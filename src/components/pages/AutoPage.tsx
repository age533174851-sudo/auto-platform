'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { confirmDialog } from '@/lib/confirm/dialog';
import { notifyInfo, notifySuccess } from '@/lib/notify/center';
import { T, CURRENCIES } from '@/lib/constants';
import { cvt, fmt, fmtPct, gS, sS, uid } from '@/lib/utils';
import type { Asset } from '@/types';
import { Card } from './SharedUI';
import AssetLogo from '../AssetLogo';
import { loadSettings as loadRiskSettings, MODE_LABEL } from '@/lib/risk/store';
import { Shield, Edit3, ChevronRight } from 'lucide-react';
import AutoStatusBoard from '../AutoStatusBoard';
import StrategyIntelligence from '../StrategyIntelligence';
import RegimeFilterPanel from '../RegimeFilterPanel';
import CommitteePanel from '../CommitteePanel';
import AllocationPanel from '../AllocationPanel';
import TacticalPanel from '../TacticalPanel';
import LearningPanel from '../LearningPanel';
import StrategyFactoryPanel from '../StrategyFactoryPanel';
import DynamicSizingPanel from '../DynamicSizingPanel';
import ChandelierPanel from '../ChandelierPanel';
import StrategyScorePanel from '../StrategyScorePanel';
import MetaStrategyPanel from '../MetaStrategyPanel';
import AuditLogPanel from '../AuditLogPanel';

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

