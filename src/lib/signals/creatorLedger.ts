// src/lib/signals/creatorLedger.ts
//
// **신호 하나마다 장부 세 권.** FOLLOW · INVERSE · IGNORE.
//
// 왜 세 권인가
// ────────────
// 두 권(순방향·역방향)만 두면 "둘 중 어느 쪽이 나은가"만 묻게 된다.
// 그런데 실제로 가장 흔한 답은 **둘 다 나쁘다**이다 — 양쪽 모두 수수료와
// 미끄러짐을 내고, 같은 손절에 닿는다. 순방향이 -0.42R일 때 역방향이
// +0.42R이 되지 않는다. 둘 다 마이너스인 경우가 가장 많다.
//
// 그래서 **거래하지 않음**을 장부로 둔다. IGNORE의 0R은 '성과 없음'이
// 아니라 **기준선**이다. FOLLOW도 INVERSE도 0을 못 넘으면 이긴 것은
// IGNORE이고, 그 결론이 화면에 그대로 적혀야 한다. 그게 없으면 언제나
// 둘 중 하나를 고르게 되고, 그 선택은 매번 돈을 잃는다.
//
// 무엇을 하지 않는가
// ──────────────────
// **주문을 내지 않는다. 네트워크를 타지 않는다.** 여기는 장부일 뿐이다.
// 그리고 사람을 단정하지 않는다 — 우리가 가진 것은 특정 기간·특정 종목의
// 모의매매 표본이지 그 사람에 대한 평가가 아니다.
//
// 잘게 쪼개는 일의 대가
// ─────────────────────
// "유튜버 × 자산 × 방향 × 국면 × 지연 × 보유시간"으로 나누면 세그먼트가
// 수십 개가 된다. 그리고 **수십 개를 뒤져 가장 좋은 것을 고르면 우연히
// 좋은 것이 반드시 나온다.** 동전 30개를 열 번씩 던지면 그중 하나는
// 여덟 번 앞면이 나온다 — 그 동전이 특별해서가 아니다.
//
// 이 함정은 이 설계의 가장 큰 위험이고, 눈으로는 절대 안 보인다. 세그먼트
// 표에는 그냥 "+0.31R"이라고 적혀 있을 뿐이다. 그래서 **비교한 개수를
// 세어 문턱을 올린다**(Bonferroni). 잘게 쪼갤수록 통과가 어려워지고,
// 그게 정확히 잘게 쪼갠 대가다.

import {
  simulatePair, scoreR, judgeCreator,
  type CreatorSignal, type PricePoint, type SimConfig,
  type Leg, type ExitReason, type Scored, type CreatorJudgement, type JudgeOptions,
} from './creatorEdge';

export type Book = 'FOLLOW' | 'INVERSE' | 'IGNORE';

export interface BookEntry {
  book: Book;
  /** 비용 차감 후 R 배수. IGNORE는 언제나 0 */
  rMultiple: number;
  netPct: number;
  /** IGNORE는 주문을 내지 않았으므로 청산 사유가 없다 */
  exitReason: ExitReason | 'NO_TRADE';
  /** 이 장부가 실제로 주문을 냈는가 */
  traded: boolean;
  side: 'LONG' | 'SHORT' | null;
}

export type MarketRegime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'UNKNOWN';

/** 발언에서 체결까지 걸린 시간. 늦을수록 이미 움직인 가격에 들어간다 */
export type LatencyBucket = 'FAST' | 'MID' | 'SLOW' | 'UNKNOWN';
/** 얼마나 들고 있었나 */
export type HoldBucket = 'SCALP' | 'INTRADAY' | 'SWING' | 'UNKNOWN';

export interface LedgerRow {
  signalId: string;
  creator: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  saidAtMs: number;
  regime: MarketRegime;
  delaySec: number;
  latency: LatencyBucket;
  /** 실제 청산까지 걸린 시간(초). 못 돌렸으면 null */
  holdSec: number | null;
  hold: HoldBucket;
  books: Record<Book, BookEntry>;
  /** 못 돌린 이유. 비어 있으면 정상 */
  skipped: string;
}

