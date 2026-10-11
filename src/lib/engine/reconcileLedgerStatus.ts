// src/lib/engine/reconcileLedgerStatus.ts
//
// 대조(reconcile)가 판정한 **생명주기 상태**를 **장부 상태**로 옮기는 정본.
//
// ── 왜 따로 두는가 ──
//
//   판정 쪽(`resolveAcked` / `resolveUnknown`)의 `resolved: true`는
//   "지금 상태를 알았다"는 뜻이다. 그런데 쓰는 쪽은 그것을 "주문이
//   끝났다"로 읽었다:
//
//     const st = verdict.state === 'FILLED' ? 'FILLED'
//       : verdict.state === 'FAILED' ? 'FAILED'
//       : verdict.state === 'REJECTED' ? 'REJECTED'
//       : 'RECONCILED';          // ← 나머지 전부
//
//   거래소가 `NEW`를 돌려주면 판정은 `ACKED`다 — **아직 거래소에 살아
//   있다.** 그런데 저 식은 `RECONCILED`를 적었다. `RECONCILED`는
//   "끝났다"는 뜻이고 `RECONCILE_TARGET_STATUSES`에 없으므로 **그 주문을
//   다시 조회하는 경로가 하나도 없다.** 거래소에 멀쩡히 열려 있는 주문이
//   장부에서 종료되고, 나중에 실제로 체결돼도 그 체결은 장부에 영원히
//   들어오지 않는다. `PARTIALLY_FILLED`(부분 체결 후 계속 열려 있음)도
//   똑같이 종료로 적혔다.
//
//   거기에 `RECONCILED`는 계좌 용량 관문의 두 목록
//   (`UNRESOLVED_ENTRY_STATUSES` · `ACCEPTED_ENTRY_STATUSES`) 어디에도
//   없다. 즉 **살아 있는 주문이 진입 잠금을 풀어 준다.** 지금은 관문이
//   거래소 미체결 주문 수를 두 번 읽어(`checkExposure`의
//   `openOrders !== 0`) 막고 있지만, 장부가 거짓이면 그 한 겹만 남는다.
//
//   "알았다"와 "끝났다"는 다른 축이다. 한 축으로 접으면 반대 방향으로
//   틀린다 — 이 저장소에서 반복되는 고장이다.

import { fromExchangeStatus } from './orderLifecycle';

/** `live_orders.status`가 받는 값 (orderExecutor의 ORDER_STATUSES와 같은 집합) */
export type LedgerOrderStatus =
  | 'INTENT' | 'SENT' | 'ACKED' | 'FILLED'
  | 'REJECTED' | 'FAILED' | 'UNKNOWN' | 'RECONCILED';

export interface LedgerStatusDecision {
  status: LedgerOrderStatus;
  /**
   * 더 이상 대조할 필요가 없는가.
   *
   * false면 장부에 **열린 주문**으로 남는다 — `reconciled_at`을 찍지
   * 않고, 다음 대조가 다시 조회한다.
   */
  terminal: boolean;
}

/**
 * 판정 상태 → 장부 상태.
 *
 * 모르는 상태를 끝났다고 적지 않는다. 확정하지 못한 것을 종료로 적는
 * 쪽이 늘 더 위험하다 (장부가 조용히 틀리고, 그 장부가 다음 주문을
 * 열어 준다).
 */
export function ledgerStatusOf(state: string | null | undefined): LedgerStatusDecision {
  switch (String(state ?? '').toUpperCase()) {
    case 'FILLED':   return { status: 'FILLED',   terminal: true };
    case 'FAILED':   return { status: 'FAILED',   terminal: true };
    case 'REJECTED': return { status: 'REJECTED', terminal: true };

    // 취소·만료는 끝난 것이다. 체결이었는지는 단정하지 않으므로
    // RECONCILED다. 부분 체결 수량은 사실이므로 호출자가 보존한다.
    case 'CANCELED': return { status: 'RECONCILED', terminal: true };

    // 조회는 됐는데 주문이 안 보이고 유예도 지난 경우. resolveAcked가
    // 주는 뜻 그대로다 — "끝났다. 체결 여부는 거래 내역에서 확인하라."
    case 'RECONCILED': return { status: 'RECONCILED', terminal: true };

    // 거래소에 아직 살아 있다(NEW). 장부도 살아 있다고 적는다.
    case 'ACKED':    return { status: 'ACKED', terminal: false };

    // 장부 어휘에 PARTIAL이 없다. 상태는 '접수됨'으로 두고 채워진 수량만
    // 사실로 남긴다. 다음 대조가 FILLED 또는 취소로 끝낸다.
    case 'PARTIAL':  return { status: 'ACKED', terminal: false };

    // 그 외(DRAFT·PENDING·APPROVED·SENT·PROTECTED·CLOSED·UNKNOWN)는
    // 거래소 조회로 나올 수 있는 값이 아니다. 나왔다면 우리가 모르는
    // 것이므로 확정하지 않는다.
    default:         return { status: 'UNKNOWN', terminal: false };
  }
}

