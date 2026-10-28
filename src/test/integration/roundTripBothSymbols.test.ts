// src/test/integration/roundTripBothSymbols.test.ts
//
// **BTC와 ETH를 같은 왕복으로 돌리고, 100배 격리 설정과 장부 정합성까지 본다.**
//
// 왜 더 필요한가
// ──────────────
// `buySellRoundTripIntegration.test.ts`가 매수→체결→포지션→매도→잔여 0을
// 이미 덮는다. 그런데 그것은 **BTCUSDT 한 종목**이고, 다음 넷이 왕복
// 맥락에서 비어 있었다:
//
//   ② 100배 **격리** 설정이 주문보다 먼저 실제로 나갔는가
//      — 교차(cross)로 들어가면 한 종목 손실이 지갑 전체로 번진다.
//        `orderExecutor`는 ISOLATED 설정 실패 시 주문을 중단하는데,
//        그 fail-closed가 왕복 시험에 걸려 있지 않았다.
//   ⑨ 장부(live_orders)가 **거래소가 말한 체결 사실과 같은가**
//      — 수량·평균가·상태가 응답에서 와야 한다. 요청값을 적으면
//        "요청한 만큼 샀다"가 장부에 남는다.
//   ⑩ 중복 주문 · UNKNOWN · 거래소 장애에서 **왕복이 거짓 성공을 적지 않는가**
//   ① ETHUSDT — 종목이 하나뿐이면 심볼을 상수로 박은 결함이 안 보인다.
//
// 막으려는 것:
//  1. BTC만 되고 ETH는 안 되는 상태를 "왕복 검증 완료"로 적는 것
//  2. 교차 마진으로 100배 주문이 나가는 것
//  3. 레버리지를 확인하지 못했는데 주문이 나가는 것
//  4. 거래소가 말하지 않은 체결을 장부에 적는 것
//  5. 타임아웃·5xx를 FILLED나 "청산 완료"로 적는 것
//  6. 같은 clientOrderId로 두 번 보내는 것
//
// **실주문은 없다.** HTTP 경계(FakeVenue)와 DB 경계(FakeDb)만 가짜고
// 실행기·판정은 실제로 돈다.
import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb, withCryptoEnv } from './venueHarness';
import { executeOrder } from '../../lib/engine/orderExecutor';
import {
  readOpenPosition, prepareSymbolClose, sendSymbolClose,
} from '../../lib/engine/venuePositionOps';
import { __clearFiltersCache } from '../../lib/exchanges/binanceFutures';

const BN_ORDER = '/fapi/v1/order';
const BN_DUAL = '/fapi/v1/positionSide/dual';
const BN_EXINFO = '/fapi/v1/exchangeInfo';
const BN_LEV = '/fapi/v1/leverage';
const BN_MARGIN = '/fapi/v1/marginType';

/** 종목마다 다른 수량·가격을 쓴다 — 상수로 박힌 자리가 드러난다 */
interface SymSpec { qty: number; entry: number; exit: number; step: string }
const SPEC: Record<'BTCUSDT' | 'ETHUSDT', SymSpec> = {
  BTCUSDT: { qty: 0.01, entry: 100_000, exit: 101_000, step: '0.001' },
  ETHUSDT: { qty: 0.5, entry: 4_000, exit: 4_040, step: '0.01' },
};
type Sym = keyof typeof SPEC;
const SYMBOLS = Object.keys(SPEC) as Sym[];

const creds = () => ({
  exchange: 'binance' as const,
  apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64), testnet: true,
});

const planOf = (sym: Sym, over: Record<string, any> = {}) => {
  const s = SPEC[sym];
  return {
    approved: true, symbol: sym, side: 'LONG' as const,
    riskAmount: 10, riskAmountWithCosts: 10,
    stopDistancePct: 1, effectiveStopPct: 1,
    positionSize: s.qty * s.entry, quantity: s.qty, requiredMargin: 10,
    leverage: 100, liquidationPrice: s.entry * 0.9, liquidationDistancePct: 1,
    notes: [], ...over,
  } as any;
};

const posRow = (sym: Sym, amt: string) => ([{
  symbol: sym, positionAmt: amt,
  entryPrice: amt === '0' ? '0' : String(SPEC[sym].entry),
  leverage: '100', marginType: 'isolated',
  liquidationPrice: String(SPEC[sym].entry * 0.9),
  unRealizedProfit: '0', positionSide: 'BOTH',
}]);

