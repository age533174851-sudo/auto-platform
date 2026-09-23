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

import {
  roundGatePrice, type GateSpotPrecision, type GatePrecisionSkip,
} from './gateSpotPrecision';

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
  /** **수량**의 소수 자릿수. 모르면 반올림하지 않는다 */
  amountPrecision?: number | null;
  /**
   * **지정가 가격**의 소수 자릿수. 수량 자릿수와 **다른 축이다.**
   *
   * 모르면 신규 진입(매수)은 보내지 않는다 — 아래 참조.
   */
  pricePrecision?: number | null;
  /** 최소 주문 **수량** (base) */
  minBaseAmount?: number | null;
  /** 최소 주문 **금액** (quote) */
  minQuoteAmount?: number | null;
  /**
   * 이 주문이 청산인가(현물 매도).
   *
   * 규격을 못 읽었을 때 정책이 갈린다 — **못 사는 것은 불편이고 못 파는
   * 것은 사고다.** 이 저장소가 이미 같은 판단을 하고 있다
   * (`/api/binance/spot/order`의 `intent: isSell ? 'EXIT' : 'ENTRY'`).
   */
  isExit?: boolean | null;
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
  /**
   * **축마다 무엇을 했는가.** 수량과 가격을 한 칸으로 합치지 않는다 —
   * Gate에서 그 둘은 서로 다른 필드에서 오고, 한쪽만 읽히는 경우가 있다.
   */
  precision?: GateSpotPrecision;
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
    // ★ **금액에는 수량 자릿수를 대지 않는다.** 이 주문에는 수량이라는 값이
    //   없고, 가격도 없다. 둘 다 '이 주문에 없음'이지 '못 읽음'이 아니다.
    return {
      ok: true, pair: p.pair, body, quantity: null,
      precision: {
        venue: 'GATE_SPOT',
        quantityApplied: false, quantitySkipped: 'NOT_IN_ORDER',
        priceApplied: false, priceSkipped: 'NOT_IN_ORDER',
        requestedQuantity: null, quantity: null,
        requestedPrice: null, price: null,
      },
    };
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

  // 수량 축은 **여기서 끝난다.** 아래 가격 축은 다른 필드(`precision`)를 쓴다.
  const quantityApplied = i.amountPrecision != null;
  const quantitySkipped: GatePrecisionSkip | null =
    quantityApplied ? null : 'METADATA_UNKNOWN';

  let priceApplied = false;
  let priceSkipped: GatePrecisionSkip | null = 'NOT_IN_ORDER';
  let rawPrice: number | null = null;
  let sentPrice: number | null = null;
  let priceNote: string | undefined;

  if (i.type === 'MARKET') {
    body.time_in_force = 'ioc';
  } else {
    const price = Number(i.price);
    if (!Number.isFinite(price) || price <= 0) return bad('지정가가 올바르지 않습니다');
    rawPrice = price;

    // ── ★ 지정가를 Gate의 **가격** 자릿수에 맞춘다 ──
    //
    //   지금까지 이 줄은 `body.price = String(price)`였다. 화면이 만드는
    //   지정가는 보간이나 나눗셈에서 나온 생 실수라 Gate의 자릿수 위에 있을
    //   이유가 없고, 벗어나면 주문이 통째로 거부된다.
    const r = roundGatePrice(price, i.pricePrecision);

    if (!r.applied) {
      // ── 규격을 못 읽었다 ──
      //
      //   **신규 진입은 보내지 않는다.** 맞춰야 하는 값을 못 맞춘 채로 새
      //   포지션을 여는 것은 거부당하는 것보다 나쁘다 — 왜 거부됐는지가
      //   사용자에게 남지 않는다.
      //
      //   **청산(매도)은 보낸다.** 규격을 못 읽어서 보유한 것을 못 파는
      //   상태를 만들지 않는다. 대신 맞췄다고 적지 않는다.
      if (!i.isExit) {
        return bad(
          `${p.pair}의 가격 자릿수를 읽지 못해 지정가 매수를 보내지 않았습니다 `
          + '— 잠시 후 다시 시도하세요 (매도는 계속 가능합니다)');
      }
      priceApplied = false;
      priceSkipped = r.skipped;
      priceNote = '가격 자릿수를 읽지 못해 가격을 맞추지 않았습니다 — 거래소가 거부할 수 있습니다';
    } else {
      priceApplied = true;
      priceSkipped = null;
      if (r.changed) priceNote = `가격을 ${price} → ${r.price}로 맞췄습니다 (호가 자릿수)`;
    }

    sentPrice = r.price;
    // 자릿수에 맞추니 0이 된 경우. `String(null)`은 `'null'`이고 그 문자열이
    // 그대로 거래소로 나간다 — 값이 없으면 본문을 만들지 않는다.
    if (!(Number(sentPrice) > 0)) {
      return bad(`지정가 ${price}를 이 종목의 가격 자릿수에 맞추면 0이 됩니다`);
    }
    body.price = String(sentPrice);
    body.time_in_force = 'gtc';
  }

  const notes = [note, priceNote].filter(Boolean) as string[];

  return {
    ok: true, pair: p.pair, body, quantity: qty,
    note: notes.length ? notes.join(' · ') : undefined,
    precision: {
      venue: 'GATE_SPOT',
      quantityApplied, quantitySkipped,
      priceApplied, priceSkipped,
      requestedQuantity: rawQty, quantity: qty,
      requestedPrice: rawPrice, price: sentPrice,
    },
  };
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
