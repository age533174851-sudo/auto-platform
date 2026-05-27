// /api/daily-briefing — 20-year analyst daily report (OpenAI-powered + mock fallback)
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Vercel: allow longer GPT response

interface ReportSection {
  title:    string;
  lines10:  string[];
  summary3: string[];
  outlook:  '상승' | '하락' | '보합';
  reason:   string;
}

interface StockPick {
  symbol: string;
  name:   string;
  outlook:'상승' | '하락' | '보합';
  reason: string;
  risk:   string;
}

interface DailyReport {
  updatedAt:         string;
  source:            'live' | 'mock' | 'partial';
  financialJuice:    ReportSection;
  seekingAlpha:      ReportSection;
  realEstateFinance: ReportSection & { realEstateOutlook: '상승'|'하락'|'보합' };
  stockPicks: {
    today:    StockPick[];
    growth:   StockPick[];
    summary3: string[];
  };
  crypto: ReportSection & { btc: '상승'|'하락'|'보합'; eth: '상승'|'하락'|'보합'; sol: '상승'|'하락'|'보합' };
  note?: string;
}

const MOCK_REPORT: DailyReport = {
  updatedAt: new Date().toISOString(),
  source: 'mock',
  financialJuice: {
    title: 'FinancialJuice 핵심 요약',
    lines10: [
      '미국 10년물 국채금리 4.35%로 안정세',
      '달러 인덱스(DXY) 104.2 — 약달러 흐름',
      'WTI 원유 배럴당 78달러 — 중동 긴장 완화',
      '금 온스당 2,340달러 — 안전자산 수요 둔화',
      '나스닥 선물 +0.4% — AI 섹터 강세 지속',
      'VIX 13.8 — 시장 안정 신호',
      'BTC 9만 4천 달러 — ETF 자금 유입',
      'EUR/USD 1.083 — ECB 인하 기대',
      '일본 닛케이 +1.2% — 엔화 약세 수혜',
      '중국 CSI300 -0.3% — 부동산 우려',
    ],
    summary3: [
      '연준 인하 기대로 위험자산 강세 지속',
      '달러 약세 — 신흥국·금속·코인 수혜',
      '단기 변동성 낮음 — 추세 추종 전략 유효',
    ],
    outlook: '상승',
    reason: '연준의 비둘기파 기조 강화와 달러 약세가 위험자산 전반에 우호적인 환경을 조성하고 있습니다.',
  },
  seekingAlpha: {
    title: 'Seeking Alpha 핵심 요약',
    lines10: [
      '엔비디아 분기 실적 컨센서스 상회 (EPS $4.93)',
      '데이터센터 매출 154% YoY 증가',
      '블랙웰 GPU 출하 본격화 — Q3 가속',
      'AMD MI300X 수주 잔고 35억 달러',
      '메타 캐피탈 EX $40B 상향 — AI 인프라',
      '애플 비전 프로 판매 부진 — 가격 인하 검토',
      '마이크로소프트 Copilot 매출 본격화',
      '구글 제미니 2.0 출시 — 추론 성능 강화',
      '테슬라 FSD V13 한국 출시 임박',
      '코인베이스 트레이딩 매출 +63% QoQ',
    ],
    summary3: [
      'AI 인프라 투자 확대 — 반도체 수혜 지속',
      '빅테크 클라우드·생성형 AI 매출 견조',
      '소비자 디바이스는 약세 — 기업용 강세',
    ],
    outlook: '상승',
    reason: 'AI 자본 지출이 빅테크 실적을 견인하고 있으며, 반도체 공급망 전반의 호황이 확인되었습니다.',
  },
  realEstateFinance: {
    title: '부동산 및 금융 뉴스',
    lines10: [
      '미국 30년 모기지 6.85% — 5월 들어 0.3%p 하락',
      '주택 착공 건수 5월 +5.7% — 신축 수요 회복',
      '한국 서울 아파트 평균 매매가 12억원 돌파',
      'KB부동산 매수우위지수 88.4 — 매수세 약화',
      '미 상업용 부동산 연체율 4.4% — CRE 우려 지속',
      'JP모건 Q1 트레이딩 매출 +21% — IB 회복',
      '골드만삭스 자산관리 부문 사상 최대',
      '한국 가계대출 5월 +5.4조 — 주담대 견인',
      '미국 은행 예금 +1.2% — 자금 흐름 정상화',
      '유로존 신용도 안정세 — 그리스 BB+ 상향',
    ],
    summary3: [
      '미국 모기지 금리 하락 — 주택 거래 회복 신호',
      '한국 부동산 지역별 양극화 심화',
      '대형 금융주 자산관리·IB 회복 — 분기 호실적',
    ],
    outlook: '보합',
    realEstateOutlook: '보합',
    reason: '금리 하락 기대로 주택 거래는 회복 흐름이나, 상업용 부동산 부실 우려로 전반 보합 전망.',
  },
  stockPicks: {
    today: [
      { symbol:'NVDA', name:'엔비디아',         outlook:'상승', reason:'블랙웰 GPU 출하 본격화', risk:'고밸류에이션 (PER 70배)' },
      { symbol:'PLTR', name:'팔란티어',         outlook:'상승', reason:'미 국방부 5년 계약 갱신', risk:'PER 200배 — 모멘텀 둔화 시 급락' },
      { symbol:'AMD',  name:'AMD',              outlook:'상승', reason:'MI300X 수주 잔고 35억 달러', risk:'엔비디아 대비 SW 생태계 열위' },
      { symbol:'COIN', name:'코인베이스',       outlook:'상승', reason:'BTC ETF 수탁 점유율 80%', risk:'SEC 규제 리스크' },
      { symbol:'SOXL', name:'반도체 3배 ETF',   outlook:'상승', reason:'필라델피아 반도체 지수 강세', risk:'레버리지 ETF 변동성' },
    ],
    growth: [
      { symbol:'SMCI', name:'슈퍼마이크로',     outlook:'상승', reason:'AI 서버 점유율 확대', risk:'회계 감사 이슈' },
      { symbol:'MSTR', name:'마이크로스트래티지',outlook:'상승', reason:'BTC 프록시 자산', risk:'BTC 가격 직결' },
      { symbol:'CRWD', name:'크라우드스트라이크',outlook:'상승', reason:'클라우드 보안 1위', risk:'SentinelOne 추격' },
      { symbol:'SNOW', name:'스노우플레이크',   outlook:'보합', reason:'데이터 클라우드 수요 견조', risk:'AI 매출 더딘 편' },
      { symbol:'HOOD', name:'로빈후드',         outlook:'상승', reason:'옵션·코인 거래 폭증', risk:'리테일 의존도 높음' },
    ],
    summary3: [
      'AI 인프라/반도체 섹터 — 강세 지속',
      '코인 관련주(COIN/MSTR/HOOD) — BTC 강세 동조',
      '레버리지/고PER 종목 — 변동성 관리 필수',
    ],
  },
  crypto: {
    title: '코인 상태 및 뉴스',
    lines10: [
      'BTC 9만 4천 달러 — 신고가 근접',
      'ETH ETF 8월 거래 개시 유력',
      'SOL 195달러 — Firedancer 업그레이드',
      '글로벌 코인 시총 3.5조 달러 — 사상 최대',
      'USDT 시총 1,160억 달러 — 5월 +4%',
      'BTC 도미넌스 56.8% — 알트 강세 신호',
      '비트코인 ETF 자금 유입 23억 달러/주',
      'SEC, ETH 현물 ETF S-1 검토 가속',
      '한국 5대 거래소 거래량 +18% — 김프 1.2%',
      '온체인 활성 주소 +9% — 사용자 증가',
    ],
    summary3: [
      'BTC ETF 자금 유입 지속 — 기관 매수세',
      'ETH ETF 임박 — 알트시즌 신호',
      'SOL 생태계 활성화',
    ],
    outlook: '상승',
    btc: '상승', eth: '상승', sol: '상승',
    reason: 'BTC ETF로의 기관 자금 유입이 일주일에 23억 달러를 넘어서며 강세를 견인하고 있고, ETH ETF 승인 임박으로 알트시즌 기대감이 형성되고 있습니다.',
  },
};

