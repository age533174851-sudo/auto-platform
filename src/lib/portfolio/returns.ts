// src/lib/portfolio/returns.ts
//
// **입출금이 있으면 (지금잔고 − 원금) ÷ 원금은 틀린다.**
//
// 전략 계좌가 여러 개가 되면서 돈이 계속 들락날락한다. 그런데 수익률을
// 잔고 증가율로 계산하면 이런 일이 생긴다:
//
//   1월  100만 넣음 →  90만 (−10%)
//   2월  900만 더 넣음 → 990만에서 1,089만 (+10%)
//   전체 잔고: 1,000만 넣어서 1,089만  →  "수익률 +8.9%"
//
// 그런데 **이 사람의 매매 실력은 −10%와 +10%를 낸 것**이다. +8.9%는
// 큰돈을 좋은 구간에 넣은 결과이고, 그건 전략의 성적이 아니다. 반대로
// 나쁜 타이밍에 큰돈을 넣으면 잘한 전략이 못한 것처럼 보인다.
//
// 그래서 둘 다 필요하다
// ─────────────────────
//   TWR (시간가중)  입출금 효과를 뺀 **전략의 성적**.
//                   전략끼리 비교하거나 지수와 비교할 때 쓴다.
//   MWR (금액가중)  입출금 시점까지 포함한 **내 지갑의 성적**.
//                   "내 돈이 실제로 얼마나 불었나"가 이쪽이다.
//
// 둘이 크게 벌어지면 그것 자체가 정보다 — 매매가 아니라 **입출금 타이밍**이
// 성적을 만들었다는 뜻이다.
//
// 모르면 0이 아니다
// ─────────────────
// 이 파일의 모든 함수는 계산할 수 없을 때 **null과 이유**를 돌려준다.
// 0%를 돌려주면 화면에 '수익률 0%'가 뜨고, 그건 '본전'이라는 뜻이지
// '계산 못 했다'가 아니다. 이 저장소에서 반복해서 문제가 된 자리다.

// ── 시간가중 수익률 (TWR) ─────────────────────────────────

export interface Period {
  /** 이 구간 시작 시점의 평가액 (**입출금 직전**) */
  startValue: number;
  /**
   * 이 구간 **시작에 들어오고 나간 순금액.** 입금 +, 출금 −.
   *
   * 시점을 하나로 못 박는 이유: 구간 중간 어디쯤이라고 두면 계산이
   * 근사(Modified Dietz)가 되고, 근사인지 정확한지 화면에서 구분이 안 된다.
   * 평가 시점을 입출금이 있을 때마다 끊으면 이 방식이 **정확하다.**
   */
  flow: number;
  /** 이 구간 끝 시점의 평가액 */
  endValue: number;
  label?: string;
}

