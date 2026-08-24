// src/lib/supabase/keyIdentity.test.ts
//
// 지키는 것
//  1. **원문·서명이 절대 밖으로 나가지 않는다**
//  2. anon/publishable 키를 service_role처럼 적지 않는다
//  3. 모르는 것을 "같다"로 적지 않는다
//  4. 어떤 입력에도 던지지 않는다
import { test, assert, eq } from '../../test/harness';
import { keyIdentityOf, compareKeys } from './keyIdentity';
import { fingerprintOf } from '../system/fingerprint';

/** 테스트용 JWT 모양 (서명은 아무 문자열 — 검증하지 않는다) */
function fakeJwt(payload: Record<string, any>, sig = 'SIGNATURE_MUST_NOT_LEAK'): string {
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.${sig}`;
}

const SERVICE = fakeJwt({ role: 'service_role', ref: 'sgbysrvvxlluzffmgcho', iss: 'supabase' });
const ANON = fakeJwt({ role: 'anon', ref: 'sgbysrvvxlluzffmgcho', iss: 'supabase' });

export function runKeyIdentityTests() {
  console.log('\n🔑 Supabase 키 신원 (값 노출 없음)');

  // ── 1. 값이 새지 않는다 ──
  test('JWT 서명과 원문은 결과 어디에도 없다', () => {
    const id = keyIdentityOf(SERVICE);
    const s = JSON.stringify(id);
    assert(!s.includes('SIGNATURE_MUST_NOT_LEAK'), '서명이 샜다');
    assert(!s.includes(SERVICE), '원문이 샜다');
    assert(!s.includes('eyJ'), 'JWT 조각이 샜다');
  });

  test('새 형식 키의 값도 새지 않는다', () => {
    const raw = 'sb_secret_REAL_VALUE_DO_NOT_LEAK_1234';
    const s = JSON.stringify(keyIdentityOf(raw));
    assert(!s.includes('REAL_VALUE_DO_NOT_LEAK'), '값이 샜다');
    assert(!s.includes(raw), '원문이 샜다');
  });

  test('지문은 6자이고 같은 키면 같다', () => {
    const a = keyIdentityOf(SERVICE);
    eq(String(a.fingerprint).length, 6, '6자');
    eq(a.fingerprint, fingerprintOf(SERVICE), '같은 방식');
    eq(keyIdentityOf(SERVICE).fingerprint, a.fingerprint, '같은 키면 같은 지문');
    assert(keyIdentityOf(ANON).fingerprint !== a.fingerprint, '다른 키면 다른 지문');
  });

  // ── 2. 역할을 정확히 읽는다 ──
  test('service_role JWT', () => {
    const id = keyIdentityOf(SERVICE);
    eq(id.kind, 'jwt', 'jwt');
    eq(id.role, 'service_role', 'role');
    eq(id.ref, 'sgbysrvvxlluzffmgcho', 'ref');
    assert(/우회/.test(id.note), 'RLS 우회를 말해야 한다');
  });

  test('anon JWT는 RLS가 걸린다고 분명히 적는다', () => {
    const id = keyIdentityOf(ANON);
    eq(id.role, 'anon', 'role');
    assert(/RLS가 그대로/.test(id.note), 'RLS가 적용된다고 말해야 한다');
    assert(/0줄/.test(id.note), '조용히 0줄이 될 수 있다는 것을 말해야 한다');
  });

  test('새 형식 secret / publishable을 가른다', () => {
    eq(keyIdentityOf('sb_secret_abc123').kind, 'sb_secret', 'secret');
    eq(keyIdentityOf('sb_secret_abc123').role, 'service_role', 'secret은 우회');
    eq(keyIdentityOf('sb_publishable_abc123').kind, 'sb_publishable', 'publishable');
    eq(keyIdentityOf('sb_publishable_abc123').role, 'anon', 'publishable은 anon');
    assert(/RLS가 그대로/.test(keyIdentityOf('sb_publishable_abc123').note), '경고해야 한다');
  });

  // ── 3. 모르면 모른다 ──
  test('키가 없으면 missing — 있다고 적지 않는다', () => {
    const id = keyIdentityOf('');
    eq(id.present, false, '없음');
    eq(id.kind, 'missing', 'missing');
    eq(id.fingerprint, null, '지문도 없다');
  });

  test('JWT 모양인데 payload가 깨졌으면 role을 지어내지 않는다', () => {
    const id = keyIdentityOf('aaa.@@@notbase64@@@.ccc');
    eq(id.kind, 'jwt', '모양은 jwt');
    eq(id.role, null, 'role을 추측하지 않는다');
    assert(/읽지 못했습니다/.test(id.note), '못 읽었다고 말해야 한다');
  });

  test('아는 형식이 아니면 unknown', () => {
    const id = keyIdentityOf('just-some-string');
    eq(id.kind, 'unknown', 'unknown');
    eq(id.role, null, 'role 없음');
  });

  test('어떤 입력에도 던지지 않는다', () => {
    for (const v of [null, undefined, '', '.', '..', 'a.b', 'a.b.c.d', ' ']) {
      const id = keyIdentityOf(v as any);
      assert(typeof id.kind === 'string', `${JSON.stringify(v)}에서 던졌다`);
    }
  });

  // ── 4. 비교 ──
  test('양쪽이 service_role이면 bothBypassRls=true', () => {
    const c = compareKeys(keyIdentityOf(SERVICE), keyIdentityOf(SERVICE));
    eq(c.sameKey, true, '같은 키');
    eq(c.sameRole, true, '같은 역할');
    eq(c.bothBypassRls, true, '둘 다 우회');
  });

  test('한쪽이 anon이면 같은 질의가 다른 결과를 낸다고 말한다', () => {
    const c = compareKeys(keyIdentityOf(SERVICE), keyIdentityOf(ANON));
    eq(c.bothBypassRls, false, '한쪽은 못 우회');
    eq(c.sameRole, false, '역할이 다르다');
    assert(/다른 결과/.test(c.note), '결과가 갈린다고 말해야 한다');
    assert(/anon/.test(c.note), '어느 쪽이 약한지 적어야 한다');
  });

  test('서로 다른 키여도 둘 다 service_role이면 우회는 같다', () => {
    const other = keyIdentityOf(fakeJwt({ role: 'service_role', ref: 'otherref' }, 'X'));
    const c = compareKeys(keyIdentityOf(SERVICE), other);
    eq(c.sameKey, false, '다른 키');
    eq(c.sameRole, true, '같은 역할');
    eq(c.bothBypassRls, true, '둘 다 우회');
  });

  test('한쪽을 모르면 전부 null — 같다고 적지 않는다', () => {
    const c = compareKeys(keyIdentityOf(SERVICE), keyIdentityOf(''));
    eq(c.sameKey, null, 'null');
    eq(c.sameRole, null, 'null');
    eq(c.bothBypassRls, null, 'null');
  });

  test('역할을 못 읽으면 우회 여부도 null이다', () => {
    const c = compareKeys(keyIdentityOf(SERVICE), keyIdentityOf('just-some-string'));
    eq(c.bothBypassRls, null, '모르면 null');
    assert(/다르다는 뜻이 아닙니다/.test(c.note), '모른다는 것을 분명히 해야 한다');
  });
}
