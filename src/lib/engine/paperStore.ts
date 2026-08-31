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
): Promise<{
  ok: boolean;
  /** OPENED | DUPLICATE | NO_ACCOUNT | INSUFFICIENT_MARGIN | ERROR */
  status: 'OPENED' | 'DUPLICATE' | 'NO_ACCOUNT' | 'INSUFFICIENT_MARGIN' | 'ERROR';
  positionId?: string;
  fill?: PaperFill;
  error?: string;
  duplicate?: boolean;
}> {
  const fill = simulateFill(args.plan, args.entryPrice, {
    feeRatePct: args.feeRatePct, slippagePct: args.slippagePct,
    stopLoss: args.stopLoss, takeProfit: args.takeProfit,
  });

  // ── 진입과 수수료는 **한 트랜잭션**이다 ──
  //
  // 예전에는 `paper_positions` INSERT 뒤에 `paper_apply_entry_fee`를 따로
  // 불렀다. 서로 다른 트랜잭션이라 뒤쪽만 실패할 수 있었고, 그러면
  // **포지션은 있는데 수수료가 안 빠진** 계좌가 남는다. 되돌릴 방법도,
  // 알아챌 방법도 없었다 — 실패를 읽는 코드가 한 곳도 없었다.
  //
  // 수익률은 `(balance − initial) / initial`로 나오므로, 한 번 어긋나면
  // 그 뒤의 모든 수익률이 그 위에서 계산된다.
  //
  // 이제 `paper_open_position`(마이그레이션 074) 하나가 계좌 줄을 잠그고,
  // 중복을 보고, 포지션을 넣고, 수수료를 뺀다. 중간에 무엇이 실패하든
  // 통째로 되돌아간다. **부분 성공이라는 상태가 없다.**
  //
  // 금액은 여기서 계산해 넘긴다 — SQL은 원자성만 맡는다.
  try {
    const { data, error } = await sb.rpc('paper_open_position', {
      p_user_id: args.userId,
      p_signal_id: args.signalId ?? null,
      p_strategy_id: args.strategyId ?? null,
      p_bucket: args.bucket || null,
      p_symbol: args.plan.symbol,
      // 현물과 선물은 화면에 보여야 하는 것이 다르다(배율·청산가). 섞어 두면
      // 현물에도 '1배 · 청산가 —'가 뜨고, 사용자는 그걸 '못 읽었다'로 읽는다.
      p_market: args.market || 'USDM',
      p_side: fill.side,
      p_entry_price: fill.entryPrice,
      p_fill_price: fill.fillPrice,
      p_quantity: fill.quantity,
      p_notional: fill.notional,
      p_leverage: fill.leverage,
      p_margin: fill.margin,
      p_stop_loss: fill.stopLoss ?? null,
      p_take_profit: fill.takeProfit ?? null,
      p_liquidation_price: fill.liquidationPrice,
      p_entry_fee: fill.entryFee,
      // 격리인가 교차인가. **청산가가 이미 이 모드로 계산돼 들어온다** —
      // 여기서 모드를 안 적으면 나중에 그 숫자가 어느 공식으로 나온 값인지
      // 알 수 없다.
      p_margin_mode: args.marginMode === 'CROSSED' ? 'CROSSED' : 'ISOLATED',
    });
    if (error) {
      // **옛 두 단계 경로로 되돌아가지 않는다.** 되돌아가면 이 변경이
      // 없애려던 부분 성공이 그대로 살아난다.
      return { ok: false, status: 'ERROR', error: String((error as any).message ?? error) };
    }
    const row = Array.isArray(data) ? data[0] : data;
    const status = String(row?.status ?? '');

    if (status === 'DUPLICATE') {
      return { ok: false, status: 'DUPLICATE', duplicate: true, error: '이미 체결된 신호' };
    }
    if (status === 'INSUFFICIENT_MARGIN') {
      // **정상 상태다.** 오류로 뭉개면 사용자는 왜 안 됐는지 알 수 없다.
      // 앱의 사전 검사는 안내이고, 판정은 계좌를 잠근 트랜잭션이 한다 —
      // 동시에 들어온 두 신호는 둘 다 통과한 것처럼 보일 수 있다.
      return { ok: false, status: 'INSUFFICIENT_MARGIN',
        error: '모의 계좌의 가용 증거금이 부족해 진입하지 않았습니다' };
    }
    if (status === 'NO_ACCOUNT') {
      // 계좌를 여기서 만들지 않는다(071). 시작한 적 없는 계좌가 거래로
      // 생기면 initial_balance의 뜻이 사라진다.
      return { ok: false, status: 'NO_ACCOUNT',
        error: '모의 계좌가 없습니다 — 먼저 모의투자를 시작하세요' };
    }
    if (status !== 'OPENED') {
      return { ok: false, status: 'ERROR', error: `알 수 없는 진입 결과 (${status || '없음'})` };
    }
    // OPENED는 **포지션 생성과 수수료 차감이 둘 다 사실**이라는 뜻이다.
    return { ok: true, status: 'OPENED', positionId: row?.position_id ?? undefined, fill };
  } catch (e: any) {
    return { ok: false, status: 'ERROR', error: String(e?.message ?? e) };
  }
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
