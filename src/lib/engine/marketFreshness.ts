// src/lib/engine/marketFreshness.ts
//
// **Exact100X 진입 전 — "언제의 값인지 모르는 시장 데이터"를 막는다.**
//
// 무엇이 문제였나
// ───────────────
// ②·③까지 오면서 청산거리와 비용은 거래소에서 읽은 값으로 계산하게
// 됐다. 그런데 그 값들이 **같은 순간의 시장**이라는 보장은 어디에도
// 없었다.
//
//   · 기준가는 `positionRisk.markPrice` 숫자 하나였다. 관측 시각이
//     아예 없었다. 계좌/포지션 상태 응답에서 가격만 떼어 온 것인데,
//     그 응답의 `updateTime`은 **포지션이 갱신된 시각**이지 마크가가
//     만들어진 시각이 아니다. 포지션을 3일 건드리지 않았으면
//     `updateTime`은 3일 전이고, 마크가는 방금 값이다. 둘은 다른 질문에
//     대한 답이라 서로의 timestamp가 될 수 없다
//   · 호가는 받은 시각만 있고 거래소가 적어 준 시각은 버렸다
//   · premium 캐시는 낡아도 부르는 쪽에서 `Date.now()`를 새로 붙이면
//     "방금 읽은 값"이 됐다(③에서 막았다)
//
// 값이 있다는 것과 그 값이 **지금 시장**이라는 것은 다른 말이다. 100배
// 에서 청산 여유는 0.5%대이고, 몇 초 전 가격으로 그 여유를 계산하면
// 계산 자체가 틀린 전제 위에 선다.
//
// 설계 원칙
// ─────────
//  1. **관측은 값·출처·거래소 시각·수신 시각·캐시 상태를 함께 들고 다닌다.**
//     하나라도 빠지면 그것은 "모르는 것"이고, 모르는 것은 통과가 아니다.
//  2. **나이는 두 번 잰다.** 거래소가 적어 준 시각과 우리가 받은 시각의
//     차(수신 지연·시계 오차), 그리고 받은 시각과 판정 시각의 차(결정
//     시점의 나이). 둘은 다른 고장을 잡는다 — 전자는 "늦게 도착한 값",
//     후자는 "읽어 놓고 오래 들고 있던 값"이다.
//  3. **서로 다른 시점을 하나의 현재 시장 상태로 합치지 않는다.**
//     마크가·호가·premium의 거래소 시각이 서로 벌어져 있으면, 각자는
//     신선해도 **합친 그림은 어느 순간에도 존재한 적이 없다.**
//  4. **미래는 막는다.** 거래소 시각이 수신 시각보다 뒤이거나 수신
//     시각이 지금보다 뒤면 시계가 어긋난 것이다. 그 상태에서 계산한
//     나이는 음수가 되어 **가장 낡은 값이 가장 신선해 보인다.**
//  5. **세탁할 자리를 남기지 않는다.** 이 파일은 `Date.now()`를 부르지
//     않는다. 판정 시각조차 인자로 받는다. 관측 시각을 만들어 낼 수
//     있는 코드가 판정 안에 있으면 그 판정은 자기 자신을 속일 수 있다.
//
// 문턱은 어디서 왔나 — **지어내지 않았다**
// ────────────────────────────────────────
// 저장소에 이미 있는 정본을 먼저 조사했다.
//
//   · `engine/dataQuality.ts` — **화면용** 정본이다. 머리말이 그렇게
//     적고 있고, 기본 주기도 그에 맞다(POLLED 10초 · STALE은 그 10배라
//     100초). 100배 진입 판정에 100초 된 마크가를 쓸 수는 없다. 원칙
//     ("나이는 데이터 자신의 시각으로 잰다", "'없음'과 '오래됨'은 다른
//     상태다")은 그대로 따르되 **숫자는 쓰지 않는다.**
//   · `engine/preTradeChecklist.ts: checkClockSkew` — 여기에 이
//     저장소가 이미 확정한 숫자가 있다. 서명 요청의 `recvWindow`는
//     5000ms이고 안전 비율은 0.6이라 **3000ms**다. 그 머리말이 이유를
//     적고 있다: 경계에 붙은 값을 통과로 적으면 "가끔 실패하는" 상태가
//     되고 그것이 가장 찾기 어려운 고장이다.
//
// 그래서 **규칙 하나**로 정한다:
//
//   > 어떤 출처의 신선도 예산은 **시스템이 그 출처에 대해 이미 선언한
//   > 갱신 주기**다. 선언한 주기가 없으면(=매번 새로 읽는다) 예산은
//   > 저장소의 시계 오차 정본 3000ms다 — 그것이 이 저장소가 이미
//   > 확정한 "두 시각이 이만큼 벌어지면 주문이 안전하지 않다"이기
//   > 때문이다.
//
//   마크가   매번 새로 읽는다(캐시 없음)        → 3000ms
//   호가     매번 새로 읽는다(캐시 없음)        → 3000ms
//   premium  `PREMIUM_TTL` 45초를 선언한다      → 45000ms
//   펀딩상한 매번 새로 읽는다(캐시 없음)        → 3000ms
//   수수료   매번 새로 읽는다(캐시 없음)        → 3000ms
//   브래킷   `BRACKET_TTL` 6시간을 선언한다     → 6시간
//
// 이 숫자들은 **Exact100X가 소유하는 실행 안전 정책**이다. 바이낸스의
// 공식 기준이라고 주장하지 않는다 — 그런 문서를 이 환경에서 확인하지
// 못했고, 확인하지 못한 것을 근거로 적지 않는다.
//
// 무엇을 하지 않는가
// ──────────────────
// **이미 열린 포지션을 닫지 않는다.** 여기는 진입 전 보호다. 데이터가
// 낡았다는 이유로 포지션을 종료시키는 권한은 아직 없다(⑤).

