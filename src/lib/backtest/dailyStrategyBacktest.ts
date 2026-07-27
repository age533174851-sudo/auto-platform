// src/lib/backtest/dailyStrategyBacktest.ts
// 1D 5v5 전략 통합 백테스트.
//
// 일반 백테스트와 다른 점 — 실전 규칙을 그대로 반영한다:
//   1. 하루 최대 1회 (5v5가 NO_TRADE면 그날은 거래 없음)
//   2. 계단식 증거금 (구간 내에서는 복리 아님)
//   3. 비대칭 청산 (고정 손절 + 분할 익절 + 트레일링)
//   4. 캔들 내부 청산 판정 (종가만 보고 수익 처리하지 않음)
//   5. 사이클 락 ($100,000 도달 → 자본 리셋)
//
// 이 규칙들을 반영하지 않으면 백테스트는 복리인데 실전은 계단식이라 결과가 완전히 달라진다.
import { evaluateBattle, type BattleInput } from '../strategies/dailyBattle';
import { evaluateLadder, completeCycle, CYCLE_TARGET, CYCLE_BASE, type LadderState } from '../strategies/ladderSizing';
import { initPosition, processBar, type AsymmetricConfig } from '../engine/asymmetricExit';
import { maxSafeLeverage } from './stressTest';
import type { DailyDerivatives } from '../derivatives/history';
import { analyzeDerivatives } from '../derivatives';

export interface DailyBar { t: number; open: number; high: number; low: number; close: number; volume?: number }
export interface IntradayBar { high: number; low: number; close: number }

export interface DailyBacktestConfig {
  startCapital?: number;         // 전략 시작 자본 (기본 $100)
  minMargin?: number;            // 5v5 최소 우위 (기본 12)
  maxLeverage?: number;          // 절대 상한 (기본 100)
  feeRatePct?: number;           // 편도 (기본 0.04)
  slippagePct?: number;          // 기본 0.05
  fundingRatePct?: number;       // 8시간당 (기본 0.01)
  breakEvenAtR?: number;
  trailStartR?: number;
  trailDistanceR?: number;
  maxHoldBars?: number;          // 일중 최대 보유 바 수
  // 파생 히스토리 인덱스 (날짜 'YYYY-MM-DD' → 펀딩·OI)
  derivativesIndex?: Map<string, DailyDerivatives>;
  // 일봉 t를 실제 날짜로 변환 (없으면 파생 데이터 미적용)
  dayToDate?: (dayIndex: number, bar: DailyBar) => string;
}

export interface DailyTrade {
  dayIndex: number;
  side: 'LONG' | 'SHORT';
  battleScore: string;           // "LONG 62 : 38 SHORT"
  tier: string;
  margin: number;                // 격리 증거금
  leverage: number;
  requestedLeverage: number;
  entryPrice: number;
  stopPrice: number;
  liquidationPrice: number;
  realizedR: number;
  pnl: number;                   // 달러
  capitalAfter: number;
  liquidated: boolean;
  exitNote: string;
}

export interface CycleRecord {
  cycleNumber: number;
  startDay: number;
  endDay?: number;
  startCapital: number;
  peakCapital: number;
  endCapital: number;
  tradeCount: number;
  completed: boolean;            // $100,000 도달
  failed: boolean;               // 자본 소진
  protectedAmount: number;
}