export interface ReturnResult {
  /** 수익률 (%). 계산할 수 없으면 null */
  pct: number | null;
  reason: string;
  /** 계산에 실제로 쓰인 구간 수 */
  periods?: number;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 시간가중 수익률.
 *
 * 구간마다 수익률을 내고 곱한다 — 구간의 **크기**가 아니라 **순서**만
 * 반영되므로 입출금이 성적을 흔들지 못한다.
 *
 * **분모가 0 이하인 구간은 계산하지 않는다.** 돈이 하나도 없는 구간의
 * 수익률은 정의되지 않는다. 그 구간을 1로 치고 넘어가면(흔한 실수)
 * 파산 구간이 성적에서 조용히 사라진다.
 */
export function timeWeightedReturn(periods: Period[] | null | undefined): ReturnResult {
  const list = Array.isArray(periods) ? periods : [];
  if (list.length === 0) return { pct: null, reason: '평가 구간이 없습니다', periods: 0 };

  let factor = 1;
  let used = 0;

  for (let i = 0; i < list.length; i++) {
    const p = list[i] ?? ({} as Period);
    const start = num(p.startValue);
    const flow = num(p.flow) ?? 0;
    const end = num(p.endValue);
    const label = p.label ? `'${p.label}' 구간` : `${i + 1}번째 구간`;

    if (start == null || end == null) {
      return { pct: null, reason: `${label}의 평가액을 읽지 못했습니다`, periods: used };
    }
    const base = start + flow;
    if (!(base > 0)) {
      // 돈이 없는 구간은 수익률이 없다. 1로 치고 넘기면 파산이 사라진다.
      return {
        pct: null,
        reason: `${label}의 시작 자산이 ${base}입니다 — 0 이하에서는 수익률이 정의되지 않습니다`,
        periods: used,
      };
    }
    factor *= end / base;
    used++;
  }

  return { pct: (factor - 1) * 100, reason: '', periods: used };
}

// ── 금액가중 수익률 (MWR / XIRR) ──────────────────────────

export interface CashFlow {
  /** 시점 (ms). 순서는 상관없다 */
  atMs: number;
  /**
   * 금액. **내 지갑 기준이다** — 계좌에 넣으면 음수, 빼면 양수.
   * 마지막 평가액은 '지금 다 빼면 이만큼'이므로 양수로 넣는다.
   */
  amount: number;
  label?: string;
}

/** 연 −99.99%보다 아래는 찾지 않는다 — 그 아래는 사실상 전액 손실이다 */
const RATE_LO = -0.9999;
/** 연 +10,000%. 이보다 큰 답은 입력이 이상한 것이다 */
const RATE_HI = 100;
const DAY_MS = 86_400_000;
const YEAR_DAYS = 365;

function npv(flows: Array<{ t: number; a: number }>, rate: number): number {
  let sum = 0;
  for (const f of flows) sum += f.a / Math.pow(1 + rate, f.t);
  return sum;
}

/**
 * 금액가중 수익률 (연율, XIRR).
 *
 * **이분법으로 푼다.** 뉴턴법이 더 빠르지만 현금흐름이 복잡하면 발산하고,
 * 발산했다는 것을 호출하는 쪽이 알기 어렵다 — 그러면 화면에 이상한 숫자가
 * 그냥 뜬다. 이분법은 느린 대신 **답이 있으면 반드시 찾고 없으면 없다고
 * 말한다.**
 */
export function moneyWeightedReturn(flows: CashFlow[] | null | undefined): ReturnResult {
  const list = (Array.isArray(flows) ? flows : [])
    .map(f => ({ t: num(f?.atMs), a: num(f?.amount) }))
    .filter(f => f.t != null && f.a != null) as Array<{ t: number; a: number }>;

  if (list.length < 2) {
    return { pct: null, reason: '현금흐름이 2건 미만입니다 — 수익률을 낼 수 없습니다' };
  }

  const hasIn = list.some(f => f.a < 0);
  const hasOut = list.some(f => f.a > 0);
  if (!hasIn || !hasOut) {
    // 부호가 한쪽뿐이면 방정식에 해가 없다. **0%로 눕히지 않는다** —
    // 0%는 '본전'이라는 뜻이고, 여기는 '계산 불가'다.
    return {
      pct: null,
      reason: '넣은 돈과 뺀 돈(또는 현재 평가액)이 둘 다 있어야 합니다 — 한쪽만으로는 수익률이 정의되지 않습니다',
    };
  }

  const t0 = Math.min(...list.map(f => f.t));
  const norm = list.map(f => ({ t: (f.t - t0) / DAY_MS / YEAR_DAYS, a: f.a }));

  // 전부 같은 날이면 시간이 0이라 연율이 정의되지 않는다.
  if (norm.every(f => f.t === 0)) {
    return { pct: null, reason: '현금흐름이 모두 같은 시점입니다 — 기간이 없으면 연 수익률이 없습니다' };
  }

  let lo = RATE_LO, hi = RATE_HI;
  const fLo = npv(norm, lo), fHi = npv(norm, hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) {
    return {
      pct: null,
      reason: `이 현금흐름에서는 연 ${(RATE_LO * 100).toFixed(0)}%~${RATE_HI * 100}% 사이에 해가 없습니다`,
    };
  }

  // 100번이면 구간이 2^-100로 줄어든다. 늘 같은 횟수를 도므로 결과가
  // 결정적이다 — 같은 입력이 같은 답을 낸다.
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (npv(norm, mid) * fLo > 0) lo = mid; else hi = mid;
  }

  return { pct: ((lo + hi) / 2) * 100, reason: '' };
}

// ── 단순 수익률이 거짓말을 하는가 ─────────────────────────

export interface NaiveCheck {
  /** (지금 − 넣은 돈) ÷ 넣은 돈 */
  naivePct: number | null;
  twrPct: number | null;
  mwrPct: number | null;
  /** 단순 수익률과 TWR의 차이(%p) */
  gapPp: number | null;
  /** 이 화면에 단순 수익률을 그대로 써도 되는가 */
  safeToShowNaive: boolean;
  reason: string;
}

/**
 * 이 정도 벌어지면 단순 수익률을 그냥 보여주면 안 된다.
 *
 * 1%p는 반올림이나 수수료로도 생기지만, 그 이상은 입출금이 성적을
 * 만들었다는 뜻이다.
 */
