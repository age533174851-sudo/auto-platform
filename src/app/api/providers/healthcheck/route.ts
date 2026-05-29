// /api/providers/healthcheck
// 각 데이터 제공사를 실제 호출해서 상태 진단
//
// 상태: 'ok'(🟢) | 'limited'(🟡) | 'error'(🔴) | 'unconfigured'(⚪)
// 응답속도 + 상세 사유 포함

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Status = 'ok' | 'limited' | 'error' | 'unconfigured';

interface ProviderHealth {
  id:        string;
  name:      string;
  nameKr:    string;
  type:      string;
  status:    Status;
  latencyMs: number | null;
  detail:    string;
  sample?:   string;       // 실제 조회 값 (예: "USD/KRW 1375")
}

// HTTP 상태코드 → 친절한 사유
function diagnose(code: number): { status: Status; detail: string } {
  if (code === 200) return { status: 'ok', detail: '정상' };
  if (code === 401 || code === 403) return { status: 'error', detail: 'API 키 무효 또는 권한 부족 (Invalid Key / Subscription Required)' };
  if (code === 429) return { status: 'limited', detail: '요청 한도 초과 (Rate Limit Exceeded)' };
  if (code >= 500) return { status: 'error', detail: `서버 오류 (HTTP ${code})` };
  return { status: 'error', detail: `HTTP ${code}` };
}

async function timed(fn: () => Promise<ProviderHealth>): Promise<ProviderHealth> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ...r, latencyMs: r.latencyMs ?? (Date.now() - t0) };
  } catch (e: any) {
    return {
      id: 'unknown', name: '', nameKr: '', type: '',
      status: 'error', latencyMs: Date.now() - t0,
      detail: e?.message?.includes('timeout') ? '응답 시간 초과' : (e?.message || '연결 실패'),
    };
  }
}

// ── ExchangeRate (환율, 키 불필요) ───────────────────────────
async function checkExchangeRate(): Promise<ProviderHealth> {
  const t0 = Date.now();
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(6000) });
    const lat = Date.now() - t0;
    if (!r.ok) { const d = diagnose(r.status); return { id:'exchangeRate', name:'ExchangeRate', nameKr:'환율 API', type:'환율', status:d.status, latencyMs:lat, detail:d.detail }; }
    const data = await r.json();
    const krw = data?.rates?.KRW;
    return { id:'exchangeRate', name:'ExchangeRate', nameKr:'환율 API', type:'환율', status:'ok', latencyMs:lat, detail:'무료 · 키 불필요', sample: krw ? `USD/KRW ${Math.round(krw)}` : undefined };
  } catch (e:any) {
    return { id:'exchangeRate', name:'ExchangeRate', nameKr:'환율 API', type:'환율', status:'error', latencyMs:Date.now()-t0, detail:e.message||'연결 실패' };
  }
}

// ── Binance (코인, 키 불필요 public) ─────────────────────────
async function checkBinance(): Promise<ProviderHealth> {
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(6000) });
    const lat = Date.now() - t0;
    if (!r.ok) {
      // 403 = 서버 IP 지역 차단 (바이낸스가 특정 클라우드/지역 IP 차단)
      if (r.status === 451 || r.status === 403) {
        // 대체: data-api 도메인 시도 (지역 차단 우회용 공개 도메인)
        try {
          const r2 = await fetch('https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(6000) });
          if (r2.ok) {
            const d2 = await r2.json();
            return { id:'binance', name:'Binance', nameKr:'바이낸스', type:'코인', status:'ok', latencyMs:Date.now()-t0, detail:'data-api 도메인 사용', sample: d2?.price ? `BTC $${Math.round(parseFloat(d2.price)).toLocaleString()}` : undefined };
          }
        } catch {}
        return { id:'binance', name:'Binance', nameKr:'바이낸스', type:'코인', status:'limited', latencyMs:lat, detail:'서버 지역 차단 (HTTP 403) — 사용자 브라우저에선 정상일 수 있음. CoinGecko로 자동 전환됨' };
      }
      const d = diagnose(r.status);
      return { id:'binance', name:'Binance', nameKr:'바이낸스', type:'코인', status:d.status, latencyMs:lat, detail:d.detail };
    }
    const data = await r.json();
    return { id:'binance', name:'Binance', nameKr:'바이낸스', type:'코인', status:'ok', latencyMs:lat, detail:'Public API', sample: data?.price ? `BTC $${Math.round(parseFloat(data.price)).toLocaleString()}` : undefined };
  } catch (e:any) {
    return { id:'binance', name:'Binance', nameKr:'바이낸스', type:'코인', status:'error', latencyMs:Date.now()-t0, detail:e.message||'연결 실패' };
  }
}

