// POST /api/paper/challenge-sweep — **챌린지를 끝까지 자동으로 닫는다**
//
// 무엇이 없었나
// ─────────────
// `083`이 자리를, `085`가 돈 경로를 만들었는데 `READY → RUNNING → CLOSING →
// CLOSED`를 실제로 미는 실행자가 **하나도 없었다.** `083`이 만든
// `paper_challenges_due_idx`·`paper_challenges_closing_idx`를 아무도 읽지
// 않았다. 워커가 이 경로를 1분마다 깨운다.
//
// 회계를 새로 만들지 않는다
// ─────────────────────────
// 강제청산은 **기존 `closePaperPosition()` → `paper_settle_close`**를 그대로
// 지난다. 수수료·손익 공식은 `computeClose()` 하나뿐이고, 여기에 복제하지
// 않는다. 이 경로에는 잔고 UPDATE도 원장 INSERT도 **없다.**
//
// 시세를 못 구하면 닫지 않는다
// ────────────────────────────
// 청산 감시와 같은 계약이다. 가격을 지어내지 않는다 — 못 구한 포지션은
// 그대로 두고 **몇 건인지 값으로 말한다.** 그래서 CLOSING이 여러 회차
// 남는 것은 정상이고, 그 사실이 응답에 보인다.
//
// 거래소 주문은 나가지 않는다
// ───────────────────────────
// 이 경로에는 `executeOrder`도 거래소 어댑터도 없다.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import {
  checkSweepRows, summarizeSweep, terminalMatchesFrozenIntent,
  type FinalizeOutcome, type SweepRow,
} from '@/lib/engine/paperChallengeSweep';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function safeEqual(provided: string | null, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, 'utf8'); const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export async function POST(req: NextRequest) {
  // 워커가 자기 ADMIN_SECRET으로 부른다 — **새 비밀을 만들지 않는다.**
  const admin = safeEqual(req.headers.get('x-admin-secret'), process.env.ADMIN_SECRET || '');
  const uid = admin ? null : await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!admin && !uid) {
    return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // ── ① 활성화·만료 ──
  //
  // 판정은 전부 `086` 안에 있다. 여기서 다시 계산하지 않는다 —
  // 같은 판단이 두 곳에 있으면 그 차이가 곧 만료 race다.
  let sweepRows: SweepRow[] = [];
  try {
    const { data, error } = await (sb as any).rpc('paper_challenge_sweep_due');
    if (error) throw new Error(String((error as any).message ?? error));
    sweepRows = (Array.isArray(data) ? data : []).map((r: any) => ({
      challenge: String(r?.challenge ?? ''), account: String(r?.account ?? ''),
      owner: String(r?.owner ?? ''), action: String(r?.action ?? ''),
    }));
  } catch (e: any) {
    // **훑지 못한 것을 "밀 것이 없었다"로 적지 않는다.**
    return NextResponse.json({
      ok: false, error: 'sweep_failed',
      message: `활성화·만료를 훑지 못했습니다 (${String(e?.message || e).slice(0, 160)})`
        + ' — 밀 것이 없었다는 뜻이 아닙니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const sweep = checkSweepRows(sweepRows);

  // ── ② 정리 중인 챌린지 ──
  let closing: any[] | null = null;
  try {
    let q = (sb as any).from('paper_challenges')
      .select('id, user_id, paper_account_id, close_intent, terminal_status')
      .eq('status', 'CLOSING');
    if (uid) q = q.eq('user_id', uid);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    closing = Array.isArray(data) ? data : null;
  } catch (e: any) {
    return NextResponse.json({
      ok: false, error: 'closing_unreadable',
      message: `정리 중인 챌린지를 읽지 못했습니다 (${String(e?.message || e).slice(0, 160)})`
        + ' — 없다는 뜻이 아닙니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  if (closing == null) {
    return NextResponse.json({ ok: false, error: 'closing_unreadable',
      message: '정리 중인 챌린지를 읽지 못했습니다 — 없다는 뜻이 아닙니다' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  const { closePaperPosition } = await import('@/lib/engine/paperStore');
  const finalizes: FinalizeOutcome[] = [];
  const contractBreaks: string[] = [];
  let unknownMarks = 0;
  let flattened = 0;

  for (const ch of closing) {
    const acct = String(ch?.paper_account_id ?? '');
    if (!acct) continue;

    // ── 열린 포지션 ──
    let rows: any[] | null = null;
    try {
      const { data, error } = await (sb as any).from('paper_positions')
        .select('id, symbol')
        .eq('paper_account_id', acct).eq('status', 'open');
      if (error) throw new Error(error.message);
      rows = Array.isArray(data) ? data : null;
    } catch {
      rows = null;
    }
    if (rows == null) {
      // **읽지 못한 것을 "포지션 없음"으로 읽지 않는다.** 마감으로 넘어가면
      // `086`이 다시 세지만, 여기서 0으로 적으면 보고가 거짓이 된다.
      finalizes.push({ challenge: String(ch.id), code: 'POSITIONS_UNREADABLE', openCount: null });
      continue;
    }

    // ── 시세 ── 못 구한 심볼은 지도에 넣지 않는다(청산 감시와 같은 계약).
    const symbols = Array.from(new Set(rows.map(r => String(r?.symbol ?? '')).filter(Boolean)));
    const marks = new Map<string, number>();
    await Promise.all(symbols.map(async (sym) => {
      try {
        const { getPremiumIndex } = await import('@/lib/exchanges/binanceFutures');
        const px = await getPremiumIndex(sym, false);
        const v = Number(px?.markPrice);
        if (Number.isFinite(v) && v > 0) marks.set(sym, v);
      } catch { /* 못 받으면 이번 회차에 그 포지션은 건드리지 않는다 */ }
    }));

    // ── 강제청산: **기존 회계 경로만** 지난다 ──
    for (const p of rows) {
      const mark = marks.get(String(p?.symbol ?? ''));
      if (mark == null) { unknownMarks += 1; continue; }
      const r = await closePaperPosition(sb, String(p.id), mark, 'MANUAL');
      if (r.ok) flattened += 1;
    }

    // ── 마감 ──
    try {
      const { data, error } = await (sb as any).rpc('paper_challenge_finalize', { p_challenge: ch.id });
      if (error) throw new Error(String((error as any).message ?? error));
      const row: any = Array.isArray(data) ? data[0] : data;
      finalizes.push({
        challenge: String(ch.id),
        code: String(row?.code ?? 'UNKNOWN'),
        openCount: row?.open_count == null ? null : Number(row.open_count),
      });

      // **보고하는 쪽이 스스로를 한 번 더 본다.**
      if (String(row?.code ?? '') === 'CLOSED') {
        const { data: after } = await (sb as any).from('paper_challenges')
          .select('close_intent, terminal_status').eq('id', ch.id).maybeSingle();
        if (after && !terminalMatchesFrozenIntent(after.close_intent, after.terminal_status)) {
          contractBreaks.push(
            `${ch.id}: 최종 상태가 동결된 사유의 복사가 아닙니다`
            + ` (${String(after.close_intent)} → ${String(after.terminal_status)})`);
        }
      }
    } catch (e: any) {
      finalizes.push({ challenge: String(ch.id), code: 'FINALIZE_FAILED', openCount: null });
      contractBreaks.push(`${ch.id}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }

  const summary = summarizeSweep({ sweep, finalizes, unknownMarks });

  return NextResponse.json({
    // 계약이 깨진 보고가 하나라도 있으면 초록으로 적지 않는다.
    ok: contractBreaks.length === 0 && summary.mismatched === 0,
    ...summary,
    flattened,
    rejectedRows: sweep.rejected,
    contractBreaks,
    finalizes,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
