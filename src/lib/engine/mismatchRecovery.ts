// src/lib/engine/mismatchRecovery.ts
//
// **어긋난 것을 어떻게 되돌리는가.**
//
// 무엇이 없었나
// ─────────────
// 상태 대조는 무엇이 다른지까지 말한다 — "포지션 수량 앱 0.5 / 거래소 1.0".
// 그런데 거기서 끝난다. 사용자가 볼 수 있는 것은 **막혔다는 사실과 목록**
// 뿐이고, 그 목록을 어떻게 없애는지는 아무 데도 없다.
//
// 그래서 실제로 일어나는 일: 화면에 "불일치 3건"이 떠 있고 신규 주문이
// 막혀 있는데, 사용자는 [미확정 주문 확정]을 눌러 보고 안 되면 거래소
// 앱을 열어 손으로 정리한다. 막힌 자리에서 푸는 방법이 없으면 그건
// 안전장치가 아니라 막다른 길이다.
//
// 무엇을 기준으로 삼는가
// ──────────────────────
// **거래소가 기준이다.** 돈이 실제로 있는 곳이 거기다. 앱의 기록은
// 거래소에서 일어난 일의 사본이고, 둘이 다르면 사본이 틀린 것이다.
//
// 그런데 그 원칙이 **"앱 기록을 지운다"로 곧장 이어지면 안 된다.**
// 거래소가 안 보여준다고 없던 일이 되는 것이 아니다 — 조회가 부분적으로
// 실패했을 수도 있고, 심볼 범위가 좁게 걸렸을 수도 있고, 그 사이에
// 포지션이 정말 닫혔을 수도 있다. 앞의 둘에서 기록을 지우면 체결 이력이
// 사라지고, 그건 되돌릴 수 없다.
//
// 그래서 둘로 나눈다: **더하는 복구는 자동, 지우는 복구는 확인.**

import type { Mismatch, MismatchCode } from './stateReconcile';

export type RecoveryAction =
  /** 미확정 주문을 거래소와 대조해 확정한다 */
  | 'RECONCILE_ORDERS'
  /** 거래소에 있는 것을 앱에 들여온다 (기록을 **더한다**) */
  | 'ADOPT_FROM_EXCHANGE'
  /** 앱에만 있는 기록을 정리한다 (기록을 **지운다** — 확인 필요) */
  | 'CLEAR_STALE_RECORD'
  /** 보호 주문을 지금 건다 */
  | 'ATTACH_STOP'
  /** 남은 보호 주문을 취소한다 */
  | 'CANCEL_ORPHAN'
  /** 배율을 맞춘다 */
  | 'SYNC_LEVERAGE'
  /** 마진 모드를 맞춘다 */
  | 'SYNC_MARGIN'
  /** 사람이 거래소에서 직접 봐야 한다 */
  | 'MANUAL_ONLY'
  /** 할 일 없음 */
  | 'NONE';

export interface RecoveryStep {
  code: MismatchCode;
  severity: 'info' | 'warn' | 'critical';
  symbol: string;
  /** 앱이 아는 값 */
  appValue: string;
  /** 거래소가 아는 값 */
  exchangeValue: string;
  /** 무엇을 기준으로 되돌리는가 */
  authority: 'EXCHANGE' | 'APP' | 'UNKNOWN';
  action: RecoveryAction;
  /** 버튼에 적을 말 */
  label: string;
  /** 왜 이렇게 되돌리는가 */
  why: string;
  /**
   * 확인 없이 실행해도 되는가.
   *
   * **기록을 지우는 것은 언제나 false다.** 거래소가 안 보여준다고 없던
   * 일이 되는 것이 아니고, 조회가 부분적으로 실패했을 수도 있다.
   */
  safeToAutomate: boolean;
  /** 되돌릴 수 없는가 */
  destructive: boolean;
  /** 이 항목이 신규 주문을 막는가 */
  blocking: boolean;
}

const s = (v: any): string => (v == null || v === '' ? '—' : String(v));

interface Rule {
  authority: RecoveryStep['authority'];
  action: RecoveryAction;
  label: string;
  why: string;
  safeToAutomate: boolean;
  destructive: boolean;
}

/**
 * 코드별 복구 규칙.
 *
 * 화면 안에 적으면 화면마다 다르게 판정하고, 그러면 어떤 화면에서는
 * 자동으로 지워지고 어떤 화면에서는 안 지워진다.
 */
