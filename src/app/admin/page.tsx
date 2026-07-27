'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { confirmDialog } from '@/lib/confirm/dialog';

// ── Theme ─────────────────────────────────────────────────────
const T = {
  bg:'#060B14', card:'#0A1628', surf:'#0D1F3C', alt:'#0F2040',
  border:'#1A2D4A', border2:'#243A5E',
  txt:'#E2E8F0', sub:'#94A3B8', muted:'#475569',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B', gld:'#D97706',
  acc:'#2563EB', acl:'#60A5FA', acg:'rgba(37,99,235,.12)',
  prp:'#7C3AED',
};

function Card({children,style}:{children?:React.ReactNode;style?:React.CSSProperties}) {
  return <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,...style}}>{children}</div>;
}
function Bdg({c,ch}:{c:string;ch:string}) {
  return <span style={{background:c+'20',color:c,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99,border:`1px solid ${c}30`,whiteSpace:'nowrap'}}>{ch}</span>;
}
function Toggle({on,onChange}:{on:boolean;onChange:(v:boolean)=>void}) {
  return (
    <div onClick={()=>onChange(!on)} style={{width:44,height:24,borderRadius:12,background:on?T.grn:T.border,cursor:'pointer',position:'relative',transition:'background .2s',flexShrink:0}}>
      <div style={{position:'absolute',top:3,left:on?23:3,width:18,height:18,borderRadius:9,background:'#fff',transition:'left .2s'}}/>
    </div>
  );
}

// ── Role guard helper (client-side) ──────────────────────────
async function getSessionAndRole(): Promise<{userId:string|null;role:string|null;token:string|null}> {
  try {
    const {getSupabaseClient} = await import('@/lib/supabase/client');
    const sb = getSupabaseClient();
    if (!sb) return {userId:null,role:null,token:null};
    const {data:{session}} = await sb.auth.getSession();
    if (!session?.user) return {userId:null,role:null,token:null};
    // /api/auth/me 호출 → ADMIN_EMAILS 자동 승급 트리거 + 최신 role 반환
    try {
      const r = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (r.ok) {
        const d = await r.json();
        return {
          userId: d?.user?.id ?? session.user.id,
          role:   d?.profile?.role ?? 'user',
          token:  session.access_token,
        };
      }
    } catch { /* fall through */ }
    // /api/auth/me 실패 시 fallback — DB 직접 조회
    const {data:profile} = await sb.from('profiles').select('role').eq('id',session.user.id).single();
    const r = (profile as { role?: string } | null)?.role ?? 'user';
    return {userId:session.user.id, role:r, token:session.access_token};
  } catch { return {userId:null,role:null,token:null}; }
}

async function apiCall(action:string, token:string|null, method='GET', body?:unknown) {
  const url = method==='GET' ? `/api/admin?action=${action}` : '/api/admin';
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type':'application/json',
      ...(token ? {'Authorization':`Bearer ${token}`} : {}),
    },
    ...(body ? {body:JSON.stringify(body)} : {}),
  });
  return res.json();
}

