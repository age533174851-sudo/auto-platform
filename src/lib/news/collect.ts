// src/lib/news/collect.ts
//
// 여러 공급자에서 온 기사를 하나의 모양으로 맞추고 중복을 걷어낸다.
//
// 왜 순수 모듈인가
// ────────────────
// 여기서 틀리면 화면이 조용히 이상해진다. 기사가 1970년으로 밀리거나,
// 같은 기사가 세 번 뜨거나, 본문이 있는 판본 대신 제목만 있는 판본이
// 남는다. 전부 눈으로는 "그냥 뉴스 목록"으로 보인다. 그래서 네트워크를
// 타지 않는 자리에 두고 테스트로 덮는다.

import { contentHash } from './schema';

export interface RawArticle {
  [k: string]: any;
}

export interface NormalizedArticle {
  title: string;
  body: string;
  url: string;
  /** ISO UTC */
  publishedAt: string;
  source: string;
  /** 어느 공급자에서 왔는가 (디버깅·비용 추적용) */
  provider: string;
  hash: string;
}

/**
 * 시각을 ISO UTC로.
 *
 * 공급자마다 다르다 — 유닉스 초, 유닉스 밀리초, ISO 문자열이 섞인다.
 * 초를 밀리초로 읽으면 1970년이 되고, 밀리초를 초로 읽으면 수만 년 뒤가
 * 된다. 둘 다 목록에서는 그냥 이상한 날짜로만 보인다.
 *
 * 판별 기준: 유닉스 초는 10자리(~2286년까지), 밀리초는 13자리다.
 */
export function toIso(v: unknown): string | null {
  if (v == null || v === '') return null;

  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    // 1e11 ≈ 1973년(밀리초) / 5138년(초). 이 위는 밀리초로 본다.
    const ms = n >= 1e11 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const first = (o: RawArticle, keys: string[]): string => {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    // 중첩된 경우: { source: { name: 'Reuters' } }
    if (v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim()) return v.name.trim();
  }
  return '';
};

/**
 * 공급자 응답 하나를 표준 모양으로.
 *
 * 제목이나 URL이 없으면 null이다. 그런 기사는 저장해도 원문을 확인할 수
 * 없고, AI 분석을 돌리면 돈만 나간다.
 */
export function normalizeArticle(raw: RawArticle, provider: string): NormalizedArticle | null {
  if (!raw || typeof raw !== 'object') return null;

  const title = first(raw, ['title', 'headline', 'name']);
  const url = first(raw, ['url', 'link', 'article_url', 'newsUrl']);
  if (!title || !url) return null;
  if (!/^https?:\/\//i.test(url)) return null;   // 상대 경로·빈 링크 제외

  const publishedAt = toIso(
    raw.publishedAt ?? raw.published_at ?? raw.datetime ?? raw.date ?? raw.time ?? raw.pubDate,
  );
  if (!publishedAt) return null;   // 시각 없는 기사는 정렬도 중복 판별도 못 한다

  return {
    title,
    body: first(raw, ['content', 'body', 'summary', 'description', 'text']),
    url,
    publishedAt,
    source: first(raw, ['source', 'site', 'publisher']) || provider,
    provider,
    hash: contentHash({ url, title, publishedAt }),
  };
}

/** 같은 지문이면 **본문이 더 긴 쪽**을 남긴다 */
function richer(a: NormalizedArticle, b: NormalizedArticle): NormalizedArticle {
  // 제목만 있는 판본이 본문 있는 판본을 덮으면 AI가 판단할 근거를 잃는다
  if (b.body.length > a.body.length) return b;
  return a;
}

export interface DedupeResult {
  unique: NormalizedArticle[];
  /** 걷어낸 개수. 0이면 중복 제거가 동작 안 하는 것일 수도 있어 로그로 본다 */
  removed: number;
}

/**
 * 중복 제거.
 *
 * 최신순으로 정렬해 돌려준다. 같은 기사가 여러 공급자에서 오는 것은
 * 정상이고, 그때마다 AI를 부르면 비용이 그만큼 곱해진다.
 */
export function dedupe(list: NormalizedArticle[]): DedupeResult {
  const byHash = new Map<string, NormalizedArticle>();
  let removed = 0;

  for (const a of list) {
    const prev = byHash.get(a.hash);
    if (prev) { removed++; byHash.set(a.hash, richer(prev, a)); }
    else byHash.set(a.hash, a);
  }

  const unique = [...byHash.values()].sort(
    (x, y) => Date.parse(y.publishedAt) - Date.parse(x.publishedAt),
  );
  return { unique, removed };
}

/** 여러 공급자 응답을 한 번에 */
export function collectFrom(
  batches: { provider: string; items: RawArticle[] | null | undefined }[],
): DedupeResult & { skipped: number } {
  const norm: NormalizedArticle[] = [];
  let skipped = 0;
  for (const b of batches) {
    if (!Array.isArray(b.items)) continue;
    for (const raw of b.items) {
      const n = normalizeArticle(raw, b.provider);
      if (n) norm.push(n); else skipped++;
    }
  }
  return { ...dedupe(norm), skipped };
}

/** 이미 저장된 지문을 빼고 새 것만 */
export function onlyNew(list: NormalizedArticle[], known: Set<string> | string[]): NormalizedArticle[] {
  const s = known instanceof Set ? known : new Set(known);
  return list.filter(a => !s.has(a.hash));
}
