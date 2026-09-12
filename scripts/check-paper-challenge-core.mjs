#!/usr/bin/env node
// scripts/check-paper-challenge-core.mjs
//
// **챌린지의 낱말이 SQL과 TS에서 갈리지 않는다.**
//
// 무엇을 막는가
// ─────────────
// 이 저장소가 반복해서 겪은 고장 두 가지가 여기 다 걸린다.
//
//   ① 만들어 놓고 배선을 안 함
//      `083`이 표와 제약을 만들었는데 코드가 그 목록을 모르면, 나중에 쓰는
//      쪽이 제 마음대로 문자열을 만든다.
//
//   ② 경로가 둘인데 한쪽만 고침
//      상태·사유·현금흐름 종류가 SQL의 CHECK와 `paperChallenge.ts`에 따로
//      적혀 있다. 하나가 늘 때 한쪽만 늘면, DB가 거부하는 값을 코드가
//      만들거나(런타임 폭발) 코드가 모르는 값을 DB가 받는다(조용한 오염).
//
// 그래서 **판정 로직을 베끼지 않는다.** `paperChallenge.ts`를 프로젝트 tsc로
// 컴파일해서 그 목록을 그대로 읽고, `083`의 CHECK가 같은 집합인지 본다
// (`gen-migration-manifest.mjs`의 `loadPlan()`과 같은 방식이다).
//
// 시험이 잡지 못하는 것
// ─────────────────────
// 시험은 `src`를 임시 디렉터리로 복사해서 돌기 때문에 `supabase/migrations`를
// **읽을 수 없다.** SQL 쪽 절반은 여기서만 볼 수 있다.
//
// 실제 Postgres가 정말로 거부하는가는 supabase-replay의 제약 시험이 본다.
// 여기는 정적 검사다 — 둘 다 필요하다.

import { readFileSync, existsSync, mkdtempSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SQL_FILE = 'supabase/migrations/083_paper_challenge_core.sql';
const TS_FILE = 'src/lib/engine/paperChallenge.ts';

let bad = 0;
const err = (m) => { console.error(`::error::${m}`); bad += 1; };
const notes = [];

if (!existsSync(join(root, SQL_FILE))) {
  err(`${SQL_FILE}을 찾지 못했습니다 — 챌린지 스키마의 정본입니다`);
  process.exit(1);
}
const raw = readFileSync(join(root, SQL_FILE), 'utf8');

/**
 * 주석을 걷어낸 **실행되는 SQL**.
 *
 * 왜 필요한가: 이 파일의 주석은 "왜 `UNIQUE (challenge_id, to_status)`를 두지
 * 않는가"처럼 **하지 않기로 한 것**을 설명한다. 주석까지 훑으면 검사기가
 * 그 설명을 제약으로 읽고 엉뚱한 곳에서 멈춘다 — 실제로 그렇게 한 번 멈췄다.
 * 구조 검사는 전부 이 값으로 한다. 주석 자체를 확인하는 검사만 원문을 쓴다.
 *
 * 따옴표 안의 `--`는 주석이 아니다. 홑따옴표 짝을 세면서 지운다.
 */
function stripSqlComments(src) {
  return src.split('\n').map((line) => {
    let q = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "'") { q = !q; continue; }
      if (!q && line[i] === '-' && line[i + 1] === '-') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

const sql = stripSqlComments(raw);

// ── TS 목록을 컴파일해서 그대로 읽는다 (베끼지 않는다) ──
async function loadDomain() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-chal-'));
  cpSync(join(root, TS_FILE), join(dir, 'paperChallenge.ts'));
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error(`TypeScript를 찾을 수 없습니다: ${tsc} — 먼저 npm install`);
  execFileSync(process.execPath, [tsc, 'paperChallenge.ts', '--module', 'commonjs',
    '--target', 'es2019', '--skipLibCheck'], { cwd: dir, stdio: 'pipe' });
  return await import(`file://${join(dir, 'paperChallenge.js')}`);
}

const D = await loadDomain();

/** `... IN ('A', 'B')`에서 집합을 꺼낸다. 이름이 아니라 **제약 본문**을 본다. */
function inSetAfter(haystack, anchor) {
  const at = haystack.indexOf(anchor);
  if (at < 0) return null;
  const m = haystack.slice(at).match(/\bIN\s*\(([^)]*)\)/i);
  if (!m) return null;
  const vals = m[1].match(/'([^']*)'/g);
  return vals ? vals.map(v => v.slice(1, -1)) : null;
}

