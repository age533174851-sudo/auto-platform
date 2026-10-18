// src/test/integration/positionReadFailClosedIntegration.test.ts
//
// **포지션·주문을 읽지 못한 것을 "없다"로 적지 않는다 — 실제 어댑터 경로.**
//
// 실제로 도는 것: `getFuturesPositions` → `parseFuturesPositionRows`
//   그리고 그 위에 얹힌 `closeAllPositions` · `cancelAllOpenOrders` ·
//   `cancelOpenTPSL`. 서명 생성과 응답 파싱까지 전부 실물이다.
// 가짜로 바꾸는 것: `fetch` 한 겹.
//
// 왜 이 묶음이 필요한가
// ─────────────────────
// 엄격 파서(`parseFuturesPositionRows`)가 들어오면서 **조회 실패가 늘었다.**
// 전에는 이상한 줄을 조용히 건너뛰고 "0개"로 돌려줬고, 그 0이 호출부에서
// "전부 닫혔다"로 읽혔다. 파서만 고치고 그 위층을 놔두면 같은 거짓말이
// 한 칸 위로 옮겨갈 뿐이다. 그래서 **위층이 null을 돌려주는지**를 센다.
//
//   remaining: 0  → "전부 닫혔다"
//   remaining: null → "모른다"
//
// 이 둘이 섞이면 살아 있는 포지션 위에서 운영이 끝난 것으로 적힌다.

import { test, eq, assert } from '../harness';
import { FakeVenue } from './venueHarness';
// 정적 import — 러너가 이 사슬을 컴파일 대상에 넣어야 한다.
import {
  getFuturesPositions, closeAllPositions, cancelAllOpenOrders, cancelOpenTPSL,
} from '../../lib/exchanges/binanceFutures';

const POS = '/fapi/v2/positionRisk';
const OPEN = '/fapi/v1/openOrders';
const ORDER = '/fapi/v1/order';
const ALL_OPEN = '/fapi/v1/allOpenOrders';

const KEY = 'K'.repeat(64);
const SECRET = 'S'.repeat(64);

/**
 * 바이낸스 USDⓈ-M `/fapi/v2/positionRisk`가 **실제로 주는 줄**.
 *
 * 통합 하네스의 모의 응답이 이 계약에서 벗어나면 (실제로 `unRealizedProfit`
 * 한 칸이 빠져 있었다) 시험은 "거래소가 주지 않는 모양"을 시험하게 되고,
 * 그 통과는 아무것도 보증하지 않는다.
 */
const REAL_ROW = {
  symbol: 'BTCUSDT', positionAmt: '0.010', entryPrice: '100000',
  breakEvenPrice: '100050', markPrice: '100300', unRealizedProfit: '3',
  liquidationPrice: '99400', leverage: '100', maxNotionalValue: '50000',
  marginType: 'isolated', isolatedMargin: '10.0', isAutoAddMargin: 'false',
  positionSide: 'BOTH', notional: '1003', isolatedWallet: '10',
  updateTime: 1_760_000_000_000, isolated: true, adlQuantile: 2,
};

async function on<T>(v: FakeVenue, fn: () => Promise<T>): Promise<T> {
  const restore = v.install();
  try { return await fn(); } finally { restore(); }
}

