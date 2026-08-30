// src/lib/markets/orderCurrency.ts
//
// **실전·테스트넷 주문에서 환율을 없앤다.**
//
// 무엇이 있었나
// ─────────────
// 화면은 원화로 금액을 받고 이렇게 수량을 만들었다:
//
//   usdtPx       = krwPx / 1375
//   usdtNotional = krwAmount / 1375
//   qty          = usdtNotional / usdtPx      →  krwAmount / krwPx
//
// 명시적인 1375는 서로 소거된다. 그래서 오래 "환율은 수량에 영향이 없다"고
// 읽혔다. **아니다.** `krwPx`는 `/api/prices`가 거래소 원가에 상수 1375를
// 곱해 만든 값이라, 실효 수식은 이렇게 된다:
//
//   qty = krwAmount / (usdPx × 1375)
//
// 즉 원화 금액을 **정확히 1375로** 달러 환산해 주문한다. 실제 환율이
// 1450이면 명목가가 5.5% 크게 체결된다. 환율은 앞단에 숨어 있었을 뿐
// 처음부터 체결 크기를 정하고 있었다.
//
// 무엇을 하나
// ───────────
// 1375를 더 나은 환율로 바꾸지 않는다. **실행 경로에서 환율을 없앤다.**
//
//   실행 통화  USDT (거래소가 실제로 부르는 값)
//   표시 통화  KRW (참고 환산)
//   환율       실행과 무관 — 못 읽어도 주문은 나간다
//
// 서버(`manualPlan`·`quantizeOrder`)와 canonical PAPER가 이미 USDT다.
// 원화 입력이 유일한 환율 유입구였다.
//
// 단위가 바뀌면 숫자의 뜻도 바뀐다
// ────────────────────────────────
// `100000`은 모의에서 ₩100,000이고 실전에서 100,000 USDT다. 같은 입력칸을
// 두 모드가 나눠 쓰면 **모드를 바꾼 순간 백 배가 넘는 주문**이 된다.
// 그래서 통화가 바뀌는 전환에서는 금액을 비운다 — 환산해서 넘기지 않는다.

import { convertQuantity } from './quantityInput';

export type TradeMode = 'mock' | 'testnet' | 'live';
export type OrderCurrency = 'KRW' | 'USDT';

/**
 * 이 모드의 주문 금액은 어느 통화인가.
 *
 * 모의는 원화 연습 장부라 원화, 거래소로 나가는 것은 거래소가 부르는
 * 통화(USDT)다.
 */
export function orderCurrencyOf(mode: TradeMode | string): OrderCurrency {
  return mode === 'testnet' || mode === 'live' ? 'USDT' : 'KRW';
}

/**
 * 모드를 바꿀 때 적어 둔 금액을 비워야 하는가.
 *
 * **통화가 바뀌면 반드시 비운다.** `100000`을 그대로 두면 ₩100,000이
 * 100,000 USDT가 된다. 자동 환산도 하지 않는다 — 사용자가 고른 적 없는
 * 숫자로 주문을 만드는 것이기 때문이다.
 */
export function amountMustClear(from: TradeMode | string, to: TradeMode | string): boolean {
  return orderCurrencyOf(from) !== orderCurrencyOf(to);
}

export type ExecBlockCode =
  /** 금액을 안 적었다. 기본값을 지어내지 않는다 */
  | 'NO_AMOUNT'
  /** 거래소 원본 가격을 못 읽었다. 환율로 되돌려 만들지 않는다 */
  | 'NATIVE_PRICE_UNKNOWN'
  /** 화면이 아는 최소 명목가 미만 (정본은 서버 필터 — C4에서 옮긴다) */
  | 'BELOW_MIN_NOTIONAL';

export type ExchangeOrderPlan =
  | {
      kind: 'READY';
      /** 포지션 명목가 (USDT). 사용자가 적은 값 그대로 — 배율과 무관 */
      notionalUsdt: number;
      /** 거래소로 보낼 코인 개수 */
      qty: number;
      /** 예상 필요 증거금 (USDT). 배율을 모르면 null */
      marginUsdt: number | null;
    }
  | { kind: 'BLOCKED'; code: ExecBlockCode; reason: string };

/**
 * 거래소 주문 계획 — **환율이 들어가지 않는다.**
 *
 * `nativePrice`는 거래소가 부르는 값(USDT)이다. 원화 표시가에서 환산해
 * 넣으면 이 함수의 의미가 사라진다.
 *
 * 가격을 못 읽었으면 막는다. **환율을 모르는 것과 시장가를 모르는 것은
 * 다른 상태다** — 전자는 표시만 못 하고, 후자는 수량을 만들 수 없다.
 */
