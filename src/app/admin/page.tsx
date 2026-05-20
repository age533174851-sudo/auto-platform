'use client';
import React, { useState, useEffect, useCallback } from 'react';
import {
  UserProfile, UserRole, PlanType, InviteCode, AuditLog,
  getMockSession, canAccessAdmin, ROLE_INFO, ROLE_RANK,
  MOCK_USERS, MOCK_INVITE_CODES, MOCK_AUDIT_LOGS,
  setMockSession, canAccessSuperAdmin, canAccessDeveloper,
} from '@/lib/auth';
import {
  SUPABASE_CONFIGURED, sbGetSession, getProfile,
  adminGetAllUsers, adminChangePlan, adminBanUser,
  adminGetCodes, adminCreateCode, adminToggleCode,
  getAuditLogs,
} from '@/lib/supabase';

const T = {
  bg:'#060B14', card:'#0F1924', border:'#1A2D4A', border2:'#243A5E',
  acc:'#2563EB', acl:'#3B82F6', acg:'rgba(37,99,235,.15)',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B', prp:'#7C3AED',
  cyn:'#0891B2', gld:'#D97706',
  txt:'#F0F6FF', sub:'#94A3B8', muted:'#475569', surf:'#0D1626',
};

const PLAN_INFO: Record<PlanType,{label:string;color:string;icon:string}> = {
  free:{label:'무료',color:'#94A3B8',icon:'🆓'},
  pro:{label:'Pro',color:'#3B82F6',icon:'⚡'},
  premium:{label:'Premium',color:'#7C3AED',icon:'💎'},
  lifetime:{label:'평생',color:'#F59E0B',icon:'♾️'},
  founder:{label:'창업',color:'#EF4444',icon:'🚀'},
  admin:{label:'관리자',color:'#10B981',icon:'🛡️'},
};

function Bdg({c,ch}:{c:string;ch:string}) {
  return <span style={{background:c+'20',color:c,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99,border:`1px solid ${c}30`,whiteSpace:'nowrap'}}>{ch}</span>;
}
function Card({children,style}:{children?:React.ReactNode;style?:React.CSSProperties;[key:string]:any}) {
  return <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,...style}}>{children}</div>;
}
function Toggle({on,onChange}:{on:boolean;onChange:(v:boolean)=>void}) {
  return (
    <button onClick={()=>onChange(!on)} style={{width:40,height:22,borderRadius:11,background:on?T.grn:'#1A2D4A',border:'none',cursor:'pointer',position:'relative',transition:'background .2s',flexShrink:0}}>
      <div style={{position:'absolute',top:3,left:on?20:3,width:16,height:16,borderRadius:8,background:'#fff',transition:'left .2s'}}/>
    </button>
  );
}

