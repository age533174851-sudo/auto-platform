// src/lib/backtest/stressTest.ts
// 고배율 스트레스 테스트.
//
// 일반 백테스트가 놓치는 것:
//  - 캔들 내부에서 청산가를 먼저 건드렸는데 종가만 보고 수익으로 계산
//  - 펀딩비 누락
//  - 슬리피지·수수료 과소평가
//
// 이 모듈은 캔들의 high/low를 사용해 intrabar 청산을 먼저 판정한다.
// 청산된 거래는 이후 가격이 얼마나 올라도 수익이 되지 않는다.

export interface StressCandle { t: number; open: number; high: number; low: number; close: number }

export interface StressConfig {
  leverage: number;
  marginPerTrade: number;      // 슬롯 증거금
  stopLossPct: number;
  takeProfitPct: number;
  feeRatePct?: number;         // 편도 수수료 (기본 0.04 = taker)
  slippagePct?: number;        // 기본 0.05
  fundingRatePct?: number;     // 8시간당 (기본 0.01)
  maintMarginRate?: number;    // 기본 0.005
  side?: 'LONG' | 'SHORT';
}

export interface StressTrade {
  entryIdx: number;
  exitIdx: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: 'TP' | 'SL' | 'LIQUIDATION' | 'TIMEOUT';
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  liquidated: boolean;
}

export interface StressResult {
  trades: StressTrade[];
  totalNetPnl: number;
  winRate: number;
  liquidationCount: number;
  liquidationRate: number;      // 청산된 거래 비율
  maxConsecutiveLosses: number;
  maxDrawdownPct: number;
  totalFees: number;
  totalFunding: number;
  // 일반 백테스트와의 차이 — intrabar 청산을 무시했다면 얼마나 부풀려졌는가
  naiveNetPnl: number;
  overstatement: number;
  survivalRate: number;         // 증거금이 남아있는 거래 비율
  verdict: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function runStressTest(
  candles: StressCandle[],
  entrySignals: number[],        // 진입할 캔들 인덱스
  cfg: StressConfig
): StressResult {
  const feeRate = (cfg.feeRatePct ?? 0.04) / 100;
  const slip = (cfg.slippagePct ?? 0.05) / 100;
  const fundingRate = (cfg.fundingRatePct ?? 0.01) / 100;
  const mmr = cfg.maintMarginRate ?? 0.005;
  const side = cfg.side ?? 'LONG';
  const isLong = side === 'LONG';

  const notional = cfg.marginPerTrade * cfg.leverage;
  // 청산 거리: 1/leverage - 유지증거금률
  const liqDistPct = Math.max(0.0001, (1 / cfg.leverage) - mmr);

  const trades: StressTrade[] = [];
  let naiveNetPnl = 0;

  for (const entryIdx of entrySignals) {
    if (entryIdx >= candles.length - 1) continue;
    const entryRaw = candles[entryIdx].close;
    // 슬리피지는 불리한 방향
    const entryPrice = isLong ? entryRaw * (1 + slip) : entryRaw * (1 - slip);
    const qty = notional / entryPrice;

    const liqPrice = isLong ? entryPrice * (1 - liqDistPct) : entryPrice * (1 + liqDistPct);
    const slPrice = isLong ? entryPrice * (1 - cfg.stopLossPct / 100) : entryPrice * (1 + cfg.stopLossPct / 100);
    const tpPrice = isLong ? entryPrice * (1 + cfg.takeProfitPct / 100) : entryPrice * (1 - cfg.takeProfitPct / 100);

    let exitIdx = -1, exitPrice = 0;
    let reason: StressTrade['exitReason'] = 'TIMEOUT';
    let liquidated = false;

    for (let i = entryIdx + 1; i < Math.min(candles.length, entryIdx + 500); i++) {
      const c = candles[i];

      // ① 청산 먼저 — 캔들 내부(high/low)로 판정
      const liqHit = isLong ? c.low <= liqPrice : c.high >= liqPrice;
      if (liqHit) {
        exitIdx = i; exitPrice = liqPrice; reason = 'LIQUIDATION'; liquidated = true; break;
      }
      // ② 손절 (같은 캔들에서 익절과 겹치면 손절 우선 — 보수적)
      const slHit = isLong ? c.low <= slPrice : c.high >= slPrice;
      if (slHit) { exitIdx = i; exitPrice = slPrice; reason = 'SL'; break; }
      // ③ 익절
      const tpHit = isLong ? c.high >= tpPrice : c.low <= tpPrice;
      if (tpHit) { exitIdx = i; exitPrice = tpPrice; reason = 'TP'; break; }
    }

    if (exitIdx < 0) {
      exitIdx = Math.min(candles.length - 1, entryIdx + 500);
      exitPrice = candles[exitIdx].close;
      reason = 'TIMEOUT';
    }

    // 손익
    const priceDiff = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
    const grossPnl = priceDiff * qty;
    const fees = (notional + Math.abs(exitPrice * qty)) * feeRate;
    const holdCandles = exitIdx - entryIdx;
    // 캔들 1개 = 1분 가정 → 480캔들 = 8시간 = 펀딩 1회
    const fundingPeriods = holdCandles / 480;
    const funding = notional * fundingRate * fundingPeriods;

    let netPnl = grossPnl - fees - funding;
    // 청산되면 증거금 전액 손실 (그 이상은 잃지 않음 — isolated)
    if (liquidated) netPnl = -cfg.marginPerTrade;
    // isolated: 손실은 증거금을 넘지 않는다
    netPnl = Math.max(netPnl, -cfg.marginPerTrade);

    trades.push({ entryIdx, exitIdx, entryPrice, exitPrice, exitReason: reason, grossPnl, fees, funding, netPnl, liquidated });

    // 순진한 계산: 청산 무시하고 종가 기준
    const naiveExit = candles[Math.min(candles.length - 1, entryIdx + holdCandles)].close;
    const naiveDiff = isLong ? naiveExit - entryRaw : entryRaw - naiveExit;
    naiveNetPnl += naiveDiff * qty;
  }

  // 집계
  const totalNetPnl = trades.reduce((a, t) => a + t.netPnl, 0);
  const wins = trades.filter(t => t.netPnl > 0).length;
  const liqCount = trades.filter(t => t.liquidated).length;
  const totalFees = trades.reduce((a, t) => a + t.fees, 0);
  const totalFunding = trades.reduce((a, t) => a + t.funding, 0);

  let consec = 0, maxConsec = 0, equity = 0, peak = 0, mdd = 0;
  for (const t of trades) {
    if (t.netPnl < 0) { consec++; maxConsec = Math.max(maxConsec, consec); } else consec = 0;
    equity += t.netPnl;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > mdd) mdd = dd;
  }

