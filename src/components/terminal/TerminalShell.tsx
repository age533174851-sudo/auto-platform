'use client';
// src/components/terminal/TerminalShell.tsx
//
// 배치를 고르는 곳. PC와 모바일은 **다른 파일**이다.
//
//   PC (>=900)
//   ┌──────────────────────────────────────────────┐
//   │ 상단 52px — 종목·가격·계좌·연결                 │
//   ├────────┬───────────────────────┬─────────────┤
//   │ 좌 18% │      중앙 55%          │   우 27%    │
//   ├────────┴───────────────────────┴─────────────┤
//   │ 하단 28% — 포지션·미체결·대조·전략·Kill Switch  │
//   └──────────────────────────────────────────────┘
//
//   모바일 (<900) → MobileShell. 줄인 것이 아니라 다시 놓은 것이다.
//   같은 배치를 줄이면 주문 버튼과 Kill Switch까지 작아진다.
//
// 폭이 줄어드는 중간 단계에서는 좌측을 접는다.
//   >=1400  3열
//   1100~   좌측 접기 (버튼으로 다시 연다)
//   900~    좌측 숨김 + 우측 좁게
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { C, FS } from './theme';
import { TerminalProvider, useTerminal } from './TerminalContext';
import { TopBar } from './TopBar';
import { LeftRail } from './LeftRail';
import { ChartPane } from './ChartPane';
import { OrderPane } from './OrderPane';
import { BottomDock } from './BottomDock';
import MobileShell from './MobileShell';

const LAYOUT_KEY = 'tg_terminal_layout_v1';

interface Layout { left: number; right: number; dock: number; leftOpen: boolean }
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
  const [hover, setHover] = useState(false);
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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        [vertical ? 'height' : 'width']: 5,
        [vertical ? 'width' : 'height']: '100%',
        // 평소에는 배경과 구분되지 않는다. 올려야 보인다 —
        // 항상 보이면 화면이 격자로 조각나 보인다.
        background: active ? C.accent : hover ? C.hair3 : 'transparent',
        cursor: vertical ? 'row-resize' : 'col-resize',
        flexShrink: 0, transition: 'background .12s',
      } as React.CSSProperties}
    />
  );
}

function Pane({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: C.panel, minWidth: 0, minHeight: 0, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', ...style,
    }}>{children}</div>
  );
}

function DesktopShell({ tier }: { tier: Exclude<Tier, 'mobile'> }) {
  const { mode, symbol } = useTerminal();
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [balance, setBalance] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) setLayout(clampLayout(JSON.parse(raw)));
    } catch { /* 깨진 저장값은 기본값으로 */ }
  }, []);

  const persist = (c: Layout) => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(c)); } catch {}
  };

  const save = useCallback((next: Layout) => {
    const c = clampLayout(next);
    setLayout(c); persist(c);
  }, []);

  const dragH = useCallback((which: 'left' | 'right') => (dpx: number) => {
    const w = rootRef.current?.clientWidth || window.innerWidth;
    const dpct = (dpx / w) * 100;
    setLayout(prev => {
      // 우측은 오른쪽 끝에 붙어 있으므로 드래그 방향이 반대다
      const c = clampLayout(which === 'left'
        ? { ...prev, left: prev.left + dpct }
        : { ...prev, right: prev.right - dpct });
      persist(c);
      return c;
    });
  }, []);

  const dragV = useCallback((dpx: number) => {
    const h = rootRef.current?.clientHeight || window.innerHeight;
    const dpct = (dpx / h) * 100;
    setLayout(prev => {
      const c = clampLayout({ ...prev, dock: prev.dock - dpct });
      persist(c);
      return c;
    });
  }, []);

  const showLeft = tier !== 'narrow' && layout.leftOpen;
  const leftPct = showLeft ? layout.left : 0;
  const rightPct = tier === 'narrow' ? Math.min(layout.right, 32) : layout.right;
  const centerPct = 100 - leftPct - rightPct;

  return (
    <div ref={rootRef} style={{
      height: '100dvh', width: '100vw', overflow: 'hidden',
      background: C.bg, color: C.text,
      display: 'flex', flexDirection: 'column',
      // 실자금이면 화면 테두리가 붉다. 어느 패널을 보고 있어도 주변시에 들어온다.
      boxShadow: mode.realMoney ? `inset 0 0 0 2px ${C.down}` : 'none',
    }}>
      <TopBar balance={balance}/>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: `${100 - layout.dock}%`, display: 'flex', minHeight: 0 }}>
          {showLeft && (
            <>
              <Pane style={{ width: `${leftPct}%` }}><LeftRail/></Pane>
              <Splitter onDrag={dragH('left')}/>
            </>
          )}

          <Pane style={{
            width: `${centerPct}%`, flex: showLeft ? undefined : 1, position: 'relative',
          }}>
            {/* 접어놓고 못 찾으면 접힌 게 아니라 사라진 것이다 */}
            {tier !== 'narrow' && (
              <button
                onClick={() => save({ ...layout, leftOpen: !showLeft })}
                title={showLeft ? '시장 패널 접기' : '시장 패널 열기'}
                style={{
                  position: 'absolute', top: 7, left: 8, zIndex: 5,
                  height: 26, padding: '0 9px', borderRadius: 7, cursor: 'pointer',
                  background: C.raised, border: `1px solid ${C.hair}`,
                  color: showLeft ? C.faint : C.accent,
                  fontSize: FS.micro, fontWeight: 600,
                }}
              >{showLeft ? '◀' : '▶ 시장'}</button>
            )}
            <ChartPane symbol={symbol.id}/>
          </Pane>

          <Splitter onDrag={dragH('right')}/>
          <Pane style={{ width: `${rightPct}%` }}><OrderPane/></Pane>
        </div>

        <Splitter vertical onDrag={dragV}/>

        <Pane style={{ height: `${layout.dock}%` }}>
          <BottomDock onBalance={setBalance}/>
        </Pane>
      </div>
    </div>
  );
}

function ShellInner() {
  // 서버·첫 렌더에서는 폭을 모른다. 모르는 채로 PC를 그리면 모바일에서
  // 한 번 깜빡이므로, 정해진 뒤에 그린다.
  const [tier, setTier] = useState<Tier | null>(null);

  useEffect(() => {
    const onResize = () => setTier(tierOf(window.innerWidth));
    onResize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  if (tier === null) return <div style={{ background: C.bg, height: '100dvh' }}/>;
  if (tier === 'mobile') return <MobileShell/>;
  return <DesktopShell tier={tier}/>;
}

export default function TerminalShell() {
  return (
    <TerminalProvider>
      <ShellInner/>
    </TerminalProvider>
  );
}
