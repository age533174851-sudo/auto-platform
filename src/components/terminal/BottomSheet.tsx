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
//  - **뒤로가기는 시트를 닫는다.** 화면을 벗어나지 않는다.
//  - **키보드가 올라오면 시트가 그만큼 물러난다.** 버튼이 덮이지 않게.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { C, FS } from './theme';
import { historyAction, sheetMetrics, type ViewportSample } from '@/lib/ui/mobileSheet';

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

  // ── 뒤로가기는 시트를 닫는다 ──
  //
  // 이게 없어서, 주문 시트에서 수량까지 다 적어 놓고 습관적으로
  // 뒤로가기를 누르면 **거래 화면을 통째로 벗어났다.** 돌아오면 적어 둔
  // 것이 없다.
  //
  // 넣은 칸을 반드시 도로 빼야 한다. 안 빼면 시트를 다섯 번 열고 닫은
  // 뒤 뒤로가기를 다섯 번 눌러야 화면을 벗어난다 — 사용자에게는 앱이
  // 멈춘 것으로 보인다. 반대로 뒤로가기로 닫힌 것까지 빼면 한 번에 두
  // 칸이 물러난다. 그 셋을 historyAction이 가른다.
  //
  // **언마운트에서는 빼지 않는다.** 시트가 열린 채로 통째로 사라지는 것은
  // 대개 화면이 이동했다는 뜻이고, 그때 back()을 부르면 방금 들어온
  // 화면에서 다시 나가 버린다. 남은 칸 하나는 뒤로가기 한 번이 더 필요한
  // 정도지만, 저쪽은 사용자가 가려던 곳에서 튕겨 나오는 것이다.
  const pushed = useRef(false);
  const closedByPop = useRef(false);
  const prevOpen = useRef<boolean | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.history) return;
    const act = historyAction(
      prevOpen.current == null ? null : { open: prevOpen.current, pushed: pushed.current },
      { open, pushed: pushed.current, closedByPop: closedByPop.current },
    );
    prevOpen.current = open;
    closedByPop.current = false;

    if (act === 'PUSH') {
      pushed.current = true;
      window.history.pushState({ traigoSheet: true }, '');
    } else if (act === 'POP') {
      pushed.current = false;
      window.history.back();
    }
  }, [open]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const onPop = () => {
      // 브라우저가 이미 칸을 뺐다. 여기서 back()을 또 부르지 않도록
      // 표시해 두고 닫는다.
      pushed.current = false;
      closedByPop.current = true;
      onClose();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open, onClose]);

  // ── 키보드가 버튼을 덮지 않게 ──
  //
  // 시트 아래쪽 입력칸을 누르면 키보드가 올라오면서 그 입력칸과 [주문]
  // 버튼을 덮는다. 사용자는 자기가 무엇을 적고 있는지 못 본 채 숫자를
  // 친다.
  //
  // iOS Safari는 키보드가 올라와도 innerHeight를 안 바꾼다 — 바뀌는 것은
  // visualViewport.height다. 없는 브라우저에서는 지금까지와 똑같이
  // 동작한다(inset 0).
  const [viewport, setViewport] = useState<ViewportSample | null>(null);
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const vv: any = (window as any).visualViewport;
    if (!vv) return;
    const read = () => setViewport({
      windowHeight: window.innerHeight,
      viewportHeight: vv.height,
      offsetTop: vv.offsetTop,
    });
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
      setViewport(null);
    };
  }, [open]);

  const metrics = sheetMetrics(viewport, maxHeightPct);

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
          maxHeight: metrics.maxHeight,
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
          // 홈 인디케이터에 버튼이 가리지 않게. 키보드가 올라와 있으면
          // 그 높이만큼 — 홈 인디케이터는 이미 키보드가 덮고 있다.
          paddingBottom: metrics.paddingBottom,
        }}>
          {children}
        </div>
      </div>
    </>
  );
}
