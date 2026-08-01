// src/lib/ai/calibration.ts
//
// AI의 확신도가 실제로 맞는지 점수를 매긴다.
//
// 왜 필요한가
// ───────────
// "TRAIGO AI Score : 96/100"은 그 자체로는 아무 뜻이 없다. 96%라고 말한
// 판단이 실제로 96% 맞았는지 **재 본 적이 없으면**, 그 숫자는 확신의
// 표현이지 정보가 아니다.
//
// 캘리브레이션(보정)은 그 질문 하나를 잰다:
//   "80%라고 말한 것들 중 실제로 몇 %가 맞았나?"
//
//   80이라 말하고 80% 맞았다  → 잘 보정됨. 80%를 80%로 읽어도 된다
//   80이라 말하고 55% 맞았다  → **과신.** 이 AI의 80은 55로 읽어야 한다
//   80이라 말하고 95% 맞았다  → 과소. 더 믿어도 된다
//
// 맞춘 비율만으로는 부족한 이유
// ─────────────────────────────
// 늘 '상승'이라고 답하는 모델은 상승장에서 90% 맞는다. 확률적 예측의
// 품질은 **방향이 맞았는가**와 **얼마나 확신했는가**를 같이 봐야 한다.
// 그래서 Brier 점수를 같이 낸다: (확신 − 실제)²의 평균, 0이 완벽, 낮을수록
// 좋다. 늘 50%라고 말하면 0.25가 나온다 — 그보다 나쁘면 아무 말도 안 하는
// 것만 못하다는 뜻이고, 이 기준선을 같이 적는다.
//
// 결과를 모르는 것은 맞춘 것이 아니다
// ───────────────────────────────────
// 아직 결과가 안 나온 예측을 분모에서 빼면 맞춘 비율이 부풀려지고, 분자에
// 넣으면 거짓말이 된다. 채점된 것과 대기 중인 것을 **따로 센다.**
//
// 표본이 적으면 숫자를 내지 않는다
// ────────────────────────────────
// 3건 중 3건을 맞혔다고 '적중률 100%'로 적으면, 가장 검증되지 않은 것이
// 점수판 1등이 된다. 전략 평가(portfolio/strategyScore)에서와 같은 규칙이다:
// **표본 부족은 낮은 점수가 아니라 별도 상태다.**

/** 한 건의 예측과 그 결과 */
export interface PredictionRecord {
  /** 어느 공급자·합의인가. 'consensus' 또는 'openai' 같은 개별 이름 */
  source: string;
  /** AI가 말한 방향 */
  direction: 'bullish' | 'bearish' | 'neutral' | string | null;
  /** 0~100 */
  confidence: number | null;
  /**
   * 실제로 어떻게 됐나. null이면 **아직 모른다** — 맞춘 것도 틀린 것도 아니다.
   * 'bullish'/'bearish'/'neutral'
   */
  outcome: 'bullish' | 'bearish' | 'neutral' | string | null;
  /** 예측 시각(ms). 최근만 보고 싶을 때 쓴다 */
  atMs?: number | null;
}

export interface Bucket {
  /** 구간 라벨 — '50–59%' */
  label: string;
  lo: number;
  hi: number;
  /** 채점된 건수 */
  n: number;
  /** 그 구간에서 실제로 맞은 비율(%). n이 0이면 null */
  actualPct: number | null;
  /** 그 구간에서 AI가 말한 평균 확신도(%) */
  claimedPct: number | null;
  /** claimed − actual. 양수면 과신 */
  gap: number | null;
}

export type CalibrationStatus =
  /** 잴 만큼 모였다 */
  | 'ok'
  /** 채점된 표본이 부족하다. 낮은 점수가 아니라 별도 상태다 */
  | 'insufficient'
  /** 넣은 것이 아예 없다 */
  | 'empty';

export interface CalibrationReport {
  status: CalibrationStatus;
  /** 채점된 건수 (결과가 나온 것만) */
  scored: number;
  /** 결과를 기다리는 건수. **이건 맞춘 것이 아니다** */
  pending: number;
  /** 확신도가 없어 채점에서 뺀 건수 */
  unusable: number;
  /** 방향을 맞힌 비율(%). 표본 부족이면 null */
  hitRatePct: number | null;
  /** Brier 점수 0~1. 낮을수록 좋다. 표본 부족이면 null */
  brier: number | null;
  /** 늘 50%라고 답했을 때의 Brier. 이보다 나쁘면 말 안 하는 것만 못하다 */
  brierBaseline: number;
  /** 평균 확신도 − 실제 적중률. 양수면 과신 */
  overconfidencePct: number | null;
  buckets: Bucket[];
  summary: string;
}

/** 이만큼은 채점돼야 숫자를 낸다 */
export const MIN_SCORED = 20;

const BUCKET_EDGES: [number, number][] = [
  [0, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 101],
];

function num(v: any): number | null {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dir(v: any): 'bullish' | 'bearish' | 'neutral' | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'bullish' || s === 'bearish' || s === 'neutral') return s;
  return null;
}

function label(lo: number, hi: number): string {
  return hi > 100 ? `${lo}–100%` : `${lo}–${hi - 1}%`;
}

/**
 * 예측 기록을 채점한다. 순수 함수 — DB를 모른다.
 *
 * `outcome`이 null인 것은 **분자에도 분모에도 넣지 않는다.** 결과를 모르는
 * 것을 맞췄다고 세면 적중률이 시간이 갈수록 좋아지는 것처럼 보인다.
 */
