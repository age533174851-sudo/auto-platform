// src/components/trading/ProSellPanel.tsx
//
// **프로 화면의 매도 패널.** 차트·호가 옆에 붙는다.
//
// `BeginnerSellScreen`과 **같은 `SellForm`을 받는다.** 그게 이 Phase의
// 핵심이다 — 두 화면이 각자 보유를 읽고 각자 요청을 만들면, 같은 매도가
// 화면에 따라 다르게 나간다.
//
// 차이는 배치와 밀도뿐이다
// ────────────────────────
//   초보  25/50/75/전량 큰 버튼 · 확인 단계 · 한 화면에 하나씩
//   프로  같은 버튼을 작게 · 수량 칸을 항상 열어 둠 · lot 수와 원가 귀속까지
//
// 프로에 더 보이는 값들도 **전부 `/api/paper/holdings`가 준 것**이다.
// 여기서 계산해서 만든 값은 하나도 없다.

'use client';

import React from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import { SELL_PERCENTS } from '@/lib/trading/positionSizing';
import { formatMoneyForScope, type MoneyScope } from '@/lib/trading/gameMoney';
import { unsupported } from '@/lib/trading/capability';
import type { SellForm } from '@/lib/trading/useSellForm';
import { trim } from './BeginnerBuyScreen';

export interface ProSellPanelProps {
  symbol: string;
  scope: MoneyScope;
  sell: SellForm;
}

export function ProSellPanel({ symbol, scope, sell }: ProSellPanelProps) {
  const money = (v: number | null | undefined) =>
    formatMoneyForScope(v == null ? null : Number(v), scope);
  const held = sell.holding;
  const ready = sell.gate.ready;

  // ── 못 하는 것은 **끄고 이유를 적는다** ──
  //
  // 숨기면 "곧 나온다"로 읽히고, 활성화하면 거짓말이 된다. 선물이 여기
  // 걸린다 — `paper_settle_close`에 부분 청산을 받을 칸이 없다.
  if (unsupported(sell.supported)) {
    return (
      <div data-testid="pro-sell" data-supported="false" style={box()}>
        <Label>매도</Label>
        <div data-testid="pro-sell-unsupported" style={{ fontSize: FS.small, color: C.faint }}>
          {sell.supported.reason}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="pro-sell" data-supported="true" style={box()}>
      <Label>보유 · 매도</Label>

      <div style={{ display: 'grid', gap: 3 }}>
        <KV k="수량" testid="pro-sell-held"
          v={sell.state === 'ERROR' ? '확인 불가'
            : sell.state === 'LOADING' ? '…'
            : held == null ? '없음' : trim(held.quantity)}
          warn={sell.state === 'ERROR'}/>
        <KV k="평단" testid="pro-sell-avg"
          v={sell.state !== 'READY' ? '확인 불가'
            : held?.avgPrice == null ? '—' : trim(held.avgPrice)}
          warn={sell.state === 'ERROR'}/>
        {/* 아래 둘은 프로에만 보인다. 둘 다 서버가 준 값 그대로다. */}
        <KV k="취득원가" testid="pro-sell-notional"
          v={held == null ? '—' : money(held.totalNotional)}/>
        <KV k="수수료 귀속" testid="pro-sell-feebasis"
          v={held == null ? '—' : money(held.entryFeeBasis)}/>
        <KV k="lot" testid="pro-sell-lots" v={held == null ? '—' : String(held.lots)}/>
        {/*
          평가손익·수익률 칸은 없다. 정본이 없어서다
          (`paper_holdings`: "평가손익·수익률은 넣지 않는다").
          프로 화면이라고 없는 값을 만들지 않는다.
        */}
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        {SELL_PERCENTS.map(p => (
          <button key={p} type="button" data-testid={`pro-sell-pct-${p}`}
            aria-pressed={sell.mode === 'PERCENT' && sell.percent === p}
            onClick={() => { sell.setMode('PERCENT'); sell.setPercent(p); }}
            style={{
              flex: 1, padding: '6px 0', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${sell.mode === 'PERCENT' && sell.percent === p ? C.accent : C.hair}`,
              background: sell.mode === 'PERCENT' && sell.percent === p ? C.accentBg : C.raised,
              color: C.text, fontSize: FS.micro, fontWeight: 700,
            }}>{p === 100 ? '전량' : `${p}%`}</button>
        ))}
      </div>

      <input
        data-testid="pro-sell-qty" inputMode="decimal" value={sell.quantityText}
        onChange={e => { sell.setMode('QUANTITY'); sell.setQuantityText(e.target.value); }}
        placeholder="수량" aria-label="매도 수량"
        style={{
          ...NUM, width: '100%', boxSizing: 'border-box', padding: '7px 8px',
          borderRadius: 6, border: `1px solid ${sell.mode === 'QUANTITY' ? C.accent : C.hair}`,
          background: C.raised, color: C.text, fontSize: FS.body, fontWeight: 700,
        }}/>

      {sell.message && (
        <div data-testid="pro-sell-message" style={{
          fontSize: FS.micro, color: sell.message.ok ? C.up : C.down,
        }}>{sell.message.text}</div>
      )}

      <button type="button" data-testid="pro-sell-submit" disabled={!ready || sell.busy}
        onClick={() => void sell.submit()}
        style={{
          width: '100%', padding: '9px 0', borderRadius: 6, border: 'none',
          background: ready ? C.down : C.raised, color: ready ? '#fff' : C.faint,
          fontSize: FS.body, fontWeight: 800,
          cursor: !ready || sell.busy ? 'not-allowed' : 'pointer',
          opacity: !ready || sell.busy ? 0.6 : 1,
        }}>{sell.busy ? '보내는 중…' : sell.submitText}</button>

      {!ready && sell.gate.reason && (
        <div data-testid="pro-sell-blocked" style={{ fontSize: FS.micro, color: C.faint }}>
          {sell.gate.reason}
        </div>
      )}
    </div>
  );
}

function box(): React.CSSProperties {
  return {
    display: 'grid', gap: 6, padding: 8, background: C.panel,
    border: `1px solid ${C.hair}`, borderRadius: 8,
  };
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: FS.micro, fontWeight: 700, color: C.dim, letterSpacing: '0.04em' }}>
      {children}
    </div>
  );
}

function KV({ k, v, warn, testid }: { k: string; v: string; warn?: boolean; testid?: string }) {
  return (
    <div data-testid={testid}
      style={{ display: 'flex', justifyContent: 'space-between', fontSize: FS.micro }}>
      <span style={{ color: C.faint }}>{k}</span>
      <span style={{ ...NUM, color: warn ? C.warn : C.text }}>{v}</span>
    </div>
  );
}
