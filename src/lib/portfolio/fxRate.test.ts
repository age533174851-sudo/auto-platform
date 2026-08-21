// src/lib/portfolio/fxRate.test.ts
//
// **이 테스트가 막는 것: 폴백 상수가 진짜 환율인 척하는 것.**
//
// `src/lib/currency.ts`에는 `FALLBACK_USDKRW = 1375`가 있다. 환율을 못
// 읽으면 그 값으로 원화 금액을 그린다 — 언제 것인지 모르고, 못 읽었다는
// 표시도 없다. 지갑에서는 그러지 않는다.
import { test, eq, assert } from '../../test/harness';
import { parseUsdKrw, fxFreshness, FX_STALE_MS } from './fxRate';

const NOW = Date.parse('2026-08-21T12:00:00.000Z');

export function runFxRateTests() {
  console.log('[환율 — 없는 것을 지어내지 않는다]');

  test('정상 범위의 값만 환율로 받는다', () => {
    const fx = parseUsdKrw(1382.5, NOW)!;
    eq(fx.rate, 1382.5); eq(fx.currency, 'KRW'); eq(fx.asOfMs, NOW);
  });

  test('공급원이 0이나 1을 주면 안 읽은 것으로 친다', () => {
    // 그대로 쓰면 5,000 USDT가 ₩5,000으로 보인다.
    eq(parseUsdKrw(0, NOW), null);
    eq(parseUsdKrw(1, NOW), null);
    eq(parseUsdKrw(99999, NOW), null);
  });

  test('값이 없거나 숫자가 아니면 null이다 — 1375로 채우지 않는다', () => {
    eq(parseUsdKrw(null, NOW), null);
    eq(parseUsdKrw(undefined, NOW), null);
    eq(parseUsdKrw('abc', NOW), null);
  });

  test('언제 것인지 모르면 환율로 쓰지 않는다', () => {
    eq(parseUsdKrw(1382, null), null);
    eq(parseUsdKrw(1382, 0), null);
  });

  test('환율이 없으면 통화를 바꾸지 않는다고 말한다', () => {
    const f = fxFreshness(null, NOW);
    eq(f.usable, false);
    assert(f.reason.includes('원화 기호만 붙이지 않습니다'), f.reason);
  });

  test('오래된 환율은 막지 않고 말한다', () => {
    const fx = parseUsdKrw(1382, NOW - FX_STALE_MS - 3600_000)!;
    const f = fxFreshness(fx, NOW);
    eq(f.usable, true); eq(f.stale, true);
    assert(f.reason.includes('지금 환율이 아닙니다'), f.reason);
  });

  test('최근 환율은 경고하지 않는다', () => {
    const f = fxFreshness(parseUsdKrw(1382, NOW - 60_000), NOW);
    eq(f.usable, true); eq(f.stale, false);
  });
}
