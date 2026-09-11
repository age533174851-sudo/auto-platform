#!/usr/bin/env node
// scripts/check-db-columns.mjs
//
// **테스트 4천 개가 초록이어도 실제 DB 칸 이름 하나가 틀리면 시스템은
// 안전하지 않다.**
//
// 무슨 일이 있었나
// ────────────────
// `/api/ledger/sync`가 `exchange_connections`에서 `exchange`를 읽었다.
// 그 칸은 없다 — 실제 이름은 `exchange_id`다(004). 그런데 조회 오류를
// 안 받고 `Array.isArray(conns) ? conns : []`로 넘어갔으므로,
// **연결 0개로 조용히 끝났다.**
//
// 기능은 있고, 테스트는 통과하고, 실제로는 한 건도 수집하지 않는다.
// 이 저장소가 계속 잡아 온 고장이 정확히 그 모양이다.
//
// 무엇을 보나
// ───────────
// 마이그레이션 원문에서 표별 칸 이름을 모으고, 코드의 `.select('...')`에
// 적힌 이름이 그 표에 실제로 있는지 본다. 정교한 SQL 파서가 아니라
// **이름 대조**다 — 그것만으로 이번 고장은 정확히 잡힌다.
//
// **못 읽으면 통과시키지 않는다.** 표를 하나도 못 모으면 그건
// '문제 없음'이 아니라 이 검사가 고장 난 것이다.
import { readFileSync, globSync } from 'node:fs';

// ── 1. 마이그레이션에서 표 → 칸 목록 ──
const columns = new Map();   // table -> Set(column)
const addCol = (t, c) => {
  const table = String(t).toLowerCase().replace(/^public\./, '').replace(/"/g, '');
  const col = String(c).toLowerCase().replace(/"/g, '');
  if (!columns.has(table)) columns.set(table, new Set());
  columns.get(table).add(col);
};

const migFiles = globSync('supabase/migrations/*.sql').sort();
for (const f of migFiles) {
  let sql = '';
  try { sql = readFileSync(f, 'utf8'); } catch { continue; }
  // 주석 제거
  sql = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

  // CREATE TABLE t ( ... )
  const ct = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  let m;
  while ((m = ct.exec(sql)) !== null) {
    const table = m[1];
    for (const line of m[2].split('\n')) {
      const t = line.trim();
      if (!t || /^(primary|unique|foreign|constraint|check|exclude)\b/i.test(t)) continue;
      const name = (/^([\w"]+)\s/.exec(t) || [])[1];
      if (name) addCol(table, name);
    }
  }
  // ALTER TABLE t ADD COLUMN [IF NOT EXISTS] c [, ADD COLUMN ... ]
  //
  // **한 문장에 ADD COLUMN이 여러 개 올 수 있다.**
  //
  //   ALTER TABLE autotrade_schedules
  //     ADD COLUMN IF NOT EXISTS execution_profile_id       text,
  //     ADD COLUMN IF NOT EXISTS execution_preset_id        text,
  //     ADD COLUMN IF NOT EXISTS execution_contract_version int;
  //
  // 예전 정규식은 표 이름과 **첫 칸 하나**만 잡았다. 그래서 위 세 칸 중
  // 둘은 이 검사기가 존재를 모른 채로 있었고, 그 칸을 select하는 코드가
  // "없는 칸"으로 잘못 잡혔다. 검사기가 틀리는 것도 고장이다 —
  // 없는 칸을 있다고 하는 것보다 **있는 칸을 없다고 하는 쪽**이 더 자주
  // 사람을 헷갈리게 한다(멀쩡한 코드를 고치게 만든다).
  //
  // 이제 문장을 통째로 떼어 그 안의 ADD COLUMN을 전부 훑는다.
  const stmt = /alter\s+table\s+(?:if\s+exists\s+)?([\w."]+)([\s\S]*?);/gi;
  while ((m = stmt.exec(sql)) !== null) {
    const table = m[1];
    const body = m[2];
    const addc = /add\s+column\s+(?:if\s+not\s+exists\s+)?([\w"]+)/gi;
    let c;
    while ((c = addc.exec(body)) !== null) addCol(table, c[1]);
  }
}

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };

if (columns.size === 0) {
  err('마이그레이션에서 표를 하나도 읽지 못했습니다 — 이 검사가 고장 났습니다');
}

// ── 2. 코드의 .from('t').select('a, b') 대조 ──
//
// 서버 코드만 본다. 화면은 서버가 준 모양을 쓰므로 여기 대상이 아니다.
const codeFiles = [
  ...globSync('src/app/api/**/*.ts'),
  ...globSync('src/lib/**/*.ts'),
  ...globSync('worker/src/**/*.ts'),
].map(f => f.replaceAll('\\', '/')).filter(f => !f.endsWith('.test.ts'));

// 별칭·집계·와일드카드는 이름 대조 대상이 아니다.
const skipExpr = (e) => !e || e === '*' || e.includes('(') || e.includes(':') || e.includes('!');

let checked = 0;
for (const f of codeFiles) {
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  if (!src.includes('.from(')) continue;

  // `.from('table')` 뒤 400자 안의 첫 `.select('...')`를 짝지어 본다.
  const re = /\.from\(\s*['"]([\w]+)['"]\s*\)([\s\S]{0,400}?)\.select\(\s*['"]([^'"]*)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const table = m[1].toLowerCase();
    const known = columns.get(table);
    if (!known) continue;                 // 워커가 만드는 표 등 — 여기서 판단하지 않는다
    const line = src.slice(0, m.index).split('\n').length;
    for (const raw of m[3].split(',')) {
      const col = raw.trim().toLowerCase();
      if (skipExpr(col)) continue;
      checked += 1;
      if (!known.has(col)) {
        err(`${f}:${line}\n     ${table}에 '${col}' 칸이 없습니다`
          + `\n     실제 칸: ${Array.from(known).slice(0, 12).join(', ')}${known.size > 12 ? ' …' : ''}`
          + '\n     조회 오류를 안 받으면 이 실수는 "연결 0개"로 조용히 끝납니다');
      }
    }
  }
}

if (bad === 0) {
  console.log(`✅ 표 ${columns.size}개 · 대조한 칸 ${checked}개 · 없는 칸 참조 0건`);
} else {
  console.error('');
  console.error('   기능이 있고 테스트가 통과해도, 칸 이름 하나가 틀리면 실제로는 한 건도 안 됩니다.');
}
process.exit(bad ? 1 : 0);
