// src/test/integration/killCloseIntegration.test.ts
//
// **긴급 종료를 실제 실행 경로에서 돌린다.**
//
// 실제로 도는 것: `executeKillActions` → `runKillClose` 순서 →
//   `accountCloseModeGate`(실제 모드 조회) → `futuresListPositions` →
//   `futuresOpenOrdersAll` → `cancelExact` → `prepareSymbolClose`
//   (모드 관문·방향 검증·현재 노출 수량·멱등 키) → `sendSymbolClose` →
//   서명 생성 · 질의 조립 · 응답 파싱 · 잔여 재조회 · 보호 상태 판정
//
// 가짜로 바꾸는 것: `fetch` 한 겹 · Supabase 한 겹
//
// ★ 이 묶음이 증명하려는 **단 하나**: 닫을 수 없는 상황에서 기존
//   보호주문이 **취소되지 않는다.** 그래서 모든 시나리오가 DELETE
//   호출 수를 센다 — 0이어야 하는 자리에서 0인지.

import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb, withCryptoEnv } from './venueHarness';
// 정적 import — 러너가 이 사슬을 컴파일 대상에 넣어야 한다.
import { executeKillActions } from '../../lib/risk/killSwitch';
import { planKillClose } from '../../lib/risk/killClosePlan';

const DUAL = '/fapi/v1/positionSide/dual';
const POS = '/fapi/v2/positionRisk';
const OPEN = '/fapi/v1/openOrders';
const ORDER = '/fapi/v1/order';
const EXINFO = '/fapi/v1/exchangeInfo';

const KEY = 'K'.repeat(64);
const SECRET = 'S'.repeat(64);

interface VOpts {
  hedge?: boolean;
  /** 모드 조회가 실패한다 */
  modeFails?: boolean;
  /** positionRisk 응답 (전송 전) */
  positions?: any[];
  /** 전송 뒤에도 남아 있는가 */
  leftAfter?: boolean;
  openOrders?: any[];
  /** 미체결 조회가 실패한다 */
  openOrdersFail?: boolean;
  /** 종료 주문 응답 */
  orderReply?: any;
  /** 취소(DELETE) 응답 */
  cancelReply?: any;
  /** 포지션 조회가 실패한다 */
  positionsFail?: boolean;
}

function venueFor(o: VOpts = {}): FakeVenue {
  const v = new FakeVenue();
  v.on(DUAL, o.modeFails
    ? { status: 500, json: { code: -1000, msg: 'down' } }
    : { json: { dualSidePosition: o.hedge === true } });
  v.on(EXINFO, { json: { symbols: [{
    symbol: 'BTCUSDT', filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
    ] }] } });
  // ★ 취소된 번호는 **목록에서 사라진다.** 사라지지 않으면 `cancelExact`가
  //   "아직 남았다"고 보고 최대 3회 재시도한다 — 그러면 취소 호출 수가
  //   실제 의미와 달라져 시험이 거짓 신호를 낸다.
  const deleted = new Set<string>();
  v.on(OPEN, o.openOrdersFail
    ? { status: 500, json: { code: -1000, msg: 'down' } }
    : { json: () => (o.openOrders ?? [
        { orderId: 111, symbol: 'BTCUSDT', type: 'STOP_MARKET' },
        { orderId: 999, symbol: 'SOLUSDT', type: 'STOP_MARKET' },
      ]).filter((x: any) => !deleted.has(String(x.orderId))) });
  v.on(ORDER, o.cancelReply ?? { json: (): any => {
    const last = [...v.calls].reverse().find(c => c.method === 'DELETE');
    const id = String(last?.params?.orderId ?? '');
    if (id) deleted.add(id);
    return { orderId: Number(id) || 0, status: 'CANCELED' };
  } }, 'DELETE');
  v.on(ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET');
  v.on(ORDER, o.orderReply ?? {
    json: { orderId: 7777, symbol: 'BTCUSDT', status: 'FILLED',
      executedQty: '0.010', avgPrice: '100000' } }, 'POST');
  v.on(POS, o.positionsFail
    ? { status: 500, json: { code: -1000, msg: 'down' } }
    : { json: () => {
        const sent = v.orderSends().length > 0;
        const open = !sent || o.leftAfter === true;
        const rows = o.positions ?? [{ symbol: 'BTCUSDT', positionAmt: '0.010',
          entryPrice: '100000', markPrice: '100000', leverage: '10',
          marginType: 'isolated', liquidationPrice: '90000', unRealizedProfit: '0' }];
        return open ? rows : rows.map((r: any) => ({ ...r, positionAmt: '0' }));
      } });
  return v;
}

