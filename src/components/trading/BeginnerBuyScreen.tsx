// src/components/trading/BeginnerBuyScreen.tsx
//
// **초보자가 보는 매수 화면.** 묻는 것은 하나다 — 얼마어치, 또는 몇 개.
//
// 이 파일이 하지 않는 것
// ──────────────────────
// **계산을 하나도 하지 않는다.** 수량·증거금·수수료는 전부 `form`(=
// `useTradeForm`의 반환)에 이미 들어 있고, 그 값들은 서버가 부르는
// `buildPaperPlan`·`planSizing`이 만든 것이다. 여기서 한 번 더 곱하면
// 화면 숫자와 장부 숫자가 갈린다.
//
// `fetch`도 하지 않는다. 주문은 `form.submit()`이다 — 프로 화면이 쓰는
// **그 함수**다. 두 화면이 각자 요청을 만들면 그때부터 주문 엔진이 둘이다.
//
// 입력 칸이 둘인데 정본은 하나다
// ──────────────────────────────
// "얼마어치"와 "몇 개"는 **같은 `percent`로 들어간다.** `percentFromNotional`
// 과 `percentFromQuantity`가 같은 기준(증거금 비율)으로 역산하므로, 어느
// 칸으로 넣어도 같은 주문이 된다. 화면이 지금 몇 %인지 말하는 곳은
// `form.percent` 한 곳뿐이다.
//
// 왜 슬라이더가 없는가
// ────────────────────
// 초보 화면에서 슬라이더는 "지금 몇 %인가"를 한 번 더 말하는 자리가 된다.
// 여기서는 비율 버튼이 유일한 비율 입력이고, 숫자는 금액/수량 칸이 말한다.

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import {
  percentFromNotional, percentFromQuantity, BUY_PERCENTS,
} from '@/lib/trading/positionSizing';
import { formatMoneyForScope, type MoneyScope } from '@/lib/trading/gameMoney';
import type { TradeForm } from '@/lib/trading/useTradeForm';

/** 무엇으로 정하는가. `Preferences.unit`과 **같은 축**이다 */
export type BuyUnit = 'QUOTE' | 'BASE';

export interface BeginnerBuyScreenProps {
  symbol: string;
  name?: string;
  market: 'SPOT' | 'USDM';
  /** 체결 기준가. 없으면 수량을 만들 수 없다 */
  price: number | null;
  /** **선택된 계좌**의 가용 잔고 */
  availableBalance: number | null;
  scope: MoneyScope;
  form: TradeForm;
  unit: BuyUnit;
  onUnit: (u: BuyUnit) => void;
  onBack: () => void;
  /** 프로 화면으로 건너간다. 문맥은 바깥이 들고 있다 */
  onPro?: () => void;
}

