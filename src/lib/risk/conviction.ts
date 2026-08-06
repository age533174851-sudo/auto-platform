// src/lib/risk/conviction.ts
//
// **확신 없는 잦은 매매와 백화점식 보유를 막는다.**
//
// 이건 매매 전략이 아니다
// ───────────────────────
// 모든 수동·자동·장기투자 전략 **위에** 얹히는 층이다. 전략은 "지금
// 들어갈 자리인가"를 답하고, 여기는 "그래서 얼마를 걸 것이고 지금
// 걸어도 되는가"를 답한다.
//
// 가장 조심해야 하는 오해
// ───────────────────────
// "확신 있는 기회에 집중한다"를 **한 종목 몰빵이나 고배율 베팅으로
// 읽으면 안 된다.**
//
//   확신 없는 종목 50개        → 진짜 분산이 아니다
//   같은 위험요인 종목 50개    → 사실상 한 방향 몰빵
//   확실해 보이는 한 종목에 전재산 → 좋은 집중이 아니라 파산 위험
//
// 그래서 이 파일의 구조가 그것을 **코드로 막는다.** A급이라고 위험이
// 커지는 것이 아니라, 미리 정한 상한 **안에서** 등급별로 차등 배정한다.
// 등급은 위험을 늘리는 손잡이가 아니라 **줄이는 손잡이**다.
//
// 확신은 두 축이다
// ────────────────
// 사람이 "확신 있다"고 느끼는 것과 그 신호가 검증된 것은 다르다. 둘을
// 섞으면 기분이 좋은 날 큰돈이 나간다. 그래서 따로 받고, **낮은 쪽이
// 등급을 정한다.**

export type Conviction = 'A' | 'B' | 'C';

export interface ConvictionInput {
  /**
   * 객관적 신호 품질 0~100.
   *
   * 백테스트·시장 국면·데이터에서 나온 값이다. **못 구했으면 null이다** —
   * 0으로 눕히면 '나쁜 신호'가 되고, 그건 '모른다'와 다르다.
   */
  objective?: number | null;
  /**
   * 사용자가 느끼는 확신 0~100. 없어도 된다.
   *
   * **이 값이 등급을 올리지 못한다.** 올릴 수 있으면 기분이 곧 크기가
   * 되고, 그러면 이 파일이 있는 이유가 사라진다.
   */
  subjective?: number | null;
}

export interface ConvictionVerdict {
  grade: Conviction;
  /** 등급을 정한 값 */
  score: number | null;
  /** 주관과 객관이 크게 어긋나는가 */
  divergent: boolean;
  reason: string;
  /** 이 등급으로 진입할 수 있는가 */
  tradable: boolean;
}

/** 등급 경계. A는 쉽게 나오면 안 된다 */
export const GRADE_MIN = { A: 75, B: 55 } as const;

/** 주관과 객관이 이만큼 벌어지면 어긋난 것으로 본다 */
export const DIVERGENCE_GAP = 30;

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 신호를 A/B/C로 나눈다.
 *
 * **객관 점수가 없으면 A가 될 수 없다.** 확인하지 못한 것은 통과가
 * 아니고, 확인 못 한 신호에 정상 위험을 실으면 그 위험은 근거가 없다.
 */
export function gradeOf(input: ConvictionInput | null | undefined): ConvictionVerdict {
  const obj = num(input?.objective);
  const subj = num(input?.subjective);

  if (obj == null) {
    return {
      grade: 'C', score: null, tradable: false,
      divergent: false,
      reason: '객관적 신호 품질을 구하지 못했습니다 — 확인 못 한 신호에는 자금을 싣지 않습니다',
    };
  }

  const clamped = Math.max(0, Math.min(100, obj));
  const divergent = subj != null && Math.abs(subj - clamped) >= DIVERGENCE_GAP;

  // **낮은 쪽이 등급을 정한다.** 주관이 높다고 올라가지 않는다.
  const deciding = subj != null ? Math.min(clamped, Math.max(0, Math.min(100, subj))) : clamped;

  const grade: Conviction =
    deciding >= GRADE_MIN.A ? 'A' : deciding >= GRADE_MIN.B ? 'B' : 'C';

  const parts: string[] = [`객관 ${clamped.toFixed(0)}점`];
  if (subj != null) parts.push(`주관 ${subj.toFixed(0)}점`);
  if (divergent) {
    parts.push(subj! > clamped
      // 이게 제일 위험한 조합이다 — 느낌은 확신인데 근거가 없다.
      ? '느낌은 확신인데 근거가 약합니다 — 집중 투자 불가'
      : '근거는 좋은데 확신이 낮습니다 — 크기를 줄이는 쪽이 맞습니다');
  }

  return {
    grade, score: deciding, divergent, tradable: grade !== 'C',
    reason: parts.join(' · ') + (grade === 'C' ? ' — 애매한 자리에는 들어가지 않습니다' : ''),
  };
}

