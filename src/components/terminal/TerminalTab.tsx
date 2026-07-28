'use client';
// src/components/terminal/TerminalTab.tsx
//
// 앱의 매매 탭 = 터미널.
//
// 터미널을 별도 경로로 두면 "따로 들어가는 화면"이 된다. 매매는 앱에서
// 가장 자주 여는 탭인데, 거기서 한 번 더 이동해야 진짜 주문 화면이 나오는
// 구조는 매매를 두 곳에 두는 것과 같다. 그래서 탭 자체를 터미널로 바꾼다.
//
// 높이를 왜 재는가
// ─────────────────
// 터미널은 원래 100dvh를 채운다. 앱 안에서는 위에 상단바·시세띠·배너가,
// 아래에 하단탭이 있고 그 높이가 상황마다 다르다(배너는 있다 없다 한다).
// 상수로 빼면 어떤 조합에서는 화면이 잘리고 어떤 조합에서는 스크롤이 생긴다.
// 그래서 자기 위치를 재서 남는 만큼만 차지한다.
import React, { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

const TerminalShell = dynamic(() => import('./TerminalShell'), {
  ssr: false,
  loading: () => (
    <div style={{
      height: '100%', background: '#0A0B0D', color: '#5B8DEF',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, fontWeight: 700, letterSpacing: 0.5,
    }}>터미널 여는 중…</div>
  ),
});

export default function TerminalTab() {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | null>(null);

  useEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      // 하단탭은 --nav-h 변수가 아니라 실제 요소에서 읽는다.
      //  · 변수 값이 calc(52px + var(--sab))라 parseFloat가 통하지 않는다
      //  · PC에서는 하단탭이 사라지고 좌측 사이드바가 된다. 그때 52px을
      //    빼면 화면 아래가 그만큼 비는데, 요소를 재면 0이 나와 저절로 맞는다
      const bar = document.querySelector('.bottom-nav');
      const barRect = bar?.getBoundingClientRect();
      // 하단에 붙어 있을 때만 그 높이를 뺀다
      const nav = barRect && barRect.bottom > window.innerHeight - 4
        ? barRect.height : 0;
      const avail = window.innerHeight - top - nav;
      // 너무 작으면 측정이 틀린 것이다. 0을 그대로 쓰면 빈 화면이 된다.
      setH(avail > 240 ? avail : Math.max(320, window.innerHeight - nav));
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    // 배너가 늦게 뜨거나 사라지면 위치가 바뀐다
    const ro = new ResizeObserver(measure);
    if (document.body) ro.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={ref} style={{
      height: h == null ? '70vh' : h,
      width: '100%', overflow: 'hidden', background: '#0A0B0D',
    }}>
      {h != null && <TerminalShell embedded/>}
    </div>
  );
}
