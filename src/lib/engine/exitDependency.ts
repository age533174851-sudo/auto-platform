// src/lib/engine/exitDependency.ts
//
// **이 포지션에서 자동으로 빠져나올 수단이 몇 개인가.**
//
// 왜 이 파일이 필요한가
// ────────────────────
// 두 가지를 따로 추적하다가 같은 사실에 도달했다.
//
//   ① 사용자 확정 운영 방식은 "매일 09:00 KST 진입 판단 → 지속 감시
//      → **실제 청산 신호 발생 시 매도**"다. 코드의 4시간 시간청산
//      (`profiles.MAX_LEV_100X.maxHoldSec = 14400`)은 그것과 충돌한다.
//
//   ② `seatExitCapabilities`가 Exact100X(`NO_FIXED_SL_EXACT100X`)에
//      주는 권한은 이것뿐이다:
//
//          fixedStopAtEntry: false   breakEven: false
//          trailing:         false   emergency: false
//          timeExit:         true    ← 유일하게 열린 것
//
// 그래서 **4시간 상수는 지우면 될 숫자가 아니다.** 지금 100배 포지션과
// 거래소 강제청산 사이에 있는 **유일한 장치**다. 100배의 청산 거리는
// 가격 0.6%(100/100 − MMR 0.4%)이고, 방치된 포지션은 불리한 0.6%
// 움직임에서 증거금 전액을 잃는다.
//
// 해결 순서가 "4시간을 없앤다"가 아니라 **"신호 청산을 먼저 배선하고,
// 그 뒤 시간청산을 주 종료에서 백스톱으로 내린다"**인 이유다. 그리고
// 12시간으로 늘리는 것은 무보호 노출을 3배로 늘리면서 신호 청산을
// 추가하지 않는 것이므로 해결이 아니다.
//
// 이 파일이 하는 일
// ─────────────────
// 시간청산을 완화해도 되는지 **묻는 자리를 만든다.** 유일한 종료
// 수단일 때는 어떤 입력에서도 완화를 허가하지 않는다. 그리고 "주문은
// 보냈는데 닫혔는지 모르는" 상태가 감시 중단과 겹쳤을 때 사람을
// 불러야 한다고 적는다.
//
// ★ 이 파일은 **판정만 한다.** 정책을 바꾸지 않고, 주문을 내지 않고,
//   상수를 고치지 않는다. import이 0개다.

/** 한 자리가 가진 자동 종료 수단 */
export interface ExitCapabilityFacts {
  fixedStopAtEntry?: boolean | null;
  breakEven?: boolean | null;
  trailing?: boolean | null;
  timeExit?: boolean | null;
  emergency?: boolean | null;
  /**
   * 신호 기반 청산이 **실제로 배선돼 있는가.**
   *
   * 선언이 아니라 배선이다. 정책 표에 적혀 있는 것과 실행기가 그것을
   * 읽는 것은 다르다 — 이 저장소가 반복해서 당한 고장이다.
   */
  signalExit?: boolean | null;
}

export type ExitPathCount = 'NONE' | 'TIME_ONLY' | 'SIGNAL_ONLY' | 'MULTIPLE';

/** 시간청산을 빼면 무엇이 남는가 */
export function countExitPaths(c: ExitCapabilityFacts | null | undefined): {
  count: ExitPathCount;
  /** 시간청산을 제외한 자동 종료 수단 수 */
  withoutTimeExit: number;
  timeExit: boolean;
} {
  const t = c?.timeExit === true;
  // **true만 센다.** null·undefined는 "있다"가 아니다.
  const others = [c?.fixedStopAtEntry, c?.breakEven, c?.trailing,
    c?.emergency, c?.signalExit].filter(v => v === true).length;
  const count: ExitPathCount = others > 0 && t ? 'MULTIPLE'
    : others > 0 ? 'SIGNAL_ONLY'
      : t ? 'TIME_ONLY' : 'NONE';
  return { count, withoutTimeExit: others, timeExit: t };
}

export type TimeExitRelaxCode =
  /** 완화해도 된다 — 다른 자동 종료 수단이 남는다 */
  | 'ALLOWED'
  /** 시간청산이 유일한 종료 수단이다. 빼면 자동 종료가 0개가 된다 */
  | 'BLOCKED_ONLY_EXIT_PATH'
  /** 신호 청산이 배선되지 않았다 */
  | 'BLOCKED_NO_SIGNAL_EXIT'
  /** 청산 감시가 돌고 있다는 확인이 없다 — 어떤 자동 종료도 못 돈다 */
  | 'BLOCKED_MONITOR_UNVERIFIED'
  /** 권한을 읽지 못했다. **완화 허가가 아니다** */
  | 'BLOCKED_UNKNOWN';

export interface TimeExitRelaxVerdict {
  allowed: boolean;
  code: TimeExitRelaxCode;
  reason: string;
  /** 완화가 막힌 동안 유지해야 하는 것 */
  keepTimeExit: boolean;
}

/**
 * 시간청산을 **완화·제거해도 되는가.**
 *
 * ★ fail-closed다. 모르면 막는다. 유일한 종료 수단이면 막는다.
 *   "유일한 자동 종료 수단을 지우는 변경"은 어떤 근거로도 통과시키지
 *   않는다 — 그 뒤에 남는 것은 사람의 주의력뿐이고, 100배에서
 *   그것으로는 0.6%를 못 지킨다.
 *
 * @param monitorVerified 청산 감시가 최근 성공했다는 확인. null = 모름
 */
