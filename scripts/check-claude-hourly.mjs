#!/usr/bin/env node
// scripts/check-claude-hourly.mjs
//
// **사람이 보지 않는 회차의 울타리를 지킨다.**
//
// `claude-hourly`는 매시간 스스로 깨어나 코드를 바꾸고 PR을 연다.
// 그 작업에 무엇을 줄지는 워크플로 한 파일이 정하고, 거기서 한 줄만
// 바뀌어도 울타리가 사라진다 — 그런데 **사라진 것을 아무도 못 본다.**
// 사람이 보고 있지 않은 시간에 도는 작업이기 때문이다.
//
// 그래서 여섯 가지를 센다:
//
//   ① 다른 워크플로를 깨울 수 없는가       (`actions: read`)
//   ② 거래소·DB 시크릿을 안 받는가
//   ③ 겹쳐 돌지 않는가                      (`concurrency`)
//   ④ 끝나지 않는 회차를 끊는가             (`timeout-minutes`)
//   ⑤ 금지 문구가 프롬프트에 남아 있는가
//   ⑥ 체크아웃된 프로젝트 설정이 인증을 바꿔치지 않는가
//
// **금지를 프롬프트에만 적는 것으로는 부족하다.** ①②가 진짜 관문이고
// ⑤는 그 위에 한 겹 더 두는 것이다. 그래서 ①②가 깨지면 더 큰 소리로
// 실패한다.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { findOverrideKeys, selfTest, OAUTH_OVERRIDE_NAMES } from './lib/oauth-override-names.mjs';

// 갈래가 둘이다. **둘 다** 같은 울타리를 가져야 한다 — 한쪽만 검사하면
// 느슨한 쪽으로 작업이 흘러간다.
const LANES = [
  { wf: '.github/workflows/claude-hourly-dev.yml', mode: 'dev',
    enableVar: 'CLAUDE_HOURLY_ENABLED' },
  { wf: '.github/workflows/claude-hourly-trading.yml', mode: 'trading',
    enableVar: 'CLAUDE_TRADING_AUTODEV_ENABLED' },
];

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };

// ── ⓞ 이 검사기의 판단이 아직 살아 있는가 ──
//
// **음성 시험을 `scripts/test-*.mjs`에만 두면 CI에서 한 번도 돌지 않는다.**
// `ci.yml`의 `.mjs` 시험 단계는 파일 이름을 두 개 적어 부르고, `npm test`는
// TypeScript 하네스라 `.mjs`가 안 걸린다 — `ci.yml` 자신이 그 자리에
// "여기서 돌리지 않으면 PR에서 한 번도 안 돈다"고 적어 두었다.
//
// 그래서 목록에 파일 이름을 더하는 대신 **판단이 매 회차 자기를 증명한다.**
// 이 검사기는 CI의 `무인 회차 울타리` 단계에서 이미 돌기 때문에, 유지해야
// 할 목록이 없다. 판단이 깨졌으면 그 뒤의 초록은 아무 뜻이 없으므로
// **갈래 검사보다 먼저** 돌린다.
const SELF = selfTest();
for (const f of SELF.failed) {
  err(`판단 자기 점검 실패 — ${f}`);
}

