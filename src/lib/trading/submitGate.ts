// src/lib/trading/submitGate.ts
//
// **주문 버튼이 잠겼으면, 왜 잠겼는지 같이 내놓는다.**
//
// 무엇이 고장이었나
// ─────────────────
// 실기에서 이런 화면이 나왔다: 로그인돼 있고, 가용 60,040 P가 읽혔고,
// 비중 55%에 증거금 33,022 P와 수량 4.3052까지 계산됐는데 **주문 버튼만
// 회색이었다.** 사용자는 무엇을 더 해야 하는지 알 수 없다.
//
// 원인은 선물에 손절이 필수라는 것이었고(`buildPaperPlan`), 화면이 그
// 사유를 어디에도 적지 않았다. 판정은 맞았고 **말을 안 한 것이 고장이다.**
//
// 그래서 여기서는 `ready`만 돌려주지 않는다. 막혔으면 **막은 이유를 함께**
// 돌려준다. 이유 없는 잠금은 이 파일을 통과하지 못한다.

export type SubmitBlock =
  | 'NONE'
  /** 이 장부·모드·시장에서 주문 자체를 받지 않는다 */
  | 'NOT_ALLOWED'
  /** 수량이 아직 없다 (비중 0 또는 잔고·시세 못 읽음) */
  | 'NO_QUANTITY'
  /** 계획이 거절됐다 (손절 없음·증거금 부족 등) */
  | 'PLAN_REJECTED';

export interface SubmitGate {
  ready: boolean;
  block: SubmitBlock;
  /** 막혔으면 **반드시** 한 줄이 있다. 통과면 null */
  reason: string | null;
}

export interface SubmitGateInput {
  canOrder: boolean;
  /** 주문을 못 받는 사유 (권한·장부·모드) */
  blockedReason?: string | null;
  quantity: number | null | undefined;
  /** 비중 계산이 막힌 사유 (잔고 못 읽음 등) */
  sizingReason?: string | null;
  planOk: boolean;
  planReason?: string | null;
}

/**
 * 순서가 뜻이다. **먼저 걸리는 것이 사용자가 먼저 해결할 것**이다.
 *
 *   권한 → 수량 → 계획
 *
 * 권한이 없는데 "손절가가 없습니다"라고 적으면, 손절을 넣어도 안 열린다.
 */
export function submitGate(i: SubmitGateInput): SubmitGate {
  if (!i.canOrder) {
    return {
      ready: false, block: 'NOT_ALLOWED',
      reason: i.blockedReason || '지금은 이 장부로 주문할 수 없습니다',
    };
  }
  const q = i.quantity;
  if (q == null || !Number.isFinite(q) || q <= 0) {
    return {
      ready: false, block: 'NO_QUANTITY',
      reason: i.sizingReason || '비중을 정하면 수량이 계산됩니다',
    };
  }
  if (!i.planOk) {
    return {
      ready: false, block: 'PLAN_REJECTED',
      reason: i.planReason || '주문 계획이 거절됐습니다',
    };
  }
  return { ready: true, block: 'NONE', reason: null };
}

/** 버튼에 적을 글자. 막혔으면 **버튼 자체가 무엇이 필요한지 말한다.** */
export function submitLabel(gate: SubmitGate, sideLabel: string, symbol: string): string {
  if (gate.ready) return `${sideLabel} ${symbol}`;
  if (gate.block === 'NO_QUANTITY') return '비중을 정하세요';
  if (gate.block === 'PLAN_REJECTED') return '주문 조건을 확인하세요';
  return '주문할 수 없습니다';
}
