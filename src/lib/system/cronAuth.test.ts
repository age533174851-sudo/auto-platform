// src/lib/system/cronAuth.test.ts
//
// **이 시험이 지키는 것 둘.**
//
// ① 빈 비밀로는 아무도 들어오지 못한다. 환경변수가 비어 있으면 `''`와
//    `''`가 같아서 헤더를 비워 보낸 쪽이 관리자가 된다.
// ② 깨우는 길이 **둘** 다 열려 있다. 길이 하나면 그것이 멈출 때 안전망이
//    없다 — 모의 자동매매가 정확히 그 상태였다(Fly 워커 하나뿐, Vercel
//    Cron은 401).
import { test, eq, assert } from '../../test/harness';
import { wakeAuth, wakeAuthFromEnv, safeSecretEqual } from './cronAuth';

const H = (o: Partial<{ authorization: string; adminHeader: string }> = {}) => ({
  authorization: o.authorization ?? null,
  adminHeader: o.adminHeader ?? null,
});

export function runCronAuthTests() {
  console.log('[깨우기 인증 — 빈 비밀로는 못 들어오고, 길은 둘이다]');

  test('Vercel Cron 경로 — Bearer CRON_SECRET', () => {
    const v = wakeAuth({ authorization: 'Bearer c1', adminHeader: null,
      cronSecret: 'c1', adminSecret: 'a1' });
    eq(v.ok, true); eq(v.kind, 'CRON_BEARER');
  });

  test('워커·수동 경로 — x-admin-secret', () => {
    const v = wakeAuth({ authorization: null, adminHeader: 'a1',
      cronSecret: 'c1', adminSecret: 'a1' });
    eq(v.ok, true); eq(v.kind, 'ADMIN_HEADER');
  });

  test('★ 두 길이 모두 열려 있다 — 하나가 멈춰도 다른 쪽으로 깨운다', () => {
    const env = { cronSecret: 'c1', adminSecret: 'a1' };
    eq(wakeAuth({ ...env, authorization: 'Bearer c1', adminHeader: null }).ok, true);
    eq(wakeAuth({ ...env, authorization: null, adminHeader: 'a1' }).ok, true);
  });

  // ★ 이 시험이 이 파일의 이유다.
  test('★ 비밀이 비어 있으면 아무도 들어오지 못한다', () => {
    for (const h of [H({ adminHeader: '' }), H({ authorization: 'Bearer ' }),
      H({ adminHeader: 'anything' }), H({ authorization: 'Bearer anything' })]) {
      const v = wakeAuth({ ...h, cronSecret: '', adminSecret: '' });
      eq(v.ok, false, `빈 비밀로 통과했습니다: ${JSON.stringify(h)}`);
      eq(v.kind, 'NONE');
    }
  });

  test('비밀이 하나만 설정돼 있으면 그 길만 열린다', () => {
    eq(wakeAuth({ ...H({ authorization: 'Bearer c1' }), cronSecret: 'c1', adminSecret: '' }).ok, true);
    eq(wakeAuth({ ...H({ adminHeader: 'a1' }), cronSecret: 'c1', adminSecret: '' }).ok, false);
    eq(wakeAuth({ ...H({ adminHeader: 'a1' }), cronSecret: '', adminSecret: 'a1' }).ok, true);
    eq(wakeAuth({ ...H({ authorization: 'Bearer c1' }), cronSecret: '', adminSecret: 'a1' }).ok, false);
  });

  test('틀린 비밀·접두어 없는 헤더는 거절한다', () => {
    const env = { cronSecret: 'c1', adminSecret: 'a1' };
    eq(wakeAuth({ ...env, ...H({ authorization: 'Bearer wrong' }) }).ok, false);
    eq(wakeAuth({ ...env, ...H({ authorization: 'c1' }) }).ok, false);          // 접두어 없음
    eq(wakeAuth({ ...env, ...H({ authorization: 'bearer c1' }) }).ok, false);   // 대소문자 다름
    eq(wakeAuth({ ...env, ...H({ authorization: 'Bearer  c1' }) }).ok, false);  // 공백 하나 더
    eq(wakeAuth({ ...env, ...H({ adminHeader: 'a' }) }).ok, false);             // 길이 다름
    eq(wakeAuth({ ...env, ...H({ adminHeader: 'a1 ' }) }).ok, false);           // 뒤 공백
  });

  test('아무 헤더도 없으면 NONE이다', () => {
    const v = wakeAuth({ ...H(), cronSecret: 'c1', adminSecret: 'a1' });
    eq(v.ok, false); eq(v.kind, 'NONE');
  });

  test('환경에서 읽는 겉면도 같은 답을 낸다', () => {
    const env = (k: string) => ({ CRON_SECRET: 'c1', ADMIN_SECRET: 'a1' } as any)[k];
    eq(wakeAuthFromEnv(H({ authorization: 'Bearer c1' }), env).kind, 'CRON_BEARER');
    eq(wakeAuthFromEnv(H({ adminHeader: 'a1' }), env).kind, 'ADMIN_HEADER');
    eq(wakeAuthFromEnv(H(), env).kind, 'NONE');
    // 환경변수가 아예 없는 경우 — 아무도 못 들어온다
    eq(wakeAuthFromEnv(H({ adminHeader: '' }), () => undefined).ok, false);
  });

  test('비밀 비교는 빈 값·null을 먼저 막는다', () => {
    eq(safeSecretEqual(null, 'x'), false);
    eq(safeSecretEqual(undefined, 'x'), false);
    eq(safeSecretEqual('', ''), false);
    eq(safeSecretEqual('x', ''), false);
    eq(safeSecretEqual('x', 'x'), true);
    eq(safeSecretEqual('x', 'xx'), false);
  });
}
