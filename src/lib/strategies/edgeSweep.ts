// src/lib/strategies/edgeSweep.ts
//
// **우위를 촘촘히 훑어 어디서 뒤집히는지 찾는다.**
//
// 지금은 무우위 / +5%p / +10%p 세 점만 돌린다. 그런데 실제로 갈리는
// 구간은 그 사이였다 — 10슬롯이 +5%p에서 한 번 -80%, 한 번 +552%로
// 갈렸고 +10%p에서는 두 번 다 목표를 찍었다. **세 점으로는 어디서
// 뒤집히는지 알 수 없다.**
//
// 이 파일이 그 사이를 채운다. 두 가지를 훑는다.
//
//   sweepEdges  0~15%p 우위를 1%p 간격으로 — **얼마나 맞혀야 하는가**
//   sweepGrid   TP/SL을 주변 설정으로 흔들어 — **그 한 점에서만 좋은가**
//
// 왜 둘로 나눴는가
// ────────────────
// 우위 사다리는 **단조롭다.** 우위가 커지면 기대값은 반드시 커진다 —
// 그래서 우위 사다리에서 "최고점 주변이 버티는가"를 묻는 것은 뜻이 없다.
// 최고점은 언제나 사다리의 끝이고, 그 옆은 언제나 조금 낮다.
//
// 과최적화는 **설정 격자**에서 생긴다. TP 1.03 / SL 0.47만 좋고 그 옆이
// 손실이면 그건 전략이 아니라 격자의 운이다. 그래서 plateau 판정은
// sweepGrid에만 건다. sweepEdges에 걸면 언제나 '넓다'가 나오고, 그건
// 검사가 아니라 장식이다.
//
// 무엇을 답하는가
// ───────────────
//   · 이 전략은 **최소 몇 %p의 우위**가 있어야 안 잃는가 (공식)
//   · 시뮬에서 **실제로 몇 %p부터** 견고해지는가 (실측)
//   · 그 둘이 얼마나 벌어져 있는가
//   · 그 성적이 **주변 TP/SL에서도** 나오는가
//
// 세 번째가 중요하다. 공식상 손익분기가 +0.5%p인데 시뮬에서 +6%p부터
// 견고하다면, 그 차이가 **변동성이 먹는 몫**이다. 기대값이 양수라고
// 자금관리가 안전한 것은 아니다 — 큰 베팅은 변동성을 못 버티고 먼저
// 죽는다(연구용 10슬롯 +5%p가 40/40 파산이었다).
//
// 무엇을 하지 않는가
// ──────────────────
// **진입 신호의 우위를 검증하지 않는다.** 이 파일은 "그만한 우위가
// 있다면 자금관리가 버티는가"만 답한다. 실제로 그 우위가 존재하는지는
// 실제 캔들 백테스트가 답할 일이고, 그것이 지금 병목이다.
//
// 그리고 **여기서 가장 좋은 설정을 자동으로 채택하지 않는다.** 이 파일은
// 후보와 그 후보가 얼마나 위태로운지를 돌려줄 뿐이다. 채택은 사람이 한다.

import type { StrategyProfile } from './profiles';
import { simSeedOf } from './profiles';
import type { RiskPresetId } from './profilePreset';
import { presetOf, applyPreset } from './profilePreset';
import { monteCarloInputOf, DEFAULT_PATHS, DEFAULT_TRADES } from './profileMonteCarlo';
import { runMonteCarlo } from './monteCarlo';
import {
  requiredEdge, edgeLadder, classify, plateauOf,
  type RobustnessGrade, type PlateauCheck,
} from './robustness';
import { costBreakdown, type CostVerdict } from './costAnalysis';
import { assumedWinRate } from './simModel';

// ── 공통 ──────────────────────────────────────────────────

