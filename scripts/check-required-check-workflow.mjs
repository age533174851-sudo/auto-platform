#!/usr/bin/env node
// scripts/check-workflow-concurrency.mjs
//
// **필수 체크가 "실패"한 것이 아니라 "생기지도 않은" 자리를 막는다.**
//
// 2026-11-13, PR #576 의 HEAD `cfe3efcb` 에 필수 체크 `auto-merge-gate`
// 가 없었다. `auto-merge` 워크플로의 `pull_request_target` run 은
// `cancelled` 였고 **시작한 잡이 0개**였다. 시험이 깨진 것이 아니라
// 줄을 서다 밀려난 것이다 — 저장소 전체가 `concurrency.group: auto-merge`
// 한 줄에 서 있었기 때문이다.
//
// 그 모양은 조용하다. 체크가 **빨갛지 않고 아예 없다.** 그래서
// "검사 실패"로도 안 잡히고, PR 은 영원히 병합 대기로 남는다.
//
// 판정은 `scripts/lib/workflow-concurrency.mjs` 한 곳에 있다.

import { readFileSync, readdirSync } from 'node:fs';
import { stripYamlComments } from './lib/strip-comments.mjs';
import { join } from 'node:path';
import { concurrencyOf, concurrencyFindings, triggerFindings, aggregatorFindings,
  prBaseFilterFindings, selfTest } from './lib/workflow-concurrency.mjs';

const WF_DIR = '.github/workflows';

/**
 * **필수 체크를 만드는 워크플로**만 이 세기를 받는다.
 *
 * 아무 워크플로에나 걸면 거짓 RED 가 쏟아지고, 늑대 소리를 내는 검사기는
 * 곧 무시당한다. `main` ruleset 의 필수 검사를 만드는 것만 센다.
 */
const REQUIRED_CHECK_WORKFLOWS = ['auto-merge.yml'];
/**
 * 워크플로를 읽는다 — **주석을 걷어서.**
 *
 * 주석을 안 걷으면 이 검사기가 막으려는 바로 그 고장을 주석 한 줄로
 * 되돌릴 수 있다. 실측(ed00c1a4), `auto-merge.yml` 에서 들여쓰기를
 * 지킨 채 주석 처리했을 때:
 *
 *   :89  `group: >-`              → rc=0 ✅ (지우면 rc=1)
 *   :90  `auto-merge-${{ … }}`    → rc=0 ✅
 *   :95  `cancel-in-progress: false` → rc=0 ✅
 *
 * `auto-merge-gate` 는 main 의 **필수 검사**다. 그 검사를 "생기지도
 * 않게" 만든 것이 바로 concurrency 설정이었고(PR #576), 그래서 이
 * 관문이 생겼다. 그 관문이 주석으로 열린다면 없는 것과 같다.
 */
const readWorkflow = (name) =>
  stripYamlComments(readFileSync(join(WF_DIR, name), 'utf8'));


/**
 * **필수 체크를 만드는 워크플로 전부.**
 *
 * `main` ruleset 이 요구하는 것은 **둘**이다 — `verify`(ci.yml)와
 * `auto-merge-gate`(auto-merge.yml). 그런데 "체크가 생기지도 않는" 자리를
 * 세는 것은 여태 `auto-merge.yml` 하나뿐이었다. 같은 침묵이 다른 쪽에서
 * 났고, 그게 더 오래 갔다.
 *
 * 실측(2026-11-20): 열린 PR 185건 중 `verify` 가 **없는** 것이 14건이고,
 * 그 중 13건은 base 가 main 이 아니다. 옛 `ci.yml` 의
 * `pull_request: branches: [main]` 때문에 run 이 **생성조차 되지 않았다.**
 * 실패도 대기도 아니고 없었다 — 그리고 없는 검사는 초록처럼 보인다.
 * 이 세션에서 그 모양의 PR 7건(#553 · #501 · #512 · #590 · #556 · #605 ·
 * #587)을 하나씩 되살려야 했다.
 *
 * `push:` 의 `branches: [main]` 은 **올바른 쓰임이라 잡지 않는다.**
 */
const BASE_FILTER_WORKFLOWS = ['ci.yml', 'auto-merge.yml'];

