// src/lib/exchanges/gateSpotPlan.test.ts
//
// Gate 현물은 바이낸스와 세 군데가 다르고, 셋 다 **조용히** 틀린다:
//
//   · 종목 이름이 `BTC_USDT`다. 밑줄을 잘못 넣으면 존재하는 **다른 종목**을 산다
//   · 시장가 매수의 amount는 수량이 아니라 **금액**이다
//   · 수량 정밀도는 내림해야 한다. 올리면 보유량을 넘겨 매도가 거부된다
//
// 그리고 체결 판정: `left`가 없으면 **모르는 것**이지 0이 아니다.

import { test, eq, assert, close } from '../../test/harness';
import {
  toGatePair, planGateSpotOrder, gateSpotFillOf, floorTo, GATE_QUOTES,
} from './gateSpotPlan';

const buyLimit = (o: any = {}) => planGateSpotOrder({
  symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.5, price: 60000, ...o,
});

export function runGateSpotPlanTests() {
  console.log('[Gate 현물 — 종목 이름]');

  test('BTCUSDT → BTC_USDT', () => {
    const p = toGatePair('BTCUSDT');
    eq(p?.pair, 'BTC_USDT');
    eq(p?.base, 'BTC');
    eq(p?.quote, 'USDT');
  });

  test('USDT보다 긴 결제 통화를 먼저 본다 — 짧은 것부터 보면 이름이 잘린다', () => {
    eq(toGatePair('SOLUSDC')?.pair, 'SOL_USDC');
    eq(toGatePair('ETHBUSD')?.pair, 'ETH_BUSD');
  });

  test('결제 통화가 코인인 쌍도 된다', () => {
    const p = toGatePair('ETHBTC');
    eq(p?.pair, 'ETH_BTC');
    eq(p?.quote, 'BTC');
  });

  test('이미 나뉘어 있으면 그대로 쓴다', () => {
    eq(toGatePair('BTC_USDT')?.pair, 'BTC_USDT');
    eq(toGatePair('btc/usdt')?.pair, 'BTC_USDT');
  });

  test('**모르는 결제 통화는 추측하지 않는다** — 아무 데나 밑줄을 넣으면 다른 종목이 된다', () => {
    eq(toGatePair('BTCKRW'), null);
    eq(toGatePair('ABCDEF'), null);
    eq(toGatePair(''), null);
    eq(toGatePair(null), null);
  });

  test('결제 통화만 있는 이름은 종목이 아니다', () => {
    eq(toGatePair('USDT'), null, 'base가 비면 안 된다');
  });

  test('주문도 같은 이유로 거절하고, 무엇이 문제인지 말한다', () => {
    const r = planGateSpotOrder({ symbol: 'BTCKRW', side: 'BUY', type: 'MARKET', quoteAmount: 100 });
    eq(r.ok, false);
    assert(r.reason!.includes('BTCKRW'), r.reason);
    assert(GATE_QUOTES.some(q => r.reason!.includes(q)), '지원 통화를 알려줘야 한다');
  });

  console.log('[Gate 현물 — 시장가 매수는 금액이다]');

  test('시장가 매수의 amount는 결제통화 금액', () => {
    const r = planGateSpotOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteAmount: 250 });
    eq(r.ok, true);
    eq(r.body!.amount, '250');
    eq(r.body!.time_in_force, 'ioc', '현물 시장가는 gtc를 못 쓴다');
    eq(r.quantity, null, '수량이 아니다');
  });

  test('금액 없이 수량만 주면 거절하고 **금액이라고 말해 준다**', () => {
    const r = planGateSpotOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.5 });
    eq(r.ok, false);
    assert(r.reason!.includes('금액'), r.reason);
    assert(r.reason!.includes('USDT'), '어느 통화인지도');
  });

  test('시장가 **매도**는 코인 수량이다', () => {
    const r = planGateSpotOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.5 });
    eq(r.ok, true);
    eq(r.body!.amount, '0.5');
    eq(r.quantity, 0.5);
  });

  test('최소 주문 금액 미만이면 거절', () => {
    const r = planGateSpotOrder({
      symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteAmount: 0.5, minQuoteAmount: 1,
    });
    eq(r.ok, false);
    assert(r.reason!.includes('최소'), r.reason);
  });

  console.log('[Gate 현물 — 지정가]');

  test('지정가는 수량 + 가격 + gtc', () => {
    const r = buyLimit();
    eq(r.ok, true);
    eq(r.body!.currency_pair, 'BTC_USDT');
    eq(r.body!.side, 'buy');
    eq(r.body!.type, 'limit');
    eq(r.body!.amount, '0.5');
    eq(r.body!.price, '60000');
    eq(r.body!.time_in_force, 'gtc');
  });

  test('가격이 없거나 0이면 거절', () => {
    eq(buyLimit({ price: null }).ok, false);
    eq(buyLimit({ price: 0 }).ok, false);
    eq(buyLimit({ price: -1 }).ok, false);
  });

  test('수량이 없거나 0이면 거절', () => {
    eq(buyLimit({ quantity: null }).ok, false);
    eq(buyLimit({ quantity: 0 }).ok, false);
  });

  test('표식을 실으면 그대로 나간다 — 없으면 중복 확인을 못 한다', () => {
    eq(buyLimit({ text: 't-ABC123' }).body!.text, 't-ABC123');
    eq(buyLimit().body!.text, undefined);
  });

  console.log('[Gate 현물 — 수량은 내림한다]');

  test('올림하면 보유량을 넘겨 매도가 거부된다', () => {
    eq(floorTo(0.123456789, 4), 0.1234);
    eq(floorTo(0.9999, 2), 0.99);
    eq(floorTo(5, 0), 5);
  });

  test('부동소수점 오차로 한 칸 내려가지 않는다', () => {
    eq(floorTo(0.3, 1), 0.3, '0.29999...로 읽혀 0.2가 되면 안 된다');
    eq(floorTo(1.1, 1), 1.1);
    eq(floorTo(2.675, 2), 2.67);
  });

  test('정밀도를 모르면 손대지 않는다 — 거래소 판단에 맡긴다', () => {
    eq(floorTo(0.123456789, null), 0.123456789);
    eq(planGateSpotOrder({
      symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.123456789,
    }).quantity, 0.123456789);
  });

  test('깎았으면 그 사실을 말한다 — 조용히 줄이면 왜 적게 팔렸는지 모른다', () => {
    const r = planGateSpotOrder({
      symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.98765, amountPrecision: 2,
    });
    eq(r.quantity, 0.98);
    assert(r.note!.includes('0.98'), r.note);
  });

  test('내림해서 0이 되면 보내지 않는다', () => {
    const r = planGateSpotOrder({
      symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.004, amountPrecision: 2,
    });
    eq(r.ok, false);
    assert(r.reason!.includes('최소 단위'), r.reason);
  });

  test('최소 주문 수량 미만이면 거절', () => {
    const r = planGateSpotOrder({
      symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.0005, minBaseAmount: 0.001,
    });
    eq(r.ok, false);
    assert(r.reason!.includes('최소 주문 수량'), r.reason);
  });

  console.log('[Gate 현물 — 체결 판정]');

  test('amount − left = 체결량', () => {
    const f = gateSpotFillOf({ amount: '1.0', left: '0.4', status: 'open' });
    close(f.filledQty as number, 0.6, 1e-9);
  });

  test('**left가 없으면 모르는 것이다 — 0이 아니다**', () => {
    const f = gateSpotFillOf({ amount: '1.0', status: 'open' });
    eq(f.filledQty, null, '0으로 적으면 미체결로 보여 사용자가 다시 넣는다');
    eq(f.unfilled, false, '모르는 것을 미체결로 단정하지 않는다');
  });

  test('거래소가 체결 수량을 따로 주면 그쪽을 믿는다 — 시장가 매수는 amount가 금액이다', () => {
    const f = gateSpotFillOf({ amount: '250', left: '0', filled_amount: '0.004', status: 'closed' });
    eq(f.filledQty, 0.004, 'amount−left(250)를 수량으로 쓰면 안 된다');
  });

  test('평균가는 체결금액 ÷ 체결수량', () => {
    const f = gateSpotFillOf({ amount: '2', left: '0', filled_total: '120000', status: 'closed' });
    eq(f.avgPrice, 60000);
  });

  test('평균가를 못 구하면 주문가라도 쓴다', () => {
    eq(gateSpotFillOf({ amount: '1', left: '1', price: '59000', status: 'open' }).avgPrice, 59000);
  });

  test('IOC가 하나도 안 붙고 취소된 것을 잡는다', () => {
    const f = gateSpotFillOf({ amount: '1', left: '1', status: 'cancelled' });
    eq(f.filledQty, 0);
    eq(f.unfilled, true);
  });

  test('아직 안 끝난 주문은 미체결로 단정하지 않는다', () => {
    eq(gateSpotFillOf({ amount: '1', left: '1', status: 'open' }).unfilled, false);
  });

  test('빈 응답에도 터지지 않는다', () => {
    const f = gateSpotFillOf(null);
    eq(f.filledQty, null);
    eq(f.status, null);
    eq(f.unfilled, false);
  });
}
