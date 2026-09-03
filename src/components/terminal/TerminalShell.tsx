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
//   태블릿·모바일 → MobileShell. 줄인 것이 아니라 다시 놓은 것이다.
//   같은 배치를 줄이면 주문 버튼과 Kill Switch까지 작아진다.
//
// 폭을 어디서 재는가 — 여기가 고장이었다
// ──────────────────────────────────────
// 예전에는 `tierOf(window.innerWidth)`로 정했다. 그런데 이 화면은 앱 탭
// 안(`.mc`)에 들어가 있고, 그 폭은 뷰포트에서 사이드바(240)와 뉴스
// 레일(300)을 뺀 값이다. 1664 창에서 터미널은 "1664니까 3열"이라고
// 결정했지만 실제로 쓸 수 있는 폭은 1124였다.
//
// 게다가 열 폭이 퍼센트라서, 좁아지면 주문판이 같이 줄었다.
// 실측: 1664에서 301px · 1440에서 240px · 1366에서 226px.
// 주문판이 좁아지자 그 안에서 라벨과 값이 겹쳤다(1366에서 14곳).
//
// 지금은 **담긴 칸의 폭을 재서**(ResizeObserver) `planTradingLayout()`에
// 넘기고, 중앙·주문의 픽셀 하한을 먼저 확보한다. 판단은
// `lib/ui/tradingLayout`에 있고 테스트가 붙어 있다.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { C, FS } from './theme';
import { TerminalProvider, useTerminal } from './TerminalContext';
import { TopBar } from './TopBar';
import { LeftRail } from './LeftRail';
import { ChartPane } from './ChartPane';
import { OrderPane } from './OrderPane';
import { BottomDock } from './BottomDock';
import MobileShell from './MobileShell';
import {
  planTradingLayout, ORDER_MIN, MARKET_MIN, SPLITTER, type TradingLayout,
} from '@/lib/ui/tradingLayout';
import { CENTER_MIN } from '@/lib/ui/panelPrefs';

/* 새 키다. 예전 값은 가로가 **퍼센트**였다 — 그대로 px로 읽으면
   주문판이 27px가 된다. 형식이 바뀌었으므로 키도 바꾼다. */
const LAYOUT_KEY = 'tg_terminal_layout_v2';

interface Layout {
  /** 주문판 폭(px). 사용자가 손잡이로 조절한 값 */
  orderPx: number;
  /** 종목 레일 폭(px). 펼친 상태에서 손잡이로 조절한 값 */
  marketPx: number;
  /** 하단 독 높이(%) — 세로는 예전 그대로다 */
  dock: number;
  leftOpen: boolean;
}
const DEFAULT_LAYOUT: Layout = { orderPx: ORDER_MIN, marketPx: MARKET_MIN, dock: 28, leftOpen: true };

/** 어떤 값이 저장돼 있어도 화면이 깨지지 않는 범위로 가둔다 */
function clampLayout(l: Partial<Layout>): Layout {
  const cl = (v: any, lo: number, hi: number, d: number) =>
    Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d;
  return {
    // 상한은 폭을 알아야 정해지므로 여기서는 넉넉히 두고, 그릴 때 다시 조인다.
    orderPx: cl(l.orderPx, ORDER_MIN, 900, DEFAULT_LAYOUT.orderPx),
    marketPx: cl(l.marketPx, MARKET_MIN, 520, DEFAULT_LAYOUT.marketPx),
    dock: cl(l.dock, 12, 55, DEFAULT_LAYOUT.dock),
    leftOpen: l.leftOpen !== false,
  };
}

/* `onDrag`가 없으면 **손잡이를 아예 그리지 않는다.**
   끌 수 없는 손잡이를 남겨 두면 사용자가 끌어 보고 자기 손이 잘못한
   줄 안다. 조절할 수 없는 상태면 경계선만 남긴다. */
