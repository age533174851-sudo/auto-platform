// src/lib/exchanges/gateSpot.ts
//
// Gate 현물 — 실제 호출.
//
// 판정은 `gateSpotPlan.ts`(순수)가 하고, 여기서는 보내고 읽기만 한다.
//
// 왜 gate.ts를 안 쓰나
// ────────────────────
// `gate.ts`의 `BASE`는 **`https://api.gateio.ws` 하나로 박혀 있다.**
// 테스트넷 연결로 주문을 넣어도 실계좌로 나간다는 뜻이다. 잔고는 테스트넷에서
// 읽고 주문은 실전으로 나가는 것보다 나쁜 조합은 별로 없다.
//
// `gateFutures.ts`의 `gateReq`는 이미 testnet 분기·서명·시각 보정을 갖고
// 있다. 그걸 쓴다 — 서명 코드를 두 벌 두면 한쪽만 고쳐지는 날이 온다.
import { venueIdOf } from './losslessJson';
import { gateReq, toGateText } from './gateFutures';
import { planGateSpotOrder, gateSpotFillOf, toGatePair, type GateSpotPlanInput } from './gateSpotPlan';
import { gatePriceDecimals, type GateSpotPrecision } from './gateSpotPrecision';

export interface GateSpotBalance {
  currency: string;
  free: number;
  locked: number;
}

/** 현물 잔고. 실패하면 던진다 — 빈 배열로 덮으면 '보유 0'과 구분이 안 된다 */
export async function getGateSpotBalances(
  key: string, secret: string, testnet = false,
): Promise<GateSpotBalance[]> {
  const rows = await gateReq<any[]>('GET', '/api/v4/spot/accounts', { key, secret, testnet });
  return (Array.isArray(rows) ? rows : []).map(b => ({
    currency: String(b?.currency ?? '').toUpperCase(),
    free: Number(b?.available) || 0,
    locked: Number(b?.locked) || 0,
  }));
}

export interface GateSpotPairInfo {
  pair: string;
  /** **수량**의 소수 자릿수 (`amount_precision`) */
  amountPrecision: number | null;
  /**
   * **지정가 가격**의 소수 자릿수 (`precision`).
   *
   * `amountPrecision`과 **다른 필드이고 다른 축이다.** 한쪽으로 다른 쪽을
   * 대신하면 가격을 수량 자릿수로 깎게 되고, 그 주문은 거래소가 거부한다.
   */
  pricePrecision: number | null;
  /** 최소 주문 **수량**(base) */
  minBaseAmount: number | null;
  /** 최소 주문 **금액**(quote) */
  minQuoteAmount: number | null;
  maxBaseAmount: number | null;
  maxQuoteAmount: number | null;
  marketMaxBaseAmount: number | null;
  marketMaxQuoteAmount: number | null;
  /** 'tradable'은 양방향, 'buyable'은 매수, 'sellable'은 매도만 가능하다. */
  tradeStatus: string | null;
}

/**
 * 종목 규격. **못 읽으면 null이다** — 그때는 정밀도를 적용하지 않고
 * 거래소 판단에 맡긴다 (바이낸스 경로가 하는 것과 같다).
 */
export async function getGateSpotPair(
  pair: string, testnet = false,
): Promise<GateSpotPairInfo | null> {
  try {
    const d = await gateReq<any>('GET', `/api/v4/spot/currency_pairs/${encodeURIComponent(pair)}`, { testnet });
    if (!d) return null;
    const numberOf = (value: unknown): number | null => {
      if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) {
        value = Number(value);
      }
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    };
    /**
     * **자릿수 축 전용 읽기.** 금액 축에는 쓰지 않는다.
     *
     * `gatePriceDecimals`는 음수·비정수·100 초과를 null로 돌린다. 자릿수는
     * 그래야 맞지만 **금액은 그러면 안 된다** — `min_base_amount`는
     * `0.0001` 같은 비정수이고, 그걸 자릿수 검증에 넣으면 상한이 통째로
     * null이 되어 "상한 없음"처럼 읽힌다.
     *
     * ★ **이름을 바꾸지 않는다.** `scripts/check-gate-spot-precision.mjs`가
     *   `pricePrecision: n(d.precision)` 철자로 "가격 자릿수를 거래소에서
     *   읽는가"를 본다. 개명하면 그 검사기가 빨강이 되고, 그건 검사기가
     *   틀린 것이 아니라 이 줄이 정본에서 벗어난 것이다.
     */
    const n = (value: unknown): number | null => gatePriceDecimals(numberOf(value));
    return {
      pair: String(d.id ?? pair),
      amountPrecision: n(d.amount_precision),
      // Gate는 수량 자릿수를 `amount_precision`, 가격 자릿수를 `precision`으로
      // 준다. **둘 중 하나로 다른 하나를 채우지 않는다** — 없으면 null이다.
      pricePrecision: n(d.precision),
      minBaseAmount: numberOf(d.min_base_amount),
      minQuoteAmount: numberOf(d.min_quote_amount),
      maxBaseAmount: numberOf(d.max_base_amount),
      maxQuoteAmount: numberOf(d.max_quote_amount),
      marketMaxBaseAmount: numberOf(d.market_order_max_stock),
      marketMaxQuoteAmount: numberOf(d.market_order_max_money),
      tradeStatus: d.trade_status != null ? String(d.trade_status) : null,
    };
  } catch { return null; }
}

