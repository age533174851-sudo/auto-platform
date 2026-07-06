'use client';
import React, { useState, useEffect, useCallback } from 'react';
import type { Asset } from '@/types';
import { T, CURRENCIES, LANGS, I18N, MOCK_NEWS, RTL_LANGS } from '@/lib/constants';
import { gS, sS, cvt, fmtPct } from '@/lib/utils';
import { ASSETS } from '@/data/assets';
import { ErrorBoundary } from '@/components/pages/ErrorBoundary';
import { Dot, Logo } from '@/components/pages/SharedUI';
import { useLivePrices, statusLabel } from '@/lib/api/hooks';
import type { LucideIcon } from 'lucide-react';
import {
  Home as HomeIc, Star, BarChart3, Zap, Bot, Sprout,
  Briefcase, NotebookPen, FlaskConical, MessageSquare, GraduationCap,
  Newspaper, Bell, Users, Landmark, Brain, CalendarClock, BadgeDollarSign,
  Link as LinkIc, ArrowLeftRight, Percent, Microscope, Building2, Sparkles,
  LineChart as LineChartIc, Bot as BotIc, BarChart2, Radio,
  TrendingUp, TrendingDown, CalendarRange, ChartLine, Receipt, Trophy, Rainbow,
  Search as SearchIc, Globe, Globe2, Workflow, FolderKanban, ClipboardList,
  Wallet,
  Stethoscope, Settings, CreditCard, Presentation, Shield, LayoutGrid,
  MoreHorizontal, X as XIcon, TriangleAlert,
} from 'lucide-react';

// lucide-react 아이콘 타입
type IconComp = LucideIcon;

// ── Static imports (small/critical for first paint) ──────────
import PosterLibrary from '@/components/PosterLibrary';
import SafetyDashboard from '@/components/SafetyDashboard';
import SeasonDashboard from '@/components/SeasonDashboard';
import HubDashboard from '@/components/HubDashboard';

// ── Dynamic imports (lazy-loaded, eliminates TDZ in bundle) ──
import dynamic from 'next/dynamic';

