// src/lib/ops/opsCommand.test.ts
//
// **사용자는 명령만 한다.** 그 명령을 잘못 읽으면 점검하려던 사람이
// 배포를 돌린다. 그리고 결과를 잘못 합치면 "확인 못 함"이 초록으로 바뀐다 —
// 이 저장소에서 가장 자주 고친 고장이 정확히 그거다.

import { test, eq, assert } from '../../test/harness';
import { parseOpsCommand, opsVerdictOf, specOf, type StepResult } from './opsCommand';
import { bootstrapStatus } from './opsBootstrap';

const step = (over: Partial<StepResult>): StepResult => ({
  step: 'worker', label: '워커', state: 'PASS', detail: '', did: [], blockedReason: null, ...over,
} as StepResult);

export function runOpsCommandTests() {
  console.log('[운영 명령 — 사람은 명령만 한다]');

  test('한국어 명령을 읽는다', () => {
    eq(parseOpsCommand('전체 점검해'), 'CHECK_ALL');
    eq(parseOpsCommand('배포해'), 'DEPLOY');
    eq(parseOpsCommand('테스트넷 검증해'), 'VERIFY_TESTNET');
    eq(parseOpsCommand('복구해'), 'RECOVER');
    eq(parseOpsCommand('지금 중지해'), 'STOP_NOW');
    eq(parseOpsCommand('LIVE_SMALL 승인'), 'APPROVE_LIVE_SMALL');
  });

  test('**모르는 말은 아무 명령으로도 읽지 않는다**', () => {
    // 비슷해 보인다고 고르면 점검하려던 사람이 배포를 돌린다.
    eq(parseOpsCommand('오늘 수익 얼마야'), null);
    eq(parseOpsCommand(''), null);
    eq(parseOpsCommand('   '), null);
  });

  test('위험한 명령을 먼저 읽는다', () => {
    // "지금 중지해줘, 그리고 점검해"에서 중지가 먼저다.
    eq(parseOpsCommand('지금 중지해줘 그리고 점검해'), 'STOP_NOW');
  });

  test('실제 자금이 걸린 명령만 승인이 필요하다', () => {
    eq(specOf('APPROVE_LIVE_SMALL')!.needsApproval, true);
    eq(specOf('CHECK_ALL')!.needsApproval, false);
    eq(specOf('CHECK_ALL')!.mutates, false);
    eq(specOf('RECOVER')!.mutates, true);
  });

  // ── 판정 합치기 ──

  test('전부 정상이면 PASS', () => {
    const r = opsVerdictOf('CHECK_ALL', [step({}), step({ step: 'ledger', label: '장부' })]);
    eq(r.verdict, 'PASS');
    eq(r.needsHuman.length, 0);
  });

  test('**하나라도 확인 못 하면 PASS가 아니다**', () => {
    const r = opsVerdictOf('CHECK_ALL', [
      step({}), step({ step: 'ledger', label: '장부', state: 'UNKNOWN' }),
    ]);
    eq(r.verdict, 'UNKNOWN');
    assert(/정상이라는 뜻이 아닙니다/.test(r.summary), r.summary);
  });

  test('스스로 고쳤으면 SELF_HEALED로 적는다 — 사람이 한 일이 아니다', () => {
    const r = opsVerdictOf('RECOVER', [
      step({ state: 'SELF_HEALED', did: ['워커 재시작'] }),
      step({ step: 'orders', label: '주문' }),
    ]);
    eq(r.verdict, 'SELF_HEALED');
    assert(/자동으로 복구했습니다/.test(r.summary), r.summary);
  });

  test('막힌 것이 하나라도 있으면 BLOCKED이고 이유를 그대로 옮긴다', () => {
    const r = opsVerdictOf('CHECK_ALL', [
      step({}),
      step({ step: 'migrations', label: '마이그레이션', state: 'BLOCKED',
        blockedReason: 'DB 접속 권한이 연결되지 않았습니다' }),
      step({ step: 'ledger', label: '장부', state: 'UNKNOWN' }),
    ]);
    // BLOCKED가 UNKNOWN보다 먼저다 — 손댈 수 있는 것을 먼저 말한다.
    eq(r.verdict, 'BLOCKED');
    eq(r.needsHuman.length, 1);
    assert(/DB 접속 권한/.test(r.needsHuman[0]), r.needsHuman[0]);
  });

  test('본 것이 하나도 없으면 PASS가 아니다', () => {
    eq(opsVerdictOf('CHECK_ALL', []).verdict, 'UNKNOWN');
    eq(opsVerdictOf('CHECK_ALL', [step({ state: 'SKIPPED' })]).verdict, 'UNKNOWN');
  });

  // ── 권한 연결 ──

  const allOn = { dbUrl: true, flyToken: true, adminSecret: true, encryptionKey: true, serviceRole: true };

  test('전부 연결돼 있으면 사람이 할 일이 없다', () => {
    const b = bootstrapStatus(allOn);
    eq(b.code, 'READY');
    eq(b.missing.length, 0);
  });

  test('없는 권한만 이름으로 말한다 — **값은 적지 않는다**', () => {
    const b = bootstrapStatus({ ...allOn, dbUrl: false });
    eq(b.code, 'OPS_BOOTSTRAP_MISSING');
    eq(b.missing.length, 1);
    eq(b.missing[0].capability, 'MIGRATE');
    assert(/SUPABASE_DB_URL/.test(b.summary), b.summary);
    assert(!/=/.test(b.summary), '값을 적지 않는다');
  });

  test('없으면 무엇을 못 하는지 같이 말한다', () => {
    const b = bootstrapStatus({ ...allOn, flyToken: false });
    assert(/스스로 되살리지 못합니다/.test(b.missing[0].withoutIt), b.missing[0].withoutIt);
  });

  test('**청산 감시에 새 시크릿을 요구하지 않는다**', () => {
    // EXIT_MONITOR_SECRET은 없앤 값이다. 워커가 이미 가진 ADMIN_SECRET을 쓴다.
    const b = bootstrapStatus(allOn);
    assert(!/EXIT_MONITOR_SECRET/.test(JSON.stringify(b)), 'EXIT_MONITOR_SECRET을 다시 요구하면 안 된다');
  });
}
