import { NextRequest, NextResponse } from 'next/server';

const KRW = 1375;

const LEADERBOARD = [
  { id:'t1', handle:'CryptoKing_KR', name:'비트코인 왕', roi30d:42.8, roi7d:12.1, roi1d:2.4, winRate:67, risk:'medium', followers:1847, maxDD:8.2, strategy:'EMA + 볼린저밴드 추세 추종', public:true, verified:true, minCopy:100000 },
  { id:'t2', handle:'QuantQueen',    name:'퀀트 여왕',  roi30d:31.2, roi7d:8.4,  roi1d:1.1, winRate:71, risk:'low',    followers:2203, maxDD:5.1, strategy:'RSI 과매도 반등 + 펀딩비 차익', public:true, verified:true, minCopy:200000 },
  { id:'t3', handle:'AltSeason99',   name:'알트시즌',   roi30d:89.4, roi7d:22.3, roi1d:8.7, winRate:54, risk:'high',   followers:931,  maxDD:24.5, strategy:'알트코인 모멘텀 스캘핑', public:true, verified:false, minCopy:50000 },
  { id:'t4', handle:'SafeHands_Pro', name:'안전제일',   roi30d:18.7, roi7d:4.2,  roi1d:0.8, winRate:78, risk:'low',    followers:3104, maxDD:3.8, strategy:'현물 DCA + 지지선 매매', public:true, verified:true, minCopy:500000 },
  { id:'t5', handle:'FuturesGod_KR', name:'선물의 신',  roi30d:67.3, roi7d:15.8, roi1d:5.2, winRate:58, risk:'high',   followers:654,  maxDD:31.2, strategy:'선물 레버리지 돌파 전략', public:true, verified:false, minCopy:100000 },
  { id:'t6', handle:'IchimokuMaster',name:'일목의 달인', roi30d:26.4, roi7d:6.9,  roi1d:1.5, winRate:64, risk:'medium', followers:1422, maxDD:7.4, strategy:'일목구름 + EMA 배열', public:true, verified:true, minCopy:200000 },
];

async function buildStrategyWithAI(description: string) {
  const key = process.env.OPENAI_API_KEY || '';
  const fallback = {
    strategy: {
      name: `AI 전략 (${new Date().toLocaleDateString('ko-KR')})`,
      timeframe: /15분/.test(description) ? '15m' : '1h',
      symbol: /btc|비트/i.test(description) ? 'BTCUSDT' : 'BTCUSDT',
      direction: 'long',
      indicators: [
        ...(/rsi|과매도/i.test(description) ? [{ name:'RSI', period:14 }] : []),
        ...(/ema|이평/i.test(description) ? [{ name:'EMA', period:20 }, { name:'EMA', period:50 }] : []),
        { name:'Volume', period:20 },
      ],
      entryConditions: ['RSI(14) < 35', 'EMA20 > EMA50', '거래량 1.5x 이상'],
      exitConditions: ['RSI(14) > 65', '목표가 도달'],
      stopLoss: '진입가 - 2ATR',
      takeProfit: ['1:2 손익비', '1:4 손익비'],
      webhook: { alert: '{{ticker}} 매수신호', token: '{{strategy.order.action}}' },
      risk: 'medium',
      description: description.slice(0, 100),
    },
    source: 'fallback',
  };
  if (!key) return fallback;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini', max_tokens: 600,
        messages: [
          { role: 'system', content: '트레이딩 전략을 JSON으로 변환. {"name":"","timeframe":"15m","symbol":"BTCUSDT","direction":"long","indicators":[],"entryConditions":[],"exitConditions":[],"stopLoss":"","takeProfit":[],"webhook":{"alert":"","token":""},"risk":"medium","description":""}' },
          { role: 'user', content: description },
        ],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return fallback;
    const d   = await r.json();
    const raw = (d.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    return { strategy: JSON.parse(raw), source: 'openai' };
  } catch { return fallback; }
}

