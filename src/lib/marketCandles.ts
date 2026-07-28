// src/lib/marketCandles.ts
//
// 시장별 캔들 조회를 한 곳으로 모은다.
//
// 기술 지표(RSI·EMA·MACD)와 진단 로직은 시장과 무관하다 — 종가 배열만 있으면
// 된다. 그런데 분석 라우트들이 각자 toBinanceSymbol()을 두고 crypto가 아니면
// null을 돌려주는 바람에, 주식·ETF는 "지원하지 않는 종목"으로 막혀 있었다.
// 막힌 것은 지표가 아니라 데이터 소스였다.
//
// 소스
//   crypto        Binance klines (키 불필요)
//   stock / etf   FMP historical-chart (FMP_API_KEY 필요)
//   그 외          미지원 — 이유를 문자열로 돌려준다

export type CandleMarket = 'crypto' | 'stock' | 'etf' | 'index' | 'krstock' | string;

export interface Candles {
  closes: number[];
  volumes: number[];
  highs: number[];
  lows: number[];
  /** 어디서 받아왔는지 — 응답에 실어 사용자가 출처를 알 수 있게 한다 */
  source: 'binance' | 'yahoo' | 'fmp';
  symbol: string;
}

export interface CandleError {
  error: string;
  message: string;
}

export type CandleResult = Candles | CandleError;

export function isCandleError(r: CandleResult): r is CandleError {
  return (r as CandleError).error !== undefined;
}

// ── Binance ───────────────────────────────────────────────────
const BINANCE_TF: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1d': '1d',
};

function toBinanceSymbol(asset: string): string {
  const a = asset.toUpperCase().replace(/USDT$|KRW$|USD$/i, '');
  return `${a}USDT`;
}

async function fetchBinance(asset: string, timeframe: string, limit: number): Promise<CandleResult> {
  const interval = BINANCE_TF[timeframe];
  if (!interval) return { error: 'unsupported_timeframe', message: `${timeframe}는 지원하지 않는 시간대입니다` };

  const symbol = toBinanceSymbol(asset);
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { signal: AbortSignal.timeout(9000) },
    );
    if (r.status === 400) {
      return { error: 'symbol_not_found', message: `Binance에 ${symbol} 페어가 없습니다` };
    }
    if (!r.ok) return { error: 'fetch_failed', message: `Binance 응답 오류 (${r.status})` };
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return { error: 'no_data', message: `${symbol} 캔들 데이터가 비어 있습니다` };
    }
    const closes: number[] = [], volumes: number[] = [], highs: number[] = [], lows: number[] = [];
    for (const k of rows) {
      const c = parseFloat(k[4]);
      if (!Number.isFinite(c)) continue;
      closes.push(c);
      highs.push(parseFloat(k[2]));
      lows.push(parseFloat(k[3]));
      volumes.push(parseFloat(k[5]) || 0);
    }
    return { closes, volumes, highs, lows, source: 'binance', symbol };
  } catch (e: any) {
    return { error: 'fetch_failed', message: e?.message || 'Binance 조회 실패' };
  }
}

// ── Yahoo Finance (주식·ETF·지수·국내주식) ───────────────────
//
// FMP를 먼저 붙였다가 되돌렸다. 배포 환경의 FMP_API_KEY로 historical-chart를
// 부르면 403이 온다 (키 무효 또는 해당 엔드포인트 유료 전환).
// Yahoo는 키가 필요 없고 미국주식·ETF·지수·국내주식(.KS/.KQ)을 모두 준다.
//
// 응답: { chart: { result: [{ timestamp: [...],
//                             indicators: { quote: [{ open, high, low, close, volume }] } }] } }

const YAHOO_TF: Record<string, { interval: string; range: string }> = {
  // 1분봉은 Yahoo가 최근 7일까지만 준다
  '1m':  { interval: '1m',  range: '5d'  },
  '5m':  { interval: '5m',  range: '1mo' },
  '15m': { interval: '15m', range: '1mo' },
  '30m': { interval: '30m', range: '3mo' },
  '1h':  { interval: '1h',  range: '6mo' },
  '4h':  { interval: '1h',  range: '1y'  },   // Yahoo에 4h가 없어 1h로 대체
  '1d':  { interval: '1d',  range: '2y'  },
};

/** 국내 6자리 종목코드는 거래소 접미사가 필요하다 (.KS 코스피 / .KQ 코스닥) */
function yahooSymbolCandidates(asset: string, market: string): string[] {
  const a = asset.toUpperCase().trim();
  if (market === 'krstock' || /^\d{6}$/.test(a)) return [`${a}.KS`, `${a}.KQ`];
  return [a];
}

