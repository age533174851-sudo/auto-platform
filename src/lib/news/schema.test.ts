// src/lib/news/schema.test.ts
//
// 막으려는 사고:
//  1. 모델이 "모르겠다"를 말할 자리가 없어 아무 방향이나 고르는 것
//     — 근거 없는 추측이 예측과 똑같은 모양으로 화면에 남는다
//  2. 모델이 지어낸 원문 주소가 진짜 출처인 척 링크로 걸리는 것
//  3. '#'이나 '5분 전' 같은 자리채우기 값이 "있음"으로 통과하는 것
//  4. 근거 없이 단정한 방향이 높은 확신도를 달고 나가는 것
//  5. 같은 기사가 utm 파라미터만 바뀐 채 다시 분석되는 것
import { test, assert, eq } from '../../test/harness';
import {
  parseDirection, parseHorizon, parseConfidence,
  parseSourceUrl, parsePublishedAt,
  validateAnalysis, extractJson, contentHash, toLegacyAnalysis, newsCacheKey,
  DIRECTION_KO,
} from './schema';

// 검증을 통과하는 최소 입력 — 각 테스트는 여기서 한 군데씩만 망가뜨린다
const OK_RAW = {
  titleKo: '비트코인 ETF 순유입 사흘째',
  summary: '기관 자금이 사흘 연속 유입됐다. 규모는 직전 주 대비 늘었다.',
  direction: 'bullish',
  confidence: 72,
  horizon: 'short',
  reasons: ['ETF 순유입 지속', '거래량 증가'],
  risks: ['금리 발표 대기'],
  affectedAssets: ['BTC', 'COIN'],
};

const OK_CTX = {
  sourceUrl: 'https://coindesk.com/markets/etf-inflow',
  publishedAt: '2026-07-20T09:00:00Z',
  provider: 'openai',
  model: 'gpt-4o-mini',
  now: '2026-07-20T10:00:00Z',
};

