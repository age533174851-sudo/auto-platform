// src/lib/news/newsTruth.test.ts
//
// **관측되지 않은 값을 숫자로 만들지 않는다.**
//
// 막으려는 사고
// ─────────────
//  1. 모델이 confidence를 답하지 않았는데 0을 넣는 것 — "0%라고 했다"와
//     "답하지 않았다"가 같은 값이 되고, 그 뒤로 아무도 구분할 수 없다
//  2. 영향도 계산이 없는 confidence를 50으로 가정하는 것 — 그 50이 알림
//     문턱(60점)을 넘기는 데 쓰였다
//  3. 판단 보류(uncertain)로 사람을 깨우는 것 — 모델이 "모르겠다"고 한
//     것을 방향으로 읽으면 안 된다
import { test, assert, eq } from '../../test/harness';
import { validateAnalysis } from './schema';
import { calculateImpact } from './sources';
import { matchNews, type MatchAnalysis } from './matcher';

const CTX = {
  sourceUrl: 'https://example.com/a',
  publishedAt: '2026-07-28T00:00:00Z',
  provider: 'openai',
  model: 'gpt-4o-mini',
  now: '2026-07-28T01:00:00Z',
};

const OK = {
  titleKo: '엔비디아 실적 상회',
  summary: '데이터센터 매출이 시장 기대를 넘었다.',
  direction: 'bullish',
  reasons: ['데이터센터 매출 증가'],
  horizon: 'short',
};

