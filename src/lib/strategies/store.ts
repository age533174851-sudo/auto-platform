// src/lib/strategies/store.ts
// 사용자 전략 CRUD (localStorage 기반)
// 로그인 유저용 supabase 동기화는 별도 라운드.

import type { UserStrategy } from './types';

const KEY = 'tg_user_strategies_v1';

function readAll(): UserStrategy[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeAll(list: UserStrategy[]): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}

export function listStrategies(): UserStrategy[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveStrategy(s: UserStrategy): UserStrategy {
  const list = readAll();
  const idx = list.findIndex(x => x.id === s.id);
  const now = Date.now();
  const updated = { ...s, updatedAt: now };
  if (idx >= 0) list[idx] = updated;
  else          list.push({ ...updated, createdAt: updated.createdAt || now });
  writeAll(list);
  return updated;
}

export function deleteStrategy(id: string): void {
  writeAll(readAll().filter(s => s.id !== id));
}

export function toggleEnabled(id: string, enabled: boolean): UserStrategy | null {
  const list = readAll();
  const idx = list.findIndex(s => s.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], enabled, updatedAt: Date.now() };
  writeAll(list);
  return list[idx];
}

export function duplicateStrategy(id: string): UserStrategy | null {
  const list = readAll();
  const src  = list.find(s => s.id === id);
  if (!src) return null;
  const now = Date.now();
  const copy: UserStrategy = {
    ...src,
    id:        'str-' + now.toString(36),
    name:      `${src.name} (복사)`,
    enabled:   false,
    createdAt: now,
    updatedAt: now,
  };
  list.push(copy);
  writeAll(list);
  return copy;
}

export function newStrategyId(): string {
  return 'str-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}
