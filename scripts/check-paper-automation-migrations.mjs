#!/usr/bin/env node
// 모의 자동화 시험대가 **운영이 쓰는 스키마**를 올리는가.
//
// 같은 고장을 두 번 봤다
// ──────────────────────
// 마이그레이션 102(봇 다중화)는 `paper_auto_claim` 함수와 claim 인덱스를
// 바꿨다. 그런데 그것을 실제 PostgreSQL로 검증하는 두 시험대가 손으로 적은
// 목록을 들고 있었고, 102가 그 목록에 들어가지 않았다:
//
//   · `scripts/probe/paper-automation-flow.mjs` — #648에서 뒤늦게 발견
//   · `scripts/paper-automation-pg.test.mjs`   — #652 조사 중에 발견
//
// 즉 운영이 쓰는 claim 함수를 **아무도 실제 DB로 돌려 보지 않는 상태**가
// 한동안 있었다. 그 사이에 15% 확률의 동시 claim 경합이 숨어 있었다(103).
//
// 왜 자동화 대신 검사인가
// ───────────────────────
// 목록을 자동으로 채우게 만들 수도 있다. 하지만 어떤 마이그레이션을
// 올릴지는 **시험이 무엇을 재는지에 달린 판단**이고, 그 판단을 지우면
// 관계없는 마이그레이션까지 끌려 들어와 시험이 느려지고 깨진다.
//
// 그래서 목록은 사람이 적고, **빠진 것이 있으면 CI가 센다.**
// 체크리스트를 자동으로 눌러 주는 대신, 빠뜨릴 수 없게 만든다.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { stripJsComments } from './lib/strip-comments.mjs';

const MIG_DIR = 'supabase/migrations';
/** 시험대: 파일 경로 → 사람이 읽을 이름 */
const HARNESSES = [
  ['scripts/paper-automation-pg.test.mjs', '실제 PostgreSQL 동시성·리스 시험'],
  ['scripts/probe/paper-automation-flow.mjs', '브라우저→API→DB 프로브'],
];

let bad = 0;
const fail = (m) => { console.error(`❌ ${m}`); bad++; };

if (!existsSync(MIG_DIR)) { console.error(`❌ ${MIG_DIR}가 없습니다`); process.exit(1); }

// 이름에 `paper`가 들어간 마이그레이션이 대상이다. 모의 장부·모의 자동화의
// 표·함수가 전부 여기 있다.
const paperMigrations = readdirSync(MIG_DIR)
  .filter(n => /^\d{3}_.*paper.*\.sql$/i.test(n))
  .sort();

if (paperMigrations.length === 0) fail(`${MIG_DIR}에서 paper 마이그레이션을 찾지 못했습니다`);

/**
 * 시험대가 그 마이그레이션을 올리는가.
 *
 * 두 가지 적는 방식을 모두 받는다:
 *   · 번호 목록  `const ids=[10,25,...,102,103]`
 *   · 파일명 목록 `['099_paper_automation.sql', ...]`
 *
 * ★ `src`는 **주석을 지운 코드**여야 한다. 원문을 그대로 넘기면 주석이
 *   목록을 대신한다 — 아래 `strip` 주석에 측정값이 있다.
 */
function covers(src, name) {
  if (src.includes(name)) return true;              // 파일명으로 적었다
  const num = Number(name.slice(0, 3));
  // 번호 목록 안에 그 수가 **독립된 항목으로** 있는가.
  // `10`이 `102`에 섞여 잡히지 않도록 경계를 본다.
  for (const m of src.matchAll(/ids\s*=\s*\[([^\]]*)\]/g)) {
    const items = m[1].split(',').map(x => Number(x.trim()));
    if (items.includes(num)) return true;
  }
  return false;
}

// ★ 주석을 지운 코드만 본다. 원문을 그대로 세면 **주석이 목록을 대신한다.**
//
//   돌려서 얻은 값 (기준 main ed00c1a4, fixture 탐침):
//
//     대조 · 원문 그대로                                 rc=0  OK
//     대조 ★★ flow 의 ids 에서 102 를 뺀다                rc=1  OK
//     102 를 빼고 파일명을 주석에 적는다                     rc=0  구멍
//     ids 줄을 통째로 주석 처리한다                         rc=0  구멍
//     ids 를 주석에만 남기고 코드에서 지운다                   rc=0  구멍
//     pg 시험대의 LATE 배열을 주석 처리한다                   rc=0  구멍
//
//   세 번째 줄이 가장 나쁘다. 시험대가 **아무것도 올리지 않는데** 이
//   검사기는 19개를 전부 올린다고 말했다. 관문이 눈을 감은 것이다.
//
//   주석을 지우는 판정은 `scripts/lib/strip-comments.mjs` 한 곳에 있다 —
//   여기서 다시 구현하지 않는다. 그 함수는 **문자열 안을 보존한다.**
//   파일명 목록은 `'102_paper_multi_bot.sql'`처럼 문자열 리터럴이므로
//   그래야 세어진다.
//
//   아직 열려 있는 방향 (닫았다고 적지 않는다): 파일명이 목록이 아닌
//   **다른 문자열 리터럴**에 들어 있어도 세어진다. 예컨대 오류 문구에
//   `'102_paper_multi_bot.sql'`을 적으면 통과한다. 그것을 가리려면 문자열
//   위치가 아니라 구문을 봐야 하고, 공용 AST 판정이 필요하다.
for (const [path, label] of HARNESSES) {
  if (!existsSync(path)) { fail(`${path}가 없습니다 (${label})`); continue; }
  const src = stripJsComments(readFileSync(path, 'utf8'));
  const missing = paperMigrations.filter(n => !covers(src, n));
  if (missing.length) {
    fail(`${path} (${label})가 올리지 않는 paper 마이그레이션 ${missing.length}개: ${missing.join(', ')}`
      + '\n   → 이 시험대는 운영이 쓰지 않는 스키마를 보고 있습니다.'
      + ' 실제로 올리는 목록에 더하세요.'
      + '\n   → 주석은 세지 않습니다. 일부러 제외해야 한다면 이 검사기를'
      + ' 고쳐서 제외를 눈에 보이게 적어야 합니다 — 주석에 사유만 적으면'
      + ' 아무도 올리지 않는데 통과하던 것이 이 검사의 구멍이었습니다.');
  }
}

if (bad > 0) {
  console.error(`\n모의 자동화 시험대 스키마 검사 실패: ${bad}건`);
  process.exit(1);
}
console.log(`✅ 모의 자동화 시험대 — paper 마이그레이션 ${paperMigrations.length}개를 ${HARNESSES.length}개 시험대가 모두 올립니다`);
