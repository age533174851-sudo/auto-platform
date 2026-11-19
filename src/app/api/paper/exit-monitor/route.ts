// POST /api/paper/exit-monitor — **모의 포지션의 손절·익절을 서버가 본다**
//
// 왜 생겼나
// ─────────
// #209가 PAPER 진입을 서버로 옮겼고, 5A가 브라우저의 청산 감시를
// 걷어냈다. 그런데 **열린 `paper_positions`를 주기적으로 읽는 서버
// 실행자가 없었다** — `/api/autotrade/exit-monitor`는 거래소 포지션용이고,
// `/api/paper/run`은 브라우저 타이머가 깨우는 데모다.
//
// 그대로 두면 모의 자동매매는 진입만 하고 자동청산이 안 된다.
//
// 무엇을 하지 않는가
// ──────────────────
// **거래소 주문을 내지 않는다.** 이 경로에는 `executeOrder`도 거래소
// 어댑터도 없다. 모의 청산이 실계좌를 건드릴 통로 자체를 두지 않는다.
//
// 규칙도 새로 쓰지 않는다 — SL/TP 판정은 `exitRules.exitOnMark`이고
// 백테스트·`/api/paper/run`과 같은 함수다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { paperExitPlan } from '@/lib/engine/paperExitSweep';
import { wakeAuthFromEnv } from '@/lib/system/cronAuth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;



/**
 * 실제 일을 하는 몸통. 입구가 둘(POST·GET)이라 여기 한 번만 적는다.
 *
 * `uid`가 null이면 **모든 사용자**를 훑는다(관리자·cron 경로). 값이 있으면
 * 그 사용자만 — 화면에서 자기 포지션을 점검하는 경로다.
 */
