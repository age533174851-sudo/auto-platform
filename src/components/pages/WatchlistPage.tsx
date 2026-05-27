'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS, LOGO_SOURCES } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Dot, Spark, Pill, Bdg, Toggle, AreaChart, WorldClock, Heatmap,
         TradingChart, Logo, getBgColor, resolveLogoUrl, getKrName, cleanName, resolveTVSym,
         DonutChart, MiniBar, GlobalSearch, getLeverageRec,
         LiquidationCalc, PositionSizer, RiskDashboard,
         InlineTVChart } from './SharedUI';


function WatchlistPage({prices,currency,onNav,onOpenAsset}:{prices:Asset[];currency:string;onNav:(tab:string)=>void;onOpenAsset?:(a:Asset,dest?:string)=>void}) {
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
      (a.nameKr || "").includes(q) ||
      a.sym.toLowerCase().includes(lq) ||
      a.id.toLowerCase().includes(resolved.toLowerCase())
    );
    return res.length ? res : WL_DB.filter(a => (a.nameKr || "").includes(q.slice(0,2)) || a.id.toLowerCase().startsWith(lq));
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
                ):(Array.isArray(res)?res:[]).map(a=>{
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
      <div className="wl-tabs" style={{display:'flex',gap:5,overflowX:'auto',paddingBottom:5,marginBottom:12}}>
        {CATS.map(c=>(
          <button key={c.id} onClick={()=>setCat(c.id)} className="wl-tab" style={{flexShrink:0,display:'flex',alignItems:'center',gap:4,padding:'5px 12px',borderRadius:20,background:cat===c.id?`${c.color}20`:'transparent',color:cat===c.id?c.color:T.muted,border:`1px solid ${cat===c.id?c.color:T.border}`,fontWeight:700,fontSize:11,cursor:'pointer',whiteSpace:'nowrap'}}>
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
          {(Array.isArray(displayRows)?displayRows:[]).map((a:any,i:number)=>(
            <div key={a.id} className="wl-row" style={{display:'flex',alignItems:'center',padding:'10px 12px',borderBottom:i<displayRows.length-1?`1px solid ${T.border}`:'none',cursor:'pointer',gap:8}} onClick={()=>{if(onOpenAsset)onOpenAsset(a,'trading');else onNav('trading');}}>
              {/* Left: logo + name */}
              <div className="wl-row-left">
                <Logo id={a.id} size={36} clr={a.clr||T.acl} name={a.nameKr}/>
                <div className="wl-name" style={{minWidth:0}}>
                  <div className="wl-name" style={{color:T.txt,fontWeight:700,fontSize:13}}>{a.nameKr||a.id}</div>
                  <div style={{color:T.muted,fontSize:9,fontFamily:'monospace',marginTop:1}}>{a.sym||a.id}</div>
                </div>
              </div>
              {/* Middle: sparkline — hidden on narrow mobile via CSS trick */}
              <div style={{flexShrink:0,display:'flex',justifyContent:'center',width:46}} className="wl-spark">
                <Spark pos={(a.c||0)>=0} w={44} h={22}/>
              </div>
              {/* Right: price + change */}
              <div className="wl-row-right">
                {a.p?(
                  <>
                    <div style={{color:a.noData?T.muted:T.txt,fontWeight:700,fontSize:11,fontFamily:'monospace',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:'100%'}}>{a.noData?'—':a.p?cvt(a.p,currency):'연결 필요'}</div>
                    <div style={{color:(a.c||0)>=0?T.grn:T.red,fontSize:10,fontWeight:700,marginTop:1,whiteSpace:'nowrap'}}>{(a.c||0)>=0?'▲':'▼'}{Math.abs(a.c||0).toFixed(2)}%</div>
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


export default WatchlistPage;