function Splitter({ vertical, onDrag, ...rest }: {
  vertical?: boolean; onDrag?: (deltaPx: number) => void;
  label?: string; min?: number; max?: number; now?: number;
}) {
  if (!onDrag) {
    return <div style={{
      [vertical ? 'height' : 'width']: 1,
      [vertical ? 'width' : 'height']: '100%',
      background: C.hair, flexShrink: 0,
    } as React.CSSProperties}/>;
  }
  return <SplitterHandle vertical={vertical} onDrag={onDrag} {...rest}/>;
}

function SplitterHandle({ vertical, onDrag, label, min, max, now }: {
  vertical?: boolean;
  onDrag: (deltaPx: number) => void;
  /** 손잡이가 무엇을 조절하는지. 없으면 스크린리더에는 빈 칸이다 */
  label?: string;
  min?: number; max?: number; now?: number;
}) {
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

  /* ── 키보드로도 조절한다 ──
     UI-1에서 오른쪽 레일 손잡이에 같은 것을 붙이며 정한 규칙이다:
     손잡이를 마우스로만 잡을 수 있으면 그 기능은 마우스를 쓰는 사람만의
     것이 된다. 방향키 한 칸씩, Home/End로 끝까지. */
  const STEP = 16;
  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    let d = 0;
    if (k === 'ArrowLeft' || k === 'ArrowUp') d = -STEP;
    else if (k === 'ArrowRight' || k === 'ArrowDown') d = STEP;
    else if (k === 'Home') d = -10000;
    else if (k === 'End') d = 10000;
    else return;
    e.preventDefault();
    onDrag(d);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={now}
      onKeyDown={onKeyDown}
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

function Pane({ children, style, ...rest }: {
  children: React.ReactNode; style?: React.CSSProperties; [key: string]: any;
}) {
  return (
    <div {...rest} style={{
      background: C.panel, minWidth: 0, minHeight: 0, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', ...style,
    }}>{children}</div>
  );
}

function DesktopShell({ plan, availW, embedded }: { plan: TradingLayout; availW: number; embedded?: boolean }) {
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

  /* 손잡이는 주문판 폭을 px로 움직인다. 퍼센트로 두면 창 크기가
     바뀔 때마다 사용자가 맞춰 둔 폭이 따라 변하고, 좁아지면 하한
     아래로 내려간다 — 그게 이번 고장이었다. */
  /* 왼쪽 손잡이는 종목 레일 폭을 움직인다.
     **한동안 이 손잡이가 아무 일도 안 했다.** 폭을 계획에서만 받도록
     바꾸면서 `onDrag={() => {}}`로 비워 뒀기 때문이다. 손잡이가 보이는데
     끌어도 안 움직이는 것은 접기가 안 되는 것보다 나쁘다 —
     사용자는 자기 손이 잘못한 줄 안다. */
  const dragMarket = useCallback((dpx: number) => {
    setLayout(prev => {
      const c = clampLayout({ ...prev, marketPx: prev.marketPx + dpx });
      persist(c);
      return c;
    });
  }, []);

  const dragOrder = useCallback((dpx: number) => {
    setLayout(prev => {
      // 주문판은 오른쪽 끝에 붙어 있으므로 드래그 방향이 반대다
      const c = clampLayout({ ...prev, orderPx: prev.orderPx - dpx });
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

  /* ── 폭은 계획에서 오고, 사용자가 조절한 값은 하한 안에서만 반영된다 ──
     계획은 `planTradingLayout(availW)`가 이미 정했다(중앙 >= 560,
     주문 >= 340). 여기서는 사용자가 넓혀 둔 주문판을 그 위에 얹되,
     중앙이 하한 아래로 내려가지 않는 선까지만 허용한다. */
  const showLeft = plan.market.mode !== 'drawer' && layout.leftOpen;
  const resizableMarket = showLeft && plan.market.mode === 'expanded';
  /* 펼친 종목 레일만 손으로 조절한다. 접힌(64px) 레일은 아이콘 한 줄
     크기라 조절할 것이 없다. 조절해도 중앙·주문 하한은 그대로 지킨다. */
  const marketMax = Math.max(MARKET_MIN,
    availW - SPLITTER - SPLITTER - CENTER_MIN - Math.max(ORDER_MIN, layout.orderPx));
  const marketW = !showLeft ? 0
    : resizableMarket ? Math.min(marketMax, Math.max(MARKET_MIN, layout.marketPx))
    : plan.market.width;
  const leftGap = showLeft ? SPLITTER : 0;
  const orderMax = Math.max(ORDER_MIN, availW - marketW - leftGap - SPLITTER - CENTER_MIN);
  const orderW = Math.min(orderMax, Math.max(ORDER_MIN, layout.orderPx));
  const centerW = Math.max(0, availW - marketW - leftGap - SPLITTER - orderW);

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
              {/* data-region은 기하 검사기가 이 칸을 찾는 표식이다.
                  내용으로 추측해서 찾으면 문구가 바뀔 때 검사가 조용히
                  아무것도 안 보게 된다. */}
              <Pane data-region="market" data-mode={plan.market.mode}
                style={{ width: marketW }}><LeftRail compact={plan.market.mode === 'compact'}/></Pane>
              <Splitter onDrag={resizableMarket ? dragMarket : undefined}
                label="종목 패널 폭 조절" min={MARKET_MIN} max={marketMax} now={marketW}/>
            </>
          )}

          <Pane data-region="chart" style={{
            width: centerW, flex: showLeft ? undefined : 1, position: 'relative',
          }}>
            {/* 접어놓고 못 찾으면 접힌 게 아니라 사라진 것이다 */}
            {(
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

          <Splitter onDrag={dragOrder} label="주문 패널 폭 조절" min={ORDER_MIN} max={orderMax} now={orderW}/>
          <Pane data-region="order" data-mode="persistent"
            style={{ width: orderW, flexShrink: 0 }}><OrderPane/></Pane>
        </div>

        <Splitter vertical onDrag={dragV} label="하단 판 높이 조절"/>

        <Pane style={{ height: `${layout.dock}%` }}>
          <BottomDock onBalance={setBalance}/>
        </Pane>
      </div>
    </div>
  );
}

function ShellInner({ embedded }: { embedded?: boolean }) {
  // 서버·첫 렌더에서는 폭을 모른다. 모르는 채로 PC를 그리면 좁은 화면에서
  // 한 번 깨진 뒤에 고쳐지므로, 정해진 뒤에 그린다.
  //
  // **뷰포트가 아니라 담긴 칸을 잰다.** 이 화면은 앱 탭 안에 들어가고,
  // 그 폭은 사이드바와 뉴스 레일을 뺀 값이다. 뷰포트로 재면 1664 창에서
  // "1664니까 3열"이라고 결정하는데 실제로 쓸 수 있는 폭은 1124다.
  const boxRef = useRef<HTMLDivElement>(null);
  const [availW, setAvailW] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setAvailW(el.clientWidth);
    measure();
    // ResizeObserver는 창 크기뿐 아니라 **옆 칸이 접혀서** 넓어진 것도
    // 잡는다. resize 이벤트만 듣던 예전 코드는 그걸 놓쳤다.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  const plan = planTradingLayout(availW);
  const box = (inner: React.ReactNode) => (
    <div ref={boxRef} style={{ width: '100%', height: embedded ? '100%' : '100dvh', minWidth: 0 }}>
      {inner}
    </div>
  );

  if (availW === null) return box(<div style={{ background: C.bg, height: '100%' }}/>);
  if (plan.kind !== 'desktop') return box(<MobileShell embedded wide={plan.kind === 'tablet'}/>);
  return box(<DesktopShell plan={plan} availW={availW} embedded/>);
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
