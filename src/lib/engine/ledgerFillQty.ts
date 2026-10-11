// src/lib/engine/ledgerFillQty.ts
//
// **장부에서 "실제로 체결된 수량"을 읽는 한 곳.**
//
// 왜 생겼나
// ─────────
// 쓰는 쪽을 정직하게 고쳤더니(`orderFillFacts`) 체결을 확인하지 못한 줄의
// `filled_qty`가 `null`이 됐다. 그런데 읽는 쪽 세 곳이 이렇게 돼 있었다:
//
//     const qty = Number(r.filled_qty ?? r.quantity) || 0;
//
// `?? r.quantity`가 **그 null을 요청 수량으로 메운다.** 즉 "모르는 것"이
// 다시 "요청만큼 체결됨"으로 읽힌다 — 없애려던 결함이 읽는 쪽으로 옮겨
// 앉은 것이다. 세 곳이 각자 같은 식을 적고 있었으니 한쪽을 고쳐도
// 나머지가 남는다.
//
// 왜 동작을 바꾸지 않았나
// ───────────────────────
// 대신 쓰는 것을 **그만두면** 순포지션이 과소 보고된다. 그러면 시스템이
// "포지션 없음"으로 보고 청산 감시를 건너뛸 수 있다 — 보호 없는 포지션이
// 남는 쪽이 더 나쁘다. 과다 보고는 진입을 막는 방향이라 그보다 안전하다.
// (진입 쪽은 어차피 계좌 용량 관문이 **거래소 노출**을 직접 읽는다.)
//
// 그래서 수량 계산은 그대로 두고, **추정했다는 사실을 드러낸다.**
// 조용히 확신하는 것을 멈추는 것이 이 파일의 목적이다. 값을 고르는 규칙이
// 한 곳에 있으니, 나중에 정책을 바꾸려면 여기만 바꾸면 된다.

export interface LedgerFillRow {
  filled_qty?: unknown;
  quantity?: unknown;
}

export interface LedgerFillRead {
  /** 포지션 계산에 쓸 수량 */
  qty: number;
  /**
   * `filled_qty`가 없어서 **요청 수량으로 대신한** 것인가.
   *
   * true면 이 수량은 거래소가 증명한 값이 아니다. 부르는 쪽은 이것을
   * 세서 응답에 드러내야 한다 — 확인하지 못한 것을 통과로 적지 않는다.
   */
  assumed: boolean;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

export function ledgerFillQty(row: LedgerFillRow | null | undefined): LedgerFillRead {
  const r = row ?? {};

  // 거래소가 증명한 값이 있으면 그것뿐이다. 0도 사실이다 — "안 채워졌다".
  const filled = num(r.filled_qty);
  if (filled != null && filled >= 0) return { qty: filled, assumed: false };

  // 없으면 요청 수량으로 대신한다. **대신했다는 사실을 함께 돌려준다.**
  const requested = num(r.quantity);
  if (requested != null && requested > 0) return { qty: requested, assumed: true };

  return { qty: 0, assumed: false };
}
