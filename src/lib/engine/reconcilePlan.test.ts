// src/lib/engine/reconcilePlan.test.ts
//
// 실제 화면에 동시에 떠 있던 것:
//
//   결과 미확정 주문 없음   ❌ (10건 남음)
//   앱의 미체결 주문 2건이 거래소에 없습니다
//   거래소 실제 5배 / TRAIGO 의도 49배
//   포지션 모드 확인 실패
//   막힘 · 11/16 · 확인 못 함 2
//
// 막으려는 것:
//  1. 미확정 주문을 안 푼 채로 포지션을 비교하는 것 — 차이가 미확정
//     때문인지 진짜 불일치인지 알 수 없다
//  2. 중간에 멈췄는데 '대조 완료'라고 적는 것
//  3. 앱에만 있는 주문을 그냥 지우는 것 — 나갔는지 아닌지가 영영
//     기록에서 사라진다
//  4. '11/16'처럼 성공인지 실패인지 헷갈리는 표기
import { test, assert, eq } from '../../test/harness';
import {
  RECONCILE_STEPS, reconcileRunOf, blockCountsOf, localOnlyVerdict,
  VENUE_REFLECT_GRACE_MS, type StepResult,
} from './reconcilePlan';

export function runReconcilePlanTests() {
  console.log('[대조 순서 — 주문이 먼저다]');

  test('미확정 주문 대조가 포지션 조회보다 먼저다', () => {
    const ids = RECONCILE_STEPS.map(s => s.id);
    assert(ids.indexOf('MATCH_UNKNOWN') < ids.indexOf('POSITIONS'),
      '미확정을 안 풀고 포지션을 비교하면 차이의 원인을 알 수 없다');
    assert(ids.indexOf('OPEN_ORDERS') < ids.indexOf('MATCH_UNKNOWN'),
      '거래소에 뭐가 살아 있는지부터 알아야 맞춰볼 수 있다');
    assert(ids[ids.length - 1] === 'RECHECK', '고친 뒤에 다시 봐야 한다');
  });

  test('주문 단계가 실패하면 멈춘다', () => {
    for (const id of ['OPEN_ORDERS', 'ORDER_HISTORY', 'MATCH_UNKNOWN', 'SETTLE_LOCAL_ONLY', 'POSITIONS']) {
      eq(RECONCILE_STEPS.find(s => s.id === id)!.continueOnFail, false, id);
    }
  });

  test('설정 조회 실패는 이어서 할 수 있다', () => {
    // 배율을 못 읽었다고 잔고 조회까지 못 할 이유는 없다.
    for (const id of ['LEVERAGE', 'POSITION_MODE', 'LIQUIDATION']) {
      eq(RECONCILE_STEPS.find(s => s.id === id)!.continueOnFail, true, id);
    }
  });

  console.log('[대조 결과 — 중간에 멈춘 것을 완료라고 하지 않는다]');

  const allOk = (): StepResult[] =>
    RECONCILE_STEPS.map(s => ({ id: s.id, state: 'OK' as const, fixed: 0 }));

  test('전부 돌면 완료다', () => {
    const r = reconcileRunOf(allOk());
    eq(r.completed, true);
    eq(r.stoppedAt, null);
    eq(r.totalFixed, 0);
    assert(r.summary.includes('대조 완료'), r.summary);
    assert(r.summary.includes(`${RECONCILE_STEPS.length}/${RECONCILE_STEPS.length}`), r.summary);
  });

  test('고친 건수를 합쳐 적는다', () => {
    const steps = allOk();
    steps.find(s => s.id === 'MATCH_UNKNOWN')!.fixed = 10;
    steps.find(s => s.id === 'SETTLE_LOCAL_ONLY')!.fixed = 2;
    const r = reconcileRunOf(steps);
    eq(r.totalFixed, 12);
    assert(r.summary.includes('12건 정리'), r.summary);
  });

  test('필수 단계가 실패하면 완료가 아니다', () => {
    const steps = allOk();
    steps.find(s => s.id === 'MATCH_UNKNOWN')!.state = 'FAILED';
    steps.find(s => s.id === 'MATCH_UNKNOWN')!.detail = '거래소 응답 없음';
    const r = reconcileRunOf(steps);
    eq(r.completed, false);
    eq(r.stoppedAt, 'MATCH_UNKNOWN');
    assert(r.summary.includes('멈췄습니다'), r.summary);
    assert(r.remaining[0].includes('거래소 응답 없음'), r.remaining.join(' / '));
  });

  test('실패가 있으면 고친 건수 합계를 내지 않는다', () => {
    // 아홉 단계에서 고친 것만 더해 '총 12건 정리'라고 적으면, 못 돈
    // 단계에 남은 문제가 없다는 뜻으로 읽힌다.
    const steps = allOk();
    steps.find(s => s.id === 'MATCH_UNKNOWN')!.fixed = 10;
    steps.find(s => s.id === 'LEVERAGE')!.state = 'FAILED';
    const r = reconcileRunOf(steps);
    eq(r.totalFixed, null);
    eq(r.completed, false);
  });

  test('이어서 할 수 있는 단계가 실패해도 멈추지는 않는다', () => {
    const steps = allOk();
    steps.find(s => s.id === 'LEVERAGE')!.state = 'FAILED';
    const r = reconcileRunOf(steps);
    eq(r.stoppedAt, null);
    eq(r.completed, false, '실패가 있으면 완료는 아니다');
    assert(r.remaining.some(x => x.includes('실제 배율')), r.remaining.join(' / '));
  });

  test('안 돌린 단계를 성공으로 세지 않는다', () => {
    const r = reconcileRunOf([{ id: 'OPEN_ORDERS', state: 'OK' }]);
    eq(r.completed, false);
    eq(r.results.length, RECONCILE_STEPS.length);
    eq(r.results.filter(x => x.state === 'PENDING').length, RECONCILE_STEPS.length - 1);
  });

  test('넘겨받은 순서를 믿지 않는다', () => {
    const shuffled = [...allOk()].reverse();
    const r = reconcileRunOf(shuffled);
    eq(r.results.map(x => x.id).join(','), RECONCILE_STEPS.map(s => s.id).join(','));
  });

  test('안 돌렸으면 그렇다고 한다', () => {
    eq(reconcileRunOf([]).summary, '아직 대조하지 않았습니다');
    eq(reconcileRunOf(null).summary, '아직 대조하지 않았습니다');
  });

  console.log('[점검 표기 — 11/16은 헷갈린다]');

  const item = (id: string, state: string) => ({ id, label: id, state });

  test('세 숫자로 나눠 적는다', () => {
    const c = blockCountsOf([
      ...Array.from({ length: 11 }, (_, i) => item(`ok${i}`, 'ok')),
      item('unknown_orders', 'bad'), item('mismatch', 'bad'), item('leverage', 'bad'),
      item('position_mode', 'unknown'), item('liquidation', 'unknown'),
    ]);
    eq(c.ok, 11);
    eq(c.blocked, 3);
    eq(c.unknown, 2);
    eq(c.label, '정상 11 · 차단 3 · 미확정 2');
  });

  test('미확정이 있으면 주문하지 않는다', () => {
    // 확인하지 못한 것은 통과가 아니다.
    eq(blockCountsOf([item('a', 'ok'), item('b', 'unknown')]).canOrder, false);
    eq(blockCountsOf([item('a', 'ok'), item('b', 'bad')]).canOrder, false);
    eq(blockCountsOf([item('a', 'ok')]).canOrder, true);
  });

  test('항목을 못 읽으면 주문 가능이라고 하지 않는다', () => {
    eq(blockCountsOf([]).canOrder, false);
    eq(blockCountsOf(null).canOrder, false);
  });

  test('먼저 고칠 것을 순서대로 준다', () => {
    // 미확정 주문이 남아 있으면 나머지를 고쳐도 소용없다.
    const c = blockCountsOf([
      item('liquidation', 'unknown'),
      item('leverage', 'bad'),
      item('unknown_orders', 'bad'),
      item('position_mode', 'unknown'),
    ]);
    eq(c.firstFix[0], 'unknown_orders');
    assert(c.firstFix.indexOf('leverage') < c.firstFix.indexOf('liquidation'), c.firstFix.join(' / '));
  });

  console.log('[앱에만 있는 주문 — 지우지 않는다]');

  test('거래소 이력에 최종 상태가 있으면 그것으로 고친다', () => {
    const v = localOnlyVerdict({ historyStatus: 'FILLED' });
    eq(v.action, 'SETTLE_FROM_VENUE');
    eq(v.finalStatus, 'FILLED');
    assert(v.reason.includes('장부를 고칩니다'), v.reason);
  });

  test('이력에도 없으면 지우지 않고 사람에게 넘긴다', () => {
    const v = localOnlyVerdict({ sentAtMs: 0, nowMs: 60_000 });
    eq(v.action, 'ESCALATE');
    eq(v.finalStatus, null);
    assert(v.reason.includes('지우지 않고'), v.reason);
    assert(v.reason.includes('영영 기록에서 사라집니다'), v.reason);
  });

  test('방금 보낸 것은 아직 기다린다', () => {
    // 거래소에 반영되기 전에 '없다'고 판정하면 멀쩡한 주문을 지운다.
    const v = localOnlyVerdict({ sentAtMs: 1000, nowMs: 1000 + VENUE_REFLECT_GRACE_MS - 1 });
    eq(v.action, 'WAIT');
    eq(v.finalStatus, null);
  });

  test('유예가 지나면 더 안 기다린다', () => {
    eq(localOnlyVerdict({ sentAtMs: 1000, nowMs: 1000 + VENUE_REFLECT_GRACE_MS }).action, 'ESCALATE');
  });

  test('보낸 시각을 모르면 기다리지 않는다', () => {
    // 언제 보냈는지 모르는 채로 무한정 기다리면 영영 안 풀린다.
    eq(localOnlyVerdict({}).action, 'ESCALATE');
  });
}