const IGNORE_ENTRY: BookEntry = {
  book: 'IGNORE',
  // **0은 '모름'이 아니라 확정된 값이다.** 거래하지 않으면 손익이 정확히
  // 0이고 비용도 0이다. 이 저장소는 보통 0과 없음을 구분하는데, 여기서는
  // 0이 진짜 0이다 — 그 차이를 주석으로 남겨 둔다.
  rMultiple: 0,
  netPct: 0,
  exitReason: 'NO_TRADE',
  traded: false,
  side: null,
};

/** 발언→체결 지연을 칸으로. 경계값은 아래 칸에 넣는다 */
export function latencyBucketOf(delaySec: number | null | undefined): LatencyBucket {
  // **`Number(null)`은 0이다.** 그냥 Number()로 넘기면 지연을 모르는 신호가
  // 전부 FAST 칸에 앉는다 — 그리고 FAST는 성적이 가장 좋게 나오는 칸이라,
  // 모르는 것이 가장 좋은 칸을 채우게 된다. 정확히 반대로 기운 실수다.
  if (delaySec == null || (delaySec as any) === '') return 'UNKNOWN';
  const d = Number(delaySec);
  if (!Number.isFinite(d) || d < 0) return 'UNKNOWN';
  if (d <= 30) return 'FAST';
  if (d <= 120) return 'MID';
  return 'SLOW';
}

/** 보유 시간을 칸으로 */
export function holdBucketOf(holdSec: number | null | undefined): HoldBucket {
  // 위와 같은 이유. null을 0초로 읽으면 SCALP 칸이 오염된다.
  if (holdSec == null || (holdSec as any) === '') return 'UNKNOWN';
  const h = Number(holdSec);
  if (!Number.isFinite(h) || h < 0) return 'UNKNOWN';
  if (h <= 15 * 60) return 'SCALP';
  if (h <= 24 * 3600) return 'INTRADAY';
  return 'SWING';
}

function legToEntry(book: 'FOLLOW' | 'INVERSE', leg: Leg | null): BookEntry {
  if (!leg) {
    // 못 돌렸으면 0으로 채우지 않는다. 0은 '거래 안 함'이라는 뜻인데
    // 여기서는 '못 돌렸다'이고, 둘을 섞으면 IGNORE 장부가 오염된다.
    return { book, rMultiple: NaN, netPct: NaN, exitReason: 'NO_DATA', traded: false, side: null };
  }
  return {
    book,
    rMultiple: leg.rMultiple,
    netPct: leg.netPct,
    exitReason: leg.exitReason,
    traded: true,
    side: leg.side,
  };
}

/**
 * 신호 하나 → 장부 세 권.
 *
 * 세 권에 **완전히 같은 조건**이 들어간다 — 같은 인식 시각, 같은 지연,
 * 같은 수수료, 같은 미끄러짐, 같은 위험거리, 같은 최대 보유시간.
 * 하나라도 다르면 비교가 성립하지 않는다. 그 보장은 simulatePair가
 * 이미 하고 있으므로 **여기서 다시 계산하지 않는다** — 규칙을 두 벌 두면
 * 한쪽만 고쳐지고, 그때 두 장부는 다른 기계의 성적이 된다.
 */
export function buildLedgerRow(
  s: CreatorSignal & { signalId?: string; creator?: string; regime?: MarketRegime },
  path: PricePoint[],
  cfg: SimConfig,
): LedgerRow {
  const pair = simulatePair(s, path, cfg);

  // 보유 시간은 순방향 다리에서 읽는다. 두 다리는 같은 시각에 들어가지만
  // 나가는 시각이 다를 수 있다 — 각자의 손절에 닿기 때문이다.
  const entryAt = Number(s.saidAtMs) + cfg.delaySec * 1000;
  const holdSec = pair.follow ? Math.max(0, (pair.follow.exitAtMs - entryAt) / 1000) : null;

  return {
    signalId: String((s as any).signalId ?? ''),
    creator: String((s as any).creator ?? ''),
    symbol: String((s as any).symbol ?? ''),
    direction: s.direction,
    saidAtMs: Number(s.saidAtMs),
    regime: (s as any).regime ?? 'UNKNOWN',
    delaySec: cfg.delaySec,
    latency: latencyBucketOf(cfg.delaySec),
    holdSec,
    hold: holdBucketOf(holdSec),
    books: {
      FOLLOW: legToEntry('FOLLOW', pair.follow),
      INVERSE: legToEntry('INVERSE', pair.inverse),
      // **IGNORE는 언제나 실린다.** 못 돌린 신호에서도 "거래하지 않았으면
      // 0이었다"는 사실은 변하지 않는다.
      IGNORE: IGNORE_ENTRY,
    },
    skipped: pair.skipped,
  };
}

