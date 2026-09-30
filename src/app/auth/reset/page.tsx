'use client';

import React, { useEffect, useState } from 'react';
import { getSupabaseClient } from '@/lib/supabase/client';
import { T } from '@/lib/constants';

function validPassword(v: string) {
  return v.length >= 8
    && /[A-Z]/.test(v)
    && /[a-z]/.test(v)
    && /[0-9]/.test(v);
}

export default function ResetPasswordPage() {
  const [ready, setReady] = useState(false);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);

  useEffect(() => {
    const sb = getSupabaseClient();
    if (!sb) { setMsg('인증 서비스를 사용할 수 없습니다.'); return; }

    let alive = true;
    const check = async () => {
      const { data } = await sb.auth.getSession();
      if (!alive) return;
      if (data.session) setReady(true);
      else setMsg('재설정 링크가 만료됐거나 유효하지 않습니다. 다시 비밀번호 찾기를 진행해주세요.');
    };
    check();

    const { data } = sb.auth.onAuthStateChange((event, session) => {
      if (!alive) return;
      if (event === 'PASSWORD_RECOVERY' || session) {
        setReady(true);
        setMsg('');
      }
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const save = async () => {
    if (!ready || busy) return;
    if (!validPassword(pw)) {
      setMsg('비밀번호는 8자 이상이며 영문 대문자·소문자·숫자를 포함해야 합니다.');
      return;
    }
    if (pw !== confirm) { setMsg('비밀번호 확인이 일치하지 않습니다.'); return; }

    const sb = getSupabaseClient();
    if (!sb) { setMsg('인증 서비스를 사용할 수 없습니다.'); return; }
    setBusy(true); setMsg('');
    try {
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) { setMsg(error.message); return; }
      setOk(true);
      setMsg('비밀번호가 변경되었습니다. 새 비밀번호로 다시 로그인할 수 있습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{minHeight:'100vh',background:T.bg,color:T.txt,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{width:'100%',maxWidth:420,background:T.card,border:`1px solid ${T.border}`,borderRadius:20,padding:20}}>
        <div style={{fontWeight:900,fontSize:20,marginBottom:6}}>비밀번호 재설정</div>
        <div style={{color:T.muted,fontSize:11,lineHeight:1.6,marginBottom:18}}>
          메일의 재설정 링크로 들어온 경우에만 새 비밀번호를 저장할 수 있습니다.
        </div>

        {!ok && (
          <>
            <label style={{display:'block',fontSize:11,color:T.muted,marginBottom:5}}>새 비밀번호</label>
            <input type="password" value={pw} onChange={e=>setPw(e.target.value)}
              autoComplete="new-password"
              style={{width:'100%',boxSizing:'border-box',minHeight:46,borderRadius:10,border:`1px solid ${T.border}`,background:T.alt,color:T.txt,padding:'0 12px',marginBottom:10}}/>
            <label style={{display:'block',fontSize:11,color:T.muted,marginBottom:5}}>새 비밀번호 확인</label>
            <input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)}
              autoComplete="new-password"
              onKeyDown={e=>{if(e.key==='Enter') save();}}
              style={{width:'100%',boxSizing:'border-box',minHeight:46,borderRadius:10,border:`1px solid ${T.border}`,background:T.alt,color:T.txt,padding:'0 12px',marginBottom:12}}/>
            <button onClick={save} disabled={!ready||busy}
              style={{width:'100%',minHeight:46,border:0,borderRadius:11,background:ready?T.acl:T.border2,color:'#fff',fontWeight:800,cursor:ready&&!busy?'pointer':'default'}}>
              {busy?'변경 중…':'비밀번호 변경'}
            </button>
          </>
        )}

        {msg && <div style={{marginTop:12,color:ok?T.grn:T.ylw,fontSize:11,lineHeight:1.55}}>{msg}</div>}
        <a href="/auth" style={{display:'block',textAlign:'center',marginTop:16,color:T.acl,fontSize:12,fontWeight:700,textDecoration:'none'}}>
          로그인 화면으로
        </a>
      </div>
    </main>
  );
}