// ──────────────────────────────────────────────────────────────────
// 거래소에서 **찾은** 주문을 장부에 적을 때
// ──────────────────────────────────────────────────────────────────
//
// 멱등 중복 감지 경로(`executeOrder`가 보내기 전에 같은 키의 주문을
// 거래소에서 찾는 자리)도 같은 거짓을 적고 있었다:
//
//   await update({ status: 'RECONCILED', … });     // 찾았으면 무조건 종료
//
// 찾은 주문이 `NEW`(아직 열려 있음)여도 `RECONCILED`가 적혔다. 그러면
// 아무도 그 주문을 다시 조회하지 않고, 체결돼도 장부에 안 들어온다.
// 위 `ledgerStatusOf`와 같은 결함이 **세 번째 자리**에 있었던 것이다.
//
// 그리고 한 가지가 더 있다. `ledgerStatusOf('FILLED')`는 상태만 보고
// FILLED를 돌려준다. 그런데 `newOrderRespType`을 지정하지 않으므로
// 응답 모양은 거래소 기본값에 달려 있고, **상태는 FILLED인데 수량이
// 없는 응답**이 올 수 있다. 상태만 믿으면 수량 없는 체결이 장부에
// 남는다 — 모순이고, 실제 체결 증거 없이 FILLED를 적는 것이다.

export interface ExchangeLedgerDecision extends LedgerStatusDecision {
  /** 사람이 봐야 하는가 (상태를 해석하지 못했거나 상태와 수량이 모순) */
  needsAttention: boolean;
  /** 그 사유. `needsAttention`이 false면 null */
  attentionReason: string | null;
}

/**
 * 체결 증거가 없는 `FILLED`를 `FILLED`로 적지 않는다.
 *
 * 수량 증거가 없으면 "거래소가 갖고 있다"는 사실만 남기고(ACKED)
 * 종료로 적지 않는다 — 다음 대조가 수량을 다시 물어본다.
 */
export function withFillEvidence(
  d: LedgerStatusDecision, filledQty: number | null | undefined,
): ExchangeLedgerDecision {
  if (d.status !== 'FILLED') return { ...d, needsAttention: false, attentionReason: null };
  if (filledQty != null && filledQty > 0) {
    return { ...d, needsAttention: false, attentionReason: null };
  }
  return {
    status: 'ACKED', terminal: false, needsAttention: true,
    attentionReason: '거래소가 FILLED를 돌려줬지만 체결 수량 증거가 없습니다'
      + ' — 체결로 적지 않고 다시 조회합니다',
  };
}

/**
 * 바이낸스에서 **찾은** 주문 → 장부 상태.
 *
 * 찾았다는 사실 자체가 증거다. 그래서 상태 문자열을 해석하지 못해도
 * "닿았는지도 모름"(`UNKNOWN`)이 아니라 "거래소가 갖고 있음"(`ACKED`)이다.
 * 대신 해석하지 못했다는 사실을 호출자에게 알려 사람이 보게 한다.
 */
export function ledgerStatusOfBinance(
  exchangeStatus: string | null | undefined, filledQty: number | null | undefined,
): ExchangeLedgerDecision {
  const mapped = fromExchangeStatus(exchangeStatus);
  if (!mapped) {
    return {
      status: 'ACKED', terminal: false, needsAttention: true,
      attentionReason: '거래소가 해석할 수 없는 주문 상태를 돌려줬습니다: '
        + `${exchangeStatus == null || String(exchangeStatus).trim() === '' ? '(없음)' : String(exchangeStatus)}`,
    };
  }
  return withFillEvidence(ledgerStatusOf(mapped), filledQty);
}

/**
 * Gate에서 **찾은** 주문 → 장부 상태.
 *
 * **Gate의 어휘는 바이낸스와 다르다.** `status`는 `open`·`finished`뿐이고
 * 끝난 이유는 `finish_as`에 들어온다(`filled`·`cancelled`·`ioc`·`stp`·
 * `liquidated`·`auto_deleveraged`·`reduce_only`·`position_closed`).
 * 그래서 `fromExchangeStatus`에 넣으면 전부 해석 불가가 된다 — 예전
 * 대조 경로가 `status: 'NEW'`를 **지어내서** 넘긴 이유다.
 *
 * `ioc`로 한 계약도 못 붙고 끝난 주문은 끝난 것이 사실이고 체결이 0인
 * 것도 사실이다. 그 둘을 `RECONCILED` + `filled_qty: 0`으로 적는다 —
 * `FAILED`로 적으면 재시도가 열려 중복 체결의 문이 된다.
 */
export interface GateOrderLedgerFacts {
  status?: string | null;
  finishAs?: string | null;
  filledQty?: number | null;
}
export function ledgerStatusOfGate(f: GateOrderLedgerFacts): ExchangeLedgerDecision {
  const st = String(f?.status ?? '').trim().toLowerCase();
  if (st === 'open') {
    return { status: 'ACKED', terminal: false, needsAttention: false, attentionReason: null };
  }
  if (st !== 'finished') {
    return {
      status: 'ACKED', terminal: false, needsAttention: true,
      attentionReason: `Gate가 해석할 수 없는 주문 상태를 돌려줬습니다: ${st === '' ? '(없음)' : st}`,
    };
  }
  const fin = String(f?.finishAs ?? '').trim().toLowerCase();
  if (fin === 'filled') {
    return withFillEvidence({ status: 'FILLED', terminal: true }, f.filledQty);
  }
  // 끝났다. 체결이었는지 아닌지는 수량이 말한다 — 상태로 단정하지 않는다.
  return { status: 'RECONCILED', terminal: true, needsAttention: false, attentionReason: null };
}
