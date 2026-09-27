'use client';
// src/components/trading/markets/SpotSizeInput.tsx
//
// **수량으로 적든 총액으로 적든, 나가는 주문은 하나다.**
//
// 모드마다 주문 계산을 따로 두지 않는다
// ─────────────────────────────────────
// 입력 모드는 **표현**이다. 어느 칸에 적었든 값은 `positionSizing`의 같은
// 역함수를 지나 `form.setPercent` 하나로 들어가고, 실제 수량은 언제나
// `useTradeForm`의 `planSizing`이 만든 것 하나다. 모드별로 수량을 따로
// 계산하면 같은 주문이 칸에 따라 다른 수량으로 나간다.
//
// ★ 조용히 고치지 않는다
// ──────────────────────
// 잔고 100인데 총액 500을 적으면, 예전 역함수는 100%로 **잘라서** 돌려줬다.
// 슬라이더를 맞추는 용도로는 맞지만 직접 입력에서는 다른 뜻이 된다 —
// 사용자는 500을 주문한 줄 알고 화면은 100을 보여준다. 그래서 직접 입력은
// `OVER_BUDGET`을 받아 **넘쳤다고 적고 반영하지 않는다.**
//
// ★ MAX는 수수료를 감안한다
// ─────────────────────────
// `MAX = 100%`로 두면 `buildPaperPlan`이 증거금 위에 수수료를 더 요구해서
// 잔고 부족으로 막힌다. 임의 여유분을 두지 않고 `paperPlan`의 수수료 정본을
// 그대로 받아 계산한다.
import React from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import {
  quantityInputToPercent, notionalInputToPercent, maxAllocationPercent,
  PRO_PERCENTS, type DirectInputResult,
} from '@/lib/trading/positionSizing';
import { paperFeeRate } from '@/lib/engine/paperPlan';

export type SizeInputMode = 'QTY' | 'NOTIONAL';

export interface SpotSizeInputProps {
  /** 기초자산 이름 — `0.001 BTC` */
  base: string;
  /** 결제통화 이름 — `100 USDT` */
  quote: string;
  availableBalance: number | null;
  price: number | null;
  leverage: number;
  /** **유일한 출구.** 어느 모드든 여기로만 나간다 */
  onPercent: (pct: number) => void;
  /** 지금 계산된 수량 — 사용자가 적은 값이 아니라 정본이 만든 값이다 */
  quantity: number | null;
  disabled?: boolean;
}

export function SpotSizeInput(p: SpotSizeInputProps) {
  const [mode, setMode] = React.useState<SizeInputMode>('QTY');
  const [text, setText] = React.useState('');
  const [verdict, setVerdict] = React.useState<DirectInputResult | null>(null);

  const feeRate = paperFeeRate(null);
  const max = maxAllocationPercent({ leverage: p.leverage, feeRate });

  // 모드를 바꾸면 적어 둔 값을 비운다. 수량 칸의 `0.5`가 총액 칸에서
  // `0.5 USDT`로 읽히면 그건 다른 주문이다.
  const switchMode = (m: SizeInputMode) => {
    if (m === mode) return;
    setMode(m); setText(''); setVerdict(null);
  };

  const apply = (raw: string) => {
    setText(raw);
    const n = Number(raw);
    if (!raw.trim()) { setVerdict(null); return; }
    const r = mode === 'QTY'
      ? quantityInputToPercent({
          quantity: n, availableBalance: p.availableBalance,
          price: p.price, leverage: p.leverage })
      : notionalInputToPercent({
          notional: n, availableBalance: p.availableBalance, leverage: p.leverage });
    setVerdict(r);
    // ★ 넘치면 **반영하지 않는다.** 잘라서 넣으면 사용자가 적은 것과
    //   나가는 것이 달라진다.
    if (r.code === 'OK' && r.percent != null) p.onPercent(r.percent);
  };

  const quick = (pct: number) => {
    setText(''); setVerdict(null);
    p.onPercent(pct);
  };

  const sel: React.CSSProperties = {
    flex: 1, minHeight: 28, borderRadius: 5,
    fontSize: FS.nano, fontWeight: 800, cursor: 'pointer',
  };

  return (
    <div data-testid="spot-size-input" style={{ display: 'grid', gap: 6, minWidth: 0 }}>
      {/* 수량 / 총액 — 표현 모드다. 주문 계산은 하나다 */}
      <div data-testid="size-mode" style={{ display: 'flex', gap: 3 }}>
        {([['QTY', `수량 (${p.base || '기초자산'})`],
           ['NOTIONAL', `총액 (${p.quote || 'USDT'})`]] as const).map(([m, label]) => (
          <button key={m} type="button" data-testid={`size-mode-${m}`}
            aria-pressed={mode === m} disabled={p.disabled}
            onClick={() => switchMode(m)}
            style={{
              ...sel,
              border: `1px solid ${mode === m ? C.accent : C.hair}`,
              background: mode === m ? C.accentBg : C.raised,
              color: mode === m ? C.accent : C.dim,
            }}>{label}</button>
        ))}
      </div>

      <input
        data-testid="size-input"
        inputMode="decimal"
        value={text}
        disabled={p.disabled}
        onChange={e => apply(e.target.value.replace(/[^\d.]/g, ''))}
        placeholder={mode === 'QTY' ? `0.001 ${p.base || ''}`.trim() : `100 ${p.quote || ''}`.trim()}
        style={{
          minHeight: 34, borderRadius: 6, border: `1px solid ${C.hair}`,
          background: C.raised, color: C.text, fontSize: FS.body,
          padding: '0 8px', minWidth: 0,
        }}/>

      {/* ★ 넘쳤으면 넘쳤다고 적는다. 조용히 100%로 고치지 않는다 */}
      {verdict && verdict.code !== 'OK' ? (
        <div data-testid="size-input-reason" data-code={verdict.code} style={{
          fontSize: FS.nano, color: C.warn, lineHeight: 1.45, overflowWrap: 'anywhere',
        }}>{verdict.reason}</div>
      ) : null}

      {/* 빠른 비율 — 전부 같은 출구(`onPercent`)로 들어간다 */}
      <div data-testid="quick-allocation" style={{ display: 'flex', gap: 3 }}>
        {PRO_PERCENTS.map(pct => (
          <button key={pct} type="button" data-testid={`alloc-${pct}`}
            disabled={p.disabled} onClick={() => quick(pct)}
            style={{
              ...sel, border: `1px solid ${C.hair}`, background: C.raised, color: C.dim,
            }}>{pct}%</button>
        ))}
        <button type="button" data-testid="alloc-max"
          disabled={p.disabled || max.percent == null}
          title={max.percent == null
            ? (max.reason || undefined)
            : `수수료 ${(feeRate * 100).toFixed(3)}%를 남기고 ${max.percent.toFixed(2)}%`}
          onClick={() => { if (max.percent != null) quick(max.percent); }}
          style={{
            ...sel, border: `1px solid ${C.hair}`, background: C.raised,
            color: max.percent == null ? C.faint : C.dim,
          }}>MAX</button>
      </div>

      {/* 실제로 나갈 수량 — **정본이 만든 값**이다. 위 입력칸이 아니다 */}
      <div data-testid="size-effective" style={{
        ...NUM, fontSize: FS.nano, color: C.faint, overflowWrap: 'anywhere',
      }}>
        주문 수량 {p.quantity == null ? '—' : p.quantity.toFixed(p.quantity < 1 ? 6 : 4)}
      </div>
    </div>
  );
}
