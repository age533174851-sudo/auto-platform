// src/lib/engine/killSwitchRecovery.test.ts
//
// **거래소 조회가 실패해도 킬스위치 자가복구는 돌아야 한다.**
// 그리고 **못 읽은 것으로 중복 잡을 만들지 않아야 한다.**

import { test, eq, assert } from '../../test/harness';
import { killSwitchRecoveryVerdict } from './killSwitchRecovery';

const ACTIVE = { data: { active: true, action_mode: 'BC' }, error: null };
const OFF = { data: { active: false, action_mode: 'BC' }, error: null };
const NO_JOBS = { data: [], error: null };
const ONE_JOB = { data: [{ id: 'job-1' }], error: null };

export function runKillSwitchRecoveryTests() {
  console.log('[킬스위치 자가복구 — 거래소 조회 실패와 무관하게, 중복 없이]');

  // ── 소유자가 요청한 다섯 가지 ──────────────────────────────────
  test('★ ① 포지션 조회 실패 + 킬스위치 active + 기존 잡 없음 ⇒ 복구 잡 1건', () => {
    // 이 판정에는 거래소 포지션 조회 결과가 **들어오지 않는다.**
    // 그것이 이 수정의 핵심이다 — 둘을 묶어 두면 거래소가 흔들릴 때
    // 정확히 킬스위치가 안 돈다.
    const v = killSwitchRecoveryVerdict({ state: ACTIVE, existing: NO_JOBS });
    eq(v.code, 'CREATE', '거래소 조회 실패와 무관하게 만들어야 합니다');
    eq(v.create, true);
    eq(v.actionMode, 'BC');
  });

  test('★ ② 기존 잡이 있으면 0건', () => {
    const v = killSwitchRecoveryVerdict({ state: ACTIVE, existing: ONE_JOB });
    eq(v.code, 'ALREADY');
    eq(v.create, false, '중복 잡을 만들었습니다');
  });

  test('★ ③ 기존 잡 조회 실패 ⇒ 0건 + 명시 오류', () => {
    const v = killSwitchRecoveryVerdict({
      state: ACTIVE, existing: { data: null, error: { message: 'timeout' } },
    });
    eq(v.code, 'JOBS_UNREADABLE', '못 읽은 것을 "0건"으로 읽었습니다');
    eq(v.create, false, '모르는 채로 중복 잡을 만들었습니다');
    assert(v.reason.includes('timeout'), '사유에 원인이 없습니다');
    assert(v.reason.includes('중복'), '왜 안 만들었는지가 사유에 없습니다');
  });

  test('★ ④ 연속 틱 ⇒ 중복 0건 (이미 만든 잡이 보이면 더 만들지 않는다)', () => {
    const first = killSwitchRecoveryVerdict({ state: ACTIVE, existing: NO_JOBS });
    eq(first.create, true);
    // 1틱 뒤: 방금 만든 잡이 PENDING으로 보인다
    const second = killSwitchRecoveryVerdict({ state: ACTIVE, existing: { data: [{ id: 'job-1' }], error: null } });
    eq(second.create, false, '연속 틱에서 중복 잡이 생겼습니다');
    const third = killSwitchRecoveryVerdict({ state: ACTIVE, existing: { data: [{ id: 'job-1' }], error: null } });
    eq(third.create, false);
  });

  // ⑤(throttle이 긴급 복구를 지연시키지 않음)는 워커 배선 쪽 성질이라
  // `scripts/check-worker-egress.mjs`가 센다 — 자가복구 폴러가 Ghost Sync의
  // 60초 주기 뒤에 있으면 실패한다.

  // ── 못 읽은 것을 "꺼짐"으로 읽지 않는다 ─────────────────────────
  test('★ 킬스위치 상태 조회 실패를 "꺼짐"으로 읽지 않는다', () => {
    const v = killSwitchRecoveryVerdict({
      state: { data: null, error: { message: '402 Payment Required' } }, existing: NO_JOBS,
    });
    eq(v.code, 'STATE_UNREADABLE', '못 읽은 상태를 NOT_ACTIVE로 읽었습니다');
    eq(v.create, false);
    assert(v.reason.includes('402'), '사유에 원인이 없습니다');
  });

  test('읽었고 꺼져 있으면 NOT_ACTIVE다 — 못 읽은 것과 구분된다', () => {
    const v = killSwitchRecoveryVerdict({ state: OFF, existing: NO_JOBS });
    eq(v.code, 'NOT_ACTIVE');
    eq(v.create, false);
  });

  test('줄이 아예 없으면(연결에 킬스위치 설정 없음) NOT_ACTIVE다', () => {
    eq(killSwitchRecoveryVerdict({ state: { data: null, error: null }, existing: NO_JOBS }).code, 'NOT_ACTIVE');
  });

  test('응답 자체가 없으면 못 읽은 것이다', () => {
    eq(killSwitchRecoveryVerdict({ state: null, existing: NO_JOBS }).code, 'STATE_UNREADABLE');
    eq(killSwitchRecoveryVerdict({ state: ACTIVE, existing: null }).code, 'JOBS_UNREADABLE');
  });

  test('★ 잡 목록이 배열이 아니면 0건으로 읽지 않는다', () => {
    for (const bad of [{ data: {}, error: null }, { data: 'none', error: null }, { data: null, error: null }]) {
      const v = killSwitchRecoveryVerdict({ state: ACTIVE, existing: bad as any });
      eq(v.code, 'JOBS_UNREADABLE', `비배열 응답(${JSON.stringify(bad.data)})을 0건으로 읽었습니다`);
      eq(v.create, false);
    }
  });

  test('active가 true가 아닌 값(1, "true")은 켜진 것으로 읽지 않는다', () => {
    for (const a of [1, 'true', 'yes', {}]) {
      const v = killSwitchRecoveryVerdict({ state: { data: { active: a }, error: null }, existing: NO_JOBS });
      eq(v.create, false, `active=${JSON.stringify(a)}를 켜진 것으로 읽었습니다`);
    }
  });

  test('action_mode가 비면 BC로 적되, 만든다는 판단은 바뀌지 않는다', () => {
    const v = killSwitchRecoveryVerdict({
      state: { data: { active: true, action_mode: null }, error: null }, existing: NO_JOBS,
    });
    eq(v.code, 'CREATE');
    eq(v.actionMode, 'BC');
  });

  test('만들지 않는 모든 판정은 actionMode가 null이다 — 쓸 수 없는 값을 흘리지 않는다', () => {
    for (const v of [
      killSwitchRecoveryVerdict({ state: OFF, existing: NO_JOBS }),
      killSwitchRecoveryVerdict({ state: ACTIVE, existing: ONE_JOB }),
      killSwitchRecoveryVerdict({ state: { data: null, error: 'x' }, existing: NO_JOBS }),
      killSwitchRecoveryVerdict({ state: ACTIVE, existing: { data: null, error: 'x' } }),
    ]) {
      eq(v.create, false);
      eq(v.actionMode, null);
    }
  });

  test('★ create가 true인 경우는 CREATE 하나뿐이다', () => {
    const all = [
      killSwitchRecoveryVerdict({ state: ACTIVE, existing: NO_JOBS }),
      killSwitchRecoveryVerdict({ state: ACTIVE, existing: ONE_JOB }),
      killSwitchRecoveryVerdict({ state: OFF, existing: NO_JOBS }),
      killSwitchRecoveryVerdict({ state: { data: null, error: 'x' }, existing: NO_JOBS }),
      killSwitchRecoveryVerdict({ state: ACTIVE, existing: { data: null, error: 'x' } }),
    ];
    eq(all.filter((v) => v.create).length, 1);
    eq(all.filter((v) => v.create)[0].code, 'CREATE');
  });

  test('모든 판정에 사유가 있다 — 조용히 건너뛰지 않는다', () => {
    for (const v of [
      killSwitchRecoveryVerdict({ state: ACTIVE, existing: NO_JOBS }),
      killSwitchRecoveryVerdict({ state: OFF, existing: NO_JOBS }),
      killSwitchRecoveryVerdict({ state: null, existing: null }),
    ]) assert(v.reason.trim().length > 0, `사유가 비었습니다: ${v.code}`);
  });
}
