// src/lib/trading/streamEndpoints.ts
//
// "이 심볼의 실시간 값을 어디서 받는가"를 정하는 한 곳.
//
// 왜 분리하는가
// ─────────────
// useBinanceStream은 심볼만 보고 무조건 선물(fapi)에 붙어 있었다. 그래서
// 현물(SPOT) 화면도 선물 호가와 선물 24시간 통계를 보고 있었다. 같은
// 화면에서 차트는 현물 봉을, 헤더는 선물 통계를 보여주는 상태다 —
// 사용자는 둘이 다른 시장이라는 걸 알 방법이 없다.
//
// 시장별 주소 선택을 컴포넌트마다 흩어 놓으면 "경로가 둘인데 한쪽만
// 고침"이 된다. 그래서 주소를 고르는 판단은 이 파일 하나에만 둔다.
//
// 여기에 없는 것
// ──────────────
// 가격을 만들어 내는 코드는 없다. 이 파일은 주소 문자열과 응답 파싱만
// 한다. 읽지 못한 값은 null이고, 0으로 적지 않는다.

export type StreamMarket = 'SPOT' | 'USDM';

export const STREAM_MARKETS: StreamMarket[] = ['SPOT', 'USDM'];

/** 모르는 값은 null이다. 기본값으로 때우면 현물이 선물 값을 보게 된다. */
export function streamMarketOf(raw: any): StreamMarket | null {
  if (typeof raw !== 'string') return null;
  const up = raw.trim().toUpperCase();
  return (STREAM_MARKETS as string[]).includes(up) ? (up as StreamMarket) : null;
}

function cleanSymbol(raw: any): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  // 주소에 그대로 들어가는 값이다. 영문·숫자 외에는 받지 않는다.
  return /^[A-Z0-9]{2,20}$/.test(s) ? s : null;
}

/**
 * 허브 키. 시장이 키에 들어가야 한다 —
 * 심볼만으로 키를 만들면 현물 화면과 선물 화면이 같은 소켓을 나눠 쓰고,
 * 먼저 붙은 쪽의 시장이 나중 쪽에도 그대로 보인다.
 */
export function hubKey(market: StreamMarket, symbol: string): string {
  return `${market}:${symbol}`;
}

/** 호가 + 최우선호가 스트림. 시장을 모르면 null이다. */
export function wsStreamUrl(rawMarket: any, rawSymbol: string): string | null {
  const market = streamMarketOf(rawMarket);
  const symbol = cleanSymbol(rawSymbol);
  if (!market || !symbol) return null;
  const s = symbol.toLowerCase();
  const streams = `${s}@depth20@100ms/${s}@bookTicker`;
  return market === 'USDM'
    ? `wss://fstream.binance.com/stream?streams=${streams}`
    : `wss://stream.binance.com:9443/stream?streams=${streams}`;
}

/** 24시간 통계(REST). 시장을 모르면 null이다. */
export function ticker24hUrl(rawMarket: any, rawSymbol: string): string | null {
  const market = streamMarketOf(rawMarket);
  const symbol = cleanSymbol(rawSymbol);
  if (!market || !symbol) return null;
  return market === 'USDM'
    ? `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`
    : `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;
}

/**
 * 마크가격(REST). 현물에는 마크가격이라는 개념이 없으므로 null이다.
 * 없는 값을 현재가로 대신 채우지 않는다.
 */
export function markPriceUrl(rawMarket: any, rawSymbol: string): string | null {
  const market = streamMarketOf(rawMarket);
  const symbol = cleanSymbol(rawSymbol);
  if (!market || !symbol) return null;
  if (market !== 'USDM') return null;
  return `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;
}

export interface Ticker24h {
  changePct: number | null;
  high: number | null;
  low: number | null;
  /** 기준통화 거래량 (BTC 수량) */
  volume: number | null;
  /** 상대통화 거래량 (USDT 금액) */
  quoteVolume: number | null;
}

/** null·빈 문자열은 0이 아니라 null이다. Number(null) === 0 함정을 막는다. */
function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 현물과 선물의 24hr 응답은 필드 이름이 같다
 * (priceChangePercent / highPrice / lowPrice / volume / quoteVolume).
 * 그래도 못 읽은 칸은 칸마다 따로 null로 남긴다 — 하나를 못 읽었다고
 * 나머지를 버릴 이유는 없고, 못 읽은 것을 0으로 적을 이유는 더 없다.
 */
export function parseTicker24h(raw: any): Ticker24h | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Ticker24h = {
    changePct: num(raw.priceChangePercent),
    high: num(raw.highPrice),
    low: num(raw.lowPrice),
    volume: num(raw.volume),
    quoteVolume: num(raw.quoteVolume),
  };
  // 전부 못 읽었으면 응답이 우리가 아는 모양이 아니다.
  const any = out.changePct !== null || out.high !== null || out.low !== null
    || out.volume !== null || out.quoteVolume !== null;
  return any ? out : null;
}

/** premiumIndex 응답에서 마크가격만. 못 읽으면 null이다. */
export function parseMarkPrice(raw: any): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = num(raw.markPrice);
  return n !== null && n > 0 ? n : null;
}

/**
 * depth20 응답의 호가 배열을 꺼낸다.
 *
 * 선물은 {a, b}, 현물은 {asks, bids}로 온다. 같은 스트림 이름인데 필드가
 * 다르다. 한쪽만 읽으면 현물 호가창이 조용히 빈 채로 뜬다 — 연결은
 * 살아 있으므로 오류도 나지 않는다.
 */
export function depthRowsOf(d: any): { asks: any[]; bids: any[] } | null {
  if (!d || typeof d !== 'object') return null;
  const asks = Array.isArray(d.a) ? d.a : Array.isArray(d.asks) ? d.asks : null;
  const bids = Array.isArray(d.b) ? d.b : Array.isArray(d.bids) ? d.bids : null;
  if (!asks || !bids) return null;
  return { asks, bids };
}
