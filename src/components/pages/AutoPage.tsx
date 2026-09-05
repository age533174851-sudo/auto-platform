'use client';
import { A } from '@/lib/theme/colors';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { BotRun, ExecMode, RiskEvent, Signal, SignalState, StratStatus, StratType, Strategy } from '@/types/domain';
import { confirmDialog } from '@/lib/confirm/dialog';
import { notifyInfo, notifySuccess } from '@/lib/notify/center';
import { T, CURRENCIES } from '@/lib/constants';
import { cvt, fmt, fmtPct, gS, sS, uid } from '@/lib/utils';
import type { Asset } from '@/types';
import { Card } from './SharedUI';
import { SettingField, settingInput } from '@/components/ui/SettingField';
import AssetLogo from '../AssetLogo';
import { loadSettings as loadRiskSettings, MODE_LABEL } from '@/lib/risk/store';
import { Shield, Edit3, ChevronRight } from 'lucide-react';
import AutoStatusBoard from '../AutoStatusBoard';
import AutotradeControl from '../AutotradeControl';
import { probeAuthToken } from '@/lib/auth/authToken';
import {
  stopTargets, verify, unknownResult, headline as stopHeadline,
  boundaryNote as stopBoundary, isAlarming as stopAlarming,
  IDLE_RESULT, type GlobalStopResult, type StopOutcome,
} from '@/lib/autotrade/globalStop';
import StrategyIntelligence from '../StrategyIntelligence';
import RegimeFilterPanel from '../RegimeFilterPanel';
import EnginePanel from '../EnginePanel';
import DailySlotPanel from '../DailySlotPanel';
import AsymmetryPanel from '../AsymmetryPanel';
import DailyStrategyPanel from '../DailyStrategyPanel';
import EdgeLabPanel from '../EdgeLabPanel';
import ChallengePanel from '../ChallengePanel';
import WalkForwardPanel from '../WalkForwardPanel';
import DerivativesPanel from '../DerivativesPanel';
import CommitteePanel from '../CommitteePanel';
import StrategyMarketPanel from '../StrategyMarketPanel';
import AllocationPanel from '../AllocationPanel';
import TacticalPanel from '../TacticalPanel';
import LearningPanel from '../LearningPanel';
import StrategyFactoryPanel from '../StrategyFactoryPanel';
import DynamicSizingPanel from '../DynamicSizingPanel';
import ChandelierPanel from '../ChandelierPanel';
import AdaptiveLeveragePanel from '../AdaptiveLeveragePanel';
import StrategyScorePanel from '../StrategyScorePanel';
import MetaStrategyPanel from '../MetaStrategyPanel';
import AuditLogPanel from '../AuditLogPanel';
import {
  kindOf, KIND_LABEL, showsTpSl, cardRowsOf, unwiredFieldsOf, edgeRowOf,
  activityOf, activityLabel, ACTIVITY_TONE, DEFAULT_FILTERS,
  cardPerfLine, cardPerfInput, UNKNOWN_TEXT,
  filterCountsOf, passesFilter, ALL_ACTIVITIES,
  actionsOf, isCompact, envLineOf, perfSummaryOf, moneyRowsOf,
  type Activity, type Tone as CardTone,
} from '@/lib/ui/strategyCard';
import { runtimeOf } from '@/lib/runtime/executionRuntime';
import { AUTO_TABS, tabOf as autoTabOf, type AutoTabId } from '@/lib/ui/autoOverview';

const STRAT_INFO:Record<StratType,{label:string;icon:string;color:string;desc:string}> = {
  ema_cross:     {label:'EMA 크로스',      icon:'📈',color:'#3B82F6',desc:'EMA20/60 골든·데드 크로스 추세 추종'},
  rsi_reversal:  {label:'RSI 반전',        icon:'🔄',color:'#7C3AED',desc:'RSI 과매수/과매도 반등 전략'},
  macd_trend:    {label:'MACD 추세',       icon:'📈',color:'#10B981',desc:'MACD 히스토그램 추세 추종'},
  breakout:      {label:'브레이크아웃',    icon:'🚀',color:'#F59E0B',desc:'볼린저밴드 / 고저 돌파 전략'},
  scalping:      {label:'스캘핑',          icon:'⚡',color:'#EF4444',desc:'단기 소폭 수익 반복 전략'},
  swing:         {label:'스윙',            icon:'🌊',color:'#0891B2',desc:'2~7일 스윙 포지션 전략'},
  dca:           {label:'DCA 적립',        icon:'💰',color:'#D97706',desc:'정기 분할 매수 전략'},
  buy_dip:       {label:'급락 매수',       icon:'💧',color:'#059669',desc:'급락 시 분할 매수 전략'},
  funding_rate:  {label:'펀딩비 전략',     icon:'💸',color:'#F59E0B',desc:'펀딩비 과열 시 롱/숏 비용 구조 활용'},
  ai_strategy:   {label:'AI 전략',         icon:'🤖',color:'#8B5CF6',desc:'시장 국면 AI 신호 기반 자동매매'},
};

/**
 * 아래 봇 카드 목록이 실행기에 연결돼 있는가.
 *
 * **false다.** [시작]을 눌러도 이 화면의 React 상태만 바뀌고 주문은
 * 나가지 않는다. 이 값이 배지·필터 칸의 이름을 고른다 — 그래서 나중에
 * 진짜 서버 목록을 붙이는 사람이 이 한 줄을 바꾸지 않고서는 '실행중'
 * 이라는 말을 화면에 띄울 수 없다.
 */
const STRAT_LIST_WIRED = false;

const INITIAL_STRATS:Strategy[] = [
// **이것들은 돌고 있는 봇이 아니라 전략 '틀'이다.**
//
// 예전에는 여기에 status:'running'과 승률 67%·누적 +₩847,000 같은
// 숫자가 박혀 있었다. 화면은 "실행중"이라고 말했고 수익까지 보여줬지만
// **아무것도 돌지 않았다.** 이 화면은 서버를 부르지 않는다 — 코드에 적힌
// 숫자를 그대로 그렸을 뿐이다.
//
// 안 도는 것을 조용히 두는 것보다 이쪽이 훨씬 나쁘다. 사용자는 자동매매가
// 돈을 벌고 있다고 믿고 실제 자금을 넣는다.
//
// 그래서 성과는 전부 0, 상태는 전부 '정지'다. 실제 실행은
// autotrade_schedules(마이그레이션 031)에 등록하고 크론이 돌린다.
  {id:'s1',name:'BTC EMA 추세 추종',type:'ema_cross',status:'stopped',asset:'BTC',assetNameKr:'비트코인',timeframe:'4h',leverage:2,maxLeverage:5,riskLevel:'medium',tp:5,sl:2.5,enabled:false,winRate:0,totalPnl:0,trades:0,maxDailyLoss:500000,maxPositionSize:3000000,cooldownMin:60,params:{ema_fast:20,ema_slow:60,rsi_filter:true,rsi_min:40,rsi_max:70},description:'EMA20/60 크로스 + RSI 40~70 필터'},
  {id:'s2',name:'ETH RSI 반전',type:'rsi_reversal',status:'stopped',asset:'ETH',assetNameKr:'이더리움',timeframe:'1h',leverage:1,maxLeverage:3,riskLevel:'low',tp:4,sl:2,enabled:false,winRate:0,totalPnl:0,trades:0,maxDailyLoss:200000,maxPositionSize:2000000,cooldownMin:120,params:{rsi_ob:70,rsi_os:30,rsi_period:14},description:'RSI 30↓ 매수 · RSI 70↑ 매도'},
  {id:'s3',name:'SOL 브레이크아웃',type:'breakout',status:'stopped',asset:'SOL',assetNameKr:'솔라나',timeframe:'15m',leverage:3,maxLeverage:10,riskLevel:'high',tp:8,sl:3,enabled:false,winRate:0,totalPnl:0,trades:0,maxDailyLoss:300000,maxPositionSize:1500000,cooldownMin:30,params:{bb_period:20,bb_std:2,vol_mult:1.5},description:'볼린저밴드 상단/하단 돌파'},
  {id:'s4',name:'BTC DCA 적립',type:'dca',status:'stopped',asset:'BTC',assetNameKr:'비트코인',timeframe:'1d',leverage:1,maxLeverage:1,riskLevel:'low',tp:50,sl:20,enabled:false,winRate:0,totalPnl:0,trades:0,maxDailyLoss:1000000,maxPositionSize:5000000,cooldownMin:1440,params:{interval_days:7,amount_krw:300000,max_entries:10},description:'주 1회 BTC 정기 매수 DCA'},
  {id:'s5',name:'BTC 펀딩비 전략',type:'funding_rate',status:'stopped',asset:'BTC',assetNameKr:'비트코인',timeframe:'4h',leverage:2,maxLeverage:5,riskLevel:'medium',tp:3,sl:1.5,enabled:false,winRate:0,totalPnl:0,trades:0,maxDailyLoss:300000,maxPositionSize:2000000,cooldownMin:240,params:{funding_threshold:0.01,direction_mode:'auto',min_funding_rate:0.005},description:'펀딩비가 과열된 시장에서 롱/숏 비용 구조를 이용하는 전략'},
  {id:'s6',name:'BTC AI 전략',type:'ai_strategy',status:'stopped',asset:'BTC',assetNameKr:'비트코인',timeframe:'1h',leverage:2,maxLeverage:3,riskLevel:'medium',tp:4,sl:2,enabled:false,winRate:0,totalPnl:0,trades:0,maxDailyLoss:300000,maxPositionSize:2000000,cooldownMin:120,params:{ai_mode:'balanced',confidence_threshold:70,regime_filter:true},description:'시장 국면 AI 신호를 기반으로 자동 진입/청산'},
];

// 비어 있다. 예전에는 여기에 신호 세 건이 박혀 있었다 —
// 2025년 5월 날짜, ₩94,230,000이라는 구체적인 가격, 78%·82% 신뢰도,
// 그리고 `state:'executed'`. **실행됐다고 적힌 신호다.**
//
// 이 화면은 신호를 만들지 않는다. 실제 신호는 전략빌더에 저장된
// 전략에서 나오고 AutoTradeEngine이 평가한다. 그런데 '신호' 칸을 열면
// 시각·가격·신뢰도가 붙은 카드 세 장이 나와서, 엔진이 돌면서 판단을
// 내리고 있는 것처럼 보였다. 하나는 체결까지 됐다고 말한다.
//
// INITIAL_RUNS·INITIAL_RISK_EVENTS를 비운 것과 같은 이유다 —
// **일어난 척하는 것이 아무것도 없는 것보다 나쁘다.**
const INITIAL_SIGNALS:Signal[] = [
];

// 비어 있다. 예전에는 여기에 2025년 5월 날짜의 '완료된 거래'가 세 건
// 박혀 있었다 — 일어난 적 없는 거래다.
const INITIAL_RUNS:BotRun[] = [
];

// 비어 있다. '일일 손실 한도 80% 도달', '3회 연속 손실 쿨다운' 같은
// 줄이 박혀 있었는데, 그 안전장치들은 한 번도 발동한 적이 없다.
// 발동한 척하는 것이 발동 안 한 것보다 나쁘다 — 사용자는 안전장치가
// 일하고 있다고 믿는다.
const INITIAL_RISK_EVENTS:RiskEvent[] = [
];

/* ─── AutoPage Component ─── */

/**
 * 전략을 만들 때 쓰는 기본값.
 *
 * 예전에는 입력칸의 placeholder로만 있었다. placeholder는 **값이 아니다** —
 * 비워 두면 0이 들어가고, 화면에는 회색으로 '5'가 떠 있으니 5인 줄 안다.
 * 익절 5%로 보이는데 실제로는 0%인 전략이 만들어진다.
 *
 * 설정을 고칠 때도 이 값을 '기본'으로 보여준다. 지금 값이 내가 바꾼 것인지
 * 원래 그랬던 것인지 구분할 수 있어야 한다.
 */
export const STRAT_DEFAULTS = {
  timeframe: '4h',
  leverage: 1,
  tp: 5,
  sl: 2.5,
} as const;

/* ── 첫 화면의 한 줄 ──
   판정은 `lib/ui/autoCockpit`가 한다. 여기서는 그 결과를 색과 글자로
   옮기기만 한다 — 이 안에서 다시 `enabled`를 세거나 mode를 읽으면
   판정 주인이 둘이 된다.

   `rows === null`은 **꺼짐이 아니라 모름**이다. 그래서 개수도, 환경
   배지도 그리지 않는다. */
