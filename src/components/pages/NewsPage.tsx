'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS, LOGO_SOURCES } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { formatNewsDate, formatRelativeTime } from '@/lib/format';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Dot, Spark, Pill, Bdg, Toggle, AreaChart, WorldClock, Heatmap,
         TradingChart, Logo, getBgColor, resolveLogoUrl, getKrName, cleanName, resolveTVSym,
         DonutChart, MiniBar, GlobalSearch, getLeverageRec,
         LiquidationCalc, PositionSizer, RiskDashboard,
         InlineTVChart } from './SharedUI';


function NewsPage({currency,onOpenAsset}:{currency:string;onOpenAsset?:(a:any,dest?:string)=>void}) {
  const [cat,setCat]         = useState('전체');
  const [search,setSearch]   = useState('');
  const [selected,setSelected] = useState<any>(null);
  const [news,setNews]       = useState<any[]>([]);
  const [loading,setLoading] = useState(true);
  const [aiSum,setAiSum]     = useState<Record<string,string>>({});
  const [aiLoading,setAiLoading] = useState<Record<string,boolean>>({});

  const CATS = ['전체','코인','주식','ETF','매크로','국내','AI/테크','에너지'];
  const sentC: Record<string,string> = { bullish:T.grn, bearish:T.red, neutral:T.ylw };

  // Fetch news from server
  const fetchNews = async(category:string) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/news?action=latest&cat=${encodeURIComponent(category==='전체'?'general':category)}`);
      const d = await r.json();
      setNews(Array.isArray(d.news) ? d.news : (Array.isArray(d) ? d : []));
    } catch {
      setNews([]);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchNews(cat); }, [cat]);

  const filtered = news.filter(n => {
    const matchSrch = !search || n.title?.includes(search) ||
      (n.tickers||[]).some((t:string) => t.toLowerCase().includes(search.toLowerCase()));
    return matchSrch;
  });

  // AI summarize a news item
  const summarize = async(newsItem: any) => {
    const id = newsItem.id || newsItem.title;
    if(aiSum[id]||aiLoading[id]) return;
    setAiLoading(p=>({...p,[id]:true}));
    try {
      const r = await fetch('/api/ai',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({action:'news',context:{headlines:[newsItem.title, newsItem.summary].filter(Boolean)}}),
      });
      const d = await r.json();
      if(d.result) setAiSum(p=>({...p,[id]:d.result}));
    } catch {} finally {
      setAiLoading(p=>({...p,[id]:false}));
    }
  };

  if(selected) return (
    <div>
      <button onClick={()=>setSelected(null)} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,color:T.muted,padding:'5px 12px',fontSize:12,cursor:'pointer',marginBottom:12}}>← 목록으로</button>
      {selected.image&&<img src={selected.image} alt="" style={{width:'100%',borderRadius:12,marginBottom:12,objectFit:'cover',maxHeight:200}} onError={e=>{(e.target as any).style.display='none'}}/>}
      <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:8,lineHeight:1.4}}>{selected.title}</div>
      <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:10}}>
        <div style={{color:T.muted,fontSize:10}}>{selected.source}</div>
        {selected.time&&<div style={{color:T.muted,fontSize:10}}>· {formatNewsDate(selected.time)}</div>}
        {selected.sentiment&&<div style={{color:sentC[selected.sentiment]||T.muted,fontSize:10,fontWeight:700}}>● {selected.sentiment}</div>}
      </div>
      {(selected.tickers||[]).length>0&&(
        <div style={{display:'flex',gap:5,marginBottom:10,flexWrap:'wrap'}}>
          {(Array.isArray(selected.tickers) ? selected.tickers : []).map((t:string)=>
                  <button key={t} type="button" onClick={()=>{
                    setSelected(null);
                    if(onOpenAsset) onOpenAsset({id:t,sym:t,nameKr:t,name:t,p:0,c:0,v:'-',t:'coin',clr:'#3B82F6'},'trading');
                  }} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:6,padding:'3px 10px',fontSize:10,fontWeight:700,cursor:'pointer',minHeight:30}}>
                    {t} →
                  </button>)}
        </div>
      )}
      <div style={{color:T.sub,fontSize:13,lineHeight:1.8,marginBottom:12}}>{selected.summary||selected.content||'본문 없음'}</div>

      {/* AI Summary */}
      {(aiSum[selected.id||selected.title]||aiLoading[selected.id||selected.title])&&(
        <Card style={{padding:'12px 14px',marginBottom:10,background:T.acl+'08',border:`1px solid ${T.acl}20`}}>
          <div style={{color:T.acl,fontSize:10,fontWeight:700,marginBottom:5}}>🤖 AI 요약</div>
          {aiLoading[selected.id||selected.title]
            ?<div style={{color:T.muted,fontSize:11}}>분석 중…</div>
            :<div style={{color:T.sub,fontSize:12,lineHeight:1.65,whiteSpace:'pre-wrap'}}>{aiSum[selected.id||selected.title]}</div>}
        </Card>
      )}
      {!aiSum[selected.id||selected.title]&&!aiLoading[selected.id||selected.title]&&(
        <button onClick={()=>summarize(selected)} style={{marginBottom:10,padding:'8px 14px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:9,fontSize:11,fontWeight:700,cursor:'pointer'}}>🤖 AI로 요약하기</button>
      )}
      <a href={selected.url} target="_blank" rel="noopener noreferrer" style={{display:'block',textAlign:'center',padding:'11px',background:'linear-gradient(135deg,#2563EB,#7C3AED)',color:'#fff',borderRadius:11,fontWeight:700,fontSize:13,textDecoration:'none'}}>
        🔗 원문 읽기
      </a>
    </div>
  );

  return (
    <div>
      {/* Search */}
      <div style={{display:'flex',gap:8,alignItems:'center',background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:'9px 14px',marginBottom:10}}>
        <span style={{color:T.muted}}>🔍</span>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="뉴스 검색 (BTC, Fed, CPI…)" style={{background:'transparent',border:'none',outline:'none',color:T.txt,fontSize:13,flex:1}}/>
        {search&&<button onClick={()=>setSearch('')} style={{background:'none',border:'none',color:T.muted,cursor:'pointer',fontSize:16}}>✕</button>}
      </div>

      {/* Categories */}
      <div style={{display:'flex',gap:5,overflowX:'auto',paddingBottom:5,marginBottom:10}}>
        {CATS.map(c=>(
          <button key={c} onClick={()=>setCat(c)} style={{flexShrink:0,padding:'5px 12px',background:cat===c?T.acg:'transparent',color:cat===c?T.acl:T.muted,border:`1px solid ${cat===c?T.acl:T.border}`,borderRadius:20,fontSize:11,fontWeight:700,cursor:'pointer'}}>{c}</button>
        ))}
      </div>

      {/* News list */}
      {loading?(
        <div>
          {[0,1,2,3].map(i=>(
            <div key={i} style={{background:T.card,borderRadius:12,padding:'14px',marginBottom:8}}>
              <div style={{height:14,background:'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)',backgroundSize:'200% 100%',animation:'shimmer 1.2s infinite',borderRadius:4,marginBottom:8,width:'80%'}}/>
              <div style={{height:10,background:'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)',backgroundSize:'200% 100%',animation:'shimmer 1.2s infinite',borderRadius:4,width:'60%'}}/>
            </div>
          ))}
        </div>
      ):filtered.length===0?(
        <div style={{textAlign:'center',padding:'40px 0'}}>
          <div style={{fontSize:32,marginBottom:8}}>📰</div>
          <div style={{color:T.muted,fontSize:13}}>{search?`"${search}" 검색 결과 없음`:'뉴스가 없습니다'}</div>
        </div>
      ):(Array.isArray(filtered)?filtered:[]).map(n=>{
        const nid = n.id||n.title;
        return (
          <Card key={nid} style={{padding:'14px 16px',marginBottom:8,cursor:'pointer'}} onClick={()=>setSelected(n)}>
            <div style={{display:'flex',gap:10,alignItems:'flex-start'}}>
              {n.image&&<img src={n.image} alt="" style={{width:64,height:64,borderRadius:9,objectFit:'cover',flexShrink:0}} onError={e=>{(e.target as any).style.display='none'}}/>}
              <div style={{flex:1,minWidth:0}}>
                <div style={{color:T.txt,fontWeight:700,fontSize:12,lineHeight:1.5,marginBottom:4,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical' as any}}>{n.title}</div>
                <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
                  <span style={{color:T.muted,fontSize:9}}>{n.source}</span>
                  {n.time&&<span style={{color:T.muted,fontSize:9}}>{formatNewsDate(n.time)}</span>}
                  {n.sentiment&&<span style={{color:sentC[n.sentiment]||T.muted,fontSize:9,fontWeight:700}}>● {n.sentiment}</span>}
                  {n.category&&<span style={{background:T.alt,color:T.muted,fontSize:8,padding:'1px 5px',borderRadius:4}}>{n.category}</span>}
                </div>
                {(n.tickers||[]).length>0&&(
                  <div style={{display:'flex',gap:4,marginTop:4,flexWrap:'wrap'}}>
                    {n.tickers.slice(0,3).map((t:string)=><span key={t} style={{background:T.acg,color:T.acl,fontSize:9,padding:'1px 6px',borderRadius:9,fontWeight:700}}>{t}</span>)}
                  </div>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/* ── AlertsPage ── */


export default NewsPage;