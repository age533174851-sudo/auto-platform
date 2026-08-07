// src/lib/strategies/robustness.ts
//
// **가장 많이 번 설정을 고르면 반드시 과최적화된다.**
//
// 지금 시뮬은 무우위 / +5%p / +10%p 세 점만 본다. 그런데 실제로 갈리는
// 구간은 그 사이였다 — 10슬롯이 +5%p에서는 한 번 -80%, 한 번 +552%로
// 갈렸고 +10%p에서는 두 번 다 목표를 찍었다. 세 점으로는 그 사이 어디서
// 뒤집히는지 알 수 없다.
//
// 그리고 격자를 촘촘히 돌리면 새 함정이 생긴다: **가장 좋은 한 점.**
//
//   TP 1.03 / SL 0.47  → 최고 성적
//   TP 1.00 / SL 0.50  → 보통
//   TP 1.06 / SL 0.44  → 손실
//
// 이건 전략이 좋은 게 아니라 그 격자에서 운이 좋았던 것이다. 실제
// 시장은 그 점 위에 머물러 주지 않는다. 그래서 **주변에서도 꾸준히
// 좋은 넓은 구간(plateau)**을 찾아야 한다.
//
// 이 파일이 하는 일
// ─────────────────
// 세 가지다. 전부 순수 함수라서 시뮬을 안 돌려도 확인할 수 있다.
//
//   1. 이 전략이 **최소 얼마의 우위**를 필요로 하는가
//   2. 격자 결과에서 **넓은 구간인가 뾰족한 한 점인가**
//   3. 여러 seed 결과를 모아 **어떤 등급인가**
//
// 규칙 하나: **수익률로 등급을 매기지 않는다.** 한 번 크게 번 것은
// 정보가 아니다. 여러 seed에서 안 죽는 것이 정보다.

import type { StrategyProfile } from './profiles';
import { noEdgeWinRate, breakevenWinRate } from './simModel';

// ── 1. 최소 필요 우위 ──────────────────────────────────────

export interface RequiredEdge {
  /** 무우위 기준 승률 (%) */
  noEdgePct: number;
  /** 본전이 되는 승률 (%) — 수수료 포함 */
  breakevenPct: number;
  /** 본전까지 필요한 우위 (%p). 이만큼은 있어야 안 잃는다 */
  breakevenPp: number;
  /**
   * 안전하게 운용할 만한 우위 (%p).
   *
   * 손익분기 바로 위는 안전하지 않다 — 비용이 조금만 늘거나 승률이
   * 조금만 떨어져도 음수가 된다. 여유를 둔다.
   */
  safePp: number;
  /** 사람이 읽는 한 줄 */
  reason: string;
}

/**
 * 손익분기 위로 얼마나 더 있어야 '안전'으로 볼 것인가.
 *
 * 근거: 손절 폭 대비 비용 비중이 클수록 여유가 더 필요하다. 스캘핑은
 * 손절 0.3%에 왕복 비용 0.09%라 손절의 30%가 비용이다 — 비용이 조금만
 * 어긋나도 기대값 부호가 바뀐다. 스윙은 손절 6%에 같은 비용이라
 * 1.5%밖에 안 된다.
 */
const SAFETY_MULTIPLIER = 1.5;
const MIN_SAFETY_PP = 2;

export function requiredEdge(p: StrategyProfile | null | undefined): RequiredEdge {
  if (!p) {
    return { noEdgePct: 0, breakevenPct: 0, breakevenPp: 0, safePp: 0,
      reason: '전략을 찾지 못했습니다' };
  }
  const noEdge = noEdgeWinRate(p) * 100;
  const be = breakevenWinRate(p) * 100;
  const bePp = be - noEdge;
  const safePp = Math.max(bePp * SAFETY_MULTIPLIER, bePp + MIN_SAFETY_PP);

  return {
    noEdgePct: noEdge,
    breakevenPct: be,
    breakevenPp: bePp,
    safePp,
    reason: `무우위 ${noEdge.toFixed(1)}% · 손익분기 ${be.toFixed(1)}%`
      + ` — 최소 +${bePp.toFixed(1)}%p, 안전하려면 +${safePp.toFixed(1)}%p 필요`,
  };
}

