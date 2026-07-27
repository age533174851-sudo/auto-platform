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

/** 관리자 JWT 또는 워커 시크릿. 둘 다 아니면 거부한다. */
async function authorize(req: NextRequest): Promise<Response | null> {
  if (safeEqual(req.headers.get('x-admin-secret'), WORKER_SECRET)) return null;

  const guard = await requireAdmin(req.headers.get('authorization'));
  if (guard instanceof Response) {
    return NextResponse.json(
      { ok: false, error: '관리자 권한이 필요합니다 (Bearer 토큰 또는 x-admin-secret 헤더)' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const denied = await authorize(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const connectionId = url.searchParams.get('connectionId');
  const dryRun = url.searchParams.get('dry') === '1';

  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
    const sb = getSupabaseAdmin();
    if (!sb) {
      return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });
    }

    // 미확정 주문 목록
    const { data: pending } = await sb.from('live_orders')
      .select('id, client_order_id, symbol, side, status, mode, exchange, created_at, error_message')
      .in('status', ['SENT', 'UNKNOWN', 'INTENT'])
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

    // 연결 정보로 실제 대조
    const { data: conn } = await sb.from('exchange_connections')
      .select('exchange, api_key, api_secret_enc, encrypted_secret, has_withdrawal, is_testnet')
      .eq('id', connectionId).maybeSingle();

    if (!conn) return NextResponse.json({ ok: false, error: '연결을 찾을 수 없습니다' }, { status: 404 });
    if (conn.has_withdrawal) {
      return NextResponse.json({ ok: false, error: '출금 권한 키는 사용할 수 없습니다' }, { status: 403 });
    }

    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const { reconcilePendingOrders } = await import('@/lib/engine/orderExecutor');

    const ex = String(conn.exchange || '').toLowerCase().includes('gate') ? 'gate' : 'binance';
    const result = await reconcilePendingOrders(sb, {
      exchange: ex as 'binance' | 'gate',
      apiKey: conn.api_key,
      apiSecret: decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? ''),
      // exchange_connections에는 mode 컬럼이 없다. 테스트넷 여부는 is_testnet이며,
      // 값이 없으면 안전한 쪽(테스트넷)으로 본다.
      testnet: conn.is_testnet !== false,
    });

    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '대조 실패' }, { status: 500 });
  }
}
