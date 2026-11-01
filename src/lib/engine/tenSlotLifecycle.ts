// src/lib/engine/tenSlotLifecycle.ts
//
// **전송 뒤의 슬롯을 움직이는 유일한 자리.** (#537)
//
// 098의 전이표가 정본이다 (`ten_slot_next_status`). 이 파일은 그 표에
// 넣을 **사건을 고르는 판단**만 한다 — 전이 자체를 여기서 다시 적지 않는다:
//
//   RESERVED ─ACK/VENUE_ORDER→ OPEN ─CLOSE_REQUEST→ CLOSING
//                                   ─CLOSED/VENUE_POSITION→ SPENT
//   OPEN ─PARTIAL_FILL/VENUE_ORDER→ OPEN   (상태는 그대로, 기록만)
//   어디서든 ─UNKNOWN_RESPONSE→ UNKNOWN    (증거가 없다는 것이 내용이다)
//
// 098의 사건은 **다섯 가지뿐이다**:
//   ACK · PARTIAL_FILL · CLOSE_REQUEST · CLOSED · UNKNOWN_RESPONSE
//
// 여기 없는 것
// ────────────
// **`FILL`도 `SL_ATTACHED`도 없다.** 그래서 `OPEN`은 "체결됐다"도
// "보호된다"도 뜻하지 않는다 — 주문이 거래소에 **접수된 것을 조회로
// 확인했다**는 뜻뿐이다. 그 둘을 같은 말로 쓰면 `CLAUDE.md`가 금지한
// "실제 거래소 증거 없이 ENTERED·PROTECTED를 적는" 자리가 된다.
//
// 체결 수량·평균가는 사건의 **칸으로** 따라가고(`p_filled_qty`·
// `p_avg_price`), 보호주문이 걸렸는지는 이 장부가 아니라 `live_orders`와
// 실행기 결과에 남는다. 없는 사건을 새로 만들지 않는다 — 사건 종류를
// 늘리는 것은 마이그레이션이고 사람 승인 사항이다.

/** 098이 받는 사건. 이 다섯 가지뿐이다 */
export type SlotEventKind =
  'ACK' | 'PARTIAL_FILL' | 'CLOSE_REQUEST' | 'CLOSED' | 'UNKNOWN_RESPONSE';

/** 098이 받는 증거 종류 */
export type SlotEvidence = 'VENUE_ORDER' | 'VENUE_POSITION' | 'NONE';

export interface SlotEventPlan {
  kind: SlotEventKind;
  evidence: SlotEvidence;
  /** 왜 이 사건인가. 사람이 읽는다 */
  reason: string;
  /** 사건에 함께 적는 거래소 주문 번호. 없으면 null */
  exchangeOrderId: string | null;
  filledQty: number | null;
  avgPrice: number | null;
}

/** 적을 사건이 없다. **없는 것을 억지로 적지 않는다** */
export interface NoSlotEvent {
  kind: null;
  reason: string;
  /** 사람이 손을 대야 하는가 */
  needsHuman: boolean;
}

export type SlotEventVerdict = SlotEventPlan | NoSlotEvent;

const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

const str = (v: unknown): string | null =>
  (typeof v === 'string' && v.trim().length > 0 ? v : null);

/**
 * 전송 결과에서 적을 사건을 고른다.
 *
 * **거래소 주문 번호가 증거다.** `VENUE_ORDER` 증거를 요구하는 사건
 * (`ACK`·`PARTIAL_FILL`)은 그 번호 없이 적지 않는다 — 098도 그 짝을
 * 요구하고, 그 요구가 옳다. 번호가 없으면 "접수됐다"는 말의 근거가 없다.
 */