  const n = trades.length || 1;
  const liquidationRate = (liqCount / n) * 100;
  const survivalRate = 100 - liquidationRate;
  const overstatement = naiveNetPnl - totalNetPnl;

  let verdict: string;
  if (liquidationRate >= 50) {
    verdict = `거래 절반 이상(${liquidationRate.toFixed(0)}%)이 청산됐습니다. 이 배율에서 이 손절폭은 작동하지 않습니다.`;
  } else if (liquidationRate >= 20) {
    verdict = `청산률 ${liquidationRate.toFixed(0)}% — 배율을 낮추거나 손절을 좁혀야 합니다.`;
  } else if (totalNetPnl < 0) {
    verdict = `청산률은 ${liquidationRate.toFixed(0)}%로 낮지만 수수료·펀딩비 반영 후 손실입니다.`;
  } else {
    verdict = `청산률 ${liquidationRate.toFixed(0)}%, 비용 반영 후 수익. 다만 표본과 시장 국면 편향을 확인하세요.`;
  }

  return {
    trades, totalNetPnl,
    winRate: (wins / n) * 100,
    liquidationCount: liqCount, liquidationRate,
    maxConsecutiveLosses: maxConsec,
    maxDrawdownPct: mdd * 100,
    totalFees, totalFunding,
    naiveNetPnl, overstatement, survivalRate, verdict,
  };
}

// 손절 거리에서 안전 최대 배율 역산 (riskManager와 동일 원리)
export function maxSafeLeverage(
  stopLossPct: number,
  opts: { feeRatePct?: number; slippagePct?: number; maintMarginRate?: number; safetyFactor?: number } = {}
): number {
  const fee = opts.feeRatePct ?? 0.08;
  const slip = opts.slippagePct ?? 0.05;
  const mmr = opts.maintMarginRate ?? 0.005;
  const safety = opts.safetyFactor ?? 1.3;

  const effectiveStop = stopLossPct + fee + slip;
  const requiredLiqDist = effectiveStop * safety;
  const lev = Math.floor(1 / (requiredLiqDist / 100 + mmr));
  return clamp(lev, 1, 125);
}
