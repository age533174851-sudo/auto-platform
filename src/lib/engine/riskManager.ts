// src/lib/engine/riskManager.ts
// Portfolio Risk Manager — "레버리지가 아니라 계좌 위험을 먼저 정한다".
// 목표 위험(허용 손실액) → 손절 거리로 포지션 크기 계산 → 필요한 레버리지 역산.
// 배율은 결과이지 입력이 아니다.
//
// 이 계층이 주문 권한의 마지막 문이다. AI가 무엇을 추천하든 아래 고정 규칙이 최종 결정한다.
import type { StandardSignal, StrategyBucket } from './signalGateway';
import { BUCKET_RISK } from './signalGateway';
import { calcLiquidationPrice, type BracketTier } from '../safety';
import type { ExpansionResult } from '../strategies/expansionMode';

export type RejectCode =
  | 'DAILY_LOSS_LIMIT'
  | 'TOTAL_RISK_LIMIT'
  | 'INVALID_STOP'
  | 'LIQUIDATION_BEFORE_STOP'
  | 'INSUFFICIENT_MARGIN'
  | 'POSITION_TOO_SMALL'
  | 'EXPANSION_NO_TRADE';

export interface RiskConfig {
  accountEquity: number;
  availableMargin?: number;
  dailyPnl?: number;
  /** 사용자·거래소가 허용하는 절대 상한. 실제 적용 상한은 아래 expansion과 함께 결정된다. */
  maxLeverage: number;
  riskPerTradePct?: number;
  maxAccountRiskPct?: number;
  maxDailyLossPct?: number;
  maxNotionalPct?: number;
  feeRatePct?: number;
  slippagePct?: number;
  minNotional?: number;
  /** @deprecated 청산가는 이제 brackets 기반 정밀식으로 계산한다. tier 조회가 불가능할 때만 쓰인다. */
  maintMarginRate?: number;

  // ── Expansion Mode 게이트 ──────────────────────────────────
  /**
   * evaluateExpansion()의 결과. 호출자가 시장 데이터로 평가해 넘긴다.
   *
   * 넘기지 않으면 일반 모드 상한(normalMaxLeverage)이 적용된다 — fail-closed.
   * expansionMode 모듈의 원칙이 "기본은 일반 모드, Expansion은 예외"이므로,
   * 대변동성 조건을 입증하지 못한 주문에 고배율을 허용하지 않는다.
   */
  expansion?: ExpansionResult | null;
  /** expansion 평가가 없을 때 적용할 상한. 기본 10배. */
  normalMaxLeverage?: number;

  /**
   * 이번 거래에 쓸 수 있는 증거금 상한 (계단식 전략의 1회 격리 증거금).
   *
   * 고정값이 아니라 상한이다. 위험 기반 사이징이 계산한 필요 증거금이
   * 이보다 작으면 작은 쪽을 쓴다. 손절이 넓은 날 계단 증거금을 그대로
   * 밀어넣으면 허용 손실을 초과하기 때문이다.
   */
  maxMargin?: number;

  /**
   * 거래소에서 조회한 실제 leverageBracket ([상한 명목가, MMR, 공제액]).
   * getLeverageBrackets()로 받아 넘긴다. 없으면 내장 fallback 테이블을 쓴다.
   */
  brackets?: BracketTier[] | null;
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

  // ── 0.5) Expansion Mode 게이트 — 이번 주문에 적용할 배율 상한을 정한다 ──
  //
  // 이 계산이 여기 있어야 하는 이유: 예전에는 evaluateExpansion()이 Edge Lab
  // 화면에서만 쓰였고, 주문 경로는 정적 cfg.maxLeverage만 봤다. 그래서 화면이
  // "최대 43배"라고 계산해도 실제 주문에는 아무 구속력이 없었다.
  const normalMax = cfg.normalMaxLeverage ?? 10;
  let leverageCap: number;

