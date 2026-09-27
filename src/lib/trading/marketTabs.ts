// src/lib/trading/marketTabs.ts
//
// **거래 화면 상단 시장 탭 — 순서와 이름을 여기서만 정한다.**
//
//     [현물] [USDT-M] [COIN-M] [주식]
//
// 왜 값으로 두는가
// ────────────────
// 탭 목록을 화면에 직접 적으면, 화면이 늘어날 때 **탭만 늘고 배선은 안
// 느는** 상태가 생긴다. 이 저장소가 이름 붙인 1번 고장이다. 목록을 여기
// 한 곳에 두고 화면·검사기·프로브가 같은 배열을 읽으면, 탭을 추가하는
// 순간 "그 탭의 화면이 있는가"를 검사기가 바로 묻는다.
//
// ★ 시장 정체성과 종목 가용성을 **분리한다**
// ──────────────────────────────────────────
// 예전 구조는 `readTradeContext`가 `SPOT`·`USDM`이 아닌 시장을 통째로
// `null`로 버렸다. 그러면 "COIN-M 탭에 들어간다"는 것 자체가 불가능하다.
//
// 그런데 **시장에 들어가는 것**과 **그 시장에서 주문할 수 있는 것**은
// 다른 사실이다:
//
//     market      = COINM      ← 언제나 유효하다 (탭이 넷이므로)
//     instrument  = null       ← 종목 출처가 없으면 없다
//     tradable    = false      ← 종목이 없으면 주문은 잠긴다
//
//     REACHABLE != TRADABLE
//
// 이 구분을 안 하면 둘 중 하나를 하게 된다: 탭을 숨기거나(제품이 작아짐),
// 심볼을 지어내거나(거짓). 둘 다 안 한다.
import type { MarketType } from '../markets/marketType';

/** 탭의 내부 식별자. **화면 문구가 아니라 이 값이 정본이다** */
export type TradingMarketId = 'SPOT' | 'USDM' | 'COINM' | 'STOCK';

export interface MarketTab {
  id: TradingMarketId;
  /** 사용자가 보는 이름 */
  label: string;
}

/**
 * ★ 정본 순서. 바이낸스 모바일과 같은 순서로 둔다.
 *
 * 두 줄로 접거나 드롭다운에 숨기지 않는다 — 좁으면 가로로 스크롤한다.
 * 숨기는 순간 "이 앱에 그 시장이 없다"로 읽힌다.
 */
export const MARKET_TABS: MarketTab[] = [
  { id: 'SPOT',  label: '현물' },
  { id: 'USDM',  label: 'USDT-M' },
  { id: 'COINM', label: 'COIN-M' },
  { id: 'STOCK', label: '주식' },
];

export const MARKET_TAB_IDS: TradingMarketId[] = MARKET_TABS.map(t => t.id);

export function marketTabLabel(id: TradingMarketId): string {
  const t = MARKET_TABS.find(x => x.id === id);
  // 모르는 시장에 이름을 지어 주지 않는다. 이름이 없으면 배선이 빠진 것이다.
  if (!t) throw new Error(`시장 탭에 없는 시장입니다: ${String(id)}`);
  return t.label;
}

/**
 * 밖에서 온 값을 탭 식별자로. **모르면 null이다.**
 *
 * 기본값을 두지 않는다. 어느 쪽으로 떨어뜨려도 위험하다 — 현물로 떨어뜨리면
 * 선물 주문이 현물로 나가고, 선물로 떨어뜨리면 현물이 레버리지로 나간다.
 */
export function readMarketTab(raw: any): TradingMarketId | null {
  const s = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '_');
  if ((MARKET_TAB_IDS as string[]).includes(s)) return s as TradingMarketId;
  // 좁은 별칭만 받는다. 넓게 받으면 오타가 통과한다.
  if (s === 'USDT_M' || s === 'USDSM' || s === 'USD_M' || s === 'USDT_FUTURES') return 'USDM';
  if (s === 'COIN_M' || s === 'COIN_FUTURES') return 'COINM';
  return null;
}

/**
 * 탭 → 시장 유형 정본(`marketType.MarketType`).
 *
 * **화면 선택은 여기서 하지 않는다.** 그건 `tradingScreenRoute`의 일이고,
 * 분기가 두 곳에 있으면 언젠가 갈린다.
 */
const TO_MARKET_TYPE: Record<TradingMarketId, MarketType> = {
  SPOT: 'SPOT',
  USDM: 'USDT_FUTURES',
  COINM: 'COIN_FUTURES',
  STOCK: 'STOCK',
};

export function marketTypeOfTab(id: TradingMarketId): MarketType {
  const t = TO_MARKET_TYPE[id];
  if (!t) throw new Error(`시장 유형이 없는 탭입니다: ${String(id)}`);
  return t;
}
