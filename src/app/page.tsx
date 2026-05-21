'use client';
import React, { useState, useEffect, useCallback } from 'react';
import type { Asset } from '@/types';
import { T, CURRENCIES, LANGS, I18N, MOCK_NEWS } from '@/lib/constants';
import { gS, sS, cvt, fmtPct } from '@/lib/utils';
import { ASSETS, simulatePriceUpdate } from '@/data/assets';
import { ErrorBoundary } from '@/components/pages/ErrorBoundary';
import { Dot, Logo } from '@/components/pages/SharedUI';

// ── Static imports (small/critical for first paint) ──────────
import PosterLibrary from '@/components/PosterLibrary';
import SafetyDashboard from '@/components/SafetyDashboard';
import SeasonDashboard from '@/components/SeasonDashboard';
import HubDashboard from '@/components/HubDashboard';

// ── Dynamic imports (lazy-loaded, eliminates TDZ in bundle) ──
import dynamic from 'next/dynamic';

const HomePageComp    = dynamic(() => import('@/components/pages/HomePage'),    { ssr: false });
const MarketPageComp  = dynamic(() => import('@/components/pages/MarketPage'),  { ssr: false });
const WatchlistPage   = dynamic(() => import('@/components/pages/WatchlistPage'),{ ssr: false });
const PortfolioPageComp = dynamic(() => import('@/components/pages/PortfolioPage'), { ssr: false });
const TradingPageComp = dynamic(() => import('@/components/pages/TradingPage'), { ssr: false });
const AutoPageComp    = dynamic(() => import('@/components/pages/AutoPage'),    { ssr: false });
const AIPageComp      = dynamic(() => import('@/components/pages/AIPage'),      { ssr: false });
const NewsPage        = dynamic(() => import('@/components/pages/NewsPage'),    { ssr: false });
const AlertsPage      = dynamic(() => import('@/components/pages/AlertsPage'), { ssr: false });
const HistoryPage     = dynamic(() => import('@/components/pages/HistoryPage'),{ ssr: false });
const BacktestPage    = dynamic(() => import('@/components/pages/BacktestPage'),{ ssr: false });
const AcademyPage     = dynamic(() => import('@/components/pages/AcademyPage'),{ ssr: false });
const ScannerPage     = dynamic(() => import('@/components/pages/ScannerPage'),{ ssr: false });
const SettingsPage    = dynamic(() => import('@/components/pages/SettingsPage'),{ ssr: false });
const SocialPage      = dynamic(() => import('@/components/pages/SocialPage'), { ssr: false });
const AccountsPage    = dynamic(() => import('@/components/pages/AccountsPage'),{ ssr: false });
const FundingPage     = dynamic(() => import('@/components/pages/FundingPage'),{ ssr: false });
const TradFiPage      = dynamic(() => import('@/components/pages/TradFiPage'), { ssr: false });
const RealtimePage    = dynamic(() => import('@/components/pages/RealtimePage'),{ ssr: false });
const AnalyticsPage   = dynamic(() => import('@/components/pages/AnalyticsPage'),{ ssr: false });
const SubscriptionPage = dynamic(() => import('@/components/pages/SubscriptionPage'),{ ssr: false });
const EconCalendarPage = dynamic(() => import('@/components/pages/EconCalendarPage'),{ ssr: false });
const BriefingPage    = dynamic(() => import('@/components/pages/BriefingPage'),{ ssr: false });
const TaxPage         = dynamic(() => import('@/components/pages/TaxPage'),    { ssr: false });
const GrowthPage      = dynamic(() => import('@/components/pages/GrowthPage'), { ssr: false });
const WunderPage      = dynamic(() => import('@/components/pages/WunderPage'), { ssr: false });
const HedgeOSPage     = dynamic(() => import('@/components/pages/HedgeOSPage'),{ ssr: false });
const ChartTab        = dynamic(() => import('@/components/pages/ChartTab'),   { ssr: false });
const AnalysisHubPage = dynamic(() => import('@/components/pages/AnalysisHubPage'),{ ssr: false });
const IntelligencePage = dynamic(() => import('@/components/IntelligencePage'),{ ssr: false });
const PnLCalculatorPage = dynamic(() => import('@/components/PnLCalculator'),  { ssr: false });
const ExchangeConnectPage = dynamic(() => import('@/components/ExchangeConnectPage'),{ ssr: false });
const AdminPageComp   = dynamic(() => import('@/components/pages/AdminPage'),  { ssr: false });
const WorldClock = dynamic(() => import('@/components/pages/SharedUI').then(m => ({ default: m.WorldClock })), { ssr: false });
const Heatmap = dynamic(() => import('@/components/pages/SharedUI').then(m => ({ default: m.Heatmap })), { ssr: false });


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
        {step===0&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>{LANGS.map(l=><button key={l.id} onClick={()=>setSl(l.id)} style={{background:sl===l.id?T.acc+'25':T.card,border:`2px solid ${sl===l.id?T.acl:T.border}`,borderRadius:16,padding:'18px 10px',cursor:'pointer',textAlign:'center'}}><div style={{fontSize:32,marginBottom:8}}>{l.flag}</div><div style={{color:sl===l.id?T.acl:T.txt,fontWeight:700,fontSize:14}}>{l.label}</div></button>)}</div>}
        {step===1&&<div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>{Object.entries(CURRENCIES).map(([code,cur])=><button key={code} onClick={()=>setSc(code)} style={{background:sc===code?T.acc+'25':T.card,border:`2px solid ${sc===code?T.acl:T.border}`,borderRadius:12,padding:'10px 4px',cursor:'pointer',textAlign:'center'}}><div style={{color:sc===code?T.acl:T.txt,fontWeight:800,fontSize:18}}>{cur.symbol}</div><div style={{color:T.muted,fontSize:9,marginTop:1}}>{code}</div></button>)}</div>}
      </div>
      <div style={{padding:'14px 20px 36px',flexShrink:0,borderTop:`1px solid ${T.border}`,background:T.bg}}>
        <button onClick={()=>{if(step===0)setStep(1);else onDone(sl,sc);}} style={{width:'100%',padding:'16px',background:`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:16,fontWeight:800,fontSize:16,cursor:'pointer',marginBottom:10}}>{step===0?'다음 →':'🚀 시작하기'}</button>
        <button onClick={()=>onDone('ko','KRW')} style={{width:'100%',padding:'10px',background:'transparent',color:T.muted,border:'none',cursor:'pointer',fontSize:12}}>건너뛰기</button>
      </div>
    </div>
  );
}

/* ── WorldClock ── */

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
  const nav=useCallback((id:string)=>{setTab(id);setShowMore(false);},[]);
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

  const allTabs=[...BTABS,...MTABS];
  const unreadCount=0; // TODO: connect to real alert count

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
        case 'accounts':     return <ExchangeConnectPage/>;
        case 'funding':      return <FundingPage currency={currency}/>;
        case 'pnl':         return <PnLCalculatorPage currency={currency}/>;;
        case 'heatmap':      return <div><div style={{fontWeight:800,fontSize:15,color:T.txt,marginBottom:12}}>🌈 자산 히트맵</div><Heatmap prices={prices}/></div>;
        case 'scanner':      return <ScannerPage prices={prices} currency={currency}/>;
        case 'clock':        return <div style={{padding:'4px 0'}}><React.Suspense fallback={null}><WorldClock/></React.Suspense></div>;
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
        case 'admin':        return isAdminUser ? <AdminPageComp/> : <HomePageComp {...p}/>;
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
      <div suppressHydrationWarning className="aw" style={{background:T.bg,minHeight:'-webkit-fill-available' as any,color:T.txt,maxWidth:480,margin:'0 auto'}}>

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
          <div style={{position:'sticky',top:0,zIndex:50,background:'rgba(6,11,20,.92)',backdropFilter:'blur(16px)',WebkitBackdropFilter:'blur(16px)',borderBottom:`1px solid ${T.border}`,padding:'11px 16px 9px',display:'flex',justifyContent:'space-between',alignItems:'center',paddingTop:`max(env(safe-area-inset-top),11px)`}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <div style={{width:26,height:26,borderRadius:8,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:13,color:'#fff'}}>T</div>
              <div style={{fontWeight:900,fontSize:14,letterSpacing:-0.5}}>{allTabs.find(t2=>t2.id===tab)?.label||'TRAIGO'}</div>
            </div>
            <div className="hdr-actions" style={{display:'flex',alignItems:'center',gap:4}}>
              <div style={{display:'flex',alignItems:'center',gap:3,background:'rgba(16,185,129,.12)',border:'1px solid rgba(16,185,129,.3)',borderRadius:20,padding:'2px 7px'}}>
                <Dot/><span style={{color:T.grn,fontSize:9,fontWeight:700}}>LIVE</span>
              </div>
              {pwaInstallable&&(
                <button onClick={promptPwaInstall} style={{background:'linear-gradient(135deg,#2563EB,#7C3AED)',border:'none',borderRadius:20,padding:'3px 10px',cursor:'pointer',fontSize:10,color:'#fff',fontWeight:700,display:'flex',alignItems:'center',gap:3}} className="hdr-badge">
                  📲 설치
                </button>
              )}
              {isAdminUser&&(
                <button onClick={()=>nav('admin')} style={{background:'rgba(16,185,129,0.12)',border:'1px solid rgba(16,185,129,0.35)',borderRadius:20,padding:'2px 9px',cursor:'pointer',fontSize:11,color:'#10B981',fontWeight:700,display:'flex',alignItems:'center',gap:3}}>
                  🛡️ 관리자
                </button>
              )}
              <button onClick={()=>nav('settings')} className="hdr-badge" style={{background:T.acg,border:`1px solid ${T.border}`,borderRadius:20,padding:'2px 7px',cursor:'pointer',fontSize:10,color:T.acl,fontWeight:700,display:'flex',alignItems:'center',gap:2}}>
                <span>{LANGS.find(l=>l.id===lang)?.flag||'🌍'}</span>
                <span>{CURRENCIES[currency]?.symbol||'₩'}</span>
              </button>
              <button onClick={()=>nav('alerts')} className="hdr-badge" style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:20,padding:'2px 7px',cursor:'pointer',fontSize:11,color:T.muted,position:'relative'}}>
                🔔{unreadCount>0&&<span style={{position:'absolute',top:-3,right:-3,background:T.red,color:'#fff',borderRadius:'50%',width:12,height:12,fontSize:8,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700}}>{unreadCount}</span>}
              </button>
              <div style={{background:T.prp+'20',border:`1px solid ${T.prp}40`,borderRadius:20,padding:'2px 7px'}}>
                <span style={{color:T.prp,fontSize:9,fontWeight:700}}>모의</span>
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
          <div className="page-content" style={{padding:'12px 12px var(--nav-h)'}}>
            <ErrorBoundary fallback={<div style={{padding:'24px 16px',textAlign:'center'}}><div style={{fontSize:32,marginBottom:8}}>⚠️</div><div style={{color:'#EF4444',fontWeight:700,marginBottom:6}}>페이지 로딩 오류</div><button onClick={()=>window.location.reload()} style={{background:'#2563EB',color:'#fff',border:'none',borderRadius:10,padding:'10px 20px',fontWeight:700,cursor:'pointer',marginTop:8}}>새로고침</button></div>}>
              {renderPage()}
            </ErrorBoundary>
          </div>

          {/* Bottom Nav */}
          <div className="bottom-nav" style={{display:"flex",alignItems:"stretch"}}>
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
