// /api/exchange/order
// 실전 거래소 주문 실행 — 다중 안전 가드
//
// ⚠️ 실제 자금이 움직입니다. 모든 안전장치를 통과해야만 주문 전송.
//
// 안전 가드 (모두 통과해야 주문):
//  1. 인증된 사용자만
//  2. 연결이 본인 소유 + is_paper=false + auto_trading_enabled=true
//  3. 출금 권한 있는 키는 거부 (perm_withdrawal=true → 차단)
//  4. 1회 주문 금액 상한 (MAX_ORDER_USDT)
//  5. confirm 토큰 (이중 확인) — 클라이언트가 명시적으로 보냄
//  6. 거래소별 주문 함수 호출
//  7. 감사 로그 기록

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { placeOrderBinance } from '@/lib/exchanges/binance';
import { placeOrderGate } from '@/lib/exchanges/gate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 1회 주문 금액 상한 (USDT) — 환경변수로 조정 가능, 기본 보수적
const MAX_ORDER_USDT = parseFloat(process.env.MAX_ORDER_USDT || '500');

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // ── 가드 1: 인증 ──────────────────────────────────────────
  const uid = await resolveUserId(
    req.headers.get('authorization'),
    req.headers.get('x-user-id')
  );
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const {
    connectionId, symbol, side, type = 'MARKET',
    quantity, amount, price, confirmToken,
  } = body;

  // ── 가드 5: 이중 확인 토큰 ────────────────────────────────
  // 클라이언트는 사용자가 명시적으로 "실전 주문 실행"을 확인했을 때만 이 토큰을 보냄
  if (confirmToken !== 'LIVE_ORDER_CONFIRMED') {
    return NextResponse.json({ error: 'confirmation_required', message: '실전 주문은 명시적 확인이 필요합니다' }, { status: 400 });
  }

  if (!connectionId || !symbol || !side) {
    return NextResponse.json({ error: 'missing_params' }, { status: 400 });
  }
  if (side !== 'BUY' && side !== 'SELL') {
    return NextResponse.json({ error: 'invalid_side' }, { status: 400 });
  }

  // ── 가드 2: 연결 소유 + 실전 모드 + 자동매매 허용 ─────────
  const { data: conn, error: connErr } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();

  if (connErr || !conn) {
    return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  }
  if (conn.is_paper !== false) {
    return NextResponse.json({ error: 'paper_mode', message: '이 연결은 모의 모드입니다. 실전 주문 불가.' }, { status: 403 });
  }
  if (conn.auto_trading_enabled !== true) {
    return NextResponse.json({ error: 'auto_trading_disabled', message: '자동매매가 비활성화된 연결입니다.' }, { status: 403 });
  }

  // ── 가드 3: 출금 권한 키 거부 ─────────────────────────────
  if (conn.perm_withdrawal === true) {
    return NextResponse.json({
      error: 'withdrawal_key_blocked',
      message: '보안상 출금 권한이 있는 API 키로는 주문할 수 없습니다. 거래 전용 키를 사용하세요.',
    }, { status: 403 });
  }
  if (conn.perm_trading !== true) {
    return NextResponse.json({ error: 'no_trading_permission', message: '거래 권한이 없는 키입니다.' }, { status: 403 });
  }

  // ── 가드 4: 1회 주문 금액 상한 ────────────────────────────
  const orderUsdt = typeof amount === 'number' ? amount
    : (typeof quantity === 'number' && typeof price === 'number' ? quantity * price : 0);
  if (orderUsdt > MAX_ORDER_USDT) {
    return NextResponse.json({
      error: 'order_too_large',
      message: `1회 주문 한도 초과 (${orderUsdt} > ${MAX_ORDER_USDT} USDT). 더 작은 금액으로 분할하세요.`,
    }, { status: 400 });
  }
  if (orderUsdt <= 0 && quantity == null) {
    return NextResponse.json({ error: 'invalid_amount' }, { status: 400 });
  }

  // ── 키 복호화 ─────────────────────────────────────────────
  let secret: string;
  try {
    secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || '');
  } catch {
    return NextResponse.json({ error: 'decrypt_failed', message: 'API 시크릿 복호화 실패' }, { status: 500 });
  }
  const apiKey = conn.api_key || '';
  if (!apiKey || !secret) {
    return NextResponse.json({ error: 'missing_credentials' }, { status: 400 });
  }

  // ── 가드 6: 거래소별 주문 ─────────────────────────────────
  const exchange = String(conn.exchange || '').toLowerCase();
  let result: any;
  try {
    if (exchange === 'binance') {
      // LOT_SIZE 반올림 (수량 기반 주문일 때)
      let qty = quantity;
      if (typeof quantity === 'number' && quantity > 0) {
        try {
          const { getSpotSymbolFilters, roundSpotQty } = await import('@/lib/exchanges/binance');
          const f = await getSpotSymbolFilters(symbol);
          if (f) {
            qty = roundSpotQty(quantity, f.stepSize);
            if (qty < f.minQty) {
              return NextResponse.json({ error: 'qty_too_small', message: `주문 수량(${qty})이 최소(${f.minQty}) 미만` }, { status: 400 });
            }
          }
        } catch {}
      }
      result = await placeOrderBinance(apiKey, secret, {
        symbol, side, type,
        quantity: qty, quoteOrderQty: side === 'BUY' && type === 'MARKET' ? amount : undefined, price,
      });
    } else if (exchange === 'gate') {
      result = await placeOrderGate(apiKey, secret, {
        symbol, side, type, quantity, amount, price,
      });
    } else {
      return NextResponse.json({ error: 'unsupported_exchange', message: `${exchange} 주문은 아직 미지원 (binance/gate만)` }, { status: 400 });
    }
  } catch (e: any) {
    result = { success: false, message: e.message || 'order_error' };
  }

  // ── 가드 7: 감사 로그 ─────────────────────────────────────
  try {
    await (sb.from('audit_logs') as any).insert({
      actor_id: uid,
      action:   'LIVE_ORDER',
      details:  {
        exchange, symbol, side, type,
        amount: orderUsdt, quantity,
        success: result.success, orderId: result.orderId,
        message: result.message,
      },
      result: result.success ? 'success' : 'failure',
    });
  } catch { /* best-effort */ }

  if (!result.success) {
    return NextResponse.json({ error: 'order_failed', message: result.message }, { status: 502 });
  }

  return NextResponse.json({
    ok:      true,
    orderId: result.orderId,
    symbol:  result.symbol,
    side:    result.side,
    qty:     result.qty,
    price:   result.price,
    exchange,
  });
}
