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
const ACC_FILE = 'supabase/migrations/085_paper_challenge_accounting.sql';
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

// ── ②-b 사유 자체가 바뀌지 않는가 (이전 값을 보는 자리) ──
//
// 위의 CHECK는 **마감할 때** 결론이 사유와 같은지만 본다. 행 단위 CHECK는
// 이전 값을 볼 수 없으므로, 아직 terminal_status가 NULL인 CLOSING 중에
// `UPDATE ... SET close_intent='FAILED'`는 그냥 통과한다. 그 뒤 같은 값으로
// 마감하면 제약이 아무 말도 하지 않는다 — **달성이 조용히 실패가 된다.**
//
// 이전 값을 볼 수 있는 유일한 자리가 BEFORE UPDATE 트리거다.
const FREEZE_FN = 'public.paper_challenges_freeze_intent';
const FREEZE_TRG = 'paper_challenges_freeze_intent_trg';
{
  const flat = sql.replace(/\s+/g, ' ');

  const trg = new RegExp(
    `CREATE TRIGGER ${FREEZE_TRG} BEFORE UPDATE ON public\\.paper_challenges FOR EACH ROW `
    + `EXECUTE FUNCTION ${FREEZE_FN.replace('.', '\\.')}\\(\\)`, 'i');
  if (!trg.test(flat)) {
    err(`${SQL_FILE}: 사유를 얼리는 BEFORE UPDATE 트리거(${FREEZE_TRG})가 없습니다 `
      + `— CHECK만으로는 CLOSING 중 close_intent 덮어쓰기를 막지 못합니다 `
      + `(TARGET_REACHED가 FAILED로 바뀝니다)`);
  }

  const at = sql.search(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${FREEZE_FN.replace('.', '\\.')}`, 'i'));
  if (at < 0) {
    err(`${SQL_FILE}: ${FREEZE_FN}() 정의가 없습니다`);
  } else {
    const body = sql.slice(at, sql.indexOf('$fn$;', at) + 5);
    // **이전 값과 비교해야** 불변이 된다. NEW만 보면 아무것도 막지 못한다.
    for (const [what, col] of [['사유', 'close_intent'], ['판정 시각', 'close_intent_event_at']]) {
      const ok = new RegExp(`OLD\\.${col}\\b[\\s\\S]*?NEW\\.${col}\\b`, 'i').test(body);
      if (!ok) {
        err(`${SQL_FILE}: ${FREEZE_FN}()이 ${what}(${col})의 이전 값과 새 값을 비교하지 않습니다 `
          + `— 비교하지 않으면 트리거가 붙어 있어도 아무것도 얼지 않습니다`);
      }
    }
    // 처음 정하는 것까지 막으면 사유를 아예 정할 수 없다.
    if (!/OLD\.close_intent\s+IS\s+NOT\s+NULL/i.test(body)) {
      err(`${SQL_FILE}: ${FREEZE_FN}()이 "이미 정해져 있을 때만" 막는지 확인할 수 없습니다 `
        + `— NULL에서 처음 정하는 것은 허용돼야 합니다`);
    }
    // 이 트리거는 회계를 하지 않는다. 돈을 만지기 시작하면 PR2 범위다.
    if (/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)\b/i.test(body)) {
      err(`${SQL_FILE}: ${FREEZE_FN}()이 다른 표에 씁니다 — 이 트리거는 거부만 합니다`);
    }
  }
  if (bad === 0) notes.push('사유와 판정 시각을 BEFORE UPDATE 트리거가 얼린다');
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

// ★ **돈 사건은 이 챌린지의 전용 계좌에만 붙는다.**
//
// `(challenge_id, user_id)`와 `(paper_account_id, user_id)`는 각각 "챌린지가
// 내 것인가"와 "계좌가 내 것인가"만 본다. 둘 다 만족하면서 계좌가 이 챌린지의
// 전용 계좌가 **아닐** 수 있다 — 같은 사용자의 다른 모의 계좌를 이 챌린지
// 원장에 적을 수 있다는 뜻이다. 그러면 원장은 이 챌린지 것인데 돈은 다른
// 계좌에 있고, SUM(amount) = balance가 조용히 깨진다.
{
  const bind = /FOREIGN\s+KEY\s*\(\s*challenge_id\s*,\s*paper_account_id\s*\)\s*REFERENCES\s+public\.paper_challenges\s*\(\s*id\s*,\s*paper_account_id\s*\)/i;
  if (!bind.test(sql)) {
    err(`${SQL_FILE}: 돈 사건의 계좌를 챌린지의 전용 계좌에 묶는 복합 외래키가 없습니다 `
      + `— 같은 사용자의 다른 모의 계좌를 이 챌린지 원장에 적을 수 있습니다`);
  } else if (!/UNIQUE\s*\(\s*id\s*,\s*paper_account_id\s*\)/i.test(sql)) {
    err(`${SQL_FILE}: paper_challenges에 UNIQUE (id, paper_account_id)가 없습니다 `
      + `— 위 복합 외래키가 가리킬 정본이 없습니다`);
  } else {
    notes.push('돈 사건이 챌린지의 전용 계좌에만 붙는다');
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
    { re: /UPDATE\s+public\.paper_accounts/i, why: '잔고 변경 — Money Authority는 PR2의 회계 경로가 만집니다' },
    { re: /INSERT\s+INTO\s+public\.paper_challenge_cashflows/i, why: '시작금 적용 — PR2입니다' },
  ];
  for (const o of OUT_OF_SCOPE) {
    if (o.re.test(sql)) err(`${SQL_FILE}: 이 마이그레이션의 범위를 넘습니다 — ${o.why}`);
  }

  // 함수와 트리거는 **이름을 세어서** 허용한다.
  //
  // 처음에는 `CREATE FUNCTION`을 통째로 금지했다. 그런데 사유를 얼리려면
  // 이전 값을 봐야 하고, 그것은 트리거로만 된다. 그렇다고 금지를 풀면
  // 회계 RPC가 이 파일로 들어올 길이 열린다 — 그래서 **딱 그 하나만**
  // 허용하고 나머지는 전부 막는다.
  const named = (kind, re) => [...sql.matchAll(re)].map(m => m[1]);
  const fns = named('함수', /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z0-9_.]+)/gi);
  const trgs = named('트리거', /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+([A-Za-z0-9_]+)/gi);
  for (const f of fns) {
    if (f.toLowerCase() !== FREEZE_FN) {
      err(`${SQL_FILE}: 이 마이그레이션의 범위를 넘습니다 — 함수 ${f}(). `
        + `여기서 허용되는 함수는 사유를 얼리는 ${FREEZE_FN}() 하나뿐이고, `
        + `회계 RPC는 PR2입니다`);
    }
  }
  for (const t of trgs) {
    if (t.toLowerCase() !== FREEZE_TRG) {
      err(`${SQL_FILE}: 이 마이그레이션의 범위를 넘습니다 — 트리거 ${t}. `
        + `여기서 허용되는 트리거는 ${FREEZE_TRG} 하나뿐이고, 자동 회계는 PR2입니다`);
    }
  }
  if (fns.length > 1 || trgs.length > 1) {
    err(`${SQL_FILE}: 함수 ${fns.length}개 · 트리거 ${trgs.length}개 — 각각 하나여야 합니다`);
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

// ── ⑩ 회계 경로(085)와 도메인 모듈이 같은 것을 말하는가 ──
//
// **판정이 두 곳에 있으면 언젠가 갈린다.**
//
// `085`는 회계를 plpgsql로 구현한다. plpgsql은 `cashflowSignOk`나
// `cashflowIdempotencyKey`를 부를 수 없으므로, 이 도메인 모듈은 PR2에서
// "부르는 관계"가 될 수 없다 — 같은 규칙을 **두 언어로 두 번** 적은 상태다.
// 화면·API(PR4)가 이 모듈을 쓰기 시작할 때, 둘이 이미 갈려 있으면 사용자는
// DB가 거부하는 값을 보내거나 그 반대가 된다.
//
// 그래서 부르는 관계 대신 **대조되는 관계**로 묶는다. 아래 검사는 085가 실제로
// 쓰는 값과 이 모듈이 말하는 값이 어긋나면 멈춘다.
if (existsSync(join(root, ACC_FILE))) {
  const accRaw = readFileSync(join(root, ACC_FILE), 'utf8');
  const acc = stripSqlComments(accRaw);

  // (1) 085가 원장에 적는 현금흐름 종류가 모듈 목록 안에 있는가.
  //
  //     085는 `paper_money_apply(..., 'TRADING_FEE', ...)`처럼 종류를 문자열로
  //     넘긴다. 목록에 없는 종류를 쓰면 083의 CHECK가 실행 시점에 거부한다.
  const used = new Set();
  for (const m of acc.matchAll(/paper_money_apply\s*\(([^;]*?)\)/gs)) {
    for (const lit of m[1].matchAll(/'([A-Z_]+)'/g)) {
      if (D.CASHFLOW_TYPES.indexOf(lit[1]) >= 0
          || D.SOURCE_EVENT_TYPES.indexOf(lit[1]) >= 0) continue;
      used.add(lit[1]);
    }
  }
  if (used.size > 0) {
    err(`${ACC_FILE}이 ${TS_FILE}의 목록에 없는 낱말을 원장에 적습니다 `
      + `[${[...used].join(', ')}] — 083의 CHECK가 실행 시점에 거부합니다`);
  } else {
    notes.push('085가 원장에 적는 낱말이 전부 도메인 목록 안에 있다');
  }

  // (2) 085가 넘기는 **부호**가 cashflowSignOk와 같은가.
  //
  //     수수료를 양수로 적으면 원장 합계가 잔고와 갈린다. 모듈은 TRADING_FEE가
  //     0 이하라고 말한다 — 085가 실제로 음수를 넘기는지 본다.
  const feeCalls = [...acc.matchAll(/'TRADING_FEE'\s*,\s*(-?)\s*p_(\w+)/g)];
  if (feeCalls.length === 0) {
    err(`${ACC_FILE}: TRADING_FEE를 적는 자리를 찾지 못했습니다 `
      + `— 부호 계약을 확인할 수 없으면 통과로 적지 않습니다`);
  } else {
    // 모듈이 말하는 부호 계약을 **컴파일된 함수에 물어본다.** 글자로 베끼지 않는다.
    const wantsNegative = D.cashflowSignOk('TRADING_FEE', -1) && !D.cashflowSignOk('TRADING_FEE', 1);
    const allNegative = feeCalls.every(([, sign]) => sign === '-');
    if (wantsNegative && !allNegative) {
      err(`${ACC_FILE}이 TRADING_FEE를 양수로 적는 자리가 있습니다 `
        + `— ${TS_FILE}의 cashflowSignOk는 0 이하만 허용합니다. `
        + `양수로 적으면 SUM(원장)이 잔고와 갈립니다`);
    } else if (!wantsNegative) {
      err(`${TS_FILE}: cashflowSignOk가 TRADING_FEE의 음수 계약을 말하지 않습니다 `
        + `— 085는 음수로 적고 있습니다`);
    } else {
      notes.push(`085의 TRADING_FEE ${feeCalls.length}곳이 전부 음수다 (모듈 계약과 같다)`);
    }
  }

  // (3) 시작금은 양수인가. 모듈은 INITIAL_DEPOSIT이 0보다 크다고 말한다.
  {
    const initCalls = [...acc.matchAll(/'INITIAL_DEPOSIT'\s*,\s*(-?)\s*p_(\w+)/g)];
    if (initCalls.length === 0) {
      err(`${ACC_FILE}: INITIAL_DEPOSIT을 적는 자리를 찾지 못했습니다`);
    } else if (initCalls.some(([, sign]) => sign === '-')) {
      err(`${ACC_FILE}이 INITIAL_DEPOSIT을 음수로 적습니다 `
        + `— ${TS_FILE}의 cashflowSignOk는 0보다 큰 값만 허용합니다`);
    } else if (!D.cashflowSignOk('INITIAL_DEPOSIT', 1) || D.cashflowSignOk('INITIAL_DEPOSIT', -1)) {
      err(`${TS_FILE}: cashflowSignOk가 INITIAL_DEPOSIT의 양수 계약을 말하지 않습니다`);
    } else {
      notes.push('085의 시작금이 양수다 (모듈 계약과 같다)');
    }
  }

  // (4) 멱등 키가 **같은 네 칸**인가.
  //
  //     085는 `ON CONFLICT ON CONSTRAINT <이름>`으로 083의 제약을 이름으로
  //     가리킨다. 제약 이름이 바뀌면 085는 실행 시점에 터진다 — 그리고
  //     `cashflowIdempotencyKey`가 세는 칸도 그 제약과 같아야 한다.
  const CONSTRAINT = 'paper_challenge_cashflows_idem_key';
  if (!new RegExp(`ON\\s+CONFLICT\\s+ON\\s+CONSTRAINT\\s+${CONSTRAINT}\\b`, 'i').test(acc)) {
    err(`${ACC_FILE}이 ${CONSTRAINT}를 ON CONFLICT로 가리키지 않습니다 `
      + `— 이름이 어긋나면 원장 멱등이 실행 시점에 사라집니다`);
  } else if (!new RegExp(`CONSTRAINT\\s+${CONSTRAINT}\\s*\\n?\\s*UNIQUE`, 'i').test(sql)) {
    err(`${SQL_FILE}에 ${CONSTRAINT} 유니크가 없습니다 — 085가 없는 제약을 가리킵니다`);
  } else {
    // 제약의 칸 목록과 모듈의 키 구성이 같은가. 키를 글자로 베끼지 않고,
    // **컴파일된 함수가 만든 키에 각 값이 들어 있는지**로 확인한다.
    //
    // `inSetAfter`는 `CHECK (x IN (...))`의 낱말 목록을 읽는 도구다. 여기서
    // 쓰면 뒤에 나오는 엉뚱한 IN 목록을 잡는다 — 실제로 현금흐름 종류 목록을
    // 칸 목록으로 읽었다. 그래서 UNIQUE의 괄호를 직접 읽는다.
    const uq = new RegExp(
      `ADD\\s+CONSTRAINT\\s+${CONSTRAINT}\\s+UNIQUE\\s*\\(([^)]*)\\)`, 'i').exec(sql);
    const cols = uq ? uq[1].split(',').map((c) => c.trim()).filter(Boolean) : null;
    const want = ['challenge_id', 'cashflow_type', 'source_event_type', 'source_event_id'];
    if (!sameSet(cols, want)) {
      err(`${SQL_FILE}: ${CONSTRAINT}의 칸이 [${(cols || []).join(', ')}]입니다 `
        + `— 멱등 키는 [${want.join(', ')}] 네 칸이어야 합니다`);
    } else {
      const key = D.cashflowIdempotencyKey({
        challengeId: 'CH', cashflowType: 'TRADING_FEE',
        sourceEventType: 'POSITION_OPEN', sourceEventId: 'EV',
      });
      const missing = ['CH', 'TRADING_FEE', 'POSITION_OPEN', 'EV'].filter((v) => !key.includes(v));
      if (missing.length > 0) {
        err(`${TS_FILE}: cashflowIdempotencyKey가 [${missing.join(', ')}]를 키에 넣지 않습니다 `
          + `— ${CONSTRAINT}는 그 칸들로 중복을 막습니다. 키가 더 느슨하면 `
          + `서로 다른 사건이 같은 키가 되고, 한 체결의 두 줄 중 하나가 사라집니다`);
      } else {
        notes.push('멱등 키가 083 제약·085 ON CONFLICT·도메인 함수에서 같은 네 칸이다');
      }
    }
  }

  // (5) 달성 사유를 되돌리지 않는다는 계약이 모듈과 085에서 같은가.
  //
  //     모듈의 freezeCloseIntent는 "이미 정해진 사유는 바뀌지 않는다"를 말한다.
  //     085의 판정 함수도 같은 것을 해야 한다 — CAS로 한 번만 정한다.
  {
    const frozen = D.freezeCloseIntent('TARGET_REACHED', 'FAILED');
    if (!frozen || frozen.intent !== 'TARGET_REACHED' || frozen.frozen !== true) {
      err(`${TS_FILE}: freezeCloseIntent가 TARGET_REACHED를 지키지 않습니다`);
    } else if (!/AND\s+c\.close_intent\s+IS\s+NULL/i.test(acc)) {
      err(`${ACC_FILE}: 판정이 close_intent IS NULL을 CAS 조건으로 걸지 않습니다 `
        + `— ${TS_FILE}은 사유가 한 번만 정해진다고 말합니다. `
        + `조건이 없으면 뒤늦은 판정이 달성을 실패로 덮어씁니다`);
    } else {
      notes.push('사유를 한 번만 정한다는 계약이 모듈·085에서 같다');
    }
  }
} else {
  // **없는 것을 통과로 적지 않는다.** 085가 사라졌으면 회계 경로가 없어진 것이다.
  err(`${ACC_FILE}을 찾지 못했습니다 — 챌린지 회계 경로의 정본입니다`);
}

if (bad === 0) {
  console.log('챌린지 스키마·도메인 확인');
  for (const n of notes) console.log(`  · ${n}`);
  console.log('통과');
}
process.exit(bad ? 1 : 0);
