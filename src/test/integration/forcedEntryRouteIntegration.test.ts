// src/test/integration/forcedEntryRouteIntegration.test.ts
//
// **09:00 KST 강제 진입을 실제 라우트 핸들러로 두드린다.**
//
// 순수 판정 시험(`dailyForcedEntry.test.ts`)은 "창 안이면 due"를 본다.
// 그것만으로는 **라우트가 그 판정을 쓰는지**를 모른다 — 이 저장소에서
// 가장 자주 난 고장이 "만들어 놓고 배선을 안 함"이다. 그래서 여기서는
// `POST`를 직접 부르고 **거래소로 나간 주문 수**를 센다.
//
// 거래소와 DB 두 경계만 가짜다. 신호 계산 · 창 판정 · 중복 판정 ·
// 응답 조립은 전부 실제 코드가 돈다.
//
// **여기서 다시 만들지 않는 것 — 이미 덮여 있다**
//
//   주문 전송 실패 · 타임아웃 · 중복 전송 · 부분 체결
//     → `orderPathIntegration`이 `executeOrder`를 직접 돌려 덮는다.
//   진입 → 감시 → 종료 사슬 (청산 감시)
//     → PR #382 `exact100xChainIntegration`이 덮는다.
//
//   강제 진입은 평소 진입과 **같은 `executeOrder`·같은 장부 줄**을 쓰므로
//   그 두 곳을 여기서 복제하면 같은 것을 두 벌 들고 가게 된다.
//
// **이 시험이 아직 증명하지 못하는 것**
//
//   창 안에서도 주문은 아직 거래소로 나가지 않는다 — 고배율 위험 거부
//   (경제 캘린더 확인 불가 · 변동성 기준 없음)가 fail-closed로 막는다.
//   그 둘은 이 변경의 범위 밖이고, 관문을 지워서 통과시키지 않는다.
//   대신 **어디서 막히는지를 시험에 적어 둔다.**

import { test, eq, assert, flushAsync } from '../harness';
import { FakeDb, FakeVenue, withCryptoEnv } from './venueHarness';
import { encryptSecret } from '../../lib/exchanges/crypto';
import { MIGRATION_MANIFEST } from '../../lib/system/migrationManifest';
import { clearCalendarCache } from '../../lib/calendar/econCalendar';
import { DAY_MS } from '../../lib/markets/dailyBarEvidence';

const ADMIN = 'test-admin-secret-0123456789';
const USER = 'u-1';
const CONN = 'c-testnet';
const SYMBOL = 'BTCUSDT';

/** 09:00 KST == 00:00 UTC */
const KST_0905 = Date.parse('2026-10-21T00:05:00Z');
const KST_1000 = Date.parse('2026-10-21T01:00:00Z');

function req(body: any, headers: Record<string, string> = {}): any {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    json: async () => body,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    nextUrl: new URL('https://x.test/api/autotrade/scalp'),
  };
}

function conn(over: Record<string, any> = {}) {
  return {
    id: CONN, user_id: USER, exchange_id: 'binance',
    api_key: 'K'.repeat(64), api_secret_enc: encryptSecret('S'.repeat(64)),
    has_withdrawal: false, is_testnet: true, perm_read: true, perm_trading: true, is_active: true,
    ...over,
  };
}

/**
 * **신호가 나지 않는 봉.** 좁은 구간을 오가고 마지막 종가가 그 안에
 * 있으면 `scalpSignal`은 '돌파 없음'으로 끝난다 — 지금까지 매일 그랬다.
 */
function flatKlines(n = 200, base = 60000) {
  const rows: any[] = [];
  const step = 60 * 60_000;                       // 1시간봉
  const start = Date.UTC(2026, 9, 1);             // 과거 — 미완성 봉 절단에 안 걸린다
  for (let i = 0; i < n; i++) {
    const c = base + (i % 7) * 10;                // 70달러 폭 안에서만 움직인다
    rows.push([start + i * step, String(c), String(c + 30), String(c - 30), String(c), '100',
      start + i * step + step - 1, '0', 10, '0', '0', '0']);
  }
  return rows;
}