/** 한 점의 성적. 우위 사다리와 설정 격자가 같은 모양을 쓴다 */
export interface SweepStats {
  /** 비용 후 기대값 (명목가 대비 %) */
  expectancyAfterCost: number;
  /** 비용 판정 — 우위가 없는 것과 비용에 먹힌 것을 가른다 */
  costVerdict: CostVerdict;
  /** 시작 자산보다 많이 끝난 경로 비율 */
  profitProb: number;
  ruinProb: number;
  medianMddPct: number;
  /** 중앙값 수익률 (%) — 시작 자산 대비 */
  medianReturnPct: number;
  /** 배율·명목가 상한에 잘린 거래 비율 */
  cappedTradeRatio: number;
  /**
   * 격자에서 칸끼리 줄 세울 때 쓰는 점수. 기대값이 0 이하면 **null**이다.
   *
   * 왜 기대값이 아닌가는 `EXPECTANCY_IDENTITY_NOTE`에 적어 뒀다.
   */
  score: number | null;
  grade: RobustnessGrade;
  tradable: boolean;
  reason: string;
}

/**
 * **이 모델에서 한 건 기대값은 익절/손절 비율과 무관하다.**
 *
 *   w    = SL/(SL+TP) + e                (simModel.assumedWinRate)
 *   exp  = w·TP − (1−w)·SL − fee
 *        = e·(TP + SL) − fee             ← 비율이 통째로 지워진다
 *
 * 대수적으로 정확하다(코드에서 확인했다: 스윙 TP12/SL6 +3%p → 0.45,
 * 스캘핑 TP0.6/SL0.3 +10%p → 0.0000, 10슬롯 TP1.5/SL0.5 +15%p → 0.21 —
 * 세 경우 모두 공식과 소수점까지 일치한다).
 *
 * 그래서 **기대값으로 TP/SL 격자를 줄 세우면 언제나 가장 넓은 칸이
 * 이긴다.** 그건 그 설정이 좋다는 뜻이 아니라 이 모델의 구조다. 실제로
 * 처음 돌렸을 때 세 프로필 모두 격자의 오른쪽 아래 모서리(TP×1.3,
 * SL×1.3)가 최고점으로 나왔다 — 그 결과를 그대로 "익절·손절을 넓히세요"로
 * 읽으면, 근거 없는 조언을 근거 있는 것처럼 하는 것이 된다.
 *
 * 비율이 실제로 바꾸는 것은 **경로**다. 포지션 크기가 손절 거리에서
 * 역산되므로(monteCarlo), 손익비를 키우면 승률이 떨어지고 한 방이 커진다 —
 * 같은 기대값에서도 파산·낙폭이 완전히 달라진다. 그래서 격자 점수는
 * 경로에서 나온 값(수익으로 끝난 경로 비율)을 쓴다.
 */
export const EXPECTANCY_IDENTITY_NOTE =
  '이 모델의 한 건 기대값은 우위 × (익절 + 손절) − 왕복비용입니다. '
  + '익절/손절 비율은 기대값에서 지워지므로, 기대값으로 격자를 줄 세우면 '
  + '언제나 가장 넓은 칸이 이깁니다 — 그건 설정이 좋다는 뜻이 아니라 '
  + '모델의 구조입니다. 비율이 바꾸는 것은 파산·낙폭 같은 경로 결과입니다.';

/**
 * 공식 기대값. 시뮬 없이 바로 나온다.
 *
 * 시뮬 결과와 이 값이 어긋나면 둘 중 하나가 틀린 것이다 — 테스트가
 * 그것을 잡는다.
 */
export function expectancyIdentity(p: StrategyProfile, edgePp: number): number {
  const tp = Number(p.takeProfitPct), sl = Number(p.stopLossPct);
  const fee = (p.takerFeePct > 0 ? p.takerFeePct : 0.045) * 2;
  return (Number(edgePp) || 0) / 100 * (tp + sl) - fee;
}

interface RunArgs {
  edgePp: number;
  preset: RiskPresetId;
  paths: number;
  trades: number;
  seeds: number;
  plateau: PlateauCheck | null;
}

/**
 * 한 설정을 돌리고 등급까지 매긴다.
 *
 * `p`는 **프리셋이 이미 얹힌 프로필**이어야 한다. monteCarloInputOf가
 * 그렇게 요구한다 — 원본을 넣으면 화면에는 '안정화 5배'라고 적혀 있는데
 * 분포는 50배로 계산된다.
 */
