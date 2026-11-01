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
  /**
   * 손절가. **`NO_FIXED_SL`이 아니면 비울 수 없다.**
   *
   * 예약과 전송에 **같은 값**이 들어가야 한다 — `canAdoptIntent()`가
   * `live_orders.stop_loss`와 보낼 주문의 값을 대조한다. 그래서 한 곳에서
   * 받아 양쪽에 같이 넘긴다. 양쪽에 따로 적으면 언젠가 갈린다.
   */
  stopLoss?: number | null;
  /** 익절가. 없으면 비운다 — 0으로 바꾸지 않는다 */
  takeProfit?: number | null;
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

  // ── 이어받을 수 있는 것만 예약한다 ──
  //
  // **예약 뒤에 알면 늦다.** 커밋된 의도를 이어받지 못하면 슬롯은
  // RESERVED로 남고 주문은 영원히 나가지 않는다. 그래서 이어받기가
  // 거절할 조건을 **예약 전에** 본다.
  //
  // 아래 관문들은 모두 같은 모양의 실측에서 나왔다. 검수 지적을 받아
  // 실제로 돌려 보고 확인한 출력:
  //
  //   stopPolicy: 'FIXED_SL'
  //   → sends 0 · UNKNOWN · "커밋된 의도의 stop_policy가 보낼 계약과 다릅니다"
  //
  // 097은 `FIXED_SL`을 유효하게 받아 `live_orders.stop_policy='FIXED_SL'`로
  // 커밋하는데, `orderExecutor`는 **`NO_FIXED_SL`일 때만** 의도에 그 칸을
  // 넣는다(078이 아직인 DB에서 모든 주문이 실패하지 않게). 그래서 저장값은
  // `'FIXED_SL'`, 예상값은 없음이 되어 대조가 깨진다.
  //
  // 그 비대칭을 `orderExecutor`에서 고치지 않는다 — 그 판단은 078의 이유가
  // 있고 다른 경로가 전부 그것에 의존한다. **이 경로가 예약하지 않는다.**
  if (a.stopPolicy != null && a.stopPolicy !== 'NO_FIXED_SL') {
    return off(`이 경로는 stopPolicy=${a.stopPolicy}를 예약하지 않습니다`
      + ' — 커밋된 의도를 이어받을 수 없어 슬롯만 묶입니다'
      + ' (비우거나 NO_FIXED_SL만 가능합니다)',
      claimVerdictOf(null, new Error('stop policy not adoptable')));
  }

  // ── 보호 없는 진입을 열지 않는다 ──
  //
  // 실측(검수 지적 B): 손절가를 넘기지 않으면 진입이 **나가고**
  // `slOrderId`는 null이다 — 보호되지 않은 포지션이다.
  //
  //   sends 1 · ACKED · slOrderId null
  //
  // `NO_FIXED_SL`은 고정 손절을 **일부러** 걸지 않는 계약이다(Exact100X).
  // 그 경우만 손절 없이 열린다. 그 밖에는 손절가를 요구한다. 전략의
  // 손절을 **낮추는 것이 아니라**, 손절 없이 보내지 않는 것이다.
  const sl = a.stopLoss;
  if (a.stopPolicy !== 'NO_FIXED_SL') {
    if (!(typeof sl === 'number' && Number.isFinite(sl) && sl > 0)) {
      return off('손절가가 없습니다 — 보호 없는 진입을 열지 않습니다'
        + ' (고정 손절을 일부러 걸지 않는 계약이면 stopPolicy=NO_FIXED_SL을 넘기세요)',
        claimVerdictOf(null, new Error('no stop loss')));
    }
    // **손절가를 주는 것만으로는 보호되지 않는다.** 실측:
    //
    //   stopLoss 95000 · protectionPolicy 'NONE'
    //   → sends 1 · ACKED · slOrderId null · unprotected true
    //
    // `orderExecutor:564`가 `noFixedSl ? 'NONE' : (args.protectionPolicy ?? 'REQUIRED')`
    // 로 정하므로, `'NONE'`을 넘기면 손절가를 줘도 부착 분기가 돌지 않는다.
    // 그래서 이 경로는 `'NONE'`을 **거절한다** — 호출부의 요청을 조용히
    // 바꾸지 않고, 보호 없이 열릴 조합을 받지 않는다.
    if (a.protectionPolicy === 'NONE') {
      return off('protectionPolicy=NONE은 손절을 걸지 않습니다 — 보호 없는 진입을 열지 않습니다'
        + ' (비우면 REQUIRED로 걸립니다)',
        claimVerdictOf(null, new Error('protection none')));
    }
  }

  // ── 실행기가 거절할 계획으로 예약하지 않는다 ──
  //
  // `executeOrder`는 사전 안전 검사를 **전송 직전**에 한다. 그 자리에서
  // 거절되면 예약은 이미 커밋돼 있고 슬롯은 RESERVED로 남는다. 아래는
  // 전부 실제로 돌려서 본 모양이다(예약 1회 · 전송 0회):
  //
  //   plan.approved=false  → REJECTED "승인되지 않은 계획은 주문할 수 없습니다"
  //   plan.leverage=0      → REJECTED "레버리지를 확인하지 못했습니다 (0)"
  //   plan.leverage=NaN    → REJECTED "레버리지를 확인하지 못했습니다 (NaN)"
  //   NO_FIXED_SL + 손절가 → REJECTED "고정 손절을 쓰지 않는 프로필인데 …"
  //
  // 그래서 같은 검사를 **예약 전에** 한 번 한다. 실행기의 검사를 없애는
  // 것이 아니다 — 그쪽은 모든 경로의 마지막 방어선으로 그대로 둔다.
  if (a.plan?.approved !== true) {
    return off('승인되지 않은 계획입니다 — 예약하지 않습니다',
      claimVerdictOf(null, new Error('plan not approved')));
  }

  // ── 방향: `LONG`·`SHORT`만 받는다 ──
  //
  // 이 파일은 `p_side`를 `plan.side === 'SHORT' ? 'SELL' : 'BUY'`로 보내고,
  // `orderExecutor`는 `plan.side !== 'LONG' ? 'SELL' : 'BUY'`로 읽는다.
  // 두 식은 `LONG`·`SHORT`에서만 같은 답을 준다 — `'HOLD'`나 `null`이면
  // **예약에는 BUY가 적히고 전송은 SELL을 기대한다.** 그러면
  // `canAdoptIntent`가 거절하고 슬롯만 남는다(상습 고장 ②).
  //
  // 식을 한 곳으로 합치는 것이 더 낫지만 그 판단은 `orderExecutor`의
  // 것이고 이 PR이 건드리지 않는 파일이다. 대신 **두 식이 일치하는
  // 범위만** 받는다. 모르는 방향은 통과가 아니다.
  if (a.plan?.side !== 'LONG' && a.plan?.side !== 'SHORT') {
    return off(`방향이 LONG·SHORT가 아닙니다 (${String(a.plan?.side)})`
      + ' — 예약과 전송이 서로 다른 방향을 보게 되어 예약하지 않습니다',
      claimVerdictOf(null, new Error('side not directional')));
  }

  // 배율은 유한 양의 정수여야 한다. **범위 정책은 여기서 정하지 않는다** —
  // 전략의 배율을 코드가 조용히 좁히지 않는다(`CLAUDE.md`). 실행기는
  // 거래소에서 배율을 되읽어 대조하고, 어긋나면 전송하지 않는다.
  const lev = a.plan?.leverage;
  if (!(typeof lev === 'number' && Number.isInteger(lev) && lev > 0)) {
    return off(`배율을 확인하지 못했습니다 (${String(lev)}) — 예약하지 않습니다`,
      claimVerdictOf(null, new Error('leverage unreadable')));
  }

  // ── `NO_FIXED_SL`에 손절가·익절가를 같이 보내지 않는다 ──
  //
  // 실행기는 그 모순을 **조용히 정리하지 않고 거절한다** — 둘 중 어느
  // 쪽이 맞는지 알 수 없기 때문이다. 그 판정이 옳다. 그렇다면 그 조합으로
  // 예약해서도 안 된다.
  if (a.stopPolicy === 'NO_FIXED_SL' && a.stopLoss != null) {
    return off('고정 손절을 쓰지 않는 계약인데 손절가가 함께 왔습니다'
      + ` (${a.stopLoss}) — 어느 쪽이 맞는지 알 수 없어 예약하지 않습니다`,
      claimVerdictOf(null, new Error('no-fixed-sl with stop loss')));
  }
  if (a.takeProfitPolicy === 'NO_FIXED_TP' && a.takeProfit != null) {
    return off('고정 익절을 쓰지 않는 계약인데 익절가가 함께 왔습니다'
      + ` (${a.takeProfit}) — 어느 쪽이 맞는지 알 수 없어 예약하지 않습니다`,
      claimVerdictOf(null, new Error('no-fixed-tp with take profit')));
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
      // **전송에 넘기는 값과 같은 값이다.** 한 곳에서 받아 양쪽에 같이 넘긴다.
      p_stop_loss: a.stopLoss ?? null,
      p_take_profit: a.takeProfit ?? null,
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
    // 예약에 적힌 그 값이다. 다르면 `canAdoptIntent()`가 거절한다.
    stopLoss: a.stopLoss ?? undefined,
    takeProfit: a.takeProfit ?? undefined,
    takeProfitPolicy: a.takeProfitPolicy,
    protectionPolicy: a.protectionPolicy,
    orderType: a.orderType,
    limitPrice: a.limitPrice,
  } as any);

  return { ok: exec.ok === true, claim, exec, reason: exec.ok === true ? null : (exec.message ?? null) };
}
