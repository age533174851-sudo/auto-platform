'use client';
// src/components/trading/markets/UsdtFuturesTradingScreen.tsx
//
// **USDⓈ-M 선물 거래 화면.**
//
// 이 시장의 말
// ────────────
//   진입 / 청산 · LONG / SHORT · 격리 / 교차 · 배율 · 감축전용 ·
//   TP / SL · 마크가 · 펀딩 · 청산가 · 청산까지 거리
//
// 수량은 **코인 개수**다. 계약 수가 아니다 — 그건 COIN-M의 말이고,
// 두 화면이 같은 폼을 쓰면 언젠가 섞인다(`marketScreenContract`의
// `never` 목록이 그것을 막는다).
//
// ★ 판단을 여기서 만들지 않는다
// ─────────────────────────────
// `form`·`sell`은 **받는다.** `PaperOrderScreen`이 밀도 분기보다 위에서
// 한 번 만들고, 간편 화면과 이 화면이 **같은 인스턴스**를 받는다. 훅을
// 여기서 만들면 "프로에서만 수량이 다르게 나가는" 고장이 난다.
//
// 배율·마진모드·손절익절·청산가는 `OrderControls`/`OrderEstimate`에서
// 온다. 그 부품은 현물과 공유하지만 **능력표가 가린다** — 현물에서는
// 렌더 자체가 없다. 부품을 두 벌 만들지 않는 이유가 그것이다.
//
// ★ 할 수 없는 것은 잠그고 사유를 적는다
// ───────────────────────────────────────
// 감축전용(reduce-only)은 모의 장부에 **보낼 칸이 없다**(`capability.ts`).
// 칸을 지우면 "선물에 그 개념이 없다"로 읽히고, 열어 두면 눌러서 아무 일도
// 안 일어난다. 그래서 **잠그고 능력표의 사유를 그대로 적는다.**
import React from 'react';
import { C, FS } from '@/components/terminal/theme';
import { OrderControls, OrderEstimate } from '../OrderControls';
import { OrderBookView, useFunding, useCountdown } from '../OrderBookView';
import { PositionRow } from '../PositionRow';
import { TradingScreenShell, InfoStat, LockedField, type ShellTab } from './TradingScreenShell';
import { fieldTestId, screenContract } from '@/lib/trading/marketScreenContract';
import { orderCapability, unsupported } from '@/lib/trading/capability';
import { liquidationDistancePct } from '@/lib/engine/leverageMath';
import { capability } from '@/lib/markets/marketType';
import type { useTradeForm } from '@/lib/trading/useTradeForm';
import type { useSellForm } from '@/lib/trading/useSellForm';
import type { MoneyScope } from '@/lib/trading/gameMoney';
import type { PaperLedger } from '@/lib/trading/usePaperLedger';

type TradeForm = ReturnType<typeof useTradeForm>;
type SellForm = ReturnType<typeof useSellForm>;

export interface FuturesScreenProps {
  symbol: string;
  name?: string;
  scope: MoneyScope;
  /** **받는다. 만들지 않는다.** 간편 화면과 같은 인스턴스다 */
  form: TradeForm;
  sell: SellForm;
  ledger: PaperLedger;
  auth?: string;
  price: number | null;
  markPrice: number | null;
  changePct: number | null;
  changeLabel: string;
  canOrder: boolean;
  onBack: () => void;
  headerRight?: React.ReactNode;
  /** 청산으로 장부가 바뀌면 바깥이 다시 읽는다 */
  onLedgerChanged?: () => void;
}

const CONTRACT = screenContract('USDT_FUTURES');

