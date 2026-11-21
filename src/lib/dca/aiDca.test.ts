// src/lib/dca/aiDca.test.ts
//
// 이 시험이 막는 것: **못 읽은 공포·탐욕 지수를 50(중립)으로 꾸며
// "이번 회차 매수액"을 보여 주는 것.**
//
// `/api/feargreed`는 공급원이 실패하면 502와 `{ crypto: null }`로 답한다
// (그 라우트 머리말: "못 읽은 값을 50으로 꾸며서 통과시키지 않는다").
// 그런데 AI DCA 패널은 `d?.crypto?.value ?? d?.value ?? 50`으로 읽어
// 실패를 "50 · 중립 · 기본 × 1배"로 바꿔 적고 있었다.
import { test, eq } from '../../test/harness';
import { readFearGreedValue, computeBuyAmount } from './aiDca';

export function runAiDcaTests() {
  console.log('[AI DCA — 공포·탐욕 지수를 못 읽으면 모른다고 한다]');

  test('정상 응답의 값은 그대로 읽는다', () => {
    eq(readFearGreedValue(true, { crypto: { value: 17, label: 'Extreme Fear' } }), 17);
    eq(readFearGreedValue(true, { crypto: { value: 0 } }), 0, '0은 유효한 지수다');
    eq(readFearGreedValue(true, { crypto: { value: 100 } }), 100);
  });

  test('라우트의 502 응답(crypto: null)은 50이 아니라 null이다', () => {
    const body = { crypto: null, zone: null, error: 'fear_greed_unavailable', upstreamError: 'upstream_http_503' };
    eq(readFearGreedValue(false, body), null);
  });

  test('HTTP 실패면 본문에 숫자가 있어도 믿지 않는다', () => {
    eq(readFearGreedValue(false, { crypto: { value: 30 } }), null);
  });

  test('본문이 없거나 깨졌으면 null이다', () => {
    eq(readFearGreedValue(true, null), null);
    eq(readFearGreedValue(true, undefined), null);
    eq(readFearGreedValue(true, 'oops'), null);
    eq(readFearGreedValue(true, {}), null);
  });

  test('범위 밖·숫자 아님은 null이다 — 구간표 끝으로 끌어당기지 않는다', () => {
    eq(readFearGreedValue(true, { crypto: { value: -1 } }), null);
    eq(readFearGreedValue(true, { crypto: { value: 101 } }), null);
    eq(readFearGreedValue(true, { crypto: { value: 'abc' } }), null);
    eq(readFearGreedValue(true, { crypto: { value: null } }), null);
    eq(readFearGreedValue(true, { crypto: { value: '' } }), null);
  });

  test('최상위 value(옛 응답 모양)는 지금 라우트가 내지 않으므로 읽지 않는다', () => {
    eq(readFearGreedValue(true, { value: 42 }), null);
  });

  test('매수액 계산 자체는 바뀌지 않는다 (회귀)', () => {
    eq(computeBuyAmount(100000, 10), 300000);
    eq(computeBuyAmount(100000, 50), 100000);
    eq(computeBuyAmount(100000, 90), 25000);
  });
}
