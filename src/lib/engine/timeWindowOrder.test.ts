// src/lib/engine/timeWindowOrder.test.ts
//
// 막으려는 것:
//  1. **놓친 조각을 몰아서 내는 것.** 10:00·10:15·10:30 예정인데
//     실행기가 10:10~10:40 죽어 있었다면, 10:40에 세 개를 한꺼번에 내면
//     "네 시간에 걸쳐 나눠 산다"는 뜻이 사라지고 시장 충격도 세 배가 된다.
//     한 번에 사려고 했으면 애초에 분할을 안 했다
//  2. 시세를 못 읽는데 시장가로 내는 것 — 가격 상한을 정한 뜻과 정반대
//  3. 분할청산이 reduceOnly 없이 나가는 것 — 마지막 조각이 반대
//     포지션을 새로 연다
//  4. 취소했다고 이미 산 것을 되파는 것
//  5. 같은 조각이 재시도로 두 번 나가는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  planWindow, missedSliceVerdict, sliceGate, sliceOrderKey,
  cancelPlanOf, progressOf, reduceOnlyCheck,
  DEFAULT_MISSED_POLICY, MAX_SLICES, SOURCE_LABEL,
} from './timeWindowOrder';

const T0 = Date.UTC(2026, 7, 8, 10, 0, 0);
const M = 60_000;

