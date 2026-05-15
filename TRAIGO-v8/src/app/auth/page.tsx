'use client';
import React, { useState, useEffect } from 'react';
import {
  UserProfile, getMockSession, clearMockSession, setMockSession,
  mockSignIn, mockSignUp, mockRedeemCode,
  MOCK_USERS, MOCK_INVITE_CODES, ROLE_INFO, canAccessAdmin,
} from '@/lib/auth';
import { SUPABASE_CONFIGURED, sbSignIn, sbSignUp, sbSignOut, sbResetPassword, getProfile, redeemCode } from '@/lib/supabase';

const T = {
  bg:'#060B14', card:'#0F1924', border:'#1A2D4A', border2:'#243A5E',
  acc:'#2563EB', acl:'#3B82F6', acg:'rgba(37,99,235,.15)',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B', prp:'#7C3AED',
  txt:'#F0F6FF', sub:'#94A3B8', muted:'#475569', surf:'#0D1626',
};

type AuthMode = 'login'|'signup'|'reset'|'profile'|'redeem';

export default function AuthPage() {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [redeemCodeVal, setRedeemCodeVal] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [session, setSession] = useState<UserProfile|null>(null);
  const [showDevAccounts, setShowDevAccounts] = useState(false);

  const isSupabase = SUPABASE_CONFIGURED;

  useEffect(() => {
    if (isSupabase) {
      // Check Supabase session
      import('@/lib/supabase').then(async ({ sbGetSession, getProfile }) => {
        try {
          const sbSession = await sbGetSession();
          if (sbSession?.user) {
            const profile = await getProfile(sbSession.user.id);
            if (profile) { setSession(profile); setMode('profile'); }
          }
        } catch {}
      });
    } else {
      const s = getMockSession();
      if (s) { setSession(s); setMode('profile'); }
    }
  }, [isSupabase]);

  const reset = () => { setError(''); setSuccess(''); };

  const handleLogin = async () => {
    reset();
    if (!email || !password) { setError('이메일과 비밀번호를 입력하세요.'); return; }
    setLoading(true);
    if (isSupabase) {
      const { profile, error: err } = await sbSignIn(email, password);
      setLoading(false);
      if (err) { setError(err); return; }
      if (profile) {
        setSession(profile);
        setSuccess('로그인 성공!');
        setTimeout(() => {
          if (canAccessAdmin(profile.role)) window.location.href = '/admin';
          else window.location.href = '/';
        }, 700);
      }
    } else {
      const { user, error: err } = await mockSignIn(email, password);
      setLoading(false);
      if (err) { setError(err); return; }
      if (user) {
        setSession(user);
        setSuccess('로그인 성공! (Mock 모드)');
        setTimeout(() => {
          if (canAccessAdmin(user.role)) window.location.href = '/admin';
          else window.location.href = '/';
        }, 700);
      }
    }
  };

  const handleSignup = async () => {
    reset();
    if (!email || !password || !displayName) { setError('모든 항목을 입력하세요.'); return; }
    if (password.length < 8) { setError('비밀번호는 8자 이상이어야 합니다.'); return; }
    setLoading(true);
    if (isSupabase) {
      const { error: err } = await sbSignUp(email, password, displayName);
      setLoading(false);
      if (err) { setError(err); return; }
      setSuccess('가입 완료! 이메일을 확인하여 계정을 인증하세요.');
    } else {
      const { user, error: err } = await mockSignUp(email, password, displayName);
      setLoading(false);
      if (err) { setError(err); return; }
      if (user) {
        setSession(user);
        setSuccess('가입 완료! (Mock 모드)');
        setTimeout(() => { window.location.href = '/'; }, 800);
      }
    }
  };

  const handleReset = async () => {
    reset();
    if (!email) { setError('이메일을 입력하세요.'); return; }
    setLoading(true);
    if (isSupabase) {
      const { error: err } = await sbResetPassword(email);
      setLoading(false);
      if (err) { setError(err); return; }
      setSuccess('비밀번호 재설정 이메일을 발송했습니다.');
    } else {
      setLoading(false);
      setSuccess('비밀번호 재설정 이메일 발송 (Supabase 연결 후 활성화)');
    }
  };

  const handleRedeem = async () => {
    reset();
    if (!redeemCodeVal.trim()) { setError('코드를 입력하세요.'); return; }
    setLoading(true);
    if (isSupabase && session) {
      const result = await redeemCode(redeemCodeVal, session.id);
      setLoading(false);
      if (!result.success) { setError((result as any).error || '유효하지 않은 코드'); return; }
      const updated = { ...session, plan: (result as any).plan, role: (result as any).role };
      setSession(updated);
      setSuccess(`"${redeemCodeVal.toUpperCase()}" 적용 완료! ${result.plan} 플랜 활성화.`);
    } else {
      const result = await mockRedeemCode(redeemCodeVal, session?.id || 'guest');
      setLoading(false);
      if (!result.success) { setError(result.error || '유효하지 않은 코드'); return; }
      if (session) {
        const updated = { ...session, plan: result.plan!, role: result.role! };
        setMockSession(updated); setSession(updated);
      }
      setSuccess(`"${redeemCodeVal.toUpperCase()}" 적용 완료! ${result.plan} 플랜 활성화.`);
      setRedeemCodeVal('');
    }
  };

  const handleLogout = async () => {
    if (isSupabase) await sbSignOut();
    clearMockSession();
    setSession(null); setMode('login');
    setTimeout(() => { window.location.href = '/'; }, 300);
  };

  const quickLogin = async (u: UserProfile) => {
    setLoading(true);
    setMockSession(u); setSession(u);
    setLoading(false);
    setSuccess(`${u.displayName} (${u.role}) 로그인!`);
    setTimeout(() => {
      if (canAccessAdmin(u.role)) window.location.href = '/admin';
      else window.location.href = '/';
    }, 500);
  };

  const roleColor = session ? ROLE_INFO[session.role].color : T.acl;
  const roleIcon  = session ? ROLE_INFO[session.role].icon  : '👤';

  return (
    <div style={{minHeight:'100vh',background:T.bg,display:'flex',alignItems:'center',justifyContent:'center',padding:20,fontFamily:"'Sora',sans-serif"}}>
      <div style={{width:'100%',maxWidth:420}}>

        {/* Logo */}
        <div style={{textAlign:'center',marginBottom:28}}>
          <div style={{width:60,height:60,borderRadius:16,background:'linear-gradient(135deg,#2563EB,#7C3AED)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:28,fontWeight:900,color:'#fff',margin:'0 auto 10px'}}>T</div>
          <div style={{color:T.txt,fontWeight:900,fontSize:20}}>TRAIGO</div>
          <div style={{color:T.muted,fontSize:11,marginTop:3}}>글로벌 투자 시뮬레이션 · 모의투자 전용</div>
          {isSupabase
            ? <div style={{background:T.grn+'15',border:`1px solid ${T.grn}30`,borderRadius:8,padding:'4px 10px',marginTop:8,display:'inline-block'}}><span style={{color:T.grn,fontSize:10,fontWeight:700}}>✅ Supabase 연결됨</span></div>
            : <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:8,padding:'4px 10px',marginTop:8,display:'inline-block'}}><span style={{color:T.ylw,fontSize:10,fontWeight:700}}>🔧 Mock 모드 — Supabase 미연결</span></div>
          }
        </div>

        {/* Profile view */}
        {mode === 'profile' && session && (
          <div>
            <div style={{background:T.card,border:`1px solid ${roleColor}40`,borderRadius:20,padding:20,marginBottom:12}}>
              <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16}}>
                <div style={{width:50,height:50,borderRadius:14,background:`linear-gradient(135deg,${roleColor},${roleColor}88)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22}}>{roleIcon}</div>
                <div>
                  <div style={{color:T.txt,fontWeight:800,fontSize:15}}>{session.displayName}</div>
                  <div style={{color:T.muted,fontSize:11}}>{session.email}</div>
                  <div style={{display:'flex',gap:4,marginTop:4,flexWrap:'wrap'}}>
                    <span style={{background:`${roleColor}20`,color:roleColor,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99,border:`1px solid ${roleColor}40`}}>{ROLE_INFO[session.role].icon} {ROLE_INFO[session.role].label}</span>
                    {session.badges.map(b=><span key={b} style={{background:`${T.ylw}15`,color:T.ylw,fontSize:9,fontWeight:700,padding:'2px 6px',borderRadius:99}}>{b}</span>)}
                  </div>
                </div>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                {canAccessAdmin(session.role)&&<a href="/admin" style={{display:'block',padding:'11px',background:`${roleColor}15`,color:roleColor,border:`1px solid ${roleColor}40`,borderRadius:12,fontWeight:700,fontSize:13,textDecoration:'none',textAlign:'center'}}>{ROLE_INFO[session.role].icon} 관리자 대시보드 →</a>}
                {(session.role==='developer'||session.role==='super_admin')&&<a href="/developer" style={{display:'block',padding:'11px',background:`${T.prp}15`,color:T.prp,border:`1px solid ${T.prp}40`,borderRadius:12,fontWeight:700,fontSize:13,textDecoration:'none',textAlign:'center'}}>⚙️ 개발자 대시보드 →</a>}
                <a href="/" style={{display:'block',padding:'11px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:12,fontWeight:700,fontSize:13,textDecoration:'none',textAlign:'center'}}>🏠 메인으로</a>
                <button onClick={()=>setMode('redeem')} style={{padding:'10px',background:'transparent',color:T.prp,border:`1px solid ${T.prp}40`,borderRadius:12,fontWeight:700,fontSize:12,cursor:'pointer'}}>🎟️ 초대 코드 입력</button>
                <button onClick={handleLogout} style={{padding:'10px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:600,fontSize:12,cursor:'pointer'}}>로그아웃</button>
              </div>
            </div>
            {success&&<div style={{background:`${T.grn}15`,border:`1px solid ${T.grn}40`,borderRadius:10,padding:'10px 14px',color:T.grn,fontSize:12}}>✅ {success}</div>}
          </div>
        )}

        {/* Redeem */}
        {mode==='redeem'&&(
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:24}}>
            <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:14}}>
              <button onClick={()=>setMode('profile')} style={{background:'transparent',border:'none',color:T.muted,cursor:'pointer',fontSize:18}}>←</button>
              <div style={{color:T.txt,fontWeight:800,fontSize:16}}>🎟️ 초대 코드 입력</div>
            </div>
            <input value={redeemCodeVal} onChange={e=>setRedeemCodeVal(e.target.value.toUpperCase())} onKeyDown={e=>e.key==='Enter'&&handleRedeem()} placeholder="예: FRIEND-LIFETIME" style={{width:'100%',background:T.bg,border:`1px solid ${T.border2}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:14,fontFamily:'monospace',fontWeight:700,outline:'none',marginBottom:10,letterSpacing:1}}/>
            {!isSupabase&&(
              <div style={{background:T.bg,borderRadius:8,padding:'10px 12px',marginBottom:10,border:`1px solid ${T.border}`}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>💡 테스트 코드</div>
                {MOCK_INVITE_CODES.filter(c=>c.active).map(c=>(
                  <div key={c.id} onClick={()=>setRedeemCodeVal(c.code)} style={{display:'flex',justifyContent:'space-between',padding:'5px 0',cursor:'pointer',borderBottom:`1px solid ${T.border}`}}>
                    <span style={{color:T.acl,fontSize:10,fontFamily:'monospace'}}>{c.code}</span>
                    <span style={{color:T.muted,fontSize:9}}>{c.plan}</span>
                  </div>
                ))}
              </div>
            )}
            {error&&<div style={{background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:10,padding:'10px 14px',marginBottom:10,color:T.red,fontSize:12}}>❌ {error}</div>}
            {success&&<div style={{background:`${T.grn}15`,border:`1px solid ${T.grn}40`,borderRadius:10,padding:'10px 14px',marginBottom:10,color:T.grn,fontSize:12}}>✅ {success}</div>}
            <button onClick={handleRedeem} disabled={loading||!redeemCodeVal.trim()} style={{width:'100%',padding:'13px',background:loading?'#243A5E':`linear-gradient(135deg,${T.prp},#5B21B6)`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>
              {loading?'확인 중...':'코드 적용'}
            </button>
          </div>
        )}

        {/* Login / Signup / Reset */}
        {(mode==='login'||mode==='signup'||mode==='reset')&&!session&&(
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:24}}>
            <div style={{display:'flex',gap:6,marginBottom:18}}>
              {(['login','signup'] as const).map(m=>(
                <button key={m} onClick={()=>{setMode(m);reset();}} style={{flex:1,padding:'10px',background:mode===m?T.acg:'transparent',color:mode===m?T.acl:T.muted,border:`1px solid ${mode===m?T.acl:T.border}`,borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer'}}>
                  {m==='login'?'로그인':'회원가입'}
                </button>
              ))}
            </div>

            {!isSupabase&&(
              <div style={{background:`${T.ylw}12`,border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'8px 12px',marginBottom:14}}>
                <div style={{color:T.ylw,fontWeight:700,fontSize:10}}>🔧 Mock 모드 — .env.local에 Supabase 키를 추가하면 실제 인증이 활성화됩니다</div>
              </div>
            )}

            {mode==='signup'&&(
              <div style={{marginBottom:12}}>
                <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:5}}>닉네임</div>
                <input value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="표시 이름" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:13,outline:'none'}}/>
              </div>
            )}

            <div style={{marginBottom:12}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:5}}>이메일</div>
              <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="your@email.com" style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:13,outline:'none'}}/>
            </div>

            {mode!=='reset'&&(
              <div style={{marginBottom:16}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:5}}>
                  <span style={{color:T.muted,fontSize:11,fontWeight:700}}>비밀번호</span>
                  {mode==='login'&&<button onClick={()=>{setMode('reset');reset();}} style={{background:'none',border:'none',color:T.acl,fontSize:10,cursor:'pointer'}}>비밀번호 찾기</button>}
                </div>
                <input type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==='Enter'&&(mode==='login'?handleLogin():handleSignup())} placeholder={mode==='signup'?'8자 이상':'비밀번호'} style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:13,outline:'none'}}/>
              </div>
            )}

            {mode==='reset'&&(
              <div style={{background:T.acg,border:`1px solid ${T.acl}30`,borderRadius:10,padding:'10px 12px',marginBottom:14}}>
                <div style={{color:T.acl,fontSize:11}}>{isSupabase?'이메일로 비밀번호 재설정 링크를 발송합니다.':'Supabase 연결 후 이 기능이 활성화됩니다.'}</div>
              </div>
            )}

            {/* Password strength indicator */}
            {mode==='signup'&&password.length>0&&(
              <div style={{marginBottom:12}}>
                <div style={{display:'flex',gap:3,marginBottom:3}}>
                  {[8,12,20].map((min,i)=>(
                    <div key={min} style={{flex:1,height:3,borderRadius:2,background:password.length>=min?[T.red,T.ylw,T.grn][i]:'#1A2D4A'}}/>
                  ))}
                </div>
                <div style={{color:password.length>=20?T.grn:password.length>=12?T.ylw:T.red,fontSize:9}}>
                  {password.length>=20?'강력한 비밀번호':password.length>=12?'보통':password.length>=8?'약함':'최소 8자 필요'}
                </div>
              </div>
            )}

            {error&&<div style={{background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:10,padding:'10px 14px',marginBottom:12,color:T.red,fontSize:12}}>❌ {error}</div>}
            {success&&<div style={{background:`${T.grn}15`,border:`1px solid ${T.grn}40`,borderRadius:10,padding:'10px 14px',marginBottom:12,color:T.grn,fontSize:12}}>✅ {success}</div>}

            <button onClick={mode==='login'?handleLogin:mode==='signup'?handleSignup:handleReset} disabled={loading} style={{width:'100%',padding:'14px',background:loading?'#243A5E':`linear-gradient(135deg,${T.acc},${T.prp})`,color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer',marginBottom:12}}>
              {loading?'처리 중...':mode==='login'?'로그인':mode==='signup'?'회원가입':'재설정 메일 발송'}
            </button>

            {mode==='login'&&(
              <div style={{textAlign:'center',color:T.muted,fontSize:11}}>
                계정이 없으신가요?{' '}
                <button onClick={()=>setMode('signup')} style={{background:'none',border:'none',color:T.acl,cursor:'pointer',fontSize:11,fontWeight:700}}>회원가입</button>
              </div>
            )}
            <a href="/" style={{display:'block',textAlign:'center',color:T.muted,fontSize:11,textDecoration:'none',marginTop:8}}>← 메인으로 (로그인 없이 사용)</a>
          </div>
        )}

        {/* Dev quick login (mock mode only) */}
        {!isSupabase&&(mode==='login'||mode==='signup')&&!session&&(
          <div style={{marginTop:12}}>
            <button onClick={()=>setShowDevAccounts(v=>!v)} style={{width:'100%',background:T.surf,border:`1px solid ${T.border}`,borderRadius:12,padding:'10px 14px',color:T.muted,fontSize:11,fontWeight:700,cursor:'pointer',display:'flex',justifyContent:'space-between'}}>
              <span>🔧 개발용 테스트 계정 {showDevAccounts?'숨기기':'보기'}</span>
              <span>{showDevAccounts?'▲':'▼'}</span>
            </button>
            {showDevAccounts&&(
              <div style={{background:T.surf,border:`1px solid ${T.border}`,borderRadius:12,marginTop:6,overflow:'hidden'}}>
                {MOCK_USERS.filter(u=>u.status!=='banned').map((u,i,arr)=>{
                  const ri=ROLE_INFO[u.role];
                  return (
                    <button key={u.id} onClick={()=>quickLogin(u)} style={{width:'100%',display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 14px',background:'transparent',border:'none',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none',cursor:'pointer',textAlign:'left'}}>
                      <div>
                        <div style={{display:'flex',gap:5,alignItems:'center'}}>
                          <span style={{fontSize:13}}>{ri.icon}</span>
                          <span style={{color:T.txt,fontSize:12,fontWeight:600}}>{u.displayName}</span>
                          <span style={{background:`${ri.color}20`,color:ri.color,fontSize:9,fontWeight:700,padding:'1px 6px',borderRadius:99}}>{ri.label}</span>
                        </div>
                        <div style={{color:T.muted,fontSize:10,marginTop:1,marginLeft:21}}>{u.email}</div>
                      </div>
                      <span style={{color:T.acl,fontSize:11}}>→</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div style={{textAlign:'center',marginTop:14,color:T.muted,fontSize:10}}>모의투자 전용 · 실제 거래 없음 · 수익 보장 없음</div>
      </div>
    </div>
  );
}
