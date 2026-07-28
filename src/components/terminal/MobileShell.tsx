'use client';
// src/components/terminal/MobileShell.tsx
//
// 모바일 배치 — PC를 줄인 것이 아니라 같은 조각을 다시 놓은 것.
//
//   세로
//   ┌──────────────────┐
//   │ 상단 (종목·가격)   │
//   │                  │
//   │      차트         │  ← 화면 대부분. 항상 살아 있다
//   │                  │
//   ├──────────────────┤
//   │ [주문][포지션]     │  ← 하단 고정. 누르면 시트가 위로 덮는다
//   │ [호가][AI·뉴스]    │
//   └──────────────────┘
//
//   가로 — 시트를 쓰지 않는다. 가로에서 시트를 올리면 남는 높이가 없다.
//   ┌─────────────┬──────┐
//   │    차트      │ 패널  │
//   └─────────────┴──────┘
//
// 차트를 시트 **아래에** 두는 이유
// ────────────────────────────────
// 패널을 화면 전환으로 만들면 차트가 언마운트되고, PC에서 지켜낸 것
// (iframe이 살아남아 추세선·확대가 유지되는 것)을 모바일에서 다시 잃는다.
// 시트는 겹치는 것이라 아래는 그대로 있다.
import React, { useEffect, useState } from 'react';
import { C, FS, tabStyle } from './theme';
import { useTerminal } from './TerminalContext';
import { TopBar } from './TopBar';
import { ChartPane } from './ChartPane';
import { OrderBookPanel, OrderFormPanel } from './OrderPane';
import { LeftRail } from './LeftRail';
import { BottomDock } from './BottomDock';
import { BottomSheet } from './BottomSheet';

type SheetId = '주문' | '포지션' | '호가' | '정보';

const NAV: { id: SheetId; label: string; icon: string }[] = [
  { id: '주문', label: '주문', icon: '⇄' },
  { id: '포지션', label: '포지션', icon: '▤' },
  { id: '호가', label: '호가', icon: '≡' },
  { id: '정보', label: 'AI·뉴스', icon: '◔' },
];

const NAV_H = 58;

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

function PanelBody({ id, onPickPrice, pickedPrice, onBalance }: {
  id: SheetId;
  onPickPrice: (p: number) => void;
  pickedPrice: number | null;
  onBalance: (v: number | null) => void;
}) {
  if (id === '주문') return <OrderFormPanel presetPrice={pickedPrice}/>;
  if (id === '호가') return <OrderBookPanel rows={11} onPickPrice={onPickPrice}/>;
  if (id === '포지션') return <div style={{ height: '58vh' }}><BottomDock onBalance={onBalance}/></div>;
  return <div style={{ height: '58vh' }}><LeftRail/></div>;
}

export default function MobileShell() {
  const { mode } = useTerminal();
  const landscape = useLandscape();
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [panel, setPanel] = useState<SheetId>('주문');   // 가로모드용
  const [picked, setPicked] = useState<number | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const { symbol } = useTerminal();

  // 호가에서 가격을 고르면 주문으로 넘긴다 — 시트를 갈아 끼운다
  const pickPrice = (p: number) => {
    setPicked(p);
    if (landscape) setPanel('주문'); else setSheet('주문');
  };

  // ── 가로 ── 2열. 시트를 올릴 높이가 없다.
  if (landscape) {
    return (
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: C.bg, color: C.text }}>
        <TopBar compact balance={balance} right={<KillButton compact/>}/>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, borderRight: `1px solid ${C.hair}` }}>
            <ChartPane symbol={symbol.id} compact/>
          </div>
          <div style={{
            width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column',
            background: C.panel, minHeight: 0,
          }}>
            <div style={{
              display: 'flex', gap: 4, padding: 6,
              borderBottom: `1px solid ${C.hair}`, flexShrink: 0, overflowX: 'auto',
            }}>
              {NAV.map(n => (
                <button key={n.id} onClick={() => setPanel(n.id)} style={tabStyle(panel === n.id)}>
                  {n.label}
                </button>
              ))}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <PanelBody id={panel} onPickPrice={pickPrice} pickedPrice={picked} onBalance={setBalance}/>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 세로 ──
  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      background: C.bg, color: C.text, overflow: 'hidden',
    }}>
      <TopBar compact balance={balance} right={<KillButton compact/>}/>

      {/* 차트는 항상 여기 있다. 시트가 덮어도 언마운트되지 않는다. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChartPane symbol={symbol.id} compact/>
      </div>

      <nav style={{
        height: NAV_H, flexShrink: 0, display: 'grid',
        gridTemplateColumns: `repeat(${NAV.length},1fr)`,
        borderTop: `1px solid ${C.hair}`, background: C.panel,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {NAV.map(n => {
          const on = sheet === n.id;
          return (
            <button key={n.id} onClick={() => setSheet(on ? null : n.id)} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 3, background: 'none', border: 'none', cursor: 'pointer',
              color: on ? C.accent : C.dim,
              // 주문 탭만 상단에 얇은 강조선. 가장 많이 누르는 곳이다.
              boxShadow: on ? `inset 0 2px 0 ${C.accent}` : 'none',
            }}>
              <span style={{ fontSize: 15, lineHeight: 1 }}>{n.icon}</span>
              <span style={{ fontSize: FS.micro, fontWeight: on ? 700 : 500 }}>{n.label}</span>
            </button>
          );
        })}
      </nav>

      <BottomSheet
        open={sheet !== null}
        title={sheet === '정보' ? 'AI · 뉴스 · 일정' : sheet ?? ''}
        onClose={() => setSheet(null)}
        // 주문 시트는 끌어서 닫히지 않는다. 수량을 입력하다 미끄러지면
        // 처음부터 다시 해야 한다.
        lockDrag={sheet === '주문'}
        maxHeightPct={sheet === '주문' ? 90 : 82}
      >
        {sheet && (
          <PanelBody id={sheet} onPickPrice={pickPrice} pickedPrice={picked} onBalance={setBalance}/>
        )}
      </BottomSheet>

      {/* 실자금이면 화면 테두리가 붉다 */}
      {mode.realMoney && (
        <div style={{
          position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 70,
          boxShadow: `inset 0 0 0 2px ${C.down}`,
        }}/>
      )}
    </div>
  );
}

/**
 * Kill Switch는 시트 안에 숨기지 않는다.
 * 필요한 순간에 두 번 누르게 하면 안 된다.
 */
function KillButton({ compact }: { compact?: boolean }) {
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
      minHeight: 34, padding: compact ? '0 12px' : '0 16px',
      background: C.downBg, color: C.down,
      border: `1px solid ${C.down}55`, borderRadius: 8,
      fontSize: FS.small, fontWeight: 700, cursor: busy ? 'default' : 'pointer',
      whiteSpace: 'nowrap',
    }}>{busy ? '…' : 'STOP'}</button>
  );
}