export function runNewsTruthTests() {
  // ── ① 없는 confidence를 0으로 만들지 않는다 ──
  test('모델이 confidence를 안 주면 null이다 — 0을 만들지 않는다', () => {
    const r = validateAnalysis({ ...OK }, CTX);
    assert(r.ok, `검증 실패: ${r.errors.join(', ')}`);
    eq(r.value!.confidence, null);
    assert(r.value!.confidence !== 0, 'confidence가 0으로 만들어졌다');
  });

  test('숫자가 아닌 confidence도 null이다', () => {
    for (const bad of ['', 'high', null, undefined, {}, NaN]) {
      const r = validateAnalysis({ ...OK, confidence: bad }, CTX);
      assert(r.ok, `검증 실패: ${JSON.stringify(bad)}`);
      eq(r.value!.confidence, null);
    }
  });

  test('모델이 실제로 준 숫자는 그대로 보존한다', () => {
    const r = validateAnalysis({ ...OK, confidence: 73 }, CTX);
    eq(r.value!.confidence, 73);
    // 0~1로 답하는 모델도 그대로 읽는다
    const r2 = validateAnalysis({ ...OK, confidence: 0.73 }, CTX);
    eq(r2.value!.confidence, 73);
  });

  test('모델이 진짜 0이라고 하면 0이다 — null과 다르다', () => {
    const r = validateAnalysis({ ...OK, confidence: 0 }, CTX);
    eq(r.value!.confidence, 0);
  });

  test('근거가 없어 uncertain으로 내려도 null은 null이다', () => {
    const r = validateAnalysis({ ...OK, reasons: [] }, CTX);
    eq(r.value!.direction, 'uncertain');
    eq(r.value!.confidence, null);
  });

  test('uncertain인데 모델이 높은 숫자를 주면 그 숫자만 제한한다', () => {
    const r = validateAnalysis({ ...OK, reasons: [], confidence: 95 }, CTX);
    eq(r.value!.direction, 'uncertain');
    eq(r.value!.confidence, 30);
  });

  // ── ② 영향도가 confidence를 가정하지 않는다 ──
  test('confidence가 없으면 50으로 가정하지 않는다', () => {
    const base = {
      sourceName: 'Reuters',
      prediction: 'up' as const,
      publishedAt: Date.now(),
      numAffectedAssets: 3,
    };
    const withNull = calculateImpact({ ...base, confidence: null });
    const withFifty = calculateImpact({ ...base, confidence: 50 });
    assert(withNull.total !== withFifty.total,
      `confidence 없음이 50과 같은 점수를 냈다 (${withNull.total})`);
    assert(withNull.total < withFifty.total, '없는 값이 더 높은 점수를 냈다');
  });

  test('확신도가 없으면 방향에 강도 몫을 주지 않는다 — 보합과 같다', () => {
    const at = Date.now();
    const noConf = calculateImpact({
      sourceName: 'Reuters', prediction: 'up', confidence: null,
      publishedAt: at, numAffectedAssets: 9,
    });
    const flat = calculateImpact({
      sourceName: 'Reuters', prediction: 'flat', confidence: null,
      publishedAt: at, numAffectedAssets: 9,
    });
    eq(noConf.sentiment, flat.sentiment);
  });

  test('영향도 점수만으로는 알림을 막지 못한다 — 그래서 matchNews가 관측을 요구한다', () => {
    // 로이터 + 방금 나온 기사 + 다수 자산이면 확신도가 없어도 60점을 넘는다.
    // 점수 함수를 비틀어 맞추는 대신, 알림 조건에서 관측 여부를 본다.
    const imp = calculateImpact({
      sourceName: 'Reuters', prediction: 'up', confidence: null,
      publishedAt: Date.now(), numAffectedAssets: 9,
    });
    assert(imp.total >= 60, `이 시험의 전제가 깨졌다 (${imp.total}점)`);
  });

  test('영향도 설명에 확신도 %를 적지 않는다', () => {
    const imp = calculateImpact({
      sourceName: 'Reuters', prediction: 'up', confidence: 73,
      publishedAt: Date.now(), numAffectedAssets: 1,
    });
    const joined = imp.reasoning.join(' ');
    assert(!/신뢰도\s*\d+%/.test(joined), `설명에 확신도 %가 남아 있다: ${joined}`);
  });

  // ── ③ 판단 보류로 알리지 않는다 ──
  const ASSETS = new Set(['BTC']);
  const strong: MatchAnalysis = {
    direction: 'bullish', confidence: 95, affectedAssets: ['BTC'],
  };

  test('방향과 확신도가 있으면 알림 후보가 된다 — 기준선', () => {
    const m = matchNews('n-strong', strong, 'Reuters', Date.now(), ASSETS);
    assert(!!m, '매칭 자체가 안 됐다');
    assert(m!.shouldNotify, `알림 후보가 아니다 (영향도 ${m!.impactScore})`);
  });

  test('uncertain은 알리지 않는다', () => {
    const m = matchNews('n-unc', { ...strong, direction: 'uncertain' },
      'Reuters', Date.now(), ASSETS);
    assert(!!m, '매칭 자체가 안 됐다');
    assert(!m!.shouldNotify, '판단 보류인데 알림이 나간다');
  });

  test('방향을 모르면(null) 알리지 않는다', () => {
    const m = matchNews('n-null', { ...strong, direction: null },
      'Reuters', Date.now(), ASSETS);
    assert(!m!.shouldNotify, '방향이 없는데 알림이 나간다');
  });

  test('확신도가 없으면 알리지 않는다', () => {
    const m = matchNews('n-noconf', { ...strong, confidence: null },
      'Reuters', Date.now(), ASSETS);
    assert(!m!.shouldNotify, '확신도가 없는데 알림이 나간다');
  });

  test('내 자산이 아니면 매칭하지 않는다', () => {
    const m = matchNews('n-other', { ...strong, affectedAssets: ['ETH'] },
      'Reuters', Date.now(), ASSETS);
    eq(m, null);
  });

  test('사유 문구가 보류를 상승·하락으로 바꾸지 않는다', () => {
    const m = matchNews('n-unc2', { ...strong, direction: 'uncertain' },
      'Reuters', Date.now(), ASSETS);
    assert(!/상승|하락/.test(m!.reason), `보류인데 방향을 적었다: ${m!.reason}`);
  });
}
