#!/usr/bin/env node
// scripts/vercel-redeploy-proof.mjs
//
// **운영 secret 없이, 진짜 스크립트를 진짜로 돌려서 계약을 확인한다.**
//
// 왜 단위 테스트만으로 부족한가
// ─────────────────────────────
// 이 저장소가 두 번 당한 고장이 "만들어 놓고 배선을 안 함"이다. 판정
// (`vercelRedeploy.ts`)에 테스트가 붙어 있어도, **그 판정을 부르는 쪽이
// 엉뚱한 칸을 읽거나 hook을 두 번 누르면** 테스트는 초록인 채로 사고가 난다.
//
// 그래서 여기서는 `scripts/vercel-redeploy.mjs`를 **그대로** 실행한다.
// 배포 상태 엔드포인트 · Deploy Hook · GitHub API를 흉내내는 작은 서버를
// 띄우고, 실제로 hook이 **몇 번** 눌렸는지 센다. 누르지 말아야 할 자리에서
// 1이 되면 실패다.
//
// 운영에 닿지 않는다: 127.0.0.1만 쓴다. 토큰도 secret도 필요 없다.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const MAIN = 'c61271eb58472a11d684799ea959765fe4618831';
const OLD = 'ae069124ec3330dde7b0b7073d966b6b5c66c4e6';
const HOOK_PATH = '/hook/zzz-secret-path-should-never-be-printed';

let fails = 0;
const ok = (l, v) => console.log(`ok  ${l}  → ${v}`);
const bad = (l, want, got) => { console.log(`FAIL ${l} : 기대 [${want}] / 실제 [${got}]`); fails += 1; };
const want = (l, expect, got) => (String(expect) === String(got) ? ok(l, got) : bad(l, expect, got));

// ── 흉내 서버 ──
//
// 시나리오마다 state를 갈아 끼운다. **hook 호출 횟수를 여기서 센다** —
// 스크립트의 로그를 믿지 않고 서버가 받은 것을 센다.
const state = {
  deployment: null,
  hookStatus: 200,
  hookCalls: 0,
  flipOnHook: false,
  runs: [],
  runsStatus: 200,
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/system/deployment') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(state.deployment));
  }
  if (url.pathname === HOOK_PATH && req.method === 'POST') {
    state.hookCalls += 1;
    if (state.flipOnHook) state.deployment.vercel.sha = MAIN;
    res.writeHead(state.hookStatus);
    return res.end('{}');
  }
  if (url.pathname.endsWith('/actions/workflows/vercel-redeploy.yml/runs')) {
    res.writeHead(state.runsStatus, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ workflow_runs: state.runs }));
  }
  res.writeHead(404); res.end('{}');
});

function body({ vercel = OLD, fly = MAIN, pending = 0, alive = true } = {}) {
  return {
    ok: true,
    migrations: { applied: true, code: 'UP_TO_DATE', pending: [], pendingCount: pending },
    vercel: { sha: vercel, short: vercel.slice(0, 7) },
    fly: { sha: fly, alive, ageSec: 3, status: 'running' },
    main: { sha: MAIN, short: MAIN.slice(0, 7) },
    verdict: { code: vercel === MAIN && fly === MAIN ? 'MATCHED' : 'MISMATCH', matched: false, reason: '' },
  };
}

async function run(scenario) {
  state.deployment = scenario.deployment ?? body();
  state.hookStatus = scenario.hookStatus ?? 200;
  state.hookCalls = 0;
  state.flipOnHook = Boolean(scenario.flipOnHook);
  state.runs = scenario.runs ?? [];
  state.runsStatus = scenario.runsStatus ?? 200;

  const port = server.address().port;
  const env = {
    ...process.env,
    BASE: `http://127.0.0.1:${port}`,
    MAIN,
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    GITHUB_REPOSITORY: 'age533174851-sudo/auto-platform',
    GITHUB_TOKEN: 'mock-token-not-a-real-secret',
    GITHUB_RUN_ID: '999999',
    // 기다리는 시간을 줄인다. **판정을 바꾸지 않는다** — 몇 번 다시 읽는지만 줄인다.
    VERCEL_REDEPLOY_WAIT_MS: '2500',
    VERCEL_REDEPLOY_POLL_MS: '500',
  };
  if (scenario.hook === false) delete env.VERCEL_DEPLOY_HOOK_URL;
  else env.VERCEL_DEPLOY_HOOK_URL = `http://127.0.0.1:${port}${HOOK_PATH}`;

  // **spawnSync를 쓰지 않는다.** 흉내 서버가 이 프로세스의 이벤트 루프에
  // 얹혀 있어서, 동기 spawn은 자기 자식의 요청을 받아 줄 수 없다 —
  // 자식은 60초를 기다리다 timeout으로 끝나고, 그 결과는 "읽지 못했다"가
  // 된다. 검사가 계약이 아니라 하네스 때문에 빨개지는 자리다.
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/vercel-redeploy.mjs'], { env });
    let out = '';
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { out += b; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', code => {
      clearTimeout(kill);
      resolve({ code, out, hookCalls: state.hookCalls });
    });
  });
}

