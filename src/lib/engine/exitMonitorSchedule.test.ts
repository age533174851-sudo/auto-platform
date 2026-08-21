// src/lib/engine/exitMonitorSchedule.test.ts
//
// **401을 '처리 0건'으로 적지 않는지** 본다.
//
// 2026-08-03부터 30번 연속으로 청산 감시가 401을 받았다. 그동안
// 트레일링·본전 이동·시간 청산은 한 번도 돌지 않았는데, 어디에도
// "안 돌았다"는 말이 없었다. 실패가 조용하면 없는 것과 같다.

import { test, eq, assert } from '../../test/harness';
import { exitMonitorPlan, exitMonitorOutcome, EXIT_MONITOR_INTERVAL_MS } from './exitMonitorSchedule';

export function runExitMonitorScheduleTests() {
  console.log('[청산 감시 — 워커가 부른다, 새 비밀 없이]');

  const base = { nowMs: 1_000_000, isMain: true, hasCredential: true };

  test('기동 후 첫 tick에서 바로 부른다', () => {
    const p = exitMonitorPlan({ ...base, lastRunMs: null });
    eq(p.run, true);
  });

  test('간격 안이면 다시 부르지 않는다', () => {
    const p = exitMonitorPlan({ ...base, lastRunMs: base.nowMs - 60_000 });
    eq(p.run, false);
    eq(p.skip, 'TOO_SOON');
  });

  test('간격이 지나면 다시 부른다', () => {
    const p = exitMonitorPlan({ ...base, lastRunMs: base.nowMs - EXIT_MONITOR_INTERVAL_MS - 1 });
    eq(p.run, true);
  });

  test('main 락이 없으면 부르지 않는다 — 손절 이동이 두 번 나가면 안 된다', () => {
    const p = exitMonitorPlan({ ...base, isMain: false, lastRunMs: null });
    eq(p.run, false);
    eq(p.skip, 'NOT_MAIN');
  });

  test('자격이 없으면 부르지 않는다 — 401을 쌓지 않는다', () => {
    const p = exitMonitorPlan({ ...base, hasCredential: false, lastRunMs: null });
    eq(p.run, false);
    eq(p.skip, 'NO_CREDENTIAL');
  });

  test('간격을 바꿔 줄 수 있다', () => {
    eq(exitMonitorPlan({ ...base, lastRunMs: base.nowMs - 30_000, intervalMs: 10_000 }).run, true);
    eq(exitMonitorPlan({ ...base, lastRunMs: base.nowMs - 5_000, intervalMs: 10_000 }).run, false);
  });

  // ── 결과 읽기 ──

  test('200 + ok:true면 확인·처리 건수를 그대로 읽는다', () => {
    const o = exitMonitorOutcome({ status: 200, body: { ok: true, checked: 3, actionable: 1, orphanCleanups: [] } });
    eq(o.code, 'OK');
    eq(o.checked, 3);
    eq(o.actionable, 1);
  });

  test('**401을 처리 0건으로 적지 않는다**', () => {
    const o = exitMonitorOutcome({ status: 401, body: null });
    eq(o.code, 'UNAUTHORIZED');
    eq(o.checked, null);
    eq(o.actionable, null);
    assert(/ADMIN_SECRET/.test(o.message), o.message);
    // **값 자체는 어디에도 싣지 않는다**
    assert(/값은 로그에 남기지 않습니다/.test(o.message), o.message);
  });

  test('연결 자체가 안 되면 "확인 못 함"이지 "할 일 없음"이 아니다', () => {
    const o = exitMonitorOutcome({ status: null, body: null, error: 'timeout' });
    eq(o.code, 'UNREACHABLE');
    eq(o.checked, null);
  });

  test('200인데 ok가 아니면 성공으로 적지 않는다', () => {
    eq(exitMonitorOutcome({ status: 200, body: { checked: 5 } }).code, 'BAD_BODY');
    eq(exitMonitorOutcome({ status: 200, body: null }).code, 'BAD_BODY');
  });

  test('500은 오류로 적는다', () => {
    const o = exitMonitorOutcome({ status: 500, body: { error: '거래소 조회 실패' } });
    eq(o.code, 'HTTP_ERROR');
    assert(/500/.test(o.message), o.message);
  });

  test('남은 보호주문을 치웠으면 그 사실을 적는다', () => {
    const o = exitMonitorOutcome({
      status: 200,
      body: { ok: true, checked: 1, actionable: 0, orphanCleanups: [{ symbol: 'BTC_USDT' }, { symbol: 'ETH_USDT' }] },
    });
    eq(o.orphanCleanups, 2);
    assert(/보호주문 2건/.test(o.message), o.message);
  });
}
