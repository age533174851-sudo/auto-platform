// src/lib/portfolio/strategyScore.ts
//
// 전략 평가 점수 — **순수 함수**.
//
// 무엇을 위한 것인가
// ──────────────────
// "잘 안 되는 전략을 계속 돌리는" 상황을 막는다. 그러려면 잘 되는지를
// 숫자로 정해 두고, 그 숫자가 기준 아래로 떨어지면 자동으로 끈다.
//
// 여기서 가장 중요한 규칙: **표본이 모자라면 점수를 주지 않는다.**
// ────────────────────────────────────────────────────────────
// 3거래에서 3승이면 승률 100%다. 이 숫자를 그대로 점수로 바꾸면 그 전략이
// 점수판 1등이 되고, 자금 배분 엔진이 거기에 돈을 몰아준다. 즉 **가장
// 검증되지 않은 전략이 가장 큰 돈을 받는다.**
//
// 그래서 표본 부족은 낮은 점수가 아니라 `insufficient`라는 별도 상태다.
// 낮은 점수로 두면 "성적이 나쁜 전략"과 "아직 모르는 전략"이 같아지는데,
// 둘은 정반대로 다뤄야 한다 — 앞의 것은 끄고, 뒤의 것은 더 돌려 봐야 한다.
//
// 왜 AI에게 안 묻는가
// ───────────────────
// 승률·손익비·MDD·샤프는 전부 계산되는 값이다. 물어볼 이유가 없고, 물으면
// 같은 입력에 다른 답이 나온다. 점수는 여기서 정하고, AI는 그 위에
// "이 배분에 반대 의견이 있나"를 묻는 자리에만 둔다.

/** 이 아래로는 점수를 매기지 않는다 */
export const MIN_TRADES = 30;

/** 이 점수 아래면 자동으로 끈다 */
export const MIN_SCORE = 40;

/** 이 낙폭을 넘으면 점수와 무관하게 끈다 */
export const MAX_DRAWDOWN_PCT = 25;

export interface StrategyStats {
  id: string;
  label?: string;
  /** 집계에 쓴 거래 수 */
  trades: number;
  /** 0~100 */
  winRatePct: number | null;
  /** 평균이익 ÷ 평균손실. 1.5면 이기는 거래가 지는 거래보다 1.5배 크다 */
  payoffRatio: number | null;
  /** 최대 낙폭 %. 양수로 준다 (10% 하락 → 10) */
  maxDrawdownPct: number | null;
  /** 샤프지수. 못 구했으면 null */
  sharpe: number | null;
  /** 최근 30일 수익률 % */
  return30dPct: number | null;
}

export type ScoreStatus = 'ok' | 'insufficient' | 'disabled' | 'unknown';

