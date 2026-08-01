// src/lib/portfolio/allocation.ts
//
// 자금 배분 정책 — **순수 함수**.
//
// 자산 규모가 커지면 운영 방식이 바뀐다
// ─────────────────────────────────────
// 1,000만 원을 8칸으로 나누면 한 칸이 125만 원이다. 코인 선물은 되지만
// 미국 주식·지수 선물·원유는 **한 칸으로 한 계약도 못 산다.** 그리고 더
// 중요한 것: 칸당 거래 수가 너무 적어져서 **어느 전략이 좋은지 알 수 없게
// 된다.** 3개월에 7칸이면 칸당 표본이 평가 최소치(30거래)에 못 미친다.
// 분산의 이득보다 "전부 통계적으로 무의미해지는" 손해가 크다.
//
// 그래서 칸 수를 자산 규모에 묶는다. 자산이 커지면 시스템이 알아서
// 운영 방식을 바꾼다.
//
// **집중과 과대 포지션은 다르다** — 이 파일에서 가장 중요한 구분
// ───────────────────────────────────────────────────────────────
// "가장 검증된 전략에 자금을 집중한다"는 그 전략의 **배분 비중**을 올리는
// 것이지, 한 거래에 거는 **위험**을 올리는 것이 아니다.
//
//   비중 60% + 거래당 위험 1%  →  손절 한 번에 계좌의 0.6% 손실
//   비중 60% + 거래당 위험 10% →  손절 한 번에 계좌의 6% 손실
//
// 앞은 집중이고 뒤는 도박이다. 화면에서는 둘 다 "그 전략에 집중"으로
// 보인다. 그래서 `riskPerTradePct`는 **등급과 무관하게 상수**다. 자산이
// 커져도 커지지 않고, 칸이 줄어도 커지지 않는다.
//
// 모르면 배분하지 않는다
// ──────────────────────
// 자산을 못 읽었을 때 가장 큰 등급을 주면 안 되는 것은 물론이고, 가장 작은
// 등급을 주는 것도 안 된다 — 작은 등급도 '돌린다'는 뜻이기 때문이다.
// 자산을 모르면 활성 전략 수는 0이다.

import type { StrategyScore } from './strategyScore';

export type TierId = 'unknown' | 'seed' | 'focus' | 'spread' | 'portfolio';

export interface Tier {
  id: TierId;
  label: string;
  /** 이 등급의 하한 (USDT). unknown은 해당 없음 */
  minUsd: number;
  /** 동시에 돌릴 수 있는 전략 수 */
  maxActive: number;
  /** 손대지 않고 남기는 현금 비율 (%) */
  reservePct: number;
  /** 한 전략이 가져갈 수 있는 최대 비중 (배분 가능액 대비, 0~1) */
  maxWeight: number;
  note: string;
}

/**
 * 등급 경계.
 *
 * 원화 기준(1,000만 / 5,000만 / 1억)을 대략 1,430원/달러로 옮긴 값이다.
 * **정확한 환산이 아니다** — 등급 경계는 원래 대략적인 선이고, 환율이
 * 움직였다고 운영 방식이 바뀌어야 하는 성질의 값이 아니다.
 * 환경변수로 덮어쓸 수 있다.
 */
export const TIERS: Tier[] = [
  {
    id: 'seed', label: '집중 (소액)', minUsd: 0,
    maxActive: 1, reservePct: 30, maxWeight: 1,
    note: '가장 검증된 전략 하나만. 나눠 봐야 칸마다 표본이 안 쌓인다',
  },
  {
    id: 'focus', label: '집중', minUsd: 7_000,
    maxActive: 3, reservePct: 20, maxWeight: 0.6,
    note: '검증된 전략 최대 3개. 한 전략이 60%를 넘지 않는다',
  },
  {
    id: 'spread', label: '분산', minUsd: 35_000,
    maxActive: 5, reservePct: 15, maxWeight: 0.4,
    note: '칸마다 의미 있는 규모가 붙기 시작한다',
  },
  {
    id: 'portfolio', label: '포트폴리오', minUsd: 70_000,
    maxActive: 8, reservePct: 10, maxWeight: 0.3,
    note: '시장·전략별 본격 분산. 전략 간 상관관계를 볼 수 있는 규모',
  },
];

export const UNKNOWN_TIER: Tier = {
  id: 'unknown', label: '확인 불가', minUsd: 0,
  maxActive: 0, reservePct: 100, maxWeight: 0,
  note: '자산을 확인하지 못했습니다 — 확인될 때까지 배분하지 않습니다',
};

/**
 * 거래당 위험 상한 (%).
 *
 * **등급과 무관한 상수다.** 파일 상단 '집중과 과대 포지션은 다르다' 참조.
 */
export const RISK_PER_TRADE_PCT = 1;
/** 설정으로도 이 위로는 못 올린다 */
export const RISK_PER_TRADE_HARD_MAX = 2;
/** 동시에 열려 있는 포지션들의 위험 합계 상한 (%) */
export const MAX_CONCURRENT_RISK_PCT = 3;

