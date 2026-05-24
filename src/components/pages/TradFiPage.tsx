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


const PRODUCT_LABEL:Record<ProductType,string> = {
  spot:'현물', futures:'선물', cfd:'CFD', tokenized:'토큰화주식',
  index:'지수', commodity:'원자재', forex:'환율', watchonly:'조회전용',
};
const PRODUCT_COLOR:Record<ProductType,string> = {
  spot:'#10B981', futures:'#F59E0B', cfd:'#7C3AED', tokenized:'#3B82F6',
  index:'#8B5CF6', commodity:'#D97706', forex:'#0891B2', watchonly:'#475569',
};

const TRADFI_PROVIDERS:Record<TradFiProvider,{name:string;icon:string;color:string;url:string}> = {
  gate:     {name:'Gate TradFi',icon:'🔵',color:'#3B82F6',url:'https://www.gate.io/'},
  bybit:    {name:'Bybit MT5',icon:'🟡',color:'#F0B90B',url:'https://www.bybit.com/'},
  binance:  {name:'Binance Futures',icon:'🟡',color:'#F0B90B',url:'https://www.binance.com/'},
  bitget:   {name:'Bitget TradFi',icon:'🔵',color:'#00D4FF',url:'https://www.bitget.com/'},
  etoro:    {name:'eToro-style',icon:'🟢',color:'#10B981',url:'#'},
  watchonly:{name:'조회만',icon:'👁',color:'#475569',url:'#'},
};