export function calibrate(records: PredictionRecord[]): CalibrationReport {
  const list = Array.isArray(records) ? records : [];

  let pending = 0, unusable = 0;
  const scored: { correct: boolean; p: number }[] = [];

  for (const r of list) {
    const o = dir(r?.outcome);
    if (o == null) { pending++; continue; }

    const d = dir(r?.direction);
    const c = num(r?.confidence);
    // 방향이나 확신도가 없으면 채점할 수 없다. 0으로 채우면 '아주 자신
    // 없었는데 맞췄다'가 되어 보정 곡선을 통째로 왜곡한다.
    if (d == null || c == null || c < 0 || c > 100) { unusable++; continue; }

    scored.push({ correct: d === o, p: c / 100 });
  }

  const n = scored.length;
  const base = {
    scored: n, pending, unusable,
    brierBaseline: 0.25,   // 늘 50%라고 답했을 때
  };

  if (list.length === 0) {
    return {
      ...base, status: 'empty',
      hitRatePct: null, brier: null, overconfidencePct: null,
      buckets: [], summary: 'AI 예측 기록이 없습니다',
    };
  }

  const buckets: Bucket[] = BUCKET_EDGES.map(([lo, hi]) => {
    const inB = scored.filter(s => s.p * 100 >= lo && s.p * 100 < hi);
    const hits = inB.filter(s => s.correct).length;
    const actualPct = inB.length ? Math.round((hits / inB.length) * 1000) / 10 : null;
    const claimedPct = inB.length
      ? Math.round((inB.reduce((a, s) => a + s.p, 0) / inB.length) * 1000) / 10
      : null;
    return {
      label: label(lo, hi), lo, hi, n: inB.length, actualPct, claimedPct,
      gap: actualPct == null || claimedPct == null
        ? null : Math.round((claimedPct - actualPct) * 10) / 10,
    };
  });

  if (n < MIN_SCORED) {
    return {
      ...base, status: 'insufficient',
      // 표본 부족일 때 적중률을 내지 않는다. 3건 중 3건이 '100%'로 적히면
      // 가장 검증 안 된 것이 가장 좋아 보인다.
      hitRatePct: null, brier: null, overconfidencePct: null,
      buckets,
      summary: `채점된 예측이 ${n}건입니다 (필요 ${MIN_SCORED}건)`
        + (pending > 0 ? ` — ${pending}건은 결과 대기 중입니다` : ''),
    };
  }

  const hits = scored.filter(s => s.correct).length;
  const hitRatePct = Math.round((hits / n) * 1000) / 10;
  // Brier: 맞았으면 목표 1, 틀렸으면 0. (확신 − 목표)²의 평균.
  const brier = Math.round(
    (scored.reduce((a, s) => a + Math.pow(s.p - (s.correct ? 1 : 0), 2), 0) / n) * 10000,
  ) / 10000;
  const meanConf = (scored.reduce((a, s) => a + s.p, 0) / n) * 100;
  const overconfidencePct = Math.round((meanConf - hitRatePct) * 10) / 10;

  // 두 가지를 **같이** 말한다. 한동안 하나만 말했는데, 과신이면서 동시에
  // 기준선보다 나쁜 경우(90이라 말하고 50% 적중)가 가장 흔하고 가장 중요한
  // 상태다. 둘 중 하나만 적으면 "왜 나쁜지"나 "얼마나 나쁜지" 중 하나가 빠진다.
  const gapNote =
    overconfidencePct >= 10
      ? `평균 확신 ${Math.round(meanConf)}%인데 실제는 ${hitRatePct}%입니다 — 과신하고 있습니다`
      : overconfidencePct <= -10
        ? `평균 확신 ${Math.round(meanConf)}%인데 실제는 ${hitRatePct}%입니다 — 실력보다 낮게 말하고 있습니다`
        : '확신도와 실제가 대체로 맞습니다';
  const worseNote = brier > 0.25
    ? ' 늘 50%라고 답하는 것(0.250)보다 나쁩니다 — 이 확신도는 아직 신호가 아닙니다.'
    : '';
  const summary =
    `${n}건 채점 · 방향 적중 ${hitRatePct}% · Brier ${brier.toFixed(3)} — ${gapNote}.`
    + worseNote
    + (pending > 0 ? ` (${pending}건 결과 대기)` : '');

  return {
    ...base, status: 'ok',
    hitRatePct, brier, overconfidencePct, buckets, summary,
  };
}

/**
 * 진입 뒤 가격이 어떻게 됐는지를 방향으로 바꾼다 — 채점용 정답지.
 *
 * `flatPct`가 있는 이유: 0.01% 올랐다고 '상승 적중'으로 세면 거의 모든
 * 예측이 방향을 맞힌 것이 된다. 움직이지 않은 것은 보합이다.
 */
export function outcomeFromPrices(
  entryPrice: number | null | undefined,
  laterPrice: number | null | undefined,
  flatPct = 0.5,
): 'bullish' | 'bearish' | 'neutral' | null {
  const a = num(entryPrice), b = num(laterPrice);
  // 가격을 모르면 결과도 모른다. 보합으로 적으면 '결과가 나왔다'가 된다.
  if (a == null || b == null || a <= 0) return null;
  const chg = ((b - a) / a) * 100;
  if (chg > flatPct) return 'bullish';
  if (chg < -flatPct) return 'bearish';
  return 'neutral';
}