// ── 세그먼트 ────────────────────────────────────────

/** 무엇으로 쪼갤 것인가. 빈 배열이면 전체를 한 덩어리로 본다 */
export type SegmentDim = 'creator' | 'symbol' | 'direction' | 'regime' | 'latency' | 'hold';

export const ALL_DIMS: SegmentDim[] = ['creator', 'symbol', 'direction', 'regime', 'latency', 'hold'];

export function segmentKeyOf(row: LedgerRow, dims: SegmentDim[]): string {
  if (!dims || dims.length === 0) return '전체';
  return dims.map(d => `${d}=${(row as any)[d] ?? 'UNKNOWN'}`).join(' · ');
}

/**
 * 장부를 세그먼트로 나눈다.
 *
 * **못 돌린 행은 뺀다.** NaN이 섞이면 scoreR이 그것을 걸러 내면서 n이
 * 장부마다 달라지고, 그러면 순방향 30건과 역방향 28건을 비교하게 된다.
 * 같은 신호에서 나온 두 다리는 언제나 같은 개수여야 한다.
 */
export function groupBySegment(
  rows: LedgerRow[] | null | undefined, dims: SegmentDim[],
): Map<string, LedgerRow[]> {
  const out = new Map<string, LedgerRow[]>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    if (r.skipped) continue;
    if (!Number.isFinite(r.books.FOLLOW.rMultiple)) continue;
    if (!Number.isFinite(r.books.INVERSE.rMultiple)) continue;
    const k = segmentKeyOf(r, dims);
    const arr = out.get(k);
    if (arr) arr.push(r); else out.set(k, [r]);
  }
  return out;
}

// ── 다중비교 보정 ───────────────────────────────────

/**
 * 표준정규 분포의 역함수(근사).
 *
 * Acklam의 유리함수 근사. 소수점 아래 넷째 자리까지 맞으면 충분하다 —
 * 여기서 쓰는 곳은 "문턱을 얼마나 올릴 것인가"이지 정밀한 p값이 아니다.
 */
export function invNorm(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])
         / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > ph) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])
         / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q
       / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

/**
 * 세그먼트 K개를 뒤졌을 때, 우위라고 부르려면 기대값이 표준오차의 몇 배여야 하는가.
 *
 * 하나만 봤다면 1.96배면 된다(양측 5%). 그런데 30개를 뒤져 가장 좋은
 * 하나를 고른다면 그 하나는 **고른 행위 자체 때문에** 좋아 보인다.
 * 유의수준을 K로 나눠(Bonferroni) 그만큼 문턱을 올린다.
 *
 * K=1 → 1.96 · K=10 → 2.81 · K=30 → 3.14 · K=100 → 3.48
 *
 * 보수적인 보정이다. 진짜 우위를 놓칠 수 있다 — 그런데 여기서 놓치는
 * 대가는 "좋은 크리에이터를 늦게 찾는 것"이고, 통과시키는 대가는
 * "우연을 우위로 믿고 돈을 넣는 것"이다. 둘은 값이 다르다.
 */
export function requiredZ(comparisons: number, alpha = 0.05): number {
  const k = Math.max(1, Math.floor(comparisons));
  return invNorm(1 - alpha / (2 * k));
}

