#!/usr/bin/env node
// scripts/dispatch-deploy-after-migrate.mjs
//
// **승인해서 위험 마이그레이션을 적용했으면 배포까지 부른다 (#450).**
//
// 왜 이 스크립트가 있나
// ─────────────────────
// DESTRUCTIVE 마이그레이션은 `migrate`를 `workflow_dispatch`로 손수 돌려
// 승인한다. 그런데 그 적용은 **main에 push를 만들지 않는다.** 그래서
// `fly-deploy`의 `push` 트리거가 오지 않고, `workflow_run` 트리거는
// `head_branch == 'main'` 가드에 걸려 언제나 skipped다.
//
// 결과는 **승인했는데 배포가 안 되는 것**이었다. 2026-11-01 ~ 11-06 사이에
// 실제로 그랬다: fly-deploy가 7회 연속 `마이그레이션이 끝나기를 기다린다`
// 단계에서 멈췄고, Worker는 11-01 빌드(`4f6ee8c6`)에 남아 main보다
// 89커밋 뒤처진 코드로 거래를 보고 있었다.
//
// 사람이 "승인한 뒤에 fly-deploy도 눌러야 한다"를 기억하는 구조는
// 언젠가 잊힌다. 그 단계를 없애는 것이 이 파일이 하는 일이다.
//
// **판정을 여기서 다시 쓰지 않는다.** 부를지 말지는
// `src/lib/ci/deployDispatch.ts`의 `approvedMigrationDeployPlan`이 정하고,
// 주소는 `deployDispatchRequest`가 만든다. 조건을 YAML이나 스크립트에
// 묻어 두면 값으로 확인할 방법이 없어지고, 이 저장소의 배포 자동화는
// 바로 그래서 두 번 조용히 죽었다(8/9 · 8/13).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || '';
// `migrate.yml`의 `steps.approval.outputs.approve` — 승인한 파일명 하나
const APPROVED = process.env.APPROVED_MIGRATION || '';
// 적용 단계의 결과. 워크플로가 `steps.apply.outcome`을 그대로 넘긴다
const APPLY_OUTCOME = process.env.APPLY_OUTCOME || '';

/** 판정 모듈을 컴파일해서 쓴다 — 같은 파일을 쓰므로 갈릴 수가 없다 */
function loadJudge() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-deploy-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, 'src/lib/ci/deployDispatch.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

async function api(path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text } }
  return { ok: r.ok, status: r.status, body };
}

async function main() {
  if (!REPO || !/^[^/\s]+\/[^/\s]+$/.test(REPO)) {
    console.log(`⚠ GITHUB_REPOSITORY가 올바르지 않습니다 (${REPO || '없음'}) — 배포를 부르지 않습니다`);
    return;
  }

  const outDir = loadJudge();
  const { approvedMigrationDeployPlan, deployDispatchRequest, dispatchResultNote } =
    await import(`file://${join(outDir, 'deployDispatch.js')}`);

  const plan = approvedMigrationDeployPlan({
    approvedFile: APPROVED,
    // **문자열을 그대로 믿지 않는다.** `success`만 성공이다 —
    // 빈 값·`skipped`·`failure`는 전부 "성공으로 확인되지 않음"이다.
    applyOk: APPLY_OUTCOME === 'success',
    hasToken: !!TOKEN,
  });

  console.log(`배포 호출: ${plan.code} — ${plan.reason}`);
  if (!plan.dispatch) return;

  const req = deployDispatchRequest(REPO);
  const r = await api(req.path, { method: req.method, body: req.body });
  console.log(dispatchResultNote({ ok: r.ok, status: r.status, message: r.body?.message ?? null }));

  // **실패를 성공으로 적지 않는다.** 다만 이 단계가 실패해도 마이그레이션
  // 적용은 이미 끝났으므로 워크플로 전체를 빨갛게 만들지는 않는다 —
  // 대신 무엇을 손으로 해야 하는지 위 한 줄이 적는다.
  if (!r.ok) {
    console.log(`::warning::fly-deploy를 부르지 못했습니다 (HTTP ${r.status}) — `
      + '손으로 fly-deploy를 실행하세요. Worker는 그때까지 옛 코드로 돕니다');
  }
}

main().catch((e) => {
  console.log(`::warning::배포 호출 중 오류 — ${e?.message || e}. `
    + '마이그레이션 적용은 끝났습니다. 손으로 fly-deploy를 실행하세요');
});