async function exec(venue: FakeVenue, actionMode: string, over: any = {}) {
  const restore = venue.install();
  const unenv = withCryptoEnv();
  const db = new FakeDb();
  try {
    const r = await executeKillActions(db as any, 'u1', 'conn-1', {
      key: KEY, secret: SECRET, testnet: true, exchange: 'binance',
      actionMode, ...over,
    });
    return { r, db };
  } finally { restore(); unenv(); }
}

/** 취소(DELETE) 호출 수 — 0이어야 하는 자리에서 0인지 센다 */
const cancels = (v: FakeVenue) => v.countOf(ORDER, 'DELETE');

export async function runKillCloseIntegrationTests() {
  console.log('[통합 — 긴급 종료 안전성 (fetch·DB만 가짜)]');

  // ══════════ ① 단방향 정상 — 대상만 취소하고 닫는다 ══════════
  {
    const v = venueFor();
    const { r } = await exec(v, 'ABCD');

    test('① 단방향: 대상 심볼 주문만 취소하고 축소 전용으로 닫는다', () => {
      assert(v.calls.length > 0, '거래소 호출이 하나도 없다 — 경로가 안 돌았다');
      eq(r.safety?.mayClose, true);
      eq(r.safety?.planCode, 'PROCEED');
      eq(v.orderSends().length, 1, '종료 주문 1건');
      eq(cancels(v), 1, '취소 1건 (대상 심볼만)');
      eq(r.close?.success, true);
      eq(r.safety?.protectionCode, 'CLOSED');
      eq(r.safety?.unprotected, false);
    });

    test('★ ① 종료 주문에 멱등 식별자가 실린다', () => {
      const send = v.orderSends()[0];
      const cid = send.params.newClientOrderId;
      assert(!!cid, '멱등 키가 없다 — 거래소가 중복을 알아볼 수 없다');
      assert(cid.startsWith('k5t'), `긴급 종료 접두사여야 한다 — ${cid}`);
      eq(send.params.reduceOnly, 'true');
      eq(send.params.side, 'SELL', 'LONG을 닫으려면 SELL');
    });

    test('★ ① 계좌 전체 취소 엔드포인트를 부르지 않는다', () => {
      eq(v.countOf('/fapi/v1/allOpenOrders'), 0,
        '★ 계좌 전체 취소는 다른 전략의 보호주문까지 지운다');
    });

    test('★ ① 모드 조회가 취소보다 먼저 일어난다', () => {
      const iDual = v.calls.findIndex(c => c.path.includes(DUAL));
      const iDel = v.calls.findIndex(c => c.method === 'DELETE');
      assert(iDual >= 0, '모드를 읽지 않았다');
      assert(iDel < 0 || iDual < iDel, '★ 모드 확인이 취소보다 앞이어야 한다');
    });
  }

  // ══════════ ② 양방향 — 취소 0건 · 주문 0건 ══════════
  {
    const v = venueFor({ hedge: true });
    const { r } = await exec(v, 'ABCD');

    test('★★ ② 양방향 계좌: 보호주문을 취소하지 않고 주문도 보내지 않는다', () => {
      eq(cancels(v), 0, '★ 닫지도 못하면서 보호만 벗기면 안 된다');
      eq(v.orderSends().length, 0);
      eq(r.safety?.mayClose, false);
      eq(r.safety?.mayCancel, false);
      eq(r.safety?.planCode, 'BLOCKED_HEDGE');
      eq(r.safety?.manualInterventionRequired, true);
      eq(r.safety?.unprotected, false, '보호주문이 그대로 남아 있다');
    });
  }

  // ══════════ ③ 모드 UNKNOWN — 취소 0건 · 주문 0건 ══════════
  {
    const v = venueFor({ modeFails: true });
    const { r } = await exec(v, 'ABCD');

    test('★★ ③ 모드를 못 읽으면 취소 0건 · 주문 0건', () => {
      eq(cancels(v), 0);
      eq(v.orderSends().length, 0);
      eq(r.safety?.planCode, 'BLOCKED_MODE_UNKNOWN');
      eq(r.safety?.manualInterventionRequired, true);
    });
  }

  // ══════════ ④ 포지션을 못 읽음 ══════════
  {
    const v = venueFor({ positionsFail: true });
    const { r } = await exec(v, 'ABCD');

    test('★ ④ 포지션을 못 읽으면 flat이 아니다 — 취소 0건 · 주문 0건', () => {
      eq(cancels(v), 0);
      eq(v.orderSends().length, 0);
      eq(r.safety?.planCode, 'BLOCKED_POSITIONS_UNREAD');
    });
  }

  // ══════════ ⑤ 미체결을 못 읽음 — 전체 취소로 대신하지 않는다 ══════════
  {
    const v = venueFor({ openOrdersFail: true });
    const { r } = await exec(v, 'ABCD');

    test('★ ⑤ 미체결을 못 읽으면 취소를 건너뛰고 종료만 한다', () => {
      eq(cancels(v), 0, '★ 임의 전체 취소 금지');
      eq(v.orderSends().length, 1, '종료는 위험을 줄이는 방향');
      eq(r.safety?.planCode, 'BLOCKED_ORDERS_UNREAD');
      eq(r.safety?.manualInterventionRequired, true);
    });
  }

  // ══════════ ⑥ SHORT 포지션 — 절댓값에 속지 않는다 ══════════
  {
    const v = venueFor({ positions: [{ symbol: 'BTCUSDT', positionAmt: '-0.010',
      entryPrice: '100000', markPrice: '100000', leverage: '10',
      marginType: 'isolated', liquidationPrice: '110000', unRealizedProfit: '0' }] });
    const { r } = await exec(v, 'ABCD');

    test('★ ⑥ SHORT 포지션이 실제로 닫힌다 (BUY로 나간다)', () => {
      eq(v.orderSends().length, 1);
      eq(v.orderSends()[0].params.side, 'BUY', '★ SHORT를 닫으려면 BUY');
      eq(r.safety?.mayClose, true);
      eq(r.close?.success, true);
    });
  }

  // ══════════ ⑦ 울타리 상실 — 취소 0건 · 주문 0건 ══════════
  {
    const v = venueFor();
    const { r } = await exec(v, 'ABCD', { stillMine: async () => false });

    test('★★ ⑦ 쓰기 직전 울타리를 잃으면 취소 0건 · 주문 0건', () => {
      eq(cancels(v), 0, '★ 임차를 잃은 실행자가 남의 보호주문을 지우면 안 된다');
      eq(v.orderSends().length, 0);
      eq(r.safety?.ordersSent, 0);
    });
  }

  {
    const v = venueFor();
    const { r } = await exec(v, 'ABCD', {
      stillMine: async () => { throw new Error('db down'); } });

    test('★ ⑦-b 울타리 조회가 던지면 쓰지 않는다 (fail-closed)', () => {
      eq(cancels(v), 0);
      eq(v.orderSends().length, 0);
      void r;
    });
  }

  // ══════════ ⑦-c 선점했지만 상대가 이미 닫았다 ══════════
  //
  //   선점만으로 **이미 전송 중인 주문**은 취소되지 않는다. 그래서 상대가
  //   먼저 닫아 버린 상태로 우리가 도착할 수 있다. 그때 우리는 **새 주문을
  //   보내지 않고**, 닫힌 것을 실패로 적지도 않아야 한다.
  {
    const v = venueFor({ positions: [{ symbol: 'BTCUSDT', positionAmt: '0',
      entryPrice: '0', markPrice: '100000', leverage: '10',
      marginType: 'isolated', liquidationPrice: '0', unRealizedProfit: '0' }] });
    const { r } = await exec(v, 'ABCD');

    test('★ ⑦-c 상대가 이미 닫았으면 주문 0건이고 실패가 아니다', () => {
      eq(v.orderSends().length, 0, '★ 이미 닫힌 자리에 보내면 반대 포지션이 된다');
      eq(cancels(v), 0, '닫을 것이 없으면 취소도 하지 않는다');
      eq(r.safety?.planCode, 'NOTHING_TO_DO');
      eq(r.safety?.manualInterventionRequired, false);
    });
  }

  // ══════════ ⑦-d 상대의 주문이 전송 중이다 (같은 멱등 키) ══════════
  //
  //   선점 직후, 상대가 **같은 종료 의도**로 이미 보낸 주문이 거래소에
  //   있을 수 있다. 그때 우리 주문은 중복 식별자로 거부된다 — 그것은
  //   실패가 아니라 "누가 이미 보냈다"는 뜻이고, 결과는 재조회가 정한다.
  {
    const v = venueFor({
      orderReply: { status: 400,
        json: { code: -4116, msg: 'Duplicate client order id.' } },
      // 상대의 주문이 체결돼 잔여 0
      leftAfter: false,
    });
    const { r } = await exec(v, 'ABCD');

    test('★ ⑦-d 같은 멱등 키의 중복 거부는 실패로 적지 않는다', () => {
      eq(v.orderSends().length, 1, '★ 중복 응답 뒤에 또 보내지 않는다');
      eq(r.close?.success, true, '재조회로 잔여 0을 확인했다');
      eq(r.safety?.protectionCode, 'CLOSED');
      eq(r.safety?.unprotected, false);
    });
  }
  {
    // 같은 상황에서 잔여가 남아 있으면 **모른다**로 적는다
    const v = venueFor({
      orderReply: { status: 400,
        json: { code: -4116, msg: 'Duplicate client order id.' } },
      leftAfter: true,
    });
    const { r } = await exec(v, 'ABCD');

    test('★ ⑦-d2 중복 거부 + 잔여 있으면 닫혔다고 적지 않는다', () => {
      eq(r.close?.success, false);
      eq(r.safety?.protectionCode, 'UNPROTECTED_EXPOSURE',
        '★ 취소는 했고 포지션은 남았다');
      eq(r.safety?.unprotected, true);
      eq(r.safety?.manualInterventionRequired, true);
    });
  }

  // ══════════ ⑧ 주문 타임아웃 — 재전송하지 않는다 ══════════
  {
    const v = venueFor({ orderReply: { timeout: true }, leftAfter: true });
    const { r } = await exec(v, 'ABCD');

    test('★ ⑧ 전송이 모호하면 곧바로 재전송하지 않는다', () => {
      eq(v.orderSends().length, 1, '★ 중복 전송 0');
      eq(r.close?.success, false);
      eq(r.safety?.protectionCode, 'UNPROTECTED_EXPOSURE',
        '★ 취소했는데 포지션이 남았다');
      eq(r.safety?.unprotected, true);
      eq(r.safety?.manualInterventionRequired, true);
    });
  }

  // ══════════ ⑨ 거부 + 잔여 — 무방비 노출로 적는다 ══════════
  {
    const v = venueFor({
      orderReply: { status: 400, json: { code: -2010, msg: 'rejected' } },
      leftAfter: true,
    });
    const { r } = await exec(v, 'ABCD');

    test('★★ ⑨ 보호주문을 취소한 뒤 종료가 실패하면 무방비로 적는다', () => {
      assert(cancels(v) >= 1, '취소는 보냈다');
      eq(r.safety?.protectionCode, 'UNPROTECTED_EXPOSURE');
      eq(r.safety?.unprotected, true);
      eq(r.close?.success, false, '★ 실패를 성공으로 적지 않는다');
    });

    test('★ ⑨ 거부 뒤 재시도 전에 거래소에 먼저 묻는다', () => {
      assert(v.countOf(ORDER, 'GET') >= 1,
        '★ 재시도 전 조회가 없으면 중복 주문이 나간다');
    });
  }

  // ══════════ ⑩ 닫지 않는 단계(C만) — 보호주문을 남긴다 ══════════
  {
    const v = venueFor({ openOrders: [
      { orderId: 111, symbol: 'BTCUSDT', type: 'STOP_MARKET' },  // 포지션 있음
      { orderId: 222, symbol: 'ETHUSDT', type: 'LIMIT' },        // 포지션 없음
    ] });
    const { r } = await exec(v, 'ABC');

    test('★★ ⑩ 닫지 않는 단계는 포지션이 있는 심볼의 주문을 취소하지 않는다', () => {
      eq(v.orderSends().length, 0, '이 단계는 포지션을 닫지 않는다');
      eq(r.safety?.retainedProtective, 1, '★ BTCUSDT 주문은 보호일 수 있어 남긴다');
      eq(r.safety?.cancelScope, 1, 'ETHUSDT 대기 주문만 취소');
      const deleted = v.calls.filter(c => c.method === 'DELETE');
      eq(deleted.length, 1);
      eq(deleted[0].params.orderId, '222', '★ 지운 것은 포지션 없는 심볼의 것뿐');
    });
  }

  // ══════════ ⑪ 재시작 — 같은 노출이면 같은 식별자 ══════════
  {
    const a = venueFor(); await exec(a, 'ABCD');
    const b = venueFor(); await exec(b, 'ABCD');

    test('★ ⑪ 재시작해도 같은 노출이면 같은 멱등 식별자다', () => {
      eq(a.orderSends()[0].params.newClientOrderId,
        b.orderSends()[0].params.newClientOrderId);
    });
  }

  // ══════════ ⑫ 부분 체결 뒤 다음 회차 ══════════
  {
    const first = venueFor({ leftAfter: true });
    await exec(first, 'ABCD');
    const second = venueFor({ positions: [{ symbol: 'BTCUSDT', positionAmt: '0.004',
      entryPrice: '100000', markPrice: '100000', leverage: '10',
      marginType: 'isolated', liquidationPrice: '90000', unRealizedProfit: '0' }] });
    const { r } = await exec(second, 'ABCD');

    test('★ ⑫ 부분 체결 뒤 다음 회차는 지금 관측한 노출로 닫는다', () => {
      eq(second.orderSends()[0].params.quantity, '0.004',
        '★ 진입 수량이 아니라 지금 노출');
      eq(r.close?.success, true);
      assert(first.orderSends()[0].params.newClientOrderId
        !== second.orderSends()[0].params.newClientOrderId,
        '★ 다른 수량은 다른 의도 — 정당한 재시도가 막히지 않는다');
    });
  }

  // ══════════ ⑬ 판정 정본이 실제로 이 경로를 통제하는가 ══════════
  test('★ ⑬ 판정 정본이 막으면 어떤 입력으로도 취소가 열리지 않는다', () => {
    for (const mv of [
      null,
      { ok: false, code: 'UNKNOWN', mode: null, message: '' },
      { ok: false, code: 'HEDGE_UNVERIFIED', mode: 'HEDGE' as const, message: '' },
    ]) {
      const p = planKillClose({
        modeVerdict: mv as any,
        positions: { ok: true, rows: [{ symbol: 'BTCUSDT', amount: 1, side: 'LONG' }] },
        openOrders: { ok: true, rows: [{ id: '1', symbol: 'BTCUSDT' }] },
      });
      eq(p.mayCancel, false);
      eq(p.cancelIds.length, 0);
    }
  });
}
