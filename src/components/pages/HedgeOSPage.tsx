'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS, LOGO_SOURCES } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import { MOCK_EXCHANGE_HEALTH, MOCK_RECOVERY, type ExchangeHealth, type RecoveryEvent } from '@/lib/mock';
import { Card, Dot, Spark, Pill, Bdg, Toggle, AreaChart, WorldClock, Heatmap,
         TradingChart, Logo, getBgColor, resolveLogoUrl, getKrName, cleanName, resolveTVSym,
         DonutChart, MiniBar, GlobalSearch, getLeverageRec,
         LiquidationCalc, PositionSizer, RiskDashboard,
         InlineTVChart } from './SharedUI';



/* ── Mock data for HedgeOS ── */
interface WalletEntry { id:string; exchange:string; asset:string; balance:number; usdtEq:number; pct:number; clr:string; }
interface MarketplaceEntry { id:string; name:string; strat:string; score:number; pnl:number; subscribers:number; badge:string; clr:string; }
interface LiquidationPos { asset:string; side:string; entryPrice:number; liqPrice:number; distPct:number; leverage:number; clr:string; }
interface ApiPermission { read:boolean; spot:boolean; futures:boolean; withdrawal:boolean; }
interface KillSwitchState { active:boolean; target:string; reason:string; activatedAt:string|null; }
interface DrawdownState { daily:{used:number;limit:number}; weekly:{used:number;limit:number}; monthly:{used:number;limit:number}; }
type KillSwitchTarget='all'|'futures'|'spot';
type BotMode='shadow'|'live'|'dca';
const MOCK_WALLET: WalletEntry[] = [
  {id:'w1',exchange:'Binance',asset:'BTC',balance:0.42,usdtEq:28350,pct:42,clr:'#F59E0B'},
  {id:'w2',exchange:'Binance',asset:'ETH',balance:3.8,usdtEq:13680,pct:20,clr:'#6366F1'},
  {id:'w3',exchange:'Binance',asset:'USDT',balance:18200,usdtEq:18200,pct:27,clr:'#10B981'},
  {id:'w4',exchange:'Gate.io',asset:'SOL',balance:45,usdtEq:7650,pct:11,clr:'#8B5CF6'},
];
const MOCK_MARKETPLACE: MarketplaceEntry[] = [
  {id:'m1',name:'퀀트 알파',strat:'EMA Cross',score:92,pnl:28.4,subscribers:1240,badge:'🏆',clr:'#F59E0B'},
  {id:'m2',name:'리스크매니저',strat:'RSI Mean Rev',score:87,pnl:19.2,subscribers:876,badge:'💎',clr:'#6366F1'},
  {id:'m3',name:'스윙마스터',strat:'Breakout',score:81,pnl:14.7,subscribers:543,badge:'⭐',clr:'#10B981'},
  {id:'m4',name:'DCA왕',strat:'DCA Bot',score:75,pnl:11.3,subscribers:2100,badge:'🤖',clr:'#3B82F6'},
];
const MOCK_LIQ_POSITIONS: LiquidationPos[] = [
  {asset:'BTC',side:'long',entryPrice:88_000_000,liqPrice:70_400_000,distPct:20,leverage:5,clr:'#F59E0B'},
  {asset:'ETH',side:'long',entryPrice:4_200_000, liqPrice:2_940_000, distPct:30,leverage:3,clr:'#6366F1'},
  {asset:'SOL',side:'short',entryPrice:195_000,  liqPrice:292_500,   distPct:8, leverage:10,clr:'#8B5CF6'},
];
const INIT_KILLSWITCH: KillSwitchState = {active:false,target:'all',reason:'',activatedAt:null};
const INIT_DRAWDOWN: DrawdownState = {daily:{used:1.2,limit:3},weekly:{used:4.1,limit:10},monthly:{used:7.8,limit:25}};

const MOCK_API_PERMS: Record<string,ApiPermission> = {
  'Binance': {read:true,spot:false,futures:true,withdrawal:false},
  'Gate.io':  {read:true,spot:true, futures:true,withdrawal:false},
  'Upbit':    {read:true,spot:true, futures:false,withdrawal:false},
};

/* ══════════════════════════════════════════════════════════════════
   HedgeOSPage Component
   ══════════════════════════════════════════════════════════════════ */

