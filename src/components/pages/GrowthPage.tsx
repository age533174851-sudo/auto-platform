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


function GrowthPage() {
  const [checklist,setChecklist]=useState([
    {id:'c1',done:true, label:'앱 설치 및 첫 로그인',          reward:'🎖 신규 배지',     xp:50},
    {id:'c2',done:true, label:'왓치리스트에 첫 종목 추가',      reward:'+10 XP',        xp:10},
    {id:'c3',done:true, label:'모의 첫 거래 실행',              reward:'첫 거래 배지',  xp:30},
    {id:'c4',done:false,label:'포트폴리오 배분 설정',           reward:'+20 XP',        xp:20},
    {id:'c5',done:false,label:'DCA 계획 1개 등록',              reward:'DCA 배지',       xp:25},
    {id:'c6',done:false,label:'AI 브리핑 3회 읽기',             reward:'AI 뱃지',        xp:15},
    {id:'c7',done:false,label:'경제 캘린더 북마크',             reward:'+10 XP',        xp:10},
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
          <div style={{color:T.txt,fontWeight:700,fontSize:13}}>시작 체크리스트</div>
          <Bdg c={T.grn} ch={`${doneCount}/${checklist.length}`}/>
        </div>
        {(Array.isArray(checklist)?checklist:[]).map((c,i)=>(
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
        <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>업적 배지</div>
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
    strategy.close_all(comment="목표 도달")
    inLong := false; scaleStage := 0

if inShort and close <= avgEntry * (1 - i_target/100)
    strategy.close_all(comment="목표 도달")
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


export default GrowthPage;