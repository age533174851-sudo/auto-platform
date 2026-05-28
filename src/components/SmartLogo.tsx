'use client';
import React, { useState, useEffect, useMemo, useRef } from 'react';

interface SmartLogoProps {
  symbol:    string;
  type?:     'stock' | 'etf' | 'crypto' | 'auto';
  size?:     number;
  fallbackColor?: string;
  name?:     string;
  rounded?:  boolean;
}

/* ═══════════════════════════════════════════════════════════════
   Batch resolver — coalesces many SmartLogo mounts into ONE call.
   Reduces logo API calls from N → 1 per ~50ms window.
   ═══════════════════════════════════════════════════════════════ */

interface BatchEntry {
  type: string;
  resolvers: Array<(url: string | null) => void>;
}

const URL_CACHE        = new Map<string, string | null>();   // key → url or null (fallback)
const INFLIGHT         = new Map<string, Promise<string | null>>();
const PENDING_QUEUE    = new Map<string, BatchEntry>();      // key → entry
let   BATCH_TIMER: any = null;
const BATCH_WINDOW_MS  = 60;     // coalesce window
const MAX_BATCH        = 40;     // server-side limit safe under 50

function batchKey(type: string, sym: string) {
  return `${type}:${sym}`;
}

function scheduleFlush() {
  if (BATCH_TIMER) return;
  BATCH_TIMER = setTimeout(() => {
    BATCH_TIMER = null;
    flushBatch();
  }, BATCH_WINDOW_MS);
}

async function flushBatch() {
  if (PENDING_QUEUE.size === 0) return;
  // Group by type — same type can batch together
  const byType = new Map<string, Array<{ key: string; sym: string; entry: BatchEntry }>>();
  for (const [key, entry] of PENDING_QUEUE.entries()) {
    const sym = key.split(':').slice(1).join(':');
    if (!byType.has(entry.type)) byType.set(entry.type, []);
    byType.get(entry.type)!.push({ key, sym, entry });
  }
  PENDING_QUEUE.clear();

  for (const [type, items] of byType.entries()) {
    // Slice into chunks of MAX_BATCH
    for (let i = 0; i < items.length; i += MAX_BATCH) {
      const chunk = items.slice(i, i + MAX_BATCH);
      const symbols = chunk.map(x => x.sym);
      try {
        const res = await fetch('/api/logo/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols, type }),
          signal: AbortSignal.timeout(8000),
        });
        const data = res.ok ? await res.json() : null;
        const items_ = data?.items || {};
        for (const { key, sym, entry } of chunk) {
          const item = items_[sym];
          const url = item && !item.fallback ? item.logoUrl : null;
          URL_CACHE.set(key, url);
          entry.resolvers.forEach(r => r(url));
        }
      } catch {
        for (const { key, entry } of chunk) {
          URL_CACHE.set(key, null);
          entry.resolvers.forEach(r => r(null));
        }
      }
    }
  }
}

function resolveLogo(type: string, sym: string): Promise<string | null> {
  const key = batchKey(type, sym);
  if (URL_CACHE.has(key)) return Promise.resolve(URL_CACHE.get(key) ?? null);
  if (INFLIGHT.has(key))  return INFLIGHT.get(key)!;
  const promise = new Promise<string | null>(resolve => {
    let entry = PENDING_QUEUE.get(key);
    if (!entry) {
      entry = { type, resolvers: [] };
      PENDING_QUEUE.set(key, entry);
    }
    entry.resolvers.push(resolve);
    scheduleFlush();
  });
  INFLIGHT.set(key, promise);
  promise.finally(() => INFLIGHT.delete(key));
  return promise;
}

/* ═══════════════════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════════════════ */

function getInitial(name?: string, symbol?: string): string {
  const src = name || symbol || '?';
  return (src.trim()[0] || '?').toUpperCase();
}

function detectType(sym: string): 'crypto' | 'stock' {
  // Common known coins (subset — server has full list)
  const COINS = new Set(['BTC','ETH','SOL','XRP','BNB','ADA','AVAX','DOGE','SHIB','DOT','LINK','MATIC','LTC','TRX','ATOM','NEAR','UNI','APT']);
  if (COINS.has(sym)) return 'crypto';
  return 'stock';
}

function SmartLogoImpl({
  symbol,
  type = 'auto',
  size = 36,
  fallbackColor = '#3B82F6',
  name,
  rounded = true,
}: SmartLogoProps) {
  const sym = (symbol || '').toUpperCase().trim();
  const resolvedType = type === 'auto' ? detectType(sym) : type;
  const cacheKey = batchKey(resolvedType, sym);

  const [logoUrl, setLogoUrl] = useState<string | null>(() =>
    URL_CACHE.has(cacheKey) ? URL_CACHE.get(cacheKey) ?? null : null
  );
  const [errored, setErrored] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => () => { isMountedRef.current = false; }, []);

  useEffect(() => {
    if (!sym) return;
    if (URL_CACHE.has(cacheKey)) {
      setLogoUrl(URL_CACHE.get(cacheKey) ?? null);
      return;
    }
    let cancelled = false;
    resolveLogo(resolvedType, sym).then(url => {
      if (cancelled || !isMountedRef.current) return;
      setLogoUrl(url);
    });
    return () => { cancelled = true; };
  }, [sym, resolvedType, cacheKey]);

  const initial = useMemo(() => getInitial(name, sym), [name, sym]);

  if (!logoUrl || errored) {
    return (
      <div style={{
        width: size, height: size,
        borderRadius: rounded ? '50%' : '20%',
        background: fallbackColor,
        display:'flex', alignItems:'center', justifyContent:'center',
        color:'#fff', fontWeight: 800, fontSize: Math.round(size * 0.42),
        flexShrink: 0,
      }}>{initial}</div>
    );
  }

  return (
    <img
      src={logoUrl}
      alt={`${sym} logo`}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setErrored(true)}
      style={{
        width: size, height: size,
        borderRadius: rounded ? '50%' : '20%',
        objectFit:'cover',
        background:'#fff',
        flexShrink: 0,
      }}
    />
  );
}

/* Memoize: only re-render if symbol/type/size change. */
const SmartLogo = React.memo(SmartLogoImpl, (prev, next) =>
  prev.symbol === next.symbol &&
  prev.type   === next.type   &&
  prev.size   === next.size   &&
  prev.name   === next.name
);
SmartLogo.displayName = 'SmartLogo';

export default SmartLogo;