export function runNewsSchemaTests() {
  console.log('[뉴스 스키마 — 방향]');

  test('아는 방향은 그대로', () => {
    eq(parseDirection('bullish'), 'bullish');
    eq(parseDirection('BEARISH'), 'bearish');
    eq(parseDirection(' neutral '), 'neutral');
    eq(parseDirection('uncertain'), 'uncertain');
  });

  test('한국어·다른 표현도 읽는다', () => {
    eq(parseDirection('상승'), 'bullish');
    eq(parseDirection('호재'), 'bullish');
    eq(parseDirection('하락'), 'bearish');
    eq(parseDirection('악재'), 'bearish');
    eq(parseDirection('보합'), 'neutral');
    eq(parseDirection('중립'), 'neutral');
  });

  test('모르는 방향은 uncertain — neutral이 아니다', () => {
    // neutral로 바꾸면 모델이 하지 않은 "보합 전망"을 우리가 만들어낸 게 된다
    eq(parseDirection('sideways-ish'), 'uncertain');
    eq(parseDirection(''), 'uncertain');
    eq(parseDirection(null), 'uncertain');
    eq(parseDirection(undefined), 'uncertain');
    eq(parseDirection(42), 'uncertain');
    eq(parseDirection({}), 'uncertain');
  });

  test('네 방향 모두 한국어 라벨이 있다', () => {
    // Record 타입이 강제하지만, 값이 빈 문자열이면 화면에 아무것도 안 뜬다
    for (const d of ['bullish', 'neutral', 'bearish', 'uncertain'] as const) {
      assert((DIRECTION_KO[d] || '').length > 0, `${d} 라벨 없음`);
    }
    eq(DIRECTION_KO.uncertain, '판단 보류');
  });

  console.log('[뉴스 스키마 — 기간]');

  test('아는 기간은 그대로, 모르면 unknown', () => {
    eq(parseHorizon('intraday'), 'intraday');
    eq(parseHorizon('단기'), 'short');
    eq(parseHorizon('중기'), 'medium');
    eq(parseHorizon('장기'), 'long');
    // 임의로 '단기'라고 하지 않는다
    eq(parseHorizon('언젠가'), 'unknown');
    eq(parseHorizon(null), 'unknown');
  });

  console.log('[뉴스 스키마 — 확신도]');

  test('0~1로 답하는 모델을 퍼센트로 읽는다', () => {
    eq(parseConfidence(0.72), 72);
    eq(parseConfidence(0.5), 50);
    // 1은 100%로 읽는다. "확신 1%"를 1로 적는 모델은 사실상 없다
    eq(parseConfidence(1), 100);
  });

  test('범위를 벗어나면 자른다', () => {
    eq(parseConfidence(150), 100);
    eq(parseConfidence(-20), 0);
    eq(parseConfidence(0), 0);
  });

  test('숫자가 아니면 null — 0으로 두면 "확신 0%"라는 거짓말이 된다', () => {
    eq(parseConfidence('높음'), null);
    eq(parseConfidence(null), null);
    eq(parseConfidence(undefined), null);
    eq(parseConfidence(NaN), null);
  });

  test('문자열 숫자도 받는다', () => {
    eq(parseConfidence('72'), 72);
    eq(parseConfidence('0.8'), 80);
  });

  console.log('[뉴스 스키마 — 원문 주소]');

  test('정상 주소는 통과', () => {
    assert(parseSourceUrl('https://reuters.com/a/b') === 'https://reuters.com/a/b');
    assert((parseSourceUrl('http://coindesk.com') || '').startsWith('http://coindesk.com'));
  });

  test("자리채우기 '#'은 주소가 아니다", () => {
    // newsapi 매핑이 주소 없을 때 '#'을 채운다. 링크처럼 생겼지만 아무 데도 안 간다
    eq(parseSourceUrl('#'), null);
    eq(parseSourceUrl('-'), null);
    eq(parseSourceUrl('N/A'), null);
    eq(parseSourceUrl('null'), null);
    eq(parseSourceUrl('undefined'), null);
    eq(parseSourceUrl(''), null);
    eq(parseSourceUrl(null), null);
  });

  test('javascript: 는 막는다 — 이 값은 window.open으로 들어간다', () => {
    eq(parseSourceUrl('javascript:alert(1)'), null);
    eq(parseSourceUrl('data:text/html,<script>x</script>'), null);
    eq(parseSourceUrl('file:///etc/passwd'), null);
  });

  test('호스트가 없거나 점이 없으면 출처가 아니다', () => {
    eq(parseSourceUrl('https://localhost/news'), null);
    eq(parseSourceUrl('그냥 텍스트'), null);
    eq(parseSourceUrl('coindesk.com/a'), null);   // 스킴 없음
  });

  console.log('[뉴스 스키마 — 발행 시각]');

  const NOW = Date.UTC(2026, 6, 20, 10, 0, 0);

  test('ISO·epoch·Date 모두 ISO UTC로', () => {
    eq(parsePublishedAt('2026-07-20T09:00:00Z', NOW), '2026-07-20T09:00:00.000Z');
    eq(parsePublishedAt(Date.UTC(2026, 6, 20, 9), NOW), '2026-07-20T09:00:00.000Z');
    // 초 단위 epoch도 받는다
    eq(parsePublishedAt(Date.UTC(2026, 6, 20, 9) / 1000, NOW), '2026-07-20T09:00:00.000Z');
    eq(parsePublishedAt(new Date(Date.UTC(2026, 6, 20, 9)), NOW), '2026-07-20T09:00:00.000Z');
  });

  test("표시용 문자열 '5분 전'은 시각이 아니다", () => {
    // 이 앱의 뉴스 항목이 time 필드에 실제로 담고 있는 값이다.
    // 통과시키면 화면에 Invalid Date가 뜬다
    eq(parsePublishedAt('5분 전', NOW), null);
    eq(parsePublishedAt('방금', NOW), null);
    eq(parsePublishedAt('', NOW), null);
    eq(parsePublishedAt(null, NOW), null);
    eq(parsePublishedAt(undefined, NOW), null);
  });

  test('미래 기사는 떨어뜨린다', () => {
    // 아직 나오지 않은 기사를 근거로 방향을 말할 수는 없다
    eq(parsePublishedAt('2026-08-20T09:00:00Z', NOW), null);
    // 시차·서버 시계 오차 정도(2일 이내)는 봐준다
    assert(parsePublishedAt('2026-07-21T09:00:00Z', NOW) !== null);
  });

  test('2000년 이전은 깨진 값으로 본다', () => {
    eq(parsePublishedAt('1970-01-01T00:00:00Z', NOW), null);
    eq(parsePublishedAt(0, NOW), null);
  });

  console.log('[뉴스 스키마 — 검증]');

  test('정상 응답은 통과한다', () => {
    const r = validateAnalysis(OK_RAW, OK_CTX);
    assert(r.ok, r.errors.join(', '));
    assert(r.value !== null);
    eq(r.value!.direction, 'bullish');
    eq(r.value!.directionKo, '상승');
    eq(r.value!.confidence, 72);
    eq(r.value!.horizon, 'short');
    eq(r.value!.analyzedAt, OK_CTX.now);
    eq(r.repaired.length, 0, `고칠 게 없어야 하는데: ${r.repaired.join(', ')}`);
  });

  test('객체가 아니면 떨어뜨린다', () => {
    for (const bad of [null, undefined, 'text', 42, [1, 2]]) {
      const r = validateAnalysis(bad, OK_CTX);
      assert(!r.ok, `${JSON.stringify(bad)}가 통과했다`);
      eq(r.value, null);
    }
  });

  test('제목·요약이 없으면 떨어뜨린다', () => {
    const r1 = validateAnalysis({ ...OK_RAW, titleKo: '' }, OK_CTX);
    assert(!r1.ok);
    assert(r1.errors.some(e => e.includes('titleKo')), r1.errors.join(', '));

    const r2 = validateAnalysis({ ...OK_RAW, summary: '' }, OK_CTX);
    assert(!r2.ok);
    assert(r2.errors.some(e => e.includes('summary')), r2.errors.join(', '));
  });

  test('원문 주소가 없으면 저장하지 않는다', () => {
    for (const bad of ['', '#', 'javascript:alert(1)', undefined]) {
      const r = validateAnalysis(OK_RAW, { ...OK_CTX, sourceUrl: bad as any });
      assert(!r.ok, `sourceUrl='${bad}'가 통과했다`);
      assert(r.errors.some(e => e.includes('sourceUrl')), r.errors.join(', '));
    }
  });

  test('발행 시각을 읽을 수 없으면 저장하지 않는다', () => {
    for (const bad of ['', '5분 전', undefined]) {
      const r = validateAnalysis(OK_RAW, { ...OK_CTX, publishedAt: bad as any });
      assert(!r.ok, `publishedAt='${bad}'가 통과했다`);
      assert(r.errors.some(e => e.includes('publishedAt')), r.errors.join(', '));
    }
  });

  test('모델이 지어낸 주소는 원문 값으로 되돌리고 기록한다', () => {
    // 조용히 덮으면 모델이 주소를 지어내고 있다는 걸 영영 모른다
    const r = validateAnalysis(
      { ...OK_RAW, sourceUrl: 'https://reuters.com/이런-기사는-없다' },
      OK_CTX,
    );
    assert(r.ok, r.errors.join(', '));
    eq(r.value!.sourceUrl, OK_CTX.sourceUrl);
    assert(r.repaired.some(x => x.includes('sourceUrl')), r.repaired.join(', '));
  });

  test('근거 없이 방향을 단정하면 uncertain으로 내린다', () => {
    // 근거 없는 방향은 예측이 아니라 추측이고, 화면에서는 둘이 똑같아 보인다
    const r = validateAnalysis({ ...OK_RAW, reasons: [], confidence: 90 }, OK_CTX);
    assert(r.ok, r.errors.join(', '));
    eq(r.value!.direction, 'uncertain');
    eq(r.value!.directionKo, '판단 보류');
    assert(r.value!.confidence <= 30, `확신도가 ${r.value!.confidence}로 남았다`);
    assert(r.repaired.some(x => x.includes('근거')), r.repaired.join(', '));
  });

  test('보류인데 확신이 높은 모순은 잘라낸다', () => {
    const r = validateAnalysis(
      { ...OK_RAW, direction: 'uncertain', confidence: 95 },
      OK_CTX,
    );
    assert(r.ok, r.errors.join(', '));
    eq(r.value!.direction, 'uncertain');
    assert(r.value!.confidence <= 50, `확신도가 ${r.value!.confidence}로 남았다`);
  });

  test('알 수 없는 방향 값은 uncertain으로 내리고 기록한다', () => {
    const r = validateAnalysis({ ...OK_RAW, direction: '아마도 오를 듯' }, OK_CTX);
    assert(r.ok, r.errors.join(', '));
    eq(r.value!.direction, 'uncertain');
    assert(r.repaired.some(x => x.includes('direction')), r.repaired.join(', '));
  });

  test('모델이 보류라고 말한 경우는 고친 게 아니다', () => {
    const r = validateAnalysis({ ...OK_RAW, direction: 'uncertain', confidence: 20 }, OK_CTX);
    assert(r.ok, r.errors.join(', '));
    eq(r.repaired.length, 0, r.repaired.join(', '));
  });

  test('확신도가 없으면 0으로 두되 기록한다', () => {
    const r = validateAnalysis({ ...OK_RAW, confidence: '높음' }, OK_CTX);
    assert(r.ok, r.errors.join(', '));
    eq(r.value!.confidence, 0);
    assert(r.repaired.some(x => x.includes('confidence')), r.repaired.join(', '));
  });

  test('자산 티커는 대문자로 정리하고 쓰레기는 버린다', () => {
    const r = validateAnalysis(
      { ...OK_RAW, affectedAssets: ['btc', ' eth ', '!!!', '', 'brk.b'] },
      OK_CTX,
    );
    assert(r.ok, r.errors.join(', '));
    const a = r.value!.affectedAssets;
    assert(a.includes('BTC'), a.join(','));
    assert(a.includes('ETH'), a.join(','));
    assert(a.includes('BRK.B'), a.join(','));
    assert(!a.includes(''), '빈 티커가 남았다');
  });

  test('배열이 아닌 근거·위험은 빈 배열로', () => {
    const r = validateAnalysis({ ...OK_RAW, risks: '금리' }, OK_CTX);
    assert(r.ok, r.errors.join(', '));
    eq(r.value!.risks.length, 0);
  });

  test('근거는 5개까지만 — 모델이 목록을 늘려 무게를 만든다', () => {
    const many = Array.from({ length: 20 }, (_, i) => `근거${i}`);
    const r = validateAnalysis({ ...OK_RAW, reasons: many }, OK_CTX);
    assert(r.ok, r.errors.join(', '));
    eq(r.value!.reasons.length, 5);
  });

  test('출처·모델 정보는 컨텍스트 값이 그대로 남는다', () => {
    const r = validateAnalysis(OK_RAW, OK_CTX);
    eq(r.value!.provider, 'openai');
    eq(r.value!.model, 'gpt-4o-mini');
    eq(r.value!.publishedAt, '2026-07-20T09:00:00.000Z');
  });

  console.log('[뉴스 스키마 — JSON 추출]');

  test('그냥 JSON', () => {
    eq(extractJson('{"a":1}').a, 1);
  });

  test('코드펜스를 벗겨낸다', () => {
    eq(extractJson('```json\n{"a":1}\n```').a, 1);
    eq(extractJson('```\n{"a":2}\n```').a, 2);
  });

  test('설명이 앞뒤로 붙어도 뽑아낸다', () => {
    eq(extractJson('분석 결과입니다:\n{"a":3}\n도움이 되셨길').a, 3);
  });

  test('못 뽑으면 null — 억지로 고치면 엉뚱한 조각을 파싱한다', () => {
    eq(extractJson('죄송하지만 분석할 수 없습니다'), null);
    eq(extractJson('{깨진 json'), null);
    eq(extractJson(''), null);
    eq(extractJson(null), null);
    eq(extractJson(undefined), null);
  });

  test('JSON이지만 객체가 아니면 null', () => {
    eq(extractJson('42'), null);
    eq(extractJson('"문자열"'), null);
  });

  console.log('[뉴스 스키마 — 중복 판별]');

  test('추적 파라미터만 다른 같은 기사는 같은 지문', () => {
    const a = contentHash({ url: 'https://reuters.com/a', title: 'Fed holds rates', publishedAt: '2026-07-20T09:00:00Z' });
    const b = contentHash({ url: 'https://reuters.com/a?utm_source=x&utm_medium=y', title: 'Fed holds rates', publishedAt: '2026-07-20T11:30:00Z' });
    eq(a, b);
  });

  test('끝 슬래시·대소문자 차이도 같은 기사', () => {
    const a = contentHash({ url: 'https://Reuters.com/A/', title: 'Fed Holds Rates' });
    const b = contentHash({ url: 'https://reuters.com/A', title: 'fed holds rates' });
    eq(a, b);
  });

  test('다른 기사는 다른 지문', () => {
    const a = contentHash({ url: 'https://reuters.com/a', title: 'Fed holds rates' });
    const b = contentHash({ url: 'https://reuters.com/b', title: 'Fed holds rates' });
    assert(a !== b, '다른 주소인데 지문이 같다');
  });

  test('같은 제목이라도 날짜가 다르면 다른 기사', () => {
    // 정기 기사(주간 전망 등)는 같은 제목을 계속 쓴다
    const a = contentHash({ url: 'https://x.com/w', title: '주간 전망', publishedAt: '2026-07-20T09:00:00Z' });
    const b = contentHash({ url: 'https://x.com/w', title: '주간 전망', publishedAt: '2026-07-27T09:00:00Z' });
    assert(a !== b, '다른 날짜인데 지문이 같다');
  });

  test('지문은 항상 16자 hex', () => {
    for (const input of [{}, { url: 'https://a.com/x' }, { title: '가나다' }]) {
      const h = contentHash(input);
      assert(/^[0-9a-f]{16}$/.test(h), `형식이 다르다: ${h}`);
    }
  });

  console.log('[뉴스 스키마 — 캐시 키]');

  test('id가 달라도 같은 기사면 같은 키 — 두 번 분석하지 않는다', () => {
    const a = newsCacheKey({ id: 'newsapi_1', url: 'https://reuters.com/a', title: 'Fed holds', publishedAt: '2026-07-20T09:00:00Z' });
    const b = newsCacheKey({ id: 'fmp_99',    url: 'https://reuters.com/a?utm_source=z', title: 'Fed holds', publishedAt: '2026-07-20T15:00:00Z' });
    eq(a, b);
  });

  test('다른 기사는 다른 키 — 남의 분석을 보여주면 안 된다', () => {
    const a = newsCacheKey({ id: 'x', url: 'https://reuters.com/a', title: 'Fed holds' });
    const b = newsCacheKey({ id: 'x', url: 'https://reuters.com/b', title: 'BOJ moves' });
    assert(a !== b);
  });

  test('time 필드의 표시용 문자열은 키를 흔들지 않는다', () => {
    // '5분 전'은 1분 뒤에 '6분 전'이 된다. 그대로 섞으면 매분 캐시가 깨진다
    const a = newsCacheKey({ id: 'x', url: 'https://a.com/1', title: 'T', time: '5분 전' });
    const b = newsCacheKey({ id: 'x', url: 'https://a.com/1', title: 'T', time: '38분 전' });
    eq(a, b);
  });

  test('publishedAt이 있으면 그쪽을 쓴다', () => {
    const a = newsCacheKey({ id: 'x', url: 'https://a.com/1', title: 'T', publishedAt: '2026-07-20T09:00:00Z', time: '5분 전' });
    const b = newsCacheKey({ id: 'x', url: 'https://a.com/1', title: 'T', publishedAt: '2026-07-27T09:00:00Z', time: '5분 전' });
    assert(a !== b, '날짜가 다른데 키가 같다');
  });

  test('주소도 제목도 없으면 id로 물러선다 — 전부 한 칸에 뭉치면 안 된다', () => {
    const a = newsCacheKey({ id: 'a' });
    const b = newsCacheKey({ id: 'b' });
    assert(a !== b, `키가 겹쳤다: ${a}`);
  });

  console.log('[뉴스 스키마 — 화면 타입으로]');

  test('uncertain은 unknown으로 간다 — flat으로 접지 않는다', () => {
    // flat으로 접으면 "보합 예상"이 되고, 그건 모델이 하지 않은 말이다
    const r = validateAnalysis({ ...OK_RAW, direction: 'uncertain', confidence: 30 }, OK_CTX);
    const legacy = toLegacyAnalysis(r.value!);
    eq(legacy.prediction, 'unknown');
  });

  test('나머지 방향도 제자리로', () => {
    const cases: [string, string][] = [['bullish', 'up'], ['bearish', 'down'], ['neutral', 'flat']];
    for (const [dir, expected] of cases) {
      const r = validateAnalysis({ ...OK_RAW, direction: dir }, OK_CTX);
      assert(r.ok, r.errors.join(', '));
      eq(toLegacyAnalysis(r.value!).prediction, expected, `${dir} → ${expected}`);
    }
  });

  test('요약·근거·확신도가 그대로 옮겨간다', () => {
    const r = validateAnalysis(OK_RAW, OK_CTX);
    const legacy = toLegacyAnalysis(r.value!);
    eq(legacy.titleKo, OK_RAW.titleKo);
    eq(legacy.summaryKo, OK_RAW.summary);
    eq(legacy.confidence, 72);
    eq(legacy.reasons.length, 2);
    eq(legacy.source, 'openai');
  });

  test('자산은 전체 방향을 달고 간다', () => {
    const r = validateAnalysis(OK_RAW, OK_CTX);
    const legacy = toLegacyAnalysis(r.value!);
    eq(legacy.affectedAssets.length, 2);
    eq(legacy.affectedAssets[0].symbol, 'BTC');
    eq(legacy.affectedAssets[0].direction, 'up');
  });

  test('분석 시각은 ms 숫자로', () => {
    const r = validateAnalysis(OK_RAW, OK_CTX);
    const legacy = toLegacyAnalysis(r.value!);
    eq(legacy.analyzedAt, Date.parse(OK_CTX.now));
  });
}
