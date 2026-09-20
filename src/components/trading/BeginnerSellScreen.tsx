// src/components/trading/BeginnerSellScreen.tsx
//
// **초보자가 보는 매도 화면.** 25 · 50 · 75 · 전량이 중심이다.
//
// 보유와 평단은 이 화면이 만들지 않는다
// ─────────────────────────────────────
// `sell.holding`은 `/api/paper/holdings` → `paper_holdings`가 준 줄
// 그대로다. 포지션 목록에서 평균을 내지 않는다 — 그러면 평단 정본이
// 둘이 되고, 088이 lot 단위로 세는 값과 갈린다.
//
// **평가손익을 적지 않는다.** `/api/paper/holdings`가 스스로
// `unrealizedPnl: 'UNAVAILABLE_NO_AUTHORITY'`라고 답한다. 없는 값을
// 그럴듯하게 그리면 사용자는 그것으로 판다.
//
// 팔고 난 결과도 마찬가지다 — 얼마에 팔렸고 손익이 얼마인지는 `/api/paper/sell`
// 응답이 말한다. 여기서 곱하지 않는다.

'use client';

import React, { useState } from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import { SELL_PERCENTS } from '@/lib/trading/positionSizing';
import { formatMoneyForScope, type MoneyScope } from '@/lib/trading/gameMoney';
import type { SellForm } from '@/lib/trading/useSellForm';
import { Head, LevelSwitch, Row, btn, trim } from './BeginnerBuyScreen';

export interface BeginnerSellScreenProps {
  symbol: string;
  name?: string;
  market: 'SPOT' | 'USDM';
  price: number | null;
  scope: MoneyScope;
  sell: SellForm;
  onBack: () => void;
  onPro?: () => void;
}

export function BeginnerSellScreen({
  symbol, name, market, price, scope, sell, onBack, onPro,
}: BeginnerSellScreenProps) {
  const [confirming, setConfirming] = useState(false);
  const money = (v: number | null | undefined) =>
    formatMoneyForScope(v == null ? null : Number(v), scope);

  const ready = sell.gate.ready;
  const held = sell.holding;

  return (
    <div data-testid="beginner-sell" data-market={market} style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      background: C.bg, color: C.text,
    }}>
      <Head title={`${name || symbol} 판매`} sub={symbol} onBack={onBack}
        right={onPro ? <LevelSwitch to="프로" onClick={onPro}/> : null}/>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'grid', gap: 12 }}>
        <Row k="현재가" v={price == null ? '확인 불가' : trim(price)} warn={price == null}
          testid="sell-price"/>

        {/*
          ★ "못 읽음"과 "보유 없음"을 다른 문장으로 적는다.
            조회 실패를 "보유 0"으로 그리면 사용자는 자산이 사라진 줄 안다.
        */}
        <Row k="보유 수량"
          v={sell.state === 'ERROR' ? '확인 불가'
            : sell.state === 'LOADING' ? '읽는 중…'
            : held == null ? '없음' : trim(held.quantity)}
          warn={sell.state === 'ERROR'} testid="sell-held"/>
        <Row k="평균 매입가"
          v={sell.state !== 'READY' ? '확인 불가'
            : held?.avgPrice == null ? '—' : trim(held.avgPrice)}
          warn={sell.state === 'ERROR'} testid="sell-avg"/>

        {sell.state === 'ERROR' && sell.error && (
          <div data-testid="sell-read-error" style={{ fontSize: FS.small, color: C.warn }}>
            {sell.error}
          </div>
        )}

        {/* ── 얼마나 팔까 ── 비율이 기본이다 ── */}
        <div style={{ display: 'flex', gap: 6 }}>
          {SELL_PERCENTS.map(p => (
            <button key={p} type="button" data-testid={`sell-pct-${p}`}
              aria-pressed={sell.mode === 'PERCENT' && sell.percent === p}
              onClick={() => { sell.setMode('PERCENT'); sell.setPercent(p); }}
              style={{
                flex: 1, padding: '12px 0', borderRadius: 8, cursor: 'pointer',
                border: `1px solid ${sell.mode === 'PERCENT' && sell.percent === p ? C.accent : C.hair}`,
                background: sell.mode === 'PERCENT' && sell.percent === p ? C.accentBg : C.raised,
                color: C.text, fontSize: FS.lead, fontWeight: 700,
              }}>{p === 100 ? '전량' : `${p}%`}</button>
          ))}
        </div>

        {/*
          수량 칸. 여기에 값을 넣으면 `setMode('QUANTITY')`가 **비율을
          비운다** — 서버의 `sellAmountOf`는 둘 다 오면 거부한다.
        */}
        <input
          data-testid="sell-qty" inputMode="decimal" value={sell.quantityText}
          onChange={e => { sell.setMode('QUANTITY'); sell.setQuantityText(e.target.value); }}
          placeholder="직접 수량 입력 (선택)" aria-label="매도 수량"
          style={{
            ...NUM, width: '100%', boxSizing: 'border-box', padding: '12px',
            borderRadius: 10, border: `1px solid ${sell.mode === 'QUANTITY' ? C.accent : C.hair}`,
            background: C.raised, color: C.text, fontSize: FS.num, fontWeight: 700,
          }}/>

        {sell.mode === 'PERCENT' && sell.approxQuantity != null && (
          <div data-testid="sell-approx" style={{ fontSize: FS.small, color: C.faint }}>
            예상 {trim(sell.approxQuantity)}개 — 실제 체결 수량은 매도 후 결과가 말합니다
          </div>
        )}

        {sell.message && (
          <div data-testid="sell-message" style={{
            fontSize: FS.body, padding: '8px 10px', borderRadius: 8,
            background: sell.message.ok ? C.upBg : C.downBg,
            color: sell.message.ok ? C.up : C.down,
          }}>{sell.message.text}</div>
        )}
        {!ready && sell.gate.reason && (
          <div data-testid="sell-blocked" style={{ fontSize: FS.small, color: C.faint }}>
            {sell.gate.reason}
          </div>
        )}
      </div>

      <div style={{ flexShrink: 0, padding: 12, borderTop: `1px solid ${C.hair}`, background: C.panel }}>
        {confirming ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <div data-testid="sell-confirm-text" style={{ fontSize: FS.body, color: C.dim }}>
              {sell.mode === 'PERCENT' && sell.percent === 100
                ? `${symbol} 보유분을 전부 팝니다. 진행할까요?`
                : `${symbol}을 ${sell.mode === 'QUANTITY'
                    ? `${sell.quantityText}개` : `${sell.percent}%`} 팝니다. 진행할까요?`}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" data-testid="sell-cancel" onClick={() => setConfirming(false)}
                style={btn(C.raised, C.text)}>돌아가기</button>
              <button type="button" data-testid="sell-confirm" disabled={sell.busy}
                onClick={() => { setConfirming(false); void sell.submit(); }}
                style={btn(C.down, '#fff', sell.busy)}>{sell.busy ? '보내는 중…' : '판매'}</button>
            </div>
          </div>
        ) : (
          <button type="button" data-testid="sell-cta" disabled={!ready || sell.busy}
            onClick={() => setConfirming(true)}
            style={btn(ready ? C.down : C.raised, ready ? '#fff' : C.faint, !ready || sell.busy)}>
            {ready ? '판매하기' : sell.submitText}
          </button>
        )}
      </div>
    </div>
  );
}
