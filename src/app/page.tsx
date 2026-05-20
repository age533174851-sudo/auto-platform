'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import { T, CURRENCIES, LANGS, I18N, LOGO_SOURCES, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import PosterLibrary from '@/components/PosterLibrary';
import ExchangeConnectPage from '@/components/ExchangeConnectPage';
import PnLCalculatorPage from '@/components/PnLCalculator';
import SafetyDashboard from '@/components/SafetyDashboard';
import SeasonDashboard from '@/components/SeasonDashboard';
import HubDashboard from '@/components/HubDashboard';
import IntelligencePage from '@/components/IntelligencePage';
import { Card, Dot, Spark, Pill, Bdg, Toggle, AreaChart, WorldClock, Heatmap,
         TradingChart, Logo, getBgColor, resolveLogoUrl, getKrName, cleanName, resolveTVSym,
         DonutChart, MiniBar, GlobalSearch, getLeverageRec,
         LiquidationCalc, PositionSizer, RiskDashboard,
         LOGO_DB } from '@/components/pages/SharedUI';
import HomePageComp from '@/components/pages/HomePage';
import MarketPageComp from '@/components/pages/MarketPage';
import PortfolioPageComp from '@/components/pages/PortfolioPage';
import TradingPageComp from '@/components/pages/TradingPage';
import AutoPageComp from '@/components/pages/AutoPage';
import AIPageComp from '@/components/pages/AIPage';
import { ErrorBoundary } from '@/components/pages/ErrorBoundary';

interface Order { id:string;assetId:string;nameKr:string;sym:string;side:'buy'|'sell';price:number;amount:number;leverage:number;fee:number;slippage:number;status:'filled';pnl:number;pnlPct:number;openedAt:string;note:string;emotion:string; }
interface Alert { id:string;assetId:string;nameKr:string;condition:'above'|'below';value:number;active:boolean; }
interface Notif { id:string;type:'trade'|'alert'|'system';title:string;body:string;read:boolean;time:string; }

/* ── Logo ── */
// Logo function defined above


/* ── Base UI ── */

/* ══════════════════════════════════════════════════════
   TRAIGO Universal Asset Metadata Resolver
   한국어 이름 · 로고 · TradingView 심볼 자동 해석
   ══════════════════════════════════════════════════════ */

