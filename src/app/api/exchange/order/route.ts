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
import { killSwitchGate } from '@/lib/risk/killSwitch';
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
    req.headers.get('x-user-id'),
    req.headers.get('x-dev-token')
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

  // ── 가드 3.5: 킬 스위치 ───────────────────────────────────
  //
  // **여기 없었다.** 이 라우트는 `AutoTradeEngine`이 실주문을 낼 때
  // 부르는 곳인데, 킬스위치를 아무도 물어보지 않았다. 사용자가 계좌를
  // 지키려고 킬스위치를 켜도 자동매매는 계속 주문을 냈다.
  //
  // 킬스위치가 일곱 경로 중 둘에서만 돌면, 그건 없는 것보다 나쁘다 —
  // 사용자는 다 멈춘 줄 알고 화면을 닫는다.
  const ksg = await killSwitchGate(sb, connectionId);
  if (!ksg.allowed) {
    return NextResponse.json({ error: ksg.error, message: ksg.message }, { status: ksg.status });
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
  const testnet = conn.is_testnet === true;
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
          const f = await getSpotSymbolFilters(symbol, testnet);
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
        quantity: qty, quoteOrderQty: side === 'BUY' && type === 'MARKET' ? amount : undefined, price, testnet,
      });
    } else if (exchange === 'gate') {
      // **testnet을 반드시 넘긴다.** 여기서 빠져 있었다 — 위에서 값을
      // 계산해 두고 바이낸스 갈래에만 넘겼다. 그래서 테스트넷으로 등록한
      // Gate 연결의 주문이 실계좌로 나갔다. 화면에는 '테스트넷'이라고
      // 적힌 채로.
      result = await placeOrderGate(apiKey, secret, {
        symbol, side, type, quantity, amount, price,
      }, testnet);
    } else {
      return NextResponse.json({ error: 'unsupported_exchange', message: `${exchange} 주문은 아직 미지원 (binance/gate만)` }, { status: 400 });
    }
  } catch (e: any) {
    result = { success: false, message: e.message || 'order_error' };
  }

  // ── 가드 7: 감사 로그 ─────────────────────────────────────
  // ── 실거래 주문은 반드시 기록에 남는다 ──
  //
  // **`audit_logs`는 마이그레이션 파이프라인에 없는 표다.** 여기 쓰던
  // `result` 칸은 `supabase/schema.sql`의 정의에도 없다. 그런데 이
  // 호출은 `try { } catch { }`로 감싸여 있어서, 실패해도 아무 흔적이
  // 남지 않는다 — **실거래 주문이 감사에서 조용히 빠진다.**
  //
  // 실제로 적용되는 표는 040의 `audit_events`이고, `recordAudit`이
  // 시크릿 걸러내기까지 한다.
  //
  // **기다린다.** await하지 않으면 서버리스는 응답을 돌려주는 순간
  // 얼어붙고, insert는 그 자리에서 잘린다 — 실거래 주문이 감사에서
  // 조용히 빠지고 **빠졌다는 사실조차 남지 않는다.**
  //
  // 그렇다고 주문을 실패시키지는 않는다. 실패하면 영수증으로 돌아오고,
  // 그 영수증을 응답에 그대로 싣는다(auditResponseField). 재시도는
  // 붙이지 않는다 — 감사 때문에 주문이 두 번 나가면 안 된다.
  const { recordCriticalAudit, auditResponseField } = await import('@/lib/safety/auditStore');
  const auditReceipt = await recordCriticalAudit(sb, {
    userId: uid, action: 'LIVE_ORDER', resource: `${exchange}:${symbol}`,
    result: result.success ? 'success' : 'failed',
    detail: {
      side, type, amount: orderUsdt, quantity,
      orderId: result.orderId, message: result.message,
    },
  });

  if (!result.success) {
    return NextResponse.json({
      error: 'order_failed', message: result.message,
      audit: auditResponseField(auditReceipt),
    }, { status: 502 });
  }

  return NextResponse.json({
    ok:      true,
    orderId: result.orderId,
    symbol:  result.symbol,
    side:    result.side,
    qty:     result.qty,
    price:   result.price,
    exchange,
    // 주문은 됐는데 기록이 안 됐을 수 있다. 그 사실을 숨기지 않는다.
    audit: auditResponseField(auditReceipt),
  });
}
