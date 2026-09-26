// src/lib/trading/tradingScreenRoute.ts
//
// **어느 시장이 어느 거래 화면으로 가는가 — 한 곳에서만 정한다.**
//
// 화면이 넷이 되면 `if (market === ...)`를 쓰고 싶어지는 자리가 여러 곳
// 생긴다. 그 분기가 두 곳에 있으면 언젠가 한쪽만 고쳐지고, 그날 COIN-M이
// USDⓈ-M 화면을 받는다 — 그 화면은 계약 수를 코인 개수로 읽는다.
//
// 그래서 **분기를 값으로 만든다.** 화면 선택은 이 파일의 표뿐이고,
// 모르는 시장에는 기본 화면을 주지 않는다.
import { parseMarketType, type MarketType } from '../markets/marketType';
import type { PaperMarket } from './useTradeForm';

/** 모의 장부의 말(`SPOT`·`USDM`)을 시장 유형 정본으로 옮긴다 */
export function marketTypeOfPaper(m: PaperMarket): MarketType {
  const t = parseMarketType(m);
  // `parseMarketType`이 'USDM' → 'USDT_FUTURES'를 이미 안다. 못 읽으면
  // 기본값을 주지 않는다 — 현물로 떨어뜨리면 선물 주문이 현물로 나간다.
  if (!t) throw new Error(`시장 유형을 읽지 못했습니다: ${String(m)}`);
  return t;
}

export type TradingScreenId =
  | 'SPOT_SCREEN' | 'USDM_SCREEN' | 'COINM_SCREEN' | 'STOCK_SCREEN';

const ROUTE: Record<MarketType, TradingScreenId> = {
  SPOT: 'SPOT_SCREEN',
  USDT_FUTURES: 'USDM_SCREEN',
  COIN_FUTURES: 'COINM_SCREEN',
  STOCK: 'STOCK_SCREEN',
};

/** **모르는 시장에 기본 화면을 주지 않는다.** */
export function tradingScreenFor(m: MarketType): TradingScreenId {
  const id = ROUTE[m];
  if (!id) throw new Error(`거래 화면이 없는 시장입니다: ${String(m)}`);
  return id;
}