/* ── Fetch live context: prices + recent news (best-effort) ── */
async function gatherContext(origin: string): Promise<string> {
  const parts: string[] = [];

  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr',
      { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const data = await r.json();
      const arr = Array.isArray(data) ? data : [];
      const top = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT']
        .map(s => arr.find((x: any) => x.symbol === s))
        .filter(Boolean);
      if (top.length > 0) {
        const lines = top.map((t: any) =>
          `${t.symbol}: $${Number(t.lastPrice).toFixed(2)} (${Number(t.priceChangePercent).toFixed(2)}%)`
        ).join(', ');
        parts.push(`코인 24h: ${lines}`);
      }
    }
  } catch {}

  try {
    const newsUrl = new URL('/api/market/news', origin);
    newsUrl.searchParams.set('limit', '8');
    const r = await fetch(newsUrl.toString(), { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      const items = Array.isArray(d?.data) ? d.data : [];
      const heads = items.slice(0, 6).map((n: any) => `- ${n.title}`).join('\n');
      if (heads) parts.push(`최근 뉴스 헤드라인:\n${heads}`);
    }
  } catch {}

  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD',
      { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      if (d?.rates?.KRW) parts.push(`USD/KRW: ${Math.round(d.rates.KRW)}`);
    }
  } catch {}

  return parts.length > 0 ? parts.join('\n\n') : '(시장 데이터 일시 미가용)';
}

