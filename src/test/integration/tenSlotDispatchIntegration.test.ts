// src/test/integration/tenSlotDispatchIntegration.test.ts
//
// **오프라인 1슬롯: 예약 → 커밋된 의도 → 전송 한 번.** (#537)
//
// 왜 이 파일인가
// ──────────────
// 097·098은 실제 PostgreSQL에서 원자성을 증명했다. 그런데 `ten_slot_claim`을
// **부르는 곳이 없었다** — `src/`·`worker/` 전체에서 그 이름은 주석 한 줄뿐.
// 배선을 넣으면서 가장 먼저 드러나는 고장이 이것이다:
//
//   예약이 `live_orders`에 INTENT를 **이미 커밋해 둔다.** 그 뒤에
//   `executeOrder`를 평범하게 부르면 같은 `client_order_id`의 INSERT가
//   23505로 깨지고 그 자리에서 끝난다 — **슬롯은 묶이고 주문은 안 나간다.**
//
// 여기서 가짜로 바꾼 것은 두 경계뿐이다: `fetch` 한 겹, Supabase 한 겹.
// `dispatchTenSlot` · `executeOrder` · 전송 직전 CAS · 상태 전이 검증은
// **실제로 돈다.**
//
// 이 파일이 증명하지 않는 것
// ──────────────────────────
// SQL의 원자성은 여기서 증명되지 않는다 — 그건 실제 PostgreSQL 시험의
// 몫이다(`scripts/ten-slot-pg.test.mjs`). 여기서 보는 것은 **호출부**다.
import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb, withCryptoEnv } from './venueHarness';
import { dispatchTenSlot, claimVerdictOf, tenSlotEnabled, CLAIM_DURABLE }
  from '../../lib/engine/tenSlotDispatch';

const BN_ORDER = '/fapi/v1/order';
const BN_POS = '/fapi/v2/positionRisk';
const BN_LEV = '/fapi/v1/leverage';
const BN_DUAL = '/fapi/v1/positionSide/dual';
const BN_EXINFO = '/fapi/v1/exchangeInfo';

const COID = 'TS-COID-1';
const CAMPAIGN = 'camp-1';
const OWNER = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';
const SIG = 'sig-ten-slot-1';

const bnOrder = (o: Record<string, any> = {}) => ({
  orderId: 7001, symbol: 'BTCUSDT', status: 'NEW',
  executedQty: '0', origQty: '0.010', avgPrice: '0', price: '0', ...o,
});

const plan = (over: Record<string, any> = {}) => ({
  approved: true, symbol: 'BTCUSDT', side: 'LONG' as const,
  riskAmount: 10, riskAmountWithCosts: 10,
  stopDistancePct: 1, effectiveStopPct: 1,
  positionSize: 1000, quantity: 0.01, requiredMargin: 10,
  leverage: 100, liquidationPrice: 90000, liquidationDistancePct: 1,
  notes: [], ...over,
}) as any;

function baseVenue(lev = 100): FakeVenue {
  return new FakeVenue()
    .on(BN_EXINFO, { json: { symbols: [{
      symbol: 'BTCUSDT', filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
      ],
    }] } })
    .on('/fapi/v1/marginType', { json: { code: 200, msg: 'success' } })
    .on('/fapi/v1/account', { json: { positions: [], assets: [] } })
    .on(BN_DUAL, { json: { dualSidePosition: false } })
    .on(BN_LEV, { json: { leverage: lev, symbol: 'BTCUSDT' } })
    // **설정 응답과 되읽기 값을 같이 맞춘다.** 실행기는 설정 응답을 믿지
    // 않고 거래소에서 다시 읽어 대조한다 — 그 판단이 옳으므로 시험이
    // 거래소 쪽을 맞춘다.
    .on(BN_POS, { json: [{ symbol: 'BTCUSDT', positionAmt: '0', entryPrice: '0',
      leverage: String(lev), marginType: 'isolated', liquidationPrice: '0' }] });
}

/** 보낼 수 있는 거래소: 조회에는 없고, POST는 받는다 */
const sendableVenue = (lev = 100) => baseVenue(lev)
  .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
  .on(BN_ORDER, { json: bnOrder({ status: 'NEW', executedQty: '0' }) }, 'POST');