const RULES: Record<MismatchCode, Rule> = {
  // 앱에는 포지션이 있는데 거래소에는 없다.
  //
  // **지우는 쪽이다 — 확인을 받는다.** 정말 닫힌 것일 수도 있지만,
  // 조회가 그 심볼을 못 봤을 수도 있다. 후자에서 지우면 열려 있는
  // 포지션을 앱이 모르게 되고, 그 뒤로 손절도 안 걸린다.
  POSITION_MISSING_ON_EXCHANGE: {
    authority: 'EXCHANGE', action: 'CLEAR_STALE_RECORD',
    label: '앱 기록 정리',
    why: '거래소에 없는 포지션이 앱에 남아 있습니다. 정말 닫힌 것인지 먼저 확인하세요 — 조회가 이 심볼을 못 봤을 수도 있습니다',
    safeToAutomate: false, destructive: true,
  },
  // 거래소에는 있는데 앱이 모른다. **더하는 쪽이라 자동으로 해도 된다** —
  // 모르는 포지션이 손절 없이 떠 있는 것이 훨씬 나쁘다.
  POSITION_MISSING_IN_APP: {
    authority: 'EXCHANGE', action: 'ADOPT_FROM_EXCHANGE',
    label: '거래소 포지션 들여오기',
    why: '거래소에 있는 포지션을 앱이 모릅니다 — 들여와야 손절과 청산 감시가 붙습니다',
    safeToAutomate: true, destructive: false,
  },
  // 방향이 다르다. 이건 자동으로 못 고친다 — 어느 쪽이 맞는지 정하는
  // 것이 곧 "지금 롱인가 숏인가"를 정하는 것이다.
  POSITION_SIDE_DIFFERS: {
    authority: 'EXCHANGE', action: 'MANUAL_ONLY',
    label: '거래소에서 확인',
    why: '앱과 거래소가 방향을 다르게 압니다. 방향을 잘못 잡으면 청산이 신규 진입이 됩니다 — 사람이 확인해야 합니다',
    safeToAutomate: false, destructive: false,
  },
  POSITION_QTY_DIFFERS: {
    authority: 'EXCHANGE', action: 'ADOPT_FROM_EXCHANGE',
    label: '거래소 수량으로 맞추기',
    why: '부분 체결이나 부분 청산이 앱에 반영되지 않았습니다 — 거래소 수량이 사실입니다',
    safeToAutomate: true, destructive: false,
  },
  LEVERAGE_DIFFERS: {
    authority: 'EXCHANGE', action: 'SYNC_LEVERAGE',
    label: '배율 맞추기',
    why: '주문 직전에 배율을 맞추고 되읽어 확인합니다',
    safeToAutomate: true, destructive: false,
  },
  MARGIN_TYPE_DIFFERS: {
    authority: 'EXCHANGE', action: 'SYNC_MARGIN',
    label: '마진 모드 맞추기',
    why: '교차와 격리는 청산가가 다릅니다 — 열린 포지션이 없을 때만 바꿀 수 있습니다',
    safeToAutomate: true, destructive: false,
  },
  // **가장 급한 것.** 포지션 크기 자체가 손절이 있다는 전제로 계산됐다.
  PROTECTIVE_ORDER_MISSING: {
    authority: 'EXCHANGE', action: 'ATTACH_STOP',
    label: '손절 지금 걸기',
    why: '포지션이 보호되지 않았습니다. 이 크기는 손절이 있다는 전제로 계산됐습니다',
    safeToAutomate: true, destructive: false,
  },
  ORDER_MISSING_ON_EXCHANGE: {
    authority: 'EXCHANGE', action: 'RECONCILE_ORDERS',
    label: '미확정 주문 확정',
    why: '앱이 아는 주문이 거래소 주문장에 없습니다 — 체결됐는지 취소됐는지 대조해 확정합니다',
    safeToAutomate: true, destructive: false,
  },
  ORDER_MISSING_IN_APP: {
    authority: 'EXCHANGE', action: 'CANCEL_ORPHAN',
    label: '남은 주문 확인',
    why: '거래소에 우리가 모르는 주문이 있습니다 — 지난 포지션의 보호 주문이면 다음 진입을 칩니다',
    safeToAutomate: false, destructive: false,
  },
  // 잔고 차이는 미실현 손익·수수료로도 생긴다. 막지 않고 적기만 한다.
  BALANCE_DIFFERS: {
    authority: 'EXCHANGE', action: 'NONE',
    label: '',
    why: '미실현 손익과 수수료로도 생깁니다 — 주문을 막지 않습니다',
    safeToAutomate: false, destructive: false,
  },
};

