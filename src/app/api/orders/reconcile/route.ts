// /api/orders/reconcile
// 재시작 복구: SENT/UNKNOWN 상태로 남은 주문을 거래소와 대조해 상태를 확정한다.
// 서버가 죽거나 응답을 못 받은 주문이 유령으로 남지 않게 한다.
// 배포 직후·워커 시작 시 호출하는 것을 권장.
//
// ── 인증 ────────────────────────────────────────────────────────
// 이 엔드포인트는 service-role 클라이언트를 쓰므로 RLS가 적용되지 않는다.
// 예전에는 인증이 아예 없어서, 익명 호출만으로
//   1) 전 사용자의 미확정 주문 목록(심볼·방향·상태·오류메시지)이 노출되고
//   2) connectionId만 주면 그 연결의 API 키를 복호화해 거래소에 요청까지
//      나가는 상태였다. 소유권 검사도 없었다.
// 운영 도구이므로 관리자 JWT 또는 워커 시크릿을 요구한다.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { requireAdmin } from '@/lib/auth/isAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const WORKER_SECRET = process.env.ADMIN_SECRET || '';

function safeEqual(provided: string | null, expected: string): boolean {
  if (!expected || !provided) return false;   // 미설정이면 이 경로를 잠근다
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

/**
 * 누가 부를 수 있고, 무엇까지 볼 수 있는가.
 *
 * **관리자 전용은 너무 좁았다.**
 * 미확정 주문이 남으면 그 사용자의 신규 진입이 막힌다. 푸는 버튼이
 * 화면에 있는데 관리자만 누를 수 있으면, 일반 사용자는 막힌 채로
 * 아무것도 못 한다 — 관리자에게 부탁하는 것은 방법이 아니다.
 *
 * 그래서 세 갈래로 나눈다:
 *   · 워커 시크릿  → 전체 대조 (크론·배포 직후)
 *   · 관리자 JWT   → 전체 대조
 *   · 사용자 JWT   → **자기 것만.** 자기 연결만, 자기 주문만.
 *
 * scopeUserId가 있으면 그 사용자로 좁힌다. null이면 전체다.
 */
async function authorize(req: NextRequest): Promise<
  { denied: Response } | { denied: null; scopeUserId: string | null }
> {
  if (safeEqual(req.headers.get('x-admin-secret'), WORKER_SECRET)) {
    return { denied: null, scopeUserId: null };
  }

  const auth = req.headers.get('authorization');
  const guard = await requireAdmin(auth);
  if (!(guard instanceof Response)) return { denied: null, scopeUserId: null };

  // 관리자가 아니면 본인 것만. 로그인조차 아니면 거부.
  const { resolveUserId } = await import('@/lib/supabase/admin');
  const uid = await resolveUserId(auth, req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (uid) return { denied: null, scopeUserId: uid };

  return {
    denied: NextResponse.json(
      { ok: false, error: '로그인이 필요합니다 (Bearer 토큰 또는 x-admin-secret 헤더)' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    ),
  };
}

export async function GET(req: NextRequest) {
  const az = await authorize(req);
  if (az.denied) return az.denied;
  const scopeUserId = (az as any).scopeUserId as string | null;

  const url = new URL(req.url);
  const connectionId = url.searchParams.get('connectionId');
  const dryRun = url.searchParams.get('dry') === '1';

  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
    const sb = getSupabaseAdmin();
    if (!sb) {
      return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });
    }

    // 미확정 주문 목록. **관리자가 아니면 자기 것만 본다** —
    // 예전에는 전 사용자의 심볼·방향·상태·오류메시지가 한 번에 나왔다.
    let listQ = sb.from('live_orders')
      .select('id, client_order_id, symbol, side, status, mode, exchange, created_at, error_message')
      .in('status', ['SENT', 'UNKNOWN', 'INTENT']);
    if (scopeUserId) listQ = listQ.eq('user_id', scopeUserId);
    const { data: pending } = await listQ
      .order('created_at', { ascending: true })
      .limit(50);

    const list = Array.isArray(pending) ? pending : [];

    if (dryRun || !connectionId) {
      return NextResponse.json({
        ok: true, dryRun: true,
        pendingCount: list.length,
        pending: list,
        hint: connectionId ? undefined : 'connectionId를 주면 실제 대조를 수행합니다',
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // 연결 정보로 실제 대조.
    // **소유권을 확인한다.** 이게 없으면 남의 connectionId를 넣어 그
    // 사람의 API 키를 복호화하고 거래소 요청까지 나가게 할 수 있다.
    let connQ = sb.from('exchange_connections')
      .select('user_id, exchange_id, api_key, api_secret_enc, has_withdrawal, is_testnet')
      .eq('id', connectionId);
    if (scopeUserId) connQ = connQ.eq('user_id', scopeUserId);
    const { data: conn } = await connQ.maybeSingle();

    if (!conn) return NextResponse.json({ ok: false, error: '연결을 찾을 수 없거나 본인의 연결이 아닙니다' }, { status: 404 });
    if (conn.has_withdrawal) {
      return NextResponse.json({ ok: false, error: '출금 권한 키는 사용할 수 없습니다' }, { status: 403 });
    }

    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const { reconcilePendingOrders } = await import('@/lib/engine/orderExecutor');

    const ex = String(conn.exchange_id || '').toLowerCase().includes('gate') ? 'gate' : 'binance';
    const result = await reconcilePendingOrders(sb, {
      exchange: ex as 'binance' | 'gate',
      apiKey: conn.api_key,
      apiSecret: decryptSecret(conn.api_secret_enc ?? ''),
      // exchange_connections에는 mode 컬럼이 없다. 테스트넷 여부는 is_testnet이며,
      // 값이 없으면 안전한 쪽(테스트넷)으로 본다.
      testnet: conn.is_testnet !== false,
      // **누구의, 어느 연결의 주문인가.** 없으면 이 사람의 키로 모든
      // 사용자의 주문을 대조하고, 테스트넷 기록을 실전 거래소에 물어본다.
      // 관리자/워커는 전체(null), 사용자는 본인 것만.
      // 연결은 언제나 좁힌다 — 테스트넷 기록을 실전 거래소에 물어보면
      // 영영 확정되지 않고 상태 대조를 영구히 막는다.
      userId: scopeUserId ?? (conn as any).user_id ?? null,
      connectionId,
    });

    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '대조 실패' }, { status: 500 });
  }
}
