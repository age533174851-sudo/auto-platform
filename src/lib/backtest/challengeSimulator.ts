// src/lib/backtest/challengeSimulator.ts
// 3개월 챌린지 시뮬레이터.
//
// 설계 원칙 (중요):
//   목표는 "측정 기준"이지 "달성해야 할 대상"이 아니다.
//   3개월에 맞추려고 레버리지나 위험을 올리지 않는다.
//   진입 조건과 위험 제한은 목표와 독립적으로 유지된다.
//
// 평균 수익률만 보면 운 좋게 성공한 한 번의 백테스트에 속는다.
// 그래서 수천 회 반복해 분포를 본다: 성공률·파산률·소요일·최대낙폭·최악 연속손실.
import { runDailyStrategyBacktest, type DailyBar, type DailyBacktestConfig } from './dailyStrategyBacktest';

export interface ChallengeConfig extends DailyBacktestConfig {
  targetCapital?: number;       // 목표 (기본 100,000)
  horizonDays?: number;         // 기간 (기본 90)
  runs?: number;                // 반복 횟수 (기본 500)
  bustThreshold?: number;       // 이 금액 아래면 파산 (기본 시작자본의 10%)
}

export interface MilestoneStat {
  level: number;                // 1000, 10000, 100000
  reachedPct: number;           // 도달률
  medianDays: number;           // 도달까지 중간 일수 (도달한 경우만)
}

export interface ChallengeResult {
  runs: number;
  horizonDays: number;
  targetCapital: number;

  // 핵심 결과
  successPct: number;           // 기간 내 목표 달성
  bustPct: number;              // 파산
  survivedPct: number;          // 살아남았지만 미달성

  // 분포 (평균이 아니라 분위수)
  p10Capital: number;
  medianCapital: number;
  p90Capital: number;
  bestCapital: number;

  // 위험 지표
  medianMaxDrawdownPct: number;
  worstMaxDrawdownPct: number;
  medianWorstStreak: number;    // 최악 연속손실 중간값
  worstStreak: number;

  // 단계별 도달
  milestones: MilestoneStat[];

  // 성공한 경우의 소요일
  medianDaysToTarget: number | null;

  // 전략 품질 (목표와 무관하게 측정)
  medianWinRate: number;
  medianExpectancyR: number;
  medianTradeRate: number;
  totalLiquidations: number;

  verdict: string;
  honestNote: string;
}

// 다양한 시장 국면의 일봉 생성 — 상승/하락/횡보/고변동을 섞는다
function generateRegimeDaily(days: number, seed: number): DailyBar[] {
  const out: DailyBar[] = [];
  let p = 65000;
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s % 2147483648) / 2147483648; };

  // 국면 길이와 종류를 시드마다 다르게
  let day = 0;
  while (day < days) {
    const regimeLen = 20 + Math.floor(rnd() * 60);
    const roll = rnd();
    // 상승 30% / 하락 25% / 횡보 30% / 고변동 15%
    const drift = roll < 0.30 ? 0.003 + rnd() * 0.004
      : roll < 0.55 ? -(0.003 + rnd() * 0.004)
      : roll < 0.85 ? (rnd() - 0.5) * 0.0008
      : (rnd() - 0.5) * 0.006;
    const vol = roll < 0.85 ? 0.015 + rnd() * 0.02 : 0.04 + rnd() * 0.04;

    for (let i = 0; i < regimeLen && day < days; i++, day++) {
      const r = drift + (rnd() - 0.5) * 2 * vol;
      const open = p, close = Math.max(1, p * (1 + r));
      out.push({
        t: day, open, close,
        high: Math.max(open, close) * (1 + vol * 0.5 * rnd()),
        low: Math.min(open, close) * (1 - vol * 0.5 * rnd()),
        volume: 800 + rnd() * 1200,
      });
      p = close;
    }
  }
  return out;
}

function intradayFor(daily: DailyBar[], seed: number) {
  return (di: number) => {
    const b = daily[di];
    if (!b) return null;
    const bars: { high: number; low: number; close: number }[] = [];
    let s = (di * 7919 + seed) >>> 0;
    const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s % 2147483648) / 2147483648; };
    for (let i = 0; i < 24; i++) {
      const t = i / 23;
      const target = b.open + (b.close - b.open) * t;
      const noise = (rnd() - 0.5) * (b.high - b.low) * 0.5;
      const c = Math.max(b.low, Math.min(b.high, target + noise));
      bars.push({
        high: Math.min(b.high, c * (1 + 0.004 * rnd())),
        low: Math.max(b.low, c * (1 - 0.004 * rnd())),
        close: c,
      });
    }
    return bars;
  };
}

