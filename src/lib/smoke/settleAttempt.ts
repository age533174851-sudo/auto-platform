// src/lib/smoke/settleAttempt.ts
//
// **한 회차를 닫는 절차는 한 곳뿐이다.**
//
// 닫는 길이 둘이 됐다: 마감 시각이 되어 워커가 닫는 길(`/settle`)과
// 사람이 "지금 테스트 종료"를 눌러 닫는 길(`/cancel`). 두 곳에 각자
// 절차를 두면 **한쪽만 고쳐진다** — 이 저장소에서 가장 자주 난 고장이고,
// 하필 이 절차가 포지션을 닫고 보호주문을 지우는 절차다.
//
// 그래서 절차는 여기 하나이고, 두 라우트는 이걸 부르기만 한다.
//
// 무엇이 통과인가
// ───────────────
// 청산 주문을 보낸 것과 포지션이 없어진 것은 다른 사실이고, 포지션이 0인
// 것과 조건부 주문이 0인 것도 다른 사실이다. **재조회가 판정한다.**
// 200 응답은 접수이지 완료가 아니다.

import { stepsOf, smokeVerdict, SMOKE_STRATEGY_ID } from './smokePlan';
import { closeVerdict } from '../engine/closeEvidence';
import { orphanCleanupPlan, cleanupOutcome, residualVerdict } from '../engine/orderOwnership';
import { ownedOrderIds, cancelLedger } from '../engine/protectionLedger';
import { cancelCompletion, type CancelCompletion } from './cancelRun';

const step = (state: string, note: string) => ({ state, note: String(note ?? '').slice(0, 400) });

/** 절차가 어디까지 왔는가 — 화면이 '청산 중 / 정리 중'을 관측값으로 그린다 */
export type SettlePhase = 'CLOSING' | 'CLEANING_PROTECTION';

export interface SettleOptions {
  /**
   * 사람이 "지금 테스트 종료"를 눌러 부른 것인가.
   *
   * **유지 시간을 채우지 않았다는 사실을 지우지 않는다** — HOLD를 PASS로
   * 적으면 중지된 회차가 정상 완주한 회차와 구분되지 않는다.
   */
  cancel?: boolean;
  /** 중지 사유 한 줄 */
  cancelNote?: string | null;
  /** 단계가 바뀔 때마다 부른다. 실패해도 절차는 계속한다 */
  onPhase?: (phase: SettlePhase) => Promise<void> | void;
}

export interface SettleResult {
  id: string;
  symbol: string | null;
  verdict: string;
  reason: string;
  /** 중지 판정에 필요한 증거. **판정은 여기서 만들지 않고 값만 모은다** */
  evidence: {
    positionZero: boolean | null;
    slOrderId: string | null;
    tpOrderId: string | null;
    cancelCode: string | null;
    cancelEntries: Array<{ id: string; state: string }>;
    residualCode: string | null;
    residualMine: number | null;
    residualUnknown: number | null;
  };
  /** cancel 모드일 때의 완료 판정 */
  completion: CancelCompletion | null;
}

/**
 * 한 회차를 닫고 판정까지 적는다.
 *
 * 호출 전에 **반드시 선점(claim)돼 있어야 한다** — 두 실행기가 같은 줄에
 * reduceOnly 청산을 각각 보내면 하나는 반대 방향 신규 진입이 된다.
 */