for (const lane of LANES) {
const WF = lane.wf;
if (!existsSync(WF)) {
  err(`${WF}이 없습니다 — 무인 회차 워크플로가 사라졌습니다`);
  continue;
}
const raw = readFileSync(WF, 'utf8');

/** 줄 맨 앞 `#`만 지운다. 값 뒤의 `#`까지 지우면 따옴표 안을 잘라 먹는다 */
const stripComments = (src) =>
  src.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');
const src = stripComments(raw);

// ── ① 다른 워크플로를 깨울 수 없는가 ──
//
// `actions: write`를 주면 이 작업이 `smoke-test-testnet`(실주문) ·
// `ops-runner`(배포) · `migrate`(DB)를 **스스로 실행시킬 수 있다.**
// 프롬프트가 금지해도 권한이 있으면 그것은 약속일 뿐이다.
{
  const m = src.match(/permissions:\s*\n((?:\s{2,}[a-z-]+:\s*\S.*\n)+)/);
  if (!m) {
    err(`${WF}: permissions 블록을 찾지 못했습니다 — 기본 권한으로 도는 것은 더 넓습니다`);
  } else {
    const perms = m[1];
    const actions = perms.match(/actions:\s*(\S+)/);
    if (!actions) {
      err(`${WF}: \`actions:\` 권한을 명시하지 않았습니다 — 다른 워크플로를 깨울 수 있는지가 불분명합니다`);
    } else if (actions[1] !== 'read' && actions[1] !== 'none') {
      err(`${WF}: \`actions: ${actions[1]}\` 입니다 — write면 이 회차가 `
        + `smoke-test-testnet(실주문)·ops-runner(배포)·migrate(DB)를 스스로 실행시킬 수 있습니다`);
    }
    for (const forbidden of ['packages: write', 'deployments: write']) {
      if (perms.includes(forbidden)) {
        err(`${WF}: \`${forbidden}\`을 줍니다 — 무인 회차에 필요하지 않습니다`);
      }
    }
  }
}

// ── ② 거래소·운영 DB 시크릿을 안 받는가 ──
//
// 이 셋 중 하나라도 넘어가면 그 회차는 **배포된 앱이나 운영 DB에
// 닿을 수 있다.** 실주문·DB 변경 금지가 그 순간 약속으로 내려앉는다.
{
  const FORBIDDEN_SECRETS = [
    'ADMIN_SECRET', 'EXIT_MONITOR_URL', 'SUPABASE_DB_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'FLY_API_TOKEN', 'CRON_SECRET',
    'ENCRYPTION_KEY', 'VERCEL_TOKEN',
  ];
  for (const s of FORBIDDEN_SECRETS) {
    if (new RegExp(`secrets\\.${s}\\b`).test(src)) {
      err(`${WF}: \`secrets.${s}\`을 넘깁니다 — 무인 회차는 거래소·운영 DB에 닿으면 안 됩니다`);
    }
  }
  // 인증은 있어야 한다. **OAuth 토큰 하나뿐이다** — ②a가 나머지 경로를
  // 전부 거부하므로 "둘 중 하나"로 세면 두 판단이 서로 어긋난다.
  if (!/secrets\.CLAUDE_CODE_OAUTH_TOKEN\b/.test(src)) {
    err(`${WF}: Claude OAuth 시크릿을 쓰지 않습니다 — 돌 수 없는 워크플로입니다`);
  }
}

// ── ②a OAuth 전용: OAuth보다 먼저 선택되는 인증 경로가 없는가 ──
//
// 공식 인증 우선순위(code.claude.com/docs/en/authentication)는
//   ① 클라우드 공급자(Bedrock/Vertex) → ② ANTHROPIC_AUTH_TOKEN
//   → ③ ANTHROPIC_API_KEY → ④ apiKeyHelper → ⑤ CLAUDE_CODE_OAUTH_TOKEN
// 이다. 즉 **①~④ 중 하나라도 회차에 들어오면 ⑤는 쓰이지 않는다.**
//
// 처음 이 블록은 ③(API 키) **하나만** 셌다. 통합 트리에서 실측하니 나머지
// 다섯은 그대로 통과했다(`ANTHROPIC_AUTH_TOKEN` · `ANTHROPIC_BASE_URL` ·
// `CLAUDE_CODE_USE_BEDROCK` · `CLAUDE_CODE_USE_VERTEX` · `apiKeyHelper`
// → 전부 exit 0). 이름이 여섯인데 하나만 센 자리였다.
//
// 이름 목록은 `scripts/lib/oauth-override-names.mjs` **한 곳**에 있다.
// 설정 파일을 보는 관문 ⑮도 같은 목록을 쓴다 — 들어올 자리가 둘인데
// 목록이 둘이면 언젠가 한쪽만 늘어난다.
//
// 인증 확인 로그의 `인증: ...OAUTH_TOKEN`은 **시크릿이 비어 있지 않다는
// 것만** 뜻한다. 무엇으로 인증했는지의 증거가 아니다.
{
  // 한 이름이 들어오는 모양이 여럿이다 — `secrets.X` · `vars.X` ·
  // env/`with` 리터럴 · 소문자 액션 입력 · 셸 `X=` · settings JSON.
  // 모양을 하나씩 세면 세지 않은 모양으로 들어오므로 **이름이 본문에
  // 나오는지**를 센다. 설명이 필요하면 `#` 주석에 적는다.
  const lines = src.split('\n');
  for (const [name, why] of OAUTH_OVERRIDE_NAMES) {
    const needle = name.toLowerCase();
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(needle)) hits.push(i + 1);
    }
    if (hits.length) {
      err(`${WF}: OAuth 전용 회차에 \`${name}\` 이름이 나옵니다 (줄 ${hits.slice(0, 5).join(', ')})`
        + ` — ${why} · 설명이라면 \`#\` 주석으로 옮기세요`);
    }
  }
  // settings 입력은 **이 검사기가 읽지 않는 파일**로 인증 설정을 옮긴다.
  if (/^\s*settings\s*:/m.test(src) || /--settings\b/.test(src)) {
    err(`${WF}: Claude Action에 settings 입력을 줍니다 — 인증 설정이 `
      + '이 검사기가 읽지 않는 파일로 옮겨가 OAuth 전용인지 셀 수 없습니다');
  }
  if (!/claude_code_oauth_token:\s*\$\{\{\s*secrets\.CLAUDE_CODE_OAUTH_TOKEN\s*\}\}/.test(src)) {
    err(`${WF}: Claude Action의 OAuth 입력이 없습니다 — 시크릿 존재 로그만으로는 인증할 수 없습니다`);
  }
}
// ── ③ 겹쳐 돌지 않는가 ──
//
// 두 회차가 동시에 깨면 같은 문제를 각자 고치고 Draft PR을 둘 연다.
{
  if (!/^concurrency:/m.test(src)) {
    err(`${WF}: \`concurrency\`가 없습니다 — 앞 회차가 도는 중에 다음 회차가 겹칩니다`);
  } else if (!/group:\s*\S/.test(src)) {
    err(`${WF}: \`concurrency.group\`이 없습니다`);
  }
  // 돌던 회차를 죽이면 만들던 브랜치가 어중간하게 남는다.
  if (/cancel-in-progress:\s*true/.test(src)) {
    err(`${WF}: \`cancel-in-progress: true\` 입니다 — 돌던 회차를 끊으면 `
      + `브랜치가 반쯤 만들어진 채로 남습니다`);
  }
}

