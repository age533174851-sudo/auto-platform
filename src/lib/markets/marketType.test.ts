// src/lib/markets/marketType.test.ts
//
// 여기서 막으려는 사고는 하나다 — **현물 매도가 선물 SHORT로 나가는 것.**
// 그래서 "현물에 없는 것이 정말 없는가"를 집요하게 확인한다.
import { test, assert, eq } from '../../test/harness';
import {
  parseMarketType, capability, isFutures, checkIntent,
  tagSignalId, marketTypeOf, untagSignalId,
  netExposure, basisPct, futuresSideToOrderSide,
  MARKET_TYPES, type MarketType,
} from './marketType';

export function runMarketTypeTests() {
  console.log('[시장 유형 — 현물에 없는 것]');

  test('현물에는 레버리지·청산가·마진모드·펀딩이 없다', () => {
    const c = capability('SPOT');
    eq(c.leverage, false, '현물에 레버리지가 있다고 표시됐다');
    eq(c.liquidation, false, '현물에 청산가가 있다고 표시됐다');
    eq(c.marginMode, false);
    eq(c.funding, false);
    eq(c.reduceOnly, false);
  });

  test('현물에는 공매도가 없다', () => {
    eq(capability('SPOT').canShort, false);
  });

  test('현물과 선물은 다른 지갑을 쓴다', () => {
    eq(capability('SPOT').wallet, 'SPOT_WALLET');
    eq(capability('USDT_FUTURES').wallet, 'FUTURES_WALLET');
    assert(capability('SPOT').wallet !== capability('USDT_FUTURES').wallet,
      '현물 잔고를 선물 증거금으로 계산하게 된다');
  });

  test('현물과 선물은 다른 주문 엔드포인트를 쓴다', () => {
    const eps = MARKET_TYPES.map(m => capability(m).orderEndpoint);
    eq(new Set(eps).size, MARKET_TYPES.length,
      '한 엔드포인트에 조건문으로 몰면 그 분기가 사고 지점이 된다');
    assert(capability('SPOT').orderEndpoint.includes('/spot/'), capability('SPOT').orderEndpoint);
  });

  console.log('[시장 유형 — 버튼 문구]');

  test('현물과 선물의 버튼 문구가 겹치지 않는다', () => {
    const spot = [capability('SPOT').buyLabel('BTC'), capability('SPOT').sellLabel('BTC')];
    const fut = [capability('USDT_FUTURES').buyLabel('BTC'), capability('USDT_FUTURES').sellLabel('BTC')];
    for (const s of spot) {
      assert(!fut.includes(s), `같은 문구가 양쪽에 있다: ${s}`);
      assert(!/LONG|SHORT/.test(s), `현물 버튼에 LONG/SHORT가 있다: ${s}`);
    }
    assert(fut.every(f => /LONG|SHORT/.test(f)), '선물 버튼에 방향이 없다');
  });

  console.log('[시장 유형 — 주문 사전 검사]');

  test('현물에 레버리지를 넣으면 막는다', () => {
    const r = checkIntent({ market: 'SPOT', side: 'BUY', quantity: 1, leverage: 10 });
    eq(r.ok, false, '현물 주문이 레버리지를 달고 통과했다');
  });

  test('현물에 reduce-only를 넣으면 막는다', () => {
    eq(checkIntent({ market: 'SPOT', side: 'BUY', quantity: 1, reduceOnly: true }).ok, false);
  });

  test('보유 수량보다 많이 팔 수 없다', () => {
    const r = checkIntent({ market: 'SPOT', side: 'SELL', quantity: 2, heldQty: 1 });
    eq(r.ok, false, '현물에서 없는 물량을 팔았다 — 공매도가 된다');
    assert(r.reason!.includes('공매도'), r.reason);
  });

  test('보유 수량을 모르면 현물 매도를 보류한다', () => {
    const r = checkIntent({ market: 'SPOT', side: 'SELL', quantity: 1, heldQty: null });
    eq(r.ok, false, '모르는 채로 매도를 내보냈다');
  });

  test('보유분 안에서의 현물 매도는 통과한다', () => {
    eq(checkIntent({ market: 'SPOT', side: 'SELL', quantity: 0.5, heldQty: 1.2 }).ok, true);
  });

  test('선물은 보유 없이도 SELL(=SHORT)이 가능하다', () => {
    eq(checkIntent({ market: 'USDT_FUTURES', side: 'SELL', quantity: 1, leverage: 10 }).ok, true);
  });

  test('수량이 이상하면 시장과 무관하게 막는다', () => {
    for (const m of MARKET_TYPES) {
      eq(checkIntent({ market: m, side: 'BUY', quantity: 0 }).ok, false, m);
      eq(checkIntent({ market: m, side: 'BUY', quantity: NaN }).ok, false, m);
    }
  });

  console.log('[시장 유형 — 해석은 실패하는 쪽으로]');

  test('모르는 값은 null이다 — 기본값을 주지 않는다', () => {
    for (const bad of ['', 'spot ', 'MARGIN', 'binance', null, undefined, 'FUTURES_X']) {
      eq(parseMarketType(bad as any), null, `'${bad}'가 어떤 시장으로 해석됐다`);
    }
  });

  test('정확한 값과 좁은 별칭만 받는다', () => {
    eq(parseMarketType('SPOT'), 'SPOT');
    eq(parseMarketType('usdt_futures'), 'USDT_FUTURES');
    eq(parseMarketType('USDT-FUTURES'), 'USDT_FUTURES');
    eq(parseMarketType('COIN_FUTURES'), 'COIN_FUTURES');
    eq(parseMarketType('futures'), 'USDT_FUTURES');
  });

  console.log('[시장 유형 — 컬럼 없이 기록]');

  test('signal_id 표식으로 유형을 남기고 다시 읽는다', () => {
    const tagged = tagSignalId('daily-ladder-2026-07-28-BTCUSDT', 'SPOT');
    assert(tagged.startsWith('[SPOT]'), tagged);
    eq(marketTypeOf({ signal_id: tagged }), 'SPOT');
    eq(untagSignalId(tagged), 'daily-ladder-2026-07-28-BTCUSDT');
  });

  test('표식을 두 번 붙이지 않는다', () => {
    const once = tagSignalId('x', 'SPOT');
    const twice = tagSignalId(once, 'USDT_FUTURES');
    eq(twice, '[USDT_FUTURES]x');
  });

  test('컬럼이 있으면 컬럼을 우선한다', () => {
    eq(marketTypeOf({ market_type: 'SPOT', signal_id: '[USDT_FUTURES]x' }), 'SPOT');
  });

  test('둘 다 없고 단서도 없으면 null이다', () => {
    eq(marketTypeOf({ signal_id: 'x' }), null, '모르는 것을 아는 척했다');
  });

  test('예전 행은 레버리지 유무로 선물이라 본다', () => {
    eq(marketTypeOf({ signal_id: 'x', leverage: 10 }), 'USDT_FUTURES');
  });

  console.log('[시장 유형 — 통합 노출]');

  test('현물과 선물을 합쳐 실제 방향을 낸다', () => {
    // 수량은 소수라 부동소수점 오차가 반드시 낀다. 합계를 반올림해서
    // 숨기지 않는다 — 표시할 때 자릿수를 정하는 것이 맞다.
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    assert(near(netExposure({ spotQty: 0.15, futuresQty: 0.02 }), 0.17));
    // 현물 보유 + 선물 숏 = 헤지된 상태
    assert(near(netExposure({ spotQty: 0.15, futuresQty: -0.10 }), 0.05),
      '헤지 후 순노출이 틀렸다');
    assert(near(netExposure({ spotQty: 0.1, futuresQty: -0.1 }), 0));
  });

  test('현물과 선물의 괴리를 낸다', () => {
    const b = basisPct(118_020, 118_046);
    assert(b !== null && Math.abs(b - 0.02203) < 0.001, String(b));
    eq(basisPct(null, 100), null, '한쪽이 없으면 계산하지 않는다');
    eq(basisPct(0, 100), null);
  });

  console.log('[시장 유형 — 방향 변환]');

  test('선물 방향만 BUY/SELL로 바꾼다', () => {
    eq(futuresSideToOrderSide('LONG'), 'BUY');
    eq(futuresSideToOrderSide('SHORT'), 'SELL');
  });

  test('선물 판별', () => {
    eq(isFutures('SPOT'), false);
    eq(isFutures('USDT_FUTURES'), true);
    eq(isFutures('COIN_FUTURES'), true);
  });
}
