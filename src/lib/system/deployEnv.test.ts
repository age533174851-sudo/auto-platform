// src/lib/system/deployEnv.test.ts
//
// **Preview에서 없는 것을 고장이라고 적으면, 운영이 멀쩡한데 사람이
// 운영을 고치러 간다.** 그리고 그 안내가 "연결을 다시 등록하세요"이면
// 시키는 대로 한 순간 **진짜로 운영이 깨진다.**
import { test, eq, assert } from '../../test/harness';
import {
  deployEnvOf, expectsProductionRuntime, workerCheck, credsCheck, envLabel,
} from './deployEnv';

export function runDeployEnvTests() {
  console.log('[배포 환경 — 모르는 것을 운영이라고 하지 않는다]');

  test('VERCEL_ENV를 그대로 읽는다', () => {
    eq(deployEnvOf({ VERCEL_ENV: 'production' }), 'production');
    eq(deployEnvOf({ VERCEL_ENV: 'preview' }), 'preview');
    eq(deployEnvOf({ VERCEL_ENV: 'development' }), 'development');
  });

  test('모르는 값은 unknown이다', () => {
    eq(deployEnvOf({}), 'unknown');
    eq(deployEnvOf({ VERCEL_ENV: '' }), 'unknown');
    eq(deployEnvOf({ VERCEL_ENV: 'staging' }), 'unknown');
  });

  test('모르는 배포에서는 검사를 끄지 않는다', () => {
    // 느슨한 쪽이 기본값이면 언젠가 진짜 장애가 조용해진다.
    eq(expectsProductionRuntime('unknown'), true);
    eq(expectsProductionRuntime('production'), true);
    eq(expectsProductionRuntime('preview'), false);
    eq(expectsProductionRuntime('development'), false);
  });

  console.log('[Worker — Preview에는 안 오는 것이 정상이다]');

  test('Preview에서 Worker 없음은 장애가 아니다', () => {
    const v = workerCheck({ present: false, env: 'preview' });
    eq(v.code, 'NOT_APPLICABLE');
    eq(v.failing, false, 'Preview에서 운영 Worker가 없다고 빨갛게 칠했다');
    assert(v.reason.includes('운영 배포에서 확인'), v.reason);
  });

  test('운영에서 Worker 없음은 실제 장애다', () => {
    const v = workerCheck({ present: false, env: 'production' });
    eq(v.code, 'MISSING');
    eq(v.failing, true, '운영에서 Worker가 없는데 넘어갔다');
    assert(v.reason.includes('함께 멈춥니다'), v.reason);
  });

  test('모르는 배포에서도 Worker 없음은 장애다', () => {
    eq(workerCheck({ present: false, env: 'unknown' }).failing, true);
  });

  test('못 읽은 것을 없다고 적지 않는다', () => {
    const v = workerCheck({ present: null, env: 'production' });
    eq(v.code, 'UNKNOWN');
    eq(v.failing, false, '못 읽었는데 장애로 적었다');
    assert(v.reason.includes('없다는 뜻이 아닙니다'), v.reason);
  });

  test('있으면 통과다', () => {
    eq(workerCheck({ present: true, env: 'production' }).code, 'PRESENT');
    eq(workerCheck({ present: true, env: 'preview' }).failing, false);
  });

  console.log('[거래소 자격 — 틀린 안내가 운영을 깬다]');

  test('Preview에 암호화 키가 없는 것은 정상이다', () => {
    // 미리보기가 실계좌 키를 들고 있으면 그쪽이 사고다.
    const v = credsCheck({ code: 'NO_KEY', message: 'x', env: 'preview' });
    eq(v.code, 'NOT_APPLICABLE');
    eq(v.failing, false);
  });

  test('Preview에서 "연결을 다시 등록하세요"라고 하지 않는다', () => {
    // **시키는 대로 하면 Preview 키로 덮어써서 운영이 못 읽게 된다.**
    const v = credsCheck({ code: 'NO_KEY', message: 'x', env: 'preview' });
    assert(!/다시 등록하세요/.test(v.reason), `틀린 안내가 나갔다: ${v.reason}`);
    assert(v.reason.includes('다시 등록하지 마세요'), v.reason);
  });

  test('키가 다른 것도 Preview에서는 정상이다', () => {
    eq(credsCheck({ code: 'KEY_MISMATCH', env: 'preview' }).failing, false);
  });

  test('운영에서 키가 없으면 실제 장애다', () => {
    const v = credsCheck({ code: 'NO_KEY', message: '이 배포에 키가 없습니다', env: 'production' });
    eq(v.code, 'MISSING');
    eq(v.failing, true);
    eq(v.reason, '이 배포에 키가 없습니다', 'crypto 계층이 적어 둔 이유를 안 썼다');
  });

  test('저장된 값이 정말 비어 있으면 Preview에서도 장애다', () => {
    // 이건 환경 문제가 아니라 저장 문제다. 어디서 보든 고쳐야 한다.
    eq(credsCheck({ code: 'EMPTY', message: '저장되어 있지 않습니다', env: 'preview' }).failing, true);
    eq(credsCheck({ code: 'MALFORMED', message: '모양이 깨졌습니다', env: 'preview' }).failing, true);
  });

  test('확인 못 한 것을 장애로 적지 않는다', () => {
    const v = credsCheck({ code: null, env: 'production' });
    eq(v.code, 'UNKNOWN');
    eq(v.failing, false);
  });

  test('정상은 정상이다', () => {
    eq(credsCheck({ code: 'OK', env: 'production' }).failing, false);
  });

  test('환경 이름을 사람이 읽을 수 있게 적는다', () => {
    eq(envLabel('preview'), '미리보기(Preview)');
    eq(envLabel('production'), '운영');
    assert(envLabel('unknown').length > 0);
  });
}
