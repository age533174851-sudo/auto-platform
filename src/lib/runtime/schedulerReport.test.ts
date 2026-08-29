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
  STALE_POLL_FLOOR_MS, type SchedulerReport,
} from './schedulerReport';

const NOW = 1_800_000_000_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const ok: SchedulerReport = {
  hasAppUrl: true, hasAdminSecret: true, isMain: true,
  pollIntervalMs: 60_000, lastPollIso: at(20_000),
  lastDueCount: 0, lastSkippedCount: 3,
  lastEvalIso: at(3_600_000), lastEvalSymbol: 'BTC_USDT', lastEvalOutcome: 'NO_ENTRY',
  lastErrorIso: null, lastError: null, pollCount: 400, evalCount: 12,
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
    const v = schedulerVerdict({ report: { ...ok, lastDueCount: 0, lastEvalIso: null, lastEvalSymbol: null, lastEvalOutcome: null }, workerAlive: true, nowMs: NOW });
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
      report: { ...ok, lastErrorIso: at(10_000), lastError: '예약을 읽지 못했습니다: timeout' },
      workerAlive: true, nowMs: NOW,
    });
    eq(v.code, 'WORKER_PRESENT_BUT_RUNTIME_BROKEN');
    assert(/timeout/.test(v.reason), v.reason);
  });

  test('오래된 오류 뒤에 성공한 폴링이 있으면 돈다고 말한다', () => {
    const v = schedulerVerdict({
      report: { ...ok, lastErrorIso: at(600_000), lastError: '한때 실패', lastPollIso: at(20_000) },
      workerAlive: true, nowMs: NOW,
    });
    eq(v.code, 'WORKER_PRIMARY_ACTIVE');
    assert(v.evidence.some(e => /한때 실패/.test(e)), '오류는 지우지 않고 근거에 남긴다');
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

  test('숫자가 아닌 칸은 0이 아니라 모름이다', () => {
    const p = parseSchedulerReport({ ...ok, lastDueCount: null, pollCount: undefined });
    eq(p?.lastDueCount, null);
    eq(p?.pollCount, null);
  });
}
