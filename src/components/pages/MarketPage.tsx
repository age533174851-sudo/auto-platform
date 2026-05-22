'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Dot, Spark, Pill, Bdg, Toggle, AreaChart, WorldClock, Heatmap,
         TradingChart, Logo, getBgColor, resolveLogoUrl, getKrName, cleanName, resolveTVSym,
         DonutChart, MiniBar, GlobalSearch, getLeverageRec,
         LiquidationCalc, PositionSizer, RiskDashboard, InlineTVChart} from './SharedUI';
import { useMarketLists, statusLabel } from '@/lib/api/hooks';


function MarketPage({prices,onNav,currency,onOpenAsset}:{prices:Asset[];onNav:(t:string)=>void;currency:string;onOpenAsset?:(a:any,dest?:string)=>void}) {
  const [filter,setFilter]       = useState('전체');
  const [search,setSearch]       = useState('');
  const [sort,setSort]           = useState('change');
  const [selAsset,setSelAsset]   = useState<Asset|null>(null);
  const [sel,setSel]             = useState<Asset|null>(null);
  const [mktTab,setMktTab]       = useState<'list'|'gainers'|'losers'|'trending'>('list');
  // Market lists via hook
  const isListTab = mktTab !== 'list';

  // Compute gainers/losers/trending from live prices (fallback to ASSETS)
  useEffect(()=>{
    if(mktTab==='list') return;
    setMktLoading(true);
    const src = prices.length > 0 ? prices : ASSETS;
    const withChange = src.filter(a => typeof a.c === 'number' && !isNaN(a.c));
    
    // Try API first, fallback to computed from prices
    fetch(`/api/prices?action=${mktTab}`)
      .then(r=>r.json())
      .then(d=>{
        const results=(d.results||[]);
        if(results.length>0){
          if(mktTab==='gainers') setGainers(results.slice(0,20));
          else if(mktTab==='losers') setLosers(results.slice(0,20));
          else if(mktTab==='trending') setTrending(results.slice(0,20));
        } else {
          // Fallback: compute from prices prop
          if(mktTab==='gainers') setGainers([...withChange].sort((a,b)=>b.c-a.c).slice(0,20));
          else if(mktTab==='losers') setLosers([...withChange].sort((a,b)=>a.c-b.c).slice(0,20));
          else if(mktTab==='trending') setTrending([...withChange].sort((a,b)=>Math.abs(b.c)-Math.abs(a.c)).slice(0,20));
        }
      })
      .catch(()=>{
        // Full fallback from prices
        if(mktTab==='gainers') setGainers([...withChange].sort((a,b)=>b.c-a.c).slice(0,20));
        else if(mktTab==='losers') setLosers([...withChange].sort((a,b)=>a.c-b.c).slice(0,20));
        else setTrending([...withChange].sort((a,b)=>Math.abs(b.c)-Math.abs(a.c)).slice(0,20));
      })
      .finally(()=>setMktLoading(false));
  },[mktTab,prices]);
  const typeMap:Record<string,string>={코인:'coin',지수:'index',미국주식:'stock',국내주식:'krstock',일본주식:'jpstock',중국주식:'cnstock',유럽주식:'eustock',ETF:'etf',원자재:'commodity',환율:'forex'};
  let list=filter==='전체'?prices:prices.filter(a=>a.t===typeMap[filter]);
  if(search){const q=search.toLowerCase();list=list.filter(a=>a.nameKr.includes(search)||a.name.toLowerCase().includes(q)||a.id.toLowerCase().includes(q)||a.sym.toLowerCase().includes(q));}
  if(sort==='change')list=[...list].sort((a,b)=>b.c-a.c);
  if(sort==='price')list=[...list].sort((a,b)=>b.p-a.p);
  return (
    <div>
      {/* Market tabs: List / Gainers / Losers / Trending */}
      <div style={{display:'flex',gap:5,marginBottom:10,overflowX:'auto'}}>
        {([['list','📋 종목'],['gainers','🚀 급등'],['losers','📉 급락'],['trending','🔥 트렌딩']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setMktTab(id)} style={{flexShrink:0,padding:'6px 12px',background:mktTab===id?T.acg:'transparent',color:mktTab===id?T.acl:T.muted,border:`1px solid ${mktTab===id?T.acl:T.border}`,borderRadius:20,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* Gainers / Losers / Trending from Binance */}
      {mktTab!=='list'&&(
        <div>
          {mktListStatus === 'loading'?(
            <div style={{textAlign:'center',padding:'30px 0',color:T.muted,fontSize:12}}>
              <div style={{fontSize:24,marginBottom:6}}>⏳</div>Binance 데이터 로딩 중…
            </div>
          ):(
            <Card style={{overflow:'hidden'}}>
              <div style={{padding:'9px 14px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',color:T.muted,fontSize:10,fontWeight:700}}>
                <span>종목</span><span>{mktTab==='gainers'?'🚀 상승률':mktTab==='losers'?'📉 하락률':'🔥 거래량'}</span>
              </div>
              {(mktTab==='gainers'?gainers:mktTab==='losers'?losers:trending).map((a:any,i:number)=>{
                // Normalize: Binance API uses {symbol,price,change24h} | prices prop uses {id,p,c}
                const sym    = a.symbol || a.id || a.sym || '?';
                const price  = a.price  ?? a.p  ?? 0;
                const change = a.change24h ?? a.c ?? 0;
                const nameKr = a.nameKr || getKrName(sym) || sym;
                const clr    = a.clr || (change >= 0 ? T.grn : T.red);
                const up     = change >= 0;
                // Build an asset object for openAsset
                const assetObj = { id:sym, nameKr, name:nameKr, sym, p:price, c:change, v:'-', t:a.t||'coin', clr };
                return (
                  <div key={sym+i} onClick={()=>onOpenAsset?.(assetObj,'trading')} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 14px',borderBottom:`1px solid ${T.border}`,cursor:'pointer'}}>
                    <div style={{display:'flex',gap:8,alignItems:'center'}}>
                      <span style={{color:T.muted,fontSize:10,width:18}}>{i+1}</span>
                      <Logo id={sym} size={30} clr={clr}/>
                      <div>
                        <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{nameKr}</div>
                        <div style={{color:T.muted,fontSize:9,fontFamily:'monospace'}}>{sym}</div>
                      </div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{color:T.txt,fontSize:11,fontWeight:700,fontFamily:'monospace'}}>{cvt(price,currency)}</div>
                      <div style={{color:up?T.grn:T.red,fontSize:10,fontWeight:700}}>{up?'▲':'▼'}{Math.abs(change).toFixed(2)}%</div>
                    </div>
                  </div>
                );
              })}
              {(mktTab==='gainers'?gainers:mktTab==='losers'?losers:trending).length===0&&(
                <div style={{padding:'24px 0',textAlign:'center',color:T.muted,fontSize:12}}>데이터 로딩 중… · 탭을 다시 선택해보세요</div>
              )}
            </Card>
          )}
        </div>
      )}

      {mktTab==='list'&&<>
      <GlobalSearch
        onSelect={(id,nameKr,clr)=>setSel({id,nameKr,name:nameKr,sym:id,p:0,c:0,v:'-',t:'stock',clr})}
        currency={currency}
      />
      <div style={{display:'flex',alignItems:'center',gap:10,background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:'10px 14px',marginBottom:12}}>
        <span>🔍</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="추천 종목 검색 (BTC, 삼성, AAPL…)" style={{background:'transparent',border:'none',outline:'none',color:T.txt,fontSize:13,flex:1}}/>
        {search&&<button onClick={()=>setSearch('')} style={{background:'none',border:'none',color:T.muted,cursor:'pointer'}}>✕</button>}
      </div>
      <div style={{display:'flex',gap:6,overflowX:'auto',paddingBottom:8,marginBottom:10}}>
        {['전체','코인','지수','미국주식','국내주식','일본주식','중국주식','유럽주식','ETF','원자재','환율'].map(t=><Pill key={t} ch={t} active={filter===t} onClick={()=>setFilter(t)}/>)}
      </div>
      <div style={{display:'flex',gap:6,marginBottom:12}}>
        <Pill ch="등락률순" active={sort==='change'} onClick={()=>setSort('change')} color={T.grn}/>
        <Pill ch="가격순" active={sort==='price'} onClick={()=>setSort('price')} color={T.ylw}/>
      </div>
      <Card style={{overflow:'hidden'}}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 60px 95px',padding:'9px 14px',borderBottom:`1px solid ${T.border}`,color:T.muted,fontSize:10,fontWeight:700,textTransform:'uppercase'}}>
          <span>종목</span><span style={{textAlign:'center'}}>차트</span><span style={{textAlign:'right'}}>가격/등락</span>
        </div>
        {list.length===0?<div style={{padding:'36px 0',textAlign:'center',color:T.muted}}><div style={{fontSize:28,marginBottom:6}}>🔍</div><div>검색 결과 없음</div></div>
        :list.map((a,i)=>(
          <div key={a.id} onClick={()=>setSelAsset(a)} style={{display:'flex',flexWrap:'nowrap',alignItems:'center',gap:8,cursor:'pointer',padding:'12px',borderBottom:`1px solid ${T.border}`}} className="mobile-1col" data-x="market-row">
            <div style={{display:'none'}}></div><div style={{display:'grid',gridTemplateColumns:'1fr 60px 95px',padding:'11px 14px',borderBottom:i<list.length-1?`1px solid ${T.border}`:'none',alignItems:'center',cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}><Logo id={a.id} size={34} clr={a.clr}/><div><div style={{color:T.txt,fontWeight:600,fontSize:12}}>{a.nameKr}</div><div style={{display:'flex',gap:4,marginTop:2}}><span style={{color:T.muted,fontSize:10}}>{a.sym}</span><Bdg c={TYPE_COLOR[a.t]} ch={TYPE_LABEL[a.t]} sm/></div></div></div>
            <div style={{display:'flex',justifyContent:'center'}}><Spark pos={a.c>=0} w={52} h={24}/></div>
            <div style={{textAlign:'right'}}><div style={{color:T.txt,fontWeight:700,fontSize:11,fontFamily:'monospace'}}>{cvt(a.p,currency)}</div><div style={{color:a.c>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{fmtPct(a.c)}</div></div>
          </div>
        ))}
      </Card>
      <div style={{color:T.muted,fontSize:10,textAlign:'center',marginTop:8}}>총 {list.length}개 종목</div>
      </>}
      {selAsset&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',zIndex:100}} onClick={()=>setSelAsset(null)}/>
          <div style={{position:'fixed',zIndex:101,inset:'auto 0 0 0',background:T.bg,borderRadius:'20px 20px 0 0',overflowY:'auto',padding:'16px 14px env(safe-area-inset-bottom,20px)',maxWidth:480,margin:'0 auto',height:'92dvh',maxHeight:'92dvh'}} onClick={e=>e.stopPropagation()}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}><Logo id={selAsset.id} size={44} clr={selAsset.clr}/><div><div style={{color:T.txt,fontWeight:900,fontSize:16}}>{selAsset.nameKr}</div><div style={{color:T.muted,fontSize:11}}>{selAsset.sym} · {TYPE_LABEL[selAsset.t]}</div></div></div>
              <button onClick={()=>setSelAsset(null)} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,color:T.muted,padding:'5px 10px',cursor:'pointer',fontSize:12}}>닫기</button>
            </div>
            <div style={{marginBottom:14}}><div style={{color:T.txt,fontSize:26,fontWeight:900,fontFamily:'monospace'}}>{cvt(selAsset.p,currency)}</div><div style={{color:selAsset.c>=0?T.grn:T.red,fontWeight:800,fontSize:15,marginTop:4}}>{selAsset.c>=0?'▲':'▼'} {Math.abs(selAsset.c).toFixed(2)}%</div></div>
            <div style={{height:240,borderRadius:12,overflow:'hidden',marginBottom:0}}>
              <InlineTVChart
                key={`market-${selAsset.id}-1-60`}
                symbol={resolveTVSym(selAsset.sym||selAsset.id)}
                chartType="1"
                interval="60"
              />
            </div>
            <div style={{display:'flex',gap:8,marginTop:14}}>
              <button style={{flex:1,padding:'13px',background:T.grn,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>📈 매수</button>
              <button style={{flex:1,padding:'13px',background:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>📉 매도</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ── WatchlistPage ── */

export default MarketPage;
