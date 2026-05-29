'use client';
import React, { useState, useEffect, useCallback } from 'react';
import {
  UserProfile, checkPasswordStrength, isValidEmail, getKoreanError,
  getMockSession, setMockSession, clearMockSession,
  mockSignIn, mockSignUp, mockRedeemCode,
  MOCK_USERS, MOCK_INVITE_CODES, ROLE_INFO, canAccessAdmin, canAccessDeveloper,
} from '@/lib/auth';
import {
  SUPABASE_CONFIGURED, sbSignIn, sbSignUp, sbSignOut,
  sbGetSession, sbResetPassword, sbUpdatePassword, getProfile, redeemCode,
} from '@/lib/supabase';

const T = {
  bg:'#060B14', card:'#0F1924', border:'#1A2D4A', border2:'#243A5E',
  acc:'#2563EB', acl:'#3B82F6', acg:'rgba(37,99,235,.15)',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B', prp:'#7C3AED',
  txt:'#F0F6FF', sub:'#94A3B8', muted:'#475569', surf:'#0D1626',
};

type AuthMode = 'login' | 'signup' | 'reset' | 'profile' | 'redeem' | 'security';

/* ── Eye toggle password input ── */
function PasswordInput({
  value, onChange, placeholder, label, onEnter, id,
}: {
  value: string; onChange: (v: string) => void;
  placeholder?: string; label?: string; onEnter?: () => void; id?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      {label && <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:5}}>{label}</div>}
      <div style={{position:'relative'}}>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onEnter?.()}
          placeholder={placeholder || '비밀번호'}
          autoComplete="current-password"
          style={{
            width:'100%', background:T.card, border:`1px solid ${T.border}`,
            borderRadius:10, padding:'12px 44px 12px 14px',
            color:T.txt, fontSize:13, outline:'none',
          }}
        />
        <button
          type="button"
          onClick={() => setShow(v => !v)}
          style={{
            position:'absolute', right:12, top:'50%', transform:'translateY(-50%)',
            background:'none', border:'none', cursor:'pointer',
            color:T.muted, fontSize:14, lineHeight:1,
          }}
          aria-label={show ? '비밀번호 숨기기' : '비밀번호 보기'}
        >
          {show ? '🙈' : '👁'}
        </button>
      </div>
    </div>
  );
}

/* ── Password strength meter ── */
function StrengthMeter({ password }: { password: string }) {
  if (!password) return null;
  const { score, label, color, hints } = checkPasswordStrength(password);
  return (
    <div style={{marginTop:6}}>
      <div style={{display:'flex',gap:3,marginBottom:4}}>
        {[1,2,3,4].map(i => (
          <div key={i} style={{flex:1,height:3,borderRadius:2,background:score>=i?color:'#1A2D4A',transition:'background .2s'}}/>
        ))}
      </div>
      {label && (
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
          <span style={{color,fontSize:10,fontWeight:700}}>{label}</span>
        </div>
      )}
      {hints.slice(0,2).map(h => (
        <div key={h} style={{color:T.muted,fontSize:10,display:'flex',gap:4,alignItems:'center',marginTop:2}}>
          <span style={{color:T.ylw}}>•</span>{h}
        </div>
      ))}
    </div>
  );
}

/* ── Toast component ── */
function Toast({ msg, type, onClose }: { msg:string; type:'success'|'error'|'info'; onClose:()=>void }) {
  const color = type==='success'?T.grn:type==='error'?T.red:T.acl;
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{
      position:'fixed',top:16,left:'50%',transform:'translateX(-50%)',zIndex:999,
      background:T.surf,border:`1px solid ${color}40`,borderRadius:12,
      padding:'12px 16px',maxWidth:340,width:'calc(100% - 32px)',
      display:'flex',gap:10,alignItems:'center',boxShadow:'0 4px 20px rgba(0,0,0,.4)',
    }}>
      <span style={{fontSize:16}}>{type==='success'?'✅':type==='error'?'❌':'ℹ️'}</span>
      <span style={{color:T.txt,fontSize:12,flex:1}}>{msg}</span>
      <button onClick={onClose} style={{background:'none',border:'none',color:T.muted,cursor:'pointer',fontSize:16}}>✕</button>
    </div>
  );
}

