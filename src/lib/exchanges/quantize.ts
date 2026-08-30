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
// 수량으로 바꾼다.**
//
// 그러면 못 읽었을 때 어떻게 하는가. **신규 진입과 청산이 다르다.**
//
//   신규 진입  규격을 모른 채 새 포지션을 열지 않는다 — 막는다.
//              "거래소가 알아서 거절하겠지"로 실제 돈을 보내지 않는다.
//   청산       막지 않는다. 규격 조회가 실패했다고 포지션에서 빠져나갈
//              길까지 플랫폼이 선제 차단하면, 못 여는 불편이 아니라
//              **못 닫는 사고**가 된다.
//
// 규격을 정상적으로 읽었는데 그 필터가 원래 없는 것과, 조회 자체가
// 실패한 것은 다른 상태다. Gate에는 고정 최소 명목가가 없다 — 그건
// '모름'이 아니라 '그런 규칙이 없음'이다.
//
// 주문유형마다 수량 격자가 다르다
// ───────────────────────────────
// 바이낸스는 `LOT_SIZE`(지정가)와 `MARKET_LOT_SIZE`(시장가)를 따로 준다.
// 한 벌로 접으면 시장가 주문을 지정가 격자로 깎게 된다. 그래서 타입이
// 둘을 나눠 들고, 없는 쪽을 다른 쪽으로 **복사하지 않는다.**

export interface QtyGrid {
  /** 수량 단위 */
  stepSize?: number | null;
  /** 최소 수량 */
  minQty?: number | null;
}

export interface SymbolFilters {
  /** 지정가 주문의 수량 격자 (바이낸스 LOT_SIZE) */
  limitQty: QtyGrid | null;
  /**
   * 시장가 주문의 수량 격자 (바이낸스 MARKET_LOT_SIZE).
   *
   * **없으면 null이다.** 지정가 격자를 복사해 채우지 않는다 — 거래소가
   * 주지 않은 규칙을 우리가 만드는 것이기 때문이다.
   */
  marketQty: QtyGrid | null;
  /** 가격 단위 */
  tickSize?: number | null;
  /**
   * 최소 명목가 (바이낸스 MIN_NOTIONAL의 `notional`).
   *
   * **거래소가 주는 값만 담는다.** Gate 선물에는 이 규칙이 없어 항상
   * null이고, 그건 '모름'이 아니라 '그런 규칙이 없음'이다.
   */
  minNotional?: number | null;
}

export type QuantizeCode =
  /** 수량 자체가 숫자가 아니거나 0 이하 */
  | 'INVALID_QUANTITY'
  /** 거래소 규격을 못 읽었다 (조회 실패) */
  | 'FILTERS_UNKNOWN'
  /** 규격은 읽었지만 **이 주문유형의** 수량 격자를 모른다 */
  | 'QTY_FILTER_UNKNOWN'
  /** 수량 단위로 내렸더니 한 칸도 안 된다 */
  | 'INVALID_STEP'
  /** 최소 주문 수량 미달 */
  | 'BELOW_MIN_QTY'
  /** 최소 명목가 미달 */
  | 'BELOW_MIN_NOTIONAL'
  /** 최소 명목가를 검사할 기준가를 못 읽었다 */
  | 'REFERENCE_PRICE_UNKNOWN';

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
  /** 왜 막혔는가. 통과했으면 null */
  code: QuantizeCode | null;
}

export interface QuantizeOptions {
  /** 이 주문의 유형. 안 주면 시장가 */
  orderType?: 'MARKET' | 'LIMIT' | null;
  /** 청산 주문인가. 청산에는 최소 명목가를 적용하지 않는다 */
  reduceOnly?: boolean | null;
  /**
   * 시장가의 최소 명목가를 검사할 기준가 (USDT).
   *
   * **서버가 거래소에서 읽은 마크가여야 한다.** 화면이 보낸 값을 쓰면
   * 검사가 검사하려던 대상에게 값을 물어보는 꼴이 된다.
   *
   * 수량을 다시 만드는 값이 아니다 — 사용자가 승인한 수량은 그대로다.
   */
  marketReferencePrice?: number | null;
}

const isPos = (v: any): v is number => Number.isFinite(v) && Number(v) > 0;

/**
 * 이 주문유형의 수량 격자.
 *
 * **없으면 null이다.** 시장가 격자가 없다고 지정가 격자를 쓰지 않는다.
 */
export function qtyGridFor(
  filters: SymbolFilters | null | undefined,
  orderType?: 'MARKET' | 'LIMIT' | null,
): QtyGrid | null {
  if (!filters) return null;
  return orderType === 'LIMIT' ? (filters.limitQty ?? null) : (filters.marketQty ?? null);
}

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
 * 순수 함수다 — 네트워크를 안 탄다. 규격과 기준가는 호출부가 읽어서 넘긴다.
 *
 * @param filters 못 읽었으면 **null**을 넘긴다. 기본값을 지어내지 않는다.
 */
