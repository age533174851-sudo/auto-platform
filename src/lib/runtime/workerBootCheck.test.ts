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
//  5. **있는데 숫자가 아닌 숫자 환경변수를 통과시키는 것.** 측정했다:
//     `WORKER_POLL_SEC=abc` → POLL_SEC=NaN → `acquireLock(..., NaN)`이
//     RangeError를 던지고 tick의 `catch { isMain = true }`가 그걸 받아
//     **모든 워커가 main이 된다**. 이건 이전할 때 손으로 다시 타이핑하는
//     칸에서 나오는 오타다
import { test, eq, assert } from '../../test/harness';
import {
  bootCheckRequested, missingRequiredEnv, invalidNumericEnv, REQUIRED_ENV, NUMERIC_ENV,
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

  // ── 숫자 환경변수 ──
  //
  // 이 묶음이 막는 것은 "오타가 조용히 동작을 바꾸는 것"이다.

  test('★★ 있는데 숫자가 아니면 통과시키지 않는다', () => {
    // WORKER_POLL_SEC=abc → NaN → acquireLock이 예외 → 모든 워커가 main
    const bad = invalidNumericEnv({ WORKER_POLL_SEC: 'abc' });
    eq(bad.length, 1, '숫자가 아닌 WORKER_POLL_SEC을 통과시켰다 — 중복 main 진입으로 간다');
    eq(bad[0].name, 'WORKER_POLL_SEC');
    for (const v of ['', ' ', 'abc', '삼초', 'null', 'undefined', 'NaN', 'Infinity', '1e999']) {
      const n = invalidNumericEnv({ EXIT_MONITOR_INTERVAL_MS: v }).length;
      // 빈 값은 '없는 것'이다 — 기본값으로 간다. 나머지는 전부 걸려야 한다.
      const expected = v.trim() === '' ? 0 : 1;
      eq(n, expected, `'${v}'를 ${expected === 0 ? '없는 것으로' : '숫자 아님으로'} 읽지 않았다`);
    }
  });

  test('★★ 읽는 방식이 워커와 같다 — parseInt 칸과 Number 칸은 다르게 판정한다', () => {
    // 워커는 WORKER_POLL_SEC만 parseInt로 읽는다: '7s' → 7 (돌아간다)
    eq(invalidNumericEnv({ WORKER_POLL_SEC: '7s' }).length, 0,
      "parseInt로 읽는 칸인데 '7s'를 거부했다 — 멀쩡히 도는 설정을 막는다");
    // 나머지는 Number로 읽는다: '7s' → NaN (안 돌아간다)
    eq(invalidNumericEnv({ LEDGER_SYNC_INTERVAL_MS: '7s' }).length, 1,
      "Number로 읽는 칸인데 '7s'를 통과시켰다 — now-last<NaN이 뒤집혀 매 tick 돈다");
  });

  test('★ 없는 것은 문제가 아니다 — 전부 기본값이 있다', () => {
    eq(invalidNumericEnv({}).length, 0);
    eq(invalidNumericEnv(null).length, 0);
    eq(invalidNumericEnv(undefined).length, 0);
    // 정상값은 조용하다
    eq(invalidNumericEnv({
      WORKER_POLL_SEC: '3', EXIT_MONITOR_INTERVAL_MS: '300000',
      PAPER_EXIT_INTERVAL_MS: ' 60000 ', LEDGER_SYNC_INTERVAL_MS: '900000',
    }).length, 0, '정상값을 거부했다 — 검사기가 울기만 하면 아무도 안 본다');
  });

  test('★ 0과 음수도 값이 아니다 — 간격 0은 전속 회전이다', () => {
    eq(invalidNumericEnv({ LEDGER_SYNC_INTERVAL_MS: '0' }).length, 1, '간격 0을 통과시켰다');
    eq(invalidNumericEnv({ WORKER_POLL_SEC: '-3' }).length, 1, '음수를 통과시켰다');
  });

  test('★★ 값을 돌려주지 않는다 — 숫자 칸에 시크릿을 붙여 넣어도', () => {
    const secret = 'sbp_0123456789abcdef0123456789abcdef';
    const bad = invalidNumericEnv({ WORKER_POLL_SEC: secret });
    eq(bad.length, 1);
    const printed = JSON.stringify(bad);
    assert(!printed.includes(secret), '이유 문구에 값이 들어갔다 — 로그로 새어 나간다');
    assert(!printed.includes('sbp_'), '값의 앞부분이 들어갔다');
    assert(printed.includes(String(secret.length)), '글자 수는 알려 줘야 사람이 뭘 붙였는지 안다');
  });

  test('★ 목록에 7칸이 다 있다 — 하나 빠지면 그 칸이 다시 조용해진다', () => {
    const names = NUMERIC_ENV.map(r => r.name);
    for (const n of [
      'WORKER_POLL_SEC', 'EXIT_MONITOR_INTERVAL_MS', 'PAPER_EXIT_INTERVAL_MS',
      'CHALLENGE_SWEEP_INTERVAL_MS', 'SCHEDULED_EXIT_INTERVAL_MS',
      'LEDGER_SYNC_INTERVAL_MS', 'EQUITY_SNAPSHOT_INTERVAL_MS',
    ]) assert(names.includes(n), `${n}이 목록에 없다 — 그 칸의 오타는 아무도 모른다`);
    // 실제 코드와의 대조는 scripts/worker-boot-check.test.mjs가 파일을 읽어서 한다.
    eq(names.length, new Set(names).size, '목록에 같은 이름이 두 번 있다');
  });
}
