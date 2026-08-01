'use client';
// src/components/terminal/TopBar.tsx
//
// 상단 띠 — 종목 · 가격 · 계좌 · 연결.
//
// 여기에 기능을 더 붙이지 않는다. 상단이 두꺼워지면 차트가 그만큼 줄고,
// 차트는 이 화면에서 가장 오래 보는 곳이다.
//
// 실전/Testnet은 글자가 아니라 **색과 위치**로 구분한다. 급할 때 글자는
// 안 읽힌다. 실자금이면 상단 왼쪽에 붉은 띠가 서고 배경이 물든다.
import React, { memo, useState } from 'react';
import { C, FS, NUM, chip, fmtPrice, pnlColor } from './theme';
import { DataBadge } from '@/components/ui/DataBadge';
import { useTerminal } from './TerminalContext';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';
import { SymbolSearch } from './SymbolSearch';
import { MarketSwitch } from './MarketSwitch';
import { TradeModeSwitch } from './TradeModeSwitch';
import { AppLauncher } from './AppLauncher';

export const TOPBAR_H = 52;

function SymbolPicker({ compact }: { compact?: boolean }) {
  const { symbol, setSymbol, favorites, toggleFavorite } = useTerminal();
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 7,
          background: open ? C.active : C.raised,
          border: `1px solid ${open ? C.hair2 : C.hair}`, borderRadius: 8,
          padding: compact ? '6px 9px' : '7px 11px', cursor: 'pointer',
          color: C.text, fontSize: compact ? FS.body : FS.lead, fontWeight: 700,
          whiteSpace: 'nowrap',
        }}
      >
        {symbol.id.replace(/USDT$/, '')}
        <span style={{ color: C.faint, fontSize: FS.micro, fontWeight: 500 }}>USDT</span>
        <span style={{ color: C.faint, fontSize: 9, marginLeft: 1 }}>▾</span>
      </button>

      {open && (
        <>
          {/* 바깥을 눌러 닫는다. onBlur로 닫으면 목록 안의 별을 누르는 순간
              닫혀서 즐겨찾기를 여러 개 못 고른다. */}
          <div onClick={() => setOpen(false)}
               style={{ position: 'fixed', inset: 0, zIndex: 59 }}/>
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 60,
            width: compact ? 'min(92vw, 360px)' : 420,
          }}>
            <SymbolSearch
              current={symbol.id}
              favorites={favorites}
              onToggleFav={toggleFavorite}
              onPick={s => { setSymbol(s); setOpen(false); }}
              onClose={() => setOpen(false)}
            />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 전체 메뉴. 로고 자리를 이 버튼이 대신한다 —
 * 로고는 아무 데도 데려다주지 않지만 이건 앱 전체로 데려다준다.
 */
function AppMenuButton() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(v => !v)} style={{
        display: 'flex', alignItems: 'baseline', gap: 6, cursor: 'pointer',
        background: open ? C.active : 'transparent',
        border: `1px solid ${open ? C.hair2 : 'transparent'}`,
        borderRadius: 8, padding: '5px 9px',
      }}>
        <span style={{ color: C.text, fontWeight: 800, fontSize: FS.lead, letterSpacing: '-0.02em' }}>
          TRAIGO
        </span>
        <span style={{ color: C.faint, fontSize: FS.micro, fontWeight: 500 }}>Pro</span>
        <span style={{ color: C.faint, fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 59 }}/>
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 60,
            width: 520, height: 460,
            background: C.panel, border: `1px solid ${C.hair2}`, borderRadius: 12,
            boxShadow: '0 16px 48px rgba(0,0,0,.6)', overflow: 'hidden',
          }}>
            <AppLauncher onClose={() => setOpen(false)}/>
          </div>
        </>
      )}
    </div>
  );
}

