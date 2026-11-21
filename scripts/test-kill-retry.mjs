#!/usr/bin/env node
/**
 * 킬스위치 자동 재시도 판정 — FakeDB / FakeVenue 시험
 *
 * 무엇을 지키는 시험인가
 * ──────────────────────
 * 킬스위치는 사람이 가장 급할 때 누른다. 그런데 한 번 눌러서 끝나지
 * 않는 경우가 실제로 있다 — 거래소가 타임아웃을 주고, 워커가 그 사이
 * 재시작되고, 포지션은 그대로 남는다. 그때 자동 재시도가 다음 세 가지를
 * 하면 안 된다:
 *
 *   ① 같은 주문을 두 번 낸다 (이미 실행 중인 시도를 못 보고 또 claim)
 *   ② 못 읽은 것을 "정리됨"으로 적는다 (조회 실패 → 완료)
 *   ③ 끝없이 다시 낸다 (한도 없이 거래소를 때린다)
 *
 * 그래서 판정을 `src/lib/risk/killRetry.ts` 한 곳에 두고, 여기서
 * **실제로 돌려서** 확인한다. 가짜 DB는 jobs 행의 수명(PENDING →
 * PROCESSING → 잠금 만료 → stale 회수)을 그대로 재현하고, 가짜 거래소는
 * **주문이 몇 번 나갔는지 센다.** 중복 실행은 그 숫자로 드러난다.
 *
 * 잔여 판정은 여기서 다시 만들지 않는다 — `leftoverVerdict`(기존)를
 * 그대로 쓴다. 같은 판단이 두 곳에 있으면 언젠가 갈린다.
 *
 * 실행: node --test scripts/test-kill-retry.mjs
 *
 * **이 파일은 아직 `scripts/run-tests.mjs`와 CI 워크플로에 등록되어
 * 있지 않다.** (등록은 `scripts/run-tests.mjs`를 건드려야 하고 그 파일은
 * 다른 작업과 겹친다.) 지금은 위 명령으로 직접 돌려야 돈다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ENTRY = 'src/lib/risk/killRetry.ts';
const OUT = mkdtempSync(join(tmpdir(), 'killretry-'));

// ── 컴파일 ──
//
// tsc는 import를 따라가므로 killSwitchTruth도 함께 나온다. 산출물이
// 없으면 **멈춘다** — 빠진 모듈로 돌린 결과는 통과도 실패도 아니다.
let tscOut = '';
try {
  tscOut = execFileSync(process.execPath, [
    join(ROOT, 'node_modules/typescript/bin/tsc'),
    ENTRY, '--outDir', OUT, '--rootDir', '.',
    '--module', 'commonjs', '--target', 'es2020',
    '--skipLibCheck', '--esModuleInterop', '--lib', 'es2020',
  ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  tscOut = String(e?.stdout || '') + String(e?.stderr || '');
}
const entryJs = join(OUT, ENTRY.replace(/\.ts$/, '.js'));

let M = null, loadErr = '';
if (existsSync(entryJs)) {
  try { M = await import(entryJs); } catch (e) { loadErr = String(e?.message || e); }
} else {
  loadErr = `컴파일 산출물이 없다: ${entryJs}\n${tscOut}`;
}

test('① 판정 모듈이 컴파일되고 killRetryVerdict를 내보낸다', () => {
  assert.ok(M, `모듈을 불러오지 못했다 — ${loadErr}`);
  assert.equal(typeof M.killRetryVerdict, 'function', 'killRetryVerdict가 없다');
});

if (!M) {
  // 아래 시험들은 판정 함수가 있어야 의미가 있다. 없는 상태에서
  // "통과"로 세지 않도록 하나의 실패로 남긴다.
  test('② 이후 시험 — 모듈이 없어 실행하지 못했다', () => {
    assert.fail(`killRetryVerdict 미구현/미컴파일 — ${loadErr}`);
  });
} else {

const { killRetryVerdict, KILL_RETRY_BACKOFF_MS, KILL_RETRY_MAX_ATTEMPTS } = M;

// leftoverVerdict는 기존 파일에서 가져온다 (여기서 다시 만들지 않는다)
const T = await import(join(OUT, 'src/lib/risk/killSwitchTruth.js'));
const { leftoverVerdict } = T;

// ── 가짜 거래소 ──
//
// 주문이 몇 번 나갔는지 센다. 중복 실행은 이 숫자로 드러난다.
function makeVenue({ clearAfter = 1, readFails = false } = {}) {
  const v = {
    sent: 0,
    readFails,
    positions: 1,
    orders: 2,
    closeAll() {
      v.sent++;
      if (v.sent >= clearAfter) { v.positions = 0; v.orders = 0; }
      return { ok: true };
    },
    /** 잔여 조회. 실패하면 null을 준다 — **0이 아니다** */
    readLeftover() {
      if (v.readFails) return { positions: null, orders: null, error: '거래소 조회 타임아웃' };
      return { positions: v.positions, orders: v.orders };
    },
  };
  return v;
}

