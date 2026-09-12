// src/lib/engine/paperChallenge.ts
//
// **챌린지의 낱말을 한 곳에서 정한다.**
//
// 여기 있는 것은 전부 순수 함수와 목록이다. DB를 부르지 않고, 돈을 움직이지
// 않고, 아무 상태도 바꾸지 않는다. 회계(PR2)·finalizer(PR3)·배선(PR4)은
// 여기 없다.
//
// 왜 지금 만드는가
// ────────────────
// 이 저장소가 반복해서 겪은 고장이 **"경로가 둘인데 한쪽만 고침"**이다.
// 상태 이름·사유 이름·현금 흐름 종류가 SQL의 CHECK와 TS에 따로 적히면,
// 나중에 하나가 늘 때 한쪽만 는다. 그러면 DB가 거부하는 값을 코드가 만들거나
// (런타임 폭발), 코드가 모르는 값을 DB가 받아들인다(조용한 오염).
//
// 그래서 **여기 적힌 목록이 정본**이고, `scripts/check-paper-challenge-core.mjs`가
// `083` 마이그레이션의 CHECK 제약과 같은 집합인지 확인한다. 한쪽만 고치면
// CI가 멈춘다. 이 파일이 아직 제품 경로에서 불리지 않는 동안에도 **배선은
// 이미 되어 있다** — 검사기가 소비자다.
//
// 돈의 정본은 여기가 아니다
// ─────────────────────────
// Money Authority는 `paper_accounts.balance` 하나다. 이 파일의 합계 함수는
// 그 잔고를 **설명**하는 계산일 뿐 잔고가 아니다.

// ══════════════ 상태 ══════════════

/**
 * 챌린지가 지금 어디에 있는가.
 *
 *   READY    `starts_at` 이전. 아직 시작하지 않았다
 *   RUNNING  활성 기간. **첫 주문 여부와 무관하다** — 주문이 한 번도 없어도
 *            기간은 흐르고 만료될 수 있어야 한다
 *   CLOSING  끝내기로 정해졌고(사유가 이미 고정됐고) 포지션을 정리하는 중
 *   CLOSED   끝났다
 */
export type ChallengeStatus = 'READY' | 'RUNNING' | 'CLOSING' | 'CLOSED';

/** `083`의 `paper_challenges_status_chk`와 같은 집합이어야 한다 (검사기가 확인한다). */
export const CHALLENGE_STATUSES: ChallengeStatus[] = ['READY', 'RUNNING', 'CLOSING', 'CLOSED'];

/**
 * 아직 끝나지 않은 상태들.
 *
 * **사용자당 하나**를 보장하는 부분 유니크 인덱스
 * (`paper_challenges_one_active_per_user`)의 `WHERE` 절과 같은 집합이다.
 * 한쪽만 늘어나면 "활성이 둘"이 조용히 가능해진다.
 */
export const ACTIVE_CHALLENGE_STATUSES: ChallengeStatus[] = ['READY', 'RUNNING', 'CLOSING'];

export function isActiveChallengeStatus(s: string | null | undefined): boolean {
  return ACTIVE_CHALLENGE_STATUSES.indexOf(s as ChallengeStatus) >= 0;
}

// ══════════════ 왜 끝나는가 ══════════════

/**
 * 끝나는 사유. **한 번 정해지면 바뀌지 않는다.**
 *
 * `status`(어디에 있는가)와 분리한다. 둘을 한 칸에 섞으면 "목표를 달성했는데
 * 정리 중 강제청산 손실로 목표 아래로 내려간" 경우를 적을 수가 없다.
 */
export type CloseIntent = 'TARGET_REACHED' | 'EXPIRED' | 'FAILED' | 'CANCELLED';

/** `083`의 `paper_challenges_intent_chk`와 같은 집합이어야 한다. */
export const CLOSE_INTENTS: CloseIntent[] = ['TARGET_REACHED', 'EXPIRED', 'FAILED', 'CANCELLED'];

/**
 * 사유를 정한다 — **이미 정해져 있으면 그대로 둔다.**
 *
 * 이것이 "TARGET_REACHED 불가역" 계약의 코드 쪽 절반이다. 유효기간 안에서
 * 목표에 처음 닿는 순간 사유가 고정되고, 그 뒤 무슨 일이 있어도 다시 판단하지
 * 않는다. 나머지 절반은 DB가 강제한다:
 *
 *   CHECK (terminal_status IS NULL OR terminal_status = close_intent)
 *
 * 여기서 `frozen`이 true로 돌아오면 **부르는 쪽은 `proposed`를 버린다.**
 * 덮어쓰면 제약이 거부하는 것이 아니라, 사유가 조용히 바뀐다.
 */
export function freezeCloseIntent(
  current: CloseIntent | null | undefined,
  proposed: CloseIntent,
): { intent: CloseIntent; frozen: boolean; reason: string } {
  if (current) {
    return {
      intent: current,
      frozen: true,
      reason: current === proposed
        ? '이미 같은 사유로 정해져 있습니다'
        : `사유는 이미 ${current}로 정해졌습니다 — ${proposed}로 바꾸지 않습니다`,
    };
  }
  return { intent: proposed, frozen: false, reason: '사유를 처음 정했습니다' };
}

/**
 * 최종 상태는 **고정된 사유를 그대로 옮긴 것**이다.
 *
 * 마지막 잔고를 보고 다시 판단하지 않는다. 사유가 없으면 끝낼 수 없다 —
 * `null`을 돌려주고 부르는 쪽이 거기서 멈춘다. `083`의
 * `paper_challenges_closing_needs_intent_chk`가 같은 말을 DB에서 한다.
 */