export function planExchangeOrder(i: {
  /** 사용자가 적은 포지션 명목가 (USDT) */
  amountUsdt: number | null | undefined;
  /** 거래소 원본 가격 (USDT). 못 읽었으면 null */
  nativePrice: number | null | undefined;
  leverage: number | null | undefined;
  /** 화면이 아는 최소 명목가. 정본은 서버 필터다 */
  minNotionalUsdt?: number | null;
}): ExchangeOrderPlan {
  const amount = Number(i.amountUsdt);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { kind: 'BLOCKED', code: 'NO_AMOUNT', reason: '포지션 명목가(USDT)를 입력하세요' };
  }
  const px = Number(i.nativePrice);
  if (!Number.isFinite(px) || px <= 0) {
    return {
      kind: 'BLOCKED', code: 'NATIVE_PRICE_UNKNOWN',
      reason: '거래소 가격을 확인하지 못해 주문할 수 없습니다 — 환율로 대신 계산하지 않습니다',
    };
  }
  const min = Number(i.minNotionalUsdt);
  if (Number.isFinite(min) && min > 0 && amount < min) {
    return {
      kind: 'BLOCKED', code: 'BELOW_MIN_NOTIONAL',
      reason: `현재 클라이언트 기준 최소 주문금액 ${min} USDT 미만입니다 (적은 값 ${amount} USDT)`,
    };
  }
  // 명목가·수량·증거금의 뜻은 `convertQuantity` 한 곳에서 온다.
  const c = convertQuantity({
    mode: 'QUOTE_NOTIONAL', value: amount, price: px, leverage: i.leverage ?? null,
  });
  if (!c.ok || c.baseQty == null || !(c.baseQty > 0)) {
    return { kind: 'BLOCKED', code: 'NATIVE_PRICE_UNKNOWN', reason: c.reason || '수량을 만들지 못했습니다' };
  }
  return {
    kind: 'READY',
    notionalUsdt: c.notionalUsd ?? amount,
    qty: c.baseQty,
    marginUsdt: c.marginUsd,
  };
}

/**
 * 거래소 가격·잔고는 **어느 연결에서 읽은 것인가.**
 *
 * 연결을 바꾸면 이전 계정의 값이 남을 수 있다. 실제로 A 계정의 잔고
 * 1,000 USDT를 읽은 뒤 B로 바꾸고 B 조회가 실패하면, 비율 버튼이 **다른
 * 계정의 잔고**로 B 주문 크기를 정할 수 있었다.
 *
 * 값에 출처를 붙여서, 지금 고른 연결의 것이 아니면 쓰지 않는다.
 */
export interface ConnectionScoped<T> {
  connectionId: string | null;
  value: T;
}

/**
 * 이 값이 지금 연결의 것인가.
 *
 * 아니면 **모르는 것으로 본다.** 이전 값을 이어 쓰지 않는다.
 */
export function scopedValueFor<T>(
  held: ConnectionScoped<T> | null | undefined, connectionId: string | null | undefined,
): T | null {
  if (!held) return null;
  if (!connectionId || held.connectionId !== connectionId) return null;
  return held.value;
}

/**
 * 가용 잔고의 상태 — **0과 '못 읽음'은 다르다.**
 *
 * 예전에는 `availableBalance === 0`을 null로 접었다. 그러면 "잔고가
 * 없다"와 "확인하지 못했다"가 같은 화면이 되는데, 앞은 입금하면 되고
 * 뒤는 무엇이 잘못됐는지 알아야 한다.
 */
export type BalanceState =
  | { kind: 'KNOWN'; usdt: number }
  | { kind: 'UNKNOWN' };

export function balanceStateOf(raw: unknown): BalanceState {
  // `Number(null)`은 0이고 `Number('')`도 0이다. 먼저 거르지 않으면
  // **못 읽은 것이 '잔고 0'이 된다** — 이 함수가 가르려던 그 혼동이다.
  if (raw == null || raw === '' || typeof raw === 'boolean') return { kind: 'UNKNOWN' };
  const n = Number(raw);
  // 음수는 정상 값이 아니다 — 못 읽은 것으로 본다.
  if (!Number.isFinite(n) || n < 0) return { kind: 'UNKNOWN' };
  return { kind: 'KNOWN', usdt: n };
}

/**
 * 비율 버튼이 쓸 잔고 — **모드마다 출처가 다르다.**
 *
 * 모의는 원화 연습 장부, 거래소는 그 계정의 가용 USDT다. 연습 잔고를
 * 실전 비율의 근거로 쓰면 **원화 숫자가 달러 주문이 된다.**
 *
 * 못 읽었으면 null이다. 0으로 두면 사용자는 잔고가 없다고 읽는데
 * 실제로는 못 읽은 것이다.
 */
export function percentBaseFor(i: {
  mode: TradeMode | string;
  practiceKrw: number | null | undefined;
  /** 지금 연결에서 읽은 가용 USDT. 못 읽었으면 UNKNOWN */
  balance: BalanceState | null | undefined;
}): {
  base: number | null;
  currency: OrderCurrency;
  /** 왜 못 쓰는가 — 화면이 그대로 적는다 */
  state: 'READY' | 'UNKNOWN' | 'ZERO';
} {
  const currency = orderCurrencyOf(i.mode);
  if (currency === 'USDT') {
    const b = i.balance;
    if (!b || b.kind !== 'KNOWN') return { base: null, currency, state: 'UNKNOWN' };
    if (!(b.usdt > 0)) return { base: null, currency, state: 'ZERO' };
    return { base: b.usdt, currency, state: 'READY' };
  }
  const n = Number(i.practiceKrw);
  if (!Number.isFinite(n)) return { base: null, currency, state: 'UNKNOWN' };
  if (!(n > 0)) return { base: null, currency, state: 'ZERO' };
  return { base: n, currency, state: 'READY' };
}