function HedgeOSPage() {
  const [tab,setTab]=useState<'control'|'wallet'|'market'|'monitor'|'recovery'>('control');
  const [ks,setKs]=useState<KillSwitchState>(INIT_KILLSWITCH);
  const [dd,setDd]=useState<DrawdownState>(INIT_DRAWDOWN);
  const [botMode,setBotMode]=useState<BotMode>('shadow');
  const [liqAlert,setLiqAlert]=useState(false);
  const [showConfirmKill,setShowConfirmKill]=useState(false);
  const [proMode,setProMode]=useState(false);
  const [sortMarket,setSortMarket]=useState<'score'|'pnl'|'subs'>('score');

  const totalBalance = (MOCK_WALLET||[]).reduce((s,w)=>s+(w?.balance||0),0);
  const totalUSDT    = (MOCK_WALLET||[]).reduce((s,w)=>s+(w?.usdtEq||0),0);
  const ddDailyPct   = (dd?.daily?.used ?? 0) / Math.max(1, dd?.daily?.limit ?? 1) * 100;
  const ddWkPct      = (dd?.weekly?.used ?? 0) / Math.max(1, dd?.weekly?.limit ?? 1) * 100;
  const sortedMarket = [...(MOCK_MARKETPLACE||[])].sort((a,b)=>
    sortMarket==='pnl'?b.pnl-a.pnl:sortMarket==='subs'?b.subscribers-a.subscribers:b.score-a.score
  );

  const activateKill=(target:KillSwitchTarget)=>{
    setKs({active:true,target,reason:'수동 긴급 정지',activatedAt:new Date().toLocaleTimeString('ko-KR')});
    setShowConfirmKill(false);
  };
  const deactivateKill=()=>setKs(INIT_KILLSWITCH);

  const statusColor=(s:ExchangeHealth['status'])=>
    s==='ok'?T.grn:s==='slow'?T.ylw:s==='error'?T.red:T.muted;

  /* ── Liquidation gauge ── */
  const LiqGauge=({pos}:{pos:LiquidationPos})=>{
    const danger=pos.distPct<5;
    const c=danger?T.red:pos.distPct<10?T.ylw:T.grn;
    return (
      <Card key={pos.asset} style={{padding:'12px 14px',marginBottom:8,border:`1px solid ${c}25`}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <div style={{width:28,height:28,borderRadius:7,background:`${pos.clr}20`,border:`1px solid ${pos.clr}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:900,color:pos.clr,flexShrink:0}}>{pos.asset.slice(0,2)}</div>
            <div>
              <div style={{display:'flex',gap:4,alignItems:'center'}}>
                <span style={{color:T.txt,fontWeight:700,fontSize:12}}>{pos.asset}</span>
                <span style={{background:pos.side==='long'?T.grn+'20':T.red+'20',color:pos.side==='long'?T.grn:T.red,fontSize:8,fontWeight:700,padding:'1px 5px',borderRadius:4}}>{pos.side.toUpperCase()}</span>
                <span style={{background:T.ylw+'15',color:T.ylw,fontSize:8,fontWeight:700,padding:'1px 5px',borderRadius:4}}>{pos.leverage}x</span>
              </div>
              <div style={{color:T.muted,fontSize:9,marginTop:1}}>진입 {cvt(pos.entryPrice,'KRW')} → 청산 {cvt(pos.liqPrice,'KRW')}</div>
            </div>
          </div>
          <div style={{textAlign:'right',flexShrink:0}}>
            <div style={{color:c,fontWeight:900,fontSize:14}}>{pos.distPct.toFixed(1)}%</div>
            <div style={{color:T.muted,fontSize:9}}>청산까지</div>
          </div>
        </div>
        <div style={{height:5,background:'#1A2D4A',borderRadius:3,overflow:'hidden'}}>
          <div style={{height:'100%',width:`${Math.min(100,100-pos.distPct*5)}%`,background:c,borderRadius:3,transition:'width .5s'}}/>
        </div>
        {danger&&<div style={{marginTop:5,color:T.red,fontSize:9,fontWeight:700}}>⚠️ 청산 위험 — 즉시 확인 필요</div>}
      </Card>
    );
  };

  return (
    <div>
      {/* Header */}
      <div style={{background:'linear-gradient(135deg,#04060F,#080D1A)',border:`1px solid ${ks.active?T.red:T.acl}40`,borderRadius:18,padding:'14px 16px',marginBottom:14}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
          <div>
            <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:3}}>
              <span style={{fontSize:18}}>🏦</span>
              <span style={{color:T.txt,fontWeight:900,fontSize:15}}>TRAIGO Hedge OS</span>
              {ks.active&&<Bdg c={T.red} ch="🚨 긴급 정지 활성화"/>}
            </div>
            <div style={{color:T.muted,fontSize:10}}>Kill Switch · 드로다운 보호 · 유니파이드 월렛 · AI 포트폴리오 · 거래소 모니터</div>
          </div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <button onClick={()=>setProMode(v=>!v)} style={{background:proMode?T.prp+'20':'transparent',color:proMode?T.prp:T.muted,border:`1px solid ${proMode?T.prp:T.border}`,borderRadius:8,padding:'4px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{proMode?'PRO':'👤 일반'}</button>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
          {[
            {l:'총 자산',v:cvt(totalBalance,'KRW'),c:T.txt},
            {l:'USDT 환산',v:`$${totalUSDT.toLocaleString()}`,c:T.acl},
            {l:'봇 모드',v:botMode==='shadow'?'👁 섀도우':botMode==='sandbox'?'샌드박스':'▶ 실행',c:botMode==='shadow'?T.prp:botMode==='sandbox'?T.ylw:T.grn},
            {l:'일일 DD',v:`${ddDailyPct.toFixed(0)}%`,c:ddDailyPct>70?T.red:ddDailyPct>40?T.ylw:T.grn},
          ].map(s=>(
            <div key={s.l} style={{background:'rgba(0,0,0,.4)',borderRadius:8,padding:'6px 7px',textAlign:'center'}}>
              <div style={{color:s.c,fontSize:11,fontWeight:800}}>{s.v}</div>
              <div style={{color:T.muted,fontSize:8,marginTop:1}}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Bot mode selector */}
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {([['shadow','👁 섀도우 모드','전략 실행, 주문 미실행',T.prp],['sandbox','샌드박스','모의 환경 실행',T.ylw],['normal','▶ 실전','실제 API 실행 (준비중)',T.grn]] as const).map(([id,l,d,c])=>(
          <button key={id} onClick={()=>setBotMode(id)} style={{flex:1,padding:'8px 4px',background:botMode===id?c+'15':'transparent',color:botMode===id?c:T.muted,border:`2px solid ${botMode===id?c:T.border}`,borderRadius:12,cursor:'pointer',textAlign:'center'}}>
            <div style={{fontSize:11,fontWeight:700}}>{l}</div>
            <div style={{color:T.muted,fontSize:8,marginTop:2}}>{d}</div>
          </button>
        ))}
      </div>
      {botMode==='normal'&&<div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:10,padding:'9px 13px',marginBottom:12}}><div style={{color:T.red,fontWeight:700,fontSize:11}}>⚠️ 실전 모드 — 현재 비활성화. 거래소 API 연결 + 출금 권한 차단 확인 필요</div></div>}

      {/* Sub tabs */}
      <div style={{display:'flex',gap:5,marginBottom:14,overflowX:'auto'}}>
        {([['control','🚨 제어'],['wallet','월렛'],['market','🏪 마켓플레이스'],['monitor','모니터'],['recovery','복구']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'7px 11px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* ── CONTROL ── */}
      {tab==='control'&&(
        <div>
          {/* Kill switch */}
          <Card style={{padding:'16px',marginBottom:12,border:`2px solid ${ks.active?T.red:T.border}`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div>
                <div style={{color:ks.active?T.red:T.txt,fontWeight:800,fontSize:14}}>🚨 킬 스위치 (Kill Switch)</div>
                <div style={{color:T.muted,fontSize:11}}>모든 자동매매를 즉시 중단합니다</div>
                {ks.active&&<div style={{color:T.red,fontSize:10,marginTop:3}}>{ks.activatedAt} 활성화됨 · {ks.reason}</div>}
              </div>
              {ks.active
                ? <button onClick={deactivateKill} style={{background:T.grn+'20',color:T.grn,border:`1px solid ${T.grn}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>✅ 해제</button>
                : <button onClick={()=>setShowConfirmKill(true)} style={{background:T.red+'20',color:T.red,border:`1px solid ${T.red}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>🚨 실행</button>
              }
            </div>
            {!ks.active&&(
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
                {([['all','전체 봇 정지'],['selected_bots','선택된 봇만'],['selected_exchange','거래소 선택'],['auto_only','자동매매만']] as const).map(([t,l])=>(
                  <button key={t} onClick={()=>activateKill(t)} style={{background:T.red+'10',color:T.red,border:`1px solid ${T.red}20`,borderRadius:8,padding:'8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{l}</button>
                ))}
              </div>
            )}
          </Card>

          {/* Drawdown protection */}
          <Card style={{padding:'16px',marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700}}>드로다운 보호</div>
              <Bdg c={dd.mode==='normal'?T.grn:dd.mode==='cooldown'?T.ylw:T.red} ch={dd.mode==='normal'?'정상':dd.mode==='cooldown'?'쿨다운':'방어 모드'}/>
            </div>
            {[
              {l:'일일 손실',used:dd?.daily?.used ?? 0,limit:dd?.daily?.limit ?? 0,pct:ddDailyPct},
              {l:'주간 손실',used:dd?.weekly?.used ?? 0,limit:dd?.weekly?.limit ?? 0,pct:ddWkPct},
              {l:'월간 손실',used:dd?.monthly?.used ?? 0,limit:dd?.monthly?.limit ?? 0,pct:(dd?.monthly?.used ?? 0) / Math.max(1, dd?.monthly?.limit ?? 1) * 100},
            ].map(r=>{
              const c=r.pct>70?T.red:r.pct>40?T.ylw:T.grn;
              return (
                <div key={r.l} style={{marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                    <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
                    <span style={{color:c,fontSize:11,fontWeight:700}}>{cvt(r.used,'KRW')} / {cvt(r.limit,'KRW')} ({r.pct.toFixed(0)}%)</span>
                  </div>
                  <div style={{height:6,background:'#1A2D4A',borderRadius:3,overflow:'hidden'}}>
                    <div style={{height:'100%',width:`${Math.min(100,r.pct)}%`,background:c,borderRadius:3,transition:'width .5s'}}/>
                  </div>
                </div>
              );
            })}
          </Card>

          {/* Liquidation monitor */}
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${liqAlert?T.red:T.border}30`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div style={{color:T.txt,fontWeight:700}}>청산 위험 모니터</div>
              <button onClick={()=>setLiqAlert(v=>!v)} style={{background:liqAlert?T.red+'20':T.acg,color:liqAlert?T.red:T.acl,border:`1px solid ${liqAlert?T.red:T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{liqAlert?'알림 ON':'🔕 알림 OFF'}</button>
            </div>
            {(MOCK_LIQ_POSITIONS||[]).map(p=><LiqGauge key={p.asset} pos={p}/>)}
          </Card>

          {/* API permission check */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>API 권한 보안 검사</div>
            {Object.entries(MOCK_API_PERMS).map(([ex,perm])=>(
              <div key={ex} style={{marginBottom:10,paddingBottom:10,borderBottom:`1px solid ${T.border}`}}>
                <div style={{color:T.txt,fontSize:12,fontWeight:700,marginBottom:6}}>{ex}</div>
                <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                  {[{l:'읽기',v:perm.read,safe:true},{l:'현물',v:perm.spot,safe:true},{l:'선물',v:perm.futures,safe:true},{l:'출금',v:perm.withdrawal,safe:false}].map(p=>(
                    <Bdg key={p.l} c={p.v?(p.safe?T.grn:T.red):T.muted} ch={`${p.v?'✅':'❌'} ${p.l}${p.v&&!p.safe?' ⚠️':''}`}/>
                  ))}
                </div>
                {perm.withdrawal&&<div style={{color:T.red,fontSize:10,fontWeight:700,marginTop:4}}>⚠️ 출금 권한이 활성화되어 있습니다. 즉시 거래소에서 비활성화하세요.</div>}
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* ── WALLET ── */}
      {tab==='wallet'&&(
        <div>
          {/* Total */}
          <div style={{background:'linear-gradient(135deg,#060A12,#0D1525)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
            <div style={{color:T.muted,fontSize:11,marginBottom:2}}>유니파이드 월렛 총 자산</div>
            <div style={{color:T.txt,fontSize:28,fontWeight:900,fontFamily:'monospace'}}>{cvt(totalBalance,'KRW')}</div>
            <div style={{color:T.acl,fontSize:13,fontWeight:700,marginTop:2}}>${totalUSDT.toLocaleString()} USDT</div>
            {/* Allocation bar */}
            <div style={{marginTop:12,height:8,background:'#1A2D4A',borderRadius:4,overflow:'hidden',display:'flex'}}>
              {(MOCK_WALLET||[]).map(w=><div key={w.id} style={{height:'100%',width:`${w.balance/totalBalance*100}%`,background:w.color,opacity:0.85}}/>)}
            </div>
            <div style={{display:'flex',gap:8,marginTop:6,flexWrap:'wrap'}}>
              {(MOCK_WALLET||[]).map(w=>(
                <div key={w.id} style={{display:'flex',alignItems:'center',gap:3}}>
                  <div style={{width:7,height:7,borderRadius:2,background:w.color}}/>
                  <span style={{color:T.muted,fontSize:9}}>{w.name} {(w.balance/totalBalance*100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Per account */}
          {(MOCK_WALLET||[]).map((w,i)=>(
            <Card key={w.id} style={{padding:'12px 14px',marginBottom:8}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <div style={{width:36,height:36,borderRadius:10,background:`${w.color}20`,border:`1px solid ${w.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>{w.icon}</div>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{w.name}</div>
                    <div style={{display:'flex',gap:4,marginTop:2}}>
                      <Bdg c={w.color} ch={w.type}/>
                      <span style={{color:T.muted,fontSize:9}}>${w.usdtEq.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>{cvt(w.balance,'KRW')}</div>
                  <div style={{color:T.muted,fontSize:10}}>{(w.balance/totalBalance*100).toFixed(1)}%</div>
                </div>
              </div>
            </Card>
          ))}

          {/* AI portfolio advice */}
          <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.prp}30`}}>
            <div style={{color:T.prp,fontWeight:700,marginBottom:8}}>AI 포트폴리오 관리자</div>
            <div style={{display:'flex',gap:6,marginBottom:10}}>
              {(['conservative','balanced','aggressive'] as const).map(m=>(
                <button key={m} type="button"
                  onClick={() => alert(`${m==='conservative'?'보수형':m==='balanced'?'균형형':'공격형'} 포트폴리오는 곧 출시됩니다. 현재는 더보기 → 리스크관리에서 모드 변경 가능합니다.`)}
                  style={{flex:1,padding:'9px',minHeight:36,background:m==='balanced'?T.prp+'20':'transparent',color:m==='balanced'?T.prp:T.muted,border:`1px solid ${m==='balanced'?T.prp:T.border}`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {m==='conservative'?'보수형':m==='balanced'?'균형형':'공격형'}
                </button>
              ))}
            </div>
            {['암호화폐 비중이 73%로 과도합니다. ETF 분산을 권장합니다.','현금 보유율 12% — 급락 대응 여력 적절','분기별 리밸런싱 예정일: 2025-07-01'].map((m,i)=>(
              <div key={i} style={{display:'flex',gap:5,padding:'4px 0',borderBottom:i<2?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.prp,fontSize:11}}>💡</span>
                <span style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{m}</span>
              </div>
            ))}
            <div style={{color:T.muted,fontSize:9,marginTop:6}}>⚠️ AI 조언은 참고용이며 수익을 보장하지 않습니다.</div>
          </Card>
        </div>
      )}

      {/* ── MARKETPLACE ── */}
      {tab==='market'&&(
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:14}}>🏪 전략 마켓플레이스</div>
            <div style={{display:'flex',gap:4}}>
              {(['score','pnl','subs'] as const).map(s=>(
                <button key={s} onClick={()=>setSortMarket(s)} style={{background:sortMarket===s?T.acg:'transparent',color:sortMarket===s?T.acl:T.muted,border:`1px solid ${sortMarket===s?T.acl:T.border}`,borderRadius:7,padding:'3px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {s==='score'?'점수':s==='pnl'?'수익률':'구독자'}
                </button>
              ))}
            </div>
          </div>

          {(Array.isArray(sortedMarket)?sortedMarket:[]).map((s,i)=>(
            <Card key={s.id} style={{padding:'14px',marginBottom:10,border:`1px solid ${s.color}20`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <div style={{width:36,height:36,borderRadius:10,background:`${s.color}20`,border:`1px solid ${s.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:14,color:s.color}}>
                    {i+1}
                  </div>
                  <div>
                    <div style={{display:'flex',gap:5,alignItems:'center',flexWrap:'wrap'}}>
                      <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{s.name}</span>
                      {s.badge&&<span style={{background:`${s.color}15`,color:s.color,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:99}}>{s.badge}</span>}
                      {s.verified&&<span style={{color:T.acl,fontSize:11}}>✓</span>}
                    </div>
                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>{s.author} · {s.type} · 구독 {s.subscribers.toLocaleString()}명</div>
                  </div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <div style={{color:s.pnl>=0?T.grn:T.red,fontWeight:900,fontSize:14}}>+{s.pnl}%</div>
                  <div style={{color:T.muted,fontSize:9}}>승률 {s.winRate}%</div>
                </div>
              </div>
              <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:8}}>
                <div style={{flex:1,height:4,background:'#1A2D4A',borderRadius:2,overflow:'hidden'}}>
                  <div style={{height:'100%',width:`${s.score}%`,background:s.score>=70?T.grn:s.score>=40?T.ylw:T.red,borderRadius:2}}/>
                </div>
                <span style={{color:T.muted,fontSize:10,flexShrink:0}}>점수 {s.score}</span>
              </div>
              <div style={{display:'flex',gap:6}}>
                <button type="button"
                  onClick={() => alert(`"${s.name}" 상세 정보는 곧 출시됩니다.\n작성자: ${s.author}\n수익률: +${s.pnl}%\n승률: ${s.winRate}%\n점수: ${s.score}`)}
                  style={{flex:1,padding:'9px',minHeight:36,background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>상세 보기</button>
                <button type="button"
                  onClick={() => alert(`"${s.name}" 모의 구독 기능은 곧 출시됩니다. 현재는 더보기 → 전략빌더에서 본인 전략 생성 가능합니다.`)}
                  style={{flex:1,padding:'9px',minHeight:36,background:s.color+'15',color:s.color,border:`1px solid ${s.color}30`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>구독 (모의)</button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── MONITOR ── */}
      {tab==='monitor'&&(
        <div>
          {/* Exchange health */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>거래소 연결 상태</div>
            {(Array.isArray(MOCK_EXCHANGE_HEALTH)?MOCK_EXCHANGE_HEALTH:[]).map((ex,i)=>{
              const c=statusColor(ex.status);
              return (
                <div key={ex.name} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<MOCK_EXCHANGE_HEALTH.length-1?`1px solid ${T.border}`:'none'}}>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}>
                    <div style={{width:8,height:8,borderRadius:'50%',background:c,boxShadow:`0 0 5px ${c}80`,flexShrink:0}}/>
                    <span style={{fontSize:14}}>{ex.icon}</span>
                    <div>
                      <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{ex.name}</div>
                      <div style={{color:T.muted,fontSize:9}}>WS: {ex.wsStatus?'✅':'❌'} · 갱신: {ex.lastCheck}</div>
                    </div>
                  </div>
                  <div style={{textAlign:'right',flexShrink:0}}>
                    <Bdg c={c} ch={ex.status==='ok'?'정상':ex.status==='slow'?'지연':ex.status==='error'?'오류':'점검중'}/>
                    {ex.latency>0&&<div style={{color:T.muted,fontSize:9,marginTop:2}}>{ex.latency}ms</div>}
                  </div>
                </div>
              );
            })}
          </Card>

          {/* Push notification channels */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>알림 채널 설정</div>
            {[
              {name:'Telegram 봇',status:'준비중',icon:'📱',c:T.acl,desc:'@TRAIGO_Alert_Bot'},
              {name:'Discord Webhook',status:'준비중',icon:'💬',c:T.prp,desc:'채널 Webhook URL 연동'},
              {name:'이메일 알림',status:'준비중',icon:'📧',c:T.ylw,desc:'가입 이메일로 발송'},
              {name:'모바일 푸시',status:'준비중',icon:'📲',c:T.grn,desc:'PWA / 앱 알림'},
            ].map((ch,i)=>(
              <div key={ch.name} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <span style={{fontSize:18}}>{ch.icon}</span>
                  <div>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{ch.name}</div>
                    <div style={{color:T.muted,fontSize:9}}>{ch.desc}</div>
                  </div>
                </div>
                <Bdg c={T.muted} ch={ch.status}/>
              </div>
            ))}
          </Card>

          {/* AI Risk Manager */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.prp}30`}}>
            <div style={{color:T.prp,fontWeight:700,marginBottom:8}}>AI 위험 관리자</div>
            {[
              {msg:'현재 시장 변동성이 보통 수준 — 정상 레버리지 유지',level:'ok'},
              {msg:'Gate.io API 응답 지연 감지 — 해당 거래소 거래 주의',level:'warn'},
              {msg:'BTC 펀딩비 0.008% — 정상 범위 내, 롱 포지션 추가 가능',level:'ok'},
              {msg:'SOL 청산 거리 5.1% — 청산 위험 모니터링 필요',level:'danger'},
            ].map((a,i)=>(
              <div key={i} style={{display:'flex',gap:5,padding:'5px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                <span style={{fontSize:11,flexShrink:0}}>{a.level==='ok'?'✅':a.level==='warn'?'⚠️':'🔴'}</span>
                <span style={{color:a.level==='danger'?T.red:a.level==='warn'?T.ylw:T.sub,fontSize:11,lineHeight:1.5}}>{a.msg}</span>
              </div>
            ))}
            <div style={{color:T.muted,fontSize:9,marginTop:6}}>⚠️ AI 분석은 참고용이며 수익을 보장하지 않습니다.</div>
          </Card>
        </div>
      )}

      {/* ── RECOVERY ── */}
      {tab==='recovery'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>자동 복구 시스템</div>
            {(Array.isArray(MOCK_RECOVERY)?MOCK_RECOVERY:[]).map((ev,i)=>(
              <div key={ev.id} style={{padding:'10px 0',borderBottom:i<(Array.isArray(MOCK_RECOVERY)?MOCK_RECOVERY.length:0)-1?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:4}}>
                  <div style={{display:'flex',gap:5,alignItems:'center'}}>
                    <Bdg c={ev.resolved?T.grn:T.red} ch={ev.resolved?'해결됨':'확인 필요'}/>
                    <span style={{color:T.txt,fontSize:11,fontWeight:700}}>{ev.type}</span>
                  </div>
                  <span style={{color:T.muted,fontSize:9}}>{ev.time}</span>
                </div>
                <div style={{color:T.muted,fontSize:10,marginBottom:2}}>{ev.desc}</div>
                <div style={{color:ev.resolved?T.grn:T.ylw,fontSize:10}}>→ {ev.action}</div>
              </div>
            ))}
          </Card>

          {/* Reconnect settings */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>재연결 설정</div>
            {[{l:'WebSocket 자동 재연결',v:true},{l:'API 타임아웃 시 폴링 전환',v:true},{l:'포지션 불일치 시 알림',v:true},{l:'API 오류 시 봇 일시 중지',v:true}].map((s,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{s.l}</span>
                <Bdg c={s.v?T.grn:T.muted} ch={s.v?'활성':'비활성'}/>
              </div>
            ))}
          </Card>

          {/* Shadow mode explanation */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.prp}30`}}>
            <div style={{color:T.prp,fontWeight:700,marginBottom:8}}>👁 섀도우 모드란?</div>
            <div style={{color:T.sub,fontSize:11,lineHeight:1.7}}>
              섀도우 모드에서는 전략 로직이 완전히 실행되지만 실제 주문은 전송되지 않습니다.
              신호·포지션·PnL은 모두 시뮬레이션으로 기록됩니다.<br/><br/>
              ✅ 실전 전 전략 검증에 최적<br/>
              ✅ 리스크 없이 전략 성과 확인<br/>
              ✅ 실전 모드 전환 전 필수 단계
            </div>
          </Card>
        </div>
      )}

      {/* Kill confirm modal */}
      {showConfirmKill&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.85)',zIndex:300}} onClick={()=>setShowConfirmKill(false)}/>
          <div style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:301,background:T.surf,borderRadius:20,padding:'24px 20px',width:320,border:`2px solid ${T.red}`}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:36,textAlign:'center',marginBottom:8}}>🚨</div>
            <div style={{color:T.red,fontWeight:900,fontSize:18,textAlign:'center',marginBottom:8}}>전체 킬 스위치</div>
            <div style={{color:T.sub,fontSize:12,lineHeight:1.6,marginBottom:20,textAlign:'center'}}>모든 자동매매를 즉시 중단합니다. 수동 거래는 계속 가능합니다.</div>
            <div style={{display:'flex',gap:10}}>
              <button onClick={()=>setShowConfirmKill(false)} style={{flex:1,padding:'12px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>activateKill('all')} style={{flex:1,padding:'12px',background:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:900,cursor:'pointer'}}>정지 실행</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   INLINE CHART PAGE — TradingView 차트 탭 (메인 앱 내부)
   ══════════════════════════════════════════════════════════════════ */

/* ── Symbol converter (reused from chart route) ── */
function tvSymbol(raw: string): string {
  if (!raw || !raw.trim()) return 'BINANCE:BTCUSDT';
  const u = raw.toUpperCase().trim();
  if (u.includes(':')) return u;
  const CRYPTO = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','TON','LINK','DOT','MATIC','ARB','OP','SUI','PEPE','LTC'];
  if (CRYPTO.includes(u)) return `BINANCE:${u}USDT`;
  if (u.endsWith('USDT')||u.endsWith('USDC')) return `BINANCE:${u}`;
  if (/^\d{6}$/.test(u)) return `KRX:${u}`;
  if (u==='GOLD'||u==='XAUUSD') return 'OANDA:XAUUSD';
  if (u==='OIL'||u==='WTI') return 'TVC:USOIL';
  if (u==='SPX') return 'SP:SPX'; if (u==='NDX') return 'NASDAQ:NDX';
  if (u==='DXY') return 'TVC:DXY';
  const AMEX=['SPY','QQQ','TQQQ','SOXL','ARKK','GLD','SLV','IWM','DIA'];
  if (AMEX.includes(u)) return `AMEX:${u}`;
  return `NASDAQ:${u}`;
}

/* ── Featured symbols for inline chart ── */
/* ── TV Featured Assets — Featured only (fast load)
   All other US stocks searched dynamically via TradingView symbol input
   ────────────────────────────────────────────────────────────────── */

// Sub-categories for the stock list (used for filtering)
type TVCat = 'crypto'|'stock'|'krstock'|'etf'|'index'|'commodity'|'forex'|
             'stock_tech'|'stock_ai'|'stock_finance'|'stock_energy'|
             'stock_health'|'stock_consumer'|'stock_defense'|'stock_meme';

interface TVAsset {
  sym: string; label: string; tv: string;
  cat: string; clr: string;
  logo?: string;   // clearbit domain
  featured?: boolean;
}

const TV_STOCKS_US: TVAsset[] = [
  /* ── Mega-cap Tech ── */
  {sym:'AAPL', label:'애플',          tv:'NASDAQ:AAPL', cat:'stock_tech',    clr:'#A0A0A0',logo:'apple.com',     featured:true},
  {sym:'MSFT', label:'마이크로소프트', tv:'NASDAQ:MSFT', cat:'stock_tech',    clr:'#00A4EF',logo:'microsoft.com', featured:true},
  {sym:'NVDA', label:'엔비디아',       tv:'NASDAQ:NVDA', cat:'stock_ai',      clr:'#76B900',logo:'nvidia.com',    featured:true},
  {sym:'GOOGL',label:'구글(A)',        tv:'NASDAQ:GOOGL',cat:'stock_tech',    clr:'#4285F4',logo:'google.com',    featured:true},
  {sym:'GOOG', label:'구글(C)',        tv:'NASDAQ:GOOG', cat:'stock_tech',    clr:'#4285F4',logo:'google.com'},
  {sym:'AMZN', label:'아마존',         tv:'NASDAQ:AMZN', cat:'stock_tech',    clr:'#FF9900',logo:'amazon.com',    featured:true},
  {sym:'META', label:'메타',           tv:'NASDAQ:META', cat:'stock_tech',    clr:'#0082FB',logo:'meta.com',      featured:true},
  {sym:'TSLA', label:'테슬라',         tv:'NASDAQ:TSLA', cat:'stock_tech',    clr:'#CC0000',logo:'tesla.com',     featured:true},
  {sym:'ORCL', label:'오라클',         tv:'NYSE:ORCL',   cat:'stock_tech',    clr:'#F80000',logo:'oracle.com'},
  {sym:'SAP',  label:'SAP',            tv:'NYSE:SAP',    cat:'stock_tech',    clr:'#008FD3',logo:'sap.com'},
  {sym:'CRM',  label:'세일즈포스',     tv:'NYSE:CRM',    cat:'stock_tech',    clr:'#00A1E0',logo:'salesforce.com'},
  {sym:'ADBE', label:'어도비',         tv:'NASDAQ:ADBE', cat:'stock_tech',    clr:'#FF0000',logo:'adobe.com'},
  {sym:'NOW',  label:'서비스나우',     tv:'NYSE:NOW',    cat:'stock_tech',    clr:'#81B5A1',logo:'servicenow.com'},
  {sym:'INTU', label:'인튜이트',       tv:'NASDAQ:INTU', cat:'stock_tech',    clr:'#236CC1',logo:'intuit.com'},
  {sym:'CSCO', label:'시스코',         tv:'NASDAQ:CSCO', cat:'stock_tech',    clr:'#1BA0D7',logo:'cisco.com'},
  {sym:'IBM',  label:'IBM',            tv:'NYSE:IBM',    cat:'stock_tech',    clr:'#006699'},
  {sym:'SHOP', label:'쇼피파이',       tv:'NYSE:SHOP',   cat:'stock_tech',    clr:'#96BF48',logo:'shopify.com'},
  {sym:'SNOW', label:'스노우플레이크', tv:'NYSE:SNOW',   cat:'stock_tech',    clr:'#29B5E8'},
  {sym:'NET',  label:'클라우드플레어', tv:'NYSE:NET',    cat:'stock_tech',    clr:'#F48120',logo:'cloudflare.com'},
  {sym:'ZS',   label:'지스케일러',     tv:'NASDAQ:ZS',   cat:'stock_tech',    clr:'#005DAA'},
  {sym:'OKTA', label:'옥타',           tv:'NASDAQ:OKTA', cat:'stock_tech',    clr:'#007DC1'},
  {sym:'DDOG', label:'데이터독',       tv:'NASDAQ:DDOG', cat:'stock_tech',    clr:'#632CA6'},
  {sym:'TEAM', label:'아틀라시안',     tv:'NASDAQ:TEAM', cat:'stock_tech',    clr:'#0052CC',logo:'atlassian.com'},
  {sym:'UBER', label:'우버',           tv:'NYSE:UBER',   cat:'stock_tech',    clr:'#000000',logo:'uber.com'},
  {sym:'LYFT', label:'리프트',         tv:'NASDAQ:LYFT', cat:'stock_tech',    clr:'#FF00BF'},
  {sym:'ABNB', label:'에어비앤비',     tv:'NASDAQ:ABNB', cat:'stock_tech',    clr:'#FF5A5F',logo:'airbnb.com'},
  {sym:'BKNG', label:'부킹홀딩스',     tv:'NASDAQ:BKNG', cat:'stock_tech',    clr:'#003580',logo:'booking.com'},
  {sym:'DASH', label:'도어대시',       tv:'NYSE:DASH',   cat:'stock_tech',    clr:'#FF3008'},
  {sym:'PINS', label:'핀터레스트',     tv:'NYSE:PINS',   cat:'stock_tech',    clr:'#E60023'},
  {sym:'SNAP', label:'스냅챗',         tv:'NYSE:SNAP',   cat:'stock_tech',    clr:'#FFFC00'},
  {sym:'RBLX', label:'로블록스',       tv:'NYSE:RBLX',   cat:'stock_tech',    clr:'#E52207'},
  {sym:'NFLX', label:'넷플릭스',       tv:'NASDAQ:NFLX', cat:'stock_consumer',clr:'#E50914',logo:'netflix.com',  featured:true},
  {sym:'DIS',  label:'디즈니',         tv:'NYSE:DIS',    cat:'stock_consumer',clr:'#113CCF',logo:'disney.com'},
  {sym:'WBD',  label:'워너브라더스',   tv:'NASDAQ:WBD',  cat:'stock_consumer',clr:'#003087'},
  {sym:'SPOT', label:'스포티파이',     tv:'NYSE:SPOT',   cat:'stock_tech',    clr:'#1DB954',logo:'spotify.com'},
  /* ── AI & Semiconductors ── */
  {sym:'AMD',  label:'AMD',            tv:'NASDAQ:AMD',  cat:'stock_ai',      clr:'#ED1C24',logo:'amd.com',      featured:true},
  {sym:'INTC', label:'인텔',           tv:'NASDAQ:INTC', cat:'stock_ai',      clr:'#0071C5',logo:'intel.com',    featured:true},
  {sym:'AVGO', label:'브로드컴',       tv:'NASDAQ:AVGO', cat:'stock_ai',      clr:'#CC0000',logo:'broadcom.com', featured:true},
  {sym:'QCOM', label:'퀄컴',           tv:'NASDAQ:QCOM', cat:'stock_ai',      clr:'#3253DC',logo:'qualcomm.com', featured:true},
  {sym:'TSM',  label:'TSMC',           tv:'NYSE:TSM',    cat:'stock_ai',      clr:'#BB2A35',                    featured:true},
  {sym:'ASML', label:'ASML',           tv:'NASDAQ:ASML', cat:'stock_ai',      clr:'#0072CE',logo:'asml.com'},
  {sym:'MU',   label:'마이크론',       tv:'NASDAQ:MU',   cat:'stock_ai',      clr:'#1C4F8C',logo:'micron.com'},
  {sym:'LRCX', label:'램리서치',       tv:'NASDAQ:LRCX', cat:'stock_ai',      clr:'#006699'},
  {sym:'AMAT', label:'어플라이드머티리얼',tv:'NASDAQ:AMAT',cat:'stock_ai',   clr:'#1976D2'},
  {sym:'KLAC', label:'KLA Corp',       tv:'NASDAQ:KLAC', cat:'stock_ai',      clr:'#003366'},
  {sym:'MRVL', label:'마벨테크',       tv:'NASDAQ:MRVL', cat:'stock_ai',      clr:'#0067B0'},
  {sym:'ARM',  label:'ARM홀딩스',      tv:'NASDAQ:ARM',  cat:'stock_ai',      clr:'#00C0C0'},
  {sym:'SMCI', label:'슈퍼마이크로',   tv:'NASDAQ:SMCI', cat:'stock_ai',      clr:'#006699'},
  {sym:'PLTR', label:'팔란티어',       tv:'NYSE:PLTR',   cat:'stock_ai',      clr:'#000000',                    featured:true},
  {sym:'AI',   label:'C3.ai',          tv:'NYSE:AI',     cat:'stock_ai',      clr:'#00A3E0'},
  {sym:'SOUN', label:'사운드하운드',   tv:'NASDAQ:SOUN', cat:'stock_ai',      clr:'#FF6B00'},
  {sym:'BBAI', label:'BigBear.ai',     tv:'NYSE:BBAI',   cat:'stock_ai',      clr:'#1A73E8'},
  /* ── Finance ── */
  {sym:'JPM',  label:'JP모건',         tv:'NYSE:JPM',    cat:'stock_finance', clr:'#006DAE',logo:'jpmorganchase.com',featured:true},
  {sym:'BAC',  label:'뱅크오브아메리카',tv:'NYSE:BAC',   cat:'stock_finance', clr:'#E31837',logo:'bankofamerica.com',featured:true},
  {sym:'GS',   label:'골드만삭스',     tv:'NYSE:GS',     cat:'stock_finance', clr:'#6C8EBF',                    featured:true},
  {sym:'MS',   label:'모건스탠리',     tv:'NYSE:MS',     cat:'stock_finance', clr:'#003087',                    featured:true},
  {sym:'WFC',  label:'웰스파고',       tv:'NYSE:WFC',    cat:'stock_finance', clr:'#D71E28',logo:'wellsfargo.com'},
  {sym:'C',    label:'씨티그룹',       tv:'NYSE:C',      cat:'stock_finance', clr:'#003B70',logo:'citi.com'},
  {sym:'BLK',  label:'블랙록',         tv:'NYSE:BLK',    cat:'stock_finance', clr:'#000000',logo:'blackrock.com'},
  {sym:'BRK.B',label:'버크셔해서웨이B',tv:'NYSE:BRK.B',  cat:'stock_finance', clr:'#003087'},
  {sym:'V',    label:'비자',           tv:'NYSE:V',      cat:'stock_finance', clr:'#1A1F71',logo:'visa.com',     featured:true},
  {sym:'MA',   label:'마스터카드',     tv:'NYSE:MA',     cat:'stock_finance', clr:'#EB001B',logo:'mastercard.com',featured:true},
  {sym:'AXP',  label:'아메리칸익스프레스',tv:'NYSE:AXP', cat:'stock_finance', clr:'#006FCF',logo:'americanexpress.com'},
  {sym:'PYPL', label:'페이팔',         tv:'NASDAQ:PYPL', cat:'stock_finance', clr:'#009CDE',logo:'paypal.com',   featured:true},
  {sym:'SQ',   label:'블록(스퀘어)',   tv:'NYSE:SQ',     cat:'stock_finance', clr:'#006AFF',                    featured:true},
  {sym:'COIN', label:'코인베이스',     tv:'NASDAQ:COIN', cat:'stock_finance', clr:'#0052FF',logo:'coinbase.com', featured:true},
  {sym:'HOOD', label:'로빈후드',       tv:'NASDAQ:HOOD', cat:'stock_finance', clr:'#00C805',logo:'robinhood.com',featured:true},
  {sym:'NU',   label:'누홀딩스',       tv:'NYSE:NU',     cat:'stock_finance', clr:'#8A05BE'},
  {sym:'SOFI', label:'소파이',         tv:'NASDAQ:SOFI', cat:'stock_meme',    clr:'#7B40F2',                    featured:true},
  {sym:'AFRM', label:'어펌',           tv:'NASDAQ:AFRM', cat:'stock_finance', clr:'#0FA0EA'},
  {sym:'NDAQ', label:'나스닥Inc',      tv:'NASDAQ:NDAQ', cat:'stock_finance', clr:'#2775CA'},
  {sym:'CME',  label:'CME그룹',        tv:'NASDAQ:CME',  cat:'stock_finance', clr:'#003366'},
  /* ── Energy ── */
  {sym:'XOM',  label:'엑슨모빌',       tv:'NYSE:XOM',    cat:'stock_energy',  clr:'#E01A2B',logo:'exxonmobil.com',featured:true},
  {sym:'CVX',  label:'셰브론',         tv:'NYSE:CVX',    cat:'stock_energy',  clr:'#009DD9',logo:'chevron.com',  featured:true},
  {sym:'OXY',  label:'옥시덴탈',       tv:'NYSE:OXY',    cat:'stock_energy',  clr:'#D23229',                    featured:true},
  {sym:'SLB',  label:'슐럼버거',       tv:'NYSE:SLB',    cat:'stock_energy',  clr:'#0067A5',                    featured:true},
  {sym:'COP',  label:'코노코필립스',   tv:'NYSE:COP',    cat:'stock_energy',  clr:'#E2231A'},
  {sym:'PXD',  label:'파이오니어NR',   tv:'NYSE:PXD',    cat:'stock_energy',  clr:'#006B3C'},
  {sym:'MPC',  label:'마라톤페트롤리움',tv:'NYSE:MPC',   cat:'stock_energy',  clr:'#006B3C'},
  {sym:'PSX',  label:'필립스66',       tv:'NYSE:PSX',    cat:'stock_energy',  clr:'#E31837'},
  {sym:'VLO',  label:'발레로에너지',   tv:'NYSE:VLO',    cat:'stock_energy',  clr:'#002A5E'},
  {sym:'NEE',  label:'넥스트에라에너지',tv:'NYSE:NEE',   cat:'stock_energy',  clr:'#0078D4'},
  {sym:'ENPH', label:'인페이즈에너지', tv:'NASDAQ:ENPH', cat:'stock_energy',  clr:'#FF6600'},
  {sym:'FSLR', label:'퍼스트솔라',     tv:'NASDAQ:FSLR', cat:'stock_energy',  clr:'#007BC0'},
  /* ── Healthcare ── */
  {sym:'LLY',  label:'일라이릴리',     tv:'NYSE:LLY',    cat:'stock_health',  clr:'#D52B1E',logo:'lilly.com',    featured:true},
  {sym:'UNH',  label:'유나이티드헬스', tv:'NYSE:UNH',    cat:'stock_health',  clr:'#316BBE',logo:'unitedhealthgroup.com',featured:true},
  {sym:'JNJ',  label:'존슨앤존슨',     tv:'NYSE:JNJ',    cat:'stock_health',  clr:'#CC0000',logo:'jnj.com',      featured:true},
  {sym:'PFE',  label:'화이자',         tv:'NYSE:PFE',    cat:'stock_health',  clr:'#0093D0',logo:'pfizer.com',   featured:true},
  {sym:'MRK',  label:'머크',           tv:'NYSE:MRK',    cat:'stock_health',  clr:'#0071A9',logo:'merck.com',    featured:true},
  {sym:'ABBV', label:'애브비',         tv:'NYSE:ABBV',   cat:'stock_health',  clr:'#071D49',logo:'abbvie.com',   featured:true},
  {sym:'BMY',  label:'BMS',            tv:'NYSE:BMY',    cat:'stock_health',  clr:'#003B5C'},
  {sym:'AMGN', label:'암젠',           tv:'NASDAQ:AMGN', cat:'stock_health',  clr:'#003087',logo:'amgen.com'},
  {sym:'GILD', label:'길리어드',       tv:'NASDAQ:GILD', cat:'stock_health',  clr:'#CC0000',logo:'gilead.com'},
  {sym:'ISRG', label:'인튜이티브서지컬',tv:'NASDAQ:ISRG',cat:'stock_health',  clr:'#003B70'},
  {sym:'SYK',  label:'스트라이커',     tv:'NYSE:SYK',    cat:'stock_health',  clr:'#0072CE'},
  {sym:'REGN', label:'리제너론',       tv:'NASDAQ:REGN', cat:'stock_health',  clr:'#00549F'},
  {sym:'MRNA', label:'모더나',         tv:'NASDAQ:MRNA', cat:'stock_health',  clr:'#0040C9',logo:'modernatx.com'},
  {sym:'BIIB', label:'바이오젠',       tv:'NASDAQ:BIIB', cat:'stock_health',  clr:'#CC0000'},
  {sym:'VRTX', label:'버텍스파마',     tv:'NASDAQ:VRTX', cat:'stock_health',  clr:'#C8002A'},
  {sym:'ZBH',  label:'짐머바이오멧',   tv:'NYSE:ZBH',    cat:'stock_health',  clr:'#005B9A'},
  {sym:'CVS',  label:'CVS헬스',        tv:'NYSE:CVS',    cat:'stock_health',  clr:'#CC0000',logo:'cvshealth.com'},
  {sym:'CI',   label:'시그나',         tv:'NYSE:CI',     cat:'stock_health',  clr:'#003087'},
  {sym:'MCK',  label:'맥케슨',         tv:'NYSE:MCK',    cat:'stock_health',  clr:'#005B99'},
  /* ── Consumer / Retail ── */
  {sym:'WMT',  label:'월마트',         tv:'NYSE:WMT',    cat:'stock_consumer',clr:'#0071CE',logo:'walmart.com',  featured:true},
  {sym:'COST', label:'코스트코',       tv:'NASDAQ:COST', cat:'stock_consumer',clr:'#005DAA',logo:'costco.com',   featured:true},
  {sym:'MCD',  label:'맥도날드',       tv:'NYSE:MCD',    cat:'stock_consumer',clr:'#DA291C',logo:'mcdonalds.com',featured:true},
  {sym:'SBUX', label:'스타벅스',       tv:'NASDAQ:SBUX', cat:'stock_consumer',clr:'#00704A',logo:'starbucks.com',featured:true},
  {sym:'KO',   label:'코카콜라',       tv:'NYSE:KO',     cat:'stock_consumer',clr:'#F40000',logo:'coca-cola.com', featured:true},
  {sym:'PEP',  label:'펩시코',         tv:'NASDAQ:PEP',  cat:'stock_consumer',clr:'#004B93',logo:'pepsico.com',  featured:true},
  {sym:'NKE',  label:'나이키',         tv:'NYSE:NKE',    cat:'stock_consumer',clr:'#111111',logo:'nike.com',     featured:true},
  {sym:'LULU', label:'룰루레몬',       tv:'NASDAQ:LULU', cat:'stock_consumer',clr:'#A2006D',logo:'lululemon.com'},
  {sym:'TGT',  label:'타겟',           tv:'NYSE:TGT',    cat:'stock_consumer',clr:'#CC0000',logo:'target.com'},
  {sym:'HD',   label:'홈데포',         tv:'NYSE:HD',     cat:'stock_consumer',clr:'#F96302',logo:'homedepot.com'},
  {sym:'LOW',  label:'로우스',         tv:'NYSE:LOW',    cat:'stock_consumer',clr:'#004990'},
  {sym:'AMZN', label:'아마존',         tv:'NASDAQ:AMZN', cat:'stock_consumer',clr:'#FF9900',logo:'amazon.com'},
  {sym:'EBAY', label:'이베이',         tv:'NASDAQ:EBAY', cat:'stock_consumer',clr:'#E53238',logo:'ebay.com'},
  {sym:'ETSY', label:'엣시',           tv:'NASDAQ:ETSY', cat:'stock_consumer',clr:'#F56400'},
  {sym:'YUM',  label:'Yum!브랜즈',     tv:'NYSE:YUM',    cat:'stock_consumer',clr:'#EE3A2E'},
  {sym:'CMG',  label:'치폴레',         tv:'NYSE:CMG',    cat:'stock_consumer',clr:'#441B13',logo:'chipotle.com'},
  {sym:'GM',   label:'GM',             tv:'NYSE:GM',     cat:'stock_consumer',clr:'#0170CE',logo:'gm.com'},
  {sym:'F',    label:'포드',           tv:'NYSE:F',      cat:'stock_consumer',clr:'#003499',logo:'ford.com'},
  {sym:'RIVN', label:'리비안',         tv:'NASDAQ:RIVN', cat:'stock_meme',    clr:'#3DD286',logo:'rivian.com',   featured:true},
  {sym:'NIO',  label:'니오',           tv:'NYSE:NIO',    cat:'stock_meme',    clr:'#2BACE2',logo:'nio.com',      featured:true},
  {sym:'LCID', label:'루시드모터스',   tv:'NASDAQ:LCID', cat:'stock_meme',    clr:'#00B2E3'},
  {sym:'LI',   label:'리오토',         tv:'NASDAQ:LI',   cat:'stock_consumer',clr:'#1F85DE'},
  {sym:'XPEV', label:'샤오펑',         tv:'NYSE:XPEV',   cat:'stock_consumer',clr:'#29B7EA'},
  /* ── Defense ── */
  {sym:'BA',   label:'보잉',           tv:'NYSE:BA',     cat:'stock_defense', clr:'#1D4289',logo:'boeing.com',   featured:true},
  {sym:'LMT',  label:'록히드마틴',     tv:'NYSE:LMT',    cat:'stock_defense', clr:'#003087',logo:'lockheedmartin.com',featured:true},
  {sym:'RTX',  label:'RTX(레이시온)',  tv:'NYSE:RTX',    cat:'stock_defense', clr:'#003087',logo:'rtx.com',      featured:true},
  {sym:'NOC',  label:'노스롭그루만',   tv:'NYSE:NOC',    cat:'stock_defense', clr:'#003087',logo:'northropgrumman.com',featured:true},
  {sym:'GD',   label:'제너럴다이내믹스',tv:'NYSE:GD',    cat:'stock_defense', clr:'#003087'},
  {sym:'HII',  label:'헌팅턴잉걸스',  tv:'NYSE:HII',    cat:'stock_defense', clr:'#003087'},
  {sym:'L3H',  label:'L3해리스',       tv:'NYSE:LHX',    cat:'stock_defense', clr:'#003087'},
  {sym:'CAT',  label:'캐터필러',       tv:'NYSE:CAT',    cat:'stock_defense', clr:'#FFCD11',logo:'caterpillar.com'},
  {sym:'DE',   label:'존디어',         tv:'NYSE:DE',     cat:'stock_consumer',clr:'#367C2B',logo:'deere.com'},
  {sym:'GE',   label:'GE에어로스페이스',tv:'NYSE:GE',    cat:'stock_defense', clr:'#003087',logo:'ge.com'},
  /* ── Meme / High-volume ── */
  {sym:'GME',  label:'게임스탑',       tv:'NYSE:GME',    cat:'stock_meme',    clr:'#E31937',logo:'gamestop.com', featured:true},
  {sym:'AMC',  label:'AMC',            tv:'NYSE:AMC',    cat:'stock_meme',    clr:'#E31937',logo:'amctheatres.com',featured:true},
  {sym:'BBBY', label:'베드배스앤비욘드',tv:'NASDAQ:BBBY', cat:'stock_meme',   clr:'#003087'},
  {sym:'SPCE', label:'버진갤럭틱',     tv:'NYSE:SPCE',   cat:'stock_meme',    clr:'#222222'},
  {sym:'WISH', label:'컨텍스트로직',   tv:'NASDAQ:WISH', cat:'stock_meme',    clr:'#2FB7EC'},
  {sym:'CLOV', label:'클로버헬스',     tv:'NASDAQ:CLOV', cat:'stock_meme',    clr:'#00873D'},
  {sym:'APLD', label:'어플라이드디지털',tv:'NASDAQ:APLD',cat:'stock_meme',    clr:'#9C27B0'},
  {sym:'MSTR', label:'마이크로스트레티지',tv:'NASDAQ:MSTR',cat:'stock_meme', clr:'#E87426',logo:'microstrategy.com',featured:true},
  {sym:'CLSK', label:'클린스파크',     tv:'NASDAQ:CLSK', cat:'stock_meme',    clr:'#6DB33F'},
  {sym:'HUT',  label:'허트마이닝',     tv:'NASDAQ:HUT',  cat:'stock_meme',    clr:'#FF6B00'},
  /* ── Other notable ── */
  {sym:'V',    label:'비자',           tv:'NYSE:V',      cat:'stock_finance', clr:'#1A1F71',logo:'visa.com'},
  {sym:'MA',   label:'마스터카드',     tv:'NYSE:MA',     cat:'stock_finance', clr:'#EB001B',logo:'mastercard.com'},
  {sym:'UPS',  label:'UPS',            tv:'NYSE:UPS',    cat:'stock_consumer',clr:'#330000',logo:'ups.com'},
  {sym:'FDX',  label:'페덱스',         tv:'NYSE:FDX',    cat:'stock_consumer',clr:'#4D148C',logo:'fedex.com'},
  {sym:'NFLX', label:'넷플릭스',       tv:'NASDAQ:NFLX', cat:'stock_consumer',clr:'#E50914',logo:'netflix.com'},
  {sym:'ZM',   label:'줌비디오',       tv:'NASDAQ:ZM',   cat:'stock_tech',    clr:'#2D8CFF',logo:'zoom.us'},
  {sym:'DOCU', label:'도큐사인',       tv:'NASDAQ:DOCU', cat:'stock_tech',    clr:'#26B5E8'},
  {sym:'BILL', label:'빌닷컴',         tv:'NYSE:BILL',   cat:'stock_tech',    clr:'#0078D4'},
  {sym:'TTD',  label:'트레이드데스크', tv:'NASDAQ:TTD',  cat:'stock_tech',    clr:'#2BACE2'},
  {sym:'HOOD', label:'로빈후드',       tv:'NASDAQ:HOOD', cat:'stock_meme',    clr:'#00C805'},
  {sym:'OPEN', label:'오픈도어',       tv:'NASDAQ:OPEN', cat:'stock_tech',    clr:'#FF5733'},
  {sym:'LMND', label:'레모네이드',     tv:'NYSE:LMND',   cat:'stock_tech',    clr:'#FF0082'},
  {sym:'BYND', label:'비욘드미트',     tv:'NASDAQ:BYND', cat:'stock_consumer',clr:'#B5D334'},
  {sym:'OATLY',label:'오틀리',         tv:'NASDAQ:OTLY', cat:'stock_consumer',clr:'#F2E6D3'},
  {sym:'DKNG', label:'드래프트킹스',   tv:'NASDAQ:DKNG', cat:'stock_meme',    clr:'#61A44F'},
  {sym:'PENN', label:'펜인터랙티브',   tv:'NASDAQ:PENN', cat:'stock_consumer',clr:'#C0392B'},
  {sym:'MGM',  label:'MGM리조트',      tv:'NYSE:MGM',    cat:'stock_consumer',clr:'#00439C'},
  {sym:'LVS',  label:'라스베거스샌즈', tv:'NYSE:LVS',    cat:'stock_consumer',clr:'#003087'},
  {sym:'WYNN', label:'윈리조트',       tv:'NASDAQ:WYNN', cat:'stock_consumer',clr:'#8B6914'},
  {sym:'TWLO', label:'트윌리오',       tv:'NYSE:TWLO',   cat:'stock_tech',    clr:'#F22F46'},
  {sym:'HubS', label:'허브스팟',       tv:'NYSE:HUBS',   cat:'stock_tech',    clr:'#FF7A59',logo:'hubspot.com'},
  {sym:'ASAN', label:'아사나',         tv:'NYSE:ASAN',   cat:'stock_tech',    clr:'#F95C2A'},
  {sym:'ZI',   label:'줌인포',         tv:'NASDAQ:ZI',   cat:'stock_tech',    clr:'#5A35B4'},
  {sym:'U',    label:'유니티',         tv:'NYSE:U',      cat:'stock_tech',    clr:'#221D1E'},
  {sym:'EA',   label:'일렉트로닉아츠', tv:'NASDAQ:EA',   cat:'stock_tech',    clr:'#FF4747',logo:'ea.com'},
  {sym:'TTWO', label:'테이크투',       tv:'NASDAQ:TTWO', cat:'stock_tech',    clr:'#003087'},
  {sym:'ATVI', label:'액티비전블리자드',tv:'NASDAQ:ATVI', cat:'stock_tech',   clr:'#148EFF'},
  {sym:'NTES', label:'넷이즈',         tv:'NASDAQ:NTES', cat:'stock_tech',    clr:'#CC0000'},
  {sym:'SE',   label:'씨(시),가레나', tv:'NYSE:SE',     cat:'stock_tech',    clr:'#EE4D2D'},
  {sym:'GRAB', label:'그랩',           tv:'NASDAQ:GRAB', cat:'stock_tech',    clr:'#00B14F'},
  {sym:'BABA', label:'알리바바',       tv:'NYSE:BABA',   cat:'stock_tech',    clr:'#FF6A00'},
  {sym:'JD',   label:'징둥닷컴',       tv:'NASDAQ:JD',   cat:'stock_tech',    clr:'#E31837'},
  {sym:'PDD',  label:'핀둬둬',         tv:'NASDAQ:PDD',  cat:'stock_tech',    clr:'#E31837'},
  {sym:'TCOM', label:'트립닷컴',       tv:'NASDAQ:TCOM', cat:'stock_tech',    clr:'#3498DB'},
  {sym:'WBX',  label:'위보그룹',       tv:'NASDAQ:WB',   cat:'stock_tech',    clr:'#FA7D3C'},
  {sym:'TSM',  label:'TSMC',           tv:'NYSE:TSM',    cat:'stock_ai',      clr:'#BB2A35'},
  {sym:'SONY', label:'소니',           tv:'NYSE:SONY',   cat:'stock_tech',    clr:'#003087',logo:'sony.com'},
  {sym:'TM',   label:'토요타',         tv:'NYSE:TM',     cat:'stock_consumer',clr:'#EB0A1E',logo:'toyota.com'},
  {sym:'HMC',  label:'혼다',           tv:'NYSE:HMC',    cat:'stock_consumer',clr:'#CC0000',logo:'honda.com'},
  {sym:'SNY',  label:'사노피',         tv:'NASDAQ:SNY',  cat:'stock_health',  clr:'#7D219E'},
  {sym:'NVO',  label:'노보노디스크',   tv:'NYSE:NVO',    cat:'stock_health',  clr:'#0099DA'},
  {sym:'NOVO', label:'노보노디스크B',  tv:'NYSE:NVO',    cat:'stock_health',  clr:'#0099DA'},
  {sym:'AZN',  label:'아스트라제네카', tv:'NASDAQ:AZN',  cat:'stock_health',  clr:'#003087',logo:'astrazeneca.com'},
  {sym:'RPRX', label:'로열티파마',     tv:'NASDAQ:RPRX', cat:'stock_health',  clr:'#003087'},
  {sym:'ARKG', label:'ARK게노믹스',    tv:'NASDAQ:ARKG', cat:'etf',           clr:'#7C3AED'},
  {sym:'SPG',  label:'사이먼프로퍼티', tv:'NYSE:SPG',    cat:'stock_finance', clr:'#003087'},
  {sym:'O',    label:'리얼티인컴',     tv:'NYSE:O',      cat:'stock_finance', clr:'#003087'},
  {sym:'AMT',  label:'아메리칸타워',   tv:'NYSE:AMT',    cat:'stock_finance', clr:'#003087'},
  {sym:'PLD',  label:'프롤로지스',     tv:'NYSE:PLD',    cat:'stock_finance', clr:'#003087'},
  {sym:'EQIX', label:'에퀴닉스',       tv:'NASDAQ:EQIX', cat:'stock_tech',    clr:'#003087'},
  {sym:'DLR',  label:'디지털리얼티',   tv:'NYSE:DLR',    cat:'stock_tech',    clr:'#003087'},
  {sym:'WM',   label:'웨이스트매니지먼트',tv:'NYSE:WM',  cat:'stock_consumer',clr:'#00A651'},
  {sym:'RSG',  label:'리퍼블릭서비스', tv:'NYSE:RSG',    cat:'stock_consumer',clr:'#003087'},
  {sym:'SPGI', label:'S&P글로벌',      tv:'NYSE:SPGI',   cat:'stock_finance', clr:'#003087'},
  {sym:'MCO',  label:'무디스',         tv:'NYSE:MCO',    cat:'stock_finance', clr:'#003087'},
  {sym:'ICE',  label:'인터컨티넨탈익스체인지',tv:'NYSE:ICE',cat:'stock_finance',clr:'#003087'},
  {sym:'COF',  label:'캐피탈원',       tv:'NYSE:COF',    cat:'stock_finance', clr:'#D22630'},
  {sym:'DFS',  label:'디스커버',       tv:'NYSE:DFS',    cat:'stock_finance', clr:'#E36C00'},
  {sym:'USB',  label:'US뱅크코프',     tv:'NYSE:USB',    cat:'stock_finance', clr:'#003087'},
  {sym:'PNC',  label:'PNC파이낸셜',    tv:'NYSE:PNC',    cat:'stock_finance', clr:'#E21836'},
  {sym:'TFC',  label:'트루이스트',     tv:'NYSE:TFC',    cat:'stock_finance', clr:'#503291'},
];

// ETFs
const TV_ETFS: TVAsset[] = [
  {sym:'SPY',  label:'S&P500 ETF',    tv:'AMEX:SPY',    cat:'etf', clr:'#1D4ED8',logo:'ssga.com',   featured:true},
  {sym:'QQQ',  label:'나스닥100 ETF', tv:'NASDAQ:QQQ',  cat:'etf', clr:'#7C3AED',                  featured:true},
  {sym:'IWM',  label:'러셀2000 ETF',  tv:'AMEX:IWM',    cat:'etf', clr:'#059669',                  featured:true},
  {sym:'DIA',  label:'다우존스 ETF',  tv:'AMEX:DIA',    cat:'etf', clr:'#D97706',                  featured:true},
  {sym:'VTI',  label:'미국전체시장',  tv:'AMEX:VTI',    cat:'etf', clr:'#1D4ED8'},
  {sym:'VOO',  label:'뱅가드S&P500',  tv:'AMEX:VOO',    cat:'etf', clr:'#1D4ED8'},
  {sym:'GLD',  label:'금 ETF',        tv:'AMEX:GLD',    cat:'etf', clr:'#D97706'},
  {sym:'SLV',  label:'은 ETF',        tv:'AMEX:SLV',    cat:'etf', clr:'#94A3B8'},
  {sym:'USO',  label:'WTI원유 ETF',   tv:'AMEX:USO',    cat:'etf', clr:'#78350F'},
  {sym:'TLT',  label:'20년 국채 ETF', tv:'NASDAQ:TLT',  cat:'etf', clr:'#1D4ED8'},
  {sym:'HYG',  label:'하이일드채권',  tv:'AMEX:HYG',    cat:'etf', clr:'#059669'},
  {sym:'TQQQ', label:'나스닥3배레버리지',tv:'NASDAQ:TQQQ',cat:'etf',clr:'#7C3AED',               featured:true},
  {sym:'SQQQ', label:'나스닥3배인버스',tv:'NASDAQ:SQQQ', cat:'etf',clr:'#DC2626',                  featured:true},
  {sym:'SOXL', label:'반도체3배레버리지',tv:'AMEX:SOXL', cat:'etf', clr:'#7C3AED',                featured:true},
  {sym:'SOXS', label:'반도체3배인버스',tv:'AMEX:SOXS',  cat:'etf', clr:'#DC2626',                  featured:true},
  {sym:'UPRO', label:'S&P3배레버리지', tv:'AMEX:UPRO',  cat:'etf', clr:'#1D4ED8'},
  {sym:'SPXS', label:'S&P3배인버스',  tv:'AMEX:SPXS',   cat:'etf', clr:'#DC2626'},
  {sym:'ARKK', label:'ARK이노베이션', tv:'AMEX:ARKK',   cat:'etf', clr:'#7C3AED',logo:'ark-invest.com',featured:true},
  {sym:'ARKW', label:'ARK넥스트인터넷',tv:'AMEX:ARKW',  cat:'etf', clr:'#7C3AED'},
  {sym:'XLK',  label:'기술섹터 ETF',  tv:'AMEX:XLK',    cat:'etf', clr:'#2563EB'},
  {sym:'XLF',  label:'금융섹터 ETF',  tv:'AMEX:XLF',    cat:'etf', clr:'#059669'},
  {sym:'XLE',  label:'에너지섹터 ETF',tv:'AMEX:XLE',    cat:'etf', clr:'#D97706'},
  {sym:'XLV',  label:'헬스케어섹터',  tv:'AMEX:XLV',    cat:'etf', clr:'#DC2626'},
  {sym:'SOXX', label:'반도체 ETF',    tv:'NASDAQ:SOXX', cat:'etf', clr:'#7C3AED'},
  {sym:'VXX',  label:'VIX ETF(단기)', tv:'AMEX:VXX',    cat:'etf', clr:'#6B7280'},
];

// Indices & Macro
const TV_INDICES: TVAsset[] = [
  {sym:'SPX',  label:'S&P 500',       tv:'SP:SPX',      cat:'index',  clr:'#6366F1',featured:true},
  {sym:'NDX',  label:'나스닥100',      tv:'NASDAQ:NDX',  cat:'index',  clr:'#7C3AED',featured:true},
  {sym:'DJI',  label:'다우존스',       tv:'DJ:DJI',      cat:'index',  clr:'#1D4ED8',featured:true},
  {sym:'RUT',  label:'러셀2000',       tv:'TVC:RUT',     cat:'index',  clr:'#059669'},
  {sym:'VIX',  label:'공포지수 VIX',  tv:'TVC:VIX',     cat:'index',  clr:'#DC2626'},
  {sym:'DXY',  label:'달러인덱스',     tv:'TVC:DXY',     cat:'index',  clr:'#10B981',featured:true},
  {sym:'KOSPI',label:'코스피',         tv:'KRX:KOSPI',   cat:'krstock',clr:'#EF4444'},
  {sym:'N225', label:'닛케이225',      tv:'TVC:NI225',   cat:'index',  clr:'#DC2626'},
  {sym:'HSI',  label:'항셍지수',       tv:'HSI:HSI',     cat:'index',  clr:'#DC2626'},
  {sym:'DAX',  label:'독일DAX',        tv:'XETR:DAX',    cat:'index',  clr:'#1D4ED8'},
  {sym:'FTSE', label:'영국FTSE100',    tv:'INDEX:FTSE',  cat:'index',  clr:'#003087'},
  {sym:'CAC',  label:'프랑스CAC40',    tv:'EURONEXT:CAC',cat:'index',  clr:'#003087'},
];

// Crypto (top 30)
const TV_CRYPTO: TVAsset[] = [
  {sym:'BTC',  label:'비트코인',       tv:'BINANCE:BTCUSDT', cat:'crypto',clr:'#F7931A',featured:true},
  {sym:'ETH',  label:'이더리움',       tv:'BINANCE:ETHUSDT', cat:'crypto',clr:'#627EEA',featured:true},
  {sym:'SOL',  label:'솔라나',         tv:'BINANCE:SOLUSDT', cat:'crypto',clr:'#9945FF',featured:true},
  {sym:'BNB',  label:'바이낸스코인',   tv:'BINANCE:BNBUSDT', cat:'crypto',clr:'#F3BA2F'},
  {sym:'XRP',  label:'리플',           tv:'BINANCE:XRPUSDT', cat:'crypto',clr:'#346AA9'},
  {sym:'DOGE', label:'도지코인',       tv:'BINANCE:DOGEUSDT',cat:'crypto',clr:'#C2A633',featured:true},
  {sym:'ADA',  label:'에이다',         tv:'BINANCE:ADAUSDT', cat:'crypto',clr:'#0D1E2D'},
  {sym:'AVAX', label:'아발란체',       tv:'BINANCE:AVAXUSDT',cat:'crypto',clr:'#E84142'},
  {sym:'LINK', label:'체인링크',       tv:'BINANCE:LINKUSDT',cat:'crypto',clr:'#2A5ADA'},
  {sym:'DOT',  label:'폴카닷',         tv:'BINANCE:DOTUSDT', cat:'crypto',clr:'#E6007A'},
  {sym:'MATIC',label:'폴리곤',         tv:'BINANCE:MATICUSDT',cat:'crypto',clr:'#8247E5'},
  {sym:'UNI',  label:'유니스왑',       tv:'BINANCE:UNIUSDT', cat:'crypto',clr:'#FF007A'},
  {sym:'ARB',  label:'아비트럼',       tv:'BINANCE:ARBUSDT', cat:'crypto',clr:'#28A0F0'},
  {sym:'OP',   label:'옵티미즘',       tv:'BINANCE:OPUSDT',  cat:'crypto',clr:'#FF0420'},
  {sym:'SUI',  label:'수이',           tv:'BINANCE:SUIUSDT', cat:'crypto',clr:'#4CA3FF'},
  {sym:'TON',  label:'톤코인',         tv:'BINANCE:TONUSDT', cat:'crypto',clr:'#0088CC'},
  {sym:'SHIB', label:'시바이누',       tv:'BINANCE:SHIBUSDT',cat:'crypto',clr:'#FFA409'},
  {sym:'PEPE', label:'페페',           tv:'BINANCE:PEPEUSDT',cat:'crypto',clr:'#3BA14C',featured:true},
  {sym:'APT',  label:'앱토스',         tv:'BINANCE:APTUSDT', cat:'crypto',clr:'#00C7B2'},
  {sym:'INJ',  label:'인젝티브',       tv:'BINANCE:INJUSDT', cat:'crypto',clr:'#00F2FE'},
];

// Korean stocks
const TV_KRSTOCKS: TVAsset[] = [
  {sym:'005930',label:'삼성전자',   tv:'KRX:005930',  cat:'krstock',clr:'#1428A0',featured:true},
  {sym:'000660',label:'SK하이닉스', tv:'KRX:000660',  cat:'krstock',clr:'#EA1917',featured:true},
  {sym:'035420',label:'NAVER',      tv:'KRX:035420',  cat:'krstock',clr:'#03C75A'},
  {sym:'035720',label:'카카오',     tv:'KRX:035720',  cat:'krstock',clr:'#FEE500'},
  {sym:'005380',label:'현대차',     tv:'KRX:005380',  cat:'krstock',clr:'#002C5F'},
  {sym:'000270',label:'기아',       tv:'KRX:000270',  cat:'krstock',clr:'#05141F'},
  {sym:'051910',label:'LG화학',     tv:'KRX:051910',  cat:'krstock',clr:'#A50034'},
  {sym:'006400',label:'삼성SDI',    tv:'KRX:006400',  cat:'krstock',clr:'#1428A0'},
  {sym:'207940',label:'삼성바이오로직스',tv:'KRX:207940',cat:'krstock',clr:'#004185'},
  {sym:'003550',label:'LG전자',     tv:'KRX:003550',  cat:'krstock',clr:'#A50034'},
  {sym:'017670',label:'SK텔레콤',   tv:'KRX:017670',  cat:'krstock',clr:'#E2007A'},
  {sym:'055550',label:'신한지주',   tv:'KRX:055550',  cat:'krstock',clr:'#0046FF'},
  {sym:'105560',label:'KB금융',     tv:'KRX:105560',  cat:'krstock',clr:'#FFB300'},
  {sym:'086790',label:'하나금융지주',tv:'KRX:086790', cat:'krstock',clr:'#009F6B'},
];

// Commodities & Forex
const TV_MACRO: TVAsset[] = [
  {sym:'XAUUSD',label:'금(Gold)',    tv:'OANDA:XAUUSD',cat:'commodity',clr:'#FFD700',featured:true},
  {sym:'XAGUSD',label:'은(Silver)',  tv:'OANDA:XAGUSD',cat:'commodity',clr:'#94A3B8'},
  {sym:'USOIL', label:'WTI 원유',    tv:'TVC:USOIL',   cat:'commodity',clr:'#78350F',featured:true},
  {sym:'UKOIL', label:'브렌트유',    tv:'TVC:UKOIL',   cat:'commodity',clr:'#78350F'},
  {sym:'NATGAS',label:'천연가스',    tv:'NYMEX:NG1!',  cat:'commodity',clr:'#2563EB'},
  {sym:'COPPER',label:'구리',        tv:'TVC:COPPER',  cat:'commodity',clr:'#B45309'},
  {sym:'WHEAT', label:'밀',          tv:'CBOT:ZW1!',   cat:'commodity',clr:'#92400E'},
  {sym:'CORN',  label:'옥수수',      tv:'CBOT:ZC1!',   cat:'commodity',clr:'#EAB308'},
  {sym:'EURUSD',label:'유로/달러',   tv:'FX:EURUSD',   cat:'forex',    clr:'#003399',featured:true},
  {sym:'USDJPY',label:'달러/엔',     tv:'FX:USDJPY',   cat:'forex',    clr:'#BC002D',featured:true},
  {sym:'GBPUSD',label:'파운드/달러', tv:'FX:GBPUSD',   cat:'forex',    clr:'#003087'},
  {sym:'USDKRW',label:'달러/원화',   tv:'FX:USDKRW',   cat:'forex',    clr:'#EF4444',featured:true},
  {sym:'BTCUSD',label:'비트코인/달러',tv:'INDEX:BTCUSD',cat:'forex',   clr:'#F7931A'},
];

// Deduplicate and merge all into TV_FEATURED
function dedup<T extends {tv:string}>(arr:T[]): T[] {
  const seen = new Set<string>();
  return arr.filter(x => { if(seen.has(x.tv)) return false; seen.add(x.tv); return true; });
}

const TV_FEATURED: TVAsset[] = dedup([
  ...TV_CRYPTO, ...TV_STOCKS_US, ...TV_ETFS, ...TV_INDICES, ...TV_KRSTOCKS, ...TV_MACRO,
]);


const TV_CAT_COLOR: Record<string,string> = {
  crypto:'#F7931A',stock:'#3B82F6',krstock:'#EF4444',
  etf:'#10B981',index:'#8B5CF6',commodity:'#D97706',forex:'#0891B2',
};

/* ── Inline TradingView Widget ── */


export default HedgeOSPage;