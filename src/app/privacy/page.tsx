export default function PrivacyPage() {
  return (
    <div style={{ minHeight:'100vh', background:'#060B14', color:'#F0F6FF', fontFamily:"'Sora',sans-serif", padding:'40px 20px' }}>
      <div style={{ maxWidth:720, margin:'0 auto' }}>
        <a href="/" style={{ color:'#3B82F6', fontSize:13, textDecoration:'none', display:'block', marginBottom:24 }}>← TRAIGO로 돌아가기</a>
        <h1 style={{ fontSize:24, fontWeight:900, marginBottom:8 }}>개인정보처리방침</h1>
        <p style={{ color:'#94A3B8', fontSize:12, marginBottom:32 }}>최종 수정일: 2025년 5월 12일</p>
        {[
          {title:'수집하는 정보',body:'이메일 주소, 설정 정보(언어/통화), 모의거래 기록. 실제 금융 정보는 수집하지 않습니다.'},
          {title:'정보 이용 목적',body:'서비스 제공 및 개선, 계정 인증, 개인화된 경험 제공.'},
          {title:'정보 보관 기간',body:'계정 삭제 시 30일 이내 모든 개인정보를 삭제합니다.'},
          {title:'제3자 제공',body:'법령에 따른 경우를 제외하고 이용자의 동의 없이 개인정보를 제3자에게 제공하지 않습니다.'},
          {title:'문의',body:'개인정보 관련 문의: privacy@traigo.app'},
        ].map(s => (
          <div key={s.title} style={{ marginBottom:28 }}>
            <h2 style={{ fontSize:16, fontWeight:700, marginBottom:8, color:'#3B82F6' }}>{s.title}</h2>
            <p style={{ color:'#94A3B8', fontSize:13, lineHeight:1.8 }}>{s.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