// ── 가짜 DB (jobs 행) ──
//
// worker/src/index.ts의 실제 수명을 따른다:
//   PENDING → (claim) PROCESSING · attempts+1 · locked_until = now+60s
//   잠금 만료 + 보유 워커 heartbeat 없음 + 유예 경과 → 회수 대상
function makeDb({ row = null, lookupFails = false } = {}) {
  const db = {
    row, lookupFails,
    lookup() {
      if (db.lookupFails) return { ok: false, error: 'jobs 조회 실패' };
      return { ok: true, job: db.row ? { ...db.row } : null };
    },
    claim(nowMs, workerId) {
      if (!db.row) {
        db.row = {
          status: 'PROCESSING', attempts: 1, maxAttempts: 5,
          lockedUntilMs: nowMs + 60_000, lockedBy: workerId,
          lastAttemptAtMs: nowMs,
        };
        return true;
      }
      // 같은 행을 다시 시도한다 — 상태로 막지 않는다. **중복 방지는
      // 여기가 아니라 판정이 한다**(IN_FLIGHT일 때 애초에 claim을 안 부른다).
      // 가짜 DB가 막아 버리면 판정이 통과한 것처럼 보일 뿐이다.
      db.row = {
        ...db.row, status: 'PROCESSING',
        attempts: (db.row.attempts ?? 0) + 1,
        lockedUntilMs: nowMs + 60_000, lockedBy: workerId,
        lastAttemptAtMs: nowMs,
      };
      return true;
    },
  };
  return db;
}

/** 한 번의 tick — 판정하고, 판정이 허락할 때만 실제로 낸다 */
function tick(db, venue, { nowMs, active = true, holderAlive = false, workerId = 'w1', expectedClosed = true }) {
  const lv = leftoverVerdict({ leftover: venue.readLeftover(), expectedClosed });
  const v = killRetryVerdict({
    nowMs, active, lookup: db.lookup(), leftover: lv, holderAlive,
  });
  if (v.retry) { db.claim(nowMs, workerId); venue.closeAll(); }
  return v;
}

const T0 = 1_762_000_000_000;

// ─────────────────────────────────────────────────────────────
test('② 첫 발동 — 큐에 아무것도 없으면 지금 낸다', () => {
  const db = makeDb(), venue = makeVenue({ clearAfter: 1 });
  const v = tick(db, venue, { nowMs: T0 });
  assert.equal(v.code, 'RETRY', v.reason);
  assert.equal(v.retry, true);
  assert.equal(v.complete, false);
  assert.equal(venue.sent, 1);
});

test('③ 같은 순간에 두 번 돌아도 주문은 한 번만 나간다 (중복 실행 금지)', () => {
  const db = makeDb(), venue = makeVenue({ clearAfter: 99 });
  tick(db, venue, { nowMs: T0 });
  assert.equal(venue.sent, 1);
  const v2 = tick(db, venue, { nowMs: T0 + 1, holderAlive: true });
  assert.equal(v2.code, 'IN_FLIGHT', v2.reason);
  assert.equal(v2.retry, false);
  assert.equal(venue.sent, 1, '★ PROCESSING 잡을 못 보고 또 냈다');
});

test('④ PENDING 잡이 이미 큐에 있으면 또 쌓지 않는다', () => {
  const db = makeDb({ row: { status: 'PENDING', attempts: 0, maxAttempts: 5, lockedUntilMs: null, lockedBy: null, lastAttemptAtMs: null } });
  const venue = makeVenue({ clearAfter: 99 });
  const v = tick(db, venue, { nowMs: T0 });
  assert.equal(v.code, 'IN_FLIGHT', v.reason);
  assert.equal(venue.sent, 0);
});

test('⑤ 잠금이 만료됐지만 보유 워커가 살아 있으면 회수하지 않는다 (느릴 뿐이다)', () => {
  const db = makeDb({ row: { status: 'PROCESSING', attempts: 1, maxAttempts: 5, lockedUntilMs: T0 - 1_000, lockedBy: 'w9', lastAttemptAtMs: T0 - 61_000 } });
  const venue = makeVenue({ clearAfter: 99 });
  const v = tick(db, venue, { nowMs: T0, holderAlive: true });
  assert.equal(v.code, 'IN_FLIGHT', v.reason);
  assert.equal(venue.sent, 0, '★ 살아 있는 워커의 주문 위에 또 냈다');
});

