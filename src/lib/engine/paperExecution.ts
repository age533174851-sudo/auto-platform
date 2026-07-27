// src/lib/engine/paperExecution.ts
// 가상 체결(Paper) 엔진 — 실주문 없이 체결·손익을 계산한다.
// 손익 계산은 순수 함수로 분리해 검증 가능하게 유지한다.
import type { PositionPlan } from './riskManager';

export type ExitReason = 'TP' | 'SL' | 'LIQUIDATION' | 'MANUAL' | 'REVERSE';

export interface PaperFill {
  side: 'LONG' | 'SHORT';
  entryPrice: number;      // 신호가 제시한 가격
  fillPrice: number;       // 슬리피지 반영 실제 체결가
  quantity: number;
  notional: number;
  leverage: number;
  margin: number;
  entryFee: number;
  stopLoss?: number;
  takeProfit?: number;
  liquidationPrice: number;
}

export interface PaperClose {
  exitPrice: number;
  exitReason: ExitReason;
  exitFee: number;
  grossPnl: number;        // 수수료 전
  realizedPnl: number;     // 수수료 후 (진입 수수료까지 차감)
  pnlPct: number;          // 증거금 대비 ROE %
  holdMs: number;
}

// 시장가 진입 시 슬리피지는 불리한 방향으로 적용한다 (낙관 편향 방지).
export function applySlippage(price: number, side: 'LONG' | 'SHORT', slippagePct: number): number {
  const s = slippagePct / 100;
  return side === 'LONG' ? price * (1 + s) : price * (1 - s);
}

// 승인된 계획 → 가상 체결
export function simulateFill(
  plan: PositionPlan,
  signalEntryPrice: number,
  opts: { feeRatePct?: number; slippagePct?: number; stopLoss?: number; takeProfit?: number } = {}
): PaperFill {
  const feeRate = (opts.feeRatePct ?? 0.05) / 100;   // 편도 수수료
  const slippagePct = opts.slippagePct ?? 0.05;

  const fillPrice = applySlippage(signalEntryPrice, plan.side, slippagePct);
  // 명목가치는 계획대로 유지하고, 체결가 기준으로 수량을 다시 계산한다.
  const notional = plan.positionSize;
  const quantity = notional / fillPrice;
  const entryFee = notional * feeRate;

  return {
    side: plan.side,
    entryPrice: signalEntryPrice,
    fillPrice,
    quantity,
    notional,
    leverage: plan.leverage,
    margin: plan.requiredMargin,
    entryFee,
    stopLoss: opts.stopLoss,
    takeProfit: opts.takeProfit,
    liquidationPrice: plan.liquidationPrice,
  };
}

// 청산 손익 계산
export function computeClose(
  fill: PaperFill,
  exitPrice: number,
  exitReason: ExitReason,
  opts: { feeRatePct?: number; openedAt?: number; closedAt?: number } = {}
): PaperClose {
  const feeRate = (opts.feeRatePct ?? 0.05) / 100;

  // 방향별 손익: 롱은 오르면 이익, 숏은 내리면 이익
  const priceDiff = fill.side === 'LONG'
    ? exitPrice - fill.fillPrice
    : fill.fillPrice - exitPrice;
  const grossPnl = priceDiff * fill.quantity;

  const exitNotional = exitPrice * fill.quantity;
  const exitFee = exitNotional * feeRate;

  // 순손익 = 총손익 - 진입수수료 - 청산수수료
  const realizedPnl = grossPnl - fill.entryFee - exitFee;
  const pnlPct = fill.margin > 0 ? (realizedPnl / fill.margin) * 100 : 0;

  const openedAt = opts.openedAt ?? Date.now();
  const closedAt = opts.closedAt ?? Date.now();

  return { exitPrice, exitReason, exitFee, grossPnl, realizedPnl, pnlPct, holdMs: Math.max(0, closedAt - openedAt) };
}

// 현재가로 청산 조건 판정 (TP/SL/청산 중 무엇이 먼저 걸리는지)
// 보수적 판정: 같은 봉에서 SL과 TP가 동시에 걸리면 SL을 우선한다.
export function checkExitTrigger(
  fill: PaperFill,
  price: { high: number; low: number; last: number }
): ExitReason | null {
  const isLong = fill.side === 'LONG';

  // 1) 청산 먼저 확인 (가장 치명적)
  if (isLong && price.low <= fill.liquidationPrice) return 'LIQUIDATION';
  if (!isLong && price.high >= fill.liquidationPrice) return 'LIQUIDATION';

  // 2) 손절 (같은 봉에서 익절과 겹치면 손절 우선 — 보수적)
  if (fill.stopLoss != null) {
    if (isLong && price.low <= fill.stopLoss) return 'SL';
    if (!isLong && price.high >= fill.stopLoss) return 'SL';
  }

  // 3) 익절
  if (fill.takeProfit != null) {
    if (isLong && price.high >= fill.takeProfit) return 'TP';
    if (!isLong && price.low <= fill.takeProfit) return 'TP';
  }

  return null;
}

// 미실현 손익 (열린 포지션 평가)
export function unrealizedPnl(fill: PaperFill, currentPrice: number): { pnl: number; pnlPct: number } {
  const priceDiff = fill.side === 'LONG'
    ? currentPrice - fill.fillPrice
    : fill.fillPrice - currentPrice;
  const pnl = priceDiff * fill.quantity - fill.entryFee;
  return { pnl, pnlPct: fill.margin > 0 ? (pnl / fill.margin) * 100 : 0 };
}