export interface StrategyScore {
  id: string;
  label: string;
  status: ScoreStatus;
  /** 0~100. status가 'ok'가 아니면 null */
  score: number | null;
  /** 자금을 받을 수 있는가 */
  eligible: boolean;
  reason: string;
  /** 무엇이 점수를 깎았는지 — 화면에 그대로 쓴다 */
  parts: Array<{ k: string; v: string; pts: number | null }>;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: any): number | null => {
  // null·undefined·빈 문자열을 Number()에 그냥 넣으면 **0**이 나온다.
  // 그러면 '샤프를 계산 못 했다'가 '샤프가 0이다'가 되고, 못 구한 지표를
  // 제외하는 규칙 자체가 무력화된다 — 테스트가 이걸 잡았다.
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 다섯 지표를 0~100 한 숫자로.
 *
 * 배점은 **손실을 통제하는 쪽에 무겁게** 뒀다. 수익률이 가장 큰 배점을
 * 가지면 "크게 걸어서 크게 번" 전략이 1등이 되는데, 그건 다음 달에
 * 계좌를 지우는 전략과 같은 전략이다.
 *
 *   낙폭 30 · 손익비 25 · 승률 20 · 샤프 15 · 최근수익 10
 *
 * 못 구한 지표는 **0점이 아니라 제외**하고 나머지로 비율을 맞춘다.
 * 0점으로 치면 '샤프를 계산 못 했다'가 '샤프가 나쁘다'와 같아진다.
 */
export function scoreStrategy(s: StrategyStats): StrategyScore {
  const id = String(s?.id || '');
  const label = String(s?.label || id || '(이름 없음)');
  const trades = num(s?.trades) ?? 0;

  const base = { id, label, parts: [] as StrategyScore['parts'] };

  if (!id) {
    return { ...base, status: 'unknown', score: null, eligible: false,
      reason: '전략 id가 없어 집계할 수 없습니다' };
  }

  if (trades < MIN_TRADES) {
    // 낮은 점수가 아니라 별도 상태다 (파일 상단 주석 참조).
    return {
      ...base, status: 'insufficient', score: null, eligible: false,
      reason: `표본 ${trades}/${MIN_TRADES}거래 — 아직 판단할 수 없습니다`,
      parts: [{ k: '표본', v: `${trades}거래`, pts: null }],
    };
  }

  const dd = num(s.maxDrawdownPct);
  const payoff = num(s.payoffRatio);
  const win = num(s.winRatePct);
  const sharpe = num(s.sharpe);
  const r30 = num(s.return30dPct);

  // 각 항목: [이름, 표시값, 배점, 0~1 점수] — 못 구했으면 null
  const items: Array<[string, string, number, number | null]> = [
    ['낙폭', dd == null ? '확인 불가' : `${dd.toFixed(1)}%`, 30,
      dd == null ? null : clamp(1 - dd / MAX_DRAWDOWN_PCT, 0, 1)],
    ['손익비', payoff == null ? '확인 불가' : payoff.toFixed(2), 25,
      payoff == null ? null : clamp((payoff - 0.8) / 1.2, 0, 1)],
    ['승률', win == null ? '확인 불가' : `${win.toFixed(1)}%`, 20,
      win == null ? null : clamp((win - 35) / 30, 0, 1)],
    ['샤프', sharpe == null ? '확인 불가' : sharpe.toFixed(2), 15,
      sharpe == null ? null : clamp((sharpe + 0.5) / 2.5, 0, 1)],
    ['최근 30일', r30 == null ? '확인 불가' : `${r30 >= 0 ? '+' : ''}${r30.toFixed(1)}%`, 10,
      r30 == null ? null : clamp((r30 + 10) / 30, 0, 1)],
  ];

  const usable = items.filter(([, , , v]) => v != null);
  const parts = items.map(([k, v, w, ratio]) => ({
    k, v, pts: ratio == null ? null : Math.round(ratio * w),
  }));

  if (usable.length === 0) {
    return { ...base, parts, status: 'unknown', score: null, eligible: false,
      reason: '지표를 하나도 계산하지 못했습니다' };
  }

  // 못 구한 지표는 제외하고 비율을 맞춘다 (0점으로 치지 않는다).
  const gotWeight = usable.reduce((a, [, , w]) => a + w, 0);
  const got = usable.reduce((a, [, , w, v]) => a + w * (v as number), 0);
  const score = Math.round((got / gotWeight) * 100);

  // 낙폭 한도는 점수와 별개로 본다. 총점이 높아도 낙폭이 한도를 넘었으면
  // 그 전략은 이미 한 번 계좌를 크게 깎았다는 뜻이다.
  if (dd != null && dd > MAX_DRAWDOWN_PCT) {
    return { ...base, parts, status: 'disabled', score, eligible: false,
      reason: `최대 낙폭 ${dd.toFixed(1)}%가 한도 ${MAX_DRAWDOWN_PCT}%를 넘었습니다` };
  }

  if (score < MIN_SCORE) {
    return { ...base, parts, status: 'disabled', score, eligible: false,
      reason: `점수 ${score}점이 기준 ${MIN_SCORE}점 아래입니다` };
  }

  const missing = items.filter(([, , , v]) => v == null).map(([k]) => k);
  return {
    ...base, parts, status: 'ok', score, eligible: true,
    reason: missing.length
      ? `${score}점 (${missing.join('·')}은 계산하지 못해 제외)`
      : `${score}점`,
  };
}

/** 여러 전략을 한 번에. 점수 높은 순으로 정렬해서 돌려준다 */
export function scoreAll(list: StrategyStats[] | null | undefined): StrategyScore[] {
  if (!Array.isArray(list)) return [];
  return list
    .map(scoreStrategy)
    .sort((a, b) => {
      // 자격 있는 것이 먼저, 그 다음 점수순.
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return (b.score ?? -1) - (a.score ?? -1);
    });
}
