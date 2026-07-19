// src/lib/engine/riskManager.ts
// Portfolio Risk Manager — "레버리지가 아니라 계좌 위험을 먼저 정한다".
// 목표 위험(허용 손실액) → 손절 거리로 포지션 크기 계산 → 필요한 레버리지 역산.
// 배율은 결과이지 입력이 아니다.
//
// 이 계층이 주문 권한의 마지막 문이다. AI가 무엇을 추천하든 아래 고정 규칙이 최종 결정한다.
import type { StandardSignal, StrategyBucket } from './signalGateway';
import { BUCKET_RISK } from './signalGateway';

export type RejectCode =
  | 'DAILY_LOSS_LIMIT'
  | 'TOTAL_RISK_LIMIT'
  | 'INVALID_STOP'
  | 'LIQUIDATION_BEFORE_STOP'
  | 'INSUFFICIENT_MARGIN'
  | 'POSITION_TOO_SMALL';

export interface RiskConfig {
  accountEquity: number;
  availableMargin?: number;
  dailyPnl?: number;
  maxLeverage: number;
  riskPerTradePct?: number;
  maxAccountRiskPct?: number;
  maxDailyLossPct?: number;
  maxNotionalPct?: number;
  feeRatePct?: number;
  slippagePct?: number;
  minNotional?: number;
  maintMarginRate?: number;
}

