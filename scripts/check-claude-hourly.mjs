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
// 그래서 다섯 가지를 센다:
//
//   ① 다른 워크플로를 깨울 수 없는가       (`actions: read`)
//   ② 거래소·DB 시크릿을 안 받는가
//   ③ 겹쳐 돌지 않는가                      (`concurrency`)
//   ④ 끝나지 않는 회차를 끊는가             (`timeout-minutes`)
//   ⑤ 금지 문구가 프롬프트에 남아 있는가
//
// **금지를 프롬프트에만 적는 것으로는 부족하다.** ①②가 진짜 관문이고
// ⑤는 그 위에 한 겹 더 두는 것이다. 그래서 ①②가 깨지면 더 큰 소리로
// 실패한다.
import { readFileSync, existsSync } from 'node:fs';

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
  // 인증은 있어야 한다. 둘 중 하나는 반드시.
  const hasAuth = /secrets\.ANTHROPIC_API_KEY\b/.test(src)
    || /secrets\.CLAUDE_CODE_OAUTH_TOKEN\b/.test(src);
  if (!hasAuth) {
    err(`${WF}: Claude 인증 시크릿을 쓰지 않습니다 — 돌 수 없는 워크플로입니다`);
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
}

if (bad === 0) {
  console.log(`✅ 무인 회차 울타리 ${LANES.length}갈래 — 다른 워크플로 실행 불가 · `
    + '거래소/DB 시크릿 없음 · 도구 차단 · 겹침 방지 · 시간 상한 · '
    + '변경 안전 관문 · 금지 지시 보존');
} else {
  console.error('');
  console.error('   이 회차는 사람이 보고 있지 않은 시간에 돕니다.');
  console.error('   울타리가 사라져도 사라진 것을 아무도 보지 못합니다.');
}
process.exit(bad ? 1 : 0);
