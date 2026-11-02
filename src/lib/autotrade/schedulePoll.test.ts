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
import {
  selectDueSchedules, claimVerdict, isLiveMode, shouldPollNow, POLL_INTERVAL_MS,
  lastEvaluationNote,
} from './schedulePoll';
import { runtimeStateOf, WORKER_STALE_MS } from './evaluationLoop';

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

  console.log('[예약 폴링 — 건너뛴 줄에도 "마지막 판단"을 적는다]');

  // **왜 이 시험이 생겼나 (2026-11-02).**
  //
  // 사용자가 "테스트는 통과하는데 데모 자동매수가 안 나간다"고 했다.
  // GitHub cron(`autotrade-tick`)의 Actions 로그를 25시간 분량 읽으니
  // 6회차가 **전부** 이렇게 끝났다:
  //
  //   {"symbol":"ETHUSDT","mode":"TESTNET","ok":true,"skipped":true,
  //    "code":"WAITING","detail":"다음 평가까지 30분 남았습니다"}
  //
  // 즉 **cron은 한 번도 평가하지 않았다.** 실제 평가자는 24시간 도는 Fly
  // Worker이고(그래서 `last_run_at`이 늘 최근이다), cron은 예비다 —
  // 그 자체는 정상이다.
  //
  // 문제는 **그 로그로는 "왜 진입하지 않았나"에 답할 수 없다**는 것이다.
  // 답은 워커의 판단(`last_decision`·`last_result`)에 있고, 그것을 보려면
  // Fly 로그나 운영 DB를 열어야 한다. `CLAUDE.md`가 금지한 바로 그
  // 문장("fly logs를 열어 확인해 주세요")이 거기서 나온다.
  //
  // 그 줄은 이미 손에 있다 — cron은 `select('*')`로 읽는다. 적지 않았을 뿐이다.

  test('마지막 판단의 결과·사유·주체를 그대로 적는다', () => {
    const n = lastEvaluationNote({
      last_run_at: '2026-11-02T01:00:00.000Z',
      last_result: 'NO_SIGNAL — 5v5가 모이지 않았습니다',
      last_decision: { outcome: 'NO_SIGNAL', reasonCode: 'SCORE_BELOW_ENTRY', source: 'WORKER' },
    } as any);
    eq(n.outcome, 'NO_SIGNAL');
    eq(n.reasonCode, 'SCORE_BELOW_ENTRY');
    eq(n.source, 'WORKER');
    eq(n.at, '2026-11-02T01:00:00.000Z');
    assert(n.line.includes('NO_SIGNAL'), n.line);
    assert(n.line.includes('SCORE_BELOW_ENTRY'), n.line);
    assert(n.line.includes('WORKER'), n.line);
  });

  test('★ 한 번도 평가하지 않은 줄을 "판단 없음"으로 적는다 — 0으로 적지 않는다', () => {
    const n = lastEvaluationNote({} as any);
    eq(n.at, null);
    eq(n.outcome, null);
    eq(n.reasonCode, null);
    assert(n.line.includes('아직 평가 기록이 없습니다'), n.line);
  });

  test('★ 칸이 있는데 못 읽은 것과 없는 것을 구분한다', () => {
    // `last_decision`이 객체가 아니면 **읽지 못한 것이다.** 빈 값으로
    // 적으면 "판단이 없었다"로 읽히고, 그건 사실이 아니다.
    const n = lastEvaluationNote({ last_run_at: '2026-11-02T01:00:00.000Z', last_decision: 'x' } as any);
    eq(n.outcome, null);
    assert(n.line.includes('읽지 못'), n.line);
    assert(n.line.includes('2026-11-02T01:00:00.000Z'), n.line);
  });

  test('★ 사유 코드가 없으면 적지 않는다 — UNKNOWN으로 메우지 않는다', () => {
    const n = lastEvaluationNote({
      last_run_at: '2026-11-02T01:00:00.000Z',
      last_decision: { outcome: 'HOLD' },
    } as any);
    eq(n.outcome, 'HOLD');
    eq(n.reasonCode, null);
    assert(!n.line.includes('UNKNOWN'), n.line);
  });

  test('★ 요약은 길이를 묶는다 — 로그를 한 줄이 다 먹지 않게', () => {
    const n = lastEvaluationNote({
      last_run_at: '2026-11-02T01:00:00.000Z',
      last_result: 'x'.repeat(5000),
      last_decision: { outcome: 'HOLD' },
    } as any);
    assert(n.line.length < 400, `문구가 ${n.line.length}자입니다`);
  });

  test('★ 건너뛴 줄의 보고에 그 판단이 실린다', () => {
    // 이게 없으면 Actions 로그는 "30분 남았습니다"만 적고 끝난다.
    const sel = selectDueSchedules([{
      id: 's1', user_id: 'u', symbol: 'ETHUSDT', connection_id: 'c1', mode: 'TESTNET',
      enabled: true, interval_min: 60,
      last_run_at: new Date(Date.parse('2026-11-02T01:00:00.000Z')).toISOString(),
      last_result: 'NO_SIGNAL — 5v5가 모이지 않았습니다',
      last_decision: { outcome: 'NO_SIGNAL', reasonCode: 'SCORE_BELOW_ENTRY', source: 'WORKER' },
    }], Date.parse('2026-11-02T01:30:00.000Z'));
    eq(sel.due.length, 0);
    eq(sel.skipped.length, 1);
    eq(sel.skipped[0].code, 'WAITING');
    eq(sel.skipped[0].lastEval?.outcome, 'NO_SIGNAL');
    eq(sel.skipped[0].lastEval?.reasonCode, 'SCORE_BELOW_ENTRY');
  });

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

  console.log('[예약 폴링 — 판단 창 안에서 반드시 본다]');

  /** 한국시간 그 날 그 시각의 ms */
  const kst = (d: number, hh: number, mm: number) => Date.UTC(2026, 7, d, hh - 9, mm);

  test('09:10~09:30 창 안에서 폴링이 최소 한 번은 평가한다', () => {
    // 2026-08-13에 GitHub cron이 133분 밀려 이 창을 통째로 놓쳤다.
    // 워커는 1분마다 보므로 20분 창 안에서 최소 20번 기회가 있다.
    let lastPoll: number | null = null;
    let evaluated = 0;
    // 워커 주 루프를 3초 간격으로 흉내낸다.
    for (let t = kst(13, 9, 10); t <= kst(13, 9, 30); t += 3_000) {
      if (!shouldPollNow(lastPoll, t)) continue;
      lastPoll = t;
      const sel = selectDueSchedules([row({ last_run_at: null })], t);
      if (sel.due.length > 0) evaluated++;
    }
    assert(evaluated >= 1, '창 안에서 한 번도 평가하지 않았다');
    assert(evaluated >= 20, `창 20분 동안 ${evaluated}번만 봤다 — 너무 성기다`);
  });

  test('폴링 주기가 판단 창보다 촘촘하다', () => {
    // 창은 20분이다. 폴링이 그보다 성기면 창을 통째로 건너뛸 수 있다.
    assert(POLL_INTERVAL_MS <= 5 * 60_000, '폴링 주기가 5분을 넘는다');
  });

  test('한 번도 안 봤으면 본다', () => {
    eq(shouldPollNow(null, NOW), true);
  });

  test('주기 안에는 다시 보지 않는다 — 몇 초마다 DB를 두드리지 않는다', () => {
    eq(shouldPollNow(NOW - 10_000, NOW), false);
    eq(shouldPollNow(NOW - POLL_INTERVAL_MS, NOW), true);
  });

  console.log('[예약 폴링 — 두 실행기가 깨워도 주문은 한 번]');

  test('같은 줄을 둘이 동시에 봐도 선점은 하나만 성공한다', () => {
    // 둘 다 due로 고른다 — 그건 정상이다. 갈리는 곳은 선점이다.
    const r = row({ last_run_at: null });
    eq(selectDueSchedules([r], NOW).due.length, 1);
    eq(selectDueSchedules([r], NOW).due.length, 1);
    // 먼저 UPDATE가 닿은 쪽만 1줄을 바꾼다. 나머지는 0줄이다.
    eq(claimVerdict(1).ok, true);
    eq(claimVerdict(0).ok, false);
    eq(claimVerdict(0).code, 'LOST');
  });

  console.log('[예약 폴링 — 주 실행기가 죽으면 화면이 그렇게 말한다]');

  test('Worker heartbeat가 끊기면 STALE이다 — 마지막 결과가 좋아도', () => {
    // 2026-08-13에 워커에 폴링 코드가 배포되지 않았는데 화면은
    // 아무것도 이상하다고 말하지 않았다.
    const s = runtimeStateOf({
      nowMs: NOW, enabled: true,
      lastRunAtMs: NOW - 2 * MIN, lastOutcome: 'NO_SIGNAL',
      runnerLastSeenMs: NOW - 2 * MIN, intervalMin: 15,
      workerLastSeenMs: NOW - 30 * MIN,
    });
    eq(s.state, 'STALE');
    eq(s.tone, 'bad');
    assert(s.reason.includes('Worker'), s.reason);
  });

  test('Worker가 살아 있으면 평소대로 판정한다', () => {
    const s = runtimeStateOf({
      nowMs: NOW, enabled: true,
      lastRunAtMs: NOW - 2 * MIN, lastOutcome: 'NO_SIGNAL',
      runnerLastSeenMs: NOW - 2 * MIN, intervalMin: 15,
      workerLastSeenMs: NOW - 10_000,
    });
    eq(s.state, 'WATCHING');
  });

  test('Worker heartbeat를 못 읽었으면 죽었다고도 살았다고도 하지 않는다', () => {
    const s = runtimeStateOf({
      nowMs: NOW, enabled: true,
      lastRunAtMs: NOW - 2 * MIN, lastOutcome: 'NO_SIGNAL',
      runnerLastSeenMs: NOW - 2 * MIN, intervalMin: 15,
      workerLastSeenMs: null,
    });
    eq(s.workerStale, null);
    eq(s.state, 'WATCHING', '못 읽은 것을 죽음으로 읽었다');
  });

  test('재배포로 잠깐 끊긴 것과 죽은 것을 가른다', () => {
    assert(WORKER_STALE_MS >= 120_000, '유예가 너무 짧으면 재배포마다 빨강이 된다');
    assert(WORKER_STALE_MS <= 600_000, '유예가 너무 길면 죽은 워커를 못 본다');
  });
}