function ExecutionTruthHero({ rows, readError, health }: {
  rows: any[] | null; readError?: string; health?: any[] | null;
}) {
  const v = cockpitVerdict(rows, readError, health);
  const badge = cockpitEnvBadge(v);
  const c = v.tone === 'live' ? T.red
    : v.tone === 'bad' ? T.red
      : v.tone === 'warn' ? T.ylw
        : v.tone === 'good' ? T.grn : T.muted;
  return (
    <div data-region="executionTruth" data-state={v.state} data-env={v.env ?? ''}
      role="status"
      style={{
        background: A(c, '12'), border: `1px solid ${A(c, '45')}`,
        borderLeft: `4px solid ${c}`, borderRadius: 12,
        padding: '12px 14px', marginBottom: 12,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <span data-truth="count" style={{ color: c, fontSize: 13, fontWeight: 800, minWidth: 0, overflowWrap: 'anywhere' }}>
          {v.headline}
        </span>
        {badge && (
          <span style={{
            flexShrink: 0, background: A(c, '22'), color: c,
            fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 6,
          }} data-truth="env">{badge}</span>
        )}
      </div>
      <div data-truth="executable" style={{ color: T.sub, fontSize: 11, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{v.detail}</div>
      {/* ── 첫 화면이 답해야 하는 나머지 ──
          대상 · 마지막 판단 · 안전. **없는 것은 적지 않는다** — 못 읽었거나
          기록이 없으면 그 자리를 0이나 '없음'으로 채우지 않고 비운다. */}
      {v.targets.length > 0 && (
        <div data-truth="targets" style={{ color: T.muted, fontSize: 10.5, marginTop: 4, overflowWrap: 'anywhere' }}>
          대상 {v.targets.join(' · ')}
        </div>
      )}
      {v.lastDecision && (
        <div data-truth="lastDecision" style={{ color: T.sub, fontSize: 10.5, marginTop: 3, overflowWrap: 'anywhere' }}>
          마지막 판단 — {v.lastDecision}
        </div>
      )}
      {/* 막힌 이유는 첫 줄 말고도 전부 보여 준다 — 하나만 고치고 나머지에서 또 막히면
          사용자는 같은 화면을 두 번 헤맨다. */}
      {v.blockers.slice(0, 4).map((b, i) => (
        <div key={`${b.where}-${i}`} data-truth="problem" style={{ color: T.red, fontSize: 10.5, marginTop: 3, overflowWrap: 'anywhere' }}>
          · {b.where ? `${b.where} — ` : ''}{b.why}
        </div>
      ))}
      {v.blockers.length === 0 && (v.state === 'ARMED' || v.state === 'UNCONFIRMED') && (
        <div data-truth="problem" style={{ color: v.state === 'ARMED' ? T.grn : T.ylw, fontSize: 10.5, marginTop: 3 }}>
          {v.state === 'ARMED' ? '안전 점검 통과 — 막는 항목 없음' : '안전 점검을 확인하지 못했습니다'}
        </div>
      )}
      {v.nextAction && (
        <div style={{ color: T.muted, fontSize: 10, marginTop: 5 }}>→ {v.nextAction}</div>
      )}
    </div>
  );
}

function AutoPage({ onNav, currency = 'KRW', onOpenAsset, requireAuth }: { onNav?: (tab: string) => void; currency?: string; onOpenAsset?: (a: any, dest?: string) => void; requireAuth?: (reason: string, action: () => void) => void } = {}) {
  // ── 3단계 정보 구조 ──
  //
  // 하위 탭이 여섯 개였다: 봇 목록 / AI 분석 / 신호 / 리스크 / 실행기록 /
  // 전략 추가. 여섯 개가 한 줄에 나란히 있으면 **매일 보는 것과 일 년에
  // 한 번 보는 것이 같은 무게로 보인다.** 그래서 매일 보는 것이 밀린다.
  //
  // 기존 화면을 지우지 않는다 — 묶기만 한다. 여섯 개는 그대로 있고
  // 다섯 갈래(개요/전략/예약/기록/진단) 아래로 들어간다.
  //
  // 묶음 정의(AUTO_TABS)는 `lib/ui/autoOverview`에 있다. 화면 안에서
  // 정하면 "왜 이 탭이 여기 있지"를 테스트할 수 없다.
  const [group,setGroup]=useState<AutoTabId>('overview');
  const [tab,setTab]=useState<'bots'|'ai'|'signals'|'risk'|'runs'|'create'>('bots');

  // 어느 묶음에 무엇이 들어가는가.
  const GROUP_MEMBERS: Record<AutoTabId, Array<[typeof tab, string]>> = {
    overview:    [],
    strategies:  [['bots','봇 목록'],['create','전략 추가']],
    schedule:    [],
    history:     [['runs','실행기록'],['signals','신호']],
    diagnostics: [['risk','리스크'],['ai','AI 분석']],
  };
  const members = GROUP_MEMBERS[group];

  // 묶음을 옮기면 그 묶음의 첫 항목으로 간다. 안 그러면 '기록'을 눌렀는데
  // 이전에 보던 '봇 목록'이 그대로 떠서 아무 일도 안 일어난 것처럼 보인다.
  const goGroup = useCallback((g: AutoTabId) => {
    setGroup(g);
    const first = GROUP_MEMBERS[g][0];
    if (first) setTab(first[0]);
  }, []);
  const [aiSection,setAiSection]=useState<'decision'|'risk'|'analysis'>('decision');
  const [strats,setStrats]=useState<Strategy[]>(INITIAL_STRATS);
  const [signals]=useState<Signal[]>(INITIAL_SIGNALS);
  const [runs]=useState<BotRun[]>(INITIAL_RUNS);
  const [riskEvents]=useState<RiskEvent[]>(INITIAL_RISK_EVENTS);
  const [execMode,setExecMode]=useState<ExecMode>('paper');
  const [stopResult,setStopResult]=useState<GlobalStopResult>(IDLE_RESULT);
  const [selStrat,setSelStrat]=useState<Strategy|null>(null);
  const [showConfirmReal,setShowConfirmReal]=useState(false);
  const [editStrat,setEditStrat]=useState<Strategy|null>(null);
  const [showCreate,setShowCreate]=useState(false);
  const [newStrat,setNewStrat]=useState({name:'',type:'ema_cross' as StratType,asset:'BTC',timeframe:'4h',leverage:1,tp:5,sl:2.5,maxDailyLoss:500000,maxPositionSize:3000000});

  /* ── 지표는 이 화면의 상태에서 만들지 않는다 ──
     예전에는 실행중·총손익·평균승률·총거래 넷을 `strats`에서 계산했다.
     `strats`는 INITIAL_STRATS로 시작하는 **전략 틀**이고 서버를 부르지
     않는다. 그래서 카드를 토글하면 머리줄이 "실행중 1"이 됐는데
     서버에는 아무것도 등록되지 않았다.

     총손익·평균승률·총거래는 이 화면이 읽을 수 있는 서버 정본이 없다.
     없는 것을 0으로 그리면 "오늘 한 건도 못 벌었다"로 읽힌다 — 그래서
     지운다. 실제 성과판은 서버 데이터를 붙일 때 만든다.

     실행중 개수만 서버가 답해 준다(`/api/autotrade/schedule`). */
  /* ── 읽는 곳은 하나다 ──
     예전에는 이 화면과 AutotradeControl이 각자 `/api/autotrade/schedule`을
     불렀다. 판정 함수는 하나여도 **읽은 시점이 둘**이라, 네트워크 타이밍이
     갈리면 첫 줄과 아래 카드가 서로 다른 상태를 보여 줄 수 있었다.
     실제로 "첫 줄 LIVE · 아래 TESTNET"이 찍혔다.

     이제 AutotradeControl 한 곳만 읽고, 그 스냅샷을 여기로 올린다.
     첫 줄과 아래 카드가 **같은 객체**를 보므로 갈릴 수 없다. */
  const [snap,setSnap]=useState<{rows:any[]|null;err:string;health:any[]|null}>(
    {rows:null,err:'',health:null});
  /* **참조가 아니라 의미로 비교한다.**
     `autotradeHealth()`는 렌더마다 새로 계산되어 매번 새 배열을 준다.
     참조로 비교하면 값이 하나도 안 바뀌어도 항상 "달라졌다"가 되고,
     부모가 다시 그리고 → 자식이 다시 그리고 → 또 새 배열이 나온다.
     실측으로 폭주하지는 않았지만, 안 도는 이유가 계약이 아니라 우연이다. */
  const sigRef = useRef('');
  const onSnapshot = useCallback((v:{rows:any[]|null;err:string;health:any[]|null})=>{
    const sig = snapshotSignature(v.rows, v.err, v.health);
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    setSnap(v);
  },[]);
  /* 전체 정지가 **실제로** 무엇을 껐는지 확인하는 읽기.
     화면 표시의 소유자가 아니다 — 표시는 위 `snap` 하나만 본다.
     이 읽기를 없애면 "모두 중단됨"을 서버 확인 없이 적게 되므로 남긴다. */
  const loadSchedules = useCallback(async():Promise<{ok:boolean;rows:any[];reason:string}>=>{
    // **정본 경로 하나만 쓴다.** 예전에는 여기서 localStorage.sb_access_token을
    // 읽었다. 저장소 역사에서 그 키를 쓰는 production writer를 찾지 못했고,
    // **정상 production app flow에서는 그 키가 채워지지 않는다.** 비면 이
    // 함수는 첫 GET 전에 종료하므로 전체정지가 서버까지 가지 못한다.
    //
    // 실측 — base(d614dfb)의 canonical-session fixture에서 버튼을 누른 뒤
    // GET 0회 · PATCH 0회를 재현했다. 표시용 카드는 같은 순간 정본 세션으로
    // 정상 동작 중이었다. 그래서 화면은 멀쩡한데 정지만 안 되는 형태였다.
    // (저장소 밖 경로나 수동 localStorage 주입까지 배제한 것은 아니다.)
    //
    // probeAuthToken은 셋을 구분한다. 안전 경로에서는 이 구분이 중요하다 —
    // '로그아웃'과 '확인하지 못함'을 같은 문장으로 적으면, 세션이 멀쩡한데
    // 잠깐 못 읽은 것을 사용자가 로그인 문제로 오해한다.
    const auth = await probeAuthToken();
    if(auth===null) return {ok:false,rows:[],reason:'로그인 상태를 확인하지 못했습니다'};
    if(!auth) return {ok:false,rows:[],reason:'로그인이 필요합니다'};
    try{
      const r = await fetch('/api/autotrade/schedule',{headers:{Authorization:auth},cache:'no-store'});
      const j = await r.json().catch(()=>null);
      if(!r.ok||!j?.ok) return {ok:false,rows:[],reason:String(j?.message||j?.error||`HTTP ${r.status}`)};
      const rows = Array.isArray(j.schedules)?j.schedules:(Array.isArray(j.items)?j.items:[]);
      return {ok:true,rows,reason:''};
    }catch(e:any){ return {ok:false,rows:[],reason:String(e?.message||e)}; }
  },[]);
  /* 다시 읽는 것도 소유자가 한다. 여기서 rows만 갈아끼우면 health가 옛
     스냅샷으로 남아 첫 줄과 아래 점검이 다시 갈린다. */
  const reloadRef = useRef<null | (() => Promise<void>)>(null);
  const onReload = useCallback((fn: () => Promise<void>) => { reloadRef.current = fn; }, []);
  const schedRows = snap.rows;
  const schedErr = snap.err;
  // **못 읽었으면 0이라고 적지 않는다.** null은 '모른다'는 뜻이다.
  const runningCount = schedRows===null ? null : stopTargets(schedRows).length;

  // ── 이 목록은 실행기에 연결돼 있지 않다 ──
  //
  // '시작'을 누르면 이 화면의 React 상태만 바뀐다. 실제로 도는 것은
  // AutoTradeEngine이고, 그건 `listStrategies()`(전략빌더 저장소)를 읽는다 —
  // 이 여섯 장의 카드는 거기에 없다.
  //
  // 그래서 **켜짐 상태를 저장하지 않는다.** 저장하면 화면을 나갔다 와도
  // '실행중'이 남고, 그러면 돌지 않는 봇이 영구히 도는 것처럼 보인다.
  // 지금 '나갔다 오면 꺼져 있는' 것은 버그가 아니라, 저장할 진실이 없는
  // 상태다. 진실을 만들기 전에 표시부터 만들면 그게 거짓말이 된다.
  const toggleStrat=(id:string)=>{
    setStrats(p=>p.map(s=>s.id===id?{...s,status:s.status==='running'?'paused':'running',enabled:s.status!=='running'}:s));
    setNotWiredWarn(true);
  };
  const [notWiredWarn, setNotWiredWarn] = useState(false);
  /**
   * 어떤 칸의 전략을 볼 것인가.
   *
   * 기본은 실행중 + 기회 근접 + 오류다. **정지된 전략 스무 개를 매번
   * 스크롤할 이유가 없다.** 오류는 기본에 넣는다 — 숨기면 고장이 조용해진다.
   */
  const [stratFilter, setStratFilter] = useState<Activity[]>(DEFAULT_FILTERS);
  /** 어느 카드의 ⋯ 메뉴가 열려 있는가 */
  const [cardMenu, setCardMenu] = useState('');
  const stopStrat=(id:string)=>setStrats(p=>p.map(s=>s.id===id?{...s,status:'stopped',enabled:false}:s));

  /* ── 전체정지는 서버를 부른다 ──
     예전에는 로컬 state만 바꾸고 "모든 봇이 중단되었습니다"라고 적었다.
     실제로 도는 것은 autotrade_schedules(031)에 등록된 예약이고 크론이
     그것을 읽는다 — 화면 상태를 바꿔도 크론은 계속 돌았다.

     워커·스케줄러·리스크 엔진은 건드리지 않는다. 이미 있는 경로만 쓴다:
       GET   /api/autotrade/schedule            → 켜져 있는 예약
       PATCH /api/autotrade/schedule {id,false} → 하나씩 끈다

     그리고 **끈 개수만 말한다.** 판정과 문장은 lib/autotrade/globalStop에
     있고 테스트가 붙어 있다.

     마지막에 한 번 더 읽는 것이 판정이다
     ─────────────────────────────────────
     PATCH가 전부 200을 받아도 그것은 그 N개에 대한 증거일 뿐이다.
     그 사이에 다른 창에서 예약을 켰거나 새 예약이 생겼으면 켜진 것이
     남는다. 예전에는 마지막 GET이 `schedRows`만 갱신하고 판정에는
     반영되지 않아서, 그 경우에도 화면은 계속 "전부 껐다"고 적었다.
     이제 그 조회 결과가 `verify()`로 들어가고, 못 읽으면 UNVERIFIED다. */
  const handleGlobalStop=useCallback(async()=>{
    setStopResult({...IDLE_RESULT, code:'STOPPING'});
    const listed = await loadSchedules();
    if(!listed.ok){
      // 무엇이 도는지 모르는 상태다. 0개라고 적지 않는다.
      setStopResult(unknownResult(listed.reason));
      return;
    }
    const targets = stopTargets(listed.rows);
    // 목록을 읽어낸 그 경로와 **같은 정본**으로 끈다. 읽기와 쓰기가 다른
    // 인증을 쓰면 "무엇이 도는지는 아는데 끄지는 못하는" 상태가 생긴다.
    const auth = await probeAuthToken();
    if(!auth){
      setStopResult(unknownResult(auth===null?'로그인 상태를 확인하지 못했습니다':'로그인이 필요합니다'));
      return;
    }
    const outcomes:StopOutcome[]=[];
    for(const t of targets){
      const label=t.label||t.id;
      try{
        const r=await fetch('/api/autotrade/schedule',{
          method:'PATCH',
          headers:{'Content-Type':'application/json',Authorization:auth},
          body:JSON.stringify({id:t.id,enabled:false}),
        });
        const j=await r.json().catch(()=>null);
        if(r.ok&&j?.ok) outcomes.push({id:t.id,label,ok:true});
        else outcomes.push({id:t.id,label,ok:false,reason:String(j?.message||j?.error||`HTTP ${r.status}`)});
      }catch(e:any){
        outcomes.push({id:t.id,label,ok:false,reason:String(e?.message||e)});
      }
    }
    // **다시 읽어서 판정한다.** 이 조회 없이는 "지금 전부 꺼졌다"를
    // 말할 근거가 없다.
    const after = await loadSchedules();
    if(after.ok){
      setStopResult(verify(outcomes, {state:'read', remaining: stopTargets(after.rows).length}));
    }else{
      setStopResult(verify(outcomes, {state:'unread', reason: after.reason}));
    }
    // 화면은 소유자가 다시 읽어서 갱신한다.
    await reloadRef.current?.();
  },[loadSchedules]);

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
    // 실제 저장 (로그인 후 실행) — MOCK 빌드는 자유, 저장 시점에만 로그인 요구
    const doSave=()=>{
      setStrats(p=>[...p,s]);
      setShowCreate(false);
      setNewStrat({name:'',type:'ema_cross',asset:'BTC',timeframe:'4h',leverage:1,tp:5,sl:2.5,maxDailyLoss:500000,maxPositionSize:3000000});
      notifySuccess('전략 저장됨', `${s.name} — 봇 목록에 추가되었어요`);
    };
    if(requireAuth) requireAuth('자동매매 전략을 저장하려면 로그인이 필요해요', doSave);
    else doSave();
  };

  const statusColor:Record<StratStatus,string>={running:T.grn,paused:T.ylw,stopped:T.muted,error:T.red};
  const statusLabel:Record<StratStatus,string>={running:'실행중',paused:'일시중지',stopped:'정지',error:'오류'};
  const signalColor:Record<SignalState,string>={waiting:T.ylw,confirmed:T.grn,rejected:T.red,executed:T.acl,expired:T.muted};
  const signalLabel:Record<SignalState,string>={waiting:'대기',confirmed:'확인됨',rejected:'거부됨',executed:'실행됨',expired:'만료'};

  return (
    /* data-region="autoPage" — 자동매매 화면의 조작 대상 최소 크기를
       한 곳(globals.css)에서 지킨다. 버튼마다 minHeight를 손으로 적으면
       스무 곳 중 한 곳이 빠지고, 빠진 것을 아무도 모른다. */
    <div data-region="autoPage">
      {/* ── 이 화면이 답해야 하는 한 가지 ──
          "지금 내 돈이 실제로 자동으로 움직이고 있는가?"

          이 판정의 주인은 `lib/ui/autoCockpit` 하나다. 화면은 서버가 준
          예약 줄(enabled·mode·connectionState·runtime)을 그대로 넘기고
          그리기만 한다 — 여기서 다시 판단하면 주인이 둘이 된다. */}
      <ExecutionTruthHero rows={schedRows} readError={schedErr} health={snap.health} />

      {/* **실제로 도는 자동매매**를 여기서 켜고 끈다.
          지금까지는 Supabase SQL 편집기에서 INSERT를 쳐야 했고, 그동안
          크론은 돌면서 아무 일도 하지 않았다. AutoStatusBoard보다 위에
          둔다 — 그쪽은 실행기·모의 판의 상태이고, 여기는 '이 전략을
          지금 켤 것인가'라는 다른 질문이다. */}
      <AutotradeControl onSnapshot={onSnapshot} onReload={onReload} />

      <AutoStatusBoard />
      {/* ── 아래 모드 버튼은 '지금 무엇이 도는가'가 아니다 ──
          이것은 이 화면 안에서 **아래 예시 전략 카드에 적용해 볼 모드**를
          고르는 입력이다. 실제 실행 환경은 예약마다 서버에 저장된 mode이고,
          그것은 위 첫 줄이 말한다.

          예전에는 이 토글의 기본값('paper')만 보고 "모의 자동매매 모드 —
          실제 자금 이동 없음"이라고 단정했다. 실전 예약이 켜져 있어도
          그렇게 적혔다. */}
      <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>
        미리보기 모드 — 아래 예시 카드에만 적용됩니다
      </div>
      <div style={{display:'flex',gap:8,marginBottom:12,alignItems:'center'}}>
        <div style={{display:'flex',gap:4,flex:1}}>
          {(['paper','testnet','real'] as ExecMode[]).map(m=>{
            const c=m==='paper'?T.acl:m==='testnet'?T.ylw:T.red;
            const on=execMode===m;
            return (
            <button key={m} onClick={()=>m==='real'?setShowConfirmReal(true):setExecMode(m)} style={{flex:1,padding:'8px',background:on?c+'22':'transparent',color:on?c:T.muted,border:`1px solid ${on?c:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
              {m==='paper'?'모의':m==='testnet'?'테스트넷':'⚠️ 실전'}
            </button>
            );
          })}
        </div>
        {/* '재시작'을 없앴다. 이 버튼은 예약을 끄는 일만 하고, 다시 켜는
            것은 어느 전략을 켤지 고르는 다른 결정이다 — 위쪽 자동매매
            제어판에서 한다. 한 버튼이 껐다 켰다를 겸하면, 껐다고 믿는
            사용자가 실수로 다시 켜기 쉽다. */}
        <button
          onClick={handleGlobalStop}
          disabled={stopResult.code==='STOPPING'}
          aria-label="등록된 자동매매 예약 전체 끄기"
          style={{background:A(T.red,'20'),color:T.red,border:`1px solid ${T.red}40`,borderRadius:10,padding:'8px 12px',minHeight:40,fontSize:11,fontWeight:700,cursor:stopResult.code==='STOPPING'?'wait':'pointer',opacity:stopResult.code==='STOPPING'?0.6:1}}>
          {stopResult.code==='STOPPING'?'정지 요청 중…':'⏹ 예약 전체 끄기'}
        </button>
      </div>

      {/* 결과 문장은 globalStop 모듈이 만든다. 화면이 스스로 "모두
          중단됐다"고 적지 않는다 — 서버가 껐다고 답한 개수만 말한다. */}
      {stopResult.code!=='IDLE'&&(()=>{
        const alarm=stopAlarming(stopResult);
        const c=alarm?T.red:stopResult.code==='STOPPING'?T.ylw:T.grn;
        return (
          <div role="status" style={{background:A(c,'12'),border:`1px solid ${A(c,'45')}`,borderRadius:12,padding:'10px 14px',marginBottom:12}}>
            <div style={{color:c,fontWeight:700,fontSize:12}}>{stopHeadline(stopResult)}</div>
            {stopBoundary(stopResult)&&(
              <div style={{color:T.sub,fontSize:11,marginTop:4,lineHeight:1.45}}>{stopBoundary(stopResult)}</div>
            )}
            {stopResult.outcomes.filter((o):o is Extract<StopOutcome,{ok:false}>=>!o.ok).slice(0,5).map(o=>(
              <div key={o.id} style={{color:T.red,fontSize:11,marginTop:3}}>· {o.label} — {o.reason}</div>
            ))}
            {stopResult.error&&<div style={{color:T.red,fontSize:11,marginTop:3}}>· {stopResult.error}</div>}
          </div>
        );
      })()}

      {execMode==='paper'&&<div style={{background:A(T.prp,'12'),border:`1px solid ${A(T.prp,'30')}`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.prp,fontSize:11,fontWeight:700}}>미리보기: 모의 — 아래 예시 카드는 주문을 내지 않습니다</div></div>}

      {execMode==='testnet'&&<div style={{background:A(T.ylw,'15'),border:`1px solid ${A(T.ylw,'30')}`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.ylw,fontSize:11,fontWeight:700}}>미리보기: 테스트넷 — 실제 실행 환경은 맨 위 줄이 말합니다</div></div>}

      {execMode==='real'&&<div style={{background:A(T.red,'15'),border:`1px solid ${A(T.red,'30')}`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.red,fontSize:11,fontWeight:700}}>미리보기: 실전 — 실제 실행 환경은 맨 위 줄이 말합니다</div></div>}

      {/* ── 켜져 있는 예약 ──
          예전에는 여기 넷이 있었다: 실행중 · 총 손익 · 평균 승률 · 총 거래.
          넷 다 아래 전략 '틀' 목록에서 계산한 값이었고, 그 목록은 서버를
          부르지 않는다. 카드를 토글하면 머리줄이 "실행중 1"이 됐지만
          서버에는 아무것도 등록되지 않았다.

          손익·승률·거래수는 이 화면이 읽을 수 있는 서버 정본이 없다.
          0으로 그리면 "한 건도 못 벌었다"로 읽히므로 지웠다. 남긴 하나는
          서버가 실제로 답해 주는 값이다. */}
      <Card style={{padding:'12px 14px',marginBottom:14,display:'flex',alignItems:'center',gap:12}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:2}}>켜져 있는 자동매매 예약</div>
          <div style={{color:runningCount===null?T.muted:runningCount>0?T.grn:T.sub,fontSize:runningCount===null?12:18,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
            {runningCount===null ? (schedErr||'확인하지 못했습니다') : `${runningCount}개`}
          </div>
          <div style={{color:T.muted,fontSize:10,marginTop:3,lineHeight:1.4}}>
            서버에 등록된 예약 기준입니다 · 아래 전략 목록의 켜짐/꺼짐과는 다릅니다
          </div>
        </div>
      </Card>

      {/* ── 1단계: 묶음 ──
          매일 보는 것(개요)과 가끔 보는 것(진단)을 같은 줄에 두지 않는다. */}
      <div style={{display:'flex',gap:5,marginBottom:6,overflowX:'auto'}}>
        {AUTO_TABS.map(t=>{
          const on = group === t.id;
          return (
            <button key={t.id} onClick={()=>goGroup(autoTabOf(t.id))} style={{flexShrink:0,padding:'8px 13px',background:on?T.acg:'transparent',color:on?T.acl:T.muted,border:`1px solid ${on?T.acl:T.border}`,borderRadius:10,fontSize:11.5,fontWeight:800,cursor:'pointer'}}>{t.label}</button>
          );
        })}
      </div>
      {/* **탭 이름만으로는 무엇이 들었는지 모른다.** 한 줄로 적는다 —
          안 적으면 사용자가 다섯 탭을 다 눌러 보고 나서야 안다. */}
      <div style={{color:T.muted,fontSize:9.5,marginBottom:10,lineHeight:1.55}}>
        {AUTO_TABS.find(t=>t.id===group)?.desc}
      </div>

      {/* ── 2단계: 묶음 안의 화면 ──
          하나뿐이면 선택지를 안 그린다. 고를 것이 없는 선택지는
          화면만 차지하고 아무것도 안 한다. */}
      {members.length > 1 && (
        <div style={{display:'flex',gap:5,marginBottom:14,overflowX:'auto'}}>
          {members.map(([id,l])=>(
            <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'7px 11px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
          ))}
        </div>
      )}

      {/* ── 예약 ──
          예약은 위의 자동매매 판(AutotradeControl)에서 만들고 끈다.
          그 판을 여기서 한 번 더 그리면 같은 화면이 둘이 되고, 둘 중
          하나만 새로 고쳐지면 서로 다른 값을 보여 준다. */}
      {group==='schedule'&&(
        <Card style={{padding:'14px 16px',marginBottom:12}}>
          <div style={{color:T.txt,fontSize:12.5,fontWeight:800,marginBottom:6}}>예약은 맨 위 판에서 켜고 끕니다</div>
          <div style={{color:T.muted,fontSize:10.5,lineHeight:1.7}}>
            실행 주기와 조건은 이 화면 맨 위의 <b style={{color:T.acl}}>자동매매</b> 판에 있습니다.
            여기서 같은 판을 한 번 더 그리지 않는 이유는, 같은 화면이 둘이 되면
            한쪽만 새로 고쳐졌을 때 <b style={{color:T.ylw}}>서로 다른 값</b>을 보여 주기 때문입니다 —
            그러면 어느 쪽이 진짜인지 알 방법이 없습니다.
          </div>
        </Card>
      )}

      {/* ── BOTS ── */}
      {group==='strategies'&&tab==='bots'&&(
        <div>
          {/* **이 목록은 실행기에 연결돼 있지 않다.**
              '시작'을 눌러도 이 화면의 상태만 바뀌고, 어떤 주문도 나가지
              않는다. 실제로 도는 것은 전략빌더에 저장된 전략이다
              (AutoTradeEngine이 브라우저에서 주기적으로 그것을 평가한다 —
              폴링은 60초이지만 앞 tick이 안 끝났으면 건너뛰고, 신호가 난
              전략은 5분간 재평가를 미룬다. 그래서 "60초마다"는 아니다).
              이 줄이 없으면 '실행중'이라고 적힌 카드를 보고 돌고 있다고
              믿게 된다 — 이 저장소에서 이미 한 번 일어난 일이다. */}
          <div style={{
            background:A(T.ylw,'12'), border:`1px solid ${A(T.ylw,'30')}`,
            borderRadius:10, padding:'10px 12px', marginBottom:10,
            color:T.ylw, fontSize:11, lineHeight:1.6,
          }}>
            <b>이 여섯 개는 예시 카드입니다 — 실행기에 연결돼 있지 않습니다.</b><br/>
            [시작]을 눌러도 <b>주문이 나가지 않고</b>, 화면을 나가면 상태가 사라집니다
            (저장하면 돌지 않는 봇이 계속 '실행중'으로 보이기 때문입니다).<br/>
            실제로 도는 것은 <b>더보기 → 전략빌더</b>에서 만든 전략입니다.
            거기서 만들어 활성화하면 <b>앱이 열려 있는 동안</b> 주기적으로 평가합니다 (기본 모의).
          </div>
          {notWiredWarn && (
            <div style={{
              background:A(T.red,'12'), border:`1px solid ${A(T.red,'30')}`,
              borderRadius:10, padding:'10px 12px', marginBottom:10,
              color:T.red, fontSize:11, lineHeight:1.6,
            }}>
              방금 누른 [시작]은 <b>아무 주문도 내지 않았습니다.</b> 위 안내를 보세요.
            </div>
          )}
          {/* ── 칸 필터 ──
              정지된 전략과 실행중인 전략을 같은 크기로 늘어놓으면, 매번
              그 사이를 찾아 스크롤해야 한다. */}
          {(() => {
            const acts = (Array.isArray(strats)?strats:[]).map(s=>activityOf({
              status:s.status, enabled:s.enabled,
              // **점수를 지어내지 않는다.** 지금 이 카드들의 신호 점수를
              // 계산하는 곳이 없으므로 언제나 null이고, 그래서 '기회 근접'은
              // 아직 한 번도 뜨지 않는다 — 그게 사실이다.
              score:null, requiredScore:null,
            }));
            const counts = filterCountsOf(acts);
            return (
              <div style={{display:'flex',gap:5,marginBottom:10,overflowX:'auto'}}>
                {ALL_ACTIVITIES.map(a=>{
                  const on = stratFilter.includes(a);
                  const c = ACTIVITY_TONE[a]==='good'?T.grn:ACTIVITY_TONE[a]==='bad'?T.red:ACTIVITY_TONE[a]==='warn'?T.ylw:T.muted;
                  return (
                    <button key={a} onClick={()=>setStratFilter(p=>p.includes(a)?p.filter(x=>x!==a):[...p,a])}
                      style={{flexShrink:0,minHeight:MIN_CONTROL_TARGET,padding:'5px 10px',borderRadius:8,cursor:'pointer',
                        background:on?A(c,'18'):'transparent',color:on?c:T.muted,
                        border:`1px solid ${on?A(c,'45'):T.border}`,fontSize:10,fontWeight:800}}>
                      {activityLabel(a, STRAT_LIST_WIRED)} {counts[a]}
                    </button>
                  );
                })}
                <button onClick={()=>setStratFilter([])}
                  style={{flexShrink:0,minHeight:MIN_CONTROL_TARGET,padding:'5px 10px',borderRadius:8,cursor:'pointer',
                    background:stratFilter.length===0?T.acg:'transparent',
                    color:stratFilter.length===0?T.acl:T.muted,
                    border:`1px solid ${stratFilter.length===0?T.acl:T.border}`,fontSize:10,fontWeight:800}}>
                  전체 {acts.length}
                </button>
              </div>
            );
          })()}

          {(Array.isArray(strats)?strats:[]).map(s=>{
            const si=STRAT_INFO[s.type];
            const kind=kindOf(s.type);
            const act=activityOf({status:s.status,enabled:s.enabled,score:null,requiredScore:null});
            if(!passesFilter(act,stratFilter)) return null;

            const actTone:CardTone=ACTIVITY_TONE[act];
            const actColor=actTone==='good'?T.grn:actTone==='bad'?T.red:actTone==='warn'?T.ylw:T.muted;
            const acts=actionsOf(act);
            // **값을 만들지 않는다.** 이 카드들의 지표를 계산하는 곳이
            // 아직 없으므로 전부 '—'로 나오고, 무엇이 없는지를 카드가
            // 직접 말한다. 그 목록이 그대로 다음 할 일이 된다.
            // **실제 전략 카드에는 잰 값만 적는다.**
            //
            // 가정값(+N%p)은 연구 화면의 것이다. 여기 오면 사용자는 그
            // 숫자를 자기 전략의 성질로 읽는다 — "우위 10%를 켜면 돈을
            // 번다"는 관찰이 나온 자리가 정확히 그곳이다.
            //
            // 아직 아무도 재지 않았으므로 지금은 전부 '검증된 우위 없음'이
            // 나온다. **비워 두면 사용자는 좋은 뜻으로 읽는다.**
            // ── 이 전략이 어디서 도는가 ──
            //
            // **"화면을 켜 둬야 돈이 되는" 구조를 화면이 먼저 말한다.**
            // 브라우저 엔진이 도는 전략은 탭을 닫으면 멈추고, 그러면
            // 진입한 포지션을 아무도 청산하지 않는다. 사용자가 그걸
            // 알아야 탭을 닫아도 되는지 판단할 수 있다.
            //
            // 서버 예약 여부를 이 화면이 읽지 않으므로 **모른다고 둔다** —
            // '서버에서 돈다'로 치면 사용자가 탭을 닫는다.
            const rt = runtimeOf({
              hasServerSchedule: null, inBrowserEngine: false,
              mode: execMode==='real'?'LIVE':execMode==='paper'?'PAPER':'TESTNET',
            });
            const rows=[
              { key:'runtime', label:'실행 위치', value: rt.label, known: rt.survivesBrowserClose },
              edgeRowOf(null),
              ...cardRowsOf(kind,null),
            ];
            const missing=unwiredFieldsOf(kind,null);
            const envLine=envLineOf(execMode==='real'?'LIVE':execMode==='testnet'?'TESTNET':'PAPER');

            // ── 정지된 전략은 한 줄 ──
            if(isCompact(act)) return (
              <Card key={s.id} style={{padding:'9px 11px',marginBottom:6,borderLeft:`3px solid ${si.color}`}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{color:T.txt,fontSize:11.5,fontWeight:700,overflowWrap:'anywhere'}}>{s.name}</div>
                    <div style={{color:T.muted,fontSize:9,marginTop:1}}>
                      {s.asset} · {s.timeframe} · {KIND_LABEL[kind]}
                    </div>
                  </div>
                  <button onClick={e=>{e.stopPropagation();toggleStrat(s.id);}} style={{flexShrink:0,minHeight:MIN_CONTROL_TARGET,padding:'0 12px',background:A(T.grn,'15'),color:T.grn,border:`1px solid ${A(T.grn,'30')}`,borderRadius:8,fontSize:10,fontWeight:800,cursor:'pointer'}}>시작</button>
                </div>
              </Card>
            );

            return (
              <Card key={s.id} style={{padding:'14px',marginBottom:10,border:`1px solid ${A(actColor,'25')}`,borderLeft:`4px solid ${si.color}`}}>
                {/* Header */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8,gap:8}}>
                  <div style={{display:'flex',gap:8,alignItems:'center',minWidth:0}}>
                    <div style={{position:'relative',width:38,height:38,flexShrink:0}}>
                      <AssetLogo ticker={s.asset} name={s.assetNameKr} size={38} />
                      <div style={{position:'absolute',right:-4,bottom:-4,width:20,height:20,borderRadius:'50%',background:si.color,border:`2px solid ${T.bg||'var(--t-card)'}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11}}>{si.icon}</div>
                    </div>
                    <div style={{minWidth:0}}>
                      <div style={{display:'flex',gap:5,alignItems:'center',flexWrap:'wrap'}}>
                        <span style={{color:T.txt,fontWeight:700,fontSize:13,overflowWrap:'anywhere'}}>{s.name}</span>
                        <span style={{background:A(actColor,'20'),color:actColor,fontSize:9,fontWeight:800,padding:'1px 6px',borderRadius:99}}>{activityLabel(act, STRAT_LIST_WIRED)}</span>
                      </div>
                      <div style={{color:T.muted,fontSize:10,marginTop:2}}>
                        {s.asset} · {s.timeframe} · {KIND_LABEL[kind]}
                      </div>
                    </div>
                  </div>
                  {/* 성적은 표본을 같이 말한다 — 3건짜리 승률은 정보가 아니다.
                      그리고 **잰 적이 없으면 숫자를 내지 않는다.** 이 목록의
                      손익·승률·거래수는 소스에 0으로 박혀 있는 값이라
                      `0원` · `거래 없음`은 확인된 사실이 아니다. */}
                  {(() => {
                    const pl = cardPerfLine(s, STRAT_LIST_WIRED);
                    return (
                      <div style={{textAlign:'right',flexShrink:0}}>
                        <div style={{color:pl.pnl===null?T.muted:pl.pnl>=0?T.grn:T.red,fontSize:12,fontWeight:700,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
                          {pl.pnl===null?UNKNOWN_TEXT:`${pl.pnl>=0?'+':''}${cvt(Math.abs(pl.pnl),currency)}`}
                        </div>
                        <div style={{color:T.muted,fontSize:9,marginTop:1}}>{pl.sample}</div>
                      </div>
                    );
                  })()}
                </div>

                {/* 실행 환경 — 모의/테스트넷/실전이 카드에도 보여야 한다 */}
                <div style={{background:T.alt,borderRadius:7,padding:'5px 8px',marginBottom:8,
                  color:envLine.realMoney?T.red:T.muted,fontSize:9,fontWeight:700}}>
                  {envLine.text}
                </div>

                {/* ── 이 전략이 보고 있는 것 ──
                    예전에는 여기가 자산/레버리지/익절/손절 네 칸이라
                    일곱 전략이 전부 같은 카드였다. 종류마다 다른 칸을
                    보여줘야 왜 서로 다른 전략인지 알 수 있다. */}
                <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:8}}>
                  {rows.map(r=>(
                    <div key={r.key} style={{background:T.alt,borderRadius:7,padding:'5px 8px'}}>
                      <div style={{color:T.muted,fontSize:8}}>{r.label}</div>
                      <div style={{color:r.known?T.txt:T.muted,fontSize:11,fontWeight:700,marginTop:1}}>{r.value}</div>
                    </div>
                  ))}
                </div>

                {/* 익절·손절은 적립 전략에서는 뜻이 없다 */}
                {showsTpSl(kind)&&(
                  <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,marginBottom:8}}>
                    {[{l:'레버리지',v:`${s.leverage}x`},{l:'익절',v:`${s.tp}%`},{l:'손절',v:`${s.sl}%`}].map(r=>(
                      <div key={r.l} style={{background:T.alt,borderRadius:7,padding:'5px 6px',textAlign:'center'}}>
                        <div style={{color:T.muted,fontSize:8}}>{r.l}</div>
                        <div style={{color:T.txt,fontSize:10,fontWeight:700,marginTop:1}}>{r.v}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* **무엇이 아직 계산되지 않는지 카드가 직접 말한다.**
                    빈 칸을 그럴듯한 숫자로 채우는 것보다 이쪽이 낫다 —
                    이 목록이 그대로 "안 붙인 배선 목록"이 된다. */}
                {missing.length>0&&(
                  <div style={{background:A(T.ylw,'10'),border:`1px solid ${A(T.ylw,'25')}`,borderRadius:8,padding:'7px 9px',marginBottom:8,color:T.ylw,fontSize:9,lineHeight:1.55}}>
                    아직 계산되지 않는 값: {missing.join(' · ')} — 지어내지 않고 비워 둡니다
                  </div>
                )}

                {/* Controls — 버튼 세 개가 늘 자리를 차지할 이유가 없다 */}
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <button onClick={e=>{e.stopPropagation();toggleStrat(s.id);}} style={{flex:1,minHeight:MIN_CONTROL_TARGET,padding:'7px',background:acts.primary.id==='pause'?A(T.ylw,'15'):A(T.grn,'15'),color:acts.primary.id==='pause'?T.ylw:T.grn,border:`1px solid ${acts.primary.id==='pause'?A(T.ylw,'30'):A(T.grn,'30')}`,borderRadius:8,fontSize:10.5,fontWeight:800,cursor:'pointer'}}>
                    {acts.primary.label}
                  </button>
                  <button onClick={e=>{e.stopPropagation();setSelStrat(selStrat?.id===s.id?null:s);}} style={{minHeight:MIN_CONTROL_TARGET,padding:'7px 12px',background:T.acg,color:T.acl,border:`1px solid ${A(T.acl,'40')}`,borderRadius:8,fontSize:10.5,fontWeight:800,cursor:'pointer'}}>
                    {acts.secondary.label}
                  </button>
                  <button onClick={e=>{e.stopPropagation();setCardMenu(m=>m===s.id?'':s.id);}} aria-label="더보기" style={{minHeight:MIN_CONTROL_TARGET,minWidth:MIN_CONTROL_TARGET,background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,fontSize:13,fontWeight:800,cursor:'pointer'}}>⋯</button>
                </div>
                {cardMenu===s.id&&(
                  <div style={{display:'flex',gap:6,marginTop:6}}>
                    {acts.inMenu.map(m=>(
                      <button key={m.id} onClick={e=>{e.stopPropagation();setCardMenu('');if(m.id==='settings')setEditStrat(s);else stopStrat(s.id);}}
                        style={{flex:1,minHeight:MIN_CONTROL_TARGET,padding:'6px',background:m.id==='stop'?A(T.red,'12'):'transparent',color:m.id==='stop'?T.red:T.muted,border:`1px solid ${m.id==='stop'?A(T.red,'25'):T.border}`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* Expanded detail */}
                {selStrat?.id===s.id&&(
                  <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
                    <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>전략 파라미터</div>
                    <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                      {Object.entries(s.params).map(([k,v])=>(
                        <div key={k} style={{background:T.alt,borderRadius:7,padding:'6px 8px'}}>
                          <div style={{color:T.muted,fontSize:9}}>{k}</div>
                          <div style={{color:T.txt,fontSize:10,fontWeight:700,marginTop:1}}>{String(v)}</div>
                        </div>
                      ))}
                      <div style={{background:T.alt,borderRadius:7,padding:'6px 8px'}}>
                        <div style={{color:T.muted,fontSize:9}}>일일 최대 손실</div>
                        <div style={{color:T.red,fontSize:10,fontWeight:700,marginTop:1}}>{cvt(s.maxDailyLoss,currency)}</div>
                      </div>
                      <div style={{background:T.alt,borderRadius:7,padding:'6px 8px'}}>
                        <div style={{color:T.muted,fontSize:9}}>최대 포지션</div>
                        <div style={{color:T.acl,fontSize:10,fontWeight:700,marginTop:1}}>{cvt(s.maxPositionSize,currency)}</div>
                      </div>
                    </div>
                    {/* ── 성과 ──
                        **표본을 같이 적는다.** 3건에서 나온 승률 67%는
                        정보가 아니라 우연이고, 그걸 다른 전략의 46%와
                        나란히 놓으면 잘못된 비교가 된다. */}
                    {(() => {
                      const perf = perfSummaryOf(cardPerfInput(s, STRAT_LIST_WIRED));
                      return (
                        <div style={{marginTop:8}}>
                          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
                            {perf.rows.map(r=>(
                              <div key={r.label} style={{background:T.alt,borderRadius:7,padding:'5px 6px',textAlign:'center'}}>
                                <div style={{color:T.muted,fontSize:8}}>{r.label}</div>
                                <div style={{color:r.known?T.txt:T.muted,fontSize:10,fontWeight:700,marginTop:1}}>{r.value}</div>
                              </div>
                            ))}
                          </div>
                          {perf.note&&(
                            <div style={{color:T.ylw,fontSize:9,marginTop:5,lineHeight:1.5}}>⚠️ {perf.note}</div>
                          )}
                        </div>
                      );
                    })()}
                    {/* **여기 있던 'AI 어시스턴트' 조언을 지웠다.**
                        "현재 시장 변동성이 보통 수준으로 설정된 레버리지가
                        적절합니다"라고 적혀 있었는데, 이 화면은 변동성을
                        읽지 않는다. 아무것도 모르면서 안다고 말하는 쪽이
                        아무 말도 안 하는 쪽보다 훨씬 나쁘다. */}
                  </div>
                )}
              </Card>
            );
          })}
          {(Array.isArray(strats)?strats:[]).every(s=>!passesFilter(activityOf({status:s.status,enabled:s.enabled,score:null,requiredScore:null}),stratFilter))&&(
            <div style={{color:T.muted,fontSize:11,textAlign:'center',padding:'18px 10px',lineHeight:1.6}}>
              고른 칸에 해당하는 전략이 없습니다 — 위 필터를 바꿔 보세요
            </div>
          )}
        </div>
      )}

      {/* ── SIGNALS ── */}
      {group==='diagnostics'&&tab==='ai'&&(<>
      {/* AI 서브탭 */}
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {([['decision','의사결정'],['risk','리스크'],['analysis','분석']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setAiSection(id)}
            style={{flex:1,padding:'9px 4px',background:aiSection===id?T.acg:T.card,color:aiSection===id?T.acl:T.muted,border:`1px solid ${aiSection===id?T.acl:T.border}`,borderRadius:11,fontSize:12,fontWeight:800,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* 의사결정: 위원회 → 자산배분 → Tactical → 자기학습 → Meta */}
      {aiSection==='decision'&&(<>
      <CommitteePanel symbols={Array.from(new Set(['BTC', 'ETH', ...strats.map(s => s.asset)])).slice(0, 5)} />
      <StrategyMarketPanel symbols={Array.from(new Set(['BTC', 'ETH', 'SOL', ...strats.map(s => s.asset)])).slice(0, 6)} />
      <DerivativesPanel />
      <AllocationPanel currency={currency} />
      <TacticalPanel symbols={Array.from(new Set(['BTC', 'ETH', ...strats.map(s => s.asset)])).slice(0, 5)} />
      <LearningPanel />
      <StrategyFactoryPanel strategies={strats.map(s => ({ id: s.id, name: s.name, type: (s as any).type, params: (s as any).params }))} />
      <MetaStrategyPanel
        strategies={strats.map(s => ({ id: s.id, name: s.name, enabled: !!(s as any).enabled && s.status !== 'stopped', winRate: (s as any).winRate ?? 0, totalPnl: (s as any).totalPnl ?? 0, trades: (s as any).trades ?? 0 }))}
        onApply={(id, enable) => setStrats(prev => prev.map(s => s.id === id ? { ...s, enabled: enable, status: enable ? 'running' : 'stopped' } as any : s))}
      />
      </>)}

      {/* 리스크: 국면 필터 → ATR 포지션 → Chandelier */}
      {aiSection==='risk'&&(<>
      <EnginePanel />
      <DailySlotPanel />
      <AsymmetryPanel />
      <DailyStrategyPanel />
      <EdgeLabPanel />
      <ChallengePanel />
      <WalkForwardPanel />
      <RegimeFilterPanel strategies={strats.map(s => ({ id: s.id, name: s.name, type: (s as any).type, asset: s.asset }))} />
      <DynamicSizingPanel currency={currency} symbols={Array.from(new Set(['BTC', 'ETH', ...strats.map(s => s.asset)])).slice(0, 5)} />
      <AdaptiveLeveragePanel symbols={Array.from(new Set(['BTC', 'ETH', ...strats.map(s => s.asset)])).slice(0, 5)} />
      <ChandelierPanel />
      </>)}

      {/* 분석: 전략 점수 → 전략 지능 → 감사 로그 */}
      {aiSection==='analysis'&&(<>
      <StrategyScorePanel strategies={strats.map(s => ({ id: s.id, name: s.name, winRate: (s as any).winRate ?? 0, totalPnl: (s as any).totalPnl ?? 0, trades: (s as any).trades ?? 0 }))} />
      <StrategyIntelligence
        strategies={strats.map(s => ({ id: s.id, name: s.name, type: (s as any).type, asset: s.asset, winRate: (s as any).winRate ?? 0, totalPnl: (s as any).totalPnl ?? 0, trades: (s as any).trades ?? 0, enabled: (s as any).enabled }))}
        signals={signals.filter((sg: any) => sg.state !== 'executed').map((sg: any) => ({ stratId: sg.stratId, stratName: sg.stratName, type: (strats.find(st => st.id === sg.stratId) as any)?.type || 'ema_cross', asset: sg.asset, side: sg.type === 'sell' ? 'sell' : 'buy' }))}
        onDisable={(id) => setStrats(prev => prev.map(s => s.id === id ? { ...s, enabled: false, status: 'stopped' } as any : s))}
      />
      <AuditLogPanel currency={currency} />
      </>)}
      </>)}

      {group==='history'&&tab==='signals'&&(
        <div>
          <div style={{background:A(T.ylw,'12'),border:`1px solid ${A(T.ylw,'30')}`,borderRadius:10,padding:'8px 12px',marginBottom:12}}>
            <div style={{color:T.ylw,fontSize:11,fontWeight:700}}>신호 처리 엔진 — 내부 지표 · TradingView · AI (준비중)</div>
          </div>
          {(Array.isArray(signals)?signals:[]).length===0&&(
            /* **비어 있다는 것을 비어 있음으로 보여 준다.**
               카드 세 장을 지우고 아무것도 안 그리면 사용자는 "고장인가"
               라고 읽는다. 어디서 신호가 나오는지 여기서 말한다. */
            <Card style={{padding:'16px',marginBottom:12}}>
              <div style={{color:T.txt,fontSize:12.5,fontWeight:800,marginBottom:6}}>표시할 신호가 없습니다</div>
              <div style={{color:T.muted,fontSize:11,lineHeight:1.7}}>
                이 신호 탭에는 <b style={{color:T.ylw}}>아직 실제 신호 데이터가 연결되어 있지 않습니다.</b><br/>
                <b style={{color:T.acl}}>더보기 → 전략빌더</b>에서 켠 전략은 브라우저 AutoTradeEngine이
                앱이 열려 있는 동안 주기적으로 조건을 평가합니다. 그 결과가 이 탭으로 들어오는 경로는 아직 없습니다.<br/>
                예전에는 여기에 시각·가격·신뢰도가 붙은 예시 카드가 있었지만, 일어난 적 없는 신호라 지웠습니다.
              </div>
            </Card>
          )}
          {(Array.isArray(signals)?signals:[]).map(sig=>(
            <Card key={sig.id} style={{padding:'12px 14px',marginBottom:8,border:`1px solid ${signalColor[sig.state]}20`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:3,flexWrap:'wrap'}}>
                    <span style={{background:sig.type==='buy'?A(T.grn,'20'):A(T.red,'20'),color:sig.type==='buy'?T.grn:T.red,fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:6}}>{sig.type==='buy'?'매수':'매도'}</span>
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
                <div style={{color:T.txt,fontSize:11,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{cvt(sig.price,currency)}</div>
                <div style={{color:T.muted,fontSize:10}}>{sig.note}</div>
              </div>
              <div style={{marginTop:6,height:4,background:'var(--t-border)',borderRadius:2,overflow:'hidden'}}>
                <div style={{height:'100%',width:sig.confidence+'%',background:signalColor[sig.state],borderRadius:2}}/>
              </div>
            </Card>
          ))}
          {/* Webhook placeholder */}
          <Card style={{padding:'14px 16px',border:`1px solid ${A(T.cyn,'30')}`}}>
            <div style={{color:T.cyn,fontWeight:700,fontSize:12,marginBottom:8}}>📺 TradingView Webhook 연동</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6,marginBottom:10}}>TradingView 알림 → TRAIGO 자동 신호 수신. 실행 시 자동으로 봇이 처리합니다.</div>
            <div style={{display:'flex',gap:8}}>
              <input placeholder="https://your-webhook-url.com/signal" style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:11,outline:'none'}}/>
              <button type="button"
                onClick={() => notifyInfo('TradingView Webhook 연동은 곧 출시됩니다. 현재는 더보기 → 전략빌더의 자체 시그널만 동작합니다.')}
                style={{background:A(T.cyn,'20'),color:T.cyn,border:`1px solid ${A(T.cyn,'40')}`,borderRadius:8,padding:'9px 14px',minHeight:MIN_CONTROL_TARGET,fontSize:11,fontWeight:700,cursor:'pointer'}}>저장</button>
            </div>
          </Card>
        </div>
      )}

      {/* ── RISK ── */}
      {group==='diagnostics'&&tab==='risk'&&(() => {
        const rs = loadRiskSettings();
        const modeInfo = MODE_LABEL[rs.mode];
        return (
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12, borderLeft:`3px solid ${modeInfo.color}`}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
              <Shield size={16} strokeWidth={2.2} color={modeInfo.color}/>
              <div style={{flex:1, minWidth:0}}>
                <div style={{color:T.txt,fontWeight:700,fontSize:13}}>글로벌 리스크 설정</div>
                <div style={{color:modeInfo.color, fontSize:10, fontWeight:700}}>{modeInfo.label} · {modeInfo.sub}</div>
              </div>
              <button onClick={() => onNav?.('risk_settings')}
                aria-label="리스크 편집"
                style={{display:'inline-flex',alignItems:'center',gap:4, background:T.acg, color:T.acl,
                  border:`1px solid ${A(T.acl,'40')}`, borderRadius:8, padding:'6px 10px',
                  fontSize:11, fontWeight:700, cursor:'pointer', minHeight:MIN_CONTROL_TARGET}}>
                <Edit3 size={11} strokeWidth={2.4}/>편집
                <ChevronRight size={12} strokeWidth={2.4}/>
              </button>
            </div>
            {[
              {l:'일일 최대 손실',v: rs.dailyMaxLossKRW === null ? '제한 없음' : cvt(rs.dailyMaxLossKRW, currency),sub:'초과 시 전체 자동매매 중단',c:T.red},
              {l:'최대 드로다운',v: rs.maxDrawdownPct === null ? '제한 없음' : `${rs.maxDrawdownPct}%`,sub:'연속 손실 한도',c:T.ylw},
              {l:'최대 레버리지',v:`${rs.maxLeverage}x`,sub:'전략별 레버리지 상한',c:T.ylw},
              {l:'최대 동시 거래',v:`${rs.maxOpenPositions}개`,sub:'오픈 포지션 동시 한도',c:T.acl},
              {l:'연속 손실 정지',v:`${rs.consecutiveLossLimit}회`,sub:'연속 손실 후 쿨다운',c:T.red},
              {l:'쿨다운 시간',v:`${rs.cooldownMinutes}분`,sub:'손실 후 대기 시간',c:T.muted},
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
          <Card style={{padding:'14px 16px',border:`1px solid ${A(T.red,'40')}`}}>
            <div style={{color:T.red,fontWeight:700,marginBottom:6}}>🚨 긴급 정지</div>
            {/* **이 문장이 버튼보다 세면 안 된다.**
                예전에는 "모든 자동매매를 즉시 중단합니다"라고 적혀 있었는데,
                바로 아래 버튼은 등록된 예약을 끌 뿐이고 열린 포지션도
                거래소 주문도 건드리지 않는다 — 같은 카드 안에서 위와
                아래가 서로 다른 말을 하고 있었다. 사용자는 큰 글씨를
                믿는다. */}
            <div style={{color:T.muted,fontSize:11,marginBottom:10,lineHeight:1.5}}>
              서버에 등록된 자동매매 예약을 모두 끕니다.
              새 진입만 막으며 열린 포지션과 기존 거래소 주문은 그대로 남습니다.
            </div>
            <button onClick={handleGlobalStop} disabled={stopResult.code==='STOPPING'} style={{width:'100%',padding:'12px',minHeight:44,background:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:stopResult.code==='STOPPING'?'wait':'pointer',opacity:stopResult.code==='STOPPING'?0.6:1}}>
              {stopResult.code==='STOPPING'?'정지 요청 중…':'등록된 자동매매 예약 전체 끄기'}
            </button>
            <div style={{color:T.muted,fontSize:10,marginTop:6,lineHeight:1.45}}>
              새 진입만 막습니다. 열린 포지션 청산이나 거래소 주문 취소는 하지 않습니다.
            </div>
          </Card>
        </div>
        );
      })()}

      {/* ── RUNS ── */}
      {group==='history'&&tab==='runs'&&(
        <div>
          {/* 실시간 자동매매 실행 로그 */}
          <AutoTradeLogPanel onOpenAsset={onOpenAsset} currency={currency}/>

          <div style={{color:T.txt,fontWeight:700,marginBottom:10,marginTop:16}}>샘플 실행 기록 (UI 데모)</div>
          {runs.map((r,i)=>(
            <Card key={r.id} style={{padding:'12px 14px',marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:2,flexWrap:'wrap'}}>
                    <span style={{background:r.side==='long'?A(T.grn,'15'):A(T.red,'15'),color:r.side==='long'?T.grn:T.red,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:6}}>{r.side==='long'?'롱':'숏'}</span>
                    <span style={{color:T.txt,fontWeight:700,fontSize:12}}>{r.asset}</span>
                    <span style={{background:A(T.prp,'15'),color:T.prp,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:6}}>{r.execMode==='paper'?'모의':r.execMode==='testnet'?'테넷':'실전'}</span>
                  </div>
                  <div style={{color:T.muted,fontSize:10}}>{r.stratName}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:1}}>진입 {cvt(r.entryPrice,currency)}{r.exitPrice?` → ${cvt(r.exitPrice,currency)}`:' (오픈)'}</div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <div style={{color:r.pnl>=0?T.grn:T.red,fontWeight:800,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{r.pnl>=0?'+':''}{cvt(Math.abs(r.pnl),currency)}</div>
                  <div style={{color:r.pnl>=0?T.grn:T.red,fontSize:10}}>{r.pnl>=0?'+':''}{r.pnlPct.toFixed(2)}%</div>
                </div>
              </div>
              <div style={{color:T.muted,fontSize:9}}>{new Date(r.openedAt).toLocaleDateString('ko-KR')}{r.closedAt?` ~ ${new Date(r.closedAt).toLocaleDateString('ko-KR')}`:'  (진행중)'}</div>
            </Card>
          ))}
        </div>
      )}

      {/* ── CREATE ── */}
      {group==='strategies'&&tab==='create'&&(
        <div>
          <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>➕ 새 자동매매 전략 생성</div>
          {/* Strategy type grid */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:8}}>전략 유형 선택</div>
            <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
              {(Object.entries(STRAT_INFO) as [StratType,any][]).map(([key,si])=>(
                <button key={key} onClick={()=>setNewStrat(p=>({...p,type:key}))} style={{background:newStrat.type===key?si.color+'20':T.alt,border:`2px solid ${newStrat.type===key?si.color:T.border}`,borderRadius:12,padding:'10px 10px',cursor:'pointer',textAlign:'left',opacity:1}}>
                  <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:3}}>
                    <span style={{fontSize:14}}>{si.icon}</span>
                    <span style={{color:newStrat.type===key?si.color:T.txt,fontWeight:700,fontSize:11}}>{si.label}</span>
                    {false&&<span style={{display:'none'}}/>}
                  </div>
                  <div style={{color:T.muted,fontSize:9,lineHeight:1.4}}>{si.desc}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Settings */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:10}}>기본 설정</div>
            <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
              {([
                {l:'전략 이름',k:'name',type:'text',ph:'내 EMA 전략',base:undefined,unit:'',ch:14},
                {l:'대상 자산',k:'asset',type:'text',ph:'BTC',base:'BTC',unit:'',ch:8},
                {l:'타임프레임',k:'timeframe',type:'text',ph:'4h',base:STRAT_DEFAULTS.timeframe,unit:'',ch:6},
                {l:'레버리지',k:'leverage',type:'number',ph:'1',base:STRAT_DEFAULTS.leverage,unit:'x',ch:6},
                {l:'익절',k:'tp',type:'number',ph:'5',base:STRAT_DEFAULTS.tp,unit:'%',ch:6},
                {l:'손절',k:'sl',type:'number',ph:'2.5',base:STRAT_DEFAULTS.sl,unit:'%',ch:6},
              ] as const).map(f=>(
                <SettingField key={f.k} label={f.l} value={(newStrat as any)[f.k]} unit={f.unit}
                  base={f.base}
                  onReset={f.base===undefined?undefined:()=>setNewStrat(p=>({...p,[f.k]:f.base as any}))}>
                  <input type={f.type} value={(newStrat as any)[f.k] ?? ''}
                    inputMode={f.type==='number'?'decimal':undefined}
                    onChange={e=>setNewStrat(p=>({...p,[f.k]:f.type==='number'?(parseFloat(e.target.value)||0):e.target.value}))}
                    placeholder={f.ph} style={settingInput(f.ch)}/>
                </SettingField>
              ))}
            </div>
            <div style={{background:A(T.ylw,'12'),border:`1px solid ${A(T.ylw,'30')}`,borderRadius:8,padding:'8px 12px',marginBottom:12}}>
              <div style={{color:T.ylw,fontSize:10,fontWeight:700}}>⚠️ 새 전략은 항상 모의매매 모드로 시작됩니다. 실제 거래 비활성화.</div>
            </div>
            <button onClick={handleCreateStrat} disabled={!newStrat.asset} style={{width:'100%',padding:'12px',background:newStrat.asset?T.acc:'var(--t-border2)',color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer'}}>
              전략 생성 (모의)
            </button>
          </Card>
        </div>
      )}

      {/* Real mode confirm modal */}
      {showConfirmReal&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.8)',zIndex:200}} onClick={()=>setShowConfirmReal(false)}/>
          <div style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:201,background:T.surf,borderRadius:20,padding:`24px 20px calc(24px + env(safe-area-inset-bottom, 0px))`,width:320,border:`2px solid ${T.red}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:T.red,fontWeight:800,fontSize:16,marginBottom:8}}>⚠️ 실전 모드 활성화</div>
            <div style={{color:T.sub,fontSize:12,lineHeight:1.6,marginBottom:16}}>실전 모드에서는 연결된 거래소 API를 통해 실제 주문이 실행됩니다. 원금 손실 위험이 있습니다.<br/><br/>먼저 테스트넷에서 전략을 충분히 검증한 뒤 활성화하세요.</div>
            <button onClick={()=>{setExecMode('real');setShowConfirmReal(false);}} style={{width:'100%',padding:'12px',background:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:800,cursor:'pointer',marginBottom:8}}>실전 모드 활성화</button>
            <button onClick={()=>setShowConfirmReal(false)} style={{width:'100%',padding:'12px',background:A(T.muted,'20'),color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소 (모의 유지)</button>
          </div>
        </>
      )}

      {/* Edit strategy modal */}
      {editStrat&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.8)',zIndex:200}} onClick={()=>setEditStrat(null)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'20px 16px 40px',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:12}}>{editStrat.name} 설정</div>
            {/* 읽기 전용 상자였다. '설정'을 눌러 열었는데 아무것도 못 바꾸는
                화면이면 그건 설정이 아니라 요약이다. 이제 실제로 고쳐진다. */}
            <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 12px',marginBottom:4}}>
              {([
                {k:'leverage',l:'레버리지',unit:'x',type:'number',step:1,ch:6},
                {k:'tp',l:'익절',unit:'%',type:'number',step:0.5,ch:6},
                {k:'sl',l:'손절',unit:'%',type:'number',step:0.5,ch:6},
                {k:'timeframe',l:'타임프레임',unit:'',type:'text',step:undefined,ch:6},
              ] as const).map(f=>(
                <SettingField key={f.k} label={f.l} value={(editStrat as any)[f.k]} unit={f.unit}
                  base={(STRAT_DEFAULTS as any)[f.k]}
                  onReset={()=>setEditStrat(p=>p?{...p,[f.k]:(STRAT_DEFAULTS as any)[f.k]} as any:p)}>
                  <input type={f.type} step={f.step as any}
                    inputMode={f.type==='number'?'decimal':undefined}
                    value={(editStrat as any)[f.k] ?? ''}
                    onChange={e=>setEditStrat(p=>p?{...p,[f.k]:f.type==='number'?(parseFloat(e.target.value)||0):e.target.value} as any:p)}
                    style={settingInput(f.ch)}/>
                </SettingField>
              ))}
            </div>
            <div style={{background:A(T.grn,'12'),border:`1px solid ${A(T.grn,'30')}`,borderRadius:8,padding:'8px 12px',marginBottom:12}}>
              <div style={{color:T.grn,fontSize:10,fontWeight:700}}>설정 변경은 백테스트 후 적용을 권장합니다.</div>
            </div>
            <div style={{display:'flex',gap:8}}>
              {/* 예전에는 '확인'이 그냥 창을 닫기만 했다 — 고친 값이 조용히
                  사라졌다. 저장과 취소를 분리한다. */}
              <button onClick={()=>setEditStrat(null)} style={{flex:1,padding:'12px',background:A(T.muted,'18'),color:T.sub,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>{const e=editStrat; setStrats(p=>p.map(x=>x.id===e.id?{...x,leverage:e.leverage,tp:e.tp,sl:e.sl,timeframe:e.timeframe,riskLevel:e.leverage>5?'high':e.leverage>2?'medium':'low'} as any:x)); setEditStrat(null);}}
                style={{flex:2,padding:'12px',background:T.acc,color:'#fff',border:'none',borderRadius:12,fontWeight:800,cursor:'pointer'}}>저장</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}


/* ── NewsPage ── */

// ─────────────────────────────────────────────────────────────
// AutoTradeLogPanel — 실시간 자동매매 실행 로그 + 모의 잔고
// ─────────────────────────────────────────────────────────────
import { loadLogs, clearLogs } from '@/lib/autotrade/store';
// **모의 잔고는 서버에서만 온다.** 예전에는 loadPaperBalance()로
// localStorage 원화 장부를 읽어 '모의 잔고'라고 적었다 — 지갑 MOCK 탭과
// 다른 숫자가 나오는 자리였다.
import { paperViewOf } from '@/lib/portfolio/paperView';
import { watchAuthToken } from '@/lib/auth/authToken';
import { calcPerformance, calcStrategyPerformance } from '@/lib/autotrade/performance';
import { attributionOf, rowsWithResidual, topMoversOf } from '@/lib/portfolio/attribution';
import { timeWeightedReturn, moneyWeightedReturn, naiveCheck, pnlBreakdown } from '@/lib/portfolio/returns';
import { getTodayPnL, checkRiskGuard, clearCooldown, resetTodayPnL } from '@/lib/risk/guard';
import type { ExecutionLog } from '@/lib/autotrade/types';
// **숫자와 '확인 불가'를 이 화면이 다시 정하지 않는다.** 같은 장부를 보는
// 지갑 화면과 자릿수·부호·문구가 갈리면 사용자는 둘 다 못 믿는다.
import { moneyText, pnlText, qtyText, UNKNOWN_LABEL } from '@/lib/ui/display';
import { Wallet, ListChecks, Trash2, RefreshCw, AlertCircle, CheckCircle2, MinusCircle, Ban, Clock, BarChart3, TrendingUp as TrendingUpIc, TrendingDown as TrendingDownIc } from 'lucide-react';
import { MIN_CONTROL_TARGET } from '@/lib/ui/panelPrefs';
import { cockpitVerdict, cockpitEnvBadge, snapshotSignature } from '@/lib/ui/autoCockpit';

/** 모의 장부 금액 한 칸. **못 읽은 것은 0이 아니다** */
const paperMoney = (v: any): string => {
  const m = moneyText(v, 'USDT');
  return m.known ? m.text : UNKNOWN_LABEL;
};

function AutoTradeLogPanel({ onOpenAsset, currency = 'KRW' }: { onOpenAsset?: (a: any, dest?: string) => void; currency?: string } = {}) {
  const [logs, setLogs]    = useState<ExecutionLog[]>([]);
  // 서버 PAPER 장부. **localStorage를 읽지 않는다** — 읽지 않으므로
  // 로컬 값이 서버 값을 덮을 수 없다.
  const [paperAuth, setPaperAuth] = useState<string | null>(null);
  const [paperPayload, setPaperPayload] = useState<any>(null);
  const [paperLoaded, setPaperLoaded] = useState(false);
  useEffect(() => watchAuthToken(setPaperAuth), []);
  useEffect(() => {
    if (paperAuth == null) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/paper/account', {
          headers: paperAuth ? { Authorization: paperAuth } : undefined,
        });
        const j = await r.json().catch(() => null);
        if (alive) setPaperPayload(j);
      } catch {
        if (alive) setPaperPayload(null);   // 못 읽은 것을 0으로 두지 않는다
      } finally { if (alive) setPaperLoaded(true); }
    })();
    return () => { alive = false; };
  }, [paperAuth]);
  const paper = paperViewOf({ loaded: paperLoaded, payload: paperPayload });
  const [filter, setFilter] = useState<'all'|'triggered'|'skipped'|'error'>('all');
  const [todayPnL, setTodayPnL] = useState(() => getTodayPnL());
  const [guard, setGuard] = useState(() => checkRiskGuard());
  const [riskMode, setRiskMode] = useState(() => loadRiskSettings().mode);
  const [userStrategies, setUserStrategies] = useState<any[]>([]);

  const refresh = useCallback(() => {
    setLogs(loadLogs());
    setTodayPnL(getTodayPnL());
    setGuard(checkRiskGuard());
    setRiskMode(loadRiskSettings().mode);
    import('@/lib/strategies/store').then(m => setUserStrategies(m.listStrategies())).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);   // 10초마다 자동 갱신
    return () => clearInterval(t);
  }, [refresh]);

  const filtered = filter === 'all' ? logs : logs.filter(l => l.status === filter);
  const perf = calcPerformance(logs);
  const stratPerf = calcStrategyPerformance(logs, userStrategies);
  // 자동 비활성화 — 성과 나쁜 활성 전략 끄기
  const autoDisable = useCallback(async (id: string) => {
    try {
      const m = await import('@/lib/strategies/store');
      m.toggleEnabled(id, false);
      refresh();
    } catch {}
  }, [refresh]);
  const positionCount = paper.positions.length;

  return (
    <div style={{marginBottom:12}}>
      {/* 리스크 가드 + 오늘 PnL */}
      <Card style={{
        padding:'14px 16px',marginBottom:10,
        borderLeft: `3px solid ${guard.pass ? T.grn : T.red}`,
      }}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8,flexWrap:'wrap'}}>
          <Shield size={14} strokeWidth={2.2} color={guard.pass ? T.grn : T.red}/>
          <span style={{color:T.txt,fontWeight:800,fontSize:13}}>리스크 가드</span>
          <span style={{
            padding:'2px 7px',borderRadius:4,fontSize:9,fontWeight:800,
            background: MODE_LABEL[riskMode].color + '22',
            color: MODE_LABEL[riskMode].color,
          }}>{MODE_LABEL[riskMode].label}</span>
          <span style={{
            marginLeft:'auto', padding:'2px 7px',borderRadius:4,fontSize:9,fontWeight:800,
            background: guard.pass ? A(T.grn,'22') : A(T.red,'22'),
            color:      guard.pass ? T.grn       : T.red,
          }}>
            {guard.pass ? '정상 작동' : '정지됨'}
          </span>
        </div>

        {/* 오늘 PnL + 한도 */}
        <div style={{marginBottom: guard.todayLimit ? 8 : 0}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:4}}>
            <span style={{color:T.muted,fontSize:10,fontWeight:700,display:'inline-flex',alignItems:'center',gap:4}}>
              {todayPnL.pnl >= 0
                ? <TrendingUpIc size={11} strokeWidth={2.4} color={T.grn}/>
                : <TrendingDownIc size={11} strokeWidth={2.4} color={T.red}/>}
              오늘 PnL ({todayPnL.trades}건)
            </span>
            <span style={{color: todayPnL.pnl >= 0 ? T.grn : T.red, fontWeight:900, fontSize:14, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
              {todayPnL.pnl >= 0 ? '+' : ''}{cvt(Math.abs(Math.floor(todayPnL.pnl)), currency)}
            </span>
          </div>

          {/* 일일 한도 진행 바 */}
          {guard.todayLimit != null && (
            <>
              <div style={{height:6, background: T.alt, borderRadius:3, overflow:'hidden', position:'relative'}}>
                {todayPnL.pnl < 0 && (() => {
                  const usedPct = Math.min(100, (-todayPnL.pnl / guard.todayLimit) * 100);
                  const barColor = usedPct >= 90 ? T.red : usedPct >= 70 ? T.ylw : T.grn;
                  return (
                    <div style={{
                      width: `${usedPct}%`, height:'100%',
                      background: barColor,
                      transition: 'width 300ms',
                    }}/>
                  );
                })()}
              </div>
              <div style={{display:'flex',justifyContent:'space-between',marginTop:3,fontSize:9,color:T.muted}}>
                <span>한도까지 남음: {cvt(Math.floor(Math.max(0, guard.todayLimit + Math.min(0, todayPnL.pnl))), currency)}</span>
                <span>한도: -{cvt(guard.todayLimit, currency)}</span>
              </div>
            </>
          )}
        </div>

        {/* 연속 손실 + 쿨다운 표시 */}
        {(guard.consecutive > 0 || guard.cooldownUntil > Date.now()) && (
          <div style={{display:'flex',gap:6,marginTop:6,flexWrap:'wrap'}}>
            {guard.consecutive > 0 && (
              <div style={{
                padding:'4px 9px', borderRadius:6, fontSize:10, fontWeight:700,
                background: guard.consecutive >= guard.consecutiveLimit ? A(T.red,'20') : A(T.ylw,'20'),
                color:      guard.consecutive >= guard.consecutiveLimit ? T.red      : T.ylw,
                border: `1px solid ${guard.consecutive >= guard.consecutiveLimit ? T.red : T.ylw}30`,
              }}>
                연속 손실 {guard.consecutive}/{guard.consecutiveLimit}
              </div>
            )}
            {guard.cooldownUntil > Date.now() && (
              <div style={{
                padding:'4px 9px', borderRadius:6, fontSize:10, fontWeight:700,
                background: A(T.ylw,'20'), color: T.ylw,
                border: `1px solid ${A(T.ylw,'30')}`,
                display:'inline-flex', alignItems:'center', gap:4,
              }}>
                <Clock size={10} strokeWidth={2.4}/>
                쿨다운 {Math.ceil((guard.cooldownUntil - Date.now()) / 60_000)}분 남음
                <button onClick={() => { clearCooldown(); refresh(); }}
                  aria-label="쿨다운 해제"
                  style={{marginLeft:4,background:'transparent',color:T.ylw,border:`1px solid ${A(T.ylw,'50')}`,borderRadius:4,padding:'1px 6px',fontSize:9,cursor:'pointer'}}>
                  해제
                </button>
              </div>
            )}
          </div>
        )}

        {!guard.pass && guard.reason && (
          <div style={{
            marginTop:8, padding:'7px 10px',
            background: A(T.red,'10'), border: `1px solid ${A(T.red,'30')}`,
            borderRadius:6, color: T.red, fontSize: 11, lineHeight: 1.4,
          }}>
            {guard.reason}
          </div>
        )}

        {/* 빠른 액션 */}
        <div style={{display:'flex',gap:5,marginTop:8}}>
          <button onClick={async () => {
              if ((await confirmDialog('오늘의 PnL과 연속 손실 카운터를 초기화하시겠습니까?', { danger: true }))) {
                resetTodayPnL(); refresh();
              }
            }}
            style={{flex:1,minHeight:MIN_CONTROL_TARGET,background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,padding:'5px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
            오늘 PnL 리셋
          </button>
        </div>
      </Card>

      {/* 실시간 성과 모니터링 */}
      {perf.totalTrades > 0 && (
        <Card style={{padding:'14px 16px',marginBottom:10, borderLeft:`3px solid ${T.prp}`}}>
          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10}}>
            <BarChart3 size={14} strokeWidth={2.2} color={T.prp}/>
            <span style={{color:T.txt,fontWeight:800,fontSize:13}}>실시간 성과</span>
            <span style={{marginLeft:'auto',color:T.muted,fontSize:10}}>{perf.totalTrades}건 청산</span>
          </div>

          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,marginBottom:6}}>
            {[
              { l:'승률', v:`${perf.winRate}%`, c: perf.winRate >= 50 ? T.grn : T.red, sub:`${perf.wins}승 ${perf.losses}패` },
              { l:'손익비', v: perf.profitFactor >= 999 ? '∞' : `${perf.profitFactor}`, c: perf.profitFactor >= 1.5 ? T.grn : perf.profitFactor >= 1 ? T.ylw : T.red, sub:'PF' },
              { l:'기대값', v:`${perf.expectancy >= 0 ? '+' : ''}${(perf.expectancy/10000).toFixed(1)}만`, c: perf.expectancy >= 0 ? T.grn : T.red, sub:'1거래당' },
            ].map(m => (
              <div key={m.l} style={{background:T.alt,padding:'8px 10px',borderRadius:8,border:`1px solid ${T.border}`}}>
                <div style={{color:T.muted,fontSize:9,marginBottom:2}}>{m.l}</div>
                <div style={{color:m.c,fontWeight:900,fontSize:15,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{m.v}</div>
                <div style={{color:T.muted,fontSize:8,marginTop:1}}>{m.sub}</div>
              </div>
            ))}
          </div>

          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6}}>
            {[
              { l:'최대 낙폭', v:`-${(perf.maxDrawdown/10000).toFixed(1)}만`, c: T.red, sub:`${perf.maxDrawdownPct}%` },
              { l:'연속 손실', v:`${perf.curConsecLoss}`, c: perf.curConsecLoss >= 3 ? T.red : T.ylw, sub:`최대 ${perf.maxConsecLoss}` },
              { l:'평균 손익', v:`${perf.avgWin > 0 ? '+'+(perf.avgWin/10000).toFixed(1) : '0'}/${perf.avgLoss > 0 ? '-'+(perf.avgLoss/10000).toFixed(1) : '0'}`, c: T.muted, sub:'익/손 만원' },
            ].map(m => (
              <div key={m.l} style={{background:T.alt,padding:'8px 10px',borderRadius:8,border:`1px solid ${T.border}`}}>
                <div style={{color:T.muted,fontSize:9,marginBottom:2}}>{m.l}</div>
                <div style={{color:m.c,fontWeight:900,fontSize:14,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{m.v}</div>
                <div style={{color:T.muted,fontSize:8,marginTop:1}}>{m.sub}</div>
              </div>
            ))}
          </div>

          {perf.curConsecLoss >= 3 && (
            <div style={{marginTop:8,padding:'7px 10px',background:A(T.red,'10'),border:`1px solid ${A(T.red,'30')}`,borderRadius:6,color:T.red,fontSize:10,lineHeight:1.4}}>
              ⚠️ 연속 {perf.curConsecLoss}회 손실 중 — 전략 점검을 권장합니다
            </div>
          )}
        </Card>
      )}

      {/* ── 성과 귀속 ──
          "총손익 +₩120,000"만으로는 무엇을 해야 할지 알 수 없다. 전략이
          스무 개일 때, 하나가 벌고 열아홉이 잃는 상황과 스물이 조금씩 버는
          상황이 화면에서 똑같이 보인다 — 그 둘은 다음에 할 일이 정반대다.

          그리고 이 카드는 **합이 맞는지 검사한다.** calcStrategyPerformance는
          strategyId가 없는 기록을 빼고 세는데(`if (!log.strategyId) continue`),
          calcPerformance는 전부 센다. 그래서 전략 태그가 안 붙은 체결이 있으면
          두 숫자가 갈리고, 지금까지는 그 사실이 어디에도 안 떴다. */}
      {stratPerf.filter(sp => sp.metrics.totalTrades > 0).length > 0 && (() => {
        const attr = attributionOf(
          stratPerf.filter(sp => sp.metrics.totalTrades > 0)
            .map(sp => ({ key: sp.strategyId, label: sp.strategyName, amount: sp.metrics.totalPnl })),
          perf.totalPnl,
        );
        const rows = rowsWithResidual(attr);
        const movers = topMoversOf(attr);
        return (
          <Card style={{padding:'14px 16px',marginBottom:10, borderLeft:`3px solid ${T.prp}`}}>
            <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
              <BarChart3 size={14} strokeWidth={2.2} color={T.prp}/>
              <span style={{color:T.txt,fontWeight:800,fontSize:13}}>성과 귀속 — 무엇이 벌었나</span>
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:5}}>
              {rows.map(r=>{
                const resid = r.key === '__unexplained__';
                const c = resid ? T.ylw : r.amount >= 0 ? T.grn : T.red;
                return (
                  <div key={r.key} style={{display:'flex',alignItems:'center',gap:8}}>
                    <span style={{color:resid?T.ylw:T.sub,fontSize:11,flex:1,minWidth:0,overflowWrap:'anywhere'}}>{r.label}</span>
                    {!resid && r.known && (
                      <span style={{color:T.muted,fontSize:9,flexShrink:0}}>{r.sharePct.toFixed(0)}%</span>
                    )}
                    <span style={{color:r.known?c:T.muted,fontSize:11,fontWeight:800,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',flexShrink:0}}>
                      {r.known?`${r.amount>=0?'+':''}${cvt(Math.abs(r.amount),currency)}`:'—'}
                    </span>
                  </div>
                );
              })}
            </div>
            {/* **합이 안 맞으면 숨기지 않는다.** 남는 만큼을 아무 항목에나
                얹으면 화면은 깔끔해지지만, 그게 대개 진짜 문제다. */}
            {attr.reason && (
              <div style={{marginTop:8,background:A(T.ylw,'10'),border:`1px solid ${A(T.ylw,'25')}`,borderRadius:8,padding:'7px 9px',color:T.ylw,fontSize:9.5,lineHeight:1.55}}>
                ⚠️ {attr.reason}
              </div>
            )}
            <div style={{color:T.muted,fontSize:9.5,marginTop:7,lineHeight:1.55}}>{movers.summary}</div>
          </Card>
        );
      })()}

      {/* 전략 포트폴리오 */}
      {stratPerf.filter(sp => sp.metrics.totalTrades > 0).length > 0 && (
        <Card style={{padding:'14px 16px',marginBottom:10, borderLeft:`3px solid ${T.acl}`}}>
          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10}}>
            <ListChecks size={14} strokeWidth={2.2} color={T.acl}/>
            <span style={{color:T.txt,fontWeight:800,fontSize:13}}>전략 포트폴리오</span>
            <span style={{marginLeft:'auto',color:T.muted,fontSize:10}}>{stratPerf.length}개 전략</span>
          </div>

          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {stratPerf.filter(sp => sp.metrics.totalTrades > 0).map(sp => {
              const hc = sp.health === 'healthy' ? T.grn : sp.health === 'watch' ? T.ylw : T.red;
              const hl = sp.health === 'healthy' ? '양호' : sp.health === 'watch' ? '관찰' : '부진';
              return (
                <div key={sp.strategyId} style={{background:T.alt,borderRadius:8,padding:'9px 11px',borderLeft:`2px solid ${hc}`}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:6,marginBottom:3}}>
                    <span style={{color:T.txt,fontWeight:700,fontSize:11,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{sp.strategyName}</span>
                    <span style={{flexShrink:0,padding:'1px 7px',borderRadius:4,fontSize:8,fontWeight:800,background:hc+'22',color:hc}}>{hl}</span>
                  </div>
                  <div style={{display:'flex',gap:10,fontSize:9,color:T.muted}}>
                    <span>승률 <b style={{color:T.txt}}>{sp.metrics.winRate}%</b></span>
                    <span>손익비 <b style={{color:sp.metrics.profitFactor>=1.2?T.grn:T.red}}>{sp.metrics.profitFactor>=999?'∞':sp.metrics.profitFactor}</b></span>
                    <span>PnL <b style={{color:sp.metrics.totalPnl>=0?T.grn:T.red}}>{sp.metrics.totalPnl>=0?'+':''}{(sp.metrics.totalPnl/10000).toFixed(1)}만</b></span>
                    <span>{sp.metrics.totalTrades}건</span>
                  </div>
                  {/* ── 이 전략에 돈이 얼마나 걸려 있는가 ──
                      승률과 손익비만 있으면 "얘가 잘한다"는 알아도
                      **"얘한테 얼마가 걸려 있나"는 모른다.** 승률 70%인
                      전략에 10만원이 걸려 있고 승률 40%인 전략에 500만원이
                      걸려 있으면, 잘하는 쪽을 봐도 계좌는 망한다.

                      배정·위험은 아직 계산하는 곳이 없어 '—'로 나온다.
                      0으로 적지 않는 이유는 배정 0이 '돈을 안 맡겼다'는
                      뜻이고 그건 '아직 계산 안 됨'과 전혀 다르기 때문이다. */}
                  {(() => {
                    const money = moneyRowsOf({
                      pnl: sp.metrics.totalPnl,
                      allocated: null, equity: null, riskPct: null,
                      openPositions: null,
                    });
                    return (
                      <div style={{display:'flex',gap:10,flexWrap:'wrap',fontSize:9,color:T.muted,marginTop:3}}>
                        {money.map(r=>(
                          <span key={r.label}>
                            {r.label} <b style={{color:r.known?T.txt:T.muted}}>{r.value}</b>
                          </span>
                        ))}
                      </div>
                    );
                  })()}

                  {sp.shouldDisable && sp.enabled && (
                    <div style={{display:'flex',alignItems:'center',gap:6,marginTop:6,padding:'5px 8px',background:A(T.red,'12'),borderRadius:6}}>
                      <span style={{flex:1,color:T.red,fontSize:9,lineHeight:1.3}}>⚠️ {sp.healthReason} — 비활성화 권장</span>
                      <button onClick={() => autoDisable(sp.strategyId)}
                        style={{flexShrink:0,background:T.red,color:'#fff',border:'none',borderRadius:5,padding:'3px 9px',fontSize:9,fontWeight:700,cursor:'pointer'}}>
                        끄기
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{color:T.muted,fontSize:9,marginTop:8,lineHeight:1.4}}>
            손익비 0.8 미만 또는 연속손실 4회 = 자동 비활성화 권장. 성과 좋은 전략에 집중하세요.
          </div>
        </Card>
      )}

      {/* ── 모의 잔고 카드 ──
          **서버 PAPER 장부에서만 온다.** 예전에는 localStorage의 원화
          장부를 읽어 '모의 잔고'라고 적었고, 지갑 MOCK 탭은 서버를 읽었다 —
          같은 계좌를 두 화면이 다른 숫자로 보여 줬다.

          이 카드만 표시 계층으로 옮겼다. AutoPage의 나머지는 아직
          예전 포맷이 많아 파일 전체를 잠그지 않는다 — 대신 이 구간만
          `partial-migrated` 계약으로 잠근다
          (scripts/check-display-layer.mjs). 표식을 지우면 검사가
          실패한다. */}
      {/* partial-migrated: AUTOPAGE-PAPER-CARD start */}
      <Card style={{padding:'14px 16px',marginBottom:10, borderLeft:`3px solid ${T.acl}`}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
          <Wallet size={14} strokeWidth={2.2} color={T.acl}/>
          <span style={{color:T.txt,fontWeight:800,fontSize:13}}>모의 잔고 (Paper)</span>
          <span style={{marginLeft:'auto',color:T.muted,fontSize:9}}>USDT · 서버 장부</span>
        </div>

        {paper.code !== 'READY' ? (
          // **없는 숫자를 0으로 그리지 않는다.** 못 읽음·미시작·조회 중을
          // 각각 다른 문장으로 말한다.
          <div style={{color:paper.code==='UNREADABLE'?T.ylw:T.muted,fontSize:10,lineHeight:1.6}}>
            {paper.note}
            {paper.code==='NOT_STARTED' && <div style={{marginTop:4}}>모의투자 화면에서 시작할 수 있습니다.</div>}
          </div>
        ) : (
        <>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6}}>
          <div style={{background:T.alt,padding:'8px 10px',borderRadius:8,border:`1px solid ${T.border}`}}>
            <div style={{color:T.muted,fontSize:9,marginBottom:2}}>현금</div>
            <div style={{color:T.txt,fontWeight:800,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
              {paperMoney(paper.cash)}
            </div>
          </div>
          <div style={{background:T.alt,padding:'8px 10px',borderRadius:8,border:`1px solid ${T.border}`}}>
            <div style={{color:T.muted,fontSize:9,marginBottom:2}}>보유 {positionCount}개 · 증거금</div>
            <div style={{color:T.txt,fontWeight:800,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
              {paperMoney(paper.usedMargin)}
            </div>
          </div>
          {/* **모르는 손익을 초록으로 그리지 않는다.** 예전에는 `?? 0`이라
              실현손익을 못 읽으면 0으로 읽혀 이익인 것처럼 초록 박스가 떴다. */}
          {(() => {
            const r = pnlText(paper.realizedPnl, 'USDT');
            const c = r.tone === 'good' ? T.grn : r.tone === 'bad' ? T.red : T.muted;
            return (
              <div style={{background:A(c,'15'),padding:'8px 10px',borderRadius:8,border:`1px solid ${c}40`}}>
                <div style={{color:c,fontSize:9,marginBottom:2}}>실현손익</div>
                <div style={{color:c,fontWeight:800,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
                  {r.known ? r.text : UNKNOWN_LABEL}
                </div>
              </div>
            );
          })()}
        </div>
        {positionCount > 0 && (
          <div style={{marginTop:8,fontSize:10,color:T.muted}}>
            보유: {paper.positions.map(p => `${p.symbol ?? UNKNOWN_LABEL} ${qtyText(p.quantity).text}`).join(' · ')}
          </div>
        )}
        {/* 이 화면은 실현손익만 보여 준다. 총자산·오늘 손익·자산곡선은
            지갑의 모의 탭이 **같은 장부**로 그린다. */}
        <div style={{marginTop:8,fontSize:9,color:T.muted,lineHeight:1.55}}>
          지갑의 모의 탭과 같은 장부입니다. 총자산·오늘 손익은 그쪽에서 봅니다.
        </div>
        </>
        )}
      </Card>
      {/* partial-migrated: AUTOPAGE-PAPER-CARD end */}

      {/* 실행 로그 헤더 */}
      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
        <ListChecks size={14} strokeWidth={2.2} color={T.acl}/>
        <span style={{color:T.txt,fontWeight:800,fontSize:13}}>자동매매 실행 로그</span>
        <span style={{color:T.muted,fontSize:10}}>({filtered.length}/{logs.length})</span>
        <button onClick={refresh}
          aria-label="새로고침"
          style={{marginLeft:'auto',background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,padding:'4px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
          새로고침
        </button>
        {logs.length > 0 && (
          <button onClick={async () => { if((await confirmDialog('실행 로그를 모두 삭제하시겠습니까?', { danger: true }))){clearLogs();refresh();} }}
            aria-label="로그 삭제"
            style={{background:A(T.red,'15'),color:T.red,border:`1px solid ${A(T.red,'30')}`,borderRadius:6,padding:'4px 8px',fontSize:10,fontWeight:700,cursor:'pointer',display:'inline-flex',alignItems:'center',gap:3}}>
            <Trash2 size={10} strokeWidth={2.4}/>삭제
          </button>
        )}
      </div>

      {/* 필터 */}
      <div style={{display:'flex',gap:4,marginBottom:8,overflowX:'auto'}}>
        {([
          {id:'all',       label:'전체',    color:T.acl},
          {id:'triggered', label:'체결',    color:T.grn},
          {id:'skipped',   label:'건너뜀',  color:T.muted},
          {id:'error',     label:'오류/차단',color:T.red},
        ] as const).map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            style={{flexShrink:0,padding:'5px 10px',background:filter===f.id?f.color+'22':T.alt,color:filter===f.id?f.color:T.muted,border:`1px solid ${filter===f.id?f.color:T.border}`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>
            {f.label}
          </button>
        ))}
      </div>

      {/* 로그 리스트 */}
      {filtered.length === 0 ? (
        <Card style={{padding:'24px',textAlign:'center'}}>
          <div style={{color:T.muted,fontSize:11,marginBottom:6}}>
            {logs.length === 0 ? '아직 실행 로그가 없습니다' : '필터 조건에 맞는 로그가 없습니다'}
          </div>
          <div style={{color:T.muted,fontSize:10,lineHeight:1.6}}>
            {logs.length === 0 ? '더보기 → 전략빌더에서 전략을 만들고 활성화하면\n앱이 열려 있는 동안 주기적으로 시그널을 평가합니다 (모의 모드 기본)' : ''}
          </div>
        </Card>
      ) : (
        filtered.slice(0, 50).map(log => {
          const sIcon = log.status === 'triggered' ? <CheckCircle2 size={12} strokeWidth={2.4} color={T.grn}/>
                     : log.status === 'skipped'   ? <MinusCircle size={12} strokeWidth={2.4} color={T.muted}/>
                     : log.status === 'blocked'   ? <Ban size={12} strokeWidth={2.4} color={T.ylw}/>
                     :                              <AlertCircle size={12} strokeWidth={2.4} color={T.red}/>;
          const sColor = log.status === 'triggered' ? T.grn
                       : log.status === 'skipped'   ? T.muted
                       : log.status === 'blocked'   ? T.ylw
                       :                              T.red;
          const sLabel = log.status === 'triggered' ? '체결'
                       : log.status === 'skipped'   ? '건너뜀'
                       : log.status === 'blocked'   ? '차단'
                       :                              '오류';
          const timeLabel = (() => {
            const diff = Date.now() - log.at;
            const mins = Math.floor(diff / 60000);
            if (mins < 1)    return '방금';
            if (mins < 60)   return `${mins}분 전`;
            if (mins < 1440) return `${Math.floor(mins/60)}시간 전`;
            return new Date(log.at).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
          })();
          return (
            <Card key={log.id} style={{padding:'10px 12px',marginBottom:6,borderLeft:`3px solid ${sColor}`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8,marginBottom:4}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:2,flexWrap:'wrap'}}>
                    {sIcon}
                    <span style={{color:sColor,fontWeight:800,fontSize:10}}>{sLabel}</span>
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onOpenAsset) {
                          onOpenAsset({
                            id: log.asset, sym: log.asset, nameKr: log.asset, name: log.asset,
                            p: log.filledPrice || 0, c: 0, t: 'crypto', clr: '#60A5FA',
                          }, 'trading');
                        }
                      }}
                      role={onOpenAsset ? 'button' : undefined}
                      tabIndex={onOpenAsset ? 0 : undefined}
                      onKeyDown={(e) => {
                        if (onOpenAsset && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          onOpenAsset({
                            id: log.asset, sym: log.asset, nameKr: log.asset, name: log.asset,
                            p: log.filledPrice || 0, c: 0, t: 'crypto', clr: '#60A5FA',
                          }, 'trading');
                        }
                      }}
                      style={{
                        color: T.txt, fontWeight:700, fontSize:12,
                        cursor: onOpenAsset ? 'pointer' : 'default',
                        textDecoration: onOpenAsset ? 'underline' : 'none',
                        textDecorationStyle: 'dotted',
                        textDecorationColor: T.muted,
                        textUnderlineOffset: 2,
                      }}>{log.asset}</span>
                    <span style={{padding:'1px 5px',background:log.action==='buy'?A(T.grn,'22'):A(T.red,'22'),color:log.action==='buy'?T.grn:T.red,borderRadius:4,fontSize:9,fontWeight:800}}>
                      {log.action==='buy'?'매수':'매도'}
                    </span>
                    <span style={{padding:'1px 5px',background:T.alt,color:T.muted,borderRadius:4,fontSize:9,fontWeight:700}}>
                      {log.mode==='paper'?'모의':log.mode==='testnet'?'테넷':'실전'}
                    </span>
                  </div>
                  <div style={{color:T.muted,fontSize:10,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{log.strategyName}</div>
                </div>
                <div style={{color:T.muted,fontSize:9,flexShrink:0}}>{timeLabel}</div>
              </div>
              {log.status === 'triggered' && log.filledPrice && log.filledAmount && (
                <div style={{color:T.txt,fontSize:11,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',background:A(T.grn,'10'),padding:'5px 8px',borderRadius:6,marginTop:4}}>
                  체결가 {cvt(Math.floor(log.filledPrice), currency)} · {cvt(Math.floor(log.filledAmount), currency)}
                  {log.filledQuantity && ` (${log.filledQuantity.toFixed(6)})`}
                </div>
              )}
              <div style={{color:T.muted,fontSize:10,marginTop:3}}>
                조건 {log.conditionsPass}/{log.conditionsAll} 통과
                {log.indicators.rsi != null && ` · RSI ${log.indicators.rsi.toFixed(1)}`}
                {log.indicators.currentPrice != null && ` · 현재가 ${log.indicators.currentPrice.toFixed(2)}`}
              </div>
              {log.reason && (
                <div style={{color:sColor,fontSize:10,marginTop:3,lineHeight:1.4}}>{log.reason}</div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}


export default AutoPage;
