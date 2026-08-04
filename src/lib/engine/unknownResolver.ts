// src/lib/engine/unknownResolver.ts
//
// UNKNOWN 주문을 거래소 조회로 확정한다.
//
// 왜 필요한가
// ───────────
// 2번에서 "UNKNOWN이면 재전송하지 않는다"까지는 막았다. 그런데 막기만 하면
// 주문이 영원히 미확정으로 남는다. 나가는 유일한 길은 거래소에 물어보는
// 것이므로, 그 물어본 결과를 어떻게 해석할지가 여기 있다.
//
// 핵심 원칙: **증거가 부족하면 확정하지 않는다.**
// 특히 "주문이 조회에 안 나온다 → 실패다 → 재시도해도 된다"는 추론이
// 중복 체결로 이어지는 전형적인 경로다. 조회가 실패했을 수도, 거래소가 아직
// 반영을 안 했을 수도, 우리가 잘못된 id로 물어봤을 수도 있다.
// 그래서 FAILED로 확정하는 조건을 좁게 잡았다.
//
// 이 파일은 순수 함수다. 네트워크·DB를 모르므로 조회 결과만 넣으면
// 테스트에서 모든 경우를 재현할 수 있다.

import { fromExchangeStatus, type OrderState } from './orderLifecycle';

/** 거래소 주문 조회 결과 */
export interface OrderQuery {
  /** 조회 자체가 성공했는가. false면 거래소에 못 닿은 것이다 (주문 유무와 무관) */
  ok: boolean;
  /** 조회된 주문. 조회는 됐으나 주문이 없으면 null */
  order: { status?: string | null; orderId?: number | string; executedQty?: number } | null;
  error?: string;
}

/** 포지션 조회 결과 — 주문이 안 보일 때 반대 증거로 쓴다 */
export interface PositionEvidence {
  /** 지금 포지션 수량 (부호 있음). 조회 실패면 null */
  qtyNow: number | null;
  /** 주문을 보내기 직전에 알고 있던 수량 */
  qtyBefore: number;
}

export interface ResolveInput {
  /** 전송 전에 우리가 붙인 멱등 키. 없으면 우리 주문을 식별할 방법이 없다 */
  clientOrderId: string | null | undefined;
  /** 전송 시점부터 지난 시간(ms) */
  elapsedMs: number;
  query: OrderQuery;
  position?: PositionEvidence;
}

export type ResolveAction =
  | 'NONE'          // 확정됨. 더 할 일 없음
  | 'RETRY_QUERY'   // 아직 모른다. 잠시 후 다시 조회
  | 'ESCALATE';     // 자동으로 판단할 수 없다. 사람이 봐야 한다

export interface ResolveResult {
  state: OrderState;
  /** 확정됐는가. false면 여전히 UNKNOWN */
  resolved: boolean;
  action: ResolveAction;
  reason: string;
}

/**
 * 거래소가 주문을 반영하기까지 기다려 주는 시간.
 * 이 시간 안에 "안 보인다"는 것은 실패의 증거가 되지 않는다.
 */
export const REFLECT_GRACE_MS = 5_000;

/** 포지션 수량 비교 허용 오차 (수량 자체가 작을 수 있으므로 절대값 기준도 둔다) */
const QTY_EPS = 1e-8;

function qtyChanged(p: PositionEvidence): boolean {
  if (p.qtyNow === null) return false;
  const diff = Math.abs(p.qtyNow - p.qtyBefore);
  const base = Math.max(Math.abs(p.qtyBefore), Math.abs(p.qtyNow), QTY_EPS);
  return diff / base > 0.001;   // 0.1% 넘게 달라졌으면 변한 것으로 본다
}

