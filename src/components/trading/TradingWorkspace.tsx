'use client';
// src/components/trading/TradingWorkspace.tsx
//
// **매매 탭의 정본 거래 화면 — 한 화면에서 끝난다.**
//
//   시장 정보
//   시간대 · 지표
//   ───── 캔들 차트 (항상 보인다) ─────
//   주문 조작 (60%)  │  호가 (40%)
//   LONG            │  SHORT
//   포지션 · 주문 · 자산
//
// 왜 시트를 버렸나
// ────────────────
// LONG을 누르면 시트가 올라오는 구조였다. 실기(360×660)에서 시트를 열면
// **캔들이 52px만 남았고 그 띠는 배경과 격자선뿐이었다.** 차트를 보고
// 들어가라고 만든 화면인데 주문하려는 순간 차트가 사라졌다.
//
// 시트를 없애면 52vh·88vh·visual viewport·오버레이 겹침·z-index 문제가
// **통째로** 없어진다. 여닫는 층이 아예 없기 때문이다.
//
// 스크롤 0을 절대조건으로 두지 않는다
// ───────────────────────────────────
// 320px 기기에서 전부를 한 화면에 욱여넣으면 글자와 버튼이 작아진다.
// **핵심 거래 영역(시장정보·차트·주문·호가·LONG/SHORT)은 첫 화면에 고정**
// 하고, 포지션 같은 부가 정보는 내리면 나온다.
//
// 권위는 하나다
// ─────────────
// 주문 판정은 `useTradeForm`에 있고 데스크톱이 다른 배치를 써도 그것을
// 쓴다. 증거금·수수료·청산가는 서버가 부르는 `buildPaperPlan` 그대로다.
import React, { useEffect, useState } from 'react';
import { C, FS } from '@/components/terminal/theme';
import { MarketHeader } from './MarketHeader';
import { PriceChart, type ChartInterval } from './PriceChart';
import { OrderBookView } from './OrderBookView';
import { OrderControls, OrderEstimate } from './OrderControls';
import { PositionRow } from './PositionRow';
import { useBinanceStream } from '@/lib/hooks/useBinanceStream';
import { usePaperLedger } from '@/lib/trading/usePaperLedger';
import { usePaperTarget } from '@/lib/trading/usePaperTarget';
import {
  targetOrderGate, paperSheetHandlesOrders, type PaperTarget,
} from '@/lib/trading/paperTarget';
import { paperOrderUiWiring } from '@/lib/trading/capability';
import { useTradeForm } from '@/lib/trading/useTradeForm';
import { splitColumns, coreBudget, BOOK_MIN_PX } from '@/lib/trading/oneScreen';
import type { IndicatorId } from '@/lib/trading/indicators';
import type { MoneyScope } from '@/lib/trading/gameMoney';

export interface TradingWorkspaceProps {
  symbol: string;
  market: 'SPOT' | 'USDM';
  tradeMode: string;
  auth?: string;
  onSymbolClick?: () => void;
  /** 테스트넷·실전에서 쓸 **기존** 주문폼. 실거래 경로를 새로 만들지 않는다 */
  exchangeOrderPane?: React.ReactNode;
  /** 차트에 줄 높이. 바깥이 남는 공간을 재서 넘긴다 */
  chartHeight?: number;
  /**
   * 첫 화면 통의 높이(px).
   *
   * 주면 이 화면이 **그 높이 안에서 끝난다** — 시장정보·차트·주문·호가·
   * 예상값·LONG/SHORT가 통 안의 칸이 되고, 모자란 칸만 제 안에서 스크롤한다.
   * 주지 않으면(데스크톱·가로) 예전처럼 내용 높이대로 흐른다.
   */
  coreHeight?: number;
}

