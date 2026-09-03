'use client';
import { useTheme } from '@/lib/theme/useTheme';
import { MODE_LABEL, type ThemeMode } from '@/lib/theme/themeMode';
import { A } from '@/lib/theme/colors';
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Asset } from '@/types';
import { T, CURRENCIES, LANGS, I18N, RTL_LANGS } from '@/lib/constants';
import {
  toFeed, errorFeed, feedTitle, feedBadge, itemTime, itemSource,
  LOADING_FEED, type NewsFeed,
} from '@/lib/news/feed';
import { gS, sS, cvt, fmtPct } from '@/lib/utils';
import { ASSETS } from '@/data/assets';
import { ErrorBoundary } from '@/components/pages/ErrorBoundary';
import { Dot, Logo } from '@/components/pages/SharedUI';
import { useLivePrices, statusLabel } from '@/lib/api/hooks';
import type { LucideIcon } from 'lucide-react';
import {
  Home as HomeIc, Star, BarChart3, Zap, Bot, Sprout,
  Wallet as Wallet2,
  Briefcase, NotebookPen, FlaskConical, MessageSquare, GraduationCap,
  Newspaper, Bell, Users, Landmark, Brain, CalendarClock, BadgeDollarSign,
  Link as LinkIc, ArrowLeftRight, Percent, Microscope, Building2, Sparkles,
  LineChart as LineChartIc, Bot as BotIc, BarChart2, Radio,
  TrendingUp, TrendingDown, CalendarRange, ChartLine, Receipt, Trophy, Rainbow,
  Search as SearchIc, Globe, Globe2, Workflow, FolderKanban, ClipboardList,
  Wallet,
  Stethoscope, Settings, CreditCard, Presentation, Shield, LayoutGrid,
  Terminal as TerminalIcon,
  MoreHorizontal, X as XIcon, TriangleAlert,
  User2, Link2, ShieldCheck, LogOut, Download, Sun, Moon, Clock, Cpu,
} from 'lucide-react';

// lucide-react 아이콘 타입
type IconComp = LucideIcon;

// ── Static imports (small/critical for first paint) ──────────
import PosterLibrary from '@/components/PosterLibrary';
import AssetDetailModal from '@/components/AssetDetailModal';
import ConfirmHost from '@/components/ConfirmHost';
import LoginModal from '@/components/LoginModal';
import SafetyDashboard from '@/components/SafetyDashboard';
import SeasonDashboard from '@/components/SeasonDashboard';
import HubDashboard from '@/components/HubDashboard';

// ── Dynamic imports (lazy-loaded, eliminates TDZ in bundle) ──
import dynamic from 'next/dynamic';