// ═══════════════════════════════════════════════════════════════
// Main Admin Page
// ═══════════════════════════════════════════════════════════════
export default function AdminPage() {
  const [role, setRole] = useState<string|null>(null);
  const [userId, setUserId] = useState<string|null>(null);
  const [token, setToken] = useState<string|null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'health'|'stats'|'users'|'exchange'|'strategies'|'notices'|'audit'|'system'>('health');

  // Data states
  const [health, setHealth]       = useState<any>(null);
  const [users, setUsers]         = useState<any[]>([]);
  const [connections, setConns]   = useState<any[]>([]);
  const [strategies, setStrats]   = useState<any[]>([]);
  const [auditLogs, setAudit]     = useState<any[]>([]);
  const [stats, setStats]         = useState<any>(null);
  const [notices, setNotices]     = useState<any[]>([]);
  const [maintenance, setMaint]   = useState(false);
  const [killConfirm, setKillCon] = useState(false);
  const [actionMsg, setActionMsg] = useState<{text:string;ok:boolean}|null>(null);
  const [userSearch, setUserSearch] = useState('');

  // ── Auth check on mount ──────────────────────────────────
  useEffect(()=>{
    getSessionAndRole().then(({userId:uid,role:r,token:t})=>{
      setUserId(uid); setRole(r); setToken(t); setLoading(false);
    });
  },[]);

  // ── Load data for active tab ─────────────────────────────
  const loadTab = useCallback(async(t:string)=>{
    if (!token) return;
    try {
      if (t==='health') {
        const d = await apiCall('health', token);
        setHealth(d);
      } else if (t==='users') {
        const d = await apiCall(`users${userSearch?`&search=${userSearch}`:''}`, token);
        setUsers(d.users??[]);
      } else if (t==='exchange') {
        const d = await apiCall('exchange_status', token);
        setConns(d.connections??[]);
      } else if (t==='strategies') {
        const d = await apiCall('strategy_status', token);
        setStrats(d.strategies??[]);
      } else if (t==='audit') {
        const d = await apiCall('audit_logs', token);
        setAudit(d.logs??[]);
      } else if (t==='stats') {
        const d = await apiCall('stats', token);
        setStats(d.stats || null);
      } else if (t==='notices') {
        const d = await apiCall('notices_list', token);
        setNotices(d.notices || []);
      }
    } catch {}
  },[token, userSearch]);

  useEffect(()=>{ if(token) loadTab(tab); },[tab, token, loadTab]);

  const showMsg = (text:string, ok:boolean) => {
    setActionMsg({text,ok});
    setTimeout(()=>setActionMsg(null),3000);
  };

  // ── Emergency stop ───────────────────────────────────────
  const emergencyStop = async() => {
    if (!token) return;
    try {
      const d = await apiCall('', token, 'POST', {action:'emergency_stop', reason:'관리자 긴급 정지'});
      if (d.success) {
        showMsg(`✅ ${d.message}`, true);
        setKillCon(false);
        loadTab('strategies');
      } else {
        showMsg(`❌ ${d.error}`, false);
      }
    } catch { showMsg('❌ 오류 발생', false); }
  };

  // ── Ban/unban user ───────────────────────────────────────
  const toggleBan = async(targetId:string, currentStatus:string) => {
    if (!token) return;
    const action = currentStatus==='banned' ? 'unban_user' : 'ban_user';
    try {
      const d = await apiCall('', token, 'POST', {action, targetId});
      if (d.success) {
        showMsg(`✅ 처리 완료`, true);
        loadTab('users');
      } else {
        showMsg(`❌ ${d.error}`, false);
      }
    } catch { showMsg('❌ 오류 발생', false); }
  };

  // ── Maintenance mode ─────────────────────────────────────
  const toggleMaintenance = async(enabled:boolean) => {
    if (!token) return;
    try {
      const d = await apiCall('', token, 'POST', {action:'maintenance_mode', enabled});
      if (d.success) {
        setMaint(d.maintenanceMode);
        showMsg(enabled ? '🔧 유지보수 모드 활성화' : '✅ 유지보수 모드 해제', true);
      }
    } catch {}
  };

  // ── Loading ──────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{minHeight:'100vh',background:T.bg,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <div style={{color:T.muted,fontSize:13}}>로딩 중...</div>
      </div>
    );
  }

  // ── Not logged in ────────────────────────────────────────
  if (!userId) {
    return (
      <div style={{minHeight:'100vh',background:T.bg,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <Card style={{padding:32,textAlign:'center',maxWidth:340}}>
          <div style={{fontSize:40,marginBottom:12}}>🔐</div>
          <div style={{color:T.txt,fontWeight:800,fontSize:16,marginBottom:8}}>로그인이 필요합니다</div>
          <div style={{color:T.muted,fontSize:12,marginBottom:20}}>관리자 페이지에 접근하려면 먼저 로그인하세요.</div>
          <a href="/auth" style={{display:'block',padding:'12px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}30`,borderRadius:10,fontWeight:700,fontSize:13,textDecoration:'none'}}>로그인하러 가기</a>
        </Card>
      </div>
    );
  }

  // ── Not admin (403 display + unauthorized 자동 리다이렉트) ──
  // role이 admin이 아닌 경우 4초 후 /unauthorized 페이지로 이동
  if (role !== 'admin') {
    if (typeof window !== 'undefined') {
      setTimeout(() => {
        try { window.location.href = '/unauthorized'; } catch { /* ignore */ }
      }, 4000);
    }
    return (
      <div style={{minHeight:'100vh',background:T.bg,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <Card style={{padding:32,textAlign:'center',maxWidth:360}}>
          <div style={{fontSize:40,marginBottom:12}}>🚫</div>
          <div style={{color:T.red,fontWeight:800,fontSize:16,marginBottom:8}}>접근 권한 없음</div>
          <div style={{color:T.muted,fontSize:12,marginBottom:4}}>관리자 계정만 이 페이지에 접근할 수 있습니다.</div>
          <div style={{color:T.muted,fontSize:11,marginBottom:20}}>현재 역할: <span style={{color:T.ylw}}>{role ?? '알 수 없음'}</span></div>
          <div style={{background:T.alt,borderRadius:10,padding:'10px 14px',marginBottom:20,textAlign:'left'}}>
            <div style={{color:T.sub,fontSize:10,fontWeight:700,marginBottom:4}}>관리자 승격 방법</div>
            <div style={{color:T.muted,fontSize:10,lineHeight:1.6}}>
              Supabase Dashboard → SQL Editor에서:<br/>
              <code style={{color:T.acl}}>UPDATE profiles SET role = &apos;admin&apos; WHERE email = &apos;your@email.com&apos;;</code>
            </div>
          </div>
          <a href="/" style={{display:'block',padding:'10px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,fontSize:12,textDecoration:'none'}}>← 홈으로</a>
        </Card>
      </div>
    );
  }

  // ── Admin UI ─────────────────────────────────────────────
  const TABS: {id:typeof tab; label:string}[] = [
    {id:'health',    label:'헬스'},
    {id:'stats',     label:'통계'},
    {id:'users',     label:'사용자'},
    {id:'exchange',  label:'거래소'},
    {id:'strategies',label:'전략'},
    {id:'notices',   label:'공지'},
    {id:'audit',     label:'감사 로그'},
    {id:'system',    label:'시스템'},
  ];

  return (
    <div style={{minHeight:'100vh',background:T.bg,color:T.txt}}>
      {/* Header */}
      <div style={{background:T.card,borderBottom:`1px solid ${T.border}`,padding:'14px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,zIndex:50}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <a href="/" style={{color:T.muted,fontSize:12,textDecoration:'none'}}>← 앱</a>
          <span style={{color:T.border}}>|</span>
          <span style={{color:T.grn,fontWeight:800,fontSize:14}}>🛡️ TRAIGO 관리자</span>
          <Bdg c={T.grn} ch="admin"/>
        </div>
        {actionMsg && (
          <div style={{background:actionMsg.ok?T.grn+'20':T.red+'20',color:actionMsg.ok?T.grn:T.red,
                       border:`1px solid ${actionMsg.ok?T.grn:T.red}30`,borderRadius:8,padding:'6px 12px',fontSize:11,fontWeight:700}}>
            {actionMsg.text}
          </div>
        )}
      </div>

      <div style={{maxWidth:900,margin:'0 auto',padding:'16px'}}>
        {/* Tab bar */}
        <div style={{display:'flex',gap:6,marginBottom:16,overflowX:'auto',paddingBottom:4}}>
          {TABS.map(({id,label})=>(
            <button key={id} onClick={()=>setTab(id)}
              style={{flexShrink:0,padding:'7px 14px',background:tab===id?T.acg:'transparent',
                      color:tab===id?T.acl:T.muted,border:`1px solid ${tab===id?T.acl:T.border}`,
                      borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer',whiteSpace:'nowrap'}}>
              {label}
            </button>
          ))}
        </div>

        {/* ── HEALTH TAB ────────────────────────────────── */}
        {tab==='health' && (
          <div>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:12}}>🩺 API 헬스 체크</div>
            {!health ? (
              <div style={{color:T.muted,fontSize:13}}>로딩 중...</div>
            ) : (
              <>
                <Card style={{padding:20,marginBottom:12}}>
                  <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
                    <div style={{width:12,height:12,borderRadius:6,background:health.connected?T.grn:T.red,flexShrink:0}}/>
                    <span style={{color:health.connected?T.grn:T.red,fontWeight:800,fontSize:15}}>
                      {health.connected ? 'Supabase 연결됨' : 'Supabase 연결 실패'}
                    </span>
                    {health.latencyMs != null && (
                      <Bdg c={health.latencyMs<200?T.grn:T.ylw} ch={`${health.latencyMs}ms`}/>
                    )}
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
                    {Object.entries(health.env??{}).map(([k,v])=>(
                      <div key={k} style={{background:T.alt,borderRadius:10,padding:'10px 12px'}}>
                        <div style={{color:v?T.grn:T.red,fontSize:11,fontWeight:700,marginBottom:3}}>{v?'✅':'❌'}</div>
                        <div style={{color:T.muted,fontSize:9,wordBreak:'break-all'}}>{k}</div>
                      </div>
                    ))}
                  </div>
                </Card>
                <button onClick={()=>loadTab('health')}
                  style={{padding:'8px 16px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}30`,borderRadius:8,fontWeight:700,fontSize:12,cursor:'pointer'}}>
                  🔄 새로고침
                </button>
              </>
            )}
          </div>
        )}

        {/* ── USERS TAB ─────────────────────────────────── */}
        {tab==='users' && (
          <div>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:12}}>👥 사용자 모니터링</div>
            <div style={{display:'flex',gap:8,marginBottom:12}}>
              <input value={userSearch} onChange={e=>setUserSearch(e.target.value)}
                placeholder="이메일 또는 이름 검색..."
                style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 12px',color:T.txt,fontSize:12,outline:'none'}}/>
              <button onClick={()=>loadTab('users')}
                style={{padding:'8px 14px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}30`,borderRadius:8,fontWeight:700,fontSize:12,cursor:'pointer'}}>
                검색
              </button>
            </div>
            <div style={{color:T.muted,fontSize:11,marginBottom:10}}>총 {users.length}명</div>
            {users.map(u=>(
              <Card key={u.id} style={{padding:'12px 16px',marginBottom:8,display:'flex',alignItems:'center',gap:12}}>
                <div style={{width:36,height:36,borderRadius:10,background:`${T.acc}30`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}}>
                  {u.role==='admin'?'🛡️':'👤'}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{color:T.txt,fontWeight:700,fontSize:13,marginBottom:2}}>{u.display_name??'(이름 없음)'}</div>
                  <div style={{color:T.muted,fontSize:11,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{u.email}</div>
                  <div style={{display:'flex',gap:4,marginTop:4,flexWrap:'wrap'}}>
                    <Bdg c={u.role==='admin'?T.grn:T.acl} ch={u.role}/>
                    <Bdg c={u.status==='active'?T.grn:T.red} ch={u.status}/>
                    {u.plan && <Bdg c={T.gld} ch={u.plan}/>}
                  </div>
                </div>
                {u.id !== userId && (
                  <button onClick={()=>toggleBan(u.id, u.status)}
                    style={{padding:'6px 12px',background:u.status==='banned'?T.grn+'20':T.red+'20',
                            color:u.status==='banned'?T.grn:T.red,border:`1px solid ${u.status==='banned'?T.grn:T.red}30`,
                            borderRadius:8,fontWeight:700,fontSize:11,cursor:'pointer',flexShrink:0}}>
                    {u.status==='banned'?'차단 해제':'차단'}
                  </button>
                )}
              </Card>
            ))}
            {users.length===0 && <div style={{color:T.muted,fontSize:13,textAlign:'center',padding:24}}>데이터 없음</div>}
          </div>
        )}

        {/* ── EXCHANGE TAB ──────────────────────────────── */}
        {tab==='exchange' && (
          <div>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:12}}>🔗 거래소 연결 현황</div>
            <div style={{color:T.muted,fontSize:11,marginBottom:10}}>총 {connections.length}개 연결</div>
            {connections.map(c=>(
              <Card key={c.id} style={{padding:'12px 16px',marginBottom:8}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:13}}>{c.label??c.exchange_id}</div>
                    <div style={{color:T.muted,fontSize:10,marginTop:2}}>user: {c.user_id?.slice(0,8)}...</div>
                    {c.last_tested_at && <div style={{color:T.muted,fontSize:10}}>마지막 테스트: {new Date(c.last_tested_at).toLocaleString('ko-KR')}</div>}
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    {c.test_status && <div style={{color:T.muted,fontSize:10,maxWidth:120,textAlign:'right'}}>{c.test_status}</div>}
                    <Bdg c={c.is_active?T.grn:T.red} ch={c.is_active?'활성':'비활성'}/>
                  </div>
                </div>
              </Card>
            ))}
            {connections.length===0 && <div style={{color:T.muted,fontSize:13,textAlign:'center',padding:24}}>연결된 거래소 없음</div>}
          </div>
        )}

        {/* ── STRATEGIES TAB ────────────────────────────── */}
        {tab==='strategies' && (
          <div>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:12}}>🤖 전략 상태</div>
            <div style={{color:T.muted,fontSize:11,marginBottom:10}}>총 {strategies.length}개</div>
            {strategies.map(s=>(
              <Card key={s.id} style={{padding:'12px 16px',marginBottom:8}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div>
                    <div style={{color:T.txt,fontWeight:700,fontSize:13}}>{s.name}</div>
                    <div style={{color:T.muted,fontSize:10,marginTop:2}}>{s.asset} · {s.exec_mode}</div>
                    <div style={{color:T.muted,fontSize:10}}>user: {s.user_id?.slice(0,8)}...</div>
                  </div>
                  <div style={{display:'flex',gap:6,alignItems:'center'}}>
                    <Bdg c={s.status==='running'?T.grn:s.status==='paused'?T.ylw:T.muted}
                         ch={s.status==='running'?'실행 중':s.status==='paused'?'일시 중지':'정지'}/>
                    {s.enabled && <Bdg c={T.grn} ch="활성"/>}
                  </div>
                </div>
              </Card>
            ))}
            {strategies.length===0 && <div style={{color:T.muted,fontSize:13,textAlign:'center',padding:24}}>전략 없음</div>}
          </div>
        )}

        {/* ── AUDIT TAB ─────────────────────────────────── */}
        {tab==='audit' && (
          <div>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:12}}>📋 감사 로그</div>
            {auditLogs.map(log=>(
              <Card key={log.id} style={{padding:'10px 14px',marginBottom:6}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8}}>
                  <div style={{flex:1}}>
                    <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:4}}>
                      <Bdg c={log.result==='success'?T.grn:T.red} ch={log.action}/>
                      {log.result && <Bdg c={log.result==='success'?T.grn:T.ylw} ch={log.result}/>}
                    </div>
                    {log.details && <div style={{color:T.muted,fontSize:10,marginTop:2}}>{JSON.stringify(log.details).slice(0,120)}</div>}
                    <div style={{color:T.muted,fontSize:10,marginTop:2}}>actor: {log.actor_id?.slice(0,8)??'system'}...</div>
                  </div>
                  <div style={{color:T.muted,fontSize:10,whiteSpace:'nowrap',flexShrink:0}}>
                    {new Date(log.created_at).toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
                  </div>
                </div>
              </Card>
            ))}
            {auditLogs.length===0 && <div style={{color:T.muted,fontSize:13,textAlign:'center',padding:24}}>로그 없음</div>}
          </div>
        )}

        {/* ── STATS TAB ──────────────────────────────────── */}
        {tab==='stats' && (
          <div>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:12,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <span>통계 대시보드</span>
              <button onClick={() => loadTab('stats')}
                style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:7,padding:'5px 12px',minHeight:30,fontSize:10,fontWeight:700,cursor:'pointer'}}>새로고침</button>
            </div>

            {!stats ? (
              <div style={{color:T.muted,fontSize:13,textAlign:'center',padding:24}}>로딩 중…</div>
            ) : (
              <>
                {/* 사용자 통계 */}
                <Card style={{padding:18,marginBottom:12}}>
                  <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>사용자</div>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10}}>
                    {[
                      { label: '전체',         val: stats.users.total,     color: T.acl },
                      { label: '24h 활동',     val: stats.users.active24h, color: T.grn },
                      { label: '7일 신규',     val: stats.users.new7d,     color: T.ylw },
                      { label: '정지',         val: stats.users.banned,    color: T.red },
                    ].map(m => (
                      <div key={m.label} style={{background:T.alt,padding:'10px 12px',borderRadius:10,borderTop:`2px solid ${m.color}`}}>
                        <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:3}}>{m.label}</div>
                        <div style={{color:m.color,fontSize:20,fontWeight:900,fontFamily:'monospace'}}>{m.val.toLocaleString('ko-KR')}</div>
                      </div>
                    ))}
                  </div>
                </Card>

                {/* 전략 통계 */}
                <Card style={{padding:18,marginBottom:12}}>
                  <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>전략</div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                    <div style={{background:T.alt,padding:'10px 12px',borderRadius:10,borderTop:`2px solid ${T.acl}`}}>
                      <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:3}}>전체 전략</div>
                      <div style={{color:T.acl,fontSize:20,fontWeight:900,fontFamily:'monospace'}}>{stats.strategies.total.toLocaleString('ko-KR')}</div>
                    </div>
                    <div style={{background:T.alt,padding:'10px 12px',borderRadius:10,borderTop:`2px solid ${T.grn}`}}>
                      <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:3}}>활성 전략</div>
                      <div style={{color:T.grn,fontSize:20,fontWeight:900,fontFamily:'monospace'}}>{stats.strategies.active.toLocaleString('ko-KR')}</div>
                    </div>
                  </div>
                </Card>

                {/* 활동 통계 */}
                <Card style={{padding:18,marginBottom:12}}>
                  <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>24시간 활동</div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
                    <div style={{background:T.alt,padding:'10px 12px',borderRadius:10,borderTop:`2px solid ${T.prp}`}}>
                      <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:3}}>거래소 연결</div>
                      <div style={{color:T.prp,fontSize:18,fontWeight:900,fontFamily:'monospace'}}>{stats.exchanges.total.toLocaleString('ko-KR')}</div>
                    </div>
                    <div style={{background:T.alt,padding:'10px 12px',borderRadius:10,borderTop:`2px solid ${T.ylw}`}}>
                      <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:3}}>봇 이벤트</div>
                      <div style={{color:T.ylw,fontSize:18,fontWeight:900,fontFamily:'monospace'}}>{stats.activity.botEvents24h.toLocaleString('ko-KR')}</div>
                    </div>
                    <div style={{background:T.alt,padding:'10px 12px',borderRadius:10,borderTop:`2px solid ${T.acl}`}}>
                      <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:3}}>감사 로그</div>
                      <div style={{color:T.acl,fontSize:18,fontWeight:900,fontFamily:'monospace'}}>{stats.activity.auditEvents24h.toLocaleString('ko-KR')}</div>
                    </div>
                  </div>
                </Card>

                <div style={{color:T.muted,fontSize:10,textAlign:'center',marginTop:8}}>
                  최종 갱신: {new Date(stats.generatedAt).toLocaleString('ko-KR')}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── NOTICES TAB ────────────────────────────────── */}
        {tab==='notices' && (
          <NoticesPanel
            notices={notices}
            token={token}
            apiCall={apiCall}
            onChange={() => loadTab('notices')}
            showMsg={showMsg}
          />
        )}

        {/* ── SYSTEM TAB ────────────────────────────────── */}
        {tab==='system' && (
          <div>
            <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:12}}>⚙️ 시스템 제어</div>

            {/* Maintenance mode */}
            <Card style={{padding:20,marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <div>
                  <div style={{color:T.txt,fontWeight:700,fontSize:13}}>🔧 유지보수 모드</div>
                  <div style={{color:T.muted,fontSize:11,marginTop:2}}>활성화 시 일반 사용자 접근 제한 (플레이스홀더)</div>
                </div>
                <Toggle on={maintenance} onChange={v=>toggleMaintenance(v)}/>
              </div>
              {maintenance && <Bdg c={T.ylw} ch="🔧 유지보수 모드 활성화 중"/>}
            </Card>

            {/* Emergency bot stop */}
            <Card style={{padding:20,border:`1px solid ${T.red}30`,background:T.red+'05'}}>
              <div style={{color:T.red,fontWeight:800,fontSize:13,marginBottom:6}}>🚨 긴급 전략 전체 정지</div>
              <div style={{color:T.muted,fontSize:11,marginBottom:14}}>
                실행 중인 모든 자동매매 전략을 즉시 중지합니다. 이 작업은 되돌릴 수 없습니다.
              </div>
              {!killConfirm ? (
                <button onClick={()=>setKillCon(true)}
                  style={{padding:'10px 20px',background:T.red+'20',color:T.red,border:`1px solid ${T.red}40`,borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer'}}>
                  🛑 긴급 정지 실행
                </button>
              ) : (
                <div>
                  <div style={{color:T.red,fontWeight:700,fontSize:12,marginBottom:10}}>⚠️ 정말 모든 봇을 정지하겠습니까?</div>
                  <div style={{display:'flex',gap:8}}>
                    <button onClick={emergencyStop}
                      style={{padding:'10px 20px',background:T.red,color:'#fff',border:'none',borderRadius:10,fontWeight:800,fontSize:13,cursor:'pointer'}}>
                      확인 — 전체 정지
                    </button>
                    <button onClick={()=>setKillCon(false)}
                      style={{padding:'10px 16px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontWeight:700,fontSize:13,cursor:'pointer'}}>
                      취소
                    </button>
                  </div>
                </div>
              )}
            </Card>

            <Card style={{padding:16,marginTop:12,background:T.alt}}>
              <div style={{color:T.sub,fontSize:11,fontWeight:700,marginBottom:6}}>🔒 관리자 승격 방법</div>
              <div style={{color:T.muted,fontSize:10,lineHeight:1.8}}>
                프론트엔드에서 관리자 역할을 부여할 수 없습니다.<br/>
                Supabase Dashboard → SQL Editor에서 직접 실행하세요:<br/>
                <code style={{color:T.acl,display:'block',marginTop:4,background:T.surf,padding:'6px 10px',borderRadius:6}}>
                  UPDATE profiles<br/>
                  SET role = &apos;admin&apos;<br/>
                  WHERE email = &apos;user@example.com&apos;;
                </code>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}


// ─── NoticesPanel — 공지 관리 ───────────────────────────────
function NoticesPanel({
  notices, token, apiCall, onChange, showMsg,
}: {
  notices: any[];
  token: string | null;
  apiCall: (action: string, tk: string, method?: 'GET'|'POST', body?: any) => Promise<any>;
  onChange: () => void;
  showMsg: (text: string, ok: boolean) => void;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [level, setLevel] = useState<'info'|'warning'|'critical'>('info');
  const [showTo, setShowTo] = useState<'all'|'pro'|'admin'>('all');

  const create = async () => {
    if (!token || !title.trim() || !body.trim()) {
      showMsg('제목과 본문을 입력하세요', false);
      return;
    }
    try {
      await apiCall('notice_create', token, 'POST', { action:'notice_create', title, body, level, show_to: showTo, active: true });
      showMsg('공지 생성 완료', true);
      setTitle(''); setBody(''); setShowCreate(false);
      onChange();
    } catch (e: any) {
      showMsg(`실패: ${e?.message || 'unknown'}`, false);
    }
  };

  const toggleActive = async (id: string, active: boolean) => {
    if (!token) return;
    try {
      await apiCall('notice_update', token, 'POST', { action:'notice_update', id, active: !active });
      onChange();
    } catch (e: any) { showMsg(`실패: ${e?.message}`, false); }
  };

  const remove = async (id: string) => {
    if (!token) return;
    if (!(await confirmDialog('이 공지를 삭제하시겠습니까?', { danger: true }))) return;
    try {
      await apiCall('notice_delete', token, 'POST', { action:'notice_delete', id });
      showMsg('삭제 완료', true);
      onChange();
    } catch (e: any) { showMsg(`실패: ${e?.message}`, false); }
  };

  const levelColor = (lv: string) => lv === 'critical' ? T.red : lv === 'warning' ? T.ylw : T.acl;

  return (
    <div>
      <div style={{color:T.txt,fontWeight:800,fontSize:15,marginBottom:12,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <span>공지 관리 ({notices.length})</span>
        <button onClick={() => setShowCreate(v => !v)}
          style={{background:showCreate?T.muted+'20':T.acg,color:showCreate?T.muted:T.acl,border:`1px solid ${showCreate?T.muted:T.acl}40`,borderRadius:7,padding:'7px 14px',minHeight:32,fontSize:11,fontWeight:700,cursor:'pointer'}}>
          {showCreate ? '취소' : '+ 새 공지'}
        </button>
      </div>

      {/* 생성 폼 */}
      {showCreate && (
        <Card style={{padding:18,marginBottom:14,border:`1px solid ${T.acl}30`}}>
          <div style={{marginBottom:8}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>제목</div>
            <input value={title} onChange={e => setTitle(e.target.value)} maxLength={120}
              style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:12,outline:'none'}}/>
          </div>
          <div style={{marginBottom:8}}>
            <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>본문 (Markdown 일부 가능)</div>
            <textarea value={body} onChange={e => setBody(e.target.value)} maxLength={2000} rows={4}
              style={{width:'100%',background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',color:T.txt,fontSize:12,outline:'none',resize:'vertical',fontFamily:'inherit'}}/>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
            <div>
              <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>중요도</div>
              <div style={{display:'flex',gap:4}}>
                {(['info','warning','critical'] as const).map(l => (
                  <button key={l} onClick={() => setLevel(l)} type="button"
                    style={{flex:1,minHeight:34,background:level===l?levelColor(l)+'22':T.alt,color:level===l?levelColor(l):T.muted,border:`1px solid ${level===l?levelColor(l):T.border}`,borderRadius:7,padding:'6px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
                    {l==='info'?'정보':l==='warning'?'경고':'심각'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:4}}>대상</div>
              <div style={{display:'flex',gap:4}}>
                {(['all','pro','admin'] as const).map(s => (
                  <button key={s} onClick={() => setShowTo(s)} type="button"
                    style={{flex:1,minHeight:34,background:showTo===s?T.acg:T.alt,color:showTo===s?T.acl:T.muted,border:`1px solid ${showTo===s?T.acl:T.border}`,borderRadius:7,padding:'6px',fontSize:10,fontWeight:700,cursor:'pointer'}}>
                    {s==='all'?'전체':s==='pro'?'Pro':'관리자'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <button onClick={create} type="button"
            style={{width:'100%',padding:'12px',minHeight:44,background:T.acl,color:'#fff',border:'none',borderRadius:8,fontSize:12,fontWeight:800,cursor:'pointer'}}>
            공지 발행
          </button>
        </Card>
      )}

      {/* 공지 리스트 */}
      {notices.length === 0 ? (
        <div style={{color:T.muted,fontSize:13,textAlign:'center',padding:24}}>공지 없음</div>
      ) : (
        notices.map((n: any) => (
          <Card key={n.id} style={{padding:14,marginBottom:8,borderLeft:`3px solid ${levelColor(n.level)}`,opacity:n.active?1:0.5}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8,marginBottom:6}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:'flex',gap:5,alignItems:'center',marginBottom:3,flexWrap:'wrap'}}>
                  <span style={{padding:'2px 7px',borderRadius:4,fontSize:9,fontWeight:800,background:levelColor(n.level)+'22',color:levelColor(n.level)}}>
                    {n.level==='critical'?'심각':n.level==='warning'?'경고':'정보'}
                  </span>
                  <span style={{padding:'2px 7px',borderRadius:4,fontSize:9,fontWeight:700,background:T.alt,color:T.muted}}>
                    {n.show_to==='all'?'전체':n.show_to==='pro'?'Pro':'관리자'}
                  </span>
                  {!n.active && <span style={{padding:'2px 7px',borderRadius:4,fontSize:9,fontWeight:700,background:T.muted+'22',color:T.muted}}>비활성</span>}
                </div>
                <div style={{color:T.txt,fontWeight:800,fontSize:13,marginBottom:3}}>{n.title}</div>
                <div style={{color:T.sub,fontSize:11,lineHeight:1.5,whiteSpace:'pre-wrap'}}>{n.body}</div>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:4,flexShrink:0}}>
                <button onClick={() => toggleActive(n.id, n.active)} type="button"
                  style={{background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,padding:'5px 10px',minHeight:28,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  {n.active?'비활성':'활성'}
                </button>
                <button onClick={() => remove(n.id)} type="button"
                  style={{background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:6,padding:'5px 10px',minHeight:28,fontSize:10,fontWeight:700,cursor:'pointer'}}>
                  삭제
                </button>
              </div>
            </div>
            <div style={{color:T.muted,fontSize:9,marginTop:6}}>
              생성: {new Date(n.created_at).toLocaleString('ko-KR')}
              {n.ends_at && ` · 만료: ${new Date(n.ends_at).toLocaleString('ko-KR')}`}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
