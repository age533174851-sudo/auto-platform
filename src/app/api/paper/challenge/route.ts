// /api/paper/challenge — 챌린지 만들기 · 내 챌린지 목록
//
// **밖에서 들어오는 것은 금액과 기간뿐이다.**
//
// 받지 않는 것 셋
// ───────────────
//  · **사건 시각** — `paperEventTimeNow()`가 서버에서 만든다. 요청 본문에서
//    오는 길이 없다
//  · **계좌 id** — 전용 계좌는 `paper_challenge_create`가 만들고, 그 뒤로는
//    `challengeId`로만 가리킨다
//  · **시작·종료 시각** — 받으면 유효기간을 과거로 적어 판정을 만들 수 있다.
//    시작은 언제나 서버가 정한 지금이고, 끝은 거기에 기간을 더한 값이다
//
// 돈은 여기서 만들지 않는다
// ─────────────────────────
// 계좌 INSERT도, 잔고 UPDATE도, 원장 INSERT도 이 파일에 없다. 전부
// `085`의 `paper_challenge_create` 한 트랜잭션 안에서 일어난다 — 계좌만
// 생기고 시작금이 안 들어간 상태가 생길 수 없다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { paperEventTimeNow } from '@/lib/engine/paperEventTime';
import {
  parseChallengeCreate, challengeCreateRejected, challengeEndsAt, challengeView,
} from '@/lib/engine/paperChallengeApi';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 한 번에 돌려주는 챌린지 수. 지난 기록이 늘어도 응답이 무한히 커지지 않게. */
const LIST_LIMIT = 50;

/**
 * 챌린지들의 잔고를 한 번에 읽는다.
 *
 * **못 읽은 계좌는 null로 둔다.** 0으로 채우면 화면이 "전액을 잃었다"로
 * 읽는다 — 확인하지 못한 것은 통과가 아니다.
 */
async function balancesOf(sb: any, accountIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!accountIds.length) return out;
  try {
    const { data, error } = await (sb as any).from('paper_accounts')
      .select('id, balance').in('id', accountIds);
    if (error) return out;
    for (const r of Array.isArray(data) ? data : []) {
      const v = Number(r?.balance);
      if (r?.id && Number.isFinite(v)) out.set(String(r.id), v);
    }
  } catch { /* 못 읽었다 — 비워 둔다 */ }
  return out;
}

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // **자기 것만.** `user_id`는 인증에서 온 값이고 쿼리스트링에서 오지 않는다.
  const { data, error } = await (sb as any).from('paper_challenges')
    .select('id, paper_account_id, status, close_intent, terminal_status,'
          + ' initial_equity, target_equity, failure_equity, starts_at, ends_at, closed_at')
    .eq('user_id', uid)
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);

  if (error) {
    // **못 읽은 것을 "챌린지 없음"으로 적지 않는다.** 빈 배열은 사실이 아니다.
    return NextResponse.json({
      ok: false, error: 'unreadable',
      message: '챌린지를 조회하지 못했습니다 — 챌린지가 없다는 뜻이 아닙니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  const rows = Array.isArray(data) ? data : [];
  const bal = await balancesOf(sb, rows.map((r: any) => String(r.paper_account_id)));

  return NextResponse.json({
    ok: true,
    challenges: rows.map((r: any) => challengeView(r,
      bal.has(String(r.paper_account_id)) ? bal.get(String(r.paper_account_id)) as number : null)),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const parsed = parseChallengeCreate(body);
  if (challengeCreateRejected(parsed)) {
    return NextResponse.json({
      ok: false, error: 'invalid_params', code: parsed.code, message: parsed.reason,
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  // **사건 시각이자 시작 시각.** 하나의 값에서 둘 다 나온다 — 따로 읽으면
  // 원장에 적히는 시각과 기간의 기준이 어긋난다.
  const eventAt = paperEventTimeNow();

  let row: any = null;
  try {
    const { data, error } = await (sb as any).rpc('paper_challenge_create', {
      p_user_id: uid,
      p_initial_equity: parsed.params.initialEquity,
      p_target_equity: parsed.params.targetEquity,
      p_failure_equity: parsed.params.failureEquity,
      p_starts_at: eventAt,
      p_ends_at: challengeEndsAt(eventAt, parsed.params.durationDays),
      p_event_effective_at: eventAt,
    });
    if (error) throw new Error(String((error as any).message ?? error));
    row = Array.isArray(data) ? data[0] : data;
  } catch (e: any) {
    return NextResponse.json({
      ok: false, error: 'create_failed',
      message: `챌린지를 만들지 못했습니다 — ${String(e?.message || e).slice(0, 160)}`,
    }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  if (!row?.challenge_id) {
    // **만들었다고 적지 않는다.** 결과를 못 받은 것은 성공이 아니다.
    return NextResponse.json({
      ok: false, error: 'create_unreadable',
      message: '챌린지 생성 결과를 받지 못했습니다 — 만들어졌다는 뜻이 아닙니다',
    }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  // `created:false`는 **이미 활성 챌린지가 있다**는 뜻이다. 실패가 아니라
  // "하나만 가질 수 있다"는 계약(083의 부분 유니크)의 답이다.
  const created = row.created === true;
  return NextResponse.json({
    ok: true, created,
    challengeId: String(row.challenge_id),
    status: String(row.status ?? ''),
    balance: Number.isFinite(Number(row.balance)) ? Number(row.balance) : null,
    message: created
      ? '챌린지를 시작했습니다'
      : '이미 진행 중인 챌린지가 있습니다 — 그 챌린지를 돌려줍니다',
  }, { status: created ? 200 : 409, headers: { 'Cache-Control': 'no-store' } });
}
