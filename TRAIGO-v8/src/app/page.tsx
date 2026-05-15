'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import { T, CURRENCIES, LANGS, I18N, LOGO_SOURCES, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';

interface Order { id:string;assetId:string;nameKr:string;sym:string;side:'buy'|'sell';price:number;amount:number;leverage:number;fee:number;slippage:number;status:'filled';pnl:number;pnlPct:number;openedAt:string;note:string;emotion:string; }
interface Alert { id:string;assetId:string;nameKr:string;condition:'above'|'below';value:number;active:boolean; }
interface Notif { id:string;type:'trade'|'alert'|'system';title:string;body:string;read:boolean;time:string; }

/* ── Logo ── */
function Logo({id,size=36,clr='#94A3B8'}:{id:string;size?:number;clr?:string}) {
  const [fail,setFail]=useState(false);const [ok,setOk]=useState(false);
  const url=LOGO_SOURCES[id];
  useEffect(()=>{setFail(false);setOk(false);},[id]);
  const r=Math.round(size*0.5);
  const base={width:size,height:size,borderRadius:r,flexShrink:0,overflow:'hidden',display:'inline-flex',alignItems:'center',justifyContent:'center'} as const;
  if(!url||fail){
    const ltr=id.replace(/[^A-Z0-9]/g,'').slice(0,2)||id.slice(0,2).toUpperCase();
    return <div style={{...base,background:`linear-gradient(135deg,${clr}CC,${clr}66)`,border:`1px solid ${clr}44`}}><span style={{color:'#fff',fontWeight:900,fontSize:size*0.34,fontFamily:'monospace'}}>{ltr}</span></div>;
  }
  return (
    <div style={{...base,background:clr+'15',border:`1px solid ${clr}22`,position:'relative'}}>
      {!ok&&<div style={{position:'absolute',inset:0,background:'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)',backgroundSize:'200% 100%',animation:'shimmer 1.2s infinite',borderRadius:r}}/>}
      <img src={url} alt={id} loading="lazy" style={{width:size*0.75,height:size*0.75,objectFit:'contain',opacity:ok?1:0,transition:'opacity .2s'}} onLoad={()=>setOk(true)} onError={()=>setFail(true)}/>
    </div>
  );
}

/* ── Base UI ── */
function Bdg({c,ch,sm}:{c:string;ch:string;sm?:boolean;[key:string]:any}) {
  return <span style={{background:c+'20',color:c,fontSize:sm?9:10,fontWeight:700,padding:sm?'1px 5px':'2px 8px',borderRadius:99,border:`1px solid ${c}30`,whiteSpace:'nowrap',display:'inline-block'}}>{ch}</span>;
}
function Pill({ch,active,color,onClick}:{ch:string;active:boolean;color?:string;onClick:()=>void;[key:string]:any}) {
  const col=color||T.acl;
  return <button onClick={onClick} style={{background:active?col+'20':'transparent',color:active?col:T.muted,border:`1px solid ${active?col:T.border}`,borderRadius:20,padding:'5px 13px',fontSize:12,fontWeight:600,cursor:'pointer',whiteSpace:'nowrap'}}>{ch}</button>;
}
function Toggle({on,onChange}:{on:boolean;onChange:(v:boolean)=>void}) {
  return <div onClick={()=>onChange(!on)} style={{width:44,height:24,borderRadius:12,background:on?T.acl:'#243A5E',cursor:'pointer',position:'relative',flexShrink:0,transition:'background .2s'}}><div style={{position:'absolute',top:3,left:on?23:3,width:18,height:18,borderRadius:9,background:'#fff',transition:'left .2s',boxShadow:'0 1px 4px rgba(0,0,0,.4)'}}/></div>;
}
function Card({children,style,glow}:{children?:React.ReactNode;style?:React.CSSProperties;glow?:boolean;[key:string]:any}) {
  return <div style={{background:T.card,border:`1px solid ${glow?T.acl:T.border}`,borderRadius:18,boxShadow:glow?`0 0 20px ${T.acg}`:'none',...style}}>{children}</div>;
}
function Dot({c}:{c?:string}) {
  return <span style={{display:'inline-block',width:7,height:7,borderRadius:'50%',background:c||T.grn,animation:'pulse 1.5s ease-in-out infinite'}}/>;
}
function Spark({pos,w,h}:{pos:boolean;w?:number;h?:number}) {
  const W=w||70,H=h||28;
  const pts=useMemo(()=>{const a=[];let y=H/2;for(let i=0;i<14;i++){y+=((Math.random()-(pos?0.42:0.58))*5.5);y=clamp(y,3,H-3);a.push({x:(i/13)*W,y});}return a;},[pos,W,H]);
  const d=pts.map((p,i)=>(i===0?'M':'L')+p.x.toFixed(1)+','+p.y.toFixed(1)).join(' ');
  const col=pos?T.grn:T.red;const uid2='s'+Math.random().toString(36).slice(2,7);
  return <svg width={W} height={H} style={{display:'block',flexShrink:0}}><defs><linearGradient id={uid2} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.3"/><stop offset="100%" stopColor={col} stopOpacity="0"/></linearGradient></defs><path d={d+' L'+W+','+H+' L0,'+H+' Z'} fill={'url(#'+uid2+')'}/><path d={d} stroke={col} strokeWidth="1.8" fill="none" strokeLinecap="round"/></svg>;
}
function AreaChart({color,h,up}:{color?:string;h?:number;up?:boolean}) {
  const col=color||T.acl,H=h||120,W=320;
  const pts=useMemo(()=>{const a=[];let y=H*0.65;for(let i=0;i<40;i++){y+=(Math.random()-(up!==false?0.43:0.57))*11;y=clamp(y,H*0.08,H*0.92);a.push({x:(i/39)*W,y});}return a;},[up,H]);
  const d=pts.map((p,i)=>(i===0?'M':'L')+p.x.toFixed(1)+','+p.y.toFixed(1)).join(' ');
  const uid2='a'+Math.random().toString(36).slice(2,7);
  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:H,display:'block'}} preserveAspectRatio="none"><defs><linearGradient id={uid2} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.22"/><stop offset="100%" stopColor={col} stopOpacity="0"/></linearGradient></defs><path d={d+' L'+W+','+H+' L0,'+H+' Z'} fill={'url(#'+uid2+')'}/><path d={d} stroke={col} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

/* ── Onboarding ── */
function Onboarding({onDone}:{onDone:(l:string,c:string)=>void}) {
  const [step,setStep]=useState(0);const [sl,setSl]=useState('ko');const [sc,setSc]=useState('KRW');
  return (
    <div style={{position:'fixed',inset:0,background:T.bg,display:'flex',flexDirection:'column',zIndex:1000}}>
      <div style={{padding:'32px 24px 16px',textAlign:'center',flexShrink:0}}>
        <div style={{width:64,height:64,borderRadius:18,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:30,fontWeight:900,color:'#fff',margin:'0 auto 10px'}}>T</div>
        <div style={{color:T.txt,fontWeight:900,fontSize:22,letterSpacing:-0.5}}>TRAIGO</div>
        <div style={{color:T.muted,fontSize:11,marginTop:3}}>글로벌 투자 시뮬레이션 플랫폼</div>
        <div style={{display:'flex',gap:8,marginTop:16,justifyContent:'center'}}>{[0,1].map(i=><div key={i} style={{width:step===i?28:8,height:7,borderRadius:4,background:step===i?T.acl:T.border,transition:'all .3s'}}/>)}</div>
        <div style={{color:T.txt,fontWeight:800,fontSize:17,marginTop:14}}>{step===0?'🌍 언어를 선택하세요':'💱 기본 통화를 선택하세요'}</div>
      </div>
      <div style={{flex:1,overflowY:'auto',padding:'0 20px 8px'}}>
        {step===0&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>{LANGS.map(l=><button key={l.code} onClick={()=>setSl(l.code)} style={{background:sl===l.code?T.acc+'25':T.card,border:`2px solid ${sl===l.code?T.acl:T.border}`,borderRadius:16,padding:'18px 10px',cursor:'pointer',textAlign:'center'}}><div style={{fontSize:32,marginBottom:8}}>{l.flag}</div><div style={{color:sl===l.code?T.acl:T.txt,fontWeight:700,fontSize:14}}>{l.name}</div></button>)}</div>}
        {step===1&&<div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>{Object.entries(CURRENCIES).map(([code,cur])=><button key={code} onClick={()=>setSc(code)} style={{background:sc===code?T.acc+'25':T.card,border:`2px solid ${sc===code?T.acl:T.border}`,borderRadius:12,padding:'10px 4px',cursor:'pointer',textAlign:'center'}}><div style={{fontSize:20,marginBottom:3}}>{cur.flag}</div><div style={{color:sc===code?T.acl:T.txt,fontWeight:800,fontSize:14}}>{cur.symbol}</div><div style={{color:T.muted,fontSize:9,marginTop:1}}>{code}</div></button>)}</div>}
      </div>
      <div style={{padding:'14px 20px 36px',flexShrink:0,borderTop:`1px solid ${T.border}`,background:T.bg}}>
        <button onClick={()=>{if(step===0)setStep(1);else onDone(sl,sc);}} style={{width:'100%',padding:'16px',background:`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:16,fontWeight:800,fontSize:16,cursor:'pointer',marginBottom:10}}>{step===0?'다음 →':'🚀 시작하기'}</button>
        <button onClick={()=>onDone('ko','KRW')} style={{width:'100%',padding:'10px',background:'transparent',color:T.muted,border:'none',cursor:'pointer',fontSize:12}}>건너뛰기</button>
      </div>
    </div>
  );
}

/* ── WorldClock ── */
function WorldClock() {
  const [now,setNow]=useState(new Date());
  useEffect(()=>{const t=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(t);},[]);
  const isOpen=(mk:typeof WORLD_MARKETS[0])=>{
    if(mk.name==='코인')return true;
    try{
      const day=now.toLocaleString('en-US',{timeZone:mk.tz,weekday:'short'});
      if(['Sat','Sun'].includes(day))return false;
      const tm=now.toLocaleTimeString('en-US',{timeZone:mk.tz,hour12:false,hour:'2-digit',minute:'2-digit'});
      const [h,mi]=tm.split(':').map(Number);
      const mins=h*60+mi;
      const [oh,om]=mk.open.split(':').map(Number);
      const [ch,cm]=mk.close.split(':').map(Number);
      return mins>=oh*60+om&&mins<ch*60+cm;
    }catch{return false;}
  };
  const getTime=(tz:string)=>{try{return now.toLocaleTimeString('ko-KR',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false});}catch{return '--:--';}};
  return (
    <div>
      <div style={{color:T.txt,fontWeight:800,fontSize:13,marginBottom:10}}>🌐 세계 시장 시계</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
        {WORLD_MARKETS.map(mk=>{const open=isOpen(mk);return(
          <div key={mk.name} style={{background:open?mk.color+'15':T.alt,border:`1px solid ${open?mk.color:T.border}`,borderRadius:12,padding:'10px 12px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <span style={{color:T.txt,fontWeight:700,fontSize:11}}>{mk.flag} {mk.name}</span>
              <span style={{background:open?mk.color+'25':'rgba(71,85,105,.3)',color:open?mk.color:T.muted,fontSize:9,fontWeight:700,borderRadius:99,padding:'1px 6px'}}>{open?'개장':'폐장'}</span>
            </div>
            <div style={{color:open?mk.color:T.muted,fontFamily:'monospace',fontSize:13,fontWeight:800}}>{mk.name==='코인'?'24/7':getTime(mk.tz)}</div>
            <div style={{color:T.muted,fontSize:9,marginTop:2}}>{mk.open}–{mk.close}</div>
          </div>
        );})}
      </div>
    </div>
  );
}

/* ── Heatmap ── */
/* ── GlobalSearch (전체 시장 검색) ── */
type SearchResultLocal = {
  symbol: string; name: string; nameKr?: string;
  exchange: string; asset_type: string;
  currency: string; provider: string;
  logo_url?: string; isWatchOnly?: boolean;
};

function GlobalSearch({onSelect,currency}:{onSelect:(id:string,nameKr:string,clr:string)=>void;currency:string}) {
  const [query,setQuery]=useState('');
  const [results,setResults]=useState<SearchResultLocal[]>([]);
  const [loading,setLoading]=useState(false);
  const [source,setSource]=useState('');
  const [open,setOpen]=useState(false);
  const debounceRef=useRef<ReturnType<typeof setTimeout>|null>(null);

  const TYPE_CLR:Record<string,string>={
    coin:'#F7931A',stock:'#3B82F6',krstock:'#EF4444',jpstock:'#DC2626',
    cnstock:'#EF4444',eustock:'#8B5CF6',etf:'#10B981',index:'#8B5CF6',
    commodity:'#D97706',forex:'#0891B2',
  };

  const TYPE_LBL:Record<string,string>={
    coin:'코인',stock:'미국주식',krstock:'국내주식',jpstock:'일본주식',
    cnstock:'중국주식',eustock:'유럽주식',etf:'ETF',index:'지수',
    commodity:'원자재',forex:'환율',
  };

  const PROVIDER_LBL:Record<string,string>={
    binance:'Binance',coingecko:'CoinGecko',polygon:'Polygon.io',
    finnhub:'Finnhub',kis:'KIS OpenAPI',naver_finance:'Naver Finance',
    exchangerate:'ExchangeRate',commodity_api:'Commodity API',mock:'Mock (오프라인)',
  };

  // Mock search DB inline (subset for offline)
  const MOCK_DB: SearchResultLocal[] = [
    {symbol:'BTC',name:'Bitcoin',nameKr:'비트코인',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
    {symbol:'ETH',name:'Ethereum',nameKr:'이더리움',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
    {symbol:'SOL',name:'Solana',nameKr:'솔라나',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
    {symbol:'XRP',name:'XRP',nameKr:'리플',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
    {symbol:'BNB',name:'BNB',nameKr:'바이낸스코인',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
    {symbol:'DOGE',name:'Dogecoin',nameKr:'도지코인',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
    {symbol:'ADA',name:'Cardano',nameKr:'에이다',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
    {symbol:'AAPL',name:'Apple Inc.',nameKr:'애플',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'MSFT',name:'Microsoft Corp.',nameKr:'마이크로소프트',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'NVDA',name:'NVIDIA Corp.',nameKr:'엔비디아',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'TSLA',name:'Tesla Inc.',nameKr:'테슬라',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'AMZN',name:'Amazon.com',nameKr:'아마존',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'META',name:'Meta Platforms',nameKr:'메타',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'GOOGL',name:'Alphabet Inc.',nameKr:'구글',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'AMD',name:'AMD',nameKr:'AMD',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'NFLX',name:'Netflix Inc.',nameKr:'넷플릭스',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'PLTR',name:'Palantir Tech',nameKr:'팔란티어',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'COIN',name:'Coinbase Global',nameKr:'코인베이스',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
    {symbol:'005930',name:'Samsung Electronics',nameKr:'삼성전자',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis'},
    {symbol:'000660',name:'SK Hynix',nameKr:'SK하이닉스',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis'},
    {symbol:'035420',name:'NAVER Corp.',nameKr:'네이버',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis'},
    {symbol:'035720',name:'Kakao Corp.',nameKr:'카카오',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis'},
    {symbol:'373220',name:'LG Energy Solution',nameKr:'LG에너지솔루션',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis'},
    {symbol:'005380',name:'Hyundai Motor',nameKr:'현대차',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis'},
    {symbol:'QQQ',name:'Invesco QQQ Trust',nameKr:'나스닥100 ETF',exchange:'NASDAQ',asset_type:'etf',currency:'USD',provider:'polygon'},
    {symbol:'SPY',name:'SPDR S&P 500 ETF',nameKr:'S&P500 ETF',exchange:'NYSE',asset_type:'etf',currency:'USD',provider:'polygon'},
    {symbol:'ARKK',name:'ARK Innovation ETF',nameKr:'ARK 혁신 ETF',exchange:'NYSE',asset_type:'etf',currency:'USD',provider:'polygon'},
    {symbol:'SOXL',name:'Direxion SOXL',nameKr:'반도체 3배 ETF',exchange:'NYSE',asset_type:'etf',currency:'USD',provider:'polygon'},
    {symbol:'TQQQ',name:'ProShares Ultra QQQ',nameKr:'나스닥 3배 ETF',exchange:'NASDAQ',asset_type:'etf',currency:'USD',provider:'polygon'},
    {symbol:'USDKRW',name:'USD/KRW',nameKr:'달러/원',exchange:'FOREX',asset_type:'forex',currency:'KRW',provider:'exchangerate',isWatchOnly:true},
    {symbol:'USDJPY',name:'USD/JPY',nameKr:'달러/엔',exchange:'FOREX',asset_type:'forex',currency:'JPY',provider:'exchangerate',isWatchOnly:true},
    {symbol:'EURUSD',name:'EUR/USD',nameKr:'유로/달러',exchange:'FOREX',asset_type:'forex',currency:'USD',provider:'exchangerate',isWatchOnly:true},
    {symbol:'GOLD',name:'Gold Spot',nameKr:'금',exchange:'COMMODITY',asset_type:'commodity',currency:'USD',provider:'commodity_api',isWatchOnly:true},
    {symbol:'WTI',name:'WTI Crude Oil',nameKr:'원유 WTI',exchange:'COMMODITY',asset_type:'commodity',currency:'USD',provider:'commodity_api',isWatchOnly:true},
  ];

  const searchLocal=(q:string)=>{
    const lq=q.toLowerCase();
    return MOCK_DB.filter(a=>
      a.symbol.toLowerCase().includes(lq)||
      a.name.toLowerCase().includes(lq)||
      (a.nameKr||'').includes(q)
    ).slice(0,20);
  };

  const doSearch=useCallback(async(q:string)=>{
    if(!q.trim()){setResults([]);setSource('');return;}
    setLoading(true);
    // 1. Instant local results
    const local=searchLocal(q);
    setResults(local);setSource('mock');
    // 2. Try Binance for crypto
    try{
      const isCrypto=/btc|eth|sol|xrp|bnb|doge|ada|avax|ton|link/i.test(q)||local.some(r=>r.asset_type==='coin');
      if(isCrypto){
        const res=await fetch(`https://api.binance.com/api/v3/exchangeInfo`,{signal:AbortSignal.timeout(2000)});
        if(res.ok){
          const data=await res.json();
          const QU=q.toUpperCase();
          const matches=(data.symbols as any[])
            .filter((s:any)=>s.quoteAsset==='USDT'&&s.status==='TRADING'&&(s.baseAsset.includes(QU)||s.symbol.includes(QU)))
            .slice(0,8)
            .map((s:any):SearchResultLocal=>({
              symbol:s.baseAsset,name:s.baseAsset,exchange:'BINANCE',
              asset_type:'coin',currency:'USDT',provider:'binance',
              nameKr:local.find(x=>x.symbol===s.baseAsset)?.nameKr,
            }));
          if(matches.length>0){
            const seen=new Set(local.map(r=>r.symbol));
            const combined=[...local,...matches.filter(m=>!seen.has(m.symbol))];
            setResults(combined);setSource('binance');
          }
        }
      }
    }catch{}
    setLoading(false);
  },[]);

  useEffect(()=>{
    if(debounceRef.current)clearTimeout(debounceRef.current);
    debounceRef.current=setTimeout(()=>doSearch(query),300);
    return()=>{if(debounceRef.current)clearTimeout(debounceRef.current);};
  },[query,doSearch]);

  const getLogoUrl=(r:SearchResultLocal)=>{
    const GECKO_MAP:Record<string,string>={BTC:'1',ETH:'279',SOL:'4128',BNB:'825',XRP:'44',DOGE:'5',ADA:'975',AVAX:'12559',TON:'17980',LINK:'877',DOT:'12171',MATIC:'4713',SHIB:'11939',ARB:'16547',SUI:'26375'};
    const CLEARBIT_MAP:Record<string,string>={AAPL:'apple.com',MSFT:'microsoft.com',NVDA:'nvidia.com',TSLA:'tesla.com',AMZN:'amazon.com',GOOGL:'google.com',META:'meta.com',NFLX:'netflix.com',AMD:'amd.com',PLTR:'palantir.com',COIN:'coinbase.com',JPM:'jpmorganchase.com',V:'visa.com',MA:'mastercard.com',QQQ:'invesco.com',SPY:'ssga.com',ARKK:'ark-invest.com'};
    if(r.asset_type==='coin'&&GECKO_MAP[r.symbol]){
      return `https://assets.coingecko.com/coins/images/${GECKO_MAP[r.symbol]}/small/${r.symbol.toLowerCase()}.png`;
    }
    if(CLEARBIT_MAP[r.symbol]) return `https://logo.clearbit.com/${CLEARBIT_MAP[r.symbol]}`;
    if(r.asset_type==='krstock'||r.exchange==='KRX') return `https://logo.clearbit.com/${r.symbol.toLowerCase()}.co.kr`;
    return null;
  };

  if(!open) return (
    <button onClick={()=>setOpen(true)} style={{width:'100%',display:'flex',alignItems:'center',gap:10,background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:'12px 16px',cursor:'pointer',marginBottom:12}}>
      <span style={{fontSize:16}}>🔍</span>
      <span style={{color:T.muted,fontSize:13,flex:1,textAlign:'left'}}>전체 시장 검색 (미국·한국·코인·ETF…)</span>
      <span style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}30`,borderRadius:8,padding:'2px 8px',fontSize:10,fontWeight:700}}>전체</span>
    </button>
  );

  return (
    <div style={{marginBottom:12}}>
      <div style={{background:T.card,border:`1px solid ${T.acl}40`,borderRadius:14,overflow:'hidden'}}>
        {/* Search input */}
        <div style={{display:'flex',alignItems:'center',gap:10,padding:'12px 14px',borderBottom:`1px solid ${T.border}`}}>
          <span style={{fontSize:16}}>{loading?'⏳':'🔍'}</span>
          <input
            autoFocus value={query} onChange={e=>setQuery(e.target.value)}
            placeholder="티커, 회사명, 한글명으로 검색 (AAPL, 삼성, Bitcoin…)"
            style={{flex:1,background:'transparent',border:'none',outline:'none',color:T.txt,fontSize:13}}
          />
          {query&&<button onClick={()=>{setQuery('');setResults([]);}} style={{background:'transparent',border:'none',color:T.muted,cursor:'pointer',fontSize:16}}>✕</button>}
          <button onClick={()=>{setOpen(false);setQuery('');setResults([]);}} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,color:T.muted,padding:'4px 8px',cursor:'pointer',fontSize:11}}>닫기</button>
        </div>

        {/* Provider info */}
        {source&&(
          <div style={{padding:'6px 14px',background:T.alt,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',gap:6}}>
            <Dot c={source==='binance'?T.ylw:source==='polygon'?T.acl:T.muted}/>
            <span style={{color:T.muted,fontSize:10}}>데이터 출처: {source==='binance'?'Binance API (실시간)':source==='coingecko'?'CoinGecko':source==='polygon'?'Polygon.io':source==='mock'?'로컬 데이터 (오프라인)':source}</span>
            <span style={{marginLeft:'auto',color:T.muted,fontSize:10}}>{results.length}개 결과</span>
          </div>
        )}

        {/* Results */}
        {results.length>0&&(
          <div style={{maxHeight:340,overflowY:'auto'}}>
            {results.map((r,i)=>{
              const logoUrl=getLogoUrl(r);
              const typeClr=TYPE_CLR[r.asset_type]||'#94A3B8';
              return (
                <div key={r.symbol+i} onClick={()=>{
                  // Cache the selected asset
                  try{
                    const cache=JSON.parse(localStorage.getItem('tg_asset_cache_v2')||'{}');
                    cache[r.symbol]={symbol:r.symbol,name:r.name,nameKr:r.nameKr,exchange:r.exchange,asset_type:r.asset_type,currency:r.currency,logo_url:logoUrl||undefined,updated_at:new Date().toISOString(),source:r.provider};
                    localStorage.setItem('tg_asset_cache_v2',JSON.stringify(cache));
                  }catch{}
                  onSelect(r.symbol, r.nameKr||r.name, typeClr);
                  setOpen(false);setQuery('');setResults([]);
                }} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'11px 14px',borderBottom:i<results.length-1?`1px solid ${T.border}`:'none',cursor:'pointer'}}>
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    {/* Logo */}
                    {logoUrl?(
                      <div style={{width:32,height:32,borderRadius:8,overflow:'hidden',background:typeClr+'20',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                        <img src={logoUrl} alt={r.symbol} width={24} height={24} style={{objectFit:'contain'}} onError={(e)=>{(e.target as HTMLImageElement).style.display='none';}}/>
                      </div>
                    ):(
                      <div style={{width:32,height:32,borderRadius:8,background:`linear-gradient(135deg,${typeClr}CC,${typeClr}66)`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                        <span style={{color:'#fff',fontWeight:900,fontSize:10,fontFamily:'monospace'}}>{r.symbol.slice(0,2)}</span>
                      </div>
                    )}
                    <div>
                      <div style={{display:'flex',gap:5,alignItems:'center'}}>
                        <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{r.symbol}</span>
                        <Bdg c={typeClr} ch={TYPE_LBL[r.asset_type]||r.asset_type} sm/>
                        {r.isWatchOnly&&<Bdg c={T.muted} ch="관찰만" sm/>}
                      </div>
                      <div style={{color:T.muted,fontSize:10,marginTop:1}}>{r.nameKr||r.name} · {r.exchange}</div>
                    </div>
                  </div>
                  <div style={{textAlign:'right',flexShrink:0}}>
                    <div style={{color:T.muted,fontSize:9}}>{PROVIDER_LBL[r.provider]||r.provider}</div>
                    <div style={{color:T.muted,fontSize:10}}>{r.currency}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {query&&!loading&&results.length===0&&(
          <div style={{padding:'24px 0',textAlign:'center'}}>
            <div style={{fontSize:28,marginBottom:6}}>🔍</div>
            <div style={{color:T.muted,fontSize:12}}>'{query}' 검색 결과 없음</div>
            <div style={{color:T.muted,fontSize:10,marginTop:4}}>API 키 설정 시 더 많은 종목 검색 가능</div>
          </div>
        )}

        {/* No query — show providers */}
        {!query&&(
          <div style={{padding:'14px 16px'}}>
            <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:10}}>🌐 지원 데이터 제공사</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
              {[
                {name:'Binance',type:'코인',status:'✅ 연결됨',c:T.ylw},
                {name:'CoinGecko',type:'코인 (폴백)',status:'✅ 연결됨',c:T.grn},
                {name:'Polygon.io',type:'미국주식',status:'🔑 API키 필요',c:T.acl},
                {name:'Finnhub',type:'미국주식',status:'🔑 API키 필요',c:T.acl},
                {name:'KIS Open API',type:'한국주식',status:'🔑 API키 필요',c:T.red},
                {name:'Naver Finance',type:'한국주식',status:'🔑 API키 필요',c:T.grn},
                {name:'ExchangeRate',type:'환율',status:'✅ 연결됨',c:T.cyn},
                {name:'Commodity API',type:'원자재',status:'🔑 API키 필요',c:T.gld},
              ].map((p,i)=>(
                <div key={i} style={{background:T.alt,borderRadius:8,padding:'8px 10px'}}>
                  <div style={{color:T.txt,fontSize:11,fontWeight:600}}>{p.name}</div>
                  <div style={{color:T.muted,fontSize:9}}>{p.type}</div>
                  <div style={{color:p.status.startsWith('✅')?T.grn:T.ylw,fontSize:9,marginTop:2}}>{p.status}</div>
                </div>
              ))}
            </div>
            <div style={{color:T.muted,fontSize:10,marginTop:10,lineHeight:1.5}}>
              💡 .env.local에 API 키를 추가하면 미국주식·한국주식 실시간 검색이 가능합니다.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
function Heatmap({prices}:{prices:Asset[]}) {
  return (
    <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:4}}>
      {prices.slice(0,24).map(a=>{
        const intensity=clamp(Math.abs(a.c)/5,0,1);
        const bg=a.c>=0?`rgba(16,185,129,${0.1+intensity*0.5})`:`rgba(239,68,68,${0.1+intensity*0.5})`;
        return <div key={a.id} style={{background:bg,border:`1px solid ${a.c>=0?'rgba(16,185,129,.3)':'rgba(239,68,68,.3)'}`,borderRadius:10,padding:'8px 4px',textAlign:'center'}}>
          <Logo id={a.id} size={20} clr={a.c>=0?T.grn:T.red}/>
          <div style={{color:T.txt,fontSize:9,fontWeight:700,marginTop:3}}>{a.id}</div>
          <div style={{color:a.c>=0?T.grn:T.red,fontSize:8,fontWeight:800,fontFamily:'monospace'}}>{fmtPct(a.c)}</div>
        </div>;
      })}
    </div>
  );
}

/* ── TradingChart ── */
const TOOL_GROUPS=[
  {name:'추세',icon:'↗',tools:[{id:'trendline',label:'추세선',icon:'↗'},{id:'hline',label:'수평선',icon:'—'},{id:'vline',label:'수직선',icon:'|'}]},
  {name:'피보',icon:'𝜑',tools:[{id:'fib_ret',label:'피보나치 되돌림',icon:'𝜑'},{id:'ruler',label:'자 (퍼센트)',icon:'📏'}]},
  {name:'도형',icon:'□',tools:[{id:'rect',label:'사각형',icon:'□'},{id:'circle',label:'원',icon:'○'}]},
  {name:'주석',icon:'✏',tools:[{id:'text',label:'텍스트',icon:'T'},{id:'brush',label:'브러시',icon:'✏'},{id:'eraser',label:'지우개',icon:'⬜'}]},
];
const PALETTE=['#3B82F6','#10B981','#EF4444','#F59E0B','#7C3AED','#EC4899','#FFFFFF','#94A3B8'];

function TradingChart({asset}:{asset?:Asset}) {
  const [ct,setCt]=useState('line');const [tf,setTf]=useState('1H');
  const [tool,setTool]=useState('cursor');const [openGrp,setOpenGrp]=useState<string|null>(null);
  const [drawColor,setDrawColor]=useState('#3B82F6');const [showPalette,setShowPalette]=useState(false);
  const [shapes,setShapes]=useState<any[]>([]);const [drawing,setDrawing]=useState(false);
  const [curPts,setCurPts]=useState<{x:number;y:number}[]>([]);
  const [textPos,setTextPos]=useState<{x:number;y:number}|null>(null);const [textVal,setTextVal]=useState('');
  const [historyStack,setHistoryStack]=useState<any[][]>([[]]);const [histIdx,setHistIdx]=useState(0);
  const [chartMode,setChartMode]=useState<'custom'|'tv'>('custom');
  const svgRef=useRef<SVGSVGElement>(null);
  const TFS=['1m','5m','15m','1H','4H','1D','1W'];
  const CTYPES=[{id:'line',label:'라인'},{id:'area',label:'영역'},{id:'candle',label:'캔들'}];
  const [indicators,setIndicators]=useState<Record<string,boolean>>({EMA:false,RSI:false,MACD:false,BB:false,VOL:false,VWAP:false});
  const toggleIndicator=(k:string)=>setIndicators(p=>({...p,[k]:!p[k]}));
  const getSVGPt=(e:React.MouseEvent)=>{const r=svgRef.current!.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};};
  const pushH=(s:any[])=>{const h=historyStack.slice(0,histIdx+1);setHistoryStack([...h,s]);setHistIdx(h.length);};
  const onMD=(e:React.MouseEvent)=>{if(tool==='cursor')return;const pt=getSVGPt(e);if(tool==='eraser'){if(shapes.length>0){const n=shapes.slice(0,-1);setShapes(n);pushH(n);}return;}if(tool==='text'){setTextPos(pt);return;}if(tool==='hline'||tool==='vline'){const s={id:Date.now(),tool,pts:[pt,pt],color:drawColor};const n=[...shapes,s];setShapes(n);pushH(n);return;}setDrawing(true);setCurPts([pt]);};
  const onMM=(e:React.MouseEvent)=>{if(!drawing)return;const pt=getSVGPt(e);if(tool==='brush')setCurPts(p=>[...p,pt]);else setCurPts(p=>[p[0],pt]);};
  const onMU=()=>{if(!drawing||curPts.length<1){setDrawing(false);return;}const s={id:Date.now(),tool,pts:curPts,color:drawColor};const n=[...shapes,s];setShapes(n);pushH(n);setCurPts([]);setDrawing(false);};
  const addText=()=>{if(!textPos||!textVal.trim()){setTextPos(null);return;}const s={id:Date.now(),tool:'text',pts:[textPos],color:drawColor,text:textVal};const n=[...shapes,s];setShapes(n);pushH(n);setTextPos(null);setTextVal('');};
  const renderShape=(s:any,preview?:boolean)=>{const [p1,p2]=s.pts;const key=s.id||'pr';const op=preview?0.65:1;
    if(s.tool==='trendline'){if(!p1||!p2)return null;return <line key={key} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={s.color} strokeWidth="1.8" strokeLinecap="round" opacity={op}/>;}
    if(s.tool==='hline')return <line key={key} x1="0" y1={p1.y} x2="100%" y2={p1.y} stroke={s.color} strokeWidth="1.5" strokeDasharray="6 3" opacity={op}/>;
    if(s.tool==='vline')return <line key={key} x1={p1.x} y1="0" x2={p1.x} y2="100%" stroke={s.color} strokeWidth="1.5" strokeDasharray="6 3" opacity={op}/>;
    if(s.tool==='rect'){if(!p1||!p2)return null;return <rect key={key} x={Math.min(p1.x,p2.x)} y={Math.min(p1.y,p2.y)} width={Math.abs(p2.x-p1.x)} height={Math.abs(p2.y-p1.y)} fill={s.color+'18'} stroke={s.color} strokeWidth="1.5" opacity={op}/>;}
    if(s.tool==='circle'){if(!p1||!p2)return null;return <ellipse key={key} cx={(p1.x+p2.x)/2} cy={(p1.y+p2.y)/2} rx={Math.abs(p2.x-p1.x)/2} ry={Math.abs(p2.y-p1.y)/2} fill={s.color+'18'} stroke={s.color} strokeWidth="1.5" opacity={op}/>;}
    if(s.tool==='fib_ret'){if(!p1||!p2)return null;const fibs=[0,0.236,0.382,0.5,0.618,0.786,1];return <g key={key} opacity={op}>{fibs.map(lv=>{const y=p1.y+(p2.y-p1.y)*lv;return <g key={lv}><line x1={p1.x} y1={y} x2={p2.x} y2={y} stroke={s.color} strokeWidth="1" strokeDasharray="4 2" opacity="0.7"/><text x={Math.max(p1.x,p2.x)+3} y={y+4} fill={s.color} fontSize="9" fontFamily="monospace">{(lv*100).toFixed(1)+'%'}</text></g>;})}</g>;}
    if(s.tool==='ruler'){if(!p1||!p2)return null;const pct=p1.y>0?((p1.y-p2.y)/p1.y*100).toFixed(2):'0';return <g key={key} opacity={op}><rect x={Math.min(p1.x,p2.x)} y={Math.min(p1.y,p2.y)} width={Math.abs(p2.x-p1.x)} height={Math.abs(p2.y-p1.y)} fill={s.color+'15'} stroke={s.color} strokeWidth="1"/><text x={(p1.x+p2.x)/2} y={(p1.y+p2.y)/2} textAnchor="middle" fill={s.color} fontSize="11" fontWeight="700" fontFamily="monospace">{pct+'%'}</text></g>;}
    if(s.tool==='brush'){if(s.pts.length<2)return null;const pd=s.pts.map((pt:any,i:number)=>(i===0?'M':'L')+pt.x.toFixed(1)+','+pt.y.toFixed(1)).join(' ');return <path key={key} d={pd} stroke={s.color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={op}/>;}
    if(s.tool==='text')return <text key={key} x={p1.x} y={p1.y} fill={s.color} fontSize="13" fontWeight="600">{s.text}</text>;
    return null;
  };
  const cursorStyle=tool==='cursor'?'default':tool==='eraser'?'cell':tool==='text'?'text':'crosshair';
  const up=asset?asset.c>=0:true;
  return (
    <div style={{background:T.bg,borderRadius:14,border:`1px solid ${T.border}`,overflow:'hidden'}}>
      <div style={{borderBottom:`1px solid ${T.border}`,padding:'7px 10px',display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
        <div style={{display:'flex',gap:3}}>
          {(['custom','tv'] as const).map(mode=><button key={mode} onClick={()=>setChartMode(mode)} style={{background:chartMode===mode?T.acg:'transparent',color:chartMode===mode?T.acl:T.muted,border:`1px solid ${chartMode===mode?T.acl:T.border}`,borderRadius:7,padding:'3px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{mode==='custom'?'커스텀':'TradingView'}</button>)}
        </div>
        {chartMode==='custom'&&<>
          <div style={{width:1,height:14,background:T.border}}/>
          <div style={{display:'flex',gap:3}}>{CTYPES.map(c=><button key={c.id} onClick={()=>setCt(c.id)} style={{background:ct===c.id?T.acg:'transparent',color:ct===c.id?T.acl:T.muted,border:`1px solid ${ct===c.id?T.acl:T.border}`,borderRadius:7,padding:'3px 7px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{c.label}</button>)}</div>
          <div style={{display:'flex',gap:3,overflowX:'auto'}}>{TFS.map(t=><button key={t} onClick={()=>setTf(t)} style={{background:tf===t?T.acg:'transparent',color:tf===t?T.acl:T.muted,border:`1px solid ${tf===t?T.acl:'transparent'}`,borderRadius:6,padding:'2px 6px',fontSize:10,fontWeight:700,cursor:'pointer',flexShrink:0}}>{t}</button>)}</div>
          <div style={{width:1,height:14,background:T.border}}/>
          <div style={{display:'flex',gap:2,overflowX:'auto'}}>
            {Object.entries(indicators).map(([k,on])=><button key={k} onClick={()=>toggleIndicator(k)} style={{background:on?T.ylw+'20':'transparent',color:on?T.ylw:T.muted,border:`1px solid ${on?T.ylw:T.border}`,borderRadius:5,padding:'1px 5px',fontSize:9,fontWeight:700,cursor:'pointer',flexShrink:0}}>{k}</button>)}
          </div>
        </>}
      </div>
      {chartMode==='tv'?(
        <div style={{padding:20,textAlign:'center',minHeight:200,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:8}}>
          <div style={{fontSize:32}}>📊</div>
          <div style={{color:T.txt,fontWeight:700,fontSize:14}}>TradingView 위젯</div>
          <div style={{color:T.muted,fontSize:11,lineHeight:1.6}}>실제 프로젝트에서는 TradingView 위젯으로 교체하세요.</div>
          <a href={`https://www.tradingview.com/chart/?symbol=${asset?.sym||'BTCUSDT'}`} target="_blank" rel="noopener noreferrer" style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,padding:'8px 16px',fontSize:12,fontWeight:700,textDecoration:'none',marginTop:8}}>TradingView에서 보기 →</a>
        </div>
      ):(
        <>
          <div style={{borderBottom:`1px solid ${T.border}`,padding:'5px 8px',display:'flex',gap:3,alignItems:'center',flexWrap:'wrap'}}>
            <button onClick={()=>{setTool('cursor');setOpenGrp(null);}} style={{width:28,height:28,display:'flex',alignItems:'center',justifyContent:'center',background:tool==='cursor'?T.acg:'transparent',color:tool==='cursor'?T.acl:T.muted,border:`1px solid ${tool==='cursor'?T.acl:'transparent'}`,borderRadius:7,cursor:'pointer',fontSize:14}}>↖</button>
            <div style={{width:1,height:18,background:T.border}}/>
            {TOOL_GROUPS.map(grp=>(
              <div key={grp.name} style={{position:'relative'}}>
                <button onClick={()=>setOpenGrp(openGrp===grp.name?null:grp.name)} style={{width:28,height:28,display:'flex',alignItems:'center',justifyContent:'center',background:openGrp===grp.name?T.acg:'transparent',color:openGrp===grp.name?T.acl:T.muted,border:`1px solid ${openGrp===grp.name?T.acl:'transparent'}`,borderRadius:7,cursor:'pointer',fontSize:13}}>{grp.icon}</button>
                {openGrp===grp.name&&<div style={{position:'absolute',top:32,left:0,zIndex:50,background:T.surf,border:`1px solid ${T.border}`,borderRadius:12,padding:6,minWidth:170,boxShadow:'0 8px 24px rgba(0,0,0,.6)'}}>
                  {grp.tools.map(t2=><button key={t2.id} onClick={()=>{setTool(t2.id);setOpenGrp(null);}} style={{display:'flex',alignItems:'center',gap:8,width:'100%',background:tool===t2.id?T.acg:'transparent',color:tool===t2.id?T.acl:T.txt,border:'none',borderRadius:8,padding:'7px 10px',cursor:'pointer',textAlign:'left'}}><span style={{fontSize:14,width:18,textAlign:'center'}}>{t2.icon}</span><span style={{fontSize:12,fontWeight:600}}>{t2.label}</span></button>)}
                </div>}
              </div>
            ))}
            <div style={{width:1,height:18,background:T.border}}/>
            <div style={{position:'relative'}}>
              <button onClick={()=>setShowPalette(v=>!v)} style={{width:22,height:22,borderRadius:6,background:drawColor,border:'2px solid rgba(255,255,255,.3)',cursor:'pointer'}}/>
              {showPalette&&<div style={{position:'absolute',top:28,left:0,zIndex:50,background:T.surf,border:`1px solid ${T.border}`,borderRadius:10,padding:8,display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:4,boxShadow:'0 8px 24px rgba(0,0,0,.5)'}}>
                {PALETTE.map(col=><button key={col} onClick={()=>{setDrawColor(col);setShowPalette(false);}} style={{width:22,height:22,borderRadius:5,background:col,border:`2px solid ${drawColor===col?'#fff':'transparent'}`,cursor:'pointer'}}/>)}
              </div>}
            </div>
            <div style={{marginLeft:'auto',display:'flex',gap:3}}>
              <button onClick={()=>{if(histIdx>0){const i=histIdx-1;setShapes(historyStack[i]||[]);setHistIdx(i);}}} disabled={histIdx<=0} style={{width:26,height:26,display:'flex',alignItems:'center',justifyContent:'center',background:'transparent',border:`1px solid ${T.border}`,borderRadius:6,color:histIdx<=0?T.muted:T.sub,cursor:'pointer',fontSize:13}}>↺</button>
              {shapes.length>0&&<button onClick={()=>{setShapes([]);pushH([]);}} style={{padding:'0 8px',height:26,background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:6,fontSize:10,fontWeight:700,cursor:'pointer'}}>삭제</button>}
            </div>
          </div>
          <div style={{position:'relative'}}>
            <div style={{padding:'8px 10px 0'}}><AreaChart color={up?T.grn:T.red} h={200} up={up}/></div>
            {tool!=='cursor'&&<svg ref={svgRef} style={{position:'absolute',inset:0,width:'100%',height:'100%',cursor:cursorStyle,zIndex:10}} onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={onMU}>
              {shapes.map(s=>renderShape(s,false))}
              {drawing&&curPts.length>=1&&renderShape({id:'pr',tool,pts:curPts,color:drawColor},true)}
            </svg>}
            {textPos&&<div style={{position:'absolute',zIndex:20,left:textPos.x+6,top:textPos.y-20,display:'flex',gap:5}}><input autoFocus value={textVal} onChange={e=>setTextVal(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')addText();if(e.key==='Escape'){setTextPos(null);setTextVal('');}}} style={{background:T.surf,border:`1px solid ${T.acl}`,borderRadius:8,padding:'5px 10px',color:T.txt,fontSize:12,outline:'none',width:140}} placeholder="텍스트 입력…"/><button onClick={addText} style={{background:T.acc,color:'#fff',border:'none',borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>확인</button></div>}
          </div>
          <div style={{padding:'6px 10px',borderTop:`1px solid ${T.border}`,display:'flex',alignItems:'center',gap:6}}>
            <Dot c={T.grn}/><span style={{color:T.muted,fontSize:10}}>{tool==='cursor'?'도구를 선택하여 드로잉':'클릭하거나 드래그하세요'}</span>
            {shapes.length>0&&<span style={{marginLeft:'auto',color:T.muted,fontSize:10}}>{shapes.length}개</span>}
          </div>
        </>
      )}
    </div>
  );
}

/* ── HomePage ── */
function HomePage({onNav,prices,currency,lang}:{onNav:(t:string)=>void;prices:Asset[];currency:string;lang:string}) {
  const top5=useMemo(()=>[...prices].sort((a,b)=>b.c-a.c).slice(0,5),[prices]);
  const [autoAll,setAutoAll]=useState(true);

  const LONG_VALUE  = 48500000;
  const SHORT_VALUE = 1230000;
  const CASH_VALUE  = 5000000;
  const TOTAL = LONG_VALUE + SHORT_VALUE + CASH_VALUE;
  const TOTAL_PNL   = 2870000;

  return (
    <div>
      {/* Risk warning */}
      <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:12,padding:'9px 13px',marginBottom:12,display:'flex',gap:8,alignItems:'flex-start'}}>
        <span style={{flexShrink:0}}>⚠️</span>
        <span style={{color:T.ylw,fontSize:11,fontWeight:600,lineHeight:1.5}}>{tr(lang,'warning')}</span>
      </div>

      {/* Total asset banner */}
      <div style={{background:'linear-gradient(145deg,#0D1A35,#091228)',border:`1px solid ${T.border2}`,borderRadius:22,padding:'22px 20px',marginBottom:14,position:'relative',overflow:'hidden'}}>
        <div style={{position:'absolute',right:-40,top:-40,width:200,height:200,background:`radial-gradient(circle,${T.acg} 0%,transparent 70%)`,pointerEvents:'none'}}/>
        <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:4}}><Dot/><span style={{color:T.muted,fontSize:11,fontWeight:600}}>헤지펀드 포트폴리오 · 🎮 {tr(lang,'mock')}</span></div>
        <div style={{color:T.muted,fontSize:12,marginBottom:2}}>총 평가 자산</div>
        <div style={{color:T.txt,fontSize:30,fontWeight:900,fontFamily:'monospace',letterSpacing:-1.5}}>{cvt(TOTAL,currency)}</div>
        <div style={{display:'flex',alignItems:'center',gap:10,marginTop:6}}>
          <span style={{color:T.grn,fontWeight:700,fontSize:13}}>▲ +{cvt(TOTAL_PNL,currency)}</span>
          <Bdg c={T.grn} ch={"+"+fmtPct(TOTAL_PNL/TOTAL*100)+" 총수익"}/>
        </div>
        <div style={{display:'flex',gap:8,marginTop:16,flexWrap:'wrap'}}>
          <button onClick={()=>onNav('portfolio')} style={{background:T.acc,color:'#fff',border:'none',borderRadius:12,padding:'11px 18px',fontWeight:800,fontSize:13,cursor:'pointer'}}>📊 포트폴리오</button>
          <button onClick={()=>onNav('trading')} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:12,padding:'11px 18px',fontWeight:700,fontSize:13,cursor:'pointer'}}>⚡ 매매하기</button>
        </div>
      </div>

      {/* Dual portfolio cards */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
        <Card style={{padding:'14px 16px',cursor:'pointer'}} glow={false}>
          <div onClick={()=>onNav('portfolio')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:6}}>
              <span style={{fontSize:14}}>📈</span>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>장투 포트폴리오</span>
            </div>
            <div style={{color:T.txt,fontSize:15,fontWeight:900,fontFamily:'monospace'}}>{cvt(LONG_VALUE,currency)}</div>
            <div style={{color:T.grn,fontSize:11,fontWeight:700,marginTop:2}}>+{cvt(1820000,currency)}</div>
            <div style={{marginTop:8,height:4,background:'#1A2D4A',borderRadius:2}}><div style={{height:'100%',width:'60%',background:T.acl,borderRadius:2}}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 60% · 레버 없음</div>
          </div>
        </Card>
        <Card style={{padding:'14px 16px',cursor:'pointer'}}>
          <div onClick={()=>onNav('portfolio')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:6}}>
              <span style={{fontSize:14}}>⚡</span>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>단타 포트폴리오</span>
            </div>
            <div style={{color:T.txt,fontSize:15,fontWeight:900,fontFamily:'monospace'}}>{cvt(SHORT_VALUE,currency)}</div>
            <div style={{color:T.grn,fontSize:11,fontWeight:700,marginTop:2}}>+{cvt(87000,currency)}</div>
            <div style={{marginTop:8,height:4,background:'#1A2D4A',borderRadius:2}}><div style={{height:'100%',width:'30%',background:T.ylw,borderRadius:2}}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 30% · 최대 10배</div>
          </div>
        </Card>
      </div>

      {/* Status cards */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
        {[
          {icon:'🔄',l:'DCA 적립',v:'주 3회 실행',sub:'다음 매수 내일',c:T.acl},
          {icon:'📊',l:'오늘 단타',v:'+₩87,000',sub:'승률 67% (2/3)',c:T.grn},
        ].map(x=>(
          <Card key={x.l} style={{padding:'14px 16px'}}>
            <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:6}}><span style={{fontSize:14}}>{x.icon}</span><div style={{color:T.muted,fontSize:10,fontWeight:600}}>{x.l}</div></div>
            <div style={{color:x.c,fontSize:14,fontWeight:900,fontFamily:'monospace'}}>{x.v}</div>
            <div style={{color:T.muted,fontSize:10,marginTop:3}}>{x.sub}</div>
          </Card>
        ))}
      </div>

      {/* Auto trading */}
      <Card style={{padding:'14px 18px',marginBottom:12}} glow={autoAll}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:2}}>🤖 자동매매 <Bdg c={autoAll?T.grn:T.muted} ch={autoAll?'실행중':'정지'}/></div>
            <div style={{color:T.muted,fontSize:11}}>{autoAll?'EMA 추세 + DCA 실행 중':'정지됨'}</div>
          </div>
          <Toggle on={autoAll} onChange={setAutoAll}/>
        </div>
      </Card>

      {/* Risk status */}
      <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.grn}20`}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:10}}>🛡️ 리스크 현황</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
          {[{l:'전체 리스크',v:'낮음',c:T.grn},{l:'장투 건전성',v:'우수',c:T.grn},{l:'단타 손실',v:'0%',c:T.grn}].map(r=>(
            <div key={r.l} style={{textAlign:'center'}}>
              <div style={{color:T.muted,fontSize:9,marginBottom:3}}>{r.l}</div>
              <Bdg c={r.c} ch={r.v}/>
            </div>
          ))}
        </div>
      </Card>

      {/* Top movers */}
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:10}}>🚀 상위 상승 종목</div>
        {top5.map((a,i)=>(
          <div key={a.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'7px 0',borderBottom:i<4?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <Logo id={a.id} size={30} clr={a.clr}/>
              <div><div style={{color:T.txt,fontWeight:600,fontSize:12}}>{a.nameKr}</div><div style={{color:T.muted,fontSize:10}}>{a.sym}</div></div>
            </div>
            <div style={{textAlign:'right'}}>
              <div style={{color:T.txt,fontWeight:700,fontSize:11,fontFamily:'monospace'}}>{cvt(a.p,currency)}</div>
              <div style={{color:a.c>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{fmtPct(a.c)}</div>
            </div>
          </div>
        ))}
      </Card>

      {/* News */}
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:10}}>📰 최신 뉴스</div>
        {MOCK_NEWS.slice(0,3).map((n,i)=>(
          <div key={n.id} style={{padding:'8px 0',borderBottom:i<2?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
              <Bdg c={n.sentiment==='bullish'?T.grn:T.red} ch={n.category}/>
              <span style={{color:T.muted,fontSize:10}}>{n.time}</span>
            </div>
            <div style={{color:T.txt,fontSize:12,fontWeight:600,lineHeight:1.4}}>{n.title}</div>
          </div>
        ))}
      </Card>

      {/* Quick access to new features */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        {[
          {tab:'calendar',icon:'📅',l:'경제 캘린더',d:'오늘 FOMC·CPI 확인',c:T.red},
          {tab:'briefing',icon:'🤖',l:'AI 브리핑',d:'오늘의 시장 요약',c:T.prp},
          {tab:'tax',icon:'💼',l:'손익 추적',d:'2025년 실현손익',c:T.ylw},
          {tab:'growth',icon:'🏆',l:'성장 현황',d:'배지·XP·친구초대',c:T.grn},
        ].map(x=>(
          <button key={x.tab} onClick={()=>onNav(x.tab)} style={{background:T.card,border:`1px solid ${x.c}20`,borderRadius:14,padding:'12px 12px',textAlign:'left',cursor:'pointer'}}>
            <div style={{fontSize:18,marginBottom:5}}>{x.icon}</div>
            <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{x.l}</div>
            <div style={{color:T.muted,fontSize:10,marginTop:2}}>{x.d}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function MarketPage({prices,onNav,currency}:{prices:Asset[];onNav:(t:string)=>void;currency:string}) {
  const [filter,setFilter]=useState('전체');const [search,setSearch]=useState('');const [sort,setSort]=useState('change');const [selAsset,setSelAsset]=useState<Asset|null>(null);
  const [sel,setSel]=useState<Asset|null>(null);
  const typeMap:Record<string,string>={코인:'coin',지수:'index',미국주식:'stock',국내주식:'krstock',일본주식:'jpstock',중국주식:'cnstock',유럽주식:'eustock',ETF:'etf',원자재:'commodity',환율:'forex'};
  let list=filter==='전체'?prices:prices.filter(a=>a.t===typeMap[filter]);
  if(search){const q=search.toLowerCase();list=list.filter(a=>a.nameKr.includes(search)||a.name.toLowerCase().includes(q)||a.id.toLowerCase().includes(q)||a.sym.toLowerCase().includes(q));}
  if(sort==='change')list=[...list].sort((a,b)=>b.c-a.c);
  if(sort==='price')list=[...list].sort((a,b)=>b.p-a.p);
  return (
    <div>
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
          <div key={a.id} onClick={()=>setSelAsset(a)} style={{display:'grid',gridTemplateColumns:'1fr 60px 95px',padding:'11px 14px',borderBottom:i<list.length-1?`1px solid ${T.border}`:'none',alignItems:'center',cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}><Logo id={a.id} size={34} clr={a.clr}/><div><div style={{color:T.txt,fontWeight:600,fontSize:12}}>{a.nameKr}</div><div style={{display:'flex',gap:4,marginTop:2}}><span style={{color:T.muted,fontSize:10}}>{a.sym}</span><Bdg c={TYPE_COLOR[a.t]} ch={TYPE_LABEL[a.t]} sm/></div></div></div>
            <div style={{display:'flex',justifyContent:'center'}}><Spark pos={a.c>=0} w={52} h={24}/></div>
            <div style={{textAlign:'right'}}><div style={{color:T.txt,fontWeight:700,fontSize:11,fontFamily:'monospace'}}>{cvt(a.p,currency)}</div><div style={{color:a.c>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{fmtPct(a.c)}</div></div>
          </div>
        ))}
      </Card>
      <div style={{color:T.muted,fontSize:10,textAlign:'center',marginTop:8}}>총 {list.length}개 종목</div>
      {selAsset&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.7)',zIndex:100}} onClick={()=>setSelAsset(null)}/>
          <div style={{position:'fixed',zIndex:101,inset:'auto 0 0 0',background:T.bg,borderRadius:'20px 20px 0 0',overflowY:'auto',padding:'20px 14px 60px',maxWidth:480,margin:'0 auto'}} onClick={e=>e.stopPropagation()}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}><Logo id={selAsset.id} size={44} clr={selAsset.clr}/><div><div style={{color:T.txt,fontWeight:900,fontSize:16}}>{selAsset.nameKr}</div><div style={{color:T.muted,fontSize:11}}>{selAsset.sym} · {TYPE_LABEL[selAsset.t]}</div></div></div>
              <button onClick={()=>setSelAsset(null)} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,color:T.muted,padding:'5px 10px',cursor:'pointer',fontSize:12}}>닫기</button>
            </div>
            <div style={{marginBottom:14}}><div style={{color:T.txt,fontSize:26,fontWeight:900,fontFamily:'monospace'}}>{cvt(selAsset.p,currency)}</div><div style={{color:selAsset.c>=0?T.grn:T.red,fontWeight:800,fontSize:15,marginTop:4}}>{selAsset.c>=0?'▲':'▼'} {Math.abs(selAsset.c).toFixed(2)}%</div></div>
            <TradingChart asset={selAsset}/>
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
function WatchlistPage({prices,currency}:{prices:Asset[];currency:string}) {
  const LISTS=[
    {id:'국내주식',icon:'🇰🇷',color:T.red,assets:['SEC','SKH','NAVER','KAKAO','LGE','HYUN']},
    {id:'해외주식',icon:'🇺🇸',color:T.acc,assets:['MSFT','TSLA','AAPL','NVDA','AMD','AMZN','GOOGL','META','NFLX','PLTR']},
    {id:'코인',icon:'₿',color:'#F7931A',assets:['BTC','ETH','SOL','XRP','BNB','DOGE','ADA','AVAX','TON','LINK']},
    {id:'ETF',icon:'📦',color:T.grn,assets:['QQQ','SPY','ARKK','SOXL','TQQQ']},
    {id:'원자재',icon:'🥇',color:T.gld,assets:['GLD','SLV','WTI','BRENT']},
    {id:'환율',icon:'💱',color:T.cyn,assets:['USDKRW','USDJPY','EURUSD']},
  ];
  const [activeList,setActiveList]=useState(LISTS[0]);
  const listAssets=useMemo(()=>activeList.assets.map(id=>prices.find(a=>a.id===id)).filter(Boolean) as Asset[],[prices,activeList]);
  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
        <div style={{fontWeight:800,fontSize:16,color:T.txt}}>⭐ 왓치리스트</div>
        <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,padding:'5px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 추가</button>
      </div>
      <div style={{display:'flex',gap:8,overflowX:'auto',paddingBottom:8,marginBottom:14}}>
        {LISTS.map(l=><button key={l.id} onClick={()=>setActiveList(l)} style={{display:'flex',alignItems:'center',gap:6,flexShrink:0,padding:'6px 14px',borderRadius:20,background:activeList.id===l.id?l.color+'20':'transparent',color:activeList.id===l.id?l.color:T.muted,border:`1px solid ${activeList.id===l.id?l.color:T.border}`,fontWeight:600,fontSize:12,cursor:'pointer'}}><span>{l.icon}</span><span>{l.id}</span><span style={{fontSize:9,background:activeList.id===l.id?l.color+'30':'#1A2D4A',color:activeList.id===l.id?l.color:T.muted,borderRadius:99,padding:'1px 6px'}}>{l.assets.length}</span></button>)}
      </div>
      <Card style={{overflow:'hidden'}}>
        {listAssets.map((a,i)=>(
          <div key={a.id} style={{display:'grid',gridTemplateColumns:'1fr 60px 100px',padding:'12px 14px',borderBottom:i<listAssets.length-1?`1px solid ${T.border}`:'none',alignItems:'center',cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:10}}><Logo id={a.id} size={38} clr={a.clr}/><div><div style={{color:T.txt,fontWeight:700,fontSize:13}}>{a.nameKr}</div><div style={{color:T.muted,fontSize:10,marginTop:1}}>{a.sym}</div></div></div>
            <div style={{display:'flex',justifyContent:'center'}}><Spark pos={a.c>=0} w={56} h={26}/></div>
            <div style={{textAlign:'right'}}><div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>{cvt(a.p,currency)}</div><div style={{color:a.c>=0?T.grn:T.red,fontSize:11,fontWeight:700,marginTop:1}}>{a.c>=0?'▲':'▼'} {Math.abs(a.c).toFixed(2)}%</div></div>
          </div>
        ))}
      </Card>
    </div>
  );
}


/* ── Portfolio types ── */
interface DCAEntry { id:string; assetId:string; nameKr:string; clr:string; sym:string; amount:number; freq:'daily'|'weekly'|'monthly'; active:boolean; avgPrice:number; totalInvested:number; qty:number; targetPrice:number; nextBuy:string; }
interface LongPos  { id:string; assetId:string; nameKr:string; clr:string; sym:string; type:'spot'|'etf'|'dca'; avgPrice:number; qty:number; invested:number; targetPrice:number; stopPrice:number; note:string; addedAt:string; }
interface ShortPos { id:string; assetId:string; nameKr:string; clr:string; sym:string; side:'long'|'short'; entryPrice:number; qty:number; margin:number; leverage:number; takeProfitPrice:number; stopLossPrice:number; pnl:number; pnlPct:number; openedAt:string; strategy:string; }
interface Allocation { longPct:number; shortPct:number; cashPct:number; }

/* ── Donut Chart ── */
function DonutChart({slices,size=110}:{slices:{pct:number;color:string;label:string}[];size?:number}) {
  const r=38,cx=55,cy=55,circ=2*Math.PI*r;
  let off=0;
  return (
    <svg width={size} height={size} viewBox="0 0 110 110">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1A2D4A" strokeWidth="18"/>
      {slices.map((s,i)=>{const dash=circ*s.pct/100,gap=circ-dash;const el=<circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth="18" strokeDasharray={`${dash} ${gap}`} strokeDashoffset={-off} style={{transform:'rotate(-90deg)',transformOrigin:'55px 55px'}}/>;off+=dash;return el;})}
    </svg>
  );
}

/* ── MiniBar ── */
function MiniBar({pct,color}:{pct:number;color:string}) {
  return <div style={{height:6,background:'#1A2D4A',borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',width:pct+'%',background:color,borderRadius:3,transition:'width .6s'}}/></div>;
}

/* ── PortfolioPage (full dual system) ── */
function PortfolioPage({prices,currency}:{prices:Asset[];currency:string}) {
  const TOTAL = 50000000;
  const [mode,setMode] = useState<'all'|'long'|'short'|'cash'>('all');
  const [alloc,setAlloc] = useState<Allocation>({longPct:60,shortPct:30,cashPct:10});
  const [activePreset,setActivePreset] = useState('균형형');

  /* Mock positions */
  const [longPositions] = useState<LongPos[]>([
    {id:'l1',assetId:'BTC',nameKr:'비트코인',clr:'#F7931A',sym:'BTC/USDT',type:'dca',avgPrice:78400000,qty:0.38,invested:29792000,targetPrice:120000000,stopPrice:60000000,note:'반감기 이후 장기 보유',addedAt:'2024-01-15'},
    {id:'l2',assetId:'ETH',nameKr:'이더리움',clr:'#627EEA',sym:'ETH/USDT',type:'spot',avgPrice:4200000,qty:2.1,invested:8820000,targetPrice:8000000,stopPrice:3000000,note:'ETF 승인 이후 장기',addedAt:'2024-03-01'},
    {id:'l3',assetId:'NVDA',nameKr:'엔비디아',clr:'#76B900',sym:'NVDA',type:'spot',avgPrice:180,qty:15,invested:3888000,targetPrice:300,stopPrice:140,note:'AI 수혜 장기',addedAt:'2024-02-10'},
    {id:'l4',assetId:'SPY',nameKr:'S&P500 ETF',clr:'#6366F1',sym:'SPY',type:'etf',avgPrice:520,qty:8,invested:6048000,targetPrice:700,stopPrice:450,note:'지수 분산투자',addedAt:'2024-06-01'},
    {id:'l5',assetId:'GLD',nameKr:'금',clr:'#D97706',sym:'GOLD',type:'spot',avgPrice:2800,qty:3,invested:1224000,targetPrice:4000,stopPrice:2200,note:'안전자산 헤지',addedAt:'2024-04-01'},
  ]);

  const [dcaPlans] = useState<DCAEntry[]>([
    {id:'d1',assetId:'BTC',nameKr:'비트코인',clr:'#F7931A',sym:'BTC/USDT',amount:300000,freq:'weekly',active:true,avgPrice:78400000,totalInvested:7200000,qty:0.092,targetPrice:150000000,nextBuy:'2025-05-16'},
    {id:'d2',assetId:'ETH',nameKr:'이더리움',clr:'#627EEA',sym:'ETH/USDT',amount:200000,freq:'weekly',active:true,avgPrice:4200000,totalInvested:4800000,qty:1.14,targetPrice:10000000,nextBuy:'2025-05-16'},
    {id:'d3',assetId:'SPY',nameKr:'S&P500 ETF',clr:'#6366F1',sym:'SPY',amount:500000,freq:'monthly',active:true,avgPrice:520,totalInvested:3000000,qty:8.33,targetPrice:700,nextBuy:'2025-06-01'},
  ]);

  const [shortPositions] = useState<ShortPos[]>([
    {id:'s1',assetId:'SOL',nameKr:'솔라나',clr:'#9945FF',sym:'SOL/USDT',side:'long',entryPrice:195000,qty:5,margin:975000,leverage:3,takeProfitPrice:240000,stopLossPrice:180000,pnl:75000,pnlPct:7.69,openedAt:'2025-05-10T09:00:00',strategy:'EMA 추세 추종'},
    {id:'s2',assetId:'BNB',nameKr:'바이낸스',clr:'#F0B90B',sym:'BNB/USDT',side:'long',entryPrice:840000,qty:1,margin:840000,leverage:2,takeProfitPrice:950000,stopLossPrice:800000,pnl:-12000,pnlPct:-1.43,openedAt:'2025-05-11T14:00:00',strategy:'RSI 반등'},
    {id:'s3',assetId:'AMD',nameKr:'AMD',clr:'#ED1C24',sym:'AMD',side:'long',entryPrice:390,qty:5,margin:2808000,leverage:1,takeProfitPrice:450,stopLossPrice:360,pnl:224400,pnlPct:8.0,openedAt:'2025-05-08T10:00:00',strategy:'어닝 모멘텀'},
  ]);

  const longValue = useMemo(()=>longPositions.reduce((s,p)=>{const a=prices.find(x=>x.id===p.assetId);return s+(a?a.p*p.qty:p.invested);},[]),[longPositions,prices]);
  const shortValue = useMemo(()=>shortPositions.reduce((s,p)=>s+p.margin+p.pnl,0),[shortPositions]);
  const cashValue = TOTAL * alloc.cashPct / 100;
  const totalValue = longValue + shortValue + cashValue;
  const longPnl = useMemo(()=>longPositions.reduce((s,p)=>{const a=prices.find(x=>x.id===p.assetId);return s+(a?a.p*p.qty-p.invested:0);},[]),[longPositions,prices]);
  const shortPnl = useMemo(()=>shortPositions.reduce((s,p)=>s+p.pnl,0),[shortPositions]);
  const totalPnl = longPnl + shortPnl;

  const PRESETS:{name:string;l:number;s:number;c:number}[] = [
    {name:'안정형',l:80,s:10,c:10},
    {name:'균형형',l:60,s:30,c:10},
    {name:'공격형',l:40,s:50,c:10},
    {name:'자동매매형',l:30,s:60,c:10},
  ];

  const applyPreset=(p:{name:string;l:number;s:number;c:number})=>{
    setAlloc({longPct:p.l,shortPct:p.s,cashPct:p.c});
    setActivePreset(p.name);
  };

  const donutSlices=[
    {pct:alloc.longPct,color:'#3B82F6',label:'장투'},
    {pct:alloc.shortPct,color:'#F59E0B',label:'단타'},
    {pct:alloc.cashPct,color:'#10B981',label:'현금'},
  ];

  /* ── ALL view ── */
  if(mode==='all') return (
    <div>
      {/* Header banner */}
      <div style={{background:'linear-gradient(135deg,#0D1A35,#091228)',border:`1px solid ${T.border2}`,borderRadius:22,padding:'20px 18px',marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}><Dot c={T.grn}/><span style={{color:T.muted,fontSize:11,fontWeight:600}}>헤지펀드 스타일 포트폴리오 · 🎮 모의</span></div>
        <div style={{color:T.muted,fontSize:12,marginBottom:2}}>총 평가 자산</div>
        <div style={{color:T.txt,fontSize:32,fontWeight:900,fontFamily:'monospace',letterSpacing:-2}}>{cvt(totalValue,currency)}</div>
        <div style={{display:'flex',alignItems:'center',gap:10,marginTop:6}}>
          <span style={{color:totalPnl>=0?T.grn:T.red,fontWeight:700,fontSize:13}}>{totalPnl>=0?'▲':'▼'} {cvt(Math.abs(totalPnl),currency)}</span>
          <Bdg c={totalPnl>=0?T.grn:T.red} ch={fmtPct(totalPnl/TOTAL*100)}/>
        </div>
      </div>

      {/* Mode switcher */}
      <div style={{display:'flex',gap:6,marginBottom:14,overflowX:'auto'}}>
        {([['all','전체','📊'],['long','장투','📈'],['short','단타','⚡'],['cash','현금','💵']] as const).map(([id,label,icon])=>(
          <button key={id} onClick={()=>setMode(id)} style={{flexShrink:0,padding:'7px 14px',background:mode===id?T.acg:'transparent',color:mode===id?T.acl:T.muted,border:`1px solid ${mode===id?T.acl:T.border}`,borderRadius:20,fontWeight:700,fontSize:12,cursor:'pointer'}}>
            {icon} {label}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}}>
        <Card style={{padding:'14px 16px',cursor:'pointer'}} glow={false}>
          <div onClick={()=>setMode('long')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}><span style={{fontSize:16}}>📈</span><div style={{color:T.muted,fontSize:10,fontWeight:700}}>장투 포트폴리오</div></div>
            <div style={{color:T.txt,fontSize:16,fontWeight:900,fontFamily:'monospace'}}>{cvt(longValue,currency)}</div>
            <div style={{color:longPnl>=0?T.grn:T.red,fontSize:11,fontWeight:700,marginTop:3}}>{longPnl>=0?'+':''}{cvt(Math.abs(longPnl),currency)}</div>
            <div style={{marginTop:8}}><MiniBar pct={alloc.longPct} color={T.acl}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 {alloc.longPct}% · 레버리지 없음</div>
          </div>
        </Card>
        <Card style={{padding:'14px 16px',cursor:'pointer'}}>
          <div onClick={()=>setMode('short')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}><span style={{fontSize:16}}>⚡</span><div style={{color:T.muted,fontSize:10,fontWeight:700}}>단타 포트폴리오</div></div>
            <div style={{color:T.txt,fontSize:16,fontWeight:900,fontFamily:'monospace'}}>{cvt(shortValue,currency)}</div>
            <div style={{color:shortPnl>=0?T.grn:T.red,fontSize:11,fontWeight:700,marginTop:3}}>{shortPnl>=0?'+':''}{cvt(Math.abs(shortPnl),currency)}</div>
            <div style={{marginTop:8}}><MiniBar pct={alloc.shortPct} color={T.ylw}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 {alloc.shortPct}% · 최대 10배</div>
          </div>
        </Card>
        <Card style={{padding:'14px 16px'}}>
          <div onClick={()=>setMode('cash')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}><span style={{fontSize:16}}>💵</span><div style={{color:T.muted,fontSize:10,fontWeight:700}}>대기 현금</div></div>
            <div style={{color:T.txt,fontSize:16,fontWeight:900,fontFamily:'monospace'}}>{cvt(cashValue,currency)}</div>
            <div style={{color:T.grn,fontSize:11,fontWeight:700,marginTop:3}}>기회 대기 중</div>
            <div style={{marginTop:8}}><MiniBar pct={alloc.cashPct} color={T.grn}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 {alloc.cashPct}%</div>
          </div>
        </Card>
        <Card style={{padding:'14px 16px'}}>
          <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>📊 자산 배분</div>
          <div style={{display:'flex',justifyContent:'center',marginBottom:6}}>
            <DonutChart slices={donutSlices}/>
          </div>
          <div style={{display:'flex',gap:8,justifyContent:'center'}}>
            {donutSlices.map(s=><div key={s.label} style={{display:'flex',alignItems:'center',gap:3}}><div style={{width:7,height:7,borderRadius:'50%',background:s.color}}/><span style={{color:T.muted,fontSize:9}}>{s.label} {s.pct}%</span></div>)}
          </div>
        </Card>
      </div>

      {/* Allocation presets */}
      <Card style={{padding:'14px 16px',marginBottom:14}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>⚙️ 배분 프리셋</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8,marginBottom:14}}>
          {PRESETS.map(p=>(
            <button key={p.name} onClick={()=>applyPreset(p)} style={{background:activePreset===p.name?T.acg:T.alt,border:`1px solid ${activePreset===p.name?T.acl:T.border}`,borderRadius:12,padding:'10px 12px',cursor:'pointer',textAlign:'left'}}>
              <div style={{color:activePreset===p.name?T.acl:T.txt,fontWeight:700,fontSize:12,marginBottom:3}}>{p.name}</div>
              <div style={{color:T.muted,fontSize:10}}>장투 {p.l}% · 단타 {p.s}% · 현금 {p.c}%</div>
            </button>
          ))}
        </div>
        <div style={{color:T.muted,fontSize:11,marginBottom:6}}>직접 조정</div>
        {([['longPct','📈 장투',T.acl],['shortPct','⚡ 단타',T.ylw],['cashPct','💵 현금',T.grn]] as const).map(([key,label,color])=>(
          <div key={key} style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
              <span style={{color:T.sub,fontSize:11}}>{label}</span>
              <span style={{color,fontWeight:800,fontSize:11,fontFamily:'monospace'}}>{alloc[key as keyof Allocation]}%</span>
            </div>
            <input type="range" min={0} max={100} value={alloc[key as keyof Allocation]} onChange={e=>{
              const v=+e.target.value;
              if(key==='longPct') setAlloc(a=>{const r=100-v;const ratio=a.shortPct/(a.shortPct+a.cashPct||1);return{longPct:v,shortPct:Math.round(r*ratio),cashPct:Math.round(r*(1-ratio))};});
              else if(key==='shortPct') setAlloc(a=>{const r=100-a.longPct;const c=Math.max(0,r-v);return{...a,shortPct:Math.min(v,r),cashPct:c};});
              else setAlloc(a=>{const r=100-a.longPct;const s=Math.max(0,r-v);return{...a,shortPct:s,cashPct:Math.min(v,r)};});
            }} style={{width:'100%',accentColor:color}}/>
          </div>
        ))}
      </Card>

      {/* Beginner guide */}
      <Card style={{padding:'14px 16px',border:`1px solid ${T.prp}30`}}>
        <div style={{color:T.prp,fontWeight:700,fontSize:12,marginBottom:10}}>💡 초보자 가이드</div>
        {[{t:'📈 장투 = 자산 불리기',d:'BTC·ETH·ETF를 오래 보유해 자산을 불립니다. 변동성에 흔들리지 않고 DCA로 꾸준히 매수.'},
          {t:'⚡ 단타 = 현금흐름 만들기',d:'단기 가격 변동을 이용해 수익을 추구합니다. 엄격한 손절과 익절이 필수.'},
          {t:'💵 현금 = 기회 대기',d:'큰 하락이나 좋은 매수 기회를 기다리는 자금. 급락 시 즉시 투입 가능.'},
        ].map(g=>(
          <div key={g.t} style={{marginBottom:10,paddingBottom:10,borderBottom:`1px solid ${T.border}`}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:3}}>{g.t}</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6}}>{g.d}</div>
          </div>
        ))}
        <div style={{color:T.ylw,fontSize:10,fontWeight:600}}>⚠️ 모의투자 전용 · 수익 보장 없음 · 투자 손실은 본인 책임</div>
      </Card>
    </div>
  );

  /* ── LONG-TERM view ── */
  if(mode==='long') return (
    <div>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
        <button onClick={()=>setMode('all')} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,padding:'5px 10px',color:T.muted,fontSize:12,cursor:'pointer'}}>← 전체</button>
        <div style={{color:T.txt,fontWeight:800,fontSize:16}}>📈 장투 포트폴리오</div>
      </div>

      {/* Long-term summary */}
      <div style={{background:'linear-gradient(135deg,#0A1628,#0D1F3C)',border:`1px solid ${T.acl}30`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
        <div style={{color:T.muted,fontSize:11,marginBottom:2}}>장투 총 가치</div>
        <div style={{color:T.txt,fontSize:26,fontWeight:900,fontFamily:'monospace'}}>{cvt(longValue,currency)}</div>
        <div style={{display:'flex',gap:16,marginTop:8}}>
          <div><div style={{color:T.muted,fontSize:10}}>수익</div><div style={{color:longPnl>=0?T.grn:T.red,fontWeight:800,fontSize:13}}>{longPnl>=0?'+':''}{cvt(Math.abs(longPnl),currency)}</div></div>
          <div><div style={{color:T.muted,fontSize:10}}>수익률</div><div style={{color:T.grn,fontWeight:800,fontSize:13}}>+{(longPnl/longPositions.reduce((s,p)=>s+p.invested,0)*100).toFixed(2)}%</div></div>
          <div><div style={{color:T.muted,fontSize:10}}>보유 종목</div><div style={{color:T.txt,fontWeight:800,fontSize:13}}>{longPositions.length}개</div></div>
        </div>
      </div>

      {/* Positions */}
      <Card style={{overflow:'hidden',marginBottom:14}}>
        <div style={{padding:'12px 14px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{color:T.txt,fontWeight:700,fontSize:13}}>보유 자산</div>
          <Bdg c={T.acl} ch="레버리지 없음 · 스팟"/>
        </div>
        {longPositions.map((p,i)=>{
          const a=prices.find(x=>x.id===p.assetId);
          const curPrice=a?a.p:p.avgPrice;
          const curValue=curPrice*p.qty;
          const pnl=curValue-p.invested;
          const pnlPct=pnl/p.invested*100;
          const tpPct=Math.min(100,(curPrice-p.avgPrice)/(p.targetPrice-p.avgPrice)*100);
          return (
            <div key={p.id} style={{padding:'14px',borderBottom:i<longPositions.length-1?`1px solid ${T.border}`:'none'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <Logo id={p.assetId} size={36} clr={p.clr}/>
                  <div>
                    <div style={{display:'flex',gap:5,alignItems:'center'}}><span style={{color:T.txt,fontWeight:700,fontSize:13}}>{p.nameKr}</span><Bdg c={p.type==='dca'?T.prp:p.type==='etf'?T.grn:T.cyn} ch={p.type==='dca'?'DCA':p.type==='etf'?'ETF':'스팟'} sm/></div>
                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>평균단가 {cvt(p.avgPrice,currency)} · {p.qty.toFixed(4)} {p.sym.split('/')[0]}</div>
                  </div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>{cvt(curValue,currency)}</div>
                  <div style={{color:pnl>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{pnl>=0?'+':''}{fmtPct(pnlPct)}</div>
                </div>
              </div>
              {/* Target progress */}
              <div style={{marginBottom:6}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{color:T.muted,fontSize:10}}>목표가 달성도</span>
                  <span style={{color:T.ylw,fontSize:10,fontWeight:700}}>{Math.max(0,tpPct).toFixed(1)}%</span>
                </div>
                <MiniBar pct={Math.max(0,Math.min(100,tpPct))} color={T.ylw}/>
                <div style={{display:'flex',justifyContent:'space-between',marginTop:2}}>
                  <span style={{color:T.muted,fontSize:9}}>현재 {cvt(curPrice,currency)}</span>
                  <span style={{color:T.grn,fontSize:9}}>목표 {cvt(p.targetPrice,currency)}</span>
                </div>
              </div>
              <div style={{color:T.muted,fontSize:10,display:'flex',gap:6,flexWrap:'wrap'}}>
                <span>손절가 {cvt(p.stopPrice,currency)}</span>
                <span>·</span>
                <span style={{color:T.sub}}>{p.note}</span>
              </div>
            </div>
          );
        })}
      </Card>

      {/* DCA Plans */}
      <Card style={{overflow:'hidden',marginBottom:14}}>
        <div style={{padding:'12px 14px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{color:T.txt,fontWeight:700,fontSize:13}}>🔄 DCA 적립 계획</div>
          <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 추가</button>
        </div>
        {dcaPlans.map((d,i)=>(
          <div key={d.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 14px',borderBottom:i<dcaPlans.length-1?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <Logo id={d.assetId} size={30} clr={d.clr}/>
              <div>
                <div style={{color:T.txt,fontWeight:600,fontSize:12}}>{d.nameKr}</div>
                <div style={{color:T.muted,fontSize:10}}>
                  {cvt(d.amount,currency)}/{d.freq==='weekly'?'주':d.freq==='monthly'?'월':'일'} · 총 {cvt(d.totalInvested,currency)}
                </div>
                <div style={{color:T.muted,fontSize:9,marginTop:1}}>다음 매수: {d.nextBuy}</div>
              </div>
            </div>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <div style={{textAlign:'right'}}>
                <div style={{color:T.txt,fontSize:11,fontWeight:700}}>{d.qty.toFixed(4)} {d.sym.split('/')[0]}</div>
                <div style={{color:T.muted,fontSize:9}}>평균 {cvt(d.avgPrice,currency)}</div>
              </div>
              <div style={{width:8,height:8,borderRadius:'50%',background:d.active?T.grn:T.muted,animation:d.active?'pulse 1.5s infinite':undefined}}/>
            </div>
          </div>
        ))}
      </Card>

      {/* Long-term risk */}
      <Card style={{padding:'14px 16px',border:`1px solid ${T.grn}30`}}>
        <div style={{color:T.grn,fontWeight:700,fontSize:12,marginBottom:10}}>🛡️ 장투 리스크 설정</div>
        {[
          {l:'최대 단일자산 집중도',v:'40%',status:'정상'},
          {l:'월 최대 매수 한도',v:cvt(3000000,currency),status:'정상'},
          {l:'리밸런싱 주기',v:'3개월',status:'예정 2025-07'},
          {l:'청산 리스크',v:'없음 (레버리지 0)',status:'안전'},
        ].map((r,i)=>(
          <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'7px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
            <span style={{color:T.sub,fontSize:11}}>{r.l}</span>
            <div style={{textAlign:'right'}}><span style={{color:T.txt,fontSize:11,fontWeight:600}}>{r.v}</span><Bdg c={T.grn} ch={r.status} sm/></div>
          </div>
        ))}
      </Card>
    </div>
  );

  /* ── SHORT-TERM view ── */
  if(mode==='short') return (
    <div>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
        <button onClick={()=>setMode('all')} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,padding:'5px 10px',color:T.muted,fontSize:12,cursor:'pointer'}}>← 전체</button>
        <div style={{color:T.txt,fontWeight:800,fontSize:16}}>⚡ 단타 포트폴리오</div>
      </div>

      {/* Short summary */}
      <div style={{background:'linear-gradient(135deg,#1A0A00,#1A1000)',border:`1px solid ${T.ylw}30`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:4}}><Dot c={T.ylw}/><span style={{color:T.muted,fontSize:11}}>단타/스윙 모드 · 🎮 모의</span></div>
        <div style={{color:T.muted,fontSize:11,marginBottom:2}}>단타 총 포지션</div>
        <div style={{color:T.txt,fontSize:26,fontWeight:900,fontFamily:'monospace'}}>{cvt(shortValue,currency)}</div>
        <div style={{display:'flex',gap:16,marginTop:8}}>
          <div><div style={{color:T.muted,fontSize:10}}>미실현 PnL</div><div style={{color:shortPnl>=0?T.grn:T.red,fontWeight:800}}>{shortPnl>=0?'+':''}{cvt(Math.abs(shortPnl),currency)}</div></div>
          <div><div style={{color:T.muted,fontSize:10}}>활성 포지션</div><div style={{color:T.txt,fontWeight:800}}>{shortPositions.length}개</div></div>
          <div><div style={{color:T.muted,fontSize:10}}>오늘 승률</div><div style={{color:T.grn,fontWeight:800}}>67%</div></div>
        </div>
      </div>

      {/* Risk meter */}
      <Card style={{padding:'14px 16px',marginBottom:14,border:`1px solid ${T.red}20`}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>🔴 단타 리스크 현황</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {[
            {l:'일일 최대 손실',v:cvt(500000,currency),used:cvt(shortPnl<0?Math.abs(shortPnl):0,currency),pct:shortPnl<0?Math.abs(shortPnl)/500000*100:0,c:T.red},
            {l:'오픈 포지션',v:'5개 한도',used:`${shortPositions.length}개`,pct:shortPositions.length/5*100,c:T.ylw},
            {l:'최대 레버리지',v:'10배 한도',used:'3배',pct:30,c:T.grn},
            {l:'연속 손실',v:'3회 한도',used:'0회',pct:0,c:T.grn},
          ].map(r=>(
            <div key={r.l} style={{background:T.alt,borderRadius:10,padding:'10px 12px'}}>
              <div style={{color:T.muted,fontSize:10,marginBottom:4}}>{r.l}</div>
              <div style={{color:T.txt,fontSize:11,fontWeight:700,marginBottom:6}}>{r.used} / {r.v}</div>
              <MiniBar pct={r.pct} color={r.pct>70?T.red:r.pct>40?T.ylw:T.grn}/>
            </div>
          ))}
        </div>
        <div style={{marginTop:10,background:'rgba(239,68,68,.08)',border:`1px solid ${T.red}20`,borderRadius:8,padding:'8px 12px'}}>
          <div style={{color:T.red,fontSize:10,fontWeight:700}}>⚠️ 긴급 정지 조건: 일일 손실 500,000원 초과 시 자동 매매 중단</div>
        </div>
      </Card>

      {/* Active positions */}
      <Card style={{overflow:'hidden',marginBottom:14}}>
        <div style={{padding:'12px 14px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{color:T.txt,fontWeight:700,fontSize:13}}>활성 포지션</div>
          <button style={{background:T.ylw+'15',color:T.ylw,border:`1px solid ${T.ylw}30`,borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 신규 진입</button>
        </div>
        {shortPositions.map((p,i)=>(
          <div key={p.id} style={{padding:'14px',borderBottom:i<shortPositions.length-1?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <Logo id={p.assetId} size={34} clr={p.clr}/>
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center'}}>
                    <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{p.nameKr}</span>
                    <Bdg c={p.side==='long'?T.grn:T.red} ch={p.side==='long'?'롱':'숏'} sm/>
                    <Bdg c={T.ylw} ch={`${p.leverage}x`} sm/>
                  </div>
                  <div style={{color:T.muted,fontSize:10,marginTop:1}}>{p.strategy} · 진입 {cvt(p.entryPrice,currency)}</div>
                </div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{color:p.pnl>=0?T.grn:T.red,fontWeight:900,fontSize:14,fontFamily:'monospace'}}>{p.pnl>=0?'+':''}{cvt(Math.abs(p.pnl),currency)}</div>
                <div style={{color:p.pnl>=0?T.grn:T.red,fontSize:11}}>{fmtPct(p.pnlPct)}</div>
              </div>
            </div>
            {/* TP/SL bars */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:6}}>
              <div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}><span style={{color:T.muted,fontSize:9}}>익절가</span><span style={{color:T.grn,fontSize:9,fontWeight:700}}>{cvt(p.takeProfitPrice,currency)}</span></div>
                <MiniBar pct={p.pnl>=0?Math.min(100,p.pnlPct/(p.takeProfitPrice/p.entryPrice-1)*100*0.01):0} color={T.grn}/>
              </div>
              <div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}><span style={{color:T.muted,fontSize:9}}>손절가</span><span style={{color:T.red,fontSize:9,fontWeight:700}}>{cvt(p.stopLossPrice,currency)}</span></div>
                <MiniBar pct={5} color={T.red}/>
              </div>
            </div>
            <div style={{display:'flex',gap:6}}>
              <button style={{flex:1,background:T.grn+'15',color:T.grn,border:`1px solid ${T.grn}30`,borderRadius:8,padding:'5px',fontSize:10,fontWeight:700,cursor:'pointer'}}>익절 청산</button>
              <button style={{flex:1,background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:8,padding:'5px',fontSize:10,fontWeight:700,cursor:'pointer'}}>손절 청산</button>
            </div>
          </div>
        ))}
      </Card>

      {/* Strategy status */}
      <Card style={{padding:'14px 16px',marginBottom:14}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>🤖 단타 전략 현황</div>
        {[
          {name:'EMA 추세 추종',active:true,win:'67%',today:'+₩87,000'},
          {name:'RSI 반등 매매',active:true,win:'58%',today:'-₩12,000'},
          {name:'브레이크아웃',active:false,win:'71%',today:'-'},
          {name:'펀딩비 전략',active:false,win:'--',today:'준비중'},
        ].map((s,i)=>(
          <div key={s.name} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <div style={{width:6,height:6,borderRadius:'50%',background:s.active?T.grn:T.muted}}/>
              <span style={{color:T.txt,fontSize:12,fontWeight:600}}>{s.name}</span>
            </div>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <span style={{color:T.muted,fontSize:10}}>승률 {s.win}</span>
              <span style={{color:s.today.startsWith('+')?T.grn:s.today.startsWith('-')?T.red:T.muted,fontSize:11,fontWeight:700}}>{s.today}</span>
            </div>
          </div>
        ))}
      </Card>

      {/* Short-term history */}
      <Card style={{padding:'14px 16px'}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>📋 오늘의 매매 기록</div>
        {[
          {sym:'SOL',side:'매수',pnl:'+₩45,000',pct:'+4.2%',time:'09:32',strat:'EMA'},
          {sym:'BNB',side:'매수',pnl:'-₩12,000',pct:'-1.4%',time:'11:15',strat:'RSI'},
          {sym:'AMD',side:'매수',pnl:'+₩54,000',pct:'+8.0%',time:'14:22',strat:'모멘텀'},
        ].map((h,i)=>(
          <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<2?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <Logo id={h.sym} size={24} clr='#94A3B8'/>
              <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{h.sym} {h.side}</div><div style={{color:T.muted,fontSize:10}}>{h.time} · {h.strat}</div></div>
            </div>
            <div style={{textAlign:'right'}}><div style={{color:h.pnl.startsWith('+')?T.grn:T.red,fontWeight:700,fontSize:12}}>{h.pnl}</div><div style={{color:h.pct.startsWith('+')?T.grn:T.red,fontSize:10}}>{h.pct}</div></div>
          </div>
        ))}
      </Card>
    </div>
  );

  /* ── CASH view ── */
  return (
    <div>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
        <button onClick={()=>setMode('all')} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,padding:'5px 10px',color:T.muted,fontSize:12,cursor:'pointer'}}>← 전체</button>
        <div style={{color:T.txt,fontWeight:800,fontSize:16}}>💵 대기 현금</div>
      </div>
      <div style={{background:'linear-gradient(135deg,#0A1A0A,#081208)',border:`1px solid ${T.grn}30`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
        <div style={{color:T.muted,fontSize:11,marginBottom:2}}>대기 현금 잔고</div>
        <div style={{color:T.txt,fontSize:28,fontWeight:900,fontFamily:'monospace'}}>{cvt(cashValue,currency)}</div>
        <div style={{color:T.grn,fontSize:12,fontWeight:600,marginTop:6}}>🎯 매수 기회 대기 중</div>
      </div>
      <Card style={{padding:'14px 16px',marginBottom:14}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>⚡ 빠른 투입 버튼</div>
        {[
          {l:'장투 포트폴리오에 추가',pct:50,color:T.acl},
          {l:'단타 진입 자금 활용',pct:30,color:T.ylw},
          {l:'급락 매수 기회 대기',pct:20,color:T.grn},
        ].map((b,i)=>(
          <button key={i} style={{width:'100%',display:'flex',justifyContent:'space-between',alignItems:'center',background:T.alt,border:`1px solid ${T.border}`,borderRadius:12,padding:'12px 14px',cursor:'pointer',marginBottom:8}}>
            <span style={{color:T.txt,fontSize:12,fontWeight:600}}>{b.l}</span>
            <div style={{display:'flex',gap:6,alignItems:'center'}}><span style={{color:b.color,fontSize:11,fontWeight:700}}>{b.pct}%</span><span style={{color:b.color,fontSize:14}}>→</span></div>
          </button>
        ))}
      </Card>
      <Card style={{padding:'14px 16px',border:`1px solid ${T.grn}30`}}>
        <div style={{color:T.grn,fontWeight:700,fontSize:12,marginBottom:8}}>💡 현금 보유 전략</div>
        <div style={{color:T.muted,fontSize:11,lineHeight:1.8}}>
          현금은 투자 기회를 기다리는 전략적 자산입니다.<br/>
          • 시장 급락 시 (10-20% 하락) 장투 포트폴리오에 즉시 투입<br/>
          • 단타 좋은 신호 발생 시 빠르게 진입 가능<br/>
          • 총 자산의 10-20% 유지를 권장합니다<br/>
          ⚠️ 모의투자 전용 · 수익 보장 없음
        </div>
      </Card>
    </div>
  );
}
/* ── TradingPage (Pro Terminal) ── */
/* Leverage recommendation engine */
function getLeverageRec(asset:Asset, riskProfile:'conservative'|'balanced'|'aggressive') {
  const vol = Math.abs(asset.c);
  const base = riskProfile==='conservative' ? 1 : riskProfile==='balanced' ? 5 : 15;
  if (vol > 6) return { rec: Math.max(1, Math.floor(base*0.4)), level:'위험', color:'#EF4444', score: 30 };
  if (vol > 3) return { rec: Math.max(2, Math.floor(base*0.7)), level:'주의', color:'#F59E0B', score: 60 };
  return { rec: base, level:'안전', color:'#10B981', score: 85 };
}

function LiquidationCalc({entryPrice,leverage,side,currency}:{entryPrice:number;leverage:number;side:string;currency:string}) {
  const liqPct = side==='매수' ? -(100/leverage)*0.9 : (100/leverage)*0.9;
  const liqPrice = entryPrice * (1 + liqPct/100);
  const dist = Math.abs(liqPct);
  const danger = dist < 10;
  return (
    <div style={{background:danger?T.red+'15':T.alt,border:`1px solid ${danger?T.red:T.border}30`,borderRadius:10,padding:'10px 12px'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
        <span style={{color:danger?T.red:T.muted,fontSize:11,fontWeight:700}}>⚡ 청산가 예상</span>
        <Bdg c={danger?T.red:T.ylw} ch={danger?'위험':'주의'}/>
      </div>
      <div style={{color:danger?T.red:T.txt,fontSize:16,fontWeight:900,fontFamily:'monospace'}}>{cvt(liqPrice,currency)}</div>
      <div style={{color:T.muted,fontSize:10,marginTop:3}}>진입가 대비 {dist.toFixed(1)}% 하락 시 청산</div>
      <div style={{marginTop:6,height:4,background:'#1A2D4A',borderRadius:2}}>
        <div style={{height:'100%',width:Math.min(100,dist*3)+'%',background:danger?T.red:dist<20?T.ylw:T.grn,borderRadius:2,transition:'width .4s'}}/>
      </div>
    </div>
  );
}

function PositionSizer({balance,currency}:{balance:number;currency:string}) {
  const [riskPct,setRiskPct]=useState(2);
  const [slPct,setSlPct]=useState(5);
  const [mode,setMode]=useState<'conservative'|'balanced'|'aggressive'>('balanced');
  const modeMulti = mode==='conservative' ? 0.5 : mode==='balanced' ? 1 : 2;
  const maxLoss = balance * riskPct / 100;
  const posSize = (maxLoss / (slPct/100)) * modeMulti;
  const suggestLev = Math.max(1, Math.min(20, Math.round(modeMulti * 3)));
  return (
    <div>
      <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:10}}>🎯 자동 포지션 사이징</div>
      <div style={{display:'flex',gap:6,marginBottom:12}}>
        {(['conservative','balanced','aggressive'] as const).map(m=>(
          <button key={m} onClick={()=>setMode(m)} style={{flex:1,padding:'7px 4px',background:mode===m?T.acg:'transparent',color:mode===m?T.acl:T.muted,border:`1px solid ${mode===m?T.acl:T.border}`,borderRadius:10,fontSize:10,fontWeight:700,cursor:'pointer'}}>
            {m==='conservative'?'보수형':m==='balanced'?'균형형':'공격형'}
          </button>
        ))}
      </div>
      <div style={{marginBottom:10}}>
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}><span style={{color:T.muted,fontSize:11}}>위험 비율</span><span style={{color:T.ylw,fontWeight:800,fontSize:11}}>{riskPct}%</span></div>
        <input type="range" min={0.5} max={10} step={0.5} value={riskPct} onChange={e=>setRiskPct(+e.target.value)} style={{width:'100%',accentColor:T.ylw}}/>
      </div>
      <div style={{marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}><span style={{color:T.muted,fontSize:11}}>손절 %</span><span style={{color:T.red,fontWeight:800,fontSize:11}}>{slPct}%</span></div>
        <input type="range" min={1} max={20} value={slPct} onChange={e=>setSlPct(+e.target.value)} style={{width:'100%',accentColor:T.red}}/>
      </div>
      <div style={{background:T.alt,borderRadius:10,padding:'10px 12px',border:`1px solid ${T.border}`}}>
        {[
          {l:'최대 손실 허용',v:cvt(maxLoss,currency),c:T.red},
          {l:'권장 포지션',v:cvt(Math.min(posSize,balance),currency),c:T.acl},
          {l:'권장 레버리지',v:`${suggestLev}x`,c:T.ylw},
        ].map((r,i)=>(
          <div key={i} style={{display:'flex',justifyContent:'space-between',marginBottom:i<2?5:0}}>
            <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
            <span style={{color:r.c,fontWeight:800,fontSize:11,fontFamily:'monospace'}}>{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RiskDashboard({positions,prices}:{positions:any[];prices:Asset[]}) {
  const [stressMode,setStressMode]=useState('-20%');
  const stressPcts:Record<string,number>={'-10%':-10,'-20%':-20,'-40%':-40,'크래시':-60};
  const stressedPnl = positions.reduce((s,p)=>{
    const a=prices.find(x=>x.id===p.assetId);
    if(!a)return s;
    const stressed=a.p*(1+stressPcts[stressMode]/100);
    return s+(stressed-p.entryPrice)*p.qty*p.leverage*(p.side==='long'?1:-1);
  },0);
  const riskScore = Math.max(0, Math.min(100, 70 - positions.reduce((s,p)=>s+p.leverage*5,0)));
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:4}}>🔥 리스크 대시보드</div>
      {/* Risk gauge */}
      <div style={{background:T.alt,borderRadius:12,padding:'12px 14px'}}>
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
          <span style={{color:T.muted,fontSize:11}}>리스크 점수</span>
          <span style={{color:riskScore>60?T.grn:riskScore>30?T.ylw:T.red,fontWeight:800,fontSize:12}}>{riskScore}/100</span>
        </div>
        <div style={{height:8,background:'#1A2D4A',borderRadius:4,overflow:'hidden'}}>
          <div style={{height:'100%',width:riskScore+'%',background:riskScore>60?T.grn:riskScore>30?T.ylw:T.red,borderRadius:4,transition:'width .6s'}}/>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:3}}>
          <span style={{color:T.red,fontSize:9}}>위험</span><span style={{color:T.grn,fontSize:9}}>안전</span>
        </div>
      </div>
      {/* Stress test */}
      <div style={{background:T.alt,borderRadius:12,padding:'12px 14px'}}>
        <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:8}}>📉 스트레스 테스트</div>
        <div style={{display:'flex',gap:5,marginBottom:10,flexWrap:'wrap'}}>
          {Object.keys(stressPcts).map(k=><button key={k} onClick={()=>setStressMode(k)} style={{background:stressMode===k?T.red+'25':'transparent',color:stressMode===k?T.red:T.muted,border:`1px solid ${stressMode===k?T.red:T.border}`,borderRadius:8,padding:'3px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{k}</button>)}
        </div>
        <div style={{color:stressedPnl>=0?T.grn:T.red,fontSize:18,fontWeight:900,fontFamily:'monospace'}}>{stressedPnl>=0?'+':''}{cvt(Math.abs(stressedPnl),'KRW')}</div>
        <div style={{color:T.muted,fontSize:10,marginTop:2}}>{stressMode} 시나리오 예상 손익</div>
      </div>
      {/* Exposure */}
      <div style={{background:T.alt,borderRadius:12,padding:'12px 14px'}}>
        <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:8}}>📊 레버리지 노출도</div>
        {positions.slice(0,3).map((p,i)=>(
          <div key={i} style={{marginBottom:8}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
              <span style={{color:T.txt,fontSize:11}}>{p.nameKr}</span>
              <span style={{color:p.leverage>5?T.red:T.ylw,fontSize:10,fontWeight:700}}>{p.leverage}x</span>
            </div>
            <div style={{height:5,background:'#1A2D4A',borderRadius:3}}>
              <div style={{height:'100%',width:Math.min(100,p.leverage*5)+'%',background:p.leverage>10?T.red:p.leverage>5?T.ylw:T.grn,borderRadius:3}}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TradingPage({prices,currency}:{prices:Asset[];currency:string}) {
  const [isMock,setIsMock]=useState(true);
  const [sel,setSel]=useState(prices[0]);
  const [side,setSide]=useState('매수');
  const [amount,setAmount]=useState('');
  const [leverage,setLeverage]=useState(1);
  const [marginMode,setMarginMode]=useState<'cross'|'isolated'>('isolated');
  const [status,setStatus]=useState<string|null>(null);
  const [search,setSearch]=useState('');
  const [showConfirm,setShowConfirm]=useState(false);
  const [orders,setOrders]=useState<Order[]>([]);
  const [showOrders,setShowOrders]=useState(false);
  const [riskProfile,setRiskProfile]=useState<'conservative'|'balanced'|'aggressive'>('balanced');
  const [tab,setTab]=useState<'trade'|'sizing'|'risk'>('trade');
  const [tp,setTp]=useState('');
  const [sl,setSl]=useState('');
  const [showChart,setShowChart]=useState(true);

  const filtered=useMemo(()=>{
    if(!search)return prices;
    const q=search.toLowerCase();
    return prices.filter(a=>a.nameKr.includes(search)||a.name.toLowerCase().includes(q)||a.id.toLowerCase().includes(q));
  },[prices,search]);

  const qMap:Record<string,string>={'10만':'100000','50만':'500000','100만':'1000000','500만':'5000000','전액':'10000000'};
  const fee=Math.round((+amount||0)*0.0005);
  const slippage=Math.round((+amount||0)*0.0001);
  const fundingFee=Math.round((+amount||0)*leverage*0.0001);
  const levRec=getLeverageRec(sel,riskProfile);

  const mockPositions=[
    {assetId:'SOL',nameKr:'솔라나',entryPrice:195000,qty:5,leverage:3,side:'long'},
    {assetId:'BNB',nameKr:'바이낸스',entryPrice:840000,qty:1,leverage:2,side:'long'},
  ];

  const confirmOrder=()=>{
    setShowConfirm(false);setStatus('loading');
    setTimeout(()=>{
      const newOrder:Order={id:uid(),assetId:sel.id,nameKr:sel.nameKr,sym:sel.sym,
        side:side==='매수'?'buy':'sell',price:sel.p,amount:+amount,leverage,
        fee,slippage,status:'filled',pnl:(Math.random()-0.4)*+amount*0.05,
        pnlPct:(Math.random()-0.4)*5,openedAt:new Date().toISOString(),note:'',emotion:'😊'};
      setOrders(prev=>[newOrder,...prev]);
      setStatus('done');setTimeout(()=>setStatus(null),3000);
    },1200);
  };

  return (
    <div>
      {/* Mock/Live toggle */}
      <div style={{display:'flex',gap:8,marginBottom:12}}>
        {([[true,'🎮 모의매매'],[false,'💰 실전']] as [boolean,string][]).map(([m,l])=>(
          <button key={String(m)} onClick={()=>setIsMock(m)} style={{flex:1,padding:'10px',background:isMock===m?T.acg:'transparent',color:isMock===m?T.acl:T.muted,border:`1px solid ${isMock===m?T.acl:T.border}`,borderRadius:12,fontWeight:700,fontSize:12,cursor:'pointer'}}>{l}</button>
        ))}
      </div>
      {isMock&&<div style={{background:T.prp+'15',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.prp,fontWeight:700,fontSize:11}}>🎮 모의매매 — 실제 돈 사용 안됨 · 수익 보장 없음</div></div>}

      {/* Sub tabs */}
      <div style={{display:'flex',gap:6,marginBottom:12}}>
        {(['trade','sizing','risk'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:'8px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {t==='trade'?'⚡ 매매':t==='sizing'?'🎯 사이징':'🔥 리스크'}
          </button>
        ))}
      </div>

      {tab==='sizing'&&(
        <Card style={{padding:'14px 16px',marginBottom:12}}>
          <PositionSizer balance={50000000} currency={currency}/>
        </Card>
      )}

      {tab==='risk'&&(
        <Card style={{padding:'14px 16px',marginBottom:12}}>
          <RiskDashboard positions={mockPositions} prices={prices}/>
        </Card>
      )}

      {tab==='trade'&&(
        <>
          {/* Asset selector */}
          <Card style={{padding:12,marginBottom:12}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="종목 검색…"
              style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'7px 10px',color:T.txt,fontSize:12,outline:'none',marginBottom:8}}/>
            <div style={{display:'flex',gap:5,flexWrap:'wrap',maxHeight:80,overflowY:'auto'}}>
              {filtered.slice(0,24).map(a=>(
                <button key={a.id} onClick={()=>{setSel(a);setSearch('');}} style={{background:sel.id===a.id?a.clr+'20':'transparent',color:sel.id===a.id?a.clr:T.muted,border:`1px solid ${sel.id===a.id?a.clr:T.border}`,borderRadius:8,padding:'3px 8px',fontSize:11,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',gap:4}}>
                  <Logo id={a.id} size={14} clr={a.clr}/>{a.id}
                </button>
              ))}
            </div>
          </Card>

          {/* Price + Chart */}
          <Card style={{padding:'14px 14px 10px',marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
              <div>
                <div style={{color:T.muted,fontSize:10}}>{sel.nameKr}</div>
                <div style={{color:T.txt,fontSize:22,fontWeight:900,fontFamily:'monospace',letterSpacing:-1}}>{cvt(sel.p,currency)}</div>
                <span style={{color:sel.c>=0?T.grn:T.red,fontWeight:800,fontSize:13}}>{sel.c>=0?'▲':'▼'} {Math.abs(sel.c).toFixed(2)}%</span>
              </div>
              <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:5}}>
                <Logo id={sel.id} size={38} clr={sel.clr}/>
                <button onClick={()=>setShowChart(v=>!v)} style={{background:showChart?T.acg:'transparent',color:showChart?T.acl:T.muted,border:`1px solid ${showChart?T.acl:T.border}`,borderRadius:8,padding:'2px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{showChart?'차트숨기기':'차트보기'}</button>
              </div>
            </div>
            {showChart&&<div style={{marginTop:8}}><TradingChart asset={sel}/></div>}
          </Card>

          {/* AI Leverage Recommendation */}
          <Card style={{padding:'12px 14px',marginBottom:12,border:`1px solid ${levRec.color}30`}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:8}}>🤖 AI 레버리지 추천</div>
            <div style={{display:'flex',gap:8,marginBottom:10}}>
              {(['conservative','balanced','aggressive'] as const).map(p=>(
                <button key={p} onClick={()=>setRiskProfile(p)} style={{flex:1,padding:'6px 4px',background:riskProfile===p?T.acg:'transparent',color:riskProfile===p?T.acl:T.muted,border:`1px solid ${riskProfile===p?T.acl:T.border}`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {p==='conservative'?'보수형':p==='balanced'?'균형형':'공격형'}
                </button>
              ))}
            </div>
            <div style={{background:levRec.color+'12',border:`1px solid ${levRec.color}30`,borderRadius:10,padding:'10px 12px'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <div>
                  <div style={{color:levRec.color,fontWeight:900,fontSize:18,fontFamily:'monospace'}}>{levRec.rec}x 권장</div>
                  <div style={{color:T.muted,fontSize:10,marginTop:1}}>변동성 {Math.abs(sel.c).toFixed(1)}% · {sel.nameKr}</div>
                </div>
                <div style={{textAlign:'center'}}>
                  <div style={{color:levRec.color,fontWeight:800,fontSize:11}}>{levRec.level}</div>
                  <div style={{color:T.muted,fontSize:9}}>안전도 {levRec.score}/100</div>
                </div>
              </div>
              <div style={{display:'flex',gap:6}}>
                {[1,3,5,10,20].map(v=>(
                  <button key={v} onClick={()=>setLeverage(v)} style={{flex:1,padding:'4px',background:v===levRec.rec?levRec.color+'25':'transparent',color:v===levRec.rec?levRec.color:T.muted,border:`1px solid ${v===levRec.rec?levRec.color:T.border}`,borderRadius:6,fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}x</button>
                ))}
              </div>
            </div>
            <div style={{marginTop:8,color:T.muted,fontSize:10,lineHeight:1.6}}>
              💡 {Math.abs(sel.c)>5?`현재 ${sel.nameKr} 변동성이 높습니다. 낮은 레버리지를 권장합니다.`:Math.abs(sel.c)>3?`${sel.nameKr} 보통 변동성. 중간 레버리지가 적합합니다.`:`${sel.nameKr} 안정적 상태. 전략에 맞는 레버리지를 선택하세요.`}
            </div>
          </Card>

          {/* Order form */}
          <Card style={{padding:14,marginBottom:12}}>
            {/* Buy/Sell */}
            <div style={{display:'flex',gap:8,marginBottom:12}}>
              {['매수','매도'].map(s=>(
                <button key={s} onClick={()=>setSide(s)} style={{flex:1,padding:'11px',background:side===s?(s==='매수'?T.grn:T.red):'transparent',color:side===s?'#fff':T.muted,border:`1px solid ${side===s?(s==='매수'?T.grn:T.red):T.border}`,borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>
                  {s==='매수'?'📈 매수 (롱)':'📉 매도 (숏)'}
                </button>
              ))}
            </div>

            {/* Amount */}
            <input type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="매매 금액 (₩)"
              style={{width:'100%',background:T.alt,border:`1px solid ${T.border2}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:16,fontFamily:'monospace',fontWeight:700,outline:'none',marginBottom:8}}/>
            <div style={{display:'flex',gap:5,marginBottom:14}}>
              {['10만','50만','100만','500만','전액'].map(v=>(
                <button key={v} onClick={()=>setAmount(qMap[v])} style={{flex:1,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:'6px 2px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}</button>
              ))}
            </div>

            {/* TP/SL */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
              <div>
                <div style={{color:T.grn,fontSize:10,fontWeight:700,marginBottom:4}}>📈 익절가</div>
                <input type="number" value={tp} onChange={e=>setTp(e.target.value)} placeholder={`${(sel.p*1.1).toFixed(0)}`}
                  style={{width:'100%',background:T.alt,border:`1px solid ${T.grn}30`,borderRadius:8,padding:'8px',color:T.txt,fontSize:12,outline:'none'}}/>
              </div>
              <div>
                <div style={{color:T.red,fontSize:10,fontWeight:700,marginBottom:4}}>📉 손절가</div>
                <input type="number" value={sl} onChange={e=>setSl(e.target.value)} placeholder={`${(sel.p*0.95).toFixed(0)}`}
                  style={{width:'100%',background:T.alt,border:`1px solid ${T.red}30`,borderRadius:8,padding:'8px',color:T.txt,fontSize:12,outline:'none'}}/>
              </div>
            </div>

            {/* Leverage */}
            <div style={{marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <span style={{color:T.muted,fontSize:11}}>레버리지</span>
                  <div style={{display:'flex',gap:4}}>
                    {(['cross','isolated'] as const).map(m=>(
                      <button key={m} onClick={()=>setMarginMode(m)} style={{background:marginMode===m?T.acg:'transparent',color:marginMode===m?T.acl:T.muted,border:`1px solid ${marginMode===m?T.acl:T.border}`,borderRadius:6,padding:'1px 6px',fontSize:9,fontWeight:700,cursor:'pointer'}}>
                        {m==='cross'?'교차':'격리'}
                      </button>
                    ))}
                  </div>
                </div>
                <span style={{color:leverage>10?T.red:leverage>5?T.ylw:T.grn,fontWeight:800,fontSize:13}}>{leverage}x</span>
              </div>
              <input type="range" min={1} max={100} value={leverage} onChange={e=>setLeverage(+e.target.value)}
                style={{width:'100%',accentColor:leverage>10?T.red:leverage>5?T.ylw:T.grn,marginBottom:6}}/>
              <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                {[1,3,5,10,20,50,100].map(v=>(
                  <button key={v} onClick={()=>setLeverage(v)} style={{background:leverage===v?T.acl+'25':'transparent',color:leverage===v?T.acl:T.muted,border:`1px solid ${leverage===v?T.acl:T.border}`,borderRadius:6,padding:'3px 7px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}x</button>
                ))}
              </div>
            </div>

            {/* High leverage warning */}
            {leverage > 20 && (
              <div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:10,padding:'10px 12px',marginBottom:12}}>
                <div style={{color:T.red,fontWeight:700,fontSize:11,marginBottom:3}}>⚠️ 고레버리지 경고</div>
                <div style={{color:T.sub,fontSize:10,lineHeight:1.6}}>
                  {leverage}배 레버리지는 매우 위험합니다. 작은 가격 변동에도 원금의 대부분을 잃을 수 있습니다. 
                  예상 청산가: 진입가 대비 {(100/leverage*0.9).toFixed(1)}% 하락 시.
                </div>
              </div>
            )}

            {/* Liquidation preview */}
            {amount && <div style={{marginBottom:12}}><LiquidationCalc entryPrice={sel.p} leverage={leverage} side={side} currency={currency}/></div>}

            {/* Fee summary */}
            {amount&&(
              <div style={{background:T.alt,borderRadius:10,padding:'10px 12px',marginBottom:12,border:`1px solid ${T.border}`}}>
                {[
                  {l:'주문 금액',v:'₩'+fmt(+amount)},
                  {l:`레버리지 적용 (${leverage}x)`,v:'₩'+fmt(+amount*leverage)},
                  {l:'수수료 (0.05%)',v:'₩'+fmt(fee)},
                  {l:'슬리피지 (0.01%)',v:'₩'+fmt(slippage)},
                  {l:'펀딩비 추정',v:'₩'+fmt(fundingFee)+'/8h'},
                ].map((r,i)=>(
                  <div key={i} style={{display:'flex',justifyContent:'space-between',marginBottom:i<4?3:0}}>
                    <span style={{color:T.muted,fontSize:10}}>{r.l}</span>
                    <span style={{color:T.txt,fontSize:10,fontWeight:700,fontFamily:'monospace'}}>{r.v}</span>
                  </div>
                ))}
              </div>
            )}

            <button onClick={()=>amount&&setShowConfirm(true)} disabled={!amount||status==='loading'}
              style={{width:'100%',padding:'14px',background:status==='done'?T.grn:status==='loading'?'#243A5E':(side==='매수'?T.grn:T.red),color:'#fff',border:'none',borderRadius:12,fontWeight:900,fontSize:14,cursor:'pointer'}}>
              {status==='loading'?'⏳ 처리 중…':status==='done'?'✅ 완료! (모의)':`[모의] ${sel.nameKr} ${side} ${leverage}x`}
            </button>
          </Card>

          {/* Order history */}
          {orders.length>0&&(
            <Card style={{padding:'14px 16px'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div style={{color:T.txt,fontWeight:700,fontSize:13}}>📋 매매 기록 ({orders.length}건)</div>
                <button onClick={()=>setShowOrders(v=>!v)} style={{background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'3px 8px',fontSize:11,cursor:'pointer'}}>{showOrders?'접기':'펼치기'}</button>
              </div>
              {showOrders&&orders.slice(0,5).map((o,i)=>(
                <div key={o.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<Math.min(4,orders.length-1)?`1px solid ${T.border}`:'none'}}>
                  <div>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{o.nameKr} {o.side==='buy'?'매수':'매도'} {o.leverage}x</div>
                    <div style={{color:T.muted,fontSize:10}}>{new Date(o.openedAt).toLocaleString('ko-KR')}</div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div style={{color:o.pnl>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{o.pnl>=0?'+':''}{fmt(o.pnl)}원</div>
                    <div style={{color:T.muted,fontSize:10}}>₩{fmt(o.amount)}</div>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      {/* Confirm modal */}
      {showConfirm&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200}} onClick={()=>setShowConfirm(false)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px 40px',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:T.txt,fontWeight:800,fontSize:16,marginBottom:14}}>⚠️ 주문 확인</div>
            {[{l:'종목',v:sel.nameKr},{l:'방향',v:side},{l:'금액',v:'₩'+fmt(+amount)},{l:'레버리지',v:leverage+'x'},{l:'마진 모드',v:marginMode==='cross'?'교차':'격리'},{l:'수수료',v:'₩'+fmt(fee)},{l:'펀딩비',v:'₩'+fmt(fundingFee)+'/8h'},{l:'청산 거리',v:(100/leverage*0.9).toFixed(1)+'%'}].map((r,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
                <span style={{color:T.muted,fontSize:13}}>{r.l}</span>
                <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{r.v}</span>
              </div>
            ))}
            {leverage>10&&<div style={{marginTop:10,background:T.red+'15',border:`1px solid ${T.red}30`,borderRadius:8,padding:'8px 12px',color:T.red,fontSize:11}}>⚠️ 고레버리지 경고: {leverage}배는 원금 손실 위험이 매우 높습니다</div>}
            <div style={{display:'flex',gap:10,marginTop:16}}>
              <button onClick={()=>setShowConfirm(false)} style={{flex:1,padding:'13px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={confirmOrder} style={{flex:2,padding:'13px',background:side==='매수'?T.grn:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>확인 {side}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
/* ── AutoPage (모듈형 자동매매 엔진) ── */

/* ─── Types ─── */
type StratType='ema_cross'|'rsi_reversal'|'macd_trend'|'breakout'|'scalping'|'swing'|'dca'|'buy_dip'|'funding_rate'|'ai_strategy';
type StratStatus='running'|'paused'|'stopped'|'error';
type SignalState='waiting'|'confirmed'|'rejected'|'executed'|'expired';
type ExecMode='paper'|'simulated'|'real';
type OrderStatus='pending'|'processing'|'completed'|'failed'|'canceled';

interface Strategy {
  id:string; name:string; type:StratType; status:StratStatus;
  asset:string; assetNameKr:string; timeframe:string;
  leverage:number; maxLeverage:number; riskLevel:'low'|'medium'|'high';
  tp:number; sl:number; enabled:boolean;
  winRate:number; totalPnl:number; trades:number;
  maxDailyLoss:number; maxPositionSize:number; cooldownMin:number;
  params:Record<string,number|string|boolean>; description:string;
}

interface Signal {
  id:string; stratId:string; stratName:string; asset:string;
  type:'buy'|'sell'; price:number; state:SignalState;
  confidence:number; source:'indicator'|'webhook'|'ai'|'manual';
  createdAt:string; note:string;
}

interface BotRun {
  id:string; stratId:string; stratName:string; asset:string;
  side:'long'|'short'; entryPrice:number; exitPrice?:number;
  qty:number; pnl:number; pnlPct:number; status:OrderStatus;
  execMode:ExecMode; openedAt:string; closedAt?:string;
}

interface RiskEvent {
  id:string; type:'daily_loss'|'drawdown'|'leverage'|'consecutive_loss'|'emergency';
  message:string; severity:'info'|'warning'|'critical'; timestamp:string;
}

/* ─── Strategy definitions ─── */
const STRAT_INFO:Record<StratType,{label:string;icon:string;color:string;desc:string}> = {
  ema_cross:     {label:'EMA 크로스',      icon:'📈',color:'#3B82F6',desc:'EMA20/60 골든·데드 크로스 추세 추종'},
  rsi_reversal:  {label:'RSI 반전',        icon:'📊',color:'#7C3AED',desc:'RSI 과매수/과매도 반등 전략'},
  macd_trend:    {label:'MACD 추세',       icon:'📉',color:'#10B981',desc:'MACD 히스토그램 추세 추종'},
  breakout:      {label:'브레이크아웃',    icon:'🚀',color:'#F59E0B',desc:'볼린저밴드 / 고저 돌파 전략'},
  scalping:      {label:'스캘핑',          icon:'⚡',color:'#EF4444',desc:'단기 소폭 수익 반복 전략'},
  swing:         {label:'스윙',            icon:'🌊',color:'#0891B2',desc:'2~7일 스윙 포지션 전략'},
  dca:           {label:'DCA 적립',        icon:'🔄',color:'#D97706',desc:'정기 분할 매수 전략'},
  buy_dip:       {label:'급락 매수',       icon:'🎯',color:'#059669',desc:'급락 시 분할 매수 전략'},
  funding_rate:  {label:'펀딩비 전략',     icon:'💰',color:'#94A3B8',desc:'펀딩비 수익 전략 (준비중)'},
  ai_strategy:   {label:'AI 전략',         icon:'🤖',color:'#6366F1',desc:'AI 신호 기반 자동매매 (준비중)'},
};

const INITIAL_STRATS:Strategy[] = [
  {id:'s1',name:'BTC EMA 추세 추종',type:'ema_cross',status:'running',asset:'BTC',assetNameKr:'비트코인',timeframe:'4h',leverage:2,maxLeverage:5,riskLevel:'medium',tp:5,sl:2.5,enabled:true,winRate:67,totalPnl:847000,trades:18,maxDailyLoss:500000,maxPositionSize:3000000,cooldownMin:60,params:{ema_fast:20,ema_slow:60,rsi_filter:true,rsi_min:40,rsi_max:70},description:'EMA20/60 크로스 + RSI 40~70 필터'},
  {id:'s2',name:'ETH RSI 반전',type:'rsi_reversal',status:'paused',asset:'ETH',assetNameKr:'이더리움',timeframe:'1h',leverage:1,maxLeverage:3,riskLevel:'low',tp:4,sl:2,enabled:true,winRate:58,totalPnl:312000,trades:12,maxDailyLoss:200000,maxPositionSize:2000000,cooldownMin:120,params:{rsi_ob:70,rsi_os:30,rsi_period:14},description:'RSI 30↓ 매수 · RSI 70↑ 매도'},
  {id:'s3',name:'SOL 브레이크아웃',type:'breakout',status:'stopped',asset:'SOL',assetNameKr:'솔라나',timeframe:'15m',leverage:3,maxLeverage:10,riskLevel:'high',tp:8,sl:3,enabled:false,winRate:71,totalPnl:224400,trades:7,maxDailyLoss:300000,maxPositionSize:1500000,cooldownMin:30,params:{bb_period:20,bb_std:2,vol_mult:1.5},description:'볼린저밴드 상단/하단 돌파'},
  {id:'s4',name:'BTC DCA 적립',type:'dca',status:'running',asset:'BTC',assetNameKr:'비트코인',timeframe:'1d',leverage:1,maxLeverage:1,riskLevel:'low',tp:50,sl:20,enabled:true,winRate:83,totalPnl:1240000,trades:24,maxDailyLoss:1000000,maxPositionSize:5000000,cooldownMin:1440,params:{interval_days:7,amount_krw:300000,max_entries:10},description:'주 1회 BTC 정기 매수 DCA'},
];

const INITIAL_SIGNALS:Signal[] = [
  {id:'sig1',stratId:'s1',stratName:'BTC EMA 추세 추종',asset:'BTC',type:'buy',price:94230000,state:'confirmed',confidence:78,source:'indicator',createdAt:'2025-05-13T09:32:00',note:'EMA 골든크로스 + RSI 52'},
  {id:'sig2',stratId:'s2',stratName:'ETH RSI 반전',asset:'ETH',type:'buy',price:5820000,state:'waiting',confidence:62,source:'indicator',createdAt:'2025-05-13T08:15:00',note:'RSI 38 — 과매도 접근'},
  {id:'sig3',stratId:'s1',stratName:'BTC EMA 추세 추종',asset:'BTC',type:'sell',price:91200000,state:'executed',confidence:82,source:'indicator',createdAt:'2025-05-12T22:00:00',note:'EMA 데드크로스 + RSI 71'},
];

const INITIAL_RUNS:BotRun[] = [
  {id:'r1',stratId:'s1',stratName:'BTC EMA',asset:'BTC',side:'long',entryPrice:92400000,exitPrice:94230000,qty:0.02,pnl:36600,pnlPct:1.98,status:'completed',execMode:'paper',openedAt:'2025-05-11T10:00:00',closedAt:'2025-05-13T09:32:00'},
  {id:'r2',stratId:'s4',stratName:'BTC DCA',asset:'BTC',side:'long',entryPrice:90100000,qty:0.0033,pnl:13729,pnlPct:4.6,status:'completed',execMode:'paper',openedAt:'2025-05-05T00:00:00'},
  {id:'r3',stratId:'s2',stratName:'ETH RSI',asset:'ETH',side:'long',entryPrice:5640000,exitPrice:5490000,qty:0.5,pnl:-75000,pnlPct:-2.66,status:'completed',execMode:'paper',openedAt:'2025-05-10T14:00:00',closedAt:'2025-05-11T08:00:00'},
];

const INITIAL_RISK_EVENTS:RiskEvent[] = [
  {id:'re1',type:'daily_loss',message:'일일 손실이 한도의 80%에 도달했습니다. ETH RSI 전략 일시 중지.',severity:'warning',timestamp:'2025-05-11T15:30:00'},
  {id:'re2',type:'consecutive_loss',message:'3회 연속 손실 감지 — BTC EMA 전략 1시간 쿨다운 진입.',severity:'info',timestamp:'2025-05-10T18:00:00'},
];

/* ─── AutoPage Component ─── */
function AutoPage() {
  const [tab,setTab]=useState<'bots'|'signals'|'risk'|'runs'|'create'>('bots');
  const [strats,setStrats]=useState<Strategy[]>(INITIAL_STRATS);
  const [signals]=useState<Signal[]>(INITIAL_SIGNALS);
  const [runs]=useState<BotRun[]>(INITIAL_RUNS);
  const [riskEvents]=useState<RiskEvent[]>(INITIAL_RISK_EVENTS);
  const [execMode,setExecMode]=useState<ExecMode>('paper');
  const [globalStop,setGlobalStop]=useState(false);
  const [selStrat,setSelStrat]=useState<Strategy|null>(null);
  const [showConfirmReal,setShowConfirmReal]=useState(false);
  const [editStrat,setEditStrat]=useState<Strategy|null>(null);
  const [showCreate,setShowCreate]=useState(false);
  const [newStrat,setNewStrat]=useState({name:'',type:'ema_cross' as StratType,asset:'BTC',timeframe:'4h',leverage:1,tp:5,sl:2.5,maxDailyLoss:500000,maxPositionSize:3000000});

  const running = strats.filter(s=>s.status==='running'&&s.enabled);
  const totalPnl = strats.reduce((s,x)=>s+x.totalPnl,0);
  const avgWinRate = strats.length ? Math.round(strats.reduce((s,x)=>s+x.winRate,0)/strats.length) : 0;
  const totalTrades = strats.reduce((s,x)=>s+x.trades,0);

  const toggleStrat=(id:string)=>setStrats(p=>p.map(s=>s.id===id?{...s,status:s.status==='running'?'paused':'running',enabled:s.status!=='running'}:s));
  const stopStrat=(id:string)=>setStrats(p=>p.map(s=>s.id===id?{...s,status:'stopped',enabled:false}:s));

  const handleGlobalStop=()=>{
    setGlobalStop(true);
    setStrats(p=>p.map(s=>({...s,status:'stopped',enabled:false})));
  };

  const handleCreateStrat=()=>{
    const s:Strategy={
      id:'s'+Date.now().toString(36),
      name:newStrat.name||`새 ${STRAT_INFO[newStrat.type].label} 전략`,
      type:newStrat.type,status:'stopped',
      asset:newStrat.asset,assetNameKr:newStrat.asset,
      timeframe:newStrat.timeframe,leverage:newStrat.leverage,maxLeverage:10,
      riskLevel:newStrat.leverage>5?'high':newStrat.leverage>2?'medium':'low',
      tp:newStrat.tp,sl:newStrat.sl,enabled:false,
      winRate:0,totalPnl:0,trades:0,
      maxDailyLoss:newStrat.maxDailyLoss,maxPositionSize:newStrat.maxPositionSize,cooldownMin:60,
      params:{},description:STRAT_INFO[newStrat.type].desc,
    };
    setStrats(p=>[...p,s]);
    setShowCreate(false);
    setNewStrat({name:'',type:'ema_cross',asset:'BTC',timeframe:'4h',leverage:1,tp:5,sl:2.5,maxDailyLoss:500000,maxPositionSize:3000000});
  };

  const statusColor:Record<StratStatus,string>={running:T.grn,paused:T.ylw,stopped:T.muted,error:T.red};
  const statusLabel:Record<StratStatus,string>={running:'실행중',paused:'일시중지',stopped:'정지',error:'오류'};
  const signalColor:Record<SignalState,string>={waiting:T.ylw,confirmed:T.grn,rejected:T.red,executed:T.acl,expired:T.muted};
  const signalLabel:Record<SignalState,string>={waiting:'대기',confirmed:'확인됨',rejected:'거부됨',executed:'실행됨',expired:'만료'};

  return (
    <div>
      {/* Exec mode + global stop */}
      <div style={{display:'flex',gap:8,marginBottom:12,alignItems:'center'}}>
        <div style={{display:'flex',gap:4,flex:1}}>
          {(['paper','simulated'] as ExecMode[]).map(m=>(
            <button key={m} onClick={()=>m==='real'?setShowConfirmReal(true):setExecMode(m)} style={{flex:1,padding:'8px',background:execMode===m?T.acg:'transparent',color:execMode===m?T.acl:T.muted,border:`1px solid ${execMode===m?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
              {m==='paper'?'🎮 모의':m==='simulated'?'🔬 시뮬':'⚠️ 실전'}
            </button>
          ))}
        </div>
        <button onClick={()=>globalStop?setGlobalStop(false):handleGlobalStop()} style={{background:globalStop?T.grn+'20':T.red+'20',color:globalStop?T.grn:T.red,border:`1px solid ${globalStop?T.grn:T.red}40`,borderRadius:10,padding:'8px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>
          {globalStop?'▶ 재시작':'⏹ 전체정지'}
        </button>
      </div>

      {globalStop&&<div style={{background:T.red+'15',border:`1px solid ${T.red}`,borderRadius:12,padding:'10px 14px',marginBottom:12,display:'flex',gap:8,alignItems:'center'}}><span style={{fontSize:18}}>🚨</span><div style={{color:T.red,fontWeight:700,fontSize:12}}>전체 긴급 정지 활성화 — 모든 봇이 중단되었습니다</div></div>}

      {execMode==='paper'&&<div style={{background:T.prp+'12',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.prp,fontSize:11,fontWeight:700}}>🎮 모의 자동매매 모드 — 실제 자금 이동 없음 · 수익 보장 없음</div></div>}

      {/* Dashboard metrics */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14}}>
        {[{l:'실행중',v:`${running.length}개`,c:T.grn},{l:'총 손익',v:totalPnl>=0?'+'+cvt(totalPnl,'KRW'):cvt(totalPnl,'KRW'),c:totalPnl>=0?T.grn:T.red},{l:'평균 승률',v:`${avgWinRate}%`,c:T.acl},{l:'총 거래',v:`${totalTrades}건`,c:T.muted}].map(s=>(
          <Card key={s.l} style={{padding:'9px 8px',textAlign:'center'}}>
            <div style={{color:s.c,fontSize:13,fontWeight:900,fontFamily:'monospace',marginBottom:1}}>{s.v}</div>
            <div style={{color:T.muted,fontSize:9}}>{s.l}</div>
          </Card>
        ))}
      </div>

      {/* Sub tabs */}
      <div style={{display:'flex',gap:5,marginBottom:14,overflowX:'auto'}}>
        {([['bots','🤖 봇 목록'],['signals','📡 신호'],['risk','🛡️ 리스크'],['runs','📋 실행기록'],['create','➕ 전략 추가']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'7px 11px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* ── BOTS ── */}
      {tab==='bots'&&(
        <div>
          {strats.map(s=>{
            const si=STRAT_INFO[s.type];
            return (
              <Card key={s.id} style={{padding:'14px',marginBottom:10,border:`1px solid ${statusColor[s.status]}20`}} onClick={()=>setSelStrat(selStrat?.id===s.id?null:s)}>
                {/* Header */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}>
                    <div style={{width:38,height:38,borderRadius:10,background:`${si.color}20`,border:`1px solid ${si.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>{si.icon}</div>
                    <div>
                      <div style={{display:'flex',gap:5,alignItems:'center',flexWrap:'wrap'}}>
                        <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{s.name}</span>
                        <span style={{background:`${statusColor[s.status]}20`,color:statusColor[s.status],fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:99}}>{statusLabel[s.status]}</span>
                        <span style={{background:T.alt,color:T.muted,fontSize:9,padding:'1px 5px',borderRadius:5}}>{s.timeframe}</span>
                      </div>
                      <div style={{color:T.muted,fontSize:10,marginTop:2}}>{s.description}</div>
                    </div>
                  </div>
                  <div style={{textAlign:'right',flexShrink:0}}>
                    <div style={{color:s.totalPnl>=0?T.grn:T.red,fontSize:12,fontWeight:700,fontFamily:'monospace'}}>{s.totalPnl>=0?'+':''}{cvt(Math.abs(s.totalPnl),'KRW')}</div>
                    <div style={{color:T.muted,fontSize:9,marginTop:1}}>승률 {s.winRate}% · {s.trades}건</div>
                  </div>
                </div>
                {/* Quick stats */}
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,marginBottom:8}}>
                  {[{l:'자산',v:s.asset},{l:'레버리지',v:`${s.leverage}x`},{l:'익절',v:`${s.tp}%`},{l:'손절',v:`${s.sl}%`}].map(r=>(
                    <div key={r.l} style={{background:T.alt,borderRadius:7,padding:'5px 6px',textAlign:'center'}}>
                      <div style={{color:T.muted,fontSize:8}}>{r.l}</div>
                      <div style={{color:T.txt,fontSize:10,fontWeight:700,marginTop:1}}>{r.v}</div>
                    </div>
                  ))}
                </div>
                {/* Controls */}
                <div style={{display:'flex',gap:6}}>
                  <button onClick={e=>{e.stopPropagation();toggleStrat(s.id);}} style={{flex:1,padding:'7px',background:s.status==='running'?T.ylw+'15':T.grn+'15',color:s.status==='running'?T.ylw:T.grn,border:`1px solid ${s.status==='running'?T.ylw:T.grn}30`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                    {s.status==='running'?'⏸ 일시중지':'▶ 시작'}
                  </button>
                  <button onClick={e=>{e.stopPropagation();stopStrat(s.id);}} style={{flex:1,padding:'7px',background:T.red+'12',color:T.red,border:`1px solid ${T.red}25`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>⏹ 중지</button>
                  <button onClick={e=>{e.stopPropagation();setEditStrat(s);}} style={{padding:'7px 10px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>설정</button>
                </div>
                {/* Expanded detail */}
                {selStrat?.id===s.id&&(
                  <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
                    <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>전략 파라미터</div>
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                      {Object.entries(s.params).map(([k,v])=>(
                        <div key={k} style={{background:T.alt,borderRadius:7,padding:'6px 8px'}}>
                          <div style={{color:T.muted,fontSize:9}}>{k}</div>
                          <div style={{color:T.txt,fontSize:10,fontWeight:700,marginTop:1}}>{String(v)}</div>
                        </div>
                      ))}
                      <div style={{background:T.alt,borderRadius:7,padding:'6px 8px'}}>
                        <div style={{color:T.muted,fontSize:9}}>일일 최대 손실</div>
                        <div style={{color:T.red,fontSize:10,fontWeight:700,marginTop:1}}>{cvt(s.maxDailyLoss,'KRW')}</div>
                      </div>
                      <div style={{background:T.alt,borderRadius:7,padding:'6px 8px'}}>
                        <div style={{color:T.muted,fontSize:9}}>최대 포지션</div>
                        <div style={{color:T.acl,fontSize:10,fontWeight:700,marginTop:1}}>{cvt(s.maxPositionSize,'KRW')}</div>
                      </div>
                    </div>
                    {/* AI assistant note */}
                    <div style={{marginTop:8,background:T.prp+'10',border:`1px solid ${T.prp}25`,borderRadius:8,padding:'8px 10px'}}>
                      <div style={{color:T.prp,fontSize:10,fontWeight:700,marginBottom:2}}>🤖 AI 어시스턴트</div>
                      <div style={{color:T.sub,fontSize:10,lineHeight:1.5}}>
                        {s.status==='running'?'전략이 정상 실행 중입니다. 현재 시장 변동성이 보통 수준으로 설정된 레버리지가 적절합니다.':s.status==='paused'?'일시 중지 상태입니다. 시장 상황 확인 후 재개를 권장합니다.':'전략이 중지되었습니다. 파라미터를 검토한 후 다시 시작하세요.'}
                      </div>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ── SIGNALS ── */}
      {tab==='signals'&&(
        <div>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'8px 12px',marginBottom:12}}>
            <div style={{color:T.ylw,fontSize:11,fontWeight:700}}>📡 신호 처리 엔진 — 내부 지표 · TradingView · AI (준비중)</div>
          </div>
          {signals.map(sig=>(
            <Card key={sig.id} style={{padding:'12px 14px',marginBottom:8,border:`1px solid ${signalColor[sig.state]}20`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:3,flexWrap:'wrap'}}>
                    <span style={{background:sig.type==='buy'?T.grn+'20':T.red+'20',color:sig.type==='buy'?T.grn:T.red,fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:6}}>{sig.type==='buy'?'매수':'매도'}</span>
                    <span style={{color:T.txt,fontWeight:700,fontSize:12}}>{sig.asset}</span>
                    <span style={{background:signalColor[sig.state]+'20',color:signalColor[sig.state],fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:99}}>{signalLabel[sig.state]}</span>
                    <span style={{background:T.alt,color:T.muted,fontSize:9,padding:'1px 5px',borderRadius:5}}>{sig.source}</span>
                  </div>
                  <div style={{color:T.muted,fontSize:10}}>{sig.stratName} · {new Date(sig.createdAt).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <div style={{color:signalColor[sig.state],fontSize:13,fontWeight:900}}>{sig.confidence}%</div>
                  <div style={{color:T.muted,fontSize:9}}>신뢰도</div>
                </div>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{color:T.txt,fontSize:11,fontFamily:'monospace'}}>{cvt(sig.price,'KRW')}</div>
                <div style={{color:T.muted,fontSize:10}}>{sig.note}</div>
              </div>
              <div style={{marginTop:6,height:4,background:'#1A2D4A',borderRadius:2,overflow:'hidden'}}>
                <div style={{height:'100%',width:sig.confidence+'%',background:signalColor[sig.state],borderRadius:2}}/>
              </div>
            </Card>
          ))}
          {/* Webhook placeholder */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.cyn}30`}}>
            <div style={{color:T.cyn,fontWeight:700,fontSize:12,marginBottom:8}}>📺 TradingView Webhook 연동</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6,marginBottom:10}}>TradingView 알림 → TRAIGO 자동 신호 수신. 실행 시 자동으로 봇이 처리합니다.</div>
            <div style={{display:'flex',gap:8}}>
              <input placeholder="https://your-webhook-url.com/signal" style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:11,outline:'none'}}/>
              <button style={{background:T.cyn+'20',color:T.cyn,border:`1px solid ${T.cyn}40`,borderRadius:8,padding:'8px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>저장</button>
            </div>
          </Card>
        </div>
      )}

      {/* ── RISK ── */}
      {tab==='risk'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🛡️ 글로벌 리스크 설정</div>
            {[
              {l:'일일 최대 손실',v:'₩1,000,000',sub:'초과 시 전체 자동매매 중단',c:T.red},
              {l:'최대 드로다운',v:'15%',sub:'연속 손실 한도',c:T.ylw},
              {l:'최대 레버리지',v:'10x',sub:'전략별 레버리지 상한',c:T.ylw},
              {l:'최대 동시 거래',v:'5개',sub:'오픈 포지션 동시 한도',c:T.acl},
              {l:'연속 손실 정지',v:'3회',sub:'연속 손실 후 쿨다운',c:T.red},
              {l:'쿨다운 시간',v:'60분',sub:'손실 후 대기 시간',c:T.muted},
            ].map((r,i)=>(
              <div key={r.l} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<5?`1px solid ${T.border}`:'none'}}>
                <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{r.l}</div><div style={{color:T.muted,fontSize:10}}>{r.sub}</div></div>
                <span style={{background:`${r.c}20`,color:r.c,fontSize:11,fontWeight:700,padding:'3px 9px',borderRadius:8}}>{r.v}</span>
              </div>
            ))}
          </Card>
          {/* Risk events */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>⚠️ 최근 리스크 이벤트</div>
            {riskEvents.map((ev,i)=>(
              <div key={ev.id} style={{padding:'10px 0',borderBottom:i<riskEvents.length-1?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:3}}>
                  <span style={{background:(ev.severity==='critical'?T.red:ev.severity==='warning'?T.ylw:T.acl)+'20',color:ev.severity==='critical'?T.red:ev.severity==='warning'?T.ylw:T.acl,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:99}}>{ev.severity==='critical'?'위험':ev.severity==='warning'?'주의':'정보'}</span>
                  <span style={{color:T.muted,fontSize:9}}>{new Date(ev.timestamp).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span>
                </div>
                <div style={{color:T.txt,fontSize:11,lineHeight:1.5}}>{ev.message}</div>
              </div>
            ))}
          </Card>
          {/* Emergency stop */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.red}40`}}>
            <div style={{color:T.red,fontWeight:700,marginBottom:6}}>🚨 긴급 정지</div>
            <div style={{color:T.muted,fontSize:11,marginBottom:10}}>모든 자동매매를 즉시 중단합니다. 수동 거래는 계속 가능합니다.</div>
            <button onClick={handleGlobalStop} style={{width:'100%',padding:'12px',background:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer'}}>🚨 전체 자동매매 긴급 정지</button>
          </Card>
        </div>
      )}

      {/* ── RUNS ── */}
      {tab==='runs'&&(
        <div>
          <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📋 실행 기록</div>
          {runs.map((r,i)=>(
            <Card key={r.id} style={{padding:'12px 14px',marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:2,flexWrap:'wrap'}}>
                    <span style={{background:r.side==='long'?T.grn+'15':T.red+'15',color:r.side==='long'?T.grn:T.red,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:6}}>{r.side==='long'?'롱':'숏'}</span>
                    <span style={{color:T.txt,fontWeight:700,fontSize:12}}>{r.asset}</span>
                    <span style={{background:T.prp+'15',color:T.prp,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:6}}>{r.execMode==='paper'?'모의':'실전'}</span>
                  </div>
                  <div style={{color:T.muted,fontSize:10}}>{r.stratName}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:1}}>진입 {cvt(r.entryPrice,'KRW')}{r.exitPrice?` → ${cvt(r.exitPrice,'KRW')}`:' (오픈)'}</div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <div style={{color:r.pnl>=0?T.grn:T.red,fontWeight:800,fontSize:13,fontFamily:'monospace'}}>{r.pnl>=0?'+':''}{cvt(Math.abs(r.pnl),'KRW')}</div>
                  <div style={{color:r.pnl>=0?T.grn:T.red,fontSize:10}}>{r.pnl>=0?'+':''}{r.pnlPct.toFixed(2)}%</div>
                </div>
              </div>
              <div style={{color:T.muted,fontSize:9}}>{new Date(r.openedAt).toLocaleDateString('ko-KR')}{r.closedAt?` ~ ${new Date(r.closedAt).toLocaleDateString('ko-KR')}`:'  (진행중)'}</div>
            </Card>
          ))}
        </div>
      )}

      {/* ── CREATE ── */}
      {tab==='create'&&(
        <div>
          <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>➕ 새 자동매매 전략 생성</div>
          {/* Strategy type grid */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:8}}>전략 유형 선택</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
              {(Object.entries(STRAT_INFO) as [StratType,any][]).map(([key,si])=>(
                <button key={key} onClick={()=>setNewStrat(p=>({...p,type:key}))} style={{background:newStrat.type===key?si.color+'20':T.alt,border:`2px solid ${newStrat.type===key?si.color:T.border}`,borderRadius:12,padding:'10px 10px',cursor:'pointer',textAlign:'left',opacity:key==='funding_rate'||key==='ai_strategy'?0.5:1}}>
                  <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:3}}>
                    <span style={{fontSize:14}}>{si.icon}</span>
                    <span style={{color:newStrat.type===key?si.color:T.txt,fontWeight:700,fontSize:11}}>{si.label}</span>
                    {(key==='funding_rate'||key==='ai_strategy')&&<span style={{color:T.muted,fontSize:8}}>준비중</span>}
                  </div>
                  <div style={{color:T.muted,fontSize:9,lineHeight:1.4}}>{si.desc}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Settings */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:10}}>기본 설정</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
              {[
                {l:'전략 이름',k:'name',type:'text',ph:'내 EMA 전략'},
                {l:'대상 자산',k:'asset',type:'text',ph:'BTC'},
                {l:'타임프레임',k:'timeframe',type:'text',ph:'4h'},
                {l:'레버리지',k:'leverage',type:'number',ph:'1'},
                {l:'익절 %',k:'tp',type:'number',ph:'5'},
                {l:'손절 %',k:'sl',type:'number',ph:'2.5'},
              ].map(f=>(
                <div key={f.k}>
                  <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>{f.l}</div>
                  <input type={f.type} value={(newStrat as any)[f.k]||''} onChange={e=>setNewStrat(p=>({...p,[f.k]:f.type==='number'?+e.target.value:e.target.value}))} placeholder={f.ph} style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:12,outline:'none'}}/>
                </div>
              ))}
            </div>
            <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:8,padding:'8px 12px',marginBottom:12}}>
              <div style={{color:T.ylw,fontSize:10,fontWeight:700}}>⚠️ 새 전략은 항상 모의매매 모드로 시작됩니다. 실제 거래 비활성화.</div>
            </div>
            <button onClick={handleCreateStrat} disabled={!newStrat.asset} style={{width:'100%',padding:'12px',background:newStrat.asset?T.acc:'#243A5E',color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer'}}>
              🤖 전략 생성 (모의)
            </button>
          </Card>
        </div>
      )}

      {/* Real mode confirm modal */}
      {showConfirmReal&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.8)',zIndex:200}} onClick={()=>setShowConfirmReal(false)}/>
          <div style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:201,background:T.surf,borderRadius:20,padding:'24px 20px',width:320,border:`2px solid ${T.red}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:T.red,fontWeight:800,fontSize:16,marginBottom:8}}>⚠️ 실전 모드 활성화</div>
            <div style={{color:T.sub,fontSize:12,lineHeight:1.6,marginBottom:16}}>실전 모드에서는 연결된 거래소 API를 통해 실제 주문이 실행됩니다. 원금 손실 위험이 있습니다.<br/><br/>현재 TRAIGO는 실전 주문 실행 기능을 지원하지 않습니다 (플레이스홀더).</div>
            <button onClick={()=>setShowConfirmReal(false)} style={{width:'100%',padding:'12px',background:T.muted+'20',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소 (모의 유지)</button>
          </div>
        </>
      )}

      {/* Edit strategy modal */}
      {editStrat&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.8)',zIndex:200}} onClick={()=>setEditStrat(null)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'20px 16px 40px',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:12}}>⚙️ {editStrat.name} 설정</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
              {[{l:'레버리지',v:`${editStrat.leverage}x`},{l:'익절',v:`${editStrat.tp}%`},{l:'손절',v:`${editStrat.sl}%`},{l:'타임프레임',v:editStrat.timeframe}].map(r=>(
                <div key={r.l} style={{background:T.alt,borderRadius:10,padding:'10px 12px'}}>
                  <div style={{color:T.muted,fontSize:10}}>{r.l}</div>
                  <div style={{color:T.txt,fontSize:14,fontWeight:700,marginTop:2}}>{r.v}</div>
                </div>
              ))}
            </div>
            <div style={{background:T.grn+'12',border:`1px solid ${T.grn}30`,borderRadius:8,padding:'8px 12px',marginBottom:12}}>
              <div style={{color:T.grn,fontSize:10,fontWeight:700}}>💡 설정 변경은 백테스트 후 적용을 권장합니다.</div>
            </div>
            <button onClick={()=>setEditStrat(null)} style={{width:'100%',padding:'12px',background:T.acc,color:'#fff',border:'none',borderRadius:12,fontWeight:700,cursor:'pointer'}}>확인</button>
          </div>
        </>
      )}
    </div>
  );
}


/* ── NewsPage ── */
function NewsPage() {
  const [tab,setTab]=useState('뉴스');
  const sentimentC:Record<string,string>={bullish:T.grn,bearish:T.red,neutral:T.ylw};
  const impactC:Record<string,string>={high:T.red,medium:T.ylw,low:T.grn};
  return (
    <div>
      <div style={{display:'flex',gap:8,marginBottom:14}}>
        {['뉴스','경제 캘린더'].map(t=><button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:'10px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:12,fontWeight:700,fontSize:12,cursor:'pointer'}}>{t}</button>)}
      </div>
      {tab==='뉴스'&&(
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          {MOCK_NEWS.map(n=>(
            <Card key={n.id} style={{padding:'14px 16px'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <div style={{display:'flex',gap:6,alignItems:'center'}}><Bdg c={sentimentC[n.sentiment]} ch={n.category}/><span style={{color:T.muted,fontSize:10}}>{n.source}</span></div>
                <span style={{color:T.muted,fontSize:10}}>{n.time}</span>
              </div>
              <div style={{color:T.txt,fontSize:13,fontWeight:700,lineHeight:1.5,marginBottom:6}}>{n.title}</div>
              <div style={{color:T.sub,fontSize:11,lineHeight:1.6}}>{n.summary}</div>
              <div style={{marginTop:8}}><span style={{color:n.sentiment==='bullish'?T.grn:n.sentiment==='bearish'?T.red:T.ylw,fontSize:10,fontWeight:700}}>{n.sentiment==='bullish'?'📈 강세':'📉 약세'} 신호</span></div>
            </Card>
          ))}
        </div>
      )}
      {tab==='경제 캘린더'&&(
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {ECON_EVENTS.map((ev,i)=>(
            <Card key={i} style={{padding:'12px 16px'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                <div style={{flex:1}}>
                  <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:4}}>
                    <span style={{fontSize:14}}>{ev.country}</span>
                    <Bdg c={impactC[ev.impact]} ch={ev.impact==='high'?'고영향':ev.impact==='medium'?'중영향':'저영향'}/>
                    <span style={{color:T.muted,fontSize:10}}>{ev.date} {ev.time}</span>
                  </div>
                  <div style={{color:T.txt,fontSize:13,fontWeight:700}}>{ev.event}</div>
                </div>
                <div style={{textAlign:'right',flexShrink:0,marginLeft:12}}>
                  <div style={{color:T.muted,fontSize:10}}>이전: {ev.previous}</div>
                  <div style={{color:T.acl,fontSize:11,fontWeight:700}}>예상: {ev.forecast}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── AlertsPage ── */
function AlertsPage({prices}:{prices:Asset[]}) {
  const [alerts,setAlerts]=useState<Alert[]>([
    {id:'1',assetId:'BTC',nameKr:'비트코인',condition:'above',value:100000000,active:true},
    {id:'2',assetId:'ETH',nameKr:'이더리움',condition:'below',value:5000000,active:true},
    {id:'3',assetId:'NVDA',nameKr:'엔비디아',condition:'above',value:250,active:false},
  ]);
  const [notifs,setNotifs]=useState<Notif[]>([
    {id:'1',type:'trade',title:'BTC 매수 완료',body:'94,230,000원에 0.001 BTC 매수 완료',read:false,time:'방금'},
    {id:'2',type:'alert',title:'가격 알림',body:'ETH가 5,800,000원을 상향 돌파',read:false,time:'5분 전'},
    {id:'3',type:'system',title:'시스템 알림',body:'자동매매 전략 #2 실행 완료',read:true,time:'1시간 전'},
  ]);
  const [newAlert,setNewAlert]=useState({assetId:'BTC',condition:'above',value:''});
  const [tab,setTab]=useState('알림');
  const unread=notifs.filter(n=>!n.read).length;
  return (
    <div>
      <div style={{display:'flex',gap:8,marginBottom:14}}>
        {['알림','가격 알림 설정'].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:'10px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:12,fontWeight:700,fontSize:12,cursor:'pointer'}}>
            {t}{t==='알림'&&unread>0&&<span style={{background:T.red,color:'#fff',borderRadius:99,padding:'0 5px',fontSize:9,marginLeft:4,fontWeight:700}}>{unread}</span>}
          </button>
        ))}
      </div>
      {tab==='알림'&&(
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:14}}>🔔 알림 센터</div>
            {unread>0&&<button onClick={()=>setNotifs(p=>p.map(n=>({...n,read:true})))} style={{background:'transparent',color:T.acl,border:'none',fontSize:11,cursor:'pointer',fontWeight:600}}>모두 읽음</button>}
          </div>
          {notifs.map((n,i)=>(
            <div key={n.id} onClick={()=>setNotifs(p=>p.map(x=>x.id===n.id?{...x,read:true}:x))} style={{display:'flex',gap:10,padding:'12px 0',borderBottom:i<notifs.length-1?`1px solid ${T.border}`:'none',cursor:'pointer',opacity:n.read?0.6:1}}>
              <div style={{fontSize:20,flexShrink:0}}>{n.type==='trade'?'⚡':n.type==='alert'?'🔔':'ℹ️'}</div>
              <div style={{flex:1}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}><div style={{color:T.txt,fontWeight:700,fontSize:13}}>{n.title}</div>{!n.read&&<div style={{width:7,height:7,borderRadius:'50%',background:T.acl,flexShrink:0}}/>}</div><div style={{color:T.sub,fontSize:12,lineHeight:1.5}}>{n.body}</div><div style={{color:T.muted,fontSize:10,marginTop:3}}>{n.time}</div></div>
            </div>
          ))}
        </div>
      )}
      {tab==='가격 알림 설정'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>+ 새 알림 추가</div>
            <div style={{display:'flex',gap:8,marginBottom:8}}>
              <select value={newAlert.assetId} onChange={e=>setNewAlert(p=>({...p,assetId:e.target.value}))} style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px',color:T.txt,fontSize:12,outline:'none'}}>
                {prices.slice(0,20).map(a=><option key={a.id} value={a.id}>{a.nameKr} ({a.id})</option>)}
              </select>
              <select value={newAlert.condition} onChange={e=>setNewAlert(p=>({...p,condition:e.target.value}))} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px',color:T.txt,fontSize:12,outline:'none'}}>
                <option value="above">이상</option><option value="below">이하</option>
              </select>
            </div>
            <div style={{display:'flex',gap:8}}>
              <input type="number" value={newAlert.value} onChange={e=>setNewAlert(p=>({...p,value:e.target.value}))} placeholder="목표 가격" style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 12px',color:T.txt,fontSize:12,outline:'none'}}/>
              <button onClick={()=>{
                if(!newAlert.value)return;
                const asset=prices.find(a=>a.id===newAlert.assetId);
                if(!asset)return;
                const a:Alert={id:uid(),assetId:newAlert.assetId,nameKr:asset.nameKr,condition:newAlert.condition as 'above'|'below',value:+newAlert.value,active:true};
                setAlerts(p=>[a,...p]);
                setNewAlert({assetId:'BTC',condition:'above',value:''});
              }} style={{background:T.acc,color:'#fff',border:'none',borderRadius:8,padding:'8px 16px',fontWeight:700,cursor:'pointer',fontSize:12}}>추가</button>
            </div>
          </Card>
          <Card style={{overflow:'hidden'}}>
            {alerts.map((a,i)=>(
              <div key={a.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 14px',borderBottom:i<alerts.length-1?`1px solid ${T.border}`:'none'}}>
                <div><div style={{display:'flex',alignItems:'center',gap:6}}><Logo id={a.assetId} size={26} clr='#94A3B8'/><div style={{color:T.txt,fontWeight:700,fontSize:13}}>{a.nameKr}</div></div><div style={{color:T.muted,fontSize:11,marginTop:2}}>{a.condition==='above'?'▲ 이상':'▼ 이하'} ₩{fmt(a.value)}</div></div>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <Toggle on={a.active} onChange={v=>setAlerts(p=>p.map(x=>x.id===a.id?{...x,active:v}:x))}/>
                  <button onClick={()=>setAlerts(p=>p.filter(x=>x.id!==a.id))} style={{background:T.red+'15',color:T.red,border:'none',borderRadius:8,padding:'4px 8px',fontSize:10,cursor:'pointer',fontWeight:700}}>삭제</button>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

/* ── AIPage ── */
const AI_INSIGHTS = [
  {type:'warning',icon:'⚡',title:'BTC 변동성 경고',body:'현재 BTC 24h 변동성이 5.2%로 평상시보다 높습니다. 레버리지를 3배 이하로 낮추는 것을 권장합니다.',time:'방금',color:'#F59E0B'},
  {type:'danger',icon:'🔥',title:'펀딩비 과열',body:'BTC 무기한 선물 펀딩비가 0.08%로 상승했습니다. 롱 포지션 보유 시 펀딩비 비용이 증가합니다.',time:'5분 전',color:'#EF4444'},
  {type:'safe',icon:'✅',title:'장투 포트폴리오 건강',body:'장기 보유 포트폴리오는 안정적입니다. BTC/ETH 비중이 균형 잡혀 있으며 청산 리스크가 없습니다.',time:'10분 전',color:'#10B981'},
  {type:'warning',icon:'⚠️',title:'포지션 집중도 경고',body:'단일 자산(SOL) 비중이 포트폴리오의 35%를 초과했습니다. 분산 투자를 권장합니다.',time:'15분 전',color:'#F59E0B'},
  {type:'info',icon:'📊',title:'시장 요약',body:'나스닥 +0.87%, 코스피 -0.22%. 연준 금리 동결로 위험자산 소폭 강세. 암호화폐 시장 전반적 상승.',time:'20분 전',color:'#3B82F6'},
  {type:'info',icon:'💡',title:'DCA 기회',body:'BTC가 단기 지지선인 9,000만원에 근접했습니다. DCA 매수 전략을 고려해볼 좋은 시점입니다.',time:'30분 전',color:'#3B82F6'},
];

function AIPage() {
  const [msgs,setMsgs]=useState([{role:'ai',text:'안녕하세요! TRAIGO AI 투자 코파일럿입니다 🤖\n\n⚠️ 교육·참고 목적 AI — 수익 보장 없음 · 투자 손실은 본인 책임\n\n현재 시장 상황을 분석하고 리스크 관리를 도와드립니다. 무엇이든 물어보세요!'}]);
  const [input,setInput]=useState('');
  const [loading,setLoading]=useState(false);
  const [tab,setTab]=useState<'chat'|'insights'|'signals'>('insights');
  const endRef=useRef<HTMLDivElement>(null);

  const KB:Record<string,string>={
    'RSI':'RSI(상대강도지수)는 0-100 범위입니다. 📊 70↑ 과매수(하락 주의) · 30↓ 과매도(반등 가능). 다른 지표와 함께 사용하세요. ⚠️ 수익 보장 없음.',
    '레버리지':'레버리지 위험도:\n• 1-3x: 낮은 위험 (초보자 권장)\n• 5-10x: 중간 위험 (경험자)\n• 20x↑: 고위험 (전문가만)\n⚠️ 레버리지가 높을수록 청산 가능성이 급격히 증가합니다.',
    '손절':'손절(Stop Loss) 설정법:\n• 스팟: -5~10%\n• 선물 낮은 레버: -3~5%\n• 선물 높은 레버: -1~2%\n🎯 손절가는 진입 전에 반드시 설정하세요.',
    'DCA':'DCA(Dollar Cost Averaging)란?\n• 정기적으로 일정 금액을 매수하는 전략\n• 평균 단가를 낮추는 효과\n• 장기 투자에 특히 효과적\n• TRAIGO 장투 포트폴리오에서 설정 가능',
    'MACD':'MACD는 두 이동평균의 차이를 나타냅니다.\n• MACD > 시그널선: 상승 신호\n• MACD < 시그널선: 하락 신호\n• 히스토그램으로 추세 강도 확인\n⚠️ 보조 지표로만 사용 권장',
    '볼린저밴드':'볼린저밴드 활용:\n• 상단 터치 → 과매수 (숏 고려)\n• 하단 터치 → 과매도 (롱 고려)\n• 밴드 수축 → 큰 움직임 예고\n• 밴드 확장 → 강한 추세',
    'FOMC':'FOMC(연방공개시장위원회):\n• 금리 인상 → 달러↑, 위험자산↓\n• 금리 동결 → 현상 유지\n• 금리 인하 → 유동성↑, 위험자산↑\n📅 다음 FOMC: 2025년 5월 28일',
    '펀딩비':'펀딩비(Funding Rate):\n• 선물 시장에서 8시간마다 지급\n• 양수(+): 롱이 숏에게 지급 → 롱 과열\n• 음수(-): 숏이 롱에게 지급 → 숏 과열\n⚠️ 펀딩비 0.1% 이상 시 추세 역전 주의',
    '포지션사이징':'포지션 사이징 공식:\n• 위험금액 = 총자산 × 위험비율(1-2%)\n• 포지션크기 = 위험금액 ÷ 손절%\n예시: 1000만원 × 2% ÷ 5% = 400만원\n🎯 TRAIGO 사이징 탭에서 자동 계산 가능',
    '시장':'현재 시장 분석:\n• BTC: +2.31% (단기 강세)\n• 나스닥: +0.87% (기술주 강세)\n• 코스피: -0.22% (외국인 매도)\n• 원/달러: 1,378원 (달러 약세)\n⚠️ 참고 정보 · 투자 조언 아님',
  };

  const QUICK=['RSI 설명','레버리지 위험','DCA 전략','MACD 활용','볼린저밴드','펀딩비란?','포지션 사이징'];

  const SIGNALS=[
    {asset:'BTC',signal:'중립',reason:'RSI 58 · EMA 골든크로스 근접',direction:'관망',color:T.ylw},
    {asset:'ETH',signal:'매수',reason:'RSI 42 · 볼린저 하단 반등',direction:'롱 고려',color:T.grn},
    {asset:'SOL',signal:'주의',reason:'RSI 72 · 과매수 구간 진입',direction:'익절 고려',color:T.red},
    {asset:'NVDA',signal:'매수',reason:'EMA20 > EMA60 · 어닝 모멘텀',direction:'롱 고려',color:T.grn},
    {asset:'QQQ',signal:'중립',reason:'FOMC 대기 · 변동성 축소',direction:'관망',color:T.ylw},
  ];

  useEffect(()=>{endRef.current?.scrollIntoView({behavior:'smooth'});},[msgs]);

  const send=useCallback((q?:string)=>{
    const text=q||input;if(!text.trim())return;
    setMsgs(p=>[...p,{role:'user',text}]);setInput('');setLoading(true);
    setTimeout(()=>{
      const key=Object.keys(KB).find(k=>text.includes(k));
      const reply=key?`${KB[key]}\n\n⚠️ 이 정보는 교육 목적이며 투자 조언이 아닙니다.`:'좋은 질문이에요! 다음 주제에 대해 물어보세요:\nRSI · 레버리지 · 손절 · DCA · MACD · 볼린저밴드 · FOMC · 펀딩비 · 포지션사이징 · 시장\n\n⚠️ TRAIGO AI는 교육 목적이며 수익을 보장하지 않습니다.';
      setMsgs(p=>[...p,{role:'ai',text:reply}]);setLoading(false);
    },700);
  },[input]);

  return (
    <div>
      {/* Sub tabs */}
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {(['insights','signals','chat'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:'9px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:12,fontWeight:700,fontSize:11,cursor:'pointer'}}>
            {t==='insights'?'🔔 AI 인사이트':t==='signals'?'📡 매매 신호':'💬 AI 채팅'}
          </button>
        ))}
      </div>

      {/* AI Insights */}
      {tab==='insights'&&(
        <div>
          <div style={{background:T.prp+'15',border:`1px solid ${T.prp}30`,borderRadius:12,padding:'10px 14px',marginBottom:14}}>
            <div style={{color:T.prp,fontWeight:700,fontSize:11}}>⚠️ AI 인사이트 안내</div>
            <div style={{color:T.sub,fontSize:10,marginTop:2}}>모든 AI 분석은 교육·참고 목적입니다. 수익을 보장하지 않으며 투자 판단은 본인 책임입니다.</div>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            {AI_INSIGHTS.map((ins,i)=>(
              <Card key={i} style={{padding:'14px 16px',border:`1px solid ${ins.color}25`}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                  <div style={{flex:1}}>
                    <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:6}}>
                      <span style={{fontSize:16}}>{ins.icon}</span>
                      <span style={{color:ins.color,fontWeight:700,fontSize:12}}>{ins.title}</span>
                    </div>
                    <div style={{color:T.sub,fontSize:12,lineHeight:1.6}}>{ins.body}</div>
                  </div>
                  <span style={{color:T.muted,fontSize:10,flexShrink:0,marginLeft:8}}>{ins.time}</span>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Trading Signals */}
      {tab==='signals'&&(
        <div>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'10px 14px',marginBottom:14}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>⚠️ AI 신호는 참고용입니다. 수익 보장 없음.</div>
          </div>
          <Card style={{overflow:'hidden',marginBottom:12}}>
            <div style={{padding:'12px 14px',borderBottom:`1px solid ${T.border}`,color:T.muted,fontSize:10,fontWeight:700,textTransform:'uppercase'}}>AI 매매 신호 (모의)</div>
            {SIGNALS.map((s,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 14px',borderBottom:i<SIGNALS.length-1?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <Logo id={s.asset} size={30} clr={s.color}/>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:13}}>{s.asset}</div>
                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>{s.reason}</div>
                  </div>
                </div>
                <div style={{textAlign:'right'}}>
                  <Bdg c={s.color} ch={s.signal}/>
                  <div style={{color:s.color,fontSize:10,fontWeight:700,marginTop:4}}>{s.direction}</div>
                </div>
              </div>
            ))}
          </Card>
          {/* TradingView signal placeholder */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.cyn}30`}}>
            <div style={{color:T.cyn,fontWeight:700,fontSize:12,marginBottom:8}}>📺 TradingView 신호 연동</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6,marginBottom:10}}>TradingView 알림을 TRAIGO와 연동하면 실시간 매매 신호를 받을 수 있습니다.</div>
            <div style={{display:'flex',gap:6}}>
              <input placeholder="Webhook URL" style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:11,outline:'none'}}/>
              <button style={{background:T.cyn+'20',color:T.cyn,border:`1px solid ${T.cyn}40`,borderRadius:8,padding:'8px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>연동</button>
            </div>
          </Card>
        </div>
      )}

      {/* AI Chat */}
      {tab==='chat'&&(
        <div>
          <div style={{background:T.prp+'15',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'9px 14px',marginBottom:12}}>
            <div style={{color:T.prp,fontWeight:700,fontSize:11}}>⚠️ 교육 목적 AI · 수익 보장 없음 · 투자 손실은 본인 책임</div>
          </div>
          <div style={{display:'flex',flexDirection:'column',height:420}}>
            <div style={{flex:1,overflowY:'auto',display:'flex',flexDirection:'column',gap:8,padding:'4px 0'}}>
              {msgs.map((m,i)=>(
                <div key={i} style={{display:'flex',justifyContent:m.role==='user'?'flex-end':'flex-start'}}>
                  <div style={{maxWidth:'85%',background:m.role==='user'?T.acc:T.alt,color:T.txt,borderRadius:m.role==='user'?'14px 14px 4px 14px':'14px 14px 14px 4px',padding:'10px 14px',fontSize:12,lineHeight:1.6,border:`1px solid ${m.role==='user'?T.acc:T.border}`,whiteSpace:'pre-wrap'}}>
                    {m.text}
                  </div>
                </div>
              ))}
              {loading&&<div style={{display:'flex',gap:4,padding:'4px 12px'}}>{[0,1,2].map(i=><div key={i} style={{width:8,height:8,borderRadius:'50%',background:T.acl,animation:`pulse ${0.6+i*0.2}s ease-in-out infinite`}}/>)}</div>}
              <div ref={endRef}/>
            </div>
            <div style={{display:'flex',gap:5,overflowX:'auto',paddingBottom:8,paddingTop:4}}>
              {QUICK.map(q=><button key={q} onClick={()=>send(q)} style={{background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:20,padding:'4px 10px',fontSize:10,fontWeight:600,cursor:'pointer',whiteSpace:'nowrap',flexShrink:0}}>{q}</button>)}
            </div>
            <div style={{display:'flex',gap:8}}>
              <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&send()} placeholder="투자 질문을 입력하세요…" style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 12px',color:T.txt,fontSize:13,outline:'none'}}/>
              <button onClick={()=>send()} style={{background:T.acc,color:'#fff',border:'none',borderRadius:10,padding:'0 16px',fontWeight:700,cursor:'pointer',fontSize:14}}>→</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
/* ── BacktestPage ── */
function BacktestPage() {
  const [strategy,setStrategy]=useState('EMA Cross');const [asset,setAsset]=useState('BTC');const [period,setPeriod]=useState('6개월');const [running,setRunning]=useState(false);const [result,setResult]=useState<any>(null);
  const run=()=>{
    setRunning(true);setResult(null);
    setTimeout(()=>{
      const trades=Array.from({length:42},(_,i)=>({n:i+1,side:Math.random()>0.4?'매수':'매도',pnl:+(Math.random()-0.38)*500000,pnlPct:+(Math.random()-0.38)*5}));
      const wins=trades.filter(t=>t.pnl>0).length;
      setResult({winRate:Math.round(wins/trades.length*100),totalPnl:trades.reduce((s,t)=>s+t.pnl,0),maxDrawdown:-12.4,profitFactor:2.1,sharpe:1.82,trades});
      setRunning(false);
    },2000);
  };
  return (
    <div>
      <div style={{fontWeight:800,fontSize:15,color:T.txt,marginBottom:12}}>🧪 백테스팅</div>
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>설정</div>
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          {[{l:'전략',v:strategy,opts:['EMA Cross','RSI Oversold','Bollinger Bounce','DCA'],set:setStrategy},{l:'종목',v:asset,opts:['BTC','ETH','AAPL','NVDA','NDX'],set:setAsset},{l:'기간',v:period,opts:['1개월','3개월','6개월','1년','3년'],set:setPeriod}].map(f=>(
            <div key={f.l}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>{f.l}</div>
              <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>{f.opts.map(o=><button key={o} onClick={()=>f.set(o)} style={{background:f.v===o?T.acg:'transparent',color:f.v===o?T.acl:T.muted,border:`1px solid ${f.v===o?T.acl:T.border}`,borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>{o}</button>)}</div>
            </div>
          ))}
        </div>
        <button onClick={run} disabled={running} style={{width:'100%',padding:'12px',background:running?'#243A5E':`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer',marginTop:14}}>{running?'⏳ 백테스트 실행 중…':'🚀 백테스트 실행'}</button>
      </Card>
      {result&&(
        <div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:12}}>
            {[{l:'승률',v:result.winRate+'%',c:T.grn},{l:'총 수익',v:'₩'+fmt(result.totalPnl),c:result.totalPnl>=0?T.grn:T.red},{l:'최대손실',v:result.maxDrawdown+'%',c:T.red},{l:'수익팩터',v:result.profitFactor,c:T.ylw},{l:'샤프지수',v:result.sharpe,c:T.acl},{l:'총 거래',v:result.trades.length+'건',c:T.txt}].map(s=>(
              <Card key={s.l} style={{padding:'12px 10px'}}>
                <div style={{color:T.muted,fontSize:9,fontWeight:700,marginBottom:4}}>{s.l}</div>
                <div style={{color:s.c,fontSize:15,fontWeight:900,fontFamily:'monospace'}}>{s.v}</div>
              </Card>
            ))}
          </div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>📈 수익 곡선 (mock)</div>
            <AreaChart color={T.acl} h={100} up={true}/>
          </Card>
          <Card style={{overflow:'hidden'}}>
            <div style={{padding:'10px 14px',borderBottom:`1px solid ${T.border}`,color:T.muted,fontSize:10,fontWeight:700}}>매매 목록 (최근 10건)</div>
            {result.trades.slice(0,10).map((t:any)=>(
              <div key={t.n} style={{display:'flex',justifyContent:'space-between',padding:'9px 14px',borderBottom:`1px solid ${T.border}`}}>
                <div style={{color:T.txt,fontSize:11}}>#{t.n} {t.side}</div>
                <div style={{color:t.pnl>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{t.pnl>=0?'+':''}{fmt(t.pnl)}원 ({t.pnlPct.toFixed(2)}%)</div>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

/* ── HistoryPage ── */
function HistoryPage() {
  const [entries]=useState([
    {id:'1',date:'2025-05-10',sym:'BTC',side:'매수',pnl:'+₩240,000',pnlPct:'+2.31%',emotion:'😊',plan:'RSI 과매도 구간 진입',result:'목표가 달성',aiReview:'손절 준수와 계획적 매수 - 훌륭한 거래였습니다!',rating:4},
    {id:'2',date:'2025-05-08',sym:'NVDA',side:'매수',pnl:'+₩185,000',pnlPct:'+5.77%',emotion:'😊',plan:'어닝서프라이즈 기대',result:'목표 초과 달성',aiReview:'거래 타이밍이 좋았습니다.',rating:5},
    {id:'3',date:'2025-05-06',sym:'ETH',side:'매도',pnl:'-₩72,000',pnlPct:'-1.12%',emotion:'😔',plan:'저항선 테스트 예상',result:'손절 실행',aiReview:'손절을 지킨 것은 올바른 결정입니다.',rating:3},
  ]);
  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div style={{fontWeight:800,fontSize:15,color:T.txt}}>📝 매매일지</div>
        <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,padding:'5px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 추가</button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:14}}>
        {[{l:'총 거래',v:'47건'},{l:'수익 거래',v:'33건'},{l:'승률',v:'70.2%'}].map(x=>(
          <Card key={x.l} style={{padding:'12px 10px',textAlign:'center'}}>
            <div style={{color:T.muted,fontSize:10,marginBottom:4}}>{x.l}</div>
            <div style={{color:T.txt,fontWeight:800,fontSize:14}}>{x.v}</div>
          </Card>
        ))}
      </div>
      {entries.map(e=>(
        <Card key={e.id} style={{padding:'14px 16px',marginBottom:10}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}><Logo id={e.sym} size={28} clr='#94A3B8'/><div><div style={{color:T.txt,fontWeight:700,fontSize:13}}>{e.sym} {e.side}</div><div style={{color:T.muted,fontSize:10}}>{e.date}</div></div></div>
            <div style={{textAlign:'right'}}><div style={{color:e.pnl.startsWith('+')?T.grn:T.red,fontWeight:800,fontSize:13}}>{e.pnl}</div><div style={{color:e.pnlPct.startsWith('+')?T.grn:T.red,fontSize:10}}>{e.pnlPct}</div></div>
          </div>
          <div style={{display:'flex',gap:4,marginBottom:8}}>
            {Array.from({length:5},(_,i)=><span key={i} style={{fontSize:14,opacity:i<e.rating?1:0.2}}>⭐</span>)}
            <span style={{marginLeft:4,fontSize:16}}>{e.emotion}</span>
          </div>
          <div style={{background:T.acl+'12',border:`1px solid ${T.acl}30`,borderRadius:8,padding:'8px 10px'}}>
            <div style={{color:T.acl,fontSize:10,fontWeight:700,marginBottom:3}}>🤖 AI 리뷰</div>
            <div style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{e.aiReview}</div>
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ── AcademyPage ── */
function AcademyPage() {
  const [level,setLevel]=useState('입문');
  const lessons:Record<string,any[]>={
    '입문':[
      {id:1,title:'📈 주식 투자 기초',desc:'주식이란 무엇인가? 기본 개념 이해',time:'10분',done:true},
      {id:2,title:'₿ 암호화폐 기초',desc:'블록체인과 비트코인의 작동 원리',time:'15분',done:true},
      {id:3,title:'📊 차트 읽는 법',desc:'캔들스틱 차트 기본 패턴 이해',time:'20분',done:false},
      {id:4,title:'💰 분산 투자 전략',desc:'리스크를 줄이는 포트폴리오 구성',time:'12분',done:false},
    ],
    '중급':[
      {id:5,title:'📉 기술적 분석 심화',desc:'RSI, MACD, 볼린저밴드 활용법',time:'30분',done:false},
      {id:6,title:'🎯 손절과 익절 전략',desc:'리스크 관리의 핵심 원칙',time:'25분',done:false},
      {id:7,title:'⚡ 레버리지 트레이딩',desc:'레버리지의 위험과 활용법',time:'20분',done:false},
      {id:8,title:'🔄 스윙 트레이딩',desc:'중기 추세를 이용한 매매 전략',time:'35분',done:false},
    ],
    '고급':[
      {id:9,title:'🤖 알고리즘 트레이딩',desc:'자동화 전략 설계와 백테스팅',time:'45분',done:false},
      {id:10,title:'📐 포트폴리오 최적화',desc:'샤프지수와 효율적 경계선 이론',time:'40분',done:false},
      {id:11,title:'🌍 매크로 분석',desc:'금리, 환율, 지정학적 리스크 분석',time:'35분',done:false},
    ],
  };
  return (
    <div>
      <div style={{fontWeight:800,fontSize:15,color:T.txt,marginBottom:12}}>📚 트레이딩 아카데미</div>
      <div style={{display:'flex',gap:8,marginBottom:14}}>
        {['입문','중급','고급'].map(l=><button key={l} onClick={()=>setLevel(l)} style={{flex:1,padding:'10px',background:level===l?T.acg:'transparent',color:level===l?T.acl:T.muted,border:`1px solid ${level===l?T.acl:T.border}`,borderRadius:12,fontWeight:700,fontSize:12,cursor:'pointer'}}>{l}</button>)}
      </div>
      {lessons[level].map((ls)=>(
        <Card key={ls.id} style={{padding:'14px 16px',marginBottom:8,opacity:ls.done?0.7:1}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div style={{flex:1}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}>{ls.done&&<span style={{color:T.grn,fontSize:12}}>✅</span>}<div style={{color:T.txt,fontWeight:700,fontSize:13}}>{ls.title}</div></div>
              <div style={{color:T.sub,fontSize:11,lineHeight:1.5,marginBottom:4}}>{ls.desc}</div>
              <div style={{color:T.muted,fontSize:10}}>⏱ {ls.time}</div>
            </div>
            <button style={{background:ls.done?'transparent':T.acg,color:ls.done?T.muted:T.acl,border:`1px solid ${ls.done?T.border:T.acl+'40'}`,borderRadius:10,padding:'7px 12px',fontSize:11,fontWeight:700,cursor:'pointer',flexShrink:0,marginLeft:10}}>{ls.done?'완료':'시작'}</button>
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ── ScannerPage ── */
function ScannerPage({prices,currency}:{prices:Asset[];currency:string}) {
  const [tab,setTab]=useState('급등');
  const gainers=[...prices].sort((a,b)=>b.c-a.c).slice(0,8);
  const losers=[...prices].sort((a,b)=>a.c-b.c).slice(0,8);
  const vols=[...prices].sort((a,b)=>Math.abs(b.c)-Math.abs(a.c)).slice(0,8);
  const lists:Record<string,Asset[]>={급등:gainers,급락:losers,변동성:vols};
  return (
    <div>
      <div style={{fontWeight:800,fontSize:15,color:T.txt,marginBottom:12}}>🔍 마켓 스캐너</div>
      <div style={{display:'flex',gap:8,marginBottom:12}}>
        {['급등','급락','변동성'].map(k=><button key={k} onClick={()=>setTab(k)} style={{flex:1,padding:'9px',background:tab===k?T.acg:'transparent',color:tab===k?T.acl:T.muted,border:`1px solid ${tab===k?T.acl:T.border}`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer'}}>{k}</button>)}
      </div>
      <Card style={{overflow:'hidden',marginBottom:16}}>
        {lists[tab].map((a,i)=>(
          <div key={a.id} style={{display:'grid',gridTemplateColumns:'1fr 95px',padding:'11px 14px',borderBottom:i<7?`1px solid ${T.border}`:'none',alignItems:'center'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}><Logo id={a.id} size={34} clr={a.clr}/><div><div style={{color:T.txt,fontWeight:700,fontSize:12}}>{a.nameKr}</div><div style={{color:T.muted,fontSize:10}}>{a.sym}</div></div></div>
            <div style={{textAlign:'right'}}><div style={{color:a.c>=0?T.grn:T.red,fontWeight:900,fontSize:13,fontFamily:'monospace'}}>{a.c>=0?'▲':'▼'}{Math.abs(a.c).toFixed(2)}%</div><div style={{color:T.muted,fontSize:10}}>{cvt(a.p,currency)}</div></div>
          </div>
        ))}
      </Card>
      <WorldClock/>
    </div>
  );
}

/* ── SettingsPage ── */
function SettingsPage({lang,setLang,currency,setCurrency}:{lang:string;setLang:(l:string)=>void;currency:string;setCurrency:(c:string)=>void}) {
  const [tab,setTab]=useState<'general'|'security'|'pro'|'legal'>('general');
  const [notif,setNotif]=useState({trade:true,profit:true,news:false,alert:true,leverage:true});
  const [sec,setSec]=useState({twoFa:true,bio:true,lock:false,sessionAlert:true});
  const [apiKeys]=useState([{id:1,name:'API Key #1',created:'2025-01-15',lastUsed:'2025-05-10',active:true}]);

  return (
    <div>
      <div style={{display:'flex',gap:6,marginBottom:14,overflowX:'auto'}}>
        {(['general','security','pro','legal'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flexShrink:0,padding:'7px 12px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {t==='general'?'⚙️ 일반':t==='security'?'🔒 보안':t==='pro'?'💎 Pro':'⚖️ 법적'}
          </button>
        ))}
      </div>

      {tab==='general'&&(
        <div>
          {/* Profile */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
              <div style={{width:52,height:52,borderRadius:15,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:24}}>👤</div>
              <div>
                <div style={{color:T.txt,fontWeight:800,fontSize:15}}>투자자님</div>
                <div style={{color:T.muted,fontSize:11}}>mock 모드 · 모의투자 전용</div>
                <div style={{marginTop:4,display:'flex',gap:6}}>
                  <Bdg c={T.gld} ch="무료 플랜"/>
                  <Bdg c={T.grn} ch="모의투자"/>
                </div>
              </div>
            </div>
            <div style={{display:'flex',gap:8}}>
              <a href="/auth" style={{flex:1,padding:'9px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer',textDecoration:'none',textAlign:'center'}}>🔐 로그인/회원가입</a>
              <a href="/admin" style={{padding:'9px 14px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer',textDecoration:'none'}}>관리자</a>
            </div>
          </Card>

          {/* Language */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🌍 언어</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:7}}>
              {LANGS.map(l=>(
                <button key={l.code} onClick={()=>setLang(l.code)} style={{background:lang===l.code?T.acg:'transparent',color:lang===l.code?T.acl:T.txt,border:`1px solid ${lang===l.code?T.acl:T.border}`,borderRadius:10,padding:'8px 4px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:18}}>{l.flag}</div>
                  <div style={{fontSize:10,fontWeight:600,marginTop:3}}>{l.name}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Currency */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>💱 기본 통화</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
              {Object.entries(CURRENCIES).map(([code,cur])=>(
                <button key={code} onClick={()=>setCurrency(code)} style={{background:currency===code?T.acg:'transparent',color:currency===code?T.acl:T.txt,border:`1px solid ${currency===code?T.acl:T.border}`,borderRadius:10,padding:'8px 4px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:14}}>{cur.flag}</div>
                  <div style={{fontSize:11,fontWeight:700}}>{cur.symbol}</div>
                  <div style={{fontSize:9,color:T.muted}}>{code}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Notifications */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔔 알림 설정</div>
            {[{k:'trade',l:'매매 완료'},{k:'profit',l:'수익 목표'},{k:'news',l:'시장 뉴스'},{k:'alert',l:'가격 알림'},{k:'leverage',l:'레버리지 경고'}].map((n,i,arr)=>(
              <div key={n.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{n.l}</span>
                <Toggle on={notif[n.k as keyof typeof notif]} onChange={v=>setNotif(p=>({...p,[n.k]:v}))}/>
              </div>
            ))}
          </Card>

          {/* Risk Profile */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🎯 위험 성향 설정</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {[{v:'conservative',l:'보수형',d:'안전 우선',c:T.grn},{v:'balanced',l:'균형형',d:'균형 추구',c:T.ylw},{v:'aggressive',l:'공격형',d:'수익 우선',c:T.red}].map(p=>(
                <button key={p.v} style={{background:T.alt,border:`1px solid ${p.c}40`,borderRadius:12,padding:'12px 6px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{color:p.c,fontSize:18,marginBottom:4}}>{'보수형'===p.l?'🛡️':'균형형'===p.l?'⚖️':'🔥'}</div>
                  <div style={{color:T.txt,fontWeight:700,fontSize:11}}>{p.l}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:2}}>{p.d}</div>
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab==='security'&&(
        <div>
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔒 보안 설정</div>
            {[{k:'twoFa',l:'2단계 인증 (2FA)',d:'Google Authenticator 사용'},{k:'bio',l:'생체인식 로그인',d:'Face ID / Touch ID'},{k:'lock',l:'자동 잠금 5분',d:'비활동 시 자동 잠금'},{k:'sessionAlert',l:'새 로그인 알림',d:'새 기기 로그인 시 알림'}].map((s,i,arr)=>(
              <div key={s.k} style={{padding:'10px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{s.l}</div><div style={{color:T.muted,fontSize:10}}>{s.d}</div></div>
                  <Toggle on={sec[s.k as keyof typeof sec]} onChange={v=>setSec(p=>({...p,[s.k]:v}))}/>
                </div>
              </div>
            ))}
          </Card>

          {/* API Keys */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700}}>🔑 API 키 관리</div>
              <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 생성</button>
            </div>
            {apiKeys.map(k=>(
              <div key={k.id} style={{background:T.alt,borderRadius:10,padding:'10px 12px',marginBottom:8}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{k.name}</div><div style={{color:T.muted,fontSize:10}}>생성: {k.created} · 최근: {k.lastUsed}</div></div>
                  <div style={{display:'flex',gap:6,alignItems:'center'}}><Bdg c={T.grn} ch="활성"/><button style={{background:T.red+'15',color:T.red,border:'none',borderRadius:6,padding:'3px 7px',fontSize:10,cursor:'pointer'}}>삭제</button></div>
                </div>
              </div>
            ))}
            <div style={{color:T.muted,fontSize:10,marginTop:6}}>⚠️ API 키는 절대 타인과 공유하지 마세요</div>
          </Card>

          {/* Login history */}
          <Card style={{padding:16}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📋 로그인 기록</div>
            {[{device:'iPhone 15 Pro',loc:'서울, 대한민국',time:'2025-05-13 09:24',current:true},{device:'MacBook Pro',loc:'서울, 대한민국',time:'2025-05-12 18:30',current:false}].map((l,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<1?`1px solid ${T.border}`:'none'}}>
                <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{l.device} {l.current&&<Bdg c={T.grn} ch="현재"/>}</div><div style={{color:T.muted,fontSize:10}}>{l.loc} · {l.time}</div></div>
                {!l.current&&<button style={{background:T.red+'15',color:T.red,border:'none',borderRadius:6,padding:'3px 7px',fontSize:10,cursor:'pointer'}}>종료</button>}
              </div>
            ))}
          </Card>
        </div>
      )}

      {tab==='pro'&&(
        <div>
          {/* Pro plans */}
          <Card style={{padding:16,marginBottom:12,border:`1px solid ${T.gld}40`}}>
            <div style={{textAlign:'center',marginBottom:16}}>
              <div style={{fontSize:32,marginBottom:6}}>💎</div>
              <div style={{color:T.txt,fontWeight:900,fontSize:18}}>TRAIGO Pro</div>
              <div style={{color:T.muted,fontSize:12}}>프로 트레이더를 위한 완전한 도구</div>
            </div>
            {[
              {l:'AI 무제한 분석',v:'월 10회 → 무제한',c:T.grn},
              {l:'고급 레버리지 도구',v:'최대 100배 접근',c:T.grn},
              {l:'AI 매매 신호',v:'실시간 알림',c:T.grn},
              {l:'전략 마켓플레이스',v:'프리미엄 전략 접근',c:T.grn},
              {l:'우선 고객 지원',v:'24/7 전담 지원',c:T.grn},
            ].map((f,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:i<4?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{f.l}</span>
                <span style={{color:f.c,fontSize:11,fontWeight:700}}>✅ {f.v}</span>
              </div>
            ))}
            <div style={{marginTop:16,textAlign:'center'}}>
              <button style={{width:'100%',padding:'14px',background:`linear-gradient(135deg,${T.gld},#B45309)`,color:'#fff',border:'none',borderRadius:14,fontWeight:900,fontSize:15,cursor:'pointer'}}>
                💎 Pro 구독 (준비중)
              </button>
              <div style={{color:T.muted,fontSize:10,marginTop:6}}>베타 기간 무료 · 향후 월 ₩29,900</div>
            </div>
          </Card>

          {/* Strategy Marketplace */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🏪 전략 마켓플레이스</div>
            {[
              {name:'프리미엄 EMA 전략',creator:'@toptrader',win:'74%',price:'무료',rating:'4.8'},
              {name:'AI 선물 전략',creator:'@aiquant',win:'68%',price:'₩9,900/월',rating:'4.6'},
              {name:'DCA 마스터',creator:'@longterm',win:'82%',price:'무료',rating:'4.9'},
            ].map((s,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<2?`1px solid ${T.border}`:'none'}}>
                <div>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{s.name}</div>
                  <div style={{display:'flex',gap:6,marginTop:2}}><span style={{color:T.muted,fontSize:10}}>{s.creator}</span><span style={{color:T.grn,fontSize:10}}>승률 {s.win}</span><span style={{color:T.ylw,fontSize:10}}>⭐{s.rating}</span></div>
                </div>
                <button style={{background:s.price==='무료'?T.grn+'15':T.ylw+'15',color:s.price==='무료'?T.grn:T.ylw,border:`1px solid ${s.price==='무료'?T.grn:T.ylw}30`,borderRadius:8,padding:'5px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{s.price}</button>
              </div>
            ))}
          </Card>

          {/* Referral */}
          <Card style={{padding:16}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:8}}>🎁 친구 초대</div>
            <div style={{color:T.muted,fontSize:11,marginBottom:10}}>친구를 초대하면 Pro 1개월을 무료로 받을 수 있습니다.</div>
            <div style={{display:'flex',gap:8}}>
              <input value="traigo.app/ref/MYCODE" readOnly style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.sub,fontSize:11,outline:'none'}}/>
              <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'8px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>복사</button>
            </div>
          </Card>
        </div>
      )}

      {tab==='legal'&&(
        <div>
          <Card style={{padding:16,marginBottom:12,border:`1px solid ${T.ylw}30`}}>
            <div style={{color:T.ylw,fontWeight:800,fontSize:13,marginBottom:10}}>⚠️ 중요 법적 고지</div>
            {['TRAIGO는 교육·시뮬레이션 목적의 모의투자 플랫폼입니다','실제 금융 거래를 실행하지 않습니다','수익을 보장하지 않으며 모든 투자 손실은 투자자 본인의 책임입니다','레버리지 거래는 원금 초과 손실이 발생할 수 있습니다','표시되는 시세는 참고용이며 지연될 수 있습니다'].map((t,i,arr)=>(
              <div key={i} style={{display:'flex',gap:6,padding:'5px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.ylw,fontSize:11,flexShrink:0}}>•</span>
                <span style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{t}</span>
              </div>
            ))}
          </Card>
          <Card style={{padding:16}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📄 법적 문서</div>
            {[{l:'이용약관',href:'/terms'},{l:'개인정보처리방침',href:'/privacy'},{l:'투자 위험 고지',href:'/terms'},{l:'FAQ / 도움말',href:'/terms'}].map((l,i,arr)=>(
              <a key={i} href={l.href} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none',textDecoration:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{l.l}</span>
                <span style={{color:T.muted,fontSize:14}}>›</span>
              </a>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
/* ── SocialPage ── */
function SocialPage() {
  const [tab,setTab]=useState<'leaderboard'|'feed'|'copy'>('leaderboard');
  const TRADERS=[
    {rank:1,name:'@cryptoking',flag:'🇰🇷',pnl:'+₩24.8M',pct:'+247%',win:'78%',followers:1842,badge:'👑'},
    {rank:2,name:'@wallst_pro',flag:'🇺🇸',pnl:'+₩18.2M',pct:'+182%',win:'71%',followers:1203,badge:'🥈'},
    {rank:3,name:'@btcmaxi',flag:'🇯🇵',pnl:'+₩15.6M',pct:'+156%',win:'69%',followers:987,badge:'🥉'},
    {rank:4,name:'@ethlover',flag:'🇰🇷',pnl:'+₩12.1M',pct:'+121%',win:'65%',followers:742,badge:''},
    {rank:5,name:'@dca_master',flag:'🇺🇸',pnl:'+₩9.4M',pct:'+94%',win:'83%',followers:621,badge:''},
  ];
  const FEED=[
    {user:'@cryptoking',badge:'👑',time:'5분 전',text:'BTC 다시 9400만 돌파! 10월 반감기 이후 상승세 지속 중. 장투 홀더들 수고하셨어요 💪',likes:142,comments:28},
    {user:'@wallst_pro',badge:'🥈',time:'12분 전',text:'NVDA 실적 발표 내일. AI 수요 지속으로 어닝서프라이즈 예상. 단기 옵션 포지션 진입 완료.⚠️ 투자 조언 아님.',likes:89,comments:15},
    {user:'@dca_master',badge:'',time:'30분 전',text:'ETH 주간 DCA 완료. 평단 420만원. 목표 1000만원까지 꾸준히 적립 예정. DCA는 감정 없이 실행이 핵심!',likes:201,comments:44},
  ];
  return (
    <div>
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {(['leaderboard','feed','copy'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:'8px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {t==='leaderboard'?'🏆 리더보드':t==='feed'?'📱 피드':'🔗 카피'}
          </button>
        ))}
      </div>
      <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'8px 12px',marginBottom:14}}>
        <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>⚠️ 소셜 기능 안내: 모든 성과는 모의투자 기준. 실제 수익 보장 없음.</div>
      </div>
      {tab==='leaderboard'&&(
        <div>
          <Card style={{overflow:'hidden',marginBottom:12}}>
            <div style={{padding:'12px 14px',borderBottom:`1px solid ${T.border}`,color:T.muted,fontSize:10,fontWeight:700,textTransform:'uppercase'}}>이번 달 수익 순위 (모의투자)</div>
            {TRADERS.map((t2,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 14px',borderBottom:i<TRADERS.length-1?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',gap:10,alignItems:'center'}}>
                  <div style={{width:28,height:28,borderRadius:8,background:i<3?`linear-gradient(135deg,${[T.gld,'#94A3B8','#C2410C'][i]},${[T.gld+'88','#64748B','#9A3412'][i]})`:T.alt,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:12,color:'#fff',flexShrink:0}}>{t2.badge||t2.rank}</div>
                  <div>
                    <div style={{display:'flex',gap:4,alignItems:'center'}}><span style={{fontSize:12}}>{t2.flag}</span><span style={{color:T.txt,fontWeight:700,fontSize:13}}>{t2.name}</span></div>
                    <div style={{display:'flex',gap:6,marginTop:1}}><span style={{color:T.grn,fontSize:10}}>승률 {t2.win}</span><span style={{color:T.muted,fontSize:10}}>{t2.followers}명 팔로워</span></div>
                  </div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.grn,fontWeight:900,fontSize:13,fontFamily:'monospace'}}>{t2.pnl}</div>
                  <div style={{color:T.grn,fontSize:11}}>{t2.pct}</div>
                </div>
              </div>
            ))}
          </Card>
          <Card style={{padding:'12px 14px',background:T.acg,border:`1px solid ${T.acl}30`}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:4}}>📊 내 순위</div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div style={{color:T.muted,fontSize:11}}>현재 순위 #247 · 수익 +₩1.2M (+12.4%)</div>
              <Bdg c={T.acl} ch="Top 5%"/>
            </div>
          </Card>
        </div>
      )}
      {tab==='feed'&&(
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          {FEED.map((f,i)=>(
            <Card key={i} style={{padding:'14px 16px'}}>
              <div style={{display:'flex',gap:10,alignItems:'flex-start'}}>
                <div style={{width:36,height:36,borderRadius:10,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}}>{f.badge||'👤'}</div>
                <div style={{flex:1}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                    <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{f.user}</span>
                    <span style={{color:T.muted,fontSize:10}}>{f.time}</span>
                  </div>
                  <div style={{color:T.sub,fontSize:12,lineHeight:1.6,marginBottom:8}}>{f.text}</div>
                  <div style={{display:'flex',gap:16}}>
                    <button style={{background:'transparent',border:'none',color:T.muted,fontSize:11,cursor:'pointer',display:'flex',gap:4,alignItems:'center'}}>❤️ {f.likes}</button>
                    <button style={{background:'transparent',border:'none',color:T.muted,fontSize:11,cursor:'pointer',display:'flex',gap:4,alignItems:'center'}}>💬 {f.comments}</button>
                    <button style={{background:'transparent',border:'none',color:T.muted,fontSize:11,cursor:'pointer'}}>↗️ 공유</button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {tab==='copy'&&(
        <div>
          <Card style={{padding:16,marginBottom:12,border:`1px solid ${T.cyn}30`}}>
            <div style={{color:T.cyn,fontWeight:700,fontSize:13,marginBottom:8}}>🔗 카피 트레이딩 (준비중)</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6,marginBottom:12}}>상위 트레이더의 전략을 자동으로 복사할 수 있습니다. 출시 예정 기능입니다.</div>
            <div style={{background:T.cyn+'10',border:`1px solid ${T.cyn}30`,borderRadius:10,padding:'12px 14px'}}>
              <div style={{color:T.cyn,fontSize:12,fontWeight:700,marginBottom:4}}>🚀 베타 신청</div>
              <div style={{display:'flex',gap:8}}>
                <input placeholder="이메일 입력" style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:11,outline:'none'}}/>
                <button style={{background:T.cyn+'20',color:T.cyn,border:`1px solid ${T.cyn}40`,borderRadius:8,padding:'8px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>신청</button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ── AccountsPage (멀티 계좌 + API 연결) ── */
type ExchangeType = 'binance'|'gateio'|'upbit'|'bithumb'|'kr_broker'|'us_broker';
type AccountGroup = 'longterm'|'shortterm'|'auto'|'cash'|'custom';
interface ConnectedAccount {
  id:string; exchange:ExchangeType; nickname:string; group:AccountGroup;
  status:'connected'|'error'|'pending'; balance:number; available:number;
  openPositions:number; todayPnl:number; todayPnlPct:number;
  apiKeyMasked:string; permissions:{trading:boolean;withdrawal:boolean;read:boolean};
  autoTrading:boolean; maxDailyLoss:number; maxPositionSize:number;
  lastSync:string; isPaper:boolean; emergencyStop:boolean;
}
interface BulkOrder {
  assetId:string; nameKr:string; side:'buy'|'sell'; totalAmount:number;
  selectedAccounts:string[]; allocationMethod:'equal'|'percent'|'weighted'|'custom';
  allocations:Record<string,number>; leverage:number;
}

const EXCHANGE_INFO:Record<ExchangeType,{name:string;icon:string;color:string;url:string}> = {
  binance:  {name:'Binance',icon:'🟡',color:'#F0B90B',url:'https://www.binance.com/api'},
  gateio:   {name:'Gate.io',icon:'🔵',color:'#3B82F6',url:'https://www.gate.io/api'},
  upbit:    {name:'Upbit',icon:'🔵',color:'#2563EB',url:'https://upbit.com/open_api'},
  bithumb:  {name:'Bithumb',icon:'🟢',color:'#10B981',url:'https://apidocs.bithumb.com'},
  kr_broker:{name:'국내 증권사',icon:'🇰🇷',color:'#EF4444',url:'#'},
  us_broker:{name:'해외 브로커',icon:'🇺🇸',color:'#6366F1',url:'#'},
};

const GROUP_INFO:Record<AccountGroup,{name:string;color:string;icon:string}> = {
  longterm: {name:'장투 계좌',color:'#3B82F6',icon:'📈'},
  shortterm:{name:'단타 계좌',color:'#F59E0B',icon:'⚡'},
  auto:     {name:'자동매매 계좌',color:'#10B981',icon:'🤖'},
  cash:     {name:'현금 대기 계좌',color:'#94A3B8',icon:'💵'},
  custom:   {name:'커스텀 그룹',color:'#7C3AED',icon:'⚙️'},
};

const MOCK_ACCOUNTS:ConnectedAccount[] = [
  {id:'acc1',exchange:'binance',nickname:'바이낸스 메인',group:'shortterm',status:'connected',balance:15420000,available:8200000,openPositions:3,todayPnl:87000,todayPnlPct:0.57,apiKeyMasked:'BNBX****...****KMN2',permissions:{trading:true,withdrawal:false,read:true},autoTrading:true,maxDailyLoss:500000,maxPositionSize:5000000,lastSync:'방금',isPaper:true,emergencyStop:false},
  {id:'acc2',exchange:'upbit',nickname:'업비트 장투',group:'longterm',status:'connected',balance:32100000,available:5000000,openPositions:5,todayPnl:124000,todayPnlPct:0.39,apiKeyMasked:'UPX****...****A92F',permissions:{trading:true,withdrawal:false,read:true},autoTrading:false,maxDailyLoss:1000000,maxPositionSize:10000000,lastSync:'3분 전',isPaper:true,emergencyStop:false},
  {id:'acc3',exchange:'gateio',nickname:'Gate.io 알트',group:'auto',status:'connected',balance:4800000,available:4800000,openPositions:0,todayPnl:-12000,todayPnlPct:-0.25,apiKeyMasked:'GTX****...****BB1C',permissions:{trading:true,withdrawal:false,read:true},autoTrading:true,maxDailyLoss:200000,maxPositionSize:2000000,lastSync:'1분 전',isPaper:true,emergencyStop:false},
  {id:'acc4',exchange:'kr_broker',nickname:'미래에셋 장투',group:'longterm',status:'pending',balance:0,available:0,openPositions:0,todayPnl:0,todayPnlPct:0,apiKeyMasked:'',permissions:{trading:false,withdrawal:false,read:false},autoTrading:false,maxDailyLoss:0,maxPositionSize:0,lastSync:'미연결',isPaper:true,emergencyStop:false},
];

function AccountsPage({prices,currency}:{prices:Asset[];currency:string}) {
  const [tab,setTab]=useState<'accounts'|'connect'|'bulk'|'safety'>('accounts');
  const [accounts,setAccounts]=useState<ConnectedAccount[]>(MOCK_ACCOUNTS);
  const [selAccs,setSelAccs]=useState<string[]>([]);
  const [connectStep,setConnectStep]=useState(0);
  const [connectExchange,setConnectExchange]=useState<ExchangeType>('binance');
  const [apiKey,setApiKey]=useState('');
  const [apiSecret,setApiSecret]=useState('');
  const [apiNick,setApiNick]=useState('');
  const [bulkOrder,setBulkOrder]=useState<Partial<BulkOrder>>({side:'buy',totalAmount:0,allocationMethod:'equal',selectedAccounts:[],allocations:{},leverage:1});
  const [showEmergency,setShowEmergency]=useState(false);
  const [globalStop,setGlobalStop]=useState(false);

  const totalBalance=accounts.reduce((s,a)=>s+a.balance,0);
  const totalPnl=accounts.reduce((s,a)=>s+a.todayPnl,0);
  const connectedCount=accounts.filter(a=>a.status==='connected').length;

  const toggleAccount=(id:string)=>setSelAccs(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);

  const computeAllocations=(accs:ConnectedAccount[],method:string,total:number):Record<string,number>=>{
    if(accs.length===0)return {};
    if(method==='equal'){const amt=Math.floor(total/accs.length);return Object.fromEntries(accs.map(a=>[a.id,amt]));}
    if(method==='weighted'){const tot=accs.reduce((s,a)=>s+a.available,0);return Object.fromEntries(accs.map(a=>[a.id,Math.floor(total*(a.available/(tot||1)))]));}
    return Object.fromEntries(accs.map(a=>[a.id,Math.floor(total/accs.length)]));
  };

  return (
    <div>
      {/* Global emergency stop banner */}
      {globalStop&&<div style={{background:T.red+'25',border:`1px solid ${T.red}`,borderRadius:12,padding:'12px 14px',marginBottom:14,display:'flex',gap:8,alignItems:'center'}}><span style={{fontSize:20}}>🚨</span><div><div style={{color:T.red,fontWeight:800}}>전체 긴급 정지 활성화</div><div style={{color:T.sub,fontSize:11}}>모든 자동매매가 중단되었습니다. 수동 매매는 가능합니다.</div></div><button onClick={()=>setGlobalStop(false)} style={{marginLeft:'auto',background:T.red,color:'#fff',border:'none',borderRadius:8,padding:'6px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>해제</button></div>}

      {/* Tabs */}
      <div style={{display:'flex',gap:5,marginBottom:14,overflowX:'auto'}}>
        {([['accounts','📱 계좌 현황'],['connect','🔗 API 연결'],['bulk','📦 일괄 매매'],['safety','🛡️ 안전 설정']] as const).map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'8px 12px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{label}</button>
        ))}
      </div>

      {/* ── ACCOUNTS TAB ── */}
      {tab==='accounts'&&(
        <div>
          {/* Paper mode notice */}
          <div style={{background:T.prp+'15',border:`1px solid ${T.prp}30`,borderRadius:12,padding:'10px 14px',marginBottom:14}}>
            <div style={{color:T.prp,fontWeight:700,fontSize:11}}>🎮 모의 API 연결 모드</div>
            <div style={{color:T.sub,fontSize:10,marginTop:2}}>실제 거래소 API가 연결된 것처럼 보이지만 모든 거래는 모의입니다. 실제 자금이 이동하지 않습니다.</div>
          </div>
          {/* Summary */}
          <div style={{background:'linear-gradient(135deg,#0D1A35,#091228)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
            <div style={{color:T.muted,fontSize:11,marginBottom:2}}>연결된 계좌 총 자산 (모의)</div>
            <div style={{color:T.txt,fontSize:26,fontWeight:900,fontFamily:'monospace'}}>{cvt(totalBalance,currency)}</div>
            <div style={{display:'flex',gap:16,marginTop:8}}>
              <div><div style={{color:T.muted,fontSize:10}}>오늘 PnL</div><div style={{color:totalPnl>=0?T.grn:T.red,fontWeight:800}}>{totalPnl>=0?'+':''}{cvt(Math.abs(totalPnl),currency)}</div></div>
              <div><div style={{color:T.muted,fontSize:10}}>연결 계좌</div><div style={{color:T.txt,fontWeight:800}}>{connectedCount}/{accounts.length}개</div></div>
              <div><div style={{color:T.muted,fontSize:10}}>자동매매</div><div style={{color:T.grn,fontWeight:800}}>{accounts.filter(a=>a.autoTrading).length}개 실행</div></div>
            </div>
            <div style={{display:'flex',gap:8,marginTop:12}}>
              <button onClick={()=>setShowEmergency(true)} style={{background:T.red+'20',color:T.red,border:`1px solid ${T.red}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>🚨 전체 긴급 정지</button>
              <button onClick={()=>setTab('connect')} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 계좌 연결</button>
            </div>
          </div>

          {/* Account groups */}
          {(['longterm','shortterm','auto','cash'] as AccountGroup[]).map(grp=>{
            const grpAccs=accounts.filter(a=>a.group===grp);
            if(grpAccs.length===0)return null;
            const gi=GROUP_INFO[grp];
            return (
              <div key={grp} style={{marginBottom:14}}>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}><span style={{fontSize:14}}>{gi.icon}</span><span style={{color:T.txt,fontWeight:700,fontSize:13}}>{gi.name}</span><Bdg c={gi.color} ch={grpAccs.length+'개'} sm/></div>
                {grpAccs.map((acc,i)=>{
                  const ex=EXCHANGE_INFO[acc.exchange];
                  const isSel=selAccs.includes(acc.id);
                  return (
                    <div key={acc.id} onClick={()=>toggleAccount(acc.id)} style={{background:T.card,border:`2px solid ${isSel?T.acl:T.border}`,borderRadius:16,padding:'14px',marginBottom:8,cursor:'pointer',position:'relative'}}>
                      {isSel&&<div style={{position:'absolute',top:10,right:10,width:18,height:18,borderRadius:'50%',background:T.acl,display:'flex',alignItems:'center',justifyContent:'center'}}><span style={{color:'#fff',fontSize:10,fontWeight:900}}>✓</span></div>}
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
                        <div style={{display:'flex',gap:8,alignItems:'center'}}>
                          <div style={{width:38,height:38,borderRadius:10,background:ex.color+'20',border:`1px solid ${ex.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18}}>{ex.icon}</div>
                          <div>
                            <div style={{display:'flex',gap:5,alignItems:'center'}}><span style={{color:T.txt,fontWeight:700,fontSize:13}}>{acc.nickname}</span><Bdg c={acc.status==='connected'?T.grn:acc.status==='pending'?T.ylw:T.red} ch={acc.status==='connected'?'연결됨':acc.status==='pending'?'연결중':'오류'} sm/>{acc.isPaper&&<Bdg c={T.prp} ch="모의" sm/>}</div>
                            <div style={{color:T.muted,fontSize:10,marginTop:1}}>{ex.name} · {acc.lastSync}</div>
                          </div>
                        </div>
                        <div style={{textAlign:'right'}}>
                          <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>{cvt(acc.balance,currency)}</div>
                          <div style={{color:acc.todayPnl>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{acc.todayPnl>=0?'+':''}{cvt(Math.abs(acc.todayPnl),currency)}</div>
                        </div>
                      </div>
                      {acc.status==='connected'&&(
                        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
                          {[{l:'가용',v:cvt(acc.available,currency)},{l:'포지션',v:acc.openPositions+'개'},{l:'거래권한',v:acc.permissions.trading?'✅':'❌'},{l:'출금권한',v:acc.permissions.withdrawal?'⚠️':'✅ 차단'}].map(r=>(
                            <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'6px 8px',textAlign:'center'}}>
                              <div style={{color:T.muted,fontSize:9}}>{r.l}</div>
                              <div style={{color:r.l==='출금권한'?(acc.permissions.withdrawal?T.red:T.grn):T.txt,fontSize:10,fontWeight:700,marginTop:1}}>{r.v}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {acc.autoTrading&&(
                        <div style={{marginTop:8,background:T.grn+'12',border:`1px solid ${T.grn}30`,borderRadius:8,padding:'5px 10px',display:'flex',alignItems:'center',gap:6}}>
                          <Dot c={T.grn}/><span style={{color:T.grn,fontSize:10,fontWeight:700}}>자동매매 실행 중</span>
                          <span style={{color:T.muted,fontSize:10}}>일일 최대 손실: {cvt(acc.maxDailyLoss,currency)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Bulk trade CTA */}
          {selAccs.length>0&&(
            <div style={{position:'sticky',bottom:80,background:T.surf,border:`1px solid ${T.acl}40`,borderRadius:16,padding:'12px 14px',boxShadow:'0 -4px 20px rgba(0,0,0,.4)',zIndex:20}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div><div style={{color:T.txt,fontWeight:700,fontSize:13}}>{selAccs.length}개 계좌 선택됨</div><div style={{color:T.muted,fontSize:10}}>일괄 매매를 실행할 수 있습니다</div></div>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={()=>setSelAccs([])} style={{background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'7px 12px',fontSize:11,cursor:'pointer'}}>취소</button>
                  <button onClick={()=>setTab('bulk')} style={{background:T.acc,color:'#fff',border:'none',borderRadius:8,padding:'7px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>📦 일괄 매매 →</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CONNECT TAB ── */}
      {tab==='connect'&&(
        <div>
          {/* Security warning */}
          <div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:12,padding:'12px 14px',marginBottom:14}}>
            <div style={{color:T.red,fontWeight:800,fontSize:13,marginBottom:6}}>🔐 API 연결 보안 수칙</div>
            {['출금 권한은 절대 켜지 마세요','거래 권한만 허용하세요','API 키는 본인 계정에만 사용됩니다','API Secret은 서버에만 저장됩니다 (프론트엔드 미노출)','언제든지 거래소에서 API 키를 삭제할 수 있습니다'].map((w,i)=>(
              <div key={i} style={{display:'flex',gap:6,padding:'3px 0'}}><span style={{color:T.red,fontSize:11,flexShrink:0}}>⚠️</span><span style={{color:T.sub,fontSize:11}}>{w}</span></div>
            ))}
          </div>

          {/* Exchange selector */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>거래소/브로커 선택</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {(Object.entries(EXCHANGE_INFO) as [ExchangeType,any][]).map(([key,ex])=>(
                <button key={key} onClick={()=>{setConnectExchange(key);setConnectStep(1);}} style={{background:connectExchange===key?ex.color+'20':T.alt,border:`2px solid ${connectExchange===key?ex.color:T.border}`,borderRadius:12,padding:'12px 6px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:22,marginBottom:4}}>{ex.icon}</div>
                  <div style={{color:connectExchange===key?ex.color:T.txt,fontWeight:700,fontSize:11}}>{ex.name}</div>
                </button>
              ))}
            </div>
          </Card>

          {connectStep>=1&&(
            <Card style={{padding:'14px 16px',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📋 API 키 발급 가이드</div>
              <div style={{display:'flex',marginBottom:14,gap:4}}>
                {[1,2,3,4].map(s=><div key={s} style={{flex:1,height:4,background:connectStep>=s?T.acl:T.border,borderRadius:2,transition:'background .3s'}}/>)}
              </div>
              {[
                {step:1,title:`${EXCHANGE_INFO[connectExchange].name} 로그인`,desc:'거래소 웹사이트에 로그인하세요.',action:'거래소 바로가기',url:EXCHANGE_INFO[connectExchange].url},
                {step:2,title:'API 관리 페이지 이동',desc:'계정 설정 → API 관리 (또는 API 키 생성) 메뉴로 이동하세요.'},
                {step:3,title:'API 키 생성 및 권한 설정',desc:'새 API 키를 생성하고 반드시 ✅ 읽기, ✅ 거래만 허용. 출금 권한은 절대 체크 해제하세요!'},
                {step:4,title:'API 키/Secret 복사',desc:'생성된 API Key와 Secret Key를 아래에 입력하세요. Secret은 한 번만 표시됩니다.'},
              ].map(g=>(
                <div key={g.step} style={{display:'flex',gap:10,padding:'10px 0',borderBottom:`1px solid ${T.border}`,opacity:connectStep===g.step?1:0.5}}>
                  <div style={{width:24,height:24,borderRadius:'50%',background:connectStep>=g.step?T.acl:T.border,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:11,color:'#fff',flexShrink:0}}>{g.step}</div>
                  <div style={{flex:1}}>
                    <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{g.title}</div>
                    <div style={{color:T.muted,fontSize:11,marginTop:2,lineHeight:1.5}}>{g.desc}</div>
                    {g.url&&g.step===connectStep&&<a href={g.url} target="_blank" rel="noopener noreferrer" style={{color:T.acl,fontSize:11,fontWeight:700,display:'inline-block',marginTop:4}}>→ {g.action}</a>}
                  </div>
                  {connectStep===g.step&&g.step<4&&<button onClick={()=>setConnectStep(s=>s+1)} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'5px 10px',fontSize:10,fontWeight:700,cursor:'pointer',flexShrink:0}}>다음</button>}
                </div>
              ))}
            </Card>
          )}

          {connectStep>=4&&(
            <Card style={{padding:'14px 16px',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔑 API 키 입력</div>
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>계좌 별칭</div>
                <input value={apiNick} onChange={e=>setApiNick(e.target.value)} placeholder="예: 바이낸스 메인" style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:12,outline:'none'}}/>
              </div>
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>API Key</div>
                <input value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="API Key 입력" style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:12,outline:'none',fontFamily:'monospace'}}/>
              </div>
              <div style={{marginBottom:14}}>
                <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>API Secret</div>
                <input type="password" value={apiSecret} onChange={e=>setApiSecret(e.target.value)} placeholder="API Secret 입력 (서버에만 저장됨)" style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:12,outline:'none',fontFamily:'monospace'}}/>
                <div style={{color:T.muted,fontSize:10,marginTop:4}}>🔒 API Secret은 암호화되어 서버에만 저장됩니다. 프론트엔드에 노출되지 않습니다.</div>
              </div>
              <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:8,padding:'10px 12px',marginBottom:14}}>
                <div style={{color:T.ylw,fontWeight:700,fontSize:11,marginBottom:3}}>⚠️ 출금 권한 확인</div>
                <div style={{color:T.sub,fontSize:10}}>API 키 생성 시 출금 권한이 비활성화되어 있는지 반드시 확인하세요. TRAIGO는 출금 기능을 사용하지 않습니다.</div>
              </div>
              <button onClick={()=>{setTab('accounts');setConnectStep(0);}} style={{width:'100%',padding:'12px',background:`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer'}}>
                🔗 연결 (모의 테스트)
              </button>
              <div style={{color:T.muted,fontSize:10,textAlign:'center',marginTop:6}}>현재는 모의 연결입니다. 실제 API 실행은 서버 검증 후 활성화됩니다.</div>
            </Card>
          )}
        </div>
      )}

      {/* ── BULK ORDER TAB ── */}
      {tab==='bulk'&&(
        <div>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'10px 14px',marginBottom:14}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>⚠️ 일괄 매매 모드 · 🎮 모의 — 실제 자금 이동 없음</div>
          </div>

          {/* Asset selection */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>1️⃣ 종목 선택</div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {['BTC','ETH','SOL','AAPL','NVDA','SPY'].map(id=>(
                <button key={id} onClick={()=>setBulkOrder(p=>({...p,assetId:id,nameKr:id}))} style={{background:bulkOrder.assetId===id?T.acg:'transparent',color:bulkOrder.assetId===id?T.acl:T.muted,border:`1px solid ${bulkOrder.assetId===id?T.acl:T.border}`,borderRadius:8,padding:'5px 12px',fontSize:12,fontWeight:700,cursor:'pointer'}}>{id}</button>
              ))}
            </div>
          </Card>

          {/* Account selection */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>2️⃣ 실행 계좌 선택</div>
            <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap'}}>
              <button onClick={()=>setBulkOrder(p=>({...p,selectedAccounts:accounts.filter(a=>a.status==='connected').map(a=>a.id)}))} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>전체 선택</button>
              {(['longterm','shortterm','auto'] as AccountGroup[]).map(grp=>(
                <button key={grp} onClick={()=>setBulkOrder(p=>({...p,selectedAccounts:accounts.filter(a=>a.group===grp&&a.status==='connected').map(a=>a.id)}))} style={{background:GROUP_INFO[grp].color+'20',color:GROUP_INFO[grp].color,border:`1px solid ${GROUP_INFO[grp].color}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{GROUP_INFO[grp].name}</button>
              ))}
            </div>
            {accounts.filter(a=>a.status==='connected').map(acc=>{
              const ex=EXCHANGE_INFO[acc.exchange];
              const isSel=(bulkOrder.selectedAccounts||[]).includes(acc.id);
              return (
                <div key={acc.id} onClick={()=>setBulkOrder(p=>({...p,selectedAccounts:isSel?p.selectedAccounts?.filter(x=>x!==acc.id)||[]:[...(p.selectedAccounts||[]),acc.id]}))} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 12px',background:isSel?T.acg:T.alt,border:`1px solid ${isSel?T.acl:T.border}`,borderRadius:10,marginBottom:6,cursor:'pointer'}}>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}><span style={{fontSize:16}}>{ex.icon}</span><div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{acc.nickname}</div><div style={{color:T.muted,fontSize:10}}>가용 {cvt(acc.available,currency)}</div></div></div>
                  {isSel&&<span style={{color:T.acl,fontSize:14,fontWeight:900}}>✓</span>}
                </div>
              );
            })}
          </Card>

          {/* Amount + allocation */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>3️⃣ 금액 및 배분 방식</div>
            <input type="number" value={bulkOrder.totalAmount||''} onChange={e=>setBulkOrder(p=>({...p,totalAmount:+e.target.value}))} placeholder="총 주문 금액 (₩)" style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:14,fontFamily:'monospace',fontWeight:700,outline:'none',marginBottom:10}}/>
            <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:6}}>배분 방식</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6,marginBottom:10}}>
              {[{id:'equal',l:'균등 배분',d:'모든 계좌에 동일 금액'},{id:'weighted',l:'잔고 비례',d:'가용 잔고 비율로 배분'},{id:'percent',l:'퍼센트',d:'계좌별 % 직접 설정'},{id:'custom',l:'직접 입력',d:'계좌별 금액 직접 입력'}].map(m=>(
                <button key={m.id} onClick={()=>setBulkOrder(p=>({...p,allocationMethod:m.id as any}))} style={{background:bulkOrder.allocationMethod===m.id?T.acg:T.alt,border:`1px solid ${bulkOrder.allocationMethod===m.id?T.acl:T.border}`,borderRadius:10,padding:'10px 8px',cursor:'pointer',textAlign:'left'}}>
                  <div style={{color:bulkOrder.allocationMethod===m.id?T.acl:T.txt,fontSize:11,fontWeight:700}}>{m.l}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:2}}>{m.d}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Preview */}
          {(bulkOrder.selectedAccounts||[]).length>0&&(bulkOrder.totalAmount||0)>0&&(
            <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.ylw}30`}}>
              <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>📋 주문 미리보기</div>
              {(()=>{
                const selAccObjs=accounts.filter(a=>(bulkOrder.selectedAccounts||[]).includes(a.id));
                const allocs=computeAllocations(selAccObjs,bulkOrder.allocationMethod||'equal',bulkOrder.totalAmount||0);
                return selAccObjs.map(acc=>{
                  const ex=EXCHANGE_INFO[acc.exchange];
                  const amt=allocs[acc.id]||0;
                  const fee=Math.round(amt*0.0005);
                  return (
                    <div key={acc.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:`1px solid ${T.border}`}}>
                      <div style={{display:'flex',gap:6,alignItems:'center'}}><span>{ex.icon}</span><span style={{color:T.txt,fontSize:12}}>{acc.nickname}</span></div>
                      <div style={{textAlign:'right'}}><div style={{color:T.txt,fontSize:12,fontWeight:700,fontFamily:'monospace'}}>{cvt(amt,currency)}</div><div style={{color:T.muted,fontSize:10}}>수수료 {cvt(fee,currency)}</div></div>
                    </div>
                  );
                });
              })()}
              <div style={{display:'flex',justifyContent:'space-between',padding:'10px 0 0',marginTop:4}}>
                <span style={{color:T.muted,fontSize:12}}>총 주문 금액</span>
                <span style={{color:T.txt,fontWeight:800,fontSize:14,fontFamily:'monospace'}}>{cvt(bulkOrder.totalAmount||0,currency)}</span>
              </div>
              <div style={{background:T.red+'12',border:`1px solid ${T.red}30`,borderRadius:8,padding:'8px 12px',marginTop:10}}>
                <div style={{color:T.red,fontSize:11,fontWeight:700}}>⚠️ 모의매매 전용 — 실제 자금이 이동하지 않습니다</div>
              </div>
              <button style={{width:'100%',padding:'13px',background:`linear-gradient(135deg,${T.grn},#059669)`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer',marginTop:12}}>
                📦 [{(bulkOrder.selectedAccounts||[]).length}개 계좌] 모의 매수 실행
              </button>
            </Card>
          )}
        </div>
      )}

      {/* ── SAFETY TAB ── */}
      {tab==='safety'&&(
        <div>
          {/* Global emergency stop */}
          <Card style={{padding:'16px',marginBottom:12,border:`1px solid ${T.red}30`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div><div style={{color:T.red,fontWeight:800,fontSize:13}}>🚨 전체 긴급 정지</div><div style={{color:T.muted,fontSize:11}}>모든 계좌 자동매매 즉시 중단</div></div>
              <button onClick={()=>setGlobalStop(true)} style={{background:globalStop?T.grn+'20':T.red+'20',color:globalStop?T.grn:T.red,border:`1px solid ${globalStop?T.grn:T.red}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>{globalStop?'✅ 정지됨':'🚨 전체 정지'}</button>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              {['자동매매만 정지','수동 매매 유지'].map((opt,i)=>(
                <button key={i} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px',fontSize:11,color:T.txt,cursor:'pointer'}}>{opt}</button>
              ))}
            </div>
          </Card>

          {/* Per-account safety */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🛡️ 계좌별 안전 설정</div>
            {accounts.filter(a=>a.status==='connected').map((acc,i,arr)=>{
              const ex=EXCHANGE_INFO[acc.exchange];
              return (
                <div key={acc.id} style={{padding:'12px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                    <div style={{display:'flex',gap:6,alignItems:'center'}}><span style={{fontSize:14}}>{ex.icon}</span><span style={{color:T.txt,fontSize:12,fontWeight:700}}>{acc.nickname}</span></div>
                    <Toggle on={acc.autoTrading} onChange={v=>setAccounts(p=>p.map(a=>a.id===acc.id?{...a,autoTrading:v}:a))}/>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                    {[{l:'일일 최대 손실',v:cvt(acc.maxDailyLoss,currency)},{l:'최대 포지션',v:cvt(acc.maxPositionSize,currency)}].map(r=>(
                      <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'8px 10px'}}>
                        <div style={{color:T.muted,fontSize:9}}>{r.l}</div>
                        <div style={{color:T.txt,fontSize:11,fontWeight:700,marginTop:1}}>{r.v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </Card>

          {/* API permissions review */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔑 API 권한 현황</div>
            {accounts.filter(a=>a.status==='connected').map((acc,i,arr)=>{
              const ex=EXCHANGE_INFO[acc.exchange];
              return (
                <div key={acc.id} style={{padding:'10px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700,marginBottom:6}}>{ex.icon} {acc.nickname}</div>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    <Bdg c={T.grn} ch="✅ 읽기 권한"/>
                    <Bdg c={acc.permissions.trading?T.grn:T.red} ch={acc.permissions.trading?'✅ 거래 권한':'❌ 거래 권한 없음'}/>
                    <Bdg c={acc.permissions.withdrawal?T.red:T.grn} ch={acc.permissions.withdrawal?'⚠️ 출금 권한 ON':'✅ 출금 차단됨'}/>
                  </div>
                  <div style={{display:'flex',gap:6,marginTop:6}}>
                    <div style={{color:T.muted,fontSize:9}}>API: {acc.apiKeyMasked||'(미연결)'}</div>
                  </div>
                </div>
              );
            })}
          </Card>
        </div>
      )}

      {/* Emergency stop modal */}
      {showEmergency&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.8)',zIndex:300}} onClick={()=>setShowEmergency(false)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:301,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px 40px',maxWidth:480,margin:'0 auto',border:`2px solid ${T.red}`}}>
            <div style={{color:T.red,fontWeight:900,fontSize:18,marginBottom:4}}>🚨 전체 긴급 정지</div>
            <div style={{color:T.sub,fontSize:12,marginBottom:16,lineHeight:1.6}}>모든 계좌의 자동매매를 즉시 중단합니다. 수동 매매는 계속 가능합니다. 이 작업은 취소할 수 있습니다.</div>
            <div style={{display:'flex',gap:10}}>
              <button onClick={()=>setShowEmergency(false)} style={{flex:1,padding:'13px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>{setGlobalStop(true);setAccounts(p=>p.map(a=>({...a,autoTrading:false})));setShowEmergency(false);}} style={{flex:2,padding:'13px',background:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:900,fontSize:14,cursor:'pointer'}}>🚨 전체 정지 실행</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ── FundingPage (입출금 + 환전 + 오픈뱅킹) ── */
type FundingTab = 'hub'|'openbanking'|'fx'|'guide';
interface LinkedBank { id:string; bankName:string; accountNum:string; holder:string; balance:number; isMain:boolean; }
interface ExchangeFunding { exchange:string; icon:string; color:string; depositTime:string; withdrawTime:string; depositFee:string; withdrawFee:string; minDeposit:string; }

const EXCHANGE_FUNDING:ExchangeFunding[] = [
  {exchange:'Binance',icon:'🟡',color:'#F0B90B',depositTime:'즉시~10분',withdrawTime:'10~60분',depositFee:'무료',withdrawFee:'네트워크 수수료',minDeposit:'없음'},
  {exchange:'Upbit',icon:'🔵',color:'#2563EB',depositTime:'즉시',withdrawTime:'즉시~10분',depositFee:'무료',withdrawFee:'무료',minDeposit:'없음'},
  {exchange:'Bithumb',icon:'🟢',color:'#10B981',depositTime:'즉시',withdrawTime:'즉시~10분',depositFee:'무료',withdrawFee:'무료',minDeposit:'없음'},
  {exchange:'Gate.io',icon:'🔵',color:'#3B82F6',depositTime:'즉시~30분',withdrawTime:'30~120분',depositFee:'무료',withdrawFee:'네트워크 수수료',minDeposit:'없음'},
];

const FX_PAIRS = [
  {from:'KRW',to:'USD',rate:0.000727,fee:0.3,flag1:'🇰🇷',flag2:'🇺🇸'},
  {from:'KRW',to:'JPY',rate:0.112,fee:0.3,flag1:'🇰🇷',flag2:'🇯🇵'},
  {from:'KRW',to:'EUR',rate:0.000667,fee:0.35,flag1:'🇰🇷',flag2:'🇪🇺'},
  {from:'USD',to:'KRW',rate:1375.4,fee:0.3,flag1:'🇺🇸',flag2:'🇰🇷'},
  {from:'USD',to:'JPY',rate:154.2,fee:0.25,flag1:'🇺🇸',flag2:'🇯🇵'},
  {from:'EUR',to:'USD',rate:1.089,fee:0.3,flag1:'🇪🇺',flag2:'🇺🇸'},
];

function FundingPage({currency}:{currency:string}) {
  const [tab,setTab]=useState<FundingTab>('hub');
  const [fromAcc,setFromAcc]=useState('bank1');
  const [toAcc,setToAcc]=useState('binance');
  const [amount,setAmount]=useState('');
  const [fxPair,setFxPair]=useState(FX_PAIRS[0]);
  const [fxAmount,setFxAmount]=useState('');
  const [obTab,setObTab]=useState<'accounts'|'deposit'|'withdraw'>('accounts');
  const [linkedBanks]=useState<LinkedBank[]>([
    {id:'bank1',bankName:'카카오뱅크',accountNum:'3333-****-1234',holder:'홍길동',balance:5240000,isMain:true},
    {id:'bank2',bankName:'신한은행',accountNum:'110-****-5678',holder:'홍길동',balance:1830000,isMain:false},
  ]);
  const [showConfirm,setShowConfirm]=useState(false);

  const SOURCES=[
    {id:'bank1',label:'카카오뱅크 ****1234',icon:'🏦',balance:5240000},
    {id:'bank2',label:'신한은행 ****5678',icon:'🏦',balance:1830000},
  ];
  const DESTS=[
    {id:'binance',label:'Binance',icon:'🟡'},
    {id:'upbit',label:'Upbit',icon:'🔵'},
    {id:'bithumb',label:'Bithumb',icon:'🟢'},
    {id:'gateio',label:'Gate.io',icon:'🔵'},
    {id:'kr_broker',label:'국내 증권사',icon:'🇰🇷'},
  ];

  const fxConverted = fxAmount ? (+fxAmount * fxPair.rate).toFixed(fxPair.to==='KRW'?0:4) : '';
  const fxFee = fxAmount ? (+fxAmount * fxPair.fee / 100).toFixed(2) : '';

  return (
    <div>
      <div style={{display:'flex',gap:5,marginBottom:14,overflowX:'auto'}}>
        {([['hub','💸 입출금'],['openbanking','🏦 오픈뱅킹'],['fx','💱 환전'],['guide','📖 가이드']] as const).map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'8px 12px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{label}</button>
        ))}
      </div>

      {/* ── HUB TAB ── */}
      {tab==='hub'&&(
        <div>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:12,padding:'10px 14px',marginBottom:14}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>⚠️ 안내</div>
            <div style={{color:T.sub,fontSize:10,marginTop:2,lineHeight:1.6}}>실제 계좌이체는 오픈뱅킹 계약/승인 후 가능합니다. 현재는 모의/가이드 기능입니다. TRAIGO는 사용자 자금을 직접 보관하지 않습니다.</div>
          </div>

          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>💸 자금 이동</div>
            <div style={{marginBottom:10}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>출금 계좌</div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {SOURCES.map(s=><button key={s.id} onClick={()=>setFromAcc(s.id)} style={{flex:1,minWidth:120,background:fromAcc===s.id?T.acg:T.alt,color:fromAcc===s.id?T.acl:T.txt,border:`1px solid ${fromAcc===s.id?T.acl:T.border}`,borderRadius:10,padding:'8px 10px',cursor:'pointer',textAlign:'left'}}>
                  <div style={{fontSize:11,fontWeight:600}}>{s.icon} {s.label}</div>
                  <div style={{color:fromAcc===s.id?T.acl:T.muted,fontSize:10,marginTop:2}}>{cvt(s.balance,currency)}</div>
                </button>)}
              </div>
            </div>
            <div style={{textAlign:'center',fontSize:18,color:T.muted,margin:'6px 0'}}>↕</div>
            <div style={{marginBottom:12}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>입금 대상</div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {DESTS.map(d=><button key={d.id} onClick={()=>setToAcc(d.id)} style={{background:toAcc===d.id?T.acg:T.alt,color:toAcc===d.id?T.acl:T.txt,border:`1px solid ${toAcc===d.id?T.acl:T.border}`,borderRadius:8,padding:'7px 10px',fontSize:11,fontWeight:600,cursor:'pointer'}}>{d.icon} {d.label}</button>)}
              </div>
            </div>
            <input type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="금액 입력 (₩)" style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:14,fontFamily:'monospace',fontWeight:700,outline:'none',marginBottom:10}}/>
            <div style={{display:'flex',gap:5,marginBottom:12}}>
              {['10만','50만','100만','전액'].map(v=><button key={v} onClick={()=>setAmount(v==='전액'?'5240000':v==='10만'?'100000':v==='50만'?'500000':'1000000')} style={{flex:1,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:6,padding:'5px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}</button>)}
            </div>
            {amount&&(
              <div style={{background:T.alt,borderRadius:8,padding:'10px 12px',marginBottom:12,border:`1px solid ${T.border}`}}>
                {[{l:'이체 금액',v:'₩'+fmt(+amount)},{l:'이체 수수료',v:'무료 (모의)'},{l:'처리 시간',v:'즉시~10분 (예상)'},{l:'최종 입금액',v:'₩'+fmt(+amount)}].map((r,i)=>(
                  <div key={i} style={{display:'flex',justifyContent:'space-between',marginBottom:i<3?4:0}}>
                    <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
                    <span style={{color:T.txt,fontSize:11,fontWeight:700}}>{r.v}</span>
                  </div>
                ))}
              </div>
            )}
            <button onClick={()=>amount&&setShowConfirm(true)} style={{width:'100%',padding:'12px',background:amount?`linear-gradient(135deg,${T.acc},${T.prp})`:'#243A5E',color:'#fff',border:'none',borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer'}}>
              💸 이체 확인 (모의)
            </button>
          </Card>

          {/* Transaction history placeholder */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📋 이체 내역 (모의)</div>
            {[{t:'입금',from:'카카오뱅크',to:'Binance',amt:'₩1,000,000',stat:'완료',time:'2025-05-10'},{t:'입금',from:'신한은행',to:'Upbit',amt:'₩500,000',stat:'완료',time:'2025-05-08'}].map((h,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<1?`1px solid ${T.border}`:'none'}}>
                <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{h.from} → {h.to}</div><div style={{color:T.muted,fontSize:10}}>{h.time}</div></div>
                <div style={{textAlign:'right'}}><div style={{color:T.grn,fontSize:12,fontWeight:700}}>{h.amt}</div><Bdg c={T.grn} ch={h.stat} sm/></div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* ── OPEN BANKING TAB ── */}
      {tab==='openbanking'&&(
        <div>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:12,padding:'12px 14px',marginBottom:14}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11,marginBottom:4}}>⚠️ 오픈뱅킹 안내</div>
            <div style={{color:T.sub,fontSize:10,lineHeight:1.6}}>실제 오픈뱅킹 서비스는 금융당국 등록 및 API 계약 후 이용 가능합니다. 현재는 UI 플레이스홀더입니다.</div>
          </div>
          <div style={{display:'flex',gap:6,marginBottom:12}}>
            {(['accounts','deposit','withdraw'] as const).map(t=><button key={t} onClick={()=>setObTab(t)} style={{flex:1,padding:'8px',background:obTab===t?T.acg:'transparent',color:obTab===t?T.acl:T.muted,border:`1px solid ${obTab===t?T.acl:T.border}`,borderRadius:8,fontSize:11,fontWeight:700,cursor:'pointer'}}>{t==='accounts'?'계좌 목록':t==='deposit'?'입금':t==='withdraw'?'출금':t}</button>)}
          </div>
          {obTab==='accounts'&&(
            <div>
              <Card style={{padding:'14px 16px',marginBottom:12}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                  <div style={{color:T.txt,fontWeight:700}}>🏦 연결된 은행 계좌</div>
                  <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 계좌 추가</button>
                </div>
                {linkedBanks.map((b,i)=>(
                  <div key={b.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<linkedBanks.length-1?`1px solid ${T.border}`:'none'}}>
                    <div style={{display:'flex',gap:8,alignItems:'center'}}>
                      <div style={{width:36,height:36,borderRadius:10,background:T.acg,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18}}>🏦</div>
                      <div><div style={{color:T.txt,fontSize:13,fontWeight:700}}>{b.bankName}</div><div style={{color:T.muted,fontSize:10}}>{b.accountNum} · {b.holder}</div></div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{color:T.txt,fontSize:13,fontWeight:700,fontFamily:'monospace'}}>{cvt(b.balance,currency)}</div>
                      {b.isMain&&<Bdg c={T.grn} ch="주계좌" sm/>}
                    </div>
                  </div>
                ))}
              </Card>
              <Card style={{padding:'14px 16px',border:`1px solid ${T.cyn}30`}}>
                <div style={{color:T.cyn,fontWeight:700,fontSize:12,marginBottom:8}}>💡 오픈뱅킹 등록 절차</div>
                {['금융결제원 오픈뱅킹 이용 동의','계좌 인증 (1원 인증)','출금 동의 (선택)','파이낸테크 이용번호 발급'].map((s,i)=>(
                  <div key={i} style={{display:'flex',gap:6,padding:'4px 0'}}><span style={{color:T.cyn,fontSize:11}}>{i+1}.</span><span style={{color:T.sub,fontSize:11}}>{s}</span></div>
                ))}
              </Card>
            </div>
          )}
          {obTab==='deposit'&&(
            <Card style={{padding:'14px 16px'}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📥 가상계좌 입금</div>
              <div style={{background:T.alt,borderRadius:10,padding:'14px',marginBottom:12,border:`1px solid ${T.border}`}}>
                <div style={{color:T.muted,fontSize:10,marginBottom:4}}>Binance 가상계좌 (모의)</div>
                <div style={{color:T.txt,fontWeight:900,fontSize:16,fontFamily:'monospace'}}>신한은행 110-123-456789</div>
                <div style={{color:T.muted,fontSize:10,marginTop:4}}>예금주: BINANCE KOREA (주) · 유효기간: 24시간</div>
              </div>
              <div style={{color:T.muted,fontSize:11,lineHeight:1.7}}><div style={{fontWeight:700,color:T.txt,marginBottom:4}}>입금 방법</div>1. 위 가상계좌로 이체<br/>2. 자동으로 잔고 반영 (즉시~10분)<br/>3. 원화 그대로 보관 후 거래 가능</div>
            </Card>
          )}
          {obTab==='withdraw'&&(
            <Card style={{padding:'14px 16px'}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📤 출금 신청 (모의)</div>
              <div style={{background:T.red+'12',border:`1px solid ${T.red}30`,borderRadius:8,padding:'10px 12px',marginBottom:12}}>
                <div style={{color:T.red,fontWeight:700,fontSize:11}}>⚠️ 출금 보안 안내</div>
                <div style={{color:T.sub,fontSize:10,marginTop:2}}>실제 출금은 본인 인증 및 24시간 지연 정책이 적용됩니다.</div>
              </div>
              <div style={{color:T.muted,fontSize:12,textAlign:'center',padding:'20px 0'}}>출금 기능은 오픈뱅킹 연동 후 활성화됩니다.</div>
            </Card>
          )}
        </div>
      )}

      {/* ── FX TAB ── */}
      {tab==='fx'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>💱 환전 계산기</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:5,marginBottom:12}}>
              {FX_PAIRS.map((p,i)=>(
                <button key={i} onClick={()=>setFxPair(p)} style={{background:fxPair===p?T.acg:T.alt,border:`1px solid ${fxPair===p?T.acl:T.border}`,borderRadius:8,padding:'8px 4px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:11,color:fxPair===p?T.acl:T.txt}}>{p.flag1}{p.flag2}</div>
                  <div style={{fontSize:10,color:fxPair===p?T.acl:T.muted,fontWeight:700}}>{p.from}/{p.to}</div>
                </button>
              ))}
            </div>
            <div style={{background:T.alt,borderRadius:10,padding:'12px 14px',marginBottom:10,border:`1px solid ${T.border}`}}>
              <div style={{color:T.muted,fontSize:10,marginBottom:4}}>현재 환율</div>
              <div style={{color:T.txt,fontSize:18,fontWeight:900,fontFamily:'monospace'}}>1 {fxPair.from} = {fxPair.rate.toFixed(4)} {fxPair.to}</div>
              <div style={{color:T.muted,fontSize:10,marginTop:2}}>수수료 {fxPair.fee}% · 실시간 (모의)</div>
            </div>
            <div style={{marginBottom:10}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>환전 금액 ({fxPair.from})</div>
              <input type="number" value={fxAmount} onChange={e=>setFxAmount(e.target.value)} placeholder={`금액 입력 (${fxPair.from})`} style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:14,fontFamily:'monospace',fontWeight:700,outline:'none'}}/>
            </div>
            {fxAmount&&(
              <div style={{background:T.acg,border:`1px solid ${T.acl}30`,borderRadius:10,padding:'12px 14px',marginBottom:12}}>
                <div style={{color:T.muted,fontSize:10,marginBottom:4}}>환전 후 ({fxPair.to})</div>
                <div style={{color:T.acl,fontSize:22,fontWeight:900,fontFamily:'monospace'}}>{Number(fxConverted).toLocaleString()} {fxPair.to}</div>
                <div style={{color:T.muted,fontSize:10,marginTop:4}}>수수료: {fxFee} {fxPair.from} ({fxPair.fee}%)</div>
              </div>
            )}
            <button style={{width:'100%',padding:'12px',background:fxAmount?`linear-gradient(135deg,${T.acc},${T.prp})`:'#243A5E',color:'#fff',border:'none',borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer'}}>
              💱 환전 실행 (모의 — 실제 환전 미실행)
            </button>
          </Card>

          {/* PG Placeholders */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>💳 간편결제 (준비중)</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {[{name:'토스페이',icon:'💙',color:'#0070F3'},{name:'네이버페이',icon:'🟢',color:'#03C75A'},{name:'카카오페이',icon:'🟡',color:'#FFCD00'}].map(p=>(
                <div key={p.name} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:12,padding:'14px 8px',textAlign:'center'}}>
                  <div style={{fontSize:24,marginBottom:4}}>{p.icon}</div>
                  <div style={{color:T.txt,fontSize:11,fontWeight:700}}>{p.name}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:3}}>준비중</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── GUIDE TAB ── */}
      {tab==='guide'&&(
        <div>
          {EXCHANGE_FUNDING.map((ex,idx)=>(
            <Card key={idx} style={{padding:'14px 16px',marginBottom:10}}>
              <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:10}}>
                <span style={{fontSize:20}}>{ex.icon}</span>
                <div style={{color:T.txt,fontWeight:700,fontSize:14}}>{ex.exchange} 입금 가이드</div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
                {[{l:'입금 처리시간',v:ex.depositTime},{l:'출금 처리시간',v:ex.withdrawTime},{l:'입금 수수료',v:ex.depositFee},{l:'출금 수수료',v:ex.withdrawFee}].map(r=>(
                  <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'8px 10px'}}>
                    <div style={{color:T.muted,fontSize:9}}>{r.l}</div>
                    <div style={{color:T.txt,fontSize:11,fontWeight:700,marginTop:2}}>{r.v}</div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.ylw}30`}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:12,marginBottom:8}}>⚠️ 책임 안내</div>
            {['TRAIGO는 사용자 자금을 직접 보관하지 않습니다','사용자가 직접 거래소/증권사 계정에 입출금합니다','API 키를 통한 거래는 사용자 본인의 책임입니다','플랫폼 운영자는 API 파트너 계약을 통해 기능을 제공합니다','API Secret은 절대 프론트엔드에 노출되지 않습니다'].map((t,i)=>(
              <div key={i} style={{display:'flex',gap:6,padding:'4px 0'}}><span style={{color:T.ylw,flexShrink:0}}>•</span><span style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{t}</span></div>
            ))}
          </Card>
        </div>
      )}

      {/* Confirm modal */}
      {showConfirm&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200}} onClick={()=>setShowConfirm(false)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px 40px',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:T.txt,fontWeight:800,fontSize:16,marginBottom:14}}>💸 이체 확인 (모의)</div>
            <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'10px 12px',marginBottom:14}}>
              <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>⚠️ 현재는 모의 이체입니다</div>
              <div style={{color:T.sub,fontSize:10,marginTop:2}}>실제 자금이 이동하지 않습니다. 오픈뱅킹 연동 후 실제 이체가 가능합니다.</div>
            </div>
            {[{l:'출금 계좌',v:'카카오뱅크 ****1234'},{l:'입금 대상',v:DESTS.find(d=>d.id===toAcc)?.label||toAcc},{l:'이체 금액',v:'₩'+fmt(+amount)},{l:'수수료',v:'무료 (모의)'},{l:'예상 처리',v:'즉시'}].map((r,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}><span style={{color:T.muted,fontSize:13}}>{r.l}</span><span style={{color:T.txt,fontWeight:700,fontSize:13}}>{r.v}</span></div>
            ))}
            <div style={{display:'flex',gap:10,marginTop:16}}>
              <button onClick={()=>setShowConfirm(false)} style={{flex:1,padding:'13px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>setShowConfirm(false)} style={{flex:2,padding:'13px',background:`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer'}}>✅ 모의 이체 확인</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}


/* ── TradFi Page (코인거래소 TradFi + 글로벌 자산 CFD) ── */
type ProductType = 'spot'|'futures'|'cfd'|'tokenized'|'index'|'commodity'|'forex'|'watchonly';
type TradFiProvider = 'gate'|'bybit'|'binance'|'bitget'|'etoro'|'watchonly';

interface TradFiAsset {
  id:string; nameKr:string; name:string; sym:string;
  category:'stock_cfd'|'index'|'commodity'|'forex';
  productType:ProductType; providers:TradFiProvider[];
  p:number; c:number; clr:string; overnight:string;
  maxLev:number; isWatchOnly:boolean;
}

const PRODUCT_LABEL:Record<ProductType,string> = {
  spot:'현물', futures:'선물', cfd:'CFD', tokenized:'토큰화주식',
  index:'지수', commodity:'원자재', forex:'환율', watchonly:'조회전용',
};
const PRODUCT_COLOR:Record<ProductType,string> = {
  spot:'#10B981', futures:'#F59E0B', cfd:'#7C3AED', tokenized:'#3B82F6',
  index:'#8B5CF6', commodity:'#D97706', forex:'#0891B2', watchonly:'#475569',
};

const TRADFI_PROVIDERS:Record<TradFiProvider,{name:string;icon:string;color:string;url:string}> = {
  gate:     {name:'Gate TradFi',icon:'🔵',color:'#3B82F6',url:'https://www.gate.io/'},
  bybit:    {name:'Bybit MT5',icon:'🟡',color:'#F0B90B',url:'https://www.bybit.com/'},
  binance:  {name:'Binance Futures',icon:'🟡',color:'#F0B90B',url:'https://www.binance.com/'},
  bitget:   {name:'Bitget TradFi',icon:'🔵',color:'#00D4FF',url:'https://www.bitget.com/'},
  etoro:    {name:'eToro-style',icon:'🟢',color:'#10B981',url:'#'},
  watchonly:{name:'조회만',icon:'👁',color:'#475569',url:'#'},
};

const TRADFI_ASSETS:TradFiAsset[] = [
  // ── 주식 CFD ──
  {id:'AAPL_CFD',nameKr:'애플 CFD',name:'Apple CFD',sym:'AAPL',category:'stock_cfd',productType:'cfd',providers:['gate','bybit','bitget'],p:287.51,c:1.17,clr:'#555555',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'TSLA_CFD',nameKr:'테슬라 CFD',name:'Tesla CFD',sym:'TSLA',category:'stock_cfd',productType:'cfd',providers:['gate','bybit','bitget'],p:398.73,c:2.40,clr:'#CC0000',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'NVDA_CFD',nameKr:'엔비디아 CFD',name:'NVIDIA CFD',sym:'NVDA',category:'stock_cfd',productType:'cfd',providers:['gate','bybit','bitget'],p:207.83,c:5.77,clr:'#76B900',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'MSFT_CFD',nameKr:'마이크로소프트 CFD',name:'Microsoft CFD',sym:'MSFT',category:'stock_cfd',productType:'cfd',providers:['gate','bybit'],p:413.96,c:0.63,clr:'#00A4EF',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'AMZN_CFD',nameKr:'아마존 CFD',name:'Amazon CFD',sym:'AMZN',category:'stock_cfd',productType:'cfd',providers:['gate','bybit','bitget'],p:274.99,c:0.53,clr:'#FF9900',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'GOOGL_CFD',nameKr:'구글 CFD',name:'Google CFD',sym:'GOOGL',category:'stock_cfd',productType:'cfd',providers:['gate','bybit'],p:395.14,c:2.33,clr:'#4285F4',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'META_CFD',nameKr:'메타 CFD',name:'Meta CFD',sym:'META',category:'stock_cfd',productType:'cfd',providers:['gate','bitget'],p:528.60,c:1.43,clr:'#0866FF',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  // ── 지수 CFD ──
  {id:'NAS100',nameKr:'나스닥100',name:'NAS100',sym:'NAS100',category:'index',productType:'index',providers:['gate','bybit','binance','bitget'],p:21340,c:0.87,clr:'#3B82F6',overnight:'-0.01%',maxLev:20,isWatchOnly:false},
  {id:'SPX500',nameKr:'S&P500',name:'SPX500',sym:'SPX500',category:'index',productType:'index',providers:['gate','bybit','binance','bitget'],p:5820,c:0.47,clr:'#6366F1',overnight:'-0.01%',maxLev:20,isWatchOnly:false},
  {id:'US30',nameKr:'다우존스',name:'US30 Dow Jones',sym:'US30',category:'index',productType:'index',providers:['gate','bybit','bitget'],p:42840,c:0.31,clr:'#8B5CF6',overnight:'-0.01%',maxLev:20,isWatchOnly:false},
  // ── 원자재 CFD ──
  {id:'XAUUSD',nameKr:'금 XAUUSD',name:'Gold XAUUSD',sym:'XAUUSD',category:'commodity',productType:'cfd',providers:['gate','bybit','binance','bitget'],p:3420,c:0.56,clr:'#D97706',overnight:'-0.01%',maxLev:20,isWatchOnly:false},
  {id:'XAGUSD',nameKr:'은 XAGUSD',name:'Silver XAGUSD',sym:'XAGUSD',category:'commodity',productType:'cfd',providers:['gate','bybit','bitget'],p:38.50,c:-1.58,clr:'#94A3B8',overnight:'-0.01%',maxLev:20,isWatchOnly:false},
  {id:'XTIUSD',nameKr:'WTI 원유',name:'WTI XTIUSD',sym:'XTIUSD',category:'commodity',productType:'cfd',providers:['gate','bybit','binance','bitget'],p:78.40,c:-0.90,clr:'#78350F',overnight:'-0.02%',maxLev:20,isWatchOnly:false},
  {id:'XBRUSD',nameKr:'브렌트유',name:'Brent XBRUSD',sym:'XBRUSD',category:'commodity',productType:'cfd',providers:['gate','bybit','bitget'],p:82.40,c:-0.72,clr:'#92400E',overnight:'-0.02%',maxLev:20,isWatchOnly:false},
  // ── 환율 CFD ──
  {id:'EURUSD',nameKr:'유로/달러',name:'EUR/USD',sym:'EURUSD',category:'forex',productType:'forex',providers:['gate','bybit','binance','bitget'],p:1.0892,c:0.18,clr:'#3B82F6',overnight:'-0.005%',maxLev:50,isWatchOnly:false},
  {id:'GBPUSD',nameKr:'파운드/달러',name:'GBP/USD',sym:'GBPUSD',category:'forex',productType:'forex',providers:['gate','bybit','bitget'],p:1.2734,c:-0.12,clr:'#7C3AED',overnight:'-0.005%',maxLev:50,isWatchOnly:false},
  {id:'USDJPY',nameKr:'달러/엔',name:'USD/JPY',sym:'USDJPY',category:'forex',productType:'forex',providers:['gate','bybit','binance','bitget'],p:154.2,c:0.33,clr:'#DC2626',overnight:'-0.005%',maxLev:50,isWatchOnly:false},
  {id:'USDKRW',nameKr:'달러/원',name:'USD/KRW',sym:'USDKRW',category:'forex',productType:'watchonly',providers:['watchonly'],p:1378,c:-0.22,clr:'#10B981',overnight:'N/A',maxLev:1,isWatchOnly:true},
];

function TradFiPage({prices,currency}:{prices:Asset[];currency:string}) {
  const [cat,setCat]=useState<string>('all');
  const [sel,setSel]=useState<TradFiAsset|null>(null);
  const [side,setSide]=useState<'long'|'short'>('long');
  const [amount,setAmount]=useState('');
  const [lev,setLev]=useState(1);
  const [provider,setProvider]=useState<TradFiProvider>('gate');
  const [mode,setMode]=useState<'list'|'trade'>('list');
  const [tab,setTab]=useState<'cfd'|'connect'|'risk'>('cfd');

  const cats=[{id:'all',l:'전체',c:T.txt},{id:'stock_cfd',l:'주식 CFD',c:'#7C3AED'},{id:'index',l:'지수',c:'#3B82F6'},{id:'commodity',l:'원자재',c:'#D97706'},{id:'forex',l:'환율',c:'#0891B2'}];
  const filtered=cat==='all'?TRADFI_ASSETS:TRADFI_ASSETS.filter(a=>a.category===cat);

  const liqPct=(100/lev)*0.9;
  const liqPrice=sel?sel.p*(1+(side==='long'?-liqPct:liqPct)/100):0;
  const fee=Math.round((+amount||0)*0.0005);
  const swapFee=sel?+(+amount*(parseFloat(sel.overnight)/100)).toFixed(0):0;

  const openTrade=(a:TradFiAsset)=>{setSel(a);setProvider(a.providers[0]);setLev(1);setAmount('');setMode('trade');};

  return (
    <div>
      {/* TradFi warning */}
      <div style={{background:'rgba(124,58,237,.12)',border:'1px solid rgba(124,58,237,.4)',borderRadius:12,padding:'10px 14px',marginBottom:14}}>
        <div style={{color:'#7C3AED',fontWeight:800,fontSize:12,marginBottom:4}}>⚠️ TradFi / CFD 상품 안내</div>
        <div style={{color:T.sub,fontSize:10,lineHeight:1.7}}>이 상품은 실제 주식 보유가 아니라 CFD/파생상품일 수 있으며, 레버리지·스왑비·청산 위험이 있습니다. 거래소, 지역, 계정 조건에 따라 이용 불가할 수 있습니다. <strong style={{color:'#7C3AED'}}>모의매매 전용</strong></div>
      </div>

      {/* Sub tabs */}
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {([['cfd','📊 TradFi 자산'],['connect','🔗 거래소 연동'],['risk','⚠️ 위험 안내']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:'8px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* CFD Asset List */}
      {tab==='cfd'&&mode==='list'&&(
        <div>
          <div style={{marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:4}}>USDT로 주식·지수·원자재·환율 거래</div>
            <div style={{color:T.muted,fontSize:11}}>코인거래소에서 제공하는 TradFi/CFD 상품</div>
          </div>
          {/* Category filter */}
          <div style={{display:'flex',gap:6,overflowX:'auto',paddingBottom:8,marginBottom:12}}>
            {cats.map(c=>(
              <button key={c.id} onClick={()=>setCat(c.id)} style={{flexShrink:0,padding:'5px 12px',background:cat===c.id?c.c+'20':'transparent',color:cat===c.id?c.c:T.muted,border:`1px solid ${cat===c.id?c.c:T.border}`,borderRadius:20,fontSize:12,fontWeight:700,cursor:'pointer'}}>{c.l}</button>
            ))}
          </div>
          {/* Asset list */}
          <Card style={{overflow:'hidden'}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr auto 80px',padding:'8px 14px',borderBottom:`1px solid ${T.border}`,color:T.muted,fontSize:10,fontWeight:700,textTransform:'uppercase'}}>
              <span>종목</span><span>제공사</span><span style={{textAlign:'right'}}>가격/등락</span>
            </div>
            {filtered.map((a,i)=>(
              <div key={a.id} onClick={()=>openTrade(a)} style={{display:'grid',gridTemplateColumns:'1fr auto 80px',padding:'12px 14px',borderBottom:i<filtered.length-1?`1px solid ${T.border}`:'none',alignItems:'center',cursor:a.isWatchOnly?'default':'pointer'}}>
                {/* Name + type */}
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:3}}>
                    <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{a.sym}</span>
                    <Bdg c={PRODUCT_COLOR[a.productType]} ch={PRODUCT_LABEL[a.productType]} sm/>
                    {a.isWatchOnly&&<Bdg c={T.muted} ch="조회만" sm/>}
                  </div>
                  <div style={{color:T.muted,fontSize:10}}>{a.nameKr} · 오버나이트 {a.overnight}</div>
                </div>
                {/* Providers */}
                <div style={{display:'flex',gap:3,marginRight:8}}>
                  {a.providers.slice(0,3).map(p=>(
                    <span key={p} title={TRADFI_PROVIDERS[p].name} style={{fontSize:14}}>{TRADFI_PROVIDERS[p].icon}</span>
                  ))}
                </div>
                {/* Price */}
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.txt,fontWeight:700,fontSize:11,fontFamily:'monospace'}}>{a.p.toLocaleString()}</div>
                  <div style={{color:a.c>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{a.c>=0?'+':''}{a.c.toFixed(2)}%</div>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* Trade panel */}
      {tab==='cfd'&&mode==='trade'&&sel&&(
        <div>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
            <button onClick={()=>setMode('list')} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,padding:'5px 10px',color:T.muted,fontSize:12,cursor:'pointer'}}>← 목록</button>
            <div style={{color:T.txt,fontWeight:800,fontSize:15}}>{sel.nameKr}</div>
            <Bdg c={PRODUCT_COLOR[sel.productType]} ch={PRODUCT_LABEL[sel.productType]}/>
          </div>

          {/* CFD Warning */}
          <div style={{background:T.prp+'15',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'10px 14px',marginBottom:12}}>
            <div style={{color:T.prp,fontWeight:700,fontSize:11}}>⚠️ 이 상품은 CFD입니다. 실제 자산 보유 아님 · 레버리지·스왑비·청산 위험 있음 · 모의매매 전용</div>
          </div>

          {/* Provider selection */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>거래소 선택</div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {sel.providers.map(p=>{
                const pInfo=TRADFI_PROVIDERS[p];
                return (
                  <button key={p} onClick={()=>setProvider(p)} style={{background:provider===p?pInfo.color+'20':T.alt,color:provider===p?pInfo.color:T.muted,border:`2px solid ${provider===p?pInfo.color:T.border}`,borderRadius:10,padding:'8px 12px',cursor:'pointer',display:'flex',alignItems:'center',gap:5}}>
                    <span>{pInfo.icon}</span><span style={{fontSize:11,fontWeight:700}}>{pInfo.name}</span>
                  </button>
                );
              })}
            </div>
            <div style={{marginTop:8,display:'flex',gap:6}}>
              <Bdg c={T.grn} ch="지원됨"/>
              <Bdg c={T.muted} ch="계좌 연결 필요"/>
              <Bdg c={T.ylw} ch="지역 제한 가능"/>
            </div>
          </Card>

          {/* Price */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.muted,fontSize:11}}>{sel.name} · {TRADFI_PROVIDERS[provider].name}</div>
            <div style={{color:T.txt,fontSize:24,fontWeight:900,fontFamily:'monospace',marginTop:4}}>{sel.p.toLocaleString()} {sel.category==='forex'?'':currency==='USD'?'USD':'USDT'}</div>
            <div style={{color:sel.c>=0?T.grn:T.red,fontWeight:800,fontSize:13,marginTop:2}}>{sel.c>=0?'▲':'▼'} {Math.abs(sel.c).toFixed(2)}%</div>
          </Card>

          {/* Order form */}
          <Card style={{padding:14,marginBottom:12}}>
            {/* Long/Short */}
            <div style={{display:'flex',gap:8,marginBottom:12}}>
              {(['long','short'] as const).map(s=>(
                <button key={s} onClick={()=>setSide(s)} style={{flex:1,padding:'11px',background:side===s?(s==='long'?T.grn:T.red):'transparent',color:side===s?'#fff':T.muted,border:`1px solid ${side===s?(s==='long'?T.grn:T.red):T.border}`,borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>
                  {s==='long'?'📈 롱 (상승)':'📉 숏 (하락)'}
                </button>
              ))}
            </div>

            {/* Amount */}
            <input type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="USDT 금액 입력" style={{width:'100%',background:T.alt,border:`1px solid ${T.border2}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:16,fontFamily:'monospace',fontWeight:700,outline:'none',marginBottom:8}}/>
            <div style={{display:'flex',gap:5,marginBottom:14}}>
              {['100','500','1000','5000'].map(v=><button key={v} onClick={()=>setAmount(v)} style={{flex:1,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}U</button>)}
            </div>

            {/* Leverage */}
            <div style={{marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                <span style={{color:T.muted,fontSize:11}}>레버리지 (최대 {sel.maxLev}x)</span>
                <span style={{color:lev>10?T.red:lev>5?T.ylw:T.grn,fontWeight:800,fontSize:13}}>{lev}x</span>
              </div>
              <input type="range" min={1} max={sel.maxLev} value={lev} onChange={e=>setLev(+e.target.value)} style={{width:'100%',accentColor:lev>10?T.red:lev>5?T.ylw:T.grn,marginBottom:6}}/>
              <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                {[1,2,3,5,10,sel.maxLev].filter((v,i,a)=>a.indexOf(v)===i).map(v=>(
                  <button key={v} onClick={()=>setLev(v)} style={{background:lev===v?T.acl+'25':'transparent',color:lev===v?T.acl:T.muted,border:`1px solid ${lev===v?T.acl:T.border}`,borderRadius:6,padding:'3px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}x</button>
                ))}
              </div>
            </div>

            {/* Liquidation preview */}
            {amount&&(
              <div style={{background:lev>10?T.red+'12':T.alt,border:`1px solid ${lev>10?T.red:T.border}30`,borderRadius:10,padding:'10px 12px',marginBottom:12}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{color:T.muted,fontSize:11}}>예상 청산가</span>
                  <span style={{color:lev>5?T.red:T.ylw,fontWeight:700,fontSize:11,fontFamily:'monospace'}}>{liqPrice.toFixed(sel.category==='forex'?4:2)}</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{color:T.muted,fontSize:11}}>청산까지 거리</span>
                  <span style={{color:T.txt,fontSize:11}}>{liqPct.toFixed(1)}% {side==='long'?'하락':'상승'} 시</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{color:T.muted,fontSize:11}}>거래 수수료 (0.05%)</span>
                  <span style={{color:T.txt,fontSize:11}}>{fee} USDT</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between'}}>
                  <span style={{color:T.muted,fontSize:11}}>오버나이트 (일)</span>
                  <span style={{color:T.ylw,fontSize:11}}>{Math.abs(swapFee)} USDT ({sel.overnight})</span>
                </div>
              </div>
            )}

            {lev>sel.maxLev*0.7&&<div style={{background:T.red+'12',border:`1px solid ${T.red}30`,borderRadius:8,padding:'8px 12px',marginBottom:12}}><div style={{color:T.red,fontSize:11,fontWeight:700}}>⚠️ 고레버리지 경고: CFD 상품은 레버리지 손실이 빠릅니다</div></div>}

            <button style={{width:'100%',padding:'14px',background:`linear-gradient(135deg,${side==='long'?T.grn:'#DC2626'},${side==='long'?'#059669':'#991B1B'})`,color:'#fff',border:'none',borderRadius:12,fontWeight:900,fontSize:14,cursor:'pointer'}}>
              [모의] {sel.nameKr} {side==='long'?'롱':'숏'} {lev}x 주문
            </button>
            <div style={{color:T.muted,fontSize:10,textAlign:'center',marginTop:6}}>실제 거래 미실행 · 수익 보장 없음 · CFD 위험 고지</div>
          </Card>
        </div>
      )}

      {/* Provider connect tab */}
      {tab==='connect'&&(
        <div>
          <div style={{fontWeight:800,fontSize:14,color:T.txt,marginBottom:12}}>🔗 TradFi 거래소 연동</div>
          {(Object.entries(TRADFI_PROVIDERS) as [TradFiProvider,any][]).filter(([k])=>k!=='watchonly').map(([key,p])=>(
            <Card key={key} style={{padding:'14px 16px',marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',gap:10,alignItems:'center'}}>
                  <div style={{width:40,height:40,borderRadius:10,background:p.color+'20',border:`1px solid ${p.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20}}>{p.icon}</div>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:13}}>{p.name}</div>
                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>TradFi/CFD 지원 · USDT 결제</div>
                    <div style={{display:'flex',gap:4,marginTop:4}}>
                      {TRADFI_ASSETS.filter(a=>a.providers.includes(key)).slice(0,4).map(a=><Bdg key={a.id} c={PRODUCT_COLOR[a.productType]} ch={a.sym} sm/>)}
                      {TRADFI_ASSETS.filter(a=>a.providers.includes(key)).length>4&&<Bdg c={T.muted} ch={`+${TRADFI_ASSETS.filter(a=>a.providers.includes(key)).length-4}개`} sm/>}
                    </div>
                  </div>
                </div>
                <a href={p.url} target="_blank" rel="noopener noreferrer" style={{background:p.color+'20',color:p.color,border:`1px solid ${p.color}40`,borderRadius:8,padding:'6px 12px',fontSize:11,fontWeight:700,textDecoration:'none'}}>연동</a>
              </div>
            </Card>
          ))}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.ylw}30`,marginTop:4}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:12,marginBottom:8}}>⚠️ 계정 적격성 안내</div>
            {['거래소 계정 KYC 완료 필요','일부 상품은 특정 국가에서 제한될 수 있음','개인 투자자 등급에 따라 레버리지 한도 다름','CFD는 거래소 정책에 따라 변동 가능','TRAIGO는 CFD 직접 제공자가 아닌 연결 플레이스홀더'].map((w,i)=>(
              <div key={i} style={{display:'flex',gap:6,padding:'3px 0'}}><span style={{color:T.ylw,fontSize:11}}>•</span><span style={{color:T.sub,fontSize:11}}>{w}</span></div>
            ))}
          </Card>
        </div>
      )}

      {/* Risk tab */}
      {tab==='risk'&&(
        <div>
          <div style={{fontWeight:800,fontSize:14,color:T.txt,marginBottom:12}}>⚠️ TradFi/CFD 위험 고지</div>
          {[
            {t:'CFD (차액결제거래) 란?',b:'CFD는 실제 자산을 보유하는 것이 아닌, 가격 변동 차이만 정산하는 파생상품입니다. 레버리지를 사용하므로 원금 전액 손실이 가능합니다.',c:'#7C3AED'},
            {t:'레버리지 위험',b:'레버리지를 사용하면 수익과 손실이 배수로 증가합니다. 10배 레버리지 사용 시 10% 역방향 이동만으로도 원금 전액 손실(청산)이 가능합니다.',c:T.red},
            {t:'오버나이트/스왑 비용',b:'CFD 포지션을 하루 이상 보유 시 스왑 비용(오버나이트 피)이 발생합니다. 장기 보유 시 상당한 비용이 누적될 수 있습니다.',c:T.ylw},
            {t:'토큰화 주식과의 차이',b:'일부 거래소는 "토큰화 주식"도 제공합니다. 이는 실제 주식과 유사하게 가격 추종하지만, 주주권이나 배당권이 없을 수 있습니다.',c:T.acl},
            {t:'지역 제한',b:'파생상품/CFD 규제는 국가마다 다릅니다. 일부 국가에서는 리테일 고객의 CFD 거래가 제한되거나 금지될 수 있습니다.',c:T.cyn},
            {t:'모의매매 기본값',b:'TRAIGO는 모의매매가 기본입니다. 실제 CFD 거래는 해당 거래소에서 직접 진행하며, TRAIGO는 직접 거래를 실행하지 않습니다.',c:T.grn},
          ].map(r=>(
            <Card key={r.t} style={{padding:'14px 16px',marginBottom:10,border:`1px solid ${r.c}25`}}>
              <div style={{color:r.c,fontWeight:700,fontSize:12,marginBottom:6}}>{r.t}</div>
              <div style={{color:T.sub,fontSize:11,lineHeight:1.6}}>{r.b}</div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── RealtimePage (실시간 엔진 + 알림 센터) ── */
type DataFreq = 'low'|'balanced'|'high';
interface RealtimeConfig { freq:DataFreq; wsEnabled:boolean; pollingInterval:number; }

function RealtimePage({prices}:{prices:Asset[]}) {
  const [config,setConfig]=useState<RealtimeConfig>({freq:'balanced',wsEnabled:true,pollingInterval:3000});
  const [wsStatus,setWsStatus]=useState<'connected'|'polling'|'error'>('connected');
  const [notifSettings,setNotifSettings]=useState({tpHit:true,slHit:true,liqWarning:true,volWarning:true,stratAlert:true,rebalance:false,marketOpen:true});
  const [channels,setChannels]=useState({push:true,telegram:false,discord:false,email:false});
  const [tab,setTab]=useState<'status'|'alerts'|'channels'>('status');

  const FREQ_OPTIONS:Record<DataFreq,{label:string;interval:number;desc:string;color:string}> = {
    low:      {label:'저주파',interval:10000,desc:'10초마다 업데이트 · 배터리 절약',color:T.grn},
    balanced: {label:'균형',interval:3000,desc:'3초마다 업데이트 · 권장',color:T.ylw},
    high:     {label:'고주파',interval:500,desc:'0.5초마다 업데이트 · 배터리 소모',color:T.red},
  };

  useEffect(()=>{
    // Simulate WS status check
    const t=setTimeout(()=>setWsStatus(config.wsEnabled?'connected':'polling'),500);
    return()=>clearTimeout(t);
  },[config.wsEnabled]);

  return (
    <div>
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {(['status','alerts','channels'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:'8px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {t==='status'?'📡 실시간 엔진':t==='alerts'?'🔔 알림 설정':'📤 알림 채널'}
          </button>
        ))}
      </div>

      {tab==='status'&&(
        <div>
          {/* WS Status */}
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${wsStatus==='connected'?T.grn:T.ylw}30`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <Dot c={wsStatus==='connected'?T.grn:T.ylw}/>
                <div><div style={{color:T.txt,fontWeight:700,fontSize:13}}>실시간 데이터 엔진</div><div style={{color:T.muted,fontSize:10}}>{wsStatus==='connected'?'WebSocket 연결됨':'폴링 모드 (WS 실패 시 자동 전환)'}</div></div>
              </div>
              <Toggle on={config.wsEnabled} onChange={v=>setConfig(p=>({...p,wsEnabled:v}))}/>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6}}>
              {[{l:'업데이트',v:FREQ_OPTIONS[config.freq].label},{l:'지연',v:`~${config.freq==='high'?500:config.freq==='balanced'?3000:10000}ms`},{l:'모드',v:config.wsEnabled?'WebSocket':'HTTP Polling'}].map(r=>(
                <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'8px 10px',textAlign:'center'}}>
                  <div style={{color:T.muted,fontSize:9}}>{r.l}</div>
                  <div style={{color:T.txt,fontSize:11,fontWeight:700,marginTop:1}}>{r.v}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Frequency selector */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>⚡ 업데이트 주파수</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {(Object.entries(FREQ_OPTIONS) as [DataFreq,any][]).map(([key,opt])=>(
                <button key={key} onClick={()=>setConfig(p=>({...p,freq:key,pollingInterval:opt.interval}))} style={{background:config.freq===key?opt.color+'20':T.alt,border:`2px solid ${config.freq===key?opt.color:T.border}`,borderRadius:12,padding:'12px 6px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{color:config.freq===key?opt.color:T.txt,fontWeight:800,fontSize:14,marginBottom:4}}>{opt.label}</div>
                  <div style={{color:T.muted,fontSize:9,lineHeight:1.5}}>{opt.desc}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Architecture info */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🏗️ 백엔드 아키텍처</div>
            {[
              {name:'WebSocket',status:'활성',desc:'Binance WS · 코인 실시간',color:T.grn,icon:'🔌'},
              {name:'HTTP Polling',status:'폴백',desc:'API 실패 시 자동 전환',color:T.ylw,icon:'🔄'},
              {name:'Supabase',status:'연동 대기',desc:'유저 데이터 · 포트폴리오',color:T.acl,icon:'🗄️'},
              {name:'Redis Cache',status:'플레이스홀더',desc:'고속 캐시 · 세션',color:T.prp,icon:'⚡'},
              {name:'PostgreSQL',status:'플레이스홀더',desc:'주문·거래 이력',color:T.cyn,icon:'💾'},
            ].map((s,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<4?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <span style={{fontSize:14}}>{s.icon}</span>
                  <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{s.name}</div><div style={{color:T.muted,fontSize:10}}>{s.desc}</div></div>
                </div>
                <Bdg c={s.color} ch={s.status} sm/>
              </div>
            ))}
          </Card>

          {/* DB Schema */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🗂️ DB 테이블 구조</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:5}}>
              {['users','portfolios','positions','orders','transactions','watchlists','alerts','strategies','backtests','api_connections','cached_assets','notifications','audit_logs','tradfi_orders'].map((t,i)=>(
                <div key={i} style={{background:T.alt,borderRadius:7,padding:'5px 9px',display:'flex',alignItems:'center',gap:5}}>
                  <span style={{color:T.acl,fontSize:10}}>📋</span><span style={{color:T.txt,fontSize:10,fontFamily:'monospace'}}>{t}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab==='alerts'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔔 알림 종류 설정</div>
            {[
              {k:'tpHit',l:'익절(TP) 도달',d:'목표가 달성 시 알림'},
              {k:'slHit',l:'손절(SL) 발동',d:'손절가 도달 시 알림'},
              {k:'liqWarning',l:'청산 위험 경고',d:'청산가 10% 이내 접근'},
              {k:'volWarning',l:'변동성 급등 경고',d:'24h 변동성 비정상'},
              {k:'stratAlert',l:'전략 알림',d:'자동매매 조건 충족'},
              {k:'rebalance',l:'리밸런싱 알림',d:'포트폴리오 비중 이탈'},
              {k:'marketOpen',l:'시장 개장/폐장',d:'주요 시장 개폐장 알림'},
            ].map((n,i,arr)=>(
              <div key={n.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{n.l}</div><div style={{color:T.muted,fontSize:10}}>{n.d}</div></div>
                <Toggle on={notifSettings[n.k as keyof typeof notifSettings]} onChange={v=>setNotifSettings(p=>({...p,[n.k]:v}))}/>
              </div>
            ))}
          </Card>
        </div>
      )}

      {tab==='channels'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📤 알림 채널</div>
            {[
              {k:'push',l:'앱 푸시 알림',d:'브라우저/PWA 푸시',status:'활성',c:T.grn},
              {k:'telegram',l:'텔레그램',d:'Bot 연동 필요',status:'준비중',c:T.acl},
              {k:'discord',l:'디스코드',d:'Webhook 연동 필요',status:'준비중',c:T.prp},
              {k:'email',l:'이메일',d:'계정 이메일로 발송',status:'준비중',c:T.ylw},
            ].map((ch,i,arr)=>(
              <div key={ch.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center'}}><span style={{color:T.txt,fontSize:12,fontWeight:600}}>{ch.l}</span><Bdg c={ch.c} ch={ch.status} sm/></div>
                  <div style={{color:T.muted,fontSize:10,marginTop:2}}>{ch.d}</div>
                </div>
                <Toggle on={channels[ch.k as keyof typeof channels]} onChange={v=>setChannels(p=>({...p,[ch.k]:v}))}/>
              </div>
            ))}
          </Card>

          {/* Telegram setup */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.acl}30`}}>
            <div style={{color:T.acl,fontWeight:700,fontSize:12,marginBottom:8}}>📱 텔레그램 연동 (준비중)</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.7,marginBottom:10}}>1. @TRAIGO_Bot 검색<br/>2. /start 입력<br/>3. 인증 코드 입력</div>
            <div style={{display:'flex',gap:8}}>
              <input placeholder="인증 코드 입력" style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:11,outline:'none'}}/>
              <button style={{background:T.acl+'20',color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'8px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>연동</button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ── AnalyticsPage (고급 분석 + 클라우드 동기화) ── */
function AnalyticsPage({prices,currency}:{prices:Asset[];currency:string}) {
  const [tab,setTab]=useState<'analytics'|'sync'|'export'>('analytics');

  const riskScore=72;
  const sectorAlloc=[
    {name:'반도체',pct:35,color:'#3B82F6'},
    {name:'코인',pct:25,color:'#F7931A'},
    {name:'테크',pct:20,color:'#7C3AED'},
    {name:'에너지',pct:10,color:'#D97706'},
    {name:'기타',pct:10,color:'#94A3B8'},
  ];

  return (
    <div>
      <div style={{display:'flex',gap:6,marginBottom:14,overflowX:'auto'}}>
        {(['analytics','sync','export'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flexShrink:0,padding:'8px 12px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {t==='analytics'?'📊 고급 분석':t==='sync'?'☁️ 클라우드 동기화':'📥 내보내기'}
          </button>
        ))}
      </div>

      {tab==='analytics'&&(
        <div>
          {/* Risk Score */}
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${riskScore>70?T.grn:riskScore>40?T.ylw:T.red}30`}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🎯 종합 리스크 점수</div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
              <div style={{color:riskScore>70?T.grn:riskScore>40?T.ylw:T.red,fontSize:32,fontWeight:900,fontFamily:'monospace'}}>{riskScore}</div>
              <div style={{textAlign:'right'}}>
                <Bdg c={T.grn} ch={riskScore>70?'건강':'보통'}/>
                <div style={{color:T.muted,fontSize:10,marginTop:3}}>100점 만점</div>
              </div>
            </div>
            <div style={{height:8,background:'#1A2D4A',borderRadius:4,overflow:'hidden',marginBottom:6}}>
              <div style={{height:'100%',width:riskScore+'%',background:riskScore>70?T.grn:riskScore>40?T.ylw:T.red,borderRadius:4,transition:'width .8s'}}/>
            </div>
          </Card>

          {/* Sector allocation */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🏭 섹터 배분</div>
            {sectorAlloc.map(s=>(
              <div key={s.name} style={{marginBottom:8}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{color:T.txt,fontSize:12}}>{s.name}</span>
                  <span style={{color:s.color,fontSize:12,fontWeight:700}}>{s.pct}%</span>
                </div>
                <div style={{height:6,background:'#1A2D4A',borderRadius:3,overflow:'hidden'}}>
                  <div style={{height:'100%',width:s.pct+'%',background:s.color,borderRadius:3}}/>
                </div>
              </div>
            ))}
          </Card>

          {/* Performance metrics */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📈 성과 지표</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8}}>
              {[
                {l:'샤프지수',v:'1.82',c:T.grn,sub:'위험대비 수익'},
                {l:'최대낙폭(MDD)',v:'-12.4%',c:T.red,sub:'최대 손실 구간'},
                {l:'변동성 (30D)',v:'18.2%',c:T.ylw,sub:'일간 수익 표준편차'},
                {l:'승률 (30D)',v:'67%',c:T.grn,sub:'수익 거래 비율'},
                {l:'수익팩터',v:'2.1',c:T.acl,sub:'총수익/총손실'},
                {l:'평균 보유기간',v:'3.2일',c:T.txt,sub:'포지션 평균 유지'},
              ].map(m=>(
                <div key={m.l} style={{background:T.alt,borderRadius:10,padding:'12px 12px'}}>
                  <div style={{color:T.muted,fontSize:9,marginBottom:3}}>{m.l}</div>
                  <div style={{color:m.c,fontSize:16,fontWeight:900,fontFamily:'monospace'}}>{m.v}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:2}}>{m.sub}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Correlation heatmap placeholder */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:4}}>🌡️ 자산 상관관계 히트맵</div>
            <div style={{color:T.muted,fontSize:10,marginBottom:10}}>상관계수 -1 (역상관) ~ +1 (정상관)</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:3}}>
              {['BTC','ETH','AAPL','NDX','GLD'].map(r=>['BTC','ETH','AAPL','NDX','GLD'].map(c=>{
                const corr=(r===c?1:Math.random()*1.6-0.3);
                const bg=corr>0.7?`rgba(16,185,129,${corr*0.7})`:corr<-0.3?`rgba(239,68,68,${Math.abs(corr)*0.7})`:'rgba(71,85,105,0.3)';
                return <div key={r+c} title={`${r}-${c}: ${corr.toFixed(2)}`} style={{background:bg,borderRadius:3,height:24,display:'flex',alignItems:'center',justifyContent:'center'}}><span style={{fontSize:8,color:'#fff',fontWeight:700}}>{corr.toFixed(1)}</span></div>;
              }))}
            </div>
            <div style={{display:'flex',justifyContent:'center',gap:16,marginTop:8}}>
              {['BTC','ETH','AAPL','NDX','GLD'].map(l=><span key={l} style={{color:T.muted,fontSize:9}}>{l}</span>)}
            </div>
          </Card>
        </div>
      )}

      {tab==='sync'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.grn}30`}}>
            <div style={{color:T.grn,fontWeight:700,marginBottom:10}}>☁️ 클라우드 동기화</div>
            {[
              {l:'포트폴리오',v:'동기화됨',t:'방금',c:T.grn},
              {l:'매매 기록',v:'동기화됨',t:'2분 전',c:T.grn},
              {l:'설정',v:'동기화됨',t:'5분 전',c:T.grn},
              {l:'왓치리스트',v:'미동기화',t:'-',c:T.ylw},
            ].map((s,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{s.l}</span>
                <div style={{display:'flex',gap:6,alignItems:'center'}}><span style={{color:T.muted,fontSize:10}}>{s.t}</span><Bdg c={s.c} ch={s.v} sm/></div>
              </div>
            ))}
            <button style={{width:'100%',marginTop:12,padding:'10px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer'}}>🔄 전체 동기화</button>
          </Card>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📱 연결 기기</div>
            {['iPhone 15 Pro · 현재 기기','MacBook Pro · 2시간 전'].map((d,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<1?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{d}</span>
                {i===0?<Bdg c={T.grn} ch="현재" sm/>:<button style={{background:T.red+'15',color:T.red,border:'none',borderRadius:6,padding:'3px 8px',fontSize:10,cursor:'pointer'}}>해제</button>}
              </div>
            ))}
          </Card>
        </div>
      )}

      {tab==='export'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📥 데이터 내보내기</div>
            {[
              {l:'포트폴리오 현황',f:'portfolio.json',icon:'💼'},
              {l:'매매 기록 (CSV)',f:'trades.csv',icon:'📋'},
              {l:'전략 설정',f:'strategies.json',icon:'🤖'},
              {l:'백테스트 결과',f:'backtests.json',icon:'🧪'},
              {l:'설정 백업',f:'settings.json',icon:'⚙️'},
            ].map((e,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<4?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}><span style={{fontSize:18}}>{e.icon}</span><div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{e.l}</div><div style={{color:T.muted,fontSize:10}}>{e.f}</div></div></div>
                <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>↓ 다운로드</button>
              </div>
            ))}
          </Card>
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📤 백업 복원</div>
            <div style={{border:`2px dashed ${T.border}`,borderRadius:10,padding:'24px',textAlign:'center',cursor:'pointer'}}>
              <div style={{fontSize:28,marginBottom:6}}>📁</div>
              <div style={{color:T.muted,fontSize:12}}>백업 파일을 드래그하거나 클릭하여 업로드</div>
              <div style={{color:T.muted,fontSize:10,marginTop:3}}>JSON, CSV 파일 지원</div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   TRAIGO SUBSCRIPTION SYSTEM
   Plans: Free · Pro · Premium · Lifetime · Founder · Admin
   ══════════════════════════════════════════════════════════════ */

type PlanType = 'free'|'pro'|'premium'|'lifetime'|'founder'|'admin';
type PlanStatus = 'active'|'expired'|'suspended'|'trialing';
type BadgeType = 'vip'|'founder'|'supporter'|'lifetime'|'admin'|'early_bird';

interface UserSubscription {
  userId: string;
  planType: PlanType;
  status: PlanStatus;
  expiresAt: string|null;   // null = never (lifetime/admin)
  grantedBy: string|null;   // admin userId who granted
  createdAt: string;
  inviteCode?: string;
  badges: BadgeType[];
}

interface InviteCode {
  id: string;
  code: string;
  planType: PlanType;
  usesMax: number|null;     // null = unlimited
  usesCount: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string|null;
  note: string;
  active: boolean;
}

const PLAN_INFO: Record<PlanType,{label:string;color:string;icon:string;price:string;features:string[]}> = {
  free:     {label:'무료',     color:'#94A3B8',icon:'🆓',price:'₩0',         features:['모의매매','기본 차트','15개 종목 왓치']},
  pro:      {label:'Pro',     color:'#3B82F6',icon:'⚡',price:'₩9,900/월',   features:['모든 무료 기능','무제한 왓치리스트','AI 분석 50회/월','실시간 알림']},
  premium:  {label:'Premium', color:'#7C3AED',icon:'💎',price:'₩29,900/월',  features:['모든 Pro 기능','AI 무제한','TradFi CFD','고급 백테스트']},
  lifetime: {label:'평생회원', color:'#F59E0B',icon:'♾️',price:'₩299,000 1회',features:['모든 Premium 기능','평생 이용','업그레이드 무료','우선 지원']},
  founder:  {label:'창업멤버', color:'#EF4444',icon:'🚀',price:'초대 전용',   features:['모든 기능','창업멤버 배지','영구 Premium','운영 참여']},
  admin:    {label:'관리자',   color:'#10B981',icon:'🛡️',price:'내부',        features:['전체 권한','사용자 관리','시스템 접근','코드 생성']},
};

const BADGE_INFO: Record<BadgeType,{label:string;color:string;icon:string}> = {
  vip:       {label:'VIP',     color:'#F59E0B',icon:'⭐'},
  founder:   {label:'창업멤버',color:'#EF4444',icon:'🚀'},
  supporter: {label:'서포터',  color:'#7C3AED',icon:'💜'},
  lifetime:  {label:'평생회원',color:'#F59E0B',icon:'♾️'},
  admin:     {label:'관리자',  color:'#10B981',icon:'🛡️'},
  early_bird:{label:'얼리버드',color:'#0891B2',icon:'🐦'},
};

// ── Mock data ─────────────────────────────────────────────────
const MOCK_CURRENT_USER: UserSubscription = {
  userId: 'usr_me',
  planType: 'pro',
  status: 'active',
  expiresAt: '2025-12-31',
  grantedBy: null,
  createdAt: '2025-01-15',
  badges: ['early_bird'],
};

const MOCK_USERS_ADMIN: (UserSubscription & {email:string;name:string})[] = [
  {userId:'usr_1',email:'kim@test.com',name:'김민준',planType:'lifetime',status:'active',expiresAt:null,grantedBy:'admin',createdAt:'2024-12-01',badges:['lifetime','vip']},
  {userId:'usr_2',email:'lee@test.com',name:'이서연',planType:'founder',status:'active',expiresAt:null,grantedBy:'admin',createdAt:'2024-11-15',badges:['founder','vip']},
  {userId:'usr_3',email:'park@test.com',name:'박지호',planType:'pro',status:'active',expiresAt:'2025-08-30',grantedBy:null,createdAt:'2025-02-01',badges:[]},
  {userId:'usr_4',email:'choi@test.com',name:'최유진',planType:'free',status:'active',expiresAt:null,grantedBy:null,createdAt:'2025-03-10',badges:['early_bird']},
  {userId:'usr_5',email:'jung@test.com',name:'정수민',planType:'premium',status:'active',expiresAt:'2025-07-31',grantedBy:null,createdAt:'2025-01-20',badges:['supporter']},
];

const MOCK_INVITE_CODES: InviteCode[] = [
  {id:'ic1',code:'TRAIGO-FOUNDER-2025',planType:'founder',usesMax:10,usesCount:2,createdBy:'admin',createdAt:'2024-11-01',expiresAt:null,note:'창업멤버 코드',active:true},
  {id:'ic2',code:'LIFETIME-VIP-AAA',planType:'lifetime',usesMax:1,usesCount:0,createdBy:'admin',createdAt:'2025-01-10',expiresAt:'2025-12-31',note:'개인 발급',active:true},
  {id:'ic3',code:'PRO-FRIEND-XYZ',planType:'pro',usesMax:null,usesCount:14,createdBy:'admin',createdAt:'2025-02-01',expiresAt:null,note:'친구 초대 - 무제한',active:true},
  {id:'ic4',code:'BETA-TESTER-001',planType:'pro',usesMax:50,usesCount:50,createdBy:'admin',createdAt:'2024-10-01',expiresAt:'2025-01-01',note:'베타 테스터용 (만료)',active:false},
];

/* ── Badge component ── */
function PlanBadge({plan,size='sm'}:{plan:PlanType;size?:'sm'|'md'|'lg'}) {
  const info = PLAN_INFO[plan];
  const sizes = {sm:{fontSize:10,padding:'2px 7px',borderRadius:99},md:{fontSize:12,padding:'4px 10px',borderRadius:12},lg:{fontSize:14,padding:'6px 14px',borderRadius:14}};
  const s = sizes[size];
  return (
    <span style={{background:info.color+'20',color:info.color,fontSize:s.fontSize,fontWeight:700,padding:s.padding,borderRadius:s.borderRadius,border:`1px solid ${info.color}40`,display:'inline-flex',alignItems:'center',gap:4,whiteSpace:'nowrap'}}>
      {info.icon} {info.label}
    </span>
  );
}

function UserBadge({badge}:{badge:BadgeType;[key:string]:any}) {
  const info = BADGE_INFO[badge];
  return (
    <span style={{background:info.color+'20',color:info.color,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:99,border:`1px solid ${info.color}40`,display:'inline-flex',alignItems:'center',gap:3}}>
      {info.icon} {info.label}
    </span>
  );
}

/* ── SubscriptionPage ── */
function SubscriptionPage() {
  const [tab, setTab] = useState<'myplan'|'plans'|'redeem'|'admin'>('myplan');
  const [sub, setSub] = useState<UserSubscription>(MOCK_CURRENT_USER);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemStatus, setRedeemStatus] = useState<string|null>(null);
  const [redeemLoading, setRedeemLoading] = useState(false);

  // Admin state
  const [adminUsers, setAdminUsers] = useState(MOCK_USERS_ADMIN);
  const [inviteCodes, setInviteCodes] = useState(MOCK_INVITE_CODES);
  const [adminTab, setAdminTab] = useState<'users'|'codes'|'stats'>('users');
  const [newCode, setNewCode] = useState({code:'',plan:'pro' as PlanType,usesMax:'1',note:'',expiresAt:''});
  const [grantModal, setGrantModal] = useState<{userId:string;name:string}|null>(null);
  const [grantPlan, setGrantPlan] = useState<PlanType>('lifetime');
  const [showCreateCode, setShowCreateCode] = useState(false);

  const isLifetime = sub.planType==='lifetime'||sub.planType==='founder'||sub.planType==='admin';
  const isAdmin = sub.planType==='admin';

  const handleRedeem = () => {
    if (!redeemCode.trim()) return;
    setRedeemLoading(true); setRedeemStatus(null);
    setTimeout(() => {
      const found = MOCK_INVITE_CODES.find(c => c.code.toUpperCase()===redeemCode.toUpperCase() && c.active);
      if (found) {
        setSub(p => ({...p, planType:found.planType, status:'active', expiresAt:null, inviteCode:found.code,
          badges: found.planType==='founder' ? [...p.badges,'founder','vip'] : found.planType==='lifetime' ? [...p.badges,'lifetime','vip'] : p.badges}));
        setRedeemStatus('success:' + found.planType);
      } else {
        setRedeemStatus('error');
      }
      setRedeemLoading(false);
    }, 900);
  };

  const handleGrant = (userId:string, plan:PlanType) => {
    setAdminUsers(prev => prev.map(u => u.userId===userId ? {
      ...u, planType:plan, status:'active', expiresAt:null, grantedBy:'admin',
      badges: plan==='founder' ? [...u.badges.filter(b=>b!=='founder'),'founder','vip'] :
              plan==='lifetime' ? [...u.badges.filter(b=>b!=='lifetime'),'lifetime','vip'] : u.badges
    } : u));
    setGrantModal(null);
  };

  const handleCreateCode = () => {
    const code: InviteCode = {
      id: 'ic'+Date.now(), code:newCode.code.toUpperCase(), planType:newCode.plan,
      usesMax: newCode.usesMax==='unlimited' ? null : +newCode.usesMax,
      usesCount:0, createdBy:'admin', createdAt:new Date().toISOString().split('T')[0],
      expiresAt: newCode.expiresAt||null, note:newCode.note, active:true,
    };
    setInviteCodes(prev=>[code,...prev]);
    setNewCode({code:'',plan:'pro',usesMax:'1',note:'',expiresAt:''});
    setShowCreateCode(false);
  };

  return (
    <div>
      {/* Tabs */}
      <div style={{display:'flex',gap:6,marginBottom:14,overflowX:'auto'}}>
        {([
          ['myplan','💳 내 플랜'],
          ['plans','📋 요금제'],
          ['redeem','🎟️ 코드 입력'],
          ...(isAdmin ? [['admin','🛡️ 관리자'] as const] : []),
        ] as [string,string][]).map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id as any)} style={{flexShrink:0,padding:'8px 12px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{label}</button>
        ))}
      </div>

      {/* ── MY PLAN ── */}
      {tab==='myplan'&&(
        <div>
          {/* Current plan card */}
          <div style={{background:`linear-gradient(135deg,${PLAN_INFO[sub.planType].color}18,${PLAN_INFO[sub.planType].color}08)`,border:`1px solid ${PLAN_INFO[sub.planType].color}40`,borderRadius:20,padding:'22px 18px',marginBottom:14}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12}}>
              <div>
                <div style={{color:T.muted,fontSize:11,marginBottom:4}}>현재 플랜</div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:28}}>{PLAN_INFO[sub.planType].icon}</span>
                  <div>
                    <div style={{color:T.txt,fontWeight:900,fontSize:20}}>{PLAN_INFO[sub.planType].label}</div>
                    {isLifetime && <div style={{color:PLAN_INFO[sub.planType].color,fontSize:11,fontWeight:700}}>♾️ 만료 없음 · 평생 이용</div>}
                    {!isLifetime && sub.expiresAt && <div style={{color:T.muted,fontSize:11}}>만료: {sub.expiresAt}</div>}
                  </div>
                </div>
              </div>
              <PlanBadge plan={sub.planType} size="md"/>
            </div>
            {/* Badges */}
            {sub.badges.length>0&&(
              <div style={{display:'flex',gap:5,flexWrap:'wrap',marginBottom:10}}>
                {sub.badges.map(b=><UserBadge key={b} badge={b}/>)}
              </div>
            )}
            {/* Features */}
            <div style={{display:'flex',flexDirection:'column',gap:4}}>
              {PLAN_INFO[sub.planType].features.map(f=>(
                <div key={f} style={{display:'flex',gap:6,alignItems:'center'}}>
                  <span style={{color:PLAN_INFO[sub.planType].color,fontSize:11}}>✅</span>
                  <span style={{color:T.sub,fontSize:11}}>{f}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Quick actions */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}}>
            <button onClick={()=>setTab('plans')} style={{background:T.acg,border:`1px solid ${T.acl}40`,borderRadius:12,padding:'12px',color:T.acl,fontWeight:700,fontSize:12,cursor:'pointer'}}>📋 요금제 비교</button>
            <button onClick={()=>setTab('redeem')} style={{background:T.prp+'15',border:`1px solid ${T.prp}40`,borderRadius:12,padding:'12px',color:T.prp,fontWeight:700,fontSize:12,cursor:'pointer'}}>🎟️ 초대 코드 입력</button>
          </div>

          {/* Subscription info */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>구독 정보</div>
            {[
              {l:'플랜',v:<PlanBadge plan={sub.planType} size="sm"/>},
              {l:'상태',v:<Bdg c={sub.status==='active'?T.grn:T.red} ch={sub.status==='active'?'활성':'만료'}/>},
              {l:'만료일',v:<span style={{color:T.txt,fontSize:12}}>{isLifetime?'♾️ 평생':sub.expiresAt||'-'}</span>},
              {l:'가입일',v:<span style={{color:T.muted,fontSize:12}}>{sub.createdAt}</span>},
              {l:'관리자 부여',v:<span style={{color:T.muted,fontSize:12}}>{sub.grantedBy?'예 (관리자)':'아니오'}</span>},
              {l:'초대 코드',v:<span style={{color:T.muted,fontSize:12,fontFamily:'monospace'}}>{sub.inviteCode||'-'}</span>},
            ].map((r,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<5?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.muted,fontSize:12}}>{r.l}</span>
                {r.v}
              </div>
            ))}
          </Card>

          {/* Payment placeholder */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.ylw}30`}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:12,marginBottom:8}}>💳 결제 수단</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6,marginBottom:10}}>실제 결제 기능은 준비 중입니다. 현재는 초대 코드 또는 관리자 부여로만 유료 플랜을 이용할 수 있습니다.</div>
            <div style={{display:'flex',gap:6}}>
              {['토스페이','카카오페이','카드결제'].map(p=>(
                <div key={p} style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 6px',textAlign:'center'}}>
                  <div style={{color:T.muted,fontSize:10,fontWeight:600}}>{p}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:2}}>준비중</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── PLANS ── */}
      {tab==='plans'&&(
        <div>
          <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:4}}>요금제 비교</div>
          <div style={{color:T.muted,fontSize:11,marginBottom:14}}>⚠️ 실제 결제 미구현 · 초대 코드 또는 관리자 부여</div>
          {(Object.entries(PLAN_INFO) as [PlanType,any][]).map(([key,info])=>(
            <div key={key} style={{background:sub.planType===key?info.color+'12':T.card,border:`2px solid ${sub.planType===key?info.color:T.border}`,borderRadius:16,padding:'16px',marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:22}}>{info.icon}</span>
                  <div>
                    <div style={{color:T.txt,fontWeight:800,fontSize:14}}>{info.label}</div>
                    <div style={{color:info.color,fontWeight:700,fontSize:12}}>{info.price}</div>
                  </div>
                </div>
                {sub.planType===key
                  ? <Bdg c={T.grn} ch="현재 플랜"/>
                  : key==='founder'||key==='admin'
                    ? <Bdg c={T.muted} ch="초대 전용"/>
                    : <button style={{background:info.color+'20',color:info.color,border:`1px solid ${info.color}40`,borderRadius:10,padding:'6px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>업그레이드 (준비중)</button>
                }
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:3}}>
                {info.features.map((f:string)=>(
                  <div key={f} style={{display:'flex',gap:6,alignItems:'center'}}>
                    <span style={{color:info.color,fontSize:11}}>✅</span>
                    <span style={{color:T.sub,fontSize:11}}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── REDEEM ── */}
      {tab==='redeem'&&(
        <div>
          <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:4}}>🎟️ 초대 코드 입력</div>
          <div style={{color:T.muted,fontSize:11,marginBottom:14}}>초대 코드를 입력하면 플랜이 즉시 활성화됩니다.</div>
          <Card style={{padding:'14px 16px',marginBottom:14}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>코드 입력</div>
            <div style={{display:'flex',gap:8,marginBottom:8}}>
              <input
                value={redeemCode}
                onChange={e=>setRedeemCode(e.target.value.toUpperCase())}
                onKeyDown={e=>e.key==='Enter'&&handleRedeem()}
                placeholder="예: TRAIGO-FOUNDER-2025"
                style={{flex:1,background:T.alt,border:`1px solid ${T.border2}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:13,fontFamily:'monospace',fontWeight:700,outline:'none',letterSpacing:1}}
              />
              <button onClick={handleRedeem} disabled={redeemLoading||!redeemCode.trim()} style={{background:T.acc,color:'#fff',border:'none',borderRadius:10,padding:'0 18px',fontWeight:700,fontSize:13,cursor:'pointer'}}>
                {redeemLoading?'확인중…':'적용'}
              </button>
            </div>
            {redeemStatus?.startsWith('success:')&&(
              <div style={{background:T.grn+'15',border:`1px solid ${T.grn}40`,borderRadius:10,padding:'12px 14px'}}>
                <div style={{color:T.grn,fontWeight:700,fontSize:13,marginBottom:4}}>✅ 코드 적용 완료!</div>
                <div style={{color:T.sub,fontSize:11}}>
                  {PLAN_INFO[redeemStatus.split(':')[1] as PlanType]?.label} 플랜이 활성화되었습니다.
                  {(redeemStatus.includes('lifetime')||redeemStatus.includes('founder'))&&' 평생 이용 가능합니다.'}
                </div>
              </div>
            )}
            {redeemStatus==='error'&&(
              <div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:10,padding:'12px 14px'}}>
                <div style={{color:T.red,fontWeight:700,fontSize:12}}>❌ 유효하지 않은 코드입니다</div>
                <div style={{color:T.muted,fontSize:10,marginTop:3}}>코드를 다시 확인하거나 관리자에게 문의하세요.</div>
              </div>
            )}
          </Card>
          {/* Test codes hint */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.ylw}30`}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:12,marginBottom:8}}>💡 테스트 코드 (개발 환경)</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {MOCK_INVITE_CODES.filter(c=>c.active).map(c=>(
                <div key={c.id} onClick={()=>setRedeemCode(c.code)} style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:T.alt,borderRadius:8,padding:'8px 12px',cursor:'pointer',border:`1px solid ${T.border}`}}>
                  <div>
                    <div style={{color:T.txt,fontSize:11,fontFamily:'monospace',fontWeight:700}}>{c.code}</div>
                    <div style={{display:'flex',gap:4,marginTop:2}}><PlanBadge plan={c.planType} size="sm"/><span style={{color:T.muted,fontSize:9}}>· {c.note}</span></div>
                  </div>
                  <span style={{color:T.acl,fontSize:11}}>→ 적용</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── ADMIN ── */}
      {tab==='admin'&&(
        <div>
          <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:4}}>🛡️ 구독 관리자</div>
          {/* Admin sub-tabs */}
          <div style={{display:'flex',gap:6,marginBottom:14}}>
            {(['users','codes','stats'] as const).map(t=>(
              <button key={t} onClick={()=>setAdminTab(t)} style={{flex:1,padding:'8px',background:adminTab===t?T.acg:'transparent',color:adminTab===t?T.acl:T.muted,border:`1px solid ${adminTab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
                {t==='users'?'👥 사용자':t==='codes'?'🎟️ 코드':'📊 현황'}
              </button>
            ))}
          </div>

          {/* Users tab */}
          {adminTab==='users'&&(
            <div>
              {adminUsers.map((u,i)=>(
                <div key={u.userId} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:'12px 14px',marginBottom:8}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                    <div>
                      <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:3}}>
                        <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{u.name}</span>
                        <PlanBadge plan={u.planType} size="sm"/>
                      </div>
                      <div style={{color:T.muted,fontSize:10}}>{u.email}</div>
                      <div style={{display:'flex',gap:4,marginTop:4,flexWrap:'wrap'}}>
                        {u.badges.map(b=><UserBadge key={b} badge={b}/>)}
                      </div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{color:T.muted,fontSize:9,marginBottom:4}}>
                        {u.expiresAt===null?'♾️ 평생':u.expiresAt||'-'}
                      </div>
                      <button onClick={()=>setGrantModal({userId:u.userId,name:u.name})} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>플랜 변경</button>
                    </div>
                  </div>
                  {/* Quick grant buttons */}
                  <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                    {(['lifetime','founder','pro','free'] as PlanType[]).map(p=>(
                      <button key={p} onClick={()=>handleGrant(u.userId,p)} style={{background:u.planType===p?PLAN_INFO[p].color+'20':T.alt,color:u.planType===p?PLAN_INFO[p].color:T.muted,border:`1px solid ${u.planType===p?PLAN_INFO[p].color:T.border}`,borderRadius:6,padding:'3px 8px',fontSize:9,fontWeight:700,cursor:'pointer'}}>
                        {PLAN_INFO[p].icon} {PLAN_INFO[p].label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Codes tab */}
          {adminTab==='codes'&&(
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div style={{color:T.txt,fontWeight:700}}>🎟️ 초대 코드 목록</div>
                <button onClick={()=>setShowCreateCode(v=>!v)} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'5px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 새 코드</button>
              </div>

              {showCreateCode&&(
                <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.acl}30`}}>
                  <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>새 초대 코드 생성</div>
                  {[
                    {l:'코드',k:'code',ph:'예: TRAIGO-VIP-2025',type:'text'},
                    {l:'메모',k:'note',ph:'예: 개인 발급',type:'text'},
                    {l:'최대 사용',k:'usesMax',ph:'1 (unlimited=무제한)',type:'text'},
                    {l:'만료일',k:'expiresAt',ph:'YYYY-MM-DD (비워두면 무기한)',type:'date'},
                  ].map(f=>(
                    <div key={f.k} style={{marginBottom:8}}>
                      <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:3}}>{f.l}</div>
                      <input type={f.type} value={newCode[f.k as keyof typeof newCode]} onChange={e=>setNewCode(p=>({...p,[f.k]:e.target.value}))} placeholder={f.ph}
                        style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:12,outline:'none',fontFamily:f.k==='code'?'monospace':'inherit'}}/>
                    </div>
                  ))}
                  <div style={{marginBottom:10}}>
                    <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:3}}>플랜</div>
                    <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                      {(['pro','premium','lifetime','founder'] as PlanType[]).map(p=>(
                        <button key={p} onClick={()=>setNewCode(prev=>({...prev,plan:p}))} style={{background:newCode.plan===p?PLAN_INFO[p].color+'20':T.alt,color:newCode.plan===p?PLAN_INFO[p].color:T.muted,border:`1px solid ${newCode.plan===p?PLAN_INFO[p].color:T.border}`,borderRadius:8,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>
                          {PLAN_INFO[p].icon} {PLAN_INFO[p].label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{display:'flex',gap:8}}>
                    <button onClick={()=>setShowCreateCode(false)} style={{flex:1,padding:'10px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,cursor:'pointer'}}>취소</button>
                    <button onClick={handleCreateCode} disabled={!newCode.code.trim()} style={{flex:2,padding:'10px',background:T.acc,color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer'}}>코드 생성</button>
                  </div>
                </Card>
              )}

              {inviteCodes.map((c,i)=>(
                <div key={c.id} style={{background:T.card,border:`1px solid ${c.active?T.border:T.muted+'30'}`,borderRadius:12,padding:'12px 14px',marginBottom:8,opacity:c.active?1:0.55}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
                    <div>
                      <div style={{color:T.txt,fontWeight:700,fontSize:12,fontFamily:'monospace',letterSpacing:.5,marginBottom:4}}>{c.code}</div>
                      <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                        <PlanBadge plan={c.planType} size="sm"/>
                        <Bdg c={c.active?T.grn:T.muted} ch={c.active?'활성':'비활성'}/>
                        <Bdg c={T.muted} ch={`${c.usesCount}/${c.usesMax===null?'∞':c.usesMax} 사용`}/>
                      </div>
                    </div>
                    <button onClick={()=>setInviteCodes(prev=>prev.map(x=>x.id===c.id?{...x,active:!x.active}:x))} style={{background:c.active?T.red+'15':T.grn+'15',color:c.active?T.red:T.grn,border:`1px solid ${c.active?T.red:T.grn}30`,borderRadius:8,padding:'4px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
                      {c.active?'비활성화':'활성화'}
                    </button>
                  </div>
                  <div style={{display:'flex',gap:10}}>
                    <span style={{color:T.muted,fontSize:10}}>{c.note}</span>
                    {c.expiresAt&&<span style={{color:T.muted,fontSize:10}}>만료: {c.expiresAt}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Stats tab */}
          {adminTab==='stats'&&(
            <div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:10,marginBottom:14}}>
                {[
                  {l:'전체 사용자',v:adminUsers.length+'명',c:T.acl},
                  {l:'유료 사용자',v:adminUsers.filter(u=>u.planType!=='free').length+'명',c:T.grn},
                  {l:'평생 회원',v:adminUsers.filter(u=>u.planType==='lifetime'||u.planType==='founder').length+'명',c:T.ylw},
                  {l:'활성 코드',v:inviteCodes.filter(c=>c.active).length+'개',c:T.prp},
                ].map(s=>(
                  <Card key={s.l} style={{padding:'14px 12px'}}>
                    <div style={{color:T.muted,fontSize:10,marginBottom:4}}>{s.l}</div>
                    <div style={{color:s.c,fontSize:22,fontWeight:900,fontFamily:'monospace'}}>{s.v}</div>
                  </Card>
                ))}
              </div>
              <Card style={{padding:'14px 16px',marginBottom:12}}>
                <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>플랜별 분포</div>
                {(Object.entries(PLAN_INFO) as [PlanType,any][]).map(([key,info])=>{
                  const count=adminUsers.filter(u=>u.planType===key).length;
                  const pct=Math.round(count/adminUsers.length*100);
                  return (
                    <div key={key} style={{marginBottom:8}}>
                      <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                        <div style={{display:'flex',gap:5,alignItems:'center'}}><span style={{fontSize:12}}>{info.icon}</span><span style={{color:T.txt,fontSize:11}}>{info.label}</span></div>
                        <span style={{color:info.color,fontSize:11,fontWeight:700}}>{count}명 ({pct}%)</span>
                      </div>
                      <div style={{height:5,background:'#1A2D4A',borderRadius:3,overflow:'hidden'}}>
                        <div style={{height:'100%',width:pct+'%',background:info.color,borderRadius:3,transition:'width .5s'}}/>
                      </div>
                    </div>
                  );
                })}
              </Card>
              {/* DB Schema reference */}
              <Card style={{padding:'14px 16px',border:`1px solid ${T.acl}30`}}>
                <div style={{color:T.acl,fontWeight:700,fontSize:12,marginBottom:8}}>🗄️ DB 스키마 (참고)</div>
                <div style={{background:'#060B14',borderRadius:8,padding:'10px 12px',fontFamily:'monospace',fontSize:10,color:T.grn,lineHeight:1.8}}>
                  {`-- subscriptions table\ncreate table subscriptions (\n  user_id uuid references auth.users,\n  plan_type text,\n  status text,\n  expires_at timestamptz,\n  granted_by uuid,\n  created_at timestamptz default now()\n);\n\n-- invite_codes table\ncreate table invite_codes (\n  code text primary key,\n  plan_type text,\n  uses_max int,\n  uses_count int default 0,\n  active boolean default true\n);`}
                </div>
              </Card>
            </div>
          )}

          {/* Grant modal */}
          {grantModal&&(
            <>
              <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200}} onClick={()=>setGrantModal(null)}/>
              <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px 40px',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
                <div style={{color:T.txt,fontWeight:800,fontSize:16,marginBottom:4}}>🛡️ 플랜 변경</div>
                <div style={{color:T.muted,fontSize:12,marginBottom:16}}>{grantModal.name}에게 플랜을 부여합니다</div>
                <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:16}}>
                  {(Object.entries(PLAN_INFO) as [PlanType,any][]).map(([key,info])=>(
                    <button key={key} onClick={()=>setGrantPlan(key)} style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:grantPlan===key?info.color+'20':T.alt,border:`2px solid ${grantPlan===key?info.color:T.border}`,borderRadius:12,padding:'12px 14px',cursor:'pointer'}}>
                      <div style={{display:'flex',gap:8,alignItems:'center'}}>
                        <span style={{fontSize:18}}>{info.icon}</span>
                        <div style={{textAlign:'left'}}><div style={{color:T.txt,fontWeight:700,fontSize:13}}>{info.label}</div><div style={{color:info.color,fontSize:11}}>{info.price}</div></div>
                      </div>
                      {grantPlan===key&&<span style={{color:info.color,fontSize:16,fontWeight:900}}>✓</span>}
                    </button>
                  ))}
                </div>
                <div style={{display:'flex',gap:10}}>
                  <button onClick={()=>setGrantModal(null)} style={{flex:1,padding:'13px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
                  <button onClick={()=>handleGrant(grantModal.userId,grantPlan)} style={{flex:2,padding:'13px',background:`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>✅ 플랜 부여</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}



/* ══════════════════════════════════════════════════════════════
   ECONOMIC CALENDAR PAGE
   ══════════════════════════════════════════════════════════════ */
function EconCalendarPage() {
  const [filter,setFilter]=useState<'all'|'high'|'medium'|'low'>('all');
  const [tab,setTab]=useState<'upcoming'|'earnings'|'crypto'>('upcoming');

  const EVENTS=[
    {id:'e1',date:'2025-05-28',time:'21:00',title:'FOMC 금리 결정',nameKr:'미국 기준금리',impact:'high',expected:'5.50%',previous:'5.50%',assets:['SPX','NDX','DJI','BTC','GLD'],category:'macro',countdown:'13일 후'},
    {id:'e2',date:'2025-05-14',time:'21:30',title:'CPI 소비자물가지수',nameKr:'미국 CPI',impact:'high',expected:'3.4%',previous:'3.5%',assets:['SPX','BTC','GLD','USDKRW'],category:'macro',countdown:'오늘'},
    {id:'e3',date:'2025-05-17',time:'21:30',title:'미국 소매판매',nameKr:'미국 소매판매',impact:'medium',expected:'0.4%',previous:'0.7%',assets:['SPX','AMZN','WMT'],category:'macro',countdown:'3일 후'},
    {id:'e4',date:'2025-05-03',time:'21:30',title:'비농업고용지수 NFP',nameKr:'미국 NFP',impact:'high',expected:'240K',previous:'303K',assets:['SPX','DJI','USD'],category:'macro',countdown:'11일 전'},
    {id:'e5',date:'2025-05-22',time:'장후',title:'NVIDIA 실적 발표',nameKr:'NVDA Q1 어닝',impact:'high',expected:'EPS $5.58',previous:'EPS $5.16',assets:['NVDA','SMH','QQQ'],category:'earnings',countdown:'8일 후'},
    {id:'e6',date:'2025-05-29',time:'장후',title:'Salesforce 실적 발표',nameKr:'CRM Q1 어닝',impact:'medium',expected:'EPS $2.34',previous:'EPS $2.12',assets:['CRM'],category:'earnings',countdown:'15일 후'},
    {id:'e7',date:'2025-05-15',time:'10:00',title:'ETH 언락 이벤트',nameKr:'이더리움 스테이킹 언락',impact:'medium',expected:'820K ETH',previous:'-',assets:['ETH'],category:'crypto',countdown:'1일 후'},
    {id:'e8',date:'2025-06-01',time:'00:00',title:'BTC 반감기 후 90일',nameKr:'비트코인 반감기 D+90',impact:'low',expected:'-',previous:'-',assets:['BTC'],category:'crypto',countdown:'18일 후'},
  ];

  const IMPACT_COLOR:Record<string,string>={'high':T.red,'medium':T.ylw,'low':T.grn};
  const IMPACT_LABEL:Record<string,string>={'high':'🔴 높음','medium':'🟡 중간','low':'🟢 낮음'};

  const catFilter = tab==='upcoming'?['macro']:tab==='earnings'?['earnings']:['crypto'];
  const filtered = EVENTS.filter(e=>catFilter.includes(e.category)&&(filter==='all'||e.impact===filter));

  return (
    <div>
      {/* Sub tabs */}
      <div style={{display:'flex',gap:6,marginBottom:12}}>
        {([['upcoming','📅 경제지표'],['earnings','📊 어닝'],['crypto','🔗 크립토']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:'8px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* Impact filter */}
      <div style={{display:'flex',gap:5,marginBottom:12,overflowX:'auto'}}>
        {([['all','전체',T.muted],['high','🔴 높음',T.red],['medium','🟡 중간',T.ylw],['low','🟢 낮음',T.grn]] as const).map(([id,l,c])=>(
          <button key={id} onClick={()=>setFilter(id)} style={{flexShrink:0,padding:'5px 10px',background:filter===id?c+'20':'transparent',color:filter===id?c:T.muted,border:`1px solid ${filter===id?c:T.border}`,borderRadius:20,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* Events */}
      {filtered.map((ev,i)=>(
        <Card key={ev.id} style={{padding:'14px',marginBottom:10,border:`1px solid ${IMPACT_COLOR[ev.impact]}20`}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
            <div style={{flex:1}}>
              <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:4,flexWrap:'wrap'}}>
                <span style={{background:IMPACT_COLOR[ev.impact]+'20',color:IMPACT_COLOR[ev.impact],fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99}}>{IMPACT_LABEL[ev.impact]}</span>
                <span style={{color:T.muted,fontSize:10}}>{ev.date} {ev.time}</span>
                <span style={{color:T.acl,fontSize:10,fontWeight:700}}>{ev.countdown}</span>
              </div>
              <div style={{color:T.txt,fontWeight:700,fontSize:14,marginBottom:2}}>{ev.title}</div>
              <div style={{color:T.muted,fontSize:11}}>{ev.nameKr}</div>
            </div>
          </div>
          {/* Expected vs Previous */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
            <div style={{background:T.acg,borderRadius:8,padding:'8px 10px'}}>
              <div style={{color:T.muted,fontSize:9,marginBottom:2}}>예상</div>
              <div style={{color:T.acl,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>{ev.expected}</div>
            </div>
            <div style={{background:T.alt,borderRadius:8,padding:'8px 10px'}}>
              <div style={{color:T.muted,fontSize:9,marginBottom:2}}>이전</div>
              <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>{ev.previous}</div>
            </div>
          </div>
          {/* Affected assets */}
          <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
            <span style={{color:T.muted,fontSize:10,alignSelf:'center'}}>영향 자산:</span>
            {ev.assets.map(a=>(
              <span key={a} style={{background:T.alt,color:T.sub,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:6,border:`1px solid ${T.border}`}}>{a}</span>
            ))}
          </div>
        </Card>
      ))}

      {filtered.length===0&&(
        <div style={{textAlign:'center',padding:'40px 0'}}>
          <div style={{fontSize:32,marginBottom:8}}>📅</div>
          <div style={{color:T.muted,fontSize:13}}>해당 조건의 이벤트가 없습니다</div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   AI DAILY BRIEFING PAGE
   ══════════════════════════════════════════════════════════════ */
function BriefingPage({prices}:{prices:Asset[]}) {
  const [tab,setTab]=useState<'market'|'portfolio'|'risk'|'watchlist'>('market');
  const now=new Date();
  const hour=now.getHours();
  const timeLabel=hour<12?'오전 브리핑':hour<18?'오후 브리핑':'야간 브리핑';

  const MARKET_ITEMS=[
    {icon:'₿',title:'BTC 모멘텀',body:'비트코인이 9,400만원 저항선에서 조정 중입니다. 단기 변동성이 확대되고 있으며, 반감기 이후 공급 감소 효과가 시장에 반영되고 있습니다.',sentiment:'neutral',tag:'변동성 주의'},
    {icon:'📊',title:'나스닥 기술주',body:'나스닥이 +0.87% 상승하며 AI 섹터 강세가 지속되고 있습니다. NVDA, MSFT 중심의 상승세로 반도체 ETF가 선도하고 있습니다.',sentiment:'bullish',tag:'강세'},
    {icon:'🛢️',title:'원유·인플레이션',body:'WTI 원유가 소폭 하락(-0.9%)하며 에너지 비용 압력이 줄어들고 있습니다. 이는 CPI 발표에 긍정적 영향을 줄 수 있습니다.',sentiment:'neutral',tag:'관찰'},
    {icon:'💱',title:'달러·환율',body:'달러 인덱스가 소폭 약세(-0.22%)를 보이며 원화가 강세입니다. 수출주에 단기 부정적 요인이 될 수 있습니다.',sentiment:'bearish',tag:'주의'},
    {icon:'🥇',title:'금·안전자산',body:'금이 +0.56% 상승하며 지정학적 리스크에 대한 헤지 수요가 지속되고 있습니다. 포트폴리오 안정성 역할을 수행 중입니다.',sentiment:'bullish',tag:'안전'},
  ];

  const PORTFOLIO_ITEMS=[
    {icon:'📈',title:'장투 포트폴리오 건강',body:'BTC·ETH 장기 포지션이 안정적입니다. 목표가 대비 진행률이 62%로 순조롭게 진행 중이며, DCA 계획이 정상 실행되고 있습니다.',sentiment:'bullish'},
    {icon:'⚡',title:'단타 주의 신호',body:'SOL 단기 포지션이 목표가의 85%에 도달했습니다. 부분 익절을 고려해볼 수 있습니다.',sentiment:'neutral'},
    {icon:'💵',title:'현금 비중',body:'현금 비중 10%가 유지되고 있습니다. CPI 발표 후 매수 기회를 노리는 전략이 유효합니다.',sentiment:'neutral'},
  ];

  const RISK_ITEMS=[
    {icon:'⚠️',title:'집중도 경고',body:'NVDA 단일 종목 비중이 35%를 초과했습니다. 분산 투자를 권장합니다.',level:'warning'},
    {icon:'✅',title:'레버리지 정상',body:'현재 사용 중인 레버리지가 권장 범위 내에 있습니다. 단타 계좌 최대 레버리지: 3배.',level:'ok'},
    {icon:'📡',title:'펀딩비 정상',body:'BTC 선물 펀딩비 0.01%로 정상 범위입니다. 과열 신호 없음.',level:'ok'},
    {icon:'⚠️',title:'유동성 주의',body:'일부 알트코인 포지션의 슬리피지가 높을 수 있습니다. 큰 규모 거래 시 주의하세요.',level:'warning'},
  ];

  const sentimentColor=(s:string)=>s==='bullish'?T.grn:s==='bearish'?T.red:T.ylw;

  return (
    <div>
      {/* Header */}
      <div style={{background:'linear-gradient(135deg,#0A1628,#0D1F3C)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'16px 18px',marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
          <span style={{fontSize:20}}>🤖</span>
          <div>
            <div style={{color:T.txt,fontWeight:800,fontSize:15}}>AI {timeLabel}</div>
            <div style={{color:T.muted,fontSize:10}}>{now.toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'long'})} · 교육 목적 · 수익 보장 없음</div>
          </div>
        </div>
        <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:8,padding:'6px 10px',marginTop:8}}>
          <div style={{color:T.ylw,fontSize:10,fontWeight:600}}>⚠️ AI 브리핑은 교육·참고 목적이며 투자 조언이 아닙니다. 수익을 보장하지 않습니다.</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:'flex',gap:6,marginBottom:14,overflowX:'auto'}}>
        {([['market','🌐 시장'],['portfolio','💼 포트폴리오'],['risk','🛡️ 리스크'],['watchlist','👁 왓치리스트']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'8px 12px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {tab==='market'&&(
        <div>
          <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>오늘의 시장 브리핑</div>
          {MARKET_ITEMS.map((item,i)=>(
            <Card key={i} style={{padding:'14px 16px',marginBottom:10,border:`1px solid ${sentimentColor(item.sentiment)}15`}}>
              <div style={{display:'flex',gap:10,alignItems:'flex-start'}}>
                <div style={{width:36,height:36,borderRadius:10,background:sentimentColor(item.sentiment)+'15',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>{item.icon}</div>
                <div style={{flex:1}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5}}>
                    <div style={{color:T.txt,fontWeight:700,fontSize:13}}>{item.title}</div>
                    <span style={{background:sentimentColor(item.sentiment)+'20',color:sentimentColor(item.sentiment),fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99}}>{item.tag}</span>
                  </div>
                  <div style={{color:T.sub,fontSize:11,lineHeight:1.6}}>{item.body}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab==='portfolio'&&(
        <div>
          <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>포트폴리오 요약</div>
          {PORTFOLIO_ITEMS.map((item,i)=>(
            <Card key={i} style={{padding:'14px 16px',marginBottom:10,border:`1px solid ${sentimentColor(item.sentiment)}15`}}>
              <div style={{display:'flex',gap:10}}>
                <span style={{fontSize:22,flexShrink:0}}>{item.icon}</span>
                <div>
                  <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:4}}>{item.title}</div>
                  <div style={{color:T.sub,fontSize:11,lineHeight:1.6}}>{item.body}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab==='risk'&&(
        <div>
          <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>리스크 요약</div>
          {RISK_ITEMS.map((item,i)=>(
            <Card key={i} style={{padding:'14px 16px',marginBottom:10,border:`1px solid ${item.level==='warning'?T.ylw:T.grn}20`}}>
              <div style={{display:'flex',gap:10}}>
                <span style={{fontSize:20,flexShrink:0}}>{item.icon}</span>
                <div>
                  <div style={{color:item.level==='warning'?T.ylw:T.grn,fontWeight:700,fontSize:13,marginBottom:4}}>{item.title}</div>
                  <div style={{color:T.sub,fontSize:11,lineHeight:1.6}}>{item.body}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab==='watchlist'&&(
        <div>
          <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>왓치리스트 하이라이트</div>
          {prices.slice(0,6).map((a,i)=>(
            <Card key={a.id} style={{padding:'12px 14px',marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <Logo id={a.id} size={32} clr={a.clr}/>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{a.nameKr}</div>
                    <div style={{color:T.muted,fontSize:10}}>{a.sym}</div>
                  </div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>{cvt(a.p,'KRW')}</div>
                  <div style={{color:a.c>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{a.c>=0?'+':''}{a.c.toFixed(2)}%</div>
                </div>
              </div>
              <div style={{marginTop:8,color:T.muted,fontSize:10,lineHeight:1.5}}>
                {Math.abs(a.c)>5?`⚠️ 변동성 높음 — 레버리지 주의`:Math.abs(a.c)>2?`📊 보통 변동성 — 전략적 접근`:`✅ 안정적 움직임`}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   TAX / PROFIT TRACKING PAGE
   ══════════════════════════════════════════════════════════════ */
function TaxPage({currency}:{currency:string}) {
  const [year,setYear]=useState('2025');
  const [tab,setTab]=useState<'summary'|'history'|'export'>('summary');

  const YEARLY={
    realized:  2870000,
    unrealized:1230000,
    fee:        124000,
    net:       2746000,
    taxRate:    22,
    taxEst:     604120,
    trades:     47,
    winTrades:  32,
    lossTrades: 15,
  };

  const MONTHLY=[
    {m:'1월',pnl:480000,trades:8},{m:'2월',pnl:-120000,trades:6},
    {m:'3월',pnl:640000,trades:10},{m:'4월',pnl:310000,trades:7},
    {m:'5월',pnl:1560000,trades:16},{m:'6월',pnl:0,trades:0},
  ];

  const maxPnl=Math.max(...MONTHLY.map(m=>Math.abs(m.pnl)));

  const HISTORY=[
    {date:'2025-05-10',asset:'BTC/USDT',side:'buy',amount:500000,pnl:87000,fee:250,type:'선물'},
    {date:'2025-05-08',asset:'NVDA',side:'sell',amount:280000,pnl:54000,fee:140,type:'주식CFD'},
    {date:'2025-05-05',asset:'ETH/USDT',side:'buy',amount:200000,pnl:-12000,fee:100,type:'선물'},
    {date:'2025-04-28',asset:'SOL/USDT',side:'sell',amount:150000,pnl:45000,fee:75,type:'현물'},
    {date:'2025-04-20',asset:'SPY',side:'buy',amount:400000,pnl:32000,fee:200,type:'ETF CFD'},
  ];

  return (
    <div>
      {/* Year selector */}
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {['2023','2024','2025'].map(y=>(
          <button key={y} onClick={()=>setYear(y)} style={{flex:1,padding:'8px',background:year===y?T.acg:'transparent',color:year===y?T.acl:T.muted,border:`1px solid ${year===y?T.acl:T.border}`,borderRadius:10,fontSize:12,fontWeight:700,cursor:'pointer'}}>{y}년</button>
        ))}
      </div>

      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {([['summary','📊 요약'],['history','📋 거래내역'],['export','📥 내보내기']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:'8px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {tab==='summary'&&(
        <div>
          <div style={{background:'linear-gradient(135deg,#0A1628,#0D1F3C)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
            <div style={{color:T.muted,fontSize:11,marginBottom:2}}>{year}년 순 실현손익 (모의)</div>
            <div style={{color:T.grn,fontSize:28,fontWeight:900,fontFamily:'monospace'}}>+{cvt(YEARLY.net,currency)}</div>
            <div style={{display:'flex',gap:16,marginTop:8}}>
              <div><div style={{color:T.muted,fontSize:10}}>실현손익</div><div style={{color:T.grn,fontWeight:700,fontSize:12}}>+{cvt(YEARLY.realized,currency)}</div></div>
              <div><div style={{color:T.muted,fontSize:10}}>미실현</div><div style={{color:T.ylw,fontWeight:700,fontSize:12}}>+{cvt(YEARLY.unrealized,currency)}</div></div>
              <div><div style={{color:T.muted,fontSize:10}}>수수료</div><div style={{color:T.red,fontWeight:700,fontSize:12}}>-{cvt(YEARLY.fee,currency)}</div></div>
            </div>
          </div>

          {/* Tax estimate */}
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.ylw}30`}}>
            <div style={{color:T.ylw,fontWeight:700,marginBottom:8}}>💼 세금 추정 (플레이스홀더)</div>
            <div style={{background:T.ylw+'10',borderRadius:10,padding:'12px 14px',marginBottom:8}}>
              <div style={{color:T.muted,fontSize:10,marginBottom:2}}>추정 세율 (가상자산 세금 예시)</div>
              <div style={{color:T.ylw,fontSize:22,fontWeight:900,fontFamily:'monospace'}}>{cvt(YEARLY.taxEst,currency)}</div>
              <div style={{color:T.muted,fontSize:10,marginTop:2}}>{YEARLY.taxRate}% × 과세표준 (실제 세율·공제는 세무사 상담 필요)</div>
            </div>
            <div style={{background:T.red+'10',border:`1px solid ${T.red}20`,borderRadius:8,padding:'8px 12px'}}>
              <div style={{color:T.red,fontSize:10,fontWeight:700}}>⚠️ 이 수치는 참고용이며 실제 세금 신고 근거로 사용하지 마세요. 반드시 세무사와 상담하세요.</div>
            </div>
          </Card>

          {/* Monthly chart */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>월별 손익</div>
            <div style={{display:'flex',gap:6,alignItems:'flex-end',height:100}}>
              {MONTHLY.map(m=>{
                const h=maxPnl>0?Math.abs(m.pnl)/maxPnl*80:0;
                return (
                  <div key={m.m} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:3}}>
                    <div style={{color:m.pnl>=0?T.grn:T.red,fontSize:8,fontWeight:700}}>{m.pnl===0?'':m.pnl>=0?'+':'-'}</div>
                    <div style={{width:'100%',background:m.pnl>0?T.grn:m.pnl<0?T.red:T.border,borderRadius:'3px 3px 0 0',height:Math.max(4,h),opacity:m.pnl===0?0.3:1}}/>
                    <div style={{color:T.muted,fontSize:9}}>{m.m.replace('월','')}</div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Stats */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
            {[{l:'총 거래',v:`${YEARLY.trades}건`,c:T.acl},{l:'수익 거래',v:`${YEARLY.winTrades}건`,c:T.grn},{l:'손실 거래',v:`${YEARLY.lossTrades}건`,c:T.red},{l:'승률',v:`${Math.round(YEARLY.winTrades/YEARLY.trades*100)}%`,c:T.grn},{l:'총 수수료',v:cvt(YEARLY.fee,currency),c:T.muted},{l:'손익비',v:'2.1:1',c:T.ylw}].map(s=>(
              <Card key={s.l} style={{padding:'10px 8px',textAlign:'center'}}>
                <div style={{color:s.c,fontSize:14,fontWeight:900,fontFamily:'monospace',marginBottom:2}}>{s.v}</div>
                <div style={{color:T.muted,fontSize:9}}>{s.l}</div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {tab==='history'&&(
        <div>
          <Card style={{overflow:'hidden'}}>
            <div style={{display:'grid',gridTemplateColumns:'80px 1fr 70px 60px',padding:'8px 12px',borderBottom:`1px solid ${T.border}`,color:T.muted,fontSize:9,fontWeight:700,textTransform:'uppercase'}}>
              <span>날짜</span><span>종목</span><span style={{textAlign:'right'}}>손익</span><span style={{textAlign:'right'}}>수수료</span>
            </div>
            {HISTORY.map((h,i)=>(
              <div key={i} style={{display:'grid',gridTemplateColumns:'80px 1fr 70px 60px',padding:'10px 12px',borderBottom:i<HISTORY.length-1?`1px solid ${T.border}`:'none',alignItems:'center'}}>
                <div><div style={{color:T.muted,fontSize:10}}>{h.date.slice(5)}</div></div>
                <div>
                  <div style={{color:T.txt,fontSize:11,fontWeight:600}}>{h.asset}</div>
                  <div style={{display:'flex',gap:4}}>
                    <span style={{background:h.side==='buy'?T.grn+'15':T.red+'15',color:h.side==='buy'?T.grn:T.red,fontSize:8,fontWeight:700,padding:'1px 5px',borderRadius:4}}>{h.side==='buy'?'매수':'매도'}</span>
                    <span style={{color:T.muted,fontSize:9}}>{h.type}</span>
                  </div>
                </div>
                <div style={{textAlign:'right',color:h.pnl>=0?T.grn:T.red,fontSize:11,fontWeight:700,fontFamily:'monospace'}}>{h.pnl>=0?'+':''}{(h.pnl/1000).toFixed(0)}K</div>
                <div style={{textAlign:'right',color:T.muted,fontSize:10}}>{(h.fee/1000).toFixed(1)}K</div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {tab==='export'&&(
        <div>
          <Card style={{padding:'16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📥 데이터 내보내기</div>
            {[
              {l:`${year}년 거래내역 CSV`,icon:'📊',desc:'엑셀에서 열 수 있는 CSV 형식',color:T.grn},
              {l:`${year}년 손익 요약 PDF`,icon:'📄',desc:'세무신고 참고용 요약본',color:T.red},
              {l:'전체 포트폴리오 JSON',icon:'💾',desc:'개발자/백업용 JSON 형식',color:T.acl},
              {l:'매매 일지 Excel',icon:'📈',desc:'XLSX 형식 상세 매매 일지',color:T.ylw},
            ].map((e,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}><span style={{fontSize:20}}>{e.icon}</span><div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{e.l}</div><div style={{color:T.muted,fontSize:10}}>{e.desc}</div></div></div>
                <button style={{background:e.color+'15',color:e.color,border:`1px solid ${e.color}30`,borderRadius:8,padding:'5px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>↓ 내보내기</button>
              </div>
            ))}
          </Card>
          <Card style={{padding:'14px 16px',border:`1px solid ${T.ylw}30`}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:12,marginBottom:6}}>⚠️ 면책 조항</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6}}>내보내기 데이터는 모의투자 기록이며 실제 세금 신고에 사용할 수 없습니다. 실제 거래 세금 신고는 각 거래소의 공식 자료를 사용하고 세무사와 상담하세요.</div>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   ONBOARDING / GROWTH PAGE
   ══════════════════════════════════════════════════════════════ */
function GrowthPage() {
  const [checklist,setChecklist]=useState([
    {id:'c1',done:true, label:'앱 설치 및 첫 로그인',          reward:'🎖 신규 배지',     xp:50},
    {id:'c2',done:true, label:'왓치리스트에 첫 종목 추가',      reward:'⭐ +10 XP',        xp:10},
    {id:'c3',done:true, label:'모의 첫 거래 실행',              reward:'⚡ 첫 거래 배지',  xp:30},
    {id:'c4',done:false,label:'포트폴리오 배분 설정',           reward:'💼 +20 XP',        xp:20},
    {id:'c5',done:false,label:'DCA 계획 1개 등록',              reward:'🔄 DCA 배지',       xp:25},
    {id:'c6',done:false,label:'AI 브리핑 3회 읽기',             reward:'🤖 AI 뱃지',        xp:15},
    {id:'c7',done:false,label:'경제 캘린더 북마크',             reward:'📅 +10 XP',        xp:10},
    {id:'c8',done:false,label:'친구 1명 초대',                  reward:'🎁 Pro 1개월',      xp:100},
  ]);

  const ACHIEVEMENTS=[
    {icon:'🎖',name:'신규 투자자',desc:'첫 로그인',earned:true,color:T.acl},
    {icon:'⚡',name:'첫 거래',desc:'첫 모의 거래',earned:true,color:T.ylw},
    {icon:'⭐',name:'왓치마스터',desc:'왓치리스트 10개',earned:false,color:T.muted},
    {icon:'📈',name:'장투러',desc:'장투 30일 보유',earned:false,color:T.muted},
    {icon:'🤖',name:'AI 애호가',desc:'AI 채팅 20회',earned:false,color:T.muted},
    {icon:'🔥',name:'연속 7일',desc:'7일 연속 접속',earned:false,color:T.muted},
    {icon:'💎',name:'분석왕',desc:'백테스트 5회',earned:false,color:T.muted},
    {icon:'🚀',name:'창업자 지지',desc:'창업멤버 초대',earned:false,color:T.muted},
  ];

  const totalXP=checklist.filter(c=>c.done).reduce((s,c)=>s+c.xp,0);
  const maxXP=checklist.reduce((s,c)=>s+c.xp,0);
  const doneCount=checklist.filter(c=>c.done).length;

  const REFERRAL_CODE='TRAIGO-MY001';
  const REFERRAL_COUNT=2;

  return (
    <div>
      {/* XP Progress */}
      <div style={{background:'linear-gradient(135deg,#0A1628,#0D1F3C)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
          <div>
            <div style={{color:T.muted,fontSize:11,marginBottom:2}}>총 경험치</div>
            <div style={{color:T.ylw,fontSize:28,fontWeight:900,fontFamily:'monospace'}}>{totalXP} XP</div>
          </div>
          <div style={{background:T.ylw+'20',borderRadius:12,padding:'8px 14px',textAlign:'center'}}>
            <div style={{color:T.ylw,fontSize:18,fontWeight:900}}>Lv.{Math.floor(totalXP/50)+1}</div>
            <div style={{color:T.muted,fontSize:9}}>초보 투자자</div>
          </div>
        </div>
        <div style={{height:6,background:'#1A2D4A',borderRadius:3,overflow:'hidden',marginBottom:4}}>
          <div style={{height:'100%',width:`${totalXP/maxXP*100}%`,background:`linear-gradient(90deg,${T.ylw},${T.grn})`,borderRadius:3,transition:'width .6s'}}/>
        </div>
        <div style={{color:T.muted,fontSize:10}}>{totalXP}/{maxXP} XP · 체크리스트 {doneCount}/{checklist.length} 완료</div>
      </div>

      {/* Checklist */}
      <Card style={{overflow:'hidden',marginBottom:14}}>
        <div style={{padding:'12px 14px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{color:T.txt,fontWeight:700,fontSize:13}}>🎯 시작 체크리스트</div>
          <Bdg c={T.grn} ch={`${doneCount}/${checklist.length}`}/>
        </div>
        {checklist.map((c,i)=>(
          <div key={c.id} onClick={()=>setChecklist(prev=>prev.map(x=>x.id===c.id?{...x,done:!x.done}:x))} style={{display:'flex',gap:10,alignItems:'center',padding:'12px 14px',borderBottom:i<checklist.length-1?`1px solid ${T.border}`:'none',cursor:'pointer',opacity:c.done?1:0.7}}>
            <div style={{width:22,height:22,borderRadius:6,background:c.done?T.grn:T.alt,border:`2px solid ${c.done?T.grn:T.border}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
              {c.done&&<span style={{color:'#fff',fontSize:12,fontWeight:900}}>✓</span>}
            </div>
            <div style={{flex:1}}>
              <div style={{color:c.done?T.sub:T.txt,fontSize:12,fontWeight:600,textDecoration:c.done?'line-through':'none'}}>{c.label}</div>
              <div style={{color:T.ylw,fontSize:10,marginTop:1}}>{c.reward} · +{c.xp} XP</div>
            </div>
          </div>
        ))}
      </Card>

      {/* Achievements */}
      <Card style={{padding:'14px 16px',marginBottom:14}}>
        <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🏆 업적 배지</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
          {ACHIEVEMENTS.map(a=>(
            <div key={a.name} style={{textAlign:'center',opacity:a.earned?1:0.4}}>
              <div style={{width:48,height:48,borderRadius:14,background:a.earned?a.color+'20':T.alt,border:`2px solid ${a.earned?a.color:T.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,margin:'0 auto 5px'}}>{a.icon}</div>
              <div style={{color:a.earned?T.txt:T.muted,fontSize:9,fontWeight:700}}>{a.name}</div>
              <div style={{color:T.muted,fontSize:8,marginTop:1}}>{a.desc}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Referral */}
      <Card style={{padding:'16px',border:`1px solid ${T.prp}30`}}>
        <div style={{color:T.prp,fontWeight:700,marginBottom:8}}>🎁 친구 초대 리워드</div>
        <div style={{display:'flex',gap:8,marginBottom:10}}>
          <div style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'9px 12px',fontFamily:'monospace',fontSize:12,fontWeight:700,color:T.txt,letterSpacing:1}}>{REFERRAL_CODE}</div>
          <button onClick={()=>typeof navigator!=='undefined'&&navigator.clipboard?.writeText(REFERRAL_CODE)} style={{background:T.prp+'20',color:T.prp,border:`1px solid ${T.prp}40`,borderRadius:8,padding:'0 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>복사</button>
        </div>
        <div style={{display:'flex',gap:8,marginBottom:8}}>
          <div style={{flex:1,background:T.alt,borderRadius:10,padding:'10px 12px',textAlign:'center'}}>
            <div style={{color:T.prp,fontSize:20,fontWeight:900}}>{REFERRAL_COUNT}</div>
            <div style={{color:T.muted,fontSize:10}}>초대한 친구</div>
          </div>
          <div style={{flex:1,background:T.alt,borderRadius:10,padding:'10px 12px',textAlign:'center'}}>
            <div style={{color:T.grn,fontSize:16,fontWeight:900}}>+2개월</div>
            <div style={{color:T.muted,fontSize:10}}>획득한 Pro</div>
          </div>
          <div style={{flex:1,background:T.alt,borderRadius:10,padding:'10px 12px',textAlign:'center'}}>
            <div style={{color:T.ylw,fontSize:16,fontWeight:900}}>3명</div>
            <div style={{color:T.muted,fontSize:10}}>목표까지</div>
          </div>
        </div>
        <div style={{color:T.muted,fontSize:10,lineHeight:1.5}}>친구가 가입하면 본인과 친구 모두 Pro 1개월씩 증정 (준비중)</div>
      </Card>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   BTC WUNDER AUTO COMPLETE FINAL — Built-in Strategy
   ══════════════════════════════════════════════════════════════════════ */

/* ─── Pine Script full text (stored as constant) ─── */
const PINE_SCRIPT = `//@version=5
strategy("BTC WUNDER AUTO COMPLETE FINAL", shorttitle="WUNDER", overlay=true,
         default_qty_type=strategy.percent_of_equity, default_qty_value=10,
         initial_capital=10000, commission_type=strategy.commission.percent,
         commission_value=0.05, pyramiding=3)

// ══════════════════════════════════════════════
// INPUTS
// ══════════════════════════════════════════════
i_seed          = input.float(10000,  "자동매매 시드 (USDT)")
i_totalPct      = input.float(30,     "총 진입 비율 %",   minval=1, maxval=100)
i_lev           = input.int(  3,      "레버리지",          minval=1, maxval=20)
i_e1            = input.float(40,     "1차 진입 %",        group="Scale-In")
i_e2            = input.float(30,     "2차 진입 %",        group="Scale-In")
i_e3            = input.float(30,     "3차 진입 %",        group="Scale-In")
i_weekTarget    = input.int(  10,     "주간 목표 거래수")
i_reentryBars   = input.int(  3,      "재진입 제한 봉 수")
i_blockWeekend  = input.bool( true,   "주말 차단")
i_htf           = input.timeframe("1D","상위 타임프레임")
i_rangeSL       = input.float(1.5,    "횡보 손절 %",       group="Risk")
i_trendSL       = input.float(2.5,    "추세 손절 %",       group="Risk")
i_rangeTrail    = input.float(1.0,    "횡보 트레일 %",     group="Risk")
i_trendTrail    = input.float(1.5,    "추세 트레일 %",     group="Risk")
i_be            = input.float(0.8,    "본절 이동 %",       group="Risk")
i_weakExit      = input.float(0.5,    "익절 감시 %",       group="Risk")
i_target        = input.float(3.0,    "목표 %",            group="Risk")
i_addDist       = input.float(0.5,    "추가진입 거리 %",   group="Scale-In")
i_oppExit       = input.bool( true,   "반대신호 EXIT-ALL")

// ══════════════════════════════════════════════
// INDICATORS
// ══════════════════════════════════════════════
ema20   = ta.ema(close, 20)
ema50   = ta.ema(close, 50)
ema200  = ta.ema(close, 200)
rsi14   = ta.rsi(close, 14)
[macdL, macdS, macdH] = ta.macd(close, 12, 26, 9)
[dip, dim, adx] = ta.dmi(14, 14)
atr14   = ta.atr(14)
volAvg  = ta.sma(volume, 20)
htfEma  = request.security(syminfo.tickerid, i_htf, ta.ema(close, 200))

// ── Trend detection ──────────────────────────
isBullTrend = close > ema200 and ema20 > ema50 and ema50 > ema200
isBearTrend = close < ema200 and ema20 < ema50 and ema50 < ema200
isRange     = not isBullTrend and not isBearTrend

// ── ADX filter ───────────────────────────────
adxStrong = adx > 20

// ── Volume filter ────────────────────────────
volOk = volume > volAvg * 1.2

// ── ATR filter ───────────────────────────────
atrOk = atr14 > ta.sma(atr14, 50) * 0.8

// ── HTF filter ───────────────────────────────
htfBull = close > htfEma
htfBear = close < htfEma

// ── Range logic ──────────────────────────────
rangeHigh = ta.highest(high,  50)
rangeLow  = ta.lowest( low,   50)
rangeSize = (rangeHigh - rangeLow) / rangeLow * 100
isNarrow  = rangeSize < 5.0

// ── Pullback entries ─────────────────────────
pullLong  = isBullTrend and ta.crossover( close, ema20) and rsi14 < 65 and adxStrong and volOk and atrOk and htfBull
pullShort = isBearTrend and ta.crossunder(close, ema20) and rsi14 > 35 and adxStrong and volOk and atrOk and htfBear

// ── Breakout entries ─────────────────────────
boLong  = isRange and ta.crossover( close, rangeHigh) and volOk and adxStrong
boShort = isRange and ta.crossunder(close, rangeLow)  and volOk and adxStrong

// ── Composite signals ────────────────────────
longSig  = (pullLong  or boLong)  and not isNarrow
shortSig = (pullShort or boShort) and not isNarrow

// ── Weekend block ────────────────────────────
dayOfWeek = dayofweek(time, "UTC+9")
isWeekend = i_blockWeekend and (dayOfWeek == dayofweek.saturday or dayOfWeek == dayofweek.sunday)

// ── Scale-in sizing ──────────────────────────
baseQty = i_seed * (i_totalPct / 100) * i_lev / close
qty1 = baseQty * (i_e1 / 100)
qty2 = baseQty * (i_e2 / 100)
qty3 = baseQty * (i_e3 / 100)

// ── State tracking ───────────────────────────
var int  scaleStage   = 0
var float avgEntry    = na
var float trailStop   = na
var int  lossStreak   = 0
var int  weeklyTrades = 0
var int  lastTradeBar = 0
var bool inLong       = false
var bool inShort      = false

// ── Cooldown & streak checks ─────────────────
cooldownOk    = (bar_index - lastTradeBar) >= i_reentryBars
streakOk      = lossStreak < 3
weeklyOk      = weeklyTrades < i_weekTarget

// ── Entry conditions ─────────────────────────
canLong  = longSig  and not inLong  and not inShort and cooldownOk and streakOk and weeklyOk and not isWeekend
canShort = shortSig and not inShort and not inLong  and cooldownOk and streakOk and weeklyOk and not isWeekend

// ── Scale-in (pyramiding) ─────────────────────
canAdd2L = inLong  and scaleStage == 1 and close <= avgEntry * (1 - i_addDist/100)
canAdd3L = inLong  and scaleStage == 2 and close <= avgEntry * (1 - i_addDist*2/100)
canAdd2S = inShort and scaleStage == 1 and close >= avgEntry * (1 + i_addDist/100)
canAdd3S = inShort and scaleStage == 2 and close >= avgEntry * (1 + i_addDist*2/100)

// ── Stop Loss ─────────────────────────────────
slPct = isRange ? i_rangeSL : i_trendSL
longSL  = inLong  ? avgEntry * (1 - slPct/100) : na
shortSL = inShort ? avgEntry * (1 + slPct/100) : na

// ── Trailing Stop ─────────────────────────────
trailPct = isRange ? i_rangeTrail : i_trendTrail

// ── Entries ───────────────────────────────────
if canLong
    strategy.entry("L1", strategy.long,  qty=qty1)
    scaleStage := 1
    inLong     := true
    avgEntry   := close
    lastTradeBar := bar_index
    weeklyTrades += 1

if canAdd2L
    strategy.entry("L2", strategy.long,  qty=qty2)
    scaleStage := 2

if canAdd3L
    strategy.entry("L3", strategy.long,  qty=qty3)
    scaleStage := 3

if canShort
    strategy.entry("S1", strategy.short, qty=qty1)
    scaleStage := 1
    inShort    := true
    avgEntry   := close
    lastTradeBar := bar_index
    weeklyTrades += 1

if canAdd2S
    strategy.entry("S2", strategy.short, qty=qty2)
    scaleStage := 2

if canAdd3S
    strategy.entry("S3", strategy.short, qty=qty3)
    scaleStage := 3

// ── Exits ─────────────────────────────────────
// Target exit
if inLong and close >= avgEntry * (1 + i_target/100)
    strategy.close_all(comment="🎯 목표 도달")
    inLong := false; scaleStage := 0

if inShort and close <= avgEntry * (1 - i_target/100)
    strategy.close_all(comment="🎯 목표 도달")
    inShort := false; scaleStage := 0

// Stop loss
if inLong  and close <= longSL
    strategy.close_all(comment="🛑 손절")
    inLong  := false; scaleStage := 0; lossStreak += 1

if inShort and close >= shortSL
    strategy.close_all(comment="🛑 손절")
    inShort := false; scaleStage := 0; lossStreak += 1

// Opposite signal exit
if i_oppExit
    if inLong  and shortSig
        strategy.close_all(comment="↩ 반대신호")
        inLong  := false; scaleStage := 0
    if inShort and longSig
        strategy.close_all(comment="↩ 반대신호")
        inShort := false; scaleStage := 0

// Loss streak reset on profit
if strategy.wintrades > strategy.wintrades[1]
    lossStreak := 0

// Weekly reset
newWeek = ta.change(weekofyear(time)) != 0
if newWeek
    weeklyTrades := 0

// ── Plots ─────────────────────────────────────
plot(ema20,  "EMA20",  color=color.new(color.blue,  20), linewidth=1)
plot(ema50,  "EMA50",  color=color.new(color.orange,20), linewidth=1)
plot(ema200, "EMA200", color=color.new(color.red,   10), linewidth=2)

// Entry markers
plotshape(canLong,  title="Long",  style=shape.triangleup,   location=location.belowbar, color=color.lime,  size=size.small)
plotshape(canShort, title="Short", style=shape.triangledown, location=location.abovebar, color=color.red,   size=size.small)

// ── WunderTrading Alert (복사해서 TradingView Alert에 붙여넣기) ───────
// Long Entry:
// {"code":"{{strategy.order.id}}","orderType":"openLong","amountPerTradeType":"percent","amountPerTrade":{{strategy.order.contracts}},"leverage":3,"stopLoss":2.5,"reduceOnly":false,"pos":"{{strategy.position_size}}"}
//
// Close All:
// {"code":"BTCWUNDER","orderType":"closeAll","reduceOnly":true,"pos":"0"}
`;

/* ─── Webhook payload templates ─── */
const WEBHOOK_TEMPLATES = {
  openLong: `{
  "code": "BTCWUNDER",
  "orderType": "openLong",
  "amountPerTradeType": "percent",
  "amountPerTrade": 10,
  "leverage": 3,
  "stopLoss": 2.5,
  "reduceOnly": false,
  "pos": "{{strategy.position_size}}"
}`,
  openShort: `{
  "code": "BTCWUNDER",
  "orderType": "openShort",
  "amountPerTradeType": "percent",
  "amountPerTrade": 10,
  "leverage": 3,
  "stopLoss": 2.5,
  "reduceOnly": false,
  "pos": "{{strategy.position_size}}"
}`,
  closeAll: `{
  "code": "BTCWUNDER",
  "orderType": "closeAll",
  "reduceOnly": true,
  "pos": "0"
}`,
};

/* ─── Default settings ─── */
interface WunderSettings {
  seed:number; totalPct:number; leverage:number;
  e1:number; e2:number; e3:number;
  weekTarget:number; reentryBars:number; blockWeekend:boolean;
  htf:string; rangeSL:number; trendSL:number;
  rangeTrail:number; trendTrail:number; be:number;
  weakExit:number; target:number; addDist:number; oppExit:boolean;
}

const DEFAULT_SETTINGS: WunderSettings = {
  seed:10000, totalPct:30, leverage:3,
  e1:40, e2:30, e3:30,
  weekTarget:10, reentryBars:3, blockWeekend:true,
  htf:'1D', rangeSL:1.5, trendSL:2.5,
  rangeTrail:1.0, trendTrail:1.5, be:0.8,
  weakExit:0.5, target:3.0, addDist:0.5, oppExit:true,
};

/* ─── Mock bot state ─── */
interface BotState {
  direction:'long'|'short'|'flat'; scaleStage:number;
  avgEntry:number; stopPrice:number; lossStreak:number;
  weeklySignals:number; paperPnl:number; paperPnlPct:number;
  lastSignal:string; webhookStatus:'connected'|'waiting'|'error';
}

const INIT_BOT: BotState = {
  direction:'long', scaleStage:2, avgEntry:91400000, stopPrice:89119000,
  lossStreak:0, weeklySignals:4, paperPnl:874000, paperPnlPct:1.91,
  lastSignal:'2025-05-13T09:32:00', webhookStatus:'waiting',
};

const MOCK_SIGNALS = [
  {id:'wh1',type:'openLong',price:91400000,time:'09:32',leverage:3,sl:2.5,stage:1,comment:'EMA 골든크로스 + RSI 52'},
  {id:'wh2',type:'addLong',price:91020000,time:'11:15',leverage:3,sl:2.5,stage:2,comment:'2차 추가진입 -0.5%'},
  {id:'wh3',type:'closeAll',price:90100000,time:'전일 22:00',leverage:3,sl:2.5,stage:0,comment:'손절 -1.5% 도달'},
  {id:'wh4',type:'openShort',price:94800000,time:'전일 16:40',leverage:3,sl:2.5,stage:1,comment:'EMA 데드크로스'},
];

/* ─── MAIN COMPONENT ─── */
function WunderPage() {
  const [tab,setTab]=useState<'dashboard'|'settings'|'logic'|'webhook'|'pine'>('dashboard');
  const [settings,setSettings]=useState<WunderSettings>(DEFAULT_SETTINGS);
  const [bot,setBot]=useState<BotState>(INIT_BOT);
  const [running,setRunning]=useState(false);
  const [copied,setCopied]=useState('');
  const [showPine,setShowPine]=useState(false);
  const [webhookUrl,setWebhookUrl]=useState('');
  const [wunderCode,setWunderCode]=useState('BTCWUNDER');
  const [showRealWarning,setShowRealWarning]=useState(false);

  const copyText=(text:string,label:string)=>{
    if(typeof navigator!=='undefined')navigator.clipboard?.writeText(text);
    setCopied(label);setTimeout(()=>setCopied(''),2000);
  };

  const updateSetting=(k:keyof WunderSettings,v:number|boolean|string)=>setSettings(p=>({...p,[k]:v}));

  return (
    <div>
      {/* Header */}
      <div style={{background:'linear-gradient(135deg,#0A0F1E,#0D1628)',border:`1px solid ${T.acl}40`,borderRadius:18,padding:'16px 18px',marginBottom:14}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
          <div>
            <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:4}}>
              <span style={{fontSize:20}}>🤖</span>
              <span style={{color:T.acl,fontWeight:900,fontSize:14}}>BTC WUNDER AUTO</span>
              <Bdg c={T.grn} ch="COMPLETE FINAL"/>
            </div>
            <div style={{color:T.muted,fontSize:10}}>BTC/USDT · 5분봉 · 레버리지 {settings.leverage}x · 모의매매 전용</div>
          </div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <Bdg c={T.prp} ch="🎮 모의"/>
            <button onClick={()=>setRunning(r=>!r)} style={{background:running?T.grn+'20':T.acg,color:running?T.grn:T.acl,border:`1px solid ${running?T.grn:T.acl}40`,borderRadius:10,padding:'7px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>
              {running?'⏸ 일시중지':'▶ 시작 (모의)'}
            </button>
          </div>
        </div>
        {/* Quick stats */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
          {[
            {l:'방향',v:bot.direction==='long'?'📈 롱':bot.direction==='short'?'📉 숏':'💤 대기',c:bot.direction==='long'?T.grn:bot.direction==='short'?T.red:T.muted},
            {l:'평균단가',v:cvt(bot.avgEntry,'KRW'),c:T.txt},
            {l:'모의 PnL',v:`+${cvt(bot.paperPnl,'KRW')}`,c:T.grn},
            {l:'주간 신호',v:`${bot.weeklySignals}/${settings.weekTarget}`,c:T.acl},
          ].map(s=>(
            <div key={s.l} style={{background:'rgba(0,0,0,.3)',borderRadius:8,padding:'7px 8px',textAlign:'center'}}>
              <div style={{color:s.c,fontSize:11,fontWeight:700,fontFamily:'monospace'}}>{s.v}</div>
              <div style={{color:T.muted,fontSize:9,marginTop:1}}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:'flex',gap:5,marginBottom:14,overflowX:'auto'}}>
        {([['dashboard','📊 대시보드'],['settings','⚙️ 설정'],['logic','📖 전략 설명'],['webhook','🔗 웹훅'],['pine','📜 Pine Script']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'7px 11px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* ────── DASHBOARD ────── */}
      {tab==='dashboard'&&(
        <div>
          {/* Paper warning */}
          <div style={{background:T.prp+'12',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'9px 13px',marginBottom:12}}>
            <div style={{color:T.prp,fontWeight:700,fontSize:11}}>🎮 모의매매 전용 · 실제 거래 미실행 · 수익 보장 없음</div>
          </div>

          {/* Bot state card */}
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${bot.direction==='long'?T.grn:T.red}20`}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🤖 봇 현재 상태</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              {[
                {l:'현재 방향',v:bot.direction==='long'?'📈 롱 포지션':bot.direction==='short'?'📉 숏 포지션':'💤 대기',c:bot.direction==='long'?T.grn:bot.direction==='short'?T.red:T.muted},
                {l:'스케일인 단계',v:`${bot.scaleStage}/3단계`,c:T.ylw},
                {l:'평균 진입가',v:cvt(bot.avgEntry,'KRW'),c:T.txt},
                {l:'손절가',v:cvt(bot.stopPrice,'KRW'),c:T.red},
                {l:'모의 PnL',v:`+${cvt(bot.paperPnl,'KRW')} (+${bot.paperPnlPct}%)`,c:T.grn},
                {l:'연속 손실',v:`${bot.lossStreak}회 / 3회 한도`,c:bot.lossStreak>=2?T.red:bot.lossStreak>=1?T.ylw:T.grn},
                {l:'주간 신호',v:`${bot.weeklySignals}/${settings.weekTarget}회`,c:T.acl},
                {l:'웹훅 상태',v:bot.webhookStatus==='connected'?'✅ 연결됨':'⏳ 대기중',c:bot.webhookStatus==='connected'?T.grn:T.ylw},
              ].map(s=>(
                <div key={s.l} style={{background:T.alt,borderRadius:8,padding:'8px 10px'}}>
                  <div style={{color:T.muted,fontSize:9,marginBottom:2}}>{s.l}</div>
                  <div style={{color:s.c,fontSize:11,fontWeight:700}}>{s.v}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Recent signals */}
          <Card style={{overflow:'hidden',marginBottom:12}}>
            <div style={{padding:'10px 14px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div style={{color:T.txt,fontWeight:700,fontSize:13}}>📡 최근 신호 (모의)</div>
              <Bdg c={T.muted} ch="자동 처리"/>
            </div>
            {MOCK_SIGNALS.map((sig,i)=>{
              const isOpen=sig.type.includes('open')||sig.type.includes('add');
              const isClose=sig.type==='closeAll';
              const clr=isClose?T.red:sig.type.includes('Long')?T.grn:T.red;
              const label=sig.type==='openLong'?'롱 진입':sig.type==='openShort'?'숏 진입':sig.type==='addLong'?'롱 추가':sig.type==='closeAll'?'전체 청산':'신호';
              return (
                <div key={sig.id} style={{padding:'11px 14px',borderBottom:i<MOCK_SIGNALS.length-1?`1px solid ${T.border}`:'none'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                    <div>
                      <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:3}}>
                        <span style={{background:clr+'20',color:clr,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:6}}>{label}</span>
                        <span style={{color:T.muted,fontSize:10}}>{sig.time}</span>
                        {sig.stage>0&&<span style={{background:T.ylw+'15',color:T.ylw,fontSize:9,padding:'1px 5px',borderRadius:5}}>{sig.stage}차</span>}
                      </div>
                      <div style={{color:T.muted,fontSize:10}}>{sig.comment}</div>
                    </div>
                    <div style={{textAlign:'right',flexShrink:0}}>
                      <div style={{color:T.txt,fontSize:11,fontWeight:700,fontFamily:'monospace'}}>{cvt(sig.price,'KRW')}</div>
                      <div style={{color:T.muted,fontSize:9}}>×{sig.leverage} · SL {sig.sl}%</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </Card>

          {/* Emergency stop */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.red}30`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div><div style={{color:T.red,fontWeight:700}}>🚨 긴급 정지</div><div style={{color:T.muted,fontSize:10}}>모든 신호 처리 즉시 중단</div></div>
              <button onClick={()=>setRunning(false)} style={{background:T.red+'20',color:T.red,border:`1px solid ${T.red}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>정지</button>
            </div>
          </Card>
        </div>
      )}

      {/* ────── SETTINGS ────── */}
      {tab==='settings'&&(
        <div>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'9px 13px',marginBottom:14}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>⚠️ 설정 변경은 다음 신호부터 적용됩니다. 모의매매 전용.</div>
          </div>

          {/* Seed & basic */}
          {[
            {group:'💰 기본 설정', items:[
              {l:'자동매매 시드 (USDT)',k:'seed',min:100,max:100000,step:100},
              {l:'총 진입 비율 %',k:'totalPct',min:5,max:100,step:5},
              {l:'레버리지',k:'leverage',min:1,max:20,step:1},
            ]},
            {group:'📊 스케일인 설정', items:[
              {l:'1차 진입 %',k:'e1',min:10,max:80,step:5},
              {l:'2차 진입 %',k:'e2',min:10,max:80,step:5},
              {l:'3차 진입 %',k:'e3',min:10,max:80,step:5},
              {l:'추가진입 거리 %',k:'addDist',min:0.1,max:3,step:0.1},
            ]},
            {group:'⚙️ 거래 제어', items:[
              {l:'주간 목표 거래수',k:'weekTarget',min:1,max:50,step:1},
              {l:'재진입 제한 봉 수',k:'reentryBars',min:1,max:20,step:1},
            ]},
            {group:'🛡️ 리스크 설정', items:[
              {l:'횡보 손절 %',k:'rangeSL',min:0.5,max:5,step:0.1},
              {l:'추세 손절 %',k:'trendSL',min:0.5,max:5,step:0.1},
              {l:'횡보 트레일 %',k:'rangeTrail',min:0.3,max:3,step:0.1},
              {l:'추세 트레일 %',k:'trendTrail',min:0.5,max:5,step:0.1},
              {l:'본절 이동 %',k:'be',min:0.1,max:2,step:0.1},
              {l:'익절 감시 %',k:'weakExit',min:0.1,max:2,step:0.1},
              {l:'목표 %',k:'target',min:1,max:10,step:0.5},
            ]},
          ].map(grp=>(
            <Card key={grp.group} style={{padding:'14px 16px',marginBottom:10}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>{grp.group}</div>
              {grp.items.map((item,i)=>(
                <div key={item.k} style={{marginBottom:i<grp.items.length-1?12:0}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                    <span style={{color:T.sub,fontSize:12}}>{item.l}</span>
                    <span style={{color:T.acl,fontWeight:800,fontSize:12,fontFamily:'monospace'}}>{(settings as any)[item.k]}</span>
                  </div>
                  <input type="range" min={item.min} max={item.max} step={item.step} value={(settings as any)[item.k]} onChange={e=>updateSetting(item.k as keyof WunderSettings,+e.target.value)} style={{width:'100%',accentColor:T.acl}}/>
                </div>
              ))}
            </Card>
          ))}

          {/* Toggles */}
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🔀 스위치</div>
            {[
              {l:'주말 차단',k:'blockWeekend',d:'토·일 신호 무시'},
              {l:'반대신호 EXIT-ALL',k:'oppExit',d:'반대 신호 발생 시 전체 청산'},
            ].map((sw,i)=>(
              <div key={sw.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<1?`1px solid ${T.border}`:'none'}}>
                <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{sw.l}</div><div style={{color:T.muted,fontSize:10}}>{sw.d}</div></div>
                <Toggle on={(settings as any)[sw.k]} onChange={v=>updateSetting(sw.k as keyof WunderSettings,v)}/>
              </div>
            ))}
          </Card>

          {/* High leverage warning */}
          {settings.leverage>5&&(
            <div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:10,padding:'10px 14px'}}>
              <div style={{color:T.red,fontWeight:700,fontSize:12,marginBottom:3}}>⚠️ 고레버리지 경고</div>
              <div style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{settings.leverage}배 레버리지는 매우 위험합니다. 작은 가격 변동에도 원금 손실 위험이 큽니다. 경험이 없다면 1~3배를 권장합니다.</div>
            </div>
          )}
        </div>
      )}

      {/* ────── LOGIC ────── */}
      {tab==='logic'&&(
        <div>
          {[
            {icon:'📊',title:'추세 감지',color:T.acl,desc:'EMA20 > EMA50 > EMA200 일 때 상승추세, 반대는 하락추세, 그 외는 횡보입니다. 상위 타임프레임(1D) EMA200도 필터로 사용합니다.'},
            {icon:'📏',title:'횡보 구간 감지',color:T.ylw,desc:'최근 50봉의 최고가/최저가 범위가 5% 미만이면 횡보(레인지) 구간으로 판단합니다. 횡보 구간에서는 범위 돌파 전략을 적용합니다.'},
            {icon:'↩️',title:'풀백 진입',color:T.grn,desc:'추세 중 EMA20 재터치(골든/데드크로스)를 기다립니다. RSI 40~70 필터, ADX 20+ 필터, 거래량 확인 후 진입합니다.'},
            {icon:'💥',title:'브레이크아웃 진입',color:T.prp,desc:'횡보 구간 고점/저점 돌파 시 진입합니다. 거래량 급증(평균의 1.2배 이상)과 ADX 강도 확인이 필요합니다.'},
            {icon:'📈',title:'3단계 스케일인',color:T.ylw,desc:`1차 ${settings.e1}%, 2차 ${settings.e2}%, 3차 ${settings.e3}% 비율로 분할 진입합니다. 2차는 평균가 -${settings.addDist}%, 3차는 -${settings.addDist*2}% 이탈 시 추가 진입합니다.`},
            {icon:'🛑',title:'손절 로직',color:T.red,desc:`횡보 구간: ${settings.rangeSL}% 손절, 추세 구간: ${settings.trendSL}% 손절을 적용합니다. 평균 진입가 기준으로 계산합니다.`},
            {icon:'🏃',title:'트레일링 스탑',color:T.cyn,desc:`횡보: ${settings.rangeTrail}% 트레일, 추세: ${settings.trendTrail}% 트레일을 적용합니다. 가격이 유리하게 움직이면 손절가를 자동으로 따라 올립니다.`},
            {icon:'📍',title:'본절 이동',color:T.grn,desc:`수익이 ${settings.be}% 이상 발생하면 손절가를 진입가(본절)로 이동합니다. 리스크를 제거하는 핵심 기능입니다.`},
            {icon:'🔴',title:'연속 손실 보호',color:T.red,desc:'3회 연속 손실 발생 시 봇이 자동으로 거래를 중단합니다. 다음 수익 발생 시 초기화됩니다.'},
            {icon:'📅',title:'주간 자동 튜닝',color:T.prp,desc:`매주 초기화 시 주간 거래 횟수를 초기화합니다. 목표: 주 ${settings.weekTarget}회 신호. 초과 시 신규 진입 차단합니다.`},
            {icon:'🏖',title:'주말 차단',color:T.ylw,desc:settings.blockWeekend?'토요일·일요일은 신호를 무시합니다. 유동성이 낮은 주말 거래를 방지합니다.':'현재 주말 차단이 비활성화되어 있습니다.'},
            {icon:'↩️',title:'반대신호 청산',color:T.red,desc:settings.oppExit?'반대 방향 신호가 발생하면 기존 포지션을 전부 청산 후 반전합니다. 트렌드 전환에 빠르게 대응합니다.':'현재 반대신호 청산이 비활성화되어 있습니다.'},
          ].map((item,i)=>(
            <Card key={i} style={{padding:'13px 15px',marginBottom:8,border:`1px solid ${item.color}15`}}>
              <div style={{display:'flex',gap:8}}>
                <span style={{fontSize:20,flexShrink:0}}>{item.icon}</span>
                <div>
                  <div style={{color:item.color,fontWeight:700,fontSize:12,marginBottom:4}}>{item.title}</div>
                  <div style={{color:T.sub,fontSize:11,lineHeight:1.6}}>{item.desc}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ────── WEBHOOK ────── */}
      {tab==='webhook'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.acl}30`}}>
            <div style={{color:T.acl,fontWeight:700,marginBottom:10}}>🔗 TradingView → TRAIGO 웹훅 설정</div>
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {[
                {step:'1',title:'TradingView 알림 생성',desc:'전략 차트에서 "알림 추가" → 조건: strategy.order 발생 시'},
                {step:'2',title:'Webhook URL 설정',desc:'알림 → 웹훅 URL에 아래 TRAIGO 주소 입력'},
                {step:'3',title:'메시지에 JSON 입력',desc:'아래 JSON 템플릿을 알림 메시지에 붙여넣기'},
                {step:'4',title:'WunderTrading 봇 코드',desc:'WunderTrading에서 봇 생성 후 BTCWUNDER 코드 사용'},
              ].map(s=>(
                <div key={s.step} style={{display:'flex',gap:10}}>
                  <div style={{width:24,height:24,borderRadius:8,background:T.acl,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:900,color:'#fff',flexShrink:0}}>{s.step}</div>
                  <div><div style={{color:T.txt,fontSize:12,fontWeight:700}}>{s.title}</div><div style={{color:T.muted,fontSize:10,marginTop:2}}>{s.desc}</div></div>
                </div>
              ))}
            </div>
          </Card>

          {/* TRAIGO webhook URL */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:8}}>📡 TRAIGO 웹훅 URL</div>
            <div style={{display:'flex',gap:8,marginBottom:4}}>
              <div style={{flex:1,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',fontFamily:'monospace',fontSize:10,color:T.acl,wordBreak:'break-all'}}>
                https://your-domain.vercel.app/api/webhook/tradingview
              </div>
              <button onClick={()=>copyText('https://your-domain.vercel.app/api/webhook/tradingview','url')} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'0 12px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{copied==='url'?'✅':'복사'}</button>
            </div>
            <div style={{color:T.muted,fontSize:9}}>* Vercel 배포 후 실제 도메인으로 교체하세요</div>
          </Card>

          {/* Webhook templates */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📋 JSON 알림 템플릿</div>
            <div style={{marginBottom:8}}>
              <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>봇 코드 (WunderTrading)</div>
              <div style={{display:'flex',gap:8}}>
                <input value={wunderCode} onChange={e=>setWunderCode(e.target.value)} style={{flex:1,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:12,fontFamily:'monospace',fontWeight:700,outline:'none'}}/>
              </div>
            </div>
            {Object.entries(WEBHOOK_TEMPLATES).map(([key,json])=>{
              const label=key==='openLong'?'롱 진입':key==='openShort'?'숏 진입':'전체 청산';
              const clr=key==='openLong'?T.grn:key==='openShort'?T.red:T.muted;
              return (
                <div key={key} style={{marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                    <span style={{background:`${clr}20`,color:clr,fontSize:10,fontWeight:700,padding:'2px 8px',borderRadius:6}}>{label}</span>
                    <button onClick={()=>copyText(json.replace('BTCWUNDER',wunderCode),key)} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:6,padding:'3px 8px',fontSize:10,cursor:'pointer'}}>{copied===key?'✅':'복사'}</button>
                  </div>
                  <div style={{background:'#030610',borderRadius:8,padding:'10px 12px',fontFamily:'monospace',fontSize:10,color:T.grn,lineHeight:1.7,overflowX:'auto',whiteSpace:'pre'}}>{json.replace('BTCWUNDER',wunderCode)}</div>
                </div>
              );
            })}
          </Card>

          {/* Exchange connection */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.ylw}30`}}>
            <div style={{color:T.ylw,fontWeight:700,marginBottom:10}}>⚠️ 실제 거래소 연결 (플레이스홀더)</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
              {['Gate.io','Binance','Bybit','WunderTrading'].map(ex=>(
                <div key={ex} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 12px'}}>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{ex}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:2}}>API 연동 준비중</div>
                  <div style={{color:T.ylw,fontSize:9,marginTop:3}}>⚠️ 실거래 미지원</div>
                </div>
              ))}
            </div>
            <div style={{marginTop:10,color:T.muted,fontSize:10,lineHeight:1.5}}>실제 거래소 연동은 계좌연결 탭에서 API 키를 먼저 설정하세요. 현재 모든 신호는 모의매매로만 처리됩니다.</div>
          </Card>
        </div>
      )}

      {/* ────── PINE SCRIPT ────── */}
      {tab==='pine'&&(
        <div>
          <div style={{background:T.grn+'12',border:`1px solid ${T.grn}30`,borderRadius:10,padding:'9px 13px',marginBottom:12}}>
            <div style={{color:T.grn,fontWeight:700,fontSize:11}}>📜 BTC WUNDER AUTO COMPLETE FINAL — Pine Script v5</div>
            <div style={{color:T.muted,fontSize:10,marginTop:2}}>TradingView에서 새 전략 스크립트를 만들고 아래 코드를 붙여넣으세요.</div>
          </div>

          <div style={{display:'flex',gap:8,marginBottom:12}}>
            <button onClick={()=>copyText(PINE_SCRIPT,'pine')} style={{flex:1,padding:'11px',background:T.grn+'20',color:T.grn,border:`1px solid ${T.grn}40`,borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer'}}>{copied==='pine'?'✅ 복사됨!':'📋 Pine Script 전체 복사'}</button>
            <button onClick={()=>setShowPine(v=>!v)} style={{padding:'11px 14px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:12,fontWeight:700,fontSize:11,cursor:'pointer'}}>{showPine?'접기':'펼치기'}</button>
          </div>

          {showPine&&(
            <div style={{background:'#030610',borderRadius:12,padding:'14px',fontFamily:'monospace',fontSize:10,color:'#50FA7B',lineHeight:1.7,overflowX:'auto',maxHeight:500,overflowY:'auto',border:`1px solid ${T.grn}30`,whiteSpace:'pre'}}>
              {PINE_SCRIPT}
            </div>
          )}

          {/* Settings summary for Pine */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>⚙️ 현재 설정값 → Pine Script 반영</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
              {[
                {l:'시드',v:`${settings.seed} USDT`},
                {l:'진입 비율',v:`${settings.totalPct}%`},
                {l:'레버리지',v:`${settings.leverage}x`},
                {l:'1/2/3차 비율',v:`${settings.e1}/${settings.e2}/${settings.e3}%`},
                {l:'추세 손절',v:`${settings.trendSL}%`},
                {l:'목표',v:`${settings.target}%`},
              ].map(r=>(
                <div key={r.l} style={{background:T.alt,borderRadius:7,padding:'7px 9px'}}>
                  <div style={{color:T.muted,fontSize:9}}>{r.l}</div>
                  <div style={{color:T.acl,fontSize:11,fontWeight:700,fontFamily:'monospace',marginTop:1}}>{r.v}</div>
                </div>
              ))}
            </div>
            <div style={{color:T.muted,fontSize:10,marginTop:8}}>💡 설정 탭에서 값을 변경하면 Pine Script의 input 기본값에 반영하세요.</div>
          </Card>
        </div>
      )}

      {/* Real trading warning modal */}
      {showRealWarning&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.8)',zIndex:200}} onClick={()=>setShowRealWarning(false)}/>
          <div style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:201,background:T.surf,borderRadius:20,padding:'24px 20px',width:320,border:`2px solid ${T.red}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:T.red,fontWeight:800,fontSize:16,marginBottom:8}}>⚠️ 실전 모드 비활성화</div>
            <div style={{color:T.sub,fontSize:12,lineHeight:1.6,marginBottom:16}}>TRAIGO는 현재 실제 거래 실행을 지원하지 않습니다. 모든 신호는 모의매매로만 처리됩니다.</div>
            <button onClick={()=>setShowRealWarning(false)} style={{width:'100%',padding:'12px',background:T.muted+'20',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>확인</button>
          </div>
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   TRAIGO INTELLIGENCE — 헤지펀드급 인텔리전스 엔진
   ══════════════════════════════════════════════════════════════════ */

/* ─── Market Regime Types ─── */
type MarketRegime =
  | 'strong_bull' | 'weak_bull' | 'strong_bear' | 'weak_bear'
  | 'range' | 'high_vol_panic' | 'low_vol_compression';

type RiskLevel = 'safe' | 'caution' | 'danger' | 'extreme';
type Session   = 'asia' | 'london' | 'newyork' | 'overlap_al' | 'overlap_ln' | 'weekend';

interface RegimeState {
  regime: MarketRegime;
  confidence: number;
  recStrategy: string;
  recLeverage: number;
  riskScore: number;
  riskLevel: RiskLevel;
  updatedAt: string;
}

interface StrategyAlloc {
  id: string; name: string; type: string;
  enabled: boolean; capitalPct: number;
  leverage: number; pnl: number; winRate: number;
  sharpe: number; maxDD: number; trades: number;
  score: number; color: string;
}

interface OnchainData {
  fundingRate: number;       // %  positive = longs paying
  openInterest: number;      // bn USD
  longShortRatio: number;    // > 1 means more longs
  exchangeReserve: number;   // BTC on exchanges
  stablecoinSupply: number;  // bn USDT
  fearGreed: number;         // 0-100
  btcDominance: number;      // %
}

interface WhaleSignal {
  type: 'inflow' | 'outflow' | 'stable_move' | 'wallet';
  amount: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  time: string;
  note: string;
}

interface CorrelationData {
  pair: string;
  corr: number;  // -1 to +1
  impact: string;
  action: string;
}

interface SessionFilter {
  id: Session; label: string; hours: string;
  active: boolean; enabled: boolean; volatility: string; color: string;
}

/* ─── Static mock data ─── */
const MOCK_REGIME: RegimeState = {
  regime: 'weak_bull', confidence: 72, recStrategy: 'EMA 추세 추종 (풀백 진입)',
  recLeverage: 3, riskScore: 38, riskLevel: 'caution', updatedAt: '09:32:14',
};

const MOCK_ONCHAIN: OnchainData = {
  fundingRate: 0.008, openInterest: 14.2, longShortRatio: 1.34,
  exchangeReserve: 2.41, stablecoinSupply: 148.6, fearGreed: 62, btcDominance: 54.2,
};

const MOCK_WHALES: WhaleSignal[] = [
  {type:'outflow',amount:'8,400 BTC',sentiment:'bullish',time:'2h 전',note:'대형 거래소 → 개인 지갑 출금 (장기 보유 신호)'},
  {type:'inflow',amount:'2,100 BTC',sentiment:'bearish',time:'5h 전',note:'개인 지갑 → 거래소 입금 (매도 준비 가능)'},
  {type:'stable_move',amount:'$320M USDT',sentiment:'bullish',time:'8h 전',note:'Tether 신규 발행 → 시장 유동성 증가'},
];

const MOCK_CORRELATIONS: CorrelationData[] = [
  {pair:'BTC ↔ NASDAQ',corr:0.71,impact:'나스닥 하락 시 BTC 하락 가능',action:'나스닥 -1.5% 이상 시 레버리지 축소'},
  {pair:'BTC ↔ DXY',corr:-0.58,impact:'달러 강세 시 BTC 약세',action:'DXY 상승 추세 시 롱 비중 감소'},
  {pair:'BTC ↔ Gold',corr:0.42,impact:'금 상승 시 BTC 안전자산 수요',action:'금 강세 시 BTC 장투 비중 증가'},
  {pair:'ETH ↔ BTC',corr:0.88,impact:'BTC 하락 시 ETH도 하락',action:'BTC 추세 전환 시 ETH 포지션 정리'},
  {pair:'알트 ↔ BTC 도미넌스',corr:-0.79,impact:'도미넌스 상승 시 알트 약세',action:`BTC 도미 ${MOCK_ONCHAIN.btcDominance}% → 알트 노출 축소 권고`},
];

const REGIME_INFO: Record<MarketRegime, {label:string;color:string;icon:string;desc:string}> = {
  strong_bull:       {label:'강한 상승추세', color:'#10B981',icon:'🚀',desc:'EMA 골든크로스, ADX 강세, 거래량 증가'},
  weak_bull:         {label:'약한 상승추세', color:'#6EE7B7',icon:'📈',desc:'가격이 EMA200 위에 있지만 모멘텀 약화'},
  strong_bear:       {label:'강한 하락추세', color:'#EF4444',icon:'🔻',desc:'EMA 데드크로스, ADX 강세, 공포 확산'},
  weak_bear:         {label:'약한 하락추세', color:'#FCA5A5',icon:'📉',desc:'하락 중이지만 모멘텀 둔화, 반등 가능'},
  range:             {label:'횡보 구간',     color:'#F59E0B',icon:'↔️',desc:'범위 5% 이내, 레인지 전략 적합'},
  high_vol_panic:    {label:'고변동 패닉',   color:'#DC2626',icon:'⚠️',desc:'급격한 가격 변동, 진입 위험'},
  low_vol_compression:{label:'저변동 압축',  color:'#6366F1',icon:'🔒',desc:'변동성 수축, 큰 움직임 임박 가능'},
};

const RISK_INFO: Record<RiskLevel, {label:string;color:string;bg:string;desc:string}> = {
  safe:    {label:'안전',     color:'#10B981',bg:'#10B98115',desc:'정상 거래 가능, 기본 레버리지 유지'},
  caution: {label:'주의',     color:'#F59E0B',bg:'#F59E0B15',desc:'레버리지 절반으로 축소 권장'},
  danger:  {label:'위험',     color:'#EF4444',bg:'#EF444415',desc:'신규 진입 중단, 기존 포지션 축소'},
  extreme: {label:'극단 위험',color:'#DC2626',bg:'#DC262615',desc:'전체 포지션 청산 후 대기'},
};

const INITIAL_ALLOCS: StrategyAlloc[] = [
  {id:'sa1',name:'WUNDER EMA 추세',type:'trend',enabled:true,capitalPct:40,leverage:3,pnl:2.4,winRate:67,sharpe:1.82,maxDD:8.4,trades:18,score:78,color:'#3B82F6'},
  {id:'sa2',name:'RSI 반전 레인지',type:'range',enabled:true,capitalPct:25,leverage:1,pnl:1.1,winRate:58,sharpe:1.24,maxDD:4.2,trades:12,score:64,color:'#7C3AED'},
  {id:'sa3',name:'BTC DCA 적립',type:'dca',enabled:true,capitalPct:20,leverage:1,pnl:3.8,winRate:83,sharpe:2.14,maxDD:2.1,trades:24,score:89,color:'#10B981'},
  {id:'sa4',name:'브레이크아웃',type:'breakout',enabled:false,capitalPct:10,leverage:5,pnl:-0.8,winRate:44,sharpe:0.62,maxDD:12.1,trades:9,score:41,color:'#F59E0B'},
  {id:'sa5',name:'헤지 (BTC 롱·알트 숏)',type:'hedge',enabled:false,capitalPct:5,leverage:2,pnl:0.4,winRate:55,sharpe:0.91,maxDD:3.8,trades:6,score:52,color:'#EF4444'},
];

const INITIAL_SESSIONS: SessionFilter[] = [
  {id:'asia',   label:'아시아',    hours:'09:00–18:00 KST',active:false,enabled:true, volatility:'낮음', color:'#F59E0B'},
  {id:'london', label:'런던',      hours:'17:00–02:00 KST',active:true, enabled:true, volatility:'높음', color:'#3B82F6'},
  {id:'newyork',label:'뉴욕',      hours:'22:00–06:00 KST',active:true, enabled:true, volatility:'매우 높음',color:'#EF4444'},
  {id:'overlap_ln',label:'런던×NY',hours:'22:00–02:00 KST',active:true, enabled:true, volatility:'최고', color:'#7C3AED'},
  {id:'weekend',label:'주말',      hours:'토·일',            active:false,enabled:false,volatility:'낮음', color:'#475569'},
];

const MOCK_ECON_EVENTS = [
  {name:'FOMC 금리 결정',date:'2025-05-28 21:00',impact:'high',block:true},
  {name:'CPI 소비자물가',date:'2025-05-14 21:30',impact:'high',block:true},
  {name:'NFP 비농업고용',date:'2025-06-06 21:30',impact:'high',block:true},
  {name:'미국 소매판매',date:'2025-05-17 21:30',impact:'medium',block:false},
];

/* ══════════════════════════════════════════════════════════════════
   IntelligencePage Component
   ══════════════════════════════════════════════════════════════════ */
function IntelligencePage() {
  const [tab,setTab]=useState<'regime'|'alloc'|'onchain'|'whale'|'session'|'score'>('regime');
  const [regime]=useState<RegimeState>(MOCK_REGIME);
  const [onchain]=useState<OnchainData>(MOCK_ONCHAIN);
  const [allocs,setAllocs]=useState<StrategyAlloc[]>(INITIAL_ALLOCS);
  const [sessions,setSessions]=useState<SessionFilter[]>(INITIAL_SESSIONS);
  const [hedgeMode,setHedgeMode]=useState(false);
  const [recoveryMode,setRecoveryMode]=useState(false);
  const [profitProtect,setProfitProtect]=useState(true);
  const [blockEcon,setBlockEcon]=useState(true);
  const [circuitBreaker,setCircuitBreaker]=useState(true);

  const ri = REGIME_INFO[regime.regime];
  const riskI = RISK_INFO[regime.riskLevel];
  const totalCapital = allocs.filter(a=>a.enabled).reduce((s,a)=>s+a.capitalPct,0);
  const avgScore = Math.round(allocs.reduce((s,a)=>s+a.score,0)/allocs.length);

  const toggleAlloc=(id:string)=>setAllocs(p=>p.map(a=>a.id===id?{...a,enabled:!a.enabled}:a));
  const changeCapital=(id:string,v:number)=>setAllocs(p=>p.map(a=>a.id===id?{...a,capitalPct:v}:a));
  const toggleSession=(id:Session)=>setSessions(p=>p.map(s=>s.id===id?{...s,enabled:!s.enabled}:s));

  /* ── Gauge component ── */
  const Gauge=({value,max,color,label}:{value:number;max:number;color:string;label:string})=>(
    <div>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
        <span style={{color:T.muted,fontSize:10}}>{label}</span>
        <span style={{color,fontWeight:700,fontSize:10}}>{value}/{max}</span>
      </div>
      <div style={{height:6,background:'#1A2D4A',borderRadius:3,overflow:'hidden'}}>
        <div style={{height:'100%',width:`${Math.min(100,value/max*100)}%`,background:color,borderRadius:3,transition:'width .5s'}}/>
      </div>
    </div>
  );

  /* ── Score ring ── */
  const ScoreRing=({score,size=64}:{score:number;size?:number})=>{
    const c=score>=70?T.grn:score>=40?T.ylw:T.red;
    const r=26;const circ=2*Math.PI*r;const dash=circ*score/100;
    return (
      <div style={{position:'relative',width:size,height:size,flexShrink:0}}>
        <svg width={size} height={size} viewBox="0 0 64 64">
          <circle cx={32} cy={32} r={r} fill="none" stroke="#1A2D4A" strokeWidth={7}/>
          <circle cx={32} cy={32} r={r} fill="none" stroke={c} strokeWidth={7}
            strokeDasharray={`${dash} ${circ-dash}`} strokeLinecap="round"
            style={{transform:'rotate(-90deg)',transformOrigin:'32px 32px',transition:'stroke-dasharray .6s'}}/>
        </svg>
        <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:15,fontWeight:900,color:c}}>{score}</div>
      </div>
    );
  };

  return (
    <div>
      {/* Header */}
      <div style={{background:'linear-gradient(135deg,#06080F,#0A0F1E)',border:`1px solid ${T.acl}30`,borderRadius:18,padding:'14px 16px',marginBottom:14}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
          <div>
            <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:3}}>
              <span style={{fontSize:18}}>🧠</span>
              <span style={{color:T.txt,fontWeight:900,fontSize:15}}>TRAIGO Intelligence</span>
              <Bdg c={T.prp} ch="헤지펀드급"/>
            </div>
            <div style={{color:T.muted,fontSize:10}}>시장 국면 AI · 자금 배분 · 위험 분석 · 필터 시스템</div>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{background:riskI.bg,border:`1px solid ${riskI.color}50`,borderRadius:10,padding:'5px 10px'}}>
              <div style={{color:riskI.color,fontWeight:900,fontSize:11}}>{riskI.label}</div>
              <div style={{color:T.muted,fontSize:9}}>위험도 {regime.riskScore}/100</div>
            </div>
          </div>
        </div>
        {/* Quick status row */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
          {[
            {l:'시장 국면',v:ri.icon+' '+ri.label.split(' ')[0],c:ri.color},
            {l:'신뢰도',v:`${regime.confidence}%`,c:T.acl},
            {l:'권장 레버',v:`${regime.recLeverage}x`,c:regime.recLeverage>5?T.red:regime.recLeverage>2?T.ylw:T.grn},
            {l:'전략 점수',v:`${avgScore}/100`,c:avgScore>=70?T.grn:avgScore>=40?T.ylw:T.red},
          ].map(s=>(
            <div key={s.l} style={{background:'rgba(0,0,0,.4)',borderRadius:8,padding:'6px 7px',textAlign:'center'}}>
              <div style={{color:s.c,fontSize:11,fontWeight:800}}>{s.v}</div>
              <div style={{color:T.muted,fontSize:8,marginTop:1}}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:'flex',gap:5,marginBottom:14,overflowX:'auto'}}>
        {([['regime','🌐 시장국면'],['alloc','💰 자금배분'],['onchain','📊 온체인'],['whale','🐋 고래'],['session','⏰ 시간필터'],['score','🏆 전략점수']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'7px 11px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* ── REGIME ── */}
      {tab==='regime'&&(
        <div>
          {/* Regime card */}
          <div style={{background:`linear-gradient(135deg,${ri.color}18,${ri.color}05)`,border:`2px solid ${ri.color}40`,borderRadius:18,padding:'16px 18px',marginBottom:14}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
              <div>
                <div style={{fontSize:28,marginBottom:6}}>{ri.icon}</div>
                <div style={{color:ri.color,fontWeight:900,fontSize:18,marginBottom:3}}>{ri.label}</div>
                <div style={{color:T.muted,fontSize:11}}>{ri.desc}</div>
                <div style={{marginTop:8,color:T.txt,fontSize:11}}>📌 권장 전략: <span style={{color:ri.color,fontWeight:700}}>{regime.recStrategy}</span></div>
              </div>
              <ScoreRing score={regime.confidence}/>
            </div>
            <div style={{marginTop:12}}>
              <Gauge value={regime.riskScore} max={100} color={riskI.color} label={`위험도 — ${riskI.label}`}/>
            </div>
          </div>

          {/* All regimes */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📊 시장 국면 분류</div>
            {(Object.entries(REGIME_INFO) as [MarketRegime,any][]).map(([key,info])=>(
              <div key={key} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:`1px solid ${T.border}`,opacity:regime.regime===key?1:0.4}}>
                <span style={{fontSize:16,flexShrink:0}}>{info.icon}</span>
                <div style={{flex:1}}>
                  <div style={{color:regime.regime===key?T.txt:T.sub,fontSize:11,fontWeight:regime.regime===key?700:400}}>{info.label}</div>
                  <div style={{color:T.muted,fontSize:9}}>{info.desc}</div>
                </div>
                {regime.regime===key&&<Bdg c={info.color} ch={`${regime.confidence}%`}/>}
              </div>
            ))}
          </Card>

          {/* Cross-market correlations */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🔗 거래소간 상관관계</div>
            {MOCK_CORRELATIONS.map((c,i)=>{
              const corrColor=Math.abs(c.corr)>0.7?T.red:Math.abs(c.corr)>0.4?T.ylw:T.grn;
              const corrBar=Math.abs(c.corr)*100;
              return (
                <div key={i} style={{marginBottom:i<MOCK_CORRELATIONS.length-1?12:0}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:3}}>
                    <span style={{color:T.txt,fontSize:11,fontWeight:600}}>{c.pair}</span>
                    <span style={{color:corrColor,fontSize:11,fontWeight:800,fontFamily:'monospace'}}>{c.corr>0?'+':''}{c.corr.toFixed(2)}</span>
                  </div>
                  <div style={{height:4,background:'#1A2D4A',borderRadius:2,overflow:'hidden',marginBottom:4}}>
                    <div style={{height:'100%',width:`${corrBar}%`,background:corrColor,borderRadius:2}}/>
                  </div>
                  <div style={{color:T.muted,fontSize:9,lineHeight:1.4}}>💡 {c.action}</div>
                </div>
              );
            })}
          </Card>

          {/* Smart filters */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🛡️ 스마트 필터</div>
            {[
              {l:'경제지표 자동 차단',k:'blockEcon',v:blockEcon,fn:setBlockEcon,d:`CPI·FOMC·NFP 발표 ±30분 거래 중단`},
              {l:'변동성 서킷브레이커',k:'circuit',v:circuitBreaker,fn:setCircuitBreaker,d:'5분 변동성 3% 초과 시 신규 진입 차단'},
              {l:'헤지 모드',k:'hedge',v:hedgeMode,fn:setHedgeMode,d:'반대 방향 소규모 포지션으로 위험 상쇄'},
              {l:'복구 재진입 모드',k:'recovery',v:recoveryMode,fn:setRecoveryMode,d:'손실 후 포지션 크기 점진적 회복'},
              {l:'수익 보호 모드',k:'profit',v:profitProtect,fn:setProfitProtect,d:'누적 수익 10% 초과 시 레버리지 자동 축소'},
            ].map((s,i,arr)=>(
              <div key={s.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{s.l}</div><div style={{color:T.muted,fontSize:10,marginTop:1}}>{s.d}</div></div>
                <Toggle on={s.v} onChange={s.fn}/>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* ── ALLOCATION ── */}
      {tab==='alloc'&&(
        <div>
          {/* Capital summary */}
          <div style={{background:'linear-gradient(135deg,#060B14,#0D1628)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'14px 16px',marginBottom:14}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{color:T.txt,fontWeight:700}}>전략별 자금 배분</div>
              <Bdg c={totalCapital>100?T.red:T.grn} ch={`총 ${totalCapital}%`}/>
            </div>
            <div style={{height:8,background:'#1A2D4A',borderRadius:4,overflow:'hidden',marginBottom:4}}>
              {allocs.filter(a=>a.enabled).map(a=>(
                <div key={a.id} style={{display:'inline-block',height:'100%',width:`${a.capitalPct}%`,background:a.color,opacity:0.9}}/>
              ))}
            </div>
            <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:6}}>
              {allocs.filter(a=>a.enabled).map(a=>(
                <div key={a.id} style={{display:'flex',alignItems:'center',gap:3}}>
                  <div style={{width:7,height:7,borderRadius:2,background:a.color,flexShrink:0}}/>
                  <span style={{color:T.muted,fontSize:9}}>{a.name.split(' ')[0]} {a.capitalPct}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Strategy cards */}
          {allocs.map((a)=>(
            <Card key={a.id} style={{padding:'14px',marginBottom:10,border:`1px solid ${a.enabled?a.color+'30':T.border}`,opacity:a.enabled?1:0.55}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <ScoreRing score={a.score} size={44}/>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:13}}>{a.name}</div>
                    <div style={{display:'flex',gap:4,marginTop:3,flexWrap:'wrap'}}>
                      <Bdg c={a.color} ch={a.type}/>
                      <Bdg c={a.winRate>=70?T.grn:a.winRate>=50?T.ylw:T.red} ch={`승률 ${a.winRate}%`}/>
                      <Bdg c={T.muted} ch={`샤프 ${a.sharpe}`}/>
                    </div>
                  </div>
                </div>
                <Toggle on={a.enabled} onChange={()=>toggleAlloc(a.id)}/>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,marginBottom:10}}>
                {[{l:'PnL',v:`${a.pnl>=0?'+':''}${a.pnl}%`,c:a.pnl>=0?T.grn:T.red},{l:'최대DD',v:`${a.maxDD}%`,c:T.red},{l:'거래수',v:`${a.trades}건`,c:T.muted}].map(m=>(
                  <div key={m.l} style={{background:T.alt,borderRadius:7,padding:'6px 8px',textAlign:'center'}}>
                    <div style={{color:m.c,fontSize:11,fontWeight:700}}>{m.v}</div>
                    <div style={{color:T.muted,fontSize:8,marginTop:1}}>{m.l}</div>
                  </div>
                ))}
              </div>
              {a.enabled&&(
                <div>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                    <span style={{color:T.muted,fontSize:10}}>자본 배분</span>
                    <span style={{color:a.color,fontWeight:800,fontSize:10}}>{a.capitalPct}%</span>
                  </div>
                  <input type="range" min={5} max={60} step={5} value={a.capitalPct} onChange={e=>changeCapital(a.id,+e.target.value)} style={{width:'100%',accentColor:a.color}}/>
                </div>
              )}
            </Card>
          ))}

          {/* AI suggestion */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.prp}30`}}>
            <div style={{color:T.prp,fontWeight:700,marginBottom:8}}>🤖 AI 자금 배분 추천</div>
            <div style={{color:T.sub,fontSize:11,lineHeight:1.6}}>
              현재 <strong style={{color:T.ylw}}>약한 상승추세</strong> 구간입니다.<br/>
              📌 DCA 적립 비중을 높이고, 브레이크아웃 전략은 비활성화를 권장합니다.<br/>
              📌 헤지 모드 소규모 활성화로 하락 리스크를 상쇄하세요.<br/>
              ⚠️ AI 추천은 참고용이며 수익을 보장하지 않습니다.
            </div>
          </Card>
        </div>
      )}

      {/* ── ONCHAIN ── */}
      {tab==='onchain'&&(
        <div>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'9px 13px',marginBottom:12}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>📊 온체인 데이터 — 참고용 · 수익 보장 없음</div>
          </div>

          {/* Funding rate */}
          <Card style={{padding:'14px 16px',marginBottom:10,border:`1px solid ${onchain.fundingRate>0.05?T.red:T.border}20`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
              <div style={{color:T.txt,fontWeight:700}}>💰 펀딩비 (Funding Rate)</div>
              <span style={{color:onchain.fundingRate>0.05?T.red:onchain.fundingRate>0.01?T.ylw:T.grn,fontWeight:900,fontSize:16,fontFamily:'monospace'}}>{onchain.fundingRate>0?'+':''}{onchain.fundingRate.toFixed(3)}%</span>
            </div>
            <div style={{height:6,background:'#1A2D4A',borderRadius:3,overflow:'hidden',marginBottom:6}}>
              <div style={{height:'100%',width:`${Math.min(100,Math.abs(onchain.fundingRate)/0.1*100)}%`,background:onchain.fundingRate>0.05?T.red:onchain.fundingRate>0.01?T.ylw:T.grn,borderRadius:3}}/>
            </div>
            <div style={{color:T.muted,fontSize:10}}>
              {onchain.fundingRate>0.05?'⚠️ 펀딩비 과열 — 롱 포지션 비용 급증. 신규 롱 진입 주의':onchain.fundingRate>0.01?'💡 보통 — 정상 범위 내':onchain.fundingRate<-0.01?'📉 음수 펀딩비 — 숏 과열 구간':'✅ 정상 펀딩비'}
            </div>
          </Card>

          {/* All onchain metrics */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
            {[
              {l:'BTC 미결제약정',v:`$${onchain.openInterest}B`,sub:'오픈 인터레스트',c:onchain.openInterest>20?T.red:T.ylw,icon:'📋'},
              {l:'롱/숏 비율',v:`${onchain.longShortRatio}:1`,sub:onchain.longShortRatio>1.3?'롱 과열 주의':'균형 유지',c:onchain.longShortRatio>1.3?T.red:T.grn,icon:'⚖️'},
              {l:'거래소 BTC 보유',v:`${onchain.exchangeReserve}M BTC`,sub:'감소 = 보유 증가',c:T.acl,icon:'🏦'},
              {l:'스테이블코인',v:`$${onchain.stablecoinSupply}B`,sub:'매수 여력 지표',c:T.grn,icon:'💵'},
              {l:'공포탐욕 지수',v:`${onchain.fearGreed}`,sub:onchain.fearGreed>75?'탐욕':onchain.fearGreed>50?'중립':'공포',c:onchain.fearGreed>75?T.red:onchain.fearGreed>50?T.ylw:T.grn,icon:'😰'},
              {l:'BTC 도미넌스',v:`${onchain.btcDominance}%`,sub:onchain.btcDominance>55?'알트 약세 주의':'알트 기회',c:onchain.btcDominance>55?T.ylw:T.grn,icon:'👑'},
            ].map(m=>(
              <Card key={m.l} style={{padding:'12px 12px'}}>
                <div style={{fontSize:18,marginBottom:4}}>{m.icon}</div>
                <div style={{color:m.c,fontSize:16,fontWeight:900,fontFamily:'monospace'}}>{m.v}</div>
                <div style={{color:T.muted,fontSize:9,marginTop:2}}>{m.l}</div>
                <div style={{color:m.c,fontSize:9,marginTop:1,fontWeight:600}}>{m.sub}</div>
              </Card>
            ))}
          </div>

          {/* Liquidation map placeholder */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.prp}30`}}>
            <div style={{color:T.prp,fontWeight:700,marginBottom:8}}>🗺 청산 맵 (준비중)</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6}}>주요 레버리지 청산 집중 구간을 시각화합니다. Coinglass API 연동 후 활성화됩니다.</div>
            <div style={{display:'flex',gap:6,marginTop:10}}>
              {['$88M 롱 청산','$3B 숏 청산','청산 히트맵'].map(t=>(
                <div key={t} style={{background:T.alt,borderRadius:8,padding:'7px 10px',fontSize:9,color:T.muted}}>{t}</div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── WHALE ── */}
      {tab==='whale'&&(
        <div>
          <div style={{background:T.acl+'12',border:`1px solid ${T.acl}30`,borderRadius:10,padding:'9px 13px',marginBottom:12}}>
            <div style={{color:T.acl,fontWeight:700,fontSize:11}}>🐋 고래 움직임 추적 — 참고용 데이터 · 수익 보장 없음</div>
          </div>

          {/* Whale signals */}
          {MOCK_WHALES.map((w,i)=>{
            const sc=w.sentiment==='bullish'?T.grn:w.sentiment==='bearish'?T.red:T.muted;
            const typeLabel=w.type==='inflow'?'거래소 입금':w.type==='outflow'?'거래소 출금':w.type==='stable_move'?'스테이블코인 이동':'지갑 활동';
            return (
              <Card key={i} style={{padding:'14px 16px',marginBottom:10,border:`1px solid ${sc}25`}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
                  <div>
                    <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:3}}>
                      <span style={{background:`${sc}20`,color:sc,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99}}>{typeLabel}</span>
                      <span style={{color:T.muted,fontSize:10}}>{w.time}</span>
                    </div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:14,fontFamily:'monospace'}}>{w.amount}</div>
                  </div>
                  <span style={{background:`${sc}20`,color:sc,fontSize:10,fontWeight:700,padding:'4px 9px',borderRadius:8}}>{w.sentiment==='bullish'?'강세':'약세'}</span>
                </div>
                <div style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{w.note}</div>
              </Card>
            );
          })}

          {/* Whale composite */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📊 고래 종합 신호</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {[
                {l:'거래소 흐름',v:'순 출금',sub:'보유 증가 중',c:T.grn},
                {l:'스테이블',v:'순 증가',sub:'매수 여력 확대',c:T.grn},
                {l:'종합 신호',v:'중립-강세',sub:'추세 확인 필요',c:T.ylw},
              ].map(m=>(
                <div key={m.l} style={{background:T.alt,borderRadius:10,padding:'10px 8px',textAlign:'center'}}>
                  <div style={{color:m.c,fontSize:12,fontWeight:700}}>{m.v}</div>
                  <div style={{color:T.muted,fontSize:8,marginTop:2}}>{m.l}</div>
                  <div style={{color:m.c,fontSize:8,marginTop:1}}>{m.sub}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* News filter */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.red}25`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{color:T.txt,fontWeight:700}}>📰 경제지표 자동 차단</div>
              <Toggle on={blockEcon} onChange={setBlockEcon}/>
            </div>
            {MOCK_ECON_EVENTS.map((ev,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'7px 0',borderBottom:i<MOCK_ECON_EVENTS.length-1?`1px solid ${T.border}`:'none'}}>
                <div>
                  <div style={{color:ev.impact==='high'?T.red:T.ylw,fontSize:10,fontWeight:700}}>{ev.name}</div>
                  <div style={{color:T.muted,fontSize:9}}>{ev.date}</div>
                </div>
                <Bdg c={ev.block?T.red:T.muted} ch={ev.block?'차단':'허용'}/>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* ── SESSION ── */}
      {tab==='session'&&(
        <div>
          <div style={{background:T.acl+'12',border:`1px solid ${T.acl}30`,borderRadius:10,padding:'9px 13px',marginBottom:12}}>
            <div style={{color:T.acl,fontWeight:700,fontSize:11}}>⏰ 시간대별 전략 ON/OFF 필터</div>
          </div>

          {sessions.map((s,i)=>(
            <Card key={s.id} style={{padding:'14px 16px',marginBottom:8,border:`1px solid ${s.enabled&&s.active?s.color:T.border}30`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <div style={{width:10,height:10,borderRadius:'50%',background:s.active?s.color:'#1A2D4A',boxShadow:s.active?`0 0 6px ${s.color}80`:undefined}}/>
                  <div>
                    <div style={{display:'flex',gap:5,alignItems:'center'}}>
                      <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{s.label} 세션</span>
                      {s.active&&<Bdg c={s.color} ch="현재"/>}
                    </div>
                    <div style={{color:T.muted,fontSize:10}}>{s.hours} · 변동성 {s.volatility}</div>
                  </div>
                </div>
                <Toggle on={s.enabled} onChange={()=>toggleSession(s.id)}/>
              </div>
              <div style={{height:4,background:'#1A2D4A',borderRadius:2,overflow:'hidden'}}>
                <div style={{height:'100%',width:s.enabled?'100%':'0%',background:s.color,borderRadius:2,transition:'width .4s'}}/>
              </div>
            </Card>
          ))}

          {/* Volatility circuit breaker */}
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${circuitBreaker?T.grn:T.border}30`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
              <div><div style={{color:T.txt,fontWeight:700}}>⚡ 변동성 서킷브레이커</div><div style={{color:T.muted,fontSize:10}}>5분 변동성 3% 초과 시 신규 진입 차단</div></div>
              <Toggle on={circuitBreaker} onChange={setCircuitBreaker}/>
            </div>
            {circuitBreaker&&(
              <div style={{background:T.grn+'12',borderRadius:8,padding:'8px 12px'}}>
                <div style={{color:T.grn,fontSize:10,fontWeight:700}}>✅ 현재 변동성 정상 — 진입 허용</div>
                <div style={{color:T.muted,fontSize:9,marginTop:2}}>5m 변동성: 0.84% / 임계값: 3.00%</div>
              </div>
            )}
          </Card>

          {/* Recovery & profit modes */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🛡️ 리스크 보호 모드</div>
            {[
              {l:'복구 재진입 모드',v:recoveryMode,fn:setRecoveryMode,d:'연속 손실 후 포지션 크기 50%→75%→100% 점진적 복구',c:T.cyn},
              {l:'수익 보호 모드',v:profitProtect,fn:setProfitProtect,d:'주간 수익 5% 이상 시 레버리지 자동 절반 감소',c:T.ylw},
              {l:'헤지 모드',v:hedgeMode,fn:setHedgeMode,d:'위험 구간에서 역방향 소규모 포지션으로 리스크 분산',c:T.prp},
            ].map((s,i,arr)=>(
              <div key={s.l} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center'}}><div style={{width:8,height:8,borderRadius:'50%',background:s.v?s.c:T.muted}}/><span style={{color:T.txt,fontSize:12,fontWeight:600}}>{s.l}</span></div>
                  <div style={{color:T.muted,fontSize:10,marginTop:2,marginLeft:13}}>{s.d}</div>
                </div>
                <Toggle on={s.v} onChange={s.fn}/>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* ── SCORE ── */}
      {tab==='score'&&(
        <div>
          {/* Overall score */}
          <div style={{background:'linear-gradient(135deg,#060B14,#0A0F1E)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
              <div>
                <div style={{color:T.txt,fontWeight:800,fontSize:15}}>전략 종합 점수</div>
                <div style={{color:T.muted,fontSize:10}}>수익성·일관성·드로다운 종합</div>
              </div>
              <ScoreRing score={avgScore} size={70}/>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
              {[
                {l:'수익성',v:72,c:T.grn},{l:'일관성',v:68,c:T.acl},
                {l:'드로다운',v:84,c:T.ylw},{l:'회복력',v:61,c:T.prp},
              ].map(s=>(
                <div key={s.l}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
                    <span style={{color:T.muted,fontSize:9}}>{s.l}</span>
                    <span style={{color:s.c,fontSize:9,fontWeight:700}}>{s.v}</span>
                  </div>
                  <div style={{height:4,background:'#1A2D4A',borderRadius:2}}><div style={{height:'100%',width:`${s.v}%`,background:s.c,borderRadius:2}}/></div>
                </div>
              ))}
            </div>
          </div>

          {/* Per-strategy scores */}
          {[...allocs].sort((a,b)=>b.score-a.score).map((a,i)=>(
            <Card key={a.id} style={{padding:'14px 16px',marginBottom:8,border:`1px solid ${a.color}20`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <div style={{width:26,height:26,borderRadius:8,background:`linear-gradient(135deg,${i===0?T.gld:i===1?'#94A3B8':i===2?'#C2410C':T.alt},${T.alt})`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:900,color:'#fff',flexShrink:0}}>{i+1}</div>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{a.name}</div>
                    <div style={{display:'flex',gap:4,marginTop:2}}>
                      <Bdg c={a.color} ch={a.type}/>
                      {!a.enabled&&<Bdg c={T.muted} ch="비활성"/>}
                    </div>
                  </div>
                </div>
                <ScoreRing score={a.score} size={44}/>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:5}}>
                {[{l:'PnL',v:`${a.pnl>=0?'+':''}${a.pnl}%`,c:a.pnl>=0?T.grn:T.red},{l:'샤프',v:a.sharpe,c:a.sharpe>1.5?T.grn:T.ylw},{l:'승률',v:`${a.winRate}%`,c:a.winRate>=70?T.grn:T.ylw},{l:'MDD',v:`${a.maxDD}%`,c:T.red}].map(m=>(
                  <div key={m.l} style={{background:T.alt,borderRadius:6,padding:'5px 6px',textAlign:'center'}}>
                    <div style={{color:m.c,fontSize:10,fontWeight:700}}>{m.v}</div>
                    <div style={{color:T.muted,fontSize:8,marginTop:1}}>{m.l}</div>
                  </div>
                ))}
              </div>
              {/* Score bar */}
              <div style={{marginTop:8}}>
                <div style={{height:4,background:'#1A2D4A',borderRadius:2,overflow:'hidden'}}>
                  <div style={{height:'100%',width:`${a.score}%`,background:a.score>=70?T.grn:a.score>=40?T.ylw:T.red,borderRadius:2,transition:'width .6s'}}/>
                </div>
              </div>
            </Card>
          ))}

          {/* AI suggestion box */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.prp}30`}}>
            <div style={{color:T.prp,fontWeight:700,marginBottom:8}}>🤖 AI 전략 어시스턴트</div>
            {[
              '현재 시장 조건은 추세 추종 전략에 유리합니다.',
              '펀딩비가 과열 구간에 근접 중 — 롱 포지션 비용 증가.',
              'BTC 도미넌스 상승 중 — 알트코인 노출 축소 권장.',
              'DCA 전략이 가장 높은 점수를 기록 중입니다.',
              '브레이크아웃 전략 승률이 50% 이하 — 비활성화 권장.',
            ].map((msg,i)=>(
              <div key={i} style={{display:'flex',gap:6,padding:'5px 0',borderBottom:i<4?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.prp,flexShrink:0,fontSize:11}}>💡</span>
                <span style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{msg}</span>
              </div>
            ))}
            <div style={{color:T.muted,fontSize:9,marginTop:8}}>⚠️ AI 분석은 교육·참고 목적이며 수익을 보장하지 않습니다.</div>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ── Navigation tabs ── */
const BTABS=[
  {id:'home',label:'홈',icon:'🏠'},{id:'watchlist',label:'왓치',icon:'⭐'},
  {id:'market',label:'시장',icon:'📊'},{id:'trading',label:'매매',icon:'⚡'},
  {id:'auto',label:'자동',icon:'🤖'},
];
const MTABS=[
  {id:'portfolio',label:'포트폴리오',icon:'💼'},{id:'history',label:'매매일지',icon:'📝'},
  {id:'backtest',label:'백테스트',icon:'🧪'},{id:'ai',label:'AI채팅',icon:'💬'},
  {id:'academy',label:'아카데미',icon:'📚'},{id:'news',label:'뉴스',icon:'📰'},
  {id:'alerts',label:'알림',icon:'🔔'},{id:'social',label:'소셜',icon:'👥'},
  {id:'accounts',label:'계좌연결',icon:'🔗'},{id:'funding',label:'입출금',icon:'💸'},
  {id:'intelligence',label:'인텔리전스',icon:'🧠'},{id:'wunder',label:'WUNDER봇',icon:'🤖'},{id:'tradfi',label:'TradFi',icon:'📊'},{id:'realtime',label:'실시간',icon:'📡'},
  {id:'analytics',label:'분석',icon:'📈'},{id:'calendar',label:'경제캘린더',icon:'📅'},
  {id:'briefing',label:'AI브리핑',icon:'🤖'},{id:'tax',label:'손익·세금',icon:'💼'},
  {id:'growth',label:'성장',icon:'🏆'},{id:'heatmap',label:'히트맵',icon:'🌈'},
  {id:'scanner',label:'스캐너',icon:'🔍'},{id:'clock',label:'세계시장',icon:'🌐'},
  {id:'settings',label:'설정',icon:'⚙️'},
  {id:'subscription',label:'구독',icon:'💳'},
];

/* ── Main App ── */
export default function App() {
  const [tab,setTab]=useState('home');
  const [prices,setPrices]=useState<Asset[]>(ASSETS);
  const [showMore,setShowMore]=useState(false);
  const [lang,setLang]=useState(()=>gS('tg_lang','ko'));
  const [currency,setCurrency]=useState(()=>gS('tg_cur','KRW'));
  const [onboarded,setOnboarded]=useState(()=>!!gS('tg_ob',''));

  useEffect(()=>{sS('tg_lang',lang);},[lang]);
  useEffect(()=>{sS('tg_cur',currency);},[currency]);
  useEffect(()=>{
    const t=setInterval(()=>setPrices(prev=>simulatePriceUpdate(prev)),3000);
    return()=>clearInterval(t);
  },[]);

  const nav=useCallback((id:string)=>{setTab(id);setShowMore(false);},[]);
  const allTabs=[...BTABS,...MTABS];
  const unreadCount=2;

  const renderPage=useCallback(()=>{
    const commonProps={prices,currency,lang,onNav:nav};
    const map:Record<string,React.ReactNode>={
      home:<HomePage {...commonProps}/>,
      watchlist:<WatchlistPage prices={prices} currency={currency}/>,
      market:<MarketPage prices={prices} onNav={nav} currency={currency}/>,
      trading:<TradingPage prices={prices} currency={currency}/>,
      auto:<AutoPage/>,
      portfolio:<PortfolioPage prices={prices} currency={currency}/>,
      history:<HistoryPage/>,
      backtest:<BacktestPage/>,
      ai:<AIPage/>,
      academy:<AcademyPage/>,
      news:<NewsPage/>,
      alerts:<AlertsPage prices={prices}/>,
      social:<SocialPage/>,
      accounts:<AccountsPage prices={prices} currency={currency}/>,
      funding:<FundingPage currency={currency}/>,
      heatmap:<div><div style={{fontWeight:800,fontSize:15,color:T.txt,marginBottom:12}}>🌈 자산 히트맵</div><Heatmap prices={prices}/></div>,
      scanner:<ScannerPage prices={prices} currency={currency}/>,
      clock:<div style={{padding:'4px 0'}}><WorldClock/></div>,
      settings:<SettingsPage lang={lang} setLang={setLang} currency={currency} setCurrency={setCurrency}/>,
      intelligence:<IntelligencePage/>,
      wunder:<WunderPage/>,
      tradfi:<TradFiPage prices={prices} currency={currency}/>,
      realtime:<RealtimePage prices={prices}/>,
      analytics:<AnalyticsPage prices={prices} currency={currency}/>,
      subscription:<SubscriptionPage/>,
      calendar:<EconCalendarPage/>,
      briefing:<BriefingPage prices={prices}/>,
      tax:<TaxPage currency={currency}/>,
      growth:<GrowthPage/>,
    };
    return <div className="slide" key={tab}>{map[tab]||map.home}</div>;
  },[tab,prices,nav,currency,lang]);

  const tickerAssets=prices.slice(0,14);

  return (
    <>
      {!onboarded&&<Onboarding onDone={(l,c)=>{setLang(l);setCurrency(c);setOnboarded(true);sS('tg_ob','1');sS('tg_lang',l);sS('tg_cur',c);}}/>}
      <div className="aw" style={{background:T.bg,minHeight:'100vh',color:T.txt,maxWidth:480,margin:'0 auto'}}>

        {/* PC Sidebar */}
        <div className="sb" style={{display:'none',padding:'12px 0'}}>
          <div style={{padding:'14px 16px 12px',borderBottom:`1px solid ${T.border}`,marginBottom:6}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <div style={{width:30,height:30,borderRadius:9,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:14,color:'#fff'}}>T</div>
              <div style={{fontWeight:900,fontSize:15,letterSpacing:-0.5}}>TRAIGO</div>
              <div style={{marginLeft:'auto'}}><Dot c={T.grn}/></div>
            </div>
          </div>
          {allTabs.map(t2=>(
            <button key={t2.id} onClick={()=>nav(t2.id)} style={{display:'flex',alignItems:'center',gap:10,width:'100%',padding:'10px 16px',background:tab===t2.id?T.acg:'transparent',color:tab===t2.id?T.acl:T.muted,border:'none',borderLeft:`3px solid ${tab===t2.id?T.acl:'transparent'}`,cursor:'pointer',fontSize:13,fontWeight:tab===t2.id?700:500,textAlign:'left'}}>
              <span style={{fontSize:16,width:22,textAlign:'center'}}>{t2.icon}</span>{t2.label}
              {t2.id==='alerts'&&unreadCount>0&&<span style={{background:T.red,color:'#fff',borderRadius:99,padding:'0 5px',fontSize:9,marginLeft:'auto',fontWeight:700}}>{unreadCount}</span>}
            </button>
          ))}
          <div style={{marginTop:'auto',padding:'12px 14px',borderTop:`1px solid ${T.border}`}}>
            <div style={{background:T.prp+'20',border:`1px solid ${T.prp}40`,borderRadius:10,padding:'8px 12px'}}>
              <div style={{color:T.prp,fontWeight:700,fontSize:11}}>🎮 모의투자 모드</div>
              <div style={{color:T.muted,fontSize:10,marginTop:2}}>실제 돈 사용 안됨 · 수익 보장 없음</div>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="mc" style={{flex:1}}>
          {/* Header */}
          <div style={{position:'sticky',top:0,zIndex:50,background:T.bg+'EE',backdropFilter:'blur(16px)',borderBottom:`1px solid ${T.border}`,padding:'11px 16px 9px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <div style={{width:26,height:26,borderRadius:8,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:13,color:'#fff'}}>T</div>
              <div style={{fontWeight:900,fontSize:14,letterSpacing:-0.5}}>{allTabs.find(t2=>t2.id===tab)?.label||'TRAIGO'}</div>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <div style={{display:'flex',alignItems:'center',gap:4,background:'rgba(16,185,129,.12)',border:'1px solid rgba(16,185,129,.3)',borderRadius:20,padding:'3px 9px'}}>
                <Dot/><span style={{color:T.grn,fontSize:10,fontWeight:700}}>LIVE</span>
              </div>
              <button onClick={()=>nav('settings')} style={{background:T.acg,border:`1px solid ${T.border}`,borderRadius:20,padding:'2px 9px',cursor:'pointer',fontSize:11,color:T.acl,fontWeight:700,display:'flex',alignItems:'center',gap:3}}>
                <span>{LANGS.find(l=>l.code===lang)?.flag||'🌍'}</span>
                <span>{CURRENCIES[currency]?.symbol||'₩'}</span>
              </button>
              <button onClick={()=>nav('alerts')} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:20,padding:'2px 8px',cursor:'pointer',fontSize:11,color:T.muted,position:'relative'}}>
                🔔{unreadCount>0&&<span style={{position:'absolute',top:-3,right:-3,background:T.red,color:'#fff',borderRadius:'50%',width:12,height:12,fontSize:8,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700}}>{unreadCount}</span>}
              </button>
              <div style={{background:T.prp+'20',border:`1px solid ${T.prp}40`,borderRadius:20,padding:'2px 7px'}}>
                <span style={{color:T.prp,fontSize:10,fontWeight:700}}>🎮 모의</span>
              </div>
            </div>
          </div>

          {/* Ticker */}
          <div style={{background:T.surf,borderBottom:`1px solid ${T.border}`,overflow:'hidden',height:26,display:'flex',alignItems:'center'}}>
            <div className="ticker">
              {[...tickerAssets,...tickerAssets].map((a,i)=>(
                <span key={i} style={{color:a.c>=0?T.grn:T.red,fontSize:10,padding:'0 12px',fontFamily:'monospace',fontWeight:500}}>
                  {a.nameKr} <span style={{color:T.txt}}>{cvt(a.p,currency)}</span> {a.c>=0?'▲':'▼'}{Math.abs(a.c).toFixed(2)}%
                </span>
              ))}
            </div>
          </div>

          {/* Page Content */}
          <div style={{padding:'12px 12px 100px'}}>{renderPage()}</div>

          {/* Bottom Nav */}
          <div className="bn" style={{position:'fixed',bottom:0,left:'50%',transform:'translateX(-50%)',width:'100%',maxWidth:480,background:T.surf+'F5',backdropFilter:'blur(20px)',borderTop:`1px solid ${T.border}`,display:'flex',padding:'5px 0 14px',zIndex:100}}>
            {BTABS.map(t2=>(
              <button key={t2.id} onClick={()=>nav(t2.id)} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2,background:'transparent',border:'none',cursor:'pointer',padding:'4px 2px'}}>
                <div style={{fontSize:18,lineHeight:1,filter:tab===t2.id?'none':'grayscale(1) opacity(.4)'}}>{t2.icon}</div>
                <div style={{fontSize:9,fontWeight:700,color:tab===t2.id?T.acl:T.muted}}>{t2.label}</div>
                {tab===t2.id&&<div style={{width:16,height:2,borderRadius:1,background:T.acl}}/>}
              </button>
            ))}
            <button onClick={()=>setShowMore(v=>!v)} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2,background:'transparent',border:'none',cursor:'pointer',padding:'4px 2px',position:'relative'}}>
              <div style={{fontSize:18,lineHeight:1}}>{showMore?'✕':'···'}</div>
              <div style={{fontSize:9,fontWeight:700,color:showMore?T.acl:T.muted}}>더보기</div>
              {unreadCount>0&&<span style={{position:'absolute',top:2,right:12,background:T.red,color:'#fff',borderRadius:'50%',width:12,height:12,fontSize:8,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700}}>{unreadCount}</span>}
            </button>
          </div>

          {/* More Menu */}
          {showMore&&(
            <>
              <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:90}} onClick={()=>setShowMore(false)}/>
              <div style={{position:'fixed',bottom:68,left:'50%',transform:'translateX(-50%)',width:'calc(100% - 24px)',maxWidth:456,background:T.surf,border:`1px solid ${T.border}`,borderRadius:20,padding:'12px',zIndex:150,boxShadow:'0 -8px 40px rgba(0,0,0,.6)'}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:.8,marginBottom:10,paddingLeft:4}}>더보기</div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
                  {MTABS.map(t2=>(
                    <button key={t2.id} onClick={()=>nav(t2.id)} style={{background:tab===t2.id?T.acg:'transparent',border:`1px solid ${tab===t2.id?T.acl:T.border}`,borderRadius:12,padding:'10px 4px',display:'flex',flexDirection:'column',alignItems:'center',gap:4,cursor:'pointer',position:'relative'}}>
                      <span style={{fontSize:20}}>{t2.icon}</span>
                      <span style={{color:tab===t2.id?T.acl:T.muted,fontSize:9,fontWeight:700,textAlign:'center'}}>{t2.label}</span>
                      {t2.id==='alerts'&&unreadCount>0&&<span style={{position:'absolute',top:4,right:4,background:T.red,color:'#fff',borderRadius:'50%',width:12,height:12,fontSize:8,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700}}>{unreadCount}</span>}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* PC Right Panel */}
        <div className="rp" style={{display:'none'}}>
          <div style={{fontWeight:800,fontSize:13,color:T.txt,marginBottom:10}}>📊 실시간 시세</div>
          {prices.slice(0,10).map((a,i)=>(
            <div key={a.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:i<9?`1px solid ${T.border}`:'none'}}>
              <div style={{display:'flex',alignItems:'center',gap:6}}><Logo id={a.id} size={24} clr={a.clr}/><div><div style={{color:T.txt,fontSize:11,fontWeight:600}}>{a.id}</div><div style={{color:T.muted,fontSize:9}}>{a.nameKr}</div></div></div>
              <div style={{textAlign:'right'}}><div style={{color:T.txt,fontSize:10,fontFamily:'monospace',fontWeight:700}}>{cvt(a.p,currency)}</div><div style={{color:a.c>=0?T.grn:T.red,fontSize:10,fontWeight:700}}>{fmtPct(a.c)}</div></div>
            </div>
          ))}
          <div style={{marginTop:16,fontWeight:800,fontSize:13,color:T.txt,marginBottom:10}}>📰 뉴스</div>
          {MOCK_NEWS.slice(0,3).map(n=>(
            <div key={n.id} style={{padding:'8px 0',borderBottom:`1px solid ${T.border}`}}>
              <div style={{color:T.txt,fontSize:11,fontWeight:600,lineHeight:1.4,marginBottom:2}}>{n.title}</div>
              <div style={{color:T.muted,fontSize:9}}>{n.time} · {n.source}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