/**
 * 우위를 얼마나 촘촘히 훑을 것인가.
 *
 * 0 / +5 / +10 세 점은 너무 성기다. 10슬롯이 +5와 +10 사이에서 완전히
 * 갈렸는데, 세 점으로는 어디서 뒤집히는지 알 수 없다.
 */
export function edgeLadder(maxPp = 15, stepPp = 1): number[] {
  const step = Math.max(0.1, Number(stepPp) || 1);
  const max = Math.max(step, Number(maxPp) || 15);
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(4)));
  return out;
}

// ── 2. 넓은 구간인가 뾰족한 점인가 ─────────────────────────

export interface GridPoint {
  /** 이 점의 설정 이름 (TP/SL 조합 등) */
  key?: string;
  /** 이 점의 성적. 무엇이든 좋지만 **비용 후 기대값**을 권한다 */
  score?: number | null;
}

export interface PlateauCheck {
  /** 가장 좋은 점 */
  bestKey: string | null;
  bestScore: number | null;
  /** 최고점의 몇 % 이상을 유지하는 이웃의 비율 */
  neighborRatio: number | null;
  /** 넓은 구간인가 */
  broad: boolean;
  /** 과최적화 위험이 있는가 */
  overfitRisk: boolean;
  reason: string;
}

/**
 * 최고점이 **혼자 서 있는가.**
 *
 * `points`는 격자에서 **서로 이웃한 순서**로 넘겨야 한다 — 이 함수는
 * 순서를 그대로 이웃으로 본다. 뒤섞어 넘기면 판정이 뜻을 잃는다.
 *
 * 판정: 최고점 주변(양옆 각 `radius`칸)이 최고점의 `keepRatio` 이상을
 * 유지하면 넓은 구간이다.
 */
export function plateauOf(
  points: GridPoint[] | null | undefined,
  opts: { radius?: number; keepRatio?: number } = {},
): PlateauCheck {
  const list = (Array.isArray(points) ? points : [])
    .map((p, i) => ({ key: String(p?.key ?? i), score: num(p?.score) }));
  const scored = list.filter(p => p.score != null);

  if (scored.length === 0) {
    return { bestKey: null, bestScore: null, neighborRatio: null,
      broad: false, overfitRisk: false, reason: '성적을 하나도 읽지 못했습니다' };
  }
  if (list.length < 3) {
    // 이웃을 볼 수 없으면 **판정하지 않는다.** '넓다'고 하면 뾰족한
    // 점이 통과하고, '좁다'고 하면 멀쩡한 것이 막힌다.
    const best = scored.reduce((a, b) => (b.score! > a.score! ? b : a));
    return { bestKey: best.key, bestScore: best.score, neighborRatio: null,
      broad: false, overfitRisk: false,
      reason: '격자가 너무 좁아 주변을 볼 수 없습니다 — 판정하지 않습니다' };
  }

  const radius = Math.max(1, Math.floor(opts.radius ?? 1));
  const keep = opts.keepRatio ?? 0.5;

  let bestIdx = 0;
  for (let i = 1; i < list.length; i++) {
    const s = list[i].score, b = list[bestIdx].score;
    if (s != null && (b == null || s > b)) bestIdx = i;
  }
  const best = list[bestIdx].score!;

  // 최고점이 0 이하면 애초에 고를 것이 없다.
  if (best <= 0) {
    return { bestKey: list[bestIdx].key, bestScore: best, neighborRatio: 0,
      broad: false, overfitRisk: false,
      reason: '격자 어디에서도 기대값이 양수가 아닙니다' };
  }

  let neighbors = 0, held = 0;
  for (let d = -radius; d <= radius; d++) {
    if (d === 0) continue;
    const j = bestIdx + d;
    if (j < 0 || j >= list.length) continue;
    neighbors++;
    const s = list[j].score;
    // **못 읽은 이웃은 '버텼다'로 안 센다.** 모르는 것을 통과로 세면
    // 격자가 듬성듬성할수록 무조건 넓어 보인다.
    if (s != null && s >= best * keep) held++;
  }

  const ratio = neighbors > 0 ? held / neighbors : null;
  const broad = ratio != null && ratio >= 0.5;

  return {
    bestKey: list[bestIdx].key,
    bestScore: best,
    neighborRatio: ratio,
    broad,
    overfitRisk: !broad,
    reason: broad
      ? `최고점 주변 ${held}/${neighbors}가 성능을 유지합니다 — 넓은 구간입니다`
      : `최고점 주변 ${held}/${neighbors}만 유지합니다 — 그 한 점에서만 좋습니다`,
  };
}

