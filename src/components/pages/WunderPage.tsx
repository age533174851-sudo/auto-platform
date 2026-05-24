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
            <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
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
              {(Array.isArray(grp.items) ? grp.items : []).map((item,i)=>(
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
            <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
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
            <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
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


export default WunderPage;