#!/usr/bin/env node
// scripts/vercel-redeploy.mjs
//
// **Vercel만 옛 코드로 떠 있을 때 다시 배포시키고, 실제로 바뀌었는지 확인한다.**
//
// 왜 있나
// ───────
// 2026-09-13, main c61271eb가 머지되고 6시간 반이 지나도록 Vercel은
// ae069124였다. Fly는 새 코드로 돌고 있었고 마이그레이션도 다 적용돼 있었다.
// `deployment-check`는 그것을 정확히 세 번 잡아냈지만, 고치는 일은 사람이
// 대시보드를 열어야 했다. **자동화할 수 있는 절차를 사람에게 넘기지 않는다.**
//
// 무엇을 하지 않나
// ────────────────
// · 토큰으로 배포하지 않는다. CLI도 쓰지 않는다. **Deploy Hook 하나뿐**이고
//   그 주소는 secret으로만 들어온다 — 저장소에 주소가 없다.
// · MISMATCH라고 무조건 누르지 않는다. 판정은 `src/lib/ops/vercelRedeploy.ts`
//   하나에 있고 테스트가 붙어 있다. 여기서 그 판정을 복제하지 않는다.
// · **hook이 200을 준 것을 배포 성공으로 적지 않는다.** 다시 읽은 Vercel SHA가
//   main과 같아야 성공이다.
//
// 값은 찍지 않는다 — hook 주소는 물론이고 어떤 접속 문자열도 로그에 넣지 않는다.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = String(process.env.BASE || '').replace(/\/+$/, '');
const MAIN = String(process.env.MAIN || '').trim();
const HOOK = String(process.env.VERCEL_DEPLOY_HOOK_URL || '').trim();
const API = String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const REPO = String(process.env.GITHUB_REPOSITORY || '').trim();
const TOKEN = String(process.env.GITHUB_TOKEN || '').trim();
const SELF_RUN = String(process.env.GITHUB_RUN_ID || '').trim();
const WORKFLOW_FILE = 'vercel-redeploy.yml';

const WAIT_MS = Number(process.env.VERCEL_REDEPLOY_WAIT_MS || 8 * 60_000);
const POLL_MS = Number(process.env.VERCEL_REDEPLOY_POLL_MS || 20_000);

