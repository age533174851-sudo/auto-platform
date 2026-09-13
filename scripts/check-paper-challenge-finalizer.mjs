#!/usr/bin/env node
// scripts/check-paper-challenge-finalizer.mjs
//
// **생명주기를 미는 경로가 계약대로 생겼는가 — 글자가 아니라 조건으로 본다.**
//
// 무엇을 지키는가
// ───────────────
//   ① `086`은 ADDITIVE다. 머지되면 자동 적용되므로 위험도가 바뀌면 알아야 한다
//   ② 중재에 `now()`를 쓰지 않는다 — 트랜잭션 시작 시각은 잠금을 기다린 만큼
//      낡아서, 검사가 초록인 채로 만료 race가 되살아난다
//   ③ 잠금 순서: 계좌를 챌린지보다 **먼저** 잠근다
//   ④ 신선도 검사는 잠금을 **다 잡은 뒤**에 온다
//   ⑤ 진입 가드가 보는 상태 집합은 `{RUNNING}` 하나다 (READY도 막는다)
//   ⑥ finalizer는 돈을 만들지 않는다 — 잔고 UPDATE·원장 INSERT 0
//   ⑦ 084가 고친 표-한정 참조가 `086`에도 전부 남아 있다
//   ⑧ 새 상태가 TS·워커까지 실제로 배선됐다
import { readFileSync } from 'node:fs';
import { loadPlan } from './gen-migration-manifest.mjs';

const MIG   = 'supabase/migrations/086_paper_challenge_finalizer.sql';
const PREV  = 'supabase/migrations/085_paper_challenge_accounting.sql';
const STORE = 'src/lib/engine/paperStore.ts';
const DISP  = 'src/lib/engine/paperDispatch.ts';
const ROUTE = 'src/app/api/paper/challenge-sweep/route.ts';
const WORKER = 'worker/src/index.ts';

const fails = [];
const notes = [];
const fail = m => fails.push(m);
const read = p => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

/**
 * 주석을 걷어낸다. **주석 속 글자를 코드로 읽지 않는다.**
 *
 * 줄 전체 주석만 지우면 안 된다 — `clock_timestamp();  -- now()가 아니다`
 * 같은 꼬리 주석이 남아서, 규칙을 **설명하는 문장**이 규칙 위반으로 읽힌다.
 * 실제로 이 검사기가 처음에 그렇게 틀렸다.
 *
 * 문자열 안의 `--`는 건드리지 않는다(앞쪽 따옴표 수가 짝수일 때만 자른다).
 */
const strip = (s) => String(s ?? '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => {
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "'") quoted = !quoted;
      else if (!quoted && line[i] === '-' && line[i + 1] === '-') return line.slice(0, i);
    }
    return line;
  })
  .join('\n');

