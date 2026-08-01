'use client';
// src/components/terminal/MobileShell.tsx
//
// 모바일 배치 — PC를 줄인 것이 아니라 조각을 다시 놓은 것.
//
// 세로는 세 칸이다: 헤더 · 주문+호가 · 포지션. **포지션은 끌어내리지 않아도
// 보인다** (아래 '왜 페이지 스크롤을 버렸나' 참조).
//
//   ┌──────────────────────────┐ ← 고정
//   │ BTCUSDT ▾  +0.99%   STOP │
//   │ 현물 · USDT-M · COIN-M    │
//   │ 모의 · 테스트넷 · 실전     │
//   ├─────────────┬────────────┤ ─┐
//   │  주문폼      │  펀딩       │  │ 남는 자리 전부
//   │  방향/배율    │  호가       │  │ (길면 이 칸 안에서
//   │  가격/수량    │  현재가 ⟵눌림│  │  스크롤. 롱/숏
//   │  [롱][숏]    │  잔량 막대   │  │  버튼은 바닥 고정)
//   ├─────────────┴────────────┤ ─┘
//   │ ══ (손잡이 — 끌어 키운다)  │ ← 여기부터가 **첫 화면 안에 있다**
//   │ 포지션(2)·미체결·자산 …    │
//   │ ┌──────────────────────┐ │
//   │ │ BTCUSDT LONG 격리 5× │ │
//   │ │ 미실현 −15.72 −43.6% │ │
//   │ └──────────────────────┘ │
//   ├──────────────────────────┤
//   │ BTCUSDT 차트           ▲ │  ← 접혀 있다. 누르면 올라온다
//   └──────────────────────────┘
//
// 왜 페이지 스크롤을 버렸나
// ─────────────────────────
// 한동안 세로를 '한 줄 스크롤'로 뒀다. 포지션 칸의 최소 높이를 '화면 − 헤더'로
// 잡아서, 끌어내리면 포지션이 화면을 꽉 채우게. 그런데 그러면 **포지션을
// 보려면 반드시 한 화면을 통째로 끌어내려야 한다.** 들고 있는 것이 있는지
// 없는지가 스크롤해야만 보이는 정보가 된다 — 그건 없는 것과 비슷하다.
//
// 지금은 화면을 세 칸으로 나눠 고정한다: 헤더 · 주문+호가 · 포지션.
// 포지션 칸은 **처음부터 보인다.** 탭 줄과 첫 카드가 첫 화면 안에 있고,
// 더 보고 싶으면 손잡이를 끌어 키운다. 끄는 것 자체는 좋다고 하셨고,
// 끌어야만 보이는 것이 문제였다.
//
// 스크롤이 두 겹이 되는 문제는 남는다. 그래서 겹치는 자리를 하나로 줄였다:
// 주문 칸과 포지션 칸은 경계가 눈에 보이고(손잡이·테두리), 각자 자기
// 안에서만 움직인다.
//
// 왜 차트가 아래에 접혀 있나
// ──────────────────────────
// 처음에는 차트를 화면 대부분에 놓고 주문·호가를 시트로 올렸다.
// 그런데 모바일에서 실제로 하는 일은 **호가를 보며 주문을 넣는 것**이고,
// 차트는 그 전에 한 번 보는 참고 자료다. 자주 쓰는 둘을 시트 뒤에 숨기고
// 가끔 보는 하나를 전면에 두면 매번 두 번씩 눌러야 한다.
//
// 차트는 한 번 펼치면 접어도 **언마운트하지 않는다**. iframe이 다시 붙으면
// 그려둔 추세선과 확대 구간이 날아간다 — PC에서 지킨 것과 같은 이유다.
import React, { useEffect, useState } from 'react';
import { C, FS, NUM, pnlColor } from './theme';
import { useTerminal } from './TerminalContext';
import { ChartPane } from './ChartPane';
import { OrderBookPanel, MarketOrderPanel, usePickedPrice } from './OrderPane';
import { MarketSwitch } from './MarketSwitch';
import { TradeModeSwitch } from './TradeModeSwitch';
import { LeftRail } from './LeftRail';
import { BottomDock } from './BottomDock';
import { BottomSheet } from './BottomSheet';
import { SymbolSearch } from './SymbolSearch';
import { AppLauncher } from './AppLauncher';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';