function runOne(p: StrategyProfile, a: RunArgs): SweepStats {
  const input = monteCarloInputOf(p, {
    edgePp: a.edgePp, preset: a.preset, paths: a.paths, trades: a.trades,
  });
  const mc = runMonteCarlo(input);
  const cost = costBreakdown(p, assumedWinRate(p, a.edgePp));

  // **여기가 한 번 비어 있었다.** 중앙값 수익률을 계산하지 않고 0으로
  // 두면 COMPOUNDING_ARTIFACT 판정이 영영 안 걸린다 — 수조 원짜리
  // 결과가 ROBUST로 통과한다. 시작 자산은 monteCarloInputOf가 정한
  // 값을 그대로 쓴다(프로필 시드와 다를 수 있다).
  const start = input.startEquity > 0 ? input.startEquity : simSeedOf(p);
  const medianReturnPct = ((mc.medianEquity - start) / start) * 100;

  const v = classify({
    seeds: a.seeds,
    profitableRate: mc.profitProb,
    ruinRate: mc.ruinProb,
    medianDrawdownPct: mc.medianMddPct,
    expectancyAfterCost: mc.expectancyPct,
    medianReturnPct,
    plateau: a.plateau,
  });

  return {
    expectancyAfterCost: mc.expectancyPct,
    costVerdict: cost.verdict,
    profitProb: mc.profitProb,
    ruinProb: mc.ruinProb,
    medianMddPct: mc.medianMddPct,
    medianReturnPct,
    cappedTradeRatio: mc.cappedTradeRatio,
    // **기대값이 0 이하인 칸은 줄 세울 자격이 없다.** null로 두면
    // plateauOf가 최고점 후보에서 빼고, 이웃으로도 '버텼다'로 안 센다.
    score: mc.expectancyPct > 0 ? mc.profitProb : null,
    grade: v.grade, tradable: v.tradable, reason: v.reason,
  };
}

export interface SweepOptions {
  preset?: RiskPresetId;
  maxEdgePp?: number;
  stepPp?: number;
  paths?: number;
  trades?: number;
  /** 등급 판정에 쓸 표본 수. 생략하면 경로 수로 센다 */
  seedsForGrade?: number;
}

function baseArgs(opts: SweepOptions) {
  const preset = presetOf(opts.preset);
  const paths = opts.paths ?? DEFAULT_PATHS;
  const trades = opts.trades ?? DEFAULT_TRADES;
  // 경로 하나하나가 서로 다른 난수 흐름이므로, 등급 판정에서 '몇 개의
  // 표본을 봤는가'는 경로 수로 센다. seed를 따로 스무 개 돌리는 것과
  // 같은 것은 아니지만, **표본이 하나뿐인 것과는 분명히 다르다.**
  const seeds = opts.seedsForGrade ?? paths;
  return { preset, paths, trades, seeds };
}

// ── 1. 우위 사다리 ────────────────────────────────────────

export interface SweepPoint extends SweepStats {
  edgePp: number;
}

export interface SweepResult {
  profileId: string;
  preset: RiskPresetId;
  points: SweepPoint[];
  /** 공식상 본전이 되는 우위 (%p) */
  breakevenPp: number;
  /** 공식상 안전 우위 (%p) — 손익분기 바로 위는 안전하지 않다 */
  safePp: number;
  /**
   * 시뮬에서 **처음 견고해지는** 우위 (%p). 끝까지 없으면 null.
   *
   * 이 값이 공식 손익분기보다 훨씬 높으면, 그 차이가 변동성이 먹는
   * 몫이다 — 기대값이 양수여도 먼저 죽는 구간이 그만큼 넓다.
   */
  firstRobustPp: number | null;
  /**
   * 견고한 구간 (%p). 끊기지 않고 이어지는 가장 긴 구간이다.
   *
   * **한 점씩 흩어져 있는 것은 구간이 아니다.** 0/+3/+9만 견고하고
   * 그 사이가 아니라면 그건 난수가 만든 무늬에 가깝다.
   */
  robustFromPp: number | null;
  robustToPp: number | null;
  /** 견고 구간이 두 칸 이상 이어지는가 */
  broadRobustZone: boolean;
  /** 사람이 읽는 한 줄 */
  summary: string;
}

