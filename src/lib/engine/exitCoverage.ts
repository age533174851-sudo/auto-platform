// src/lib/engine/exitCoverage.ts
//
// **어느 전략의 포지션을 청산 감시가 실제로 보는가.**
//
// 왜 이 파일이 필요한가
// ─────────────────────
// `/api/autotrade/exit-monitor`는 `decideExits`가 준 목록만 본다.
// 그 함수가 읽는 표는 `ladder_daily_trades` 하나이고, 그건 계단식
// 전용 표다(`ladderGate.ts` 말고는 아무도 안 쓴다).
//
// 그래서 트레일링 · 본전 이동 · 시간 청산 · 포지션 점검은 **계단식에만**
// 붙어 있다. 그런데 응답에는 `checked` · `actionable` 숫자만 있어서,
// 다른 전략이 아예 목록에 오르지 않은 것과 **볼 것이 없었던 것**이
// 구분되지 않았다. 화면에는 "청산 감시 정상"이 떠 있었다.
//
// **UNKNOWN을 0으로 적지 않는다**는 이 저장소의 규칙이 여기에도 그대로
// 적용된다. 안 보는 것은 "이상 없음"이 아니다.
//
// 이 표는 지우기 위한 것이다
// ──────────────────────────
// 목표는 모든 칸이 true가 되어 이 파일이 사라지는 것이다. 그때까지는
// **비어 있는 칸이 응답과 화면에 그대로 보여야** 한다.

import { STRATEGIES, type StrategyId } from '../strategies/registry';

/** 청산 감시가 열린 포지션 목록을 읽는 표 */
export const EXIT_MONITOR_SOURCE_TABLE = 'ladder_daily_trades';

export interface ExitCoverage {
  strategyId: StrategyId | string;
  name: string;
  /** 진입 시점에 거래소 손절·익절을 거는가 (orderExecutor 공통 경로) */
  protectiveOrdersAtEntry: boolean;
  /** 트레일링 손절 */
  trailing: boolean;
  /** 본전 이동 */
  breakEven: boolean;
  /** 최대 보유 기간 초과 시 시간 청산 */
  timeExit: boolean;
  /** 청산가 근접 · 손절 소실 · 마진 모드 변경 감시 */
  positionGuard: boolean;
  /** 포지션 0 확인 뒤 남은 보호주문 제거 — 감시 주기마다 */
  orphanSweep: boolean;
  /** 빈 칸의 이유. 전부 채워졌으면 null */
  gap: string | null;
}

/**
 * 지금 코드가 실제로 하는 일.
 *
 * **여기에 희망을 적지 않는다.** 이 값은 `/api/autotrade/exit-monitor`와
 * `/api/system/runtime-health` 응답에 그대로 실린다 — 적어 놓은 것과
 * 코드가 갈리면 그 화면이 거짓말을 한다.
 */
const BY_MONITOR: Record<string, Omit<ExitCoverage, 'strategyId' | 'name'>> = {
  'daily-ladder': {
    protectiveOrdersAtEntry: true,
    trailing: true, breakEven: true, timeExit: true, positionGuard: true,
    orphanSweep: true,
    gap: null,
  },
  scalp: {
    protectiveOrdersAtEntry: true,
    // 청산 감시가 읽는 표에 이 전략의 줄이 없다.
    trailing: false, breakEven: false, timeExit: false, positionGuard: false,
    // 고아 정리는 전략을 가리지 않는다 — live_orders를 본다(orphanSweep.ts).
    orphanSweep: true,
    gap: `열린 포지션이 ${EXIT_MONITOR_SOURCE_TABLE}에 안 적혀서 트레일링·본전이동·시간청산·포지션점검을 받지 않습니다`,
  },
  'my-original-v1': {
    protectiveOrdersAtEntry: true,
    trailing: false, breakEven: false, timeExit: false, positionGuard: false,
    orphanSweep: true,
    gap: `열린 포지션이 ${EXIT_MONITOR_SOURCE_TABLE}에 안 적혀서 트레일링·본전이동·시간청산·포지션점검을 받지 않습니다`,
  },
};

/**
 * 모르는 전략은 **덮이는 것으로 치지 않는다.**
 *
 * 새 전략을 레지스트리에 넣고 이 표를 안 고치면, 조용히 "전부 true"가
 * 되는 대신 전부 false로 보이고 이유가 남는다. 그게 이 저장소가 반복해서
 * 당한 "만들어 놓고 배선을 안 함"을 눈에 보이게 하는 유일한 방법이다.
 */
const UNDECLARED: Omit<ExitCoverage, 'strategyId' | 'name'> = {
  protectiveOrdersAtEntry: false,
  trailing: false, breakEven: false, timeExit: false, positionGuard: false,
  orphanSweep: false,
  gap: '청산 감시 표(exitCoverage.ts)에 이 전략이 없습니다 — 무엇이 도는지 아무도 적지 않았습니다',
};

/** 실행 경로가 있는 전략의 청산 감시 커버리지 */
export function exitCoverage(): ExitCoverage[] {
  return STRATEGIES
    .filter(s => s.executionReady)
    .map(s => ({
      strategyId: s.id,
      name: s.name,
      ...(BY_MONITOR[s.id] ?? UNDECLARED),
    }));
}

/** 빈 칸이 있는 전략만 */
export function exitCoverageGaps(): ExitCoverage[] {
  return exitCoverage().filter(c => c.gap != null);
}

/**
 * 사람이 읽는 한 줄.
 *
 * **"정상"이라고 적지 않는다.** 안 보는 전략이 하나라도 있으면 그 수를 적는다.
 */
export function exitCoverageLine(): string {
  const all = exitCoverage();
  const gaps = all.filter(c => c.gap != null);
  if (all.length === 0) return '실행 경로가 있는 전략이 없습니다';
  if (gaps.length === 0) return `전략 ${all.length}개 전부 청산 감시 대상입니다`;
  return `전략 ${all.length}개 중 ${gaps.length}개가 트레일링·본전이동·시간청산·포지션점검을 받지 않습니다`
    + ` (${gaps.map(g => g.strategyId).join(' · ')})`;
}
