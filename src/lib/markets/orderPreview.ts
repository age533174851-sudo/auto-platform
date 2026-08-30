// src/lib/markets/orderPreview.ts
//
// **주문 전에 보는 숫자와 실제로 나가는 주문이 같은 뜻이어야 한다.**
//
// 무엇이 있었나
// ─────────────
// 실행에서는 환율을 없앴는데(C3) 미리보기와 확인창은 옛 계산 그대로였다:
//
//   krwPx  = sel.p              // /api/prices의 **원화 표시가**
//   usdtPx = krwPx / 1375
//   qty    = amount / krwPx
//
// 그런데 실전·테스트넷에서 `amount`는 이제 **USDT 명목가**다. 그래서
// 100 USDT · ETH 2,500 USDT(원화 표시 3,437,500)를 넣으면 확인창은
//
//   수량 ≈ 0.000029 ETH · 명목가 ≈ 0.073 USDT
//
// 라고 적었다. 실제 주문은 `100 / 2500 = 0.04 ETH`로 나간다 — 약 1,375배
// 다른 숫자를 보고 승인하는 것이다. **체결이 틀린 게 아니라 확인창이
// 거짓말을 한다.** 사용자가 승인의 근거로 삼는 화면이라 더 나쁘다.
//
// 무엇을 하나
// ───────────
// 미리보기·확인창·실행이 **같은 한 곳**에서 뜻을 받는다.
//
//   거래소(USDT)  exchangePreviewOf  → planExchangeOrder와 같은 계산
//   연습(KRW)     practicePreviewOf  → 원화 연습 장부 표시 그대로
//
// 거래소 쪽에는 환율도 원화 표시가도 들어오지 않는다. 가격을 못 읽었으면
// 숫자를 만들지 않고 `PRICE_UNKNOWN`을 돌려준다 — **현물 가격으로 대신
// 채우지 않는다.** 화면은 "확인 전"이라고 적고 확인창을 열지 않는다.
//
// 미리 읽은 값은 예상이다
// ───────────────────────
// 확인창을 열 때 읽은 가격과 확인 버튼을 누를 때 읽은 가격은 다를 수 있다.
// 앞은 **판단용 예상값**, 뒤가 **체결 크기의 정본**이다. 그래서 화면은
// 확인창의 수량에 '예상'을 붙인다.

import { convertQuantity, notionalAndMargin } from './quantityInput';
import {
  orderCurrencyOf, planExchangeOrder,
  type OrderCurrency, type TradeMode,
} from './orderCurrency';
import type { SizingBasis } from './orderTypes';

export type PreviewState =
  /** 숫자가 실행과 같은 뜻으로 나왔다 */
  | 'READY'
  /** 금액이 없다 */
  | 'NO_AMOUNT'
  /** 가격을 못 읽었다 — 만들어 채우지 않는다 */
  | 'PRICE_UNKNOWN'
  /** 규칙에 막혔다 (최소 명목가 등) */
  | 'BLOCKED';

export interface OrderPreview {
  state: PreviewState;
  /** 아래 숫자들의 통화 */
  currency: OrderCurrency;
  /**
   * 수량을 나눈 가격 — **표시용 참고가가 아니라 계산에 쓴 값이다.**
   * 시장가면 거래소 선물가, 지정가면 사용자가 적은 지정가.
   */
  price: number | null;
  /** 그 가격이 어디서 왔는가. 연습 장부에는 없다 */
  basis: SizingBasis | null;
  qty: number | null;
  notional: number | null;
  margin: number | null;
  /** 연습(KRW) 표시에서만 쓰는 참고 환산. 거래소 경로에는 없다 */
  refUsdt: { notional: number | null; margin: number | null } | null;
  /** 왜 못 쓰는가 — 화면이 그대로 적는다 */
  reason: string | null;
}

const blank = (state: PreviewState, currency: OrderCurrency, reason: string | null): OrderPreview => ({
  state, currency, price: null, basis: null,
  qty: null, notional: null, margin: null, refUsdt: null, reason,
});

/**
 * 거래소로 나가는 주문의 미리보기.
 *
 * **실행과 같은 함수(`planExchangeOrder`)로 계산한다.** 화면이 공식을 따로
 * 갖고 있으면 언젠가 실행과 갈린다 — 그게 이번 고장이었다.
 */
