export default function TermsPage() {
  return (
    <div style={{ minHeight:'100vh', background:'#060B14', color:'#F0F6FF', fontFamily:"'Sora',sans-serif", padding:'40px 20px' }}>
      <div style={{ maxWidth:720, margin:'0 auto' }}>
        <a href="/" style={{ color:'#3B82F6', fontSize:13, textDecoration:'none', display:'block', marginBottom:24 }}>← TRAIGO로 돌아가기</a>
        <h1 style={{ fontSize:24, fontWeight:900, marginBottom:8 }}>이용약관</h1>
        <p style={{ color:'#94A3B8', fontSize:12, marginBottom:32 }}>최종 수정일: 2025년 5월 12일</p>
        {[
          {title:'제1조 (목적)',body:'본 약관은 TRAIGO가 제공하는 투자 시뮬레이션 서비스의 이용 조건을 규정합니다.'},
          {title:'제2조 (서비스 성격)',body:'TRAIGO는 교육 및 시뮬레이션 목적의 모의투자 플랫폼입니다. 실제 금융 거래를 실행하지 않으며, 어떠한 형태의 수익도 보장하지 않습니다.'},
          {title:'제3조 (이용자 의무)',body:'이용자는 본 서비스를 통해 얻은 정보를 실제 투자 결정의 유일한 근거로 사용해서는 안 됩니다. 모든 투자 손익은 이용자 본인의 책임입니다.'},
          {title:'제4조 (면책조항)',body:'서비스는 시세 정보의 정확성을 보장하지 않으며, 서비스 중단, 데이터 손실로 인한 손해에 책임을 지지 않습니다.'},
          {title:'제5조 (준거법)',body:'본 약관은 대한민국 법률에 따라 해석됩니다.'},
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