function TopBarInner({ balance, compact, right }: {
  balance: number | null;
  compact?: boolean;
  /** 모바일에서 Kill Switch 등을 오른쪽에 끼워 넣는다 */
  right?: React.ReactNode;
}) {
  const { symbol, mode, connections, marketType, setMarketType } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);

  const px = stream.lastPrice;
  const chg = stream.changePct;
  const live = stream.status === 'live' && !stream.stale;

  return (
    <div style={{
      height: TOPBAR_H, display: 'flex', alignItems: 'center',
      gap: compact ? 10 : 16, padding: compact ? '0 46px 0 12px' : '0 14px',
      borderBottom: `1px solid ${C.hair}`, flexShrink: 0,
      background: mode.realMoney ? 'linear-gradient(90deg,rgba(246,70,93,.10),transparent 42%)' : C.panel,
      // 실자금이면 왼쪽에 붉은 기둥이 선다. 어느 패널을 보든 시야 끝에 걸린다.
      borderLeft: mode.realMoney ? `3px solid ${C.down}` : '3px solid transparent',
    }}>
      {!compact && <AppMenuButton/>}

      <SymbolPicker compact={compact}/>

      {/* 지금 어느 시장에 있는지 모르면 '매도'를 누르며 파는 줄 알고
          숏을 연다. 종목 바로 옆에 둔다. */}
      {!compact && <MarketSwitch value={marketType} onChange={setMarketType}/>}
      {/* 모의/테스트넷/실전. 좁을 때도 뺄 수 없다 — 이 값만 '진짜 돈인가'를 정한다 */}
      <div style={{ minWidth: 190 }}><TradeModeSwitch compact/></div>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 1,
        minWidth: 0, flex: compact ? 1 : undefined, overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <span style={{
            ...NUM, color: pnlColor(chg), fontWeight: 700,
            fontSize: compact ? FS.lead : FS.num,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{fmtPrice(px)}</span>
          {chg != null && (
            <span style={{
              ...NUM, color: pnlColor(chg), fontSize: FS.micro,
              fontWeight: 600, whiteSpace: 'nowrap',
            }}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
          )}
        </div>
        {/* 이 숫자가 어디서 온 값인지. 크게만 띄우고 출처를 안 쓰면
            멈춘 값을 실시간으로 오인한다.
            좁은 화면에서도 지우지 않는다 — 출처를 지우면 그 순간
            "가짜를 진짜처럼 보여주던" 상태로 돌아간다. 대신 짧게 쓴다. */}
        <div style={{ overflow: 'hidden' }}>
          <DataBadge compact source={{
            kind: live ? 'REALTIME' : 'UNAVAILABLE',
            origin: compact ? '' : 'Binance', asOf: stream.priceAt, expectedIntervalMs: 100,
          }}/>
        </div>
      </div>

      {!compact && <div style={{ flex: 1 }}/>}

      {right}

      {!compact && (
        <div style={{ textAlign: 'right', lineHeight: 1.3 }}>
          <div style={{ color: C.faint, fontSize: FS.micro }}>선물 잔고</div>
          <div style={{ ...NUM, color: C.text, fontSize: FS.body, fontWeight: 600 }}>
            {balance != null ? `${fmtPrice(balance)} USDT` : '—'}
          </div>
        </div>
      )}

      {/* 운영 모드 — 모름을 안전으로 표시하지 않는다.
          좁은 화면에서는 글자 대신 점으로. 자리는 안 먹되 색은 남는다. */}
      {compact ? (
        <span
          title={mode.unknown ? '운영 모드 확인 불가' : mode.label}
          style={{
            width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
            background: mode.unknown ? C.warn : mode.realMoney ? C.down : C.up,
            boxShadow: mode.realMoney ? `0 0 0 3px ${C.downBg}` : 'none',
          }}
        />
      ) : (
        <span style={mode.unknown
          ? chip(C.warn, C.warnBg)
          : mode.realMoney ? chip(C.down, C.downBg) : chip(C.dim)}>
          {mode.unknown ? '모드 확인 불가' : mode.label.split(' —')[0]}
        </span>
      )}

      {!compact && (
        <span style={chip(connections.length ? C.dim : C.faint)}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: connections.length ? C.up : C.faint,
          }}/>
          {connections.length ? `거래소 ${connections.length}` : '미연결'}
        </span>
      )}
    </div>
  );
}

export const TopBar = memo(TopBarInner);
