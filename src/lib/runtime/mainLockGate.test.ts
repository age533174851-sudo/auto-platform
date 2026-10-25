import { test, eq } from '../../test/harness';
import { mainLockGranted, MainLeaseKeeper, mainLeaseHolder } from './mainLockGate';

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

  test('긴 tick 중 갱신 후 다음 main 작업 계속 허용', async () => {
    let now = 0, calls = 0;
    const guard = new MainLeaseKeeper(async () => { calls++; return true; }, 3000, () => {}, () => now);
    eq(await guard.allowed(), true);
    eq(calls, 0);
    now = 3001;
    eq(await guard.allowed(), true);
    eq(calls, 1);
    guard.stop();
  });
  test('갱신 거절 뒤 같은 tick에서 main 권한 영구 취소', async () => {
    let calls = 0, lost = 0;
    const guard = new MainLeaseKeeper(async () => { calls++; return false; }, 3000, () => { lost++; });
    eq(await guard.refresh(), false);
    eq(await guard.allowed(), false);
    eq(await guard.refresh(), false);
    eq(calls, 1);
    eq(lost, 1);
    guard.stop();
  });
  test('DB 예외가 main 권한을 유지하지 못한다', async () => {
    let lost = 0;
    const guard = new MainLeaseKeeper(async () => { throw new Error('exceed_egress_quota'); }, 3000, () => { lost++; });
    eq(await guard.refresh(), false);
    eq(await guard.allowed(), false);
    eq(lost, 1);
    guard.stop();
  });
  test('동시 갱신은 한 번의 DB 호출을 공유한다', async () => {
    let calls = 0;
    let release: (ok: boolean) => void = () => {};
    const guard = new MainLeaseKeeper(() => {
      calls++;
      return new Promise<boolean>((resolve) => { release = resolve; });
    }, 3000);
    const a = guard.refresh();
    const b = guard.refresh();
    await Promise.resolve();
    eq(calls, 1);
    release(true);
    eq(await a, true);
    eq(await b, true);
    guard.stop();
  });
  test('비정상 갱신 응답은 성공으로 취급하지 않는다', async () => {
    for (const value of [null, undefined, 1, 'true']) {
      const guard = new MainLeaseKeeper(async () => value as unknown as boolean, 3000);
      eq(await guard.refresh(), false);
      eq(await guard.allowed(), false);
      guard.stop();
    }
  });
  test('TTL 갱신 ACK가 너무 늦으면 true여도 낡은 권한으로 취급', async () => {
    let now = 0, lost = 0;
    let release: (ok: boolean) => void = () => {};
    const guard = new MainLeaseKeeper(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
      3000, () => { lost++; }, () => now,
    );
    const pending = guard.refresh();
    await Promise.resolve();
    now = 3001;
    release(true);
    eq(await pending, false);
    eq(await guard.allowed(), false);
    eq(lost, 1);
    guard.stop();
  });
  test('tick 종료 후 늦게 도착한 갱신 결과는 권한을 되살리지 못한다', async () => {
    let release: (ok: boolean) => void = () => {};
    const guard = new MainLeaseKeeper(() => new Promise<boolean>((resolve) => { release = resolve; }), 3000);
    const pending = guard.refresh();
    await Promise.resolve();
    guard.stop();
    release(true);
    eq(await pending, false);
    eq(await guard.allowed(), false);
  });


  test('같은 machine ID라도 실행 세대가 다르면 main 임차 holder는 다르다', () => {
    const first = mainLeaseHolder('fly-machine-1', 'process-a');
    const restarted = mainLeaseHolder('fly-machine-1', 'process-b');
    eq(first === restarted, false);
    eq(first === 'fly-machine-1', false);
  });
  test('FakeLease: 겹친 재시작은 TTL 전에 기존 main 임차를 승계하지 못한다', () => {
    const oldHolder = mainLeaseHolder('fly-machine-1', 'process-a');
    const newHolder = mainLeaseHolder('fly-machine-1', 'process-b');
    let holder = oldHolder;
    let expiresAt = 12;
    const acquire = (candidate: string, now: number) => {
      if (candidate !== holder && !(expiresAt < now)) return false;
      holder = candidate;
      expiresAt = now + 12;
      return true;
    };
    eq(acquire(newHolder, 1), false);
    eq(acquire(oldHolder, 1), true);
    eq(acquire(newHolder, 14), true);
    // A late shutdown of the old process cannot release B's lease:
    eq(holder === oldHolder, false);
  });
  test('main 임차 holder에 빈 세대/worker ID를 허용하지 않는다', () => {
    for (const [id, nonce] of [['', 'process'], ['fly-machine', ''], [' ', 'process'], ['fly-machine', ' ']]) {
      let rejected = false;
      try { mainLeaseHolder(id, nonce); } catch { rejected = true; }
      eq(rejected, true);
    }
  });

}
