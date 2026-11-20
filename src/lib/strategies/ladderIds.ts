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

// 손절 주문에 새길 식별자는 **여기 없다.**
//
// 만들어 두려다 멈췄다. `placeStop` → `futuresSetTpsl`에서 clientOrderId를
// 쓰는 것은 Gate 갈래뿐이고, 바이낸스 갈래는 `placeFuturesTPSL`에 그 칸이
// 없어 **조용히 버려진다.** 쓰이지 않는 생성기를 미리 두면 다음 사람이
// "표식이 새겨진다"고 읽는다 — 그 배선이 생길 때 같이 만든다.
//
// 지금의 소유 증거는 장부에 적는 거래소 주문 번호다
// (`live_orders.sl_order_id` · `stopLedger.ts`).
