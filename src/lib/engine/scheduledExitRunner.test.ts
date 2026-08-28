// src/lib/engine/scheduledExitRunner.test.ts
//
// **"이 시각에 팔겠다"를 지킬 실행기가 있는가 — 근거로 답하는가.**
//
// 화면은 이걸 하드코딩 true 세 개로 답하고 있었다. 아무것도 확인하지
// 않고 "앱을 닫아도 제 시각에 나갑니다"를 적었고, 그 약속은 사실이
// 아니었다. 여기서 그 자리를 못 박는다.
import { test, eq, assert } from '../../test/harness';
import { scheduledExitRunnerOf, overdueExitsOf, WORKER_FRESH_MS } from './scheduledExitRunner';
import { DEFAULT_GRACE_MS } from './scheduleExit';

const MIN = 60_000;
const NOW = Date.parse('2026-08-28T12:00:00Z');

export function runScheduledExitRunnerTests() {
  console.log('\n🧪 예약청산 실행기 (제 시각에 나간다고 함부로 적지 않는다)');

  // ══ 워커가 살아 있으면 브라우저 없이 나간다 ══
  test('워커 신호가 최근이면 앱을 닫아도 나간다고 말할 수 있다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: NOW - 30_000, overdue: 0, nowMs: NOW, appOpen: false,
    });
    eq(v.code, 'WORKER');
    eq(v.browserFree, true);
    eq(v.canBeOnTime, true);
  });

  test('워커 신호가 끊기면 앱을 닫으면 안 나간다고 말한다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: NOW - 30 * MIN, overdue: 0, nowMs: NOW, appOpen: false,
    });
    eq(v.code, 'WORKER_STALE');
    eq(v.browserFree, false);
    eq(v.canBeOnTime, false);
  });

  test('워커가 끊겨도 앱이 열려 있으면 그 사실을 정확히 말한다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: NOW - 30 * MIN, overdue: 0, nowMs: NOW, appOpen: true,
    });
    eq(v.code, 'BROWSER_ONLY');
    eq(v.browserFree, false);
    assert(v.text.includes('앱을 닫거나'), `무엇이 위험한지 말한다 — ${v.text}`);
  });

  // ══ 모르는 것을 "나간다"로도 "안 나간다"로도 적지 않는다 ══
  test('워커 상태를 못 읽었으면 확인하지 못했다고 말한다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: null, overdue: 0, nowMs: NOW, appOpen: true,
    });
    eq(v.code, 'UNKNOWN');
    eq(v.canBeOnTime, false);
    assert(v.text.includes('확인하지 못했습니다'), `모른다고 말한다 — ${v.text}`);
  });

  // ══ **증거가 보고를 이긴다** ══
  test('놓친 예약이 있으면 워커가 살아 있어도 "제 시각에 나간다"고 하지 않는다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: NOW - 10_000, overdue: 2, nowMs: NOW, appOpen: true,
    });
    // 워커는 살아 있다고 보고됐지만, 실제로 놓친 것이 있다.
    eq(v.code, 'WORKER');
    eq(v.canBeOnTime, false);
    assert(v.text.includes('2건'), `몇 건인지 말한다 — ${v.text}`);
    assert(v.text.includes('자동으로 나가지 않습니다'), '무슨 일이 일어났는지 말한다');
  });

  test('놓친 예약을 못 셌으면(null) 0건으로 읽지 않는다', () => {
    const v = scheduledExitRunnerOf({
      workerLastSeenMs: NOW - 10_000, overdue: null, nowMs: NOW, appOpen: false,
    });
    // **못 센 것을 "놓친 것 없음"으로 바꾸지 않는다.**
    eq(v.overdue, null);
    eq(v.code, 'WORKER');
  });

  test('워커 신선도 경계에서 뒤집힌다', () => {
    const at = (lag: number) => scheduledExitRunnerOf({
      workerLastSeenMs: NOW - lag, overdue: 0, nowMs: NOW, appOpen: false,
    }).code;
    eq(at(WORKER_FRESH_MS), 'WORKER');
    eq(at(WORKER_FRESH_MS + 1), 'WORKER_STALE');
  });

  // ══ 놓친 예약 세기 ══
  test('유예를 넘긴 살아 있는 예약만 센다', () => {
    const rows = [
      { run_at: new Date(NOW - 90 * MIN).toISOString() },                       // 놓쳤다
      { run_at: new Date(NOW - 10 * MIN).toISOString() },                       // 아직 유예 안
      { run_at: new Date(NOW + 60 * MIN).toISOString() },                       // 미래
      { run_at: new Date(NOW - 90 * MIN).toISOString(), fired_at: 'x' },        // 이미 쐈다
      { run_at: new Date(NOW - 90 * MIN).toISOString(), cancelled_at: 'x' },    // 취소했다
      { run_at: new Date(NOW - 90 * MIN).toISOString(), enabled: false },       // 꺼 뒀다
    ];
    eq(overdueExitsOf(rows, NOW, DEFAULT_GRACE_MS), 1);
  });

  test('목록을 못 읽었으면 0이 아니라 null이다', () => {
    // **0으로 세면 실행기가 죽어 있어도 화면이 초록이 된다.**
    eq(overdueExitsOf(null, NOW, DEFAULT_GRACE_MS), null);
    eq(overdueExitsOf(undefined, NOW, DEFAULT_GRACE_MS), null);
    eq(overdueExitsOf([], NOW, DEFAULT_GRACE_MS), 0);
  });

  test('유예 경계에서 세는 기준이 바뀐다', () => {
    const at = (ago: number) => overdueExitsOf(
      [{ run_at: new Date(NOW - ago).toISOString() }], NOW, DEFAULT_GRACE_MS);
    eq(at(DEFAULT_GRACE_MS), 0);
    eq(at(DEFAULT_GRACE_MS + 1), 1);
  });

  test('시각을 못 읽은 줄은 놓친 것으로 세지 않는다', () => {
    eq(overdueExitsOf([{ run_at: 'not-a-date' }], NOW, DEFAULT_GRACE_MS), 0);
  });

  // ══ 실행 주기가 유예 안에 들어오는가 ══
  test('워커 주기(60초)는 유예(30분) 안에 충분히 들어온다', () => {
    // GitHub 예약은 실측 중앙값 50분이라 유예를 넘겼다. 그게 이 작업의 이유다.
    const workerIntervalMs = 60_000;
    assert(workerIntervalMs * 2 < DEFAULT_GRACE_MS,
      '실행 주기가 유예의 절반보다 짧아야 한 회차를 놓쳐도 유예 안에 들어온다');
  });
}
