// /api/translate — 뉴스/AI 텍스트 번역
// 1순위 Papago(NAVER_CLIENT_ID/SECRET) → 2순위 OpenAI(OPENAI_API_KEY) → 원문 폴백
// POST { text, target?='ko', source?='auto' }
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const cache = new Map<string, string>();

const LANG_NAME: Record<string, string> = { ko: 'Korean', en: 'English', ja: 'Japanese', zh: 'Chinese (Simplified)' };

async function translateWithOpenAI(text: string, target: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) return null;
  const targetName = LANG_NAME[target] || 'Korean';
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: `You are a professional financial news translator. Translate the user's text into ${targetName}. Output ONLY the translation, preserving meaning and tone. Keep ticker symbols (BTC, ETH, NVDA), company names, and numbers unchanged.` },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { console.log(`[OpenAI 번역] HTTP ${r.status}`); return null; }
    const d = await r.json();
    const out = d?.choices?.[0]?.message?.content?.trim();
    return out || null;
  } catch (e: any) {
    console.log('[OpenAI 번역] 오류:', e?.message);
    return null;
  }
}

async function translateWithPapago(text: string, target: string): Promise<{ translated: string; source: string } | null> {
  const id = process.env.NAVER_CLIENT_ID || '';
  const secret = process.env.NAVER_CLIENT_SECRET || '';
  if (!id || !secret) return null;
  try {
    let source = 'en';
    try {
      const dr = await fetch('https://naveropenapi.apigw.ntruss.com/langs/v1/dect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': secret },
        body: new URLSearchParams({ query: text.slice(0, 200) }),
        signal: AbortSignal.timeout(5000),
      });
      if (dr.ok) { const dd = await dr.json(); if (dd.langCode) source = dd.langCode; }
    } catch {}
    if (source === target) return { translated: text, source };
    const r = await fetch('https://naveropenapi.apigw.ntruss.com/nmt/v1/translation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': secret },
      body: new URLSearchParams({ source, target, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const translated = d?.message?.result?.translatedText;
    return translated ? { translated, source } : null;
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const text = String(body.text || '').slice(0, 4500);
  const target = body.target || 'ko';
  if (!text.trim()) return NextResponse.json({ error: 'empty' }, { status: 400 });

  const cacheKey = `${target}:${text}`;
  if (cache.has(cacheKey)) return NextResponse.json({ translated: cache.get(cacheKey), cached: true });

  const papago = await translateWithPapago(text, target);
  if (papago) {
    cache.set(cacheKey, papago.translated);
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    return NextResponse.json({ translated: papago.translated, source: papago.source, engine: 'papago' });
  }

  const openai = await translateWithOpenAI(text, target);
  if (openai) {
    cache.set(cacheKey, openai);
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    return NextResponse.json({ translated: openai, engine: 'openai' });
  }

  return NextResponse.json({ translated: text, fallback: true, reason: 'no_translation_available' });
}