export default function AdminPage() {
  const [session,setSession]=useState<UserProfile|null>(null);
  const [loading,setLoading]=useState(true);
  const [tab,setTab]=useState<'users'|'codes'|'audit'|'system'>('users');
  const [users,setUsers]=useState<UserProfile[]>(MOCK_USERS);
  const [codes,setCodes]=useState<InviteCode[]>(MOCK_INVITE_CODES);
  const [auditLogs]=useState<AuditLog[]>(MOCK_AUDIT_LOGS);
  const [search,setSearch]=useState('');
  const [grantModal,setGrantModal]=useState<UserProfile|null>(null);
  const [grantPlan,setGrantPlan]=useState<PlanType>('lifetime');
  const [grantRole,setGrantRole]=useState<UserRole>('lifetime');
  const [showNewCode,setShowNewCode]=useState(false);
  const [newCode,setNewCode]=useState({code:'',plan:'pro' as PlanType,role:'user' as UserRole,usesMax:'1',note:'',expiresAt:''});
  const [confirmAction,setConfirmAction]=useState<{title:string;desc:string;danger:boolean;onConfirm:()=>void}|null>(null);
  const [maintenanceMode,setMaintenanceMode]=useState(false);
  const [featureFlags,setFeatureFlags]=useState({realTrading:false,aiSignals:true,socialFeed:true,copyTrading:false,telegram:false});

  const loadData = useCallback(async () => {
    if (SUPABASE_CONFIGURED) {
      try {
        const sbSession = await sbGetSession();
        if (sbSession?.user) {
          const profile = await getProfile(sbSession.user.id);
          setSession(profile);
          if (profile && canAccessAdmin(profile.role)) {
            const [sbUsers, sbCodes, sbLogs] = await Promise.all([
              adminGetAllUsers(), adminGetCodes(), getAuditLogs(),
            ]);
            if (sbUsers.length > 0) setUsers(sbUsers);
            if (sbCodes.length > 0) setCodes(sbCodes);
          }
        }
      } catch {}
    } else {
      const s = getMockSession();
      setSession(s);
    }
    setLoading(false);
  }, []);
  useEffect(() => { loadData(); }, [loadData]);

  if(loading) return <div style={{minHeight:'100vh',background:T.bg,display:'flex',alignItems:'center',justifyContent:'center'}}><div style={{color:T.muted,fontSize:13}}>로딩 중…</div></div>;

  if(!session||!canAccessAdmin(session.role)) {
    return (
      <div style={{minHeight:'100vh',background:T.bg,display:'flex',alignItems:'center',justifyContent:'center',padding:20,fontFamily:"'Sora',sans-serif"}}>
        <div style={{textAlign:'center',maxWidth:360}}>
          <div style={{fontSize:48,marginBottom:16}}>🔒</div>
          <div style={{color:T.txt,fontWeight:800,fontSize:20,marginBottom:8}}>접근 권한이 없습니다</div>
          <div style={{color:T.muted,fontSize:13,lineHeight:1.6,marginBottom:20}}>관리자, 개발자, 슈퍼관리자만 접근 가능합니다.</div>
          <a href="/auth" style={{display:'inline-block',padding:'12px 24px',background:T.acc,color:'#fff',borderRadius:12,fontWeight:700,fontSize:13,textDecoration:'none',marginRight:8}}>로그인</a>
          <a href="/" style={{display:'inline-block',padding:'12px 24px',background:T.card,color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,fontSize:13,textDecoration:'none'}}>홈으로</a>
        </div>
      </div>
    );
  }

  const ri=ROLE_INFO[session.role];
  const isSuperAdmin=canAccessSuperAdmin(session.role);
  const isDeveloper=canAccessDeveloper(session.role);

  const filteredUsers=users.filter(u=>!search||u.email.toLowerCase().includes(search.toLowerCase())||u.displayName.toLowerCase().includes(search.toLowerCase()));

  const handleGrantPlan=async(userId:string,plan:PlanType,role:UserRole)=>{
    setUsers(prev=>prev.map(u=>u.id===userId?{...u,plan,role,expiresAt:plan==='lifetime'||plan==='founder'?null:u.expiresAt,grantedBy:session.id,badges:plan==='lifetime'?[...new Set([...u.badges,'lifetime'])]:plan==='founder'?[...new Set([...u.badges,'founder','vip'])]:u.badges}:u));
    setGrantModal(null);
  };

  const handleBan=(userId:string,ban:boolean)=>setUsers(prev=>prev.map(u=>u.id===userId?{...u,status:ban?'banned':'active'}:u));
  const handleToggleCode=(id:string)=>setCodes(prev=>prev.map(c=>c.id===id?{...c,active:!c.active}:c));

  const handleCreateCode=()=>{
    const code:InviteCode={
      id:'ic_'+Date.now().toString(36),code:newCode.code.toUpperCase(),
      plan:newCode.plan,role:newCode.role,
      usesMax:newCode.usesMax==='unlimited'?null:parseInt(newCode.usesMax)||1,
      usesCount:0,active:true,createdBy:session.id,
      createdAt:new Date().toISOString().split('T')[0],
      expiresAt:newCode.expiresAt||null,note:newCode.note,
    };
    setCodes(prev=>[code,...prev]);
    setNewCode({code:'',plan:'pro',role:'user',usesMax:'1',note:'',expiresAt:''});
    setShowNewCode(false);
  };

  const stats={
    total:users.length,active:users.filter(u=>u.status==='active').length,
    paid:users.filter(u=>u.plan!=='free').length,
    lifetime:users.filter(u=>u.plan==='lifetime'||u.plan==='founder').length,
    banned:users.filter(u=>u.status==='banned').length,
  };

  return (
    <div style={{minHeight:'100vh',background:T.bg,fontFamily:"'Sora',sans-serif",color:T.txt}}>
      {/* Top bar */}
      <div style={{background:T.surf,borderBottom:`1px solid ${T.border}`,padding:'12px 16px',display:'flex',justifyContent:'space-between',alignItems:'center',position:'sticky',top:0,zIndex:50}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:`linear-gradient(135deg,${ri.color},${ri.color}88)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16}}>{ri.icon}</div>
          <div>
            <div style={{color:T.txt,fontWeight:800,fontSize:13}}>TRAIGO 관리자 대시보드</div>
            <div style={{color:T.muted,fontSize:10}}>{session.displayName} · {ri.label}</div>
          </div>
        </div>
        <div style={{display:'flex',gap:8}}>
          {isDeveloper&&<a href="/developer" style={{background:T.prp+'20',color:T.prp,border:`1px solid ${T.prp}40`,borderRadius:8,padding:'5px 10px',fontSize:11,fontWeight:700,textDecoration:'none'}}>⚙️ 개발자</a>}
          <a href="/" style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'5px 10px',fontSize:11,fontWeight:700,textDecoration:'none'}}>🏠</a>
          <a href="/auth" style={{background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:8,padding:'5px 10px',fontSize:11,textDecoration:'none'}}>로그아웃</a>
        </div>
      </div>

      <div style={{maxWidth:800,margin:'0 auto',padding:'16px 16px 80px'}}>
        {maintenanceMode&&(
          <div style={{background:T.red+'20',border:`1px solid ${T.red}`,borderRadius:12,padding:'12px 16px',marginBottom:14,display:'flex',gap:10,alignItems:'center'}}>
            <span style={{fontSize:20}}>🚨</span>
            <div><div style={{color:T.red,fontWeight:800}}>유지보수 모드 활성화</div><div style={{color:T.sub,fontSize:11}}>일반 사용자 접근 차단 중</div></div>
            <button onClick={()=>setMaintenanceMode(false)} style={{marginLeft:'auto',background:T.red,color:'#fff',border:'none',borderRadius:8,padding:'6px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>해제</button>
          </div>
        )}

        {/* Supabase status */}
        {SUPABASE_CONFIGURED
          ? <div style={{background:T.grn+'12',border:`1px solid ${T.grn}30`,borderRadius:10,padding:'8px 14px',marginBottom:12,display:'flex',gap:6,alignItems:'center'}}><span style={{color:T.grn,fontSize:10,fontWeight:700}}>✅ Supabase 연결됨 — 실제 DB 데이터</span></div>
          : <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'8px 14px',marginBottom:12,display:'flex',gap:6,alignItems:'center'}}><span style={{color:T.ylw,fontSize:10,fontWeight:700}}>🔧 Mock 모드 — .env.local에 Supabase 키 추가 필요</span></div>
        }
        {/* Stats */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:8,marginBottom:16}}>
          {[{l:'전체',v:stats.total,c:T.acl},{l:'활성',v:stats.active,c:T.grn},{l:'유료',v:stats.paid,c:T.prp},{l:'평생',v:stats.lifetime,c:T.ylw},{l:'차단',v:stats.banned,c:T.red}].map(s=>(
            <Card key={s.l} style={{padding:'10px 8px',textAlign:'center'}}>
              <div style={{color:s.c,fontSize:20,fontWeight:900,fontFamily:'monospace'}}>{s.v}</div>
              <div style={{color:T.muted,fontSize:9,marginTop:2}}>{s.l}</div>
            </Card>
          ))}
        </div>

        {/* Tabs */}
        <div style={{display:'flex',gap:6,marginBottom:16,overflowX:'auto'}}>
          {([['users','👥 사용자'],['codes','🎟️ 초대 코드'],['audit','📋 감사 로그'],...(isSuperAdmin||isDeveloper?[['system','⚙️ 시스템']]:[])] as [string,string][]).map(([id,label])=>(
            <button key={id} onClick={()=>setTab(id as any)} style={{flexShrink:0,padding:'8px 14px',background:tab===id?T.acg:'transparent',color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer'}}>{label}</button>
          ))}
        </div>

        {tab==='users'&&(
          <div>
            <div style={{display:'flex',gap:8,marginBottom:12}}>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="이메일 또는 이름 검색…" style={{flex:1,background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 14px',color:T.txt,fontSize:12,outline:'none'}}/>
            </div>
            {filteredUsers.map(u=>{
              const uri=ROLE_INFO[u.role];const pi=PLAN_INFO[u.plan];
              const isMe=u.id===session.id;
              const canManage=isSuperAdmin||(ROLE_RANK[session.role]>ROLE_RANK[u.role]&&!isMe);
              return (
                <Card key={u.id} style={{padding:'14px',marginBottom:8,opacity:u.status==='banned'?0.65:1}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                    <div style={{display:'flex',gap:10,alignItems:'center'}}>
                      <div style={{width:38,height:38,borderRadius:10,background:`${uri.color}20`,border:`1px solid ${uri.color}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>{uri.icon}</div>
                      <div>
                        <div style={{display:'flex',gap:4,alignItems:'center',flexWrap:'wrap'}}>
                          <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{u.displayName}</span>
                          {isMe&&<Bdg c={T.acl} ch="나"/>}
                          <span style={{background:`${uri.color}20`,color:uri.color,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:99}}>{uri.label}</span>
                          <span style={{background:`${pi.color}20`,color:pi.color,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:99}}>{pi.icon}{pi.label}</span>
                          {u.status==='banned'&&<Bdg c={T.red} ch="차단"/>}
                          {u.expiresAt===null&&<Bdg c={T.ylw} ch="♾️ 평생"/>}
                        </div>
                        <div style={{color:T.muted,fontSize:10,marginTop:2}}>{u.email}</div>
                        <div style={{display:'flex',gap:4,marginTop:3,flexWrap:'wrap'}}>{u.badges.map(b=><span key={b} style={{background:T.ylw+'15',color:T.ylw,fontSize:8,fontWeight:700,padding:'1px 5px',borderRadius:99}}>{b}</span>)}</div>
                      </div>
                    </div>
                    <div style={{display:'flex',gap:5,flexShrink:0}}>
                      {canManage&&<button onClick={()=>{setGrantModal(u);setGrantPlan(u.plan);setGrantRole(u.role);}} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'4px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>변경</button>}
                      {canManage&&<button onClick={()=>setConfirmAction({title:u.status==='banned'?`${u.displayName} 차단 해제`:`${u.displayName} 차단`,desc:u.status==='banned'?'차단을 해제합니다.':'이 사용자를 차단합니다.',danger:u.status!=='banned',onConfirm:()=>handleBan(u.id,u.status!=='banned')})} style={{background:u.status==='banned'?T.grn+'15':T.red+'15',color:u.status==='banned'?T.grn:T.red,border:`1px solid ${u.status==='banned'?T.grn:T.red}30`,borderRadius:8,padding:'4px 9px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{u.status==='banned'?'해제':'차단'}</button>}
                    </div>
                  </div>
                  {canManage&&(
                    <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                      <span style={{color:T.muted,fontSize:9,alignSelf:'center',marginRight:2}}>빠른 부여:</span>
                      {(['lifetime','founder','premium','pro','free'] as PlanType[]).map(p=>(
                        <button key={p} onClick={()=>handleGrantPlan(u.id,p,p==='lifetime'?'lifetime':p==='founder'?'founder':'user')} style={{background:u.plan===p?PLAN_INFO[p].color+'20':'transparent',color:u.plan===p?PLAN_INFO[p].color:T.muted,border:`1px solid ${u.plan===p?PLAN_INFO[p].color:T.border}`,borderRadius:6,padding:'2px 7px',fontSize:9,fontWeight:700,cursor:'pointer'}}>{PLAN_INFO[p].icon}{PLAN_INFO[p].label}</button>
                      ))}
                    </div>
                  )}
                  <div style={{color:T.muted,fontSize:9,marginTop:6}}>가입: {u.createdAt} · 최근: {u.lastSignIn||'-'}</div>
                </Card>
              );
            })}
          </div>
        )}

        {tab==='codes'&&(
          <div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700}}>🎟️ 초대 코드</div>
              <button onClick={()=>setShowNewCode(v=>!v)} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'6px 12px',fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 생성</button>
            </div>
            {showNewCode&&(
              <Card style={{padding:'16px',marginBottom:12,border:`1px solid ${T.acl}30`}}>
                <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>새 초대 코드</div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
                  {[{l:'코드 (대문자)',k:'code',ph:'TRAIGO-XXXX-2026',type:'text'},{l:'최대 사용 횟수',k:'usesMax',ph:'숫자 또는 unlimited',type:'text'},{l:'메모',k:'note',ph:'용도',type:'text'},{l:'만료일 (선택)',k:'expiresAt',ph:'',type:'date'}].map(f=>(
                    <div key={f.k}>
                      <div style={{color:T.muted,fontSize:11,marginBottom:4}}>{f.l}</div>
                      <input type={f.type} value={newCode[f.k as keyof typeof newCode]} onChange={e=>setNewCode(p=>({...p,[f.k]:f.k==='code'?e.target.value.toUpperCase().replace(/\s/g,'-'):e.target.value}))} placeholder={f.ph} style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:'9px 12px',color:T.txt,fontSize:12,fontFamily:f.k==='code'?'monospace':'inherit',fontWeight:f.k==='code'?700:400,outline:'none'}}/>
                    </div>
                  ))}
                </div>
                <div style={{marginBottom:10}}>
                  <div style={{color:T.muted,fontSize:11,marginBottom:6}}>플랜</div>
                  <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>{(['pro','premium','lifetime','founder'] as PlanType[]).map(p=><button key={p} onClick={()=>setNewCode(prev=>({...prev,plan:p}))} style={{background:newCode.plan===p?PLAN_INFO[p].color+'25':T.bg,color:newCode.plan===p?PLAN_INFO[p].color:T.muted,border:`1px solid ${newCode.plan===p?PLAN_INFO[p].color:T.border}`,borderRadius:8,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>{PLAN_INFO[p].icon} {PLAN_INFO[p].label}</button>)}</div>
                </div>
                <div style={{marginBottom:12}}>
                  <div style={{color:T.muted,fontSize:11,marginBottom:6}}>역할</div>
                  <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>{(['user','vip','lifetime','founder'] as UserRole[]).map(r=><button key={r} onClick={()=>setNewCode(prev=>({...prev,role:r}))} style={{background:newCode.role===r?ROLE_INFO[r].color+'25':T.bg,color:newCode.role===r?ROLE_INFO[r].color:T.muted,border:`1px solid ${newCode.role===r?ROLE_INFO[r].color:T.border}`,borderRadius:8,padding:'5px 10px',fontSize:11,fontWeight:700,cursor:'pointer'}}>{ROLE_INFO[r].icon} {ROLE_INFO[r].label}</button>)}</div>
                </div>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={()=>setShowNewCode(false)} style={{flex:1,padding:'10px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,cursor:'pointer'}}>취소</button>
                  <button onClick={handleCreateCode} disabled={!newCode.code.trim()} style={{flex:2,padding:'10px',background:newCode.code.trim()?T.acc:'#243A5E',color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer'}}>✅ 코드 생성</button>
                </div>
              </Card>
            )}
            {codes.map(c=>(
              <Card key={c.id} style={{padding:'14px',marginBottom:8,opacity:c.active?1:0.5,border:`1px solid ${c.active?T.border:T.muted+'30'}`}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:12,fontFamily:'monospace',letterSpacing:.5,marginBottom:5}}>{c.code}</div>
                    <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                      <Bdg c={PLAN_INFO[c.plan].color} ch={`${PLAN_INFO[c.plan].icon} ${PLAN_INFO[c.plan].label}`}/>
                      <Bdg c={ROLE_INFO[c.role].color} ch={`${ROLE_INFO[c.role].icon} ${ROLE_INFO[c.role].label}`}/>
                      <Bdg c={c.active?T.grn:T.muted} ch={c.active?'활성':'비활성'}/>
                      <Bdg c={T.muted} ch={`${c.usesCount}/${c.usesMax===null?'∞':c.usesMax}회`}/>
                    </div>
                  </div>
                  <div style={{display:'flex',gap:5}}>
                    <button onClick={()=>typeof navigator!=='undefined'&&navigator.clipboard?.writeText(c.code)} style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:7,padding:'4px 8px',fontSize:10,cursor:'pointer'}}>복사</button>
                    <button onClick={()=>handleToggleCode(c.id)} style={{background:c.active?T.red+'15':T.grn+'15',color:c.active?T.red:T.grn,border:`1px solid ${c.active?T.red:T.grn}30`,borderRadius:7,padding:'4px 8px',fontSize:10,fontWeight:700,cursor:'pointer'}}>{c.active?'비활성':'활성'}</button>
                  </div>
                </div>
                <div style={{color:T.muted,fontSize:10}}>📝 {c.note} {c.expiresAt&&`· 만료: ${c.expiresAt}`}</div>
              </Card>
            ))}
          </div>
        )}

        {tab==='audit'&&(
          <div>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📋 감사 로그</div>
            {auditLogs.map(log=>(
              <Card key={log.id} style={{padding:'12px 14px',marginBottom:8}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                  <span style={{background:T.acl+'20',color:T.acl,fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:6,fontFamily:'monospace'}}>{log.action}</span>
                  <span style={{color:T.muted,fontSize:9}}>{new Date(log.createdAt).toLocaleString('ko-KR')}</span>
                </div>
                <div style={{color:T.txt,fontSize:12,marginBottom:3}}>{log.details}</div>
                <div style={{color:T.muted,fontSize:10}}>실행: {log.actorEmail}{log.targetEmail&&` · 대상: ${log.targetEmail}`}</div>
              </Card>
            ))}
          </div>
        )}

        {tab==='system'&&(
          <div>
            <Card style={{padding:'16px',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🚩 기능 플래그</div>
              {(Object.entries(featureFlags) as [string,boolean][]).map(([key,val],i,arr)=>(
                <div key={key} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                  <div>
                    <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{key==='realTrading'?'실제 거래 실행':key==='aiSignals'?'AI 매매 신호':key==='socialFeed'?'소셜 피드':key==='copyTrading'?'카피 트레이딩':'텔레그램 알림'}</div>
                    <div style={{color:T.muted,fontSize:10}}>{key==='realTrading'?'⚠️ 위험':''}</div>
                  </div>
                  <Toggle on={val} onChange={v=>setFeatureFlags(p=>({...p,[key]:v}))}/>
                </div>
              ))}
            </Card>
            <Card style={{padding:'16px',marginBottom:12,border:`1px solid ${T.red}30`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div><div style={{color:T.red,fontWeight:700}}>🚨 유지보수 모드</div><div style={{color:T.muted,fontSize:11}}>활성 시 일반 사용자 접근 차단</div></div>
                <Toggle on={maintenanceMode} onChange={v=>v?setConfirmAction({title:'유지보수 모드 활성화',desc:'일반 사용자가 접근할 수 없게 됩니다.',danger:true,onConfirm:()=>setMaintenanceMode(true)}):setMaintenanceMode(false)}/>
              </div>
            </Card>
            <Card style={{padding:'16px',marginBottom:12,border:`1px solid ${T.prp}30`}}>
              <div style={{color:T.prp,fontWeight:700,marginBottom:10}}>🗄️ DB 스키마 참고</div>
              <div style={{background:'#030610',borderRadius:8,padding:'10px 12px',fontFamily:'monospace',fontSize:10,color:T.grn,lineHeight:1.8,overflowX:'auto'}}>
                {`create table profiles (\n  id uuid primary key references auth.users,\n  email text unique not null,\n  display_name text,\n  role text default 'user',\n  plan text default 'free',\n  status text default 'active',\n  badges text[] default '{}',\n  expires_at timestamptz,\n  granted_by uuid\n);\n\ncreate table invite_codes (\n  code text primary key,\n  plan text, role text,\n  uses_max int, uses_count int default 0,\n  active boolean default true\n);`}
              </div>
            </Card>
            {isSuperAdmin&&(
              <Card style={{padding:'16px',border:`2px solid ${T.red}`}}>
                <div style={{color:T.red,fontWeight:800,fontSize:14,marginBottom:8}}>👑 슈퍼관리자 전용</div>
                <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                  {[{l:'🚨 긴급 정지',danger:true},{l:'📧 전체 공지',danger:false},{l:'💾 DB 백업',danger:false}].map(a=>(
                    <button key={a.l} onClick={()=>setConfirmAction({title:a.l,desc:a.l+' 실행',danger:a.danger,onConfirm:()=>{}})} style={{background:a.danger?T.red+'20':T.acg,color:a.danger?T.red:T.acl,border:`1px solid ${a.danger?T.red:T.acl}40`,borderRadius:10,padding:'8px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>{a.l}</button>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* Grant modal */}
      {grantModal&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.8)',zIndex:200}} onClick={()=>setGrantModal(null)}/>
          <div style={{position:'fixed',inset:'auto 0 0',zIndex:201,background:T.surf,borderRadius:'20px 20px 0 0',padding:'24px 20px 40px',maxWidth:480,margin:'0 auto',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:T.txt,fontWeight:800,fontSize:16,marginBottom:4}}>플랜/역할 변경</div>
            <div style={{color:T.muted,fontSize:12,marginBottom:16}}>{grantModal.displayName} ({grantModal.email})</div>
            <div style={{marginBottom:12}}>
              <div style={{color:T.muted,fontSize:11,marginBottom:8}}>플랜</div>
              <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>{(['free','pro','premium','lifetime','founder'] as PlanType[]).map(p=><button key={p} onClick={()=>setGrantPlan(p)} style={{background:grantPlan===p?PLAN_INFO[p].color+'25':T.bg,color:grantPlan===p?PLAN_INFO[p].color:T.muted,border:`2px solid ${grantPlan===p?PLAN_INFO[p].color:T.border}`,borderRadius:10,padding:'8px 12px',fontSize:12,fontWeight:700,cursor:'pointer'}}>{PLAN_INFO[p].icon} {PLAN_INFO[p].label}</button>)}</div>
            </div>
            <div style={{marginBottom:16}}>
              <div style={{color:T.muted,fontSize:11,marginBottom:8}}>역할</div>
              <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>{(['user','vip','lifetime','founder',...(isSuperAdmin?['admin','developer'] as UserRole[]:[])] as UserRole[]).map(r=><button key={r} onClick={()=>setGrantRole(r)} style={{background:grantRole===r?ROLE_INFO[r].color+'25':T.bg,color:grantRole===r?ROLE_INFO[r].color:T.muted,border:`2px solid ${grantRole===r?ROLE_INFO[r].color:T.border}`,borderRadius:10,padding:'8px 12px',fontSize:12,fontWeight:700,cursor:'pointer'}}>{ROLE_INFO[r].icon} {ROLE_INFO[r].label}</button>)}</div>
            </div>
            {(grantPlan==='lifetime'||grantRole==='admin')&&<div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'10px 12px',marginBottom:12}}><div style={{color:T.ylw,fontSize:11,fontWeight:700}}>⚠️ 고권한 부여 — 만료일 없음(무기한)</div></div>}
            <div style={{display:'flex',gap:10}}>
              <button onClick={()=>setGrantModal(null)} style={{flex:1,padding:'13px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>handleGrantPlan(grantModal.id,grantPlan,grantRole)} style={{flex:2,padding:'13px',background:`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>✅ 변경 적용</button>
            </div>
          </div>
        </>
      )}

      {/* Confirm modal */}
      {confirmAction&&(
        <>
          <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.8)',zIndex:300}} onClick={()=>setConfirmAction(null)}/>
          <div style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:301,background:T.surf,borderRadius:20,padding:'24px 20px',width:320,border:`1px solid ${confirmAction.danger?T.red:T.border}`}} onClick={e=>e.stopPropagation()}>
            <div style={{color:confirmAction.danger?T.red:T.txt,fontWeight:800,fontSize:16,marginBottom:8}}>{confirmAction.title}</div>
            <div style={{color:T.muted,fontSize:12,lineHeight:1.6,marginBottom:20}}>{confirmAction.desc}</div>
            <div style={{display:'flex',gap:10}}>
              <button onClick={()=>setConfirmAction(null)} style={{flex:1,padding:'11px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,cursor:'pointer'}}>취소</button>
              <button onClick={()=>{confirmAction.onConfirm();setConfirmAction(null);}} style={{flex:1,padding:'11px',background:confirmAction.danger?T.red:T.acc,color:'#fff',border:'none',borderRadius:10,fontWeight:800,cursor:'pointer'}}>확인</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
