// src/lib/runtime/executorEvidence.test.ts
//
// 지키는 것
//  1. **못 읽은 것을 '정상'이나 0으로 적지 않는다** — readFailed는 unknown
//  2. 줄이 없는 것(absent)과 못 읽은 것(unknown)을 가른다
//  3. readFailed면 **줄에서 아무 값도 가져오지 않는다** (낡은 값을 확인된
//     값으로 싣지 않는다)
//  4. 표에 칸이 더 생겨도 응답에 저절로 실리지 않는다 (칸을 골라 담는다)
//  5. 임계값을 여기서 다시 적지 않는다 — `judgeExecutor`의 판정을 그대로 쓴다
import { test, assert, eq } from '../../test/harness';
import { executorEvidenceFrom, readExecutorEvidence } from './executorEvidence';
import { DEGRADED_AFTER_MS, STOPPED_AFTER_MS } from '../jobs/executorHealth';

const NOW = Date.parse('2026-10-31T18:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const row = (o: Record<string, unknown> = {}) => ({
  worker_id: 'w-1', last_seen: iso(1_000), status: 'running',
  current_task: 'jobs+monitor', error_count: 0,
  provider: 'fly', version: 'abc1234', region: 'nrt',
  machine_id: 'm-9', started_at: iso(600_000), tick_count: 42, startup_ok: true,
  ...o,
});

export function runExecutorEvidenceTests() {
  test('★★ 조회 실패를 정상이나 0으로 적지 않는다', () => {
    const e = executorEvidenceFrom(null, NOW, true);
    eq(e.status, 'unknown', '못 읽은 것은 unknown이다');
    eq(e.ageSec, null, '**0이 아니라 null이다**');
    eq(e.canQueue, false, '확인 못 한 것으로 주문을 보내지 않는다');
    assert(typeof e.reason === 'string' && e.reason.length > 0, '이유를 적는다');
  });

  test('★★ 줄이 없는 것(absent)과 못 읽은 것(unknown)을 가른다', () => {
    eq(executorEvidenceFrom(null, NOW, false).status, 'absent', '행이 없다');
    eq(executorEvidenceFrom(null, NOW, true).status, 'unknown', '조회 실패');
  });

  test('★★ 조회 실패면 줄에서 아무 값도 가져오지 않는다', () => {
    // 낡거나 반쯤 찬 객체를 들고 있을 수 있다. 그것을 실으면 "확인하지
    // 못한 것"이 "확인한 값"으로 읽힌다.
    const e = executorEvidenceFrom(row(), NOW, true);
    eq(e.status, 'unknown', 'unknown이다');
    for (const k of ['lastSeen', 'version', 'provider', 'region', 'machineId', 'startedAt'] as const) {
      eq(e[k], null, `${k}는 null이다`);
    }
    eq(e.tickCount, null, 'tickCount도 null이다');
    eq(e.workerId, null, 'workerId도 null이다');
  });

  test('★ 살아 있으면 줄이 적은 값을 그대로 싣는다', () => {
    const e = executorEvidenceFrom(row(), NOW, false);
    eq(e.status, 'running', '정상');
    eq(e.version, 'abc1234', '돌고 있는 커밋');
    eq(e.region, 'nrt', '어느 지역');
    eq(e.provider, 'fly', '어디서 도는가 — 서버가 준다');
    eq(e.canQueue, true, '주문 가능');
    eq(e.reason, null, '정상이면 이유는 null (빈 문자열이 아니다)');
  });

  test('★★ 임계값을 여기서 다시 적지 않는다 — judgeExecutor를 따른다', () => {
    eq(executorEvidenceFrom(row({ last_seen: iso(DEGRADED_AFTER_MS + 1_000) }), NOW).status,
      'degraded', '지연');
    eq(executorEvidenceFrom(row({ last_seen: iso(STOPPED_AFTER_MS + 1_000) }), NOW).status,
      'stopped', '끊김');
  });

  test('★★ 시각이 없으면 "방금"이 아니라 "모름"이다', () => {
    const e = executorEvidenceFrom(row({ last_seen: null }), NOW, false);
    eq(e.ageSec, null, 'null이다');
    assert(e.status !== 'running', `시각 없이 정상이라고 적지 않는다 (${e.status})`);
  });

  test('★★ 표에 칸이 더 생겨도 응답에 저절로 실리지 않는다', async () => {
    // `select('*')`를 펼쳐 담으면 **다음에 추가되는 칸이 뭐든 밖으로 나간다.**
    const sb = { from: () => ({ select: () => ({ order: () => ({ limit: () => ({
      maybeSingle: async () => ({
        data: { ...row(), service_role_key: 'MUST-NOT-APPEAR', some_future_column: 'nope' },
        error: null,
      }),
    }) }) }) }) };
    const e = await readExecutorEvidence(sb as any, NOW);
    eq(e.status, 'running', '정상으로 읽는다');
    const text = JSON.stringify(e);
    assert(!text.includes('MUST-NOT-APPEAR'), '모르는 칸은 실리지 않는다');
    assert(!text.includes('some_future_column'), '새 칸도 실리지 않는다');
  });

  test('★★ 조회가 던져도 청산 감시를 멈추지 않는다 — unknown으로 드러난다', async () => {
    const boom = { from: () => { throw new Error('boom'); } };
    const e = await readExecutorEvidence(boom as any, NOW);
    eq(e.status, 'unknown', '조용히 정상이 되지 않는다');
    eq(e.canQueue, false, '주문도 막는다');
  });

  test('★★ error를 돌려주면 그 줄을 쓰지 않는다', async () => {
    const sb = { from: () => ({ select: () => ({ order: () => ({ limit: () => ({
      maybeSingle: async () => ({ data: row(), error: { message: 'rls' } }),
    }) }) }) }) };
    const e = await readExecutorEvidence(sb as any, NOW);
    eq(e.status, 'unknown', 'error면 unknown이다');
    eq(e.version, null, '오류인데 값을 싣지 않는다');
  });

  test('★ supabase가 없으면 unknown이다 (0건이 아니다)', async () => {
    eq((await readExecutorEvidence(null, NOW)).status, 'unknown', 'unknown');
  });
}