test('⑥ 워커 재시작 — 유예 전에는 기다리고, 유예가 지나면 한 번만 다시 낸다', () => {
  const row = { status: 'PROCESSING', attempts: 1, maxAttempts: 5, lockedUntilMs: T0, lockedBy: 'dead', lastAttemptAtMs: T0 - 60_000 };
  const db = makeDb({ row }), venue = makeVenue({ clearAfter: 2 });

  const early = tick(db, venue, { nowMs: T0 + 30_000, holderAlive: false });
  assert.equal(early.code, 'BACKOFF', early.reason);
  assert.ok(early.waitMs > 0, '남은 유예를 알려주지 않는다');
  assert.equal(venue.sent, 0);

  const late = tick(db, venue, { nowMs: T0 + 121_000, holderAlive: false });
  assert.equal(late.code, 'RETRY', late.reason);
  assert.equal(venue.sent, 1);

  // 바로 다음 tick은 새 잠금 때문에 또 내지 않는다
  const again = tick(db, venue, { nowMs: T0 + 121_500, holderAlive: true });
  assert.equal(again.retry, false, again.reason);
  assert.equal(venue.sent, 1, '★ 재시작 복구가 중복 주문을 냈다');
});

test('⑦ 거래소가 CLEAR를 확인했을 때만 완료다', () => {
  const db = makeDb({ row: { status: 'DONE', attempts: 1, maxAttempts: 5, lockedUntilMs: null, lockedBy: null, lastAttemptAtMs: T0 - 10_000 } });
  const venue = makeVenue({ clearAfter: 0 });
  venue.positions = 0; venue.orders = 0;
  const v = tick(db, venue, { nowMs: T0 });
  assert.equal(v.code, 'DONE', v.reason);
  assert.equal(v.complete, true);
  assert.equal(v.retry, false);
  assert.equal(venue.sent, 0);
});

test('⑧ 잔여 조회 실패(UNKNOWN)를 완료로 적지 않는다', () => {
  const db = makeDb({ row: { status: 'DONE', attempts: 1, maxAttempts: 5, lockedUntilMs: null, lockedBy: null, lastAttemptAtMs: T0 - 600_000 } });
  const venue = makeVenue({ readFails: true });
  const v = tick(db, venue, { nowMs: T0 });
  assert.notEqual(v.code, 'DONE', '★ 못 읽은 것을 정리됨으로 적었다');
  assert.equal(v.complete, false);
  assert.equal(v.code, 'RETRY', v.reason);
});

test('⑨ 포지션이 남아 있으면 한도까지 다시 내고, 한도에서 사람에게 올린다', () => {
  const row = { status: 'DONE', attempts: 0, maxAttempts: 3, lockedUntilMs: null, lockedBy: null, lastAttemptAtMs: null };
  const db = makeDb({ row }), venue = makeVenue({ clearAfter: 99 });
  let now = T0, last = null;
  for (let i = 0; i < 40; i++) {
    now += 10_000;
    // 잠금을 풀어 "직전 시도가 끝난 상태"로 만든다 — 백오프만 남는다
    if (db.row) db.row = { ...db.row, status: 'DONE', lockedUntilMs: null, lockedBy: null };
    last = tick(db, venue, { nowMs: now, holderAlive: false });
    if (last.code === 'GIVE_UP_REPORT') break;
  }
  assert.equal(last.code, 'GIVE_UP_REPORT', last.reason);
  assert.equal(last.escalate, true, '사람에게 올리지 않는다');
  assert.equal(last.complete, false, '★ 포기를 완료로 적었다');
  assert.equal(venue.sent, 3, `한도(3)를 넘겨 냈다 — ${venue.sent}건`);
  assert.ok(/남아|REMAINS|확인/.test(last.reason), last.reason);
});