/**
 * 헤더 높이를 **재서** 쓴다.
 *
 * 세로 배치에서 헤더는 화면에 고정(sticky)되고, 그 아래 탭 줄도 고정된다.
 * 탭 줄이 붙을 위치가 헤더 높이인데, 그 높이는 고정이 아니다 — 종목 이름이
 * 길거나 시장 전환 줄이 접히면 한 줄이 늘어난다. 상수로 박아 두면 그때
 * 탭 줄이 헤더 밑에 겹쳐 글자가 뭉개진다.
 *
 * 첫 화면의 높이 계산에도 같은 값을 쓴다. 그래서 재는 편이 싸다.
 */
function useMeasuredHeight<T extends HTMLElement>() {
  const ref = React.useRef<T | null>(null);
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

function useLandscape(): boolean {
  const [land, setLand] = useState(false);
  useEffect(() => {
    const check = () => setLand(window.innerWidth > window.innerHeight && window.innerHeight < 560);
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);
  return land;
}

// ── 상단 ────────────────────────────────────────────────
function MobileHeader({ onOpenSearch, onOpenInfo, onOpenMenu, innerRef, sticky }: {
  onOpenSearch: () => void; onOpenInfo: () => void; onOpenMenu: () => void;
  innerRef?: React.Ref<HTMLDivElement>;
  /** 세로 배치에서는 화면에 고정한다 — 스크롤을 내려도 종목·가격·STOP은 보여야 한다 */
  sticky?: boolean;
}) {
  const { symbol, mode, marketType, setMarketType } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);
  const chg = stream.changePct;

  return (
    <div ref={innerRef} style={{
      flexShrink: 0,
      borderBottom: `1px solid ${C.hair}`,
      background: mode.realMoney
        ? 'linear-gradient(90deg,rgba(246,70,93,.10),transparent 55%)' : C.panel,
      borderLeft: mode.realMoney ? `3px solid ${C.down}` : '3px solid transparent',
      // 고정 헤더는 아래 내용보다 위에 있어야 한다. 탭 줄도 sticky라서
      // z-index를 주지 않으면 탭 줄이 헤더를 덮는다.
      ...(sticky ? { position: 'sticky' as const, top: 0, zIndex: 20 } : null),
    }}>
    <div style={{
      padding: '6px 46px 4px 12px',
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <button onClick={onOpenSearch} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        background: 'none', border: 'none', padding: 0, cursor: 'pointer', minWidth: 0,
      }}>
        <span style={{
          color: C.text, fontSize: 15, fontWeight: 800,
          letterSpacing: '-0.02em', whiteSpace: 'nowrap',
        }}>{symbol.id}</span>
        <span style={{
          color: C.faint, fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0,
          background: C.raised, borderRadius: 4, padding: '2px 5px',
        }}>무기한</span>
        <span style={{ color: C.dim, fontSize: 10, flexShrink: 0 }}>▾</span>
      </button>

      <span style={{ ...NUM, color: pnlColor(chg), fontSize: FS.body, fontWeight: 700 }}>
        {chg != null ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '—'}
      </span>

      <div style={{ flex: 1 }}/>
      {/* 터미널이 섬이 되지 않게. 앱의 나머지 기능으로 가는 유일한 길이다. */}
      <button onClick={onOpenMenu} title="전체 메뉴" style={{
        minHeight: 30, width: 32, background: C.raised, color: C.dim,
        border: `1px solid ${C.hair}`, borderRadius: 7,
        fontSize: 13, cursor: 'pointer', flexShrink: 0, lineHeight: 1,
      }}>☰</button>
      <button onClick={onOpenInfo} title="AI · 뉴스 · 일정" style={{
        minHeight: 30, padding: '0 10px', background: C.raised, color: C.dim,
        border: `1px solid ${C.hair}`, borderRadius: 7,
        fontSize: FS.micro, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
      }}>AI·뉴스</button>
      <KillButton/>
      {/* 모드는 점 하나로. 자리는 안 먹되 색은 남는다 */}
      <span
        title={mode.unknown ? '운영 모드 확인 불가' : mode.label}
        style={{
          width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
          background: mode.unknown ? C.warn : mode.realMoney ? C.down : C.up,
          boxShadow: mode.realMoney ? `0 0 0 3px ${C.downBg}` : 'none',
        }}
      />
    </div>

    {/* 시장 전환은 자기 줄을 갖는다. 종목·가격과 같은 줄에 두면
        좁은 화면에서 서로를 밀어내고, 밀려난 쪽이 잘린다.
        어느 시장에 있는지는 잘려도 되는 정보가 아니다. */}
    <div style={{ padding: '0 12px 6px', display: 'flex', flexDirection: 'column', gap: 5 }}>
      <MarketSwitch compact value={marketType} onChange={setMarketType}/>
      {/* 이 화면에서 가장 중요한 한 줄 — 진짜 돈인가.
          접거나 메뉴에 넣지 않는다. */}
      <TradeModeSwitch compact/>
    </div>
    </div>
  );
}

/**
 * 포지션 칸 손잡이.
 *
 * 끌면 칸이 커지고, 누르면 최대/최소를 오간다. 둘 다 두는 이유는 **끌기가
 * 보이지 않는 기능**이기 때문이다 — 손잡이가 있어도 끌 수 있는 줄 모르는
 * 사람이 있고, 그 사람에게는 없는 기능이다.
 *
 * 포인터 이벤트를 쓰고 캡처한다. touchmove만 쓰면 손가락이 칸 밖으로 나가는
 * 순간 이벤트가 끊겨 칸이 끌리다 만 자리에 멈춘다.
 */
function DockHandle({ onDrag, onToggle }: {
  onDrag: (dy: number) => void;
  onToggle: () => void;
}) {
  const last = React.useRef<number | null>(null);
  const moved = React.useRef(0);

  return (
    <div
      onPointerDown={e => {
        last.current = e.clientY;
        moved.current = 0;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        if (last.current == null) return;
        const dy = e.clientY - last.current;
        if (dy === 0) return;
        last.current = e.clientY;
        moved.current += Math.abs(dy);
        onDrag(dy);
      }}
      onPointerUp={e => {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        // 끌지 않고 뗐으면 누른 것으로 본다. 8px는 손 떨림 여유다.
        if (moved.current < 8) onToggle();
        last.current = null;
      }}
      onPointerCancel={() => { last.current = null; }}
      style={{
        flexShrink: 0, height: 18, cursor: 'ns-resize',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        touchAction: 'none',
      }}
    >
      <div style={{ width: 34, height: 4, borderRadius: 2, background: C.hair2 }}/>
    </div>
  );
}

// ── 하단 접이식 차트 ─────────────────────────────────────
function ChartDrawer({ innerRef }: { innerRef?: React.Ref<HTMLDivElement> }) {
  const { symbol } = useTerminal();
  const [open, setOpen] = useState(false);
  // 한 번 열면 계속 붙여 둔다. 접을 때마다 언마운트하면 다시 펼 때
  // iframe이 처음부터 로드되고 그려둔 것이 날아간다.
  const [mounted, setMounted] = useState(false);

  const toggle = () => {
    if (!mounted) setMounted(true);
    setOpen(v => !v);
  };

  return (
    <div ref={innerRef} style={{
      flexShrink: 0, borderTop: `1px solid ${C.hair2}`, background: C.panel,
      display: 'flex', flexDirection: 'column',
      height: open ? '58vh' : 'auto', minHeight: 0,
    }}>
      <button onClick={toggle} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', background: 'none', border: 'none', cursor: 'pointer',
        padding: '12px 14px', paddingBottom: open ? 8 : 'max(env(safe-area-inset-bottom), 12px)',
        color: C.text, fontSize: FS.body, fontWeight: 600, flexShrink: 0,
      }}>
        <span>{symbol.id} 차트</span>
        <span style={{ color: C.dim, fontSize: 11 }}>{open ? '▼' : '▲'}</span>
      </button>

      {mounted && (
        // 접혀 있을 때는 높이 0으로 숨긴다. display:none이면 iframe이
        // 다시 그려질 때 크기를 0으로 인식해 차트가 깨진다.
        <div style={{
          flex: open ? 1 : undefined, height: open ? undefined : 0,
          minHeight: 0, overflow: 'hidden',
        }}>
          <ChartPane symbol={symbol.id} compact/>
        </div>
      )}
    </div>
  );
}