export function UsdtFuturesTradingScreen(p: FuturesScreenProps) {
  const [intent, setIntent] = React.useState<'OPEN' | 'CLOSE'>('OPEN');
  const funding = useFunding(p.symbol);
  const nextIn = useCountdown(funding.nextAt);
  const reduceOnly = orderCapability('USDM', 'REDUCE_ONLY');
  const PARTIAL = orderCapability('USDM', 'PARTIAL_CLOSE');
  const LIMIT = orderCapability('USDM', 'TYPE_LIMIT');

  // 청산까지 거리는 **배율에서 나온다.** 여기서 공식을 다시 쓰지 않는다 —
  // `leverageMath`가 정본이고, 위험 계산도 같은 함수를 쓴다.
  const liqDist = liquidationDistancePct(p.form.lev);
  const positions = p.ledger.openPositions;

  // ── 시장별 핵심 정보 ──
  const info = (
    <div style={{
      display: 'flex', gap: 14, padding: '6px 10px', overflowX: 'auto',
      overscrollBehavior: 'contain',
    }}>
      <InfoStat testid={fieldTestId('MARK_PRICE')} label="마크가"
        value={p.markPrice == null ? '—' : p.markPrice.toFixed(2)}
        sub={p.markPrice == null ? '스트림 미수신' : null}/>
      <InfoStat testid={fieldTestId('FUNDING')} label="펀딩"
        value={funding.rate == null ? '—' : `${funding.rate.toFixed(4)}%`}
        sub={funding.nextAt == null ? '다음 정산 미확인' : `다음 ${nextIn}`}
        tone={funding.rate == null ? undefined : funding.rate >= 0 ? 'up' : 'down'}/>
      <InfoStat testid={fieldTestId('LIQUIDATION_DISTANCE')} label="청산까지"
        value={liqDist == null ? '—' : `${liqDist.toFixed(2)}%`}
        sub={liqDist == null ? '배율을 읽지 못했습니다' : `${p.form.lev}배 기준`}
        tone={liqDist != null && liqDist < 2 ? 'warn' : undefined}/>
    </div>
  );

  // ── 주문 입력 ──
  const orderForm = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      {/* 진입인가 청산인가 — 선물에서 이 둘은 다른 일이다.
          청산은 포지션이 있어야 뜻이 있으므로 목록으로 보낸다. */}
      <div data-testid={fieldTestId('OPEN_CLOSE')} style={{ display: 'flex', gap: 3 }}>
        {(['OPEN', 'CLOSE'] as const).map(k => (
          <button key={k} type="button" onClick={() => setIntent(k)}
            data-testid={`intent-${k}`} aria-pressed={intent === k}
            style={{
              flex: 1, minHeight: 30, borderRadius: 6,
              border: `1px solid ${intent === k ? C.accent : C.hair}`,
              background: intent === k ? C.accentBg : C.raised,
              color: intent === k ? C.accent : C.dim,
              fontSize: FS.nano, fontWeight: 800, cursor: 'pointer',
            }}>{k === 'OPEN' ? '진입' : '청산'}</button>
        ))}
      </div>

      {intent === 'OPEN' ? (
        <>
          {/* 배율 · 마진모드 · 비중 · 손절익절 — 능력표가 가리는 공용 부품 */}
          <OrderControls form={p.form} symbol={p.symbol} scope={p.scope}
            availableBalance={p.ledger.available} canOrder={p.canOrder}/>

          {/* 감축전용 — 개념은 있고 우리가 못 한다. 잠그고 사유를 적는다. */}
          <LockedField testid={fieldTestId('REDUCE_ONLY')} title="감축전용 (Reduce Only)"
            reason={unsupported(reduceOnly) ? reduceOnly.reason : reduceOnly.note}/>
        </>
      ) : (
        <div data-testid="close-intent-note" style={{
          fontSize: FS.nano, color: C.faint, lineHeight: 1.6, padding: '6px 2px',
        }}>
          열린 포지션은 아래 <b>포지션</b> 칸에서 닫습니다.
          {' '}{unsupported(PARTIAL) ? PARTIAL.reason : PARTIAL.note}
        </div>
      )}
    </div>
  );

  const tabs: ShellTab[] = [
    {
      id: 'positions', label: '포지션',
      body: (
        <div data-testid={fieldTestId('POSITIONS')} style={{ display: 'grid', gap: 8 }}>
          {positions.length === 0 ? (
            <div style={{ fontSize: FS.nano, color: C.faint }}>열린 포지션이 없습니다</div>
          ) : null}
          {/* **주문에 쓰는 바로 그 장부**를 넘긴다. 여기서 다시 조회하면
              같은 포지션이 두 화면에서 다르게 보인다(계좌가 갈린다). */}
          <PositionRow positions={positions} auth={p.auth} onClosed={p.ledger.reload}/>
        </div>
      ),
    },
    {
      id: 'open-orders', label: '미체결',
      body: (
        // **"0건"이라고 적지 않는다.** 모의 장부에 대기 주문이라는 개념이
        // 없다. 0건이라고 쓰면 기능이 있는데 지금 비어 있는 것으로 읽힌다.
        <LockedField testid={fieldTestId('OPEN_ORDERS')} title="미체결"
          reason={unsupported(LIMIT) ? LIMIT.reason : LIMIT.note}/>
      ),
    },
  ];

  return (
    <TradingScreenShell
      testid={CONTRACT.root}
      symbol={p.symbol} name={p.name}
      marketLabel={capability('USDT_FUTURES').label}
      price={p.price} changePct={p.changePct} changeLabel={p.changeLabel}
      onBack={p.onBack} headerRight={p.headerRight}
      chartSource={{ symbol: p.symbol, market: 'USDM' }}
      info={info}
      orderForm={orderForm}
      orderBook={
        <div data-testid={fieldTestId('ORDER_BOOK')} style={{ height: '100%' }}>
          <OrderBookView symbolId={p.symbol} market="USDM" rows={7} dense
            onPickPrice={() => { /* 모의 장부는 지정가를 받지 않는다 */ }}/>
        </div>
      }
      estimate={<OrderEstimate form={p.form} scope={p.scope}/>}
      cta={
        <div data-testid={fieldTestId('LONG_SHORT')} style={{ display: 'flex', gap: 6 }}>
          <Cta form={p.form} side="LONG" disabled={!p.form.gate.ready || p.form.busy || intent !== 'OPEN'}/>
          <Cta form={p.form} side="SHORT" disabled={!p.form.gate.ready || p.form.busy || intent !== 'OPEN'}
            unavailable={p.form.shortDisabled}/>
        </div>
      }
      tabs={tabs}
    />
  );
}

