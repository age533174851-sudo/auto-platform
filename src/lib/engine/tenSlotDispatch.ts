// src/lib/engine/tenSlotDispatch.ts
//
// **097이 커밋한 예약을 거래소까지 들고 가는 유일한 자리.** (#537)
//
// 왜 이 파일이 필요한가
// ─────────────────────
// 097·098은 예약과 주문 의도를 한 트랜잭션으로 적는다. 실제 PostgreSQL에서
// 원자성까지 증명했다. 그런데 `ten_slot_claim`을 **부르는 곳이 없었다** —
// `src/`·`worker/` 전체에서 그 이름은 주석 한 줄뿐이다. 만들어 놓고 배선을
// 안 한 것이다(`CLAUDE.md` 상습 고장 ①).
//
// 배선을 아무렇게나 하면 안 되는 이유
// ───────────────────────────────────
// 예약이 `live_orders`에 `INTENT`를 **이미 커밋해 둔다.** 그 뒤에
// `executeOrder`를 평범하게 부르면 같은 `client_order_id`로 INSERT가
// 23505로 깨지고, 그 자리에서 끝난다 — **예약은 남고 주문은 영원히 나가지
// 않는다.** `executeOrder`는 그 자리를 여는 길을 이미 갖고 있다:
// `adoptIntent: true`. 그 조건은 `canAdoptIntent()` 한 곳에 있다.
//
// 그래서 이 파일이 하는 일은 둘뿐이다:
//   ① 예약이 **커밋됐는지** 코드로 확인한다
//   ② 커밋됐을 때만 **같은 `client_order_id`로** 이어받아 전송한다
//
// 하지 않는 일
// ────────────
// 잠금·중복 전송 관문을 새로 만들지 않는다. 전송 직전의 `INTENT → SENT`
// 조건부 CAS는 `orderExecutor`의 `claimOrderDispatch`가 이미 한다. 같은
// 판단을 여기 또 적으면 언젠가 갈린다.
//
// 기본은 꺼짐이다
// ───────────────
// 기존 일일 최대 1회 전략을 10슬롯으로 **바꾸지 않는다.** 이 경로는
// 명시적으로 켜야 돌고, 켜지지 않으면 거래소를 부르지도 않는다.

import { executeOrder, type ExecuteResult } from './orderExecutor';

/** 예약이 실제로 커밋됐을 때 SQL이 돌려주는 코드. 이 하나만 전송을 연다 */
export const CLAIM_DURABLE = 'RESERVATION_AND_INTENT_DURABLE';

/** 10슬롯 경로를 켜는 값. **다른 어떤 값도 켜지 않는다** */
const ON = 'on';

/**
 * 이 경로가 켜져 있는가. **기본 꺼짐.**
 *
 * `'true'`·`'1'`·`'yes'`를 받지 않는다. 켜는 방법이 여러 개면 "껐다고
 * 생각했는데 켜져 있는" 상태가 생긴다.
 */
export function tenSlotEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.TEN_SLOT_DISPATCH ?? '').trim().toLowerCase() === ON;
}

export interface TenSlotClaimVerdict {
  /** SQL이 돌려준 코드. 읽지 못했으면 null — 빈 문자열로 바꾸지 않는다 */
  code: string | null;
  slotIndex: number | null;
  campaignVersion: number | null;
  liveOrderId: string | null;
  /** 전송을 열어도 되는가. **`CLAIM_DURABLE`일 때만 true** */
  durable: boolean;
  /** 열지 않는 이유 */
  reason: string | null;
}

const int = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isInteger(v) ? v
    : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null);

