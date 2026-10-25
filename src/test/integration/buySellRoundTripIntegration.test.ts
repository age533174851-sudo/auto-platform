// src/test/integration/buySellRoundTripIntegration.test.ts
//
// **매수 → 체결 → 포지션 → 매도(reduce-only) → 체결 → 잔여 0.**
// 한 시나리오가 끝까지 이어서 돈다.
//
// 왜 이 파일이 따로 필요한가
// ──────────────────────────
// 통합 시험이 이미 여럿 있지만 전부 **구간별**이다 — 주문 경로는 주문
// 경로만, 청산 경로는 청산 경로만 본다. 그래서 "매수는 되는데 그 포지션을
// 실제로 닫을 수 있는가"를 아무도 한 번에 확인하지 않았다.
//
// 구간이 각각 초록인데 이어 붙이면 깨지는 자리는 **경계**에 있다:
// 매수가 적은 수량을 청산이 그대로 읽는가, 체결 증거가 다음 단계로
// 넘어가는가, 닫은 뒤의 0이 **확인된 0**인가.
//
// 여기서 실제로 도는 것
// ─────────────────────
//   `executeOrder`         매수 (의도 기록 → 중복 확인 → 전송 → 결과 기록)
//   `readOpenPosition`     포지션 조회
//   `prepareSymbolClose`   매도 준비 (모드 관문 · 방향 · 수량 · 멱등 키)
//   `sendSymbolClose`      매도 전송 (reduce-only)
//
// 가짜는 `fetch` 한 겹과 Supabase 한 겹뿐이다. **거래소에 실제 주문을
// 보내지 않는다.**
//
// #436과 겹치지 않는다
// ────────────────────
// #436은 `positionRiskRead.ts`의 깨진 `positionAmt` 판정과
// `orderPathIntegration.test.ts`를 고친다. 이 파일은 둘 다 건드리지 않고
// 새 파일만 더한다.
import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb, withCryptoEnv } from './venueHarness';
import { executeOrder } from '../../lib/engine/orderExecutor';
import {
  readOpenPosition, prepareSymbolClose, sendSymbolClose,
} from '../../lib/engine/venuePositionOps';

const BN_ORDER = '/fapi/v1/order';
const BN_POS = '/fapi/v2/positionRisk';
const BN_DUAL = '/fapi/v1/positionSide/dual';
const BN_EXINFO = '/fapi/v1/exchangeInfo';
const BN_LEV = '/fapi/v1/leverage';

const QTY = 0.01;
const ENTRY = 100_000;
const EXIT = 101_000;

const creds = () => ({
  exchange: 'binance' as const,
  apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64), testnet: true,
});

const plan = (over: Record<string, any> = {}) => ({
  approved: true, symbol: 'BTCUSDT', side: 'LONG' as const,
  riskAmount: 10, riskAmountWithCosts: 10,
  stopDistancePct: 1, effectiveStopPct: 1,
  positionSize: QTY * ENTRY, quantity: QTY, requiredMargin: 10,
  leverage: 100, liquidationPrice: 90_000, liquidationDistancePct: 1,
  notes: [], ...over,
}) as any;

/** 포지션 조회 응답 한 줄 */
const posRow = (amt: string) => ([{
  symbol: 'BTCUSDT', positionAmt: amt, entryPrice: amt === '0' ? '0' : String(ENTRY),
  leverage: '100', marginType: 'isolated', liquidationPrice: '90000',
  unRealizedProfit: '0', positionSide: 'BOTH',
}]);

/**
 * 거래소 한 대. **포지션이 상태를 가진다** — 매수가 체결되면 조회에
 * 잡히고, reduce-only 매도가 체결되면 0이 된다. 그래야 "닫았다"가
 * 거래소가 보여 준 사실이 된다.
 */
