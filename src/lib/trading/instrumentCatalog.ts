// src/lib/trading/instrumentCatalog.ts
//
// **이 시장에 무엇이 상장돼 있는가 — 거래소가 말한 것만 적는다.**
//
// 왜 정본이 따로 필요한가
// ───────────────────────
// Phase 1에서 시장 탭 넷을 열었지만, 종목 출처가 없는 시장은 잠겨 있었다.
// 이제 그 출처를 만든다. 그런데 출처를 만드는 순간 가장 하기 쉬운 실수가
// **이름으로 상장을 추론하는 것**이다:
//
//     현물에 BTCUSDT가 있으니 선물에도 있겠지   ← 확인한 적이 없다
//     BTCUSDT를 BTCUSD_PERP으로 바꾸면 COIN-M   ← 계약을 지어낸 것이다
//
// 그래서 이 파일은 **파싱만 한다.** 거래소 응답에 실제로 들어 있는 줄만
// 종목이 되고, 없으면 없는 것이다. 심볼을 만드는 코드가 한 줄도 없다.
//
// 무엇을 통과시키는가
// ───────────────────
//   현물    `status === 'TRADING'` · `quoteAsset === 'USDT'`
//   USDⓈ-M  `status === 'TRADING'` · `contractType === 'PERPETUAL'`
//           · `quoteAsset === 'USDT'`
//
// USDT 결제만 받는 이유는 **모의 장부가 USDT 기준**이기 때문이다. 다른
// 결제통화 상품을 목록에 넣으면 잔고 단위가 섞인다. 이건 거래소의 제한이
// 아니라 우리 장부의 제한이므로, 그 사실을 `quoteFilter`로 값에 적어 둔다.
//
// COIN-M · 주식은 여기서 열지 않는다
// ──────────────────────────────────
// COIN-M은 계약 크기·증거금 코인이 달라 같은 장부로 다룰 수 없고, 주식은
// `/api/stocks`가 **mock fallback**을 갖고 있어(`status: 'mock'`) 주문 가능
// 종목의 출처로 쓸 수 없다. 목록이 보인다는 것과 거래할 수 있다는 것은
// 다른 사실이다.
import type { TradingMarketId } from './marketTabs';

/** 이 목록을 누가 말했는가. **값으로 들고 다닌다** */
export type CatalogSource =
  | 'BINANCE_SPOT_EXCHANGE_INFO'
  | 'BINANCE_USDM_EXCHANGE_INFO';

export interface CatalogInstrument {
  market: TradingMarketId;
  /** 거래소가 쓰는 그대로. **가공하지 않는다** */
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  catalogSource: CatalogSource;
  /** 이 목록을 읽은 시각 */
  asOf: number;
}

/** 이번 단계에서 실제 목록 권위가 열린 시장 */
export const CATALOG_MARKETS: TradingMarketId[] = ['SPOT', 'USDM'];

export interface CatalogAvailability {
  open: boolean;
  /** 안 열린 이유. 열렸으면 null */
  reason: string | null;
}

/**
 * 이 시장의 목록 권위가 열려 있는가. **모르는 시장을 열어 주지 않는다.**
 */
export function catalogOpenFor(market: TradingMarketId): CatalogAvailability {
  if (market === 'SPOT' || market === 'USDM') return { open: true, reason: null };
  if (market === 'COINM') {
    return {
      open: false,
      reason: 'COIN-M 종목 목록 출처가 아직 없습니다 — 계약 수·담보 코인이 달라 '
        + '현물/USDⓈ-M 목록에서 만들어 쓸 수 없습니다',
    };
  }
  return {
    open: false,
    reason: '주식 종목 목록 출처가 아직 없습니다 — 지금 있는 주식 시세는 '
      + 'mock fallback을 포함하고 있어 주문 가능 종목의 근거로 쓰지 않습니다',
  };
}

/** 모의 장부가 다루는 결제통화. **거래소 제한이 아니라 우리 장부의 제한이다** */
export const CATALOG_QUOTE = 'USDT';