/** 무엇을 관측했는가. 출처별로 예산이 다르므로 종류가 필요하다 */
export type ObservationKind =
  | 'MARK'            // 거리를 재는 기준가
  | 'BOOK'            // 호가 — 예상 체결가·슬리피지
  | 'PREMIUM'         // 펀딩률·다음 정산 시각
  | 'FUNDING_BOUNDS'  // 펀딩 주기·지불 상한
  | 'COMMISSION'      // 계정 실제 수수료율
  | 'BRACKET';        // 유지증거금 구간

/** 이 값이 캐시에서 왔는가. `'FRESH'` 외에는 쓰지 않는다 */
export type ObservationCache = 'FRESH' | 'STALE_CACHE' | 'NONE';

/**
 * **하나의 관측.** 값만 들고 다니지 않는다.
 *
 * `observedAtMs`를 호출부가 `Date.now()`로 붙일 수 없게 하려면, 읽는
 * 쪽(`readMarkPrice` 등)이 자기가 실제로 받은 시각을 **응답에 넣어서**
 * 돌려줘야 한다. 그러면 낡은 캐시에 새 시각을 붙이는 길이 구조적으로
 * 사라진다 — 붙일 시각이 이미 응답 안에 있으므로.
 */
export interface MarketObservation {
  kind: ObservationKind;
  /** 사람이 읽는 출처. 비어 있으면 출처 미상이다 */
  source: string | null;
  /**
   * 값 자체. 숫자인 출처(마크가)만 채운다.
   * **`undefined`는 "이 출처는 값 검사 대상이 아니다"**, `null`은 "못 읽었다".
   */
  value?: number | null;
  /** 거래소가 응답에 적어 준 시각(ms). 없으면 null — **만들어 내지 않는다** */
  exchangeTimeMs: number | null;
  /** 우리가 그 응답을 **실제로 받은** 시각(ms) */
  observedAtMs: number | null;
  cache: ObservationCache | null;
}

