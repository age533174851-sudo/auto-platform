'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { placeOrder, toTVSymbol, type OrderRequest } from '@/lib/api/client';
import { paperBuy, getOpenPositions, checkPaperExits, loadPaperBalance } from '@/lib/autotrade/store';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR, simulatePriceUpdate } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Dot, Spark, Pill, Bdg, Toggle, AreaChart, WorldClock, Heatmap,
         TradingChart, Logo, getBgColor, resolveLogoUrl, getKrName, cleanName, resolveTVSym,
         DonutChart, MiniBar, GlobalSearch, getLeverageRec,
         LiquidationCalc, PositionSizer, RiskDashboard, InlineTVChart, ChartContainer } from './SharedUI';


function TradingPage({prices,currency,activeAsset,onOpenPnL}:{prices:Asset[];currency:string;activeAsset?:any;onOpenPnL?:(a:any)=>void}) {
  const [isMock,setIsMock]=useState(true);
  const resolveAsset = (): Asset => {
    if(activeAsset){const {_ts,...clean}=activeAsset;return clean as Asset;}
    try{const s=sessionStorage.getItem('tg_sel_asset');if(s)return JSON.parse(s) as Asset;}catch{}
    return prices[0] || ASSETS[0];
  };
  const [sel,setSel]=useState<Asset>(resolveAsset);
  const [side,setSide]=useState('매수');
  const [amount,setAmount]=useState('');
  const [leverage,setLeverage]=useState(1);
  const [marginMode,setMarginMode]=useState<'cross'|'isolated'>('isolated');
  const [status,setStatus]=useState<string|null>(null);
  const [search,setSearch]=useState('');
  const [showConfirm,setShowConfirm]=useState(false);
  useEffect(()=>{if(activeAsset){const {_ts,...clean}=activeAsset;setSel(clean as Asset);}},[activeAsset]);
  const [orders,setOrders]=useState<Order[]>([]);
  const [showOrders,setShowOrders]=useState(false);
  const [riskProfile,setRiskProfile]=useState<'conservative'|'balanced'|'aggressive'>('balanced');

    const [tab,setTab]=useState<'trade'|'chart'|'ai'|'tech'|'news'|'sizing'|'risk'>('chart');
  const [chartInterval,setChartInterval]=useState('60');
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

  // 실제 보유 포지션 (paper store 기반)
  const [positions, setPositions] = useState<Array<{ asset: string; qty: number; avgPrice: number; slPrice?: number; tpPrice?: number }>>([]);
  const refreshPositions = useCallback(() => {
    try { setPositions(getOpenPositions()); } catch { setPositions([]); }
  }, []);
  useEffect(() => { refreshPositions(); }, [refreshPositions]);

  const confirmOrder = async () => {
    setShowConfirm(false);
    setStatus('loading');
    const orderAmt = amount ? +amount : 100_000;
    try {
      const r = await placeOrder({
        assetId:  sel.id,
        nameKr:   sel.nameKr,
        symbol:   sel.sym || sel.id,
        side:     side === '매수' ? 'buy' : 'sell',
        amount:   orderAmt,
        leverage,
        price:    sel.p || 0,
        mode:     isMock ? 'paper' : 'real',
      });
      const newOrder: Order = {
        id:       r.data?.orderId || uid(),
        assetId:  sel.id, nameKr: sel.nameKr, sym: sel.sym,
        side:     side === '매수' ? 'buy' : 'sell',
        price:    r.data?.filledPrice || sel.p,
        amount:   orderAmt, leverage,
        fee:      r.data?.fee || orderAmt * 0.001,
        slippage: 0,
        status:   r.status === 'error' ? 'failed' : 'filled',
        pnl:      r.data?.pnl || 0,
        pnlPct:   0,
        openedAt: new Date().toISOString(),
        note: '', emotion: '😊',
      };
      setOrders(prev => [newOrder, ...prev]);

      // 실제 포지션 생성 (paper 모드 매수)
      if (isMock && side === '매수' && r.status !== 'error') {
        try {
          const px = r.data?.filledPrice || sel.p || 0;
          paperBuy(sel.id, px, orderAmt, {
            stopLossPct: sl ? Math.abs(((+sl - px) / px) * 100) : undefined,
            takeProfitPct: tp ? Math.abs(((+tp - px) / px) * 100) : undefined,
            stratId: 'manual',
          });
          refreshPositions();
        } catch {}
      }

      setStatus(r.status === 'error' ? 'error' as any : 'done');
    } catch {
      setStatus('error' as any);
    }
    setTimeout(() => setStatus(null), 3000);
  };

  return (
    <div>
      {/* Mock/Live toggle */}
      <div style={{display:'flex',gap:8,marginBottom:12}}>
        {([[true,'모의매매'],[false,'실전']] as [boolean,string][]).map(([m,l])=>(
          <button key={String(m)} onClick={()=>setIsMock(m)} style={{flex:1,padding:'10px',background:isMock===m?T.acg:'transparent',color:isMock===m?T.acl:T.muted,border:`1px solid ${isMock===m?T.acl:T.border}`,borderRadius:12,fontWeight:700,fontSize:12,cursor:'pointer'}}>{l}</button>
        ))}
      </div>
      {isMock&&<div style={{background:T.prp+'15',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'8px 12px',marginBottom:12}}><div style={{color:T.prp,fontWeight:700,fontSize:11}}>모의매매 — 실제 돈 사용 안됨 · 수익 보장 없음</div></div>}

      {/* Sub tabs */}
      <div style={{display:'flex',gap:4,marginBottom:12,overflowX:'auto'}}>
        {(['trade','chart','ai','tech','news','sizing','risk'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{flexShrink:0,padding:'8px 10px',minHeight:38,background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap'}}>
            {t==='trade'?'매매':t==='chart'?'차트':t==='ai'?'AI':t==='tech'?'기술':t==='news'?'뉴스':t==='sizing'?'사이징':'리스크'}
          </button>
        ))}
      </div>

      {tab==='chart'&&(
        <Card style={{padding:0,overflow:'hidden',marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 14px',borderBottom:`1px solid ${T.border}`}}>
            <div>
              <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{sel.nameKr}</span>
              <span style={{color:T.muted,fontSize:10,marginLeft:8}}>{sel.sym||sel.id}</span>
            </div>
            <div style={{display:'flex',gap:4}}>
              {['1','5','15','60','240','D'].map(iv=>(
                <button key={iv} onClick={()=>setChartInterval(iv)}
                  style={{padding:'2px 6px',background:chartInterval===iv?T.acg:'transparent',color:chartInterval===iv?T.acl:T.muted,border:`1px solid ${chartInterval===iv?T.acl:'transparent'}`,borderRadius:5,fontSize:9,fontWeight:700,cursor:'pointer'}}>
                  {iv==='60'?'1H':iv==='240'?'4H':iv==='D'?'1D':iv+'m'}
                </button>
              ))}
            </div>
          </div>
          <ChartContainer
            storageKey="tg_chart_height_trading"
            defaultLevel="normal"
            title={`${sel.sym || sel.id} · ${sel.nameKr || ''}`}>
            <InlineTVChart symbol={toTVSymbol(sel.sym||sel.id)} interval={chartInterval}/>
          </ChartContainer>
          <div style={{padding:'8px 14px',borderTop:`1px solid ${T.border}`,display:'flex',flexDirection:'column',gap:8}}>
            <div style={{display:'flex',gap:8}}>
              <button type="button" onClick={()=>{setSide('매수');setTab('trade');}} style={{flex:1,padding:'10px',background:T.grn,color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer',minHeight:40}}>
                📈 매수
              </button>
              <button type="button" onClick={()=>{setSide('매도');setTab('trade');}} style={{flex:1,padding:'10px',background:T.red,color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer',minHeight:40}}>
                📉 매도
              </button>
            </div>
            <button type="button" onClick={()=>onOpenPnL?.(sel)} disabled={!onOpenPnL} style={{padding:'9px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,fontWeight:700,fontSize:12,cursor:onOpenPnL?'pointer':'not-allowed',minHeight:38,opacity:onOpenPnL?1:0.5}}>
              💹 수익 계산기로 이동
            </button>
          </div>
        </Card>
      )}

      {tab==='sizing'&&(
        <Card style={{padding:'14px 16px',marginBottom:12}}>
          <PositionSizer balance={50000000} currency={currency}/>
        </Card>
      )}

      {tab==='risk'&&(
        <Card style={{padding:'14px 16px',marginBottom:12}}>
          <RiskDashboard positions={positions.map(p=>({assetId:p.asset,nameKr:p.asset,entryPrice:p.avgPrice,qty:p.qty,leverage:1,side:'long'}))} prices={prices}/>
        </Card>
      )}

      {tab==='ai' && <AIAnalysisTab asset={sel} onTradeBuy={() => { setSide('매수'); setTab('trade'); }} onTradeSell={() => { setSide('매도'); setTab('trade'); }} />}
      {tab==='tech' && <TechAnalysisTab asset={sel}/>}
      {tab==='news' && <NewsTab asset={sel}/>}

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
            <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:8}}>AI 레버리지 추천</div>
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
                <button key={s} onClick={()=>setSide(s)} style={{flex:1,padding:'14px 11px',minHeight:44,background:side===s?(s==='매수'?T.grn:T.red):'transparent',color:side===s?'#fff':T.muted,border:`1px solid ${side===s?(s==='매수'?T.grn:T.red):T.border}`,borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>
                  {s==='매수'?'매수 (롱)':'매도 (숏)'}
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
            <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
              <div>
                <div style={{color:T.grn,fontSize:10,fontWeight:700,marginBottom:4}}>익절가</div>
                <input type="number" value={tp} onChange={e=>setTp(e.target.value)} placeholder={`${(sel.p*1.1).toFixed(0)}`}
                  style={{width:'100%',background:T.alt,border:`1px solid ${T.grn}30`,borderRadius:8,padding:'8px',color:T.txt,fontSize:12,outline:'none'}}/>
              </div>
              <div>
                <div style={{color:T.red,fontSize:10,fontWeight:700,marginBottom:4}}>손절가</div>
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

            <button onClick={()=>{if(!amount)setAmount('100000');setShowConfirm(true);}} disabled={status==='loading'}
              style={{width:'100%',padding:'14px',background:status==='done'?T.grn:status==='loading'?'#243A5E':(side==='매수'?T.grn:T.red),color:'#fff',border:'none',borderRadius:12,fontWeight:900,fontSize:14,cursor:'pointer'}}>
              {status==='loading'?'⏳ 처리 중…':status==='done'?'✅ 완료! (모의)':`[모의] ${sel.nameKr} ${side} ${leverage}x`}
            </button>
            <div style={{color:T.muted,fontSize:9,textAlign:'center',marginTop:6}}>금액 미입력 시 기본 10만원 모의주문</div>
          </Card>

          {/* 현재 포지션 (실제 보유) */}
          {positions.length>0&&(
            <Card style={{padding:'14px 16px',marginBottom:12,borderLeft:`3px solid ${T.grn}`}}>
              <div style={{color:T.txt,fontWeight:800,fontSize:13,marginBottom:10}}>현재 포지션 ({positions.length})</div>
              {positions.map((p,i)=>{
                const cur = prices.find(a=>a.id===p.asset)?.p || p.avgPrice;
                const pnl = (cur - p.avgPrice) * p.qty;
                const pnlPct = p.avgPrice>0 ? ((cur-p.avgPrice)/p.avgPrice)*100 : 0;
                return (
                  <div key={i} style={{background:T.alt,borderRadius:10,padding:'11px 13px',marginBottom:i<positions.length-1?8:0}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                      <span style={{background:T.grn+'20',color:T.grn,fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:5}}>{p.asset} LONG</span>
                      <span style={{color:pnl>=0?T.grn:T.red,fontSize:13,fontWeight:900,fontFamily:'monospace'}}>{pnl>=0?'+':''}{fmt(Math.round(pnl))}원 ({fmtPct(pnlPct)})</span>
                    </div>
                    <div style={{display:'flex',gap:12,flexWrap:'wrap',fontSize:9,color:T.muted,fontFamily:'monospace',marginBottom:8}}>
                      <span>진입 ₩{fmt(Math.round(p.avgPrice))}</span>
                      <span>현재 ₩{fmt(Math.round(cur))}</span>
                      <span>수량 {p.qty.toFixed(4)}</span>
                      {p.slPrice&&<span style={{color:T.red}}>SL ₩{fmt(Math.round(p.slPrice))}</span>}
                      {p.tpPrice&&<span style={{color:T.grn}}>TP ₩{fmt(Math.round(p.tpPrice))}</span>}
                    </div>
                    <div style={{display:'flex',gap:6}}>
                      <button onClick={()=>{
                        try {
                          const b = loadPaperBalance();
                          if(b.positions[p.asset]){ b.krw += p.qty*cur; b.totalPnL += pnl; delete b.positions[p.asset]; 
                            try{localStorage.setItem('tg_paper_balance_v1',JSON.stringify(b));}catch{} }
                          refreshPositions();
                        } catch {}
                      }} style={{flex:1,padding:'8px',background:T.red+'18',color:T.red,border:`1px solid ${T.red}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>포지션 종료</button>
                      <button onClick={()=>{setSel(prices.find(a=>a.id===p.asset)||sel);setTab('trade');setSide('매수');}}
                        style={{flex:1,padding:'8px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:7,fontSize:10,fontWeight:700,cursor:'pointer'}}>추가 진입</button>
                    </div>
                  </div>
                );
              })}
            </Card>
          )}

          {/* Order history */}
          {orders.length>0&&(
            <Card style={{padding:'14px 16px'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div style={{color:T.txt,fontWeight:700,fontSize:13}}>매매 기록 ({orders.length}건)</div>
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
              <button onClick={confirmOrder} style={{flex:2,padding:'14px',minHeight:44,background:side==='매수'?T.grn:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer',position:'relative',zIndex:10}}>확인 {side}</button>
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


// ═════════════════════════════════════════════════════════════
// 새 탭 컴포넌트들 (AI / 기술 / 뉴스)
// ═════════════════════════════════════════════════════════════
import { Sparkles, TrendingUp, TrendingDown, Activity, AlertCircle,
         Newspaper, Gauge, ChevronRight } from 'lucide-react';

// ─── 1) AI 분석 탭 ────────────────────────────────────────────
interface AnalysisResp {
  asset: string;
  snapshot: any;
  diagnosis: {
    trend: 'bullish'|'bearish'|'neutral';
    momentum: 'strong'|'moderate'|'weak';
    volatility: 'high'|'medium'|'low';
    signals: string[];
    buySignals: number;
    sellSignals: number;
    score: number;
  };
  aiComment: string;
  aiSource: string;
}

function getAssetMarket(a: any): string {
  const t = a?.t || a?.type || '';
  if (t === 'crypto' || t === 'futures') return 'crypto';
  if (t === 'krstock')                    return 'stock';
  if (t === 'stock' || t === 'etf')       return 'stock';
  return 'crypto';
}

function AIAnalysisTab({ asset, onTradeBuy, onTradeSell }: {
  asset: any; onTradeBuy: () => void; onTradeSell: () => void;
}) {
  const [data, setData] = useState<AnalysisResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/asset-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset:     asset?.sym || asset?.id,
          market:    getAssetMarket(asset),
          timeframe: '1h',
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.message || `status_${r.status}`);
        setLoading(false);
        return;
      }
      const d = await r.json();
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
    } finally {
      setLoading(false);
    }
  }, [asset?.sym, asset?.id]);

  useEffect(() => { load(); }, [load]);

  const trendColor = data?.diagnosis.trend === 'bullish' ? T.grn
                  : data?.diagnosis.trend === 'bearish' ? T.red
                  : T.muted;

  if (loading) {
    return (
      <Card style={{padding:'16px',marginBottom:12}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10}}>
          <Sparkles size={14} strokeWidth={2.2} color={T.muted}/>
          <span style={{color:T.muted,fontSize:13,fontWeight:700}}>AI 분석 중...</span>
        </div>
        {[1,2,3].map(i => (
          <div key={i} style={{background:T.alt,height:i===1?80:60,borderRadius:8,marginBottom:8,opacity:0.5}}/>
        ))}
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card style={{padding:'16px',marginBottom:12}}>
        <div style={{color:T.red,fontSize:12,marginBottom:6}}>분석 실패: {error || '데이터 없음'}</div>
        <button onClick={load} style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 14px',fontSize:11,cursor:'pointer'}}>다시 시도</button>
        <div style={{marginTop:8,color:T.muted,fontSize:10}}>
          현재 분석은 주요 암호화폐만 지원합니다 (Binance USDT 페어)
        </div>
      </Card>
    );
  }

  const d = data.diagnosis;
  return (
    <div style={{marginBottom:12}}>
      {/* AI 코멘트 카드 */}
      <Card style={{padding:'14px 16px',marginBottom:10,borderLeft:`3px solid ${trendColor}`}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
          <Sparkles size={14} strokeWidth={2.2} color={T.prp}/>
          <span style={{color:T.txt,fontWeight:800,fontSize:13}}>AI 종합 분석</span>
          <span style={{marginLeft:'auto',padding:'2px 7px',background:trendColor+'22',color:trendColor,fontSize:9,fontWeight:800,borderRadius:4}}>
            {d.trend === 'bullish' ? '강세' : d.trend === 'bearish' ? '약세' : '중립'} · 모멘텀 {d.momentum === 'strong' ? '강함' : d.momentum === 'moderate' ? '보통' : '약함'}
          </span>
        </div>
        <div style={{color:T.txt,fontSize:12,lineHeight:1.7,marginBottom:8}}>{data.aiComment}</div>
        <div style={{display:'flex',gap:5,fontSize:9,color:T.muted}}>
          <span>소스: {data.aiSource === 'openai' ? 'OpenAI' : '내장 분석'}</span>
          <span>·</span>
          <span>매수 {d.buySignals} / 매도 {d.sellSignals}</span>
          <span>·</span>
          <span>변동성 {d.volatility === 'high' ? '높음' : d.volatility === 'medium' ? '보통' : '낮음'}</span>
        </div>
      </Card>

      {/* 점수 게이지 */}
      <Card style={{padding:'12px 14px',marginBottom:10}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:5}}>
          <span style={{color:T.muted,fontSize:10,fontWeight:700,display:'inline-flex',alignItems:'center',gap:4}}>
            <Gauge size={10} strokeWidth={2.4}/>매수·매도 점수
          </span>
          <span style={{color:trendColor,fontWeight:900,fontSize:14}}>
            {d.score >= 0 ? '+' : ''}{d.score}
          </span>
        </div>
        <div style={{height:8,background:T.alt,borderRadius:4,overflow:'hidden',position:'relative'}}>
          {/* 중앙선 */}
          <div style={{position:'absolute',top:0,bottom:0,left:'50%',width:1,background:T.muted,zIndex:1}}/>
          {/* 막대 */}
          <div style={{
            position:'absolute',
            top:0, bottom:0,
            left: d.score >= 0 ? '50%' : `${50 + d.score/2}%`,
            width: `${Math.abs(d.score) / 2}%`,
            background: trendColor,
            transition: 'width 300ms',
          }}/>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:4,fontSize:9,color:T.muted}}>
          <span>-100 매도</span>
          <span>0 중립</span>
          <span>+100 매수</span>
        </div>
      </Card>

      {/* 시그널 리스트 */}
      <Card style={{padding:'12px 14px',marginBottom:10}}>
        <div style={{color:T.txt,fontWeight:800,fontSize:12,marginBottom:8}}>주요 시그널</div>
        {d.signals.length === 0 ? (
          <div style={{color:T.muted,fontSize:11}}>특별한 시그널이 감지되지 않습니다</div>
        ) : (
          d.signals.map((s, i) => (
            <div key={i} style={{
              display:'flex',alignItems:'flex-start',gap:6,
              padding:'7px 10px',background:T.alt,borderRadius:6,marginBottom:5,
              borderLeft: `2px solid ${
                s.includes('매수') || s.includes('정배열') || s.includes('상승') ? T.grn :
                s.includes('매도') || s.includes('역배열') || s.includes('하락') ? T.red :
                T.acl
              }`,
            }}>
              <span style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{s}</span>
            </div>
          ))
        )}
      </Card>

      {/* 매매 버튼 */}
      <div style={{display:'flex',gap:8}}>
        <button type="button" onClick={onTradeBuy}
          style={{flex:1,padding:'12px',background:T.grn,color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer',minHeight:46,display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
          <TrendingUp size={14} strokeWidth={2.4}/>매수
        </button>
        <button type="button" onClick={onTradeSell}
          style={{flex:1,padding:'12px',background:T.red,color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer',minHeight:46,display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
          <TrendingDown size={14} strokeWidth={2.4}/>매도
        </button>
      </div>
    </div>
  );
}

// ─── 2) 기술 분석 탭 ─────────────────────────────────────────
function TechAnalysisTab({ asset }: { asset: any }) {
  const [data, setData] = useState<AnalysisResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tf, setTf] = useState<'15m'|'1h'|'4h'|'1d'>('1h');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/asset-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset:     asset?.sym || asset?.id,
          market:    getAssetMarket(asset),
          timeframe: tf,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.message || `status_${r.status}`);
        setLoading(false);
        return;
      }
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
    } finally {
      setLoading(false);
    }
  }, [asset?.sym, asset?.id, tf]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <Card style={{padding:'16px',marginBottom:12}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10}}>
          <Activity size={14} strokeWidth={2.2} color={T.muted}/>
          <span style={{color:T.muted,fontSize:13,fontWeight:700}}>지표 계산 중...</span>
        </div>
        <div style={{background:T.alt,height:200,borderRadius:8,opacity:0.5}}/>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card style={{padding:'16px',marginBottom:12}}>
        <div style={{color:T.red,fontSize:12}}>{error}</div>
      </Card>
    );
  }

  const snap = data.snapshot;

  return (
    <div style={{marginBottom:12}}>
      {/* 시간 단위 선택 */}
      <div style={{display:'flex',gap:5,marginBottom:10}}>
        {(['15m','1h','4h','1d'] as const).map(t => (
          <button key={t} onClick={()=>setTf(t)}
            style={{flex:1,padding:'6px',minHeight:34,background:tf===t?T.acg:T.alt,color:tf===t?T.acl:T.muted,border:`1px solid ${tf===t?T.acl:T.border}`,borderRadius:8,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {t}
          </button>
        ))}
      </div>

      {/* RSI */}
      <Card style={{padding:'12px 14px',marginBottom:8}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:6}}>
          <span style={{color:T.muted,fontSize:11,fontWeight:700}}>RSI (14)</span>
          <span style={{color:
            (snap.rsi ?? 50) > 70 ? T.red :
            (snap.rsi ?? 50) < 30 ? T.grn :
            T.txt,
            fontWeight:900,fontSize:16,fontFamily:'monospace'}}>
            {snap.rsi != null ? snap.rsi.toFixed(1) : '—'}
          </span>
        </div>
        <div style={{height:6,background:T.alt,borderRadius:3,overflow:'hidden',position:'relative'}}>
          <div style={{position:'absolute',top:0,bottom:0,left:'30%',width:1,background:T.grn+'80',zIndex:1}}/>
          <div style={{position:'absolute',top:0,bottom:0,left:'70%',width:1,background:T.red+'80',zIndex:1}}/>
          {snap.rsi != null && (
            <div style={{height:'100%',width:`${snap.rsi}%`,background:
              snap.rsi > 70 ? T.red :
              snap.rsi < 30 ? T.grn :
              T.acl,
              transition:'width 300ms'}}/>
          )}
        </div>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:3,fontSize:9,color:T.muted}}>
          <span>0</span><span>30 과매도</span><span>70 과매수</span><span>100</span>
        </div>
      </Card>

      {/* EMA 배열 */}
      <Card style={{padding:'12px 14px',marginBottom:8}}>
        <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:8}}>EMA 배열</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:5,marginBottom:8}}>
          {[
            { name:'EMA20',  val:snap.ema20,  c:'#60A5FA' },
            { name:'EMA60',  val:snap.ema60,  c:'#F59E0B' },
            { name:'EMA120', val:snap.ema120, c:'#A78BFA' },
          ].map(e => (
            <div key={e.name} style={{background:T.alt,padding:'7px 9px',borderRadius:6,borderTop:`2px solid ${e.c}`}}>
              <div style={{color:e.c,fontSize:9,fontWeight:700}}>{e.name}</div>
              <div style={{color:T.txt,fontSize:11,fontFamily:'monospace',fontWeight:700}}>
                {e.val != null ? e.val.toFixed(2) : '—'}
              </div>
            </div>
          ))}
        </div>
        {snap.ema20 != null && snap.ema60 != null && snap.ema120 != null && (
          <div style={{padding:'7px 10px',background:T.bg,borderRadius:6,fontSize:11,
            color: snap.ema20 > snap.ema60 && snap.ema60 > snap.ema120 ? T.grn :
                   snap.ema20 < snap.ema60 && snap.ema60 < snap.ema120 ? T.red :
                   T.ylw,
            fontWeight:700}}>
            {snap.ema20 > snap.ema60 && snap.ema60 > snap.ema120 ? '✓ 정배열 (강한 상승 추세)' :
             snap.ema20 < snap.ema60 && snap.ema60 < snap.ema120 ? '✗ 역배열 (강한 하락 추세)' :
             '⚠ 혼조 (방향성 불확실)'}
          </div>
        )}
      </Card>

      {/* 가격 / 변동 / 거래량 */}
      <Card style={{padding:'12px 14px',marginBottom:8}}>
        <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:8}}>가격 데이터</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
          <div style={{background:T.alt,padding:'7px 10px',borderRadius:6}}>
            <div style={{color:T.muted,fontSize:9}}>현재가</div>
            <div style={{color:T.txt,fontSize:13,fontFamily:'monospace',fontWeight:800}}>
              {snap.currentPrice != null ? snap.currentPrice.toFixed(snap.currentPrice > 100 ? 2 : 6) : '—'}
            </div>
          </div>
          <div style={{background:T.alt,padding:'7px 10px',borderRadius:6}}>
            <div style={{color:T.muted,fontSize:9}}>최근 1봉 변동</div>
            <div style={{color:(snap.priceChange ?? 0) >= 0 ? T.grn : T.red,fontSize:13,fontFamily:'monospace',fontWeight:800}}>
              {snap.priceChange != null ? `${snap.priceChange >= 0 ? '+' : ''}${snap.priceChange.toFixed(2)}%` : '—'}
            </div>
          </div>
          <div style={{background:T.alt,padding:'7px 10px',borderRadius:6}}>
            <div style={{color:T.muted,fontSize:9}}>현재 거래량</div>
            <div style={{color:T.txt,fontSize:13,fontFamily:'monospace',fontWeight:700}}>
              {snap.volume != null ? snap.volume.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}
            </div>
          </div>
          <div style={{background:T.alt,padding:'7px 10px',borderRadius:6}}>
            <div style={{color:T.muted,fontSize:9}}>평균 대비</div>
            <div style={{color:T.txt,fontSize:13,fontFamily:'monospace',fontWeight:700}}>
              {snap.volume != null && snap.volumeAvg != null ?
                `${(snap.volume / snap.volumeAvg).toFixed(2)}배` : '—'}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── 3) 뉴스 탭 ──────────────────────────────────────────────
function NewsTab({ asset }: { asset: any }) {
  // 자산 관련 뉴스 필터링 (MOCK_NEWS에서)
  const filtered = (MOCK_NEWS || []).filter(n => {
    const sym = (asset?.sym || asset?.id || '').toLowerCase();
    const krName = (asset?.nameKr || '').toLowerCase();
    const title = (n.title || '').toLowerCase();
    const summary = ((n as any).summary || '').toLowerCase();
    return title.includes(sym) || (krName && title.includes(krName)) ||
           summary.includes(sym) || (krName && summary.includes(krName));
  });
  const display = filtered.length > 0 ? filtered : (MOCK_NEWS || []).slice(0, 5);

  return (
    <div style={{marginBottom:12}}>
      <Card style={{padding:'12px 14px',marginBottom:10}}>
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:5}}>
          <Newspaper size={13} strokeWidth={2.2} color={T.acl}/>
          <span style={{color:T.txt,fontWeight:800,fontSize:12}}>
            {filtered.length > 0
              ? `${asset?.nameKr || asset?.sym || asset?.id} 관련 뉴스 ${filtered.length}건`
              : '관련 뉴스를 찾지 못해 전체 뉴스 표시'}
          </span>
        </div>
        <div style={{color:T.muted,fontSize:10}}>
          뉴스 영향 분석은 더보기 → 자동 → 시장 브리핑에서 사용 가능
        </div>
      </Card>

      {display.map(n => (
        <Card key={n.id} style={{padding:'11px 14px',marginBottom:6}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8,marginBottom:4}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:12,lineHeight:1.4,flex:1}}>{n.title}</div>
            {(n as any).sentiment && (
              <span style={{flexShrink:0,padding:'1px 6px',
                background: (n as any).sentiment === 'bullish' ? T.grn+'22' :
                            (n as any).sentiment === 'bearish' ? T.red+'22' :
                            T.ylw+'22',
                color: (n as any).sentiment === 'bullish' ? T.grn :
                       (n as any).sentiment === 'bearish' ? T.red :
                       T.ylw,
                fontSize:9,fontWeight:800,borderRadius:4}}>
                {(n as any).sentiment === 'bullish' ? '강세' :
                 (n as any).sentiment === 'bearish' ? '약세' : '중립'}
              </span>
            )}
          </div>
          <div style={{display:'flex',gap:6,marginTop:3,fontSize:10,color:T.muted}}>
            <span>{n.source}</span>
            <span>·</span>
            <span>{n.time}</span>
          </div>
        </Card>
      ))}
    </div>
  );
}


export default TradingPage;
