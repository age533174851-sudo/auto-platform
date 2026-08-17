// /api/autotrade/smoke-test/cancel
//
// **"중지"가 두 가지라서 경로를 나눈다.**
//
//   intent: 'STOP_AFTER_CURRENT'  지금 회차는 원래 마감 시각까지 정상으로
//                                 끝내고, 다음 회차를 열지 않는다
//   intent: 'CANCEL_NOW'          지금 회차를 즉시 청산하고, 그 회차가
//                                 만든 SL/TP를 정확한 번호로 지우고,
//                                 거래소 재조회로 0을 확인한 뒤 끝낸다
//
// 왜 하나의 `stop: true`로 두지 않는가
// ────────────────────────────────────
// 뜻이 둘인데 이름이 하나면 **서버가 하나를 고르게 되고**, 고른 쪽이
// 사람이 생각한 쪽이라는 보장이 없다. 실제로 사람은 "지금 당장 그만"을
// 눌렀는데 서버는 "다음 회차부터 그만"을 했고, 화면은 계속 진행 중이었다.
// 그래서 **intent를 명시**하게 하고, 옛 형식과 섞어 보내면 거절한다.
//
// 브라우저를 닫아도 끝난다
// ────────────────────────
// 중지는 한 순간이 아니라 절차다. 진행 상태가 DB에 있고(CANCEL_REQUESTED →
// CLOSING → CLEANING_PROTECTION), 워커가 `resume`으로 같은 절차를 이어
// 받는다 — 탭을 닫는 순간 100배 포지션이 남으면 그건 중지가 아니다.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { stopIntentVerdict } from '@/lib/smoke/cancelRun';
import { stopAfterCurrent, cancelNow, resumeCancels } from '@/lib/smoke/cancelOps';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

  let userId: string | null = byAdmin ? (String(body?.userId || '') || null) : null;
  if (!byAdmin) {
    userId = await resolveUserId(
      req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
    if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // ── 워커가 끊긴 중지를 이어받는다 ──
  //
  // **사람 토큰으로는 못 부른다.** 남의 묶음까지 이어서 청산하는
  // 경로이므로 실행기 시크릿이 있을 때만이다.
  if (body?.resume === true) {
    if (!byAdmin) {
      return NextResponse.json({ ok: false, error: 'admin_required',
        message: 'resume은 실행기만 부를 수 있습니다' }, { status: 403 });
    }
    try {
      const results = await resumeCancels(sb, 5);
      return NextResponse.json({ ok: true, resumed: results },
        { headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: 'resume_failed', message: String(e?.message || e) },
        { status: 500 });
    }
  }

  // ── 무엇을 시켰는가 ──
  const iv = stopIntentVerdict(body);
  if (!iv.ok || !iv.intent || !iv.runId) {
    return NextResponse.json({ ok: false, error: iv.code.toLowerCase(), message: iv.message },
      { status: 400 });
  }

  const r = iv.intent === 'CANCEL_NOW'
    ? await cancelNow(sb, { runId: iv.runId, userId })
    : await stopAfterCurrent(sb, { runId: iv.runId, userId });

  return NextResponse.json({
    ok: r.ok, intent: iv.intent, code: r.code, state: r.state,
    runId: r.runId, message: r.message,
  }, { status: r.status, headers: { 'Cache-Control': 'no-store' } });
}