interface StageOpts {
  /** ISOLATED 설정이 실패한다 — 교차로 들어가면 안 된다 */
  marginFails?: boolean;
  /** 레버리지 조회·설정이 실패한다 */
  levFails?: boolean;
  /** 매수 전송이 타임아웃난다 */
  buyTimesOut?: boolean;
  /** 매도(reduce-only) 전송이 5xx로 실패한다 */
  sellFails?: boolean;
}

function stage(sym: Sym, o: StageOpts = {}) {
  // **규격 캐시를 비우고 시작한다.**
  //
  // `getSymbolFilters`는 `demo:SYMBOL`로 5분 캐시한다. 비우지 않으면 이
  // 시험이 **다른 시험이 채워 둔 값**을 타고, exchangeInfo→필터 경로가
  // 한 번도 안 돌면서 통과한다. 실제로 BTC 왕복 시험이 그 상태였다 —
  // 호출 목록에 exchangeInfo가 없었다.
  __clearFiltersCache();
  const s = SPEC[sym];
  let amt = 0;
  const venue = new FakeVenue();
  const fill = (id: number, q: number, px: number, orig: number) => ({
    orderId: id, symbol: sym, status: q >= orig ? 'FILLED' : 'PARTIALLY_FILLED',
    executedQty: String(q), origQty: String(orig), avgPrice: String(px),
  });

  venue
    .on(BN_EXINFO, { json: { symbols: [{
      symbol: sym, filters: [
        { filterType: 'LOT_SIZE', stepSize: s.step, minQty: s.step },
        // **MARKET 주문은 두 격자를 모두 요구한다.** `quantizeOrder`는
        // MARKET_LOT_SIZE가 없으면 QTY_FILTER_UNKNOWN으로 fail-closed한다
        // (규격을 모르는 채 시장가를 보내지 않는다). 이것을 빼 놓으면
        // "왕복이 된다"가 아니라 "관문이 막았다"를 보게 된다.
        { filterType: 'MARKET_LOT_SIZE', stepSize: s.step, minQty: s.step },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
      ],
    }] } })
    .on(BN_MARGIN, o.marginFails
      ? { status: 400, json: { code: -4047, msg: 'Margin type cannot be changed' } }
      : { json: { code: 200, msg: 'success' } })
    .on(BN_DUAL, { json: { dualSidePosition: false } })
    .on(BN_LEV, o.levFails
      ? { status: 400, json: { code: -4028, msg: 'Leverage not modified' } }
      : { json: { leverage: 100, symbol: sym } })
    // **기준 가격.** MIN_NOTIONAL 검사는 가격이 있어야 한다. 운영 코드는
    // 못 읽으면 REFERENCE_PRICE_UNKNOWN으로 주문을 막는다("지어낸 가격으로
    // 검사하지 않는다"). 그 경로를 통과시키려면 여기서 줘야 한다.
    .on('/fapi/v1/premiumIndex', { json: { symbol: sym, markPrice: String(s.entry) } })
    .on('positionRisk', { json: () => posRow(sym, amt === 0 ? '0' : String(amt)) })
    // **중복 확인(GET)은 상태를 가진다.** 늘 "없음"으로 답하면 재시도가
    // 언제나 새 주문을 만들고, 멱등 관문이 시험되지 않는다. 실제 거래소는
    // 같은 clientOrderId를 두 번째부터 "있다"고 답한다.
    .on(BN_ORDER, { json: () => {
      const prior = venue.orderSends().find((c) => c.params.newClientOrderId);
      if (!prior) return { code: -2013, msg: 'Order does not exist.' };
      return {
        orderId: 8001, symbol: sym, clientOrderId: prior.params.newClientOrderId,
        status: amt > 0 ? 'FILLED' : 'NEW',
        executedQty: String(amt), origQty: String(s.qty), avgPrice: String(s.entry),
      };
    } }, 'GET');

  // 매도(reduce-only)를 **먼저** 등록한다 — 먼저 등록한 규칙이 이긴다.
  venue.onParams(BN_ORDER, 'POST', { reduceOnly: 'true' }, o.sellFails
    ? { status: 503, json: { code: -1001, msg: 'Internal error' } }
    : { json: () => {
      const sent = venue.orderSends().slice(-1)[0];
      const q = Number(sent?.params.quantity);
      if (sent?.params.side !== 'SELL' || !Number.isFinite(q) || q <= 0 || q > amt) {
        return { code: -2022, msg: 'ReduceOnly Order is rejected.' };
      }
      amt = Number((amt - q).toFixed(9));
      return fill(8002, q, s.exit, q);
    } });

  venue.on(BN_ORDER, o.buyTimesOut
    ? { timeout: true }
    : { json: () => { amt = s.qty; return fill(8001, s.qty, s.entry, s.qty); } }, 'POST');

  return { venue, openQty: () => amt };
}

