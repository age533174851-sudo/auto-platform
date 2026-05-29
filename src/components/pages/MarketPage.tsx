'use client';
import React, { useState, useEffect, useMemo } from 'react';
import { T } from '@/lib/constants';
import { cvt, fmtPct } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR } from '@/data/assets';
import type { Asset } from '@/types';
import {
  Card, Logo, Spark, Pill, Bdg,
  GlobalSearch, getKrName, resolveTVSym, InlineTVChart,
} from './SharedUI';
import { useLogoMap } from '@/lib/hooks/useLogoMap';

/* ─────────────────────────────────────────────────────────────
   MarketPage
───────────────────────────────────────────────────────────── */
function MarketPage({
  prices,
  onNav,
  currency,
  onOpenAsset,
  onOpenPnL,
}: {
  prices: Asset[];
  onNav: (t: string) => void;
  currency: string;
  onOpenAsset?: (a: any, dest?: string) => void;
  onOpenPnL?:   (a: any) => void;
}) {
  /* ── state ── */
  const [filter,     setFilter]     = useState('전체');
  const [search,     setSearch]     = useState('');
  const [sort,       setSort]       = useState('change');
  const [mktTab,     setMktTab]     = useState<'list'|'gainers'|'losers'|'trending'>('list');
  const [gainers,    setGainers]    = useState<any[]>([]);
  const [losers,     setLosers]     = useState<any[]>([]);
  const [trending,   setTrending]   = useState<any[]>([]);
  const [mktLoading, setMktLoading] = useState(false);
  const [selAsset,   setSelAsset]   = useState<Asset | null>(null);
  const [tradeModal, setTradeModal] = useState<{ side: 'buy' | 'sell'; asset: Asset } | null>(null);
  const [allCoins,   setAllCoins]   = useState<Asset[]>([]);
  const [coinMeta,   setCoinMeta]   = useState<{ count: number; total: number; status: string } | null>(null);
  const [coinsLoading, setCoinsLoading] = useState(false);

  /* ── gainers / losers / trending fetch with fallback ── */
  useEffect(() => {
    if (mktTab === 'list') return;
    setMktLoading(true);
    const src       = prices.length > 0 ? prices : ASSETS;
    const sorted    = [...src].filter(a => Number.isFinite(a.c));
    const byGain    = [...sorted].sort((a, b) => b.c - a.c);
    const byLoss    = [...sorted].sort((a, b) => a.c - b.c);
    const byVol     = [...sorted].sort((a, b) => Math.abs(b.c) - Math.abs(a.c));

    fetch(`/api/prices?action=${mktTab}`)
      .then(r => r.json())
      .then(d => {
        const results: any[] = d.results || [];
        if (results.length > 0) {
          const mapped = results.slice(0, 20);
          if (mktTab === 'gainers')  setGainers(mapped);
          else if (mktTab === 'losers')   setLosers(mapped);
          else if (mktTab === 'trending') setTrending(mapped);
        } else {
          // No API data → compute from prices
          if (mktTab === 'gainers')  setGainers(byGain.slice(0, 20));
          else if (mktTab === 'losers')   setLosers(byLoss.slice(0, 20));
          else if (mktTab === 'trending') setTrending(byVol.slice(0, 20));
        }
      })
      .catch(() => {
        if (mktTab === 'gainers')  setGainers(byGain.slice(0, 20));
        else if (mktTab === 'losers')   setLosers(byLoss.slice(0, 20));
        else if (mktTab === 'trending') setTrending(byVol.slice(0, 20));
      })
      .finally(() => setMktLoading(false));
  }, [mktTab, prices]);

  // 코인 필터 선택 시 Binance 전체 USDT 페어 로드 (한 번만)
  useEffect(() => {
    if (filter !== '코인' || allCoins.length > 0 || coinsLoading) return;
    setCoinsLoading(true);
    fetch('/api/prices?action=all_crypto&limit=300')
      .then(r => r.json())
      .then(d => {
        const results = Array.isArray(d.results) ? d.results : [];
        const mapped: Asset[] = results.map((c: any) => ({
          id:     c.symbol,
          sym:    `${c.symbol}/USDT`,
          nameKr: c.symbol,
          name:   c.symbol,
          p:      c.price || 0,
          c:      c.change24h || 0,
          v:      c.volume24h ? `${(c.volume24h / 1e8).toFixed(1)}억` : '-',
          t:      'coin' as const,
          clr:    '#F7931A',
        }));
        setAllCoins(mapped);
        setCoinMeta({ count: d.count || mapped.length, total: d.total || 0, status: d.status || 'live' });
      })
      .catch(() => setCoinMeta({ count: 0, total: 0, status: 'error' }))
      .finally(() => setCoinsLoading(false));
  }, [filter, allCoins.length, coinsLoading]);

  /* ── list filter / sort ── */
  const TYPE_MAP: Record<string, string> = {
    코인:'coin', 지수:'index', 미국주식:'stock', 국내주식:'krstock',
    일본주식:'jpstock', 중국주식:'cnstock', 유럽주식:'eustock',
    ETF:'etf', 원자재:'commodity', 환율:'forex',
  };

  let list = filter === '전체' ? prices
    : filter === '코인' && allCoins.length > 0 ? allCoins
    : prices.filter(a => a.t === TYPE_MAP[filter]);
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(a =>
      a.nameKr.includes(search) ||
      a.name.toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q) ||
      (a.sym || '').toLowerCase().includes(q)
    );
  }
  if (sort === 'change') list = [...list].sort((a, b) => b.c - a.c);
  if (sort === 'price')  list = [...list].sort((a, b) => b.p - a.p);

  // 화면에 나오는 모든 심볼을 모아서 batch로 logo URL 가져오기
  const symbolsForLogo = useMemo(() => {
    const set = new Set<string>();
    // 메인 리스트 (보이는 상위 50개로 제한 — 안전)
    for (const a of list.slice(0, 50)) {
      if (a.sym) set.add(a.sym.toUpperCase());
      if (a.id)  set.add(a.id.toUpperCase());
    }
    // gainers / losers / trending 일부도 미리 로드
    for (const arr of [gainers, losers, trending]) {
      if (Array.isArray(arr)) {
        for (const r of arr.slice(0, 10)) {
          if (r?.sym) set.add(String(r.sym).toUpperCase());
        }
      }
    }
    return Array.from(set);
  }, [list, gainers, losers, trending]);
  const logoMap = useLogoMap(symbolsForLogo);

  /* ── open asset detail (always uses the clicked asset's id) ── */
  const handleOpenAsset = (asset: Asset | any) => {
    if (onOpenAsset) {
      // Pass asset with _ts so page.tsx forces a re-render
      onOpenAsset({ ...asset, _ts: Date.now() }, 'trading');
    } else {
      setSelAsset(asset as Asset);
    }
  };

  /* ── normalise gainers/losers/trending row → common shape ── */
  const normaliseRow = (a: any) => ({
    sym:    a.symbol  || a.id    || a.sym || '?',
    price:  a.price   ?? a.p     ?? 0,
    change: a.change24h ?? a.c   ?? 0,
    nameKr: a.nameKr  || getKrName(a.symbol || a.id || '') || a.symbol || a.id || '?',
    clr:    a.clr     || (( a.change24h ?? a.c ?? 0) >= 0 ? T.grn : T.red),
    raw:    a,
  });

  /* ─────────────────────── JSX ─────────────────────── */
  return (
    <div>

      {/* ── Tab bar ── */}
      <div style={{ display:'flex', gap:5, marginBottom:10, overflowX:'auto' }}>
        {([ ['list','📋 종목'], ['gainers','🚀 급등'], ['losers','📉 급락'], ['trending','🔥 트렌딩'] ] as const)
          .map(([id, label]) => (
            <button
              key={id}
              onClick={() => setMktTab(id)}
              style={{
                flexShrink:0, padding:'6px 12px',
                background: mktTab === id ? T.acg : 'transparent',
                color:      mktTab === id ? T.acl : T.muted,
                border:    `1px solid ${mktTab === id ? T.acl : T.border}`,
                borderRadius:20, fontSize:11, fontWeight:700, cursor:'pointer',
              }}
            >
              {label}
            </button>
          ))}
      </div>

      {/* ── Gainers / Losers / Trending ── */}
      {mktTab !== 'list' && (
        <div>
          {mktLoading ? (
            <div style={{ textAlign:'center', padding:'30px 0', color:T.muted, fontSize:12 }}>
              <div style={{ fontSize:24, marginBottom:6 }}>⏳</div>
              데이터 로딩 중…
            </div>
          ) : (
            <Card style={{ overflow:'hidden' }}>
              <div style={{
                padding:'9px 14px', borderBottom:`1px solid ${T.border}`,
                display:'flex', justifyContent:'space-between',
                color:T.muted, fontSize:10, fontWeight:700,
              }}>
                <span>종목</span>
                <span>
                  {mktTab === 'gainers' ? '🚀 상승률' : mktTab === 'losers' ? '📉 하락률' : '🔥 거래량'}
                </span>
              </div>

              {(mktTab === 'gainers' ? gainers : mktTab === 'losers' ? losers : trending)
                .map((rawRow: any, i: number) => {
                  const row = normaliseRow(rawRow);
                  const up  = row.change >= 0;
                  const assetForNav: Asset = {
                    id:     row.sym,
                    nameKr: row.nameKr,
                    name:   row.nameKr,
                    sym:    row.sym,
                    p:      row.price,
                    c:      row.change,
                    v:      '-',
                    t:      rawRow.t || 'coin',
                    clr:    row.clr,
                  };
                  return (
                    <div
                      key={row.sym + i}
                      onClick={() => handleOpenAsset(assetForNav)}
                      style={{
                        display:'flex', justifyContent:'space-between',
                        alignItems:'center', padding:'10px 14px',
                        borderBottom:`1px solid ${T.border}`, cursor:'pointer',
                      }}
                    >
                      <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                        <span style={{ color:T.muted, fontSize:10, width:18 }}>{i + 1}</span>
                        <Logo id={row.sym} size={30} clr={row.clr} name={row.nameKr} logoUrl={logoMap[String(row.sym || '').toUpperCase()]} />
                        <div>
                          <div style={{ color:T.txt, fontWeight:700, fontSize:12 }}>{row.nameKr}</div>
                          <div style={{ color:T.muted, fontSize:9, fontFamily:'monospace' }}>{row.sym}</div>
                        </div>
                      </div>
                      <div style={{ textAlign:'right' }}>
                        <div style={{ color:T.txt, fontSize:11, fontWeight:700, fontFamily:'monospace' }}>
                          {cvt(row.price, currency)}
                        </div>
                        <div style={{ color: up ? T.grn : T.red, fontSize:10, fontWeight:700 }}>
                          {up ? '▲' : '▼'}{Math.abs(row.change).toFixed(2)}%
                        </div>
                      </div>
                    </div>
                  );
                })}

              {(mktTab === 'gainers' ? gainers : mktTab === 'losers' ? losers : trending).length === 0 && (
                <div style={{ padding:'24px 0', textAlign:'center', color:T.muted, fontSize:12 }}>
                  탭을 다시 눌러 보세요
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      {/* ── Main list ── */}
      {mktTab === 'list' && (
        <>
          <GlobalSearch
            onSelect={(id, nameKr, clr) =>
              handleOpenAsset({ id, nameKr, name: nameKr, sym: id, p: 0, c: 0, v: '-', t: 'stock', clr })
            }
            currency={currency}
          />

          {/* Search input */}
          <div style={{
            display:'flex', alignItems:'center', gap:10,
            background:T.card, border:`1px solid ${T.border}`,
            borderRadius:14, padding:'10px 14px', marginBottom:12,
          }}>
            <span>🔍</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="종목 검색 (BTC, 삼성, AAPL…)"
              style={{ background:'transparent', border:'none', outline:'none', color:T.txt, fontSize:13, flex:1 }}
            />
            {search && (
              <button onClick={() => setSearch('')} style={{ background:'none', border:'none', color:T.muted, cursor:'pointer' }}>
                ✕
              </button>
            )}
          </div>

          {/* Filter pills */}
          <div style={{ display:'flex', gap:6, overflowX:'auto', paddingBottom:8, marginBottom:10 }}>
            {['전체','코인','지수','미국주식','국내주식','일본주식','중국주식','유럽주식','ETF','원자재','환율']
              .map(t => (
                <Pill key={t} ch={t} active={filter === t} onClick={() => setFilter(t)} />
              ))}
          </div>

          {/* Sort pills */}
          <div style={{ display:'flex', gap:6, marginBottom:8 }}>
            <Pill ch="등락률순" active={sort === 'change'} onClick={() => setSort('change')} color={T.grn} />
            <Pill ch="가격순"   active={sort === 'price'}  onClick={() => setSort('price')}  color={T.ylw} />
          </div>

          {/* 종목 수 + 데이터 소스 배지 */}
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12, flexWrap:'wrap' }}>
            <span style={{ color:T.muted, fontSize:11, fontWeight:700 }}>
              {coinsLoading && filter === '코인' ? '코인 불러오는 중…' : `${list.length.toLocaleString('ko-KR')}개 종목`}
            </span>
            {filter === '코인' && coinMeta && (
              <>
                <span style={{
                  padding:'2px 8px', borderRadius:5, fontSize:9, fontWeight:800,
                  background: coinMeta.status === 'live' ? T.grn+'20' : T.muted+'20',
                  color:      coinMeta.status === 'live' ? T.grn : T.muted,
                  display:'inline-flex', alignItems:'center', gap:3,
                }}>
                  <span style={{ width:5, height:5, borderRadius:'50%', background: coinMeta.status === 'live' ? T.grn : T.muted, display:'inline-block' }}/>
                  {coinMeta.status === 'live' ? 'Binance 실시간' : '연결 실패'}
                </span>
                {coinMeta.total > 0 && (
                  <span style={{ color:T.muted, fontSize:9 }}>
                    전체 {coinMeta.total.toLocaleString('ko-KR')}개 중 거래량 상위
                  </span>
                )}
              </>
            )}
            {filter !== '코인' && filter !== '전체' && (
              <span style={{
                padding:'2px 8px', borderRadius:5, fontSize:9, fontWeight:800,
                background: T.ylw+'20', color: T.ylw,
              }}>
                대표 종목 · API 키 필요
              </span>
            )}
          </div>

          {/* Table header */}
          <Card style={{ overflow:'hidden' }}>
            <div style={{
              display:'grid', gridTemplateColumns:'1fr 60px 95px',
              padding:'9px 14px', borderBottom:`1px solid ${T.border}`,
              color:T.muted, fontSize:10, fontWeight:700, textTransform:'uppercase',
            }}>
              <span>종목</span>
              <span style={{ textAlign:'center' }}>차트</span>
              <span style={{ textAlign:'right' }}>가격/등락</span>
            </div>

            {list.length === 0 ? (
              <div style={{ padding:'36px 0', textAlign:'center', color:T.muted }}>
                <div style={{ fontSize:28, marginBottom:6 }}>🔍</div>
                <div>검색 결과 없음</div>
              </div>
            ) : (Array.isArray(list)?list:[]).map((a, i) => (
              <div
                key={a.id}
                onClick={() => handleOpenAsset(a)}
                style={{
                  display:'grid', gridTemplateColumns:'1fr 60px 95px',
                  padding:'11px 14px',
                  borderBottom: i < list.length - 1 ? `1px solid ${T.border}` : 'none',
                  alignItems:'center', cursor:'pointer',
                }}
              >
                <div style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}>
                  <Logo id={a.id} size={34} clr={a.clr} name={a.nameKr} logoUrl={logoMap[String(a.sym || a.id).toUpperCase()] || logoMap[String(a.id).toUpperCase()]} />
                  <div style={{ minWidth:0 }}>
                    <div style={{ color:T.txt, fontWeight:600, fontSize:12,
                      overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {a.nameKr}
                    </div>
                    <div style={{ display:'flex', gap:4, marginTop:2 }}>
                      <span style={{ color:T.muted, fontSize:10 }}>{a.sym}</span>
                      <Bdg c={TYPE_COLOR[a.t]} ch={TYPE_LABEL[a.t]} sm />
                    </div>
                  </div>
                </div>
                <div style={{ display:'flex', justifyContent:'center' }}>
                  <Spark pos={a.c >= 0} w={52} h={24} />
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ color:T.txt, fontWeight:700, fontSize:11, fontFamily:'monospace' }}>
                    {cvt(a.p, currency)}
                  </div>
                  <div style={{ color: a.c >= 0 ? T.grn : T.red, fontSize:11, fontWeight:700 }}>
                    {fmtPct(a.c)}
                  </div>
                </div>
              </div>
            ))}
          </Card>

          <div style={{ color:T.muted, fontSize:10, textAlign:'center', marginTop:8 }}>
            총 {list.length}개 종목
          </div>
        </>
      )}

      {/* ── Asset detail bottom sheet ── */}
      {selAsset && (
        <>
          <div
            style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.7)', zIndex:100 }}
            onClick={() => setSelAsset(null)}
          />
          <div
            style={{
              position:'fixed', zIndex:101, inset:'auto 0 0 0',
              background:T.bg, borderRadius:'20px 20px 0 0',
              overflowY:'auto',
              padding:`16px 14px calc(env(safe-area-inset-bottom, 20px) + 20px)`,
              maxWidth:480, margin:'0 auto',
              maxHeight:'92dvh',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <Logo id={selAsset.id} size={44} clr={selAsset.clr} name={selAsset.nameKr} logoUrl={logoMap[String(selAsset.sym || selAsset.id).toUpperCase()] || logoMap[String(selAsset.id).toUpperCase()]} />
                <div>
                  <div style={{ color:T.txt, fontWeight:900, fontSize:16 }}>{selAsset.nameKr}</div>
                  <div style={{ color:T.muted, fontSize:11 }}>{selAsset.sym} · {TYPE_LABEL[selAsset.t]}</div>
                </div>
              </div>
              <button
                onClick={() => setSelAsset(null)}
                style={{ background:'transparent', border:`1px solid ${T.border}`, borderRadius:8, color:T.muted, padding:'5px 10px', cursor:'pointer', fontSize:12 }}
              >
                닫기
              </button>
            </div>

            {/* Price */}
            <div style={{ marginBottom:14 }}>
              <div style={{ color:T.txt, fontSize:26, fontWeight:900, fontFamily:'monospace' }}>
                {cvt(selAsset.p, currency)}
              </div>
              <div style={{ color: selAsset.c >= 0 ? T.grn : T.red, fontWeight:800, fontSize:15, marginTop:4 }}>
                {selAsset.c >= 0 ? '▲' : '▼'} {Math.abs(selAsset.c).toFixed(2)}%
              </div>
            </div>

            {/* Chart */}
            <div style={{ height:240, borderRadius:12, overflow:'hidden', marginBottom:14 }}>
              <InlineTVChart
                symbol={resolveTVSym(selAsset.sym || selAsset.id)}
                chartType="1"
                interval="60"
              />
            </div>

            {/* Buy / Sell + PnL */}
            <div style={{ display:'flex', gap:8, marginBottom:8 }}>
              <button
                type="button"
                onClick={() => {
                  setSelAsset(null);
                  if (onOpenAsset) onOpenAsset({ ...selAsset, _ts: Date.now() }, 'trading');
                }}
                style={{ flex:1, padding:'13px', background:T.grn, color:'#fff', border:'none', borderRadius:12, fontWeight:800, fontSize:14, cursor:'pointer', minHeight:48 }}
              >
                📈 매수
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelAsset(null);
                  if (onOpenAsset) onOpenAsset({ ...selAsset, _ts: Date.now() }, 'trading');
                }}
                style={{ flex:1, padding:'13px', background:T.red, color:'#fff', border:'none', borderRadius:12, fontWeight:800, fontSize:14, cursor:'pointer', minHeight:48 }}
              >
                📉 매도
              </button>
            </div>
            <button
              type="button"
              disabled={!onOpenPnL}
              onClick={() => {
                if (!onOpenPnL || !selAsset) return;
                setSelAsset(null);
                onOpenPnL(selAsset);
              }}
              style={{ width:'100%', padding:'12px', background:T.acg, color:T.acl,
                border:`1px solid ${T.acl}40`, borderRadius:12, fontWeight:700,
                fontSize:13, cursor:onOpenPnL?'pointer':'not-allowed', minHeight:46,
                opacity:onOpenPnL?1:0.5 }}
            >
              💹 수익 계산하기
            </button>
          </div>
        </>
      )}

    </div>
  );
}

export default MarketPage;
