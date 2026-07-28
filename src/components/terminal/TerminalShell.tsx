'use client';
// src/components/terminal/TerminalShell.tsx
//
// PC 터미널 레이아웃.
//
//   1920×1080 기준
//   ┌──────────────────────────────────────────────┐
//   │ 상단 46px — 종목·가격·계좌·연결                 │
//   ├────────┬───────────────────────┬─────────────┤
//   │ 좌 18% │      중앙 55%          │   우 27%    │
//   │ 시장   │      차트              │  호가·주문   │
//   ├────────┴───────────────────────┴─────────────┤
//   │ 하단 28% — 포지션·미체결·대조·전략·Kill Switch  │
//   └──────────────────────────────────────────────┘
//
// 폭이 줄면 축소하지 않고 **재배치**한다.
//   ≥1400  3열
//   1100~  좌측을 접는다 (버튼으로 다시 연다)
//   900~   좌측 숨김 + 우측 좁게
//   <900   모바일 화면으로 보낸다 — 이 레이아웃을 줄여 쓰지 않는다
//
// 크기·비율은 사용자별로 저장한다. 매번 다시 맞추게 하면 안 쓰게 된다.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { T } from '@/lib/constants';
import { TerminalProvider, useTerminal } from './TerminalContext';
import { TopBar, TOPBAR_H } from './TopBar';
import { LeftRail } from './LeftRail';
import { ChartPane } from './ChartPane';
import { OrderPane } from './OrderPane';
import { BottomDock } from './BottomDock';

const LAYOUT_KEY = 'tg_terminal_layout_v1';

interface Layout {
  left: number;    // %
  right: number;   // %
  dock: number;    // %
  leftOpen: boolean;
}

const DEFAULT_LAYOUT: Layout = { left: 18, right: 27, dock: 28, leftOpen: true };

/** 어떤 값이 저장돼 있어도 화면이 깨지지 않는 범위로 가둔다 */
function clampLayout(l: Partial<Layout>): Layout {
  const cl = (v: any, lo: number, hi: number, d: number) =>
    Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d;
  return {
    left: cl(l.left, 12, 30, DEFAULT_LAYOUT.left),
    right: cl(l.right, 18, 40, DEFAULT_LAYOUT.right),
    dock: cl(l.dock, 12, 55, DEFAULT_LAYOUT.dock),
    leftOpen: l.leftOpen !== false,
  };
}

type Tier = 'wide' | 'mid' | 'narrow' | 'mobile';

function tierOf(w: number): Tier {
  if (w >= 1400) return 'wide';
  if (w >= 1100) return 'mid';
  if (w >= 900) return 'narrow';
  return 'mobile';
}

function Splitter({ vertical, onDrag }: { vertical?: boolean; onDrag: (deltaPx: number) => void }) {
  const [active, setActive] = useState(false);
  const last = useRef(0);

  useEffect(() => {
    if (!active) return;
    const move = (e: MouseEvent) => {
      const cur = vertical ? e.clientY : e.clientX;
      onDrag(cur - last.current);
      last.current = cur;
    };
    const up = () => setActive(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    // 드래그 중 텍스트가 선택되면 커서가 튄다
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.userSelect = prev;
    };
  }, [active, onDrag, vertical]);

  return (
    <div
      onMouseDown={e => { last.current = vertical ? e.clientY : e.clientX; setActive(true); }}
      style={{
        [vertical ? 'height' : 'width']: 4,
        [vertical ? 'width' : 'height']: '100%',
        background: active ? T.acc : T.border,
        cursor: vertical ? 'row-resize' : 'col-resize',
        flexShrink: 0,
      } as React.CSSProperties}
    />
  );
}

function Pane({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: T.card, minWidth: 0, minHeight: 0, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', ...style,
    }}>{children}</div>
  );
}

