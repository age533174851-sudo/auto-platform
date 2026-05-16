import { NextRequest, NextResponse } from 'next/server';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// ─── Safe OpenAI call — never exposes key to client ──────────────
async function callOpenAI(
  systemPrompt: string,
  userPrompt:   string,
  maxTokens  = 600
): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

// ─── Fallback responses (Korean, education-focused) ──────────────
const FALLBACKS: Record<string, string> = {
  chat: '죄송합니다. AI 서비스에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해주세요.\n\n⚠️ TRAIGO AI는 교육 목적으로만 제공됩니다. 실제 투자 결정은 공인 투자 전문가와 상담하세요.',
  summary: '📊 시장 분석을 불러올 수 없습니다. 네트워크 상태를 확인해주세요.\n\n⚠️ AI 분석은 참고용이며 수익을 보장하지 않습니다.',
  leverage: '⚠️ 레버리지는 매우 위험합니다.\n\n• 초보자: 1-2x 이하 권장\n• 손절 반드시 설정\n• 투자 원금의 5% 이하로 포지션 진입\n\n현재 AI 서비스를 이용할 수 없습니다. 잠시 후 다시 시도하세요.',
  portfolio: '포트폴리오 분석을 불러올 수 없습니다.\n\n일반 원칙:\n• 단일 자산 30% 이하 유지\n• 섹터 분산\n• 현금 10-20% 보유',
  strategy: '전략 설명을 불러올 수 없습니다.\n\nEMA Cross: 단기 EMA가 장기 EMA를 돌파할 때 진입\nRSI: 30 이하 매수, 70 이상 매도\nMACD: 신호선 교차 시 진입\n\n⚠️ 과거 성과가 미래를 보장하지 않습니다.',
  news: '뉴스 요약을 불러올 수 없습니다.\n\n최신 시장 뉴스는 주요 금융 매체를 직접 확인하세요.',
  sentiment: '시장 심리 분석을 불러올 수 없습니다.\n\n⚠️ 시장 심리는 투자 결정의 일부 참고 자료일 뿐입니다.',
  journal: '매매일지 AI 리뷰를 불러올 수 없습니다.\n\n스스로 점검: 계획 준수 여부, 손절 실행 여부, 감정적 판단 배제 여부를 확인하세요.',
};

// ─── SYSTEM PROMPTS ─────────────────────────────────────────────
const SYSTEM = {
  market: `당신은 TRAIGO 앱의 한국어 AI 투자 코파일럿입니다.
규칙:
- 반드시 한국어로 답변
- 200자 이내, 불릿 포인트 사용
- 수익 보장 절대 금지
- 항상 "⚠️ 교육 목적" 면책 문구 포함
- 마지막 줄: 🔍 불리시/베어리시 전망 한 줄 요약`,

  leverage: `당신은 TRAIGO의 레버리지 리스크 전문 AI입니다.
규칙:
- 한국어로 간결하게
- 청산 가격, 리스크 수준 명시
- conservative(1-3x)/balanced(3-7x)/aggressive(7x+) 분류
- 반드시 손절 설정 권고
- ⚠️ 고위험 경고 포함`,

  portfolio: `당신은 TRAIGO의 포트폴리오 분석 AI입니다.
규칙:
- 한국어, 150자 이내
- 집중 리스크, 과도 노출 감지
- 분산 투자 제안
- 구체적 숫자 포함 (예: BTC 비중 45% → 30% 이하 권장)
- ⚠️ 투자 조언 아님 명시`,

  strategy: `당신은 TRAIGO의 트레이딩 전략 교육 AI입니다.
규칙:
- 한국어, 초보자 친화적
- EMA/RSI/MACD/BB 등 기술적 지표 쉽게 설명
- 실전 예시 포함
- ⚠️ 수익 보장 안됨 명시
- 200자 이내`,

  news: `당신은 TRAIGO의 시장 뉴스 요약 AI입니다.
규�글:
- 한국어, 150자 이내
- CPI/FOMC/NFP 등 매크로 이벤트 영향 설명
- 불리시/베어리시 영향 구분
- 기술적 용어 간단히 해석
- ⚠️ 투자 판단은 본인 책임`,

  sentiment: `당신은 TRAIGO의 시장 심리 분석 AI입니다.
규칙:
- 한국어, 100자 이내
- 0-100 공포/탐욕 점수 제시
- 불리시 확률 % 명시
- 주요 근거 2-3가지
- ⚠️ 참고용 분석`,

  chat: `당신은 TRAIGO 앱의 한국어 AI 투자 코파일럿입니다.
규칙:
- 반드시 한국어로 답변
- 친근하고 명확하게
- 투자 조언 아닌 교육 정보 제공
- 수익 보장 절대 금지
- 250자 이내
- 이모지 적절히 사용
- 마지막에 ⚠️ 면책 문구`,

  journal: `당신은 TRAIGO의 매매일지 AI 리뷰어입니다.
규칙:
- 한국어, 150자 이내
- 긍정적/개선점 균형있게
- 손절 준수 여부 언급
- 감정 편향 분석
- ⚠️ 교육 목적 명시`,
};