export function TradingWorkspace({
  symbol, market, tradeMode, auth, onSymbolClick,
  exchangeOrderPane, chartHeight = 220, coreHeight,
}: TradingWorkspaceProps) {
  const [interval, setInterval] = useState<ChartInterval>('15m');
  const [indicators, setIndicators] = useState<IndicatorId[]>(['MA7', 'MA25']);
  const [width, setWidth] = useState(360);
  // 시장정보 줄은 종목 이름 길이와 폭에 따라 접힌다(320px에서 실측 106px,
  // 360px에서 74px). 상수로 박으면 접히는 순간 CTA가 화면 밖으로 나간다.
  const [headRef, headH] = useMeasuredHeight<HTMLDivElement>();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const read = () => setWidth(window.innerWidth);
    read();
    window.addEventListener('resize', read);
    window.addEventListener('orientationchange', read);
    return () => {
      window.removeEventListener('resize', read);
      window.removeEventListener('orientationchange', read);
    };
  }, []);

  const stream = useBinanceStream(symbol, true, market);
  const [target] = usePaperTarget();

  const paperOrders = paperSheetHandlesOrders(tradeMode);
  const ledger = usePaperLedger(target, paperOrders);
  const challengeStatus = useChallengeStatus(target, auth);

  const gate = targetOrderGate(target, challengeStatus);
  const wiring = paperOrderUiWiring(market);
  const canOrder = paperOrders && !!auth && gate.allowed && wiring.canOrder;

  // **원인을 숨기지 않는다.** 값을 지어내지 않되 사유는 말한다.
  const blockedReason = !paperOrders ? '이 모드의 주문은 아래 주문폼이 처리합니다'
    : !auth ? '로그인이 필요합니다 — 로그인 후 모의 잔고를 확인할 수 있습니다'
    : !wiring.canOrder ? wiring.reason
    : !gate.allowed ? gate.reason
    : null;

  const scope: MoneyScope = target.kind === 'CHALLENGE' ? 'CHALLENGE' : 'PAPER';
  const availableUnknownReason = !auth
    ? '로그인이 필요합니다 — 로그인 후 모의 잔고를 확인할 수 있습니다'
    : (ledger.availableUnknownReason || ledger.error);

  const form = useTradeForm({
    symbol, market, price: stream.lastPrice, target,
    availableBalance: auth ? ledger.available : null,
    availableUnknownReason,
    canOrder, blockedReason,
    onSubmitted: ledger.reload,
  });

  // 폭은 실측한 최소치가 정한다. 50:50을 박지 않는다 —
  // 호가 한 줄의 글자 폭(가격 53px + 수량 30px)이 바닥을 정한다.
  const cols = splitColumns(width);

  // 세로도 같다. **남는 높이를 나눈다** — 상수로 박은 예산은 320×600에서
  // 틀렸고, 그때 LONG/SHORT가 슬라이더를 덮었다(`coreBudget` 주석).
  // 열린 포지션이 있으면 그 줄도 통 안에 들어간다. **있을 때만** 예산을
  // 쓴다 — 없을 때까지 자리를 비워 두면 평소에 차트가 작아진다.
  const openPositions = paperOrders && auth ? ledger.openPositions : [];
  const bounded = typeof coreHeight === 'number' && coreHeight > 0;
  const budget = coreBudget(coreHeight, headH, openPositions.length > 0);
  // 통이 짧으면 포지션 줄을 통 **밖**에 둔다. 안에 욱여넣으면 그 34px이
  // 호가에서 나가고, 매수 3줄 중 하나가 말없이 밀려 나간다(320×600).
  const rowInside = !bounded || budget.positionInCore;
  const chartPx = bounded ? budget.chartHeight : chartHeight;

  const core = (
    <div
      data-testid="trading-workspace" data-layout="one-screen" data-trade-mode={tradeMode}
      data-bounded={bounded ? '1' : '0'}
      style={{
        display: 'flex', flexDirection: 'column', background: C.bg, minWidth: 0,
        // 통 높이를 받으면 **그 안에서 끝난다.** 넘치면 아래 칸이 밀려
        // 나가는 게 아니라, 모자란 칸이 제 안에서 스크롤한다.
        ...(bounded ? { height: coreHeight, minHeight: 0, overflow: 'hidden' } : null),
      }}
    >
      {/* ① 시장 정보 — 높이를 잰다. 접히면 차트가 그만큼 양보한다 */}
      <div ref={headRef} style={{ flexShrink: 0 }}>
        <MarketHeader
          symbol={symbol} market={market} stream={stream}
          target={paperOrders ? target : null}
          onSymbolClick={onSymbolClick}
          compact dense
        />
      </div>

      {/* ② 차트 — **언제나 보인다.** 주문을 만지는 동안에도 덮이지 않는다 */}
      <div style={{ flexShrink: 0 }}>
        <PriceChart
          symbol={symbol} market={market}
          interval={interval} onIntervalChange={setInterval}
          indicators={indicators}
          onToggleIndicator={(id) => setIndicators(prev =>
            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
          height={chartPx}
          denseToolbar
        />
      </div>

      {/* ③ 주문 │ 호가 — 같은 줄에 상주한다 */}
      {paperOrders ? (
        <div data-testid="workspace-split" style={{
          display: 'flex', alignItems: 'stretch', gap: 6,
          // 세로 여백 4px. 6px이면 320px에서 매수 3번째 줄이 3px 잘렸다 —
          // 스크롤은 됐지만 "매수 3줄이 보인다"는 조건을 못 지킨다.
          padding: '4px 8px', borderTop: `1px solid ${C.hair}`,
          background: C.panel, minWidth: 0,
          // 남는 높이를 다 가져가되 **넘치지 않는다**. `minHeight: 0`이
          // 없으면 flex 칸이 내용 높이만큼 부풀어 CTA를 밀어낸다.
          ...(bounded ? { flex: 1, minHeight: 0 } : null),
        }}>
          {/* ── 주문 칸만 제 스크롤을 갖는다 ──
              이 저장소는 칸마다 스크롤 주는 것을 꺼려 왔다(손가락이 어디
              닿았느냐에 따라 다르게 움직인다). 하지만 `MobileShell`이 이미
              같은 이유로 예외를 뒀다 — 넘친 주문 버튼이 **말없이 사라지는**
              쪽이 훨씬 나쁘다. 320×600에서 실제로 그랬다. */}
          <div
            data-testid="workspace-order-col"
            data-scrolls={bounded && budget.orderScrolls ? '1' : '0'}
            style={{
              width: `${cols.orderPct}%`, minWidth: 0,
              ...(bounded ? {
                minHeight: 0, overflowY: 'auto' as const,
                overscrollBehavior: 'contain' as const,
                WebkitOverflowScrolling: 'touch' as any,
              } : null),
            }}
          >
            <OrderControls
              form={form} symbol={symbol} scope={scope}
              availableBalance={auth ? ledger.available : null}
              canOrder={canOrder}
            />
          </div>
          <div data-testid="workspace-book" style={{
            width: `${cols.bookPct}%`, minWidth: BOOK_MIN_PX, flexShrink: 0,
            border: `1px solid ${C.hair}`, borderRadius: 8, background: C.bg,
            // 예산은 이 칸의 실측 높이(`BOOK_H`)를 바닥으로 잡는다. 그래도
            // 모자라는 기기가 나오면 **잘리는 대신 스크롤한다** — 매도 3줄이
            // 말없이 사라지면 화면만 보고는 알 수가 없다.
            minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain',
            WebkitOverflowScrolling: 'touch' as any,
          }}>
            {/* 3 매도 + 현재가 + 3 매수. 이 셋은 **잘리면 안 된다** */}
            <OrderBookView symbolId={symbol} market={market} rows={3} dense variant="compact"/>
          </div>
        </div>
      ) : (
        // 테스트넷·실전 — 기존 주문폼 그대로. 실거래 경로 변경 0.
        <div data-testid="exchange-order-pane" style={{ borderTop: `1px solid ${C.hair}` }}>
          {exchangeOrderPane}
        </div>
      )}

      {/* ④ 증거금 · 수수료 · 청산가 · 막힌 사유 — **주문 칸 밖**
          위 칸이 스크롤해도 이 줄은 안 움직인다. 얼마가 잠기고 어디서
          청산되는지 모른 채 누르는 화면을 만들지 않는다. */}
      {paperOrders ? (
        <div style={{ flexShrink: 0 }}>
          <OrderEstimate form={form} scope={scope}/>
        </div>
      ) : null}

      {/* ⑤ LONG · SHORT — 통의 마지막 칸에 **그냥 놓인다**

          예전에는 `position: sticky; bottom: var(--nav-h)`였다. 320×600
          실측에서 이 줄이 흐름 위치(787)에서 붙는 위치(490)로 끌어올려지며
          **슬라이더(447~452)를 덮었다.** `elementFromPoint`로 슬라이더
          한가운데를 찍으면 이 버튼이 나왔다 — 보이는데 눌리지 않았다.

          붙이지 않으면 덮을 일이 없다. 통이 하단 탭 위에서 끝나므로 탭
          밑으로 들어가지도 않는다. */}
      {paperOrders ? (
        <div data-testid="workspace-cta" style={{
          flexShrink: 0,
          display: 'flex', gap: 6, padding: '4px 8px',
          background: C.panel, borderTop: `1px solid ${C.hair}`,
        }}>
          <Cta form={form} side="LONG" disabled={!form.gate.ready || form.busy}/>
          <Cta form={form} side="SHORT" disabled={!form.gate.ready || form.busy}
            unavailable={form.shortDisabled}/>
        </div>
      ) : null}

      {/* ⑥ 열린 포지션 — **주문에 쓰는 바로 그 장부에서 온다**

          `usePaperLedger(target, …)` 결과를 그대로 받는다. 다시 읽지
          않으므로 챌린지 장부로 주문하고 기본 계좌 포지션을 보는 일이
          생길 수 없다(`BottomDock`은 `/api/paper/account`를 읽어서 늘
          `is_default` 계좌를 본다). */}
      {paperOrders && rowInside ? (
        <PositionRow
          positions={openPositions}
          auth={auth}
          onClosed={ledger.reload}
        />
      ) : null}
    </div>
  );

  // 통 안에 자리가 없으면 **통 밖**에 붙인다. 조금 내리면 보이고, 대신
  // 차트와 호가는 바닥을 지킨다 — 잘리는 것보다 낫다.
  if (paperOrders && !rowInside) {
    return (
      <>
        {core}
        <PositionRow positions={openPositions} auth={auth} onClosed={ledger.reload}/>
      </>
    );
  }
  return core;
}

/**
 * 높이를 잰다.
 *
 * 시장정보 줄은 폭과 종목 이름에 따라 접힌다 — 320px에서 106px, 360px에서
 * 74px이었다. 상수로 박으면 접히는 순간 아래 칸이 32px씩 밀리고, 통이
 * 고정 높이이므로 **밀린 만큼 CTA가 잘린다.** 그래서 재는 편이 싸다.
 * (`MobileShell`이 헤더에서 같은 이유로 이미 재고 있다.)
 */
function useMeasuredHeight<T extends HTMLElement>(): [React.MutableRefObject<T | null>, number] {
  const ref = React.useRef<T | null>(null);
  const [h, setH] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setH(el.getBoundingClientRect().height);
    read();
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

  return [ref, h];
}

/**
 * 방향 버튼이 곧 주문 버튼이다.
 *
 * 누르면 그 방향으로 주문이 나간다. 막혀 있으면 **버튼 글자가 무엇이
 * 필요한지 말한다**(`submitGate.submitLabel`) — 회색 버튼만 두고 이유를
 * 안 적는 상태를 만들지 않는다.
 */
function Cta({ form, side, disabled, unavailable }: {
  form: ReturnType<typeof useTradeForm>;
  side: 'LONG' | 'SHORT'; disabled: boolean; unavailable?: boolean;
}) {
  // **초기값을 "골랐다"로 읽지 않는다.** `form.side`는 미리보기 계산용
  // 기본값(LONG)을 갖고 있어서, 그것만 보면 LONG은 한 번만 눌러도 주문이
  // 나가고 SHORT는 두 번 눌러야 하는 비대칭이 생긴다.
  const on = form.sideChosen && form.side === side;
  const col = side === 'LONG' ? C.up : C.down;
  const label = form.sideLabel(side);
  const off = disabled || !!unavailable;
  return (
    <button
      type="button"
      data-testid={`workspace-cta-${label}`}
      disabled={!!unavailable}
      title={unavailable ? '이 시장에는 숏이 없습니다' : (form.gate.reason || undefined)}
      onClick={() => {
        if (unavailable) return;
        // 방향을 먼저 맞추고, 이미 그 방향이면 보낸다.
        if (!on) { form.chooseSide(side); return; }
        void form.submit();
      }}
      style={{
        flex: 1, minWidth: 0, padding: '12px 0', borderRadius: 9, border: 'none',
        background: off ? C.raised : col,
        color: off ? C.faint : '#fff',
        fontSize: FS.lead, fontWeight: 800,
        cursor: unavailable ? 'not-allowed' : 'pointer',
        opacity: on ? 1 : 0.82,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip',
      }}
    >
      {on && !off ? form.submitText : label}
    </button>
  );
}

/** 고른 챌린지가 지금 주문을 받는가. **못 읽으면 null** — 게이트가 막는다. */
function useChallengeStatus(target: PaperTarget, auth?: string): string | null {
  const [status, setStatus] = useState<string | null>(null);
  const id = target?.kind === 'CHALLENGE' ? target.challengeId : null;

  useEffect(() => {
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