/**
 * **샤드를 합산하는 워크플로.**
 *
 * 합산 job 이 `if: always()` 면 실행이 취소됐을 때도 돌아서 "증거 없음"을
 * 실패로 적는다. 취소는 실패가 아니라 교체된 SHA 의 결과다 — 그걸
 * 빨간불로 남기면 커밋을 올릴 때마다 정체를 다시 읽어야 하는 빨간불이
 * 하나씩 쌓인다.
 */
const SHARDED_WORKFLOWS = ['mutation-100x-pr313.yml'];

if (process.argv.includes('--self-test')) {
  const r = selfTest();
  for (const f of r.failed) console.error(`❌ 자기 점검 실패 — ${f}`);
  if (r.failed.length === 0) console.log(`✅ 자기 점검 ${r.total}/${r.total}`);
  process.exit(r.failed.length ? 1 : 0);
}

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };

const SELF = selfTest();
for (const f of SELF.failed) err(`판단 자기 점검 실패 — ${f}`);

let present = [];
try {
  present = readdirSync(WF_DIR);
} catch {
  err(`${WF_DIR} 를 읽지 못했습니다 — 못 본 것을 "없음"으로 적지 않습니다`);
}

let checked = 0;
for (const name of REQUIRED_CHECK_WORKFLOWS) {
  if (!present.includes(name)) {
    // **파일이 사라진 것을 통과로 적지 않는다.** 이름이 바뀌면 이 검사기가
    // 조용히 아무것도 안 보게 된다.
    err(`${WF_DIR}/${name} 이 없습니다 — 필수 체크를 만드는 워크플로가 사라졌거나 이름이 바뀌었습니다`);
    continue;
  }
  const src = readWorkflow(name);

  // 실패하는 길이 둘이다 — ① 깨어나지 않거나 ② 깨어났다가 밀려나거나.
  // 한쪽만 보면 다른 쪽으로 같은 증상이 난다.
  for (const f of triggerFindings(src, `${WF_DIR}/${name}`)) err(f);

  const c = concurrencyOf(src);
  if (c == null) {
    err(`${WF_DIR}/${name}: \`concurrency:\` 블록이 없습니다 — `
      + '겹침 제어가 없으면 같은 PR 에 병합 판정이 동시에 두 번 돌 수 있습니다');
    continue;
  }
  checked += 1;
  for (const f of concurrencyFindings({ ...c, where: `${WF_DIR}/${name}` })) err(f);
}

// ── base 를 가리는 트리거: 그 PR 에는 체크가 **생기지 않는다** ──
let baseChecked = 0;
for (const name of BASE_FILTER_WORKFLOWS) {
  if (!present.includes(name)) {
    err(`${WF_DIR}/${name} 이 없습니다 — 필수 체크를 만드는 워크플로가 사라졌거나 이름이 바뀌었습니다`);
    continue;
  }
  baseChecked += 1;
  const src = readWorkflow(name);
  for (const f of prBaseFilterFindings(src, `${WF_DIR}/${name}`)) err(f);
}
if (bad === 0 && baseChecked === 0) {
  err('base 필터를 한 건도 보지 못했습니다 — 0건을 통과로 적지 않습니다');
}

let shardChecked = 0;
for (const name of SHARDED_WORKFLOWS) {
  if (!present.includes(name)) {
    err(`${WF_DIR}/${name} 이 없습니다 — 샤드 합산 워크플로가 사라졌거나 이름이 바뀌었습니다`);
    continue;
  }
  shardChecked += 1;
  const src = readWorkflow(name);
  for (const f of aggregatorFindings(src, `${WF_DIR}/${name}`)) err(f);
}
if (bad === 0 && shardChecked === 0) {
  err('샤드 합산 워크플로를 한 건도 보지 못했습니다 — 0건을 통과로 적지 않습니다');
}

if (bad === 0 && checked === 0) {
  err('필수 체크 워크플로를 한 건도 보지 못했습니다 — 0건을 통과로 적지 않습니다');
}

if (bad === 0) {
  console.log(`✅ 필수 체크 워크플로 ${checked}개 · base 필터 ${baseChecked}개 · 샤드 합산 ${shardChecked}개 — 모든 PR HEAD 에서 깨어나고`
    + '(opened · synchronize · reopened · ready_for_review · labeled), '
    + '같은 PR 의 이벤트는 한 줄, 다른 PR 은 서로 다른 줄, 예약 안전망은 저만의 줄 · '
    + `돌고 있는 판정을 끊지 않음 (자기 점검 ${SELF.total}/${SELF.total})`);
}
process.exit(bad ? 1 : 0);
