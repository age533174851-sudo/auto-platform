// src/lib/ops/selfHeal.test.ts
//
// 자동 복구의 위험은 둘이다: **고쳐지지 않는 원인을 계속 재시작으로
// 덮는 것**과, **주문이 떠 있는 동안 눈감고 워커를 갈아 끼우는 것.**
// 이 시험은 그 둘을 막는다.

import { test, eq, assert } from '../../test/harness';
import { healPlan, healVerdict, deployVerification, observedVercelSha, MAX_ATTEMPTS, ATTEMPT_WINDOW_MS } from './selfHeal';
import type { RuntimeHealth } from '../runtime/runtimeHealth';

const NOW = 1_800_000_000_000;

const health = (over: Partial<RuntimeHealth> = {}): RuntimeHealth => ({
  code: 'STALE_HEARTBEAT', severity: 'bad', summary: '신호가 오래됐습니다',
  findings: [{ code: 'STALE_HEARTBEAT', severity: 'bad', detail: '오래됨',
    autoFix: 'RESTART_WORKER', needsHuman: null }],
  canRun: false, ageSec: 600, ...over,
} as RuntimeHealth);

const healthy = (): RuntimeHealth => ({
  code: 'HEALTHY', severity: 'ok', summary: '정상', findings: [], canRun: true, ageSec: 5,
} as RuntimeHealth);