export function quantizeOrder(
  quantity: number,
  price: number | null | undefined,
  filters: SymbolFilters | null | undefined,
  opts?: QuantizeOptions | null,
): QuantizeResult {
  const orderType = opts?.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET';
  const reduceOnly = !!opts?.reduceOnly;

  const q0 = Number(quantity);
  if (!isPos(q0)) {
    return { ok: false, quantity: null, price: null, changed: false, applied: false,
      code: 'INVALID_QUANTITY', reason: '수량이 올바르지 않습니다' };
  }
  const p0 = isPos(Number(price)) ? Number(price) : null;

  if (!filters) {
    // ── 규격을 못 읽었다 ──
    //
    // 청산은 보낸다. 규격 조회 실패로 포지션에서 못 빠져나오게 하는 것이
    // 더 위험하다. 신규 진입은 막는다 — 모르는 규격으로 새 포지션을 여는
    // 것은 거부당하는 것보다 나쁘다.
    if (!reduceOnly) {
      return {
        ok: false, quantity: null, price: p0, changed: false, applied: false,
        code: 'FILTERS_UNKNOWN',
        reason: '거래소 수량 규격을 읽지 못해 신규 주문을 보내지 않습니다'
              + ' — 잠시 후 다시 시도하세요 (청산은 계속 가능합니다)',
      };
    }
    return {
      ok: true, quantity: q0, price: p0, changed: false, applied: false, code: null,
      reason: '거래소 수량 규격을 읽지 못했습니다 — 청산이라 그대로 보냅니다',
    };
  }

  // ── 수량 격자는 **주문유형이 정한다** ──
  //
  // 바이낸스는 시장가에 `MARKET_LOT_SIZE`를 따로 준다. 지정가 격자로
  // 시장가를 깎으면 거래소가 요구하지 않은 크기로 주문하게 된다.
  const lot = qtyGridFor(filters, orderType);
  const tick = isPos(filters.tickSize) ? Number(filters.tickSize) : null;
  const p = (p0 != null && tick) ? roundToTick(p0, tick) : p0;

  // ── 규격 응답을 받은 것과 **이 주문유형의 규격을 아는 것**은 다르다 ──
  //
  // `exchangeInfo`가 200을 주고 `LOT_SIZE`도 있는데 `MARKET_LOT_SIZE`만
  // 없을 수 있다. 그때 시장가 수량을 그대로 흘려보내면, 조회에 실패했을
  // 때와 똑같이 **규격을 모른 채 신규 포지션을 여는 것**이 된다.
  // 위의 `filters == null`과 같은 정책으로 간다.
  if (!lot) {
    if (!reduceOnly) {
      return {
        ok: false, quantity: null, price: p, changed: false, applied: false,
        code: 'QTY_FILTER_UNKNOWN',
        reason: `${orderType === 'LIMIT' ? '지정가' : '시장가'} 주문의 수량 규격을 확인하지 못해`
              + ' 신규 주문을 보내지 않습니다 (청산은 계속 가능합니다)',
      };
    }
    return {
      ok: true, quantity: q0, price: p, changed: p0 != null && p !== p0, applied: false, code: null,
      reason: `${orderType === 'LIMIT' ? '지정가' : '시장가'} 주문의 수량 규격을 확인하지 못했습니다`
            + ' — 청산이라 그대로 보냅니다',
    };
  }

  const step = isPos(lot.stepSize) ? Number(lot.stepSize) : null;
  const minQty = isPos(lot.minQty) ? Number(lot.minQty) : null;

  const q = step ? floorToStep(q0, step) : q0;

  if (!isPos(q)) {
    // 내림했더니 0이 됐다. 요청한 수량이 한 단위보다 작다는 뜻이다.
    return { ok: false, quantity: null, price: p, changed: true, applied: true,
      code: 'INVALID_STEP',
      reason: `수량 ${q0}이 거래소 최소 단위(${step})보다 작습니다 — 이대로는 주문할 수 없습니다` };
  }

  if (minQty != null && q < minQty) {
    // 청산이라고 최소 수량을 없는 셈 치지 않는다 — 거래소가 그대로 거절한다.
    return { ok: false, quantity: null, price: p, changed: true, applied: true,
      code: 'BELOW_MIN_QTY',
      reason: `수량 ${q}이 최소 주문 수량 ${minQty}보다 적습니다` };
  }

  // ── 최소 명목가 ──
  //
  // **청산에는 적용하지 않는다.** 남은 포지션이 최소 금액보다 작아졌다고
  // 닫지 못하게 하면 빠져나갈 길이 없다.
  //
  // 신규 진입에서는 **자른 뒤의 수량**으로 검사한다. 사용자가 적은 원본이
  // 최소를 넘어도 stepSize로 내리면서 미달이 될 수 있다.
  const minNotional = isPos(filters.minNotional) ? Number(filters.minNotional) : null;
  if (minNotional != null && !reduceOnly) {
    // 지정가는 그 가격에 체결되고, 시장가는 지금 값에 체결된다.
    const ref = orderType === 'LIMIT'
      ? p
      : (isPos(opts?.marketReferencePrice) ? Number(opts!.marketReferencePrice) : null);
    if (ref == null) {
      return { ok: false, quantity: null, price: p, changed: true, applied: true,
        code: 'REFERENCE_PRICE_UNKNOWN',
        reason: `최소 주문 금액(${minNotional})을 확인할 기준 가격을 읽지 못했습니다`
              + ' — 지어낸 가격으로 검사하지 않습니다' };
    }
    if (q * ref < minNotional) {
      return { ok: false, quantity: null, price: p, changed: true, applied: true,
        code: 'BELOW_MIN_NOTIONAL',
        reason: `주문 금액 ${(q * ref).toFixed(2)}이 최소 금액 ${minNotional}보다 적습니다` };
    }
  }

  const changed = q !== q0 || (p0 != null && p !== p0);
  return {
    ok: true, quantity: q, price: p, changed, applied: true, code: null,
    // 바뀌었으면 **반드시 말한다.** 말없이 크기를 줄이면 "100%를 눌렀는데
    // 왜 잔고가 남지"가 설명 안 되는 상태로 남는다.
    reason: changed
      ? `거래소 단위에 맞춰 조정했습니다: 수량 ${q0} → ${q}`
        + (p0 != null && p !== p0 ? ` · 가격 ${p0} → ${p}` : '')
      : '거래소 단위에 맞습니다',
  };
}
