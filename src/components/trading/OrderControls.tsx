'use client';
// src/components/trading/OrderControls.tsx
//
// **주문 조작부 — 한 화면 안의 한 칸.**
//
// 왜 시트가 아닌가
// ────────────────
// 전에는 LONG/SHORT를 누르면 시트가 올라오는 구조였다. 실기(360×660)에서
// 시트를 열면 **캔들이 52px만 남았고 그 띠는 배경과 격자선뿐이었다.**
// 차트를 보고 들어가라고 만든 화면인데 주문하려는 순간 차트가 사라졌다.
//
// 그래서 주문 조작부가 화면에 **상주한다.** 여닫는 층이 없으면 52vh·88vh·
// visual viewport·오버레이 겹침 같은 문제가 통째로 없어진다.
//
// 좁은 칸에서 지키는 것
// ─────────────────────
// 숫자를 `...`로 줄여서 통과시키지 않는다. 가용·비중·증거금·명목가·수량·
// 청산가는 **끝까지 보여야** 한다. 자리가 모자라면 글자를 줄이지 말고
// 줄을 나눈다.
//
// 판정은 여기 없다
// ────────────────
// 방향·배율·비중·손절과 그로부터 나오는 계획은 `useTradeForm`에 있다.
// 이 파일은 그 값을 그리고 함수를 부른다 — 데스크톱이 다른 배치를 써도
// 같은 판정을 쓴다.
import React from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import { SizingSlider } from './SizingSlider';
import { fieldTestId } from '@/lib/trading/marketScreenContract';
import { PAPER_MAX_LEVERAGE, type MarginMode } from '@/lib/engine/paperPlan';
import { STOP_PCTS } from '@/lib/trading/stopPresets';
import { unsupported } from '@/lib/trading/capability';
import { formatMoneyForScope, type MoneyScope } from '@/lib/trading/gameMoney';
import { LEVERAGES, type TradeForm } from '@/lib/trading/useTradeForm';

export interface OrderControlsProps {
  form: TradeForm;
  symbol: string;
  scope: MoneyScope;
  availableBalance: number | null;
  canOrder: boolean;
}

