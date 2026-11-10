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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

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

/**
 * 즉시 500으로 답하는 **가짜 Supabase.** 연결은 받아 주되 데이터는 주지 않는다.
 *
 * 왜 닫힌 포트(127.0.0.1:1)를 쓰지 않는가 — 실측값이다. 닫힌 포트로 두면
 * `fetch` 재시도 때문에
 *
 *     tick #1  → 7.1초      [jobs] ❌ → 21.1초
 *
 * 가 걸린다. 즉답하는 가짜를 두면 같은 두 줄을 수백 밀리초에 얻는다.
 * 결론은 똑같다(둘 다 조회가 실패한다) — 기다리는 시간만 사라진다.
 *
 * 밖으로 나가는 연결은 없다. 이 프로세스 안의 127.0.0.1 이고 포트는
 * 커널이 골라 준다(0) — 다른 시험과 부딪히지 않는다.
 *
 * 부팅 점검 쪽 시험들은 계속 127.0.0.1:1을 쓴다. 그쪽은 "연결이 애초에
 * 불가능한데도 끝났다"가 증거이므로, 받아 주는 서버를 두면 주장이 약해진다.
 */
function startDeadSupabase() {
  const server = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"message":"stub: 이 시험은 데이터를 주지 않는다"}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * 워커를 띄우고 **찾는 줄이 보이는 즉시 죽인다.**
 *
 * 왜 끝까지 기다리지 않는가 — 실측한 값이다. 스위치 없이 띄운 워커는
 * 영원히 돌기 때문에 `spawnSync`로는 timeout 을 꽉 채운다. 그 30초가
 * 이 파일 32초 중 30초였다. 그런데 `scripts/cta-verdict-mutations.mjs`
 * 는 변이 **44건마다** `run-tests.mjs` 를 통째로 다시 돌린다. 그래서
 * 30초가 44배가 되어 CI `verify` 에 **+11분**이 붙고, 20분짜리 작업이
 * 30분 제한(`ci.yml` `timeout-minutes: 30`)을 넘겨 취소됐다.
 *
 * 증거는 "tick 에 들어갔다"는 줄이 나오는 순간 이미 다 모였다. 그 뒤로
 * 기다리는 시간은 아무것도 더 증명하지 않는다.
 *
 * `reason` 을 같이 돌려주므로 시험이 **조기 종료가 실제로 동작했는지**
 * 확인할 수 있다 — 누가 이 최적화를 되돌리면 `timeout` 이 되어 빨개진다.
 */
function runWorkerUntil(env, patterns, hardTimeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ARTIFACT], { env });
    let out = '';
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* 이미 죽었으면 됐다 */ }
      resolve({ out, reason });
    };
    const timer = setTimeout(() => finish('timeout'), hardTimeoutMs);
    const onData = (b) => {
      out += String(b);
      if (patterns.every(p => p.test(out))) finish('matched');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => finish('error'));
    // 'close' 는 stdio 가 다 닫힌 뒤다. 'exit' 는 출력이 남아 있을 수 있다.
    child.on('close', () => finish('closed'));
  });
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

