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

/**
 * 마지막 **평가 완료**가 얼마나 오래됐는가 — 굵은 구간으로만 센다.
 *
 * 왜 필요한가
 * ───────────
 * 2026-11-17 18:49 회차가 #684 이후 처음으로 사유를 뱉었다:
 *
 *     TRAIGO_TICK_REASONS  WAITING=2
 *     TRAIGO_TICK_LASTEVAL NO_BREAKOUT=2
 *
 * 읽으면 "조건이 안 맞아 관망 중"으로 보인다. 그런데 이 두 줄만으로는
 * **그 `NO_BREAKOUT`이 방금 내려진 판단인지 일주일 전에 굳은 판단인지
 * 구분할 수 없다.** 워커가 죽어 있어도 글자는 똑같다 — `lastEval`은
 * 마지막으로 **적힌** 판단이지 마지막으로 **내려진** 판단이 아니다.
 *
 * cron 틱은 예비 실행기이고 주 실행기는 워커다. 그래서 틱의 `WAITING`은
 * 정상이고, **"자동매매가 살아 있는가"에 답하는 것은 이 나이 하나다.**
 *
 * 왜 새 값을 만들지 않았나
 * ────────────────────────
 * `lastEval.completedAt`(판단과 같은 UPDATE에 적힌 `sourceAt`)과
 * `lastEval.completed`는 **이미 응답에 실려 와 있다.** 검사기가 버리고
 * 있었을 뿐이다. 라우트를 고치지 않는다 — 열린 PR 19건이 그 파일을
 * 잡고 있고, 고칠 필요도 없다.
 *
 * 선점 시각(`at`)은 쓰지 않는다
 * ─────────────────────────────
 * `claimSchedule`이 평가 **전에** 적는 값이라, 선점 직후 죽은 회차는
 * `at`만 최근이다. 그걸로 나이를 재면 죽은 워커가 살아 있어 보인다.
 * 완료 증거는 `completed`뿐이고, 그것이 아니면 `NOT_COMPLETED`다.
 *
 * 본문을 찍지 않는다
 * ──────────────────
 * 시각 문자열을 내보내지 않는다. **숫자로 바꿔 구간 이름만** 적는다 —
 * `safeCode`가 모양으로 거르는 것과 같은 규율이다.
 *
 * 읽지 못한 나이는 `UNKNOWN`이다. 0도 `LT_1H`도 아니다.
 */
const HOUR = 3_600_000;
/** 서버와 러너의 시계 차이. 이만큼의 미래는 0으로 본다 */
const CLOCK_SLACK_MS = 5 * 60_000;
const AGE_STEPS = [
  [HOUR, 'LT_1H'],
  [6 * HOUR, 'LT_6H'],
  [24 * HOUR, 'LT_24H'],
  [7 * 24 * HOUR, 'LT_7D'],
];

export function evalAgeBucket(note, nowMs) {
  if (!object(note)) return null;
  // 완료를 확인하지 못한 회차는 나이를 재지 않는다 — 선점만 하고 죽었을
  // 수 있고, 그 경우 `completedAt`은 이전 회차의 것이다.
  if (note.completed !== true) return 'NOT_COMPLETED';
  const t = typeof note.completedAt === 'string' ? Date.parse(note.completedAt) : NaN;
  if (!Number.isFinite(t)) return 'UNKNOWN';
  const age = nowMs - t;
  // 시계 차이를 넘는 미래 시각은 읽은 것으로 치지 않는다.
  if (age < -CLOCK_SLACK_MS) return 'UNKNOWN';
  const a = Math.max(0, age);
  for (const [limit, name] of AGE_STEPS) if (a < limit) return name;
  return 'GTE_7D';
}

/**
 * 모든 결과 행을 **정확히 한 구간에** 넣는다 — 합이 `checked`와 같아야
 * 하므로 줄 자체가 자기 검산이 된다.
 *
 * · `lastEval`이 있는 행 → 위 나이 판정
 * · 없고 이번 회차에 평가한 행(`outcome`) → `JUST_NOW`
 * · 둘 다 아닌 행(연결이 없어 막힌 행) → `NO_RECORD`
 */
export function tickFreshness(body, nowMs = Date.now()) {
  const rows = Array.isArray(body?.results) ? body.results.filter(object) : [];
  return tally(rows.map((r) => {
    const b = evalAgeBucket(r.lastEval, nowMs);
    if (b !== null) return b;
    if (typeof r.outcome === 'string' && r.outcome !== '') return 'JUST_NOW';
    return 'NO_RECORD';
  }));
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
  let freshness = null;
  try {
    const path = process.argv[2];
    if (!path) throw new Error('missing body file');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    verdict = tickResponseVerdict(parsed);
    reasons = tickReasons(parsed);
    freshness = tickFreshness(parsed);
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
    console.log('TRAIGO_TICK_EVALAGE UNKNOWN (응답을 읽지 못했습니다)');
  } else {
    const fmt = (t) => (t.length ? t.map((x) => x.code + '=' + x.count).join(' ') : 'none');
    console.log('TRAIGO_TICK_REASONS ' + fmt(reasons.outcomes));
    if (reasons.lastEval.length) {
      console.log('TRAIGO_TICK_LASTEVAL ' + fmt(reasons.lastEval));
    }
    // **이 줄이 "워커가 살아 있는가"에 답한다.** 위 LASTEVAL은 마지막으로
    // 적힌 판단이지 마지막으로 내려진 판단이 아니다.
    console.log('TRAIGO_TICK_EVALAGE ' + fmt(freshness ?? []));
  }
  if (verdict.code === 'NO_ENABLED_SCHEDULES') {
    console.log('NOTICE: all schedules disabled; GitHub tick succeeded but no trade was possible.');
  }
  if (verdict.code === 'ENTRY_REPORTED_NOT_FILL_VERIFIED') {
    console.log('NOTICE: entry is an application-reported result; exchange fill and SL/TP are NOT verified by this workflow.');
  }
  if (!verdict.pass) process.exitCode = 1;
}
