// src/lib/backtest/excursion.ts
// MAE/MFE 분석 — 경로 의존성을 측정한다.
//
// 왜 필요한가:
//   종가 수익률만 보면 "그날 +5% 올랐으니 100배면 +500%"라는 결론이 나온다.
//   하지만 실제 경로가 진입 → -0.7% → +1% → +5% 였다면,
//   100배는 -0.5% 지점에서 이미 청산되어 +5%를 못 먹는다.
//
//   MAE (Maximum Adverse Excursion): 진입 후 가장 불리하게 갔던 지점
//   MFE (Maximum Favorable Excursion): 진입 후 가장 유리하게 갔던 지점
//
//   "MAE < 청산거리"인 거래만 그 배율에서 실제로 살아남는다.

import { initPosition, processBar, type AsymmetricConfig } from '../engine/asymmetricExit';

export interface Bar { high: number; low: number; close: number; t?: number }

export interface Excursion {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  maePct: number;          // 최대 불리 이동 % (양수로 표기)
  mfePct: number;          // 최대 유리 이동 %
  closePct: number;        // 종가 기준 수익률 %
  maeBeforeMfe: boolean;   // MAE가 MFE보다 먼저 왔는가 (중요: 먼저 오면 청산 위험)
  maeBarIndex: number;
  mfeBarIndex: number;
  barsHeld: number;
  /**
   * 실현 수익 시뮬레이션용 봉 참조 (복사하지 않는다).
   * MFE는 "가장 좋았던 지점"일 뿐 실제로 그 가격에 팔았다는 뜻이 아니다.
   * 실제 청산 규칙을 태워 보려면 봉 순서가 필요하다.
   */
  bars?: Bar[];
}

/** 진입 후 봉들을 훑어 MAE/MFE를 기록한다 */
export function measureExcursion(
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  bars: Bar[]
): Excursion {
  const isLong = side === 'LONG';
  let mae = 0, mfe = 0, maeIdx = 0, mfeIdx = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    // 불리한 방향: 롱이면 저가, 숏이면 고가
    const adverse = isLong
      ? ((entryPrice - b.low) / entryPrice) * 100
      : ((b.high - entryPrice) / entryPrice) * 100;
    // 유리한 방향
    const favorable = isLong
      ? ((b.high - entryPrice) / entryPrice) * 100
      : ((entryPrice - b.low) / entryPrice) * 100;

    if (adverse > mae) { mae = adverse; maeIdx = i; }
    if (favorable > mfe) { mfe = favorable; mfeIdx = i; }
  }

  const last = bars[bars.length - 1];
  const closePct = last
    ? (isLong ? ((last.close - entryPrice) / entryPrice) * 100
              : ((entryPrice - last.close) / entryPrice) * 100)
    : 0;

  return {
    side, entryPrice,
    maePct: Math.max(0, mae),
    mfePct: Math.max(0, mfe),
    closePct,
    // 같은 봉에서 둘 다 나왔으면(maeIdx === mfeIdx) 불리한 쪽이 먼저였다고 본다.
    // OHLC만으로는 봉 안의 순서를 알 수 없으므로 보수적으로 판정한다.
    maeBeforeMfe: maeIdx <= mfeIdx,
    maeBarIndex: maeIdx, mfeBarIndex: mfeIdx,
    barsHeld: bars.length,
    bars,
  };
}

// ── 배율별 생존 판정 ──────────────────────────────────

export interface SurvivalAtLeverage {
  leverage: number;
  liquidationDistPct: number;
  survived: boolean;
  reason: string;
  /**
   * MFE를 그대로 먹었다고 가정한 수익 — **실현 가능한 값이 아니라 상한**이다.
   *
   * 진입 후 최대 +8%까지 갔다고 해서 봇이 정확히 +8%에서 팔았다고 볼 수 없다.
   * 실제로 얼마를 먹었는지는 realizedAt()으로 청산 규칙을 태워 봐야 한다.
   * 이 값은 "아무리 잘해도 이 이상은 불가능하다"는 천장으로만 쓴다.
   */
  mfeUpperBoundPct: number | null;
}

/**
 * 특정 배율에서 이 거래가 살아남았는지 판정한다.
 * MAE가 청산거리를 넘으면 최종 방향이 맞아도 청산된다.
 */
