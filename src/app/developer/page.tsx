'use client';
import React, { useState, useEffect } from 'react';
import {
  UserProfile, getMockSession, canAccessDeveloper, ROLE_INFO,
} from '@/lib/auth';

const T = {
  bg:'#060B14', card:'#0F1924', border:'#1A2D4A', border2:'#243A5E',
  acc:'#2563EB', acl:'#3B82F6', acg:'rgba(37,99,235,.15)',
  grn:'#10B981', red:'#EF4444', ylw:'#F59E0B', prp:'#7C3AED',
  cyn:'#0891B2', gld:'#D97706',
  txt:'#F0F6FF', sub:'#94A3B8', muted:'#475569', surf:'#0D1626',
};

function Card({children,style}:{children?:React.ReactNode;style?:React.CSSProperties;[key:string]:any}) {
  return <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,...style}}>{children}</div>;
}
function Bdg({c,ch}:{c:string;ch:string}) {
  return <span style={{background:c+'20',color:c,fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:99,border:`1px solid ${c}30`,whiteSpace:'nowrap'}}>{ch}</span>;
}
function Dot({c}:{c:string}) {
  return <div style={{width:8,height:8,borderRadius:'50%',background:c,boxShadow:`0 0 6px ${c}80`}}/>;
}
function Toggle({on,onChange}:{on:boolean;onChange:(v:boolean)=>void}) {
  return (
    <button onClick={()=>onChange(!on)} style={{width:40,height:22,borderRadius:11,background:on?T.grn:'#1A2D4A',border:'none',cursor:'pointer',position:'relative',transition:'background .2s',flexShrink:0}}>
      <div style={{position:'absolute',top:3,left:on?20:3,width:16,height:16,borderRadius:8,background:'#fff',transition:'left .2s'}}/>
    </button>
  );
}

const MOCK_ERRORS = [
  {id:'e1',level:'warn',msg:'Binance WS reconnect #3',file:'api/prices/route.ts',time:'09:32:14',count:3},
  {id:'e2',level:'info',msg:'Asset cache miss: PLTR — fetching mock',file:'lib/assetSearch.ts',time:'09:31:05',count:1},
  {id:'e3',level:'info',msg:'GlobalSearch: 8 results from mock provider',file:'app/page.tsx',time:'09:30:44',count:12},
  {id:'e4',level:'error',msg:'supabase not configured — using mock session',file:'lib/auth.ts',time:'09:30:01',count:1},
];

const API_STATUS = [
  {name:'Binance REST',status:'operational',latency:'142ms',uptime:'99.8%'},
  {name:'Binance WebSocket',status:'degraded',latency:'892ms',uptime:'94.2%'},
  {name:'CoinGecko',status:'operational',latency:'341ms',uptime:'98.1%'},
  {name:'Polygon.io',status:'unconfigured',latency:'-',uptime:'-'},
  {name:'KIS Open API',status:'unconfigured',latency:'-',uptime:'-'},
  {name:'Supabase',status:'unconfigured',latency:'-',uptime:'-'},
];

