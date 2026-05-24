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


function TaxPage({currency}:{currency:string}) {
  const [year, setYear]  = useState(() => {
    if (typeof window === 'undefined') return '2025';
    try { return localStorage.getItem('tg_tax_year') || '2025'; } catch { return '2025'; }
  });
  const [tab, setTab]    = useState<'summary'|'history'|'export'>('summary');
  const [loading, setLoading] = useState(false);

  // Persist year selection
  const selectYear = (y: string) => {
    setLoading(true);
    setYear(y);
    try { localStorage.setItem('tg_tax_year', y); } catch {}
    setTimeout(() => setLoading(false), 300);
  };

  // Load journal entries (real data)
  const journalEntries: any[] = (() => {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem('tg_journal_v1') || '[]'); } catch { return []; }
  })();

  // Filter by selected year
  const yearEntries = journalEntries.filter(e => {
    const d = e.date || e.createdAt || '';
    return d.startsWith(year);
  });

  // Year-specific mock data (different per year to show filtering works)
  const YEAR_DATA: Record<string, any> = {
    '2023': {realized:1240000,unrealized:480000,fee:58000,net:1182000,taxRate:22,trades:18,winTrades:11,lossTrades:7,
      monthly:[{m:'1월',pnl:0,trades:0},{m:'2월',pnl:0,trades:0},{m:'3월',pnl:120000,trades:3},{m:'4월',pnl:-30000,trades:2},{m:'5월',pnl:80000,trades:3},{m:'6월',pnl:220000,trades:4},{m:'7월',pnl:180000,trades:2},{m:'8월',pnl:-40000,trades:1},{m:'9월',pnl:310000,trades:2},{m:'10월',pnl:0,trades:0},{m:'11월',pnl:200000,trades:1},{m:'12월',pnl:200000,trades:0}],
      history:[{date:'2023-09-12',asset:'BTC/USDT',side:'buy',amount:800000,pnl:240000,fee:400,type:'현물'},{date:'2023-06-28',asset:'ETH/USDT',side:'sell',amount:500000,pnl:130000,fee:250,type:'현물'},{date:'2023-04-15',asset:'AAPL',side:'buy',amount:300000,pnl:-30000,fee:150,type:'주식CFD'}]},
    '2024': {realized:5480000,unrealized:2100000,fee:218000,net:5262000,taxRate:22,trades:34,winTrades:22,lossTrades:12,
      monthly:[{m:'1월',pnl:680000,trades:4},{m:'2월',pnl:320000,trades:3},{m:'3월',pnl:-180000,trades:5},{m:'4월',pnl:540000,trades:4},{m:'5월',pnl:1100000,trades:6},{m:'6월',pnl:820000,trades:4},{m:'7월',pnl:-200000,trades:3},{m:'8월',pnl:940000,trades:2},{m:'9월',pnl:1180000,trades:3},{m:'10월',pnl:280000,trades:0},{m:'11월',pnl:0,trades:0},{m:'12월',pnl:0,trades:0}],
      history:[{date:'2024-09-05',asset:'NVDA',side:'sell',amount:800000,pnl:420000,fee:400,type:'주식CFD'},{date:'2024-07-22',asset:'BTC/USDT',side:'buy',amount:2000000,pnl:-180000,fee:1000,type:'선물'},{date:'2024-05-14',asset:'ETH/USDT',side:'sell',amount:600000,pnl:240000,fee:300,type:'현물'},{date:'2024-03-01',asset:'SOL/USDT',side:'buy',amount:400000,pnl:-90000,fee:200,type:'현물'},{date:'2024-01-08',asset:'SPY',side:'buy',amount:500000,pnl:200000,fee:250,type:'ETF CFD'}]},
    '2025': {realized:2870000,unrealized:1230000,fee:124000,net:2746000,taxRate:22,trades:47,winTrades:32,lossTrades:15,
      monthly:[{m:'1월',pnl:480000,trades:8},{m:'2월',pnl:-120000,trades:6},{m:'3월',pnl:640000,trades:10},{m:'4월',pnl:310000,trades:7},{m:'5월',pnl:1560000,trades:16},{m:'6월',pnl:0,trades:0},{m:'7월',pnl:0,trades:0},{m:'8월',pnl:0,trades:0},{m:'9월',pnl:0,trades:0},{m:'10월',pnl:0,trades:0},{m:'11월',pnl:0,trades:0},{m:'12월',pnl:0,trades:0}],
      history:[{date:'2025-05-10',asset:'BTC/USDT',side:'buy',amount:500000,pnl:87000,fee:250,type:'선물'},{date:'2025-05-08',asset:'NVDA',side:'sell',amount:280000,pnl:54000,fee:140,type:'주식CFD'},{date:'2025-05-05',asset:'ETH/USDT',side:'buy',amount:200000,pnl:-12000,fee:100,type:'선물'},{date:'2025-04-28',asset:'SOL/USDT',side:'sell',amount:150000,pnl:45000,fee:75,type:'현물'},{date:'2025-04-20',asset:'SPY',side:'buy',amount:400000,pnl:32000,fee:200,type:'ETF CFD'}]},
  };

  // Merge real journal entries into year data
  const base = YEAR_DATA[year] || YEAR_DATA['2025'];
  const journalPnl = yearEntries.reduce((s:number, e:any) => s + (Number(e.pnl)||0), 0);
  const YEARLY = {
    ...base,
    realized:  base.realized + journalPnl,
    net:       base.net + journalPnl,
    taxEst:    Math.round((base.net + journalPnl) * base.taxRate / 100),
    trades:    base.trades + yearEntries.length,
    winTrades: base.winTrades + (Array.isArray(yearEntries) ? yearEntries : []).filter((e:any)=>(e.pnl||0)>0).length,
    lossTrades:base.lossTrades + (Array.isArray(yearEntries) ? yearEntries : []).filter((e:any)=>(e.pnl||0)<0).length,
  };

  const MONTHLY = Array.isArray(base?.monthly) ? base.monthly : [];
  const maxPnl  = MONTHLY.length > 0 ? Math.max(1, ...MONTHLY.map(m => Math.abs(m.pnl || 0))) : 1;
  const HISTORY = [
    ...yearEntries.map((e:any,i:number) => ({
      date: e.date||'—', asset: e.sym||'—', side: e.side==='매수'?'buy':'sell',
      amount: Math.abs(e.pnl||0)*10, pnl: e.pnl||0, fee: Math.round(Math.abs(e.pnl||0)*0.001)||0, type: '일지'
    })),
    ...(Array.isArray(base?.history) ? base.history : []),
  ];

  const hasData = base.trades > 0 || yearEntries.length > 0;

  const csvExport = () => {
    const rows = [['날짜','종목','방향','금액','손익','수수료','유형'],...HISTORY.map(h=>[h.date,h.asset,h.side,h.amount,h.pnl,h.fee,h.type])];
    const csv = rows.map(r=>r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href=url; a.download=`TRAIGO_${year}_손익.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{opacity:loading?0.6:1,transition:'opacity .3s'}}>
      {/* Year selector */}
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {['2023','2024','2025'].map(y=>(
          <button key={y} onClick={()=>selectYear(y)} style={{flex:1,padding:'10px',background:year===y?T.acg:'transparent',color:year===y?T.acl:T.muted,border:`2px solid ${year===y?T.acl:T.border}`,borderRadius:10,fontSize:13,fontWeight:700,cursor:'pointer',transition:'all .15s'}}>
            {y}년{year===y&&<span style={{marginLeft:5,fontSize:9,background:T.acl,color:'#fff',borderRadius:99,padding:'1px 5px'}}>선택</span>}
          </button>
        ))}
      </div>

      {/* No data state */}
      {!hasData && (
        <div style={{textAlign:'center',padding:'40px 0',marginBottom:14}}>
          <div style={{fontSize:32,marginBottom:8}}>📭</div>
          <div style={{color:T.muted,fontSize:13,fontWeight:600}}>{year}년 거래 기록이 없습니다.</div>
          <div style={{color:T.muted,fontSize:10,marginTop:4}}>매매일지 탭에서 거래를 기록해보세요.</div>
        </div>
      )}

      {/* Tabs */}
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {([['summary','📊 요약'],['history','📋 거래내역'],['export','📥 내보내기']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:'8px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {tab==='summary'&&(
        <div>
          <div style={{background:'linear-gradient(135deg,#0A1628,#0D1F3C)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
            <div style={{color:T.muted,fontSize:11,marginBottom:2}}>{year}년 순 실현손익 (모의)</div>
            <div style={{color:YEARLY.net>=0?T.grn:T.red,fontSize:28,fontWeight:900,fontFamily:'monospace'}}>{YEARLY.net>=0?'+':''}{cvt(YEARLY.net,currency)}</div>
            <div style={{display:'flex',gap:16,marginTop:8,flexWrap:'wrap'}}>
              {[{l:'실현손익',v:YEARLY.realized,c:T.grn},{l:'수수료',v:-YEARLY.fee,c:T.red},{l:'예상세금',v:-YEARLY.taxEst,c:T.red}].map(r=>(
                <div key={r.l}><div style={{color:T.muted,fontSize:10}}>{r.l}</div><div style={{color:r.c,fontWeight:700,fontSize:12}}>{r.v>=0?'+':''}{cvt(Math.abs(r.v),currency)}</div></div>
              ))}
            </div>
          </div>

          {/* Monthly bars */}
          <Card style={{padding:'14px 16px',marginBottom:14}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📊 {year}년 월별 손익</div>
            <div style={{display:'flex',gap:3,alignItems:'flex-end',height:80}}>
              {MONTHLY.map(m=>{
                const h = maxPnl > 0 ? Math.abs(m.pnl)/maxPnl*70 : 0;
                return (
                  <div key={m.m} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
                    <div style={{height:h||2,background:m.pnl>=0?T.grn:T.red,borderRadius:2,width:'100%',minHeight:m.pnl!==0?2:0,opacity:m.pnl===0?0.2:1}}/>
                    <div style={{color:T.muted,fontSize:7,fontWeight:600}}>{m.m.replace('월','')}</div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Stats */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:14}}>
            {[{l:'총 거래',v:`${YEARLY.trades}건`},{l:'수익',v:`${YEARLY.winTrades}건`},{l:'손실',v:`${YEARLY.lossTrades}건`},{l:'승률',v:YEARLY.trades>0?`${Math.round(YEARLY.winTrades/YEARLY.trades*100)}%`:'—'},{l:'세율',v:`${YEARLY.taxRate}%`},{l:'예상세금',v:cvt(YEARLY.taxEst,currency)}].map(s=>(
              <Card key={s.l} style={{padding:'10px 8px',textAlign:'center'}}>
                <div style={{color:T.muted,fontSize:9,marginBottom:3}}>{s.l}</div>
                <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{s.v}</div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {tab==='history'&&(
        <div>
          {HISTORY.length===0?(
            <div style={{textAlign:'center',padding:'30px 0',color:T.muted,fontSize:12}}>{year}년 거래내역 없음</div>
          ):(
            <Card style={{overflow:'hidden'}}>
              {HISTORY.map((h,i)=>(
                <div key={i} style={{padding:'10px 14px',borderBottom:i<HISTORY.length-1?`1px solid ${T.border}`:'none'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div>
                      <div style={{color:T.txt,fontSize:11,fontWeight:700}}>{h.asset}</div>
                      <div style={{color:T.muted,fontSize:9}}>{h.date} · {h.type}</div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{color:(h.pnl||0)>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{(h.pnl||0)>=0?'+':''}{cvt(Math.abs(h.pnl||0),currency)}</div>
                      <div style={{color:T.muted,fontSize:9}}>수수료 {cvt(h.fee,currency)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

          {tab === 'calculator' && (
            <div>
              <div style={{ background:T.ylw+'10', border:`1px solid ${T.ylw}30`, borderRadius:10, padding:'10px 14px', marginBottom:14, color:T.ylw, fontSize:10, lineHeight:1.6 }}>
                ⚠️ 이 계산기는 앱 내 <b>참고용 계산기</b>입니다. 실제 세무신고용으로 사용하지 마세요. 정확한 세무 상담은 공인세무사에게 문의하세요.
              </div>
              {/* 자산 유형 선택 */}
              <div style={{ display:'flex', gap:6, marginBottom:14 }}>
                {([['coin','가상자산'],['us_stock','해외주식'],['stock','국내주식']] as const).map(([t2,l]) => (
                  <button key={t2} onClick={() => setCalcAssetType(t2)} style={{ flex:1, padding:'8px', background:calcAssetType===t2?T.acg:'transparent', color:calcAssetType===t2?T.acl:T.muted, border:`1px solid ${calcAssetType===t2?T.acl:T.border}`, borderRadius:8, fontSize:10, fontWeight:700, cursor:'pointer', minHeight:36 }}>
                    {l}
                  </button>
                ))}
              </div>
              {/* 입력 필드 */}
              {[
                {label:'매도 단가 (원)', val:calcSellPrice, set:setCalcSellPrice, ph:'예: 95000000'},
                {label:'매수 단가 (원)', val:calcBuyPrice,  set:setCalcBuyPrice,  ph:'예: 50000000'},
                {label:'수량',           val:calcQty,       set:setCalcQty,       ph:'예: 0.5'},
                {label:'수수료율 (%)',   val:calcFeeRate,   set:setCalcFeeRate,   ph:'예: 0.25'},
              ].map(({label,val,set,ph}) => (
                <div key={label} style={{ marginBottom:10 }}>
                  <div style={{ color:T.muted, fontSize:10, marginBottom:4 }}>{label}</div>
                  <input
                    type="number"
                    value={val}
                    onChange={e => set(e.target.value)}
                    placeholder={ph}
                    style={{ width:'100%', background:T.alt, border:`1px solid ${T.border}`, borderRadius:8, color:T.txt, padding:'10px 12px', fontSize:14, outline:'none', boxSizing:'border-box' }}
                  />
                </div>
              ))}
              {/* 결과 */}
              {taxCalcResult && (
                <Card style={{ padding:'14px', marginTop:14 }}>
                  <div style={{ color:T.txt, fontWeight:700, fontSize:12, marginBottom:10 }}>📊 계산 결과</div>
                  {[
                    { l:'매도 금액', v:taxCalcResult.totalSell.toLocaleString()+'원' },
                    { l:'매수 원가', v:taxCalcResult.totalBuy.toLocaleString()+'원' },
                    { l:'총 수수료', v:taxCalcResult.totalFee.toLocaleString()+'원' },
                    { l:'손익',      v:(taxCalcResult.gain>=0?'+':'')+taxCalcResult.gain.toLocaleString()+'원 ('+taxCalcResult.gain_pct.toFixed(2)+'%)', color: taxCalcResult.gain>=0?T.grn:T.red },
                    { l:'기본공제',  v:taxCalcResult.deduction.toLocaleString()+'원' },
                    { l:'과세표준',  v:taxCalcResult.taxBase.toLocaleString()+'원' },
                    { l:'세율',      v:(taxCalcResult.taxRate*100)+'%' },
                    { l:'예상 세금', v:taxCalcResult.estTax.toLocaleString()+'원', color:T.ylw, bold:true },
                  ].map(row => (
                    <div key={row.l} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid ${T.border}` }}>
                      <span style={{ color:T.muted, fontSize:11 }}>{row.l}</span>
                      <span style={{ color:(row as any).color||T.txt, fontSize:11, fontWeight:(row as any).bold?800:600 }}>{row.v}</span>
                    </div>
                  ))}
                  <div style={{ color:T.muted, fontSize:9, marginTop:8, lineHeight:1.5 }}>
                    * 2025년 세법 기준 참고용 계산입니다. 지방세(10%) 미포함.
                  </div>
                </Card>
              )}
            </div>
          )}
      {tab==='export'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📥 내보내기</div>
            <button onClick={csvExport} style={{width:'100%',padding:'12px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:11,fontWeight:700,fontSize:13,cursor:'pointer',marginBottom:8}}>
              📊 {year}년 CSV 다운로드
            </button>
            <div style={{color:T.muted,fontSize:10,textAlign:'center'}}>엑셀에서 열 수 있는 CSV 형식으로 내보냅니다.</div>
          </Card>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'10px 14px'}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11,marginBottom:4}}>⚠️ 세금 안내</div>
            <div style={{color:T.muted,fontSize:10,lineHeight:1.6}}>이 데이터는 모의투자 기록입니다. 실제 세금 신고는 공인 세무사와 상담하세요. 예상 세금 계산은 교육 목적입니다.</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   ONBOARDING / GROWTH PAGE
   ══════════════════════════════════════════════════════════════ */


export default TaxPage;