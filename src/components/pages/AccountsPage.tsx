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


const EXCHANGE_INFO:Record<ExchangeType,{name:string;icon:string;color:string;url:string}> = {
  binance:  {name:'Binance',icon:'🟡',color:'#F0B90B',url:'https://www.binance.com/api'},
  gateio:   {name:'Gate.io',icon:'🔵',color:'#3B82F6',url:'https://www.gate.io/api'},
  upbit:    {name:'Upbit',icon:'🔵',color:'#2563EB',url:'https://upbit.com/open_api'},
  bithumb:  {name:'Bithumb',icon:'🟢',color:'#10B981',url:'https://apidocs.bithumb.com'},
  kr_broker:{name:'국내 증권사',icon:'🇰🇷',color:'#EF4444',url:'#'},
  us_broker:{name:'해외 브로커',icon:'🇺🇸',color:'#6366F1',url:'#'},
};

const GROUP_INFO:Record<AccountGroup,{name:string;color:string;icon:string}> = {
  longterm: {name:'장투 계좌',color:'#3B82F6',icon:'📈'},
  shortterm:{name:'단타 계좌',color:'#F59E0B',icon:'⚡'},
  auto:     {name:'자동매매 계좌',color:'#10B981',icon:'🤖'},
  cash:     {name:'현금 대기 계좌',color:'#94A3B8',icon:'💵'},
  custom:   {name:'커스텀 그룹',color:'#7C3AED',icon:'⚙️'},
};

const MOCK_ACCOUNTS:ConnectedAccount[] = [
  {id:'acc1',exchange:'binance',nickname:'바이낸스 메인',group:'shortterm',status:'connected',balance:15420000,available:8200000,openPositions:3,todayPnl:87000,todayPnlPct:0.57,apiKeyMasked:'BNBX****...****KMN2',permissions:{trading:true,withdrawal:false,read:true},autoTrading:true,maxDailyLoss:500000,maxPositionSize:5000000,lastSync:'방금',isPaper:true,emergencyStop:false},
  {id:'acc2',exchange:'upbit',nickname:'업비트 장투',group:'longterm',status:'connected',balance:32100000,available:5000000,openPositions:5,todayPnl:124000,todayPnlPct:0.39,apiKeyMasked:'UPX****...****A92F',permissions:{trading:true,withdrawal:false,read:true},autoTrading:false,maxDailyLoss:1000000,maxPositionSize:10000000,lastSync:'3분 전',isPaper:true,emergencyStop:false},
  {id:'acc3',exchange:'gateio',nickname:'Gate.io 알트',group:'auto',status:'connected',balance:4800000,available:4800000,openPositions:0,todayPnl:-12000,todayPnlPct:-0.25,apiKeyMasked:'GTX****...****BB1C',permissions:{trading:true,withdrawal:false,read:true},autoTrading:true,maxDailyLoss:200000,maxPositionSize:2000000,lastSync:'1분 전',isPaper:true,emergencyStop:false},
  {id:'acc4',exchange:'kr_broker',nickname:'미래에셋 장투',group:'longterm',status:'pending',balance:0,available:0,openPositions:0,todayPnl:0,todayPnlPct:0,apiKeyMasked:'',permissions:{trading:false,withdrawal:false,read:false},autoTrading:false,maxDailyLoss:0,maxPositionSize:0,lastSync:'미연결',isPaper:true,emergencyStop:false},
];


