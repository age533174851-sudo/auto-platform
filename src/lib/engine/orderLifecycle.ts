// src/lib/engine/orderLifecycle.ts
//
// 주문 생명주기 상태 기계.
//
// 왜 필요한가
// ───────────
// 지금은 상태 문자열이 여러 곳에서 각자 쓰인다. orderExecutor가 'ACKED'로
// 적고, 워커가 'PROCESSING'을 쓰고, 화면은 '체결'을 보여준다. 같은 주문을
// PC·모바일·워커·거래소가 서로 다르게 알고 있으면, 화면에서 성공했다고 떠도
// 거래소에서는 실패한 상태가 그대로 남는다.
//
// 여기서 상태와 "어디서 어디로 갈 수 있는지"를 한 곳에 정의한다. 허용되지
// 않은 전이는 거부하므로, 이미 실패로 확정된 주문이 나중에 체결로 바뀌는
// 식의 뒤집힘을 코드가 막는다.
//
// UNKNOWN에 대하여
// ────────────────
// "요청은 보냈는데 응답을 못 받은" 상태다. 거래소에 주문이 들어갔을 수도,
// 안 들어갔을 수도 있다. 이 상태에서 같은 주문을 다시 보내면 중복 체결이
// 된다. 그래서 UNKNOWN에서 나가는 길은 **거래소 조회로 확정하는 것뿐**이다.
// canRetry()가 UNKNOWN에 대해 항상 false를 돌려주는 이유다.

export type OrderState =
  | 'DRAFT'        // 작성 중 (아직 제출되지 않음)
  | 'PENDING'      // 사용자 확인 대기
  | 'APPROVED'     // 서버 위험 규칙 통과
  | 'SENT'         // 거래소로 전송함 (응답 대기)
  | 'ACKED'        // 거래소가 접수함
  | 'PARTIAL'      // 부분 체결
  | 'FILLED'       // 전체 체결
  | 'PROTECTED'    // 보호주문(손절) 부착 확인됨
  | 'CLOSED'       // 포지션 종료
  | 'REJECTED'     // 거래소가 거부
  | 'FAILED'       // 전송 전/중 실패 (거래소에 안 들어감이 확실)
  | 'CANCELED'     // 취소됨
  | 'UNKNOWN';     // 응답 없음 — 거래소 조회로 확정해야 함

/** 더 이상 변하지 않는 상태 */
export const TERMINAL: OrderState[] = ['CLOSED', 'REJECTED', 'FAILED', 'CANCELED'];

/**
 * 허용된 전이.
 *
 * SENT에서 UNKNOWN으로 갈 수 있는 것이 핵심이다 — 타임아웃·네트워크 오류는
 * 실패가 아니라 "모름"이다. 이를 FAILED로 처리하면 재시도해서 중복이 된다.
 */
const ALLOWED: Record<OrderState, OrderState[]> = {
  DRAFT:     ['PENDING', 'APPROVED', 'CANCELED'],
  PENDING:   ['APPROVED', 'CANCELED', 'REJECTED'],
  APPROVED:  ['SENT', 'CANCELED', 'FAILED'],
  SENT:      ['ACKED', 'PARTIAL', 'FILLED', 'REJECTED', 'FAILED', 'UNKNOWN'],
  ACKED:     ['PARTIAL', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN'],
  PARTIAL:   ['PARTIAL', 'FILLED', 'CANCELED', 'UNKNOWN'],
  FILLED:    ['PROTECTED', 'CLOSED'],
  PROTECTED: ['CLOSED', 'PARTIAL'],   // 부분 청산이 들어올 수 있다
  // UNKNOWN에서 나가는 길은 거래소 조회로 확정하는 것뿐이다.
  UNKNOWN:   ['ACKED', 'PARTIAL', 'FILLED', 'REJECTED', 'CANCELED', 'FAILED'],
  CLOSED:    [],
  REJECTED:  [],
  FAILED:    [],
  CANCELED:  [],
};

export function isTerminal(s: OrderState): boolean {
  return TERMINAL.includes(s);
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  if (from === to) return true;              // 같은 상태 재기록은 허용 (멱등)
  return (ALLOWED[from] || []).includes(to);
}

export interface TransitionResult {
  ok: boolean;
  state: OrderState;      // 적용 후 상태 (거부되면 원래 상태)
  reason?: string;
}

/**
 * 전이를 적용한다. 허용되지 않으면 상태를 바꾸지 않고 이유를 돌려준다.
 * 조용히 무시하지 않는 이유: 잘못된 전이는 어딘가의 논리 오류이므로
 * 호출자가 로그를 남길 수 있어야 한다.
 */
export function applyTransition(from: OrderState, to: OrderState): TransitionResult {
  if (from === to) return { ok: true, state: to };
  if (isTerminal(from)) {
    return { ok: false, state: from, reason: `${from}은 종료 상태라 ${to}로 바꿀 수 없습니다` };
  }
  if (!canTransition(from, to)) {
    return { ok: false, state: from, reason: `${from} → ${to}는 허용되지 않은 전이입니다` };
  }
  return { ok: true, state: to };
}

/**
 * 재전송해도 되는가.
 *
 * UNKNOWN은 절대 false다. 거래소에 들어갔을 수도 있는 주문을 다시 보내면
 * 중복 체결이 된다. 반드시 조회로 확정한 뒤 그 결과에서 다시 판단해야 한다.
 */
export function canRetry(state: OrderState): boolean {
  if (state === 'UNKNOWN') return false;
  if (isTerminal(state)) return state === 'FAILED';   // 전송 전 실패만 재시도 가능
  return state === 'APPROVED';
}

/** 조회로 확정이 필요한 상태 */
export function needsReconcile(state: OrderState): boolean {
  return state === 'UNKNOWN' || state === 'SENT';
}

// ── 거래소 응답 → 상태 ────────────────────────────────
// Binance 주문 status 문자열을 내부 상태로 옮긴다.
const EXCHANGE_MAP: Record<string, OrderState> = {
  NEW: 'ACKED',
  PARTIALLY_FILLED: 'PARTIAL',
  FILLED: 'FILLED',
  CANCELED: 'CANCELED',
  REJECTED: 'REJECTED',
  EXPIRED: 'CANCELED',
  EXPIRED_IN_MATCH: 'CANCELED',
};

export function fromExchangeStatus(raw: string | null | undefined): OrderState | null {
  if (!raw) return null;
  return EXCHANGE_MAP[String(raw).toUpperCase()] ?? null;
}

/** 사용자에게 보여줄 한국어 라벨 */
export const STATE_LABEL: Record<OrderState, string> = {
  DRAFT: '작성 중',
  PENDING: '확인 대기',
  APPROVED: '서버 승인',
  SENT: '거래소 전송',
  ACKED: '접수됨',
  PARTIAL: '부분 체결',
  FILLED: '전체 체결',
  PROTECTED: '보호주문 확인',
  CLOSED: '종료',
  REJECTED: '거부됨',
  FAILED: '실패',
  CANCELED: '취소됨',
  UNKNOWN: '확인 필요',
};

/** 진행률 표시용 순서 (분기 상태는 제외) */
export const HAPPY_PATH: OrderState[] = [
  'DRAFT', 'PENDING', 'APPROVED', 'SENT', 'ACKED', 'PARTIAL', 'FILLED', 'PROTECTED', 'CLOSED',
];

export function progressIndex(state: OrderState): number {
  const i = HAPPY_PATH.indexOf(state);
  return i >= 0 ? i : -1;   // -1이면 정상 경로를 벗어난 상태
}