const str = (v: any) => (typeof v === 'string' ? v : '').trim().toUpperCase();

/**
 * 바이낸스 **현물** exchangeInfo → 종목 목록.
 *
 * 응답에 없는 줄은 만들지 않는다. 필드가 비면 그 줄을 **버린다** —
 * `baseAsset`을 심볼에서 잘라내 추측하지 않는다.
 */
export function parseSpotCatalog(payload: any, asOf: number): CatalogInstrument[] {
  const rows = Array.isArray(payload?.symbols) ? payload.symbols : [];
  const out: CatalogInstrument[] = [];
  for (const r of rows) {
    if (str(r?.status) !== 'TRADING') continue;
    const symbol = str(r?.symbol);
    const baseAsset = str(r?.baseAsset);
    const quoteAsset = str(r?.quoteAsset);
    if (!symbol || !baseAsset || !quoteAsset) continue;
    if (quoteAsset !== CATALOG_QUOTE) continue;
    out.push({
      market: 'SPOT', symbol, baseAsset, quoteAsset,
      catalogSource: 'BINANCE_SPOT_EXCHANGE_INFO', asOf,
    });
  }
  return dedupe(out);
}

/**
 * 바이낸스 **USDⓈ-M** exchangeInfo → 종목 목록.
 *
 * ★ `contractType === 'PERPETUAL'`을 반드시 본다. 분기물(`CURRENT_QUARTER`)은
 *   만기가 있어 무기한과 같은 장부로 다룰 수 없다.
 * ★ 현물에 같은 이름이 있다는 이유로 여기 넣지 않는다. **이 응답에
 *   들어 있어야** 선물 종목이다.
 */
export function parseUsdmCatalog(payload: any, asOf: number): CatalogInstrument[] {
  const rows = Array.isArray(payload?.symbols) ? payload.symbols : [];
  const out: CatalogInstrument[] = [];
  for (const r of rows) {
    if (str(r?.status) !== 'TRADING') continue;
    if (str(r?.contractType) !== 'PERPETUAL') continue;
    const symbol = str(r?.symbol);
    const baseAsset = str(r?.baseAsset);
    const quoteAsset = str(r?.quoteAsset);
    if (!symbol || !baseAsset || !quoteAsset) continue;
    if (quoteAsset !== CATALOG_QUOTE) continue;
    out.push({
      market: 'USDM', symbol, baseAsset, quoteAsset,
      catalogSource: 'BINANCE_USDM_EXCHANGE_INFO', asOf,
    });
  }
  return dedupe(out);
}

function dedupe(rows: CatalogInstrument[]): CatalogInstrument[] {
  const seen = new Set<string>();
  const out: CatalogInstrument[] = [];
  for (const r of rows) {
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    out.push(r);
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

/** 시장별 파서. **모르는 시장에는 파서를 주지 않는다** */
export function parseCatalogFor(
  market: TradingMarketId, payload: any, asOf: number,
): CatalogInstrument[] {
  if (market === 'SPOT') return parseSpotCatalog(payload, asOf);
  if (market === 'USDM') return parseUsdmCatalog(payload, asOf);
  throw new Error(`목록 권위가 없는 시장입니다: ${String(market)}`);
}

/**
 * 이미 받아 둔 목록 안에서 찾는다. **타이핑마다 거래소를 부르지 않는다.**
 *
 * 빈 검색어는 목록 그대로다 — 아무것도 없는 것처럼 보이면 사용자는
 * "종목이 없다"로 읽는다.
 */
export function searchCatalog(
  rows: readonly CatalogInstrument[], query: string, limit = 60,
): CatalogInstrument[] {
  const q = String(query || '').trim().toUpperCase();
  if (!q) return rows.slice(0, limit);
  const starts: CatalogInstrument[] = [];
  const contains: CatalogInstrument[] = [];
  for (const r of rows) {
    if (r.symbol.startsWith(q) || r.baseAsset.startsWith(q)) starts.push(r);
    else if (r.symbol.includes(q)) contains.push(r);
  }
  return [...starts, ...contains].slice(0, limit);
}
