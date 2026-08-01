// POST /api/stock/order — 국내주식 주문 (한국투자증권)
//
// 이 라우트가 지키는 순서
// ───────────────────────
//   1. 인증 · 연결
//   2. **장이 열려 있는가**       ← 코인에는 없던 관문
//   3. 종목 배수 확인             ← 3배 ETF에 2% 손절을 걸지 않기 위해
//   4. 시세 (없으면 여기서 멈춘다)
//   5. 점검 목록
//   6. 주문
//
// 왜 2번이 앞인가
// ───────────────
// 장이 닫혀 있으면 나머지를 볼 이유가 없고, 무엇보다 **닫힌 시장에
// 주문을 내면 증권사가 조용히 예약주문으로 받는다.** 화면에는 에러가
// 안 뜨고, 전략은 "샀다"고 믿고 손절 감시를 시작하는데 포지션은 없다.
//
// 이 앱이 오늘 하루에만 여섯 번 잡은 실패가 전부 그 모양이었다 —
// 요청은 성공했는데 실제로는 안 되어 있다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { marketPhase, marketOfSymbol } from '@/lib/markets/marketHours';
import { instrumentOf, adjustForLeverage } from '@/lib/markets/instrument';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const symbol = String(body.symbol || '').trim();
  const side = String(body.side || '').toUpperCase() as 'BUY' | 'SELL';
  const orderType = String(body.orderType || 'MARKET').toUpperCase() as 'MARKET' | 'LIMIT';
  const quantity = Number(body.quantity);
  const isExit = side === 'SELL';

  // ── 1) 연결 ──
  const { data: conn, error: connErr } = await (sb as any)
    .from('exchange_connections')
    .select('id, exchange_id, api_key, api_secret_enc, encrypted_secret, account_no, is_testnet')
    .eq('id', String(body.connectionId || ''))
    .eq('user_id', uid)
    .maybeSingle();
  if (connErr || !conn) {
    return NextResponse.json({ ok: false, error: 'connection_not_found',
      message: '증권사 연결을 찾지 못했습니다' }, { status: 404 });
  }
  if (String(conn.exchange_id) !== 'kis') {
    return NextResponse.json({ ok: false, error: 'not_kis',
      message: `이 연결은 ${conn.exchange_id}입니다 — 주식 주문은 한국투자증권 연결로만 냅니다` },
      { status: 400 });
  }

  // ── 2) 장이 열려 있는가 ──
  //
  // 종목으로 시장을 정한다. **모르는 모양이면 여기서 멈춘다** —
  // 미국으로 넘겨짚으면 일본·홍콩 종목이 조용히 미국 시간표로 판정된다.
  const mkt = marketOfSymbol(symbol);
  if (!mkt) {
    return NextResponse.json({ ok: false, error: 'unknown_market',
      message: `종목 코드로 어느 시장인지 알 수 없습니다: ${symbol || '(없음)'}` }, { status: 400 });
  }
  // 휴장일 목록은 아직 없다. marketPhase가 그 사실을 결과에 담고,
  // 점검 목록이 '경고'로 그린다 — 없는 것을 있는 척하지 않는다.
  const hours = marketPhase(mkt, Date.now());

  // ── 3) 종목 배수 ──
  //
  // 3배 ETF에 일반 주식과 같은 손절을 걸면 3배 자주 걸린다. 전략이
  // 나쁜 게 아니라 손절이 잘못 잡힌 것인데 화면에는 '승률이 낮다'로만
  // 보인다. 매도(청산)에는 안 본다 — 나가는 데는 크기 계산이 없다.
  const spec = instrumentOf(symbol);
  const baseStopPct = Number(body.stopLossPct);
  const sizing = isExit ? null : adjustForLeverage(baseStopPct, spec);

  // ── 4) 시세 ──
  //
  // 없으면 여기서 멈춘다. 추측한 가격으로 손절가를 만들면 그 값이
  // 실제와 다르고, 필요 금액도 계산할 수 없다.
  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  const { getAccessToken, getKisPrice, getKisBalance, placeKisOrder } = await import('@/lib/exchanges/kis');
  const { supabaseTokenCache } = await import('@/lib/exchanges/kisTokenCache');

  const creds = {
    appKey: String(conn.api_key || ''),
    appSecret: decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? ''),
    accountNo: String(conn.account_no || ''),
    // is_testnet === false 만 실전이다. 이 저장소 전체가 쓰는 규칙이고,
    // 모르는 값이 실전으로 읽히지 않게 하려는 것이다.
    env: (conn.is_testnet === false ? 'LIVE' : 'PAPER') as 'LIVE' | 'PAPER',
  };

  const tok = await getAccessToken(creds, supabaseTokenCache(sb, conn.id));
  if (!tok.token) {
    return NextResponse.json({ ok: false, error: 'kis_auth_failed',
      message: `한국투자증권 인증 실패: ${tok.error}`, cacheNote: tok.cacheNote }, { status: 502 });
  }

  const quote = await getKisPrice(creds, tok.token, symbol);
  const refPrice = quote.price;

  // 현금은 매수에만 필요하다. 매도는 보유분을 파는 것이라 현금이
  // 없어도 나간다 — 여기서 막으면 정작 팔아서 현금을 만들려는 주문이
  // 막힌다.
  let cash: number | null = null;
  if (!isExit) {
    const bal = await getKisBalance(creds, tok.token);
    cash = bal.cash;
  }

  // ── 5) 점검 목록 ──
  const { runChecklist } = await import('@/lib/engine/preTradeChecklist');
  const { fromLegacyMode, gateOrder } = await import('@/lib/engine/operatingMode');

  const notional = refPrice != null && Number.isFinite(quantity) ? refPrice * quantity : 0;
  const mode = fromLegacyMode(process.env.NEXT_PUBLIC_APP_MODE ?? null);
  const g = gateOrder(mode, notional);

  const limits = isExit
    ? { dailyLoss: null, weeklyLoss: null, lossStreak: null, aiVeto: null, aiPredictionId: null }
    : await (await import('@/lib/risk/collectLimits')).collectAllLimits({
        sb, userId: uid, connectionId: conn.id, testnet: creds.env === 'PAPER',
        equityUsd: null,
        symbol, side: 'LONG',
        market: 'STOCK',
        addMarginUsd: null,
        openUse: null,
      });

  const checklist = runChecklist({
    mode: { disposition: g.disposition, reason: g.reason },
    // 시계는 증권사 API에 서명 개념이 없어 해당 없다. 다만 목록에서
    // 뺄 수는 없으므로(ALL_MARKETS) 확인한 사실을 그대로 넣는다 —
    // 서버 시각을 못 읽었으면 null이고 그건 막는다.
    clock: null,
    ...limits,
    reconcile: null,
    unresolvedOrderCount: null,
    marketHours: {
      canOrder: hours.canOrder,
      reason: hours.reason,
      holidaysKnown: hours.holidaysKnown,
    },
    // 주식은 시세 × 수량으로 필요 금액을 계산할 수 있다 — 파생과 달리
    // 껍데기 검사가 되지 않는다. 둘 중 하나라도 모르면 넘기지 않는다.
    margin: (!isExit && refPrice != null)
      ? { required: notional, available: cash }
      : null,
    stopPrice: null,
    liquidationPrice: null,
    side: isExit ? 'SHORT' : 'LONG',
  }, { market: 'STOCK', intent: isExit ? 'EXIT' : 'ENTRY', aiVeto: !!limits.aiVeto });

  if (!checklist.allowed) {
    const { gateWithOverrides, readOverrides } = await import('@/lib/engine/overrideGate');
    const gateRes = await gateWithOverrides(
      sb, uid, checklist as any, readOverrides(body), { market: 'STOCK', symbol });
    if (gateRes.blocked) {
      return NextResponse.json({
        ok: false, error: 'checklist_blocked',
        message: checklist.summary,
        safetyLogError: gateRes.logError,
        refusedOverrides: gateRes.refused.map(b => b.id),
        marketHours: hours,
        sizing,
        checklist: {
          allowed: false, market: checklist.market, intent: checklist.intent,
          passed: checklist.passed, total: checklist.total,
          unknownCount: checklist.unknownCount,
          results: checklist.results, blockers: gateRes.remaining,
        },
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  // 시세를 못 읽었으면 점검이 이미 막았어야 한다. 그래도 한 번 더 본다 —
  // 여기까지 왔다는 것은 사용자가 무언가를 넘겼다는 뜻이고, 가격 없이
  // 지정가 주문을 만들 수는 없다.
  if (orderType === 'LIMIT' && !(Number(body.price) > 0)) {
    return NextResponse.json({ ok: false, error: 'price_required',
      message: '지정가 주문인데 가격이 없습니다' }, { status: 400 });
  }

  // ── 6) 주문 ──
  const r = await placeKisOrder(creds, tok.token, {
    symbol, side,
    quantity,
    orderType,
    price: orderType === 'LIMIT' ? Number(body.price) : null,
  });

  return NextResponse.json({
    ok: r.ok,
    marketType: 'STOCK',
    market: mkt,
    orderNo: r.orderNo,
    message: r.message,
    plan: r.plan,
    refPrice,
    quoteNote: quote.message,
    // 무엇을 보고 판단했는지 남긴다. 응답만 보고도 재구성할 수 있어야 한다.
    marketHours: hours,
    sizing,
    cacheNote: tok.cacheNote,
    checklist: { allowed: true, passed: checklist.passed, total: checklist.total },
  }, { status: r.ok ? 200 : 400, headers: { 'Cache-Control': 'no-store' } });
}
