// src/lib/strategies/monteCarlo.ts
//
// **한 번 돌린 결과는 증거가 아니다.**
//
// 화면은 1,000건을 한 번 돌리고 그 끝 잔고를 보여 줬다. 스윙 +10%p에서
// 25억이 나왔고, 그걸 보면 "이 전략은 된다"고 읽힌다. 그런데 같은 설정을
// 다시 돌리면 다른 숫자가 나온다 — 그 25억은 **한 경로**이고, 그 경로가
// 분포의 어디쯤인지는 화면 어디에도 없었다.
//
// 실제로 이런 일이 생긴다: 같은 설정에서 40%의 경로가 손실인데 화면에
// 걸린 한 경로가 수익이면, 사용자는 그 전략을 실전에 연결한다. 그리고
// 그건 시뮬이 거짓말한 것이 아니라 **한 표본을 결론으로 읽게 놔둔** 것이다.
//
// 여기서 하는 일
// ──────────────
// 같은 설정으로 N개의 경로를 돌리고 **분포**를 돌려준다. 중앙값, 하위 5%,
// 상위 95%, 수익 확률, 파산 확률, 목표 달성 확률, MDD 중앙값과 최악값.
//
// 무엇을 하지 않는가
// ──────────────────
// **이건 백테스트가 아니다.** 실제 캔들도, 실제 진입 조건도 없다.
// 사용자가 "승률이 이만큼이라면"이라고 가정한 값으로 자금 관리가 어떻게
// 되는지를 보는 것뿐이다. 진입 조건에 우위가 있는지는 여기서 **전혀**
// 검증되지 않는다. 그래서 이 모듈의 이름에도, 화면에도 그렇게 적어야 한다.
//
// 검증되지 않는 것들(실제 백테스트가 필요한 자리):
//   · 진입 조건이 실제로 우위가 있는가
//   · 같은 봉에서 익절과 손절이 둘 다 닿았을 때 무엇이 먼저인가
//   · 갭·슬리피지·펀딩비·미체결·PostOnly 취소
//   · 추세장과 횡보장에서 성과가 갈리는가
//   · 큰 자금에서 체결이 되는가

/**
 * 결정론적 난수. `Math.random()`을 쓰면 같은 시드로 같은 결과가 안 나와
 * 테스트를 붙일 수 없고, 사용자가 "아까 그 결과"를 다시 볼 수도 없다.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MonteCarloInput {
  /** 경로 하나당 거래 수 */
  trades: number;
  /** 경로 수. 하나면 그건 분포가 아니다 */
  paths: number;
  startEquity: number;
  /** 1회 위험 — 손절에 닿았을 때 잃는 자산 비율(%) */
  riskPerTradePct: number;
  /** 가정 승률 0~1 */
  winRate: number;
  /** 이겼을 때 명목가 대비 순이익 % (익절 − 왕복비용) */
  winNetPct: number;
  /** 졌을 때 명목가 대비 순손실 % (손절 + 왕복비용). **양수로 넣는다** */
  lossNetPct: number;
  /** 손절 폭(명목가 대비 %). 포지션 크기를 여기서 역산한다 */
  stopLossPct: number;
  /**
   * 배율 상한. 1회 위험이 크고 손절이 좁으면 필요한 명목가가 계좌의
   * 수십 배가 되는데, 거래소는 그걸 안 받아 준다. 상한을 안 두면
   * **실행 불가능한 크기로 번 돈**이 결과에 들어간다.
   */
  maxLeverage?: number | null;
  /**
   * 명목가 상한(절대액). 계좌가 커질수록 같은 비율로 복리를 돌리면
   * 유동성이 없는 크기까지 간다 — 25억이 나온 이유의 일부다.
   */
  maxNotional?: number | null;
  /** 목표 잔고. 도달하면 그 경로는 거기서 멈춘다 */
  targetEquity?: number | null;
  /**
   * 파산 판정선. 이 아래로 내려간 경로는 거기서 끝난다.
   * 기본은 시작 자산의 5% — 그 밑에서는 사실상 회복이 불가능하다.
   */
  ruinEquity?: number | null;
  seed: number;
}

