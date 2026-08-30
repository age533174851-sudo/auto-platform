// src/lib/runtime/schedulerReport.test.ts
//
// **"확인 불가"가 나오는 자리를 시험으로 못 박는다.**
//
// 2026-08-29에 "Fly Worker 예약 폴러가 실제로 도는가"에 답하려다 세 가지가
// 전부 막혔다: 로그는 사람이 열어야 하고, DB는 CI가 못 읽고,
// runtime-health는 로그인이 필요하다. 판정은 INSUFFICIENT_EVIDENCE로 끝났다.
//
// 그래서 워커가 스스로 적게 했다. 이 시험이 지키는 것은 하나다 —
// **모르는 것을 돈다고 적지 않고, 안 도는 것을 모른다고 적지 않는다.**

import { test, eq, assert } from '../../test/harness';
import {
  schedulerVerdict, parseSchedulerReport, pickSchedulerRow,
  mergeSchedulerReport, EMPTY_SCHEDULER_REPORT, SCHEDULER_ERROR_CODES,
  STALE_POLL_FLOOR_MS, type SchedulerReport,
} from './schedulerReport';

const NOW = 1_800_000_000_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const ok: SchedulerReport = {
  hasAppUrl: true, hasAdminSecret: true, isMain: true,
  pollIntervalMs: 60_000, lastPollIso: at(20_000),
  lastDueCount: 0, lastSkippedCount: 3,
  lastEvalIso: at(3_600_000),
  lastErrorIso: null, lastErrorCode: null, pollCount: 400, evalCount: 12,
  source: 'FLY_WORKER',
};

