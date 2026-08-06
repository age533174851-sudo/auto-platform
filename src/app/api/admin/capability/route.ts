// /api/admin/capability
//
// **거래 권한을 SQL 없이 주고 읽는다.**
//
// 왜 필요한가
// ───────────
// 권한 표(039)를 만들고 기본값을 VIEW_ONLY로 뒀는데, **그 표에 값을 넣을
// 방법을 SQL 말고는 안 만들었다.** 그래서 마이그레이션을 실행한 순간
// 저장소 소유자 본인이 VIEW_ONLY가 됐고, 테스트넷 주문이 거래소에 닿기도
// 전에 막혔다.
//
// 이 저장소에서 계속 고쳐 온 것과 같은 모양이다 — 화면에서 못 넣는 값을
// 서버가 요구하면 그 기능은 죽은 것이다.
//
// 무엇을 지키는가
// ───────────────
//  · **클라이언트가 자기 권한을 못 올린다.** 바꾸는 사람은 토큰에서
//    나오고, 대상은 본문에서 온다. 둘을 같은 곳에서 읽으면 아무나
//    자기를 올릴 수 있다.
//  · **회원 등급이 곧 거래 권한이 되지 않는다.** 관리자는 이 화면을
//    쓸 수 있을 뿐이고, 권한은 여전히 명시적으로 부여해야 붙는다.
//  · **누가 누구를 무엇에서 무엇으로 바꿨는지 남긴다.** 권한 상승은
//    흔적이 없으면 나중에 "내가 안 올렸는데"를 가릴 수 없다.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { requireAdmin } from '@/lib/auth/isAdmin';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { capabilityOf, CAP_INFO, CAP_RANK, type TradingCapability } from '@/lib/auth/tradingCapability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function safeEqual(provided: string | null, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

/**
 * 누가 부를 수 있는가.
 *
 * 관리자 JWT 또는 운영 시크릿. **일반 사용자는 자기 것도 못 바꾼다** —
 * 바꿀 수 있으면 권한 체계가 있는 이유가 사라진다.
 */
async function authorizeAdmin(req: NextRequest): Promise<
  { denied: Response } | { denied: null; actorId: string | null }
> {
  if (safeEqual(req.headers.get('x-admin-secret'), ADMIN_SECRET)) {
    return { denied: null, actorId: null };
  }
  const auth = req.headers.get('authorization');
  const guard = await requireAdmin(auth);
  if (guard instanceof Response) return { denied: guard };
  // **바꾸는 사람은 토큰에서 나온다.** 본문에서 읽으면 아무나 자기가
  // 바꿨다고 적을 수 있고, 그러면 기록이 기록이 아니다.
  const actorId = await resolveUserId(auth, null, null);
  return { denied: null, actorId };
}

/** GET — 지금 이 사람(또는 지정한 사람)의 권한 */
export async function GET(req: NextRequest) {
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const auth = req.headers.get('authorization');
  const me = await resolveUserId(auth, null, null);
  const asked = req.nextUrl.searchParams.get('userId');

  // 남의 권한을 보려면 관리자여야 한다. 자기 것은 누구나 볼 수 있다 —
  // **왜 막혔는지 모르는 것이 지금 문제의 절반이다.**
  let target = me;
  if (asked && asked !== me) {
    const az = await authorizeAdmin(req);
    if (az.denied) return az.denied;
    target = asked;
  }
  if (!target) {
    return NextResponse.json({ ok: false, error: '로그인이 필요합니다' }, { status: 401 });
  }

  const { loadCapability } = await import('@/lib/auth/loadCapability');
  const read = await loadCapability(sb, target);
  return NextResponse.json({
    ok: true,
    userId: target,
    capability: read.capability,
    label: CAP_INFO[read.capability]?.label ?? read.capability,
    desc: CAP_INFO[read.capability]?.desc ?? '',
    known: read.known,
    installed: read.installed,
    bootstrapped: !!read.bootstrapped,
    reason: read.reason,
    // 화면이 고를 수 있는 값. 여기서 주면 화면이 목록을 따로 안 들고 있어도 된다.
    choices: Object.keys(CAP_RANK).map(k => ({
      value: k, label: CAP_INFO[k as TradingCapability]?.label ?? k,
      desc: CAP_INFO[k as TradingCapability]?.desc ?? '',
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/** POST — 권한을 준다 */
export async function POST(req: NextRequest) {
  const az = await authorizeAdmin(req);
  if (az.denied) return az.denied;
  const actorId = (az as any).actorId as string | null;

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any = {};
  try { body = await req.json(); } catch { /* 빈 본문 */ }

  const target = String(body.userId ?? '').trim();
  if (!target) {
    return NextResponse.json({ ok: false, error: 'userId가 필요합니다' }, { status: 400 });
  }
  // **모르는 값은 기본값으로 떨어진다.** 그래서 원문과 해석된 값을 둘 다
  // 돌려준다 — 오타로 VIEW_ONLY가 됐는데 성공으로 읽으면 안 된다.
  const raw = String(body.capability ?? '');
  const capability = capabilityOf(raw);
  if (raw.trim() && capability === 'VIEW_ONLY' && raw.trim().toUpperCase() !== 'VIEW_ONLY') {
    return NextResponse.json({
      ok: false, error: 'unknown_capability',
      message: `'${raw}'는 아는 권한이 아닙니다 — 오타가 권한이 되지 않도록 거부합니다`,
      choices: Object.keys(CAP_RANK),
    }, { status: 400 });
  }

  const { loadCapability } = await import('@/lib/auth/loadCapability');
  const before = await loadCapability(sb, target);

  const { error } = await (sb as any).from('trading_capabilities').upsert({
    user_id: target,
    capability,
    granted_by: actorId,
    granted_at: new Date().toISOString(),
    note: String(body.note ?? '').slice(0, 500),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });

  if (error) {
    const missing = String(error.code ?? '') === '42P01';
    return NextResponse.json({
      ok: false, error: missing ? 'table_missing' : 'write_failed',
      message: missing
        ? '거래 권한 표가 없습니다 — 마이그레이션 039_trading_capability.sql을 먼저 실행하세요'
        : error.message,
    }, { status: missing ? 409 : 500 });
  }

  // **누가 누구를 무엇에서 무엇으로.** 흔적이 없으면 나중에 가릴 수 없다.
  try {
    const { recordAudit } = await import('@/lib/safety/auditStore');
    recordAudit(sb, {
      userId: actorId, action: 'CAPABILITY_CHANGE',
      detail: `${target}: ${before.capability} → ${capability}`,
      meta: { target, from: before.capability, to: capability, note: body.note ?? '' },
    } as any);
  } catch { /* 기록 실패가 권한 부여를 되돌리지는 않는다 */ }

  return NextResponse.json({
    ok: true, userId: target,
    from: before.capability, to: capability,
    label: CAP_INFO[capability]?.label ?? capability,
    // 넓혔는가 좁혔는가. 화면이 색을 정할 때 쓴다.
    widened: (CAP_RANK[capability] ?? 0) > (CAP_RANK[before.capability] ?? 0),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