/**
 * 우위를 훑는다.
 *
 * **결정적이다.** `profileMonteCarlo.seedFor`가 벽시계를 안 쓰므로 같은
 * 설정은 같은 결과를 낸다 — 두 번 돌려 다른 답이 나오면 설정 차이인지
 * 난수 차이인지 알 수 없다.
 */
export function sweepEdges(
  p: StrategyProfile | null | undefined, opts: SweepOptions = {},
): SweepResult {
  const preset = presetOf(opts.preset);

  if (!p) {
    return {
      profileId: '', preset, points: [],
      breakevenPp: 0, safePp: 0, firstRobustPp: null,
      robustFromPp: null, robustToPp: null, broadRobustZone: false,
      summary: '전략을 찾지 못했습니다',
    };
  }

  const withPreset = applyPreset(p, preset);
  const req = requiredEdge(withPreset);
  const { paths, trades, seeds } = baseArgs(opts);
  const ladder = edgeLadder(opts.maxEdgePp ?? 15, opts.stepPp ?? 1);

  const points: SweepPoint[] = ladder.map(edgePp => ({
    edgePp,
    // **우위 사다리에는 plateau를 걸지 않는다.** 단조로운 축에서
    // "최고점 주변이 버티는가"는 언제나 참이라 검사가 아니다.
    // 과최적화는 sweepGrid가 본다.
    ...runOne(withPreset, { edgePp, preset, paths, trades, seeds, plateau: null }),
  }));

  const zone = longestRobustRun(points);

  return {
    profileId: String(withPreset.id ?? ''),
    preset,
    points,
    breakevenPp: req.breakevenPp,
    safePp: req.safePp,
    firstRobustPp: points.find(pt => pt.grade === 'ROBUST')?.edgePp ?? null,
    robustFromPp: zone.from,
    robustToPp: zone.to,
    broadRobustZone: zone.length >= 2,
    summary: summaryOf(req.breakevenPp, req.safePp, zone),
  };
}

interface RobustRun { from: number | null; to: number | null; length: number }

/** 끊기지 않고 이어지는 가장 긴 견고 구간 */
function longestRobustRun(points: SweepPoint[]): RobustRun {
  let best: RobustRun = { from: null, to: null, length: 0 };
  let i = 0;
  while (i < points.length) {
    if (points[i].grade !== 'ROBUST') { i++; continue; }
    let j = i;
    while (j + 1 < points.length && points[j + 1].grade === 'ROBUST') j++;
    const len = j - i + 1;
    if (len > best.length) {
      best = { from: points[i].edgePp, to: points[j].edgePp, length: len };
    }
    i = j + 1;
  }
  return best;
}

function summaryOf(breakevenPp: number, safePp: number, zone: RobustRun): string {
  const be = `공식상 최소 +${breakevenPp.toFixed(1)}%p · 안전 +${safePp.toFixed(1)}%p`;
  if (zone.from == null) {
    return `${be} · 훑은 범위 안에서는 견고한 구간이 없습니다`
      + ' — 우위를 더 준다고 해결되는 문제가 아닐 수 있습니다';
  }
  const range = zone.length >= 2
    ? `+${zone.from}~+${zone.to}%p`
    : `+${zone.from}%p (그 한 점뿐입니다 — 구간이 아닙니다)`;
  const gap = zone.from - breakevenPp;
  if (gap <= 0.5) {
    return `${be} · 시뮬 견고 구간 ${range}`;
  }
  return `${be} · 시뮬 견고 구간 ${range}`
    + ` — 손익분기와 ${gap.toFixed(1)}%p 벌어져 있고 그 몫을 변동성이 먹습니다`;
}

// ── 2. TP/SL 설정 격자 ────────────────────────────────────

