'use client';
// src/components/trading/markets/SpotTradingScreen.tsx
//
// **현물 거래 화면.**
//
// 이 시장의 말
// ────────────
//   매수 / 매도 · 가격 · 수량 / 총액 · 25·50·75·MAX ·
//   보유 Base · 가용 Quote · 호가 · 미체결 · 체결내역
//
// ★ 여기 **없어야** 하는 말
// ─────────────────────────
//   레버리지 · 격리/교차 · 펀딩 · 청산가 · 감축전용 · LONG/SHORT
//
// 현물에는 이것들이 **1배·0원으로 있는 게 아니라 아예 없다.** 0으로 적으면
// "1배 레버리지", "청산가 0원"처럼 읽히고, 그 값으로 위험을 계산하면 답이
// 나온다 — 틀린 답이. 그래서 칸 자체를 그리지 않는다.
//
// 공용 부품인 `OrderControls`가 배율·마진모드·청산가를 들고 있지만, 그
// 부품은 **능력표에 물어보고** 그린다(`unsupported(form.caps.leverage)`).
// 현물에서는 렌더가 없다. 부품을 두 벌 만들지 않으면서 의미를 안 섞는
// 방법이 이것이다.
//
// ★ 현물 '매도'는 공매도가 아니다
// ────────────────────────────────
// 가진 것을 파는 것이고, 그 경로는 `useSellForm` → `/api/paper/sell`이다.
// 진입 경로(`useTradeForm`)로 보내면 **현물 매도가 숏 진입이 된다.**
// 그래서 이 화면은 매수·매도를 서로 다른 훅에 붙인다.
import React from 'react';
import { C, FS } from '@/components/terminal/theme';
import { OrderControls, OrderEstimate } from '../OrderControls';
import { OrderBookView } from '../OrderBookView';
import { ProSellPanel } from '../ProSellPanel';
import { TradingScreenShell, InfoStat, LockedField,
  type ShellTab, type MarketScreenCommonProps } from './TradingScreenShell';
import { fieldTestId, screenContract } from '@/lib/trading/marketScreenContract';
import { orderCapability, unsupported } from '@/lib/trading/capability';
import { capability } from '@/lib/markets/marketType';
import { formatMoneyForScope } from '@/lib/trading/gameMoney';
import type { useTradeForm } from '@/lib/trading/useTradeForm';
import type { useSellForm } from '@/lib/trading/useSellForm';
import type { MoneyScope } from '@/lib/trading/gameMoney';
import type { PaperLedger } from '@/lib/trading/usePaperLedger';

type TradeForm = ReturnType<typeof useTradeForm>;
type SellForm = ReturnType<typeof useSellForm>;

export interface SpotScreenProps extends MarketScreenCommonProps {
  scope: MoneyScope;
  /** **받는다. 만들지 않는다.** 간편 화면과 같은 인스턴스다 */
  form: TradeForm;
  sell: SellForm;
  ledger: PaperLedger;
  canOrder: boolean;
}

const CONTRACT = screenContract('SPOT');
/** 총액으로 살 수 있는가 — 서버가 받는 것은 수량뿐이다 */
const QUOTE_INPUT = orderCapability('SPOT', 'PRICE_INPUT');
const LIMIT = orderCapability('SPOT', 'TYPE_LIMIT');