// ─── GET handler ─────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'chat';

  // ── Sentiment score ──
  if (action === 'sentiment') {
    const btcChange   = parseFloat(searchParams.get('btcChange') || '0');
    const ethChange   = parseFloat(searchParams.get('ethChange') || '0');
    const vix         = parseFloat(searchParams.get('vix') || '18');
    const userPrompt  = `현재 시장 데이터:\n- BTC 24h 변동: ${btcChange >= 0 ? '+' : ''}${btcChange.toFixed(2)}%\n- ETH 24h 변동: ${ethChange >= 0 ? '+' : ''}${ethChange.toFixed(2)}%\n- VIX 공포지수: ${vix}\n\n현재 시장 심리를 분석해주세요. 공포/탐욕 점수(0-100)와 불리시 확률(%)을 포함하세요.`;
    const result = await callOpenAI(SYSTEM.sentiment, userPrompt, 200);
    return NextResponse.json({
      result: result || FALLBACKS.sentiment,
      source: result ? 'openai' : 'fallback',
      cached: false,
    }, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } });
  }

  // ── Market summary ──
  if (action === 'summary') {
    const assets = searchParams.get('assets') || 'BTC,ETH,NVDA,SPY';
    const userPrompt = `현재 주요 자산 현황:\n${assets}\n\n위 자산들의 시장 상황을 간략히 분석해주세요. 전반적인 시장 분위기(불리시/베어리시)와 주목할 포인트를 알려주세요.`;
    const result = await callOpenAI(SYSTEM.market, userPrompt, 400);
    return NextResponse.json({
      result: result || FALLBACKS.summary,
      source: result ? 'openai' : 'fallback',
    }, { headers: { 'Cache-Control': 'public, s-maxage=180, stale-while-revalidate=360' } });
  }

  // ── Strategy explanation ──
  if (action === 'strategy') {
    const strat = searchParams.get('strategy') || 'EMA Cross';
    const userPrompt = `트레이딩 전략 "${strat}"을 초보자도 이해하기 쉽게 한국어로 설명해주세요. 진입/청산 조건, 장단점을 포함하세요.`;
    const result = await callOpenAI(SYSTEM.strategy, userPrompt, 400);
    return NextResponse.json({
      result: result || FALLBACKS.strategy,
      source: result ? 'openai' : 'fallback',
    }, { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' } });
  }

  return NextResponse.json({ error: 'Unknown action', actions: ['sentiment','summary','strategy'] }, { status: 400 });
}

// ─── POST handler (chat, leverage, portfolio, news, journal) ─────
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { action = 'chat', message = '', context = {} } = body;

  // ── Chat ──
  if (action === 'chat') {
    if (!message.trim()) return NextResponse.json({ error: 'message required' }, { status: 400 });
    const result = await callOpenAI(SYSTEM.chat, message, 400);
    return NextResponse.json({ result: result || FALLBACKS.chat, source: result ? 'openai' : 'fallback' });
  }

  // ── Leverage recommendation ──
  if (action === 'leverage') {
    const { asset = 'BTC', leverage = 3, riskLevel = 'medium', entryPrice = 0, portfolioSize = 0 } = context;
    const userPrompt = `사용자 레버리지 분석 요청:
- 자산: ${asset}
- 요청 레버리지: ${leverage}x
- 리스크 성향: ${riskLevel}
- 진입 가격: ₩${entryPrice.toLocaleString()}
- 포트폴리오 규모: ₩${portfolioSize.toLocaleString()}

레버리지 적정성을 평가하고 청산 리스크를 설명해주세요.`;
    const result = await callOpenAI(SYSTEM.leverage, userPrompt, 400);
    return NextResponse.json({ result: result || FALLBACKS.leverage, source: result ? 'openai' : 'fallback' });
  }

  // ── Portfolio review ──
  if (action === 'portfolio') {
    const { holdings = [] } = context;
    const holdingsStr = holdings.slice(0, 10).map((h: any) =>
      `- ${h.name||h.sym}: ₩${(h.value||0).toLocaleString()} (${(h.pct||0).toFixed(1)}%)`
    ).join('\n');
    const userPrompt = `포트폴리오 구성:\n${holdingsStr || '데이터 없음'}\n\n집중 리스크와 분산 투자 개선점을 분석해주세요.`;
    const result = await callOpenAI(SYSTEM.portfolio, userPrompt, 400);
    return NextResponse.json({ result: result || FALLBACKS.portfolio, source: result ? 'openai' : 'fallback' });
  }

  // ── News summary ──
  if (action === 'news') {
    const { headlines = [] } = context;
    const headlineStr = headlines.slice(0, 5).map((h: string, i: number) => `${i+1}. ${h}`).join('\n');
    const userPrompt = `다음 시장 뉴스 헤드라인을 요약해주세요:\n${headlineStr || '헤드라인 없음'}\n\n시장에 미치는 영향과 투자자 관점에서 주목해야 할 포인트를 알려주세요.`;
    const result = await callOpenAI(SYSTEM.news, userPrompt, 400);
    return NextResponse.json({ result: result || FALLBACKS.news, source: result ? 'openai' : 'fallback' });
  }

  // ── Journal review ──
  if (action === 'journal') {
    const { trade = {} } = context;
    const userPrompt = `매매일지 분석:
- 종목: ${trade.sym||'—'}
- 방향: ${trade.side||'—'}
- 진입가: ₩${(trade.entryPrice||0).toLocaleString()}
- 청산가: ₩${(trade.exitPrice||0).toLocaleString()}
- 손익: ${trade.pnl >= 0 ? '+' : ''}₩${(Math.abs(trade.pnl||0)).toLocaleString()} (${trade.pnlPct||0}%)
- 감정: ${trade.emotion||'—'}
- 메모: ${trade.memo||'없음'}

이 거래를 리뷰하고 개선점을 제안해주세요.`;
    const result = await callOpenAI(SYSTEM.journal, userPrompt, 350);
    return NextResponse.json({ result: result || FALLBACKS.journal, source: result ? 'openai' : 'fallback' });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
