// src/lib/engine/manualOverride.ts
//
// **사용자가 손으로 닫았으면 자동매매가 다시 열지 않는다.**
//
// 무엇이 문제인가
// ───────────────
// 자동매매가 롱을 열었다. 사용자가 화면을 보다가 "이건 아닌데" 싶어
// 거래소 앱에서 손으로 닫았다. 그런데 진입 조건은 아직 참이다.
//
// 다음 주기에 자동매매가 포지션을 조회한다 — 없다. 조건은 맞다. 다시 연다.
//
// 사용자 입장에서는 **닫았는데 다시 열린다.** 그리고 다시 닫으면 또 열린다.
// 지금 있는 방어는 `reentryCheck`(시간 간격)뿐이라, 간격이 지나면 그대로
// 반복된다. 이건 자동매매가 아니라 사용자와 코드가 싸우는 것이고,
// 그 싸움의 수수료는 사용자가 낸다.
//
// 손으로 닫은 것을 어떻게 아는가
// ──────────────────────────────
// 거래소만 보면 손절 체결과 수동 청산이 비슷하게 생겼다. 둘 다
// "포지션이 사라졌다"이다.
//
// 구별되는 지점이 하나 있다: **우리가 건 보호 주문이 아직 살아 있는가.**
//
//   · 손절/익절로 닫혔다  → 그 주문이 체결됐으므로 주문장에 없다
//   · 사용자가 닫았다     → 우리 손절은 아직 주문장에 남아 있다
//                          (거래소가 자동 취소하기 전까지)
//
// 완벽하지 않다. 거래소가 reduceOnly 주문을 즉시 정리하면 둘이 같아
// 보인다. 그래서 **애매하면 막는 쪽으로 기운다** — 다시 여는 것보다
// 안 여는 쪽이 되돌리기 쉽다. 못 여는 것은 불편이고, 원치 않는데 열리는
// 것은 사고다.
//
// 무엇을 하지 않는가
// ──────────────────
// **영구히 막지 않는다.** 사용자가 한 번 손으로 닫았다고 그 전략을
// 영영 못 쓰게 하면, 다시 켜는 방법을 찾다가 결국 안전장치를 통째로
// 끈다. 쿨다운을 두고, 그 시간이 얼마인지 화면에 적는다.

export type CloseCause =
  /** 우리가 건 손절이 체결됐다 */
  | 'STOP'
  /** 우리가 건 익절이 체결됐다 */
  | 'TAKE_PROFIT'
  /** 거래소 강제청산 */
  | 'LIQUIDATION'
  /** 자동매매가 스스로 닫았다 */
  | 'ENGINE'
  /** 사용자가 손으로 닫았다 */
  | 'MANUAL'
  /** 닫힌 것은 맞는데 원인을 못 가렸다 */
  | 'UNKNOWN';

export interface CloseEvidence {
  /** 지금 포지션이 있는가. null이면 조회 실패 */
  hasPosition: boolean | null;
  /** 우리가 건 손절 주문 id. 없으면 안 걸었다 */
  stopOrderId?: string | null;
  /** 우리가 건 익절 주문 id */
  takeProfitOrderId?: string | null;
  /**
   * 지금 주문장에 남아 있는 주문 id 목록.
   * **못 읽었으면 null이다** — 빈 배열(진짜로 없음)과 다르다.
   */
  openOrderIds?: string[] | null;
  /** 앱이 스스로 닫은 기록이 있는가 */
  engineClosed?: boolean;
  /** 거래소가 청산이라고 말했는가 */
  liquidated?: boolean;
}

export interface CauseVerdict {
  cause: CloseCause;
  reason: string;
  /** 자동매매를 잠가야 하는가 */
  shouldSuppress: boolean;
}

/**
 * 포지션이 왜 사라졌는가.
 *
 * 순수 함수다 — 네트워크를 안 탄다.
 *
 * **애매하면 MANUAL 쪽으로 기운다.** 다시 여는 것보다 안 여는 쪽이
 * 되돌리기 쉽다.
 */