export function runSelfHealTests() {
  console.log('[자동 복구 — 스스로 고치되 눈감고 고치지 않는다]');

  test('멀쩡하면 아무것도 하지 않는다', () => {
    const p = healPlan({ health: healthy(), openOrders: 0, attempts: [], nowMs: NOW });
    eq(p.code, 'HEALTHY');
    eq(p.actions.length, 0);
  });

  test('멈춘 워커는 재시작한다', () => {
    const p = healPlan({ health: health(), openOrders: 0, attempts: [], nowMs: NOW });
    eq(p.code, 'HEAL');
    eq(p.actions.join(','), 'RESTART_WORKER');
    eq(p.attempt, 1);
  });

  test('**열린 주문이 있으면 대조가 먼저다**', () => {
    const p = healPlan({ health: health(), openOrders: 2, attempts: [], nowMs: NOW });
    eq(p.actions[0], 'RECONCILE_FIRST');
    assert(/대조를 먼저/.test(p.reason), p.reason);
  });

  test('**열린 주문 수를 모르면 아무것도 하지 않는다**', () => {
    // 못 읽은 채로 워커를 갈아 끼우면 그 사이 체결을 아무도 안 본다.
    const p = healPlan({ health: health(), openOrders: null, attempts: [], nowMs: NOW });
    eq(p.code, 'HOLD');
    eq(p.actions.length, 0);
  });

  test('**시도 기록을 못 읽으면 다시 시도하지 않는다**', () => {
    // 0번으로 세면 무한 재시작이 된다.
    const p = healPlan({ health: health(), openOrders: 0, attempts: undefined, nowMs: NOW });
    eq(p.code, 'HOLD');
    assert(/몇 번째인지 모르는/.test(p.reason), p.reason);
  });

  test('**같은 원인으로 세 번 시도했으면 멈춘다**', () => {
    const attempts = Array.from({ length: MAX_ATTEMPTS }, (_, k) =>
      ({ trigger: 'STALE_HEARTBEAT', startedAtMs: NOW - (k + 1) * 60_000, outcome: 'FAILED' }));
    const p = healPlan({ health: health(), openOrders: 0, attempts, nowMs: NOW });
    eq(p.code, 'GIVE_UP');
    eq(p.actions.length, 0);
    assert(p.needsHuman.length > 0, '사람이 볼 것을 남긴다');
  });

  test('오래된 시도는 같은 사건으로 세지 않는다', () => {
    const attempts = Array.from({ length: MAX_ATTEMPTS }, (_, k) =>
      ({ trigger: 'STALE_HEARTBEAT', startedAtMs: NOW - ATTEMPT_WINDOW_MS - (k + 1) * 1000, outcome: 'FAILED' }));
    const p = healPlan({ health: health(), openOrders: 0, attempts, nowMs: NOW });
    eq(p.code, 'HEAL');
    eq(p.attempt, 1);
  });

  test('세 번째 시도부터는 재시작 대신 재배포로 올린다', () => {
    const attempts = [
      { trigger: 'STALE_HEARTBEAT', startedAtMs: NOW - 60_000, outcome: 'FAILED' },
      { trigger: 'STALE_HEARTBEAT', startedAtMs: NOW - 120_000, outcome: 'FAILED' },
    ];
    const p = healPlan({ health: health(), openOrders: 0, attempts, nowMs: NOW });
    eq(p.attempt, 3);
    eq(p.actions.join(','), 'REDEPLOY_WORKER');
  });

  test('**값을 바꿔야 하는 고장은 자동으로 손대지 않는다**', () => {
    // 다른 DB를 보고 있는 워커를 재시작해 봐야 같은 곳에 다시 붙는다.
    const h = health({
      code: 'DIFFERENT_DATABASE',
      findings: [{ code: 'DIFFERENT_DATABASE', severity: 'bad', detail: '다른 DB',
        autoFix: null, needsHuman: 'SUPABASE_URL이 웹과 다릅니다' }],
    } as any);
    const p = healPlan({ health: h, openOrders: 0, attempts: [], nowMs: NOW });
    eq(p.code, 'NEEDS_HUMAN');
    eq(p.actions.length, 0);
  });

  test('상태를 못 읽으면 만지지 않는다', () => {
    eq(healPlan({ health: undefined, openOrders: 0, attempts: [], nowMs: NOW }).code, 'HOLD');
  });

  // ── 고친 뒤 ──

  test('**명령이 0으로 끝난 것과 낫는 것은 다르다**', () => {
    const v = healVerdict({ commandOk: true, after: health(), before: 'STALE_HEARTBEAT' });
    eq(v.outcome, 'FAILED');
    eq(v.verified, false);
  });

  test('정말 나았으면 HEALED', () => {
    const v = healVerdict({ commandOk: true, after: healthy(), before: 'STALE_HEARTBEAT' });
    eq(v.outcome, 'HEALED');
    eq(v.verified, true);
  });

  test('복구 후 상태를 못 읽으면 나았다고 적지 않는다', () => {
    const v = healVerdict({ commandOk: true, after: undefined, before: 'STALE_HEARTBEAT' });
    eq(v.outcome, 'BLOCKED');
    eq(v.verified, false);
  });

  test('명령 자체가 실패하면 FAILED', () => {
    eq(healVerdict({ commandOk: false, after: healthy(), before: null }).outcome, 'FAILED');
  });

  // ── 배포 검증 ──

  test('여섯 가지가 다 맞아야 VERIFIED다', () => {
    const v = deployVerification({
      mainSha: 'abc1234', vercelSha: 'abc1234', flySha: 'abc1234',
      workerFresh: true, migrationsApplied: true,
    });
    eq(v.code, 'VERIFIED');
  });

  test('**Fly SHA가 비어 있는 것은 "같다"가 아니다**', () => {
    const v = deployVerification({
      mainSha: 'abc1234', vercelSha: 'abc1234', flySha: null,
      workerFresh: true, migrationsApplied: true,
    });
    eq(v.code, 'UNKNOWN');
    assert(/확인하지 못했습니다/.test(v.reason), v.reason);
  });

  test('마이그레이션이 안 됐으면 배포 완료가 아니다', () => {
    const v = deployVerification({
      mainSha: 'abc1234', vercelSha: 'abc1234', flySha: 'abc1234',
      workerFresh: true, migrationsApplied: false,
    });
    eq(v.code, 'MISMATCH');
    assert(/마이그레이션/.test(v.reason), v.reason);
  });

  test('워커가 죽어 있으면 배포 완료가 아니다', () => {
    const v = deployVerification({
      mainSha: 'abc1234', vercelSha: 'abc1234', flySha: 'abc1234',
      workerFresh: false, migrationsApplied: true,
    });
    eq(v.code, 'MISMATCH');
  });

  test('코드가 다르면 MISMATCH', () => {
    const v = deployVerification({
      mainSha: 'abc1234', vercelSha: 'abc1234', flySha: 'def5678',
      workerFresh: true, migrationsApplied: true,
    });
    eq(v.code, 'MISMATCH');
    assert(/Fly SHA/.test(v.reason), v.reason);
  });

  // ══════════════════════════════════════════════════════════════
  //  관측하지 않은 Vercel SHA를 main으로 채우던 자리 (P0)
  // ══════════════════════════════════════════════════════════════
  //
  // `ops-runner`가 `vercelSha: mainSha`를 넘기고 있었다. 관측한 적 없는 값을
  // main과 같게 만들어 넘긴 것이라 **Vercel 검사는 언제나 통과**했고, 같은
  // 값이 장부(`deployment_verifications.vercel_sha`)에도 적혔다.
  //
  // 2026-09-13에 Vercel만 6시간 넘게 옛 커밋이었다 — 그때 DEPLOY가 돌았다면
  // 이 자리는 초록으로 기록됐을 것이다.

  const MAIN = 'c61271eb58472a11d684799ea959765fe4618831';
  const OLD = 'ae069124ec3330dde7b0b7073d966b6b5c66c4e6';
  const okRest = { workerFresh: true, migrationsApplied: true };

  test('관측값이 main과 같으면 VERIFIED다', () => {
    const v = deployVerification({ mainSha: MAIN, vercelSha: MAIN, flySha: MAIN, ...okRest });
    eq(v.code, 'VERIFIED');
  });

  test('관측값이 다르면 MISMATCH다 — 그날의 값으로 확인한다', () => {
    const v = deployVerification({ mainSha: MAIN, vercelSha: OLD, flySha: MAIN, ...okRest });
    eq(v.code, 'MISMATCH');
    assert(/Vercel SHA/.test(v.reason), v.reason);
  });

  test('★ 관측하지 못하면 UNKNOWN이다 — 성공이 아니다', () => {
    const v = deployVerification({ mainSha: MAIN, vercelSha: null, flySha: MAIN, ...okRest });
    eq(v.code, 'UNKNOWN');
    assert(/확인하지 못했습니다/.test(v.reason), v.reason);
  });

  test('★ 빈 문자열도 관측이 아니다', () => {
    eq(deployVerification({ mainSha: MAIN, vercelSha: '', flySha: MAIN, ...okRest }).code, 'UNKNOWN');
    eq(deployVerification({ mainSha: MAIN, vercelSha: '   ', flySha: MAIN, ...okRest }).code, 'UNKNOWN');
  });

  // ── 응답에서 SHA를 읽는 쪽 ──
  test('정상 응답에서 Vercel SHA를 읽는다', () => {
    eq(observedVercelSha({ vercel: { sha: MAIN } }), MAIN);
  });

  test('대문자는 소문자로 맞춘다 — 비교가 대소문자로 갈리지 않게', () => {
    eq(observedVercelSha({ vercel: { sha: MAIN.toUpperCase() } }), MAIN);
  });

  test('★ API가 죽었거나 본문이 없으면 null이다', () => {
    for (const body of [null, undefined, {}, { vercel: null }, { vercel: {} }, '', 0, []] as any[]) {
      eq(observedVercelSha(body), null, JSON.stringify(body ?? null));
    }
  });

  test('★ 파싱은 됐는데 SHA 모양이 아니면 null이다 — 소음을 관측으로 적지 않는다', () => {
    for (const sha of ['unknown', 'null', 'undefined', 'error', 'main', '123', 'zzzzzzz',
      'not-a-sha-value', '<html>', MAIN + 'ff']) {
      eq(observedVercelSha({ vercel: { sha } }), null, sha);
    }
  });

  test('★ 문자열이 아니면 null이다', () => {
    for (const sha of [123, true, {}, [], { sha: MAIN }] as any[]) {
      eq(observedVercelSha({ vercel: { sha } }), null, JSON.stringify(sha));
    }
  });

  test('짧은 커밋 표기(7자)도 관측으로 받는다', () => {
    eq(observedVercelSha({ vercel: { sha: 'c61271e' } }), 'c61271e');
  });

  test('★ 읽지 못한 것을 넘기면 판정이 UNKNOWN으로 이어진다 — 관측 실패가 초록이 되지 않는다', () => {
    const sha = observedVercelSha({ vercel: { sha: 'unknown' } });   // 소음
    eq(sha, null);
    eq(deployVerification({ mainSha: MAIN, vercelSha: sha, flySha: MAIN, ...okRest }).code, 'UNKNOWN');
  });
}