export default function DeveloperPage() {
  const [session,setSession]=useState<UserProfile|null>(null);
  const [loading,setLoading]=useState(true);
  const [tab,setTab]=useState<'status'|'logs'|'flags'|'deploy'>('status');
  const [testMode,setTestMode]=useState(true);
  const [logFilter,setLogFilter]=useState<'all'|'error'|'warn'|'info'>('all');
  const [flags,setFlags]=useState({
    mockAuth:true, mockPrices:true, mockOrders:true,
    supabase:false, realTradingApi:false,
    debugBanner:true, verboseLog:false, performanceMetrics:false,
  });
  const [uptime]=useState({start:'2025-05-13 09:00:00',hours:4,builds:127,deploys:14});

  useEffect(()=>{const s=getMockSession();setSession(s);setLoading(false);},[]);

  if(loading) return <div style={{minHeight:'100vh',background:T.bg,display:'flex',alignItems:'center',justifyContent:'center'}}><div style={{color:T.muted,fontSize:13}}>로딩 중…</div></div>;

  if(!session||!canAccessDeveloper(session.role)) {
    return (
      <div style={{minHeight:'100vh',background:T.bg,display:'flex',alignItems:'center',justifyContent:'center',padding:20,fontFamily:"'Sora',sans-serif"}}>
        <div style={{textAlign:'center',maxWidth:360}}>
          <div style={{fontSize:48,marginBottom:16}}>🔒</div>
          <div style={{color:T.txt,fontWeight:800,fontSize:20,marginBottom:8}}>개발자 전용 페이지</div>
          <div style={{color:T.muted,fontSize:13,lineHeight:1.6,marginBottom:20}}>developer 또는 super_admin 계정이 필요합니다.</div>
          <a href="/auth" style={{display:'inline-block',padding:'12px 24px',background:T.acc,color:'#fff',borderRadius:12,fontWeight:700,fontSize:13,textDecoration:'none',marginRight:8}}>로그인</a>
          <a href="/" style={{display:'inline-block',padding:'12px 24px',background:T.card,color:T.muted,border:`1px solid ${T.border}`,borderRadius:12,fontWeight:700,fontSize:13,textDecoration:'none'}}>홈으로</a>
        </div>
      </div>
    );
  }

  const ri=ROLE_INFO[session.role];
  const filteredLogs=logFilter==='all'?MOCK_ERRORS:MOCK_ERRORS.filter(e=>e.level===logFilter);

  return (
    <div style={{minHeight:'100vh',background:T.bg,fontFamily:"'Sora',sans-serif",color:T.txt}}>
      {/* Top bar */}
      <div style={{background:T.surf,borderBottom:`1px solid ${T.border}`,padding:'12px 16px',display:'flex',justifyContent:'space-between',alignItems:'center',position:'sticky',top:0,zIndex:50}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:`linear-gradient(135deg,${T.prp},#5B21B6)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16}}>⚙️</div>
          <div>
            <div style={{color:T.txt,fontWeight:800,fontSize:13}}>TRAIGO 개발자 대시보드</div>
            <div style={{color:T.muted,fontSize:10}}>{session.displayName} · {ri.label}</div>
          </div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {testMode&&<Bdg c={T.ylw} ch="🧪 테스트 모드"/>}
          <a href="/admin" style={{background:T.grn+'20',color:T.grn,border:`1px solid ${T.grn}40`,borderRadius:8,padding:'5px 10px',fontSize:11,fontWeight:700,textDecoration:'none'}}>🛡️ 관리자</a>
          <a href="/" style={{background:T.acg,color:T.acl,border:`1px solid ${T.acl}40`,borderRadius:8,padding:'5px 10px',fontSize:11,fontWeight:700,textDecoration:'none'}}>🏠</a>
        </div>
      </div>

      <div style={{maxWidth:800,margin:'0 auto',padding:'16px 16px 80px'}}>
        {/* System health mini bar */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:16}}>
          {[
            {l:'서버 상태',v:'정상',c:T.grn,icon:'🟢'},
            {l:'빌드 상태',v:`#${uptime.builds}`,c:T.grn,icon:'✅'},
            {l:'가동 시간',v:`${uptime.hours}h`,c:T.acl,icon:'⏱'},
            {l:'배포 횟수',v:`${uptime.deploys}회`,c:T.muted,icon:'🚀'},
          ].map(s=>(
            <Card key={s.l} style={{padding:'10px 8px',textAlign:'center'}}>
              <div style={{fontSize:14,marginBottom:2}}>{s.icon}</div>
              <div style={{color:s.c,fontSize:13,fontWeight:900,fontFamily:'monospace'}}>{s.v}</div>
              <div style={{color:T.muted,fontSize:9,marginTop:1}}>{s.l}</div>
            </Card>
          ))}
        </div>

        {/* Tabs */}
        <div style={{display:'flex',gap:6,marginBottom:16,overflowX:'auto'}}>
          {([['status','📡 시스템 상태'],['logs','📋 에러 로그'],['flags','🚩 개발 플래그'],['deploy','🚀 배포']] as const).map(([id,label])=>(
            <button key={id} onClick={()=>setTab(id)} style={{flexShrink:0,padding:'8px 14px',background:tab===id?T.prp+'25':'transparent',color:tab===id?T.prp:T.muted,border:`1px solid ${tab===id?T.prp:T.border}`,borderRadius:10,fontWeight:700,fontSize:12,cursor:'pointer'}}>{label}</button>
          ))}
        </div>

        {/* STATUS */}
        {tab==='status'&&(
          <div>
            <Card style={{padding:'16px',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>📡 API 상태</div>
              {API_STATUS.map((api,i)=>(
                <div key={api.name} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<API_STATUS.length-1?`1px solid ${T.border}`:'none'}}>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}>
                    <Dot c={api.status==='operational'?T.grn:api.status==='degraded'?T.ylw:T.muted}/>
                    <div>
                      <div style={{color:T.txt,fontSize:12,fontWeight:600}}>{api.name}</div>
                      <div style={{color:T.muted,fontSize:10}}>응답: {api.latency} · 가동률: {api.uptime}</div>
                    </div>
                  </div>
                  <Bdg c={api.status==='operational'?T.grn:api.status==='degraded'?T.ylw:T.muted} ch={api.status==='operational'?'정상':api.status==='degraded'?'저하':'미설정'}/>
                </div>
              ))}
            </Card>

            <Card style={{padding:'16px',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🗄️ 데이터베이스 상태</div>
              {[
                {name:'Supabase (PostgreSQL)',status:false,note:'NEXT_PUBLIC_SUPABASE_URL 미설정'},
                {name:'Redis Cache',status:false,note:'KV 저장소 미연결'},
                {name:'localStorage (폴백)',status:true,note:'클라이언트 로컬 캐시 — 활성'},
                {name:'메모리 캐시',status:true,note:'assetCache.ts — 활성'},
              ].map((db,i)=>(
                <div key={db.name} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}>
                    <Dot c={db.status?T.grn:T.muted}/>
                    <div><div style={{color:T.txt,fontSize:12,fontWeight:600}}>{db.name}</div><div style={{color:T.muted,fontSize:10}}>{db.note}</div></div>
                  </div>
                  <Bdg c={db.status?T.grn:T.muted} ch={db.status?'활성':'비활성'}/>
                </div>
              ))}
            </Card>

            <Card style={{padding:'16px',border:`1px solid ${T.ylw}30`}}>
              <div style={{color:T.ylw,fontWeight:700,marginBottom:10}}>⚠️ 설정 필요 항목</div>
              {[
                {l:'NEXT_PUBLIC_SUPABASE_URL',desc:'Supabase 프로젝트 URL'},
                {l:'NEXT_PUBLIC_SUPABASE_ANON_KEY',desc:'Supabase anon 키'},
                {l:'POLYGON_API_KEY',desc:'미국주식 실시간 검색'},
                {l:'KIS_APP_KEY',desc:'한국주식 (KIS Open API)'},
              ].map((env,i)=>(
                <div key={env.l} style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                  <div><div style={{color:T.txt,fontSize:11,fontFamily:'monospace'}}>{env.l}</div><div style={{color:T.muted,fontSize:10}}>{env.desc}</div></div>
                  <Bdg c={T.ylw} ch="미설정"/>
                </div>
              ))}
              <div style={{color:T.muted,fontSize:10,marginTop:8}}>→ .env.local 파일에 추가하세요</div>
            </Card>
          </div>
        )}

        {/* LOGS */}
        {tab==='logs'&&(
          <div>
            <div style={{display:'flex',gap:6,marginBottom:12}}>
              {(['all','error','warn','info'] as const).map(f=>(
                <button key={f} onClick={()=>setLogFilter(f)} style={{padding:'5px 10px',background:logFilter===f?(f==='error'?T.red:f==='warn'?T.ylw:f==='info'?T.acl:T.prp)+'25':'transparent',color:logFilter===f?(f==='error'?T.red:f==='warn'?T.ylw:f==='info'?T.acl:T.prp):T.muted,border:`1px solid ${logFilter===f?(f==='error'?T.red:f==='warn'?T.ylw:f==='info'?T.acl:T.prp):T.border}`,borderRadius:8,fontSize:11,fontWeight:700,cursor:'pointer'}}>
                  {f==='all'?'전체':f.toUpperCase()}
                </button>
              ))}
            </div>
            {filteredLogs.map(log=>(
              <Card key={log.id} style={{padding:'12px 14px',marginBottom:8,border:`1px solid ${log.level==='error'?T.red:log.level==='warn'?T.ylw:T.border}30`}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                  <span style={{background:(log.level==='error'?T.red:log.level==='warn'?T.ylw:T.acl)+'20',color:(log.level==='error'?T.red:log.level==='warn'?T.ylw:T.acl),fontSize:9,fontWeight:700,padding:'2px 6px',borderRadius:5,fontFamily:'monospace'}}>{log.level.toUpperCase()}</span>
                  <span style={{color:T.muted,fontSize:9,fontFamily:'monospace'}}>{log.time} ×{log.count}</span>
                </div>
                <div style={{color:T.txt,fontSize:12,fontFamily:'monospace',marginBottom:3}}>{log.msg}</div>
                <div style={{color:T.muted,fontSize:10}}>{log.file}</div>
              </Card>
            ))}
          </div>
        )}

        {/* FLAGS */}
        {tab==='flags'&&(
          <div>
            <div style={{background:T.ylw+'12',border:`1px solid ${T.ylw}30`,borderRadius:10,padding:'10px 14px',marginBottom:12}}>
              <div style={{color:T.ylw,fontWeight:700,fontSize:11}}>🧪 개발 플래그 — 프로덕션에서 비활성화</div>
            </div>
            <Card style={{padding:'16px',marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                <div style={{color:T.txt,fontWeight:700}}>테스트 모드 (전역)</div>
                <Toggle on={testMode} onChange={setTestMode}/>
              </div>
              <div style={{color:T.muted,fontSize:11,marginBottom:0}}>모의매매 기본값, API 키 없이 동작, mock 데이터 사용</div>
            </Card>
            <Card style={{padding:'16px'}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>개별 플래그</div>
              {(Object.entries(flags) as [string,boolean][]).map(([key,val],i,arr)=>{
                const labels:Record<string,{l:string;d:string;danger:boolean}> = {
                  mockAuth:{l:'Mock 인증',d:'localStorage 세션 사용',danger:false},
                  mockPrices:{l:'Mock 시세',d:'Binance API 대신 시뮬레이션',danger:false},
                  mockOrders:{l:'Mock 주문',d:'모든 주문이 모의로 처리됨',danger:false},
                  supabase:{l:'Supabase 연결',d:'실제 DB 연결 활성화',danger:true},
                  realTradingApi:{l:'실제 거래 API',d:'⚠️ 실제 자금 이동 가능',danger:true},
                  debugBanner:{l:'디버그 배너',d:'UI 경고 배너 표시',danger:false},
                  verboseLog:{l:'상세 로그',d:'콘솔 상세 출력',danger:false},
                  performanceMetrics:{l:'성능 지표',d:'렌더링 성능 측정',danger:false},
                };
                const info=labels[key]||{l:key,d:'',danger:false};
                return (
                  <div key={key} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<arr.length-1?`1px solid ${T.border}`:'none'}}>
                    <div>
                      <div style={{display:'flex',gap:5,alignItems:'center'}}>
                        <span style={{color:info.danger?T.red:T.txt,fontSize:12,fontWeight:600}}>{info.l}</span>
                        {info.danger&&<Bdg c={T.red} ch="위험"/>}
                      </div>
                      <div style={{color:T.muted,fontSize:10}}>{info.d}</div>
                    </div>
                    <Toggle on={val} onChange={v=>setFlags(p=>({...p,[key]:v}))}/>
                  </div>
                );
              })}
            </Card>
          </div>
        )}

        {/* DEPLOY */}
        {tab==='deploy'&&(
          <div>
            <Card style={{padding:'16px',marginBottom:12,border:`1px solid ${T.grn}30`}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:12}}>🚀 배포 현황</div>
              {[
                {env:'Production',branch:'main',commit:'a1b2c3d',time:'2025-05-13 09:00',status:'deployed'},
                {env:'Preview',branch:'feature/subscription',commit:'e4f5g6h',time:'2025-05-12 18:30',status:'building'},
                {env:'Development',branch:'dev',commit:'local',time:'지금',status:'local'},
              ].map((d,i)=>(
                <div key={d.env} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:i<2?`1px solid ${T.border}`:'none'}}>
                  <div>
                    <div style={{display:'flex',gap:5,alignItems:'center'}}>
                      <span style={{color:T.txt,fontSize:12,fontWeight:700}}>{d.env}</span>
                      <Bdg c={d.status==='deployed'?T.grn:d.status==='building'?T.ylw:T.acl} ch={d.status==='deployed'?'배포됨':d.status==='building'?'빌드중':'로컬'}/>
                    </div>
                    <div style={{color:T.muted,fontSize:10,marginTop:2}}>{d.branch} · {d.commit} · {d.time}</div>
                  </div>
                </div>
              ))}
            </Card>

            <Card style={{padding:'16px',marginBottom:12}}>
              <div style={{color:T.txt,fontWeight:700,marginBottom:10}}>⚡ 빠른 명령어</div>
              {[
                {cmd:'npm run build',desc:'TypeScript 빌드 확인'},
                {cmd:'npx vercel --prod',desc:'Vercel 프로덕션 배포'},
                {cmd:'npm install @supabase/supabase-js',desc:'Supabase 패키지 설치'},
                {cmd:'npx supabase init',desc:'Supabase CLI 초기화'},
              ].map((c,i)=>(
                <div key={c.cmd} style={{padding:'8px 0',borderBottom:i<3?`1px solid ${T.border}`:'none'}}>
                  <div style={{color:T.grn,fontFamily:'monospace',fontSize:11,fontWeight:700,marginBottom:2}}>{c.cmd}</div>
                  <div style={{color:T.muted,fontSize:10}}>{c.desc}</div>
                </div>
              ))}
            </Card>

            <Card style={{padding:'16px',border:`1px solid ${T.prp}30`}}>
              <div style={{color:T.prp,fontWeight:700,marginBottom:10}}>📦 tech stack</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:6}}>
                {[['Next.js','14.2.5'],['React','18.3.1'],['TypeScript','5.5.3'],['Tailwind CSS','3.4.4'],['Supabase','(미설치)'],['next.config.js','ignoreBuildErrors: true']].map(([k,v])=>(
                  <div key={k} style={{background:T.bg,borderRadius:8,padding:'7px 10px'}}>
                    <div style={{color:T.muted,fontSize:9}}>{k}</div>
                    <div style={{color:T.txt,fontSize:10,fontWeight:700,marginTop:1}}>{v}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