const sameSet = (a, b) =>
  Array.isArray(a) && Array.isArray(b)
  && a.length === b.length
  && [...a].sort().join('|') === [...b].sort().join('|');

function compareSet(label, anchor, expected) {
  const got = inSetAfter(sql, anchor);
  if (got == null) {
    err(`${SQL_FILE}: ${label} 제약(${anchor})에서 허용 목록을 찾지 못했습니다`);
    return;
  }
  if (!sameSet(got, expected)) {
    err(`${label}이 SQL과 TS에서 다릅니다 `
      + `— SQL [${got.join(', ')}] / ${TS_FILE} [${expected.join(', ')}]. `
      + `한쪽만 고치면 DB가 거부하는 값을 코드가 만들거나 그 반대가 됩니다`);
    return;
  }
  notes.push(`${label} ${got.length}종이 SQL·TS에서 같다`);
}

// ── ① 낱말이 같은가 ──
compareSet('상태', 'paper_challenges_status_chk', D.CHALLENGE_STATUSES);
compareSet('종료 사유', 'paper_challenges_intent_chk', D.CLOSE_INTENTS);
compareSet('현금흐름 종류', 'paper_challenge_cashflows_type_chk', D.CASHFLOW_TYPES);
compareSet('현금흐름 원인', 'paper_challenge_cashflows_source_chk', D.SOURCE_EVENT_TYPES);
compareSet('전이 기록의 상태', 'paper_challenge_transitions_status_chk', D.CHALLENGE_STATUSES);

// **활성 집합**은 부분 유니크 인덱스의 WHERE와 같아야 한다. 한쪽만 늘면
// "활성이 둘"이 조용히 가능해지거나, 끝난 챌린지가 새 챌린지를 막는다.
compareSet('활성 상태', 'paper_challenges_one_active_per_user', D.ACTIVE_CHALLENGE_STATUSES);

// ── ② TARGET_REACHED 불가역을 DB가 강제하는가 ──
//
// 코드 규율만으로는 부족하다. finalizer가 마지막 잔고를 보고 사유를 다시
// 판단하면 달성이 실패로 뒤집힌다. 제약이 그것을 거부해야 한다.
{
  const ok = /CHECK\s*\(\s*terminal_status\s+IS\s+NULL\s+OR\s+terminal_status\s*=\s*close_intent\s*\)/i.test(sql);
  if (!ok) {
    err(`${SQL_FILE}: terminal_status가 close_intent와 같아야 한다는 CHECK가 없습니다 `
      + `— 목표 달성이 정리 중 손실로 실패로 뒤집힐 수 있습니다`);
  } else {
    notes.push('TARGET_REACHED 불가역을 DB가 강제한다 (terminal_status = close_intent)');
  }

  // 끝났다는 것과 결론이 적혔다는 것은 같은 사실이다.
  if (!/CHECK\s*\(\s*\(\s*status\s*=\s*'CLOSED'\s*\)\s*=\s*\(\s*terminal_status\s+IS\s+NOT\s+NULL\s*\)\s*\)/i.test(sql)) {
    err(`${SQL_FILE}: CLOSED와 terminal_status가 짝을 이룬다는 CHECK가 없습니다`);
  }

  // CLOSING에 들어갔다는 것은 사유가 이미 정해졌다는 뜻이다.
  if (!/CHECK\s*\(\s*status\s*<>\s*'CLOSING'\s+OR\s+close_intent\s+IS\s+NOT\s+NULL\s*\)/i.test(sql)) {
    err(`${SQL_FILE}: CLOSING에 사유가 있어야 한다는 CHECK가 없습니다 `
      + `— 왜 끝나는지 모른 채 정리에 들어갈 수 있습니다`);
  }
}

