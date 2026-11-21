#!/usr/bin/env node
// scripts/check-checker-sweep.mjs
//
// **제외 목록은 검사기를 숨기는 자리가 될 수 있다.**
//
// `scripts/lib/checker-sweep.mjs` 로 목록을 옮긴 덕분에 무인 회차가
// 그 목록을 고칠 수 있게 됐다. 그건 고치라고 연 길이지 **빼라고 연
// 길이 아니다.** 막는 검사기를 목록에 적어 넣으면 전수가 조용히 줄고,
// 줄어든 전수는 초록처럼 보인다 (`CLAUDE.md`: 없는 검사는 초록처럼 보인다).
//
// 그래서 네 가지를 센다:
//
//   ① 목록의 모든 항목이 **이유**와 **대신 도는 곳**을 갖는가
//      (`runWith` 로 러너가 직접 돌거나, `coveredBy` 가 돌거나 — 둘 중 하나)
//   ② `coveredBy` 라고 적은 파일이 **실제로 그 검사기를 언급하는가**
//      (주장만으로는 통과 못 한다)
//   ③ 선언이 썩지 않았는가 (없는 파일을 빼 두지 않았는가)
//   ④ **판단이 YAML 로 되돌아가지 않았는가** — 워크플로가 러너를 부르고,
//      제 안에 또 전수 루프를 갖고 있지 않은가
//
// ④ 가 이 관문의 핵심이다. 이것이 없으면 다음 사람이 워크플로에 루프를
// 다시 적고, 그 순간 "무인 회차가 제가 깨뜨린 것을 못 고치는" 모양이
// 그대로 돌아온다.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { SWEEP_EXCLUSIONS, sweepFindings } from './lib/checker-sweep.mjs';
import { stripYamlComments } from './lib/strip-comments.mjs';

const RUNNER = 'scripts/run-all-checkers.mjs';
/** 전수를 돌아야 하는 워크플로 */
const SWEEP_WORKFLOWS = ['.github/workflows/claude-hourly-trading.yml'];

/**
 * YAML 안에 전수 루프가 다시 생겼는가.
 *
 * **주석을 계약으로 읽지 않는다.** 처음 쓸 때 이 함수가 "전에는 여기에
 * `for f in scripts/check-*.mjs` 루프가 있었다"고 적은 **설명 주석**에
 * 걸렸다. 규칙이 아니라 규칙에 대한 설명을 보고 빨간불을 켠 것이고,
 * 그 반대 방향(주석에 적힌 문구만 보고 초록을 켜는 것)이 이 저장소가
 * 두 번 겪은 고장이다 — `scripts/lib/strip-comments.mjs` 머리말에 있다.
 * 그래서 **정본 함수로 주석을 걷어내고** 남은 코드만 본다.
 */
export function inlineSweepFindings(src, where) {
  const out = [];
  const text = stripYamlComments(String(src ?? ''));
  // **"러너를 부르는가"는 여기서 보지 않는다.** 그 질문의 주인은
  // `check-claude-hourly` 다(거기가 `|| fail=1`까지 함께 못 박는다).
  // 같은 판단을 두 곳에 두면 언젠가 갈린다 — 이 저장소의 상습 고장이다.
  // 여기는 **제외 목록이 정직한가**만 본다.
  // `for f in scripts/check-*.mjs` 모양이 돌아오면 목록이 둘이 된다.
  if (/for\s+\w+\s+in\s+[^\n]*scripts\/check-\*/.test(text)) {
    out.push(`${where}: YAML 안에 전수 루프가 다시 있습니다 — 제외 판단이 두 곳으로 갈립니다`);
  }
  return out;
}

export function allFindings({ exists = existsSync, read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null) } = {}) {
  const out = sweepFindings({ exclusions: SWEEP_EXCLUSIONS, exists, read });
  if (!exists(RUNNER)) out.push(`${RUNNER} 가 없습니다 — 전수를 돌 자리가 없습니다`);
  for (const w of SWEEP_WORKFLOWS) {
    if (!exists(w)) { out.push(`${w} 가 없습니다`); continue; }
    out.push(...inlineSweepFindings(read(w), w));
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const found = allFindings();
  if (found.length) {
    console.log('❌ 검사기 전수 제외 목록이 사실과 다릅니다');
    for (const f of found) console.log(`   · ${f}`);
    console.log('::error::검사기 전수 제외 목록이 사실과 다릅니다');
    process.exitCode = 1;
  } else {
    console.log(`✅ 검사기 전수 제외 ${SWEEP_EXCLUSIONS.length}건 — 전부 이유와 "대신 도는 곳"이 있고, 그 곳이 실제로 부른다 · YAML 에 전수 루프 없음`);
  }
}
