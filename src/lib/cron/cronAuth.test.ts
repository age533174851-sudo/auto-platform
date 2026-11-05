// src/lib/cron/cronAuth.test.ts
//
// **"비밀이 없다"는 "아무나 통과"가 아니다.**
//
// 다섯 크론이 똑같이 `if (secret) { … 401 … }`로 적고 있었다. 비밀이
// 없으면 블록을 통째로 건너뛰므로 인증이 사라진다. 그 상태로 열리는
// 일은 DB 삭제 · 외부 API 한도 소모 · 유료 AI 호출이다.
//
// 판정을 다섯 벌로 둔 것이 다섯 벌이 같이 틀린 이유다. 여기 한 곳에서
// 고정한다.

import { test, eq, assert } from '../../test/harness';
import { cronAuthVerdict, cronAuthFromRequest } from './cronAuth';

const SECRET = 'cron-secret-0123456789abcdef';

/** 헤더·질의만 있는 요청 */
const reqOf = (authorization: string | null, querySecret: string | null = null) => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? authorization : null) },
  nextUrl: { searchParams: { get: (k: string) => (k === 'secret' ? querySecret : null) } },
});

export function runCronAuthTests() {
  console.log('[크론 인증 — 비밀이 없으면 잠근다]');

  // ── ① 미설정은 503이다. 200도 401도 아니다 ──
  //
  // 503인 이유: 호출자가 틀린 것이 아니라 **배포가 덜 된 것**이다.
  // 401로 적으면 운영자가 비밀을 맞추려 하고, 200으로 적으면 열린다.
  for (const [label, secret] of [
    ['undefined', undefined], ['null', null], ['빈 문자열', ''],
    ['공백', '   '], ['탭·줄바꿈', '\t\n '],
  ] as Array<[string, any]>) {
    test(`① CRON_SECRET이 ${label}이면 503으로 잠근다`, () => {
      const v = cronAuthVerdict({ secret, authorization: `Bearer ${SECRET}` });
      eq(v.ok, false, '비밀이 없는데 통과시켰다');
      eq(v.code, 'SECRET_MISSING');
      eq(v.status, 503);
      assert(v.message.includes('아무나 불러도 된다는 뜻이 아닙니다'),
        `사유가 오해를 남긴다: ${v.message}`);
    });
  }

  // **공백 비밀을 공백으로 열 수 없다.** 예전에는 `'   '`가 truthy라
  // 그 공백 자체가 진짜 비밀이 됐다.
  test('① 공백 비밀은 공백을 제시해도 열리지 않는다', () => {
    const v = cronAuthVerdict({ secret: '   ', authorization: 'Bearer    ' });
    eq(v.code, 'SECRET_MISSING', '공백을 비밀로 쓰지 않는다');
    eq(v.status, 503);
  });

  // ── ② 틀린 인증은 401 ──
  for (const [label, given] of [
    ['헤더 없음', null], ['빈 값', ''], ['다른 값', 'Bearer wrong-value-here'],
    ['접두사만', 'Bearer '], ['Bearer 없이 틀린 값', 'nope'],
    ['길이만 같고 내용이 다름', `Bearer ${'x'.repeat(SECRET.length)}`],
  ] as Array<[string, any]>) {
    test(`② 인증이 ${label}이면 401이다`, () => {
      const v = cronAuthVerdict({ secret: SECRET, authorization: given });
      eq(v.ok, false, '틀린 인증을 통과시켰다');
      eq(v.code, 'UNAUTHORIZED');
      eq(v.status, 401);
    });
  }

  // ── ③ 맞으면 통과 — 과잉 차단 방지 ──
  //
  // 위를 통과시키려고 전부 막으면 크론이 통째로 멎는다.
  test('③ Authorization: Bearer 가 맞으면 통과한다', () => {
    const v = cronAuthVerdict({ secret: SECRET, authorization: `Bearer ${SECRET}` });
    eq(v.ok, true, `막혔다: ${v.code} ${v.message}`);
    eq(v.code, 'OK');
  });

  test('③ Bearer 접두사 없이 값만 보내도 통과한다 (기존 계약)', () => {
    eq(cronAuthVerdict({ secret: SECRET, authorization: SECRET }).ok, true);
  });

  test('③ ?secret= 질의도 그대로 받는다 (기존 계약)', () => {
    const v = cronAuthVerdict({ secret: SECRET, authorization: null, querySecret: SECRET });
    eq(v.ok, true, `질의 인증이 막혔다: ${v.message}`);
  });

  // 헤더가 **있지만 틀린** 경우에 질의로 우회되면 안 된다 —
  // 기존 코드의 `||`는 헤더가 빈 값일 때만 질의를 본다.
  test('③ 헤더가 틀렸으면 맞는 질의가 있어도 401이다', () => {
    const v = cronAuthVerdict({ secret: SECRET, authorization: 'Bearer wrong', querySecret: SECRET });
    eq(v.code, 'UNAUTHORIZED', '틀린 헤더를 질의로 덮어쓰지 않는다');
  });

  // ── ④ 요청에서 읽는 겹 ──
  test('④ cronAuthFromRequest가 헤더·질의·환경을 그대로 읽는다', () => {
    eq(cronAuthFromRequest(reqOf(`Bearer ${SECRET}`), { CRON_SECRET: SECRET }).ok, true);
    eq(cronAuthFromRequest(reqOf(null, SECRET), { CRON_SECRET: SECRET }).ok, true);
    eq(cronAuthFromRequest(reqOf('Bearer x'), { CRON_SECRET: SECRET }).code, 'UNAUTHORIZED');
    eq(cronAuthFromRequest(reqOf(`Bearer ${SECRET}`), {}).code, 'SECRET_MISSING');
    // nextUrl이 없어도 터지지 않는다 — 터지면 그 자체가 열린 길이 된다
    eq(cronAuthFromRequest({ headers: { get: () => null } }, { CRON_SECRET: SECRET }).code,
      'UNAUTHORIZED');
  });

  // ── ⑤ 비밀 값을 사유에 싣지 않는다 ──
  test('⑤ 판정 문구 어디에도 비밀 값이 없다', () => {
    for (const v of [
      cronAuthVerdict({ secret: SECRET, authorization: 'Bearer wrong' }),
      cronAuthVerdict({ secret: '', authorization: `Bearer ${SECRET}` }),
    ]) {
      assert(!JSON.stringify(v).includes(SECRET), `비밀이 응답에 들어갔다: ${v.message}`);
    }
  });
}