export interface SegmentJudgement {
  key: string;
  n: number;
  /** 이 세그먼트에서 어느 장부가 이겼는가 */
  best: Book;
  judgement: CreatorJudgement;
  scored: Record<Book, Scored>;
  /** 이 판정을 내리려고 비교한 세그먼트 개수 */
  comparisons: number;
  /** 다중비교 보정을 통과했는가. **애매하면 false다** */
  survivesMultipleComparison: boolean;
  /** 사람이 읽는 한 줄 */
  note: string;
}

/**
 * 한 세그먼트를 판정한다.
 *
 * 판정 자체는 `judgeCreator`가 한다 — **같은 함수여야** 전체 판정과
 * 세그먼트 판정이 다른 규칙으로 갈리지 않는다. 여기서 더하는 것은
 * 두 가지뿐이다: IGNORE 기준선과 다중비교 보정.
 */
export function judgeSegment(
  key: string,
  rows: LedgerRow[],
  opts: {
    /** 학습/검증을 나누는 비율. 기본 0.7 — 앞 70%로 찾고 뒤 30%로 확인한다 */
    splitRatio?: number;
    comparisons?: number;
    alpha?: number;
    judge?: JudgeOptions;
  } = {},
): SegmentJudgement {
  // **시간순으로 나눈다.** 무작위로 섞어 나누면 미래를 보고 과거를
  // 판정하게 된다 — 검증 구간의 뜻이 사라진다.
  const sorted = [...(rows || [])].sort((a, b) => a.saidAtMs - b.saidAtMs);
  const ratio = Math.min(0.95, Math.max(0.05, opts.splitRatio ?? 0.7));
  const cut = Math.floor(sorted.length * ratio);

  const rOf = (list: LedgerRow[], b: Book) => list.map(x => x.books[b].rMultiple);

  const judgement = judgeCreator({
    inSample: {
      follow: rOf(sorted.slice(0, cut), 'FOLLOW'),
      inverse: rOf(sorted.slice(0, cut), 'INVERSE'),
    },
    outOfSample: {
      follow: rOf(sorted.slice(cut), 'FOLLOW'),
      inverse: rOf(sorted.slice(cut), 'INVERSE'),
    },
  }, opts.judge);

  const scored: Record<Book, Scored> = {
    FOLLOW: scoreR(rOf(sorted, 'FOLLOW')),
    INVERSE: scoreR(rOf(sorted, 'INVERSE')),
    IGNORE: scoreR(sorted.map(() => 0)),
  };

  // ── 어느 장부가 이겼는가 ──
  //
  // **IGNORE가 기준선이다.** 순방향도 역방향도 0을 못 넘으면 이긴 것은
  // 거래하지 않은 쪽이고, 그 결론이 그대로 적혀야 한다. 이 줄이 없으면
  // 언제나 둘 중 하나를 고르게 되고 그 선택은 매번 돈을 잃는다.
  const fe = scored.FOLLOW.expectancyR;
  const ie = scored.INVERSE.expectancyR;
  const best: Book = fe <= 0 && ie <= 0 ? 'IGNORE' : fe >= ie ? 'FOLLOW' : 'INVERSE';

  const comparisons = Math.max(1, Math.floor(opts.comparisons ?? 1));
  const zNeed = requiredZ(comparisons, opts.alpha ?? 0.05);

  let survives = false;
  let note = '';
  if (best === 'IGNORE') {
    // 거래하지 않는다는 결론에는 보정이 필요 없다. 아무것도 안 하는 데
    // 통계적 확신이 필요한 것이 아니다 — 그건 기본값이다.
    survives = true;
    note = `순방향 ${fe.toFixed(2)}R · 역방향 ${ie.toFixed(2)}R — 둘 다 비용을 못 넘습니다. `
         + '거래하지 않는 쪽이 이깁니다.';
  } else {
    const sc = scored[best];
    const se = sc.stderrR;
    if (se == null || !(se > 0)) {
      note = `표본이 ${sc.n}건이라 우연인지 판단할 수 없습니다`;
    } else {
      const z = sc.expectancyR / se;
      survives = z >= zNeed;
      note = `${best === 'FOLLOW' ? '순방향' : '역방향'} ${sc.expectancyR.toFixed(2)}R `
           + `(z=${z.toFixed(2)}, 세그먼트 ${comparisons}개를 비교했으므로 ${zNeed.toFixed(2)} 필요) — `
           + (survives
               ? '우연으로 보기 어렵습니다'
               : '세그먼트를 여럿 뒤져 고른 결과일 수 있어 우위로 보지 않습니다');
    }
  }

  return {
    key, n: sorted.length, best, judgement, scored,
    comparisons, survivesMultipleComparison: survives, note,
  };
}

