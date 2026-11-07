#!/usr/bin/env node
// scripts/check-cron-auth-contract.mjs
//
// **`news-pipeline`이 첫 실행부터 성공 0회인 이유를 값으로 적는다 (#582).**
//
// 두 가지를 본다
// ──────────────
// ① `/api/cron/*`가 비밀 **미설정 시 열리는가**
// ② 워크플로가 보내는 비밀 이름이 **동기화되는가**
//
// ②가 #582의 직접 원인이다:
//
//   워크플로가 보내는 것 : `secrets.NEWS_CRON_SECRET`
//   서버가 비교하는 것   : `process.env.CRON_SECRET`
//   sync-secrets가 관리  : `scripts/sync-secrets.mjs`의 NAMES 네 개
//                          → **둘 다 거기 없다**
//
// 사람이 서로 다른 두 곳에 서로 다른 이름으로 같은 값을 손으로 넣어야
// 하고, 한 번도 맞은 적이 없다. `autotrade-tick`이 `EXIT_MONITOR_SECRET`
// 으로 30회 넘게 연속 401이던 것과 **같은 고장**이다. 그쪽은 정본 이름
// 하나(`ADMIN_SECRET`)로 모아 고쳤고, `Authorization: Bearer` 쪽은
// 안 했다.
//
// ①은 더 조용한 쪽이다. 다섯 라우트가 모두
//
//   const secret = process.env.CRON_SECRET || '';
//   if (secret) { ...401... }
//
// 이므로 **비어 있으면 검사 자체를 건너뛴다.** 관리되지 않는 비밀이라
// "비어 있음"은 현실적인 상태다. 지금 401이 난다는 것은 운영에는 값이
// 들어 있다는 뜻이므로 **잠재적** 노출이고 현재 노출은 아니다.
//
// 종료 코드
// ─────────
// 기본은 **선언이 현실과 맞는지만** 본다. 지금의 두 구멍은 아래
// `DECLARED_DEBT`에 적혀 있으므로 통과한다 — 고치는 것은 인증 동작
// 변경이라 승인 사항이다. 새 구멍이 생기거나 선언이 어긋나면 RED다.
//
//   node scripts/check-cron-auth-contract.mjs                 표 + 드리프트
//   node scripts/check-cron-auth-contract.mjs --assert-hardened  남은 구멍이 있으면 exit 1
//
// 판정은 `src/lib/ops/cronAuthContract.ts` 한 곳에 있고, 주석 제거는
// `scripts/lib/strip-comments.mjs` 한 곳에 있다. 어느 쪽도 복제하지 않는다.

import { readFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripJsComments } from './lib/strip-comments.mjs';

const JUDGE = 'src/lib/ops/cronAuthContract.ts';
const SYNC = 'scripts/sync-secrets.mjs';
const CRON_DIR = 'src/app/api/cron';
const WF_DIR = '.github/workflows';

const errs = [];
const err = (m) => { errs.push(m); console.log(`❌ ${m}`); console.log(`::error::${m}`); };
const ok = (m) => console.log(`✅ ${m}`);
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

// ── 선언된 부채 ──
//
// **고치지 않은 것을 숨기지 않는다.** 각 항목에 "그래서 무슨 일이
// 일어나는가"를 적는다. 승인이 나면 이 표에서 지운다.
const DECLARED_DEBT = {
  failOpenEnv: {
    env: 'CRON_SECRET',
    why: '다섯 cron 라우트가 모두 `if (secret)` 안에서만 거절한다 — '
      + '비어 있으면 누구나 부를 수 있다. cleanup은 행을 지우고(보존일수·'
      + '1회 상한 가드는 있다) ai-*는 유료 API를 호출한다. fail-closed로 '
      + '바꾸는 것은 인증 동작 변경이라 승인 사항이다',
  },
  handSetSecrets: {
    names: ['CRON_SECRET', 'NEWS_CRON_SECRET'],
    why: 'sync-secrets가 관리하지 않는다 — 사람이 두 곳에 다른 이름으로 '
      + '같은 값을 손으로 넣어야 한다. #582가 그래서 성공 0회다. '
      + '정본 이름 하나로 모으는 것은 워크플로/인증 변경이라 승인 사항이다',
  },
};

function loadJudge() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-cronauth-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, JUDGE, '--outDir', dir, '--module', 'commonjs',
    '--target', 'es2019', '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

/** 워크플로가 보내는 인증 비밀 — `env:`의 secrets 이름과 헤더를 짝짓는다 */
function workflowAuthSecrets() {
  if (!existsSync(WF_DIR)) return [];
  const out = [];
  for (const name of readdirSync(WF_DIR)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const raw = readFileSync(join(WF_DIR, name), 'utf8');
    // YAML 주석(#)을 지운다 — 설명에 적힌 이름을 배선으로 읽지 않는다
    const src = raw.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
    const sendsBearer = /Authorization:\s*Bearer/i.test(src);
    const sendsAdmin = /x-admin-secret\s*:/i.test(src);
    if (!sendsBearer && !sendsAdmin) continue;
    const names = [...new Set([...src.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))]
      // URL은 인증 비밀이 아니다
      .filter((n) => !/_URL$/.test(n));
    for (const secret of names) {
      out.push({ file: `${WF_DIR}/${name}`, secret,
        header: sendsBearer ? 'Authorization' : 'x-admin-secret' });
    }
  }
  return out;
}