async function sweep(uid: string | null) {
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const nowMs = Date.now();

  // ── 열린 모의 포지션 ──
  //
  // **조회 실패를 '포지션 없음'으로 읽지 않는다.** 없다고 읽으면 이번
  // 회차가 "볼 것이 없었다"로 끝나고, 손절이 걸려 있는 포지션이 조용히
  // 방치된다.
  let rows: any[] | null = null;
  try {
    // ── **여기는 계좌로 좁히지 않는다. 일부러 그렇다** ──
    //
    // `081`로 사용자당 모의 계좌가 여럿이 될 수 있게 됐고, 포지션을 읽는
    // 다른 자리는 전부 `paper_account_id`로 좁혔다. 이 감시만 예외다.
    //
    // 이유: 여기가 손절·익절·청산가를 **실제로 집행하는 안전망**이다.
    // 기본 계좌로 좁히면 전용 계좌(챌린지 등) 포지션의 손절을 **아무도 안
    // 본다.** 좁히는 것이 안전해 보이지만 여기서는 정반대다.
    //
    // 섞여도 안전한 이유: 이 경로는 계좌를 합산하지 않는다. 포지션을 한 줄씩
    // 보고 `closePaperPosition(id)`로 닫으며, `paper_settle_close`가 **그
    // 포지션이 든 계좌**를 따라간다(082). 남의 예산을 깎거나 남의 자산에
    // 더해지는 일이 없다.
    // **`market`을 함께 읽는다.** 이 칸을 안 읽었기 때문에 현물 포지션이
    // 선물 마크가로 판정되고 있었다 — `/api/paper/close`가 이미 고친 고장이
    // 이 라우트에만 남아 있었다.
    let q = (sb as any).from('paper_positions')
      .select('id, user_id, paper_account_id, symbol, market, side, fill_price, quantity, margin, stop_loss, take_profit, liquidation_price, opened_at')
      .eq('status', 'open');
    if (uid) q = q.eq('user_id', uid);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows = Array.isArray(data) ? data : null;
  } catch (e: any) {
    return NextResponse.json({
      ok: false, error: 'positions_unreadable',
      message: `모의 포지션을 읽지 못했습니다 (${String(e?.message || e).slice(0, 160)}) — `
        + '포지션이 없다는 뜻이 아닙니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  if (rows == null) {
    return NextResponse.json({ ok: false, error: 'positions_unreadable',
      message: '모의 포지션을 읽지 못했습니다 — 포지션이 없다는 뜻이 아닙니다' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 현재가 ──
  //
  // 심볼당 한 번만 받는다. **못 받은 심볼은 지도에 넣지 않는다** —
  // 넣지 않으면 판정기가 그 포지션을 건드리지 않는다.
  // ── **시장마다 가격 출처가 다르다** ──
  //
  // 예전에는 심볼만 보고 전부 `getPremiumIndex`(선물 마크가)를 불렀다.
  // 현물 포지션도 선물 가격으로 판정됐다는 뜻이고, 익절이 걸린 현물은
  // 펀딩·베이시스만큼 다른 가격에 닫혔다.
  //
  // 진입(`/api/paper/order`)과 청산(`/api/paper/close`)은 이미
  // `readPaperMarkPrice` 하나를 쓴다. **이 감시기도 같은 함수를 부른다** —
  // 규칙을 세 곳에 적고 같기를 바라지 않는다.
  //
  // 그래서 지도의 키도 심볼이 아니라 `시장:심볼`이다. 같은 심볼이 현물과
  // 선물에 동시에 있으면 심볼만으로는 두 가격이 한 칸을 덮어쓴다.
  // 시장 판단·지도 키·청산가 읽기는 `paperExitMarks` 한 곳에 있다.
  // 여기에 다시 적으면 시험이 보는 것과 라우트가 쓰는 것이 갈린다.
  const { exitMarkKey, exitMarkPairs, exitLiquidationOf } =
    await import('@/lib/engine/paperExitMarks');
  const keyOf = exitMarkKey;
  const pairs = exitMarkPairs(rows);
  const marks = new Map<string, number>();
  await Promise.all(pairs.map(async (p) => {
    try {
      const { readPaperMarkPrice, paperPriceFailed } =
        await import('@/lib/engine/paperPriceSource');
      const px = await readPaperMarkPrice(p.market, p.symbol);
      if (paperPriceFailed(px)) return;
      const v = Number(px.price);
      if (Number.isFinite(v) && v > 0) marks.set(p.key, v);
    } catch { /* 못 받으면 이번 회차에 그 포지션은 건드리지 않는다 */ }
  }));

  const plan = paperExitPlan({
    // 판정기는 심볼로 가격을 찾으므로, 여기서 `시장:심볼`을 심볼 자리에 넣는다.
    // 원래 심볼은 아래에서 `rows`로 되찾는다.
    positions: rows.map(r => ({
      id: String(r.id), symbol: keyOf(r), side: r.side,
      fillPrice: Number(r.fill_price), quantity: Number(r.quantity),
      stopLoss: r.stop_loss == null ? undefined : Number(r.stop_loss),
      takeProfit: r.take_profit == null ? undefined : Number(r.take_profit),
      // **`Number(null)`은 0이다.** 현물에는 청산가가 없어서 이 칸이 비는데,
      // 0을 넣으면 "청산가 0"이라는 없는 값이 판정 입력으로 들어간다.
      // (지금은 LONG 판정이 `low <= 0`이라 발동하지 않지만, 부등호가 한 번만
      //  바뀌면 전 현물 포지션이 청산된다.) 없는 것은 없다고 넘긴다.
      liquidationPrice: exitLiquidationOf(r),
      openedAt: new Date(r.opened_at).getTime(),
    })) as any,
    marks, nowMs,
    // 시간청산은 켜지 않는다 — 전략별로 선언된 PAPER 보유시간 정책이 없다.
  });

  // ── 닫는다 ──
  //
  // 중복은 `closePaperPosition`의 조건부 UPDATE가 막는다. 두 실행기가
  // 같은 줄을 집어도 **계좌는 한 번만** 움직인다.
  const { closePaperPosition } = await import('@/lib/engine/paperStore');
  const results: any[] = [];
  let closed = 0, already = 0, failed = 0;
  for (const a of plan.actions) {
    const row = rows.find(r => String(r.id) === String(a.positionId));
    const mark = row ? marks.get(keyOf(row)) : undefined;
    if (mark == null) { continue; }   // 여기 올 수 없지만, 지어낸 가격으로 닫지 않는다
    const r = await closePaperPosition(sb, a.positionId as string, mark, (a.exitReason ?? 'MANUAL') as any);
    if (r.ok) closed += 1;
    else if (String(r.error) === '이미 청산된 포지션') already += 1;
    else failed += 1;
    results.push({ positionId: a.positionId, reason: a.exitReason, ok: r.ok,
      realizedPnl: r.realizedPnl ?? null, error: r.ok ? null : r.error });
  }

  // Existing PAPER-only worker wakeup, after protective exits. JWT polling never
  // advances automation, and unknown/failed exits block new entries this tick.
  let automation: { ok: boolean; code: string } | null = null;
  // **깨우기 경로에서만 회차를 돌린다.** `uid === null`이 그 경로다
  // (cron·관리자). 사용자 토큰으로 들어온 화면 조회가 회차를 전진시키면
  // 브라우저를 열어 둔 사람만 봇이 도는 셈이 된다.
  if (uid === null && failed === 0 && plan.unknownMarks === 0) {
    try {
      const { runDuePaperAutomation } = await import('@/lib/engine/paperAutomation');
      automation = await runDuePaperAutomation(sb);
    } catch { automation = { ok: false, code: 'AUTOMATION_UNAVAILABLE' }; }
  }

  return NextResponse.json({
    ok: failed === 0,
    scanned: plan.scanned,
    closed,
    // 다른 실행기가 먼저 닫은 것. **실패가 아니다**
    alreadyClosed: already,
    failed,
    // **시세를 못 구해 미룬 것.** 0으로 세지 않는다
    unknownMarks: plan.unknownMarks,
    unknownSymbols: plan.unknownSymbols,
    note: plan.reason,
    // 시간청산은 켜져 있지 않다. 그 사실을 값으로 남긴다.
    timeExit: 'DISABLED_NO_EXPLICIT_POLICY',
    results,
    automation,
    checkedAt: nowMs,
  }, { status: failed === 0 ? 200 : 500, headers: { 'Cache-Control': 'no-store' } });
}

// ── 입구 ──
//
// **깨우는 길을 둘 둔다.** 전에는 깨우는 곳이 Fly 워커 하나뿐이었다 —
// 워커가 꺼져 있으면 모의매매는 한 건도 돌지 않고, 걸어 둔 손절이 걸리지
// 않는다. 진입을 놓치는 것과 손절이 안 걸리는 것은 잃는 것이 다르다.
//
// 두 번째 길은 **GitHub Actions 15분**이다(`.github/workflows/paper-tick.yml`).
// `vercel.json`이 **아닌** 이유: Vercel Hobby 크론은 하루 한 번만 허용하고,
// 더 잦게 적으면 **배포가 실패한다** — 그 라우트 하나가 아니라 전부가 안
// 올라간다(`api/cron/reconcile/route.ts`가 실제로 겪은 기록). `watch/tick`이
// 같은 이유로 이미 GitHub Actions를 쓴다.
//
// 그래서 **GET도 받는다.** 예약·외부 스케줄러가 보내는 모양이 GET이고,
// `/api/autotrade/exit-monitor`도 GET이다. 전에는 `POST`만 내보내서, 어떤
// 예약을 붙여도 405로 조용히 한 번도 돌지 않았다.
//
// 인증 판정은 `system/cronAuth` **한 곳**에 있다. 전에는 이 라우트와
// 자동매매 라우트에 각자 적혀 있었고 받는 경로가 서로 달랐다 — 경로가
// 둘인데 한쪽만 고친 상태였다.
//
// 겹쳐 깨워도 회차는 하나만 돈다: `paper_auto_claim()`이 토큰 하나만
// 내주고, PG 시험이 동시 8회 × 30라운드로 그것을 고정한다.

/** 사용자 화면·워커가 부른다. 사용자 토큰이면 그 사용자만 훑는다 */
export async function POST(req: NextRequest) {
  const wake = wakeAuthFromEnv({
    authorization: req.headers.get('authorization'),
    adminHeader: req.headers.get('x-admin-secret'),
  });
  const uid = wake.ok ? null : await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!wake.ok && !uid) {
    return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  }
  return sweep(uid);
}

/**
 * 예약이 부른다 — GitHub Actions(`x-admin-secret`)와, 요금제가 허용하면
 * Vercel Cron(`Bearer CRON_SECRET`). 판정은 둘 다 `cronAuth`가 한다.
 *
 * 여기서는 **사용자 토큰 경로를 열지 않는다.** 브라우저의 선행 조회
 * 하나로 전체 훑기가 돌아가면 안 된다. 예약·관리자만이다.
 */
export async function GET(req: NextRequest) {
  const wake = wakeAuthFromEnv({
    authorization: req.headers.get('authorization'),
    adminHeader: req.headers.get('x-admin-secret'),
  });
  if (!wake.ok) {
    return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  }
  return sweep(null);
}
