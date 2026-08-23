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
 * **파이프라인 밖에 있는 표의 기준선 — 이름 집합이다.**
 *
 * 처음엔 개수(7)만 비교했다. 그건 검사가 아니다: `trade_orders`를
 * 마이그레이션으로 옮기고 새로 `wallet_snapshots`에 쓰기 시작하면
 * 개수는 그대로 7이라 **통과한다.** 하나가 고쳐지고 하나가 새로
 * 생겼는데 검사는 아무 말도 안 한다.
 *
 * 그래서 **이름으로 비교한다.**
 *   - 이 집합에 없던 표가 나타나면 → 실패
 *   - 이 집합의 표가 마이그레이션으로 옮겨져 사라지면 → 통과(권장)
 *     그리고 여기서도 지우라고 알려 준다 — 기준선이 실제보다 넓으면
 *     그만큼 다시 열린다.
 *
 * 이 7개는 `supabase/schema.sql`에만 정의가 있다. 실제 DB에 있는지는
 * `scripts/check-db-schema.mjs`가 진짜 DB에 물어본다.
 */
const OUTSIDE_PIPELINE_BASELINE = new Set([
  'alerts',
  'backtest_results',
  'pnl_reports',
  'portfolio_positions',
  'trade_orders',
  'trading_strategies',
  'watchlists',
]);

/**
 * 이 검사가 모르는 표.
 *
 * **여기에 넣으려면 그 표가 어디서 만들어지는지 확인해야 한다.**
 * 확인 없이 넣으면 이 검사는 꺼진 것과 같다.
 */
const KNOWN_ELSEWHERE = {
  profiles: 'Supabase Auth 연동 표 — 프로젝트 초기 설정에서 만든다',
};

/**
 * **같은 표를 두 번, 서로 다른 모양으로 정의하지 않는다.**
 *
 * `watchlists`가 그랬다. `schema.sql`은 `name · symbols(jsonb)`,
 * `schema_v2.sql`은 `symbol · name_kr · symbol_ticker …`. 둘 다
 * `CREATE TABLE IF NOT EXISTS`라 **먼저 실행된 쪽이 이긴다.**
 * 어느 쪽이 이겼는지는 파일만 봐서는 알 수 없고, 진 쪽을 쓰는 코드는
 * 조용히 실패한다 — 화면에는 저장된 것처럼 보이면서.
 */
function definitionsByTable() {
  const defs = new Map();   // table → [{ file, cols:Set }]
  const files = [
    ...readdirSync('supabase/migrations')
      // `RUN_*.sql`은 여러 마이그레이션을 한 번에 붙여 놓은 묶음 파일이다.
      // 같은 표가 두 번 나오는 것이 **의도**라 여기서 세지 않는다.
      .filter(n => n.endsWith('.sql') && !n.startsWith('RUN_'))
      .map(n => `supabase/migrations/${n}`),
    'supabase/schema.sql', 'supabase/schema_v2.sql',
  ];
  for (const f of files) {
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["']?([a-z0-9_]+)["']?\s*\(/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      const table = m[1].toLowerCase();
      // 괄호 균형을 세어 본문 끝을 찾는다 — CHECK(...)·NUMERIC(18,2)이 안에 있다.
      let depth = 0, i = re.lastIndex - 1, end = -1;
      for (; i < src.length; i++) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) continue;
      const body = src.slice(re.lastIndex, end);
      const cols = new Set();
      // 최상위 쉼표로만 자른다
      let d = 0, cur = '';
      for (const ch of body) {
        if (ch === '(') d += 1;
        if (ch === ')') d -= 1;
        if (ch === ',' && d === 0) { cols.add(firstWord(cur)); cur = ''; }
        else cur += ch;
      }
      cols.add(firstWord(cur));
      cols.delete('');
      if (!defs.has(table)) defs.set(table, []);
      defs.get(table).push({ file: f, cols });
    }
  }
  return defs;
}