test('⑩ 백오프 — 직전 시도 직후에는 기다리고 남은 시간을 알려준다', () => {
  const db = makeDb({ row: { status: 'DONE', attempts: 1, maxAttempts: 5, lockedUntilMs: null, lockedBy: null, lastAttemptAtMs: T0 } });
  const venue = makeVenue({ clearAfter: 99 });
  const soon = tick(db, venue, { nowMs: T0 + 1_000 });
  assert.equal(soon.code, 'BACKOFF', soon.reason);
  assert.ok(soon.waitMs > 0 && soon.waitMs <= KILL_RETRY_BACKOFF_MS, `waitMs=${soon.waitMs}`);
  assert.equal(venue.sent, 0);

  const after = tick(db, venue, { nowMs: T0 + KILL_RETRY_BACKOFF_MS + 1 });
  assert.equal(after.code, 'RETRY', after.reason);
  assert.equal(venue.sent, 1);
});

test('⑪ 백오프는 시도가 늘수록 길어진다', () => {
  const mk = (attempts) => killRetryVerdict({
    nowMs: T0 + 1,
    active: true,
    lookup: { ok: true, job: { status: 'DONE', attempts, maxAttempts: 9, lockedUntilMs: null, lockedBy: null, lastAttemptAtMs: T0 } },
    leftover: leftoverVerdict({ leftover: { positions: 1, orders: 0 }, expectedClosed: true }),
    holderAlive: false,
  });
  const a = mk(1), b = mk(2), c = mk(3);
  assert.equal(a.code, 'BACKOFF'); assert.equal(b.code, 'BACKOFF'); assert.equal(c.code, 'BACKOFF');
  assert.ok(b.waitMs > a.waitMs, `${b.waitMs} > ${a.waitMs}`);
  assert.ok(c.waitMs > b.waitMs, `${c.waitMs} > ${b.waitMs}`);
});

// ── 누락 시 fail-closed ──
//
// 못 읽은 것은 통과가 아니다. 완료도 아니고, 중복 주문의 허가도 아니다.
const REMAINS = () => leftoverVerdict({ leftover: { positions: 1, orders: 0 }, expectedClosed: true });
const CLEARV = () => leftoverVerdict({ leftover: { positions: 0, orders: 0 }, expectedClosed: true });
const JOB = (o = {}) => ({ ok: true, job: { status: 'DONE', attempts: 0, maxAttempts: 5, lockedUntilMs: null, lockedBy: null, lastAttemptAtMs: null, ...o } });

test('⑫ 큐를 조회하지 못하면 중복 주문의 허가로 읽지 않는다', () => {
  const v = killRetryVerdict({ nowMs: T0, active: true, lookup: { ok: false, error: 'jobs 조회 실패' }, leftover: REMAINS() });
  assert.equal(v.code, 'UNKNOWN_HOLD', v.reason);
  assert.equal(v.retry, false, '★ 실행 중인 시도가 있는지도 모르는 채로 또 냈다');
  assert.equal(v.complete, false);
  assert.equal(v.escalate, true);
});

test('⑬ 발동 여부를 못 읽으면 꺼진 것으로 읽지 않는다', () => {
  const v = killRetryVerdict({ nowMs: T0, active: null, lookup: JOB(), leftover: REMAINS() });
  assert.equal(v.code, 'UNKNOWN_HOLD', v.reason);
  assert.equal(v.complete, false);
});

test('⑭ 잔여 판정이 아예 없으면 완료도 재시도도 아니다', () => {
  const v = killRetryVerdict({ nowMs: T0, active: true, lookup: JOB(), leftover: null });
  assert.equal(v.code, 'UNKNOWN_HOLD', v.reason);
  assert.equal(v.retry, false);
  assert.equal(v.complete, false);
});

test('⑮ 시도 횟수를 못 읽으면 0으로 읽지 않는다', () => {
  const v = killRetryVerdict({ nowMs: T0, active: true, lookup: JOB({ attempts: null }), leftover: REMAINS() });
  assert.equal(v.code, 'UNKNOWN_HOLD', v.reason);
  assert.equal(v.retry, false);
  assert.equal(v.escalate, true);
});

test('⑯ 잡 상태를 못 읽으면 "실행 중이 아니다"로 읽지 않는다', () => {
  const v = killRetryVerdict({ nowMs: T0, active: true, lookup: JOB({ status: null }), leftover: REMAINS() });
  assert.equal(v.code, 'UNKNOWN_HOLD', v.reason);
  assert.equal(v.retry, false);
});

test('⑰ PROCESSING인데 잠금 시각을 모르면 회수하지 않는다', () => {
  const v = killRetryVerdict({ nowMs: T0, active: true, lookup: JOB({ status: 'PROCESSING', attempts: 1, lockedUntilMs: null, lockedBy: 'w9' }), leftover: REMAINS() });
  assert.equal(v.code, 'UNKNOWN_HOLD', v.reason);
  assert.equal(v.retry, false);
});