export async function settleAttempt(sb: any, row: any, opts: SettleOptions = {}): Promise<SettleResult> {
  const steps: Record<string, any> = { ...(row.steps && typeof row.steps === 'object' ? row.steps : {}) };
  steps.HOLD = opts.cancel
    ? step('SKIPPED', opts.cancelNote || '사람이 중지했습니다 — 유지 시간을 채우지 않았습니다')
    : step('PASS', `${row.hold_min}분 유지 완료`);

  const patch: Record<string, any> = {};
  const evidence: SettleResult['evidence'] = {
    positionZero: null, slOrderId: row.sl_order_id ?? null, tpOrderId: row.tp_order_id ?? null,
    cancelCode: null, cancelEntries: [], residualCode: null, residualMine: null, residualUnknown: null,
  };

  const phase = async (p: SettlePhase) => {
    try { await opts.onPhase?.(p); } catch { /* 표시가 실패해도 청산은 계속한다 */ }
  };

  try {
    const { loadFuturesCreds } = await import('../exchanges/loadCreds');
    const ops = await import('../engine/venuePositionOps');

    const creds = await loadFuturesCreds(sb, row.user_id, row.connection_id);
    if (!creds.ok) {
      // **자격증명을 못 읽으면 닫을 수가 없다.** 이건 UNKNOWN이지
      // "닫았다"가 아니다. HOLDING으로 되돌려 다음 주기에 다시 시도한다.
      steps.CLOSE = step('UNKNOWN', `거래소 자격증명을 읽지 못했습니다: ${(creds as any).message}`);
      await save(sb, row.id, { state: 'HOLDING', steps, settle_claimed_at: null });
      return {
        id: row.id, symbol: row.symbol ?? null, verdict: 'RETRY', reason: (creds as any).message,
        evidence, completion: opts.cancel ? cancelCompletion({ positionZero: null }) : null,
      };
    }
    const venue = {
      exchange: (creds as any).exchange as 'binance' | 'gate',
      apiKey: (creds as any).key, apiSecret: (creds as any).secret,
      testnet: (creds as any).testnet as boolean,
    };

    // ── 청산 ──
    //
    // reduceOnly 전량청산이다. **진입 관문이 막혀 있어도 이건 나간다** —
    // 못 여는 것은 불편이고 못 닫는 것은 사고다.
    await phase('CLOSING');
    const closeT0 = Date.now();
    const before = await ops.readOpenPosition(venue, row.symbol);
    const closeRes = await ops.closeSymbolPosition(venue, row.symbol, before.side ?? row.side);
    const after = await ops.readOpenPosition(venue, row.symbol);
    const closeMs = Date.now() - closeT0;
    // 마감 시각으로부터 얼마나 늦게 닫혔는가. **못 읽으면 null이다.**
    // 사람이 중지시킨 경우는 마감 시각과 비교할 것이 아니므로 안 적는다.
    const dueMs = row.hold_until ? Date.parse(String(row.hold_until)) : NaN;
    patch.exit_latency_ms = (!opts.cancel && Number.isFinite(dueMs))
      ? Math.max(0, Math.round(closeT0 - dueMs)) : null;
    patch.api_latency_ms_max = Math.max(Number(row.api_latency_ms_max) || 0, closeMs);

    const cv = closeVerdict({
      before: { ok: before.ok, found: before.found, amount: before.qty ?? null, error: before.error },
      order: { attempted: closeRes.attempted, ok: closeRes.ok, error: closeRes.error },
      after: { ok: after.ok, found: after.found, amount: after.qty ?? null, error: after.error },
    });

    steps.CLOSE = closeRes.attempted && closeRes.ok
      ? step('PASS', '전량 청산 주문 접수')
      : step(closeRes.attempted ? 'FAIL' : 'UNKNOWN', closeRes.error || '청산 주문을 보내지 못했습니다');

    // **접수와 0은 다른 사실이다.** 재조회가 판정한다.
    steps.POSITION_ZERO = cv.closed
      ? step('PASS', cv.reason)
      : step(cv.needsReconcile ? 'UNKNOWN' : 'FAIL', cv.reason);
    evidence.positionZero = cv.closed ? true : (cv.needsReconcile ? null : false);

    // ── 남은 보호주문 ──
    //
    // **내 것만** 취소한다 — 같은 계좌의 다른 전략이 걸어 둔 손절을
    // 지우지 않는다. **저장해 둔 정확한 거래소 주문 번호가 1순위 소유
    // 증거다.** 식별자(text) 파싱은 2순위다 — 형식이 한 번 깨지면 내
    // 주문이 UNKNOWN이 되고, UNKNOWN은 안전을 이유로 안 지우므로
    // 거래소에 계속 쌓인다. 실제로 그렇게 쌓였다(2026-08-15).
    await phase('CLEANING_PROTECTION');
    const orders = await ops.readProtectiveOrders(venue, row.symbol);
    const ownedIds = ownedOrderIds({ placed: [row.sl_order_id, row.tp_order_id] });

    const plan = orphanCleanupPlan({
      position: { ok: after.ok, found: after.found, qty: after.qty },
      orders, myStrategyId: SMOKE_STRATEGY_ID, ownedIds,
    });

    // ── 취소하고 **재조회로 사라진 것까지 확인한다** ──
    //
    // 예전에는 거래소가 200을 주면 취소된 것으로 적었다. 200은 접수다.
    // `cancelExact`는 요청 → 재조회 → 아직 있으면 재시도를 최대 3바퀴
    // 돈다. **끝까지 남으면 FAIL이지 PASS가 아니다.**
    const cx = plan.cancel.length
      ? await ops.cancelExact(venue, row.symbol, plan.cancel, { attempts: 3 })
      : { attempts: [] as any[], leftover: orders, rounds: 0 };
    const ledger = cancelLedger({ ids: plan.cancel, attempts: cx.attempts, leftover: cx.leftover });
    const cleaned = cleanupOutcome({
      plan,
      cancelled: plan.ok ? ledger.entries.filter(e => e.state === 'CANCEL_CONFIRMED').map(e => e.id) : null,
    });

    const leftover = plan.ok ? (cx.leftover ?? await ops.readProtectiveOrders(venue, row.symbol)) : orders;
    const rv = residualVerdict({
      position: { ok: after.ok, found: after.found, qty: after.qty },
      orders: leftover, myStrategyId: SMOKE_STRATEGY_ID, ownedIds,
    });

    evidence.cancelCode = ledger.code;
    evidence.cancelEntries = ledger.entries.map(e => ({ id: e.id, state: e.state }));
    evidence.residualCode = rv.code;
    evidence.residualMine = rv.mine.length;
    evidence.residualUnknown = rv.unknown.length;

    // 취소가 실제로 됐는지도 SL·TP **각각** 적는다. 하나로 뭉치면
    // "무엇이 안 지워졌는지"가 사라진다.
    const stateOf = (id: any) => ledger.entries.find(e => e.id === String(id ?? ''))?.state ?? null;
    const idNote = (label: string, id: any) => {
      if (!id) return `${label} 번호 없음`;
      const st = stateOf(id);
      if (st === 'CANCEL_CONFIRMED') return `${label} ${id} 취소 확인`;
      if (st === 'STILL_PRESENT') return `${label} ${id} 남음`;
      if (st === 'CANCEL_UNKNOWN') return `${label} ${id} 확인 불가`;
      return rv.knownStillPresent.includes(String(id)) ? `${label} ${id} 남음` : `${label} ${id} 없음`;
    };
    const slNote = idNote('손절', row.sl_order_id);
    const tpNote = idNote('익절', row.tp_order_id);

    // **취소 장부와 잔여 판정이 둘 다 통과해야 통과다.**
    const ordersOk = rv.ok && ledger.ok;
    steps.ORDERS_ZERO = ordersOk
      ? step('PASS', `${slNote} · ${tpNote} · ${rv.reason}`)
      : (rv.code === 'ORDERS_UNKNOWN' || ledger.code === 'UNKNOWN')
        ? step('UNKNOWN', `${slNote} · ${tpNote} · ${rv.ok ? ledger.reason : rv.reason} — ${cleaned.reason}`)
        // **남으면 FAIL이다.** 그 주문이 다음 진입을 친다.
        : step('FAIL', `${slNote} · ${tpNote} · ${ledger.ok ? rv.reason : ledger.reason}`);

    // ── 대조 ──
    steps.RECONCILE = (cv.closed && ordersOk)
      ? step('PASS', '장부와 거래소가 일치합니다 — 손절/익절 취소 확인 · 포지션 0 · 잔여 0')
      : step(cv.closed === false && !cv.needsReconcile ? 'FAIL'
        : ledger.code === 'STILL_PRESENT' ? 'FAIL'
          : rv.ok === false && rv.code !== 'ORDERS_UNKNOWN' ? 'FAIL' : 'UNKNOWN',
      `대조하지 못했습니다 — 포지션 ${cv.code} · 잔여 ${rv.code} · 취소 ${ledger.code}`);

    patch.closed_at = new Date().toISOString();
    steps._residual = { code: rv.code, mine: rv.mine, unknown: rv.unknown,
      foreign: rv.foreign, knownStillPresent: rv.knownStillPresent };
    steps._cancel = {
      code: ledger.code, rounds: cx.rounds,
      requested: plan.cancel,
      entries: ledger.entries,
      attempts: cx.attempts,
      leftoverReadable: cx.leftover != null,
    };
  } catch (e: any) {
    steps.CLOSE = steps.CLOSE ?? step('UNKNOWN', `청산 경로에서 예외: ${e?.message || e}`);
    steps.RECONCILE = step('UNKNOWN', String(e?.message || e));
  }

  // ── 판정 ──
  //
  // 사람이 중지시킨 회차는 **PASS가 아니다** — 유지 시간을 안 채웠으므로
  // 통과라고 부를 수 없다. 대신 정리가 끝났는지를 따로 판정한다.
  const completion = opts.cancel ? cancelCompletion({
    positionZero: evidence.positionZero,
    slOrderId: evidence.slOrderId, tpOrderId: evidence.tpOrderId,
    cancelEntries: evidence.cancelEntries, cancelCode: evidence.cancelCode,
    residualCode: evidence.residualCode,
    residualMine: evidence.residualMine, residualUnknown: evidence.residualUnknown,
  }) : null;

  const list = stepsOf(steps);
  const v = smokeVerdict(list);
  const state = opts.cancel
    ? (completion!.ok ? 'CANCELLED' : 'FAIL')
    : (v.code === 'PASS' ? 'PASS' : v.code === 'RUNNING' ? 'FAIL' : v.code === 'UNKNOWN' ? 'FAIL' : v.code);
  const verdict = opts.cancel ? (completion!.ok ? 'CANCELLED' : 'FAIL') : v.code;
  const reason = opts.cancel ? completion!.reason : v.reason;

  await save(sb, row.id, { ...patch, state, steps, verdict, reason });
  return { id: row.id, symbol: row.symbol ?? null, verdict, reason, evidence, completion };
}

export async function save(sb: any, id: string, patch: Record<string, any>): Promise<void> {
  try {
    await sb.from('smoke_tests').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  } catch { /* 다음 주기에 다시 적힌다 */ }
}
