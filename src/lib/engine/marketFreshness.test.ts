// src/lib/engine/marketFreshness.test.ts
//
// **"값은 있는데 언제의 값인지 모르는 상태"로 진입하지 않는다.**
//
// 이 파일은 신선도 판정 그 자체만 본다. 청산가 식은
// `liquidationDistance.test.ts`, 비용은 `executionCost.test.ts`가 본다 —
// 같은 것을 두 곳에서 시험하면 한쪽만 고쳐지고 그때 두 답이 갈린다.
//
// ★ 진입 전 보호다. 이미 열린 포지션을 닫는 권한이 아니다.
import { test, eq, assert } from '../../test/harness';
import {
  assessMarketFreshness, EXACT100X_FRESHNESS_POLICY, CLOCK_SKEW_BUDGET_MS,
  PREMIUM_REFRESH_MS, BRACKET_REFRESH_MS,
  type MarketObservation, type ObservationKind,
} from './marketFreshness';

const NOW = 1_700_000_000_000;

/** 전부 통과하는 관측 한 벌. 시험마다 **한 칸씩만** 망가뜨린다 */
const obs = (over: Partial<Record<ObservationKind, Partial<MarketObservation> | null>> = {})
: MarketObservation[] => {
  const base: Record<ObservationKind, MarketObservation> = {
    MARK: { kind: 'MARK', source: 'EXCHANGE_PREMIUM_INDEX', value: 50_000,
            exchangeTimeMs: NOW - 300, observedAtMs: NOW - 200, cache: 'FRESH' },
    BOOK: { kind: 'BOOK', source: 'EXCHANGE_DEPTH',
            exchangeTimeMs: NOW - 400, observedAtMs: NOW - 250, cache: 'FRESH' },
    PREMIUM: { kind: 'PREMIUM', source: 'EXCHANGE_PREMIUM_INDEX',
               exchangeTimeMs: NOW - 500, observedAtMs: NOW - 350, cache: 'FRESH' },
    FUNDING_BOUNDS: { kind: 'FUNDING_BOUNDS', source: 'EXCHANGE_FUNDING_INFO',
                      exchangeTimeMs: null, observedAtMs: NOW - 100, cache: 'FRESH' },
    COMMISSION: { kind: 'COMMISSION', source: 'EXCHANGE_ACCOUNT',
                  exchangeTimeMs: null, observedAtMs: NOW - 150, cache: 'FRESH' },
    BRACKET: { kind: 'BRACKET', source: 'EXCHANGE_LEVERAGE_BRACKET',
               exchangeTimeMs: null, observedAtMs: NOW - 60_000, cache: 'FRESH' },
  };
  const out: MarketObservation[] = [];
  for (const k of Object.keys(base) as ObservationKind[]) {
    if (k in over) {
      const o = over[k];
      if (o === null) continue;            // 목록에서 통째로 빼기
      out.push({ ...base[k], ...o } as MarketObservation);
    } else out.push(base[k]);
  }
  return out;
};

const ALL: ObservationKind[] = ['MARK', 'BRACKET', 'COMMISSION', 'BOOK', 'PREMIUM', 'FUNDING_BOUNDS'];

const run = (over: Parameters<typeof obs>[0] = {}, now: number | null = NOW) =>
  assessMarketFreshness({ observations: obs(over), required: ALL, nowMs: now });

