// src/lib/runtime/runtimeHealth.test.ts
//
// **넷이 동시에 참일 수 있다.**
//
// 화면은 워커가 죽었다 하고, 배포는 success이고, Fly는 started라 하고,
// 로그에는 tick이 찍힌다 — 워커가 살아서 **다른 데이터베이스**에 쓰고
// 있으면 넷 다 참이다. 그걸 알아내는 데 사흘이 걸렸다.
//
// 이 시험은 그 사흘을 한 줄로 만든다.

import { test, eq, assert } from '../../test/harness';
import { runtimeHealthOf, autoFixPlan, STALE_MS, WORKER_STALE_MS } from './runtimeHealth';
// **다른 모듈에서 가져온다.** 셋이 같은 숫자인지는 한 파일 안에서는
// 확인할 수 없다 — 갈라진 자리가 바로 다른 파일이었다.
import { HEARTBEAT_STALE_MS } from './persistentRuntime';
import { WORKER_STALE_MS as LOOP_WORKER_STALE_MS } from '../autotrade/evaluationLoop';

const NOW = 1_800_000_000_000;
const fresh = new Date(NOW - 10_000).toISOString();

const okRow = {
  worker_id: 'w1', last_seen: fresh, status: 'running', version: 'abc1234567',
  provider: 'FLY', region: 'nrt', supabase_fingerprint: 'aaa111',
  encryption_fingerprint: 'bbb222', startup_ok: true,
};