// ── ④ 끝나지 않는 회차를 끊는가 ──
{
  const t = src.match(/timeout-minutes:\s*(\d+)/);
  if (!t) {
    err(`${WF}: \`timeout-minutes\`가 없습니다 — 멈추지 않는 회차가 다음 회차를 영원히 막습니다`);
  } else if (Number(t[1]) > 120) {
    err(`${WF}: \`timeout-minutes: ${t[1]}\` 은 너무 깁니다(2시간 초과)`);
  }
}

// ── ⑤ 금지 문구가 프롬프트에 남아 있는가 ──
//
// ①②가 진짜 관문이고 이것은 그 위의 한 겹이다. 그래도 지워지면
// 회차가 스스로 하는 판단이 달라진다.
{
  const MUST_SAY = [
    { re: /main\s*직접\s*수정/, what: 'main 직접 수정 금지' },
    { re: /자동\s*병합\s*금지|병합\s*금지/, what: 'PR 자동 병합 금지' },
    { re: /LIVE\s*주문/, what: 'LIVE 주문 금지' },
    { re: /운영\s*DB/, what: '운영 DB 변경 금지' },
    { re: /안전장치를\s*제거하지/, what: '기존 안전장치 제거 금지' },
    { re: /NO_FIXED_SL/, what: 'NO_FIXED_SL·NO_FIXED_TP 계약 보호' },
    { re: /Draft/, what: 'Draft PR로만 올린다' },
    { re: /실패를\s*숨기지|숨기지\s*않습니다/, what: '테스트 실패 은폐 금지' },
    { re: /억지로\s*코드를\s*바꾸지/, what: '고칠 것이 없으면 바꾸지 않는다' },
  ];
  // 프롬프트는 주석이 아니라 값이므로 주석 제거본에서 찾는다.
  for (const m of MUST_SAY) {
    if (!m.re.test(src)) {
      err(`${WF}: 프롬프트에서 "${m.what}" 지시가 사라졌습니다`);
    }
  }
}

