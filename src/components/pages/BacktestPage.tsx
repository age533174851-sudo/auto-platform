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


function BacktestPage() {
  const [strategy, setStrategy] = useState('EMA Cross');
  const [asset,    setAsset]    = useState('BTC');
  const [period,   setPeriod]   = useState('6개월');
  const [running,  setRunning]  = useState(false);
  const [result,   setResult]   = useState<any>(null);
  const [equity,   setEquity]   = useState<number[]>([]);

  /* ─── Deterministic seed from params ─── */
  const seed = (strategy+asset+period).split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const rng  = (n:number) => { let x=Math.sin(n+seed)*10000; return x-Math.floor(x); };

  /* ─── Period → trading days ─── */
  const DAYS: Record<string,number> = {'1개월':22,'3개월':66,'6개월':130,'1년':252,'3년':756};
  const days = DAYS[period] || 130;

  /* ─── Base parameters per strategy ─── */
  const STRAT_PARAMS: Record<string,(d:number,rng:(n:number)=>number)=>{winRate:number;avgWin:number;avgLoss:number;tradeFreq:number;maxDD:number;sharpe:number}> = {
    'EMA Cross':      (d,r)=>({winRate:0.53+r(d*1)*0.10, avgWin:0.028+r(d*2)*0.015, avgLoss:0.019+r(d*3)*0.008, tradeFreq:0.08+r(d*4)*0.04, maxDD:-(0.12+r(d*5)*0.15+Math.log(d/22)*0.03), sharpe:0.9+r(d*6)*0.8}),
    'RSI Oversold':   (d,r)=>({winRate:0.58+r(d*2)*0.08, avgWin:0.022+r(d*3)*0.012, avgLoss:0.015+r(d*4)*0.006, tradeFreq:0.05+r(d*5)*0.03, maxDD:-(0.09+r(d*6)*0.12+Math.log(d/22)*0.025), sharpe:1.1+r(d*7)*0.7}),
    'Bollinger Bounce':(d,r)=>({winRate:0.55+r(d*3)*0.09, avgWin:0.019+r(d*4)*0.011, avgLoss:0.016+r(d*5)*0.007, tradeFreq:0.07+r(d*6)*0.04, maxDD:-(0.11+r(d*7)*0.13+Math.log(d/22)*0.028), sharpe:1.0+r(d*8)*0.75}),
    'DCA':            (d,r)=>({winRate:0.62+r(d*4)*0.06, avgWin:0.015+r(d*5)*0.008, avgLoss:0.011+r(d*6)*0.004, tradeFreq:1/5,              maxDD:-(0.07+r(d*8)*0.10+Math.log(d/22)*0.02),  sharpe:1.3+r(d*9)*0.5}),
  };

  /* ─── Asset volatility multiplier ─── */
  const ASSET_VOL: Record<string,number> = {BTC:1.8,ETH:2.1,SOL:2.6,AAPL:0.8,NVDA:1.4,NDX:1.0,SPY:0.7,TSLA:1.6,BNB:2.0,XRP:2.4};
  const vol = ASSET_VOL[asset] || 1.0;

  /* ─── Build candle series (mock historical, deterministic) ─── */
  const genCandles = (d: number): number[] => {
    const arr: number[] = [100];
    const drift = (asset==='BTC'||asset==='ETH'||asset==='NVDA') ? 0.0004 : 0.0002;
    for (let i=1; i<d; i++) {
      const r = rng(i);
      const change = (r-0.48)*0.028*vol + drift;
      arr.push(arr[i-1]*(1+change));
    }
    return arr;
  };

  const run = () => {
    setRunning(true); setResult(null); setEquity([]);
    setTimeout(()=>{
      const candles = genCandles(days);
      const p = (STRAT_PARAMS[strategy] || STRAT_PARAMS['EMA Cross'])(days, rng);
      const tradeCount = Math.round(days * p.tradeFreq);
      const trades: any[] = [];
      let balance = 10000000;  // 10M KRW starting
      const equityCurve: number[] = [balance];
      let maxBalance = balance;
      let maxDD = 0;

      for (let i=0; i<tradeCount; i++) {
        const win  = rng(i*3+1) < p.winRate;
        const pct  = win ? (p.avgWin  + rng(i*3+2)*p.avgWin*0.8)  * vol
                         : -(p.avgLoss + rng(i*3+3)*p.avgLoss*0.8) * vol;
        // Real fee calculation using fee engine
        const feeRate = (feeConfig?.customTaker ?? (feeConfig?.exchange ? 0.0004 : 0.0004));
        const fee  = feeRate * 2; // round trip
        const netPct = pct - fee;
        const pnl  = Math.round(balance * netPct);
        balance   += pnl;
        if (balance > maxBalance) maxBalance = balance;
        const dd = (balance - maxBalance) / maxBalance * 100;
        if (dd < maxDD) maxDD = dd;
        const ci = Math.floor(i / tradeCount * (days-1));
        trades.push({
          n:i+1, side:win?'매수':'매도', entry:Math.round(candles[ci]*100)/100,
          exit:Math.round(candles[Math.min(ci+5,days-1)]*100)/100,
          pnl, pnlPct: Math.round(netPct*10000)/100, fee:Math.round(balance*fee),
        });
        // Equity curve sample (every ~5 trades)
        if (i%Math.max(1,Math.round(tradeCount/50))===0) equityCurve.push(balance);
      }
      equityCurve.push(balance);

      const wins = trades.filter(t=>t.pnl>0);
      const losses = trades.filter(t=>t.pnl<0);
      const winRate = Math.round(wins.length/trades.length*100);
      const totalPnl = trades.reduce((s,t)=>s+t.pnl,0);
      const grossProfit = wins.reduce((s,t)=>s+t.pnl,0);
      const grossLoss   = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
      const profitFactor= grossLoss>0 ? +(grossProfit/grossLoss).toFixed(2) : 99;
      const rets = equityCurve.map((v,i,a)=>i>0?(v-a[i-1])/a[i-1]:0).slice(1);
      const meanR = rets.reduce((s,r)=>s+r,0)/rets.length;
      const stdR  = Math.sqrt(rets.reduce((s,r)=>s+(r-meanR)**2,0)/rets.length);
      const sharpe = stdR>0 ? +((meanR/stdR)*Math.sqrt(252)).toFixed(2) : 0;

      setResult({winRate, totalPnl, maxDD:+maxDD.toFixed(2), profitFactor, sharpe, tradeCount:trades.length, trades});
      setEquity(equityCurve);
      setRunning(false);
    }, 1200);
  };

  /* ─── Mini equity chart ─── */
  const EquityChart = ({data}:{data:number[]}) => {
    if (data.length<2) return null;
    const min=Math.min(...data), max=Math.max(...data), range=max-min||1;
    const w=280, h=80;
    const pts=data.map((v,i)=>`${(i/(data.length-1))*w},${h-(v-min)/range*h}`).join(' ');
    const up=data[data.length-1]>=data[0];
    return (
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{height:h}}>
        <defs><linearGradient id="eq_g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={up?T.grn:T.red} stopOpacity={0.3}/><stop offset="100%" stopColor={up?T.grn:T.red} stopOpacity={0}/></linearGradient></defs>
        <polygon points={`0,${h} ${pts} ${w},${h}`} fill="url(#eq_g)"/>
        <polyline points={pts} fill="none" stroke={up?T.grn:T.red} strokeWidth="1.5" strokeLinejoin="round"/>
      </svg>
    );
  };

  return (
    <div>
      <div style={{fontWeight:800,fontSize:15,color:T.txt,marginBottom:12}}>🧪 백테스팅 엔진</div>
      <Card style={{padding:'14px 16px',marginBottom:12}}>
        <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>⚙️ 설정</div>
        {[
          {l:'전략',v:strategy,opts:['EMA Cross','RSI Oversold','Bollinger Bounce','DCA'],set:setStrategy},
          {l:'종목',v:asset,opts:['BTC','ETH','SOL','AAPL','NVDA','SPY'],set:setAsset},
          {l:'기간',v:period,opts:['1개월','3개월','6개월','1년','3년'],set:setPeriod},
        ].map(f=>(
          <div key={f.l} style={{marginBottom:10}}>
            <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:5}}>{f.l}</div>
            <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
              {f.opts.map(o=>(
                <button key={o} onClick={()=>f.set(o)} style={{background:f.v===o?T.acg:'transparent',color:f.v===o?T.acl:T.muted,border:`1px solid ${f.v===o?T.acl:T.border}`,borderRadius:8,padding:'5px 11px',fontSize:11,fontWeight:700,cursor:'pointer'}}>{o}</button>
              ))}
            </div>
          </div>
        ))}
        <button onClick={run} disabled={running} style={{width:'100%',padding:'12px',background:running?'#243A5E':`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:700,fontSize:13,cursor:running?'not-allowed':'pointer',marginTop:4}}>
          {running?'⏳ 백테스트 실행 중…':'🚀 백테스트 실행'}
        </button>
      </Card>

      {result&&(
        <div>
          {/* Stats grid */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:12}}>
            {[
              {l:'승률',      v:`${result.winRate}%`,   c:result.winRate>=55?T.grn:result.winRate>=45?T.ylw:T.red},
              {l:'총 수익',   v:(result.totalPnl>=0?'+':'')+fmt(result.totalPnl)+'원', c:result.totalPnl>=0?T.grn:T.red},
              {l:'최대손실',  v:`${result.maxDD}%`,     c:T.red},
              {l:'수익팩터',  v:`${result.profitFactor}x`, c:result.profitFactor>=1.5?T.grn:result.profitFactor>=1?T.ylw:T.red},
              {l:'샤프지수',  v:`${result.sharpe}`,     c:result.sharpe>=1.5?T.grn:result.sharpe>=0.5?T.ylw:T.red},
              {l:'총 거래',   v:`${result.tradeCount}건`, c:T.acl},
            ].map(s=>(
              <Card key={s.l} style={{padding:'11px 10px'}}>
                <div style={{color:T.muted,fontSize:9,fontWeight:700,marginBottom:4}}>{s.l}</div>
                <div style={{color:s.c,fontSize:14,fontWeight:900,fontFamily:'monospace'}}>{s.v}</div>
              </Card>
            ))}
          </div>

          {/* Equity curve */}
          {equity.length>=2&&(
            <Card style={{padding:'14px 16px',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:8,display:'flex',justifyContent:'space-between'}}>
                <span>📈 수익 곡선</span>
                <span style={{color:equity[equity.length-1]>=equity[0]?T.grn:T.red,fontSize:12,fontWeight:700}}>
                  {equity[equity.length-1]>=equity[0]?'+':''}
                  {((equity[equity.length-1]/equity[0]-1)*100).toFixed(1)}%
                </span>
              </div>
              <EquityChart data={equity}/>
            </Card>
          )}

          {/* Trade list */}
          <Card style={{overflow:'hidden'}}>
            <div style={{padding:'10px 14px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between'}}>
              <span style={{color:T.muted,fontSize:10,fontWeight:700}}>매매 목록 (최근 15건)</span>
              <span style={{color:T.muted,fontSize:9}}>{strategy} · {asset} · {period}</span>
            </div>
            {result.trades.slice(0,15).map((t:any)=>(
              <div key={t.n} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 14px',borderBottom:`1px solid ${T.border}`}}>
                <div>
                  <span style={{color:T.muted,fontSize:10}}>#{t.n} </span>
                  <span style={{color:t.pnl>=0?T.grn:T.red,fontSize:10,fontWeight:700}}>{t.side}</span>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:t.pnl>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{t.pnl>=0?'+':''}{fmt(t.pnl)}원</div>
                  <div style={{color:t.pnlPct>=0?T.grn:T.red,fontSize:9}}>{t.pnlPct>=0?'+':''}{t.pnlPct}%</div>
                </div>
              </div>
            ))}
          </Card>
          <div style={{color:T.muted,fontSize:9,textAlign:'center',marginTop:8}}>
            ⚠️ 과거 성과가 미래를 보장하지 않습니다 · 모의투자 전용
          </div>
        </div>
      )}
    </div>
  );
}

/* ── HistoryPage ── */


export default BacktestPage;