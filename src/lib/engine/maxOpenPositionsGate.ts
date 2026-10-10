// src/lib/engine/maxOpenPositionsGate.ts
//
// Exact100X 계약의 maxOpenPositions=1을 실거래 TESTNET 연결 전체에 배선.
// BTC/ETH가 각각 신호를 내도 DB의 동일 UNIQUE(key)를 경쟁한다.
// 15분 동안 다른 진입을 막는 보수적인 inflight 윈도우다.
// 이것만으로 거래소/외부 매매까지 strict single-writer인 것은 아니다.
// ── 어떤 상태를 "진행 중"으로 볼 것인가 ──
//
// 처음 배선할 때 `['INTENT','SENT','UNKNOWN']`만 셌다. 그 목록은
// `live_orders_status_idx` 부분 인덱스와 같은 모양이어서 그럴듯했지만,
// **상태 정의와는 다르다** — `OrderStatus`에는 `ACKED`가 있고 그것은
// *거래소가 접수한 진입*이다. 빠진 방향이 **통과**였다.
//
// 그런데 `ACKED`를 그냥 목록에 넣으면 반대쪽으로 고장난다:
// `PENDING_STATUSES`(reconcile 대상)에 ACKED가 없어서 아무도 그 줄을
// 해소하지 않고, `newOrderRespType`을 지정하지 않아 바이낸스가 ACK만
// 돌려주므로 체결된 시장가 주문도 FILLED로 바뀌지 않는다. 즉 한 번
// 진입하면 그 줄이 영구히 남아 **다시는 진입하지 못한다.**
//
// 그래서 둘을 **다른 축으로** 둔다.
//   · 미확정   reconcile이 해소한다        → 나이 제한 없이 막는다
//   · 접수됨   reconcile이 해소하지 않는다 → 잠금 창 안의 것만 막는다
//
// 이 목록이 `OrderStatus` 전체를 덮는지는 시험이 대조한다. 어휘가 늘면
// 분류를 강제로 하게 된다.

/** reconcile(`PENDING_STATUSES`)이 해소하는 미확정 진입 상태 */
export const UNRESOLVED_ENTRY_STATUSES = ['INTENT', 'SENT', 'UNKNOWN'] as const;

/** 거래소가 접수했으나 reconcile 대상이 아닌 상태. 나이로 제한한다 */
export const ACCEPTED_ENTRY_STATUSES = ['ACKED'] as const;

/** 진입 잠금 창. 접수된 진입을 "진행 중"으로 볼 기간과 같다 */
export const CAPACITY_WINDOW_SEC = 15 * 60;

export type CapacityCode =
  | 'CAPACITY_AVAILABLE' | 'CAPACITY_REACHED' | 'CAPACITY_PENDING'
  | 'CAPACITY_UNKNOWN' | 'CAPACITY_BUSY' | 'CAPACITY_CLAIM_FAILED'
  | 'CAPACITY_UNSUPPORTED';

export interface CapacityVerdict {
  allowed: boolean;
  code: CapacityCode;
  reason: string;
}
export interface CapacityExposure {
  /** 동일 연결 전체의 열린 포지션 수. 심볼별이 아님. */
  positions: number;
  /** 동일 연결 전체의 미체결 주문 수. */
  openOrders: number;
}
export interface CapacityClaim {
  ok: boolean;
  duplicate: boolean;
  installed?: boolean;
  error?: string;
}
export interface CapacityDeps {
  observeExposure: () => Promise<CapacityExposure | null>;
  /** UNRESOLVED_ENTRY_STATUSES — 나이 제한 없이 */
  countPendingEntries: () => Promise<number | null>;
  /** ACCEPTED_ENTRY_STATUSES — CAPACITY_WINDOW_SEC 안의 것만 */
  countRecentAcceptedEntries: () => Promise<number | null>;
  claimSlot: () => Promise<CapacityClaim>;
}
const block = (code: CapacityCode, reason: string): CapacityVerdict =>
  ({ allowed: false, code, reason });
