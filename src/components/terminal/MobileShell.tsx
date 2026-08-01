'use client';
// src/components/terminal/MobileShell.tsx
//
// 모바일 배치 — PC를 줄인 것이 아니라 조각을 다시 놓은 것.
//
// 첫 화면은 스크롤 없이 다 보이고, **더 보려면 그냥 내린다.**
//
//   ┌──────────────────────────┐ ← 붙어 있다(sticky)
//   │ BTCUSDT ▾  −1.91%   STOP │
//   │ 현물·USDT-M·COIN-M │ 모의·테스트넷·실전 │
//   ├─────────────┬────────────┤ ─┐
//   │  주문폼      │  펀딩       │  │ 첫 화면의 나머지를
//   │  방향/배율    │  호가       │  │ 정확히 채운다.
//   │  가격/수량    │  현재가 ⟵눌림│  │ 스크롤 없이 다 보인다
//   │  [롱][숏]    │  잔량 막대   │  │
//   ├─────────────┴────────────┤ ─┘
//   │ 포지션 · 데모 · 미체결 …   │ ← 탭 줄까지가 첫 화면 (sticky)
//   ├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
//   │ ┌──────────────────────┐ │ ← 여기부터는 화면을 내리면 나온다
//   │ │ BTCUSDT LONG 격리 5× │ │
//   │ │ 미실현 −15.72 −43.6% │ │
//   │ └──────────────────────┘ │
//   ├──────────────────────────┤
//   │ BTCUSDT 차트           ▲ │  ← 맨 아래. 누르면 올라온다
//   └──────────────────────────┘
//
// 배치가 세 번 바뀐 이유 — 두 요구가 서로 반대처럼 보였다
// ───────────────────────────────────────────────────────
//  1. 처음: 포지션 칸의 최소 높이를 '화면 − 헤더'로 뒀다. 그러면 **포지션을
//     보려면 반드시 한 화면을 통째로 끌어내려야 한다.** 들고 있는 것이 있는지
//     없는지가 스크롤해야만 보이는 정보가 된다 — 없는 것과 비슷하다.
//  2. 그래서 칸을 고정하고 손잡이로 끌게 했다. 그런데 **끌기는 보이지 않는
//     기능**이다. 손잡이가 있어도 끌 수 있는 줄 모르는 사람에게는 없는
//     기능이고, 그 사람의 포지션 칸은 영원히 탭 줄뿐이다.
//  3. 지금: 첫 화면을 고정하고 **그 아래는 그냥 페이지 스크롤**이다.
//
// 1번이 문제였던 것은 스크롤 자체가 아니라 **스크롤이 필수**였다는 점이다.
// 지금은 주문폼이 첫 화면에 다 들어가므로 내리는 것은 '더 보려고' 하는 일이지
// 주문하려고 하는 일이 아니다. 화면을 내리는 것은 아무도 배울 필요가 없다.
//
// 스크롤이 두 겹이 되는 문제는 통을 **하나로** 두어 없앴다. 주문 칸과 호가
// 칸은 각자 스크롤하지 않는다(overflow: hidden) — 손가락이 어디에 닿았는지에
// 따라 다르게 움직이는 화면이 되지 않게.
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

    {/* 시장 전환과 모드 전환을 **한 줄에** 놓는다.
        둘 다 종목·가격 줄에는 못 넣는다(서로를 밀어내고 밀려난 쪽이 잘린다).
        그렇다고 각자 한 줄씩 쓰면 헤더만 130px이고, 그 차이가 그대로
        주문폼에서 빠져 25%·50% 줄이 진입 버튼 뒤로 밀렸다.

        둘 다 칩 세 개짜리라 360px에 나란히 들어간다. 어느 쪽도 접거나
        메뉴로 숨기지 않는다 — '현물인가 선물인가'와 '진짜 돈인가'는
        잘려도 되는 정보가 아니다. */}
    <div style={{ padding: '0 12px 6px', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <div style={{ flexShrink: 0 }}>
        <MarketSwitch compact value={marketType} onChange={setMarketType}/>
      </div>
      {/* 이 화면에서 가장 중요한 한 줄 — 진짜 돈인가. */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <TradeModeSwitch compact/>
      </div>
    </div>
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
        padding: '9px 14px', paddingBottom: open ? 8 : 'max(env(safe-area-inset-bottom), 9px)',
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
  // 첫 화면은 고정, 그 아래는 **그냥 내리면 이어진다.**
  //
  //   ┌ 헤더        화면에 붙어 있다(sticky)          ┐
  //   │ 주문+호가   첫 화면의 나머지를 정확히 채운다  │ ← 스크롤 없이 다 보인다
  //   │ 탭 줄       포지션·데모·미체결…  (sticky)     ┘
  //   ├ 포지션 카드  ← 여기부터는 화면을 내리면 나온다
  //   └ 차트        맨 아래
  //
  // 손잡이(드래그)를 없앤 이유
  // ──────────────────────────
  // 한동안 포지션 칸을 고정 높이로 두고 손잡이로 끌어 키웠다. 그런데
  // **끌기는 보이지 않는 기능**이다 — 손잡이가 있어도 끌 수 있는 줄 모르는
  // 사람에게는 없는 기능이고, 그 사람에게 포지션 칸은 영원히 탭 줄뿐이다.
  //
  // 화면을 내리는 것은 아무도 배울 필요가 없다. 그래서 끌기를 없애고
  // 페이지 스크롤로 바꿨다.
  //
  // 예전에 페이지 스크롤을 버렸던 이유는 지금 없다
  // ──────────────────────────────────────────────
  // 그때는 포지션 칸의 최소 높이가 '화면 − 헤더'라, 포지션을 보려면 **반드시**
  // 한 화면을 통째로 끌어내려야 했다. 지금은 주문폼이 첫 화면에 다 들어가므로
  // 내리는 것은 **더 보려고** 하는 일이지 필수가 아니다. 안 내리면 주문만
  // 하면 되고, 내리면 포지션이 나온다.
  //
  // 첫 화면의 주문 칸 높이 = 통 − 헤더 − TAB_ROW.
  // 탭 줄만큼 남기는 이유: 그 줄이 안 보이면 아래에 무언가 있다는 사실 자체가
  // 안 보인다. 스크롤은 배울 필요 없는 동작이지만, **내릴 것이 있다는 신호**는
  // 화면에 있어야 한다.
  const TAB_ROW = 76;          // 탭 줄(48) + 그 아래 내용이 살짝 비치는 만큼
  const firstScreen = Math.max(220, boxH - hdrH - TAB_ROW);

  return (
    <div ref={boxRef} style={{
      height: embedded ? '100%' : '100dvh',
      background: C.bg, color: C.text,
      // 이 통이 스크롤을 갖는다. 안쪽 칸들은 각자 스크롤하지 않는다 —
      // 두 겹이 되면 손가락이 어디에 닿았는지에 따라 다르게 움직인다.
      overflowY: 'auto', overscrollBehavior: 'contain',
      WebkitOverflowScrolling: 'touch' as any,
    }}>
      {/* 헤더는 붙어 있는다. 내려도 종목·가격·STOP은 보여야 한다. */}
      <MobileHeader innerRef={hdrRef} sticky
        onOpenSearch={() => setSearch(true)} onOpenInfo={() => setInfo(true)} onOpenMenu={() => setMenu(true)}/>

      {/* 주문 + 호가 — 첫 화면의 나머지를 정확히 채운다.
          두 열을 한 통에 넣지 않는 이유: 주문폼이 호가보다 길어서 한 통이면
          호가가 폼 길이에 끌려 올라간다 — 호가는 늘 같은 자리에 있어야
          눈이 찾는다. */}
      <div style={{ height: firstScreen, display: 'flex', overflow: 'hidden' }}>
        <div style={{
          width: '56%', flexShrink: 0, minHeight: 0, overflow: 'hidden',
          borderRight: `1px solid ${C.hair}`,
        }}>
          <MarketOrderPanel dense presetPrice={presetPrice} presetSeq={presetSeq}/>
        </div>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
          <OrderBookPanel rows={7} dense showFunding onPickPrice={pick}/>
        </div>
      </div>

      {/* 포지션 — 탭 줄은 첫 화면 안에 있고, 카드는 내리면 나온다.
          `flow`는 이 독이 **자기 스크롤을 갖지 않는다**는 뜻이다. 탭 줄은
          헤더 밑에 붙어(stickyTop) 카드 사이를 지나가는 동안에도 남는다. */}
      <div style={{ borderTop: `1px solid ${C.hair2}`, background: C.panel }}>
        <BottomDock flow stickyTop={hdrH}/>
      </div>

      <ChartDrawer/>

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