async function generateBriefing() {
  let btcPrice = 94230000, btcChg = 2.14, fundingRate = 0.0001;
  try {
    const [t, f] = await Promise.allSettled([
      fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', { signal: AbortSignal.timeout(3000) }).then(r => r.json()),
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', { signal: AbortSignal.timeout(3000) }).then(r => r.json()),
    ]);
    if (t.status === 'fulfilled' && t.value && t.value.lastPrice) {
      const p = parseFloat(t.value.lastPrice);
      const c = parseFloat(t.value.priceChangePercent);
      if (Number.isFinite(p) && p > 0) btcPrice = p * KRW;
      if (Number.isFinite(c))           btcChg   = c;
    }
    if (f.status === 'fulfilled' && f.value && f.value.lastFundingRate) {
      const fr = parseFloat(f.value.lastFundingRate);
      if (Number.isFinite(fr)) fundingRate = fr;
    }
  } catch {}
  // 최종 가드 — 어떻게든 NaN이 끼면 mock 기본값으로
  if (!Number.isFinite(btcPrice) || btcPrice <= 0) btcPrice = 94230000;
  if (!Number.isFinite(btcChg))                     btcChg   = 0;
  if (!Number.isFinite(fundingRate))                fundingRate = 0.0001;
  const sentiment = btcChg > 3 ? 'STRONG_BULLISH' : btcChg > 1 ? 'BULLISH' : btcChg < -3 ? 'STRONG_BEARISH' : btcChg < -1 ? 'BEARISH' : 'NEUTRAL';
  const fundBias  = fundingRate > 0.0005 ? '롱 과열' : fundingRate < -0.0001 ? '숏 과열' : '중립';
  const key = process.env.OPENAI_API_KEY || '';
  let aiSummary: string | null = null;
  if (key) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
        body: JSON.stringify({ model:'gpt-4o-mini', max_tokens:150,
          messages:[{role:'system',content:'한국어 100자 이내 암호화폐 시장 브리핑. ⚠️투자조언아님'},
          {role:'user',content:`BTC: ₩${Math.round(btcPrice/10000)}만 (${btcChg.toFixed(2)}%), 펀딩:${fundBias}, 시장:${sentiment}`}],
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) { const d = await r.json(); aiSummary = d.choices?.[0]?.message?.content || null; }
    } catch {}
  }
  return { btcPrice, btcChg, fundingRate, sentiment, fundBias,
    aiSummary: aiSummary || `BTC ₩${Math.round(btcPrice/10000)}만 (${btcChg >= 0 ? '+' : ''}${btcChg.toFixed(2)}%) · 펀딩 ${fundBias} · ${sentiment}`,
    source: aiSummary ? 'openai' : 'fallback', timestamp: new Date().toISOString() };
}

async function analyzeNewsImpact(headline: string) {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) return { impact:'NEUTRAL', direction:'중립', volatility:'MEDIUM', score:0, reason:'API 키 없음', source:'fallback' };
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
      body: JSON.stringify({ model:'gpt-4o-mini', max_tokens:150,
        messages:[
          {role:'system',content:'뉴스 암호화폐 영향 JSON분석. {"impact":"BULLISH|BEARISH|NEUTRAL","direction":"","volatility":"HIGH|MEDIUM|LOW","score":-100~100,"reason":""}'},
          {role:'user',content:headline}
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { impact:'NEUTRAL', direction:'중립', volatility:'MEDIUM', score:0, reason:'분석 실패', source:'fallback' };
    const d   = await r.json();
    const raw = (d.choices?.[0]?.message?.content||'').replace(/```json|```/g,'').trim();
    return { ...JSON.parse(raw), source:'openai' };
  } catch { return { impact:'NEUTRAL', direction:'중립', volatility:'MEDIUM', score:0, reason:'오류', source:'fallback' }; }
}

async function getLiquidationData(symbol = 'BTCUSDT') {
  let price = 68000;
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) { const d = await r.json(); price = parseFloat(d.price); }
  } catch {}
  const levels = [];
  for (let i = -10; i <= 10; i++) {
    if (i === 0) continue;
    const pct  = i * 2;
    const px   = price * (1 + pct / 100);
    const size = Math.abs(i) <= 3 ? 'MAJOR' : Math.abs(i) <= 6 ? 'MEDIUM' : 'MINOR';
    const side = i < 0 ? 'LONG_LIQ' : 'SHORT_LIQ';
    const seed = Math.abs(Math.sin(price + i) * 1e8);
    levels.push({ pct, price: px, priceKRW: Math.round(px * KRW), size, side, volume: Math.round(seed * (4 - Math.abs(i) * 0.3)) });
  }
  return { symbol, currentPrice: price, currentPriceKRW: Math.round(price * KRW),
    longRatio: 58, shortRatio: 42, squeeze: 'BALANCED',
    levels: levels.sort((a, b) => a.pct - b.pct),
    source: 'calculated', timestamp: new Date().toISOString() };
}

