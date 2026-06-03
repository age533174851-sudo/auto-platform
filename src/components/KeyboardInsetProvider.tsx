'use client';
import { useEffect } from 'react';

// visualViewport로 모바일 키보드 높이 감지 → CSS 변수 --kb 설정
// + 입력창 포커스 시 자동 스크롤 (키보드에 안 가리게)
export default function KeyboardInsetProvider() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const vv = window.visualViewport;

    // 1. 키보드 높이 → --kb 변수
    const update = () => {
      if (!vv) return;
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--kb', `${Math.round(kb)}px`);
      if (kb > 80) root.classList.add('kb-open');
      else root.classList.remove('kb-open');
    };
    if (vv) {
      update();
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }

    // 2. 입력창 포커스 시 자동 스크롤 (키보드 위로)
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (!el) return;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) {
        // 키보드 애니메이션 후 스크롤
        setTimeout(() => {
          try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
        }, 300);
      }
    };
    document.addEventListener('focusin', onFocus);

    return () => {
      if (vv) { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); }
      document.removeEventListener('focusin', onFocus);
    };
  }, []);

  return null;
}
