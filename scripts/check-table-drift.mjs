#!/usr/bin/env node
// scripts/check-table-drift.mjs
//
// **마이그레이션에 없는 표에 쓰지 않는다.**
//
// 무슨 일이 있었나
// ────────────────
// 코드가 `audit_logs`에 여섯 곳에서 썼다. 그런데 그 표를 만드는
// 마이그레이션이 **하나도 없었다.** 정의는 `supabase/schema.sql`에만
// 있었고(파이프라인 밖이다), 그마저도 코드가 쓰는 칸과 달랐다:
//
//   코드가 쓴 칸      actor_id · action · details(객체) · result · target_id
//   schema.sql       actor_id · action · details(TEXT) · (result 없음)
//   생성된 타입      user_id · entity_type · metadata · (actor_id 없음)
//
// **셋이 서로 달랐다.** 그리고 그 insert들은 전부 `try/catch`거나
// 오류를 안 보는 자리라, 실패해도 아무 흔적이 없다.
//
// 그중에는 **실거래 주문(LIVE_ORDER)과 관리자 긴급 정지
// (EMERGENCY_BOT_STOP)**가 있었다. 급할 때 누른 버튼일수록 나중에
// "누가 언제 왜 눌렀나"를 많이 묻게 되는데, 그 기록이 없었다.
//
// 실제로 적용되는 표는 040이 만든 `audit_events`다.
//
// 무엇을 막는가
// ─────────────
// 코드가 `.from('X')`로 쓰는 표 이름이 `supabase/migrations/*.sql`에
// 만들어지지 않으면 실패한다. **`schema.sql`은 세지 않는다** — 그건
// 파이프라인이 적용하지 않는 파일이다.
import { readFileSync, readdirSync, globSync } from 'node:fs';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };

/** 마이그레이션이 실제로 만드는 표 이름 */
function migratedTables() {
  const out = new Set();
  for (const f of readdirSync('supabase/migrations').filter(n => n.endsWith('.sql'))) {
    const src = readFileSync(`supabase/migrations/${f}`, 'utf8');
    for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["']?([a-z0-9_]+)/gi)) {
      out.add(m[1].toLowerCase());
    }
  }
  return out;
}

/**
 * `supabase/schema*.sql`이 만드는 표.
 *
 * **이건 마이그레이션이 아니다.** 파이프라인(`apply-migrations`)이
 * 적용하지 않는 기반 스키마 파일이고, 새 환경에서는 사람이 한 번
 * 실행해야 한다. 그래서 여기 있는 표는 "있을 것"이지 "적용됐다"가 아니다.
 */
function baseSchemaTables() {
  const out = new Set();
  for (const f of ['supabase/schema.sql', 'supabase/schema_v2.sql']) {
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["']?([a-z0-9_]+)/gi)) {
      out.add(m[1].toLowerCase());
    }
  }
  return out;
}

/**
 * **파이프라인 밖에 있는 표의 기준선.**
 *
 * 이 수는 **늘어나면 안 된다.** 늘어난다는 것은 새 기능이 또 파이프라인
 * 밖의 표에 쓴다는 뜻이고, 그러면 새 환경에서 그 기능은 조용히 안 돈다.
 *
 * 줄이는 방향은 언제나 옳다 — 마이그레이션으로 옮기면 된다.
 */
const OUTSIDE_PIPELINE_BASELINE = 7;

/**
 * 이 검사가 모르는 표.
 *
 * **여기에 넣으려면 그 표가 어디서 만들어지는지 확인해야 한다.**
 * 확인 없이 넣으면 이 검사는 꺼진 것과 같다.
 */
const KNOWN_ELSEWHERE = {
  profiles: 'Supabase Auth 연동 표 — 프로젝트 초기 설정에서 만든다',
};

const migrated = migratedTables();
const baseOnly = baseSchemaTables();
if (migrated.size === 0) {
  err('마이그레이션에서 표를 하나도 못 읽었습니다 — 검사가 아무것도 안 보고 통과할 뻔했습니다');
}

/** 줄 주석·블록 주석을 지운다 — 왜 안 쓰는지 설명하려면 이름을 적어야 한다 */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => (/^\s*(\/\/|\*)/.test(l) ? '' : l.replace(/\/\/.*$/, '')))
    .join('\n');
}

const files = [
  ...globSync('src/**/*.ts'),
  ...globSync('src/**/*.tsx'),
  ...globSync('worker/src/**/*.ts'),
].map(f => f.replaceAll('\\', '/')).filter(f => !/\.test\.tsx?$/.test(f));

const hits = new Map();   // table → [file:line]
for (const f of files) {
  let raw = '';
  try { raw = readFileSync(f, 'utf8'); } catch { continue; }
  // 타입 정의 파일은 표를 쓰는 것이 아니라 적어 두는 곳이다.
  if (/supabase\/types\.ts$/.test(f)) continue;
  const src = strip(raw);
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\.from\(\s*['"`]([a-z0-9_]+)['"`]/gi)) {
      const t = m[1].toLowerCase();
      if (!hits.has(t)) hits.set(t, []);
      hits.get(t).push(`${f}:${i + 1}`);
    }
  });
}

let checked = 0;
const outside = [];
for (const [table, where] of [...hits.entries()].sort()) {
  checked += 1;
  if (migrated.has(table)) continue;
  if (KNOWN_ELSEWHERE[table]) continue;

  if (baseOnly.has(table)) {
    // 있기는 하다. 다만 **파이프라인이 재현하지 못한다.**
    outside.push({ table, where });
    continue;
  }

  err(`'${table}' 표에 쓰는데 어디에서도 만들지 않습니다`
    + `\n     ${where.slice(0, 4).join('\n     ')}${where.length > 4 ? `\n     … 외 ${where.length - 4}곳` : ''}`
    + '\n     마이그레이션에도, 기반 스키마에도 없습니다 — 이 쓰기는 조용히 실패합니다');
}

// ── 파이프라인 밖의 표 ──
//
// **줄이는 것은 언제나 옳고, 늘리는 것은 막는다.**
if (outside.length > OUTSIDE_PIPELINE_BASELINE) {
  err(`파이프라인 밖의 표가 ${outside.length}개입니다 (기준선 ${OUTSIDE_PIPELINE_BASELINE})`
    + `\n     늘어난 것: ${outside.map(o => o.table).join(' · ')}`
    + '\n     새 기능이 기반 스키마(supabase/schema*.sql)의 표에 쓰고 있습니다'
    + '\n     — 그 표는 마이그레이션이 만들지 않으므로 새 환경에서 재현되지 않습니다');
}

if (bad === 0) {
  const line = `✅ 코드가 쓰는 표 ${checked}개 · 마이그레이션이 만드는 표 ${migrated.size}개`;
  if (outside.length > 0) {
    console.log(`${line} · 파이프라인 밖 ${outside.length}개(기준선 ${OUTSIDE_PIPELINE_BASELINE})`);
    console.log(`   파이프라인 밖: ${outside.map(o => o.table).join(' · ')}`);
    console.log('   이 표들은 supabase/schema*.sql에만 있어 새 환경에서 자동으로 만들어지지 않습니다.');
  } else {
    console.log(line);
  }
} else {
  console.error('');
  console.error('   쓰기가 조용히 실패하는 표는 없는 것보다 나쁩니다.');
  console.error('   화면에는 "기록됨"이 뜨고 실제로는 아무것도 안 남습니다.');
}
process.exit(bad ? 1 : 0);