test('⑱ 잠금이 만료됐는데 보유 워커 생존을 모르면 회수하지 않는다', () => {
  const v = killRetryVerdict({
    nowMs: T0, active: true,
    lookup: JOB({ status: 'PROCESSING', attempts: 1, lockedUntilMs: T0 - 500_000, lockedBy: 'w9', lastAttemptAtMs: T0 - 600_000 }),
    leftover: REMAINS(), holderAlive: null,
  });
  assert.equal(v.code, 'UNKNOWN_HOLD', v.reason);
  assert.equal(v.retry, false);
});

test('⑲ 시도한 적이 있는데 그 시각을 모르면 즉시 또 내지 않는다', () => {
  const v = killRetryVerdict({ nowMs: T0, active: true, lookup: JOB({ attempts: 2, lastAttemptAtMs: null }), leftover: REMAINS() });
  assert.equal(v.code, 'UNKNOWN_HOLD', v.reason);
  assert.equal(v.retry, false);
});

test('⑳ 마지막 시도 시각이 미래면(시계 어긋남) 그대로 믿지 않는다', () => {
  const v = killRetryVerdict({ nowMs: T0, active: true, lookup: JOB({ attempts: 1, lastAttemptAtMs: T0 + 60_000 }), leftover: REMAINS() });
  assert.equal(v.code, 'UNKNOWN_HOLD', v.reason);
  assert.equal(v.retry, false);
});

test('㉑ 발동 중이 아니면 재시도하지 않는다', () => {
  const v = killRetryVerdict({ nowMs: T0, active: false, lookup: JOB(), leftover: REMAINS() });
  assert.equal(v.code, 'NOT_ACTIVE', v.reason);
  assert.equal(v.retry, false);
  assert.equal(v.complete, false);
});

test('㉒ 한도를 이미 넘긴 상태에서는 완료로 적지 않고 올린다', () => {
  const v = killRetryVerdict({ nowMs: T0, active: true, lookup: JOB({ attempts: 9, maxAttempts: 5, lastAttemptAtMs: T0 - 10_000_000 }), leftover: REMAINS() });
  assert.equal(v.code, 'GIVE_UP_REPORT', v.reason);
  assert.equal(v.complete, false);
  assert.equal(v.retry, false);
  assert.equal(v.escalate, true);
});

test('㉓ 한도를 넘겼어도 거래소가 CLEAR면 완료다', () => {
  const v = killRetryVerdict({ nowMs: T0, active: true, lookup: JOB({ attempts: 9, maxAttempts: 5 }), leftover: CLEARV() });
  assert.equal(v.code, 'DONE', v.reason);
  assert.equal(v.complete, true);
});

test('㉔ maxAttempts가 없으면 기본 한도를 쓴다 (무한이 아니다)', () => {
  assert.equal(typeof KILL_RETRY_MAX_ATTEMPTS, 'number');
  assert.ok(KILL_RETRY_MAX_ATTEMPTS > 0 && KILL_RETRY_MAX_ATTEMPTS <= 20);
  const v = killRetryVerdict({
    nowMs: T0, active: true,
    lookup: JOB({ attempts: KILL_RETRY_MAX_ATTEMPTS, maxAttempts: null, lastAttemptAtMs: T0 - 10_000_000 }),
    leftover: REMAINS(),
  });
  assert.equal(v.code, 'GIVE_UP_REPORT', v.reason);
});

test('㉕ nowMs가 수상하면 아무 판정도 내리지 않는다', () => {
  for (const bad of [NaN, Infinity, null, undefined]) {
    const v = killRetryVerdict({ nowMs: bad, active: true, lookup: JOB(), leftover: REMAINS() });
    assert.equal(v.code, 'UNKNOWN_HOLD', `nowMs=${String(bad)} — ${v.reason}`);
  }
});

test('㉖ 잔여 판정을 여기서 다시 만들지 않는다 (판단은 한 곳)', () => {
  const src = readFileSync(join(ROOT, ENTRY), 'utf8');
  assert.ok(/from '\.\/killSwitchTruth'/.test(src), 'leftoverVerdict의 타입을 기존 파일에서 가져오지 않는다');
  // 잔여를 직접 세기 시작하면 두 곳이 갈린다
  assert.ok(!/\.positions\b/.test(src), '★ killRetry가 positions를 직접 센다 — 잔여 판정이 두 곳이 된다');
  assert.ok(!/\.orders\b/.test(src), '★ killRetry가 orders를 직접 센다 — 잔여 판정이 두 곳이 된다');
});

}