export type FreshnessCode =
  | 'OK'
  /** 판정 시각 자체를 못 읽었다 — 나이를 잴 수 없다 */
  | 'NOW_UNUSABLE'
  /** 관측이 아예 없다 */
  | 'OBSERVATION_MISSING'
  /** 값이 숫자로 못 쓸 상태다 (NaN · Infinity · 0 이하) */
  | 'VALUE_INVALID'
  /** 시각이 없거나 숫자가 아니다 — **0이나 지금으로 대체하지 않는다** */
  | 'TIMESTAMP_MISSING'
  /** 캐시 값이다. 지금 것이 아니다 */
  | 'CACHE_NOT_FRESH'
  /** 시각이 미래다 — 시계가 어긋났다 */
  | 'FROM_FUTURE'
  /** 거래소 시각과 수신 시각이 너무 벌어졌다 (지연 또는 시계 오차) */
  | 'QUOTE_LAG_EXCEEDED'
  /** 판정 시점 기준으로 너무 오래된 값이다 */
  | 'STALE'
  /** 서로 다른 시점을 하나의 시장 상태로 합치려 했다 */
  | 'CROSS_SOURCE_SKEW';

export interface FreshnessPolicy {
  /**
   * 두 시각이 이만큼 벌어지면 주문이 안전하지 않다.
   * `checkClockSkew`의 `recvWindow 5000 × safetyRatio 0.6`에서 온다.
   */
  clockSkewBudgetMs: number;
  /** 미래 시각 허용치. 같은 근거다 */
  futureToleranceMs: number;
  /** 거래소 시각 → 수신 시각 지연 예산 (출처별) */
  maxQuoteLagMs: Partial<Record<ObservationKind, number>>;
  /** 수신 시각 → 판정 시각 나이 예산 (출처별) */
  maxDecisionAgeMs: Record<ObservationKind, number>;
  /**
   * 거래소 시각을 **반드시** 들고 와야 하는 출처.
   *
   * 시장 데이터 엔드포인트는 응답에 시각을 적어 준다(premiumIndex의
   * `time`, depth의 `T`/`E`). 계정 쪽 응답(수수료·브래킷·펀딩 정보)은
   * 적어 주지 않으므로 **없는 것을 요구하지 않는다** — 대신 그쪽은
   * 캐시 상태와 수신 시각으로 본다.
   */
  requireExchangeTime: ObservationKind[];
  /**
   * **하나의 "현재 시장 상태"로 합쳐지는 출처들.**
   *
   * 이들끼리는 거래소 시각이 서로 얼마나 벌어졌는지를 본다. 각자
   * 신선해도 서로 다른 순간이면 합친 그림은 존재한 적이 없다.
   */
  crossSourceKinds: ObservationKind[];
}

/**
 * **이 저장소의 시계 오차 정본.** `checkClockSkew`와 같은 수다.
 *
 * 복제가 아니라 같은 근거를 명시적으로 적은 것이다 — `preTradeChecklist`는
 * 주문 서명의 timestamp를 보고, 여기는 시장 데이터의 시각을 본다. 두
 * 판정은 입력이 다르지만 "두 시각이 이만큼 벌어지면 위험하다"는 같은
 * 숫자를 쓴다. 한쪽만 바뀌면 안 되므로 그 사실을 여기 적어 둔다.
 */
export const CLOCK_SKEW_BUDGET_MS = 5000 * 0.6;

/** premium 모듈이 스스로 선언한 갱신 주기 (`PREMIUM_TTL`) */
export const PREMIUM_REFRESH_MS = 45 * 1000;
/** 브래킷 모듈이 스스로 선언한 갱신 주기 (`BRACKET_TTL`) */
export const BRACKET_REFRESH_MS = 6 * 60 * 60 * 1000;

/**
 * **Exact100X가 소유하는 실행 안전 정책.**
 *
 * 화면용 정본(`dataQuality`)을 쓰지 않는 이유는 머리말에 적었다.
 */
