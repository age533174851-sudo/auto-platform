// src/lib/news/schema.test.ts
//
// 막으려는 사고:
//  1. 모델이 지어낸 원문 URL을 그대로 저장하는 것 — 사람은 링크가 있으면
//     확인 없이 믿는다
//  2. 근거 없이 '상승'이라고 단정한 응답을 통과시키는 것 — 예측과 추측이
//     화면에서 똑같아 보인다
//  3. 모르는 direction 값을 neutral로 바꾸는 것 — '보합 전망'이 되어버린다
//  4. 같은 기사를 URL 파라미터만 달라졌다고 다시 분석해 돈을 두 번 쓰는 것
import { test, assert, eq } from '../../test/harness';
import {
  validateAnalysis, parseDirection, parseHorizon, parseConfidence,
  extractJson, contentHash, DIRECTION_KO,
} from './schema';

const CTX = {
  sourceUrl: 'https://example.com/a',
  publishedAt: '2026-07-28T00:00:00Z',
  provider: 'openai',
  model: 'gpt-4o-mini',
  now: '2026-07-28T01:00:00Z',
};

const good = (over: any = {}) => ({
  titleKo: '비트코인 상승', summary: '기관 매수세가 늘었다',
  direction: 'bullish', confidence: 70, horizon: 'short',
  reasons: ['기관 순유입 증가'], risks: ['발표 전 변동성'],
  affectedAssets: ['BTC'], ...over,
});

