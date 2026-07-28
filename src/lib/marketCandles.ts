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
  source: 'binance' | 'fmp';
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

// ── FMP (주식·ETF) ────────────────────────────────────────────
// intraday는 historical-chart, 일봉은 historical-price-full을 쓴다.
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
  if (m === 'stock' || m === 'etf' || m === 'index') return fetchFmp(a, timeframe, limit);

  if (m === 'krstock') {
    return {
      error: 'market_not_supported',
      message: '국내 주식은 아직 지표 분석 데이터를 연결하지 않았습니다. 차트 탭에서 확인해주세요.',
    };
  }

  return {
    error: 'market_not_supported',
    message: `${market} 시장은 아직 지표 분석을 지원하지 않습니다`,
  };
}