export interface MonteCarloResult {
  paths: number;
  trades: number;
  /** 최종 잔고 분포 */
  medianEquity: number;
  p5Equity: number;
  p95Equity: number;
  /** 시작 자산보다 많이 끝난 경로 비율 0~1 */
  profitProb: number;
  /** 파산선 아래로 간 경로 비율 0~1 */
  ruinProb: number;
  /** 목표에 닿은 경로 비율 0~1. 목표가 없으면 null */
  targetProb: number | null;
  /** 최대낙폭(%) — 중앙값과 최악값 */
  medianMddPct: number;
  worstMddPct: number;
  /** 한 건 기대값(명목가 대비 %). 음수면 경로 수를 늘려도 안 바뀐다 */
  expectancyPct: number;
  /**
   * 배율 상한에 걸려 의도한 위험만큼 못 실은 거래의 비율 0~1.
   *
   * 이게 높으면 화면의 '1회 위험 10%'는 실제로 일어난 적이 없다 —
   * 설정과 실행이 다른데 결과만 보면 알 수 없다.
   */
  cappedTradeRatio: number;
}

const pct = (v: number) => v / 100;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * 경로를 여러 개 돌려 분포를 낸다.
 *
 * 포지션 크기는 **손절 거리에서 역산한다** — "1회 위험 1%"는 손절에
 * 닿았을 때 자산의 1%를 잃는다는 뜻이므로, 명목가는
 * `자산 × 위험% ÷ 손절%`다. 배율을 올린다고 이 크기가 커지지 않는다.
 * 배율은 **이 크기를 실을 수 있는지**만 정한다 — 그 구분이 없으면
 * "배율을 올리면 수익이 는다"는 착시가 생긴다.
 */
export function runMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  const paths = Math.max(1, Math.floor(input.paths));
  const trades = Math.max(1, Math.floor(input.trades));
  const start = input.startEquity;
  const ruinAt = input.ruinEquity != null ? input.ruinEquity : start * 0.05;
  const target = input.targetEquity ?? null;

  const winNet = pct(input.winNetPct);
  const lossNet = pct(input.lossNetPct);
  const stop = pct(input.stopLossPct);
  const risk = pct(input.riskPerTradePct);
  // **승률이 숫자가 아니면 멈춘다.**
  //
  // 예전 코드는 `Math.max(0, Math.min(1, undefined))` = NaN이었고,
  // `rnd() < NaN`은 언제나 false다. 그래서 300개 경로가 **전부 전패**로
  // 조용히 수렴했다 — 오류도 없고, 결과는 그럴듯한 숫자 하나였다.
  // 조용히 틀리는 쪽이 언제나 더 나쁘다.
  if (!Number.isFinite(input.winRate)) {
    throw new Error(`가정 승률이 숫자가 아닙니다 (${input.winRate}) — 이 값 없이는 경로를 돌릴 수 없습니다`);
  }
  const w = Math.max(0, Math.min(1, input.winRate));

  const finals: number[] = [];
  const mdds: number[] = [];
  let ruined = 0, hitTarget = 0, profitable = 0;
  let cappedTrades = 0, totalTrades = 0;

  for (let p = 0; p < paths; p++) {
    // 경로마다 다른 시드. 같은 시드를 쓰면 N개가 전부 같은 그림이 된다.
    const rnd = mulberry32(input.seed + p * 2654435761);
    let eq = start;
    let peak = start;
    let mdd = 0;
    let reachedTarget = false;
    let isRuined = false;

    for (let t = 0; t < trades; t++) {
      // 손절 거리에서 역산한 명목가.
      let notional = stop > 0 ? (eq * risk) / stop : eq;

      // 거래소가 받아 주는 크기로 자른다. **자르고 나면 위험도 작아진다** —
      // 그 사실이 결과에 반영돼야 설정과 실행이 어긋난 것을 알 수 있다.
      let capped = false;
      if (input.maxLeverage != null && input.maxLeverage > 0) {
        const cap = eq * input.maxLeverage;
        if (notional > cap) { notional = cap; capped = true; }
      }
      if (input.maxNotional != null && input.maxNotional > 0 && notional > input.maxNotional) {
        notional = input.maxNotional; capped = true;
      }
      if (capped) cappedTrades++;
      totalTrades++;

      eq += rnd() < w ? notional * winNet : -notional * lossNet;

      if (eq > peak) peak = eq;
      if (peak > 0) {
        const dd = (peak - eq) / peak * 100;
        if (dd > mdd) mdd = dd;
      }

      // **파산이 먼저다.** 목표를 먼저 보면, 파산선 아래에서 목표를
      // 넘는 일은 없지만 순서를 헷갈리면 판정이 갈린다.
      if (eq <= ruinAt) { isRuined = true; eq = Math.max(eq, 0); break; }
      if (target != null && eq >= target) { reachedTarget = true; break; }
    }

    finals.push(eq);
    mdds.push(mdd);
    if (isRuined) ruined++;
    if (reachedTarget) hitTarget++;
    if (eq > start) profitable++;
  }

  const sortedEq = [...finals].sort((a, b) => a - b);
  const sortedMdd = [...mdds].sort((a, b) => a - b);

  return {
    paths, trades,
    medianEquity: quantile(sortedEq, 0.5),
    p5Equity: quantile(sortedEq, 0.05),
    p95Equity: quantile(sortedEq, 0.95),
    profitProb: profitable / paths,
    ruinProb: ruined / paths,
    targetProb: target == null ? null : hitTarget / paths,
    medianMddPct: quantile(sortedMdd, 0.5),
    worstMddPct: sortedMdd.length ? sortedMdd[sortedMdd.length - 1] : 0,
    expectancyPct: (w * input.winNetPct) - ((1 - w) * input.lossNetPct),
    cappedTradeRatio: totalTrades > 0 ? cappedTrades / totalTrades : 0,
  };
}