// ── 3. 등급 ────────────────────────────────────────────────

export type RobustnessGrade =
  /** 여러 seed에서 대부분 살아남고 낙폭도 견딜 만하다 */
  | 'ROBUST'
  /** 방향은 좋은데 표본이나 여유가 부족하다 */
  | 'PROMISING'
  /** 평균은 양수인데 seed마다 결과가 갈린다 */
  | 'FRAGILE_EDGE'
  /** 기대값은 양수인데 파산·낙폭이 과하다 */
  | 'OVER_RISKED'
  /** 그 한 점에서만 좋다 */
  | 'OVERFIT'
  /** 비용 후 기대값이 0 이하 */
  | 'NO_EDGE'
  /** 장기 복리 때문에 숫자가 비현실적으로 커졌다 */
  | 'COMPOUNDING_ARTIFACT'
  /** 판정할 근거가 모자란다 */
  | 'UNKNOWN';

export interface RobustnessInput {
  /** 돌린 seed 수 */
  seeds?: number | null;
  /** 그중 수익으로 끝난 비율 (0~1) */
  profitableRate?: number | null;
  /** 파산 비율 (0~1) */
  ruinRate?: number | null;
  /** 낙폭 중앙값 (%) */
  medianDrawdownPct?: number | null;
  /** 비용 **후** 기대값 (명목가 대비 %) */
  expectancyAfterCost?: number | null;
  /** 격자 판정 */
  plateau?: PlateauCheck | null;
  /** 중앙값 최종 수익률 (%) — 비현실적 복리를 잡는 데만 쓴다 */
  medianReturnPct?: number | null;
}

export interface RobustnessVerdict {
  grade: RobustnessGrade;
  /** 실전에 붙여도 되는가 */
  tradable: boolean;
  reason: string;
  /** 무엇을 더 해야 하는가 */
  nextStep: string;
}

/** 이 이상 벌었다고 나오면 복리 가정이 만든 숫자다 */
export const ARTIFACT_RETURN_PCT = 100_000;
/** 이 이상 최소 seed가 있어야 '여러 seed'라고 할 수 있다 */
export const MIN_SEEDS = 20;

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 등급.
 *
 * **순서가 판정이다.** 위에 있는 것부터 걸린다 — 기대값이 음수면
 * 낙폭이 아무리 낮아도 볼 이유가 없고, 파산이 잦으면 평균 수익이
 * 아무리 커도 쓸 수 없다.
 */
