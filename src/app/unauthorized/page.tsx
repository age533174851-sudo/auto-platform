'use client';
export default function UnauthorizedPage() {
  const T = { bg:'var(--t-bg)', card:'var(--t-card)', border:'var(--t-border)', acc:'#2563EB', acl:'#3B82F6', acg:'rgba(37,99,235,.15)', txt:'var(--t-txt)', muted:'var(--t-muted)' };
  return (
    <div style={{ minHeight:'100vh', background:T.bg, display:'flex', alignItems:'center', justifyContent:'center', padding:20, fontFamily:"'Sora',sans-serif" }}>
      <div style={{ textAlign:'center', maxWidth:380 }}>
        <div style={{ fontSize:56, marginBottom:16 }}>🔒</div>
        <div style={{ color:T.txt, fontWeight:900, fontSize:22, marginBottom:8 }}>접근 권한이 없습니다</div>
        <div style={{ color:T.muted, fontSize:13, lineHeight:1.7, marginBottom:24 }}>
          이 페이지에 접근하려면 관리자 권한이 필요합니다.<br/>
          일반 사용자 계정으로는 접근할 수 없습니다.
        </div>
        <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
          <a href="/auth" style={{ padding:'12px 22px', background:`linear-gradient(135deg,${T.acc},#7C3AED)`, color:'#fff', borderRadius:12, fontWeight:700, fontSize:13, textDecoration:'none' }}>로그인</a>
          <a href="/" style={{ padding:'12px 22px', background:T.card, color:T.muted, border:`1px solid ${T.border}`, borderRadius:12, fontWeight:700, fontSize:13, textDecoration:'none' }}>메인으로</a>
        </div>
      </div>
    </div>
  );
}