// ── 위험 예산 ────────────────────────────────────────────

export interface RiskBudgetPolicy {
  /**
   * 한 거래에 걸 수 있는 **최대** 위험(계좌 %).
   *
   * A급이 이 값을 넘지 못한다. 등급은 이 상한 **안에서** 차등하는 것이지
   * 상한을 여는 것이 아니다.
   */
  maxRiskPct: number;
  /** 등급별 배수 0~1 */
  gradeFactor?: Partial<Record<Conviction, number>>;
}

export const DEFAULT_GRADE_FACTOR: Record<Conviction, number> = {
  A: 1,
  // B는 절반이다. '조금 애매한데 그냥 간다'가 정상 크기로 나가면
  // 등급을 나눈 뜻이 없다.
  B: 0.4,
  C: 0,
};

export interface RiskBudget {
  riskPct: number;
  /** 정상 위험 대비 몇 배인가 */
  factor: number;
  /** Paper로만 돌릴 것인가 */
  paperOnly: boolean;
  reason: string;
}

/**
 * 등급에서 위험 예산을 낸다.
 *
 * **상한을 넘을 수 없다.** 그것이 이 함수의 유일한 존재 이유다 —
 * 등급이 좋다고 크게 거는 것을 코드가 못 하게 막는다.
 */
export function riskBudgetFor(
  v: ConvictionVerdict, policy: RiskBudgetPolicy,
): RiskBudget {
  const cap = num(policy?.maxRiskPct);
  if (cap == null || cap <= 0) {
    return { riskPct: 0, factor: 0, paperOnly: true,
      reason: '위험 상한이 정해지지 않았습니다 — 상한 없이는 자금을 싣지 않습니다' };
  }
  const factors = { ...DEFAULT_GRADE_FACTOR, ...(policy.gradeFactor ?? {}) };
  // 배수도 1을 넘지 못한다. 설정 실수 하나가 상한을 뚫으면 안 된다.
  const f = Math.max(0, Math.min(1, num(factors[v.grade]) ?? 0));

  if (v.grade === 'C' || f <= 0) {
    return { riskPct: 0, factor: 0, paperOnly: true,
      reason: v.grade === 'C' ? 'C급 — 진입하지 않습니다' : '이 등급의 배정 비율이 0입니다' };
  }

  // 주관이 객관보다 크게 높으면 한 단계 더 줄인다. 느낌으로 커지는 것을
  // 막는 자리가 여기다.
  const penalty = v.divergent && (v.score != null) ? 0.5 : 1;
  const riskPct = cap * f * penalty;

  return {
    riskPct, factor: f * penalty, paperOnly: false,
    reason: `${v.grade}급 — 상한 ${cap}%의 ${(f * penalty * 100).toFixed(0)}%`
      + (penalty < 1 ? ' (주관·객관 괴리로 절반)' : ''),
  };
}

// ── 과매매 차단 ──────────────────────────────────────────

export interface OvertradingPolicy {
  /** 하루 최대 진입 수. 0 이하면 제한 없음 */
  maxEntriesPerDay?: number | null;
  /** 같은 심볼 재진입까지의 최소 간격(분) */
  sameSymbolCooldownMin?: number | null;
  /** 손절 뒤 냉각 시간(분) */
  afterLossCooldownMin?: number | null;
  /** 연속 손실 몇 번이면 멈추는가 */
  maxConsecutiveLosses?: number | null;
}

export interface TradingHistory {
  nowMs: number;
  /** 오늘 진입 수 */
  entriesToday?: number | null;
  /** 이 심볼의 마지막 진입 시각 */
  lastEntryOnSymbolMs?: number | null;
  /** 마지막 손절 시각 */
  lastLossMs?: number | null;
  /** 지금까지 연속 손실 */
  consecutiveLosses?: number | null;
}

export type OvertradingBlock =
  | 'DAILY_CAP'
  | 'SYMBOL_COOLDOWN'
  | 'LOSS_COOLDOWN'
  | 'LOSS_STREAK';

export interface OvertradingVerdict {
  allowed: boolean;
  blocked: OvertradingBlock | null;
  reason: string;
  /** 다시 가능해지는 시각(ms). 모르면 null */
  retryAtMs: number | null;
}

/**
 * 지금 새로 들어가도 되는가.
 *
 * **막는 것이 실패가 아니다.** 신호가 없는 날 안 들어간 것은 관망
 * 성공이고, 여기서 막힌 것도 규칙이 일한 것이다. 화면이 이 둘을 빨간
 * 오류로 그리면 사용자는 규칙을 끄고 싶어진다.
 */
