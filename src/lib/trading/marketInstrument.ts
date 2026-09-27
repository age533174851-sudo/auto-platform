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
// 확인한 척하는 것이다.
//
// 그래서 규칙은 하나다: **출처가 확인해 준 종목만 쓴다.**
//
// 지금 있는 출처
// ──────────────
//   ENTRY    사용자가 들고 들어온 종목 (`instrumentRoute.detailTargetOf` → 현물)
//   CATALOG  거래소 상장 목록 (`instrumentCatalog`, 현물 · USDⓈ-M)
//
// COIN-M · 주식은 아직 어느 출처도 없다. 탭에는 들어가되 종목이 비고
// 주문이 잠긴다 — **REACHABLE != TRADABLE**.
//
// ★ 시장마다 고른 종목을 따로 기억한다
// ────────────────────────────────────
// 현물에서 BTCUSDT를 보다가 USDⓈ-M으로 갔다가 돌아오면 BTCUSDT여야 한다.
// 그런데 그 "기억"을 시장 사이에 **복사하면** 그게 곧 추측이다. 그래서
// 저장도 조회도 시장별로 칸이 갈려 있고, `selectInstrument`가 다른 시장의
// 종목을 그 칸에 넣는 것을 거부한다.
import type { TradingMarketId } from './marketTabs';
import { marketTabLabel, MARKET_TAB_IDS } from './marketTabs';
import { isCoinMSymbol } from '../markets/coinM';
import type { CatalogInstrument, CatalogSource } from './instrumentCatalog';

/** 지금 거래 대상. **추측으로 만들어진 적이 없다** */
export interface MarketInstrument {
  /** 어느 시장의 종목인가. **이 값과 다른 시장 화면에 쓰이면 안 된다** */
  market: TradingMarketId;
  symbol: string;
  /** 거래소가 말해 준 경우에만 채운다. 모르면 null — 심볼에서 잘라내지 않는다 */
  baseAsset: string | null;
  quoteAsset: string | null;
  /** 이 종목을 누가 확인해 줬는가. 값으로 들고 다닌다 */
  source: 'ENTRY' | 'CATALOG';
  /** 목록에서 왔으면 어느 목록인가 */
  catalogSource: CatalogSource | null;
  /** 그 출처를 읽은 시각. 모르면 null */
  asOf: number | null;
}

/** 목록의 한 줄을 이 시장의 종목으로. **시장을 바꿔 담지 않는다** */
export function instrumentFromCatalog(row: CatalogInstrument): MarketInstrument {
  return {
    market: row.market,
    symbol: row.symbol,
    baseAsset: row.baseAsset,
    quoteAsset: row.quoteAsset,
    source: 'CATALOG',
    catalogSource: row.catalogSource,
    asOf: row.asOf,
  };
}

/** 사용자가 이 화면에 들어올 때 들고 온 것 */
export interface EntryInstrument {
  symbol: string;
  market: TradingMarketId;
}

/** 시장마다 따로 기억하는 선택. **칸이 갈려 있는 것이 계약이다** */
export type SelectedByMarket = Partial<Record<TradingMarketId, MarketInstrument | null>>;

export const EMPTY_SELECTION: SelectedByMarket = {};

/**
 * 고른 종목을 그 시장 칸에 넣는다.
 *
 * ★ **다른 시장의 종목은 받지 않는다.** 이 한 줄이 "탭을 옮겼더니 심볼이
 *   따라왔다"를 막는다 — 복사가 일어나는 자리는 여기뿐이고, 여기서 막으면
 *   다른 곳에서 일어날 수 없다.
 */
export function selectInstrument(
  prev: SelectedByMarket, market: TradingMarketId, next: MarketInstrument | null,
): SelectedByMarket {
  if (!(MARKET_TAB_IDS as string[]).includes(market)) {
    throw new Error(`모르는 시장에 종목을 넣으려 했습니다: ${String(market)}`);
  }
  if (next && next.market !== market) {
    throw new Error(
      `${next.market} 종목(${next.symbol})을 ${market} 칸에 넣으려 했습니다 — `
      + '이름이 같아도 다른 시장의 상품입니다');
  }
  return { ...prev, [market]: next ?? null };
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
 * 우선순위
 *   ① 사용자가 **이 시장에서** 고른 종목 (`selected[market]`)
 *   ② 들고 온 종목이 **바로 이 시장의 것**일 때 (`entry`)
 *   ③ 없다
 *
 * 다른 시장의 종목을 이 시장으로 옮겨 적는 경로는 없다.
 */
export function instrumentForMarket(
  market: TradingMarketId,
  entry: EntryInstrument | null,
  selected: SelectedByMarket = EMPTY_SELECTION,
): InstrumentAvailability {
  const label = marketTabLabel(market);

  // ── ① 이 시장에서 고른 종목 ──
  const picked = selected[market] ?? null;
  if (picked) {
    if (picked.market !== market) {
      // 여기 오면 저장 단계가 뚫린 것이다. 조용히 쓰지 않는다.
      return {
        market, instrument: null, tradable: false,
        reason: `저장된 종목이 ${picked.market}의 것입니다 (${picked.symbol}) — `
          + `${label} 종목을 다시 고르세요`,
      };
    }
    return { market, instrument: picked, tradable: true, reason: null };
  }

  // ── ② 들고 온 종목이 바로 이 시장의 것인가 ──
  if (entry && entry.market === market && entry.symbol) {
    return {
      market,
      instrument: {
        market, symbol: entry.symbol,
        baseAsset: null, quoteAsset: null,
        source: 'ENTRY', catalogSource: null, asOf: null,
      },
      tradable: true,
      reason: null,
    };
  }

  // ── ③ 없다. 사유는 시장마다 다르다 ──
  return { market, instrument: null, tradable: false, reason: reasonFor(market, entry, label) };
}

function reasonFor(
  market: TradingMarketId, entry: EntryInstrument | null, label: string,
): string {
  // ★ 아는 **부정 사실**은 구체적으로 적는다. "출처 없음"보다 낫다.
  if (market === 'COINM') {
    const sym = entry?.symbol;
    const notCoinM = sym && !isCoinMSymbol(sym)
      ? `${sym}은 COIN-M 계약 형식이 아닙니다 (BTCUSD_PERP 같은 모양). ` : '';
    return notCoinM
      + 'COIN-M 종목 목록 출처가 아직 없어 여기서 만들어 쓰지 않습니다';
  }
  if (market === 'STOCK') {
    return '주식 종목 목록 출처가 아직 없습니다 — 지금 있는 주식 시세는 '
      + 'mock fallback을 포함하고 있어 주문 가능 종목의 근거로 쓰지 않습니다';
  }
  return `${label} 종목을 아직 고르지 않았습니다 — `
    + `종목을 고르면 주문할 수 있습니다`;
}
