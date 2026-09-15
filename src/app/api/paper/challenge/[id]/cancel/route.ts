// POST /api/paper/challenge/[id]/cancel — 사용자가 챌린지를 그만둔다
//
// **이 라우트는 돈을 만들지 않는다.**
// ───────────────────────────────────
// 잔고 UPDATE도, `paper_challenge_cashflows` INSERT도, 포지션 청산도 여기
// 없다. 하는 일은 `087`의 `paper_challenge_cancel`을 부르는 것뿐이고, 그
// 함수는 **사유를 CANCELLED로 얼리고 CLOSING으로 미는 것**만 한다.
//
// 남은 포지션의 강제청산과 마감은 이미 있는 스윕이 한다:
//
//   취소 → CLOSING(CANCELLED) → 스윕이 `closePaperPosition` → finalize → CLOSED
//
// 여기서 직접 정산하면 정산 경로가 둘이 되고, `paper_settle_close` 하나뿐인
// 회계 권위가 깨진다 — 이 저장소가 반복해서 겪은 "경로가 둘인데 한쪽만
// 고침"이다.
//
// **사유는 덮지 않는다.** 목표 달성이나 만료가 먼저 정해졌으면 409로
// 돌아온다. "취소했습니다"라고 적지 않는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { paperEventTimeNow } from '@/lib/engine/paperEventTime';
import { readChallengeId } from '@/lib/engine/paperChallengeScope';
import { challengeCancelView } from '@/lib/engine/paperChallengeApi';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const cid = readChallengeId(params?.id);
  if (!cid) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

  let row: any = null;
  try {
    const { data, error } = await (sb as any).rpc('paper_challenge_cancel', {
      p_challenge: cid,
      // **소유자를 인자로 넘긴다.** 함수 안에서 `user_id`까지 함께 보므로
      // 남의 challengeId는 NOT_FOUND가 된다 — 여기서 확인하고 저기서 안 보면
      // 언젠가 한쪽만 고쳐진다.
      p_user: uid,
      // 사건 시각은 서버가 만든다. 요청 본문에서 오는 길이 없다.
      p_event_effective_at: paperEventTimeNow(),
    });
    if (error) throw new Error(String((error as any).message ?? error));
    row = Array.isArray(data) ? data[0] : data;
  } catch (e: any) {
    // **취소됐다고 적지 않는다.** 호출이 실패한 것은 취소가 아니다.
    return NextResponse.json({
      ok: false, error: 'cancel_failed',
      message: `취소하지 못했습니다 — ${String(e?.message || e).slice(0, 160)}`,
    }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  const view = challengeCancelView(row?.code, row?.close_intent);
  return NextResponse.json({
    ok: view.ok,
    code: row?.code != null ? String(row.code) : null,
    status: row?.status != null ? String(row.status) : null,
    closeIntent: row?.close_intent != null ? String(row.close_intent) : null,
    message: view.message,
  }, { status: view.http, headers: { 'Cache-Control': 'no-store' } });
}
