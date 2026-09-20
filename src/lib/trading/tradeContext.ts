// src/lib/trading/tradeContext.ts
//
// **모드를 바꿔도 잃으면 안 되는 것 — 여기서만 정한다.**
//
// 간편 ↔ 프로를 전환하면 화면 컴포넌트가 통째로 갈린다. 그때 사용자가
// 방금 고른 것이 사라지면, 전환 버튼은 "지금까지 고른 것을 버리는 버튼"이
// 된다. 종목을 다시 찾고 방향을 다시 누르게 하느니 전환을 안 만드는 게 낫다.
//
// ★ `challengeId`는 여기 넣지 않는다
// ──────────────────────────────────
// 넣고 싶어지는 자리다. "주문 문맥"이라는 말에 챌린지도 들어가니까.
// 그런데 challengeId의 정본은 이미 `usePaperTarget`(모듈 싱글턴 +
// localStorage)이고, 두 모드가 같은 인스턴스를 본다 — **전환해도 자동으로
// 유지된다.** 여기 한 벌 더 들고 있으면 두 값이 갈리는 날이 오고, 그날
// 화면은 챌린지 잔고를 보면서 기본 계좌로 주문을 낸다.
//
// 이 저장소가 이미 한 번 겪은 고장이다(`usePaperTarget`의 머리말 참고:
// "컴포넌트마다 자기 useState를 들면 반드시 갈린다").
//
// 그래서 이 타입에는 **계좌·장부에 관한 것이 하나도 없다.** 종목·시장·
// 방향뿐이고, 셋 다 돈을 움직이지 않는다.

import type { PaperMarket } from './useTradeForm';

/** 사용자가 무엇을 하려던 중인가. **BUY/SELL은 화면의 말이다** */
export type TradeDirection = 'BUY' | 'SELL';

export interface TradeContext {
  symbol: string;
  market: PaperMarket;
  direction: TradeDirection;
}

const MARKETS: readonly PaperMarket[] = ['SPOT', 'USDM'];

/**
 * 밖에서 온 값을 문맥으로 읽는다. **못 읽으면 null** — 기본값으로 채우지
 * 않는다. 종목을 모르는 채 주문 화면을 열면 사용자는 자기가 무엇을 사는지
 * 모르는 채로 버튼을 누르게 된다.
 */
export function readTradeContext(raw: any): TradeContext | null {
  if (!raw || typeof raw !== 'object') return null;

  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
  if (!symbol) return null;

  const market = raw.market;
  if (!MARKETS.includes(market)) return null;

  const direction = raw.direction;
  if (direction !== 'BUY' && direction !== 'SELL') return null;

  return { symbol, market, direction };
}

export function sameTradeContext(
  a: TradeContext | null, b: TradeContext | null,
): boolean {
  if (!a || !b) return false;
  return a.symbol === b.symbol
      && a.market === b.market
      && a.direction === b.direction;
}

/**
 * **BUY/SELL → 어느 경로로 가는가.**
 *
 * 이 한 줄이 Phase 3에서 제일 위험한 자리다. `OrderIntent.side`는
 * `'BUY'|'SELL'`이고 `/api/paper/order`의 `side`는 `'LONG'|'SHORT'`다.
 * 모양이 비슷해서 그냥 매핑하고 싶어진다 — 그러면 **현물 "매도"가 공매도
 * 주문이 된다.**
 *
 * 현물에서 파는 것은 **가진 것을 파는 것**이지 새 포지션이 아니다.
 * `buildPaperPlan`이 서버에서 거부하기는 하지만(`paperPlan.ts`의
 * "현물은 숏으로 열 수 없습니다"), 화면이 거기까지 보내는 것 자체가 틀렸다.
 *
 * 선물은 다르다. 거기서 SELL은 진짜로 숏 진입이고, 그건 `/api/paper/order`가
 * 맞다.
 */
export type TradeRoute = 'OPEN_POSITION' | 'SELL_HOLDING';

export function routeFor(ctx: TradeContext | null): TradeRoute | null {
  if (!ctx) return null;
  if (ctx.market === 'SPOT' && ctx.direction === 'SELL') return 'SELL_HOLDING';
  return 'OPEN_POSITION';
}

/**
 * 진입 경로로 갈 때의 방향. **매도가 여기로 오면 안 된다**는 것을
 * 값으로 막는다 — 현물 SELL은 `routeFor`가 이미 다른 길로 보냈다.
 */
export function openSideFor(ctx: TradeContext | null): 'LONG' | 'SHORT' | null {
  if (!ctx) return null;
  if (routeFor(ctx) !== 'OPEN_POSITION') return null;
  return ctx.direction === 'BUY' ? 'LONG' : 'SHORT';
}
