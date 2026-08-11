// src/lib/autotrade/schedulePoll.test.ts
//
// **스케줄러 하나에 기대면 그날이 사라진다.**
//
// GitHub Actions의 cron은 `*/15`로 적혀 있지만 실제 실행이 40~80분씩
// 밀린 기록이 있다. 원본 전략의 판단 창은 09:10~09:30이고 유예를 더해도
// 10:00까지다 — 한 번 크게 밀리면 그날 평가가 통째로 없어진다.
//
// 그래서 24시간 도는 Worker도 예약을 본다. 그러면 보는 곳이 둘이 되고,
// **둘이 같은 줄을 동시에 평가하면 주문이 두 번 나간다.** 이 파일이
// 못 박는 것은 그 둘이다: 무엇을 고르는가, 어떻게 한 번만 도는가.

import { test, eq, assert } from '../../test/harness';
import { selectDueSchedules, claimVerdict, isLiveMode } from './schedulePoll';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const row = (over: Record<string, any> = {}) => ({
  id: `s-${over.symbol ?? 'ETHUSDT'}`,
  user_id: 'u1',
  symbol: 'ETHUSDT',
  connection_id: 'conn-1',
  mode: 'TESTNET',
  enabled: true,
  last_run_at: null,
  interval_min: 15,
  ...over,
});

export function runSchedulePollTests() {
  console.log('[예약 폴링 — 무엇을 고르는가]');

  test('켜져 있고 차례가 된 TESTNET 예약을 고른다', () => {
    const s = selectDueSchedules([row()], NOW);
    eq(s.due.length, 1);
    eq(s.due[0].verdict.code, 'FIRST');
  });

  test('실전 예약은 이 루프가 건드리지 않는다', () => {
    // 아무도 안 보는 시각에 도는 코드를 실계좌에 먼저 붙이지 않는다.
    for (const m of ['LIVE_SMALL', 'LIVE_LIMITED', 'SHADOW_LIVE']) {
      const s = selectDueSchedules([row({ mode: m })], NOW);
      eq(s.due.length, 0, m);
      eq(s.skipped[0].code, 'NOT_TESTNET', m);
    }
    eq(isLiveMode('TESTNET'), false);
    eq(isLiveMode('PAPER'), false);
  });

  test('꺼진 예약은 안 고른다', () => {
    eq(selectDueSchedules([row({ enabled: false })], NOW).skipped[0].code, 'OFF');
    // enabled가 true가 아닌 모든 값은 꺼진 것이다.
    eq(selectDueSchedules([row({ enabled: 'true' })], NOW).due.length, 0);
  });

  test('연결이 없으면 안 고른다 — 평가해도 주문을 못 낸다', () => {
    eq(selectDueSchedules([row({ connection_id: null })], NOW).skipped[0].code, 'NO_CONNECTION');
  });

  test('간격이 아직이면 안 고른다', () => {
    const s = selectDueSchedules([row({ last_run_at: new Date(NOW - 5 * MIN).toISOString() })], NOW);
    eq(s.due.length, 0);
    eq(s.skipped[0].code, 'WAITING');
  });

  test('간격이 지났으면 고른다', () => {
    const s = selectDueSchedules([row({ last_run_at: new Date(NOW - 20 * MIN).toISOString() })], NOW);
    eq(s.due.length, 1);
    eq(s.due[0].verdict.code, 'DUE');
  });

  test('방금 돈 것은 안 고른다 — 몇 초마다 깨어나도 매번 평가하지 않는다', () => {
    const s = selectDueSchedules([row({ last_run_at: new Date(NOW - 5_000).toISOString() })], NOW);
    eq(s.due.length, 0);
    eq(s.skipped[0].code, 'TOO_SOON');
  });

  test('건너뛴 줄을 조용히 버리지 않는다 — 이유가 남는다', () => {
    const s = selectDueSchedules([
      row({ symbol: 'BTCUSDT', mode: 'LIVE_LIMITED' }),
      row({ symbol: 'ETHUSDT' }),
      row({ symbol: 'SOLUSDT', enabled: false }),
    ], NOW);
    eq(s.due.length, 1);
    eq(s.due[0].row.symbol, 'ETHUSDT');
    eq(s.skipped.length, 2);
    for (const x of s.skipped) assert(x.reason.length > 0, `${x.symbol}에 사유가 없다`);
  });

  test('예약이 없으면 조용히 끝난다', () => {
    const s = selectDueSchedules([], NOW);
    eq(s.due.length, 0); eq(s.skipped.length, 0);
  });

  test('배열이 아닌 것을 받아도 터지지 않는다', () => {
    eq(selectDueSchedules(null as any, NOW).due.length, 0);
  });

  console.log('[예약 폴링 — 두 곳이 봐도 한 번만 돈다]');

  test('선점에 성공하면 평가한다', () => {
    const v = claimVerdict(1);
    eq(v.ok, true); eq(v.code, 'CLAIMED');
  });

  test('0줄이면 다른 쪽이 이미 가져간 것이다', () => {
    const v = claimVerdict(0);
    eq(v.ok, false); eq(v.code, 'LOST');
    assert(v.reason.includes('두 번 평가하지 않습니다'), v.reason);
  });

  test('선점 실패를 "남이 가져갔다"로 읽지 않는다', () => {
    // 조회 오류를 LOST로 읽으면 그 예약은 아무도 안 도는데
    // 로그에는 정상으로 보인다.
    const v = claimVerdict(null, new Error('timeout'));
    eq(v.ok, false); eq(v.code, 'FAILED');
    assert(v.reason.includes('timeout'), v.reason);
  });

  test('결과를 못 읽었으면 가져온 것으로 치지 않는다', () => {
    const v = claimVerdict(null);
    eq(v.ok, false); eq(v.code, 'FAILED');
  });

  test('어떤 입력으로도 실패가 성공이 되지 않는다', () => {
    for (const [n, e] of [[0, null], [null, null], [-1, null], [0, new Error('x')]] as any[]) {
      eq(claimVerdict(n, e).ok, false, `${n}/${e}`);
    }
  });
}