export function OrderControls({
  form, symbol, scope, availableBalance, canOrder,
}: OrderControlsProps) {
  return (
    <div data-testid="order-controls" style={{
      display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
    }}>
      {/* ── 주문 유형 · 마진 모드 · 배율 — **한 줄** ──

          모의 장부에는 대기 주문이 없다. 낼 수 있는 것은 즉시 체결뿐이고,
          그 사실을 적어 둔다 — 지정가 칸을 만들면 서버가 무시하는 가짜가 된다.

          예전에는 이 글자가 제 줄을 하나 먹었다. 320×600에서는 그 한 줄이
          아래 손절 버튼을 화면 밖으로 밀어냈다. 줄을 합치면 20px이 돌아온다. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <span data-testid="order-type" style={{
          flexShrink: 0, fontSize: FS.nano, color: C.faint, fontWeight: 700,
          letterSpacing: '0.02em', lineHeight: 1.15,
        }}>시장가<br/>MARKET</span>
          {/* ★ 시장 전용 칸이다. **능력표가 가린다** — 현물에서는 렌더
              자체가 없다(`marketScreenContract`의 SPOT `never` 목록).
              바깥 표식(`mkt-*`)은 계약 정본이 정한다. 손으로 적으면
              검사기가 찾는 이름과 갈린다. */}
          {!unsupported(form.caps.marginMode) ? (
            <span data-testid={fieldTestId('MARGIN_MODE')} style={{ display: 'contents' }}>
            <select
              value={form.marginMode}
              onChange={e => form.setMarginMode(e.target.value as MarginMode)}
              data-testid="margin-mode"
              style={sel}
            >
              <option value="ISOLATED">격리</option>
              <option value="CROSSED">교차</option>
            </select>
            </span>
          ) : null}
          {!unsupported(form.caps.leverage) ? (
            <span data-testid={fieldTestId('LEVERAGE')} style={{ display: 'contents' }}>
            <select
              value={form.leverage}
              onChange={e => form.setLeverage(Number(e.target.value))}
              data-testid="leverage"
              title={`최대 ${PAPER_MAX_LEVERAGE}x`}
              style={sel}
            >
              {LEVERAGES.map(l => <option key={l} value={l}>{l}x</option>)}
            </select>
            </span>
          ) : null}
      </div>

      {/* ── 0~100% 비중 ── */}
      <SizingSlider
        availableBalance={availableBalance}
        percent={form.percent} onPercent={form.setPercent}
        sizing={form.sizing}
        leverage={form.lev} scope={scope}
        symbol={symbol.replace(/USDT$/, '')}
        disabled={!canOrder}
      />

      {/* ── 손절 거리 ──
          사이징이 아니다. 위 슬라이더는 "얼마나 크게", 이 줄은 "어디서 나올까"다.
          **선물은 손절이 필수다**(`buildPaperPlan`) — 그래서 이 줄이 숨으면
          주문 자체가 불가능해진다. 실기에서 그렇게 막혔다. */}
      {!unsupported(form.caps.stopLoss) ? (
        <div data-testid={fieldTestId('TP_SL')}
          style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          {/* 한 덩어리로 읽혀야 한다. 실기에서 `손절` / `거리`가 두 줄로
              갈라져 서로 다른 칸 이름처럼 보였다 — 좁아서 접힌 게 아니라
              내가 세로 20px을 아끼려고 `<br/>`을 직접 넣어 둔 것이었다.
              넓은 화면에서도 늘 갈라졌다. 줄이려면 글자를 쪼갤 게 아니라
              줄바꿈을 막는다. */}
          <span style={{
            flexShrink: 0, fontSize: FS.nano, color: C.faint, fontWeight: 700,
            whiteSpace: 'nowrap',
          }}>손절거리</span>
          <div style={{ display: 'flex', gap: 3, flex: 1, minWidth: 0 }}>
            {STOP_PCTS.map(p => (
              <button key={p} type="button"
                onClick={() => { form.setSlPct(form.slPct === p ? null : p); form.setSl(''); }}
                data-testid={`sl-${p}`}
                style={{
                  flex: 1, minWidth: 0, minHeight: 26, padding: '2px 0', borderRadius: 5,
                  border: `1px solid ${form.slPct === p && !form.sl ? C.accent : C.hair}`,
                  background: form.slPct === p && !form.sl ? C.accentBg : C.raised,
                  color: form.slPct === p && !form.sl ? C.accent : C.dim,
                  fontSize: FS.nano, fontWeight: 700, cursor: 'pointer', ...NUM,
                }}>{p}%</button>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── 익절 · 손절가 직접 입력 ── */}
      <div style={{ display: 'flex', gap: 4, minWidth: 0 }}>
        {!unsupported(form.caps.takeProfit) ? (
          <Mini label="익절가" value={form.tp} onChange={form.setTp} testid="tp-input"/>
        ) : null}
        {!unsupported(form.caps.stopLoss) ? (
          <Mini label="손절가" value={form.sl} onChange={form.setSl} testid="sl-input"/>
        ) : null}
      </div>

      {/* 예상값과 막힌 사유는 **이 칸 밖**에 있다(`OrderEstimate`).
          좁은 기기에서 이 칸은 안에서 스크롤한다 — 증거금·청산가가 그
          스크롤에 딸려 올라가면 주문 직전에 안 보인다. */}
    </div>
  );
}

const sel: React.CSSProperties = {
  flex: 1, minWidth: 0, minHeight: 28, borderRadius: 6,
  background: C.raised, color: C.text, border: `1px solid ${C.hair}`,
  fontSize: FS.micro, fontWeight: 700, padding: '0 4px', outline: 'none', cursor: 'pointer',
};

/**
 * 가격 한 칸.
 *
 * 라벨을 제 줄에 두지 않고 `placeholder`와 `aria-label`로 내린다 — 320px
 * 에서 그 줄 하나가 22px이고, 그만큼 아래 예상값이 화면 밖으로 밀렸다.
 * **읽을 수 있는 이름은 없어지지 않는다**(스크린리더는 `aria-label`을,
 * 눈은 비어 있을 때 `placeholder`를 읽는다).
 */
function Mini({ label, value, onChange, testid }: {
  label: string; value: string; onChange: (v: string) => void; testid: string;
}) {
  return (
    <input
      type="number" inputMode="decimal" value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={label} aria-label={label} title={label}
      data-testid={testid}
      style={{
        flex: 1, boxSizing: 'border-box', minWidth: 0,
        background: C.raised, color: C.text,
        border: `1px solid ${C.hair}`, borderRadius: 6,
        padding: '5px 6px', fontSize: FS.micro, outline: 'none', ...NUM,
      }}
    />
  );
}

// ────────────────────────────────────────────────────────────────────
/**
 * **증거금 · 수수료 · 청산가 · 막힌 사유 — 주문 칸 밖에 산다.**
 *
 * 왜 밖으로 뺐나
 * ──────────────
 * 320×600에서는 주문 칸이 제 높이를 다 못 받아 **그 칸만 안에서 스크롤**
 * 한다. 이 블록이 그 안에 있으면 증거금과 청산가가 스크롤에 딸려 올라가
 * **누르기 직전에 안 보인다.** 얼마가 잠기고 어디서 청산되는지 모른 채
 * 누르는 화면을 만들지 않는다.
 *
 * 값은 서버가 부르는 `buildPaperPlan` 그대로다. 여기서 계산하지 않는다.
 */
export function OrderEstimate({ form, scope }: { form: TradeForm; scope: MoneyScope }) {
  const money = (v: number | null) => formatMoneyForScope(v, scope);
  const { plan, gate } = form;

  return (
    <div data-testid="order-estimate-row" style={{
      display: 'flex', flexDirection: 'column', gap: 2,
      padding: '4px 8px', borderTop: `1px solid ${C.hair}`,
      background: C.panel, fontSize: FS.nano, minWidth: 0,
    }}>
      <div data-testid="order-estimate" style={{
        display: 'flex', gap: 10, flexWrap: 'wrap', minWidth: 0,
      }}>
        {/* 수량이 맨 앞이다. **실제로 사는 것**이고, 슬라이더 칸이 스크롤해도
            이 줄은 움직이지 않는다.

            값은 `useTradeForm.sizing`이다 — 주문 본문에 실려 나가는 바로
            그 수량이고, `buildPaperPlan`도 이 값을 입력으로 받는다. 여기서
            다시 계산하지 않는다. */}
        <Est label="수량"
          value={form.quantity == null
            ? '—' : form.quantity.toFixed(form.quantity < 1 ? 6 : 4)}
          testid="est-qty"/>
        <Est label="증거금" value={plan.ok ? money(plan.requiredMargin) : '—'} testid="est-margin"/>
        <Est label="수수료" value={plan.ok ? money(plan.entryFee) : '—'} testid="est-fee"/>
        {/* 청산가는 **선물에만 있는 개념**이다. 현물에서 0으로 적으면
            "0원에 청산"으로 읽힌다 — 칸 자체를 그리지 않는다. */}
        {!form.spot ? (
          <span data-testid={fieldTestId('LIQUIDATION_PRICE')} style={{ display: 'contents' }}>
            <Est label="청산가"
              value={plan.liquidationPrice == null ? '—' : plan.liquidationPrice.toFixed(2)}
              testid="est-liq"/>
          </span>
        ) : null}
      </div>

      {/* ── ★ 막혔으면 왜 막혔는지 ──
          실기에서 로그인·잔고·수량이 다 있는데 버튼만 회색이었고 사유가
          화면 어디에도 없었다. 판정은 맞았고 **말을 안 한 것이 고장**이었다. */}
      {gate.reason ? (
        <div data-testid="order-blocked-reason" style={{
          color: C.warn, lineHeight: 1.35, minWidth: 0,
        }}>{gate.reason}</div>
      ) : null}

      {form.message ? (
        <div data-testid="order-message" style={{
          color: form.message.ok ? C.up : C.down, lineHeight: 1.35,
        }}>{form.message.text}</div>
      ) : null}

      {/* 최종 판정은 서버다. 화면 숫자를 약속으로 읽지 않게 적어 둔다. */}
      <div data-testid="server-recalc-note" style={{ color: C.faint, lineHeight: 1.3 }}>
        최종 허용 수량은 주문할 때 서버가 다시 계산합니다.
      </div>
    </div>
  );
}

/**
 * 값 한 줄.
 *
 * **줄이지 않는다.** 좁아도 `...`로 자르지 않고 아래로 내린다 — 잘린
 * 명목가는 읽는 사람이 자릿수를 잘못 세게 만든다(실기에서 잘렸다).
 */
function Est({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, minWidth: 0, alignItems: 'baseline' }}>
      <span style={{ color: C.faint, flexShrink: 0 }}>{label}</span>
      <span data-testid={testid} style={{
        ...NUM, color: C.dim, fontWeight: 700,
        minWidth: 0, overflowWrap: 'anywhere',
      }}>{value}</span>
    </span>
  );
}
