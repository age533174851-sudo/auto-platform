// /api/autotrade/smoke-test/advance
//
// **다음 회차를 시작한다 — 계좌가 깨끗한 것이 증명됐을 때만.**
//
// 왜 별도 경로인가
// ────────────────
// 1회차는 사람이 버튼을 눌러 시작한다. 그런데 2회차는 **10분 뒤**에
// 시작해야 하고, 그때 사람은 화면을 닫고 있다. 그래서 워커가 이
// 경로를 1분마다 부른다 — 청산(`/settle`)과 같은 구조다.
//
// 무엇을 하지 않는가
// ──────────────────
// **판정을 여기서 만들지 않는다.** "다음으로 가도 되는가"는
// `advanceVerdict` 하나가 정하고, "어떻게 시작하는가"는
// `startAttempt` 하나가 정한다. 이 파일은 그 둘을 잇기만 한다.
//
// 그리고 **병렬로 열지 않는다.** 도는 회차가 하나라도 있으면
// `advanceVerdict`가 IN_PROGRESS를 준다 — 그게 순차 실행의 전부다.
// DB의 부분 유니크 인덱스가 마지막 방어선으로 한 번 더 막는다.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { advanceVerdict, runProgress, runSummary } from '@/lib/smoke/smokeRun';
import { startAttempt, type AttemptSource } from '@/lib/smoke/startAttempt';
import { attemptSummaryOf, stepPassCounts } from '@/lib/smoke/view';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isMissing = (m: any) => /does not exist|schema cache|relation/i.test(String(m));

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

  // ── 사람이 중지시키는 경우 ──
  //
  // 반복 중에 "그만"이 있어야 한다. 없으면 사용자는 예약을 지우거나
  // 거래소에서 직접 닫게 되고, 그게 더 위험하다.
  // **도는 회차는 그대로 둔다** — 열린 포지션은 워커가 마감 시각에 닫는다.
  // 여기서 멈추는 것은 '다음 회차를 더 열지 않는다'이다.
  if (body?.stop === true && body?.runId) {
    const { data, error } = await (sb as any).from('smoke_runs')
      .update({ state: 'STOPPED', reason: '사람이 중지했습니다 — 이미 열린 회차는 마감 시각에 청산됩니다',
        closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', String(body.runId)).eq('user_id', userId ?? '').eq('state', 'RUNNING').select('id');
    if (error) return NextResponse.json({ ok: false, error: 'update_failed', message: error.message }, { status: 500 });
    if (!Array.isArray(data) || data.length === 0) {
      return NextResponse.json({ ok: false, error: 'not_found',
        message: '진행 중인 그 반복 테스트를 찾지 못했습니다' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, stopped: String(body.runId),
      message: '다음 회차를 더 시작하지 않습니다 — 이미 열린 회차는 마감 시각에 청산됩니다' },
      { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 진행 중인 묶음을 본다 ──
  let runs: any[] = [];
  try {
    let q = (sb as any).from('smoke_runs').select('*').eq('state', 'RUNNING');
    if (userId) q = q.eq('user_id', userId);
    if (body?.runId) q = q.eq('id', String(body.runId));
    const { data, error } = await q.order('created_at', { ascending: true }).limit(10);
    if (error) throw new Error(error.message);
    runs = data || [];
  } catch (e: any) {
    if (isMissing(e?.message)) {
      return NextResponse.json({
        ok: false, error: 'table_missing',
        message: 'smoke_runs 표가 없습니다 — 마이그레이션 053을 적용하세요',
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: 'query_failed', message: String(e?.message || e) }, { status: 500 });
  }

  const started: any[] = [];
  const held: any[] = [];

  for (const run of runs) {
    const { data: tests } = await (sb as any).from('smoke_tests')
      .select('*').eq('run_id', run.id).order('attempt_no', { ascending: true });
    const list = Array.isArray(tests) ? tests : [];
    const summaries = list.map(attemptSummaryOf);

    const adv = advanceVerdict({
      run: {
        attempts: Number(run.attempts) || 0,
        directionMode: run.direction_mode ?? 'ALTERNATE',
        failurePolicy: run.failure_policy === 'DURABLE' ? 'DURABLE' : 'SAFE',
        firstSide: run.first_side === 'SHORT' ? 'SHORT' : 'LONG',
        state: run.state,
      },
      attempts: summaries,
    });

    // ── 끝났거나 멈춰야 하는 묶음은 여기서 닫는다 ──
    if (adv.code !== 'START_NEXT' && adv.code !== 'START_FIRST') {
      if (adv.code === 'IN_PROGRESS') {
        held.push({ runId: run.id, code: adv.code, reason: adv.reason });
        continue;
      }
      const progress = runProgress({
        total: Number(run.attempts) || 0,
        firstSide: run.first_side === 'SHORT' ? 'SHORT' : 'LONG',
        directionMode: run.direction_mode ?? 'ALTERNATE',
        attempts: summaries,
      });
      const stepPass = stepPassCounts(list);
      const summary = runSummary({
        total: Number(run.attempts) || 0, attempts: summaries, stepPass, advance: adv,
      });
      await (sb as any).from('smoke_runs').update({
        state: summary.code === 'PASS' ? 'PASS' : summary.code === 'RUNNING' ? 'RUNNING' : summary.code,
        verdict: summary.code, reason: adv.reason,
        closed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', run.id).eq('state', 'RUNNING');
      held.push({ runId: run.id, code: adv.code, reason: adv.reason,
        progress: progress.headline, verdict: summary.code });
      continue;
    }

    // ── 다음 회차를 연다 ──
    //
    // **여기까지 온 것은 직전 회차가 PASS이고 포지션 0 · 잔여 0이
    // 증명됐다는 뜻이다**(또는 내구성 모드에서 그것이 증명된 실패).
    const source: AttemptSource = byAdmin ? 'FLY_WORKER' : 'USER';
    const r = await startAttempt(sb, {
      userId: run.user_id, connectionId: run.connection_id,
      symbol: run.symbol, side: adv.nextSide!,
      marginUsd: Number(run.margin_usd), leverage: Number(run.leverage),
      holdMin: Number(run.hold_min),
      runId: run.id, attemptNo: adv.nextAttemptNo!, source,
    });
    started.push({
      runId: run.id, attemptNo: adv.nextAttemptNo, side: adv.nextSide,
      ok: r.ok, code: r.code, message: r.message,
    });

    // 시작 자체가 실패했으면 다음 주기에 `advanceVerdict`가 그 회차를
    // 보고 판정한다 — **여기서 다시 시도하지 않는다.** 모르는 상태의
    // 재시도가 중복 진입이다.
  }

  return NextResponse.json({
    ok: true, started, held, checked: runs.length,
    source: byAdmin ? 'RUNNER' : 'USER',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
