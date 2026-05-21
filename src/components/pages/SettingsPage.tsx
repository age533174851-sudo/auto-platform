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


function SettingsPage({lang,setLang,currency,setCurrency}:{lang:string;setLang:(l:string)=>void;currency:string;setCurrency:(c:string)=>void}) {
  const [tab,setTab]=useState<'general'|'security'|'pro'|'legal'>('general');
  const [notif,setNotif]=useState({trade:true,profit:true,news:false,alert:true,leverage:true});
  const [sec,setSec]=useState({twoFa:true,bio:true,lock:false,sessionAlert:true});
  const [apiKeys]=useState([{id:1,name:'API Key #1',created:'2025-01-15',lastUsed:'2025-05-10',active:true}]);
  const [userRole,setUserRole]=useState<string|null>(null);
  const isAdminUser = userRole === 'admin';
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        const {getSupabaseClient}=await import('@/lib/supabase/client');
        const sb=getSupabaseClient();
        if(!sb) return;
        const {data:{user}}=await sb.auth.getUser();
        if(!user||cancelled) return;
        const {data:profile}=await sb.from('profiles').select('role').eq('id',user.id).single();
        if(!cancelled&&profile?.role) setUserRole(profile.role);
      }catch{}
    })();
    return()=>{cancelled=true;};
  },[]);

  return (
    <div>
      <div style={{display:'flex',gap:6,marginBottom:14,overflowX:'auto'}}>
        {(['general','security','pro','legal'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flexShrink:0,padding:'7px 12px',background:tab===t?T.acg:'transparent',color:tab===t?T.acl:T.muted,border:`1px solid ${tab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {t==='general'?'⚙️ 일반':t==='security'?'🔒 보안':t==='pro'?'💎 Pro':'⚖️ 법적'}
          </button>
        ))}
      </div>

      {tab==='general'&&(
        <div>
          {/* Profile */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
              <div style={{width:52,height:52,borderRadius:15,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:24}}>👤</div>
              <div>
                <div style={{color:T.txt,fontWeight:800,fontSize:15}}>투자자님</div>
                <div style={{color:T.muted,fontSize:11}}>mock 모드 · 모의투자 전용</div>
                <div style={{marginTop:4,display:'flex',gap:6}}>
                  <Bdg c={T.gld} ch="무료 플랜"/>
                  <Bdg c={T.grn} ch="모의투자"/>
                </div>
              </div>
            </div>
            <div style={{display:'flex',gap:8}}>
              <a href="/auth" style={{flex:1,padding:'9px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer',textDecoration:'none',textAlign:'center'}}>🔐 로그인/회원가입</a>
              {isAdminUser&&<a href="/admin" style={{padding:'9px 14px',background:'rgba(16,185,129,0.1)',color:'#10B981',border:'1px solid rgba(16,185,129,0.3)',borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer',textDecoration:'none'}}>🛡️ 관리자</a>}
            </div>
          </Card>

          {/* Language */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🌍 언어</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:7}}>
              {LANGS.map(l=>(
                <button key={l.id} onClick={()=>setLang(l.id)} style={{background:lang===l.id?T.acg:'transparent',color:lang===l.id?T.acl:T.txt,border:`1px solid ${lang===l.id?T.acl:T.border}`,borderRadius:10,padding:'8px 4px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:18}}>{l.flag}</div>
                  <div style={{fontSize:10,fontWeight:600,marginTop:3}}>{l.name}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Currency */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>💱 기본 통화</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
              {Object.entries(CURRENCIES).map(([code,cur])=>(
                <button key={code} onClick={()=>setCurrency(code)} style={{background:currency===code?T.acg:'transparent',color:currency===code?T.acl:T.txt,border:`1px solid ${currency===code?T.acl:T.border}`,borderRadius:10,padding:'8px 4px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{fontSize:14}}>{cur.flag}</div>
                  <div style={{fontSize:11,fontWeight:700}}>{cur.symbol}</div>
                  <div style={{fontSize:9,color:T.muted}}>{code}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Notifications */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔔 알림 설정</div>
            {[{k:'trade',l:'매매 완료'},{k:'profit',l:'수익 목표'},{k:'news',l:'시장 뉴스'},{k:'alert',l:'가격 알림'},{k:'leverage',l:'레버리지 경고'}].map((n,i,arr)=>(
              <div key={n.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{n.l}</span>
                <Toggle on={notif[n.k as keyof typeof notif]} onChange={v=>setNotif(p=>({...p,[n.k]:v}))}/>
              </div>
            ))}
          </Card>

          {/* Risk Profile */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🎯 위험 성향 설정</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {[{v:'conservative',l:'보수형',d:'안전 우선',c:T.grn},{v:'balanced',l:'균형형',d:'균형 추구',c:T.ylw},{v:'aggressive',l:'공격형',d:'수익 우선',c:T.red}].map(p=>(
                <button key={p.v} style={{background:T.alt,border:`1px solid ${p.c}40`,borderRadius:12,padding:'12px 6px',cursor:'pointer',textAlign:'center'}}>
                  <div style={{color:p.c,fontSize:18,marginBottom:4}}>{'보수형'===p.l?'🛡️':'균형형'===p.l?'⚖️':'🔥'}</div>
                  <div style={{color:T.txt,fontWeight:700,fontSize:11}}>{p.l}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:2}}>{p.d}</div>
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab==='security'&&(
        <div>
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔒 보안 설정</div>
            {[{k:'twoFa',l:'2단계 인증 (2FA)',d:'Google Authenticator 사용'},{k:'bio',l:'생체인식 로그인',d:'Face ID / Touch ID'},{k:'lock',l:'자동 잠금 5분',d:'비활동 시 자동 잠금'},{k:'sessionAlert',l:'새 로그인 알림',d:'새 기기 로그인 시 알림'}].map((s,i,arr)=>(
              <div key={s.k} style={{padding:'10px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{s.l}</div><div style={{color:T.muted,fontSize:10}}>{s.d}</div></div>
                  <Toggle on={sec[s.k as keyof typeof sec]} onChange={v=>setSec(p=>({...p,[s.k]:v}))}/>
                </div>
              </div>
            ))}
          </Card>

          {/* API Keys */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700}}>🔑 API 키 관리</div>
              <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 생성</button>
            </div>
            {apiKeys.map(k=>(
              <div key={k.id} style={{background:T.alt,borderRadius:10,padding:'10px 12px',marginBottom:8}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{k.name}</div><div style={{color:T.muted,fontSize:10}}>생성: {k.created} · 최근: {k.lastUsed}</div></div>
                  <div style={{display:'flex',gap:6,alignItems:'center'}}><Bdg c={T.grn} ch="활성"/><button style={{background:T.red+'15',color:T.red,border:'none',borderRadius:6,padding:'3px 7px',fontSize:10,cursor:'pointer'}}>삭제</button></div>
                </div>
              </div>
            ))}
            <div style={{color:T.muted,fontSize:10,marginTop:6}}>⚠️ API 키는 절대 타인과 공유하지 마세요</div>
          </Card>

          {/* Login history */}
          <Card style={{padding:16}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📋 로그인 기록</div>
            {[{device:'iPhone 15 Pro',loc:'서울, 대한민국',time:'2025-05-13 09:24',current:true},{device:'MacBook Pro',loc:'서울, 대한민국',time:'2025-05-12 18:30',current:false}].map((l,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<1?`1px solid ${T.border}`:'none'}}>
                <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{l.device} {l.current&&<Bdg c={T.grn} ch="현재"/>}</div><div style={{color:T.muted,fontSize:10}}>{l.loc} · {l.time}</div></div>
                {!l.current&&<button style={{background:T.red+'15',color:T.red,border:'none',borderRadius:6,padding:'3px 7px',fontSize:10,cursor:'pointer'}}>종료</button>}
              </div>
            ))}
          </Card>
        </div>
      )}

      {tab==='pro'&&(
        <div>
          {/* Pro plans */}
          <Card style={{padding:16,marginBottom:12,border:`1px solid ${T.gld}40`}}>
            <div style={{textAlign:'center',marginBottom:16}}>
              <div style={{fontSize:32,marginBottom:6}}>💎</div>
              <div style={{color:T.txt,fontWeight:900,fontSize:18}}>TRAIGO Pro</div>
              <div style={{color:T.muted,fontSize:12}}>프로 트레이더를 위한 완전한 도구</div>
            </div>
            {[
              {l:'AI 무제한 분석',v:'월 10회 → 무제한',c:T.grn},
              {l:'고급 레버리지 도구',v:'최대 100배 접근',c:T.grn},
              {l:'AI 매매 신호',v:'실시간 알림',c:T.grn},
              {l:'전략 마켓플레이스',v:'프리미엄 전략 접근',c:T.grn},
              {l:'우선 고객 지원',v:'24/7 전담 지원',c:T.grn},
            ].map((f,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:i<4?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{f.l}</span>
                <span style={{color:f.c,fontSize:11,fontWeight:700}}>✅ {f.v}</span>
              </div>
            ))}
            <div style={{marginTop:16,textAlign:'center'}}>
              <button style={{width:'100%',padding:'14px',background:`linear-gradient(135deg,${T.gld},#B45309)`,color:'#fff',border:'none',borderRadius:14,fontWeight:900,fontSize:15,cursor:'pointer'}}>
                💎 Pro 구독 (준비중)
              </button>
              <div style={{color:T.muted,fontSize:10,marginTop:6}}>베타 기간 무료 · 향후 월 ₩29,900</div>
            </div>
          </Card>

          {/* Strategy Marketplace */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🏪 전략 마켓플레이스</div>
            {[
              {name:'프리미엄 EMA 전략',creator:'@toptrader',win:'74%',price:'무료',rating:'4.8'},
              {name:'AI 선물 전략',creator:'@aiquant',win:'68%',price:'₩9,900/월',rating:'4.6'},
              {name:'DCA 마스터',creator:'@longterm',win:'82%',price:'무료',rating:'4.9'},
            ].map((s,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<2?`1px solid ${T.border}`:'none'}}>
                <div>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{s.name}</div>
                  <div style={{display:'flex',gap:6,marginTop:2}}><span style={{color:T.muted,fontSize:10}}>{s.creator}</span><span style={{color:T.grn,fontSize:10}}>승률 {s.win}</span><span style={{color:T.ylw,fontSize:10}}>⭐{s.rating}</span></div>
                </div>
                <button style={{background:s.price==='무료'?T.grn+'15':T.ylw+'15',color:s.price==='무료'?T.grn:T.ylw,border:`1px solid ${s.price==='무료'?T.grn:T.ylw}30`,borderRadius:8,padding:'5px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{s.price}</button>
              </div>
            ))}
          </Card>

          {/* Referral */}
          <Card style={{padding:16}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:8}}>🎁 친구 초대</div>
            <div style={{color:T.muted,fontSize:11,marginBottom:10}}>친구를 초대하면 Pro 1개월을 무료로 받을 수 있습니다.</div>
            <div style={{display:'flex',gap:8}}>
              <input value="traigo.app/ref/MYCODE" readOnly style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.sub,fontSize:11,outline:'none'}}/>
              <button style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'8px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>복사</button>
            </div>
          </Card>
        </div>
      )}

      {tab==='legal'&&(
        <div>
          <Card style={{padding:16,marginBottom:12,border:`1px solid ${T.ylw}30`}}>
            <div style={{color:T.ylw,fontWeight:800,fontSize:13,marginBottom:10}}>⚠️ 중요 법적 고지</div>
            {['TRAIGO는 교육·시뮬레이션 목적의 모의투자 플랫폼입니다','실제 금융 거래를 실행하지 않습니다','수익을 보장하지 않으며 모든 투자 손실은 투자자 본인의 책임입니다','레버리지 거래는 원금 초과 손실이 발생할 수 있습니다','표시되는 시세는 참고용이며 지연될 수 있습니다'].map((t,i,arr)=>(
              <div key={i} style={{display:'flex',gap:6,padding:'5px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.ylw,fontSize:11,flexShrink:0}}>•</span>
                <span style={{color:T.sub,fontSize:11,lineHeight:1.5}}>{t}</span>
              </div>
            ))}
          </Card>
          <Card style={{padding:16}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📄 법적 문서</div>
            {[{l:'이용약관',href:'/terms'},{l:'개인정보처리방침',href:'/privacy'},{l:'투자 위험 고지',href:'/terms'},{l:'FAQ / 도움말',href:'/terms'}].map((l,i,arr)=>(
              <a key={i} href={l.href} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none',textDecoration:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{l.l}</span>
                <span style={{color:T.muted,fontSize:14}}>›</span>
              </a>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
/* ── SocialPage ── */


export default SettingsPage;