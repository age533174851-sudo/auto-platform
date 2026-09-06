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

  // ── ② 영향도에 모델 자기평가가 들어가지 않는다 ──
  test('영향도 입력에 confidence를 넣을 자리가 없다', () => {
    // 타입에서 없앴다. 값을 넣어도 점수가 달라지지 않는다.
    const base = {
      sourceName: 'Reuters', prediction: 'up' as const,
      publishedAt: Date.now(), numAffectedAssets: 3,
    };
    const a = calculateImpact({ ...base, ...({ confidence: 5 } as any) });
    const b = calculateImpact({ ...base, ...({ confidence: 95 } as any) });
    const c = calculateImpact(base);
    eq(a.total, c.total);
    eq(b.total, c.total);
  });

  test('방향이 있어도 강도를 매기지 않는다 — 보합과 같은 몫', () => {
    const at = Date.now();
    const up = calculateImpact({
      sourceName: 'Reuters', prediction: 'up', publishedAt: at, numAffectedAssets: 9,
    });
    const flat = calculateImpact({
      sourceName: 'Reuters', prediction: 'flat', publishedAt: at, numAffectedAssets: 9,
    });
    eq(up.sentiment, flat.sentiment);
    eq(up.total, flat.total);
  });

  test('영향도 설명에 확신도를 적지 않는다', () => {
    const imp = calculateImpact({
      sourceName: 'Reuters', prediction: 'up',
      publishedAt: Date.now(), numAffectedAssets: 1,
    });
    const joined = imp.reasoning.join(' ');
    assert(!/신뢰도\s*\d+%/.test(joined), `설명에 확신도 %가 남아 있다: ${joined}`);
    assert(!/확신도\s*\d/.test(joined), `설명에 확신도 숫자가 남아 있다: ${joined}`);
  });

  test('관측 가능한 것은 여전히 점수에 든다 — 출처·최신성', () => {
    const at = Date.now();
    const good = calculateImpact({ sourceName: 'Reuters', prediction: 'up', publishedAt: at });
    const old = calculateImpact({
      sourceName: 'Reuters', prediction: 'up', publishedAt: at - 1000 * 60 * 60 * 24 * 30,
    });
    assert(good.total > old.total, '최신성이 점수에 반영되지 않는다');
  });

  // ── ③ 알림 권한이 모델 자기평가에 걸리지 않는다 ──
  const ASSETS = new Set(['BTC']);
  const strong: MatchAnalysis = { direction: 'bullish', affectedAssets: ['BTC'] };

  test('방향이 있고 영향도가 문턱을 넘으면 알림 후보다 — 기준선', () => {
    const m = matchNews('n-strong', strong, 'Reuters', Date.now(), ASSETS);
    assert(!!m, '매칭 자체가 안 됐다');
    assert(m!.shouldNotify, `알림 후보가 아니다 (영향도 ${m!.impactScore})`);
  });

  test('confidence 5와 95의 판정이 같다 — 모델 자기평가는 알림 권한이 아니다', () => {
    const at = Date.now();
    const low  = matchNews('n-c', { ...strong, ...({ confidence: 5 } as any) }, 'Reuters', at, ASSETS);
    const high = matchNews('n-c', { ...strong, ...({ confidence: 95 } as any) }, 'Reuters', at, ASSETS);
    const none = matchNews('n-c', strong, 'Reuters', at, ASSETS);
    eq(low!.shouldNotify, none!.shouldNotify);
    eq(high!.shouldNotify, none!.shouldNotify);
    eq(low!.impactScore, none!.impactScore);
    eq(high!.impactScore, none!.impactScore);
  });

  test('확신도가 없다고 알림을 막지 않는다 — 관측 여부가 권한이 아니다', () => {
    const m = matchNews('n-noconf', strong, 'Reuters', Date.now(), ASSETS);
    assert(m!.shouldNotify, '확신도가 없다는 이유로 알림이 막혔다');
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

  test('오래된 기사는 알리지 않는다 — 관측 가능한 것이 판정한다', () => {
    const old = Date.now() - 1000 * 60 * 60 * 24 * 30;
    const m = matchNews('n-old', strong, 'Reuters', old, ASSETS);
    assert(!m!.shouldNotify, `오래된 기사가 알림 문턱을 넘었다 (${m!.impactScore})`);
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
