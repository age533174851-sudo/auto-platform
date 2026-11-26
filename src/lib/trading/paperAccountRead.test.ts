// src/lib/trading/paperAccountRead.test.ts
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { test, eq, assert } from '../../test/harness';
import { paperAccountReadOf } from './paperAccountRead';

export function runPaperAccountReadTests() {
  console.log('[모의 계좌 읽기 → 화면 상태]');

  const OK = { kind: 'RESPONSE' as const, httpOk: true, failText: 'x',
    body: { ok: true, account: { balance: 1 }, positions: [{ id: 'p1' }] } };

  test('성공하면 계좌와 포지션을 그대로 싣는다', () => {
    const s = paperAccountReadOf(OK);
    eq(s.positions.length, 1); eq(s.err, ''); assert(s.acct != null, 'acct');
  });

  test('★ 서버가 실패를 돌려주면 옛 포지션을 들고 있지 않는다', () => {
    const s = paperAccountReadOf({ kind: 'RESPONSE', httpOk: false, body: { ok: false }, failText: '조회 실패 (503)' });
    eq(s.positions.length, 0); eq(s.acct, null); eq(s.err, '조회 실패 (503)');
  });

  test('★ 네트워크가 끊겨도 포지션을 비우고 오류를 적는다', () => {
    const s = paperAccountReadOf({ kind: 'THROWN', message: 'offline' });
    eq(s.positions.length, 0); assert(s.err.includes('offline'), s.err);
  });

  test('★ 인증이 없으면(로그아웃) 앞 사용자의 포지션을 남기지 않는다', () => {
    eq(paperAccountReadOf({ kind: 'DISABLED' }).positions.length, 0);
  });

  // 훅이 실제로 이 함수를 쓰는지 — 만들어 놓고 배선 안 하는 고장을 막는다.
  test('★ usePaperAccount가 모든 갈래에서 포지션까지 함께 갱신한다', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/terminal/PaperWallet.tsx'), 'utf8');
    const hook = src.slice(src.indexOf('export function usePaperAccount'), src.indexOf('export function PaperWallet'));
    assert(hook.includes('paperAccountReadOf('), '훅이 paperAccountReadOf를 쓰지 않는다');
    const setAcctCalls = (hook.match(/setAcct\(/g) || []).length;
    const setPosCalls = (hook.match(/setPositions\(/g) || []).length;
    assert(setAcctCalls > 0 && setAcctCalls === setPosCalls,
      `setAcct ${setAcctCalls}회 · setPositions ${setPosCalls}회 — 계좌만 바꾸고 포지션을 남기는 갈래가 있다`);
  });
}