/**
 * TP·SL을 원래 값의 몇 배로 흔들 것인가.
 *
 * 절대값이 아니라 배수인 이유: 스캘핑(TP 0.6)과 스윙(TP 12)에 같은
 * 절대 격자를 쓰면 한쪽은 격자가 너무 촘촘하고 한쪽은 너무 성기다.
 */
export const GRID_MULTIPLIERS = [0.7, 0.85, 1, 1.15, 1.3];

export interface GridCell extends SweepStats {
  key: string;
  takeProfitPct: number;
  stopLossPct: number;
  tpMult: number;
  slMult: number;
  /** 원래 설정 그 자체인가 */
  isBase: boolean;
}

export interface GridResult {
  profileId: string;
  preset: RiskPresetId;
  edgePp: number;
  cells: GridCell[];
  /**
   * 점수가 가장 높은 칸. **기대값이 가장 큰 칸이 아니다** —
   * 그 줄 세우기는 이 모델에서 뜻이 없다(EXPECTANCY_IDENTITY_NOTE).
   */
  best: GridCell | null;
  /** 원래 설정의 칸 */
  base: GridCell | null;
  /** 최고점을 TP 방향으로 흔들었을 때 */
  alongTp: PlateauCheck;
  /** 최고점을 SL 방향으로 흔들었을 때 */
  alongSl: PlateauCheck;
  /**
   * **양쪽 다 버텨야 넓은 것이다.** 한 방향만 버티는 것은 능선이지
   * 고원이 아니다 — 실제 시장은 그 능선 위에 머물러 주지 않는다.
   */
  broad: boolean;
  overfitRisk: boolean;
  /** 견고 등급을 받은 칸 수 */
  robustCells: number;
  /**
   * 기대값으로 줄 세웠다면 어느 칸이 이겼을 것인가.
   *
   * **쓰라고 내놓는 값이 아니다.** 언제나 격자의 가장 넓은 모서리가
   * 나온다는 것을 화면에서 직접 보여 주기 위한 값이다 — 그 자리에
   * `EXPECTANCY_IDENTITY_NOTE`를 같이 붙인다.
   */
  expectancyWinnerKey: string | null;
  /** 기대값 최고 칸이 격자의 모서리(가장 넓은 설정)인가 */
  expectancyWinnerIsWidest: boolean;
  summary: string;
}

export interface GridOptions extends SweepOptions {
  /** 이 우위를 가정하고 격자를 흔든다. 생략하면 안전 우위 */
  edgePp?: number;
  multipliers?: number[];
}

/**
 * TP/SL을 주변으로 흔들어 **그 한 점에서만 좋은지** 본다.
 *
 * 여기서 승률을 고정하지 않는다. TP를 넓히면 무우위 승률이 **떨어지고**
 * (simModel.noEdgeWinRate), 그 하락이 그대로 반영된다. 승률을 고정한 채
 * TP만 넓히면 "익절을 멀리 두면 공짜로 번다"는 착시가 생긴다 — 실제로는
 * 좋은 손익비를 낮은 승률과 맞바꾸는 것이다.
 *
 * **줄 세우기는 기대값으로 하지 않는다.** 이 모델에서 기대값은
 * `우위 × (익절 + 손절) − 비용`이라 비율이 지워진다 — 그걸로 정렬하면
 * 언제나 가장 넓은 칸이 이기고, 그건 설정이 아니라 모델을 본 것이다.
 * 대신 경로에서 나온 값(수익으로 끝난 경로 비율)으로 세운다.
 * 자세한 대수는 `EXPECTANCY_IDENTITY_NOTE`.
 *
 * **결정적이다.** seedFor에 TP/SL이 섞이므로 칸마다 다른 시드를 쓰지만,
 * 같은 칸은 언제나 같은 시드다.
 */