const TRADFI_ASSETS:TradFiAsset[] = [
  // ── 주식 CFD ──
  {id:'AAPL_CFD',nameKr:'애플 CFD',name:'Apple CFD',sym:'AAPL',category:'stock_cfd',productType:'cfd',providers:['gate','bybit','bitget'],p:287.51,c:1.17,clr:'#555555',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'TSLA_CFD',nameKr:'테슬라 CFD',name:'Tesla CFD',sym:'TSLA',category:'stock_cfd',productType:'cfd',providers:['gate','bybit','bitget'],p:398.73,c:2.40,clr:'#CC0000',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'NVDA_CFD',nameKr:'엔비디아 CFD',name:'NVIDIA CFD',sym:'NVDA',category:'stock_cfd',productType:'cfd',providers:['gate','bybit','bitget'],p:207.83,c:5.77,clr:'#76B900',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'MSFT_CFD',nameKr:'마이크로소프트 CFD',name:'Microsoft CFD',sym:'MSFT',category:'stock_cfd',productType:'cfd',providers:['gate','bybit'],p:413.96,c:0.63,clr:'#00A4EF',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'AMZN_CFD',nameKr:'아마존 CFD',name:'Amazon CFD',sym:'AMZN',category:'stock_cfd',productType:'cfd',providers:['gate','bybit','bitget'],p:274.99,c:0.53,clr:'#FF9900',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'GOOGL_CFD',nameKr:'구글 CFD',name:'Google CFD',sym:'GOOGL',category:'stock_cfd',productType:'cfd',providers:['gate','bybit'],p:395.14,c:2.33,clr:'#4285F4',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  {id:'META_CFD',nameKr:'메타 CFD',name:'Meta CFD',sym:'META',category:'stock_cfd',productType:'cfd',providers:['gate','bitget'],p:528.60,c:1.43,clr:'#0866FF',overnight:'-0.02%',maxLev:10,isWatchOnly:false},
  // ── 지수 CFD ──
  {id:'NAS100',nameKr:'나스닥100',name:'NAS100',sym:'NAS100',category:'index',productType:'index',providers:['gate','bybit','binance','bitget'],p:21340,c:0.87,clr:'#3B82F6',overnight:'-0.01%',maxLev:20,isWatchOnly:false},
  {id:'SPX500',nameKr:'S&P500',name:'SPX500',sym:'SPX500',category:'index',productType:'index',providers:['gate','bybit','binance','bitget'],p:5820,c:0.47,clr:'#6366F1',overnight:'-0.01%',maxLev:20,isWatchOnly:false},
  {id:'US30',nameKr:'다우존스',name:'US30 Dow Jones',sym:'US30',category:'index',productType:'index',providers:['gate','bybit','bitget'],p:42840,c:0.31,clr:'#8B5CF6',overnight:'-0.01%',maxLev:20,isWatchOnly:false},
  // ── 원자재 CFD ──
  {id:'XAUUSD',nameKr:'금 XAUUSD',name:'Gold XAUUSD',sym:'XAUUSD',category:'commodity',productType:'cfd',providers:['gate','bybit','binance','bitget'],p:3420,c:0.56,clr:'#D97706',overnight:'-0.01%',maxLev:20,isWatchOnly:false},
  {id:'XAGUSD',nameKr:'은 XAGUSD',name:'Silver XAGUSD',sym:'XAGUSD',category:'commodity',productType:'cfd',providers:['gate','bybit','bitget'],p:38.50,c:-1.58,clr:'#94A3B8',overnight:'-0.01%',maxLev:20,isWatchOnly:false},
  {id:'XTIUSD',nameKr:'WTI 원유',name:'WTI XTIUSD',sym:'XTIUSD',category:'commodity',productType:'cfd',providers:['gate','bybit','binance','bitget'],p:78.40,c:-0.90,clr:'#78350F',overnight:'-0.02%',maxLev:20,isWatchOnly:false},
  {id:'XBRUSD',nameKr:'브렌트유',name:'Brent XBRUSD',sym:'XBRUSD',category:'commodity',productType:'cfd',providers:['gate','bybit','bitget'],p:82.40,c:-0.72,clr:'#92400E',overnight:'-0.02%',maxLev:20,isWatchOnly:false},
  // ── 환율 CFD ──
  {id:'EURUSD',nameKr:'유로/달러',name:'EUR/USD',sym:'EURUSD',category:'forex',productType:'forex',providers:['gate','bybit','binance','bitget'],p:1.0892,c:0.18,clr:'#3B82F6',overnight:'-0.005%',maxLev:50,isWatchOnly:false},
  {id:'GBPUSD',nameKr:'파운드/달러',name:'GBP/USD',sym:'GBPUSD',category:'forex',productType:'forex',providers:['gate','bybit','bitget'],p:1.2734,c:-0.12,clr:'#7C3AED',overnight:'-0.005%',maxLev:50,isWatchOnly:false},
  {id:'USDJPY',nameKr:'달러/엔',name:'USD/JPY',sym:'USDJPY',category:'forex',productType:'forex',providers:['gate','bybit','binance','bitget'],p:154.2,c:0.33,clr:'#DC2626',overnight:'-0.005%',maxLev:50,isWatchOnly:false},
  {id:'USDKRW',nameKr:'달러/원',name:'USD/KRW',sym:'USDKRW',category:'forex',productType:'watchonly',providers:['watchonly'],p:1378,c:-0.22,clr:'#10B981',overnight:'N/A',maxLev:1,isWatchOnly:true},
];


function TradFiPage({prices,currency}:{prices:Asset[];currency:string}) {
  const [cat,setCat]=useState<string>('all');
  const [sel,setSel]=useState<TradFiAsset|null>(null);
  const [side,setSide]=useState<'long'|'short'>('long');
  const [amount,setAmount]=useState('');
  const [lev,setLev]=useState(1);
  const [provider,setProvider]=useState<TradFiProvider>('gate');
  const [mode,setMode]=useState<'list'|'trade'>('list');
  const [tab,setTab]=useState<'cfd'|'connect'|'risk'>('cfd');

  const cats=[{id:'all',l:'전체',c:T.txt},{id:'stock_cfd',l:'주식 CFD',c:'#7C3AED'},{id:'index',l:'지수',c:'#3B82F6'},{id:'commodity',l:'원자재',c:'#D97706'},{id:'forex',l:'환율',c:'#0891B2'}];
  const filtered=cat==='all'?TRADFI_ASSETS:TRADFI_ASSETS.filter(a=>a.category===cat);

  const liqPct=(100/lev)*0.9;
  const liqPrice=sel?sel.p*(1+(side==='long'?-liqPct:liqPct)/100):0;
  const fee=Math.round((+amount||0)*0.0005);
  const swapFee=sel?+(+amount*(parseFloat(sel.overnight)/100)).toFixed(0):0;

  const openTrade=(a:TradFiAsset)=>{setSel(a);setProvider(a.providers[0]);setLev(1);setAmount('');setMode('trade');};

  return (
    <div>
      {/* TradFi warning */}
      <div style={{background:'rgba(124,58,237,.12)',border:'1px solid rgba(124,58,237,.4)',borderRadius:12,padding:'10px 14px',marginBottom:14}}>
        <div style={{color:'#7C3AED',fontWeight:800,fontSize:12,marginBottom:4}}>⚠️ TradFi / CFD 상품 안내</div>
        <div style={{color:T.sub,fontSize:10,lineHeight:1.7}}>이 상품은 실제 주식 보유가 아니라 CFD/파생상품일 수 있으며, 레버리지·스왑비·청산 위험이 있습니다. 거래소, 지역, 계정 조건에 따라 이용 불가할 수 있습니다. <strong style={{color:'#7C3AED'}}>모의매매 전용</strong></div>
      </div>

      {/* Sub tabs */}
      <div style={{display:'flex',gap:6,marginBottom:14}}>
        {([['cfd','📊 TradFi 자산'],['connect','🔗 거래소 연동'],['risk','⚠️ 위험 안내']] as const).map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:'8px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{l}</button>
        ))}
      </div>

      {/* CFD Asset List */}
      {tab==='cfd'&&mode==='list'&&(
        <div>
          <div style={{marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:4}}>USDT로 주식·지수·원자재·환율 거래</div>
            <div style={{color:T.muted,fontSize:11}}>코인거래소에서 제공하는 TradFi/CFD 상품</div>
          </div>
          {/* Category filter */}
          <div style={{display:'flex',gap:6,overflowX:'auto',paddingBottom:8,marginBottom:12}}>
            {cats.map(c=>(
              <button key={c.id} onClick={()=>setCat(c.id)} style={{flexShrink:0,padding:'5px 12px',background:cat===c.id?c.c+'20':'transparent',color:cat===c.id?c.c:T.muted,border:`1px solid ${cat===c.id?c.c:T.border}`,borderRadius:20,fontSize:12,fontWeight:700,cursor:'pointer'}}>{c.l}</button>
            ))}
          </div>
          {/* Asset list */}
          <Card style={{overflow:'hidden'}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr auto 80px',padding:'8px 14px',borderBottom:`1px solid ${T.border}`,color:T.muted,fontSize:10,fontWeight:700,textTransform:'uppercase'}}>
              <span>종목</span><span>제공사</span><span style={{textAlign:'right'}}>가격/등락</span>
            </div>
            {filtered.map((a,i)=>(
              <div key={a.id} onClick={()=>openTrade(a)} style={{display:'grid',gridTemplateColumns:'1fr auto 80px',padding:'12px 14px',borderBottom:i<filtered.length-1?`1px solid ${T.border}`:'none',alignItems:'center',cursor:a.isWatchOnly?'default':'pointer'}}>
                {/* Name + type */}
                <div>
                  <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:3}}>
                    <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{a.sym}</span>
                    <Bdg c={PRODUCT_COLOR[a.productType]} ch={PRODUCT_LABEL[a.productType]} sm/>
                    {a.isWatchOnly&&<Bdg c={T.muted} ch="조회만" sm/>}
                  </div>
                  <div style={{color:T.muted,fontSize:10}}>{a.nameKr} · 오버나이트 {a.overnight}</div>
                </div>
                {/* Providers */}
                <div style={{display:'flex',gap:3,marginRight:8}}>
                  {a.providers.slice(0,3).map(p=>(
                    <span key={p} title={TRADFI_PROVIDERS[p].name} style={{fontSize:14}}>{TRADFI_PROVIDERS[p].icon}</span>
                  ))}
                </div>
                {/* Price */}
                <div style={{textAlign:'right'}}>
                  <div style={{color:T.txt,fontWeight:700,fontSize:11,fontFamily:'monospace'}}>{a.p.toLocaleString()}</div>
                  <div style={{color:a.c>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{a.c>=0?'+':''}{a.c.toFixed(2)}%</div>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* Trade panel */}
      {tab==='cfd'&&mode==='trade'&&sel&&(
        <div>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
            <button onClick={()=>setMode('list')} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,padding:'5px 10px',color:T.muted,fontSize:12,cursor:'pointer'}}>← 목록</button>
            <div style={{color:T.txt,fontWeight:800,fontSize:15}}>{sel.nameKr}</div>
            <Bdg c={PRODUCT_COLOR[sel.productType]} ch={PRODUCT_LABEL[sel.productType]}/>
          </div>

          {/* CFD Warning */}
          <div style={{background:T.prp+'15',border:`1px solid ${T.prp}30`,borderRadius:10,padding:'10px 14px',marginBottom:12}}>
            <div style={{color:T.prp,fontWeight:700,fontSize:11}}>⚠️ 이 상품은 CFD입니다. 실제 자산 보유 아님 · 레버리지·스왑비·청산 위험 있음 · 모의매매 전용</div>
          </div>

          {/* Provider selection */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>거래소 선택</div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {(Array.isArray(sel.providers) ? sel.providers : []).map(p=>{
                const pInfo=TRADFI_PROVIDERS[p];
                return (
                  <button key={p} onClick={()=>setProvider(p)} style={{background:provider===p?pInfo.color+'20':T.alt,color:provider===p?pInfo.color:T.muted,border:`2px solid ${provider===p?pInfo.color:T.border}`,borderRadius:10,padding:'8px 12px',cursor:'pointer',display:'flex',alignItems:'center',gap:5}}>
                    <span>{pInfo.icon}</span><span style={{fontSize:11,fontWeight:700}}>{pInfo.name}</span>
                  </button>
                );
              })}
            </div>
            <div style={{marginTop:8,display:'flex',gap:6}}>
              <Bdg c={T.grn} ch="지원됨"/>
              <Bdg c={T.muted} ch="계좌 연결 필요"/>
              <Bdg c={T.ylw} ch="지역 제한 가능"/>
            </div>
          </Card>

          {/* Price */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.muted,fontSize:11}}>{sel.name} · {TRADFI_PROVIDERS[provider].name}</div>
            <div style={{color:T.txt,fontSize:24,fontWeight:900,fontFamily:'monospace',marginTop:4}}>{sel.p.toLocaleString()} {sel.category==='forex'?'':currency==='USD'?'USD':'USDT'}</div>
            <div style={{color:sel.c>=0?T.grn:T.red,fontWeight:800,fontSize:13,marginTop:2}}>{sel.c>=0?'▲':'▼'} {Math.abs(sel.c).toFixed(2)}%</div>
          </Card>

          {/* Order form */}
          <Card style={{padding:14,marginBottom:12}}>
            {/* Long/Short */}
            <div style={{display:'flex',gap:8,marginBottom:12}}>
              {(['long','short'] as const).map(s=>(
                <button key={s} onClick={()=>setSide(s)} style={{flex:1,padding:'11px',background:side===s?(s==='long'?T.grn:T.red):'transparent',color:side===s?'#fff':T.muted,border:`1px solid ${side===s?(s==='long'?T.grn:T.red):T.border}`,borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>
                  {s==='long'?'📈 롱 (상승)':'📉 숏 (하락)'}
                </button>
              ))}
            </div>

            {/* Amount */}
            <input type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="USDT 금액 입력" style={{width:'100%',background:T.alt,border:`1px solid ${T.border2}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:16,fontFamily:'monospace',fontWeight:700,outline:'none',marginBottom:8}}/>
            <div style={{display:'flex',gap:5,marginBottom:14}}>
              {['100','500','1000','5000'].map(v=><button key={v} onClick={()=>setAmount(v)} style={{flex:1,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}U</button>)}
            </div>

            {/* Leverage */}
            <div style={{marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                <span style={{color:T.muted,fontSize:11}}>레버리지 (최대 {sel.maxLev}x)</span>
                <span style={{color:lev>10?T.red:lev>5?T.ylw:T.grn,fontWeight:800,fontSize:13}}>{lev}x</span>
              </div>
              <input type="range" min={1} max={sel.maxLev} value={lev} onChange={e=>setLev(+e.target.value)} style={{width:'100%',accentColor:lev>10?T.red:lev>5?T.ylw:T.grn,marginBottom:6}}/>
              <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                {[1,2,3,5,10,sel.maxLev].filter((v,i,a)=>a.indexOf(v)===i).map(v=>(
                  <button key={v} onClick={()=>setLev(v)} style={{background:lev===v?T.acl+'25':'transparent',color:lev===v?T.acl:T.muted,border:`1px solid ${lev===v?T.acl:T.border}`,borderRadius:6,padding:'3px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}x</button>
                ))}
              </div>
            </div>

            {/* Liquidation preview */}
            {amount&&(
              <div style={{background:lev>10?T.red+'12':T.alt,border:`1px solid ${lev>10?T.red:T.border}30`,borderRadius:10,padding:'10px 12px',marginBottom:12}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{color:T.muted,fontSize:11}}>예상 청산가</span>
                  <span style={{color:lev>5?T.red:T.ylw,fontWeight:700,fontSize:11,fontFamily:'monospace'}}>{liqPrice.toFixed(sel.category==='forex'?4:2)}</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{color:T.muted,fontSize:11}}>청산까지 거리</span>
                  <span style={{color:T.txt,fontSize:11}}>{liqPct.toFixed(1)}% {side==='long'?'하락':'상승'} 시</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{color:T.muted,fontSize:11}}>거래 수수료 (0.05%)</span>
                  <span style={{color:T.txt,fontSize:11}}>{fee} USDT</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between'}}>
                  <span style={{color:T.muted,fontSize:11}}>오버나이트 (일)</span>
                  <span style={{color:T.ylw,fontSize:11}}>{Math.abs(swapFee)} USDT ({sel.overnight})</span>
                </div>
              </div>
            )}

            {lev>sel.maxLev*0.7&&<div style={{background:T.red+'12',border:`1px solid ${T.red}30`,borderRadius:8,padding:'8px 12px',marginBottom:12}}><div style={{color:T.red,fontSize:11,fontWeight:700}}>⚠️ 고레버리지 경고: CFD 상품은 레버리지 손실이 빠릅니다</div></div>}

            <button style={{width:'100%',padding:'14px',background:`linear-gradient(135deg,${side==='long'?T.grn:'#DC2626'},${side==='long'?'#059669':'#991B1B'})`,color:'#fff',border:'none',borderRadius:12,fontWeight:900,fontSize:14,cursor:'pointer'}}>
              [모의] {sel.nameKr} {side==='long'?'롱':'숏'} {lev}x 주문
            </button>
            <div style={{color:T.muted,fontSize:10,textAlign:'center',marginTop:6}}>실제 거래 미실행 · 수익 보장 없음 · CFD 위험 고지</div>
          </Card>
        </div>
      )}

      {/* Provider connect tab */}
      {tab==='connect'&&(
        <div>
          <div style={{fontWeight:800,fontSize:14,color:T.txt,marginBottom:12}}>🔗 TradFi 거래소 연동</div>
          {(Object.entries(TRADFI_PROVIDERS) as [TradFiProvider,any][]).filter(([k])=>k!=='watchonly').map(([key,p])=>(
            <Card key={key} style={{padding:'14px 16px',marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{display:'flex',gap:10,alignItems:'center'}}>
                  <div style={{width:40,height:40,borderRadius:10,background:p.color+'20',border:`1px solid ${p.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20}}>{p.icon}</div>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:13}}>{p.name}</div>
                    <div style={{color:T.muted,fontSize:10,marginTop:1}}>TradFi/CFD 지원 · USDT 결제</div>
                    <div style={{display:'flex',gap:4,marginTop:4}}>
                      {TRADFI_ASSETS.filter(a=>(Array.isArray(a.providers)?a.providers:[]).includes(key)).slice(0,4).map(a=><Bdg key={a.id} c={PRODUCT_COLOR[a.productType]} ch={a.sym} sm/>)}
                      {TRADFI_ASSETS.filter(a=>(Array.isArray(a.providers)?a.providers:[]).includes(key)).length>4&&<Bdg c={T.muted} ch={`+${TRADFI_ASSETS.filter(a=>(Array.isArray(a.providers)?a.providers:[]).includes(key)).length-4}개`} sm/>}
                    </div>
                  </div>
                </div>
                <a href={p.url} target="_blank" rel="noopener noreferrer" style={{background:p.color+'20',color:p.color,border:`1px solid ${p.color}40`,borderRadius:8,padding:'6px 12px',fontSize:11,fontWeight:700,textDecoration:'none'}}>연동</a>
              </div>
            </Card>
          ))}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.ylw}30`,marginTop:4}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:12,marginBottom:8}}>⚠️ 계정 적격성 안내</div>
            {['거래소 계정 KYC 완료 필요','일부 상품은 특정 국가에서 제한될 수 있음','개인 투자자 등급에 따라 레버리지 한도 다름','CFD는 거래소 정책에 따라 변동 가능','TRAIGO는 CFD 직접 제공자가 아닌 연결 플레이스홀더'].map((w,i)=>(
              <div key={i} style={{display:'flex',gap:6,padding:'3px 0'}}><span style={{color:T.ylw,fontSize:11}}>•</span><span style={{color:T.sub,fontSize:11}}>{w}</span></div>
            ))}
          </Card>
        </div>
      )}

      {/* Risk tab */}
      {tab==='risk'&&(
        <div>
          <div style={{fontWeight:800,fontSize:14,color:T.txt,marginBottom:12}}>⚠️ TradFi/CFD 위험 고지</div>
          {[
            {t:'CFD (차액결제거래) 란?',b:'CFD는 실제 자산을 보유하는 것이 아닌, 가격 변동 차이만 정산하는 파생상품입니다. 레버리지를 사용하므로 원금 전액 손실이 가능합니다.',c:'#7C3AED'},
            {t:'레버리지 위험',b:'레버리지를 사용하면 수익과 손실이 배수로 증가합니다. 10배 레버리지 사용 시 10% 역방향 이동만으로도 원금 전액 손실(청산)이 가능합니다.',c:T.red},
            {t:'오버나이트/스왑 비용',b:'CFD 포지션을 하루 이상 보유 시 스왑 비용(오버나이트 피)이 발생합니다. 장기 보유 시 상당한 비용이 누적될 수 있습니다.',c:T.ylw},
            {t:'토큰화 주식과의 차이',b:'일부 거래소는 "토큰화 주식"도 제공합니다. 이는 실제 주식과 유사하게 가격 추종하지만, 주주권이나 배당권이 없을 수 있습니다.',c:T.acl},
            {t:'지역 제한',b:'파생상품/CFD 규제는 국가마다 다릅니다. 일부 국가에서는 리테일 고객의 CFD 거래가 제한되거나 금지될 수 있습니다.',c:T.cyn},
            {t:'모의매매 기본값',b:'TRAIGO는 모의매매가 기본입니다. 실제 CFD 거래는 해당 거래소에서 직접 진행하며, TRAIGO는 직접 거래를 실행하지 않습니다.',c:T.grn},
          ].map(r=>(
            <Card key={r.t} style={{padding:'14px 16px',marginBottom:10,border:`1px solid ${r.c}25`}}>
              <div style={{color:r.c,fontWeight:700,fontSize:12,marginBottom:6}}>{r.t}</div>
              <div style={{color:T.sub,fontSize:11,lineHeight:1.6}}>{r.b}</div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── RealtimePage (실시간 엔진 + 알림 센터) ── */
type DataFreq = 'low'|'balanced'|'high';
interface RealtimeConfig { freq:DataFreq; wsEnabled:boolean; pollingInterval:number; }



export default TradFiPage;