export function runSchedulerReportTests() {
  console.log('[예약 주 경로 — 사람이 fly logs를 안 열어도 된다]');

  test('설정·락·최근 폴링이 다 있으면 주 경로가 돈다고 말한다', () => {
    const v = schedulerVerdict({ report: ok, workerAlive: true, heartbeatAgeSec: 2, nowMs: NOW });
    eq(v.code, 'WORKER_PRIMARY_ACTIVE');
    assert(v.evidence.some(e => /APP_URL 있음/.test(e)), v.evidence.join(' | '));
  });

  test('due 0건은 **안 돈다가 아니다** — 볼 예약이 없었을 뿐이다', () => {
    const v = schedulerVerdict({ report: { ...ok, lastDueCount: 0, lastEvalIso: null }, workerAlive: true, nowMs: NOW });
    eq(v.code, 'WORKER_PRIMARY_ACTIVE');
  });

  test('칸을 못 읽은 것을 고장으로 적지 않는다', () => {
    eq(schedulerVerdict({ report: undefined, workerAlive: true, nowMs: NOW }).code, 'INSUFFICIENT_EVIDENCE');
  });

  test('워커가 적은 적이 없는 것도 고장이 아니다 — 모르는 것이다', () => {
    eq(schedulerVerdict({ report: null, workerAlive: true, nowMs: NOW }).code, 'INSUFFICIENT_EVIDENCE');
  });

  test('APP_URL이 없으면 미배선이지 고장이 아니다', () => {
    const v = schedulerVerdict({ report: { ...ok, hasAppUrl: false }, workerAlive: true, nowMs: NOW });
    eq(v.code, 'WORKER_PRESENT_BUT_CONFIG_BLOCKED');
    assert(/APP_URL/.test(v.reason), v.reason);
  });

  test('ADMIN_SECRET이 없어도 미배선으로 읽고, 이름만 적는다', () => {
    const v = schedulerVerdict({ report: { ...ok, hasAdminSecret: false }, workerAlive: true, nowMs: NOW });
    eq(v.code, 'WORKER_PRESENT_BUT_CONFIG_BLOCKED');
    assert(/ADMIN_SECRET/.test(v.reason), v.reason);
  });

  test('유무를 안 적었으면 있다고도 없다고도 읽지 않는다', () => {
    const v = schedulerVerdict({ report: { ...ok, hasAppUrl: null }, workerAlive: true, nowMs: NOW });
    eq(v.code, 'INSUFFICIENT_EVIDENCE');
  });

  test('설정은 갖췄는데 한 번도 안 봤으면 고장이다', () => {
    const v = schedulerVerdict({ report: { ...ok, lastPollIso: null }, workerAlive: true, nowMs: NOW });
    eq(v.code, 'WORKER_PRESENT_BUT_RUNTIME_BROKEN');
  });

  test('**방금 뜬 워커를 고장이라고 적지 않는다** — 첫 폴링 전이다', () => {
    const v = schedulerVerdict({
      report: { ...ok, lastPollIso: null }, workerAlive: true,
      workerStartedIso: at(30_000), nowMs: NOW,
    });
    eq(v.code, 'INSUFFICIENT_EVIDENCE');
    assert(/첫 예약 폴링 전/.test(v.reason), v.reason);
  });

  test('뜬 지 한참 됐는데 한 번도 안 봤으면 그건 고장이다', () => {
    const v = schedulerVerdict({
      report: { ...ok, lastPollIso: null }, workerAlive: true,
      workerStartedIso: at(3_600_000), nowMs: NOW,
    });
    eq(v.code, 'WORKER_PRESENT_BUT_RUNTIME_BROKEN');
  });

  test('폴링이 주기의 다섯 배 넘게 밀리면 멈춘 것으로 본다', () => {
    const v = schedulerVerdict({
      report: { ...ok, lastPollIso: at(STALE_POLL_FLOOR_MS + 60_000) }, workerAlive: true, nowMs: NOW,
    });
    eq(v.code, 'WORKER_PRESENT_BUT_RUNTIME_BROKEN');
    assert(/멈춰/.test(v.reason), v.reason);
  });

  test('마지막 폴링이 오류로 끝났으면 초록으로 넘기지 않는다', () => {
    const v = schedulerVerdict({
      report: { ...ok, lastErrorIso: at(10_000), lastErrorCode: 'SCHEDULE_READ_FAILED' },
      workerAlive: true, nowMs: NOW,
    });
    eq(v.code, 'WORKER_PRESENT_BUT_RUNTIME_BROKEN');
    assert(/SCHEDULE_READ_FAILED/.test(v.reason), v.reason);
  });

  test('오래된 오류 뒤에 성공한 폴링이 있으면 돈다고 말한다', () => {
    const v = schedulerVerdict({
      report: { ...ok, lastErrorIso: at(600_000), lastErrorCode: 'EVALUATION_FAILED', lastPollIso: at(20_000) },
      workerAlive: true, nowMs: NOW,
    });
    eq(v.code, 'WORKER_PRIMARY_ACTIVE');
    assert(v.evidence.some(e => /EVALUATION_FAILED/.test(e)), '오류는 지우지 않고 근거에 남긴다');
  });

  test('heartbeat가 끊겼으면 예약도 안 도는 것이다', () => {
    const v = schedulerVerdict({ report: ok, workerAlive: false, nowMs: NOW });
    eq(v.code, 'WORKER_PRESENT_BUT_RUNTIME_BROKEN');
  });

  test('살아 있는지 모르면 돈다고 적지 않는다', () => {
    eq(schedulerVerdict({ report: ok, workerAlive: null, nowMs: NOW }).code, 'INSUFFICIENT_EVIDENCE');
  });

  test('예비 워커만 보고했으면 주 경로를 봤다고 하지 않는다', () => {
    const v = schedulerVerdict({ report: { ...ok, isMain: false }, workerAlive: true, nowMs: NOW });
    eq(v.code, 'INSUFFICIENT_EVIDENCE');
    eq(v.standbyOnly, true);
  });

  // ── 한 워커의 사실과 다른 워커의 사실을 섞지 않는다 ──
  //
  // 보고는 main 락을 쥔 줄에서 고르면서 생존 여부만 가장 최근 줄에서
  // 계산하면, **죽은 main 워커가 살아 있는 예비 워커의 생존 신호를 빌려
  // 쓴다.** 폴링 허용치(최대 5분) 안에서 초록이 나온다 — 그동안 아무도
  // 예약을 보고 있지 않은데도.

  test('**죽은 main + 살아 있는 예비**를 섞어 ACTIVE로 읽지 않는다', () => {
    const deadMain = { worker_id: 'A', last_seen: at(3_600_000), scheduler: { ...ok, isMain: true, lastPollIso: at(60_000) } };
    const freshStandby = { worker_id: 'B', last_seen: at(2_000), scheduler: { ...ok, isMain: false } };
    // 응답 순서는 last_seen 내림차순이라 예비가 먼저 온다.
    const picked = pickSchedulerRow([freshStandby, deadMain]);
    eq((picked.row as any).worker_id, 'A');          // 보고는 main 줄에서 고른다

    // 라우트가 하는 것과 같은 계산: **고른 줄의 heartbeat로** 생존을 본다.
    const seenMs = Date.parse(String((picked.row as any).last_seen));
    const v = schedulerVerdict({
      report: parseSchedulerReport((picked.row as any).scheduler),
      workerAlive: NOW - seenMs < 120_000,           // 한 시간 전 → false
      heartbeatAgeSec: Math.round((NOW - seenMs) / 1000),
      standbyOnly: picked.standbyOnly, nowMs: NOW,
    });
    assert(v.code !== 'WORKER_PRIMARY_ACTIVE', `죽은 main을 ACTIVE로 읽었습니다: ${v.code}`);
    eq(v.code, 'WORKER_PRESENT_BUT_RUNTIME_BROKEN');
  });

  test('고른 main이 살아 있고 폴링도 최근이면 ACTIVE가 유지된다', () => {
    const staleStandby = { worker_id: 'B', last_seen: at(3_600_000), scheduler: { ...ok, isMain: false } };
    const liveMain = { worker_id: 'A', last_seen: at(2_000), scheduler: { ...ok, isMain: true, lastPollIso: at(20_000) } };
    const picked = pickSchedulerRow([liveMain, staleStandby]);
    eq((picked.row as any).worker_id, 'A');
    const seenMs = Date.parse(String((picked.row as any).last_seen));
    const v = schedulerVerdict({
      report: parseSchedulerReport((picked.row as any).scheduler),
      workerAlive: NOW - seenMs < 120_000,
      heartbeatAgeSec: Math.round((NOW - seenMs) / 1000),
      standbyOnly: picked.standbyOnly, nowMs: NOW,
    });
    eq(v.code, 'WORKER_PRIMARY_ACTIVE');
  });

  test('머신이 둘이면 **main 락을 쥔 줄**을 고른다', () => {
    const standby = { scheduler: { ...ok, isMain: false } };
    const main = { scheduler: { ...ok, isMain: true } };
    const picked = pickSchedulerRow([standby, main]);
    eq(parseSchedulerReport(picked.row?.scheduler)?.isMain, true);
    eq(picked.standbyOnly, false);
  });

  test('아무도 main이 아니면 예비라고 적는다', () => {
    const picked = pickSchedulerRow([{ scheduler: { ...ok, isMain: false } }]);
    eq(picked.standbyOnly, true);
  });

  test('줄이 하나도 없으면 없다고 말한다', () => {
    const picked = pickSchedulerRow([]);
    eq(picked.row, null);
  });

  test('문자열 JSON도 읽고, 형식이 아니면 null이다', () => {
    eq(parseSchedulerReport(JSON.stringify(ok))?.isMain, true);
    eq(parseSchedulerReport('{'), null);
    eq(parseSchedulerReport(null), null);
    eq(parseSchedulerReport([1, 2]), null);
  });

  // ── 관측 장치는 본업보다 약해야 한다 ──
  //
  // 이 병합이 던지면 예약 평가도 주문 실행도 생존 신호도 같이 멈춘다.
  // **고장을 보려고 만든 것이 고장을 만들면 안 된다.**

  test('무엇이 들어와도 병합은 던지지 않는다 — 이전 상태가 남는다', () => {
    const weird: any[] = [null, undefined, 'x', 7, [], true, { get isMain() { throw new Error('boom'); } }];
    for (const w of weird) {
      const out = mergeSchedulerReport(ok, w);
      assert(out != null && typeof out === 'object', '입력에서 무너졌습니다');
      eq(out.source, 'FLY_WORKER');
    }
  });

  test('이전 상태가 없어도 빈 보고에서 출발한다', () => {
    eq(mergeSchedulerReport(null, { isMain: true }).isMain, true);
    eq(mergeSchedulerReport(undefined, null).lastPollIso, EMPTY_SCHEDULER_REPORT.lastPollIso);
  });

  test('부분 갱신이다 — **한쪽이 다른 쪽을 지우지 않는다**', () => {
    const after = mergeSchedulerReport(ok, { isMain: false });
    eq(after.isMain, false);
    eq(after.lastPollIso, ok.lastPollIso);
    eq(after.hasAppUrl, true);
  });

  test('모르는 칸 이름은 무시한다 — 보고 형식이 마음대로 늘지 않는다', () => {
    const after: any = mergeSchedulerReport(ok, { lastEvalSymbol: 'BTC_USDT' } as any);
    eq(after.lastEvalSymbol, undefined);
  });

  // ── 공개 경로로 값이 새지 않는다 ──

  // **가리개가 아니라 목록이 방어선이다.**
  //
  // 예외 문구를 정규식으로 가리는 것은 방어가 아니라 추측이다 — 무엇이
  // 섞여 들어올지 미리 알 수 없다. 미리 정한 코드만 통과시킨다.

  test('임의 문자열은 공개 보고에 남지 않는다 — UNKNOWN으로 접힌다', () => {
    const leaky = [
      'fetch failed: https://my-app.vercel.app/api/autotrade/evaluate 502',
      'user age533174851@gmail.com not permitted',
      'duplicate key value violates unique constraint "paper_positions_pkey"',
      `unauthorized: ${'X'.repeat(28)}`,
      'connection_id 3f2a-9b user_id 77 account 12345',
      'ETIMEDOUT 10.0.0.4:5432',
    ];
    for (const raw of leaky) {
      const merged = mergeSchedulerReport(ok, { lastErrorCode: raw as any });
      eq(merged.lastErrorCode, 'UNKNOWN');
      const parsed = parseSchedulerReport({ ...ok, lastErrorCode: raw });
      eq(parsed?.lastErrorCode, 'UNKNOWN');
      // 근거 줄에도 원문이 실리면 안 된다.
      const v = schedulerVerdict({ report: parsed, workerAlive: true, nowMs: NOW });
      const printed = [v.reason, ...v.evidence].join(' | ');
      assert(!printed.includes(raw), `근거에 원문이 실렸습니다: ${printed}`);
    }
  });

  test('073 이전 형식의 예외 문구는 사실만 남기고 문구는 버린다', () => {
    const legacy = parseSchedulerReport({
      ...ok, lastErrorCode: undefined,
      lastError: '평가 실패: https://app.example.com/x', lastErrorIso: at(1000),
    });
    eq(legacy?.lastErrorCode, 'UNKNOWN');            // 오류가 있었다는 사실은 남는다
    eq((legacy as any)?.lastError, undefined);       // 문구는 형식에 없다
  });

  test('아는 코드는 그대로 통과한다', () => {
    for (const c of SCHEDULER_ERROR_CODES) {
      eq(parseSchedulerReport({ ...ok, lastErrorCode: c })?.lastErrorCode, c);
    }
  });

  test('보고에는 종목·결과·자격·예외문구 칸이 아예 없다', () => {
    const denied = ['lastEvalSymbol', 'lastEvalOutcome', 'userId', 'user_id', 'accountId',
      'connectionId', 'apiKey', 'secret', 'fingerprint', 'appUrl', 'adminSecret',
      'lastError', 'error', 'message', 'detail', 'stack'];
    const keys = Object.keys(EMPTY_SCHEDULER_REPORT);
    for (const d of denied) assert(!keys.includes(d), `${d}가 공개 보고에 들어 있습니다`);
    eq(keys.includes('hasAppUrl'), true);
  });

  test('숫자가 아닌 칸은 0이 아니라 모름이다', () => {
    const p = parseSchedulerReport({ ...ok, lastDueCount: null, pollCount: undefined });
    eq(p?.lastDueCount, null);
    eq(p?.pollCount, null);
  });
}
