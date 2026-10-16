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
import { stripJsComments } from './lib/strip-comments.mjs';
import { functionBody } from './lib/function-body.mjs';

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

// ── ⑧ 주문을 **만드는** 관리자 경로는 관문이 하나 더 있어야 한다 ──
//
// `/advance` · `/settle` · `/cancel`은 **이미 열린** 묶음을 이어 가거나
// 닫는다. 대상을 비워 두면 "도는 것 전부"가 되고 그게 맞다.
//
// **시작은 다르다.** 대상을 비우면 없던 주문이 생긴다. 그래서 무인
// 시작은 사용자·연결·확인 문구 셋을 요구하고, 그 판정은
// `headlessStartVerdict` 한 곳에 있다.
//
// 여기서 보는 것은 **그 판정을 불렀는가가 아니라 그 결과를 따랐는가**다.
// 부르기만 하고 결과를 버리는 모양으로 새 나간 적이 있다(TD-18).
{
  const ROUTE = 'src/app/api/autotrade/smoke-test/route.ts';
  const CANON_MODULE = 'src/lib/smoke/smokeRun.ts';
  const raw = read(ROUTE);
  if (!raw) err(`${ROUTE}이 없습니다 — 스모크 시작 경로가 사라졌습니다`);
  else {
    const whole = stripJsComments(raw);
    // **POST 본문만 본다.** 파일 전체에서 찾으면 `import`에 남은
    // 이름과 GET의 로그인 확인이 POST의 것을 대신 증명해 버린다 —
    // 음성 시험에서 실제로 그렇게 새 나갔다.
    const fb = functionBody(raw, 'POST');
    const src = fb.ok ? stripJsComments(fb.body) : '';
    if (!fb.ok) err(`${ROUTE}: POST 본문을 읽지 못했습니다 — ${fb.reason}`);
    void whole;

    if (!/x-admin-secret/.test(src) || !new RegExp(`process\\.env\\.${CANON}`).test(src)) {
      err(`${ROUTE}: 무인 시작이 \`x-admin-secret\`·\`process.env.${CANON}\`을 보지 않습니다 — `
        + `시작만 사람의 JWT를 요구하면 신호 없는 날에는 실주문 경로가 한 번도 돌지 않습니다`);
    }

    const vIdx = src.indexOf('headlessStartVerdict(');
    // 판정을 받은 **그 변수 이름**을 집는다. 이름을 모른 채
    // "`!무엇.ok`로 분기하는 줄이 있는가"만 보면 바로 아래
    // `smokeRequestVerdict`의 거절 분기가 대신 증명해 준다 —
    // 음성 시험에서 그렇게 통과했다.
    const vm = src.match(/(?:const|let|var)\s+(\w+)\s*=\s*headlessStartVerdict\(/);
    if (vIdx < 0) {
      err(`${ROUTE}: \`headlessStartVerdict\`를 부르지 않습니다 — `
        + `무인 시작 판정을 라우트에 직접 적으면 시험이 붙지 않습니다`);
    } else if (!vm) {
      err(`${ROUTE}: 무인 시작 판정의 결과를 변수에 받지 않습니다 — `
        + `받지 않으면 결과를 따를 수도 없습니다`);
    } else {
      // 판정 결과로 **분기하고 그 안에서 반환**해야 한다.
      //
      // "판정 뒤 어딘가에 `return NextResponse.json(`이 있는가"로 보면
      // 바로 아래에 있는 `supabase_not_configured` 503이 대신 증명해
      // 준다 — 음성 시험에서 그렇게 통과했다. 그래서 **거절 분기의
      // 모양 자체**를 본다.
      const v = vm[1];
      const rejectBranch = new RegExp(
        `if\\s*\\(\\s*!\\s*${v}\\.ok[^)]*\\)\\s*\\{[^}]*return\\s+NextResponse\\.json\\(`);
      if (!rejectBranch.test(src)) {
        err(`${ROUTE}: 무인 시작 판정 결과로 분기해 거절하지 않습니다 — `
          + `부르기만 하고 결과를 버리면 아무것도 막지 않습니다`);
      }

      // 그리고 그 반환이 **주문을 만드는 것들보다 먼저** 와야 한다.
      for (const sink of ['startAttempt(', ".from('smoke_runs').insert(", '.insert(']) {
        const sIdx = src.indexOf(sink);
        if (sIdx >= 0 && sIdx < vIdx) {
          err(`${ROUTE}: \`${sink}\`이 무인 시작 판정보다 먼저 옵니다 — `
            + `판정이 막기로 한 요청이 이미 장부와 거래소를 건드립니다`);
        }
      }
    }

    // ── 무인 **조회**는 대상을 비울 수 없다 ──
    //
    // 쓰기와 달리 조회는 열어 줄 만하지만, 대상을 비우면 전체
    // 사용자의 장부가 한 번에 나간다. 그래서 `userId`가 없으면
    // 400으로 돌려보내는 분기가 있어야 한다.
    const gb = functionBody(raw, 'GET');
    if (!gb.ok) err(`${ROUTE}: GET 본문을 읽지 못했습니다 — ${gb.reason}`);
    else {
      const g = stripJsComments(gb.body);
      if (/x-admin-secret/.test(g)) {
        if (!/searchParams\.get\('userId'\)/.test(g)) {
          err(`${ROUTE} GET: 무인 조회가 대상 사용자를 받지 않습니다 — `
            + `비우면 전체 사용자의 장부가 됩니다`);
        }
        if (!/user_required/.test(g)) {
          err(`${ROUTE} GET: 대상 사용자가 없을 때의 거절(user_required)이 없습니다`);
        }
        if (!/\.eq\('user_id', userId\)/.test(g)) {
          err(`${ROUTE} GET: 조회를 대상 사용자로 좁히지 않습니다`);
        }
      }
    }

    // 무인 경로가 대상 사용자를 본문에서 가져가는 자리이므로, 사람
    // 경로의 JWT 확인이 사라지면 안 된다.
    if (!/resolveUserId\(/.test(src)) {
      err(`${ROUTE}: \`resolveUserId\`가 사라졌습니다 — 사람 경로의 로그인 확인입니다`);
    }
    if (!/auth_required/.test(src)) {
      err(`${ROUTE}: 사람 경로의 401(auth_required)이 사라졌습니다`);
    }
  }

  // 판정 정본이 **확인 문구를 실제로 비교하는가.** 상수만 선언해 두고
  // 비교하지 않으면 문구는 장식이 된다.
  const canon = read(CANON_MODULE);
  if (!canon) err(`${CANON_MODULE}이 없습니다`);
  else {
    const c = stripJsComments(canon);
    if (!/HEADLESS_START_CONFIRM\s*=\s*'[^']+'/.test(c)) {
      err(`${CANON_MODULE}: HEADLESS_START_CONFIRM 상수가 없습니다`);
    }
    if (!/!==\s*HEADLESS_START_CONFIRM|HEADLESS_START_CONFIRM\s*!==/.test(c)) {
      err(`${CANON_MODULE}: 확인 문구를 비교하는 줄이 없습니다 — `
        + `선언만 있고 비교가 없으면 스케줄러가 긁어도 주문이 나갑니다`);
    }
    // TESTNET 판정을 이 정본이 대신 말하면 두 곳이 갈린다. 거래소
    // 연결을 실제로 읽는 `startAttempt`가 정한다.
    if (/is_testnet/.test(c)) {
      err(`${CANON_MODULE}: 무인 시작 판정이 \`is_testnet\`을 직접 봅니다 — `
        + `그 판단은 거래소 연결을 읽는 startAttempt 한 곳에 있어야 합니다`);
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
