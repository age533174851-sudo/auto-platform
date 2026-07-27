// src/lib/strategies/slotManager.ts
//
// ⚠️ 이 모듈은 "하루 10슬롯 순차 사용" 해석에 기반해 작성됐으나,
//    실제 요구사항은 "하루 최대 1회 + 10배 계단식 증거금"으로 확정됐다.
//    현재 전략은 ladderSizing.ts + dailyBattle.ts를 사용한다.
//    이 파일은 참고용으로 남겨두되 신규 배선에는 쓰지 않는다.
// DAILY_HIGH_LEV 슬롯 관리.
//
// 규칙:
//  1. 하루 시작 시점의 자산을 10등분해 슬롯 크기를 고정한다.
//     (매번 현재 잔고 ÷ 10로 재계산하면 지고 있을 때 슬롯이 작아져 의도와 달라진다)
//  2. 슬롯 하나는 하루에 한 번만 쓴다 — 이기든 지든 재사용 금지.
//  3. ISOLATED 강제. Cross면 주문 자체를 거부한다.
//  4. 슬롯 상태는 DB에 저장한다. 메모리에 두면 재시작 시 제한이 사라진다.
//  5. 안전장치(일일 손실 한도·연속 손실)에 걸리면 남은 슬롯이 있어도 중단한다.

export const ACCOUNT_CEILING = 10_000;   // 이 금액 초과 시 전략 비활성화
export const DEFAULT_SLOT_COUNT = 10;

export type SlotRejectCode =
  | 'ACCOUNT_TOO_LARGE'      // 자산이 상한 초과 → 다른 전략 사용
  | 'ALL_SLOTS_USED'         // 오늘 슬롯 소진
  | 'DAY_HALTED'             // 안전장치 발동
  | 'CROSS_MARGIN_FORBIDDEN' // Cross 마진 시도
  | 'POSITION_ALREADY_OPEN'  // 이미 열린 슬롯 있음 (동시 1개)
  | 'SLOT_ALREADY_USED';     // 해당 슬롯 중복 사용

export interface SlotDay {
  id: string;
  tradeDate: string;
  startEquity: number;
  slotSize: number;
  slotCount: number;
  slotsUsed: number;
  realizedPnl: number;
  consecutiveLosses: number;
  halted: boolean;
  haltReason?: string;
  maxDailyLoss?: number;
  maxConsecutiveLosses: number;
}

