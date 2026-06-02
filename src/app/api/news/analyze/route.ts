// ─────────────────────────────────────────────────────────────
// TRAIGO — News Analyze API
// POST /api/news/analyze
// body: { items: [{ id, title, summary?, tickers?, category? }] }
// 응답: { results: { [id]: NewsAnalysis }, source }
//
// 동작:
// - OPENAI_API_KEY 있으면 OpenAI 호출 → 실패하면 mock fallback
// - 키 없으면 mock으로 즉시 응답
// - 최대 5개까지 배치 분석 (비용 보호)
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { mockAnalyze } from '@/lib/news/mockAnalyzer';
import type { AnalyzeRequest, AnalyzeResponse, NewsAnalysis, NewsPrediction } from '@/lib/news/types';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_BATCH = 5; // 한 번에 분석할 뉴스 개수 제한

// JSON 추출 (LLM 응답에 markdown fence가 있을 수 있음)
function extractJSON(text: string): unknown | null {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  // 첫 { ... 마지막 } 추출 시도
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// OpenAI 한 건 호출
async function analyzeOne(
  item: { id: string; title: string; summary?: string; tickers?: string[]; category?: string },
  apiKey: string,
): Promise<NewsAnalysis | null> {
  const systemPrompt = [
    'You are a financial news analyzer. Output ONLY valid JSON, no markdown.',
    'For a given news headline (often in English), produce Korean translation + sentiment analysis.',
    '',
    'Output schema (all keys required):',
    '{',
    '  "titleKo": "자연스러운 한국어 제목 (40자 이내)",',
    '  "summaryKo": "1~2줄 자연 한국어 요약 (80자 이내)",',
    '  "prediction": "up" | "down" | "flat",',
    '  "confidence": 0~100 정수,',
    '  "reasons": ["근거1", "근거2", "근거3"],   // 2~4개, 각 25자 이내, 한국어',
    '  "affectedAssets": [{"symbol":"BTC","direction":"up"}]  // 0~5개',
    '}',
    '',
    'Rules:',
    '- titleKo는 자연스러운 한국 기사 제목처럼. 직역 금지.',
    '- prediction은 "해당 자산이 단기적으로 어떻게 움직일지" 예측.',
    '- confidence는 분석 자신감 (애매하면 50~65, 명확하면 70~90).',
    '- affectedAssets symbol은 티커 (BTC, NVDA, QQQ, VOO, GOLD 등). 매크로 뉴스면 광범위 지수(QQQ, VOO) 또는 GOLD.',
    '- 부족한 정보로 추측하지 말 것. 명확하지 않으면 "flat".',
  ].join('\n');

  const userPrompt = [
    `Title: ${item.title}`,
    item.summary ? `Summary: ${item.summary}` : '',
    item.tickers && item.tickers.length > 0 ? `Tickers: ${item.tickers.join(', ')}` : '',
    item.category ? `Category: ${item.category}` : '',
  ].filter(Boolean).join('\n');

  try {
    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const content = d.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = extractJSON(content) as Record<string, unknown> | null;
    if (!parsed) return null;

    const titleKo    = typeof parsed.titleKo === 'string' ? parsed.titleKo : item.title;
    const summaryKo  = typeof parsed.summaryKo === 'string' ? parsed.summaryKo : '';
    const predRaw    = String(parsed.prediction || 'flat').toLowerCase();
    const prediction: NewsPrediction = (predRaw === 'up' || predRaw === 'down' || predRaw === 'flat') ? predRaw : 'flat';
    let confidence   = Math.round(Number(parsed.confidence) || 60);
    confidence = Math.max(40, Math.min(95, confidence));
    const reasons    = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 4)
      : [];
    const affectedRaw = Array.isArray(parsed.affectedAssets) ? parsed.affectedAssets : [];
    const affectedAssets: NewsAnalysis['affectedAssets'] = affectedRaw
      .filter((x: unknown): x is { symbol: string; direction?: string } =>
        typeof x === 'object' && x !== null && typeof (x as { symbol?: unknown }).symbol === 'string')
      .slice(0, 5)
      .map(x => {
        const dirRaw = String(x.direction || 'flat').toLowerCase();
        const dir: NewsPrediction = (dirRaw === 'up' || dirRaw === 'down' || dirRaw === 'flat') ? dirRaw : 'flat';
        return { symbol: x.symbol.toUpperCase(), direction: dir };
      });

    return {
      titleKo,
      summaryKo: summaryKo || titleKo,
      prediction,
      confidence,
      reasons,
      affectedAssets,
      source: 'openai',
      analyzedAt: Date.now(),
    };
  } catch (e) {
    console.warn('[news/analyze] openai call failed', e);
    return null;
  }
}

export async function POST(req: NextRequest) {
  let body: AnalyzeRequest;
  try {
    body = (await req.json()) as AnalyzeRequest;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'no_items' }, { status: 400 });
  }

  // 안전 차단: 너무 많이 보내면 잘라
  const items = body.items.slice(0, MAX_BATCH).filter(it => it && typeof it.id === 'string' && typeof it.title === 'string');

  const apiKey = process.env.OPENAI_API_KEY || '';
  const useOpenAI = apiKey.length > 0;

  const results: Record<string, NewsAnalysis> = {};
  let anyOpenAI = false;
  let anyMock   = false;

  if (useOpenAI) {
    // 병렬 호출 (timeout 각 20초)
    const settled = await Promise.allSettled(items.map(it => analyzeOne(it, apiKey)));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const s  = settled[i];
      if (s.status === 'fulfilled' && s.value) {
        results[it.id] = s.value;
        anyOpenAI = true;
      } else {
        // 한 건 실패 → mock으로 채움
        results[it.id] = mockAnalyze(it);
        anyMock = true;
      }
    }
  } else {
    // 키 없음 → 전부 mock
    for (const it of items) results[it.id] = mockAnalyze(it);
    anyMock = true;
  }

  const source: AnalyzeResponse['source'] = anyOpenAI && anyMock ? 'mixed' : anyOpenAI ? 'openai' : 'mock';
  return NextResponse.json({ results, source } as AnalyzeResponse, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

// GET은 헬스체크 용도
export async function GET() {
  const hasKey = (process.env.OPENAI_API_KEY || '').length > 0;
  return NextResponse.json({
    ok: true,
    openai: hasKey ? 'enabled' : 'disabled (mock only)',
    maxBatch: MAX_BATCH,
  });
}
