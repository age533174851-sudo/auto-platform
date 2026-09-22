'use client';
// src/lib/trading/useTradeForm.ts
//
// **주문 한 건의 상태와 판정 — 화면 없이.**
//
// 왜 떼어내는가
// ─────────────
// 모바일은 한 화면에 주문·호가·차트를 같이 놓고, 데스크톱은 다른 배치를
// 쓴다. 배치가 둘인데 **판정까지 둘이면** 같은 입력에서 다른 수량이 나오고,
// 그 차이는 체결된 뒤에야 보인다.
//
// 그래서 방향·마진모드·배율·비중·손절·익절과 그로부터 나오는 계획·수량·
// 주문 전송을 전부 여기 둔다. 화면은 값을 읽고 함수를 부를 뿐이다.
//
// 여기서 만들지 않는 것
// ─────────────────────
//  · 증거금·수수료·청산가 — `buildPaperPlan`이 낸다(서버가 부르는 그 함수)
//  · 수량 — `planSizing`이 낸다
//  · 손절가 — 퍼센트만 보내고 **서버가 자기 마크가로** 만든다
//  · 잠금 사유 — `submitGate`가 정한다
import { useMemo, useState } from 'react';
import { buildPaperPlan, type MarginMode, type PaperPlanResult } from '../engine/paperPlan';
import { planSizing, type SizingResult } from './positionSizing';
import { previewStopPrice, stopChoiceOf, stopRequestFields } from './stopPresets';
import { targetRequestFields, type PaperTarget } from './paperTarget';
import { orderCapability, unsupported, type Support } from './capability';
import { submitGate, submitLabel, type SubmitGate } from './submitGate';

export type TradeSide = 'LONG' | 'SHORT';
export type PaperMarket = 'SPOT' | 'USDM';

/** 화면에 그대로 적을 수 있는 배율 목록. 서버 상한은 `PAPER_MAX_LEVERAGE`다 */
export const LEVERAGES = [1, 3, 5, 10, 20, 50, 100];

export interface TradeFormInput {
  symbol: string;
  market: PaperMarket;
  /** 체결 기준가. 못 읽으면 null — 수량도 계획도 만들지 않는다 */
  price: number | null;
  target: PaperTarget;
  availableBalance: number | null;
  /** 잔고를 못 읽은 사유. 화면이 그대로 적는다 */
  availableUnknownReason?: string | null;
  /** 이 장부·모드에서 주문을 받는가 */
  canOrder: boolean;
  /** 못 받는 사유 */
  blockedReason?: string | null;
  onSubmitted?: () => void;
}

export interface TradeForm {
  side: TradeSide; setSide: (s: TradeSide) => void;
  /** 사용자가 방향을 실제로 눌렀는가. 안 눌렀으면 `submit()`이 나가지 않는다 */
  sideChosen: boolean;
  /** 방향을 고른다 — 이것을 거쳐야 `sideChosen`이 선다 */
  chooseSide: (s: TradeSide) => void;
  marginMode: MarginMode; setMarginMode: (m: MarginMode) => void;
  leverage: number; setLeverage: (n: number) => void;
  /** 유효 배율 — 현물은 언제나 1이다 */
  lev: number;
  percent: number; setPercent: (p: number) => void;
  tp: string; setTp: (v: string) => void;
  /** 손절**가** 직접 입력 */
  sl: string; setSl: (v: string) => void;
  /** 손절 **거리**(%) 프리셋 */
  slPct: number | null; setSlPct: (p: number | null) => void;

  spot: boolean;
  caps: {
    short: Support; leverage: Support; marginMode: Support;
    stopLoss: Support; takeProfit: Support;
  };
  shortDisabled: boolean;

  sizing: SizingResult;
  quantity: number | null;
  /** 미리보기 손절가. **주문 본문에 들어가지 않는다** */
  previewStop: number | null;
  /** 증거금·수수료·청산가의 정본 */
  plan: PaperPlanResult;
  gate: SubmitGate;
  submitText: string;
  sideLabel: (s: TradeSide) => string;

  busy: boolean;
  message: { ok: boolean; text: string } | null;
  submit: () => Promise<void>;
}

