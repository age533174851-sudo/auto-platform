// src/lib/runtime/workerIdentity.test.ts
//
// 화면의 공급자 이름이 두 번 틀렸다. 한 번은 글자로 박혀서, 한 번은
// 사람이 안 넣어서. **둘 다 사실을 아는 쪽이 적지 않아서 생긴 일이다.**

import { test, eq } from '../../test/harness';
import { detectProvider, workerIdentityOf, fingerprintPair } from './workerIdentity';

export function runWorkerIdentityTests() {
  console.log('[워커 신원 — 어디서 도는지는 워커가 안다]');

  test('Fly가 넣어 주는 값으로 Fly를 알아본다', () => {
    eq(detectProvider({ FLY_APP_NAME: 'auto-platform', NODE_ENV: 'production' }), 'FLY');
    eq(detectProvider({ FLY_MACHINE_ID: 'abc123', NODE_ENV: 'production' }), 'FLY');
  });

  test('Railway·Render도 각자 값으로 알아본다', () => {
    eq(detectProvider({ RAILWAY_SERVICE_ID: 's1', NODE_ENV: 'production' }), 'RAILWAY');
    eq(detectProvider({ RENDER_SERVICE_ID: 'r1', NODE_ENV: 'production' }), 'RENDER');
  });

  test('**사람이 넣는 WORKER_PROVIDER는 보지 않는다**', () => {
    // 사람이 넣는 값은 사람이 안 넣거나 틀리게 넣는다 — 둘 다 겪었다.
    eq(detectProvider({ WORKER_PROVIDER: 'Fly', NODE_ENV: 'production' }), null);
  });

  test('production인데 아무 표시도 없으면 모른다고 한다', () => {
    // **지어내지 않는다.** heartbeat 행이 있다는 사실만으로 'Fly'라고
    // 적으면 'Railway'라고 박아 둔 것과 같은 거짓말이 된다.
    eq(detectProvider({ NODE_ENV: 'production' }), null);
    eq(workerIdentityOf({ NODE_ENV: 'production' }).providerLabel, '실행기');
  });

  test('production이 아니면 로컬로 본다', () => {
    eq(detectProvider({}), 'LOCAL');
  });

  test('빈 문자열은 값이 아니다', () => {
    eq(detectProvider({ FLY_APP_NAME: '   ', NODE_ENV: 'production' }), null);
  });

  test('지역·머신·커밋을 같이 적는다', () => {
    const id = workerIdentityOf({
      FLY_APP_NAME: 'auto-platform', FLY_REGION: 'nrt', FLY_MACHINE_ID: 'm1', GIT_SHA: 'abc1234',
      NODE_ENV: 'production',
    });
    eq(id.provider, 'FLY');
    eq(id.providerLabel, 'Fly');
    eq(id.region, 'nrt');
    eq(id.machineId, 'm1');
    eq(id.gitSha, 'abc1234');
  });

  test('커밋이 비어 있으면 "같음"이 아니라 null이다', () => {
    eq(workerIdentityOf({ FLY_APP_NAME: 'x', NODE_ENV: 'production' }).gitSha, null);
  });

  test('지문 비교 — 한쪽이라도 없으면 같다고 말하지 않는다', () => {
    eq(fingerprintPair('abc123', 'abc123'), 'SAME');
    eq(fingerprintPair('abc123', 'def456'), 'DIFFERENT');
    eq(fingerprintPair('abc123', null), 'UNKNOWN');
    eq(fingerprintPair('', ''), 'UNKNOWN');
  });
}