// ── ⑥ 비밀을 로그로 흘리지 않는가 ──
{
  if (/show_full_output:\s*true/.test(src)) {
    err(`${WF}: \`show_full_output: true\` 입니다 — 액션 설명이 `
      + `로그에 비밀이 드러날 수 있다고 적고 있습니다`);
  }
  for (const line of src.split('\n')) {
    if (!/^\s*echo\b/.test(line)) continue;
    if (/sha256sum|cut -c/.test(line)) continue;          // 지문은 허용
    if (/\$\{\{\s*secrets\./.test(line) || /\$\{?(OAUTH|APIKEY)\}?\b/.test(line)) {
      // 값이 아니라 "있는지 없는지"만 적는 줄은 허용한다.
      if (/-z|-n|인증:/.test(line)) continue;
      err(`${WF}: 비밀 값을 출력하는 줄이 있습니다\n    ${line.trim().slice(0, 80)}`);
    }
  }
}

// ── ⑦ 예약은 저장소 변수로 명시적으로 켠다 ──
//
// 병합되는 순간 매시간 돌기 시작하면, 비용과 동작을 보기 전에 이미
// 돌고 있는 것이다. 처음에는 수동 실행으로 확인한다.
{
  if (!src.includes(`vars.${lane.enableVar}`)) {
    err(`${WF}: 예약 실행이 \`vars.${lane.enableVar}\`로 켜지지 않습니다 — `
      + '병합과 동시에 매시간 돌기 시작합니다');
  }
  if (!/if:\s*\$\{\{[^}]*workflow_dispatch/.test(src)) {
    err(`${WF}: 수동 실행 경로가 조건에 없습니다 — 처음 확인할 방법이 없습니다`);
  }
}

// ── ⑧ 결과물을 다시 보는 관문이 붙어 있는가 ──
//
// 프롬프트는 지시고 이것은 관문이다. 빠지면 "안전장치를 지워서
// 초록을 만든" 회차를 아무도 못 본다.
{
  if (!src.includes('check-autodev-safety.mjs')) {
    err(`${WF}: 변경 안전 관문(check-autodev-safety)이 없습니다`);
  } else if (!new RegExp(`check-autodev-safety\\.mjs[^\\n]*--mode ${lane.mode}\\b`).test(src)) {
    err(`${WF}: 변경 안전 관문을 \`--mode ${lane.mode}\`로 부르지 않습니다 — `
      + '갈래가 다르면 보는 규칙이 다릅니다');
  }
}

// ── ⑨ 위험한 도구를 CLI 수준에서 막는가 ──
//
// 권한으로 막는 것이 1차고 이것은 2차다. `curl` 하나만 열려 있어도
// 배포된 앱이나 거래소로 직접 요청을 만들 수 있다.
{
  const MUST_DENY = ['gh workflow run', 'gh pr merge', 'curl', 'psql'];
  const m = src.match(/--disallowedTools\s+"([^"]*)"/);
  if (!m) {
    err(`${WF}: \`--disallowedTools\`가 없습니다 — 도구 수준 차단이 없습니다`);
  } else {
    for (const d of MUST_DENY) {
      if (!m[1].includes(d)) {
        err(`${WF}: \`${d}\`를 막지 않습니다 — 이 하나로 울타리를 넘을 수 있습니다`);
      }
    }
  }
}

// ── ⑩ 거래 갈래는 검증이 더 세야 한다 ──
if (lane.mode === 'trading') {
  // **프롬프트에 적힌 문장으로는 안 된다.** 프롬프트도 같은 문자열을
  // 담고 있어서, 실제 실행 단계를 지워도 통과했다(음성 시험 W7).
  // 그래서 셸에서만 나오는 모양(실패를 잡는 `|| fail=1`)을 본다.
  if (!/check-100x-mutations\.mjs --self-test \|\| fail=1/.test(src)) {
    err(`${WF}: 변이 하네스 자기 점검을 **실행 단계에서** 돌리지 않습니다 — `
      + '프롬프트에 적는 것과 실제로 돌리는 것은 다른 사실입니다');
  }
  if (!/for f in scripts\/check-\*\.mjs/.test(src)) {
    err(`${WF}: 검사기 전수 재확인이 없습니다 — `
      + '에이전트가 "돌렸다"고 적은 것과 실제 통과는 다른 사실입니다');
  }
  if (!/worker:build/.test(src)) {
    err(`${WF}: 워커 빌드 확인이 없습니다`);
  }
}

// ── ⑫ 도구를 **허용 목록**으로 준다 ──
//
// 공식 문서: "Claude does not have access to execute arbitrary Bash
// commands by default." 즉 `--allowedTools`가 없으면 에이전트는 테스트도
// 못 돌린다 — 검증했다고 적어도 돌린 적이 없는 것이다. 반대로 넓게 주면
// 울타리가 무의미해진다. **필요한 것만** 있는지 센다.
{
  const am = src.match(/--allowedTools\s+"([^"]*)"/);
  if (!am) {
    err(`${WF}: \`--allowedTools\`가 없습니다 — Bash는 기본으로 꺼져 있어 `
      + '에이전트가 테스트·타입검사·빌드를 돌릴 수 없습니다');
  } else {
    const allow = am[1];
    for (const need of ['Bash(npm test)', 'Bash(npx tsc --noEmit)', 'Bash(npm run build)']) {
      if (!allow.includes(need)) {
        err(`${WF}: 허용 목록에 \`${need}\`가 없습니다 — 그 검증을 돌릴 수 없습니다`);
      }
    }
    // 넓게 여는 모양은 막는다. `Bash(:*)`·`Bash(npm:*)`은 무엇이든 된다.
    for (const tooWide of ['Bash(:*)', 'Bash(*)', 'Bash(npm:*)', 'Bash(node:*)',
      'Bash(gh:*)', 'Bash(git:*)', 'Bash(bash:*)', 'Bash(sh:*)']) {
      if (allow.includes(tooWide)) {
        err(`${WF}: 허용 목록이 너무 넓습니다 (\`${tooWide}\`) — `
          + '그 하나로 금지한 명령까지 전부 열립니다');
      }
    }
  }
}

// ── ⑬ main 보호 규칙을 확인하고, 모르면 멈추는가 ──
//
// `contents: write`는 기술적으로 main push를 허용한다. 보호 규칙이
// 진짜 관문인데, **관문이 있는지 모르는 채로** 무인 회차를 돌리면
// 약속만 남는다.
{
  if (!/branches\/main\/protection/.test(src)) {
    err(`${WF}: main 보호 규칙을 확인하지 않습니다 — `
      + '`contents: write`가 main push를 허용하는데 관문이 있는지 모릅니다');
  }
  if (!/required_pull_request_reviews/.test(src)) {
    err(`${WF}: 보호 규칙에서 PR 필수 여부를 보지 않습니다 — `
      + '보호가 켜져 있어도 PR 없이 밀 수 있으면 관문이 아닙니다');
  }
  // 기존 보호 API만으로는 Ruleset 기반 보호를 검출할 수 없다.
  // 두 API 중 하나에서 PR 필수 조건을 증명해야 하며, 읽기 실패는 거부한다.
  if (!/rules\/branches\/main/.test(src)) {
    err(`${WF}: main에 적용되는 Ruleset을 확인하지 않습니다`);
  }
  if (!/get\('type'\)\s*==\s*'pull_request'/.test(src)) {
    err(`${WF}: 유효한 Ruleset에서 PR 필수 규칙을 검증하지 않습니다`);
  }
  if (!/status\s*!=\s*200/.test(src) || !/sys\.exit\(1\)/.test(src)) {
    err(`${WF}: 보호 규칙 조회 실패를 fail-closed로 처리하지 않습니다`);
  }
  if (!/No effective pull-request requirement/.test(src) || !/sys\.exit\(1\)/.test(src)) {
    err(`${WF}: PR 필수 규칙이 없을 때 실행을 차단하지 않습니다`);
  }
}

// ── ⑭ 검증을 워크플로가 직접 하는가 ──
//
// 에이전트가 "돌렸고 통과했다"고 적는 것과 실제 통과는 다른 사실이다.
{
  const need = [
    { re: /^\s+npm test \|\|/m, what: 'npm test' },
    // **기준선을 재는 것과 그것을 대조하는 것은 다른 단계다.**
    // `npx tsc ... | grep -c` 만 보면 기준선 단계가 대신 증명해 준다 —
    // 음성 시험 X9가 그렇게 빠져나갔다. 대조 단계에만 있는 비교문을 본다.
    // 기준선은 **환경변수로** 넘긴다(SC2170). 그래서 비교문은
    // `-gt "${base}"` 모양이고, 그 `base`가 `TSC_BEFORE`에서 온다는
    // 것까지 함께 본다 — 둘 중 하나만 보면 연결이 끊겨도 통과한다.
    { re: /-gt\s+"\$\{base\}"/, what: 'tsc 기준선 **대조**(늘었는지 비교)' },
    { re: /TSC_BEFORE:\s*\$\{\{\s*steps\.baseline\.outputs\.tsc_before\s*\}\}/,
      what: '기준선을 환경변수로 넘기기' },
    { re: /^\s+npm run build \|\|/m, what: 'npm run build' },
  ];
  for (const n of need) {
    if (!n.re.test(src)) {
      err(`${WF}: 워크플로가 ${n.what}를 직접 돌리지 않습니다 — `
        + '에이전트의 보고만으로는 통과를 확인할 수 없습니다');
    }
  }
}

}   // ← 갈래 반복 끝

