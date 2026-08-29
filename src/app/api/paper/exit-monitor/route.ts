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
import { timingSafeEqual } from 'crypto';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { paperExitPlan } from '@/lib/engine/paperExitSweep';

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

  const nowMs = Date.now();

  // ── 열린 모의 포지션 ──
  //
  // **조회 실패를 '포지션 없음'으로 읽지 않는다.** 없다고 읽으면 이번
  // 회차가 "볼 것이 없었다"로 끝나고, 손절이 걸려 있는 포지션이 조용히
  // 방치된다.
  let rows: any[] | null = null;
  try {
    let q = (sb as any).from('paper_positions')
      .select('id, user_id, symbol, side, fill_price, quantity, margin, stop_loss, take_profit, liquidation_price, opened_at')
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

  const plan = paperExitPlan({
    positions: rows.map(r => ({
      id: String(r.id), symbol: String(r.symbol ?? ''), side: r.side,
      fillPrice: Number(r.fill_price), quantity: Number(r.quantity),
      stopLoss: r.stop_loss == null ? undefined : Number(r.stop_loss),
      takeProfit: r.take_profit == null ? undefined : Number(r.take_profit),
      liquidationPrice: Number(r.liquidation_price),
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
    const sym = rows.find(r => String(r.id) === String(a.positionId))?.symbol;
    const mark = sym ? marks.get(String(sym)) : undefined;
    if (mark == null) { continue; }   // 여기 올 수 없지만, 지어낸 가격으로 닫지 않는다
    const r = await closePaperPosition(sb, a.positionId as string, mark, (a.exitReason ?? 'MANUAL') as any);
    if (r.ok) closed += 1;
    else if (String(r.error) === '이미 청산된 포지션') already += 1;
    else failed += 1;
    results.push({ positionId: a.positionId, reason: a.exitReason, ok: r.ok,
      realizedPnl: r.realizedPnl ?? null, error: r.ok ? null : r.error });
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
    checkedAt: nowMs,
  }, { status: failed === 0 ? 200 : 500, headers: { 'Cache-Control': 'no-store' } });
}
