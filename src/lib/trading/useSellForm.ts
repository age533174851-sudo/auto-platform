// src/lib/trading/useSellForm.ts
//
// **매도 화면의 경계 인터페이스.** 간편 화면과 프로 패널이 **같은 이것**을
// 받는다. `useTradeForm`이 매수에서 하는 일을 매도에서 한다.
//
// 이 훅은 판단하지 않는다
// ───────────────────────
//   보유·평단   `/api/paper/holdings` (`paper_holdings`)
//   금액 검증   `sellAmountOf` — **서버가 부르는 그 함수**
//   잠금 사유   `sellPlan.sellGate`
//   실행        `/api/paper/sell` → `paper_sell_holding`
//   계좌        `challengeId` 하나만 싣는다. 계좌 id를 싣지 않는다
//
// ★ `uiLevel`을 입력으로 받지 않는다
// ──────────────────────────────────
// 받는 순간 "간편에서는 이렇게, 프로에서는 저렇게" 계산하는 길이 열린다.
// 그러면 같은 주문이 화면 설정에 따라 다른 값으로 나간다. 두 모드는
// **이 훅의 결과를 다르게 그릴 뿐**이다.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { targetQuery, targetRequestFields, type PaperTarget } from './paperTarget';
import { orderCapability, type Support } from './capability';
import type { PaperMarket } from './useTradeForm';
import {
  holdingFor, sellRequestOf, sellGate, sellSubmitLabel, approxSellQuantity,
  newClientSellId,
  type SellHolding, type SellInputMode, type SellGate,
} from './sellPlan';
import type { SellAmount } from '../engine/paperSellRequest';

export interface SellFormInput {
  symbol: string;
  market: PaperMarket;
  target: PaperTarget;
  /** 화면이 살아 있는 동안만 읽는다 */
  enabled?: boolean;
  /** 팔고 난 뒤 바깥 장부를 다시 읽게 한다 */
  onSold?: () => void;
}

export interface SellForm {
  /** 보유 조회 상태. **ERROR와 "보유 없음"은 다르다** */
  state: 'LOADING' | 'READY' | 'ERROR';
  holding: SellHolding | null;
  /** 조회 실패 사유. 성공이면 null */
  error: string | null;

  mode: SellInputMode;
  /** 칸을 바꾸면 **반대쪽 칸을 비운다** — 둘 다 실리는 일이 없게 */
  setMode: (m: SellInputMode) => void;
  percent: number | null;
  setPercent: (p: number | null) => void;
  quantityText: string;
  setQuantityText: (v: string) => void;

  /** 지금 요청에 실릴 금액 칸. **서버와 같은 함수가 만든 값이다** */
  request: SellAmount;
  /** 비율을 눌렀을 때의 **예상** 수량. 요청에 실리지 않는다 */
  approxQuantity: number | null;
  supported: Support;
  gate: SellGate;
  submitText: string;

  busy: boolean;
  message: { ok: boolean; text: string } | null;
  submit: () => Promise<void>;
  reload: () => void;
}

async function authHeader(): Promise<Record<string, string>> {
  try {
    const { getSupabaseClient } = await import('@/lib/supabase/client');
    const sb = getSupabaseClient();
    if (!sb) return {};
    const { data } = await sb.auth.getSession();
    const tok = data?.session?.access_token;
    return tok ? { Authorization: `Bearer ${tok}` } : {};
  } catch { return {}; }
}

/** 조회 실패를 사람 말로. **"보유 0"이라고 적지 않는다** */
function readError(status: number, d: any): string {
  if (typeof d?.message === 'string' && d.message) return d.message;
  if (status === 401) return '로그인하면 보유를 읽어 옵니다';
  if (d?.error === 'challenge_not_found') return '고른 챌린지를 찾지 못했습니다';
  return '보유를 읽지 못했습니다 — 보유가 없다는 뜻이 아닙니다';
}

