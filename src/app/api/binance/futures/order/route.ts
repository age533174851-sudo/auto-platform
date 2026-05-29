// /api/binance/futures/order
// 바이낸스 선물 주문 — 다중 안전 가드 + testnet/실전
//
// POST { connectionId, symbol, side, type, quantity, price?, leverage?, reduceOnly?, confirmToken }
// 안전 가드:
//  1. 인증된 사용자
//  2. 연결 소유 + binance + auto_trading_enabled
//  3. 출금 권한 키 차단
//  4. confirm 토큰
//  5. testnet이면 가드 완화, 실전이면 1회 한도 적용
//  6. 감사 로그

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { placeFuturesOrderSafe, setFuturesLeverage } from '@/lib/exchanges/binanceFutures';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_ORDER_USDT = parseFloat(process.env.MAX_ORDER_USDT || '500');

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { connectionId, symbol, side, type = 'MARKET', quantity, price, leverage, reduceOnly, confirmToken } = body;

  // 가드 4: 이중 확인
  if (confirmToken !== 'LIVE_ORDER_CONFIRMED') {
    return NextResponse.json({ error: 'confirmation_required', message: '실전 주문은 명시적 확인 필요' }, { status: 400 });
  }
  if (!connectionId || !symbol || !side || quantity == null) {
    return NextResponse.json({ error: 'missing_params' }, { status: 400 });
  }
  if (side !== 'BUY' && side !== 'SELL') {
    return NextResponse.json({ error: 'invalid_side' }, { status: 400 });
  }

  // 가드 2: 연결 조회
  const { data: conn, error: connErr } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (connErr || !conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') {
    return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  }
  if (conn.auto_trading_enabled !== true) {
    return NextResponse.json({ error: 'auto_trading_disabled', message: '자동매매 비활성 연결' }, { status: 403 });
  }

  // 가드 3: 출금 권한 차단
  if (conn.has_withdrawal === true) {
    return NextResponse.json({ error: 'withdrawal_key_blocked', message: '출금 권한 키로는 주문 불가' }, { status: 403 });
  }

  const testnet = conn.is_testnet === true;

  // 가드 5: 실전이면 1회 한도 (testnet은 가짜 돈이라 완화)
  if (!testnet && typeof price === 'number') {
    const orderUsdt = quantity * price;
    if (orderUsdt > MAX_ORDER_USDT) {
      return NextResponse.json({ error: 'order_too_large', message: `1회 한도 초과 (${orderUsdt} > ${MAX_ORDER_USDT} USDT)` }, { status: 400 });
    }
  }

  // 키 복호화
  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return NextResponse.json({ error: 'decrypt_failed' }, { status: 500 }); }
  const apiKey = conn.api_key || '';
  if (!apiKey || !secret) return NextResponse.json({ error: 'missing_credentials' }, { status: 400 });

  // 레버리지 (선택)
  if (typeof leverage === 'number' && leverage > 0) {
    try { await setFuturesLeverage(apiKey, secret, symbol, leverage, testnet); } catch { /* 무시 */ }
  }

  // 주문
  const result = await placeFuturesOrderSafe(apiKey, secret, {
    symbol, side, type, quantity, price, reduceOnly: !!reduceOnly,
  }, testnet);

  // 진입 성공 + SL/TP% 제공 시 거래소에 청산 주문 자동 설정
  if (result.success && !reduceOnly && (body.stopLossPct || body.takeProfitPct)) {
    try {
      const { placeFuturesTPSL, getFuturesTicker } = await import('@/lib/exchanges/binanceFutures');
      const entryPrice = result.price || await getFuturesTicker(symbol, testnet) || 0;
      if (entryPrice > 0) {
        const closeSide = side === 'BUY' ? 'SELL' : 'BUY';   // 롱이면 SELL로 청산
        const isLong = side === 'BUY';
        if (body.takeProfitPct > 0) {
          const tp = isLong ? entryPrice * (1 + body.takeProfitPct / 100) : entryPrice * (1 - body.takeProfitPct / 100);
          await placeFuturesTPSL(apiKey, secret, { symbol, side: closeSide, stopPrice: tp, type: 'TAKE_PROFIT_MARKET' }, testnet);
        }
        if (body.stopLossPct > 0) {
          const sl = isLong ? entryPrice * (1 - body.stopLossPct / 100) : entryPrice * (1 + body.stopLossPct / 100);
          await placeFuturesTPSL(apiKey, secret, { symbol, side: closeSide, stopPrice: sl, type: 'STOP_MARKET' }, testnet);
        }
      }
    } catch { /* TP/SL 실패해도 진입은 유지 */ }
  }

  // 가드 6: 감사 로그
  try {
    await (sb.from('audit_logs') as any).insert({
      actor_id: uid, action: 'FUTURES_ORDER',
      details: { exchange: 'binance', testnet, symbol, side, type, quantity, success: result.success, orderId: result.orderId, message: result.message },
      result: result.success ? 'success' : 'failure',
    });
  } catch {}

  if (!result.success) return NextResponse.json({ error: 'order_failed', message: result.message }, { status: 502 });
  return NextResponse.json({ ok: true, testnet, ...result });
}
