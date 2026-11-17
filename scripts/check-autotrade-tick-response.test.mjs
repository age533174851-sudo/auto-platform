import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tickResponseVerdict, tickReasons, safeCode, tickFreshness, evalAgeBucket } from './check-autotrade-tick-response.mjs';

const ok = (results) => ({ ok: true, error: null, scheduledUnknown: false, scheduled: results.length, results });

test('no enabled schedules is visible but never claimed as an entry', () => {
  const v = tickResponseVerdict(ok([]));
  assert.equal(v.pass, true);
  assert.equal(v.code, 'NO_ENABLED_SCHEDULES');
  assert.equal(v.reportedEntries, 0);
});

test('HTTP 200 with server error or unknown schedule count fails closed', () => {
  for (const b of [
    { ok: false, error: 'quota', scheduled: 0, results: [] },
    { ok: true, error: 'database error', scheduled: 0, results: [] },
    { ok: true, scheduledUnknown: true, scheduled: null, results: [] },
    { ok: true, scheduled: null, results: [] },
    { ok: true, scheduled: 1, results: [] },
    { ok: true, scheduled: 1, results: [null] },
    {},
  ]) {
    assert.equal(tickResponseVerdict(b).pass, false);
  }
});

test('WAITING is not failed or entered; reported entry is not a verified fill', () => {
  const wait = tickResponseVerdict(ok([{ ok: true, skipped: true, code: 'WAITING' }]));
  assert.equal(wait.pass, true);
  assert.equal(wait.code, 'NO_ENTRY_REPORTED');
  const entered = tickResponseVerdict(ok([{ ok: true, executed: true, outcome: 'ENTERED' }]));
  assert.equal(entered.pass, true);
  assert.equal(entered.code, 'ENTRY_REPORTED_NOT_FILL_VERIFIED');
});

test('per-schedule execution failure makes workflow fail', () => {
  const v = tickResponseVerdict(ok([{ ok: false, executed: false, outcome: 'FAILED' }]));
  assert.equal(v.pass, false);
  assert.equal(v.code, 'EVALUATION_FAILURE');
  assert.equal(v.failures, 1);
});