export default function MobileShell({ embedded }: { embedded?: boolean } = {}) {
  const { symbol, mode, setSymbol, favorites, toggleFavorite } = useTerminal();
  const landscape = useLandscape();
  const [hdrRef, hdrH] = useMeasuredHeight<HTMLDivElement>();
  // 스크롤 통의 실제 높이. `100dvh`를 그대로 쓰지 않는 이유: 이 화면은
  // 앱 탭 안에 끼워지기도 한다(embedded). 그때 통의 높이는 화면 높이에서
  // 하단탭과 위쪽 여백을 뺀 값이라 100dvh보다 작다 — dvh로 칸을 잘라 두면
  // 첫 화면이 통보다 커져서 '엿보기'가 화면 밖으로 밀린다.
  const [boxRef, boxH] = useMeasuredHeight<HTMLDivElement>();
  // 호가 줄·현재가를 누르면 그 가격이 주문폼에 들어간다. 같은 가격을 두 번
  // 눌러도 반영되도록 누른 횟수를 같이 들고 다닌다 (usePickedPrice 주석).
  const { pick, presetPrice, presetSeq } = usePickedPrice();
  // 사용자가 손잡이로 정한 포지션 칸 높이. null이면 기본값(통의 32%)을 쓴다.
  const [dockUser, setDockUser] = useState<number | null>(null);
  // 주문폼의 **자연 높이**. 스크롤 통 안쪽을 재야 내용 전체 높이가 나온다 —
  // 바깥(통)을 재면 통에 맞춰 잘린 높이가 나와서 아무 정보가 없다.
  const [formRef, formH] = useMeasuredHeight<HTMLDivElement>();
  // 접힌 차트 줄도 자리를 차지한다. 이걸 빼먹으면 폼을 아무리 줄여도
  // **딱 차트 줄 높이만큼** 계속 모자란다 — 남는 자리를 포지션에 다 줘
  // 버리고, 밀려나는 것은 flex:1인 주문 칸이기 때문이다.
  const [chartRef, chartH] = useMeasuredHeight<HTMLDivElement>();
  const [search, setSearch] = useState(false);
  const [info, setInfo] = useState(false);
  const [menu, setMenu] = useState(false);

  // ── 가로 ── 차트를 옆에 세울 공간이 생긴다
  if (landscape) {
    return (
      <div style={{
        height: embedded ? '100%' : '100dvh', display: 'flex', flexDirection: 'column',
        background: C.bg, color: C.text, overflow: 'hidden',
      }}>
        <MobileHeader onOpenSearch={() => setSearch(true)} onOpenInfo={() => setInfo(true)} onOpenMenu={() => setMenu(true)}/>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, borderRight: `1px solid ${C.hair}` }}>
            <ChartPane symbol={symbol.id} compact/>
          </div>
          <div style={{ width: 210, flexShrink: 0, overflowY: 'auto', borderRight: `1px solid ${C.hair}` }}>
            <OrderBookPanel rows={8} dense showFunding onPickPrice={pick}/>
          </div>
          <div style={{ width: 250, flexShrink: 0, overflowY: 'auto' }}>
            <MarketOrderPanel dense presetPrice={presetPrice} presetSeq={presetSeq}/>
          </div>
        </div>
        <SearchSheet open={search} onClose={() => setSearch(false)}
          current={symbol.id} favorites={favorites}
          onToggleFav={toggleFavorite} onPick={s => { setSymbol(s); setSearch(false); }}/>
      </div>
    );
  }

  // ── 세로 ──
  //
  // 세 칸으로 나눠 고정한다. 페이지 스크롤은 없다.
  //
  //   헤더        잰 높이 그대로 (종목이 길면 한 줄 늘어난다)
  //   주문+호가   남는 자리 전부. 폼이 길면 이 칸 안에서 스크롤한다
  //   포지션      dockH. **첫 화면 안에 있다.** 손잡이로 키운다
  //   차트        접혀 있으면 한 줄
  //
  // dockH의 기본값은 통 높이의 32%다. 카드 하나(약 150px)와 탭 줄이 들어가는
  // 최소치를 밑으로 두고, 위로는 주문 버튼이 남을 만큼만 올라간다 —
  // 포지션을 키우다가 주문을 못 넣게 되면 그건 다른 화면이 된 것이다.
  // 포지션 칸의 기본 높이는 **주문폼이 다 들어가고 남는 만큼**이다.
  //
  // 처음에는 '통의 32%'로 고정했다. 그런데 앱 안에서는 남는 높이가 상황마다
  // 다르고(배너·시세띠·하단탭), 32%를 떼고 나면 주문폼이 자기 칸에 안 들어가
  // **폼 안에서 또 스크롤**이 생겼다. 롱/숏 버튼이 바닥에 고정돼 있으니 그
  // 버튼이 손절·수량 줄을 덮었고, 화면은 "주문할 것이 두 줄뿐인" 모양이 됐다.
  //
  // 그래서 반대로 잡는다: 폼의 자연 높이(formH)를 재고, 남는 것을 포지션에
  // 준다. 폼이 다 들어가면 스크롤이 아예 없다. 폼이 너무 길어 안 들어가면
  // 그때만 폼이 스크롤하고, 포지션은 탭 줄만 남는다 — **탭 줄은 항상 보인다.**
  const avail = Math.max(0, boxH - hdrH);
  const dockMin = 84;                       // 손잡이 + 탭 줄
  const dockMax = Math.max(dockMin, avail - 160);
  const leftover = formH > 0
    ? avail - formH - chartH
    : Math.round(avail * 0.32);
  const dockH = avail === 0 ? 160
    : Math.min(dockMax, Math.max(dockMin, dockUser ?? leftover));

  return (
    <div ref={boxRef} style={{
      height: embedded ? '100%' : '100dvh',
      background: C.bg, color: C.text,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <MobileHeader innerRef={hdrRef}
        onOpenSearch={() => setSearch(true)} onOpenInfo={() => setInfo(true)} onOpenMenu={() => setMenu(true)}/>

      {/* 주문 + 호가 — 남는 자리 전부.
          두 열이 각자 스크롤한다. 주문폼이 호가보다 길어서 한 통에 넣으면
          호가가 폼 길이에 끌려 올라간다 — 호가는 늘 같은 자리에 있어야
          눈이 찾는다. 롱/숏 버튼은 폼 안에서 바닥에 고정돼 있다. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <div style={{
          width: '56%', flexShrink: 0, minHeight: 0,
          borderRight: `1px solid ${C.hair}`,
          overflowY: 'auto', overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch' as any,
        }}>
          <div ref={formRef}>
            <MarketOrderPanel dense presetPrice={presetPrice} presetSeq={presetSeq}/>
          </div>
        </div>
        <div style={{
          flex: 1, minWidth: 0, minHeight: 0,
          overflowY: 'auto', overscrollBehavior: 'contain',
        }}>
          <OrderBookPanel rows={7} dense showFunding onPickPrice={pick}/>
        </div>
      </div>

      {/* 포지션 — 첫 화면 안에 있다. 손잡이를 끌면 커진다. */}
      <div style={{
        height: dockH, flexShrink: 0, minHeight: 0,
        borderTop: `1px solid ${C.hair2}`, background: C.panel,
        display: 'flex', flexDirection: 'column',
      }}>
        <DockHandle
          onDrag={dy => setDockUser(h => Math.min(dockMax, Math.max(dockMin, (h ?? dockH) - dy)))}
          onToggle={() => setDockUser(h => ((h ?? dockH) > dockMin + 20 ? dockMin : dockMax))}
        />
        <div style={{ flex: 1, minHeight: 0 }}>
          <BottomDock/>
        </div>
      </div>

      <ChartDrawer innerRef={chartRef}/>

      <SearchSheet open={search} onClose={() => setSearch(false)}
        current={symbol.id} favorites={favorites}
        onToggleFav={toggleFavorite} onPick={s => { setSymbol(s); setSearch(false); }}/>

      <BottomSheet open={menu} title="전체 메뉴" onClose={() => setMenu(false)} maxHeightPct={88}>
        <div style={{ height: '74vh' }}><AppLauncher onClose={() => setMenu(false)}/></div>
      </BottomSheet>

      <BottomSheet open={info} title="AI · 뉴스 · 일정" onClose={() => setInfo(false)}>
        <div style={{ height: '62vh' }}><LeftRail/></div>
      </BottomSheet>

      {mode.realMoney && (
        <div style={{
          position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 70,
          boxShadow: `inset 0 0 0 2px ${C.down}`,
        }}/>
      )}
    </div>
  );
}

function SearchSheet({ open, onClose, current, favorites, onToggleFav, onPick }: {
  open: boolean; onClose: () => void; current: string;
  favorites: string[]; onToggleFav: (id: string) => void;
  onPick: (s: any) => void;
}) {
  return (
    <BottomSheet open={open} title="종목 검색" onClose={onClose} maxHeightPct={86}>
      <div style={{ height: '72vh' }}>
        <SymbolSearch embedded current={current} favorites={favorites}
          onToggleFav={onToggleFav} onPick={onPick} onClose={onClose}/>
      </div>
    </BottomSheet>
  );
}

/**
 * Kill Switch는 접거나 시트에 넣지 않는다.
 * 필요한 순간에 두 번 누르게 하면 안 된다.
 */
function KillButton() {
  const { auth, connId } = useTerminal();
  const [busy, setBusy] = useState(false);

  const fire = async () => {
    if (!auth || !connId) { alert('로그인·거래소 연결이 필요합니다'); return; }
    if (!window.confirm('킬스위치를 발동합니다.\n신규 진입이 차단됩니다. 진행할까요?')) return;
    setBusy(true);
    try {
      const r = await fetch('/api/risk/kill-switch/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ connectionId: connId, reason: '모바일 터미널에서 수동 발동' }),
      });
      const j = await r.json();
      alert(r.ok ? '킬스위치 발동됨 — 신규 진입 차단' : (j?.message || j?.error || '발동 실패'));
    } catch (e: any) { alert(`실패: ${e?.message || e}`); }
    finally { setBusy(false); }
  };

  return (
    <button onClick={fire} disabled={busy} style={{
      minHeight: 30, padding: '0 11px',
      background: C.downBg, color: C.down,
      border: `1px solid ${C.down}55`, borderRadius: 7,
      fontSize: FS.micro, fontWeight: 700, cursor: busy ? 'default' : 'pointer',
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>{busy ? '…' : 'STOP'}</button>
  );
}
