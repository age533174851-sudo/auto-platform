import { NextRequest, NextResponse } from 'next/server';

// ── AI Assistant ───────────────────────────────────────────────
async function runAIAssistant(question: string, context: any = {}): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return getFallbackResponse(question);
  try {
    const sysPrompt = `당신은 TRAIGO 전문 트레이딩 AI 비서입니다. 한국어로 답변하며:
- 구체적이고 실용적인 조언
- 100자 이내로 간결하게
- ⚠️ 투자 결과에 책임지지 않음
- 위험성 명시
컨텍스트: ${JSON.stringify(context).slice(0,200)}`;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini', max_tokens: 200,
        messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: question }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return getFallbackResponse(question);
    const d = await r.json();
    return d.choices?.[0]?.message?.content || getFallbackResponse(question);
  } catch { return getFallbackResponse(question); }
}

function getFallbackResponse(q: string): string {
  const q_lower = q.toLowerCase();
  if (q_lower.includes('손실') || q_lower.includes('왜'))
    return '손실 원인: 1) 추세 반대 진입 2) 손절 지연 3) 과도한 레버리지 4) 뉴스 영향. 매매일지를 기록하여 패턴을 파악하세요.';
  if (q_lower.includes('전략') || q_lower.includes('추천'))
    return '현재 시장: 추세 추종 전략이 적합합니다. EMA20/50 크로스 + RSI 50 이상 확인 후 진입. 손절은 진입가 -2ATR 설정 권장.';
  if (q_lower.includes('레버리지'))
    return '권장 레버리지: 초보 1-3x, 중급 3-7x, 고급 7-15x. 포지션당 리스크 1-2% 이내 유지. 고레버리지는 청산 위험↑';
  if (q_lower.includes('포트폴리오') || q_lower.includes('리스크'))
    return '포트폴리오 점검: 1) 총 리스크 < 자본 10% 2) 분산 투자 3) 현금 비중 20%+ 유지 4) 상관관계 낮은 자산 조합 권장.';
  return 'TRAIGO AI 비서: 구체적인 질문을 입력하세요. 예: "왜 손실났는지 분석해줘", "지금 시장에 맞는 전략 추천해줘"';
}

// ── Strategy Simulator (Monte Carlo) ─────────────────────────────
function runMonteCarloSimulation(
  winRate: number, avgWin: number, avgLoss: number,
  initialCapital: number, trades: number, simulations: number = 1000
) {
  const seed = (n: number) => { let x = Math.sin(n * 9301 + 49297) * 233280; return x - Math.floor(x); };
  const paths: number[][] = [];
  let ruinCount = 0;
  let finalValues: number[] = [];

  for (let sim = 0; sim < simulations; sim++) {
    let cap = initialCapital;
    const path: number[] = [cap];
    let ruin = false;
    for (let t = 0; t < trades; t++) {
      const r = seed(sim * trades + t);
      if (r < winRate) cap *= (1 + avgWin);
      else             cap *= (1 - avgLoss);
      if (cap < initialCapital * 0.1) { ruin = true; break; }
      path.push(Math.round(cap));
    }
    if (ruin) { ruinCount++; path.push(0); }
    if (sim < 20) paths.push(path); // keep 20 sample paths for chart
    finalValues.push(cap);
  }

  finalValues.sort((a, b) => a - b);
  const p10 = finalValues[Math.floor(simulations * 0.1)];
  const p50 = finalValues[Math.floor(simulations * 0.5)];
  const p90 = finalValues[Math.floor(simulations * 0.9)];
  const avgFinal = finalValues.reduce((a, b) => a + b) / simulations;

  return {
    paths,
    p10, p50, p90,
    expected: Math.round(avgFinal),
    ruinProbability: Math.round(ruinCount / simulations * 100),
    profitProbability: Math.round(finalValues.filter(v => v > initialCapital).length / simulations * 100),
    maxPotential: Math.round(Math.max(...finalValues)),
    simulations, trades,
    initialCapital,
  };
}