function stage() {
  let amt = 0;                    // 지금 열린 수량
  const venue = new FakeVenue();
  const fill = (id: number, q: number, px: number, orig = QTY) => ({
    orderId: id, symbol: 'BTCUSDT', status: q >= orig ? 'FILLED' : 'PARTIALLY_FILLED',
    executedQty: String(q), origQty: String(orig), avgPrice: String(px),
  });
  const api = {
    venue,
    openQty: () => amt,
    /**
     * 조회는 **지금 상태**를 돌려준다. v2·v3 둘 다 불리므로 'positionRisk'
     * 조각으로 한 번에 받는다.
     */
    wirePositions() {
      venue.on('positionRisk', { json: () => posRow(amt === 0 ? '0' : String(amt)) });
      return api;
    },
    /**
     * reduce-only 매도는 **파라미터로** 가른다. 바이낸스 선물 주문은
     * 질의 문자열로 나가므로 body가 아니라 params를 봐야 한다.
     * 더 좁은 규칙을 먼저 등록한다 — 먼저 등록한 쪽이 이긴다.
     */
    sellFills() {
      venue.onParams(BN_ORDER, 'POST', { reduceOnly: 'true' },
        { json: () => { amt = 0; return fill(7002, QTY, EXIT); } });
      return api;
    },
    /** 매수 체결 (reduce-only가 아닌 POST) */
    buyFills(q = QTY) {
      venue.on(BN_ORDER, { json: () => { amt = q; return fill(7001, q, ENTRY); } }, 'POST');
      return api;
    },
    /** 접수만 되고 체결되지 않는다 */
    buyAcksOnly() {
      venue.on(BN_ORDER, { json: {
        orderId: 7003, symbol: 'BTCUSDT', status: 'NEW',
        executedQty: '0', origQty: String(QTY), avgPrice: '0',
      } }, 'POST');
      return api;
    },
  };
  venue
    .on(BN_EXINFO, { json: { symbols: [{
      symbol: 'BTCUSDT', filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
      ],
    }] } })
    .on('/fapi/v1/marginType', { json: { code: 200, msg: 'success' } })
    .on(BN_DUAL, { json: { dualSidePosition: false } })
    .on(BN_LEV, { json: { leverage: 100, symbol: 'BTCUSDT' } })
    // 중복 확인(GET)은 "그런 주문 없음"
    .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET');
  return api;
}

/** 전송된 주문의 파라미터 (질의 문자열로 나간다) */
const sentParams = (v: FakeVenue) => v.orderSends().map((c) => c.params);

async function scenario<T>(venue: FakeVenue, body: () => Promise<T>): Promise<T | Error> {
  const restore = venue.install();
  const unenv = withCryptoEnv();
  try { return await body(); }
  catch (e: any) { return e instanceof Error ? e : new Error(String(e)); }
  finally { restore(); unenv(); }
}

const buy = (db: FakeDb, over: Record<string, any> = {}) => executeOrder(db as any, {
  userId: 'u1', connectionId: 'c1', signalId: 'sig-rt', clientOrderId: 'RT-1',
  exchange: 'binance', mode: 'TESTNET', plan: plan(),
  apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
  stopPolicy: 'NO_FIXED_SL', takeProfitPolicy: 'NO_FIXED_TP', protectionPolicy: 'NONE',
  ...over,
} as any);

