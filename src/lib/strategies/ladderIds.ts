// src/lib/strategies/ladderIds.ts
//
// **계단식 주문의 식별자를 만드는 단 하나의 자리.**
//
// 왜 필요한가
// ───────────
// 진입 식별자는 라우트 안에 이렇게 박혀 있었다:
//
//     const clientOrderId = `LD${tradeDate.replace(/-/g, '')}${symbol}`.slice(0, 36);
//
// 그리고 청산 감시가 손절을 옮길 때 그 주문이 **내 것인지 증명하려면**
// 같은 문자열을 다시 조립해야 한다. 그 조립을 두 곳에 적으면 언젠가
// 한쪽만 바뀌고, 그때 **옮긴 손절이 고아가 됐을 때 "내 것"이라고
// 증명하지 못한다.** 그러면 정리 코드가 안전을 이유로 안 지우고,
// 그 손절은 거래소에 계속 남는다.
//
// 그래서 여기 한 곳에 둔다. 부르는 쪽은 거래일과 종목만 안다.
//
// 형식을 지금 바꾸지 않는 이유
// ────────────────────────────
// `LD…`는 `ownedClientOrderId`의 소유권 형식이 아니다. 바꾸면 소유권
// 파싱이 되지만, **진입 식별자는 멱등 열쇠다** — 형식을 바꾸는 순간
// 배포 경계에서 같은 논리적 주문이 다른 id를 갖게 되고, 그건 중복 진입의
// 문이다. 그 교체는 따로, 하루 잠금이 확실히 서 있는 상태에서 한다.
//
// 지금 고치는 것은 **장부가 새 손절 번호를 기억하지 못하던 것**이다.

/** `2026-08-22` → `20260822` */
function compactDate(tradeDate: any): string {
  return String(tradeDate ?? '').replace(/[^0-9]/g, '');
}

/**
 * 계단식 **진입** 주문의 식별자.
 *
 * 라우트에 박혀 있던 그 값 그대로다 — 이 함수를 만들면서 형식을
 * 바꾸지 않았다. 바꾸면 멱등 열쇠가 바뀐다.
 */
export function ladderEntryClientOrderId(i: { tradeDate: any; symbol: any }): string {
  const sym = String(i.symbol ?? '').toUpperCase();
  return `LD${compactDate(i.tradeDate)}${sym}`.slice(0, 36);
}

/**
 * **같은 손절가로 다시 보내면 같은 id가 나온다.**
 *
 * 손절을 옮기는 것은 "손절을 X로 만든다"는 논리적 행동이다. 재시도는
 * 같은 X이므로 같은 id여야 하고(거래소가 중복으로 막아 준다), 다른
 * 값으로 옮기는 것은 다른 행동이므로 다른 id여야 한다.
 *
 * **시각을 넣지 않는다.** `Date.now()`를 섞으면 재시도마다 새 id가 되고,
 * 그건 멱등이 아니라 중복이다.
 */
export function ladderStopClientOrderId(i: {
  tradeDate: any; symbol: any; stopPrice: number;
}): string {
  const base = ladderEntryClientOrderId({ tradeDate: i.tradeDate, symbol: i.symbol });
  return `${base}S${priceTag(i.stopPrice)}`.slice(0, 36);
}

/**
 * 손절가 하나를 짧고 **안정적인** 숫자로.
 *
 * `Math.round(price * 100) % 1e6` 같은 것은 안 된다 — BTC의 60,000과
 * 70,000이 둘 다 0이 되어 같은 id가 나온다. 그러면 손절을 옮겼는데
 * 거래소가 중복이라고 거절하고, 옛 손절이 그대로 남는다.
 *
 * FNV-1a 32비트를 쓴다. 자릿수가 아니라 값 전체를 섞으므로 가까운
 * 가격끼리 붙지 않는다.
 */
export function priceTag(price: number): string {
  const s = Number.isFinite(price) ? String(Math.round(Number(price) * 1e8)) : '0';
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k += 1) {
    h ^= s.charCodeAt(k);
    // >>> 0 으로 32비트를 유지한다. 안 하면 부호 비트가 섞여 값이 갈린다.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return String(h % 1_000_000);
}