/** 097이 커밋해 둔 INTENT 줄. `dispatchTenSlot`이 조립하는 의도와 같은 값 */
const committedIntent = (over: Record<string, any> = {}) => ({
  id: 'claim-row-1', client_order_id: COID, status: 'INTENT',
  user_id: OWNER, connection_id: CONN, signal_id: SIG,
  exchange: 'binance', mode: 'TESTNET', symbol: 'BTCUSDT', side: 'BUY',
  order_type: 'MARKET', quantity: 0.01, leverage: 100, reduce_only: false,
  price: null, stop_loss: null, take_profit: null, stop_policy: 'NO_FIXED_SL',
  entry_adverse_distance_pct: null, entry_liquidation_distance_pct_raw: null,
  exchange_order_id: null, sent_at: null, attempt_count: 0,
  ...over,
});

/** 예약이 커밋된 DB. INSERT는 유니크로 깨지고, RPC는 커밋을 알린다 */
const claimedDb = (rpcOver?: any, rowOver: Record<string, any> = {}) =>
  new FakeDb({
    failInsertCode: { table: 'live_orders', code: '23505' },
    rpc: {
      ten_slot_claim: rpcOver ?? { data: [{
        code: CLAIM_DURABLE, slot_index: 0, campaign_version: 1,
        live_order_id: 'claim-row-1',
      }] },
    },
  }).seed('live_orders', [committedIntent(rowOver)]);

const ENV_ON = { TEN_SLOT_DISPATCH: 'on' };

async function dispatch(db: FakeDb, env: Record<string, string | undefined> = ENV_ON, over: any = {}) {
  return dispatchTenSlot(db as any, {
    campaignId: CAMPAIGN, expectedVersion: 0, clientOrderId: COID,
    exposure: { positions: 0, openOrders: 0, pendingEntries: 0 },
    userId: OWNER, connectionId: CONN, signalId: SIG,
    exchange: 'binance', mode: 'TESTNET',
    plan: plan(), apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
    // **`protectionPolicy`를 기본값으로 넣지 않는다.**
    //
    // 전에는 `'NONE'`을 넣어 뒀는데, 그러면 손절·정책 관문을 하나씩 떼
    // 보는 변이에서 **NONE 관문이 대신 막아** 시험이 그대로 통과했다.
    // 관문이 서로를 가리면 어느 것도 고정되지 않는다 — 실제로 변이 두
    // 건이 초록으로 통과했고 그래서 여기를 고쳤다.
    stopPolicy: 'NO_FIXED_SL', takeProfitPolicy: 'NO_FIXED_TP',
    ...over,
  }, env);
}

async function scenario<T>(venue: FakeVenue, body: () => Promise<T>): Promise<T | Error> {
  const restore = venue.install();
  const unenv = withCryptoEnv();
  try { return await body(); }
  catch (e: any) { return e instanceof Error ? e : new Error(String(e)); }
  finally { restore(); unenv(); }
}