export function slotEventForExec(exec: any): SlotEventVerdict {
  const status = str(exec?.status);
  const orderId = str(exec?.exchangeOrderId);
  const filled = num(exec?.filledQty);
  const avg = num(exec?.avgPrice);

  if (status == null) {
    return { kind: null, reason: '전송 결과의 상태를 읽지 못했습니다', needsHuman: true };
  }

  // ── 거래소가 그 주문을 알고 있다고 확인된 상태들 ──
  //
  // `RECONCILED`는 "이미 있던 주문을 조회로 찾았다"다 — `ACKED`와 같은
  // 종류의 증거다. `FILLED`도 **접수**는 확인된 것이므로 같은 사건으로
  // 간다. **체결됐다는 사실은 수량 칸으로 간다 — 상태 이름으로 가지
  // 않는다.** 098에 FILL 사건이 없기 때문이고, 그 공백을 여기서
  // 메우지 않는다.
  if (status === 'ACKED' || status === 'FILLED' || status === 'RECONCILED') {
    if (orderId == null) {
      // 접수됐다는데 번호가 없다. **접수로 적지 않는다.**
      return {
        kind: 'UNKNOWN_RESPONSE', evidence: 'NONE',
        reason: `상태는 ${status}인데 거래소 주문 번호가 없습니다 — 접수로 적지 않습니다`,
        exchangeOrderId: null, filledQty: filled, avgPrice: avg,
      };
    }
    return {
      kind: 'ACK', evidence: 'VENUE_ORDER',
      reason: `거래소 주문 ${orderId}을 확인했습니다`,
      exchangeOrderId: orderId, filledQty: filled, avgPrice: avg,
    };
  }

  // 보냈지만 아직 확인되지 않았다. 모른다고 적는 것은 언제나 할 수 있다.
  if (status === 'SENT' || status === 'UNKNOWN' || status === 'INTENT') {
    return {
      kind: 'UNKNOWN_RESPONSE', evidence: 'NONE',
      reason: `전송 결과가 ${status}입니다 — 확정되지 않았습니다`,
      exchangeOrderId: orderId, filledQty: filled, avgPrice: avg,
    };
  }

  // ── 보내지 않은 것이 **확인된** 경우 ──
  //
  // 여기에 적을 사건이 098에 **없다.** `UNKNOWN_RESPONSE`는 "모른다"는
  // 뜻이고, 이건 모르는 것이 아니라 **안 나갔다는 것을 아는** 상태다.
  // 모르는 것으로 적으면 장부가 거짓이 되고, `UNKNOWN`에서 `FREE`로
  // 돌아가는 길은 098에 없으므로 그 슬롯은 영원히 묶인다.
  //
  // 그래서 아무것도 적지 않고 **사람에게 넘긴다.** 사건 종류를 늘리는
  // 것은 마이그레이션이고 사람 승인 사항이다.
  if (status === 'FAILED' || status === 'REJECTED') {
    return {
      kind: null,
      reason: `전송이 ${status}로 끝났습니다 — 098에 "보내지 않았다"를 적을 사건이 없습니다.`
        + ' 모른다(UNKNOWN_RESPONSE)로 적으면 장부가 거짓이 되고 슬롯이 영원히 묶입니다.',
      needsHuman: true,
    };
  }

  return { kind: null, reason: `처음 보는 전송 상태입니다 (${status})`, needsHuman: true };
}

/** 포지션을 다시 읽은 결과. **못 읽은 것과 0은 다르다** */
export interface PositionRead {
  /** 조회 자체가 됐는가 */
  ok: boolean;
  /** 남은 수량. 못 읽었으면 null — 0으로 바꾸지 않는다 */
  remainingQty: number | null;
}

/**
 * 닫겠다는 **의도**를 적는 사건. 거래소 증거가 필요하지 않다.
 *
 * 098이 `CLOSE_REQUEST`에 증거를 요구하지 않는 이유와 같다 — 이것은
 * 관측이 아니라 우리 쪽 결정이다.
 */
export function slotEventForCloseRequest(): SlotEventPlan {
  return {
    kind: 'CLOSE_REQUEST', evidence: 'NONE',
    reason: '닫겠다는 우리 쪽 의도입니다',
    exchangeOrderId: null, filledQty: null, avgPrice: null,
  };
}

/**
 * 닫혔는지 **포지션 조회로** 확인한 결과에서 사건을 고른다.
 *
 * 주문이 접수된 것과 포지션이 사라진 것은 다른 사실이다. 그래서
 * `CLOSED`는 `VENUE_POSITION` 증거만 받는다(098의 전이표).
 */
