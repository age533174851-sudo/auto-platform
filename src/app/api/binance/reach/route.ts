// /api/binance/reach
// Vercel 서버에서 바이낸스 각 도메인에 닿는지 진단
// 451/403 지역차단인지, 어떤 도메인이 살아있는지 확인

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TARGETS = [
  { id: 'spot',           url: 'https://api.binance.com/api/v3/ping',                    desc: '현물 실계좌' },
  { id: 'spot-data',      url: 'https://data-api.binance.vision/api/v3/ping',            desc: '현물 data-api (지역우회)' },
  { id: 'futures',        url: 'https://fapi.binance.com/fapi/v1/ping',                  desc: '선물 실계좌' },
  { id: 'futures-test',   url: 'https://testnet.binancefuture.com/fapi/v1/ping',         desc: '선물 테스트넷' },
  { id: 'coingecko',      url: 'https://api.coingecko.com/api/v3/ping',                  desc: 'CoinGecko (백업)' },
];

export async function GET() {
  const results = await Promise.all(TARGETS.map(async t => {
    const t0 = Date.now();
    try {
      const r = await fetch(t.url, { signal: AbortSignal.timeout(7000) });
      const ms = Date.now() - t0;
      let status: 'ok' | 'geo_blocked' | 'error';
      let detail: string;
      if (r.ok) { status = 'ok'; detail = '정상 연결'; }
      else if (r.status === 451 || r.status === 403) { status = 'geo_blocked'; detail = `지역 차단 (HTTP ${r.status})`; }
      else { status = 'error'; detail = `HTTP ${r.status}`; }
      return { ...t, status, detail, ms };
    } catch (e: any) {
      return { ...t, status: 'error' as const, detail: e?.message?.includes('timeout') ? '시간초과' : '연결 실패', ms: Date.now() - t0 };
    }
  }));

  const spotOk = results.find(r => r.id === 'spot')?.status === 'ok';
  const testnetOk = results.find(r => r.id === 'futures-test')?.status === 'ok';
  const anyBinanceOk = results.some(r => r.id !== 'coingecko' && r.status === 'ok');

  let verdict: string;
  if (testnetOk) verdict = '✅ 테스트넷 연결 가능 — 실제 주문 테스트 OK';
  else if (anyBinanceOk) verdict = '⚠️ 일부 바이낸스 도메인만 연결 — 테스트넷 확인 필요';
  else verdict = '❌ 서버에서 바이낸스 전체 차단 (지역 451) — 프록시/VPS 또는 다른 거래소 필요';

  return NextResponse.json({ results, spotOk, testnetOk, anyBinanceOk, verdict, at: Date.now() }, { headers: { 'Cache-Control': 'no-store' } });
}
