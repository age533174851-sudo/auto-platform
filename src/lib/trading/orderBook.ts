// src/lib/trading/orderBook.ts
//
// **호가판의 판단 — 거래 화면 둘이 같은 답을 쓴다.**
//
// 무엇이 갈려 있었나
// ──────────────────
// 호가창이 두 벌이었고, 같은 스트림을 받아 **각자 계산했다.** 그리고 실제로
// 어긋나 있었다 — 가운데 현재가의 폴백이 달랐다:
//
//   터미널   lastPrice ?? 최우선 매수
//   `/` 매매  lastPrice ?? 최우선 매수 ?? 최우선 매도
//
// 스트림이 막 붙어 체결가가 아직 없고 매수 호가만 비어 있는 순간, 한
// 화면은 가격을 보여 주고 다른 화면은 '—'를 보여 줬다. 둘 다 같은 시장을
// 보고 있는데도 그렇다. 이 정도 차이는 아무도 버그로 신고하지 않고, 그래서
// 영원히 남는다.
//
// 그리기는 합치지 않았다
// ──────────────────────
// 두 화면은 테마도 배지도 다르다. `/` 매매 탭에는 네 출처의 최악을 세우는
// `DataHealth` 합성 배지와 "호가창은 암호화폐만 제공합니다" 안내가 있고,
// 터미널에는 없다. 그리기까지 한 벌로 밀면 그 둘이 사라진다 — **디자인
// 작업으로 기능을 지우는 것**이라 하지 않았다.
//
// 그래서 합친 것은 **판단**이다. 몇 줄을 어떤 순서로 보여 줄지, 깊이 막대의
// 분모가 얼마인지, 가운데 값이 무엇인지, 지금 이 판을 믿어도 되는지 —
// 이 파일이 답하고 두 화면이 그대로 받는다.

/** `useBinanceStream`이 주는 한 줄과 같은 모양. 그 모듈에 의존하지 않으려고 다시 적는다. */
export interface BookLevel { price: number; qty: number }

export interface OrderBookLadder {
  /** 매도 — **높은 가격이 위**로 오도록 뒤집은 상태 */
  asks: BookLevel[];
  /** 매수 — 높은 가격부터 */
  bids: BookLevel[];
  /** 깊이 막대의 분모. **0으로 나누지 않는다** */
  maxQty: number;
  /** 가운데 값. 아무것도 못 구하면 null — **지어내지 않는다** */
  mid: number | null;
  /** 보여 줄 줄이 하나라도 있는가 */
  empty: boolean;
}

/**
 * 스트림에서 판을 만든다. **순수 함수다.**
 *
 * `rows`가 0 이하이거나 숫자가 아니면 아무 줄도 만들지 않는다 — 음수를
 * `slice`에 넣으면 뒤에서 세어 **엉뚱한 구간**이 나온다.
 */
export function orderBookLadder(i: {
  asks?: BookLevel[] | null;
  bids?: BookLevel[] | null;
  rows: number;
  /** 체결가. 있으면 이것이 가운데 값이다 */
  lastPrice?: number | null;
}): OrderBookLadder {
  const n = Number(i?.rows);
  const rows = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

  const rawAsks = Array.isArray(i?.asks) ? i.asks : [];
  const rawBids = Array.isArray(i?.bids) ? i.bids : [];

  // 매도는 낮은 가격부터 오므로, 앞에서 `rows`개를 잘라 **뒤집어** 놓는다.
  // 그래야 사다리에서 높은 가격이 위에 온다.
  const asks = rawAsks.slice(0, rows).reverse();
  const bids = rawBids.slice(0, rows);

  let maxQty = 1e-9;   // 0으로 나누지 않기 위한 하한
  for (const l of asks) if (Number.isFinite(l?.qty) && l.qty > maxQty) maxQty = l.qty;
  for (const l of bids) if (Number.isFinite(l?.qty) && l.qty > maxQty) maxQty = l.qty;

  // 가운데 값: 체결가 → 최우선 매수 → 최우선 매도.
  //
  // **최우선 매도까지 본다.** 예전 터미널 판은 매수까지만 봐서, 매수 호가가
  // 비는 순간 가격이 '—'가 됐다. 둘 중 넓은 쪽으로 맞춘다 — 좁은 쪽으로
  // 맞추면 멀쩡히 보이던 값이 사라지는 퇴행이다.
  const last = Number(i?.lastPrice);
  const bestBid = bids.length ? Number(bids[0]?.price) : NaN;
  // asks는 뒤집혀 있으므로 **마지막 줄**이 최우선(가장 낮은) 매도다.
  const bestAsk = asks.length ? Number(asks[asks.length - 1]?.price) : NaN;

  const mid = Number.isFinite(last) && last > 0 ? last
    : Number.isFinite(bestBid) && bestBid > 0 ? bestBid
    : Number.isFinite(bestAsk) && bestAsk > 0 ? bestAsk
    : null;

  return { asks, bids, maxQty, mid, empty: asks.length === 0 && bids.length === 0 };
}

/**
 * 지금 이 판을 실시간으로 볼 수 있는가.
 *
 * **`status`만 보면 안 된다.** 실제로 겪은 고장이 정확히 이것이다 —
 * Binance가 연결은 받아 주고 데이터를 보내지 않아서 화면에 '● 실시간'이
 * 떠 있는데 호가는 비어 있었다. 연결 여부와 신선도는 다른 축이고,
 * **둘 다 참일 때만** 실시간이다.
 */
export function orderBookLive(s: { status?: string | null; stale?: boolean } | null | undefined): boolean {
  return !!s && s.status === 'live' && s.stale !== true;
}
