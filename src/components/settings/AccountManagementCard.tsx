'use client';

import React, { useEffect, useState } from 'react';
import { T } from '@/lib/constants';
import { A } from '@/lib/theme/colors';
import { getSupabaseClient } from '@/lib/supabase/client';
import { getEmailRedirectUrl } from '@/lib/supabase';
import { confirmDialog } from '@/lib/confirm/dialog';
import { Copy, Mail, UserRound, KeyRound, ShieldCheck, RefreshCw } from 'lucide-react';

type UserView = {
  id: string;
  email: string;
  emailConfirmed: boolean;
  displayName: string;
};

const field: React.CSSProperties = {
  width:'100%', boxSizing:'border-box', minHeight:44, borderRadius:10,
  border:'1px solid var(--t-border)', background:'var(--t-alt)',
  color:'var(--t-txt)', padding:'0 11px', fontSize:12,
};

export default function AccountManagementCard() {
  const [me,setMe]=useState<UserView|null>(null);
  const [name,setName]=useState('');
  const [email,setEmail]=useState('');
  const [pw,setPw]=useState('');
  const [pw2,setPw2]=useState('');
  const [busy,setBusy]=useState('');
  const [msg,setMsg]=useState('');

  const load=async()=>{
    const sb=getSupabaseClient();
    if(!sb){setMe(null);setMsg('인증 서비스를 사용할 수 없습니다.');return;}
    const {data:{user}}=await sb.auth.getUser();
    if(!user){setMe(null);return;}
    const {data:profile}=await sb.from('profiles').select('display_name').eq('id',user.id).maybeSingle();
    const v={
      id:user.id,
      email:user.email||'',
      emailConfirmed:!!user.email_confirmed_at,
      displayName:String((profile as any)?.display_name||user.user_metadata?.display_name||''),
    };
    setMe(v); setName(v.displayName); setEmail(v.email);
  };

  useEffect(()=>{void load();},[]);

  const run=async(key:string,fn:()=>Promise<string>)=>{
    if(busy)return;
    setBusy(key);setMsg('');
    try{setMsg(await fn());await load();}
    catch(e:any){setMsg(e?.message||'처리하지 못했습니다.');}
    finally{setBusy('');}
  };

  if(!me){
    return <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:16}}>
      <div style={{color:T.txt,fontWeight:800,fontSize:14,marginBottom:5}}>계정 관리</div>
      <div style={{color:T.muted,fontSize:11,lineHeight:1.55,marginBottom:12}}>로그인하면 이름·이메일·비밀번호·로그인 아이디를 여기서 관리할 수 있습니다.</div>
      <a href="/auth" style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:44,borderRadius:10,background:T.acl,color:'#fff',fontWeight:800,fontSize:12,textDecoration:'none'}}>로그인 / 회원가입</a>
    </div>;
  }

  const saveName=()=>run('name',async()=>{
    const v=name.trim();
    if(v.length<2)throw new Error('이름은 2자 이상 입력해주세요.');
    const sb=getSupabaseClient(); if(!sb)throw new Error('인증 서비스를 사용할 수 없습니다.');
    const {error:e1}=await sb.from('profiles').update({display_name:v,updated_at:new Date().toISOString()} as any).eq('id',me.id);
    if(e1)throw e1;
    const {error:e2}=await sb.auth.updateUser({data:{display_name:v}});
    if(e2)throw e2;
    return '이름을 변경했습니다.';
  });

  const saveEmail=()=>run('email',async()=>{
    const v=email.trim().toLowerCase();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))throw new Error('이메일 형식을 확인해주세요.');
    if(v===me.email.toLowerCase())return '현재 이메일과 같습니다.';
    if(!(await confirmDialog(`로그인 이메일을 ${v}(으)로 변경하시겠습니까?\n인증 설정에 따라 기존/새 이메일 확인이 필요할 수 있습니다.`))) return '변경을 취소했습니다.';
    const sb=getSupabaseClient(); if(!sb)throw new Error('인증 서비스를 사용할 수 없습니다.');
    const {error}=await sb.auth.updateUser({email:v},{emailRedirectTo:getEmailRedirectUrl()});
    if(error)throw error;
    return '이메일 변경 요청을 보냈습니다. 받은 편지함의 확인 절차를 완료해주세요.';
  });

  const savePassword=()=>run('pw',async()=>{
    if(pw.length<8||!/[A-Z]/.test(pw)||!/[a-z]/.test(pw)||!/[0-9]/.test(pw))
      throw new Error('비밀번호는 8자 이상이며 영문 대문자·소문자·숫자를 포함해야 합니다.');
    if(pw!==pw2)throw new Error('비밀번호 확인이 일치하지 않습니다.');
    const sb=getSupabaseClient(); if(!sb)throw new Error('인증 서비스를 사용할 수 없습니다.');
    const {error}=await sb.auth.updateUser({password:pw});
    if(error)throw error;
    setPw('');setPw2('');
    return '비밀번호를 변경했습니다.';
  });

  const sendReset=()=>run('reset',async()=>{
    const sb=getSupabaseClient(); if(!sb)throw new Error('인증 서비스를 사용할 수 없습니다.');
    const base=typeof window!=='undefined'?window.location.origin:'';
    const {error}=await sb.auth.resetPasswordForEmail(me.email,{redirectTo:`${base}/auth/reset`});
    if(error)throw error;
    return '비밀번호 재설정 메일을 보냈습니다.';
  });

  const resendVerify=()=>run('verify',async()=>{
    const sb=getSupabaseClient(); if(!sb)throw new Error('인증 서비스를 사용할 수 없습니다.');
    const {error}=await sb.auth.resend({type:'signup',email:me.email,options:{emailRedirectTo:getEmailRedirectUrl()}});
    if(error)throw error;
    return '이메일 인증 메일을 다시 보냈습니다.';
  });

  const copy=async(v:string,label:string)=>{
    try{await navigator.clipboard.writeText(v);setMsg(`${label}을 복사했습니다.`);}
    catch{setMsg('복사하지 못했습니다.');}
  };

  return <div style={{display:'flex',flexDirection:'column',gap:12}}>
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:16}}>
      <div style={{display:'flex',alignItems:'center',gap:7,color:T.txt,fontWeight:800,fontSize:14,marginBottom:12}}><UserRound size={15} color={T.acl}/>계정 기본 정보</div>
      <div style={{background:T.alt,borderRadius:10,padding:'10px 11px',marginBottom:10}}>
        <div style={{color:T.muted,fontSize:9}}>로그인 아이디</div>
        <div style={{display:'flex',gap:8,alignItems:'center',marginTop:3}}>
          <div style={{color:T.txt,fontSize:12,fontWeight:700,flex:1,overflowWrap:'anywhere'}}>{me.email}</div>
          <button onClick={()=>copy(me.email,'로그인 아이디')} aria-label="로그인 아이디 복사" style={{border:0,background:'transparent',cursor:'pointer',padding:5}}><Copy size={14} color={T.muted}/></button>
        </div>
        <div style={{color:T.muted,fontSize:9,marginTop:5,lineHeight:1.45}}>현재 TRAIGO는 별도 사용자명이 없고 가입 이메일이 로그인 아이디입니다.</div>
      </div>
      <div style={{background:T.alt,borderRadius:10,padding:'10px 11px'}}>
        <div style={{color:T.muted,fontSize:9}}>계정 고유 ID · 변경 불가</div>
        <div style={{display:'flex',gap:8,alignItems:'center',marginTop:3}}>
          <div style={{color:T.sub,fontSize:10,fontFamily:'monospace',flex:1,overflowWrap:'anywhere'}}>{me.id}</div>
          <button onClick={()=>copy(me.id,'계정 ID')} aria-label="계정 ID 복사" style={{border:0,background:'transparent',cursor:'pointer',padding:5}}><Copy size={14} color={T.muted}/></button>
        </div>
      </div>
    </div>

    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:16}}>
      <div style={{color:T.txt,fontWeight:800,fontSize:13,marginBottom:8}}>이름 변경</div>
      <div style={{display:'flex',gap:7}}>
        <input value={name} onChange={e=>setName(e.target.value)} style={field} placeholder="표시 이름"/>
        <button onClick={saveName} disabled={!!busy} style={{flexShrink:0,minWidth:72,border:0,borderRadius:10,background:T.acl,color:'#fff',fontWeight:800,fontSize:11,cursor:'pointer'}}>{busy==='name'?'저장 중':'저장'}</button>
      </div>
    </div>

    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:16}}>
      <div style={{display:'flex',alignItems:'center',gap:7,color:T.txt,fontWeight:800,fontSize:13,marginBottom:8}}><Mail size={14} color={T.acl}/>이메일 · 로그인 아이디 변경</div>
      <div style={{display:'flex',gap:7}}>
        <input type="email" value={email} onChange={e=>setEmail(e.target.value)} style={field}/>
        <button onClick={saveEmail} disabled={!!busy} style={{flexShrink:0,minWidth:72,border:0,borderRadius:10,background:T.acl,color:'#fff',fontWeight:800,fontSize:11,cursor:'pointer'}}>{busy==='email'?'요청 중':'변경'}</button>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:7,marginTop:9}}>
        <ShieldCheck size={13} color={me.emailConfirmed?T.grn:T.ylw}/>
        <span style={{color:me.emailConfirmed?T.grn:T.ylw,fontSize:10,fontWeight:700}}>{me.emailConfirmed?'이메일 인증 완료':'이메일 미인증'}</span>
        {!me.emailConfirmed&&<button onClick={resendVerify} disabled={!!busy} style={{marginLeft:'auto',border:`1px solid ${T.border}`,background:T.alt,color:T.acl,borderRadius:8,minHeight:30,padding:'0 9px',fontSize:9.5,fontWeight:700,cursor:'pointer'}}>인증메일 재전송</button>}
      </div>
    </div>

    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:16}}>
      <div style={{display:'flex',alignItems:'center',gap:7,color:T.txt,fontWeight:800,fontSize:13,marginBottom:8}}><KeyRound size={14} color={T.acl}/>비밀번호 변경 · 찾기</div>
      <input type="password" autoComplete="new-password" value={pw} onChange={e=>setPw(e.target.value)} style={{...field,marginBottom:7}} placeholder="새 비밀번호"/>
      <input type="password" autoComplete="new-password" value={pw2} onChange={e=>setPw2(e.target.value)} style={{...field,marginBottom:9}} placeholder="새 비밀번호 확인"/>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:7}}>
        <button onClick={savePassword} disabled={!!busy} style={{minHeight:40,border:0,borderRadius:9,background:T.acl,color:'#fff',fontSize:10.5,fontWeight:800,cursor:'pointer'}}>{busy==='pw'?'변경 중':'비밀번호 변경'}</button>
        <button onClick={sendReset} disabled={!!busy} style={{minHeight:40,border:`1px solid ${T.border}`,borderRadius:9,background:T.alt,color:T.txt,fontSize:10.5,fontWeight:800,cursor:'pointer'}}>{busy==='reset'?'전송 중':'재설정 메일 보내기'}</button>
      </div>
    </div>

    <div style={{background:A(T.ylw,'10'),border:`1px solid ${A(T.ylw,'30')}`,borderRadius:10,padding:'9px 11px',color:T.muted,fontSize:9.5,lineHeight:1.55}}>
      이메일을 완전히 잊은 계정을 이름만으로 찾아주는 기능은 계정 존재 여부를 노출할 수 있어 제공하지 않습니다. 로그인 아이디는 가입 이메일이며, 로그인된 상태에서는 위에서 바로 확인할 수 있습니다.
    </div>

    {msg&&<div style={{background:T.alt,borderRadius:9,padding:'9px 11px',color:T.sub,fontSize:10.5,lineHeight:1.5}}>{msg}</div>}
    <button onClick={()=>void load()} disabled={!!busy} style={{alignSelf:'flex-start',border:0,background:'transparent',color:T.muted,fontSize:10,cursor:'pointer',display:'flex',alignItems:'center',gap:5}}><RefreshCw size={12}/>계정 정보 다시 읽기</button>
  </div>;
}