export const EXACT100X_FRESHNESS_POLICY: FreshnessPolicy = {
  clockSkewBudgetMs: CLOCK_SKEW_BUDGET_MS,
  futureToleranceMs: CLOCK_SKEW_BUDGET_MS,
  maxQuoteLagMs: {
    MARK: CLOCK_SKEW_BUDGET_MS,
    BOOK: CLOCK_SKEW_BUDGET_MS,
    PREMIUM: CLOCK_SKEW_BUDGET_MS,
  },
  maxDecisionAgeMs: {
    MARK: CLOCK_SKEW_BUDGET_MS,
    BOOK: CLOCK_SKEW_BUDGET_MS,
    PREMIUM: PREMIUM_REFRESH_MS,
    FUNDING_BOUNDS: CLOCK_SKEW_BUDGET_MS,
    COMMISSION: CLOCK_SKEW_BUDGET_MS,
    BRACKET: BRACKET_REFRESH_MS,
  },
  requireExchangeTime: ['MARK', 'BOOK', 'PREMIUM'],
  crossSourceKinds: ['MARK', 'BOOK', 'PREMIUM'],
};

export interface FreshnessFinding {
  kind: ObservationKind;
  code: FreshnessCode;
  detail: string;
  /** 판정 시각 기준 나이(ms). 못 재면 null */
  ageMs: number | null;
  /** 거래소 시각 → 수신 시각 지연(ms). 못 재면 null */
  quoteLagMs: number | null;
}

/**
 * **출처별 관측 시각을 따로 둔다.**
 *
 * 하나로 합치면 "둘 중 어느 쪽이 낡았는가"를 영영 물을 수 없게 된다.
 * 특히 premium과 펀딩 상한은 다른 엔드포인트에서 다른 순간에 온다 —
 * 같은 칸에 적으면 한쪽의 신선함이 다른 쪽을 덮는다.
 */
export interface FreshnessProvenance {
  referenceMarkObservedAtMs: number | null;
  referenceMarkExchangeTimeMs: number | null;
  bookObservedAtMs: number | null;
  bookExchangeTimeMs: number | null;
  premiumObservedAtMs: number | null;
  premiumExchangeTimeMs: number | null;
  fundingBoundsObservedAtMs: number | null;
  commissionObservedAtMs: number | null;
  bracketObservedAtMs: number | null;
  bracketFreshness: ObservationCache | null;
}

export interface MarketFreshnessAssessment {
  ok: boolean;
  code: FreshnessCode;
  reason: string;
  /** 막혔든 통과했든 **본 것을 전부 남긴다** */
  findings: FreshnessFinding[];
  provenance: FreshnessProvenance;
  /** 이 판정을 내린 시각 */
  evaluatedAtMs: number | null;
  /** 가장 큰 교차 출처 시각 차(ms). 못 재면 null */
  maxCrossSourceSkewMs: number | null;
}

/**
 * 숫자로 읽는다. **없는 것은 null이지 0이 아니다.**
 *
 * `Number(null) === 0`이라 그냥 `Number()`를 쓰면 **빠진 시각이 조용히
 * 1970년이 된다.** 1970년은 "아주 낡음"으로 잡히니 다행 아니냐 싶지만,
 * 반대로 빠진 `exchangeTimeMs`가 0이면 지연이 거대해져 "미래/과거"
 * 판정이 엉키고, 무엇보다 **없는 것과 낡은 것이 같은 코드로 보고된다.**
 * 둘은 다른 고장이다.
 */
const num = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const KIND_WORD: Record<ObservationKind, string> = {
  MARK: '기준 마크가',
  BOOK: '호가',
  PREMIUM: 'premium(펀딩률)',
  FUNDING_BOUNDS: '펀딩 주기·상한',
  COMMISSION: '수수료율',
  BRACKET: '유지증거금 구간',
};

const emptyProvenance = (): FreshnessProvenance => ({
  referenceMarkObservedAtMs: null, referenceMarkExchangeTimeMs: null,
  bookObservedAtMs: null, bookExchangeTimeMs: null,
  premiumObservedAtMs: null, premiumExchangeTimeMs: null,
  fundingBoundsObservedAtMs: null,
  commissionObservedAtMs: null,
  bracketObservedAtMs: null, bracketFreshness: null,
});

