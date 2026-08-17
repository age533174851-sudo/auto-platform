// /api/autotrade/smoke-test/settle
//
// **브라우저를 닫아도 여기서 닫는다.**
//
// 스모크 테스트는 "지금 진입하고 10분 뒤에 닫는다"이다. 그 10분 사이에
// 사람은 화면을 닫는다 — 실제로 그러라고 만든 기능이다. 화면 타이머로
// 닫으면 탭을 닫는 순간 100배 포지션이 그대로 남고, 그건 배관 확인이
// 아니라 사고다.
//
// 그래서 마감 시각은 DB에 있고, 24시간 도는 Fly Worker가 이 경로를
// 1분마다 부른다. GitHub 크론도 예비로 같은 경로를 부를 수 있다 —
// **둘이 같은 줄을 동시에 닫지 않게** 선점(claim)이 있다.
//
// 닫고 끝이 아니다
// ────────────────
// 청산 주문을 보낸 것과 포지션이 없어진 것은 다른 사실이고, 포지션이
// 0인 것과 조건부 주문이 0인 것도 다른 사실이다. 어제 Gate에 조건부
// 주문 4개가 쌓인 이유가 그 둘을 같이 본 것이다.
// **고아 주문이 남으면 이 테스트는 FAIL이다.**

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { closeDue } from '@/lib/smoke/smokePlan';
// **닫는 절차는 여기 없다.** 사람이 "지금 테스트 종료"를 눌러 닫는 길이
// 하나 더 생겼고, 두 곳에 절차를 두면 한쪽만 고쳐진다 — 하필 포지션을
// 닫고 보호주문을 지우는 절차다. 절차는 `settleAttempt` 하나뿐이다.
import { settleAttempt } from '@/lib/smoke/settleAttempt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isMissing = (m: any) => /does not exist|schema cache|relation/i.test(String(m));

/** 두 실행기가 같은 순간에 같은 줄을 닫지 않게 하는 유예 */
const CLAIM_TTL_MS = 120_000;

function safeEqual(a: any, b: any): boolean {
  const x = String(a ?? ''); const y = String(b ?? '');
  if (!x || !y || x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

export async function POST(req: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET || '';
  const byAdmin = !!adminSecret && safeEqual(req.headers.get('x-admin-secret'), adminSecret);

  let body: any = {};
  try { body = await req.json(); } catch { /* 워커는 본문 없이 부를 수 있다 */ }

  // 실행기가 부를 때는 admin 시크릿, 사람이 부를 때는 로그인 토큰.
  let userId: string | null = byAdmin ? (String(body?.userId || '') || null) : null;
  if (!byAdmin) {
    userId = await resolveUserId(
      req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
    if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const nowMs = Date.now();

  // ── 닫을 때가 된 줄을 고른다 ──
  //
  // **`state`와 마감 시각을 둘 다 본다.** 시각만 보면 아직 진입 중인
  // 줄이나 이미 끝난 줄까지 닫으러 간다.
  let rows: any[] = [];
  try {
    let q = (sb as any).from('smoke_tests').select('*').eq('state', 'HOLDING');
    if (userId) q = q.eq('user_id', userId);
    if (body?.id) q = q.eq('id', String(body.id));
    const { data, error } = await q.order('hold_until', { ascending: true }).limit(20);
    if (error) throw new Error(error.message);
    rows = data || [];
  } catch (e: any) {
    if (isMissing(e?.message)) {
      return NextResponse.json({
        ok: false, error: 'table_missing',
        message: 'smoke_tests 표가 없습니다 — 마이그레이션 052를 적용하세요',
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: 'query_failed', message: String(e?.message || e) }, { status: 500 });
  }

  const settled: any[] = [];
  const skipped: any[] = [];

  for (const row of rows) {
    const due = closeDue({ nowMs, state: row.state, holdUntil: row.hold_until });
    if (!due.due) { skipped.push({ id: row.id, code: due.code, reason: due.reason }); continue; }

    // ── 선점 ──
    //
    // 워커와 예비 실행기가 동시에 깨어날 수 있다. 둘이 같은 줄에
    // reduceOnly 청산을 각각 보내면 하나는 반대 방향 신규 진입이 된다.
    // **읽었을 때와 값이 같을 때만** 바꾼다(compare-and-set).
    const claimCutoff = new Date(nowMs - CLAIM_TTL_MS).toISOString();
    let claim = (sb as any).from('smoke_tests')
      .update({ settle_claimed_at: new Date(nowMs).toISOString(), state: 'CLOSING' })
      .eq('id', row.id).eq('state', 'HOLDING');
    claim = row.settle_claimed_at == null
      ? claim.is('settle_claimed_at', null)
      : claim.lt('settle_claimed_at', claimCutoff);
    const { data: claimed, error: claimErr } = await claim.select('id');

    if (claimErr) {
      // **선점 실패를 '남이 가져갔다'로 읽지 않는다.** 그러면 이 줄은
      // 아무도 안 닫는데 로그에는 정상으로 보인다.
      skipped.push({ id: row.id, code: 'CLAIM_FAILED', reason: String(claimErr.message) });
      continue;
    }
    if (!Array.isArray(claimed) || claimed.length === 0) {
      skipped.push({ id: row.id, code: 'CLAIM_LOST', reason: '다른 실행기가 이미 이 테스트를 닫고 있습니다' });
      continue;
    }

    const r = await settleAttempt(sb, row);
    settled.push({ id: r.id, symbol: r.symbol, verdict: r.verdict, reason: r.reason });
  }

  return NextResponse.json({
    ok: true, settled, skipped, checked: rows.length,
    source: byAdmin ? 'RUNNER' : 'USER',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
