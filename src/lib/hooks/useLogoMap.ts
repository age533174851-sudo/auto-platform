// ─────────────────────────────────────────────────────────────
// TRAIGO — useLogoMap
// 자산 리스트(symbol[])을 받으면 /api/logo/batch 호출해서 logoUrl map 반환
// - sessionStorage 캐시 (6h)
// - 같은 심볼 재요청 방지
// - 페이지 진입시 한 번만 호출
// ─────────────────────────────────────────────────────────────

import { useEffect, useState, useRef } from 'react';

// v2 — 캐시 열쇠에 자산 종류를 넣는다.
//
// v1은 심볼만으로 캐시했다. 그런데 티커는 시장을 가로질러 겹친다:
//   SOL  → 솔라나(코인) / ReneSola(미국주식)
//   XRP  → 리플(코인)   / Bitwise XRP ETF
// 그래서 왓치리스트 코인 탭에 ReneSola와 Bitwise 로고가 떴다.
//
// 종류를 안 넘기면 서버가 'auto'로 추측하고, 추측은 주식 쪽을 먼저 본다.
// 열쇠를 바꿨으므로 v1 캐시는 자연히 버려진다.
const STORAGE_KEY = 'tg_logo_map_v2';
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

interface CachedLogo {
  logoUrl: string | null;
  fallback: boolean;
  cachedAt: number;
}

function loadStore(): Record<string, CachedLogo> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function saveStore(store: Record<string, CachedLogo>) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch { /* quota — ignore */ }
}

function isFresh(entry: CachedLogo | undefined): entry is CachedLogo {
  if (!entry) return false;
  return Date.now() - entry.cachedAt < TTL_MS;
}

interface BatchResponse {
  ok?: boolean;
  items?: Record<string, { symbol: string; logoUrl: string | null; source: string; fallback: boolean }>;
}

/**
 * 자산 심볼 배열을 받아 { [SYMBOL]: logoUrl } 맵을 반환.
 * 캐시에 있는 건 즉시 반환, 없는 것만 API 호출.
 */
export function useLogoMap(
  symbols: string[] | undefined | null,
  /**
   * 이 목록이 어떤 자산인가. **'auto'로 두면 티커가 겹치는 종목이
   * 다른 시장의 로고를 가져온다** (SOL → ReneSola).
   */
  assetType: 'stock' | 'etf' | 'crypto' | 'auto' = 'auto',
): Record<string, string> {
  // 캐시·요청 열쇠. 같은 티커라도 종류가 다르면 다른 로고다.
  const keyOf = (sym: string) => `${assetType}:${sym}`;
  const [map, setMap] = useState<Record<string, string>>(() => {
    if (typeof window === 'undefined') return {};
    const store = loadStore();
    const initial: Record<string, string> = {};
    for (const k of Object.keys(store)) {
      const v = store[k];
      if (!isFresh(v) || !v.logoUrl || v.fallback) continue;
      // 열쇠는 'crypto:SOL' 모양이다. 화면은 심볼로 찾으므로 되돌린다.
      const sym = k.slice(k.indexOf(':') + 1);
      initial[sym] = v.logoUrl;
    }
    return initial;
  });
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!Array.isArray(symbols) || symbols.length === 0) return;
    const store = loadStore();

    // 정규화 + 캐시 없는 심볼만 추출
    const need: string[] = [];
    const fromCache: Record<string, string> = {};
    const seen = new Set<string>();
    for (const raw of symbols) {
      const s = (raw || '').trim().toUpperCase();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      const c = store[keyOf(s)];
      if (isFresh(c)) {
        if (c.logoUrl && !c.fallback) fromCache[s] = c.logoUrl;
        continue;
      }
      if (inFlight.current.has(keyOf(s))) continue;
      need.push(s);
    }

    // 캐시에서 즉시 채울 수 있는 게 있으면 반영
    if (Object.keys(fromCache).length > 0) {
      setMap(prev => {
        const next = { ...prev };
        let changed = false;
        for (const k of Object.keys(fromCache)) {
          if (next[k] !== fromCache[k]) { next[k] = fromCache[k]; changed = true; }
        }
        return changed ? next : prev;
      });
    }
    if (need.length === 0) return;

    // in-flight 표시
    for (const s of need) inFlight.current.add(keyOf(s));

    // 50개 단위로 batch
    const cancelled = { v: false };
    (async () => {
      try {
        const r = await fetch(`/api/logo/batch?symbols=${encodeURIComponent(need.join(','))}&type=${assetType}`, {
          signal: AbortSignal.timeout(15000),
        });
        if (cancelled.v) return;
        if (!r.ok) return;
        const data: BatchResponse = await r.json();
        const items = data?.items || {};
        const newStore = loadStore();
        const newMap: Record<string, string> = {};
        const now = Date.now();
        for (const s of need) {
          const it = items[s];
          if (it) {
            newStore[keyOf(s)] = { logoUrl: it.logoUrl, fallback: it.fallback, cachedAt: now };
            if (it.logoUrl && !it.fallback) newMap[s] = it.logoUrl;
          } else {
            // API에서 누락된 심볼도 fallback으로 캐싱해서 재요청 안 함
            newStore[keyOf(s)] = { logoUrl: null, fallback: true, cachedAt: now };
          }
        }
        saveStore(newStore);
        if (Object.keys(newMap).length > 0) {
          setMap(prev => ({ ...prev, ...newMap }));
        }
      } catch (e) {
        // 에러 무시 (Logo 컴포넌트의 자체 cascade가 fallback 처리)
        console.warn('[useLogoMap] batch failed', e);
      } finally {
        for (const s of need) inFlight.current.delete(keyOf(s));
      }
    })();

    return () => { cancelled.v = true; };
  // symbols 배열 자체보다 정렬된 문자열로 비교 (불필요한 리렌더 방지)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(symbols) ? symbols.map(s => (s || '').toUpperCase()).sort().join(',') : '', assetType]);

  return map;
}
