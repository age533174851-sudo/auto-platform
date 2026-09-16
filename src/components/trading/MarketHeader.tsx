'use client';
// src/components/trading/MarketHeader.tsx
//
// 거래 화면 맨 위 한 줄: **무엇을 · 어느 장부로 · 얼마에** 보고 있는가.
//
//   BTCUSDT · Perpetual · [PAPER]
//   65,432.10   +1.24%
//   Mark 65,430.5 · 24h High 66,100 · 24h Low 64,200 · 24h Vol(USDT) 1.23B
//
// 여기서 지키는 것
// ────────────────
//  · 값은 전부 `useBinanceStream`이 **관측한 것**이다. 이 파일은 계산하지
//    않는다. 24시간 통계는 이미 받고 있던 ticker 응답에서 나오므로 요청이
//    늘지 않는다.
//  · 못 받은 칸은 `—`다. 0이 아니다 (`marketStats`).
//  · 현물에는 Mark 칸이 아예 없다 — 없는 개념과 못 받은 값은 다르다.
//  · 장부 배지는 `paperTarget`이 정한 값을 그대로 보여준다. 여기서 장부를
//    고르거나 바꾸지 않는다.
import React from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import {
  marketStatCells, fmtStatPrice, fmtChangePct, changeTone, UNKNOWN_TEXT,
} from '@/lib/trading/marketStats';
import type { StreamState } from '@/lib/hooks/useBinanceStream';
import type { PaperTarget } from '@/lib/trading/paperTarget';

export interface MarketHeaderProps {
  symbol: string;
  market: 'SPOT' | 'USDM';
  stream: StreamState;
  /** 모의 장부. 없으면 배지를 그리지 않는다 (실거래 화면 등) */
  target?: PaperTarget | null;
  quoteAsset?: string;
  onSymbolClick?: () => void;
  compact?: boolean;
}

const TONE_COLOR: Record<string, string> = {
  UP: C.up, DOWN: C.down, FLAT: C.dim, UNKNOWN: C.faint,
};

export function MarketHeader({
  symbol, market, stream, target, quoteAsset,
  onSymbolClick, compact,
}: MarketHeaderProps) {
  const price = stream.lastPrice;
  const tone = changeTone(stream.changePct);

  const cells = marketStatCells({
    market,
    markPrice: stream.markPrice,
    high24h: stream.high24h,
    low24h: stream.low24h,
    volume24h: stream.volume24h,
    quoteVolume24h: stream.quoteVolume24h,
    quoteAsset,
  });

  // 스트림이 붙긴 했는데 값이 안 오는 상태를 숨기지 않는다.
  const stalled = stream.stale || stream.status === 'reconnecting' || stream.status === 'error';

  return (
    <div
      data-testid="market-header"
      data-market={market}
      style={{
        display: 'flex', flexDirection: 'column', gap: compact ? 5 : 6,
        padding: compact ? '10px 12px 8px' : '10px 14px',
        borderBottom: `1px solid ${C.hair}`,
        background: C.panel,
      }}
    >
      {/* ── 1줄: 종목 · 시장 · 장부 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onSymbolClick}
          disabled={!onSymbolClick}
          data-testid="market-header-symbol"
          style={{
            background: 'none', border: 'none', padding: 0,
            // 실기에서 화면 위쪽이 메뉴·AI뉴스·STOP으로 차 있어 **무엇을 보는
            // 중인지가 묻혔다.** 차트 바로 위에서 종목이 가장 크게 읽혀야 한다.
            color: C.text, fontSize: compact ? 19 : FS.head, fontWeight: 800,
            cursor: onSymbolClick ? 'pointer' : 'default', letterSpacing: '-0.02em',
          }}
        >
          {symbol}
          {onSymbolClick ? <span style={{ color: C.dim, fontSize: FS.small, marginLeft: 4 }}>▾</span> : null}
        </button>

        <span
          data-testid="market-header-kind"
          style={{
            fontSize: FS.micro, fontWeight: 700, color: C.dim,
            border: `1px solid ${C.hair}`, borderRadius: 4, padding: '2px 6px',
            letterSpacing: '0.04em',
          }}
        >
          {market === 'USDM' ? 'Perpetual' : 'Spot'}
        </span>

        {target ? (
          <span
            data-testid="market-header-ledger"
            data-ledger={target.kind}
            title={
              target.kind === 'CHALLENGE'
                ? '이 화면의 주문은 챌린지 전용 장부로 들어갑니다'
                : '이 화면의 주문은 기본 모의 장부로 들어갑니다'
            }
            style={{
              fontSize: FS.micro, fontWeight: 800,
              color: target.kind === 'CHALLENGE' ? C.warn : C.accent,
              background: target.kind === 'CHALLENGE' ? C.warnBg : C.accentBg,
              borderRadius: 4, padding: '2px 6px', letterSpacing: '0.04em',
            }}
          >
            {/* 챌린지에는 이름 칸이 없다(`paper_challenges`). 없는 값을
                채워 넣지 않는다 — 배지는 어느 장부인지만 말한다. */}
            {target.kind === 'CHALLENGE' ? 'CHALLENGE' : 'PAPER'}
          </span>
        ) : null}

        {stalled ? (
          <span
            data-testid="market-header-stalled"
            title={stream.error || '시세가 갱신되지 않고 있습니다'}
            style={{ fontSize: FS.micro, fontWeight: 700, color: C.warn }}
          >
            ● 지연
          </span>
        ) : null}
      </div>

      {/* ── 2줄: 현재가 · 변동률 ── */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span
          data-testid="market-header-price"
          style={{
            ...NUM,
            fontSize: compact ? 26 : 24, fontWeight: 800,
            color: price == null ? C.faint : TONE_COLOR[tone] || C.text,
          }}
        >
          {fmtStatPrice(price)}
        </span>
        <span
          data-testid="market-header-change"
          style={{ ...NUM, fontSize: compact ? FS.sub : FS.lead, fontWeight: 800, color: TONE_COLOR[tone] }}
        >
          {fmtChangePct(stream.changePct)}
        </span>
      </div>

      {/* ── 3줄: Mark · 24h ── */}
      <div
        data-testid="market-header-stats"
        style={{
          display: 'flex', gap: compact ? 12 : 18, flexWrap: 'wrap',
          fontSize: FS.micro,
        }}
      >
        {cells.map(c => (
          <span key={c.label} style={{ display: 'flex', gap: 4, alignItems: 'baseline' }}>
            <span style={{ color: C.faint }}>{c.label}</span>
            <span
              style={{ ...NUM, color: c.unknown ? C.faint : C.dim, fontWeight: 600 }}
              title={c.unknown ? '아직 받지 못한 값입니다 (0이 아닙니다)' : undefined}
            >
              {c.text}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export { UNKNOWN_TEXT };