export function classify(input: RobustnessInput | null | undefined): RobustnessVerdict {
  const i = input ?? {};
  const exp = num(i.expectancyAfterCost);
  const seeds = num(i.seeds) ?? 0;
  const win = num(i.profitableRate);
  const ruin = num(i.ruinRate);
  const mdd = num(i.medianDrawdownPct);
  const ret = num(i.medianReturnPct);

  // 0. 근거가 없으면 등급을 매기지 않는다.
  if (exp == null) {
    return { grade: 'UNKNOWN', tradable: false,
      reason: '비용 후 기대값을 계산하지 못했습니다',
      nextStep: '수수료·슬리피지를 포함한 기대값부터 구하세요' };
  }

  // 1. 비용 후 기대값이 0 이하면 나머지는 볼 이유가 없다.
  if (exp <= 0) {
    return { grade: 'NO_EDGE', tradable: false,
      reason: `비용 후 기대값이 ${exp.toFixed(4)}%입니다 — 거래할수록 잃습니다`,
      nextStep: '배율이나 위험을 올려도 해결되지 않습니다. TP/SL 구조와 진입 신호를 바꿔야 합니다' };
  }

  // 2. 숫자가 현실을 떠났으면 그 숫자로 판단하지 않는다.
  if (ret != null && ret >= ARTIFACT_RETURN_PCT) {
    return { grade: 'COMPOUNDING_ARTIFACT', tradable: false,
      reason: `중앙값 수익률 ${ret.toLocaleString()}% — 그 우위가 수천 번 유지된다는 가정이 만든 숫자입니다`,
      nextStep: '실제 기대수익으로 쓰지 마세요. 명목가 상한과 유동성을 넣고 다시 돌리세요' };
  }

  // 3. 파산·낙폭이 과하면 기대값이 양수여도 못 쓴다.
  //    기대값이 양수라고 자금관리가 안전한 것은 아니다 —
  //    큰 베팅은 변동성을 못 버티고 먼저 죽는다.
  if ((ruin != null && ruin >= 0.05) || (mdd != null && mdd >= 50)) {
    return { grade: 'OVER_RISKED', tradable: false,
      reason: ruin != null && ruin >= 0.05
        ? `파산률 ${(ruin * 100).toFixed(1)}% — 기대값이 양수여도 먼저 죽습니다`
        : `낙폭 중앙값 ${mdd!.toFixed(1)}% — 정상적인 운용으로 보기 어렵습니다`,
      nextStep: '거래당 위험과 배율을 낮춰 같은 우위로 다시 돌리세요' };
  }

  // 4. 그 한 점에서만 좋으면 격자가 만든 성적이다.
  if (i.plateau && i.plateau.overfitRisk && i.plateau.neighborRatio != null) {
    return { grade: 'OVERFIT', tradable: false,
      reason: i.plateau.reason,
      nextStep: '주변 설정에서도 버티는 넓은 구간을 찾으세요 — 실제 시장은 그 점 위에 머물지 않습니다' };
  }

  // 5. 표본이 모자라면 아직 등급을 못 준다.
  if (seeds < MIN_SEEDS) {
    return { grade: 'PROMISING', tradable: false,
      reason: `기대값은 양수인데 seed가 ${seeds}개뿐입니다 — 운인지 우위인지 아직 모릅니다`,
      nextStep: `서로 다른 seed로 ${MIN_SEEDS}회 이상 돌리세요` };
  }

  // 6. seed마다 결과가 갈리면 평균을 믿을 수 없다.
  if (win != null && win < 0.7) {
    return { grade: 'FRAGILE_EDGE', tradable: false,
      reason: `수익으로 끝난 seed가 ${(win * 100).toFixed(0)}%뿐입니다 — 경로에 크게 의존합니다`,
      nextStep: '평균 수익률로 판단하지 마세요. 위험을 낮추거나 신호 품질을 올려야 합니다' };
  }

  return {
    grade: 'ROBUST', tradable: true,
    reason: `비용 후 기대값 +${exp.toFixed(4)}%`
      + (win != null ? ` · seed ${(win * 100).toFixed(0)}%가 수익` : '')
      + (mdd != null ? ` · 낙폭 중앙값 ${mdd.toFixed(1)}%` : ''),
    nextStep: '실제 캔들 백테스트로 이 우위가 정말 존재하는지 확인하세요 — 확률 시뮬은 자금관리만 검증합니다',
  };
}

/** 화면에 적을 등급 이름 */
export const GRADE_LABEL: Record<RobustnessGrade, string> = {
  ROBUST: '견고',
  PROMISING: '가능성 있음 · 표본 부족',
  FRAGILE_EDGE: '우위가 불안정',
  OVER_RISKED: '위험 과다',
  OVERFIT: '과최적화 의심',
  NO_EDGE: '우위 없음',
  COMPOUNDING_ARTIFACT: '복리가 만든 숫자',
  UNKNOWN: '판정 불가',
};