export interface DailyBacktestResult {
  derivativesDaysUsed: number;   // 파생 데이터가 실제로 적용된 일수
  trades: DailyTrade[];
  cycles: CycleRecord[];
  totalDays: number;
  tradingDays: number;
  noTradeDays: number;
  tradeRate: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  expectancyR: number;
  liquidationCount: number;
  maxConsecutiveLosses: number;
  finalCapital: number;
  totalProtected: number;
  cyclesCompleted: number;
  cyclesFailed: number;
  verdict: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 일봉 배열 + 각 일자의 일중 데이터로 백테스트.
 * intraday가 없으면 일봉 자체를 단일 바로 사용한다(정밀도 낮음).
 */
export function runDailyStrategyBacktest(
  daily: DailyBar[],
  cfg: DailyBacktestConfig = {},
  intradayProvider?: (dayIndex: number) => IntradayBar[] | null
): DailyBacktestResult {
  const startCapital = cfg.startCapital ?? CYCLE_BASE;
  const minMargin = cfg.minMargin ?? 12;
  const maxLev = cfg.maxLeverage ?? 100;
  const fee = (cfg.feeRatePct ?? 0.04) / 100;
  const slip = (cfg.slippagePct ?? 0.05) / 100;
  const funding = (cfg.fundingRatePct ?? 0.01) / 100;

  const trades: DailyTrade[] = [];
  const cycles: CycleRecord[] = [];

  let ladder: LadderState = {
    currentTierIndex: 0,
    strategyCapital: startCapital,
    realizedEquity: startCapital,
    cycleNumber: 1,
    cycleStartAt: '0',
    protectedProfit: 0,
    cycleLocked: false,
  };
  let currentCycle: CycleRecord = {
    cycleNumber: 1, startDay: 0, startCapital, peakCapital: startCapital,
    endCapital: startCapital, tradeCount: 0, completed: false, failed: false, protectedAmount: 0,
  };

  let noTradeDays = 0, liquidationCount = 0, consec = 0, maxConsec = 0;
  let derivativesDaysUsed = 0;
  const winRs: number[] = [], lossRs: number[] = [];

  const WARMUP = 25;   // 5v5에 필요한 일봉 수

  for (let d = WARMUP; d < daily.length; d++) {
    // ── 1) 5v5 판정 ──
    const window = daily.slice(Math.max(0, d - 30), d);
    const input: BattleInput = {
      dailyCloses: window.map(b => b.close),
      dailyHighs: window.map(b => b.high),
      dailyLows: window.map(b => b.low),
      dailyVolumes: window.map(b => b.volume ?? 1000),
    };
    // 파생 히스토리가 있으면 그날 데이터를 5v5에 주입
    if (cfg.derivativesIndex && cfg.dayToDate) {
      const dateKey = cfg.dayToDate(d, daily[d]);
      const dv = cfg.derivativesIndex.get(dateKey);
      if (dv && dv.coverage !== 'none') {
        const sig = analyzeDerivatives({
          symbol: 'BACKTEST',
          fundingRate: dv.fundingRate,
          nextFundingTime: null,
          openInterest: null,
          openInterestValue: null,
          oiChangePct24h: dv.oiChangePct,
          priceChangePct24h: daily[d - 1]
            ? ((daily[d].close - daily[d - 1].close) / daily[d - 1].close) * 100
            : null,
          markPrice: daily[d].close,
          source: 'binance',
          fetchedAt: 0,
        });
        input.derivativesSignal = {
          longConfirmation: sig.longConfirmation,
          shortConfirmation: sig.shortConfirmation,
          patternLabel: sig.patternLabel,
          crowdingNote: sig.crowdingNote,
          reliability: sig.reliability,
        };
        derivativesDaysUsed++;
      }
    }

    const battle = evaluateBattle(input, { minMargin });

    if (battle.side === 'NO_TRADE') { noTradeDays++; continue; }

    // ── 2) 계단식 증거금 ──
    const lad = evaluateLadder(ladder);
    if (lad.locked || lad.margin <= 0) {
      // 사이클 완료 또는 자본 소진
      if (lad.cycleComplete) {
        const reset = completeCycle(ladder);
        currentCycle.endDay = d; currentCycle.endCapital = ladder.realizedEquity;
        currentCycle.completed = true; currentCycle.protectedAmount = reset.protectedAmount;
        cycles.push(currentCycle);

        ladder = {
          currentTierIndex: 0, strategyCapital: reset.newCapital, realizedEquity: reset.newCapital,
          cycleNumber: reset.newCycleNumber, cycleStartAt: String(d),
          protectedProfit: reset.totalProtected, cycleLocked: false,
        };
        currentCycle = {
          cycleNumber: reset.newCycleNumber, startDay: d, startCapital: reset.newCapital,
          peakCapital: reset.newCapital, endCapital: reset.newCapital, tradeCount: 0,
          completed: false, failed: false, protectedAmount: 0,
        };
        continue;
      }
      // 자본 소진 → 사이클 실패, 재시작
      currentCycle.endDay = d; currentCycle.endCapital = ladder.realizedEquity;
      currentCycle.failed = true;
      cycles.push(currentCycle);

      ladder = {
        currentTierIndex: 0, strategyCapital: CYCLE_BASE, realizedEquity: CYCLE_BASE,
        cycleNumber: ladder.cycleNumber + 1, cycleStartAt: String(d),
        protectedProfit: ladder.protectedProfit, cycleLocked: false,
      };
      currentCycle = {
        cycleNumber: ladder.cycleNumber, startDay: d, startCapital: CYCLE_BASE,
        peakCapital: CYCLE_BASE, endCapital: CYCLE_BASE, tradeCount: 0,
        completed: false, failed: false, protectedAmount: 0,
      };
      continue;
    }
    ladder.currentTierIndex = lad.tier.index;

    // ── 3) 손절 폭 → 안전 배율 역산 ──
    const stopPct = battle.suggestedStopPct ?? 1.5;
    const safeLev = maxSafeLeverage(stopPct, { feeRatePct: fee * 200, slippagePct: slip * 100 });
    const leverage = clamp(Math.min(safeLev, maxLev), 1, maxLev);

    const bar = daily[d];
    const isLong = battle.side === 'LONG';
    const entryPrice = isLong ? bar.open * (1 + slip) : bar.open * (1 - slip);
    const stopPrice = isLong ? entryPrice * (1 - stopPct / 100) : entryPrice * (1 + stopPct / 100);
    const liqDist = (1 / leverage) - 0.005;
    const liquidationPrice = isLong ? entryPrice * (1 - liqDist) : entryPrice * (1 + liqDist);

    const notional = lad.margin * leverage;
    const qty = notional / entryPrice;

    // ── 4) 비대칭 청산 시뮬 ──
    const exitCfg: AsymmetricConfig = {
      side: battle.side, entryPrice, stopPrice, liquidationPrice, quantity: qty,
      breakEvenAtR: cfg.breakEvenAtR ?? 1,
      trailStartR: cfg.trailStartR ?? 2,
      trailDistanceR: cfg.trailDistanceR ?? 1,
      maxHoldBars: cfg.maxHoldBars ?? 24,
    };
    let state = initPosition(exitCfg);
    const bars: IntradayBar[] = intradayProvider?.(d) ?? [
      { high: bar.high, low: bar.low, close: bar.close },
    ];

    let liquidated = false;
    let exitNote = '';
    for (let i = 0; i < bars.length && !state.closed; i++) {
      const res = processBar(exitCfg, state, bars[i], i);
      state = res.state;
      for (const a of res.actions) {
        if (a.event === 'LIQUIDATION') { liquidated = true; exitNote = a.note; }
        else if (a.closeQty > 0) exitNote = a.note;
      }
    }
    // 미청산분은 종가로
    if (!state.closed && state.remainingQty > 0) {
      const lastClose = bars[bars.length - 1].close;
      const riskDist = Math.abs(entryPrice - stopPrice);
      const move = isLong ? lastClose - entryPrice : entryPrice - lastClose;
      state.realizedR += (move / riskDist) * (state.remainingQty / qty);
      exitNote = exitNote || '종가 청산';
    }

    // ── 5) 손익 계산 (R → 달러) ──
    // 1R = 증거금 × (손절거리 × 레버리지)
    const rValue = lad.margin * (stopPct / 100) * leverage;
    let pnl = state.realizedR * rValue;
    // 수수료·펀딩
    const fees = notional * fee * 2;
    const fundingCost = notional * funding * (bars.length / 480);
    pnl -= fees + fundingCost;
    // isolated: 손실은 증거금을 넘지 않는다
    if (liquidated) pnl = -lad.margin;
    pnl = Math.max(pnl, -lad.margin);

    ladder.realizedEquity += pnl;
    ladder.strategyCapital = ladder.realizedEquity;

    if (liquidated) liquidationCount++;
    if (pnl < 0) { consec++; maxConsec = Math.max(maxConsec, consec); } else consec = 0;
    if (state.realizedR > 0) winRs.push(state.realizedR); else lossRs.push(state.realizedR);

    currentCycle.tradeCount++;
    currentCycle.peakCapital = Math.max(currentCycle.peakCapital, ladder.realizedEquity);
    currentCycle.endCapital = ladder.realizedEquity;

    trades.push({
      dayIndex: d, side: battle.side,
      battleScore: `${battle.longTotal.toFixed(0)}:${battle.shortTotal.toFixed(0)}`,
      tier: lad.tier.label, margin: lad.margin, leverage, requestedLeverage: maxLev,
      entryPrice, stopPrice, liquidationPrice,
      realizedR: state.realizedR, pnl, capitalAfter: ladder.realizedEquity,
      liquidated, exitNote,
    });

    // 사이클 목표 즉시 확인
    if (ladder.realizedEquity >= CYCLE_TARGET) {
      const reset = completeCycle(ladder);
      currentCycle.endDay = d; currentCycle.completed = true;
      currentCycle.protectedAmount = reset.protectedAmount;
      cycles.push(currentCycle);
      ladder = {
        currentTierIndex: 0, strategyCapital: reset.newCapital, realizedEquity: reset.newCapital,
        cycleNumber: reset.newCycleNumber, cycleStartAt: String(d),
        protectedProfit: reset.totalProtected, cycleLocked: false,
      };
      currentCycle = {
        cycleNumber: reset.newCycleNumber, startDay: d, startCapital: reset.newCapital,
        peakCapital: reset.newCapital, endCapital: reset.newCapital, tradeCount: 0,
        completed: false, failed: false, protectedAmount: 0,
      };
    }
  }

  if (currentCycle.tradeCount > 0 || cycles.length === 0) cycles.push(currentCycle);

  const n = trades.length || 1;
  const wins = trades.filter(t => t.pnl > 0).length;
  const avgWinR = winRs.length ? winRs.reduce((a, b) => a + b, 0) / winRs.length : 0;
  const avgLossR = lossRs.length ? lossRs.reduce((a, b) => a + b, 0) / lossRs.length : 0;
  const wr = wins / n;
  const expectancyR = wr * avgWinR + (1 - wr) * avgLossR;
  const totalDays = daily.length - WARMUP;

  const completed = cycles.filter(c => c.completed).length;
  const failed = cycles.filter(c => c.failed).length;

  let verdict: string;
  if (trades.length === 0) {
    verdict = '거래가 발생하지 않았습니다. 최소 우위 기준을 낮추거나 데이터 기간을 늘리세요.';
  } else if (liquidationCount / n > 0.2) {
    verdict = `청산률 ${((liquidationCount / n) * 100).toFixed(0)}% — 배율이 손절 폭에 비해 높습니다.`;
  } else if (expectancyR <= 0) {
    verdict = `기대값 ${expectancyR.toFixed(3)}R — 이 설정으로는 장기적으로 손실입니다.`;
  } else if (completed > 0) {
    verdict = `사이클 ${completed}회 완료 · 기대값 +${expectancyR.toFixed(3)}R. 표본과 시장 국면 편향을 확인하세요.`;
  } else {
    verdict = `기대값 +${expectancyR.toFixed(3)}R이지만 사이클($${CYCLE_TARGET.toLocaleString()})은 미달성. 더 긴 기간이 필요합니다.`;
  }

  return {
    trades, cycles, totalDays,
    tradingDays: trades.length, noTradeDays,
    tradeRate: (trades.length / (totalDays || 1)) * 100,
    winRate: wr * 100, avgWinR, avgLossR, expectancyR,
    liquidationCount, maxConsecutiveLosses: maxConsec,
    derivativesDaysUsed,
    finalCapital: ladder.realizedEquity,
    totalProtected: ladder.protectedProfit,
    cyclesCompleted: completed, cyclesFailed: failed,
    verdict,
  };
}