export function tierFor(equityUsd: number | null | undefined, tiers: Tier[] = TIERS): Tier {
  const v = Number(equityUsd);
  // 0도 '모름'과 구분한다: 0은 돌릴 돈이 없는 것이고, null은 못 읽은 것이다.
  // 둘 다 배분은 안 되지만 사용자가 할 일이 다르다 (충전 vs 연결 확인).
  if (equityUsd == null || !Number.isFinite(v) || v < 0) return UNKNOWN_TIER;
  const sorted = [...tiers].sort((a, b) => a.minUsd - b.minUsd);
  let out = sorted[0] ?? UNKNOWN_TIER;
  for (const t of sorted) if (v >= t.minUsd) out = t;
  return out;
}

export interface AllocationSlot {
  id: string;
  label: string;
  score: number | null;
  /** 배분 가능액 대비 비중 (0~1) */
  weight: number;
  /** 실제 금액 (USDT). 자산을 모르면 null */
  usd: number | null;
  reason: string;
}

export interface AllocationPlan {
  tier: Tier;
  equityUsd: number | null;
  /** 남겨 두는 현금 */
  reserveUsd: number | null;
  /** 전략들에 나눠 줄 수 있는 총액 */
  deployableUsd: number | null;
  slots: AllocationSlot[];
  /** 자격은 있으나 자리가 없어 못 들어간 전략 */
  benched: Array<{ id: string; label: string; score: number | null; reason: string }>;
  riskPerTradePct: number;
  maxConcurrentRiskPct: number;
  /** 사람이 읽을 한 줄 */
  summary: string;
  /** 알아야 할 것 (표본 부족·자산 미확인 등) */
  notes: string[];
}

export interface AllocationInput {
  equityUsd: number | null;
  scores: StrategyScore[];
  tiers?: Tier[];
  /** 거래당 위험 %. 하드 상한을 넘기면 상한으로 깎고 note에 남긴다 */
  riskPerTradePct?: number;
}

/**
 * 점수판 → 배분표.
 *
 * 자격 있는 전략을 점수순으로 등급의 자리 수만큼 뽑고, 점수에 비례해
 * 나눈다. 다만 **한 전략의 상한**을 넘으면 깎아 나머지에 다시 나눈다 —
 * 상한을 두는 이유는 한 전략이 무너졌을 때 계좌 전체가 같이 무너지지 않게
 * 하기 위해서다. 점수가 아무리 높아도 그 점수는 과거의 것이다.
 */
export function allocate(input: AllocationInput): AllocationPlan {
  const notes: string[] = [];
  const tier = tierFor(input.equityUsd, input.tiers);
  const equityUsd = tier.id === 'unknown' ? null : Number(input.equityUsd);

  let risk = Number(input.riskPerTradePct);
  if (!Number.isFinite(risk) || risk <= 0) risk = RISK_PER_TRADE_PCT;
  if (risk > RISK_PER_TRADE_HARD_MAX) {
    notes.push(
      `거래당 위험 ${risk}%는 상한 ${RISK_PER_TRADE_HARD_MAX}%를 넘어 ${RISK_PER_TRADE_HARD_MAX}%로 낮췄습니다 `
      + '— 비중을 키우는 것과 한 거래에 크게 거는 것은 다릅니다');
    risk = RISK_PER_TRADE_HARD_MAX;
  }

  const all = Array.isArray(input.scores) ? input.scores : [];
  const eligible = all.filter(s => s.eligible).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const waiting = all.filter(s => !s.eligible);

  const reserveUsd = equityUsd == null ? null : equityUsd * (tier.reservePct / 100);
  const deployableUsd = equityUsd == null ? null : equityUsd - (reserveUsd as number);

  if (tier.id === 'unknown') {
    notes.push(UNKNOWN_TIER.note);
  }

  const picked = eligible.slice(0, tier.maxActive);
  const benched = [
    ...eligible.slice(tier.maxActive).map(s => ({
      id: s.id, label: s.label, score: s.score,
      reason: `${tier.label} 등급은 ${tier.maxActive}개까지입니다 — 자산이 늘면 자리가 생깁니다`,
    })),
    ...waiting.map(s => ({ id: s.id, label: s.label, score: s.score, reason: s.reason })),
  ];

  const slots = weigh(picked, tier.maxWeight).map(w => ({
    id: w.id, label: w.label, score: w.score, weight: w.weight,
    usd: deployableUsd == null ? null : Number((deployableUsd * w.weight).toFixed(2)),
    reason: w.capped
      ? `점수 ${w.score} · 상한 ${Math.round(tier.maxWeight * 100)}%에 걸려 깎였습니다`
      : `점수 ${w.score}`,
  }));

  // 상한 때문에 배분 가능액을 다 쓰지 못하는 경우가 있다. 자격 있는 전략이
  // 하나뿐인데 상한이 60%면 40%가 놀게 된다. **그건 버그가 아니라 결과다** —
  // 검증된 것이 하나뿐이면 현금을 더 들고 있는 것이 맞다. 다만 조용히
  // 놀리면 안 된다. 화면에 '전액 투입 중'으로 보이면 안 되니까.
  const used = slots.reduce((a, s) => a + s.weight, 0);
  if (slots.length > 0 && used < 0.99) {
    notes.push(
      `배분 가능액의 ${Math.round(used * 100)}%만 씁니다 — 한 전략 상한 `
      + `${Math.round(tier.maxWeight * 100)}%에 걸려 나머지는 현금으로 둡니다 `
      + '(검증된 전략이 늘면 채워집니다)');
  }

  if (picked.length === 0 && tier.id !== 'unknown') {
    notes.push(
      all.length === 0
        ? '평가할 전략이 없습니다'
        : '기준을 넘은 전략이 없습니다 — 표본이 쌓이거나 성적이 올라올 때까지 배분하지 않습니다');
  }

  const insufficient = waiting.filter(s => s.status === 'insufficient');
  if (insufficient.length) {
    notes.push(
      `${insufficient.length}개 전략은 표본이 모자라 평가하지 않았습니다 — `
      + '성적이 나쁜 것이 아니라 아직 모르는 것입니다');
  }

  const summary = tier.id === 'unknown'
    ? '자산을 확인하지 못해 배분하지 않았습니다'
    : picked.length === 0
      ? `${tier.label} · 활성 전략 없음`
      : `${tier.label} · ${picked.length}/${tier.maxActive}개 활성 · `
        + `현금 ${tier.reservePct}% 유보 · 거래당 위험 ${risk}%`;

  return {
    tier, equityUsd, reserveUsd, deployableUsd,
    slots, benched,
    riskPerTradePct: risk,
    maxConcurrentRiskPct: MAX_CONCURRENT_RISK_PCT,
    summary, notes,
  };
}

