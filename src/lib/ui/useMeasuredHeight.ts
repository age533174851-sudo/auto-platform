// src/lib/ui/useMeasuredHeight.ts
//
// **높이를 상수로 박지 않고 잰다.**
//
// 세로 배치에서 헤더는 화면에 고정(sticky)되고, 그 아래 탭 줄도 고정된다.
// 탭 줄이 붙을 위치가 헤더 높이인데, 그 높이는 고정이 아니다 — 종목 이름이
// 길거나 시장 전환 줄이 접히면 한 줄이 늘어난다. 상수로 박아 두면 그때
// 탭 줄이 헤더 밑에 겹쳐 글자가 뭉개진다.
//
// 첫 화면의 높이 계산에도 같은 값을 쓴다. 그래서 재는 편이 싸다.
//
// ★ 왜 공용 파일로 옮겼나
// ───────────────────────
// 이 훅은 `MobileShell`(터미널)의 파일 안에 있었다. 새 거래 화면도 같은
// 계산이 필요한데, 거기서 한 벌 더 쓰면 **같은 판단이 두 곳에** 있게 된다 —
// 이 저장소가 이름 붙인 2번 고장이다. 한쪽만 고쳐지는 날이 오고, 그날 두
// 화면의 첫 화면 높이가 갈린다. 그래서 옮겨서 **같은 파일을 부른다.**
'use client';

import { useEffect, useRef, useState } from 'react';

export function useMeasuredHeight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [h, setH] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setH(el.getBoundingClientRect().height);
    read();

    // ResizeObserver가 없는 환경(구형 웹뷰)에서도 최소한 회전에는 반응해야 한다.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(read);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', read);
    window.addEventListener('orientationchange', read);
    return () => {
      window.removeEventListener('resize', read);
      window.removeEventListener('orientationchange', read);
    };
  }, []);

  return [ref, h] as const;
}
