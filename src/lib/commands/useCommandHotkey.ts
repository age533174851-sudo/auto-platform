'use client';
// src/lib/commands/useCommandHotkey.ts
//
// Ctrl/Cmd + K 리스너.
//
// 왜 팔레트 컴포넌트와 같은 파일에 두지 않는가
// ────────────────────────────────────────────
// 팔레트는 dynamic import로 늦게 불러온다 — Ctrl+K를 한 번도 누르지 않는
// 사용자가 그 무게를 같이 받을 이유가 없다. 그런데 리스너는 처음부터 붙어
// 있어야 한다(안 붙으면 첫 Ctrl+K가 먹지 않는다). 그래서 키만 듣는 이 작은
// 훅을 따로 둬서 정적으로 가져간다.
//
// 여는 상태를 앱이 갖는 이유: 팔레트를 여는 창구가 단축키만이 아니다.
// 돋보기 버튼, 모바일 길게 누르기도 같은 상태를 켠다.
import { useEffect } from 'react';

export function useCommandHotkey(onOpen: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'k' && e.key !== 'K') return;
      // 일부 브라우저는 Cmd+K를 주소창 검색에 쓴다. 막지 않으면 팔레트와
      // 브라우저 UI가 같이 뜬다.
      e.preventDefault();
      onOpen();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onOpen]);
}