export interface GateSpotOrderResult {
  success: boolean;
  message: string;
  orderId?: string;
  /** 체결 수량. **모르면 null** */
  filledQty?: number | null;
  avgPrice?: number | null;
  status?: string | null;
  unfilled?: boolean;
  raw?: any;
  /** 축마다 규격을 적용했는가. 계획 단계에서 막히면 없다 */
  precision?: GateSpotPrecision;
}

export async function placeGateSpotOrder(
  key: string, secret: string,
  input: Omit<GateSpotPlanInput,
    'text' | 'maxBaseAmount' | 'maxQuoteAmount' | 'marketMaxBaseAmount' | 'marketMaxQuoteAmount'
  > & { clientOrderId?: string },
  testnet = false,
): Promise<GateSpotOrderResult> {
  const p = toGatePair(input.symbol);
  if (!p) return { success: false, message: `종목 '${input.symbol}'을 Gate 이름으로 바꾸지 못했습니다` };

  // 규격을 먼저 읽는다. 못 읽으면 정밀도 없이 진행한다 (거래소가 판단).
  const info = await getGateSpotPair(p.pair, testnet);
  const status = info?.tradeStatus;
  const sideAllowed = (status === 'buyable' && input.side === 'BUY')
    || (status === 'sellable' && input.side === 'SELL');
  if (status && status !== 'tradable' && !sideAllowed) {
    return { success: false, message: `${p.pair}는 지금 요청한 방향으로 거래할 수 없습니다 (${status})` };
  }

  const plan = planGateSpotOrder({
    ...input,
    text: toGateText(input.clientOrderId),
    // 자릿수, 최소값, 최대값은 수량과 금액의 규격을 각각 넘긴다.
    amountPrecision: input.amountPrecision ?? info?.amountPrecision ?? null,
    pricePrecision: input.pricePrecision ?? info?.pricePrecision ?? null,
    minBaseAmount: input.minBaseAmount ?? info?.minBaseAmount ?? null,
    minQuoteAmount: input.minQuoteAmount ?? info?.minQuoteAmount ?? null,
    maxBaseAmount: info?.maxBaseAmount ?? null,
    maxQuoteAmount: info?.maxQuoteAmount ?? null,
    marketMaxBaseAmount: info?.marketMaxBaseAmount ?? null,
    marketMaxQuoteAmount: info?.marketMaxQuoteAmount ?? null,
  });
  if (!plan.ok) return { success: false, message: plan.reason || '주문을 만들지 못했습니다' };

  let response: { id?: unknown };
  try {
    response = await gateReq('POST', '/api/v4/spot/orders', { key, secret, body: plan.body, testnet });
  } catch (e: any) {
    return { success: false, message: `Gate 현물 주문 실패: ${e?.message || e}` };
  }

  // 전송 뒤 식별자를 확인하지 못하면 실행기가 주문을 미확정으로 기록한다.
  const orderId = venueIdOf(response?.id);
  if (!orderId) throw new Error('Gate 현물 주문 응답에서 주문 ID를 확인하지 못했습니다');

  const fill = gateSpotFillOf(response);
  return {
    success: true,
    orderId,
    filledQty: fill.filledQty,
    avgPrice: fill.avgPrice,
    status: fill.status,
    unfilled: fill.unfilled,
    raw: response,
    precision: plan.precision,
    message: fill.unfilled
      ? '주문이 체결되지 않고 취소되었습니다 (시장가 IOC)'
      : plan.note
        ? `주문 접수 · ${plan.note}`
        : '주문 접수',
  };
}

/**
 * 표식으로 기존 주문을 찾는다 — 중복 방지용.
 *
 * **`{ ok, order, error }`를 돌려준다.** 조회 실패를 '없음'으로 돌려주면
 * 한도 초과 한 번에 같은 주문이 두 번 나간다. 선물 경로에서 같은 이유로
 * 같은 모양으로 고쳤다.
 */
export async function findGateSpotOrderByText(
  key: string, secret: string, pair: string, clientOrderId: string, testnet = false,
): Promise<{ ok: boolean; order: any | null; error?: string }> {
  const text = toGateText(clientOrderId);
  if (!text) return { ok: true, order: null };
  try {
    // Gate는 text로 단건 조회를 지원한다 (order_id 자리에 text를 넣는다).
    const d = await gateReq<{ id?: unknown }>(
      'GET', `/api/v4/spot/orders/${encodeURIComponent(text)}`,
      { key, secret, qs: `currency_pair=${encodeURIComponent(pair)}`, testnet });
    if (!d || typeof d !== 'object' || Array.isArray(d) || !venueIdOf(d.id)) {
      return { ok: false, order: null, error: 'Gate 현물 주문 조회 응답에서 주문 ID를 확인하지 못했습니다' };
    }
    return { ok: true, order: d };
  } catch (e: any) {
    const msg = String(e?.message || e);
    // 404 / ORDER_NOT_FOUND는 **정말로 없는 것**이다. 나머지는 모르는 것.
    if (/404|ORDER_NOT_FOUND|not found/i.test(msg)) return { ok: true, order: null };
    return { ok: false, order: null, error: msg };
  }
}
