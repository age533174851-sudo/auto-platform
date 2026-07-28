// src/app/terminal/page.tsx
//
// PC 전용 터미널. 모바일 화면(/)은 그대로 두고 별도 경로로 뗐다.
//
// 같은 화면을 폭에 맞춰 줄이지 않는 이유: 줄이면 주문 버튼과 Kill Switch까지
// 작아진다. 그 둘은 어느 화면에서든 커야 한다. 그래서 PC는 PC 배치,
// 모바일은 모바일 배치로 각자 만든다.
import dynamic from 'next/dynamic';

// TradingView iframe · WebSocket · localStorage를 쓰므로 서버 렌더는 의미가 없다.
const TerminalShell = dynamic(() => import('@/components/terminal/TerminalShell'), {
  ssr: false,
  loading: () => (
    <div style={{
      height: '100vh', background: '#060B14', color: '#60A5FA',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 13, fontWeight: 800, letterSpacing: 1,
    }}>TRAIGO Pro 터미널 로딩 중…</div>
  ),
});

export const metadata = {
  title: 'TRAIGO Pro 터미널',
  description: 'PC 전용 트레이딩 터미널 — 차트 · 호가 · 주문 · 포지션',
};

export default function TerminalPage() {
  return <TerminalShell/>;
}