// ── ③ 판정 시각에 기본값을 두지 않았는가 ──
//
// `event_effective_at`에 DEFAULT가 붙으면 "이 일이 실제로 언제 일어났는가"를
// 아무도 적지 않게 되고, 행이 기록된 시각이 슬그머니 만료·목표 판정의 기준이
// 된다. 조용한 거짓이다.
for (const table of ['paper_challenge_cashflows', 'paper_challenge_transitions']) {
  const at = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`);
  if (at < 0) { err(`${SQL_FILE}: ${table} 표를 찾지 못했습니다`); continue; }
  const body = sql.slice(at, sql.indexOf(');', at));
  const line = body.split('\n').find(l => /^\s*event_effective_at\s/.test(l));
  if (!line) {
    err(`${SQL_FILE}: ${table}에 event_effective_at이 없습니다 — 판정 시각의 정본입니다`);
    continue;
  }
  if (!/NOT\s+NULL/i.test(line)) {
    err(`${SQL_FILE}: ${table}.event_effective_at이 NOT NULL이 아닙니다`);
  }
  if (/DEFAULT/i.test(line)) {
    err(`${SQL_FILE}: ${table}.event_effective_at에 DEFAULT가 있습니다 `
      + `— 기본값을 두면 기록 시각이 판정 기준이 됩니다. 부르는 쪽이 반드시 넣어야 합니다`);
  }
  // 기록 시각은 따로 있어야 한다. 하나로 합치면 둘을 구분할 수 없다.
  if (!/^\s*recorded_at\s/m.test(body)) {
    err(`${SQL_FILE}: ${table}에 recorded_at이 없습니다 — 판정 시각과 기록 시각을 나눠야 합니다`);
  }
}
if (bad === 0) notes.push('판정 시각(event_effective_at)에 DEFAULT가 없다');

// ── ④ 소유권을 DB가 강제하는가 ──
//
// 서비스 계층 검사 하나에 기대지 않는다. 복합 외래키가 "이 계좌가 이 사용자
// 것인가"를 DB에서 본다 — `081`이 포지션에 한 것과 같다.
const FKS = [
  { label: '챌린지 → 계좌 소유권',
    re: /FOREIGN\s+KEY\s*\(\s*paper_account_id\s*,\s*user_id\s*\)\s*REFERENCES\s+public\.paper_accounts\s*\(\s*id\s*,\s*user_id\s*\)/i,
    n: 2 },
  { label: '하위 표 → 챌린지 소유권',
    re: /FOREIGN\s+KEY\s*\(\s*challenge_id\s*,\s*user_id\s*\)\s*REFERENCES\s+public\.paper_challenges\s*\(\s*id\s*,\s*user_id\s*\)/i,
    n: 2 },
];
for (const f of FKS) {
  const hits = (sql.match(new RegExp(f.re.source, 'gi')) || []).length;
  if (hits < f.n) {
    err(`${SQL_FILE}: ${f.label} 복합 외래키가 ${f.n}개여야 하는데 ${hits}개입니다 `
      + `— 남의 계좌·남의 챌린지에 줄을 붙일 수 있습니다`);
  } else {
    notes.push(`${f.label} 복합 외래키 ${hits}개`);
  }
}

// 복합 외래키가 가리킬 정본.
if (!/UNIQUE\s*\(\s*id\s*,\s*user_id\s*\)/i.test(sql)) {
  err(`${SQL_FILE}: paper_challenges에 UNIQUE (id, user_id)가 없습니다 — 하위 표가 소유권을 가리킬 수 없습니다`);
}
// 챌린지 ↔ 전용 계좌는 1:1.
if (!/UNIQUE\s*\(\s*paper_account_id\s*\)/i.test(sql)) {
  err(`${SQL_FILE}: 한 계좌가 두 챌린지에 붙는 것을 막는 UNIQUE (paper_account_id)가 없습니다`);
}

// ── ⑤ 멱등 키 ──
//
// 유니크에 `cashflow_type`이 들어 있어야 **같은 체결 하나**가 REALIZED_PNL
// 한 줄과 TRADING_FEE 한 줄을 둘 다 남긴다. 체결 id 하나를 전역 키로 쓰면
// 둘 중 하나가 사라진다.
{
  const m = sql.match(/paper_challenge_cashflows_idem_key[\s\S]{0,200}?UNIQUE\s*\(([^)]*)\)/i);
  const cols = m ? m[1].split(',').map(s => s.trim()) : null;
  const want = ['challenge_id', 'cashflow_type', 'source_event_type', 'source_event_id'];
  if (!sameSet(cols, want)) {
    err(`${SQL_FILE}: 현금흐름 멱등 키가 [${want.join(', ')}]이 아닙니다 `
      + `— 실제 [${cols ? cols.join(', ') : '찾지 못함'}]. cashflow_type이 빠지면 `
      + `한 체결의 실현손익과 수수료 중 하나가 사라집니다`);
  } else {
    notes.push('현금흐름 멱등 키에 cashflow_type이 들어 있다');
  }
}

// **전이 기록에는 (challenge_id, to_status) 유니크를 두지 않는다.**
//
// 그것은 감사 로그에 제품 정책("어떤 상태에 한 번만 들어갈 수 있다")을
// 강제시키는 것이라 결합도가 너무 높다. finalizer 멱등은 챌린지 행의 CAS로
// 보장한다.
{
  const m = sql.match(/paper_challenge_transitions_idem_key[\s\S]{0,200}?UNIQUE\s*\(([^)]*)\)/i);
  const cols = m ? m[1].split(',').map(s => s.trim()) : null;
  if (!sameSet(cols, ['challenge_id', 'transition_key'])) {
    err(`${SQL_FILE}: 전이 기록의 멱등 키가 (challenge_id, transition_key)가 아닙니다 `
      + `— 실제 [${cols ? cols.join(', ') : '찾지 못함'}]`);
  }
  if (/UNIQUE\s*\(\s*challenge_id\s*,\s*to_status\s*\)/i.test(sql)) {
    err(`${SQL_FILE}: 전이 기록에 UNIQUE (challenge_id, to_status)가 있습니다 `
      + `— 감사 로그가 제품 상태 정책을 강제하게 됩니다. finalizer 멱등은 `
      + `챌린지 행의 CAS(WHERE status='CLOSING')로 보장하세요`);
  } else {
    notes.push('전이 기록이 제품 정책을 강제하지 않는다 (to_status 유니크 없음)');
  }
}

// ── ⑥ 부호 계약 ──
if (!/CHECK\s*\(\s*cashflow_type\s*<>\s*'TRADING_FEE'\s+OR\s+amount\s*<=\s*0\s*\)/i.test(sql)) {
  err(`${SQL_FILE}: 수수료가 음수라는 CHECK가 없습니다 — 양수로 적으면 수수료를 낼수록 잔고가 늡니다`);
}
if (!/CHECK\s*\(\s*cashflow_type\s*<>\s*'INITIAL_DEPOSIT'\s+OR\s+amount\s*>\s*0\s*\)/i.test(sql)) {
  err(`${SQL_FILE}: 시작금이 양수라는 CHECK가 없습니다`);
}

// REALIZED_PNL이 **수수료 차감 전 gross**라는 것은 구조로 표현되지 않는다.
// 그래서 주석에 남아 있는지 본다 — 없으면 다음 사람이 순액을 적고, 수수료가
// 두 번 빠져 SUM(amount) ≠ balance가 된다.
if (!/gross/i.test(raw) || !/REALIZED_PNL/.test(raw)) {
  err(`${SQL_FILE}: REALIZED_PNL이 수수료 차감 전 gross라는 설명이 없습니다 `
    + `— 순액을 적으면 수수료가 두 번 빠집니다`);
} else {
  notes.push('REALIZED_PNL = 수수료 차감 전 gross가 명시돼 있다');
}

// ── ⑦ RLS ──
//
// 돈에 닿는 표다. 브라우저가 직접 쓰는 길을 만들지 않는다.
for (const t of ['paper_challenges', 'paper_challenge_cashflows', 'paper_challenge_transitions']) {
  if (!new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`, 'i').test(sql)) {
    err(`${SQL_FILE}: ${t}에 RLS가 켜져 있지 않습니다`);
  }
  const owner = new RegExp(
    `CREATE POLICY ${t}_owner ON public\\.${t}\\s+FOR SELECT TO authenticated USING \\(user_id = auth\\.uid\\(\\)\\)`, 'i');
  if (!owner.test(sql.replace(/\s+/g, ' '))) {
    err(`${SQL_FILE}: ${t}의 소유자 정책이 'authenticated에게 SELECT만, 본인 행만'이 아닙니다`);
  }
}
// authenticated에게 쓰기를 열어 준 곳이 없어야 한다.
{
  const flat = sql.replace(/\s+/g, ' ');
  const writeToAuthed = /FOR (ALL|INSERT|UPDATE|DELETE) TO authenticated/i.test(flat);
  if (writeToAuthed) {
    err(`${SQL_FILE}: authenticated에게 쓰기 정책이 열려 있습니다 — 돈에 닿는 표는 service_role만 씁니다`);
  } else {
    notes.push('쓰기는 service_role만, 읽기는 본인 행만');
  }
}

