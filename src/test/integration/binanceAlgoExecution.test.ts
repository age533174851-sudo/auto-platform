import { test, eq, assert } from '../harness';
import { FakeDb, FakeVenue, withCryptoEnv } from './venueHarness';
import { encryptSecret } from '../../lib/exchanges/crypto';
import { settleAttempt } from '../../lib/smoke/settleAttempt';
import { startAttempt } from '../../lib/smoke/startAttempt';
import { testnetAlgoConnectionClear } from '../../lib/exchanges/binanceAlgoStore';
import { executeTestnetAlgoProtection } from '../../lib/exchanges/binanceAlgoExecution';
import { executeOrder } from '../../lib/engine/orderExecutor';
import { __clearFiltersCache } from '../../lib/exchanges/binanceFutures';

export async function runBinanceAlgoExecutionTests() {
  const restoreCrypto = withCryptoEnv();
  const cid = 'smo-abcBTCUSDE0', child = 'smo-abcBTCUSDS0';
  const scope = { userId: 'u1', connectionId: 'c1', parentId: 'p1' };
  const makeDb = (options = {}) => new FakeDb({ algoSchema: true, ...options })
    .seed('exchange_connections', [{ id: 'c1', user_id: 'u1', exchange_id: 'binance', is_testnet: true, has_withdrawal: false }])
    .seed('live_orders', [{ id: 'p1', user_id: 'u1', connection_id: 'c1', exchange: 'binance', mode: 'TESTNET',
      client_order_id: cid, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', testnet_algo_intents: {} }]);
  const intent = () => ({ environment: 'TESTNET' as const, symbol: 'BTCUSDT', positionMode: 'ONE_WAY' as const,
    closes: 'LONG' as const, side: 'SELL' as const, type: 'STOP_MARKET' as const, triggerPrice: 98,
    tickSize: .1, workingType: 'MARK_PRICE' as const, referencePrice: 100,
    referenceObservedAtMs: Date.now(), evaluatedAtMs: Date.now(), maxReferenceAgeMs: 5000,
    closeAll: true, clientAlgoId: child });
  async function core(options: { lost?: boolean; writeFail?: boolean; wrongRead?: boolean; live?: boolean } = {}) {
    const db = makeDb(options.writeFail ? { failUpdatesOn: 'live_orders' } : {});
    let posts = 0; let payload: Record<string, string> = {};
    const row = () => ({ ...payload, algoId: '9223372036854775801', algoType: 'CONDITIONAL',
      orderType: payload.type, algoStatus: 'NEW', positionSide: 'BOTH', closePosition: true, reduceOnly: false });
    const transport = { post: async (p: Record<string, string>) => {
      eq((db.row('live_orders', { id: 'p1' }).testnet_algo_intents as any)[child]?.state, 'SENT', 'POST preceded durable intent');
      posts++; payload = p;
      if (options.lost) throw Error('response lost after venue acceptance');
      return row();
    }, readOpen: async () => ({ success: true, orders: [{ ...row(), ...(options.wrongRead ? { reduceOnly: true, closePosition: false } : {}) }] }) };
    const input = { ...intent(), ...(options.live ? { environment: 'LIVE' as const } : {}) };
    const first = await executeTestnetAlgoProtection(db, scope, input, transport);
    const second = await executeTestnetAlgoProtection(db, scope, { ...input, evaluatedAtMs: Date.now() }, transport);
    return { first, second, db, posts };
  }
  const good = await core(), lost = await core({ lost: true }), failed = await core({ writeFail: true });
  const bad = await core({ wrongRead: true }), live = await core({ live: true });
  test('Algo POST requires confirmed durable intent, exact readback and lossless namespaced ID', () => {
    eq(good.first.success, true); eq(good.first.orderId, 'algo:9223372036854775801'); eq(good.posts, 1);
    eq(good.second.success, false); eq(good.db.row('live_orders', { id: 'p1' }).testnet_algo_intents[child].state, 'ACTIVE');
  });
  test('lost Algo ACK never sends the same child twice', () => { eq(lost.posts, 1); eq(lost.first.success, false); eq(lost.second.success, false); });
  test('unconfirmed DB intent and LIVE both produce zero venue writes', () => { eq(failed.posts, 0); eq(live.posts, 0); });
  test('Algo ACK with incorrect protective flags is UNKNOWN', () => { eq(bad.first.success, false); eq(bad.db.row('live_orders', { id: 'p1' }).testnet_algo_intents[child].state, 'UNKNOWN'); });

  // Real executor reproduces the observed -4120; only venue HTTP is fake.
  async function executorCase(useAlgo: boolean, hedge = false, foreign = false, viaStart = false, failHolding = false) {
  const db = new FakeDb({ algoSchema: true, ...(failHolding ? { failUpdatesOn: 'smoke_tests' } : {}) }).seed('exchange_connections', [{ id: 'c1', user_id: 'u1',
    exchange_id: 'binance', is_testnet: true, has_withdrawal: false,
    api_key: 'K'.repeat(64), api_secret_enc: encryptSecret('S'.repeat(64)) }]);
  let position = 0; let legacyProtectivePosts = 0; const active: any[] = [];
  const venue = new FakeVenue()
    .on('/fapi/v1/exchangeInfo', { json: { symbols: [{ symbol: 'BTCUSDT', filters: [
      { filterType: 'LOT_SIZE', stepSize: '.001', minQty: '.001', maxQty: '100000' }, { filterType: 'MARKET_LOT_SIZE', stepSize: '.001', minQty: '.001', maxQty: '100000' }, { filterType: 'PRICE_FILTER', tickSize: '.1' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ] }] } })
    .on('/fapi/v1/marginType', { json: { code: 200 } })
    .on('/fapi/v1/account', { json: { positions: [], assets: [] } })
    .on('/fapi/v1/positionSide/dual', { json: { dualSidePosition: hedge } })
    .on('/fapi/v1/leverage', { json: { leverage: 10, symbol: 'BTCUSDT' } })
    .on('/fapi/v1/ticker/price', { json: { symbol: 'BTCUSDT', price: '100' } })
    .on('/fapi/v1/premiumIndex', () => ({ json: { symbol: 'BTCUSDT', markPrice: '100', indexPrice: '100',
      lastFundingRate: '0', nextFundingTime: Date.now() + 3600000, time: Date.now() } }))
    .on('/fapi/v2/positionRisk', () => ({ json: [{ symbol: 'BTCUSDT', positionAmt: String(position), entryPrice: '100',
      markPrice: '100', positionSide: 'BOTH', leverage: '10', marginType: 'isolated', liquidationPrice: '90', notional: String(position * 100), isolatedMargin: '10' }] }))
    .on('/fapi/v1/order', { status: 400, json: { code: -2013, msg: 'Order does not exist' } }, 'GET')
    .on('/fapi/v1/order', call => {
      if (call.params.type !== 'MARKET') { legacyProtectivePosts++; return { status: 400, json: { code: -4120, msg: 'Please use Algo Order API endpoints' } }; }
      const quantity = Number(call.params.quantity);
      position = call.params.reduceOnly === 'true' ? 0 : quantity;
      return { json: { orderId: 42, symbol: 'BTCUSDT', status: 'FILLED', executedQty: String(quantity), origQty: String(quantity), avgPrice: '100', cumQuote: String(quantity * 100) } };
    }, 'POST')
    .on('/fapi/v1/openOrders', { json: [] })
    .on('/fapi/v1/openAlgoOrders', () => ({ json: active.filter(o => o.algoStatus === 'NEW') }))
    .on('/fapi/v1/algoOrder', call => ({ json: active.find(o => o.algoId === call.params.algoId || o.clientAlgoId === call.params.clientAlgoId) }), 'GET')
    .on('/fapi/v1/algoOrder', call => {
      const order = active.find(o => o.algoId === call.params.algoId);
      if (!order) return { status: 400, json: { code: -2013, msg: 'Order does not exist' } };
      order.algoStatus = 'CANCELED'; return { json: { code: 200, algoId: order.algoId, clientAlgoId: order.clientAlgoId } };
    }, 'DELETE')
    .on('/fapi/v1/algoOrder', call => {
      const row = { ...call.params, algoId: String(100 + active.length), algoType: 'CONDITIONAL', orderType: call.params.type,
        algoStatus: 'NEW', positionSide: 'BOTH', closePosition: true, reduceOnly: false };
      active.push(row); return { json: row };
    }, 'POST');
  __clearFiltersCache(); const restore = venue.install();
  let result: any, settled: any = null, fenced = false;
  try {
    if (viaStart) {
      result = await startAttempt(db, { userId: 'u1', connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG',
        leverage: 10, marginUsd: 20, holdMin: 1, source: 'USER' });
      if (result.ok && result.row?.state === 'HOLDING') settled = await settleAttempt(db, result.row);
      return { result, legacyProtectivePosts, active, venue, db, settled, fenced };
    }
    result = await executeOrder(db, { userId: 'u1', connectionId: 'c1', signalId: 'smoke-test:round1',
    clientOrderId: cid, exchange: 'binance', mode: 'TESTNET', source: 'MANUAL',
    testnetAlgoProtection: useAlgo, protectionPolicy: 'REQUIRED', stopLoss: 98, takeProfit: 104,
    apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
    plan: { approved: true, symbol: 'BTCUSDT', side: 'LONG', riskAmount: 2, riskAmountWithCosts: 2,
      stopDistancePct: 2, effectiveStopPct: 2, positionSize: 100, quantity: 1, requiredMargin: 10,
      leverage: 10, entryPrice: 100, liquidationPrice: 90, liquidationDistancePct: 10, notes: [] },
  } as any);
    if (useAlgo && result.ok === true) {
      fenced = !await testnetAlgoConnectionClear(db, 'u1', 'c1');
      if (foreign) active.push({ ...active[0], algoId: '999', clientAlgoId: 'smo-otherBTCUSDS0' });
      const row = { id: 'smoke1', user_id: 'u1', connection_id: 'c1', mode: 'TESTNET', symbol: 'BTCUSDT', side: 'LONG',
        client_order_id: cid, sl_order_id: result.slOrderId, tp_order_id: result.tpOrderId, hold_min: 1,
        hold_until: new Date(Date.now() - 1000).toISOString(), state: 'HOLDING', steps: Object.fromEntries(
          ['PREFLIGHT', 'ENTRY', 'FILL', 'STOP', 'TAKE_PROFIT'].map(key => [key, { state: 'PASS', note: 'entry proven' }])) };
      db.seed('smoke_tests', [row]); settled = await settleAttempt(db, row);
    }
  } finally { restore(); __clearFiltersCache(); }
  return { result, legacyProtectivePosts, active, venue, db, settled, fenced };
  }
  const legacy = await executorCase(false);
  const hedge = await executorCase(true, true);
  const foreign = await executorCase(true, false, true);
  const scheduled = await executorCase(true, false, false, true);
  const noDeadline = await executorCase(true, false, false, true, true);
  const { result, legacyProtectivePosts, active, venue, settled, fenced, db: roundDb } = await executorCase(true);
  test('legacy executor control reproduces observed -4120 before the new transport', () => {
    assert(legacy.legacyProtectivePosts > 0); eq(legacy.result.ok, false);
    assert(String(legacy.result.message).includes('4120'));
  });
  test('actual TESTNET smoke executor sends Algo STOP/TP, not legacy -4120 requests', () => {
    eq(legacyProtectivePosts, 0, 'legacy conditional endpoint still used');
    eq(active.length, 2, JSON.stringify(result)); eq(result.ok, true); eq(result.settled, true);
    eq(result.protection?.stop?.found, true); eq(result.protection?.takeProfit?.found, true);
    assert(String(result.slOrderId).startsWith('algo:'));
    for (const call of venue.calls.filter(call => call.path === '/fapi/v1/algoOrder')) {
      eq(call.host, 'demo-fapi.binance.com'); eq(call.authed, true);
      if (call.method === 'POST') {
        eq(call.params.algoType, 'CONDITIONAL'); assert(!!call.params.triggerPrice);
        eq(call.params.stopPrice, undefined);
      } else eq(call.params.symbol, undefined, 'individual Algo API does not accept symbol');
    }
  });
  test('HEDGE is rejected before entry, not after creating an unprotectable position', () => {
    eq(hedge.result.ok, false); eq(hedge.venue.orderSends().length, 0);
  });
  test('same-strategy text does not authorize canceling another parent Algo order', () => {
    eq(foreign.venue.calls.filter(call => call.method === 'DELETE' && call.params.algoId === '999').length, 0);
    eq(foreign.active.find(order => order.algoId === '999')?.algoStatus, 'NEW');
    assert(foreign.settled?.verdict !== 'PASS');
  });
  test('actual start persists HOLDING and a deadline, then actual settle completes it', () => {
    eq(scheduled.result.ok, true, JSON.stringify(scheduled.result));
    eq(scheduled.result.row?.state, 'HOLDING');
    assert(Number.isFinite(Date.parse(scheduled.result.row?.hold_until)));
    eq(scheduled.settled?.verdict, 'PASS', JSON.stringify(scheduled.settled));
  });
  test('missing HOLDING/deadline persistence cannot be reported STARTED', () => {
    eq(noDeadline.result.ok, false, JSON.stringify(noDeadline.result));
  });
  test('actual settle closes entry, cancels exact Algo IDs and clears durable child fence', async () => {
    eq(fenced, true);
    eq(settled?.verdict, 'PASS', JSON.stringify(settled));
    eq(venue.countOf('/fapi/v1/algoOrder', 'DELETE'), 2);
    eq(venue.countOf('/fapi/v1/order', 'DELETE'), 0);
    eq(await testnetAlgoConnectionClear(roundDb, 'u1', 'c1'), true);
    assert(active.every(order => order.algoStatus === 'CANCELED'));
  });
  const rejectedScopes = [];
  for (const override of [{ mode: 'LIVE' }, { exchange: 'gate' }, { signalId: 'ordinary-strategy' },
    { reduceOnly: true }, { orderType: 'LIMIT' }, { protectionPolicy: 'NONE' }]) {
    const emptyDb = new FakeDb(), emptyVenue = new FakeVenue(), uninstall = emptyVenue.install();
    try {
      const response = await executeOrder(emptyDb, { userId: 'u1', connectionId: 'c1',
        clientOrderId: cid, signalId: 'smoke-test:scope', mode: 'TESTNET', exchange: 'binance',
        testnetAlgoProtection: true, protectionPolicy: 'REQUIRED', stopLoss: 98,
        apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64), plan: { approved: true }, ...override } as any);
      rejectedScopes.push({ response, calls: emptyVenue.calls.length, writes: emptyDb.writes.length });
    } finally { uninstall(); }
  }
  test('Algo integration rejects LIVE, Gate, ordinary strategies and unsupported modes before any side effect', () => {
    for (const result of rejectedScopes) { eq(result.response.status, 'REJECTED'); eq(result.calls, 0); eq(result.writes, 0); }
  });
  restoreCrypto();
}