  if (cfg.expansion) {
    if (cfg.expansion.mode === 'NO_TRADE') {
      return reject('EXPANSION_NO_TRADE',
        `Expansion 판정이 진입 불가입니다 — ${cfg.expansion.reason}`,
        signal.symbol, side, notes);
    }
    leverageCap = Math.max(1, Math.min(cfg.maxLeverage, cfg.expansion.maxLeverageAllowed));
    notes.push(
      `Expansion ${cfg.expansion.mode} (${cfg.expansion.expansionScore}점) — 배율 상한 ${leverageCap}배` +
      (cfg.expansion.maeConstraint.cappedBy === 'mae' ? ' (과거 MAE 제약)' : '')
    );
  } else {
    // fail-closed: 대변동성 조건을 입증하지 못했으므로 일반 모드 상한을 넘지 않는다.
    leverageCap = Math.max(1, Math.min(cfg.maxLeverage, normalMax));
    if (cfg.maxLeverage > normalMax) {
      notes.push(`Expansion 평가 없음 — 설정 상한 ${cfg.maxLeverage}배 대신 일반 모드 ${leverageCap}배 적용`);
    }
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

  // ── 5) 레버리지 역산 (상한은 0.5단계에서 정한 leverageCap) ──
  //
  // 증거금 예산 = min(가용 증거금, 계단식 1회 증거금).
  // 계단식 전략은 "1회 격리 증거금 $100" 같은 고정 규칙을 갖지만, 그것을
  // 그대로 밀어넣지 않고 상한으로 쓴다. 위험 기반 사이징이 더 작은 값을
  // 요구하면 작은 쪽을 따른다 — 손절이 넓은 날 계단 증거금을 다 쓰면
  // 거래당 허용 손실을 넘긴다.
  const marginBudget = Math.min(availableMargin, cfg.maxMargin ?? Infinity);
  if (cfg.maxMargin != null && cfg.maxMargin < availableMargin) {
    notes.push(`계단식 1회 증거금 상한 $${cfg.maxMargin.toFixed(0)} 적용 (가용 $${availableMargin.toFixed(0)})`);
  }
  if (marginBudget <= 0) {
    return reject('INSUFFICIENT_MARGIN', '이번 거래에 배정할 증거금이 없습니다',
      signal.symbol, side, notes, { riskAmount, stopDistancePct, effectiveStopPct });
  }

  let leverage = Math.max(1, Math.ceil(positionSize / Math.max(marginBudget, 1)));
  leverage = clamp(leverage, 1, leverageCap);
  let requiredMargin = positionSize / leverage;

  if (requiredMargin > marginBudget) {
    positionSize = marginBudget * leverageCap;
    leverage = leverageCap;
    requiredMargin = positionSize / leverage;
    notes.push(`증거금 예산 한계로 포지션 축소 → $${positionSize.toFixed(0)}`);
  }
  notes.push(`역산 레버리지 ${leverage}배 · 필요 증거금 $${requiredMargin.toFixed(2)}`);

  if (requiredMargin > marginBudget) {
    return reject('INSUFFICIENT_MARGIN',
      `증거금 부족 (필요 $${requiredMargin.toFixed(0)} > 예산 $${marginBudget.toFixed(0)})`,
      signal.symbol, side, notes, { riskAmount, stopDistancePct, effectiveStopPct, positionSize, leverage, requiredMargin });
  }

  if (positionSize < minNotional) {
    return reject('POSITION_TOO_SMALL',
      `주문 금액 $${positionSize.toFixed(2)}이 거래소 최소($${minNotional})보다 작습니다`,
      signal.symbol, side, notes, { riskAmount, stopDistancePct, effectiveStopPct, positionSize, leverage, requiredMargin });
  }

  // ── 6) 청산가 — 계단식 유지증거금 정밀식 ──
  //
  // 예전에는 (1/leverage - 0.005) 평탄 근사였다. Binance는 유지증거금률이
  // 포지션 명목가에 따라 계단식으로 오르고 구간마다 공제액이 붙기 때문에,
  // 명목가가 큰 포지션일수록 근사식이 실제 청산가를 낙관적으로 계산한다.
  // calcLiquidationPrice는 cfg.brackets(거래소 실조회)를 우선 쓰고, 없으면
  // 내장 fallback 테이블을 쓴다.
  const quantity = positionSize / signal.entryPrice;
  let liquidationPrice = 0;
  let liquidationDistancePct = 100;   // 1배는 사실상 청산 위험이 없다

  if (leverage > 1) {
    liquidationPrice = calcLiquidationPrice(
      signal.entryPrice,
      leverage,
      side === 'LONG' ? 'buy' : 'sell',
      quantity,
      cfg.brackets,
    );
    if (liquidationPrice > 0) {
      liquidationDistancePct = Math.abs(signal.entryPrice - liquidationPrice) / signal.entryPrice * 100;
    } else {
      // 정밀식이 값을 못 내면(비정상 입력) 근사식으로 물러서되 그 사실을 남긴다.
      const liqMove = Math.max(0, (1 / leverage) - mmr);
      liquidationDistancePct = liqMove * 100;
      liquidationPrice = side === 'LONG'
        ? signal.entryPrice * (1 - liqMove)
        : signal.entryPrice * (1 + liqMove);
      notes.push('청산가: 계단식 계산 실패 — 근사식으로 대체');
    }
    notes.push(
      `청산가 $${liquidationPrice.toFixed(2)} (명목가 $${(quantity * signal.entryPrice).toFixed(0)} 기준` +
      `${cfg.brackets?.length ? ', 거래소 브래킷' : ', 내장 테이블'})`
    );
  }

  // ── 7) 청산이 손절보다 먼저 오면 거부 (경고 아님) ──
  const SAFETY_BUFFER = 1.3;
  if (leverage > 1 && liquidationDistancePct <= effectiveStopPct * SAFETY_BUFFER) {
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
    quantity,
    requiredMargin, leverage,
    liquidationPrice, liquidationDistancePct,
    notes,
  };
}