const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;

export function runChallenge(cfg: ChallengeConfig = {}): ChallengeResult {
  const target = cfg.targetCapital ?? 100_000;
  const horizon = cfg.horizonDays ?? 90;
  const runs = cfg.runs ?? 500;
  const startCapital = cfg.startCapital ?? 100;
  const bustAt = cfg.bustThreshold ?? startCapital * 0.1;

  // 워밍업(5v5에 필요한 일봉) + 실제 기간
  const WARMUP = 30;
  const totalDays = horizon + WARMUP;

  let success = 0, bust = 0, survived = 0, totalLiq = 0;
  const finals: number[] = [];
  const drawdowns: number[] = [];
  const streaks: number[] = [];
  const winRates: number[] = [];
  const expectancies: number[] = [];
  const tradeRates: number[] = [];
  const daysToTarget: number[] = [];
  const milestoneHits: Record<number, number[]> = { 1000: [], 10000: [], 100000: [] };

  for (let run = 0; run < runs; run++) {
    const seed = 1000 + run * 37;
    const daily = generateRegimeDaily(totalDays, seed);

    const r = runDailyStrategyBacktest(
      daily,
      { ...cfg, startCapital },   // 위험 규칙은 그대로 — 목표 때문에 바꾸지 않는다
      intradayFor(daily, seed),
    );

    totalLiq += r.liquidationCount;
    winRates.push(r.winRate);
    expectancies.push(r.expectancyR);
    tradeRates.push(r.tradeRate);
    streaks.push(r.maxConsecutiveLosses);

    // 자본 곡선에서 마일스톤·최대낙폭 추적
    let peak = startCapital, maxDD = 0;
    const hit: Record<number, number> = {};
    let reachedTarget = false;
    let dayAtTarget = -1;

    for (const t of r.trades) {
      const cap = t.capitalAfter + (r.totalProtected || 0);
      if (cap > peak) peak = cap;
      const dd = peak > 0 ? (peak - cap) / peak : 0;
      if (dd > maxDD) maxDD = dd;

      for (const lv of [1000, 10000, 100000]) {
        if (!hit[lv] && cap >= lv) hit[lv] = t.dayIndex - WARMUP;
      }
      if (!reachedTarget && cap >= target) {
        reachedTarget = true;
        dayAtTarget = t.dayIndex - WARMUP;
      }
    }

    const finalCap = r.finalCapital + (r.totalProtected || 0);
    finals.push(finalCap);
    drawdowns.push(maxDD * 100);

    for (const lv of [1000, 10000, 100000]) {
      if (hit[lv] != null) milestoneHits[lv].push(hit[lv]);
    }

    if (reachedTarget || r.cyclesCompleted > 0) {
      success++;
      daysToTarget.push(dayAtTarget >= 0 ? dayAtTarget : horizon);
    } else if (finalCap < bustAt) {
      bust++;
    } else {
      survived++;
    }
  }

  const sortedFinals = [...finals].sort((a, b) => a - b);
  const sortedDD = [...drawdowns].sort((a, b) => a - b);
  const sortedStreaks = [...streaks].sort((a, b) => a - b);
  const sortedWR = [...winRates].sort((a, b) => a - b);
  const sortedEV = [...expectancies].sort((a, b) => a - b);
  const sortedTR = [...tradeRates].sort((a, b) => a - b);
  const sortedDays = [...daysToTarget].sort((a, b) => a - b);

  const milestones: MilestoneStat[] = [1000, 10000, 100000].map(lv => {
    const hits = milestoneHits[lv].sort((a, b) => a - b);
    return {
      level: lv,
      reachedPct: (hits.length / runs) * 100,
      medianDays: hits.length ? quantile(hits, 0.5) : 0,
    };
  });

  const successPct = (success / runs) * 100;
  const bustPct = (bust / runs) * 100;
  const medEV = quantile(sortedEV, 0.5);

  let verdict: string;
  if (successPct >= 50) {
    verdict = `${runs}회 중 ${successPct.toFixed(1)}%가 ${horizon}일 내 목표 달성. 다만 이 결과는 생성된 시장 데이터 기준이며 실제 시장과 다를 수 있습니다.`;
  } else if (successPct >= 10) {
    verdict = `달성률 ${successPct.toFixed(1)}% — 가능하지만 대부분의 경로에서 미달성입니다. 운에 크게 좌우됩니다.`;
  } else if (successPct > 0) {
    verdict = `달성률 ${successPct.toFixed(1)}% — 사실상 예외적인 경우에만 달성됩니다.`;
  } else {
    verdict = `${runs}회 모두 ${horizon}일 내 목표에 도달하지 못했습니다. 기간을 늘리거나 전략의 엣지를 개선해야 합니다.`;
  }

  const honestNote = medEV <= 0
    ? `기대값이 ${medEV.toFixed(3)}R로 0 이하입니다. 목표 달성 여부와 무관하게 이 전략은 장기적으로 손실입니다. 기간이나 위험을 조정해도 해결되지 않습니다.`
    : medEV < 0.2
      ? `기대값 +${medEV.toFixed(3)}R은 양수지만 작습니다. 목표까지 도달하려면 엣지 개선이 먼저입니다 — 위험을 키우는 것으로는 해결되지 않습니다.`
      : `기대값 +${medEV.toFixed(3)}R. 엣지가 확인되면 기간은 자연히 따라옵니다.`;

  return {
    runs, horizonDays: horizon, targetCapital: target,
    successPct, bustPct, survivedPct: (survived / runs) * 100,
    p10Capital: quantile(sortedFinals, 0.1),
    medianCapital: quantile(sortedFinals, 0.5),
    p90Capital: quantile(sortedFinals, 0.9),
    bestCapital: sortedFinals[sortedFinals.length - 1] ?? 0,
    medianMaxDrawdownPct: quantile(sortedDD, 0.5),
    worstMaxDrawdownPct: sortedDD[sortedDD.length - 1] ?? 0,
    medianWorstStreak: quantile(sortedStreaks, 0.5),
    worstStreak: sortedStreaks[sortedStreaks.length - 1] ?? 0,
    milestones,
    medianDaysToTarget: sortedDays.length ? quantile(sortedDays, 0.5) : null,
    medianWinRate: quantile(sortedWR, 0.5),
    medianExpectancyR: medEV,
    medianTradeRate: quantile(sortedTR, 0.5),
    totalLiquidations: totalLiq,
    verdict, honestNote,
  };
}