async function fetchYahoo(asset: string, market: string, timeframe: string, limit: number): Promise<CandleResult> {
  const tf = YAHOO_TF[timeframe] || YAHOO_TF['1d'];
  const candidates = yahooSymbolCandidates(asset, market);
  let lastMsg = '';

  for (const symbol of candidates) {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?range=${tf.range}&interval=${tf.interval}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12_000) },
      );
      if (!r.ok) { lastMsg = `Yahoo 응답 오류 (${r.status})`; continue; }

      const d = await r.json();
      const res = d?.chart?.result?.[0];
      const q = res?.indicators?.quote?.[0];
      if (!res || !q || !Array.isArray(q.close)) {
        lastMsg = `${symbol}의 시세 데이터를 찾지 못했습니다`;
        continue;
      }

      const closes: number[] = [], volumes: number[] = [], highs: number[] = [], lows: number[] = [];
      for (let i = 0; i < q.close.length; i++) {
        const c = Number(q.close[i]);
        if (!Number.isFinite(c)) continue;   // 휴장일은 null로 온다
        closes.push(c);
        highs.push(Number(q.high?.[i]) || c);
        lows.push(Number(q.low?.[i]) || c);
        volumes.push(Number(q.volume?.[i]) || 0);
      }
      if (closes.length === 0) { lastMsg = `${symbol} 종가가 비어 있습니다`; continue; }

      // 최근 limit개만 쓴다 (오래된 것 → 최신 순서 유지)
      const start = Math.max(0, closes.length - limit);
      return {
        closes: closes.slice(start), volumes: volumes.slice(start),
        highs: highs.slice(start), lows: lows.slice(start),
        source: 'yahoo', symbol,
      };
    } catch (e: any) {
      lastMsg = e?.message || 'Yahoo 조회 실패';
    }
  }
  return { error: 'no_data', message: lastMsg || `${asset}의 시세를 찾지 못했습니다 (티커를 확인해주세요)` };
}

// ── FMP (예비) ────────────────────────────────────────────────
// 키가 유효해지면 쓸 수 있도록 남겨둔다. 현재 배포에서는 403이 온다.
const FMP_TF: Record<string, string> = {
  '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min',
  '1h': '1hour', '4h': '4hour',
};

async function fetchFmp(asset: string, timeframe: string, limit: number): Promise<CandleResult> {
  const key = process.env.FMP_API_KEY || '';
  if (!key) {
    return { error: 'no_provider_key', message: '주식 분석에는 FMP_API_KEY가 필요합니다 (서버 환경변수 미설정)' };
  }
  const symbol = asset.toUpperCase().trim();
  const base = 'https://financialmodelingprep.com/api/v3';

  const url = timeframe === '1d'
    ? `${base}/historical-price-full/${symbol}?apikey=${key}`
    : `${base}/historical-chart/${FMP_TF[timeframe] || '1hour'}/${symbol}?apikey=${key}`;

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) return { error: 'fetch_failed', message: `FMP 응답 오류 (${r.status})` };
    const d = await r.json();

    // 일봉은 { historical: [...] }, intraday는 배열로 온다
    const rows: any[] = Array.isArray(d) ? d : (Array.isArray(d?.historical) ? d.historical : []);
    if (rows.length === 0) {
      return { error: 'no_data', message: `${symbol}의 시세 데이터를 찾지 못했습니다 (티커를 확인해주세요)` };
    }

    // FMP는 최신순으로 준다. 지표 계산은 과거→현재 순서를 전제하므로 뒤집는다.
    const asc = rows.slice(0, limit).reverse();
    const closes: number[] = [], volumes: number[] = [], highs: number[] = [], lows: number[] = [];
    for (const k of asc) {
      const c = Number(k.close);
      if (!Number.isFinite(c)) continue;
      closes.push(c);
      highs.push(Number(k.high) || c);
      lows.push(Number(k.low) || c);
      volumes.push(Number(k.volume) || 0);
    }
    if (closes.length === 0) {
      return { error: 'no_data', message: `${symbol}의 종가를 읽지 못했습니다` };
    }
    return { closes, volumes, highs, lows, source: 'fmp', symbol };
  } catch (e: any) {
    return { error: 'fetch_failed', message: e?.message || 'FMP 조회 실패' };
  }
}

// ── 진입점 ────────────────────────────────────────────────────
/**
 * 시장에 맞는 소스에서 캔들을 가져온다.
 * market을 주지 않으면 티커 모양으로 추정한다 (6자리 숫자=국내주식 등).
 */
export async function fetchCandles(
  asset: string,
  market: CandleMarket = 'crypto',
  timeframe = '1h',
  limit = 200,
): Promise<CandleResult> {
  const a = (asset || '').trim();
  if (!a) return { error: 'missing_asset', message: '종목을 지정해주세요' };

  const m = String(market || 'crypto').toLowerCase();

  if (m === 'crypto') return fetchBinance(a, timeframe, limit);

  // 주식·ETF·지수·국내주식은 Yahoo에서 받는다. 실패하면 FMP로 한 번 더 시도한다
  // (FMP 키가 유효해지면 자동으로 살아난다).
  if (m === 'stock' || m === 'etf' || m === 'index' || m === 'krstock') {
    const y = await fetchYahoo(a, m, timeframe, limit);
    if (!isCandleError(y)) return y;
    if (m !== 'krstock' && process.env.FMP_API_KEY) {
      const f = await fetchFmp(a, timeframe, limit);
      if (!isCandleError(f)) return f;
    }
    return y;
  }

  return {
    error: 'market_not_supported',
    message: `${market} 시장은 아직 지표 분석을 지원하지 않습니다`,
  };
}
