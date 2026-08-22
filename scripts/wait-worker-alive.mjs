// scripts/wait-worker-alive.mjs
//
// **배포가 끝난 뒤 워커가 실제로 한 줄 썼는지 본다.**
//
// `flyctl status`의 `started`는 프로세스가 DB에 쓴다는 뜻이 아니다.
// 2026-08-21에 배포는 success였고 status는 started였는데 heartbeat는
// 27.6시간 전 것이었다 — 그동안 청산 감시·원장 수집·자산 스냅샷·예약
// 평가가 전부 멈춰 있었다.
//
// 왜 워크플로 YAML이 아니라 여기인가
// ──────────────────────────────────
// 처음에는 이 폴링을 `run: |` 안의 여러 줄짜리 `python3 -c`로 넣었다.
// 그 줄들이 블록 스칼라의 들여쓰기를 벗어나 `try:`·`except Exception:`이
// **워크플로의 최상위 키**가 됐고, GitHub은 파일을 Startup failure로
// 거절했다. fly-deploy는 아예 실행되지 않았고 `workflow_dispatch`는
// HTTP 422를 돌려줬다 — 배포 자체가 멈췄다.
//
// `yaml.safe_load`는 그 파일을 통과시켰다. 문법상 올바른 YAML이 맞기
// 때문이다. **유효한 YAML과 유효한 워크플로는 다르다.**
//
// 그래서 YAML에는 이 파일을 부르는 한 줄만 남긴다. 들여쓰기로 깨질 것이
// 없고, 판정에는 테스트가 붙어 있다(`src/lib/ops/workerAlive.ts`).
//
// 값은 아무것도 찍지 않는다 — 주소도 로그에 넣지 않는다.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = String(process.env.BASE || '').replace(/\/+$/, '');

function loadJudge() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-alive-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, 'src/lib/ops/workerAlive.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

async function main() {
  if (!BASE) {
    // **주소를 모르는 것은 배포 실패가 아니다.** 다만 확인하지 못한
    // 것을 성공으로 적지도 않는다.
    console.log('::warning::확인할 주소가 없어 워커 생존을 보지 못했습니다 — 배포가 됐다는 뜻이 아닙니다');
    return 0;
  }

  const dir = loadJudge();
  const { workerAliveVerdict, ALIVE_BUDGET_MS, ALIVE_INTERVAL_MS } =
    await import(`file://${join(dir, 'workerAlive.js')}`);

  const startMs = Date.now();
  let last = null;

  for (;;) {
    let body = null;
    try {
      const r = await fetch(`${BASE}/api/system/deployment`, { signal: AbortSignal.timeout(20_000) });
      body = await r.json().catch(() => null);
    } catch { body = null; }

    const elapsedMs = Date.now() - startMs;
    last = workerAliveVerdict({ body, elapsedMs, budgetMs: ALIVE_BUDGET_MS });
    if (last.done) break;
    await new Promise(r => setTimeout(r, ALIVE_INTERVAL_MS));
  }

  if (last.ok) {
    console.log(last.reason);
    return 0;
  }
  console.log(`::error::${last.reason}`);
  console.log('Fly 쪽 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 를 먼저 확인하세요 (값이 아니라 지문으로).');
  return 1;
}

main().then(c => process.exit(c)).catch(e => {
  console.log(`::error::워커 생존 확인에 실패했습니다: ${String(e?.message || e).slice(0, 200)}`);
  process.exit(1);
});
