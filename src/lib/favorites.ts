// src/lib/favorites.ts
// 기능 즐겨찾기 — 홈에 고정할 메뉴 id 목록. localStorage 영속 + 구독.
const KEY = 'tg_favorites_v1';
const MAX = 8;

type Cb = () => void;
const subs = new Set<Cb>();

export function getFavorites(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function save(ids: string[]) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, JSON.stringify(ids.slice(0, MAX))); } catch {}
  subs.forEach(cb => { try { cb(); } catch {} });
}

export function isFavorite(id: string): boolean {
  return getFavorites().includes(id);
}

// 추가/제거 토글. 반환: 추가됐으면 true. 한도 초과 시 false.
export function toggleFavorite(id: string): boolean {
  const cur = getFavorites();
  if (cur.includes(id)) { save(cur.filter(x => x !== id)); return false; }
  if (cur.length >= MAX) { save(cur); return false; }   // 한도 초과 → 변화 없음
  save([...cur, id]);
  return true;
}

export function subscribeFavorites(cb: Cb): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export const FAV_MAX = MAX;