export function useSellForm(i: SellFormInput): SellForm {
  const enabled = i.enabled !== false;

  const [state, setState] = useState<'LOADING' | 'READY' | 'ERROR'>('LOADING');
  const [holdings, setHoldings] = useState<SellHolding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const [mode, setModeRaw] = useState<SellInputMode>('PERCENT');
  const [percent, setPercent] = useState<number | null>(null);
  const [quantityText, setQuantityText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // ── 재시도는 **같은 식별자로** 나간다 ──
  //
  // 실패했을 때 새 id를 만들면, 첫 요청이 사실 성공했는데 응답만 못 받은
  // 경우에 두 번 팔린다. 088은 같은 id + 같은 내용을 `REPLAYED`로 답해
  // 그것을 막는데, id가 매번 달라지면 그 보호가 작동하지 않는다.
  // 성공한 뒤에만 버린다.
  const sellId = useRef<string>('');

  const reload = useCallback(() => setTick(n => n + 1), []);

  const setMode = useCallback((m: SellInputMode) => {
    setModeRaw(m);
    // **반대쪽 칸을 비운다.** 둘 다 값이 남아 있으면 `sellAmountOf`가
    // `AMBIGUOUS`로 거부한다 — 화면이 그 상태를 만들 이유가 없다.
    if (m === 'PERCENT') setQuantityText('');
    else setPercent(null);
  }, []);

  const query = targetQuery(i.target);

  // 장부가 바뀌면 이전 장부의 보유를 남겨 두지 않는다. 챌린지를 고른 순간
  // 기본 계좌 보유가 잠깐 보이면 그걸로 매도 수량을 정한다.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState('LOADING'); setHoldings(null); setError(null);

    (async () => {
      try {
        const r = await fetch(`/api/paper/holdings${query}`, {
          headers: { ...(await authHeader()) }, cache: 'no-store',
        });
        const d = await r.json().catch(() => null);
        if (cancelled) return;
        if (!r.ok || !d?.ok || !Array.isArray(d.holdings)) {
          setState('ERROR'); setError(readError(r.status, d)); return;
        }
        setHoldings(d.holdings as SellHolding[]);
        setState('READY');
      } catch {
        if (cancelled) return;
        setState('ERROR');
        setError('보유를 읽지 못했습니다 — 보유가 없다는 뜻이 아닙니다');
      }
    })();

    return () => { cancelled = true; };
  }, [enabled, query, tick]);

  const holding = useMemo(
    () => holdingFor(holdings, i.symbol, i.market),
    [holdings, i.symbol, i.market]);

  // 능력은 화면이 정하지 않는다. 088 이후 현물만 나눠 팔 수 있다.
  const supported = orderCapability(i.market, 'PARTIAL_CLOSE');

  const request = useMemo(
    () => sellRequestOf({ mode, percent, quantityText }),
    [mode, percent, quantityText]);

  const gate = useMemo(() => sellGate({
    supported,
    holdingRead: state === 'READY',
    holding,
    request,
  }), [supported, state, holding, request]);

  const approxQuantity = useMemo(
    () => (mode === 'PERCENT' ? approxSellQuantity(holding, percent) : null),
    [mode, holding, percent]);

  const submit = async () => {
    if (busy || !gate.ready) return;
    if (request.ok !== true) return;

    setBusy(true); setMessage(null);
    try {
      if (!sellId.current) {
        sellId.current = newClientSellId(Date.now(), Math.random());
      }
      const body: any = {
        symbol: i.symbol,
        clientSellId: sellId.current,
        // **하나만 싣는다.** 둘 다 실으면 서버가 AMBIGUOUS로 거부한다.
        ...(request.percent != null ? { percent: request.percent } : {}),
        ...(request.quantity != null ? { quantity: request.quantity } : {}),
        // **장부 식별자는 이것 하나다.** 계좌 id를 보내지 않는다.
        ...targetRequestFields(i.target),
      };

      const r = await fetch('/api/paper/sell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => null);

      if (!r.ok || !d?.ok) {
        setMessage({ ok: false, text: String(d?.message || d?.error || `매도 실패 (HTTP ${r.status})`) });
        return;                       // ★ sellId를 버리지 않는다 — 다음 시도가 같은 id로 나간다
      }

      // 팔린 수량·손익은 **응답이 말한다.** 화면이 계산하지 않는다.
      setMessage({ ok: true, text: String(d.message || '모의 매도가 처리됐습니다') });
      sellId.current = '';            // 다음은 새 매도다
      setPercent(null); setQuantityText('');
      reload();
      i.onSold?.();
    } catch (e: any) {
      setMessage({ ok: false, text: String(e?.message || '매도를 보내지 못했습니다') });
    } finally {
      setBusy(false);
    }
  };

  return {
    state, holding, error,
    mode, setMode, percent, setPercent, quantityText, setQuantityText,
    request, approxQuantity, supported, gate,
    submitText: sellSubmitLabel(gate, i.symbol),
    busy, message, submit, reload,
  };
}
