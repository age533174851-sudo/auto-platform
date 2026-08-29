// src/lib/engine/paperExitSweep.ts
//
// **모의 포지션의 손절·익절을 누가 보는가.**
//
// 확인된 구멍
// ───────────
// #209가 PAPER 진입을 서버로 옮겼고(`paperDispatch` → `openPaperPosition`),
// 5A가 브라우저의 `checkPaperExits()`를 걷어냈다. 그런데 **서버에는 열린
// `paper_positions`를 주기적으로 읽어 SL/TP를 보는 실행자가 없었다.**
//
//   /api/autotrade/exit-monitor   paper 참조 0건 (거래소·live_orders용)
//   워커                          그 exit-monitor와 예약청산만 깨움
//   closePaperPosition            청산 기능은 있으나 부르는 주기 실행자 없음
//   /api/paper/run                판정은 있으나 **브라우저 타이머가 깨움**
//
// 그래서 이대로 두면 모의 자동매매는 **진입은 하는데 자동청산이 안 되는**
// 시스템이 된다. 못 여는 것은 불편이고 못 닫는 것은 사고다.
//
// 판정을 새로 쓰지 않는다
// ───────────────────────
// SL/TP 규칙은 `exitRules.exitOnMark`에 있고 백테스트와 공용이다.
// 여기서는 **여러 심볼·여러 사용자를 한 번에 훑는 계획**만 만든다 —
// 규칙을 복제하면 모의 성적이 백테스트와 다른 기계의 성적이 된다.
//
// 시간청산은 켜지 않는다
// ──────────────────────
// `DEFAULT_RUNNER.maxHoldHours`는 `/api/paper/run`(수동 데모)의 값이지
// **전략별로 선언된 PAPER 보유시간 정책이 아니다.** 전략이 연 포지션에
// 그 값을 적용하면 아무도 고르지 않은 청산이 일어난다. 명시된 정책이
// 생기기 전까지 이 스윕은 **SL·TP·청산가만** 본다.
import { planExits, type OpenPaperPos, type RunnerAction } from './paperRunner';
import { DEFAULT_RUNNER } from './paperRunner';

/** 시간청산을 끄는 값. 명시된 정책이 없으면 시간으로 닫지 않는다 */
export const NO_TIME_EXIT_HOURS = Number.POSITIVE_INFINITY;

export interface PaperExitPlan {
  /** 지금 닫아야 할 것 */
  actions: RunnerAction[];
  /** 시세를 못 구해 판단을 미룬 포지션 수. **0으로 세지 않는다** */
  unknownMarks: number;
  /** 시세를 못 구한 심볼 */
  unknownSymbols: string[];
  /** 훑은 포지션 수 */
  scanned: number;
  reason: string;
}

/**
 * 열린 모의 포지션 + 심볼별 현재가 → 닫을 것.
 *
 * **시세를 모르면 그 포지션은 건드리지 않는다.** 0으로 읽으면 전부
 * 손절에 걸리고, 직전 가격으로 읽으면 급락이 안 보인다. 미룬 것은
 * 미뤘다고 센다 — 운영 화면이 "왜 안 닫혔나"에 답할 수 있어야 한다.
 */
export function paperExitPlan(i: {
  positions: OpenPaperPos[] | null | undefined;
  /** 심볼 → 현재가. **못 구한 심볼은 넣지 않는다** */
  marks: Map<string, number> | null | undefined;
  nowMs: number;
  /** 시간청산 시간. 기본은 끈 상태 */
  maxHoldHours?: number;
}): PaperExitPlan {
  const rows = Array.isArray(i?.positions) ? i.positions : [];
  const marks = i?.marks instanceof Map ? i.marks : new Map<string, number>();
  if (rows.length === 0) {
    return { actions: [], unknownMarks: 0, unknownSymbols: [], scanned: 0,
      reason: '열린 모의 포지션이 없습니다' };
  }

  const cfg = {
    ...DEFAULT_RUNNER,
    // **명시된 정책이 없으면 시간으로 닫지 않는다.**
    maxHoldHours: i?.maxHoldHours ?? NO_TIME_EXIT_HOURS,
  };

  const actions: RunnerAction[] = [];
  const unknown = new Set<string>();
  let unknownCount = 0;

  // 심볼별로 묶어 같은 가격으로 한 번에 본다.
  const bySymbol = new Map<string, OpenPaperPos[]>();
  for (const p of rows) {
    const sym = String((p as any)?.symbol ?? '');
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym)!.push(p);
  }

  for (const [sym, list] of bySymbol) {
    const raw = marks.get(sym);
    const mark = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
    if (mark == null) {
      // **못 구한 것을 0으로도 '없음'으로도 읽지 않는다.**
      unknown.add(sym || '(빈 심볼)');
      unknownCount += list.length;
      continue;
    }
    // 규칙은 `exitOnMark` 하나 — 백테스트와 같은 함수다.
    actions.push(...planExits(list, mark, i.nowMs, cfg));
  }

  return {
    actions,
    unknownMarks: unknownCount,
    unknownSymbols: Array.from(unknown),
    scanned: rows.length,
    reason: unknownCount > 0
      ? `${unknownCount}건은 현재가를 못 구해 이번 회차에 판단하지 않았습니다`
      : '',
  };
}
