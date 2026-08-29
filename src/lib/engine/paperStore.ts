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
    /** 'SPOT' | 'USDM' | 'COINM'. 안 주면 지금까지의 동작대로 USDM */
    market?: string;
    /**
     * 격리인가 교차인가. 안 주면 **격리**다.
     *
     * 기본을 교차로 두지 않는 이유: 교차는 손실이 계좌 전체로 번진다.
     * 값을 안 보낸 옛 호출부가 조용히 교차가 되면 아무도 고르지 않은
     * 위험이 켜진다.
     */
    marginMode?: 'ISOLATED' | 'CROSSED';
  }
): Promise<{ ok: boolean; positionId?: string; fill?: PaperFill; error?: string; duplicate?: boolean;
  /** 진입 수수료가 계좌에 반영됐는가. null이면 시도조차 못 했다 */
  feeApplied?: boolean | null }> {
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
    // 현물과 선물은 화면에 보여야 하는 것이 다르다(배율·청산가). 섞어 두면
    // 현물에도 '1배 · 청산가 —'가 뜨고, 사용자는 그걸 '못 읽었다'로 읽는다.
    market: args.market || 'USDM',
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
    // 격리인가 교차인가. **청산가가 이미 이 모드로 계산돼 들어온다** —
    // 여기서 모드를 안 적으면 나중에 그 숫자가 어느 공식으로 나온 값인지
    // 알 수 없다.
    margin_mode: args.marginMode === 'CROSSED' ? 'CROSSED' : 'ISOLATED',
  };

  const { data, error } = await sb.from('paper_positions').insert(row).select('id').single();
  if (error) {
    if (String(error.code) === '23505') return { ok: false, duplicate: true, error: '이미 체결된 신호' };
    return { ok: false, error: error.message };
  }

  // 진입 수수료 차감 — **읽고 고쳐 쓰지 않는다.**
  //
  // 두 포지션이 동시에 열리면 예전 구조는 둘 다 옛 total_fees를 읽고 각자
  // 덮어써서 한쪽 수수료가 사라졌다. 청산과 같은 고장이라 같은 방식으로
  // 고친다 — SQL이 증가시킨다(마이그레이션 072).
  //
  // 아직 남은 것: 이 INSERT와 수수료 반영은 **한 트랜잭션이 아니다.**
  // 진입은 중복 방지(signal_id 유니크)·규격 검증이 얽혀 있어 통째로 옮기는
  // 것은 이 변경의 범위를 넘는다. 실패하면 아래에 사유가 남는다.
  let feeApplied: boolean | null = null;
  try {
    const { data, error: feeErr } = await sb.rpc('paper_apply_entry_fee', {
      p_user_id: args.userId, p_entry_fee: fill.entryFee,
    });
    if (feeErr) throw new Error(String((feeErr as any).message ?? feeErr));
    const row = Array.isArray(data) ? data[0] : data;
    feeApplied = row?.applied === true;
  } catch { feeApplied = false; }

  // 수수료가 반영되지 않았으면 **반영됐다고 적지 않는다.**
  return { ok: true, positionId: data?.id, fill, feeApplied };
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

  // ── 청산과 정산은 **하나의 트랜잭션**이다 ──
  //
  // 예전에는 조건부 UPDATE로 선점한 다음 계좌를 따로 고쳤다. 선점은 **같은
  // 포지션**을 두 번 닫는 것만 막았고, 두 가지가 남아 있었다.
  //
  //   · 포지션은 CLOSED가 됐는데 계좌 갱신이 실패하면 되돌릴 수 없다.
  //     그 포지션은 다시 닫을 수도 없다 — 장부가 조용히 어긋난다.
  //   · **서로 다른** 두 포지션이 같은 계좌에서 동시에 닫히면, 둘 다 옛
  //     balance를 읽고 각자 덮어써서 한쪽 손익이 사라진다. 선점은 여기서
  //     아무 일도 하지 않는다.
  //
  // 그래서 둘을 `paper_settle_close`(마이그레이션 072) 안으로 옮겼다.
  // 함수 안에서 계좌 정산이 실패하면 **포지션 UPDATE까지 되돌아간다.**
  // 계좌는 읽지 않고 `balance = balance + delta`로 증가시키므로 동시에
  // 닫혀도 두 손익이 모두 남는다.
  //
  // 금액은 위 `computeClose`가 계산한 값을 그대로 넘긴다 — 공식을 SQL에
  // 다시 적지 않는다. 함수가 보장하는 것은 계산이 아니라 원자성이다.
  let settled: any = null;
  try {
    const { data, error: rpcErr } = await sb.rpc('paper_settle_close', {
      p_position_id: positionId,
      p_exit_price: closed.exitPrice,
      p_exit_reason: closed.exitReason,
      p_exit_fee: closed.exitFee,
      p_gross_pnl: closed.grossPnl,
      p_realized_pnl: closed.realizedPnl,
      p_pnl_pct: closed.pnlPct,
    });
    if (rpcErr) throw new Error(String((rpcErr as any).message ?? rpcErr));
    settled = Array.isArray(data) ? data[0] : data;
  } catch (e: any) {
    // **실패를 성공으로 적지 않는다.** 트랜잭션이 통째로 되돌아갔으므로
    // 포지션은 열린 채로 남고, 다음 회차가 다시 집는다.
    return { ok: false, error: `청산을 기록하지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}` };
  }

  if (!settled) {
    // 함수가 아무 줄도 돌려주지 않았다. **닫혔다고 말하지 않는다.**
    return { ok: false, error: '청산을 기록하지 못했습니다: 정산 결과를 받지 못했습니다' };
  }
  if (settled.settled !== true) {
    // 다른 실행기가 먼저 닫았다. 계좌는 그쪽에서 한 번만 움직였다.
    return { ok: false, error: '이미 청산된 포지션' };
  }

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
