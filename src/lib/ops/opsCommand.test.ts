// src/lib/ops/opsCommand.test.ts
//
// **사용자는 명령만 한다.** 그 명령을 잘못 읽으면 점검하려던 사람이
// 배포를 돌린다. 그리고 결과를 잘못 합치면 "확인 못 함"이 초록으로 바뀐다 —
// 이 저장소에서 가장 자주 고친 고장이 정확히 그거다.

import { test, eq, assert } from '../../test/harness';
import { parseOpsCommand, opsVerdictOf, specOf, type StepResult } from './opsCommand';
import { bootstrapStatus, credentialStateOf } from './opsBootstrap';

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

  test('전부 정상이면 READY', () => {
    const r = opsVerdictOf('CHECK_ALL', [step({}), step({ step: 'ledger', label: '장부' })]);
    eq(r.verdict, 'READY');
    eq(r.needsHuman.length, 0);
  });

  test('**하나라도 확인 못 하면 READY가 아니다**', () => {
    const r = opsVerdictOf('CHECK_ALL', [
      step({}), step({ step: 'ledger', label: '장부', state: 'UNKNOWN' }),
    ]);
    // '모름'과 '막힘'은 사용자 입장에서 대응이 같다 — 지금 매매하면 안 된다.
    eq(r.verdict, 'BLOCKED');
    assert(/정상이라는 뜻이 아닙니다/.test(r.summary), r.summary);
  });

  test('**권한 연결만 남았으면 BOOTSTRAP_REQUIRED다** — 그 밖의 고장과 구분한다', () => {
    // 최초 1회 사람이 할 일과 시스템이 고쳐야 할 것을 한 통에 담으면
    // 사용자는 매번 같은 목록을 보게 되고, 그러면 곧 안 본다.
    const r = opsVerdictOf('CHECK_ALL', [
      step({}),
      step({ step: 'secrets', label: '권한 연결', state: 'BLOCKED', kind: 'BOOTSTRAP',
        blockedReason: 'SUPABASE_DB_URL (GitHub Secrets)' }),
    ]);
    eq(r.verdict, 'BOOTSTRAP_REQUIRED');
    assert(/최초 1회/.test(r.summary), r.summary);
  });

  test('권한 말고 다른 것도 막혀 있으면 BOOTSTRAP_REQUIRED가 아니다', () => {
    const r = opsVerdictOf('CHECK_ALL', [
      step({ step: 'secrets', label: '권한 연결', state: 'BLOCKED', blockedReason: 'X' }),
      step({ step: 'worker', label: '워커', state: 'BLOCKED', blockedReason: '멈춤' }),
    ]);
    eq(r.verdict, 'BLOCKED');
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
    // BLOCKED가 먼저다 — 손댈 수 있는 것을 먼저 말한다.
    eq(r.verdict, 'BLOCKED');
    eq(r.needsHuman.length, 1);
    assert(/DB 접속 권한/.test(r.needsHuman[0]), r.needsHuman[0]);
  });

  test('본 것이 하나도 없으면 READY가 아니다', () => {
    eq(opsVerdictOf('CHECK_ALL', []).verdict, 'BLOCKED');
    eq(opsVerdictOf('CHECK_ALL', [step({ state: 'SKIPPED' })]).verdict, 'BLOCKED');
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

  // ── 실제로 써 본 결과 ──

  test('**값이 있는 것과 그 값으로 되는 것은 다르다**', () => {
    // 만료된 토큰은 있는데 안 된다. 없는 것과 대응이 다르다.
    const b = bootstrapStatus({
      ...allOn,
      probes: [{ credential: 'FLY_API_TOKEN', state: 'INVALID', checkedAtMs: 1, detail: null }],
    });
    eq(b.code, 'OPS_BOOTSTRAP_MISSING');
    assert(/만료·권한 부족/.test(b.missing[0].missing[0]), b.missing[0].missing[0]);
  });

  test('실제로 써 본 결과가 추측을 이긴다', () => {
    // 화면(Vercel)은 GitHub Secrets를 볼 수 없다. 그래서 dbUrl:false여도
    // 실행기가 CONNECTED로 적었으면 그게 사실이다.
    const b = bootstrapStatus({
      ...allOn, dbUrl: false,
      probes: [{ credential: 'SUPABASE_DB_URL', state: 'CONNECTED', checkedAtMs: 1, detail: null }],
    });
    eq(b.code, 'READY');
  });

  test('확인 기록이 없으면 없는 대로 읽는다 — 아마 있겠지로 읽지 않는다', () => {
    eq(credentialStateOf(null, 'FLY_API_TOKEN'), 'UNKNOWN');
    eq(credentialStateOf([], 'FLY_API_TOKEN'), 'UNKNOWN');
    eq(credentialStateOf([{ credential: 'FLY_API_TOKEN', state: 'CONNECTED', checkedAtMs: 1, detail: null }],
      'FLY_API_TOKEN'), 'CONNECTED');
  });

  test('MIGRATE가 없으면 신규 진입이 막힌다고 말한다', () => {
    const b = bootstrapStatus({ ...allOn, dbUrl: false });
    assert(/신규 자동매매 진입이 막힙니다/.test(b.missing[0].withoutIt), b.missing[0].withoutIt);
    // **이미 열린 포지션의 청산·보호는 계속 동작한다**
    assert(/청산·보호는 계속/.test(b.missing[0].withoutIt), b.missing[0].withoutIt);
  });

  test('**값이 어긋난 것은 BOOTSTRAP_REQUIRED가 아니다**', () => {
    // 권한을 연결해도 안 풀린다. 둘을 섞으면 사용자는 연결한 뒤에도
    // 같은 화면을 보게 되고, 그러면 이 화면을 안 믿게 된다.
    const r = opsVerdictOf('CHECK_ALL', [
      step({}),
      step({ step: 'secrets', label: '권한 연결', state: 'BLOCKED', kind: 'FAULT',
        blockedReason: '암호화 키가 웹과 워커에서 다릅니다' }),
    ]);
    eq(r.verdict, 'BLOCKED');
  });

  test('종류를 안 적으면 권한 문제로 보지 않는다', () => {
    // 기본값은 FAULT다 — 권한 문제라고 말하려면 그렇다고 적어야 한다.
    const r = opsVerdictOf('CHECK_ALL', [
      step({ step: 'secrets', label: '권한 연결', state: 'BLOCKED', blockedReason: 'X' }),
    ]);
    eq(r.verdict, 'BLOCKED');
  });
  console.log('[운영 명령 — 시크릿 동기화]');

  test('"시크릿 동기화해"를 읽는다', () => {
    eq(parseOpsCommand('시크릿 동기화해'), 'SYNC_SECRETS');
    eq(parseOpsCommand('시크릿 맞춰줘'), 'SYNC_SECRETS');
    eq(parseOpsCommand('sync secrets'), 'SYNC_SECRETS');
  });

  test('"지금 중지"가 시크릿보다 먼저 걸린다', () => {
    // 위험한 것이 먼저 걸려야 한다.
    eq(parseOpsCommand('지금 중지하고 시크릿 동기화해'), 'STOP_NOW');
  });

  test('시크릿 동기화는 값을 바꾸지만 승인을 요구하지 않는다', () => {
    // 값이 한 곳(GitHub Secrets)에서만 오고 여러 번 해도 결과가 같다.
    // 승인을 붙이면 그 승인이 곧 사람이 눌러야 할 버튼이 된다.
    const s = specOf('SYNC_SECRETS')!;
    eq(s.mutates, true);
    eq(s.needsApproval, false);
    assert(s.steps.includes('secrets'), s.steps.join(','));
  });

}
