// src/lib/runtime/workerBootCheck.test.ts
//
// 막으려는 것:
//  1. **알 수 없는 값으로 부팅 점검이 켜지는 것.** 운영 부팅이 이 스위치
//     때문에 조용히 일을 멈추면, 화면에는 워커가 떠 있는데 아무것도
//     안 하는 상태가 된다 — 기본은 꺼짐이어야 한다
//  2. 빈 문자열을 '값이 있다'로 읽는 것. 호스팅 UI에서 변수를 만들고
//     값을 안 채우면 빈 문자열이 온다
//  3. 필수 env 목록이 `worker/src/index.ts`와 갈리는 것 — 갈리면 한쪽은
//     "없어도 뜨는" 쪽이 된다
//  4. 이름 대신 **값**을 돌려주는 것
import { test, eq, assert } from '../../test/harness';
import {
  bootCheckRequested, missingRequiredEnv, REQUIRED_ENV,
} from './workerBootCheck';

const FULL = {
  SUPABASE_URL: 'http://example.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  EXCHANGE_ENCRYPTION_KEY: 'k',
};

export function runWorkerBootCheckTests() {
  console.log('[워커 부팅 점검 — 부팅 가능과 매매 가능을 가른다]');

  test('★★ 기본은 꺼짐이다 — 알 수 없는 값으로 켜지지 않는다', () => {
    for (const v of [undefined, '', ' ', '0', 'false', 'off', 'no', 'maybe', 'TRUE_ISH', '2']) {
      eq(bootCheckRequested(v === undefined ? {} : { WORKER_BOOT_CHECK: v }), false,
        `'${String(v)}'로 켜졌다 — 운영 부팅이 조용히 멈출 수 있다`);
    }
    eq(bootCheckRequested(null), false);
    eq(bootCheckRequested(undefined), false);
    // 숫자 1은 문자열이 아니다. 호스팅은 언제나 문자열로 준다.
    eq(bootCheckRequested({ WORKER_BOOT_CHECK: 1 as any }), false);
  });

  test('★ 명시적으로 켜면 켜진다', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'y', 'TRUE', ' On ']) {
      eq(bootCheckRequested({ WORKER_BOOT_CHECK: v }), true, `'${v}'로 안 켜졌다`);
    }
  });

  test('★★ 빈 문자열은 "값이 있다"가 아니다', () => {
    for (const blank of ['', '   ', '\t']) {
      const m = missingRequiredEnv({ ...FULL, SUPABASE_URL: blank });
      assert(m.includes('SUPABASE_URL'),
        `공백('${blank}')을 값으로 읽었다 — 호스팅 UI에서 변수만 만들고 값을 안 넣으면 이 모양이다`);
    }
  });

  test('★★ 전부 있으면 빈 배열이다', () => {
    eq(missingRequiredEnv(FULL).length, 0, `있는데 없다고 했다: ${missingRequiredEnv(FULL).join(', ')}`);
  });

  test('★★ 없는 것만 이름으로 돌려준다 — 값은 돌려주지 않는다', () => {
    const m = missingRequiredEnv({ SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value' });
    assert(m.includes('SUPABASE_URL'), 'SUPABASE_URL 누락을 못 잡았다');
    assert(m.some(x => /ENCRYPTION_KEY/.test(x)), '암호화 키 누락을 못 잡았다');
    for (const line of m) {
      assert(!line.includes('super-secret-value'), `값이 섞여 나왔다: ${line}`);
    }
    eq(m.includes('SUPABASE_SERVICE_ROLE_KEY'), false, '있는 것을 없다고 했다');
  });

  test('★★ 암호화 키는 두 이름 중 하나면 된다', () => {
    const a = missingRequiredEnv({ ...FULL, EXCHANGE_ENCRYPTION_KEY: undefined, ENCRYPTION_KEY: 'k' });
    eq(a.length, 0, `ENCRYPTION_KEY 로도 충족돼야 한다: ${a.join(', ')}`);
    const b = missingRequiredEnv({ ...FULL, EXCHANGE_ENCRYPTION_KEY: undefined });
    assert(b.some(x => /ENCRYPTION_KEY/.test(x)), '둘 다 없는데 통과시켰다');
  });

  test('★★ 아무것도 없으면 셋 다 이름이 나온다', () => {
    eq(missingRequiredEnv({}).length, REQUIRED_ENV.length);
    eq(missingRequiredEnv(null).length, REQUIRED_ENV.length);
  });
}
