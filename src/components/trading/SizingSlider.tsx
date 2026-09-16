'use client';
// src/components/trading/SizingSlider.tsx
//
// 0~100% 드래그 슬라이더. **비율이 무엇의 비율인지 화면에 적는다.**
//
//   "가용 잔고의 50%를 **증거금**으로"  ← 이것
//   "가용 잔고의 50%를 명목가로"        ← 이것이 아니다
//
// 1배에서는 둘이 같은 값이라 화면만 보면 구별되지 않는다. 100배에서 100배
// 차이가 난다. 그래서 계산은 `positionSizing.planSizing` 하나에 두고, 이
// 컴포넌트는 그 결과를 **말로 적어서** 보여 준다.
//
// 빠른 버튼이 없는 이유
// ─────────────────────
// 한동안 슬라이더 아래에 25/50/75/100% 버튼을 같이 뒀다. 그런데 비율을
// 정하는 방법이 둘이면 "지금 몇 %인가"를 말하는 곳도 둘이 된다. 끌어서
// 정하고 숫자로 읽는다 — 그 한 벌이면 충분하다.
//
// 잔고를 못 읽으면 잠근다
// ───────────────────────
// 0%로 두지 않는다. 0은 "돈이 없다"로 읽히고, 사용자는 있는 돈을 못 쓴다고
// 생각한다. 잠그고 사유를 적는다.
import React from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import { planSizing, type SizingResult } from '@/lib/trading/positionSizing';
import { formatMoneyForScope, type MoneyScope } from '@/lib/trading/gameMoney';

export interface SizingSliderProps {
  availableBalance: number | null;
  /** 잔고를 못 읽은 사유 — 있으면 그대로 적는다 */
  unknownReason?: string | null;
  percent: number;
  onPercent: (p: number) => void;
  price: number | null;
  leverage: number;
  /** 게임머니로 적을 장부인가 */
  scope: MoneyScope;
  symbol?: string;
  disabled?: boolean;
}

export function SizingSlider({
  availableBalance, unknownReason, percent, onPercent,
  price, leverage, scope, symbol, disabled,
}: SizingSliderProps) {
  const plan: SizingResult = planSizing({
    availableBalance, percent, price, leverage,
  });

  const balanceUnknown = availableBalance == null;
  const locked = !!disabled || balanceUnknown;
  const money = (v: number | null) => formatMoneyForScope(v, scope);

  return (
    <div data-testid="sizing-slider" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* ── 무엇의 비율인지 ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: FS.micro, color: C.dim, fontWeight: 700 }}>
          증거금 배정 비율
        </span>
        <span style={{ fontSize: FS.micro, color: C.faint }}>
          가용 {money(availableBalance)}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="range"
          data-testid="sizing-slider-input"
          min={0} max={100} step={1}
          value={locked ? 0 : percent}
          disabled={locked}
          onChange={e => onPercent(Number(e.target.value))}
          aria-label="증거금 배정 비율"
          style={{ flex: 1, accentColor: C.accent, cursor: locked ? 'not-allowed' : 'pointer' }}
        />
        <span style={{ ...NUM, width: 44, textAlign: 'right', fontSize: FS.body, fontWeight: 800, color: locked ? C.faint : C.text }}>
          {locked ? '—' : `${percent}%`}
        </span>
      </div>

      {/* ── 이 비율이 만든 값 ── */}
      {locked ? (
        <div data-testid="sizing-locked" style={{ fontSize: FS.micro, color: C.warn, lineHeight: 1.5 }}>
          {unknownReason
            || (balanceUnknown ? '가용 잔고를 확인하지 못했습니다 — 잔고가 0이라는 뜻이 아닙니다' : '지금은 수량을 정할 수 없습니다')}
        </div>
      ) : plan.code === 'OK' ? (
        <div data-testid="sizing-preview" style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: FS.micro }}>
          {/* 순서가 곧 의미다: 증거금 → (×배율) → 명목가 → (÷가격) → 수량 */}
          <Row label="증거금" value={money(plan.marginBudget)} strong/>
          <Row label={`명목가 (×${leverage})`} value={money(plan.notional)}/>
          <Row
            label="수량"
            value={plan.quantity == null ? '—' : `${plan.quantity.toFixed(plan.quantity < 1 ? 6 : 4)}${symbol ? ` ${symbol}` : ''}`}
          />
        </div>
      ) : (
        <div data-testid="sizing-reason" style={{ fontSize: FS.micro, color: C.warn, lineHeight: 1.5 }}>
          {plan.reason}
        </div>
      )}

      {/* 최종 판정은 서버다. 화면 숫자를 약속으로 읽지 않게 적어 둔다. */}
      <div style={{ fontSize: FS.nano, color: C.faint, lineHeight: 1.5 }}>
        최종 허용 수량은 주문할 때 서버가 다시 계산합니다.
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: C.faint }}>{label}</span>
      <span style={{ ...NUM, color: strong ? C.text : C.dim, fontWeight: strong ? 800 : 600 }}>{value}</span>
    </div>
  );
}
