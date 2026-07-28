// ─────────────────────────────────────────────────────────────
// TRAIGO — News Analyze API
// POST /api/news/analyze
// body: { items: [{ id, title, summary?, tickers?, category?, url?, publishedAt? }] }
// 응답: { results: { [id]: NewsAnalysis }, source }
//
// 동작:
// - OPENAI_API_KEY 있으면 OpenAI 호출 → 실패하면 mock fallback
// - 키 없으면 mock으로 즉시 응답
// - 최대 5개까지 배치 분석 (비용 보호)
//
// 무엇이 통과할 수 있는지는 이 파일이 정하지 않는다. lib/news/schema가
// 정하고, 그건 테스트가 있다. 여기는 인증·호출·위임만 한다.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { mockAnalyze } from '@/lib/news/mockAnalyzer';
import {
  ANALYSIS_JSON_INSTRUCTION, extractJson, validateAnalysis, toLegacyAnalysis,
  parseSourceUrl, parsePublishedAt,
} from '@/lib/news/schema';
import type { AnalyzeRequest, AnalyzeResponse, NewsAnalysis } from '@/lib/news/types';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_BATCH = 5; // 한 번에 분석할 뉴스 개수 제한
const MODEL = 'gpt-4o-mini';

type Item = AnalyzeRequest['items'][number];

// OpenAI 한 건 호출
async function analyzeOne(item: Item, apiKey: string): Promise<NewsAnalysis | null> {
  const systemPrompt = [
    '너는 금융 뉴스 분석가다. 영어 기사를 한국어로 옮기고 시장 영향을 분석한다.',
    '',
    ANALYSIS_JSON_INSTRUCTION,
    '',
    '- titleKo는 자연스러운 한국 기사 제목처럼 쓴다. 직역 금지. 40자 이내.',
    '- summary는 2~3줄. affectedAssets는 티커로 (BTC, NVDA, QQQ, GOLD 등).',
    '- 매크로 뉴스면 광범위 지수(QQQ, VOO) 또는 GOLD.',
  ].join('\n');

  const userPrompt = [
    `Title: ${item.title}`,
    item.summary ? `Summary: ${item.summary}` : '',
    item.tickers && item.tickers.length > 0 ? `Tickers: ${item.tickers.join(', ')}` : '',
    item.category ? `Category: ${item.category}` : '',
  ].filter(Boolean).join('\n');

  let parsed: any;
  try {
    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
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
    parsed = extractJson(d.choices?.[0]?.message?.content);
    if (!parsed) return null;
  } catch (e) {
    console.warn('[news/analyze] openai call failed', e);
    return null;
  }

  const v = validateAnalysis(parsed, {
    sourceUrl:   item.url,
    publishedAt: item.publishedAt,
    provider:    'openai',
    model:       MODEL,
  });

  // 고친 것도 떨어뜨린 것도 남긴다. 조용히 지나가면 모델이 나빠져도 알 수 없다.
  if (v.repaired.length) console.info(`[news/analyze] ${item.id} 보정: ${v.repaired.join(' / ')}`);
  if (!v.ok) {
    console.warn(`[news/analyze] ${item.id} 반려: ${v.errors.join(' / ')}`);
    return null;
  }
  return toLegacyAnalysis(v.value!);
}

/**
 * 출처를 확인할 수 없는 기사는 AI에 보내지 않는다.
 *
 * 보내봐야 검증에서 떨어진다 — 원문 없는 분석은 저장하지 않기로 했으니까.
 * 미리 걸러야 버릴 응답에 돈을 쓰지 않는다.
 */
function isVerifiable(item: Item): boolean {
  return parseSourceUrl(item.url) !== null && parsePublishedAt(item.publishedAt) !== null;
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

  // 출처를 확인할 수 없는 건 AI에 보내지 않는다 — 어차피 검증에서 떨어진다
  const askable = useOpenAI ? items.filter(isVerifiable) : [];
  const unverifiable = useOpenAI ? items.length - askable.length : 0;

  if (askable.length > 0) {
    // 병렬 호출 (timeout 각 20초)
    const settled = await Promise.allSettled(askable.map(it => analyzeOne(it, apiKey)));
    for (let i = 0; i < askable.length; i++) {
      const s = settled[i];
      if (s.status === 'fulfilled' && s.value) {
        results[askable[i].id] = s.value;
        anyOpenAI = true;
      }
    }
  }

  // AI가 못 채운 자리는 mock으로. mock은 source:'mock'으로 표시되어 나가므로
  // 화면에서 AI 분석과 섞이지 않는다.
  for (const it of items) {
    if (results[it.id]) continue;
    results[it.id] = mockAnalyze(it);
    anyMock = true;
  }

  const source: AnalyzeResponse['source'] = anyOpenAI && anyMock ? 'mixed' : anyOpenAI ? 'openai' : 'mock';
  return NextResponse.json({ results, source, unverifiable } as AnalyzeResponse, {
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
