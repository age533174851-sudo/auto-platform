#!/usr/bin/env node
// scripts/wait-migrations.mjs
//
// **배포 전에 DB가 코드를 따라왔는지 본다. 다만 12초를 못 기다려서
// 매번 실패하지는 않는다.**
//
// #182를 합친 순간 같은 push에서 두 워크플로가 같이 출발했다:
//
//   01:36:03  fly-deploy  PENDING(067) → 배포 중단, 사람이 재실행해야 함
//   01:36:15  migrate     067 적용 완료
//
// 게이트는 옳았다 — DB가 뒤처진 채로 워커를 바꾸면 안 된다. 문제는
// **마이그레이션이 들어간 merge마다 배포가 반드시 한 번 실패**한다는
// 것이었다. 판정을 느슨하게 하지 않고 시간만 준다(`migrationWait.ts`).
//
// 값은 찍지 않는다 — DB 주소도 비밀번호도 로그에 넣지 않는다.
// (`apply-migrations.mjs --check`가 지문만 출력한다.)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPORT = process.env.MIGRATION_REPORT_PATH || 'migration-report.json';

function loadJudge() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-migwait-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, 'src/lib/ops/migrationWait.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

/** 상태를 한 번 읽는다. **읽기에 실패하면 null이다 — UP_TO_DATE가 아니다** */
function readState() {
  try {
    // --check는 아무것도 바꾸지 않는다. 실패해도 리포트는 남을 수 있다.
    execFileSync(process.execPath, ['scripts/apply-migrations.mjs', '--check'],
      { stdio: 'inherit' });
  } catch { /* 아래에서 리포트를 본다 */ }
  try {
    const r = JSON.parse(readFileSync(REPORT, 'utf8'));
    const pending = Array.isArray(r?.pending)
      ? r.pending.map(p => String(p?.name || p)).filter(Boolean) : [];
    return { code: r?.code ?? null, pending };
  } catch { return { code: null, pending: [] }; }
}

async function main() {
  if (!String(process.env.SUPABASE_DB_URL || '').trim()) {
    // 예전 동작 그대로: 주소를 모르면 배포는 진행한다.
    // 다만 **확인했다고 적지 않는다.**
    console.log('::warning::SUPABASE_DB_URL이 없어 마이그레이션 상태를 확인하지 못했습니다 — '
      + 'DB가 따라와 있다는 뜻이 아닙니다');
    return 0;
  }

  const dir = loadJudge();
  const { migrationWaitVerdict, MIGRATION_WAIT_BUDGET_MS, MIGRATION_WAIT_INTERVAL_MS } =
    await import(`file://${join(dir, 'migrationWait.js')}`);

  const startMs = Date.now();
  let last = null;
  for (;;) {
    const { code, pending } = readState();
    const elapsedMs = Date.now() - startMs;
    last = migrationWaitVerdict({ code, pending, elapsedMs, budgetMs: MIGRATION_WAIT_BUDGET_MS });
    console.log(`마이그레이션 상태: ${code ?? '(못 읽음)'} → ${last.code}`);
    if (last.done) break;
    console.log(`${Math.round(MIGRATION_WAIT_INTERVAL_MS / 1000)}초 뒤 다시 봅니다 — ${last.reason}`);
    await new Promise(r => setTimeout(r, MIGRATION_WAIT_INTERVAL_MS));
  }

  if (last.proceed) { console.log(last.reason); return 0; }
  console.log(`::error::${last.reason}`);
  return 1;
}

main().then(c => process.exit(c)).catch(e => {
  console.log(`::error::마이그레이션 확인에 실패했습니다: ${String(e?.message || e).slice(0, 200)}`);
  process.exit(1);
});
