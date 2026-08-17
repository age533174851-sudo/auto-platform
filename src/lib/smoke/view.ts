// src/lib/smoke/view.ts
//
// **화면이 읽는 모양을 한 곳에서만 만든다.**
//
// 라우트가 셋이다 — 시작(POST) · 상태(GET) · 다음 회차(advance).
// 셋이 각자 회차를 요약하면 한쪽만 고쳐지고, 그때 같은 테스트가
// 화면에서는 PASS인데 진행 판정에서는 UNKNOWN이 된다.
//
// 그리고 Next의 `route.ts`는 HTTP 핸들러 말고 다른 것을 내보내면
// 안 된다 — 라우트끼리 공유하려면 어차피 여기여야 한다.

import { stepsOf, smokeVerdict } from './smokePlan';
import {
  runProgress, runMetrics, runSummary, advanceVerdict, type AttemptSummary,
} from './smokeRun';
import { cancelPhase } from './cancelRun';

/** 회차 한 줄 */
export function viewTest(r: any) {
  const steps = stepsOf(r?.steps);
  const v = smokeVerdict(steps, r?.state);
  return {
    id: r?.id, attemptNo: r?.attempt_no ?? null, symbol: r?.symbol, side: r?.side,
    marginUsd: r?.margin_usd, leverage: r?.leverage, holdMin: r?.hold_min,
    state: r?.state, holdUntil: r?.hold_until, source: r?.dispatch_source ?? null,
    entry: {
      orderId: r?.entry_order_id, avgPrice: r?.entry_avg_price, qty: r?.entry_qty,
      refPrice: r?.ref_price, exitOrderId: r?.exit_order_id, exitAvgPrice: r?.exit_avg_price,
      slOrderId: r?.sl_order_id, tpOrderId: r?.tp_order_id,
      slTrigger: r?.sl_trigger, tpTrigger: r?.tp_trigger,
    },
    timing: {
      entryLatencyMs: r?.entry_latency_ms ?? null, exitLatencyMs: r?.exit_latency_ms ?? null,
      slippagePct: r?.slippage_pct ?? null, apiLatencyMsMax: r?.api_latency_ms_max ?? null,
    },
    steps, verdict: v, reason: r?.reason ?? null,
    // ── 정리 증거 ──
    //
    // **적어 두고 그리지 않았다.** settle은 취소 한 건 한 건의 증거를
    // `steps._cancel`에, 잔여 판정을 `steps._residual`에 남긴다. 그런데
    // `stepsOf`는 정해진 단계 이름만 읽으므로 이 둘은 화면에 한 번도
    // 나온 적이 없다 — "왜 안 지워졌나"를 물었을 때 DB를 직접 열지
    // 않고는 답할 수 없었던 이유다. 이 저장소의 대표 고장(만들어 놓고
    // 배선 안 함)을 증거 경로에서 또 낸 것이다.
    evidence: {
      cancel: r?.steps?._cancel ?? null,
      residual: r?.steps?._residual ?? null,
    },
    createdAt: r?.created_at, closedAt: r?.closed_at,
  };
}

/**
 * 회차 줄 → 진행 판정이 읽는 요약.
 *
 * **증거가 없으면 null이지 true가 아니다.** 여기서 PENDING을 true로
 * 눕히면 정리되지 않은 계좌 위로 다음 회차가 열린다 — 이번에 터진
 * 사고를 10번 반복하는 도구가 된다.
 */
export function attemptSummaryOf(t: any): AttemptSummary {
  const steps = stepsOf(t?.steps);
  const proven = (id: string): boolean | null => {
    const st = steps.find(s => s.id === id)?.state ?? 'PENDING';
    return st === 'PASS' ? true : st === 'FAIL' ? false : null;
  };
  return {
    attemptNo: Number(t?.attempt_no) || 0,
    state: String(t?.state ?? ''),
    verdict: t?.verdict ?? null,
    positionZero: proven('POSITION_ZERO'),
    residualZero: proven('ORDERS_ZERO'),
    reason: t?.reason ?? null,
  };
}

/** 단계별로 몇 회가 통과했는가 */
export function stepPassCounts(tests: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of (Array.isArray(tests) ? tests : [])) {
    for (const s of stepsOf(t?.steps)) {
      if (s.state === 'PASS') out[s.id] = (out[s.id] ?? 0) + 1;
    }
  }
  return out;
}

/** 묶음 하나 */
export function viewRun(run: any, tests: any[]) {
  const list = Array.isArray(tests) ? tests : [];
  const summaries = list.map(attemptSummaryOf);
  const firstSide = run?.first_side === 'SHORT' ? 'SHORT' as const : 'LONG' as const;
  const directionMode = run?.direction_mode ?? 'ALTERNATE';
  const total = Number(run?.attempts) || 0;

  const progress = runProgress({ total, firstSide, directionMode, attempts: summaries });
  const advance = advanceVerdict({
    run: {
      attempts: total, directionMode,
      failurePolicy: run?.failure_policy === 'DURABLE' ? 'DURABLE' : 'SAFE',
      firstSide, state: run?.state,
    },
    attempts: summaries,
  });
  const stepPass = stepPassCounts(list);

  return {
    id: run?.id, symbol: run?.symbol, firstSide, directionMode,
    failurePolicy: run?.failure_policy, attempts: total,
    marginUsd: run?.margin_usd, leverage: run?.leverage, holdMin: run?.hold_min,
    state: run?.state, reason: run?.reason ?? null,
    // ── 중지가 어디까지 왔는가 ──
    //
    // **누른 직후 '완료'로 그리지 않는다.** 화면은 여기 적힌 관측 상태만
    // 그린다: 중지 요청됨 → 포지션 청산 중 → 보호주문 정리 중 → 중지 완료.
    // 낙관적으로 앞질러 그리면 청산이 실패해도 끝난 것처럼 보이고,
    // 그때 사람은 화면을 닫는다.
    cancel: cancelPhase(run?.state),
    stopIntent: run?.stop_intent ?? null,
    cancelNote: run?.cancel_note ?? null,
    progress, advance,
    summary: runSummary({ total, attempts: summaries, stepPass, advance }),
    metrics: runMetrics(list),
    tests: list.map(viewTest),
    createdAt: run?.created_at, closedAt: run?.closed_at,
  };
}
