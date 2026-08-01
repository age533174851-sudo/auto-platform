// src/lib/exchanges/quantize.ts
//
// **거래소 수량·가격 단위에 맞춘다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 비율 버튼(25%·50%·100%)은 `잔고 × 비율 × 배율 ÷ 가격`을 계산해서
// 소수점 여섯 자리로 잘랐다. BTCUSDT 선물의 수량 단위는 0.001이라
// **0.09906은 존재할 수 없는 수량**이다. 거래소가 거부한다:
//
//   [-1111] Precision is over the maximum defined for this asset.
//
// 저장소에 `roundQuantity`도 `roundToStep`도 이미 있었다. 그런데
// **수동 주문 경로에서 한 번도 안 불렸다.** 자동매매(daily-ladder)만
// 쓰고 있었고, 그래서 자동은 되는데 손으로 누르면 안 되는 상태였다.
// 오늘 계속 잡은 그 모양이다 — 만들어 놓고 배선을 안 한 것.
//
// 조용히 바꾸지 않는다
// ────────────────────
// 반올림은 사용자가 낸 주문의 **크기를 바꾸는 일**이다. 0.09906을
// 0.099로 내리면 의도보다 작게 산다. 작은 차이지만, 말없이 바꾸면
// "왜 100%를 눌렀는데 잔고가 남지" 같은 것이 설명 안 되는 상태로 남는다.
// 그래서 바뀌었으면 바뀌었다고 돌려준다.
//
// 못 읽으면 만들어내지 않는다
// ───────────────────────────
// 거래소 규격을 못 받았으면 기본값(0.001 같은 것)으로 채우지 않는다.
// 종목마다 다르고, 틀린 기본값으로 반올림하면 **맞는 수량을 틀린
// 수량으로 바꾼다.** 그대로 보내고 거래소가 판단하게 둔다 — 거부당해도
// 돈은 안 나가고, 이유는 거래소가 정확히 알려준다.

export interface SymbolFilters {
  /** 수량 단위 */
  stepSize?: number | null;
  /** 최소 수량 */
  minQty?: number | null;
  /** 가격 단위 */
  tickSize?: number | null;
  /** 최소 명목가 (Binance의 MIN_NOTIONAL) */
  minNotional?: number | null;
}

export interface QuantizeResult {
  ok: boolean;
  /** 실제로 보낼 수량. ok가 false면 보내지 않는다 */
  quantity: number | null;
  /** 실제로 보낼 가격 (지정가일 때) */
  price: number | null;
  /** 요청한 값에서 바뀌었는가 */
  changed: boolean;
  /** 사용자에게 그대로 보여줄 한 줄 */
  reason: string;
  /** 규격을 실제로 적용했는가. false면 거래소가 거부할 수 있다 */
  applied: boolean;
}

const isPos = (v: any): v is number => Number.isFinite(v) && Number(v) > 0;

/** 소수점 자리수를 단위에서 뽑는다. 0.001 → 3 */
export function decimalsOf(step: number): number {
  if (!isPos(step)) return 0;
  // 부동소수 오차로 0.001이 0.0009999…가 되는 경우가 있어 문자열로도 본다.
  const s = String(step);
  if (s.includes('e') || s.includes('E')) {
    return Math.max(0, Math.round(-Math.log10(step)));
  }
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  // 뒤쪽 0을 세지 않는다 — '0.00100'은 3자리다
  return s.slice(dot + 1).replace(/0+$/, '').length;
}

/** 단위에 맞춰 **내림**한다. 올리면 가진 것보다 많이 사려다 거부당한다. */
export function floorToStep(value: number, step: number): number {
  if (!isPos(step)) return value;
  const d = decimalsOf(step);
  // 0.3 / 0.1 = 2.9999… 가 되는 부동소수 문제. 아주 작은 값을 더해
  // 경계에서 한 칸 내려가는 것을 막는다.
  const n = Math.floor(value / step + 1e-9) * step;
  return Number(n.toFixed(d));
}

/** 가격은 **반올림**한다. 지정가는 내려도 올려도 되고, 가까운 쪽이 낫다. */
export function roundToTick(value: number, tick: number): number {
  if (!isPos(tick)) return value;
  return Number((Math.round(value / tick) * tick).toFixed(decimalsOf(tick)));
}

/**
 * 주문 수량·가격을 거래소 규격에 맞춘다.
 *
 * 순수 함수다 — 네트워크를 안 탄다. 규격은 호출부가 읽어서 넘긴다.
 *
 * @param filters 못 읽었으면 **null**을 넘긴다. 기본값을 지어내지 않는다.
 */
export function quantizeOrder(
  quantity: number,
  price: number | null | undefined,
  filters: SymbolFilters | null | undefined,
): QuantizeResult {
  const q0 = Number(quantity);
  if (!isPos(q0)) {
    return { ok: false, quantity: null, price: null, changed: false, applied: false,
      reason: '수량이 올바르지 않습니다' };
  }
  const p0 = isPos(Number(price)) ? Number(price) : null;

  if (!filters) {
    // 규격을 못 받았다. **그대로 보낸다.** 기본값으로 반올림하면 맞는
    // 수량을 틀린 수량으로 바꿀 수 있고, 그건 거부당하는 것보다 나쁘다.
    return {
      ok: true, quantity: q0, price: p0, changed: false, applied: false,
      reason: '거래소 수량 규격을 읽지 못했습니다 — 그대로 보냅니다. 거부되면 수량을 조금 줄여 보세요',
    };
  }

  const step = isPos(filters.stepSize) ? Number(filters.stepSize) : null;
  const tick = isPos(filters.tickSize) ? Number(filters.tickSize) : null;

  const q = step ? floorToStep(q0, step) : q0;
  const p = (p0 != null && tick) ? roundToTick(p0, tick) : p0;

  if (!isPos(q)) {
    // 내림했더니 0이 됐다. 요청한 수량이 한 단위보다 작다는 뜻이다.
    return { ok: false, quantity: null, price: p, changed: true, applied: true,
      reason: `수량 ${q0}이 거래소 최소 단위(${step})보다 작습니다 — 이대로는 주문할 수 없습니다` };
  }

  const minQty = isPos(filters.minQty) ? Number(filters.minQty) : null;
  if (minQty != null && q < minQty) {
    return { ok: false, quantity: null, price: p, changed: true, applied: true,
      reason: `수량 ${q}이 최소 주문 수량 ${minQty}보다 적습니다` };
  }

  const minNotional = isPos(filters.minNotional) ? Number(filters.minNotional) : null;
  if (minNotional != null && p != null && q * p < minNotional) {
    return { ok: false, quantity: null, price: p, changed: true, applied: true,
      reason: `주문 금액 ${(q * p).toFixed(2)}이 최소 금액 ${minNotional}보다 적습니다` };
  }

  const changed = q !== q0 || (p0 != null && p !== p0);
  return {
    ok: true, quantity: q, price: p, changed, applied: true,
    // 바뀌었으면 **반드시 말한다.** 말없이 크기를 줄이면 "100%를 눌렀는데
    // 왜 잔고가 남지"가 설명 안 되는 상태로 남는다.
    reason: changed
      ? `거래소 단위에 맞춰 조정했습니다: 수량 ${q0} → ${q}`
        + (p0 != null && p !== p0 ? ` · 가격 ${p0} → ${p}` : '')
      : '거래소 단위에 맞습니다',
  };
}
