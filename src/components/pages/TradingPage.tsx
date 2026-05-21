'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Dot, Spark, Pill, Bdg, Toggle, AreaChart, WorldClock, Heatmap,
         TradingChart, Logo, getBgColor, resolveLogoUrl, getKrName, cleanName, resolveTVSym,
         DonutChart, MiniBar, GlobalSearch, getLeverageRec,
         LiquidationCalc, PositionSizer, RiskDashboard } from './SharedUI';


function TradingPage({prices,currency}:{prices:Asset[];currency:string}) {
  const [isMock,setIsMock]=useState(true);
  const [sel,setSel]=useState<Asset>(prices[0]||ASSETS[0]);
  const [side,setSide]=useState('매수');
  const [amount,setAmount]=useState('');
  const [leverage,setLeverage]=useState(1);
  const [marginMode,setMarginMode]=useState<'cross'|'isolated'>('isolated');
  const [status,setStatus]=useState<string|null>(null);
  const [search,setSearch]=useState('');
  const [showConfirm,setShowConfirm]=useState(false);
  const [orders,setOrders]=useState<Order[]>([]);
  const [showOrders,setShowOrders]=useState(false);
  const [riskProfile,setRiskProfile]=useState<'conservative'|'balanced'|'aggressive'>('balanced');

    const [tab,setTab]=useState<'trade'|'sizing'|'risk'>('trade');
  const [tp,setTp]=useState('');
  const [sl,setSl]=useState('');
  const [showChart,setShowChart]=useState(true);

  const filtered=useMemo(()=>{
    if(!search)return prices;
    const q=search.toLowerCase();
    return prices.filter(a=>a.nameKr.includes(search)||a.name.toLowerCase().includes(q)||a.id.toLowerCase().includes(q));
  },[prices,search]);

  const qMap:Record<string,string>={'10만':'100000','50만':'500000','100만':'1000000','500만':'5000000','전액':'10000000'};
  const fee=Math.round((+amount||0)*0.0005);
  const slippage=Math.round((+amount||0)*0.0001);
  const fundingFee=Math.round((+amount||0)*leverage*0.0001);
  const levRec=getLeverageRec(sel,riskProfile);

  const mockPositions=[
    {assetId:'SOL',nameKr:'솔라나',entryPrice:195000,qty:5,leverage:3,side:'long'},
    {assetId:'BNB',nameKr:'바이낸스',entryPrice:840000,qty:1,leverage:2,side:'long'},
  ];

  const confirmOrder=()=>{
    setShowConfirm(false);setStatus('loading');
    setTimeout(()=>{
      const newOrder:Order={id:uid(),assetId:sel.id,nameKr:sel.nameKr,sym:sel.sym,
        side:side==='매수'?'buy':'sell',price:sel.p,amount:+amount,leverage,
        fee,slippage,status:'filled',pnl:(Math.random()-0.4)*+amount*0.05,
        pnlPct:(Math.random()-0.4)*5,openedAt:new Date().toISOString(),note:'',emotion:'😊'};
      setOrders(prev=>[newOrder,...prev]);
      setStatus('done');setTimeout(()=>setStatus(null),3000);
    },1200);
  };

  return (
    <div>
      {/* Mock/Live toggle */}
      <div style={{display:'flex',gap:8,marginBottom:12}}>
        {([[true,'🎮 모의매매'],[false,'💰 실전']] as [boolean,string][]).map(([m,l])=>(
          <button key={String(m)} onClick={()=>setIsMock(m)} style={{flex:1,padding:'10px',background:isMock===m?T.acg:'transparent',color:isMock===m?T.acl:T.muted,border:`1px solid ${isMock===m?T.acl:T.border}`,borderRadius:12,fontWeight:700,fontSize:12,cursor:'pointer'}}>{l}</button>
        ))}
      </div>
      {isMock&&<div style={{background:T.prp+'15',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.prp,fontWeight:700,fontSize:11}}>🎮 모의매매 — 실제 돈 사용 안됨 · 수익 보장 없음</div></div>}

      {/* Sub tabs */}
      <div style={{display:'flex',gap:6,marginBottom:12}}>
        {(['trade','sizing','risk'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:'8px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {t==='trade'?'⚡ 매매':t==='sizing'?'🎯 사이징':'🔥 리스크'}
          </button>
        ))}
      </div>

      {tab==='sizing'&&(
        <Card style={{padding:'14px 16px',marginBottom:12}}>
          <PositionSizer balance={50000000} currency={currency}/>
        </Card>
      )}

      {tab==='risk'&&(
        <Card style={{padding:'14px 16px',marginBottom:12}}>
          <RiskDashboard positions={mockPositions} prices={prices}/>
        </Card>
      )}

      {tab==='trade'&&(
        <>
          {/* Asset selector */}
          <Card style={{padding:12,marginBottom:12}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="종목 검색…"
              style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'7px 10px',color:T.txt,fontSize:12,outline:'none',marginBottom:8}}/>
            <div style={{display:'flex',gap:5,flexWrap:'wrap',maxHeight:80,overflowY:'auto'}}>
              {filtered.slice(0,24).map(a=>(
                <button key={a.id} onClick={()=>{setSel(a);setSearch('');}} style={{background:sel.id===a.id?a.clr+'20':'transparent',color:sel.id===a.id?a.clr:T.muted,border:`1px solid ${sel.id===a.id?a.clr:T.border}`,borderRadius:8,padding:'3px 8px',fontSize:11,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',gap:4}}>
                  <Logo id={a.id} size={14} clr={a.clr}/>{a.id}
                </button>
              ))}
            </div>
          </Card>

          {/* Price + Chart */}
          <Card style={{padding:'14px 14px 10px',marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
              <div>
                <div style={{color:T.muted,fontSize:10}}>{sel.nameKr}</div>
                <div style={{color:T.txt,fontSize:22,fontWeight:900,fontFamily:'monospace',letterSpacing:-1}}>{cvt(sel.p,currency)}</div>
                <span style={{color:sel.c>=0?T.grn:T.red,fontWeight:800,fontSize:13}}>{sel.c>=0?'▲':'▼'} {Math.abs(sel.c).toFixed(2)}%</span>
              </div>
              <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:5}}>
                <Logo id={sel.id} size={38} clr={sel.clr}/>
                <button onClick={()=>setShowChart(v=>!v)} style={{background:showChart?T.acg:'transparent',color:showChart?T.acl:T.muted,border:`1px solid ${showChart?T.acl:T.border}`,borderRadius:8,padding:'2px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{showChart?'차트숨기기':'차트보기'}</button>
              </div>
            </div>
            {showChart&&<div style={{marginTop:8}}><TradingChart asset={sel}/></div>}
          </Card>

          {/* AI Leverage Recommendation */}
          <Card style={{padding:'12px 14px',marginBottom:12,border:`1px solid ${levRec.color}30`}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:8}}>🤖 AI 레버리지 추천</div>
            <div style={{display:'flex',gap:8,marginBottom:10}}>
              {(['conservative','balanced','aggressive'] as const).map(p=>(
                <button key={p} onClick={()=>setRiskProfile(p)} style={{flex:1,padding:'6px 4px',background:riskProfile===p?T.acg:'transparent',color:riskProfile===p?T.acl:T.muted,border:`1px solid ${riskProfile===p?T.acl:T.border}`,borderRadius:8,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {p==='conservative'?'보수형':p==='balanced'?'균형형':'공격형'}
                </button>
              ))}
            </div>
            <div style={{background:levRec.color+'12',border:`1px solid ${levRec.color}30`,borderRadius:10,padding:'10px 12px'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <div>
                  <div style={{color:levRec.color,fontWeight:900,fontSize:18,fontFamily:'monospace'}}>{levRec.rec}x 권장</div>
                  <div style={{color:T.muted,fontSize:10,marginTop:1}}>변동성 {Math.abs(sel.c).toFixed(1)}% · {sel.nameKr}</div>
                </div>
                <div style={{textAlign:'center'}}>
                  <div style={{color:levRec.color,fontWeight:800,fontSize:11}}>{levRec.level}</div>
                  <div style={{color:T.muted,fontSize:9}}>안전도 {levRec.score}/100</div>
                </div>
              </div>
              <div style={{display:'flex',gap:6}}>
                {[1,3,5,10,20].map(v=>(
                  <button key={v} onClick={()=>setLeverage(v)} style={{flex:1,padding:'4px',background:v===levRec.rec?levRec.color+'25':'transparent',color:v===levRec.rec?levRec.color:T.muted,border:`1px solid ${v===levRec.rec?levRec.color:T.border}`,borderRadius:6,fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}x</button>
                ))}
              </div>
            </div>
            <div style={{marginTop:8,color:T.muted,fontSize:10,lineHeight:1.6}}>
              💡 {Math.abs(sel.c)>5?`현재 ${sel.nameKr} 변동성이 높습니다. 낮은 레버리지를 권장합니다.`:Math.abs(sel.c)>3?`${sel.nameKr} 보통 변동성. 중간 레버리지가 적합합니다.`:`${sel.nameKr} 안정적 상태. 전략에 맞는 레버리지를 선택하세요.`}
            </div>
          </Card>

          {/* Order form */}
          <Card style={{padding:14,marginBottom:12}}>
            {/* Buy/Sell */}
            <div style={{display:'flex',gap:8,marginBottom:12}}>
              {['매수','매도'].map(s=>(
                <button key={s} onClick={()=>setSide(s)} style={{flex:1,padding:'11px',background:side===s?(s==='매수'?T.grn:T.red):'transparent',color:side===s?'#fff':T.muted,border:`1px solid ${side===s?(s==='매수'?T.grn:T.red):T.border}`,borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>
                  {s==='매수'?'📈 매수 (롱)':'📉 매도 (숏)'}
                </button>
              ))}
            </div>

            {/* Amount */}
            <input type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="매매 금액 (₩)"
              style={{width:'100%',background:T.alt,border:`1px solid ${T.border2}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:16,fontFamily:'monospace',fontWeight:700,outline:'none',marginBottom:8}}/>
            <div style={{display:'flex',gap:5,marginBottom:14}}>
              {['10만','50만','100만','500만','전액'].map(v=>(
                <button key={v} onClick={()=>setAmount(qMap[v])} style={{flex:1,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:'6px 2px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}</button>
              ))}
            </div>

            {/* TP/SL */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
              <div>
                <div style={{color:T.grn,fontSize:10,fontWeight:700,marginBottom:4}}>📈 익절가</div>
                <input type="number" value={tp} onChange={e=>setTp(e.target.value)} placeholder={`${(sel.p*1.1).toFixed(0)}`}
                  style={{width:'100%',background:T.alt,border:`1px solid ${T.grn}30`,borderRadius:8,padding:'8px',color:T.txt,fontSize:12,outline:'none'}}/>
              </div>
              <div>
                <div style={{color:T.red,fontSize:10,fontWeight:700,marginBottom:4}}>📉 손절가</div>
                <input type="number" value={sl} onChange={e=>setSl(e.target.value)} placeholder={`${(sel.p*0.95).toFixed(0)}`}
                  style={{width:'100%',background:T.alt,border:`1px solid ${T.red}30`,borderRadius:8,padding:'8px',color:T.txt,fontSize:12,outline:'none'}}/>
              </div>
            </div>

            {/* Leverage */}
            <div style={{marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <span style={{color:T.muted,fontSize:11}}>레버리지</span>
                  <div style={{display:'flex',gap:4}}>
                    {(['cross','isolated'] as const).map(m=>(
                      <button key={m} onClick={()=>setMarginMode(m)} style={{background:marginMode===m?T.acg:'transparent',color:marginMode===m?T.acl:T.muted,border:`1px solid ${marginMode===m?T.acl:T.border}`,borderRadius:6,padding:'1px 6px',fontSize:9,fontWeight:700,cursor:'pointer'}}>
                        {m==='cross'?'교차':'격리'}
                      </button>
                    ))}
                  </div>
                </div>
                <span style={{color:leverage>10?T.red:leverage>5?T.ylw:T.grn,fontWeight:800,fontSize:13}}>{leverage}x</span>
              </div>
              <input type="range" min={1} max={100} value={leverage} onChange={e=>setLeverage(+e.target.value)}
                style={{width:'100%',accentColor:leverage>10?T.red:leverage>5?T.ylw:T.grn,marginBottom:6}}/>
              <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                {[1,3,5,10,20,50,100].map(v=>(
                  <button key={v} onClick={()=>setLeverage(v)} style={{background:leverage===v?T.acl+'25':'transparent',color:leverage===v?T.acl:T.muted,border:`1px solid ${leverage===v?T.acl:T.border}`,borderRadius:6,padding:'3px 7px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}x</button>
                ))}
              </div>
            </div>

            {/* High leverage warning */}
            {leverage > 20 && (
              <div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:10,padding:'10px 12px',marginBottom:12}}>
                <div style={{color:T.red,fontWeight:700,fontSize:11,marginBottom:3}}>⚠️ 고레버리지 경고</div>
                <div style={{color:T.sub,fontSize:10,lineHeight:1.6}}>
                  {leverage}배 레버리지는 매우 위험합니다. 작은 가격 변동에도 원금의 대부분을 잃을 수 있습니다. 
                  예상 청산가: 진입가 대비 {(100/leverage*0.9).toFixed(1)}% 하락 시.
                </div>
              </div>
            )}

            {/* Liquidation preview */}
            {amount && <div style={{marginBottom:12}}><LiquidationCalc entryPrice={sel.p} leverage={leverage} side={side} currency={currency}/></div>}

            {/* Fee summary */}
            {amount&&(
              <div style={{background:T.alt,borderRadius:10,padding:'10px 12px',marginBottom:12,border:`1px solid ${T.border}`}}>
                {[
                  {l:'주문 금액',v:'₩'+fmt(+amount)},
                  {l:`레버리지 적용 (${leverage}x)`,v:'₩'+fmt(+amount*leverage)},
                  {l:'수수료 (0.05%)',v:'₩'+fmt(fee)},
                  {l:'슬리피지 (0.01%)',v:'₩'+fmt(slippage)},
                  {l:'펀딩비 추정',v:'₩'+fmt(fundingFee)+'/8h'},
                ].map((r,i)=>(
                  <div key={i} style={{display:'flex',justifyContent:'space-between',marginBottom:i<4?3:0}}>
                    <span style={{color:T.muted,fontSize:10}}>{r.l}</span>
                    <span style={{color:T.txt,fontSize:10,fontWeight:700,fontFamily:'monospace'}}>{r.v}</span>
                  </div>
                ))}
              </div>
            )}

            <button onClick={()=>amount&&setShowConfirm(true)} disabled={!amount||status==='loading'}
              style={{width:'100%',padding:'14px',background:status==='done'?T.grn:status==='loading'?'#243A5E':(side==='매수'?T.grn:T.red),color:'#fff',border:'none',borderRadius:12,fontWeight:900,fontSize:14,cursor:'pointer'}}>
              {status==='loading'?'⏳ 처리 중…':status==='done'?'✅ 완료! (모의)':`[모의] ${sel.nameKr} ${side} ${leverage}x`}
            </button>
          </Card>

          {/* Order history */}
          {orders.length>0&&(
            <Card style={{padding:'14px 16px'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div style={{color:T.txt,fontWeight:700,fontSize:13}}>📋 매매 기록 ({orders.length}건)</div>
                <button onClick={()=>setShowOrders(v=>!v)} style={{background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'3px 8px',fontSize:11,cursor:'pointer'}}>{showOrders?'접기':'펼치기'}</button>
              </div>
              {showOrders&&orders.slice(0,5).map((o,i)=>(
                <div key={o.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<Math.min(4,orders.length-1)?`1px solid ${T.border}`:'none'}}>
                  <div>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{o.nameKr} {o.side==='buy'?'매수':'매도'} {o.leverage}x</div>
                    <div style={{color:T.muted,fontSize:10}}>{new Date(o.openedAt).toLocaleString('ko-KR')}</div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div style={{color:o.pnl>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{o.pnl>=0?'+':''}{fmt(o.pnl)}원</div>
                    <div style={{color:T.muted,fontSize:10}}>₩{fmt(o.amount)}</div>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      {/* Confirm modal */}
      {showConfirm&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200,touchAction:'none'}} onClick={()=>setShowConfirm(false)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px calc(40px + env(safe-area-inset-bottom, 0px))',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:T.txt,fontWeight:800,fontSize:16,marginBottom:14}}>⚠️ 주문 확인</div>
            {[{l:'종목',v:sel.nameKr},{l:'방향',v:side},{l:'금액',v:'₩'+fmt(+amount)},{l:'레버리지',v:leverage+'x'},{l:'마진 모드',v:marginMode==='cross'?'교차':'격리'},{l:'수수료',v:'₩'+fmt(fee)},{l:'펀딩비',v:'₩'+fmt(fundingFee)+'/8h'},{l:'청산 거리',v:(100/leverage*0.9).toFixed(1)+'%'}].map((r,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}>
                <span style={{color:T.muted,fontSize:13}}>{r.l}</span>
                <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{r.v}</span>
              </div>
            ))}
            {leverage>10&&<div style={{marginTop:10,background:T.red+'15',border:`1px solid ${T.red}30`,borderRadius:8,padding:'8px 12px',color:T.red,fontSize:11}}>⚠️ 고레버리지 경고: {leverage}배는 원금 손실 위험이 매우 높습니다</div>}
            <div style={{display:'flex',gap:10,marginTop:16}}>
              <button onClick={()=>setShowConfirm(false)} style={{flex:1,padding:'13px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={confirmOrder} style={{flex:2,padding:'13px',background:side==='매수'?T.grn:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>확인 {side}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
/* ── AutoPage (모듈형 자동매매 엔진) ── */

/* ─── Types ─── */
type StratType='ema_cross'|'rsi_reversal'|'macd_trend'|'breakout'|'scalping'|'swing'|'dca'|'buy_dip'|'funding_rate'|'ai_strategy';
type StratStatus='running'|'paused'|'stopped'|'error';
type SignalState='waiting'|'confirmed'|'rejected'|'executed'|'expired';
type ExecMode='paper'|'simulated'|'real';
type OrderStatus='pending'|'processing'|'completed'|'failed'|'canceled';

interface Strategy {
  id:string; name:string; type:StratType; status:StratStatus;
  asset:string; assetNameKr:string; timeframe:string;
  leverage:number; maxLeverage:number; riskLevel:'low'|'medium'|'high';
  tp:number; sl:number; enabled:boolean;
  winRate:number; totalPnl:number; trades:number;
  maxDailyLoss:number; maxPositionSize:number; cooldownMin:number;
  params:Record<string,number|string|boolean>; description:string;
}

interface Signal {
  id:string; stratId:string; stratName:string; asset:string;
  type:'buy'|'sell'; price:number; state:SignalState;
  confidence:number; source:'indicator'|'webhook'|'ai'|'manual';
  createdAt:string; note:string;
}

interface BotRun {
  id:string; stratId:string; stratName:string; asset:string;
  side:'long'|'short'; entryPrice:number; exitPrice?:number;
  qty:number; pnl:number; pnlPct:number; status:OrderStatus;
  execMode:ExecMode; openedAt:string; closedAt?:string;
}

interface RiskEvent {
  id:string; type:'daily_loss'|'drawdown'|'leverage'|'consecutive_loss'|'emergency';
  message:string; severity:'info'|'warning'|'critical'; timestamp:string;
}

/* ─── Strategy definitions ─── */

export default TradingPage;
