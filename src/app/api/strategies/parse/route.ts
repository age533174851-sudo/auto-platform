// /api/strategies/parse
// 입력: { prompt: string }
// 출력: { strategy: Partial<UserStrategy>, warnings: string[], confidence: number, source: 'openai'|'fallback' }
//
// OpenAI gpt-4o-mini로 자연어 → 전략 JSON 변환.
// 키 없거나 실패 시 정규식 기반 결정적 fallback.
// 안전: 반환된 전략은 항상 enabled: false (사용자가 확인 후 활성화).

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PROMPT = 800;

// ─── 결정적 fallback 파서 ─────────────────────────────────────
// 자주 등장하는 패턴을 정규식으로 잡아 부분적인 전략 JSON 생성.
function fallbackParse(prompt: string) {
  const p = prompt.toLowerCase();
  const warnings: string[] = [];

  // 자산 감지
  const ASSETS = ['btc','eth','sol','xrp','doge','ada','bnb','avax','dot','link','aapl','tsla','nvda','msft','googl','amzn','meta','spy','qqq','nasdaq','005930','삼성전자','애플','테슬라','엔비디아','비트코인','이더리움','솔라나','리플','도지','에이다','업비트','바이낸스'];
  const KR_NAMES: Record<string,string> = {
    '비트코인':'BTC','이더리움':'ETH','솔라나':'SOL','리플':'XRP','도지':'DOGE','에이다':'ADA',
    '삼성전자':'005930','애플':'AAPL','테슬라':'TSLA','엔비디아':'NVDA',
    '나스닥':'QQQ',
  };
  let asset = '';
  let market: 'crypto'|'stock'|'etf'|'futures'|'forex' = 'crypto';
  for (const k of Object.keys(KR_NAMES)) {
    if (prompt.includes(k)) { asset = KR_NAMES[k]; break; }
  }
  if (!asset) {
    for (const a of ASSETS) {
      if (p.includes(a.toLowerCase())) { asset = a.toUpperCase(); break; }
    }
  }
  if (!asset) { asset = 'BTC'; warnings.push('자산을 찾지 못해 BTC로 설정했습니다'); }
  if (/^\d{6}$/.test(asset) || ['AAPL','TSLA','NVDA','MSFT','GOOGL','AMZN','META','005930'].includes(asset)) market = 'stock';
  if (['SPY','QQQ'].includes(asset)) market = 'etf';

  // 타임프레임 감지
  let timeframe: '1m'|'5m'|'15m'|'30m'|'1h'|'4h'|'1d' = '1h';
  if (/1\s*분|1m\b/.test(p)) timeframe = '1m';
  else if (/5\s*분|5m\b/.test(p))   timeframe = '5m';
  else if (/15\s*분|15m\b/.test(p)) timeframe = '15m';
  else if (/30\s*분|30m\b/.test(p)) timeframe = '30m';
  else if (/1\s*시간|1h\b/.test(p)) timeframe = '1h';
  else if (/4\s*시간|4h\b/.test(p)) timeframe = '4h';
  else if (/일봉|1d\b|하루/.test(p)) timeframe = '1d';

  // 액션
  const action: 'buy'|'sell' = /매도|sell|숏|short|하락/.test(p) ? 'sell' : 'buy';

  // 조건 추출
  const conditions: Array<{ indicator: string; operator?: string; value?: number; signal?: string }> = [];

  // RSI 조건
  const rsiMatch = p.match(/rsi\s*(?:가\s*)?(\d+)\s*(이하|이상|미만|초과|<=?|>=?)/);
  if (rsiMatch) {
    const v = parseInt(rsiMatch[1], 10);
    const opRaw = rsiMatch[2];
    const op = (opRaw === '이하' || opRaw === '<=') ? '<=' :
               (opRaw === '이상' || opRaw === '>=') ? '>=' :
               (opRaw === '미만' || opRaw === '<')  ? '<'  : '>';
    conditions.push({ indicator: 'RSI', operator: op, value: v });
  } else if (/rsi/.test(p)) {
    // RSI 언급은 있는데 값 추출 못함
    conditions.push({ indicator: 'RSI', operator: '<=', value: 30 });
    warnings.push('RSI 값을 정확히 인식하지 못해 30으로 기본 설정');
  }

  // MACD 골든크로스 / 데드크로스
  if (/macd.*골든\s*크로스|골든\s*크로스.*macd/.test(p)) {
    conditions.push({ indicator: 'MACD', signal: 'golden_cross' });
  } else if (/macd.*데드\s*크로스|데드\s*크로스.*macd/.test(p)) {
    conditions.push({ indicator: 'MACD', signal: 'dead_cross' });
  } else if (/골든\s*크로스/.test(p)) {
    conditions.push({ indicator: 'MA_Cross', signal: 'golden_cross' });
  } else if (/데드\s*크로스/.test(p)) {
    conditions.push({ indicator: 'MA_Cross', signal: 'dead_cross' });
  }

  // EMA 돌파
  if (/ema.*돌파|돌파.*ema/.test(p)) {
    conditions.push({ indicator: 'EMA', operator: 'cross_above' });
  }

  // 거래량 급증
  if (/거래량.*급증|거래량.*증가/.test(p)) {
    conditions.push({ indicator: 'Volume', operator: 'volume_surge' });
  }

  if (conditions.length === 0) {
    conditions.push({ indicator: 'RSI', operator: '<=', value: 30 });
    warnings.push('조건을 명확히 추출하지 못해 RSI<=30 기본값 사용');
  }

  // 주문 금액
  let amount = 100000;
  const amtMatch = p.match(/(\d+)\s*(만원|만\s*원|만)/);
  const krwMatch = p.match(/(\d[\d,]*)\s*원/);
  if (amtMatch) {
    amount = parseInt(amtMatch[1], 10) * 10000;
  } else if (krwMatch) {
    amount = parseInt(krwMatch[1].replace(/,/g, ''), 10);
  }
  if (!Number.isFinite(amount) || amount <= 0) amount = 100000;

  // 익절 / 손절
  let takeProfitPct = 5, stopLossPct = 2;
  const tpMatch = p.match(/(?:익절|target|tp)[^0-9]*(\d+(?:\.\d+)?)\s*%?/);
  const slMatch = p.match(/(?:손절|stop\s*loss|sl)[^0-9]*(\d+(?:\.\d+)?)\s*%?/);
  if (tpMatch) takeProfitPct = parseFloat(tpMatch[1]);
  if (slMatch) stopLossPct   = parseFloat(slMatch[1]);

  const confidence = warnings.length === 0 ? 0.75 : warnings.length === 1 ? 0.55 : 0.40;

  return {
    strategy: {
      name:      `AI 전략 — ${asset} ${timeframe}`,
      asset,
      market,
      timeframe,
      mode:      'paper' as const,    // 기본 모의투자
      action,
      conditions,
      order: {
        type:     'market' as const,
        amount,
        currency: 'KRW' as const,
      },
      risk: {
        takeProfitPct,
        stopLossPct,
        maxDailyLossPct: 10,
      },
      enabled:   false,                // 안전: 사용자 확인 후 활성화
      source:    'ai' as const,
      prompt,
    },
    warnings,
    confidence,
    source: 'fallback' as const,
  };
}