/** 한 줄에서 칸 이름만. 제약(PRIMARY KEY·UNIQUE·CHECK…) 줄은 버린다. */
function firstWord(line) {
  const t = String(line).replace(/--[^\n]*/g, '').trim();
  const w = (t.split(/[\s(]/)[0] || '').toLowerCase().replace(/["']/g, '');
  if (!w || /^(primary|unique|check|constraint|foreign|exclude|like)$/.test(w)) return '';
  return /^[a-z_][a-z0-9_]*$/.test(w) ? w : '';
}

const migrated = migratedTables();
const baseOnly = baseSchemaTables();

/**
 * **이미 갈라져 있는 표.** 이름으로 적는다 — 개수가 아니다.
 *
 * 새 갈라짐이 하나라도 생기면 실패한다. 여기 있는 것을 고쳐서
 * 사라지면 통과하고, 지우라고 알려 준다.
 *
 * **여기 넣는 것은 "괜찮다"가 아니라 "아직 안 고쳤다"는 뜻이다.**
 */
const KNOWN_FORKS = new Map([
  ['exchange_connections', '004 마이그레이션(api_key)과 schema_v2(updated_at)가 갈렸다 — 실계좌 연결 표라 손대기 전에 실제 DB 확인이 먼저다'],
  ['portfolios',           'schema.sql(type·allocation_pct·is_paper…)과 schema_v2(description)가 갈렸다'],
  ['audit_logs',           'schema.sql과 schema_v2가 갈렸다 — 코드는 더 이상 이 표에 쓰지 않는다(audit_events로 옮김)'],
]);

// ── 같은 표의 정의가 둘 이상이고 **양쪽 다** 상대에 없는 칸을 가지면 갈라진 것 ──
//
// 한쪽이 다른 쪽을 온전히 품고 있으면(상위 집합) 칸이 더해진 것이라
// 갈라짐과는 다르다 — 알려만 주고 막지는 않는다.
const forks = new Map();
const supersets = [];
for (const [table, list] of definitionsByTable()) {
  if (list.length < 2) continue;
  const base = list[0];
  for (const other of list.slice(1)) {
    const onlyA = [...base.cols].filter(c => !other.cols.has(c));
    const onlyB = [...other.cols].filter(c => !base.cols.has(c));
    if (onlyA.length === 0 && onlyB.length === 0) continue;
    const line = `${base.file}: ${onlyA.length ? onlyA.join(' · ') : '(없음)'}`
      + ` / ${other.file}: ${onlyB.length ? onlyB.join(' · ') : '(없음)'}`;
    if (onlyA.length > 0 && onlyB.length > 0) forks.set(table, line);
    else supersets.push(`${table} — ${line}`);
  }
}

for (const [table, line] of [...forks].sort()) {
  if (KNOWN_FORKS.has(table)) continue;
  err(`'${table}' 표가 두 곳에서 서로 다른 모양으로 정의돼 있습니다`
    + `\n     ${line}`
    + '\n     둘 다 CREATE TABLE IF NOT EXISTS라 **먼저 실행된 쪽이 이깁니다**'
    + '\n     — 진 쪽을 쓰는 코드는 조용히 실패합니다 (watchlists가 그랬습니다)'
    + '\n     정의를 한 곳으로 모으세요');
}
const fixedForks = [...KNOWN_FORKS.keys()].filter(t => !forks.has(t)).sort();
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
// **줄이는 것은 언제나 옳고, 늘리는 것은 막는다.** 개수가 아니라
// 이름으로 본다 — 하나 줄고 하나 늘면 개수는 같지만 검사는 통과하면 안 된다.
const outsideNames = new Set(outside.map(o => o.table));
const added = [...outsideNames].filter(t => !OUTSIDE_PIPELINE_BASELINE.has(t)).sort();
const gone  = [...OUTSIDE_PIPELINE_BASELINE].filter(t => !outsideNames.has(t)).sort();

if (added.length > 0) {
  const where = new Map(outside.map(o => [o.table, o.where]));
  err(`파이프라인 밖의 새 표: ${added.join(' · ')}`
    + added.map(t => `\n     ${t} → ${(where.get(t) || []).slice(0, 3).join(' · ')}`).join('')
    + '\n     새 기능이 기반 스키마(supabase/schema*.sql)의 표에 쓰고 있습니다'
    + '\n     — 그 표는 마이그레이션이 만들지 않으므로 새 환경에서 재현되지 않습니다'
    + '\n     supabase/migrations/에 CREATE TABLE을 추가하세요');
}

if (bad === 0) {
  const line = `✅ 코드가 쓰는 표 ${checked}개 · 마이그레이션이 만드는 표 ${migrated.size}개`;
  if (outside.length > 0) {
    console.log(`${line} · 파이프라인 밖 ${outside.length}개(기준선 ${OUTSIDE_PIPELINE_BASELINE.size}개 이름)`);
    console.log(`   파이프라인 밖: ${[...outsideNames].sort().join(' · ')}`);
    console.log('   이 표들은 supabase/schema*.sql에만 있어 새 환경에서 자동으로 만들어지지 않습니다.');
    console.log('   실제 DB에 있는지는 scripts/check-db-schema.mjs가 확인합니다.');
  } else {
    console.log(line);
  }
  if (gone.length > 0) {
    // 기준선이 실제보다 넓으면 그만큼 다시 열린다. 지우라고 말한다.
    console.log(`   ℹ️ 기준선에서 지울 수 있는 표: ${gone.join(' · ')} — 이제 마이그레이션이 만듭니다`);
  }
  if (forks.size > 0) {
    console.log(`   ⚠️ 아직 갈라져 있는 표 ${forks.size}개(전부 KNOWN_FORKS에 적혀 있습니다): ${[...forks.keys()].sort().join(' · ')}`);
    console.log('      "괜찮다"가 아니라 "아직 안 고쳤다"입니다. 실제 DB 모양은 scripts/check-db-schema.mjs가 확인합니다.');
  }
  if (fixedForks.length > 0) {
    console.log(`   ℹ️ KNOWN_FORKS에서 지울 수 있는 표: ${fixedForks.join(' · ')} — 더 이상 갈라져 있지 않습니다`);
  }
  if (supersets.length > 0) {
    console.log(`   ℹ️ 칸이 더해진 정의(갈라짐 아님) ${supersets.length}건`);
  }
} else {
  console.error('');
  console.error('   쓰기가 조용히 실패하는 표는 없는 것보다 나쁩니다.');
  console.error('   화면에는 "기록됨"이 뜨고 실제로는 아무것도 안 남습니다.');
}
process.exit(bad ? 1 : 0);