// ── FMP (미국주식) — 무료 endpoint로 안전하게 체크 ──────────
async function checkFMP(): Promise<ProviderHealth> {
  const key = process.env.FMP_API_KEY || '';
  if (!key) return { id:'fmp', name:'Financial Modeling Prep', nameKr:'FMP', type:'미국주식', status:'unconfigured', latencyMs:null, detail:'FMP_API_KEY 미설정' };
  const t0 = Date.now();
  try {
    // /quote는 유료 전환됨 → 무료 가능한 stable endpoint 사용
    const r = await fetch(`https://financialmodelingprep.com/stable/quote-short?symbol=AAPL&apikey=${key}`, { signal: AbortSignal.timeout(6000) });
    const lat = Date.now() - t0;
    if (!r.ok) {
      const d = diagnose(r.status);
      // 403이면 무료 플랜 제한 가능성 명시
      const detail = r.status === 403 ? 'HTTP 403 — 무료 플랜 제한 또는 키 무효 (유료 endpoint 호출 시 발생)' : d.detail;
      return { id:'fmp', name:'Financial Modeling Prep', nameKr:'FMP', type:'미국주식', status:d.status, latencyMs:lat, detail };
    }
    const data = await r.json();
    const price = Array.isArray(data) ? data[0]?.price : data?.price;
    return { id:'fmp', name:'Financial Modeling Prep', nameKr:'FMP', type:'미국주식', status:'ok', latencyMs:lat, detail:'정상', sample: price ? `AAPL $${price}` : undefined };
  } catch (e:any) {
    return { id:'fmp', name:'Financial Modeling Prep', nameKr:'FMP', type:'미국주식', status:'error', latencyMs:Date.now()-t0, detail:e.message||'연결 실패' };
  }
}

// ── Finnhub (미국주식) ───────────────────────────────────────
async function checkFinnhub(): Promise<ProviderHealth> {
  const key = process.env.FINNHUB_API_KEY || '';
  if (!key) return { id:'finnhub', name:'Finnhub', nameKr:'핀허브', type:'미국주식', status:'unconfigured', latencyMs:null, detail:'FINNHUB_API_KEY 미설정' };
  const t0 = Date.now();
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${key}`, { signal: AbortSignal.timeout(6000) });
    const lat = Date.now() - t0;
    if (!r.ok) { const d = diagnose(r.status); return { id:'finnhub', name:'Finnhub', nameKr:'핀허브', type:'미국주식', status:d.status, latencyMs:lat, detail:d.detail }; }
    const data = await r.json();
    return { id:'finnhub', name:'Finnhub', nameKr:'핀허브', type:'미국주식', status:'ok', latencyMs:lat, detail:'정상', sample: data?.c ? `AAPL $${data.c}` : undefined };
  } catch (e:any) {
    return { id:'finnhub', name:'Finnhub', nameKr:'핀허브', type:'미국주식', status:'error', latencyMs:Date.now()-t0, detail:e.message||'연결 실패' };
  }
}

// ── EODHD (미국주식/코인) ────────────────────────────────────
async function checkEODHD(): Promise<ProviderHealth> {
  const key = process.env.EODHD_API_KEY || '';
  if (!key) return { id:'eodhd', name:'EODHD', nameKr:'EODHD', type:'미국주식', status:'unconfigured', latencyMs:null, detail:'EODHD_API_KEY 미설정' };
  const t0 = Date.now();
  try {
    const r = await fetch(`https://eodhd.com/api/real-time/AAPL.US?api_token=${key}&fmt=json`, { signal: AbortSignal.timeout(6000) });
    const lat = Date.now() - t0;
    if (!r.ok) { const d = diagnose(r.status); return { id:'eodhd', name:'EODHD', nameKr:'EODHD', type:'미국주식', status:d.status, latencyMs:lat, detail:d.detail }; }
    const data = await r.json();
    return { id:'eodhd', name:'EODHD', nameKr:'EODHD', type:'미국주식', status:'ok', latencyMs:lat, detail:'정상', sample: data?.close ? `AAPL $${data.close}` : undefined };
  } catch (e:any) {
    return { id:'eodhd', name:'EODHD', nameKr:'EODHD', type:'미국주식', status:'error', latencyMs:Date.now()-t0, detail:e.message||'연결 실패' };
  }
}

// ── Polygon (미국주식) ───────────────────────────────────────
async function checkPolygon(): Promise<ProviderHealth> {
  const key = process.env.POLYGON_API_KEY || '';
  if (!key) return { id:'polygon', name:'Polygon.io', nameKr:'폴리곤', type:'미국주식', status:'unconfigured', latencyMs:null, detail:'POLYGON_API_KEY 미설정 — 키 발급 시 활성화 가능' };
  const t0 = Date.now();
  try {
    const r = await fetch(`https://api.polygon.io/v2/aggs/ticker/AAPL/prev?apiKey=${key}`, { signal: AbortSignal.timeout(6000) });
    const lat = Date.now() - t0;
    if (!r.ok) { const d = diagnose(r.status); return { id:'polygon', name:'Polygon.io', nameKr:'폴리곤', type:'미국주식', status:d.status, latencyMs:lat, detail:d.detail }; }
    const data = await r.json();
    const price = data?.results?.[0]?.c;
    return { id:'polygon', name:'Polygon.io', nameKr:'폴리곤', type:'미국주식', status:'ok', latencyMs:lat, detail:'정상', sample: price ? `AAPL $${price}` : undefined };
  } catch (e:any) {
    return { id:'polygon', name:'Polygon.io', nameKr:'폴리곤', type:'미국주식', status:'error', latencyMs:Date.now()-t0, detail:e.message||'연결 실패' };
  }
}

export async function GET() {
  const checks = await Promise.all([
    checkExchangeRate(),
    checkBinance(),
    checkFMP(),
    checkFinnhub(),
    checkEODHD(),
    checkPolygon(),
  ]);

  const summary = {
    ok:           checks.filter(c => c.status === 'ok').length,
    limited:      checks.filter(c => c.status === 'limited').length,
    error:        checks.filter(c => c.status === 'error').length,
    unconfigured: checks.filter(c => c.status === 'unconfigured').length,
  };

  return NextResponse.json({ providers: checks, summary, checkedAt: Date.now() }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
