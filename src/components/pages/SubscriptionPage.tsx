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


const PLAN_INFO: Record<PlanType,{label:string;color:string;icon:string;price:string;features:string[]}> = {
  free:     {label:'무료',     color:'#94A3B8',icon:'🆓',price:'₩0',         features:['모의매매','기본 차트','15개 종목 왓치']},
  pro:      {label:'Pro',     color:'#3B82F6',icon:'⚡',price:'₩9,900/월',   features:['모든 무료 기능','무제한 왓치리스트','AI 분석 50회/월','실시간 알림']},
  premium:  {label:'Premium', color:'#7C3AED',icon:'💎',price:'₩29,900/월',  features:['모든 Pro 기능','AI 무제한','TradFi CFD','고급 백테스트']},
  lifetime: {label:'평생회원', color:'#F59E0B',icon:'♾️',price:'₩299,000 1회',features:['모든 Premium 기능','평생 이용','업그레이드 무료','우선 지원']},
  founder:  {label:'창업멤버', color:'#EF4444',icon:'🚀',price:'초대 전용',   features:['모든 기능','창업멤버 배지','영구 Premium','운영 참여']},
  admin:    {label:'관리자',   color:'#10B981',icon:'🛡️',price:'내부',        features:['전체 권한','사용자 관리','시스템 접근','코드 생성']},
};

const BADGE_INFO: Record<BadgeType,{label:string;color:string;icon:string}> = {
  vip:       {label:'VIP',     color:'#F59E0B',icon:'⭐'},
  founder:   {label:'창업멤버',color:'#EF4444',icon:'🚀'},
  supporter: {label:'서포터',  color:'#7C3AED',icon:'💜'},
  lifetime:  {label:'평생회원',color:'#F59E0B',icon:'♾️'},
  admin:     {label:'관리자',  color:'#10B981',icon:'🛡️'},
  early_bird:{label:'얼리버드',color:'#0891B2',icon:'🐦'},
};

// ── Mock data ─────────────────────────────────────────────────
const MOCK_CURRENT_USER: UserSubscription = {
  userId: 'usr_me',
  planType: 'pro',
  status: 'active',
  expiresAt: '2025-12-31',
  grantedBy: null,
  createdAt: '2025-01-15',
  badges: ['early_bird'],
};

const MOCK_USERS_ADMIN: (UserSubscription & {email:string;name:string})[] = [
  {userId:'usr_1',email:'kim@test.com',name:'김민준',planType:'lifetime',status:'active',expiresAt:null,grantedBy:'admin',createdAt:'2024-12-01',badges:['lifetime','vip']},
  {userId:'usr_2',email:'lee@test.com',name:'이서연',planType:'founder',status:'active',expiresAt:null,grantedBy:'admin',createdAt:'2024-11-15',badges:['founder','vip']},
  {userId:'usr_3',email:'park@test.com',name:'박지호',planType:'pro',status:'active',expiresAt:'2025-08-30',grantedBy:null,createdAt:'2025-02-01',badges:[]},
  {userId:'usr_4',email:'choi@test.com',name:'최유진',planType:'free',status:'active',expiresAt:null,grantedBy:null,createdAt:'2025-03-10',badges:['early_bird']},
  {userId:'usr_5',email:'jung@test.com',name:'정수민',planType:'premium',status:'active',expiresAt:'2025-07-31',grantedBy:null,createdAt:'2025-01-20',badges:['supporter']},
];

const MOCK_INVITE_CODES: InviteCode[] = [
  {id:'ic1',code:'TRAIGO-FOUNDER-2025',planType:'founder',usesMax:10,usesCount:2,createdBy:'admin',createdAt:'2024-11-01',expiresAt:null,note:'창업멤버 코드',active:true},
  {id:'ic2',code:'LIFETIME-VIP-AAA',planType:'lifetime',usesMax:1,usesCount:0,createdBy:'admin',createdAt:'2025-01-10',expiresAt:'2025-12-31',note:'개인 발급',active:true},
  {id:'ic3',code:'PRO-FRIEND-XYZ',planType:'pro',usesMax:null,usesCount:14,createdBy:'admin',createdAt:'2025-02-01',expiresAt:null,note:'친구 초대 - 무제한',active:true},
  {id:'ic4',code:'BETA-TESTER-001',planType:'pro',usesMax:50,usesCount:50,createdBy:'admin',createdAt:'2024-10-01',expiresAt:'2025-01-01',note:'베타 테스터용 (만료)',active:false},
];