function ShellInner() {
  const { mode, symbol } = useTerminal();
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [tier, setTier] = useState<Tier>('wide');
  const [balance, setBalance] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) setLayout(clampLayout(JSON.parse(raw)));
    } catch { /* 깨진 저장값은 기본값으로 */ }
    setReady(true);
  }, []);

  const save = useCallback((next: Layout) => {
    const c = clampLayout(next);
    setLayout(c);
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(c)); } catch {}
  }, []);

  useEffect(() => {
    const onResize = () => setTier(tierOf(window.innerWidth));
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const dragH = useCallback((which: 'left' | 'right') => (dpx: number) => {
    const w = rootRef.current?.clientWidth || window.innerWidth;
    const dpct = (dpx / w) * 100;
    setLayout(prev => {
      // 우측은 오른쪽 끝에 붙어 있으므로 드래그 방향이 반대다
      const next = which === 'left'
        ? { ...prev, left: prev.left + dpct }
        : { ...prev, right: prev.right - dpct };
      const c = clampLayout(next);
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(c)); } catch {}
      return c;
    });
  }, []);

  const dragV = useCallback((dpx: number) => {
    const h = rootRef.current?.clientHeight || window.innerHeight;
    const dpct = (dpx / h) * 100;
    setLayout(prev => {
      const c = clampLayout({ ...prev, dock: prev.dock - dpct });
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(c)); } catch {}
      return c;
    });
  }, []);

  if (!ready) return <div style={{ background: T.bg, height: '100vh' }}/>;

  // 좁은 화면은 이 레이아웃을 줄여 쓰지 않는다. 모바일은 다른 동선이다.
  if (tier === 'mobile') {
    return (
      <div style={{
        height: '100vh', background: T.bg, color: T.txt,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center',
      }}>
        <div style={{ fontSize: 15, fontWeight: 900, color: T.acl }}>TRAIGO Pro 터미널</div>
        <div style={{ fontSize: 12, color: T.sub, lineHeight: 1.7, maxWidth: 320 }}>
          이 화면은 가로 900px 이상에서 동작합니다.
          <br/>좁은 화면에서는 축소하지 않고 <b style={{ color: T.txt }}>모바일 전용 화면</b>으로 갑니다 —
          같은 배치를 줄여 쓰면 주문 버튼까지 작아지기 때문입니다.
        </div>
        <a href="/" style={{
          background: T.acc, color: '#fff', borderRadius: 8,
          padding: '11px 22px', fontSize: 13, fontWeight: 800, textDecoration: 'none',
        }}>모바일 화면으로</a>
      </div>
    );
  }

  const showLeft = tier === 'wide' ? layout.leftOpen : tier === 'mid' ? layout.leftOpen : false;
  const leftPct = showLeft ? layout.left : 0;
  const rightPct = tier === 'narrow' ? Math.min(layout.right, 32) : layout.right;
  const centerPct = 100 - leftPct - rightPct;

  return (
    <div ref={rootRef} style={{
      height: '100vh', width: '100vw', overflow: 'hidden',
      background: T.bg, color: T.txt,
      display: 'flex', flexDirection: 'column',
      // 실자금이면 화면 테두리가 붉다. 어느 패널을 보고 있어도 주변시에 들어온다.
      boxShadow: mode.realMoney ? `inset 0 0 0 2px ${T.red}` : 'none',
    }}>
      <TopBar balance={balance}/>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* ── 상단 3열 ── */}
        <div style={{ height: `${100 - layout.dock}%`, display: 'flex', minHeight: 0 }}>
          {showLeft && (
            <>
              <Pane style={{ width: `${leftPct}%`, borderRight: `1px solid ${T.border}` }}>
                <LeftRail/>
              </Pane>
              <Splitter onDrag={dragH('left')}/>
            </>
          )}

          <Pane style={{ width: `${centerPct}%`, flex: showLeft ? undefined : 1, position: 'relative' }}>
            {/* 접어둔 좌측을 다시 여는 손잡이. 접어놓고 못 찾으면
                접힌 것이 아니라 사라진 것이 된다. */}
            {tier !== 'narrow' && (
              <button
                onClick={() => save({ ...layout, leftOpen: !showLeft })}
                title={showLeft ? '시장 패널 접기' : '시장 패널 열기'}
                style={{
                  position: 'absolute', top: 5, left: 5, zIndex: 5,
                  background: T.alt, color: showLeft ? T.muted : T.acl,
                  border: `1px solid ${showLeft ? T.border : T.border2}`,
                  borderRadius: 5, padding: '2px 8px', fontSize: 9,
                  fontWeight: 700, cursor: 'pointer', lineHeight: 1.6,
                }}
              >{showLeft ? '◀' : '▶ 시장'}</button>
            )}
            <ChartPane symbol={symbol.id}/>
          </Pane>

          <Splitter onDrag={dragH('right')}/>
          <Pane style={{ width: `${rightPct}%`, borderLeft: `1px solid ${T.border}` }}>
            <OrderPane/>
          </Pane>
        </div>

        <Splitter vertical onDrag={dragV}/>

        {/* ── 하단 ── */}
        <Pane style={{ height: `${layout.dock}%`, borderTop: `1px solid ${T.border}` }}>
          <BottomDock onBalance={setBalance}/>
        </Pane>
      </div>
    </div>
  );
}

export default function TerminalShell() {
  return (
    <TerminalProvider>
      <ShellInner/>
    </TerminalProvider>
  );
}