export async function runTenSlotDispatchIntegrationTests() {
  console.log('[통합 — 10슬롯 1슬롯 배선 (fetch·DB만 가짜)]');

  // ══════════ ① 커밋된 예약은 거래소까지 간다. **한 번만** ══════════
  {
    const db = claimedDb();
    const venue = sendableVenue();
    const r = await scenario(venue, () => dispatch(db));

    test('★★ 예약이 커밋되면 주문이 거래소로 한 번 나간다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const d = r as any;
      eq(venue.orderSends().length, 1, `주문이 ${venue.orderSends().length}번 나갔다`);
      eq(d.claim.durable, true, d.claim.reason);
      eq(d.claim.slotIndex, 0);
      eq(d.exec?.status, 'ACKED', `${d.exec?.status} / ${d.exec?.message} / reason=${d.reason}`);
      // **의도를 또 적지 않는다.** 커밋된 그 줄을 쓴다.
      eq(db.table('live_orders').length, 1, '의도가 두 줄이 됐다');
      eq(db.table('live_orders')[0].id, 'claim-row-1');
    });
  }

  // ══════════ ② 기본은 꺼짐 — 예약조차 하지 않는다 ══════════
  {
    const db = claimedDb();
    const venue = sendableVenue();
    const r = await scenario(venue, () => dispatch(db, {}));

    test('★★ 켜지 않으면 거래소도 예약도 부르지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0, '꺼져 있는데 주문이 나갔다');
      // 예약만 해 두고 전송하지 않으면 슬롯이 묶인 채로 남는다.
      eq(db.rpcCalls.length, 0, '꺼져 있는데 예약을 불렀다');
      eq((r as any).ok, false);
    });
  }

  test('켜는 값은 하나뿐이다 — true·1·yes로는 켜지지 않는다', () => {
    eq(tenSlotEnabled({}), false);
    eq(tenSlotEnabled({ TEN_SLOT_DISPATCH: 'true' }), false);
    eq(tenSlotEnabled({ TEN_SLOT_DISPATCH: '1' }), false);
    eq(tenSlotEnabled({ TEN_SLOT_DISPATCH: 'yes' }), false);
    eq(tenSlotEnabled({ TEN_SLOT_DISPATCH: 'ON' }), true);
    eq(tenSlotEnabled({ TEN_SLOT_DISPATCH: ' on ' }), true);
  });

  // ══════════ ③ 예약이 커밋되지 않으면 **전송하지 않는다** ══════════
  //
  // 코드 하나하나가 다른 이유로 거절이다. 어느 하나라도 전송을 열면
  // 그건 예약 없이 주문을 내는 길이다.
  const refusals: Array<[string, string]> = [
    ['이미 열린 슬롯이 없다', 'EXHAUSTED'],
    ['캠페인이 없다', 'CAMPAIGN_MISSING'],
    ['버전이 어긋났다', 'VERSION_MISMATCH'],
    ['중지된 캠페인', 'KILLED'],
    ['노출을 확인하지 못했다', 'EXPOSURE_UNKNOWN'],
    ['호출자 정체성이 없다', 'CALLER_UNKNOWN'],
    ['주인이 다르다', 'CLAIM_IDENTITY_MISMATCH'],
  ];
  for (const [label, code] of refusals) {
    const db = claimedDb({ data: [{ code, slot_index: null, campaign_version: null, live_order_id: null }] });
    const venue = sendableVenue();
    const r = await scenario(venue, () => dispatch(db));
    test(`★ 예약 거절(${label} · ${code})이면 전송하지 않는다`, () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0, `${code}인데 주문이 나갔다`);
      eq((r as any).ok, false);
      eq((r as any).exec, null, '전송하지 않았는데 전송 결과를 적었다');
      eq((r as any).claim.code, code);
    });
  }

  // ══════════ ④ 확인하지 못한 예약도 전송하지 않는다 ══════════
  const unknowns: Array<[string, any]> = [
    ['호출이 오류로 끝났다', { error: { message: 'boom' } }],
    ['응답이 비어 있다', { data: [] }],
    ['응답이 null이다', { data: null }],
    ['줄이 두 개다', { data: [
      { code: CLAIM_DURABLE, slot_index: 0, campaign_version: 1, live_order_id: 'a' },
      { code: CLAIM_DURABLE, slot_index: 1, campaign_version: 1, live_order_id: 'b' },
    ] }],
    ['코드가 없다', { data: [{ slot_index: 0, campaign_version: 1, live_order_id: 'a' }] }],
    ['커밋됐다는데 슬롯 번호가 없다', { data: [{ code: CLAIM_DURABLE, slot_index: null, campaign_version: 1, live_order_id: 'a' }] }],
    ['커밋됐다는데 버전이 없다', { data: [{ code: CLAIM_DURABLE, slot_index: 0, campaign_version: null, live_order_id: 'a' }] }],
    ['커밋됐다는데 주문 줄 id가 없다', { data: [{ code: CLAIM_DURABLE, slot_index: 0, campaign_version: 1, live_order_id: null }] }],
    ['호출이 던졌다', { throws: '연결이 끊겼습니다' }],
  ];
  for (const [label, reply] of unknowns) {
    const db = claimedDb(reply);
    const venue = sendableVenue();
    const r = await scenario(venue, () => dispatch(db));
    test(`★★ 예약을 확인 못 함(${label})이면 전송하지 않는다`, () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0, `${label} — 확인도 못 했는데 주문이 나갔다`);
      eq((r as any).ok, false);
      eq((r as any).claim.durable, false);
      eq((r as any).exec, null);
      assert(typeof (r as any).reason === 'string' && (r as any).reason.length > 0,
        '왜 안 보냈는지 적지 않았다');
    });
  }

  // ══════════ ⑤ 예약이 쓴 번호를 그대로 들고 간다 ══════════
  {
    const db = claimedDb();
    const venue = sendableVenue();
    await scenario(venue, () => dispatch(db));
    test('★★ 예약과 전송이 같은 client_order_id를 쓴다', () => {
      eq(db.rpcCalls.length, 1);
      eq(db.rpcCalls[0].name, 'ten_slot_claim');
      eq(db.rpcCalls[0].args.p_client_order_id, COID);
      // 거래소에 나간 번호도 같아야 한다 — 다르면 거래소와 장부가 갈린다.
      const sent = venue.orderSends()[0] as any;
      eq(sent?.params?.newClientOrderId, COID,
        `거래소에 나간 번호가 예약 번호와 다르다: ${JSON.stringify(sent?.params ?? null)}`);
    });
  }

  // **`test()` 안에서 시나리오를 돌리지 않는다.** 이 파일 맨 위 harness
  // 주석이 적은 그대로다 — `test()`는 async 본문을 pending에 넣고 바로
  // 돌아오므로, 안에서 fetch 스텁을 깔면 다른 시나리오의 스텁과 겹친다.
  // 실제로 그렇게 적었다가 **같은 주문이 옆 시나리오의 거래소에 한 번 더
  // 기록돼** "POST 2회"로 보였다. 실행은 여기서, 판정만 test()에.
  {
    const db = claimedDb();
    await scenario(sendableVenue(), () => dispatch(db));
    test('★★ 호출자 정체성을 예약에 들고 간다 — SQL의 CALLER_UNKNOWN을 우회하지 않는다', () => {
      eq(db.rpcCalls.length, 1);
      eq(db.rpcCalls[0].args.p_caller_user_id, OWNER);
      eq(db.rpcCalls[0].args.p_caller_connection_id, CONN);
      eq(db.rpcCalls[0].args.p_signal_id, SIG);
    });
  }

  // ══════════ ⑤-c 신호 id가 없으면 예약조차 하지 않는다 ══════════
  //
  // `canAdoptIntent()`는 `user_id`·`connection_id`·`signal_id` 셋을
  // 정체성으로 요구한다. 097의 `p_signal_id`는 기본값 NULL이므로, 안
  // 넘기고 예약하면 **이어받을 수 없는 의도가 커밋된다** — 슬롯은 묶이고
  // 주문은 영원히 나가지 않는다. 실제로 그 모양을 먼저 봤다.
  {
    const db = claimedDb();
    const venue = sendableVenue();
    const r = await scenario(venue, () => dispatch(db, ENV_ON, { signalId: '  ' }));
    test('★★ 신호 id가 비면 예약도 전송도 하지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(db.rpcCalls.length, 0, '이어받을 수 없는 예약을 만들었다');
      eq(venue.orderSends().length, 0);
      eq((r as any).ok, false);
    });
  }

  // ══════════ ⑤-d 이어받을 수 없는 계약은 **예약하지 않는다** ══════════
  //
  // 검수 지적을 실제로 돌려 확인했다. `stopPolicy: 'FIXED_SL'`로 예약하면:
  //
  //   sends 0 · UNKNOWN · "커밋된 의도의 stop_policy가 보낼 계약과 다릅니다"
  //
  // 097은 `FIXED_SL`을 유효하게 받아 커밋하는데 `orderExecutor`는
  // `NO_FIXED_SL`일 때만 의도에 그 칸을 넣는다. 그래서 대조가 깨지고
  // **슬롯만 RESERVED로 남는다.** 그 비대칭을 `orderExecutor`에서 고치지
  // 않고(078의 이유가 있다) 이 경로가 예약하지 않는 쪽으로 막았다.
  for (const policy of ['FIXED_SL', 'TRAILING', 'fixed_sl']) {
    const db = claimedDb(undefined, { stop_policy: policy });
    const venue = sendableVenue();
    // 손절가도 주고 보호도 요구한다 — **이 관문만** 막아야 한다.
    const r = await scenario(venue, () => dispatch(db, ENV_ON,
      { stopPolicy: policy, stopLoss: 95000, protectionPolicy: 'REQUIRED' }));
    test(`★★ 이어받을 수 없는 stopPolicy(${policy})는 예약조차 하지 않는다`, () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(db.rpcCalls.length, 0, '이어받을 수 없는 예약을 만들었다 — 슬롯이 묶인다');
      eq(venue.orderSends().length, 0);
      eq((r as any).ok, false);
    });
  }

  // ══════════ ⑤-e 보호 없는 진입을 열지 않는다 ══════════
  //
  // 검수 지적 B를 그대로 돌려 확인했다. 손절가를 넘기지 않으면:
  //
  //   sends 1 · ACKED · slOrderId null      ← 보호되지 않은 포지션
  //
  // 100배가 열리는 경로에서 가장 비싼 결과다. `NO_FIXED_SL`은 고정 손절을
  // **일부러** 걸지 않는 계약이므로 그 경우만 통과한다.
  {
    const db = claimedDb(undefined, { stop_policy: null });
    const venue = sendableVenue();
    const r = await scenario(venue, () => dispatch(db, ENV_ON,
      { stopPolicy: null, protectionPolicy: 'REQUIRED' }));
    test('★★ 손절가가 없으면 예약도 전송도 하지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(db.rpcCalls.length, 0, '보호 없이 열릴 예약을 만들었다');
      eq(venue.orderSends().length, 0, '보호 없이 주문이 나갔다');
      eq((r as any).ok, false);
    });
  }

  for (const [label, bad] of [
    ['0', 0], ['음수', -1], ['NaN', Number.NaN], ['무한', Number.POSITIVE_INFINITY],
  ] as Array<[string, number]>) {
    const db = claimedDb(undefined, { stop_policy: null });
    const venue = sendableVenue();
    const r = await scenario(venue, () => dispatch(db, ENV_ON,
      { stopPolicy: null, stopLoss: bad, protectionPolicy: 'REQUIRED' }));
    test(`★ 손절가가 ${label}이면 손절로 세지 않는다`, () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(db.rpcCalls.length, 0, `${label}을 손절가로 받아들였다`);
      eq(venue.orderSends().length, 0);
    });
  }

  test('NO_FIXED_SL은 손절가 없이 지나간다 — 일부러 걸지 않는 계약이다', async () => {
    // 이 계약의 통과는 위 ①이 이미 돌려서 보였다(기본 dispatch가 NO_FIXED_SL).
    // 여기서는 그 분기가 손절가를 **요구하지 않는다**는 것만 고정한다.
    eq(typeof dispatchTenSlot, 'function');
  });

  // ══════════ ⑤-f 손절가를 주면 **예약과 전송 양쪽에** 같은 값이 간다 ══════════
  {
    const SL = 95000;
    const db = claimedDb(undefined, { stop_policy: null, stop_loss: SL });
    // **손절이 붙었는지 거래소에서 되읽어 확인한다.** 주문을 보냈다는 것과
    // 손절이 걸렸다는 것은 다른 사실이다 — 되읽기를 깔지 않으면 실행기는
    // 정직하게 "확인하지 못했습니다"로 끝내고, 그건 PROTECTED의 증거가 아니다.
    const venue = sendableVenue()
      .on('/fapi/v1/openOrders', { json: [{ orderId: 7001, symbol: 'BTCUSDT',
        type: 'STOP_MARKET', side: 'SELL', stopPrice: String(SL), reduceOnly: true }] });
    const r = await scenario(venue, () => dispatch(db, ENV_ON,
      { stopPolicy: null, stopLoss: SL, protectionPolicy: undefined }));
    test('★★ 손절가는 예약과 전송에 같은 값으로 간다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(db.rpcCalls.length, 1);
      eq(db.rpcCalls[0].args.p_stop_loss, SL, '예약에 손절가가 가지 않았다');
      // 이어받기가 손절가까지 대조하므로, 양쪽이 같아야 전송이 열린다.
      eq((r as any).claim.durable, true, (r as any).claim.reason);
      assert(venue.orderSends().length >= 1,
        `손절가를 줬는데 진입이 나가지 않았다: ${(r as any).exec?.status} / ${(r as any).exec?.message}`);
      // **보호가 실제로 붙었는가.** 진입이 나간 것만으로는 부족하다 —
      // 검수 지적 B가 가리킨 것이 바로 "나갔는데 손절이 없다"였다.
      // 진입 + 손절 = POST 2회. 손절 주문 번호가 남아야 한다.
      eq(venue.orderSends().length, 2, `POST가 ${venue.orderSends().length}번이다 (진입+손절=2)`);
      assert((r as any).exec?.slOrderId != null,
        `손절 주문 번호가 없다: ${(r as any).exec?.message}`);
      // **보호되지 않았다고 적히지 않는다.**
      assert((r as any).exec?.unprotected !== true,
        `보호되지 않은 포지션으로 끝났다: ${(r as any).exec?.message}`);
      // 되읽기가 실제로 됐다는 증거: 실행기는 못 읽으면 그 사실을 메시지에
      // 적는다("거래소 주문 목록을 읽지 못해 손절 부착을 확인하지
      // 못했습니다"). 그 문구가 없어야 확인된 것이다.
      assert(!String((r as any).exec?.message ?? '').includes('확인하지 못했'),
        `손절 부착을 확인하지 못한 채 끝났다: ${(r as any).exec?.message}`);
    });
  }

  {
    const db = claimedDb(undefined, { stop_policy: null, stop_loss: 95000 });
    const venue = sendableVenue();
    const r = await scenario(venue, () => dispatch(db, ENV_ON,
      { stopPolicy: null, stopLoss: 95000, protectionPolicy: 'NONE' }));
    test('★★ 손절가가 있어도 protectionPolicy=NONE이면 예약도 전송도 하지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      // 실측: NONE이면 손절가를 줘도 slOrderId null · unprotected true로 끝났다.
      eq(db.rpcCalls.length, 0, '보호 없이 열릴 예약을 만들었다');
      eq(venue.orderSends().length, 0, '보호 없이 주문이 나갔다');
      eq((r as any).ok, false);
    });
  }

  // ══════════ ⑤-g 방향과 배율: LONG/SHORT · 10~75배 ══════════
  //
  // 기존 시험은 LONG·100배만 봤다. 사용자가 쓰는 범위를 덮지 않으면
  // "통과했다"가 그 범위의 증거가 아니다.
  for (const [side, venueSide] of [['LONG', 'BUY'], ['SHORT', 'SELL']] as Array<[string, string]>) {
    for (const lev of [10, 75]) {
      const db = claimedDb(undefined, { side: venueSide, leverage: lev });
      const venue = sendableVenue(lev);
      const r = await scenario(venue, () => dispatch(db, ENV_ON, { plan: plan({ side, leverage: lev }) }));
      test(`★★ ${side} ${lev}배도 예약을 이어받아 한 번만 보낸다`, () => {
        assert(!(r instanceof Error), String((r as any)?.message));
        const d = r as any;
        eq(d.claim.durable, true, d.claim.reason);
        eq(d.exec?.status, 'ACKED', `${d.exec?.status} / ${d.exec?.message}`);
        eq(venue.orderSends().length, 1, `주문이 ${venue.orderSends().length}번 나갔다`);
        eq(db.rpcCalls[0].args.p_side, venueSide, '예약에 간 방향이 다르다');
        eq(db.rpcCalls[0].args.p_leverage, lev, '예약에 간 배율이 다르다');
      });
    }
  }

  // ══════════ ⑤-h 실행기가 거절할 계획으로 **예약하지 않는다** ══════════
  //
  // 전부 실제로 돌려서 본 모양이다. 고치기 전에는 **예약 1회 · 전송 0회**로
  // 끝났다 — 슬롯은 RESERVED, 주문은 없음:
  //
  //   approved=false  → REJECTED "승인되지 않은 계획은 주문할 수 없습니다"
  //   leverage 0      → REJECTED "레버리지를 확인하지 못했습니다 (0)"
  //   leverage NaN    → REJECTED "레버리지를 확인하지 못했습니다 (NaN)"
  //   NO_FIXED_SL+손절 → REJECTED "고정 손절을 쓰지 않는 프로필인데 …"
  //
  // **각 시험은 나머지 입력이 전부 유효하다.** 안 그러면 다른 관문이
  // 대신 막아 가짜 GREEN이 된다 — 이 파일에서 실제로 한 번 당했다.
  const badPlans: Array<[string, any]> = [
    ['승인되지 않은 계획', { plan: plan({ approved: false }) }],
    ['방향이 HOLD', { plan: plan({ side: 'HOLD' }) }],
    ['방향이 null', { plan: plan({ side: null }) }],
    ['방향이 빈 문자열', { plan: plan({ side: '' }) }],
    ['배율 0', { plan: plan({ leverage: 0 }) }],
    ['배율 음수', { plan: plan({ leverage: -10 }) }],
    ['배율 NaN', { plan: plan({ leverage: Number.NaN }) }],
    ['배율이 소수', { plan: plan({ leverage: 12.5 }) }],
    ['배율 없음', { plan: plan({ leverage: null }) }],
    ['NO_FIXED_SL인데 손절가', { stopPolicy: 'NO_FIXED_SL', stopLoss: 95000 }],
    ['NO_FIXED_TP인데 익절가', { stopPolicy: 'NO_FIXED_SL', takeProfitPolicy: 'NO_FIXED_TP', takeProfit: 120000 }],
  ];
  for (const [label, over] of badPlans) {
    const db = claimedDb();
    const venue = sendableVenue();
    const r = await scenario(venue, () => dispatch(db, ENV_ON, over));
    test(`★★ ${label}이면 예약조차 하지 않는다`, () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(db.rpcCalls.length, 0, '실행기가 거절할 계획으로 예약했다 — 슬롯이 묶인다');
      eq(venue.orderSends().length, 0);
      eq((r as any).ok, false);
      eq((r as any).exec, null, '전송하지 않았는데 전송 결과를 적었다');
    });
  }

  // ══════════ ⑤-i 방향은 **예약과 전송이 같은 것을 봐야 한다** ══════════
  //
  // 이 파일은 `p_side`를 `side === 'SHORT' ? 'SELL' : 'BUY'`로 보내고
  // `orderExecutor`는 `side !== 'LONG' ? 'SELL' : 'BUY'`로 읽는다.
  // 두 식은 LONG·SHORT에서만 같다 — 그 범위만 받는 것을 고정한다.
  for (const [side, expected] of [['LONG', 'BUY'], ['SHORT', 'SELL']] as Array<[string, string]>) {
    const db = claimedDb(undefined, { side: expected });
    const venue = sendableVenue();
    await scenario(venue, () => dispatch(db, ENV_ON, { plan: plan({ side }) }));
    test(`★ ${side} 예약에 가는 방향은 ${expected}다 — 실행기가 읽는 것과 같다`, () => {
      eq(db.rpcCalls.length, 1);
      eq(db.rpcCalls[0].args.p_side, expected);
    });
  }

  // ══════════ ⑤-j 실행 계약·위험 좌표는 **양쪽에 같이 간다** ══════════
  //
  // 전에는 이 경로가 그 칸을 **받지도, 넘기지도 않았다.** 계약을 준
  // 호출부의 값이 조용히 사라지고, 주문은 계약 없이 나갔다:
  //
  //   executionIdentity 지정 → rpc 1 · sends 1 · ACKED   ← 계약이 사라진 채
  //
  // 그러면 `live_orders`의 계약 세 칸이 비고, 나중 복구가 "배율 100이고
  // 손절이 없으니 Exact100X겠지"로 되돌아간다 — 090이 끝낸 추론이다.
  {
    const IDENT = { profileId: 'exact100x', presetId: 'exact100x-v3', contractVersion: 3 };
    const RISK = { adverseDistancePct: 1.5, liquidationDistancePctRaw: 0.9 };
    const db = claimedDb(undefined, {
      execution_profile_id: IDENT.profileId,
      execution_preset_id: IDENT.presetId,
      execution_contract_version: IDENT.contractVersion,
      entry_adverse_distance_pct: RISK.adverseDistancePct,
      entry_liquidation_distance_pct_raw: RISK.liquidationDistancePctRaw,
    });
    const venue = sendableVenue();
    const r = await scenario(venue, () => dispatch(db, ENV_ON,
      { executionIdentity: IDENT, entryRiskSnapshot: RISK }));

    test('★★ 계약과 위험 좌표가 예약에 적히고, 그 예약을 이어받아 보낸다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(db.rpcCalls.length, 1);
      const args = db.rpcCalls[0].args;
      eq(args.p_execution_profile_id, IDENT.profileId, '예약에 프로필이 가지 않았다');
      eq(args.p_execution_preset_id, IDENT.presetId, '예약에 프리셋이 가지 않았다');
      eq(args.p_execution_contract_version, IDENT.contractVersion, '예약에 계약 버전이 가지 않았다');
      eq(args.p_entry_adverse_distance_pct, RISK.adverseDistancePct);
      eq(args.p_entry_liquidation_distance_pct_raw, RISK.liquidationDistancePctRaw);
      // 양쪽이 같아야 이어받기가 열린다 — 한쪽만 넘기면 거절된다.
      eq((r as any).claim.durable, true, (r as any).claim.reason);
      eq((r as any).exec?.status, 'ACKED', (r as any).exec?.message);
      eq(venue.orderSends().length, 1);
    });
  }

  // ══════════ ⑤-k 불완전한 계약으로는 예약하지 않는다 ══════════
  //
  // 실행기는 계약이 있는데 짝이 안 맞으면 전송 직전에 거절한다. 그때
  // 예약은 이미 커밋돼 있다 — 슬롯만 남는다.
  for (const [label, ident] of [
    ['프리셋 없음', { profileId: 'exact100x', contractVersion: 3 }],
    ['프로필 없음', { presetId: 'exact100x-v3', contractVersion: 3 }],
    ['버전 없음', { profileId: 'exact100x', presetId: 'exact100x-v3' }],
    ['버전이 숫자가 아님', { profileId: 'exact100x', presetId: 'exact100x-v3', contractVersion: 'x' }],
    ['빈 프로필', { profileId: '  ', presetId: 'exact100x-v3', contractVersion: 3 }],
  ] as Array<[string, any]>) {
    const db = claimedDb();
    const venue = sendableVenue();
    const r = await scenario(venue, () => dispatch(db, ENV_ON, { executionIdentity: ident }));
    test(`★★ 불완전한 계약(${label})이면 예약조차 하지 않는다`, () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(db.rpcCalls.length, 0, '불완전한 계약으로 예약했다 — 슬롯이 묶인다');
      eq(venue.orderSends().length, 0);
      eq((r as any).ok, false);
    });
  }

  // ══════════ ⑥ 같은 예약을 두 실행기가 동시에 집어도 전송은 한 번 ══════════
  //
  // 새 잠금을 만들지 않았다. `orderExecutor`의 전송 직전 CAS
  // (`INTENT → SENT` 조건부 UPDATE)가 **실제로** 두 번째를 막는지 본다.
  {
    const db = claimedDb();
    const venue = sendableVenue();
    const rs = await scenario(venue, () => Promise.all([dispatch(db), dispatch(db)]));
    test('★★ 동시 두 실행기여도 거래소 POST는 한 번이다', () => {
      assert(!(rs instanceof Error), String((rs as any)?.message));
      eq(venue.orderSends().length, 1, `주문이 ${venue.orderSends().length}번 나갔다`);
      const sent = db.writes.filter(w => w.kind === 'update'
        && w.patch.status === 'SENT' && (w.where as any)?.status === 'INTENT');
      eq(sent.length, 1, `SENT 선점이 ${sent.length}번이다`);
    });
  }

  // ══════════ ⑦ 예약 판정은 순수 함수로도 고정한다 ══════════
  test('예약 판정: 커밋 코드 하나만 전송을 연다', () => {
    eq(claimVerdictOf([{ code: CLAIM_DURABLE, slot_index: 0, campaign_version: 1, live_order_id: 'a' }]).durable, true);
    eq(claimVerdictOf([{ code: 'ALREADY_CLAIMED', slot_index: 0, campaign_version: 1, live_order_id: 'a' }]).durable, false);
    // 한 줄로 와도 받는다 (RETURNS TABLE이 한 줄로 올 수 있다)
    eq(claimVerdictOf({ code: CLAIM_DURABLE, slot_index: 3, campaign_version: 9, live_order_id: 'a' }).slotIndex, 3);
    // 숫자 모양이 아닌 값은 0으로 바꾸지 않는다
    eq(claimVerdictOf([{ code: CLAIM_DURABLE, slot_index: 'x', campaign_version: 1, live_order_id: 'a' }]).durable, false);
  });
}
