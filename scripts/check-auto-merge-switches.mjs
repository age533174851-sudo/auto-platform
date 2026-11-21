#!/usr/bin/env node
// scripts/check-auto-merge-switches.mjs
//
// **보고 통로가 쓰기 통로로 변하지 않게 한다.**
//
// 무엇을 막나
// ───────────
// `autoMergeGate`에서 기술 판정부(`autoMergeTechnicalGate`)를 떼어냈다.
// 보고기가 "스위치를 켠다면 그래도 막는 것이 남아 있는가"를 물을 수
// 있어야 열린 PR 100개가 왜 안 올라가는지 알 수 있기 때문이다.
//
// 그런데 그 함수는 **라벨도 초안도 보지 않는다.** 머지 러너가 실수로
// 그것을 부르면, 라벨 없는 초안 PR이 합쳐진다. 그때 CI는 초록이고
// 로그도 정상처럼 보인다 — 조용히 틀리는 쪽이 언제나 더 나쁘다.
//
// 그래서 값으로 못 박는다:
//
//   ① `autoMergeGate`에 라벨·초안 조기 반환이 **그대로 있다**
//   ② `scripts/auto-merge.mjs`는 `autoMergeTechnicalGate`를 **부르지 않는다**
//   ③ `scripts/pr-backlog.mjs`에 **쓰기 호출이 없다**
//   ④ 두 스크립트가 사실을 **같은 모듈**에서 가져온다 (판단이 갈리지 않게)
//
// 이 검사기는 막는 쪽이다. 막혀서 불편하면 **검사기가 옳다.**

import { readFileSync, existsSync } from 'node:fs';
import { stripJsComments } from './lib/strip-comments.mjs';

const GATE = 'src/lib/ci/autoMergeGate.ts';
const MERGER = 'scripts/auto-merge.mjs';
const REPORTER = 'scripts/pr-backlog.mjs';
const FACTS = 'scripts/lib/pr-facts.mjs';
const REBASER = 'scripts/auto-rebase.mjs';

let errors = [];
let notes = [];

/**
 * 파일을 읽는다. `code`는 **주석을 뺀 것**이다.
 *
 * 왜 둘인가: 쓰기 호출을 모양으로 막는데, 주석에 `method: 'PUT'`이라고
 * 적은 설명까지 걸리면 "쓰면 안 되는 이유"를 적을 수가 없다. 주석은
 * 호출이 아니다. 반대로 스위치가 **있는지**는 코드에서 봐야 한다 —
 * 주석에 적힌 라벨 확인은 아무것도 막지 않는다.
 *
 * 주석 제거는 `scripts/lib/strip-comments.mjs`가 한다 — 사본을 만들지 않는다.
 */
function read(p) {
  if (!existsSync(p)) { errors.push(`${p}이 없습니다`); return null; }
  const raw = readFileSync(p, 'utf8');
  return { raw, code: stripJsComments(raw) };
}


/**
 * **규칙은 여기 하나에 있다.** 소스를 받아서 위반 목록을 돌려준다.
 *
 * 왜 함수로 뺐나: `--self-test`가 **일부러 망가뜨린 소스**를 넣어서
 * 각 규칙이 실제로 걸리는지 확인한다. 통과만 하고 아무것도 막지 않는
 * 검사기는 없는 것보다 나쁘다 — 막는 것처럼 보이면서 안 막는다.
 */