export const NAIVE_GAP_WARN_PP = 1;

/**
 * 단순 수익률을 믿어도 되는가.
 *
 * 입출금이 없으면 세 값이 같아지므로 단순 수익률을 써도 된다. 벌어지기
 * 시작하면 **어느 쪽이 무슨 뜻인지 화면이 말해야 한다.**
 */
export function naiveCheck(
  investedTotal: any, currentValue: any, twr: ReturnResult, mwr: ReturnResult,
): NaiveCheck {
  const inv = num(investedTotal);
  const cur = num(currentValue);
  const naive = inv != null && cur != null && inv > 0 ? ((cur - inv) / inv) * 100 : null;
  const t = twr?.pct ?? null;
  const gap = naive != null && t != null ? Math.abs(naive - t) : null;

  if (naive == null) {
    return { naivePct: null, twrPct: t, mwrPct: mwr?.pct ?? null, gapPp: null,
      safeToShowNaive: false, reason: '넣은 돈을 확인하지 못해 단순 수익률을 낼 수 없습니다' };
  }
  if (gap == null) {
    // TWR을 못 냈으면 단순 수익률이 맞는지 **확인하지 못한** 것이다.
    // 확인하지 못한 것은 통과가 아니다.
    return { naivePct: naive, twrPct: null, mwrPct: mwr?.pct ?? null, gapPp: null,
      safeToShowNaive: false,
      reason: `시간가중 수익률을 내지 못해 이 값이 입출금에 왜곡됐는지 확인할 수 없습니다 — ${twr?.reason || ''}`.trim() };
  }
  if (gap >= NAIVE_GAP_WARN_PP) {
    return { naivePct: naive, twrPct: t, mwrPct: mwr?.pct ?? null, gapPp: gap,
      safeToShowNaive: false,
      reason: `단순 수익률 ${naive.toFixed(2)}%와 시간가중 ${t.toFixed(2)}%가 ${gap.toFixed(2)}%p 다릅니다`
        + ' — 그 차이는 매매가 아니라 입출금 시점이 만든 것입니다' };
  }
  return { naivePct: naive, twrPct: t, mwrPct: mwr?.pct ?? null, gapPp: gap,
    safeToShowNaive: true, reason: '' };
}

// ── 실현 · 미실현 · 비용 ──────────────────────────────────

export interface PnlParts {
  realized?: any;
  unrealized?: any;
  fees?: any;
  funding?: any;
}

export interface PnlBreakdown {
  realized: number | null;
  unrealized: number | null;
  fees: number | null;
  funding: number | null;
  /** 비용을 빼기 전 손익 */
  beforeCost: number | null;
  /** 비용을 뺀 손익 — **이것이 진짜 손익이다** */
  afterCost: number | null;
  /** 비용 합계 (양수 = 나간 돈) */
  costTotal: number | null;
  /** 모르는 항목 이름들. 비어 있지 않으면 합계를 믿으면 안 된다 */
  missing: string[];
  reason: string;
}

/**
 * 손익을 쪼갠다.
 *
 * **모르는 항목이 하나라도 있으면 합계를 내지 않는다.** 수수료를 모르는데
 * 0으로 치고 더하면, 화면의 '순손익'은 실제보다 언제나 좋게 나온다.
 * 그리고 그 낙관은 조용하다 — 어디에도 "수수료를 못 읽었다"고 안 뜬다.
 */
export function pnlBreakdown(p: PnlParts | null | undefined): PnlBreakdown {
  const v = p ?? {};
  const realized = num(v.realized);
  const unrealized = num(v.unrealized);
  const fees = num(v.fees);
  const funding = num(v.funding);

  const missing: string[] = [];
  if (realized == null) missing.push('실현손익');
  if (unrealized == null) missing.push('미실현손익');
  if (fees == null) missing.push('수수료');
  if (funding == null) missing.push('펀딩비');

  if (missing.length > 0) {
    return {
      realized, unrealized, fees, funding,
      beforeCost: null, afterCost: null, costTotal: null, missing,
      reason: `${missing.join(' · ')}를 확인하지 못해 합계를 내지 않습니다`
        + ' — 모르는 값을 0으로 더하면 순손익이 실제보다 좋게 나옵니다',
    };
  }

  const before = realized! + unrealized!;
  const cost = fees! + funding!;
  return {
    realized, unrealized, fees, funding,
    beforeCost: before, afterCost: before - cost, costTotal: cost,
    missing: [],
    reason: '',
  };
}