export function slotEventForCloseConfirm(pos: PositionRead): SlotEventVerdict {
  if (!pos?.ok) {
    return {
      kind: 'UNKNOWN_RESPONSE', evidence: 'NONE',
      reason: '포지션을 다시 읽지 못했습니다 — 닫혔다고 적지 않습니다',
      exchangeOrderId: null, filledQty: null, avgPrice: null,
    };
  }
  const left = pos.remainingQty;
  if (left == null) {
    // **읽었다는데 수량이 없다.** 0으로 바꾸지 않는다.
    return {
      kind: 'UNKNOWN_RESPONSE', evidence: 'NONE',
      reason: '조회는 됐지만 남은 수량을 읽지 못했습니다 — 0으로 적지 않습니다',
      exchangeOrderId: null, filledQty: null, avgPrice: null,
    };
  }
  if (left > 0) {
    return {
      kind: null,
      reason: `아직 ${left}이 남아 있습니다 — 닫힘으로 적지 않습니다`,
      needsHuman: false,
    };
  }
  return {
    kind: 'CLOSED', evidence: 'VENUE_POSITION',
    reason: '포지션이 0인 것을 조회로 확인했습니다',
    exchangeOrderId: null, filledQty: null, avgPrice: null,
  };
}

export interface ApplySlotEventArgs {
  campaignId: string;
  expectedVersion: number;
  slotIndex: number;
  /** 멱등 키. 같은 사건은 같은 키로 온다 */
  eventId: string;
  userId: string;
  connectionId: string;
  /** 예약이 쓴 그 번호. `VENUE_*` 증거에는 098이 요구한다 */
  clientOrderId: string;
}

export interface SlotEventResult {
  ok: boolean;
  code: string | null;
  slotStatus: string | null;
  campaignVersion: number | null;
  reason: string | null;
}

/** 098이 커밋을 알리는 코드 */
export const EVENT_APPLIED = 'EVENT_APPLIED';

/**
 * RPC 응답에서 **칸을 골라 담는다.** 펼치지 않는다.
 */
export function eventResultOf(data: unknown, error?: unknown): SlotEventResult {
  const miss = (reason: string): SlotEventResult =>
    ({ ok: false, code: null, slotStatus: null, campaignVersion: null, reason });
  if (error) return miss('사건 기록 호출이 실패했습니다');
  const rows = Array.isArray(data) ? data : data == null ? [] : [data];
  if (rows.length === 0) return miss('사건 기록 결과가 비어 있습니다');
  if (rows.length > 1) return miss(`사건 기록 결과가 ${rows.length}줄입니다 — 한 줄이어야 합니다`);
  const r = rows[0] as Record<string, unknown>;
  const code = str(r.code);
  if (code == null) return miss('사건 기록 결과에 코드가 없습니다');
  const version = num(r.campaign_version);
  return {
    // **코드가 커밋을 뜻할 때만 ok다.** 멱등 재적용도 커밋이다.
    ok: code === EVENT_APPLIED || code === 'EVENT_ALREADY_APPLIED',
    code,
    slotStatus: str(r.slot_status),
    campaignVersion: version,
    reason: code === EVENT_APPLIED || code === 'EVENT_ALREADY_APPLIED'
      ? null : `사건이 적히지 않았습니다 (${code})`,
  };
}

/**
 * 사건 하나를 적는다.
 *
 * **고른 사건을 그대로 넘긴다.** 여기서 종류를 바꾸거나 증거를 올려
 * 적지 않는다 — 올려 적는 순간 그게 "증거 없이 OPEN·SPENT로 가는" 길이다.
 */
export async function applySlotEvent(
  sb: any, plan: SlotEventPlan, a: ApplySlotEventArgs,
): Promise<SlotEventResult> {
  let data: unknown = null;
  let error: unknown = null;
  try {
    const res = await sb.rpc('ten_slot_apply_event', {
      p_campaign_id: a.campaignId,
      p_expected_version: a.expectedVersion,
      p_slot_index: a.slotIndex,
      p_event_id: a.eventId,
      p_kind: plan.kind,
      p_evidence: plan.evidence,
      p_exchange_order_id: plan.exchangeOrderId,
      p_filled_qty: plan.filledQty,
      p_avg_price: plan.avgPrice,
      p_caller_user_id: a.userId,
      p_caller_connection_id: a.connectionId,
      // `NONE` 증거에는 098이 요구하지 않지만, 넘겨도 무해하고
      // 넘기지 않으면 `VENUE_*`에서 빠뜨릴 길이 생긴다.
      p_client_order_id: a.clientOrderId,
    });
    data = res?.data ?? null;
    error = res?.error ?? null;
  } catch (e) {
    error = e;
  }
  return eventResultOf(data, error);
}
