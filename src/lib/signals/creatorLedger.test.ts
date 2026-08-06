// src/lib/signals/creatorLedger.test.ts
//
// 막으려는 것:
//  1. 순방향·역방향만 비교하다 **둘 다 나쁠 때도 하나를 고르는 것**
//     — 가장 흔한 정답은 '거래하지 않음'이다
//  2. 세그먼트를 수십 개로 쪼갠 뒤 가장 좋은 것을 골라 우위라고 부르는 것
//     — 동전 30개를 열 번씩 던지면 하나는 여덟 번 앞면이 나온다
//  3. 학습 구간과 검증 구간을 무작위로 나눠 미래를 보고 과거를 판정하는 것
//  4. 못 돌린 신호를 0R로 채워 '거래 안 함' 장부를 오염시키는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  buildLedgerRow, groupBySegment, judgeSegment, judgeAllSegments,
  latencyBucketOf, holdBucketOf, requiredZ, invNorm, canPromote,
  type LedgerRow,
} from './creatorLedger';
import type { PricePoint, SimConfig } from './creatorEdge';

const CFG: SimConfig = {
  feePctPerSide: 0.045, slippagePct: 0.01, delaySec: 30,
  maxHoldSec: 3600, defaultStopPct: 1, takePct: 2,
};

/** 발언 시각부터 1초 간격으로 가격 경로를 만든다 */
function path(startMs: number, prices: number[], stepSec = 60): PricePoint[] {
  return prices.map((p, i) => ({ t: startMs + i * stepSec * 1000, price: p }));
}

const T0 = Date.UTC(2026, 0, 1);

function signal(over: any = {}) {
  return {
    signalId: 's1', creator: 'A', symbol: 'BTCUSDT',
    direction: 'LONG' as const, saidAtMs: T0, kind: 'EXPLICIT_ENTRY' as const,
    ...over,
  };
}

