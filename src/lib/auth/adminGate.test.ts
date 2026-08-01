// src/lib/auth/adminGate.test.ts
//
// 이 테스트가 지키는 것: **막아야 할 것이 막히는가.**
// 통과 경로가 깨지면 관리자가 못 들어와 바로 알아차린다. 거절 경로가
// 깨지면 아무도 모른다 — 그래서 거절 쪽을 더 많이 적었다.

import { test, eq, assert } from '../../test/harness';
import {
  readClaims,
  isExpired,
  decideByRole,
  lookupRole,
  gateRequest,
  needsLogin,
  AREA_MIN_ROLE,
  SESSION_COOKIE,
} from './adminGate';

// ── 테스트용 JWT 만들기 (서명은 아무 값이나 — 이 코드는 검증하지 않는다) ──
function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function jwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.signature-not-checked-here`;
}

const NOW = 1_800_000_000;
const URL_OK = 'https://example.supabase.co';
const KEY_OK = 'anon-key';

/** 지정한 role을 돌려주는 가짜 PostgREST */
function fetchWithRole(role: string | null, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(role === null ? [] : [{ role }]), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

export function runAdminGateTests() {
  console.log('[관리자 화면 문지기 — 토큰 읽기]');

  test('정상 토큰에서 sub·exp를 읽는다', () => {
    const c = readClaims(jwt({ sub: 'u1', exp: NOW + 3600 }));
    assert(!!c, '읽어야 한다');
    eq(c!.sub, 'u1');
    eq(c!.exp, NOW + 3600);
  });

  test('토큰이 없으면 null', () => {
    eq(readClaims(null), null);
    eq(readClaims(undefined), null);
    eq(readClaims(''), null);
  });

  test('JWT 모양이 아니면 null', () => {
    eq(readClaims('not-a-jwt'), null);
    eq(readClaims('only.two'), null);
  });

  test('payload가 JSON이 아니면 null — 던지지 않는다', () => {
    eq(readClaims('aaa.!!!not-base64-json!!!.bbb'), null);
  });

  test('exp가 없으면 null — 모르면 통과 못 한다', () => {
    eq(readClaims(jwt({ sub: 'u1' })), null);
  });

  test('sub이 없으면 null', () => {
    eq(readClaims(jwt({ exp: NOW + 3600 })), null);
  });

  test('exp가 문자열이면 null — 숫자만 받는다', () => {
    eq(readClaims(jwt({ sub: 'u1', exp: String(NOW + 3600) })), null);
  });

  console.log('[관리자 화면 문지기 — 만료]');

  test('아직 유효한 토큰', () => {
    eq(isExpired({ sub: 'u', exp: NOW + 600 }, NOW), false);
  });

  test('이미 지난 토큰', () => {
    eq(isExpired({ sub: 'u', exp: NOW - 1 }, NOW), true);
  });

  test('곧 만료될 토큰은 미리 만료로 본다 — 검증 중 만료되면 위조와 구분이 안 된다', () => {
    eq(isExpired({ sub: 'u', exp: NOW + 3 }, NOW, 5), true);
    eq(isExpired({ sub: 'u', exp: NOW + 30 }, NOW, 5), false);
  });

  console.log('[관리자 화면 문지기 — role 판정]');

  test('admin은 /admin에 들어간다', () => {
    const d = decideByRole('admin', 'admin');
    eq(d.allow, true);
  });

  test('super_admin은 두 화면 다 들어간다', () => {
    eq(decideByRole('admin', 'super_admin').allow, true);
    eq(decideByRole('developer', 'super_admin').allow, true);
  });

  test('developer는 /admin에도 들어간다 (등급이 더 높다)', () => {
    eq(decideByRole('admin', 'developer').allow, true);
  });

  test('admin은 /developer에 못 들어간다 — canAccessDeveloper와 같은 기준', () => {
    const d = decideByRole('developer', 'admin');
    eq(d.allow, false);
    assert(d.allow === false && d.reason === 'insufficient_role', 'insufficient_role이어야 한다');
  });

  test('일반 사용자는 막힌다', () => {
    eq(decideByRole('admin', 'user').allow, false);
    eq(decideByRole('developer', 'user').allow, false);
  });

  test('vip·lifetime·founder도 관리자는 아니다', () => {
    for (const r of ['vip', 'lifetime', 'founder']) {
      eq(decideByRole('admin', r).allow, false, `${r}가 통과했다`);
    }
  });

  test('role이 없으면 막힌다', () => {
    const d = decideByRole('admin', null);
    eq(d.allow, false);
    assert(d.allow === false && d.reason === 'no_profile', 'no_profile이어야 한다');
  });

  test('모르는 role 문자열은 막힌다 — 통과시키면 역할 추가할 때 문이 열린다', () => {
    const d = decideByRole('admin', 'ADMIN');       // 대문자 오타
    eq(d.allow, false);
    eq(decideByRole('admin', 'superadmin').allow, false);
    eq(decideByRole('admin', 'root').allow, false);
    eq(decideByRole('admin', '__proto__').allow, false);
  });

  test('두 화면의 최소 등급이 서로 다르다', () => {
    eq(AREA_MIN_ROLE.admin, 'admin');
    eq(AREA_MIN_ROLE.developer, 'developer');
  });

  console.log('[관리자 화면 문지기 — Supabase 조회]');

  test('role을 돌려준다', async () => {
    const r = await lookupRole({
      token: 't', userId: 'u1', supabaseUrl: URL_OK, anonKey: KEY_OK,
      fetchImpl: fetchWithRole('admin'),
    });
    eq(r.ok, true);
    eq(r.role, 'admin');
  });

  test('토큰을 Bearer로, anon 키를 apikey로 보낸다 — 자기 행만 필터한다', async () => {
    let seenUrl = '';
    let seenAuth = '';
    let seenKey = '';
    const spy = (async (u: any, init: any) => {
      seenUrl = String(u);
      seenAuth = init?.headers?.Authorization ?? '';
      seenKey = init?.headers?.apikey ?? '';
      return new Response(JSON.stringify([{ role: 'admin' }]), { status: 200 });
    }) as unknown as typeof fetch;

    await lookupRole({
      token: 'tok123', userId: 'u-42', supabaseUrl: URL_OK + '/', anonKey: KEY_OK, fetchImpl: spy,
    });
    assert(seenUrl.includes('/rest/v1/profiles'), 'profiles를 읽어야 한다');
    assert(seenUrl.includes('select=role'), 'role만 읽어야 한다');
    assert(seenUrl.includes('id=eq.u-42'), '자기 id로 필터해야 한다');
    assert(!seenUrl.includes('//rest'), '끝 슬래시가 겹치면 안 된다');
    eq(seenAuth, 'Bearer tok123');
    eq(seenKey, KEY_OK);
  });

  test('401은 unverified — 서명이 틀렸거나 폐기된 토큰', async () => {
    const r = await lookupRole({
      token: 't', userId: 'u1', supabaseUrl: URL_OK, anonKey: KEY_OK,
      fetchImpl: fetchWithRole('admin', 401),
    });
    eq(r.ok, false);
    eq(r.reason, 'unverified');
  });

  test('행이 없으면 no_profile — RLS가 남의 행을 안 주는 경우도 여기다', async () => {
    const r = await lookupRole({
      token: 't', userId: 'u1', supabaseUrl: URL_OK, anonKey: KEY_OK,
      fetchImpl: fetchWithRole(null),
    });
    eq(r.ok, false);
    eq(r.reason, 'no_profile');
  });

  test('500은 lookup_failed — 확인을 못 한 것이고 문제없음이 아니다', async () => {
    const r = await lookupRole({
      token: 't', userId: 'u1', supabaseUrl: URL_OK, anonKey: KEY_OK,
      fetchImpl: fetchWithRole('admin', 500),
    });
    eq(r.ok, false);
    eq(r.reason, 'lookup_failed');
  });

  test('네트워크가 던지면 lookup_failed — 통과시키지 않는다', async () => {
    const boom = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const r = await lookupRole({
      token: 't', userId: 'u1', supabaseUrl: URL_OK, anonKey: KEY_OK, fetchImpl: boom,
    });
    eq(r.ok, false);
    eq(r.reason, 'lookup_failed');
  });

  test('응답이 JSON이 아니면 lookup_failed', async () => {
    const junk = (async () => new Response('<html>502</html>', { status: 200 })) as unknown as typeof fetch;
    const r = await lookupRole({
      token: 't', userId: 'u1', supabaseUrl: URL_OK, anonKey: KEY_OK, fetchImpl: junk,
    });
    eq(r.ok, false);
    eq(r.reason, 'lookup_failed');
  });

  test('role 칸이 비어 있으면 no_profile', async () => {
    const empty = (async () =>
      new Response(JSON.stringify([{ role: '' }]), { status: 200 })) as unknown as typeof fetch;
    const r = await lookupRole({
      token: 't', userId: 'u1', supabaseUrl: URL_OK, anonKey: KEY_OK, fetchImpl: empty,
    });
    eq(r.ok, false);
    eq(r.reason, 'no_profile');
  });

  console.log('[관리자 화면 문지기 — 전체 판단]');

  const base = { nowSec: NOW, supabaseUrl: URL_OK, anonKey: KEY_OK };

  test('관리자 토큰이면 통과한다', async () => {
    const d = await gateRequest({
      ...base, area: 'admin',
      token: jwt({ sub: 'u1', exp: NOW + 3600 }),
      fetchImpl: fetchWithRole('admin'),
    });
    eq(d.allow, true);
    assert(d.allow && d.role === 'admin', 'role이 실려야 한다');
  });

  test('쿠키가 없으면 no_token — Supabase를 부르지도 않는다', async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response('[]'); }) as unknown as typeof fetch;
    const d = await gateRequest({ ...base, area: 'admin', token: null, fetchImpl: spy });
    eq(d.allow, false);
    assert(d.allow === false && d.reason === 'no_token', 'no_token이어야 한다');
    eq(called, false, '토큰도 없는데 네트워크를 불렀다');
  });

  test('만료된 토큰은 네트워크 없이 거절한다', async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response('[]'); }) as unknown as typeof fetch;
    const d = await gateRequest({
      ...base, area: 'admin', token: jwt({ sub: 'u1', exp: NOW - 10 }), fetchImpl: spy,
    });
    assert(d.allow === false && d.reason === 'expired', 'expired여야 한다');
    eq(called, false, '만료된 토큰으로 왕복을 낭비했다');
  });

  test('payload에 role을 심어도 통과하지 못한다 — 권한은 DB에서만 온다', async () => {
    // 공격자가 서명 없이 만들 수 있는 최선의 토큰.
    const forged = jwt({ sub: 'u1', exp: NOW + 3600, role: 'super_admin', is_admin: true });
    const d = await gateRequest({
      ...base, area: 'admin', token: forged,
      // Supabase는 이 사용자를 일반 사용자로 안다
      fetchImpl: fetchWithRole('user'),
    });
    eq(d.allow, false);
    assert(d.allow === false && d.reason === 'insufficient_role', 'insufficient_role이어야 한다');
  });

  test('Supabase가 토큰을 거부하면 막힌다', async () => {
    const d = await gateRequest({
      ...base, area: 'admin', token: jwt({ sub: 'u1', exp: NOW + 3600 }),
      fetchImpl: fetchWithRole('admin', 401),
    });
    assert(d.allow === false && d.reason === 'unverified', 'unverified여야 한다');
  });

  test('Supabase 장애 중에는 열지 않는다 — 정전에 풀리는 잠금장치는 잠금장치가 아니다', async () => {
    const boom = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const d = await gateRequest({
      ...base, area: 'admin', token: jwt({ sub: 'u1', exp: NOW + 3600 }), fetchImpl: boom,
    });
    eq(d.allow, false);
  });

  test('Supabase 설정이 없으면 열지 않는다', async () => {
    const d = await gateRequest({
      area: 'admin', nowSec: NOW, supabaseUrl: '', anonKey: '',
      token: jwt({ sub: 'u1', exp: NOW + 3600 }),
      fetchImpl: fetchWithRole('admin'),
    });
    eq(d.allow, false);
    assert(d.allow === false && d.reason === 'lookup_failed', 'lookup_failed여야 한다');
  });

  test('admin 계정이 /developer를 열려 하면 막힌다', async () => {
    const d = await gateRequest({
      ...base, area: 'developer', token: jwt({ sub: 'u1', exp: NOW + 3600 }),
      fetchImpl: fetchWithRole('admin'),
    });
    eq(d.allow, false);
  });

  test('developer 계정은 /developer를 연다', async () => {
    const d = await gateRequest({
      ...base, area: 'developer', token: jwt({ sub: 'u1', exp: NOW + 3600 }),
      fetchImpl: fetchWithRole('developer'),
    });
    eq(d.allow, true);
  });

  console.log('[관리자 화면 문지기 — 거절 후 어디로]');

  test('토큰 문제는 로그인으로 보낸다', () => {
    eq(needsLogin('no_token'), true);
    eq(needsLogin('bad_token'), true);
    eq(needsLogin('expired'), true);
    eq(needsLogin('unverified'), true);
  });

  test('권한 문제는 로그인으로 보내지 않는다 — 다시 로그인해도 달라지지 않는다', () => {
    eq(needsLogin('insufficient_role'), false);
    eq(needsLogin('no_profile'), false);
    eq(needsLogin('lookup_failed'), false);
  });

  test('쿠키 이름이 고정돼 있다 — 클라이언트와 미들웨어가 같은 값을 봐야 한다', () => {
    eq(SESSION_COOKIE, 'tg_at');
  });
}
