// src/lib/portfolio/walletTruthView.test.ts
//
// **화면이 한 번에 서로 모순되는 세 문장을 말한 적이 있다.**
//
//   auth_required
//   이 환경에 연결된 계좌가 없습니다
//   다른 환경의 계좌 8개는 합산에서 제외
//
// 인증이 안 돼서 아무것도 못 읽었는데 "계좌가 없다"고 단정했고,
// 동시에 "8개"라는 숫자를 어디선가 만들어 냈다. 그리고 `auth_required`는
// 서버 내부 코드다 — 사용자에게 보여 줄 말이 아니다.

import { test, eq, assert } from '../../test/harness';
import { walletTruthOf, envNoteOf, otherEnvNote, looksLikeCode } from './walletTruthView';

export function runWalletTruthViewTests() {
  console.log('[지갑 진실 — 없음과 확인 못 함을 섞지 않는다]');

  test('**401이면 계좌가 없다고 말하지 않는다**', () => {
    const v = walletTruthOf({ status: 401, body: { ok: false, error: 'auth_required' } });
    eq(v.code, 'AUTH_UNKNOWN');
    eq(v.canStateAccounts, false);
    eq(v.canStateBalance, false);
    eq(v.needsLogin, true);
  });

  test('**서버 내부 코드를 화면에 그대로 내보내지 않는다**', () => {
    const v = walletTruthOf({ status: 401, body: { ok: false, error: 'auth_required' } });
    assert(!/auth_required/.test(v.message), v.message);
    assert(/로그인/.test(v.message), v.message);
  });

  test('코드처럼 생긴 문자열을 알아본다', () => {
    eq(looksLikeCode('auth_required'), true);
    eq(looksLikeCode('supabase_not_configured'), true);
    eq(looksLikeCode('로그인이 필요합니다'), false);
    eq(looksLikeCode('지갑을 읽지 못했습니다'), false);
  });

  test('서버가 코드만 준 경우에도 사람 말로 옮긴다', () => {
    const v = walletTruthOf({ status: 500, body: { ok: false, error: 'supabase_not_configured', message: 'supabase_not_configured' } });
    assert(!/supabase_not_configured/.test(v.message), v.message);
  });

  test('연결 자체가 안 되면 잔고 0이라고 말하지 않는다', () => {
    const v = walletTruthOf({ status: null, networkError: 'fetch failed' });
    eq(v.canStateBalance, false);
    assert(/0이라는 뜻이 아닙니다/.test(v.message), v.message);
  });

  test('**계좌 수를 못 읽었으면 "없음"이 아니다**', () => {
    const v = walletTruthOf({ status: 200, body: { ok: true }, connections: null });
    eq(v.code, 'ACCOUNT_UNKNOWN');
    assert(/없다는 뜻이 아닙니다/.test(v.message), v.message);
  });

  test('읽었고 정말 0개일 때만 "없습니다"라고 말한다', () => {
    const v = walletTruthOf({ status: 200, body: { ok: true }, connections: 0 });
    eq(v.code, 'NO_ACCOUNT');
    eq(v.canStateAccounts, true);
  });

  test('정상이면 아무 경고도 하지 않는다', () => {
    const v = walletTruthOf({ status: 200, body: { ok: true }, connections: 3 });
    eq(v.code, 'OK');
    eq(v.message, '');
  });

  // ── 환경 안내 ──

  test('**인증 실패 상태에서 "이 환경에 계좌가 없습니다"라고 적지 않는다**', () => {
    // 이게 그 모순의 두 번째 문장이다.
    const truth = walletTruthOf({ status: 401, body: { ok: false, error: 'auth_required' } });
    const note = envNoteOf({ truth, env: 'LIVE', envConnections: 0 });
    assert(!/계좌가 없습니다/.test(note), note);
    assert(/확인하지 못했|로그인/.test(note), note);
  });

  test('읽었고 0개면 그때는 없다고 적는다', () => {
    const truth = walletTruthOf({ status: 200, body: { ok: true }, connections: 2 });
    eq(envNoteOf({ truth, env: 'LIVE', envConnections: 0 }), 'LIVE 환경에 연결된 계좌가 없습니다');
  });

  test('환경별 계좌 수를 못 읽으면 그렇게 적는다', () => {
    const truth = walletTruthOf({ status: 200, body: { ok: true }, connections: 2 });
    assert(/확인하지 못했습니다/.test(envNoteOf({ truth, env: 'LIVE', envConnections: null })));
  });

  // ── 다른 환경 계좌 수 ──

  test('**아무것도 못 읽었으면 "다른 환경 계좌 N개"를 말하지 않는다**', () => {
    // 이게 그 모순의 세 번째 문장이다 — 어디선가 만들어 낸 숫자.
    const truth = walletTruthOf({ status: 401, body: { ok: false, error: 'auth_required' } });
    eq(otherEnvNote({ truth, accountEnvs: ['TESTNET', 'TESTNET'], currentEnv: 'LIVE' }), null);
  });

  test('읽었으면 같은 목록에서만 센다', () => {
    const truth = walletTruthOf({ status: 200, body: { ok: true }, connections: 3 });
    const n = otherEnvNote({ truth, accountEnvs: ['LIVE', 'TESTNET', 'TESTNET'], currentEnv: 'LIVE' });
    assert(/계좌 2개/.test(String(n)), String(n));
  });

  test('환경을 모르는 계좌는 어느 쪽에도 넣지 않고 그 사실을 적는다', () => {
    const truth = walletTruthOf({ status: 200, body: { ok: true }, connections: 2 });
    const n = otherEnvNote({ truth, accountEnvs: ['LIVE', null], currentEnv: 'LIVE' });
    assert(/환경을 모르는 1개/.test(String(n)), String(n));
  });

  test('목록을 못 받았으면 숫자를 만들지 않는다', () => {
    const truth = walletTruthOf({ status: 200, body: { ok: true }, connections: 3 });
    eq(otherEnvNote({ truth, accountEnvs: null, currentEnv: 'LIVE' }), null);
  });

  // ── 그 화면을 통째로 재현한다 ──

  test('**auth_required 화면에서 나올 수 있는 문장들이 서로 모순되지 않는다**', () => {
    // 실제로 이렇게 떴다:
    //   auth_required / 이 환경에 연결된 계좌가 없습니다 / 다른 환경의 계좌 8개
    const truth = walletTruthOf({ status: 401, body: { ok: false, error: 'auth_required' } });
    const lines = [
      truth.message,
      envNoteOf({ truth, env: 'LIVE', envConnections: 0 }),
      otherEnvNote({ truth, accountEnvs: ['TESTNET', 'TESTNET', 'TESTNET'], currentEnv: 'LIVE' }),
    ].filter(Boolean).join(' | ');

    // 1. 서버 코드가 새지 않는다
    assert(!/auth_required/.test(lines), lines);
    // 2. 없다고 단정하지 않는다
    assert(!/계좌가 없습니다/.test(lines), lines);
    // 3. 어디선가 만들어 낸 계좌 수가 없다
    assert(!/계좌 \d+개/.test(lines), lines);
    // 4. 그리고 무엇이 문제인지는 말한다
    assert(/로그인/.test(lines), lines);
  });

  test('정상 화면에서는 필요한 말만 남는다', () => {
    const truth = walletTruthOf({ status: 200, body: { ok: true }, connections: 3 });
    const lines = [
      truth.message,
      envNoteOf({ truth, env: 'LIVE', envConnections: 1, serverNote: '연결 1개를 모두 읽었습니다' }),
      otherEnvNote({ truth, accountEnvs: ['LIVE', 'TESTNET', 'TESTNET'], currentEnv: 'LIVE' }),
    ].filter(Boolean);
    eq(lines[0], '연결 1개를 모두 읽었습니다');
    assert(/계좌 2개/.test(lines[1]), lines[1]);
  });
}