export async function runBuySellRoundTripTests() {
  console.log('[통합 — 매수→체결→포지션→매도→잔여 0 왕복 (실제 경로)]');

  // ══════════ ① 완주 ══════════
  {
    const db = new FakeDb();
    const s = stage().wirePositions().sellFills().buyFills();
    const out = await scenario(s.venue, async () => {
      const bought = await buy(db);
      const afterBuy = await readOpenPosition(creds(), 'BTCUSDT');
      const prep = await prepareSymbolClose(creds(), 'BTCUSDT', 'LONG', (q) => `close-${q}`);
      const sent = prep.prepared ? await sendSymbolClose(creds(), prep.prepared) : null;
      const afterSell = await readOpenPosition(creds(), 'BTCUSDT');
      return { bought, afterBuy, prep, sent, afterSell };
    });

    test('★ ① 왕복이 끝까지 돈다 (던지지 않는다)', () => {
      assert(!(out instanceof Error), `왕복이 던졌다: ${(out as any)?.message}`);
    });

    const o = out as any;

    test('★ ① 매수가 거래소로 실제 전송된다', () => {
      const sends = s.venue.orderSends();
      assert(sends.length >= 1, '주문 전송이 0건이다 — 매수가 안 나갔다');
      eq(sends[0].params.side, 'BUY', `매수 방향이 아니다: ${JSON.stringify(sends[0].params)}`);
      assert(sends[0].params.reduceOnly !== 'true', '매수에 reduceOnly가 붙었다');
    });

    test('★ ① 체결이 장부에 FILLED로 적히고 수량·평균가가 증거에서 온다', () => {
      const row = db.table('live_orders').find((r: any) => r.client_order_id === 'RT-1');
      assert(row, '장부에 매수 줄이 없다');
      eq(row.status, 'FILLED', `체결인데 장부가 ${row.status}다`);
      eq(Number(row.filled_qty), QTY);
      eq(Number(row.avg_price), ENTRY);
    });

    test('★ ① 매수 뒤 포지션 조회가 그 수량을 보여 준다', () => {
      assert(o.afterBuy, '포지션 조회 결과가 없다');
      eq(Number(o.afterBuy.qty ?? o.afterBuy.quantity ?? 0), QTY,
        `조회된 수량이 다르다: ${JSON.stringify(o.afterBuy)}`);
    });

    test('★ ① 매도 준비가 READY이고 **관측한 수량**을 쓴다', () => {
      eq(o.prep.code, 'READY', `준비가 ${o.prep.code}다: ${o.prep.message}`);
      eq(o.prep.prepared.observedQty, QTY, '장부가 아니라 거래소 관측값을 써야 한다');
      eq(o.prep.prepared.quantity, QTY);
    });

    test('★★ ① 매도는 포지션의 반대 방향 + reduceOnly다', () => {
      eq(o.prep.prepared.orderSide, 'SELL', 'LONG을 닫는데 SELL이 아니다 — 반대 진입이 된다');
      eq(o.prep.prepared.reduceOnly, true);
    });

    test('★★ ① 매도 전송 본문에 reduceOnly=true가 실린다 (실측)', () => {
      const sends = s.venue.orderSends();
      assert(sends.length >= 2, `전송이 ${sends.length}건이다 — 매도가 안 나갔다`);
      const last = sends[sends.length - 1].params;
      eq(last.reduceOnly, 'true', `reduceOnly가 없다: ${JSON.stringify(last)}`);
      eq(last.side, 'SELL', `매도 방향이 아니다: ${JSON.stringify(last)}`);
    });

    test('★ ① 매도가 체결됐다고 거래소가 답한다', () => {
      assert(o.sent, '매도를 보내지 않았다');
      eq(o.sent.ok, true, `매도 실패: ${o.sent.error}`);
      eq(Number(o.sent.executedQty ?? 0), QTY);
    });

    test('★★★ ① 매도 뒤 포지션이 0이고 그것이 **거래소가 보여 준 0**이다', () => {
      eq(s.openQty(), 0, '거래소 쪽 수량이 아직 남아 있다');
      eq(Number(o.afterSell.qty ?? o.afterSell.quantity ?? 0), 0,
        `잔여가 0이 아니다: ${JSON.stringify(o.afterSell)}`);
      eq(o.afterSell.ok ?? true, true, '조회 실패를 0으로 읽으면 안 된다');
    });

    test('★ ① 전송은 매수 1 · 매도 1 — 그 이상 보내지 않는다', () => {
      eq(s.venue.orderSends().length, 2);
    });
  }

  // ══════════ ② ACK ≠ FILL ══════════
  {
    const db = new FakeDb();
    const s = stage().wirePositions().buyAcksOnly();
    await scenario(s.venue, () => buy(db, { clientOrderId: 'RT-ACK' }));

    test('★★ ② 접수(ACK)를 체결로 적지 않는다', () => {
      const row = db.table('live_orders').find((r: any) => r.client_order_id === 'RT-ACK');
      assert(row, '장부 줄이 없다');
      assert(row.status !== 'FILLED', `미체결인데 ${row.status}로 적혔다`);
      assert(!row.filled_qty, `체결 수량이 지어졌다: ${row.filled_qty}`);
      assert(row.avg_price == null, `미체결인데 평균가가 적혔다: ${row.avg_price}`);
    });

    test('★★ ② 체결되지 않았으므로 거래소 포지션도 0이다', () => {
      eq(s.openQty(), 0);
    });
  }

  // ══════════ ③ 조회 실패 ≠ 포지션 0 ══════════
  {
    const s = stage();
    s.venue.on('positionRisk', { status: 500, json: { code: -1001, msg: 'Internal error' } });
    const out = await scenario(s.venue, async () => ({
      read: await readOpenPosition(creds(), 'BTCUSDT'),
      prep: await prepareSymbolClose(creds(), 'BTCUSDT', 'LONG'),
    }));
    const o = out as any;

    test('★★★ ③ 포지션 조회가 실패하면 flat으로 읽지 않는다', () => {
      assert(!(out instanceof Error), `던졌다: ${(out as any)?.message}`);
      assert(o.read.ok !== true, '조회 실패인데 성공으로 읽었다');
      assert(o.prep.code !== 'ALREADY_FLAT',
        '조회 실패를 "이미 닫혔다"로 읽었다 — 열린 포지션이 방치된다');
      eq(o.prep.code, 'READ_FAILED');
    });

    test('★★ ③ 그 상태에서 주문을 보내지 않는다', () => {
      eq(s.venue.orderSends().length, 0, '모르는 상태에서 주문을 보냈다');
    });
  }

  // ══════════ ④ 부분 체결 ══════════
  {
    const db = new FakeDb();
    const half = 0.004;
    const s = stage().wirePositions().buyFills(half);
    const out = await scenario(s.venue, async () => {
      await buy(db, { clientOrderId: 'RT-PART' });
      return prepareSymbolClose(creds(), 'BTCUSDT', 'LONG');
    });

    test('★★ ④ 부분 체결을 요청 수량만큼 체결됐다고 적지 않는다', () => {
      const row = db.table('live_orders').find((r: any) => r.client_order_id === 'RT-PART');
      assert(row, '장부 줄이 없다');
      assert(Number(row.filled_qty ?? 0) !== QTY,
        `부분 체결인데 요청 수량(${QTY})이 적혔다`);
    });

    test('★★ ④ 매도는 **실제 남은 수량**으로 준비된다 (요청 수량이 아니다)', () => {
      const p = (out as any);
      eq(p.code, 'READY', `준비가 ${p.code}다`);
      eq(p.prepared.observedQty, half,
        '관측값이 아니라 다른 값을 썼다 — 남은 것보다 많이 팔면 반대 진입이다');
      eq(p.prepared.quantity, half);
    });
  }

  // ══════════ ⑤ 중복 실행 멱등성 ══════════
  {
    const db = new FakeDb();
    const s = stage().wirePositions().sellFills().buyFills();
    const out = await scenario(s.venue, async () => {
      await buy(db);
      const a = await prepareSymbolClose(creds(), 'BTCUSDT', 'LONG', (q) => `close-${q}`);
      const b = await prepareSymbolClose(creds(), 'BTCUSDT', 'LONG', (q) => `close-${q}`);
      return { a, b };
    });
    const o = out as any;

    test('★★ ⑤ 같은 노출을 본 두 실행자는 같은 멱등 키를 만든다', () => {
      eq(o.a.prepared.clientOrderId, o.b.prepared.clientOrderId,
        '키가 다르면 거래소가 중복을 알아볼 기회가 없다');
      assert(o.a.prepared.clientOrderId, '멱등 키가 비었다');
    });
  }

  // ══════════ ⑥ 이미 닫힌 뒤 ══════════
  {
    const s = stage().wirePositions();   // amt는 0인 채
    const out = await scenario(s.venue, () => prepareSymbolClose(creds(), 'BTCUSDT', 'LONG'));

    test('★ ⑥ 이미 flat이면 ALREADY_FLAT이고 주문을 보내지 않는다 (실패가 아니다)', () => {
      eq((out as any).code, 'ALREADY_FLAT');
      eq(s.venue.orderSends().length, 0);
    });
  }
}