export function useTradeForm(i: TradeFormInput): TradeForm {
  const spot = i.market === 'SPOT';
  const [side, setSide] = useState<TradeSide>('LONG');
  // ── 사용자가 방향을 **실제로 눌렀는가** ──
  //
  // 이 깃발이 없던 동안 방향 초기값 `'LONG'`이 곧 "LONG을 골랐다"로 읽혔다.
  // 그래서 LONG은 한 번 눌러도 주문이 나가고 SHORT는 두 번 눌러야 하는
  // 비대칭이 생겼다. (그 전 시트 구조에서는 더 나빴다 — 첫 화면에서
  // SHORT를 눌러도 열린 주문판의 방향은 항상 LONG이었다.)
  //
  // 미리보기 계산에는 방향이 하나 필요하므로 `side`는 그대로 두되,
  // **주문은 누른 적이 있어야만** 나간다.
  const [sideChosen, setSideChosen] = useState(false);
  const chooseSide = (s: TradeSide) => { setSide(s); setSideChosen(true); };
  const [marginMode, setMarginMode] = useState<MarginMode>('ISOLATED');
  const [leverage, setLeverage] = useState(spot ? 1 : 10);
  const [percent, setPercent] = useState(0);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [slPct, setSlPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const lev = spot ? 1 : leverage;

  // 능력 표는 화면이 만들지 않는다. 서버가 못 하는 칸은 여기서도 안 연다.
  const caps = {
    short: orderCapability(i.market, 'SIDE_SHORT'),
    leverage: orderCapability(i.market, 'LEVERAGE'),
    marginMode: orderCapability(i.market, 'MARGIN_MODE'),
    stopLoss: orderCapability(i.market, 'STOP_LOSS'),
    takeProfit: orderCapability(i.market, 'TAKE_PROFIT'),
  };

  const sizing = planSizing({
    availableBalance: i.availableBalance, percent, price: i.price, leverage: lev,
  });
  const quantity = sizing.quantity;

  // 손절은 프리셋(%)과 직접입력(가격) 중 **하나만** 나간다.
  const stop = stopChoiceOf(slPct, sl);
  const previewStop = spot ? null
    : stop.kind === 'PRICE' ? stop.price
    : stop.kind === 'PCT' ? previewStopPrice(i.price, side, stop.pct)
    : null;

  // 서버가 쓰는 계산 그대로. 미리보기 식을 새로 적지 않는다.
  const plan = useMemo(() => buildPaperPlan({
    symbol: i.symbol, side, market: i.market,
    quantity: quantity ?? 0,
    leverage: lev,
    markPrice: i.price,
    stopPrice: previewStop,
    takeProfit: tp ? Number(tp) : null,
    availableBalance: i.availableBalance,
    marginMode: spot ? 'ISOLATED' : marginMode,
  }), [i.symbol, side, i.market, quantity, lev, i.price, previewStop, tp,
       i.availableBalance, marginMode, spot]);

  // **막혔으면 이유도 같이 나온다.** 이유 없는 잠금은 만들지 않는다.
  const gate = submitGate({
    canOrder: i.canOrder,
    blockedReason: i.blockedReason,
    quantity,
    sizingReason: i.availableUnknownReason || (sizing.code === 'OK' ? null : sizing.reason),
    planOk: plan.ok,
    planReason: plan.reason,
  });

  const sideLabel = (s: TradeSide) =>
    spot ? (s === 'LONG' ? 'BUY' : 'SELL') : s;
  const submitText = submitLabel(gate, sideLabel(side), i.symbol);

  const submit = async () => {
    if (!gate.ready || busy) return;
    // **누르지 않은 방향으로 내보내지 않는다.** 화면이 어떻게 배치되든
    // 주문 방향은 사용자가 고른 것이어야 한다.
    if (!sideChosen) return;
    setBusy(true); setMessage(null);
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
        symbol: i.symbol, side, market: i.market,
        quantity,
        // 현물에는 배율이 없다. 보내지 않는다.
        ...(spot ? {} : { leverage: lev, marginMode }),
        // 손절: 프리셋이면 퍼센트가, 직접 입력이면 가격이 실린다.
        ...(spot ? {} : stopRequestFields(stop)),
        ...(tp ? { takeProfit: Number(tp) } : {}),
        // **장부 식별자는 이것 하나다.** 계좌 id를 보내지 않는다.
        ...targetRequestFields(i.target),
      };

      const r = await fetch('/api/paper/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.ok) {
        setMessage({ ok: false, text: String(d?.message || d?.error || `주문 실패 (HTTP ${r.status})`) });
      } else {
        // ── ★ 서버가 쓴 문장을 버리지 않는다 ──
        //
        //   여기는 `'모의 주문이 체결됐습니다'` 고정 문구였다. 그래서
        //   서버가 응답에 실어 보낸 두 가지가 화면에 닿은 적이 없다:
        //
        //     · 격자를 못 읽어 수량을 **안 맞추고** 보냈다는 사실
        //     · 요청한 수량이 격자에 맞춰 **줄어들었다**는 사실
        //
        //   둘 다 사용자가 누른 것과 실제 체결이 다르다는 뜻인데, 화면은
        //   성공만 알려 주었다. 만들어 놓고 배선을 안 한 경우다.
        //
        //   서버 문장이 비어 있을 때만 기본 문구를 쓴다.
        const text = typeof d?.message === 'string' && d.message.trim()
          ? d.message.trim()
          : '모의 주문이 체결됐습니다';
        setMessage({ ok: true, text });
        setPercent(0);
        i.onSubmitted?.();
      }
    } catch (e: any) {
      setMessage({ ok: false, text: String(e?.message || '주문을 보내지 못했습니다') });
    } finally {
      setBusy(false);
    }
  };

  return {
    side, setSide, sideChosen, chooseSide, marginMode, setMarginMode, leverage, setLeverage, lev,
    percent, setPercent, tp, setTp, sl, setSl, slPct, setSlPct,
    spot, caps, shortDisabled: unsupported(caps.short),
    sizing, quantity, previewStop, plan, gate, submitText, sideLabel,
    busy, message, submit,
  };
}