const str = (v: unknown): string | null =>
  (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * RPC 응답에서 **칸을 골라 담는다.** 펼치지 않는다.
 *
 * `ten_slot_claim`은 `RETURNS TABLE`이므로 Supabase가 **배열**로 돌려줄 수
 * 있고 한 줄로 돌려줄 수도 있다. 둘 다 받는다. 줄이 여러 개면 읽지 못한
 * 것으로 센다 — 이 함수는 한 번에 한 슬롯만 예약한다.
 */
export function claimVerdictOf(data: unknown, error?: unknown): TenSlotClaimVerdict {
  const miss = (reason: string): TenSlotClaimVerdict => ({
    code: null, slotIndex: null, campaignVersion: null, liveOrderId: null,
    durable: false, reason,
  });
  if (error) return miss('예약 호출이 실패했습니다');
  const rows = Array.isArray(data) ? data : data == null ? [] : [data];
  if (rows.length === 0) return miss('예약 결과가 비어 있습니다');
  if (rows.length > 1) return miss(`예약 결과가 ${rows.length}줄입니다 — 한 줄이어야 합니다`);
  const r = rows[0] as Record<string, unknown>;
  const code = str(r.code);
  if (code == null) return miss('예약 결과에 코드가 없습니다');
  const v: TenSlotClaimVerdict = {
    code,
    slotIndex: int(r.slot_index),
    campaignVersion: int(r.campaign_version),
    liveOrderId: str(r.live_order_id),
    durable: false,
    reason: null,
  };
  if (code !== CLAIM_DURABLE) return { ...v, reason: `예약이 커밋되지 않았습니다 (${code})` };
  // **커밋됐다고 적힌 줄에 좌표가 없으면 믿지 않는다.** 이어받기는
  // 이 좌표로 그 줄을 찾는다 — 없으면 무엇을 이어받는지 모른다.
  if (v.slotIndex == null) return { ...v, reason: '커밋됐다는데 슬롯 번호가 없습니다' };
  if (v.campaignVersion == null) return { ...v, reason: '커밋됐다는데 캠페인 버전이 없습니다' };
  if (v.liveOrderId == null) return { ...v, reason: '커밋됐다는데 주문 줄 id가 없습니다' };
  return { ...v, durable: true };
}

export interface TenSlotDispatchArgs {
  campaignId: string;
  expectedVersion: number;
  /** 예약과 전송이 **같은 값을 쓴다.** 여기서 새로 만들지 않는다 */
  clientOrderId: string;
  requestedLots?: number;
  exposure: { positions: number; openOrders: number; pendingEntries: number };
  userId: string;
  connectionId: string;
  exchange: string;
  mode: string;
  plan: any;
  apiKey: string;
  apiSecret: string;
  /**
   * **비울 수 없다.**
   *
   * `canAdoptIntent()`는 `user_id`·`connection_id`·`signal_id` 셋을
   * 정체성으로 요구한다 — 셋 중 하나라도 비면 이어받기를 거절한다.
   * 097의 `p_signal_id`는 기본값이 NULL이므로, 안 넘기고 예약하면
   * **이어받을 수 없는 의도가 커밋된다.** 그러면 슬롯은 묶이고 주문은
   * 영원히 나가지 않는다. 그래서 예약 **전에** 막는다.
   */
  signalId: string;
  stopPolicy?: string | null;
  takeProfitPolicy?: string | null;
  protectionPolicy?: string | null;
  orderType?: 'MARKET' | 'LIMIT';
  limitPrice?: number;
}

export interface TenSlotDispatchResult {
  ok: boolean;
  /** 예약 판정. 전송까지 갔는지와 **따로** 적는다 */
  claim: TenSlotClaimVerdict;
  /** 전송 결과. 전송하지 않았으면 null — 실패로 적지 않는다 */
  exec: ExecuteResult | null;
  reason: string | null;
}

/**
 * 예약 하나를 거래소까지 들고 간다.
 *
 * 전송은 **예약이 커밋된 뒤에만** 열린다. 커밋을 확인하지 못한 모든
 * 경우에 거래소를 부르지 않는다 — 확인하지 못한 것은 통과가 아니다.
 */
export async function dispatchTenSlot(
  sb: any,
  a: TenSlotDispatchArgs,
  env: Record<string, string | undefined> = process.env,
): Promise<TenSlotDispatchResult> {
  const off = (reason: string, claim: TenSlotClaimVerdict): TenSlotDispatchResult =>
    ({ ok: false, claim, exec: null, reason });

  if (!tenSlotEnabled(env)) {
    // 꺼져 있으면 **예약도 하지 않는다.** 예약만 해 두고 전송하지 않으면
    // 슬롯이 묶인 채로 남는다.
    return off('10슬롯 경로가 꺼져 있습니다 (TEN_SLOT_DISPATCH=on 이어야 합니다)',
      claimVerdictOf(null, new Error('not enabled')));
  }

  // 이어받을 수 없는 예약을 만들지 않는다. 예약 뒤에 알면 슬롯이 묶인다.
  if (typeof a.signalId !== 'string' || a.signalId.trim().length === 0) {
    return off('신호 id가 없습니다 — 이어받을 수 없는 예약을 만들지 않습니다',
      claimVerdictOf(null, new Error('no signal id')));
  }

  let data: unknown = null;
  let error: unknown = null;
  try {
    const res = await sb.rpc('ten_slot_claim', {
      p_campaign_id: a.campaignId,
      p_expected_version: a.expectedVersion,
      p_client_order_id: a.clientOrderId,
      p_requested_lots: a.requestedLots ?? 1,
      p_exposure_positions: a.exposure.positions,
      p_exposure_open_orders: a.exposure.openOrders,
      p_exposure_pending_entries: a.exposure.pendingEntries,
      p_exchange: a.exchange,
      p_mode: a.mode,
      p_symbol: a.plan?.symbol,
      p_side: a.plan?.side === 'SHORT' ? 'SELL' : 'BUY',
      p_order_type: a.orderType ?? 'MARKET',
      p_quantity: a.plan?.quantity,
      p_price: a.limitPrice ?? null,
      p_leverage: a.plan?.leverage,
      p_reduce_only: false,
      p_signal_id: a.signalId,
      p_stop_policy: a.stopPolicy ?? null,
      // **호출자의 정체성을 들고 간다.** 안 넘기면 SQL이 CALLER_UNKNOWN으로
      // 막는다 — 그 검사가 옳으므로 우회하지 않고 값을 넘긴다.
      p_caller_user_id: a.userId,
      p_caller_connection_id: a.connectionId,
    });
    data = res?.data ?? null;
    error = res?.error ?? null;
  } catch (e) {
    error = e;
  }

  const claim = claimVerdictOf(data, error);
  if (!claim.durable) return off(claim.reason ?? '예약을 확인하지 못했습니다', claim);

  // 여기서부터만 거래소가 열린다.
  const exec = await executeOrder(sb, {
    // ── **이 한 줄이 배선의 전부다** ──
    //
    // 없으면 `executeOrder`가 새 INTENT를 INSERT하고, 예약이 이미 적어 둔
    // 같은 `client_order_id` 때문에 23505로 깨져 **그 자리에서 끝난다.**
    // 실측한 모양: `주문이 0번 나갔다`. 슬롯은 묶이고 주문은 영원히 안 나간다.
    //
    // 반대로 예약이 커밋되지 않았는데 이것을 넘기면 `canAdoptIntent()`가
    // 거절한다 — 그래서 위에서 `claim.durable`을 확인한 뒤에만 온다.
    // 이어받기 조건을 여기 복제하지 않는다. 그 판단은 그 함수 한 곳에 있다.
    adoptIntent: true,
    userId: a.userId,
    connectionId: a.connectionId,
    signalId: a.signalId,
    // **예약이 쓴 그 값이다.** 새로 만들면 커밋된 줄을 이어받지 못하고
    // 의도가 두 줄이 된다.
    clientOrderId: a.clientOrderId,
    exchange: a.exchange,
    mode: a.mode,
    plan: a.plan,
    apiKey: a.apiKey,
    apiSecret: a.apiSecret,
    stopPolicy: a.stopPolicy,
    takeProfitPolicy: a.takeProfitPolicy,
    protectionPolicy: a.protectionPolicy,
    orderType: a.orderType,
    limitPrice: a.limitPrice,
  } as any);

  return { ok: exec.ok === true, claim, exec, reason: exec.ok === true ? null : (exec.message ?? null) };
}
