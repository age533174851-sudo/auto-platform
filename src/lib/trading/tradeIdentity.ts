// src/lib/trading/tradeIdentity.ts
//
// **화면이 보는 종목과 주문이 나가는 종목은 같아야 한다.**
//
// 무엇이 문제였나 (Phase 1에 남아 있던 구멍)
// ──────────────────────────────────────────
// `PaperOrderScreen`의 `stream` · `form` · `sell` · `wiring`이 전부
// **들어올 때의 문맥**(`ctx.symbol` · `ctx.market`)에 묶여 있었다. 시장
// 탭을 만들었지만 현물 말고는 잠겨 있어서 드러나지 않았을 뿐이다.
//
// USDⓈ-M 종목 선택을 열면 즉시 이렇게 된다:
//
//     화면 헤더    USDⓈ-M · ETHUSDT
//     실제 주문    SPOT · BTCUSDT      ← 사용자는 알 수 없다
//
// 오류도 안 나고 경고도 없다. 보이는 것과 나가는 것이 다른 종류의 고장이고,
// 이 저장소에서 가장 비싼 종류다.
//
// 그래서 **활성 정체성**을 값으로 만든다
// ──────────────────────────────────────
// 시세·판정·능력표·화면이 전부 이 하나를 본다. 어느 하나가 다른 것을
// 보면 그건 배선이 끊긴 것이고, 검사기가 그것을 본다.
//
//     activeIdentity = { market, symbol }   ← 없으면 null (거래 불가)
//
// ★ 정체성이 바뀌면 이전 주문 입력을 물려주지 않는다
// ──────────────────────────────────────────────────
// 현물 BTC에서 50%를 골라 두고 USDⓈ-M ETH로 넘어갔는데 그 50%와 손절이
// 그대로 살아 있으면, 사용자가 의도한 적 없는 주문이 한 번의 실수로 나간다.
// 배율은 특히 위험하다 — 현물에는 없는 개념이라 1이어야 하는데 100이 남아
// 있을 수 있다.
//
// 초기화 규칙을 화면마다 복제하지 않는다. **여기 한 곳**이고
// `useTradeForm`이 이것을 부른다.
import type { TradingMarketId } from './marketTabs';
import type { MarketInstrument } from './marketInstrument';

/** 지금 이 화면이 실제로 다루는 것. **없으면 null이다** */
export interface TradeIdentity {
  market: TradingMarketId;
  symbol: string;
}

export function activeIdentity(
  market: TradingMarketId, instrument: MarketInstrument | null,
): TradeIdentity | null {
  if (!instrument) return null;
  // 시장이 어긋나면 **정체성을 만들지 않는다.** 여기서 관대하게 넘기면
  // 화면과 주문이 다른 종목을 보는 바로 그 상태가 된다.
  if (instrument.market !== market) return null;
  if (!instrument.symbol) return null;
  return { market, symbol: instrument.symbol };
}

/**
 * 정체성을 한 문자열로. **이 값이 바뀌면 주문 입력을 초기화한다.**
 *
 * 없을 때도 안정된 값을 준다 — `undefined`를 키로 쓰면 "없음 → 없음"
 * 전환이 매번 초기화로 잡힌다.
 */
export function identityKey(id: TradeIdentity | null): string {
  return id ? `${id.market}:${id.symbol}` : 'NONE';
}

export function sameIdentity(a: TradeIdentity | null, b: TradeIdentity | null): boolean {
  return identityKey(a) === identityKey(b);
}

/** 모의 선물의 기본 배율. `useTradeForm`의 초기값과 같은 값이어야 한다 */
export const DEFAULT_FUTURES_LEVERAGE = 10;

export interface IdentityDefaults {
  leverage: number;
  marginMode: 'ISOLATED' | 'CROSSED';
}

/**
 * 이 시장에서 주문 입력이 돌아가야 할 자리.
 *
 * 현물에 배율은 **1이 아니라 없는 개념**이지만, 폼이 숫자를 들고 있어야
 * 하므로 1로 둔다. 화면에는 능력표가 가려서 렌더되지 않는다 — 숫자가
 * 남아 있어도 사용자에게 "1배 레버리지"로 보이지 않는다.
 */
export function identityDefaults(market: TradingMarketId): IdentityDefaults {
  if (market === 'SPOT') return { leverage: 1, marginMode: 'ISOLATED' };
  return { leverage: DEFAULT_FUTURES_LEVERAGE, marginMode: 'ISOLATED' };
}

/** 정체성이 바뀌었을 때 주문 입력이 돌아갈 상태. **한 곳에서만 정한다** */
export interface IdentityResetState {
  sideChosen: false;
  percent: null;
  tp: '';
  sl: '';
  slPct: null;
  message: null;
  leverage: number;
  marginMode: 'ISOLATED' | 'CROSSED';
}

export function identityResetState(market: TradingMarketId): IdentityResetState {
  const d = identityDefaults(market);
  return {
    sideChosen: false,
    percent: null,
    tp: '',
    sl: '',
    slPct: null,
    message: null,
    leverage: d.leverage,
    marginMode: d.marginMode,
  };
}

/**
 * 지금 주문이 **날아가는 중인가.**
 *
 * 날아가는 중에 시장이나 종목을 바꾸면, BTC 주문의 응답이 ETH 화면에
 * 도착한다. 성공 메시지가 엉뚱한 종목 위에 뜨고, 사용자는 그 종목이
 * 체결된 줄 안다.
 */
export function switchBlockedReason(inFlight: boolean): string | null {
  return inFlight
    ? '주문을 보내는 중입니다 — 결과가 올 때까지 시장·종목을 바꿀 수 없습니다'
    : null;
}