/**
 * 이 결과를 실전에 연결해도 되는가.
 *
 * **좋아 보이는 한 경로로 통과시키지 않는다.** 판단은 분포로 한다.
 * 그리고 애매하면 통과가 아니다 — 확인하지 못한 것은 통과가 아니다.
 */
export function verdictOf(r: MonteCarloResult): {
  ok: boolean; code: string; reason: string;
} {
  if (r.expectancyPct <= 0) {
    return { ok: false, code: 'NEGATIVE_EXPECTANCY',
      reason: `한 건 기대값이 ${r.expectancyPct.toFixed(3)}%입니다 — 비용을 넘는 우위가 없습니다. 오래 돌릴수록 확실히 집니다` };
  }
  if (r.ruinProb >= 0.05) {
    return { ok: false, code: 'RUIN_RISK',
      reason: `파산 확률 ${(r.ruinProb * 100).toFixed(1)}% — 기대값이 양수여도 원금을 잃는 경로가 너무 많습니다` };
  }
  if (r.profitProb < 0.5) {
    return { ok: false, code: 'COIN_FLIP',
      reason: `수익으로 끝난 경로가 ${(r.profitProb * 100).toFixed(0)}%뿐입니다 — 화면에 걸린 한 경로가 수익이어도 분포는 그렇지 않습니다` };
  }
  if (r.cappedTradeRatio > 0.1) {
    return { ok: false, code: 'SIZE_NOT_EXECUTABLE',
      reason: `거래의 ${(r.cappedTradeRatio * 100).toFixed(0)}%가 배율·명목가 상한에 잘렸습니다 — 설정한 위험대로 실행된 적이 없습니다` };
  }
  return { ok: true, code: 'DISTRIBUTION_POSITIVE',
    reason: `${r.paths}개 경로 중 ${(r.profitProb * 100).toFixed(0)}%가 수익, 파산 ${(r.ruinProb * 100).toFixed(1)}%. `
      + '다만 이것은 가정 승률로 돌린 자금관리 검증이며, 진입 조건의 우위는 여기서 검증되지 않았습니다' };
}