export function overtradingGate(
  policy: OvertradingPolicy | null | undefined,
  hist: TradingHistory,
): OvertradingVerdict {
  const p = policy ?? {};
  const now = num(hist?.nowMs) ?? 0;
  const ok: OvertradingVerdict = { allowed: true, blocked: null, reason: '', retryAtMs: null };

  const streakCap = num(p.maxConsecutiveLosses);
  const streak = num(hist?.consecutiveLosses) ?? 0;
  if (streakCap != null && streakCap > 0 && streak >= streakCap) {
    return {
      allowed: false, blocked: 'LOSS_STREAK', retryAtMs: null,
      reason: `연속 ${streak}회 손실 — 자동 중지되었습니다. 사람이 확인하고 풀어야 합니다`,
    };
  }

  const lossCd = num(p.afterLossCooldownMin);
  const lastLoss = num(hist?.lastLossMs);
  if (lossCd != null && lossCd > 0 && lastLoss != null) {
    const until = lastLoss + lossCd * 60_000;
    if (now < until) {
      return {
        allowed: false, blocked: 'LOSS_COOLDOWN', retryAtMs: until,
        reason: `손절 직후 ${lossCd}분은 쉽니다 — ${Math.ceil((until - now) / 60_000)}분 남았습니다`,
      };
    }
  }

  const symCd = num(p.sameSymbolCooldownMin);
  const lastSym = num(hist?.lastEntryOnSymbolMs);
  if (symCd != null && symCd > 0 && lastSym != null) {
    const until = lastSym + symCd * 60_000;
    if (now < until) {
      return {
        allowed: false, blocked: 'SYMBOL_COOLDOWN', retryAtMs: until,
        reason: `같은 종목 재진입까지 ${Math.ceil((until - now) / 60_000)}분 남았습니다`,
      };
    }
  }

  const dayCap = num(p.maxEntriesPerDay);
  const today = num(hist?.entriesToday) ?? 0;
  if (dayCap != null && dayCap > 0 && today >= dayCap) {
    return {
      allowed: false, blocked: 'DAILY_CAP', retryAtMs: null,
      reason: `오늘 진입 ${today}/${dayCap}회를 다 썼습니다 — 다음 진입은 내일 가능합니다`,
    };
  }

  return ok;
}

// ── 관망 점수 ────────────────────────────────────────────

export interface PatienceInput {
  /** 본 신호 수 */
  signalsSeen?: number | null;
  aGrade?: number | null;
  bGrade?: number | null;
  cGrade?: number | null;
  /** 실제 진입 수 */
  entries?: number | null;
  /** 과매매 규칙이 막은 수 */
  blockedByGate?: number | null;
}

export interface PatienceScore {
  /** 규칙 준수율 0~1. 판단할 표본이 없으면 null */
  disciplineRate: number | null;
  /** 안 들어간 것이 옳았던 횟수 */
  avoided: number;
  /** 사람이 읽는 한 줄 */
  summary: string;
}

/**
 * 안 들어간 날을 성과로 기록한다.
 *
 * **"아무것도 안 했으니 손해 봤다"는 느낌이 과매매의 시작이다.**
 * 그날 A급이 없었으면 0건이 맞는 답이고, 화면은 그것을 성과로 적어야 한다.
 */
export function patienceScore(input: PatienceInput | null | undefined): PatienceScore {
  const i = input ?? {};
  const a = Math.max(0, num(i.aGrade) ?? 0);
  const b = Math.max(0, num(i.bGrade) ?? 0);
  const c = Math.max(0, num(i.cGrade) ?? 0);
  const entries = Math.max(0, num(i.entries) ?? 0);
  const blocked = Math.max(0, num(i.blockedByGate) ?? 0);
  const seen = Math.max(0, num(i.signalsSeen) ?? (a + b + c));

  // C급을 안 들어간 것 + 규칙이 막은 것 = 피한 것
  const avoided = c + blocked;

  // **표본이 없으면 100%가 아니다.** 아무 신호도 없던 날을 '완벽한 준수'로
  // 적으면 그 숫자는 아무 뜻도 없다.
  const denom = seen + blocked;
  const disciplineRate = denom > 0
    ? Math.max(0, Math.min(1, (denom - Math.max(0, entries - a - b)) / denom))
    : null;

  const summary = seen === 0 && blocked === 0
    ? '오늘 본 신호가 없습니다 — 기록할 것이 없습니다'
    : [
        `신호 ${seen}건 (A ${a} · B ${b} · C ${c})`,
        `진입 ${entries}건`,
        avoided > 0 ? `피한 자리 ${avoided}건` : '',
        entries === 0 && a === 0 ? '오늘은 들어갈 자리가 없었습니다 — 관망이 정답입니다' : '',
      ].filter(Boolean).join(' · ');

  return { disciplineRate, avoided, summary };
}
