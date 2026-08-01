'use client';
//
// 미들웨어가 관리자 화면 진입을 거절했을 때 도착하는 곳.
//
// 이유를 화면에 적는 이유: 거절 원인이 셋인데(권한 부족 / 프로필 없음 /
// 확인 실패) 화면이 다 똑같으면 사용자가 할 수 있는 일이 없다. 특히
// `lookup_failed`는 **권한 문제가 아니라 서버가 확인을 못 한 것**이라
// 잠시 뒤 다시 시도하면 되는데, "권한 없음"만 보이면 계정을 의심한다.
import { useEffect, useState } from 'react';

/** 미들웨어가 붙여 보낸 reason → 사용자가 무엇을 할 수 있는지 */
const REASON_TEXT: Record<string, { title: string; body: string; retry: boolean }> = {
  insufficient_role: {
    title: '접근 권한이 없습니다',
    body: '이 화면은 관리자 계정만 들어갈 수 있습니다. 로그인은 정상이지만 계정 등급이 부족합니다.',
    retry: false,
  },
  no_profile: {
    title: '프로필을 찾을 수 없습니다',
    body: '로그인은 됐지만 계정 정보(profiles) 행이 없습니다. 관리자에게 문의하세요.',
    retry: false,
  },
  lookup_failed: {
    title: '권한을 확인하지 못했습니다',
    body: '서버가 계정 등급을 확인하지 못했습니다. 권한이 없다는 뜻이 아닙니다 — 잠시 뒤 다시 시도해 주세요.',
    retry: true,
  },
};

const FALLBACK = {
  title: '접근 권한이 없습니다',
  body: '이 페이지에 접근하려면 관리자 권한이 필요합니다. 일반 사용자 계정으로는 접근할 수 없습니다.',
  retry: false,
};

export default function UnauthorizedPage() {
  const T = { bg:'var(--t-bg)', card:'var(--t-card)', border:'var(--t-border)', acc:'#2563EB', acl:'#3B82F6', acg:'rgba(37,99,235,.15)', txt:'var(--t-txt)', muted:'var(--t-muted)' };

  // 쿼리는 클라이언트에서 읽는다 — 이 페이지는 정적으로 미리 렌더되므로
  // 서버 렌더 시점에는 값이 없다.
  const [info, setInfo] = useState(FALLBACK);
  const [area, setArea] = useState<string|null>(null);
  const [reason, setReason] = useState<string|null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get('reason');
    setReason(r);
    setArea(q.get('area'));
    if (r && REASON_TEXT[r]) setInfo(REASON_TEXT[r]);
  }, []);

  return (
    <div style={{ minHeight:'100vh', background:T.bg, display:'flex', alignItems:'center', justifyContent:'center', padding:20, fontFamily:"'Sora',sans-serif" }}>
      <div style={{ textAlign:'center', maxWidth:380 }}>
        <div style={{ fontSize:56, marginBottom:16 }}>{info.retry ? '⏳' : '🔒'}</div>
        <div style={{ color:T.txt, fontWeight:900, fontSize:22, marginBottom:8 }}>{info.title}</div>
        <div style={{ color:T.muted, fontSize:13, lineHeight:1.7, marginBottom:20 }}>
          {info.body}
          {area && <><br/><span style={{ fontSize:11 }}>요청한 화면: /{area}</span></>}
        </div>

        {/* 문의할 때 이 값이 있으면 원인을 바로 좁힐 수 있다 */}
        {reason && (
          <div style={{ color:T.muted, fontSize:10, marginBottom:20, opacity:.7 }}>
            사유 코드: <code style={{ color:T.acl }}>{reason}</code>
          </div>
        )}

        <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
          {info.retry
            ? <button onClick={()=>window.location.reload()} style={{ padding:'12px 22px', background:`linear-gradient(135deg,${T.acc},#7C3AED)`, color:'#fff', border:'none', borderRadius:12, fontWeight:700, fontSize:13, cursor:'pointer' }}>다시 시도</button>
            : <a href="/auth" style={{ padding:'12px 22px', background:`linear-gradient(135deg,${T.acc},#7C3AED)`, color:'#fff', borderRadius:12, fontWeight:700, fontSize:13, textDecoration:'none' }}>로그인</a>}
          <a href="/" style={{ padding:'12px 22px', background:T.card, color:T.muted, border:`1px solid ${T.border}`, borderRadius:12, fontWeight:700, fontSize:13, textDecoration:'none' }}>메인으로</a>
        </div>
      </div>
    </div>
  );
}