const HomePageComp    = dynamic(() => import('@/components/pages/HomePage'),    { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const MarketPageComp  = dynamic(() => import('@/components/pages/MarketPage'),  { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const WatchlistPage   = dynamic(() => import('@/components/pages/WatchlistPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const WalletPageComp = dynamic(() => import('@/components/pages/WalletPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const PortfolioPageComp = dynamic(() => import('@/components/pages/PortfolioPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const TradingPageComp = dynamic(() => import('@/components/pages/TradingPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const AutoPageComp    = dynamic(() => import('@/components/pages/AutoPage'),    { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const StrategyBuilderPage = dynamic(() => import('@/components/pages/StrategyBuilderPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const RiskSettingsPage = dynamic(() => import('@/components/pages/RiskSettingsPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const AutoTradeEngine = dynamic(() => import('@/components/AutoTradeEngine'), { ssr: false });
const ApiHealthMonitor = dynamic(() => import('@/components/ApiHealthMonitor'), { ssr: false });
const AIPageComp      = dynamic(() => import('@/components/pages/AIPage'),      { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const NewsPage        = dynamic(() => import('@/components/pages/NewsPage'),    { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const AlertsPage      = dynamic(() => import('@/components/pages/AlertsPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const HistoryPage     = dynamic(() => import('@/components/pages/HistoryPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const BacktestPage    = dynamic(() => import('@/components/pages/BacktestPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const AcademyPage     = dynamic(() => import('@/components/pages/AcademyPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const ScannerPage     = dynamic(() => import('@/components/pages/ScannerPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const SettingsPage    = dynamic(() => import('@/components/pages/SettingsPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const SocialPage      = dynamic(() => import('@/components/pages/SocialPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const AccountsPage    = dynamic(() => import('@/components/pages/AccountsPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const HubAccountsPage = dynamic(() => import('@/components/pages/HubAccountsPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const ManualAccountsPage = dynamic(() => import('@/components/pages/ManualAccountsPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const FearDcaPage = dynamic(() => import('@/components/pages/FearDcaPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>로딩 중...</div> });
import { nextStack, topmost, historyDelta } from '@/lib/nav/overlayStack';
import type { Command } from '@/lib/commands/types';
import { useHotkeys } from '@/lib/commands/useHotkeys';
import { DEFAULT_PROFILE } from '@/lib/commands/keymap';
import { buildCommands } from '@/lib/commands/registry';
import { MENU } from '@/lib/menuItems';
import {
  loadLeftMode, loadRightMode, loadRailWidth,
  saveLeftMode, saveRightMode, saveRailWidth,
  sidebarWidthFor, clampRailWidth, railWidthFor,
} from '@/lib/ui/panelPrefs';
import { shouldCollapseNewsRail } from '@/lib/ui/tradingLayout';
import {
  nextLeftMode, nextRightMode, RAIL_DEFAULT,
  type LeftMode, type RightMode,
} from '@/lib/ui/panelPrefs';
import PanelToggle from '@/components/shell/PanelToggle';
const RailResizer = dynamic(() => import('@/components/shell/RailResizer'), { ssr: false });
import { notifyError, notifyInfo } from '@/lib/notify/center';
// 팔레트는 열릴 때까지 필요 없다. 앱 첫 로드에 끼우면 Ctrl+K를 한 번도
// 누르지 않는 사용자도 그 무게를 같이 받는다.
const CommandPalette = dynamic(() => import('@/components/CommandPalette'),{ ssr: false });
const ShortcutHelp = dynamic(() => import('@/components/ShortcutHelp'),{ ssr: false });
const MenuHubPage = dynamic(() => import('@/components/pages/MenuHubPage'),{ ssr: false });
const TerminalTab = dynamic(() => import('@/components/terminal/TerminalTab'),{ ssr: false });
const AiUsagePage = dynamic(() => import('@/components/pages/AiUsagePage'),{ ssr: false });
const PineGuidePage = dynamic(() => import('@/components/pages/PineGuidePage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>로딩 중...</div> });
const SeasonalityPage = dynamic(() => import('@/components/pages/SeasonalityPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>로딩 중...</div> });
const AIPortfolioPage = dynamic(() => import('@/components/pages/AIPortfolioPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const DCAPage         = dynamic(() => import('@/components/pages/DCAPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const DividendCalendarPage = dynamic(() => import('@/components/pages/DividendCalendarPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const FundingPage     = dynamic(() => import('@/components/pages/FundingPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const TradFiPage      = dynamic(() => import('@/components/pages/TradFiPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const RealtimePage    = dynamic(() => import('@/components/pages/RealtimePage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const AnalyticsPage   = dynamic(() => import('@/components/pages/AnalyticsPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const SubscriptionPage = dynamic(() => import('@/components/pages/SubscriptionPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const EconCalendarPage = dynamic(() => import('@/components/pages/EconCalendarPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const BriefingPage    = dynamic(() => import('@/components/pages/BriefingPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const TaxPage         = dynamic(() => import('@/components/pages/TaxPage'),    { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const GrowthPage      = dynamic(() => import('@/components/pages/GrowthPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const WunderPage      = dynamic(() => import('@/components/pages/WunderPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const HedgeOSPage     = dynamic(() => import('@/components/pages/HedgeOSPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const ChartTab        = dynamic(() => import('@/components/pages/ChartTab'),   { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const AnalysisHubPage = dynamic(() => import('@/components/pages/AnalysisHubPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const IntelligencePage = dynamic(() => import('@/components/IntelligencePage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const PnLCalculatorPage = dynamic(() => import('@/components/PnLCalculator'),  { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const DiagnosticsPage    = dynamic(() => import('@/components/pages/DiagnosticsPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const OpsPage            = dynamic(() => import('@/components/pages/OpsPage'), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const SearchPage         = dynamic(() => import('@/components/pages/SearchPage'),       { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const JournalReviewPage  = dynamic(() => import('@/components/pages/JournalReviewPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const AutoBotLabPage     = dynamic(() => import('@/components/pages/AutoBotLabPage'),   { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const WatchGroupsPage    = dynamic(() => import('@/components/pages/WatchGroupsPage'),  { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const PaperTradingPage   = dynamic(() => import('@/components/pages/PaperTradingPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const ExchangeConnectPage = dynamic(() => import('@/components/ExchangeConnectPage'),{ ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const AdminPageComp   = dynamic(() => import('@/components/pages/AdminPage'),  { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const WorldClock = dynamic(() => import('@/components/pages/SharedUI').then(m => ({ default: m.WorldClock })), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });
const Heatmap = dynamic(() => import('@/components/pages/SharedUI').then(m => ({ default: m.Heatmap })), { ssr: false, loading: () => <div style={{padding:'40px 20px',textAlign:'center',color:'var(--t-muted)',fontSize:13}}>⏳ 로딩 중...</div> });


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
        <div style={{display:'flex',gap:8,marginTop:16,justifyContent:'center'}}>{[0,1,2].map(i=><div key={i} style={{width:step===i?28:8,height:7,borderRadius:4,background:step===i?T.acl:T.border,transition:'all .3s'}}/>)}</div>
        <div style={{color:T.txt,fontWeight:800,fontSize:17,marginTop:14,display:'flex',alignItems:'center',justifyContent:'center',gap:7}}>
          <Globe2 size={18} strokeWidth={2.2} color={T.acl}/>
          <span>{step===0 ? t.title : step===1 ? t.currencyTitle : '이렇게 시작해요'}</span>
        </div>
      </div>
      <div style={{flex:1,overflowY:'auto',padding:'0 20px 8px',width:'100%',maxWidth:560,margin:'0 auto'}}>
        {step===0&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>{LANGS.map(l=>(
          <button key={l.id} onClick={()=>pick(l.id)}
            dir={l.id === 'ar' ? 'rtl' : 'ltr'}
            style={{background:sl===l.id?A(T.acc,'25'):T.card,border:`2px solid ${sl===l.id?T.acl:T.border}`,borderRadius:16,padding:'16px 12px',cursor:'pointer',textAlign:'center',minHeight:64,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:4}}>
            <div style={{color:sl===l.id?T.acl:T.txt,fontWeight:700,fontSize:15,lineHeight:1.2,wordBreak:'keep-all'}}>{l.native}</div>
            {l.native !== l.label && <div style={{color:T.muted,fontSize:9}}>{l.label}</div>}
          </button>
        ))}</div>}
        {step===1&&<div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>{Object.entries(CURRENCIES).map(([code,cur])=><button key={code} onClick={()=>setSc(code)} style={{background:sc===code?A(T.acc,'25'):T.card,border:`2px solid ${sc===code?T.acl:T.border}`,borderRadius:12,padding:'10px 4px',cursor:'pointer',textAlign:'center'}}><div style={{color:sc===code?T.acl:T.txt,fontWeight:800,fontSize:18}}>{cur.symbol}</div><div style={{color:T.muted,fontSize:9,marginTop:1}}>{code}</div></button>)}</div>}
        {step===2&&<div style={{display:'flex',flexDirection:'column',gap:12}}>
          {[
            {n:'1',t:'모의투자 (MOCK)',d:'가상 자금으로 안전하게 연습해요. 지금 바로 시작할 수 있어요.',c:T.grn,badge:'지금 시작'},
            {n:'2',t:'테스트넷 연결',d:'거래소 테스트 환경에 연결해 실전처럼 연습해요. (가짜 돈)',c:T.ylw,badge:'다음 단계'},
            {n:'3',t:'실전 투자',d:'실제 자금으로 거래해요. 로그인 후 API 연결이 필요해요.',c:T.acl,badge:'로그인 후'},
          ].map(m=>(
            <div key={m.n} style={{display:'flex',gap:12,alignItems:'flex-start',background:T.card,border:`1px solid ${m.c}30`,borderRadius:16,padding:'14px 16px'}}>
              <div style={{flexShrink:0,width:32,height:32,borderRadius:'50%',background:m.c+'20',color:m.c,fontWeight:900,fontSize:15,display:'flex',alignItems:'center',justifyContent:'center'}}>{m.n}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
                  <span style={{color:T.txt,fontWeight:800,fontSize:14}}>{m.t}</span>
                  <span style={{color:m.c,background:m.c+'18',fontSize:9,fontWeight:800,padding:'2px 7px',borderRadius:5}}>{m.badge}</span>
                </div>
                <div style={{color:T.muted,fontSize:11,lineHeight:1.5}}>{m.d}</div>
              </div>
            </div>
          ))}
          <div style={{color:T.muted,fontSize:11,textAlign:'center',marginTop:2}}>먼저 모의투자로 부담 없이 둘러보세요.</div>
        </div>}
      </div>
      <div style={{padding:'14px 20px 36px',flexShrink:0,borderTop:`1px solid ${T.border}`,background:T.bg,width:'100%',maxWidth:560,margin:'0 auto'}}>
        <button onClick={()=>{if(step<2)setStep(step+1);else onDone(sl,sc);}} style={{width:'100%',padding:'16px',background:`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:16,fontWeight:800,fontSize:16,cursor:'pointer',marginBottom:10}}>{step<2 ? t.next : '모의투자로 시작하기'}</button>
        <button onClick={()=>onDone(sl,sc==='KRW'&&sl!=='ko'?'USD':sc)} style={{width:'100%',padding:'10px',background:'transparent',color:T.muted,border:'none',cursor:'pointer',fontSize:12}}>{t.skip}</button>
      </div>
    </div>
  );
}

/* ── WorldClock ── */

// ── 하단 탭 ──
//
// **지갑을 하단에 둔다.** 홈에 계좌 정보를 다 몰아넣으면 홈이 관리자
// 화면이 된다. 바이낸스가 Assets를 따로 두는 이유와 같다.
//
// 자리를 만들려고 '왓치'와 '시즌전략'을 뺐다 — 둘 다 지운 것이 아니라
// 더보기에서 그대로 열린다(MTABS). 매일 보는 것과 가끔 보는 것을 같은
// 줄에 두면, 매일 보는 것이 밀린다.
const BTABS: { id: string; label: string; Icon: IconComp }[] = [
  {id:'home',     label:'홈',   Icon: HomeIc},
  {id:'market',   label:'시장', Icon: BarChart3},
  {id:'trading',  label:'매매', Icon: Zap},
  {id:'auto',     label:'자동', Icon: Bot},
  {id:'wallet',   label:'지갑', Icon: Wallet2},
  // '더보기'는 여기 없다. 하단바 마지막 칸은 BTABS.map 뒤에 따로 그려지는
  // 시트 토글이고, 여는 화면이 아니라 겹쳐 뜨는 층이다. 여기에 넣으면
  // 더보기 버튼이 둘이 되고, 그중 하나는 renderPage에 case가 없어
  // 빈 화면으로 간다. **화면이 아닌 것을 화면 목록에 넣지 않는다.**
];
const MTABS: { id: string; label: string; Icon: IconComp; core?: boolean }[] = [
  {id:'wallet',       label:'지갑',       Icon: Wallet2, core: true},
  {id:'watchlist',    label:'왓치리스트', Icon: Star, core: true},
  {id:'season',       label:'시즌전략',   Icon: Sprout},
  {id:'ai_usage',     label:'AI 관리센터', Icon: Cpu},
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
  {id:'ops',          label:'운영',       Icon: TerminalIcon},
  {id:'settings',     label:'설정',       Icon: Settings, core: true},
  {id:'subscription', label:'구독',       Icon: CreditCard},
  {id:'posters',      label:'강의',       Icon: Presentation},
  {id:'safety',       label:'안전제어',   Icon: Shield},
  {id:'hub',          label:'허브',       Icon: LayoutGrid},
];

export default function App() {
  const [mounted, setMounted] = useState(false);
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  // 밝음 → 어두움 → 시간에 맞춰 → 밝음. 셋뿐이라 목록을 따로 두지 않는다.
  const cycleTheme=useCallback(()=>{
    const order:ThemeMode[]=['light','dark','auto'];
    setThemeMode(order[(order.indexOf(themeMode)+1)%order.length]);
  },[themeMode,setThemeMode]);
  const [tab,setTab]=useState('home');
  const [paletteOpen,setPaletteOpen]=useState(false);
  const [helpOpen,setHelpOpen]=useState(false);
  // ── 딥링크 ──
  // 이 앱은 한 페이지 안에서 tab 상태로 화면을 바꾸므로 URL이 없다.
  // 그래서 Pro 터미널 같은 별도 경로에서 특정 화면으로 돌아올 방법이
  // 없었다. ?tab=xxx를 읽어 그 화면으로 연다.
  useEffect(()=>{
    try{
      const t=new URLSearchParams(window.location.search).get('tab');
      if(t) setTab(t);
    }catch{}
  },[]);

  // ── 주소창 ↔ 화면 동기화 ──
  //
  // 화면을 바꾸면 주소도 바뀐다. 그래야 새로고침해도 보던 화면이 나오고,
  // 링크를 보내면 상대도 같은 화면을 보고, 뒤로가기가 앱을 나가는 대신
  // 이전 화면으로 간다.
  //
  // setTab이 아니라 tab 값을 보고 있다. nav() 말고도 상태를 바꾸는 길이
  // 여럿이라(로그인 후 대기 동작, 자산 열기 등) 호출부마다 붙이면 언젠가
  // 하나가 빠지고, 그 화면만 주소가 안 따라온다.
  //
  // 홈은 파라미터 없이 '/'로 둔다 — 첫 화면 주소에 ?tab=home이 붙어 있으면
  // 공유했을 때 앱 주소가 아니라 무슨 딥링크처럼 보인다.
  const urlSyncFirst=useRef(true);
  useEffect(()=>{
    // 첫 실행은 건너뛴다. 이 시점의 주소가 진실이고 위 딥링크 훅이 화면을
    // 거기에 맞추는 중이다. 여기서 밀어 넣으면 그 딥링크를 지운다.
    if(urlSyncFirst.current){ urlSyncFirst.current=false; return; }
    try{
      const url=new URL(window.location.href);
      const cur=url.searchParams.get('tab');
      const want=tab==='home'?null:tab;
      if(cur===want) return;              // 이미 맞으면 기록을 남기지 않는다
      if(want) url.searchParams.set('tab',want); else url.searchParams.delete('tab');
      // 지금 맨 위가 모달 표식이면 쌓지 말고 **덮어쓴다**.
      // 시트에서 항목을 누르면 화면 전환과 시트 닫힘이 같은 렌더에서 일어난다.
      // 여기서 쌓고 아래 훅이 back()으로 되감으면 방금 누른 화면이 취소되고
      // 이전 화면으로 돌아간다 — 메뉴가 아예 안 먹는 것처럼 보인다.
      const onOverlay=(window.history.state as any)?.overlay===true;
      if(onOverlay) window.history.replaceState({tab},'',url.toString());
      else window.history.pushState({tab},'',url.toString());
    }catch{}
  },[tab]);

  // 뒤로/앞으로 처리는 오버레이 상태가 다 선언된 뒤에 있다.
  // 모달이 열려 있으면 화면을 바꾸는 대신 모달부터 닫아야 하는데,
  // 그 판단을 하려면 모달 상태를 알아야 한다.
  // ── Admin role (loaded from Supabase profiles after mount) ──
  const [userRole,setUserRole]=useState<string|null>(null);
  const [authUser,setAuthUser]=useState<any>(null);
  const [loginOpen,setLoginOpen]=useState(false);
  const [loginReason,setLoginReason]=useState<string>('');
  const [profileOpen,setProfileOpen]=useState(false);
  const pendingAction=useRef<null|(()=>void)>(null);

  // 로그인 필요 기능 게이팅: 로그인돼 있으면 실행, 아니면 모달 (성공 후 자동 복귀)
  const requireAuth=useCallback((reason:string,action:()=>void)=>{
    if(authUser){ action(); return; }
    setLoginReason(reason); pendingAction.current=action; setLoginOpen(true);
  },[authUser]);

  // auth 상태 로드 + 구독
  useEffect(()=>{
    let unsub:any;
    (async()=>{
      try{
        const { sbGetSession, sbOnAuthStateChange }=await import('@/lib/supabase');
        const sess=await sbGetSession();
        if(sess?.user) setAuthUser(sess.user);
        const r=await sbOnAuthStateChange((profile:any)=>{ setAuthUser(profile); });
        unsub=r?.unsubscribe || r;
      }catch{}
    })();
    return ()=>{ try{ unsub&&unsub(); }catch{} };
  },[]);
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
      // 빌드 id를 붙여 부른다. 파일 내용이 같아도 URL이 달라지면 브라우저가
      // 새 서비스워커로 보고 설치하고, sw.js는 이 값으로 캐시 이름을 짓는다.
      // (public/sw.js 맨 위 주석 참조 — 손으로 버전을 올리던 것을 없앴다)
      navigator.serviceWorker.register(`/sw.js?v=${process.env.NEXT_PUBLIC_BUILD_ID || 'dev'}`,{scope:'/'})
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
  const { prices, status: priceStatus, source: priceSource, lastRealAt: priceRealAt, simSteps: priceSimSteps, liveIds: priceLiveIds } = useLivePrices(3000);
  const [showMore,setShowMore]=useState(false);

  /* ── PC 껍데기 (사이드바 · 오른쪽 레일) ─────────────────────
     상태는 여기 있지만 **판단은 여기 없다.** 조이기·기본값·저장 키는
     전부 lib/ui/panelPrefs에 있고 테스트가 붙어 있다. 이 자리는
     "값을 화면에 꽂는 곳"까지만 한다.

     서버 렌더에서는 localStorage가 없다. 기본값으로 그리고 붙은 뒤에
     읽는다 — 첫 그림과 두 번째 그림이 갈리면 리액트가 경고를 내고,
     사용자에게는 화면이 한 번 튀는 것으로 보인다. */
  const [leftMode,setLeftMode]   = useState<LeftMode>('expanded');
  const [rightMode,setRightMode] = useState<RightMode>('expanded');
  /* 자동 접기를 사용자가 되돌렸는가. 되돌렸으면 자동 판단은 물러난다. */
  const [railUserOpened,setRailUserOpened] = useState(false);
  const [railW,setRailW]         = useState<number>(RAIL_DEFAULT);
  const [viewportW,setViewportW] = useState<number>(1920);

  useEffect(()=>{
    setLeftMode(loadLeftMode());
    setRightMode(loadRightMode());
    setViewportW(window.innerWidth);
    setRailW(loadRailWidth());
  },[]);

  /* 창 크기가 바뀌면 저장된 폭을 **다시 조인다.**
     넓은 모니터에서 420으로 늘려 둔 사람이 노트북을 열었을 때 그 값을
     그대로 강제하면 본문이 400px가 된다. 저장값 자체는 건드리지
     않으므로 넓은 화면으로 돌아가면 원래 폭이 살아난다. */
  useEffect(()=>{
    const onResize=()=>setViewportW(window.innerWidth);
    window.addEventListener('resize',onResize);
    return()=>window.removeEventListener('resize',onResize);
  },[]);

  const sidebarW  = sidebarWidthFor(leftMode, viewportW);
  const railWNow  = clampRailWidth(railW, viewportW, sidebarW);

  /* ── 거래 탭에서는 뉴스 레일이 먼저 물러난다 ──
     공간 우선순위는 중앙 거래/차트 > 주문 > 종목 > 시세·뉴스다.
     그런데 레일이 300px를 먼저 가져가고 거래화면이 나머지를 나눠 쓰고
     있었다 — 1664 창에서 주문판이 301px가 된 직접 원인이다.

     **거래 탭일 때만** 판단한다. 다른 화면에서 접으면 이번 작업이
     건드리지 않기로 한 화면들이 같이 바뀐다. 사용자가 직접 펼치면
     그 선택이 이긴다 — 자동 판단이 사용자 조작을 덮으면 안 된다. */
  const railAutoCollapse = tab === 'trading'
    && rightMode === 'expanded'
    && !railUserOpened
    && shouldCollapseNewsRail(viewportW, sidebarW, railWNow);
  const effRightMode: RightMode = railAutoCollapse ? 'collapsed' : rightMode;
  const railCol   = railWidthFor(effRightMode, railWNow);

  const toggleLeft  = useCallback(()=>{ setLeftMode(m=>{ const n=nextLeftMode(m);  saveLeftMode(n);  return n; }); },[]);
  /* **보이는 상태를 뒤집는다.**
     자동으로 접힌 동안 `rightMode`는 여전히 'expanded'이고 화면만
     'collapsed'였다. 그래서 저장값을 뒤집으면 expanded→collapsed가 되어
     **한 번 눌러도 안 열리고 두 번 눌러야 열렸다.** 사용자가 보고 누른
     것은 '접힌 레일'이므로, 뒤집을 대상도 그 상태여야 한다. */
  const toggleRight = useCallback(()=>{
    setRailUserOpened(true);
    const n = nextRightMode(effRightMode);
    setRightMode(n); saveRightMode(n);
  },[effRightMode]);
  const commitRail  = useCallback((w:number)=>{ setRailW(w); saveRailWidth(w); },[]);

  /* ── 오른쪽 레일 뉴스도 서버에서 읽는다 ──
     홈과 이 레일이 같은 `MOCK_NEWS` 상수를 그리고 있었다. 한쪽만 고치면
     같은 거짓이 다른 화면에 남는다. 판정은 lib/news/feed 한 곳이다. */
  const [railFeed,setRailFeed]=useState<NewsFeed>(LOADING_FEED);
  useEffect(()=>{
    let alive=true;
    (async()=>{
      try{
        const r=await fetch('/api/news?action=latest&cat=general',{signal:AbortSignal.timeout(12000)});
        const j=await r.json().catch(()=>null);
        if(!alive) return;
        setRailFeed(r.ok ? toFeed(j) : errorFeed(`뉴스를 읽지 못했습니다 (HTTP ${r.status})`));
      }catch{ if(alive) setRailFeed(errorFeed()); }
    })();
    return()=>{alive=false;};
  },[]);
  const [simpleMode,setSimpleMode]=useState(()=>{ try { return localStorage.getItem('tg_simple_mode')==='true'; } catch { return false; } });
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
    // 실시간 USD/KRW 환율 갱신 (실패 시 캐시/폴백)
    import('@/lib/currency').then(m => m.refreshUsdKrw()).catch(()=>{});
  },[]);

  // 첫 진입 로그인 안내 — 온보딩 완료 + 비로그인 + 미표시 시 1회 (설정 안 들어가도 바로 보이게)
  useEffect(()=>{
    if(!onboarded) return;
    if(authUser) return;
    let seen=false; try{ seen=!!localStorage.getItem('tg_seen_login_v1'); }catch{}
    if(seen) return;
    const t=setTimeout(()=>{
      if(!authUser){ setLoginReason(''); pendingAction.current=null; setLoginOpen(true); try{localStorage.setItem('tg_seen_login_v1','1');}catch{} }
    }, 900);
    return ()=>clearTimeout(t);
  },[onboarded,authUser]);

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
  const [detailAsset,setDetailAsset]=useState<any>(null);
  const openDetail=useCallback((asset:any)=>{ if(asset) setDetailAsset(asset); },[]);
  const [pnlPrefill,setPnlPrefill]=useState<any>(null);

  // ── 뒤로가기로 모달 닫기 ──
  //
  // 모달이 열린 채 뒤로가기를 누르면 모달만 닫혀야 한다. 화면까지 같이
  // 바뀌면 뒤로가기 한 번에 두 단계가 사라지고, 사용자는 자기가 어디서
  // 왔는지 잃는다. 모바일에서는 이게 기본 기대다.
  //
  // 방법: 모달이 열릴 때 주소는 그대로 둔 채 히스토리 자리만 하나 만든다.
  // 뒤로가기가 그 자리를 소비하면 화면은 그대로고 모달만 닫힌다.
  const overlays=useMemo(()=>[
    { id:'login',   open:loginOpen,       close:()=>{ setLoginOpen(false); pendingAction.current=null; } },
    { id:'profile', open:profileOpen,     close:()=>setProfileOpen(false) },
    { id:'detail',  open:!!detailAsset,   close:()=>setDetailAsset(null) },
    { id:'more',    open:showMore,        close:()=>setShowMore(false) },
    // 팔레트도 겹이다 — 뒤로가기가 팔레트만 닫고 화면은 그대로 둔다.
    { id:'palette', open:paletteOpen,     close:()=>setPaletteOpen(false) },
    { id:'help',    open:helpOpen,        close:()=>setHelpOpen(false) },
  ],[loginOpen,profileOpen,detailAsset,showMore,paletteOpen,helpOpen]);

  const stackRef=useRef<string[]>([]);
  const closedByPop=useRef(false);
  // 핸들러가 항상 최신 상태를 보게 한다. popstate 리스너는 한 번만 붙으므로
  // 값을 그대로 담으면 첫 렌더의 값에 갇힌다.
  const overlaysRef=useRef(overlays);
  overlaysRef.current=overlays;

  useEffect(()=>{
    const prev=stackRef.current;
    const next=nextStack(prev,overlays.filter(o=>o.open).map(o=>o.id));
    stackRef.current=next;
    const d=historyDelta(prev.length,next.length,closedByPop.current);
    closedByPop.current=false;
    try{
      if(d.action==='push'){
        // 주소는 바꾸지 않는다. 모달은 화면이 아니라 화면 위의 겹이다 —
        // 주소까지 바꾸면 그 링크를 공유했을 때 모달이 떠 있는 화면이 된다.
        for(let i=0;i<d.count;i++) window.history.pushState({ overlay:true },'',window.location.href);
      }else if(d.action==='back'){
        // X나 배경을 눌러 닫았다. 만들어 둔 자리를 치우지 않으면
        // 그 다음 뒤로가기가 아무 일도 안 하는 것처럼 보인다.
        //
        // 다만 맨 위가 아직 모달 표식일 때만 되감는다. 화면 전환과 함께
        // 닫힌 경우에는 위 훅이 표식을 이미 덮어썼으므로, 여기서 back()을
        // 부르면 방금 이동한 화면이 취소된다.
        if((window.history.state as any)?.overlay===true){
          for(let i=0;i<d.count;i++) window.history.back();
        }
      }
    }catch{}
  },[overlays]);

  // 뒤로/앞으로.
  //  · 모달이 열려 있으면 맨 위 것만 닫는다. 화면은 건드리지 않는다
  //  · 아니면 주소가 진실이고 화면이 따라간다. 이때 setTab이 위 주소
  //    동기화 훅을 다시 돌리지만 주소와 이미 같으므로 아무것도 쌓지 않는다
  useEffect(()=>{
    const onPop=()=>{
      try{
        const top=topmost(stackRef.current);
        if(top){
          closedByPop.current=true;
          overlaysRef.current.find(o=>o.id===top)?.close();
          return;
        }
        setTab(new URLSearchParams(window.location.search).get('tab')||'home');
      }catch{}
    };
    window.addEventListener('popstate',onPop);
    return ()=>window.removeEventListener('popstate',onPop);
  },[]);

  // 로그인 필요 목적지 (거래소 연결·실전매매 관련). 비로그인 시 즉시 로그인 모달 → 성공 후 자동 이동.
  const LOGIN_REQUIRED_ROUTES=new Set(['accounts','exchange_connect','hub_accounts','manual_accounts']);
  // 이 앱 밖의 별도 라우트. setTab으로는 갈 수 없다 —
  // 여기 없으면 메뉴에 항목이 보여도 눌렀을 때 아무 일도 일어나지 않는다.
  // 매매 탭이 곧 터미널이므로 terminal은 여기 없다. 넣으면 같은 화면으로
  // 가는 길이 둘이 되고, 하나는 하단탭이 사라진 채로 열린다.
  const EXTERNAL_ROUTES:Record<string,string>={};
  const nav=useCallback((id:string)=>{
    const ext=EXTERNAL_ROUTES[id];
    if(ext){ setShowMore(false); if(typeof window!=='undefined') window.location.href=ext; return; }
    if(LOGIN_REQUIRED_ROUTES.has(id) && !authUser){
      setLoginReason('거래소 연결과 실전 매매는 로그인이 필요해요');
      pendingAction.current=()=>{setTab(id);setShowMore(false);};
      setLoginOpen(true);
      setShowMore(false);
      return;
    }
    setTab(id);setShowMore(false);
  },[authUser]);

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
  // ── 커맨드 실행 ──
  //
  // 레지스트리는 "무엇을 할지"만 선언하고(action.kind), 실제 동작은 여기서
  // 연결한다. 그래야 레지스트리와 매칭 규칙이 setTab이나 router를 모르는
  // 순수 코드로 남고, 테스트가 붙는다.
  //
  // 모르는 kind를 조용히 넘기지 않는 이유: 커맨드를 추가하고 배선을 잊으면
  // 팔레트에서 눌러도 아무 일이 없다. 그건 "고장"인데 화면에서는 "닫힘"으로
  // 보여서 원인을 못 찾는다.
  const runCommand=useCallback((cmd:Command)=>{
    switch(cmd.action.kind){
      case 'tab':
        nav(cmd.action.value);
        return;
      case 'href':
        if(typeof window!=='undefined') window.location.href=cmd.action.value;
        return;
      case 'symbol': {
        // id로 원본 자산을 찾아 넘긴다. {sym}만 만들어 보내면 가격·이름이
        // 없는 반쪽 객체가 되고, 상세 화면이 ₩0을 그린다 — 0원은 시세가
        // 아니라 고장이라는 것을 이 프로젝트에서 이미 겪었다.
        const found=(prices as any[])?.find(a=>a?.id===cmd.action.value);
        if(found) openAsset(found,'trading');
        else notifyError('종목을 찾지 못했습니다', cmd.label);
        return;
      }
      case 'invoke':
        if(cmd.action.value==='palette.open'){ setShowMore(false); setPaletteOpen(true); return; }
        if(cmd.action.value==='help.keys'){ setShowMore(false); setHelpOpen(true); return; }
        if(cmd.action.value==='theme.toggle'){ cycleTheme(); return; }
        if(cmd.action.value==='theme.auto'){ setThemeMode('auto'); return; }
        notifyError('아직 연결되지 않은 커맨드입니다', cmd.label);
        return;
      default:
        notifyError('알 수 없는 커맨드입니다', cmd.label);
    }
  },[nav,openAsset,cycleTheme,setThemeMode,prices]);

  // 팔레트에 넘길 종목. 한글 이름을 같이 실어야 'ㅅㅅㅈㅈ' → 삼성전자가
  // 된다 — 기호만 넘기면 초성 검색이 코인에만 통하고 국내 주식에는 통하지
  // 않는다. 정작 초성이 가장 필요한 쪽이 빠진다.
  const paletteSymbols=useMemo(
    ()=>(prices as any[])?.map(a=>({ id:a.id, sym:a.sym, nameKr:a.nameKr, name:a.name }))??[],
    [prices]);

  // 팔레트를 여는 창구가 단축키만이 아니다 — 더보기 시트의 검색 줄도 같은
  // 상태를 켠다. 겹을 둘 다 쌓으면 뒤로가기를 두 번 눌러야 하므로 시트는 닫는다.
  const openPalette=useCallback(()=>{
    setShowMore(false);
    setPaletteOpen(true);
  },[]);

  // ── 전역 단축키 ──
  //
  // 커맨드 레지스트리 위의 키맵이다. 키를 핸들러에 박지 않는 이유는
  // registry.ts에 적어 뒀다 — 창구마다 판단하면 위험 등급을 빼먹는다.
  const allCommands=useMemo(()=>buildCommands(MENU),[]);
  const lookupCommand=useCallback(
    (id:string)=>allCommands.find(c=>c.id===id)??null,[allCommands]);
  useHotkeys({
    profile: DEFAULT_PROFILE,
    lookup: lookupCommand,
    onRun: runCommand,
    // 확인이 필요한 커맨드는 첫 입력에 실행되지 않는다. 화면에 아무 표시가
    // 없으면 사용자는 단축키가 씹혔다고 생각하고 다시 누른다 — 그 두 번째가
    // 실행이 되므로, 무엇을 기다리는지 반드시 알려야 한다.
    onAsk: (cmd)=>notifyInfo('한 번 더 누르면 실행됩니다', cmd.label),
    // 팔레트가 열려 있으면 전역 단축키를 끈다. 팔레트는 자기 키(↑↓·Enter·Esc)를
    // 쓰는데 그 위에서 g·? 같은 것이 같이 터지면 두 곳이 동시에 반응한다.
    disabled: paletteOpen || helpOpen,
  });

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
    autobot:'돌아가는 자동매매 봇을 관리해요',
    paper:'가상 자금으로 연습 매매해요',
    season:'계절·이벤트 기반 전략을 봐요',
    scanner:'조건에 맞는 종목을 찾아줘요',
    review:'지난 매매를 AI가 분석해줘요',
    briefing:'오늘의 시장을 AI가 요약해줘요',
    calendar:'금리·고용 등 경제 일정을 봐요',
    ai_portfolio:'자산 비중을 다시 맞춰요',
    growth:'장기 적립·복리 계획을 세워요',
    dividends:'배당금·이자 일정을 관리해요',
    safety:'로그인·키 보안을 점검해요',
    diagnostics:'외부 연동 상태를 점검해요',
    ops:'명령 하나로 점검·배포·복구를 해요',
    posters:'투자 기초를 카드로 배워요',
    social:'다른 투자자 의견을 봐요',
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
    const p={prices,currency,lang,onNav:nav,authUser,onLogin:()=>{setLoginReason('');pendingAction.current=null;setLoginOpen(true);}};
    try {
      switch(tab) {
        case 'home':         return <HomePageComp {...p} onOpenAsset={openDetail}/>;
        case 'watchlist':    return <WatchlistPage prices={prices} currency={currency} onNav={nav} onOpenAsset={openDetail} liveIds={priceLiveIds}/>;
        case 'market':       return <MarketPageComp prices={prices} onNav={nav} currency={currency} onOpenAsset={openDetail} onOpenPnL={openPnL}/>;
        case 'trading':      return <TradingPageComp key={activeAsset?.id||'trading'} prices={prices} currency={currency} activeAsset={activeAsset} onOpenPnL={openPnL} priceRealAt={priceRealAt} priceSimSteps={priceSimSteps}/>;
        case 'auto':         return <AutoPageComp onNav={nav} currency={currency} onOpenAsset={openAsset} requireAuth={requireAuth}/>;
        case 'strategies':   return <StrategyBuilderPage onNav={nav}/>;
        case 'risk_settings':return <RiskSettingsPage/>;
        case 'season':       return <SeasonDashboard/>;
        case 'wallet':       return <WalletPageComp/>;
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
        case 'ai_usage':     return <AiUsagePage/>;
        case 'menu_hub':     return <MenuHubPage onNav={nav}/>;
        case 'pine_guide':   return <PineGuidePage/>;
        case 'seasonality':  return <SeasonalityPage/>;
        case 'hub_accounts': return <HubAccountsPage/>;
        case 'ai_portfolio': return <AIPortfolioPage prices={prices} currency={currency}/>;
        case 'dca':          return <DCAPage currency={currency}/>;
        case 'dividends':    return <DividendCalendarPage currency={currency}/>;
        case 'funding':      return <FundingPage currency={currency}/>;
        case 'pnl':         return <PnLCalculatorPage currency={currency} prefill={pnlPrefill}/>;
        case 'heatmap':      return <div><div style={{fontWeight:800,fontSize:15,color:T.txt,marginBottom:12}}>🌈 자산 히트맵</div><Heatmap prices={prices}/></div>;
        case 'scanner':      return <ScannerPage prices={prices} currency={currency} onOpenAsset={openAsset}/>;
        case 'clock':        return <div style={{padding:'4px 0'}}><React.Suspense fallback={null}><WorldClock/></React.Suspense></div>;
        case 'search':       return <SearchPage prices={prices} currency={currency} onOpenAsset={openAsset}/>;
        case 'review':       return <JournalReviewPage currency={currency}/>;
        case 'autobot':      return <AutoBotLabPage/>;
        case 'groups':       return <WatchGroupsPage prices={prices} currency={currency} onOpenAsset={openAsset}/>;
        case 'paper':        return <PaperTradingPage prices={prices} onOpenAsset={openAsset}/>;
        case 'paper':        return <PaperTradingPage prices={prices} currency={currency} onOpenAsset={openAsset}/>;
        case 'diagnostics':  return <DiagnosticsPage/>;
        case 'ops':          return <OpsPage/>;
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
        case 'growth':       return <GrowthPage prices={prices} currency={currency}/>;
        case 'admin':        return isAdminUser ? <AdminPageComp/> : <HomePageComp {...p}/>;
        default:             return <HomePageComp {...p}/>;
      }
    } catch(e) {
      console.error('[renderPage]', tab, e);
      return <div style={{padding:'24px 16px',textAlign:'center',color:'#EF4444'}}>
        <div style={{marginBottom:8,display:'flex',justifyContent:'center'}}><TriangleAlert size={28} strokeWidth={2.2}/></div>
        <div style={{fontWeight:700,marginBottom:4}}>페이지 오류</div>
        <div style={{fontSize:11,color:'var(--t-sub)',marginBottom:12}}>{String(e)}</div>
        <button onClick={()=>nav('home')} style={{background:'#2563EB',color:'#fff',border:'none',borderRadius:10,padding:'10px 20px',fontWeight:700,cursor:'pointer'}}>홈으로</button>
      </div>;
    }
  },[tab,prices,nav,currency,lang,setLang,setCurrency,isAdminUser,activeAsset,openAsset,openPnL,pnlPrefill]);

  const tickerAssets=prices.slice(0,14);

  // Don't render until client is mounted - prevents ALL hydration mismatches
  if (!mounted) {
    return (
      <div style={{
        minHeight:'100vh', background:'var(--t-bg)',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}>
        <div style={{ textAlign:'center', color:'var(--t-muted)' }}>
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
      {/* 백그라운드 자동매매 엔진 — 활성 전략만, 앱이 열려 있는 동안 주기적으로 평가
          (폴링 60초이지만 앞 tick이 안 끝나면 건너뛰고, 신호가 난 전략은 5분 쿨다운) */}
      <AutoTradeEngine/>
      <ApiHealthMonitor/>
      {!onboarded&&<Onboarding onDone={(l,c)=>{setLang(l);setCurrency(c);setOnboarded(true);sS('tg_ob','1');sS('tg_lang',l);sS('tg_cur',c);}}/>}
      <ConfirmHost />
      <LoginModal
        open={loginOpen}
        reason={loginReason}
        onClose={()=>{ setLoginOpen(false); pendingAction.current=null; }}
        onSuccess={()=>{ const a=pendingAction.current; pendingAction.current=null; if(a) setTimeout(a,100); }}
        onGoEmail={()=>{ if(typeof window!=='undefined') window.location.href='/auth'; }}
      />
      <AssetDetailModal
        asset={detailAsset}
        currency={currency}
        prices={prices}
        onClose={()=>setDetailAsset(null)}
        onTrade={(a)=>openAsset(a,'trading')}
        onPnL={openPnL}
        onNav={nav}
      />
      <div suppressHydrationWarning className="aw"
        data-left={leftMode} data-right={effRightMode}
        style={{background:T.bg,minHeight:'-webkit-fill-available' as any,color:T.txt,
          // 칸 폭은 CSS가 아니라 여기서 정한다. CSS에 숫자를 또 적으면
          // 드래그가 멈추는 자리와 칸이 멈추는 자리가 갈린다.
          ['--sb-w' as any]:`${sidebarW}px`, ['--rp-w' as any]:`${railCol}px`}}>

        {/* PC Sidebar */}
        <div className="sb" style={{display:'none',padding:'12px 0'}}>
          <div style={{padding:'14px 12px 12px',borderBottom:`1px solid ${T.border}`,marginBottom:6}}>
            <div style={{display:'flex',alignItems:'center',gap:8,minWidth:0,justifyContent:leftMode==='compact'?'center':'flex-start'}}>
              <div style={{width:30,height:30,borderRadius:9,flexShrink:0,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:14,color:'#fff'}}>T</div>
              <div className="sb-brand-text" style={{fontWeight:900,fontSize:15,letterSpacing:-0.5,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>TRAIGO</div>
              <div className="sb-brand-text" style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:6}}>
                <Dot c={T.grn}/>
              </div>
            </div>
            {/* 접기 버튼은 접힌 상태에서도 남아야 한다 — 그러지 않으면
                한 번 접은 사람은 다시 펼 방법이 없다. */}
            <div style={{display:'flex',justifyContent:leftMode==='compact'?'center':'flex-end',marginTop:8}}>
              <PanelToggle side="left" open={leftMode==='expanded'} onToggle={toggleLeft}/>
            </div>
          </div>
          <button onClick={()=>nav('menu_hub')} className="sb-menu-btn" title="전체 메뉴 · 검색" aria-label="전체 메뉴 · 검색" style={{display:'flex',alignItems:'center',gap:10,width:'100%',padding:'11px 16px',margin:'2px 0 6px',background:tab==='menu_hub'?T.acg:A(T.acc,'15'),color:tab==='menu_hub'?T.acl:T.acl,border:'none',borderRadius:0,cursor:'pointer',fontSize:13,fontWeight:800,textAlign:'left'}}>
            <span style={{width:20,flexShrink:0,display:'inline-flex',alignItems:'center',justifyContent:'center'}}><SearchIc size={16} strokeWidth={2.4}/></span>
            <span className="sb-label" style={{minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>전체 메뉴 · 검색</span>
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
                {g.title&&<div className="sb-group-title" style={{padding:'10px 16px 4px',color:T.muted,fontSize:9,fontWeight:800,letterSpacing:1,textTransform:'uppercase'}}>{g.title}</div>}
                {g.ids.map(id=>{ const t2=find(id); if(!t2)return null; const Ic=t2.Icon;
                  return (
                    /* 접힌 상태에서는 이름이 사라진다. title과 aria-label을
                       항상 붙여 두는 이유가 그것이다 — 아이콘만 남았을 때
                       무엇인지 알 방법이 그것뿐이다. */
                    <button key={id} onClick={()=>nav(id)} className="sb-item" title={t2.label+(TAB_DESC[id]?` — ${TAB_DESC[id]}`:'')} aria-label={t2.label} aria-current={tab===id?'page':undefined} style={{display:'flex',alignItems:'center',gap:10,width:'100%',padding:'9px 16px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.sub,border:'none',borderLeft:`3px solid ${tab===id?T.acl:'transparent'}`,cursor:'pointer',fontSize:13,fontWeight:tab===id?700:500,textAlign:'left'}}>
                      <span style={{width:20,flexShrink:0,display:'inline-flex',alignItems:'center',justifyContent:'center'}}><Ic size={16} strokeWidth={2.2}/></span>
                      <span className="sb-label" style={{minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t2.label}</span>
                      {id==='alerts'&&unreadCount>0&&<span className="sb-badge" style={{background:T.red,color:'#fff',borderRadius:99,padding:'0 5px',fontSize:9,marginLeft:'auto',fontWeight:700,flexShrink:0}}>{unreadCount}</span>}
                    </button>
                  );
                })}
              </div>
            ));
          })()}
          <div className="sb-foot" style={{marginTop:'auto',padding:'12px 14px',borderTop:`1px solid ${T.border}`}}>
            <div style={{background:A(T.prp,'20'),border:`1px solid ${A(T.prp,'40')}`,borderRadius:10,padding:'8px 12px'}}>
              <div style={{color:T.prp,fontWeight:700,fontSize:11,display:'flex',alignItems:'center',gap:6}}><Bot size={12} strokeWidth={2.2}/> 모의투자 모드</div>
              <div style={{color:T.muted,fontSize:10,marginTop:2}}>실제 돈 사용 안됨 · 수익 보장 없음</div>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="mc" style={{flex:1}}>
          {/* Header
              매매 탭에서는 감춘다. 이 줄과 아래 시세띠가 합쳐서 80px쯤
              먹는데, 터미널은 그 80px이 있고 없고에 따라 주문폼이 한
              화면에 들어가느냐 마느냐가 갈린다. 탭 이름('매매')은 하단
              탭에 이미 켜져 있고, 종목·가격·모드는 터미널 헤더가 더
              정확하게 보여준다 — 같은 것을 두 번 그리느라 주문을 밀어낼
              이유가 없다. */}
          {tab!=='trading'&&(
          /* 머리줄이 겹치던 이유는 이름 칸과 버튼 칸이 **둘 다 줄어들 수
             없었기** 때문이다. flex 아이템의 기본 min-width는 auto라
             내용보다 좁아지지 않는다. 이름에 min-width:0을 주고 버튼
             줄에는 wrap을 허용한다 — 겹치는 것보다 한 줄 쓰는 것이 낫다. */
          <div style={{position:'sticky',top:0,zIndex:50,background:'color-mix(in srgb, var(--t-bg) 92%, transparent)',backdropFilter:'blur(16px)',WebkitBackdropFilter:'blur(16px)',borderBottom:`1px solid ${T.border}`,padding:'11px 16px 9px',display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap',paddingTop:`max(env(safe-area-inset-top),11px)`}}>
            <div className="hdr-brand">
              <div style={{width:26,height:26,borderRadius:8,flexShrink:0,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:13,color:'#fff'}}>T</div>
              <div className="hdr-title" style={{fontWeight:900,fontSize:14,letterSpacing:-0.5}}>{allTabs.find(t2=>t2.id===tab)?.label||'TRAIGO'}</div>
            </div>
            <div className="hdr-actions" style={{display:'flex',alignItems:'center',gap:4}}>
              <div style={{display:'flex',alignItems:'center',gap:3,background:priceStatus==='live'?'rgba(16,185,129,.12)':priceStatus==='mock'?'rgba(245,158,11,.12)':'rgba(239,68,68,.12)',border:`1px solid ${priceStatus==='live'?'rgba(16,185,129,.3)':priceStatus==='mock'?'rgba(245,158,11,.3)':'rgba(239,68,68,.3)'}`,borderRadius:20,padding:'2px 7px'}}>
                <Dot c={priceStatus==='live'?T.grn:priceStatus==='mock'?T.ylw:T.red}/><span style={{color:priceStatus==='live'?T.grn:priceStatus==='mock'?T.ylw:T.red,fontSize:9,fontWeight:700}}>{priceStatus==='live'?'LIVE':priceStatus==='mock'?'MOCK':'ERR'}</span>
              </div>
              {/* 테마는 설정에도 있지만 여기에도 둔다. 밝기는 자주 바꾸는
                  것이고, 그때마다 설정까지 들어가게 하면 아무도 안 쓴다.
                  누르면 밝음 → 어두움 → 시간에 맞춰 순으로 돈다. */}
              <button onClick={cycleTheme} title={`테마: ${MODE_LABEL[themeMode]}`} aria-label={`테마 ${MODE_LABEL[themeMode]}`}
                style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:20,width:26,height:26,cursor:'pointer',color:T.sub,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                {themeMode==='light'?<Sun size={13} strokeWidth={2.2}/>:themeMode==='dark'?<Moon size={13} strokeWidth={2.2}/>:<Clock size={13} strokeWidth={2.2}/>}
              </button>
              {pwaInstallable&&(
                <button onClick={promptPwaInstall} style={{background:'linear-gradient(135deg,#2563EB,#7C3AED)',border:'none',borderRadius:20,padding:'3px 10px',cursor:'pointer',fontSize:10,color:'#fff',fontWeight:700,display:'flex',alignItems:'center',gap:3}} className="hdr-badge">
                  <Download size={11} strokeWidth={2.4}/> 설치
                </button>
              )}
              {isAdminUser&&(
                <button onClick={()=>nav('admin')} style={{background:'rgba(16,185,129,0.12)',border:'1px solid rgba(16,185,129,0.35)',borderRadius:20,padding:'2px 9px',cursor:'pointer',fontSize:11,color:'#10B981',fontWeight:700,display:'flex',alignItems:'center',gap:3}}>
                  <Shield size={11} strokeWidth={2.4}/> 관리자
                </button>
              )}
              <button onClick={()=>nav('settings')} className="hdr-badge" style={{background:T.acg,border:`1px solid ${T.border}`,borderRadius:20,padding:'2px 8px',cursor:'pointer',fontSize:10,color:T.acl,fontWeight:700,display:'flex',alignItems:'center',gap:3}}>
                <Globe size={11} strokeWidth={2.4}/>
                <span style={{textTransform:'uppercase'}}>{lang.split('-')[0]}</span>
                <span>{CURRENCIES[currency]?.symbol||'₩'}</span>
              </button>
              <button onClick={()=>nav('alerts')} className="hdr-badge" style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:20,padding:'2px 7px',cursor:'pointer',fontSize:11,color:T.muted,position:'relative'}}>
                <Bell size={13} strokeWidth={2.2} color={T.muted}/>{unreadCount>0&&<span style={{position:'absolute',top:-3,right:-3,background:T.red,color:'#fff',borderRadius:'50%',width:12,height:12,fontSize:8,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700}}>{unreadCount}</span>}
              </button>
              {authUser ? (
                <div style={{position:'relative'}}>
                  <button onClick={()=>setProfileOpen(o=>!o)} aria-label="프로필 메뉴" style={{minHeight:44,minWidth:44,background:A(T.prp,'20'),border:`1px solid ${A(T.prp,'40')}`,borderRadius:'50%',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',padding:0}}>
                    <span style={{color:T.prp,fontSize:15,fontWeight:800}}>{String(authUser.nickname||authUser.email||'U').charAt(0).toUpperCase()}</span>
                  </button>
                  {profileOpen&&(
                    <>
                      <div onClick={()=>setProfileOpen(false)} style={{position:'fixed',inset:0,zIndex:60}}/>
                      <div style={{position:"absolute",right:0,top:50,zIndex:61,background:T.bg,border:`1px solid ${T.border2}`,borderRadius:14,padding:'8px',minWidth:180,boxShadow:'0 8px 30px rgba(0,0,0,.5)'}}>
                        <div style={{padding:'8px 12px 10px',borderBottom:`1px solid ${T.border}`,marginBottom:4}}>
                          <div style={{color:T.txt,fontWeight:700,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{authUser.nickname||'내 계정'}</div>
                          <div style={{color:T.muted,fontSize:10,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{authUser.email||''}</div>
                        </div>
                        {[{ic:User2,l:'내 계정',d:'settings'},{ic:Link2,l:'거래소 연결',d:'accounts'},{ic:ShieldCheck,l:'보안',d:'safety'},{ic:Bell,l:'알림 설정',d:'alerts'}].map(m=>(
                          <button key={m.d} onClick={()=>{setProfileOpen(false);nav(m.d);}} style={{width:'100%',minHeight:44,display:'flex',alignItems:'center',gap:10,background:'transparent',border:'none',borderRadius:9,padding:'0 12px',cursor:'pointer',color:T.txt,fontSize:13,textAlign:'left'}}>
                            <m.ic size={16} color={T.muted}/> {m.l}
                          </button>
                        ))}
                        <button onClick={async()=>{setProfileOpen(false);try{const{sbSignOut}=await import('@/lib/supabase');await sbSignOut();}catch{};setAuthUser(null);}} style={{width:'100%',minHeight:44,display:'flex',alignItems:'center',gap:10,background:'transparent',border:'none',borderTop:`1px solid ${T.border}`,marginTop:4,paddingTop:4,borderRadius:9,padding:'0 12px',cursor:'pointer',color:T.red,fontSize:13,textAlign:'left'}}>
                          <LogOut size={16} color={T.red}/> 로그아웃
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <button onClick={()=>{setLoginReason('');pendingAction.current=null;setLoginOpen(true);}} aria-label="로그인" style={{minHeight:44,background:`linear-gradient(135deg,${T.acc},${T.prp})`,border:'none',borderRadius:22,padding:'0 18px',cursor:'pointer',fontSize:13,color:'#fff',fontWeight:800}}>
                  로그인
                </button>
              )}
            </div>
          </div>
          )}

          {/* Ticker — 매매 탭에서는 감춘다 (위 Header 주석 참조).
              터미널에는 자기 종목의 실시간 호가가 있고, 다른 코인 시세를
              흘려보내는 띠는 주문 화면에서 자리를 먹는 것 이상을 하지 않는다. */}
          {tab!=='trading'&&(
          <div style={{background:T.surf,borderBottom:`1px solid ${T.border}`,overflow:'hidden',height:26,display:'flex',alignItems:'center'}}>
            <div className="ticker">
              {[...tickerAssets,...tickerAssets].map((a,i)=>(
                <span key={i} style={{color:a.c>=0?T.grn:T.red,fontSize:10,padding:'0 12px',fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',fontWeight:500}}>
                  {a.nameKr} <span style={{color:T.txt}}>{cvt(a.p,currency)}</span> {a.c>=0?'▲':'▼'}{Math.abs(a.c).toFixed(2)}%
                </span>
              ))}
            </div>
          </div>
          )}

          {/* PWA: Offline banner */}
          {pwaOffline&&(
            <div style={{background:'#78350F',borderBottom:'1px solid #92400E',padding:'8px 16px',display:'flex',alignItems:'center',gap:8,zIndex:49}}>
              <span style={{fontSize:14}}>📡</span>
              <span style={{color:'#FCD34D',fontSize:11,fontWeight:700,flex:1}}>오프라인 · 캐시된 데이터 표시 중</span>
            </div>
          )}
          {/* PWA: Update banner */}
          {pwaUpdate&&(
            <div style={{background:'#1E3A5F',borderBottom:`1px solid ${A(T.acl,'40')}`,padding:'8px 16px',display:'flex',alignItems:'center',gap:8,zIndex:49}}>
              <span style={{fontSize:14}}>🔄</span>
              <span style={{color:T.acl,fontSize:11,fontWeight:700,flex:1}}>새 버전이 있습니다</span>
              <button onClick={applyPwaUpdate} style={{background:T.acl,color:'#fff',border:'none',borderRadius:8,padding:'4px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>업데이트</button>
              <button onClick={()=>setPwaUpdate(false)} style={{background:'transparent',border:'none',color:T.muted,cursor:'pointer',fontSize:16,lineHeight:1}}>✕</button>
            </div>
          )}
          {/* Page Content */}
          {/* 매매 탭은 터미널이다. page-content의 패딩 안에 넣으면 좌우가
              잘리고 아래로 스크롤이 생기므로, 컨테이너 자체를 바꿔 끼운다. */}
          {tab==='trading' ? (
            <ErrorBoundary onHome={() => nav('home')}>
              <TerminalTab onNav={nav}/>
            </ErrorBoundary>
          ) : (
            <div className="page-content" style={{padding:'12px 12px calc(var(--nav-h) + 20px)'}}>
              <ErrorBoundary onHome={() => nav('home')}>
                {renderPage()}
              </ErrorBoundary>
            </div>
          )}

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
          {/*
            빠른 명령 팔레트. Ctrl/Cmd+K 또는 아래 '더보기'의 검색으로 열린다.
            열려 있을 때만 렌더한다 — 컴포넌트가 dynamic이라 그때 불러온다.
          */}
          {paletteOpen&&(
            <CommandPalette
              open={paletteOpen}
              onClose={()=>setPaletteOpen(false)}
              onRun={runCommand}
              isAdmin={isAdminUser}
              symbols={paletteSymbols}
            />
          )}

          {helpOpen&&(
            <ShortcutHelp open={helpOpen} onClose={()=>setHelpOpen(false)} profile={DEFAULT_PROFILE}/>
          )}

          {showMore&&(
            <>
              <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:90}} onClick={()=>setShowMore(false)}/>
              <div className="kb-shrink" style={{position:'fixed',bottom:'calc(var(--nav-h) + 8px)',left:'50%',transform:'translateX(-50%)',width:'calc(100% - 24px)',maxWidth:456,background:T.surf,border:`1px solid ${T.border}`,borderRadius:20,padding:'12px 12px calc(12px + env(safe-area-inset-bottom,0px))',zIndex:150,boxShadow:'0 -8px 40px rgba(0,0,0,.6)',maxHeight:'70vh',overflowY:'auto'}}>
                {/*
                  모바일에는 Ctrl+K가 없다. 단축키만 만들어 두면 이 기능은
                  PC 사용자만의 것이 된다 — 그래서 눈에 보이는 입구를 둔다.
                */}
                <button onClick={openPalette}
                  style={{display:'flex',alignItems:'center',gap:8,width:'100%',marginBottom:10,
                    background:T.alt,border:`1px solid ${T.border}`,borderRadius:12,
                    padding:'11px 12px',cursor:'pointer',textAlign:'left'}}>
                  <span style={{fontSize:14}}>🔍</span>
                  <span style={{flex:1,color:T.muted,fontSize:12,fontWeight:600}}>이동·실행·검색 — 초성도 됩니다</span>
                  <span style={{color:T.muted,fontSize:9,fontWeight:700,border:`1px solid ${T.border}`,borderRadius:5,padding:'2px 5px'}}>⌘K</span>
                </button>

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
                      {title:'거래',ids:['strategies','autobot','fear_dca','paper','season']},
                      {title:'분석',ids:['backtest','scanner','seasonality','review','briefing','news','calendar','analysis','pine_guide']},
                      {title:'자산',ids:['portfolio','ai_portfolio','growth','dividends','accounts','manual_accounts']},
                      {title:'관리',ids:['ai_usage','risk_settings','history','alerts','safety','diagnostics','ops']},
                      {title:'기타',ids:['academy','posters','social','settings']},
                    ];
                    return mGroups.map((g,gi)=>{
                      // 관리자 전용 항목은 목록에서 뺀다. 서버가 막으니
                      // 보안은 이미 되어 있고, 여기서 빼는 건 눌러도 거부만
                      // 당하는 항목을 안 보여주기 위해서다.
                      const ADMIN_ONLY=new Set(['ai_usage']);
                      const items=g.ids
                        .filter(id=>!ADMIN_ONLY.has(id)||isAdminUser)
                        .map(id=>MTABS.find(t=>t.id===id)).filter(Boolean)
                        .filter((t2:any)=>!simpleMode||t2.core);
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
                                  <span style={{flexShrink:0,width:36,height:36,borderRadius:9,background:active?A(T.acl,'20'):T.surf,display:'flex',alignItems:'center',justifyContent:'center'}}>
                                    <Ic size={18} strokeWidth={active?2.4:2.1} color={active?T.acl:T.sub}/>
                                  </span>
                                  <div style={{flex:1,minWidth:0}}>
                                    <div style={{color:active?T.acl:T.txt,fontSize:13,fontWeight:700}}>{t2.label}</div>
                                    {TAB_DESC[t2.id] && <div style={{color:T.muted,fontSize:10,marginTop:2,lineHeight:1.35}}>{TAB_DESC[t2.id]}</div>}
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

        {/* PC Right Panel
            접으면 얇은 띠만 남고, 그 폭만큼 가운데가 넓어진다(.aw의 grid).
            띠는 칸 **안에** 있으므로 본문 위에 뜨지 않는다.
            데이터 출처는 이번 단계에서 바꾸지 않았다 — 시세는 그대로
            useLivePrices의 prices다. */}
        <div className="rp" style={{display:'none'}}>
          {effRightMode==='expanded'&&(
            <RailResizer width={railWNow} sidebarW={sidebarW} onResize={setRailW} onCommit={commitRail}/>
          )}
          {/* 토글을 오른쪽 끝에 두면 안 된다.
              화면 우상단(top:10 right:10)에는 이미 떠 있는 알림 벨이 있고
              (NotifyHost · position:fixed · z-index 9998), 그 자리에 놓으면
              **버튼이 보이기는 하는데 눌리지 않는다.** 실제로 그 상태였다 —
              클릭이 벨에 먹혔다. 그래서 레일의 왼쪽에 붙인다. */}
          <div className="rp-toggle-row" style={{display:'flex',alignItems:'center',justifyContent:effRightMode==='expanded'?'flex-start':'center',marginBottom:effRightMode==='expanded'?6:0}}>
            <PanelToggle side="right" open={effRightMode==='expanded'} onToggle={toggleRight}/>
          </div>
          <div className="rp-body">
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
          <div style={{marginTop:16,fontWeight:800,fontSize:13,color:T.txt,marginBottom:6,display:'flex',alignItems:'center',gap:6,cursor:'pointer'}} onClick={()=>nav('news')}>
            <Newspaper size={14} strokeWidth={2.2}/> {feedTitle(railFeed.provenance)}
            {feedBadge(railFeed.provenance)&&(
              <span style={{background:A(T.ylw,'20'),color:T.ylw,border:`1px solid ${A(T.ylw,'40')}`,fontSize:9,fontWeight:800,padding:'1px 5px',borderRadius:99}}>{feedBadge(railFeed.provenance)}</span>
            )}
            <span style={{marginLeft:'auto',color:T.acl,fontSize:10}}>전체 ›</span>
          </div>
          {railFeed.note&&(
            <div style={{color:T.muted,fontSize:9,marginBottom:8,lineHeight:1.45,overflowWrap:'anywhere'}}>{railFeed.note}</div>
          )}
          {railFeed.items.slice(0,3).map(n=>(
            <div key={n.id} onClick={()=>nav('news')} role="button" tabIndex={0}
              onKeyDown={(e)=>{ if(e.key==='Enter'){nav('news');} }}
              style={{padding:'8px 0',borderBottom:`1px solid ${T.border}`,cursor:'pointer'}}>
              <div style={{color:T.txt,fontSize:11,fontWeight:600,lineHeight:1.4,marginBottom:2}}>{n.title}</div>
              {/* 예시 기사에는 시각·매체를 적지 않는다 */}
              {(itemTime(railFeed.provenance,n.time)||itemSource(railFeed.provenance,n.source))&&(
                <div style={{color:T.muted,fontSize:9}}>
                  {[itemTime(railFeed.provenance,n.time),itemSource(railFeed.provenance,n.source)].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          ))}
          </div>
        </div>
      </div>
    </>
  );
}
