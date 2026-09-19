// src/lib/engine/paperSpotHoldings.test.ts
//
// **현물 분할매도에서 TS가 실제로 판단하는 것만 여기서 고정한다.**
//
// 금액 계산은 이 파일에 없다 — 그것은 `paper_sell_holding`(088)이 NUMERIC으로
// 하고, 실행 증명은 `scripts/sql/088_paper_spot_holdings_proof.sql`과
// `scripts/paper-spot-holdings-concurrency.sh`가 실제 Postgres에서 한다.
// 여기에 같은 산수를 다시 적으면 **정본이 둘**이 되고, 언젠가 한쪽만 고쳐진다.
//
// TS가 판단하는 것은 셋이다.
//   ① 얼마를 팔라는 것인지 읽기       (paperSellRequest)
//   ② 감시기가 어느 가격으로 판정하는지 (paperExitMarks)
//   ③ 청산 계산이 어느 수수료 칸을 읽는지 (paperStore — A1)
import { test, eq, assert } from '../../test/harness';
import { sellAmountOf, sellAmountFailed } from './paperSellRequest';
import {
  exitMarketOf, exitMarkKey, exitMarkPairs, exitLiquidationOf,
} from './paperExitMarks';

export function runPaperSpotHoldingsTests() {
  // ── 현물 분할매도 — 매도 요청 읽기 ──
  test('비율 하나면 통과', () => {
    const a = sellAmountOf({ percent: 25 });
    assert(!sellAmountFailed(a));
    if (a.ok) { eq(a.percent, 25); eq(a.quantity, null); }
  });

  test('수량 하나면 통과', () => {
    const a = sellAmountOf({ quantity: 0.5 });
    assert(!sellAmountFailed(a));
    if (a.ok) { eq(a.quantity, 0.5); eq(a.percent, null); }
  });

  test('★ 둘 다 오면 거부 — 하나를 골라 주지 않는다', () => {
    const a = sellAmountOf({ percent: 25, quantity: 0.5 });
    assert(sellAmountFailed(a));
    if (!a.ok) eq(a.code, 'AMBIGUOUS');
  });

  test('★ 둘 다 없으면 거부 — 전량으로 읽지 않는다', () => {
    const a = sellAmountOf({});
    assert(sellAmountFailed(a));
    if (!a.ok) eq(a.code, 'AMBIGUOUS');
  });

  test('100%는 받는다 (전량매도가 이 경로다)', () => {
    const a = sellAmountOf({ percent: 100 });
    assert(a.ok);
  });

  test('101%는 거부', () => {
    const a = sellAmountOf({ percent: 101 });
    assert(sellAmountFailed(a));
    if (!a.ok) eq(a.code, 'BAD_PERCENT');
  });

  test('0%·음수·숫자 아님은 거부', () => {
    for (const p of [0, -1, 'abc', NaN]) {
      assert(sellAmountFailed(sellAmountOf({ percent: p })), `percent=${String(p)}`);
    }
  });

  test('수량 0·음수는 거부', () => {
    for (const q of [0, -0.1, 'x']) {
      assert(sellAmountFailed(sellAmountOf({ quantity: q })), `quantity=${String(q)}`);
    }
  });

  test('★ 빈 문자열은 "안 보낸 것"이다 — 0으로 읽지 않는다', () => {
    // `Number('') === 0`이다. 빈 값을 값으로 세면 "둘 다 왔다"가 되어
    // 멀쩡한 요청이 거부된다.
    const a = sellAmountOf({ percent: 25, quantity: '' });
    assert(a.ok);
    if (a.ok) eq(a.percent, 25);
  });

  test('★ boolean은 값이 아니다', () => {
    // `Number(true) === 1`이다. 참을 수량 1로 읽으면 누른 적 없는 매도가 나간다.
    const a = sellAmountOf({ quantity: true, percent: 50 });
    assert(a.ok);
    if (a.ok) eq(a.percent, 50);
  });

  // ── 현물 분할매도 — 감시기 가격 권위 ──
  test('SPOT과 USDM을 그대로 읽는다', () => {
    eq(exitMarketOf({ market: 'SPOT' }), 'SPOT');
    eq(exitMarketOf({ market: 'usdm' }), 'USDM');
  });

  test('★ 모르는 시장은 USDM으로 흘려보내지 않는다', () => {
    // 이것이 현물을 선물 마크가로 닫던 고장의 뿌리다.
    eq(exitMarketOf({ market: 'COINM' }), null);
    eq(exitMarketOf({ market: '' }), null);
    eq(exitMarketOf({}), null);
    eq(exitMarketOf(null), null);
  });

  test('★ 지도 키에 시장이 들어간다 — 같은 심볼이 두 시장에 있어도 안 덮인다', () => {
    const spot = { market: 'SPOT', symbol: 'BTCUSDT' };
    const perp = { market: 'USDM', symbol: 'BTCUSDT' };
    assert(exitMarkKey(spot) !== exitMarkKey(perp));
    eq(exitMarkKey(spot), 'SPOT:BTCUSDT');
  });

  test('쌍은 중복 없이 나온다', () => {
    const pairs = exitMarkPairs([
      { market: 'SPOT', symbol: 'BTCUSDT' },
      { market: 'SPOT', symbol: 'BTCUSDT' },
      { market: 'USDM', symbol: 'BTCUSDT' },
    ]);
    eq(pairs.length, 2);
  });

  test('★ 시장이나 심볼을 모르는 줄은 쌍에서 빠진다 (fail-closed)', () => {
    const pairs = exitMarkPairs([
      { market: 'SPOT', symbol: 'BTCUSDT' },
      { market: 'COINM', symbol: 'BTCUSD_PERP' },
      { market: 'SPOT', symbol: '' },
    ]);
    eq(pairs.length, 1);
    eq(pairs[0].key, 'SPOT:BTCUSDT');
  });

  test('목록이 아니면 빈 쌍 — 던지지 않는다', () => {
    eq(exitMarkPairs(null).length, 0);
    eq(exitMarkPairs(undefined as any).length, 0);
  });

  test('★ 청산가가 없으면 undefined다 — Number(null) === 0을 쓰지 않는다', () => {
    // 현물에는 청산가가 없다. 0을 넣으면 "청산가 0"이 판정 입력이 된다.
    eq(exitLiquidationOf({ liquidation_price: null }), undefined);
    eq(exitLiquidationOf({ liquidation_price: '' }), undefined);
    eq(exitLiquidationOf({}), undefined);
    eq(exitLiquidationOf({ liquidation_price: 'abc' }), undefined);
  });

  test('청산가가 있으면 그 값이다', () => {
    eq(exitLiquidationOf({ liquidation_price: 42.5 }), 42.5);
    eq(exitLiquidationOf({ liquidation_price: '42.5' }), 42.5);
  });
}