export function SpotTradingScreen(p: SpotScreenProps) {
  const [tab, setTab] = React.useState<'BUY' | 'SELL'>('BUY');
  // **받은 그대로 넘긴다.** 복사본을 만들면 간편 화면과 다른 매도가 나간다.
  const sell = p.sell;
  // ★ 종목이 없으면 조회도 주문도 하지 않는다.
  const sym = p.instrument?.symbol ?? null;
  const locked = sym == null;
  // 표시용 기초자산 이름이다. **다른 시장 심볼을 만드는 데 쓰지 않는다.**
  const base = (sym ?? '').replace(/USDT$|USDC$|BUSD$/, '');
  const held = p.sell.holding;

  // ── 시장별 핵심 정보 — 보유 Base · 가용 Quote ──
  //
  // 못 읽은 것을 0으로 접지 않는다. 0은 "하나도 없다"로 읽히고, 그걸 보고
  // 팔 수 없다고 판단하거나 전량을 사 버린다.
  const info = (
    <div style={{ display: 'flex', gap: 14, padding: '6px 10px', overflowX: 'auto' }}>
      <InfoStat testid={fieldTestId('BASE_HOLDING')} label={`보유 ${base}`}
        value={held?.quantity == null ? '—' : held.quantity.toFixed(6)}
        sub={p.sell.state === 'ERROR'
          ? (p.sell.error || '보유를 읽지 못했습니다')
          : (held?.avgPrice == null ? null : `평균 ${held.avgPrice.toFixed(2)}`)}/>
      <InfoStat testid={fieldTestId('QUOTE_AVAILABLE')} label="가용"
        value={p.ledger.available == null ? '—' : formatMoneyForScope(p.ledger.available, p.scope)}
        sub={p.ledger.availableUnknownReason}/>
    </div>
  );

  // ── 매수 / 매도 ──
  const orderForm = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      {/* 현물은 산다/판다다. LONG/SHORT라고 쓰면 선물과 같은 것으로 읽힌다 */}
      <div data-testid={fieldTestId('BUY_SELL')} style={{ display: 'flex', gap: 3 }}>
        {(['BUY', 'SELL'] as const).map(k => (
          <button key={k} type="button" onClick={() => setTab(k)}
            data-testid={`spot-tab-${k}`} aria-pressed={tab === k}
            style={{
              flex: 1, minHeight: 30, borderRadius: 6,
              border: `1px solid ${tab === k ? (k === 'BUY' ? C.up : C.down) : C.hair}`,
              background: tab === k ? C.raised : 'transparent',
              color: tab === k ? (k === 'BUY' ? C.up : C.down) : C.dim,
              fontSize: FS.nano, fontWeight: 800, cursor: 'pointer',
            }}>{k === 'BUY' ? capability('SPOT').buyLabel(base) : capability('SPOT').sellLabel(base)}</button>
        ))}
      </div>

      {/* 수량 / 총액 — **총액 입력은 아직 없다.** 서버가 받는 것은 수량뿐이고,
          총액 칸을 그려 두면 눌러서 아무 일도 안 일어난다. 잠그고 적는다. */}
      <div data-testid={fieldTestId('QTY_TOTAL_TOGGLE')} style={{ display: 'flex', gap: 3 }}>
        <span style={{
          flex: 1, minHeight: 26, display: 'flex', alignItems: 'center',
          justifyContent: 'center', borderRadius: 5,
          border: `1px solid ${C.accent}`, background: C.accentBg,
          color: C.accent, fontSize: FS.nano, fontWeight: 800,
        }}>수량</span>
        <span title={unsupported(QUOTE_INPUT) ? QUOTE_INPUT.reason : QUOTE_INPUT.note} style={{
          flex: 1, minHeight: 26, display: 'flex', alignItems: 'center',
          justifyContent: 'center', borderRadius: 5,
          border: `1px solid ${C.hair}`, background: C.raised,
          color: C.faint, fontSize: FS.nano, fontWeight: 700,
        }}>총액 (준비 안 됨)</span>
      </div>

      {tab === 'BUY' ? (
        // 25·50·75·MAX 비중은 `SizingSlider`가 그린다. 여기서 다시
        // 계산하지 않는다 — 수량 정본은 `useTradeForm.sizing` 하나다.
        <OrderControls form={p.form} symbol={sym ?? ''} scope={p.scope}
          availableBalance={p.ledger.available} canOrder={p.canOrder && !locked}/>
      ) : (
        <ProSellPanel symbol={sym ?? ""} scope={p.scope} sell={sell}/>
      )}
    </div>
  );

  const tabs: ShellTab[] = [
    {
      id: 'holdings', label: '보유',
      body: (
        // 현물에는 '포지션'이 아니라 보유가 있다. 같은 말로 쓰면 선물
        // 포지션과 섞인다 — 청산가도 배율도 없는 것에 그 말을 붙이지 않는다.
        <div data-testid={fieldTestId('POSITIONS')} style={{ display: 'grid', gap: 6 }}>
          {held == null ? (
            <div style={{ fontSize: FS.nano, color: C.faint, lineHeight: 1.6 }}>
              {p.sell.state === 'ERROR'
                ? (p.sell.error || '보유를 읽지 못했습니다 — 보유가 없다는 뜻이 아닙니다')
                : `${base} 보유가 없습니다`}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <InfoStat testid="spot-hold-qty" label="수량" value={held.quantity.toFixed(6)}/>
              <InfoStat testid="spot-hold-avg" label="평균단가"
                value={held.avgPrice == null ? '—' : held.avgPrice.toFixed(2)}
                sub={held.avgPrice == null ? '체결평균가 없음' : null}/>
              <InfoStat testid="spot-hold-lots" label="매수 건수" value={String(held.lots)}/>
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'open-orders', label: '미체결',
      body: <LockedField testid={fieldTestId('OPEN_ORDERS')} title="미체결"
        reason={unsupported(LIMIT) ? LIMIT.reason : LIMIT.note}/>,
    },
    {
      id: 'fills', label: '체결내역',
      body: <LockedField testid={fieldTestId('FILLS')} title="체결내역"
        reason={'모의 장부에 체결 내역을 주는 경로가 없습니다 — '
          + 'account · holdings · positions · order · sell · close · modify뿐입니다'}/>,
    },
  ];

  return (
    <TradingScreenShell
      testid={CONTRACT.root}
      market={p.market} onMarket={p.onMarket}
      instrumentReason={p.instrumentReason}
      symbol={sym ?? '종목 없음'} name={p.name}
      marketLabel={capability('SPOT').label}
      price={locked ? null : p.price} changePct={locked ? null : p.changePct}
      changeLabel={p.changeLabel}
      onBack={p.onBack} headerRight={p.headerRight}
      chartSource={sym == null ? null : { symbol: sym, market: 'SPOT' }}
      chartUnavailableReason={p.instrumentReason ?? undefined}
      info={info}
      orderForm={orderForm}
      orderBook={
        <div data-testid={fieldTestId('ORDER_BOOK')} style={{ height: '100%' }}>
          {/* ★ `market`을 반드시 넘긴다. 안 넘기면 기본이 선물이라
              **현물 가격 옆에 선물 호가**가 놓인다. */}
          {sym == null ? (
            <div data-testid="book-no-instrument" style={{
              padding: 10, fontSize: FS.nano, color: C.faint, lineHeight: 1.6,
            }}>{p.instrumentReason}</div>
          ) : (
            <OrderBookView symbolId={sym} market="SPOT" rows={7} dense/>
          )}
        </div>
      }
      estimate={tab === 'BUY' && !locked ? <OrderEstimate form={p.form} scope={p.scope}/> : null}
      cta={
        tab === 'BUY' ? (
          <button type="button" data-testid="spot-buy-cta"
            disabled={locked || !p.form.gate.ready || p.form.busy}
            title={locked ? (p.instrumentReason || undefined) : (p.form.gate.reason || undefined)}
            onClick={() => {
              if (!p.form.sideChosen || p.form.side !== 'LONG') { p.form.chooseSide('LONG'); return; }
              void p.form.submit();
            }}
            style={{
              width: '100%', padding: '13px 0', borderRadius: 9, border: 'none',
              background: locked || !p.form.gate.ready || p.form.busy ? C.raised : C.up,
              color: locked || !p.form.gate.ready || p.form.busy ? C.faint : '#fff',
              fontSize: FS.lead, fontWeight: 800, cursor: 'pointer',
            }}>
            {!locked && p.form.sideChosen && p.form.side === 'LONG' && p.form.gate.ready
              ? p.form.submitText : capability('SPOT').buyLabel(base || '종목')}
          </button>
        ) : (
          <button type="button" data-testid="spot-sell-cta"
            disabled={locked || !p.sell.gate.ready || p.sell.busy}
            title={locked ? (p.instrumentReason || undefined) : (p.sell.gate.reason || undefined)}
            onClick={() => { void p.sell.submit(); }}
            style={{
              width: '100%', padding: '13px 0', borderRadius: 9, border: 'none',
              background: locked || !p.sell.gate.ready || p.sell.busy ? C.raised : C.down,
              color: locked || !p.sell.gate.ready || p.sell.busy ? C.faint : '#fff',
              fontSize: FS.lead, fontWeight: 800, cursor: 'pointer',
            }}>{p.sell.submitText}</button>
        )
      }
      tabs={tabs}
    />
  );
}