export function sweepGrid(
  p: StrategyProfile | null | undefined, opts: GridOptions = {},
): GridResult {
  const preset = presetOf(opts.preset);
  const empty = (summary: string): GridResult => ({
    profileId: '', preset, edgePp: 0, cells: [], best: null, base: null,
    alongTp: plateauOf([]), alongSl: plateauOf([]),
    broad: false, overfitRisk: false, robustCells: 0,
    expectancyWinnerKey: null, expectancyWinnerIsWidest: false, summary,
  });

  if (!p) return empty('전략을 찾지 못했습니다');

  const withPreset = applyPreset(p, preset);
  const baseTp = Number(withPreset.takeProfitPct);
  const baseSl = Number(withPreset.stopLossPct);
  if (!(baseTp > 0) || !(baseSl > 0)) {
    return empty('익절·손절 폭을 읽지 못해 격자를 만들 수 없습니다');
  }

  const mults = normalizeMults(opts.multipliers);
  const { paths, trades, seeds } = baseArgs(opts);
  // 우위를 안 주면 무우위 격자가 되고, 무우위에서는 모든 칸이 음수라
  // 비교할 것이 없다. 기본은 공식상 '안전' 우위다.
  const edgePp = Number.isFinite(opts.edgePp as number)
    ? Number(opts.edgePp)
    : Number(requiredEdge(withPreset).safePp.toFixed(2));

  const cells: GridCell[] = [];
  for (const slMult of mults) {
    for (const tpMult of mults) {
      const tp = round4(baseTp * tpMult);
      const sl = round4(baseSl * slMult);
      const cellProfile: StrategyProfile = {
        ...withPreset, takeProfitPct: tp, stopLossPct: sl,
      };
      cells.push({
        key: `TP ${tp} / SL ${sl}`,
        takeProfitPct: tp, stopLossPct: sl, tpMult, slMult,
        isBase: tpMult === 1 && slMult === 1,
        // 칸 하나하나에는 plateau를 안 건다 — 격자 전체를 본 뒤에
        // 최고점에만 건다. 모든 칸에 같은 판정을 물리면, 최고점이
        // 뾰족하다는 이유로 멀쩡한 칸까지 OVERFIT가 된다.
        ...runOne(cellProfile, { edgePp, preset, paths, trades, seeds, plateau: null }),
      });
    }
  }

  // **경로 점수로 줄 세운다.** 기대값으로 세우면 언제나 격자의 가장
  // 넓은 모서리가 이긴다 — 그건 설정이 아니라 모델을 본 것이다.
  const best = cells.reduce<GridCell | null>((a, b) => {
    if (b.score == null) return a;
    if (a == null || a.score == null) return b;
    // 동점이면 **원래 설정을 이긴 것으로 치지 않는다.** 격자가 원래
    // 설정을 근거 없이 밀어내는 것을 막는다.
    if (b.score > a.score) return b;
    if (b.score === a.score && a.isBase) return a;
    return a;
  }, null);
  const base = cells.find(c => c.isBase) ?? null;

  // **줄 단위로 본다.** 25칸을 한 줄로 펴서 plateauOf에 넘기면 줄이
  // 바뀌는 자리에서 '이웃'이 이웃이 아니게 된다 — plateauOf는 배열
  // 순서를 그대로 이웃으로 보기 때문이다.
  const alongTp = plateauOf(
    cells.filter(c => c.slMult === best?.slMult)
      .map(c => ({ key: c.key, score: c.score })));
  const alongSl = plateauOf(
    cells.filter(c => c.tpMult === best?.tpMult)
      .map(c => ({ key: c.key, score: c.score })));

  const broad = alongTp.broad && alongSl.broad;

  // 두 방향을 합친 판정. **더 나쁜 쪽을 취한다** — 한 방향이 넓다고
  // 다른 방향의 절벽이 사라지지 않는다.
  const combined: PlateauCheck = {
    bestKey: best ? best.key : null,
    bestScore: best ? best.score : null,
    neighborRatio: worseRatio(alongTp.neighborRatio, alongSl.neighborRatio),
    broad,
    overfitRisk: !broad,
    reason: `TP 방향 — ${alongTp.reason} / SL 방향 — ${alongSl.reason}`,
  };

  // 기대값으로 세웠다면 누가 이겼는가 — **보여 주기 위한 값이다.**
  const expWinner = cells.reduce<GridCell | null>(
    (a, b) => (a == null || b.expectancyAfterCost > a.expectancyAfterCost ? b : a), null);
  const widest = Math.max(...mults);

  // 최고점에만 격자 판정을 물려 등급을 다시 매긴다.
  // (`best`는 `cells` 안의 객체 그대로라, 여기서 고치면 격자에도 반영된다)
  if (best) {
    const v = classify({
      seeds, profitableRate: best.profitProb, ruinRate: best.ruinProb,
      medianDrawdownPct: best.medianMddPct,
      expectancyAfterCost: best.expectancyAfterCost,
      medianReturnPct: best.medianReturnPct,
      plateau: combined,
    });
    best.grade = v.grade; best.tradable = v.tradable; best.reason = v.reason;
  }

  const robustCells = cells.filter(c => c.grade === 'ROBUST').length;

  return {
    profileId: String(withPreset.id ?? ''),
    preset, edgePp, cells, best, base,
    alongTp, alongSl, broad,
    overfitRisk: !broad,
    robustCells,
    expectancyWinnerKey: expWinner ? expWinner.key : null,
    expectancyWinnerIsWidest:
      expWinner != null && expWinner.tpMult === widest && expWinner.slMult === widest,
    summary: gridSummaryOf(best, base, broad, robustCells, cells.length, edgePp),
  };
}

