'use client';
// src/components/terminal/MarketSwitch.tsx
//
// 시장 유형 전환 + 현물·선물 통합 비교판.
//
// 전환은 눈에 띄어야 한다
// ───────────────────────
// 현물과 선물은 같은 종목이라도 완전히 다른 거래다. 지금 어느 쪽에
// 있는지 모르면 '매도'를 누르며 파는 줄 알고 숏을 연다.
// 그래서 선택된 유형은 색까지 다르게 한다 — 현물은 중립, 선물은 강조.
import React, { memo } from 'react';
import { C, FS, NUM, fmtPrice, pnlColor } from './theme';
import { MARKET_TYPES, capability, basisPct, netExposure, type MarketType } from '@/lib/markets/marketType';

export const MarketSwitch = memo(function MarketSwitch({
  value, onChange, compact,
}: { value: MarketType; onChange: (m: MarketType) => void; compact?: boolean }) {
  return (
    <div style={{
      display: 'flex', gap: 3, background: C.raised,
      padding: 3, borderRadius: 8, flexShrink: 0,
    }}>
      {MARKET_TYPES.map(m => {
        const on = m === value;
        const cap = capability(m);
        // 선물은 파랑, 현물은 회색. 같은 색을 쓰면 전환됐는지 안 보인다.
        const tone = cap.leverage ? C.accent : C.hair3;
        return (
          <button key={m} onClick={() => onChange(m)} style={{
            minHeight: compact ? 26 : 30, padding: compact ? '0 8px' : '0 12px',
            border: 'none', borderRadius: 6, cursor: 'pointer',
            background: on ? tone : 'transparent',
            color: on ? (cap.leverage ? '#fff' : C.text) : C.dim,
            fontSize: FS.micro, fontWeight: on ? 700 : 500,
            whiteSpace: 'nowrap', transition: 'background .12s, color .12s',
          }}>{compact ? cap.shortLabel : cap.label}</button>
        );
      })}
    </div>
  );
});

/**
 * 같은 종목의 현물·선물을 나란히 본다.
 *
 * 따로 보면 현물 0.15 BTC와 선물 SHORT 0.10 BTC가 둘 다 크게 느껴진다.
 * 실제 방향 노출은 +0.05다. 그 숫자를 직접 보여준다.
 */
export const MarketCompare = memo(function MarketCompare({
  spotPrice, markPrice, fundingPct, spotQty, futuresQty, dense,
}: {
  spotPrice: number | null;
  markPrice: number | null;
  fundingPct: number | null;
  /** 현물 보유 수량. 모르면 null */
  spotQty: number | null;
  /** 선물 순수량. LONG +, SHORT −. 모르면 null */
  futuresQty: number | null;
  dense?: boolean;
}) {
  const basis = basisPct(spotPrice, markPrice);
  const known = spotQty != null && futuresQty != null;
  const net = known ? netExposure({ spotQty, futuresQty }) : null;

  return (
    <div style={{
      padding: dense ? '8px 10px' : '10px 12px',
      background: C.raised, borderRadius: 8,
      display: 'flex', flexDirection: 'column', gap: 4, fontSize: FS.micro,
    }}>
      <Row k="현물 가격" v={spotPrice == null ? '—' : `$${fmtPrice(spotPrice)}`}/>
      <Row k="선물 Mark" v={markPrice == null ? '—' : `$${fmtPrice(markPrice)}`}/>
      {/* 괴리는 한쪽이라도 없으면 계산하지 않는다. 0%로 적으면 "같다"가 된다. */}
      <Row k="Basis" v={basis == null ? '—' : `${basis >= 0 ? '+' : ''}${basis.toFixed(3)}%`}
           color={basis == null ? undefined : pnlColor(basis)}/>
      <Row k="Funding" v={fundingPct == null ? '—' : `${fundingPct >= 0 ? '+' : ''}${fundingPct.toFixed(4)}%`}
           color={fundingPct == null ? undefined : fundingPct >= 0 ? C.down : C.up}/>

      <div style={{ height: 1, background: C.hair, margin: '3px 0' }}/>

      <Row k="현물 보유" v={spotQty == null ? '확인 불가' : fmtPrice(spotQty, 6)}
           color={spotQty == null ? C.warn : undefined}/>
      <Row k="선물 포지션"
           v={futuresQty == null ? '확인 불가'
             : futuresQty === 0 ? '없음'
             : `${futuresQty > 0 ? 'LONG' : 'SHORT'} ${fmtPrice(Math.abs(futuresQty), 6)}`}
           color={futuresQty == null ? C.warn : futuresQty === 0 ? undefined : pnlColor(futuresQty)}/>
      {/* 둘 중 하나라도 모르면 합계를 내지 않는다. 반쪽 합계는 틀린 합계다. */}
      <Row k="총 순노출"
           v={net == null ? '한쪽을 몰라 계산 불가' : `${net >= 0 ? '+' : ''}${fmtPrice(net, 6)}`}
           color={net == null ? C.warn : pnlColor(net)} bold/>
    </div>
  );
});

function Row({ k, v, color, bold }: { k: string; v: string; color?: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: C.faint, whiteSpace: 'nowrap' }}>{k}</span>
      <span style={{
        ...NUM, color: color ?? C.text,
        fontWeight: bold ? 700 : 600, whiteSpace: 'nowrap',
      }}>{v}</span>
    </div>
  );
}