export function runNewsSchemaTests() {
  console.log('[뉴스 스키마 — 방향]');

  test('모르는 값은 uncertain이다', () => {
    // neutral로 바꾸면 '보합 전망'이 된다. 모르는 것과 다른 말이다.
    eq(parseDirection('보라색'), 'uncertain');
    eq(parseDirection(null), 'uncertain');
    eq(parseDirection(''), 'uncertain');
  });

  test('네 값을 그대로 받는다', () => {
    for (const d of ['bullish', 'neutral', 'bearish', 'uncertain']) eq(parseDirection(d), d);
  });

  test('다른 표현도 알아본다', () => {
    eq(parseDirection('UP'), 'bullish');
    eq(parseDirection('상승'), 'bullish');
    eq(parseDirection('negative'), 'bearish');
    eq(parseDirection('중립'), 'neutral');
  });

  test('한국어 표기가 네 개 다 있다', () => {
    eq(Object.keys(DIRECTION_KO).length, 4);
    eq(DIRECTION_KO.uncertain, '판단 보류');
  });

  console.log('[뉴스 스키마 — 확신도]');

  test('0~1로 답해도 퍼센트로 읽는다', () => {
    eq(parseConfidence(0.72), 72);
    eq(parseConfidence(72), 72);
  });

  test('범위를 벗어나면 자른다', () => {
    eq(parseConfidence(150), 100);
    eq(parseConfidence(-5), 0);
  });

  test('숫자가 아니면 null — 0이 아니다', () => {
    // 0으로 두면 '확신 0%'가 되는데, 그건 '모른다'와 다른 주장이다
    eq(parseConfidence('abc'), null);
    eq(parseConfidence(undefined), null);
  });

  console.log('[뉴스 스키마 — 기간]');

  test('모르면 unknown이다', () => {
    eq(parseHorizon('내일쯤'), 'unknown');
    eq(parseHorizon(null), 'unknown');
    eq(parseHorizon('단기'), 'short');
    eq(parseHorizon('long'), 'long');
  });

  console.log('[뉴스 스키마 — 검증]');

  test('정상 응답은 통과한다', () => {
    const r = validateAnalysis(good(), CTX);
    eq(r.ok, true, r.errors.join(','));
    eq(r.value!.direction, 'bullish');
    eq(r.value!.directionKo, '상승');
    eq(r.value!.provider, 'openai');
    eq(r.value!.sourceUrl, CTX.sourceUrl);
  });

  test('원문 URL이 없으면 저장하지 않는다', () => {
    const r = validateAnalysis(good(), { ...CTX, sourceUrl: '' });
    eq(r.ok, false);
    assert(r.errors.some(e => e.includes('sourceUrl')), r.errors.join(','));
  });

  test('모델이 만든 URL은 원문 값으로 되돌린다', () => {
    // 그럴듯한 주소를 지어내면 사람은 확인 없이 믿는다
    const r = validateAnalysis(good({ sourceUrl: 'https://evil.example/fake' }), CTX);
    eq(r.ok, true);
    eq(r.value!.sourceUrl, CTX.sourceUrl);
    assert(r.repaired.some(x => x.includes('sourceUrl')), r.repaired.join(','));
  });

  test('제목·요약이 없으면 떨어진다', () => {
    eq(validateAnalysis(good({ titleKo: '' }), CTX).ok, false);
    eq(validateAnalysis(good({ summary: '' }), CTX).ok, false);
  });

  test('객체가 아니면 떨어진다', () => {
    eq(validateAnalysis(null, CTX).ok, false);
    eq(validateAnalysis([1, 2], CTX).ok, false);
    eq(validateAnalysis('상승할 것 같습니다', CTX).ok, false);
  });

  console.log('[뉴스 스키마 — 근거 없는 단정을 막는다]');

  test('근거가 없으면 방향을 보류로 내린다', () => {
    const r = validateAnalysis(good({ reasons: [] }), CTX);
    eq(r.ok, true);
    eq(r.value!.direction, 'uncertain', '근거 없는 방향은 예측이 아니라 추측이다');
    assert(r.value!.confidence <= 30, String(r.value!.confidence));
    assert(r.repaired.some(x => x.includes('근거')), r.repaired.join(','));
  });

  test('보류인데 확신이 높으면 낮춘다', () => {
    const r = validateAnalysis(good({ direction: 'uncertain', confidence: 95 }), CTX);
    eq(r.ok, true);
    assert(r.value!.confidence <= 50, String(r.value!.confidence));
  });

  test('확신도가 없으면 0으로 두되 그 사실을 남긴다', () => {
    const r = validateAnalysis(good({ confidence: null }), CTX);
    eq(r.ok, true);
    assert(r.repaired.some(x => x.includes('confidence')), r.repaired.join(','));
  });

  test('고친 내용을 조용히 넘기지 않는다', () => {
    // repaired가 비면 모델이 나빠져도 알 수 없다
    const r = validateAnalysis(good({ direction: '아마도요', reasons: ['근거'] }), CTX);
    assert(r.repaired.length > 0, '고쳤으면 기록이 남아야 한다');
  });

  console.log('[뉴스 스키마 — JSON 추출]');

  test('코드펜스를 벗겨낸다', () => {
    const v = extractJson('```json\n{"a":1}\n```');
    eq(v?.a, 1);
  });

  test('설명이 섞여 있어도 뽑아낸다', () => {
    const v = extractJson('분석 결과입니다:\n{"a":2}\n감사합니다');
    eq(v?.a, 2);
  });

  test('JSON이 없으면 null — 억지로 고치지 않는다', () => {
    eq(extractJson('그냥 문장입니다'), null);
    eq(extractJson(''), null);
    eq(extractJson(null), null);
  });

  test('배열만 오면 받지 않는다', () => {
    // 분석 결과는 객체다. 배열을 통과시키면 뒤에서 필드 접근이 전부 undefined다
    eq(extractJson('[1,2,3]'), null);
  });

  console.log('[뉴스 스키마 — 중복 판별]');

  test('추적 파라미터만 다르면 같은 기사다', () => {
    const a = contentHash({ url: 'https://x.com/a?utm_source=twitter', title: 'T', publishedAt: '2026-07-28T01:00:00Z' });
    const b = contentHash({ url: 'https://x.com/a', title: 'T', publishedAt: '2026-07-28T09:00:00Z' });
    eq(a, b, '같은 기사를 두 번 분석하면 돈이 두 번 나간다');
  });

  test('끝 슬래시와 대소문자를 무시한다', () => {
    eq(contentHash({ url: 'https://X.com/A/', title: 'T' }),
       contentHash({ url: 'https://x.com/a', title: 't' }));
  });

  test('다른 기사는 다른 지문이다', () => {
    assert(contentHash({ url: 'https://x.com/a', title: 'A' })
        !== contentHash({ url: 'https://x.com/b', title: 'B' }));
  });

  test('제목이 같아도 URL이 다르면 다른 기사다', () => {
    assert(contentHash({ url: 'https://x.com/a', title: '같은 제목' })
        !== contentHash({ url: 'https://y.com/b', title: '같은 제목' }));
  });

  test('날짜가 다르면 다른 기사다', () => {
    assert(contentHash({ url: 'https://x.com/a', title: 'T', publishedAt: '2026-07-28T00:00:00Z' })
        !== contentHash({ url: 'https://x.com/a', title: 'T', publishedAt: '2026-07-29T00:00:00Z' }));
  });

  test('지문 길이가 일정하다', () => {
    eq(contentHash({}).length, 16);
    eq(contentHash({ url: 'https://x.com/very/long/path', title: '아주 긴 제목'.repeat(20) }).length, 16);
  });
}
