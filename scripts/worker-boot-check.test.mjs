// scripts/worker-boot-check.test.mjs
//
// **부팅 점검이 정말로 아무 일도 하지 않는지 실제 프로세스로 확인한다.**
//
// 왜 유닛 시험으로 안 되나
// ────────────────────────
// `processPendingJobs`·`monitorConnections`·`pollSchedules`·
// `pollExitMonitor`·`pollScheduledExit`는 `worker/src/index.ts` 안의
// 모듈 내부 함수이고, 그 파일은 최상위에서 `main()`을 부른다. 즉
// import 하는 순간 워커가 **돌기 시작한다.** 그래서 "0번 불렸다"를
// import로는 증명할 수 없다.
//
// 그래서 빌드된 산출물을 **자식 프로세스로 띄워** 출력과 종료코드로 본다.
// DB·네트워크·거래소 없이: `SUPABASE_URL`을 127.0.0.1:1(즉시 거부)로 준다.
//
// 음성 대조가 핵심이다
// ────────────────────
// 스위치 **없이** 띄우면 같은 환경에서 `tick #1`에 들어가고 `[jobs]`
// 조회와 `[heartbeat]` 쓰기를 실제로 시도한다. 그 줄들이 스위치를 켰을
// 때 사라지는 것이 "0번 불렸다"의 증거다. 스위치를 켠 쪽만 보면
// "원래 안 하는 것"과 구분할 수 없다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const ARTIFACT = 'worker/dist/worker/src/index.js';

/** DB도 네트워크도 없는 환경. 127.0.0.1:1은 즉시 거부된다 */
const BASE_ENV = {
  PATH: process.env.PATH,
  SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-not-a-real-key',
  EXCHANGE_ENCRYPTION_KEY: 'fake-key-for-test',
  GIT_SHA: 'deadbeef1234567',
};

function runWorker(env, timeoutMs) {
  const r = spawnSync(process.execPath, [ARTIFACT], {
    env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('워커 산출물이 있다 (없으면 빌드한다 — 건너뛰지 않는다)', () => {
  if (!existsSync(ARTIFACT)) {
    execFileSync('npm', ['run', 'build', '--prefix', 'worker'], { stdio: 'inherit' });
  }
  assert.ok(existsSync(ARTIFACT),
    `${ARTIFACT} 가 없다 — railway.json 의 start 가 가리키는 경로다`);
});

test('★★ 부팅 점검 모드는 tick 에 들어가지 않는다 (jobs·heartbeat 0)', () => {
  const { status, out } = runWorker({ ...BASE_ENV, WORKER_BOOT_CHECK: '1' }, 60_000);
  assert.equal(status, 0, `종료코드가 0이 아니다 (${status})\n${out}`);
  assert.match(out, /부팅 점검 모드/, '부팅 점검 모드 표시가 없다');
  assert.match(out, /부팅 가능/, '통과 문구가 없다');
  // ★ 핵심: 아무 일도 하지 않았다
  assert.doesNotMatch(out, /tick #/, 'tick 에 들어갔다');
  assert.doesNotMatch(out, /\[jobs\]/, 'PENDING 잡을 조회했다 — processPendingJobs 가 돌았다');
  assert.doesNotMatch(out, /\[heartbeat\]/, 'heartbeat 를 썼다 — DB 쓰기가 일어났다');
  assert.doesNotMatch(out, /\[smoke\]/, '스모크 경로에 들어갔다');
  // 값이 로그에 새지 않는다
  assert.doesNotMatch(out, /fake-not-a-real-key|fake-key-for-test/, '시크릿 값이 로그에 찍혔다');
});

test('★★ 음성 대조: 스위치가 없으면 같은 환경에서 tick 에 들어간다', () => {
  // 들어가는 것을 확인하면 바로 죽인다. 영원히 도는 루프다.
  const { out } = runWorker({ ...BASE_ENV }, 30_000);
  assert.match(out, /tick #/,
    '스위치 없이도 tick 에 안 들어갔다 — 그러면 위 시험이 무엇도 증명하지 못한다');
  assert.match(out, /\[jobs\]/, '스위치 없이도 jobs 를 안 봤다 — 음성 대조가 성립하지 않는다');
});

test('★★ 필수 환경변수가 없으면 통과시키지 않는다', () => {
  for (const drop of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'EXCHANGE_ENCRYPTION_KEY']) {
    const env = { ...BASE_ENV, WORKER_BOOT_CHECK: '1' };
    delete env[drop];
    const { status, out } = runWorker(env, 60_000);
    assert.equal(status, 1, `${drop} 가 없는데 종료코드가 ${status} 다 — 통과시켰다\n${out}`);
    assert.match(out, /필수 환경변수 누락/, `${drop}: 이유를 적지 않았다`);
    assert.doesNotMatch(out, /tick #/, `${drop}: tick 에 들어갔다`);
  }
});

test('★ 빈 문자열은 값이 아니다 — 호스팅 UI에서 변수만 만든 경우', () => {
  const { status, out } = runWorker(
    { ...BASE_ENV, WORKER_BOOT_CHECK: '1', SUPABASE_SERVICE_ROLE_KEY: '' }, 60_000);
  assert.equal(status, 1, `빈 문자열을 값으로 읽었다 (exit ${status})\n${out}`);
  assert.match(out, /SUPABASE_SERVICE_ROLE_KEY/, '어느 변수가 비었는지 적지 않았다');
});

test('★ railway.json 의 start 경로가 산출물과 맞는다', () => {
  const rj = JSON.parse(execFileSync('cat', ['railway.json'], { encoding: 'utf8' }));
  const start = String(rj?.deploy?.startCommand ?? '');
  assert.match(start, /cd worker/, `startCommand 가 worker 에서 돌지 않는다: ${start}`);
  const m = start.match(/npm start/);
  assert.ok(m, `startCommand 가 npm start 가 아니다: ${start}`);
  const pkg = JSON.parse(execFileSync('cat', ['worker/package.json'], { encoding: 'utf8' }));
  const rel = String(pkg?.scripts?.start ?? '').replace(/^node\s+/, '');
  assert.equal(`worker/${rel}`, ARTIFACT,
    `npm start 가 찾는 경로(worker/${rel})와 실제 산출물(${ARTIFACT})이 다르다`);
});