async function main() {
  const assertHardened = process.argv.includes('--assert-hardened');

  const judgeSrc = read(JUDGE);
  const syncSrc = read(SYNC);
  if (!judgeSrc) err(`${JUDGE}을 읽지 못했습니다 — 판정 정본이 없습니다`);
  if (!syncSrc) err(`${SYNC}을 읽지 못했습니다 — 관리 목록을 알 수 없습니다`);
  if (!existsSync(CRON_DIR)) err(`${CRON_DIR}을 읽지 못했습니다`);
  if (errs.length) return finish();

  const outDir = loadJudge();
  const { classifyRouteAuth, classifySecretName, managedNamesFrom, routeIsHardened } =
    await import(`file://${join(outDir, 'cronAuthContract.js')}`);

  // **관리 목록은 sync-secrets에서 읽는다.** 베껴 쓰면 두 곳이 갈린다.
  const managed = managedNamesFrom(stripJsComments(syncSrc));
  if (managed == null) {
    err(`${SYNC}에서 NAMES를 읽지 못했습니다 — 관리 목록 UNKNOWN을 `
      + '"아무것도 관리되지 않음"으로 적지 않습니다');
    return finish();
  }
  ok(`sync-secrets 관리 이름 ${managed.length}개: ${managed.join(' · ')}`);

  // ── ① 라우트의 미설정 시 동작 ──
  const routes = readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, path: join(CRON_DIR, d.name, 'route.ts') }))
    .filter((r) => existsSync(r.path));

  if (!routes.length) err(`${CRON_DIR}에서 라우트를 찾지 못했습니다 — 검사기가 고장 난 것입니다`);

  console.log('');
  console.log('| cron 라우트 | 비밀 | 미설정 시 | 안전 |');
  console.log('|---|---|---|---|');
  const notHardened = [];
  for (const r of routes) {
    // **정본 제거기로 주석을 지워서 넘긴다.** 판정 모듈은 지우지 않는다.
    const a = classifyRouteAuth(stripJsComments(readFileSync(r.path, 'utf8')));
    const safe = routeIsHardened(a);
    if (!safe) notHardened.push({ ...r, a });
    console.log(`| \`${r.name}\` | ${a.envName ?? 'UNKNOWN'} | ${a.mode} | ${safe ? '✅' : '⚠'} |`);
  }

  // 선언과 현실이 맞는지
  const declaredEnv = DECLARED_DEBT.failOpenEnv.env;
  const unexpected = notHardened.filter((r) => r.a.envName !== declaredEnv);
  if (unexpected.length) {
    for (const u of unexpected) {
      err(`${u.path}: 선언되지 않은 인증 구멍입니다 (${u.a.mode}, ${u.a.envName ?? 'UNKNOWN'}) — `
        + `${u.a.reason}. DECLARED_DEBT에 적거나 fail-closed로 고치세요`);
    }
  } else if (notHardened.length) {
    ok(`미설정 시 열리는 라우트 ${notHardened.length}개 — 전부 ${declaredEnv}로 선언돼 있습니다`);
  } else {
    ok('모든 cron 라우트가 fail-closed입니다');
  }

  // ── ② 워크플로가 보내는 비밀 이름 ──
  const sending = workflowAuthSecrets();
  const handSet = [];
  console.log('');
  console.log('| 워크플로 | 헤더 | 비밀 | 동기화 |');
  console.log('|---|---|---|---|');
  for (const s of sending) {
    const m = classifySecretName(s.secret, managed);
    if (m === 'HAND_SET') handSet.push(s);
    console.log(`| \`${s.file.replace(WF_DIR + '/', '')}\` | ${s.header} | ${s.secret} | `
      + `${m === 'MANAGED' ? '✅ MANAGED' : '⚠ HAND_SET'} |`);
  }

  const declaredNames = DECLARED_DEBT.handSetSecrets.names;
  const undeclared = handSet.filter((s) => !declaredNames.includes(s.secret));
  if (undeclared.length) {
    for (const u of undeclared) {
      err(`${u.file}: \`secrets.${u.secret}\`은 sync-secrets가 관리하지 않습니다 — `
        + '사람이 손으로 맞춰야 하는 비밀은 언젠가 갈립니다('
        + 'autotrade-tick이 EXIT_MONITOR_SECRET으로 30회 연속 401이었습니다). '
        + `정본 이름(${managed.join('·')}) 중 하나를 쓰거나 DECLARED_DEBT에 적으세요`);
    }
  } else if (handSet.length) {
    ok(`손으로 맞추는 비밀 ${handSet.length}곳 — 전부 선언돼 있습니다`);
  } else {
    ok('모든 워크플로가 동기화되는 이름만 씁니다');
  }

  // ── 남은 구멍 ──
  console.log('');
  if (notHardened.length || handSet.length) {
    console.log(`⚠ 남은 인증 구멍: 미설정 시 열리는 라우트 ${notHardened.length}개 · `
      + `손으로 맞추는 비밀 ${handSet.length}곳`);
    console.log(`   · ${DECLARED_DEBT.failOpenEnv.why}`);
    console.log(`   · ${DECLARED_DEBT.handSetSecrets.why}`);
    if (assertHardened) {
      err(`인증이 아직 단단하지 않습니다 — 라우트 ${notHardened.length}개 · 비밀 ${handSet.length}곳`);
    }
  }
  finish();
}

function finish() {
  console.log('');
  if (errs.length) {
    console.log(`크론 인증 계약이 어긋났습니다 (${errs.length}곳).`);
    console.log('사람이 손으로 맞춰야 하는 비밀은 언젠가 갈립니다 — 그걸 없애는 것이 이 검사의 목적입니다.');
    process.exit(1);
  }
  console.log('✅ 선언이 현실과 일치합니다 — 남은 구멍은 위에 값으로 적혀 있습니다');
}

main().catch((e) => { err(`검사 중 오류 — ${e?.message || e}`); finish(); });
