// src/lib/trading/marketInstrument.ts
//
// **이 시장에서 지금 무엇을 거래하는가 — 그리고 모르면 모른다고 한다.**
//
// ★ 심볼을 만들어내지 않는다. 이 파일의 목적 전부다.
// ────────────────────────────────────────────────────
// 시장 탭을 누르면 가장 하고 싶어지는 일이 "들고 있던 심볼을 그 시장 것으로
// 바꾸기"다. 전부 금지다:
//
//     BTCUSDT (현물) → BTCUSDT (USDⓈ-M)   이름이 같다고 같은 상품이 아니다
//     BTCUSDT        → BTCUSD_PERP         계약 형식을 지어내는 것이다
//     BTCUSDT        → 아무 주식 티커       말이 안 된다
//
// 첫 번째가 제일 위험하다. **그럴듯해서 아무도 의심하지 않는다.** 실제로
// 바이낸스에 둘 다 있더라도, 그 사실을 **우리가 확인한 적이 없으면** 화면이
// 확인한 척하는 것이다. 상장 폐지되거나 티커가 다른 종목에서는 조용히
// 엉뚱한 상품을 주문하게 된다.
//
// 그래서 규칙은 하나다: **출처가 확인해 준 종목만 쓴다.**
//
// 지금 있는 출처
// ──────────────
//   현물   `instrumentRoute.detailTargetOf` — 목록에서 고른 종목을 현물로 준다
//   USDⓈ-M  없다
//   COIN-M  없다
//   주식    없다
//
// 출처가 없는 시장은 **탭에는 들어가되 종목이 비어 있고 주문이 잠긴다.**
// 나중에 출처가 붙으면 `ENTRY` 옆에 항목을 하나 더하면 되고, 화면·검사기는
// 고치지 않아도 된다.
import type { TradingMarketId } from './marketTabs';
import { marketTabLabel } from './marketTabs';
import { isCoinMSymbol } from '../markets/coinM';

/** 지금 거래 대상. **추측으로 만들어진 적이 없다** */
export interface MarketInstrument {
  symbol: string;
  /** 이 종목을 누가 확인해 줬는가. 값으로 들고 다닌다 */
  source: 'ENTRY';
}

/** 사용자가 이 화면에 들어올 때 들고 온 것 */
export interface EntryInstrument {
  symbol: string;
  market: TradingMarketId;
}

export interface InstrumentAvailability {
  market: TradingMarketId;
  /** 없으면 null. **0도 빈 문자열도 아니다** */
  instrument: MarketInstrument | null;
  /** 주문을 낼 수 있는 상태인가 */
  tradable: boolean;
  /** 못 쓰는 이유. 쓸 수 있으면 null */
  reason: string | null;
}

/**
 * 이 시장에서 쓸 종목을 정한다. **없으면 null이고, 왜 없는지 적는다.**
 *
 * `entry`가 그 시장의 것일 때만 종목이 선다. 다른 시장의 종목을 이 시장으로
 * 옮겨 적지 않는다 — 옮기는 순간 그게 추측이다.
 */
export function instrumentForMarket(
  market: TradingMarketId,
  entry: EntryInstrument | null,
): InstrumentAvailability {
  const label = marketTabLabel(market);

  // ── 들고 온 종목이 **바로 이 시장의 것**인가 ──
  if (entry && entry.market === market && entry.symbol) {
    return {
      market,
      instrument: { symbol: entry.symbol, source: 'ENTRY' },
      tradable: true,
      reason: null,
    };
  }

  // ── 아니면 종목이 없다. 사유는 시장마다 다르다 ──
  return { market, instrument: null, tradable: false, reason: reasonFor(market, entry, label) };
}

function reasonFor(
  market: TradingMarketId, entry: EntryInstrument | null, label: string,
): string {
  if (!entry || !entry.symbol) {
    return `${label} 종목을 아직 고르지 않았습니다 — 종목을 고르면 주문할 수 있습니다`;
  }

  const sym = entry.symbol;

  // ★ 아는 **부정 사실**은 구체적으로 적는다. "출처 없음"보다 낫다.
  if (market === 'COINM' && !isCoinMSymbol(sym)) {
    return `${sym}은 COIN-M 계약 형식이 아닙니다 (BTCUSD_PERP 같은 모양). `
      + 'COIN-M 종목 출처가 아직 연결되지 않아 여기서 만들어 쓰지 않습니다';
  }
  if (market === 'STOCK') {
    return `${sym}은 주식 종목이 아닙니다. `
      + '주식 종목 출처(증권사 연결)가 아직 이어지지 않았습니다';
  }

  // 남은 경우 — 이름이 같아 보여도 같은 상품이라고 단정하지 않는다.
  return `${sym}이 ${label}에도 상장돼 있는지 확인할 출처가 없습니다. `
    + `이름이 같다고 같은 상품으로 보지 않습니다 — ${label} 종목을 직접 고르면 주문할 수 있습니다`;
}