export function BeginnerBuyScreen({
  symbol, name, market, price, availableBalance, scope,
  form, unit, onUnit, onBack, onPro,
}: BeginnerBuyScreenProps) {
  // 입력 칸은 **버퍼**다. 정본은 `form.percent`.
  const [text, setText] = useState('');
  const [confirming, setConfirming] = useState(false);

  // 비율이 밖에서 0으로 돌아오면(주문 성공 뒤) 칸도 비운다.
  useEffect(() => { if (form.percent === 0) setText(''); }, [form.percent]);

  // 단위를 바꾸면 칸을 비운다. 숫자를 그대로 두면 "3개"가 "3달러"가 된다.
  const switchUnit = (u: BuyUnit) => {
    if (u === unit) return;
    setText(''); form.setPercent(0); onUnit(u);
  };

  const apply = (raw: string) => {
    setText(raw);
    const v = Number(raw);
    if (!raw.trim() || !Number.isFinite(v) || v < 0) { form.setPercent(0); return; }
    const pct = unit === 'QUOTE'
      ? percentFromNotional({ notional: v, availableBalance, leverage: form.lev })
      : percentFromQuantity({ quantity: v, availableBalance, price, leverage: form.lev });
    // **못 구하면 0으로 끌어다 놓지 않는다.** 0은 "사용자가 0을 골랐다"이고
    // 그건 확인된 사실이 아니다. 잔고·시세를 못 읽은 것은 게이트가 말한다.
    if (pct == null) return;
    form.setPercent(pct);
  };

  // 비율 버튼도 **같은 `setPercent`로** 들어간다.
  const pickPercent = (p: number) => {
    form.setPercent(p);
    // 칸에는 그 비율이 만든 값을 적어 준다 — 두 칸이 서로 다른 말을 하지
    // 않도록. 이 값은 표시용이고 요청에는 `form`의 수량이 실린다.
    const shown = unit === 'QUOTE' ? form.plan?.notional : form.quantity;
    setText(shown == null || !Number.isFinite(Number(shown)) ? '' : trim(Number(shown)));
  };

  const money = (v: number | null | undefined) =>
    formatMoneyForScope(v == null ? null : Number(v), scope);

  const ready = form.gate.ready;
  const unitLabel = unit === 'QUOTE' ? '얼마어치' : '몇 개';

  const estimate = useMemo(() => ([
    { k: '예상 수량', v: form.quantity == null ? '—' : trim(form.quantity), testid: 'buy-est-qty' },
    { k: '주문 금액', v: money(form.plan?.ok ? form.plan.notional : null), testid: 'buy-est-notional' },
    { k: '예상 수수료', v: money(form.plan?.ok ? form.plan.entryFee : null), testid: 'buy-est-fee' },
  ]), [form.quantity, form.plan, scope]);

  return (
    <div data-testid="beginner-buy" data-market={market} style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      background: C.bg, color: C.text,
    }}>
      <Head title={`${name || symbol} 구매`} sub={symbol} onBack={onBack}
        right={onPro ? <LevelSwitch to="프로" onClick={onPro}/> : null}/>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'grid', gap: 12 }}>
        <Row k="현재가" v={price == null ? '확인 불가' : trim(price)} warn={price == null}
          testid="buy-price"/>
        <Row k="주문 가능" v={availableBalance == null ? '확인 불가' : money(availableBalance)}
          warn={availableBalance == null} testid="buy-available"/>

        {/* ── 무엇으로 정하는가 ── */}
        <div style={{ display: 'flex', gap: 6 }}>
          {(['QUOTE', 'BASE'] as BuyUnit[]).map(u => (
            <button key={u} type="button" onClick={() => switchUnit(u)}
              data-testid={`buy-unit-${u.toLowerCase()}`} aria-pressed={u === unit}
              style={{
                flex: 1, padding: '10px 0', borderRadius: 8, cursor: 'pointer',
                border: `1px solid ${u === unit ? C.accent : C.hair}`,
                background: u === unit ? C.accentBg : C.raised,
                color: C.text, fontSize: FS.lead, fontWeight: 700,
              }}>{u === 'QUOTE' ? '얼마어치 살까요?' : '몇 개 살까요?'}</button>
          ))}
        </div>

        <input
          data-testid="buy-amount" inputMode="decimal" value={text}
          onChange={e => apply(e.target.value)}
          placeholder={unit === 'QUOTE' ? '금액을 입력하세요' : '수량을 입력하세요'}
          aria-label={unitLabel}
          style={{
            ...NUM, width: '100%', boxSizing: 'border-box', padding: '14px 12px',
            borderRadius: 10, border: `1px solid ${C.hair}`, background: C.raised,
            color: C.text, fontSize: FS.hero, fontWeight: 800,
          }}/>

        <div style={{ display: 'flex', gap: 6 }}>
          {BUY_PERCENTS.map(p => (
            <button key={p} type="button" onClick={() => pickPercent(p)}
              data-testid={`buy-pct-${p}`}
              style={{
                flex: 1, padding: '9px 0', borderRadius: 8, cursor: 'pointer',
                border: `1px solid ${C.hair}`, background: C.raised,
                color: C.dim, fontSize: FS.body, fontWeight: 700,
              }}>{p === 100 ? '최대' : `${p}%`}</button>
          ))}
        </div>

        <div style={{
          border: `1px solid ${C.hair}`, borderRadius: 10, background: C.panel, padding: 10,
          display: 'grid', gap: 6,
        }}>
          {estimate.map(e => (
            <div key={e.k} data-testid={e.testid}
              style={{ display: 'flex', justifyContent: 'space-between', fontSize: FS.body }}>
              <span style={{ color: C.faint }}>{e.k}</span>
              <span style={NUM}>{e.v}</span>
            </div>
          ))}
          {/*
            평가손익은 적지 않는다. 열린 포지션의 미실현 손익 정본이 이
            저장소에 없다(`paper_holdings` 주석). 없는 값을 그럴듯하게
            그리면 사용자는 그것으로 판단한다.
          */}
        </div>

        {form.message && (
          <div data-testid="buy-message" style={{
            fontSize: FS.body, padding: '8px 10px', borderRadius: 8,
            background: form.message.ok ? C.upBg : C.downBg,
            color: form.message.ok ? C.up : C.down,
          }}>{form.message.text}</div>
        )}
        {!ready && form.gate.reason && (
          <div data-testid="buy-blocked" style={{ fontSize: FS.small, color: C.faint }}>
            {form.gate.reason}
          </div>
        )}
      </div>

      {/* ── 확인 단계 ── 시장가는 되돌릴 수 없다 ── */}
      <div style={{ flexShrink: 0, padding: 12, borderTop: `1px solid ${C.hair}`, background: C.panel }}>
        {confirming ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <div data-testid="buy-confirm-text" style={{ fontSize: FS.body, color: C.dim }}>
              {form.quantity == null ? '수량을 확인하지 못했습니다' :
                `${symbol} ${trim(form.quantity)}개를 ${money(form.plan?.ok ? form.plan.notional : null)}에 삽니다. 진행할까요?`}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" data-testid="buy-cancel" onClick={() => setConfirming(false)}
                style={btn(C.raised, C.text)}>돌아가기</button>
              <button type="button" data-testid="buy-confirm" disabled={form.busy}
                onClick={() => { setConfirming(false); void form.submit(); }}
                style={btn(C.up, '#fff', form.busy)}>{form.busy ? '보내는 중…' : '구매'}</button>
            </div>
          </div>
        ) : (
          <button type="button" data-testid="buy-cta" disabled={!ready || form.busy}
            onClick={() => {
              // 방향을 **실제로 누른 것**으로 만든다. `useTradeForm`은
              // 누른 적 없는 방향으로는 주문을 내보내지 않는다.
              form.chooseSide('LONG');
              setConfirming(true);
            }}
            style={btn(ready ? C.up : C.raised, ready ? '#fff' : C.faint, !ready || form.busy)}>
            {ready ? '구매하기' : form.submitText}
          </button>
        )}
      </div>
    </div>
  );
}

