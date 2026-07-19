// src/lib/engine/paperStore.ts
// 가상 매매 DB 저장 계층. 포지션 오픈/청산 + 계좌 잔고 갱신.
import { simulateFill, computeClose, type PaperFill, type ExitReason } from './paperExecution';
import type { PositionPlan } from './riskManager';

const DEFAULT_BALANCE = 10000;

// 가상 계좌 조회 (없으면 생성)
export async function getPaperAccount(sb: any, userId: string) {
  const { data } = await sb.from('paper_accounts').select('*').eq('user_id', userId).maybeSingle();
  if (data) return data;
  const row = { user_id: userId, balance: DEFAULT_BALANCE, initial_balance: DEFAULT_BALANCE, total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0 };
  try { await sb.from('paper_accounts').insert(row); } catch {}
  return row;
}

// 승인된 계획 → 가상 포지션 오픈
export async function openPaperPosition(
  sb: any,
  args: {
    userId: string; signalId: string; strategyId: string; bucket?: string;
    plan: PositionPlan; entryPrice: number; stopLoss?: number; takeProfit?: number;
    feeRatePct?: number; slippagePct?: number;
  }
): Promise<{ ok: boolean; positionId?: string; fill?: PaperFill; error?: string; duplicate?: boolean }> {
  const fill = simulateFill(args.plan, args.entryPrice, {
    feeRatePct: args.feeRatePct, slippagePct: args.slippagePct,
    stopLoss: args.stopLoss, takeProfit: args.takeProfit,
  });

  const row = {
    user_id: args.userId,
    signal_id: args.signalId,
    strategy_id: args.strategyId,
    bucket: args.bucket || null,
    symbol: args.plan.symbol,
    side: fill.side,
    status: 'open',
    entry_price: fill.entryPrice,
    fill_price: fill.fillPrice,
    quantity: fill.quantity,
    notional: fill.notional,
    leverage: fill.leverage,
    margin: fill.margin,
    stop_loss: fill.stopLoss ?? null,
    take_profit: fill.takeProfit ?? null,
    liquidation_price: fill.liquidationPrice,
    entry_fee: fill.entryFee,
  };

  const { data, error } = await sb.from('paper_positions').insert(row).select('id').single();
  if (error) {
    if (String(error.code) === '23505') return { ok: false, duplicate: true, error: '이미 체결된 신호' };
    return { ok: false, error: error.message };
  }

  // 증거금 + 진입 수수료 차감
  try {
    const acct = await getPaperAccount(sb, args.userId);
    await sb.from('paper_accounts').update({
      balance: Number(acct.balance) - fill.entryFee,
      total_fees: Number(acct.total_fees) + fill.entryFee,
      updated_at: new Date().toISOString(),
    }).eq('user_id', args.userId);
  } catch {}

  return { ok: true, positionId: data?.id, fill };
}

// 가상 포지션 청산
export async function closePaperPosition(
  sb: any,
  positionId: string,
  exitPrice: number,
  exitReason: ExitReason,
  feeRatePct = 0.05
): Promise<{ ok: boolean; realizedPnl?: number; pnlPct?: number; error?: string }> {
  const { data: pos, error } = await sb.from('paper_positions').select('*').eq('id', positionId).maybeSingle();
  if (error || !pos) return { ok: false, error: '포지션을 찾을 수 없습니다' };
  if (pos.status === 'closed') return { ok: false, error: '이미 청산된 포지션' };

  const fill: PaperFill = {
    side: pos.side, entryPrice: Number(pos.entry_price), fillPrice: Number(pos.fill_price),
    quantity: Number(pos.quantity), notional: Number(pos.notional), leverage: Number(pos.leverage),
    margin: Number(pos.margin), entryFee: Number(pos.entry_fee),
    stopLoss: pos.stop_loss != null ? Number(pos.stop_loss) : undefined,
    takeProfit: pos.take_profit != null ? Number(pos.take_profit) : undefined,
    liquidationPrice: Number(pos.liquidation_price),
  };

  const closed = computeClose(fill, exitPrice, exitReason, {
    feeRatePct,
    openedAt: new Date(pos.opened_at).getTime(),
    closedAt: Date.now(),
  });

  await sb.from('paper_positions').update({
    status: 'closed',
    exit_price: closed.exitPrice,
    exit_reason: closed.exitReason,
    exit_fee: closed.exitFee,
    gross_pnl: closed.grossPnl,
    realized_pnl: closed.realizedPnl,
    pnl_pct: closed.pnlPct,
    closed_at: new Date().toISOString(),
  }).eq('id', positionId);

  // 계좌 반영
  try {
    const acct = await getPaperAccount(sb, pos.user_id);
    await sb.from('paper_accounts').update({
      balance: Number(acct.balance) + closed.grossPnl - closed.exitFee,
      total_pnl: Number(acct.total_pnl) + closed.realizedPnl,
      total_fees: Number(acct.total_fees) + closed.exitFee,
      trade_count: Number(acct.trade_count) + 1,
      win_count: Number(acct.win_count) + (closed.realizedPnl > 0 ? 1 : 0),
      updated_at: new Date().toISOString(),
    }).eq('user_id', pos.user_id);
  } catch {}

  return { ok: true, realizedPnl: closed.realizedPnl, pnlPct: closed.pnlPct };
}

// 반대 신호 시 기존 포지션 청산 (REVERSE)
export async function closeOpposingPositions(
  sb: any, userId: string, symbol: string, newSide: 'LONG' | 'SHORT', currentPrice: number, feeRatePct = 0.05
): Promise<number> {
  const opposing = newSide === 'LONG' ? 'SHORT' : 'LONG';
  const { data } = await sb.from('paper_positions')
    .select('id').eq('user_id', userId).eq('symbol', symbol).eq('side', opposing).eq('status', 'open');
  if (!Array.isArray(data) || !data.length) return 0;
  let n = 0;
  for (const p of data) {
    const r = await closePaperPosition(sb, p.id, currentPrice, 'REVERSE', feeRatePct);
    if (r.ok) n++;
  }
  return n;
}
