// src/lib/portfolio/allocation.test.ts
//
// 이 두 모듈이 **어느 전략에 얼마를 줄지**를 정한다. 여기서 틀리면
// 화면에는 "가장 검증된 전략에 집중"이라고 뜨고 실제로는 가장 검증되지
// 않은 전략에 돈이 몰린다.
//
// 특히 세 가지를 지킨다:
//   · 표본 3거래에 3승인 전략이 1등이 되면 안 된다
//   · 자산을 모를 때 배분하면 안 된다 (작은 등급도 '돌린다'는 뜻이다)
//   · **비중을 키우는 것과 한 거래에 크게 거는 것은 다르다**

import { test, eq, assert, close } from '../../test/harness';
import {
  scoreStrategy, scoreAll, MIN_TRADES, MIN_SCORE, MAX_DRAWDOWN_PCT,
  type StrategyStats, type StrategyScore,
} from './strategyScore';
import {
  allocate, tierFor, readTiers, TIERS, UNKNOWN_TIER,
  RISK_PER_TRADE_PCT, RISK_PER_TRADE_HARD_MAX,
} from './allocation';

const stats = (o: Partial<StrategyStats> = {}): StrategyStats => ({
  id: 'a', label: 'A', trades: 100,
  winRatePct: 55, payoffRatio: 1.6, maxDrawdownPct: 8, sharpe: 1.2, return30dPct: 6,
  ...o,
});

/** 점수를 직접 지정한 가짜 평가 결과 — 배분 로직만 보고 싶을 때 */
const sc = (id: string, score: number | null, eligible = true): StrategyScore => ({
  id, label: id, status: eligible ? 'ok' : 'disabled',
  score, eligible, reason: '', parts: [],
});

