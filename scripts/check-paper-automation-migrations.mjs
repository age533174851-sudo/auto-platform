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

for (const [path, label] of HARNESSES) {
  if (!existsSync(path)) { fail(`${path}가 없습니다 (${label})`); continue; }
  const src = readFileSync(path, 'utf8');
  const missing = paperMigrations.filter(n => !covers(src, n));
  if (missing.length) {
    fail(`${path} (${label})가 올리지 않는 paper 마이그레이션 ${missing.length}개: ${missing.join(', ')}`
      + '\n   → 이 시험대는 운영이 쓰지 않는 스키마를 보고 있습니다.'
      + ' 목록에 더하거나, 왜 제외인지 그 파일에 적으세요.');
  }
}

if (bad > 0) {
  console.error(`\n모의 자동화 시험대 스키마 검사 실패: ${bad}건`);
  process.exit(1);
}
console.log(`✅ 모의 자동화 시험대 — paper 마이그레이션 ${paperMigrations.length}개를 ${HARNESSES.length}개 시험대가 모두 올립니다`);
