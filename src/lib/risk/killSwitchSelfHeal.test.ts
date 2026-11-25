// src/lib/risk/killSwitchSelfHeal.test.ts
//
// 이 시험이 지키는 한 문장: **못 읽은 것을 '아니다'로 적지 않는다.**
// ★은 이 모듈이 있는 이유 그 자체다 — 지우면 #514의 구멍이 돌아온다.
import { test, eq, assert } from '../../test/harness';
import {
  killSwitchSelfHealVerdict, connectionScanVerdict,
  type SelfHealLookup, type KillSwitchStateRow,
} from './killSwitchSelfHeal';

const st = (rows: KillSwitchStateRow[]): SelfHealLookup<KillSwitchStateRow> => ({ ok: true, rows });
const stFail = (): SelfHealLookup<KillSwitchStateRow> => ({ ok: false });
const jobs = (n: number): SelfHealLookup<unknown> => ({ ok: true, rows: Array.from({ length: n }, (_, i) => ({ id: `j${i}` })) });
const jobsFail = (): SelfHealLookup<unknown> => ({ ok: false });

export function runKillSwitchSelfHealTests(): void {
  console.log('\n[킬스위치 자가복구 판정 — #514]');

  // ── 연결 목록 ──
  test('★ 연결 목록 조회가 실패하면 "연결 없음"이 아니다', () => {
    const v = connectionScanVerdict({ rows: null, failed: true });
    eq(v.ok, false);
    eq(v.attention, true, '조용히 끝내면 그 회차의 자가복구가 통째로 빈다');
    eq(v.count, 0);
  });

  test('★ 배열이 아닌 응답도 "읽은 것"으로 치지 않는다', () => {
    for (const rows of [null, undefined, {}, 'x', 0]) {
      const v = connectionScanVerdict({ rows, failed: false });
      eq(v.ok, false, `rows=${JSON.stringify(rows)}`);
      eq(v.attention, true);
    }
  });

  test('연결 0개는 확인된 0개다 — 경고하지 않는다', () => {
    const v = connectionScanVerdict({ rows: [], failed: false });
    eq(v.ok, true); eq(v.attention, false); eq(v.count, 0);
  });

  test('연결 3개를 읽으면 그대로 센다', () => {
    const v = connectionScanVerdict({ rows: [1, 2, 3], failed: false });
    eq(v.ok, true); eq(v.attention, false); eq(v.count, 3);
  });

  // ── 킬스위치 상태 ──
  test('★★ 킬스위치 상태를 못 읽으면 "꺼졌다"로 읽지 않는다', () => {
    const v = killSwitchSelfHealVerdict({ state: stFail() });
    eq(v.code, 'UNVERIFIED');
    eq(v.insert, false, '모르는 상태에서 청산 job을 넣지 않는다');
    eq(v.attention, true, '조용히 넘어가면 켜진 킬스위치가 방치된다');
  });

  test('★ 상태를 아예 조회하지 않았으면 UNVERIFIED다', () => {
    for (const s of [null, undefined]) {
      const v = killSwitchSelfHealVerdict({ state: s as any });
      eq(v.code, 'UNVERIFIED'); eq(v.insert, false); eq(v.attention, true);
    }
  });

  test('★ active가 boolean이 아니면 해석하지 않는다', () => {
    for (const active of [null, undefined, 'true', 1, 0, {}]) {
      const v = killSwitchSelfHealVerdict({ state: st([{ active }]) });
      eq(v.code, 'UNVERIFIED', `active=${JSON.stringify(active)}`);
      eq(v.insert, false);
      eq(v.attention, true);
    }
  });

  test('행이 없으면 한 번도 발동하지 않은 것 — 경고하지 않는다', () => {
    const v = killSwitchSelfHealVerdict({ state: st([]) });
    eq(v.code, 'NOT_ACTIVE'); eq(v.insert, false); eq(v.attention, false);
  });

  test('active:false는 조회로 확인한 꺼짐이다', () => {
    const v = killSwitchSelfHealVerdict({ state: st([{ active: false }]) });
    eq(v.code, 'NOT_ACTIVE'); eq(v.insert, false); eq(v.attention, false);
  });

  test('꺼진 연결에는 잡 조회가 필요하지 않다', () => {
    const v = killSwitchSelfHealVerdict({ state: st([{ active: false }]), jobs: null });
    eq(v.code, 'NOT_ACTIVE'); eq(v.attention, false);
  });

  // ── 기존 잡 ──
  test('★★ 기존 잡을 못 읽으면 "없음"으로 읽고 또 넣지 않는다', () => {
    const v = killSwitchSelfHealVerdict({ state: st([{ active: true }]), jobs: jobsFail() });
    eq(v.code, 'UNVERIFIED');
    eq(v.insert, false, '중복 KILL_SWITCH_EXECUTE가 난다');
    eq(v.attention, true);
  });

  test('★ 켜졌는데 잡을 조회하지 않았으면 UNVERIFIED다', () => {
    const v = killSwitchSelfHealVerdict({ state: st([{ active: true }]), jobs: null });
    eq(v.code, 'UNVERIFIED'); eq(v.insert, false); eq(v.attention, true);
  });

  test('★ 잡 응답이 배열이 아니면 "없음"이 아니다', () => {
    const v = killSwitchSelfHealVerdict({
      state: st([{ active: true }]), jobs: { ok: true, rows: null as any },
    });
    eq(v.code, 'UNVERIFIED'); eq(v.insert, false); eq(v.attention, true);
  });

  test('기존 잡이 있으면 건드리지 않는다', () => {
    const v = killSwitchSelfHealVerdict({ state: st([{ active: true }]), jobs: jobs(1) });
    eq(v.code, 'ALREADY_ENSURED'); eq(v.insert, false); eq(v.attention, false);
  });

  test('기존 잡이 둘이어도 더 넣지 않는다', () => {
    const v = killSwitchSelfHealVerdict({ state: st([{ active: true }]), jobs: jobs(2) });
    eq(v.code, 'ALREADY_ENSURED'); eq(v.insert, false);
  });

  // ── 실제로 넣는 경우 ──
  test('★ 켜졌고 기존 잡이 0개면 하나 보장한다', () => {
    const v = killSwitchSelfHealVerdict({
      state: st([{ active: true, action_mode: 'BCO' }]), jobs: jobs(0),
    });
    eq(v.code, 'ENSURE_JOB'); eq(v.insert, true); eq(v.attention, false);
    eq(v.actionMode, 'BCO');
  });

  test('action_mode를 못 읽으면 지어내지 않는다 (null)', () => {
    for (const m of [null, undefined, '', '   ', 7, {}]) {
      const v = killSwitchSelfHealVerdict({
        state: st([{ active: true, action_mode: m }]), jobs: jobs(0),
      });
      eq(v.code, 'ENSURE_JOB', `action_mode=${JSON.stringify(m)}`);
      eq(v.actionMode, null);
    }
  });

  test('action_mode의 앞뒤 공백은 떼고 쓴다', () => {
    const v = killSwitchSelfHealVerdict({
      state: st([{ active: true, action_mode: '  BC  ' }]), jobs: jobs(0),
    });
    eq(v.actionMode, 'BC');
  });

  // ── 전체 불변식 ──
  test('★★ insert는 ENSURE_JOB에서만 참이다', () => {
    const cases: Array<{ state: any; jobs?: any }> = [
      { state: stFail() }, { state: null }, { state: st([]) },
      { state: st([{ active: false }]) }, { state: st([{ active: 'true' }]) },
      { state: st([{ active: true }]), jobs: jobsFail() },
      { state: st([{ active: true }]), jobs: null },
      { state: st([{ active: true }]), jobs: jobs(1) },
      { state: st([{ active: true }]), jobs: jobs(0) },
    ];
    for (const c of cases) {
      const v = killSwitchSelfHealVerdict(c);
      eq(v.insert, v.code === 'ENSURE_JOB', `code=${v.code}`);
    }
  });

  test('★★ UNVERIFIED는 반드시 attention이다 — 조용한 미확인이 없다', () => {
    const cases: Array<{ state: any; jobs?: any }> = [
      { state: stFail() }, { state: null }, { state: undefined },
      { state: st([{ active: null }]) }, { state: st([{ active: 1 }]) },
      { state: st([{ active: true }]), jobs: jobsFail() },
      { state: st([{ active: true }]), jobs: null },
      { state: st([{ active: true }]), jobs: { ok: true, rows: 'x' as any } },
    ];
    for (const c of cases) {
      const v = killSwitchSelfHealVerdict(c);
      eq(v.code, 'UNVERIFIED');
      eq(v.attention, true, `code=${v.code} reason=${v.reason}`);
    }
  });

  test('★ 판정 문구에 조회 오류 원문이 섞이지 않는다', () => {
    // 오류는 **있었는지 여부만** 받는다. 원문을 담으면 알림으로 흘러가고
    // DB 오류에는 접속 문자열이 섞일 수 있다.
    const v = killSwitchSelfHealVerdict({ state: stFail() });
    assert(!/password|postgres:\/\/|key=|secret/i.test(v.reason), v.reason);
    const c = connectionScanVerdict({ rows: null, failed: true });
    assert(!/password|postgres:\/\/|key=|secret/i.test(c.reason), c.reason);
  });
}