/** 관측 목록을 출처별 칸에 **그대로** 옮긴다. 합치지 않는다 */
function collectProvenance(obs: Array<MarketObservation | null | undefined>): FreshnessProvenance {
  const p = emptyProvenance();
  for (const o of obs) {
    if (!o) continue;
    const at = num(o.observedAtMs);
    const ex = num(o.exchangeTimeMs);
    if (o.kind === 'MARK') { p.referenceMarkObservedAtMs = at; p.referenceMarkExchangeTimeMs = ex; }
    else if (o.kind === 'BOOK') { p.bookObservedAtMs = at; p.bookExchangeTimeMs = ex; }
    else if (o.kind === 'PREMIUM') { p.premiumObservedAtMs = at; p.premiumExchangeTimeMs = ex; }
    else if (o.kind === 'FUNDING_BOUNDS') { p.fundingBoundsObservedAtMs = at; }
    else if (o.kind === 'COMMISSION') { p.commissionObservedAtMs = at; }
    else if (o.kind === 'BRACKET') { p.bracketObservedAtMs = at; p.bracketFreshness = o.cache ?? null; }
  }
  return p;
}

export interface MarketFreshnessInput {
  /**
   * 이번 판정이 보는 관측들. **목록에 있는 것은 전부 검사한다.**
   *
   * 목록에 **없는** 출처는 여기서 판정하지 않는다(`required` 제외).
   * 이유: "못 읽었다"는 이미 주인이 있는 고장이다 — 브래킷을 못 읽으면
   * `LIQUIDATION_UNSAFE`, 호가·수수료·펀딩을 못 읽으면 `COST_UNKNOWN`이
   * ②·③에서 막는다. 여기서 같은 상황을 `MARKET_DATA_STALE`로 덮어쓰면
   * **사유가 바뀌어** 운영자가 "낡았다"와 "못 읽었다"를 구분할 수 없게
   * 되고, ②·③이 세운 계약이 조용히 사라진다. ④가 보는 것은
   * **"값은 있는데 언제의 값인지 모르는 상태"**다.
   */
  observations: Array<MarketObservation | null | undefined>;
  /**
   * **반드시 있어야 하는 출처.** 목록에 없으면 `OBSERVATION_MISSING`.
   *
   * 기준 마크가가 여기 들어간다 — 그 값에는 다른 주인이 없다. 없으면
   * 거리를 잴 기준 자체가 없으므로 ④가 막는다.
   */
  required: ObservationKind[];
  /** 판정 시각. **이 파일은 `Date.now()`를 부르지 않는다** */
  nowMs: number | null | undefined;
  policy?: FreshnessPolicy;
}

/**
 * **진입 전 시장 데이터 신선도 판정.**
 *
 * 하나라도 막히면 `ok: false`다. 첫 번째 사유를 `code`에 담되
 * `findings`에는 본 것을 전부 남긴다 — 운영자가 "무엇이 낡았는가"를
 * 한 번에 봐야 하기 때문이다.
 */
