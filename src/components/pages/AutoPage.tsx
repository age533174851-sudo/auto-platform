'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES } from '@/lib/constants';
import { cvt, fmt, fmtPct, gS, sS, uid } from '@/lib/utils';
import type { Asset } from '@/types';
import { Card } from './SharedUI';

const STRAT_INFO:Record<StratType,{label:string;icon:string;color:string;desc:string}> = {
  ema_cross:     {label:'EMA 크로스',      icon:'📈',color:'#3B82F6',desc:'EMA20/60 골든·데드 크로스 추세 추종'},
  rsi_reversal:  {label:'RSI 반전',        icon:'📊',color:'#7C3AED',desc:'RSI 과매수/과매도 반등 전략'},
  macd_trend:    {label:'MACD 추세',       icon:'📉',color:'#10B981',desc:'MACD 히스토그램 추세 추종'},
  breakout:      {label:'브레이크아웃',    icon:'🚀',color:'#F59E0B',desc:'볼린저밴드 / 고저 돌파 전략'},
  scalping:      {label:'스캘핑',          icon:'⚡',color:'#EF4444',desc:'단기 소폭 수익 반복 전략'},
  swing:         {label:'스윙',            icon:'🌊',color:'#0891B2',desc:'2~7일 스윙 포지션 전략'},
  dca:           {label:'DCA 적립',        icon:'🔄',color:'#D97706',desc:'정기 분할 매수 전략'},
  buy_dip:       {label:'급락 매수',       icon:'🎯',color:'#059669',desc:'급락 시 분할 매수 전략'},
  funding_rate:  {label:'펀딩비 전략',     icon:'💰',color:'#F59E0B',desc:'펀딩비 과열 시 롱/숏 비용 구조 활용'},
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
          <div style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:201,background:T.surf,borderRadius:20,padding:`24px 20px calc(24px + env(safe-area-inset-bottom, 0px))`,width:320,border:`2px solid ${T.red}`}} onClick={e=>e.stopPropagation()}>
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

export default AutoPage;
