#!/usr/bin/env node
// GitHub Actions fallback response contract. Never print the response body or secrets.
// HTTP 200 means the endpoint responded; it does NOT mean a trade was entered or filled.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * **열거된 코드만 통과시킨다.**
 *
 * 이 파일의 규칙은 머리말에 있다 — 응답 본문을 찍지 않는다. 그런데
 * "왜 안 들어갔나"를 보여 주려면 응답에서 뭔가를 꺼내야 한다. 그래서
 * **값이 아니라 모양으로** 거른다: 대문자·숫자·밑줄로 된 짧은 식별자만
 * 통과하고, 그 밖의 것은 전부 `UNSPECIFIED_SHAPE` 한 단어가 된다.
 *
 * 자유 문장(`detail` · `lastEval.line`)은 **꺼내지 않는다.** 그 칸에는
 * 종목·주문 번호·거래소 원문이 들어오고, 이 출력은 공개 로그에 남는다.
 */
const CODE_RE = /^[A-Z][A-Z0-9_]{0,39}$/;
export function safeCode(v) {
  const s = typeof v === 'string' ? v : '';
  return CODE_RE.test(s) ? s : 'UNSPECIFIED_SHAPE';
}

/** 결과 하나의 사유 코드. 건너뜀은 `code`, 평가한 것은 `outcome`이 답한다 */
function reasonOf(r) {
  if (typeof r?.code === 'string' && r.code !== '') return safeCode(r.code);
  if (typeof r?.outcome === 'string' && r.outcome !== '') return safeCode(r.outcome);
  return 'UNSPECIFIED';
}

/**
 * 코드 → 건수. **정렬을 고정한다** — 같은 입력이 같은 줄을 내지 않으면
 * 로그를 회차끼리 비교할 수 없다.
 */
function tally(codes) {
  const m = new Map();
  for (const c of codes) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([code, count]) => ({ code, count }));
}

/**
 * **진입 0건의 이유를 코드별 건수로 센다.**
 *
 * 왜 필요한가: `scheduled=2 checked=2 entryReported=0 failures=0`은
 * 세 회차 연속 같은 줄이었고, 그 줄만으로는 **조건이 안 됐는지 관문이
 * 막았는지 구분할 수 없다.** 답은 이미 응답의 `results[]`에 실려 와
 * 있었고(`code` · `outcome` · `lastEval.reasonCode`) 여기서 버리고 있었다.
 *
 * 이것을 보려고 Fly 로그나 운영 DB를 열어야 한다면 그게 바로
 * `CLAUDE.md`가 없애라고 한 문장이다.
 */
export function tickReasons(body) {
  const rows = Array.isArray(body?.results) ? body.results.filter(object) : [];
  const lastEval = rows
    .map((r) => (object(r.lastEval) && typeof r.lastEval.reasonCode === 'string' && r.lastEval.reasonCode !== ''
      ? safeCode(r.lastEval.reasonCode) : null))
    .filter((c) => c !== null);
  return { outcomes: tally(rows.map(reasonOf)), lastEval: tally(lastEval) };
}

export function tickResponseVerdict(body) {
  const fail = (code) => ({ pass: false, code, scheduled: null, checked: 0, reportedEntries: 0, failures: 0 });
  if (!object(body)) return fail('INVALID_JSON_SHAPE');
  if (body.ok !== true || body.error != null || body.scheduledUnknown === true) {
    return fail('SCHEDULE_READ_OR_SERVER_FAILED');
  }
  if (!Number.isSafeInteger(body.scheduled) || body.scheduled < 0 || !Array.isArray(body.results)) {
    return fail('SCHEDULE_COUNT_UNKNOWN');
  }
  if (body.results.length !== body.scheduled || !body.results.every(object)) {
    return fail('SCHEDULE_RESULT_INCOMPLETE');
  }
  // A schedule evaluation can report ok:true even when its DB state write failed.
  // The cron audit write is separate from the schedule evaluation loop.
  if (body.results.some((r) => r.saveError != null && r.saveError !== '')) {
    return fail('SCHEDULE_STATE_SAVE_FAILED');
  }
  if (body.cronLogError != null && body.cronLogError !== '') {
    return fail('CRON_AUDIT_SAVE_FAILED');
  }
  if (body.results.some((r) => typeof r.ok !== 'boolean')) {
    return fail('EVALUATION_STATUS_UNKNOWN');
  }
  const failures = body.results.filter((r) => r.ok === false).length;
  const reportedEntries = body.results.filter((r) => r.executed === true).length;
  const checked = body.results.length;
  if (failures > 0) {
    return { pass: false, code: 'EVALUATION_FAILURE', scheduled: body.scheduled, checked, reportedEntries, failures };
  }
  if (body.scheduled === 0) {
    return { pass: true, code: 'NO_ENABLED_SCHEDULES', scheduled: 0, checked, reportedEntries, failures };
  }
  return { pass: true, code: reportedEntries > 0 ? 'ENTRY_REPORTED_NOT_FILL_VERIFIED' : 'NO_ENTRY_REPORTED', scheduled: body.scheduled, checked, reportedEntries, failures };
}

// This is a CLI only when run directly; importing it for tests has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let verdict;
  let reasons = null;
  try {
    const path = process.argv[2];
    if (!path) throw new Error('missing body file');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    verdict = tickResponseVerdict(parsed);
    reasons = tickReasons(parsed);
  } catch {
    verdict = { pass: false, code: 'INVALID_OR_MISSING_BODY', scheduled: null, checked: 0, reportedEntries: 0, failures: 0 };
  }
  // Do not print raw HTTP payload, error messages, identifiers or credentials.
  console.log('TRAIGO_TICK ' + verdict.code + ' scheduled=' + (verdict.scheduled ?? 'UNKNOWN') + ' checked=' + verdict.checked + ' entryReported=' + verdict.reportedEntries + ' failures=' + verdict.failures);

  // ── 왜 안 들어갔는가를 **코드별 건수로** 적는다 ──
  //
  // 본문을 찍지 않는다는 규칙은 그대로다 — 위 `safeCode`가 모양으로
  // 거른 열거 코드만 나간다. 자유 문장은 나가지 않는다.
  //
  // 몸통을 못 읽은 회차(`INVALID_OR_MISSING_BODY`)는 셀 것이 없다.
  // 그때 `none`을 적으면 "사유 없음"으로 읽히므로 **UNKNOWN을 적는다** —
  // 확인하지 못한 것은 0이 아니다.
  if (reasons == null) {
    console.log('TRAIGO_TICK_REASONS UNKNOWN (응답을 읽지 못했습니다)');
  } else {
    const fmt = (t) => (t.length ? t.map((x) => x.code + '=' + x.count).join(' ') : 'none');
    console.log('TRAIGO_TICK_REASONS ' + fmt(reasons.outcomes));
    if (reasons.lastEval.length) {
      console.log('TRAIGO_TICK_LASTEVAL ' + fmt(reasons.lastEval));
    }
  }
  if (verdict.code === 'NO_ENABLED_SCHEDULES') {
    console.log('NOTICE: all schedules disabled; GitHub tick succeeded but no trade was possible.');
  }
  if (verdict.code === 'ENTRY_REPORTED_NOT_FILL_VERIFIED') {
    console.log('NOTICE: entry is an application-reported result; exchange fill and SL/TP are NOT verified by this workflow.');
  }
  if (!verdict.pass) process.exitCode = 1;
}
