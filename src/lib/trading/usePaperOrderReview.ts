'use client';
// src/lib/trading/usePaperOrderReview.ts
//
// **확인 시트의 껍데기. 판정도 순서도 `paperOrderReview.ts`에 있다.**
//
// 왜 훅이 따로인가
// ────────────────
// 전환 잠금(시장·종목)은 `PaperOrderScreen`에 있고, 시트는 USDⓈ-M 화면
// 안에 있다. 상태를 화면 안에 두면 잠금이 그것을 볼 수 없고, 잠금 쪽에
// 사본을 하나 더 두면 **같은 판단이 두 곳**이 된다 — 이 저장소가 이름 붙인
// 2번 고장이다.
//
// 그래서 `form`과 **같은 자리**에서 한 번 만들고 아래로 넘긴다.
// `useTradeForm`이 이미 그 규칙으로 살고 있다.
//
// ★ 여기에 if가 없다
// ──────────────────
// "취소하면 안 나간다" · "두 번 눌러도 한 번만" · "여는 것만으로는 아무
// 요청도 안 나간다"는 전부 순서에 관한 사실이고, `useState` 안에 있으면
// 시험이 닿지 못한다. 전이는 `reviewReduce`가 하고, 이 파일은 그것이 돌려준
// 부수효과를 실행할 뿐이다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  confirmVerdict, reviewPhaseOf, reviewReduce, reviewRows, sameTicket, ticketKey,
  REVIEW_CLOSED,
  type ConfirmVerdict, type ReviewEnv, type ReviewEvent, type ReviewPhase,
  type ReviewRow, type ReviewState, type ReviewTicket,
} from './paperOrderReview';
import type { MarginMode } from '../engine/paperPlan';
import type { TradeForm } from './useTradeForm';

export interface PaperOrderReview {
  phase: ReviewPhase;
  /** 열려 있으면 그때 붙잡은 주문. 닫혀 있으면 null */
  ticket: ReviewTicket | null;
  /** 지금 화면에 적을 줄들. 닫혀 있으면 빈 배열 */
  rows: ReviewRow[];
  /** 확인 버튼 판정 — **색 · DOM · 클릭이 이것 하나를 본다** */
  verdict: ConfirmVerdict;
  open: () => void;
  cancel: () => void;
  confirm: () => void;
  /** 주문 결과. 실패해도 시트를 닫지 않고 이것을 보여 준다 */
  message: TradeForm['message'];
}

export interface PaperOrderReviewInput {
  form: TradeForm;
  /** 사람이 읽는 시장 이름. 화면이 지어내지 않고 능력표에서 온다 */
  marketLabel: string;
  /** 이 시장의 방향 말 */
  sideLabel: string;
  /** 주문 방식 이름. 모의 장부는 시장가뿐이다 */
  orderTypeLabel: string;
  /** 지금 진입 화면인가. 청산 탭에서는 열리지 않는다 */
  intentOpen: boolean;
  /** `ctaVerdict`가 정한 할 일. `'OPEN_REVIEW'`가 아니면 열지 않는다 */
  ctaAction: string;
}

export function usePaperOrderReview(i: PaperOrderReviewInput): PaperOrderReview {
  const { form } = i;
  const [state, setState] = useState<ReviewState>(REVIEW_CLOSED);

  /** 지금 폼이 실제로 다루는 주문. **화면이 아니라 폼에서 온다** */
  const current: ReviewTicket | null = useMemo(
    () => (form.symbol ? { market: form.market, symbol: form.symbol, side: form.side } : null),
    [form.market, form.symbol, form.side],
  );

  const env: ReviewEnv = {
    current,
    gateReady: !!form.gate.ready,
    busy: !!form.busy,
    intentOpen: !!i.intentOpen,
    ctaAction: i.ctaAction,
  };

  const phase = reviewPhaseOf(state, env.busy);

  // ── 전이 ──
  //
  //   상태는 `reviewReduce`가 정하고, 이 함수는 그것이 돌려준 부수효과를
  //   실행할 뿐이다. `setState`의 갱신 함수는 StrictMode에서 두 번 불릴 수
  //   있으므로 **효과는 그 밖에서 한 번만** 낸다.
  const stateRef = useRef(state);
  stateRef.current = state;
  const envRef = useRef(env);
  envRef.current = env;

  const dispatch = useCallback((e: ReviewEvent) => {
    const step = reviewReduce(stateRef.current, envRef.current, e);
    stateRef.current = step.state;
    setState(step.state);
    if (!step.effects.includes('SUBMIT')) return;
    // ★ 결과를 **상태를 엿봐서** 알아내지 않는다. `submit()`이 값으로
    //   돌려준다 — 성공이면 닫고 실패면 열어 둔다.
    void form.submit().then(r => {
      dispatch({ type: 'RESULT', ok: r.sent && r.ok });
    });
  }, [form]);

  // ── 붙잡은 주문이 바뀌었는가 ──
  const lastKey = useRef(ticketKey(null));
  const curKey = ticketKey(current);
  useEffect(() => {
    if (lastKey.current === curKey) return;
    lastKey.current = curKey;
    dispatch({ type: 'IDENTITY' });
  }, [curKey, dispatch]);

  const verdict = confirmVerdict({
    phase, opened: state.opened, current, gateReady: env.gateReady, busy: env.busy,
  });

  const open = useCallback(() => dispatch({ type: 'OPEN' }), [dispatch]);
  const cancel = useCallback(() => dispatch({ type: 'CANCEL' }), [dispatch]);
  const confirm = useCallback(() => dispatch({ type: 'CONFIRM' }), [dispatch]);

  const rows = useMemo(() => (state.opened == null ? [] : reviewRows({
    market: state.opened.market,
    marketLabel: i.marketLabel,
    symbol: state.opened.symbol,
    side: state.opened.side,
    sideLabel: i.sideLabel,
    orderTypeLabel: i.orderTypeLabel,
    // ★ 값은 **지금 폼**에서 온다. 열 때 얼려 두지 않는다 — 얼린 숫자를
    //   보여 주고 다른 값으로 보내면 그것이 바로 보이는 것과 나가는 것이
    //   다른 상태다. 정체가 바뀌면 위에서 시트를 닫는다.
    referencePrice: form.referencePrice,
    quantity: form.quantity,
    leverage: form.lev,
    marginMode: (form.spot ? 'ISOLATED' : form.marginMode) as MarginMode,
    plan: form.plan,
  })), [state.opened, i.marketLabel, i.sideLabel, i.orderTypeLabel,
        form.referencePrice, form.quantity, form.lev, form.spot, form.marginMode, form.plan]);

  return {
    phase,
    ticket: state.opened,
    rows,
    verdict,
    open,
    cancel,
    confirm,
    message: form.message,
  };
}

export { sameTicket };
