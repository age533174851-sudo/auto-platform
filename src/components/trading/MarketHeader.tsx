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
  /**
   * 한 화면 배치용 — **줄을 합친다.**
   *
   * 실측에서 이 헤더가 127px을 먹었고, 그 위 터미널 헤더 85px과 합쳐
   * 차트가 시작하기 전에 212px이 사라졌다. 360×660에서는 화면의 3분의 1이다.
   * 종목·현재가·등락률을 한 줄로, 24시간 통계를 그 아래 한 줄로 줄인다.
   */
  dense?: boolean;
}

const TONE_COLOR: Record<string, string> = {
  UP: C.up, DOWN: C.down, FLAT: C.dim, UNKNOWN: C.faint,
};

export function MarketHeader({
  symbol, market, stream, target, quoteAsset,
  onSymbolClick, compact, dense,
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
        display: 'flex', flexDirection: 'column', gap: dense ? 3 : compact ? 5 : 6,
        padding: dense ? '6px 10px 5px' : compact ? '10px 12px 8px' : '10px 14px',
        borderBottom: `1px solid ${C.hair}`,
        background: C.panel,
      }}
    >
      {/* ── 1줄: 종목 · 시장 · 장부 (dense면 가격까지 같은 줄) ── */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: dense ? 6 : 8, flexWrap: 'wrap', minWidth: 0 }}>
        <button
          type="button"
          onClick={onSymbolClick}
          disabled={!onSymbolClick}
          data-testid="market-header-symbol"
          style={{
            background: 'none', border: 'none', padding: 0,
            // 실기에서 화면 위쪽이 메뉴·AI뉴스·STOP으로 차 있어 **무엇을 보는
            // 중인지가 묻혔다.** 차트 바로 위에서 종목이 가장 크게 읽혀야 한다.
            color: C.text, fontSize: dense ? 17 : compact ? 19 : FS.head, fontWeight: 800,
            cursor: onSymbolClick ? 'pointer' : 'default', letterSpacing: '-0.02em',
          }}
        >
          {symbol}
          {onSymbolClick ? <span style={{ color: C.dim, fontSize: FS.small, marginLeft: 4 }}>▾</span> : null}
        </button>

        {/* dense에서는 이 배지가 아래 줄로 내려간다.
            320px 실측에서 이 줄이 두 줄로 접혀 **헤더가 106px**이 됐고,
            통이 고정 높이라 그 32px만큼 아래 칸이 잘렸다. 종목·현재가·
            등락률이 한 줄에 남는 것이 시장 종류 배지보다 먼저다. */}
        {dense ? null : <KindBadge market={market}/>}

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

        {dense ? (
          <>
            <div style={{ flex: 1, minWidth: 4 }}/>
            <span data-testid="market-header-price" style={{
              ...NUM, fontSize: 17, fontWeight: 800,
              color: price == null ? C.faint : TONE_COLOR[tone] || C.text,
            }}>{fmtStatPrice(price)}</span>
            <span data-testid="market-header-change" style={{
              ...NUM, fontSize: FS.micro, fontWeight: 800, color: TONE_COLOR[tone],
            }}>{fmtChangePct(stream.changePct)}</span>
          </>
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

      {/* ── 2줄: 현재가 · 변동률 (dense면 위 줄로 올라갔다) ── */}
      {dense ? null : (
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
      )}

      {/* ── 3줄: Mark · 24h ── */}
      <div
        data-testid="market-header-stats"
        style={{
          display: 'flex', gap: compact ? 12 : 18, flexWrap: 'wrap',
          fontSize: FS.micro,
        }}
      >
        {dense ? <KindBadge market={market} dense/> : null}
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

/** 선물인가 현물인가. dense에서는 24시간 통계 줄로 내려간다. */
function KindBadge({ market, dense }: { market: 'SPOT' | 'USDM'; dense?: boolean }) {
  // dense에서는 테두리를 벗고 짧게 쓴다. 320px 실측에서 `Perpetual` 배지가
  // 61px이었고, 그 61px 때문에 24시간 통계 줄이 두 줄로 접혀 **헤더가
  // 105px**이 됐다. 통이 고정 높이라 그 31px은 아래 칸에서 빠진다.
  return (
    <span
      data-testid="market-header-kind"
      title={market === 'USDM' ? 'Perpetual (무기한 선물)' : 'Spot (현물)'}
      style={{
        fontSize: FS.micro, fontWeight: 700, color: C.dim, flexShrink: 0,
        letterSpacing: '0.04em', whiteSpace: 'nowrap',
        ...(dense ? null : {
          border: `1px solid ${C.hair}`, borderRadius: 4, padding: '1px 5px',
        }),
      }}
    >
      {dense ? (market === 'USDM' ? 'PERP' : 'SPOT') : (market === 'USDM' ? 'Perpetual' : 'Spot')}
    </span>
  );
}

export { UNKNOWN_TEXT };