export function runTimeWindowOrderTests() {
  console.log('[시간 분할 — 구간을 나눈다]');

  test('10시~14시 15분마다면 17회다', () => {
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 4 * 60 * M, intervalMinutes: 15, totalNotional: 1000 });
    eq(p.ok, true);
    eq(p.count, 17, '시작 시각에도 한 번 낸다');
    close(p.perSliceNotional!, 1000 / 17, 1e-9);
  });

  test('끝 시각을 넘겨서 내지 않는다', () => {
    // "14시까지"라고 했으면 그 뒤로는 아무것도 나가면 안 된다.
    const end = T0 + 4 * 60 * M;
    const p = planWindow({ startAtMs: T0, endAtMs: end, intervalMinutes: 15, totalNotional: 1000 });
    for (const s of p.slices) assert(s.scheduledAtMs <= end, String(s.scheduledAtMs));
  });

  test('횟수로도 받는다 — 사용자가 나눗셈을 하지 않는다', () => {
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 120 * M, sliceCount: 13, totalNotional: 2000 });
    eq(p.ok, true);
    eq(p.count, 13);
    close(p.perSliceNotional!, 2000 / 13, 1e-9);
    // 마지막 조각이 종료 시각에 딱 떨어져야 한다.
    eq(p.slices[12].scheduledAtMs, T0 + 120 * M);
  });

  test('초반·후반 집중은 몫만 바꾸고 합은 그대로다', () => {
    const front = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000, sliceMode: 'FRONT_LOADED' });
    const sum = front.slices.reduce((a, s) => a + (s.notional as number), 0);
    close(sum, 1000, 1e-6, '총액이 변하면 안 된다');
    assert(front.slices[0].notional! > front.slices[4].notional!, '앞이 커야 한다');

    const back = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000, sliceMode: 'BACK_LOADED' });
    assert(back.slices[0].notional! < back.slices[4].notional!, '뒤가 커야 한다');
  });

  test('총량이 없으면 못 나눈다', () => {
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15 });
    eq(p.ok, false);
    assert(p.reason.includes('얼마를 나눌지'), p.reason);
  });

  test('거꾸로 된 구간을 받지 않는다', () => {
    eq(planWindow({ startAtMs: T0, endAtMs: T0 - M, intervalMinutes: 5, totalNotional: 100 }).ok, false);
  });

  test('너무 잘게 쪼개면 막는다', () => {
    // 조각이 잘아질수록 수수료가 이익을 먹는다.
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 10000 * M, intervalMinutes: 1, totalNotional: 100 });
    eq(p.ok, false);
    assert(p.reason.includes('수수료가 이익을 먹습니다'), p.reason);
    assert(MAX_SLICES <= 500, String(MAX_SLICES));
  });

  test('한 번밖에 안 나뉘면 그렇다고 적는다', () => {
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 5 * M, intervalMinutes: 60, totalNotional: 100 });
    eq(p.count, 1);
    assert(p.warnings.some(w => w.includes('분할이 아니라')), p.warnings.join('|'));
  });

  console.log('[시간 분할 — 놓친 것을 몰아서 내지 않는다]');

  test('30분 죽어 있었어도 한꺼번에 내지 않는다', () => {
    // 10:00·10:15·10:30 예정, 10:40에 깨어남.
    // 셋 다 유예(1분)를 넘겼으므로 **10:40에는 아무것도 안 나간다.**
    // 다음 10:45 조각부터 정상 실행이다.
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000 });
    const v = missedSliceVerdict(p.slices, [], T0 + 40 * M);
    eq(v.catchUp, false);
    eq(v.dueNow.length, 0, '몰아서 내지 않는다');
    eq(v.skipped.length, 3, '지나간 셋은 건너뛴다');
    assert(v.note.includes('시장 충격'), v.note);
  });

  test('유예 안에 둘이 걸려도 최근 것 하나만 낸다', () => {
    // 이 경우가 실제로 위험하다. 둘이 동시에 due로 잡히면 그건 이미
    // 몰아서 내는 것이다.
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000 });
    // 유예를 20분으로 늘려 0번과 1번이 모두 창에 들어오게 한다.
    const v = missedSliceVerdict(p.slices, [], T0 + 16 * M, 'SKIP', 20 * M);
    eq(v.dueNow.length, 1, '**한 번에 하나만**');
    eq(v.dueNow[0], 1, '최근 것');
    assert(v.skipped.includes(0), '앞엣것은 건너뛴다');
  });

  test('기본 정책은 건너뛰기다', () => {
    eq(DEFAULT_MISSED_POLICY, 'SKIP');
  });

  test('조금 늦은 것은 지금 것으로 본다', () => {
    // 1초 늦었다고 건너뛰면 정상 실행이 계속 사라진다.
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000 });
    const v = missedSliceVerdict(p.slices, [], T0 + 1000);
    eq(v.dueNow[0], 0);
    eq(v.skipped.length, 0);
  });

  test('이미 낸 조각은 다시 내지 않는다', () => {
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000 });
    const v = missedSliceVerdict(p.slices, [0], T0 + 1000);
    eq(v.dueNow.length, 0);
  });

  test('아직 시각이 안 됐으면 아무것도 안 낸다', () => {
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000 });
    eq(missedSliceVerdict(p.slices, [], T0 - M).dueNow.length, 0);
  });

  test('지금 시각을 모르면 아무것도 안 낸다', () => {
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000 });
    eq(missedSliceVerdict(p.slices, [], null).dueNow.length, 0);
  });

  console.log('[시간 분할 — 이 조각을 내도 되는가]');

  test('시세가 끊겼으면 시장가를 내지 않는다', () => {
    const g = sliceGate({ side: 'BUY', price: 64000, priceFresh: false });
    eq(g.allow, false);
    eq(g.action, 'BLOCK');
    assert(g.reason.includes('정반대'), g.reason);
  });

  test('앞 조각 결과를 모르면 새 조각을 안 낸다', () => {
    // 그 조각이 사실은 체결됐다면 같은 자리를 두 번 사게 된다.
    const g = sliceGate({ side: 'BUY', price: 64000, hasUnresolved: true });
    eq(g.action, 'BLOCK');
    assert(g.reason.includes('두 번'), g.reason);
  });

  test('가격 상한을 넘으면 그 조각만 건너뛴다', () => {
    const g = sliceGate({ side: 'BUY', price: 67000, maxPrice: 66000 });
    eq(g.action, 'SKIP', '막는 게 아니라 이번만 거른다');
  });

  test('매도는 하한으로 거른다', () => {
    eq(sliceGate({ side: 'SELL', price: 60000, minPrice: 62000 }).action, 'SKIP');
    eq(sliceGate({ side: 'SELL', price: 63000, minPrice: 62000 }).action, 'SUBMIT');
  });

  test('장이 닫혔으면 건너뛴다', () => {
    eq(sliceGate({ side: 'BUY', price: 100, marketOpen: false }).action, 'SKIP');
  });

  test('조건이 다 맞으면 낸다', () => {
    eq(sliceGate({ side: 'BUY', price: 64000, maxPrice: 66000, priceFresh: true }).action, 'SUBMIT');
  });

  console.log('[시간 분할 — 같은 조각이 두 번 나가지 않는다]');

  test('열쇠에 조각 번호가 들어간다', () => {
    // 시각으로 만들면 재시도할 때마다 달라져 같은 조각이 여러 번 나간다.
    eq(sliceOrderKey('run-1', 0), 'run-1#s0');
    eq(sliceOrderKey('run-1', 5), 'run-1#s5');
    assert(sliceOrderKey('run-1', 0) === sliceOrderKey('run-1', 0), '재시도해도 같아야 한다');
  });

  test('번호가 이상하면 열쇠를 만들지 않는다', () => {
    eq(sliceOrderKey('', 0), null);
    eq(sliceOrderKey('r', null), null);
    eq(sliceOrderKey('r', -1), null);
    eq(sliceOrderKey('r', 1.5), null);
  });

  console.log('[시간 분할 — 분할청산은 reduceOnly가 강제다]');

  test('청산이면 언제나 reduceOnly다', () => {
    // 안 켜면 마지막 조각이 나갈 때쯤 포지션이 이미 닫혀 있을 수 있고,
    // 그러면 그 조각이 반대 포지션을 새로 연다.
    const c = reduceOnlyCheck(0.1, 0.2079, true);
    eq(c.forceReduceOnly, true);
    eq(c.ok, true);
    close(c.cappedQuantity!, 0.1, 1e-9);
  });

  test('보유보다 많이 청산하려 하면 잘라 낸다', () => {
    const c = reduceOnlyCheck(0.3, 0.2, true);
    close(c.cappedQuantity!, 0.2, 1e-9);
    assert(c.reason.includes('반대 포지션'), c.reason);
  });

  test('보유 수량을 못 읽으면 시작하지 않는다', () => {
    // 넘치는 만큼이 그대로 신규 진입이 된다.
    const c = reduceOnlyCheck(0.1, null, true);
    eq(c.ok, false);
    assert(c.reason.includes('신규 진입'), c.reason);
  });

  test('신규 진입에는 reduceOnly를 안 건다', () => {
    const c = reduceOnlyCheck(0.1, 0, false);
    eq(c.forceReduceOnly, false);
    eq(c.ok, true);
  });

  console.log('[시간 분할 — 취소는 남은 것만]');

  test('이미 산 것을 자동으로 되팔지 않는다', () => {
    // 사용자가 "그만 사자"고 한 것이지 "산 것을 물러 달라"고 한 게 아니다.
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000 });
    const c = cancelPlanOf(p.slices, [0, 1]);
    eq(c.unwindFilled, false);
    eq(c.cancelIndexes.length, 3);
    assert(c.note.includes('손실이 확정'), c.note);
  });

  console.log('[시간 분할 — 진행 상황]');

  test('평균 체결가는 금액 가중이다', () => {
    // 조각마다 산 금액이 다르므로 단순 평균은 틀린다.
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000 });
    const pr = progressOf(p, [
      { index: 0, filledNotional: 100, avgPrice: 60000 },
      { index: 1, filledNotional: 300, avgPrice: 64000 },
    ], T0 + 20 * M);
    close(pr.filledNotional!, 400, 1e-9);
    close(pr.avgFillPrice!, (100 * 60000 + 300 * 64000) / 400, 1e-6);
    eq(pr.doneCount, 2);
  });

  test('체결 정보를 못 읽은 조각은 평균에서 뺀다', () => {
    // 0으로 세면 평균이 바닥으로 내려간다.
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000 });
    const pr = progressOf(p, [
      { index: 0, filledNotional: 100, avgPrice: 60000 },
      { index: 1, filledNotional: null, avgPrice: null },
    ], T0 + 20 * M);
    close(pr.avgFillPrice!, 60000, 1e-9);
    assert(pr.note.includes('못 읽은'), pr.note);
  });

  test('다음 실행 시각을 알려 준다', () => {
    const p = planWindow({ startAtMs: T0, endAtMs: T0 + 60 * M, intervalMinutes: 15, totalNotional: 1000 });
    const pr = progressOf(p, [{ index: 0, filledNotional: 100, avgPrice: 60000 }], T0 + M);
    eq(pr.nextAtMs, T0 + 15 * M);
  });

  console.log('[시간 분할 — 수동과 전략을 기록에서 구분한다]');

  test('생성 주체를 구분한다', () => {
    // 실행 엔진은 하나지만 기록은 나눈다 — 안 나누면 "내가 산 것"과
    // "전략이 산 것"을 구분할 수 없어 성과 분석이 뜻을 잃는다.
    eq(SOURCE_LABEL.MANUAL, '직접 예약');
    eq(SOURCE_LABEL.STRATEGY, '전략');
  });
}