/**
 * 점수 비례 배분 + 상한.
 *
 * 상한에 걸린 전략을 깎고 남은 몫을 나머지에게 다시 나눈다. 나머지가 전부
 * 상한이면 더 나눌 곳이 없으므로 남은 몫은 현금으로 남는다 — 억지로
 * 밀어 넣지 않는다.
 */
function weigh(
  picked: StrategyScore[], maxWeight: number,
): Array<{ id: string; label: string; score: number | null; weight: number; capped: boolean }> {
  const n = picked.length;
  if (n === 0) return [];

  const cap = Math.min(1, Math.max(0, maxWeight));
  // 점수가 전부 같거나 0이면 균등 분배로 떨어진다.
  const raw = picked.map(s => Math.max(1, Number(s.score) || 0));
  const total = raw.reduce((a, b) => a + b, 0);

  let weights = raw.map(v => v / total);
  const capped = new Array(n).fill(false);

  // 상한을 넘는 것을 깎고 남은 몫을 아직 여유 있는 쪽에 다시 나눈다.
  for (let pass = 0; pass < n; pass++) {
    let spill = 0;
    for (let i = 0; i < n; i++) {
      if (weights[i] > cap) { spill += weights[i] - cap; weights[i] = cap; capped[i] = true; }
    }
    if (spill <= 1e-9) break;
    const room = weights.reduce((a, w, i) => a + (capped[i] ? 0 : cap - w), 0);
    if (room <= 1e-9) break;   // 더 줄 곳이 없다 — 남은 몫은 현금
    for (let i = 0; i < n; i++) {
      if (!capped[i]) weights[i] += spill * ((cap - weights[i]) / room);
    }
  }

  return picked.map((s, i) => ({
    id: s.id, label: s.label, score: s.score,
    weight: Number(weights[i].toFixed(4)),
    capped: capped[i],
  }));
}

/** 환경변수로 등급 경계를 덮어쓴다 (USDT). 예: PORTFOLIO_TIERS_USD=10000,50000,100000 */
export function readTiers(env: (k: string) => string | undefined): { tiers: Tier[]; note: string } {
  const raw = String(env('PORTFOLIO_TIERS_USD') ?? '').trim();
  if (!raw) return { tiers: TIERS, note: '' };

  const nums = raw.split(/[,;\s]+/).map(Number).filter(n => Number.isFinite(n) && n >= 0);
  if (nums.length !== 3) {
    return {
      tiers: TIERS,
      note: `PORTFOLIO_TIERS_USD는 경계 3개여야 합니다 (받은 값: '${raw}') — 기본값을 씁니다`,
    };
  }
  const [a, b, c] = nums;
  if (!(a < b && b < c)) {
    return { tiers: TIERS, note: `PORTFOLIO_TIERS_USD가 오름차순이 아닙니다 ('${raw}') — 기본값을 씁니다` };
  }
  return {
    tiers: TIERS.map((t, i) => (i === 0 ? t : { ...t, minUsd: [a, b, c][i - 1] })),
    note: '',
  };
}
