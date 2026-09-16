'use client';
// src/components/trading/TradingWorkspace.tsx
//
// **거래 화면 한 판.** 헤더 · 차트 · 호가 · 주문이 한 곳에 있다.
//
// 무엇을 고치는가
// ───────────────
// 지금까지 "모의투자"라고 적힌 화면이 여럿이었고, 차트는 남의 iframe이고,
// 호가창은 아래로 밀려 스크롤 밖에 있었다. 여기서는
//
//   · 봉은 `/api/market/candles`(= `fetchVenueBars`)에서 받아 우리가 그린다
//   · 호가는 **늘 보인다** — 접히지 않고, 주문 옆에 고정된다
//   · 장부는 서버 PAPER/Paper Challenge 하나다 (`paperTarget`)
//   · 수량은 가용 잔고의 **증거금 배정 비율**로 정한다
//
// 데스크톱과 모바일
// ─────────────────
// 판은 하나다. 데스크톱은 차트 옆에 주문이 서고, 모바일은 차트가 주인공이며
// 하단 LONG/SHORT를 누르면 같은 `TradeSheet`가 올라온다 — **두 화면의 주문
// 규칙이 갈릴 수 없다.**
import React, { useEffect, useMemo, useState } from 'react';
import { C, FS } from '@/components/terminal/theme';
import { MarketHeader } from './MarketHeader';
import { PriceChart, type ChartInterval } from './PriceChart';
import { OrderBookView } from './OrderBookView';
import { TradeSheet } from './TradeSheet';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';
import { usePaperLedger } from '@/lib/trading/usePaperLedger';
import { usePaperTarget } from '@/lib/trading/usePaperTarget';
import { targetOrderGate } from '@/lib/trading/paperTarget';
import { paperOrderUiWiring } from '@/lib/trading/capability';
import type { IndicatorId } from '@/lib/trading/indicators';
import type { MoneyScope } from '@/lib/trading/gameMoney';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT'];

export interface TradingWorkspaceProps {
  /** 모바일 배치로 그릴 것인가. 없으면 화면 폭으로 정한다 */
  mobile?: boolean;
  initialSymbol?: string;
  initialMarket?: 'SPOT' | 'USDM';
}