function calcRebalance(holdings: any[], riskProfile: string) {
  const profiles: Record<string, any> = {
    conservative: { spot:70, futures:10, cash:20, maxLev:2 },
    balanced:     { spot:50, futures:30, cash:20, maxLev:5 },
    aggressive:   { spot:30, futures:60, cash:10, maxLev:10 },
  };
  const target = profiles[riskProfile] || profiles.balanced;
  const total  = holdings.reduce((a: number, h: any) => a + (h.value || 0), 0) || 10000000;
  return {
    target, riskProfile, totalValue: total,
    allocations: [
      { type:'현물',  target:target.spot,    current:45, action:target.spot > 45 ? '매수 필요' : '매도 필요', amount: Math.abs(target.spot-45)/100*total },
      { type:'선물',  target:target.futures, current:40, action:target.futures > 40 ? '증가 필요' : '축소 필요', amount: Math.abs(target.futures-40)/100*total },
      { type:'현금',  target:target.cash,    current:15, action:target.cash > 15 ? '보유 증가' : '보유 축소', amount: Math.abs(target.cash-15)/100*total },
    ],
    maxLeverage: target.maxLev, timestamp: new Date().toISOString(),
  };
}

function detectAnomalies(trades: any[], dailyLoss: number, leverage: number) {
  const alerts: any[] = [];
  if (dailyLoss > 500000) alerts.push({ type:'DAILY_LOSS', severity:'critical', msg:`일일 손실 ₩${dailyLoss.toLocaleString()}`, action:'거래 중단 권장' });
  if (leverage > 15)       alerts.push({ type:'HIGH_LEVERAGE', severity:'warning', msg:`레버리지 ${leverage}x 과도`, action:'레버리지 축소' });
  const recent = (trades || []).slice(-5);
  const losses = recent.filter((t: any) => (t.pnl || 0) < 0).length;
  if (losses >= 4) alerts.push({ type:'REVENGE_TRADE', severity:'warning', msg:`연속 ${losses}회 손실`, action:'쿨다운 권장' });
  return alerts;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');

  if (action === 'leaderboard') {
    const sort = searchParams.get('sort') || 'roi30d';
    const sorted = [...LEADERBOARD].sort((a: any, b: any) => b[sort] - a[sort]);
    return NextResponse.json({ traders: sorted }, { headers: { 'Cache-Control': 'public, s-maxage=60' } });
  }
  if (action === 'briefing') {
    const data = await generateBriefing();
    return NextResponse.json(data, { headers: { 'Cache-Control': 'public, s-maxage=300' } });
  }
  if (action === 'liquidation') {
    const data = await getLiquidationData(searchParams.get('symbol') || 'BTCUSDT');
    return NextResponse.json(data, { headers: { 'Cache-Control': 'public, s-maxage=30' } });
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { action } = body;

  if (action === 'build-strategy') return NextResponse.json(await buildStrategyWithAI(body.description || ''));
  if (action === 'news-impact')    return NextResponse.json(await analyzeNewsImpact(body.headline || ''));
  if (action === 'rebalance')      return NextResponse.json(calcRebalance(body.holdings || [], body.riskProfile || 'balanced'));
  if (action === 'anomaly-check')  return NextResponse.json({ alerts: detectAnomalies(body.trades||[], body.dailyLoss||0, body.leverage||1) });
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
