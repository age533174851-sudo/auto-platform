// /api/autotrade/smoke-test
//
// **강제 스모크 테스트 — 지금 한 바퀴, 필요하면 열 바퀴 돌린다.**
//
// POST : 반복 묶음을 만들고 1회차를 시작한다
// GET  : 내 묶음과 회차별 진행 상태
//
// 한 번 통과한 것은 통과가 아니다
// ───────────────────────────────
// 이번에 실제로 터진 고장(수량 2배 · netting 찌꺼기 · 조건부 주문 4개 ·
// 소유권 형식 깨짐)은 전부 **두 번째 회차부터** 드러난다. 첫 회차는
// 깨끗한 계좌에서 시작하므로 무엇을 안 치웠는지 알 수가 없다.
//
// 그래서 횟수를 고를 수 있고, 특히 **LONG↔SHORT 교대**가 있다 —
// 매 회차가 반전 경로를 지나며 "이전 방향이 완전히 정리됐는가"를 묻는다.
//
// **반드시 순차다.** 10개를 동시에 내지 않는다 — ONE_WAY 계좌는
// 종목당 포지션이 하나라, 병렬로 내면 서로를 상계하고 서로의 손절을
// 발동시킨다. 그건 반복 검증이 아니라 어제 사고의 재현이다.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import {
  smokeRequestVerdict,
  HOLD_CHOICES, SMOKE_SYMBOLS, DEFAULT_HOLD_MIN, STEP_LABEL, STEP_ORDER,
} from '@/lib/smoke/smokePlan';
import {
  runRequestVerdict, sideForAttempt,
  ATTEMPT_CHOICES, MAX_ATTEMPTS, DEFAULT_ATTEMPTS,
} from '@/lib/smoke/smokeRun';
import { viewRun, viewTest } from '@/lib/smoke/view';
import { startAttempt } from '@/lib/smoke/startAttempt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isMissing = (m: any) => /does not exist|schema cache|relation/i.test(String(m));

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  // ── 1. 한 회차의 설정 ──
  const rv = smokeRequestVerdict(body);
  if (!rv.ok || !rv.request) {
    return NextResponse.json({ ok: false, error: rv.code.toLowerCase(), message: rv.message }, { status: 400 });
  }
  const { symbol, side, connectionId, marginUsd, leverage, holdMin } = rv.request;

  // ── 2. 반복 설정 ──
  const rr = runRequestVerdict(body, holdMin);
  if (!rr.ok || !rr.request) {
    return NextResponse.json({ ok: false, error: rr.code.toLowerCase(), message: rr.message }, { status: 400 });
  }
  const { attempts, directionMode, failurePolicy } = rr.request;

  // ── 3. 묶음을 만든다 ──
  //
  // **같은 종목에 묶음을 두 개 돌리지 않는다.** 부분 유니크 인덱스가
  // 막고, 여기서는 그 이유를 사람이 읽을 말로 돌려준다.
  let run: any = null;
  try {
    const { data, error } = await (sb as any).from('smoke_runs').insert({
      user_id: userId, connection_id: connectionId,
      symbol, first_side: side, direction_mode: directionMode,
      mode: 'TESTNET', margin_usd: marginUsd, leverage, hold_min: holdMin,
      attempts, failure_policy: failurePolicy, state: 'RUNNING',
      reason: rr.message,
    }).select('*').single();
    if (error) throw new Error(error.message);
    run = data;
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (isMissing(msg)) {
      return NextResponse.json({
        ok: false, error: 'table_missing',
        message: 'smoke_runs 표가 아직 없습니다 — 마이그레이션 053을 자동으로 적용하는 중입니다',
      }, { status: 503 });
    }
    if (/duplicate key|unique constraint/i.test(msg)) {
      return NextResponse.json({
        ok: false, error: 'already_running',
        message: `${symbol}에 진행 중인 반복 테스트가 이미 있습니다 — 끝나거나 중지한 뒤에 시작하세요`,
      }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: 'insert_failed', message: msg }, { status: 500 });
  }

  // ── 4. 1회차를 시작한다 ──
  //
  // **시작 절차는 한 곳뿐이다.** 2회차부터는 워커가 같은 함수를 부른다 —
  // 두 곳에 두면 한쪽만 고쳐진다.
  const first = await startAttempt(sb, {
    userId, connectionId, symbol,
    side: sideForAttempt(directionMode, 1, side) ?? side,
    marginUsd, leverage, holdMin,
    runId: run.id, attemptNo: 1, source: 'USER',
    exitPolicyId: body?.exitPolicyId ?? null,
  });

  // 1회차가 시작조차 못 했으면 묶음도 거기서 끝낸다 — 대기 중인 회차를
  // 남겨 두면 워커가 나중에 조용히 열어 버린다.
  if (!first.ok && first.code !== 'STARTED') {
    await (sb as any).from('smoke_runs').update({
      state: first.code === 'BLOCKED' || first.code === 'DUPLICATE' ? 'STOPPED' : 'FAIL',
      verdict: first.code === 'BLOCKED' ? 'BLOCKED' : first.code,
      reason: first.message, closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', run.id);
  }

  const view = await runView(sb, run.id);
  return NextResponse.json({
    ok: first.ok, run: view,
    message: first.ok
      ? `${rr.message} — 1회차 ${first.message}. **브라우저를 닫아도 됩니다**`
      : first.message,
  }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}

/** 진행 상태 */
export async function GET(req: NextRequest) {
  const userId = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let runs: any[] = [];
  let tests: any[] = [];
  let tableMissing = false;
  try {
    const { data, error } = await (sb as any).from('smoke_runs')
      .select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5);
    if (error) throw new Error(error.message);
    runs = data || [];
    const ids = runs.map((r: any) => r.id);
    if (ids.length) {
      const { data: t } = await (sb as any).from('smoke_tests')
        .select('*').in('run_id', ids).order('attempt_no', { ascending: true });
      tests = t || [];
    }
  } catch (e: any) {
    if (isMissing(e?.message)) tableMissing = true;
    else return NextResponse.json({ ok: false, error: 'query_failed', message: String(e?.message || e) }, { status: 500 });
  }

  // 묶음에 속하지 않는 옛 단독 실행도 같이 보여준다 — 053 이전 기록이다.
  let solo: any[] = [];
  if (!tableMissing) {
    try {
      const { data } = await (sb as any).from('smoke_tests')
        .select('*').eq('user_id', userId).is('run_id', null)
        .order('created_at', { ascending: false }).limit(5);
      solo = data || [];
    } catch { /* 없으면 없는 대로 */ }
  }

  return NextResponse.json({
    ok: !tableMissing,
    ...(tableMissing ? {
      error: 'table_missing',
      message: 'smoke_runs 표가 아직 없습니다 — 마이그레이션 052·053을 자동으로 적용하는 중입니다',
    } : {}),
    runs: runs.map(r => viewRun(r, tests.filter((t: any) => String(t.run_id) === String(r.id)))),
    soloTests: solo.map(viewTest),
    // 화면이 고를 것들. **서버가 정한 목록만** 쓴다.
    options: {
      symbols: SMOKE_SYMBOLS, holdChoices: HOLD_CHOICES, defaultHoldMin: DEFAULT_HOLD_MIN,
      attemptChoices: ATTEMPT_CHOICES, maxAttempts: MAX_ATTEMPTS, defaultAttempts: DEFAULT_ATTEMPTS,
      directionModes: ['LONG', 'SHORT', 'ALTERNATE'],
      failurePolicies: ['SAFE', 'DURABLE'],
      stepOrder: STEP_ORDER, stepLabels: STEP_LABEL,
    },
    note: '이 거래는 SMOKE_TEST로 따로 기록되며 전략 승률·strategy_cycles·원본 전략 손익에 섞이지 않습니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

async function runView(sb: any, runId: string) {
  const { data: run } = await sb.from('smoke_runs').select('*').eq('id', runId).maybeSingle();
  const { data: tests } = await sb.from('smoke_tests').select('*')
    .eq('run_id', runId).order('attempt_no', { ascending: true });
  return viewRun(run, tests || []);
}
