// src/lib/exchanges/gateSpotPlan.ts
//
// Gate 현물 주문의 **판정** — 순수 함수. 네트워크를 모른다.
//
// 왜 떼어내는가
// ─────────────
// Gate 현물에는 바이낸스와 다른 점이 셋 있고, 셋 다 조용히 틀린다:
//
//  1. **종목 이름이 다르다.** `BTCUSDT`가 아니라 `BTC_USDT`다. 기존 코드는
//     `endsWith('USDT')`만 봤다 — `ETHBTC`나 `SOLUSDC`를 넣으면 밑줄이 안
//     붙고, Gate는 그 이름을 모르는 종목으로 거절한다. 거절되면 그나마
//     낫고, 하필 그 이름의 종목이 있으면 **다른 것을 산다.**
//
//  2. **시장가 매수의 `amount`가 수량이 아니라 금액이다.** 매도는 수량이다.
//     같은 칸에 서로 다른 단위가 들어간다. 여기서 헷갈리면 0.5 USDT어치를
//     사려다 0.5 BTC를 사게 된다.
//
//  3. **수량 정밀도는 내림해야 한다.** 올리면 보유량을 넘겨 매도가 거부된다.
//
// 그리고 체결 판정: `left`가 없으면 **얼마나 체결됐는지 모르는 것**이지
// 0이 아니다. 0으로 적으면 '미체결'로 보이고, 사용자가 다시 넣는다.

export type GateSpotSide = 'BUY' | 'SELL';
export type GateSpotType = 'MARKET' | 'LIMIT';

/**
 * 붙일 수 있는 결제 통화. **긴 것부터** 본다.
 *
 * 'USDT'보다 'USD'를 먼저 보면 `BTCUSDT`가 `BTCUS/DT`로 잘린다.
 */
export const GATE_QUOTES = ['USDT', 'USDC', 'BUSD', 'TUSD', 'DAI', 'BTC', 'ETH'] as const;

export interface GatePair {
  pair: string;   // BTC_USDT
  base: string;   // BTC
  quote: string;  // USDT
}

/**
 * `BTCUSDT` · `BTC/USDT` · `btc_usdt` → `{ pair: 'BTC_USDT', ... }`
 *
 * 결제 통화를 못 알아보면 **null이다.** 추측해서 밑줄을 아무 데나 넣으면
 * 존재하는 다른 종목이 될 수 있다.
 */
export function toGatePair(symbol: string | null | undefined): GatePair | null {
  const raw = String(symbol ?? '').toUpperCase().trim();
  if (!raw) return null;

  // 이미 나뉘어 있으면 그대로 쓴다
  const sep = raw.includes('_') ? '_' : raw.includes('/') ? '/' : null;
  if (sep) {
    const [base, quote] = raw.split(sep);
    if (!base || !quote) return null;
    return { pair: `${base}_${quote}`, base, quote };
  }

  for (const q of GATE_QUOTES) {
    if (raw.length > q.length && raw.endsWith(q)) {
      const base = raw.slice(0, -q.length);
      return { pair: `${base}_${q}`, base, quote: q };
    }
  }
  return null;
}

export interface GateSpotPlanInput {
  symbol: string;
  side: GateSpotSide;
  type: GateSpotType;
  /** 코인 수량 (LIMIT 전부 · MARKET 매도) */
  quantity?: number | null;
  /** 결제통화 금액 (MARKET 매수 전용) */
  quoteAmount?: number | null;
  /** LIMIT 가격 */
  price?: number | null;
  /** 거래소에 남길 표식 (t- 접두사가 붙은 값) */
  text?: string;
  /** 수량 소수 자릿수. 모르면 반올림하지 않는다 */
  amountPrecision?: number | null;
  /** 최소 주문 수량 (base) */
  minBaseAmount?: number | null;
  /** 최소 주문 금액 (quote) */
  minQuoteAmount?: number | null;
}

export interface GateSpotPlan {
  ok: boolean;
  reason?: string;
  pair?: string;
  /** Gate `/api/v4/spot/orders`에 그대로 보낼 본문 */
  body?: Record<string, any>;
  /** 실제로 나가는 수량 (정밀도 적용 후). 금액 주문이면 null */
  quantity?: number | null;
  /** 정밀도 때문에 깎였으면 그 사실 */
  note?: string;
}

const bad = (reason: string): GateSpotPlan => ({ ok: false, reason });

/** 소수 자릿수로 **내림**한다. 올리면 보유량을 넘겨 매도가 거부된다 */
export function floorTo(value: number, precision: number | null | undefined): number {
  if (precision == null || !Number.isFinite(precision) || precision < 0) return value;
  const f = Math.pow(10, Math.floor(precision));
  // 부동소수점 오차로 한 칸 내려가는 것을 막는다 (0.29999999998 → 0.3)
  return Math.floor(Number((value * f).toFixed(8))) / f;
}

/**
 * 주문 본문을 만든다.
 *
 * 시장가는 `ioc`(즉시 체결 아니면 취소)를 쓴다. Gate 현물은 `market` 타입에
 * `gtc`를 허용하지 않는다 — 남겨 두면 거절당한다.
 */
