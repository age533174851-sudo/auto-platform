// /api/binance/futures/reverse — 포지션 뒤집기 (청산 → 반대 진입)
// POST { connectionId, symbol, expectedSide, expectedQty, leverage?, stopLossPct, confirmToken }
//
// 왜 라우트를 따로 두는가
// ──────────────────────
// 화면에서 두 번 부르면 될 것 같지만 안 된다. 청산과 진입 사이에 **아무도
// 확인하지 않는 순간**이 생기기 때문이다:
//
//  · 청산 응답을 못 받았는데 진입을 보내면, 청산이 실제로는 됐든 안 됐든
//    반대 주문이 나간다. 안 됐다면 그건 뒤집기가 아니라 **양방향 포지션**이다
//  · 화면이 닫히거나 네트워크가 끊기면 청산만 되고 진입은 사라진다.
//    그 사실을 아무도 기록하지 않는다
//
// 그래서 서버가 순서를 쥔다. **청산이 끝났다는 것을 거래소에 다시 물어
// 확인한 뒤에만** 반대 진입을 보낸다. 확인하지 못하면 진입하지 않는다 —
// 결과는 '평평한 계좌 + 이유'이고, 그건 되돌릴 수 있는 상태다.
//
// 주문 자체는 이 파일이 만들지 않는다
// ───────────────────────────────────
// 두 단계 모두 **기존 수동 주문 라우트(`../order`)를 그대로 부른다.**
// 거기에 킬스위치 가드·거래 전 점검·수동 계획 검사·멱등 키·ISOLATED 강제·
// 손절 부착·UNKNOWN 처리가 전부 들어 있다. 여기서 executeOrder를 직접
// 부르면 그 관문들을 다시 적게 되고, 두 벌이 되는 순간 한쪽만 고쳐진다.
// 이 프로젝트에서 이미 여러 번 그렇게 갈렸다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadBinanceCreds } from '@/lib/exchanges/loadCreds';
import { POST as placeOrder } from '../order/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 청산이 실제로 끝났는지 거래소에 다시 묻는다. 시장가라도 즉시 반영되지는 않는다 */
const FLAT_RETRIES = 4;
const FLAT_WAIT_MS = 700;

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const auth = req.headers.get('authorization');
  const uid = await resolveUserId(auth, req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  // 뒤집기는 청산 하나 + 진입 하나다. 진입이 있으므로 확인 토큰을 요구한다.
  if (body.confirmToken !== 'LIVE_ORDER_CONFIRMED') {
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400 });
  }

  const symbol = String(body.symbol || '').toUpperCase().replace('/', '');
  const expectedSide = String(body.expectedSide || '').toUpperCase();
  if (!body.connectionId || !symbol) {
    return NextResponse.json({ error: 'missing_params' }, { status: 400 });
  }
  if (expectedSide !== 'LONG' && expectedSide !== 'SHORT') {
    return NextResponse.json({ error: 'invalid_side' }, { status: 400 });
  }

  // 진입에는 손절이 필요하다. 없으면 `../order`의 수동 계획 검사가 거부하는데,
  // 그때는 **이미 청산이 끝난 뒤**다. 보내기 전에 여기서 막는다.
  const slPct = Number(body.stopLossPct);
  if (!Number.isFinite(slPct) || slPct <= 0) {
    return NextResponse.json({
      error: 'stop_required',
      message: '손절 폭(stopLossPct)이 없으면 뒤집지 않습니다. '
             + '청산만 하고 진입이 거부되면 포지션이 사라진 채로 끝납니다.',
    }, { status: 400 });
  }

  const creds = await loadBinanceCreds(sb, uid, body.connectionId);
  if (!creds.ok) {
    return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status });
  }

  const bf = await import('@/lib/exchanges/binanceFutures');

  // ── 1) 지금 포지션이 화면이 본 것과 같은가 ──
  //
  // 화면의 값은 최대 10초 전 것이다(BottomDock 새로고침 주기). 그 사이 손절이
  // 걸렸거나 일부가 청산됐을 수 있다. 다른 수량을 뒤집으면 그건 사용자가
  // 누른 것과 다른 거래다.
  const risk = await bf.getSymbolPositionRisk(creds.key, creds.secret, symbol, creds.testnet);
  if (!risk) {
    return NextResponse.json({
      ok: false, stage: 'precheck', error: 'position_lookup_failed',
      message: '포지션을 확인하지 못해 아무것도 하지 않았습니다.',
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }

  const qty = Math.abs(Number(risk.positionAmt) || 0);
  const side = risk.positionAmt > 0 ? 'LONG' : risk.positionAmt < 0 ? 'SHORT' : null;
  if (!qty || !side) {
    return NextResponse.json({
      ok: false, stage: 'precheck', error: 'no_position',
      message: `${symbol} 포지션이 없습니다. 뒤집을 것이 없습니다.`,
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  if (side !== expectedSide) {
    return NextResponse.json({
      ok: false, stage: 'precheck', error: 'side_changed',
      message: `방향이 바뀌었습니다 — 화면 ${expectedSide}, 실제 ${side}. 새로고침 후 다시 하세요.`,
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }
  // 수량은 조금 달라질 수 있다(수수료·부분 체결). 5% 넘게 다르면 다른 거래다.
  const expQty = Number(body.expectedQty);
  if (Number.isFinite(expQty) && expQty > 0 && Math.abs(qty - expQty) / expQty > 0.05) {
    return NextResponse.json({
      ok: false, stage: 'precheck', error: 'qty_changed',
      message: `수량이 바뀌었습니다 — 화면 ${expQty}, 실제 ${qty}. 새로고침 후 다시 하세요.`,
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  const leverage = Number(body.leverage ?? risk.leverage ?? 0) || null;

  // `../order`를 부르기 위한 요청을 만든다. 인증 헤더를 그대로 넘긴다 —
  // 그쪽이 스스로 다시 확인하므로 이 라우트가 권한을 대신 주지 않는다.
  const callOrder = async (payload: Record<string, any>) => {
    const inner = new NextRequest(new URL('/api/binance/futures/order', req.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: auth } : {}),
        ...(req.headers.get('x-user-id') ? { 'x-user-id': req.headers.get('x-user-id') as string } : {}),
        ...(req.headers.get('x-dev-token') ? { 'x-dev-token': req.headers.get('x-dev-token') as string } : {}),
      },
      body: JSON.stringify({ ...payload, connectionId: body.connectionId, confirmToken: 'LIVE_ORDER_CONFIRMED' }),
    });
    const res = await placeOrder(inner);
    let json: any = null;
    try { json = await res.json(); } catch { /* 본문 없음 */ }
    return { status: res.status, json };
  };

  // ── 2) 청산 ──
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
  const close = await callOrder({
    symbol, side: closeSide, type: 'MARKET', quantity: qty, reduceOnly: true,
  });

  if (!close.json?.ok) {
    return NextResponse.json({
      ok: false, stage: 'close', close: close.json,
      error: close.json?.error || 'close_failed',
      message: `청산에 실패해 뒤집지 않았습니다 — ${close.json?.message || '사유 미상'}`,
    }, { status: close.status || 502, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 3) 정말 평평한가 ──
  //
  // 여기가 이 라우트의 핵심이다. `ok:true`는 '주문이 접수됐다'는 뜻이지
  // '포지션이 0이다'가 아니다. 확인하지 못하면 **진입하지 않는다** —
  // 확인 못 한 것을 통과로 치면 양방향 포지션이 열린다.
  let flat = false;
  let lastQty: number | null = null;
  for (let i = 0; i < FLAT_RETRIES; i++) {
    await new Promise(r => setTimeout(r, FLAT_WAIT_MS));
    const after = await bf.getSymbolPositionRisk(creds.key, creds.secret, symbol, creds.testnet);
    if (!after) continue;                      // 조회 실패는 '0'이 아니다
    lastQty = Math.abs(Number(after.positionAmt) || 0);
    // 먼지처럼 남는 수량은 있을 수 있다. 원래의 1% 미만이면 닫힌 것으로 본다.
    if (lastQty <= qty * 0.01) { flat = true; break; }
  }

  if (!flat) {
    return NextResponse.json({
      ok: false, stage: 'verify', close: close.json,
      error: 'not_flat',
      remainingQty: lastQty,
      message: lastQty == null
        ? '청산 주문은 나갔지만 포지션을 확인하지 못해 반대 진입을 하지 않았습니다. '
          + '거래소에서 직접 확인하세요.'
        : `청산 후에도 ${lastQty}가 남아 있어 반대 진입을 하지 않았습니다. `
          + '남은 수량을 먼저 정리하세요.',
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 4) 반대 진입 ──
  //
  // 여기부터는 평범한 신규 진입이다. 거래 전 점검·손절 부착이 그대로 걸린다.
  const openSide = side === 'LONG' ? 'SELL' : 'BUY';
  const open = await callOrder({
    symbol, side: openSide, type: 'MARKET', quantity: qty,
    ...(leverage ? { leverage } : {}),
    stopLossPct: slPct,
  });

  if (!open.json?.ok) {
    return NextResponse.json({
      ok: false, stage: 'open', close: close.json, open: open.json,
      error: open.json?.error || 'open_failed',
      message: `${side} 포지션은 청산했지만 반대 진입이 거부됐습니다 — `
             + `${open.json?.message || '사유 미상'} (지금은 포지션이 없습니다)`,
    }, { status: open.status || 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const newSide = side === 'LONG' ? 'SHORT' : 'LONG';
  return NextResponse.json({
    ok: true, stage: 'done',
    from: side, to: newSide, quantity: qty, leverage,
    close: close.json, open: open.json,
    message: `${symbol} ${side} → ${newSide} ${qty} 뒤집었습니다`
           + (open.json?.slOrderId ? ' · 손절 부착' : ''),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