// ─── OpenAI 파서 ──────────────────────────────────────────────
async function openaiParse(prompt: string, key: string) {
  const sys = `당신은 트레이딩 전략 변환기입니다. 한국어/영어 자연어를 다음 JSON 스키마로 변환합니다:
{
  "name": "전략 이름",
  "asset": "BTC|ETH|TSLA|005930 등",
  "market": "crypto|stock|etf|forex|futures",
  "timeframe": "1m|5m|15m|30m|1h|4h|1d",
  "action": "buy|sell",
  "conditions": [
    { "indicator": "RSI|MACD|EMA|SMA|BB|Volume|MA_Cross|...", "operator": "<=|>=|cross_above|...", "value": 30, "signal": "golden_cross" }
  ],
  "order": { "type": "market|limit", "amount": 100000, "currency": "KRW|USD" },
  "risk": { "takeProfitPct": 5, "stopLossPct": 2, "maxDailyLossPct": 10 }
}
규칙:
- enabled, mode, source, prompt 필드는 출력하지 마세요. 서버가 채웁니다.
- 값을 모르면 합리적 기본값. 자산은 한국어→티커 변환(예: 비트코인→BTC, 삼성전자→005930).
- 금액 단위: 만원→×10000.
- 출력은 오직 JSON. 설명 텍스트 금지.`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`openai_status_${r.status}`);
  const d = await r.json();
  const raw = d?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(raw);

  // 서버 측에서 안전 필드 강제
  return {
    strategy: {
      ...parsed,
      enabled: false,
      mode:    'paper' as const,
      source:  'ai' as const,
      prompt,
    },
    warnings: [],
    confidence: 0.85,
    source: 'openai' as const,
  };
}

// ─── POST handler ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: { prompt?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const prompt = (body?.prompt || '').trim().slice(0, MAX_PROMPT);
  if (!prompt) {
    return NextResponse.json({ error: 'empty_prompt' }, { status: 400 });
  }

  const key = process.env.OPENAI_API_KEY || '';
  if (key) {
    try {
      const result = await openaiParse(prompt, key);
      return NextResponse.json(result);
    } catch (e) {
      // OpenAI 실패 시 fallback으로
      const result = fallbackParse(prompt);
      return NextResponse.json({
        ...result,
        warnings: [...result.warnings, `OpenAI 호출 실패 — fallback 사용 (${e instanceof Error ? e.message : 'unknown'})`],
      });
    }
  }

  // 키 없으면 fallback
  return NextResponse.json(fallbackParse(prompt));
}
