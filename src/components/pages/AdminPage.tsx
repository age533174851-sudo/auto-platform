'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { T } from '@/lib/constants';

function AdminPage() {
  const [aTab,setATab]=useState<'health'|'users'|'strategies'|'exchanges'|'logs'|'control'>('health');
  const [health,setHealth]=useState<any>(null);
  const [users,setUsers]=useState<any[]>([]);
  const [strategies,setStrategies]=useState<any[]>([]);
  const [exchanges,setExchanges]=useState<any[]>([]);
  const [logs,setLogs]=useState<any[]>([]);
  const [loading,setLoading]=useState(false);
  const [msg,setMsg]=useState('');

  const authHeader = useCallback(async()=>{
    try{
      const {getSupabaseClient}=await import('@/lib/supabase/client');
      const sb=getSupabaseClient();
      if(!sb) return {};
      const {data:{session}}=await sb.auth.getSession();
      if(!session) return {};
      return {'Authorization':`Bearer ${session.access_token}`,'Content-Type':'application/json'};
    }catch{return {};}
  },[]);

  const load=useCallback(async(tab:string)=>{
    setLoading(true);
    try{
      const headers=await authHeader();
      if(tab==='health'){
        const r=await fetch('/api/admin?action=health',{headers});
        setHealth(await r.json());
      } else if(tab==='users'){
        const r=await fetch('/api/admin?action=users',{headers});
        const d=await r.json();
        setUsers(d.users||[]);
      } else if(tab==='strategies'){
        const r=await fetch('/api/admin?action=strategy_status',{headers});
        const d=await r.json();
        setStrategies(d.strategies||[]);
      } else if(tab==='exchanges'){
        const r=await fetch('/api/admin?action=exchange_status',{headers});
        const d=await r.json();
        setExchanges(d.connections||[]);
      } else if(tab==='logs'){
        const r=await fetch('/api/admin?action=audit_logs&limit=100',{headers});
        const d=await r.json();
        setLogs(d.logs||[]);
      }
    }catch(e){console.error(e);}
    setLoading(false);
  },[authHeader]);

  useEffect(()=>{load(aTab);},[aTab,load]);

  const doAction=useCallback(async(action:string,body:Record<string,unknown>={})=>{
    setMsg('');
    try{
      const headers=await authHeader();
      const r=await fetch('/api/admin',{method:'POST',headers,body:JSON.stringify({action,...body})});
      const d=await r.json();
      if(r.ok) setMsg(d.message||'완료');
      else setMsg(`오류: ${d.error}`);
    }catch(e){setMsg(String(e));}
  },[authHeader]);

  const TABS=[
    {id:'health',label:'API 헬스',icon:'💚'},
    {id:'users',label:'사용자',icon:'👥'},
    {id:'strategies',label:'전략 현황',icon:'🤖'},
    {id:'exchanges',label:'거래소',icon:'🔗'},
    {id:'logs',label:'감사 로그',icon:'📋'},
    {id:'control',label:'긴급 제어',icon:'⚡'},
  ] as const;

  return (
    <div style={{padding:'4px 0'}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
        <div style={{width:32,height:32,borderRadius:10,background:'rgba(16,185,129,0.15)',border:'1px solid rgba(16,185,129,0.4)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:16}}>🛡️</div>
        <div>
          <div style={{color:T.txt,fontWeight:800,fontSize:15}}>관리자 대시보드</div>
          <div style={{color:T.muted,fontSize:10}}>역할: admin · 서버사이드 검증됨</div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{display:'flex',gap:4,overflowX:'auto',marginBottom:12,paddingBottom:2}}>
        {TABS.map(tb=>(
          <button key={tb.id} onClick={()=>setATab(tb.id)} style={{flexShrink:0,padding:'6px 10px',background:aTab===tb.id?'rgba(16,185,129,0.15)':'transparent',border:`1px solid ${aTab===tb.id?'rgba(16,185,129,0.5)':T.border}`,borderRadius:10,color:aTab===tb.id?'#10B981':T.muted,fontSize:11,fontWeight:700,cursor:'pointer'}}>
            {tb.icon} {tb.label}
          </button>
        ))}
      </div>

      {loading&&<div style={{textAlign:'center',color:T.muted,fontSize:12,padding:'20px 0'}}>로딩 중…</div>}

      {/* Health */}
      {!loading&&aTab==='health'&&health&&(
        <div>
          <div style={{background:health.connected?'rgba(16,185,129,0.08)':'rgba(239,68,68,0.08)',border:`1px solid ${health.connected?'rgba(16,185,129,0.3)':'rgba(239,68,68,0.3)'}`,borderRadius:12,padding:'12px 14px',marginBottom:10}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
              <span style={{fontSize:16}}>{health.connected?'✅':'❌'}</span>
              <span style={{color:T.txt,fontWeight:700,fontSize:13}}>{health.message}</span>
              {health.latencyMs!=null&&<span style={{color:T.muted,fontSize:10,marginLeft:'auto'}}>{health.latencyMs}ms</span>}
            </div>
            {health.env&&Object.entries(health.env).map(([k,v])=>(
              <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'3px 0',borderTop:`1px solid ${T.border}`}}>
                <span style={{color:T.muted,fontSize:10,fontFamily:'monospace'}}>{k}</span>
                <span style={{color:v?'#10B981':'#EF4444',fontSize:10,fontWeight:700}}>{v?'✓ 설정됨':'✗ 없음'}</span>
              </div>
            ))}
          </div>
          <button onClick={()=>load('health')} style={{width:'100%',padding:'8px',background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,color:T.acl,fontSize:11,fontWeight:700,cursor:'pointer'}}>🔄 새로고침</button>
        </div>
      )}

      {/* Users */}
      {!loading&&aTab==='users'&&(
        <div>
          <div style={{color:T.muted,fontSize:10,marginBottom:8}}>총 {users.length}명</div>
          {(Array.isArray(users)?users:[]).map((u:any)=>(
            <div key={u.id} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'10px 12px',marginBottom:6}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div>
                  <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{u.display_name||u.email}</div>
                  <div style={{color:T.muted,fontSize:10}}>{u.email}</div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:u.role==='admin'?'#10B981':T.acl,fontSize:10,fontWeight:700}}>{u.role}</div>
                  <div style={{color:u.status==='banned'?'#EF4444':T.muted,fontSize:10}}>{u.status}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Strategies */}
      {!loading&&aTab==='strategies'&&(
        <div>
          <div style={{color:T.muted,fontSize:10,marginBottom:8}}>전략 {strategies.length}개</div>
          {(Array.isArray(strategies)?strategies:[]).map((s:any)=>(
            <div key={s.id} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'9px 12px',marginBottom:6}}>
              <div style={{display:'flex',justifyContent:'space-between'}}>
                <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{s.name}</div>
                <div style={{color:s.enabled?'#10B981':'#EF4444',fontSize:10,fontWeight:700}}>{s.status}</div>
              </div>
              <div style={{color:T.muted,fontSize:10}}>{s.asset} · {s.exec_mode}</div>
            </div>
          ))}
        </div>
      )}

      {/* Exchanges */}
      {!loading&&aTab==='exchanges'&&(
        <div>
          <div style={{color:T.muted,fontSize:10,marginBottom:8}}>연결 {exchanges.length}개</div>
          {(Array.isArray(exchanges)?exchanges:[]).map((c:any)=>(
            <div key={c.id} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'9px 12px',marginBottom:6}}>
              <div style={{display:'flex',justifyContent:'space-between'}}>
                <div style={{color:T.txt,fontSize:12,fontWeight:700}}>{c.label||c.exchange_id}</div>
                <div style={{color:c.is_active?'#10B981':'#EF4444',fontSize:10,fontWeight:700}}>{c.is_active?'활성':'비활성'}</div>
              </div>
              <div style={{color:T.muted,fontSize:10}}>{c.test_status||'미테스트'} · {c.last_tested_at?.slice(0,10)||'-'}</div>
            </div>
          ))}
        </div>
      )}

      {/* Audit Logs */}
      {!loading&&aTab==='logs'&&(
        <div>
          <div style={{color:T.muted,fontSize:10,marginBottom:8}}>최근 {logs.length}건</div>
          {(Array.isArray(logs)?logs:[]).map((l:any)=>(
            <div key={l.id} style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:10,padding:'8px 12px',marginBottom:5}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{color:T.acl,fontSize:11,fontWeight:700,fontFamily:'monospace'}}>{l.action}</span>
                <span style={{color:T.muted,fontSize:9}}>{l.created_at?.slice(0,16).replace('T',' ')}</span>
              </div>
              <div style={{color:T.muted,fontSize:10}}>{l.result} {l.details?JSON.stringify(l.details).slice(0,60):''}…</div>
            </div>
          ))}
        </div>
      )}

      {/* Emergency Control */}
      {aTab==='control'&&(
        <div>
          {msg&&<div style={{background:'rgba(16,185,129,0.1)',border:'1px solid rgba(16,185,129,0.3)',borderRadius:10,padding:'10px 12px',marginBottom:10,color:'#10B981',fontSize:12,fontWeight:700}}>{msg}</div>}
          <div style={{background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.3)',borderRadius:12,padding:'14px',marginBottom:10}}>
            <div style={{color:'#EF4444',fontWeight:800,fontSize:13,marginBottom:4}}>⚡ 긴급 전략 전체 정지</div>
            <div style={{color:T.muted,fontSize:11,marginBottom:12}}>실행 중인 모든 자동매매 전략을 즉시 중지합니다.</div>
            <button onClick={()=>doAction('emergency_stop',{reason:'관리자 긴급 정지'})} style={{width:'100%',padding:'10px',background:'rgba(239,68,68,0.15)',border:'1px solid rgba(239,68,68,0.5)',borderRadius:10,color:'#EF4444',fontSize:12,fontWeight:800,cursor:'pointer'}}>
              🛑 전체 봇 긴급 정지
            </button>
          </div>
          <div style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:12,padding:'14px',marginBottom:10}}>
            <div style={{color:T.txt,fontWeight:800,fontSize:13,marginBottom:4}}>🔧 유지보수 모드</div>
            <div style={{color:T.muted,fontSize:11,marginBottom:12}}>유지보수 모드를 감사 로그에 기록합니다.</div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>doAction('maintenance_mode',{enabled:true,reason:'정기 유지보수'})} style={{flex:1,padding:'8px',background:T.surf,border:`1px solid ${T.border}`,borderRadius:10,color:T.ylw,fontSize:11,fontWeight:700,cursor:'pointer'}}>🟡 시작</button>
              <button onClick={()=>doAction('maintenance_mode',{enabled:false})} style={{flex:1,padding:'8px',background:T.surf,border:`1px solid ${T.border}`,borderRadius:10,color:T.grn,fontSize:11,fontWeight:700,cursor:'pointer'}}>🟢 해제</button>
            </div>
          </div>
          <div style={{background:T.alt,border:`1px solid ${T.border}`,borderRadius:12,padding:'12px',color:T.muted,fontSize:10}}>
            ℹ️ 관리자 승격은 Supabase SQL에서만 가능합니다:<br/>
            <code style={{color:T.acl,fontSize:9}}>UPDATE profiles SET role = 'admin' WHERE email = 'user@example.com';</code>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminPage;
