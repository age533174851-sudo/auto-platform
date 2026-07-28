'use client';
// src/components/terminal/BottomSheet.tsx
//
// 모바일 바텀시트.
//
// 왜 시트인가
// ───────────
// 모바일에서 패널을 화면 전환으로 만들면 차트가 언마운트된다. 그러면
// PC에서 지켜낸 것(차트 iframe이 살아남는 것)을 모바일에서 다시 잃는다.
// 시트는 차트 **위에 겹치는** 것이라 아래는 그대로 살아 있다.
//
// 설계에서 신경 쓴 것
// ───────────────────
//  - 손잡이를 아래로 끌면 닫힌다. 하지만 **주문 시트는 그렇지 않다** —
//    수량을 입력하다 손이 미끄러져 닫히면 처음부터 다시 해야 한다.
//    닫기는 명시적인 X 버튼이나 배경 탭으로만 한다(lockDrag).
//  - 열려 있는 동안 뒤 배경은 스크롤되지 않는다.
//  - 높이는 내용에 맞추되 화면의 88%를 넘지 않는다.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { C, FS } from './theme';

export function BottomSheet({
  open, title, onClose, children, lockDrag, maxHeightPct = 88,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** 주문처럼 실수로 닫히면 안 되는 시트 */
  lockDrag?: boolean;
  maxHeightPct?: number;
}) {
  const [dragY, setDragY] = useState(0);
  const startY = useRef(0);
  const dragging = useRef(false);

  // 열려 있는 동안 뒤가 스크롤되면 시트가 떠 있는 느낌이 사라진다
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // ESC로도 닫는다 (가로모드에서 키보드를 쓸 수 있다)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => { if (open) setDragY(0); }, [open]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (lockDrag) return;
    dragging.current = true;
    startY.current = e.touches[0].clientY;
  }, [lockDrag]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragging.current) return;
    const dy = e.touches[0].clientY - startY.current;
    setDragY(Math.max(0, dy));   // 위로는 끌리지 않는다
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    // 100px 넘게 내렸으면 닫는다. 그보다 적으면 제자리로.
    if (dragY > 100) onClose();
    setDragY(0);
  }, [dragY, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 80,
          background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(2px)',
        }}
      />
      <div
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 81,
          maxHeight: `${maxHeightPct}vh`,
          background: C.panel,
          borderTop: `1px solid ${C.hair2}`,
          borderRadius: '16px 16px 0 0',
          boxShadow: '0 -16px 48px rgba(0,0,0,.6)',
          display: 'flex', flexDirection: 'column',
          transform: `translateY(${dragY}px)`,
          transition: dragging.current ? 'none' : 'transform .18s cubic-bezier(.2,.8,.2,1)',
        }}
      >
        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          style={{
            flexShrink: 0, padding: '10px 14px 8px',
            cursor: lockDrag ? 'default' : 'grab',
            touchAction: lockDrag ? 'auto' : 'none',
          }}
        >
          {/* 손잡이 — 끌 수 있는 시트에만 보인다. 못 끄는데 손잡이가 있으면 거짓말이다. */}
          {!lockDrag && (
            <div style={{
              width: 36, height: 4, borderRadius: 2,
              background: C.hair3, margin: '0 auto 10px',
            }}/>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: C.text, fontSize: FS.lead, fontWeight: 700 }}>{title}</span>
            <button onClick={onClose} aria-label="닫기" style={{
              width: 32, height: 32, borderRadius: 8, cursor: 'pointer',
              background: C.raised, border: `1px solid ${C.hair}`,
              color: C.dim, fontSize: 15, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>×</button>
          </div>
        </div>

        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          // 홈 인디케이터에 버튼이 가리지 않게
          paddingBottom: 'max(env(safe-area-inset-bottom), 8px)',
        }}>
          {children}
        </div>
      </div>
    </>
  );
}