test('CLI does not echo server messages or sensitive payloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-tick-response-'));
  try {
    const file = join(dir, 'response.json');
    writeFileSync(file, JSON.stringify({ ok: false, error: 'DO_NOT_LEAK_SECRET', scheduled: 0, results: [] }));
    const run = spawnSync(process.execPath, [new URL('./check-autotrade-tick-response.mjs', import.meta.url).pathname, file], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /SCHEDULE_READ_OR_SERVER_FAILED/);
    assert.doesNotMatch(run.stdout + run.stderr, /DO_NOT_LEAK_SECRET/);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test('workflow checks out repository before invoking the parser and never echoes the body', () => {
  const workflow = readFileSync(new URL('../.github/workflows/autotrade-tick.yml', import.meta.url), 'utf8');
  const checkout = workflow.indexOf('actions/checkout@v4');
  const verifier = workflow.indexOf('node scripts/check-autotrade-tick-response.mjs');
  assert.ok(checkout >= 0 && verifier > checkout, 'checkout must precede the parser');
  assert.doesNotMatch(workflow, /^\s*cat "\$body"/m);
});

test('RED: schedule save error cannot be reported as a successful tick', () => {
  const v = tickResponseVerdict(ok([{ ok: true, executed: false, saveError: 'write failed' }]));
  assert.equal(v.pass, false);
  assert.equal(v.code, 'SCHEDULE_STATE_SAVE_FAILED');
});

test('RED: cron log failure must be visible rather than silently green', () => {
  const v = tickResponseVerdict({ ...ok([{ ok: true, executed: false }]), cronLogError: 'write failed' });
  assert.equal(v.pass, false);
  assert.equal(v.code, 'CRON_AUDIT_SAVE_FAILED');
});

test('RED: missing per-schedule ok must not pass as a successful evaluation', () => {
  const v = tickResponseVerdict(ok([{ executed: true, outcome: 'ENTERED' }]));
  assert.equal(v.pass, false);
  assert.equal(v.code, 'EVALUATION_STATUS_UNKNOWN');
});

// ── 진입 0건의 **이유**를 센다 ──
//
// `scheduled=2 checked=2 entryReported=0 failures=0`이 세 회차 연속
// 같은 줄이었고, 그 줄만으로는 조건이 안 됐는지 관문이 막았는지
// 구분할 수 없었다. 답은 이미 응답에 실려 와 있었고 여기서 버렸다.

test('건너뜀은 code로, 평가한 것은 outcome으로 센다', () => {
  const r = tickReasons(ok([
    { ok: true, skipped: true, code: 'INTERVAL_NOT_DUE' },
    { ok: true, skipped: true, code: 'INTERVAL_NOT_DUE' },
    { ok: true, executed: false, outcome: 'WAITING' },
  ]));
  assert.deepEqual(r.outcomes, [
    { code: 'INTERVAL_NOT_DUE', count: 2 },
    { code: 'WAITING', count: 1 },
  ]);
});

test('정렬이 고정이다 — 같은 입력이 같은 줄을 낸다', () => {
  // 건수 내림차순, 같으면 코드 오름차순. 안 고정하면 회차끼리 비교할 수 없다.
  const a = tickReasons(ok([
    { ok: true, outcome: 'ZEBRA' }, { ok: true, outcome: 'ALPHA' },
  ]));
  const b = tickReasons(ok([
    { ok: true, outcome: 'ALPHA' }, { ok: true, outcome: 'ZEBRA' },
  ]));
  assert.deepEqual(a.outcomes, b.outcomes);
  assert.deepEqual(a.outcomes.map(x => x.code), ['ALPHA', 'ZEBRA']);
});

test('사유가 없는 줄을 "없음"으로 적지 않는다', () => {
  const r = tickReasons(ok([{ ok: true, executed: false }]));
  assert.deepEqual(r.outcomes, [{ code: 'UNSPECIFIED', count: 1 }]);
});

test('lastEval.reasonCode는 따로 센다 — 없으면 세지 않는다', () => {
  const r = tickReasons(ok([
    { ok: true, code: 'INTERVAL_NOT_DUE', lastEval: { reasonCode: 'NO_SIGNAL' } },
    { ok: true, code: 'INTERVAL_NOT_DUE' },
  ]));
  assert.deepEqual(r.lastEval, [{ code: 'NO_SIGNAL', count: 1 }]);
});

test('열거 코드 모양이 아니면 값을 내보내지 않는다', () => {
  // 이 출력은 공개 로그에 남는다. 자유 문장을 통과시키면 그게 유출 경로다.
  assert.equal(safeCode('ENTERED'), 'ENTERED');
  assert.equal(safeCode('A_B_9'), 'A_B_9');
  assert.equal(safeCode('lower case'), 'UNSPECIFIED_SHAPE');
  assert.equal(safeCode('BTCUSDT 주문 12345 실패'), 'UNSPECIFIED_SHAPE');
  assert.equal(safeCode('A'.repeat(41)), 'UNSPECIFIED_SHAPE');
  assert.equal(safeCode(null), 'UNSPECIFIED_SHAPE');
  assert.equal(safeCode({ toString: () => 'ENTERED' }), 'UNSPECIFIED_SHAPE');
});

test('CLI가 사유를 찍어도 자유 문장은 새지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tickreason-'));
  try {
    const file = join(dir, 'body.json');
    writeFileSync(file, JSON.stringify(ok([
      { ok: true, skipped: true, code: 'INTERVAL_NOT_DUE',
        detail: 'DO_NOT_LEAK_SECRET',
        lastEval: { reasonCode: 'NO_SIGNAL', line: 'DO_NOT_LEAK_SECRET' } },
      { ok: true, executed: false, outcome: 'DO_NOT_LEAK_SECRET lower' },
    ])));
    const run = spawnSync(process.execPath, ['scripts/check-autotrade-tick-response.mjs', file],
      { encoding: 'utf8' });
    assert.match(run.stdout, /TRAIGO_TICK_REASONS .*INTERVAL_NOT_DUE=1/);
    assert.match(run.stdout, /TRAIGO_TICK_LASTEVAL NO_SIGNAL=1/);
    assert.match(run.stdout, /UNSPECIFIED_SHAPE=1/);
    assert.doesNotMatch(run.stdout + run.stderr, /DO_NOT_LEAK_SECRET/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('응답을 못 읽은 회차는 UNKNOWN이지 none이 아니다', () => {
  const run = spawnSync(process.execPath,
    ['scripts/check-autotrade-tick-response.mjs', join(tmpdir(), 'no-such-tick-body.json')],
    { encoding: 'utf8' });
  assert.match(run.stdout, /TRAIGO_TICK_REASONS UNKNOWN/);
  assert.doesNotMatch(run.stdout, /TRAIGO_TICK_REASONS none/);
  assert.equal(run.status, 1);
});

// ── 마지막 평가의 나이 ────────────────────────────────────

const NOW = Date.UTC(2026, 10, 17, 18, 49, 0);
const agoISO = (ms) => new Date(NOW - ms).toISOString();
const H = 3_600_000;
const done = (ms) => ({ completed: true, completedAt: agoISO(ms), reasonCode: 'NO_BREAKOUT' });

test('나이를 굵은 구간으로만 센다 — 경계는 아래쪽 구간에 들어간다', () => {
  assert.equal(evalAgeBucket(done(0), NOW), 'LT_1H');
  assert.equal(evalAgeBucket(done(H - 1), NOW), 'LT_1H');
  assert.equal(evalAgeBucket(done(H), NOW), 'LT_6H');
  assert.equal(evalAgeBucket(done(6 * H - 1), NOW), 'LT_6H');
  assert.equal(evalAgeBucket(done(6 * H), NOW), 'LT_24H');
  assert.equal(evalAgeBucket(done(24 * H), NOW), 'LT_7D');
  assert.equal(evalAgeBucket(done(7 * 24 * H - 1), NOW), 'LT_7D');
  assert.equal(evalAgeBucket(done(7 * 24 * H), NOW), 'GTE_7D');
  assert.equal(evalAgeBucket(done(90 * 24 * H), NOW), 'GTE_7D');
});

test('선점만 하고 판단을 못 마친 회차는 나이를 재지 않는다', () => {
  // `last_run_at`은 평가 **전에** 적힌다. 그걸로 나이를 재면 선점 직후
  // 죽은 워커가 방금 평가한 것처럼 보인다.
  assert.equal(evalAgeBucket({ completed: false, completedAt: agoISO(0) }, NOW), 'NOT_COMPLETED');
  assert.equal(evalAgeBucket({ completedAt: agoISO(0) }, NOW), 'NOT_COMPLETED');
});

test('읽지 못한 나이는 UNKNOWN이다 — 0도 LT_1H도 아니다', () => {
  assert.equal(evalAgeBucket({ completed: true, completedAt: null }, NOW), 'UNKNOWN');
  assert.equal(evalAgeBucket({ completed: true, completedAt: '어제쯤' }, NOW), 'UNKNOWN');
  assert.equal(evalAgeBucket({ completed: true, completedAt: 1763405340000 }, NOW), 'UNKNOWN');
  // 시계 차이를 넘는 미래 시각을 '방금'으로 읽지 않는다.
  assert.equal(evalAgeBucket({ completed: true, completedAt: agoISO(-60 * 60_000) }, NOW), 'UNKNOWN');
  // 그 안쪽의 작은 미래는 시계 차이로 보고 0으로 둔다.
  assert.equal(evalAgeBucket({ completed: true, completedAt: agoISO(-60_000) }, NOW), 'LT_1H');
  // lastEval 자체가 없으면 나이 판정 대상이 아니다.
  assert.equal(evalAgeBucket(undefined, NOW), null);
});

test('모든 행이 정확히 한 구간에 들어간다 — 합이 checked와 같다', () => {
  const body = ok([
    { ok: true, skipped: true, code: 'WAITING', lastEval: done(10 * 60_000) },
    { ok: true, skipped: true, code: 'WAITING', lastEval: done(30 * 24 * H) },
    { ok: true, executed: false, outcome: 'NO_SIGNAL' },
    { ok: false, blocked: true, code: 'NO_CONNECTION' },
  ]);
  const f = tickFreshness(body, NOW);
  assert.deepEqual(f, [
    { code: 'GTE_7D', count: 1 },
    { code: 'JUST_NOW', count: 1 },
    { code: 'LT_1H', count: 1 },
    { code: 'NO_RECORD', count: 1 },
  ]);
  assert.equal(f.reduce((n, x) => n + x.count, 0), body.results.length);
});

test('같은 NO_BREAKOUT이라도 살아 있는 워커와 죽은 워커가 구분된다', () => {
  // 이 시험이 이 기능의 존재 이유다. 두 몸통의 REASONS·LASTEVAL은 글자까지
  // 같고, 다른 것은 나이 한 줄뿐이다.
  const live = ok([{ ok: true, skipped: true, code: 'WAITING', lastEval: done(5 * 60_000) }]);
  const dead = ok([{ ok: true, skipped: true, code: 'WAITING', lastEval: done(30 * 24 * H) }]);
  assert.deepEqual(tickReasons(live), tickReasons(dead));
  assert.deepEqual(tickFreshness(live, NOW), [{ code: 'LT_1H', count: 1 }]);
  assert.deepEqual(tickFreshness(dead, NOW), [{ code: 'GTE_7D', count: 1 }]);
});

test('CLI가 나이를 찍어도 시각 문자열은 새지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tickage-'));
  try {
    const file = join(dir, 'body.json');
    const stamp = new Date(Date.now() - 90 * 60_000).toISOString();
    writeFileSync(file, JSON.stringify(ok([
      { ok: true, skipped: true, code: 'WAITING',
        lastEval: { completed: true, completedAt: stamp, reasonCode: 'NO_BREAKOUT',
          line: 'DO_NOT_LEAK_SECRET', at: stamp } },
    ])));
    const run = spawnSync(process.execPath, ['scripts/check-autotrade-tick-response.mjs', file],
      { encoding: 'utf8' });
    assert.match(run.stdout, /TRAIGO_TICK_EVALAGE LT_6H=1/);
    // 시각은 구간 이름으로만 나간다 — 원문도, 그 일부도 적지 않는다.
    assert.doesNotMatch(run.stdout + run.stderr, /DO_NOT_LEAK_SECRET/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(stamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(run.stdout + run.stderr, /\d{4}-\d{2}-\d{2}T/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('응답을 못 읽은 회차의 나이는 UNKNOWN이지 none이 아니다', () => {
  const run = spawnSync(process.execPath,
    ['scripts/check-autotrade-tick-response.mjs', join(tmpdir(), 'no-such-tick-body.json')],
    { encoding: 'utf8' });
  assert.match(run.stdout, /TRAIGO_TICK_EVALAGE UNKNOWN/);
  assert.doesNotMatch(run.stdout, /TRAIGO_TICK_EVALAGE none/);
});