/** 어디에도 hook 주소가 새지 않게 한다. 예외 메시지에도 URL이 실려 온다 */
function scrub(text) {
  let s = String(text ?? '');
  if (HOOK) s = s.split(HOOK).join('<hook 가림>');
  return s.replace(/https?:\/\/api\.vercel\.com\/[^\s'"]+/gi, '<hook 가림>');
}
const say = (...a) => console.log(scrub(a.join(' ')));

function loadJudge() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-redeploy-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, 'src/lib/ops/vercelRedeploy.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

/** 배포 상태를 읽는다. 이 경로는 인증이 없다 — 헤더를 붙이지 않는다 */
async function readDeployment() {
  let url = `${BASE}/api/system/deployment`;
  if (MAIN) url += `?main=${encodeURIComponent(MAIN)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (r.status !== 200) return { status: r.status, body: null };
    return { status: 200, body: await r.json().catch(() => null) };
  } catch (e) {
    say(`::warning::배포 상태를 읽지 못했습니다: ${String(e?.message || e).slice(0, 120)}`);
    return { status: null, body: null };
  }
}

/**
 * 같은 SHA로 지금까지 몇 번 깨웠는가.
 *
 * **새 저장소를 만들지 않는다.** 이 워크플로의 실행 기록 자체가 시도 기록이다.
 * 세지 못하면 **0이 아니라 null**을 돌려준다 — 판정이 그때는 누르지 않는다.
 *
 * 보수적으로 센다: 눌렀는지 아닌지와 무관하게 같은 SHA의 지난 실행을 전부
 * 센다. 덜 누르는 쪽으로 틀리는 것이 더 누르는 쪽으로 틀리는 것보다 낫다.
 */
async function readAttempts() {
  if (!TOKEN || !REPO || !MAIN) return { attempts: null, lastAttemptIso: null };
  const url = `${API}/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs`
    + `?head_sha=${encodeURIComponent(MAIN)}&per_page=100`;
  try {
    const r = await fetch(url, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'traigo-vercel-redeploy',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status !== 200) {
      say(`::warning::지난 시도를 세지 못했습니다 (HTTP ${r.status})`);
      return { attempts: null, lastAttemptIso: null };
    }
    const j = await r.json().catch(() => null);
    const runs = Array.isArray(j?.workflow_runs) ? j.workflow_runs : null;
    if (!runs) return { attempts: null, lastAttemptIso: null };
    const prior = runs.filter(x => String(x?.id ?? '') !== SELF_RUN);
    const times = prior.map(x => Date.parse(x?.created_at || '')).filter(Number.isFinite);
    return {
      attempts: prior.length,
      lastAttemptIso: times.length ? new Date(Math.max(...times)).toISOString() : null,
    };
  } catch (e) {
    say(`::warning::지난 시도를 세지 못했습니다: ${String(e?.message || e).slice(0, 120)}`);
    return { attempts: null, lastAttemptIso: null };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!BASE) {
    say('::error::확인할 주소가 없습니다 (EXIT_MONITOR_URL) — 배포 상태를 확인하지 못했습니다');
    return 1;
  }

  const dir = loadJudge();
  const { redeployDecision, redeployOutcome } = await import(`file://${join(dir, 'vercelRedeploy.js')}`);

  const first = await readDeployment();
  const body = first.body;
  const read = {
    mainSha: body?.main?.sha ?? null,
    vercelSha: body?.vercel?.sha ?? null,
    flySha: body?.fly?.sha ?? null,
    pendingCount: typeof body?.migrations?.pendingCount === 'number' ? body.migrations.pendingCount : null,
    workerAlive: typeof body?.fly?.alive === 'boolean' ? body.fly.alive : null,
  };
  say(`main ${String(read.mainSha ?? '?').slice(0, 7)}`
    + ` · vercel ${String(read.vercelSha ?? '?').slice(0, 7)}`
    + ` · fly ${String(read.flySha ?? '?').slice(0, 7)}`
    + ` · 남은 마이그레이션 ${read.pendingCount ?? '확인 못 함'}`
    + ` · 워커 ${read.workerAlive == null ? '확인 못 함' : read.workerAlive ? '살아 있음' : '없음'}`);

  // hook이 없을 때는 지난 시도를 세러 가지도 않는다 — 할 일이 없다.
  const counted = HOOK ? await readAttempts() : { attempts: 0, lastAttemptIso: null };
  if (HOOK) {
    say(`같은 SHA 지난 시도: ${counted.attempts == null ? '세지 못함' : counted.attempts}건`
      + (counted.lastAttemptIso ? ` · 마지막 ${counted.lastAttemptIso}` : ''));
  }

  const d = redeployDecision({
    hookConfigured: Boolean(HOOK),
    ...read,
    attempts: counted.attempts,
    lastAttemptIso: counted.lastAttemptIso,
    now: Date.now(),
  });
  say(`판정: ${d.code} — ${d.reason}`);

  if (!d.fire) {
    // **자동 복구가 한도까지 갔는데도 안 됐다는 것은 조용히 넘길 일이 아니다.**
    if (d.code === 'SKIP_ATTEMPTS_EXHAUSTED') {
      say(`::error::자동 복구가 한도까지 실패했습니다 — 사람이 봐야 합니다 (${d.reason})`);
      return 1;
    }
    say(`::notice::재배포하지 않았습니다 (${d.code})`);
    return 0;
  }

  // ── 여기서만 hook을 깨운다 ──
  let hookOk = false;
  let hookStatus = null;
  try {
    const r = await fetch(HOOK, { method: 'POST', signal: AbortSignal.timeout(60_000) });
    hookStatus = r.status;
    hookOk = r.status >= 200 && r.status < 300;
  } catch (e) {
    say(`::warning::Deploy Hook 호출이 실패했습니다: ${String(e?.message || e).slice(0, 120)}`);
  }
  say(`Deploy Hook 호출: HTTP ${hookStatus ?? '없음'} (주소는 적지 않습니다)`);

  // ── 정말로 바뀌었는지 **다시 읽어서** 확인한다 ──
  let vercelAfter = read.vercelSha;
  let waitedMs = 0;
  if (hookOk) {
    const started = Date.now();
    while (Date.now() - started < WAIT_MS) {
      await sleep(POLL_MS);
      const again = await readDeployment();
      const got = again.body?.vercel?.sha ?? null;
      waitedMs = Date.now() - started;
      if (got) vercelAfter = got;
      say(`  · ${Math.round(waitedMs / 1000)}초 — vercel ${String(got ?? '?').slice(0, 7)}`);
      if (got && MAIN && String(got).trim().toLowerCase() === MAIN.toLowerCase()) break;
    }
  }

  const o = redeployOutcome({
    hookOk, hookStatus,
    mainSha: read.mainSha ?? MAIN ?? null,
    vercelShaAfter: vercelAfter,
    waitedSec: Math.round(waitedMs / 1000),
  });
  say(`결과: ${o.code} — ${o.reason}`);
  if (o.ok) return 0;
  say(`::error::${o.reason}`);
  return 1;
}

main().then(c => process.exit(c)).catch(e => {
  console.log(`::error::재배포 복구에 실패했습니다: ${scrub(String(e?.message || e)).slice(0, 200)}`);
  process.exit(1);
});
