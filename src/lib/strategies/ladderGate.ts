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
    const { data: reservation, error: resErr } = await sb
      .from('ladder_daily_trades')
      .insert({
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
      })
      .select('id').single();

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
 * 예약 취소 — 주문이 실패했을 때 호출한다.
 * 이걸 빼먹으면 주문이 안 나갔는데도 그 날 하루가 소진된다.
 */
export async function releaseReservation(sb: any, reservationId?: string): Promise<void> {
  if (!sb || !reservationId) return;
  try { await sb.from('ladder_daily_trades').delete().eq('id', reservationId); } catch { /* 무시 */ }
}

/** 주문이 나간 뒤 체결 정보를 예약 행에 채운다. */
export async function confirmReservation(
  sb: any,
  reservationId: string | undefined,
  fill: {
    leverage?: number; entryPrice?: number;
    stopLoss?: number; takeProfit?: number; liquidationPrice?: number;
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