/**
 * 목표 달성에 필요한 엣지를 역산한다.
 * "지금 얼마나 부족한가"를 숫자로 보여준다.
 */
export interface EdgeRequirement {
  requiredDailyPct: number;
  requiredExpectancyR: number;  // 1R이 자본의 riskPct일 때
  currentExpectancyR: number;
  gapMultiple: number;          // 몇 배 개선이 필요한가
  feasible: boolean;
  note: string;
}

export function requiredEdge(
  startCapital: number, targetCapital: number, days: number,
  currentExpectancyR: number, riskPctOfCapital = 10
): EdgeRequirement {
  const multiple = targetCapital / startCapital;
  const requiredDaily = Math.pow(multiple, 1 / days) - 1;
  // 1R이 자본의 riskPct% → 일일 수익률 = expectancy × riskPct
  const requiredR = requiredDaily / (riskPctOfCapital / 100);
  const gap = currentExpectancyR > 0 ? requiredR / currentExpectancyR : Infinity;

  return {
    requiredDailyPct: requiredDaily * 100,
    requiredExpectancyR: requiredR,
    currentExpectancyR,
    gapMultiple: gap,
    feasible: gap <= 5,
    note: gap === Infinity
      ? '현재 기대값이 0 이하라 어떤 기간으로도 목표에 도달하지 못합니다'
      : gap <= 2
        ? `현재 엣지의 ${gap.toFixed(1)}배가 필요합니다 — 파라미터 조정으로 가능한 범위입니다`
        : gap <= 5
          ? `현재 엣지의 ${gap.toFixed(1)}배가 필요합니다 — 전략 개선이 필요합니다`
          : `현재 엣지의 ${gap.toFixed(0)}배가 필요합니다 — 기간을 늘리는 편이 현실적입니다`,
  };
}
