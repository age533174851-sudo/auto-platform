'use client';
// src/components/trading/ProOrderPanel.tsx
//
// **전용 주문 화면의 프로 표현. 판단은 하나도 하지 않는다.**
//
// 무엇이 달라졌나
// ───────────────
// 예전에는 프로를 누르면 주문 화면이 **원스크린 거래 화면으로 차 냈다**
// (`TradingWorkspace`). 차트·호가·주문·포지션이 한 화면에 들어간 그 배치다.
// 모바일에서 그 화면은 320×600에서 차트가 96px까지 밀렸고, 주문 버튼이
// 슬라이더를 덮은 적도 있다.
//
// 이제 프로는 **주문 화면 안에 머문다.** 차트를 보려면 뒤로 나가면
// 종목 상세가 그대로 있다(주문 겹이 상세 겹 위에 뜨므로 상세는 살아 있다).
//
// ★ 훅을 여기서 만들지 않는다 — 이것이 이 파일의 계약이다
// ────────────────────────────────────────────────────────
// `form`과 `sell`을 **props로 받는다.** 만들지 않는다.
//
//   같은 `useTradeForm` 인스턴스 ─┬─ 간편 화면(BeginnerBuyScreen)
//                                 └─ 프로 화면(이 파일)
//
// 밀도가 판단을 바꾸지 않는다는 것을 말로 적는 대신 **구조로 만든다.**
// 훅을 양쪽에서 각자 만들면 언젠가 한쪽 인자만 바뀌고, 그때 "프로에서만
// 수량이 다르게 나가는" 고장이 난다. 이 저장소가 이름 붙인 2번 고장이다.
//
// 호가를 여기 두지 않는다
// ───────────────────────
// 호가는 **판단할 때** 보는 것이고 종목 상세의 일이다. 주문 화면에 다시
// 얹으면 그게 원스크린 터미널이다 — 이름만 바뀐 같은 배치가 된다.
import React from 'react';
import { C, FS } from '@/components/terminal/theme';
import { OrderControls, OrderEstimate } from './OrderControls';
import { ProSellPanel } from './ProSellPanel';
import type { useTradeForm } from '@/lib/trading/useTradeForm';
import type { useSellForm } from '@/lib/trading/useSellForm';
import type { MoneyScope } from '@/lib/trading/gameMoney';

type TradeForm = ReturnType<typeof useTradeForm>;
type SellForm = ReturnType<typeof useSellForm>;

export interface ProOrderPanelProps {
  symbol: string;
  market: 'SPOT' | 'USDM';
  scope: MoneyScope;
  /** **받는다. 만들지 않는다.** 간편 화면과 같은 인스턴스다 */
  form: TradeForm;
  /** 같은 이유로 받는다. 현물이 아니면 패널이 스스로 사유를 적는다 */
  sell: SellForm;
  availableBalance: number | null;
  canOrder: boolean;
}

/**
 * 막혔으면 **왜 막혔는지 버튼 글자가 말한다**(`submitGate.submitLabel`).
 * 회색 버튼만 두고 이유를 안 적는 상태를 만들지 않는다.
 */
function Cta({ form, side, disabled, unavailable }: {
  form: TradeForm;
  side: 'LONG' | 'SHORT'; disabled: boolean; unavailable?: boolean;
}) {
  // **초기값을 "골랐다"로 읽지 않는다.** `form.side`는 미리보기 계산용
  // 기본값(LONG)을 갖고 있어서, 그것만 보면 LONG은 한 번에 나가고 SHORT는
  // 두 번 눌러야 하는 비대칭이 생긴다.
  const on = form.sideChosen && form.side === side;
  const col = side === 'LONG' ? C.up : C.down;
  const label = form.sideLabel(side);
  const off = disabled || !!unavailable;
  return (
    <button
      type="button"
      data-testid={`pro-order-cta-${label}`}
      disabled={!!unavailable}
      title={unavailable ? '이 시장에는 숏이 없습니다' : (form.gate.reason || undefined)}
      onClick={() => {
        if (unavailable) return;
        // 방향을 먼저 맞추고, 이미 그 방향이면 보낸다.
        if (!on) { form.chooseSide(side); return; }
        void form.submit();
      }}
      style={{
        flex: 1, minWidth: 0, padding: '13px 0', borderRadius: 9, border: 'none',
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

export function ProOrderPanel({
  symbol, market, scope, form, sell, availableBalance, canOrder,
}: ProOrderPanelProps) {
  return (
    <div
      data-testid="pro-order-panel"
      style={{
        display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1,
        background: C.bg,
      }}
    >
      {/* ① 주문 유형 · 마진 모드 · 배율 · 수량 — 넘치면 이 칸이 스크롤한다.
          잘리면 넘친 줄이 말없이 사라지고, 화면만 봐서는 알 수가 없다. */}
      <div data-testid="pro-order-scroll" style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' as any,
        padding: '8px 10px',
      }}>
        <OrderControls
          form={form} symbol={symbol} scope={scope}
          availableBalance={availableBalance} canOrder={canOrder}
        />

        {/* ② 보유 · 나눠 팔기 — **현물에만 있다.**
            간편 화면과 같은 `sell`을 받으므로 두 화면이 서로 다른 수량을
            보낼 수 없다. 선물이면 패널이 스스로 "전량만"이라고 적는다. */}
        {market === 'SPOT' ? (
          <div data-testid="pro-order-sell" style={{ paddingTop: 10 }}>
            <ProSellPanel symbol={symbol} scope={scope} sell={sell}/>
          </div>
        ) : null}
      </div>

      {/* ③ 증거금 · 수수료 · 청산가 · 막힌 사유 — **주문 칸 밖에 고정.**
          위가 스크롤해도 이 줄은 안 움직인다. 얼마가 잠기고 어디서 청산되는지
          모른 채 누르는 화면을 만들지 않는다. */}
      <div style={{ flexShrink: 0 }}>
        <OrderEstimate form={form} scope={scope}/>
      </div>

      {/* ④ LONG · SHORT — 통의 마지막 칸에 **그냥 놓인다.**
          `position: sticky`로 붙이지 않는다. 320×600 실측에서 붙인 줄이
          슬라이더를 덮어, 보이는데 눌리지 않는 상태가 된 적이 있다. */}
      <div data-testid="pro-order-cta" style={{
        flexShrink: 0, display: 'flex', gap: 6, padding: '6px 10px',
        background: C.panel, borderTop: `1px solid ${C.hair}`,
      }}>
        <Cta form={form} side="LONG" disabled={!form.gate.ready || form.busy}/>
        <Cta form={form} side="SHORT" disabled={!form.gate.ready || form.busy}
          unavailable={form.shortDisabled}/>
      </div>
    </div>
  );
}
