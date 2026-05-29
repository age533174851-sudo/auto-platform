'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { T } from '@/lib/constants';
import { ASSETS, TYPE_LABEL, TYPE_COLOR } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Logo } from './SharedUI';
import { cvt, fmtPct } from '@/lib/utils';

const RECENT_KEY = 'tg_recent_search_v1';
const CATEGORIES: Array<{ id: string; label: string; types: string[] }> = [
  { id:'all',     label:'전체',   types:[] },
  { id:'coin',    label:'코인',   types:['coin'] },
  { id:'stock',   label:'미국주식', types:['stock'] },
  { id:'krstock', label:'국내주식', types:['krstock'] },
  { id:'etf',     label:'ETF',    types:['etf'] },
  { id:'commodity', label:'원자재', types:['commodity'] },
  { id:'forex',   label:'환율',   types:['forex'] },
];

export default function SearchPage({
  prices,
  currency,
  onOpenAsset,
}: {
  prices?: Asset[];
  currency: string;
  onOpenAsset?: (a: any, dest?: string) => void;
}) {
  const [query, setQuery]       = useState('');
  const [cat,   setCat]         = useState('all');
  const [recent, setRecent]     = useState<string[]>([]);

  // Load recent searches
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      setRecent(Array.isArray(arr) ? arr : []);
    } catch { setRecent([]); }
  }, []);

  const saveRecent = useCallback((q: string) => {
    if (!q.trim()) return;
    setRecent(prev => {
      const next = [q, ...prev.filter(x => x !== q)].slice(0, 10);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const clearRecent = useCallback(() => {
    setRecent([]);
    try { localStorage.removeItem(RECENT_KEY); } catch {}
  }, []);

  // Source data: live prices if available, else ASSETS
  const source = useMemo(() => {
    const src = Array.isArray(prices) && prices.length > 0 ? prices : ASSETS;
    return Array.isArray(src) ? src : [];
  }, [prices]);

  // Filter results
  const results = useMemo(() => {
    let list = source;
    const types = CATEGORIES.find(c => c.id === cat)?.types ?? [];
    if (types.length > 0) {
      list = list.filter(a => types.includes(a.t));
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(a =>
        (a.nameKr || '').toLowerCase().includes(q) ||
        (a.name   || '').toLowerCase().includes(q) ||
        (a.id     || '').toLowerCase().includes(q) ||
        (a.sym    || '').toLowerCase().includes(q)
      );
    }
    return list.slice(0, 50);
  }, [source, query, cat]);

  const handleSelect = useCallback((a: Asset) => {
    saveRecent(query || a.nameKr || a.id);
    onOpenAsset?.(a, 'trading');
  }, [query, saveRecent, onOpenAsset]);

  return (
    <div style={{ paddingBottom: 100 }}>
      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ color: T.txt, fontWeight: 900, fontSize: 17, marginBottom: 4 }}>
          🔍 통합 검색
        </div>
        <div style={{ color: T.muted, fontSize: 10 }}>
          코인 · 주식 · ETF · 원자재 · 환율 통합 검색
        </div>
      </div>

      {/* Search input */}
      <div style={{ display:'flex', alignItems:'center', gap: 10,
        background: T.card, border:`1px solid ${T.border}`,
        borderRadius: 14, padding:'12px 14px', marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>🔍</span>
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="BTC, 삼성전자, AAPL, SOXL…"
          style={{ background:'transparent', border:'none', outline:'none',
            color: T.txt, fontSize: 14, flex: 1 }}
        />
        {query && (
          <button type="button" onClick={() => setQuery('')}
            style={{ background:'none', border:'none', color: T.muted,
              cursor:'pointer', fontSize: 16, padding: 0 }}>
            ✕
          </button>
        )}
      </div>

      {/* Category pills */}
      <div style={{ display:'flex', gap: 6, overflowX:'auto', marginBottom: 12, paddingBottom: 4 }}>
        {CATEGORIES.map(c => (
          <button key={c.id} type="button" onClick={() => setCat(c.id)}
            style={{ flexShrink: 0, padding:'6px 14px', minHeight: 34,
              background: cat === c.id ? T.acg : T.alt,
              border:`1px solid ${cat === c.id ? T.acl : T.border}`,
              color: cat === c.id ? T.acl : T.muted,
              borderRadius: 20, fontSize: 11, fontWeight: 700, cursor:'pointer' }}>
            {c.label}
          </button>
        ))}
      </div>

      {/* Recent searches */}
      {!query && recent.length > 0 && (
        <Card style={{ marginBottom: 10 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 8 }}>
            <div style={{ color: T.muted, fontSize: 11, fontWeight: 700 }}>최근 검색</div>
            <button type="button" onClick={clearRecent}
              style={{ background:'none', border:'none', color: T.muted,
                fontSize: 10, cursor:'pointer' }}>
              지우기
            </button>
          </div>
          <div style={{ display:'flex', gap: 6, flexWrap:'wrap' }}>
            {recent.map(r => (
              <button key={r} type="button" onClick={() => setQuery(r)}
                style={{ background: T.alt, color: T.sub,
                  border:`1px solid ${T.border}`, borderRadius: 16,
                  padding:'5px 12px', fontSize: 11, fontWeight: 600, cursor:'pointer',
                  minHeight: 32 }}>
                🕐 {r}
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Results */}
      <Card style={{ overflow:'hidden', padding: 0 }}>
        <div style={{ padding:'10px 14px', borderBottom:`1px solid ${T.border}`,
          color: T.muted, fontSize: 10, fontWeight: 700 }}>
          검색 결과 {results.length}건
        </div>
        {results.length === 0 ? (
          <div style={{ padding:'40px 0', textAlign:'center', color: T.muted, fontSize: 13 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
            {query ? `"${query}" 검색 결과 없음` : '검색어를 입력하세요'}
          </div>
        ) : results.map((a, i) => (
          <div
            key={a.id + i}
            onClick={() => handleSelect(a)}
            role="button"
            tabIndex={0}
            style={{ display:'grid', gridTemplateColumns:'1fr 90px',
              padding:'12px 14px', cursor:'pointer',
              borderBottom: i < results.length - 1 ? `1px solid ${T.border}` : 'none',
              alignItems:'center' }}>
            <div style={{ display:'flex', alignItems:'center', gap: 10, minWidth: 0 }}>
              <Logo id={a.id} size={36} clr={a.clr} name={a.nameKr} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ color: T.txt, fontWeight: 700, fontSize: 13,
                  whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                  {a.nameKr}
                </div>
                <div style={{ display:'flex', gap: 6, marginTop: 2, alignItems:'center' }}>
                  <span style={{ color: T.muted, fontSize: 10, fontFamily:'monospace' }}>
                    {a.sym || a.id}
                  </span>
                  <span style={{ background: (TYPE_COLOR[a.t] || T.muted) + '20',
                    color: TYPE_COLOR[a.t] || T.muted,
                    borderRadius: 4, padding:'1px 6px', fontSize: 9, fontWeight: 700 }}>
                    {TYPE_LABEL[a.t] || a.t}
                  </span>
                </div>
              </div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, fontFamily:'monospace' }}>
                {cvt(a.p || 0, currency)}
              </div>
              <div style={{ color: (a.c || 0) >= 0 ? T.grn : T.red,
                fontSize: 11, fontWeight: 700 }}>
                {fmtPct(a.c || 0)}
              </div>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
