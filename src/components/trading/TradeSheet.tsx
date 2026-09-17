'use client';
// src/components/trading/TradeSheet.tsx
//
// **주문을 만드는 한 판.** 호가 · 장부 · 마진모드 · 배율 · 수량 · TP/SL ·
// 예상 증거금/수수료 · 최종 버튼이 한 화면 안에 있다.
//
// 왜 시트인가
// ───────────
// 모바일에서는 차트가 주인공이고 주문은 필요할 때 올라와야 한다. 데스크톱
// 에서는 같은 내용이 오른쪽 열에 그대로 선다 — **판이 하나**라서 두 화면의
// 주문 규칙이 갈릴 일이 없다.
//
// 계산을 여기서 하지 않는다
// ─────────────────────────
// 수량·증거금·수수료·청산가는 서버가 쓰는 것과 **같은 함수**로 만든다
// (`buildPaperPlan`). 미리보기용으로 비슷한 식을 새로 적으면 화면과 체결이
// 달라지고, 그 차이는 체결된 뒤에야 보인다.
//
// 보내는 것
// ─────────
// `challengeId` 하나다. 계좌 id도, 체결가도, 사건 시각도 보내지 않는다 —
// 그것들은 서버가 정한다.
import React, { useMemo, useState } from 'react';
import { C, FS, NUM } from '@/components/terminal/theme';
import { OrderBookView } from './OrderBookView';
import { SizingSlider } from './SizingSlider';
import { buildPaperPlan, PAPER_MAX_LEVERAGE, type MarginMode } from '@/lib/engine/paperPlan';
import { planSizing } from '@/lib/trading/positionSizing';
import { formatMoneyForScope, type MoneyScope } from '@/lib/trading/gameMoney';
import { orderCapability, unsupported } from '@/lib/trading/capability';
import { targetRequestFields, type PaperTarget } from '@/lib/trading/paperTarget';
import {
  STOP_PCTS, previewStopPrice, stopChoiceOf, stopRequestFields,
} from '@/lib/trading/stopPresets';
import {
  sectionVisible, toggleSnap, bookRowsFor, type SheetSnap,
} from '@/lib/trading/sheetSnap';

export type TradeSide = 'LONG' | 'SHORT';

export interface TradeSheetProps {
  symbol: string;
  market: 'SPOT' | 'USDM';
  price: number | null;
  target: PaperTarget;
  scope: MoneyScope;
  availableBalance: number | null;
  availableUnknownReason?: string | null;
  /** 주문을 낼 수 있는가 — 챌린지가 RUNNING이 아니면 false */
  canOrder: boolean;
  /** 못 내는 이유. 화면이 그대로 적는다 */
  blockedReason?: string | null;
  onSubmitted?: () => void;
  onClose?: () => void;
  compact?: boolean;
  /**
   * 시트 자리. **HALF에서는 차트가 위에 남아 있다.**
   * 어느 자리든 주문 버튼은 있다 (`sheetSnap`).
   */
  snap?: SheetSnap;
  onSnapChange?: (s: SheetSnap) => void;
}

const LEVERAGES = [1, 3, 5, 10, 20, 50, 100];

