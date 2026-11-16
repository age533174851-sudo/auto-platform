#!/usr/bin/env node
// scripts/check-migrate-deploy-wiring.mjs
//
// **승인 적용이 끝나면 배포가 자동으로 불려야 한다 (#450).**
//
// 무엇이 끊겨 있었나
// ──────────────────
// 위험 마이그레이션(DESTRUCTIVE)은 `migrate`를 `workflow_dispatch`로 손수
// 돌려 승인한다. 그런데 그 적용은 **main에 push를 만들지 않는다.** 그래서
//
//   · `fly-deploy`의 `push` 트리거가 안 온다
//   · `fly-deploy`의 `workflow_run` 트리거는 `head_branch == 'main'`
//     가드에 걸려 언제나 skipped다 (그 워크플로가 직접 적어 둔 기존 고장)
//   · `migrate.yml`에는 배포를 깨우는 단계가 없었다
//
// 결과: 승인해서 마이그레이션이 적용돼도 **Worker는 옛 빌드로 계속 돈다.**
// 2026-11-01 ~ 11-06 사이에 실제로 그랬다 — fly-deploy가 7회 연속
// `마이그레이션이 끝나기를 기다린다` 단계에서 실패했고, Worker는 11-01
// 빌드(4f6ee8c6)에 멈춘 채 main보다 89커밋 뒤처져 있었다.
//
// 사람이 기억해야 하는 단계는 언젠가 잊힌다. `CLAUDE.md`의 첫 규칙이
// 그것이다 — **사용자가 해야 할 것이 생기면 먼저 그것을 자동화한다.**
//
// 이 검사가 지키는 것
// ───────────────────
// 그 배선이 **다시 끊기지 않는 것**. 조건을 YAML 안에만 두면 값으로
// 확인할 방법이 없어서 이 저장소의 배포 자동화가 두 번 조용히 죽었다
// (8/9 · 8/13). 판정은 `src/lib/ci/deployDispatch.ts` 한 곳에 두고,
// 워크플로는 그것을 부르기만 한다.
//
// **이 파일의 첫 판이 아무것도 막지 못했다 — 그 기록을 남긴다.**
// 처음에는 워크플로를 문자열로 읽고 `run:` 줄 주변 1200자를 잘라
// `steps.approval.outputs.approve`를 찾았다. 그런데 그 문자열은 같은
// 단계의 `env:` 줄에도 있다. 그래서 `if:`에서 승인 조건을 통째로 지워도
// 통과했다. 스크립트 쪽도 `approvedMigrationDeployPlan` 호출을 상수로
// 바꿔치기했는데 통과했다 — 설명 **주석**에 그 이름이 적혀 있었기
// 때문이다. 이 저장소가 `check-ui-shell-contract`에서 두 번 겪은 것과
// 같은 고장이다.
//
// 그래서 지금 판은 ① 워크플로를 **파싱해서** 그 단계의 `if:` 식 자체를
// 보고, ② 스크립트는 `stripJsComments`로 주석을 지운 뒤 본다.
// **검사기가 통과시키는 변이를 먼저 만들어 보고 나서 초록을 믿는다.**

import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { stripJsComments } from './lib/strip-comments.mjs';

const errs = [];
const err = (m) => { errs.push(m); console.log(`❌ ${m}`); console.log(`::error::${m}`); };
const ok = (m) => console.log(`✅ ${m}`);

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

const WF = '.github/workflows/migrate.yml';
const SCRIPT = 'scripts/dispatch-deploy-after-migrate.mjs';
const JUDGE = 'src/lib/ci/deployDispatch.ts';

const wfRaw = read(WF);
const scRaw = read(SCRIPT);
const jdRaw = read(JUDGE);

// **주석은 계약이 아니다.** 설명에 적힌 이름을 배선으로 읽으면 검사기가
// 조용히 아무것도 막지 않는다 (scripts/lib/strip-comments.mjs 참고).
const sc = scRaw == null ? null : stripJsComments(scRaw);
const jd = jdRaw == null ? null : stripJsComments(jdRaw);

