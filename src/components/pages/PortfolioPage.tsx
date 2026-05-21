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


function PortfolioPage({prices,currency}:{prices:Asset[];currency:string}) {
  // ── Safety helpers ──────────────────────────────────────
  const safeDiv=(a:number,b:number):number=>(!b||!isFinite(a/b)?0:a/b);
  const safePrices:Asset[]=(prices||[]).filter(x=>x&&x.id);
  const TOTAL = 50000000;
  const [mode,setMode] = useState<'all'|'long'|'short'|'cash'>('all');
  const [alloc,setAlloc] = useState<Allocation>({longPct:60,shortPct:30,cashPct:10});
  const [activePreset,setActivePreset] = useState('균형형');

  /* Mock positions */
  const [longPositions] = useState<LongPos[]>([
    {id:'l1',assetId:'BTC',nameKr:'비트코인',clr:'#F7931A',sym:'BTC/USDT',type:'dca',avgPrice:78400000,qty:0.38,invested:29792000,targetPrice:120000000,stopPrice:60000000,note:'반감기 이후 장기 보유',addedAt:'2024-01-15'},
    {id:'l2',assetId:'ETH',nameKr:'이더리움',clr:'#627EEA',sym:'ETH/USDT',type:'spot',avgPrice:4200000,qty:2.1,invested:8820000,targetPrice:8000000,stopPrice:3000000,note:'ETF 승인 이후 장기',addedAt:'2024-03-01'},
    {id:'l3',assetId:'NVDA',nameKr:'엔비디아',clr:'#76B900',sym:'NVDA',type:'spot',avgPrice:180,qty:15,invested:3888000,targetPrice:300,stopPrice:140,note:'AI 수혜 장기',addedAt:'2024-02-10'},
    {id:'l4',assetId:'SPY',nameKr:'S&P500 ETF',clr:'#6366F1',sym:'SPY',type:'etf',avgPrice:520,qty:8,invested:6048000,targetPrice:700,stopPrice:450,note:'지수 분산투자',addedAt:'2024-06-01'},
    {id:'l5',assetId:'GLD',nameKr:'금',clr:'#D97706',sym:'GOLD',type:'spot',avgPrice:2800,qty:3,invested:1224000,targetPrice:4000,stopPrice:2200,note:'안전자산 헤지',addedAt:'2024-04-01'},
  ]);

  const [dcaPlans] = useState<DCAEntry[]>([
    {id:'d1',assetId:'BTC',nameKr:'비트코인',clr:'#F7931A',sym:'BTC/USDT',amount:300000,freq:'weekly',active:true,avgPrice:78400000,totalInvested:7200000,qty:0.092,targetPrice:150000000,nextBuy:'2025-05-16'},
    {id:'d2',assetId:'ETH',nameKr:'이더리움',clr:'#627EEA',sym:'ETH/USDT',amount:200000,freq:'weekly',active:true,avgPrice:4200000,totalInvested:4800000,qty:1.14,targetPrice:10000000,nextBuy:'2025-05-16'},
    {id:'d3',assetId:'SPY',nameKr:'S&P500 ETF',clr:'#6366F1',sym:'SPY',amount:500000,freq:'monthly',active:true,avgPrice:520,totalInvested:3000000,qty:8.33,targetPrice:700,nextBuy:'2025-06-01'},
  ]);

  const [shortPositions] = useState<ShortPos[]>([
    {id:'s1',assetId:'SOL',nameKr:'솔라나',clr:'#9945FF',sym:'SOL/USDT',side:'long',entryPrice:195000,qty:5,margin:975000,leverage:3,takeProfitPrice:240000,stopLossPrice:180000,pnl:75000,pnlPct:7.69,openedAt:'2025-05-10T09:00:00',strategy:'EMA 추세 추종'},
    {id:'s2',assetId:'BNB',nameKr:'바이낸스',clr:'#F0B90B',sym:'BNB/USDT',side:'long',entryPrice:840000,qty:1,margin:840000,leverage:2,takeProfitPrice:950000,stopLossPrice:800000,pnl:-12000,pnlPct:-1.43,openedAt:'2025-05-11T14:00:00',strategy:'RSI 반등'},
    {id:'s3',assetId:'AMD',nameKr:'AMD',clr:'#ED1C24',sym:'AMD',side:'long',entryPrice:390,qty:5,margin:2808000,leverage:1,takeProfitPrice:450,stopLossPrice:360,pnl:224400,pnlPct:8.0,openedAt:'2025-05-08T10:00:00',strategy:'어닝 모멘텀'},
  ]);

  const longValue = useMemo(()=>(longPositions||[]).reduce((s,p)=>{try{const a=safePrices.find(x=>x.id===p.assetId);return s+(a&&typeof a.p==='number'?a.p*(p.qty||0):(p.invested||0));}catch{return s;}},0),[longPositions,prices]);
  const shortValue = useMemo(()=>(shortPositions||[]).reduce((s,p)=>{try{return s+(typeof p?.margin==='number'?p.margin:0)+(typeof p?.pnl==='number'?p.pnl:0);}catch{return s;}},0),[shortPositions]);
  const cashValue = TOTAL * alloc.cashPct / 100;
  const totalValue = longValue + shortValue + cashValue;
  const longPnl = useMemo(()=>(longPositions||[]).reduce((s,p)=>{try{const a=safePrices.find(x=>x.id===p.assetId);const cv=a&&typeof a.p==='number'?a.p*(p.qty||0):(p.invested||0);return s+(cv-(p.invested||0));}catch{return s;}},0),[longPositions,prices]);
  const shortPnl = useMemo(()=>(shortPositions||[]).reduce((s,p)=>{try{return s+(typeof p?.pnl==='number'?p.pnl:0);}catch{return s;}},0),[shortPositions]);
  const totalPnl = longPnl + shortPnl;

  const PRESETS:{name:string;l:number;s:number;c:number}[] = [
    {name:'안정형',l:80,s:10,c:10},
    {name:'균형형',l:60,s:30,c:10},
    {name:'공격형',l:40,s:50,c:10},
    {name:'자동매매형',l:30,s:60,c:10},
  ];

  const applyPreset=(p:{name:string;l:number;s:number;c:number})=>{
    setAlloc({longPct:p.l,shortPct:p.s,cashPct:p.c});
    setActivePreset(p.name);
  };

  const donutSlices=[
    {pct:alloc.longPct,color:'#3B82F6',label:'장투'},
    {pct:alloc.shortPct,color:'#F59E0B',label:'단타'},
    {pct:alloc.cashPct,color:'#10B981',label:'현금'},
  ];

  /* ── ALL view ── */
  if(mode==='all') return (
    <div>
      {/* Header banner */}
      <div style={{background:'linear-gradient(135deg,#0D1A35,#091228)',border:`1px solid ${T.border2}`,borderRadius:22,padding:'20px 18px',marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}><Dot c={T.grn}/><span style={{color:T.muted,fontSize:11,fontWeight:600}}>헤지펀드 스타일 포트폴리오 · 🎮 모의</span></div>
        <div style={{color:T.muted,fontSize:12,marginBottom:2}}>총 평가 자산</div>
        <div style={{color:T.txt,fontSize:32,fontWeight:900,fontFamily:'monospace',letterSpacing:-2}}>{cvt(totalValue,currency)}</div>
        <div style={{display:'flex',alignItems:'center',gap:10,marginTop:6}}>
          <span style={{color:totalPnl>=0?T.grn:T.red,fontWeight:700,fontSize:13}}>{totalPnl>=0?'▲':'▼'} {cvt(Math.abs(totalPnl),currency)}</span>
          <Bdg c={totalPnl>=0?T.grn:T.red} ch={fmtPct(TOTAL>0?totalPnl/TOTAL*100:0)}/>
        </div>
      </div>

      {/* Mode switcher */}
      <div style={{display:'flex',gap:6,marginBottom:14,overflowX:'auto'}}>
        {([['all','전체','📊'],['long','장투','📈'],['short','단타','⚡'],['cash','현금','💵']] as const).map(([id,label,icon])=>(
          <button key={id} onClick={()=>setMode(id)} style={{flexShrink:0,padding:'7px 14px',background:mode===id?T.acg:'transparent',color:mode===id?T.acl:T.muted,border:`1px solid ${mode===id?T.acl:T.border}`,borderRadius:20,fontWeight:700,fontSize:12,cursor:'pointer'}}>
            {icon} {label}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}}>
        <Card style={{padding:'14px 16px',cursor:'pointer'}} glow={false}>
          <div onClick={()=>setMode('long')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}><span style={{fontSize:16}}>📈</span><div style={{color:T.muted,fontSize:10,fontWeight:700}}>장투 포트폴리오</div></div>
            <div style={{color:T.txt,fontSize:16,fontWeight:900,fontFamily:'monospace'}}>{cvt(longValue,currency)}</div>
            <div style={{color:longPnl>=0?T.grn:T.red,fontSize:11,fontWeight:700,marginTop:3}}>{longPnl>=0?'+':''}{cvt(Math.abs(longPnl),currency)}</div>
            <div style={{marginTop:8}}><MiniBar pct={alloc.longPct} color={T.acl}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 {alloc.longPct}% · 레버리지 없음</div>
          </div>
        </Card>
        <Card style={{padding:'14px 16px',cursor:'pointer'}}>
          <div onClick={()=>setMode('short')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}><span style={{fontSize:16}}>⚡</span><div style={{color:T.muted,fontSize:10,fontWeight:700}}>단타 포트폴리오</div></div>
            <div style={{color:T.txt,fontSize:16,fontWeight:900,fontFamily:'monospace'}}>{cvt(shortValue,currency)}</div>
            <div style={{color:shortPnl>=0?T.grn:T.red,fontSize:11,fontWeight:700,marginTop:3}}>{shortPnl>=0?'+':''}{cvt(Math.abs(shortPnl),currency)}</div>
            <div style={{marginTop:8}}><MiniBar pct={alloc.shortPct} color={T.ylw}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 {alloc.shortPct}% · 최대 10배</div>
          </div>
        </Card>
        <Card style={{padding:'14px 16px'}}>
          <div onClick={()=>setMode('cash')} style={{cursor:'pointer'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}><span style={{fontSize:16}}>💵</span><div style={{color:T.muted,fontSize:10,fontWeight:700}}>대기 현금</div></div>
            <div style={{color:T.txt,fontSize:16,fontWeight:900,fontFamily:'monospace'}}>{cvt(cashValue,currency)}</div>
            <div style={{color:T.grn,fontSize:11,fontWeight:700,marginTop:3}}>기회 대기 중</div>
            <div style={{marginTop:8}}><MiniBar pct={alloc.cashPct} color={T.grn}/></div>
            <div style={{color:T.muted,fontSize:9,marginTop:3}}>배분 {alloc.cashPct}%</div>
          </div>
        </Card>
        <Card style={{padding:'14px 16px'}}>
          <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>📊 자산 배분</div>
          <div style={{display:'flex',justifyContent:'center',marginBottom:6}}>
            <DonutChart slices={donutSlices}/>
          </div>
          <div style={{display:'flex',gap:8,justifyContent:'center'}}>
            {donutSlices.map(s=><div key={s.label} style={{display:'flex',alignItems:'center',gap:3}}><div style={{width:7,height:7,borderRadius:'50%',background:s.color}}/><span style={{color:T.muted,fontSize:9}}>{s.label} {s.pct}%</span></div>)}
          </div>
        </Card>
      </div>

      {/* Allocation presets */}
      <Card style={{padding:'14px 16px',marginBottom:14}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>⚙️ 배분 프리셋</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8,marginBottom:14}}>
          {PRESETS.map(p=>(
            <button key={p.name} onClick={()=>applyPreset(p)} style={{background:activePreset===p.name?T.acg:T.alt,border:`1px solid ${activePreset===p.name?T.acl:T.border}`,borderRadius:12,padding:'10px 12px',cursor:'pointer',textAlign:'left'}}>
              <div style={{color:activePreset===p.name?T.acl:T.txt,fontWeight:700,fontSize:12,marginBottom:3}}>{p.name}</div>
              <div style={{color:T.muted,fontSize:10}}>장투 {p.l}% · 단타 {p.s}% · 현금 {p.c}%</div>
            </button>
          ))}
        </div>
        <div style={{color:T.muted,fontSize:11,marginBottom:6}}>직접 조정</div>
        {([['longPct','📈 장투',T.acl],['shortPct','⚡ 단타',T.ylw],['cashPct','💵 현금',T.grn]] as const).map(([key,label,color])=>(
          <div key={key} style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
              <span style={{color:T.sub,fontSize:11}}>{label}</span>
              <span style={{color,fontWeight:800,fontSize:11,fontFamily:'monospace'}}>{alloc[key as keyof Allocation]}%</span>
            </div>
            <input type="range" min={0} max={100} value={alloc[key as keyof Allocation]} onChange={e=>{
              const v=+e.target.value;
              if(key==='longPct') setAlloc(a=>{const r=100-v;const ratio=a.shortPct/(a.shortPct+a.cashPct||1);return{longPct:v,shortPct:Math.round(r*ratio),cashPct:Math.round(r*(1-ratio))};});
              else if(key==='shortPct') setAlloc(a=>{const r=100-a.longPct;const c=Math.max(0,r-v);return{...a,shortPct:Math.min(v,r),cashPct:c};});
              else setAlloc(a=>{const r=100-a.longPct;const s=Math.max(0,r-v);return{...a,shortPct:s,cashPct:Math.min(v,r)};});
            }} style={{width:'100%',accentColor:color}}/>
          </div>
        ))}
      </Card>

      {/* Beginner guide */}
      <Card style={{padding:'14px 16px',border:`1px solid ${T.prp}30`}}>
        <div style={{color:T.prp,fontWeight:700,fontSize:12,marginBottom:10}}>💡 초보자 가이드</div>
        {[{t:'📈 장투 = 자산 불리기',d:'BTC·ETH·ETF를 오래 보유해 자산을 불립니다. 변동성에 흔들리지 않고 DCA로 꾸준히 매수.'},
          {t:'⚡ 단타 = 현금흐름 만들기',d:'단기 가격 변동을 이용해 수익을 추구합니다. 엄격한 손절과 익절이 필수.'},
          {t:'💵 현금 = 기회 대기',d:'큰 하락이나 좋은 매수 기회를 기다리는 자금. 급락 시 즉시 투입 가능.'},
        ].map(g=>(
          <div key={g.t} style={{marginBottom:10,paddingBottom:10,borderBottom:`1px solid ${T.border}`}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:3}}>{g.t}</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6}}>{g.d}</div>
          </div>
        ))}
        <div style={{color:T.ylw,fontSize:10,fontWeight:600}}>⚠️ 모의투자 전용 · 수익 보장 없음 · 투자 손실은 본인 책임</div>
      </Card>
    </div>
  );

  /* ── LONG-TERM view ── */
  if(mode==='long') return (
    <div>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
        <button onClick={()=>setMode('all')} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,padding:'5px 10px',color:T.muted,fontSize:12,cursor:'pointer'}}>← 전체</button>
        <div style={{color:T.txt,fontWeight:800,fontSize:16}}>📈 장투 포트폴리오</div>
      </div>

      {/* Long-term summary */}
      <div style={{background:'linear-gradient(135deg,#0A1628,#0D1F3C)',border:`1px solid ${T.acl}30`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
        <div style={{color:T.muted,fontSize:11,marginBottom:2}}>장투 총 가치</div>
        <div style={{color:T.txt,fontSize:26,fontWeight:900,fontFamily:'monospace'}}>{cvt(longValue,currency)}</div>
        <div style={{display:'flex',gap:16,marginTop:8}}>
          <div><div style={{color:T.muted,fontSize:10}}>수익</div><div style={{color:longPnl>=0?T.grn:T.red,fontWeight:800,fontSize:13}}>{longPnl>=0?'+':''}{cvt(Math.abs(longPnl),currency)}</div></div>
          <div><div style={{color:T.muted,fontSize:10}}>수익률</div><div style={{color:T.grn,fontWeight:800,fontSize:13}}>+{(safeDiv(longPnl,(longPositions||[]).reduce((s,p)=>s+(p?.invested||0),0))*100).toFixed(2)}%</div></div>
          <div><div style={{color:T.muted,fontSize:10}}>보유 종목</div><div style={{color:T.txt,fontWeight:800,fontSize:13}}>{longPositions.length}개</div></div>
        </div>
      </div>

      {/* Positions */}
      <Card style={{overflow:'hidden',marginBottom:14}}>
        <div style={{padding:'12px 14px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{color:T.txt,fontWeight:700,fontSize:13}}>보유 자산</div>
          <Bdg c={T.acl} ch="레버리지 없음 · 스팟"/>
        </div>
        {(longPositions||[]).map((p,i)=>{
          const a=(prices||[]).find(x=>x.id===p.assetId);
          const curPrice=(a&&typeof a.p==='number')?a.p:(p.avgPrice||0);
          const curValue=curPrice*(p.qty||0);
          const pnl=curValue-p.invested;
          const pnlPct=safeDiv(pnl,p.invested||0)*100;
          const tpPct=Math.min(100,safeDiv(curPrice-p.avgPrice,p.targetPrice-p.avgPrice)*100);
          return (
            <div key={p.id} style={{padding:'14px',borderBottom:i<(longPositions||[]).length-1?`1px solid ${T.border}`:'none'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <Logo id={p.assetId} size={36} clr={p.clr}/>
                  <div>
                    <div style={{display:'flex',gap:5,alignItems:'center'}}><span style={{color:T.txt,fontWeight:700,fontSize:13}}>{p.nameKr}</span><Bdg c={p.type==='dca'?T.prp:p.type==='etf'?T.grn:T.cyn} ch={p.type==='dca'?'DCA':p.type==='etf'?'ETF':'스팟'} sm/></div>
                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>평균단가 {cvt(p.avgPrice,currency)} · {p.qty.toFixed(4)} {p.sym.split('/')[0]}</div>
                  </div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>{cvt(curValue,currency)}</div>
                  <div style={{color:pnl>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{pnl>=0?'+':''}{fmtPct(pnlPct)}</div>
                </div>
              </div>
              {/* Target progress */}
              <div style={{marginBottom:6}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{color:T.muted,fontSize:10}}>목표가 달성도</span>
                  <span style={{color:T.ylw,fontSize:10,fontWeight:700}}>{Math.max(0,tpPct).toFixed(1)}%</span>
                </div>
                <MiniBar pct={Math.max(0,Math.min(100,tpPct))} color={T.ylw}/>
                <div style={{display:'flex',justifyContent:'space-between',marginTop:2}}>
                  <span style={{color:T.muted,fontSize:9}}>현재 {cvt(curPrice,currency)}</span>
                  <span style={{color:T.grn,fontSize:9}}>목표 {cvt(p.targetPrice,currency)}</span>
                </div>
              </div>
              <div style={{color:T.muted,fontSize:10,display:'flex',gap:6,flexWrap:'wrap'}}>
                <span>손절가 {cvt(p.stopPrice,currency)}</span>
                <span>·</span>
                <span style={{color:T.sub}}>{p.note}</span>
              </div>
            </div>
          );
        })}
      </Card>

      {/* DCA Plans */}
      <Card style={{overflow:'hidden',marginBottom:14}}>
        <div style={{padding:'12px 14px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{color:T.txt,fontWeight:700,fontSize:13}}>🔄 DCA 적립 계획</div>
          <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 추가</button>
        </div>
        {(dcaPlans||[]).map((d,i)=>(
          <div key={d.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 14px',borderBottom:i<(dcaPlans||[]).length-1?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <Logo id={d.assetId} size={30} clr={d.clr}/>
              <div>
                <div style={{color:T.txt,fontWeight:600,fontSize:12}}>{d.nameKr}</div>
                <div style={{color:T.muted,fontSize:10}}>
                  {cvt(d.amount,currency)}/{d.freq==='weekly'?'주':d.freq==='monthly'?'월':'일'} · 총 {cvt(d.totalInvested,currency)}
                </div>
                <div style={{color:T.muted,fontSize:9,marginTop:1}}>다음 매수: {d.nextBuy}</div>
              </div>
            </div>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <div style={{textAlign:'right'}}>
                <div style={{color:T.txt,fontSize:11,fontWeight:700}}>{d.qty.toFixed(4)} {d.sym.split('/')[0]}</div>
                <div style={{color:T.muted,fontSize:9}}>평균 {cvt(d.avgPrice,currency)}</div>
              </div>
              <div style={{width:8,height:8,borderRadius:'50%',background:d.active?T.grn:T.muted,animation:d.active?'pulse 1.5s infinite':undefined}}/>
            </div>
          </div>
        ))}
      </Card>

      {/* Long-term risk */}
      <Card style={{padding:'14px 16px',border:`1px solid ${T.grn}30`}}>
        <div style={{color:T.grn,fontWeight:700,fontSize:12,marginBottom:10}}>🛡️ 장투 리스크 설정</div>
        {[
          {l:'최대 단일자산 집중도',v:'40%',status:'정상'},
          {l:'월 최대 매수 한도',v:cvt(3000000,currency),status:'정상'},
          {l:'리밸런싱 주기',v:'3개월',status:'예정 2025-07'},
          {l:'청산 리스크',v:'없음 (레버리지 0)',status:'안전'},
        ].map((r,i)=>(
          <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'7px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
            <span style={{color:T.sub,fontSize:11}}>{r.l}</span>
            <div style={{textAlign:'right'}}><span style={{color:T.txt,fontSize:11,fontWeight:600}}>{r.v}</span><Bdg c={T.grn} ch={r.status} sm/></div>
          </div>
        ))}
      </Card>
    </div>
  );

  /* ── SHORT-TERM view ── */
  if(mode==='short') return (
    <div>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
        <button onClick={()=>setMode('all')} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,padding:'5px 10px',color:T.muted,fontSize:12,cursor:'pointer'}}>← 전체</button>
        <div style={{color:T.txt,fontWeight:800,fontSize:16}}>⚡ 단타 포트폴리오</div>
      </div>

      {/* Short summary */}
      <div style={{background:'linear-gradient(135deg,#1A0A00,#1A1000)',border:`1px solid ${T.ylw}30`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:4}}><Dot c={T.ylw}/><span style={{color:T.muted,fontSize:11}}>단타/스윙 모드 · 🎮 모의</span></div>
        <div style={{color:T.muted,fontSize:11,marginBottom:2}}>단타 총 포지션</div>
        <div style={{color:T.txt,fontSize:26,fontWeight:900,fontFamily:'monospace'}}>{cvt(shortValue,currency)}</div>
        <div style={{display:'flex',gap:16,marginTop:8}}>
          <div><div style={{color:T.muted,fontSize:10}}>미실현 PnL</div><div style={{color:shortPnl>=0?T.grn:T.red,fontWeight:800}}>{shortPnl>=0?'+':''}{cvt(Math.abs(shortPnl),currency)}</div></div>
          <div><div style={{color:T.muted,fontSize:10}}>활성 포지션</div><div style={{color:T.txt,fontWeight:800}}>{shortPositions.length}개</div></div>
          <div><div style={{color:T.muted,fontSize:10}}>오늘 승률</div><div style={{color:T.grn,fontWeight:800}}>67%</div></div>
        </div>
      </div>

      {/* Risk meter */}
      <Card style={{padding:'14px 16px',marginBottom:14,border:`1px solid ${T.red}20`}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>🔴 단타 리스크 현황</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {[
            {l:'일일 최대 손실',v:cvt(500000,currency),used:cvt(shortPnl<0?Math.abs(shortPnl):0,currency),pct:shortPnl<0?Math.abs(shortPnl)/500000*100:0,c:T.red},
            {l:'오픈 포지션',v:'5개 한도',used:`${shortPositions.length}개`,pct:shortPositions.length/5*100,c:T.ylw},
            {l:'최대 레버리지',v:'10배 한도',used:'3배',pct:30,c:T.grn},
            {l:'연속 손실',v:'3회 한도',used:'0회',pct:0,c:T.grn},
          ].map(r=>(
            <div key={r.l} style={{background:T.alt,borderRadius:10,padding:'10px 12px'}}>
              <div style={{color:T.muted,fontSize:10,marginBottom:4}}>{r.l}</div>
              <div style={{color:T.txt,fontSize:11,fontWeight:700,marginBottom:6}}>{r.used} / {r.v}</div>
              <MiniBar pct={r.pct} color={r.pct>70?T.red:r.pct>40?T.ylw:T.grn}/>
            </div>
          ))}
        </div>
        <div style={{marginTop:10,background:'rgba(239,68,68,.08)',border:`1px solid ${T.red}20`,borderRadius:8,padding:'8px 12px'}}>
          <div style={{color:T.red,fontSize:10,fontWeight:700}}>⚠️ 긴급 정지 조건: 일일 손실 500,000원 초과 시 자동 매매 중단</div>
        </div>
      </Card>

      {/* Active positions */}
      <Card style={{overflow:'hidden',marginBottom:14}}>
        <div style={{padding:'12px 14px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{color:T.txt,fontWeight:700,fontSize:13}}>활성 포지션</div>
          <button style={{background:T.ylw+'15',color:T.ylw,border:`1px solid ${T.ylw}30`,borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 신규 진입</button>
        </div>
        {(shortPositions||[]).map((p,i)=>(
          <div key={p.id} style={{padding:'14px',borderBottom:i<(shortPositions||[]).length-1?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <Logo id={p.assetId} size={34} clr={p.clr}/>
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center'}}>
                    <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{p.nameKr}</span>
                    <Bdg c={p.side==='long'?T.grn:T.red} ch={p.side==='long'?'롱':'숏'} sm/>
                    <Bdg c={T.ylw} ch={`${p.leverage}x`} sm/>
                  </div>
                  <div style={{color:T.muted,fontSize:10,marginTop:1}}>{p.strategy} · 진입 {cvt(p.entryPrice,currency)}</div>
                </div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{color:p.pnl>=0?T.grn:T.red,fontWeight:900,fontSize:14,fontFamily:'monospace'}}>{p.pnl>=0?'+':''}{cvt(Math.abs(p.pnl),currency)}</div>
                <div style={{color:p.pnl>=0?T.grn:T.red,fontSize:11}}>{fmtPct(p.pnlPct)}</div>
              </div>
            </div>
            {/* TP/SL bars */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:6}}>
              <div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}><span style={{color:T.muted,fontSize:9}}>익절가</span><span style={{color:T.grn,fontSize:9,fontWeight:700}}>{cvt(p.takeProfitPrice,currency)}</span></div>
                <MiniBar pct={p.pnl>=0?Math.min(100,p.pnlPct/(p.takeProfitPrice/p.entryPrice-1)*100*0.01):0} color={T.grn}/>
              </div>
              <div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}><span style={{color:T.muted,fontSize:9}}>손절가</span><span style={{color:T.red,fontSize:9,fontWeight:700}}>{cvt(p.stopLossPrice,currency)}</span></div>
                <MiniBar pct={5} color={T.red}/>
              </div>
            </div>
            <div style={{display:'flex',gap:6}}>
              <button style={{flex:1,background:T.grn+'15',color:T.grn,border:`1px solid ${T.grn}30`,borderRadius:8,padding:'5px',fontSize:10,fontWeight:700,cursor:'pointer'}}>익절 청산</button>
              <button style={{flex:1,background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:8,padding:'5px',fontSize:10,fontWeight:700,cursor:'pointer'}}>손절 청산</button>
            </div>
          </div>
        ))}
      </Card>

      {/* Strategy status */}
      <Card style={{padding:'14px 16px',marginBottom:14}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>🤖 단타 전략 현황</div>
        {[
          {name:'EMA 추세 추종',active:true,win:'67%',today:'+₩87,000'},
          {name:'RSI 반등 매매',active:true,win:'58%',today:'-₩12,000'},
          {name:'브레이크아웃',active:false,win:'71%',today:'-'},
          {name:'펀딩비 전략',active:false,win:'--',today:'준비중'},
        ].map((s,i)=>(
          <div key={s.name} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <div style={{width:6,height:6,borderRadius:'50%',background:s.active?T.grn:T.muted}}/>
              <span style={{color:T.txt,fontSize:12,fontWeight:600}}>{s.name}</span>
            </div>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <span style={{color:T.muted,fontSize:10}}>승률 {s.win}</span>
              <span style={{color:s.today.startsWith('+')?T.grn:s.today.startsWith('-')?T.red:T.muted,fontSize:11,fontWeight:700}}>{s.today}</span>
            </div>
          </div>
        ))}
      </Card>

      {/* Short-term history */}
      <Card style={{padding:'14px 16px'}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>📋 오늘의 매매 기록</div>
        {[
          {sym:'SOL',side:'매수',pnl:'+₩45,000',pct:'+4.2%',time:'09:32',strat:'EMA'},
          {sym:'BNB',side:'매수',pnl:'-₩12,000',pct:'-1.4%',time:'11:15',strat:'RSI'},
          {sym:'AMD',side:'매수',pnl:'+₩54,000',pct:'+8.0%',time:'14:22',strat:'모멘텀'},
        ].map((h,i)=>(
          <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<2?`1px solid ${T.border}`:'none'}}>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <Logo id={h.sym} size={24} clr='#94A3B8'/>
              <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{h.sym} {h.side}</div><div style={{color:T.muted,fontSize:10}}>{h.time} · {h.strat}</div></div>
            </div>
            <div style={{textAlign:'right'}}><div style={{color:h.pnl.startsWith('+')?T.grn:T.red,fontWeight:700,fontSize:12}}>{h.pnl}</div><div style={{color:h.pct.startsWith('+')?T.grn:T.red,fontSize:10}}>{h.pct}</div></div>
          </div>
        ))}
      </Card>
    </div>
  );

  /* ── CASH view ── */
  return (
    <div>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
        <button onClick={()=>setMode('all')} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,padding:'5px 10px',color:T.muted,fontSize:12,cursor:'pointer'}}>← 전체</button>
        <div style={{color:T.txt,fontWeight:800,fontSize:16}}>💵 대기 현금</div>
      </div>
      <div style={{background:'linear-gradient(135deg,#0A1A0A,#081208)',border:`1px solid ${T.grn}30`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
        <div style={{color:T.muted,fontSize:11,marginBottom:2}}>대기 현금 잔고</div>
        <div style={{color:T.txt,fontSize:28,fontWeight:900,fontFamily:'monospace'}}>{cvt(cashValue,currency)}</div>
        <div style={{color:T.grn,fontSize:12,fontWeight:600,marginTop:6}}>🎯 매수 기회 대기 중</div>
      </div>
      <Card style={{padding:'14px 16px',marginBottom:14}}>
        <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>⚡ 빠른 투입 버튼</div>
        {[
          {l:'장투 포트폴리오에 추가',pct:50,color:T.acl},
          {l:'단타 진입 자금 활용',pct:30,color:T.ylw},
          {l:'급락 매수 기회 대기',pct:20,color:T.grn},
        ].map((b,i)=>(
          <button key={i} style={{width:'100%',display:'flex',justifyContent:'space-between',alignItems:'center',background:T.alt,border:`1px solid ${T.border}`,borderRadius:12,padding:'12px 14px',cursor:'pointer',marginBottom:8}}>
            <span style={{color:T.txt,fontSize:12,fontWeight:600}}>{b.l}</span>
            <div style={{display:'flex',gap:6,alignItems:'center'}}><span style={{color:b.color,fontSize:11,fontWeight:700}}>{b.pct}%</span><span style={{color:b.color,fontSize:14}}>→</span></div>
          </button>
        ))}
      </Card>
      <Card style={{padding:'14px 16px',border:`1px solid ${T.grn}30`}}>
        <div style={{color:T.grn,fontWeight:700,fontSize:12,marginBottom:8}}>💡 현금 보유 전략</div>
        <div style={{color:T.muted,fontSize:11,lineHeight:1.8}}>
          현금은 투자 기회를 기다리는 전략적 자산입니다.<br/>
          • 시장 급락 시 (10-20% 하락) 장투 포트폴리오에 즉시 투입<br/>
          • 단타 좋은 신호 발생 시 빠르게 진입 가능<br/>
          • 총 자산의 10-20% 유지를 권장합니다<br/>
          ⚠️ 모의투자 전용 · 수익 보장 없음
        </div>
      </Card>
    </div>
  );
}
/* ── TradingPage (Pro Terminal) ── */
/* Leverage recommendation engine */

export default PortfolioPage;