/**
 * **진짜 일봉.** UTC 00:00 간격, 마지막 봉은 어제 것.
 *
 * 기존 `flatKlines`는 1시간봉이고 2026-10-01에서 멈춰 있다 — 그것이
 * 일봉 자리에 들어가도 통과하던 것이 이 PR이 닫는 구멍이다.
 */
function dailyKlines(nowMs: number, n = 60, base = 60000) {
  const lastOpen = Math.floor(nowMs / DAY_MS) * DAY_MS - DAY_MS;
  const rows: any[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const t = lastOpen - k * DAY_MS;
    const c = base + (k % 7) * 50;
    rows.push([t, String(c), String(c + 400), String(c - 400), String(c), '1000',
      t + DAY_MS - 1, '0', 100, '0', '0', '0']);
  }
  return rows;
}

/** 신선한 경제 캘린더 한 줄 (영향도 낮음 — 지표 임박 거부를 부르지 않는다) */
function freshCalendarRows(nowMs: number) {
  return [{
    id: 'ev-1', timestamp_utc: new Date(nowMs + 5 * DAY_MS).toISOString(),
    event: 'Low impact filler', impact: 'low', country: 'US',
    affected_assets: null, source: 'api', time_known: true,
    updated_at: new Date(nowMs - 60_000).toISOString(),
  }];
}

const BODY = {
  userId: USER, connectionId: CONN, symbol: SYMBOL, mode: 'TESTNET',
  intervalMin: 60,
  executionProfileId: 'MAX_LEV_100X',
  executionPresetId: 'EXACT_100X',
  executionContractVersion: 2,
  marginAllocationPct: 10,
};