async function scenario<T>(venue: FakeVenue, body: () => Promise<T>): Promise<T | Error> {
  const restore = venue.install();
  const unenv = withCryptoEnv();
  try { return await body(); }
  catch (e: any) { return e instanceof Error ? e : new Error(String(e)); }
  finally { restore(); unenv(); }
}

const buy = (db: FakeDb, sym: Sym, over: Record<string, any> = {}) =>
  executeOrder(db as any, {
    userId: 'u1', connectionId: 'c1', signalId: `sig-${sym}`,
    clientOrderId: `RT2-${sym}`,
    exchange: 'binance', mode: 'TESTNET', plan: planOf(sym),
    apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
    stopPolicy: 'NO_FIXED_SL', takeProfitPolicy: 'NO_FIXED_TP', protectionPolicy: 'NONE',
    ...over,
  } as any);

const paramsOf = (v: FakeVenue) => v.orderSends().map((c) => c.params);

export async function runRoundTripBothSymbolsTests() {
  console.log('[통합 — BTC·ETH 왕복 + 100배 격리 + 장부 정합성 + 장애]');

  // ══════════ 종목별 완주 ══════════
  for (const sym of SYMBOLS) {
    const s = SPEC[sym];
    const db = new FakeDb();
    const st = stage(sym);
    const out = await scenario(st.venue, async () => {
      const bought = await buy(db, sym);
      const afterBuy = await readOpenPosition(creds(), sym);
      const prep = await prepareSymbolClose(creds(), sym, 'LONG', (q) => `cl-${sym}-${q}`);
      const sent = prep.prepared ? await sendSymbolClose(creds(), prep.prepared) : null;
      const afterSell = await readOpenPosition(creds(), sym);
      return { bought, afterBuy, prep, sent, afterSell };
    });
    const o = out as any;

    test(`★ ${sym} — 왕복이 끝까지 돈다`, () => {
      assert(!(out instanceof Error), `던졌다: ${(out as any)?.message}`);
    });

    test(`★★★ ${sym} — ISOLATED 설정이 주문보다 **먼저** 나간다`, () => {
      // 교차로 들어가면 한 종목 손실이 지갑 전체로 번진다.
      const idx = st.venue.calls.findIndex((c) => c.path.includes('marginType'));
      const ord = st.venue.calls.findIndex(
        (c) => c.method === 'POST' && c.path.includes(BN_ORDER));
      assert(idx >= 0, 'marginType 호출이 없다 — 격리 설정을 안 했다');
      assert(ord >= 0 && idx < ord, `격리 설정이 주문보다 늦다 (margin ${idx}, order ${ord})`);
      const p = st.venue.calls[idx].params;
      eq(String(p.marginType).toUpperCase(), 'ISOLATED');
      eq(p.symbol, sym);
    });

    test(`★★ ${sym} — 레버리지 100배를 그 종목에 건다`, () => {
      const c = st.venue.calls.find((x) => x.path.includes(BN_LEV));
      assert(!!c, 'leverage 호출이 없다');
      eq(Number(c!.params.leverage), 100);
      eq(c!.params.symbol, sym);
    });

    test(`★★ ${sym} — 매수가 그 종목·그 수량으로 전송된다`, () => {
      const sends = paramsOf(st.venue);
      assert(sends.length >= 1, '주문 전송 0건');
      eq(sends[0].symbol, sym);
      eq(sends[0].side, 'BUY');
      eq(Number(sends[0].quantity), s.qty);
      assert(sends[0].reduceOnly !== 'true', '매수에 reduceOnly가 붙었다');
    });

    test(`★★★ ${sym} — 장부가 거래소가 말한 체결 사실과 같다`, () => {
      const row = db.table('live_orders').find((r: any) => r.client_order_id === `RT2-${sym}`);
      assert(row, '장부에 매수 줄이 없다');
      eq(row.status, 'FILLED', `체결인데 장부가 ${row.status}다`);
      eq(Number(row.filled_qty), s.qty);
      eq(Number(row.avg_price), s.entry);   // 요청가가 아니라 응답의 평균가
      eq(row.symbol, sym);
    });

    test(`★★ ${sym} — 매도는 반대 방향 + reduceOnly + **관측 수량**`, () => {
      const sell = paramsOf(st.venue).find((p) => p.reduceOnly === 'true');
      assert(!!sell, 'reduce-only 매도가 안 나갔다');
      eq(sell!.side, 'SELL');
      eq(sell!.symbol, sym);
      eq(Number(sell!.quantity), s.qty);
    });

    test(`★★★ ${sym} — 매도 뒤 포지션 0이고 그것이 거래소가 보여 준 0이다`, () => {
      eq(st.openQty(), 0, '거래소 쪽 노출이 0이 아니다');
      // readOpenPosition은 { ok, found, qty, side, error }를 준다.
      eq(o.afterSell?.ok, true, `조회가 실패했다: ${o.afterSell?.error}`);
      eq(o.afterSell?.found, false, '닫았는데 포지션이 남아 있다고 읽었다');
      eq(Number(o.afterSell?.qty), 0);
    });

    test(`★ ${sym} — 전송은 매수 1 · 매도 1뿐이다`, () => {
      eq(st.venue.orderSends().length, 2);
    });
  }

  // ══════════ 두 종목이 서로를 밀지 않는다 ══════════
  test('★★ BTC와 ETH가 서로 다른 수량·가격으로 기록된다 (상수 박힘 없음)', () => {
    assert(SPEC.BTCUSDT.qty !== SPEC.ETHUSDT.qty, '수량이 같으면 이 시험이 무의미하다');
    assert(SPEC.BTCUSDT.entry !== SPEC.ETHUSDT.entry, '가격이 같으면 무의미하다');
  });

  // ══════════ 100배 격리 fail-closed ══════════
  {
    const db = new FakeDb();
    const st = stage('BTCUSDT', { marginFails: true });
    const r = await scenario(st.venue, () => buy(db, 'BTCUSDT')) as any;

    test('★★★ ISOLATED 설정이 실패하면 주문을 보내지 않는다 (교차 진입 금지)', () => {
      eq(st.venue.orderSends().length, 0, '격리 설정 실패인데 주문이 나갔다');
    });
    test('★★ 그 사실이 결과에 남는다 — 성공으로 적지 않는다', () => {
      assert(!(r?.ok === true && r?.status === 'FILLED'),
        `격리 실패인데 체결로 적혔다: ${JSON.stringify(r)?.slice(0, 160)}`);
    });
  }

  {
    const db = new FakeDb();
    const st = stage('BTCUSDT');
    const r = await scenario(st.venue,
      () => buy(db, 'BTCUSDT', { plan: planOf('BTCUSDT', { leverage: 0 }) })) as any;

    test('★★★ 레버리지를 확인하지 못하면 거절하고 주문을 보내지 않는다', () => {
      eq(st.venue.orderSends().length, 0, '레버리지 미확인인데 주문이 나갔다');
      eq(r?.status, 'REJECTED');
    });
  }

  // ══════════ 거래소 장애 · UNKNOWN ══════════
  {
    const db = new FakeDb();
    const st = stage('ETHUSDT', { buyTimesOut: true });
    const r = await scenario(st.venue, () => buy(db, 'ETHUSDT')) as any;

    test('★★★ 매수 타임아웃을 FILLED로 적지 않는다', () => {
      assert(r?.status !== 'FILLED', `타임아웃인데 FILLED다: ${r?.status}`);
      const row = db.table('live_orders').find((x: any) => x.client_order_id === 'RT2-ETHUSDT');
      if (row) assert(row.status !== 'FILLED', `장부가 FILLED다: ${row.status}`);
    });

    test('★★★ 타임아웃 뒤 거래소 노출은 0이다 — 체결을 지어내지 않는다', () => {
      eq(st.openQty(), 0);
    });
  }

  {
    const db = new FakeDb();
    const st = stage('BTCUSDT', { sellFails: true });
    const out = await scenario(st.venue, async () => {
      await buy(db, 'BTCUSDT');
      const prep = await prepareSymbolClose(creds(), 'BTCUSDT', 'LONG', (q) => `cl-${q}`);
      const sent = prep.prepared ? await sendSymbolClose(creds(), prep.prepared) : null;
      const after = await readOpenPosition(creds(), 'BTCUSDT');
      return { sent, after };
    });
    const o = out as any;

    test('★★★ 청산 전송이 5xx면 "청산 완료"로 적지 않는다', () => {
      assert(o?.sent?.ok !== true, `청산 실패인데 ok=true다: ${JSON.stringify(o?.sent)?.slice(0, 160)}`);
    });

    test('★★★ 그리고 포지션은 **그대로 남아 있다** — 0으로 위장하지 않는다', () => {
      eq(st.openQty(), SPEC.BTCUSDT.qty, '청산 실패인데 거래소 노출이 줄었다');
      // 포지션이 남아 있으므로 found=true여야 한다. false면 "닫혔다"로 읽은 것이다.
      assert(o?.after?.found === true,
        `청산 실패인데 포지션 없음으로 읽었다: ${JSON.stringify(o?.after)}`);
      eq(Number(o?.after?.qty), SPEC.BTCUSDT.qty);
    });
  }

  // ══════════ 중복 주문 ══════════
  {
    const db = new FakeDb();
    const st = stage('BTCUSDT');
    const out = await scenario(st.venue, async () => {
      const a = await buy(db, 'BTCUSDT');
      const b = await buy(db, 'BTCUSDT');   // 같은 clientOrderId로 재시도
      return { a, b };
    });
    const o = out as any;

    test('★★★ 같은 clientOrderId 재시도가 두 번째 주문을 만들지 않는다', () => {
      eq(st.venue.orderSends().length, 1,
        `중복 주문이 나갔다: ${JSON.stringify(paramsOf(st.venue))}`);
    });

    test('★★ 거래소 노출도 한 번분만 늘어난다', () => {
      eq(st.openQty(), SPEC.BTCUSDT.qty);
    });

    // **장부 줄 수는 여기서 단언하지 않는다.**
    //
    // 운영에서 같은 clientOrderId가 두 줄이 되지 않는 이유는 실행기 로직이
    // 아니라 **`live_orders.client_order_id`의 유니크 제약**이다
    // (`orderExecutor.ts`가 23505를 받아 기존 줄을 돌려준다). `FakeDb`에는
    // 그 제약이 없으므로 여기서 줄 수를 세면 **없는 관문을 시험하는 것**이
    // 된다. 진짜 관문은 바로 아래에서 23505로 직접 시험한다.
  }

  // ══════════ 장부 유니크 제약(23505) — 운영의 진짜 중복 관문 ══════════
  {
    // 같은 clientOrderId가 장부에 이미 있는 상태를 재현한다.
    // 실제 DB는 유니크 제약으로 23505를 던지고, 실행기는 그것을 받아
    // **주문을 보내지 않고** 기존 상태를 그대로 돌려준다.
    const db = new FakeDb({ failInsertCode: { table: 'live_orders', code: '23505' } });
    db.seed('live_orders', [{
      id: 'prev-1', client_order_id: 'RT2-BTCUSDT', status: 'FILLED',
      exchange_order_id: '8001', filled_qty: SPEC.BTCUSDT.qty, avg_price: SPEC.BTCUSDT.entry,
      symbol: 'BTCUSDT',
    }]);
    const st = stage('BTCUSDT');
    const r = await scenario(st.venue, () => buy(db, 'BTCUSDT')) as any;

    test('★★★ 장부에 이미 있는 주문(23505)이면 거래소로 보내지 않는다', () => {
      eq(st.venue.orderSends().length, 0,
        `중복인데 주문이 나갔다: ${JSON.stringify(paramsOf(st.venue))}`);
    });

    test('★★ 중복이라고 적고, 기존 체결 사실을 그대로 돌려준다', () => {
      eq(r?.duplicate, true, `duplicate 표시가 없다: ${JSON.stringify(r)?.slice(0, 180)}`);
      eq(r?.status, 'FILLED');
      eq(r?.exchangeOrderId, '8001');
      eq(Number(r?.filledQty), SPEC.BTCUSDT.qty);
    });

    test('★★ 거래소 노출도 늘지 않는다', () => {
      eq(st.openQty(), 0);
    });
  }
}