export function survivalAt(
  ex: Excursion,
  leverage: number,
  opts: { maintMarginRate?: number; feePct?: number; slippagePct?: number } = {}
): SurvivalAtLeverage {
  const mmr = opts.maintMarginRate ?? 0.005;
  const fee = opts.feePct ?? 0.08;      // 왕복
  const slip = opts.slippagePct ?? 0.05;

  const liqDist = Math.max(0.01, (1 / leverage - mmr) * 100);
  // 실효 MAE = 가격 MAE + 슬리피지 (진입가가 불리하게 체결되므로)
  const effectiveMae = ex.maePct + slip;

  if (effectiveMae >= liqDist) {
    return {
      leverage, liquidationDistPct: liqDist, survived: false,
      reason: `MAE ${effectiveMae.toFixed(2)}% ≥ 청산거리 ${liqDist.toFixed(2)}% — 청산됨`,
      mfeUpperBoundPct: null,
    };
  }

  // 살아남음 — MFE를 그대로 먹었다고 가정한 상한값 (실현값이 아니다)
  const grossPct = ex.mfePct * leverage;
  const costPct = (fee + slip) * leverage;
  return {
    leverage, liquidationDistPct: liqDist, survived: true,
    reason: `MAE ${effectiveMae.toFixed(2)}% < 청산거리 ${liqDist.toFixed(2)}% — 생존`,
    mfeUpperBoundPct: grossPct - costPct,
  };
}

// ── 실현 수익 시뮬레이션 ───────────────────────────────
//
// survivalAt이 돌려주는 MFE 기반 값은 상한이다. 실제로 얼마를 먹었는지는
// 진입 후 봉을 순서대로 훑으며 청산 규칙(손절·분할익절·트레일링·시간청산)을
// 적용해야 알 수 있다. asymmetricExit.processBar가 그 판정을 한다.
//
// 봉 안의 순서 문제
// ────────────────
// 한 봉에서 청산가와 익절가를 둘 다 터치하면 OHLC만으로는 어느 쪽이 먼저인지
// 알 수 없다. processBar는 청산 → 손절 → 분할익절 → 트레일링 순으로 검사하므로
// 항상 불리한 쪽을 먼저 적용한다. 고배율에서 결과가 낙관적으로 왜곡되는 것을
// 막기 위한 의도적 선택이다.

export interface RealizedResult {
  leverage: number;
  liquidated: boolean;
  /** 확정 R 배수 합계 (손절 거리 1배 = 1R) */
  realizedR: number;
  /** 증거금 대비 수익률 % (수수료·슬리피지 반영) */
  returnPct: number;
  /** MFE 상한 대비 실제로 얼마나 먹었는가 (0~1). 1이면 최고점에서 전량 청산 */
  captureRatio: number | null;
  exits: { event: string; price: number; rMultiple: number; note: string }[];
  stopPct: number;
  note: string;
}

/**
 * 실제 청산 규칙을 태워 실현 수익을 계산한다.
 *
 * stopPct를 주지 않으면 청산거리의 절반을 손절로 쓴다. 청산가를 손절 대신
 * 쓰는 설계는 안 되므로(청산되면 증거금 전액 손실), 그 사이에 손절을 둔다.
 */
