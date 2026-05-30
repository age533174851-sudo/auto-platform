// /api/translate — Papago(Naver) 번역
// POST { text, target?='ko', source?='auto' }
// 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 간단 캐시 (같은 텍스트 재번역 방지)
const cache = new Map<string, string>();

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const text = String(body.text || '').slice(0, 4500);
  const target = body.target || 'ko';
  if (!text.trim()) return NextResponse.json({ error: 'empty' }, { status: 400 });

  const id = process.env.NAVER_CLIENT_ID || '';
  const secret = process.env.NAVER_CLIENT_SECRET || '';
  if (!id || !secret) {
    // 키 없으면 원문 반환 (fallback)
    return NextResponse.json({ translated: text, source: 'none', fallback: true });
  }

  const cacheKey = `${target}:${text}`;
  if (cache.has(cacheKey)) return NextResponse.json({ translated: cache.get(cacheKey), cached: true });

  try {
    // 언어 감지
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

    // 이미 목표 언어면 그대로
    if (source === target) return NextResponse.json({ translated: text, source, skipped: true });

    // 번역
    const r = await fetch('https://naveropenapi.apigw.ntruss.com/nmt/v1/translation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': secret },
      body: new URLSearchParams({ source, target, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      return NextResponse.json({ translated: text, source, fallback: true, error: e?.errorMessage || `HTTP ${r.status}` });
    }
    const d = await r.json();
    const translated = d?.message?.result?.translatedText || text;
    cache.set(cacheKey, translated);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return NextResponse.json({ translated, source });
  } catch (e: any) {
    return NextResponse.json({ translated: text, fallback: true, error: e?.message || 'error' });
  }
}
