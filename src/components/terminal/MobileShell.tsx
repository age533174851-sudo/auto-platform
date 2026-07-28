'use client';
// src/components/terminal/MobileShell.tsx
//
// 모바일 배치 — PC를 줄인 것이 아니라 조각을 다시 놓은 것.
//
//   ┌──────────────────────────┐
//   │ BTCUSDT ▾  -2.48%   STOP │  상단
//   ├─────────────┬────────────┤
//   │  주문폼      │  펀딩       │  ← 둘이 항상 같이 보인다
//   │  방향/배율    │  호가       │
//   │  가격/수량    │  중앙가     │
//   │  [롱][숏]    │  잔량 막대   │
//   ├─────────────┴────────────┤
//   │ 포지션(1) · 미체결 · 대조   │  ← 탭
//   ├──────────────────────────┤
//   │ BTCUSDT 차트           ▲ │  ← 접혀 있다. 누르면 올라온다
//   └──────────────────────────┘
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
import { OrderBookPanel, MarketOrderPanel } from './OrderPane';
import { MarketSwitch } from './MarketSwitch';
import { LeftRail } from './LeftRail';
import { BottomDock } from './BottomDock';
import { BottomSheet } from './BottomSheet';
import { SymbolSearch } from './SymbolSearch';
import { AppLauncher } from './AppLauncher';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';

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
function MobileHeader({ onOpenSearch, onOpenInfo, onOpenMenu }: {
  onOpenSearch: () => void; onOpenInfo: () => void; onOpenMenu: () => void;
}) {
  const { symbol, mode, marketType, setMarketType } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);
  const chg = stream.changePct;

  return (
    <div style={{
      flexShrink: 0,
      borderBottom: `1px solid ${C.hair}`,
      background: mode.realMoney
        ? 'linear-gradient(90deg,rgba(246,70,93,.10),transparent 55%)' : C.panel,
      borderLeft: mode.realMoney ? `3px solid ${C.down}` : '3px solid transparent',
    }}>
    <div style={{
      padding: '8px 46px 6px 12px',
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
    <div style={{ padding: '0 12px 8px' }}>
      <MarketSwitch compact value={marketType} onChange={setMarketType}/>
    </div>
    </div>
  );
}

// ── 하단 접이식 차트 ─────────────────────────────────────
function ChartDrawer() {
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
    <div style={{
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

export default function MobileShell() {
  const { symbol, mode, setSymbol, favorites, toggleFavorite } = useTerminal();
  const landscape = useLandscape();
  const [picked, setPicked] = useState<number | null>(null);
  const [search, setSearch] = useState(false);
  const [info, setInfo] = useState(false);
  const [menu, setMenu] = useState(false);

  // ── 가로 ── 차트를 옆에 세울 공간이 생긴다
  if (landscape) {
    return (
      <div style={{
        height: '100dvh', display: 'flex', flexDirection: 'column',
        background: C.bg, color: C.text, overflow: 'hidden',
      }}>
        <MobileHeader onOpenSearch={() => setSearch(true)} onOpenInfo={() => setInfo(true)} onOpenMenu={() => setMenu(true)}/>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, borderRight: `1px solid ${C.hair}` }}>
            <ChartPane symbol={symbol.id} compact/>
          </div>
          <div style={{ width: 210, flexShrink: 0, overflowY: 'auto', borderRight: `1px solid ${C.hair}` }}>
            <OrderBookPanel rows={8} dense showFunding onPickPrice={setPicked}/>
          </div>
          <div style={{ width: 250, flexShrink: 0, overflowY: 'auto' }}>
            <MarketOrderPanel dense presetPrice={picked}/>
          </div>
        </div>
        <SearchSheet open={search} onClose={() => setSearch(false)}
          current={symbol.id} favorites={favorites}
          onToggleFav={toggleFavorite} onPick={s => { setSymbol(s); setSearch(false); }}/>
      </div>
    );
  }

  // ── 세로 ──
  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      background: C.bg, color: C.text, overflow: 'hidden',
    }}>
      <MobileHeader onOpenSearch={() => setSearch(true)} onOpenInfo={() => setInfo(true)} onOpenMenu={() => setMenu(true)}/>

      {/* 주문과 호가는 항상 같이 보인다. 모바일에서 실제로 하는 일이 이것이다. */}
      <div style={{ display: 'flex', minHeight: 0, flex: 1, overflow: 'hidden' }}>
        <div style={{
          width: '56%', flexShrink: 0, overflowY: 'auto',
          borderRight: `1px solid ${C.hair}`,
        }}>
          <MarketOrderPanel dense presetPrice={picked}/>
        </div>
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
          <OrderBookPanel rows={7} dense showFunding onPickPrice={setPicked}/>
        </div>
      </div>

      {/* 포지션 — 접혀 있지 않다. 들고 있는 것을 못 보면 판단을 못 한다.
          BottomDock이 자기 탭(포지션·미체결·상태대조·전략)을 갖고 있으므로
          바깥에서 탭을 한 겹 더 씌우지 않는다. */}
      <div style={{
        flexShrink: 0, height: '27vh', minHeight: 0,
        display: 'flex', flexDirection: 'column',
        borderTop: `1px solid ${C.hair2}`, background: C.panel,
      }}>
        <BottomDock/>
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