// ── ⑧ 이 마이그레이션의 범위 ──
//
// PR1은 **표와 제약뿐이다.** 회계 RPC·시작금 적용·잔고 변경·finalizer는
// PR2·PR3이다. 여기에 섞여 들어오면 "스키마만 보는 리뷰"가 돈 경로를 통과시킨다.
{
  const OUT_OF_SCOPE = [
    { re: /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i, why: '함수 정의 — 회계 RPC는 PR2입니다' },
    { re: /CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i, why: '트리거 — 자동 회계는 PR2입니다' },
    { re: /UPDATE\s+public\.paper_accounts/i, why: '잔고 변경 — Money Authority는 PR2의 회계 경로가 만집니다' },
    { re: /INSERT\s+INTO\s+public\.paper_challenge_cashflows/i, why: '시작금 적용 — PR2입니다' },
  ];
  for (const o of OUT_OF_SCOPE) {
    if (o.re.test(sql)) err(`${SQL_FILE}: 이 마이그레이션의 범위를 넘습니다 — ${o.why}`);
  }
}

// ── ⑨ 도메인 모듈이 실제로 컴파일되고 목록이 비어 있지 않은가 ──
//
// 빈 배열끼리는 늘 "같은 집합"이다. 0개를 통과로 적지 않는다.
for (const [name, list] of [
  ['CHALLENGE_STATUSES', D.CHALLENGE_STATUSES],
  ['ACTIVE_CHALLENGE_STATUSES', D.ACTIVE_CHALLENGE_STATUSES],
  ['CLOSE_INTENTS', D.CLOSE_INTENTS],
  ['CASHFLOW_TYPES', D.CASHFLOW_TYPES],
  ['SOURCE_EVENT_TYPES', D.SOURCE_EVENT_TYPES],
]) {
  if (!Array.isArray(list) || list.length === 0) {
    err(`${TS_FILE}: ${name}이 비어 있습니다 — 빈 목록은 어떤 SQL과도 "같은 집합"이 됩니다`);
  }
}

if (bad === 0) {
  console.log('챌린지 스키마·도메인 확인');
  for (const n of notes) console.log(`  · ${n}`);
  console.log('통과');
}
process.exit(bad ? 1 : 0);