export function realizedAt(
  ex: Excursion,
  leverage: number,
  opts: {
    stopPct?: number;
    maintMarginRate?: number;
    feePct?: number;
    slippagePct?: number;
    partialLadder?: { atR: number; closePct: number }[];
    trailStartR?: number;
    trailDistanceR?: number;
    breakEvenAtR?: number;
    maxHoldBars?: number;
  } = {},
): RealizedResult | null {
  const bars = ex.bars;
  if (!bars || bars.length === 0) return null;

  const mmr = opts.maintMarginRate ?? 0.005;
  const fee = opts.feePct ?? 0.08;
  const slip = opts.slippagePct ?? 0.05;

  const liqDist = Math.max(0.01, (1 / leverage - mmr) * 100);
  const stopPct = opts.stopPct ?? liqDist * 0.5;
  const isLong = ex.side === 'LONG';

  const cfg: AsymmetricConfig = {
    side: ex.side,
    entryPrice: ex.entryPrice,
    stopPrice: isLong
      ? ex.entryPrice * (1 - stopPct / 100)
      : ex.entryPrice * (1 + stopPct / 100),
    liquidationPrice: isLong
      ? ex.entryPrice * (1 - liqDist / 100)
      : ex.entryPrice * (1 + liqDist / 100),
    quantity: 1,
    partialLadder: opts.partialLadder,
    trailStartR: opts.trailStartR,
    trailDistanceR: opts.trailDistanceR,
    breakEvenAtR: opts.breakEvenAtR ?? 1,
    maxHoldBars: opts.maxHoldBars,
  };

  let state = initPosition(cfg);
  const exits: RealizedResult['exits'] = [];
  let liquidated = false;

  for (let i = 0; i < bars.length && !state.closed; i++) {
    const step = processBar(cfg, state, bars[i], i);
    state = step.state;
    for (const a of step.actions) {
      if (a.closeQty > 0 || a.event === 'LIQUIDATION') {
        exits.push({ event: a.event, price: a.price, rMultiple: a.rMultiple, note: a.note });
      }
      if (a.event === 'LIQUIDATION') liquidated = true;
    }
  }

  // 끝까지 안 닫혔으면 마지막 종가로 청산
  if (!state.closed && state.remainingQty > 0) {
    const last = bars[bars.length - 1];
    const move = isLong ? last.close - cfg.entryPrice : cfg.entryPrice - last.close;
    const r = move / Math.abs(cfg.entryPrice - cfg.stopPrice);
    state.realizedR += r * state.remainingQty;
    exits.push({ event: 'CLOSE_AT_END', price: last.close, rMultiple: r, note: '기간 종료 — 마지막 종가로 청산' });
  }

  // R → 가격 % → 증거금 대비 %
  const grossPricePct = state.realizedR * stopPct;
  const costPct = fee + slip;
  const returnPct = (grossPricePct - costPct) * leverage;

  const upperBound = ex.mfePct * leverage - (fee + slip) * leverage;
  const captureRatio = upperBound > 0 ? returnPct / upperBound : null;

  return {
    leverage, liquidated,
    realizedR: state.realizedR,
    returnPct,
    captureRatio,
    exits,
    stopPct,
    note: liquidated
      ? `청산 — 증거금 전액 손실`
      : `실현 ${state.realizedR.toFixed(2)}R · 증거금 대비 ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%` +
        (captureRatio != null ? ` (MFE 상한의 ${(captureRatio * 100).toFixed(0)}%)` : ''),
  };
}

// ── 분포 분석 ─────────────────────────────────────────