export function runCreatorLedgerTests() {
  console.log('[크리에이터 장부 — 세 권]');

  test('신호 하나에 장부가 세 권 생긴다', () => {
    const r = buildLedgerRow(signal() as any, path(T0, [100, 101, 102, 103]), CFG);
    eq(r.books.FOLLOW.book, 'FOLLOW');
    eq(r.books.INVERSE.book, 'INVERSE');
    eq(r.books.IGNORE.book, 'IGNORE');
  });

  test('IGNORE는 언제나 0R이고 주문을 내지 않는다', () => {
    const r = buildLedgerRow(signal() as any, path(T0, [100, 101, 102]), CFG);
    eq(r.books.IGNORE.rMultiple, 0);
    eq(r.books.IGNORE.traded, false);
    eq(r.books.IGNORE.exitReason, 'NO_TRADE');
    eq(r.books.IGNORE.side, null);
  });

  test('역방향은 순방향의 부호 반전이 아니다 — 둘 다 비용을 낸다', () => {
    // 완전한 횡보 — 진입가로 돌아와 시간 청산. 그러면 남는 것은 비용뿐이다.
    const r = buildLedgerRow(signal() as any, path(T0, [100, 100, 100, 100]), CFG);
    const f = r.books.FOLLOW.rMultiple;
    const i = r.books.INVERSE.rMultiple;
    assert(Math.abs(f + i) > 1e-9,
      `합이 0이면 비용이 안 들어간 것이다 (f=${f}, i=${i})`);
    assert(f < 0 && i < 0, `횡보에서는 둘 다 비용만큼 진다 (f=${f}, i=${i})`);
  });

  test('못 돌린 신호는 0으로 채우지 않는다', () => {
    // 가격 경로가 없으면 체결가를 지어낼 수 없다. 0R로 채우면
    // '거래해서 본전' 이 되고, 그건 IGNORE 장부와 구별이 안 된다.
    const r = buildLedgerRow(signal() as any, [], CFG);
    assert(!Number.isFinite(r.books.FOLLOW.rMultiple), '못 돌린 것을 0으로 적으면 안 된다');
    assert(r.skipped.length > 0, '왜 못 돌렸는지 남아야 한다');
    // 그래도 IGNORE는 0이다 — 거래하지 않았으면 0인 것은 변하지 않는다.
    eq(r.books.IGNORE.rMultiple, 0);
  });

  test('못 돌린 행은 세그먼트에 들어가지 않는다', () => {
    const ok = buildLedgerRow(signal() as any, path(T0, [100, 102, 104]), CFG);
    const bad = buildLedgerRow(signal({ signalId: 's2' }) as any, [], CFG);
    const g = groupBySegment([ok, bad], ['creator']);
    eq(g.get('creator=A')?.length, 1, 'NaN이 섞이면 두 장부의 n이 달라진다');
  });

  console.log('[크리에이터 장부 — 칸 나누기]');

  test('지연은 경계값을 아래 칸에 넣는다', () => {
    eq(latencyBucketOf(0), 'FAST');
    eq(latencyBucketOf(30), 'FAST');
    eq(latencyBucketOf(31), 'MID');
    eq(latencyBucketOf(120), 'MID');
    eq(latencyBucketOf(121), 'SLOW');
    eq(latencyBucketOf(null), 'UNKNOWN', '모르면 모른다 — FAST로 넣으면 안 된다');
    eq(latencyBucketOf(-1), 'UNKNOWN');
  });

  test('보유 시간도 마찬가지다', () => {
    eq(holdBucketOf(900), 'SCALP');
    eq(holdBucketOf(901), 'INTRADAY');
    eq(holdBucketOf(86400), 'INTRADAY');
    eq(holdBucketOf(86401), 'SWING');
    eq(holdBucketOf(undefined), 'UNKNOWN');
  });

  console.log('[크리에이터 장부 — 거래하지 않는 쪽이 이길 때]');

  test('순방향도 역방향도 0을 못 넘으면 IGNORE가 이긴다', () => {
    // 횡보 → 양쪽 다 비용만 나간다. 이때 "그래도 둘 중 나은 쪽"을 고르면
    // 매번 돈을 잃는다.
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push(buildLedgerRow(
        signal({ signalId: `s${i}`, saidAtMs: T0 + i * 86400000 }) as any,
        path(T0 + i * 86400000, [100, 100.1, 100, 99.95, 100]),
        CFG));
    }
    const sj = judgeSegment('전체', rows, { comparisons: 1 });
    eq(sj.best, 'IGNORE');
    assert(sj.note.includes('거래하지 않는 쪽'), sj.note);
  });

  test('거래하지 않는다는 결론에는 통계적 확신을 요구하지 않는다', () => {
    // 아무것도 안 하는 것이 기본값이다. 그것에 증거를 요구하면
    // 증거가 모자랄 때마다 거래하게 된다 — 정확히 반대로 기울었다.
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(buildLedgerRow(
        signal({ signalId: `s${i}`, saidAtMs: T0 + i * 86400000 }) as any,
        path(T0 + i * 86400000, [100, 100.05, 100, 100.02]),
        CFG));
    }
    const sj = judgeSegment('전체', rows, { comparisons: 50 });
    eq(sj.best, 'IGNORE');
    eq(sj.survivesMultipleComparison, true);
  });

  console.log('[크리에이터 장부 — 여럿을 뒤져 고른 결과인가]');

  test('역정규분포 근사가 알려진 값과 맞는다', () => {
    close(invNorm(0.975), 1.959964, 1e-4);
    close(invNorm(0.995), 2.575829, 1e-4);
    close(invNorm(0.5), 0, 1e-6);
  });

  test('비교한 세그먼트가 많을수록 문턱이 올라간다', () => {
    close(requiredZ(1), 1.959964, 1e-3);
    assert(requiredZ(10) > requiredZ(1));
    assert(requiredZ(30) > requiredZ(10));
    assert(requiredZ(100) > requiredZ(30));
    // 하나만 봤을 때와 백 개를 뒤졌을 때가 같으면 보정이 없는 것이다.
    assert(requiredZ(100) - requiredZ(1) > 1);
  });

  test('세그먼트를 여럿 뒤져 고른 우위는 통과시키지 않는다', () => {
    // 같은 데이터를 comparisons=1과 comparisons=200으로 판정하면
    // 뒤쪽이 더 엄격해야 한다.
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 80; i++) {
      // 살짝 오르는 경로 — 순방향이 조금 유리하다
      const up = i % 3 === 0 ? [100, 100.3, 101.2, 102.2] : [100, 100.1, 100.4, 100.2];
      rows.push(buildLedgerRow(
        signal({ signalId: `s${i}`, saidAtMs: T0 + i * 86400000 }) as any,
        path(T0 + i * 86400000, up), CFG));
    }
    const lenient = judgeSegment('전체', rows, { comparisons: 1 });
    const strict  = judgeSegment('전체', rows, { comparisons: 200 });
    assert(strict.comparisons > lenient.comparisons);
    // 엄격한 쪽이 통과했다면 느슨한 쪽도 반드시 통과해야 한다 — 반대는 아니다.
    if (strict.survivesMultipleComparison) {
      eq(lenient.survivesMultipleComparison, true, '문턱이 거꾸로 작동한다');
    }
  });

  test('비교 개수를 호출부가 잊어버릴 수 없다', () => {
    // judgeAllSegments가 세그먼트 수를 직접 센다. 호출부가 넘기게 두면
    // 잊어버리고, 잊어버리면 보정이 없는 것과 같다.
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(buildLedgerRow(
        signal({
          signalId: `s${i}`, saidAtMs: T0 + i * 86400000,
          creator: i % 2 ? 'A' : 'B',
        }) as any,
        path(T0 + i * 86400000, [100, 100.5, 101, 100.8]), CFG));
    }
    const out = judgeAllSegments(rows, ['creator']);
    eq(out.length, 2);
    for (const sj of out) eq(sj.comparisons, 2, '세그먼트 수가 자동으로 안 들어갔다');
  });

  test('보정을 통과한 세그먼트가 언제나 위에 온다', () => {
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(buildLedgerRow(
        signal({
          signalId: `s${i}`, saidAtMs: T0 + i * 86400000,
          creator: i % 2 ? 'A' : 'B',
        }) as any,
        path(T0 + i * 86400000, [100, 100.4, 100.9, 100.6]), CFG));
    }
    const out = judgeAllSegments(rows, ['creator']);
    let seenFail = false;
    for (const sj of out) {
      if (!sj.survivesMultipleComparison) seenFail = true;
      else assert(!seenFail, '통과 못 한 것이 통과한 것보다 위에 있다');
    }
  });

  console.log('[크리에이터 장부 — 승격]');

  test('표본이 모자라면 승격하지 않는다', () => {
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 12; i++) {
      rows.push(buildLedgerRow(
        signal({ signalId: `s${i}`, saidAtMs: T0 + i * 86400000 }) as any,
        path(T0 + i * 86400000, [100, 101, 102.5, 103]), CFG));
    }
    const sj = judgeSegment('전체', rows, { comparisons: 1 });
    const c = canPromote(sj);
    eq(c.ok, false);
  });

  test('거래하지 않는 쪽이 이기면 연결할 것이 없다', () => {
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push(buildLedgerRow(
        signal({ signalId: `s${i}`, saidAtMs: T0 + i * 86400000 }) as any,
        path(T0 + i * 86400000, [100, 100.05, 100, 100.02]), CFG));
    }
    const c = canPromote(judgeSegment('전체', rows, { comparisons: 1 }));
    eq(c.ok, false);
    assert(c.reason.includes('연결할 것이 없습니다'), c.reason);
  });

  test('통과해도 실주문이 아니라고 적는다', () => {
    // 통과 경로가 있더라도 다음 단계는 SHADOW_LIVE다. 그 문장이 빠지면
    // 화면에서 '통과'가 '켜도 됨'으로 읽힌다.
    const sj: any = {
      key: '전체', n: 200, best: 'FOLLOW',
      judgement: { verdict: 'FOLLOW', reason: 'ok' },
      scored: { FOLLOW: { expectancyR: 0.3 }, INVERSE: {}, IGNORE: {} },
      comparisons: 1, survivesMultipleComparison: true, note: '우연으로 보기 어렵습니다',
    };
    const c = canPromote(sj);
    eq(c.ok, true);
    assert(c.reason.includes('아직 실주문이 아닙니다'), c.reason);
  });

  test('구간 판정과 전체 집계가 어긋나면 통과시키지 않는다', () => {
    const sj: any = {
      key: '전체', n: 200, best: 'INVERSE',
      judgement: { verdict: 'FOLLOW', reason: 'ok' },
      scored: { FOLLOW: { expectancyR: 0.1 }, INVERSE: { expectancyR: 0.3 }, IGNORE: {} },
      comparisons: 1, survivesMultipleComparison: true, note: 'x',
    };
    eq(canPromote(sj).ok, false);
  });

  console.log('[크리에이터 장부 — 학습·검증을 시간으로 나눈다]');

  test('시간순으로 나눈다 — 미래를 보고 과거를 판정하지 않는다', () => {
    // 뒤쪽 30%만 크게 오르는 데이터. 무작위로 섞어 나누면 그 상승이
    // 학습 구간에 새어 들어가고, 검증 구간의 뜻이 사라진다.
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 100; i++) {
      const p = i >= 70 ? [100, 101, 102.5, 103] : [100, 100.05, 100, 99.98];
      rows.push(buildLedgerRow(
        signal({ signalId: `s${i}`, saidAtMs: T0 + i * 86400000 }) as any,
        path(T0 + i * 86400000, p), CFG));
    }
    const sj = judgeSegment('전체', rows, { splitRatio: 0.7, comparisons: 1 });
    // 학습 구간(앞 70건)은 횡보라 기대값이 음수여야 한다.
    assert(sj.judgement.inSample.follow.expectancyR < 0,
      `학습 구간에 뒤쪽 상승이 새어 들어갔다 (${sj.judgement.inSample.follow.expectancyR})`);
    assert(sj.judgement.outOfSample.follow.expectancyR > 0,
      '검증 구간이 뒤쪽 30건이 아니다');
  });

  test('입력 순서가 뒤죽박죽이어도 시간순으로 정렬한다', () => {
    const mk = (i: number) => buildLedgerRow(
      signal({ signalId: `s${i}`, saidAtMs: T0 + i * 86400000 }) as any,
      path(T0 + i * 86400000, i >= 70 ? [100, 101, 102.5, 103] : [100, 100.05, 100, 99.98]),
      CFG);
    const rows: LedgerRow[] = [];
    for (let i = 0; i < 100; i++) rows.push(mk(i));
    const shuffled = [...rows].reverse();
    const a = judgeSegment('전체', rows, { comparisons: 1 });
    const b = judgeSegment('전체', shuffled, { comparisons: 1 });
    close(a.judgement.inSample.follow.expectancyR,
          b.judgement.inSample.follow.expectancyR, 1e-9,
          '입력 순서가 판정을 바꾸면 안 된다');
  });
}