const HomePageComp    = dynamic(() => import('@/components/pages/HomePage'),    { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const MarketPageComp  = dynamic(() => import('@/components/pages/MarketPage'),  { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const WatchlistPage   = dynamic(() => import('@/components/pages/WatchlistPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const PortfolioPageComp = dynamic(() => import('@/components/pages/PortfolioPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const TradingPageComp = dynamic(() => import('@/components/pages/TradingPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const AutoPageComp    = dynamic(() => import('@/components/pages/AutoPage'),    { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const StrategyBuilderPage = dynamic(() => import('@/components/pages/StrategyBuilderPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const RiskSettingsPage = dynamic(() => import('@/components/pages/RiskSettingsPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const AutoTradeEngine = dynamic(() => import('@/components/AutoTradeEngine'), { ssr: false });
const ApiHealthMonitor = dynamic(() => import('@/components/ApiHealthMonitor'), { ssr: false });
const AIPageComp      = dynamic(() => import('@/components/pages/AIPage'),      { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const NewsPage        = dynamic(() => import('@/components/pages/NewsPage'),    { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const AlertsPage      = dynamic(() => import('@/components/pages/AlertsPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const HistoryPage     = dynamic(() => import('@/components/pages/HistoryPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const BacktestPage    = dynamic(() => import('@/components/pages/BacktestPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const AcademyPage     = dynamic(() => import('@/components/pages/AcademyPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const ScannerPage     = dynamic(() => import('@/components/pages/ScannerPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const SettingsPage    = dynamic(() => import('@/components/pages/SettingsPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const SocialPage      = dynamic(() => import('@/components/pages/SocialPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const AccountsPage    = dynamic(() => import('@/components/pages/AccountsPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const HubAccountsPage = dynamic(() => import('@/components/pages/HubAccountsPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const ManualAccountsPage = dynamic(() => import('@/components/pages/ManualAccountsPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const FearDcaPage = dynamic(() => import('@/components/pages/FearDcaPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>로딩 중...</div> });
const MenuHubPage = dynamic(() => import('@/components/pages/MenuHubPage'),{ ssr: false });
const PineGuidePage = dynamic(() => import('@/components/pages/PineGuidePage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>로딩 중...</div> });
const SeasonalityPage = dynamic(() => import('@/components/pages/SeasonalityPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>로딩 중...</div> });
const AIPortfolioPage = dynamic(() => import('@/components/pages/AIPortfolioPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const DCAPage         = dynamic(() => import('@/components/pages/DCAPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const DividendCalendarPage = dynamic(() => import('@/components/pages/DividendCalendarPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const FundingPage     = dynamic(() => import('@/components/pages/FundingPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const TradFiPage      = dynamic(() => import('@/components/pages/TradFiPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const RealtimePage    = dynamic(() => import('@/components/pages/RealtimePage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const AnalyticsPage   = dynamic(() => import('@/components/pages/AnalyticsPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const SubscriptionPage = dynamic(() => import('@/components/pages/SubscriptionPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const EconCalendarPage = dynamic(() => import('@/components/pages/EconCalendarPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const BriefingPage    = dynamic(() => import('@/components/pages/BriefingPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const TaxPage         = dynamic(() => import('@/components/pages/TaxPage'),    { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const GrowthPage      = dynamic(() => import('@/components/pages/GrowthPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const WunderPage      = dynamic(() => import('@/components/pages/WunderPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const HedgeOSPage     = dynamic(() => import('@/components/pages/HedgeOSPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const ChartTab        = dynamic(() => import('@/components/pages/ChartTab'),   { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const AnalysisHubPage = dynamic(() => import('@/components/pages/AnalysisHubPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const IntelligencePage = dynamic(() => import('@/components/IntelligencePage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const PnLCalculatorPage = dynamic(() => import('@/components/PnLCalculator'),  { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const DiagnosticsPage    = dynamic(() => import('@/components/pages/DiagnosticsPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const SearchPage         = dynamic(() => import('@/components/pages/SearchPage'),       { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const JournalReviewPage  = dynamic(() => import('@/components/pages/JournalReviewPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const AutoBotLabPage     = dynamic(() => import('@/components/pages/AutoBotLabPage'),   { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const WatchGroupsPage    = dynamic(() => import('@/components/pages/WatchGroupsPage'),  { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const PaperTradingPage   = dynamic(() => import('@/components/pages/PaperTradingPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const ExchangeConnectPage = dynamic(() => import('@/components/ExchangeConnectPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const AdminPageComp   = dynamic(() => import('@/components/pages/AdminPage'),  { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const WorldClock = dynamic(() => import('@/components/pages/SharedUI').then(m => ({ default: m.WorldClock })), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });
const Heatmap = dynamic(() => import('@/components/pages/SharedUI').then(m => ({ default: m.Heatmap })), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'#475569',fontSize:13}}>⏳ 로딩 중...</div> });


// 온보딩 번역 — 선택 언어 기준으로 제목/버튼 표시
const OB_I18N: Record<string, { title: string; currencyTitle: string; next: string; start: string; skip: string; tagline: string }> = {
  'ko':    { title: '언어를 선택하세요',        currencyTitle: '기본 통화를 선택하세요',     next: '다음',      start: '시작하기',     skip: '건너뛰기',   tagline: '글로벌 투자 시뮬레이션 플랫폼' },
  'en':    { title: 'Choose your language',     currencyTitle: 'Choose your currency',        next: 'Next',      start: 'Get Started',  skip: 'Skip',       tagline: 'Global investment simulation platform' },
  'ja':    { title: '言語を選択してください',     currencyTitle: '通貨を選択してください',       next: '次へ',      start: '始める',       skip: 'スキップ',   tagline: 'グローバル投資シミュレーション' },
  'zh-CN': { title: '请选择语言',                currencyTitle: '请选择货币',                  next: '下一步',    start: '开始',         skip: '跳过',       tagline: '全球投资模拟平台' },
  'zh-TW': { title: '請選擇語言',                currencyTitle: '請選擇貨幣',                  next: '下一步',    start: '開始',         skip: '跳過',       tagline: '全球投資模擬平台' },
  'vi':    { title: 'Chọn ngôn ngữ',            currencyTitle: 'Chọn tiền tệ',                next: 'Tiếp theo', start: 'Bắt đầu',      skip: 'Bỏ qua',     tagline: 'Nền tảng mô phỏng đầu tư toàn cầu' },
  'th':    { title: 'เลือกภาษา',                 currencyTitle: 'เลือกสกุลเงิน',                next: 'ถัดไป',     start: 'เริ่ม',         skip: 'ข้าม',        tagline: 'แพลตฟอร์มจำลองการลงทุนระดับโลก' },
  'id':    { title: 'Pilih bahasa',             currencyTitle: 'Pilih mata uang',             next: 'Lanjut',    start: 'Mulai',        skip: 'Lewati',     tagline: 'Platform simulasi investasi global' },
  'es':    { title: 'Elige tu idioma',          currencyTitle: 'Elige tu moneda',             next: 'Siguiente', start: 'Empezar',      skip: 'Omitir',     tagline: 'Plataforma de simulación de inversión global' },
  'fr':    { title: 'Choisissez votre langue',  currencyTitle: 'Choisissez votre devise',     next: 'Suivant',   start: 'Commencer',    skip: 'Ignorer',    tagline: "Plateforme de simulation d'investissement" },
  'de':    { title: 'Sprache auswählen',        currencyTitle: 'Währung auswählen',           next: 'Weiter',    start: 'Loslegen',     skip: 'Überspringen', tagline: 'Globale Investitions-Simulationsplattform' },
  'ar':    { title: 'اختر لغتك',                 currencyTitle: 'اختر عملتك',                   next: 'التالي',    start: 'ابدأ',         skip: 'تخطي',        tagline: 'منصة محاكاة الاستثمار العالمية' },
};

function Onboarding({onDone}:{onDone:(l:string,c:string)=>void}) {
  const [step,setStep]=useState(0);
  const [sl,setSl]=useState('ko');
  const [sc,setSc]=useState('KRW');

  const t = OB_I18N[sl] || OB_I18N['en'];
  const isRTL = sl === 'ar';

  // 선택 언어 즉시 localStorage 반영 (앱 진입 후 연동)
  const pick = (id: string) => {
    setSl(id);
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('tg_lang', id);
        document.documentElement.lang = id;
        document.documentElement.dir = id === 'ar' ? 'rtl' : 'ltr';
      }
    } catch {}
  };

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} style={{position:'fixed',inset:0,background:T.bg,display:'flex',flexDirection:'column',zIndex:1000}}>
      <div style={{padding:'32px 24px 16px',textAlign:'center',flexShrink:0,width:'100%',maxWidth:560,margin:'0 auto'}}>
        <div style={{width:64,height:64,borderRadius:18,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:30,fontWeight:900,color:'#fff',margin:'0 auto 10px'}}>T</div>
        <div style={{color:T.txt,fontWeight:900,fontSize:22,letterSpacing:-0.5}}>TRAIGO</div>
        <div style={{color:T.muted,fontSize:11,marginTop:3}}>{t.tagline}</div>
        <div style={{display:'flex',gap:8,marginTop:16,justifyContent:'center'}}>{[0,1].map(i=><div key={i} style={{width:step===i?28:8,height:7,borderRadius:4,background:step===i?T.acl:T.border,transition:'all .3s'}}/>)}</div>
        <div style={{color:T.txt,fontWeight:800,fontSize:17,marginTop:14,display:'flex',alignItems:'center',justifyContent:'center',gap:7}}>
          <Globe2 size={18} strokeWidth={2.2} color={T.acl}/>
          <span>{step===0 ? t.title : t.currencyTitle}</span>
        </div>
      </div>
      <div style={{flex:1,overflowY:'auto',padding:'0 20px 8px',width:'100%',maxWidth:560,margin:'0 auto'}}>
        {step===0&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>{LANGS.map(l=>(
          <button key={l.id} onClick={()=>pick(l.id)}
            dir={l.id === 'ar' ? 'rtl' : 'ltr'}
            style={{background:sl===l.id?T.acc+'25':T.card,border:`2px solid ${sl===l.id?T.acl:T.border}`,borderRadius:16,padding:'16px 12px',cursor:'pointer',textAlign:'center',minHeight:64,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:4}}>
            <div style={{color:sl===l.id?T.acl:T.txt,fontWeight:700,fontSize:15,lineHeight:1.2,wordBreak:'keep-all'}}>{l.native}</div>
            {l.native !== l.label && <div style={{color:T.muted,fontSize:9}}>{l.label}</div>}
          </button>
        ))}</div>}
        {step===1&&<div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>{Object.entries(CURRENCIES).map(([code,cur])=><button key={code} onClick={()=>setSc(code)} style={{background:sc===code?T.acc+'25':T.card,border:`2px solid ${sc===code?T.acl:T.border}`,borderRadius:12,padding:'10px 4px',cursor:'pointer',textAlign:'center'}}><div style={{color:sc===code?T.acl:T.txt,fontWeight:800,fontSize:18}}>{cur.symbol}</div><div style={{color:T.muted,fontSize:9,marginTop:1}}>{code}</div></button>)}</div>}
      </div>
      <div style={{padding:'14px 20px 36px',flexShrink:0,borderTop:`1px solid ${T.border}`,background:T.bg,width:'100%',maxWidth:560,margin:'0 auto'}}>
        <button onClick={()=>{if(step===0)setStep(1);else onDone(sl,sc);}} style={{width:'100%',padding:'16px',background:`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:16,fontWeight:800,fontSize:16,cursor:'pointer',marginBottom:10}}>{step===0 ? t.next : t.start}</button>
        <button onClick={()=>onDone(sl,sc==='KRW'&&sl!=='ko'?'USD':sc)} style={{width:'100%',padding:'10px',background:'transparent',color:T.muted,border:'none',cursor:'pointer',fontSize:12}}>{t.skip}</button>
      </div>
    </div>
  );
}

/* ── WorldClock ── */

const BTABS: { id: string; label: string; Icon: IconComp }[] = [
  {id:'home',     label:'홈',       Icon: HomeIc},
  {id:'watchlist',label:'왓치',     Icon: Star},
  {id:'market',   label:'시장',     Icon: BarChart3},
  {id:'trading',  label:'매매',     Icon: Zap},
  {id:'auto',     label:'자동',     Icon: Bot},
  {id:'season',   label:'시즌전략', Icon: Sprout},
];
const MTABS: { id: string; label: string; Icon: IconComp; core?: boolean }[] = [
  {id:'portfolio',    label:'포트폴리오', Icon: Briefcase, core: true},
  {id:'history',      label:'매매일지',   Icon: NotebookPen},
  {id:'backtest',     label:'백테스트',   Icon: FlaskConical, core: true},
  {id:'pine_guide',   label:'Pine 가이드', Icon: FlaskConical},
  {id:'seasonality',  label:'계절성 분석', Icon: CalendarRange, core: true},
  {id:'strategies',   label:'전략빌더',   Icon: Sparkles, core: true},
  {id:'risk_settings',label:'리스크관리', Icon: Shield, core: true},
  {id:'ai',           label:'AI채팅',     Icon: MessageSquare},
  {id:'academy',      label:'아카데미',   Icon: GraduationCap, core: true},
  {id:'news',         label:'뉴스',       Icon: Newspaper, core: true},
  {id:'alerts',       label:'알림',       Icon: Bell, core: true},
  {id:'social',       label:'소셜',       Icon: Users},
  {id:'hub_accounts', label:'통합운용',   Icon: Landmark},
  {id:'ai_portfolio', label:'AI추천',     Icon: Brain},
  {id:'dca',          label:'자동적립',   Icon: CalendarClock},
  {id:'fear_dca',     label:'공포 DCA',    Icon: TrendingDown, core: true},
  {id:'dividends',    label:'배당캘린더', Icon: BadgeDollarSign},
  {id:'accounts',     label:'거래소연결', Icon: LinkIc, core: true},
  {id:'manual_accounts', label:'수동자산등록', Icon: Wallet, core: true},
  {id:'funding',      label:'입출금',     Icon: ArrowLeftRight},
  {id:'pnl',          label:'수익계산',   Icon: Percent},
  {id:'analysis',     label:'분석허브',   Icon: Microscope},
  {id:'hedgeos',      label:'Hedge OS',   Icon: Building2},
  {id:'intelligence', label:'인텔리전스', Icon: Sparkles},
  {id:'chart',        label:'차트',       Icon: LineChartIc},
  {id:'wunder',       label:'WUNDER봇',   Icon: BotIc},
  {id:'tradfi',       label:'TradFi',     Icon: BarChart2},
  {id:'realtime',     label:'실시간',     Icon: Radio},
  {id:'analytics',    label:'분석',       Icon: TrendingUp},
  {id:'calendar',     label:'경제캘린더', Icon: CalendarRange},
  {id:'briefing',     label:'AI브리핑',   Icon: ChartLine},
  {id:'tax',          label:'손익·세금',  Icon: Receipt},
  {id:'growth',       label:'성장',       Icon: Trophy},
  {id:'heatmap',      label:'히트맵',     Icon: Rainbow},
  {id:'scanner',      label:'스캐너',     Icon: SearchIc},
  {id:'clock',        label:'세계시장',   Icon: Globe},
  {id:'search',       label:'검색',       Icon: SearchIc},
  {id:'autobot',      label:'AutoBot Lab',Icon: Workflow},
  {id:'review',       label:'AI 복기',    Icon: ClipboardList},
  {id:'groups',       label:'관심그룹',   Icon: FolderKanban},
  {id:'paper',        label:'모의매매',   Icon: ClipboardList},
  {id:'diagnostics',  label:'API 진단',   Icon: Stethoscope},
  {id:'settings',     label:'설정',       Icon: Settings, core: true},
  {id:'subscription', label:'구독',       Icon: CreditCard},
  {id:'posters',      label:'강의',       Icon: Presentation},
  {id:'safety',       label:'안전제어',   Icon: Shield},
  {id:'hub',          label:'허브',       Icon: LayoutGrid},
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

      // Auto-reload once when new SW takes control (gets fresh chunks)
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) { refreshing = true; window.location.reload(); }
      });
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

  // Live prices via API hook (auto-fetches /api/prices, simulates locally)
  const { prices, status: priceStatus, source: priceSource } = useLivePrices(3000);
  const [showMore,setShowMore]=useState(false);
  const [simpleMode,setSimpleMode]=useState(()=>{ try { return localStorage.getItem('tg_simple_mode')!=='false'; } catch { return true; } });
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

  useEffect(()=>{
    sS('tg_lang',lang);
    // RTL 언어(아랍어 등) 처리 + lang attr 동기화
    if (typeof document !== 'undefined') {
      const isRtl = RTL_LANGS.has(lang);
      document.documentElement.setAttribute('dir',  isRtl ? 'rtl' : 'ltr');
      document.documentElement.setAttribute('lang', lang);
    }
  },[lang]);

  // Keyboard shortcuts (desktop/Mac)
  const [activeAsset,setActiveAsset]=useState<any>(null);
  const [pnlPrefill,setPnlPrefill]=useState<any>(null);
  const nav=useCallback((id:string)=>{setTab(id);setShowMore(false);},[]);
  const openAsset=useCallback((asset:any,dest='trading')=>{
    if(asset){
      // Force state update even for same asset (triggers re-render)
      setActiveAsset(null);
      setTimeout(()=>{
        setActiveAsset({...asset, _ts: Date.now()});
        try{sessionStorage.setItem('tg_sel_asset',JSON.stringify(asset));}catch{}
      },0);
    }
    nav(dest);
  },[nav]);

  // Open the PnL calculator with asset prefilled
  const openPnL = useCallback((asset:any) => {
    if (asset) {
      // Detect asset type from asset.t or asset.category
      const detectType = (a:any) => {
        const t = a?.t || a?.type || a?.category || '';
        if (t === 'coin' || t === 'crypto')      return 'crypto';
        if (t === 'krstock' || t === 'kr_stock') return 'kr_stock';
        if (t === 'stock' || t === 'us_stock')   return 'us_stock';
        if (t === 'etf')                          return 'etf';
        if (t === 'commodity')                    return 'commodity';
        // Heuristic: 6-digit code → KR stock, all-letters → US stock
        if (/^\d{6}$/.test(a?.id || '')) return 'kr_stock';
        if (/^[A-Z]{1,5}$/.test(a?.id || '')) return 'us_stock';
        return 'crypto';
      };
      setPnlPrefill({
        assetName:    asset.nameKr || asset.name || asset.id,
        assetType:    detectType(asset),
        symbol:       asset.sym || asset.id,
        currentPrice: asset.p || asset.price || 0,
        side:         'long',
        isFutures:    false,
        fxRate:       1375,
      });
    }
    nav('pnl');
  }, [nav]);
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
  // Price update handled by useLivePrices hook

  const allTabs=[...BTABS,...MTABS];
  const TAB_DESC:Record<string,string>={
    home:'전체 요약을 한눈에 봐요',
    watchlist:'관심 종목을 모아봐요',
    market:'실시간 코인·주식 시세를 봐요',
    trading:'직접 사고팔아요 (수동 매매)',
    auto:'AI가 대신 자동으로 거래해요',
    strategies:'나만의 매매 규칙을 만들어요',
    fear_dca:'공포일 때 분할 매수하는 전략',
    seasonality:'계절·시기별 시장 흐름을 봐요',
    backtest:'과거 데이터로 전략을 테스트해요',
    pine_guide:'트레이딩뷰 전략 가져오는 법',
    news:'최신 코인·주식 뉴스를 봐요',
    portfolio:'내 보유 자산을 관리해요',
    risk_settings:'손실 한도·리스크를 설정해요',
    history:'지난 매매 기록을 봐요',
    accounts:'거래소 API를 연결해요',
    manual_accounts:'수동으로 자산을 기록해요',
    alerts:'가격·신호 알림을 받아요',
    academy:'투자 기초를 배워요',
    settings:'앱 설정을 바꿔요',
    analysis:'AI 시장 분석을 봐요',
  };
  const unreadCount=0; // TODO: connect to real alert count

  const renderPage=useCallback(()=>{
    const p={prices,currency,lang,onNav:nav};
    try {
      switch(tab) {
        case 'home':         return <HomePageComp {...p} onOpenAsset={openAsset}/>;
        case 'watchlist':    return <WatchlistPage prices={prices} currency={currency} onNav={nav} onOpenAsset={openAsset}/>;
        case 'market':       return <MarketPageComp prices={prices} onNav={nav} currency={currency} onOpenAsset={openAsset} onOpenPnL={openPnL}/>;
        case 'trading':      return <TradingPageComp key={activeAsset?.id||'trading'} prices={prices} currency={currency} activeAsset={activeAsset} onOpenPnL={openPnL}/>;
        case 'auto':         return <AutoPageComp onNav={nav} currency={currency} onOpenAsset={openAsset}/>;
        case 'strategies':   return <StrategyBuilderPage onNav={nav}/>;
        case 'risk_settings':return <RiskSettingsPage/>;
        case 'season':       return <SeasonDashboard/>;
        case 'portfolio':    return <PortfolioPageComp prices={prices} currency={currency} onOpenAsset={openAsset}/>;
        case 'history':      return <HistoryPage/>;
        case 'backtest':     return <BacktestPage/>;
        case 'ai':           return <AIPageComp prices={prices} currency={currency} onOpenAsset={openAsset}/>;
        case 'academy':      return <AcademyPage/>;
        case 'posters':      return <PosterLibrary/>;
        case 'safety':       return <SafetyDashboard/>;
        case 'hub':          return <HubDashboard currency={currency} onOpenAsset={openAsset}/>;
        case 'news':         return <NewsPage currency={currency} onOpenAsset={openAsset}/>;
        case 'alerts':       return <AlertsPage prices={prices} onNav={nav} onOpenAsset={openAsset}/>;
        case 'social':       return <SocialPage/>;
        case 'accounts':     return <ExchangeConnectPage/>;
        case 'manual_accounts': return <ManualAccountsPage/>;
        case 'fear_dca':     return <FearDcaPage/>;
        case 'menu_hub':     return <MenuHubPage onNav={nav}/>;
        case 'pine_guide':   return <PineGuidePage/>;
        case 'seasonality':  return <SeasonalityPage/>;
        case 'hub_accounts': return <HubAccountsPage/>;
        case 'ai_portfolio': return <AIPortfolioPage/>;
        case 'dca':          return <DCAPage/>;
        case 'dividends':    return <DividendCalendarPage/>;
        case 'funding':      return <FundingPage currency={currency}/>;
        case 'pnl':         return <PnLCalculatorPage currency={currency} prefill={pnlPrefill}/>;
        case 'heatmap':      return <div><div style={{fontWeight:800,fontSize:15,color:T.txt,marginBottom:12}}>🌈 자산 히트맵</div><Heatmap prices={prices}/></div>;
        case 'scanner':      return <ScannerPage prices={prices} currency={currency} onOpenAsset={openAsset}/>;
        case 'clock':        return <div style={{padding:'4px 0'}}><React.Suspense fallback={null}><WorldClock/></React.Suspense></div>;
        case 'search':       return <SearchPage prices={prices} currency={currency} onOpenAsset={openAsset}/>;
        case 'review':       return <JournalReviewPage/>;
        case 'autobot':      return <AutoBotLabPage/>;
        case 'groups':       return <WatchGroupsPage prices={prices} currency={currency} onOpenAsset={openAsset}/>;
        case 'paper':        return <PaperTradingPage prices={prices} onOpenAsset={openAsset}/>;
        case 'paper':        return <PaperTradingPage prices={prices} currency={currency} onOpenAsset={openAsset}/>;
        case 'diagnostics':  return <DiagnosticsPage/>;
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
        case 'calendar':     return <EconCalendarPage lang={lang}/>;
        case 'briefing':     return <BriefingPage prices={prices} onOpenAsset={openAsset}/>;
        case 'tax':          return <TaxPage currency={currency}/>;
        case 'growth':       return <GrowthPage/>;
        case 'admin':        return isAdminUser ? <AdminPageComp/> : <HomePageComp {...p}/>;
        default:             return <HomePageComp {...p}/>;
      }
    } catch(e) {
      console.error('[renderPage]', tab, e);
      return <div style={{padding:'24px 16px',textAlign:'center',color:'#EF4444'}}>
        <div style={{marginBottom:8,display:'flex',justifyContent:'center'}}><TriangleAlert size={28} strokeWidth={2.2}/></div>
        <div style={{fontWeight:700,marginBottom:4}}>페이지 오류</div>
        <div style={{fontSize:11,color:'#94A3B8',marginBottom:12}}>{String(e)}</div>
        <button onClick={()=>nav('home')} style={{background:'#2563EB',color:'#fff',border:'none',borderRadius:10,padding:'10px 20px',fontWeight:700,cursor:'pointer'}}>홈으로</button>
      </div>;
    }
  },[tab,prices,nav,currency,lang,setLang,setCurrency,isAdminUser,activeAsset,openAsset,openPnL,pnlPrefill]);

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
      {/* 백그라운드 자동매매 엔진 (활성 전략만 60초마다 평가) */}
      <AutoTradeEngine/>
      <ApiHealthMonitor/>
      {!onboarded&&<Onboarding onDone={(l,c)=>{setLang(l);setCurrency(c);setOnboarded(true);sS('tg_ob','1');sS('tg_lang',l);sS('tg_cur',c);}}/>}
      <div suppressHydrationWarning className="aw" style={{background:T.bg,minHeight:'-webkit-fill-available' as any,color:T.txt}}>

        {/* PC Sidebar */}
        <div className="sb" style={{display:'none',padding:'12px 0'}}>
          <div style={{padding:'14px 16px 12px',borderBottom:`1px solid ${T.border}`,marginBottom:6}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <div style={{width:30,height:30,borderRadius:9,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:14,color:'#fff'}}>T</div>
              <div style={{fontWeight:900,fontSize:15,letterSpacing:-0.5}}>TRAIGO</div>
              <div style={{marginLeft:'auto'}}><Dot c={T.grn}/></div>
            </div>
          </div>
          <button onClick={()=>nav('menu_hub')} style={{display:'flex',alignItems:'center',gap:10,width:'100%',padding:'11px 16px',margin:'2px 0 6px',background:tab==='menu_hub'?T.acg:T.acc+'15',color:tab==='menu_hub'?T.acl:T.acl,border:'none',borderRadius:0,cursor:'pointer',fontSize:13,fontWeight:800,textAlign:'left'}}>
            <span style={{width:20,display:'inline-flex',alignItems:'center',justifyContent:'center'}}><SearchIc size={16} strokeWidth={2.4}/></span>전체 메뉴 · 검색
          </button>
          {(()=>{
            const find=(id:string)=>allTabs.find(t=>t.id===id);
            const groups:{title:string;ids:string[]}[]=[
              {title:'',ids:['home','watchlist','market']},
              {title:'거래',ids:['trading','auto','strategies','fear_dca','season']},
              {title:'분석',ids:['backtest','pine_guide','seasonality','news','analysis']},
              {title:'관리',ids:['portfolio','risk_settings','history','accounts','manual_accounts','alerts']},
              {title:'기타',ids:['academy','settings']},
            ];
            return groups.map((g,gi)=>(
              <div key={gi}>
                {g.title&&<div style={{padding:'10px 16px 4px',color:T.muted,fontSize:9,fontWeight:800,letterSpacing:1,textTransform:'uppercase'}}>{g.title}</div>}
                {g.ids.map(id=>{ const t2=find(id); if(!t2)return null; const Ic=t2.Icon;
                  return (
                    <button key={id} onClick={()=>nav(id)} title={TAB_DESC[id]||''} style={{display:'flex',alignItems:'center',gap:10,width:'100%',padding:'9px 16px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.sub,border:'none',borderLeft:`3px solid ${tab===id?T.acl:'transparent'}`,cursor:'pointer',fontSize:13,fontWeight:tab===id?700:500,textAlign:'left'}}>
                      <span style={{width:20,display:'inline-flex',alignItems:'center',justifyContent:'center'}}><Ic size={16} strokeWidth={2.2}/></span>{t2.label}
                      {id==='alerts'&&unreadCount>0&&<span style={{background:T.red,color:'#fff',borderRadius:99,padding:'0 5px',fontSize:9,marginLeft:'auto',fontWeight:700}}>{unreadCount}</span>}
                    </button>
                  );
                })}
              </div>
            ));
          })()}
          <div style={{marginTop:'auto',padding:'12px 14px',borderTop:`1px solid ${T.border}`}}>
            <div style={{background:T.prp+'20',border:`1px solid ${T.prp}40`,borderRadius:10,padding:'8px 12px'}}>
              <div style={{color:T.prp,fontWeight:700,fontSize:11,display:'flex',alignItems:'center',gap:6}}><Bot size={12} strokeWidth={2.2}/> 모의투자 모드</div>
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
              <div style={{display:'flex',alignItems:'center',gap:3,background:priceStatus==='live'?'rgba(16,185,129,.12)':priceStatus==='mock'?'rgba(245,158,11,.12)':'rgba(239,68,68,.12)',border:`1px solid ${priceStatus==='live'?'rgba(16,185,129,.3)':priceStatus==='mock'?'rgba(245,158,11,.3)':'rgba(239,68,68,.3)'}`,borderRadius:20,padding:'2px 7px'}}>
                <Dot c={priceStatus==='live'?T.grn:priceStatus==='mock'?T.ylw:T.red}/><span style={{color:priceStatus==='live'?T.grn:priceStatus==='mock'?T.ylw:T.red,fontSize:9,fontWeight:700}}>{priceStatus==='live'?'LIVE':priceStatus==='mock'?'MOCK':'ERR'}</span>
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
              <button onClick={()=>nav('settings')} className="hdr-badge" style={{background:T.acg,border:`1px solid ${T.border}`,borderRadius:20,padding:'2px 8px',cursor:'pointer',fontSize:10,color:T.acl,fontWeight:700,display:'flex',alignItems:'center',gap:3}}>
                <Globe size={11} strokeWidth={2.4}/>
                <span style={{textTransform:'uppercase'}}>{lang.split('-')[0]}</span>
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
                <span key={i} style={{color:a.c>=0?T.grn:T.red,fontSize:10,padding:'0 12px',fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',fontWeight:500}}>
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
          <div className="page-content" style={{padding:'12px 12px calc(var(--nav-h) + 20px)'}}>
            <ErrorBoundary onHome={() => nav('home')}>
              {renderPage()}
            </ErrorBoundary>
          </div>

          {/* Bottom Nav */}
          <div className="bottom-nav" style={{display:"flex",alignItems:"stretch"}}>
            {BTABS.map(t2=>{
              const Ic = t2.Icon;
              const active = tab === t2.id;
              return (
                <button key={t2.id} onClick={()=>nav(t2.id)} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:3,background:'transparent',border:'none',cursor:'pointer',padding:'6px 2px',minHeight:48,touchAction:'manipulation'}}>
                  <Ic size={20} strokeWidth={active?2.4:2} color={active?T.acl:T.muted}/>
                  <div style={{fontSize:9,fontWeight:700,color:active?T.acl:T.muted}}>{t2.label}</div>
                  {active&&<div style={{width:16,height:2,borderRadius:1,background:T.acl}}/>}
                </button>
              );
            })}
            <button onClick={()=>setShowMore(v=>!v)} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:3,background:'transparent',border:'none',cursor:'pointer',padding:'6px 2px',position:'relative',minHeight:48,touchAction:'manipulation'}}>
              {showMore
                ? <XIcon size={20} strokeWidth={2.4} color={T.acl}/>
                : <MoreHorizontal size={20} strokeWidth={2.2} color={T.muted}/>}
              <div style={{fontSize:9,fontWeight:700,color:showMore?T.acl:T.muted}}>더보기</div>
              {unreadCount>0&&<span style={{position:'absolute',top:2,right:12,background:T.red,color:'#fff',borderRadius:'50%',width:12,height:12,fontSize:8,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700}}>{unreadCount}</span>}
            </button>
          </div>

          {/* More Menu */}
          {showMore&&(
            <>
              <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:90}} onClick={()=>setShowMore(false)}/>
              <div className="kb-shrink" style={{position:'fixed',bottom:'calc(var(--nav-h) + 8px)',left:'50%',transform:'translateX(-50%)',width:'calc(100% - 24px)',maxWidth:456,background:T.surf,border:`1px solid ${T.border}`,borderRadius:20,padding:'12px 12px calc(12px + env(safe-area-inset-bottom,0px))',zIndex:150,boxShadow:'0 -8px 40px rgba(0,0,0,.6)',maxHeight:'70vh',overflowY:'auto'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,paddingLeft:4}}>
                  <span style={{color:T.muted,fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:.8}}>더보기</span>
                  <div style={{display:'flex',gap:4,background:T.alt,borderRadius:8,padding:3}}>
                    {([{v:true,l:'간단'},{v:false,l:'전체'}] as const).map(opt=>(
                      <button key={String(opt.v)} onClick={()=>{setSimpleMode(opt.v);try{localStorage.setItem('tg_simple_mode',String(opt.v));}catch{}}}
                        style={{padding:'5px 14px',borderRadius:6,border:'none',cursor:'pointer',fontSize:10,fontWeight:800,
                          background:simpleMode===opt.v?T.acc:'transparent',color:simpleMode===opt.v?'#fff':T.muted}}>
                        {opt.l}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  {(()=>{
                    const mGroups:{title:string;ids:string[]}[]=[
                      {title:'거래',ids:['strategies','fear_dca','season']},
                      {title:'분석',ids:['backtest','pine_guide','seasonality','news','analysis']},
                      {title:'관리',ids:['portfolio','risk_settings','history','accounts','manual_accounts','alerts']},
                      {title:'기타',ids:['academy','settings']},
                    ];
                    return mGroups.map((g,gi)=>{
                      const items=g.ids.map(id=>MTABS.find(t=>t.id===id)).filter(Boolean).filter((t2:any)=>!simpleMode||t2.core);
                      if(items.length===0) return null;
                      return (
                        <div key={gi}>
                          <div style={{display:'flex',alignItems:'center',gap:8,margin:'12px 2px 6px'}}>
                            <span style={{color:T.acl,fontSize:10,fontWeight:800,letterSpacing:1}}>{g.title}</span>
                            <div style={{flex:1,height:1,background:T.border}}/>
                          </div>
                          <div style={{display:'flex',flexDirection:'column',gap:6}}>
                            {items.map((t2:any)=>{
                              const Ic=t2.Icon; const active=tab===t2.id;
                              return (
                                <button key={t2.id} onClick={()=>nav(t2.id)} style={{background:active?T.acg:T.alt,border:`1px solid ${active?T.acl:T.border}`,borderRadius:12,padding:'12px 14px',display:'flex',alignItems:'center',gap:12,cursor:'pointer',position:'relative',touchAction:'manipulation',textAlign:'left',width:'100%'}}>
                                  <span style={{flexShrink:0,width:36,height:36,borderRadius:9,background:active?T.acl+'20':T.surf,display:'flex',alignItems:'center',justifyContent:'center'}}>
                                    <Ic size={18} strokeWidth={active?2.4:2.1} color={active?T.acl:T.sub}/>
                                  </span>
                                  <div style={{flex:1,minWidth:0}}>
                                    <div style={{color:active?T.acl:T.txt,fontSize:13,fontWeight:700}}>{t2.label}</div>
                                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>{TAB_DESC[t2.id]||''}</div>
                                  </div>
                                  {t2.id==='alerts'&&unreadCount>0&&<span style={{flexShrink:0,background:T.red,color:'#fff',borderRadius:'50%',width:18,height:18,fontSize:9,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700}}>{unreadCount}</span>}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
                {simpleMode && (
                  <div style={{color:T.muted,fontSize:9,textAlign:'center',marginTop:10,lineHeight:1.4}}>
                    핵심 기능만 표시 중 · '전체'를 누르면 모든 기능이 나타납니다
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* PC Right Panel */}
        <div className="rp" style={{display:'none'}}>
          <div style={{fontWeight:800,fontSize:13,color:T.txt,marginBottom:10,display:'flex',alignItems:'center',gap:6}}><Radio size={14} strokeWidth={2.2}/> 실시간 시세</div>
          {prices.slice(0,10).map((a,i)=>(
            <div key={a.id}
              onClick={()=>openAsset(a,'trading')}
              role="button" tabIndex={0}
              onKeyDown={(e)=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault();openAsset(a,'trading');} }}
              style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:i<9?`1px solid ${T.border}`:'none',cursor:'pointer'}}>
              <div style={{display:'flex',alignItems:'center',gap:6}}><Logo id={a.id} size={24} clr={a.clr} name={a.nameKr}/><div><div style={{color:T.txt,fontSize:11,fontWeight:600}}>{a.id}</div><div style={{color:T.muted,fontSize:9}}>{a.nameKr}</div></div></div>
              <div style={{textAlign:'right'}}><div style={{color:T.txt,fontSize:10,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',fontWeight:700}}>{cvt(a.p,currency)}</div><div style={{color:a.c>=0?T.grn:T.red,fontSize:10,fontWeight:700}}>{fmtPct(a.c)}</div></div>
            </div>
          ))}
          <div style={{marginTop:16,fontWeight:800,fontSize:13,color:T.txt,marginBottom:10,display:'flex',alignItems:'center',gap:6,cursor:'pointer'}} onClick={()=>nav('news')}><Newspaper size={14} strokeWidth={2.2}/> 뉴스 <span style={{marginLeft:'auto',color:T.acl,fontSize:10}}>전체 ›</span></div>
          {MOCK_NEWS.slice(0,3).map(n=>(
            <div key={n.id} onClick={()=>nav('news')} role="button" tabIndex={0}
              onKeyDown={(e)=>{ if(e.key==='Enter'){nav('news');} }}
              style={{padding:'8px 0',borderBottom:`1px solid ${T.border}`,cursor:'pointer'}}>
              <div style={{color:T.txt,fontSize:11,fontWeight:600,lineHeight:1.4,marginBottom:2}}>{n.title}</div>
              <div style={{color:T.muted,fontSize:9}}>{n.time} · {n.source}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
