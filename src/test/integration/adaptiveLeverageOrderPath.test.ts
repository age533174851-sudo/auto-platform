// src/test/integration/adaptiveLeverageOrderPath.test.ts
//
// **10~75배가 실제 주문 경로를 통과하는가 — 그리고 100배는 못 가는가.**
//
// `adaptiveLeverage.test.ts`는 판정만 본다. 이 파일은 그 판정이 낸 값으로
// **진짜 `executeOrder`를 돌려** 거래소에 무엇이 나갔는지를 센다. 가짜는
// `fetch`와 DB뿐이다.
//
// 왜 둘 다 필요한가
// ─────────────────
// 판정이 20배를 냈는데 거래소에 100배가 걸리는 고장은 판정 시험으로
// 잡히지 않는다. 그 고장은 **배선**에 있고, 배선은 나간 요청의
// 파라미터로만 확인된다.
//
// 종목이 둘인 이유
// ────────────────
// 수량 격자(`stepSize`)와 가격 단위가 종목마다 다르다. BTC 하나로만
// 보면 "0.001 격자에서만 맞는 반올림"이 통과한다. ETH는 같은 코드가
// 다른 격자에서도 맞는지 묻는다.
import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb, withCryptoEnv, type VenueCall } from './venueHarness';
import { executeOrder, reconcilePendingOrders } from '../../lib/engine/orderExecutor';
import { readOpenPosition, prepareSymbolClose, sendSymbolClose } from '../../lib/engine/venuePositionOps';
import { __clearFiltersCache } from '../../lib/exchanges/binanceFutures';
import {
  planAdaptiveEntry, type AdaptiveEntryInput,
} from '../../lib/engine/adaptiveEntry';
import { ADAPTIVE_LADDER, FORBIDDEN_LEVERAGE } from '../../lib/engine/adaptiveLeverage';

const BN_ORDER = '/fapi/v1/order';
const BN_POS = '/fapi/v2/positionRisk';
const BN_LEV = '/fapi/v1/leverage';
const BN_DUAL = '/fapi/v1/positionSide/dual';
const BN_EXINFO = '/fapi/v1/exchangeInfo';
const BN_MARGIN = '/fapi/v1/marginType';
const BN_MARK = '/fapi/v1/premiumIndex';

const NOW = 1_800_000_000_000;

interface SymSpec { price: number; step: string; tick: string }
const SPEC: Record<'BTCUSDT' | 'ETHUSDT', SymSpec> = {
  BTCUSDT: { price: 100_000, step: '0.001', tick: '0.10' },
  ETHUSDT: { price: 4_000, step: '0.01', tick: '0.01' },
};

/** 모든 축이 넉넉한 위험 입력. 배율은 `requestedLeverage`로 내려 고른다 */
function risk(over: Partial<AdaptiveEntryInput['risk']> = {}): AdaptiveEntryInput['risk'] {
  return {
    nowMs: NOW,
    atrPct: 0.2,
    volatilityAsOfMs: NOW - 60_000,
    depthUsd: 5_000_000_000,
    bookAsOfMs: NOW - 1_000,
    spreadBps: 0,
    roundTripFeeBps: 1,
    maintenanceMarginRate: 0.004,
    exchangeMaxLeverage: 75,
    exchangeMaxAsOfMs: NOW - 60_000,
    highRiskApproved: true,
    ...over,
  };
}

function entryFor(sym: keyof typeof SPEC, leverage: number | null, over: Partial<AdaptiveEntryInput> = {}) {
  return planAdaptiveEntry({
    risk: risk(),
    availableUsd: 1_000,
    marginAllocationPct: 10,          // 증거금 100 USD
    referencePrice: SPEC[sym].price,
    requestedLeverage: leverage,
    ...over,
  });
}

const posRow = (sym: string, amt: string, lev: string) => ([{
  symbol: sym, positionAmt: amt, entryPrice: amt === '0' ? '0' : String(SPEC[sym as keyof typeof SPEC].price),
  leverage: lev, marginType: 'isolated', liquidationPrice: '0',
}]);

