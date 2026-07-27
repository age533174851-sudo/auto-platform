import { NextRequest, NextResponse } from 'next/server';

const HEADERS = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' };

// ── On-chain mock data (replace with Glassnode/CryptoQuant API) ──
function getOnchainMock() {
  const now = Date.now();
  const seed = Math.floor(now / 60000); // changes every minute
  const rng  = (n: number) => { let x = Math.sin(n + seed) * 10000; return x - Math.floor(x); };

  return {
    exchangeFlow: {
      btcInflow:   Math.round(rng(1) * 5000 + 1000),    // BTC/24h
      btcOutflow:  Math.round(rng(2) * 4000 + 800),
      netFlow:     Math.round((rng(1) - rng(2)) * 2000),
      trend:       rng(3) > 0.5 ? 'OUTFLOW' : 'INFLOW',
      riskLevel:   rng(3) > 0.7 ? 'HIGH' : rng(3) > 0.4 ? 'MEDIUM' : 'LOW',
    },
    stablecoin: {
      usdtInflow:  Math.round(rng(4) * 500e6 + 100e6),  // USD
      usdcInflow:  Math.round(rng(5) * 300e6 + 50e6),
      totalInflow: Math.round((rng(4) + rng(5)) * 400e6 + 150e6),
      trend:       rng(6) > 0.5 ? 'BULLISH' : 'BEARISH',
    },
    whales: [
      { address:'0x3f5C...A1b2', action:'매수',  amount: Math.round(rng(7)*500+50)+' BTC',  time:'12분 전', type:'whale' },
      { address:'0x8aE2...9cD4', action:'이동',  amount: Math.round(rng(8)*2000+200)+' ETH', time:'28분 전', type:'shark' },
      { address:'0x1Fb7...3eF0', action:'매도',  amount: Math.round(rng(9)*300+30)+' BTC',  time:'45분 전', type:'whale' },
      { address:'0x9cA3...7bB1', action:'입금',  amount: Math.round(rng(10)*800+100)+' ETH', time:'1시간 전', type:'shark' },
    ],
    etfFlow: {
      btcEtfInflow:  Math.round((rng(11) - 0.3) * 800e6), // USD (can be negative)
      ethEtfInflow:  Math.round((rng(12) - 0.4) * 200e6),
      source:        'BlackRock/Fidelity (추정)',
      date:          new Date().toLocaleDateString('ko-KR'),
    },
    longShort: {
      longRatio:   Math.round(rng(13) * 30 + 50),  // 50-80
      shortRatio:  0,
      fundingRate: (rng(14) - 0.3) * 0.002,
      openInterest: Math.round(rng(15) * 20e9 + 10e9),
    },
    riskScore: Math.round(rng(16) * 60 + 20),  // 20-80
    source:    'mock',
    timestamp: new Date().toISOString(),
    note:      '실시간 데이터는 Glassnode/CryptoQuant API 연결 시 제공됩니다',
  };
}

async function fetchLiveOnchain() {
  // Try to get live funding rate from Binance (public)
  let fundingRate = 0.0001;
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      const fr = parseFloat(d?.lastFundingRate);
      if (Number.isFinite(fr)) fundingRate = fr;
    }
  } catch {}

  // Try to get open interest
  let openInterest = 10e9;
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT', { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      const oi = parseFloat(d?.openInterest);
      if (Number.isFinite(oi) && oi > 0) openInterest = oi * 65000;
    }
  } catch {}

  // 최종 가드
  if (!Number.isFinite(fundingRate)) fundingRate = 0.0001;
  if (!Number.isFinite(openInterest) || openInterest <= 0) openInterest = 10e9;

  const mock = getOnchainMock();
  return {
    ...mock,
    longShort: { ...mock.longShort, fundingRate, openInterest },
    source: fundingRate !== 0.0001 ? 'binance+mock' : 'mock',
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'all';

  try {
    const data = await fetchLiveOnchain();

    if (action === 'whales')    return NextResponse.json({ whales: data.whales }, { headers: HEADERS });
    if (action === 'exchange')  return NextResponse.json({ exchangeFlow: data.exchangeFlow }, { headers: HEADERS });
    if (action === 'stable')    return NextResponse.json({ stablecoin: data.stablecoin }, { headers: HEADERS });
    if (action === 'etf')       return NextResponse.json({ etfFlow: data.etfFlow }, { headers: HEADERS });
    if (action === 'risk')      return NextResponse.json({ riskScore: data.riskScore }, { headers: HEADERS });

    return NextResponse.json(data, { headers: HEADERS });
  } catch {
    return NextResponse.json(getOnchainMock(), { headers: HEADERS });
  }
}