// ── Economic Calendar ──────────────────────────────────────────
function getEconCalendar() {
  const now = new Date();
  const events = [
    { id:'e1', date:'2025-06-11', time:'21:30', country:'🇺🇸', event:'CPI 발표', importance:'HIGH', expected:'3.2%', prev:'3.4%', impact:'HIGH_VOLATILITY', assets:['BTC','USD','금'], botPause:true },
    { id:'e2', date:'2025-06-12', time:'03:00', country:'🇺🇸', event:'FOMC 금리 결정', importance:'HIGH', expected:'5.25%', prev:'5.25%', impact:'EXTREME_VOLATILITY', assets:['BTC','주식','달러'], botPause:true },
    { id:'e3', date:'2025-06-13', time:'21:30', country:'🇺🇸', event:'PPI 발표', importance:'MEDIUM', expected:'2.8%', prev:'2.7%', impact:'MEDIUM_VOLATILITY', assets:['원자재','USD'], botPause:false },
    { id:'e4', date:'2025-06-07', time:'21:30', country:'🇺🇸', event:'NFP 고용지표', importance:'HIGH', expected:'185K', prev:'175K', impact:'HIGH_VOLATILITY', assets:['달러','주식'], botPause:true },
    { id:'e5', date:'2025-06-20', time:'00:00', country:'🌐', event:'BTC 옵션 만기', importance:'MEDIUM', expected:'$2.4B', prev:'$1.8B', impact:'MEDIUM_VOLATILITY', assets:['BTC'], botPause:false },
    { id:'e6', date:'2025-06-27', time:'23:00', country:'🇺🇸', event:'GDP 발표', importance:'HIGH', expected:'2.1%', prev:'1.6%', impact:'HIGH_VOLATILITY', assets:['주식','달러'], botPause:true },
    { id:'e7', date:'2025-06-14', time:'06:00', country:'🇰🇷', event:'한국 금리 결정', importance:'MEDIUM', expected:'3.50%', prev:'3.50%', impact:'LOW_VOLATILITY', assets:['원화','KOSPI'], botPause:false },
    { id:'e8', date:'2025-06-19', time:'21:30', country:'🇺🇸', event:'주간 실업수당', importance:'LOW', expected:'220K', prev:'215K', impact:'LOW_VOLATILITY', assets:['달러'], botPause:false },
  ];

  // Add countdown
  return events.map(e => {
    const eventTime = new Date(`${e.date}T${e.time}`);
    const diffMs    = eventTime.getTime() - now.getTime();
    const diffH     = Math.round(diffMs / 3600000);
    return {
      ...e,
      countdown: diffH > 0 ? (diffH > 48 ? `${Math.round(diffH/24)}일 후` : `${diffH}시간 후`) : '진행 중/완료',
      isPast: diffMs < 0,
    };
  }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// ── Tax Report ─────────────────────────────────────────────────
function generateTaxReport(year: number) {
  // Mock trade history with realistic data
  const months = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
  const monthlyData = months.map((m, i) => {
    const seed = Math.sin(i * 7 + year) * 10000;
    const rng  = () => { const x = seed * (i+1); return (x - Math.floor(x)); };
    const pnl    = Math.round((rng() - 0.35) * 3000000);
    const fees   = Math.round(rng() * 150000 + 20000);
    const trades = Math.round(rng() * 80 + 10);
    return { month: m, pnl, fees, funding: Math.round(rng() * 50000), trades, taxable: Math.max(0, pnl) };
  });

  const totalPnL    = monthlyData.reduce((a, m) => a + m.pnl, 0);
  const totalFees   = monthlyData.reduce((a, m) => a + m.fees, 0);
  const totalFund   = monthlyData.reduce((a, m) => a + m.funding, 0);
  const totalTrades = monthlyData.reduce((a, m) => a + m.trades, 0);
  const taxable     = Math.max(0, totalPnL);
  // Korea: crypto gains taxed at 20% above 2.5M KRW threshold (2025)
  const THRESHOLD   = 2500000;
  const estimatedTax = taxable > THRESHOLD ? Math.round((taxable - THRESHOLD) * 0.22) : 0;

  return {
    year, monthlyData, totalPnL, totalFees, totalFund, totalTrades,
    taxable, estimatedTax, threshold: THRESHOLD,
    note: '⚠️ 세금 계산은 참고용입니다. 실제 신고는 세무사에게 문의하세요.',
    source: 'mock',
  };
}

// ── Community Posts ────────────────────────────────────────────
const COMMUNITY_POSTS = [
  { id:'p1', author:'CryptoKing_KR', avatar:'👑', content:'BTC EMA50 지지 확인. 다음 목표 $72K. 손절 $64K 설정 중.', pnlVerified:'+4.2%', likes:47, comments:12, time:'2시간 전', type:'analysis', bookmarked:false },
  { id:'p2', author:'QuantQueen',    avatar:'🤖', content:'펀딩비 0.05% 초과. 롱 과열 주의. 숏 스퀴즈 가능성 있음.', pnlVerified:'+1.8%', likes:89, comments:23, time:'4시간 전', type:'warning', bookmarked:false },
  { id:'p3', author:'SafeHands',     avatar:'🛡️', content:'DCA 전략: 현재가 -5%, -10%, -15% 분할 매수 설정 완료.', pnlVerified:'+0.9%', likes:32, comments:7,  time:'6시간 전', type:'strategy', bookmarked:false },
  { id:'p4', author:'AltSeason99',   avatar:'🚀', content:'SOL 선물 3배 진입. 구름 돌파 + 거래량 폭증 확인.', pnlVerified:'+12.4%',likes:61, comments:18, time:'어제',    type:'trade', bookmarked:false },
];

// ─── MAIN ROUTER ──────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'assistant';

  if (action === 'calendar') {
    return NextResponse.json({ events: getEconCalendar() }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600' },
    });
  }

  if (action === 'tax') {
    const year = parseInt(searchParams.get('year') || String(new Date().getFullYear()));
    return NextResponse.json(generateTaxReport(year), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  if (action === 'community') {
    return NextResponse.json({ posts: COMMUNITY_POSTS }, {
      headers: { 'Cache-Control': 'public, s-maxage=30' },
    });
  }

  if (action === 'simulator') {
    const winRate = parseFloat(searchParams.get('wr') || '0.55');
    const avgWin  = parseFloat(searchParams.get('aw') || '0.03');
    const avgLoss = parseFloat(searchParams.get('al') || '0.02');
    const capital = parseFloat(searchParams.get('cap') || '10000000');
    const trades  = parseInt(searchParams.get('n') || '100');
    const result  = runMonteCarloSimulation(winRate, avgWin, avgLoss, capital, trades);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { action } = body;

  if (action === 'assistant') {
    const answer = await runAIAssistant(body.question || '', body.context || {});
    return NextResponse.json({ answer, source: process.env.OPENAI_API_KEY ? 'openai' : 'fallback' });
  }

  if (action === 'like-post') {
    return NextResponse.json({ ok: true, likes: (body.currentLikes || 0) + 1 });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
