/**
 * src/lib/api/hooks.ts
 * React hooks that wrap the API client.
 * Components import ONLY these hooks — never fetch directly.
 */
'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  fetchPrices, fetchGainers, fetchLosers, fetchTrending,
  fetchCandles, fetchCalendar, fetchProviderStatus,
  placeOrder, calcTax,
  type PriceItem, type CalendarEvent, type OrderRequest,
  type OrderResult, type TaxInput, type TaxResult,
  type ApiResult, type DataStatus, type ProviderStatus,
} from './client';
import type { Asset } from '@/types';
import { ASSETS, simulatePriceUpdate } from '@/data/assets';

/* ── Status badge ────────────────────────────────────────────── */
export function statusLabel(s: DataStatus) {
  return s === 'live'  ? { text:'LIVE',  color:'#10B981' }
       : s === 'mock'  ? { text:'MOCK',  color:'#F59E0B' }
       : s === 'error' ? { text:'ERR',   color:'#EF4444' }
       :                 { text:'…',     color:'#475569' };
}

/* ═══════════════════════════════════════════════════════════════
   useLivePrices — polls /api/prices and simulates locally
   ═══════════════════════════════════════════════════════════════ */
export function useLivePrices(intervalMs = 8000) {
  const [prices,    setPrices]    = useState<Asset[]>(ASSETS);
  const [status,    setStatus]    = useState<DataStatus>('loading');
  const [source,    setSource]    = useState('initialising');

  // Merge Binance live data into ASSETS array (keep full Asset shape)
  const merge = useCallback((live: PriceItem[]) => {
    if (!live.length) return;
    setPrices(prev => prev.map(a => {
      const match = live.find(l =>
        l.id === a.id || l.symbol === a.id ||
        l.symbol.toUpperCase() === a.sym?.replace('USDT','').toUpperCase()
      );
      if (!match) return a;
      return { ...a, p: match.price, c: match.change24h, v: String(match.volume) };
    }));
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchPrices('coin').then(r => {
      merge(r.data);
      setStatus(r.data.length > 0 ? 'live' : 'mock');
      setSource(r.source);
    });
  }, [merge]);

  // Interval: real refresh every ~24s, local sim every 8s (mobile-friendly)
  // PAUSES when tab is hidden to save CPU/battery.
  useEffect(() => {
    let fetchCount = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      // Skip work if tab hidden
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchCount++;
      if (fetchCount % Math.round(24000 / intervalMs) === 0) {
        // Real refresh ~24s
        fetchPrices('coin').then(r => {
          merge(r.data);
          setStatus(r.data.length > 0 ? 'live' : 'mock');
          setSource(r.source);
        }).catch(() => {});
      } else {
        // Local simulation between refreshes
        setPrices(prev => simulatePriceUpdate(prev));
      }
    };
    const t = setInterval(tick, intervalMs);
    // Refetch immediately when tab becomes visible again
    const onVis = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        fetchPrices('coin').then(r => {
          merge(r.data);
          setStatus(r.data.length > 0 ? 'live' : 'mock');
          setSource(r.source);
        }).catch(() => {});
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
    }
    return () => {
      stopped = true;
      clearInterval(t);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, [intervalMs, merge]);

  return { prices, status, source };
}

/* ═══════════════════════════════════════════════════════════════
   useMarketLists — gainers / losers / trending
   ═══════════════════════════════════════════════════════════════ */
export function useMarketLists(tab: 'gainers'|'losers'|'trending', prices: Asset[], enabled: boolean) {
  const [data,   setData]   = useState<PriceItem[]>([]);
  const [status, setStatus] = useState<DataStatus>('loading');

  useEffect(() => {
    if (!enabled) return;
    setStatus('loading');
    const fn = tab === 'gainers' ? fetchGainers
             : tab === 'losers'  ? fetchLosers
             : fetchTrending;
    fn().then(r => {
      if (r.data.length > 0) {
        setData(r.data);
        setStatus(r.status);
      } else {
        // Fallback: compute from prices prop
        const sorted = [...prices].filter(a => isFinite(a.c));
        const items: PriceItem[] = (
          tab === 'gainers'  ? sorted.sort((a,b) => b.c - a.c) :
          tab === 'losers'   ? sorted.sort((a,b) => a.c - b.c) :
          sorted.sort((a,b) => Math.abs(b.c) - Math.abs(a.c))
        ).slice(0,20).map(a => ({
          id: a.id, symbol: a.sym || a.id, nameKr: a.nameKr,
          price: a.p, change24h: a.c, volume: a.v, source: 'mock',
        }));
        setData(items);
        setStatus('mock');
      }
    });
  }, [tab, enabled, prices]);

  return { data, status };
}

