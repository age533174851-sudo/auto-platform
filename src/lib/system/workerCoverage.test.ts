// src/lib/system/workerCoverage.test.ts
//
// **"Fly를 끄면 무엇이 멈추는가"의 답을 고정한다.**
//
// 이 시험이 막는 것은 숫자 하나가 아니라 **거짓 안심**이다.
// 손절 감시가 5분에서 24시간으로 늘어난 것을 "Vercel cron에 있으니
// 대체됐다"고 적는 순간, 100배 포지션이 하루 동안 감시 없이 남는다.

import { test, eq, assert } from '../../test/harness';
import {
  cronEveryMs, coverageRow, coverage, flyRetirementBlockers, flyRetirable,
  killSwitchExecutionPath,
  type WorkerTask, type VercelCron,
} from './workerCoverage';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function runWorkerCoverageTests() {
  console.log('[Worker 대체 범위 — Fly를 끄면 무엇이 멈추는가]');

  // ── ① cron 환산 ──
  test('하루 1회 cron은 24시간으로 환산된다', () => {
    eq(cronEveryMs('0 0 * * *'), DAY);
    eq(cronEveryMs('0 23 * * *'), DAY);
    eq(cronEveryMs('30 3 * * *'), DAY);
  });

  test('*/N 분 cron은 N분으로 환산된다', () => {
    eq(cronEveryMs('*/5 * * * *'), 5 * MIN);
    eq(cronEveryMs('*/1 * * * *'), MIN);
  });

  test('매시 cron은 1시간으로 환산된다', () => {
    eq(cronEveryMs('0 * * * *'), HOUR);
    eq(cronEveryMs('37 * * * *'), HOUR);
  });

  test('N시간마다 cron은 N시간으로 환산된다', () => {
    eq(cronEveryMs('0 */4 * * *'), 4 * HOUR);
  });

  test('★ 환산할 수 없는 cron은 null이다 — 0으로 적지 않는다', () => {
    // 요일·날짜가 걸리면 하루보다 긴 주기다. 추측하지 않는다.
    eq(cronEveryMs('0 9 * * 1'), null);
    eq(cronEveryMs('0 9 1 * *'), null);
    eq(cronEveryMs('0 9 * 3 *'), null);
    // 모양이 아예 아닌 것
    eq(cronEveryMs(''), null);
    eq(cronEveryMs('0 0 * *'), null);
    eq(cronEveryMs('말도 안 되는 값'), null);
    // null/undefined가 0이 되지 않는다
    eq(cronEveryMs(null as unknown as string), null);
    eq(cronEveryMs(undefined as unknown as string), null);
  });

  // **이 시험은 변이가 살아남아서 추가됐다.**
  //
  // 위 시험의 입력은 전부 `cronEveryMs`의 **앞쪽 가드**에서 끝난다
  // (칸 수가 틀리거나, 날짜·월·요일이 걸리거나). 그래서 함수 **맨 끝의
  // `return null`은 한 번도 실행되지 않았고**, 그 줄을 `return 0`으로
  // 바꿔도 7287개가 전부 통과했다. 아래 입력만이 그 줄에 도달한다.
  test('★ 분·시 모양을 못 읽는 cron도 null이다 (맨 끝 분기)', () => {
    // 칸 수·날짜·요일은 정상이라 앞쪽 가드를 통과하고, 분이 범위라
    // 어떤 패턴에도 안 맞아 맨 끝까지 내려간다.
    eq(cronEveryMs('1-5 * * * *'), null);
    eq(cronEveryMs('0,30 * * * *'), null);
    eq(cronEveryMs('*/5 */2 * * *'), null);
    eq(cronEveryMs('* * * * *'), null);
  });

  // ── ② 대체 판정 ──
  const crons: VercelCron[] = [
    { schedule: '0 23 * * *', path: '/api/autotrade/daily-ladder' },
    { schedule: '0 0 * * *', path: '/api/autotrade/exit-monitor' },
    { schedule: '0 1 * * *', path: '/api/autotrade/scheduled-exit' },
  ];

  const task = (o: Partial<WorkerTask>): WorkerTask => ({
    fn: 'pollX', everyMs: MIN, endpoint: '/api/x', role: '역할',
    safetyCritical: true, ...o,
  });

  test('★ 5분 감시가 하루 1회가 되면 DEGRADED다 — 288배', () => {
    const r = coverageRow(
      task({ fn: 'pollExitMonitor', everyMs: 5 * MIN, endpoint: '/api/autotrade/exit-monitor' }),
      crons,
    );
    eq(r.substitute, 'DEGRADED');
    eq(r.flyEveryMs, 5 * MIN);
    eq(r.vercelEveryMs, DAY);
    eq(Math.round(r.factor as number), 288);
  });

  test('★ 1분 예약 청산이 하루 1회가 되면 1440배다', () => {
    const r = coverageRow(
      task({ fn: 'pollScheduledExit', everyMs: MIN, endpoint: '/api/autotrade/scheduled-exit' }),
      crons,
    );
    eq(r.substitute, 'DEGRADED');
    eq(Math.round(r.factor as number), 1440);
  });

  test('cron이 아예 없으면 NONE이고 배수는 null이다', () => {
    const r = coverageRow(task({ endpoint: '/api/paper/exit-monitor' }), crons);
    eq(r.substitute, 'NONE');
    eq(r.vercelEveryMs, null);
    eq(r.factor, null);
    assert(r.reason.includes('아무도 깨우지 않습니다'), '이유에 결과가 적혀야 한다');
  });

  test('DB를 직접 보는 작업은 깨울 경로가 없어 NONE이다', () => {
    const r = coverageRow(task({ fn: 'pollSchedules', endpoint: null }), crons);
    eq(r.substitute, 'NONE');
    eq(r.vercelEveryMs, null);
    eq(r.factor, null);
  });

  test('주기가 2배 안이면 EQUIVALENT다', () => {
    const r = coverageRow(
      task({ everyMs: 12 * HOUR, endpoint: '/api/autotrade/exit-monitor' }),
      crons,
    );
    eq(r.substitute, 'EQUIVALENT');
  });

  test('★ 환산 불가 cron은 UNKNOWN이고 EQUIVALENT가 아니다', () => {
    const r = coverageRow(
      task({ endpoint: '/api/weekly' }),
      [{ schedule: '0 9 * * 1', path: '/api/weekly' }],
    );
    eq(r.substitute, 'UNKNOWN');
    eq(r.factor, null);
  });

  test('매 tick 작업은 비교 기준이 없어 UNKNOWN이다', () => {
    const r = coverageRow(
      task({ everyMs: null, endpoint: '/api/autotrade/exit-monitor' }),
      crons,
    );
    eq(r.substitute, 'UNKNOWN');
    eq(r.factor, null);
  });

  // ── ②-b 깨우는 쪽이 여럿일 때 ──
  //
  // **이 시험은 제 분석이 틀렸기 때문에 추가됐다.**
  // 처음에는 `vercel.json`만 보고 손절 감시를 "288배 악화"로 보고했다.
  // 그런데 Vercel Hobby는 일 단위 cron만 허용하고, 분 단위로 깨우는 일은
  // 이미 **GitHub Actions의 schedule**이 하고 있었다(`exit-monitor.yml`
  // `7 * * * *`). 실제 악화는 12배다. 한쪽만 보면 **이미 있는 대체를
  // 없다고 적는다.**
  test('★ 같은 경로를 여럿이 깨우면 가장 자주 도는 것이 답이다', () => {
    const r = coverageRow(
      task({ fn: 'pollExitMonitor', everyMs: 5 * MIN, endpoint: '/api/autotrade/exit-monitor' }),
      [
        { schedule: '0 0 * * *', path: '/api/autotrade/exit-monitor', source: 'vercel.json' },
        { schedule: '7 * * * *', path: '/api/autotrade/exit-monitor', source: 'actions' },
      ],
    );
    eq(r.vercelEveryMs, HOUR);        // 1일이 아니라 1시간
    eq(Math.round(r.factor as number), 12);  // 288배가 아니라 12배
    assert(r.reason.includes('actions'), '어느 쪽이 깨우는지 적어야 한다');
  });

  test('순서가 뒤바뀌어도 가장 자주 도는 것을 집는다', () => {
    const r = coverageRow(
      task({ everyMs: MIN, endpoint: '/api/x' }),
      [
        { schedule: '*/5 * * * *', path: '/api/x', source: 'fast' },
        { schedule: '0 0 * * *', path: '/api/x', source: 'slow' },
      ],
    );
    eq(r.vercelEveryMs, 5 * MIN);
    assert(r.reason.includes('fast'), '빠른 쪽이 답이어야 한다');
  });

  test('환산 불가 cron은 환산 가능한 것보다 뒤로 밀린다', () => {
    const r = coverageRow(
      task({ everyMs: MIN, endpoint: '/api/x' }),
      [
        { schedule: '0 9 * * 1', path: '/api/x', source: 'weekly' },
        { schedule: '*/5 * * * *', path: '/api/x', source: 'fast' },
      ],
    );
    eq(r.vercelEveryMs, 5 * MIN);
    eq(r.substitute, 'DEGRADED');
  });

  // ── ③ Fly를 끌 수 있는가 ──
  test('★ 안전상 필수가 EQUIVALENT가 아니면 Fly를 끌 수 없다', () => {
    const rows = coverage([
      task({ fn: 'a', everyMs: 5 * MIN, endpoint: '/api/autotrade/exit-monitor' }),
    ], crons);
    eq(flyRetirable(rows), false);
    eq(flyRetirementBlockers(rows).length, 1);
  });

  test('★ UNKNOWN도 Fly 종료를 막는다 — 확인 못 한 것은 통과가 아니다', () => {
    const rows = coverage([
      task({ fn: 'a', endpoint: '/api/weekly' }),
    ], [{ schedule: '0 9 * * 1', path: '/api/weekly' }]);
    eq(rows[0].substitute, 'UNKNOWN');
    eq(flyRetirable(rows), false);
  });

  test('안전상 필수가 아닌 작업은 Fly 종료를 막지 않는다', () => {
    const rows = coverage([
      task({ fn: 'ledger', safetyCritical: false, endpoint: '/api/ledger/sync' }),
    ], crons);
    eq(rows[0].substitute, 'NONE');
    eq(flyRetirable(rows), true);
  });

  test('전부 EQUIVALENT면 끌 수 있다', () => {
    const rows = coverage([
      task({ fn: 'a', everyMs: 12 * HOUR, endpoint: '/api/autotrade/exit-monitor' }),
    ], crons);
    eq(flyRetirable(rows), true);
    eq(flyRetirementBlockers(rows).length, 0);
  });

  test('빈 입력에서 터지지 않는다', () => {
    eq(coverage([], []).length, 0);
    eq(flyRetirable([]), true);
    eq(coverage(null as unknown as WorkerTask[], null as unknown as VercelCron[]).length, 0);
  });

  // ── 정정: "Fly가 없으면 킬스위치가 아예 실행되지 않는다"는 과장이었다 ──
  //
  // 이 시험이 막는 것은 **두 방향의 거짓**이다.
  //   · 없는 위험을 있다고 적는 것 (멈추지 않는데 멈춘다고 보고)
  //   · 모르는 것을 안전하다고 적는 것 (확인 못 했는데 안 멈춘다고 보고)
  // 둘 다 같은 규칙 위반이다 — 확인한 것만 적는다.
  console.log('[킬스위치 실행 경로 — Fly를 끄면 실행 자체가 멈추는가]');

  test('라우트가 직접 실행하고 큐에 외부 생산자가 없으면 큐는 자가복구 그물이다', () => {
    const v = killSwitchExecutionPath({
      enqueueCallers: 0, externalQueueProducers: 0, routesExecuteInline: true,
    });
    eq(v.path, 'INLINE');
    eq(v.queueIsSelfHealOnly, true);
    eq(v.stopsAllExecution, false, '★ 멈추지 않는데 멈춘다고 적었다');
    assert(v.reason.includes('자가복구'), v.reason);
  });

  test('큐에 외부 생산자가 생기면 같은 문장을 더 쓰지 않는다', () => {
    const v = killSwitchExecutionPath({
      enqueueCallers: 2, externalQueueProducers: 1, routesExecuteInline: true,
    });
    eq(v.path, 'BOTH');
    eq(v.queueIsSelfHealOnly, false);
    eq(v.stopsAllExecution, false);
    assert(v.reason.includes('3곳'), v.reason);
  });

  test('직접 실행이 없고 큐로만 실행되면 끄면 정말 멈춘다', () => {
    const v = killSwitchExecutionPath({
      enqueueCallers: 1, externalQueueProducers: 0, routesExecuteInline: false,
    });
    eq(v.path, 'QUEUE');
    eq(v.stopsAllExecution, true);
  });

  test('실행하는 곳을 하나도 못 찾으면 안전으로 적지 않는다', () => {
    const v = killSwitchExecutionPath({
      enqueueCallers: 0, externalQueueProducers: 0, routesExecuteInline: false,
    });
    eq(v.path, 'UNKNOWN');
    eq(v.stopsAllExecution, null, '★ 실행자가 안 보이는데 안 멈춘다고 적었다');
  });

  test('하나라도 세지 못했으면 UNKNOWN이고 stopsAllExecution은 null이다', () => {
    for (const f of [
      { enqueueCallers: null, externalQueueProducers: 0, routesExecuteInline: true },
      { enqueueCallers: 0, externalQueueProducers: null, routesExecuteInline: true },
      { enqueueCallers: 0, externalQueueProducers: 0, routesExecuteInline: null },
    ]) {
      const v = killSwitchExecutionPath(f as never);
      eq(v.path, 'UNKNOWN');
      eq(v.stopsAllExecution, null, '★ 모르는 것을 0/false로 읽었다');
      eq(v.queueIsSelfHealOnly, false);
    }
    eq(killSwitchExecutionPath(null).path, 'UNKNOWN');
    eq(killSwitchExecutionPath(undefined).stopsAllExecution, null);
  });
}
