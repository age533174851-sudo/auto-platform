// src/lib/engine/stopLedger.ts
//
// **손절을 옮기면 장부가 새 번호를 기억해야 한다.**
//
// 무엇이 있었나
// ─────────────
// 진입 때는 제대로 돌고 있었다:
//
//     SL 생성 → 거래소 orderId 받음 → live_orders.sl_order_id 저장
//
// 그래서 나중에 그 주문이 고아로 남았을 때 **정확히 "내 것"이라고
// 증명할 수 있다.** 고아 정리(`flatCleanupPlan`)는 적어 둔
// `sl_order_id`·`tp_order_id`를 **1순위 소유 증거**로 쓰고, 청산 감시는
// `ownedOnly: true`로 **그 번호와 일치하는 것만** 지운다.
//
// 그런데 트레일링은 이랬다:
//
//     placeStop() → 새 orderId 받음 → 옛 STOP 취소
//                                   → ladder_daily_trades.exit_reason만 수정
//
// **새 번호를 아무 데도 안 적었다.** 그래서 손절을 한 번이라도 옮긴
// 포지션은, 그 손절이 나중에 고아가 됐을 때 소유를 증명하지 못한다.
// 정리 코드는 안전을 이유로 안 지우고(그게 맞다 — 남의 손절을 지우는
// 것이 가장 큰 사고다), 그 손절은 거래소에 계속 남는다.
//
// 순서도 중요하다
// ───────────────
// **새 번호를 먼저 적고 옛 손절을 취소한다.**
//
// 반대로 하면 취소와 기록 사이에 요청이 끊겼을 때 장부에 옛 번호만
// 남는다. 그 번호는 이미 없는 주문이라 정리가 아무것도 못 찾고,
// 실제로 걸려 있는 새 손절은 **장부에 없어서 남의 것으로 보인다.**
//
// 기록이 실패해도 취소로 넘어가지 않는다. 손절이 잠깐 둘인 것은
// 위험하지 않다(둘 다 전량을 닫으므로 먼저 걸리는 쪽이 끝낸다).
// **번호를 잃는 쪽이 훨씬 비싸다.**

export type StopLedgerCode =
  /** 새 번호를 적었다 */
  | 'RECORDED'
  /** 거래소가 주문 번호를 안 줬다 — 적을 것이 없다 */
  | 'NO_ORDER_ID'
  /** 어느 줄에 적을지 모른다 */
  | 'NO_TARGET_ROW'
  /** 적으려다 실패했다 */
  | 'WRITE_FAILED';

export interface StopLedgerVerdict {
  code: StopLedgerCode;
  /** 새 번호가 장부에 남았는가 */
  recorded: boolean;
  /**
   * 옛 손절을 취소해도 되는가.
   *
   * **번호를 못 적었으면 취소하지 않는다.** 취소해 버리면 장부에는
   * 없는 옛 번호만 남고, 실제로 걸린 새 손절은 남의 것으로 보인다.
   */
  cancelOld: boolean;
  reason: string;
}

/**
 * 새 손절 번호를 적을 수 있는가, 그리고 옛 것을 취소해도 되는가.
 *
 * **순수 함수다.** 여기가 틀리면 손절이 사라지거나 고아가 된다.
 */
export function stopLedgerVerdict(i: {
  /** 거래소가 준 새 손절 주문 번호 */
  newOrderId: string | null | undefined;
  /** 적을 대상 줄을 찾았는가 */
  targetFound: boolean;
  /** 적기가 성공했는가. 시도 안 했으면 null */
  writeOk: boolean | null;
}): StopLedgerVerdict {
  const id = String(i.newOrderId ?? '').trim();
  if (!id) {
    return {
      code: 'NO_ORDER_ID', recorded: false, cancelOld: false,
      reason: '거래소가 새 손절의 주문 번호를 주지 않았습니다 — 적을 것이 없어 '
        + '옛 손절을 취소하지 않습니다(취소하면 지금 걸린 손절이 장부에서 남의 것이 됩니다)',
    };
  }
  if (!i.targetFound) {
    return {
      code: 'NO_TARGET_ROW', recorded: false, cancelOld: false,
      reason: '새 손절 번호를 적을 진입 기록을 찾지 못했습니다 — 옛 손절을 취소하지 않습니다',
    };
  }
  if (i.writeOk !== true) {
    return {
      code: 'WRITE_FAILED', recorded: false, cancelOld: false,
      reason: '새 손절 번호를 장부에 적지 못했습니다 — 옛 손절을 취소하지 않습니다. '
        + '손절이 잠깐 둘인 것은 위험하지 않습니다(둘 다 전량을 닫습니다)',
    };
  }
  return {
    code: 'RECORDED', recorded: true, cancelOld: true,
    reason: `새 손절 번호를 장부에 적었습니다 (${id})`,
  };
}

export interface LedgerRow {
  id?: any;
  client_order_id?: any;
  sl_order_id?: any;
  created_at?: any;
}

/**
 * 새 번호를 어느 줄에 적을 것인가.
 *
 * **진입 식별자가 1순위다.** 같은 연결·종목에 여러 주문이 쌓여 있어도
 * 그 거래의 진입 줄은 하나뿐이다.
 *
 * 못 찾으면 **손절 번호를 들고 있는 가장 최근 줄**로 내려간다. 그것도
 * 없으면 `null` — 아무 줄에나 적지 않는다. 엉뚱한 줄에 적으면 다른
 * 거래의 손절 번호를 덮어써서, 그 거래의 손절이 고아가 된다.
 */
export function pickStopLedgerRow(
  rows: LedgerRow[] | null | undefined,
  entryClientOrderId: string | null,
): LedgerRow | null {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return null;

  if (entryClientOrderId) {
    const exact = list.find(r => String(r?.client_order_id ?? '') === entryClientOrderId);
    if (exact) return exact;
  }

  const withStop = list
    .filter(r => String(r?.sl_order_id ?? '').trim() !== '')
    .sort((a, b) => msOf(b?.created_at) - msOf(a?.created_at));
  return withStop[0] ?? null;
}

function msOf(v: any): number {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : 0;
}