export function TradingWorkspace({ mobile, initialSymbol, initialMarket }: TradingWorkspaceProps) {
  const [symbol, setSymbol] = useState(initialSymbol || 'BTCUSDT');
  const [market, setMarket] = useState<'SPOT' | 'USDM'>(initialMarket || 'USDM');
  const [interval, setInterval] = useState<ChartInterval>('15m');
  const [indicators, setIndicators] = useState<IndicatorId[]>(['MA7', 'MA25']);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [narrow, setNarrow] = useState(!!mobile);

  useEffect(() => {
    if (mobile !== undefined) { setNarrow(mobile); return; }
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 820px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [mobile]);

  const stream = useBinanceStream(symbol, true, market);
  const [target] = usePaperTarget();
  const ledger = usePaperLedger(target);

  // 챌린지를 고르고 있으면 그 상태를 읽어 주문 가능 여부를 정한다.
  // **모르면 못 낸다** — 확인하지 못한 것은 통과가 아니다.
  const [challengeStatus, setChallengeStatus] = useState<string | null>(null);
  useEffect(() => {
    if (target.kind !== 'CHALLENGE' || !target.challengeId) {
      setChallengeStatus(null); return;
    }
    let cancelled = false;
    setChallengeStatus(null);
    (async () => {
      try {
        let auth: Record<string, string> = {};
        try {
          const { getSupabaseClient } = await import('@/lib/supabase/client');
          const sb = getSupabaseClient();
          if (sb) {
            const { data } = await sb.auth.getSession();
            const t = data?.session?.access_token;
            if (t) auth = { Authorization: `Bearer ${t}` };
          }
        } catch { /* 익명이면 서버가 막는다 */ }
        const r = await fetch(`/api/paper/challenge/${target.challengeId}`, {
          headers: auth, cache: 'no-store',
        });
        const d = await r.json().catch(() => null);
        if (cancelled) return;
        // **읽지 못하면 상태를 지어내지 않는다.** null이면 게이트가 막는다.
        setChallengeStatus(r.ok && d?.ok ? String(d.challenge?.status ?? '') || null : null);
      } catch { if (!cancelled) setChallengeStatus(null); }
    })();
    return () => { cancelled = true; };
  }, [target.kind, target.challengeId]);

  const gate = targetOrderGate(target, challengeStatus);
  const wiring = paperOrderUiWiring(market);
  const canOrder = gate.allowed && wiring.canOrder;
  const blockedReason = !wiring.canOrder ? wiring.reason : !gate.allowed ? gate.reason : null;

  const scope: MoneyScope = target.kind === 'CHALLENGE' ? 'CHALLENGE' : 'PAPER';

  const header = (
    <MarketHeader
      symbol={symbol} market={market} stream={stream}
      target={target}
      compact={narrow}
    />
  );

  const controls = (
    <div style={{ display: 'flex', gap: 6, padding: '8px 12px', flexWrap: 'wrap',
      borderBottom: `1px solid ${C.hair}`, background: C.panel }}>
      <select
        value={symbol} onChange={e => setSymbol(e.target.value)}
        data-testid="workspace-symbol"
        style={selectStyle}
      >
        {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      {(['USDM', 'SPOT'] as const).map(m => (
        <button key={m} type="button" onClick={() => setMarket(m)}
          data-testid={`workspace-market-${m}`}
          style={{
            padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
            border: `1px solid ${market === m ? C.accent : C.hair}`,
            background: market === m ? C.accentBg : C.raised,
            color: market === m ? C.accent : C.dim,
            fontSize: FS.micro, fontWeight: 700,
          }}>{m === 'USDM' ? '선물' : '현물'}</button>
      ))}
    </div>
  );

  const chart = (
    <PriceChart
      symbol={symbol} market={market}
      interval={interval} onIntervalChange={setInterval}
      indicators={indicators}
      onToggleIndicator={(id) => setIndicators(prev =>
        prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
      height={narrow ? 260 : 420}
    />
  );

  const sheet = (
    <TradeSheet
      symbol={symbol} market={market}
      price={stream.lastPrice}
      target={target} scope={scope}
      availableBalance={ledger.available}
      availableUnknownReason={ledger.availableUnknownReason || ledger.error}
      canOrder={canOrder}
      blockedReason={blockedReason}
      onSubmitted={ledger.reload}
      onClose={narrow ? () => setSheetOpen(false) : undefined}
      compact={narrow}
    />
  );

  // ══════════════ 모바일 ══════════════
  if (narrow) {
    return (
      <div data-testid="trading-workspace" data-layout="mobile"
        style={{ display: 'flex', flexDirection: 'column', background: C.bg,
          // 하단 고정 CTA가 마지막 줄을 가리지 않게 자리를 비운다
          paddingBottom: 'calc(var(--nav-h, 0px) + 76px)', position: 'relative' }}>
        {header}
        {controls}
        {/* 차트가 주인공이다 */}
        {chart}
        {/* 호가는 접지 않는다 — 시장을 안 보고 누르는 상태를 만들지 않는다 */}
        <div data-testid="workspace-book"
          style={{ borderTop: `1px solid ${C.hair}`, background: C.panel }}>
          <OrderBookView symbolId={symbol} market={market} rows={5} dense/>
        </div>

        {/* 하단 고정 LONG / SHORT */}
        <div
          data-testid="workspace-cta"
          style={{
            // **앱의 하단 탭바 위에 앉는다.** `bottom: 0`으로 두면 탭바에
            // 가려져서 실측 스크린샷에서 초록·빨강 띠만 삐져나와 있었다 —
            // 버튼이 있는데 누를 수 없는 상태다. 높이는 전역 `--nav-h`가 안다.
            position: 'fixed', left: 0, right: 0, bottom: 'var(--nav-h, 0px)', zIndex: 40,
            display: 'flex', gap: 8, padding: '10px 12px',
            background: C.panel, borderTop: `1px solid ${C.hair}`,
          }}
        >
          <CtaBtn label={market === 'SPOT' ? 'BUY' : 'LONG'} tone="up" onClick={() => setSheetOpen(true)}/>
          <CtaBtn label={market === 'SPOT' ? 'SELL' : 'SHORT'} tone="down" onClick={() => setSheetOpen(true)}/>
        </div>

        {sheetOpen ? (
          <div
            data-testid="workspace-sheet"
            style={{
              position: 'fixed', inset: 0, zIndex: 50,
              background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end',
            }}
            onClick={() => setSheetOpen(false)}
          >
            <div onClick={e => e.stopPropagation()}
              style={{ width: '100%', maxHeight: '88vh', overflowY: 'auto',
                paddingBottom: 'var(--nav-h, 0px)',
                borderTopLeftRadius: 14, borderTopRightRadius: 14, background: C.panel }}>
              {sheet}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  // ══════════════ 데스크톱 ══════════════
  return (
    <div data-testid="trading-workspace" data-layout="desktop"
      style={{ display: 'flex', flexDirection: 'column', background: C.bg,
        border: `1px solid ${C.hair}`, borderRadius: 12, overflow: 'hidden' }}>
      {header}
      {controls}
      <div style={{ display: 'flex', alignItems: 'stretch', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>{chart}</div>
        {/* 호가는 **차트 옆에 고정**이다. 아래로 밀면 스크롤 밖으로 나간다 */}
        <div
          data-testid="workspace-book"
          style={{ width: 210, flexShrink: 0, borderLeft: `1px solid ${C.hair}`, background: C.panel }}
        >
          <OrderBookView symbolId={symbol} market={market} rows={11} dense/>
        </div>
        <div style={{ width: 330, flexShrink: 0, borderLeft: `1px solid ${C.hair}`, overflowY: 'auto' }}>
          {sheet}
        </div>
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: C.raised, color: C.text, border: `1px solid ${C.hair}`,
  borderRadius: 6, padding: '5px 8px', fontSize: FS.micro, fontWeight: 700,
  outline: 'none', cursor: 'pointer',
};

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
