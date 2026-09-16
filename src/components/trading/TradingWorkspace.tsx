'use client';
// src/components/trading/TradingWorkspace.tsx
//
// **매매 탭의 정본 거래 화면.**
//
// 왜 다시 쓰는가
// ──────────────
// 처음에 이 컴포넌트를 `모의매매` 탭(`PaperTradingPage`)에 붙였다. 그런데
// 사용자가 실제로 여는 길은 `/ → 매매`이고, 그건
// `TerminalTab → TerminalShell → MobileShell`이다. 즉 **만들어 놓고 사람이
// 다니는 길에 안 붙였다.** 실제 기기 스크린샷에서 드러났다.
//
// 그래서 이 컴포넌트는 이제 **받은 값으로만** 그린다. 종목·시장·모드를
// 스스로 고르지 않고 터미널이 이미 아는 값을 받는다 — 화면이 두 개의
// "지금 무엇을 보는가"를 갖는 순간 둘은 갈린다.
//
// 첫 화면의 순서
// ──────────────
//   시장 정보 → 차트 → 거래 버튼
//
// 예전 모바일 첫 화면은 `[58% 주문폼 │ 42% 호가]`였다. 차트는 맨 아래에
// 접혀 있었다. 차트를 보고 들어가는 화면이 아니라 주문폼을 채우는 화면이다.
// 호가와 상세 주문은 **버튼을 누른 뒤** 시트에서 본다.
//
// 실거래는 건드리지 않는다
// ────────────────────────
// 모의(`mock`)만 `TradeSheet`가 주문을 맡는다. 테스트넷·실전은 기존
// 주문폼(`exchangeOrderPane`)이 같은 시트 안에서 그대로 열린다 —
// 껍데기만 수렴시키고 실거래 payload·검증·라우팅은 0으로 둔다.
import React, { useState } from 'react';
import { C, FS } from '@/components/terminal/theme';
import { MarketHeader } from './MarketHeader';
import { PriceChart, type ChartInterval } from './PriceChart';
import { TradeSheet } from './TradeSheet';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';
import { usePaperLedger } from '@/lib/trading/usePaperLedger';
import { usePaperTarget } from '@/lib/trading/usePaperTarget';
import {
  targetOrderGate, paperSheetHandlesOrders, type PaperTarget,
} from '@/lib/trading/paperTarget';
import { paperOrderUiWiring } from '@/lib/trading/capability';
import type { IndicatorId } from '@/lib/trading/indicators';
import type { MoneyScope } from '@/lib/trading/gameMoney';

export interface TradingWorkspaceProps {
  symbol: string;
  /** 모의 장부가 아는 시장. 터미널 어휘는 `canonicalMarketOf`가 옮긴다 */
  market: 'SPOT' | 'USDM';
  /** 'mock' | 'testnet' | 'live' — 주문을 누가 맡을지 정한다 */
  tradeMode: string;
  /** 로그인 토큰. 빈 값이면 로그인 전이다 */
  auth?: string;
  /** 종목을 바꾸는 길. 없으면 종목 이름이 버튼이 아니다 */
  onSymbolClick?: () => void;
  /**
   * 테스트넷·실전에서 시트에 들어갈 **기존** 주문폼.
   * 여기서 실거래 주문을 새로 만들지 않는다.
   */
  exchangeOrderPane?: React.ReactNode;
  chartHeight?: number;
  /** 하단 고정 버튼이 앱 탭바 위에 앉도록 띄울 높이 */
  ctaBottom?: string | number;
}

