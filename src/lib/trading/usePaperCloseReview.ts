'use client';
// src/lib/trading/usePaperCloseReview.ts
//
// **청산 확인 창의 껍데기. 판정도 순서도 `paperCloseReview.ts`에 있다.**
//
// ★ 청산 요청이 나가는 자리는 **이 파일 한 곳**이다
// ──────────────────────────────────────────────────
// 예전에는 포지션 줄이 직접 `fetch('/api/paper/close')`를 불렀다. 줄마다
// 부를 수 있으면 "첫 클릭에는 안 나간다"를 지킬 곳이 화면 수만큼 늘어난다.
// 이제 전이(`closeReviewReduce`)가 `'CLOSE'` 부수효과를 낼 때만 여기서
// 한 번 보낸다.
//
// 본문은 `closeRequestBody()`가 만든다 — `{ positionId }` 하나뿐이고,
// 가격도 계좌도 보내지 않는다. 서버가 포지션에서 스스로 찾는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CLOSE_REVIEW_CLOSED, closeConfirmVerdict, closeRequestBody, closeReviewPhaseOf,
  closeReviewReduce, closeRows,
  type CloseConfirmVerdict, type CloseReviewEnv, type CloseReviewEvent,
  type CloseReviewPhase, type CloseReviewState, type CloseRow, type CloseTicket,
  type ClosePositionView,
} from './paperCloseReview';

export interface PaperCloseReview {
  phase: CloseReviewPhase;
  /** 열려 있으면 그때 붙잡은 포지션. 닫혀 있으면 null */
  ticket: CloseTicket | null;
  /** 그 포지션의 지금 장부 값. 사라졌으면 null */
  position: ClosePositionView | null;
  /** 화면에 적을 줄들. 닫혀 있으면 빈 배열 */
  rows: CloseRow[];
  /** 확인 버튼 판정 — **색 · DOM · 클릭이 이것 하나를 본다** */
  verdict: CloseConfirmVerdict;
  open: (positionId: string) => void;
  cancel: () => void;
  confirm: () => void;
  /** 실패 사유. 실패해도 창을 닫지 않고 이것을 보여 준다 */
  message: { ok: boolean; text: string } | null;
}

export interface PaperCloseReviewInput {
  /** `usePaperLedger`가 준 그대로. 여기서 다시 읽지 않는다 */
  positions: readonly ClosePositionView[];
  /** Authorization 헤더 값. 없으면 청산할 수 없다 */
  auth?: string;
  /** 청산 뒤 장부를 다시 읽는다 — `ledger.reload` */
  onClosed: () => void;
}

export function usePaperCloseReview(i: PaperCloseReviewInput): PaperCloseReview {
  const [state, setState] = useState<CloseReviewState>(CLOSE_REVIEW_CLOSED);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const openIds = useMemo(
    () => i.positions.map(p => String(p.id)), [i.positions]);
  const idsKey = openIds.join(',');

  const env: CloseReviewEnv = { openIds, hasAuth: !!i.auth, busy };
  const phase = closeReviewPhaseOf(state, busy);

  const stateRef = useRef(state);
  stateRef.current = state;
  const envRef = useRef(env);
  envRef.current = env;
  const authRef = useRef(i.auth);
  authRef.current = i.auth;
  const onClosedRef = useRef(i.onClosed);
  onClosedRef.current = i.onClosed;

  const dispatch = useCallback((e: CloseReviewEvent) => {
    const step = closeReviewReduce(stateRef.current, envRef.current, e);
    stateRef.current = step.state;
    setState(step.state);
    if (!step.effects.includes('CLOSE')) return;

    // ── ★ 청산 요청 — 저장소에서 이 한 곳 ──
    const id = step.state.opened?.positionId || '';
    const auth = authRef.current;
    if (!id || !auth) { dispatch({ type: 'RESULT', ok: false }); return; }
    setBusy(true); setMessage(null);
    void (async () => {
      let ok = false;
      try {
        const r = await fetch('/api/paper/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify(closeRequestBody(id)),
        });
        const d = await r.json().catch(() => null);
        ok = r.ok && !!d?.ok;
        if (ok) {
          setMessage({ ok: true, text: String(d?.message || '포지션을 청산했습니다') });
          onClosedRef.current();
        } else {
          setMessage({ ok: false, text: String(d?.message || d?.error || `청산 실패 (${r.status})`) });
        }
      } catch (e: any) {
        setMessage({ ok: false, text: String(e?.message || '청산 요청을 보내지 못했습니다') });
      } finally {
        setBusy(false);
        dispatch({ type: 'RESULT', ok });
      }
    })();
  }, []);

  // ── 장부가 바뀌었는가 ──
  //
  //   창에는 A가 적혀 있는데 A가 닫혔으면, 그 창은 더 이상 이 화면의 일이
  //   아니다. **다른 포지션으로 재사용하지 않는다** — 닫는다.
  const lastIds = useRef('');
  useEffect(() => {
    if (lastIds.current === idsKey) return;
    lastIds.current = idsKey;
    dispatch({ type: 'LEDGER' });
  }, [idsKey, dispatch]);

  const position = useMemo(() => {
    const id = state.opened?.positionId;
    if (!id) return null;
    return i.positions.find(p => String(p.id) === id) ?? null;
  }, [state.opened, i.positions]);

  const verdict = closeConfirmVerdict({
    phase, opened: state.opened, openIds, hasAuth: !!i.auth, busy,
  });

  const rows = useMemo(() => (position == null ? [] : closeRows(position)), [position]);

  const open = useCallback(
    (positionId: string) => dispatch({ type: 'OPEN', positionId }), [dispatch]);
  const cancel = useCallback(() => dispatch({ type: 'CANCEL' }), [dispatch]);
  const confirm = useCallback(() => dispatch({ type: 'CONFIRM' }), [dispatch]);

  return { phase, ticket: state.opened, position, rows, verdict, open, cancel, confirm, message };
}
