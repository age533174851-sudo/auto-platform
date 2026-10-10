#!/usr/bin/env node
// 실행 프로필 계약 검사기에 **기준 커밋이 전달되는가**를 워크플로에서 본다.
//
// 왜 이 검사가 필요한가
// ─────────────────────
// `check-execution-profile.mjs`는 base와 HEAD의 계약 지문을 비교한다.
// base를 못 받으면 origin/main으로 후퇴하는데, push main CI에서는
// origin/main == HEAD가 되어 **자기 자신과 비교**한다 — 정작 신뢰하는
// 실행에서 버전 검사가 꺼진다. 그래서 그 검사기는 PR·push 이벤트에서
// `EXECUTION_CONTRACT_BASE`가 비면 **실패한다.**
//
// 그 fail-closed는 올바르게 동작했다. 문제는 **배선이 둘이었다는 것**이다:
// `ci.yml`은 값을 넘기는데 새로 생긴 `mutation-100x-pr313.yml`은 넘기지
// 않았고, 그래서 8개 샤드가 전부 기준선 단계에서 멈췄다
// (runs/38065897023). 457건이 실패한 게 아니라 **시작조차 못 했다.**
//
// 같은 판단이 두 곳에 있으면 언젠가 갈린다. 세 번째 워크플로가 생길 때
// 같은 자리에서 또 끊기지 않도록, **검사기를 호출하는 모든 워크플로**가
// 그 값을 넘기는지 여기서 확인한다.
//
// 무엇을 보는가
// ─────────────
// `.github/workflows/*.yml` 중 아래를 실행하는 것:
//   · scripts/check-execution-profile.mjs      (직접 호출)
//   · scripts/check-100x-mutations.mjs         (하네스가 위를 다시 돈다)
//   · scripts/canonical-trading-mutations.mjs  (같은 이유)
//   · scripts/cta-verdict-mutations.mjs
// 그 워크플로가 `pull_request`·`push`로 돌면 job 또는 step에
// `EXECUTION_CONTRACT_BASE`가 있어야 한다.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.github/workflows';
const VAR = 'EXECUTION_CONTRACT_BASE';

/** 이 스크립트를 돌리면 계약 검사기가 (직접 또는 하네스를 통해) 돈다 */
const NEEDS_BASE = [
  'check-execution-profile.mjs',
  'check-100x-mutations.mjs',
  'canonical-trading-mutations.mjs',
  'cta-verdict-mutations.mjs',
];

const errors = [];
const err = (m) => errors.push(m);

let scanned = 0;
let wired = 0;

for (const name of readdirSync(DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))) {
  const src = readFileSync(join(DIR, name), 'utf8');

  const hits = NEEDS_BASE.filter(s => src.includes(s));
  if (hits.length === 0) continue;

  // 이벤트가 base를 알려 주는 경우에만 검사기가 그 값을 요구한다.
  // `workflow_dispatch`·`schedule`만으로 도는 워크플로는 대상이 아니다.
  const onPr = /^\s{2}pull_request:/m.test(src);
  const onPush = /^\s{2}push:/m.test(src);
  if (!onPr && !onPush) continue;

  scanned += 1;
  if (!src.includes(VAR)) {
    err(`${name}: ${hits.join(' · ')}을 ${onPr ? 'pull_request' : 'push'}에서 돌리는데`
      + ` ${VAR}를 넘기지 않습니다 — 계약 검사기가 기준선에서 멈춥니다`);
    continue;
  }

  // **값이 비면 넘기지 않은 것과 같다.** `${{ }}`가 비어 있을 수 있는
  // 표현식인지는 여기서 알 수 없지만, 최소한 이벤트의 base를 참조해야 한다.
  const line = src.split('\n').find(l => l.includes(VAR) && l.includes(':'));
  if (!line || !/pull_request\.base\.sha|github\.event\.before|\$\{\{/.test(line)) {
    err(`${name}: ${VAR}에 이벤트의 base를 넣지 않습니다 (${String(line || '').trim()})`
      + ' — 고정값이나 빈 값이면 자기 자신과 비교하는 상태로 되돌아갑니다');
    continue;
  }
  wired += 1;
}

if (scanned === 0) {
  // **0개를 통과로 적지 않는다.** 경로가 바뀌어 아무것도 못 찾았다면
  // 이 검사는 돌지 않은 것이다.
  err(`${DIR}에서 계약 검사기를 호출하는 워크플로를 하나도 찾지 못했습니다`
    + ' — 파일 위치나 스크립트 이름이 바뀌었는지 확인해야 합니다');
}

if (errors.length) {
  for (const e of errors) console.error(`❌ ${e}`);
  process.exit(1);
}
console.log(`✅ 계약 기준 커밋 배선 — 대상 워크플로 ${scanned}개 전부 ${VAR}를 넘깁니다`);