// ── ⑪ 두 갈래가 동시에 돌지 않는가 ──
//
// 엔진과 화면이 같은 시각에 깨면 두 브랜치가 갈리고, 변경 안전 관문이
// 서로의 변경을 보게 된다.
{
  const crons = LANES.map((l) => {
    if (!existsSync(l.wf)) return null;
    const m = readFileSync(l.wf, 'utf8').match(/cron:\s*'([^']+)'/);
    return m ? m[1] : null;
  });
  if (crons[0] && crons[1] && crons[0] === crons[1]) {
    err(`두 갈래의 예약 시각이 같습니다 (${crons[0]}) — 동시에 깨면 브랜치가 갈립니다`);
  }

  // **그리고 같은 concurrency 그룹이어야 한다.** 예약 시각을 벌린
  // 것만으로는 부족하다 — 앞 회차가 길어지면 그대로 겹치고, 그때
  // 두 브랜치가 같은 파일을 만진다.
  const groups = LANES.map((l) => {
    if (!existsSync(l.wf)) return null;
    const m = readFileSync(l.wf, 'utf8').match(/^concurrency:[\s\S]*?group:\s*(\S+)/m);
    return m ? m[1] : null;
  });
  if (!groups[0] || !groups[1]) {
    err('갈래의 concurrency 그룹을 읽지 못했습니다');
  } else if (groups[0] !== groups[1]) {
    err(`두 갈래의 concurrency 그룹이 다릅니다 (${groups[0]} · ${groups[1]}) — `
      + '앞 회차가 길어지면 일반 갈래와 거래 갈래가 동시에 돕니다');
  }
}