interface StageOpts {
  /** 거래소가 되읽어 주는 배율. 요청과 다르면 실행기가 막아야 한다 */
  readBackLeverage?: number;
  /** ISOLATED 설정을 실패시킨다 */
  isolatedFails?: boolean;
  /** 지금 열려 있는 포지션 수량 (문자열). 기본 0 */
  positionAmt?: () => string;
  /** 진입 주문 응답 */
  entryReply?: any;
  /** 진입 주문에서 타임아웃을 낸다 */
  entryTimeout?: boolean;
  /**
   * 주문 조회(GET)의 응답.
   *
   * FakeVenue는 **먼저 등록된 규칙이 이긴다.** 그래서 조회 응답을 바꾸려면
   * 기본 규칙을 나중에 덮는 것이 아니라 **여기서 대신 깔아야** 한다.
   * 나중에 덮는 줄을 쓰면 조용히 무시되고, 시험은 엉뚱한 이유로 실패한다.
   */
  orderGet?: any;
}

function stage(sym: keyof typeof SPEC, leverage: number, o: StageOpts = {}) {
  // 앞 시나리오가 캐시에 남긴 규격을 쓰면 "규격을 안 읽어도 통과"가 된다.
  __clearFiltersCache();
  const s = SPEC[sym];
  const amt = o.positionAmt ?? (() => '0');
  const v = new FakeVenue()
    .on(BN_EXINFO, { json: { symbols: [{ symbol: sym, filters: [
      { filterType: 'LOT_SIZE', stepSize: s.step, minQty: s.step },
      { filterType: 'MARKET_LOT_SIZE', stepSize: s.step, minQty: s.step },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PRICE_FILTER', tickSize: s.tick },
    ] }] } })
    .on(BN_MARK, { json: { symbol: sym, markPrice: String(s.price) } })
    .on(BN_MARGIN, o.isolatedFails
      ? { status: 400, json: { code: -4000, msg: 'margin type change failed' } }
      : { json: { code: 200, msg: 'success' } })
    .on(BN_LEV, { json: { leverage: o.readBackLeverage ?? leverage, symbol: sym } })
    .on(BN_DUAL, { json: { dualSidePosition: false } })
    .on('/fapi/v1/account', { json: { positions: [], assets: [] } })
    .on(BN_POS, { json: () => posRow(sym, amt(), String(o.readBackLeverage ?? leverage)) });

  // 중복 확인(GET)과 전송(POST)을 **메서드로 가른다.** 안 가르면 중복
  // 확인에도 "주문 있음"이 돌아가고 실행기는 올바르게 전송을 생략한다 —
  // 그러면 "주문이 나갔다"를 보는 시험이 0건으로 초록이 된다.
  v.on(BN_ORDER, o.orderGet
    ? { json: o.orderGet }
    : { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET');
  if (o.entryTimeout) {
    v.on(BN_ORDER, { timeout: true }, 'POST');
  } else {
    v.on(BN_ORDER, { json: o.entryReply ?? {
      orderId: 9100, symbol: sym, status: 'FILLED',
      executedQty: '0', origQty: '0', avgPrice: String(s.price), price: '0',
    } }, 'POST');
  }
  return v;
}

const creds = (exchange: 'binance' = 'binance') => ({
  exchange, apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64), testnet: true,
});

async function scenario<T>(venue: FakeVenue, body: () => Promise<T>): Promise<T | Error> {
  const restore = venue.install();
  const unenv = withCryptoEnv();
  try { return await body(); }
  catch (e: any) { return e instanceof Error ? e : new Error(String(e)); }
  finally { restore(); unenv(); }
}

/** 적응형 계획을 그대로 실행기에 넘긴다. **배율·수량을 여기서 다시 만들지 않는다** */
async function sendEntry(db: FakeDb, sym: keyof typeof SPEC, p: any, over: any = {}) {
  return executeOrder(db as any, {
    userId: 'u1', connectionId: 'c1', signalId: 'sig-1',
    clientOrderId: over.clientOrderId ?? `ADAPT-${sym}-${p.leverage}`,
    exchange: 'binance', mode: 'TESTNET',
    apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
    stopPolicy: 'NO_FIXED_SL', takeProfitPolicy: 'NO_FIXED_TP', protectionPolicy: 'NONE',
    plan: {
      approved: true, symbol: sym, side: 'LONG',
      riskAmount: p.allocatedMargin, riskAmountWithCosts: p.allocatedMargin,
      stopDistancePct: 1, effectiveStopPct: 1,
      positionSize: p.targetNotional, quantity: p.quantity,
      requiredMargin: p.allocatedMargin, leverage: p.leverage,
      liquidationPrice: p.liquidationPrice.long, liquidationDistancePct: 1,
      notes: [],
    },
    ...over,
  } as any);
}

const paramOf = (c: VenueCall | undefined, k: string) => String(c?.params?.[k] ?? '');

export async function runAdaptiveLeverageOrderPathTests() {
  console.log('[통합 — 적응형 10~75배가 실제 주문 경로를 지난다]');

  // ══════════ ① 사다리 전 칸 × 두 종목 ══════════
  for (const sym of ['BTCUSDT', 'ETHUSDT'] as const) {
    for (const lev of ADAPTIVE_LADDER) {
      const p = entryFor(sym, lev);
      const db = new FakeDb();
      const venue = stage(sym, lev);
      const r = await scenario(venue, () => sendEntry(db, sym, p));

      test(`★★ ${sym} ${lev}배 — 계획이 그 배율과 수량을 낸다`, () => {
        eq(p.ok, true, p.message);
        eq(p.leverage, lev, `${lev}배를 요구했는데 ${p.leverage}배가 나왔다`);
        // 증거금 100 USD × 배율 ÷ 기준가
        const want = (100 * lev) / SPEC[sym].price;
        assert(Math.abs(p.quantity! - want) <= Number(SPEC[sym].step),
          `수량이 ${p.quantity}인데 기대는 ${want} 부근이다`);
      });

      test(`★★ ${sym} ${lev}배 — ISOLATED가 주문보다 먼저 나간다`, () => {
        assert(!(r instanceof Error), String((r as any)?.message));
        const iso = venue.calls.findIndex(c => c.path.includes(BN_MARGIN));
        const ord = venue.calls.findIndex(c => c.method === 'POST' && c.path.includes(BN_ORDER));
        assert(iso >= 0, 'ISOLATED 설정을 안 보냈다');
        assert(ord >= 0, '주문을 안 보냈다');
        assert(iso < ord, `주문(${ord})이 ISOLATED(${iso})보다 먼저 나갔다`);
      });

      test(`★★ ${sym} ${lev}배 — 거래소에 건 배율이 정확히 ${lev}이고 100이 아니다`, () => {
        const levCall = venue.calls.find(c => c.path.includes(BN_LEV) && c.method === 'POST')
          ?? venue.calls.find(c => c.path.includes(BN_LEV));
        assert(!!levCall, '배율 설정을 안 보냈다');
        eq(paramOf(levCall, 'leverage'), String(lev),
          `요청 배율이 ${paramOf(levCall, 'leverage')}다`);
        assert(paramOf(levCall, 'leverage') !== String(FORBIDDEN_LEVERAGE),
          '이 정책으로 100배가 나갔다');
      });

      test(`★★ ${sym} ${lev}배 — 보낸 수량이 계획과 같다`, () => {
        const sent = venue.orderSends()[0];
        assert(!!sent, '주문이 나가지 않았다');
        eq(paramOf(sent, 'symbol'), sym);
        eq(paramOf(sent, 'side'), 'BUY');
        const q = Number(paramOf(sent, 'quantity'));
        assert(Math.abs(q - p.quantity!) <= Number(SPEC[sym].step) + 1e-9,
          `보낸 수량 ${q}가 계획 ${p.quantity}와 다르다`);
      });
    }
  }

  // ══════════ ② 100배는 주문을 만들기 전에 끝난다 ══════════
  {
    const venue = stage('BTCUSDT', 50);
    const p = entryFor('BTCUSDT', FORBIDDEN_LEVERAGE);

    test('★★ 100배 요구는 계획 단계에서 거부된다', () => {
      eq(p.ok, false, '100배 계획이 만들어졌다');
      eq(p.code, 'HUNDRED_X_FORBIDDEN');
      eq(p.leverage, null, '막혔는데 배율이 적혔다');
    });

    test('★★ 100배 요구에서는 거래소 호출이 0건이다', () => {
      // 계획이 막혔으므로 실행기를 부를 일 자체가 없다. "주문만 0건"이
      // 아니라 **배율 설정·마진 설정도 0건**이어야 한다 — 거부된 회차가
      // 계좌 설정을 바꿔 놓으면 다음 회차가 그 설정으로 돈다.
      eq(venue.calls.length, 0, `거래소를 ${venue.calls.length}번 불렀다`);
    });

    test('★★ 100배는 75로 조용히 낮춰지지 않는다', () => {
      assert(p.leverage !== 75, '100 요구가 75로 바뀌었다 — 호출자는 100이 된 줄 안다');
      assert(/100/.test(p.message), `사유에 요구값이 없다: ${p.message}`);
    });
  }

  // ══════════ ③ 위험 데이터가 없으면 주문이 없다 ══════════
  for (const [label, over] of [
    ['변동성 없음', { atrPct: null }],
    ['호가가 1분 전', { bookAsOfMs: NOW - 60_000 }],
    ['거래소 상한 모름', { exchangeMaxLeverage: null }],
  ] as Array<[string, any]>) {
    const venue = stage('BTCUSDT', 20);
    const p = planAdaptiveEntry({
      risk: risk(over), availableUsd: 1_000, marginAllocationPct: 10,
      referencePrice: SPEC.BTCUSDT.price,
    });
    test(`★★ ${label} → 계획 차단 · 거래소 호출 0건`, () => {
      eq(p.ok, false, `${label}인데 계획이 나왔다`);
      eq(p.code, 'LEVERAGE_BLOCKED');
      eq(venue.calls.length, 0);
    });
  }

  // ══════════ ④ 레버리지 설정이 확정되지 않으면 주문 0건 ══════════
  {
    const p = entryFor('BTCUSDT', 50);
    const db = new FakeDb();
    // 50을 요청했는데 거래소가 20으로 잡았다. 위험이 줄어드는 방향이지만
    // **사용자가 고른 전략이 아니다** — 수량은 50배로 만들어졌다.
    const venue = stage('BTCUSDT', 50, { readBackLeverage: 20 });
    const r = await scenario(venue, () => sendEntry(db, 'BTCUSDT', p));

    test('★★ 거래소가 다른 배율로 잡으면 주문을 보내지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0,
        '배율이 확정되지 않았는데 주문이 나갔다 — 수량은 50배 기준이다');
      eq((r as any).ok, false);
      assert(/배율/.test(String((r as any).message ?? '')), (r as any).message);
    });
  }

  // ══════════ ⑤ ISOLATED 설정 실패 → 주문 0건 ══════════
  {
    const p = entryFor('ETHUSDT', 30);
    const db = new FakeDb();
    const venue = stage('ETHUSDT', 30, { isolatedFails: true });
    const r = await scenario(venue, () => sendEntry(db, 'ETHUSDT', p));

    test('★★ ISOLATED 설정이 실패하면 주문 0건 (cross로 새지 않는다)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0, 'cross일 수 있는 계좌에 100배급 주문이 나갔다');
      eq((r as any).status, 'FAILED');
    });
  }

  // ══════════ ⑥ 매수 → 체결 → reduce-only 청산 → 잔여 0 ══════════
  for (const sym of ['BTCUSDT', 'ETHUSDT'] as const) {
    const lev = 30;
    const p = entryFor(sym, lev);
    const qty = p.quantity!;
    const shown = qty.toFixed(sym === 'BTCUSDT' ? 3 : 2);
    let amt = '0';
    const db = new FakeDb();
    const venue = stage(sym, lev, {
      positionAmt: () => amt,
      entryReply: {
        orderId: 9200, symbol: sym, status: 'FILLED',
        executedQty: shown, origQty: shown, avgPrice: String(SPEC[sym].price),
      },
    });

    const out = await scenario(venue, async () => {
      const entry = await sendEntry(db, sym, p);
      amt = shown;                                   // 거래소에 포지션이 생겼다
      const open = await readOpenPosition(creds(), sym);
      const prep = await prepareSymbolClose(creds(), sym, 'LONG');
      const sent = prep.code === 'READY' && prep.prepared
        ? await sendSymbolClose(creds(), prep.prepared) : null;
      amt = '0';                                     // 청산이 체결됐다
      const after = await readOpenPosition(creds(), sym);
      return { entry, open, prep, sent, after };
    });

    test(`★★ ${sym} — 매수가 체결로 확정되고 노출이 관측된다`, () => {
      assert(!(out instanceof Error), String((out as any)?.message));
      const o: any = out;
      // `executeOrder`는 전송이 성공하면 **접수(ACKED)**를 돌려준다.
      // 체결 사실은 거래소 응답에서 뽑아 **장부에** 적힌다 — 그 둘을
      // 같은 칸으로 읽으면 "접수를 체결로" 세는 바로 그 고장이 된다.
      eq(o.entry.ok, true, `진입 전송이 실패했다: ${o.entry.message}`);
      const row = db.table('live_orders')[0];
      assert(row, '장부 줄이 없다');
      eq(row.status, 'FILLED', `거래소가 FILLED를 줬는데 장부가 ${row.status}다`);
      assert(Math.abs(Number(row.filled_qty) - Number(shown)) < 1e-9,
        `장부 체결 수량 ${row.filled_qty} ≠ 응답 ${shown}`);
      eq(o.open.found, true, '열린 포지션을 못 읽었다');
      assert(Math.abs(Number(o.open.qty) - Number(shown)) < 1e-9,
        `관측 수량 ${o.open.qty} ≠ 체결 ${shown}`);
    });

    test(`★★ ${sym} — 청산은 reduce-only이고 수량이 관측값이다`, () => {
      const o: any = out;
      eq(o.prep.code, 'READY', `청산 준비가 ${o.prep.code}다`);
      eq(o.prep.prepared.reduceOnly, true);
      eq(o.prep.prepared.orderSide, 'SELL');
      assert(Math.abs(Number(o.prep.prepared.quantity) - Number(shown)) < 1e-9,
        `청산 수량 ${o.prep.prepared.quantity}가 관측 ${shown}과 다르다`);
      eq(o.sent?.ok, true, `청산 전송 실패: ${o.sent?.error}`);
    });

    test(`★★ ${sym} — 청산 뒤 거래소가 보여 주는 잔여가 0이다`, () => {
      const o: any = out;
      eq(o.after.found, false, `잔여가 남았다 (${o.after.qty})`);
      // 진입 1건 + 청산 1건. 그 사이에 재전송이 끼면 중복 체결이다.
      eq(venue.orderSends().length, 2,
        `주문 전송이 ${venue.orderSends().length}건이다 — 진입·청산 각 1건이어야 한다`);
    });
  }

  // ══════════ ⑦ 부분 체결 — 관측한 만큼만 닫는다 ══════════
  {
    const sym = 'BTCUSDT' as const;
    const p = entryFor(sym, 20);
    const full = p.quantity!.toFixed(3);
    const half = (p.quantity! / 2).toFixed(3);
    let amt = '0';
    const db = new FakeDb();
    const venue = stage(sym, 20, {
      positionAmt: () => amt,
      entryReply: {
        orderId: 9300, symbol: sym, status: 'PARTIALLY_FILLED',
        executedQty: half, origQty: full, avgPrice: String(SPEC[sym].price),
      },
    });
    const out = await scenario(venue, async () => {
      const entry = await sendEntry(db, sym, p);
      amt = half;
      const prep = await prepareSymbolClose(creds(), sym, 'LONG');
      return { entry, prep };
    });

    test('★★ 부분 체결은 전량 체결로 적히지 않는다', () => {
      assert(!(out instanceof Error), String((out as any)?.message));
      const o: any = out;
      assert(o.entry.status !== 'FILLED',
        `절반만 체결됐는데 ${o.entry.status}로 적혔다`);
    });

    test('★★ 청산 수량은 주문 수량이 아니라 **관측한 노출**이다', () => {
      const o: any = out;
      eq(o.prep.code, 'READY');
      assert(Math.abs(Number(o.prep.prepared.quantity) - Number(half)) < 1e-9,
        `${full}을 닫으려 한다 — 거래소에는 ${half}밖에 없다`);
    });
  }

  // ══════════ ⑧ 응답을 못 받으면 체결로 적지 않는다 ══════════
  {
    const p = entryFor('BTCUSDT', 20);
    const db = new FakeDb();
    const venue = stage('BTCUSDT', 20, { entryTimeout: true });
    const r = await scenario(venue, () => sendEntry(db, 'BTCUSDT', p,
      { clientOrderId: 'ADAPT-UNKNOWN-1' }));

    test('★★ 전송 타임아웃은 FILLED도 REJECTED도 아니다', () => {
      const row = db.table('live_orders')[0];
      assert(row, '장부 줄이 없다');
      assert(row.status !== 'FILLED', '응답을 못 받았는데 체결로 적혔다');
      assert(row.status !== 'REJECTED', '타임아웃을 거절로 단정했다');
      if (!(r instanceof Error)) {
        assert((r as any).status !== 'FILLED', '반환이 체결이다');
      }
    });
  }

  // ══════════ ⑨ 재시작 복구 — 끊긴 회차를 조회로 확정한다 ══════════
  //
  // 전송 뒤에 프로세스가 죽으면 장부에는 미확정 줄만 남는다. 다시 켰을 때
  // **다시 보내는 것**이 가장 위험하고(중복 체결), **없는 것으로 적는 것**이
  // 그다음으로 위험하다(포지션은 열려 있는데 장부는 비어 있다).
  {
    const sym = 'BTCUSDT' as const;
    const p = entryFor(sym, 20);
    const shown = p.quantity!.toFixed(3);
    const db = new FakeDb().seed('live_orders', [{
      id: 'row-restart', user_id: 'u1', connection_id: 'c1',
      client_order_id: 'ADAPT-RESTART-1', status: 'UNKNOWN',
      symbol: sym, side: 'BUY', exchange: 'binance', mode: 'TESTNET',
      quantity: p.quantity, leverage: 20,
      created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      pos_qty_before: 0, resolve_attempts: 0,
    }]);
    // 재시작 조회에서는 주문이 **보인다** — 끊긴 사이에 체결됐다.
    const venue = stage(sym, 20, { orderGet: {
      orderId: 9500, symbol: sym, status: 'FILLED',
      executedQty: shown, origQty: shown, avgPrice: String(SPEC[sym].price),
      clientOrderId: 'ADAPT-RESTART-1',
    } });
    await scenario(venue, () => reconcilePendingOrders(db as any, {
      exchange: 'binance', apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
      testnet: true, userId: 'u1', connectionId: 'c1',
    } as any));

    test('★★ 재시작 조회가 주문을 찾으면 체결로 확정하고 재전송하지 않는다', () => {
      const row = db.table('live_orders')[0];
      eq(row.status, 'FILLED', `조회에서 FILLED를 봤는데 장부가 ${row.status}다`);
      assert(Math.abs(Number(row.filled_qty) - Number(shown)) < 1e-9,
        `확정 수량 ${row.filled_qty} ≠ 조회 ${shown}`);
      eq(venue.orderSends().length, 0, '대조가 주문을 다시 보냈다 — 중복 체결이다');
    });
  }

  // ══════════ ⑨ 중복 — 같은 clientOrderId는 두 번 나가지 않는다 ══════════
  {
    const p = entryFor('BTCUSDT', 20);
    const db = new FakeDb({ failInsertCode: { table: 'live_orders', code: '23505' } });
    db.seed('live_orders', [{
      id: 'row-dup', client_order_id: 'ADAPT-DUP-1', status: 'FILLED',
      symbol: 'BTCUSDT', filled_qty: p.quantity, avg_price: SPEC.BTCUSDT.price,
      exchange_order_id: '9400',
    }]);
    const venue = stage('BTCUSDT', 20);
    const r = await scenario(venue, () => sendEntry(db, 'BTCUSDT', p,
      { clientOrderId: 'ADAPT-DUP-1' }));

    test('★★ 장부 유일성 제약에 걸리면 주문을 보내지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0, '중복인데 주문이 나갔다');
      eq((r as any).duplicate, true, '중복으로 판정하지 않았다');
    });
  }
}