export interface PositionPlan {
  approved: boolean;
  rejectCode?: RejectCode;
  rejectReason?: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  riskAmount: number;
  riskAmountWithCosts: number;
  stopDistancePct: number;
  effectiveStopPct: number;
  positionSize: number;
  quantity: number;
  requiredMargin: number;
  leverage: number;
  liquidationPrice: number;
  liquidationDistancePct: number;
  notes: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function reject(code: RejectCode, reason: string, symbol: string, side: 'LONG' | 'SHORT', notes: string[], partial: Partial<PositionPlan> = {}): PositionPlan {
  return {
    approved: false, rejectCode: code, rejectReason: reason,
    symbol, side,
    riskAmount: 0, riskAmountWithCosts: 0, stopDistancePct: 0, effectiveStopPct: 0,
    positionSize: 0, quantity: 0, requiredMargin: 0, leverage: 0,
    liquidationPrice: 0, liquidationDistancePct: 0, notes,
    ...partial,
  };
}

export function planPosition(signal: StandardSignal, cfg: RiskConfig, currentOpenRisk = 0): PositionPlan {
  const notes: string[] = [];
  const side: 'LONG' | 'SHORT' = signal.signal === 'SHORT' ? 'SHORT' : 'LONG';
  const bucket: StrategyBucket = signal.bucket || 'swing';

  const availableMargin = cfg.availableMargin ?? cfg.accountEquity;
  const feeRatePct = cfg.feeRatePct ?? 0.1;
  const slippagePct = cfg.slippagePct ?? 0.05;
  const minNotional = cfg.minNotional ?? 5;
  const mmr = cfg.maintMarginRate ?? 0.005;

  // ── 0) 일일 손실 한도 (최우선 차단) ──
  const maxDailyLossPct = cfg.maxDailyLossPct ?? 3;
  const dailyLossLimit = cfg.accountEquity * (maxDailyLossPct / 100);
  const dailyPnl = cfg.dailyPnl ?? 0;
  if (dailyPnl <= -dailyLossLimit) {
    return reject('DAILY_LOSS_LIMIT',
      `일일 손실 한도 도달 (오늘 $${dailyPnl.toFixed(0)} / 한도 -$${dailyLossLimit.toFixed(0)}) — 오늘은 신규 진입하지 않습니다`,
      signal.symbol, side, notes);
  }

  // ── 1) 거래당 허용 손실 ──
  const bucketRisk = BUCKET_RISK[bucket];
  const riskPct = cfg.riskPerTradePct ?? (bucketRisk.min + (bucketRisk.max - bucketRisk.min) * signal.confidence);
  const riskAmount = cfg.accountEquity * (riskPct / 100);
  notes.push(`${bucketRisk.label} 전략 · 거래당 위험 ${riskPct.toFixed(2)}% ($${riskAmount.toFixed(2)})`);

  // ── 2) 전체 동시 위험 상한 ──
  const maxAccountRisk = cfg.accountEquity * ((cfg.maxAccountRiskPct ?? 5) / 100);
  if (currentOpenRisk + riskAmount > maxAccountRisk) {
    return reject('TOTAL_RISK_LIMIT',
      `전체 위험 한도 초과 (보유 $${currentOpenRisk.toFixed(0)} + 신규 $${riskAmount.toFixed(0)} > 한도 $${maxAccountRisk.toFixed(0)})`,
      signal.symbol, side, notes, { riskAmount });
  }

  // ── 3) 손절 거리 (수수료·슬리피지 포함) ──
  const stopDistancePct = Math.abs(signal.entryPrice - signal.stopLoss) / signal.entryPrice * 100;
  if (!isFinite(stopDistancePct) || stopDistancePct <= 0) {
    return reject('INVALID_STOP', '손절 거리가 0 — 위험 계산 불가', signal.symbol, side, notes, { riskAmount });
  }
  const effectiveStopPct = stopDistancePct + feeRatePct + slippagePct;
  notes.push(`손절 ${stopDistancePct.toFixed(2)}% + 수수료 ${feeRatePct}% + 슬리피지 ${slippagePct}% = 실효 ${effectiveStopPct.toFixed(2)}%`);

  // ── 4) 포지션 크기 = 허용손실 ÷ 실효 손절거리 ──
  let positionSize = riskAmount / (effectiveStopPct / 100);
  notes.push(`포지션 명목가치 $${positionSize.toFixed(0)}`);

  const maxNotional = cfg.accountEquity * ((cfg.maxNotionalPct ?? 300) / 100);
  if (positionSize > maxNotional) {
    positionSize = maxNotional;
    notes.push(`명목가치 상한(${cfg.maxNotionalPct ?? 300}%) 적용 → $${positionSize.toFixed(0)}`);
  }

  // ── 5) 레버리지 역산 ──
  let leverage = Math.max(1, Math.ceil(positionSize / Math.max(availableMargin, 1)));
  leverage = clamp(leverage, 1, cfg.maxLeverage);
  let requiredMargin = positionSize / leverage;

  if (requiredMargin > availableMargin) {
    positionSize = availableMargin * cfg.maxLeverage;
    leverage = cfg.maxLeverage;
    requiredMargin = positionSize / leverage;
    notes.push(`가용 증거금 한계로 포지션 축소 → $${positionSize.toFixed(0)}`);
  }
  notes.push(`역산 레버리지 ${leverage}배 · 필요 증거금 $${requiredMargin.toFixed(2)}`);

  if (requiredMargin > availableMargin) {
    return reject('INSUFFICIENT_MARGIN',
      `증거금 부족 (필요 $${requiredMargin.toFixed(0)} > 가용 $${availableMargin.toFixed(0)})`,
      signal.symbol, side, notes, { riskAmount, stopDistancePct, effectiveStopPct, positionSize, leverage, requiredMargin });
  }

  if (positionSize < minNotional) {
    return reject('POSITION_TOO_SMALL',
      `주문 금액 $${positionSize.toFixed(2)}이 거래소 최소($${minNotional})보다 작습니다`,
      signal.symbol, side, notes, { riskAmount, stopDistancePct, effectiveStopPct, positionSize, leverage, requiredMargin });
  }

  // ── 6) 청산가 ──
  const liqMove = (1 / leverage) - mmr;
  const liquidationDistancePct = Math.max(0, liqMove * 100);
  const liquidationPrice = side === 'LONG'
    ? signal.entryPrice * (1 - liqMove)
    : signal.entryPrice * (1 + liqMove);

  // ── 7) 청산이 손절보다 먼저 오면 거부 (경고 아님) ──
  const SAFETY_BUFFER = 1.3;
  if (liquidationDistancePct <= effectiveStopPct * SAFETY_BUFFER) {
    return reject('LIQUIDATION_BEFORE_STOP',
      `청산 거리(${liquidationDistancePct.toFixed(2)}%)가 손절 거리(${effectiveStopPct.toFixed(2)}%)에 너무 가깝습니다 — ${leverage}배는 위험. 배율을 낮추거나 손절을 좁히세요`,
      signal.symbol, side, notes,
      { riskAmount, stopDistancePct, effectiveStopPct, positionSize, leverage, requiredMargin, liquidationPrice, liquidationDistancePct });
  }
  notes.push(`청산까지 ${liquidationDistancePct.toFixed(1)}% (손절의 ${(liquidationDistancePct / effectiveStopPct).toFixed(1)}배 여유)`);

  return {
    approved: true,
    symbol: signal.symbol, side,
    riskAmount,
    riskAmountWithCosts: positionSize * (effectiveStopPct / 100),
    stopDistancePct, effectiveStopPct,
    positionSize,
    quantity: positionSize / signal.entryPrice,
    requiredMargin, leverage,
    liquidationPrice, liquidationDistancePct,
    notes,
  };
}