/**
 * 두 방향의 이웃 유지 비율 중 나쁜 쪽.
 *
 * **못 읽은 쪽을 좋은 쪽으로 세지 않는다.** 한쪽이 null(격자가 좁아
 * 판정 불가)이면 남은 쪽 값을 그대로 쓰고, 둘 다 null이면 null이다 —
 * classify는 null이면 과최적화 판정을 걸지 않는다.
 */
function worseRatio(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function normalizeMults(raw: number[] | null | undefined): number[] {
  const list = (Array.isArray(raw) ? raw : GRID_MULTIPLIERS)
    .map(v => Number(v))
    .filter(v => Number.isFinite(v) && v > 0);
  const uniq = Array.from(new Set(list)).sort((a, b) => a - b);
  // 이웃을 볼 수 없는 격자는 plateau 판정을 못 한다. 세 칸이 최소다.
  return uniq.length >= 3 ? uniq : GRID_MULTIPLIERS;
}

const round4 = (v: number) => Number(v.toFixed(4));

function gridSummaryOf(
  best: GridCell | null, base: GridCell | null,
  broad: boolean, robustCells: number, total: number, edgePp: number,
): string {
  if (!best) {
    return `우위 +${edgePp}%p 가정 · ${total}칸 어디에도 양의 기대값이 없어 `
      + '줄 세울 것이 없습니다';
  }
  const head = `우위 +${edgePp}%p 가정 · ${total}칸 중 견고 ${robustCells}칸`;
  const shape = broad
    ? '최고점 주변도 함께 버팁니다 — 넓은 구간입니다'
    : '최고점이 혼자 서 있습니다 — 그 격자에서 운이 좋았던 것일 수 있습니다';

  // **원래 설정보다 좋아 보인다고 바꾸라는 뜻이 아니다.** 격자에서
  // 가장 좋은 칸은 정의상 그 격자의 최고점이고, 그 자리가 다음 달에도
  // 최고점일 이유는 없다.
  const vsBase = base && best.key !== base.key
    ? ` · 원래 설정(${base.key})보다 격자 최고점(${best.key})이 나아 보이지만,`
      + ' 그 차이가 실제 시장에서 유지된다는 근거는 여기에 없습니다'
    : ' · 원래 설정이 격자 최고점입니다';

  // 줄 세우기 기준을 매번 같이 적는다. 이걸 안 적으면 다음 사람이
  // 기대값 열을 보고 "제일 큰 칸이 최고점 아니냐"고 되묻게 된다.
  return `${head} · ${shape}${vsBase} · 줄 세우기는 기대값이 아니라 경로 결과로 했습니다`
    + ` (${EXPECTANCY_IDENTITY_NOTE})`;
}