export interface ExcursionStats {
  sampleSize: number;
  // MAE 분포
  maeP50: number; maeP75: number; maeP90: number; maeP99: number; maeMax: number;
  // MFE 분포
  mfeP50: number; mfeP90: number; mfeP99: number; mfeMax: number;
  // 배율별 생존률
  survivalByLeverage: { leverage: number; survivalRate: number; avgReturnIfSurvived: number; bigWinCount: number }[];
  // fat-tail 빈도
  daysWith3PctMove: number;
  daysWith5PctMove: number;
  // 100배에서 실제로 큰 수익이 가능했던 날
  fatTailDays: { mfePct: number; maePct: number; returnAt100x: number }[];
  note: string;
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

export function analyzeExcursions(
  excursions: Excursion[],
  leverages: number[] = [100, 50, 25, 10, 5, 2],
  opts: { bigWinThresholdPct?: number } = {}
): ExcursionStats {
  const bigWin = opts.bigWinThresholdPct ?? 300;   // 증거금 대비 +300%
  const n = excursions.length;

  const maes = excursions.map(e => e.maePct).sort((a, b) => a - b);
  const mfes = excursions.map(e => e.mfePct).sort((a, b) => a - b);

  // 봉이 보존돼 있으면 실현 수익으로 집계한다. 없으면 MFE 상한으로 떨어지되
  // 그 사실을 note에 남긴다 — 두 값은 자릿수가 다를 수 있다.
  const hasBars = excursions.some(e => e.bars && e.bars.length);

  const survivalByLeverage = leverages.map(lev => {
    const survived = excursions.filter(e => survivalAt(e, lev).survived);
    const returns = survived.map(e => {
      if (hasBars) {
        const r = realizedAt(e, lev);
        if (r) return r.liquidated ? -100 : r.returnPct;
      }
      return survivalAt(e, lev).mfeUpperBoundPct ?? 0;
    });
    return {
      leverage: lev,
      survivalRate: n ? (survived.length / n) * 100 : 0,
      avgReturnIfSurvived: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0,
      bigWinCount: returns.filter(r => r >= bigWin).length,
    };
  });

  // 100배에서 살아남고 큰 수익이 났던 날
  const fatTailDays = excursions
    .map(e => {
      const s = survivalAt(e, 100);
      if (!s.survived) return null;
      const realized = hasBars ? realizedAt(e, 100) : null;
      const ret = realized && !realized.liquidated ? realized.returnPct : (s.mfeUpperBoundPct ?? 0);
      return ret >= bigWin ? { mfePct: e.mfePct, maePct: e.maePct, returnAt100x: ret } : null;
    })
    .filter((x): x is { mfePct: number; maePct: number; returnAt100x: number } => x !== null)
    .sort((a, b) => b.returnAt100x - a.returnAt100x);

  const s100 = survivalByLeverage.find(s => s.leverage === 100);
  const basis = hasBars
    ? '실현 수익 기준(청산 규칙 시뮬레이션)'
    : '⚠️ MFE 상한 기준 — 최고점에서 전량 청산했다고 가정한 값이라 실현 가능 수익보다 높습니다. 봉 데이터를 함께 넘기면 실현값으로 계산합니다.';
  const note = !n
    ? '표본이 없습니다'
    : s100 && s100.survivalRate < 10
      ? `100배 생존률 ${s100.survivalRate.toFixed(1)}% — 대부분의 거래가 MAE에서 청산됩니다. MAE 중앙값 ${pct(maes, 0.5).toFixed(2)}%가 청산거리 0.50%를 넘습니다. (${basis})`
      : s100
        ? `100배 생존률 ${s100.survivalRate.toFixed(1)}%, 그중 +${bigWin}% 이상 ${s100.bigWinCount}회 (${basis})`
        : '';

  return {
    sampleSize: n,
    maeP50: pct(maes, 0.5), maeP75: pct(maes, 0.75), maeP90: pct(maes, 0.9),
    maeP99: pct(maes, 0.99), maeMax: maes[maes.length - 1] ?? 0,
    mfeP50: pct(mfes, 0.5), mfeP90: pct(mfes, 0.9), mfeP99: pct(mfes, 0.99),
    mfeMax: mfes[mfes.length - 1] ?? 0,
    survivalByLeverage,
    daysWith3PctMove: excursions.filter(e => e.mfePct >= 3).length,
    daysWith5PctMove: excursions.filter(e => e.mfePct >= 5).length,
    fatTailDays: fatTailDays.slice(0, 20),
    note,
  };
}

/**
 * MAE 분포에서 안전한 최대 배율을 역산한다.
 * "거래의 X%가 살아남으려면 배율이 얼마여야 하는가"
 */
export function maxLeverageForSurvivalRate(
  excursions: Excursion[],
  targetSurvivalRate = 90,
  opts: { maintMarginRate?: number; slippagePct?: number } = {}
): { leverage: number; actualSurvivalRate: number; requiredLiqDist: number; note: string } {
  const mmr = opts.maintMarginRate ?? 0.005;
  const slip = opts.slippagePct ?? 0.05;
  if (!excursions.length) {
    return { leverage: 1, actualSurvivalRate: 0, requiredLiqDist: 0, note: '표본 없음' };
  }

  // 목표 생존률에 해당하는 MAE 분위수
  const maes = excursions.map(e => e.maePct + slip).sort((a, b) => a - b);
  const idx = Math.min(maes.length - 1, Math.floor(maes.length * (targetSurvivalRate / 100)));
  const requiredLiqDist = maes[idx];

  // (1/lev - mmr)*100 >= requiredLiqDist  →  lev <= 1/(requiredLiqDist/100 + mmr)
  const lev = Math.max(1, Math.floor(1 / (requiredLiqDist / 100 + mmr)));

  const actual = excursions.filter(e => survivalAt(e, lev, opts).survived).length / excursions.length * 100;

  return {
    leverage: lev,
    actualSurvivalRate: actual,
    requiredLiqDist,
    note: `거래의 ${targetSurvivalRate}%가 살아남으려면 청산거리 ${requiredLiqDist.toFixed(2)}% 이상 필요 → 최대 ${lev}배`,
  };
}
