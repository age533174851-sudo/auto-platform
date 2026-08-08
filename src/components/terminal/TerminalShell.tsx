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
import { layoutPlanOf, type LayoutPlan } from '@/lib/ui/layoutMode';
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

// 배치 판정은 `lib/ui/layoutMode`가 한다.
//
// 예전에는 여기서 `window.innerWidth`만 보고 900/1100/1400으로 갈랐다.
// 두 가지가 문제였다:
//
//   1. **뷰포트만 봤다.** 갤럭시탭 분할화면에서 innerWidth는 1280인데
//      우리 앱에 주어진 폭은 700px일 수 있다. 그때 3열을 그리면 깨진다
//   2. **이 파일 안에만 있었다.** 다른 화면은 각자 다른 기준을 쓰거나
//      아예 안 썼다 — 한 화면을 고치면 다른 화면에서 또 패드가 깨진다
//
// 이제 실제 컨테이너 폭을 재고, 판정은 다른 화면과 공유한다.

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

function DesktopShell({ plan, embedded }: { plan: LayoutPlan; embedded?: boolean }) {
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

  // **패드에서 전체 메뉴를 펼치지 않는다.** 220px는 여기서 너무 비싸고,
  // 그만큼 주문판이 눌린다.
  const showLeft = plan.sidebar === 'FULL' && layout.leftOpen;
  const leftPct = showLeft ? layout.left : 0;
  // **오른쪽 시세·뉴스는 거래 실행보다 우선순위가 낮다.** 시세를 못 보면
  // 불편하지만, 주문 버튼이 호가 위로 겹치면 잘못된 주문이 나간다.
  const rightPct = plan.rightRailVisible ? layout.right : 0;
  const centerPct = 100 - leftPct - rightPct;

  return (
    <div ref={rootRef} style={{
      // 앱 탭 안에 들어갈 때는 뷰포트가 아니라 부모를 채운다. 100dvh를
      // 그대로 두면 상단바·하단탭 높이만큼 화면 밖으로 밀려난다.
      height: embedded ? '100%' : '100dvh',
      width: embedded ? '100%' : '100vw', overflow: 'hidden',
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
            {plan.rightRailVisible && (
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

function ShellInner({ embedded }: { embedded?: boolean }) {
  // 서버·첫 렌더에서는 폭을 모른다. 모르는 채로 PC를 그리면 모바일에서
  // 한 번 깜빡이므로, 정해진 뒤에 그린다.
  // ── 실제로 우리에게 주어진 폭을 잰다 ──
  //
  // `window.innerWidth`가 아니라 이 컨테이너의 폭이다. 분할화면·사이드
  // 패널·확대 때문에 둘은 자주 다르고, 큰 쪽을 믿으면 안 들어가는
  // 배치를 그린다.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [plan, setPlan] = useState<LayoutPlan | null>(null);

  useEffect(() => {
    const measure = () => {
      const w = boxRef.current?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
      const vw = typeof window !== 'undefined' ? window.innerWidth : undefined;
      const portrait = typeof window !== 'undefined' && window.innerHeight > window.innerWidth;
      setPlan(layoutPlanOf(w, { viewportWidthPx: vw, portrait }));
    };
    measure();
    // ResizeObserver가 있으면 컨테이너 변화까지 잡는다 — 분할화면 손잡이를
    // 끌 때 resize 이벤트가 안 오는 경우가 있다.
    let ro: any = null;
    if (typeof ResizeObserver !== 'undefined' && boxRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(boxRef.current);
    }
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  // 폭을 재기 전에 그리면 한 번 깜빡인다.
  return (
    <div ref={boxRef} style={{ width: '100%', height: embedded ? '100%' : '100dvh', minWidth: 0 }}>
      {plan === null
        ? <div style={{ background: C.bg, height: '100%' }}/>
        : plan.mode === 'MOBILE'
          ? <MobileShell embedded={embedded}/>
          : <DesktopShell plan={plan} embedded={embedded}/>}
    </div>
  );
}

export default function TerminalShell(
  { embedded, navigateApp }: { embedded?: boolean; navigateApp?: (tabId: string) => void } = {},
) {
  return (
    <TerminalProvider navigateApp={navigateApp}>
      <ShellInner embedded={embedded}/>
    </TerminalProvider>
  );
}
