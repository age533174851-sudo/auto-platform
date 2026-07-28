// ─────────────────────────────────────────────────────────────
// TRAIGO — News Analyzer Client Helper
// sessionStorage 캐시 + batch 호출 + mock fallback
// ─────────────────────────────────────────────────────────────

import type { AnalyzeRequest, AnalyzeResponse, NewsAnalysis } from './types';
import { mockAnalyze } from './mockAnalyzer';
import { newsCacheKey, isVerifiableNewsItem } from './schema';

export { newsCacheKey, isVerifiableNewsItem };

// v2 — 키를 id에서 내용 지문으로 바꿨다. 옛 키는 자연히 버려진다.
const CACHE_KEY_PREFIX = 'tg_news_analysis_v2_';
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
//
// 출처를 확인할 수 없는 기사는 아예 요청하지 않고, 결과에도 넣지 않는다.
// 서버도 같은 기준으로 거른다(isVerifiableNewsItem) — 두 쪽이 어긋나면
// 화면은 영영 오지 않는 결과를 기다리며 계속 다시 요청한다.
export async function analyzeNewsBatch(items: AnalyzeRequest['items']): Promise<Record<string, NewsAnalysis>> {
  if (!Array.isArray(items) || items.length === 0) return {};

  const analyzable = items.filter(it => isVerifiableNewsItem(it));
  if (analyzable.length === 0) return {};

  // 캐시된 것은 즉시 반환, 나머지만 API.
  // 캐시는 내용 지문으로 찾고, 결과는 호출자가 준 id로 돌려준다 —
  // 같은 기사가 다른 id로 들어와도 두 번 분석하지 않는다.
  const cached: Record<string, NewsAnalysis> = {};
  const needFetch: AnalyzeRequest['items'] = [];
  for (const it of analyzable) {
    const c = loadCachedAnalysis(newsCacheKey(it));
    if (c) cached[it.id] = c;
    else needFetch.push(it);
  }

  if (needFetch.length === 0) return cached;

  // 분석에 실패한 자리를 mock으로 채운다. 여기 오는 항목은 출처가 확인된
  // 것들뿐이다 — 독자가 원문으로 가서 맞는지 볼 수 있다.
  const fillWithMock = () => {
    for (const it of needFetch) {
      if (cached[it.id]) continue;
      const m = mockAnalyze(it);
      cached[it.id] = m;
      saveCachedAnalysis(newsCacheKey(it), m);
    }
  };

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
        for (const it of needFetch) {
          const a = d.results[it.id];
          if (a) {
            cached[it.id] = a;
            saveCachedAnalysis(newsCacheKey(it), a);
          }
        }
      }
    }
  } catch (e) {
    console.warn('[news] analyze API failed, using mock', e);
  }

  fillWithMock();
  return cached;
}

// 단건 즉시 mock (캐시 안 침)
export function quickMockAnalyze(item: AnalyzeRequest['items'][number]): NewsAnalysis {
  return mockAnalyze(item);
}
