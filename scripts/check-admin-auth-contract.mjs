#!/usr/bin/env node
// scripts/check-admin-auth-contract.mjs
//
// **같은 비밀에 이름을 둘 붙이지 못하게 한다.**
//
// 무슨 일이 있었나
// ────────────────
// `x-admin-secret`을 보내는 워크플로들이 `EXIT_MONITOR_SECRET`이라는 GitHub secret
// 이름을 썼다. 서버는 `ADMIN_SECRET`과 비교하고, `sync-secrets`도
// `ADMIN_SECRET`을 Vercel·Fly로 밀어 넣는다. 즉 **동기화되는 이름과
// 호출자가 보는 이름이 달랐다.**
//
// 그래서 `sync-secrets`가 매번 성공해도 호출자는 계속 401이었다.
// exit-monitor가 2026-08-03부터 30번, autotrade-tick이 2026-08-26부터
// 30번 넘게. 그동안 예약 자동매매는 한 번도 돌지 않았고, 로그에는
// "Vercel에 넣고 재배포하세요"라는 사람 할 일 목록만 쌓였다.
//
// 값을 맞추는 것으로는 안 끝난다 — **이름이 둘일 수 있다는 구조가
// 원인이다.** 그래서 여기서 세 곳을 함께 본다:
//
//   호출자(workflow)  ─ 어떤 GitHub secret을 x-admin-secret으로 보내는가
//   서버(route)       ─ 그 헤더를 어떤 환경변수와 비교하는가
//   동기화(sync)      ─ 어떤 이름을 기준값으로 밀어 넣는가
//
// 셋이 갈리면 실패한다. 이름 문자열 하나만 보면, 셋 중 하나만 바뀌었을 때
// 놓친다.
//
// **비밀 값은 읽지도 출력하지도 않는다.** 이 검사가 보는 것은 이름뿐이다.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/**
 * **주석을 걷어낸다. 안 걷어내면 검사기가 제 설명을 사용처로 읽는다.**
 *
 * 이 파일을 처음 돌렸을 때 실패한 이유가 그거였다 — autotrade-tick의
 * "예전에는 `EXIT_MONITOR_SECRET`을 썼다"는 **역사를 적은 주석**을
 * 보고 지금도 쓰고 있다고 판정했다. 이 저장소는 같은 고장을 이미 겪었다
 * (#211에서 검사기가 주석을 코드로 읽고 59줄을 통째로 삼켰다).
 *
 * 줄 맨 앞의 `#`만 지운다. YAML 주석도 `run:` 블록 안의 셸 주석도 그 형태다.
 * 값 뒤에 붙는 `# ...`까지 지우려 들면 따옴표 안의 `#`을 잘라 먹는다.
 */
const stripComments = (src) =>
  src.split('\n').map(l => (/^\s*#/.test(l) ? '' : l)).join('\n');

/** 정본 이름. 이것 말고 다른 별칭을 x-admin-secret에 쓰지 않는다 */
const CANON = 'ADMIN_SECRET';

/** 같은 비밀에 붙었던 옛 이름들. 다시 나타나면 실패한다 */
const ALIASES = ['EXIT_MONITOR_SECRET', 'WATCH_TICK_SECRET', 'AUTOTRADE_SECRET'];

/**
 * `x-admin-secret`으로 부르는 호출자와 그 대상.
 *
 * **여기에 적힌 것만 검사하지 않는다** — 워크플로 전체를 훑어 새로 생긴
 * 호출자도 잡는다. 이 표는 "이 셋은 반드시 있어야 한다"는 뜻이다.
 * 워크플로가 사라지면 그것도 실패다 — 죽은 채로 잊히지 않게.
 */
const REQUIRED_CALLERS = [
  { file: '.github/workflows/autotrade-tick.yml', route: 'src/app/api/autotrade/daily-ladder/route.ts' },
  { file: '.github/workflows/watch-tick.yml', route: 'src/app/api/watch/tick/route.ts' },
  { file: '.github/workflows/exit-monitor.yml', route: 'src/app/api/autotrade/exit-monitor/route.ts' },
];

/**
 * **건드리면 안 되는 별도 계약.**
 *
 * `scheduled-exit`은 `Authorization: Bearer CRON_SECRET`이다. 전체 치환을
 * 하다가 이것까지 바꾸면 다른 것이 죽는다. 그래서 여기에 못 박는다.
 */
const SEPARATE_CONTRACTS = [
  { file: '.github/workflows/scheduled-exit.yml', secret: 'CRON_SECRET', header: 'Authorization' },
  { file: '.github/workflows/news-pipeline.yml', secret: 'NEWS_CRON_SECRET', header: 'Authorization' },
];

// ── ① x-admin-secret을 보내는 워크플로를 전부 찾는다 ──
//
// 표에 적힌 것만 보면, 내일 누가 네 번째 호출자를 옛 별칭으로 만들어도
// 통과한다. **찾는 것까지가 기계의 몫이다.**
const WF_DIR = '.github/workflows';
let files = [];
try {
  files = readdirSync(WF_DIR).filter(f => /\.ya?ml$/.test(f)).map(f => join(WF_DIR, f));
} catch { /* 아래에서 0개로 잡힌다 */ }
if (!files.length) err(`${WF_DIR}에서 워크플로를 하나도 못 읽었습니다 — 검사기가 고장 난 것입니다`);

const adminCallers = [];
for (const f of files) {
  const src = stripComments(read(f) ?? '');
  if (!/x-admin-secret\s*:/i.test(src)) continue;
  adminCallers.push(f);

  // 이 파일이 `env:`로 넘기는 secrets 이름들
  const used = [...src.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]);

  for (const alias of ALIASES) {
    if (used.includes(alias)) {
      err(`${f}: x-admin-secret 호출자가 \`secrets.${alias}\`를 씁니다 — `
        + `정본은 \`secrets.${CANON}\` 하나입니다. 같은 비밀에 이름이 둘이면 언젠가 갈립니다`);
    }
  }
  if (!used.includes(CANON)) {
    err(`${f}: x-admin-secret을 보내면서 \`secrets.${CANON}\`을 쓰지 않습니다`);
  }
}

// ── ② 반드시 있어야 하는 호출자가 사라지지 않았는가 ──
for (const c of REQUIRED_CALLERS) {
  if (!read(c.file)) {
    err(`${c.file}이 없습니다 — 이 호출자가 사라지면 그 예약은 아무도 돌리지 않습니다`);
    continue;
  }
  if (!adminCallers.includes(c.file)) {
    err(`${c.file}: x-admin-secret 호출이 사라졌습니다 — 인증 방식을 바꿨다면 이 검사도 같이 고치세요`);
  }
}

// ── ③ 서버가 그 헤더를 무엇과 비교하는가 ──
//
// 호출자만 맞춰 놓고 서버가 다른 것을 보면 여전히 401이다.
for (const c of REQUIRED_CALLERS) {
  const src = read(c.route);
  if (!src) { err(`${c.route}이 없습니다`); continue; }
  if (!/x-admin-secret/i.test(src)) {
    err(`${c.route}: x-admin-secret을 읽지 않습니다 — 호출자(${c.file})는 그것을 보냅니다`);
  }
  if (!new RegExp(`process\\.env\\.${CANON}`).test(src)) {
    err(`${c.route}: \`process.env.${CANON}\`을 보지 않습니다 — x-admin-secret의 정본은 그것입니다`);
  }
}

// ── ④ 동기화가 그 이름을 기준값으로 받는가 ──
{
  const wf = stripComments(read('.github/workflows/sync-secrets.yml') ?? '') || null;
  if (!wf) err('.github/workflows/sync-secrets.yml이 없습니다');
  else if (!new RegExp(`${CANON}:\\s*\\$\\{\\{\\s*secrets\\.${CANON}\\s*\\}\\}`).test(wf)) {
    err(`sync-secrets.yml: 기준값이 \`secrets.${CANON}\`이 아닙니다 — `
      + `호출자가 보내는 이름과 밀어 넣는 이름이 갈립니다`);
  }

  const sync = read('src/lib/ops/secretSync.ts');
  if (!sync) err('src/lib/ops/secretSync.ts가 없습니다');
  else {
    const m = sync.match(/export const SYNCED_NAMES\s*=\s*\[([\s\S]*?)\]/);
    if (!m) err('secretSync.ts에서 SYNCED_NAMES를 찾지 못했습니다');
    else if (!new RegExp(`'${CANON}'`).test(m[1])) {
      err(`secretSync.ts: SYNCED_NAMES에 ${CANON}이 없습니다 — `
        + `동기화되지 않는 값을 호출자가 보내면 배포가 밀리는 순간 401입니다`);
    }
  }

  const mjs = read('scripts/sync-secrets.mjs');
  if (mjs && !new RegExp(`'${CANON}'`).test(mjs)) {
    err(`scripts/sync-secrets.mjs: 밀어 넣는 이름 목록에 ${CANON}이 없습니다`);
  }
}

// ── ⑤ 별도 계약을 건드리지 않았는가 ──
//
// **전체 치환의 사고를 여기서 막는다.** Bearer 계약을 x-admin-secret
// 정본으로 바꿔 놓으면, 고쳤다고 생각한 순간 다른 것이 죽는다.
for (const s of SEPARATE_CONTRACTS) {
  const raw = read(s.file);
  if (!raw) { err(`${s.file}이 없습니다`); continue; }
  const src = stripComments(raw);
  if (!src.includes(`secrets.${s.secret}`)) {
    err(`${s.file}: \`secrets.${s.secret}\`이 사라졌습니다 — `
      + `이것은 ${s.header} 별도 계약이라 ${CANON}으로 바꾸면 안 됩니다`);
  }
}

// ── ⑥ 사람 할 일 목록이 다시 들어오지 않았는가 ──
//
// 최상위 규칙: 보고에는 "사용자가 해야 할 것"이 아니라 "시스템이 자동으로
// 한 것 / 자동 복구하지 못한 이유"만 남는다. 401 안내도 마찬가지다 —
// 이름이 하나가 된 뒤의 401은 사람이 손으로 맞출 일이 아니다.
const HUMAN_TODO = [
  { re: /Redeploy 했는지|재배포 했는지|넣고 재배포/, what: '재배포하라는 안내' },
  { re: /앞뒤 공백[·, ]*줄바꿈이 딸려/, what: '공백을 확인하라는 안내' },
  { re: /글자 하나까지 같아야 합니다/, what: '두 값을 사람이 맞추라는 안내' },
];
for (const f of files) {
  // 주석에 남긴 역사는 사람 할 일 목록이 아니다. 실행되는 줄만 본다.
  const src = stripComments(read(f) ?? '');
  for (const h of HUMAN_TODO) {
    if (h.re.test(src)) {
      err(`${f}: ${h.what}가 남아 있습니다 — 사람이 맞춰야 하는 구조 자체를 없앴습니다`);
    }
  }
}

// ── ⑦ 비밀 값을 찍지 않는가 ──
//
// 지문(sha256 앞 몇 자)은 허용한다. 값 자체를 echo하는 것만 막는다.
for (const f of files) {
  const src = stripComments(read(f) ?? '');
  for (const line of src.split('\n')) {
    if (!/^\s*echo\b/.test(line)) continue;
    if (/sha256sum|cut -c/.test(line)) continue;          // 지문은 허용
    if (/\$\{?SECRET\}?|\$\{\{\s*secrets\./.test(line)) {
      err(`${f}: 비밀 값을 그대로 출력하는 줄이 있습니다 — 지문만 남기세요\n    ${line.trim().slice(0, 80)}`);
    }
  }
}

if (bad === 0) {
  console.log(`✅ 관리자 인증 계약 일관 — x-admin-secret 호출자 ${adminCallers.length}개가 `
    + `전부 \`secrets.${CANON}\` 하나를 씁니다 (별도 계약 ${SEPARATE_CONTRACTS.length}개는 그대로)`);
} else {
  console.error('');
  console.error('   같은 비밀에 이름이 둘이면, 동기화가 매번 성공해도 호출자는 계속 401입니다.');
  console.error('   그 401은 조용합니다 — 예약은 안 돌고, 로그에는 사람 할 일 목록만 쌓입니다.');
}
process.exit(bad ? 1 : 0);