export function TradeSheet({
  symbol, market, price, target, scope, availableBalance, availableUnknownReason,
  canOrder, blockedReason, onSubmitted, onClose, compact,
  snap = 'EXPANDED', onSnapChange,
}: TradeSheetProps) {
  /** 이 칸을 지금 자리에서 그리는가 — 판정은 `sheetSnap` 하나에 있다 */
  const show = (sec: string) => sectionVisible(sec, snap);
  const spot = market === 'SPOT';
  const [side, setSide] = useState<TradeSide>('LONG');
  const [marginMode, setMarginMode] = useState<MarginMode>('ISOLATED');
  const [leverage, setLeverage] = useState(spot ? 1 : 10);
  const [percent, setPercent] = useState(0);
  const [tp, setTp] = useState('');
  /** 직접 입력한 손절**가**. 비어 있으면 아래 프리셋을 쓴다 */
  const [sl, setSl] = useState('');
  /** 고른 손절 **거리**(%). 주문에는 이 값이 실린다 — 가격은 서버가 만든다 */
  const [slPct, setSlPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const lev = spot ? 1 : leverage;

  // 능력 표는 화면이 만들지 않는다. 서버가 못 하는 칸은 여기서도 안 연다.
  const capShort = orderCapability(market, 'SIDE_SHORT');
  const capLev = orderCapability(market, 'LEVERAGE');
  const capMargin = orderCapability(market, 'MARGIN_MODE');
  const capSl = orderCapability(market, 'STOP_LOSS');
  const capTp = orderCapability(market, 'TAKE_PROFIT');

  const sizing = planSizing({ availableBalance, percent, price, leverage: lev });
  const quantity = sizing.quantity;

  // 손절은 프리셋(%)과 직접입력(가격) 중 **하나만** 나간다.
  const stop = stopChoiceOf(slPct, sl);
  // 미리보기용 손절가. 주문 본문에는 들어가지 않는다 (`stopPresets` 머리말).
  const previewSl = spot ? null
    : stop.kind === 'PRICE' ? stop.price
    : stop.kind === 'PCT' ? previewStopPrice(price, side, stop.pct)
    : null;

  // 서버가 쓰는 계산 그대로. 미리보기 식을 새로 적지 않는다.
  const preview = useMemo(() => buildPaperPlan({
    symbol, side, market,
    quantity: quantity ?? 0,
    leverage: lev,
    markPrice: price,
    stopPrice: previewSl,
    takeProfit: tp ? Number(tp) : null,
    availableBalance,
    marginMode: spot ? 'ISOLATED' : marginMode,
  }), [symbol, side, market, quantity, lev, price, previewSl, tp, availableBalance, marginMode, spot]);

  const money = (v: number | null) => formatMoneyForScope(v, scope);
  const ready = canOrder && quantity != null && quantity > 0 && preview.ok;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setMsg(null);
    try {
      let auth: Record<string, string> = {};
      try {
        const { getSupabaseClient } = await import('@/lib/supabase/client');
        const sb = getSupabaseClient();
        if (sb) {
          const { data } = await sb.auth.getSession();
          const t = data?.session?.access_token;
          if (t) auth = { Authorization: `Bearer ${t}` };
        }
      } catch { /* 익명이면 서버가 401로 막는다 */ }

      const body: any = {
        symbol, side, market,
        quantity,
        // 현물에는 배율이 없다. 보내지 않는다.
        ...(spot ? {} : { leverage: lev, marginMode }),
        // 손절: 프리셋이면 **퍼센트**가, 직접 입력이면 가격이 실린다.
        // 프리셋 가격은 서버가 자기 마크가로 만든다 — 화면이 체결 기준을
        // 정하지 않는다.
        ...(spot ? {} : stopRequestFields(stop)),
        ...(tp ? { takeProfit: Number(tp) } : {}),
        // **장부 식별자는 이것 하나다.** 계좌 id를 보내지 않는다.
        ...targetRequestFields(target),
      };

      const r = await fetch('/api/paper/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.ok) {
        setMsg({ ok: false, text: String(d?.message || d?.error || `주문 실패 (HTTP ${r.status})`) });
      } else {
        setMsg({ ok: true, text: '모의 주문이 체결됐습니다' });
        setPercent(0);
        onSubmitted?.();
      }
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || '주문을 보내지 못했습니다') });
    } finally {
      setBusy(false);
    }
  };

  const longLabel = spot ? 'BUY' : 'LONG';
  const shortLabel = spot ? 'SELL' : 'SHORT';

  return (
    <div
      data-testid="trade-sheet"
      data-market={market}
      style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        padding: compact ? 12 : 14, background: C.panel,
        borderTop: `1px solid ${C.hair}`,
      }}
    >
      {onClose ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: FS.sub, fontWeight: 800, color: C.text }}>{symbol} 주문</span>
          {/* ── 자리 전환 ──
              **감춘 것을 말한다.** HALF에서 배율·손절 칸이 안 보이는데
              아무 말이 없으면 사용자는 그 기능이 없다고 읽는다. 지금 값을
              적어 두고, 누르면 펴진다. */}
          {onSnapChange ? (
            <button
              type="button" onClick={() => onSnapChange(toggleSnap(snap))}
              data-testid="trade-sheet-snap"
              data-snap={snap}
              style={{
                flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 7,
                background: C.raised, border: `1px solid ${C.hair}`, color: C.dim,
                fontSize: FS.micro, fontWeight: 700, cursor: 'pointer',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {snap === 'HALF'
                ? `${spot ? '현물' : `${marginMode === 'CROSSED' ? '교차' : '격리'} · ${lev}x`} · 설정 더보기 ▲`
                : '접기 ▼'}
            </button>
          ) : null}
          <button type="button" onClick={onClose} className="switch"
            style={{ background: 'none', border: 'none', color: C.dim, fontSize: FS.title, cursor: 'pointer' }}>✕</button>
        </div>
      ) : null}

      {/* ── ★ 호가창은 접히지 않는다 ── */}
      {/* 주문을 넣는 순간 사용자가 봐야 하는 값이다. 시트 안에서 늘 보이게
          고정 높이를 준다 — 예전에는 아래로 밀려 스크롤 밖으로 나갔다. */}
      <div
        data-testid="trade-sheet-book"
        style={{ border: `1px solid ${C.hair}`, borderRadius: 8, overflow: 'hidden', background: C.bg }}
      >
        {/* 줄 수는 자리가 정한다(`sheetSnap.bookRowsFor`). HALF에서 5줄씩
            쓰면 호가만 245px이라 방향·수량 버튼이 스크롤 밖으로 밀린다. */}
        <OrderBookView symbolId={symbol} market={market} rows={bookRowsFor(snap)} dense
          variant={compact ? 'compact' : 'full'} onPickPrice={undefined}/>
      </div>

      {/* ── 방향 ── */}
      {show('SIDE') && <div style={{ display: 'flex', gap: 6 }}>
        <SideBtn on={side === 'LONG'} tone="up" label={longLabel} onClick={() => setSide('LONG')}/>
        <SideBtn
          on={side === 'SHORT'} tone="down" label={shortLabel}
          disabled={unsupported(capShort)}
          title={unsupported(capShort) ? (capShort as any).reason : undefined}
          onClick={() => setSide('SHORT')}
        />
      </div>}
      {show('SIDE') && unsupported(capShort) ? (
        <div data-testid="trade-sheet-no-short" style={{ fontSize: FS.nano, color: C.faint }}>
          {(capShort as any).reason}
        </div>
      ) : null}

      {/* ── 마진 모드 · 배율 ── */}
      {show('MARGIN_MODE') && !unsupported(capMargin) ? (
        <div style={{ display: 'flex', gap: 6 }}>
          {(['ISOLATED', 'CROSSED'] as MarginMode[]).map(m => (
            <button key={m} type="button" onClick={() => setMarginMode(m)}
              data-testid={`margin-mode-${m}`}
              style={{
                flex: 1, padding: '6px 0', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${marginMode === m ? C.accent : C.hair}`,
                background: marginMode === m ? C.accentBg : C.raised,
                color: marginMode === m ? C.accent : C.dim,
                fontSize: FS.micro, fontWeight: 700,
              }}>{m === 'ISOLATED' ? '격리' : '교차'}</button>
          ))}
        </div>
      ) : null}

      {show('LEVERAGE') && !unsupported(capLev) ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: FS.micro, color: C.dim, fontWeight: 700 }}>
            배율 <span style={{ ...NUM, color: C.accent }}>{lev}x</span>
            <span style={{ color: C.faint, fontWeight: 500 }}> (최대 {PAPER_MAX_LEVERAGE}x)</span>
          </span>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {LEVERAGES.map(l => (
              <button key={l} type="button" onClick={() => setLeverage(l)}
                data-testid={`leverage-${l}`}
                style={{
                  flex: '1 1 40px', padding: '4px 0', borderRadius: 6, cursor: 'pointer',
                  border: `1px solid ${lev === l ? C.accent : C.hair}`,
                  background: lev === l ? C.accentBg : C.raised,
                  color: lev === l ? C.accent : C.dim,
                  fontSize: FS.micro, fontWeight: 700, ...NUM,
                }}>{l}x</button>
            ))}
          </div>
        </div>
      ) : show('LEVERAGE') ? (
        <div style={{ fontSize: FS.nano, color: C.faint }}>{(capLev as any).reason}</div>
      ) : null}

      {/* ── 0~100% 슬라이더 ── */}
      {show('SIZING') && <SizingSlider
        availableBalance={availableBalance}
        unknownReason={availableUnknownReason}
        percent={percent} onPercent={setPercent}
        price={price} leverage={lev} scope={scope}
        symbol={symbol.replace(/USDT$/, '')}
        disabled={!canOrder}
      />}

      {/* ── TP / SL ── */}
      {/* 손절 거리 프리셋은 기존 주문폼(1·2·3·5·10%)에서 그대로 가져왔다.
          **사이징이 아니다** — 위 슬라이더는 "얼마나 크게 들어갈까"이고
          이 줄은 "어디서 나올까"다. 같은 퍼센트처럼 보인다고 묶으면 서로
          다른 결정을 한 칸에서 하게 된다. */}
      {show('STOP_PRESETS') && !unsupported(capSl) ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: FS.micro, color: C.dim, fontWeight: 700 }}>손절 거리</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {STOP_PCTS.map(p => (
              <button key={p} type="button"
                onClick={() => { setSlPct(slPct === p ? null : p); setSl(''); }}
                data-testid={`trade-sheet-sl-${p}`}
                style={{
                  flex: 1, padding: '5px 0', borderRadius: 6, cursor: 'pointer',
                  border: `1px solid ${slPct === p && !sl ? C.accent : C.hair}`,
                  background: slPct === p && !sl ? C.accentBg : C.raised,
                  color: slPct === p && !sl ? C.accent : C.dim,
                  fontSize: FS.micro, fontWeight: 700, ...NUM,
                }}>{p}%</button>
            ))}
          </div>
          {previewSl != null ? (
            <span data-testid="trade-sheet-sl-preview" style={{ fontSize: FS.nano, color: C.faint }}>
              예상 손절가 {previewSl.toFixed(2)} — 실제 값은 주문할 때 서버 마크가로 정해집니다
            </span>
          ) : null}
        </div>
      ) : null}

      {show('TP_SL') && <div style={{ display: 'flex', gap: 6 }}>
        <Field
          label="익절 (TP)" value={tp} onChange={setTp}
          disabled={unsupported(capTp)} reason={(capTp as any).reason}
          testid="trade-sheet-tp"
        />
        <Field
          label="손절가 직접 입력" value={sl} onChange={setSl}
          disabled={unsupported(capSl)} reason={(capSl as any).reason}
          testid="trade-sheet-sl"
        />
      </div>}

      {/* ── 예상치 — 서버와 같은 함수가 낸 값 ── */}
      {show('ESTIMATE') && <div data-testid="trade-sheet-estimate"
        style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: FS.micro,
          background: C.raised, borderRadius: 8, padding: '8px 10px' }}>
        <Est label="예상 증거금" value={preview.ok ? money(preview.requiredMargin) : '—'}/>
        <Est label="예상 수수료" value={preview.ok ? money(preview.entryFee) : '—'}/>
        {!spot ? (
          <Est label="예상 청산가" value={preview.liquidationPrice == null ? '—' : preview.liquidationPrice.toFixed(2)}/>
        ) : null}
        {!preview.ok && quantity != null && quantity > 0 ? (
          <div style={{ color: C.warn, lineHeight: 1.5, marginTop: 2 }}>{preview.reason}</div>
        ) : null}
      </div>}

      {/* ── 최종 버튼 ── */}
      {!canOrder && blockedReason ? (
        <div data-testid="trade-sheet-blocked" style={{ fontSize: FS.micro, color: C.warn, lineHeight: 1.5 }}>
          {blockedReason}
        </div>
      ) : null}

      {/* ── 최종 버튼은 시트 바닥에 붙인다 ──
          실기에서 시트가 길어 이 버튼이 첫 화면 밖에 있었다. 주문 화면에서
          제일 중요한 버튼을 찾으려고 스크롤하게 두지 않는다. */}
      <button
        type="button" onClick={submit} disabled={!ready || busy}
        data-testid="trade-sheet-submit"
        style={{
          position: 'sticky', bottom: 0, zIndex: 2,
          padding: '13px 0', borderRadius: 10, border: 'none',
          boxShadow: `0 -10px 16px -6px ${C.panel}`,
          background: !ready || busy ? C.raised : side === 'LONG' ? C.up : C.down,
          color: !ready || busy ? C.faint : '#fff',
          fontSize: FS.sub, fontWeight: 800,
          cursor: !ready || busy ? 'not-allowed' : 'pointer',
        }}
      >
        {busy ? '보내는 중…' : `${side === 'LONG' ? longLabel : shortLabel} ${symbol}`}
      </button>

      {msg ? (
        <div data-testid="trade-sheet-msg"
          style={{ fontSize: FS.micro, color: msg.ok ? C.up : C.down, lineHeight: 1.5 }}>
          {msg.text}
        </div>
      ) : null}
    </div>
  );
}

function SideBtn({ on, tone, label, onClick, disabled, title }: {
  on: boolean; tone: 'up' | 'down'; label: string;
  onClick: () => void; disabled?: boolean; title?: string;
}) {
  const col = tone === 'up' ? C.up : C.down;
  const bg = tone === 'up' ? C.upBg : C.downBg;
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} title={title}
      data-testid={`trade-side-${label}`}
      style={{
        flex: 1, padding: '9px 0', borderRadius: 8,
        border: `1px solid ${disabled ? C.hair : on ? col : C.hair}`,
        background: disabled ? C.raised : on ? bg : C.raised,
        color: disabled ? C.faint : on ? col : C.dim,
        fontSize: FS.lead, fontWeight: 800,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >{label}</button>
  );
}

function Field({ label, value, onChange, disabled, reason, testid }: {
  label: string; value: string; onChange: (v: string) => void;
  disabled?: boolean; reason?: string; testid: string;
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: FS.nano, color: C.faint }}>{label}</span>
      <input
        type="number" inputMode="decimal" value={disabled ? '' : value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled} placeholder={disabled ? '지원 안 함' : '가격'}
        data-testid={testid}
        title={disabled ? reason : undefined}
        style={{
          width: '100%', boxSizing: 'border-box',
          background: disabled ? C.panel : C.raised,
          color: disabled ? C.faint : C.text,
          border: `1px solid ${C.hair}`, borderRadius: 7,
          padding: '8px 9px', fontSize: FS.body, outline: 'none', ...NUM,
        }}
      />
      {/* 비활성 칸은 **왜** 비활성인지 말한다. "준비 중"이라고 적지 않는다. */}
      {disabled && reason ? (
        <span style={{ fontSize: FS.nano, color: C.faint, lineHeight: 1.4 }}>{reason}</span>
      ) : null}
    </div>
  );
}

function Est({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: C.faint }}>{label}</span>
      <span style={{ ...NUM, color: C.dim, fontWeight: 700 }}>{value}</span>
    </div>
  );
}