export function planGateSpotOrder(i: GateSpotPlanInput): GateSpotPlan {
  const p = toGatePair(i.symbol);
  if (!p) {
    return bad(`종목 '${i.symbol}'의 결제 통화를 알 수 없습니다 `
      + `(지원: ${GATE_QUOTES.join(', ')}). 'BTC_USDT'처럼 밑줄로 적어도 됩니다`);
  }
  if (i.side !== 'BUY' && i.side !== 'SELL') return bad('BUY 또는 SELL만 가능합니다');
  if (i.type !== 'MARKET' && i.type !== 'LIMIT') return bad('주문 유형이 올바르지 않습니다');

  const body: Record<string, any> = {
    currency_pair: p.pair,
    side: i.side.toLowerCase(),
    type: i.type.toLowerCase(),
  };
  if (i.text) body.text = i.text;

  // ── 시장가 매수: amount는 **결제통화 금액**이다 ──
  const byQuote = i.type === 'MARKET' && i.side === 'BUY';
  if (byQuote) {
    const amt = Number(i.quoteAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return bad(`시장가 매수는 ${p.quote} 금액이 필요합니다 (수량이 아니라 금액입니다)`);
    }
    if (i.minQuoteAmount != null && amt < Number(i.minQuoteAmount)) {
      return bad(`최소 주문 금액(${i.minQuoteAmount} ${p.quote})보다 적습니다`);
    }
    body.time_in_force = 'ioc';
    body.amount = String(amt);
    return { ok: true, pair: p.pair, body, quantity: null };
  }

  // ── 나머지는 전부 코인 수량 ──
  const rawQty = Number(i.quantity);
  if (!Number.isFinite(rawQty) || rawQty <= 0) return bad('주문 수량이 올바르지 않습니다');

  const qty = floorTo(rawQty, i.amountPrecision);
  if (!(qty > 0)) {
    return bad(`수량 ${rawQty}가 이 종목의 최소 단위보다 작습니다 `
      + `(소수 ${i.amountPrecision}자리까지)`);
  }
  if (i.minBaseAmount != null && qty < Number(i.minBaseAmount)) {
    return bad(`최소 주문 수량(${i.minBaseAmount} ${p.base})보다 적습니다`);
  }
  const note = qty !== rawQty
    ? `수량을 ${rawQty} → ${qty}로 내림했습니다 (최소 단위)`
    : undefined;

  body.amount = String(qty);

  if (i.type === 'MARKET') {
    body.time_in_force = 'ioc';
  } else {
    const price = Number(i.price);
    if (!Number.isFinite(price) || price <= 0) return bad('지정가가 올바르지 않습니다');
    body.price = String(price);
    body.time_in_force = 'gtc';
  }

  return { ok: true, pair: p.pair, body, quantity: qty, note };
}

export interface GateSpotFill {
  /** 체결 수량. **모르면 null이다 — 0이 아니다** */
  filledQty: number | null;
  /** 평균 체결가. 모르면 null */
  avgPrice: number | null;
  /** 거래소가 준 상태 문자열 */
  status: string | null;
  /** 하나도 안 붙고 끝났는가 (ioc 취소). 판단 못 하면 false */
  unfilled: boolean;
}

/**
 * 주문 응답에서 체결을 읽는다.
 *
 * Gate 현물 응답은 `amount`(주문량) · `left`(남은 양) · `filled_total`
 * (체결된 결제통화 금액)을 준다. **`left`가 없으면 얼마나 붙었는지 모르는
 * 것**이지 0이 아니다. 0으로 적으면 화면에 '미체결'로 보이고, 사용자는
 * 같은 주문을 다시 넣는다.
 */
export function gateSpotFillOf(order: any): GateSpotFill {
  const num = (v: any): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const status = order?.status != null ? String(order.status) : null;
  const amount = num(order?.amount);
  const left = num(order?.left);

  let filledQty: number | null = null;
  if (amount != null && left != null) filledQty = Math.max(0, amount - left);
  // 시장가 매수는 amount가 금액이라 위 뺄셈이 수량이 아니다.
  // Gate가 따로 주는 체결 수량이 있으면 그쪽을 믿는다.
  const explicit = num(order?.filled_amount) ?? num(order?.filled_base_amount);
  if (explicit != null) filledQty = explicit;

  const filledTotal = num(order?.filled_total);
  let avgPrice = num(order?.avg_deal_price) ?? num(order?.fill_price) ?? null;
  if (avgPrice == null && filledTotal != null && filledQty != null && filledQty > 0) {
    avgPrice = filledTotal / filledQty;
  }
  if (avgPrice == null) avgPrice = num(order?.price);

  // 끝났는데 하나도 안 붙었는가. **끝난 것이 확인될 때만** true다.
  const finished = status === 'cancelled' || status === 'closed';
  const unfilled = finished && filledQty === 0;

  return { filledQty, avgPrice, status, unfilled };
}
