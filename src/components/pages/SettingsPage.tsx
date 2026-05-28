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
import { useProfile } from '@/lib/auth/useProfile';
import {
  Globe2, DollarSign, Bell, Target, Shield, Database, Settings as SettingsIcon,
  Lock, Save, Scale, Flame, Download, Upload, Hourglass,
} from 'lucide-react';


function SettingsPage({lang,setLang,currency,setCurrency}:{lang:string;setLang:(l:string)=>void;currency:string;setCurrency:(c:string)=>void}) {
  const [tab,setTab]=useState<'general'|'security'|'backup'|'pro'|'legal'>('general');
  const [notif,setNotif]=useState({trade:true,profit:true,news:false,alert:true,leverage:true});
  const [notifPerm,setNotifPerm]=useState<'default'|'granted'|'denied'|'unsupported'>('default');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('Notification' in window)) { setNotifPerm('unsupported'); return; }
    setNotifPerm(Notification.permission as any);
  }, []);
  const [sec,setSec]=useState({twoFa:true,bio:true,lock:false,sessionAlert:true});
  const [apiKeys]=useState([{id:1,name:'API Key #1',created:'2025-01-15',lastUsed:'2025-05-10',active:true}]);

  // 실제 로그인 상태 + 프로필 (useProfile 훅: /api/auth/me 호출, role 자동 승급 포함)
  const { user, profile, isAdmin, isAuthenticated, loading: profileLoading } = useProfile();
  const userRole = profile?.role || null;
  const isAdminUser = isAdmin;
  // (기존의 직접 supabase 호출 useEffect는 useProfile 훅으로 대체됨)

  /* ── Toast & file I/O ── */
  const [toast,setToast]=useState('');
  const [importing,setImporting]=useState(false);
  const fileInputRef=useRef<HTMLInputElement|null>(null);

  const showToast=useCallback((m:string)=>{
    setToast(m);
    setTimeout(()=>setToast(''),2500);
  },[]);

  /* ── Backup export: collect all tg_* localStorage keys ── */
  const exportBackup=useCallback(()=>{
    try {
      const BACKUP_KEYS=[
        'tg_portfolio_v2','tg_watch_groups_v1','tg_alerts_v1','tg_alerts_fired_v1',
        'tg_pnl_history_v1','tg_paper_account_v1','tg_recent_search_v1',
        'tg_history_v2','tg_academy_v1','tg_settings_v1',
      ];
      const data:Record<string,any>={};
      BACKUP_KEYS.forEach(k=>{
        const v=localStorage.getItem(k);
        if(v) data[k]=v;
      });
      const payload={
        app:'TRAIGO',
        version:'v9',
        exportedAt:new Date().toISOString(),
        data,
      };
      const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;
      a.download=`traigo-backup-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('✅ 백업 파일이 다운로드되었습니다');
    } catch(e) {
      console.error('[export]',e);
      showToast('❌ 백업 실패');
    }
  },[showToast]);

  /* ── 모든 사용자 데이터 삭제 (위험 구역) ── */
  const clearAllData=useCallback(async()=>{
    if(typeof window==='undefined')return;
    const ok=confirm('정말 모든 로컬 데이터를 삭제하시겠습니까?\n\n삭제 대상:\n• localStorage (포트폴리오, 워치리스트, 알림 등)\n• sessionStorage\n• 브라우저 캐시\n\n이 작업은 되돌릴 수 없습니다.');
    if(!ok)return;
    try{
      // tg_* 키만 (다른 앱 데이터 보호)
      const removed:string[]=[];
      for(let i=window.localStorage.length-1;i>=0;i--){
        const k=window.localStorage.key(i);
        if(k&&k.startsWith('tg_')){
          window.localStorage.removeItem(k);
          removed.push(k);
        }
      }
      try{ window.sessionStorage.clear(); }catch{}
      if('caches' in window){
        try{
          const keys=await caches.keys();
          await Promise.all(keys.map(key=>caches.delete(key)));
        }catch(e){ console.warn('[clearAllData] cache clear failed',e); }
      }
      showToast(`✅ ${removed.length}개 항목 삭제 완료. 새로고침합니다.`);
      setTimeout(()=>{
        try{ window.location.reload(); }catch{}
      },1200);
    }catch(err){
      console.error('[clearAllData] failed',err);
      showToast('❌ 데이터 삭제 중 오류가 발생했습니다');
    }
  },[showToast]);

  /* ── 로그아웃 ── */
  const handleSignOut=useCallback(async()=>{
    if(!confirm('로그아웃 하시겠습니까?'))return;
    try{
      const {getSupabaseClient}=await import('@/lib/supabase/client');
      const sb=getSupabaseClient();
      if(sb){ await sb.auth.signOut(); }
      showToast('✅ 로그아웃 되었습니다');
      setTimeout(()=>{
        try{ window.location.href='/'; }catch{}
      },800);
    }catch(e){
      console.error('[signOut]',e);
      showToast('❌ 로그아웃 실패');
    }
  },[showToast]);

  const importBackup=useCallback(async(file:File)=>{
    setImporting(true);
    try {
      const text=await file.text();
      const parsed=JSON.parse(text);
      if(parsed?.app!=='TRAIGO'||!parsed?.data||typeof parsed.data!=='object'){
        throw new Error('TRAIGO 백업 파일이 아닙니다');
      }
      if(!confirm('현재 데이터를 백업 파일로 교체하시겠습니까? 이 작업은 되돌릴 수 없습니다.')){
        setImporting(false);
        return;
      }
      let restored=0;
      Object.entries(parsed.data).forEach(([k,v])=>{
        if(typeof v==='string'&&k.startsWith('tg_')){
          localStorage.setItem(k,v);
          restored++;
        }
      });
      showToast(`✅ ${restored}개 항목 복원 완료. 새로고침 후 적용됩니다.`);
      setTimeout(()=>{ if(typeof window!=='undefined') window.location.reload(); },1500);
    } catch(e:any) {
      console.error('[import]',e);
      showToast(`❌ ${e?.message||'복원 실패'}`);
    } finally {
      setImporting(false);
    }
  },[showToast]);

  return (
    <div>
      {toast&&(
        <div style={{position:'fixed',top:16,left:'50%',transform:'translateX(-50%)',
          background:T.acl,color:'#fff',padding:'10px 18px',borderRadius:12,
          fontSize:13,fontWeight:700,zIndex:999}}>
          {toast}
        </div>
      )}
      <div style={{display:'flex',gap:6,marginBottom:14,overflowX:'auto'}}>
        {(['general','security','backup','pro','legal'] as const).map(t=>{
          const active = tab===t;
          const Icon = t==='general'?SettingsIcon:t==='security'?Lock:t==='backup'?Save:t==='pro'?Flame:Scale;
          const label = t==='general'?'일반':t==='security'?'보안':t==='backup'?'백업':t==='pro'?'Pro':'법적';
          return (
            <button key={t} onClick={()=>setTab(t)} style={{flexShrink:0,padding:'7px 12px',background:active?T.acg:'transparent',color:active?T.acl:T.muted,border:`1px solid ${active?T.acl:T.border}`,borderRadius:10,fontSize:11,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',gap:5,minHeight:36}}>
              <Icon size={12} strokeWidth={2.4}/>
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {tab==='general'&&(
        <div>
          {/* Profile */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
              <div style={{width:52,height:52,borderRadius:15,background:`linear-gradient(135deg,${T.acc},${T.prp})`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,color:'#fff',fontWeight:800}}>
                {isAuthenticated && user?.email
                  ? user.email.slice(0,1).toUpperCase()
                  : '?'}
              </div>
              <div style={{flex:1, minWidth:0}}>
                {profileLoading ? (
                  <>
                    <div style={{color:T.txt,fontWeight:800,fontSize:15}}>로딩 중...</div>
                    <div style={{color:T.muted,fontSize:11}}>세션 확인 중</div>
                  </>
                ) : isAuthenticated && user ? (
                  <>
                    <div style={{color:T.txt,fontWeight:800,fontSize:15,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                      {profile?.display_name || user.email?.split('@')[0] || '사용자'}
                    </div>
                    <div style={{color:T.muted,fontSize:11,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                      {user.email || ''}
                    </div>
                    <div style={{marginTop:4,display:'flex',gap:6,flexWrap:'wrap'}}>
                      <Bdg c={T.grn} ch="로그인됨"/>
                      <Bdg c={T.acl} ch={`Plan: ${profile?.plan || 'free'}`}/>
                      {isAdminUser && <Bdg c="#F59E0B" ch="ADMIN"/>}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{color:T.txt,fontWeight:800,fontSize:15}}>투자자님</div>
                    <div style={{color:T.muted,fontSize:11}}>비로그인 · 모의투자 전용</div>
                    <div style={{marginTop:4,display:'flex',gap:6}}>
                      <Bdg c={T.gld} ch="무료 플랜"/>
                      <Bdg c={T.grn} ch="모의투자"/>
                    </div>
                  </>
                )}
              </div>
            </div>
            <div style={{display:'flex',gap:8}}>
              {isAuthenticated ? (
                <>
                  <button type="button" onClick={handleSignOut} style={{flex:1,padding:'10px',minHeight:44,background:'transparent',color:T.red,border:`1px solid ${T.red}55`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer'}}>
                    로그아웃
                  </button>
                  {isAdminUser && <a href="/admin" style={{padding:'10px 14px',minHeight:44,background:'rgba(16,185,129,0.1)',color:'#10B981',border:'1px solid rgba(16,185,129,0.3)',borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer',textDecoration:'none',display:'flex',alignItems:'center',justifyContent:'center'}}>관리자</a>}
                </>
              ) : (
                <>
                  <a href="/auth" style={{flex:1,padding:'10px',minHeight:44,background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer',textDecoration:'none',textAlign:'center',display:'flex',alignItems:'center',justifyContent:'center'}}>로그인 / 회원가입</a>
                  {isAdminUser && <a href="/admin" style={{padding:'10px 14px',minHeight:44,background:'rgba(16,185,129,0.1)',color:'#10B981',border:'1px solid rgba(16,185,129,0.3)',borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer',textDecoration:'none',display:'flex',alignItems:'center',justifyContent:'center'}}>관리자</a>}
                </>
              )}
            </div>
          </Card>

          {/* Language */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12,display:'flex',alignItems:'center',gap:6}}>
              <Globe2 size={14} strokeWidth={2.2} color={T.acl}/>
              <span>언어 / Language</span>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
              {LANGS.map(l=>{
                const active = lang===l.id;
                return (
                  <button key={l.id} onClick={()=>setLang(l.id)}
                    style={{
                      background: active ? T.acg : 'transparent',
                      color:      active ? T.acl : T.txt,
                      border:    `1px solid ${active ? T.acl : T.border}`,
                      borderRadius:10,
                      padding:'10px 10px',
                      minHeight:46,
                      cursor:'pointer',
                      textAlign:'left',
                      display:'flex',
                      alignItems:'center',
                      gap:8,
                      touchAction:'manipulation',
                    }}>
                    <span style={{
                      fontSize:9, fontWeight:800,
                      padding:'2px 6px',
                      background: active ? T.acl + '25' : T.alt,
                      color: active ? T.acl : T.muted,
                      borderRadius:6,
                      flexShrink:0,
                      letterSpacing:0.3,
                    }}>{l.id.toUpperCase()}</span>
                    <span style={{
                      fontSize:12, fontWeight:600,
                      overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                      direction: l.rtl ? 'rtl' : 'ltr',
                    }}>{l.native}</span>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* Currency */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12,display:'flex',alignItems:'center',gap:6}}>
              <DollarSign size={14} strokeWidth={2.2} color={T.acl}/>
              <span>기본 통화</span>
            </div>
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
            <div style={{color:T.txt,fontWeight:700,marginBottom:12,display:'flex',alignItems:'center',gap:6}}>
              <Bell size={14} strokeWidth={2.2} color={T.acl}/>
              <span>알림 설정</span>
            </div>

            {/* 브라우저 알림 권한 */}
            <div style={{background:T.alt,borderRadius:10,padding:'10px 12px',marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700}}>브라우저 알림</div>
                  <div style={{color:T.muted,fontSize:10,marginTop:2}}>
                    {notifPerm === 'granted' ? '✓ 허용됨 — 푸시 알림 수신 가능'
                      : notifPerm === 'denied' ? '차단됨 — 브라우저 설정에서 변경 필요'
                      : notifPerm === 'unsupported' ? '이 브라우저는 알림 미지원'
                      : '알림을 받으려면 권한을 허용하세요'}
                  </div>
                </div>
                {notifPerm === 'default' && (
                  <button type="button"
                    onClick={async () => {
                      const { requestPermission } = await import('@/lib/notifications');
                      const r = await requestPermission();
                      setNotifPerm(r);
                      if (r === 'granted') showToast('알림이 허용되었습니다');
                      else if (r === 'denied') showToast('알림이 차단되었습니다');
                    }}
                    style={{flexShrink:0,background:T.acl,color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',minHeight:36,fontSize:11,fontWeight:700,cursor:'pointer'}}>
                    권한 허용
                  </button>
                )}
                {notifPerm === 'granted' && (
                  <button type="button"
                    onClick={async () => {
                      const { notify } = await import('@/lib/notifications');
                      notify('priceAlerts', 'TRAIGO 테스트 알림', { body: '알림이 정상 작동합니다!' });
                    }}
                    style={{flexShrink:0,background:T.alt,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'8px 14px',minHeight:36,fontSize:11,fontWeight:700,cursor:'pointer'}}>
                    테스트
                  </button>
                )}
              </div>
            </div>

            {[{k:'trade',l:'매매 완료'},{k:'profit',l:'수익 목표'},{k:'news',l:'시장 뉴스'},{k:'alert',l:'가격 알림'},{k:'leverage',l:'레버리지 경고'}].map((n,i,arr)=>(
              <div key={n.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                <span style={{color:T.txt,fontSize:12}}>{n.l}</span>
                <Toggle on={notif[n.k as keyof typeof notif]} onChange={v=>setNotif(p=>({...p,[n.k]:v}))}/>
              </div>
            ))}
          </Card>

          {/* Risk Profile */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:12,display:'flex',alignItems:'center',gap:6}}>
              <Target size={14} strokeWidth={2.2} color={T.acl}/>
              <span>위험 성향 설정</span>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {[{v:'conservative',l:'보수형',d:'안전 우선',c:T.grn},{v:'balanced',l:'균형형',d:'균형 추구',c:T.ylw},{v:'aggressive',l:'공격형',d:'수익 우선',c:T.red}].map(p=>(
                <button key={p.v}
                  type="button"
                  onClick={() => {
                    // 위험 성향 저장 + 더보기 → 리스크관리로 이동 안내
                    try { localStorage.setItem('tg_risk_profile', p.v); } catch {}
                    showToast(`${p.l} 선택됨 — 더보기 → 리스크관리에서 상세 설정`);
                  }}
                  style={{background:T.alt,border:`1px solid ${p.c}40`,borderRadius:12,padding:'12px 6px',cursor:'pointer',textAlign:'center',minHeight:84}}>
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
            <div style={{color:T.txt,fontWeight:700,marginBottom:12,display:'flex',alignItems:'center',gap:6}}>
              <Lock size={14} strokeWidth={2.2} color={T.acl}/>
              <span>보안 설정</span>
            </div>
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
              <button type="button"
                onClick={() => showToast('API 키 생성 기능은 곧 출시됩니다 (거래소 연결 페이지에서 등록)')}
                style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'6px 12px',minHeight:32,fontSize:11,fontWeight:700,cursor:'pointer'}}>+ 생성</button>
            </div>
            {(Array.isArray(apiKeys)?apiKeys:[]).map(k=>(
              <div key={k.id} style={{background:T.alt,borderRadius:10,padding:'10px 12px',marginBottom:8}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{k.name}</div><div style={{color:T.muted,fontSize:10}}>생성: {k.created} · 최근: {k.lastUsed}</div></div>
                  <div style={{display:'flex',gap:6,alignItems:'center'}}><Bdg c={T.grn} ch="활성"/>
                    <button type="button"
                      onClick={() => {
                        if (typeof window !== 'undefined' && window.confirm(`API 키 "${k.name}"을(를) 삭제하시겠습니까?`)) {
                          showToast('API 키 관리는 거래소 연결 페이지에서 가능합니다');
                        }
                      }}
                      style={{background:T.red+'15',color:T.red,border:'none',borderRadius:6,padding:'5px 10px',minHeight:30,fontSize:10,cursor:'pointer'}}>삭제</button>
                  </div>
                </div>
              </div>
            ))}
            <div style={{color:T.muted,fontSize:10,marginTop:6}}>⚠️ API 키는 절대 타인과 공유하지 마세요</div>
          </Card>

          {/* Login history (real) */}
          <LoginHistoryCard isAuthenticated={isAuthenticated}/>
        </div>
      )}

      {tab==='backup'&&(
        <div>
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:14,marginBottom:6,display:'flex',alignItems:'center',gap:6}}>
              <Database size={15} strokeWidth={2.2} color={T.acl}/>
              <span>데이터 백업</span>
            </div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6,marginBottom:14}}>
              포트폴리오·관심종목 그룹·매매기록·모의매매·알림 등 모든 사용자 데이터를 JSON 파일로 내보내거나 가져올 수 있습니다.
            </div>

            <button type="button" onClick={exportBackup}
              style={{width:'100%',padding:'13px',minHeight:48,
                background:'linear-gradient(135deg,#2563EB,#10B981)',
                color:'#fff',border:'none',borderRadius:12,
                fontWeight:800,fontSize:13,cursor:'pointer',marginBottom:10,
                display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
              <Upload size={15} strokeWidth={2.4}/>
              <span>백업 파일 내보내기</span>
            </button>

            <input ref={fileInputRef} type="file" accept=".json,application/json"
              onChange={e=>{
                const f=e.target.files?.[0];
                if(f) importBackup(f);
                e.target.value='';
              }}
              style={{display:'none'}}/>

            <button type="button" onClick={()=>fileInputRef.current?.click()} disabled={importing}
              style={{width:'100%',padding:'13px',minHeight:48,
                background:T.alt,color:T.txt,
                border:`1px solid ${T.border}`,borderRadius:12,
                fontWeight:700,fontSize:13,cursor:importing?'wait':'pointer',
                opacity:importing?0.6:1,marginBottom:10,
                display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
              {importing
                ? <><Hourglass size={14} strokeWidth={2.4}/><span>가져오는 중...</span></>
                : <><Download size={15} strokeWidth={2.4}/><span>백업 파일 가져오기</span></>}
            </button>

            <div style={{padding:'10px 12px',background:T.ylw+'10',
              border:`1px solid ${T.ylw}30`,borderRadius:10,
              color:T.ylw,fontSize:10,lineHeight:1.5,marginTop:6}}>
              ⚠️ 백업 파일에는 보유 종목·매매 내역 등 개인 정보가 포함됩니다. 안전한 곳에 보관하세요.
            </div>
          </Card>

          <Card style={{padding:16,marginBottom:12,
            background:T.red+'08',border:`1px solid ${T.red}30`}}>
            <div style={{color:T.red,fontWeight:700,fontSize:13,marginBottom:6}}>⚠️ 위험 구역</div>
            <div style={{color:T.muted,fontSize:11,lineHeight:1.6,marginBottom:12}}>
              아래 작업은 되돌릴 수 없습니다. 진행 전 반드시 백업해주세요.
            </div>
            <button type="button" onClick={clearAllData}
              style={{width:'100%',padding:'11px',minHeight:44,
                background:'transparent',color:T.red,
                border:`1px solid ${T.red}`,borderRadius:10,
                fontWeight:700,fontSize:12,cursor:'pointer'}}>
              🗑 모든 사용자 데이터 삭제
            </button>
          </Card>

          <Card style={{padding:14,marginBottom:12}}>
            <div style={{color:T.txt,fontWeight:700,fontSize:12,marginBottom:8}}>저장된 데이터 항목</div>
            <div style={{color:T.muted,fontSize:10,lineHeight:1.8}}>
              · 💼 포트폴리오 (tg_portfolio_v2)<br/>
              · 🗂 관심종목 그룹 (tg_watch_groups_v1)<br/>
              · 💰 수익계산기 기록 (tg_pnl_history_v1)<br/>
              · 📓 모의매매 계좌 (tg_paper_account_v1)<br/>
              · 🔔 알림 설정 (tg_alerts_v1)<br/>
              · 🔍 최근 검색어 (tg_recent_search_v1)<br/>
              · 📚 학습 진도 (tg_academy_v1)<br/>
              · 📝 매매일지 (tg_journal_v1)
            </div>
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
              <button type="button"
                onClick={() => showToast('Pro 구독은 베타 종료 후 출시 예정입니다. 베타 기간 모든 기능 무료!')}
                style={{width:'100%',padding:'14px',minHeight:50,background:`linear-gradient(135deg,${T.gld},#B45309)`,color:'#fff',border:'none',borderRadius:14,fontWeight:900,fontSize:15,cursor:'pointer'}}>
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
                <button type="button"
                  onClick={() => showToast(s.price === '무료' ? `"${s.name}" 적용은 곧 출시됩니다` : `${s.name} 구독은 Pro 출시 후 가능`)}
                  style={{background:s.price==='무료'?T.grn+'15':T.ylw+'15',color:s.price==='무료'?T.grn:T.ylw,border:`1px solid ${s.price==='무료'?T.grn:T.ylw}30`,borderRadius:8,padding:'6px 12px',minHeight:32,fontSize:10,fontWeight:700,cursor:'pointer'}}>{s.price}</button>
              </div>
            ))}
          </Card>

          {/* Referral */}
          <Card style={{padding:16}}>
            <div style={{color:T.txt,fontWeight:700,marginBottom:8}}>🎁 친구 초대</div>
            <div style={{color:T.muted,fontSize:11,marginBottom:10}}>친구를 초대하면 Pro 1개월을 무료로 받을 수 있습니다.</div>
            <div style={{display:'flex',gap:8}}>
              <input value="traigo.app/ref/MYCODE" readOnly style={{flex:1,background:T.alt,border:`1px solid ${T.border}`,borderRadius:8,padding:'8px 10px',color:T.sub,fontSize:11,outline:'none'}}/>
              <button type="button"
                onClick={async () => {
                  const code = 'traigo.app/ref/MYCODE';
                  try {
                    if (navigator?.clipboard?.writeText) {
                      await navigator.clipboard.writeText(code);
                      showToast('✅ 추천 링크 복사 완료');
                    } else {
                      showToast('이 브라우저는 클립보드를 지원하지 않습니다');
                    }
                  } catch {
                    showToast('복사 실패 - 직접 선택해주세요');
                  }
                }}
                style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'8px 14px',minHeight:36,fontSize:11,fontWeight:700,cursor:'pointer'}}>복사</button>
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

