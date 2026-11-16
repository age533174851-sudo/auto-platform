// src/lib/strategies/ladderGate.ts
//
// 계단식 전략의 주문 경로 관문.
//
// ladderSizing.ts는 순수 계산(잔고 → 단계 → 증거금)만 한다. 실주문에 쓰려면
// 상태가 재시작 후에도 남아야 하고, "하루 최대 1회"가 동시 요청에도 깨지지
// 않아야 한다. 그 두 가지를 DB로 처리하는 계층이 여기다.
//
// 하루 1회를 어떻게 보장하는가
// ────────────────────────────
// "오늘 거래했나?"를 select로 확인하고 insert하면, 웹훅 두 건이 거의 동시에
// 도착할 때 둘 다 통과한다. 그래서 ladder_daily_trades에
// (user_id, strategy_id, trade_date) unique 제약을 걸고, 진입을 "예약"하는
// insert가 성공한 요청만 주문으로 넘어간다. 두 번째 요청은 23505로 실패한다.
//
// 순서가 중요하다: 예약 → 주문. 주문 먼저 내고 기록하면, 기록 직전에 죽었을 때
// 같은 날 두 번째 주문이 나갈 수 있다.
import {
  evaluateLadder, completeCycle,
  CYCLE_BASE, CYCLE_TARGET, LADDER_TIERS,
  type LadderState, type LadderDecision,
} from './ladderSizing';

export const DEFAULT_STRATEGY_ID = 'daily-ladder';

export type LadderRejectCode =
  | 'NO_USER'            // userId가 없어 사이클을 특정할 수 없음
  | 'NO_DB'              // Supabase 미구성 — 상태를 강제할 수 없으므로 거부
  | 'CYCLE_LOCKED'       // 목표 달성 또는 수동 잠금
  | 'BELOW_MINIMUM'      // 전략 자본이 최소 구간 미만
  | 'ALREADY_TRADED'     // 오늘 이미 거래함
  | 'DB_ERROR';

export interface LadderGateResult {
  allowed: boolean;
  rejectCode?: LadderRejectCode;
  reason?: string;