/* ── Main Auth Page ── */
export default function AuthPage() {
  const [mode, setMode]               = useState<AuthMode>('login');
  const [email, setEmail]             = useState('');
  const [password, setPassword]       = useState('');
  const [confirmPw, setConfirmPw]     = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode]   = useState('');
  const [redeemVal, setRedeemVal]     = useState('');
  const [keepLogin, setKeepLogin]     = useState(true);
  const [loading, setLoading]         = useState(false);
  const [session, setSession]         = useState<UserProfile | null>(null);
  const [toast, setToast]             = useState<{msg:string;type:'success'|'error'|'info'}|null>(null);
  const [showDevAccounts, setShowDevAccounts] = useState(false);
  const [newPw, setNewPw]             = useState('');
  const [confirmNewPw, setConfirmNewPw] = useState('');

  const showToast = (msg: string, type: 'success'|'error'|'info' = 'info') => setToast({msg,type});

  // ── Validation ────────────────────────────────────────────
  const emailOk    = !email || isValidEmail(email);
  const pwStrength = checkPasswordStrength(password);
  const pwMatch    = !confirmPw || password === confirmPw;
  const canSignup  = isValidEmail(email) && pwStrength.isValid && password === confirmPw && displayName.trim().length >= 2;
  const canLogin   = isValidEmail(email) && password.length >= 4;

  // ── Load session on mount ──────────────────────────────────
  useEffect(() => {
    (async () => {
      if (SUPABASE_CONFIGURED) {
        try {
          const s = await sbGetSession();
          if (s?.user) {
            const p = await getProfile(s.user.id);
            if (p) { setSession(p); setMode('profile'); }
          }
        } catch {}
      } else {
        const s = getMockSession();
        if (s) { setSession(s); setMode('profile'); }
      }
    })();
  }, []);

  const doLogout = useCallback(async () => {
    if (SUPABASE_CONFIGURED) await sbSignOut();
    clearMockSession();
    setSession(null);
    setMode('login');
    setEmail(''); setPassword(''); setConfirmPw('');
    showToast('로그아웃 되었습니다.', 'info');
  }, []);

  // ── Login ─────────────────────────────────────────────────
  const handleLogin = async () => {
    if (!canLogin) { showToast('이메일과 비밀번호를 확인해주세요.', 'error'); return; }
    setLoading(true);
    try {
      if (SUPABASE_CONFIGURED) {
        const { profile, error } = await sbSignIn(email, password);
        if (error) { showToast(getKoreanError(error), 'error'); return; }
        if (profile) {
          setSession(profile); setMode('profile');
          showToast(`${profile.displayName}님, 반갑습니다!`, 'success');
          setTimeout(() => {
            if (canAccessAdmin(profile.role)) window.location.href = '/admin';
            else window.location.href = '/';
          }, 800);
        }
      } else {
        const { user, error } = await mockSignIn(email, password);
        if (error) { showToast(error, 'error'); return; }
        if (user) {
          setSession(user); setMode('profile');
          showToast(`${user.displayName}님, 반갑습니다! (Mock)`, 'success');
          setTimeout(() => {
            if (canAccessAdmin(user.role)) window.location.href = '/admin';
            else window.location.href = '/';
          }, 800);
        }
      }
    } finally { setLoading(false); }
  };

  // ── Signup ─────────────────────────────────────────────────
  const handleSignup = async () => {
    if (!canSignup) { showToast('모든 항목을 올바르게 입력해주세요.', 'error'); return; }
    setLoading(true);
    try {
      if (SUPABASE_CONFIGURED) {
        const { error } = await sbSignUp(email, password, displayName);
        if (error) { showToast(getKoreanError(error), 'error'); return; }
        showToast('가입 완료! 이메일을 확인하여 계정을 인증하세요.', 'success');
        setMode('login');
      } else {
        const { user, error } = await mockSignUp(email, password, displayName, inviteCode || undefined);
        if (error) { showToast(error, 'error'); return; }
        if (user) {
          setSession(user); setMode('profile');
          const msg = user.inviteCode
            ? `가입 완료! 초대 코드 "${user.inviteCode}" 적용됨 · ${ROLE_INFO[user.role].label} (Mock)`
            : '가입 완료! (Mock 모드)';
          showToast(msg, 'success');
          setTimeout(() => { window.location.href = '/'; }, 1000);
        }
      }
    } finally { setLoading(false); }
  };

  // ── Reset password ─────────────────────────────────────────
  const handleReset = async () => {
    if (!isValidEmail(email)) { showToast('올바른 이메일을 입력해주세요.', 'error'); return; }
    setLoading(true);
    try {
      if (SUPABASE_CONFIGURED) {
        const { error } = await sbResetPassword(email);
        if (error) { showToast(getKoreanError(error), 'error'); return; }
      }
      showToast('비밀번호 재설정 메일을 보냈습니다. 메일함을 확인하세요.', 'success');
    } finally { setLoading(false); }
  };

  // ── Change password (security page) ───────────────────────
  const handleChangePw = async () => {
    if (newPw !== confirmNewPw) { showToast('새 비밀번호가 일치하지 않습니다.', 'error'); return; }
    if (!checkPasswordStrength(newPw).isValid) { showToast('비밀번호 강도가 부족합니다.', 'error'); return; }
    setLoading(true);
    try {
      if (SUPABASE_CONFIGURED) {
        const { error } = await sbUpdatePassword(newPw);
        if (error) { showToast(getKoreanError(error), 'error'); return; }
      }
      showToast('비밀번호가 변경되었습니다.', 'success');
      setNewPw(''); setConfirmNewPw('');
    } finally { setLoading(false); }
  };

  // ── Redeem code ────────────────────────────────────────────
  const handleRedeem = async () => {
    if (!redeemVal.trim()) { showToast('코드를 입력해주세요.', 'error'); return; }
    setLoading(true);
    try {
      let result: any;
      if (SUPABASE_CONFIGURED && session) {
        result = await redeemCode(redeemVal, session.id);
      } else {
        result = await mockRedeemCode(redeemVal, session?.id || 'guest');
      }
      if (!result.success) { showToast(result.error || '유효하지 않은 코드입니다.', 'error'); return; }
      if (session) {
        const updated = { ...session, plan: result.plan || session.plan, role: result.role || session.role };
        setMockSession(updated as UserProfile);
        setSession(updated as UserProfile);
      }
      showToast(`코드 적용 완료! ${result.plan} 플랜 활성화.`, 'success');
      setRedeemVal('');
    } finally { setLoading(false); }
  };

  // ── Quick dev login ────────────────────────────────────────
  const quickLogin = async (u: UserProfile) => {
    setLoading(true);
    setMockSession(u); setSession(u);
    setLoading(false);
    showToast(`${u.displayName} (${ROLE_INFO[u.role].label}) 로그인`, 'success');
    setTimeout(() => {
      if (canAccessAdmin(u.role)) window.location.href = '/admin';
      else window.location.href = '/';
    }, 500);
  };

  const ri = session ? ROLE_INFO[session.role] : null;

  return (
    <div style={{minHeight:'100vh',background:T.bg,display:'flex',alignItems:'center',justifyContent:'center',padding:20,fontFamily:"'Sora',sans-serif"}}>
      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)}/>}
      <div style={{width:'100%',maxWidth:420}}>

        {/* Logo */}
        <div style={{textAlign:'center',marginBottom:24}}>
          <a href="/" style={{textDecoration:'none'}}>
            <div style={{width:56,height:56,borderRadius:16,background:'linear-gradient(135deg,#2563EB,#7C3AED)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:26,fontWeight:900,color:'#fff',margin:'0 auto 8px'}}>T</div>
            <div style={{color:T.txt,fontWeight:900,fontSize:20}}>TRAIGO</div>
          </a>
          <div style={{color:T.muted,fontSize:11,marginTop:3}}>글로벌 투자 시뮬레이션 · 모의투자 전용</div>
          <div style={{marginTop:8,display:'inline-block',padding:'3px 10px',borderRadius:99,
            ...(SUPABASE_CONFIGURED
              ? {background:T.grn+'15',border:`1px solid ${T.grn}30`}
              : {background:T.ylw+'12',border:`1px solid ${T.ylw}30`})}}>
            <span style={{fontSize:10,fontWeight:700,color:SUPABASE_CONFIGURED?T.grn:T.ylw}}>
              {SUPABASE_CONFIGURED ? '✅ Supabase 연결됨' : '🔧 Mock 모드'}
            </span>
          </div>
        </div>

        {/* ─────────── PROFILE ─────────── */}
        {mode === 'profile' && session && ri && (
          <div>
            <div style={{background:T.card,border:`1px solid ${ri.color}40`,borderRadius:20,padding:20,marginBottom:12}}>
              <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16}}>
                <div style={{width:50,height:50,borderRadius:14,background:`linear-gradient(135deg,${ri.color},${ri.color}88)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22}}>{ri.icon}</div>
                <div style={{flex:1}}>
                  <div style={{color:T.txt,fontWeight:800,fontSize:15}}>{session.displayName}</div>
                  <div style={{color:T.muted,fontSize:11}}>{session.email}</div>
                  <div style={{display:'flex',gap:4,marginTop:4,flexWrap:'wrap'}}>
                    <span style={{background:`${ri.color}20`,color:ri.color,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99,border:`1px solid ${ri.color}40`}}>{ri.label}</span>
                    {session.badges.map(b => (
                      <span key={b} style={{background:`${T.ylw}15`,color:T.ylw,fontSize:9,fontWeight:700,padding:'2px 6px',borderRadius:99}}>{b}</span>
                    ))}
                    {(session.expiresAt === null && ['lifetime','founder'].includes(session.role)) && (
                      <span style={{background:`${T.ylw}15`,color:T.ylw,fontSize:9,fontWeight:700,padding:'2px 6px',borderRadius:99}}>♾️ 평생</span>
                    )}
                  </div>
                </div>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                {canAccessAdmin(session.role) && (
                  <a href="/admin" style={{display:'block',padding:'11px',background:`${ri.color}15`,color:ri.color,border:`1px solid ${ri.color}40`,borderRadius:12,fontWeight:700,fontSize:13,textDecoration:'none',textAlign:'center'}}>{ri.icon} 관리자 대시보드 →</a>
                )}
                {canAccessDeveloper(session.role) && (
                  <a href="/developer" style={{display:'block',padding:'11px',background:`${T.prp}15`,color:T.prp,border:`1px solid ${T.prp}40`,borderRadius:12,fontWeight:700,fontSize:13,textDecoration:'none',textAlign:'center'}}>⚙️ 개발자 대시보드 →</a>
                )}
                <a href="/" style={{display:'block',padding:'11px',background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:12,fontWeight:700,fontSize:13,textDecoration:'none',textAlign:'center'}}>🏠 메인으로</a>
                <div style={{display:'flex',gap:8}}>
                  <button onClick={() => setMode('redeem')} style={{flex:1,padding:'9px',background:'transparent',color:T.prp,border:`1px solid ${T.prp}40`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>🎟️ 초대 코드</button>
                  <button onClick={() => setMode('security')} style={{flex:1,padding:'9px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer'}}>🔒 보안 설정</button>
                </div>
                <button onClick={doLogout} style={{padding:'10px',background:'transparent',color:T.muted,border:`1px solid ${T.border}`,borderRadius:10,fontSize:11,cursor:'pointer'}}>로그아웃</button>
              </div>
            </div>
          </div>
        )}

        {/* ─────────── LOGIN ─────────── */}
        {mode === 'login' && (
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:24}}>
            <div style={{display:'flex',gap:6,marginBottom:18}}>
              {(['login','signup'] as const).map(m => (
                <button key={m} onClick={() => { setMode(m); }} style={{flex:1,padding:'10px',background:mode===m?T.acg:'transparent',color:mode===m?T.acl:T.muted,border:`1px solid ${mode===m?T.acl:T.border}`,borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer'}}>
                  {m === 'login' ? '로그인' : '회원가입'}
                </button>
              ))}
            </div>
            {!SUPABASE_CONFIGURED && (
              <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'8px 12px',marginBottom:14}}>
                <div style={{color:T.ylw,fontWeight:700,fontSize:10}}>🔧 Mock 모드 — .env.local에 Supabase 키 추가 시 실제 인증 활성화</div>
              </div>
            )}
            <div style={{marginBottom:12}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:5}}>이메일</div>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com"
                style={{width:'100%',background:T.bg,border:`1px solid ${!email||emailOk?T.border:T.red}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:16,outline:'none'}}/>
              {email && !emailOk && <div style={{color:T.red,fontSize:10,marginTop:3}}>이메일 형식이 올바르지 않습니다.</div>}
            </div>
            <PasswordInput value={password} onChange={setPassword} label="비밀번호" onEnter={handleLogin}/>
            <div style={{display:'flex',justifyContent:'flex-end',margin:'6px 0 14px'}}>
              <button onClick={() => setMode('reset')} style={{background:'none',border:'none',color:T.acl,fontSize:11,cursor:'pointer'}}>비밀번호 찾기</button>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
              <button onClick={() => setKeepLogin(v => !v)} style={{width:20,height:20,borderRadius:5,background:keepLogin?T.acl:'transparent',border:`2px solid ${keepLogin?T.acl:T.border}`,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                {keepLogin && <span style={{color:'#fff',fontSize:12,fontWeight:900}}>✓</span>}
              </button>
              <span style={{color:T.muted,fontSize:12}}>로그인 유지</span>
            </div>
            <button onClick={handleLogin} disabled={loading || !canLogin} style={{width:'100%',padding:'14px',background:canLogin&&!loading?`linear-gradient(135deg,${T.acc},${T.prp})`:'#243A5E',color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer',marginBottom:12}}>
              {loading ? '로그인 중...' : '로그인'}
            </button>
            <a href="/" style={{display:'block',textAlign:'center',color:T.muted,fontSize:11,textDecoration:'none'}}>← 로그인 없이 메인으로</a>
          </div>
        )}

        {/* ─────────── SIGNUP ─────────── */}
        {mode === 'signup' && (
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:24}}>
            <div style={{display:'flex',gap:6,marginBottom:18}}>
              {(['login','signup'] as const).map(m => (
                <button key={m} onClick={() => setMode(m)} style={{flex:1,padding:'10px',background:mode===m?T.acg:'transparent',color:mode===m?T.acl:T.muted,border:`1px solid ${mode===m?T.acl:T.border}`,borderRadius:12,fontWeight:700,fontSize:13,cursor:'pointer'}}>
                  {m === 'login' ? '로그인' : '회원가입'}
                </button>
              ))}
            </div>
            {/* Nickname */}
            <div style={{marginBottom:12}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:5}}>닉네임</div>
              <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="표시 이름 (2자 이상)"
                style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:16,outline:'none'}}/>
            </div>
            {/* Email */}
            <div style={{marginBottom:12}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:5}}>이메일</div>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com"
                style={{width:'100%',background:T.bg,border:`1px solid ${!email||emailOk?T.border:T.red}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:16,outline:'none'}}/>
              {email && !emailOk && <div style={{color:T.red,fontSize:10,marginTop:3}}>이메일 형식이 올바르지 않습니다.</div>}
            </div>
            {/* Password + strength */}
            <div style={{marginBottom:12}}>
              <PasswordInput value={password} onChange={setPassword} label="비밀번호"/>
              <StrengthMeter password={password}/>
            </div>
            {/* Confirm password */}
            <div style={{marginBottom:12}}>
              <PasswordInput value={confirmPw} onChange={setConfirmPw} label="비밀번호 확인" onEnter={handleSignup}/>
              {confirmPw && !pwMatch && (
                <div style={{color:T.red,fontSize:10,marginTop:4}}>⚠️ 비밀번호가 일치하지 않습니다.</div>
              )}
              {confirmPw && pwMatch && password.length > 0 && (
                <div style={{color:T.grn,fontSize:10,marginTop:4}}>✅ 비밀번호가 일치합니다.</div>
              )}
            </div>
            {/* Invite code (optional) */}
            <div style={{marginBottom:14}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:5}}>초대 코드 (선택)</div>
              <input value={inviteCode} onChange={e => setInviteCode(e.target.value.toUpperCase())} placeholder="FRIEND-LIFETIME (선택사항)"
                style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 14px',color:T.txt,fontSize:16,fontFamily:'monospace',fontWeight:700,outline:'none',letterSpacing:1}}/>
              <div style={{color:T.muted,fontSize:10,marginTop:3}}>코드 입력 시 VIP/창업멤버/평생회원 플랜이 자동 적용됩니다.</div>
            </div>
            <button onClick={handleSignup} disabled={loading || !canSignup} style={{width:'100%',padding:'14px',background:canSignup&&!loading?`linear-gradient(135deg,${T.acc},${T.prp})`:'#243A5E',color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:canSignup?'pointer':'not-allowed',marginBottom:8}}>
              {loading ? '가입 중...' : '회원가입'}
            </button>
            {!canSignup && (email || password || confirmPw) && (
              <div style={{color:T.muted,fontSize:10,textAlign:'center',marginBottom:8}}>
                {!isValidEmail(email) ? '올바른 이메일을 입력하세요' :
                 !pwStrength.isValid ? '더 강한 비밀번호를 사용하세요' :
                 !pwMatch ? '비밀번호가 일치하지 않습니다' :
                 displayName.trim().length < 2 ? '닉네임을 2자 이상 입력하세요' : ''}
              </div>
            )}
            <div style={{color:T.muted,fontSize:10,textAlign:'center'}}>이미 계정이 있으신가요? <button onClick={() => setMode('login')} style={{background:'none',border:'none',color:T.acl,cursor:'pointer',fontSize:10,fontWeight:700}}>로그인</button></div>
          </div>
        )}

        {/* ─────────── RESET ─────────── */}
        {mode === 'reset' && (
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:24}}>
            <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:16}}>
              <button onClick={() => setMode('login')} style={{background:'transparent',border:'none',color:T.muted,cursor:'pointer',fontSize:20}}>←</button>
              <div style={{color:T.txt,fontWeight:800,fontSize:16}}>비밀번호 찾기</div>
            </div>
            <div style={{color:T.muted,fontSize:12,marginBottom:14,lineHeight:1.6}}>
              가입한 이메일을 입력하면 비밀번호 재설정 링크를 보내드립니다.
            </div>
            <div style={{marginBottom:14}}>
              <div style={{color:T.muted,fontSize:11,fontWeight:700,marginBottom:5}}>이메일</div>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key==='Enter'&&handleReset()} placeholder="가입한 이메일"
                style={{width:'100%',background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:16,outline:'none'}}/>
            </div>
            <button onClick={handleReset} disabled={loading || !isValidEmail(email)} style={{width:'100%',padding:'14px',background:isValidEmail(email)&&!loading?`linear-gradient(135deg,${T.acc},${T.prp})`:'#243A5E',color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>
              {loading ? '발송 중...' : '재설정 메일 발송'}
            </button>
          </div>
        )}

        {/* ─────────── REDEEM ─────────── */}
        {mode === 'redeem' && (
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:24}}>
            <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:16}}>
              <button onClick={() => setMode('profile')} style={{background:'transparent',border:'none',color:T.muted,cursor:'pointer',fontSize:20}}>←</button>
              <div style={{color:T.txt,fontWeight:800,fontSize:16}}>🎟️ 초대 코드 입력</div>
            </div>
            <input value={redeemVal} onChange={e => setRedeemVal(e.target.value.toUpperCase())} onKeyDown={e => e.key==='Enter'&&handleRedeem()} placeholder="예: FRIEND-LIFETIME"
              style={{width:'100%',background:T.bg,border:`1px solid ${T.border2}`,borderRadius:10,padding:'12px 14px',color:T.txt,fontSize:14,fontFamily:'monospace',fontWeight:700,outline:'none',letterSpacing:1,marginBottom:10}}/>
            {!SUPABASE_CONFIGURED && (
              <div style={{background:T.bg,borderRadius:8,padding:'10px 12px',marginBottom:10,border:`1px solid ${T.border}`}}>
                <div style={{color:T.muted,fontSize:10,fontWeight:700,marginBottom:6}}>💡 테스트 코드</div>
                {MOCK_INVITE_CODES.filter(c => c.active).map(c => (
                  <div key={c.id} onClick={() => setRedeemVal(c.code)} style={{display:'flex',justifyContent:'space-between',padding:'5px 0',cursor:'pointer',borderBottom:`1px solid ${T.border}`}}>
                    <span style={{color:T.acl,fontSize:10,fontFamily:'monospace'}}>{c.code}</span>
                    <span style={{color:T.muted,fontSize:9}}>{c.plan} · {c.note}</span>
                  </div>
                ))}
              </div>
            )}
            <button onClick={handleRedeem} disabled={loading || !redeemVal.trim()} style={{width:'100%',padding:'13px',background:redeemVal&&!loading?`linear-gradient(135deg,${T.prp},#5B21B6)`:'#243A5E',color:'#fff',border:'none',borderRadius:12,fontWeight:800,fontSize:14,cursor:'pointer'}}>
              {loading ? '확인 중...' : '코드 적용'}
            </button>
          </div>
        )}

        {/* ─────────── SECURITY ─────────── */}
        {mode === 'security' && (
          <div>
            <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:14}}>
              <button onClick={() => setMode('profile')} style={{background:'transparent',border:'none',color:T.muted,cursor:'pointer',fontSize:20}}>←</button>
              <div style={{color:T.txt,fontWeight:800,fontSize:16}}>🔒 보안 설정</div>
            </div>
            {/* Change password */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,padding:16,marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🔑 비밀번호 변경</div>
              {session && canAccessAdmin(session.role) && (
                <div style={{background:T.red+'12',border:`1px solid ${T.red}30`,borderRadius:8,padding:'8px 12px',marginBottom:10}}>
                  <div style={{color:T.red,fontSize:11,fontWeight:700}}>⚠️ 관리자 계정은 강력한 비밀번호를 사용하세요.</div>
                </div>
              )}
              <div style={{marginBottom:10}}><PasswordInput value={newPw} onChange={setNewPw} label="새 비밀번호"/><StrengthMeter password={newPw}/></div>
              <div style={{marginBottom:12}}>
                <PasswordInput value={confirmNewPw} onChange={setConfirmNewPw} label="새 비밀번호 확인" onEnter={handleChangePw}/>
                {confirmNewPw && newPw !== confirmNewPw && <div style={{color:T.red,fontSize:10,marginTop:3}}>⚠️ 비밀번호가 일치하지 않습니다.</div>}
              </div>
              <button onClick={handleChangePw} disabled={loading||!newPw||newPw!==confirmNewPw||!checkPasswordStrength(newPw).isValid} style={{width:'100%',padding:'11px',background:(newPw&&newPw===confirmNewPw&&checkPasswordStrength(newPw).isValid&&!loading)?T.acc:'#243A5E',color:'#fff',border:'none',borderRadius:10,fontWeight:700,cursor:'pointer'}}>
                {loading ? '변경 중...' : '비밀번호 변경'}
              </button>
            </div>
            {/* 2FA placeholder */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,padding:16,marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>🔐 2단계 인증 (2FA)</div>
              {[{l:'OTP 앱 인증',s:'사용 안 함',c:T.muted},{l:'이메일 인증',s:'사용 안 함',c:T.muted},{l:'SMS 인증',s:'준비중',c:T.ylw}].map((f,i) => (
                <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:i<2?`1px solid ${T.border}`:'none'}}>
                  <span style={{color:T.txt,fontSize:12}}>{f.l}</span>
                  <span style={{background:`${f.c}20`,color:f.c,fontSize:9,fontWeight:700,padding:'2px 8px',borderRadius:99}}>{f.s}</span>
                </div>
              ))}
            </div>
            {/* Login history placeholder */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,padding:16,marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>📋 최근 로그인 기록</div>
              {[{device:'iPhone 15 Pro',loc:'서울, 대한민국',time:'방금',cur:true},{device:'MacBook Pro',loc:'서울',time:'어제 18:30',cur:false}].map((l,i) => (
                <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:i<1?`1px solid ${T.border}`:'none'}}>
                  <div><div style={{color:T.txt,fontSize:12}}>{l.device} {l.cur&&<span style={{background:T.grn+'20',color:T.grn,fontSize:8,fontWeight:700,padding:'1px 5px',borderRadius:99}}>현재</span>}</div><div style={{color:T.muted,fontSize:10}}>{l.loc} · {l.time}</div></div>
                  {!l.cur && <button type="button"
                    onClick={() => alert(`"${l.device}" 세션 종료는 설정 → 보안 → 로그인 기록에서 가능합니다 (실제 기기 추적)`)}
                    style={{background:T.red+'15',color:T.red,border:'none',borderRadius:6,padding:'6px 12px',minHeight:30,fontSize:10,cursor:'pointer'}}>종료</button>}
                </div>
              ))}
            </div>
            <button onClick={doLogout} style={{width:'100%',padding:'11px',background:'transparent',color:T.red,border:`1px solid ${T.red}40`,borderRadius:12,fontWeight:700,cursor:'pointer'}}>
              모든 기기에서 로그아웃
            </button>
          </div>
        )}

        {/* ─────────── Dev Quick Login ─────────── */}
        {!SUPABASE_CONFIGURED && (mode==='login'||mode==='signup') && (
          <div style={{marginTop:12}}>
            <button onClick={() => setShowDevAccounts(v => !v)} style={{width:'100%',background:T.surf,border:`1px solid ${T.border}`,borderRadius:12,padding:'10px 14px',color:T.muted,fontSize:11,fontWeight:700,cursor:'pointer',display:'flex',justifyContent:'space-between'}}>
              <span>🔧 개발용 테스트 계정</span><span>{showDevAccounts?'▲':'▼'}</span>
            </button>
            {showDevAccounts && (
              <div style={{background:T.surf,border:`1px solid ${T.border}`,borderRadius:12,marginTop:6,overflow:'hidden'}}>
                {MOCK_USERS.filter(u => u.status !== 'banned').map((u,i,arr) => {
                  const ri2 = ROLE_INFO[u.role];
                  return (
                    <button key={u.id} onClick={() => quickLogin(u)} style={{width:'100%',display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 14px',background:'transparent',border:'none',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none',cursor:'pointer',textAlign:'left'}}>
                      <div>
                        <div style={{display:'flex',gap:5,alignItems:'center'}}>
                          <span style={{fontSize:14}}>{ri2.icon}</span>
                          <span style={{color:T.txt,fontSize:12,fontWeight:600}}>{u.displayName}</span>
                          <span style={{background:`${ri2.color}20`,color:ri2.color,fontSize:8,fontWeight:700,padding:'1px 5px',borderRadius:99}}>{ri2.label}</span>
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

        <div style={{textAlign:'center',marginTop:14,color:T.muted,fontSize:10}}>
          모의투자 전용 · 실제 거래 없음 · 수익 보장 없음
        </div>
      </div>
    </div>
  );
}
