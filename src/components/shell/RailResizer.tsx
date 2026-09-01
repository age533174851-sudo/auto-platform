'use client';
// src/components/shell/RailResizer.tsx
//
// 오른쪽 레일의 폭 손잡이.
//
// 왜 컴포넌트로 빼나
// ──────────────────
// 드래그는 짧은 코드지만 **틀리기 쉬운 곳이 정해져 있다**:
// 포인터 캡처를 안 하면 손이 창 밖으로 나갈 때 놓친 채로 남고,
// 전역 커서를 안 바꾸면 본문 위에서 커서 모양이 돌아오고,
// 키보드를 안 붙이면 마우스 없는 사람에게는 없는 기능이 된다.
// 이걸 page.tsx 안에 인라인으로 두면 다음에 왼쪽 패널에도 손잡이를
// 붙일 때 같은 실수를 다시 한다.
//
// 폭 계산은 여기서 하지 않는다 — `lib/ui/panelPrefs`가 한다.
// 이 파일은 **입력을 값으로 바꾸는 자리**까지만 책임진다.

import React, { useCallback, useRef } from 'react';
import {
  railWidthFromPointer, railWidthFromKey,
  RAIL_MIN, railMaxFor,
} from '@/lib/ui/panelPrefs';

export default function RailResizer({
  width, sidebarW, onResize, onCommit,
}: {
  width: number;
  sidebarW: number;
  /** 드래그 중 계속 불린다 — 화면은 즉시 따라와야 한다 */
  onResize: (w: number) => void;
  /** 손을 뗐을 때 한 번 — 저장은 여기서만 한다 */
  onCommit: (w: number) => void;
}) {
  const latest = useRef(width);
  latest.current = width;

  const end = useCallback(() => {
    document.body.classList.remove('rp-resizing');
    onCommit(latest.current);
  }, [onCommit]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    // 왼쪽 버튼만. 가운데 버튼 드래그는 브라우저의 자동 스크롤이다.
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    // 캡처하지 않으면 빠르게 끌었을 때 포인터가 손잡이를 벗어나
    // move 이벤트가 끊긴다 — 칸이 손가락을 따라오다 멈춘다.
    try { el.setPointerCapture(e.pointerId); } catch { /* 캡처 못 해도 드래그는 이어진다 */ }
    document.body.classList.add('rp-resizing');
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
    const w = railWidthFromPointer(e.clientX, window.innerWidth, sidebarW);
    latest.current = w;
    onResize(w);
  }, [onResize, sidebarW]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    const next = railWidthFromKey(e.key, width, window.innerWidth, sidebarW);
    // 다루지 않는 키는 그대로 흘려보낸다. 여기서 preventDefault를 하면
    // Tab으로 손잡이를 빠져나갈 수 없게 된다.
    if (next == null) return;
    e.preventDefault();
    onResize(next);
    onCommit(next);
  }, [width, sidebarW, onResize, onCommit]);

  const max = typeof window === 'undefined'
    ? RAIL_MIN
    : railMaxFor(window.innerWidth, sidebarW);

  return (
    <button
      type="button"
      className="rp-resizer"
      // separator는 "두 칸 사이의 조절 가능한 경계"라는 뜻이다.
      // 화면 낭독기가 지금 폭을 읽어 준다.
      role="separator"
      aria-orientation="vertical"
      aria-label="오른쪽 패널 폭 조절"
      aria-valuenow={width}
      aria-valuemin={RAIL_MIN}
      aria-valuemax={max}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => { onResize(300); onCommit(300); }}
      title="끌어서 폭 조절 · 방향키로도 됩니다 · 두 번 누르면 기본값"
    />
  );
}