// ── ⑮ 체크아웃된 프로젝트 설정이 인증을 바꿔치지 않는가 ──
//
// **울타리가 워크플로 파일만 보던 자리다.**
//
// Claude Code는 작업 디렉터리의 `.claude/settings.json`과
// `.claude/settings.local.json`을 설정으로 읽는다. 공식 설정 색인은
// `apiKeyHelper`와 `env`의 적용 범위를 둘 다 **"Any file"** 로 적으므로,
// 저장소에 **커밋된** 그 파일에서도 적용된다. 그리고 프로젝트 로컬 설정은
// 우선순위에서 사용자 설정보다 위다.
//
// 무인 회차는 이 저장소를 체크아웃한 뒤 그 안에서 돈다. 그래서 커밋된
// 설정 파일에 `apiKeyHelper`나 `env.ANTHROPIC_API_KEY`가 들어가면
// **워크플로 YAML은 그대로인데 인증 경로가 바뀐다** — YAML만 읽는 검사는
// 그것을 구조적으로 볼 수 없다. 실제로 이 저장소는
// `.claude/settings.local.json`을 **git으로 추적하고 있다**(공식 문서는
// 이 파일을 커밋하지 말라고 적는다).
//
// 값은 읽지 않는다. **키 이름만** 센다 — 값이 토큰일 수 있고, 키·시크릿
// 값은 로그·응답·커밋 어디에도 남기지 않는다.
{
  const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

  // **추적되는 파일만** 본다. 개발자 각자의 추적되지 않는 개인 설정은
  // 체크아웃에 들어가지 않으므로 무인 회차와 무관하고, 그것까지 빨갛게
  // 만들면 사람이 이 검사기를 무시하게 된다.
  let tracked = null;
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...SETTINGS_FILES],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    tracked = new Set(out.split('\0').filter(Boolean));
  } catch {
    tracked = null;
  }

  if (tracked == null) {
    // 못 읽은 것을 "없음"으로 적지 않는다.
    err('추적되는 프로젝트 설정 파일 목록을 읽지 못했습니다 — '
      + 'git에게 물을 수 없으면 커밋된 설정이 인증을 바꿔치는지 셀 수 없습니다');
  } else {
    for (const f of SETTINGS_FILES) {
      if (!tracked.has(f)) continue;        // 체크아웃에 없다 — 볼 것이 없다
      if (!existsSync(f)) {
        err(`${f}이 추적되는데 작업 트리에 없습니다 — 체크아웃에서 무엇이 적용될지 셀 수 없습니다`);
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(f, 'utf8'));
      } catch {
        // 깨진 JSON을 통과로 보지 않는다. (내용·오류 본문은 적지 않는다)
        err(`${f}을 JSON으로 읽지 못했습니다 — 무엇이 적용되는지 셀 수 없습니다`);
        continue;
      }
      const { hits, truncated } = findOverrideKeys(parsed);
      for (const h of hits) {
        err(`${f}: \`${h.path}\` 키가 있습니다 — ${h.why}`
          + ' · 무인 회차는 체크아웃된 이 파일을 설정으로 읽습니다 (값은 보지 않았습니다)');
      }
      if (truncated) {
        err(`${f}: 중첩이 너무 깊어 끝까지 보지 못했습니다 — 못 본 것을 "없음"으로 적지 않습니다`);
      }
    }
  }
}

if (bad === 0) {
  console.log(`✅ 판단 자기 점검 ${SELF.total}/${SELF.total} — `
    + '인증 바꿔치기 이름을 키로 찾고, 품은 이름은 찾지 않고, 못 본 깊이를 '
    + '"없음"으로 적지 않고, 결과에 값을 섞지 않는다');
  console.log(`✅ 무인 회차 울타리 ${LANES.length}갈래 — 다른 워크플로 실행 불가 · `
    + '거래소/DB 시크릿 없음 · 도구 차단 · 겹침 방지 · 시간 상한 · '
    + '변경 안전 관문 · 금지 지시 보존 · 체크아웃 설정의 인증 바꿔치기 없음');
} else {
  console.error('');
  console.error('   이 회차는 사람이 보고 있지 않은 시간에 돕니다.');
  console.error('   울타리가 사라져도 사라진 것을 아무도 보지 못합니다.');
}
process.exit(bad ? 1 : 0);