const countOk = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function checkExposure(x: CapacityExposure | null, max: number): CapacityVerdict {
  if (!x || !countOk(x.positions) || !countOk(x.openOrders)) {
    return block('CAPACITY_UNKNOWN', '계좌 전체 포지션 또는 미체결 주문을 읽지 못했습니다');
  }
  if (x.positions >= max) {
    return block('CAPACITY_REACHED',
      `계좌 전체 포지션 ${x.positions}개 / 최대 ${max}개 — 추가 진입하지 않습니다`);
  }
  if (x.openOrders !== 0) {
    return block('CAPACITY_PENDING',
      `거래소 미체결 주문 ${x.openOrders}건 — 추가 진입하지 않습니다`);
  }
  return { allowed: true, code: 'CAPACITY_AVAILABLE', reason: '계좌 전체 진입 가능' };
}

export async function maxOpenPositionsGate(
  i: { maxOpenPositions: number; mode: string },
  deps: CapacityDeps,
): Promise<CapacityVerdict> {
  // 1-slot claim만 구현됐다. 프로필 값을 2로 올리는 것만으로
  // 두 포지션이 허용된 척하지 않도록 확장 전까지 명시적으로 막는다.
  if (i.mode !== 'TESTNET' || i.maxOpenPositions !== 1) {
    return block('CAPACITY_UNSUPPORTED',
      'TESTNET 동시 최대 1개만 지원합니다 — 상한 또는 환경이 다릅니다');
  }

  let pre: CapacityExposure | null = null;
  try { pre = await deps.observeExposure(); } catch { /* unknown */ }
  const before = checkExposure(pre, i.maxOpenPositions);
  if (!before.allowed) return before;

  let pending: number | null = null;
  try { pending = await deps.countPendingEntries(); } catch { /* unknown */ }
  if (!countOk(pending)) {
    return block('CAPACITY_UNKNOWN', '미확정 진입 장부 조회 실패 — 빈 장부로 간주하지 않습니다');
  }
  if (pending > 0) {
    return block('CAPACITY_PENDING',
      `INTENT/SENT/UNKNOWN 주문 ${pending}건이 남아 있습니다`);
  }

  // 거래소가 접수한 진입. 창 안의 것만 본다 — 위 주석의 영구 차단을 피한다.
  let accepted: number | null = null;
  try { accepted = await deps.countRecentAcceptedEntries(); } catch { /* unknown */ }
  if (!countOk(accepted)) {
    return block('CAPACITY_UNKNOWN', '접수된 진입 장부 조회 실패 — 빈 장부로 간주하지 않습니다');
  }
  if (accepted > 0) {
    return block('CAPACITY_PENDING',
      `거래소가 접수한(ACKED) 진입 ${accepted}건이 잠금 창 안에 있습니다`);
  }

  let claim: CapacityClaim | null = null;
  try { claim = await deps.claimSlot(); } catch { /* unknown */ }
  // 범용 claimSignal은 DB 오류에서 fail-open이다. 여기는 fail-closed.
  if (!claim || claim.installed !== true || claim.error || (!claim.duplicate && claim.ok !== true)) {
    return block('CAPACITY_CLAIM_FAILED', '원자적 진입 잠금을 확실히 획득하지 못했습니다');
  }
  if (claim.duplicate) {
    return block('CAPACITY_BUSY', '같은 거래소 연결의 최근 100배 진입으로 15분 대기 중입니다');
  }

  // claim 획득 후 재조회하여 앞선 스냅숏의 노출 변경을 감지한다.
  // 재조회 실패도 fail-closed. 이 경우 slot은 보수적으로 15분 유지된다.
  let after: CapacityExposure | null = null;
  try { after = await deps.observeExposure(); } catch { /* unknown */ }
  return checkExposure(after, i.maxOpenPositions);
}