export function resolveUnknown(input: ResolveInput): ResolveResult {
  const { clientOrderId, elapsedMs, query, position } = input;

  // ── 1. 거래소에 못 닿았다 ──
  // 주문이 없다는 뜻이 아니다. 아무것도 확정할 수 없다.
  if (!query.ok) {
    return {
      state: 'UNKNOWN', resolved: false, action: 'RETRY_QUERY',
      reason: `거래소 조회 실패 — 주문 유무를 알 수 없습니다: ${query.error || '사유 미상'}`,
    };
  }

  // ── 2. 주문이 조회됐다 ──
  if (query.order) {
    const mapped = fromExchangeStatus(query.order.status);
    if (!mapped) {
      // 모르는 상태 문자열을 임의로 매핑하면 조용히 틀린 판정을 한다.
      return {
        state: 'UNKNOWN', resolved: false, action: 'ESCALATE',
        reason: `거래소가 해석할 수 없는 상태를 돌려줬습니다: ${query.order.status ?? '(없음)'}`,
      };
    }
    return {
      state: mapped, resolved: true, action: 'NONE',
      reason: `거래소 조회로 확정: ${query.order.status}`,
    };
  }

  // ── 3. 조회는 됐는데 주문이 없다 ──
  // 여기가 위험 구간이다. "없다 → 실패다 → 재시도"가 중복의 주 경로다.

  // 3-a. 멱등 키가 없으면 우리 주문을 식별할 방법 자체가 없다.
  // "안 보인다"가 "안 들어갔다"를 뜻하지 않으므로 절대 자동 확정하지 않는다.
  if (!clientOrderId) {
    return {
      state: 'UNKNOWN', resolved: false, action: 'ESCALATE',
      reason: '멱등 키(clientOrderId) 없이 전송된 주문이라 거래소에서 식별할 수 없습니다. ' +
              '수동으로 거래 내역을 확인해야 합니다.',
    };
  }

  // 3-b. 거래소가 아직 반영하지 못했을 수 있다.
  if (elapsedMs < REFLECT_GRACE_MS) {
    return {
      state: 'UNKNOWN', resolved: false, action: 'RETRY_QUERY',
      reason: `전송 후 ${Math.round(elapsedMs)}ms — 거래소 반영 대기 시간(${REFLECT_GRACE_MS}ms) 내입니다`,
    };
  }

  // 3-c. 포지션으로 교차 확인한다.
  if (position) {
    if (position.qtyNow === null) {
      // 주문도 안 보이고 포지션도 못 읽었다. 증거가 반쪽이다.
      return {
        state: 'UNKNOWN', resolved: false, action: 'RETRY_QUERY',
        reason: '주문이 조회되지 않지만 포지션을 읽지 못해 교차 확인을 못 했습니다',
      };
    }
    if (qtyChanged(position)) {
      // 모순이다. 주문은 없다는데 포지션은 움직였다.
      // 다른 경로가 계좌를 건드렸거나 우리가 잘못된 id로 물었다.
      // 어느 쪽이든 자동으로 재시도하면 안 된다.
      return {
        state: 'UNKNOWN', resolved: false, action: 'ESCALATE',
        reason: `주문은 조회되지 않는데 포지션이 변했습니다 ` +
                `(${position.qtyBefore} → ${position.qtyNow}). 자동 판단하지 않습니다.`,
      };
    }
  }

  // 3-d. 멱등 키로 물었고, 반영 시간이 지났고, 포지션도 그대로다.
  // 여기까지 와야 "거래소에 안 들어갔다"고 볼 수 있다.
  return {
    state: 'FAILED', resolved: true, action: 'NONE',
    reason: position
      ? '멱등 키로 조회했으나 주문이 없고 포지션도 변하지 않았습니다 — 전송되지 않은 것으로 확정합니다'
      : '멱등 키로 조회했으나 주문이 없습니다 — 전송되지 않은 것으로 확정합니다 (포지션 교차 확인 없음)',
  };
}

/**
 * 다음 조회까지 기다릴 시간. 지수 백오프하되 상한을 둔다.
 * 상한이 없으면 장시간 미확정 주문의 확인이 몇 분 단위로 늘어진다.
 */
export function nextQueryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), 30_000);
}

/**
 * 이 이상 시도했는데도 확정이 안 되면 자동 조회를 멈추고 사람에게 넘긴다.
 * 계속 돌리면 미확정 주문 하나가 조회 요청으로 레이트리밋을 소모한다.
 */
export const MAX_RESOLVE_ATTEMPTS = 8;

export function shouldEscalate(attempt: number): boolean {
  return attempt >= MAX_RESOLVE_ATTEMPTS;
}

