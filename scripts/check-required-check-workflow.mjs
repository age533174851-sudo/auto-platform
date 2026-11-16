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
import { join } from 'node:path';
import { concurrencyOf, concurrencyFindings, triggerFindings, selfTest }
  from './lib/workflow-concurrency.mjs';

const WF_DIR = '.github/workflows';

/**
 * **필수 체크를 만드는 워크플로**만 이 세기를 받는다.
 *
 * 아무 워크플로에나 걸면 거짓 RED 가 쏟아지고, 늑대 소리를 내는 검사기는
 * 곧 무시당한다. `main` ruleset 의 필수 검사를 만드는 것만 센다.
 */
const REQUIRED_CHECK_WORKFLOWS = ['auto-merge.yml'];

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
  const src = readFileSync(join(WF_DIR, name), 'utf8');

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

if (bad === 0 && checked === 0) {
  err('필수 체크 워크플로를 한 건도 보지 못했습니다 — 0건을 통과로 적지 않습니다');
}

if (bad === 0) {
  console.log(`✅ 필수 체크 워크플로 ${checked}개 — 모든 PR HEAD 에서 깨어나고`
    + '(opened · synchronize · reopened · ready_for_review · labeled), '
    + '같은 PR 의 이벤트는 한 줄, 다른 PR 은 서로 다른 줄, 예약 안전망은 저만의 줄 · '
    + `돌고 있는 판정을 끊지 않음 (자기 점검 ${SELF.total}/${SELF.total})`);
}
process.exit(bad ? 1 : 0);