export function exchangePreviewOf(i: {
  /** 사용자가 적은 포지션 명목가 (USDT) */
  amountUsdt: number | string | null | undefined;
  /** 이 연결에서 읽은 거래소 선물가. 못 읽었으면 null */
  venuePrice: number | null | undefined;
  leverage: number | null | undefined;
  minNotionalUsdt?: number | null;
  /** 사용자가 고른 주문유형. 안 주면 시장가 */
  orderType?: string | null;
  /** 지정가 주문의 가격 (USDT) */
  limitPrice?: number | string | null;
}): OrderPreview {
  const currency: OrderCurrency = 'USDT';
  const amount = Number(i?.amountUsdt);
  if (!Number.isFinite(amount) || amount <= 0) {
    return blank('NO_AMOUNT', currency, '포지션 명목가(USDT)를 입력하세요');
  }
  // ── 기준가 판단을 여기서 다시 쓰지 않는다 ──
  //
  // **실행이 쓰는 그 함수를 그대로 부른다.** 지정가는 거래소 시세를 몰라도
  // 계산된다 — 체결될 가격을 사용자가 이미 정했기 때문이다. 그래서 시세
  // 조회 실패로 지정가 미리보기를 막지 않는다.
  const plan = planExchangeOrder({
    amountUsdt: amount, nativePrice: i?.venuePrice ?? null, leverage: i?.leverage ?? null,
    minNotionalUsdt: i?.minNotionalUsdt ?? null,
    orderType: i?.orderType ?? 'MARKET', limitPrice: i?.limitPrice ?? null,
  });
  if (plan.kind !== 'READY') {
    const state: PreviewState =
      plan.code === 'NATIVE_PRICE_UNKNOWN' || plan.code === 'LIMIT_PRICE_REQUIRED'
        ? 'PRICE_UNKNOWN' : 'BLOCKED';
    return blank(state, currency, plan.reason);
  }
  return {
    state: 'READY', currency, price: plan.sizingPrice, basis: plan.basis,
    qty: plan.qty, notional: plan.notionalUsdt, margin: plan.marginUsdt,
    refUsdt: null, reason: null,
  };
}

/**
 * 연습(모의) 장부 표시용 환산율. **표시 전용이다.**
 *
 * 거래소 주문 경로는 이 값을 지나지 않는다 — 지나면 그게 C3 이전 고장이다.
 */
const PRACTICE_DISPLAY_RATE = 1375;

/** 원화 연습 장부의 미리보기. 기존 표시를 그대로 유지한다. */
export function practicePreviewOf(i: {
  amountKrw: number | string | null | undefined;
  krwPrice: number | null | undefined;
  leverage: number | null | undefined;
}): OrderPreview {
  const currency: OrderCurrency = 'KRW';
  const amount = Number(i?.amountKrw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return blank('NO_AMOUNT', currency, '포지션 명목가(₩)를 입력하세요');
  }
  const px = Number(i?.krwPrice);
  const known = Number.isFinite(px) && px > 0;
  const qty = known ? amount / px : null;
  const km = notionalAndMargin({ notional: amount, leverage: i?.leverage ?? null });
  const usdt = amount / PRACTICE_DISPLAY_RATE;
  const usdtPx = qty != null && qty > 0 ? usdt / qty : null;
  const c = qty != null && qty > 0
    ? convertQuantity({ mode: 'BASE_ASSET', value: qty, price: usdtPx, leverage: i?.leverage ?? null })
    : null;
  return {
    state: known ? 'READY' : 'PRICE_UNKNOWN',
    currency,
    price: known ? px : null,
    basis: null,
    qty,
    notional: km.notional,
    margin: km.margin,
    refUsdt: { notional: c?.notionalUsd ?? (known ? usdt : null), margin: c?.marginUsd ?? null },
    reason: known ? null : '가격을 확인하지 못했습니다',
  };
}

/** 모드가 통화를 정하고, 통화가 어느 계산을 쓸지 정한다. */
export function orderPreviewOf(i: {
  mode: TradeMode | string;
  amount: number | string | null | undefined;
  /** 이 연결에서 읽은 거래소 선물가 */
  venuePrice: number | null | undefined;
  /** 연습 표시용 원화가 */
  krwPrice: number | null | undefined;
  leverage: number | null | undefined;
  minNotionalUsdt?: number | null;
  /** 사용자가 고른 주문유형 */
  orderType?: string | null;
  /** 지정가 주문의 가격 (USDT) */
  limitPrice?: number | string | null;
}): OrderPreview {
  return orderCurrencyOf(i?.mode) === 'USDT'
    ? exchangePreviewOf({
        amountUsdt: i?.amount, venuePrice: i?.venuePrice,
        leverage: i?.leverage, minNotionalUsdt: i?.minNotionalUsdt ?? null,
        orderType: i?.orderType ?? 'MARKET', limitPrice: i?.limitPrice ?? null,
      })
    : practicePreviewOf({ amountKrw: i?.amount, krwPrice: i?.krwPrice, leverage: i?.leverage });
}