// ── ACKED는 UNKNOWN과 규칙이 다르다 ──────────────────────────
//
// **위 resolveUnknown을 ACKED에 그대로 쓰면 안 된다.**
//
// resolveUnknown의 마지막 규칙(3-d)은 "멱등 키로 물었는데 주문이 없고
// 포지션도 그대로면 → 전송되지 않은 것(FAILED)"이다. SENT/UNKNOWN에는
// 맞다. 그 상태는 "보냈는지도 모르는" 상태니까.
//
// **ACKED는 다르다.** 거래소가 주문을 받았다고 이미 확인해 줬고, 우리는
// exchange_order_id까지 갖고 있다. 그런데 지금 조회에 안 나온다면 그건
// "안 들어갔다"가 아니라 **이미 끝났다**는 뜻이다 — 체결됐거나 취소됐고,
// 거래소의 조회 창(대개 며칠)에서 밀려났다.
//
// 그걸 FAILED로 찍으면 두 가지가 망가진다:
//   · 장부가 거짓말을 한다 (나간 주문을 안 나갔다고 기록)
//   · FAILED는 재시도가 열리는 상태다 → 중복 체결의 문
//
// 그리고 이 구멍 때문에 실제로 무슨 일이 있었나
// ─────────────────────────────────────────
// reconcilePendingOrders는 `status IN ('SENT','UNKNOWN')`만 조회했다.
// **ACKED가 빠져 있었다.** 그래서 ACKED로 들어간 주문은 그 뒤로 아무도
// 건드리지 않고 영원히 ACKED에 남았다.
//
// 그런데 상태 대조(gatherAndReconcile)는 ACKED를 "열려 있는 주문"이자
// (수량이 있으면) "보유 중인 포지션"으로 읽는다. 결과: 거래소에는
// 아무것도 없는데 앱은 계속 있다고 믿고, **신규 진입이 영구히 막힌다.**
// [미확정 주문 확정]을 눌러도 안 풀린다 — 그 버튼이 ACKED를 안 보니까.

/**
 * 거래소가 받았다고 확인해 준(ACKED) 주문의 지금 상태를 판정한다.
 *
 * 확정할 수 없으면 **확정하지 않는다.** 여기서 잘못 확정하면 장부가
 * 조용히 틀리고, 그 틀린 장부가 다음 주문을 막거나 열어 준다.
 */
/**
 * ACKED 판정 결과.
 *
 * 'RECONCILED'는 생명주기 상태가 아니라 **장부 상태**다 — "거래소에서
 * 더 이상 살아 있지 않다. 최종 결과는 거래 내역에서 확인해야 한다."
 * OrderState에 억지로 밀어 넣지 않고 여기서만 넓힌다. 억지로 넣으면
 * 상태 기계의 전이 표가 거짓말을 하게 된다.
 */
export interface AckedResolveResult extends Omit<ResolveResult, 'state'> {
  state: OrderState | 'RECONCILED';
}

export function resolveAcked(input: ResolveInput): AckedResolveResult {
  const { clientOrderId, elapsedMs, query, position } = input;

  // 1. 거래소에 못 닿았으면 아무것도 바꾸지 않는다.
  if (!query.ok) {
    return {
      state: 'ACKED', resolved: false, action: 'RETRY_QUERY',
      reason: `거래소 조회 실패 — 상태를 확인할 수 없습니다: ${query.error || '사유 미상'}`,
    };
  }

  // 2. 주문이 조회됐으면 거래소 상태를 그대로 따른다.
  if (query.order) {
    const mapped = fromExchangeStatus(query.order.status);
    if (!mapped) {
      return {
        state: 'ACKED', resolved: false, action: 'ESCALATE',
        reason: `거래소가 해석할 수 없는 상태를 돌려줬습니다: ${query.order.status ?? '(없음)'}`,
      };
    }
    return { state: mapped, resolved: true, action: 'NONE',
      reason: `거래소 조회로 확정: ${query.order.status}` };
  }

  // 3. 조회는 됐는데 주문이 없다.
  if (!clientOrderId) {
    return {
      state: 'ACKED', resolved: false, action: 'ESCALATE',
      reason: '멱등 키가 없어 거래소에서 이 주문을 식별할 수 없습니다',
    };
  }
  if (elapsedMs < REFLECT_GRACE_MS) {
    return {
      state: 'ACKED', resolved: false, action: 'RETRY_QUERY',
      reason: `전송 후 ${Math.round(elapsedMs)}ms — 거래소 반영 대기 시간 내입니다`,
    };
  }

  // **여기가 UNKNOWN과 갈리는 지점이다.**
  // 거래소가 받았다고 했던 주문이 이제 안 보인다 = 더 이상 살아 있지
  // 않다. 체결인지 취소인지는 이 조회로 알 수 없으므로 **그렇게 말한다.**
  // RECONCILED는 "이 주문은 끝났고, 최종 결과는 거래 내역에서 확인해야
  // 한다"는 뜻이다 — FILLED로도 FAILED로도 단정하지 않는다.
  return {
    state: 'RECONCILED', resolved: true, action: 'NONE',
    reason: position && position.qtyNow !== null && !qtyChanged(position)
      ? '거래소가 받았던 주문이 더 이상 조회되지 않고 포지션도 그대로입니다 — '
        + '이미 종료된 주문으로 정리합니다 (체결·취소 여부는 거래 내역에서 확인하세요)'
      : '거래소가 받았던 주문이 더 이상 조회되지 않습니다 — '
        + '이미 종료된 주문으로 정리합니다 (체결·취소 여부는 거래 내역에서 확인하세요)',
  };
}
