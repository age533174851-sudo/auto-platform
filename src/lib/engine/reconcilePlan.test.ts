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
  resolveOrder, resolutionFromVenueStatus, reconcileOrdersSummary,
  reconcileGraceMs, VENUE_RECONCILE_GRACE_MS, DEFAULT_RECONCILE_GRACE_MS,
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

  console.log('[주문 대조 — endpoint가 200이라고 주문이 다 풀린 게 아니다]');

  const NOW = 1_700_000_000_000;

  test('C. 이력 조회가 실패하면 로컬 주문을 지우지 않는다', () => {
    // Gate history를 못 읽었는데 '거래소에 없다'고 지우면, 나갔는지
    // 아닌지가 영영 기록에서 사라진다.
    const v = resolveOrder({
      clientOrderId: 'c1', inOpenOrders: false,
      sentAtMs: NOW - 60_000, nowMs: NOW,
    });
    eq(v.resolution, 'STILL_UNKNOWN');
    eq(v.blocksClear, true);
    eq(v.evidence.source, 'NONE');
    assert(v.reason.includes('지우지 않고'), v.reason);
  });

  test('D. 보낸 지 2초면 유예 안이라 미확정을 유지한다', () => {
    const v = resolveOrder({
      clientOrderId: 'c1', inOpenOrders: false,
      sentAtMs: NOW - 2000, nowMs: NOW, graceMs: 5000,
    });
    eq(v.resolution, 'GRACE_PERIOD');
    eq(v.blocksClear, true, '반영 대기도 통과가 아니다 — 모르는 것이지 괜찮은 것이 아니다');
  });

  test('E. 10초 뒤 이력에서 FILLED를 찾으면 증거와 함께 확정한다', () => {
    const v = resolveOrder({
      clientOrderId: 'c1', inOpenOrders: false,
      historyStatus: 'FILLED', historyOrderId: 'v-991',
      filledQty: 1, orderQty: 1,
      sentAtMs: NOW - 10_000, nowMs: NOW, graceMs: 5000,
    });
    eq(v.resolution, 'RESOLVED_FILLED');
    eq(v.blocksClear, false);
    eq(v.evidence.source, 'ORDER_HISTORY');
    eq(v.evidence.venueStatus, 'FILLED');
    eq(v.evidence.venueOrderId, 'v-991');
  });

  test('거래소에 살아 있으면 미확정이 아니라 진행 중이다', () => {
    const v = resolveOrder({ clientOrderId: 'c1', inOpenOrders: true, nowMs: NOW });
    eq(v.resolution, 'GRACE_PERIOD');
    eq(v.evidence.source, 'OPEN_ORDERS');
  });

  test('모르는 상태 문자열을 체결로 읽지 않는다', () => {
    // 거래소가 새 표기를 내면 조용히 체결로 세는 것이 가장 위험하다.
    const v = resolveOrder({
      clientOrderId: 'c1', inOpenOrders: false,
      historyStatus: 'SETTLING', sentAtMs: NOW - 60_000, nowMs: NOW,
    });
    eq(v.resolution, 'STILL_UNKNOWN');
    assert(v.reason.includes('해석하지 못했습니다'), v.reason);
  });

  test('취소인데 일부 체결된 것을 취소로만 적지 않는다', () => {
    // 그 체결분은 실제로 포지션이 됐다.
    eq(resolutionFromVenueStatus('CANCELED', 0.3, 1), 'RESOLVED_PARTIAL');
    eq(resolutionFromVenueStatus('CANCELED', 0, 1), 'RESOLVED_CANCELED');
  });

  test('체결 수량을 모르면 전량 체결로 단정하지 않는다', () => {
    // 거래소가 'closed'만 주고 수량을 안 주면 취소로 닫힌 것일 수도 있다.
    eq(resolutionFromVenueStatus('closed', null, 1), null);
    eq(resolutionFromVenueStatus('closed', 1, 1), 'RESOLVED_FILLED');
    eq(resolutionFromVenueStatus('FILLED', 0.4, 1), 'RESOLVED_PARTIAL');
  });

  test('살아 있는 상태는 확정이 아니다', () => {
    for (const s of ['NEW', 'OPEN', 'LIVE', '', null]) {
      eq(resolutionFromVenueStatus(s), null, String(s));
    }
  });

  console.log('[주문 대조 — 한 건이라도 남으면 통과가 아니다]');

  test('아홉 건이 풀리고 한 건이 남으면 통과가 아니다', () => {
    // 90%가 아니라 '아직 미확정이 있다'이다. 그 한 건이 중복 주문을 만든다.
    const vs = [
      ...Array.from({ length: 9 }, (_, i) => resolveOrder({
        clientOrderId: `c${i}`, historyStatus: 'FILLED', filledQty: 1, orderQty: 1, nowMs: NOW,
      })),
      resolveOrder({ clientOrderId: 'c9', sentAtMs: NOW - 60_000, nowMs: NOW }),
    ];
    const sum = reconcileOrdersSummary(vs);
    eq(sum.total, 10);
    eq(sum.resolved, 9);
    eq(sum.stillUnknown, 1);
    eq(sum.canClear, false);
    assert(sum.reason.includes('중복될 수 있습니다'), sum.reason);
  });

  test('반영 대기도 통과를 막는다', () => {
    const sum = reconcileOrdersSummary([
      resolveOrder({ clientOrderId: 'c1', sentAtMs: NOW - 1000, nowMs: NOW, graceMs: 5000 }),
    ]);
    eq(sum.inGrace, 1);
    eq(sum.canClear, false);
  });

  test('전부 확정되면 통과한다', () => {
    const sum = reconcileOrdersSummary([
      resolveOrder({ clientOrderId: 'c1', historyStatus: 'FILLED', filledQty: 1, orderQty: 1, nowMs: NOW }),
      resolveOrder({ clientOrderId: 'c2', historyStatus: 'CANCELED', nowMs: NOW }),
    ]);
    eq(sum.canClear, true);
    eq(sum.reason, '');
    eq(sum.byResolution.RESOLVED_FILLED, 1);
    eq(sum.byResolution.RESOLVED_CANCELED, 1);
  });

  console.log('[주문 대조 — 거래소마다 반영 속도가 다르다]');

  test('국내 증권사는 유예가 더 길다', () => {
    // 체결 통보가 느리다. 짧게 잡으면 멀쩡한 주문을 미확정으로 몬다.
    assert(reconcileGraceMs('KIS') > reconcileGraceMs('BINANCE'),
      `KIS ${reconcileGraceMs('KIS')} vs BINANCE ${reconcileGraceMs('BINANCE')}`);
    eq(reconcileGraceMs('GATE'), VENUE_RECONCILE_GRACE_MS.GATE);
  });

  test('대소문자를 가리지 않는다', () => {
    eq(reconcileGraceMs('gate'), reconcileGraceMs('GATE'));
  });

  test('모르는 거래소를 가장 빠른 쪽으로 가정하지 않는다', () => {
    // 짧게 잡으면 멀쩡한 주문이 미확정으로 몰리고, 사람이 경고에 무뎌진다.
    const unknown = reconcileGraceMs('아무거나');
    eq(unknown, DEFAULT_RECONCILE_GRACE_MS);
    assert(unknown >= Math.min(...Object.values(VENUE_RECONCILE_GRACE_MS)), String(unknown));
  });
}