export async function runPositionReadFailClosedTests() {
  console.log('[통합 — 조회 실패를 "없음"으로 적지 않는다]');

  // ══════════ ⓪ 실제 응답 계약은 그대로 통과한다 ══════════
  //
  // 엄격해진 파서가 **진짜 응답**까지 막으면 그건 수정이 아니라 고장이다.
  {
    const v = new FakeVenue().on(POS, { json: [REAL_ROW] });
    const r: any = await on(v, () => getFuturesPositions(KEY, SECRET, true));

    test('★ ⓪ 거래소가 실제로 주는 줄은 그대로 읽힌다', () => {
      eq(r.success, true, String(r.message));
      eq(r.positions.length, 1);
      eq(r.positions[0].side, 'LONG');
      eq(r.positions[0].amount, 0.01);
      eq(r.positions[0].unrealizedPnl, 3);
    });
  }

  // ══════════ ① 칸 하나가 **빠진** 줄은 평탄이 아니다 ══════════
  //
  // 값이 깨진 것이 아니라 **없는** 경우다 — 하네스가 실제로 그랬다.
  {
    const { unRealizedProfit: _drop, ...missing } = REAL_ROW;
    const v = new FakeVenue().on(POS, { json: [missing] });
    const r: any = await on(v, () => getFuturesPositions(KEY, SECRET, true));

    test('★ ① 미실현손익 칸이 빠진 줄을 "포지션 없음"으로 읽지 않는다', () => {
      eq(r.success, false);
      assert(r.positions === undefined || r.positions.length === 0,
        '못 읽은 조회가 포지션 목록을 내놓았다');
    });
  }

  // ══════════ ② 못 읽으면 "남은 수"는 null이다 (0이 아니다) ══════════
  {
    const { markPrice: _drop, ...missing } = REAL_ROW;
    const v = new FakeVenue()
      .on(POS, { json: [missing] })
      .on(ORDER, { json: { orderId: 1, status: 'FILLED' } }, 'POST');
    const r: any = await on(v, () => closeAllPositions(KEY, SECRET, true, 2));

    test('★ ② 포지션을 못 읽으면 "전부 닫혔다"로 적지 않는다', () => {
      eq(r.success, false);
      eq(r.remaining, null, '못 읽은 잔여를 0으로 적으면 운영이 끝난 것이 된다');
      eq(v.orderSends().length, 0, '무엇을 닫는지 모르는 채로 주문이 나갔다');
    });
  }

  // ══════════ ③ 응답 자체가 실패해도 같다 ══════════
  {
    const v = new FakeVenue()
      .on(POS, { status: 500, json: { code: -1000, msg: 'down' } })
      .on(ORDER, { json: { orderId: 1, status: 'FILLED' } }, 'POST');
    const r: any = await on(v, () => closeAllPositions(KEY, SECRET, true, 2));

    test('★ ③ 조회가 500이어도 잔여는 null이고 주문은 0건이다', () => {
      eq(r.success, false);
      eq(r.remaining, null);
      eq(v.orderSends().length, 0);
    });
  }

  // ══════════ ④ 대상 목록을 못 만들면 취소도 보내지 않는다 ══════════
  //
  // 예전에는 포지션 조회가 실패해도 주문 쪽 심볼만으로 목록을 만들어
  // **반쪽짜리 취소**를 하고 `success: true`를 돌려줬다. 포지션에만
  // 붙어 있던 보호주문은 남는데 보고는 "전부 취소"였다.
  {
    const { leverage: _drop, ...missing } = REAL_ROW;
    const v = new FakeVenue()
      .on(OPEN, { json: [] })
      .on(POS, { json: [missing] })
      .on(ALL_OPEN, { json: { code: 200, msg: 'ok' } }, 'DELETE');
    const r: any = await on(v, () => cancelAllOpenOrders(KEY, SECRET, true));

    test('★ ④ 취소 대상을 못 세면 취소를 보내지 않고 실패로 적는다', () => {
      eq(r.success, false);
      eq(r.count, 0);
      eq(v.countOf(ALL_OPEN, 'DELETE'), 0, '대상을 모르는 채로 취소가 나갔다');
    });
  }

  // ══════════ ⑤ 개별 취소 실패를 "전부 취소됨"으로 적지 않는다 ══════════
  {
    const orders = [
      { orderId: 11, symbol: 'BTCUSDT', type: 'STOP_MARKET', side: 'SELL',
        stopPrice: '99000', closePosition: true, reduceOnly: false, origQty: '0', price: '0' },
      { orderId: 12, symbol: 'BTCUSDT', type: 'TAKE_PROFIT_MARKET', side: 'SELL',
        stopPrice: '101000', closePosition: true, reduceOnly: false, origQty: '0', price: '0' },
    ];
    const v = new FakeVenue()
      .on(OPEN, { json: orders })
      .on(ORDER, { status: 400, json: { code: -2011, msg: 'Unknown order sent.' } }, 'DELETE');
    const r: any = await on(v, () => cancelOpenTPSL(KEY, SECRET, 'BTCUSDT', true));

    test('★ ⑤ 첫 취소가 거부되면 멈추고, 지운 수를 정직하게 적는다', () => {
      eq(r.success, false);
      eq(r.cancelled, 0, '지우지 못한 것을 지웠다고 적었다');
      eq(v.countOf(ORDER, 'DELETE'), 1,
        '거부를 무시하고 다음 주문까지 지우러 갔다');
    });
  }

  // ══════════ ⑥ 미체결을 못 읽으면 지울 것이 없다고 적지 않는다 ══════════
  {
    const v = new FakeVenue()
      .on(OPEN, { status: 500, json: { code: -1000, msg: 'down' } })
      .on(ORDER, { json: { code: 200 } }, 'DELETE');
    const r: any = await on(v, () => cancelOpenTPSL(KEY, SECRET, 'BTCUSDT', true));

    test('★ ⑥ 미체결 조회 실패는 "취소할 것이 없음"이 아니다', () => {
      eq(r.success, false);
      eq(r.cancelled, 0);
      eq(v.countOf(ORDER, 'DELETE'), 0);
    });
  }
}