export interface SlotAllocation {
  allowed: boolean;
  rejectCode?: SlotRejectCode;
  reason?: string;
  slotIndex?: number;
  allocatedMargin?: number;    // 이 슬롯에 격리할 증거금
  protectedBalance?: number;   // 건드리지 않는 나머지 자금
  slotsRemaining?: number;
  day?: SlotDay;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── 오늘의 슬롯 상태 조회 (없으면 생성) ──
export async function getOrCreateSlotDay(
  sb: any,
  userId: string,
  currentEquity: number,
  opts: { slotCount?: number; maxDailyLoss?: number; maxConsecutiveLosses?: number } = {}
): Promise<SlotDay | null> {
  const date = todayUtc();
  const { data: existing } = await sb
    .from('daily_slot_days').select('*').eq('user_id', userId).eq('trade_date', date).maybeSingle();

  if (existing) {
    return {
      id: existing.id, tradeDate: existing.trade_date,
      startEquity: Number(existing.start_equity),
      slotSize: Number(existing.slot_size),
      slotCount: Number(existing.slot_count),
      slotsUsed: Number(existing.slots_used),
      realizedPnl: Number(existing.realized_pnl),
      consecutiveLosses: Number(existing.consecutive_losses),
      halted: !!existing.halted,
      haltReason: existing.halt_reason || undefined,
      maxDailyLoss: existing.max_daily_loss != null ? Number(existing.max_daily_loss) : undefined,
      maxConsecutiveLosses: Number(existing.max_consecutive_losses ?? 3),
    };
  }

  // 새 날 — 지금 자산으로 슬롯 크기 고정
  const slotCount = opts.slotCount ?? DEFAULT_SLOT_COUNT;
  const slotSize = currentEquity / slotCount;
  const row = {
    user_id: userId, trade_date: date,
    start_equity: currentEquity,
    slot_size: slotSize,
    slot_count: slotCount,
    max_daily_loss: opts.maxDailyLoss ?? currentEquity * 0.3,   // 기본: 자산의 30%
    max_consecutive_losses: opts.maxConsecutiveLosses ?? 3,
  };
  const { data, error } = await sb.from('daily_slot_days').insert(row).select('*').single();
  if (error) {
    // 동시 생성 경합 — 다시 읽는다
    const { data: retry } = await sb
      .from('daily_slot_days').select('*').eq('user_id', userId).eq('trade_date', date).maybeSingle();
    if (!retry) return null;
    return {
      id: retry.id, tradeDate: retry.trade_date, startEquity: Number(retry.start_equity),
      slotSize: Number(retry.slot_size), slotCount: Number(retry.slot_count),
      slotsUsed: Number(retry.slots_used), realizedPnl: Number(retry.realized_pnl),
      consecutiveLosses: Number(retry.consecutive_losses), halted: !!retry.halted,
      haltReason: retry.halt_reason || undefined,
      maxDailyLoss: retry.max_daily_loss != null ? Number(retry.max_daily_loss) : undefined,
      maxConsecutiveLosses: Number(retry.max_consecutive_losses ?? 3),
    };
  }
  return {
    id: data.id, tradeDate: data.trade_date, startEquity: Number(data.start_equity),
    slotSize: Number(data.slot_size), slotCount: Number(data.slot_count),
    slotsUsed: 0, realizedPnl: 0, consecutiveLosses: 0, halted: false,
    maxDailyLoss: data.max_daily_loss != null ? Number(data.max_daily_loss) : undefined,
    maxConsecutiveLosses: Number(data.max_consecutive_losses ?? 3),
  };
}

// ── 다음 슬롯 배정 가능한지 판정 ──
export async function allocateSlot(
  sb: any,
  args: { userId: string; currentEquity: number; marginMode: string; slotCount?: number; maxDailyLoss?: number; maxConsecutiveLosses?: number }
): Promise<SlotAllocation> {
  // Cross 마진 금지 — 다른 슬롯 자금이 청산에 끌려가면 격리 구조가 깨진다
  if (String(args.marginMode).toLowerCase() !== 'isolated') {
    return { allowed: false, rejectCode: 'CROSS_MARGIN_FORBIDDEN',
      reason: 'DAILY_HIGH_LEV는 ISOLATED 전용입니다. Cross는 다른 슬롯 자금까지 청산에 사용될 수 있어 금지됩니다.' };
  }

  // 자산 상한
  if (args.currentEquity > ACCOUNT_CEILING) {
    return { allowed: false, rejectCode: 'ACCOUNT_TOO_LARGE',
      reason: `자산 $${args.currentEquity.toFixed(0)}이 상한 $${ACCOUNT_CEILING}을 넘어 이 전략은 비활성화됩니다. 단타/스윙/장투 배분을 사용하세요.` };
  }

  const day = await getOrCreateSlotDay(sb, args.userId, args.currentEquity, {
    slotCount: args.slotCount, maxDailyLoss: args.maxDailyLoss, maxConsecutiveLosses: args.maxConsecutiveLosses,
  });
  if (!day) return { allowed: false, reason: '슬롯 상태를 읽을 수 없습니다' };

  // 안전장치 확인
  if (day.halted) {
    return { allowed: false, rejectCode: 'DAY_HALTED', day,
      reason: `오늘은 중단되었습니다: ${day.haltReason || '안전장치 발동'}` };
  }
  if (day.maxDailyLoss != null && -day.realizedPnl >= day.maxDailyLoss) {
    await haltDay(sb, day.id, `일일 손실 한도 도달 ($${Math.abs(day.realizedPnl).toFixed(0)})`);
    return { allowed: false, rejectCode: 'DAY_HALTED', day,
      reason: `일일 손실 한도 $${day.maxDailyLoss.toFixed(0)}에 도달해 중단합니다` };
  }
  if (day.consecutiveLosses >= day.maxConsecutiveLosses) {
    await haltDay(sb, day.id, `연속 손실 ${day.consecutiveLosses}회`);
    return { allowed: false, rejectCode: 'DAY_HALTED', day,
      reason: `연속 ${day.consecutiveLosses}회 손실로 중단합니다` };
  }

  // 슬롯 소진
  if (day.slotsUsed >= day.slotCount) {
    return { allowed: false, rejectCode: 'ALL_SLOTS_USED', day,
      reason: `오늘 ${day.slotCount}개 슬롯을 모두 사용했습니다. 내일 초기화됩니다.` };
  }

  // 동시 1개만 — 열린 포지션이 있으면 대기
  const { data: open } = await sb.from('daily_slot_uses')
    .select('id, slot_index').eq('user_id', args.userId).eq('status', 'open').limit(1);
  if (Array.isArray(open) && open.length > 0) {
    return { allowed: false, rejectCode: 'POSITION_ALREADY_OPEN', day,
      reason: `슬롯 ${open[0].slot_index + 1}번이 아직 열려 있습니다. 청산 후 다음 슬롯을 사용합니다.` };
  }

  const slotIndex = day.slotsUsed;
  return {
    allowed: true, slotIndex,
    allocatedMargin: day.slotSize,
    protectedBalance: args.currentEquity - day.slotSize,
    slotsRemaining: day.slotCount - day.slotsUsed,
    day,
  };
}

// ── 슬롯 사용 확정 (주문 직전 호출) ──
export async function commitSlotUse(
  sb: any,
  args: {
    dayId: string; userId: string; slotIndex: number; signalId?: string;
    symbol: string; side: string; allocatedMargin: number; leverage: number;
    positionSize: number; entryPrice?: number; stopLoss?: number; takeProfit?: number; liquidationPrice?: number;
  }
): Promise<{ ok: boolean; useId?: string; error?: string; duplicate?: boolean }> {
  const date = todayUtc();
  const { data, error } = await sb.from('daily_slot_uses').insert({
    day_id: args.dayId, user_id: args.userId, trade_date: date, slot_index: args.slotIndex,
    signal_id: args.signalId || null, symbol: args.symbol, side: args.side,
    margin_mode: 'isolated', allocated_margin: args.allocatedMargin, leverage: args.leverage,
    position_size: args.positionSize, entry_price: args.entryPrice ?? null,
    stop_loss: args.stopLoss ?? null, take_profit: args.takeProfit ?? null,
    liquidation_price: args.liquidationPrice ?? null,
  }).select('id').single();

  if (error) {
    if (String(error.code) === '23505') return { ok: false, duplicate: true, error: '이 슬롯은 오늘 이미 사용했습니다' };
    return { ok: false, error: error.message };
  }

  // 슬롯 사용 카운트 증가
  try {
    const { data: d } = await sb.from('daily_slot_days').select('slots_used').eq('id', args.dayId).single();
    await sb.from('daily_slot_days')
      .update({ slots_used: Number(d?.slots_used || 0) + 1, updated_at: new Date().toISOString() })
      .eq('id', args.dayId);
  } catch {}

  return { ok: true, useId: data.id };
}

// ── 슬롯 청산 기록 + 안전장치 갱신 ──
export async function closeSlotUse(
  sb: any, useId: string, exitPrice: number, exitReason: string, realizedPnl: number
): Promise<{ ok: boolean; halted?: boolean; haltReason?: string }> {
  const { data: use } = await sb.from('daily_slot_uses').select('*').eq('id', useId).maybeSingle();
  if (!use) return { ok: false };

  await sb.from('daily_slot_uses').update({
    status: 'closed', exit_price: exitPrice, exit_reason: exitReason,
    realized_pnl: realizedPnl, closed_at: new Date().toISOString(),
  }).eq('id', useId);

  const { data: day } = await sb.from('daily_slot_days').select('*').eq('id', use.day_id).maybeSingle();
  if (!day) return { ok: true };

  const newPnl = Number(day.realized_pnl) + realizedPnl;
  const newConsec = realizedPnl < 0 ? Number(day.consecutive_losses) + 1 : 0;

  let halted = !!day.halted, haltReason = day.halt_reason;
  const maxLoss = day.max_daily_loss != null ? Number(day.max_daily_loss) : null;
  if (!halted && maxLoss != null && -newPnl >= maxLoss) {
    halted = true; haltReason = `일일 손실 한도 도달 ($${Math.abs(newPnl).toFixed(0)} / 한도 $${maxLoss.toFixed(0)})`;
  }
  if (!halted && newConsec >= Number(day.max_consecutive_losses ?? 3)) {
    halted = true; haltReason = `연속 ${newConsec}회 손실`;
  }

  await sb.from('daily_slot_days').update({
    realized_pnl: newPnl, consecutive_losses: newConsec,
    halted, halt_reason: haltReason, updated_at: new Date().toISOString(),
  }).eq('id', use.day_id);

  return { ok: true, halted, haltReason: haltReason || undefined };
}

async function haltDay(sb: any, dayId: string, reason: string) {
  try {
    await sb.from('daily_slot_days')
      .update({ halted: true, halt_reason: reason, updated_at: new Date().toISOString() }).eq('id', dayId);
  } catch {}
}