function AccountsPage({prices,currency}:{prices:Asset[];currency:string}) {
  const [tab,setTab]=useState<'accounts'|'connect'|'bulk'|'safety'>('accounts');
  const [accounts,setAccounts]=useState<ConnectedAccount[]>(MOCK_ACCOUNTS);
  const [selAccs,setSelAccs]=useState<string[]>([]);
  const [connectStep,setConnectStep]=useState(0);
  const [connectExchange,setConnectExchange]=useState<ExchangeType>('binance');
  const [apiKey,setApiKey]=useState('');
  const [apiSecret,setApiSecret]=useState('');
  const [apiNick,setApiNick]=useState('');
  const [bulkOrder,setBulkOrder]=useState<Partial<BulkOrder>>({side:'buy',totalAmount:0,allocationMethod:'equal',selectedAccounts:[],allocations:{},leverage:1});
  const [showEmergency,setShowEmergency]=useState(false);
  const [globalStop,setGlobalStop]=useState(false);

  const totalBalance=(accounts||[]).reduce((s,a)=>s+(a?.balance||0),0);
  const totalPnl=accounts.reduce((s,a)=>s+a.todayPnl,0);
  const connectedCount=accounts.filter(a=>a.status==='connected').length;

  const toggleAccount=(id:string)=>setSelAccs(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);

  const computeAllocations=(accs:ConnectedAccount[],method:string,total:number):Record<string,number>=>{
    if(accs.length===0)return {};
    if(method==='equal'){const amt=Math.floor(total/accs.length);return Object.fromEntries(accs.map(a=>[a.id,amt]));}
    if(method==='weighted'){const tot=accs.reduce((s,a)=>s+a.available,0);return Object.fromEntries(accs.map(a=>[a.id,Math.floor(total*(a.available/(tot||1)))]));}
    return Object.fromEntries(accs.map(a=>[a.id,Math.floor(total/accs.length)]));
  };

  return (
    <div>
      {/* Global emergency stop banner */}
      {globalStop&&<div style={{background:T.red+'25',border:`1px solid ${T.red}`,borderRadius:12,padding:'12px 14px',marginBottom:14,display:'flex',gap:8,alignItems:'center'}}><span style={{fontSize:20}}>🚨</span><div><div style={{color:T.red,fontWeight:800}}>전체 긴급 정지 활성화</div><div style={{color:T.sub,fontSize:11}}>모든 자동매매가 중단되었습니다. 수동 매매는 가능합니다.</div></div><button onClick={()=>setGlobalStop(false)} style={{marginLeft:'auto',background:T.red,color:'#fff',border:'none',borderRadius:8,padding:'6px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>해제</button></div>}

      {/* Tabs */}
      <div style={{display:'flex',gap:5,marginBottom:14,overflowX:'auto'}}>
        {([['accounts','📱 계좌 현황'],['connect','🔗 API 연결'],['bulk','📦 일괄 매매'],['safety','🛡️ 안전 설정']] as const).map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'8px 12px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{label}</button>
        ))}
      </div>

      {/* ── ACCOUNTS TAB ── */}
      {tab==='accounts'&&(
        <div>
          {/* Paper mode notice */}
          <div style={{background:T.prp+'15',border:`1px solid ${T.prp}30`,borderRadius:12,padding:'10px 14px',marginBottom:14}}>
            <div style={{color:T.prp,fontWeight:700,fontSize:11}}>🎮 모의 API 연결 모드</div>
            <div style={{color:T.sub,fontSize:10,marginTop:2}}>실제 거래소 API가 연결된 것처럼 보이지만 모든 거래는 모의입니다. 실제 자금이 이동하지 않습니다.</div>
          </div>
          {/* Summary */}
          <div style={{background:'linear-gradient(135deg,#0D1A35,#091228)',border:`1px solid ${T.border2}`,borderRadius:18,padding:'18px 16px',marginBottom:14}}>
            <div style={{color:T.muted,fontSize:11,marginBottom:2}}>연결된 계좌 총 자산 (모의)</div>
            <div style={{color:T.txt,fontSize:26,fontWeight:900,fontFamily:'monospace'}}>{cvt(totalBalance,currency)}</div>
            <div style={{display:'flex',gap:16,marginTop:8}}>
              <div><div style={{color:T.muted,fontSize:10}}>오늘 PnL</div><div style={{color:totalPnl>=0?T.grn:T.red,fontWeight:800}}>{totalPnl>=0?'+':''}{cvt(Math.abs(totalPnl),currency)}</div></div>
              <div><div style={{color:T.muted,fontSize:10}}>연결 계좌</div><div style={{color:T.txt,fontWeight:800}}>{connectedCount}/{accounts.length}개</div></div>
              <div><div style={{color:T.muted,fontSize:10}}>자동매매</div><div style={{color:T.grn,fontWeight:800}}>{accounts.filter(a=>a.autoTrading).length}개 실행</div></div>
            </div>
            <div style={{display:'flex',gap:8,marginTop:12}}>
              <button onClick={()=>setShowEmergency(true)} style={{background:T.red+'20',color:T.red,border:`1px solid ${T.red}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>🚨 전체 긴급 정지</button>
              <button onClick={()=>setTab('connect')} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 계좌 연결</button>
            </div>
          </div>

          {/* Account groups */}
          {(['longterm','shortterm','auto','cash'] as AccountGroup[]).map(grp=>{
            const grpAccs=accounts.filter(a=>a.group===grp);
            if(grpAccs.length===0)return null;
            const gi=GROUP_INFO[grp];
            return (
              <div key={grp} style={{marginBottom:14}}>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}><span style={{fontSize:14}}>{gi.icon}</span><span style={{color:T.txt,fontWeight:700,fontSize:13}}>{gi.name}</span><Bdg c={gi.color} ch={grpAccs.length+'개'} sm/></div>
                {grpAccs.map((acc,i)=>{
                  const ex=EXCHANGE_INFO[acc.exchange];
                  const isSel=selAccs.includes(acc.id);
                  return (
                    <div key={acc.id} onClick={()=>toggleAccount(acc.id)} style={{background:T.card,border:`2px solid ${isSel?T.acl:T.border}`,borderRadius:16,padding:'14px',marginBottom:8,cursor:'pointer',position:'relative'}}>
                      {isSel&&<div style={{position:'absolute',top:10,right:10,width:18,height:18,borderRadius:'50%',background:T.acl,display:'flex',alignItems:'center',justifyContent:'center'}}><span style={{color:'#fff',fontSize:10,fontWeight:900}}>✓</span></div>}
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
                        <div style={{display:'flex',gap:8,alignItems:'center'}}>
                          <div style={{width:38,height:38,borderRadius:10,background:ex.color+'20',border:`1px solid ${ex.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18}}>{ex.icon}</div>
                          <div>
                            <div style={{display:'flex',gap:5,alignItems:'center'}}><span style={{color:T.txt,fontWeight:700,fontSize:13}}>{acc.nickname}</span><Bdg c={acc.status==='connected'?T.grn:acc.status==='pending'?T.ylw:T.red} ch={acc.status==='connected'?'연결됨':acc.status==='pending'?'연결중':'오류'} sm/>{acc.isPaper&&<Bdg c={T.prp} ch="모의" sm/>}</div>
                            <div style={{color:T.muted,fontSize:10,marginTop:1}}>{ex.name} · {acc.lastSync}</div>
                          </div>
                        </div>
                        <div style={{textAlign:'right'}}>
                          <div style={{color:T.txt,fontWeight:700,fontSize:13,fontFamily:'monospace'}}>{cvt(acc.balance,currency)}</div>
                          <div style={{color:acc.todayPnl>=0?T.grn:T.red,fontSize:11,fontWeight:700}}>{acc.todayPnl>=0?'+':''}{cvt(Math.abs(acc.todayPnl),currency)}</div>
                        </div>
                      </div>
                      {acc.status==='connected'&&(
                        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
                          {[{l:'가용',v:cvt(acc.available,currency)},{l:'포지션',v:acc.openPositions+'개'},{l:'거래권한',v:acc.permissions.trading?'✅':'❌'},{l:'출금권한',v:acc.permissions.withdrawal?'⚠️':'✅ 차단'}].map(r=>(
                            <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'6px 8px',textAlign:'center'}}>
                              <div style={{color:T.muted,fontSize:9}}>{r.l}</div>
                              <div style={{color:r.l==='출금권한'?(acc.permissions.withdrawal?T.red:T.grn):T.txt,fontSize:10,fontWeight:700,marginTop:1}}>{r.v}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {acc.autoTrading&&(
                        <div style={{marginTop:8,background:T.grn+'12',border:`1px solid ${T.grn}30`,borderRadius:8,padding:'5px 10px',display:'flex',alignItems:'center',gap:6}}>
                          <Dot c={T.grn}/><span style={{color:T.grn,fontSize:10,fontWeight:700}}>자동매매 실행 중</span>
                          <span style={{color:T.muted,fontSize:10}}>일일 최대 손실: {cvt(acc.maxDailyLoss,currency)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Bulk trade CTA */}
          {selAccs.length>0&&(
            <div style={{position:'sticky',bottom:80,background:T.surf,border:`1px solid ${T.acl}40`,borderRadius:16,padding:'12px 14px',boxShadow:'0 -4px 20px rgba(0,0,0,.4)',zIndex:20}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div><div style={{color:T.txt,fontWeight:700,fontSize:13}}>{selAccs.length}개 계좌 선택됨</div><div style={{color:T.muted,fontSize:10}}>일괄 매매를 실행할 수 있습니다</div></div>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={()=>setSelAccs([])} style={{background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'7px 12px',fontSize:11,cursor:'pointer'}}>취소</button>
                  <button onClick={()=>setTab('bulk')} style={{background:T.acc,color:'#fff',border:'none',borderRadius:8,padding:'7px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>📦 일괄 매매 →</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CONNECT TAB ── */}
      {tab==='connect'&&(
        <div>
          {/* Security warning */}
          <div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:12,padding:'12px 14px',marginBottom:14}}>
            <div style={{color:T.red,fontWeight:800,fontSize:13,marginBottom:6}}>🔐 API 연결 보안 수칙</div>
            {['출금 권한은 절대 켜지 마세요','거래 권한만 허용하세요','API 키는 본인 계정에만 사용됩니다','API Secret은 서버에만 저장됩니다 (프론트엔드 미노출)','언제든지 거래소에서 API 키를 삭제할 수 있습니다'].map((w,i)=>(
              <div key={i} style={{display:'flex',gap:6,padding:'3px 0'}}><span style={{color:T.red,fontSize:11,flexShrink:0}}>⚠️</span><span style={{color:T.sub,fontSize:11}}>{w}</span></div>
            ))}
          </div>

          {/* Exchange selector */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>거래소/브로커 선택</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {(Object.entries(EXCHANGE_INFO) as [ExchangeType,any][]).map(([key,ex])=>(
                <button key={key} onClick={()=>{setConnectExchange(key);setConnectStep(1);}} style={{background:connectExchange===key?ex.color+'20':T.alt,border:`2px solid ${connectExchange===key?ex.color:T.border}`,borderRadius:12,padding:'12px 6px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:22,marginBottom:4}}>{ex.icon}</div>
                  <div style={{color:connectExchange===key?ex.color:T.txt,fontWeight:700,fontSize:11}}>{ex.name}</div>
                </button>
              ))}
            </div>
          </Card>

          {connectStep>=1&&(
            <Card style={{padding:'14px 16px',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📋 API 키 발급 가이드</div>
              <div style={{display:'flex',marginBottom:14,gap:4}}>
                {[1,2,3,4].map(s=><div key={s} style={{flex:1,height:4,background:connectStep>=s?T.acl:T.border,borderRadius:2,transition:'background .3s'}}/>)}
              </div>
              {[
                {step:1,title:`${EXCHANGE_INFO[connectExchange].name} 로그인`,desc:'거래소 웹사이트에 로그인하세요.',action:'거래소 바로가기',url:EXCHANGE_INFO[connectExchange].url},
                {step:2,title:'API 관리 페이지 이동',desc:'계정 설정 → API 관리 (또는 API 키 생성) 메뉴로 이동하세요.'},
                {step:3,title:'API 키 생성 및 권한 설정',desc:'새 API 키를 생성하고 반드시 ✅ 읽기, ✅ 거래만 허용. 출금 권한은 절대 체크 해제하세요!'},
                {step:4,title:'API 키/Secret 복사',desc:'생성된 API Key와 Secret Key를 아래에 입력하세요. Secret은 한 번만 표시됩니다.'},
              ].map(g=>(
                <div key={g.step} style={{display:'flex',gap:10,padding:'10px 0',borderBottom:`1px solid ${T.border}`,opacity:connectStep===g.step?1:0.5}}>
                  <div style={{width:24,height:24,borderRadius:'50%',background:connectStep>=g.step?T.acl:T.border,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:900,fontSize:11,color:'#fff',flexShrink:0}}>{g.step}</div>
                  <div style={{flex:1}}>
                    <div style={{color:T.txt,fontWeight:700,fontSize:12}}>{g.title}</div>
                    <div style={{color:T.muted,fontSize:11,marginTop:2,lineHeight:1.5}}>{g.desc}</div>
                    {g.url&&g.step===connectStep&&<a href={g.url} target="_blank" rel="noopener noreferrer" style={{color:T.acl,fontSize:11,fontWeight:700,display:'inline-block',marginTop:4}}>→ {g.action}</a>}
                  </div>
                  {connectStep===g.step&&g.step<4&&<button onClick={()=>setConnectStep(s=>s+1)} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'5px 10px',fontSize:10,fontWeight:700,cursor:'pointer',flexShrink:0}}>다음</button>}
                </div>
              ))}
            </Card>
          )}

          {connectStep>=4&&(
            <Card style={{padding:'14px 16px',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔑 API 키 입력</div>
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>계좌 별칭</div>
                <input value={apiNick} onChange={e=>setApiNick(e.target.value)} placeholder="예: 바이낸스 메인" style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:12,outline:'none'}}/>
              </div>
              <div style={{marginBottom:10}}>
                <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>API Key</div>
                <input value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="API Key 입력" style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:12,outline:'none',fontFamily:'monospace'}}/>
              </div>
              <div style={{marginBottom:14}}>
                <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>API Secret</div>
                <input type="password" value={apiSecret} onChange={e=>setApiSecret(e.target.value)} placeholder="API Secret 입력 (서버에만 저장됨)" style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:12,outline:'none',fontFamily:'monospace'}}/>
                <div style={{color:T.muted,fontSize:10,marginTop:4}}>🔒 API Secret은 암호화되어 서버에만 저장됩니다. 프론트엔드에 노출되지 않습니다.</div>
              </div>
              <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:8,padding:'10px 12px',marginBottom:14}}>
                <div style={{color:T.ylw,fontWeight:700,fontSize:11,marginBottom:3}}>⚠️ 출금 권한 확인</div>
                <div style={{color:T.sub,fontSize:10}}>API 키 생성 시 출금 권한이 비활성화되어 있는지 반드시 확인하세요. TRAIGO는 출금 기능을 사용하지 않습니다.</div>
              </div>
              <button onClick={()=>{setTab('accounts');setConnectStep(0);}} style={{width:'100%',padding:'12px',background:`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer'}}>
                🔗 연결 (모의 테스트)
              </button>
              <div style={{color:T.muted,fontSize:10,textAlign:'center',marginTop:6}}>현재는 모의 연결입니다. 실제 API 실행은 서버 검증 후 활성화됩니다.</div>
            </Card>
          )}
        </div>
      )}

      {/* ── BULK ORDER TAB ── */}
      {tab==='bulk'&&(
        <div>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'10px 14px',marginBottom:14}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>⚠️ 일괄 매매 모드 · 🎮 모의 — 실제 자금 이동 없음</div>
          </div>

          {/* Asset selection */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>1️⃣ 종목 선택</div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {['BTC','ETH','SOL','AAPL','NVDA','SPY'].map(id=>(
                <button key={id} onClick={()=>setBulkOrder(p=>({...p,assetId:id,nameKr:id}))} style={{background:bulkOrder.assetId===id?T.acg:'transparent',color:bulkOrder.assetId===id?T.acl:T.muted,border:`1px solid ${bulkOrder.assetId===id?T.acl:T.border}`,borderRadius:8,padding:'5px 12px',fontSize:12,fontWeight:700,cursor:'pointer'}}>{id}</button>
              ))}
            </div>
          </Card>

          {/* Account selection */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>2️⃣ 실행 계좌 선택</div>
            <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap'}}>
              <button onClick={()=>setBulkOrder(p=>({...p,selectedAccounts:accounts.filter(a=>a.status==='connected').map(a=>a.id)}))} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>전체 선택</button>
              {(['longterm','shortterm','auto'] as AccountGroup[]).map(grp=>(
                <button key={grp} onClick={()=>setBulkOrder(p=>({...p,selectedAccounts:accounts.filter(a=>a.group===grp&&a.status==='connected').map(a=>a.id)}))} style={{background:GROUP_INFO[grp].color+'20',color:GROUP_INFO[grp].color,border:`1px solid ${GROUP_INFO[grp].color}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{GROUP_INFO[grp].name}</button>
              ))}
            </div>
            {accounts.filter(a=>a.status==='connected').map(acc=>{
              const ex=EXCHANGE_INFO[acc.exchange];
              const isSel=(bulkOrder.selectedAccounts||[]).includes(acc.id);
              return (
                <div key={acc.id} onClick={()=>setBulkOrder(p=>({...p,selectedAccounts:isSel?p.selectedAccounts?.filter(x=>x!==acc.id)||[]:[...(p.selectedAccounts||[]),acc.id]}))} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 12px',background:isSel?T.acg:T.alt,border:`1px solid ${isSel?T.acl:T.border}`,borderRadius:10,marginBottom:6,cursor:'pointer'}}>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}><span style={{fontSize:16}}>{ex.icon}</span><div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{acc.nickname}</div><div style={{color:T.muted,fontSize:10}}>가용 {cvt(acc.available,currency)}</div></div></div>
                  {isSel&&<span style={{color:T.acl,fontSize:14,fontWeight:900}}>✓</span>}
                </div>
              );
            })}
          </Card>

          {/* Amount + allocation */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>3️⃣ 금액 및 배분 방식</div>
            <input type="number" value={bulkOrder.totalAmount||''} onChange={e=>setBulkOrder(p=>({...p,totalAmount:+e.target.value}))} placeholder="총 주문 금액 (₩)" style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:14,fontFamily:'monospace',fontWeight:700,outline:'none',marginBottom:10}}/>
            <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:6}}>배분 방식</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6,marginBottom:10}}>
              {[{id:'equal',l:'균등 배분',d:'모든 계좌에 동일 금액'},{id:'weighted',l:'잔고 비례',d:'가용 잔고 비율로 배분'},{id:'percent',l:'퍼센트',d:'계좌별 % 직접 설정'},{id:'custom',l:'직접 입력',d:'계좌별 금액 직접 입력'}].map(m=>(
                <button key={m.id} onClick={()=>setBulkOrder(p=>({...p,allocationMethod:m.id as any}))} style={{background:bulkOrder.allocationMethod===m.id?T.acg:T.alt,border:`1px solid ${bulkOrder.allocationMethod===m.id?T.acl:T.border}`,borderRadius:10,padding:'10px 8px',cursor:'pointer',textAlign:'left'}}>
                  <div style={{color:bulkOrder.allocationMethod===m.id?T.acl:T.txt,fontSize:11,fontWeight:700}}>{m.l}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:2}}>{m.d}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Preview */}
          {(bulkOrder.selectedAccounts||[]).length>0&&(bulkOrder.totalAmount||0)>0&&(
            <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.ylw}30`}}>
              <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:10}}>📋 주문 미리보기</div>
              {(()=>{
                const selAccObjs=accounts.filter(a=>(bulkOrder.selectedAccounts||[]).includes(a.id));
                const allocs=computeAllocations(selAccObjs,bulkOrder.allocationMethod||'equal',bulkOrder.totalAmount||0);
                return selAccObjs.map(acc=>{
                  const ex=EXCHANGE_INFO[acc.exchange];
                  const amt=allocs[acc.id]||0;
                  const fee=Math.round(amt*0.0005);
                  return (
                    <div key={acc.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:`1px solid ${T.border}`}}>
                      <div style={{display:'flex',gap:6,alignItems:'center'}}><span>{ex.icon}</span><span style={{color:T.txt,fontSize:12}}>{acc.nickname}</span></div>
                      <div style={{textAlign:'right'}}><div style={{color:T.txt,fontSize:12,fontWeight:700,fontFamily:'monospace'}}>{cvt(amt,currency)}</div><div style={{color:T.muted,fontSize:10}}>수수료 {cvt(fee,currency)}</div></div>
                    </div>
                  );
                });
              })()}
              <div style={{display:'flex',justifyContent:'space-between',padding:'10px 0 0',marginTop:4}}>
                <span style={{color:T.muted,fontSize:12}}>총 주문 금액</span>
                <span style={{color:T.txt,fontWeight:800,fontSize:14,fontFamily:'monospace'}}>{cvt(bulkOrder.totalAmount||0,currency)}</span>
              </div>
              <div style={{background:T.red+'12',border:`1px solid ${T.red}30`,borderRadius:8,padding:'8px 12px',marginTop:10}}>
                <div style={{color:T.red,fontSize:11,fontWeight:700}}>⚠️ 모의매매 전용 — 실제 자금이 이동하지 않습니다</div>
              </div>
              <button style={{width:'100%',padding:'13px',background:`linear-gradient(135deg,${T.grn},#059669)`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer',marginTop:12}}>
                📦 [{(bulkOrder.selectedAccounts||[]).length}개 계좌] 모의 매수 실행
              </button>
            </Card>
          )}
        </div>
      )}

      {/* ── SAFETY TAB ── */}
      {tab==='safety'&&(
        <div>
          {/* Global emergency stop */}
          <Card style={{padding:'16px',marginBottom:12,border:`1px solid ${T.red}30`}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
              <div><div style={{color:T.red,fontWeight:800,fontSize:13}}>🚨 전체 긴급 정지</div><div style={{color:T.muted,fontSize:11}}>모든 계좌 자동매매 즉시 중단</div></div>
              <button onClick={()=>setGlobalStop(true)} style={{background:globalStop?T.grn+'20':T.red+'20',color:globalStop?T.grn:T.red,border:`1px solid ${globalStop?T.grn:T.red}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>{globalStop?'✅ 정지됨':'🚨 전체 정지'}</button>
            </div>
            <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              {['자동매매만 정지','수동 매매 유지'].map((opt,i)=>(
                <button key={i} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px',fontSize:11,color:T.txt,cursor:'pointer'}}>{opt}</button>
              ))}
            </div>
          </Card>

          {/* Per-account safety */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🛡️ 계좌별 안전 설정</div>
            {accounts.filter(a=>a.status==='connected').map((acc,i,arr)=>{
              const ex=EXCHANGE_INFO[acc.exchange];
              return (
                <div key={acc.id} style={{padding:'12px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                    <div style={{display:'flex',gap:6,alignItems:'center'}}><span style={{fontSize:14}}>{ex.icon}</span><span style={{color:T.txt,fontSize:12,fontWeight:700}}>{acc.nickname}</span></div>
                    <Toggle on={acc.autoTrading} onChange={v=>setAccounts(p=>p.map(a=>a.id===acc.id?{...a,autoTrading:v}:a))}/>
                  </div>
                  <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                    {[{l:'일일 최대 손실',v:cvt(acc.maxDailyLoss,currency)},{l:'최대 포지션',v:cvt(acc.maxPositionSize,currency)}].map(r=>(
                      <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'8px 10px'}}>
                        <div style={{color:T.muted,fontSize:9}}>{r.l}</div>
                        <div style={{color:T.txt,fontSize:11,fontWeight:700,marginTop:1}}>{r.v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </Card>

          {/* API permissions review */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔑 API 권한 현황</div>
            {accounts.filter(a=>a.status==='connected').map((acc,i,arr)=>{
              const ex=EXCHANGE_INFO[acc.exchange];
              return (
                <div key={acc.id} style={{padding:'10px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700,marginBottom:6}}>{ex.icon} {acc.nickname}</div>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    <Bdg c={T.grn} ch="✅ 읽기 권한"/>
                    <Bdg c={acc.permissions.trading?T.grn:T.red} ch={acc.permissions.trading?'✅ 거래 권한':'❌ 거래 권한 없음'}/>
                    <Bdg c={acc.permissions.withdrawal?T.red:T.grn} ch={acc.permissions.withdrawal?'⚠️ 출금 권한 ON':'✅ 출금 차단됨'}/>
                  </div>
                  <div style={{display:'flex',gap:6,marginTop:6}}>
                    <div style={{color:T.muted,fontSize:9}}>API: {acc.apiKeyMasked||'(미연결)'}</div>
                  </div>
                </div>
              );
            })}
          </Card>
        </div>
      )}

      {/* Emergency stop modal */}
      {showEmergency&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.8)',zIndex:300}} onClick={()=>setShowEmergency(false)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:301,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px calc(40px + env(safe-area-inset-bottom, 0px))',maxWidth:480,margin:'0 auto',border:`2px solid ${T.red}`}}>
            <div style={{color:T.red,fontWeight:900,fontSize:18,marginBottom:4}}>🚨 전체 긴급 정지</div>
            <div style={{color:T.sub,fontSize:12,marginBottom:16,lineHeight:1.6}}>모든 계좌의 자동매매를 즉시 중단합니다. 수동 매매는 계속 가능합니다. 이 작업은 취소할 수 있습니다.</div>
            <div style={{display:'flex',gap:10}}>
              <button onClick={()=>setShowEmergency(false)} style={{flex:1,padding:'13px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>{setGlobalStop(true);setAccounts(p=>p.map(a=>({...a,autoTrading:false})));setShowEmergency(false);}} style={{flex:2,padding:'13px',background:T.red,color:'#fff',border:'none',borderRadius:12,fontWeight:900,fontSize:14,cursor:'pointer'}}>🚨 전체 정지 실행</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ── FundingPage (입출금 + 환전 + 오픈뱅킹) ── */
type FundingTab = 'hub'|'openbanking'|'fx'|'guide';
interface LinkedBank { id:string; bankName:string; accountNum:string; holder:string; balance:number; isMain:boolean; }
interface ExchangeFunding { exchange:string; icon:string; color:string; depositTime:string; withdrawTime:string; depositFee:string; withdrawFee:string; minDeposit:string; }

const EXCHANGE_FUNDING:ExchangeFunding[] = [
  {exchange:'Binance',icon:'🟡',color:'#F0B90B',depositTime:'즉시~10분',withdrawTime:'10~60분',depositFee:'무료',withdrawFee:'네트워크 수수료',minDeposit:'없음'},
  {exchange:'Upbit',icon:'🔵',color:'#2563EB',depositTime:'즉시',withdrawTime:'즉시~10분',depositFee:'무료',withdrawFee:'무료',minDeposit:'없음'},
  {exchange:'Bithumb',icon:'🟢',color:'#10B981',depositTime:'즉시',withdrawTime:'즉시~10분',depositFee:'무료',withdrawFee:'무료',minDeposit:'없음'},
  {exchange:'Gate.io',icon:'🔵',color:'#3B82F6',depositTime:'즉시~30분',withdrawTime:'30~120분',depositFee:'무료',withdrawFee:'네트워크 수수료',minDeposit:'없음'},
];

const FX_PAIRS = [
  {from:'KRW',to:'USD',rate:0.000727,fee:0.3,flag1:'🇰🇷',flag2:'🇺🇸'},
  {from:'KRW',to:'JPY',rate:0.112,fee:0.3,flag1:'🇰🇷',flag2:'🇯🇵'},
  {from:'KRW',to:'EUR',rate:0.000667,fee:0.35,flag1:'🇰🇷',flag2:'🇪🇺'},
  {from:'USD',to:'KRW',rate:1375.4,fee:0.3,flag1:'🇺🇸',flag2:'🇰🇷'},
  {from:'USD',to:'JPY',rate:154.2,fee:0.25,flag1:'🇺🇸',flag2:'🇯🇵'},
  {from:'EUR',to:'USD',rate:1.089,fee:0.3,flag1:'🇪🇺',flag2:'🇺🇸'},
];



export default AccountsPage;