export function terminalStatusFor(intent: CloseIntent | null | undefined): CloseIntent | null {
  return intent ? intent : null;
}

// ══════════════ 전이 ══════════════

/**
 * 갈 수 있는 길. 여기 없는 전이는 없는 것이다.
 *
 *   READY   → RUNNING   기간이 시작됐다
 *   READY   → CLOSING   시작 전에 취소했다 (사유가 이미 있어야 한다)
 *   RUNNING → CLOSING   목표·실패·만료·취소 중 하나가 정해졌다
 *   CLOSING → CLOSED    정리가 끝났다
 *
 * **되돌아가는 길이 없다.** CLOSED에서 나가는 길도 없다. 제자리 전이도 없다 —
 * 같은 사건이 두 번 도착한 것은 전이가 아니라 중복이고, 그건
 * `(challenge_id, transition_key)` 유니크가 처리한다.
 */
const TRANSITIONS: Array<[ChallengeStatus, ChallengeStatus]> = [
  ['READY', 'RUNNING'],
  ['READY', 'CLOSING'],
  ['RUNNING', 'CLOSING'],
  ['CLOSING', 'CLOSED'],
];

export function transitionAllowed(from: string, to: string): boolean {
  return TRANSITIONS.some(([a, b]) => a === from && b === to);
}

/** 어디로 갈 수 있는가 — 화면·검사가 쓰기 좋은 모양. */
export function allowedNextStatuses(from: string): ChallengeStatus[] {
  return TRANSITIONS.filter(([a]) => a === from).map(([, b]) => b);
}

// ══════════════ 돈 사건 ══════════════

/**
 * 잔고를 설명하는 네 가지.
 *
 *   balance = INITIAL_DEPOSIT + REALIZED_PNL + TRADING_FEE(음수) + FUNDING
 *
 * `REALIZED_PNL`은 **수수료 차감 전 gross 실현손익**이다. 이름은 그대로 두되
 * 뜻을 못박는다 — 순액(net)을 적으면 같은 체결의 `TRADING_FEE` 줄과 겹쳐
 * 수수료가 두 번 빠지고, `SUM(amount) = balance`가 깨진다.
 */
export type CashflowType = 'INITIAL_DEPOSIT' | 'REALIZED_PNL' | 'TRADING_FEE' | 'FUNDING';

/** `083`의 `paper_challenge_cashflows_type_chk`와 같은 집합이어야 한다. */
export const CASHFLOW_TYPES: CashflowType[] =
  ['INITIAL_DEPOSIT', 'REALIZED_PNL', 'TRADING_FEE', 'FUNDING'];

/** 이 돈 사건을 일으킨 것. `083`의 `..._source_chk`와 같은 집합이어야 한다. */
export type SourceEventType =
  'CHALLENGE_CREATE' | 'POSITION_OPEN' | 'POSITION_CLOSE' | 'FUNDING_ACCRUAL';

export const SOURCE_EVENT_TYPES: SourceEventType[] =
  ['CHALLENGE_CREATE', 'POSITION_OPEN', 'POSITION_CLOSE', 'FUNDING_ACCRUAL'];

/**
 * 부호 계약.
 *
 *   INITIAL_DEPOSIT  > 0    시작금은 주는 것이다
 *   TRADING_FEE      <= 0   **수수료는 음수다.** 양수로 적으면 잔고가 는다
 *   REALIZED_PNL     자유    손실이면 음수
 *   FUNDING          자유    받을 수도 낼 수도 있다
 *
 * `083`의 `..._deposit_sign_chk` · `..._fee_sign_chk`와 같은 규칙이다. 여기서
 * 먼저 막는 이유는, DB가 거부할 때는 이미 트랜잭션 한복판이기 때문이다.
 */
export function cashflowSignOk(type: string, amount: number): boolean {
  if (!Number.isFinite(amount)) return false;
  if (type === 'INITIAL_DEPOSIT') return amount > 0;
  if (type === 'TRADING_FEE') return amount <= 0;
  return CASHFLOW_TYPES.indexOf(type as CashflowType) >= 0;
}

/**
 * 멱등 키 — `083`의 `paper_challenge_cashflows_idem_key`와 **같은 네 칸**이다.
 *
 * `cashflow_type`이 키에 들어 있다는 것이 요점이다. **같은 체결 하나**가
 * `REALIZED_PNL` 한 줄과 `TRADING_FEE` 한 줄을 만들기 때문에, 체결 id 하나를
 * 전역 키로 쓰면 둘 중 하나가 사라진다.
 */
export function cashflowIdempotencyKey(i: {
  challengeId: string;
  cashflowType: CashflowType;
  sourceEventType: SourceEventType;
  sourceEventId: string;
}): string {
  return [i.challengeId, i.cashflowType, i.sourceEventType, i.sourceEventId].join(' ');
}

/**
 * 원장이 설명하는 잔고.
 *
 * **이 값이 잔고인 것이 아니다.** 정본은 `paper_accounts.balance`이고, 이
 * 합계는 그것과 같아야 한다는 불변식의 왼쪽일 뿐이다. 그 불변식을 실제로
 * 유지하는 책임은 PR2의 회계 경로에 있다.
 *
 * 읽을 수 없는 값이 하나라도 섞이면 **NaN을 그대로 돌려준다.** 0으로 적지
 * 않는다 — 확인하지 못한 것은 통과가 아니다.
 */
export function sumCashflowAmounts(rows: Array<{ amount: number | string }>): number {
  let sum = 0;
  for (const r of rows || []) {
    const raw = r == null ? null : r.amount;
    const v = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof v !== 'number' || !Number.isFinite(v)) return NaN;
    sum += v;
  }
  return sum;
}