/**
 * 막혔으면 **왜 막혔는지 버튼 글자가 말한다**(`submitGate.submitLabel`).
 * 회색 버튼만 두고 이유를 안 적는 상태를 만들지 않는다.
 */
export function Cta({ form, side, disabled, unavailable }: {
  form: TradeForm; side: 'LONG' | 'SHORT'; disabled: boolean; unavailable?: boolean;
}) {
  // **초기값을 "골랐다"로 읽지 않는다.** `form.side`는 미리보기 계산용
  // 기본값(LONG)을 갖고 있어서, 그것만 보면 LONG은 한 번에 나가고 SHORT는
  // 두 번 눌러야 하는 비대칭이 생긴다.
  const on = form.sideChosen && form.side === side;
  const col = side === 'LONG' ? C.up : C.down;
  const label = form.sideLabel(side);
  const off = disabled || !!unavailable;
  return (
    <button type="button" data-testid={`pro-order-cta-${label}`}
      disabled={!!unavailable}
      title={unavailable ? '이 시장에는 숏이 없습니다' : (form.gate.reason || undefined)}
      onClick={() => {
        if (unavailable) return;
        if (!on) { form.chooseSide(side); return; }
        void form.submit();
      }}
      style={{
        flex: 1, minWidth: 0, padding: '13px 0', borderRadius: 9, border: 'none',
        background: off ? C.raised : col, color: off ? C.faint : '#fff',
        fontSize: FS.lead, fontWeight: 800,
        cursor: unavailable ? 'not-allowed' : 'pointer',
        opacity: on ? 1 : 0.82,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip',
      }}>
      {on && !off ? form.submitText : label}
    </button>
  );
}
