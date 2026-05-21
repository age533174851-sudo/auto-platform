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


function HomePage({onNav,prices,currency,lang}:{onNav:(t:string)=>void;prices:Asset[];currency:string;lang:string}) {
  const top5=useMemo(()=>[...prices].sort((a,b)=>b.c-a.c).slice(0,5),[prices]);
  const [autoAll,setAutoAll]=useState(true);

  const LONG_VALUE  = 48500000;
  const SHORT_VALUE = 1230000;
  const CASH_VALUE  = 5000000;
  const TOTAL = LONG_VALUE + SHORT_VALUE + CASH_VALUE;
  const TOTAL_PNL   = 2870000;

  return (
    <div>
      {/* Risk warning */}
      <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:12,padding:'9px 13px',marginBottom:12,display:'flex',gap:8,alignItems:'flex-start'}}>
        <span style={{flexShrink:0}}>⚠️</span>
        <span style={{color:T.ylw,fontSize:11,fontWeight:600,lineHeight:1.5}}>{tr(lang,'warning')}</span>
      </div>

      {/* Total asset banner */}
      <div style={{background:'linear-gradient(145deg,#0D1A35,#091228)',border:`1px solid ${T.border2}`,borderRadius:22,padding:'22px 20px',marginBottom:14,position:'relative',overflow:'hidden'}}>
        <div style={{position:'absolute',right:-40,top:-40,width:200,height:200,background:`radial-gradient(circle,${T.acg} 0%,transparent 70%)`,pointerEvents:'none'}}/>
        <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:4}}><Dot/><span style={{color:T.muted,fontSize:11,fontWeight:600}}>헤지펀드 포트폴리오 · 🎮 {tr(lang,'mock')}</span></div>
        <div style={{color:T.muted,fontSize:12,marginBottom:2}}>총 평가 자산</div>
        <div style={{color:T.txt,fontSize:30,fontWeight:900,fontFamily:'monospace',letterSpacing:-1.5}}>{cvt(TOTAL,currency)}</div>
        <div style={{display:'flex',alignItems:'center',gap:10,marginTop:6}}>
          <span style={{color:T.grn,fontWeight:700,fontSize:13}}>▲ +{cvt(TOTAL_PNL,currency)}</span>
          <Bdg c={T.grn} ch={"+"+fmtPct(TOTAL_PNL/TOTAL*100)+" 총수익"}/>
        </div>
        <div style={{display:'flex',gap:8,marginTop:16,flexWrap:'wrap'}}>
          <button onClick={()=>onNav('portfolio')} style={{background:T.acc,color:'#fff',border:'none',borderRadius:12,padding:'11px 18px',fontWeight:800,fontSize:13,cursor:'pointer'}}>📊 포트폴리오</button>
          <button onClick={()=>onNav('trading')} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:12,padding:'11px 18px',fontWeight:700,fontSize:13,cursor:'pointer'}}>⚡ 매매하기</button>
        </div>
      </div>

      {/* Dual portfolio cards */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
        <Card style={{padding:'14px 16px',cursor:'pointer'}} glow={false}>
          <div onClick={()=>onNav('portfolio')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:6}}>
              <span style={{fontSize:14}}>📈</span>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>장투 포트폴리오</span>
            </div>
            <div style={{color:T.txt,fontSize:15,fontWeight:900,fontFamily:'monospace'}}>{cvt(LONG_VALUE,currency)}</div>
            <div style={{color:T.grn,fontSize:11,fontWeight:700,marginTop:2}}>+{cvt(1820000,currency)}</div>
            <div style={{marginTop:8,height:4,background:'#1A2D4A',borderRadius:2}}><div style={{height:'100%',width:'60%',background:T.acl,borderRadius:2}}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 60% · 레버 없음</div>
          </div>
        </Card>
        <Card style={{padding:'14px 16px',cursor:'pointer'}}>
          <div onClick={()=>onNav('portfolio')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:6}}>
              <span style={{fontSize:14}}>⚡</span>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>단타 포트폴리오</span>
            </div>
            <div style={{color:T.txt,fontSize:15,fontWeight:900,fontFamily:'monospace'}}>{cvt(SHORT_VALUE,currency)}</div>
            <div style={{color:T.grn,fontSize:11,fontWeight:700,marginTop:2}}>+{cvt(87000,currency)}</div>
            <div style={{marginTop:8,height:4,background:'#1A2D4A',borderRadius:2}}><div style={{height:'100%',width:'30%',background:T.ylw,borderRadius:2}}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 30% · 최대 10배</div>
          </div>
        </Card>
      </div>

      {/* Status cards */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
        {[
          {icon:'🔄',l:'DCA 적립',v:'주 3회 실행',sub:'다음 매수 내일',c:T.acl},
          {icon:'📊',l:'오늘 단타',v:'+₩87,000',sub:'승률 67% (2/3)',c:T.grn},
        ].map(x=>(
          <Card key={x.l} style={{padding:'14px 16px'}}>
            <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:6}}><span style={{fontSize:14}}>{x.icon}</span><div style={{color:T.muted,fontSize:10,fontWeight:600}}>{x.l}</div></div>
            <div style={{color:x.c,fontSize:14,fontWeight:900,fontFamily:'monospace'}}>{x.v}</div>
            <div style={{color:T.muted,fontSize:10,marginTop:3}}>{x.sub}</div>
          </Card>
        ))}
      </div>

      {/* Auto trading */}
      <Card style={{padding:'14px 18px',marginBottom:12}} glow={autoAll}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:2}}>🤖 자동매매 <Bdg c={autoAll?T.grn:T.muted} ch={autoAll?'실행중':'정지'}/></div>
            <div style={{color:T.muted,fontSize:11}}>{autoAll?'EMA 추세 + DCA 실행 중':'정지됨'}</div>
          </div>
          <Toggle on={autoAll} onChange={setAutoAll}/>
        </div>
      </Card>

      {/* Risk status */}
      <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.grn}20`}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:10}}>🛡️ 리스크 현황</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
          {[{l:'전체 리스크',v:'낮음',c:T.grn},{l:'장투 건전성',v:'우수',c:T.grn},{l:'단타 손실',v:'0%',c:T.grn}].map(r=>(
            <div key={r.l} style={{textAlign:'center'}}>
              <div style={{color:T.muted,fontSize:9,marginBottom:3}}>{r.l}</div>
              <Bdg c={r.c} ch={r.v}/>
            </div>
          ))}
        </div>
      </Card>

      {/* Top movers */}
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:10}}>🚀 상위 상승 종목</div>
        {top5.map((a,i)=>(
          <div key={a.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'7px 0',borderBottom:i<4?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <Logo id={a.id} size={30} clr={a.clr}/>
              <div><div style={{color:T.txt,fontWeight:600,fontSize:12}}>{a.nameKr}</div><div style={{color:T.muted,fontSize:10}}>{a.sym}</div></div>
            </div>
            <div style={{textAlign:'right'}}>
              <div style={{color:T.txt,fontWeight:700,fontSize:11,fontFamily:'monospace'}}>{cvt(a.p,currency)}</div>
              <div style={{color:a.c>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{fmtPct(a.c)}</div>
            </div>
          </div>
        ))}
      </Card>

      {/* News */}
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:10}}>📰 최신 뉴스</div>
        {MOCK_NEWS.slice(0,3).map((n,i)=>(
          <div key={n.id} style={{padding:'8px 0',borderBottom:i<2?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
              <Bdg c={n.sentiment==='bullish'?T.grn:T.red} ch={n.category}/>
              <span style={{color:T.muted,fontSize:10}}>{n.time}</span>
            </div>
            <div style={{color:T.txt,fontSize:12,fontWeight:600,lineHeight:1.4}}>{n.title}</div>
          </div>
        ))}
      </Card>

      {/* Quick access to new features */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        {[
          {tab:'calendar',icon:'📅',l:'경제 캘린더',d:'오늘 FOMC·CPI 확인',c:T.red},
          {tab:'briefing',icon:'🤖',l:'AI 브리핑',d:'오늘의 시장 요약',c:T.prp},
          {tab:'tax',icon:'💼',l:'손익 추적',d:'2025년 실현손익',c:T.ylw},
          {tab:'growth',icon:'🏆',l:'성장 현황',d:'배지·XP·친구초대',c:T.grn},
        ].map(x=>(
          <button key={x.tab} onClick={()=>onNav(x.tab)} style={{background:T.card,border:`1px solid ${x.c}20`,borderRadius:14,padding:'12px 12px',textAlign:'left',cursor:'pointer'}}>
            <div style={{fontSize:18,marginBottom:5}}>{x.icon}</div>
            <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{x.l}</div>
            <div style={{color:T.muted,fontSize:10,marginTop:2}}>{x.d}</div>
          </button>
        ))}
      </div>
    </div>
  );
}


export default HomePage;
