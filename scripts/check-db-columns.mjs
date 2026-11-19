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

/**
 * `.from('table').select(...)`에서 정적 projection을 읽는다.
 *
 * select 인자는 한 문자열일 수도 있고:
 *   .select('id, signal_id')
 *
 * 문자열을 이어 붙인 식일 수도 있다:
 *   .select('id, ' + 'signal_id')
 *
 * 예전 검사는 첫 문자열만 읽어서 두 번째 조각의 없는 칼럼을 영원히
 * 보지 못했다. 동적 변수/함수 호출은 이 이름 대조 검사에서 추측하지 않는다.
 */
function firstSelectArg(args) {
  let quote = null;
  let escaped = false;
  let paren = 0, brace = 0, bracket = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') paren += 1;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '{') brace += 1;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === ',' && paren === 0 && brace === 0 && bracket === 0) {
      return args.slice(0, i);
    }
  }
  return args;
}

function staticStringConcat(expr) {
  const parts = [];
  const lit = /(['"])([\s\S]*?)\1/g;
  let last = 0;
  let m;
  while ((m = lit.exec(expr)) !== null) {
    const between = expr.slice(last, m.index).replace(/\s+/g, '');
    if (between && between !== '+') return null;
    parts.push(m[2]);
    last = lit.lastIndex;
  }
  const tail = expr.slice(last).replace(/\s+/g, '');
  if (parts.length === 0 || (tail && tail !== '+')) return null;
  return parts.join('');
}

function selectCallsOf(src) {
  const out = [];
  const re = /\.from\(\s*['"]([\w]+)['"]\s*\)([\s\S]{0,400}?)\.select\(([\s\S]{0,600}?)\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // select의 두 번째 인자({ count: 'exact', head: true })에 있는 문자열은
    // projection이 아니다. 첫 번째 인자만 떼고, 정적 문자열 결합일 때만 본다.
    const projection = staticStringConcat(firstSelectArg(m[3]));
    if (projection == null) continue;
    out.push({ table: m[1], projection, index: m.index });
  }
  return out;
}

// 검사기 자체 회귀 1: 이어 붙인 두 번째 조각을 못 읽으면 즉시 RED.
// 이 형태가 바로 live_orders.strategy_id 운영 장애를 25일 놓친 모양이다.
{
  const probe = selectCallsOf(
    "sb.from('live_orders').select('id, signal_id, ' + 'strategy_id')",
  );
  if (probe.length !== 1 || probe[0].projection !== 'id, signal_id, strategy_id') {
    err('DB 칼럼 검사기가 이어 붙인 select projection을 끝까지 읽지 못합니다');
  }
}

// 검사기 자체 회귀 2: select 옵션의 문자열을 칼럼명에 붙이면 안 된다.
// .select('id', { count: 'exact' })가 'idexact'로 읽히면 검사기가 거짓 RED를 낸다.
{
  const probe = selectCallsOf(
    "sb.from('live_orders').select('id', { count: 'exact', head: true })",
  );
  if (probe.length !== 1 || probe[0].projection !== 'id') {
    err('DB 칼럼 검사기가 select 옵션 문자열을 projection으로 오인합니다');
  }
}

let checked = 0;
for (const f of codeFiles) {
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  if (!src.includes('.from(')) continue;

  for (const q of selectCallsOf(src)) {
    const table = q.table.toLowerCase();
    const known = columns.get(table);
    if (!known) continue;                 // 워커가 만드는 표 등 — 여기서 판단하지 않는다
    const line = src.slice(0, q.index).split('\n').length;
    for (const raw of q.projection.split(',')) {
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

// ── 3. 마이그레이션이 만들지 않는 표를 쓰고 있는가 ──
//
// **여기가 오래 비어 있던 구멍이다.**
//
// 위의 칸 대조는 `if (!known) continue`로 시작한다 — 마이그레이션에
// 없는 표는 칸 목록이 없으니 **아무 말 없이 넘어간다.** 그래서
// `audit_logs`를 열두 곳에서 쓰는데도 이 검사는 몇 달을 초록이었다.
// 그 표는 `schema.sql`에만 있고 마이그레이션 체인에는 없다.
//
// 확인하지 못한 것은 통과가 아니다. 그래서 이제:
//
//   · 체인이 만드는 표면 → 칸까지 대조한다 (위)
//   · 체인에 없고 **아래에 선언돼 있으면** → 이유와 함께 센다
//   · 체인에 없고 선언도 없으면 → **실패한다**
//
// 선언이 썩지 않게 **양방향으로** 본다: 더 이상 안 쓰는 표나, 그 뒤
// 체인에 들어온 표가 아래에 남아 있으면 그것도 실패다. 한쪽만 보면
// 이 목록은 아무도 지우지 않는 고무도장이 된다.
//
// 아래 일곱 개는 '괜찮다'는 뜻이 **아니다.** 이들은 `types.ts`에 있다 —
// 그 파일은 Management API로 **실제 DB에서 뽑았으므로**, 있다는 것은
// 운영 DB에 그 표가 실제로 있다는 증거다. 없다는 것은 증거가 아니다
// (그 파일은 체인의 표 76개 중 41개만 알고 있다 — 오래됐다).
//
// 그래서 남는 위험은 이쪽이다: **빈 DB에서 다시 세우면 이 일곱 개가
// 안 만들어진다.** Supabase Preview · 새 개발 환경 · 복구용 재구축이
// 전부 그 경우다. 체인에 올리는 것은 마이그레이션 추가라 승인 사항이다.
const OFF_CHAIN_TABLES = new Map([
  ['alerts',              'types.ts(실제 DB)에 있음 · 체인에 없음 — 빈 DB 재생에서 누락'],
  ['backtest_results',    'types.ts(실제 DB)에 있음 · 체인에 없음 — 빈 DB 재생에서 누락'],
  ['pnl_reports',         'types.ts(실제 DB)에 있음 · 체인에 없음 — 빈 DB 재생에서 누락'],
  ['portfolio_positions', 'types.ts(실제 DB)에 있음 · 체인에 없음 — 빈 DB 재생에서 누락'],
  ['trade_orders',        'types.ts(실제 DB)에 있음 · 체인에 없음 — 빈 DB 재생에서 누락'],
  ['trading_strategies',  'types.ts(실제 DB)에 있음 · 체인에 없음 — 빈 DB 재생에서 누락'],
  ['watchlists',          'types.ts(실제 DB)에 있음 · 체인에 없음 — 빈 DB 재생에서 누락'],
]);

// 체인이 만드는 **이름**. 칸을 못 뜨는 뷰도 존재는 한다.
const chainObjects = new Set(columns.keys());
for (const f of migFiles) {
  let sql = '';
  try { sql = readFileSync(f, 'utf8'); } catch { continue; }
  sql = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const names = [
    ...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi),
    ...sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi),
    ...sql.matchAll(/create\s+materialized\s+view\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi),
  ];
  for (const m of names) {
    chainObjects.add(String(m[1]).toLowerCase().replace(/^public\./, '').replace(/"/g, ''));
  }
}

// 코드가 부르는 표 전부. `.select`가 붙지 않은 insert·update·delete도 센다 —
// **쓰기만 하는 표가 바로 `audit_logs`가 숨어 있던 모양이다.** 위의 칸
// 대조는 `.select`가 붙은 자리만 보므로 쓰기 전용 표를 영원히 못 본다.
function tablesIn(src) {
  const out = [];
  for (const m of src.matchAll(/\.from\(\s*['"]([a-z0-9_]+)['"]\s*\)/gi)) {
    out.push({ table: m[1].toLowerCase(), index: m.index });
  }
  return out;
}

// 검사기 자체 회귀 3: **쓰기 전용 호출을 놓치면 즉시 RED.**
// 이 구멍이 `audit_logs`를 열두 곳에서 몇 달 동안 가렸다 — 칸 대조는
// `.select`만 보고, 표 존재 확인은 아예 없었다.
{
  const probe = tablesIn(
    "await sb.from('audit_logs').insert({ a: 1 });\n"
    + "await (sb.from('live_orders') as any).update({ b: 2 });\n"
    + "await sb.from('profiles').delete().eq('id', x);",
  ).map(x => x.table);
  const want = ['audit_logs', 'live_orders', 'profiles'];
  if (probe.length !== 3 || want.some((w, i) => probe[i] !== w)) {
    err(`DB 칼럼 검사기가 쓰기 전용 .from() 호출을 다 읽지 못합니다 — 읽은 것: ${probe.join(', ')}`);
  }
}

const usedTables = new Map();   // table -> Set(file:line)
for (const f of codeFiles) {
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  if (!src.includes('.from(')) continue;
  for (const { table, index } of tablesIn(src)) {
    const line = src.slice(0, index).split('\n').length;
    if (!usedTables.has(table)) usedTables.set(table, new Set());
    usedTables.get(table).add(`${f}:${line}`);
  }
}

const offChain = [];
for (const [t, where] of usedTables) {
  if (chainObjects.has(t)) continue;
  if (OFF_CHAIN_TABLES.has(t)) { offChain.push(t); continue; }
  err(`${[...where][0]}\n     '${t}' 표를 쓰는데 마이그레이션이 그 표를 만들지 않습니다`
    + `\n     쓰는 곳 ${where.size}군데: ${[...where].slice(0, 4).join(' · ')}${where.size > 4 ? ' …' : ''}`
    + '\n     체인에 올리거나, 있는 표로 돌리거나, 이유를 OFF_CHAIN_TABLES에 적으세요'
    + '\n     조회 오류를 안 받으면 이 실수는 "0건"으로 조용히 끝납니다');
}

// 선언이 썩는 것을 막는다. 둘 다 실패여야 한다 — 안 그러면 아무도 지우지 않는다.
for (const [t, why] of OFF_CHAIN_TABLES) {
  if (chainObjects.has(t)) {
    err(`OFF_CHAIN_TABLES의 '${t}'는 이제 마이그레이션이 만듭니다 — 목록에서 지우세요 (${why})`);
  } else if (!usedTables.has(t)) {
    err(`OFF_CHAIN_TABLES의 '${t}'를 코드가 더 이상 쓰지 않습니다 — 목록에서 지우세요 (${why})`);
  }
}

if (bad === 0) {
  console.log(`✅ 표 ${columns.size}개 · 대조한 칸 ${checked}개 · 없는 칸 참조 0건`);
  if (offChain.length) {
    console.log(`⚠️  빈 DB 재생에서 누락 — 마이그레이션이 만들지 않는 표 ${offChain.length}개를 코드가 씁니다`);
    for (const t of offChain.sort()) {
      console.log(`   · ${t} — ${OFF_CHAIN_TABLES.get(t)} (${usedTables.get(t).size}곳)`);
    }
    console.log('   운영 DB에는 있습니다(types.ts가 실제 DB에서 뽑힌 증거) — 없는 것은 빈 DB에서 다시 세울 때입니다');
    console.log('   체인에 올리는 것은 마이그레이션 추가라 승인 사항입니다');
  }
} else {
  console.error('');
  console.error('   기능이 있고 테스트가 통과해도, 칸 이름 하나가 틀리면 실제로는 한 건도 안 됩니다.');
}
process.exit(bad ? 1 : 0);