/**
 * 전체 장부를 세그먼트로 나눠 한꺼번에 판정한다.
 *
 * **비교한 개수를 자동으로 센다.** 호출부가 직접 넘기게 두면 잊어버리고,
 * 잊어버리면 보정이 없는 것과 같다. 이 저장소에서 가장 자주 반복된
 * 실패가 "만들어 놓고 배선을 안 함"이라 여기서는 셀 수 없게 만든다.
 */
export function judgeAllSegments(
  rows: LedgerRow[] | null | undefined,
  dims: SegmentDim[],
  opts: { splitRatio?: number; alpha?: number; judge?: JudgeOptions } = {},
): SegmentJudgement[] {
  const groups = groupBySegment(rows, dims);
  const comparisons = groups.size;
  const out: SegmentJudgement[] = [];
  for (const [key, list] of groups) {
    out.push(judgeSegment(key, list, { ...opts, comparisons }));
  }
  // 좋은 것부터. 다만 보정을 통과한 것을 언제나 위에 둔다 — 통과 못 한
  // 세그먼트가 숫자만 좋아서 맨 위에 앉으면 그것부터 읽힌다.
  return out.sort((a, b) => {
    if (a.survivesMultipleComparison !== b.survivesMultipleComparison) {
      return a.survivesMultipleComparison ? -1 : 1;
    }
    return b.scored[b.best].expectancyR - a.scored[a.best].expectancyR;
  });
}

/**
 * 이 세그먼트를 실거래에 연결해도 되는가.
 *
 * **어느 하나라도 아니면 아니다.** 그리고 통과해도 그것은 "Paper에서
 * 다음 단계로 갈 수 있다"는 뜻이지 실주문을 내도 된다는 뜻이 아니다 —
 * 단계는 RESEARCH → PAPER → SHADOW_LIVE → 알림 → 수동 승인 → LIVE_SMALL이다.
 */
export function canPromote(sj: SegmentJudgement | null | undefined): {
  ok: boolean; reason: string;
} {
  if (!sj) return { ok: false, reason: '판정이 없습니다' };
  if (sj.best === 'IGNORE') {
    return { ok: false, reason: '거래하지 않는 쪽이 이깁니다 — 연결할 것이 없습니다' };
  }
  if (sj.judgement.verdict === 'INSUFFICIENT_DATA') {
    return { ok: false, reason: sj.judgement.reason };
  }
  if (sj.judgement.verdict === 'NO_EDGE') {
    return { ok: false, reason: sj.judgement.reason };
  }
  if (!sj.survivesMultipleComparison) {
    return { ok: false, reason: sj.note };
  }
  // 판정과 최고 장부가 어긋나면 통과시키지 않는다. 둘이 다르다는 것은
  // 학습·검증으로 나눈 판정과 전체 집계가 다른 말을 한다는 뜻이다.
  const wanted: Book = sj.judgement.verdict === 'FOLLOW' ? 'FOLLOW' : 'INVERSE';
  if (wanted !== sj.best) {
    return { ok: false,
      reason: `구간 판정은 ${wanted}인데 전체 집계는 ${sj.best}가 낫습니다 — 어긋나면 통과시키지 않습니다` };
  }
  return { ok: true,
    reason: `${sj.note} · 다음 단계는 SHADOW_LIVE입니다 — 아직 실주문이 아닙니다` };
}

export const BOOK_LABEL: Record<Book, string> = {
  FOLLOW: '순방향 (말한 대로)',
  INVERSE: '역방향 (반대로)',
  IGNORE: '거래 안 함 (기준선)',
};