export function runMarketFreshnessTests() {
  // ══════════════════════════════════════════════════════════
  // 대조군 — **정상 스냅숏을 과도하게 거부하지 않는다**
  // ══════════════════════════════════════════════════════════
  //
  // 이것이 없으면 "전부 막는" 판정도 만점을 받는다. 막는 능력만 시험하면
  // 가장 안전해 보이는 코드는 `return false`다.
  test('정상 스냅숏은 통과한다 — 막는 능력만 시험하지 않는다', () => {
    const v = run();
    assert(v.ok, `정상인데 막혔다 — ${v.reason}`);
    eq(v.code, 'OK');
    eq(v.findings.length, ALL.length, '본 것을 전부 남겨야 한다');
    assert(v.findings.every(f => f.code === 'OK'), '정상인데 지적이 남았다');
  });

  test('브래킷은 6시간, premium은 45초까지 정상이다 — 자기 갱신 주기가 예산이다', () => {
    assert(run({ BRACKET: { observedAtMs: NOW - (BRACKET_REFRESH_MS - 1000) } }).ok,
      '브래킷 6시간 예산 안인데 막혔다');
    assert(run({ PREMIUM: { exchangeTimeMs: NOW - PREMIUM_REFRESH_MS + 2000,
                            observedAtMs: NOW - (PREMIUM_REFRESH_MS - 1000) } }).ok,
      'premium 45초 예산 안인데 막혔다');
  });

  // ══════════════════════════════════════════════════════════
  // ① 마크가 값 자체
  // ══════════════════════════════════════════════════════════
  for (const [label, v] of [
    ['null', null], ['0', 0], ['음수', -1],
    ['NaN', NaN], ['Infinity', Infinity], ['빈 문자열', ''],
  ] as const) {
    test(`마크가 값이 ${label}이면 막는다`, () => {
      const r = run({ MARK: { value: v as any } });
      assert(!r.ok, `${label}인데 통과했다`);
      eq(r.code, 'VALUE_INVALID');
    });
  }

  // ══════════════════════════════════════════════════════════
  // ②③ 시각이 없다 — **0이나 지금으로 대체하지 않는다**
  // ══════════════════════════════════════════════════════════
  test('마크가에 수신 시각이 없으면 막는다', () => {
    const r = run({ MARK: { observedAtMs: null } });
    assert(!r.ok); eq(r.code, 'TIMESTAMP_MISSING');
  });

  test('마크가에 거래소 시각이 없으면 막는다 — 수신 시각만으로는 모른다', () => {
    const r = run({ MARK: { exchangeTimeMs: null } });
    assert(!r.ok); eq(r.code, 'TIMESTAMP_MISSING');
  });

  for (const [label, v] of [['NaN', NaN], ['Infinity', Infinity], ['문자열', 'x']] as const) {
    test(`수신 시각이 ${label}이면 막는다 — 숫자가 아닌 것은 0이 아니다`, () => {
      const r = run({ MARK: { observedAtMs: v as any } });
      assert(!r.ok, `${label}인데 통과했다`); eq(r.code, 'TIMESTAMP_MISSING');
    });
    test(`거래소 시각이 ${label}이면 막는다`, () => {
      const r = run({ BOOK: { exchangeTimeMs: v as any } });
      assert(!r.ok, `${label}인데 통과했다`); eq(r.code, 'TIMESTAMP_MISSING');
    });
  }

  test('판정 시각 자체를 모르면 막는다 — 나이를 잴 수 없다', () => {
    for (const n of [null, undefined, NaN, Infinity] as any[]) {
      const r = assessMarketFreshness({ observations: obs(), required: ALL, nowMs: n });
      assert(!r.ok, `now=${String(n)}인데 통과했다`);
      eq(r.code, 'NOW_UNUSABLE');
    }
  });

  test('관측이 목록에 아예 없으면 "없음"이다 — "낡음"과 다른 코드다', () => {
    const r = run({ BOOK: null });
    assert(!r.ok); eq(r.code, 'OBSERVATION_MISSING');
  });

  // ══════════════════════════════════════════════════════════
  // ④⑤ 낡음
  // ══════════════════════════════════════════════════════════
  test('마크가가 시계오차 예산보다 오래됐으면 막는다', () => {
    const r = run({ MARK: { exchangeTimeMs: NOW - CLOCK_SKEW_BUDGET_MS - 1100,
                            observedAtMs: NOW - CLOCK_SKEW_BUDGET_MS - 1 } });
    assert(!r.ok, '예산을 넘겼는데 통과했다'); eq(r.code, 'STALE');
  });

  test('호가가 오래됐으면 막는다', () => {
    const r = run({ BOOK: { exchangeTimeMs: NOW - CLOCK_SKEW_BUDGET_MS - 1100,
                            observedAtMs: NOW - CLOCK_SKEW_BUDGET_MS - 1 } });
    assert(!r.ok); eq(r.code, 'STALE');
  });

  test('premium이 자기 갱신 주기를 넘겼으면 막는다', () => {
    const r = run({ PREMIUM: { exchangeTimeMs: NOW - PREMIUM_REFRESH_MS - 1100,
                               observedAtMs: NOW - PREMIUM_REFRESH_MS - 1 } });
    assert(!r.ok); eq(r.code, 'STALE');
  });

  test('브래킷이 6시간을 넘겼으면 막는다', () => {
    const r = run({ BRACKET: { observedAtMs: NOW - BRACKET_REFRESH_MS - 1 } });
    assert(!r.ok); eq(r.code, 'STALE');
  });

  test('만료된 캐시는 값이 있어도 막는다 — "지금 것"이 아니다', () => {
    const r = run({ BRACKET: { cache: 'STALE_CACHE' } });
    assert(!r.ok, '만료된 캐시가 통과했다'); eq(r.code, 'CACHE_NOT_FRESH');
    const p = run({ PREMIUM: { cache: 'STALE_CACHE' } });
    assert(!p.ok, '만료된 premium 캐시가 통과했다'); eq(p.code, 'CACHE_NOT_FRESH');
  });

  test('낡은 캐시에 지금 시각을 붙여도 캐시 상태로 잡힌다 — 세탁이 안 된다', () => {
    // 시각만 보면 완벽하게 새것이다. 나이 검사만 있으면 통과한다.
    const r = run({ PREMIUM: { cache: 'STALE_CACHE',
                               exchangeTimeMs: NOW - 100, observedAtMs: NOW } });
    assert(!r.ok, '★ 열흘 된 캐시에 지금 시각을 붙여 통과시켰다');
    eq(r.code, 'CACHE_NOT_FRESH');
  });

  // ══════════════════════════════════════════════════════════
  // ⑥ 수신 지연 — 늦게 도착한 값
  // ══════════════════════════════════════════════════════════
  test('거래소 시각과 수신 시각이 너무 벌어지면 막는다 (지연·시계오차)', () => {
    // 받은 지 100ms밖에 안 됐지만, 거래소가 만든 것은 그보다 한참 전이다.
    const r = run({ MARK: { exchangeTimeMs: NOW - CLOCK_SKEW_BUDGET_MS - 200,
                            observedAtMs: NOW - 100 } });
    assert(!r.ok, '★ 수신 시각만 새것이면 통과시켰다');
    eq(r.code, 'QUOTE_LAG_EXCEEDED');
  });

  // ══════════════════════════════════════════════════════════
  // ⑦ 미래 시각 — 음수 나이를 0으로 깎지 않는다
  // ══════════════════════════════════════════════════════════
  test('수신 시각이 미래면 막는다 — 로컬 시계가 어긋났다', () => {
    const r = run({ MARK: { exchangeTimeMs: NOW + CLOCK_SKEW_BUDGET_MS + 1000,
                            observedAtMs: NOW + CLOCK_SKEW_BUDGET_MS + 1000 } });
    assert(!r.ok, '★ 미래 시각이 "나이 0"으로 읽혀 가장 신선해 보였다');
    eq(r.code, 'FROM_FUTURE');
  });

  test('거래소 시각이 수신 시각보다 미래면 막는다', () => {
    const r = run({ BOOK: { exchangeTimeMs: NOW - 100 + CLOCK_SKEW_BUDGET_MS + 1000,
                            observedAtMs: NOW - 100 } });
    assert(!r.ok); eq(r.code, 'FROM_FUTURE');
  });

  // ══════════════════════════════════════════════════════════
  // ⑧ 교차 출처 시각 차 — 각자 신선해도 **합친 그림**은 없을 수 있다
  // ══════════════════════════════════════════════════════════
  test('각자 예산 안이어도 서로 다른 시점이면 하나의 시장 상태로 합치지 않는다', () => {
    // 마크가: 거래소 시각 NOW-200, 수신 NOW-100 → 나이 100ms · 지연 100ms ✓
    // 호가:   거래소 시각 NOW-5200, 수신 NOW-2600 → 나이 2600ms · 지연 2600ms ✓
    // 둘 다 자기 예산(3000ms) 안이지만 거래소 시각은 5000ms 벌어져 있다.
    const r = run({
      MARK: { exchangeTimeMs: NOW - 200, observedAtMs: NOW - 100 },
      BOOK: { exchangeTimeMs: NOW - 5_200, observedAtMs: NOW - 2_600 },
    });
    assert(!r.ok, '★ 5초 떨어진 마크가와 호가를 하나의 현재 시장으로 합쳤다');
    eq(r.code, 'CROSS_SOURCE_SKEW');
    assert((r.maxCrossSourceSkewMs as number) >= 5_000, '최대 시각차를 적어야 한다');
  });

  test('교차 검사가 각자의 개별 검사로 대체되지 않는다 — 개별은 전부 통과했다', () => {
    const only = assessMarketFreshness({
      observations: obs({
        MARK: { exchangeTimeMs: NOW - 200, observedAtMs: NOW - 100 },
        BOOK: { exchangeTimeMs: NOW - 5_200, observedAtMs: NOW - 2_600 },
      }),
      required: ALL, nowMs: NOW,
    });
    const perSource = only.findings.filter(f => f.code !== 'OK' && f.code !== 'CROSS_SOURCE_SKEW');
    eq(perSource.length, 0, '개별 검사가 이미 잡았다면 교차 검사가 무의미해진다');
  });

  test('premium은 자기 주기가 길어 마크가와 45초까지는 합칠 수 있다', () => {
    // 스스로 45초 주기를 선언한 출처를 3초 안에 맞추라고 요구하면
    // 정상 동작이 영구 차단된다. 쌍의 예산은 느슨한 쪽이다.
    const r = run({ PREMIUM: { exchangeTimeMs: NOW - 40_000, observedAtMs: NOW - 39_900 } });
    assert(r.ok, `정상 동작을 막았다 — ${r.reason}`);
  });

  // ══════════════════════════════════════════════════════════
  // 출처별 관측 시각을 **합치지 않는다**
  // ══════════════════════════════════════════════════════════
  test('provenance가 출처별로 따로 남는다 — premium과 펀딩 상한이 다른 칸이다', () => {
    const v = run();
    const p = v.provenance;
    eq(p.referenceMarkObservedAtMs, NOW - 200);
    eq(p.referenceMarkExchangeTimeMs, NOW - 300);
    eq(p.bookObservedAtMs, NOW - 250);
    eq(p.bookExchangeTimeMs, NOW - 400);
    eq(p.premiumObservedAtMs, NOW - 350);
    eq(p.premiumExchangeTimeMs, NOW - 500);
    eq(p.fundingBoundsObservedAtMs, NOW - 100);
    eq(p.commissionObservedAtMs, NOW - 150);
    eq(p.bracketObservedAtMs, NOW - 60_000);
    eq(p.bracketFreshness, 'FRESH');
    assert(p.premiumObservedAtMs !== p.fundingBoundsObservedAtMs,
      '★ premium과 펀딩 상한이 한 칸으로 합쳐졌다 — 한쪽의 신선함이 다른 쪽을 덮는다');
  });

  test('막혔을 때도 provenance를 남긴다 — 무엇이 몇 ms 전이었는지 말할 수 있어야 한다', () => {
    const v = run({ MARK: { observedAtMs: null } });
    assert(!v.ok);
    eq(v.provenance.bookObservedAtMs, NOW - 250, '막혔다고 기록을 버리지 않는다');
  });

  // ══════════════════════════════════════════════════════════
  // 정책 자체
  // ══════════════════════════════════════════════════════════
  test('시계오차 예산은 저장소 정본과 같은 수다 (recvWindow 5000 × 0.6)', () => {
    eq(CLOCK_SKEW_BUDGET_MS, 3000);
    eq(EXACT100X_FRESHNESS_POLICY.clockSkewBudgetMs, 3000);
    eq(EXACT100X_FRESHNESS_POLICY.futureToleranceMs, 3000);
  });

  test('화면용 정본(dataQuality)의 100초 STALE 기준을 쓰지 않는다', () => {
    for (const k of ['MARK', 'BOOK'] as ObservationKind[]) {
      assert(EXACT100X_FRESHNESS_POLICY.maxDecisionAgeMs[k] < 100_000,
        `${k}에 화면용 기준(100초)을 쓰면 100배 진입이 10만ms 전 가격으로 판정된다`);
    }
  });

  test('시장 데이터 출처는 거래소 시각을 **반드시** 들고 와야 한다', () => {
    for (const k of ['MARK', 'BOOK', 'PREMIUM'] as ObservationKind[]) {
      assert(EXACT100X_FRESHNESS_POLICY.requireExchangeTime.includes(k),
        `${k}에 거래소 시각을 요구하지 않으면 늦게 도착한 값을 구분할 수 없다`);
    }
  });
}
