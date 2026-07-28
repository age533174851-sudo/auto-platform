// src/lib/news/store.ts
//
// 수집한 기사를 저장하고 읽는다.
//
// 테이블이 없어도 죽지 않는다
// ───────────────────────────
// 019 마이그레이션을 아직 안 돌렸을 수 있다. 그때 500을 뱉으면 뉴스
// 화면 전체가 멈춘다. 저장만 건너뛰고 수집 결과는 그대로 돌려준다 —
// 다만 **저장이 안 됐다는 사실을 숨기지 않는다.** 조용히 성공한 척하면
// 크론이 매번 같은 기사를 다시 수집하면서 AI 비용만 나간다.
import type { NormalizedArticle } from './collect';
import type { NewsAnalysisV2 } from './schema';

const TABLE = 'news_articles';

/** 테이블 없음을 나타내는 Postgres 코드 */
function isMissingTable(err: any): boolean {
  const code = String(err?.code || '');
  const msg = String(err?.message || '').toLowerCase();
  return code === '42P01' || msg.includes('does not exist') || msg.includes('could not find the table');
}

export interface SaveResult {
  ok: boolean;
  saved: number;
  /** 테이블이 없어 저장을 건너뛴 경우 */
  skippedNoTable: boolean;
  error: string;
}

/**
 * 새 기사를 넣는다. 이미 있으면 건드리지 않는다.
 *
 * upsert가 아니라 ignoreDuplicates를 쓰는 이유: 같은 hash가 다시 들어왔을
 * 때 원문을 덮으면, 이미 붙여둔 AI 분석이 날아간다. 원문은 안 바뀐다.
 */
export async function saveArticles(sb: any, list: NormalizedArticle[]): Promise<SaveResult> {
  if (!sb) return { ok: false, saved: 0, skippedNoTable: false, error: 'supabase_not_configured' };
  if (list.length === 0) return { ok: true, saved: 0, skippedNoTable: false, error: '' };

  const rows = list.map(a => ({
    hash: a.hash, title: a.title, body: a.body, url: a.url,
    published_at: a.publishedAt, source: a.source, provider: a.provider,
  }));

  try {
    const { error } = await sb.from(TABLE)
      .upsert(rows, { onConflict: 'hash', ignoreDuplicates: true });
    if (error) {
      if (isMissingTable(error)) {
        return {
          ok: false, saved: 0, skippedNoTable: true,
          error: 'news_articles 테이블이 없습니다 — supabase/migrations/019_news_articles.sql을 실행하세요. 수집은 됐지만 저장되지 않았습니다.',
        };
      }
      return { ok: false, saved: 0, skippedNoTable: false, error: error.message || '저장 실패' };
    }
    return { ok: true, saved: rows.length, skippedNoTable: false, error: '' };
  } catch (e: any) {
    return { ok: false, saved: 0, skippedNoTable: false, error: e?.message || '저장 중 오류' };
  }
}

/**
 * 이미 저장된 지문 목록.
 *
 * 실패하면 **빈 배열이 아니라 null**을 준다. 빈 배열로 두면 "저장된 게
 * 없다"로 읽혀서 전부 새 기사로 보이고, AI를 다시 다 돌린다.
 */
export async function knownHashes(sb: any, hashes: string[]): Promise<Set<string> | null> {
  if (!sb || hashes.length === 0) return new Set();
  try {
    const { data, error } = await sb.from(TABLE).select('hash').in('hash', hashes);
    if (error) return null;
    return new Set((data || []).map((r: any) => String(r.hash)));
  } catch { return null; }
}

/** 아직 분석 안 된 기사 (크론용) */
export async function unanalyzed(sb: any, limit = 10): Promise<NormalizedArticle[] | null> {
  if (!sb) return null;
  try {
    const { data, error } = await sb.from(TABLE)
      .select('hash, title, body, url, published_at, source, provider')
      .is('analyzed_at', null)
      .order('published_at', { ascending: false })
      .limit(Math.max(1, Math.min(50, limit)));
    if (error) return null;
    return (data || []).map((r: any) => ({
      hash: r.hash, title: r.title, body: r.body || '', url: r.url,
      publishedAt: new Date(r.published_at).toISOString(),
      source: r.source || '', provider: r.provider || '',
    }));
  } catch { return null; }
}

/** 분석 결과를 기사에 붙인다 */
export async function attachAnalysis(
  sb: any, hash: string, a: NewsAnalysisV2, repaired: string[],
): Promise<{ ok: boolean; error: string }> {
  if (!sb) return { ok: false, error: 'supabase_not_configured' };
  try {
    const { error } = await sb.from(TABLE).update({
      analyzed_at: a.analyzedAt,
      ai_provider: a.provider, ai_model: a.model,
      title_ko: a.titleKo, summary: a.summary,
      direction: a.direction, confidence: a.confidence, horizon: a.horizon,
      reasons: a.reasons, risks: a.risks, affected_assets: a.affectedAssets,
      repaired,
    }).eq('hash', hash);
    return error ? { ok: false, error: error.message } : { ok: true, error: '' };
  } catch (e: any) { return { ok: false, error: e?.message || '분석 저장 실패' }; }
}