export function assessMarketFreshness(input: MarketFreshnessInput): MarketFreshnessAssessment {
  const policy = input.policy ?? EXACT100X_FRESHNESS_POLICY;
  const observations = Array.isArray(input.observations) ? input.observations : [];
  const required = Array.isArray(input.required) ? input.required : [];
  const provenance = collectProvenance(observations);
  const findings: FreshnessFinding[] = [];

  const now = num(input.nowMs);
  if (now == null) {
    return {
      ok: false, code: 'NOW_UNUSABLE',
      reason: '판정 시각을 읽지 못했습니다 — 데이터 나이를 잴 수 없습니다',
      findings, provenance, evaluatedAtMs: null, maxCrossSourceSkewMs: null,
    };
  }

  const byKind = new Map<ObservationKind, MarketObservation>();
  for (const o of observations) {
    if (o && o.kind) byKind.set(o.kind, o);
  }

  // ── 출처별 검사 ──
  //
  // `required` + **목록에 실제로 들어온 것** 전부를 본다. 들어온 관측을
  // 빠뜨리면 "검사 목록에서 이름을 지우는" 변경이 조용히 통과한다.
  const toCheck: ObservationKind[] = [...required];
  for (const o of observations) {
    if (o && o.kind && !toCheck.includes(o.kind)) toCheck.push(o.kind);
  }
  for (const kind of toCheck) {
    const word = KIND_WORD[kind] ?? kind;
    const o = byKind.get(kind);
    if (!o) {
      findings.push({ kind, code: 'OBSERVATION_MISSING', ageMs: null, quoteLagMs: null,
        detail: `${word} — 읽지 못했습니다. 값이 없는 것은 통과가 아닙니다` });
      continue;
    }

    // ① 값 자체 (값을 싣는 출처만)
    if (o.value !== undefined) {
      const v = num(o.value);
      if (v == null || !(v > 0)) {
        findings.push({ kind, code: 'VALUE_INVALID', ageMs: null, quoteLagMs: null,
          detail: `${word} — 값이 ${String(o.value)}입니다. 숫자로 쓸 수 없습니다` });
        continue;
      }
    }

    // ② 캐시 상태. 낡은 캐시는 "값은 있지만 지금 것이 아니다"
    if (o.cache !== 'FRESH') {
      findings.push({ kind, code: 'CACHE_NOT_FRESH', ageMs: null, quoteLagMs: null,
        detail: `${word} — ${o.cache === 'STALE_CACHE' ? '만료된 캐시입니다' : '값이 없습니다'}.`
          + ' 지금 것이 아닌 값으로 100배 진입을 판정하지 않습니다' });
      continue;
    }

    // ③ 수신 시각. **없으면 0이나 지금으로 대체하지 않는다**
    const at = num(o.observedAtMs);
    if (at == null) {
      findings.push({ kind, code: 'TIMESTAMP_MISSING', ageMs: null, quoteLagMs: null,
        detail: `${word} — **언제 받았는지** 모릅니다 (${String(o.observedAtMs)}).`
          + ' 시각이 없는 값은 지금 시장이라고 말할 수 없습니다' });
      continue;
    }

    // ④ 거래소 시각. 시장 데이터 출처에는 **반드시** 있어야 한다
    const needEx = policy.requireExchangeTime.includes(kind);
    const ex = num(o.exchangeTimeMs);
    if (needEx && ex == null) {
      findings.push({ kind, code: 'TIMESTAMP_MISSING', ageMs: Math.max(0, now - at), quoteLagMs: null,
        detail: `${word} — 거래소가 적어 준 시각이 없습니다 (${String(o.exchangeTimeMs)}).`
          + ' 수신 시각만으로는 거래소에서 언제 만들어진 값인지 알 수 없습니다' });
      continue;
    }

    // ⑤ 미래 시각 — 시계가 어긋나면 나이가 음수가 되어 **가장 낡은 값이
    //    가장 신선해 보인다.** 음수를 0으로 깎지 않고 막는다.
    const tol = policy.futureToleranceMs;
    if (at > now + tol) {
      findings.push({ kind, code: 'FROM_FUTURE', ageMs: now - at, quoteLagMs: null,
        detail: `${word} — 수신 시각이 지금보다 ${at - now}ms 미래입니다`
          + ` (허용 ${tol}ms). 로컬 시계가 어긋났습니다` });
      continue;
    }
    if (ex != null && ex > at + tol) {
      findings.push({ kind, code: 'FROM_FUTURE', ageMs: now - at, quoteLagMs: at - ex,
        detail: `${word} — 거래소 시각이 수신 시각보다 ${ex - at}ms 미래입니다`
          + ` (허용 ${tol}ms). 거래소와 로컬 시계가 어긋났습니다` });
      continue;
    }

    // ⑥ 수신 지연 — 늦게 도착한 값이거나 시계가 벌어진 것이다
    const lagBudget = policy.maxQuoteLagMs[kind];
    const lag = ex == null ? null : at - ex;
    if (lag != null && lagBudget != null && lag > lagBudget) {
      findings.push({ kind, code: 'QUOTE_LAG_EXCEEDED', ageMs: now - at, quoteLagMs: lag,
        detail: `${word} — 거래소 시각으로부터 ${lag}ms 뒤에 도착했습니다`
          + ` (허용 ${lagBudget}ms). 수신 지연이거나 시계 오차입니다` });
      continue;
    }

    // ⑦ 결정 시점의 나이
    const age = now - at;
    const ageBudget = policy.maxDecisionAgeMs[kind];
    if (ageBudget == null || age > ageBudget) {
      findings.push({ kind, code: 'STALE', ageMs: age, quoteLagMs: lag,
        detail: `${word} — ${age}ms 전 값입니다 (허용 ${ageBudget ?? '미정의'}ms).`
          + ' 지난 시장으로 100배 청산 여유를 계산하지 않습니다' });
      continue;
    }

    findings.push({ kind, code: 'OK', ageMs: age, quoteLagMs: lag,
      detail: `${word} ${age}ms 전${lag == null ? '' : ` (수신 지연 ${lag}ms)`}` });
  }

  // ── 교차 출처 시각 차 ──
  //
  // 각자 자기 예산 안에 있어도 **서로 다른 순간**이면 합친 그림은 어느
  // 순간에도 존재한 적이 없다. 거래소 시각끼리 본다 — 우리 수신 시각으로
  // 재면 각자의 나이 예산에 갇혀 검사가 사실상 비어 버린다.
  //
  // 쌍의 예산은 **둘 중 느슨한 쪽**이다. 스스로 45초 주기를 선언한
  // 출처를 3초 안에 맞추라고 요구하면, 그 출처가 제공하지 않는 것을
  // 요구하는 것이 되어 정상 동작이 영구 차단된다.
  let maxSkew: number | null = null;
  const crossFail: string[] = [];
  const cross = policy.crossSourceKinds
    .map(k => ({ k, o: byKind.get(k) }))
    .filter(x => x.o != null && num(x.o!.exchangeTimeMs) != null) as Array<{ k: ObservationKind; o: MarketObservation }>;
  for (let i = 0; i < cross.length; i++) {
    for (let j = i + 1; j < cross.length; j++) {
      const a = cross[i]; const b = cross[j];
      const ta = num(a.o.exchangeTimeMs) as number;
      const tb = num(b.o.exchangeTimeMs) as number;
      const skew = Math.abs(ta - tb);
      maxSkew = maxSkew == null ? skew : Math.max(maxSkew, skew);
      const budget = Math.max(
        policy.maxDecisionAgeMs[a.k] ?? policy.clockSkewBudgetMs,
        policy.maxDecisionAgeMs[b.k] ?? policy.clockSkewBudgetMs,
      );
      if (skew > budget) {
        crossFail.push(`${KIND_WORD[a.k]} ↔ ${KIND_WORD[b.k]} — 거래소 시각이 ${skew}ms`
          + ` 벌어져 있습니다 (허용 ${budget}ms)`);
      }
    }
  }
  if (crossFail.length) {
    findings.push({ kind: 'MARK', code: 'CROSS_SOURCE_SKEW', ageMs: null, quoteLagMs: null,
      detail: crossFail.join(' · ') });
  }

  const bad = findings.find(f => f.code !== 'OK');
  if (bad) {
    return {
      ok: false, code: bad.code,
      reason: `시장 데이터 신선도 미달 — ${bad.detail}`,
      findings, provenance, evaluatedAtMs: now, maxCrossSourceSkewMs: maxSkew,
    };
  }
  return {
    ok: true, code: 'OK',
    reason: `시장 데이터 신선도 확인 — ${findings.map(f => f.detail).join(' · ')}`,
    findings, provenance, evaluatedAtMs: now, maxCrossSourceSkewMs: maxSkew,
  };
}