/* ── Badge component ── */
function PlanBadge({plan,size='sm'}:{plan:PlanType;size?:'sm'|'md'|'lg'}) {
  const info = PLAN_INFO[plan];
  const sizes = {sm:{fontSize:10,padding:'2px 7px',borderRadius:99},md:{fontSize:12,padding:'4px 10px',borderRadius:12},lg:{fontSize:14,padding:'6px 14px',borderRadius:14}};
  const s = sizes[size];
  return (
    <span style={{background:info.color+'20',color:info.color,fontSize:s.fontSize,fontWeight:700,padding:s.padding,borderRadius:s.borderRadius,border:`1px solid ${info.color}40`,display:'inline-flex',alignItems:'center',gap:4,whiteSpace:'nowrap'}}>
      {info.icon} {info.label}
    </span>
  );
}

function UserBadge({badge}:{badge:BadgeType;[key:string]:any}) {
  const info = BADGE_INFO[badge];
  return (
    <span style={{background:info.color+'20',color:info.color,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:99,border:`1px solid ${info.color}40`,display:'inline-flex',alignItems:'center',gap:3}}>
      {info.icon} {info.label}
    </span>
  );
}

/* ── SubscriptionPage ── */

function SubscriptionPage() {
  const [tab, setTab] = useState<'myplan'|'plans'|'redeem'|'admin'>('myplan');
  const [sub, setSub] = useState<UserSubscription>(MOCK_CURRENT_USER);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemStatus, setRedeemStatus] = useState<string|null>(null);
  const [redeemLoading, setRedeemLoading] = useState(false);

  // Admin state
  const [adminUsers, setAdminUsers] = useState(MOCK_USERS_ADMIN);
  const [inviteCodes, setInviteCodes] = useState(MOCK_INVITE_CODES);
  const [adminTab, setAdminTab] = useState<'users'|'codes'|'stats'>('users');
  const [newCode, setNewCode] = useState({code:'',plan:'pro' as PlanType,usesMax:'1',note:'',expiresAt:''});
  const [grantModal, setGrantModal] = useState<{userId:string;name:string}|null>(null);
  const [grantPlan, setGrantPlan] = useState<PlanType>('lifetime');
  const [showCreateCode, setShowCreateCode] = useState(false);

  const isLifetime = sub.planType==='lifetime'||sub.planType==='founder'||sub.planType==='admin';
  const isAdmin = sub.planType==='admin';

  const handleRedeem = () => {
    if (!redeemCode.trim()) return;
    setRedeemLoading(true); setRedeemStatus(null);
    setTimeout(() => {
      const found = MOCK_INVITE_CODES.find(c => c.code.toUpperCase()===redeemCode.toUpperCase() && c.active);
      if (found) {
        setSub(p => ({...p, planType:found.planType, status:'active', expiresAt:null, inviteCode:found.code,
          badges: found.planType==='founder' ? [...p.badges,'founder','vip'] : found.planType==='lifetime' ? [...p.badges,'lifetime','vip'] : p.badges}));
        setRedeemStatus('success:' + found.planType);
      } else {
        setRedeemStatus('error');
      }
      setRedeemLoading(false);
    }, 900);
  };

  const handleGrant = (userId:string, plan:PlanType) => {
    setAdminUsers(prev => prev.map(u => u.userId===userId ? {
      ...u, planType:plan, status:'active', expiresAt:null, grantedBy:'admin',
      badges: plan==='founder' ? [...u.badges.filter(b=>b!=='founder'),'founder','vip'] :
              plan==='lifetime' ? [...u.badges.filter(b=>b!=='lifetime'),'lifetime','vip'] : u.badges
    } : u));
    setGrantModal(null);
  };

  const handleCreateCode = () => {
    const code: InviteCode = {
      id: 'ic'+Date.now(), code:newCode.code.toUpperCase(), planType:newCode.plan,
      usesMax: newCode.usesMax==='unlimited' ? null : +newCode.usesMax,
      usesCount:0, createdBy:'admin', createdAt:new Date().toISOString().split('T')[0],
      expiresAt: newCode.expiresAt||null, note:newCode.note, active:true,
    };
    setInviteCodes(prev=>[code,...prev]);
    setNewCode({code:'',plan:'pro',usesMax:'1',note:'',expiresAt:''});
    setShowCreateCode(false);
  };

  return (
    <div>
      {/* Tabs */}
      <div style={{display:'flex',gap:6,marginBottom:14,overflowX:'auto'}}>
        {([
          ['myplan','💳 내 플랜'],
          ['plans','📋 요금제'],
          ['redeem','🎟️ 코드 입력'],
          ...(isAdmin ? [['admin','🛡️ 관리자'] as const] : []),
        ] as [string,string][]).map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id as any)} style={{flexShrink:0,padding:'8px 12px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>{label}</button>
        ))}
      </div>

      {/* ── MY PLAN ── */}
      {tab==='myplan'&&(
        <div>
          {/* Current plan card */}
          <div style={{background:`linear-gradient(135deg,${PLAN_INFO[sub.planType].color}18,${PLAN_INFO[sub.planType].color}08)`,border:`1px solid ${PLAN_INFO[sub.planType].color}40`,borderRadius:20,padding:'22px 18px',marginBottom:14}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12}}>
              <div>
                <div style={{color:T.muted,fontSize:11,marginBottom:4}}>현재 플랜</div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:28}}>{PLAN_INFO[sub.planType].icon}</span>
                  <div>
                    <div style={{color:T.txt,fontWeight:900,fontSize:20}}>{PLAN_INFO[sub.planType].label}</div>
                    {isLifetime && <div style={{color:PLAN_INFO[sub.planType].color,fontSize:11,fontWeight:700}}>♾️ 만료 없음 · 평생 이용</div>}
                    {!isLifetime && sub.expiresAt && <div style={{color:T.muted,fontSize:11}}>만료: {sub.expiresAt}</div>}
                  </div>
                </div>
              </div>
              <PlanBadge plan={sub.planType} size="md"/>
            </div>
            {/* Badges */}
            {sub.badges.length>0&&(
              <div style={{display:'flex',gap:5,flexWrap:'wrap',marginBottom:10}}>
                {(Array.isArray(sub.badges) ? sub.badges : []).map(b=><UserBadge key={b} badge={b}/>)}
              </div>
            )}
            {/* Features */}
            <div style={{display:'flex',flexDirection:'column',gap:4}}>
              {PLAN_INFO[sub.planType].features.map(f=>(
                <div key={f} style={{display:'flex',gap:6,alignItems:'center'}}>
                  <span style={{color:PLAN_INFO[sub.planType].color,fontSize:11}}>✅</span>
                  <span style={{color:T.sub,fontSize:11}}>{f}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Quick actions */}
          <div className="mobile-1col" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}}>
            <button onClick={()=>setTab('plans')} style={{background:T.acg,border:`1px solid ${T.acl}40`,borderRadius:12,padding:'12px',color:T.acl,fontWeight:700,fontSize:12,cursor:'pointer'}}>📋 요금제 비교</button>
            <button onClick={()=>setTab('redeem')} style={{background:T.prp+'15',border:`1px solid ${T.prp}40`,borderRadius:12,padding:'12px',color:T.prp,fontWeight:700,fontSize:12,cursor:'pointer'}}>🎟️ 초대 코드 입력</button>
          </div>

          {/* Subscription info */}
          <Card style={{padding:'14px 16px',marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>구독 정보</div>
            {[
              {l:'플랜',v:<PlanBadge plan={sub.planType} size="sm"/>},
              {l:'상태',v:<Bdg c={sub.status==='active'?T.grn:T.red} ch={sub.status==='active'?'활성':'만료'}/>},
              {l:'만료일',v:<span style={{color:T.txt,fontSize:12}}>{isLifetime?'♾️ 평생':sub.expiresAt||'-'}</span>},
              {l:'가입일',v:<span style={{color:T.muted,fontSize:12}}>{sub.createdAt}</span>},
              {l:'관리자 부여',v:<span style={{color:T.muted,fontSize:12}}>{sub.grantedBy?'예 (관리자)':'아니오'}</span>},
              {l:'초대 코드',v:<span style={{color:T.muted,fontSize:12,fontFamily:'monospace'}}>{sub.inviteCode||'-'}</span>},
            ].map((r,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<5?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.muted,fontSize:12}}>{r.l}</span>
                {r.v}
              </div>
            ))}
          </Card>

          {/* Payment placeholder */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.ylw}30`}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:12,marginBottom:8}}>💳 결제 수단</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6,marginBottom:10}}>실제 결제 기능은 준비 중입니다. 현재는 초대 코드 또는 관리자 부여로만 유료 플랜을 이용할 수 있습니다.</div>
            <div style={{display:'flex',gap:6}}>
              {['토스페이','카카오페이','카드결제'].map(p=>(
                <div key={p} style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 6px',textAlign:'center'}}>
                  <div style={{color:T.muted,fontSize:10,fontWeight:600}}>{p}</div>
                  <div style={{color:T.muted,fontSize:9,marginTop:2}}>준비중</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── PLANS ── */}
      {tab==='plans'&&(
        <div>
          <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:4}}>요금제 비교</div>
          <div style={{color:T.muted,fontSize:11,marginBottom:14}}>⚠️ 실제 결제 미구현 · 초대 코드 또는 관리자 부여</div>
          {(Object.entries(PLAN_INFO) as [PlanType,any][]).map(([key,info])=>(
            <div key={key} style={{background:sub.planType===key?info.color+'12':T.card,border:`2px solid ${sub.planType===key?info.color:T.border}`,borderRadius:16,padding:'16px',marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:22}}>{info.icon}</span>
                  <div>
                    <div style={{color:T.txt,fontWeight:800,fontSize:14}}>{info.label}</div>
                    <div style={{color:info.color,fontWeight:700,fontSize:12}}>{info.price}</div>
                  </div>
                </div>
                {sub.planType===key
                  ? <Bdg c={T.grn} ch="현재 플랜"/>
                  : key==='founder'||key==='admin'
                    ? <Bdg c={T.muted} ch="초대 전용"/>
                    : <button type="button"
                        onClick={() => alert('Pro 구독은 베타 종료 후 출시 예정입니다. 베타 기간 모든 기능 무료!')}
                        style={{background:info.color+'20',color:info.color,border:`1px solid ${info.color}40`,borderRadius:10,padding:'8px 14px',minHeight:36,fontSize:11,fontWeight:700,cursor:'pointer'}}>업그레이드 (준비중)</button>
                }
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:3}}>
                {(Array.isArray(info.features) ? info.features : []).map((f:string)=>(
                  <div key={f} style={{display:'flex',gap:6,alignItems:'center'}}>
                    <span style={{color:info.color,fontSize:11}}>✅</span>
                    <span style={{color:T.sub,fontSize:11}}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── REDEEM ── */}
      {tab==='redeem'&&(
        <div>
          <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:4}}>🎟️ 초대 코드 입력</div>
          <div style={{color:T.muted,fontSize:11,marginBottom:14}}>초대 코드를 입력하면 플랜이 즉시 활성화됩니다.</div>
          <Card style={{padding:'14px 16px',marginBottom:14}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>코드 입력</div>
            <div style={{display:'flex',gap:8,marginBottom:8}}>
              <input
                value={redeemCode}
                onChange={e=>setRedeemCode(e.target.value.toUpperCase())}
                onKeyDown={e=>e.key==='Enter'&&handleRedeem()}
                placeholder="예: TRAIGO-FOUNDER-2025"
                style={{flex:1,background:T.alt,border:`1px solid ${T.border2}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:13,fontFamily:'monospace',fontWeight:700,outline:'none',letterSpacing:1}}
              />
              <button onClick={handleRedeem} disabled={redeemLoading||!redeemCode.trim()} style={{background:T.acc,color:'#fff',border:'none',borderRadius:10,padding:'0 18px',fontWeight:700,fontSize:13,cursor:'pointer'}}>
                {redeemLoading?'확인중…':'적용'}
              </button>
            </div>
            {redeemStatus?.startsWith('success:')&&(
              <div style={{background:T.grn+'15',border:`1px solid ${T.grn}40`,borderRadius:10,padding:'12px 14px'}}>
                <div style={{color:T.grn,fontWeight:700,fontSize:13,marginBottom:4}}>✅ 코드 적용 완료!</div>
                <div style={{color:T.sub,fontSize:11}}>
                  {PLAN_INFO[redeemStatus.split(':')[1] as PlanType]?.label} 플랜이 활성화되었습니다.
                  {(redeemStatus.includes('lifetime')||redeemStatus.includes('founder'))&&' 평생 이용 가능합니다.'}
                </div>
              </div>
            )}
            {redeemStatus==='error'&&(
              <div style={{background:T.red+'15',border:`1px solid ${T.red}40`,borderRadius:10,padding:'12px 14px'}}>
                <div style={{color:T.red,fontWeight:700,fontSize:12}}>❌ 유효하지 않은 코드입니다</div>
                <div style={{color:T.muted,fontSize:10,marginTop:3}}>코드를 다시 확인하거나 관리자에게 문의하세요.</div>
              </div>
            )}
          </Card>
          {/* Test codes hint */}
          <Card style={{padding:'14px 16px',border:`1px solid ${T.ylw}30`}}>
            <div style={{color:T.ylw,fontWeight:700,fontSize:12,marginBottom:8}}>💡 테스트 코드 (개발 환경)</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {MOCK_INVITE_CODES.filter(c=>c.active).map(c=>(
                <div key={c.id} onClick={()=>setRedeemCode(c.code)} style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:T.alt,borderRadius:8,padding:'8px 12px',cursor:'pointer',border:`1px solid ${T.border}`}}>
                  <div>
                    <div style={{color:T.txt,fontSize:11,fontFamily:'monospace',fontWeight:700}}>{c.code}</div>
                    <div style={{display:'flex',gap:4,marginTop:2}}><PlanBadge plan={c.planType} size="sm"/><span style={{color:T.muted,fontSize:9}}>· {c.note}</span></div>
                  </div>
                  <span style={{color:T.acl,fontSize:11}}>→ 적용</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── ADMIN ── */}
      {tab==='admin'&&(
        <div>
          <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:4}}>🛡️ 구독 관리자</div>
          {/* Admin sub-tabs */}
          <div style={{display:'flex',gap:6,marginBottom:14}}>
            {(['users','codes','stats'] as const).map(t=>(
              <button key={t} onClick={()=>setAdminTab(t)} style={{flex:1,padding:'8px',background:adminTab===t?T.acg:'transparent',color:adminTab===t?T.acl:T.muted,border:`1px solid ${adminTab===t?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>
                {t==='users'?'👥 사용자':t==='codes'?'🎟️ 코드':'📊 현황'}
              </button>
            ))}
          </div>

          {/* Users tab */}
          {adminTab==='users'&&(
            <div>
              {adminUsers.map((u,i)=>(
                <div key={u.userId} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:'12px 14px',marginBottom:8}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                    <div>
                      <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:3}}>
                        <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{u.name}</span>
                        <PlanBadge plan={u.planType} size="sm"/>
                      </div>
                      <div style={{color:T.muted,fontSize:10}}>{u.email}</div>
                      <div style={{display:'flex',gap:4,marginTop:4,flexWrap:'wrap'}}>
                        {(Array.isArray(u.badges) ? u.badges : []).map(b=><UserBadge key={b} badge={b}/>)}
                      </div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{color:T.muted,fontSize:9,marginBottom:4}}>
                        {u.expiresAt===null?'♾️ 평생':u.expiresAt||'-'}
                      </div>
                      <button onClick={()=>setGrantModal({userId:u.userId,name:u.name})} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 10px',fontSize:10,fontWeight:700,cursor:'pointer'}}>플랜 변경</button>
                    </div>
                  </div>
                  {/* Quick grant buttons */}
                  <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                    {(['lifetime','founder','pro','free'] as PlanType[]).map(p=>(
                      <button key={p} onClick={()=>handleGrant(u.userId,p)} style={{background:u.planType===p?PLAN_INFO[p].color+'20':T.alt,color:u.planType===p?PLAN_INFO[p].color:T.muted,border:`1px solid ${u.planType===p?PLAN_INFO[p].color:T.border}`,borderRadius:6,padding:'3px 8px',fontSize:9,fontWeight:700,cursor:'pointer'}}>
                        {PLAN_INFO[p].icon} {PLAN_INFO[p].label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Codes tab */}
          {adminTab==='codes'&&(
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div style={{color:T.txt,fontWeight:700}}>🎟️ 초대 코드 목록</div>
                <button onClick={()=>setShowCreateCode(v=>!v)} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'5px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 새 코드</button>
              </div>

              {showCreateCode&&(
                <Card style={{padding:'14px 16px',marginBottom:12,border:`1px solid ${T.acl}30`}}>
                  <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>새 초대 코드 생성</div>
                  {[
                    {l:'코드',k:'code',ph:'예: TRAIGO-VIP-2025',type:'text'},
                    {l:'메모',k:'note',ph:'예: 개인 발급',type:'text'},
                    {l:'최대 사용',k:'usesMax',ph:'1 (unlimited=무제한)',type:'text'},
                    {l:'만료일',k:'expiresAt',ph:'YYYY-MM-DD (비워두면 무기한)',type:'date'},
                  ].map(f=>(
                    <div key={f.k} style={{marginBottom:8}}>
                      <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:3}}>{f.l}</div>
                      <input type={f.type} value={newCode[f.k as keyof typeof newCode]} onChange={e=>setNewCode(p=>({...p,[f.k]:e.target.value}))} placeholder={f.ph}
                        style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.txt,fontSize:12,outline:'none',fontFamily:f.k==='code'?'monospace':'inherit'}}/>
                    </div>
                  ))}
                  <div style={{marginBottom:10}}>
                    <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:3}}>플랜</div>
                    <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                      {(['pro','premium','lifetime','founder'] as PlanType[]).map(p=>(
                        <button key={p} onClick={()=>setNewCode(prev=>({...prev,plan:p}))} style={{background:newCode.plan===p?PLAN_INFO[p].color+'20':T.alt,color:newCode.plan===p?PLAN_INFO[p].color:T.muted,border:`1px solid ${newCode.plan===p?PLAN_INFO[p].color:T.border}`,borderRadius:8,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>
                          {PLAN_INFO[p].icon} {PLAN_INFO[p].label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{display:'flex',gap:8}}>
                    <button onClick={()=>setShowCreateCode(false)} style={{flex:1,padding:'10px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,cursor:'pointer'}}>취소</button>
                    <button onClick={handleCreateCode} disabled={!newCode.code.trim()} style={{flex:2,padding:'10px',background:T.acc,color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer'}}>코드 생성</button>
                  </div>
                </Card>
              )}

              {inviteCodes.map((c,i)=>(
                <div key={c.id} style={{background:T.card,border:`1px solid ${c.active?T.border:T.muted+'30'}`,borderRadius:12,padding:'12px 14px',marginBottom:8,opacity:c.active?1:0.55}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:6}}>
                    <div>
                      <div style={{color:T.txt,fontWeight:700,fontSize:12,fontFamily:'monospace',letterSpacing:.5,marginBottom:4}}>{c.code}</div>
                      <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                        <PlanBadge plan={c.planType} size="sm"/>
                        <Bdg c={c.active?T.grn:T.muted} ch={c.active?'활성':'비활성'}/>
                        <Bdg c={T.muted} ch={`${c.usesCount}/${c.usesMax===null?'∞':c.usesMax} 사용`}/>
                      </div>
                    </div>
                    <button onClick={()=>setInviteCodes(prev=>prev.map(x=>x.id===c.id?{...x,active:!x.active}:x))} style={{background:c.active?T.red+'15':T.grn+'15',color:c.active?T.red:T.grn,border:`1px solid ${c.active?T.red:T.grn}30`,borderRadius:8,padding:'4px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
                      {c.active?'비활성화':'활성화'}
                    </button>
                  </div>
                  <div style={{display:'flex',gap:10}}>
                    <span style={{color:T.muted,fontSize:10}}>{c.note}</span>
                    {c.expiresAt&&<span style={{color:T.muted,fontSize:10}}>만료: {c.expiresAt}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Stats tab */}
          {adminTab==='stats'&&(
            <div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:10,marginBottom:14}}>
                {[
                  {l:'전체 사용자',v:adminUsers.length+'명',c:T.acl},
                  {l:'유료 사용자',v:adminUsers.filter(u=>u.planType!=='free').length+'명',c:T.grn},
                  {l:'평생 회원',v:adminUsers.filter(u=>u.planType==='lifetime'||u.planType==='founder').length+'명',c:T.ylw},
                  {l:'활성 코드',v:inviteCodes.filter(c=>c.active).length+'개',c:T.prp},
                ].map(s=>(
                  <Card key={s.l} style={{padding:'14px 12px'}}>
                    <div style={{color:T.muted,fontSize:10,marginBottom:4}}>{s.l}</div>
                    <div style={{color:s.c,fontSize:22,fontWeight:900,fontFamily:'monospace'}}>{s.v}</div>
                  </Card>
                ))}
              </div>
              <Card style={{padding:'14px 16px',marginBottom:12}}>
                <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>플랜별 분포</div>
                {(Object.entries(PLAN_INFO) as [PlanType,any][]).map(([key,info])=>{
                  const count=adminUsers.filter(u=>u.planType===key).length;
                  const pct=Math.round(count/adminUsers.length*100);
                  return (
                    <div key={key} style={{marginBottom:8}}>
                      <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                        <div style={{display:'flex',gap:5,alignItems:'center'}}><span style={{fontSize:12}}>{info.icon}</span><span style={{color:T.txt,fontSize:11}}>{info.label}</span></div>
                        <span style={{color:info.color,fontSize:11,fontWeight:700}}>{count}명 ({pct}%)</span>
                      </div>
                      <div style={{height:5,background:'#1A2D4A',borderRadius:3,overflow:'hidden'}}>
                        <div style={{height:'100%',width:pct+'%',background:info.color,borderRadius:3,transition:'width .5s'}}/>
                      </div>
                    </div>
                  );
                })}
              </Card>
              {/* DB Schema reference */}
              <Card style={{padding:'14px 16px',border:`1px solid ${T.acl}30`}}>
                <div style={{color:T.acl,fontWeight:700,fontSize:12,marginBottom:8}}>🗄️ DB 스키마 (참고)</div>
                <div style={{background:'#060B14',borderRadius:8,padding:'10px 12px',fontFamily:'monospace',fontSize:10,color:T.grn,lineHeight:1.8}}>
                  {`-- subscriptions table\ncreate table subscriptions (\n  user_id uuid references auth.users,\n  plan_type text,\n  status text,\n  expires_at timestamptz,\n  granted_by uuid,\n  created_at timestamptz default now()\n);\n\n-- invite_codes table\ncreate table invite_codes (\n  code text primary key,\n  plan_type text,\n  uses_max int,\n  uses_count int default 0,\n  active boolean default true\n);`}
                </div>
              </Card>
            </div>
          )}

          {/* Grant modal */}
          {grantModal&&(
            <>
              <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',zIndex:200,touchAction:'none'}} onClick={()=>setGrantModal(null)}/>
              <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px calc(40px + env(safe-area-inset-bottom, 0px))',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
                <div style={{color:T.txt,fontWeight:800,fontSize:16,marginBottom:4}}>🛡️ 플랜 변경</div>
                <div style={{color:T.muted,fontSize:12,marginBottom:16}}>{grantModal.name}에게 플랜을 부여합니다</div>
                <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:16}}>
                  {(Object.entries(PLAN_INFO) as [PlanType,any][]).map(([key,info])=>(
                    <button key={key} onClick={()=>setGrantPlan(key)} style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:grantPlan===key?info.color+'20':T.alt,border:`2px solid ${grantPlan===key?info.color:T.border}`,borderRadius:12,padding:'12px 14px',cursor:'pointer'}}>
                      <div style={{display:'flex',gap:8,alignItems:'center'}}>
                        <span style={{fontSize:18}}>{info.icon}</span>
                        <div style={{textAlign:'left'}}><div style={{color:T.txt,fontWeight:700,fontSize:13}}>{info.label}</div><div style={{color:info.color,fontSize:11}}>{info.price}</div></div>
                      </div>
                      {grantPlan===key&&<span style={{color:info.color,fontSize:16,fontWeight:900}}>✓</span>}
                    </button>
                  ))}
                </div>
                <div style={{display:'flex',gap:10}}>
                  <button onClick={()=>setGrantModal(null)} style={{flex:1,padding:'13px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
                  <button onClick={()=>handleGrant(grantModal.userId,grantPlan)} style={{flex:2,padding:'13px',background:`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>✅ 플랜 부여</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}



/* ══════════════════════════════════════════════════════════════
   ECONOMIC CALENDAR PAGE
   ══════════════════════════════════════════════════════════════ */


export default SubscriptionPage;