const INITIAL_STRATS:Strategy[] = [
  {id:'s1',name:'BTC EMA 추세 추종',type:'ema_cross',status:'running',asset:'BTC',assetNameKr:'비트코인',timeframe:'4h',leverage:2,maxLeverage:5,riskLevel:'medium',tp:5,sl:2.5,enabled:true,winRate:67,totalPnl:847000,trades:18,maxDailyLoss:500000,maxPositionSize:3000000,cooldownMin:60,params:{ema_fast:20,ema_slow:60,rsi_filter:true,rsi_min:40,rsi_max:70},description:'EMA20/60 크로스 + RSI 40~70 필터'},
  {id:'s2',name:'ETH RSI 반전',type:'rsi_reversal',status:'paused',asset:'ETH',assetNameKr:'이더리움',timeframe:'1h',leverage:1,maxLeverage:3,riskLevel:'low',tp:4,sl:2,enabled:true,winRate:58,totalPnl:312000,trades:12,maxDailyLoss:200000,maxPositionSize:2000000,cooldownMin:120,params:{rsi_ob:70,rsi_os:30,rsi_period:14},description:'RSI 30↓ 매수 · RSI 70↑ 매도'},
  {id:'s3',name:'SOL 브레이크아웃',type:'breakout',status:'stopped',asset:'SOL',assetNameKr:'솔라나',timeframe:'15m',leverage:3,maxLeverage:10,riskLevel:'high',tp:8,sl:3,enabled:false,winRate:71,totalPnl:224400,trades:7,maxDailyLoss:300000,maxPositionSize:1500000,cooldownMin:30,params:{bb_period:20,bb_std:2,vol_mult:1.5},description:'볼린저밴드 상단/하단 돌파'},
  {id:'s4',name:'BTC DCA 적립',type:'dca',status:'running',asset:'BTC',assetNameKr:'비트코인',timeframe:'1d',leverage:1,maxLeverage:1,riskLevel:'low',tp:50,sl:20,enabled:true,winRate:83,totalPnl:1240000,trades:24,maxDailyLoss:1000000,maxPositionSize:5000000,cooldownMin:1440,params:{interval_days:7,amount_krw:300000,max_entries:10},description:'주 1회 BTC 정기 매수 DCA'},
  {id:'s5',name:'BTC 펀딩비 전략',type:'funding_rate',status:'stopped',asset:'BTC',assetNameKr:'비트코인',timeframe:'4h',leverage:2,maxLeverage:5,riskLevel:'medium',tp:3,sl:1.5,enabled:false,winRate:62,totalPnl:0,trades:0,maxDailyLoss:300000,maxPositionSize:2000000,cooldownMin:240,params:{funding_threshold:0.01,direction_mode:'auto',min_funding_rate:0.005},description:'펀딩비가 과열된 시장에서 롱/숏 비용 구조를 이용하는 전략'},
  {id:'s6',name:'BTC AI 전략',type:'ai_strategy',status:'stopped',asset:'BTC',assetNameKr:'비트코인',timeframe:'1h',leverage:2,maxLeverage:3,riskLevel:'medium',tp:4,sl:2,enabled:false,winRate:0,totalPnl:0,trades:0,maxDailyLoss:300000,maxPositionSize:2000000,cooldownMin:120,params:{ai_mode:'balanced',confidence_threshold:70,regime_filter:true},description:'시장 국면 AI 신호를 기반으로 자동 진입/청산'},
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

function AutoPage({ onNav, currency = 'KRW', onOpenAsset, requireAuth }: { onNav?: (tab: string) => void; currency?: string; onOpenAsset?: (a: any, dest?: string) => void; requireAuth?: (reason: string, action: () => void) => void } = {}) {
  const [tab,setTab]=useState<'bots'|'ai'|'signals'|'risk'|'runs'|'create'>('bots');
  const [aiSection,setAiSection]=useState<'decision'|'risk'|'analysis'>('decision');
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
    <div>
      <AutoStatusBoard />
      {/* Exec mode + global stop */}
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
        <button onClick={()=>globalStop?setGlobalStop(false):handleGlobalStop()} style={{background:globalStop?T.grn+'20':T.red+'20',color:globalStop?T.grn:T.red,border:`1px solid ${globalStop?T.grn:T.red}40`,borderRadius:10,padding:'8px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>
          {globalStop?'▶ 재시작':'⏹ 전체정지'}
        </button>
      </div>

      {globalStop&&<div style={{background:T.red+'15',border:`1px solid ${T.red}`,borderRadius:12,padding:'10px 14px',marginBottom:12,display:'flex',gap:8,alignItems:'center'}}><span style={{fontSize:18}}>🚨</span><div style={{color:T.red,fontWeight:700,fontSize:12}}>전체 긴급 정지 활성화 — 모든 봇이 중단되었습니다</div></div>}

      {execMode==='paper'&&<div style={{background:T.prp+'12',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.prp,fontSize:11,fontWeight:700}}>모의 자동매매 모드 — 실제 자금 이동 없음 · 수익 보장 없음</div></div>}

      {execMode==='testnet'&&<div style={{background:T.ylw+'15',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.ylw,fontSize:11,fontWeight:700}}>테스트넷 자동매매 — 거래소 테스트 서버에 실제 주문 (가짜 자금)</div></div>}

      {execMode==='real'&&<div style={{background:T.red+'15',border:`1px solid ${T.red}30`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.red,fontSize:11,fontWeight:700}}>⚠️ 실전 자동매매 — 연결된 거래소로 실제 주문 실행 · 원금 손실 위험</div></div>}

      {/* Dashboard metrics */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14}}>
        {[{l:'실행중',v:`${running.length}개`,c:T.grn},{l:'총 손익',v:totalPnl>=0?'+'+cvt(totalPnl,currency):cvt(totalPnl,currency),c:totalPnl>=0?T.grn:T.red},{l:'평균 승률',v:`${avgWinRate}%`,c:T.acl},{l:'총 거래',v:`${totalTrades}건`,c:T.muted}].map(s=>(
          <Card key={s.l} style={{padding:'9px 8px',textAlign:'center'}}>
            <div style={{color:s.c,fontSize:13,fontWeight:900,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',marginBottom:1}}>{s.v}</div>
            <div style={{color:T.muted,fontSize:9}}>{s.l}</div>
          </Card>
        ))}
      </div>

      {/* Sub tabs */}
      <div style={{display:'flex',gap:5,marginBottom:14,overflowX:'auto'}}>
        {([['bots','봇 목록'],['ai','AI 분석'],['signals','신호'],['risk','리스크'],['runs','실행기록'],['create','전략 추가']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'7px 11px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* ── BOTS ── */}
      {tab==='bots'&&(
        <div>
          {(Array.isArray(strats)?strats:[]).map(s=>{
            const si=STRAT_INFO[s.type];
            return (
              <Card key={s.id} style={{padding:'14px',marginBottom:10,border:`1px solid ${statusColor[s.status]}20`,borderLeft:`4px solid ${si.color}`}} onClick={()=>setSelStrat(selStrat?.id===s.id?null:s)}>
                {/* Header */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}>
                    <div style={{position:'relative',width:38,height:38,flexShrink:0}}>
                      <AssetLogo ticker={s.asset} name={s.assetNameKr} size={38} />
                      <div style={{position:'absolute',right:-4,bottom:-4,width:20,height:20,borderRadius:'50%',background:si.color,border:`2px solid ${T.bg||'#0B1220'}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11}}>{si.icon}</div>
                    </div>
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
                    <div style={{color:s.totalPnl>=0?T.grn:T.red,fontSize:12,fontWeight:700,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{s.totalPnl>=0?'+':''}{cvt(Math.abs(s.totalPnl),currency)}</div>
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
                    {/* AI assistant note */}
                    <div style={{marginTop:8,background:T.prp+'10',border:`1px solid ${T.prp}25`,borderRadius:8,padding:'8px 10px'}}>
                      <div style={{color:T.prp,fontSize:10,fontWeight:700,marginBottom:2}}>AI 어시스턴트</div>
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
      {tab==='ai'&&(<>
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
      <RegimeFilterPanel strategies={strats.map(s => ({ id: s.id, name: s.name, type: (s as any).type, asset: s.asset }))} />
      <DynamicSizingPanel currency={currency} symbols={Array.from(new Set(['BTC', 'ETH', ...strats.map(s => s.asset)])).slice(0, 5)} />
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

      {tab==='signals'&&(
        <div>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'8px 12px',marginBottom:12}}>
            <div style={{color:T.ylw,fontSize:11,fontWeight:700}}>신호 처리 엔진 — 내부 지표 · TradingView · AI (준비중)</div>
          </div>
          {(Array.isArray(signals)?signals:[]).map(sig=>(
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
                <div style={{color:T.txt,fontSize:11,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>{cvt(sig.price,currency)}</div>
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
              <button type="button"
                onClick={() => notifyInfo('TradingView Webhook 연동은 곧 출시됩니다. 현재는 더보기 → 전략빌더의 자체 시그널만 동작합니다.')}
                style={{background:T.cyn+'20',color:T.cyn,border:`1px solid ${T.cyn}40`,borderRadius:8,padding:'9px 14px',minHeight:36,fontSize:11,fontWeight:700,cursor:'pointer'}}>저장</button>
            </div>
          </Card>
        </div>
      )}

      {/* ── RISK ── */}
      {tab==='risk'&&(() => {
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
                  border:`1px solid ${T.acl}40`, borderRadius:8, padding:'6px 10px',
                  fontSize:11, fontWeight:700, cursor:'pointer', minHeight:32}}>
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
          <Card style={{padding:'14px 16px',border:`1px solid ${T.red}40`}}>
            <div style={{color:T.red,fontWeight:700,marginBottom:6}}>🚨 긴급 정지</div>
            <div style={{color:T.muted,fontSize:11,marginBottom:10}}>모든 자동매매를 즉시 중단합니다. 수동 거래는 계속 가능합니다.</div>
            <button onClick={handleGlobalStop} style={{width:'100%',padding:'12px',background:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer'}}>🚨 전체 자동매매 긴급 정지</button>
          </Card>
        </div>
        );
      })()}

      {/* ── RUNS ── */}
      {tab==='runs'&&(
        <div>
          {/* 실시간 자동매매 실행 로그 */}
          <AutoTradeLogPanel onOpenAsset={onOpenAsset}/>

          <div style={{color:T.txt,fontWeight:700,marginBottom:10,marginTop:16}}>샘플 실행 기록 (UI 데모)</div>
          {runs.map((r,i)=>(
            <Card key={r.id} style={{padding:'12px 14px',marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:2,flexWrap:'wrap'}}>
                    <span style={{background:r.side==='long'?T.grn+'15':T.red+'15',color:r.side==='long'?T.grn:T.red,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:6}}>{r.side==='long'?'롱':'숏'}</span>
                    <span style={{color:T.txt,fontWeight:700,fontSize:12}}>{r.asset}</span>
                    <span style={{background:T.prp+'15',color:T.prp,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:6}}>{r.execMode==='paper'?'모의':r.execMode==='testnet'?'테넷':'실전'}</span>
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
      {tab==='create'&&(
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
            <button onClick={()=>setShowConfirmReal(false)} style={{width:'100%',padding:'12px',background:T.muted+'20',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소 (모의 유지)</button>
          </div>
        </>
      )}

      {/* Edit strategy modal */}
      {editStrat&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.8)',zIndex:200}} onClick={()=>setEditStrat(null)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'20px 16px 40px',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:12}}>{editStrat.name} 설정</div>
            <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
              {[{l:'레버리지',v:`${editStrat.leverage}x`},{l:'익절',v:`${editStrat.tp}%`},{l:'손절',v:`${editStrat.sl}%`},{l:'타임프레임',v:editStrat.timeframe}].map(r=>(
                <div key={r.l} style={{background:T.alt,borderRadius:10,padding:'10px 12px'}}>
                  <div style={{color:T.muted,fontSize:10}}>{r.l}</div>
                  <div style={{color:T.txt,fontSize:14,fontWeight:700,marginTop:2}}>{r.v}</div>
                </div>
              ))}
            </div>
            <div style={{background:T.grn+'12',border:`1px solid ${T.grn}30`,borderRadius:8,padding:'8px 12px',marginBottom:12}}>
              <div style={{color:T.grn,fontSize:10,fontWeight:700}}>설정 변경은 백테스트 후 적용을 권장합니다.</div>
            </div>
            <button onClick={()=>setEditStrat(null)} style={{width:'100%',padding:'12px',background:T.acc,color:'#fff',border:'none',borderRadius:12,fontWeight:700,cursor:'pointer'}}>확인</button>
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
import { loadLogs, clearLogs, loadPaperBalance, resetPaperBalance } from '@/lib/autotrade/store';
import { calcPerformance, calcStrategyPerformance } from '@/lib/autotrade/performance';
import { getTodayPnL, checkRiskGuard, clearCooldown, resetTodayPnL } from '@/lib/risk/guard';
import type { ExecutionLog } from '@/lib/autotrade/types';
import { Wallet, ListChecks, Trash2, RefreshCw, AlertCircle, CheckCircle2, MinusCircle, Ban, Clock, BarChart3, TrendingUp as TrendingUpIc, TrendingDown as TrendingDownIc } from 'lucide-react';

function AutoTradeLogPanel({ onOpenAsset }: { onOpenAsset?: (a: any, dest?: string) => void } = {}) {
  const [logs, setLogs]    = useState<ExecutionLog[]>([]);
  const [balance, setBalance] = useState(loadPaperBalance());
  const [filter, setFilter] = useState<'all'|'triggered'|'skipped'|'error'>('all');
  const [todayPnL, setTodayPnL] = useState(() => getTodayPnL());
  const [guard, setGuard] = useState(() => checkRiskGuard());
  const [riskMode, setRiskMode] = useState(() => loadRiskSettings().mode);
  const [userStrategies, setUserStrategies] = useState<any[]>([]);

  const refresh = useCallback(() => {
    setLogs(loadLogs());
    setBalance(loadPaperBalance());
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
  const positionCount = Object.keys(balance.positions || {}).length;
  const totalPositionVal = Object.entries(balance.positions || {}).reduce((acc, [_, p]: any) => acc + (p.qty * p.avgPrice), 0);

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
            background: guard.pass ? T.grn + '22' : T.red + '22',
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
                background: guard.consecutive >= guard.consecutiveLimit ? T.red+'20' : T.ylw+'20',
                color:      guard.consecutive >= guard.consecutiveLimit ? T.red      : T.ylw,
                border: `1px solid ${guard.consecutive >= guard.consecutiveLimit ? T.red : T.ylw}30`,
              }}>
                연속 손실 {guard.consecutive}/{guard.consecutiveLimit}
              </div>
            )}
            {guard.cooldownUntil > Date.now() && (
              <div style={{
                padding:'4px 9px', borderRadius:6, fontSize:10, fontWeight:700,
                background: T.ylw+'20', color: T.ylw,
                border: `1px solid ${T.ylw}30`,
                display:'inline-flex', alignItems:'center', gap:4,
              }}>
                <Clock size={10} strokeWidth={2.4}/>
                쿨다운 {Math.ceil((guard.cooldownUntil - Date.now()) / 60_000)}분 남음
                <button onClick={() => { clearCooldown(); refresh(); }}
                  aria-label="쿨다운 해제"
                  style={{marginLeft:4,background:'transparent',color:T.ylw,border:`1px solid ${T.ylw}50`,borderRadius:4,padding:'1px 6px',fontSize:9,cursor:'pointer'}}>
                  해제
                </button>
              </div>
            )}
          </div>
        )}

        {!guard.pass && guard.reason && (
          <div style={{
            marginTop:8, padding:'7px 10px',
            background: T.red+'10', border: `1px solid ${T.red}30`,
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
            style={{flex:1,minHeight:30,background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,padding:'5px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
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
            <div style={{marginTop:8,padding:'7px 10px',background:T.red+'10',border:`1px solid ${T.red}30`,borderRadius:6,color:T.red,fontSize:10,lineHeight:1.4}}>
              ⚠️ 연속 {perf.curConsecLoss}회 손실 중 — 전략 점검을 권장합니다
            </div>
          )}
        </Card>
      )}

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
                  {sp.shouldDisable && sp.enabled && (
                    <div style={{display:'flex',alignItems:'center',gap:6,marginTop:6,padding:'5px 8px',background:T.red+'12',borderRadius:6}}>
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

      {/* 모의 잔고 카드 */}
      <Card style={{padding:'14px 16px',marginBottom:10, borderLeft:`3px solid ${T.acl}`}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
          <Wallet size={14} strokeWidth={2.2} color={T.acl}/>
          <span style={{color:T.txt,fontWeight:800,fontSize:13}}>모의 잔고 (Paper)</span>
          <button onClick={async () => {
              if ((await confirmDialog('모의 잔고를 초기화하시겠습니까? (KRW 1,000만원 + 포지션 모두 청산)', { danger: true }))) {
                resetPaperBalance(); refresh();
              }
            }}
            aria-label="잔고 초기화"
            style={{marginLeft:'auto',background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,padding:'4px 8px',fontSize:10,fontWeight:700,cursor:'pointer',display:'inline-flex',alignItems:'center',gap:3}}>
            <RefreshCw size={10} strokeWidth={2.4}/>초기화
          </button>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6}}>
          <div style={{background:T.alt,padding:'8px 10px',borderRadius:8,border:`1px solid ${T.border}`}}>
            <div style={{color:T.muted,fontSize:9,marginBottom:2}}>현금</div>
            <div style={{color:T.txt,fontWeight:800,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
              {cvt(Math.floor(balance.krw), currency)}
            </div>
          </div>
          <div style={{background:T.alt,padding:'8px 10px',borderRadius:8,border:`1px solid ${T.border}`}}>
            <div style={{color:T.muted,fontSize:9,marginBottom:2}}>보유 {positionCount}개</div>
            <div style={{color:T.txt,fontWeight:800,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
              {cvt(Math.floor(totalPositionVal), currency)}
            </div>
          </div>
          <div style={{background:balance.totalPnL>=0?T.grn+'15':T.red+'15',padding:'8px 10px',borderRadius:8,border:`1px solid ${balance.totalPnL>=0?T.grn:T.red}40`}}>
            <div style={{color:balance.totalPnL>=0?T.grn:T.red,fontSize:9,marginBottom:2}}>누적 PnL</div>
            <div style={{color:balance.totalPnL>=0?T.grn:T.red,fontWeight:800,fontSize:13,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums'}}>
              {balance.totalPnL>=0?'+':''}{cvt(Math.abs(Math.floor(balance.totalPnL)), currency)}
            </div>
          </div>
        </div>
        {positionCount > 0 && (
          <div style={{marginTop:8,fontSize:10,color:T.muted}}>
            보유: {Object.entries(balance.positions).map(([asset, p]: any) => `${asset} ${p.qty.toFixed(4)}@${cvt(Math.floor(p.avgPrice), currency)}`).join(', ')}
          </div>
        )}
      </Card>

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
            style={{background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:6,padding:'4px 8px',fontSize:10,fontWeight:700,cursor:'pointer',display:'inline-flex',alignItems:'center',gap:3}}>
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
            {logs.length === 0 ? '더보기 → 전략빌더에서 전략을 만들고 활성화하면\n60초마다 시그널 평가가 시작됩니다 (모의 모드 기본)' : ''}
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
                    <span style={{padding:'1px 5px',background:log.action==='buy'?T.grn+'22':T.red+'22',color:log.action==='buy'?T.grn:T.red,borderRadius:4,fontSize:9,fontWeight:800}}>
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
                <div style={{color:T.txt,fontSize:11,fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums',background:T.grn+'10',padding:'5px 8px',borderRadius:6,marginTop:4}}>
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
