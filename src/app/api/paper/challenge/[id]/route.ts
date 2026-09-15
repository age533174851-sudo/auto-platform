// GET /api/paper/challenge/[id] — 챌린지 하나 조회
//
// **남의 챌린지는 없는 것과 같은 답을 받는다.** 소유자가 아니면 404이고,
// "권한이 없습니다"라고 말하지 않는다 — 그 말 자체가 존재를 알려 준다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { readChallengeId } from '@/lib/engine/paperChallengeScope';
import { challengeView } from '@/lib/engine/paperChallengeApi';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const cid = readChallengeId(params?.id);
  if (!cid) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

  const { data, error } = await (sb as any).from('paper_challenges')
    .select('id, paper_account_id, status, close_intent, terminal_status,'
          + ' initial_equity, target_equity, failure_equity, starts_at, ends_at, closed_at')
    .eq('id', cid).eq('user_id', uid).maybeSingle();

  if (error) {
    // **못 읽은 것을 "없다"로 적지 않는다.**
    return NextResponse.json({
      ok: false, error: 'unreadable',
      message: '챌린지를 조회하지 못했습니다 — 없다는 뜻이 아닙니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!data?.id) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  let balance: number | null = null;
  try {
    const { data: acct } = await (sb as any).from('paper_accounts')
      .select('balance').eq('id', data.paper_account_id).maybeSingle();
    const v = Number(acct?.balance);
    balance = Number.isFinite(v) ? v : null;   // 못 읽으면 null — 0으로 적지 않는다
  } catch { balance = null; }

  return NextResponse.json({
    ok: true, challenge: challengeView(data, balance),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
