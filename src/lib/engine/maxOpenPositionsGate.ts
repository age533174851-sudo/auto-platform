// src/lib/engine/maxOpenPositionsGate.ts
//
// Exact100X 계약의 maxOpenPositions=1을 실거래 TESTNET 연결 전체에 배선.
// BTC/ETH가 각각 신호를 내도 DB의 동일 UNIQUE(key)를 경쟁한다.
// 15분 동안 다른 진입을 막는 보수적인 inflight 윈도우다.
// 이것만으로 거래소/외부 매매까지 strict single-writer인 것은 아니다.
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
  countPendingEntries: () => Promise<number | null>;
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