export async function runForcedEntryRouteTests() {
  console.log('[통합 — 09:00 KST 강제 진입 (실제 라우트)]');

  // 앞의 async 시험들과 겹치면 전역 fetch·require 캐시가 섞인다.
  await flushAsync();

  const serverPath = require.resolve('../../lib/supabase/server');
  const adminPath = require.resolve('../../lib/supabase/admin');
  const routePath = require.resolve('../../app/api/autotrade/scalp/route');

  /** 한 번 두드린다. 시계·거래소·DB를 모두 고정한다 */
  async function hit(opts: {
    nowMs: number;
    seedOrders?: any[];
    failOrderSelect?: boolean;
    /** 진짜 일봉을 돌려줄 것인가 (기본: 1시간봉 — 기존 재현 픽스처) */
    goodDaily?: boolean;
    /** 신선한 경제 캘린더를 넣을 것인가 */
    calendar?: boolean;
    body?: any;
  }) {
    const prevSecret = process.env.ADMIN_SECRET;
    process.env.ADMIN_SECRET = ADMIN;
    const restoreCrypto = withCryptoEnv();

    // **모듈 캐시를 비운다.** 앞 시나리오의 "이벤트 없음"이 캐시에 남으면
    // 뒤 시나리오가 캘린더를 넣어도 그대로 막힌다.
    clearCalendarCache();
    const db = new FakeDb(opts.failOrderSelect ? { failSelectsOn: 'live_orders' } : {});
    if (opts.calendar) db.seed('econ_events', freshCalendarRows(opts.nowMs));
    db.seed('exchange_connections', [conn()]);
    // 마이그레이션 관문은 실제 관문이다 — **끄지 않고 만족시킨다.**
    db.seed('schema_migrations', MIGRATION_MANIFEST.map((m: any) => ({
      filename: m.name, checksum: m.checksum, status: 'applied', verified: true,
    })));
    if (opts.seedOrders) db.seed('live_orders', opts.seedOrders);

    const venue = new FakeVenue();
    // **일봉 요청을 먼저 가른다.** 뒤의 일반 규칙이 모든 주기를 삼킨다.
    venue.onParams('/fapi/v1/klines', 'GET', { interval: '1d' },
      { json: opts.goodDaily ? dailyKlines(opts.nowMs) : flatKlines() });
    venue.on('/fapi/v1/klines', { json: flatKlines() });
    // 포지션은 0이지만 **격리·100배 설정은 읽혀야** 한다. 빈 배열이면
    // 라우트가 `MARGIN_MODE_UNKNOWN`으로 막는다 — 그 관문은 옳다.
    const flatPositionRisk = [{
      symbol: SYMBOL, positionAmt: '0', entryPrice: '0', markPrice: '60030',
      unRealizedProfit: '0', liquidationPrice: '0', leverage: '100',
      marginType: 'isolated', isolatedMargin: '0', positionSide: 'BOTH',
    }];
    venue.on('/fapi/v2/positionRisk', { json: flatPositionRisk });
    venue.on('/fapi/v3/positionRisk', { json: flatPositionRisk });
    venue.on('/fapi/v1/openOrders', { json: [] });
    venue.on('/fapi/v1/openAlgoOrders', { json: [] });
    venue.on('/fapi/v2/balance', { json: [{ asset: 'USDT', availableBalance: '1000', balance: '1000' }] });
    venue.on('/fapi/v2/account', { json: { totalWalletBalance: '1000', availableBalance: '1000', positions: [] } });
    venue.on('/fapi/v1/exchangeInfo', { json: { symbols: [{
      symbol: SYMBOL, pricePrecision: 2, quantityPrecision: 3,
      filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
      ],
    }] } });
    // **메서드를 적는다.** `/fapi/v1/leverage`는 `/fapi/v1/leverageBracket`의
    // 앞부분이라, 메서드 없이 먼저 등록하면 브래킷 조회를 가로챈다.
    venue.on('/fapi/v1/leverage', { json: { leverage: 100, symbol: SYMBOL } }, 'POST');
    venue.on('/fapi/v1/marginType', { json: { code: 200, msg: 'success' } });
    venue.on('/fapi/v1/positionSide/dual', { json: { dualSidePosition: false } });
    venue.on('/fapi/v1/premiumIndex', { json: {
      symbol: SYMBOL, markPrice: '60030.00', indexPrice: '60029.50',
      lastFundingRate: '0.0001', nextFundingTime: opts.nowMs + 3_600_000, time: opts.nowMs,
    } });
    // 100배 진입은 **지금 값**을 요구한다. 오래된 값으로는 판정하지 않는다.
    venue.on('/fapi/v1/leverageBracket', { json: [{ symbol: SYMBOL, brackets: [
      { bracket: 1, initialLeverage: 125, notionalCap: 50000, notionalFloor: 0,
        maintMarginRatio: 0.004, cum: 0 },
    ] }] });
    venue.on('/fapi/v1/commissionRate', { json: {
      symbol: SYMBOL, makerCommissionRate: '0.000200', takerCommissionRate: '0.000400',
    } });
    venue.on('/fapi/v1/depth', { json: {
      lastUpdateId: 1, E: opts.nowMs, T: opts.nowMs,
      bids: [['60029.90', '5'], ['60029.80', '5']],
      asks: [['60030.10', '5'], ['60030.20', '5']],
    } });
    venue.on('/fapi/v1/fundingInfo', { json: [{
      symbol: SYMBOL, fundingIntervalHours: 8,
      adjustedFundingRateCap: '0.0005', adjustedFundingRateFloor: '-0.0005',
    }] });
    // 진입 전 체크리스트가 보는 것들.
    venue.on('/fapi/v1/time', { json: { serverTime: opts.nowMs } });
    venue.on('/fapi/v1/income', { json: [] });          // 손실 원장 0건
    venue.on('/api/v3/klines', { json: flatKlines(50) });
    venue.on('/fapi/v1/ticker/price', { json: { symbol: SYMBOL, price: '60030' } });
    // **중복확인(GET)과 주문전송(POST)을 메서드로 가른다.**
    //
    // 메서드를 적지 않으면 중복확인 GET에도 "주문 있음"이 돌아가고,
    // 실행기는 **올바르게** 재전송을 생략한다 — 그러면 "주문이 나갔다"를
    // 보는 시험이 주문 0건으로 초록이 된다. 실제로 그렇게 통과했었다.
    venue.on('/fapi/v1/order', { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET');
    venue.on('/fapi/v1/order', { json: {
      orderId: 777001, status: 'NEW', symbol: SYMBOL, executedQty: '0', avgPrice: '0',
      cumQuote: '0', origQty: '0.166', side: 'BUY', type: 'MARKET',
    } }, 'POST');
    // 규칙 없는 호출이 던져서 시험이 통째로 죽지 않게 한다.
    venue.on('/fapi/', { status: 400, json: { code: -1000, msg: 'unmapped in this test' } });
    venue.on('/api/', { status: 400, json: { code: -1000, msg: 'unmapped in this test' } });
    const restoreVenue = venue.install();

    const realNow = Date.now;
    Date.now = () => opts.nowMs;

    const prevServer = require.cache[serverPath];
    const prevAdmin = require.cache[adminPath];
    require.cache[serverPath] = {
      id: serverPath, filename: serverPath, loaded: true, exports: {
        getSupabaseAdmin: () => db,
        resolveUserId: async () => USER,
        getUserIdFromRequest: async () => USER,
        serviceRoleKeyRole: () => 'service_role',
      },
    } as any;
    delete require.cache[adminPath];
    delete require.cache[routePath];

    try {
      const mod = require(routePath);
      const res = await mod.POST(req({ ...BODY, ...(opts.body ?? {}) }, { 'x-admin-secret': ADMIN }));
      const json = await res.json();
      return { status: res.status, json, venue, db };
    } finally {
      Date.now = realNow;
      delete require.cache[routePath];
      delete require.cache[adminPath];
      if (prevServer) require.cache[serverPath] = prevServer; else delete require.cache[serverPath];
      if (prevAdmin) require.cache[adminPath] = prevAdmin;
      restoreVenue();
      restoreCrypto();
      if (prevSecret === undefined) delete process.env.ADMIN_SECRET;
      else process.env.ADMIN_SECRET = prevSecret;
    }
  }

  /** 오늘 창 안에 이미 난 진입 한 줄 */
  const orderInWindow = {
    id: 'o-today', user_id: USER, connection_id: CONN, symbol: SYMBOL,
    mode: 'TESTNET', reduce_only: false, status: 'FILLED',
    created_at: new Date(KST_0905 - 60_000).toISOString(),
  };

  // ── 순서대로 돌린다. 전역 시계·fetch를 바꾸므로 겹치면 안 된다 ──
  const inWindow = await hit({ nowMs: KST_0905 });
  const already = await hit({ nowMs: KST_0905, seedOrders: [orderInWindow] });
  const unreadable = await hit({ nowMs: KST_0905, failOrderSelect: true });
  const outside = await hit({ nowMs: KST_1000 });
  // ⑥ 진짜 일봉 + 신선한 캘린더 — 증거가 갖춰지면 어디까지 가는가
  // ⑥-0 **캘린더는 신선한데 일봉만 거짓인** 경우. 차단 사유가 하나로
  //      좁혀져야 "거짓 일봉이 막았다"를 증명할 수 있다.
  const badDailyOnly = await hit({ nowMs: KST_0905, goodDaily: false, calendar: true });
  const goodEvidence = await hit({ nowMs: KST_0905, goodDaily: true, calendar: true });
  // ⑦ 증거가 갖춰진 상태에서 **같은 창을 다시 두드린다** — 재시작과 같다.
  //    판단 근거가 메모리가 아니라 장부이므로 두 번째는 주문이 나가면 안 된다.
  const goodAgain = await hit({
    nowMs: KST_0905, goodDaily: true, calendar: true, seedOrders: [orderInWindow],
  });

  const sends = (r: any) => r.venue.orderSends().length;

  test('★ ① 09:00 창 안에서는 신호가 없어도 "신호 없음"으로 끝나지 않는다', () => {
    // 지금까지 매일 여기서 끝났다. 이 한 줄이 바뀐 전부다.
    eq(inWindow.json?.forcedEntry?.code, 'DUE', JSON.stringify(inWindow.json).slice(0, 400));
    assert(inWindow.json?.signal != null,
      `강제 진입이 주문 모양을 만들지 못했습니다: ${JSON.stringify(inWindow.json).slice(0, 400)}`);
  });

  test('★ ① 강제 진입이 **승인된 100배 계획**까지 간다', () => {
    // 신호 관문만 지나고 그 뒤에서 조용히 멈추면 고친 것이 아니다.
    // 수량·배율·청산가가 실제 위험 엔진에서 나와야 한다.
    eq(inWindow.json?.approved, true,
      `승인되지 않았습니다: ${inWindow.json?.rejectCode} ${String(inWindow.json?.reason ?? '').slice(0, 200)}`);
    eq(inWindow.json?.plan?.leverage, 100);
    assert(Number(inWindow.json?.plan?.quantity) > 0, JSON.stringify(inWindow.json?.plan));
    assert(Number(inWindow.json?.plan?.liquidationPrice) > 0, '청산가가 계산되지 않았습니다');
  });

  test('★ ① 남은 차단은 신호가 아니라 **위험 거부**다 (고배율 fail-closed)', () => {
    // 계획이 승인돼도 주문은 아직 나가지 않는다. 막는 것은 경제 캘린더와
    // 변동성 기준을 **확인하지 못했다**는 사실이고, 그 둘은 이 변경의
    // 범위 밖이다. 여기에 적어 두지 않으면 "09시 수정이 됐는데 왜 아직
    // 주문이 없나"를 또 처음부터 추적하게 된다.
    assert(inWindow.json?.blocked !== 'NO_SIGNAL', '여전히 신호 관문에서 막혔습니다');
    eq(sends(inWindow), 0, '위험 거부 상태에서 주문이 나갔습니다');
    assert(/위험 규칙|캘린더|변동성/.test(String(inWindow.json?.error ?? '')),
      `예상하지 못한 차단입니다: ${inWindow.json?.blocked} ${String(inWindow.json?.error ?? '').slice(0, 200)}`);
  });

  test('★ ① 강제 진입은 신호 판정을 거치지 않았다고 기록에 남는다', () => {
    const notes: string[] = inWindow.json?.signal?.notes ?? [];
    assert(notes.some(n => /강제 진입/.test(n)), notes.join(' · '));
  });

  test('★ ② 같은 창에서 이미 낸 뒤에는 주문을 보내지 않는다 (중복 실행·재시작)', () => {
    // 재시작해도 같다 — 판단 근거가 메모리가 아니라 **장부**다.
    eq(already.json?.forcedEntry?.code, 'ALREADY_TODAY');
    eq(already.json?.executed, false);
    eq(sends(already), 0, '중복 창에서 주문이 나갔습니다');
  });

  test('★ ③ 오늘 냈는지 못 읽으면 보내지 않는다 — 0건으로 접지 않는다', () => {
    eq(unreadable.json?.forcedEntry?.code, 'HISTORY_UNKNOWN');
    eq(sends(unreadable), 0, '장부를 못 읽었는데 주문이 나갔습니다');
  });

  test('★ ④ 창 밖에서는 보내지 않는다 — 지난 창을 뒤늦게 열지 않는다', () => {
    eq(outside.json?.forcedEntry?.code, 'AFTER_WINDOW');
    eq(outside.json?.executed, false);
    eq(sends(outside), 0, '창 밖에서 주문이 나갔습니다');
  });

  test('★★ ⑥ 거짓 일봉(1시간봉·멈춘 피드)으로는 변동성 관문을 통과하지 못한다', () => {
    // 재현된 결함: 20일 지난 1시간봉이 일봉 기준선 자리에 들어가 **통과**했다.
    // 이제 시각으로 확인하고, 아니면 기준선을 만들지 않는다.
    eq(inWindow.json?.dailyEvidence?.ok, false,
      JSON.stringify(inWindow.json?.dailyEvidence));
    assert(['NOT_DAILY', 'STALE', 'GAPPED', 'TOO_FEW', 'UNREADABLE']
      .includes(String(inWindow.json?.dailyEvidence?.code)),
      JSON.stringify(inWindow.json?.dailyEvidence));
    assert(/변동성|캘린더|위험 규칙/.test(String(inWindow.json?.error ?? '')),
      String(inWindow.json?.error));
    eq(sends(inWindow), 0, '거짓 일봉 위에서 주문이 나갔습니다');
  });

  test('★★★ ⑥ 캘린더가 신선해도 **거짓 일봉**만으로 진입이 막힌다', () => {
    // 캘린더를 넣어 차단 사유를 하나로 좁혔다. 여기서 통과하면
    // 20일 지난 1시간봉으로 100배 진입이 나간다는 뜻이다.
    eq(badDailyOnly.json?.dailyEvidence?.ok, false,
      JSON.stringify(badDailyOnly.json?.dailyEvidence));
    eq(badDailyOnly.json?.blocked, 'RISK_VETO',
      `${badDailyOnly.json?.blocked} · ${String(badDailyOnly.json?.error ?? '').slice(0, 250)}`);
    assert(/변동성/.test(String(badDailyOnly.json?.error ?? '')),
      `변동성이 아닌 사유로 막혔습니다: ${String(badDailyOnly.json?.error ?? '').slice(0, 250)}`);
    eq(sends(badDailyOnly), 0, '거짓 일봉 위에서 주문이 나갔습니다');
  });

  test('★★ ⑥ 진짜 일봉이면 증거가 OK로 기록된다', () => {
    eq(goodEvidence.json?.dailyEvidence?.ok, true,
      JSON.stringify(goodEvidence.json?.dailyEvidence));
    eq(goodEvidence.json?.dailyEvidence?.code, 'OK');
    assert(Number(goodEvidence.json?.dailyEvidence?.sampleCount) >= 30,
      JSON.stringify(goodEvidence.json?.dailyEvidence));
  });

  test('★★ ⑥ 증거가 갖춰지면 위험 거부를 우회하지 않고 **지나간다**', () => {
    // 관문을 끈 것이 아니다 — 같은 관문에 맞는 입력을 준 것이다.
    assert(goodEvidence.json?.blocked !== 'RISK_VETO',
      `여전히 위험 거부입니다: ${String(goodEvidence.json?.error ?? '').slice(0, 250)}`);
    eq(goodEvidence.json?.approved, true,
      `승인되지 않았습니다: ${goodEvidence.json?.rejectCode} ${String(goodEvidence.json?.reason ?? '').slice(0, 200)}`);
  });

  test('★★★ ⑥ 09:00 강제 진입이 **실제 진입 주문 1건**까지 도달한다', () => {
    // 여기가 이 PR의 끝이다. 창 판정 → 강제 신호 → 위험 엔진 → 체크리스트
    // → 위험 거부 → 주문 전송까지 **관문을 하나도 끄지 않고** 간다.
    const sent = goodEvidence.venue.orderSends();
    eq(sent.length, 1, `주문 ${sent.length}건 — 1건이어야 합니다`);
    eq(sent[0].params?.side, 'BUY');
    eq(sent[0].params?.type, 'MARKET');
    eq(String(sent[0].params?.quantity), String(goodEvidence.json?.plan?.quantity));
    eq(goodEvidence.json?.executed, true);
  });

  test('★★★ ⑥ 장부가 INTENT → SENT → ACKED 순서로 남는다', () => {
    // 보내기 **전에** 의도를 남긴다. 그 줄이 없으면 타임아웃 뒤에
    // 무엇을 보냈는지 알 방법이 없다.
    const live = goodEvidence.db.writes
      .filter((w: any) => w.table === 'live_orders' && w.patch?.status)
      .map((w: any) => w.patch.status);
    eq(live[0], 'INTENT', JSON.stringify(live));
    assert(live.includes('SENT'), JSON.stringify(live));
    assert(live.includes('ACKED'), JSON.stringify(live));
    assert(live.indexOf('INTENT') < live.indexOf('SENT'), JSON.stringify(live));
    assert(live.indexOf('SENT') < live.indexOf('ACKED'), JSON.stringify(live));
  });

  test('★★★ ⑦ 증거가 갖춰져도 같은 창 두 번째 호출은 주문을 보내지 않는다 (재시작·중복)', () => {
    // 재시작해도 같다 — 근거가 메모리가 아니라 장부다.
    eq(goodAgain.json?.forcedEntry?.code, 'ALREADY_TODAY');
    eq(sends(goodAgain), 0, '같은 창에서 두 번째 주문이 나갔습니다');
  });

  test('★ 창 판정 결과가 응답에 **값으로** 남는다', () => {
    // 문장이 아니라 코드로 남아야 화면이 "왜 안 났는지"를 틀리게 적지 않는다.
    for (const r of [inWindow, already, unreadable, outside]) {
      assert(r.json?.forcedEntry != null && typeof r.json.forcedEntry.code === 'string',
        JSON.stringify(r.json).slice(0, 200));
    }
  });
}
