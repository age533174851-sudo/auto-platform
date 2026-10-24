import { test, eq } from '../../test/harness';
import { mainLockGranted } from './mainLockGate';

export function runMainLockGateTests() {
  console.log('[워커 main 임차 — 획득 증거 없으면 standby]');
  test('락 획득 성공만 main 권한 부여', async () => {
    eq(await mainLockGranted(async () => true), true);
  });
  test('다른 워커가 보유한 락은 main 권한 없음', async () => {
    eq(await mainLockGranted(async () => false), false);
  });
  test('DB 조회 예외는 main 권한을 부여하지 않는다', async () => {
    eq(await mainLockGranted(async () => { throw new Error('exceed_egress_quota'); }), false);
  });
  test('거절된 Promise도 main 권한을 부여하지 않는다', async () => {
    eq(await mainLockGranted(() => Promise.reject(new Error('network timeout'))), false);
  });
  test('불완전한 결과는 성공이 아니다', async () => {
    for (const result of [null, undefined, 1, 'true', { ok: true }]) {
      eq(await mainLockGranted(async () => result as unknown as boolean), false);
    }
  });
}
