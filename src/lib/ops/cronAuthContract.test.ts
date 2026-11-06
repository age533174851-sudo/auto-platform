// src/lib/ops/cronAuthContract.test.ts
//
// **`news-pipeline`이 성공 0회인 이유를 값으로 고정한다 (#582).**
//
// 두 가지를 지킨다:
//   ① 비밀이 미설정일 때 라우트가 **열리는지**를 판정한다
//   ② 워크플로가 보내는 비밀 이름이 **동기화되는지**를 판정한다
//
// 둘 다 이 저장소가 이미 겪은 고장이다. `autotrade-tick`은 ②로 30회 넘게
// 연속 401이었고, 그때 고친 것은 `x-admin-secret` 경로뿐이었다.

import { test, eq, assert } from '../../test/harness';
import {
  classifyRouteAuth, classifySecretName, managedNamesFrom, routeIsHardened,
} from './cronAuthContract';

export function runCronAuthContractTests() {
  console.log('[크론 인증 계약 — 미설정이면 열리는가 · 이름이 동기화되는가]');

  // ── ① 미설정 시 동작 ──
  const FAIL_OPEN_SHAPE = `
    export async function GET(req) {
      const secret = process.env.CRON_SECRET || '';
      if (secret) {
        const given = req.headers.get('authorization');
        if (given !== secret) return json({ error: 'unauthorized' }, { status: 401 });
      }
      return doWork();
    }`;

  test('★ if (secret) 안에 거절이 있으면 FAIL_OPEN이다', () => {
    const a = classifyRouteAuth(FAIL_OPEN_SHAPE);
    eq(a.mode, 'FAIL_OPEN');
    eq(a.envName, 'CRON_SECRET');
    eq(routeIsHardened(a), false);
    assert(a.reason.includes('누구나'), '결과가 이유에 적혀야 한다');
  });

  test('미설정을 명시적으로 거절하면 FAIL_CLOSED다', () => {
    const a = classifyRouteAuth(`
      const secret = process.env.CRON_SECRET || '';
      if (!secret) return json({ error: 'not_configured' }, { status: 401 });
      if (given !== secret) return json({ error: 'unauthorized' }, { status: 401 });
    `);
    eq(a.mode, 'FAIL_CLOSED');
    eq(routeIsHardened(a), true);
  });

  test('비밀을 읽지만 거절이 없으면 NONE이다', () => {
    const a = classifyRouteAuth(`const secret = process.env.CRON_SECRET || ''; return doWork();`);
    eq(a.mode, 'NONE');
    eq(routeIsHardened(a), false);
  });

  test('비밀 검사가 아예 없으면 NONE이다', () => {
    const a = classifyRouteAuth(`export async function GET() { return doWork(); }`);
    eq(a.mode, 'NONE');
    eq(a.envName, null);
  });

  test('★ 알아보지 못한 모양은 UNKNOWN이고 안전으로 세지 않는다', () => {
    // 401은 있는데 비밀을 읽는 자리를 못 찾은 경우
    const a = classifyRouteAuth(`if (await isAllowed(req)) {} else return json({}, {status:401});`);
    eq(a.mode, 'UNKNOWN');
    eq(routeIsHardened(a), false);
    // 비밀은 읽지만 미설정 처리를 못 알아본 경우
    const b = classifyRouteAuth(`
      const secret = process.env.CRON_SECRET || '';
      maybeReject(secret) && json({}, { status: 401 });
    `);
    eq(b.mode, 'UNKNOWN');
    eq(routeIsHardened(b), false);
  });

  test('빈 입력·null에서 터지지 않는다', () => {
    eq(classifyRouteAuth('').mode, 'NONE');
    eq(classifyRouteAuth(null as unknown as string).mode, 'NONE');
  });

  // ── ★ 대비 경로 — 제 파서가 여기서 틀렸다 ──
  //
  // 검사기를 처음 돌렸을 때 `src/app/api/cron/reconcile/route.ts`를
  // **UNKNOWN**으로 읽었다. 그 라우트는 실제로는 이 저장소에서 **가장
  // 올바른** 모양이다 — 미설정이면 잠그고, 비교도 상수 시간이다:
  //
  //   const secret = process.env.CRON_SECRET || process.env.ADMIN_SECRET || '';
  //   if (!secret) { ...잠겨 있습니다... }
  //   if (!safeEqual(given, secret)) { 401 }
  //
  // 제 정규식이 사슬의 **마지막** env만 집어서 `const <var> = ...` 선언을
  // 찾지 못했다. 검사기가 제 파서의 맹점을 잡아 준 것이다.
  test('★ 대비 경로가 있어도 FAIL_CLOSED를 알아본다 (reconcile의 모양)', () => {
    const a = classifyRouteAuth(`
      export async function GET(req) {
        const secret = process.env.CRON_SECRET || process.env.ADMIN_SECRET || '';
        if (!secret) {
          return json({ message: 'CRON_SECRET(또는 ADMIN_SECRET)이 없어 잠겨 있습니다' }, { status: 503 });
        }
        const given = req.headers.get('authorization');
        if (!safeEqual(given, secret)) return json({}, { status: 401 });
        return doWork();
      }`);
    eq(a.mode, 'FAIL_CLOSED');
    eq(routeIsHardened(a), true);
    // 사슬의 **첫** env가 대표 이름이고, 전부도 남는다.
    eq(a.envName, 'CRON_SECRET');
    eq(a.envNames.join(','), 'CRON_SECRET,ADMIN_SECRET');
  });

  test('단일 env도 envNames에 담긴다', () => {
    const a = classifyRouteAuth(FAIL_OPEN_SHAPE);
    eq(a.envNames.join(','), 'CRON_SECRET');
  });

  test('★ fail-closed가 먼저다 — 뒤에 if (secret)이 있어도 FAIL_OPEN이 아니다', () => {
    const a = classifyRouteAuth(`
      const secret = process.env.CRON_SECRET || '';
      if (!secret) return json({}, { status: 503 });
      if (secret) { if (given !== secret) return json({}, { status: 401 }); }
    `);
    eq(a.mode, 'FAIL_CLOSED');
  });

  // ── ★ 주석 전제 ──
  //
  // 이 모듈은 **주석이 이미 지워진** 소스를 받는다. 처음에는 제거기를
  // 이 파일 옆에 복사해 넣었는데, 그것이 바로 이 저장소가 금지한
  // 중복이다(주석 제거기는 `scripts/lib/strip-comments.mjs` 한 곳).
  // 그래서 전제를 바꿨고, **전제가 깨지면 판정이 틀린다는 사실**을
  // 여기에 고정한다 — 호출자가 정본 제거기를 쓰지 않으면 이렇게 된다.
  test('★ 주석을 지우지 않고 넘기면 판정이 틀린다 (그래서 호출자가 지운다)', () => {
    const withComment = `
      // const secret = process.env.FAKE_SECRET || '';
      // if (secret) { return 401 }
      export async function GET() { return doWork(); }`;
    const a = classifyRouteAuth(withComment);
    // 주석을 코드로 읽어 **실제와 다른** 판정이 나온다.
    eq(a.envName, 'FAKE_SECRET');
    assert(a.mode !== 'NONE',
      '주석이 남아 있으면 실제(NONE)와 다르게 읽힌다 — 그래서 미리 지워야 한다');
  });

  // ── ② 비밀 이름이 동기화되는가 ──
  test('관리 목록을 sync-secrets 소스에서 읽는다 (베껴 쓰지 않는다)', () => {
    const names = managedNamesFrom(
      `const NAMES = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'EXCHANGE_ENCRYPTION_KEY', 'ADMIN_SECRET'];`,
    );
    eq(names?.length, 4);
    assert(names!.includes('ADMIN_SECRET'), 'ADMIN_SECRET이 있어야 한다');
  });

  test('★ 관리 목록을 읽지 못하면 null이다 — 빈 배열로 적지 않는다', () => {
    // 빈 배열이면 "아무것도 관리되지 않는다"로 읽혀 전부 HAND_SET이 된다.
    // 그건 거짓이고, 모르는 것은 null이어야 한다.
    eq(managedNamesFrom('const OTHER = [1,2];'), null);
    eq(managedNamesFrom(''), null);
    eq(managedNamesFrom('const NAMES = [];'), null);
  });

  test('★ 동기화되지 않는 이름은 HAND_SET이다', () => {
    const managed = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'EXCHANGE_ENCRYPTION_KEY', 'ADMIN_SECRET'];
    // #582의 실제 두 이름
    eq(classifySecretName('NEWS_CRON_SECRET', managed), 'HAND_SET');
    eq(classifySecretName('CRON_SECRET', managed), 'HAND_SET');
    // autotrade-tick이 30회 연속 401이던 옛 이름
    eq(classifySecretName('EXIT_MONITOR_SECRET', managed), 'HAND_SET');
    // 정본으로 모은 이름
    eq(classifySecretName('ADMIN_SECRET', managed), 'MANAGED');
  });

  test('빈 이름은 HAND_SET으로 본다 — 통과시키지 않는다', () => {
    eq(classifySecretName('', ['ADMIN_SECRET']), 'HAND_SET');
    eq(classifySecretName(null as unknown as string, ['ADMIN_SECRET']), 'HAND_SET');
    eq(classifySecretName('ADMIN_SECRET', null as unknown as string[]), 'HAND_SET');
  });
}