  /** 이번 진입에 격리할 증거금 (allowed일 때만 의미 있음) */
  margin?: number;
  decision?: LadderDecision;
  state?: LadderState;
  cycleId?: string;
  /** 예약된 ladder_daily_trades 행 id — 주문 결과를 여기에 기록한다 */
  reservationId?: string;
  tradeDate?: string;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function rowToState(row: any): LadderState {
  return {
    currentTierIndex: Number(row.current_tier_index ?? 0),
    strategyCapital:  Number(row.strategy_capital ?? CYCLE_BASE),
    realizedEquity:   Number(row.realized_equity ?? CYCLE_BASE),
    cycleNumber:      Number(row.cycle_number ?? 1),
    cycleStartAt:     String(row.cycle_start_at ?? new Date().toISOString()),
    protectedProfit:  Number(row.protected_profit ?? 0),
    cycleLocked:      !!row.cycle_locked,
    lockReason:       row.lock_reason || undefined,
  };
}

/**
 * 사이클 상태를 읽는다. 없으면 CYCLE_BASE로 새로 만든다.
 * 전략 자본은 계좌 잔고와 별개다 — 계좌에 $50,000이 있어도 이 전략이
 * 운용하는 돈은 사이클 자본까지다.
 */
export async function getOrCreateCycle(
  sb: any,
  userId: string,
  strategyId = DEFAULT_STRATEGY_ID,
): Promise<{ id: string; state: LadderState } | null> {
  const { data: existing } = await sb
    .from('ladder_cycles').select('*')
    .eq('user_id', userId).eq('strategy_id', strategyId)
    .maybeSingle();

  if (existing) return { id: existing.id, state: rowToState(existing) };

  const { data: created, error } = await sb
    .from('ladder_cycles')
    .insert({
      user_id: userId,
      strategy_id: strategyId,
      cycle_number: 1,
      current_tier_index: LADDER_TIERS.findIndex(t => t.minEquity === CYCLE_BASE) >= 0
        ? LADDER_TIERS.findIndex(t => t.minEquity === CYCLE_BASE)
        : 0,
      strategy_capital: CYCLE_BASE,
      realized_equity: CYCLE_BASE,
    })
    .select('*').single();

  // 동시 생성 경쟁에서 졌으면 상대가 만든 행을 읽는다
  if (error) {
    const { data: retry } = await sb
      .from('ladder_cycles').select('*')
      .eq('user_id', userId).eq('strategy_id', strategyId)
      .maybeSingle();
    return retry ? { id: retry.id, state: rowToState(retry) } : null;
  }
  return created ? { id: created.id, state: rowToState(created) } : null;
}

/**
 * 진입 가능 여부를 판정하고, 가능하면 오늘의 거래 슬롯을 예약한다.
 *
 * 반환이 allowed면 reservationId가 함께 온다. 주문 실패 시에는
 * releaseReservation()으로 되돌려야 그 날 재시도가 가능하다.
 */
export async function openLadderGate(
  sb: any,
  opts: {
    userId?: string | null;
    strategyId?: string;
    signalId?: string;
    symbol?: string;
    side?: 'LONG' | 'SHORT';
    /**
     * **이 거래가 열리는 연결.** 청산 감시가 계좌를 고르는 근거다.
     * 안 주면 감시는 "활성 연결이 하나뿐일 때만" 손을 댄다.
     */
    connectionId?: string | null;
    /** 거래소에서 조회한 확정 잔고. 주면 사이클 상태를 이 값으로 갱신한다. */
    realizedEquity?: number;
  },
): Promise<LadderGateResult> {
  const strategyId = opts.strategyId || DEFAULT_STRATEGY_ID;

  if (!opts.userId) {
    return { allowed: false, rejectCode: 'NO_USER',
      reason: 'userId가 없어 사이클 상태를 확인할 수 없습니다' };
  }
  if (!sb) {
    // 상태를 강제할 수 없으면 통과시키지 않는다. 메모리로 대체하면
    // 재시작할 때마다 하루 1회 제한이 사라진다.
    return { allowed: false, rejectCode: 'NO_DB',
      reason: 'DB가 구성되지 않아 하루 1회 제한을 강제할 수 없습니다' };
  }

  try {
    // ── 버려진 예약 치우기 (사이클 판정보다 **먼저**) ──
    //
    // 예약은 주문보다 먼저 꽂힌다. 그래야 동시 요청 둘 중 하나만
    // 통과한다(unique 제약). 그런데 예약한 뒤 주문까지 가는 동안 함수가
    // 죽으면 — Vercel 실행 상한(60초)에 걸리거나 배포로 인스턴스가
    // 교체되면 — releaseReservation이 돌지 못한다.
    //
    // 그러면 RESERVED 행이 남고, unique 제약 때문에 **그날은 다시 시도할
    // 수 없다.** 주문은 한 건도 안 나갔는데 하루를 잃는다. 화면에는
    // "오늘 이미 거래했습니다"로만 보이고 푸는 방법이 없다.
    //
    // 하루 1회 크론일 때는 드물었다. 실행기를 15분마다로 바꾸면서 같은
    // 창에 들어갈 확률이 96배가 됐다.
    //
    // **사이클 판정보다 먼저 한다.** 오늘 사이클이 잠겨 있어도 버려진
    // 예약은 치워야 한다 — 잠금이 풀린 뒤에 그 행이 또 하루를 먹는다.
    //
    // **진입 흔적이 없는 RESERVED만 치운다.** entry_price가 있으면 주문이
    // 나간 것이므로 절대 건드리지 않는다. 그걸 지우면 하루 1회 제약이
    // 풀려 같은 날 두 번 들어간다 — 막으려던 사고보다 크다.
    const STALE_MS = 10 * 60 * 1000;   // 실행 상한(60초)의 열 배
    try {
      await sb.from('ladder_daily_trades')
        .delete()
        .eq('user_id', opts.userId)
        .eq('strategy_id', strategyId)
        .eq('trade_date', todayUtc())
        .eq('status', 'RESERVED')
        .is('entry_price', null)
        .lt('created_at', new Date(Date.now() - STALE_MS).toISOString());
    } catch { /* 못 치워도 아래 insert가 ALREADY_TRADED로 알려 준다 */ }

    const cycle = await getOrCreateCycle(sb, opts.userId, strategyId);
    if (!cycle) {
      return { allowed: false, rejectCode: 'DB_ERROR', reason: '사이클 상태를 읽지 못했습니다' };
    }

    // 거래소 잔고가 주어지면 그것을 확정 잔고로 삼는다
    let state = cycle.state;
    if (typeof opts.realizedEquity === 'number' && isFinite(opts.realizedEquity)) {
      state = { ...state, realizedEquity: opts.realizedEquity };
      await sb.from('ladder_cycles')
        .update({ realized_equity: opts.realizedEquity })
        .eq('id', cycle.id);
    }

    const decision = evaluateLadder(state);

    // ── 사이클 목표 달성 → 잠그고 수익 분리 ──
    if (decision.cycleComplete) {
      const reset = completeCycle(state);
      await sb.from('ladder_cycles').update({
        cycle_locked: true,
        lock_reason: `사이클 ${state.cycleNumber} 목표 $${CYCLE_TARGET.toLocaleString()} 달성`,
        protected_profit: reset.totalProtected,
      }).eq('id', cycle.id);

      return { allowed: false, rejectCode: 'CYCLE_LOCKED',
        reason: `${decision.message} ${reset.summary}`,
        decision, state, cycleId: cycle.id };
    }

    if (decision.locked) {
      const code: LadderRejectCode =
        state.realizedEquity < LADDER_TIERS[0].minEquity ? 'BELOW_MINIMUM' : 'CYCLE_LOCKED';
      return { allowed: false, rejectCode: code, reason: decision.message, decision, state, cycleId: cycle.id };
    }

    // ── 단계 변동을 상태에 반영 ──
    if (decision.promoted || decision.demoted) {
      await sb.from('ladder_cycles')
        .update({ current_tier_index: decision.tier.index })
        .eq('id', cycle.id);
    }

    // ── 하루 1회 예약 (unique 제약이 경쟁을 처리한다) ──
    const tradeDate = todayUtc();

    const reservationRow: Record<string, any> = {
      user_id: opts.userId,
      strategy_id: strategyId,
      trade_date: tradeDate,
      cycle_id: cycle.id,
      cycle_number: state.cycleNumber,
      tier_index: decision.tier.index,
      allocated_margin: decision.margin,
      signal_id: opts.signalId || null,
      symbol: opts.symbol || null,
      side: opts.side || null,
      status: 'RESERVED',
    };
    // **이 거래가 어느 계좌에서 열리는가.**
    //
    // 안 적으면 청산 감시가 "그 사용자의 활성 연결 첫 줄"을 쓴다 —
    // 연결이 둘이면 Gate 포지션의 손절 이동이 바이낸스로 나간다.
    if (opts.connectionId) reservationRow.connection_id = opts.connectionId;

    let { data: reservation, error: resErr } = await sb
      .from('ladder_daily_trades').insert(reservationRow).select('id').single();

    // 068이 아직 안 붙은 DB에서는 그 칸이 없다. **진입을 막지 않는다** —
    // 연결을 못 적는 것보다 진입 자체가 안 되는 쪽이 나쁘다. 못 적힌
    // 줄은 읽는 쪽이 "모름"으로 다룬다(tradeVenue.ts).
    if (resErr && 'connection_id' in reservationRow
        && /connection_id|column|schema cache/i.test(String(resErr.message || ''))) {
      delete reservationRow.connection_id;
      ({ data: reservation, error: resErr } = await sb
        .from('ladder_daily_trades').insert(reservationRow).select('id').single());
    }

    if (resErr) {
      const dup = String(resErr.code) === '23505' || /duplicate|unique/i.test(resErr.message || '');
      if (dup) {
        return { allowed: false, rejectCode: 'ALREADY_TRADED',
          reason: `오늘(${tradeDate}) 이미 거래했습니다 — 이 전략은 하루 최대 1회입니다`,
          decision, state, cycleId: cycle.id, tradeDate };
      }
      return { allowed: false, rejectCode: 'DB_ERROR',
        reason: `거래 예약 실패: ${resErr.message}`, decision, state, cycleId: cycle.id };
    }

    return {
      allowed: true,
      margin: decision.margin,
      decision, state,
      cycleId: cycle.id,
      reservationId: reservation?.id,
      tradeDate,
    };
  } catch (e: any) {
    return { allowed: false, rejectCode: 'DB_ERROR', reason: e?.message || '계단 게이트 오류' };
  }
}

/**
 * 주문 결과를 예약 행에 **어떻게** 옮길지. 판정은 여기 한 곳이다.
 *
 * 왜 `ok` 하나로는 모자라나
 * ─────────────────────────
 * `executeOrder`의 `ok: false`에는 서로 다른 셋이 섞여 있다.
 *
 *   `REJECTED`  거래소가 거부했다 — 주문은 **없다**
 *   `FAILED`    보내지 못했다 — 주문은 **없다**
 *   `UNKNOWN`   응답을 못 받았다 — **나갔는지 모른다**
 *
 * 앞의 둘은 하루를 돌려줘도 된다. 마지막은 아니다. 그런데 호출부는
 * `exec.ok ? confirm : release` 두 갈래뿐이었고, `release`는 예약 행을
 * **DELETE** 한다. 그 행이 `(user_id, strategy_id, trade_date)` unique를
 * 쥐고 있으므로, 지우는 순간 **하루 1회 잠금이 열린다.** 다음 주기에
 * 두 번째 주문이 나가고, 앞 주문이 실제로는 체결돼 있었다면 포지션이
 * 두 배가 된다.
 *
 * **확인하지 못한 것은 통과가 아니다.** 모르면 돌려주지 않는다 —
 * 하루를 손해 보는 쪽이 포지션이 두 배가 되는 쪽보다 싸다.
 *
 * 그래서 모르는 상태는 전부 `HOLD_UNKNOWN`으로 떨어진다. `status`가
 * 비었거나 처음 보는 값일 때도 마찬가지다 — 새 상태가 생겼을 때
 * 조용히 "안 나갔다"로 접히면 이 고장이 그대로 돌아온다.
 */
export type ReservationOutcome =
  /** 나갔다 — 체결 정보를 채운다 */
  | 'CONFIRM'
  /** **확실히** 안 나갔다 — 행을 지우고 하루를 돌려준다 */
  | 'RELEASE'
  /** 나갔는지 모른다 — 지우지 않는다. 하루는 소진된 채로 둔다 */
  | 'HOLD_UNKNOWN';

export function reservationOutcome(
  exec: { ok?: boolean; status?: string | null } | null | undefined,
): ReservationOutcome {
  if (exec?.ok === true) return 'CONFIRM';
  const s = String(exec?.status ?? '').toUpperCase();
  // 열거는 **돌려줘도 되는 쪽만** 한다. 나머지는 전부 모르는 것으로 둔다.
  if (s === 'REJECTED' || s === 'FAILED') return 'RELEASE';
  return 'HOLD_UNKNOWN';
}

/**
 * 나갔는지 모르는 주문의 예약 행에 남기는 상태.
 *
 * `RESERVED`로 두면 안 된다 — `openLadderGate`의 묵은 예약 청소가
 * `status='RESERVED' AND entry_price IS NULL`인 10분 지난 행을 지우고,
 * 그러면 **잠금이 다시 열린다.** 그 청소의 조건에서 벗어나는 값이어야 한다.
 *
 * `017_ladder_cycles.sql`의 `status`는 `text not null default 'OPEN'`이고
 * CHECK 제약이 없다 — 새 값을 쓰는 데 마이그레이션이 필요하지 않다.
 */
export const RECONCILE_STATUS = 'RECONCILE_REQUIRED';

/**
 * 나갔는지 모르는 주문 — **지우지 않고** 대조 대상으로 남긴다.
 *
 * 하루는 소진된 채로 둔다. 이 행이 unique를 계속 쥐고 있어야 같은 날
 * 두 번째 주문이 못 나간다.
 */
export async function holdReservationForReconcile(
  sb: any, reservationId: string | undefined, note: string,
): Promise<void> {
  if (!sb || !reservationId) return;
  try {
    await sb.from('ladder_daily_trades').update({
      status: RECONCILE_STATUS,
      // 왜 남았는지가 장부에 있어야 다음 사람이 처음부터 다시 조사하지 않는다.
      exit_reason: note,
    }).eq('id', reservationId);
  } catch { /* 기록 실패가 주문을 되돌리지는 않는다 */ }
}

/**
 * 예약 취소 — 주문이 실패했을 때 호출한다.
 * 이걸 빼먹으면 주문이 안 나갔는데도 그 날 하루가 소진된다.
 */
export async function releaseReservation(sb: any, reservationId?: string): Promise<void> {
  if (!sb || !reservationId) return;
  try { await sb.from('ladder_daily_trades').delete().eq('id', reservationId); } catch { /* 무시 */ }
}

/**
 * 주문이 나간 뒤 체결 정보를 예약 행에 채운다.
 *
 * **`stopLoss`는 선택이 아니다.**
 *
 * 왜 타입으로 강제하나
 * ────────────────────
 * 2026-11-16까지 이 자리의 유일한 호출자(`/api/autotrade/daily-ladder`)가
 * `stopLoss`를 넘기지 않았다. 손절은 거래소에는 제대로 걸렸지만
 * (`executeOrder`에 같은 값이 넘어간다) **장부에는 한 번도 안 적혔다.**
 * 그래서 `ladder_daily_trades.stop_loss`가 모든 진입에서 NULL이었다.
 *
 * 그 한 칸이 비면 청산 감시가 통째로 멈춘다 — `exitMonitor.ts`는
 *
 *     const stop = Number(t.stop_loss);
 *     if (!entry || !stop) continue;      // ← 시간청산보다 **앞**이다
 *
 * 로 줄을 버린다. 트레일링·본전 이동·5일 시간청산·청산가 근접 점검이
 * 전부 0회가 되고, 응답에는 "확인함"만 남는다. 같은 파일의 다른 자리는
 * 이 칸이 차 있다고 **가정하고** 주석까지 달아 두었다
 * ("stop_loss를 덮어쓰지 않는다 — 그 칸은 진입 시점 값이고 1R을 정의한다").
 * 채우는 쪽만 없었다.
 *
 * 인자를 빼먹는 것은 조용하다. 타입을 필수로 만들면 **컴파일이 막는다** —
 * 빠뜨릴 수 있는 자리를 없앤다. 값을 확인하지 못한 경우에는 `null`을
 * **명시해야** 하고, 그건 "모른다"를 적는 것이지 빼먹는 것이 아니다.
 */
export async function confirmReservation(
  sb: any,
  reservationId: string | undefined,
  fill: {
    leverage?: number; entryPrice?: number;
    /** **필수.** 확인하지 못했으면 `null`을 명시한다 — 생략은 못 한다 */
    stopLoss: number | null;
    takeProfit?: number; liquidationPrice?: number;
  },
): Promise<void> {
  if (!sb || !reservationId) return;
  try {
    await sb.from('ladder_daily_trades').update({
      status: 'OPEN',
      leverage: fill.leverage ?? null,
      entry_price: fill.entryPrice ?? null,
      stop_loss: fill.stopLoss ?? null,
      take_profit: fill.takeProfit ?? null,
      liquidation_price: fill.liquidationPrice ?? null,
    }).eq('id', reservationId);
  } catch { /* 기록 실패가 주문을 되돌리지는 않는다 */ }
}
