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



export default AdminPage;