// ─────────────────────────────────────────────────────────────
// LoginHistoryCard — 실제 세션 데이터를 /api/auth/session-log에서 조회
// 비로그인이면 empty state. 로그인이면 본인 세션 목록 + 종료 버튼.
// ─────────────────────────────────────────────────────────────
interface SessionRow {
  id:           string;
  device_name:  string | null;
  device_type:  string | null;
  browser:      string | null;
  os:           string | null;
  ip_address:   string | null;
  country:      string | null;
  city:         string | null;
  is_current:   boolean;
  revoked:      boolean;
  last_seen_at: string;
  created_at:   string;
}

function LoginHistoryCard({ isAuthenticated }: { isAuthenticated: boolean }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    if (!isAuthenticated) { setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      const sb = getSupabaseClient();
      if (!sb) { setLoading(false); return; }
      const { data: { session } } = await sb.auth.getSession();
      if (!session?.access_token) { setLoading(false); return; }
      const r = await fetch('/api/auth/session-log', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) { setError(`status_${r.status}`); setLoading(false); return; }
      const d = await r.json();
      setSessions(Array.isArray(d.sessions) ? d.sessions : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  const revoke = useCallback(async (id: string) => {
    if (!confirm('이 세션을 종료하시겠습니까?\n(해당 기기는 다음 새로고침 시 재로그인 필요)')) return;
    try {
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      const sb = getSupabaseClient();
      if (!sb) return;
      const { data: { session } } = await sb.auth.getSession();
      if (!session?.access_token) return;
      const r = await fetch(`/api/auth/session-log?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (r.ok) fetchSessions();
    } catch {/* silent */}
  }, [fetchSessions]);

  const revokeAllOthers = useCallback(async () => {
    if (!confirm('현재 기기를 제외한 모든 세션을 즉시 종료하시겠습니까?\n\n• 다른 기기들은 즉시 또는 곧 로그아웃됩니다\n• 이 작업은 되돌릴 수 없습니다')) return;
    try {
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      const sb = getSupabaseClient();
      if (!sb) return;
      const { data: { session } } = await sb.auth.getSession();
      if (!session?.access_token) return;
      const r = await fetch('/api/auth/session-log?all_others=1', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (r.ok) {
        await fetchSessions();
        alert('다른 기기에서 모두 로그아웃 처리되었습니다');
      } else {
        const d = await r.json().catch(() => ({}));
        alert(`종료 실패: ${d.error || r.status}`);
      }
    } catch (e) {
      alert(`오류: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }, [fetchSessions]);

  if (!isAuthenticated) {
    return (
      <Card style={{padding:16}}>
        <div style={{color:T.txt,fontWeight:700,marginBottom:12,display:'flex',alignItems:'center',gap:6}}>
          로그인 기록
        </div>
        <div style={{padding:'18px 8px',textAlign:'center',color:T.muted,fontSize:11}}>
          로그인 후 본인 기기별 접속 기록을 확인할 수 있습니다
        </div>
      </Card>
    );
  }

  return (
    <Card style={{padding:16}}>
      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:12,flexWrap:'wrap'}}>
        <span style={{color:T.txt,fontWeight:700}}>로그인 기록</span>
        {sessions.length > 0 && (
          <span style={{color:T.muted,fontSize:10}}>· {sessions.length}개 활성 세션</span>
        )}
        <button onClick={fetchSessions} disabled={loading}
          style={{marginLeft:'auto',background:T.alt,color:T.muted,border:`1px solid ${T.border}`,borderRadius:6,padding:'4px 10px',minHeight:28,fontSize:9,fontWeight:700,cursor:loading?'wait':'pointer',opacity:loading?0.6:1}}>
          새로고침
        </button>
        {sessions.filter(s => !s.is_current).length > 0 && (
          <button onClick={revokeAllOthers}
            style={{background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:6,padding:'4px 10px',minHeight:28,fontSize:9,fontWeight:700,cursor:'pointer'}}>
            다른 기기 모두 로그아웃
          </button>
        )}
      </div>

      {loading ? (
        <div style={{padding:'14px 8px',textAlign:'center',color:T.muted,fontSize:11}}>
          기록을 불러오는 중...
        </div>
      ) : error ? (
        <div style={{padding:'10px',background:T.red+'10',border:`1px solid ${T.red}30`,borderRadius:6,color:T.red,fontSize:10}}>
          오류: {error}
        </div>
      ) : sessions.length === 0 ? (
        <div style={{padding:'18px 8px',textAlign:'center',color:T.muted,fontSize:11}}>
          아직 기록된 세션이 없습니다. 잠시 후 다시 확인해보세요.
        </div>
      ) : (
        sessions.map((s, i) => {
          const isCurrent = s.is_current;
          const deviceLabel = [s.device_name, s.browser].filter(Boolean).join(' · ') || '알 수 없는 기기';
          const osLine = [s.os, s.country, s.city].filter(Boolean).join(' · ');
          const timeLabel = (() => {
            try {
              const d = new Date(s.last_seen_at);
              const diffMs = Date.now() - d.getTime();
              const mins = Math.floor(diffMs / 60000);
              if (mins < 1)    return '방금 전';
              if (mins < 60)   return `${mins}분 전`;
              if (mins < 1440) return `${Math.floor(mins/60)}시간 전`;
              return d.toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
            } catch { return s.last_seen_at; }
          })();
          return (
            <div key={s.id} style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'10px 0',borderBottom: i < sessions.length - 1 ? `1px solid ${T.border}` : 'none', gap: 8}}>
              <div style={{flex:1, minWidth:0}}>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:2,flexWrap:'wrap'}}>
                  <span style={{color:T.txt,fontSize:12,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis'}}>
                    {deviceLabel}
                  </span>
                  {isCurrent && <Bdg c={T.grn} ch="현재"/>}
                </div>
                <div style={{color:T.muted,fontSize:10,lineHeight:1.5}}>
                  {osLine || '위치 정보 없음'}
                </div>
                <div style={{color:T.muted,fontSize:10,marginTop:1}}>
                  {timeLabel}
                  {s.ip_address && <span style={{marginLeft:4,fontFamily:'monospace',opacity:0.7}}>· {s.ip_address}</span>}
                </div>
              </div>
              {!isCurrent && (
                <button onClick={() => revoke(s.id)}
                  style={{background:T.red+'15',color:T.red,border:`1px solid ${T.red}30`,borderRadius:6,padding:'5px 9px',fontSize:10,fontWeight:700,cursor:'pointer',minHeight:30,flexShrink:0}}>
                  종료
                </button>
              )}
            </div>
          );
        })
      )}
    </Card>
  );
}


export default SettingsPage;