export function recoveryStepOf(m: Mismatch | null | undefined): RecoveryStep | null {
  if (!m) return null;
  const rule = RULES[m.code];
  // **모르는 코드를 자동으로 처리하지 않는다.** 새 코드가 생겼는데
  // 여기가 안 따라오면, 그 항목은 사람에게 넘어간다 — 조용히 지나가는
  // 것보다 낫다.
  const r: Rule = rule ?? {
    authority: 'UNKNOWN', action: 'MANUAL_ONLY', label: '거래소에서 확인',
    why: '이 불일치를 되돌리는 방법이 정해져 있지 않습니다',
    safeToAutomate: false, destructive: false,
  };
  return {
    code: m.code,
    severity: m.severity,
    symbol: s(m.symbol),
    appValue: s(m.app),
    exchangeValue: s(m.exchange),
    authority: r.authority,
    action: r.action,
    label: r.label,
    why: r.why,
    safeToAutomate: r.safeToAutomate,
    destructive: r.destructive,
    // critical만 신규 주문을 막는다 — stateReconcile의 규칙과 같다.
    blocking: m.severity === 'critical',
  };
}

export interface RecoveryPlan {
  steps: RecoveryStep[];
  /** 확인 없이 눌러도 되는 것 */
  autoSteps: RecoveryStep[];
  /** 사람이 확인해야 하는 것 */
  manualSteps: RecoveryStep[];
  /** 되돌릴 수 없는 것 */
  destructiveSteps: RecoveryStep[];
  blocksNewOrders: boolean;
  summary: string;
}

/**
 * 불일치 목록 → 복구 계획.
 *
 * 급한 것부터 정렬한다. 보호 없는 포지션이 잔고 차이 뒤에 묻히면 안 된다.
 */
export function recoveryPlan(mismatches: Mismatch[] | null | undefined): RecoveryPlan {
  const steps = (Array.isArray(mismatches) ? mismatches : [])
    .map(recoveryStepOf)
    .filter(Boolean) as RecoveryStep[];

  const rank = (st: RecoveryStep) =>
    (st.action === 'ATTACH_STOP' ? 0
      : st.severity === 'critical' ? 1
      : st.severity === 'warn' ? 2 : 3);
  steps.sort((a, b) => rank(a) - rank(b));

  const actionable = steps.filter(st => st.action !== 'NONE');
  const autoSteps = actionable.filter(st => st.safeToAutomate);
  const manualSteps = actionable.filter(st => !st.safeToAutomate);
  const destructiveSteps = actionable.filter(st => st.destructive);
  const blocksNewOrders = steps.some(st => st.blocking);

  const summary = steps.length === 0
    ? '앱과 거래소가 일치합니다'
    : [
        `어긋난 곳 ${steps.length}건`,
        autoSteps.length > 0 ? `자동 복구 가능 ${autoSteps.length}건` : '',
        manualSteps.length > 0 ? `사람 확인 필요 ${manualSteps.length}건` : '',
        blocksNewOrders ? '— 신규 주문이 막혀 있습니다' : '',
      ].filter(Boolean).join(' · ');

  return { steps, autoSteps, manualSteps, destructiveSteps, blocksNewOrders, summary };
}

/**
 * 확인 창에 띄울 문장.
 *
 * **무엇이 지워지는지 숫자로 적는다.** "정말 실행할까요?"만 물으면
 * 사람은 읽지 않고 예를 누른다.
 */
export function confirmLinesFor(step: RecoveryStep): string[] {
  const lines = [
    `${step.symbol} · ${step.label}`,
    '',
    step.why,
    '',
    `앱      ${step.appValue}`,
    `거래소   ${step.exchangeValue}`,
  ];
  if (step.destructive) {
    lines.push('', '이 작업은 앱의 기록을 지웁니다. 되돌릴 수 없습니다.');
    lines.push('거래소의 포지션과 체결 이력은 건드리지 않습니다.');
  }
  return lines;
}