/* ── OpenAI structured-JSON call ── */
async function callOpenAI(apiKey: string, context: string): Promise<DailyReport | null> {
  const systemPrompt = `당신은 20년 경력의 글로벌 금융 애널리스트입니다.
한국 투자자를 위해 매일 아침 시장 분석 리포트를 한국어로 작성합니다.
반드시 JSON 형식으로만 응답하세요. 다음 스키마를 정확히 지키세요:

{
  "financialJuice":    { "title":"FinancialJuice 핵심 요약", "lines10":[10개 한 줄 요약], "summary3":[3줄 핵심], "outlook":"상승|하락|보합", "reason":"한 문단 이유" },
  "seekingAlpha":      { "title":"Seeking Alpha 핵심 요약", "lines10":[10], "summary3":[3], "outlook":"상승|하락|보합", "reason":"…" },
  "realEstateFinance": { "title":"부동산 및 금융 뉴스", "lines10":[10], "summary3":[3], "outlook":"상승|하락|보합", "realEstateOutlook":"상승|하락|보합", "reason":"…" },
  "stockPicks": {
    "today":  [5개 종목 { "symbol":"NVDA", "name":"엔비디아", "outlook":"상승|하락|보합", "reason":"…", "risk":"…" }],
    "growth": [5개 성장주 동일 구조],
    "summary3": [3줄 핵심]
  },
  "crypto": { "title":"코인 상태 및 뉴스", "lines10":[10], "summary3":[3], "outlook":"상승|하락|보합", "btc":"상승|하락|보합", "eth":"…", "sol":"…", "reason":"…" }
}

주의:
- lines10은 반드시 10개 요소, summary3은 3개 요소
- outlook 값은 정확히 "상승" "하락" "보합" 중 하나
- 종목 추천 시 실제 미국 상장사명 사용 (NVDA, AAPL, MSFT 등)
- 어려운 경제 용어는 괄호로 쉽게 풀어주세요
- 원문 그대로 인용하지 말고 요약·재구성하세요`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        temperature: 0.5,
        max_tokens: 3500,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: `오늘 시장 데이터:\n\n${context}\n\n위 정보를 참고해 한국 투자자용 데일리 리포트를 작성하세요.` },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[daily-briefing] OpenAI HTTP', res.status, errText.slice(0, 300));
      return null;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    // Validate shape
    if (!parsed.financialJuice || !parsed.crypto || !parsed.stockPicks) {
      console.error('[daily-briefing] Invalid GPT JSON shape');
      return null;
    }
    return {
      updatedAt: new Date().toISOString(),
      source: 'live',
      financialJuice:    parsed.financialJuice,
      seekingAlpha:      parsed.seekingAlpha    || MOCK_REPORT.seekingAlpha,
      realEstateFinance: parsed.realEstateFinance || MOCK_REPORT.realEstateFinance,
      stockPicks:        parsed.stockPicks,
      crypto:            parsed.crypto,
    };
  } catch (e: any) {
    console.error('[daily-briefing] OpenAI error', e?.message);
    return null;
  }
}

export async function GET(req: NextRequest) {
  const key = process.env.OPENAI_API_KEY || '';

  // No key → return mock
  if (!key) {
    return NextResponse.json({
      ...MOCK_REPORT,
      source: 'mock',
      note: 'OPENAI_API_KEY 미설정 — mock 리포트 표시',
    });
  }

  // Gather live context + call GPT
  try {
    const context = await gatherContext(req.nextUrl.origin);
    const report  = await callOpenAI(key, context);
    if (report) {
      return NextResponse.json(report);
    }
    // GPT failed → mock fallback
    return NextResponse.json({
      ...MOCK_REPORT,
      source: 'partial',
      note: 'GPT 호출 실패 — mock 리포트 표시',
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[daily-briefing] fatal', e);
    return NextResponse.json({ ...MOCK_REPORT, source: 'mock' });
  }
}
