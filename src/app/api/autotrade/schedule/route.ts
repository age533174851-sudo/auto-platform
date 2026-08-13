// /api/autotrade/schedule — 자동매매 예약을 화면에서 켜고 끈다
//
// GET    : 내 예약 + 최근 실행 기록
// POST   : 만들거나 고친다 (같은 심볼은 한 줄)
// DELETE : 끈다 (지우지 않는다)
//
// 왜 이 라우트가 필요한가
// ───────────────────────
// 지금까지 자동매매를 켜려면 **Supabase SQL 편집기에서 INSERT를 쳐야
// 했다.** 화면에는 봇 카드가 여섯 장 있는데 그건 실행기에 연결돼 있지
// 않고, 실제로 도는 것(daily-ladder 크론)이 읽는 표에는 화면에서 줄을
// 만들 방법이 없었다.
//
// 그래서 "자동매매를 켰다"고 믿는 사람과 실제로 켜진 상태 사이에 SQL
// 한 줄이 끼어 있었다. 그 줄을 안 친 동안 크론은 돌면서 아무 일도 하지
// 않았고, 화면 어디에도 그 사실이 없었다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { leverageNote } from '@/lib/engine/leverageMath';
import { liveTradingGate } from '@/lib/engine/liveTradingGate';
import { scheduleConnState, rebindVerdict } from '@/lib/engine/schedulePlan';
import {
  resolveStrategy, runnableStrategies, strategyIdOfRow, LEGACY_STRATEGY_ID,
} from '@/lib/strategies/registry';
import { runtimeStateOf, RUNTIME_LABEL } from '@/lib/autotrade/evaluationLoop';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 표가 없을 때의 응답. '무엇을 해야 하는지'까지 적는다 */
function tableMissing(migration: string, table: string) {
  return NextResponse.json({
    ok: false, error: 'table_missing',
    message: `${table} 표가 없습니다 — 마이그레이션 ${migration}을 적용하세요`,
  }, { status: 503 });
}
const isMissing = (msg: any) => /does not exist|schema cache|relation/i.test(String(msg));

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // **strategy_id를 반드시 고른다.**
  //
  // 예전에는 이 목록에 없었다. 그런데 아래에서 `strategyIdOfRow(r)`을
  // 부르고, 그 함수는 값이 없으면 계단식으로 되돌린다 — 그래서 scalp
  // 예약을 만들어도 화면은 **언제나 '일봉 계단식'**이라고 적었다.
  // 실행기는 `select('*')`라 제대로 돌았으므로, 화면과 실제가 갈렸다.
  //
  // 050이 아직인 계정에서는 이 칸이 없어서 조회가 실패한다 —
  // 아래 OPTIONAL 되읽기가 그 이름을 빼고 다시 읽는다.
  const FULL = 'id, symbol, connection_id, mode, enabled, last_run_at, last_result, last_decision, leverage_cap, risk_pct, interval_min, margin_pct, strategy_id, strategy_version';

  let { data: rows, error } = await (sb as any)
    .from('autotrade_schedules').select(FULL).eq('user_id', uid).order('symbol');

  // **칸 하나가 없으면 이 조회가 통째로 실패한다.** 그러면 화면은
  // "예약을 읽지 못했습니다"만 띄우고, 진짜 원인(마이그레이션 미적용)은
  // 어디에도 안 나온다. 없는 칸만 빼고 다시 읽어서 화면은 살리고,
  // 무엇이 빠졌는지는 점검 목록이 말하게 한다.
  //
  // **한 번만 재시도하지 않는다.** Postgres는 모르는 칸을 만나면 첫 번째
  // 것만 이름을 대고 멈춘다. 036과 043이 둘 다 안 돌아간 계정에서
  // margin_pct만 빼고 한 번 재시도하면 last_decision 때문에 또 실패하고,
  // 화면은 여전히 죽는다. 이름이 나올 때마다 빼고, 더 이상 안 나올 때까지 돈다.
  const OPTIONAL = ['margin_pct', 'last_decision', 'strategy_id', 'strategy_version'];
  const missing: string[] = [];

  for (let i = 0; i < OPTIONAL.length && error; i++) {
    const named = OPTIONAL.find(c => !missing.includes(c) && new RegExp(c, 'i').test(String(error!.message)));
    if (!named) break;
    missing.push(named);
    const cols = FULL.split(', ').filter(c => !missing.includes(c)).join(', ');
    const retry = await (sb as any)
      .from('autotrade_schedules').select(cols).eq('user_id', uid).order('symbol');
    rows = retry.data; error = retry.error;
  }

  // **읽기가 끝내 실패했으면 '있다'고도 '없다'고도 말하지 않는다.**
  const marginColumnPresent: boolean | null = error ? null : !missing.includes('margin_pct');
  const decisionColumnPresent: boolean | null = error ? null : !missing.includes('last_decision');

  if (error) {
    if (isMissing(error.message)) return tableMissing('031', 'autotrade_schedules');
    return NextResponse.json({ ok: false, error: 'query_failed', message: error.message }, { status: 500 });
  }

  // 최근 실행 기록. **없으면 없다고 말한다** — 빈 배열과 '표가 없다'는 다르다.
  let runs: any[] = [];
  let runsError: string | null = null;
  try {
    const { data, error: e2 } = await (sb as any)
      .from('cron_runs')
      .select('job, status, detail, started_at, duration_ms')
      .eq('job', 'daily-ladder')
      .order('started_at', { ascending: false }).limit(10);
    if (e2) runsError = isMissing(e2.message) ? '크론 실행 기록 표가 없습니다 (마이그레이션 029)' : e2.message;
    else runs = data || [];
  } catch (e: any) { runsError = String(e?.message || e); }

  // ── 청산 감시도 돌고 있는가 ──
  //
  // 진입만 보고 있었다. 그런데 **포지션을 여는 것과 닫는 것은 다른
  // 크론이다.** 진입이 잘 돌아도 청산 감시가 멈춰 있으면 트레일링 손절도
  // 시간 청산도 안 되고, 그건 진입이 안 되는 것보다 나쁘다.
  // 열린 거래가 있을 때만 의미가 있으므로 그 수도 같이 센다.
  let exitRuns: any[] = [];
  let openTradeCount: number | null = null;
  try {
    const { data } = await (sb as any)
      .from('cron_runs')
      .select('job, status, detail, started_at')
      .eq('job', 'exit-monitor')
      .order('started_at', { ascending: false }).limit(5);
    exitRuns = data || [];
  } catch { /* 못 읽으면 점검이 '확인 못 함'으로 적는다 */ }
  try {
    const { data } = await (sb as any)
      .from('ladder_daily_trades')
      .select('id').eq('user_id', uid).eq('status', 'OPEN').limit(50);
    // **0건과 '못 읽음'은 다르다.** 못 읽으면 null로 남긴다.
    openTradeCount = Array.isArray(data) ? data.length : null;
  } catch { openTradeCount = null; }

  // 고를 수 있는 연결. 화면이 이 목록에서만 고르게 해야 '없는 연결 id'가
  // 저장되는 일이 없다.
  //
  // **못 읽은 것을 빈 배열로 두지 않는다.** 빈 배열이면 아래 판정이 모든
  // 예약을 '연결 없음(낡음)'으로 적고, 사용자는 멀쩡한 예약을 다시 연결한다.
  let connections: any[] | null = null;
  try {
    const { data, error: cErr } = await (sb as any)
      .from('exchange_connections')
      .select('id, exchange_id, label, is_testnet')
      .eq('user_id', uid);
    if (!cErr) {
      connections = (data || []).filter((c: any) => String(c.exchange_id).toLowerCase() !== 'kis');
    }
  } catch { /* null 그대로 — 화면이 '확인하지 못했습니다'로 적는다 */ }

  // ── 실행기가 마지막으로 온 시각 ──
  //
  // `enabled`는 `running`이 아니다. DB에 켜져 있다고 실제로 돌고 있는
  // 것이 아니다 — 실행기가 죽어 있으면 그건 '설정이 켜져 있다'일 뿐이고,
  // 화면이 그걸 '감시 중'이라고 적으면 거짓말이 된다.
  //
  // **못 읽으면 null이다.** 0이나 '정상'으로 눕히면 멈춘 실행기를 못 본다.
  const runnerLastSeenMs = (() => {
    const first = Array.isArray(runs) ? runs[0] : null;
    const t = first?.started_at ? Date.parse(String(first.started_at)) : NaN;
    return Number.isFinite(t) ? t : null;
  })();
  const nowMs = Date.now();

  // ── 주 실행기(Fly Worker)가 살아 있는가 ──
  //
  // 2026-08-13에 워커에 폴링 코드가 배포되지 않아 판단 창을 133분
  // 놓쳤다. 그때 화면은 아무것도 이상하다고 말하지 않았다.
  // **못 읽으면 null이다** — 죽었다고도 살았다고도 말하지 않는다.
  const workerLastSeenMs = await (async () => {
    try {
      const { data } = await (sb as any).from('worker_heartbeat')
        .select('last_seen, status').order('last_seen', { ascending: false }).limit(1);
      const first = Array.isArray(data) ? data[0] : null;
      if (!first || String(first.status) === 'stopped') return null;
      const t = first?.last_seen ? Date.parse(String(first.last_seen)) : NaN;
      return Number.isFinite(t) ? t : null;
    } catch { return null; }
  })();

  // ── 예약이 가리키는 연결이 아직 있는가 ──
  //
  // 연결을 다시 등록하면 id가 새로 생긴다. 예약의 id는 그대로 남고, 그
  // 연결은 더 이상 없다. 그 상태로 화면의 스위치를 누르면 **낡은 id로
  // POST가 나가서 404로 끝난다** — 켤 수도 끌 수도 없는 줄이 된다.
  // 화면에는 '연결 있음'이라고 적혀 있었다.
  const annotated = (rows || []).map((r: any) => {
    const v = scheduleConnState(r.connection_id, connections as any);
    // **어느 전략인지 화면이 알아야 한다.** 지금까지 예약 줄에는 종목만
    // 있었고, 실제로 도는 것이 계단식이라는 사실은 어디에도 없었다.
    const sid = strategyIdOfRow(r);
    const sv = resolveStrategy({
      id: sid, version: r.strategy_version,
      env: String(r.mode || '').toUpperCase().startsWith('LIVE') ? 'LIVE' : 'TESTNET',
    });
    return {
      ...r,
      connectionState: v.state, connectionNote: v.message, needsRebind: v.needsRebind,
      strategyId: sid,
      strategyName: sv.spec?.name ?? sid,
      strategyVersion: r.strategy_version ?? sv.spec?.version ?? null,
      // 이 예약이 지금 코드로 돌 수 있는가. 못 돌면 왜 못 도는지까지.
      strategyRunnable: sv.ok,
      strategyNote: sv.ok ? (sv.spec?.note ?? '') : sv.message,
      // ── 지금 실제로 어떤 상태인가 ──
      //
      // 켜짐/꺼짐만으로는 부족하다. 켜져 있는데 실행기가 안 오면 그건
      // 감시 중이 아니다. 마지막 평가 결과와 다음 평가 시각까지 함께
      // 준다 — 화면이 '다음 실행 아침 8시' 같은 없는 사실을 적지 않도록.
      runtime: runtimeStateOf({
        nowMs, enabled: r.enabled,
        lastRunAtMs: r.last_run_at,
        // 새 값(outcome)이 있으면 그것을, 없으면 옛 값(verdict)을 읽는다.
        // 옛 기록만 있는 계정에서 상태가 통째로 '확인 못 함'이 되지 않게.
        lastOutcome: r.last_decision?.outcome ?? r.last_decision?.verdict ?? null,
        lastReason: r.last_decision?.reason ?? r.last_result ?? null,
        intervalMin: r.interval_min,
        runnerLastSeenMs,
        workerLastSeenMs,
      }),
    };
  });

  return NextResponse.json({
    ok: true,
    schedules: annotated,
    runs, runsError,
    // **null이면 못 읽은 것이다.** 화면이 빈 목록과 구분해야 한다.
    connections: connections ?? [],
    connectionsReadOk: connections != null,
    // ── 고를 수 있는 전략 ──
    //
    // **실행 경로가 있는 것만 내려보낸다.** 연구 모듈을 이름만 섞어 놓으면
    // 사용자는 켰다고 믿고 아무 일도 일어나지 않는다 — 이 저장소에서 가장
    // 자주 난 고장이다. 환경별로 다르다(실행 이력이 없는 전략은 실전을 닫는다).
    strategies: {
      TESTNET: runnableStrategies('TESTNET'),
      LIVE: runnableStrategies('LIVE'),
    },
    // 크론이 실제로 인증될 수 있는가. **값은 싣지 않는다**
    adminSecretSet: !!process.env.ADMIN_SECRET,
    cronSecretSet: !!process.env.CRON_SECRET,
    // 실거래 잠금. 이게 안 풀려 있으면 실전 예약은 매일 403으로 끝난다 —
    // 그런데 화면 어디에도 그 사실이 없었다. **값이 아니라 상태만 나간다.**
    // **스위치가 켜졌다'와 '실제로 열린다'는 다르다.** Preview 배포는
    // 스위치가 켜져 있어도 막힌다. 화면이 후자를 보여야 한다.
    liveUnlocked: liveTradingGate().allowed,
    liveGate: (() => { const g = liveTradingGate(); return { env: g.env, reason: g.reason, previewOverride: g.previewOverride }; })(),
    // 마이그레이션 036이 적용됐는가. 없으면 배율이 낮게 역산된다.
    marginColumnPresent,
    // 마이그레이션 043이 적용됐는가. 없으면 화면이 판단 점수를
    // 문장에서 되짚는다 — 돌긴 돌지만 문장이 바뀌면 숫자를 잃는다.
    decisionColumnPresent,
    // 포지션을 닫아 줄 크론이 돌고 있는가 + 지금 열려 있는 거래 수
    exitRuns, openTradeCount,
    // **고정 시각을 안 내려보낸다.** 하루 1회 크론 시절의 값이라,
    // 화면이 이걸 받으면 '다음 실행 아침 8시'라는 없는 사실을 적는다.
    // 실제 다음 평가 시각은 예약마다 다르고 마지막 평가에서 계산된다.
    cronUtcHour: null,
    // ── 실행기가 살아 있는가 ──
    //
    // **못 읽었으면 null이다.** 빈 값을 '정상'으로 그리면, 멈춘 실행기
    // 위에서 예약이 켜져 있는 상태가 화면에는 정상으로 보인다.
    // 주 실행기(Fly Worker). 예비(GitHub)와 나눠서 적는다 — 어느 쪽이
    // 죽었는지 모르면 스케줄러 고장을 진단할 수 없다.
    worker: {
      lastSeenMs: workerLastSeenMs,
      lastSeenAt: workerLastSeenMs == null ? null : new Date(workerLastSeenMs).toISOString(),
      note: workerLastSeenMs == null
        ? 'Worker heartbeat를 읽지 못했습니다 — 살아 있는지 확인되지 않았습니다'
        : `${Math.round((nowMs - workerLastSeenMs) / 60_000)}분 전에 확인했습니다`,
    },
    runner: {
      lastSeenMs: runnerLastSeenMs,
      lastSeenAt: runnerLastSeenMs == null ? null : new Date(runnerLastSeenMs).toISOString(),
      note: runnerLastSeenMs == null
        ? '실행기 실행 기록을 읽지 못했습니다'
        : `${Math.round((nowMs - runnerLastSeenMs) / 60_000)}분 전에 확인했습니다`,
    },
    // 화면이 상태 배지 글자를 서버와 똑같이 쓰게 한다 — 두 곳에 적으면
    // 한쪽만 바뀌고, 그때 같은 상태가 두 이름으로 보인다.
    runtimeLabels: RUNTIME_LABEL,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const symbol = String(body?.symbol || '').toUpperCase().replace('/', '');
  const connectionId = String(body?.connectionId || '');
  const enabled = body?.enabled !== false;
  const modeRaw = String(body?.mode || 'TESTNET').toUpperCase();

  // 배율 **상한**과 1회 위험 비율. 둘 다 선택이다 — 안 주면 코드 기본값.
  //
  // '상한'이지 '배율'이 아니다. 여기에 100을 저장하고 그대로 쓰면 손절이
  // 2%인 자리에도 100배가 나가는데, 그건 진입 직후 청산이다. 상한이면
  // 역산 결과가 더 작을 때 작은 쪽이 나간다 — 안전한 쪽으로 틀린다.
  const levRaw = body?.leverageCap;
  const riskRaw = body?.riskPct;
  let leverageCap: number | null = null;
  let riskPct: number | null = null;
  if (levRaw != null && levRaw !== '') {
    const n = Math.round(Number(levRaw));
    if (!Number.isFinite(n) || n < 1 || n > 125) {
      return NextResponse.json({
        ok: false, error: 'invalid_leverage',
        message: `배율 상한은 1~125 사이여야 합니다 (입력 ${levRaw})`,
      }, { status: 400 });
    }
    leverageCap = n;
  }
  if (riskRaw != null && riskRaw !== '') {
    const n = Number(riskRaw);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      return NextResponse.json({
        ok: false, error: 'invalid_risk',
        message: `1회 위험 비율은 0보다 크고 100 이하여야 합니다 (입력 ${riskRaw})`,
      }, { status: 400 });
    }
    riskPct = n;
  }

  // 1회 증거금 비율(%). **이 값이 배율을 실제로 결정한다** —
  // 배율은 명목가 ÷ 증거금 예산으로 역산되므로, 예산을 작게 묶어야
  // 높은 배율이 나온다. "100배로 10%씩 10번"의 그 10%다.
  let marginPct: number | null = null;
  if (body?.marginPct != null && body.marginPct !== '') {
    const n = Number(body.marginPct);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      return NextResponse.json({
        ok: false, error: 'invalid_margin',
        message: `1회 증거금 비율은 0보다 크고 100 이하여야 합니다 (입력 ${body.marginPct})`,
      }, { status: 400 });
    }
    marginPct = n;
  }

  // 얼마나 자주 진입을 볼 것인가(분). 안 주면 표 기본값(하루).
  let intervalMin: number | null = null;
  if (body?.intervalMin != null && body.intervalMin !== '') {
    const n = Math.round(Number(body.intervalMin));
    if (!Number.isFinite(n) || n < 1 || n > 10080) {
      return NextResponse.json({
        ok: false, error: 'invalid_interval',
        message: `실행 간격은 1분~7일(10080분) 사이여야 합니다 (입력 ${body.intervalMin})`,
      }, { status: 400 });
    }
    intervalMin = n;
  }

  if (!symbol) return NextResponse.json({ ok: false, error: 'missing_symbol' }, { status: 400 });

  // ── 어떤 전략인가 ──
  //
  // 안 주면 계단식으로 본다 — 이 칸이 생기기 전에 만든 예약과 옛 화면이
  // 그렇다. **짐작이 아니다**: 그 줄을 읽는 실행기가 하나뿐이었다.
  // 준 값이 목록에 없으면 **막는다.** 기본 전략으로 대신 돌리면 사용자가
  // 고르지 않은 전략이 그 사람 계좌에서 돈다.
  const strategyId = String(body?.strategyId || '').trim() || LEGACY_STRATEGY_ID;
  const strategyVersionIn = body?.strategyVersion == null ? '' : String(body.strategyVersion).trim();

  // **연결이 없으면 만들지 않는다.** 연결 없는 줄은 크론이 읽어도 주문을
  // 못 내고, 화면에는 '켜짐'으로 보인다 — 가장 조용한 실패다.
  if (!connectionId) {
    return NextResponse.json({
      ok: false, error: 'missing_connection',
      message: '거래소 연결을 골라야 합니다 — 연결 없는 예약은 실행돼도 주문을 낼 수 없습니다',
    }, { status: 400 });
  }

  // 아는 값만 받는다. 오타가 실전으로 읽히면 안 된다.
  const ALLOWED = ['UI_DEMO', 'PAPER', 'TESTNET', 'SHADOW_LIVE', 'LIVE_SMALL', 'LIVE_LIMITED'];
  if (!ALLOWED.includes(modeRaw)) {
    return NextResponse.json({
      ok: false, error: 'invalid_mode',
      message: `모르는 운영 모드입니다: ${modeRaw}`, allowed: ALLOWED,
    }, { status: 400 });
  }

  // 이 연결이 정말 내 것인가. 남의 연결 id를 넣어 그 계좌로 주문이
  // 나가게 하면 안 된다.
  const { data: conn } = await (sb as any)
    .from('exchange_connections')
    .select('id, is_testnet, exchange_id')
    .eq('id', connectionId).eq('user_id', uid).maybeSingle();
  if (!conn) {
    // ── 무엇을 해야 하는지까지 적는다 ──
    //
    // 예전에는 "그 거래소 연결을 찾지 못했습니다"가 전부였다. 사용자가
    // 화면에서 고른 적이 없는 id라 어디서 온 값인지도 알 수 없었다 —
    // **예약에 저장돼 있던 낡은 id였다.** 연결을 다시 등록하면 id가
    // 새로 생기고, 예약은 옛 id를 계속 들고 있다.
    //
    // 그 상태를 여기서 구분해 준다. 지금 쓸 수 있는 연결이 무엇인지도
    // 같이 알려 주되, **대신 골라 주지는 않는다.**
    let mine: any[] = [];
    try {
      const { data } = await (sb as any)
        .from('exchange_connections')
        .select('id, exchange_id, label, is_testnet').eq('user_id', uid);
      mine = (data || []).filter((c: any) => String(c.exchange_id).toLowerCase() !== 'kis');
    } catch { /* 못 읽으면 아래에서 목록 없이 안내한다 */ }

    const { data: existing } = await (sb as any)
      .from('autotrade_schedules')
      .select('id, connection_id').eq('user_id', uid).eq('symbol', symbol).maybeSingle();
    const stale = existing && String(existing.connection_id) === connectionId;

    return NextResponse.json({
      ok: false, error: 'connection_not_found',
      // 화면이 [이 연결로 재연결] 버튼을 띄울 근거다.
      needsRebind: !!stale,
      message: stale
        ? `${symbol} 예약이 가리키는 거래소 연결이 더 이상 없습니다 — `
          + '연결을 다시 등록하면 id가 새로 생기고, 예약은 옛 id를 그대로 들고 있습니다. '
          + '화면에서 지금 쓸 연결을 고른 뒤 다시 시도하세요. 대신 골라 주지 않습니다 — '
          + '어느 계좌로 주문이 나가는지는 사용자가 정해야 합니다.'
        : '그 거래소 연결을 찾지 못했습니다',
      // 값이 아니라 고를 수 있는 것들의 이름표만 싣는다.
      availableConnections: mine.map((c: any) => ({
        id: c.id, exchange_id: c.exchange_id, label: c.label, is_testnet: c.is_testnet,
      })),
    }, { status: 404 });
  }

  // ── 명시적 재연결 ──
  //
  // 화면이 `rebind: true`로 부르면 "이 예약의 연결을 지금 고른 것으로
  // 바꾸겠다"는 뜻이다. 판정은 schedulePlan 한 곳에 있다 — 여기서 다시
  // 쓰면 화면과 서버가 다른 규칙을 갖게 된다.
  if (body?.rebind === true) {
    let mine: any[] | null = null;
    try {
      const { data, error: cErr } = await (sb as any)
        .from('exchange_connections')
        .select('id, exchange_id, label, is_testnet').eq('user_id', uid);
      if (!cErr) mine = data || [];
    } catch { /* null → 아래 판정이 '확인하지 못했다'로 막는다 */ }

    const v = rebindVerdict({ currentConnectionId: connectionId, connections: mine as any, mode: modeRaw });
    if (!v.ok) {
      return NextResponse.json({
        ok: false, error: 'rebind_rejected', code: v.code, message: v.message,
      }, { status: v.code === 'CONNECTIONS_UNKNOWN' ? 503 : 400 });
    }
  }

  // **모드와 연결이 어긋나면 막는다.**
  // is_testnet === false 만 실전이다(저장소 전체 규칙).
  const connIsLive = conn.is_testnet === false;
  const modeIsLive = modeRaw.startsWith('LIVE') || modeRaw === 'SHADOW_LIVE';
  if (modeIsLive && !connIsLive) {
    return NextResponse.json({
      ok: false, error: 'mode_conn_mismatch',
      message: '실전 모드인데 테스트넷 연결입니다 — 주문이 테스트넷으로 나갑니다',
    }, { status: 400 });
  }
  if (!modeIsLive && connIsLive) {
    // 이쪽이 훨씬 위험하다. 테스트넷인 줄 알고 켰는데 실계좌로 나간다.
    return NextResponse.json({
      ok: false, error: 'mode_conn_mismatch',
      message: `${modeRaw} 모드인데 **실전 연결**입니다 — 진짜 돈으로 주문이 나갑니다. `
        + '테스트넷 연결을 고르거나 모드를 올리세요.',
    }, { status: 400 });
  }

  // 전략 판정. **실행기까지 가기 전에 여기서 막는다** — 거기까지 가면
  // "왜 안 돌지"의 답이 실행기 로그에 묻힌다.
  const sv = resolveStrategy({
    id: strategyId, version: strategyVersionIn,
    env: modeIsLive ? 'LIVE' : 'TESTNET',
    intervalMin,
  });
  if (!sv.ok || !sv.spec) {
    return NextResponse.json({
      ok: false, error: 'strategy_rejected', code: sv.code, message: sv.message,
      // 무엇을 고를 수 있는지 같이 준다. 막기만 하면 사용자가 할 일이 없다.
      available: runnableStrategies(modeIsLive ? 'LIVE' : 'TESTNET')
        .map(x => ({ id: x.id, name: x.name, version: x.version })),
    }, { status: 400 });
  }

  // ── 배포 순서에 묶이지 않게 한다 ──
  //
  // 새 정체(user_id, strategy_id, symbol, connection_id, mode)는 마이그레이션
  // 050이 만든다. 그런데 **코드 배포와 SQL 적용이 같은 순간에 일어나지
  // 않는다.** 둘 사이에 반드시 틈이 있고, 그 틈에서 저장이 통째로 실패하면
  // 사용자는 자동매매를 켤 수 없다.
  //
  // 그래서 새 방식으로 먼저 시도하고, **050이 아직이라는 신호가 오면**
  // 옛 방식(user_id, symbol)으로 되돌아가 저장한다. 되돌아갔다는 사실은
  // 응답에 남긴다 — 조용히 옛 모양으로 저장하면 "왜 두 번째 전략이
  // 안 켜지지"의 답이 사라진다.
  const FULL_SELECT =
    'id, symbol, mode, enabled, connection_id, strategy_id, strategy_version, leverage_cap, risk_pct, interval_min';
  const LEGACY_SELECT =
    'id, symbol, mode, enabled, connection_id, leverage_cap, risk_pct, interval_min';

  const baseRow: Record<string, any> = {
    user_id: uid, symbol, connection_id: connectionId,
    mode: modeRaw, enabled, margin_pct: marginPct,
    leverage_cap: leverageCap, risk_pct: riskPct,
    ...(intervalMin != null ? { interval_min: intervalMin } : {}),
  };

  let { data, error } = await (sb as any)
    .from('autotrade_schedules')
    .upsert({
      ...baseRow,
      strategy_id: sv.spec.id,
      // **저장할 때는 지금 코드의 버전을 적는다.** 사용자가 보낸 값을 그대로
      // 적으면 옛 버전이 영원히 남고, 다음 실행이 매번 VERSION_MISMATCH가 된다.
      strategy_version: sv.spec.version,
    }, { onConflict: 'user_id,strategy_id,symbol,connection_id,mode' })
    .select(FULL_SELECT).single();

  // 050이 아직인가. 칸이 없거나 그 이름의 제약이 없으면 그 신호다.
  const needsPhaseB = !!error && /strategy_id|strategy_version|no unique|on conflict|constraint matching/i
    .test(String(error.message));
  let phaseBPending = false;
  if (needsPhaseB) {
    phaseBPending = true;
    const retry = await (sb as any)
      .from('autotrade_schedules')
      .upsert(baseRow, { onConflict: 'user_id,symbol' })
      .select(LEGACY_SELECT).single();
    data = retry.data; error = retry.error;
  }

  if (error) {
    if (isMissing(error.message)) return tableMissing('031', 'autotrade_schedules');
    return NextResponse.json({ ok: false, error: 'upsert_failed', message: error.message }, { status: 500 });
  }

  // ── 켠 직후 첫 평가 ────────────────────────────────────
  //
  // 예전에는 스위치를 켜면 DB에 `enabled=true`만 적히고 **아무 일도
  // 일어나지 않았다.** 실행기가 오기까지 최대 15분 동안 화면에는 근거가
  // 없고, 사용자는 "켰는데 왜 아무것도 안 하지"로 스위치를 껐다 켰다 한다.
  //
  // 그래서 여기서 한 번 평가한다. **실행기와 같은 함수를 쓴다** —
  // 여기서 따로 실행기를 부르면 첫 평가와 그 뒤 평가가 서로 다른 검사를
  // 받게 되고, 그때 한쪽만 고쳐진다.
  //
  // 두 번 눌러도 두 번 돌지 않는다: `dueCheck`의 최소 간격(60초)이
  // 막는다. **평가가 두 번 도는 것은 주문이 두 번 나가는 것과 같다.**
  let firstEvaluation: any = null;
  if (enabled && data?.id) {
    const adminSecret = process.env.ADMIN_SECRET || '';
    if (!adminSecret) {
      // 값이 아니라 없다는 사실만 적는다.
      firstEvaluation = { ran: false, outcome: null,
        note: 'ADMIN_SECRET이 없어 첫 평가를 부를 수 없습니다 — 실행기가 주기적으로 확인합니다' };
    } else {
      try {
        const { evaluateIfDue } = await import('@/lib/autotrade/evaluationRunner');
        const origin = new URL(req.url).origin;
        // 방금 저장한 줄을 그대로 쓴다. `last_run_at`은 upsert가 건드리지
        // 않으므로 예전 값 그대로이고, 그게 중복 방지의 근거다.
        const { data: fresh } = await (sb as any)
          .from('autotrade_schedules')
          .select('id, user_id, symbol, connection_id, mode, enabled, last_run_at, interval_min, leverage_cap, risk_pct, margin_pct')
          .eq('id', data.id).maybeSingle();
        const row = { ...(fresh || {}), ...data, user_id: uid, strategy_version: sv.spec.version };
        const r = await evaluateIfDue(sb, row as any, {
          origin, adminSecret,
          // 화면이 기다리는 시간이다. 넘어가면 평가는 서버에서 계속
          // 진행될 수 있으므로 **실패라고 적지 않는다.**
          timeoutMs: 25_000,
        }, Date.now());
        firstEvaluation = r.record
          ? { ran: true, outcome: r.record.outcome, summary: r.record.summary,
              executed: r.record.executed, strategyId: r.record.strategyId,
              ...(r.saveError ? { saveError: r.saveError } : {}) }
          : { ran: false, outcome: null, code: r.due.code, note: r.due.reason };
      } catch (e: any) {
        // 첫 평가 실패가 예약 저장을 되돌리지는 않는다. 예약은 이미
        // 저장됐고 실행기가 주기적으로 본다 — 그 사실을 적는다.
        firstEvaluation = { ran: false, outcome: null,
          note: `첫 평가를 부르지 못했습니다 — ${e?.message || e}. 예약은 저장됐고 실행기가 주기적으로 확인합니다` };
      }
    }
  }

  return NextResponse.json({
    ok: true, schedule: data,
    // **켠 직후 무슨 일이 있었는지 화면이 바로 말할 수 있어야 한다.**
    // outcome은 ENTERED · NO_SIGNAL · BLOCKED · FAILED 중 하나이고,
    // NO_SIGNAL은 **정상이다** — 조건이 안 맞았을 뿐이다.
    firstEvaluation,
    // ── 고정 시각을 적지 않는다 ──
    //
    // 예전에는 '다음 실행은 매일 23:00 UTC(한국 08:00)'라고 적었다.
    // **사실이 아니다.** 그 문구는 vercel.json 크론(하루 1회) 시절 것이고,
    // 지금 실행기는 주기적으로 예약을 확인한다. 그래서 켠 직후 화면은
    // 아침 8시를 가리키는데 실제로는 몇 분 뒤에 첫 평가가 돈다 —
    // 사용자는 그 사이를 '고장'으로 읽는다.
    //
    // 그리고 '실행'이 아니라 **'평가'**다. 주기가 와도 조건이 안 맞으면
    // 주문하지 않는 것이 정상이다. '실행'이라고 적으면 주기마다 주문이
    // 나가는 기능으로 읽힌다.
    message: enabled
      ? `${symbol} · ${sv.spec.name} 자동매매 시작됨`
        + (leverageCap ? ` · 배율 상한 ${leverageCap}배` : '')
        + (riskPct ? ` · 1회 위험 ${riskPct}%` : '')
        + ' — 서버 실행기가 주기적으로 조건을 평가합니다'
      : `${symbol} · ${sv.spec.name} 자동매매를 껐습니다`,
    strategy: { id: sv.spec.id, name: sv.spec.name, version: sv.spec.version },
    // **되돌아갔으면 그렇게 말한다.** 이 값이 true면 저장은 됐지만 전략
    // 칸이 비어 있고, 같은 종목에 두 번째 전략을 켤 수 없다.
    phaseBPending,
    ...(phaseBPending ? {
      warning: '마이그레이션 050(PHASE B)이 아직 적용되지 않아 옛 방식으로 저장했습니다 — '
        + '전략 구분 없이 종목당 한 줄입니다. supabase/migrations/RUN_PHASE_B_strategy.sql을 '
        + '실행하면 같은 종목에 여러 전략을 켤 수 있습니다',
    } : {}),
    // **상한이지 목표가 아니다.** 손절이 넓으면 역산 결과가 더 작게 나오고,
    // 그때는 작은 쪽이 나간다. 화면이 이걸 '100배로 나간다'로 읽으면 안 된다.
    // 식은 leverageMath 한 곳에만 둔다. 여기 있던 숫자는 1회 증거금
    // 칸이 생기기 전의 식이라, 증거금 10%에서는 네 배 틀렸다.
    leverageNote: leverageCap ? leverageNote(leverageCap, riskPct, marginPct) : null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function DELETE(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const id = new URL(req.url).searchParams.get('id') || '';
  if (!id) return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 });

  // 지우지 않고 끈다. 지우면 '켠 적 없다'와 '껐다'가 같아진다.
  const { error } = await (sb as any)
    .from('autotrade_schedules')
    .update({ enabled: false }).eq('id', id).eq('user_id', uid);
  if (error) {
    return NextResponse.json({ ok: false, error: 'update_failed', message: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