export function classifyClose(ev: CloseEvidence): CauseVerdict {
  // 아직 포지션이 있으면 닫힌 것이 아니다.
  if (ev.hasPosition === true) {
    return { cause: 'UNKNOWN', reason: '포지션이 아직 있습니다', shouldSuppress: false };
  }
  if (ev.hasPosition == null) {
    // **포지션을 못 읽었으면 닫혔다고 단정하지 않는다.** 그리고 모르는
    // 채로 새로 열지도 않는다 — 이미 있는 포지션 위에 또 열 수 있다.
    return {
      cause: 'UNKNOWN',
      reason: '포지션을 읽지 못해 닫혔는지 알 수 없습니다 — 확인 전에는 새로 열지 않습니다',
      shouldSuppress: true,
    };
  }

  if (ev.liquidated) {
    return { cause: 'LIQUIDATION', reason: '거래소 강제청산입니다', shouldSuppress: true };
  }
  if (ev.engineClosed) {
    return { cause: 'ENGINE', reason: '자동매매가 스스로 닫았습니다', shouldSuppress: false };
  }

  const stopId = ev.stopOrderId ? String(ev.stopOrderId) : null;
  const tpId = ev.takeProfitOrderId ? String(ev.takeProfitOrderId) : null;

  // 보호 주문을 안 걸었으면 무엇으로 닫혔는지 가릴 근거가 없다.
  if (!stopId && !tpId) {
    return {
      cause: 'UNKNOWN',
      reason: '보호 주문을 건 적이 없어 무엇으로 닫혔는지 가릴 수 없습니다',
      shouldSuppress: true,
    };
  }

  if (!Array.isArray(ev.openOrderIds)) {
    // 주문장을 못 읽었다. **'없음'으로 치면 손절 체결로 읽히고,
    // 그러면 자동매매가 곧바로 다시 연다.**
    return {
      cause: 'UNKNOWN',
      reason: '미체결 주문을 읽지 못해 무엇으로 닫혔는지 가릴 수 없습니다',
      shouldSuppress: true,
    };
  }

  const live = new Set(ev.openOrderIds.map(String));
  const stopAlive = stopId != null && live.has(stopId);
  const tpAlive = tpId != null && live.has(tpId);

  // 우리 보호 주문이 아직 살아 있는데 포지션이 없다 → 다른 손이 닫았다.
  if (stopAlive || tpAlive) {
    return {
      cause: 'MANUAL',
      reason: '포지션이 없는데 걸어 둔 보호 주문이 아직 남아 있습니다 — '
            + '자동매매가 아닌 곳에서 닫혔습니다',
      shouldSuppress: true,
    };
  }

  // 보호 주문도 사라졌다 → 체결된 것으로 본다. 어느 쪽인지는
  // 걸어 둔 것이 하나뿐이면 그것이고, 둘 다면 가릴 수 없다.
  if (stopId && !tpId) {
    return { cause: 'STOP', reason: '손절이 체결됐습니다', shouldSuppress: false };
  }
  if (tpId && !stopId) {
    return { cause: 'TAKE_PROFIT', reason: '익절이 체결됐습니다', shouldSuppress: false };
  }
  return {
    cause: 'UNKNOWN',
    reason: '손절과 익절이 둘 다 사라져 어느 쪽으로 닫혔는지 가릴 수 없습니다',
    // 여기는 막지 않는다. 둘 다 걸려 있었고 둘 다 사라졌다면 그중
    // 하나가 체결된 것이고, 그건 정상 종료다. 원인만 모를 뿐이다.
    shouldSuppress: false,
  };
}

export interface SuppressState {
  /** 언제 그렇게 판정했는가 */
  atMs: number;
  cause: CloseCause;
}

export interface SuppressVerdict {
  allowed: boolean;
  reason: string;
  /** 몇 분 더 기다려야 하는가. 잠금이 아니면 0 */
  waitMin: number;
}

/**
 * 쿨다운 기본값(분).
 *
 * 왜 원인마다 다른가: 사용자가 손으로 닫은 것은 **의사 표시**다. 곧바로
 * 다시 열면 그 의사를 무시하는 것이라 길게 잡는다. 강제청산은 시장이
 * 전략과 안 맞는 국면이라는 신호이므로 역시 길다. 원인을 못 가린 경우는
 * 짧게 — 조회 한 번 실패로 하루를 잠그면 그건 그것대로 사고다.
 */
export const SUPPRESS_MIN: Record<CloseCause, number> = {
  MANUAL: 120,
  LIQUIDATION: 240,
  UNKNOWN: 15,
  STOP: 0,
  TAKE_PROFIT: 0,
  ENGINE: 0,
};

/**
 * 지금 자동매매가 이 종목에 들어가도 되는가.
 *
 * **기록이 없으면 통과다.** 한 번도 닫힌 적 없는 종목까지 막으면
 * 자동매매가 아예 시작을 못 한다.
 */
export function suppressGate(
  state: SuppressState | null | undefined,
  nowMs: number,
  overrideMin?: Partial<Record<CloseCause, number>>,
): SuppressVerdict {
  if (!state) return { allowed: true, reason: '', waitMin: 0 };
  if (!Number.isFinite(state.atMs) || !Number.isFinite(nowMs)) {
    return { allowed: false, waitMin: 0,
      reason: '마지막 청산 시각을 읽지 못해 재진입 간격을 판단할 수 없습니다' };
  }

  const mins = overrideMin?.[state.cause] ?? SUPPRESS_MIN[state.cause] ?? 0;
  if (mins <= 0) return { allowed: true, reason: '', waitMin: 0 };

  const since = nowMs - state.atMs;
  if (since < 0) {
    return { allowed: false, waitMin: 0,
      reason: '마지막 청산이 미래로 기록돼 있습니다 — 시계가 어긋났습니다' };
  }
  const gap = mins * 60_000;
  if (since >= gap) return { allowed: true, reason: '', waitMin: 0 };

  const waitMin = Math.ceil((gap - since) / 60_000);
  const label = state.cause === 'MANUAL' ? '사용자가 손으로 닫았습니다'
    : state.cause === 'LIQUIDATION' ? '강제청산됐습니다'
    : '무엇으로 닫혔는지 가리지 못했습니다';
  return {
    allowed: false, waitMin,
    reason: `${label} — ${waitMin}분 뒤에 다시 봅니다 (쿨다운 ${mins}분)`,
  };
}
