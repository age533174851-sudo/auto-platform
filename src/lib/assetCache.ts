// ─────────────────────────────────────────────────────────────
// TRAIGO Asset Cache System
// Layer 1: Memory cache (instant)
// Layer 2: localStorage (persistent offline)
// Layer 3: Supabase cached_assets table (cross-device)
// ─────────────────────────────────────────────────────────────
import type { CachedAsset, SearchResult, AssetType } from './assetTypes';

const CACHE_KEY = 'tg_asset_cache_v2';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── In-memory cache ───────────────────────────────────────────
let memCache: Record<string, CachedAsset> = {};
let memCacheTime: Record<string, number> = {};

// ── Supabase SQL Schema (reference) ──────────────────────────
export const SUPABASE_ASSET_SCHEMA = `
-- Cached assets table (for cross-device sync)
create table if not exists cached_assets (
  symbol        text primary key,
  name          text not null,
  name_kr       text,
  exchange      text,
  asset_type    text,
  currency      text default 'USD',
  logo_url      text,
  last_price    numeric,
  change_pct    numeric,
  updated_at    timestamptz default now(),
  source        text default 'mock',
  is_favorite   boolean default false,
  user_id       uuid references auth.users
);

create index if not exists idx_cached_assets_type on cached_assets(asset_type);
create index if not exists idx_cached_assets_user on cached_assets(user_id);
`;

// ── Load all cached assets from localStorage ─────────────────
export function loadCache(): Record<string, CachedAsset> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    memCache = parsed;
    return parsed;
  } catch {
    return {};
  }
}

// ── Save one asset to cache ───────────────────────────────────
export function cacheAsset(asset: CachedAsset): void {
  memCache[asset.symbol] = asset;
  memCacheTime[asset.symbol] = Date.now();
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(memCache));
    } catch {}
  }
}

// ── Get from cache (checks TTL) ───────────────────────────────
export function getCachedAsset(symbol: string): CachedAsset | null {
  const cached = memCache[symbol];
  if (!cached) {
    // Try loading from localStorage
    const all = loadCache();
    return all[symbol] || null;
  }
  const age = Date.now() - (memCacheTime[symbol] || 0);
  if (age > CACHE_TTL) return null; // stale, refetch
  return cached;
}

// ── Convert SearchResult → CachedAsset ───────────────────────
export function searchResultToCache(result: SearchResult, price?: number): CachedAsset {
  return {
    symbol:     result.symbol,
    name:       result.name,
    nameKr:     result.nameKr,
    exchange:   result.exchange,
    asset_type: result.asset_type,
    currency:   result.currency,
    logo_url:   result.logo_url,
    last_price: price,
    updated_at: new Date().toISOString(),
    source:     result.provider,
  };
}

// ── Get all cached assets sorted by recency ───────────────────
export function getAllCached(): CachedAsset[] {
  const cache = loadCache();
  return Object.values(cache).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
}

// ── Remove from cache ─────────────────────────────────────────
export function removeCached(symbol: string): void {
  delete memCache[symbol];
  if (typeof window !== 'undefined') {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(memCache)); } catch {}
  }
}

// ── Toggle favorite ───────────────────────────────────────────
export function toggleFavorite(symbol: string): void {
  if (memCache[symbol]) {
    memCache[symbol].is_favorite = !memCache[symbol].is_favorite;
    if (typeof window !== 'undefined') {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(memCache)); } catch {}
    }
  }
}

// ── Supabase sync (optional, called when auth is available) ───
export async function syncToSupabase(_userId: string): Promise<void> {
  // Supabase sync — enabled when @supabase/supabase-js is installed
  // npm install @supabase/supabase-js
}

// ── Load from Supabase (on login) ────────────────────────────
export async function loadFromSupabase(_userId: string): Promise<void> {
  // Supabase load — enabled when @supabase/supabase-js is installed
  // npm install @supabase/supabase-js
}
