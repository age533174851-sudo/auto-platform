// src/lib/strategies/sync.ts
// 전략 클라우드 동기화 (Supabase) — best-effort
//
// 정책:
// - localStorage가 마스터 (오프라인 우선)
// - 로그인된 유저는 Supabase에 best-effort로 미러링
// - 실패해도 동작에 영향 X
// - 다른 기기에서 로그인 시 pullStrategies()로 가져와 병합

import type { UserStrategy } from './types';
import { listStrategies, saveStrategy } from './store';

const PULLED_KEY  = 'tg_strategies_synced_at_v1';

/** 로그인 유저 토큰 가져오기 */
async function getAuthHeader(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  try {
    // supabase-js client가 있다면 세션 토큰 사용
    const { getSupabaseClient } = await import('@/lib/supabase/client');
    const client = getSupabaseClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    const token = data?.session?.access_token;
    return token ? `Bearer ${token}` : null;
  } catch { return null; }
}

/** Supabase → 클라이언트 (로그인 후 호출하면 좋음) */
export async function pullStrategies(): Promise<{ ok: boolean; merged: number; error?: string }> {
  if (typeof window === 'undefined') return { ok: false, merged: 0 };
  const auth = await getAuthHeader();
  if (!auth) return { ok: false, merged: 0, error: 'not_logged_in' };

  try {
    const r = await fetch('/api/strategies/sync?action=pull', {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return { ok: false, merged: 0, error: `status_${r.status}` };
    const d = await r.json();
    if (!d.synced) return { ok: false, merged: 0, error: d.reason || 'sync_disabled' };

    const remote: UserStrategy[] = Array.isArray(d.strategies) ? d.strategies : [];
    const local = listStrategies();
    const localById = new Map(local.map(s => [s.id, s]));

    // last-write-wins: updatedAt 비교
    let merged = 0;
    for (const r of remote) {
      const l = localById.get(r.id);
      if (!l || r.updatedAt > l.updatedAt) {
        saveStrategy(r);
        merged++;
      }
    }

    try { window.localStorage.setItem(PULLED_KEY, String(Date.now())); } catch {}
    return { ok: true, merged };
  } catch (e) {
    return { ok: false, merged: 0, error: e instanceof Error ? e.message : 'unknown' };
  }
}

/** 클라이언트 → Supabase (저장/수정/토글 후 호출) */
export async function pushStrategies(strategies?: UserStrategy[]): Promise<{ ok: boolean; error?: string }> {
  if (typeof window === 'undefined') return { ok: false };
  const auth = await getAuthHeader();
  if (!auth) return { ok: false, error: 'not_logged_in' };

  const list = strategies ?? listStrategies();
  if (list.length === 0) return { ok: true };
  if (list.length > 50) {
    return { ok: false, error: 'too_many_strategies' };
  }

  try {
    const r = await fetch('/api/strategies/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ action: 'push', strategies: list }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      return { ok: false, error: d.error || `status_${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown' };
  }
}

/** 단일 전략 삭제 — Supabase에서도 제거 */
export async function deleteStrategyCloud(id: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof window === 'undefined') return { ok: false };
  const auth = await getAuthHeader();
  if (!auth) return { ok: false, error: 'not_logged_in' };

  try {
    const r = await fetch('/api/strategies/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ action: 'delete', id }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      return { ok: false, error: d.error || `status_${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown' };
  }
}

/** 마지막 동기화 시각 */
export function getLastSyncedAt(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(PULLED_KEY);
    return raw ? parseInt(raw, 10) : 0;
  } catch { return 0; }
}
