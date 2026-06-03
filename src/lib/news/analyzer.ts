// ─────────────────────────────────────────────────────────────
// TRAIGO — News Analyzer Client Helper
// sessionStorage 캐시 + batch 호출 + mock fallback
// ─────────────────────────────────────────────────────────────

import type { AnalyzeRequest, AnalyzeResponse, NewsAnalysis } from './types';
import { mockAnalyze } from './mockAnalyzer';

const CACHE_KEY_PREFIX = 'tg_news_analysis_v1_';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h

interface CacheEntry {
  analysis: NewsAnalysis;
  cachedAt: number;
}

export function loadCachedAnalysis(id: string): NewsAnalysis | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY_PREFIX + id);
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    if (!entry || !entry.analysis) return null;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      window.sessionStorage.removeItem(CACHE_KEY_PREFIX + id);
      return null;
    }
    return { ...entry.analysis, source: 'cache' };
  } catch {
    return null;
  }
}

export function saveCachedAnalysis(id: string, analysis: NewsAnalysis): void {
  if (typeof window === 'undefined') return;
  try {
    const entry: CacheEntry = { analysis, cachedAt: Date.now() };
    window.sessionStorage.setItem(CACHE_KEY_PREFIX + id, JSON.stringify(entry));
  } catch {
    // QuotaExceeded — silently ignore
  }
}

// 배치 분석 요청
export async function analyzeNewsBatch(items: AnalyzeRequest['items']): Promise<Record<string, NewsAnalysis>> {
  if (!Array.isArray(items) || items.length === 0) return {};

  // 캐시된 것은 즉시 반환, 나머지만 API
  const cached: Record<string, NewsAnalysis> = {};
  const needFetch: AnalyzeRequest['items'] = [];
  for (const it of items) {
    const c = loadCachedAnalysis(it.id);
    if (c) cached[it.id] = c;
    else needFetch.push(it);
  }

  if (needFetch.length === 0) return cached;

  // API 호출
  try {
    const r = await fetch('/api/news/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: needFetch } satisfies AnalyzeRequest),
      signal: AbortSignal.timeout(25000),
    });
    if (r.ok) {
      const d = (await r.json()) as AnalyzeResponse;
      if (d && d.results) {
        for (const id of Object.keys(d.results)) {
          const a = d.results[id];
          if (a) {
            cached[id] = a;
            saveCachedAnalysis(id, a);
          }
        }
        // API에서 누락된 건 mock으로
        for (const it of needFetch) {
          if (!cached[it.id]) {
            const m = mockAnalyze(it);
            cached[it.id] = m;
            saveCachedAnalysis(it.id, m);
          }
        }
        return cached;
      }
    }
    // API 실패 → 전부 mock
    for (const it of needFetch) {
      const m = mockAnalyze(it);
      cached[it.id] = m;
      saveCachedAnalysis(it.id, m);
    }
    return cached;
  } catch (e) {
    console.warn('[news] analyze API failed, using mock', e);
    for (const it of needFetch) {
      const m = mockAnalyze(it);
      cached[it.id] = m;
      saveCachedAnalysis(it.id, m);
    }
    return cached;
  }
}

// 단건 즉시 mock (캐시 안 침)
export function quickMockAnalyze(item: AnalyzeRequest['items'][number]): NewsAnalysis {
  return mockAnalyze(item);
}
