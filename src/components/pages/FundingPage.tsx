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


function FundingPage({currency}:{currency:string}) {
  const [tab,setTab]=useState<FundingTab>('hub');
  const [fromAcc,setFromAcc]=useState('bank1');
  const [toAcc,setToAcc]=useState('binance');
  const [amount,setAmount]=useState('');
  const [fxPair,setFxPair]=useState(FX_PAIRS[0]);
  const [fxAmount,setFxAmount]=useState('');
  const [obTab,setObTab]=useState<'accounts'|'deposit'|'withdraw'>('accounts');
  const [linkedBanks]=useState<LinkedBank[]>([
    {id:'bank1',bankName:'카카오뱅크',accountNum:'3333-****-1234',holder:'홍길동',balance:5240000,isMain:true},
    {id:'bank2',bankName:'신한은행',accountNum:'110-****-5678',holder:'홍길동',balance:1830000,isMain:false},
  ]);
  const [showConfirm,setShowConfirm]=useState(false);

  const SOURCES=[
    {id:'bank1',label:'카카오뱅크 ****1234',icon:'🏦',balance:5240000},
    {id:'bank2',label:'신한은행 ****5678',icon:'🏦',balance:1830000},
  ];
  const DESTS=[
    {id:'binance',label:'Binance',icon:'🟡'},
    {id:'upbit',label:'Upbit',icon:'🔵'},
    {id:'bithumb',label:'Bithumb',icon:'🟢'},
    {id:'gateio',label:'Gate.io',icon:'🔵'},
    {id:'kr_broker',label:'국내 증권사',icon:'🇰🇷'},
  ];

  const fxConverted = fxAmount ? (+fxAmount * fxPair.rate).toFixed(fxPair.to==='KRW'?0:4) : '';
  const fxFee = fxAmount ? (+fxAmount * fxPair.fee / 100).toFixed(2) : '';

  return (
    <div>
      <div style={{display:'flex',gap:5,marginBottom:14,overflowX:'auto'}}>
        {([['hub','💸 입출금'],['openbanking','🏦 오픈뱅킹'],['fx','💱 환전'],['guide','📖 가이드']] as const).map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'8px 12px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{label}</button>
        ))}
      </div>

      {/* ── HUB TAB ── */}
      {tab==='hub'&&(
        <div>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:12,padding:'10px 14px',marginBottom:14}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>⚠️ 안내</div>
            <div style={{color:T.sub,fontSize:10,marginTop:2,lineHeight:1.6}}>실제 계좌이체는 오픈뱅킹 계약/승인 후 가능합니다. 현재는 모의/가이드 기능입니다. TRAIGO는 사용자 자금을 직접 보관하지 않습니다.</div>
          </div>

          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>💸 자금 이동</div>
            <div style={{marginBottom:10}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>출금 계좌</div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {SOURCES.map(s=><button key={s.id} onClick={()=>setFromAcc(s.id)} style={{flex:1,minWidth:120,background:fromAcc===s.id?T.acg:T.alt,color:fromAcc===s.id?T.acl:T.txt,border:`1px solid ${fromAcc===s.id?T.acl:T.border}`,borderRadius:10,padding:'8px 10px',cursor:'pointer',textAlign:'left'}}>
                  <div style={{fontSize:11,fontWeight:600}}>{s.icon} {s.label}</div>
                  <div style={{color:fromAcc===s.id?T.acl:T.muted,fontSize:10,marginTop:2}}>{cvt(s.balance,currency)}</div>
                </button>)}
              </div>
            </div>
            <div style={{textAlign:'center',fontSize:18,color:T.muted,margin:'6px 0'}}>↕</div>
            <div style={{marginBottom:12}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>입금 대상</div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {DESTS.map(d=><button key={d.id} onClick={()=>setToAcc(d.id)} style={{background:toAcc===d.id?T.acg:T.alt,color:toAcc===d.id?T.acl:T.txt,border:`1px solid ${toAcc===d.id?T.acl:T.border}`,borderRadius:8,padding:'7px 10px',fontSize:11,fontWeight:600,cursor:'pointer'}}>{d.icon} {d.label}</button>)}
              </div>
            </div>
            <input type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="금액 입력 (₩)" style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:14,fontFamily:'monospace',fontWeight:700,outline:'none',marginBottom:10}}/>
            <div style={{display:'flex',gap:5,marginBottom:12}}>
              {['10만','50만','100만','전액'].map(v=><button key={v} onClick={()=>setAmount(v==='전액'?'5240000':v==='10만'?'100000':v==='50만'?'500000':'1000000')} style={{flex:1,background:T.alt,color:T.sub,border:`1px solid ${T.border}`,borderRadius:6,padding:'5px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{v}</button>)}
            </div>
            {amount&&(
              <div style={{background:T.alt,borderRadius:8,padding:'10px 12px',marginBottom:12,border:`1px solid ${T.border}`}}>
                {[{l:'이체 금액',v:'₩'+fmt(+amount)},{l:'이체 수수료',v:'무료 (모의)'},{l:'처리 시간',v:'즉시~10분 (예상)'},{l:'최종 입금액',v:'₩'+fmt(+amount)}].map((r,i)=>(
                  <div key={i} style={{display:'flex',justifyContent:'space-between',marginBottom:i<3?4:0}}>
                    <span style={{color:T.muted,fontSize:11}}>{r.l}</span>
                    <span style={{color:T.txt,fontSize:11,fontWeight:700}}>{r.v}</span>
                  </div>
                ))}
              </div>
            )}
            <button onClick={()=>amount&&setShowConfirm(true)} style={{width:'100%',padding:'12px',background:amount?`linear-gradient(135deg,${T.acc},${T.prp})`:'#243A5E',color:'#fff',border:'none',borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer'}}>
              💸 이체 확인 (모의)
            </button>
          </Card>

          {/* Transaction history placeholder */}
          <Card style={{padding:'14px 16px'}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📋 이체 내역 (모의)</div>
            {[{t:'입금',from:'카카오뱅크',to:'Binance',amt:'₩1,000,000',stat:'완료',time:'2025-05-10'},{t:'입금',from:'신한은행',to:'Upbit',amt:'₩500,000',stat:'완료',time:'2025-05-08'}].map((h,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<1?`1px solid ${T.border}`:'none'}}>
                <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{h.from} → {h.to}</div><div style={{color:T.muted,fontSize:10}}>{h.time}</div></div>
                <div style={{textAlign:'right'}}><div style={{color:T.grn,fontSize:12,fontWeight:700}}>{h.amt}</div><Bdg c={T.grn} ch={h.stat} sm/></div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* ── OPEN BANKING TAB ── */}
      {tab==='openbanking'&&(
        <div>
          <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:12,padding:'12px 14px',marginBottom:14}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:11,marginBottom:4}}>⚠️ 오픈뱅킹 안내</div>
            <div style={{color:T.sub,fontSize:10,lineHeight:1.6}}>실제 오픈뱅킹 서비스는 금융당국 등록 및 API 계약 후 이용 가능합니다. 현재는 UI 플레이스홀더입니다.</div>
          </div>
          <div style={{display:'flex',gap:6,marginBottom:12}}>
            {(['accounts','deposit','withdraw'] as const).map(t=><button key={t} onClick={()=>setObTab(t)} style={{flex:1,padding:'8px',background:obTab===t?T.acg:'transparent',color:obTab===t?T.acl:T.muted,border:`1px solid ${obTab===t?T.acl:T.border}`,borderRadius:8,fontSize:11,fontWeight:700,cursor:'pointer'}}>{t==='accounts'?'계좌 목록':t==='deposit'?'입금':t==='withdraw'?'출금':t}</button>)}
          </div>
          {obTab==='accounts'&&(
            <div>
              <Card style={{padding:'14px 16px',marginBottom:12}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                  <div style={{color:T.txt,fontWeight:700}}>🏦 연결된 은행 계좌</div>
                  <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 계좌 추가</button>
                </div>
                {(Array.isArray(linkedBanks)?linkedBanks:[]).map((b,i)=>(
                  <div key={b.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<linkedBanks.length-1?`1px solid ${T.border}`:'none'}}>
                    <div style={{display:'flex',gap:8,alignItems:'center'}}>
                      <div style={{width:36,height:36,borderRadius:10,background:T.acg,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18}}>🏦</div>
                      <div><div style={{color:T.txt,fontSize:13,fontWeight:700}}>{b.bankName}</div><div style={{color:T.muted,fontSize:10}}>{b.accountNum} · {b.holder}</div></div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{color:T.txt,fontSize:13,fontWeight:700,fontFamily:'monospace'}}>{cvt(b.balance,currency)}</div>
                      {b.isMain&&<Bdg c={T.grn} ch="주계좌" sm/>}
                    </div>
                  </div>
                ))}
              </Card>
              <Card style={{padding:'14px 16px',border:`1px solid ${T.cyn}30`}}>
                <div style={{color:T.cyn,fontWeight:700,fontSize:12,marginBottom:8}}>💡 오픈뱅킹 등록 절차</div>
                {['금융결제원 오픈뱅킹 이용 동의','계좌 인증 (1원 인증)','출금 동의 (선택)','파이낸테크 이용번호 발급'].map((s,i)=>(
                  <div key={i} style={{display:'flex',gap:6,padding:'4px 0'}}><span style={{color:T.cyn,fontSize:11}}>{i+1}.</span><span style={{color:T.sub,fontSize:11}}>{s}</span></div>
                ))}
              </Card>
            </div>
          )}
          {obTab==='deposit'&&(
            <Card style={{padding:'14px 16px'}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📥 가상계좌 입금</div>
              <div style={{background:T.alt,borderRadius:10,padding:'14px',marginBottom:12,border:`1px solid ${T.border}`}}>
                <div style={{color:T.muted,fontSize:10,marginBottom:4}}>Binance 가상계좌 (모의)</div>
                <div style={{color:T.txt,fontWeight:900,fontSize:16,fontFamily:'monospace'}}>신한은행 110-123-456789</div>
                <div style={{color:T.muted,fontSize:10,marginTop:4}}>예금주: BINANCE KOREA (주) · 유효기간: 24시간</div>
              </div>
              <div style={{color:T.muted,fontSize:11,lineHeight:1.7}}><div style={{fontWeight:700,color:T.txt,marginBottom:4}}>입금 방법</div>1. 위 가상계좌로 이체<br/>2. 자동으로 잔고 반영 (즉시~10분)<br/>3. 원화 그대로 보관 후 거래 가능</div>
            </Card>
          )}
          {obTab==='withdraw'&&(
            <Card style={{padding:'14px 16px'}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📤 출금 신청 (모의)</div>
              <div style={{background:T.red+'12',border:`1px solid ${T.red}30`,borderRadius:8,padding:'10px 12px',marginBottom:12}}>
                <div style={{color:T.red,fontWeight:700,fontSize:11}}>⚠️ 출금 보안 안내</div>
                <div style={{color:T.sub,fontSize:10,marginTop:2}}>실제 출금은 본인 인증 및 24시간 지연 정책이 적용됩니다.</div>
              </div>
              <div style={{color:T.muted,fontSize:12,textAlign:'center',padding:'20px 0'}}>출금 기능은 오픈뱅킹 연동 후 활성화됩니다.</div>
            </Card>
          )}
        </div>
      )}

      {/* ── FX TAB ── */}
      {tab==='fx'&&(
        <div>
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>💱 환전 계산기</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:5,marginBottom:12}}>
              {FX_PAIRS.map((p,i)=>(
                <button key={i} onClick={()=>setFxPair(p)} style={{background:fxPair===p?T.acg:T.alt,border:`1px solid ${fxPair===p?T.acl:T.border}`,borderRadius:8,padding:'8px 4px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:11,color:fxPair===p?T.acl:T.txt}}>{p.flag1}{p.flag2}</div>
                  <div style={{fontSize:10,color:fxPair===p?T.acl:T.muted,fontWeight:700}}>{p.from}/{p.to}</div>
                </button>
              ))}
            </div>
            <div style={{background:T.alt,borderRadius:10,padding:'12px 14px',marginBottom:10,border:`1px solid ${T.border}`}}>
              <div style={{color:T.muted,fontSize:10,marginBottom:4}}>현재 환율</div>
              <div style={{color:T.txt,fontSize:18,fontWeight:900,fontFamily:'monospace'}}>1 {fxPair.from} = {fxPair.rate.toFixed(4)} {fxPair.to}</div>
              <div style={{color:T.muted,fontSize:10,marginTop:2}}>수수료 {fxPair.fee}% · 실시간 (모의)</div>
            </div>
            <div style={{marginBottom:10}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:4}}>환전 금액 ({fxPair.from})</div>
              <input type="number" value={fxAmount} onChange={e=>setFxAmount(e.target.value)} placeholder={`금액 입력 (${fxPair.from})`} style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:14,fontFamily:'monospace',fontWeight:700,outline:'none'}}/>
            </div>
            {fxAmount&&(
              <div style={{background:T.acg,border:`1px solid ${T.acl}30`,borderRadius:10,padding:'12px 14px',marginBottom:12}}>
                <div style={{color:T.muted,fontSize:10,marginBottom:4}}>환전 후 ({fxPair.to})</div>
                <div style={{color:T.acl,fontSize:22,fontWeight:900,fontFamily:'monospace'}}>{Number(fxConverted).toLocaleString()} {fxPair.to}</div>
                <div style={{color:T.muted,fontSize:10,marginTop:4}}>수수료: {fxFee} {fxPair.from} ({fxPair.fee}%)</div>
              </div>
            )}
            <button style={{width:'100%',padding:'12px',background:fxAmount?`linear-gradient(135deg,${T.acc},${T.prp})`:'#243A5E',color:'#fff',border:'none',borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer'}}>
              💱 환전 실행 (모의 — 실제 환전 미실행)
            </button>
          </Card>

          {/* PG Placeholders */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>💳 간편결제 (준비중)</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {[{name:'토스페이',icon:'💙',color:'#0070F3'},{name:'네이버페이',icon:'🟢',color:'#03C75A'},{name:'카카오페이',icon:'🟡',color:'#FFCD00'}].map(p=>(
                <div key={p.name} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:12,padding:'14px 8px',textAlign:'center'}}>
                  <div style={{fontSize:24,marginBottom:4}}>{p.icon}</div>
                  <div style={{color:T.txt,fontSize:11,fontWeight:700}}>{p.name}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:3}}>준비중</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── GUIDE TAB ── */}
      {tab==='guide'&&(
        <div>
          {EXCHANGE_FUNDING.map((ex,idx)=>(
            <Card key={idx} style={{padding:'14px 16px',marginBottom:10}}>
              <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:10}}>
                <span style={{fontSize:20}}>{ex.icon}</span>
                <div style={{color:T.txt,fontWeight:700,fontSize:14}}>{ex.exchange} 입금 가이드</div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
                {[{l:'입금 처리시간',v:ex.depositTime},{l:'출금 처리시간',v:ex.withdrawTime},{l:'입금 수수료',v:ex.depositFee},{l:'출금 수수료',v:ex.withdrawFee}].map(r=>(
                  <div key={r.l} style={{background:T.alt,borderRadius:8,padding:'8px 10px'}}>
                    <div style={{color:T.muted,fontSize:9}}>{r.l}</div>
                    <div style={{color:T.txt,fontSize:11,fontWeight:700,marginTop:2}}>{r.v}</div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.ylw}30`}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:12,marginBottom:8}}>⚠️ 책임 안내</div>
            {['TRAIGO는 사용자 자금을 직접 보관하지 않습니다','사용자가 직접 거래소/증권사 계정에 입출금합니다','API 키를 통한 거래는 사용자 본인의 책임입니다','플랫폼 운영자는 API 파트너 계약을 통해 기능을 제공합니다','API Secret은 절대 프론트엔드에 노출되지 않습니다'].map((t,i)=>(
              <div key={i} style={{display:'flex',gap:6,padding:'4px 0'}}><span style={{color:T.ylw,flexShrink:0}}>•</span><span style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{t}</span></div>
            ))}
          </Card>
        </div>
      )}

      {/* Confirm modal */}
      {showConfirm&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200,touchAction:'none'}} onClick={()=>setShowConfirm(false)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px calc(40px + env(safe-area-inset-bottom, 0px))',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:T.txt,fontWeight:800,fontSize:16,marginBottom:14}}>💸 이체 확인 (모의)</div>
            <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'10px 12px',marginBottom:14}}>
              <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>⚠️ 현재는 모의 이체입니다</div>
              <div style={{color:T.sub,fontSize:10,marginTop:2}}>실제 자금이 이동하지 않습니다. 오픈뱅킹 연동 후 실제 이체가 가능합니다.</div>
            </div>
            {[{l:'출금 계좌',v:'카카오뱅크 ****1234'},{l:'입금 대상',v:DESTS.find(d=>d.id===toAcc)?.label||toAcc},{l:'이체 금액',v:'₩'+fmt(+amount)},{l:'수수료',v:'무료 (모의)'},{l:'예상 처리',v:'즉시'}].map((r,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:`1px solid ${T.border}`}}><span style={{color:T.muted,fontSize:13}}>{r.l}</span><span style={{color:T.txt,fontWeight:700,fontSize:13}}>{r.v}</span></div>
            ))}
            <div style={{display:'flex',gap:10,marginTop:16}}>
              <button onClick={()=>setShowConfirm(false)} style={{flex:1,padding:'13px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>setShowConfirm(false)} style={{flex:2,padding:'13px',background:`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:13,cursor:'pointer'}}>✅ 모의 이체 확인</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}


/* ── TradFi Page (코인거래소 TradFi + 글로벌 자산 CFD) ── */
type ProductType = 'spot'|'futures'|'cfd'|'tokenized'|'index'|'commodity'|'forex'|'watchonly';
type TradFiProvider = 'gate'|'bybit'|'binance'|'bitget'|'etoro'|'watchonly';

interface TradFiAsset {
  id:string; nameKr:string; name:string; sym:string;
  category:'stock_cfd'|'index'|'commodity'|'forex';
  productType:ProductType; providers:TradFiProvider[];
  p:number; c:number; clr:string; overnight:string;
  maxLev:number; isWatchOnly:boolean;
}

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



export default FundingPage;