export function evaluate({ gate, merger, reporter, facts, rebaser }) {
  errors = [];
  notes = [];
// ── ① 스위치가 게이트에 그대로 있는가 ──
  if (gate) {
    const head = gate.slice(
      gate.indexOf('export function autoMergeGate'),
      gate.indexOf('export function autoMergeTechnicalGate'));
    if (!head) {
      errors.push(`${GATE}: autoMergeGate / autoMergeTechnicalGate 를 찾지 못했습니다`);
    } else {
      if (!/labels\.includes\(AUTO_MERGE_LABEL\)/.test(head)) {
        errors.push(`${GATE}: autoMergeGate에서 라벨 확인이 사라졌습니다 — `
          + '라벨은 유일한 스위치입니다');
      }
      if (!/code:\s*'NO_LABEL'/.test(head)) {
        errors.push(`${GATE}: autoMergeGate가 NO_LABEL을 돌려주지 않습니다`);
      }
      if (!/pr\.draft/.test(head) || !/code:\s*'DRAFT'/.test(head)) {
        errors.push(`${GATE}: autoMergeGate에서 초안 확인이 사라졌습니다`);
      }
      if (!/return autoMergeTechnicalGate\(pr\)/.test(head)) {
        errors.push(`${GATE}: autoMergeGate가 기술 판정부를 부르지 않습니다 — `
          + '판정이 두 곳으로 갈라졌을 수 있습니다');
      }
    }
    // 기술 판정부가 스위치를 다시 보면 안 된다 (보고가 막힌다)
    const tech = gate.slice(gate.indexOf('export function autoMergeTechnicalGate'));
    if (tech && /AUTO_MERGE_LABEL/.test(tech)) {
      errors.push(`${GATE}: autoMergeTechnicalGate가 라벨을 봅니다 — `
        + '이 함수는 스위치를 보지 않아야 보고가 됩니다');
    }
    if (tech && /code:\s*'(NO_LABEL|DRAFT)'/.test(tech)) {
      errors.push(`${GATE}: autoMergeTechnicalGate가 NO_LABEL/DRAFT를 돌려줍니다`);
    }
  }
  
  // ── ② 머지 러너는 기술 판정부를 부르지 않는다 ──
  if (merger) {
    if (/autoMergeTechnicalGate/.test(merger)) {
      errors.push(`${MERGER}: autoMergeTechnicalGate를 부릅니다 — `
        + '이 함수는 라벨도 초안도 보지 않습니다. 합치는 쪽은 autoMergeGate만 씁니다');
    }
    if (!/autoMergeGate\(facts\)/.test(merger)) {
      errors.push(`${MERGER}: autoMergeGate(facts) 호출을 찾지 못했습니다`);
    }
  }
  
  // ── ③ 보고기에 쓰기 호출이 없다 ──
  //
  // 모양으로 막는다. "읽기 전용"이라고 주석에 적는 것으로는 안 된다 —
  // 주석은 고쳐도 아무것도 깨지지 않는다.
  const WRITE_SHAPES = [
    [/method:\s*['"](PUT|POST|PATCH|DELETE)['"]/i, 'HTTP 쓰기 method'],
    [/\/merge['"`]/, '머지 엔드포인트'],
    [/ccr\/auto_merge/, '자동 머지 켜기'],
    [/ready_for_review/, '초안 해제'],
    [/convert_to_draft/, '초안 전환'],
    [/\/labels/, '라벨 변경'],
    [/\/issues\/\$\{[^}]*\}\/comments/, '코멘트 작성'],
    [/upsertComment/, '코멘트 작성'],
    [/execFileSync\(\s*['"]git['"]/, 'git 실행'],
    [/\bwriteFileSync\b/, '파일 쓰기'],
  ];
  if (reporter) {
    for (const [re, what] of WRITE_SHAPES) {
      if (re.test(reporter)) {
        errors.push(`${REPORTER}: ${what}가 있습니다 — 이 스크립트는 읽기만 합니다`);
      }
    }
    // api()가 method를 받으면 언젠가 쓰기가 들어온다
    if (/async function api\([^)]*init/.test(reporter)) {
      errors.push(`${REPORTER}: api()가 init을 받습니다 — `
        + '모양 자체로 쓰기를 막으려면 method를 받지 않아야 합니다');
    }
    if (!/autoMergeTechnicalGate/.test(reporter)) {
      errors.push(`${REPORTER}: autoMergeTechnicalGate를 쓰지 않습니다 — `
        + '판정을 따로 만들면 머지 게이트와 갈립니다');
    }
  }
  
  // ── ④ 사실은 같은 모듈에서 온다 ──
  if (facts) {
    for (const [p, src] of [[MERGER, merger], [REPORTER, reporter]]) {
      if (!src) continue;
      if (!/from '\.\/lib\/pr-facts\.mjs'/.test(src) && !/from '\.\.\/lib\/pr-facts\.mjs'/.test(src)) {
        errors.push(`${p}: scripts/lib/pr-facts.mjs 를 쓰지 않습니다 — `
          + '사실을 각자 만들면 같은 PR에 다른 답이 나옵니다');
      }
      // 사실을 다시 인라인으로 만들면 안 된다
      if (/^\s*const facts = \{/m.test(src)) {
        errors.push(`${p}: PrFacts를 직접 만듭니다 — pr-facts.mjs의 gatherFacts/buildFacts를 쓰세요`);
      }
    }
    // 못 읽은 것을 0으로 적지 않는다
    if (!/unresolvedThreads: null/.test(facts) || !/changesRequested: null/.test(facts)) {
      errors.push(`${FACTS}: 읽기 실패 때 null로 두는 경로를 찾지 못했습니다 — `
        + 'UNKNOWN을 0으로 적으면 미해결 리뷰가 무시됩니다');
    }
    if (!/review\?\.unresolvedThreads \?\? null/.test(facts)) {
      notes.push(`${FACTS}: buildFacts가 리뷰 null을 그대로 넘기는지 확인하세요`);
    }
  }
  // ── ⑤ 열린 PR 목록을 첫 장에서 끊지 않는가 ──
  //
  // 2026-11-07에 열린 PR이 225개인데 세 도구가 전부 **100개만** 보고
  // 있었다. 셋 다 `?state=open&per_page=100`을 한 번 부르고 끝냈다.
  // 그래서 `auto-merge`의 30분 안전망과 `auto-rebase`의 30분 안전망이
  // 둘 다 첫 장 밖의 PR을 영원히 건너뛰었고, `pr-backlog`는 적체를
  // 100개라고 적었다. **셋이 같은 자리에서 같이 틀린 것이다.**
  //
  // 그래서 목록을 `listOpenPulls` 하나로 모았다. 이 규칙은 그 자리가
  // 다시 갈라지지 않게 한다 — 한 도구만 직접 장을 세는 순간 걸린다.
  for (const [label, src] of [[MERGER, merger], [REPORTER, reporter], [REBASER, rebaser]]) {
    if (!src) continue;
    if (!/listOpenPulls/.test(src)) {
      errors.push(`${label}: 열린 PR 목록을 \`listOpenPulls\`로 읽지 않습니다 — `
        + '첫 장(100개)에서 끊기면 안전망이 그 밖의 PR을 영원히 건너뜁니다');
    }
    for (const m of src.matchAll(/pulls\?state=open[^`'"\n]*/g)) {
      if (!/[?&]page=/.test(m[0])) {
        errors.push(`${label}: 열린 PR 목록을 장 없이 직접 부릅니다 — 100개에서 조용히 잘립니다`);
      }
    }
  }

  // `listOpenPulls`는 **다 읽었을 때만** complete=true여야 한다.
  if (facts && !/complete: false/.test(facts)) {
    errors.push(`${FACTS}: listOpenPulls가 못 읽은 경우를 complete=false로 적지 않습니다 — `
      + '부분을 전체로 읽습니다');
  }

  return { errors: [...errors], notes: [...notes] };
}

const SELF = process.argv.includes('--self-test');

const sources = {
  gate: read(GATE)?.code, merger: read(MERGER)?.code,
  reporter: read(REPORTER)?.code, facts: read(FACTS)?.code,
  rebaser: read(REBASER)?.code,
};
const fileErrors = [...errors];

if (SELF) {
  // 실제 소스는 깨끗해야 하고, 각 규칙은 망가뜨리면 걸려야 한다.
  const clean = evaluate(sources);
  const cases = [
    ['게이트의 라벨 확인 제거',
      s => ({ ...s, gate: s.gate.replace(/labels\.includes\(AUTO_MERGE_LABEL\)/g, 'false') })],
    ['게이트의 NO_LABEL 제거',
      s => ({ ...s, gate: s.gate.replace(/code: 'NO_LABEL'/g, "code: 'OK'") })],
    ['게이트의 초안 확인 제거',
      s => ({ ...s, gate: s.gate.replace(/code: 'DRAFT'/g, "code: 'OK'") })],
    ['게이트가 기술 판정부를 안 부름',
      s => ({ ...s, gate: s.gate.replace('return autoMergeTechnicalGate(pr);', 'return { merge: true, code: "OK", details: [], reason: "" };') })],
    ['머지 러너가 기술 판정부를 부름',
      s => ({ ...s, merger: s.merger.replace('autoMergeGate(facts)', 'autoMergeTechnicalGate(facts)') })],
    ['보고기에 쓰기 method 추가',
      s => ({ ...s, reporter: s.reporter + "\nawait fetch(u, { method: 'PUT' });\n" })],
    ['보고기에 머지 엔드포인트 추가',
      s => ({ ...s, reporter: s.reporter + "\nconst x = `/repos/${REPO}/pulls/1/merge`;\n" })],
    ['보고기에 라벨 변경 추가',
      s => ({ ...s, reporter: s.reporter + "\nconst x = `/repos/${REPO}/issues/1/labels`;\n" })],
    ['보고기에 초안 해제 추가',
      s => ({ ...s, reporter: s.reporter + '\nconst x = "ready_for_review";\n' })],
    ['보고기의 api()가 init을 받음',
      s => ({ ...s, reporter: s.reporter.replace('async function api(path)', 'async function api(path, init = {})') })],
    ['보고기가 판정기를 안 씀',
      s => ({ ...s, reporter: s.reporter.replace(/autoMergeTechnicalGate/g, 'myOwnGate') })],
    ['보고기가 공용 사실 모듈을 안 씀',
      s => ({ ...s, reporter: s.reporter.replace("from './lib/pr-facts.mjs'", "from './nope.mjs'") })],
    ['머지 러너가 사실을 직접 만듦',
      s => ({ ...s, merger: s.merger + '\n    const facts = { number: 1 };\n' })],
    ['사실 모듈이 리뷰 실패를 0으로 적음',
      s => ({ ...s, facts: s.facts.replace(/unresolvedThreads: null/g, 'unresolvedThreads: 0') })],
    ['머지 러너가 목록을 첫 장만 읽음',
      s => ({ ...s, merger: s.merger.replace(/listOpenPulls/g, 'nope') })],
    ['보고기가 목록을 첫 장만 읽음',
      s => ({ ...s, reporter: s.reporter.replace(/listOpenPulls/g, 'nope') })],
    ['재배치기가 목록을 첫 장만 읽음',
      s => ({ ...s, rebaser: s.rebaser.replace(/listOpenPulls/g, 'nope') })],
    ['장 없는 단발 호출이 되살아남',
      s => ({ ...s, merger: s.merger + '\nconst u = `/repos/${REPO}/pulls?state=open&per_page=100`;\n' })],
    ['listOpenPulls가 부분을 전체로 적음',
      s => ({ ...s, facts: s.facts.replace(/complete: false/g, 'complete: true') })],
  ];

  const bad = [];
  if (clean.errors.length) bad.push(`실제 소스가 이미 위반입니다: ${clean.errors.join(' / ')}`);
  for (const [name, mutate] of cases) {
    const r = evaluate(mutate(sources));
    if (r.errors.length === 0) bad.push(`막지 못했습니다: ${name}`);
  }
  if (bad.length) {
    console.error('\n❌ 자동 머지 스위치 검사기 자체가 고장났습니다\n');
    for (const b of bad) console.error(`  · ${b}`);
    process.exit(1);
  }
  console.log(`✅ 자기 시험 — 규칙 ${cases.length}개가 모두 실제로 막습니다`);
}

const result = evaluate(sources);
errors = [...fileErrors, ...result.errors];
notes = result.notes;

for (const n of notes) console.log(`⚠️  ${n}`);
if (errors.length) {
  console.error('\n❌ 자동 머지 스위치 검사 실패\n');
  for (const e of errors) console.error(`  · ${e}`);
  console.error('\n막혔다면 검사기가 옳습니다. 스위치를 우회하지 말고 이유를 고치세요.\n');
  process.exit(1);
}
console.log('✅ 자동 머지 스위치 — 라벨·초안은 게이트에만, 보고기는 읽기만');