/* ═══════════════════════════════════════════════════════════════
   useCalendar
   ═══════════════════════════════════════════════════════════════ */
export function useCalendar(lang = 'ko', country = 'all') {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [status, setStatus] = useState<DataStatus>('loading');
  const [source, setSource] = useState('');

  useEffect(() => {
    fetchCalendar().then(r => {
      setEvents(r.data);
      setStatus(r.data.length > 0 ? r.status : 'mock');
      setSource(r.source);
    });
  }, []);

  const filtered = country === 'all' ? events : events.filter(e => e.country === country);
  return { events: filtered, status, source };
}

/* ═══════════════════════════════════════════════════════════════
   useOrderBook — selected asset + order placement
   ═══════════════════════════════════════════════════════════════ */
export function useOrderBook() {
  const [selectedAsset, setSelectedAsset]   = useState<Asset | null>(null);
  const [showModal,     setShowModal]       = useState(false);
  const [side,          setSide]            = useState<'buy'|'sell'>('buy');
  const [orderStatus,   setOrderStatus]     = useState<'idle'|'loading'|'done'|'error'>('idle');
  const [lastOrder,     setLastOrder]       = useState<OrderResult | null>(null);

  /** Call this from any card/row click */
  const openAsset = useCallback((asset: Asset | any, openTrade = false) => {
    // Normalize to avoid stale closure with _ts injected in parent
    const { _ts, ...clean } = asset as any;
    setSelectedAsset(clean as Asset);
    if (openTrade) {
      setSide('buy');
      setShowModal(true);
    }
  }, []);

  const openBuy  = useCallback(() => { setSide('buy');  setShowModal(true); }, []);
  const openSell = useCallback(() => { setSide('sell'); setShowModal(true); }, []);
  const closeModal = useCallback(() => {
    setShowModal(false);
    setOrderStatus('idle');
  }, []);

  const submitOrder = useCallback(async (req: Omit<OrderRequest, 'assetId'|'nameKr'|'symbol'>) => {
    if (!selectedAsset) return;
    setOrderStatus('loading');
    const r = await placeOrder({
      ...req,
      assetId: selectedAsset.id,
      nameKr:  selectedAsset.nameKr,
      symbol:  selectedAsset.sym || selectedAsset.id,
    });
    if (r.status !== 'error') {
      setLastOrder(r.data);
      setOrderStatus('done');
    } else {
      setOrderStatus('error');
    }
    return r;
  }, [selectedAsset]);

  return {
    selectedAsset, openAsset, openBuy, openSell,
    showModal, closeModal, side, setSide,
    orderStatus, lastOrder, submitOrder,
  };
}

/* ═══════════════════════════════════════════════════════════════
   useTaxCalc — reactive tax calculation
   ═══════════════════════════════════════════════════════════════ */
export function useTaxCalc(input: Partial<TaxInput>) {
  const full: TaxInput = {
    assetType:    input.assetType    ?? 'coin',
    sellPrice:    input.sellPrice    ?? 0,
    buyPrice:     input.buyPrice     ?? 0,
    qty:          input.qty          ?? 0,
    feeRate:      input.feeRate      ?? 0.001,
    exchangeRate: input.exchangeRate ?? 1,
  };
  if (!full.sellPrice || !full.buyPrice || !full.qty) return null;
  return calcTax(full);
}

/* ═══════════════════════════════════════════════════════════════
   useProviderStatus
   ═══════════════════════════════════════════════════════════════ */
export function useProviderStatus() {
  const [providers, setProviders] = useState<Record<string, ProviderStatus>>({});
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    fetchProviderStatus().then(r => {
      setProviders(r.data);
      setLoading(false);
    });
  }, []);

  return { providers, loading };
}

// Re-export types for convenience
export type { PriceItem, CalendarEvent, OrderRequest, OrderResult, TaxInput, TaxResult, DataStatus };
export { calcTax };