export function runAllocationTests() {
  console.log('[전략 점수 — 표본이 모자라면 점수를 주지 않는다]');

  test('3거래 3승은 1등이 아니라 "아직 모름"이다', () => {
    const r = scoreStrategy(stats({ trades: 3, winRatePct: 100, payoffRatio: 5, maxDrawdownPct: 0 }));
    eq(r.status, 'insufficient');
    eq(r.score, null, '점수를 매기면 그 숫자가 정렬에 쓰인다');
    eq(r.eligible, false);
    assert(r.reason.includes('3/30'), r.reason);
  });

  test(`${MIN_TRADES}거래부터 평가한다`, () => {
    eq(scoreStrategy(stats({ trades: MIN_TRADES - 1 })).status, 'insufficient');
    eq(scoreStrategy(stats({ trades: MIN_TRADES })).status, 'ok');
  });

  test('표본 부족은 "성적 나쁨"과 다른 상태다 — 하나는 끄고 하나는 더 돌려야 한다', () => {
    const few = scoreStrategy(stats({ trades: 5 }));
    const bad = scoreStrategy(stats({ winRatePct: 20, payoffRatio: 0.6, maxDrawdownPct: 22, sharpe: -0.4, return30dPct: -9 }));
    eq(few.status, 'insufficient');
    eq(bad.status, 'disabled');
    assert(few.status !== bad.status, '둘이 같은 상태가 되면 구분이 사라진다');
  });

  console.log('[전략 점수 — 배점]');

  test('좋은 전략은 높은 점수', () => {
    const r = scoreStrategy(stats({ winRatePct: 62, payoffRatio: 2.0, maxDrawdownPct: 4, sharpe: 2.0, return30dPct: 15 }));
    eq(r.status, 'ok');
    assert((r.score as number) >= 80, `${r.score}점`);
  });

  test('낙폭 한도를 넘으면 점수와 무관하게 끈다', () => {
    const r = scoreStrategy(stats({
      maxDrawdownPct: MAX_DRAWDOWN_PCT + 1,
      winRatePct: 90, payoffRatio: 3, sharpe: 3, return30dPct: 40,
    }));
    eq(r.status, 'disabled');
    assert(r.reason.includes('낙폭'), r.reason);
  });

  test('기준 점수 아래면 끈다', () => {
    const r = scoreStrategy(stats({ winRatePct: 33, payoffRatio: 0.7, maxDrawdownPct: 24, sharpe: -0.5, return30dPct: -12 }));
    eq(r.status, 'disabled');
    assert((r.score as number) < MIN_SCORE, `${r.score}점`);
  });

  test('못 구한 지표는 0점이 아니라 **제외**한다', () => {
    // 샤프만 없는 전략이, 샤프가 실제로 나쁜 전략보다 낮게 나오면 안 된다.
    const noSharpe = scoreStrategy(stats({ sharpe: null }));
    const badSharpe = scoreStrategy(stats({ sharpe: -0.5 }));
    assert((noSharpe.score as number) > (badSharpe.score as number),
      `없음 ${noSharpe.score} vs 나쁨 ${badSharpe.score}`);
    assert(noSharpe.reason.includes('샤프'), '무엇을 제외했는지 말해야 한다');
  });

  test('지표를 하나도 못 구하면 unknown', () => {
    const r = scoreStrategy(stats({
      winRatePct: null, payoffRatio: null, maxDrawdownPct: null, sharpe: null, return30dPct: null,
    }));
    eq(r.status, 'unknown');
    eq(r.eligible, false);
  });

  test('정렬은 자격 있는 것 먼저, 그 다음 점수순', () => {
    const list = scoreAll([
      stats({ id: 'low', winRatePct: 45, payoffRatio: 1.1, maxDrawdownPct: 15, sharpe: 0.3, return30dPct: 1 }),
      stats({ id: 'new', trades: 2 }),
      stats({ id: 'high', winRatePct: 62, payoffRatio: 2.0, maxDrawdownPct: 4, sharpe: 2.0, return30dPct: 15 }),
    ]);
    eq(list[0].id, 'high');
    eq(list[1].id, 'low');
    eq(list[2].id, 'new', '표본 부족은 맨 뒤 — 점수가 없으므로 앞에 설 수 없다');
  });

  console.log('[배분 — 자산 규모가 칸 수를 정한다]');

  test('규모별 등급', () => {
    eq(tierFor(3_000).id, 'seed');
    eq(tierFor(7_000).id, 'focus');
    eq(tierFor(20_000).id, 'focus');
    eq(tierFor(35_000).id, 'spread');
    eq(tierFor(70_000).id, 'portfolio');
    eq(tierFor(1_000_000).id, 'portfolio');
  });

  test('칸 수가 규모를 따라 늘어난다', () => {
    eq(tierFor(3_000).maxActive, 1);
    eq(tierFor(10_000).maxActive, 3);
    eq(tierFor(40_000).maxActive, 5);
    eq(tierFor(100_000).maxActive, 8);
  });

  test('자산을 모르면 배분하지 않는다 — 작은 등급도 "돌린다"는 뜻이다', () => {
    for (const v of [null, undefined, NaN, -1]) {
      const t = tierFor(v as any);
      eq(t.id, 'unknown', String(v));
      eq(t.maxActive, 0);
    }
    const p = allocate({ equityUsd: null, scores: [sc('a', 90)] });
    eq(p.slots.length, 0);
    eq(p.deployableUsd, null);
    assert(p.summary.includes('확인하지 못'), p.summary);
  });

  test('잔고 0은 "모름"과 다르다 — 사용자가 할 일이 다르다 (충전 vs 연결 확인)', () => {
    eq(tierFor(0).id, 'seed');
    const p = allocate({ equityUsd: 0, scores: [sc('a', 90)] });
    eq(p.deployableUsd, 0);
    eq(p.slots[0].usd, 0);
  });

  console.log('[배분 — 집중과 과대 포지션은 다르다]');

  test('거래당 위험은 등급과 무관한 상수다', () => {
    const small = allocate({ equityUsd: 3_000, scores: [sc('a', 90)] });
    const big = allocate({ equityUsd: 500_000, scores: [sc('a', 90), sc('b', 80)] });
    eq(small.riskPerTradePct, RISK_PER_TRADE_PCT);
    eq(big.riskPerTradePct, RISK_PER_TRADE_PCT);
  });

  test('한 전략에 100%를 줘도 거래당 위험은 안 커진다', () => {
    const p = allocate({ equityUsd: 3_000, scores: [sc('a', 95)] });
    eq(p.slots.length, 1);
    eq(p.slots[0].weight, 1, '소액 등급은 한 전략에 몰아준다');
    eq(p.riskPerTradePct, RISK_PER_TRADE_PCT, '그래도 한 거래에 거는 위험은 그대로다');
  });

  test('위험을 상한 위로 올리려 하면 깎고 그 사실을 남긴다', () => {
    const p = allocate({ equityUsd: 10_000, scores: [sc('a', 90)], riskPerTradePct: 10 });
    eq(p.riskPerTradePct, RISK_PER_TRADE_HARD_MAX);
    assert(p.notes.some(n => n.includes('상한')), p.notes.join(' / '));
  });

  console.log('[배분 — 비중]');

  test('점수에 비례해 나눈다', () => {
    const p = allocate({ equityUsd: 100_000, scores: [sc('a', 80), sc('b', 40), sc('c', 40)] });
    eq(p.tier.id, 'portfolio');
    // 상한 30%에 걸린다: 80/160=50% → 30%로 깎이고, 남은 20%를 나머지에
    // 밀어 넣으려다 그쪽도 30%에서 걸린다. 결과는 셋 다 30%, 합 90%.
    // 남은 10%는 현금이다 — 억지로 넣지 않는다.
    eq(p.slots[0].weight, 0.3);
    close(p.slots[1].weight + p.slots[2].weight, 0.6, 1e-3);
    assert(p.notes.some(n => n.includes('현금으로 둡니다')), '다 못 쓴 것을 말해야 한다');
  });

  test('한 전략 상한을 넘지 않는다 — 그 점수는 과거의 것이다', () => {
    // 99 vs 50+50이면 49.7%라 상한에 안 닿는다. 상한이 실제로 무는 값으로.
    const p = allocate({ equityUsd: 10_000, scores: [sc('a', 99), sc('b', 10), sc('c', 10)] });
    eq(p.tier.maxWeight, 0.6);
    assert(p.slots.every(s => s.weight <= 0.6 + 1e-6), JSON.stringify(p.slots));
    assert(p.slots[0].reason.includes('상한'), p.slots[0].reason);
  });

  test('나머지가 전부 상한이면 남은 몫은 현금으로 둔다 — 억지로 밀어 넣지 않는다', () => {
    const p = allocate({ equityUsd: 100_000, scores: [sc('a', 90), sc('b', 10)] });
    const sum = p.slots.reduce((a, s) => a + s.weight, 0);
    assert(sum <= 1 + 1e-6, `합이 ${sum}`);
  });

  test('비중 합은 1을 넘지 않는다 (전 등급)', () => {
    for (const eq_ of [3_000, 10_000, 40_000, 200_000]) {
      const p = allocate({
        equityUsd: eq_,
        scores: ['a','b','c','d','e','f','g','h','i'].map((id, i) => sc(id, 90 - i * 5)),
      });
      const sum = p.slots.reduce((a, s) => a + s.weight, 0);
      assert(sum <= 1 + 1e-6, `${eq_}에서 합이 ${sum}`);
    }
  });

  test('금액은 유보 현금을 뺀 나머지에서 나온다', () => {
    const p = allocate({ equityUsd: 10_000, scores: [sc('a', 90)] });
    eq(p.tier.reservePct, 20);
    eq(p.reserveUsd, 2_000);
    eq(p.deployableUsd, 8_000);
    // 자격 있는 전략이 하나뿐이라 상한 60%에 걸린다 → 4,800만 나간다.
    // **이건 결과지 버그가 아니다.** 검증된 것이 하나뿐이면 현금을 더 들고
    // 있는 것이 맞다. 다만 조용히 놀리면 안 되므로 note로 말한다.
    eq(p.slots[0].weight, 0.6);
    eq(p.slots[0].usd, 4_800);
    assert(p.notes.some(n => n.includes('현금으로 둡니다')), p.notes.join(' / '));
  });

  console.log('[배분 — 자리와 대기]');

  test('자리보다 전략이 많으면 점수순으로 자르고 이유를 남긴다', () => {
    const p = allocate({ equityUsd: 10_000, scores: [sc('a', 90), sc('b', 80), sc('c', 70), sc('d', 60)] });
    eq(p.slots.length, 3);
    eq(p.benched.length, 1);
    eq(p.benched[0].id, 'd');
    assert(p.benched[0].reason.includes('자산이 늘면'), p.benched[0].reason);
  });

  test('표본 부족 전략은 "성적이 나쁜 것이 아니다"라고 적는다', () => {
    const scores = scoreAll([stats({ id: 'a' }), stats({ id: 'new', trades: 4 })]);
    const p = allocate({ equityUsd: 10_000, scores });
    eq(p.slots.length, 1);
    assert(p.notes.some(n => n.includes('아직 모르는')), p.notes.join(' / '));
  });

  test('기준을 넘은 전략이 하나도 없으면 배분하지 않는다', () => {
    const p = allocate({ equityUsd: 10_000, scores: [sc('a', 20, false), sc('b', 10, false)] });
    eq(p.slots.length, 0);
    eq(p.benched.length, 2);
    assert(p.notes.some(n => n.includes('기준을 넘은')), p.notes.join(' / '));
  });

  test('전략이 아예 없으면 그렇게 말한다', () => {
    const p = allocate({ equityUsd: 10_000, scores: [] });
    assert(p.notes.some(n => n.includes('평가할 전략이 없')), p.notes.join(' / '));
  });

  console.log('[배분 — 등급 경계 설정]');

  const envOf = (o: Record<string, string>) => (k: string) => o[k];

  test('기본값', () => {
    eq(readTiers(envOf({})).tiers, TIERS);
  });

  test('환경변수로 경계를 바꾼다', () => {
    const { tiers } = readTiers(envOf({ PORTFOLIO_TIERS_USD: '10000,50000,100000' }));
    eq(tierFor(9_000, tiers).id, 'seed');
    eq(tierFor(10_000, tiers).id, 'focus');
    eq(tierFor(100_000, tiers).id, 'portfolio');
  });

  test('경계가 3개가 아니거나 오름차순이 아니면 기본값을 쓰되 그 사실을 남긴다', () => {
    for (const v of ['1000', '1,2,3,4', '100,50,10']) {
      const r = readTiers(envOf({ PORTFOLIO_TIERS_USD: v }));
      eq(r.tiers, TIERS, v);
      assert(r.note.includes('PORTFOLIO_TIERS_USD'), `${v}: ${r.note}`);
    }
  });

  console.log('[배분 — 처음부터 끝까지]');

  test('실제 통계 → 점수 → 배분', () => {
    const scores = scoreAll([
      stats({ id: 'trend', label: '추세추종', winRatePct: 48, payoffRatio: 2.4, maxDrawdownPct: 9, sharpe: 1.4, return30dPct: 8 }),
      stats({ id: 'breakout', label: '변동성돌파', winRatePct: 58, payoffRatio: 1.3, maxDrawdownPct: 12, sharpe: 0.9, return30dPct: 4 }),
      stats({ id: 'revert', label: '역추세', trades: 12 }),
      stats({ id: 'blown', label: '망가진전략', maxDrawdownPct: 40 }),
    ]);
    // 1,000만 원 ≈ $7,000 → focus 등급, 최대 3칸
    const p = allocate({ equityUsd: 7_000, scores });

    eq(p.tier.id, 'focus');
    eq(p.slots.length, 2, '자격 있는 둘만 들어간다');
    eq(p.reserveUsd, 1_400);
    eq(p.deployableUsd, 5_600);
    assert(p.slots.every(s => s.weight <= 0.6 + 1e-6), '한 전략 60% 상한');
    assert(p.benched.some(b => b.id === 'revert'), '표본 부족은 대기');
    assert(p.benched.some(b => b.id === 'blown'), '낙폭 초과는 대기');
    eq(p.riskPerTradePct, 1, '집중해도 거래당 위험은 1%');
  });
}
