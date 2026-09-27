'use client';
// src/lib/trading/useInstrumentCatalog.ts
//
// **시장별 종목 목록을 한 번 받아 두고, 검색은 그 안에서 한다.**
//
// 타이핑마다 거래소를 부르지 않는다 — 한 글자에 한 번씩 조회를 보내면
// 느리고, 중간에 하나 실패하면 목록이 깜빡이면서 "종목이 사라졌다"처럼
// 보인다.
//
// ★ 실패를 빈 목록으로 두지 않는다
// ────────────────────────────────
// `rows: []` + `state: 'READY'`는 화면에 **"이 시장에 종목이 없다"**로
// 그려진다. 그건 거짓이다. 실패는 `ERROR`와 사유로 남고, 화면이 다시
// 시도할 수 있게 `reload`를 준다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TradingMarketId } from './marketTabs';
import { catalogOpenFor, type CatalogInstrument } from './instrumentCatalog';

export interface InstrumentCatalog {
  state: 'IDLE' | 'LOADING' | 'READY' | 'ERROR' | 'CLOSED';
  rows: CatalogInstrument[];
  /** 못 읽었거나 안 열린 이유. 정상이면 null */
  reason: string | null;
  asOf: number | null;
  reload: () => void;
}

/** 시장별로 한 번만 받아 둔다. 탭을 왕복해도 다시 부르지 않는다 */
const cache = new Map<string, { rows: CatalogInstrument[]; asOf: number }>();

/** 시험이 캐시를 비운다 — 제품 경로에서는 부르지 않는다 */
export function __clearCatalogCache() { cache.clear(); }

export function useInstrumentCatalog(
  market: TradingMarketId, enabled = true,
): InstrumentCatalog {
  const open = catalogOpenFor(market);
  const [state, setState] = useState<InstrumentCatalog['state']>('IDLE');
  const [rows, setRows] = useState<CatalogInstrument[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const reload = useCallback(() => setTick(n => n + 1), []);

  useEffect(() => {
    if (!enabled) { setState('IDLE'); return; }
    if (!open.open) {
      // 목록 권위가 없는 시장이다. 로딩처럼 보이게 두지 않는다.
      setState('CLOSED'); setRows([]); setReason(open.reason); setAsOf(null);
      return;
    }

    const hit = cache.get(market);
    if (hit && tick === 0) {
      setState('READY'); setRows(hit.rows); setReason(null); setAsOf(hit.asOf);
      return;
    }

    let cancelled = false;
    setState('LOADING'); setReason(null);
    (async () => {
      try {
        const r = await fetch(`/api/market/instruments?market=${encodeURIComponent(market)}`);
        const d = await r.json().catch(() => null);
        if (cancelled || !alive.current) return;
        if (!r.ok || !d?.ok || !Array.isArray(d.instruments)) {
          setState('ERROR'); setRows([]); setAsOf(null);
          setReason(String(d?.message || `${market} 종목 목록을 읽지 못했습니다`));
          return;
        }
        cache.set(market, { rows: d.instruments, asOf: Number(d.asOf) || Date.now() });
        setState('READY'); setRows(d.instruments);
        setAsOf(Number(d.asOf) || Date.now()); setReason(null);
      } catch (e: any) {
        if (cancelled || !alive.current) return;
        setState('ERROR'); setRows([]); setAsOf(null);
        setReason(`${market} 종목 목록을 읽지 못했습니다 (${String(e?.message || e).slice(0, 120)})`);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, enabled, open.open, tick]);

  return { state, rows, reason, asOf, reload };
}
