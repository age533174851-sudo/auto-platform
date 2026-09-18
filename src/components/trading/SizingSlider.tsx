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
import { type SizingResult } from '@/lib/trading/positionSizing';
import { formatMoneyForScope, type MoneyScope } from '@/lib/trading/gameMoney';

export interface SizingSliderProps {
  availableBalance: number | null;
  percent: number;
  onPercent: (p: number) => void;
  /**
   * 이미 계산된 결과. **여기서 다시 계산하지 않는다** —
   * `planSizing`을 두 곳에서 부르면 같은 입력에 다른 수량이 나올 수 있다.
   */
  sizing: SizingResult;
  leverage: number;
  /** 게임머니로 적을 장부인가 */
  scope: MoneyScope;
  symbol?: string;
  disabled?: boolean;
}

export function SizingSlider({
  availableBalance, percent, onPercent,
  sizing, leverage, scope, symbol, disabled,
}: SizingSliderProps) {
  const plan = sizing;

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
        <span data-testid="sizing-available" style={{
          fontSize: FS.micro, color: C.faint, minWidth: 0, overflowWrap: 'anywhere',
        }}>가용 {money(availableBalance)}</span>
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

      {/* ── 이 비율이 만든 값 ──

          **사유는 여기서 적지 않는다.** 실기에서 같은 문장이 화면에 두 번
          찍혔다 — 여기 한 번, 주문 버튼 바로 위 `order-blocked-reason`에
          한 번. 판정은 하나(`planSizing` → `submitGate`)인데 그리는 곳만
          둘이었다.

          남기는 쪽은 **주문 버튼에 가장 가까운 것**이다. 누르기 직전에
          읽는 자리이고, `submitGate`가 사이징 사유까지 이미 물고 온다
          (`useTradeForm`의 `sizingReason`). 그래서 여기서 지워도 사이징
          사유가 화면에서 사라지지 않는다. */}
      {locked ? null : plan.code === 'OK' ? (
        <div data-testid="sizing-preview" style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: FS.micro }}>
          {/* 순서가 곧 의미다: 증거금 → (×배율) → 명목가 → (÷가격) → 수량 */}
          <Row label="증거금" value={money(plan.marginBudget)} strong/>
          <Row label={`명목가 (×${leverage})`} value={money(plan.notional)}/>
          <Row
            label="수량"
            value={plan.quantity == null ? '—' : `${plan.quantity.toFixed(plan.quantity < 1 ? 6 : 4)}${symbol ? ` ${symbol}` : ''}`}
          />
        </div>
      ) : null}

      {/* 「최종 허용 수량은 서버가 다시 계산한다」는 단서는 **주문 칸 밖**
          예상값 줄에 있다(`OrderEstimate`). 좁은 기기에서 이 칸은 안에서
          스크롤하는데, 그 단서가 같이 스크롤해서 사라지면 화면 숫자를
          약속으로 읽게 된다. */}
    </div>
  );
}

/**
 * 값 한 줄.
 *
 * **자르지 않는다.** 실기에서 `명목가 (×10) 330,22…`처럼 우측이 잘렸다.
 * 잘린 숫자는 읽는 사람이 자릿수를 잘못 세게 만든다 — 좁으면 글자를
 * 줄이지 말고 아래로 내린다(`flexWrap` + `overflowWrap`).
 */
function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 4,
      minWidth: 0, flexWrap: 'wrap',
    }}>
      <span style={{ color: C.faint, flexShrink: 0 }}>{label}</span>
      <span style={{
        ...NUM, color: strong ? C.text : C.dim, fontWeight: strong ? 800 : 600,
        minWidth: 0, overflowWrap: 'anywhere', textAlign: 'right',
      }}>{value}</span>
    </div>
  );
}
