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
import { gatePriceDecimals, roundGatePrice } from './gateSpotPrecision';

// 규격을 **읽은** 상태가 기본이다 — 실제 경로가 그렇다(`placeGateSpotOrder`가
// 먼저 `getGateSpotPair`를 부른다). 못 읽은 경우는 아래에 따로 시험이 있고,
// 그때 신규 매수는 보내지 않는다.
const buyLimit = (o: any = {}) => planGateSpotOrder({
  symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.5, price: 60000,
  pricePrecision: 2, ...o,
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

  // ══════════ ★ Gate의 네 축은 서로 다른 것이다 (4B-2B-1) ══════════
  //
  // Gate가 종목마다 주는 규격은 넷이고 의미가 전부 다르다:
  //
  //   amount_precision   수량 자릿수      min_base_amount   최소 주문 수량
  //   precision          가격 자릿수      min_quote_amount  최소 주문 금액
  //
  // 하나의 stepSize/minNotional 개념으로 뭉치면 한쪽 종목에서 조용히 틀린
  // 값이 나간다. 아래 시험은 넷이 **각각 다른 축**임을 값으로 고정한다.

  test('★ 가격 자릿수를 수량 자릿수로 대신하지 않는다', () => {
    // 수량은 2자리, 가격은 4자리인 종목. 한쪽으로 다른 쪽을 채우면 값이 갈린다.
    const r = buyLimit({
      quantity: 0.123456, price: 60000.123456,
      amountPrecision: 2, pricePrecision: 4,
    });
    assert(r.ok, `막혔습니다: ${r.reason}`);
    eq(r.body!.amount, '0.12', '수량이 가격 자릿수로 깎였습니다');
    eq(r.body!.price, '60000.1235', '★ 가격이 수량 자릿수로 깎였습니다');
  });

  test('★ 지정가가 실제 POST 본문에 정규화된 값으로 들어간다', () => {
    const r = buyLimit({ price: 60000.987654, pricePrecision: 2, amountPrecision: 3 });
    assert(r.ok, `막혔습니다: ${r.reason}`);
    eq(r.body!.price, '60000.99', '본문에 원값이 들어갔습니다');
    eq(r.precision!.requestedPrice, 60000.987654);
    eq(r.precision!.price, 60000.99);
    assert(r.precision!.priceApplied, '맞췄는데 안 맞췄다고 적혔습니다');
  });

  test('★ 가격 자릿수를 못 읽으면 지정가 매수를 보내지 않는다', () => {
    const r = buyLimit({ pricePrecision: null, amountPrecision: 3 });
    assert(!r.ok, '★ 모르는 자릿수로 신규 매수가 나갔습니다');
    assert(/자릿수/.test(r.reason || ''), `사유가 그 사실을 말하지 않습니다: ${r.reason}`);
  });

  test('★ 같은 상황에서 매도는 나간다 — 못 파는 것은 사고다', () => {
    const r = planGateSpotOrder({
      symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', quantity: 0.5, price: 60000.987,
      amountPrecision: 3, pricePrecision: null, isExit: true,
    });
    assert(r.ok, `매도가 막혔습니다: ${r.reason}`);
    eq(r.body!.price, '60000.987', '안 맞췄는데 값이 바뀌었습니다');
    assert(!r.precision!.priceApplied, '★ 안 맞췄는데 맞췄다고 적혔습니다');
    eq(r.precision!.priceSkipped, 'METADATA_UNKNOWN');
  });

  test('★ 시장가 매수(금액)에는 수량도 가격도 없다 — "못 읽음"이 아니다', () => {
    const r = planGateSpotOrder({
      symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteAmount: 100,
      minQuoteAmount: 1, amountPrecision: 3, pricePrecision: 2,
    });
    assert(r.ok, `막혔습니다: ${r.reason}`);
    eq(r.body!.amount, '100', '금액이 수량 자릿수로 깎였습니다');
    assert(r.body!.price === undefined, '시장가에 가격이 실렸습니다');
    eq(r.precision!.quantitySkipped, 'NOT_IN_ORDER');
    eq(r.precision!.priceSkipped, 'NOT_IN_ORDER');
    assert(r.precision!.quantitySkipped !== 'METADATA_UNKNOWN',
      '★ 해당 없음이 규격 미상으로 뭉개졌습니다');
  });

  test('★ 최소 금액과 최소 수량은 다른 축이다', () => {
    // 금액 하한만 걸리는 경우
    const byQuote = planGateSpotOrder({
      symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteAmount: 0.5,
      minQuoteAmount: 1, minBaseAmount: 0.0001,
    });
    assert(!byQuote.ok, '최소 금액 미달이 통과했습니다');
    assert(/금액/.test(byQuote.reason || ''), `수량 사유로 막혔습니다: ${byQuote.reason}`);

    // 수량 하한만 걸리는 경우 — 같은 값이라도 축이 다르면 사유가 다르다
    const byBase = planGateSpotOrder({
      symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.00005,
      amountPrecision: 8, minBaseAmount: 0.001, minQuoteAmount: 1,
    });
    assert(!byBase.ok, '최소 수량 미달이 통과했습니다');
    assert(/수량/.test(byBase.reason || ''), `금액 사유로 막혔습니다: ${byBase.reason}`);
  });

  test('수량은 내림, 가격은 반올림이다 — 정책이 다르다', () => {
    // 올림된 수량은 보유를 넘겨 거부되지만, 지정가는 한 칸 위여도 유효하다.
    eq(floorTo(0.129, 2), 0.12);
    eq(roundGatePrice(100.129, 2).price, 100.13);
  });

  // ══════════ 자릿수 → 증분 변환 ══════════

  test('가격 자릿수를 확정하는 곳은 한 곳뿐이다', () => {
    eq(gatePriceDecimals(0), 0, '정수 호가는 뜻이 있는 값이다');
    eq(gatePriceDecimals(2), 2);
    eq(gatePriceDecimals('8'), 8);
  });

  test('★ 모르는 자릿수는 null이다 — 0이 아니다 (Number(null)===0 함정)', () => {
    for (const bad of [null, undefined, '', -1, 1.5, NaN, 'x', 101]) {
      eq(gatePriceDecimals(bad as any), null,
        `${JSON.stringify(bad)}가 자릿수로 읽혔습니다`);
    }
    // 0으로 읽히면 모든 지정가가 정수로 반올림된다
    const r = roundGatePrice(60000.987, null);
    eq(r.price, 60000.987, '★ 규격을 못 읽었는데 가격이 바뀌었습니다');
    assert(!r.applied);
  });

  test('★ 자릿수에 맞추니 0이 되는 지정가는 보내지 않는다', () => {
    // `String(null)`은 `'null'`이고, 그 문자열이 그대로 거래소로 나간다.
    // 값이 없으면 본문을 만들지 않는다.
    const r = buyLimit({ price: 0.004, pricePrecision: 2 });
    assert(!r.ok, '★ 0이 된 가격이 통과했습니다');
    assert(r.body == null, "본문이 만들어졌습니다 — 'null' 문자열이 나갈 수 있습니다");
    assert(/0이 됩니다/.test(r.reason || ''), `사유가 그 사실을 말하지 않습니다: ${r.reason}`);
  });

  test('가격이 없으면 "이 주문에 없음"이지 "못 읽음"이 아니다', () => {
    const r = roundGatePrice(null, 2);
    eq(r.skipped, 'NOT_IN_ORDER');
    assert(!r.applied, '없는 가격을 맞췄다고 적었습니다');
  });
}