async function check(label, scenario, expect) {
  const r = await run(scenario);
  const line = (r.out.match(/^판정: (\S+)/m) || [])[1] ?? '(없음)';
  const outcome = (r.out.match(/^결과: (\S+)/m) || [])[1] ?? null;
  want(`${label} · 판정`, expect.code, line);
  want(`${label} · hook 호출 횟수`, expect.hookCalls, r.hookCalls);
  want(`${label} · 종료코드`, expect.exit, r.code);
  if (expect.outcome) want(`${label} · 결말`, expect.outcome, outcome);
  // **주소가 로그에 새면 그 자체가 실패다.**
  if (r.out.includes('zzz-secret-path-should-never-be-printed')) {
    bad(`${label} · hook 주소가 로그에 없다`, '없음', '있음');
  } else {
    ok(`${label} · hook 주소가 로그에 없다`, '없음');
  }
  return r;
}

await new Promise(res => server.listen(0, '127.0.0.1', res));
console.log('── Vercel 재배포 복구 실행 증명 (흉내 서버 · 운영 secret 0) ──\n');

// ══ 누르지 않아야 하는 자리 ══
await check('hook 미설정', { hook: false }, { code: 'SKIP_NO_HOOK', hookCalls: 0, exit: 0 });
await check('이미 같음', { deployment: body({ vercel: MAIN }) }, { code: 'SKIP_MATCHED', hookCalls: 0, exit: 0 });
await check('Fly도 뒤처짐', { deployment: body({ fly: OLD }) }, { code: 'SKIP_NOT_VERCEL_ONLY', hookCalls: 0, exit: 0 });
await check('마이그레이션 대기', { deployment: body({ pending: 2 }) }, { code: 'SKIP_MIGRATIONS_PENDING', hookCalls: 0, exit: 0 });
await check('워커 죽음', { deployment: body({ alive: false }) }, { code: 'SKIP_WORKER', hookCalls: 0, exit: 0 });
await check('지난 시도를 못 셈', { runsStatus: 500 }, { code: 'SKIP_UNKNOWN', hookCalls: 0, exit: 0 });
await check('방금 눌렀음(쿨다운)', {
  runs: [{ id: 1, created_at: new Date(Date.now() - 30_000).toISOString() }],
}, { code: 'SKIP_COOLDOWN', hookCalls: 0, exit: 0 });

// **한도까지 실패한 것은 조용히 넘기지 않는다 — 종료코드 1이다.**
await check('한도 소진', {
  runs: [1, 2, 3].map(i => ({ id: i, created_at: new Date(Date.now() - 3 * 3600_000).toISOString() })),
}, { code: 'SKIP_ATTEMPTS_EXHAUSTED', hookCalls: 0, exit: 1 });

// ══ 눌러야 하는 자리 ══
await check('Vercel만 뒤처짐 → 눌렀는데 안 바뀜', {}, {
  code: 'FIRE', hookCalls: 1, exit: 1, outcome: 'FIRED_NOT_VERIFIED',
});
await check('Vercel만 뒤처짐 → 눌렀고 실제로 바뀜', { flipOnHook: true }, {
  code: 'FIRE', hookCalls: 1, exit: 0, outcome: 'VERIFIED',
});
await check('hook이 거부함', { hookStatus: 403 }, {
  code: 'FIRE', hookCalls: 1, exit: 1, outcome: 'HOOK_FAILED',
});

// ══ 한 번만 누른다 ══
//
// 재시도 루프가 hook을 반복해서 누르면 배포가 쌓인다. 위 '안 바뀜' 시나리오는
// 2.5초 동안 다시 읽기를 5번 하는데, 그동안 hook 호출은 1이어야 한다.
const again = await run({});
want('다시 읽는 동안 hook을 또 누르지 않는다', 1, again.hookCalls);
want('다시 읽기를 실제로 여러 번 한다', true, (again.out.match(/^ {2}· \d+초 —/gm) || []).length >= 2);

server.close();

const n = Number((process.argv.find(a => a.startsWith('--min=')) || '--min=0').slice(6));
console.log(`\n확인 ${fails === 0 ? '전부 통과' : `${fails}건 실패`}`);
if (fails > 0) process.exit(1);
if (n > 0) console.log(`(최소 ${n}건 요구)`);