if (!wfRaw) err(`${WF}을 읽지 못했습니다`);
if (!jd) err(`${JUDGE}을 읽지 못했습니다`);

// ── ① 판정은 한 곳에 있고, 승인 적용용 계획 함수가 있다 ──
if (jd) {
  if (!/export function approvedMigrationDeployPlan\b/.test(jd)) {
    err(`${JUDGE}에 approvedMigrationDeployPlan이 없습니다 — 승인 적용 뒤 `
      + '배포를 부를지 판정하는 곳이 없으면 그 조건이 YAML 안에만 남습니다');
  } else ok('승인 적용 뒤 배포 판정이 deployDispatch.ts 한 곳에 있습니다');
}

// ── ② 그 판정을 부르는 스크립트가 있고, 주소를 손으로 적지 않는다 ──
if (!sc) {
  err(`${SCRIPT}이 없습니다 — migrate가 배포를 부를 수단이 없습니다`);
} else {
  // **부르는 것**을 본다. 이름이 어딘가 적혀 있는 것으로는 부족하다.
  if (!/\bapprovedMigrationDeployPlan\s*\(/.test(sc)) {
    err(`${SCRIPT}이 approvedMigrationDeployPlan을 호출하지 않습니다 — `
      + '판정을 스크립트가 다시 쓰면 두 곳이 갈립니다');
  } else ok('제출 스크립트가 정본 판정을 호출합니다');

  if (!/\bdeployDispatchRequest\s*\(/.test(sc)) {
    err(`${SCRIPT}이 deployDispatchRequest를 호출하지 않습니다 — 디스패치 주소를 `
      + '손으로 적으면 워크플로 파일명이 바뀌는 날 한쪽만 고쳐집니다');
  } else ok('디스패치 주소를 정본 함수에서 만듭니다');

  // 판정 결과를 무시하고 무조건 보내면 위 두 검사를 통과하고도 배선은 틀린다.
  if (!/if\s*\(\s*!\s*plan\.dispatch\s*\)/.test(sc)) {
    err(`${SCRIPT}이 plan.dispatch를 보고 멈추지 않습니다 — `
      + '판정을 불러 놓고 결과를 무시하면 판정이 없는 것과 같습니다');
  } else ok('판정이 false면 디스패치를 보내지 않습니다');

  // 배포 대상 ref를 손으로 적지 않는다 — PR 브랜치가 운영에 올라가는 자리다
  if (/ref['"\s:]+['"](?!main)/.test(sc) && !/DEPLOY_REF/.test(sc)) {
    err(`${SCRIPT}이 배포 ref를 손으로 적습니다 — main 외의 ref가 운영 워커로 갑니다`);
  }
}

// ── ③ 워크플로가 그 스크립트를 부르고, **승인 적용이 성공했을 때만** 부른다 ──
//
// 문자열 잘라 보기를 하지 않는다. 그게 첫 판이 아무것도 막지 못한 이유다.
// 단계를 **파싱해서** 그 단계의 `if:` 식만 본다.
if (wfRaw) {
  let doc = null;
  try { doc = yaml.load(wfRaw); } catch (e) {
    err(`${WF}을 YAML로 읽지 못했습니다 — ${e?.message || e}`);
  }

  const jobs = doc && typeof doc === 'object' ? (doc.jobs ?? {}) : {};
  const steps = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const st of job?.steps ?? []) steps.push({ jobName, job, st });
  }

  const hits = steps.filter(({ st }) => String(st?.run ?? '').includes(SCRIPT));

  if (hits.length === 0) {
    err(`${WF}의 어떤 단계도 ${SCRIPT}을 실행하지 않습니다 — 승인해서 적용해도 `
      + '배포가 안 됩니다 (Worker는 옛 빌드로 계속 돕니다)');
  } else {
    ok(`migrate.yml이 배포 호출 단계를 가지고 있습니다 (${hits.length}개)`);
  }

  for (const { jobName, job, st } of hits) {
    const where = `${WF} · ${jobName} · ${st.name || '(이름 없음)'}`;
    const cond = String(st.if ?? '');

    // 조건 없이 부르면 평소 자동 적용(push)에서도 매번 배포를 부른다.
    // push는 이미 fly-deploy를 깨우므로 중복이고, 무엇보다 **승인 적용과
    // 평소 적용을 구별하지 못한다.**
    if (!cond) {
      err(`${where}에 if 조건이 없습니다 — 평소 push 적용에서도 매번 배포를 `
        + '부르고, 승인 적용과 구별하지 못합니다');
      continue;
    }

    if (!/steps\.approval\.outputs\.approve\s*!=\s*''/.test(cond)) {
      err(`${where}의 if가 승인 여부를 보지 않습니다 — `
        + "`steps.approval.outputs.approve != ''`로 좁혀야 합니다 (현재: ${cond})"
          .replace('${cond}', cond));
    } else ok('배포 호출이 승인 적용에서만 돕니다 (if 식으로 확인)');

    if (!/steps\.apply\.outcome\s*==\s*'success'/.test(cond)) {
      err(`${where}의 if가 적용 성공을 보지 않습니다 — `
        + '적용이 실패했는데 배포하면 새 코드가 없는 칸을 읽습니다 '
        + `(현재: ${cond})`);
    } else ok('배포 호출이 적용 성공에서만 돕니다 (if 식으로 확인)');

    // `always()`가 섞이면 위 두 조건이 있어도 실패한 적용에서 돈다.
    if (/\balways\s*\(\s*\)/.test(cond)) {
      err(`${where}의 if에 always()가 섞여 있습니다 — 적용이 실패해도 배포가 나갑니다`);
    }

    // 스크립트는 값으로 한 번 더 확인한다. 그 값을 넘겨주지 않으면
    // 판정이 언제나 "승인 없음"이 되어 조용히 아무것도 안 한다.
    const env = { ...(job?.env ?? {}), ...(st?.env ?? {}) };
    for (const k of ['APPROVED_MIGRATION', 'APPLY_OUTCOME', 'GITHUB_TOKEN']) {
      if (!(k in env)) {
        err(`${where}에 ${k}를 넘기지 않습니다 — 스크립트가 값으로 확인할 수 없습니다`);
      }
    }
    if (['APPROVED_MIGRATION', 'APPLY_OUTCOME', 'GITHUB_TOKEN'].every((k) => k in env)) {
      ok('스크립트가 승인 파일명·적용 결과·토큰을 값으로 받습니다');
    }

    // `workflow_dispatch`로 다른 워크플로를 깨우려면 이 권한이 있어야 한다.
    const perms = job?.permissions ?? doc?.permissions ?? null;
    if (perms === 'write-all') {
      ok('actions 권한 있음 (write-all)');
    } else if (perms && typeof perms === 'object') {
      if (perms.actions !== 'write') {
        err(`${WF}에 actions: write가 없습니다 — fly-deploy를 깨우는 `
          + 'workflow_dispatch가 403으로 거부됩니다');
      } else ok('actions: write가 선언되어 있습니다');
    } else {
      err(`${WF}에 permissions 선언이 없습니다 — 저장소 기본값이 읽기면 `
        + 'fly-deploy 디스패치가 403으로 거부됩니다. actions: write를 명시하세요');
    }
  }
}

console.log('');
if (errs.length) {
  console.log(`승인 적용 → 배포 배선이 끊겨 있습니다 (${errs.length}곳).`);
  console.log('사람이 기억해야 하는 단계는 언젠가 잊힙니다 — 그걸 없애는 것이 이 검사의 목적입니다.');
  process.exit(1);
}
console.log('✅ 승인 적용 → 배포 배선 정상 — 판정은 한 곳 · if 식 · 넘기는 값 · actions 권한 모두 확인');