export function runRuntimeHealthTests() {
  console.log('[런타임 건강 — fly logs를 사람이 안 봐도 된다]');

  test('전부 맞으면 정상이고 공급자 이름을 그대로 쓴다', () => {
    const h = runtimeHealthOf({
      worker: okRow, webSupabaseFp: 'aaa111', webEncryptionFp: 'bbb222',
      mainSha: 'abc1234567', nowMs: NOW,
    });
    eq(h.code, 'HEALTHY');
    eq(h.canRun, true);
    assert(/FLY/.test(h.summary), h.summary);
  });

  test('읽지 못한 것을 정상으로 적지 않는다', () => {
    const h = runtimeHealthOf({ worker: undefined, nowMs: NOW });
    eq(h.code, 'UNKNOWN');
    eq(h.severity, 'unknown');
    eq(h.canRun, false);
  });

  test('기록이 아예 없는 것과 못 읽은 것은 다르다', () => {
    const h = runtimeHealthOf({ worker: null, nowMs: NOW });
    eq(h.code, 'NO_WORKER');
    eq(h.severity, 'bad');
  });

  test('신호가 오래되면 멈춘 것으로 본다', () => {
    const h = runtimeHealthOf({
      worker: { ...okRow, last_seen: new Date(NOW - STALE_MS - 1000).toISOString() },
      mainSha: 'abc1234567', nowMs: NOW,
    });
    eq(h.code, 'STALE_HEARTBEAT');
    eq(h.canRun, false);
  });

  test('**살아 있는데 다른 DB를 보고 있는 경우를 잡는다**', () => {
    // 이게 사흘을 잃은 그 고장이다. 워커는 fresh하고 tick도 찍는다.
    const h = runtimeHealthOf({
      worker: { ...okRow, supabase_fingerprint: 'zzz999' },
      webSupabaseFp: 'aaa111', mainSha: 'abc1234567', nowMs: NOW,
    });
    eq(h.code, 'DIFFERENT_DATABASE');
    eq(h.canRun, false);
    // **값이 아니라 지문만 말한다**
    assert(/zzz999/.test(h.summary) && /aaa111/.test(h.summary), h.summary);
    assert(!/SUPABASE_URL=/.test(h.summary), '값을 싣지 않는다');
  });

  test('암호화 키가 다르면 주문을 낼 수 없다고 말한다', () => {
    const h = runtimeHealthOf({
      worker: { ...okRow, encryption_fingerprint: 'ccc333' },
      webEncryptionFp: 'bbb222', mainSha: 'abc1234567', nowMs: NOW,
    });
    eq(h.code, 'DIFFERENT_ENCRYPTION_KEY');
    eq(h.findings[0].autoFix, null);
    assert(!!h.findings[0].needsHuman, '자동으로 못 고치는 이유를 적는다');
  });

  test('커밋이 다르면 배포가 안 끝난 것이다 — 다만 일은 받을 수 있다', () => {
    const h = runtimeHealthOf({ worker: okRow, mainSha: 'def7654321', nowMs: NOW });
    eq(h.code, 'SHA_MISMATCH');
    eq(h.severity, 'warn');
    eq(h.canRun, true);
  });

  test('**커밋 모름은 같음이 아니다**', () => {
    const h = runtimeHealthOf({ worker: { ...okRow, version: null }, mainSha: 'abc1234567', nowMs: NOW });
    eq(h.code, 'VERSION_UNKNOWN');
    assert(!/같/.test(h.summary) || /같다는 뜻이 아닙니다/.test(h.summary), h.summary);
  });

  test('기동 점검 실패는 살아 있어도 나쁘다', () => {
    const h = runtimeHealthOf({
      worker: { ...okRow, startup_ok: false, startup_detail: 'SUPABASE_SERVICE_ROLE_KEY 없음' },
      mainSha: 'abc1234567', nowMs: NOW,
    });
    eq(h.code, 'STARTUP_FAILED');
    eq(h.canRun, false);
  });

  test('한쪽 지문이 없으면 다르다고 말하지 않는다', () => {
    const h = runtimeHealthOf({
      worker: { ...okRow, supabase_fingerprint: null }, webSupabaseFp: 'aaa111',
      mainSha: 'abc1234567', nowMs: NOW,
    });
    eq(h.code, 'HEALTHY');
  });

  // ── 자동 복구 ──

  test('멈춘 워커는 자동 재시작 대상이다', () => {
    const h = runtimeHealthOf({
      worker: { ...okRow, last_seen: new Date(NOW - STALE_MS - 1).toISOString() },
      mainSha: 'abc1234567', nowMs: NOW,
    });
    const p = autoFixPlan(h, { openOrders: 0 });
    eq(p.actions.join(','), 'RESTART_WORKER');
  });

  test('**열린 주문이 있으면 대조를 먼저 한다**', () => {
    const h = runtimeHealthOf({
      worker: { ...okRow, last_seen: new Date(NOW - STALE_MS - 1).toISOString() },
      mainSha: 'abc1234567', nowMs: NOW,
    });
    const p = autoFixPlan(h, { openOrders: 2 });
    eq(p.actions[0], 'RECONCILE_FIRST');
  });

  test('**열린 주문 수를 모르면 재시작하지 않는다**', () => {
    const h = runtimeHealthOf({
      worker: { ...okRow, last_seen: new Date(NOW - STALE_MS - 1).toISOString() },
      mainSha: 'abc1234567', nowMs: NOW,
    });
    const p = autoFixPlan(h, { openOrders: null });
    eq(p.actions.length, 0);
    assert(p.blocked.some(b => /확인하지 못해/.test(b)), p.blocked.join(' | '));
  });

  // ── 워커 생존 기준은 하나다 ────────────────────────────────
  //
  // 이 시험이 없으면 다음에 누가 한 곳만 고친다. 실제로 그렇게 됐다:
  // 세 상수가 180초 · 180초 · **30초**였고, `schedulePoll.test.ts`가
  // `>= 120_000`을 요구하는데도 30초가 통과했다 — 다른 상수여서 그
  // 시험이 보지 못했다. 셋이 같은 값임을 여기서 묶어 두면, 한쪽에 붙인
  // 어떤 시험도 나머지를 함께 지킨다.
  test('워커 생존 기준은 세 모듈에서 같은 숫자다', () => {
    eq(STALE_MS, WORKER_STALE_MS);
    eq(HEARTBEAT_STALE_MS, WORKER_STALE_MS);
    eq(LOOP_WORKER_STALE_MS, WORKER_STALE_MS);
  });

  test('워커 생존 기준은 재배포를 견디고 죽음을 놓치지 않는 범위다', () => {
    // schedulePoll.test.ts:470이 WORKER_STALE_MS에 걸어 둔 것과 같은 범위다.
    // 같은 숫자가 됐으므로 이제 세 모듈 전부가 이 범위 안에 있다.
    assert(WORKER_STALE_MS >= 120_000, `${WORKER_STALE_MS}: 유예가 짧으면 재배포마다 빨강이 된다`);
    assert(WORKER_STALE_MS <= 600_000, `${WORKER_STALE_MS}: 유예가 길면 죽은 워커를 못 본다`);
    // 워커는 최악의 설정에서도 15초마다 heartbeat를 쓴다
    // (worker/src/index.ts:86의 clamp 상한). 그 네 번은 넘겨야
    // 한 번 늦은 것을 죽음으로 읽지 않는다.
    assert(WORKER_STALE_MS >= 15_000 * 4, `${WORKER_STALE_MS}: 15초 주기의 네 번보다 짧다`);
  });

  test('값을 바꿔야 하는 고장은 자동 목록에 넣지 않는다', () => {
    const h = runtimeHealthOf({
      worker: { ...okRow, supabase_fingerprint: 'zzz999' },
      webSupabaseFp: 'aaa111', mainSha: 'abc1234567', nowMs: NOW,
    });
    const p = autoFixPlan(h, { openOrders: 0 });
    eq(p.actions.length, 0);
    assert(p.blocked.some(b => /DIFFERENT_DATABASE/.test(b)), p.blocked.join(' | '));
  });
}