// ── Korean name map (canonical, no corporate suffixes) ──
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
        {step===0&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>{LANGS.map(l=><button key={l.id} onClick={()=>setSl(l.id)} style={{background:sl===l.id?T.acc+'25':T.card,border:`2px solid ${sl===l.id?T.acl:T.border}`,borderRadius:16,padding:'18px 10px',cursor:'pointer',textAlign:'center'}}><div style={{fontSize:32,marginBottom:8}}>{l.flag}</div><div style={{color:sl===l.id?T.acl:T.txt,fontWeight:700,fontSize:14}}>{l.name}</div></button>)}</div>}
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
function WatchlistPage({prices,currency,onNav}:{prices:Asset[];currency:string;onNav:(tab:string)=>void}) {
  const STORE = 'tg_watchlist_v2';

  /* ─── Full search DB (Korean names, clean) ─── */
  const WL_DB = [
    {id:'BTC', nameKr:'비트코인',   sym:'BTC',     clr:'#F7931A', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:BTCUSDT'},
    {id:'ETH', nameKr:'이더리움',   sym:'ETH',     clr:'#627EEA', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:ETHUSDT'},
    {id:'SOL', nameKr:'솔라나',     sym:'SOL',     clr:'#9945FF', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:SOLUSDT'},
    {id:'XRP', nameKr:'리플',       sym:'XRP',     clr:'#00AAE4', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:XRPUSDT'},
    {id:'BNB', nameKr:'바이낸스코인',sym:'BNB',    clr:'#F0B90B', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:BNBUSDT'},
    {id:'DOGE',nameKr:'도지코인',   sym:'DOGE',    clr:'#C2A633', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:DOGEUSDT'},
    {id:'ADA', nameKr:'에이다',     sym:'ADA',     clr:'#0033AD', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:ADAUSDT'},
    {id:'AVAX',nameKr:'아발란체',   sym:'AVAX',    clr:'#E84142', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:AVAXUSDT'},
    {id:'TON', nameKr:'톤코인',     sym:'TON',     clr:'#0088CC', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:TONUSDT'},
    {id:'LINK',nameKr:'체인링크',   sym:'LINK',    clr:'#2A5ADA', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:LINKUSDT'},
    {id:'ARB', nameKr:'아비트럼',   sym:'ARB',     clr:'#12AAFF', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:ARBUSDT'},
    {id:'SUI', nameKr:'수이',       sym:'SUI',     clr:'#4DA2FF', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:SUIUSDT'},
    {id:'PEPE',nameKr:'페페',       sym:'PEPE',    clr:'#3BA14C', cat:'coin',  exchange:'BINANCE', tv:'BINANCE:PEPEUSDT'},
    {id:'NVDA',nameKr:'엔비디아',   sym:'NVDA',    clr:'#76B900', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:NVDA'},
    {id:'AAPL',nameKr:'애플',       sym:'AAPL',    clr:'#555555', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:AAPL'},
    {id:'MSFT',nameKr:'마이크로소프트',sym:'MSFT', clr:'#00A4EF', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:MSFT'},
    {id:'TSLA',nameKr:'테슬라',     sym:'TSLA',    clr:'#CC0000', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:TSLA'},
    {id:'GOOGL',nameKr:'구글',      sym:'GOOGL',   clr:'#4285F4', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:GOOGL'},
    {id:'AMZN',nameKr:'아마존',     sym:'AMZN',    clr:'#FF9900', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:AMZN'},
    {id:'META',nameKr:'메타',       sym:'META',    clr:'#0082FB', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:META'},
    {id:'AMD', nameKr:'AMD',        sym:'AMD',     clr:'#ED1C24', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:AMD'},
    {id:'INTC',nameKr:'인텔',       sym:'INTC',    clr:'#0071C5', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:INTC'},
    {id:'AVGO',nameKr:'브로드컴',   sym:'AVGO',    clr:'#CC0000', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:AVGO'},
    {id:'QCOM',nameKr:'퀄컴',       sym:'QCOM',    clr:'#3253DC', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:QCOM'},
    {id:'TSM', nameKr:'TSMC',       sym:'TSM',     clr:'#BB2A35', cat:'stock', exchange:'NYSE',    tv:'NYSE:TSM'},
    {id:'PLTR',nameKr:'팔란티어',   sym:'PLTR',    clr:'#1F2937', cat:'stock', exchange:'NYSE',    tv:'NYSE:PLTR'},
    {id:'PL',  nameKr:'플래닛랩스', sym:'PL',      clr:'#4287F5', cat:'stock', exchange:'NYSE',    tv:'NYSE:PL'},
    {id:'COIN',nameKr:'코인베이스', sym:'COIN',    clr:'#0052FF', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:COIN'},
    {id:'HOOD',nameKr:'로빈후드',   sym:'HOOD',    clr:'#00C805', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:HOOD'},
    {id:'RIVN',nameKr:'리비안',     sym:'RIVN',    clr:'#3DD286', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:RIVN'},
    {id:'GME', nameKr:'게임스탑',   sym:'GME',     clr:'#E31937', cat:'stock', exchange:'NYSE',    tv:'NYSE:GME'},
    {id:'MSTR',nameKr:'마이크로스트레티지',sym:'MSTR',clr:'#E87426',cat:'stock',exchange:'NASDAQ',tv:'NASDAQ:MSTR'},
    {id:'JPM', nameKr:'JP모건',     sym:'JPM',     clr:'#006DAE', cat:'stock', exchange:'NYSE',    tv:'NYSE:JPM'},
    {id:'GS',  nameKr:'골드만삭스', sym:'GS',      clr:'#6C8EBF', cat:'stock', exchange:'NYSE',    tv:'NYSE:GS'},
    {id:'V',   nameKr:'비자',       sym:'V',       clr:'#1A1F71', cat:'stock', exchange:'NYSE',    tv:'NYSE:V'},
    {id:'NFLX',nameKr:'넷플릭스',   sym:'NFLX',    clr:'#E50914', cat:'stock', exchange:'NASDAQ',  tv:'NASDAQ:NFLX'},
    {id:'WMT', nameKr:'월마트',     sym:'WMT',     clr:'#0071CE', cat:'stock', exchange:'NYSE',    tv:'NYSE:WMT'},
    {id:'LLY', nameKr:'일라이릴리', sym:'LLY',     clr:'#D52B1E', cat:'stock', exchange:'NYSE',    tv:'NYSE:LLY'},
    {id:'MSTR',nameKr:'마이크로스트레티지',sym:'MSTR',clr:'#E87426',cat:'stock',exchange:'NASDAQ',tv:'NASDAQ:MSTR'},
    {id:'005930',nameKr:'삼성전자', sym:'005930',  clr:'#1428A0', cat:'krstock',exchange:'KRX',    tv:'KRX:005930'},
    {id:'000660',nameKr:'SK하이닉스',sym:'000660', clr:'#EA1917', cat:'krstock',exchange:'KRX',    tv:'KRX:000660'},
    {id:'035420',nameKr:'NAVER',    sym:'035420',  clr:'#03C75A', cat:'krstock',exchange:'KRX',    tv:'KRX:035420'},
    {id:'035720',nameKr:'카카오',   sym:'035720',  clr:'#FEE500', cat:'krstock',exchange:'KRX',    tv:'KRX:035720'},
    {id:'005380',nameKr:'현대차',   sym:'005380',  clr:'#002C5F', cat:'krstock',exchange:'KRX',    tv:'KRX:005380'},
    {id:'000270',nameKr:'기아',     sym:'000270',  clr:'#E31F26', cat:'krstock',exchange:'KRX',    tv:'KRX:000270'},
    {id:'SPY', nameKr:'S&P500 ETF', sym:'SPY',     clr:'#1D4ED8', cat:'etf',   exchange:'AMEX',    tv:'AMEX:SPY'},
    {id:'QQQ', nameKr:'나스닥100 ETF',sym:'QQQ',   clr:'#7C3AED', cat:'etf',   exchange:'NASDAQ',  tv:'NASDAQ:QQQ'},
    {id:'TQQQ',nameKr:'나스닥3배',  sym:'TQQQ',    clr:'#7C3AED', cat:'etf',   exchange:'NASDAQ',  tv:'NASDAQ:TQQQ'},
    {id:'SQQQ',nameKr:'나스닥3배인버스',sym:'SQQQ', clr:'#DC2626', cat:'etf',   exchange:'NASDAQ',  tv:'NASDAQ:SQQQ'},
    {id:'SOXL',nameKr:'반도체3배',  sym:'SOXL',    clr:'#7C3AED', cat:'etf',   exchange:'AMEX',    tv:'AMEX:SOXL'},
    {id:'ARKK',nameKr:'ARK이노베이션',sym:'ARKK',  clr:'#7C3AED', cat:'etf',   exchange:'AMEX',    tv:'AMEX:ARKK'},
    {id:'GLD', nameKr:'금 ETF',     sym:'GLD',     clr:'#D97706', cat:'etf',   exchange:'AMEX',    tv:'AMEX:GLD'},
    {id:'XAUUSD',nameKr:'금(Gold)',  sym:'XAUUSD',  clr:'#FFD700', cat:'commodity',exchange:'FOREX',tv:'OANDA:XAUUSD'},
    {id:'USOIL',nameKr:'WTI원유',   sym:'USOIL',   clr:'#78350F', cat:'commodity',exchange:'CME',  tv:'TVC:USOIL'},
    {id:'DXY', nameKr:'달러인덱스', sym:'DXY',     clr:'#10B981', cat:'index',  exchange:'TVC',     tv:'TVC:DXY'},
    {id:'SPX', nameKr:'S&P 500',    sym:'SPX',     clr:'#1D4ED8', cat:'index',  exchange:'SP',      tv:'SP:SPX'},
    {id:'NDX', nameKr:'나스닥100',  sym:'NDX',     clr:'#7C3AED', cat:'index',  exchange:'NASDAQ',  tv:'NASDAQ:NDX'},
    {id:'VIX', nameKr:'공포지수',   sym:'VIX',     clr:'#EF4444', cat:'index',  exchange:'TVC',     tv:'TVC:VIX'},
  ];

  /* ─── KR alias map for search ─── */
  const KR_A: Record<string,string> = {
    '비트코인':'BTC','이더리움':'ETH','솔라나':'SOL','리플':'XRP','도지코인':'DOGE',
    '바이낸스코인':'BNB','에이다':'ADA','아발란체':'AVAX','톤코인':'TON','체인링크':'LINK',
    '아비트럼':'ARB','수이':'SUI','페페':'PEPE','엔비디아':'NVDA','애플':'AAPL',
    '마이크로소프트':'MSFT','테슬라':'TSLA','구글':'GOOGL','알파벳':'GOOGL',
    '아마존':'AMZN','메타':'META','AMD':'AMD','인텔':'INTC','브로드컴':'AVGO',
    '퀄컴':'QCOM','팔란티어':'PLTR','플래닛랩스':'PL','코인베이스':'COIN',
    '로빈후드':'HOOD','리비안':'RIVN','게임스탑':'GME','마이크로스트레티지':'MSTR',
    'JP모건':'JPM','골드만삭스':'GS','비자':'V','넷플릭스':'NFLX','월마트':'WMT',
    '일라이릴리':'LLY','삼성전자':'005930','SK하이닉스':'000660','카카오':'035720',
    '현대차':'005380','기아':'000270','금':'XAUUSD','원유':'USOIL','달러':'DXY',
    'NAVER':'035420','나스닥':'QQQ','나스닥100':'QQQ','S&P500':'SPY',
    '반도체':'SOXL','반도체3배':'SOXL','나스닥3배':'TQQQ','공포지수':'VIX',
    'bitcoin':'BTC','ethereum':'ETH','solana':'SOL','nvidia':'NVDA',
    'apple':'AAPL','microsoft':'MSFT','tesla':'TSLA','google':'GOOGL',
    'amazon':'AMZN','meta':'META','palantir':'PLTR','planet labs':'PL',
    'coinbase':'COIN','samsung':'005930','kakao':'035720',
    'gold':'XAUUSD','oil':'USOIL','dollar':'DXY',
  };

  const searchWL = (q: string) => {
    if (!q.trim()) return WL_DB.slice(0, 20);
    const lq = q.toLowerCase().trim();
    const resolved = KR_A[q.trim()] || KR_A[lq] || q.toUpperCase().trim();
    const res = WL_DB.filter(a =>
      a.id === resolved ||
      a.id.toLowerCase().includes(lq) ||
      a.nameKr.includes(q) ||
      a.sym.toLowerCase().includes(lq) ||
      a.id.toLowerCase().includes(resolved.toLowerCase())
    );
    return res.length ? res : WL_DB.filter(a => a.nameKr.includes(q.slice(0,2)) || a.id.toLowerCase().startsWith(lq));
  };

  /* ─── State ─── */
  const [wl,    setWl]     = useState<any[]>(()=>{ if(typeof window==='undefined') return []; try{return JSON.parse(localStorage.getItem(STORE)||'[]');}catch{return [];} });
  const [cat,   setCat]    = useState('코인');
  const [open,  setOpen]   = useState(false);
  const [q,     setQ]      = useState('');
  const [res,   setRes]    = useState<any[]>([]);
  const [toast, setToast]  = useState('');

  const save  = (arr: any[]) => { setWl(arr); try{localStorage.setItem(STORE,JSON.stringify(arr));}catch{} };
  const flash = (m: string) => { setToast(m); setTimeout(()=>setToast(''),2500); };

  const openModal = () => { setOpen(true); setQ(''); setRes(WL_DB.slice(0,20)); };
  const search    = (v: string) => { setQ(v); setRes(searchWL(v)); };
  const inWL      = (id: string) => wl.some(w=>w.id===id);

  const add = (a: any) => {
    if (inWL(a.id)) { flash('이미 추가된 종목입니다.'); return; }
    const item={id:a.id,nameKr:a.nameKr,sym:a.sym,clr:a.clr,cat:a.cat,exchange:a.exchange,tv:a.tv,addedAt:new Date().toISOString()};
    save([item,...wl]);
    flash(`${a.nameKr} 추가됨 ✅`);
  };
  const remove = (id: string) => { save(wl.filter(w=>w.id!==id)); flash('제거됨'); };

  const CATS = [
    {id:'코인',   icon:'₿',  color:'#F7931A'},
    {id:'미국주식',icon:'🇺🇸', color:'#3B82F6'},
    {id:'국내주식',icon:'🇰🇷', color:'#EF4444'},
    {id:'ETF',   icon:'📦', color:'#10B981'},
    {id:'원자재', icon:'🥇', color:'#D97706'},
    {id:'관심종목',icon:'⭐', color:'#F59E0B'},
  ];
  const CAT_IDS: Record<string,string[]> = {
    '코인':    ['BTC','ETH','SOL','XRP','BNB','DOGE','ADA','AVAX','TON','LINK'],
    '미국주식':['NVDA','AAPL','MSFT','TSLA','GOOGL','META','AMZN','AMD','PLTR','NFLX'],
    '국내주식':['005930','000660','035420','035720','005380','000270'],
    'ETF':    ['SPY','QQQ','SOXL','TQQQ','SQQQ','ARKK','GLD'],
    '원자재':  ['XAUUSD','USOIL','DXY','SPX','NDX','VIX'],
    '관심종목':wl.map(w=>w.id),
  };
  const displayIds = CAT_IDS[cat] || [];
  const displayRows = displayIds.map(id=>{
    const db   = WL_DB.find(a=>a.id===id) || wl.find(w=>w.id===id);
    const live = (prices||[]).find(p=>p.id===id);
    return db ? {...db,...(live||{})} : null;
  }).filter(Boolean) as any[];

  return (
    <div>
      {/* ── Toast ── */}
      {toast&&(
        <div style={{position:'fixed',top:16,left:'50%',transform:'translateX(-50%)',zIndex:999,background:T.surf,border:`1px solid ${T.acl}40`,borderRadius:12,padding:'10px 16px',fontSize:12,fontWeight:700,color:T.txt,whiteSpace:'nowrap',boxShadow:'0 4px 20px rgba(0,0,0,.5)'}}>
          {toast}
        </div>
      )}

      {/* ── Add Modal ── */}
      {open&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.78)',zIndex:300}} onClick={()=>setOpen(false)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:301,background:T.surf,borderRadius:'22px 22px 0 0',border:`1px solid ${T.border}`,paddingBottom:`max(env(safe-area-inset-bottom,0px),16px)`}} onClick={e=>e.stopPropagation()}>
            <div style={{width:36,height:4,background:T.border,borderRadius:2,margin:'10px auto 10px'}}/>
            <div style={{padding:'0 16px'}}>
              <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:10}}>📌 관심종목 추가</div>
              {/* Search input */}
              <div style={{position:'relative',marginBottom:10}}>
                <input
                  value={q}
                  onChange={e=>search(e.target.value)}
                  placeholder="종목 검색 (비트코인, NVDA, 삼성전자, 플래닛랩스…)"
                  autoFocus
                  style={{width:'100%',background:T.bg,border:`2px solid ${T.acl}`,borderRadius:12,padding:'11px 14px 11px 38px',color:T.txt,fontSize:16,outline:'none',fontWeight:500}}
                />
                <span style={{position:'absolute',left:12,top:'50%',transform:'translateY(-50%)',color:T.muted,fontSize:15,pointerEvents:'none'}}>🔍</span>
                {q&&<button onClick={()=>search('')} style={{position:'absolute',right:12,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:T.muted,cursor:'pointer',fontSize:18,lineHeight:1}}>✕</button>}
              </div>
              {/* Hint chips */}
              {!q&&(
                <div style={{display:'flex',gap:5,flexWrap:'wrap',marginBottom:8}}>
                  {['비트코인','엔비디아','테슬라','삼성전자','플래닛랩스','구글','금'].map(h=>(
                    <button key={h} onClick={()=>search(h)} style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:20,padding:'3px 9px',fontSize:10,cursor:'pointer',whiteSpace:'nowrap'}}>{h}</button>
                  ))}
                </div>
              )}
              {/* Result list */}
              <div style={{maxHeight:300,overflowY:'auto',WebkitOverflowScrolling:'touch' as any,marginBottom:10}}>
                {res.length===0?(
                  <div style={{textAlign:'center',padding:'24px 0',color:T.muted}}>
                    <div style={{fontSize:24,marginBottom:6}}>🔍</div>
                    <div style={{fontSize:11}}>&ldquo;{q}&rdquo; 검색 결과 없음</div>
                  </div>
                ):res.map(a=>{
                  const already = inWL(a.id);
                  return (
                    <div key={a.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:`1px solid ${T.border}`}}>
                      <div style={{display:'flex',gap:9,alignItems:'center',flex:1,minWidth:0}}>
                        <div style={{width:36,height:36,borderRadius:10,background:`${a.clr}18`,border:`1px solid ${a.clr}35`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:900,color:a.clr,flexShrink:0}}>
                          {a.id.slice(0,2)}
                        </div>
                        <div style={{minWidth:0}}>
                          <div style={{color:T.txt,fontSize:12,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{a.nameKr}</div>
                          <div style={{color:T.muted,fontSize:9,fontFamily:'monospace',marginTop:1}}>{a.sym} · {a.exchange}</div>
                        </div>
                      </div>
                      <button
                        onClick={()=>{ already ? remove(a.id) : add(a); }}
                        style={{flexShrink:0,marginLeft:10,background:already?T.red+'15':T.acg,color:already?T.red:T.acl,border:`1px solid ${already?T.red:T.acl}40`,borderRadius:9,padding:'6px 12px',fontSize:11,fontWeight:700,cursor:'pointer',minHeight:34}}
                      >
                        {already?'제거':'+ 추가'}
                      </button>
                    </div>
                  );
                })}
              </div>
              <button onClick={()=>setOpen(false)} style={{width:'100%',padding:'12px',background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:11,fontWeight:700,cursor:'pointer',fontSize:13}}>
                닫기
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Header ── */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
        <div style={{fontWeight:900,fontSize:16,color:T.txt}}>⭐ 왓치리스트</div>
        <button
          onClick={openModal}
          style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,padding:'7px 14px',fontSize:12,fontWeight:700,cursor:'pointer',minHeight:38}}
        >
          + 추가
        </button>
      </div>

      {/* ── Category tabs ── */}
      <div style={{display:'flex',gap:5,overflowX:'auto',paddingBottom:5,marginBottom:12}}>
        {CATS.map(c=>(
          <button key={c.id} onClick={()=>setCat(c.id)} style={{flexShrink:0,display:'flex',alignItems:'center',gap:4,padding:'5px 12px',borderRadius:20,background:cat===c.id?`${c.color}20`:'transparent',color:cat===c.id?c.color:T.muted,border:`1px solid ${cat===c.id?c.color:T.border}`,fontWeight:700,fontSize:11,cursor:'pointer',whiteSpace:'nowrap'}}>
            {c.icon} {c.id}
            {c.id==='관심종목'&&wl.length>0&&<span style={{background:`${c.color}30`,color:c.color,borderRadius:99,fontSize:8,padding:'1px 5px'}}>{wl.length}</span>}
          </button>
        ))}
      </div>

      {/* ── Empty state ── */}
      {cat==='관심종목'&&wl.length===0?(
        <div style={{textAlign:'center',padding:'52px 0'}}>
          <div style={{fontSize:40,marginBottom:10}}>⭐</div>
          <div style={{color:T.txt,fontWeight:700,fontSize:14,marginBottom:5}}>관심 종목이 없습니다</div>
          <div style={{color:T.muted,fontSize:11,marginBottom:16}}>+ 추가 버튼으로 원하는 종목을 등록하세요</div>
          <button onClick={openModal} style={{padding:'11px 24px',background:'linear-gradient(135deg,#2563EB,#7C3AED)',color:'#fff',border:'none',borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer'}}>+ 첫 종목 추가</button>
        </div>
      ):(
        <Card style={{overflow:'hidden'}}>
          {displayRows.map((a:any,i:number)=>(
            <div key={a.id} style={{display:'grid',gridTemplateColumns:'1fr 52px 100px',alignItems:'center',padding:'11px 14px',borderBottom:i<displayRows.length-1?`1px solid ${T.border}`:'none',cursor:'pointer'}} onClick={()=>onNav('chart')}>
              <div style={{display:'flex',alignItems:'center',gap:9,minWidth:0}}>
                <div style={{width:34,height:34,borderRadius:10,background:`${a.clr||T.acl}18`,border:`1px solid ${a.clr||T.acl}30`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:900,color:a.clr||T.acl,flexShrink:0}}>{(a.sym||a.id||'?').slice(0,2)}</div>
                <div style={{minWidth:0}}>
                  <div style={{color:T.txt,fontWeight:700,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{a.nameKr||a.id}</div>
                  <div style={{color:T.muted,fontSize:9,fontFamily:'monospace',marginTop:1}}>{a.sym||a.id}</div>
                </div>
              </div>
              <div style={{display:'flex',justifyContent:'center'}}><Spark pos={(a.c||0)>=0} w={46} h={22}/></div>
              <div style={{textAlign:'right'}}>
                {a.p?(
                  <>
                    <div style={{color:T.txt,fontWeight:700,fontSize:12,fontFamily:'monospace'}}>{cvt(a.p,currency)}</div>
                    <div style={{color:(a.c||0)>=0?T.grn:T.red,fontSize:10,fontWeight:700,marginTop:1}}>{(a.c||0)>=0?'▲':'▼'}{Math.abs(a.c||0).toFixed(2)}%</div>
                  </>
                ):(
                  <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:3}}>
                    <div style={{color:T.muted,fontSize:10}}>—</div>
                    {cat==='관심종목'&&<button onClick={e=>{e.stopPropagation();remove(a.id);}} style={{background:'none',border:'none',color:T.red,fontSize:9,cursor:'pointer',padding:'2px 0'}}>제거</button>}
                  </div>
                )}
              </div>
            </div>
          ))}
          {displayRows.length===0&&<div style={{padding:'30px 0',textAlign:'center',color:T.muted,fontSize:12}}>데이터 로딩 중…</div>}
        </Card>
      )}

      {/* ── Sync hint ── */}
      <div style={{marginTop:10,background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:'9px 13px',display:'flex',gap:7,alignItems:'center'}}>
        <span style={{fontSize:14}}>☁️</span>
        <span style={{color:T.muted,fontSize:10,flex:1}}>로그인하면 모든 기기에 동기화됩니다</span>
        <a href="/auth" style={{color:T.acl,fontSize:10,fontWeight:700,textDecoration:'none'}}>로그인 →</a>
      </div>
    </div>
  );
}


/* ── Portfolio types ── */
interface DCAEntry { id:string; assetId:string; nameKr:string; clr:string; sym:string; amount:number; freq:'daily'|'weekly'|'monthly'; active:boolean; avgPrice:number; totalInvested:number; qty:number; targetPrice:number; nextBuy:string; }
interface LongPos  { id:string; assetId:string; nameKr:string; clr:string; sym:string; type:'spot'|'etf'|'dca'; avgPrice:number; qty:number; invested:number; targetPrice:number; stopPrice:number; note:string; addedAt:string; }
interface ShortPos { id:string; assetId:string; nameKr:string; clr:string; sym:string; side:'long'|'short'; entryPrice:number; qty:number; margin:number; leverage:number; takeProfitPrice:number; stopLossPrice:number; pnl:number; pnlPct:number; openedAt:string; strategy:string; }
interface Allocation { longPct:number; shortPct:number; cashPct:number; }

/* ── Donut Chart ── */
function NewsPage({currency}:{currency:string}) {
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
        {selected.time&&<div style={{color:T.muted,fontSize:10}}>· {new Date(selected.time).toLocaleDateString('ko-KR')}</div>}
        {selected.sentiment&&<div style={{color:sentC[selected.sentiment]||T.muted,fontSize:10,fontWeight:700}}>● {selected.sentiment}</div>}
      </div>
      {(selected.tickers||[]).length>0&&(
        <div style={{display:'flex',gap:5,marginBottom:10,flexWrap:'wrap'}}>
          {selected.tickers.map((t:string)=><span key={t} style={{background:T.acg,color:T.acl,fontSize:10,padding:'2px 8px',borderRadius:20,fontWeight:700}}>{t}</span>)}
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
      ):filtered.map(n=>{
        const nid = n.id||n.title;
        return (
          <Card key={nid} style={{padding:'14px 16px',marginBottom:8,cursor:'pointer'}} onClick={()=>setSelected(n)}>
            <div style={{display:'flex',gap:10,alignItems:'flex-start'}}>
              {n.image&&<img src={n.image} alt="" style={{width:64,height:64,borderRadius:9,objectFit:'cover',flexShrink:0}} onError={e=>{(e.target as any).style.display='none'}}/>}
              <div style={{flex:1,minWidth:0}}>
                <div style={{color:T.txt,fontWeight:700,fontSize:12,lineHeight:1.5,marginBottom:4,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical' as any}}>{n.title}</div>
                <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
                  <span style={{color:T.muted,fontSize:9}}>{n.source}</span>
                  {n.time&&<span style={{color:T.muted,fontSize:9}}>{new Date(n.time).toLocaleDateString('ko-KR')}</span>}
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
function BacktestPage() {
  const [strategy, setStrategy] = useState('EMA Cross');
  const [asset,    setAsset]    = useState('BTC');
  const [period,   setPeriod]   = useState('6개월');
  const [running,  setRunning]  = useState(false);
  const [result,   setResult]   = useState<any>(null);
  const [equity,   setEquity]   = useState<number[]>([]);

  /* ─── Deterministic seed from params ─── */
  const seed = (strategy+asset+period).split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const rng  = (n:number) => { let x=Math.sin(n+seed)*10000; return x-Math.floor(x); };

  /* ─── Period → trading days ─── */
  const DAYS: Record<string,number> = {'1개월':22,'3개월':66,'6개월':130,'1년':252,'3년':756};
  const days = DAYS[period] || 130;

  /* ─── Base parameters per strategy ─── */
  const STRAT_PARAMS: Record<string,(d:number,rng:(n:number)=>number)=>{winRate:number;avgWin:number;avgLoss:number;tradeFreq:number;maxDD:number;sharpe:number}> = {
    'EMA Cross':      (d,r)=>({winRate:0.53+r(d*1)*0.10, avgWin:0.028+r(d*2)*0.015, avgLoss:0.019+r(d*3)*0.008, tradeFreq:0.08+r(d*4)*0.04, maxDD:-(0.12+r(d*5)*0.15+Math.log(d/22)*0.03), sharpe:0.9+r(d*6)*0.8}),
    'RSI Oversold':   (d,r)=>({winRate:0.58+r(d*2)*0.08, avgWin:0.022+r(d*3)*0.012, avgLoss:0.015+r(d*4)*0.006, tradeFreq:0.05+r(d*5)*0.03, maxDD:-(0.09+r(d*6)*0.12+Math.log(d/22)*0.025), sharpe:1.1+r(d*7)*0.7}),
    'Bollinger Bounce':(d,r)=>({winRate:0.55+r(d*3)*0.09, avgWin:0.019+r(d*4)*0.011, avgLoss:0.016+r(d*5)*0.007, tradeFreq:0.07+r(d*6)*0.04, maxDD:-(0.11+r(d*7)*0.13+Math.log(d/22)*0.028), sharpe:1.0+r(d*8)*0.75}),
    'DCA':            (d,r)=>({winRate:0.62+r(d*4)*0.06, avgWin:0.015+r(d*5)*0.008, avgLoss:0.011+r(d*6)*0.004, tradeFreq:1/5,              maxDD:-(0.07+r(d*8)*0.10+Math.log(d/22)*0.02),  sharpe:1.3+r(d*9)*0.5}),
  };

  /* ─── Asset volatility multiplier ─── */
  const ASSET_VOL: Record<string,number> = {BTC:1.8,ETH:2.1,SOL:2.6,AAPL:0.8,NVDA:1.4,NDX:1.0,SPY:0.7,TSLA:1.6,BNB:2.0,XRP:2.4};
  const vol = ASSET_VOL[asset] || 1.0;

  /* ─── Build candle series (mock historical, deterministic) ─── */
  const genCandles = (d: number): number[] => {
    const arr: number[] = [100];
    const drift = (asset==='BTC'||asset==='ETH'||asset==='NVDA') ? 0.0004 : 0.0002;
    for (let i=1; i<d; i++) {
      const r = rng(i);
      const change = (r-0.48)*0.028*vol + drift;
      arr.push(arr[i-1]*(1+change));
    }
    return arr;
  };

  const run = () => {
    setRunning(true); setResult(null); setEquity([]);
    setTimeout(()=>{
      const candles = genCandles(days);
      const p = (STRAT_PARAMS[strategy] || STRAT_PARAMS['EMA Cross'])(days, rng);
      const tradeCount = Math.round(days * p.tradeFreq);
      const trades: any[] = [];
      let balance = 10000000;  // 10M KRW starting
      const equityCurve: number[] = [balance];
      let maxBalance = balance;
      let maxDD = 0;

      for (let i=0; i<tradeCount; i++) {
        const win  = rng(i*3+1) < p.winRate;
        const pct  = win ? (p.avgWin  + rng(i*3+2)*p.avgWin*0.8)  * vol
                         : -(p.avgLoss + rng(i*3+3)*p.avgLoss*0.8) * vol;
        // Real fee calculation using fee engine
        const feeRate = (feeConfig?.customTaker ?? (feeConfig?.exchange ? 0.0004 : 0.0004));
        const fee  = feeRate * 2; // round trip
        const netPct = pct - fee;
        const pnl  = Math.round(balance * netPct);
        balance   += pnl;
        if (balance > maxBalance) maxBalance = balance;
        const dd = (balance - maxBalance) / maxBalance * 100;
        if (dd < maxDD) maxDD = dd;
        const ci = Math.floor(i / tradeCount * (days-1));
        trades.push({
          n:i+1, side:win?'매수':'매도', entry:Math.round(candles[ci]*100)/100,
          exit:Math.round(candles[Math.min(ci+5,days-1)]*100)/100,
          pnl, pnlPct: Math.round(netPct*10000)/100, fee:Math.round(balance*fee),
        });
        // Equity curve sample (every ~5 trades)
        if (i%Math.max(1,Math.round(tradeCount/50))===0) equityCurve.push(balance);
      }
      equityCurve.push(balance);

      const wins = trades.filter(t=>t.pnl>0);
      const losses = trades.filter(t=>t.pnl<0);
      const winRate = Math.round(wins.length/trades.length*100);
      const totalPnl = trades.reduce((s,t)=>s+t.pnl,0);
      const grossProfit = wins.reduce((s,t)=>s+t.pnl,0);
      const grossLoss   = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
      const profitFactor= grossLoss>0 ? +(grossProfit/grossLoss).toFixed(2) : 99;
      const rets = equityCurve.map((v,i,a)=>i>0?(v-a[i-1])/a[i-1]:0).slice(1);
      const meanR = rets.reduce((s,r)=>s+r,0)/rets.length;
      const stdR  = Math.sqrt(rets.reduce((s,r)=>s+(r-meanR)**2,0)/rets.length);
      const sharpe = stdR>0 ? +((meanR/stdR)*Math.sqrt(252)).toFixed(2) : 0;

      setResult({winRate, totalPnl, maxDD:+maxDD.toFixed(2), profitFactor, sharpe, tradeCount:trades.length, trades});
      setEquity(equityCurve);
      setRunning(false);
    }, 1200);
  };

  /* ─── Mini equity chart ─── */
  const EquityChart = ({data}:{data:number[]}) => {
    if (data.length<2) return null;
    const min=Math.min(...data), max=Math.max(...data), range=max-min||1;
    const w=280, h=80;
    const pts=data.map((v,i)=>`${(i/(data.length-1))*w},${h-(v-min)/range*h}`).join(' ');
    const up=data[data.length-1]>=data[0];
    return (
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{height:h}}>
        <defs><linearGradient id="eq_g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={up?T.grn:T.red} stopOpacity={0.3}/><stop offset="100%" stopColor={up?T.grn:T.red} stopOpacity={0}/></linearGradient></defs>
        <polygon points={`0,${h} ${pts} ${w},${h}`} fill="url(#eq_g)"/>
        <polyline points={pts} fill="none" stroke={up?T.grn:T.red} strokeWidth="1.5" strokeLinejoin="round"/>
      </svg>
    );
  };

  return (
    <div>
      <div style={{fontWeight:800,fontSize:15,color:T.txt,marginBottom:12}}>🧪 백테스팅 엔진</div>
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>⚙️ 설정</div>
        {[
          {l:'전략',v:strategy,opts:['EMA Cross','RSI Oversold','Bollinger Bounce','DCA'],set:setStrategy},
          {l:'종목',v:asset,opts:['BTC','ETH','SOL','AAPL','NVDA','SPY'],set:setAsset},
          {l:'기간',v:period,opts:['1개월','3개월','6개월','1년','3년'],set:setPeriod},
        ].map(f=>(
          <div key={f.l} style={{marginBottom:10}}>
            <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:5}}>{f.l}</div>
            <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
              {f.opts.map(o=>(
                <button key={o} onClick={()=>f.set(o)} style={{background:f.v===o?T.acg:'transparent',color:f.v===o?T.acl:T.muted,border:`1px solid ${f.v===o?T.acl:T.border}`,borderRadius:8,padding:'5px 11px',fontSize:11,fontWeight:700,cursor:'pointer'}}>{o}</button>
              ))}
            </div>
          </div>
        ))}
        <button onClick={run} disabled={running} style={{width:'100%',padding:'12px',background:running?'#243A5E':`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:700,fontSize:13,cursor:running?'not-allowed':'pointer',marginTop:4}}>
          {running?'⏳ 백테스트 실행 중…':'🚀 백테스트 실행'}
        </button>
      </Card>

      {result&&(
        <div>
          {/* Stats grid */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:12}}>
            {[
              {l:'승률',      v:`${result.winRate}%`,   c:result.winRate>=55?T.grn:result.winRate>=45?T.ylw:T.red},
              {l:'총 수익',   v:(result.totalPnl>=0?'+':'')+fmt(result.totalPnl)+'원', c:result.totalPnl>=0?T.grn:T.red},
              {l:'최대손실',  v:`${result.maxDD}%`,     c:T.red},
              {l:'수익팩터',  v:`${result.profitFactor}x`, c:result.profitFactor>=1.5?T.grn:result.profitFactor>=1?T.ylw:T.red},
              {l:'샤프지수',  v:`${result.sharpe}`,     c:result.sharpe>=1.5?T.grn:result.sharpe>=0.5?T.ylw:T.red},
              {l:'총 거래',   v:`${result.tradeCount}건`, c:T.acl},
            ].map(s=>(
              <Card key={s.l} style={{padding:'11px 10px'}}>
                <div style={{color:T.muted,fontSize:9,fontWeight:700,marginBottom:4}}>{s.l}</div>
                <div style={{color:s.c,fontSize:14,fontWeight:900,fontFamily:'monospace'}}>{s.v}</div>
              </Card>
            ))}
          </div>

          {/* Equity curve */}
          {equity.length>=2&&(
            <Card style={{padding:'14px 16px',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:8,display:'flex',justifyContent:'space-between'}}>
                <span>📈 수익 곡선</span>
                <span style={{color:equity[equity.length-1]>=equity[0]?T.grn:T.red,fontSize:12,fontWeight:700}}>
                  {equity[equity.length-1]>=equity[0]?'+':''}
                  {((equity[equity.length-1]/equity[0]-1)*100).toFixed(1)}%
                </span>
              </div>
              <EquityChart data={equity}/>
            </Card>
          )}

          {/* Trade list */}
          <Card style={{overflow:'hidden'}}>
            <div style={{padding:'10px 14px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between'}}>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>매매 목록 (최근 15건)</span>
              <span style={{color:T.muted,fontSize:9}}>{strategy} · {asset} · {period}</span>
            </div>
            {result.trades.slice(0,15).map((t:any)=>(
              <div key={t.n} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 14px',borderBottom:`1px solid ${T.border}`}}>
                <div>
                  <span style={{color:T.muted,fontSize:10}}>#{t.n} </span>
                  <span style={{color:t.pnl>=0?T.grn:T.red,fontSize:10,fontWeight:700}}>{t.side}</span>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:t.pnl>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{t.pnl>=0?'+':''}{fmt(t.pnl)}원</div>
                  <div style={{color:t.pnlPct>=0?T.grn:T.red,fontSize:9}}>{t.pnlPct>=0?'+':''}{t.pnlPct}%</div>
                </div>
              </div>
            ))}
          </Card>
          <div style={{color:T.muted,fontSize:9,textAlign:'center',marginTop:8}}>
            ⚠️ 과거 성과가 미래를 보장하지 않습니다 · 모의투자 전용
          </div>
        </div>
      )}
    </div>
  );
}

/* ── HistoryPage ── */
function HistoryPage() {
  const STORE = 'tg_journal_v1';
  const EMOTIONS = ['😊','😔','😤','😰','🤔','😎','🙁','😡'];
  const AI_REVIEWS = [
    '손절 규칙을 잘 지켰습니다. 계획대로 실행하는 것이 중요합니다.',
    '진입 타이밍이 좋았습니다. 지지선에서의 매수는 좋은 전략입니다.',
    'FOMO 진입 가능성이 있습니다. 다음에는 신호를 기다리세요.',
    '목표가 도달 전 조기 청산은 아쉽습니다. 계획을 지켜보세요.',
    '추세 방향과 일치한 거래입니다. 흐름을 읽는 눈이 좋습니다.',
    '손절이 너무 타이트했습니다. ATR 기반 손절을 고려해보세요.',
    '수익 실현 타이밍이 훌륭했습니다. 고점 근처에서 잘 나왔습니다.',
    '거래 횟수가 많습니다. 과거래는 수수료 손실로 이어질 수 있습니다.',
    '포지션 크기가 적절했습니다. 리스크 관리가 잘 되었습니다.',
  ];

  const loadEntries = (): any[] => {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem(STORE) || '[]'); }
    catch { return []; }
  };
  const saveEntries = (arr: any[]) => {
    try { localStorage.setItem(STORE, JSON.stringify(arr)); } catch {}
  };

  const [entries, setEntries] = useState<any[]>(loadEntries);
  const [showAdd, setShowAdd]   = useState(false);
  const [editId, setEditId]     = useState<string|null>(null);
  const [saving, setSaving]     = useState(false);
  const [toast, setToast]       = useState<string|null>(null);
  const [deleteId, setDeleteId] = useState<string|null>(null);

  const EMPTY_FORM = {
    sym:'BTC', side:'매수', entryPrice:'', exitPrice:'', size:'',
    pnl:'', pnlPct:'', date:new Date().toISOString().split('T')[0],
    memo:'', emotion:'😊', rating:3, tags:''
  };
  const [form, setForm] = useState<any>(EMPTY_FORM);

  const showTst = (msg: string) => { setToast(msg); setTimeout(()=>setToast(null), 2500); };

  const computePnl = (f: any) => {
    const entry = parseFloat(f.entryPrice) || 0;
    const exit  = parseFloat(f.exitPrice)  || 0;
    const size  = parseFloat(f.size)       || 0;
    if (!entry || !exit || !size) return { pnl: 0, pnlPct: 0 };
    const raw = f.side === '매수' ? (exit - entry) * size : (entry - exit) * size;
    const pct = entry > 0 ? ((exit - entry) / entry * (f.side === '매수' ? 1 : -1) * 100) : 0;
    return { pnl: Math.round(raw), pnlPct: Math.round(pct * 100) / 100 };
  };

  const openAdd = () => {
    setForm(EMPTY_FORM); setEditId(null); setShowAdd(true);
  };
  const openEdit = (e: any) => {
    setForm({ ...e, entryPrice: e.entryPrice||'', exitPrice: e.exitPrice||'', size: e.size||'', tags: (e.tags||[]).join(',') });
    setEditId(e.id); setShowAdd(true);
  };

  const handleSave = async () => {
    if (!form.sym?.trim()) { showTst('종목을 입력하세요'); return; }
    setSaving(true);
    await new Promise(r => setTimeout(r, 500));
    const computed = computePnl(form);
    const aiReview = AI_REVIEWS[Math.floor(Math.random() * AI_REVIEWS.length)];
    const entry = {
      id: editId || ('j_' + Date.now().toString(36)),
      sym: form.sym.toUpperCase().trim(),
      side: form.side,
      entryPrice: parseFloat(form.entryPrice) || 0,
      exitPrice:  parseFloat(form.exitPrice)  || 0,
      size:       parseFloat(form.size)       || 0,
      pnl:        computed.pnl,
      pnlPct:     computed.pnlPct,
      date:       form.date || new Date().toISOString().split('T')[0],
      memo:       form.memo || '',
      emotion:    form.emotion || '😊',
      rating:     form.rating || 3,
      tags:       form.tags ? form.tags.split(',').map((t:string)=>t.trim()).filter(Boolean) : [],
      aiReview,
      createdAt: new Date().toISOString(),
    };
    const next = editId
      ? entries.map(e => e.id === editId ? entry : e)
      : [entry, ...entries];
    setEntries(next);
    saveEntries(next);
    setSaving(false);
    setShowAdd(false);
    showTst(editId ? '수정되었습니다.' : '매매일지가 저장되었습니다. ✅');
  };

  const handleDelete = (id: string) => {
    const next = entries.filter(e => e.id !== id);
    setEntries(next); saveEntries(next);
    setDeleteId(null); showTst('삭제되었습니다.');
  };

  // Stats
  const total    = entries.length;
  const wins     = entries.filter(e => (e.pnl||0) > 0).length;
  const winRate  = total > 0 ? Math.round(wins / total * 100) : 0;
  const totalPnl = entries.reduce((s, e) => s + (e.pnl||0), 0);

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div style={{position:'fixed',top:16,left:'50%',transform:'translateX(-50%)',zIndex:999,background:T.surf,border:`1px solid ${T.grn}40`,borderRadius:12,padding:'10px 16px',fontSize:12,color:T.txt,fontWeight:700,boxShadow:'0 4px 20px rgba(0,0,0,.4)',whiteSpace:'nowrap',zIndex:999}}>
          {toast}
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200}} onClick={()=>setDeleteId(null)}/>
          <div style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:201,background:T.surf,borderRadius:18,padding:'22px 20px',width:300,border:`1px solid ${T.red}40`}}>
            <div style={{color:T.red,fontWeight:700,fontSize:15,marginBottom:8}}>🗑 삭제 확인</div>
            <div style={{color:T.muted,fontSize:12,marginBottom:16}}>이 일지를 삭제하시겠습니까?</div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>setDeleteId(null)} style={{flex:1,padding:'10px',background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>handleDelete(deleteId)} style={{flex:1,padding:'10px',background:T.red,color:'#fff',border:'none',borderRadius:10,fontWeight:700,cursor:'pointer'}}>삭제</button>
            </div>
          </div>
        </>
      )}

      {/* Add/Edit sheet */}
      {showAdd && (
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200,backdropFilter:'blur(4px)'}} onClick={()=>setShowAdd(false)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',maxHeight:'90vh',overflowY:'auto',WebkitOverflowScrolling:'touch' as any,border:`1px solid ${T.border}`}}>
            <div style={{width:36,height:4,borderRadius:2,background:T.border,margin:'10px auto 12px'}}/>
            <div style={{padding:'0 16px 16px'}}>
              <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:14}}>{editId?'✏️ 수정':'+ 새 매매일지'}</div>

              {/* Symbol + Side */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
                <div>
                  <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>종목</div>
                  <input value={form.sym} onChange={e=>setForm((p:any)=>({...p,sym:e.target.value.toUpperCase()}))} placeholder="BTC, NVDA, SPY…" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 11px',color:T.txt,fontSize:16,outline:'none',fontWeight:700}}/>
                </div>
                <div>
                  <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>방향</div>
                  <div style={{display:'flex',gap:5}}>
                    {['매수','매도'].map(s=>(
                      <button key={s} onClick={()=>setForm((p:any)=>({...p,side:s}))} style={{flex:1,padding:'9px',background:form.side===s?(s==='매수'?T.grn:T.red)+'20':T.alt,color:form.side===s?(s==='매수'?T.grn:T.red):T.muted,border:`1px solid ${form.side===s?(s==='매수'?T.grn:T.red):T.border}`,borderRadius:9,fontWeight:700,fontSize:12,cursor:'pointer'}}>{s}</button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Prices */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:10}}>
                {[{l:'진입가',k:'entryPrice'},{l:'청산가',k:'exitPrice'},{l:'수량',k:'size'}].map(f=>(
                  <div key={f.k}>
                    <div style={{color:T.muted,fontSize:9,fontWeight:700,marginBottom:3}}>{f.l}</div>
                    <input type="number" inputMode="decimal" value={form[f.k]} onChange={e=>setForm((p:any)=>({...p,[f.k]:e.target.value}))} placeholder="0" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 9px',color:T.txt,fontSize:16,outline:'none'}}/>
                  </div>
                ))}
              </div>

              {/* Auto PnL preview */}
              {form.entryPrice && form.exitPrice && form.size && (()=>{
                const {pnl, pnlPct} = computePnl(form);
                return (
                  <div style={{background:pnl>=0?T.grn+'12':T.red+'12',border:`1px solid ${pnl>=0?T.grn:T.red}30`,borderRadius:8,padding:'7px 10px',marginBottom:10,display:'flex',gap:10}}>
                    <div><div style={{color:T.muted,fontSize:9}}>예상 PnL</div><div style={{color:pnl>=0?T.grn:T.red,fontWeight:700,fontSize:12,fontFamily:'monospace'}}>{pnl>=0?'+':''}₩{Math.abs(pnl).toLocaleString()}</div></div>
                    <div><div style={{color:T.muted,fontSize:9}}>수익률</div><div style={{color:pnl>=0?T.grn:T.red,fontWeight:700,fontSize:12}}>{pnlPct>=0?'+':''}{pnlPct}%</div></div>
                  </div>
                );
              })()}

              {/* Date */}
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>날짜</div>
                <input type="date" value={form.date} onChange={e=>setForm((p:any)=>({...p,date:e.target.value}))} style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 11px',color:T.txt,fontSize:16,outline:'none'}}/>
              </div>

              {/* Memo */}
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>메모</div>
                <textarea value={form.memo} onChange={e=>setForm((p:any)=>({...p,memo:e.target.value}))} placeholder="진입 이유, 결과, 배운 점…" rows={3} style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 11px',color:T.txt,fontSize:14,outline:'none',resize:'none',fontFamily:'inherit'}}/>
              </div>

              {/* Emotion */}
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>감정</div>
                <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                  {EMOTIONS.map(e=>(
                    <button key={e} onClick={()=>setForm((p:any)=>({...p,emotion:e}))} style={{width:36,height:36,borderRadius:9,background:form.emotion===e?T.acg:T.alt,border:`2px solid ${form.emotion===e?T.acl:T.border}`,cursor:'pointer',fontSize:18}}>{e}</button>
                  ))}
                </div>
              </div>

              {/* Rating */}
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>자체 평가</div>
                <div style={{display:'flex',gap:4}}>
                  {[1,2,3,4,5].map(r=>(
                    <button key={r} onClick={()=>setForm((p:any)=>({...p,rating:r}))} style={{fontSize:22,background:'none',border:'none',cursor:'pointer',opacity:r<=form.rating?1:0.25}}>⭐</button>
                  ))}
                </div>
              </div>

              {/* Tags */}
              <div style={{marginBottom:14}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>태그 (쉼표 구분)</div>
                <input value={form.tags} onChange={e=>setForm((p:any)=>({...p,tags:e.target.value}))} placeholder="RSI, 돌파, 손절, DCA…" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 11px',color:T.txt,fontSize:16,outline:'none'}}/>
              </div>

              {/* Save */}
              <button onClick={handleSave} disabled={saving} style={{width:'100%',padding:'13px',background:saving?'#243A5E':'linear-gradient(135deg,#2563EB,#7C3AED)',color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:saving?'not-allowed':'pointer',marginBottom:6}}>
                {saving?'저장 중…':(editId?'수정 저장':'저장 ✅')}
              </button>
              <div style={{color:T.muted,fontSize:9,textAlign:'center'}}>⚠️ 모의투자 전용 · AI 리뷰 자동 생성</div>
            </div>
          </div>
        </>
      )}

      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div style={{fontWeight:800,fontSize:15,color:T.txt}}>📝 매매일지</div>
        <button onClick={openAdd} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,padding:'6px 14px',fontSize:12,fontWeight:700,cursor:'pointer',minHeight:36}}>+ 추가</button>
      </div>

      {/* Stats */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,marginBottom:14}}>
        {[{l:'총 거래',v:`${total}건`},{l:'수익 거래',v:`${wins}건`},{l:'승률',v:`${winRate}%`},{l:'총 PnL',v:totalPnl>=0?`+₩${Math.abs(totalPnl).toLocaleString()}`:`-₩${Math.abs(totalPnl).toLocaleString()}`,c:totalPnl>=0?T.grn:T.red}].map(x=>(
          <Card key={x.l} style={{padding:'10px 8px',textAlign:'center'}}>
            <div style={{color:T.muted,fontSize:9,marginBottom:3}}>{x.l}</div>
            <div style={{color:(x as any).c||T.txt,fontWeight:800,fontSize:13}}>{x.v}</div>
          </Card>
        ))}
      </div>

      {/* Empty state */}
      {entries.length === 0 ? (
        <div style={{textAlign:'center',padding:'50px 0'}}>
          <div style={{fontSize:40,marginBottom:10}}>📝</div>
          <div style={{color:T.txt,fontWeight:700,fontSize:14,marginBottom:6}}>아직 기록된 매매일지가 없습니다.</div>
          <div style={{color:T.muted,fontSize:11,marginBottom:16}}>첫 거래를 기록해보세요.</div>
          <button onClick={openAdd} style={{padding:'11px 24px',background:'linear-gradient(135deg,#2563EB,#7C3AED)',color:'#fff',border:'none',borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer'}}>+ 첫 일지 작성</button>
        </div>
      ) : (
        entries.map(e => {
          const pos = (e.pnl||0) >= 0;
          return (
            <Card key={e.id} style={{padding:'14px 16px',marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <Logo id={e.sym||'BTC'} size={30} clr={pos?T.grn:T.red}/>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:13}}>{e.sym} {e.side}</div>
                    <div style={{color:T.muted,fontSize:10}}>{e.date}</div>
                  </div>
                </div>
                <div style={{display:'flex',gap:5,alignItems:'center'}}>
                  <div style={{textAlign:'right'}}>
                    <div style={{color:pos?T.grn:T.red,fontWeight:800,fontSize:13}}>{pos?'+':''}{e.pnl!=null?`₩${Math.abs(e.pnl).toLocaleString()}`:'—'}</div>
                    <div style={{color:pos?T.grn:T.red,fontSize:10}}>{e.pnlPct!=null?`${e.pnlPct>=0?'+':''}${e.pnlPct}%`:'—'}</div>
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:3}}>
                    <button onClick={()=>openEdit(e)} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:6,padding:'3px 7px',fontSize:10,cursor:'pointer',color:T.muted}}>편집</button>
                    <button onClick={()=>setDeleteId(e.id)} style={{background:T.red+'15',border:'none',borderRadius:6,padding:'3px 7px',fontSize:10,cursor:'pointer',color:T.red}}>삭제</button>
                  </div>
                </div>
              </div>
              <div style={{display:'flex',gap:4,alignItems:'center',marginBottom:6}}>
                {Array.from({length:5},(_,i)=><span key={i} style={{fontSize:12,opacity:i<(e.rating||0)?1:0.2}}>⭐</span>)}
                <span style={{marginLeft:4,fontSize:16}}>{e.emotion||'😊'}</span>
                {(e.tags||[]).map((t:string)=>(
                  <span key={t} style={{background:T.alt,color:T.muted,fontSize:8,padding:'1px 5px',borderRadius:4}}>{t}</span>
                ))}
              </div>
              {e.memo && <div style={{color:T.muted,fontSize:11,marginBottom:6,lineHeight:1.5}}>{e.memo}</div>}
              {e.aiReview && (
                <div style={{background:T.acl+'12',border:`1px solid ${T.acl}25`,borderRadius:8,padding:'7px 10px'}}>
                  <div style={{color:T.acl,fontSize:9,fontWeight:700,marginBottom:2}}>🤖 AI 리뷰</div>
                  <div style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{e.aiReview}</div>
                </div>
              )}
            </Card>
          );
        })
      )}
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
  const [userRole,setUserRole]=useState<string|null>(null);
  const isAdminUser = userRole === 'admin';
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        const {getSupabaseClient}=await import('@/lib/supabase/client');
        const sb=getSupabaseClient();
        if(!sb) return;
        const {data:{user}}=await sb.auth.getUser();
        if(!user||cancelled) return;
        const {data:profile}=await sb.from('profiles').select('role').eq('id',user.id).single();
        if(!cancelled&&profile?.role) setUserRole(profile.role);
      }catch{}
    })();
    return()=>{cancelled=true;};
  },[]);

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
              {isAdminUser&&<a href="/admin" style={{padding:'9px 14px',background:'rgba(16,185,129,0.1)',color:'#10B981',border:'1px solid rgba(16,185,129,0.3)',borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer',textDecoration:'none'}}>🛡️ 관리자</a>}
            </div>
          </Card>

          {/* Language */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🌍 언어</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:7}}>
              {LANGS.map(l=>(
                <button key={l.id} onClick={()=>setLang(l.id)} style={{background:lang===l.id?T.acg:'transparent',color:lang===l.id?T.acl:T.txt,border:`1px solid ${lang===l.id?T.acl:T.border}`,borderRadius:10,padding:'8px 4px',cursor:'pointer',textAlign:'center'}}>
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
  const [tab,setTab] = useState<'feed'|'strategy'|'board'|'qa'|'journal'|'profit'|'notice'>('feed');

  const TABS = [
    {id:'feed',      icon:'📱', label:'피드'},
    {id:'strategy',  icon:'🤖', label:'전략 공유'},
    {id:'board',     icon:'💬', label:'자유게시판'},
    {id:'qa',        icon:'❓', label:'질문/답변'},
    {id:'journal',   icon:'📝', label:'일지 공유'},
    {id:'profit',    icon:'💰', label:'수익 인증'},
    {id:'notice',    icon:'📢', label:'공지'},
  ] as const;

  const FEED_POSTS = [
    {id:'f1',user:'@cryptoking',badge:'👑',time:'5분 전',text:'BTC 9400만 돌파! 반감기 이후 상승세 지속. 장투 홀더 수고하셨어요 💪',likes:142,comments:28,tags:['BTC','장투']},
    {id:'f2',user:'@wallst_pro',badge:'🥈',time:'12분 전',text:'NVDA 실적 내일. AI 수요 지속으로 어닝서프라이즈 예상. ⚠️ 투자 조언 아님.',likes:89,comments:15,tags:['NVDA','주식']},
    {id:'f3',user:'@dca_master',badge:'',time:'30분 전',text:'ETH 주간 DCA 완료. 평단 420만원. DCA는 감정 없이 실행이 핵심!',likes:201,comments:44,tags:['ETH','DCA']},
    {id:'f4',user:'@scalper_kr',badge:'',time:'1시간 전',text:'SOL 단타 +3.2% 성공. 지지선 반등 포착. 모의매매 연습 덕분에 타이밍 잡았습니다.',likes:67,comments:12,tags:['SOL','단타']},
  ];

  const STRATEGIES = [
    {id:'s1',user:'@cryptoking',badge:'👑',name:'BTC EMA Pro',pnl:'+24.8%',winRate:'67%',subs:1842,desc:'EMA20/50/200 다중 타임프레임 추세 추종 전략. BTC 5분봉 최적화.',tags:['BTC','추세'],verified:true},
    {id:'s2',user:'@dca_master',badge:'',name:'ETH DCA Master',pnl:'+38.1%',winRate:'83%',subs:987,desc:'월 4회 ETH DCA + RSI 30 이하 추가매수 전략.',tags:['ETH','DCA'],verified:true},
    {id:'s3',user:'@ai_trader',badge:'🤖',name:'AI Regime Strategy',pnl:'+42.1%',winRate:'52%',subs:444,desc:'시장 국면 AI 분류 + 자동 레버리지 조정 전략.',tags:['AI','자동'],verified:false},
  ];

  const BOARD_POSTS = [
    {id:'b1',user:'@newbie_kr',time:'2시간 전',title:'초보자도 TRAIGO 사용할 수 있나요?',views:342,likes:28,comments:15,category:'질문'},
    {id:'b2',user:'@chart_pro',time:'3시간 전',title:'TradingView 웹훅 설정 완전 가이드',views:1204,likes:94,comments:31,category:'가이드'},
    {id:'b3',user:'@btcmaxi',time:'5시간 전',title:'비트코인 반감기 이후 역대 수익률 분석',views:2847,likes:213,comments:87,category:'분석'},
  ];

  const QA_POSTS = [
    {id:'q1',user:'@learner_kr',time:'1시간 전',title:'손절 라인을 어떻게 설정해야 하나요?',solved:true,answers:8,likes:34},
    {id:'q2',user:'@trader_new',time:'4시간 전',title:'RSI와 MACD 함께 사용하는 방법?',solved:false,answers:3,likes:19},
    {id:'q3',user:'@beginner_sol',time:'어제',title:'DCA 투자 금액은 어떻게 정하나요?',solved:true,answers:12,likes:56},
  ];

  const PROFIT_POSTS = [
    {id:'p1',user:'@cryptoking',badge:'👑',time:'오전',asset:'BTC',pnl:'+₩1,240,000',pct:'+8.3%',side:'롱',mode:'모의'},
    {id:'p2',user:'@nvda_trader',badge:'',time:'어제',asset:'NVDA',pnl:'+₩380,000',pct:'+5.7%',side:'매수',mode:'모의'},
    {id:'p3',user:'@eth_dca',badge:'',time:'어제',asset:'ETH',pnl:'+₩680,000',pct:'+3.2%',side:'롱',mode:'모의'},
  ];

  const NOTICES = [
    {id:'n1',time:'2025-05-16',title:'TRAIGO v8 업데이트 — Analysis Hub · PWA · 드로잉 시스템 대폭 강화',important:true},
    {id:'n2',time:'2025-05-10',title:'WUNDER 자동매매 봇 베타 출시 — Pine Script 연동 지원',important:true},
    {id:'n3',time:'2025-05-01',title:'신규 기능: 경제 캘린더 · 뉴스 상세 · 왓치리스트 추가/제거',important:false},
  ];

  const PostCard = ({p, children}:{p:any; children?: React.ReactNode}) => (
    <Card style={{padding:'14px 16px',marginBottom:8}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
        <div style={{display:'flex',gap:6,alignItems:'center'}}>
          <div style={{width:28,height:28,borderRadius:8,background:T.acg,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:900,color:T.acl}}>{(p.user||'?')[1]?.toUpperCase()||'?'}</div>
          <div>
            <div style={{display:'flex',gap:4,alignItems:'center'}}>
              <span style={{color:T.txt,fontSize:12,fontWeight:700}}>{p.user}</span>
              {p.badge&&<span style={{fontSize:12}}>{p.badge}</span>}
              {p.verified&&<span style={{color:T.acl,fontSize:11}}>✓</span>}
            </div>
            <div style={{color:T.muted,fontSize:9,marginTop:1}}>{p.time}</div>
          </div>
        </div>
        {children}
      </div>
      {p.title&&<div style={{color:T.txt,fontSize:13,fontWeight:700,marginBottom:4}}>{p.title}</div>}
      {p.text&&<div style={{color:T.sub,fontSize:12,lineHeight:1.6,marginBottom:8}}>{p.text}</div>}
      {(p.tags||[]).length>0&&(
        <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:8}}>
          {p.tags.map((t:string)=><span key={t} style={{background:T.alt,color:T.muted,fontSize:9,padding:'1px 6px',borderRadius:5}}>#{t}</span>)}
        </div>
      )}
    </Card>
  );

  return (
    <div>
      <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'8px 12px',marginBottom:10}}>
        <div style={{color:T.ylw,fontWeight:700,fontSize:10}}>⚠️ 모든 성과는 모의투자 기준 · 실제 수익 보장 없음</div>
      </div>

      {/* Tabs */}
      <div style={{display:'flex',gap:4,overflowX:'auto',paddingBottom:4,marginBottom:12}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{flexShrink:0,padding:'5px 10px',background:tab===t.id?T.acg:'transparent',color:tab===t.id?T.acl:T.muted,border:`1px solid ${tab===t.id?T.acl:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab==='feed'&&(
        <div>
          {FEED_POSTS.map(p=>(
            <PostCard key={p.id} p={p}>
              <div style={{display:'flex',gap:8,color:T.muted,fontSize:10}}>
                <span>❤️ {p.likes}</span><span>💬 {p.comments}</span>
              </div>
            </PostCard>
          ))}
        </div>
      )}

      {tab==='strategy'&&(
        <div>
          {STRATEGIES.map(s=>(
            <Card key={s.id} style={{padding:'14px 16px',marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                <div><div style={{color:T.txt,fontWeight:700,fontSize:13}}>{s.name}{s.verified&&<span style={{color:T.acl,fontSize:11,marginLeft:4}}>✓</span>}</div><div style={{color:T.muted,fontSize:10}}>{s.user} {s.badge} · 구독 {s.subs.toLocaleString()}명</div></div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.grn,fontWeight:800,fontSize:13}}>{s.pnl}</div>
                  <div style={{color:T.muted,fontSize:9}}>승률 {s.winRate}</div>
                </div>
              </div>
              <div style={{color:T.sub,fontSize:11,marginBottom:8,lineHeight:1.5}}>{s.desc}</div>
              <div style={{display:'flex',gap:4,marginBottom:8}}>
                {s.tags.map((t:string)=><span key={t} style={{background:T.alt,color:T.muted,fontSize:9,padding:'1px 6px',borderRadius:5}}>#{t}</span>)}
              </div>
              <button style={{width:'100%',padding:'8px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:9,fontSize:11,fontWeight:700,cursor:'pointer'}}>⭐ 전략 구독 (모의)</button>
            </Card>
          ))}
        </div>
      )}

      {tab==='board'&&(
        <div>
          {BOARD_POSTS.map(p=>(
            <Card key={p.id} style={{padding:'12px 14px',marginBottom:6,cursor:'pointer'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:4}}>
                <span style={{background:T.acl+'20',color:T.acl,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:5}}>{p.category}</span>
                <div style={{display:'flex',gap:8,color:T.muted,fontSize:9}}>
                  <span>👁 {p.views}</span><span>❤️ {p.likes}</span><span>💬 {p.comments}</span>
                </div>
              </div>
              <div style={{color:T.txt,fontSize:12,fontWeight:600,marginBottom:3}}>{p.title}</div>
              <div style={{color:T.muted,fontSize:9}}>{p.user} · {p.time}</div>
            </Card>
          ))}
        </div>
      )}

      {tab==='qa'&&(
        <div>
          {QA_POSTS.map(p=>(
            <Card key={p.id} style={{padding:'12px 14px',marginBottom:6,cursor:'pointer'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:4}}>
                <span style={{background:p.solved?T.grn+'20':T.ylw+'20',color:p.solved?T.grn:T.ylw,fontSize:9,fontWeight:700,padding:'1px 7px',borderRadius:5}}>{p.solved?'✅ 해결됨':'미해결'}</span>
                <div style={{display:'flex',gap:8,color:T.muted,fontSize:9}}><span>💬 {p.answers}</span><span>❤️ {p.likes}</span></div>
              </div>
              <div style={{color:T.txt,fontSize:12,fontWeight:600,marginBottom:3}}>{p.title}</div>
              <div style={{color:T.muted,fontSize:9}}>{p.user} · {p.time}</div>
            </Card>
          ))}
        </div>
      )}

      {tab==='journal'&&(
        <div style={{textAlign:'center',padding:'30px 0'}}>
          <div style={{fontSize:32,marginBottom:8}}>📝</div>
          <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:6}}>공유된 매매일지</div>
          <div style={{color:T.muted,fontSize:11}}>커뮤니티 일지 공유 기능 준비 중</div>
        </div>
      )}

      {tab==='profit'&&(
        <div>
          {PROFIT_POSTS.map(p=>(
            <Card key={p.id} style={{padding:'14px 16px',marginBottom:8,border:`1px solid ${T.grn}20`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <div style={{width:28,height:28,borderRadius:8,background:T.grn+'20',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:900,color:T.grn}}>{(p.user||'?')[1]?.toUpperCase()||'?'}</div>
                  <div><div style={{color:T.txt,fontSize:12,fontWeight:700}}>{p.user} {p.badge}</div><div style={{color:T.muted,fontSize:9}}>{p.time} · {p.asset} {p.side}</div></div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.grn,fontWeight:900,fontSize:14}}>{p.pnl}</div>
                  <div style={{color:T.grn,fontSize:10}}>{p.pct}</div>
                  <div style={{color:T.muted,fontSize:8}}>{p.mode}</div>
                </div>
              </div>
            </Card>
          ))}
          <div style={{marginTop:8,color:T.muted,fontSize:9,textAlign:'center'}}>모든 수익은 모의투자 기준 · 실제 수익 보장 없음</div>
        </div>
      )}

      {tab==='notice'&&(
        <div>
          {NOTICES.map(n=>(
            <Card key={n.id} style={{padding:'12px 14px',marginBottom:6,border:`1px solid ${n.important?T.acl:T.border}20`}}>
              <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:3}}>
                {n.important&&<span style={{background:T.red+'20',color:T.red,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:5}}>중요</span>}
                <span style={{color:T.muted,fontSize:9}}>{n.time}</span>
              </div>
              <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{n.title}</div>
            </Card>
          ))}
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

  const totalBalance=(accounts||[]).reduce((s,a)=>s+(a?.balance||0),0);
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
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:301,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px calc(40px + env(safe-area-inset-bottom, 0px))',maxWidth:480,margin:'0 auto',border:`2px solid ${T.red}`}}>
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
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200,touchAction:'none'}} onClick={()=>setShowConfirm(false)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px calc(40px + env(safe-area-inset-bottom, 0px))',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
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
                const CORR_MATRIX:Record<string,Record<string,number>>={BTC:{BTC:1,ETH:.85,AAPL:.42,NDX:.38,GLD:.15},ETH:{BTC:.85,ETH:1,AAPL:.39,NDX:.35,GLD:.12},AAPL:{BTC:.42,ETH:.39,AAPL:1,NDX:.91,GLD:-.08},NDX:{BTC:.38,ETH:.35,AAPL:.91,NDX:1,GLD:-.12},GLD:{BTC:.15,ETH:.12,AAPL:-.08,NDX:-.12,GLD:1}};
                const corr=(CORR_MATRIX[r]?.[c]??0);
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
              <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200,touchAction:'none'}} onClick={()=>setGrantModal(null)}/>
              <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px calc(40px + env(safe-area-inset-bottom, 0px))',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
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
  const [filter,setFilter]   = useState<'all'|'high'|'medium'|'low'>('all');
  const [country,setCountry] = useState('전체');
  const [selected,setSelected] = useState<any>(null);
  const [events,setEvents]   = useState<any[]>([]);
  const [loading,setLoading] = useState(true);

  const impactC:Record<string,string> = { high:T.red, medium:T.ylw, low:T.grn };
  const COUNTRIES = ['전체','US','EU','KR','JP','CN','UK'];

  // Fetch from Finnhub (server-side) or mock
  useEffect(()=>{
    setLoading(true);
    fetch('/api/finnhub?action=calendar')
      .then(r=>r.json())
      .then(d=>{ setEvents(Array.isArray(d.events) ? d.events : []); })
      .catch(()=>setEvents([]))
      .finally(()=>setLoading(false));
  },[]);

  const filtered = events.filter(e=>{
    const matchImpact  = filter==='all' || e.impact===filter;
    const matchCountry = country==='전체' || e.country===country;
    return matchImpact && matchCountry;
  });

  const eventDescriptions: Record<string,string> = {
    'CPI':'소비자물가지수 — 인플레이션의 핵심 지표. 예상 상회 시 긴축 가능성 ↑ (주식 하락 압력)',
    'FOMC':'연방공개시장위원회 — Fed 금리 결정. 시장 방향성에 가장 큰 영향',
    'NFP':'비농업고용 — 고용시장 강도 지표. 강한 고용 → 금리 인상 우려',
    'GDP':'국내총생산 성장률 — 경기 상태 척도',
    'PPI':'생산자물가지수 — 기업의 생산 비용 변화',
    'PMI':'구매관리자지수 — 50 이상 경기 확장, 50 이하 수축',
    'ECB':'유럽중앙은행 금리 결정',
    '금통위':'한국은행 기준금리 결정',
  };

  if(selected) return (
    <div>
      <button onClick={()=>setSelected(null)} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,color:T.muted,padding:'5px 12px',fontSize:12,cursor:'pointer',marginBottom:12}}>← 목록으로</button>
      <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:6}}>{selected.event}</div>
      <div style={{display:'flex',gap:8,marginBottom:10}}>
        <span style={{background:impactC[selected.impact]+'20',color:impactC[selected.impact],fontSize:10,fontWeight:700,padding:'3px 8px',borderRadius:6}}>{selected.impact==='high'?'🔴 고영향':selected.impact==='medium'?'🟡 중영향':'🟢 저영향'}</span>
        <span style={{color:T.muted,fontSize:10}}>{selected.country} · {selected.date} {selected.time}</span>
      </div>
      {[...Object.entries(eventDescriptions)].filter(([k])=>selected.event?.includes(k)).map(([k,desc])=>(
        <Card key={k} style={{padding:'12px 14px',marginBottom:8,background:T.acl+'08',border:`1px solid ${T.acl}20`}}>
          <div style={{color:T.acl,fontSize:10,fontWeight:700,marginBottom:4}}>📘 이벤트 설명</div>
          <div style={{color:T.sub,fontSize:12,lineHeight:1.65}}>{desc}</div>
        </Card>
      ))}
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:10}}>
        {[{l:'예측',v:selected.forecast},{l:'이전',v:selected.previous},{l:'실제',v:selected.actual}].map(d=>(
          d.v&&<Card key={d.l} style={{padding:'10px 8px',textAlign:'center'}}>
            <div style={{color:T.muted,fontSize:9}}>{d.l}</div>
            <div style={{color:T.txt,fontWeight:700,fontSize:14,marginTop:3}}>{d.v}{selected.unit||''}</div>
          </Card>
        ))}
      </div>
      <Card style={{padding:'12px 14px',background:'#0A1628',border:`1px solid ${T.red}30`}}>
        <div style={{color:T.red,fontWeight:700,fontSize:10,marginBottom:4}}>⚠️ 트레이딩 주의</div>
        <div style={{color:T.muted,fontSize:11,lineHeight:1.6}}>고영향 이벤트 발표 30분 전후에는 변동성이 급격히 증가합니다. 기존 포지션 리스크를 점검하고 무리한 레버리지 사용을 피하세요.</div>
      </Card>
    </div>
  );

  return (
    <div>
      {/* Filters */}
      <div style={{display:'flex',gap:6,marginBottom:8}}>
        {([['all','전체'],['high','고영향'],['medium','중영향'],['low','저영향']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setFilter(id)} style={{flex:1,padding:'6px',background:filter===id?impactC[id==='all'?'high':id]+'20':T.alt,color:filter===id?(id==='all'?T.acl:impactC[id]):T.muted,border:`1px solid ${filter===id?(id==='all'?T.acl:impactC[id]):T.border}`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>
      <div style={{display:'flex',gap:5,overflowX:'auto',paddingBottom:4,marginBottom:10}}>
        {COUNTRIES.map(c=>(
          <button key={c} onClick={()=>setCountry(c)} style={{flexShrink:0,padding:'4px 10px',background:country===c?T.acg:'transparent',color:country===c?T.acl:T.muted,border:`1px solid ${country===c?T.acl:T.border}`,borderRadius:16,fontSize:10,fontWeight:700,cursor:'pointer'}}>{c}</button>
        ))}
      </div>

      {loading?(
        <div>{[0,1,2,3].map(i=>(
          <div key={i} style={{background:T.card,borderRadius:12,padding:'14px',marginBottom:8}}>
            <div style={{height:12,background:'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)',backgroundSize:'200% 100%',animation:'shimmer 1.2s infinite',borderRadius:4,marginBottom:6,width:'70%'}}/>
            <div style={{height:10,background:'linear-gradient(90deg,#1A2D4A 25%,#243A5E 50%,#1A2D4A 75%)',backgroundSize:'200% 100%',animation:'shimmer 1.2s infinite',borderRadius:4,width:'40%'}}/>
          </div>
        ))}</div>
      ):filtered.length===0?(
        <div style={{textAlign:'center',padding:'40px 0'}}>
          <div style={{fontSize:32,marginBottom:8}}>📅</div>
          <div style={{color:T.muted,fontSize:13}}>해당 조건의 경제 이벤트가 없습니다</div>
        </div>
      ):filtered.map(e=>(
        <Card key={e.id} style={{padding:'12px 14px',marginBottom:8,cursor:'pointer',borderLeft:`3px solid ${impactC[e.impact]||T.border}`}} onClick={()=>setSelected(e)}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:3}}>{e.event}</div>
              <div style={{display:'flex',gap:8,color:T.muted,fontSize:10}}>
                <span>{e.country}</span><span>{e.date}</span><span>{e.time}</span>
              </div>
            </div>
            <div style={{textAlign:'right',flexShrink:0,marginLeft:8}}>
              <div style={{color:impactC[e.impact],fontWeight:700,fontSize:10}}>{e.impact==='high'?'🔴':e.impact==='medium'?'🟡':'🟢'} {e.impact}</div>
              {e.forecast&&<div style={{color:T.muted,fontSize:9,marginTop:2}}>예측 {e.forecast}{e.unit||''}</div>}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function EventRow({ ev, onClick, impactC, impactL }: { ev:any; onClick:()=>void; impactC:Record<string,string>; impactL:Record<string,string> }) {
  const ic = impactC[ev.impact] || T.muted;
  return (
    <div onClick={onClick} style={{background:T.card,border:`1px solid ${ev.impact==='high'?ic+'30':T.border}`,borderRadius:12,padding:'11px 14px',marginBottom:6,cursor:'pointer'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:5}}>
        <div style={{display:'flex',gap:5,alignItems:'center',flex:1}}>
          <span style={{fontSize:14,flexShrink:0}}>{ev.country}</span>
          <span style={{color:T.txt,fontWeight:700,fontSize:12,lineHeight:1.3}}>{ev.event}</span>
        </div>
        <span style={{background:`${ic}20`,color:ic,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99,flexShrink:0,marginLeft:8}}>{impactL[ev.impact]||ev.impact}</span>
      </div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div style={{display:'flex',gap:10}}>
          <span style={{color:T.muted,fontSize:9}}>🕐 {ev.time}</span>
          {ev.previous && <span style={{color:T.muted,fontSize:9}}>이전: {ev.previous}</span>}
          {ev.forecast && <span style={{color:T.acl,fontSize:9}}>예측: {ev.forecast}</span>}
          {ev.actual   && <span style={{color:T.grn,fontSize:9,fontWeight:700}}>실제: {ev.actual}</span>}
        </div>
        {ev.impact === 'high' && <span style={{color:T.red,fontSize:9}}>⚠️ 변동성↑</span>}
      </div>
      {ev.note && <div style={{color:T.ylw,fontSize:9,marginTop:3}}>{ev.note}</div>}
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
  const [year, setYear]  = useState(() => {
    if (typeof window === 'undefined') return '2025';
    try { return localStorage.getItem('tg_tax_year') || '2025'; } catch { return '2025'; }
  });
  const [tab, setTab]    = useState<'summary'|'history'|'export'>('summary');
  const [loading, setLoading] = useState(false);

  // Persist year selection
  const selectYear = (y: string) => {
    setLoading(true);
    setYear(y);
    try { localStorage.setItem('tg_tax_year', y); } catch {}
    setTimeout(() => setLoading(false), 300);
  };

  // Load journal entries (real data)
  const journalEntries: any[] = (() => {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem('tg_journal_v1') || '[]'); } catch { return []; }
  })();

  // Filter by selected year
  const yearEntries = journalEntries.filter(e => {
    const d = e.date || e.createdAt || '';
    return d.startsWith(year);
  });

  // Year-specific mock data (different per year to show filtering works)
  const YEAR_DATA: Record<string, any> = {
    '2023': {realized:1240000,unrealized:480000,fee:58000,net:1182000,taxRate:22,trades:18,winTrades:11,lossTrades:7,
      monthly:[{m:'1월',pnl:0,trades:0},{m:'2월',pnl:0,trades:0},{m:'3월',pnl:120000,trades:3},{m:'4월',pnl:-30000,trades:2},{m:'5월',pnl:80000,trades:3},{m:'6월',pnl:220000,trades:4},{m:'7월',pnl:180000,trades:2},{m:'8월',pnl:-40000,trades:1},{m:'9월',pnl:310000,trades:2},{m:'10월',pnl:0,trades:0},{m:'11월',pnl:200000,trades:1},{m:'12월',pnl:200000,trades:0}],
      history:[{date:'2023-09-12',asset:'BTC/USDT',side:'buy',amount:800000,pnl:240000,fee:400,type:'현물'},{date:'2023-06-28',asset:'ETH/USDT',side:'sell',amount:500000,pnl:130000,fee:250,type:'현물'},{date:'2023-04-15',asset:'AAPL',side:'buy',amount:300000,pnl:-30000,fee:150,type:'주식CFD'}]},
    '2024': {realized:5480000,unrealized:2100000,fee:218000,net:5262000,taxRate:22,trades:34,winTrades:22,lossTrades:12,
      monthly:[{m:'1월',pnl:680000,trades:4},{m:'2월',pnl:320000,trades:3},{m:'3월',pnl:-180000,trades:5},{m:'4월',pnl:540000,trades:4},{m:'5월',pnl:1100000,trades:6},{m:'6월',pnl:820000,trades:4},{m:'7월',pnl:-200000,trades:3},{m:'8월',pnl:940000,trades:2},{m:'9월',pnl:1180000,trades:3},{m:'10월',pnl:280000,trades:0},{m:'11월',pnl:0,trades:0},{m:'12월',pnl:0,trades:0}],
      history:[{date:'2024-09-05',asset:'NVDA',side:'sell',amount:800000,pnl:420000,fee:400,type:'주식CFD'},{date:'2024-07-22',asset:'BTC/USDT',side:'buy',amount:2000000,pnl:-180000,fee:1000,type:'선물'},{date:'2024-05-14',asset:'ETH/USDT',side:'sell',amount:600000,pnl:240000,fee:300,type:'현물'},{date:'2024-03-01',asset:'SOL/USDT',side:'buy',amount:400000,pnl:-90000,fee:200,type:'현물'},{date:'2024-01-08',asset:'SPY',side:'buy',amount:500000,pnl:200000,fee:250,type:'ETF CFD'}]},
    '2025': {realized:2870000,unrealized:1230000,fee:124000,net:2746000,taxRate:22,trades:47,winTrades:32,lossTrades:15,
      monthly:[{m:'1월',pnl:480000,trades:8},{m:'2월',pnl:-120000,trades:6},{m:'3월',pnl:640000,trades:10},{m:'4월',pnl:310000,trades:7},{m:'5월',pnl:1560000,trades:16},{m:'6월',pnl:0,trades:0},{m:'7월',pnl:0,trades:0},{m:'8월',pnl:0,trades:0},{m:'9월',pnl:0,trades:0},{m:'10월',pnl:0,trades:0},{m:'11월',pnl:0,trades:0},{m:'12월',pnl:0,trades:0}],
      history:[{date:'2025-05-10',asset:'BTC/USDT',side:'buy',amount:500000,pnl:87000,fee:250,type:'선물'},{date:'2025-05-08',asset:'NVDA',side:'sell',amount:280000,pnl:54000,fee:140,type:'주식CFD'},{date:'2025-05-05',asset:'ETH/USDT',side:'buy',amount:200000,pnl:-12000,fee:100,type:'선물'},{date:'2025-04-28',asset:'SOL/USDT',side:'sell',amount:150000,pnl:45000,fee:75,type:'현물'},{date:'2025-04-20',asset:'SPY',side:'buy',amount:400000,pnl:32000,fee:200,type:'ETF CFD'}]},
  };

  // Merge real journal entries into year data
  const base = YEAR_DATA[year] || YEAR_DATA['2025'];
  const journalPnl = yearEntries.reduce((s:number, e:any) => s + (Number(e.pnl)||0), 0);
  const YEARLY = {
    ...base,
    realized:  base.realized + journalPnl,
    net:       base.net + journalPnl,
    taxEst:    Math.round((base.net + journalPnl) * base.taxRate / 100),
    trades:    base.trades + yearEntries.length,
    winTrades: base.winTrades + yearEntries.filter((e:any)=>(e.pnl||0)>0).length,
    lossTrades:base.lossTrades + yearEntries.filter((e:any)=>(e.pnl||0)<0).length,
  };

  const MONTHLY = base.monthly;
  const maxPnl  = Math.max(1, ...MONTHLY.map(m => Math.abs(m.pnl)));
  const HISTORY = [
    ...yearEntries.map((e:any,i:number) => ({
      date: e.date||'—', asset: e.sym||'—', side: e.side==='매수'?'buy':'sell',
      amount: Math.abs(e.pnl||0)*10, pnl: e.pnl||0, fee: Math.round(Math.abs(e.pnl||0)*0.001)||0, type: '일지'
    })),
    ...base.history,
  ];

  const hasData = base.trades > 0 || yearEntries.length > 0;

  const csvExport = () => {
    const rows = [['날짜','종목','방향','금액','손익','수수료','유형'],...HISTORY.map(h=>[h.date,h.asset,h.side,h.amount,h.pnl,h.fee,h.type])];
    const csv = rows.map(r=>r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href=url; a.download=`TRAIGO_${year}_손익.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{opacity:loading?0.6:1,transition:'opacity .3s'}}>
      {/* Year selector */}
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {['2023','2024','2025'].map(y=>(
          <button key={y} onClick={()=>selectYear(y)} style={{flex:1,padding:'10px',background:year===y?T.acg:'transparent',color:year===y?T.acl:T.muted,border:`2px solid ${year===y?T.acl:T.border}`,borderRadius:10,fontSize:13,fontWeight:700,cursor:'pointer',transition:'all .15s'}}>
            {y}년{year===y&&<span style={{marginLeft:5,fontSize:9,background:T.acl,color:'#fff',borderRadius:99,padding:'1px 5px'}}>선택</span>}
          </button>
        ))}
      </div>

      {/* No data state */}
      {!hasData && (
        <div style={{textAlign:'center',padding:'40px 0',marginBottom:14}}>
          <div style={{fontSize:32,marginBottom:8}}>📭</div>
          <div style={{color:T.muted,fontSize:13,fontWeight:600}}>{year}년 거래 기록이 없습니다.</div>
          <div style={{color:T.muted,fontSize:10,marginTop:4}}>매매일지 탭에서 거래를 기록해보세요.</div>
        </div>
      )}

      {/* Tabs */}
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {([['summary','📊 요약'],['history','📋 거래내역'],['export','📥 내보내기']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:'8px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {tab==='summary'&&(
        <div>
          <div style={{background:'linear-gradient(135deg,#0A1628,#0D1F3C)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
            <div style={{color:T.muted,fontSize:11,marginBottom:2}}>{year}년 순 실현손익 (모의)</div>
            <div style={{color:YEARLY.net>=0?T.grn:T.red,fontSize:28,fontWeight:900,fontFamily:'monospace'}}>{YEARLY.net>=0?'+':''}{cvt(YEARLY.net,currency)}</div>
            <div style={{display:'flex',gap:16,marginTop:8,flexWrap:'wrap'}}>
              {[{l:'실현손익',v:YEARLY.realized,c:T.grn},{l:'수수료',v:-YEARLY.fee,c:T.red},{l:'예상세금',v:-YEARLY.taxEst,c:T.red}].map(r=>(
                <div key={r.l}><div style={{color:T.muted,fontSize:10}}>{r.l}</div><div style={{color:r.c,fontWeight:700,fontSize:12}}>{r.v>=0?'+':''}{cvt(Math.abs(r.v),currency)}</div></div>
              ))}
            </div>
          </div>

          {/* Monthly bars */}
          <Card style={{padding:'14px 16px',marginBottom:14}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📊 {year}년 월별 손익</div>
            <div style={{display:'flex',gap:3,alignItems:'flex-end',height:80}}>
              {MONTHLY.map(m=>{
                const h = maxPnl > 0 ? Math.abs(m.pnl)/maxPnl*70 : 0;
                return (
                  <div key={m.m} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
                    <div style={{height:h||2,background:m.pnl>=0?T.grn:T.red,borderRadius:2,width:'100%',minHeight:m.pnl!==0?2:0,opacity:m.pnl===0?0.2:1}}/>
                    <div style={{color:T.muted,fontSize:7,fontWeight:600}}>{m.m.replace('월','')}</div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Stats */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:14}}>
            {[{l:'총 거래',v:`${YEARLY.trades}건`},{l:'수익',v:`${YEARLY.winTrades}건`},{l:'손실',v:`${YEARLY.lossTrades}건`},{l:'승률',v:YEARLY.trades>0?`${Math.round(YEARLY.winTrades/YEARLY.trades*100)}%`:'—'},{l:'세율',v:`${YEARLY.taxRate}%`},{l:'예상세금',v:cvt(YEARLY.taxEst,currency)}].map(s=>(
              <Card key={s.l} style={{padding:'10px 8px',textAlign:'center'}}>
                <div style={{color:T.muted,fontSize:9,marginBottom:3}}>{s.l}</div>
                <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{s.v}</div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {tab==='history'&&(
        <div>
          {HISTORY.length===0?(
            <div style={{textAlign:'center',padding:'30px 0',color:T.muted,fontSize:12}}>{year}년 거래내역 없음</div>
          ):(
            <Card style={{overflow:'hidden'}}>
              {HISTORY.map((h,i)=>(
                <div key={i} style={{padding:'10px 14px',borderBottom:i<HISTORY.length-1?`1px solid ${T.border}`:'none'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div>
                      <div style={{color:T.txt,fontSize:11,fontWeight:700}}>{h.asset}</div>
                      <div style={{color:T.muted,fontSize:9}}>{h.date} · {h.type}</div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{color:(h.pnl||0)>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{(h.pnl||0)>=0?'+':''}{cvt(Math.abs(h.pnl||0),currency)}</div>
                      <div style={{color:T.muted,fontSize:9}}>수수료 {cvt(h.fee,currency)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      {tab==='export'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📥 내보내기</div>
            <button onClick={csvExport} style={{width:'100%',padding:'12px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:11,fontWeight:700,fontSize:13,cursor:'pointer',marginBottom:8}}>
              📊 {year}년 CSV 다운로드
            </button>
            <div style={{color:T.muted,fontSize:10,textAlign:'center'}}>엑셀에서 열 수 있는 CSV 형식으로 내보냅니다.</div>
          </Card>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'10px 14px'}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11,marginBottom:4}}>⚠️ 세금 안내</div>
            <div style={{color:T.muted,fontSize:10,lineHeight:1.6}}>이 데이터는 모의투자 기록입니다. 실제 세금 신고는 공인 세무사와 상담하세요. 예상 세금 계산은 교육 목적입니다.</div>
          </div>
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
  const maxXP=(checklist||[]).reduce((s,c)=>s+(c?.xp||0),0);
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
   TRAIGO HEDGE OS — 완전한 AI 헤지펀드 운영 시스템
   Kill Switch · Drawdown · Unified Wallet · Strategy Marketplace
   · Liquidation Monitor · Auto Recovery · AI Portfolio
   ══════════════════════════════════════════════════════════════════ */

/* ─── Types ─── */
type KillSwitchTarget = 'all'|'selected_bots'|'selected_exchange'|'auto_only';
type DrawdownMode     = 'normal'|'cooldown'|'defensive'|'stopped';
type ApiPermission    = { read:boolean; spot:boolean; futures:boolean; withdrawal:boolean };
type WalletEntry      = { id:string; name:string; icon:string; type:string; balance:number; usdtEq:number; color:string; exchange:string };
type MarketplaceStrat = { id:string; name:string; author:string; pnl:number; winRate:number; subscribers:number; score:number; type:string; color:string; badge?:string; verified:boolean };
type LiquidationPos   = { asset:string; clr:string; side:'long'|'short'; size:number; entryPrice:number; liqPrice:number; distPct:number; leverage:number };
type ExchangeHealth   = { name:string; icon:string; status:'ok'|'slow'|'error'|'maintenance'; latency:number; wsStatus:boolean; lastCheck:string };
type RecoveryEvent    = { id:string; type:string; desc:string; action:string; time:string; resolved:boolean };
type BotMode          = 'normal'|'shadow'|'sandbox';

interface KillSwitchState {
  active: boolean; target: KillSwitchTarget;
  reason: string; activatedAt: string | null;
}

interface DrawdownState {
  daily:{ used:number; limit:number };
  weekly:{ used:number; limit:number };
  monthly:{ used:number; limit:number };
  mode: DrawdownMode; cooldownEndsAt: string | null;
}

/* ─── Initial data ─── */
const INIT_KILLSWITCH: KillSwitchState = {
  active:false, target:'all', reason:'', activatedAt:null,
};

const INIT_DRAWDOWN: DrawdownState = {
  daily:  {used:87000,  limit:500000},
  weekly: {used:187000, limit:2000000},
  monthly:{used:440000, limit:5000000},
  mode:'normal', cooldownEndsAt:null,
};

const MOCK_WALLET: WalletEntry[] = [
  {id:'w1',name:'Binance',icon:'🟡',type:'crypto',balance:15420000,usdtEq:11217,color:'#F0B90B',exchange:'binance'},
  {id:'w2',name:'Upbit',icon:'🔵',type:'crypto',balance:32100000,usdtEq:23346,color:'#2563EB',exchange:'upbit'},
  {id:'w3',name:'Gate.io',icon:'🔵',type:'crypto',balance:4800000,usdtEq:3491,color:'#3B82F6',exchange:'gateio'},
  {id:'w4',name:'현금 계좌',icon:'🏦',type:'cash',balance:8500000,usdtEq:6178,color:'#10B981',exchange:'bank'},
  {id:'w5',name:'ETF 계좌',icon:'📊',type:'etf',balance:12000000,usdtEq:8727,color:'#7C3AED',exchange:'broker'},
];

const MOCK_MARKETPLACE: MarketplaceStrat[] = [
  {id:'ms1',name:'WUNDER EMA Pro',author:'@wunder',pnl:24.8,winRate:67,subscribers:1842,score:89,type:'trend',color:'#3B82F6',badge:'👑 TOP',verified:true},
  {id:'ms2',name:'BTC RSI Reversal',author:'@cryptoking',pnl:18.2,winRate:71,subscribers:1203,score:82,type:'reversal',color:'#7C3AED',badge:'🔥 인기',verified:true},
  {id:'ms3',name:'DCA Master 3.0',author:'@dca_master',pnl:15.6,winRate:83,subscribers:987,score:91,type:'dca',color:'#10B981',badge:'🛡️ 안정',verified:true},
  {id:'ms4',name:'SOL Scalping',author:'@solscalp',pnl:31.2,winRate:58,subscribers:612,score:64,type:'scalping',color:'#F59E0B',verified:false},
  {id:'ms5',name:'Alt Rotation AI',author:'@ai_trader',pnl:42.1,winRate:52,subscribers:444,score:71,type:'ai',color:'#6366F1',badge:'🤖 AI',verified:true},
  {id:'ms6',name:'Hedge BTC+Alt',author:'@hedgemaster',pnl:8.4,winRate:74,subscribers:328,score:77,type:'hedge',color:'#0891B2',verified:true},
];

const MOCK_LIQ_POSITIONS: LiquidationPos[] = [
  {asset:'BTC',clr:'#F7931A',side:'long', size:0.02,entryPrice:91400000,liqPrice:83400000,distPct:8.75,leverage:3},
  {asset:'SOL',clr:'#9945FF',side:'long', size:5,   entryPrice:195000,  liqPrice:161000,  distPct:5.13,leverage:5},
  {asset:'ETH',clr:'#627EEA',side:'short',size:0.5, entryPrice:5900000, liqPrice:6490000, distPct:9.0, leverage:2},
];

const MOCK_EXCHANGE_HEALTH: ExchangeHealth[] = [
  {name:'Binance',icon:'🟡',status:'ok',latency:142,wsStatus:true,lastCheck:'방금'},
  {name:'Upbit',icon:'🔵',status:'ok',latency:88,wsStatus:true,lastCheck:'방금'},
  {name:'Gate.io',icon:'🔵',status:'slow',latency:892,wsStatus:true,lastCheck:'1분 전'},
  {name:'Bithumb',icon:'🟢',status:'ok',latency:203,wsStatus:true,lastCheck:'방금'},
  {name:'Bybit',icon:'🟡',status:'maintenance',latency:0,wsStatus:false,lastCheck:'10분 전'},
];

const MOCK_RECOVERY: RecoveryEvent[] = [
  {id:'r1',type:'WS 재연결',desc:'Binance WebSocket 연결 끊김',action:'3초 후 자동 재연결 성공',time:'09:32',resolved:true},
  {id:'r2',type:'API 타임아웃',desc:'Gate.io API 응답 지연 892ms',action:'폴링 모드로 전환',time:'08:15',resolved:true},
  {id:'r3',type:'포지션 불일치',desc:'SOL 포지션 0.1 단위 불일치 감지',action:'수동 확인 필요',time:'어제 22:00',resolved:false},
];

const MOCK_API_PERMS: Record<string,ApiPermission> = {
  'Binance': {read:true,spot:false,futures:true,withdrawal:false},
  'Gate.io':  {read:true,spot:true, futures:true,withdrawal:false},
  'Upbit':    {read:true,spot:true, futures:false,withdrawal:false},
};

/* ══════════════════════════════════════════════════════════════════
   HedgeOSPage Component
   ══════════════════════════════════════════════════════════════════ */
function HedgeOSPage() {
  const [tab,setTab]=useState<'control'|'wallet'|'market'|'monitor'|'recovery'>('control');
  const [ks,setKs]=useState<KillSwitchState>(INIT_KILLSWITCH);
  const [dd,setDd]=useState<DrawdownState>(INIT_DRAWDOWN);
  const [botMode,setBotMode]=useState<BotMode>('shadow');
  const [liqAlert,setLiqAlert]=useState(false);
  const [showConfirmKill,setShowConfirmKill]=useState(false);
  const [proMode,setProMode]=useState(false);
  const [sortMarket,setSortMarket]=useState<'score'|'pnl'|'subs'>('score');

  const totalBalance = (MOCK_WALLET||[]).reduce((s,w)=>s+(w?.balance||0),0);
  const totalUSDT    = (MOCK_WALLET||[]).reduce((s,w)=>s+(w?.usdtEq||0),0);
  const ddDailyPct   = dd.daily.used/dd.daily.limit*100;
  const ddWkPct      = dd.weekly.used/dd.weekly.limit*100;
  const sortedMarket = [...MOCK_MARKETPLACE].sort((a,b)=>
    sortMarket==='pnl'?b.pnl-a.pnl:sortMarket==='subs'?b.subscribers-a.subscribers:b.score-a.score
  );

  const activateKill=(target:KillSwitchTarget)=>{
    setKs({active:true,target,reason:'수동 긴급 정지',activatedAt:new Date().toLocaleTimeString('ko-KR')});
    setShowConfirmKill(false);
  };
  const deactivateKill=()=>setKs(INIT_KILLSWITCH);

  const statusColor=(s:ExchangeHealth['status'])=>
    s==='ok'?T.grn:s==='slow'?T.ylw:s==='error'?T.red:T.muted;

  /* ── Liquidation gauge ── */
  const LiqGauge=({pos}:{pos:LiquidationPos})=>{
    const danger=pos.distPct<5;
    const c=danger?T.red:pos.distPct<10?T.ylw:T.grn;
    return (
      <Card key={pos.asset} style={{padding:'12px 14px',marginBottom:8,border:`1px solid ${c}25`}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <div style={{width:28,height:28,borderRadius:7,background:`${pos.clr}20`,border:`1px solid ${pos.clr}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:900,color:pos.clr,flexShrink:0}}>{pos.asset.slice(0,2)}</div>
            <div>
              <div style={{display:'flex',gap:4,alignItems:'center'}}>
                <span style={{color:T.txt,fontWeight:700,fontSize:12}}>{pos.asset}</span>
                <span style={{background:pos.side==='long'?T.grn+'20':T.red+'20',color:pos.side==='long'?T.grn:T.red,fontSize:8,fontWeight:700,padding:'1px 5px',borderRadius:4}}>{pos.side.toUpperCase()}</span>
                <span style={{background:T.ylw+'15',color:T.ylw,fontSize:8,fontWeight:700,padding:'1px 5px',borderRadius:4}}>{pos.leverage}x</span>
              </div>
              <div style={{color:T.muted,fontSize:9,marginTop:1}}>진입 {cvt(pos.entryPrice,'KRW')} → 청산 {cvt(pos.liqPrice,'KRW')}</div>
            </div>
          </div>
          <div style={{textAlign:'right',flexShrink:0}}>
            <div style={{color:c,fontWeight:900,fontSize:14}}>{pos.distPct.toFixed(1)}%</div>
            <div style={{color:T.muted,fontSize:9}}>청산까지</div>
          </div>
        </div>
        <div style={{height:5,background:'#1A2D4A',borderRadius:3,overflow:'hidden'}}>
          <div style={{height:'100%',width:`${Math.min(100,100-pos.distPct*5)}%`,background:c,borderRadius:3,transition:'width .5s'}}/>
        </div>
        {danger&&<div style={{marginTop:5,color:T.red,fontSize:9,fontWeight:700}}>⚠️ 청산 위험 — 즉시 확인 필요</div>}
      </Card>
    );
  };

  return (
    <div>
      {/* Header */}
      <div style={{background:'linear-gradient(135deg,#04060F,#080D1A)',border:`1px solid ${ks.active?T.red:T.acl}40`,borderRadius:18,padding:'14px 16px',marginBottom:14}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
          <div>
            <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:3}}>
              <span style={{fontSize:18}}>🏦</span>
              <span style={{color:T.txt,fontWeight:900,fontSize:15}}>TRAIGO Hedge OS</span>
              {ks.active&&<Bdg c={T.red} ch="🚨 긴급 정지 활성화"/>}
            </div>
            <div style={{color:T.muted,fontSize:10}}>Kill Switch · 드로다운 보호 · 유니파이드 월렛 · AI 포트폴리오 · 거래소 모니터</div>
          </div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <button onClick={()=>setProMode(v=>!v)} style={{background:proMode?T.prp+'20':'transparent',color:proMode?T.prp:T.muted,border:`1px solid ${proMode?T.prp:T.border}`,borderRadius:8,padding:'4px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{proMode?'⚡ PRO':'👤 일반'}</button>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
          {[
            {l:'총 자산',v:cvt(totalBalance,'KRW'),c:T.txt},
            {l:'USDT 환산',v:`$${totalUSDT.toLocaleString()}`,c:T.acl},
            {l:'봇 모드',v:botMode==='shadow'?'👁 섀도우':botMode==='sandbox'?'🧪 샌드박스':'▶ 실행',c:botMode==='shadow'?T.prp:botMode==='sandbox'?T.ylw:T.grn},
            {l:'일일 DD',v:`${ddDailyPct.toFixed(0)}%`,c:ddDailyPct>70?T.red:ddDailyPct>40?T.ylw:T.grn},
          ].map(s=>(
            <div key={s.l} style={{background:'rgba(0,0,0,.4)',borderRadius:8,padding:'6px 7px',textAlign:'center'}}>
              <div style={{color:s.c,fontSize:11,fontWeight:800}}>{s.v}</div>
              <div style={{color:T.muted,fontSize:8,marginTop:1}}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Bot mode selector */}
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {([['shadow','👁 섀도우 모드','전략 실행, 주문 미실행',T.prp],['sandbox','🧪 샌드박스','모의 환경 실행',T.ylw],['normal','▶ 실전','실제 API 실행 (준비중)',T.grn]] as const).map(([id,l,d,c])=>(
          <button key={id} onClick={()=>setBotMode(id)} style={{flex:1,padding:'8px 4px',background:botMode===id?c+'15':'transparent',color:botMode===id?c:T.muted,border:`2px solid ${botMode===id?c:T.border}`,borderRadius:12,cursor:'pointer',textAlign:'center'}}>
            <div style={{fontSize:11,fontWeight:700}}>{l}</div>
            <div style={{color:T.muted,fontSize:8,marginTop:2}}>{d}</div>
          </button>
        ))}
      </div>
      {botMode==='normal'&&<div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:10,padding:'9px 13px',marginBottom:12}}><div style={{color:T.red,fontWeight:700,fontSize:11}}>⚠️ 실전 모드 — 현재 비활성화. 거래소 API 연결 + 출금 권한 차단 확인 필요</div></div>}

      {/* Sub tabs */}
      <div style={{display:'flex',gap:5,marginBottom:14,overflowX:'auto'}}>
        {([['control','🚨 제어'],['wallet','💼 월렛'],['market','🏪 마켓플레이스'],['monitor','📡 모니터'],['recovery','🔄 복구']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'7px 11px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* ── CONTROL ── */}
      {tab==='control'&&(
        <div>
          {/* Kill switch */}
          <Card style={{padding:'16px',marginBottom:12,border:`2px solid ${ks.active?T.red:T.border}`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div>
                <div style={{color:ks.active?T.red:T.txt,fontWeight:800,fontSize:14}}>🚨 킬 스위치 (Kill Switch)</div>
                <div style={{color:T.muted,fontSize:11}}>모든 자동매매를 즉시 중단합니다</div>
                {ks.active&&<div style={{color:T.red,fontSize:10,marginTop:3}}>⏰ {ks.activatedAt} 활성화됨 · {ks.reason}</div>}
              </div>
              {ks.active
                ? <button onClick={deactivateKill} style={{background:T.grn+'20',color:T.grn,border:`1px solid ${T.grn}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>✅ 해제</button>
                : <button onClick={()=>setShowConfirmKill(true)} style={{background:T.red+'20',color:T.red,border:`1px solid ${T.red}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>🚨 실행</button>
              }
            </div>
            {!ks.active&&(
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
                {([['all','전체 봇 정지'],['selected_bots','선택된 봇만'],['selected_exchange','거래소 선택'],['auto_only','자동매매만']] as const).map(([t,l])=>(
                  <button key={t} onClick={()=>activateKill(t)} style={{background:T.red+'10',color:T.red,border:`1px solid ${T.red}20`,borderRadius:8,padding:'8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{l}</button>
                ))}
              </div>
            )}
          </Card>

          {/* Drawdown protection */}
          <Card style={{padding:'16px',marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700}}>📉 드로다운 보호</div>
              <Bdg c={dd.mode==='normal'?T.grn:dd.mode==='cooldown'?T.ylw:T.red} ch={dd.mode==='normal'?'정상':dd.mode==='cooldown'?'쿨다운':'방어 모드'}/>
            </div>
            {[
              {l:'일일 손실',used:dd.daily.used,limit:dd.daily.limit,pct:ddDailyPct},
              {l:'주간 손실',used:dd.weekly.used,limit:dd.weekly.limit,pct:ddWkPct},
              {l:'월간 손실',used:dd.monthly.used,limit:dd.monthly.limit,pct:dd.monthly.used/dd.monthly.limit*100},
            ].map(r=>{
              const c=r.pct>70?T.red:r.pct>40?T.ylw:T.grn;
              return (
                <div key={r.l} style={{marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                    <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
                    <span style={{color:c,fontSize:11,fontWeight:700}}>{cvt(r.used,'KRW')} / {cvt(r.limit,'KRW')} ({r.pct.toFixed(0)}%)</span>
                  </div>
                  <div style={{height:6,background:'#1A2D4A',borderRadius:3,overflow:'hidden'}}>
                    <div style={{height:'100%',width:`${Math.min(100,r.pct)}%`,background:c,borderRadius:3,transition:'width .5s'}}/>
                  </div>
                </div>
              );
            })}
          </Card>

          {/* Liquidation monitor */}
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${liqAlert?T.red:T.border}30`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{color:T.txt,fontWeight:700}}>⚡ 청산 위험 모니터</div>
              <button onClick={()=>setLiqAlert(v=>!v)} style={{background:liqAlert?T.red+'20':T.acg,color:liqAlert?T.red:T.acl,border:`1px solid ${liqAlert?T.red:T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{liqAlert?'🔔 알림 ON':'🔕 알림 OFF'}</button>
            </div>
            {MOCK_LIQ_POSITIONS.map(p=><LiqGauge key={p.asset} pos={p}/>)}
          </Card>

          {/* API permission check */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🔑 API 권한 보안 검사</div>
            {Object.entries(MOCK_API_PERMS).map(([ex,perm])=>(
              <div key={ex} style={{marginBottom:10,paddingBottom:10,borderBottom:`1px solid ${T.border}`}}>
                <div style={{color:T.txt,fontSize:12,fontWeight:700,marginBottom:6}}>{ex}</div>
                <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                  {[{l:'읽기',v:perm.read,safe:true},{l:'현물',v:perm.spot,safe:true},{l:'선물',v:perm.futures,safe:true},{l:'출금',v:perm.withdrawal,safe:false}].map(p=>(
                    <Bdg key={p.l} c={p.v?(p.safe?T.grn:T.red):T.muted} ch={`${p.v?'✅':'❌'} ${p.l}${p.v&&!p.safe?' ⚠️':''}`}/>
                  ))}
                </div>
                {perm.withdrawal&&<div style={{color:T.red,fontSize:10,fontWeight:700,marginTop:4}}>⚠️ 출금 권한이 활성화되어 있습니다. 즉시 거래소에서 비활성화하세요.</div>}
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* ── WALLET ── */}
      {tab==='wallet'&&(
        <div>
          {/* Total */}
          <div style={{background:'linear-gradient(135deg,#060A12,#0D1525)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
            <div style={{color:T.muted,fontSize:11,marginBottom:2}}>유니파이드 월렛 총 자산</div>
            <div style={{color:T.txt,fontSize:28,fontWeight:900,fontFamily:'monospace'}}>{cvt(totalBalance,'KRW')}</div>
            <div style={{color:T.acl,fontSize:13,fontWeight:700,marginTop:2}}>${totalUSDT.toLocaleString()} USDT</div>
            {/* Allocation bar */}
            <div style={{marginTop:12,height:8,background:'#1A2D4A',borderRadius:4,overflow:'hidden',display:'flex'}}>
              {MOCK_WALLET.map(w=><div key={w.id} style={{height:'100%',width:`${w.balance/totalBalance*100}%`,background:w.color,opacity:0.85}}/>)}
            </div>
            <div style={{display:'flex',gap:8,marginTop:6,flexWrap:'wrap'}}>
              {MOCK_WALLET.map(w=>(
                <div key={w.id} style={{display:'flex',alignItems:'center',gap:3}}>
                  <div style={{width:7,height:7,borderRadius:2,background:w.color}}/>
                  <span style={{color:T.muted,fontSize:9}}>{w.name} {(w.balance/totalBalance*100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Per account */}
          {MOCK_WALLET.map((w,i)=>(
            <Card key={w.id} style={{padding:'12px 14px',marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <div style={{width:36,height:36,borderRadius:10,background:`${w.color}20`,border:`1px solid ${w.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>{w.icon}</div>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{w.name}</div>
                    <div style={{display:'flex',gap:4,marginTop:2}}>
                      <Bdg c={w.color} ch={w.type}/>
                      <span style={{color:T.muted,fontSize:9}}>${w.usdtEq.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>{cvt(w.balance,'KRW')}</div>
                  <div style={{color:T.muted,fontSize:10}}>{(w.balance/totalBalance*100).toFixed(1)}%</div>
                </div>
              </div>
            </Card>
          ))}

          {/* AI portfolio advice */}
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.prp}30`}}>
            <div style={{color:T.prp,fontWeight:700,marginBottom:8}}>🤖 AI 포트폴리오 관리자</div>
            <div style={{display:'flex',gap:6,marginBottom:10}}>
              {(['conservative','balanced','aggressive'] as const).map(m=>(
                <button key={m} style={{flex:1,padding:'7px',background:m==='balanced'?T.prp+'20':'transparent',color:m==='balanced'?T.prp:T.muted,border:`1px solid ${m==='balanced'?T.prp:T.border}`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {m==='conservative'?'보수형':m==='balanced'?'균형형':'공격형'}
                </button>
              ))}
            </div>
            {['암호화폐 비중이 73%로 과도합니다. ETF 분산을 권장합니다.','현금 보유율 12% — 급락 대응 여력 적절','분기별 리밸런싱 예정일: 2025-07-01'].map((m,i)=>(
              <div key={i} style={{display:'flex',gap:5,padding:'4px 0',borderBottom:i<2?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.prp,fontSize:11}}>💡</span>
                <span style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{m}</span>
              </div>
            ))}
            <div style={{color:T.muted,fontSize:9,marginTop:6}}>⚠️ AI 조언은 참고용이며 수익을 보장하지 않습니다.</div>
          </Card>
        </div>
      )}

      {/* ── MARKETPLACE ── */}
      {tab==='market'&&(
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:14}}>🏪 전략 마켓플레이스</div>
            <div style={{display:'flex',gap:4}}>
              {(['score','pnl','subs'] as const).map(s=>(
                <button key={s} onClick={()=>setSortMarket(s)} style={{background:sortMarket===s?T.acg:'transparent',color:sortMarket===s?T.acl:T.muted,border:`1px solid ${sortMarket===s?T.acl:T.border}`,borderRadius:7,padding:'3px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {s==='score'?'점수':s==='pnl'?'수익률':'구독자'}
                </button>
              ))}
            </div>
          </div>

          {sortedMarket.map((s,i)=>(
            <Card key={s.id} style={{padding:'14px',marginBottom:10,border:`1px solid ${s.color}20`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <div style={{width:36,height:36,borderRadius:10,background:`${s.color}20`,border:`1px solid ${s.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:14,color:s.color}}>
                    {i+1}
                  </div>
                  <div>
                    <div style={{display:'flex',gap:5,alignItems:'center',flexWrap:'wrap'}}>
                      <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{s.name}</span>
                      {s.badge&&<span style={{background:`${s.color}15`,color:s.color,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:99}}>{s.badge}</span>}
                      {s.verified&&<span style={{color:T.acl,fontSize:11}}>✓</span>}
                    </div>
                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>{s.author} · {s.type} · 구독 {s.subscribers.toLocaleString()}명</div>
                  </div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <div style={{color:s.pnl>=0?T.grn:T.red,fontWeight:900,fontSize:14}}>+{s.pnl}%</div>
                  <div style={{color:T.muted,fontSize:9}}>승률 {s.winRate}%</div>
                </div>
              </div>
              <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:8}}>
                <div style={{flex:1,height:4,background:'#1A2D4A',borderRadius:2,overflow:'hidden'}}>
                  <div style={{height:'100%',width:`${s.score}%`,background:s.score>=70?T.grn:s.score>=40?T.ylw:T.red,borderRadius:2}}/>
                </div>
                <span style={{color:T.muted,fontSize:10,flexShrink:0}}>점수 {s.score}</span>
              </div>
              <div style={{display:'flex',gap:6}}>
                <button style={{flex:1,padding:'7px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>📋 상세 보기</button>
                <button style={{flex:1,padding:'7px',background:s.color+'15',color:s.color,border:`1px solid ${s.color}30`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>⭐ 구독 (모의)</button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── MONITOR ── */}
      {tab==='monitor'&&(
        <div>
          {/* Exchange health */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📡 거래소 연결 상태</div>
            {MOCK_EXCHANGE_HEALTH.map((ex,i)=>{
              const c=statusColor(ex.status);
              return (
                <div key={ex.name} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<MOCK_EXCHANGE_HEALTH.length-1?`1px solid ${T.border}`:'none'}}>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}>
                    <div style={{width:8,height:8,borderRadius:'50%',background:c,boxShadow:`0 0 5px ${c}80`,flexShrink:0}}/>
                    <span style={{fontSize:14}}>{ex.icon}</span>
                    <div>
                      <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{ex.name}</div>
                      <div style={{color:T.muted,fontSize:9}}>WS: {ex.wsStatus?'✅':'❌'} · 갱신: {ex.lastCheck}</div>
                    </div>
                  </div>
                  <div style={{textAlign:'right',flexShrink:0}}>
                    <Bdg c={c} ch={ex.status==='ok'?'정상':ex.status==='slow'?'지연':ex.status==='error'?'오류':'점검중'}/>
                    {ex.latency>0&&<div style={{color:T.muted,fontSize:9,marginTop:2}}>{ex.latency}ms</div>}
                  </div>
                </div>
              );
            })}
          </Card>

          {/* Push notification channels */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🔔 알림 채널 설정</div>
            {[
              {name:'Telegram 봇',status:'준비중',icon:'📱',c:T.acl,desc:'@TRAIGO_Alert_Bot'},
              {name:'Discord Webhook',status:'준비중',icon:'💬',c:T.prp,desc:'채널 Webhook URL 연동'},
              {name:'이메일 알림',status:'준비중',icon:'📧',c:T.ylw,desc:'가입 이메일로 발송'},
              {name:'모바일 푸시',status:'준비중',icon:'📲',c:T.grn,desc:'PWA / 앱 알림'},
            ].map((ch,i)=>(
              <div key={ch.name} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <span style={{fontSize:18}}>{ch.icon}</span>
                  <div>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{ch.name}</div>
                    <div style={{color:T.muted,fontSize:9}}>{ch.desc}</div>
                  </div>
                </div>
                <Bdg c={T.muted} ch={ch.status}/>
              </div>
            ))}
          </Card>

          {/* AI Risk Manager */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.prp}30`}}>
            <div style={{color:T.prp,fontWeight:700,marginBottom:8}}>🤖 AI 위험 관리자</div>
            {[
              {msg:'현재 시장 변동성이 보통 수준 — 정상 레버리지 유지',level:'ok'},
              {msg:'Gate.io API 응답 지연 감지 — 해당 거래소 거래 주의',level:'warn'},
              {msg:'BTC 펀딩비 0.008% — 정상 범위 내, 롱 포지션 추가 가능',level:'ok'},
              {msg:'SOL 청산 거리 5.1% — 청산 위험 모니터링 필요',level:'danger'},
            ].map((a,i)=>(
              <div key={i} style={{display:'flex',gap:5,padding:'5px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                <span style={{fontSize:11,flexShrink:0}}>{a.level==='ok'?'✅':a.level==='warn'?'⚠️':'🔴'}</span>
                <span style={{color:a.level==='danger'?T.red:a.level==='warn'?T.ylw:T.sub,fontSize:11,lineHeight:1.5}}>{a.msg}</span>
              </div>
            ))}
            <div style={{color:T.muted,fontSize:9,marginTop:6}}>⚠️ AI 분석은 참고용이며 수익을 보장하지 않습니다.</div>
          </Card>
        </div>
      )}

      {/* ── RECOVERY ── */}
      {tab==='recovery'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🔄 자동 복구 시스템</div>
            {MOCK_RECOVERY.map((ev,i)=>(
              <div key={ev.id} style={{padding:'10px 0',borderBottom:i<MOCK_RECOVERY.length-1?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:4}}>
                  <div style={{display:'flex',gap:5,alignItems:'center'}}>
                    <Bdg c={ev.resolved?T.grn:T.red} ch={ev.resolved?'해결됨':'확인 필요'}/>
                    <span style={{color:T.txt,fontSize:11,fontWeight:700}}>{ev.type}</span>
                  </div>
                  <span style={{color:T.muted,fontSize:9}}>{ev.time}</span>
                </div>
                <div style={{color:T.muted,fontSize:10,marginBottom:2}}>{ev.desc}</div>
                <div style={{color:ev.resolved?T.grn:T.ylw,fontSize:10}}>→ {ev.action}</div>
              </div>
            ))}
          </Card>

          {/* Reconnect settings */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>⚙️ 재연결 설정</div>
            {[{l:'WebSocket 자동 재연결',v:true},{l:'API 타임아웃 시 폴링 전환',v:true},{l:'포지션 불일치 시 알림',v:true},{l:'API 오류 시 봇 일시 중지',v:true}].map((s,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{s.l}</span>
                <Bdg c={s.v?T.grn:T.muted} ch={s.v?'활성':'비활성'}/>
              </div>
            ))}
          </Card>

          {/* Shadow mode explanation */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.prp}30`}}>
            <div style={{color:T.prp,fontWeight:700,marginBottom:8}}>👁 섀도우 모드란?</div>
            <div style={{color:T.sub,fontSize:11,lineHeight:1.7}}>
              섀도우 모드에서는 전략 로직이 완전히 실행되지만 실제 주문은 전송되지 않습니다.
              신호·포지션·PnL은 모두 시뮬레이션으로 기록됩니다.<br/><br/>
              ✅ 실전 전 전략 검증에 최적<br/>
              ✅ 리스크 없이 전략 성과 확인<br/>
              ✅ 실전 모드 전환 전 필수 단계
            </div>
          </Card>
        </div>
      )}

      {/* Kill confirm modal */}
      {showConfirmKill&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.85)',zIndex:300}} onClick={()=>setShowConfirmKill(false)}/>
          <div style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:301,background:T.surf,borderRadius:20,padding:'24px 20px',width:320,border:`2px solid ${T.red}`}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:36,textAlign:'center',marginBottom:8}}>🚨</div>
            <div style={{color:T.red,fontWeight:900,fontSize:18,textAlign:'center',marginBottom:8}}>전체 킬 스위치</div>
            <div style={{color:T.sub,fontSize:12,lineHeight:1.6,marginBottom:20,textAlign:'center'}}>모든 자동매매를 즉시 중단합니다. 수동 거래는 계속 가능합니다.</div>
            <div style={{display:'flex',gap:10}}>
              <button onClick={()=>setShowConfirmKill(false)} style={{flex:1,padding:'12px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>activateKill('all')} style={{flex:1,padding:'12px',background:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:900,cursor:'pointer'}}>정지 실행</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   INLINE CHART PAGE — TradingView 차트 탭 (메인 앱 내부)
   ══════════════════════════════════════════════════════════════════ */

/* ── Symbol converter (reused from chart route) ── */
function tvSymbol(raw: string): string {
  if (!raw || !raw.trim()) return 'BINANCE:BTCUSDT';
  const u = raw.toUpperCase().trim();
  if (u.includes(':')) return u;
  const CRYPTO = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','TON','LINK','DOT','MATIC','ARB','OP','SUI','PEPE','LTC'];
  if (CRYPTO.includes(u)) return `BINANCE:${u}USDT`;
  if (u.endsWith('USDT')||u.endsWith('USDC')) return `BINANCE:${u}`;
  if (/^\d{6}$/.test(u)) return `KRX:${u}`;
  if (u==='GOLD'||u==='XAUUSD') return 'OANDA:XAUUSD';
  if (u==='OIL'||u==='WTI') return 'TVC:USOIL';
  if (u==='SPX') return 'SP:SPX'; if (u==='NDX') return 'NASDAQ:NDX';
  if (u==='DXY') return 'TVC:DXY';
  const AMEX=['SPY','QQQ','TQQQ','SOXL','ARKK','GLD','SLV','IWM','DIA'];
  if (AMEX.includes(u)) return `AMEX:${u}`;
  return `NASDAQ:${u}`;
}

/* ── Featured symbols for inline chart ── */
/* ── TV Featured Assets — Featured only (fast load)
   All other US stocks searched dynamically via TradingView symbol input
   ────────────────────────────────────────────────────────────────── */

// Sub-categories for the stock list (used for filtering)
type TVCat = 'crypto'|'stock'|'krstock'|'etf'|'index'|'commodity'|'forex'|
             'stock_tech'|'stock_ai'|'stock_finance'|'stock_energy'|
             'stock_health'|'stock_consumer'|'stock_defense'|'stock_meme';

interface TVAsset {
  sym: string; label: string; tv: string;
  cat: string; clr: string;
  logo?: string;   // clearbit domain
  featured?: boolean;
}

const TV_STOCKS_US: TVAsset[] = [
  /* ── Mega-cap Tech ── */
  {sym:'AAPL', label:'애플',          tv:'NASDAQ:AAPL', cat:'stock_tech',    clr:'#A0A0A0',logo:'apple.com',     featured:true},
  {sym:'MSFT', label:'마이크로소프트', tv:'NASDAQ:MSFT', cat:'stock_tech',    clr:'#00A4EF',logo:'microsoft.com', featured:true},
  {sym:'NVDA', label:'엔비디아',       tv:'NASDAQ:NVDA', cat:'stock_ai',      clr:'#76B900',logo:'nvidia.com',    featured:true},
  {sym:'GOOGL',label:'구글(A)',        tv:'NASDAQ:GOOGL',cat:'stock_tech',    clr:'#4285F4',logo:'google.com',    featured:true},
  {sym:'GOOG', label:'구글(C)',        tv:'NASDAQ:GOOG', cat:'stock_tech',    clr:'#4285F4',logo:'google.com'},
  {sym:'AMZN', label:'아마존',         tv:'NASDAQ:AMZN', cat:'stock_tech',    clr:'#FF9900',logo:'amazon.com',    featured:true},
  {sym:'META', label:'메타',           tv:'NASDAQ:META', cat:'stock_tech',    clr:'#0082FB',logo:'meta.com',      featured:true},
  {sym:'TSLA', label:'테슬라',         tv:'NASDAQ:TSLA', cat:'stock_tech',    clr:'#CC0000',logo:'tesla.com',     featured:true},
  {sym:'ORCL', label:'오라클',         tv:'NYSE:ORCL',   cat:'stock_tech',    clr:'#F80000',logo:'oracle.com'},
  {sym:'SAP',  label:'SAP',            tv:'NYSE:SAP',    cat:'stock_tech',    clr:'#008FD3',logo:'sap.com'},
  {sym:'CRM',  label:'세일즈포스',     tv:'NYSE:CRM',    cat:'stock_tech',    clr:'#00A1E0',logo:'salesforce.com'},
  {sym:'ADBE', label:'어도비',         tv:'NASDAQ:ADBE', cat:'stock_tech',    clr:'#FF0000',logo:'adobe.com'},
  {sym:'NOW',  label:'서비스나우',     tv:'NYSE:NOW',    cat:'stock_tech',    clr:'#81B5A1',logo:'servicenow.com'},
  {sym:'INTU', label:'인튜이트',       tv:'NASDAQ:INTU', cat:'stock_tech',    clr:'#236CC1',logo:'intuit.com'},
  {sym:'CSCO', label:'시스코',         tv:'NASDAQ:CSCO', cat:'stock_tech',    clr:'#1BA0D7',logo:'cisco.com'},
  {sym:'IBM',  label:'IBM',            tv:'NYSE:IBM',    cat:'stock_tech',    clr:'#006699'},
  {sym:'SHOP', label:'쇼피파이',       tv:'NYSE:SHOP',   cat:'stock_tech',    clr:'#96BF48',logo:'shopify.com'},
  {sym:'SNOW', label:'스노우플레이크', tv:'NYSE:SNOW',   cat:'stock_tech',    clr:'#29B5E8'},
  {sym:'NET',  label:'클라우드플레어', tv:'NYSE:NET',    cat:'stock_tech',    clr:'#F48120',logo:'cloudflare.com'},
  {sym:'ZS',   label:'지스케일러',     tv:'NASDAQ:ZS',   cat:'stock_tech',    clr:'#005DAA'},
  {sym:'OKTA', label:'옥타',           tv:'NASDAQ:OKTA', cat:'stock_tech',    clr:'#007DC1'},
  {sym:'DDOG', label:'데이터독',       tv:'NASDAQ:DDOG', cat:'stock_tech',    clr:'#632CA6'},
  {sym:'TEAM', label:'아틀라시안',     tv:'NASDAQ:TEAM', cat:'stock_tech',    clr:'#0052CC',logo:'atlassian.com'},
  {sym:'UBER', label:'우버',           tv:'NYSE:UBER',   cat:'stock_tech',    clr:'#000000',logo:'uber.com'},
  {sym:'LYFT', label:'리프트',         tv:'NASDAQ:LYFT', cat:'stock_tech',    clr:'#FF00BF'},
  {sym:'ABNB', label:'에어비앤비',     tv:'NASDAQ:ABNB', cat:'stock_tech',    clr:'#FF5A5F',logo:'airbnb.com'},
  {sym:'BKNG', label:'부킹홀딩스',     tv:'NASDAQ:BKNG', cat:'stock_tech',    clr:'#003580',logo:'booking.com'},
  {sym:'DASH', label:'도어대시',       tv:'NYSE:DASH',   cat:'stock_tech',    clr:'#FF3008'},
  {sym:'PINS', label:'핀터레스트',     tv:'NYSE:PINS',   cat:'stock_tech',    clr:'#E60023'},
  {sym:'SNAP', label:'스냅챗',         tv:'NYSE:SNAP',   cat:'stock_tech',    clr:'#FFFC00'},
  {sym:'RBLX', label:'로블록스',       tv:'NYSE:RBLX',   cat:'stock_tech',    clr:'#E52207'},
  {sym:'NFLX', label:'넷플릭스',       tv:'NASDAQ:NFLX', cat:'stock_consumer',clr:'#E50914',logo:'netflix.com',  featured:true},
  {sym:'DIS',  label:'디즈니',         tv:'NYSE:DIS',    cat:'stock_consumer',clr:'#113CCF',logo:'disney.com'},
  {sym:'WBD',  label:'워너브라더스',   tv:'NASDAQ:WBD',  cat:'stock_consumer',clr:'#003087'},
  {sym:'SPOT', label:'스포티파이',     tv:'NYSE:SPOT',   cat:'stock_tech',    clr:'#1DB954',logo:'spotify.com'},
  /* ── AI & Semiconductors ── */
  {sym:'AMD',  label:'AMD',            tv:'NASDAQ:AMD',  cat:'stock_ai',      clr:'#ED1C24',logo:'amd.com',      featured:true},
  {sym:'INTC', label:'인텔',           tv:'NASDAQ:INTC', cat:'stock_ai',      clr:'#0071C5',logo:'intel.com',    featured:true},
  {sym:'AVGO', label:'브로드컴',       tv:'NASDAQ:AVGO', cat:'stock_ai',      clr:'#CC0000',logo:'broadcom.com', featured:true},
  {sym:'QCOM', label:'퀄컴',           tv:'NASDAQ:QCOM', cat:'stock_ai',      clr:'#3253DC',logo:'qualcomm.com', featured:true},
  {sym:'TSM',  label:'TSMC',           tv:'NYSE:TSM',    cat:'stock_ai',      clr:'#BB2A35',                    featured:true},
  {sym:'ASML', label:'ASML',           tv:'NASDAQ:ASML', cat:'stock_ai',      clr:'#0072CE',logo:'asml.com'},
  {sym:'MU',   label:'마이크론',       tv:'NASDAQ:MU',   cat:'stock_ai',      clr:'#1C4F8C',logo:'micron.com'},
  {sym:'LRCX', label:'램리서치',       tv:'NASDAQ:LRCX', cat:'stock_ai',      clr:'#006699'},
  {sym:'AMAT', label:'어플라이드머티리얼',tv:'NASDAQ:AMAT',cat:'stock_ai',   clr:'#1976D2'},
  {sym:'KLAC', label:'KLA Corp',       tv:'NASDAQ:KLAC', cat:'stock_ai',      clr:'#003366'},
  {sym:'MRVL', label:'마벨테크',       tv:'NASDAQ:MRVL', cat:'stock_ai',      clr:'#0067B0'},
  {sym:'ARM',  label:'ARM홀딩스',      tv:'NASDAQ:ARM',  cat:'stock_ai',      clr:'#00C0C0'},
  {sym:'SMCI', label:'슈퍼마이크로',   tv:'NASDAQ:SMCI', cat:'stock_ai',      clr:'#006699'},
  {sym:'PLTR', label:'팔란티어',       tv:'NYSE:PLTR',   cat:'stock_ai',      clr:'#000000',                    featured:true},
  {sym:'AI',   label:'C3.ai',          tv:'NYSE:AI',     cat:'stock_ai',      clr:'#00A3E0'},
  {sym:'SOUN', label:'사운드하운드',   tv:'NASDAQ:SOUN', cat:'stock_ai',      clr:'#FF6B00'},
  {sym:'BBAI', label:'BigBear.ai',     tv:'NYSE:BBAI',   cat:'stock_ai',      clr:'#1A73E8'},
  /* ── Finance ── */
  {sym:'JPM',  label:'JP모건',         tv:'NYSE:JPM',    cat:'stock_finance', clr:'#006DAE',logo:'jpmorganchase.com',featured:true},
  {sym:'BAC',  label:'뱅크오브아메리카',tv:'NYSE:BAC',   cat:'stock_finance', clr:'#E31837',logo:'bankofamerica.com',featured:true},
  {sym:'GS',   label:'골드만삭스',     tv:'NYSE:GS',     cat:'stock_finance', clr:'#6C8EBF',                    featured:true},
  {sym:'MS',   label:'모건스탠리',     tv:'NYSE:MS',     cat:'stock_finance', clr:'#003087',                    featured:true},
  {sym:'WFC',  label:'웰스파고',       tv:'NYSE:WFC',    cat:'stock_finance', clr:'#D71E28',logo:'wellsfargo.com'},
  {sym:'C',    label:'씨티그룹',       tv:'NYSE:C',      cat:'stock_finance', clr:'#003B70',logo:'citi.com'},
  {sym:'BLK',  label:'블랙록',         tv:'NYSE:BLK',    cat:'stock_finance', clr:'#000000',logo:'blackrock.com'},
  {sym:'BRK.B',label:'버크셔해서웨이B',tv:'NYSE:BRK.B',  cat:'stock_finance', clr:'#003087'},
  {sym:'V',    label:'비자',           tv:'NYSE:V',      cat:'stock_finance', clr:'#1A1F71',logo:'visa.com',     featured:true},
  {sym:'MA',   label:'마스터카드',     tv:'NYSE:MA',     cat:'stock_finance', clr:'#EB001B',logo:'mastercard.com',featured:true},
  {sym:'AXP',  label:'아메리칸익스프레스',tv:'NYSE:AXP', cat:'stock_finance', clr:'#006FCF',logo:'americanexpress.com'},
  {sym:'PYPL', label:'페이팔',         tv:'NASDAQ:PYPL', cat:'stock_finance', clr:'#009CDE',logo:'paypal.com',   featured:true},
  {sym:'SQ',   label:'블록(스퀘어)',   tv:'NYSE:SQ',     cat:'stock_finance', clr:'#006AFF',                    featured:true},
  {sym:'COIN', label:'코인베이스',     tv:'NASDAQ:COIN', cat:'stock_finance', clr:'#0052FF',logo:'coinbase.com', featured:true},
  {sym:'HOOD', label:'로빈후드',       tv:'NASDAQ:HOOD', cat:'stock_finance', clr:'#00C805',logo:'robinhood.com',featured:true},
  {sym:'NU',   label:'누홀딩스',       tv:'NYSE:NU',     cat:'stock_finance', clr:'#8A05BE'},
  {sym:'SOFI', label:'소파이',         tv:'NASDAQ:SOFI', cat:'stock_meme',    clr:'#7B40F2',                    featured:true},
  {sym:'AFRM', label:'어펌',           tv:'NASDAQ:AFRM', cat:'stock_finance', clr:'#0FA0EA'},
  {sym:'NDAQ', label:'나스닥Inc',      tv:'NASDAQ:NDAQ', cat:'stock_finance', clr:'#2775CA'},
  {sym:'CME',  label:'CME그룹',        tv:'NASDAQ:CME',  cat:'stock_finance', clr:'#003366'},
  /* ── Energy ── */
  {sym:'XOM',  label:'엑슨모빌',       tv:'NYSE:XOM',    cat:'stock_energy',  clr:'#E01A2B',logo:'exxonmobil.com',featured:true},
  {sym:'CVX',  label:'셰브론',         tv:'NYSE:CVX',    cat:'stock_energy',  clr:'#009DD9',logo:'chevron.com',  featured:true},
  {sym:'OXY',  label:'옥시덴탈',       tv:'NYSE:OXY',    cat:'stock_energy',  clr:'#D23229',                    featured:true},
  {sym:'SLB',  label:'슐럼버거',       tv:'NYSE:SLB',    cat:'stock_energy',  clr:'#0067A5',                    featured:true},
  {sym:'COP',  label:'코노코필립스',   tv:'NYSE:COP',    cat:'stock_energy',  clr:'#E2231A'},
  {sym:'PXD',  label:'파이오니어NR',   tv:'NYSE:PXD',    cat:'stock_energy',  clr:'#006B3C'},
  {sym:'MPC',  label:'마라톤페트롤리움',tv:'NYSE:MPC',   cat:'stock_energy',  clr:'#006B3C'},
  {sym:'PSX',  label:'필립스66',       tv:'NYSE:PSX',    cat:'stock_energy',  clr:'#E31837'},
  {sym:'VLO',  label:'발레로에너지',   tv:'NYSE:VLO',    cat:'stock_energy',  clr:'#002A5E'},
  {sym:'NEE',  label:'넥스트에라에너지',tv:'NYSE:NEE',   cat:'stock_energy',  clr:'#0078D4'},
  {sym:'ENPH', label:'인페이즈에너지', tv:'NASDAQ:ENPH', cat:'stock_energy',  clr:'#FF6600'},
  {sym:'FSLR', label:'퍼스트솔라',     tv:'NASDAQ:FSLR', cat:'stock_energy',  clr:'#007BC0'},
  /* ── Healthcare ── */
  {sym:'LLY',  label:'일라이릴리',     tv:'NYSE:LLY',    cat:'stock_health',  clr:'#D52B1E',logo:'lilly.com',    featured:true},
  {sym:'UNH',  label:'유나이티드헬스', tv:'NYSE:UNH',    cat:'stock_health',  clr:'#316BBE',logo:'unitedhealthgroup.com',featured:true},
  {sym:'JNJ',  label:'존슨앤존슨',     tv:'NYSE:JNJ',    cat:'stock_health',  clr:'#CC0000',logo:'jnj.com',      featured:true},
  {sym:'PFE',  label:'화이자',         tv:'NYSE:PFE',    cat:'stock_health',  clr:'#0093D0',logo:'pfizer.com',   featured:true},
  {sym:'MRK',  label:'머크',           tv:'NYSE:MRK',    cat:'stock_health',  clr:'#0071A9',logo:'merck.com',    featured:true},
  {sym:'ABBV', label:'애브비',         tv:'NYSE:ABBV',   cat:'stock_health',  clr:'#071D49',logo:'abbvie.com',   featured:true},
  {sym:'BMY',  label:'BMS',            tv:'NYSE:BMY',    cat:'stock_health',  clr:'#003B5C'},
  {sym:'AMGN', label:'암젠',           tv:'NASDAQ:AMGN', cat:'stock_health',  clr:'#003087',logo:'amgen.com'},
  {sym:'GILD', label:'길리어드',       tv:'NASDAQ:GILD', cat:'stock_health',  clr:'#CC0000',logo:'gilead.com'},
  {sym:'ISRG', label:'인튜이티브서지컬',tv:'NASDAQ:ISRG',cat:'stock_health',  clr:'#003B70'},
  {sym:'SYK',  label:'스트라이커',     tv:'NYSE:SYK',    cat:'stock_health',  clr:'#0072CE'},
  {sym:'REGN', label:'리제너론',       tv:'NASDAQ:REGN', cat:'stock_health',  clr:'#00549F'},
  {sym:'MRNA', label:'모더나',         tv:'NASDAQ:MRNA', cat:'stock_health',  clr:'#0040C9',logo:'modernatx.com'},
  {sym:'BIIB', label:'바이오젠',       tv:'NASDAQ:BIIB', cat:'stock_health',  clr:'#CC0000'},
  {sym:'VRTX', label:'버텍스파마',     tv:'NASDAQ:VRTX', cat:'stock_health',  clr:'#C8002A'},
  {sym:'ZBH',  label:'짐머바이오멧',   tv:'NYSE:ZBH',    cat:'stock_health',  clr:'#005B9A'},
  {sym:'CVS',  label:'CVS헬스',        tv:'NYSE:CVS',    cat:'stock_health',  clr:'#CC0000',logo:'cvshealth.com'},
  {sym:'CI',   label:'시그나',         tv:'NYSE:CI',     cat:'stock_health',  clr:'#003087'},
  {sym:'MCK',  label:'맥케슨',         tv:'NYSE:MCK',    cat:'stock_health',  clr:'#005B99'},
  /* ── Consumer / Retail ── */
  {sym:'WMT',  label:'월마트',         tv:'NYSE:WMT',    cat:'stock_consumer',clr:'#0071CE',logo:'walmart.com',  featured:true},
  {sym:'COST', label:'코스트코',       tv:'NASDAQ:COST', cat:'stock_consumer',clr:'#005DAA',logo:'costco.com',   featured:true},
  {sym:'MCD',  label:'맥도날드',       tv:'NYSE:MCD',    cat:'stock_consumer',clr:'#DA291C',logo:'mcdonalds.com',featured:true},
  {sym:'SBUX', label:'스타벅스',       tv:'NASDAQ:SBUX', cat:'stock_consumer',clr:'#00704A',logo:'starbucks.com',featured:true},
  {sym:'KO',   label:'코카콜라',       tv:'NYSE:KO',     cat:'stock_consumer',clr:'#F40000',logo:'coca-cola.com', featured:true},
  {sym:'PEP',  label:'펩시코',         tv:'NASDAQ:PEP',  cat:'stock_consumer',clr:'#004B93',logo:'pepsico.com',  featured:true},
  {sym:'NKE',  label:'나이키',         tv:'NYSE:NKE',    cat:'stock_consumer',clr:'#111111',logo:'nike.com',     featured:true},
  {sym:'LULU', label:'룰루레몬',       tv:'NASDAQ:LULU', cat:'stock_consumer',clr:'#A2006D',logo:'lululemon.com'},
  {sym:'TGT',  label:'타겟',           tv:'NYSE:TGT',    cat:'stock_consumer',clr:'#CC0000',logo:'target.com'},
  {sym:'HD',   label:'홈데포',         tv:'NYSE:HD',     cat:'stock_consumer',clr:'#F96302',logo:'homedepot.com'},
  {sym:'LOW',  label:'로우스',         tv:'NYSE:LOW',    cat:'stock_consumer',clr:'#004990'},
  {sym:'AMZN', label:'아마존',         tv:'NASDAQ:AMZN', cat:'stock_consumer',clr:'#FF9900',logo:'amazon.com'},
  {sym:'EBAY', label:'이베이',         tv:'NASDAQ:EBAY', cat:'stock_consumer',clr:'#E53238',logo:'ebay.com'},
  {sym:'ETSY', label:'엣시',           tv:'NASDAQ:ETSY', cat:'stock_consumer',clr:'#F56400'},
  {sym:'YUM',  label:'Yum!브랜즈',     tv:'NYSE:YUM',    cat:'stock_consumer',clr:'#EE3A2E'},
  {sym:'CMG',  label:'치폴레',         tv:'NYSE:CMG',    cat:'stock_consumer',clr:'#441B13',logo:'chipotle.com'},
  {sym:'GM',   label:'GM',             tv:'NYSE:GM',     cat:'stock_consumer',clr:'#0170CE',logo:'gm.com'},
  {sym:'F',    label:'포드',           tv:'NYSE:F',      cat:'stock_consumer',clr:'#003499',logo:'ford.com'},
  {sym:'RIVN', label:'리비안',         tv:'NASDAQ:RIVN', cat:'stock_meme',    clr:'#3DD286',logo:'rivian.com',   featured:true},
  {sym:'NIO',  label:'니오',           tv:'NYSE:NIO',    cat:'stock_meme',    clr:'#2BACE2',logo:'nio.com',      featured:true},
  {sym:'LCID', label:'루시드모터스',   tv:'NASDAQ:LCID', cat:'stock_meme',    clr:'#00B2E3'},
  {sym:'LI',   label:'리오토',         tv:'NASDAQ:LI',   cat:'stock_consumer',clr:'#1F85DE'},
  {sym:'XPEV', label:'샤오펑',         tv:'NYSE:XPEV',   cat:'stock_consumer',clr:'#29B7EA'},
  /* ── Defense ── */
  {sym:'BA',   label:'보잉',           tv:'NYSE:BA',     cat:'stock_defense', clr:'#1D4289',logo:'boeing.com',   featured:true},
  {sym:'LMT',  label:'록히드마틴',     tv:'NYSE:LMT',    cat:'stock_defense', clr:'#003087',logo:'lockheedmartin.com',featured:true},
  {sym:'RTX',  label:'RTX(레이시온)',  tv:'NYSE:RTX',    cat:'stock_defense', clr:'#003087',logo:'rtx.com',      featured:true},
  {sym:'NOC',  label:'노스롭그루만',   tv:'NYSE:NOC',    cat:'stock_defense', clr:'#003087',logo:'northropgrumman.com',featured:true},
  {sym:'GD',   label:'제너럴다이내믹스',tv:'NYSE:GD',    cat:'stock_defense', clr:'#003087'},
  {sym:'HII',  label:'헌팅턴잉걸스',  tv:'NYSE:HII',    cat:'stock_defense', clr:'#003087'},
  {sym:'L3H',  label:'L3해리스',       tv:'NYSE:LHX',    cat:'stock_defense', clr:'#003087'},
  {sym:'CAT',  label:'캐터필러',       tv:'NYSE:CAT',    cat:'stock_defense', clr:'#FFCD11',logo:'caterpillar.com'},
  {sym:'DE',   label:'존디어',         tv:'NYSE:DE',     cat:'stock_consumer',clr:'#367C2B',logo:'deere.com'},
  {sym:'GE',   label:'GE에어로스페이스',tv:'NYSE:GE',    cat:'stock_defense', clr:'#003087',logo:'ge.com'},
  /* ── Meme / High-volume ── */
  {sym:'GME',  label:'게임스탑',       tv:'NYSE:GME',    cat:'stock_meme',    clr:'#E31937',logo:'gamestop.com', featured:true},
  {sym:'AMC',  label:'AMC',            tv:'NYSE:AMC',    cat:'stock_meme',    clr:'#E31937',logo:'amctheatres.com',featured:true},
  {sym:'BBBY', label:'베드배스앤비욘드',tv:'NASDAQ:BBBY', cat:'stock_meme',   clr:'#003087'},
  {sym:'SPCE', label:'버진갤럭틱',     tv:'NYSE:SPCE',   cat:'stock_meme',    clr:'#222222'},
  {sym:'WISH', label:'컨텍스트로직',   tv:'NASDAQ:WISH', cat:'stock_meme',    clr:'#2FB7EC'},
  {sym:'CLOV', label:'클로버헬스',     tv:'NASDAQ:CLOV', cat:'stock_meme',    clr:'#00873D'},
  {sym:'APLD', label:'어플라이드디지털',tv:'NASDAQ:APLD',cat:'stock_meme',    clr:'#9C27B0'},
  {sym:'MSTR', label:'마이크로스트레티지',tv:'NASDAQ:MSTR',cat:'stock_meme', clr:'#E87426',logo:'microstrategy.com',featured:true},
  {sym:'CLSK', label:'클린스파크',     tv:'NASDAQ:CLSK', cat:'stock_meme',    clr:'#6DB33F'},
  {sym:'HUT',  label:'허트마이닝',     tv:'NASDAQ:HUT',  cat:'stock_meme',    clr:'#FF6B00'},
  /* ── Other notable ── */
  {sym:'V',    label:'비자',           tv:'NYSE:V',      cat:'stock_finance', clr:'#1A1F71',logo:'visa.com'},
  {sym:'MA',   label:'마스터카드',     tv:'NYSE:MA',     cat:'stock_finance', clr:'#EB001B',logo:'mastercard.com'},
  {sym:'UPS',  label:'UPS',            tv:'NYSE:UPS',    cat:'stock_consumer',clr:'#330000',logo:'ups.com'},
  {sym:'FDX',  label:'페덱스',         tv:'NYSE:FDX',    cat:'stock_consumer',clr:'#4D148C',logo:'fedex.com'},
  {sym:'NFLX', label:'넷플릭스',       tv:'NASDAQ:NFLX', cat:'stock_consumer',clr:'#E50914',logo:'netflix.com'},
  {sym:'ZM',   label:'줌비디오',       tv:'NASDAQ:ZM',   cat:'stock_tech',    clr:'#2D8CFF',logo:'zoom.us'},
  {sym:'DOCU', label:'도큐사인',       tv:'NASDAQ:DOCU', cat:'stock_tech',    clr:'#26B5E8'},
  {sym:'BILL', label:'빌닷컴',         tv:'NYSE:BILL',   cat:'stock_tech',    clr:'#0078D4'},
  {sym:'TTD',  label:'트레이드데스크', tv:'NASDAQ:TTD',  cat:'stock_tech',    clr:'#2BACE2'},
  {sym:'HOOD', label:'로빈후드',       tv:'NASDAQ:HOOD', cat:'stock_meme',    clr:'#00C805'},
  {sym:'OPEN', label:'오픈도어',       tv:'NASDAQ:OPEN', cat:'stock_tech',    clr:'#FF5733'},
  {sym:'LMND', label:'레모네이드',     tv:'NYSE:LMND',   cat:'stock_tech',    clr:'#FF0082'},
  {sym:'BYND', label:'비욘드미트',     tv:'NASDAQ:BYND', cat:'stock_consumer',clr:'#B5D334'},
  {sym:'OATLY',label:'오틀리',         tv:'NASDAQ:OTLY', cat:'stock_consumer',clr:'#F2E6D3'},
  {sym:'DKNG', label:'드래프트킹스',   tv:'NASDAQ:DKNG', cat:'stock_meme',    clr:'#61A44F'},
  {sym:'PENN', label:'펜인터랙티브',   tv:'NASDAQ:PENN', cat:'stock_consumer',clr:'#C0392B'},
  {sym:'MGM',  label:'MGM리조트',      tv:'NYSE:MGM',    cat:'stock_consumer',clr:'#00439C'},
  {sym:'LVS',  label:'라스베거스샌즈', tv:'NYSE:LVS',    cat:'stock_consumer',clr:'#003087'},
  {sym:'WYNN', label:'윈리조트',       tv:'NASDAQ:WYNN', cat:'stock_consumer',clr:'#8B6914'},
  {sym:'TWLO', label:'트윌리오',       tv:'NYSE:TWLO',   cat:'stock_tech',    clr:'#F22F46'},
  {sym:'HubS', label:'허브스팟',       tv:'NYSE:HUBS',   cat:'stock_tech',    clr:'#FF7A59',logo:'hubspot.com'},
  {sym:'ASAN', label:'아사나',         tv:'NYSE:ASAN',   cat:'stock_tech',    clr:'#F95C2A'},
  {sym:'ZI',   label:'줌인포',         tv:'NASDAQ:ZI',   cat:'stock_tech',    clr:'#5A35B4'},
  {sym:'U',    label:'유니티',         tv:'NYSE:U',      cat:'stock_tech',    clr:'#221D1E'},
  {sym:'EA',   label:'일렉트로닉아츠', tv:'NASDAQ:EA',   cat:'stock_tech',    clr:'#FF4747',logo:'ea.com'},
  {sym:'TTWO', label:'테이크투',       tv:'NASDAQ:TTWO', cat:'stock_tech',    clr:'#003087'},
  {sym:'ATVI', label:'액티비전블리자드',tv:'NASDAQ:ATVI', cat:'stock_tech',   clr:'#148EFF'},
  {sym:'NTES', label:'넷이즈',         tv:'NASDAQ:NTES', cat:'stock_tech',    clr:'#CC0000'},
  {sym:'SE',   label:'씨(시),가레나', tv:'NYSE:SE',     cat:'stock_tech',    clr:'#EE4D2D'},
  {sym:'GRAB', label:'그랩',           tv:'NASDAQ:GRAB', cat:'stock_tech',    clr:'#00B14F'},
  {sym:'BABA', label:'알리바바',       tv:'NYSE:BABA',   cat:'stock_tech',    clr:'#FF6A00'},
  {sym:'JD',   label:'징둥닷컴',       tv:'NASDAQ:JD',   cat:'stock_tech',    clr:'#E31837'},
  {sym:'PDD',  label:'핀둬둬',         tv:'NASDAQ:PDD',  cat:'stock_tech',    clr:'#E31837'},
  {sym:'TCOM', label:'트립닷컴',       tv:'NASDAQ:TCOM', cat:'stock_tech',    clr:'#3498DB'},
  {sym:'WBX',  label:'위보그룹',       tv:'NASDAQ:WB',   cat:'stock_tech',    clr:'#FA7D3C'},
  {sym:'TSM',  label:'TSMC',           tv:'NYSE:TSM',    cat:'stock_ai',      clr:'#BB2A35'},
  {sym:'SONY', label:'소니',           tv:'NYSE:SONY',   cat:'stock_tech',    clr:'#003087',logo:'sony.com'},
  {sym:'TM',   label:'토요타',         tv:'NYSE:TM',     cat:'stock_consumer',clr:'#EB0A1E',logo:'toyota.com'},
  {sym:'HMC',  label:'혼다',           tv:'NYSE:HMC',    cat:'stock_consumer',clr:'#CC0000',logo:'honda.com'},
  {sym:'SNY',  label:'사노피',         tv:'NASDAQ:SNY',  cat:'stock_health',  clr:'#7D219E'},
  {sym:'NVO',  label:'노보노디스크',   tv:'NYSE:NVO',    cat:'stock_health',  clr:'#0099DA'},
  {sym:'NOVO', label:'노보노디스크B',  tv:'NYSE:NVO',    cat:'stock_health',  clr:'#0099DA'},
  {sym:'AZN',  label:'아스트라제네카', tv:'NASDAQ:AZN',  cat:'stock_health',  clr:'#003087',logo:'astrazeneca.com'},
  {sym:'RPRX', label:'로열티파마',     tv:'NASDAQ:RPRX', cat:'stock_health',  clr:'#003087'},
  {sym:'ARKG', label:'ARK게노믹스',    tv:'NASDAQ:ARKG', cat:'etf',           clr:'#7C3AED'},
  {sym:'SPG',  label:'사이먼프로퍼티', tv:'NYSE:SPG',    cat:'stock_finance', clr:'#003087'},
  {sym:'O',    label:'리얼티인컴',     tv:'NYSE:O',      cat:'stock_finance', clr:'#003087'},
  {sym:'AMT',  label:'아메리칸타워',   tv:'NYSE:AMT',    cat:'stock_finance', clr:'#003087'},
  {sym:'PLD',  label:'프롤로지스',     tv:'NYSE:PLD',    cat:'stock_finance', clr:'#003087'},
  {sym:'EQIX', label:'에퀴닉스',       tv:'NASDAQ:EQIX', cat:'stock_tech',    clr:'#003087'},
  {sym:'DLR',  label:'디지털리얼티',   tv:'NYSE:DLR',    cat:'stock_tech',    clr:'#003087'},
  {sym:'WM',   label:'웨이스트매니지먼트',tv:'NYSE:WM',  cat:'stock_consumer',clr:'#00A651'},
  {sym:'RSG',  label:'리퍼블릭서비스', tv:'NYSE:RSG',    cat:'stock_consumer',clr:'#003087'},
  {sym:'SPGI', label:'S&P글로벌',      tv:'NYSE:SPGI',   cat:'stock_finance', clr:'#003087'},
  {sym:'MCO',  label:'무디스',         tv:'NYSE:MCO',    cat:'stock_finance', clr:'#003087'},
  {sym:'ICE',  label:'인터컨티넨탈익스체인지',tv:'NYSE:ICE',cat:'stock_finance',clr:'#003087'},
  {sym:'COF',  label:'캐피탈원',       tv:'NYSE:COF',    cat:'stock_finance', clr:'#D22630'},
  {sym:'DFS',  label:'디스커버',       tv:'NYSE:DFS',    cat:'stock_finance', clr:'#E36C00'},
  {sym:'USB',  label:'US뱅크코프',     tv:'NYSE:USB',    cat:'stock_finance', clr:'#003087'},
  {sym:'PNC',  label:'PNC파이낸셜',    tv:'NYSE:PNC',    cat:'stock_finance', clr:'#E21836'},
  {sym:'TFC',  label:'트루이스트',     tv:'NYSE:TFC',    cat:'stock_finance', clr:'#503291'},
];

// ETFs
const TV_ETFS: TVAsset[] = [
  {sym:'SPY',  label:'S&P500 ETF',    tv:'AMEX:SPY',    cat:'etf', clr:'#1D4ED8',logo:'ssga.com',   featured:true},
  {sym:'QQQ',  label:'나스닥100 ETF', tv:'NASDAQ:QQQ',  cat:'etf', clr:'#7C3AED',                  featured:true},
  {sym:'IWM',  label:'러셀2000 ETF',  tv:'AMEX:IWM',    cat:'etf', clr:'#059669',                  featured:true},
  {sym:'DIA',  label:'다우존스 ETF',  tv:'AMEX:DIA',    cat:'etf', clr:'#D97706',                  featured:true},
  {sym:'VTI',  label:'미국전체시장',  tv:'AMEX:VTI',    cat:'etf', clr:'#1D4ED8'},
  {sym:'VOO',  label:'뱅가드S&P500',  tv:'AMEX:VOO',    cat:'etf', clr:'#1D4ED8'},
  {sym:'GLD',  label:'금 ETF',        tv:'AMEX:GLD',    cat:'etf', clr:'#D97706'},
  {sym:'SLV',  label:'은 ETF',        tv:'AMEX:SLV',    cat:'etf', clr:'#94A3B8'},
  {sym:'USO',  label:'WTI원유 ETF',   tv:'AMEX:USO',    cat:'etf', clr:'#78350F'},
  {sym:'TLT',  label:'20년 국채 ETF', tv:'NASDAQ:TLT',  cat:'etf', clr:'#1D4ED8'},
  {sym:'HYG',  label:'하이일드채권',  tv:'AMEX:HYG',    cat:'etf', clr:'#059669'},
  {sym:'TQQQ', label:'나스닥3배레버리지',tv:'NASDAQ:TQQQ',cat:'etf',clr:'#7C3AED',               featured:true},
  {sym:'SQQQ', label:'나스닥3배인버스',tv:'NASDAQ:SQQQ', cat:'etf',clr:'#DC2626',                  featured:true},
  {sym:'SOXL', label:'반도체3배레버리지',tv:'AMEX:SOXL', cat:'etf', clr:'#7C3AED',                featured:true},
  {sym:'SOXS', label:'반도체3배인버스',tv:'AMEX:SOXS',  cat:'etf', clr:'#DC2626',                  featured:true},
  {sym:'UPRO', label:'S&P3배레버리지', tv:'AMEX:UPRO',  cat:'etf', clr:'#1D4ED8'},
  {sym:'SPXS', label:'S&P3배인버스',  tv:'AMEX:SPXS',   cat:'etf', clr:'#DC2626'},
  {sym:'ARKK', label:'ARK이노베이션', tv:'AMEX:ARKK',   cat:'etf', clr:'#7C3AED',logo:'ark-invest.com',featured:true},
  {sym:'ARKW', label:'ARK넥스트인터넷',tv:'AMEX:ARKW',  cat:'etf', clr:'#7C3AED'},
  {sym:'XLK',  label:'기술섹터 ETF',  tv:'AMEX:XLK',    cat:'etf', clr:'#2563EB'},
  {sym:'XLF',  label:'금융섹터 ETF',  tv:'AMEX:XLF',    cat:'etf', clr:'#059669'},
  {sym:'XLE',  label:'에너지섹터 ETF',tv:'AMEX:XLE',    cat:'etf', clr:'#D97706'},
  {sym:'XLV',  label:'헬스케어섹터',  tv:'AMEX:XLV',    cat:'etf', clr:'#DC2626'},
  {sym:'SOXX', label:'반도체 ETF',    tv:'NASDAQ:SOXX', cat:'etf', clr:'#7C3AED'},
  {sym:'VXX',  label:'VIX ETF(단기)', tv:'AMEX:VXX',    cat:'etf', clr:'#6B7280'},
];

// Indices & Macro
const TV_INDICES: TVAsset[] = [
  {sym:'SPX',  label:'S&P 500',       tv:'SP:SPX',      cat:'index',  clr:'#6366F1',featured:true},
  {sym:'NDX',  label:'나스닥100',      tv:'NASDAQ:NDX',  cat:'index',  clr:'#7C3AED',featured:true},
  {sym:'DJI',  label:'다우존스',       tv:'DJ:DJI',      cat:'index',  clr:'#1D4ED8',featured:true},
  {sym:'RUT',  label:'러셀2000',       tv:'TVC:RUT',     cat:'index',  clr:'#059669'},
  {sym:'VIX',  label:'공포지수 VIX',  tv:'TVC:VIX',     cat:'index',  clr:'#DC2626'},
  {sym:'DXY',  label:'달러인덱스',     tv:'TVC:DXY',     cat:'index',  clr:'#10B981',featured:true},
  {sym:'KOSPI',label:'코스피',         tv:'KRX:KOSPI',   cat:'krstock',clr:'#EF4444'},
  {sym:'N225', label:'닛케이225',      tv:'TVC:NI225',   cat:'index',  clr:'#DC2626'},
  {sym:'HSI',  label:'항셍지수',       tv:'HSI:HSI',     cat:'index',  clr:'#DC2626'},
  {sym:'DAX',  label:'독일DAX',        tv:'XETR:DAX',    cat:'index',  clr:'#1D4ED8'},
  {sym:'FTSE', label:'영국FTSE100',    tv:'INDEX:FTSE',  cat:'index',  clr:'#003087'},
  {sym:'CAC',  label:'프랑스CAC40',    tv:'EURONEXT:CAC',cat:'index',  clr:'#003087'},
];

// Crypto (top 30)
const TV_CRYPTO: TVAsset[] = [
  {sym:'BTC',  label:'비트코인',       tv:'BINANCE:BTCUSDT', cat:'crypto',clr:'#F7931A',featured:true},
  {sym:'ETH',  label:'이더리움',       tv:'BINANCE:ETHUSDT', cat:'crypto',clr:'#627EEA',featured:true},
  {sym:'SOL',  label:'솔라나',         tv:'BINANCE:SOLUSDT', cat:'crypto',clr:'#9945FF',featured:true},
  {sym:'BNB',  label:'바이낸스코인',   tv:'BINANCE:BNBUSDT', cat:'crypto',clr:'#F3BA2F'},
  {sym:'XRP',  label:'리플',           tv:'BINANCE:XRPUSDT', cat:'crypto',clr:'#346AA9'},
  {sym:'DOGE', label:'도지코인',       tv:'BINANCE:DOGEUSDT',cat:'crypto',clr:'#C2A633',featured:true},
  {sym:'ADA',  label:'에이다',         tv:'BINANCE:ADAUSDT', cat:'crypto',clr:'#0D1E2D'},
  {sym:'AVAX', label:'아발란체',       tv:'BINANCE:AVAXUSDT',cat:'crypto',clr:'#E84142'},
  {sym:'LINK', label:'체인링크',       tv:'BINANCE:LINKUSDT',cat:'crypto',clr:'#2A5ADA'},
  {sym:'DOT',  label:'폴카닷',         tv:'BINANCE:DOTUSDT', cat:'crypto',clr:'#E6007A'},
  {sym:'MATIC',label:'폴리곤',         tv:'BINANCE:MATICUSDT',cat:'crypto',clr:'#8247E5'},
  {sym:'UNI',  label:'유니스왑',       tv:'BINANCE:UNIUSDT', cat:'crypto',clr:'#FF007A'},
  {sym:'ARB',  label:'아비트럼',       tv:'BINANCE:ARBUSDT', cat:'crypto',clr:'#28A0F0'},
  {sym:'OP',   label:'옵티미즘',       tv:'BINANCE:OPUSDT',  cat:'crypto',clr:'#FF0420'},
  {sym:'SUI',  label:'수이',           tv:'BINANCE:SUIUSDT', cat:'crypto',clr:'#4CA3FF'},
  {sym:'TON',  label:'톤코인',         tv:'BINANCE:TONUSDT', cat:'crypto',clr:'#0088CC'},
  {sym:'SHIB', label:'시바이누',       tv:'BINANCE:SHIBUSDT',cat:'crypto',clr:'#FFA409'},
  {sym:'PEPE', label:'페페',           tv:'BINANCE:PEPEUSDT',cat:'crypto',clr:'#3BA14C',featured:true},
  {sym:'APT',  label:'앱토스',         tv:'BINANCE:APTUSDT', cat:'crypto',clr:'#00C7B2'},
  {sym:'INJ',  label:'인젝티브',       tv:'BINANCE:INJUSDT', cat:'crypto',clr:'#00F2FE'},
];

// Korean stocks
const TV_KRSTOCKS: TVAsset[] = [
  {sym:'005930',label:'삼성전자',   tv:'KRX:005930',  cat:'krstock',clr:'#1428A0',featured:true},
  {sym:'000660',label:'SK하이닉스', tv:'KRX:000660',  cat:'krstock',clr:'#EA1917',featured:true},
  {sym:'035420',label:'NAVER',      tv:'KRX:035420',  cat:'krstock',clr:'#03C75A'},
  {sym:'035720',label:'카카오',     tv:'KRX:035720',  cat:'krstock',clr:'#FEE500'},
  {sym:'005380',label:'현대차',     tv:'KRX:005380',  cat:'krstock',clr:'#002C5F'},
  {sym:'000270',label:'기아',       tv:'KRX:000270',  cat:'krstock',clr:'#05141F'},
  {sym:'051910',label:'LG화학',     tv:'KRX:051910',  cat:'krstock',clr:'#A50034'},
  {sym:'006400',label:'삼성SDI',    tv:'KRX:006400',  cat:'krstock',clr:'#1428A0'},
  {sym:'207940',label:'삼성바이오로직스',tv:'KRX:207940',cat:'krstock',clr:'#004185'},
  {sym:'003550',label:'LG전자',     tv:'KRX:003550',  cat:'krstock',clr:'#A50034'},
  {sym:'017670',label:'SK텔레콤',   tv:'KRX:017670',  cat:'krstock',clr:'#E2007A'},
  {sym:'055550',label:'신한지주',   tv:'KRX:055550',  cat:'krstock',clr:'#0046FF'},
  {sym:'105560',label:'KB금융',     tv:'KRX:105560',  cat:'krstock',clr:'#FFB300'},
  {sym:'086790',label:'하나금융지주',tv:'KRX:086790', cat:'krstock',clr:'#009F6B'},
];

// Commodities & Forex
const TV_MACRO: TVAsset[] = [
  {sym:'XAUUSD',label:'금(Gold)',    tv:'OANDA:XAUUSD',cat:'commodity',clr:'#FFD700',featured:true},
  {sym:'XAGUSD',label:'은(Silver)',  tv:'OANDA:XAGUSD',cat:'commodity',clr:'#94A3B8'},
  {sym:'USOIL', label:'WTI 원유',    tv:'TVC:USOIL',   cat:'commodity',clr:'#78350F',featured:true},
  {sym:'UKOIL', label:'브렌트유',    tv:'TVC:UKOIL',   cat:'commodity',clr:'#78350F'},
  {sym:'NATGAS',label:'천연가스',    tv:'NYMEX:NG1!',  cat:'commodity',clr:'#2563EB'},
  {sym:'COPPER',label:'구리',        tv:'TVC:COPPER',  cat:'commodity',clr:'#B45309'},
  {sym:'WHEAT', label:'밀',          tv:'CBOT:ZW1!',   cat:'commodity',clr:'#92400E'},
  {sym:'CORN',  label:'옥수수',      tv:'CBOT:ZC1!',   cat:'commodity',clr:'#EAB308'},
  {sym:'EURUSD',label:'유로/달러',   tv:'FX:EURUSD',   cat:'forex',    clr:'#003399',featured:true},
  {sym:'USDJPY',label:'달러/엔',     tv:'FX:USDJPY',   cat:'forex',    clr:'#BC002D',featured:true},
  {sym:'GBPUSD',label:'파운드/달러', tv:'FX:GBPUSD',   cat:'forex',    clr:'#003087'},
  {sym:'USDKRW',label:'달러/원화',   tv:'FX:USDKRW',   cat:'forex',    clr:'#EF4444',featured:true},
  {sym:'BTCUSD',label:'비트코인/달러',tv:'INDEX:BTCUSD',cat:'forex',   clr:'#F7931A'},
];

// Deduplicate and merge all into TV_FEATURED
function dedup<T extends {tv:string}>(arr:T[]): T[] {
  const seen = new Set<string>();
  return arr.filter(x => { if(seen.has(x.tv)) return false; seen.add(x.tv); return true; });
}

const TV_FEATURED: TVAsset[] = dedup([
  ...TV_CRYPTO, ...TV_STOCKS_US, ...TV_ETFS, ...TV_INDICES, ...TV_KRSTOCKS, ...TV_MACRO,
]);


const TV_CAT_COLOR: Record<string,string> = {
  crypto:'#F7931A',stock:'#3B82F6',krstock:'#EF4444',
  etf:'#10B981',index:'#8B5CF6',commodity:'#D97706',forex:'#0891B2',
};

/* ── Inline TradingView Widget ── */
function InlineTVChart({ symbol, chartType='1', interval='60' }: { symbol:string; chartType?:string; interval?:string }) {
  if (!symbol) return (
    <div style={{height:'100%',display:'flex',alignItems:'center',justifyContent:'center',background:T.card,flexDirection:'column',gap:6}}>
      <span style={{fontSize:24}}>📊</span>
      <span style={{color:T.muted,fontSize:12}}>심볼을 선택하세요</span>
    </div>
  );

  const ref = useRef<HTMLDivElement>(null);
  const wid = useRef<any>(null);

  // Map our chart type ids → TradingView style numbers
  const TV_STYLE_MAP: Record<string,number> = {
    '1':1,'9':9,'2':2,'3':3,'0':0,'8':8,'10':10,'15':15,'16':16,
    '6':6,'habikinashi':8,'5':5,'11':11,'4':4,'12':12,'13':13,
    'vol_candle':1,'vol_footprint':1,'tpo':1,'session_vol':1,
  };

  useEffect(() => {
    if (!ref.current || typeof window === 'undefined') return;
    const el = ref.current;

    // Always rebuild widget when dependencies change (most reliable for chartType switching)
    // The key prop on the parent ensures remount when symbol/chartType/interval changes
    try { wid.current?.remove?.(); } catch {}
    wid.current = null;

    // Build a unique container id
    const cid = 'tv_' + Math.random().toString(36).slice(2, 8);
    el.innerHTML = '';
    const inner = document.createElement('div');
    inner.id = cid;
    inner.style.cssText = 'width:100%;height:100%;';
    el.appendChild(inner);

    const initWidget = () => {
      if (!inner || !(window as any).TradingView) return;
      try {
        wid.current = new (window as any).TradingView.widget({
          container_id: cid,
          symbol,
          interval: interval || '60',
          style: TV_STYLE_MAP[chartType] ?? 1,
          timezone: 'Asia/Seoul',
          theme: 'dark',
          locale: 'kr',
          toolbar_bg: '#060B14',
          enable_publishing: false,
          allow_symbol_change: true,
          save_image: false,
          hide_side_toolbar: false,
          withdateranges: true,
          hide_legend: false,
          studies: ['RSI@tv-basicstudies', 'MACD@tv-basicstudies'],
          width: '100%',
          height: '100%',
          backgroundColor: '#060B14',
          gridColor: '#1A2D4A',
          overrides: {
            'paneProperties.background': '#060B14',
            'paneProperties.backgroundType': 'solid',
          },
        });
      } catch {}
    };

    // Load TV script if not already loaded
    if ((window as any).TradingView) {
      initWidget();
    } else {
      const existing = document.getElementById('tv-script');
      if (!existing) {
        const script = document.createElement('script');
        script.id = 'tv-script';
        script.src = 'https://s3.tradingview.com/tv.js';
        script.async = true;
        script.onload = initWidget;
        script.onerror = () => {
          el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:8px;background:#0F1924;color:#475569;font-size:11px;">
            <span style="font-size:24px">📊</span>
            <div>${symbol}</div>
            <div>TradingView 차트 로딩 실패</div>
            <div style="font-size:9px">광고 차단기 확인 또는 새로고침</div>
          </div>`;
        };
        document.head.appendChild(script);
      } else {
        // Script tag exists, wait for it
        const wait = setInterval(() => {
          if ((window as any).TradingView) { clearInterval(wait); initWidget(); }
        }, 200);
        setTimeout(() => clearInterval(wait), 8000);
      }
    }

    return () => {
      try { wid.current?.remove?.(); } catch {}
      wid.current = null;
    };
  }, [symbol, chartType, interval]);

  return (
    <div ref={ref} style={{ width:'100%', height:'100%', borderRadius:'inherit', overflow:'hidden', background:'#060B14' }}/>
  );
}

/* ── Main inline chart tab ── */
function ChartTab() {
  const [sel,setSel]=useState<TVAsset>({sym:'BTC',label:'비트코인',tv:'BINANCE:BTCUSDT',cat:'crypto',clr:'#F7931A',featured:true});
  const [sel2,setSel2]=useState<TVAsset>({sym:'NVDA',label:'엔비디아',tv:'NASDAQ:NVDA',cat:'stock_ai',clr:'#76B900',featured:true});
  const [query,setQuery]=useState('');
  const [catFilt,setCatFilt]=useState<string>('featured');
  const [subCat,setSubCat]=useState<string>('all');
  const [layout,setLayout]=useState<'1'|'2h'>('1');
  const [manualSym,setManualSym]=useState('');
  const [showManual,setShowManual]=useState(false);
  const [liveData,setLiveData]=useState<Record<string,{price:number;change:number}>>({});
  const [provStatus,setProvStatus]=useState<{source:string;latency:number;status:string}|null>(null);
  const [recent,setRecent]=useState<TVAsset[]>(()=>{
    if(typeof window==='undefined') return [];
    try{return JSON.parse(localStorage.getItem('tg_tv_recent')||'[]');}catch{return [];}
  });
  const [watchlist,setWatchlist]=useState<TVAsset[]>(()=>{
    if(typeof window==='undefined') return [];
    try{return JSON.parse(localStorage.getItem('tg_tv_watchlist')||'[]');}catch{return [];}
  });

  useEffect(()=>{
    let cancelled=false;
    async function fetchData(){
      try{
        const res=await fetch('/api/prices');
        const json=await res.json();
        if(cancelled) return;
        setProvStatus({source:json.source,latency:json.latency,status:json.status});
        const map:Record<string,{price:number;change:number}>={};
        for(const item of (json.data||[])) map[item.symbol]={price:item.price,change:item.change24h};
        setLiveData(map);
      }catch{}
    }
    fetchData();
    const iv=setInterval(fetchData,15000);
    return()=>{cancelled=true;clearInterval(iv);};
  },[]);

  const pickAsset=(f:TVAsset)=>{
    setSel(f);setQuery('');
    const next=[f,...recent.filter(r=>r.tv!==f.tv)].slice(0,12);
    setRecent(next);
    if(typeof window!=='undefined') localStorage.setItem('tg_tv_recent',JSON.stringify(next));
  };

  const addWatchlist=(f:TVAsset)=>{
    const next=[f,...watchlist.filter(w=>w.tv!==f.tv)].slice(0,50);
    setWatchlist(next);
    if(typeof window!=='undefined') localStorage.setItem('tg_tv_watchlist',JSON.stringify(next));
  };

  const applyManual=()=>{
    if(!manualSym.trim()) return;
    const tv=tvSymbol(manualSym);
    const f:TVAsset={sym:manualSym.toUpperCase(),label:manualSym.toUpperCase(),tv,cat:'stock',clr:T.acl};
    pickAsset(f);setManualSym('');setShowManual(false);
  };

  // Category system
  const CAT_TABS=[
    {id:'featured',l:'⭐ 인기',icon:'⭐'},
    {id:'crypto',l:'코인',icon:'₿'},
    {id:'stock',l:'미국주식',icon:'🇺🇸'},
    {id:'etf',l:'ETF',icon:'📦'},
    {id:'krstock',l:'한국',icon:'🇰🇷'},
    {id:'index',l:'지수',icon:'📊'},
    {id:'commodity',l:'원자재',icon:'🛢'},
    {id:'forex',l:'환율',icon:'💱'},
    {id:'watchlist',l:'관심',icon:'💜'},
    {id:'recent',l:'최근',icon:'🕐'},
  ];

  const STOCK_SUB=[
    {id:'all',l:'전체'},
    {id:'stock_tech',l:'테크'},
    {id:'stock_ai',l:'AI/반도체'},
    {id:'stock_finance',l:'금융'},
    {id:'stock_energy',l:'에너지'},
    {id:'stock_health',l:'헬스케어'},
    {id:'stock_consumer',l:'소비재'},
    {id:'stock_defense',l:'방산'},
    {id:'stock_meme',l:'밈주식'},
  ];

  // Get display list
  let displayList: TVAsset[];
  if(catFilt==='watchlist') displayList=watchlist;
  else if(catFilt==='recent') displayList=recent;
  else if(catFilt==='featured') displayList=TV_FEATURED.filter(f=>f.featured);
  else if(catFilt==='stock'){
    displayList = subCat==='all'
      ? TV_FEATURED.filter(f=>f.cat.startsWith('stock'))
      : TV_FEATURED.filter(f=>f.cat===subCat);
  }
  else if(catFilt==='crypto') displayList=TV_FEATURED.filter(f=>f.cat==='crypto');
  else if(catFilt==='etf')    displayList=TV_FEATURED.filter(f=>f.cat==='etf');
  else if(catFilt==='krstock') displayList=TV_FEATURED.filter(f=>f.cat==='krstock');
  else if(catFilt==='index')  displayList=TV_FEATURED.filter(f=>f.cat==='index'||f.cat==='krstock');
  else if(catFilt==='commodity') displayList=TV_FEATURED.filter(f=>f.cat==='commodity');
  else if(catFilt==='forex')  displayList=TV_FEATURED.filter(f=>f.cat==='forex');
  else displayList=TV_FEATURED;

  // Apply search
  if(query.trim()){
    const q=query.trim().toLowerCase();
    displayList=TV_FEATURED.filter(f=>
      f.sym.toLowerCase().includes(q)||
      f.label.includes(q)||
      f.tv.toLowerCase().includes(q)
    );
  }

  const selBase=sel.sym.replace('USDT','').replace('USD','');
  const selLive=liveData[selBase]||liveData[sel.sym];

  // Logo helper
  const Logo=({asset,size=22}:{asset:TVAsset;size?:number})=>(
    <div style={{width:size,height:size,borderRadius:size*0.3,background:`${asset.clr}20`,border:`1px solid ${asset.clr}40`,display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden',flexShrink:0}}>
      {asset.logo
        ? <img src={`https://logo.clearbit.com/${asset.logo}`} alt="" width={size} height={size}
            onError={e=>{try{(e.target as HTMLImageElement).style.display='none';}catch{}}}
            style={{objectFit:'contain',borderRadius:size*0.3}}/>
        : <span style={{fontSize:size*0.5,fontWeight:900,color:asset.clr}}>{asset.sym.slice(0,2)}</span>
      }
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div style={{background:'linear-gradient(135deg,#060B14,#0A0F1E)',border:`1px solid ${sel.clr}40`,borderRadius:18,padding:'14px 16px',marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
          <div style={{display:'flex',gap:8,alignItems:'center',flex:1}}>
            <Logo asset={sel} size={32}/>
            <div>
              <div style={{display:'flex',gap:5,alignItems:'center',flexWrap:'wrap'}}>
                <span style={{color:T.txt,fontWeight:800,fontSize:14}}>{sel.label}</span>
                <span style={{background:`${sel.clr}20`,color:sel.clr,fontSize:9,fontWeight:700,padding:'2px 6px',borderRadius:99}}>{sel.sym}</span>
                {provStatus&&<span style={{background:provStatus.status==='live'?T.grn+'20':T.ylw+'20',color:provStatus.status==='live'?T.grn:T.ylw,fontSize:8,fontWeight:700,padding:'1px 6px',borderRadius:99}}>{provStatus.status==='live'?'● LIVE':'● MOCK'} {provStatus.source}</span>}
              </div>
              <div style={{color:T.muted,fontSize:10,fontFamily:'monospace',marginTop:1}}>{sel.tv}</div>
            </div>
          </div>
          <div style={{textAlign:'right',flexShrink:0}}>
            {selLive?(
              <div>
                <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>
                  {selLive.price>=1000?selLive.price.toLocaleString('ko-KR',{maximumFractionDigits:0})+'원':selLive.price.toFixed(4)}
                </div>
                <div style={{color:selLive.change>=0?T.grn:T.red,fontSize:11,fontWeight:700,textAlign:'right'}}>
                  {selLive.change>=0?'+':''}{selLive.change.toFixed(2)}%
                </div>
              </div>
            ):<div style={{color:T.muted,fontSize:10}}>가격 로딩 중…</div>}
          </div>
        </div>
        <div style={{display:'flex',gap:5,alignItems:'center',flexWrap:'wrap'}}>
          {(['1','2h'] as const).map(l=>(
            <button key={l} onClick={()=>setLayout(l)} style={{padding:'4px 9px',background:layout===l?T.acg:'transparent',color:layout===l?T.acl:T.muted,border:`1px solid ${layout===l?T.acl:T.border}`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>
              {l==='1'?'▣ 1':'⬒ 2분할'}
            </button>
          ))}
          <button onClick={()=>addWatchlist(sel)} style={{padding:'4px 9px',background:watchlist.some(w=>w.tv===sel.tv)?T.ylw+'20':'transparent',color:watchlist.some(w=>w.tv===sel.tv)?T.ylw:T.muted,border:`1px solid ${watchlist.some(w=>w.tv===sel.tv)?T.ylw:T.border}`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>
            {watchlist.some(w=>w.tv===sel.tv)?'★ 저장됨':'☆ 관심'}
          </button>
          <a href="/chart" target="_blank" style={{marginLeft:'auto',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,textDecoration:'none'}}>⛶ 전체 ↗</a>
        </div>
      </div>

      {/* Chart */}
      {layout==='1'&&(
        <div style={{height:420,borderRadius:12,overflow:'hidden',border:`1px solid ${T.border}`,marginBottom:12,background:T.card}}>
          <InlineTVChart symbol={sel.tv}/>
        </div>
      )}
      {layout==='2h'&&(
        <div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:8}}>
            <div style={{height:350,borderRadius:10,overflow:'hidden',border:`1px solid ${T.border}`,background:T.card}}><InlineTVChart symbol={sel.tv}/></div>
            <div style={{height:350,borderRadius:10,overflow:'hidden',border:`1px solid ${T.border}`,background:T.card}}><InlineTVChart symbol={sel2.tv}/></div>
          </div>
          {/* Chart 2 selector - horizontal scroll of featured */}
          <div style={{display:'flex',gap:5,overflowX:'auto',marginBottom:8,paddingBottom:2}}>
            {TV_FEATURED.filter(f=>f.featured).slice(0,12).map(f=>(
              <button key={f.tv} onClick={()=>setSel2(f)} style={{flexShrink:0,background:sel2.tv===f.tv?f.clr+'20':T.card,border:`1px solid ${sel2.tv===f.tv?f.clr:T.border}`,borderRadius:8,padding:'4px 8px',cursor:'pointer',display:'flex',gap:4,alignItems:'center'}}>
                <Logo asset={f} size={14}/>
                <span style={{color:sel2.tv===f.tv?f.clr:T.txt,fontSize:9,fontWeight:700}}>{f.sym}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      <div style={{display:'flex',gap:6,marginBottom:8}}>
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="검색: BTC, 애플, AAPL, 삼성, 005930…"
          style={{flex:1,background:T.card,border:`1px solid ${query?T.acl:T.border}`,borderRadius:10,padding:'9px 12px',color:T.txt,fontSize:12,outline:'none'}}/>
        <button onClick={()=>setShowManual(v=>!v)} style={{background:showManual?T.acg:'transparent',color:showManual?T.acl:T.muted,border:`1px solid ${showManual?T.acl:T.border}`,borderRadius:10,padding:'9px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>⌨️</button>
      </div>

      {/* Manual input */}
      {showManual&&(
        <div style={{marginBottom:8}}>
          <div style={{display:'flex',gap:6,marginBottom:5}}>
            <input value={manualSym} onChange={e=>setManualSym(e.target.value.toUpperCase())} onKeyDown={e=>e.key==='Enter'&&applyManual()}
              placeholder="NASDAQ:AAPL, KRX:005930, BINANCE:BTCUSDT…"
              style={{flex:1,background:T.card,border:`1px solid ${T.acl}`,borderRadius:10,padding:'9px 12px',color:T.acl,fontSize:12,fontFamily:'monospace',fontWeight:700,outline:'none',letterSpacing:.5}}/>
            <button onClick={applyManual} style={{background:T.acc,color:'#fff',border:'none',borderRadius:10,padding:'9px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>차트</button>
          </div>
          {/* Symbol format hints */}
          <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
            {['NASDAQ:AAPL','NYSE:KO','AMEX:SPY','KRX:005930','BINANCE:BTCUSDT','OANDA:XAUUSD'].map(ex=>(
              <button key={ex} onClick={()=>setManualSym(ex)} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:6,padding:'3px 8px',color:T.muted,fontSize:9,fontFamily:'monospace',cursor:'pointer'}}>{ex}</button>
            ))}
          </div>
        </div>
      )}

      {/* Category tabs */}
      <div style={{display:'flex',gap:4,overflowX:'auto',paddingBottom:3,marginBottom:6}}>
        {CAT_TABS.map(c=>(
          <button key={c.id} onClick={()=>{setCatFilt(c.id);setSubCat('all');setQuery('');}} style={{flexShrink:0,padding:'5px 9px',background:catFilt===c.id?T.acg:'transparent',color:catFilt===c.id?T.acl:T.muted,border:`1px solid ${catFilt===c.id?T.acl:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>
            {c.icon} {c.l}
            {c.id==='watchlist'&&watchlist.length>0&&<span style={{marginLeft:3,background:T.ylw+'20',color:T.ylw,borderRadius:99,padding:'0 4px',fontSize:8}}>{watchlist.length}</span>}
          </button>
        ))}
      </div>

      {/* Stock sub-category tabs */}
      {catFilt==='stock'&&!query&&(
        <div style={{display:'flex',gap:3,overflowX:'auto',paddingBottom:3,marginBottom:6}}>
          {STOCK_SUB.map(s=>(
            <button key={s.id} onClick={()=>setSubCat(s.id)} style={{flexShrink:0,padding:'3px 8px',background:subCat===s.id?T.prp+'20':'transparent',color:subCat===s.id?T.prp:T.muted,border:`1px solid ${subCat===s.id?T.prp:T.border}`,borderRadius:20,fontSize:9,fontWeight:700,cursor:'pointer'}}>
              {s.l}
            </button>
          ))}
        </div>
      )}

      {/* Stats row */}
      {!query&&(
        <div style={{color:T.muted,fontSize:9,marginBottom:6}}>
          {catFilt==='featured'?`⭐ 인기 ${displayList.length}개`:
           catFilt==='watchlist'?`💜 관심종목 ${displayList.length}개`:
           catFilt==='recent'?`🕐 최근 ${displayList.length}개`:
           `${displayList.length}개 종목`}
          {catFilt==='stock'&&subCat==='all'&&` · 전 섹터 ${TV_FEATURED.filter(f=>f.cat.startsWith('stock')).length}개`}
        </div>
      )}
      {query&&<div style={{color:T.acl,fontSize:9,marginBottom:6}}>🔍 "{query}" 검색 결과: {displayList.length}개</div>}

      {/* Empty states */}
      {catFilt==='watchlist'&&watchlist.length===0&&(
        <div style={{textAlign:'center',padding:'30px 0'}}>
          <div style={{fontSize:28,marginBottom:6}}>💜</div>
          <div style={{color:T.muted,fontSize:12}}>관심 종목이 없습니다</div>
          <div style={{color:T.muted,fontSize:10,marginTop:3}}>종목 선택 후 ☆ 관심 버튼으로 추가하세요</div>
        </div>
      )}
      {catFilt==='recent'&&recent.length===0&&(
        <div style={{textAlign:'center',padding:'30px 0'}}>
          <div style={{color:T.muted,fontSize:12}}>최근 본 종목이 없습니다</div>
        </div>
      )}

      {/* Asset grid */}
      {displayList.length>0&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:5,marginBottom:12}}>
          {displayList.slice(0,80).map(f=>{
            const base=f.sym.replace('USDT','').replace('USD','');
            const live=liveData[base]||liveData[f.sym];
            const isActive=sel.tv===f.tv;
            const inWL=watchlist.some(w=>w.tv===f.tv);
            return (
              <button key={f.tv} onClick={()=>pickAsset(f)}
                style={{background:isActive?f.clr+'20':T.card,border:`2px solid ${isActive?f.clr:T.border}`,borderRadius:11,padding:'8px 5px',cursor:'pointer',textAlign:'center',position:'relative'}}>
                {inWL&&<div style={{position:'absolute',top:2,right:3,color:T.ylw,fontSize:7,fontWeight:900}}>★</div>}
                <Logo asset={f} size={24}/>
                <div style={{color:isActive?f.clr:T.txt,fontWeight:700,fontSize:9,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginTop:3}}>{f.sym.slice(0,7)}</div>
                {live?(
                  <div style={{color:live.change>=0?T.grn:T.red,fontSize:7,marginTop:1,fontWeight:700}}>{live.change>=0?'+':''}{live.change.toFixed(1)}%</div>
                ):(
                  <div style={{color:T.muted,fontSize:7,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{f.label.slice(0,5)}</div>
                )}
              </button>
            );
          })}
        </div>
      )}
      {displayList.length>80&&<div style={{color:T.muted,fontSize:10,textAlign:'center',marginBottom:8}}>표시: 80/{displayList.length}개 · 검색으로 종목을 찾아보세요</div>}

      {/* Provider & search hint */}
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 14px',marginBottom:8}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5}}>
          <div style={{color:T.muted,fontSize:10,fontWeight:700}}>📡 데이터 소스</div>
          <div style={{display:'flex',gap:6}}>
            {[{n:'Binance',s:'live'},{n:'Polygon',s:'live'}].map(p=>(
              <div key={p.n} style={{display:'flex',gap:2,alignItems:'center'}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:p.s==='live'?T.grn:T.muted}}/>
                <span style={{color:T.muted,fontSize:8}}>{p.n}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{color:T.muted,fontSize:9,lineHeight:1.5}}>
          🇺🇸 미국주식 전체: ⌨️ 직접 입력으로 TradingView 심볼 검색 (NASDAQ:AAPL, NYSE:KO)<br/>
          🔍 원하는 종목이 없으면 ⌨️ 직접 입력 → 관심 ☆ 저장
        </div>
      </div>

      <div style={{textAlign:'center'}}>
        <a href="/chart" target="_blank" style={{color:T.acl,fontSize:11,fontWeight:700,textDecoration:'none'}}>📊 4분할 + 전체화면 전용 차트 ↗</a>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   TRAIGO DRAWING SYSTEM — 완전한 드로잉 엔진
   저장·복원·편집·실행취소·스타일·위험도구·피보나치
   ══════════════════════════════════════════════════════════════════ */

/* ─── Core Drawing Types ─── */
type DrawingToolId = string;
type DrawingPoint  = { x: number; y: number; price?: number; bar?: number };

interface DrawingObject {
  id: string;
  toolId: DrawingToolId;
  toolLabel: string;
  symbol: string;
  timeframe: string;
  points: DrawingPoint[];
  priceLevel?: number;
  priceLevel2?: number;
  text?: string;
  style: {
    color: string;
    width: number;
    dash: 'solid'|'dashed'|'dotted';
    fillColor?: string;
    fillOpacity?: number;
    textSize?: number;
    fontWeight?: 'normal'|'bold';
    opacity?: number;
  };
  locked: boolean;
  hidden: boolean;
  selected?: boolean;
  name?: string;
  createdAt: string;
  updatedAt: string;
  // Risk tool fields
  riskEntry?: number;
  riskSL?: number;
  riskTP?: number;
  // Fib fields
  fibLevels?: { level: number; label: string; color: string }[];
}

interface DrawingAction {
  type: 'add'|'delete'|'update'|'move';
  prev: DrawingObject | null;
  next: DrawingObject | null;
}

interface LayoutData {
  id: string;
  name: string;
  symbol: string;
  interval: string;
  chartType: string;
  indicators: string[];
  drawings: DrawingObject[];
  chartType2?: string;
  symbol2?: string;
  createdAt: string;
  updatedAt: string;
}

/* ─── Drawing Tool Definitions ─── */
type DrawingTool = { id:string; label:string; icon:string; group:string };

const DRAWING_TOOLS: DrawingTool[] = [
  {id:'cursor',   label:'커서',           icon:'↗',  group:'tools'},
  {id:'ruler',    label:'자 (거리측정)',   icon:'📏', group:'tools'},
  {id:'eraser',   label:'지우개',         icon:'🧹', group:'tools'},
  {id:'magnet',   label:'자석 스냅',      icon:'🧲', group:'tools'},
  {id:'lock',     label:'모두 잠금',      icon:'🔒', group:'tools'},
  {id:'hide_all', label:'모두 숨기기',    icon:'👁', group:'tools'},
  {id:'trendline',label:'추세선',         icon:'/',  group:'trend'},
  {id:'hline',    label:'수평선',         icon:'—',  group:'trend'},
  {id:'vline',    label:'수직선',         icon:'|',  group:'trend'},
  {id:'cross',    label:'크로스선',       icon:'+',  group:'trend'},
  {id:'channel',  label:'채널',           icon:'⫿', group:'trend'},
  {id:'ray',      label:'레이',           icon:'→',  group:'trend'},
  {id:'regression',label:'회귀채널',      icon:'≈',  group:'trend'},
  {id:'fib_ret',  label:'피보나치 되돌림',icon:'🌀', group:'fib'},
  {id:'fib_ext',  label:'피보나치 확장',  icon:'↔', group:'fib'},
  {id:'fib_chan', label:'피보나치 채널',  icon:'🔀', group:'fib'},
  {id:'fib_time', label:'피보나치 타임존',icon:'⏱', group:'fib'},
  {id:'fib_fan',  label:'피보나치 팬',    icon:'🌈', group:'fib'},
  {id:'gann_fan', label:'갠 팬',          icon:'⚡', group:'fib'},
  {id:'gann_sq',  label:'갠 사각형',      icon:'⊞',  group:'fib'},
  {id:'xabcd',    label:'XABCD 패턴',    icon:'⛤',  group:'patterns'},
  {id:'abcd',     label:'ABCD 패턴',     icon:'◈',  group:'patterns'},
  {id:'triangle', label:'삼각형 패턴',   icon:'△',  group:'patterns'},
  {id:'hs',       label:'머리어깨',       icon:'⛰',  group:'patterns'},
  {id:'wave',     label:'엘리어트 파동', icon:'〜', group:'patterns'},
  {id:'wedge',    label:'웨지',           icon:'◁',  group:'patterns'},
  {id:'long_pos', label:'롱 포지션',      icon:'📈', group:'predict'},
  {id:'short_pos',label:'숏 포지션',      icon:'📉', group:'predict'},
  {id:'forecast', label:'예측 범위',      icon:'🔮', group:'predict'},
  {id:'vwap',     label:'앵커 VWAP',      icon:'⚓', group:'predict'},
  {id:'pricelvl', label:'가격 레벨',      icon:'━',  group:'predict'},
  {id:'brush',    label:'브러시',         icon:'🖌', group:'geo'},
  {id:'highlight',label:'하이라이터',     icon:'🖍', group:'geo'},
  {id:'arrow',    label:'화살표',         icon:'➤',  group:'geo'},
  {id:'rect',     label:'사각형',         icon:'□',  group:'geo'},
  {id:'ellipse',  label:'타원',           icon:'○',  group:'geo'},
  {id:'triangle2',label:'삼각형',         icon:'△',  group:'geo'},
  {id:'path',     label:'경로',           icon:'✏', group:'geo'},
  {id:'text',     label:'텍스트',         icon:'T',  group:'geo'},
  {id:'price_note',label:'가격 메모',     icon:'💬', group:'geo'},
  {id:'balloon',  label:'풍선',           icon:'💭', group:'geo'},
];

/* ─── Intervals ─── */
type Interval = { id:string; label:string; group:string };
const INTERVALS: Interval[] = [
  {id:'1T',  label:'1틱',   group:'tick'},  {id:'10T', label:'10틱',  group:'tick'},
  {id:'100T',label:'100틱', group:'tick'},  {id:'1000T',label:'1000틱',group:'tick'},
  {id:'1s',  label:'1초',   group:'seconds'},{id:'5s',  label:'5초',   group:'seconds'},
  {id:'10s', label:'10초',  group:'seconds'},{id:'15s', label:'15초',  group:'seconds'},
  {id:'30s', label:'30초',  group:'seconds'},
  {id:'1',   label:'1분',   group:'minutes'},{id:'2',   label:'2분',   group:'minutes'},
  {id:'3',   label:'3분',   group:'minutes'},{id:'5',   label:'5분',   group:'minutes'},
  {id:'10',  label:'10분',  group:'minutes'},{id:'15',  label:'15분',  group:'minutes'},
  {id:'30',  label:'30분',  group:'minutes'},{id:'45',  label:'45분',  group:'minutes'},
  {id:'60',  label:'1시간', group:'hours'},  {id:'120', label:'2시간', group:'hours'},
  {id:'180', label:'3시간', group:'hours'},  {id:'240', label:'4시간', group:'hours'},
  {id:'D',   label:'1일',   group:'days'},   {id:'W',   label:'1주',   group:'days'},
  {id:'M',   label:'1월',   group:'days'},   {id:'3M',  label:'3월',   group:'days'},
  {id:'6M',  label:'6월',   group:'days'},   {id:'12M', label:'1년',   group:'days'},
];

/* ─── Chart Types ─── */
type ChartType = { id:string; label:string; icon:string };
const CHART_TYPES: ChartType[] = [
  {id:'1',  label:'캔들스틱',      icon:'🕯'},{id:'9',  label:'속빈 캔들',  icon:'◻'},
  {id:'2',  label:'바',            icon:'⊟'},{id:'3',  label:'색상 바',    icon:'🎨'},
  {id:'0',  label:'선',            icon:'〰'},{id:'8',  label:'영역',       icon:'▽'},
  {id:'10', label:'기준선',        icon:'↕'},{id:'15', label:'스텝 라인',  icon:'⌐'},
  {id:'16', label:'HLC 영역',      icon:'≋'},{id:'6',  label:'고-저',      icon:'|'},
  {id:'habikinashi',label:'헤이킨 아시',icon:'🕯'},
  {id:'5',  label:'렌코',          icon:'🧱'},{id:'11', label:'카기',       icon:'⋮'},
  {id:'4',  label:'라인 브레이크', icon:'📉'},{id:'12', label:'포인트&피겨',icon:'✕'},
  {id:'13', label:'레인지 바',     icon:'📊'},
  {id:'vol_candle',label:'볼륨 캔들',icon:'📊'},
  {id:'vol_footprint',label:'볼륨 풋프린트',icon:'👣'},
  {id:'tpo',label:'TPO 차트',      icon:'⬡'},
  {id:'session_vol',label:'세션 볼륨',icon:'📈'},
];

const CHART_TYPE_DESC: Record<string,string> = {
  '1':'표준 캔들','9':'속빈 캔들','2':'OHLC 바','3':'색상 바','0':'선형',
  '8':'영역','10':'기준선','15':'스텝','16':'HLC 영역','6':'고가-저가',
  'habikinashi':'헤이킨 아시 평균 캔들','5':'렌코 벽돌','11':'카기','4':'라인 브레이크',
  '12':'포인트 & 피겨','13':'레인지 바','vol_candle':'볼륨 캔들',
  'vol_footprint':'볼륨 풋프린트','tpo':'TPO(시간·가격)','session_vol':'세션 볼륨 프로파일',
};

/* ─── Analysis Tab ─── */
type AnalysisTab = 'hub'|'layout'|'tools'|'drawing'|'interval'|'indicators'|'info'|'paper'|'pine'|'more';
type ObjectTree  = { id:string; type:string; symbol:string; color:string; visible:boolean; locked?:boolean; name?:string };
type ChartLayout = { id:string; name:string; symbols:string[]; intervals:string[]; createdAt:string };

/* ─── Indicator List ─── */
const INDICATORS_LIST = [
  {id:'RSI',    label:'RSI',                  category:'momentum',  key:'RSI@tv-basicstudies'},
  {id:'MACD',   label:'MACD',                 category:'momentum',  key:'MACD@tv-basicstudies'},
  {id:'BOLL',   label:'볼린저 밴드',           category:'volatility',key:'BB@tv-basicstudies'},
  {id:'EMA',    label:'지수이동평균 (EMA)',     category:'trend',     key:'EMA@tv-basicstudies'},
  {id:'SMA',    label:'단순이동평균 (SMA)',     category:'trend',     key:'SMA@tv-basicstudies'},
  {id:'VWAP',   label:'VWAP',                 category:'volume',    key:'VWAP@tv-basicstudies'},
  {id:'OBV',    label:'OBV',                  category:'volume',    key:'OBV@tv-basicstudies'},
  {id:'STOCH',  label:'스토캐스틱',            category:'momentum',  key:'Stochastic@tv-basicstudies'},
  {id:'ATR',    label:'ATR',                  category:'volatility',key:'ATR@tv-basicstudies'},
  {id:'ADX',    label:'ADX',                  category:'trend',     key:'DMI@tv-basicstudies'},
  {id:'CCI',    label:'CCI',                  category:'momentum',  key:'CCI@tv-basicstudies'},
  {id:'MFI',    label:'머니플로우',            category:'volume',    key:'MFI@tv-basicstudies'},
  {id:'WR',     label:'윌리엄스 %R',           category:'momentum',  key:'WilliamsR@tv-basicstudies'},
  {id:'ICHIMOKU',label:'일목균형표',           category:'trend',     key:'IchimokuCloud@tv-basicstudies'},
  {id:'PSAR',   label:'파라볼릭 SAR',          category:'trend',     key:'Parabolic SAR@tv-basicstudies'},
  {id:'PIVOT',  label:'피봇 포인트',           category:'trend',     key:'Pivot Points Standard@tv-basicstudies'},
  {id:'SUPER',  label:'슈퍼트렌드',            category:'trend',     key:'Supertrend@tv-basicstudies'},
  {id:'VOL',    label:'거래량',                category:'volume',    key:'Volume@tv-basicstudies'},
  {id:'RVOL',   label:'상대 거래량',           category:'volume',    key:'Relative Volume at Time@tv-basicstudies'},
  {id:'ACCUM',  label:'축적/분산',             category:'volume',    key:'Accumulation Distribution@tv-basicstudies'},
];

/* ─── Korean Search Map ─── */
const KR_SEARCH_MAP: Record<string,string> = {
  '비트코인':'BTC','이더리움':'ETH','솔라나':'SOL','엔비디아':'NVDA',
  '애플':'AAPL','테슬라':'TSLA','구글':'GOOGL','플래닛랩스':'PL',
};

/* ── Storage helpers ── */
const STORAGE_KEY_DRAWINGS = 'tg_drawings_v2';
const STORAGE_KEY_LAYOUTS  = 'tg_layouts_v2';

function loadDrawings(): DrawingObject[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_DRAWINGS) || '[]'); } catch { return []; }
}
function saveDrawings(drawings: DrawingObject[]): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY_DRAWINGS, JSON.stringify(drawings)); } catch {}
}
function loadLayouts(): LayoutData[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_LAYOUTS) || '[]'); } catch { return []; }
}
function saveLayouts(layouts: LayoutData[]): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY_LAYOUTS, JSON.stringify(layouts)); } catch {}
}

/* ── Default fib levels ── */
const DEFAULT_FIB_LEVELS = [
  { level: 0,     label: '0',     color: '#94A3B8' },
  { level: 0.236, label: '0.236', color: '#3B82F6' },
  { level: 0.382, label: '0.382', color: '#10B981' },
  { level: 0.5,   label: '0.5',   color: '#F59E0B' },
  { level: 0.618, label: '0.618', color: '#EF4444' },
  { level: 0.786, label: '0.786', color: '#7C3AED' },
  { level: 1,     label: '1',     color: '#94A3B8' },
  { level: 1.272, label: '1.272', color: '#0891B2' },
  { level: 1.618, label: '1.618', color: '#EF4444' },
];

/* ══════════════════════════════════════════════════════════════════
   AnalysisHubPage
   ══════════════════════════════════════════════════════════════════ */
function AnalysisHubPage() {
  /* ── Core state ── */
  const [tab,setTab]                 = useState<AnalysisTab>('hub');
  const [activeTool,setActiveTool]   = useState('cursor');
  const [activeInterval,setActiveInterval] = useState('60');
  const [chartType,setChartType]     = useState(()=>{ if(typeof window==='undefined') return '1'; try{return localStorage.getItem('tg_charttype')||'1';}catch{return '1';} });
  const [activeIndicators,setActiveIndicators] = useState<string[]>(['RSI','MACD']);
  const [indFilter,setIndFilter]     = useState('all');
  const [indSearch,setIndSearch]     = useState('');
  const [drawingGroup,setDrawingGroup] = useState('tools');
  const [showSheet,setShowSheet]     = useState(false);
  const [sheetContent,setSheetContent] = useState<'drawing'|'interval'|'charttype'|'objecttree'|'style'|'risk'|'fib'|'indicators'|'compare'|'alerts'|'replay'|'templates'|'symbol_info'|'financials'|'forecasts'|'technicals'|'idea'|'pine'|'help'|'paper_order'>('drawing');
  const [magnetMode,setMagnetMode]   = useState(false);
  const [customInterval,setCustomInterval] = useState('');

  /* ── Drawing state ── */
  const [drawings,setDrawings]       = useState<DrawingObject[]>(loadDrawings);
  const [selectedId,setSelectedId]   = useState<string|null>(null);
  const [undoStack,setUndoStack]     = useState<DrawingAction[]>([]);
  const [redoStack,setRedoStack]     = useState<DrawingAction[]>([]);
  const [editingDrawing,setEditingDrawing] = useState<DrawingObject|null>(null);
  const [showStyleEditor,setShowStyleEditor] = useState(false);

  /* ── Layout state ── */
  const [layouts,setLayouts]         = useState<LayoutData[]>(loadLayouts);
  const [activeLayout,setActiveLayout] = useState<string|null>(null);
  const [showSaveLayout,setShowSaveLayout] = useState(false);
  const [newLayoutName,setNewLayoutName] = useState('');
  const [symbol,setSymbol]           = useState('BINANCE:BTCUSDT');
  const [symbol2,setSymbol2]         = useState('NASDAQ:NVDA');

  /* ── Risk tool state ── */
  const [riskEntry,setRiskEntry]     = useState(94230000);
  const [riskSL,setRiskSL]           = useState(91200000);
  const [riskTP,setRiskTP]           = useState(99000000);
  const [riskSize,setRiskSize]       = useState(1000000);
  const [riskLeverage,setRiskLeverage] = useState(3);

  /* ── Fib state ── */
  const [fibLevels,setFibLevels]     = useState(DEFAULT_FIB_LEVELS);
  const [fibShowLabels,setFibShowLabels] = useState(true);
  const [fibReverse,setFibReverse]   = useState(false);

  /* ── Paper trading ── */
  const [paperSize]  = useState(1000000);
  const [paperPnl]   = useState(87400);
  const [paperTrades]= useState(12);

  /* ── Persist chartType ── */
  useEffect(()=>{ try{localStorage.setItem('tg_charttype',chartType);}catch{} },[chartType]);
  useEffect(()=>{ saveDrawings(drawings); },[drawings]);

  /* ── Drawing helpers ── */
  const pushUndo=(action:DrawingAction)=>{
    setUndoStack(s=>[action,...s].slice(0,50));
    setRedoStack([]);
  };

  const undo=()=>{
    if(!undoStack.length) return;
    const [action,...rest]=undoStack;
    setUndoStack(rest);
    setRedoStack(s=>[action,...s].slice(0,50));
    if(action.type==='add'&&action.next)     setDrawings(d=>d.filter(x=>x.id!==action.next!.id));
    if(action.type==='delete'&&action.prev)  setDrawings(d=>[...d,action.prev!]);
    if((action.type==='update'||action.type==='move')&&action.prev)
      setDrawings(d=>d.map(x=>x.id===action.prev!.id?action.prev!:x));
  };

  const redo=()=>{
    if(!redoStack.length) return;
    const [action,...rest]=redoStack;
    setRedoStack(rest);
    setUndoStack(s=>[action,...s].slice(0,50));
    if(action.type==='add'&&action.next)     setDrawings(d=>[...d,action.next!]);
    if(action.type==='delete'&&action.next)  setDrawings(d=>d.filter(x=>x.id!==action.next!.id));
    if((action.type==='update'||action.type==='move')&&action.next)
      setDrawings(d=>d.map(x=>x.id===action.next!.id?action.next!:x));
  };

  const addDrawing=(toolId:string,priceLevel?:number,priceLevel2?:number)=>{
    const tool=DRAWING_TOOLS.find(d=>d.id===toolId);
    if(!tool) return;
    const newD:DrawingObject={
      id:'d_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
      toolId, toolLabel:tool.label,
      symbol, timeframe:activeInterval,
      points:[], priceLevel, priceLevel2,
      style:{
        color: toolId==='long_pos'?'#10B981':toolId==='short_pos'?'#EF4444':'#3B82F6',
        width:2, dash:'solid', opacity:1, textSize:12, fontWeight:'normal',
        ...(toolId.includes('fib')?{fillColor:'#3B82F620',fillOpacity:0.1}:{}),
      },
      locked:false, hidden:false, selected:true,
      fibLevels: toolId.includes('fib')?[...DEFAULT_FIB_LEVELS]:undefined,
      riskEntry:  toolId==='long_pos'||toolId==='short_pos'?riskEntry:undefined,
      riskSL:     toolId==='long_pos'||toolId==='short_pos'?riskSL:undefined,
      riskTP:     toolId==='long_pos'||toolId==='short_pos'?riskTP:undefined,
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString(),
    };
    pushUndo({type:'add',prev:null,next:newD});
    setDrawings(d=>[newD,...d.map(x=>({...x,selected:false}))]);
    setSelectedId(newD.id);
    setActiveTool('cursor');
  };

  const deleteDrawing=(id:string)=>{
    const d=drawings.find(x=>x.id===id);
    if(!d) return;
    pushUndo({type:'delete',prev:d,next:null});
    setDrawings(prev=>prev.filter(x=>x.id!==id));
    if(selectedId===id) setSelectedId(null);
  };

  const duplicateDrawing=(id:string)=>{
    const d=drawings.find(x=>x.id===id);
    if(!d) return;
    const copy={...d,id:'d_'+Date.now().toString(36),name:(d.name||d.toolLabel)+' 복사',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),selected:true};
    pushUndo({type:'add',prev:null,next:copy});
    setDrawings(prev=>[copy,...prev.map(x=>({...x,selected:false}))]);
    setSelectedId(copy.id);
  };

  const updateDrawingStyle=(id:string,style:Partial<DrawingObject['style']>)=>{
    const prev=drawings.find(x=>x.id===id);
    if(!prev) return;
    const next={...prev,style:{...prev.style,...style},updatedAt:new Date().toISOString()};
    pushUndo({type:'update',prev,next});
    setDrawings(d=>d.map(x=>x.id===id?next:x));
  };

  const toggleLock=(id:string)=>setDrawings(d=>d.map(x=>x.id===id?{...x,locked:!x.locked,updatedAt:new Date().toISOString()}:x));
  const toggleVisible=(id:string)=>setDrawings(d=>d.map(x=>x.id===id?{...x,hidden:!x.hidden,updatedAt:new Date().toISOString()}:x));
  const renameDrawing=(id:string,name:string)=>setDrawings(d=>d.map(x=>x.id===id?{...x,name,updatedAt:new Date().toISOString()}:x));
  const clearAllDrawings=()=>{ setDrawings([]); setSelectedId(null); setUndoStack([]); setRedoStack([]); };

  /* ── Layout helpers ── */
  const saveCurrentLayout=()=>{
    if(!newLayoutName.trim()) return;
    const layout:LayoutData={
      id:'lay_'+Date.now().toString(36),
      name:newLayoutName.trim(),
      symbol, interval:activeInterval, chartType,
      indicators:activeIndicators,
      drawings:[...drawings],
      symbol2, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    };
    const next=[layout,...layouts].slice(0,20);
    setLayouts(next); saveLayouts(next);
    setActiveLayout(layout.id);
    setShowSaveLayout(false); setNewLayoutName('');
  };

  const loadLayout=(layout:LayoutData)=>{
    setSymbol(layout.symbol);
    setActiveInterval(layout.interval);
    setChartType(layout.chartType);
    setActiveIndicators(layout.indicators||[]);
    setDrawings(layout.drawings||[]);
    if(layout.symbol2) setSymbol2(layout.symbol2);
    setActiveLayout(layout.id);
  };

  const deleteLayout=(id:string)=>{
    const next=layouts.filter(l=>l.id!==id);
    setLayouts(next); saveLayouts(next);
    if(activeLayout===id) setActiveLayout(null);
  };

  const exportLayout=()=>{
    const layout:LayoutData={
      id:'export_'+Date.now().toString(36),
      name:'내보내기',
      symbol, interval:activeInterval, chartType,
      indicators:activeIndicators, drawings,
      symbol2, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    };
    const blob=new Blob([JSON.stringify(layout,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download=`traigo_layout_${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const importLayout=(e:React.ChangeEvent<HTMLInputElement>)=>{
    const file=e.target.files?.[0];
    if(!file) return;
    const reader=new FileReader();
    reader.onload=(ev)=>{
      try{
        const layout:LayoutData=JSON.parse(ev.target?.result as string);
        loadLayout(layout);
      }catch{}
    };
    reader.readAsText(file);
  };

  /* ── Risk calculations ── */
  const riskReward    = riskEntry > 0 ? Math.abs(riskTP-riskEntry)/Math.abs(riskEntry-riskSL) : 0;
  const expectedProfit= riskSize*riskLeverage*(Math.abs(riskTP-riskEntry)/riskEntry);
  const expectedLoss  = riskSize*riskLeverage*(Math.abs(riskEntry-riskSL)/riskEntry);
  const liqPct        = 100/riskLeverage*0.9;
  const liqPrice      = activeTool==='long_pos'? riskEntry*(1-liqPct/100) : riskEntry*(1+liqPct/100);

  /* ── Computed ── */
  const selectedDrawing = drawings.find(d=>d.id===selectedId)||null;
  const visibleDrawings = drawings.filter(d=>!d.hidden);
  const DRAWING_GROUPS=[
    {id:'tools',l:'도구'},{id:'trend',l:'추세'},{id:'fib',l:'피보/갠'},
    {id:'patterns',l:'패턴'},{id:'predict',l:'예측'},{id:'geo',l:'도형'},
  ];
  const INTERVAL_GROUPS=[
    {id:'tick',l:'틱'},{id:'seconds',l:'초'},{id:'minutes',l:'분'},
    {id:'hours',l:'시간'},{id:'days',l:'일/주/월'},
  ];
  const IND_CATS=['all','trend','momentum','volatility','volume'];
  const filteredInds=INDICATORS_LIST.filter(i=>
    (indFilter==='all'||i.category===indFilter)&&
    (indSearch===''||i.label.includes(indSearch)||i.id.toLowerCase().includes(indSearch.toLowerCase()))
  );
  const openSheet=(c:'drawing'|'interval'|'charttype'|'objecttree'|'style'|'risk'|'fib')=>{setSheetContent(c);setShowSheet(true);};
  const toggleIndicator=(id:string)=>setActiveIndicators(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);

  /* ── Style editor values ── */
  const selStyle=selectedDrawing?.style||{color:'#3B82F6',width:2,dash:'solid',opacity:1,textSize:12,fontWeight:'normal'};

  /* ── Bottom sheet ── */
  const BottomSheet=({title,children}:{title:string;children:React.ReactNode})=>(
    <>
      <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200,touchAction:'none'}} onClick={()=>setShowSheet(false)}/>
      <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',maxHeight:'85vh',overflowY:'auto',border:`1px solid ${T.border}`,WebkitOverflowScrolling:'touch' as any}} onClick={e=>e.stopPropagation()}>
        <div style={{position:'sticky',top:0,background:T.surf,padding:'16px 16px 10px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center',zIndex:1}}>
          <div style={{color:T.txt,fontWeight:800,fontSize:14}}>{title}</div>
          <button onClick={()=>setShowSheet(false)} style={{background:'transparent',border:'none',color:T.muted,cursor:'pointer',fontSize:20,lineHeight:1}}>✕</button>
        </div>
        <div style={{padding:'12px 16px calc(44px + env(safe-area-inset-bottom, 0px))'}}>{children}</div>
      </div>
    </>
  );

  return (
    <div>
      {/* ── Top toolbar ── */}
      <div style={{background:'linear-gradient(135deg,#04060F,#080D1A)',border:`1px solid ${T.acl}30`,borderRadius:18,padding:'12px 14px',marginBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
          <div style={{display:'flex',gap:5,alignItems:'center'}}>
            <span style={{fontSize:16}}>🔬</span>
            <span style={{color:T.txt,fontWeight:800,fontSize:14}}>Analysis Hub</span>
            {undoStack.length>0&&<span style={{background:T.prp+'20',color:T.prp,fontSize:9,padding:'1px 6px',borderRadius:99,fontWeight:700}}>{undoStack.length} 기록</span>}
          </div>
          <div style={{display:'flex',gap:5}}>
            <button onClick={undo} disabled={!undoStack.length} style={{background:undoStack.length?T.alt:'transparent',color:undoStack.length?T.txt:T.muted,border:`1px solid ${T.border}`,borderRadius:7,padding:'4px 8px',fontSize:11,cursor:undoStack.length?'pointer':'default'}}>↩ 실행취소</button>
            <button onClick={redo} disabled={!redoStack.length} style={{background:redoStack.length?T.alt:'transparent',color:redoStack.length?T.txt:T.muted,border:`1px solid ${T.border}`,borderRadius:7,padding:'4px 8px',fontSize:11,cursor:redoStack.length?'pointer':'default'}}>↪ 다시실행</button>
            <a href="/chart" target="_blank" style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,textDecoration:'none'}}>⛶</a>
          </div>
        </div>
        {/* Quick tool bar */}
        <div style={{display:'flex',gap:4,overflowX:'auto'}}>
          <button onClick={()=>openSheet('interval')} style={{flexShrink:0,background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:7,padding:'5px 10px',fontSize:11,fontWeight:800,cursor:'pointer',fontFamily:'monospace'}}>
            {INTERVALS.find(i=>i.id===activeInterval)?.label||activeInterval}
          </button>
          <button onClick={()=>openSheet('charttype')} style={{flexShrink:0,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 10px',fontSize:13,cursor:'pointer'}}>
            {CHART_TYPES.find(c=>c.id===chartType)?.icon||'🕯'}
          </button>
          <button onClick={()=>setTab('indicators')} style={{flexShrink:0,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
            🔬{activeIndicators.length>0&&<span style={{background:T.acl,color:'#fff',borderRadius:99,padding:'0 3px',fontSize:8,marginLeft:2}}>{activeIndicators.length}</span>}
          </button>
          <button onClick={()=>openSheet('drawing')} style={{flexShrink:0,background:activeTool!=='cursor'?T.prp+'15':T.alt,color:activeTool!=='cursor'?T.prp:T.sub,border:`1px solid ${activeTool!=='cursor'?T.prp:T.border}`,borderRadius:7,padding:'5px 9px',fontSize:13,cursor:'pointer'}}>
            {DRAWING_TOOLS.find(d=>d.id===activeTool)?.icon||'↗'}
          </button>
          <button onClick={()=>setMagnetMode(v=>!v)} style={{flexShrink:0,background:magnetMode?T.ylw+'20':T.alt,color:magnetMode?T.ylw:T.muted,border:`1px solid ${magnetMode?T.ylw:T.border}`,borderRadius:7,padding:'5px 9px',fontSize:12,cursor:'pointer'}} title="자석 스냅 모드">🧲</button>
          <button onClick={()=>openSheet('objecttree')} style={{flexShrink:0,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
            📋{drawings.length>0&&<span style={{background:T.muted+'80',color:T.txt,borderRadius:99,padding:'0 3px',fontSize:8,marginLeft:2}}>{drawings.length}</span>}
          </button>
          {selectedDrawing&&(
            <>
              <button onClick={()=>openSheet('style')} style={{flexShrink:0,background:T.alt,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 9px',cursor:'pointer'}}>
                <div style={{width:12,height:12,borderRadius:'50%',background:selectedDrawing.style.color,display:'inline-block'}}/>
              </button>
              {(selectedDrawing.toolId==='long_pos'||selectedDrawing.toolId==='short_pos')&&(
                <button onClick={()=>openSheet('risk')} style={{flexShrink:0,background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:7,padding:'5px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>위험</button>
              )}
              {selectedDrawing.toolId.includes('fib')&&(
                <button onClick={()=>openSheet('fib')} style={{flexShrink:0,background:T.ylw+'15',color:T.ylw,border:`1px solid ${T.ylw}30`,borderRadius:7,padding:'5px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>피보</button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Active tool indicator */}
      {activeTool!=='cursor'&&(
        <div style={{background:T.prp+'12',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'8px 12px',marginBottom:10,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{color:T.prp,fontWeight:700,fontSize:12}}>
            {DRAWING_TOOLS.find(d=>d.id===activeTool)?.icon} {DRAWING_TOOLS.find(d=>d.id===activeTool)?.label} 도구 활성
            {magnetMode&&' · 🧲 스냅'}
          </div>
          <div style={{display:'flex',gap:5}}>
            <button onClick={()=>addDrawing(activeTool,riskEntry,riskTP)} style={{background:T.prp,color:'#fff',border:'none',borderRadius:7,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>추가</button>
            <button onClick={()=>setActiveTool('cursor')} style={{background:T.prp+'20',color:T.prp,border:'none',borderRadius:7,padding:'4px 8px',fontSize:10,cursor:'pointer'}}>해제</button>
          </div>
        </div>
      )}

      {/* Main tabs */}
      <div style={{display:'flex',gap:4,marginBottom:12,overflowX:'auto'}}>
        {([['hub','🏠 허브'],['layout','📐 레이아웃'],['tools','🔧 도구'],['drawing','✏️ 드로잉'],['interval','⏱ 인터벌'],['indicators','🔬 지표'],['info','ℹ️ 정보'],['paper','🎮 모의'],['more','⋯ 더보기']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'7px 10px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* ── HUB ── */}
      {tab==='hub'&&(
        <div>
          {/* Chart preview */}
          <div style={{height:'min(340px,48vw)',borderRadius:14,overflow:'hidden',border:`1px solid ${T.border}`,marginBottom:12,background:T.card,position:'relative'}}>
            <InlineTVChart key={`${symbol}-${chartType}-${activeInterval}`} symbol={symbol} chartType={chartType} interval={activeInterval}/>
            <div style={{position:'absolute',top:8,right:8,display:'flex',flexDirection:'column',gap:3,zIndex:10}}>
              {DRAWING_TOOLS.filter(d=>['cursor','trendline','hline','fib_ret','long_pos','short_pos','rect','text'].includes(d.id)).map(d=>(
                <button key={d.id} onClick={()=>setActiveTool(d.id)} style={{width:30,height:30,background:activeTool===d.id?T.prp+'CC':T.card+'CC',color:activeTool===d.id?'#fff':T.sub,border:`1px solid ${activeTool===d.id?T.prp:T.border}`,borderRadius:7,cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center',backdropFilter:'blur(4px)',WebkitBackdropFilter:'blur(4px)'}}>
                  {d.icon}
                </button>
              ))}
            </div>
          </div>

          {/* ── TOOLS SECTION ── */}
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🔧 도구</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
              {[
                {icon:'🔬',label:'인디케이터',sheet:'indicators'},
                {icon:'🔀',label:'비교',sheet:'compare'},
                {icon:'🔔',label:'알림',sheet:'alerts'},
                {icon:'⏮',label:'바 리플레이',sheet:'replay'},
                {icon:'📋',label:'템플릿',sheet:'templates'},
                {icon:'📊',label:'차트 유형',sheet:'charttype'},
                {icon:'🌳',label:'오브젝트 트리',sheet:'objecttree'},
                {icon:'✏️',label:'드로잉',action:'drawing'},
              ].map(item=>(
                <button key={item.label} onClick={()=>{ if('sheet' in item && item.sheet) { openSheet(item.sheet as any); } else if('action' in item && item.action) setTab(item.action as any); }} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 6px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:20,marginBottom:4}}>{item.icon}</div>
                  <div style={{color:T.muted,fontSize:9,fontWeight:600,lineHeight:1.2}}>{item.label}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* ── INFO SECTION ── */}
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>ℹ️ 정보</div>
            <div style={{display:'flex',flexDirection:'column',gap:0}}>
              {[
                {icon:'📋',label:'심볼 정보',desc:'거래소 · 자산 유형 · 시가총액',sheet:'symbol_info'},
                {icon:'💰',label:'재무제표',desc:'매출 · EPS · PER (준비중)',sheet:'financials'},
                {icon:'🔮',label:'애널리스트 예측',desc:'목표가 · 추천 (준비중)',sheet:'forecasts'},
                {icon:'📊',label:'기술적 분석',desc:'매수/매도 신호 종합',sheet:'technicals'},
              ].map((item,i,arr)=>(
                <button key={item.label} onClick={()=>openSheet(item.sheet as any)} style={{display:'flex',gap:10,alignItems:'center',padding:'10px 0',background:'transparent',border:'none',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none',cursor:'pointer',textAlign:'left',width:'100%'}}>
                  <span style={{fontSize:20,flexShrink:0}}>{item.icon}</span>
                  <div style={{flex:1}}>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{item.label}</div>
                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>{item.desc}</div>
                  </div>
                  <span style={{color:T.muted,fontSize:14}}>›</span>
                </button>
              ))}
            </div>
          </Card>

          {/* ── MORE SECTION ── */}
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>⋯ 더보기</div>
            <div style={{display:'flex',flexDirection:'column',gap:0}}>
              {[
                {icon:'💡',label:'아이디어 작성',desc:'트레이딩 아이디어 공유',sheet:'idea'},
                {icon:'🌲',label:'파인 에디터',desc:'Pine Script 작성/편집',sheet:'pine'},
                {icon:'❓',label:'도움말',desc:'차트 도구 사용 가이드',sheet:'help'},
              ].map((item,i,arr)=>(
                <button key={item.label} onClick={()=>openSheet(item.sheet as any)} style={{display:'flex',gap:10,alignItems:'center',padding:'10px 0',background:'transparent',border:'none',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none',cursor:'pointer',textAlign:'left',width:'100%'}}>
                  <span style={{fontSize:20,flexShrink:0}}>{item.icon}</span>
                  <div style={{flex:1}}>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{item.label}</div>
                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>{item.desc}</div>
                  </div>
                  <span style={{color:T.muted,fontSize:14}}>›</span>
                </button>
              ))}
            </div>
          </Card>

          {/* ── PAPER TRADING PREVIEW ── */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.prp}30`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{color:T.prp,fontWeight:700}}>🎮 모의매매</div>
              <button onClick={()=>setTab('paper')} style={{background:T.prp+'20',color:T.prp,border:`1px solid ${T.prp}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>열기</button>
            </div>
            <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}25`,borderRadius:8,padding:'8px 10px',marginBottom:8}}>
              <div style={{color:T.ylw,fontSize:10,fontWeight:700}}>⚠️ 모의투자입니다. 실제 주문이 아닙니다.</div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6}}>
              <div style={{background:T.alt,borderRadius:8,padding:'7px',textAlign:'center'}}>
                <div style={{color:T.txt,fontSize:11,fontWeight:700,fontFamily:'monospace'}}>₩1,000,000</div>
                <div style={{color:T.muted,fontSize:8,marginTop:1}}>잔고</div>
              </div>
              <div style={{background:T.alt,borderRadius:8,padding:'7px',textAlign:'center'}}>
                <div style={{color:T.grn,fontSize:11,fontWeight:700}}>+₩87,400</div>
                <div style={{color:T.muted,fontSize:8,marginTop:1}}>모의 PnL</div>
              </div>
              <div style={{background:T.alt,borderRadius:8,padding:'7px',textAlign:'center'}}>
                <div style={{color:T.acl,fontSize:11,fontWeight:700}}>12건</div>
                <div style={{color:T.muted,fontSize:8,marginTop:1}}>거래</div>
              </div>
            </div>
          </Card>
        </div>
      )}
            {tab==='layout'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{color:T.txt,fontWeight:700}}>📐 레이아웃 저장</div>
              <div style={{display:'flex',gap:5}}>
                <button onClick={()=>setShowSaveLayout(v=>!v)} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 저장</button>
                <button onClick={exportLayout} style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'4px 10px',fontSize:11,cursor:'pointer'}}>↓ 내보내기</button>
                <label style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'4px 10px',fontSize:11,cursor:'pointer'}}>
                  ↑ 가져오기<input type="file" accept=".json" style={{display:'none'}} onChange={importLayout}/>
                </label>
              </div>
            </div>
            {showSaveLayout&&(
              <div style={{display:'flex',gap:6,marginBottom:10}}>
                <input value={newLayoutName} onChange={e=>setNewLayoutName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&saveCurrentLayout()} placeholder="레이아웃 이름" style={{flex:1,background:T.bg,border:`1px solid ${T.acl}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:16,outline:'none'}}/>
                <button onClick={saveCurrentLayout} disabled={!newLayoutName.trim()} style={{background:newLayoutName.trim()?T.acc:'#243A5E',color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>저장</button>
              </div>
            )}
            {layouts.length===0?(
              <div style={{color:T.muted,fontSize:11,textAlign:'center',padding:'16px 0'}}>저장된 레이아웃 없음 · 위에서 저장하세요</div>
            ):(
              <div style={{display:'flex',flexDirection:'column',gap:5}}>
                {layouts.map(l=>(
                  <div key={l.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:activeLayout===l.id?T.acg:T.alt,border:`1px solid ${activeLayout===l.id?T.acl:T.border}`,borderRadius:9,padding:'8px 12px',cursor:'pointer'}} onClick={()=>loadLayout(l)}>
                    <div>
                      <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{l.name}</div>
                      <div style={{color:T.muted,fontSize:9,marginTop:1}}>{l.symbol} · {l.interval} · {l.drawings?.length||0}개 드로잉 · {l.updatedAt?.split('T')[0]}</div>
                    </div>
                    <div style={{display:'flex',gap:4}}>
                      {activeLayout===l.id&&<Bdg c={T.grn} ch="활성"/>}
                      <button onClick={e=>{e.stopPropagation();deleteLayout(l.id);}} style={{background:T.red+'15',color:T.red,border:'none',borderRadius:6,padding:'2px 7px',fontSize:9,cursor:'pointer'}}>삭제</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📊 현재 설정</div>
            {[
              {l:'심볼',v:symbol},{l:'인터벌',v:INTERVALS.find(i=>i.id===activeInterval)?.label||activeInterval},
              {l:'차트 유형',v:CHART_TYPES.find(c=>c.id===chartType)?.label||chartType},
              {l:'인디케이터',v:activeIndicators.join(', ')||'없음'},
              {l:'드로잉 수',v:`${drawings.length}개`},
            ].map((r,i)=>(
              <div key={r.l} style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:`1px solid ${T.border}`}}>
                <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
                <span style={{color:T.txt,fontSize:11,fontWeight:600,maxWidth:'60%',textAlign:'right',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.v}</span>
              </div>
            ))}
          </Card>
        </div>
      )}

      {tab==='tools'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔧 차트 도구</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {[
                {icon:'🔬',label:'인디케이터',desc:'기술적 지표 추가',action:()=>openSheet('indicators')},
                {icon:'🔀',label:'비교',desc:'종목 오버레이',action:()=>openSheet('compare')},
                {icon:'🔔',label:'알림',desc:'가격/지표 알림',action:()=>openSheet('alerts')},
                {icon:'⏮',label:'바 리플레이',desc:'과거 재생',action:()=>openSheet('replay')},
                {icon:'📋',label:'템플릿',desc:'인디케이터 묶음',action:()=>openSheet('templates')},
                {icon:'📊',label:'차트 유형',desc:'캔들·선·영역…',action:()=>openSheet('charttype')},
                {icon:'🌳',label:'오브젝트 트리',desc:'드로잉 목록',action:()=>openSheet('objecttree')},
                {icon:'✏️',label:'드로잉 도구',desc:'추세선·피보…',action:()=>setTab('drawing')},
                {icon:'⏱',label:'인터벌',desc:'1m·5m·1h·1D…',action:()=>setTab('interval')},
              ].map(item=>(
                <button key={item.label} onClick={item.action} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:11,padding:'12px 8px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:24,marginBottom:5}}>{item.icon}</div>
                  <div style={{color:T.txt,fontSize:10,fontWeight:700,marginBottom:2}}>{item.label}</div>
                  <div style={{color:T.muted,fontSize:8,lineHeight:1.3}}>{item.desc}</div>
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab==='more'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>⋯ 더보기</div>
            {[
              {icon:'💡',label:'아이디어 작성',desc:'트레이딩 아이디어 공유',action:()=>openSheet('idea')},
              {icon:'🌲',label:'파인 에디터',desc:'Pine Script 작성/편집',action:()=>openSheet('pine')},
              {icon:'❓',label:'도움말',desc:'차트 도구 사용 가이드',action:()=>openSheet('help')},
              {icon:'🤖',label:'WUNDER 봇',desc:'Pine Script 자동매매',action:()=>setTab('wunder' as any)},
              {icon:'⛶',label:'전용 차트 열기',desc:'4분할·전체화면 지원',action:()=>{ if(typeof window!=='undefined') window.open('/chart','_blank'); }},
            ].map((item,i,arr)=>(
              <button key={item.label} onClick={item.action} style={{display:'flex',gap:12,alignItems:'center',padding:'11px 0',background:'transparent',border:'none',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none',cursor:'pointer',textAlign:'left',width:'100%'}}>
                <span style={{fontSize:22,flexShrink:0}}>{item.icon}</span>
                <div style={{flex:1}}>
                  <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{item.label}</div>
                  <div style={{color:T.muted,fontSize:10,marginTop:1}}>{item.desc}</div>
                </div>
                <span style={{color:T.muted,fontSize:16}}>›</span>
              </button>
            ))}
          </Card>
        </div>
      )}

{tab==='drawing'&&(
        <div>
          {/* Group tabs */}
          <div style={{display:'flex',gap:4,marginBottom:10,overflowX:'auto'}}>
            {DRAWING_GROUPS.map(g=>(
              <button key={g.id} onClick={()=>setDrawingGroup(g.id)} style={{flexShrink:0,padding:'5px 10px',background:drawingGroup===g.id?T.prp+'20':'transparent',color:drawingGroup===g.id?T.prp:T.muted,border:`1px solid ${drawingGroup===g.id?T.prp:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>{g.l}</button>
            ))}
          </div>

          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,marginBottom:12}}>
            {DRAWING_TOOLS.filter(d=>d.group===drawingGroup).map(d=>(
              <button key={d.id} onClick={()=>{ if(activeTool===d.id){ addDrawing(d.id); } else { setActiveTool(d.id); }}} style={{background:activeTool===d.id?T.prp+'20':T.card,border:`2px solid ${activeTool===d.id?T.prp:T.border}`,borderRadius:12,padding:'12px 6px',cursor:'pointer',textAlign:'center',position:'relative'}}>
                {activeTool===d.id&&<div style={{position:'absolute',top:3,right:3,width:6,height:6,borderRadius:'50%',background:T.prp}}/>}
                <div style={{fontSize:20,marginBottom:4}}>{d.icon}</div>
                <div style={{color:activeTool===d.id?T.prp:T.txt,fontSize:9,fontWeight:700,lineHeight:1.3}}>{d.label}</div>
              </button>
            ))}
          </div>

          <div style={{color:T.muted,fontSize:10,textAlign:'center',marginBottom:12}}>
            도구 선택 후 <strong style={{color:T.txt}}>한 번 더 클릭</strong>하면 현재 심볼에 드로잉이 추가됩니다
          </div>

          {/* Object tree */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{color:T.txt,fontWeight:700}}>📋 오브젝트 트리 ({drawings.length}개)</div>
              {drawings.length>0&&<button onClick={clearAllDrawings} style={{background:T.red+'15',color:T.red,border:'none',borderRadius:7,padding:'3px 8px',fontSize:9,cursor:'pointer'}}>전체삭제</button>}
            </div>
            {drawings.length===0?(
              <div style={{color:T.muted,fontSize:11,textAlign:'center',padding:'16px 0'}}>드로잉이 없습니다<br/><span style={{fontSize:10}}>위 도구로 추가하세요</span></div>
            ):(
              drawings.map(d=>(
                <div key={d.id} onClick={()=>setSelectedId(d.id===selectedId?null:d.id)} style={{display:'flex',alignItems:'center',gap:6,padding:'8px 0',borderBottom:`1px solid ${T.border}`,opacity:d.hidden?0.4:1,background:selectedId===d.id?T.acg:'transparent',cursor:'pointer',borderRadius:selectedId===d.id?6:0,paddingLeft:selectedId===d.id?4:0}}>
                  <div style={{width:10,height:10,borderRadius:2,background:d.style.color,flexShrink:0}}/>
                  <div style={{flex:1}}>
                    <div style={{color:T.txt,fontSize:11,fontWeight:selectedId===d.id?700:400}}>{d.name||d.toolLabel}</div>
                    <div style={{color:T.muted,fontSize:9}}>{d.symbol} · {d.timeframe} · {d.createdAt.split('T')[0]}</div>
                  </div>
                  <div style={{display:'flex',gap:3,flexShrink:0}}>
                    <button onClick={e=>{e.stopPropagation();toggleLock(d.id);}} style={{background:'transparent',border:'none',color:d.locked?T.ylw:T.muted,cursor:'pointer',fontSize:11}}>{d.locked?'🔒':'🔓'}</button>
                    <button onClick={e=>{e.stopPropagation();toggleVisible(d.id);}} style={{background:'transparent',border:'none',color:d.hidden?T.muted:T.sub,cursor:'pointer',fontSize:11}}>{d.hidden?'🙈':'👁'}</button>
                    <button onClick={e=>{e.stopPropagation();duplicateDrawing(d.id);}} style={{background:'transparent',border:'none',color:T.acl,cursor:'pointer',fontSize:11}}>⎘</button>
                    <button onClick={e=>{e.stopPropagation();deleteDrawing(d.id);}} style={{background:'transparent',border:'none',color:T.red,cursor:'pointer',fontSize:11}}>✕</button>
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      )}

      {/* ── INTERVAL ── */}
      {tab==='interval'&&(
        <div>
          <div style={{background:T.acg,border:`1px solid ${T.acl}30`,borderRadius:10,padding:'9px 13px',marginBottom:12}}>
            <div style={{color:T.acl,fontWeight:700,fontSize:12}}>현재: <span style={{fontFamily:'monospace'}}>{INTERVALS.find(i=>i.id===activeInterval)?.label||activeInterval}</span></div>
          </div>
          {INTERVAL_GROUPS.map(grp=>(
            <div key={grp.id} style={{marginBottom:14}}>
              <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>{grp.l}</div>
              <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                {INTERVALS.filter(i=>i.group===grp.id).map(iv=>(
                  <button key={iv.id} onClick={()=>setActiveInterval(iv.id)} style={{background:activeInterval===iv.id?T.acg:T.card,border:`2px solid ${activeInterval===iv.id?T.acl:T.border}`,borderRadius:9,padding:'7px 13px',cursor:'pointer',minWidth:48,textAlign:'center'}}>
                    <span style={{color:activeInterval===iv.id?T.acl:T.txt,fontSize:12,fontWeight:700,fontFamily:'monospace'}}>{iv.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div style={{display:'flex',gap:6}}>
            <input value={customInterval} onChange={e=>setCustomInterval(e.target.value)} placeholder="직접 입력 (예: 75)" style={{flex:1,background:T.card,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 12px',color:T.txt,fontSize:12,fontFamily:'monospace',outline:'none'}}/>
            <button onClick={()=>{if(customInterval.trim()){setActiveInterval(customInterval.trim());setCustomInterval('');}}} style={{background:T.acc,color:'#fff',border:'none',borderRadius:9,padding:'9px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>적용</button>
          </div>
        </div>
      )}

      {/* ── INDICATORS ── */}
      {tab==='indicators'&&(
        <div>
          <input value={indSearch} onChange={e=>setIndSearch(e.target.value)} placeholder="인디케이터 검색…" style={{width:'100%',background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 14px',color:T.txt,fontSize:12,outline:'none',marginBottom:8}}/>
          <div style={{display:'flex',gap:4,marginBottom:10,overflowX:'auto'}}>
            {IND_CATS.map(c=>(
              <button key={c} onClick={()=>setIndFilter(c)} style={{flexShrink:0,padding:'4px 10px',background:indFilter===c?T.acg:'transparent',color:indFilter===c?T.acl:T.muted,border:`1px solid ${indFilter===c?T.acl:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                {c==='all'?'전체':c==='trend'?'추세':c==='momentum'?'모멘텀':c==='volatility'?'변동성':'거래량'}
              </button>
            ))}
          </div>
          {filteredInds.map(ind=>{
            const active=activeIndicators.includes(ind.id);
            return (
              <div key={ind.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <div style={{width:32,height:32,borderRadius:8,background:active?T.acg:T.alt,border:`1px solid ${active?T.acl:T.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:900,color:active?T.acl:T.muted,fontFamily:'monospace'}}>{ind.id.slice(0,4)}</div>
                  <div>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{ind.label}</div>
                    <div style={{color:T.muted,fontSize:9}}>{ind.category==='trend'?'추세':ind.category==='momentum'?'모멘텀':ind.category==='volatility'?'변동성':'거래량'}</div>
                  </div>
                </div>
                <button onClick={()=>toggleIndicator(ind.id)} style={{background:active?T.red+'15':T.acg,color:active?T.red:T.acl,border:`1px solid ${active?T.red:T.acl}40`,borderRadius:9,padding:'5px 12px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {active?'제거':'추가'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── INFO ── */}
      {tab==='info'&&(
        <div>
          {[
            {icon:'📋',title:'종목 상세',desc:'심볼 정보, 거래소, 섹터',available:true},
            {icon:'💰',title:'재무제표',desc:'매출, EPS, PER (준비중)',available:false},
            {icon:'🔮',title:'애널리스트 예측',desc:'목표가, 추천 (준비중)',available:false},
            {icon:'📊',title:'기술적 분석 요약',desc:'매수/매도/중립 종합',available:true},
            {icon:'🌲',title:'파인 에디터',desc:'Pine Script → TradingView 열기',available:true},
            {icon:'❓',title:'도움말',desc:'차트 도구 사용 가이드',available:true},
          ].map((item,i)=>(
            <div key={item.title} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'11px 0',borderBottom:`1px solid ${T.border}`}}>
              <div style={{display:'flex',gap:10,alignItems:'center'}}>
                <span style={{fontSize:20}}>{item.icon}</span>
                <div>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{item.title}</div>
                  <div style={{color:T.muted,fontSize:10}}>{item.desc}</div>
                </div>
              </div>
              <button style={{background:item.available?T.acg:T.alt,color:item.available?T.acl:T.muted,border:`1px solid ${item.available?T.acl:T.border}`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:item.available?'pointer':'default'}}>
                {item.available?'보기':'준비중'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── PAPER ── */}
      {tab==='paper'&&(
        <div>
          <div style={{background:'linear-gradient(135deg,#060B14,#0A0F1E)',border:`1px solid ${T.prp}40`,borderRadius:18,padding:'16px',marginBottom:12}}>
            <div style={{color:T.muted,fontSize:11,marginBottom:2}}>모의매매 계좌</div>
            <div style={{color:T.txt,fontSize:26,fontWeight:900,fontFamily:'monospace'}}>{cvt(paperSize,'KRW')}</div>
            <div style={{display:'flex',gap:12,marginTop:6}}>
              <div><div style={{color:T.muted,fontSize:9}}>실현손익</div><div style={{color:T.grn,fontWeight:700,fontSize:12}}>+{cvt(paperPnl,'KRW')}</div></div>
              <div><div style={{color:T.muted,fontSize:9}}>수익률</div><div style={{color:T.grn,fontWeight:700,fontSize:12}}>+{(paperPnl/paperSize*100).toFixed(2)}%</div></div>
              <div><div style={{color:T.muted,fontSize:9}}>거래</div><div style={{color:T.acl,fontWeight:700,fontSize:12}}>{paperTrades}건</div></div>
            </div>
          </div>
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🎮 모의 주문</div>
            <div style={{display:'flex',gap:6,marginBottom:10}}>
              {['매수','매도'].map(s=>(
                <button key={s} style={{flex:1,padding:'10px',background:s==='매수'?T.grn+'15':T.red+'15',color:s==='매수'?T.grn:T.red,border:`1px solid ${s==='매수'?T.grn:T.red}40`,borderRadius:10,fontWeight:700,fontSize:13,cursor:'pointer'}}>{s}</button>
              ))}
            </div>
            {[{l:'심볼',v:symbol.split(':')[1]||symbol},{l:'차트 유형',v:CHART_TYPES.find(c=>c.id===chartType)?.label||chartType},{l:'인터벌',v:INTERVALS.find(i=>i.id===activeInterval)?.label||activeInterval},{l:'드로잉',v:`${drawings.length}개`}].map((r,i)=>(
              <div key={r.l} style={{display:'flex',justifyContent:'space-between',padding:'6px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
                <span style={{color:T.txt,fontSize:11,fontWeight:600}}>{r.v}</span>
              </div>
            ))}
            <button style={{width:'100%',padding:'11px',background:'linear-gradient(135deg,#2563EB,#7C3AED)',color:'#fff',border:'none',borderRadius:11,fontWeight:800,fontSize:13,cursor:'pointer',marginTop:10}}>🎮 모의 주문</button>
            <div style={{color:T.muted,fontSize:9,textAlign:'center',marginTop:5}}>모의매매 전용 · 실제 자금 없음 · 수익 보장 없음</div>
          </Card>
        </div>
      )}

      {/* ══ BOTTOM SHEETS ══ */}
      {showSheet&&sheetContent==='drawing'&&(
        <BottomSheet title="✏️ 드로잉 도구 선택">
          <div style={{display:'flex',gap:4,marginBottom:10,overflowX:'auto'}}>
            {DRAWING_GROUPS.map(g=>(
              <button key={g.id} onClick={()=>setDrawingGroup(g.id)} style={{flexShrink:0,padding:'4px 9px',background:drawingGroup===g.id?T.prp+'20':'transparent',color:drawingGroup===g.id?T.prp:T.muted,border:`1px solid ${drawingGroup===g.id?T.prp:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>{g.l}</button>
            ))}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:6}}>
            {DRAWING_TOOLS.filter(d=>d.group===drawingGroup).map(d=>(
              <button key={d.id} onClick={()=>{setActiveTool(d.id);setShowSheet(false);setTab('drawing');}} style={{background:activeTool===d.id?T.prp+'20':T.card,border:`2px solid ${activeTool===d.id?T.prp:T.border}`,borderRadius:10,padding:'10px 4px',cursor:'pointer',textAlign:'center'}}>
                <div style={{fontSize:20,marginBottom:3}}>{d.icon}</div>
                <div style={{color:activeTool===d.id?T.prp:T.muted,fontSize:8,fontWeight:700,lineHeight:1.2}}>{d.label.slice(0,6)}</div>
              </button>
            ))}
          </div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='interval'&&(
        <BottomSheet title="⏱ 인터벌 선택">
          {INTERVAL_GROUPS.map(grp=>(
            <div key={grp.id} style={{marginBottom:12}}>
              <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>{grp.l}</div>
              <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                {INTERVALS.filter(i=>i.group===grp.id).map(iv=>(
                  <button key={iv.id} onClick={()=>{setActiveInterval(iv.id);setShowSheet(false);}} style={{background:activeInterval===iv.id?T.acg:T.card,border:`2px solid ${activeInterval===iv.id?T.acl:T.border}`,borderRadius:9,padding:'7px 12px',cursor:'pointer'}}>
                    <span style={{color:activeInterval===iv.id?T.acl:T.txt,fontSize:12,fontWeight:700,fontFamily:'monospace'}}>{iv.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='charttype'&&(
        <BottomSheet title="📊 차트 유형 선택">
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
            {CHART_TYPES.map(ct=>(
              <button key={ct.id} onClick={()=>{setChartType(ct.id);setShowSheet(false);}} style={{background:chartType===ct.id?T.acg:T.card,border:`2px solid ${chartType===ct.id?T.acl:T.border}`,borderRadius:12,padding:'12px 6px',cursor:'pointer',textAlign:'center'}}>
                <div style={{fontSize:22,marginBottom:4}}>{ct.icon}</div>
                <div style={{color:chartType===ct.id?T.acl:T.txt,fontSize:9,fontWeight:700,lineHeight:1.2}}>{ct.label}</div>
                {CHART_TYPE_DESC[ct.id]&&<div style={{color:T.muted,fontSize:7,marginTop:2,lineHeight:1.3}}>{CHART_TYPE_DESC[ct.id].slice(0,12)}</div>}
              </button>
            ))}
          </div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='objecttree'&&(
        <BottomSheet title={`📋 오브젝트 트리 (${drawings.length}개)`}>
          {drawings.length===0?(
            <div style={{textAlign:'center',padding:'24px 0',color:T.muted,fontSize:12}}>드로잉이 없습니다</div>
          ):(
            <>
              <div style={{display:'flex',gap:6,marginBottom:10}}>
                <button onClick={clearAllDrawings} style={{flex:1,padding:'8px',background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:9,fontSize:11,fontWeight:700,cursor:'pointer'}}>전체 삭제</button>
                <button onClick={()=>setDrawings(d=>d.map(x=>({...x,visible:true,hidden:false})))} style={{flex:1,padding:'8px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}30`,borderRadius:9,fontSize:11,fontWeight:700,cursor:'pointer'}}>모두 표시</button>
              </div>
              {drawings.map(d=>(
                <div key={d.id} style={{display:'flex',alignItems:'center',gap:8,padding:'10px 0',borderBottom:`1px solid ${T.border}`,opacity:d.hidden?0.4:1}}>
                  <div style={{width:12,height:12,borderRadius:3,background:d.style.color,flexShrink:0}}/>
                  <div style={{flex:1}}>
                    <input value={d.name||d.toolLabel} onChange={e=>renameDrawing(d.id,e.target.value)} style={{background:'transparent',border:'none',color:T.txt,fontSize:12,fontWeight:600,width:'100%',outline:'none',cursor:'text'}}/>
                    <div style={{color:T.muted,fontSize:9}}>{d.symbol} · {d.timeframe} · {d.toolLabel}</div>
                  </div>
                  <div style={{display:'flex',gap:5,flexShrink:0}}>
                    <button onClick={()=>toggleLock(d.id)} style={{background:'transparent',border:'none',color:d.locked?T.ylw:T.muted,cursor:'pointer',fontSize:12}}>{d.locked?'🔒':'🔓'}</button>
                    <button onClick={()=>toggleVisible(d.id)} style={{background:'transparent',border:'none',color:d.hidden?T.muted:T.sub,cursor:'pointer',fontSize:12}}>{d.hidden?'🙈':'👁'}</button>
                    <button onClick={()=>duplicateDrawing(d.id)} style={{background:'transparent',border:'none',color:T.acl,cursor:'pointer',fontSize:12}}>⎘</button>
                    <button onClick={()=>deleteDrawing(d.id)} style={{background:'transparent',border:'none',color:T.red,cursor:'pointer',fontSize:12}}>✕</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='style'&&selectedDrawing&&(
        <BottomSheet title="🎨 스타일 편집">
          <div style={{display:'flex',gap:6,marginBottom:14,alignItems:'center'}}>
            <div style={{width:24,height:24,borderRadius:6,background:selectedDrawing.style.color,flexShrink:0}}/>
            <span style={{color:T.txt,fontSize:13,fontWeight:700}}>{selectedDrawing.name||selectedDrawing.toolLabel}</span>
          </div>
          {/* Color presets */}
          <div style={{marginBottom:12}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>색상</div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {['#3B82F6','#10B981','#EF4444','#F59E0B','#7C3AED','#0891B2','#EC4899','#F97316','#14B8A6','#94A3B8','#FFFFFF','#000000'].map(clr=>(
                <button key={clr} onClick={()=>updateDrawingStyle(selectedDrawing.id,{color:clr})} style={{width:28,height:28,borderRadius:6,background:clr,border:`3px solid ${selectedDrawing.style.color===clr?'#fff':'transparent'}`,cursor:'pointer'}}/>
              ))}
            </div>
          </div>
          {/* Width */}
          <div style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>선 두께</span>
              <span style={{color:T.acl,fontSize:10,fontWeight:700}}>{selectedDrawing.style.width}px</span>
            </div>
            <input type="range" min={1} max={8} step={1} value={selectedDrawing.style.width} onChange={e=>updateDrawingStyle(selectedDrawing.id,{width:+e.target.value})} style={{width:'100%',accentColor:T.acl}}/>
          </div>
          {/* Opacity */}
          <div style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>불투명도</span>
              <span style={{color:T.acl,fontSize:10,fontWeight:700}}>{Math.round((selectedDrawing.style.opacity||1)*100)}%</span>
            </div>
            <input type="range" min={10} max={100} step={5} value={Math.round((selectedDrawing.style.opacity||1)*100)} onChange={e=>updateDrawingStyle(selectedDrawing.id,{opacity:+e.target.value/100})} style={{width:'100%',accentColor:T.acl}}/>
          </div>
          {/* Line style */}
          <div style={{marginBottom:12}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>선 스타일</div>
            <div style={{display:'flex',gap:6}}>
              {(['solid','dashed','dotted'] as const).map(ds=>(
                <button key={ds} onClick={()=>updateDrawingStyle(selectedDrawing.id,{dash:ds})} style={{flex:1,padding:'8px',background:selectedDrawing.style.dash===ds?T.acg:T.alt,color:selectedDrawing.style.dash===ds?T.acl:T.muted,border:`1px solid ${selectedDrawing.style.dash===ds?T.acl:T.border}`,borderRadius:8,fontSize:11,fontWeight:700,cursor:'pointer'}}>
                  {ds==='solid'?'━━━':ds==='dashed'?'┅┅┅':'···'}
                </button>
              ))}
            </div>
          </div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={()=>toggleLock(selectedDrawing.id)} style={{flex:1,padding:'10px',background:selectedDrawing.locked?T.ylw+'15':T.alt,color:selectedDrawing.locked?T.ylw:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer'}}>
              {selectedDrawing.locked?'🔒 잠금됨':'🔓 잠금'}
            </button>
            <button onClick={()=>deleteDrawing(selectedDrawing.id)} style={{flex:1,padding:'10px',background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer'}}>🗑 삭제</button>
          </div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='risk'&&(
        <BottomSheet title={`📊 위험 도구 — ${activeTool==='long_pos'?'롱':'숏'} 포지션`}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
            {[{l:'진입가',key:'entry',val:riskEntry,set:setRiskEntry},{l:'손절가',key:'sl',val:riskSL,set:setRiskSL},{l:'목표가',key:'tp',val:riskTP,set:setRiskTP},{l:'투자금',key:'size',val:riskSize,set:setRiskSize}].map(f=>(
              <div key={f.key}>
                <div style={{color:T.muted,fontSize:10,marginBottom:3}}>{f.l}</div>
                <input type="number" value={f.val} onChange={e=>f.set(+e.target.value)} style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:11,fontFamily:'monospace',outline:'none'}}/>
              </div>
            ))}
          </div>
          <div style={{marginBottom:12}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>레버리지: {riskLeverage}x</div>
            <input type="range" min={1} max={20} step={1} value={riskLeverage} onChange={e=>setRiskLeverage(+e.target.value)} style={{width:'100%',accentColor:T.acl}}/>
          </div>
          <Card style={{padding:'12px 14px',marginBottom:10,border:`1px solid ${T.grn}30`}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              {[
                {l:'리스크/리워드',v:`1 : ${riskReward.toFixed(2)}`,c:riskReward>=2?T.grn:riskReward>=1?T.ylw:T.red},
                {l:'예상 수익',v:'+'+cvt(Math.round(expectedProfit),'KRW'),c:T.grn},
                {l:'예상 손실',v:'-'+cvt(Math.round(expectedLoss),'KRW'),c:T.red},
                {l:'청산가 (추정)',v:cvt(Math.round(liqPrice),'KRW'),c:T.red},
              ].map(r=>(
                <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'8px 9px'}}>
                  <div style={{color:T.muted,fontSize:9,marginBottom:2}}>{r.l}</div>
                  <div style={{color:r.c,fontSize:11,fontWeight:700,fontFamily:'monospace'}}>{r.v}</div>
                </div>
              ))}
            </div>
          </Card>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:8,padding:'8px 12px',marginBottom:10}}>
            <div style={{color:T.ylw,fontSize:10,fontWeight:700}}>⚠️ 교육 목적 계산 · 실제 거래에 사용하지 마세요</div>
          </div>
          <button onClick={()=>addDrawing(activeTool,riskEntry,riskTP)} style={{width:'100%',padding:'12px',background:`linear-gradient(135deg,${activeTool==='long_pos'?T.grn:T.red},${activeTool==='long_pos'?T.acl:T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer'}}>
            {activeTool==='long_pos'?'📈 롱 포지션 추가':'📉 숏 포지션 추가'}
          </button>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='fib'&&(
        <BottomSheet title="🌀 피보나치 설정">
          <div style={{display:'flex',gap:8,marginBottom:12}}>
            <button onClick={()=>setFibShowLabels(v=>!v)} style={{flex:1,padding:'9px',background:fibShowLabels?T.acg:T.alt,color:fibShowLabels?T.acl:T.muted,border:`1px solid ${fibShowLabels?T.acl:T.border}`,borderRadius:9,fontSize:11,fontWeight:700,cursor:'pointer'}}>
              {fibShowLabels?'레이블 ON':'레이블 OFF'}
            </button>
            <button onClick={()=>setFibReverse(v=>!v)} style={{flex:1,padding:'9px',background:fibReverse?T.prp+'20':T.alt,color:fibReverse?T.prp:T.muted,border:`1px solid ${fibReverse?T.prp:T.border}`,borderRadius:9,fontSize:11,fontWeight:700,cursor:'pointer'}}>
              {fibReverse?'역방향 ON':'역방향 OFF'}
            </button>
          </div>
          <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:8}}>레벨 편집</div>
          {fibLevels.map((fib,i)=>(
            <div key={i} style={{display:'flex',gap:8,alignItems:'center',marginBottom:6}}>
              <input type="number" step={0.001} value={fib.level} onChange={e=>setFibLevels(prev=>prev.map((f,j)=>j===i?{...f,level:+e.target.value}:f))} style={{width:70,background:T.bg,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 8px',color:T.txt,fontSize:11,fontFamily:'monospace',outline:'none'}}/>
              <input value={fib.label} onChange={e=>setFibLevels(prev=>prev.map((f,j)=>j===i?{...f,label:e.target.value}:f))} style={{flex:1,background:T.bg,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 8px',color:T.txt,fontSize:11,outline:'none'}}/>
              <div style={{width:24,height:24,borderRadius:5,background:fib.color,flexShrink:0,cursor:'pointer'}}/>
            </div>
          ))}
          <button onClick={()=>setFibLevels(DEFAULT_FIB_LEVELS)} style={{width:'100%',marginTop:8,padding:'9px',background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:9,fontSize:11,cursor:'pointer'}}>기본값 복원</button>
        </BottomSheet>
      )}
    </div>
  );


      {/* ── TOOLS BOTTOM SHEETS ── */}
      {showSheet&&sheetContent==='indicators'&&(
        <BottomSheet title="🔬 인디케이터">
          <input value={indSearch} onChange={e=>setIndSearch(e.target.value)} placeholder="인디케이터 검색…" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 12px',color:T.txt,fontSize:16,outline:'none',marginBottom:8}}/>
          <div style={{display:'flex',gap:4,marginBottom:10,overflowX:'auto'}}>
            {['all','trend','momentum','volatility','volume'].map(c=>(
              <button key={c} onClick={()=>setIndFilter(c)} style={{flexShrink:0,padding:'4px 9px',background:indFilter===c?T.acg:'transparent',color:indFilter===c?T.acl:T.muted,border:`1px solid ${indFilter===c?T.acl:T.border}`,borderRadius:20,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                {c==='all'?'전체':c==='trend'?'추세':c==='momentum'?'모멘텀':c==='volatility'?'변동성':'거래량'}
              </button>
            ))}
          </div>
          {INDICATORS_LIST.filter(i=>(indFilter==='all'||i.category===indFilter)&&(indSearch===''||i.label.includes(indSearch)||i.id.toLowerCase().includes(indSearch.toLowerCase()))).map(ind=>{
            const active=activeIndicators.includes(ind.id);
            return (
              <div key={ind.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <div style={{width:32,height:32,borderRadius:8,background:active?T.acg:T.alt,border:`1px solid ${active?T.acl:T.border}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:900,color:active?T.acl:T.muted,fontFamily:'monospace'}}>{ind.id.slice(0,4)}</div>
                  <div>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{ind.label}</div>
                    <div style={{color:T.muted,fontSize:9}}>{ind.category}</div>
                  </div>
                </div>
                <button onClick={()=>{activeIndicators.includes(ind.id)?setActiveIndicators(p=>p.filter(x=>x!==ind.id)):setActiveIndicators(p=>[...p,ind.id]);}} style={{background:active?T.red+'15':T.acg,color:active?T.red:T.acl,border:`1px solid ${active?T.red:T.acl}40`,borderRadius:9,padding:'5px 12px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {active?'제거':'추가'}
                </button>
              </div>
            );
          })}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='compare'&&(
        <BottomSheet title="🔀 비교 차트">
          <div style={{color:T.muted,fontSize:11,marginBottom:10}}>다른 종목을 오버레이하여 상관관계를 분석합니다.</div>
          {['NASDAQ:NDX','OANDA:XAUUSD','TVC:DXY','SP:SPX','BINANCE:ETHUSDT'].map(s=>(
            <div key={s} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
              <span style={{color:T.txt,fontSize:12,fontFamily:'monospace'}}>{s}</span>
              <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>+ 추가</button>
            </div>
          ))}
          <div style={{marginTop:10,color:T.muted,fontSize:9}}>* TradingView 차트에서 비교 기능이 활성화됩니다</div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='alerts'&&(
        <BottomSheet title="🔔 알림 설정">
          <div style={{background:T.acg,border:`1px solid ${T.acl}30`,borderRadius:10,padding:'10px 12px',marginBottom:12}}>
            <div style={{color:T.acl,fontWeight:700,fontSize:11}}>현재 심볼: {symbol}</div>
          </div>
          {[{l:'가격 도달',d:'특정 가격 도달 시 알림'},{l:'% 변동',d:'일정 % 이상 변동 시 알림'},{l:'거래량 급증',d:'평균 대비 거래량 급증 시'},{l:'지표 조건',d:'RSI 과매수/과매도 등'}].map((a,i)=>(
            <div key={a.l} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:`1px solid ${T.border}`}}>
              <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{a.l}</div><div style={{color:T.muted,fontSize:9,marginTop:1}}>{a.d}</div></div>
              <button style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'4px 10px',fontSize:10,cursor:'pointer'}}>준비중</button>
            </div>
          ))}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='replay'&&(
        <BottomSheet title="⏮ 바 리플레이">
          <div style={{textAlign:'center',padding:'20px 0'}}>
            <div style={{fontSize:40,marginBottom:10}}>⏮</div>
            <div style={{color:T.txt,fontWeight:700,fontSize:14,marginBottom:6}}>바 리플레이</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6,marginBottom:14}}>과거 특정 시점부터 차트를 재생합니다. TradingView 위젯에서 직접 실행하세요.</div>
            <a href="/chart" target="_blank" style={{display:'inline-block',padding:'10px 20px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,fontSize:12,fontWeight:700,textDecoration:'none'}}>전용 차트에서 열기 ↗</a>
          </div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='templates'&&(
        <BottomSheet title="📋 인디케이터 템플릿">
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {[{n:'트렌드 팩',inds:['EMA','SMA','ADX'],desc:'추세 추종용'},
              {n:'RSI 전략',inds:['RSI','MACD','BOLL'],desc:'모멘텀 분석'},
              {n:'거래량 분석',inds:['VOL','OBV','VWAP','MFI'],desc:'유동성 확인'},
              {n:'BTC WUNDER',inds:['EMA','RSI','ADX','ATR'],desc:'WUNDER 봇 전략'},
            ].map(t=>(
              <div key={t.n} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'11px 13px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{t.n}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:1}}>{t.inds.join(' · ')} · {t.desc}</div>
                </div>
                <button onClick={()=>setActiveIndicators(t.inds)} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'5px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>적용</button>
              </div>
            ))}
          </div>
        </BottomSheet>
      )}

      {/* ── INFO BOTTOM SHEETS ── */}
      {showSheet&&sheetContent==='symbol_info'&&(
        <BottomSheet title="📋 심볼 정보">
          <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:14}}>
            <div style={{width:44,height:44,borderRadius:12,background:T.acg,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>₿</div>
            <div>
              <div style={{color:T.txt,fontWeight:800,fontSize:15}}>{symbol.split(':')[1]||symbol}</div>
              <div style={{color:T.muted,fontSize:11}}>{symbol}</div>
            </div>
          </div>
          {[
            {l:'거래소',v:symbol.split(':')[0]||'BINANCE'},
            {l:'자산 유형',v:symbol.includes('BINANCE')?'암호화폐':symbol.includes('KRX')?'한국주식':symbol.includes('NYSE')||symbol.includes('NASDAQ')?'미국주식':'기타'},
            {l:'인터벌',v:INTERVALS.find(i=>i.id===activeInterval)?.label||activeInterval},
            {l:'차트 유형',v:CHART_TYPES.find(c=>c.id===chartType)?.label||chartType},
            {l:'활성 인디케이터',v:activeIndicators.join(', ')||'없음'},
            {l:'드로잉 수',v:`${drawings.length}개`},
          ].map((r,i)=>(
            <div key={r.l} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
              <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
              <span style={{color:T.txt,fontSize:11,fontWeight:600,textAlign:'right',maxWidth:'60%'}}>{r.v}</span>
            </div>
          ))}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='financials'&&(
        <BottomSheet title="💰 재무제표">
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}25`,borderRadius:10,padding:'10px 12px',marginBottom:12}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>📡 재무 데이터 준비중</div>
            <div style={{color:T.muted,fontSize:10,marginTop:3}}>Finnhub / FMP API 연동 예정</div>
          </div>
          {[{l:'매출 (TTM)',v:'준비중'},{l:'영업이익률',v:'준비중'},{l:'EPS',v:'준비중'},{l:'PER',v:'준비중'},{l:'PBR',v:'준비중'},{l:'시가총액',v:'준비중'}].map((r,i)=>(
            <div key={r.l} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
              <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
              <span style={{color:T.muted,fontSize:11}}>{r.v}</span>
            </div>
          ))}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='forecasts'&&(
        <BottomSheet title="🔮 애널리스트 예측">
          <div style={{background:T.acl+'12',border:`1px solid ${T.acl}25`,borderRadius:10,padding:'10px 12px',marginBottom:12}}>
            <div style={{color:T.acl,fontWeight:700,fontSize:11}}>📡 예측 데이터 준비중</div>
            <div style={{color:T.muted,fontSize:10,marginTop:3}}>TipRanks / Wall Street Horizon API 연동 예정</div>
          </div>
          {[{l:'컨센서스',v:'준비중',c:T.muted},{l:'목표주가',v:'준비중',c:T.muted},{l:'매수 추천',v:'준비중',c:T.grn},{l:'중립',v:'준비중',c:T.ylw},{l:'매도 추천',v:'준비중',c:T.red}].map((r,i)=>(
            <div key={r.l} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
              <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
              <span style={{color:r.c,fontSize:11,fontWeight:600}}>{r.v}</span>
            </div>
          ))}
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='technicals'&&(
        <BottomSheet title="📊 기술적 분석">
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:14}}>
            {[{l:'이동평균',v:'매수',c:T.grn},{l:'오실레이터',v:'중립',c:T.ylw},{l:'종합',v:'강한매수',c:T.grn}].map(s=>(
              <div key={s.l} style={{background:`${s.c}12`,border:`1px solid ${s.c}30`,borderRadius:10,padding:'10px 8px',textAlign:'center'}}>
                <div style={{color:s.c,fontWeight:800,fontSize:12,marginBottom:2}}>{s.v}</div>
                <div style={{color:T.muted,fontSize:9}}>{s.l}</div>
              </div>
            ))}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
            {[{l:'RSI(14)',v:'52.4 — 중립'},{l:'MACD',v:'골든크로스'},{l:'볼린저',v:'중간밴드 위'},{l:'ADX',v:'28.1 — 추세'},{l:'스토캐스틱',v:'46 — 중립'},{l:'CCI',v:'42 — 매수'}].map(r=>(
              <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'7px 9px'}}>
                <div style={{color:T.muted,fontSize:9}}>{r.l}</div>
                <div style={{color:T.txt,fontSize:10,fontWeight:700,marginTop:1}}>{r.v}</div>
              </div>
            ))}
          </div>
          <div style={{marginTop:10,color:T.muted,fontSize:9}}>⚠️ 기술적 분석은 참고용이며 투자 조언이 아닙니다.</div>
        </BottomSheet>
      )}

      {/* ── MORE BOTTOM SHEETS ── */}
      {showSheet&&sheetContent==='idea'&&(
        <BottomSheet title="💡 아이디어 작성">
          <div style={{marginBottom:10}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:5}}>제목</div>
            <input placeholder="트레이딩 아이디어 제목…" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 12px',color:T.txt,fontSize:16,outline:'none'}}/>
          </div>
          <div style={{marginBottom:10}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:5}}>방향</div>
            <div style={{display:'flex',gap:6}}>
              {['📈 롱','📉 숏','↔️ 중립'].map(d=>(
                <button key={d} style={{flex:1,padding:'8px',background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,fontSize:11,fontWeight:700,cursor:'pointer'}}>{d}</button>
              ))}
            </div>
          </div>
          <div style={{marginBottom:12}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:5}}>내용</div>
            <textarea placeholder="분석 내용을 작성하세요…" rows={4} style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:9,padding:'9px 12px',color:T.txt,fontSize:14,outline:'none',resize:'none',fontFamily:'inherit'}}/>
          </div>
          <button style={{width:'100%',padding:'12px',background:'linear-gradient(135deg,#2563EB,#7C3AED)',color:'#fff',border:'none',borderRadius:11,fontWeight:800,fontSize:13,cursor:'pointer'}}>아이디어 게시 (준비중)</button>
          <div style={{color:T.muted,fontSize:9,textAlign:'center',marginTop:6}}>커뮤니티 아이디어 공유 기능 준비 중</div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='pine'&&(
        <BottomSheet title="🌲 파인 에디터">
          <div style={{background:'#030610',borderRadius:10,padding:'12px',marginBottom:10,fontFamily:'monospace',fontSize:11,color:'#50FA7B',lineHeight:1.7}}>
            <div style={{color:'#8BE9FD'}}>//@version=5</div>
            <div style={{color:'#FF79C6'}}>indicator<span style={{color:'#F8F8F2'}}>(<span style={{color:'#F1FA8C'}}>"My Script"</span>, overlay=<span style={{color:'#BD93F9'}}>true</span>)</span></div>
            <div style={{color:'#F8F8F2',marginTop:4}}>plot(close, <span style={{color:'#F1FA8C'}}>"Close"</span>, color=color.blue)</div>
          </div>
          <div style={{color:T.muted,fontSize:11,lineHeight:1.5,marginBottom:12}}>
            Pine Script를 작성하고 TradingView에서 적용하세요.<br/>
            WUNDER 자동매매 전략도 Pine Script로 작성됩니다.
          </div>
          <div style={{display:'flex',gap:6}}>
            <a href="/chart" target="_blank" style={{flex:1,display:'block',padding:'10px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,fontSize:11,fontWeight:700,textDecoration:'none',textAlign:'center'}}>TradingView에서 열기 ↗</a>
            <button onClick={()=>setTab('wunder' as any)} style={{flex:1,padding:'10px',background:T.prp+'15',color:T.prp,border:`1px solid ${T.prp}30`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>WUNDER 봇 Pine Script</button>
          </div>
        </BottomSheet>
      )}

      {showSheet&&sheetContent==='help'&&(
        <BottomSheet title="❓ 도움말">
          {[
            {icon:'📈',t:'차트 기본 조작',d:'핀치 줌 · 스크롤 · 클릭으로 심볼 변경'},
            {icon:'✏️',t:'드로잉 도구 사용법',d:'도구 탭에서 선택 → 한 번 더 클릭으로 추가'},
            {icon:'⏱',t:'인터벌 변경',d:'상단 인터벌 버튼 탭 또는 인터벌 탭 이동'},
            {icon:'💾',t:'레이아웃 저장',d:'레이아웃 탭 → + 저장 → 이름 입력'},
            {icon:'🔗',t:'TradingView 연동',d:'웹훅 탭에서 TradingView Alert 설정'},
            {icon:'🤖',t:'자동매매 봇',d:'WUNDER봇 탭에서 Pine Script 설정'},
          ].map((h,i)=>(
            <div key={h.t} style={{display:'flex',gap:10,padding:'10px 0',borderBottom:`1px solid ${T.border}`}}>
              <span style={{fontSize:20,flexShrink:0}}>{h.icon}</span>
              <div>
                <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{h.t}</div>
                <div style={{color:T.muted,fontSize:10,marginTop:2,lineHeight:1.4}}>{h.d}</div>
              </div>
            </div>
          ))}
          <div style={{marginTop:10,color:T.muted,fontSize:9,textAlign:'center'}}>TRAIGO v8 · 모의투자 전용</div>
        </BottomSheet>
      )}

}


/* ── Navigation tabs ── */
const BTABS=[
  {id:'home',label:'홈',icon:'🏠'},{id:'watchlist',label:'왓치',icon:'⭐'},
  {id:'market',label:'시장',icon:'📊'},{id:'trading',label:'매매',icon:'⚡'},
  {id:'auto',label:'자동',icon:'🤖'},{id:'season',label:'시즌전략',icon:'🌱'},
];
const MTABS=[
  {id:'portfolio',label:'포트폴리오',icon:'💼'},{id:'history',label:'매매일지',icon:'📝'},
  {id:'backtest',label:'백테스트',icon:'🧪'},{id:'ai',label:'AI채팅',icon:'💬'},
  {id:'academy',label:'아카데미',icon:'📚'},{id:'news',label:'뉴스',icon:'📰'},
  {id:'alerts',label:'알림',icon:'🔔'},{id:'social',label:'소셜',icon:'👥'},
  {id:'accounts',label:'거래소연결',icon:'🔗'},{id:'funding',label:'입출금',icon:'💸'},{id:'pnl',label:'수익계산',icon:'💹'},
  {id:'analysis',label:'분석허브',icon:'🔬'},{id:'hedgeos',label:'Hedge OS',icon:'🏦'},{id:'intelligence',label:'인텔리전스',icon:'🧠'},{id:'chart',label:'차트',icon:'📈'},{id:'wunder',label:'WUNDER봇',icon:'🤖'},{id:'tradfi',label:'TradFi',icon:'📊'},{id:'realtime',label:'실시간',icon:'📡'},
  {id:'analytics',label:'분석',icon:'📈'},{id:'calendar',label:'경제캘린더',icon:'📅'},
  {id:'briefing',label:'AI브리핑',icon:'🤖'},{id:'tax',label:'손익·세금',icon:'💼'},
  {id:'growth',label:'성장',icon:'🏆'},{id:'heatmap',label:'히트맵',icon:'🌈'},
  {id:'scanner',label:'스캐너',icon:'🔍'},{id:'clock',label:'세계시장',icon:'🌐'},
  {id:'settings',label:'설정',icon:'⚙️'},
  {id:'subscription',label:'구독',icon:'💳'},
  {id:'posters',label:'강의',icon:'🎓'},{id:'safety',label:'안전제어',icon:'🛡️'},{id:'hub',label:'허브',icon:'🌐'},
];

// ══════════════════════════════════════════════════════════════
// ADMIN PAGE — only rendered when isAdminUser === true
// Role is verified server-side on every /api/admin call.
// To promote a user to admin, run in Supabase SQL:
//   UPDATE profiles SET role = 'admin' WHERE email = 'your@email.com';
// ══════════════════════════════════════════════════════════════
function AdminPage() {
  const [aTab,setATab]=useState<'health'|'users'|'strategies'|'exchanges'|'logs'|'control'>('health');
  const [health,setHealth]=useState<any>(null);
  const [users,setUsers]=useState<any[]>([]);
  const [strategies,setStrategies]=useState<any[]>([]);
  const [exchanges,setExchanges]=useState<any[]>([]);
  const [logs,setLogs]=useState<any[]>([]);
  const [loading,setLoading]=useState(false);
  const [msg,setMsg]=useState('');

  const authHeader = useCallback(async()=>{
    try{
      const {getSupabaseClient}=await import('@/lib/supabase/client');
      const sb=getSupabaseClient();
      if(!sb) return {};
      const {data:{session}}=await sb.auth.getSession();
      if(!session) return {};
      return {'Authorization':`Bearer ${session.access_token}`,'Content-Type':'application/json'};
    }catch{return {};}
  },[]);

  const load=useCallback(async(tab:string)=>{
    setLoading(true);
    try{
      const headers=await authHeader();
      if(tab==='health'){
        const r=await fetch('/api/admin?action=health',{headers});
        setHealth(await r.json());
      } else if(tab==='users'){
        const r=await fetch('/api/admin?action=users',{headers});
        const d=await r.json();
        setUsers(d.users||[]);
      } else if(tab==='strategies'){
        const r=await fetch('/api/admin?action=strategy_status',{headers});
        const d=await r.json();
        setStrategies(d.strategies||[]);
      } else if(tab==='exchanges'){
        const r=await fetch('/api/admin?action=exchange_status',{headers});
        const d=await r.json();
        setExchanges(d.connections||[]);
      } else if(tab==='logs'){
        const r=await fetch('/api/admin?action=audit_logs&limit=100',{headers});
        const d=await r.json();
        setLogs(d.logs||[]);
      }
    }catch(e){console.error(e);}
    setLoading(false);
  },[authHeader]);

  useEffect(()=>{load(aTab);},[aTab,load]);

  const doAction=useCallback(async(action:string,body:Record<string,unknown>={})=>{
    setMsg('');
    try{
      const headers=await authHeader();
      const r=await fetch('/api/admin',{method:'POST',headers,body:JSON.stringify({action,...body})});
      const d=await r.json();
      if(r.ok) setMsg(d.message||'완료');
      else setMsg(`오류: ${d.error}`);
    }catch(e){setMsg(String(e));}
  },[authHeader]);

  const TABS=[
    {id:'health',label:'API 헬스',icon:'💚'},
    {id:'users',label:'사용자',icon:'👥'},
    {id:'strategies',label:'전략 현황',icon:'🤖'},
    {id:'exchanges',label:'거래소',icon:'🔗'},
    {id:'logs',label:'감사 로그',icon:'📋'},
    {id:'control',label:'긴급 제어',icon:'⚡'},
  ] as const;

  return (
    <div style={{padding:'4px 0'}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
        <div style={{width:32,height:32,borderRadius:10,background:'rgba(16,185,129,0.15)',border:'1px solid rgba(16,185,129,0.4)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:16}}>🛡️</div>
        <div>
          <div style={{color:T.txt,fontWeight:800,fontSize:15}}>관리자 대시보드</div>
          <div style={{color:T.muted,fontSize:10}}>역할: admin · 서버사이드 검증됨</div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{display:'flex',gap:4,overflowX:'auto',marginBottom:12,paddingBottom:2}}>
        {TABS.map(tb=>(
          <button key={tb.id} onClick={()=>setATab(tb.id)} style={{flexShrink:0,padding:'6px 10px',background:aTab===tb.id?'rgba(16,185,129,0.15)':'transparent',border:`1px solid ${aTab===tb.id?'rgba(16,185,129,0.5)':T.border}`,borderRadius:10,color:aTab===tb.id?'#10B981':T.muted,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {tb.icon} {tb.label}
          </button>
        ))}
      </div>

      {loading&&<div style={{textAlign:'center',color:T.muted,fontSize:12,padding:'20px 0'}}>로딩 중…</div>}

      {/* Health */}
      {!loading&&aTab==='health'&&health&&(
        <div>
          <div style={{background:health.connected?'rgba(16,185,129,0.08)':'rgba(239,68,68,0.08)',border:`1px solid ${health.connected?'rgba(16,185,129,0.3)':'rgba(239,68,68,0.3)'}`,borderRadius:12,padding:'12px 14px',marginBottom:10}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
              <span style={{fontSize:16}}>{health.connected?'✅':'❌'}</span>
              <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{health.message}</span>
              {health.latencyMs!=null&&<span style={{color:T.muted,fontSize:10,marginLeft:'auto'}}>{health.latencyMs}ms</span>}
            </div>
            {health.env&&Object.entries(health.env).map(([k,v])=>(
              <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'3px 0',borderTop:`1px solid ${T.border}`}}>
                <span style={{color:T.muted,fontSize:10,fontFamily:'monospace'}}>{k}</span>
                <span style={{color:v?'#10B981':'#EF4444',fontSize:10,fontWeight:700}}>{v?'✓ 설정됨':'✗ 없음'}</span>
              </div>
            ))}
          </div>
          <button onClick={()=>load('health')} style={{width:'100%',padding:'8px',background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,color:T.acl,fontSize:11,fontWeight:700,cursor:'pointer'}}>🔄 새로고침</button>
        </div>
      )}

      {/* Users */}
      {!loading&&aTab==='users'&&(
        <div>
          <div style={{color:T.muted,fontSize:10,marginBottom:8}}>총 {users.length}명</div>
          {users.map((u:any)=>(
            <div key={u.id} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 12px',marginBottom:6}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{u.display_name||u.email}</div>
                  <div style={{color:T.muted,fontSize:10}}>{u.email}</div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:u.role==='admin'?'#10B981':T.acl,fontSize:10,fontWeight:700}}>{u.role}</div>
                  <div style={{color:u.status==='banned'?'#EF4444':T.muted,fontSize:10}}>{u.status}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Strategies */}
      {!loading&&aTab==='strategies'&&(
        <div>
          <div style={{color:T.muted,fontSize:10,marginBottom:8}}>전략 {strategies.length}개</div>
          {strategies.map((s:any)=>(
            <div key={s.id} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'9px 12px',marginBottom:6}}>
              <div style={{display:'flex',justifyContent:'space-between'}}>
                <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{s.name}</div>
                <div style={{color:s.enabled?'#10B981':'#EF4444',fontSize:10,fontWeight:700}}>{s.status}</div>
              </div>
              <div style={{color:T.muted,fontSize:10}}>{s.asset} · {s.exec_mode}</div>
            </div>
          ))}
        </div>
      )}

      {/* Exchanges */}
      {!loading&&aTab==='exchanges'&&(
        <div>
          <div style={{color:T.muted,fontSize:10,marginBottom:8}}>연결 {exchanges.length}개</div>
          {exchanges.map((c:any)=>(
            <div key={c.id} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'9px 12px',marginBottom:6}}>
              <div style={{display:'flex',justifyContent:'space-between'}}>
                <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{c.label||c.exchange_id}</div>
                <div style={{color:c.is_active?'#10B981':'#EF4444',fontSize:10,fontWeight:700}}>{c.is_active?'활성':'비활성'}</div>
              </div>
              <div style={{color:T.muted,fontSize:10}}>{c.test_status||'미테스트'} · {c.last_tested_at?.slice(0,10)||'-'}</div>
            </div>
          ))}
        </div>
      )}

      {/* Audit Logs */}
      {!loading&&aTab==='logs'&&(
        <div>
          <div style={{color:T.muted,fontSize:10,marginBottom:8}}>최근 {logs.length}건</div>
          {logs.map((l:any)=>(
            <div key={l.id} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'8px 12px',marginBottom:5}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{color:T.acl,fontSize:11,fontWeight:700,fontFamily:'monospace'}}>{l.action}</span>
                <span style={{color:T.muted,fontSize:9}}>{l.created_at?.slice(0,16).replace('T',' ')}</span>
              </div>
              <div style={{color:T.muted,fontSize:10}}>{l.result} {l.details?JSON.stringify(l.details).slice(0,60):''}…</div>
            </div>
          ))}
        </div>
      )}

      {/* Emergency Control */}
      {aTab==='control'&&(
        <div>
          {msg&&<div style={{background:'rgba(16,185,129,0.1)',border:'1px solid rgba(16,185,129,0.3)',borderRadius:10,padding:'10px 12px',marginBottom:10,color:'#10B981',fontSize:12,fontWeight:700}}>{msg}</div>}
          <div style={{background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.3)',borderRadius:12,padding:'14px',marginBottom:10}}>
            <div style={{color:'#EF4444',fontWeight:800,fontSize:13,marginBottom:4}}>⚡ 긴급 전략 전체 정지</div>
            <div style={{color:T.muted,fontSize:11,marginBottom:12}}>실행 중인 모든 자동매매 전략을 즉시 중지합니다.</div>
            <button onClick={()=>doAction('emergency_stop',{reason:'관리자 긴급 정지'})} style={{width:'100%',padding:'10px',background:'rgba(239,68,68,0.15)',border:'1px solid rgba(239,68,68,0.5)',borderRadius:10,color:'#EF4444',fontSize:12,fontWeight:800,cursor:'pointer'}}>
              🛑 전체 봇 긴급 정지
            </button>
          </div>
          <div style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:12,padding:'14px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:800,fontSize:13,marginBottom:4}}>🔧 유지보수 모드</div>
            <div style={{color:T.muted,fontSize:11,marginBottom:12}}>유지보수 모드를 감사 로그에 기록합니다.</div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>doAction('maintenance_mode',{enabled:true,reason:'정기 유지보수'})} style={{flex:1,padding:'8px',background:T.surf,border:`1px solid ${T.border}`,borderRadius:10,color:T.ylw,fontSize:11,fontWeight:700,cursor:'pointer'}}>🟡 시작</button>
              <button onClick={()=>doAction('maintenance_mode',{enabled:false})} style={{flex:1,padding:'8px',background:T.surf,border:`1px solid ${T.border}`,borderRadius:10,color:T.grn,fontSize:11,fontWeight:700,cursor:'pointer'}}>🟢 해제</button>
            </div>
          </div>
          <div style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:12,padding:'12px',color:T.muted,fontSize:10}}>
            ℹ️ 관리자 승격은 Supabase SQL에서만 가능합니다:<br/>
            <code style={{color:T.acl,fontSize:9}}>UPDATE profiles SET role = 'admin' WHERE email = 'user@example.com';</code>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main App ── */
export default function App() {
  const [mounted, setMounted] = useState(false);
  const [tab,setTab]=useState('home');
  // ── Admin role (loaded from Supabase profiles after mount) ──
  const [userRole,setUserRole]=useState<string|null>(null);
  const isAdminUser = userRole==='admin'||userRole==='developer'||userRole==='super_admin';
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        const {getSupabaseClient}=await import('@/lib/supabase/client');
        const sb=getSupabaseClient();
        if(!sb) return;
        const {data:{user}}=await sb.auth.getUser();
        if(!user||cancelled) return;
        const {data:profile}=await sb.from('profiles').select('role').eq('id',user.id).single();
        if(!cancelled&&profile?.role) setUserRole(profile.role);
      }catch{}
    })();
    return()=>{cancelled=true;};
  },[]);
  // ── PWA state (safe client-only) ──
  const [pwaInstallable,setPwaInstallable] = useState(false);
  const [pwaOffline,setPwaOffline]         = useState(false);
  const [pwaUpdate,setPwaUpdate]           = useState(false);
  const [pwaSwReg,setPwaSwReg]             = useState<ServiceWorkerRegistration|null>(null);
  const [pwaPrompt,setPwaPrompt]           = useState<any>(null);

  useEffect(()=>{ setMounted(true); },[]);

  useEffect(()=>{
    if(typeof window==='undefined') return;
    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('/sw.js',{scope:'/'})
        .then(reg=>{
          setPwaSwReg(reg);
          reg.addEventListener('updatefound',()=>{
            const nw=reg.installing;
            if(!nw) return;
            nw.addEventListener('statechange',()=>{
              if(nw.state==='installed'&&navigator.serviceWorker.controller) setPwaUpdate(true);
            });
          });
        }).catch(()=>{});
    }
    const handleOnline  = ()=>setPwaOffline(false);
    const handleOffline = ()=>setPwaOffline(true);
    if(!navigator.onLine) setPwaOffline(true);
    window.addEventListener('online',handleOnline);
    window.addEventListener('offline',handleOffline);
    const handlePrompt=(e:Event)=>{
      e.preventDefault();
      setPwaPrompt(e);
      setPwaInstallable(true);
    };
    window.addEventListener('beforeinstallprompt',handlePrompt);
    window.addEventListener('appinstalled',()=>{setPwaInstallable(false);});
    return()=>{
      window.removeEventListener('online',handleOnline);
      window.removeEventListener('offline',handleOffline);
      window.removeEventListener('beforeinstallprompt',handlePrompt);
    };
  },[]);

  const promptPwaInstall=async()=>{
    if(!pwaPrompt) return;
    (pwaPrompt as any).prompt();
    await (pwaPrompt as any).userChoice;
    setPwaPrompt(null); setPwaInstallable(false);
  };
  const applyPwaUpdate=()=>{
    if(pwaSwReg?.waiting) pwaSwReg.waiting.postMessage({type:'SKIP_WAITING'});
    setPwaUpdate(false);
  };

  const [prices,setPrices]=useState<Asset[]>(ASSETS);
  const [showMore,setShowMore]=useState(false);
  // SSR-safe: start with defaults, load from localStorage after mount
  const [lang,setLang]           = useState('ko');
  const [currency,setCurrency]   = useState('KRW');
  const [onboarded,setOnboarded] = useState(true);   // default true = no onboarding flash

  useEffect(()=>{
    // Load persisted preferences AFTER hydration (client only)
    const savedLang = gS('tg_lang','ko');
    const savedCur  = gS('tg_cur','KRW');
    const savedOb   = !!gS('tg_ob','');
    if(savedLang !== 'ko')   setLang(savedLang);
    if(savedCur  !== 'KRW')  setCurrency(savedCur);
    setOnboarded(savedOb);
  },[]);

  useEffect(()=>{sS('tg_lang',lang);},[lang]);

  // Keyboard shortcuts (desktop/Mac)
  useEffect(()=>{
    const handler=(e:KeyboardEvent)=>{
      if(e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement) return;
      const meta=e.metaKey||e.ctrlKey;
      if(meta&&e.key==='k'){e.preventDefault();nav('market');}   // Cmd+K → search
      if(meta&&e.key==='1'){e.preventDefault();nav('home');}
      if(meta&&e.key==='2'){e.preventDefault();nav('chart');}
      if(meta&&e.key==='3'){e.preventDefault();nav('analysis');}
      if(e.key==='Escape'){setShowMore(false);}
    };
    window.addEventListener('keydown',handler);
    return()=>window.removeEventListener('keydown',handler);
  },[nav]);
  useEffect(()=>{sS('tg_cur',currency);},[currency]);
  useEffect(()=>{
    const t=setInterval(()=>setPrices(prev=>simulatePriceUpdate(prev)),3000);
    return()=>clearInterval(t);
  },[]);

  const nav=useCallback((id:string)=>{setTab(id);setShowMore(false);},[]);
  const allTabs=[...BTABS,...MTABS];
  const unreadCount=2;

  const renderPage=useCallback(()=>{
    const p={prices,currency,lang,onNav:nav};
    try {
      switch(tab) {
        case 'home':         return <HomePageComp {...p}/>;
        case 'watchlist':    return <WatchlistPage prices={prices} currency={currency} onNav={nav}/>;
        case 'market':       return <MarketPageComp prices={prices} onNav={nav} currency={currency}/>;
        case 'trading':      return <TradingPageComp prices={prices} currency={currency}/>;
        case 'auto':         return <AutoPageComp/>;
        case 'season':       return <SeasonDashboard/>;
        case 'portfolio':    return <PortfolioPageComp prices={prices} currency={currency}/>;
        case 'history':      return <HistoryPage/>;
        case 'backtest':     return <BacktestPage/>;
        case 'ai':           return <AIPageComp prices={prices} currency={currency}/>;
        case 'academy':      return <AcademyPage/>;
        case 'posters':      return <PosterLibrary/>;
        case 'safety':       return <SafetyDashboard/>;
        case 'hub':          return <HubDashboard currency={currency}/>;
        case 'news':         return <NewsPage currency={currency}/>;
        case 'alerts':       return <AlertsPage prices={prices}/>;
        case 'social':       return <SocialPage/>;
        case 'accounts':     return <ExchangeConnectPage/>;;
        case 'funding':      return <FundingPage currency={currency}/>;
        case 'pnl':         return <PnLCalculatorPage currency={currency}/>;;
        case 'heatmap':      return <div><div style={{fontWeight:800,fontSize:15,color:T.txt,marginBottom:12}}>🌈 자산 히트맵</div><Heatmap prices={prices}/></div>;
        case 'scanner':      return <ScannerPage prices={prices} currency={currency}/>;
        case 'clock':        return <div style={{padding:'4px 0'}}><WorldClock/></div>;
        case 'settings':     return <SettingsPage lang={lang} setLang={setLang} currency={currency} setCurrency={setCurrency}/>;
        case 'analysis':     return <AnalysisHubPage/>;
        case 'hedgeos':      return <HedgeOSPage/>;
        case 'intelligence': return <IntelligencePage prices={prices} currency={currency}/>;
        case 'wunder':       return <WunderPage/>;
        case 'chart':        return <ChartTab/>;
        case 'tradfi':       return <TradFiPage prices={prices} currency={currency}/>;
        case 'realtime':     return <RealtimePage prices={prices}/>;
        case 'analytics':    return <AnalyticsPage prices={prices} currency={currency}/>;
        case 'subscription': return <SubscriptionPage/>;
        case 'calendar':     return <EconCalendarPage/>;
        case 'briefing':     return <BriefingPage prices={prices}/>;
        case 'tax':          return <TaxPage currency={currency}/>;
        case 'growth':       return <GrowthPage/>;
        case 'admin':        return isAdminUser ? <AdminPage/> : <HomePage {...p}/>;
        default:             return <HomePageComp {...p}/>;
      }
    } catch(e) {
      console.error('[renderPage]', tab, e);
      return <div style={{padding:'24px 16px',textAlign:'center',color:'#EF4444'}}>
        <div style={{fontSize:24,marginBottom:8}}>⚠️</div>
        <div style={{fontWeight:700,marginBottom:4}}>페이지 오류</div>
        <div style={{fontSize:11,color:'#94A3B8',marginBottom:12}}>{String(e)}</div>
        <button onClick={()=>nav('home')} style={{background:'#2563EB',color:'#fff',border:'none',borderRadius:10,padding:'10px 20px',fontWeight:700,cursor:'pointer'}}>홈으로</button>
      </div>;
    }
  },[tab,prices,nav,currency,lang,setLang,setCurrency,isAdminUser]);

  const tickerAssets=prices.slice(0,14);

  // Don't render until client is mounted - prevents ALL hydration mismatches
  if (!mounted) {
    return (
      <div style={{
        minHeight:'100vh', background:'#060B14',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}>
        <div style={{ textAlign:'center', color:'#475569' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>
            <span style={{ display:'inline-block', animation:'spin 1s linear infinite' }}>⟳</span>
          </div>
          <div style={{ fontSize:13, fontWeight:700, color:'#60A5FA' }}>TRAIGO</div>
        </div>
      </div>
    );
  }

  return (
    <>
      {!onboarded&&<Onboarding onDone={(l,c)=>{setLang(l);setCurrency(c);setOnboarded(true);sS('tg_ob','1');sS('tg_lang',l);sS('tg_cur',c);}}/>}
      <div suppressHydrationWarning className="aw" style={{background:T.bg,minHeight:'100vh',minHeight:'-webkit-fill-available' as any,color:T.txt,maxWidth:480,margin:'0 auto'}}>

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
          <div style={{position:'sticky',top:0,zIndex:50,background:'rgba(6,11,20,.92)',backdropFilter:'blur(16px)',WebkitBackdropFilter:'blur(16px)',WebkitBackdropFilter:'blur(16px)',borderBottom:`1px solid ${T.border}`,padding:'11px 16px 9px',display:'flex',justifyContent:'space-between',alignItems:'center',paddingTop:`max(env(safe-area-inset-top),11px)`}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <div style={{width:26,height:26,borderRadius:8,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:13,color:'#fff'}}>T</div>
              <div style={{fontWeight:900,fontSize:14,letterSpacing:-0.5}}>{allTabs.find(t2=>t2.id===tab)?.label||'TRAIGO'}</div>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <div style={{display:'flex',alignItems:'center',gap:4,background:'rgba(16,185,129,.12)',border:'1px solid rgba(16,185,129,.3)',borderRadius:20,padding:'3px 9px'}}>
                <Dot/><span style={{color:T.grn,fontSize:10,fontWeight:700}}>LIVE</span>
              </div>
              {pwaInstallable&&(
                <button onClick={promptPwaInstall} style={{background:'linear-gradient(135deg,#2563EB,#7C3AED)',border:'none',borderRadius:20,padding:'3px 10px',cursor:'pointer',fontSize:10,color:'#fff',fontWeight:700,display:'flex',alignItems:'center',gap:3}}>
                  📲 설치
                </button>
              )}
              {isAdminUser&&(
                <button onClick={()=>nav('admin')} style={{background:'rgba(16,185,129,0.12)',border:'1px solid rgba(16,185,129,0.35)',borderRadius:20,padding:'2px 9px',cursor:'pointer',fontSize:11,color:'#10B981',fontWeight:700,display:'flex',alignItems:'center',gap:3}}>
                  🛡️ 관리자
                </button>
              )}
              <button onClick={()=>nav('settings')} style={{background:T.acg,border:`1px solid ${T.border}`,borderRadius:20,padding:'2px 9px',cursor:'pointer',fontSize:11,color:T.acl,fontWeight:700,display:'flex',alignItems:'center',gap:3}}>
                <span>{LANGS.find(l=>l.id===lang)?.flag||'🌍'}</span>
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

          {/* PWA: Offline banner */}
          {pwaOffline&&(
            <div style={{background:'#78350F',borderBottom:'1px solid #92400E',padding:'8px 16px',display:'flex',alignItems:'center',gap:8,zIndex:49}}>
              <span style={{fontSize:14}}>📡</span>
              <span style={{color:'#FCD34D',fontSize:11,fontWeight:700,flex:1}}>오프라인 · 캐시된 데이터 표시 중</span>
            </div>
          )}
          {/* PWA: Update banner */}
          {pwaUpdate&&(
            <div style={{background:'#1E3A5F',borderBottom:`1px solid ${T.acl}40`,padding:'8px 16px',display:'flex',alignItems:'center',gap:8,zIndex:49}}>
              <span style={{fontSize:14}}>🔄</span>
              <span style={{color:T.acl,fontSize:11,fontWeight:700,flex:1}}>새 버전이 있습니다</span>
              <button onClick={applyPwaUpdate} style={{background:T.acl,color:'#fff',border:'none',borderRadius:8,padding:'4px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>업데이트</button>
              <button onClick={()=>setPwaUpdate(false)} style={{background:'transparent',border:'none',color:T.muted,cursor:'pointer',fontSize:16,lineHeight:1}}>✕</button>
            </div>
          )}
          {/* Page Content */}
          <div style={{padding:'12px 12px var(--nav-h)'}}>
            <ErrorBoundary fallback={<div style={{padding:'24px 16px',textAlign:'center'}}><div style={{fontSize:32,marginBottom:8}}>⚠️</div><div style={{color:'#EF4444',fontWeight:700,marginBottom:6}}>페이지 로딩 오류</div><button onClick={()=>window.location.reload()} style={{background:'#2563EB',color:'#fff',border:'none',borderRadius:10,padding:'10px 20px',fontWeight:700,cursor:'pointer',marginTop:8}}>새로고침</button></div>}>
              {renderPage()}
            </ErrorBoundary>
          </div>

          {/* Bottom Nav */}
          <div className="bottom-nav" style={{}}>
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
              <div style={{position:'fixed',bottom:'calc(var(--nav-h) + 8px)',left:'50%',transform:'translateX(-50%)',width:'calc(100% - 24px)',maxWidth:456,background:T.surf,border:`1px solid ${T.border}`,borderRadius:20,padding:'12px 12px calc(12px + env(safe-area-inset-bottom,0px))',zIndex:150,boxShadow:'0 -8px 40px rgba(0,0,0,.6)',maxHeight:'70vh',overflowY:'auto'}}>
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
/* ══════════════════════════════════════════════════════════════════
   TRAIGO Asset Logo System — 200+ curated logos
   Priority: curated URL → cryptologos.cc → Clearbit → initials
   ══════════════════════════════════════════════════════════════════ */

/* ─── Multi-source logo resolver ─── */
interface LogoDef { primary: string; fallbacks: string[]; initials: string; bg: string }