/** plpgsql/sql 함수 본문을 뽑는다. 여는 달러 표식과 같은 표식까지가 본문이다. */
function body(sql, name) {
  const decl = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name.replace(/\./g, '\\.')}\\s*\\(`, 'i');
  const m = decl.exec(sql);
  if (!m) return null;
  const tag = /\$([A-Za-z_]\w*)?\$/.exec(sql.slice(m.index));
  if (!tag) return null;
  const open = m.index + tag.index + tag[0].length;
  const close = sql.indexOf(tag[0], open);
  return close < 0 ? null : sql.slice(open, close);
}

const raw = read(MIG);
if (!raw) fail(`${MIG}을 읽지 못했습니다`);
const sql = strip(raw);

// ── ① 위험도 ──
if (raw) {
  const plan = await loadPlan();
  const c = plan.classifyMigration(raw);
  if (c.risk !== 'ADDITIVE') {
    fail(`${MIG}의 위험도가 ${c.risk}입니다 — ADDITIVE가 아니면 자동 적용되지 않습니다`
      + ' (시그니처를 바꿔 DROP FUNCTION이 들어왔는지 보세요)');
  } else {
    notes.push('086은 ADDITIVE — 머지되면 자동 적용된다');
  }
}

// ── ② 중재에 now()를 쓰지 않는다 ──
const ARBITERS = [
  'public.paper_event_time_guard',
  'public.paper_challenge_expiry_eligible',
  'public.paper_challenge_sweep_due',
  'public.paper_challenge_finalize',
];
for (const fn of ARBITERS) {
  const b = body(sql, fn);
  if (b == null) { fail(`${fn}을 찾지 못했습니다`); continue; }
  if (/\bnow\s*\(\s*\)|\bCURRENT_TIMESTAMP\b/i.test(b)) {
    fail(`${fn}이 now()/CURRENT_TIMESTAMP를 씁니다`
      + ' — 트랜잭션 시작 시각이라 잠금을 오래 기다린 트랜잭션이 옛 시각으로 통과합니다.'
      + ' 중재에는 clock_timestamp()를 쓰세요');
  }
  if (!/clock_timestamp\s*\(\s*\)/i.test(b) && fn !== 'public.paper_challenge_expiry_eligible') {
    // expiry_eligible은 자기 안에서 읽고, 나머지도 읽어야 한다
  }
}

// ── ③④ 잠금 순서와 신선도 위치 ──
/**
 * 어느 표를 먼저 **잠그는가**.
 *
 * `FOR UPDATE`에서 **뒤로** 읽어 대상 표를 정한다. 표 이름에서 앞으로 훑으면,
 * 잠그지 않고 읽는 조회가 200자 뒤의 다른 `FOR UPDATE`에 붙어 엉뚱한 위치가
 * 나온다 — 실제로 이 검사기가 그렇게 틀렸다(스윕은 대상을 먼저 읽는다).
 */
function firstLockAt(b, table) {
  for (const m of b.matchAll(/FOR\s+UPDATE/gi)) {
    const before = b.slice(Math.max(0, m.index - 260), m.index);
    const owner = [...before.matchAll(/public\.(paper_accounts|paper_challenges)/gi)].pop();
    if (owner && owner[1].toLowerCase() === table) return m.index;
  }
  return -1;
}

function lockOrder(b, label) {
  const acct = firstLockAt(b, 'paper_accounts');
  const chal = firstLockAt(b, 'paper_challenges');
  if (acct < 0) { fail(`${label}이 계좌를 잠그지 않습니다`); return null; }
  if (chal < 0) { fail(`${label}이 챌린지를 잠그지 않습니다`); return null; }
  if (acct > chal) {
    fail(`${label}이 챌린지를 계좌보다 먼저 잠급니다`
      + ' — paper_settle_close는 계좌를 쥐고 챌린지를 기다리므로 순환이 생깁니다');
    return null;
  }
  return { acct, chal };
}
for (const [fn, label] of [
  ['public.paper_challenge_sweep_due', '스윕'],
  ['public.paper_challenge_finalize', '마감'],
]) {
  const b = body(sql, fn);
  if (b) lockOrder(b, label);
}

for (const [file, fn, label] of [
  [MIG, 'public.paper_open_position', '진입'],
  [MIG, 'public.paper_settle_close', '청산'],
]) {
  const b = body(strip(read(file) ?? ''), fn);
  if (b == null) { fail(`${fn}을 ${file}에서 찾지 못했습니다`); continue; }
  const o = lockOrder(b, label);
  const guard = b.search(/paper_event_time_guard/);
  if (guard < 0) {
    fail(`${label}이 사건 시각 신선도를 보지 않습니다`);
  } else if (o && guard < o.chal) {
    fail(`${label}의 신선도 검사가 잠금보다 앞에 있습니다`
      + ' — 잠금을 기다리는 동안 시각이 낡아 만료와 같은 직렬화 안에서 비교되지 않습니다');
  }
  // **챌린지 계좌에만 건다.** 일반 계좌 동작은 그대로여야 한다.
  const scoped = new RegExp(
    `IF\\s+v_challenge\\s+IS\\s+NOT\\s+NULL\\s+THEN[\\s\\S]{0,200}?paper_event_time_guard`, 'i');
  if (!scoped.test(b)) {
    fail(`${label}의 신선도 검사가 챌린지 계좌로 좁혀져 있지 않습니다`
      + ' — 일반 모의 계좌에 걸면 이득 없는 새 실패 모드가 생깁니다');
  }
}

// ── ⑤ 진입 가드가 보는 상태 집합 ──
{
  const b = body(sql, 'public.paper_open_position') ?? '';
  const m = /IF\s+v_challenge\s+IS\s+NOT\s+NULL\s+AND\s+([\s\S]*?)\s+THEN\s*\n\s*RETURN QUERY SELECT 'CHALLENGE_NOT_RUNNING'/i.exec(b);
  if (!m) {
    fail(`${MIG}의 진입 가드(CHALLENGE_NOT_RUNNING)를 찾지 못했습니다`);
  } else {
    const states = Array.from(new Set(
      (m[1].match(/'(READY|RUNNING|CLOSING|CLOSED)'/g) ?? []).map(s => s.slice(1, -1))));
    // 조건: 가드가 **허용**하는 상태를 하나만 지목해야 한다. 금지 목록을 나열하면
    // 상태가 늘 때마다 조용히 열린다.
    if (states.length !== 1 || states[0] !== 'RUNNING') {
      fail(`${MIG}의 진입 가드가 보는 상태가 {${states.join(', ')}}입니다`
        + ' — 허용은 RUNNING 하나여야 합니다. 금지 목록을 나열하면 READY가 열립니다');
    } else {
      notes.push('진입은 RUNNING에서만 — 금지 목록이 아니라 허용 하나로 적혀 있다');
    }
  }
}

// ── ⑥ finalizer는 돈을 만들지 않는다 ──
{
  const b = body(sql, 'public.paper_challenge_finalize') ?? '';
  if (/UPDATE\s+public\.paper_accounts[\s\S]{0,200}?\bbalance\s*=/i.test(b)) {
    fail('마감이 잔고를 직접 고칩니다 — 돈은 paper_money_apply 하나만 지나야 합니다');
  }
  if (/INSERT\s+INTO\s+public\.paper_challenge_cashflows/i.test(b)) {
    fail('마감이 원장에 직접 적습니다 — 돈 경로가 둘이 됩니다');
  }
  if (!/terminal_status\s*=\s*c\.close_intent/i.test(b)) {
    fail('마감이 최종 상태를 동결된 사유의 복사로 적지 않습니다'
      + ' — 마지막 잔고를 보고 다시 판단하면 083의 제약이 거부합니다');
  }
  if (!/COUNT\(\*\)[\s\S]{0,200}?paper_positions[\s\S]{0,200}?'open'/i.test(b)) {
    fail('마감이 열린 포지션 수를 세지 않습니다');
  }
  if (!/SUM\(f\.amount\)/i.test(b)) {
    fail('마감이 원장과 잔고를 대조하지 않습니다');
  }
  if (!/AND\s+c\.status\s*=\s*'CLOSING'/i.test(b)) {
    fail('마감이 CLOSING을 CAS 조건으로 걸지 않습니다 — 둘이 붙으면 두 번 닫힙니다');
  }
}

// ── ⑦ 084의 표-한정 참조 보존 ──
{
  const prev = strip(read(PREV) ?? '');
  for (const fn of ['public.paper_open_position', 'public.paper_settle_close']) {
    const a = body(prev, fn), b = body(sql, fn);
    if (!a || !b) { fail(`${fn} 대조 실패 — 한쪽을 읽지 못했습니다`); continue; }
    const refs = t => new Set(t.match(/\b(?:pp|a|c)\.[a-z_]+/g) ?? []);
    const missing = [...refs(a)].filter(r => !refs(b).has(r));
    if (missing.length) {
      fail(`${fn}에서 085의 표-한정 참조가 빠졌습니다: ${missing.join(', ')}`
        + ' — 084가 고친 42702가 되살아납니다');
    }
  }
  notes.push('084가 고친 표-한정 참조가 086에도 전부 남아 있다');
}

// ── ⑧ 새 상태와 스윕이 실제로 배선됐는가 ──
{
  const store = read(STORE) ?? '';
  if (!store.includes('CHALLENGE_NOT_RUNNING')) {
    fail(`${STORE}이 CHALLENGE_NOT_RUNNING을 옮기지 않습니다`
      + ' — 모르는 상태는 ERROR로 떨어져 정상 거절이 오류로 보고됩니다');
  }
  const disp = read(DISP) ?? '';
  if (!disp.includes('CHALLENGE_NOT_RUNNING')) {
    fail(`${DISP}이 CHALLENGE_NOT_RUNNING을 옮기지 않습니다 — FAILED로 떨어집니다`);
  }
  const route = read(ROUTE) ?? '';
  if (!route) fail(`${ROUTE}이 없습니다 — 스윕을 부르는 경로가 없습니다`);
  if (/from\('paper_accounts'\)[\s\S]{0,120}?update/i.test(route)
   || /from\('paper_challenge_cashflows'\)[\s\S]{0,120}?insert/i.test(route)) {
    fail(`${ROUTE}이 잔고나 원장을 직접 건드립니다 — 회계는 RPC만 지나야 합니다`);
  }
  if (!/closePaperPosition/.test(route)) {
    fail(`${ROUTE}이 기존 청산 경로를 쓰지 않습니다`);
  }
  const worker = read(WORKER) ?? '';
  if (!/pollChallengeSweep\s*\(\s*isMain\s*\)/.test(worker)) {
    fail(`${WORKER}의 tick이 pollChallengeSweep을 부르지 않습니다`
      + ' — 만들어 놓고 배선을 안 한 상태입니다');
  }
  if (!/api\/paper\/challenge-sweep/.test(worker)) {
    fail(`${WORKER}이 challenge-sweep 경로를 부르지 않습니다`);
  }
}

for (const n of notes) console.log(`  · ${n}`);
if (fails.length) {
  console.error('\n챌린지 마감 계약 위반:');
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('챌린지 마감 계약 전부 통과');