export function TradingWorkspace({
  symbol, market, tradeMode, auth, onSymbolClick,
  exchangeOrderPane, chartHeight = 300, ctaBottom = 'var(--nav-h, 0px)',
}: TradingWorkspaceProps) {
  const [interval, setInterval] = useState<ChartInterval>('15m');
  const [indicators, setIndicators] = useState<IndicatorId[]>(['MA7', 'MA25']);
  const [sheetOpen, setSheetOpen] = useState(false);

  const stream = useBinanceStream(symbol, true, market);
  const [target] = usePaperTarget();

  // 모의일 때만 장부를 읽는다. 실전 화면에서 모의 잔고를 읽어 봐야
  // 그 숫자는 이 화면의 주문과 아무 상관이 없다.
  const paperOrders = paperSheetHandlesOrders(tradeMode);
  const ledger = usePaperLedger(target, paperOrders);

  const gate = targetOrderGate(target, useChallengeStatus(target, auth));
  const wiring = paperOrderUiWiring(market);
  const canOrder = paperOrders && gate.allowed && wiring.canOrder;

  // **원인을 숨기지 않는다.** 예전에는 `확인 불가` 한 마디였고, 그걸 보고
  // 무엇을 해야 하는지 알 수 없었다. 값을 지어내지는 않되 사유는 말한다.
  const blockedReason = !paperOrders ? null
    : !auth ? '로그인이 필요합니다 — 로그인 후 모의 잔고를 확인할 수 있습니다'
    : !wiring.canOrder ? wiring.reason
    : !gate.allowed ? gate.reason
    : null;

  const scope: MoneyScope = target.kind === 'CHALLENGE' ? 'CHALLENGE' : 'PAPER';
  const longLabel = market === 'SPOT' ? 'BUY' : 'LONG';
  const shortLabel = market === 'SPOT' ? 'SELL' : 'SHORT';

  const sheetBody = paperOrders ? (
    <TradeSheet
      symbol={symbol} market={market}
      price={stream.lastPrice}
      target={target} scope={scope}
      availableBalance={auth ? ledger.available : null}
      availableUnknownReason={
        !auth
          ? '로그인이 필요합니다 — 로그인 후 모의 잔고를 확인할 수 있습니다'
          : (ledger.availableUnknownReason || ledger.error)
      }
      canOrder={canOrder}
      blockedReason={blockedReason}
      onSubmitted={ledger.reload}
      onClose={() => setSheetOpen(false)}
      compact
    />
  ) : (
    // 테스트넷·실전 — **기존 주문폼 그대로.** 껍데기만 같은 시트다.
    <div data-testid="exchange-order-sheet" style={{ padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: FS.sub, fontWeight: 800, color: C.text }}>{symbol} 주문</span>
        <button type="button" onClick={() => setSheetOpen(false)} className="switch"
          style={{ background: 'none', border: 'none', color: C.dim, fontSize: FS.title, cursor: 'pointer' }}>✕</button>
      </div>
      {exchangeOrderPane}
    </div>
  );

  return (
    <div
      data-testid="trading-workspace" data-layout="mobile" data-trade-mode={tradeMode}
      style={{ display: 'flex', flexDirection: 'column', background: C.bg }}
    >
      {/* ① 시장 정보 */}
      <MarketHeader
        symbol={symbol} market={market} stream={stream}
        target={paperOrders ? target : null}
        onSymbolClick={onSymbolClick}
        compact
      />

      {/* ② 차트가 주인공이다 — 시간대·캔들·거래량·이동평균 */}
      <PriceChart
        symbol={symbol} market={market}
        interval={interval} onIntervalChange={setInterval}
        indicators={indicators}
        onToggleIndicator={(id) => setIndicators(prev =>
          prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
        height={chartHeight}
      />

      {/* ③ 거래 버튼 — 화면에 붙어 있다 */}
      <div
        data-testid="workspace-cta"
        style={{
          position: 'sticky', bottom: ctaBottom as any, zIndex: 30,
          display: 'flex', gap: 8, padding: '10px 12px',
          background: C.panel, borderTop: `1px solid ${C.hair}`,
        }}
      >
        <CtaBtn label={longLabel} tone="up" onClick={() => setSheetOpen(true)}/>
        <CtaBtn label={shortLabel} tone="down" onClick={() => setSheetOpen(true)}/>
      </div>

      {sheetOpen ? (
        <div
          data-testid="workspace-sheet"
          style={{
            position: 'fixed', inset: 0, zIndex: 60,
            background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end',
          }}
          onClick={() => setSheetOpen(false)}
        >
          <div onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxHeight: '88vh', overflowY: 'auto',
              paddingBottom: 'var(--nav-h, 0px)',
              borderTopLeftRadius: 14, borderTopRightRadius: 14, background: C.panel,
            }}>
            {sheetBody}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 고른 챌린지가 지금 주문을 받는가.
 *
 * **못 읽으면 `null`이다.** `targetOrderGate`가 그걸 "확인하지 못함"으로
 * 읽어 주문을 막는다 — 모르는 것을 통과로 적지 않는다.
 */
function useChallengeStatus(target: PaperTarget, auth?: string): string | null {
  const [status, setStatus] = useState<string | null>(null);
  const id = target?.kind === 'CHALLENGE' ? target.challengeId : null;

  React.useEffect(() => {
    if (!id) { setStatus(null); return; }
    let cancelled = false;
    setStatus(null);
    (async () => {
      try {
        const r = await fetch(`/api/paper/challenge/${id}`, {
          headers: auth ? { Authorization: auth } : {}, cache: 'no-store',
        });
        const d = await r.json().catch(() => null);
        if (cancelled) return;
        setStatus(r.ok && d?.ok ? (String(d.challenge?.status ?? '') || null) : null);
      } catch { if (!cancelled) setStatus(null); }
    })();
    return () => { cancelled = true; };
  }, [id, auth]);

  return status;
}

function CtaBtn({ label, tone, onClick }: { label: string; tone: 'up' | 'down'; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick}
      data-testid={`workspace-cta-${label}`}
      style={{
        flex: 1, padding: '14px 0', borderRadius: 10, border: 'none',
        background: tone === 'up' ? C.up : C.down, color: '#fff',
        fontSize: FS.sub, fontWeight: 800, cursor: 'pointer',
      }}
    >{label}</button>
  );
}
