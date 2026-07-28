'use client';
// src/components/terminal/TopBar.tsx
//
// 상단 띠 — 종목 · 가격 · 계좌 · 연결 상태만. 얇게.
//
// 여기에 기능을 더 붙이지 않는다. 상단이 두꺼워지면 차트가 그만큼 줄고,
// 차트는 이 화면에서 가장 오래 보는 곳이다.
//
// 실전/Testnet은 **배경색**으로 구분한다. 글자로만 쓰면 급할 때 안 읽는다.
import React, { memo } from 'react';
import { T } from '@/lib/constants';
import { DataBadge } from '@/components/ui/DataBadge';
import { useTerminal } from './TerminalContext';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';

export const TOPBAR_H = 46;

/** 모드별 상단 띠 색. 실자금일 때만 눈에 띄어야 한다 */
export function modeAccent(realMoney: boolean, unknown: boolean): string {
  if (unknown) return T.muted;
  return realMoney ? T.red : T.acc;
}

function TopBarInner({ balance }: { balance: number | null }) {
  const { symbol, symbols, setSymbol, mode, connections } = useTerminal();
  const stream = useBinanceStream(symbol.id, true);

  const px = stream.lastPrice;
  const chg = stream.changePct;
  const accent = modeAccent(mode.realMoney, mode.unknown);

  return (
    <div style={{
      height: TOPBAR_H, display: 'flex', alignItems: 'center', gap: 14,
      padding: '0 12px', borderBottom: `1px solid ${T.border}`,
      // 실자금이면 상단 전체가 붉게 물든다. 화면 어디를 보고 있어도 주변시에 들어온다.
      background: mode.realMoney ? '#2A0E12' : T.card,
      flexShrink: 0,
    }}>
      <span style={{ color: T.acl, fontWeight: 900, fontSize: 14, letterSpacing: -0.5 }}>TRAIGO</span>
      <span style={{ color: T.muted, fontSize: 9 }}>Pro 터미널</span>

      {/* 종목 — 차트와 주문이 함께 따라간다 */}
      <select
        value={symbol.id}
        onChange={e => {
          const s = symbols.find(x => x.id === e.target.value);
          if (s) setSymbol(s);
        }}
        style={{
          background: T.alt, color: T.txt, border: `1px solid ${T.border2}`,
          borderRadius: 6, padding: '4px 8px', fontSize: 12, fontWeight: 800, cursor: 'pointer',
        }}
      >
        {symbols.map(s => <option key={s.id} value={s.id}>{s.display}</option>)}
      </select>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{
          color: (chg ?? 0) >= 0 ? T.grn : T.red, fontWeight: 900, fontSize: 15,
          fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums',
        }}>
          {px != null ? px.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
        </span>
        <span style={{ color: T.muted, fontSize: 9 }}>USDT</span>
        {chg != null && (
          <span style={{ color: chg >= 0 ? T.grn : T.red, fontSize: 11, fontWeight: 700 }}>
            {chg >= 0 ? '▲' : '▼'}{Math.abs(chg).toFixed(2)}%
          </span>
        )}
      </div>

      {/* 이 가격이 어디서 온 값인지. 숫자만 크게 띄우고 출처를 안 쓰면
          멈춘 값을 실시간으로 오인한다. */}
      <DataBadge compact source={{
        kind: stream.status === 'live' && !stream.stale ? 'REALTIME' : 'UNAVAILABLE',
        origin: 'Binance 선물', asOf: stream.priceAt, expectedIntervalMs: 100,
      }}/>

      <div style={{ flex: 1 }}/>

      <div style={{ textAlign: 'right', lineHeight: 1.25 }}>
        <div style={{ color: T.muted, fontSize: 8 }}>선물 잔고</div>
        <div style={{
          color: T.txt, fontSize: 12, fontWeight: 800,
          fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums',
        }}>
          {balance != null ? `${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT` : '—'}
        </div>
      </div>

      {/* 운영 모드 — 모름을 안전으로 표시하지 않는다 */}
      <span style={{
        padding: '3px 9px', borderRadius: 6, fontSize: 10, fontWeight: 800,
        color: accent, border: `1px solid ${accent}`,
        background: mode.realMoney ? T.red + '18' : 'transparent',
      }}>
        {mode.unknown ? '모드 ?' : mode.label.split(' —')[0]}
      </span>

      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 10, color: connections.length ? T.grn : T.muted,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: connections.length ? T.grn : T.muted,
        }}/>
        {connections.length ? `거래소 ${connections.length}` : '거래소 미연결'}
      </span>
    </div>
  );
}

// 잔고 외에는 컨텍스트와 스트림만 본다. 좌측 뉴스가 갱신돼도 여기는 안 흔들린다.
export const TopBar = memo(TopBarInner);