export function judgeTimeExitRelax(i: {
  capabilities?: ExitCapabilityFacts | null;
  monitorVerified?: boolean | null;
} | null | undefined): TimeExitRelaxVerdict {
  const keep = (code: TimeExitRelaxCode, reason: string): TimeExitRelaxVerdict =>
    ({ allowed: false, code, reason, keepTimeExit: true });

  if (i?.capabilities == null) {
    return keep('BLOCKED_UNKNOWN',
      '종료 권한을 읽지 못했습니다 — 완화 허가로 읽지 않습니다');
  }
  const paths = countExitPaths(i.capabilities);

  // 감시가 돌지 않으면 **어떤 자동 종료도 집행되지 않는다.** 그 상태에서
  // 시간청산을 빼는 변경을 허가하면, 감시가 돌아왔을 때도 종료가 없다.
  if (i.monitorVerified !== true) {
    return keep('BLOCKED_MONITOR_UNVERIFIED',
      '청산 감시 성공이 확인되지 않았습니다 — 감시가 멈춘 동안은 어떤 자동 종료도 돌지 않습니다');
  }
  // ── 순서가 의미를 가진다 ──
  //
  //   "유일한 종료 수단인가"를 **신호 청산 검사보다 먼저** 본다.
  //   반대로 두면 `BLOCKED_ONLY_EXIT_PATH`가 **도달 불가능한 죽은
  //   분기**가 된다 — 신호 청산이 켜져야 그 검사에 닿는데, 켜져 있으면
  //   이미 "유일"이 아니기 때문이다. 시험이 그것을 잡았다.
  if (paths.withoutTimeExit <= 0) {
    return keep('BLOCKED_ONLY_EXIT_PATH',
      '시간청산이 유일한 자동 종료 수단입니다 — 빼면 거래소 강제청산까지 자동 종료가 0개가 됩니다');
  }
  if (i.capabilities.signalExit !== true) {
    return keep('BLOCKED_NO_SIGNAL_EXIT',
      '신호 기반 청산이 배선되지 않았습니다 — 사용자 요구인 "청산 신호 발생 시 매도"가'
      + ' 구현되기 전에는 시간청산을 빼지 않습니다');
  }
  return {
    allowed: true, code: 'ALLOWED', keepTimeExit: false,
    reason: `시간청산 외 자동 종료 수단 ${paths.withoutTimeExit}개가 남습니다`,
  };
}

// ══════════════════════════════════════════════════════════
// 미해결 종료 — "보냈는데 닫혔는지 모른다"는 상태의 내구성
// ══════════════════════════════════════════════════════════
//
//   `exitAuthorityRun`은 `CLOSE_INCOMPLETE`·`CLOSE_UNKNOWN_RECONCILE_REQUIRED`
//   에서 `needsReconcile: true`를 돌려준다. 그런데 그 값은 **HTTP 응답에만
//   적힌다.** 그것을 읽어 재조회를 걸거나 어딘가에 남기는 코드가 없다.
//
//   그래서 복구는 **다음 회차의 재발견**에 의존한다. 포지션이 아직 열려
//   있으므로 다음 회차가 다시 찾아서 닫는다 — 통합 시험 ⑧-g가 그것을
//   고정한다. 거기까지는 동작한다.
//
//   문제는 **감시가 멈추는 경우**다. 그 회차가 마지막이었으면 "주문을
//   보냈고 닫혔는지 모른다"는 사실이 응답 본문과 함께 사라진다. 아무도
//   그 포지션을 다시 보지 않는다.

export type UnresolvedCloseCode =
  /** 미해결 종료가 없다 */
  | 'NONE'
  /** 미해결이지만 감시가 돌고 있다 — 다음 회차가 재발견한다 */
  | 'PENDING_MONITOR_ALIVE'
  /** 미해결인데 감시가 멈췄다. **사람이 거래소를 봐야 한다** */
  | 'OPERATOR_REQUIRED'
  /** 미해결 여부를 모른다 */
  | 'UNKNOWN';

export interface UnresolvedCloseVerdict {
  code: UnresolvedCloseCode;
  /** 운영자에게 알려야 하는가 */
  alertOperator: boolean;
  reason: string;
}

/**
 * 미해결 종료가 방치될 상태인가.
 *
 * ★ `needsReconcile`을 **모르면 미해결로 본다.** 확인하지 못한 것을
 *   "해결됐다"로 적으면 그 포지션은 아무도 보지 않는다.
 */
export function judgeUnresolvedClose(i: {
  needsReconcile?: boolean | null;
  monitorVerified?: boolean | null;
} | null | undefined): UnresolvedCloseVerdict {
  const nr = i?.needsReconcile;
  if (nr === false) {
    return { code: 'NONE', alertOperator: false, reason: '' };
  }
  if (nr !== true) {
    return {
      code: 'UNKNOWN', alertOperator: true,
      reason: '종료 결과를 확인하지 못했습니다 — 해결됐다고 적지 않습니다',
    };
  }
  // 여기부터 needsReconcile === true
  if (i?.monitorVerified === true) {
    return {
      code: 'PENDING_MONITOR_ALIVE', alertOperator: false,
      reason: '미해결 종료가 있지만 감시가 돌고 있어 다음 회차가 다시 확인합니다',
    };
  }
  return {
    code: 'OPERATOR_REQUIRED', alertOperator: true,
    reason: '주문을 보냈지만 닫혔는지 모르는 상태에서 청산 감시가 멈췄습니다'
      + ' — 다음 회차가 없으므로 사람이 거래소에서 직접 확인해야 합니다',
  };
}
