'use client';
// src/lib/ui/useInert.ts
//
// **덮개가 떠 있는 동안 뒤를 키보드에서도 없애는 한 곳.**
//
// 왜 필요한가
// ───────────
// `position: absolute`로 화면을 덮으면 **포인터만** 막힌다. 뒤의 버튼·
// 입력은 그대로 Tab으로 갈 수 있다. Phase 2C 감사에서 그것이 blocker로
// 잡혔다 — 확인 창을 열어 둔 채 키보드로 뒤의 진입/청산 버튼에 닿을 수
// 있었고, 거기서 청산으로 바꾼 채 확인을 누를 수 있었다.
//
// `pointer-events: none`으로도 못 막는다. 그건 이름 그대로 포인터 이야기다.
// `inert`는 그 하위 전체를 포커스·클릭·접근성 트리에서 빼낸다.
//
// 왜 ref 효과인가
// ───────────────
// React 18에는 `inert` prop이 없다(19에서 생긴다). 문자열로 넘기면 조용히
// 무시되거나 경고만 난다. 그래서 DOM 속성을 직접 세운다.
//
// **구현이 두 벌이 되지 않게** 여기 한 곳에 둔다 — 화면마다 따로 쓰면
// 언젠가 한쪽만 고쳐지고, 그쪽 화면만 키보드가 새는데 눈으로는 똑같아
// 보인다.
import { useEffect, type RefObject } from 'react';

export function useInert(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => {
    const el = ref.current as any;
    if (!el) return;
    el.inert = !!on;
    return () => { if (el) el.inert = false; };
  }, [ref, on]);
}
