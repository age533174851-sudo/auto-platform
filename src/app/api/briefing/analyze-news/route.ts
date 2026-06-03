// /api/briefing/analyze-news
// 뉴스 텍스트 → BTC/ETH/달러/주식에 미칠 영향 분석
//
// OpenAI gpt-4o-mini (JSON 모드) + 키워드 기반 fallback
// 출력 형식 고정 — 클라이언트가 안전하게 렌더링

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Direction = 'up' | 'down' | 'neutral';

interface ImpactItem {
  asset:     string;       // 'BTC', 'ETH', '달러', '주식'
  direction: Direction;
  strength:  number;       // 0~100
  reason:    string;       // 1-2 문장
}

interface AnalysisResult {
  summary:   string;
  impacts:   ImpactItem[];
  sentiment: 'bullish' | 'bearish' | 'neutral';
  confidence: number;        // 0~1
  source:    'openai' | 'fallback';
  warnings?: string[];
}

const MAX_INPUT = 2000;

// ─── Fallback (키워드 기반) ─────────────────────────────────
function fallbackAnalyze(text: string): AnalysisResult {
  const t = text.toLowerCase();

  // 키워드 가중치
  const upPatterns = [
    /etf.*승인|etf.*approved/i,
    /금리.*인하|rate.*cut|dovish|비둘기/i,
    /연준.*완화|fed.*pivot/i,
    /최고가|all.time.high|ath/i,
    /상승|급등|폭등|rally|surge/i,
    /매수|매집|whale.*buy/i,
    /채택|adoption|institutional/i,
  ];
  const downPatterns = [
    /금리.*인상|rate.*hike|hawkish|매파/i,
    /해킹|hack|exploit/i,
    /규제|crackdown|ban/i,
    /sec.*제재|sec.*action/i,
    /폭락|급락|crash|plunge/i,
    /청산|liquidation/i,
    /파산|bankruptcy/i,
    /부정적|negative/i,
  ];

  const upHits   = upPatterns.filter(p => p.test(text)).length;
  const downHits = downPatterns.filter(p => p.test(text)).length;

  // 자산별 멘션
  const btcMention   = /(비트코인|bitcoin|btc)/i.test(text);
  const ethMention   = /(이더리움|ethereum|eth)/i.test(text);
  const usdMention   = /(달러|dollar|usd|dxy|연준|fed|금리)/i.test(text);
  const stockMention = /(주식|nasdaq|s&p|stock|증시|naver|samsung|tesla)/i.test(text);

  // 방향 결정
  const dir: Direction = upHits > downHits + 0.5 ? 'up'
                       : downHits > upHits + 0.5 ? 'down'
                       : 'neutral';

  const baseStrength = Math.min(80, (Math.max(upHits, downHits) + 1) * 25);
  const sentiment    = dir === 'up' ? 'bullish' : dir === 'down' ? 'bearish' : 'neutral';

  const impacts: ImpactItem[] = [];

  if (btcMention || (!btcMention && !ethMention && !usdMention && !stockMention)) {
    impacts.push({
      asset:     'BTC',
      direction: dir,
      strength:  baseStrength,
      reason:    upHits > 0 ? `${upHits}개의 긍정 키워드 (ETF/완화/상승 등) 감지` :
                 downHits > 0 ? `${downHits}개의 부정 키워드 (인상/규제/하락 등) 감지` :
                 '명확한 방향 신호 없음 — 추가 정보 필요',
    });
  }

  if (ethMention || btcMention) {
    impacts.push({
      asset:     'ETH',
      direction: dir,
      strength:  Math.max(20, baseStrength - 10),
      reason:    dir === 'up' ? 'BTC 강세 시 ETH도 동반 상승 경향'
               : dir === 'down' ? 'BTC 약세 시 ETH 추가 하락 위험'
               : 'BTC 방향에 따라 결정',
    });
  }

  if (usdMention) {
    // 달러는 반대 방향 (보통 위험자산과 역상관)
    const usdDir: Direction = dir === 'up' ? 'down' : dir === 'down' ? 'up' : 'neutral';
    impacts.push({
      asset:     '달러',
      direction: usdDir,
      strength:  baseStrength * 0.7,
      reason:    '위험자산 강세 시 달러 약세, 위험회피 시 달러 강세',
    });
  }

  if (stockMention) {
    impacts.push({
      asset:     '주식',
      direction: dir,
      strength:  baseStrength * 0.6,
      reason:    '거시 환경이 주식 시장에 동조하는 흐름',
    });
  }

  const summary = upHits > downHits ? '긍정적 뉴스로 위험자산에 호재로 작용할 가능성'
                : downHits > upHits ? '부정적 뉴스로 위험자산에 악재로 작용할 가능성'
                : '명확한 방향성을 알기 어려운 중립적 뉴스';

  return {
    summary,
    impacts,
    sentiment,
    confidence: upHits + downHits >= 2 ? 0.55 : 0.35,
    source: 'fallback',
    warnings: ['키워드 기반 분석 — OpenAI 키 설정 시 더 정확'],
  };
}

// ─── OpenAI 분석 ─────────────────────────────────────────────
async function openaiAnalyze(text: string, key: string): Promise<AnalysisResult> {
  const sys = `당신은 거시 경제·암호화폐·주식 시장 분석가입니다.
주어진 뉴스가 BTC / ETH / 달러 / 주식에 미칠 단기 영향을 JSON으로 분석합니다.

스키마:
{
  "summary": "한 문장 요약",
  "sentiment": "bullish | bearish | neutral",
  "impacts": [
    {
      "asset":     "BTC | ETH | 달러 | 주식",
      "direction": "up | down | neutral",
      "strength":  0-100,
      "reason":    "1-2 문장 이유"
    }
  ]
}

규칙:
- 뉴스에 직접 언급되지 않은 자산은 impacts에 넣지 마세요
- strength는 영향 크기 (확신도가 아닌 가격 변동 크기)
- 출력은 오직 JSON. 설명 텍스트 금지.`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 600,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: text },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`openai_${r.status}`);
  const d = await r.json();
  const raw = d?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(raw);

  return {
    summary:    String(parsed.summary || ''),
    sentiment:  ['bullish','bearish','neutral'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
    impacts:    Array.isArray(parsed.impacts) ? parsed.impacts.slice(0, 6) : [],
    confidence: 0.85,
    source:     'openai',
  };
}

// ─── POST handler ────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: { text?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const text = (body.text || '').trim().slice(0, MAX_INPUT);
  if (!text) {
    return NextResponse.json({ error: 'empty_text' }, { status: 400 });
  }

  const key = process.env.OPENAI_API_KEY || '';
  if (key) {
    try {
      const result = await openaiAnalyze(text, key);
      return NextResponse.json(result);
    } catch (e) {
      const result = fallbackAnalyze(text);
      return NextResponse.json({
        ...result,
        warnings: [
          ...(result.warnings || []),
          `OpenAI 실패 — fallback 사용 (${e instanceof Error ? e.message : 'unknown'})`,
        ],
      });
    }
  }

  return NextResponse.json(fallbackAnalyze(text));
}
