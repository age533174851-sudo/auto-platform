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
       :                 { text:'…',     color:'var(--t-muted)' };
}

/* ══════════════════════════════════════════════════════════════
   useLivePrices — /api/prices를 받아오고, 그 사이를 보간한다
   ══════════════════════════════════════════════════════════════
   이전에는 action='coin'을 불렀다. 그런데 그 응답은 **코인 하나짜리
   객체**라 fetchPrices가 배열로 못 읽고 항상 빈 목록을 돌려줌다.
   결과적으로 화면의 모든 종목 가격이 ASSETS 기본값을 난수보행한
   값이었다. 상단 MOCK 배지만이 유일한 단서였다.
   all_crypto는 {results:[...]} 형태라 fetchPrices가 그대로 읽는다.
   (데이터 출처 표시를 붙이다가 드러난 문제다.) */
export function useLivePrices(intervalMs = 5000) {
  const [prices,    setPrices]    = useState<Asset[]>(ASSETS);
  const [status,    setStatus]    = useState<DataStatus>('loading');
  const [source,    setSource]    = useState('initialising');
  const [lastRealAt, setLastRealAt] = useState<number | null>(null);
  /**
   * **실제 시세를 받은 종목의 id.**
   *
   * ASSETS에는 하드코딩된 기본 가격이 들어 있다(BTC 60,212 같은 것).
   * 그 값을 그대로 그리면 시세를 못 받았을 때도 그럴듯한 숫자가 뜬다 —
   * 실제로 매매 화면은 63,093인데 왓치리스트는 60,212를 보여주고 있었다.
   *
   * 여기 없는 종목의 가격은 **화면이 '—'로 그려야 한다.** 모르는 것을
   * 숫자로 그리면 그게 시세인 줄 안다.
   */
  const [liveIds, setLiveIds] = useState<Set<string>>(() => new Set());

  const merge = useCallback((all: PriceItem[]) => {
    // **지어낸 값은 받지 않는다.** /api/prices는 실데이터에 mock 시드를
    // 섞어서 준다 — 거래소가 막혔을 때도 응답에 숫자가 가득하다.
    // 그 숫자를 그리면 화면은 멀쩡한데 값이 전부 가짜다.
    const live = all.filter(l => l.source !== 'mock');
    if (!live.length) return;
    const got = new Set<string>();
    setPrices(prev => prev.map(a => {
      const match = live.find(l =>
        l.id === a.id || l.symbol === a.id ||
        l.symbol.toUpperCase() === a.sym?.replace('USDT','').toUpperCase()
      );
      if (!match) return a;
      got.add(a.id);
      return { ...a, p: match.price, c: match.change24h, v: String(match.volume) };
    }));
    setLiveIds(prev => {
      // 이번에 못 받은 종목을 지우지 않는다. 한 번 실패했다고 값이
      // 사라지면 화면이 깜빡인다 — 오래된 값이라는 것은 lastRealAt이 말한다.
      const next = new Set(prev);
      got.forEach(id => next.add(id));
      return next;
    });
  }, []);

  const load = useCallback(() => {
    return fetchPrices('all_crypto', 'limit=200').then(r => {
      const real = (r.data || []).filter(l => l.source !== 'mock');
      merge(r.data);
      // 줄이 있다고 live가 아니다 — 전부 mock 시드일 수 있다.
      setStatus(real.length > 0 ? 'live' : 'mock');
      setSource(real.length > 0 ? r.source : 'mock');
      if (real.length > 0) setLastRealAt(Date.now());
    }).catch(() => { setStatus('mock'); });
  }, [merge]);

  useEffect(() => { load(); }, [load]);

  // **난수보행을 걷어냈다.**
  //
  // 예전에는 12초마다 실데이터를 받고 **그 사이 세 번은 Math.random()으로
  // 값을 흔들었다.** 화면이 살아 있어 보이게 하려던 것인데, 결과는 네 번 중
  // 세 번이 지어낸 가격이었다. 상단 배지는 계속 LIVE였다.
  //
  // 거래 앱에서 지어낸 가격을 그리는 것은 그 자체로 사고다. 사용자가 그 값을
  // 보고 주문을 낸다. 화면이 덜 부드러운 것이 훨씬 낫다 — 대신 자주 받는다.
  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      // 탭이 숨겨져 있으면 받지 않는다. 배터리와 레이트리밋 둘 다.
      if (typeof document !== 'undefined' && document.hidden) return;
      load();
    };
    const t = setInterval(tick, Math.max(2000, intervalMs));
    // 돌아왔을 때 즉시 한 번. 오래된 값을 그대로 두면 몇 초 동안
    // 지난 가격을 보고 주문할 수 있다.
    const onVis = () => {
      if (typeof document !== 'undefined' && !document.hidden) load();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      clearInterval(t);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, [intervalMs, load]);

  return {
    prices, status, source,
    /** 마지막으로 실데이터를 받은 시각. null이면 아직 한 번도 못 받았다 */
    lastRealAt,
    /** 실제 시세를 받은 종목. 여기 없으면 화면이 '—'로 그려야 한다 */
    liveIds,
    /**
     * 더 이상 값을 지어내지 않으므로 항상 0이다.
     * 이 값을 읽는 화면들이 있어 모양만 남긴다.
     */
    simSteps: 0,
  };
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