test('★★ 음성 대조: 스위치가 없으면 같은 환경에서 tick 에 들어간다', async () => {
  // 들어가는 것을 **확인하는 순간** 죽인다. 영원히 도는 루프라서, 끝까지
  // 기다리면 그 시간이 cta-verdict 변이 44배로 곱해진다(위 주석 참고).
  const stub = await startDeadSupabase();
  try {
    const { out, reason } = await runWorkerUntil(
      { ...BASE_ENV, SUPABASE_URL: stub.url }, [/tick #/, /\[jobs\]/], 60_000);
    assert.match(out, /tick #/,
      '스위치 없이도 tick 에 안 들어갔다 — 그러면 위 시험이 무엇도 증명하지 못한다');
    assert.match(out, /\[jobs\]/, '스위치 없이도 jobs 를 안 봤다 — 음성 대조가 성립하지 않는다');
    // 조기 종료가 동작했는가. 되돌리면 60초를 꽉 채우고 여기서 빨개진다.
    assert.equal(reason, 'matched',
      `증거를 보고 즉시 끝내지 못했다 (${reason}) — 이 파일 비용이 CI 에서 44배로 곱해진다`);
  } finally {
    await stub.close();
  }
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
  const rj = JSON.parse(readFileSync('railway.json', 'utf8'));
  const start = String(rj?.deploy?.startCommand ?? '');
  assert.match(start, /cd worker/, `startCommand 가 worker 에서 돌지 않는다: ${start}`);
  const m = start.match(/npm start/);
  assert.ok(m, `startCommand 가 npm start 가 아니다: ${start}`);
  const pkg = JSON.parse(readFileSync('worker/package.json', 'utf8'));
  const rel = String(pkg?.scripts?.start ?? '').replace(/^node\s+/, '');
  assert.equal(`worker/${rel}`, ARTIFACT,
    `npm start 가 찾는 경로(worker/${rel})와 실제 산출물(${ARTIFACT})이 다르다`);
});

test('★★ 숫자 환경변수에 오타가 있으면 통과시키지 않는다', () => {
  // 왜 이게 치명적인가 (빌드된 supabase.js 를 직접 불러 재어 봤다):
  //   WORKER_POLL_SEC=abc → POLL_SEC = Math.max(1, Math.min(15, NaN)) = NaN
  //   → acquireLock(..., NaN) 안의 `new Date(now + NaN).toISOString()` 이
  //     **그 함수의 try 바깥**에서 RangeError 를 던진다
  //   → tick() 의 `catch { isMain = true }` 가 받는다
  //   → **모든 워커가 자기를 main 이라고 믿는다** (중복 main 진입)
  // Fly → Railway 겹치는 구간에서 이게 두 배로 돈다.
  const { status, out } = runWorker(
    { ...BASE_ENV, WORKER_BOOT_CHECK: '1', WORKER_POLL_SEC: 'abc' }, 60_000);
  assert.equal(status, 1, `숫자 아닌 WORKER_POLL_SEC 를 통과시켰다 (exit ${status})\n${out}`);
  assert.match(out, /WORKER_POLL_SEC/, '어느 변수가 문제인지 적지 않았다');
  assert.doesNotMatch(out, /tick #/, 'tick 에 들어갔다');
  // 통과 문구가 같이 찍히면 사람은 통과로 읽는다
  assert.doesNotMatch(out, /부팅 점검 통과/, '거부하면서 통과 문구도 찍었다');
});

test('★ 음성 대조: 정상 숫자는 통과시킨다 — 울기만 하는 검사기가 아니다', () => {
  const { status, out } = runWorker(
    { ...BASE_ENV, WORKER_BOOT_CHECK: '1', WORKER_POLL_SEC: '3',
      LEDGER_SYNC_INTERVAL_MS: '900000' }, 60_000);
  assert.equal(status, 0, `정상 숫자인데 거부했다 (exit ${status})\n${out}`);
  assert.match(out, /부팅 점검 통과/, '통과 문구가 없다');
});

test('★★ NUMERIC_ENV 표가 worker/src/index.ts 의 실제 코드와 어긋나지 않는다', () => {
  // 이 시험이 막는 것: 나중에 숫자 env 가 하나 늘었는데 표에 안 들어가서
  // **그 칸의 오타만 조용히 통과하는 상태.** 표가 코드를 따라가는지는
  // 사람이 기억할 일이 아니다.
  const src = readFileSync('worker/src/index.ts', 'utf8');
  const mod = readFileSync('src/lib/runtime/workerBootCheck.ts', 'utf8');

  // 코드에서 숫자로 읽는 env 를 실제로 긁는다: parseInt(process.env.X 또는 Number(process.env.X
  const found = new Map();           // 이름 → 'parseInt' | 'Number'
  for (const m of src.matchAll(/\b(parseInt|Number)\(\s*process\.env\.([A-Z0-9_]+)/g)) {
    found.set(m[2], m[1]);
  }
  assert.ok(found.size >= 7,
    `worker/src/index.ts 에서 숫자 env 를 ${found.size}개만 찾았다 — 정규식이 코드를 못 따라가고 있다`);

  // 표에 적힌 것 긁기
  const listed = new Map();
  const block = mod.match(/NUMERIC_ENV[^=]*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(block, 'NUMERIC_ENV 표를 모듈에서 찾지 못했다');
  for (const m of block[1].matchAll(/name:\s*'([A-Z0-9_]+)'\s*,\s*parse:\s*'(parseInt|Number)'/g)) {
    listed.set(m[1], m[2]);
  }

  for (const [name, parse] of found) {
    assert.ok(listed.has(name),
      `${name} 을 코드는 숫자로 읽는데 NUMERIC_ENV 표에 없다 — 그 칸의 오타는 아무도 모른다`);
    assert.equal(listed.get(name), parse,
      `${name}: 코드는 ${parse} 로 읽는데 표는 ${listed.get(name)} 로 적혀 있다 — 판정이 실제와 달라진다`);
  }
  for (const name of listed.keys()) {
    assert.ok(found.has(name),
      `${name} 이 표에 있는데 코드는 숫자로 읽지 않는다 — 낡은 항목이다`);
  }
});