// ── 아래는 그리기만 한다 ──

export function Head({ title, sub, onBack, right }: {
  title: string; sub?: string; onBack: () => void; right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
      borderBottom: `1px solid ${C.hair}`, background: C.panel, flexShrink: 0,
    }}>
      <button type="button" onClick={onBack} data-testid="order-back" aria-label="뒤로"
        style={{
          flexShrink: 0, background: 'none', border: 'none', color: C.text,
          fontSize: 20, cursor: 'pointer', padding: '0 4px',
        }}>‹</button>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: FS.lead, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {title}
        </span>
        {sub && <span style={{ fontSize: FS.micro, color: C.faint }}>{sub}</span>}
      </div>
      {right}
    </div>
  );
}

export function LevelSwitch({ to, onClick }: { to: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} data-testid="level-switch"
      style={{
        flexShrink: 0, padding: '6px 10px', borderRadius: 999, cursor: 'pointer',
        border: `1px solid ${C.hair}`, background: C.raised, color: C.dim,
        fontSize: FS.micro, fontWeight: 700, whiteSpace: 'nowrap',
      }}>{to} 모드</button>
  );
}

export function Row({ k, v, warn, testid }: {
  k: string; v: string; warn?: boolean; testid?: string;
}) {
  return (
    <div data-testid={testid}
      style={{ display: 'flex', justifyContent: 'space-between', fontSize: FS.body }}>
      <span style={{ color: C.faint }}>{k}</span>
      <span style={{ ...NUM, color: warn ? C.warn : C.text, fontWeight: 700 }}>{v}</span>
    </div>
  );
}

export function btn(bg: string, color: string, disabled = false): React.CSSProperties {
  return {
    flex: 1, width: '100%', padding: '14px 0', borderRadius: 10, border: 'none',
    background: bg, color, fontSize: FS.lead, fontWeight: 800,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
  };
}

/** 자릿수를 흔들지 않되 0을 만들지 않는다. 아주 작은 값은 그대로 보인다. */
export function trim(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return String(Number(v.toFixed(digits)));
}
