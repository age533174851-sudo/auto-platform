#!/usr/bin/env node
// scripts/paper-challenge-finalizer-mutations.mjs
//
// **규칙을 하나씩 빼고, 그때 검사가 빨개지는지 본다.**
//
// 통과하는 검사만 보고는 "이 규칙을 아무도 안 지켜본다"를 구별할 수 없다.
// 그래서 `086`의 계약을 한 줄씩 무력화하고, 실행 증명이나 계약 검사기가
// **그것을 잡는지** 확인한다. 안 잡히면 그 줄은 장식이다.
//
// 무엇이 빨개져야 통과인가
// ────────────────────────
// 실행 증명(`scripts/sql/086_..._proof.sql`) **또는** 계약 검사기
// (`scripts/check-paper-challenge-finalizer.mjs`) 중 하나라도 실패하면 RED다.
// 둘을 다 보는 이유: `now()`처럼 **실제 시계로는 구별되지 않는** 위반이 있고,
// 그건 조건을 읽는 검사기만 잡을 수 있다.
//
// 쓰는 법
//   PAPER_DB_URL=postgresql://... node scripts/paper-challenge-finalizer-mutations.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MIG   = 'supabase/migrations/086_paper_challenge_finalizer.sql';
const PROOF = 'scripts/sql/086_paper_challenge_finalizer_proof.sql';
const CHECK = 'scripts/check-paper-challenge-finalizer.mjs';

const DB = process.env.PAPER_DB_URL || '';
if (!DB) { console.error('PAPER_DB_URL이 필요합니다'); process.exit(1); }

// **표를 건드리는 검사다.** 로컬이 아니면 시작하지 않는다.
function hostOf(url) {
  const q = /[?&]host=([^&]+)/.exec(url);
  if (q) return decodeURIComponent(q[1]);
  return url.replace(/^[a-z]+:\/\//, '').replace(/^[^@/]*@/, '').replace(/[:/?].*$/, '');
}
const HOST = hostOf(DB);
if (!(HOST.startsWith('/') || ['localhost', '127.0.0.1', '::1', 'db', 'postgres'].includes(HOST))) {
  console.error(`거부: 접속 대상이 로컬이 아닙니다 (${HOST})`);
  process.exit(1);
}

const canonical = readFileSync(MIG, 'utf8');
const restore = () => writeFileSync(MIG, canonical);

function applyMigration() {
  try {
    execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-q', '--single-transaction', '-f', MIG],
      { stdio: 'pipe' });
    return true;
  } catch { return false; }
}
function proofGreen() {
  // **NOTICE는 stderr로 나온다.** stdout만 보면 정본도 빨갛게 읽힌다 —
  // 처음에 그렇게 틀렸다. 두 흐름을 모두 본다.
  const r = spawnSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-Xf', PROOF],
    { encoding: 'utf8' });
  const out = String(r.stdout ?? '') + String(r.stderr ?? '');
  return r.status === 0 && /챌린지 생명주기 실행 증명 전부 통과/.test(out);
}
function checkerGreen() {
  try {
    execFileSync(process.execPath, [CHECK], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

// ── 무엇을 빼 보는가 ──
const MUTATIONS = [
  { name: '진입 가드를 금지 목록으로 바꾼다 — READY에서 주문이 열린다',
    cut: ["v_ch_status IS DISTINCT FROM 'RUNNING'", "v_ch_status IN ('CLOSING', 'CLOSED')"] },

  { name: '진입 가드를 통째로 제거 — 어느 상태에서도 주문이 열린다',
    cut: ["IF v_challenge IS NOT NULL AND v_ch_status IS DISTINCT FROM 'RUNNING' THEN",
          'IF false THEN'] },

  { name: '신선도 비교를 항상 참으로 — 낡은 사건이 돈을 움직인다',
    cut: ['SELECT p_now <= p_event_at + public.paper_event_max_lag()', 'SELECT true'] },

  { name: '만료 부등식을 >= 로 느슨하게 — 경계에서 만료와 정산이 겹친다',
    cut: ['SELECT p_now > p_ends_at + public.paper_event_max_lag()',
          'SELECT p_now >= p_ends_at + public.paper_event_max_lag()'] },

  { name: '만료가 다른 상수를 쓰게 한다 — 유예가 신선도와 어긋난다',
    cut: ['SELECT p_now > p_ends_at + public.paper_event_max_lag()',
          "SELECT p_now > p_ends_at + INTERVAL '0 seconds'"] },

  { name: '중재가 now()를 쓰게 한다 — 잠금을 기다린 트랜잭션이 옛 시각으로 통과한다',
    cut: ['v_now TIMESTAMPTZ := clock_timestamp();   -- **now()가 아니다** (머리말 참고)',
          'v_now TIMESTAMPTZ := now();'] },

  { name: '마감의 CLOSING CAS 제거 — 둘이 붙으면 두 번 닫힌다',
    cut: ["   WHERE c.id = p_challenge\n     AND c.status = 'CLOSING';",
          '   WHERE c.id = p_challenge;'] },

  { name: '열린 포지션 0 확인 제거 — 포지션이 남은 채 CLOSED가 된다',
    cut: ['IF v_open > 0 THEN', 'IF false THEN'] },

  { name: '원장·잔고 대조 제거 — 어긋난 채로 끝났다고 적는다',
    cut: ['IF v_ledger IS DISTINCT FROM v_bal THEN', 'IF false THEN'] },

  { name: '최종 상태를 다시 판단한다 — 동결된 사유를 덮는다',
    cut: ['terminal_status = c.close_intent,   -- **동결된 사유를 그대로 옮긴다**',
          "terminal_status = 'FAILED',"] },

  {
    // CAS 하나만 빼면 **잠긴 재조회의 `intent IS NULL` 검사가 대신 막는다**
    // — 행동이 안 바뀌는 등가 뮤테이션이다(실험으로 확인했다). 그 앞의
    // 상태 검사까지 셋을 같이 빼야 "이미 끝나기로 한 챌린지를 다시 민다"가
    // 실제로 일어난다. 서로를 가려 주는 세 방어이므로 함께 뺀다.
    name: '이미 정해진 사유를 지키는 방어를 **셋 다** 제거 (상태 + 의도 + CAS)',
    cuts: [
      ["    IF v_ch.st IN ('READY', 'RUNNING')\n"
     + '       AND v_ch.intent IS NULL\n'
     + '       AND public.paper_challenge_expiry_eligible(v_ch.e_at) THEN',
       '    IF public.paper_challenge_expiry_eligible(v_ch.e_at) THEN'],
      ['       WHERE c.id = v_ch.cid\n         AND c.close_intent IS NULL;',
       '       WHERE c.id = v_ch.cid;'],
      ["     WHERE c.status IN ('READY', 'RUNNING')",
       "     WHERE c.status IN ('READY', 'RUNNING', 'CLOSING')"],
    ],
  },

  { name: '만료가 judge와 다른 전이 키를 쓴다 — CLOSING 로그가 두 줄이 된다',
    cut: ["'INTENT:' || v_ch.cid::TEXT", "'EXPIRE:' || v_ch.cid::TEXT"] },

  { name: '원장 시각 동결 트리거 제거 — 같은 사건에 다른 시각을 적을 수 있다',
    cut: ['CREATE TRIGGER paper_challenge_cashflows_freeze_trg\n'
        + '  BEFORE UPDATE ON public.paper_challenge_cashflows\n'
        + '  FOR EACH ROW\n'
        + '  EXECUTE FUNCTION public.paper_challenge_cashflows_freeze_event_at();',
          'SELECT 1;'] },

  { name: '신선도를 일반 계좌까지 확대 — legacy 동작이 바뀐다',
    cut: ['  IF v_challenge IS NOT NULL THEN\n'
        + '    PERFORM public.paper_event_time_guard(p_event_effective_at);\n'
        + '  END IF;\n\n  -- ③ 같은 신호는 한 번만',
          '  IF TRUE THEN\n'
        + '    PERFORM public.paper_event_time_guard(p_event_effective_at);\n'
        + '  END IF;\n\n  -- ③ 같은 신호는 한 번만'] },

  { name: '마감의 잠금 순서를 뒤집는다 — 정산과 순환이 생긴다',
    cuts: [
      ['  SELECT a.id, a.balance INTO v_locked, v_bal\n'
     + '    FROM public.paper_accounts a WHERE a.id = v_acct FOR UPDATE;',
        '  -- (뮤테이션) 계좌 잠금을 뒤로 미룬다'],
      ["  SELECT c.id AS cid, c.user_id AS uid, c.status AS st, c.close_intent AS intent\n"
     + '    INTO v_ch\n'
     + '    FROM public.paper_challenges c WHERE c.id = p_challenge FOR UPDATE;',
        "  SELECT c.id AS cid, c.user_id AS uid, c.status AS st, c.close_intent AS intent\n"
     + '    INTO v_ch\n'
     + '    FROM public.paper_challenges c WHERE c.id = p_challenge FOR UPDATE;\n'
     + '  SELECT a.id, a.balance INTO v_locked, v_bal\n'
     + '    FROM public.paper_accounts a WHERE a.id = v_acct FOR UPDATE;'],
    ] },
];

let survivors = 0, anchorFails = 0;

console.log('── 정본 기준선 ──');
restore();
if (!applyMigration()) { console.log('  ✗ 정본이 적용되지 않는다'); process.exit(1); }
if (!proofGreen())     { console.log('  ✗ 정본에서 증명이 빨갛다'); process.exit(1); }
if (!checkerGreen())   { console.log('  ✗ 정본에서 검사기가 빨갛다'); process.exit(1); }
console.log('  ✓ 정본 GREEN (적용 · 증명 · 검사기)');

console.log('\n── 뮤테이션 ──');
for (const m of MUTATIONS) {
  const cuts = m.cuts || [m.cut];
  let mutated = canonical, missing = null;
  for (const [oldText, newText] of cuts) {
    if (!mutated.includes(oldText)) { missing = oldText.slice(0, 70); break; }
    mutated = mutated.replace(oldText, newText);
  }
  if (missing !== null) {
    // **적용되지 않은 뮤테이션을 통과로 적지 않는다.**
    console.log(`  ‼ ${m.name}\n      앵커가 낡았습니다: ${JSON.stringify(missing)}`);
    anchorFails += 1;
    continue;
  }
  writeFileSync(MIG, mutated);

  let why;
  if (!applyMigration())      why = 'RED (적용 거부)';
  else if (!proofGreen())     why = 'RED (실행 증명)';
  else if (!checkerGreen())   why = 'RED (계약 검사기)';
  else                        why = null;

  console.log(why
    ? `  ✓ ${m.name}\n      ${why}`
    : `  ✗ ${m.name}\n      초록이다 — 이 규칙을 지켜보는 것이 없다`);
  if (!why) survivors += 1;

  restore();
  applyMigration();      // 다음 판을 정본 위에서 시작한다
}

console.log('\n── 주석만 바꾼 대조군 ──');
{
  const ctrl = canonical.replace('-- ══════════════════ ⑧ 마감 ══════════════════',
    '-- ══════════════════ ⑧ 마감 ══════════════════ (대조군: 주석만 바꿨다)');
  if (ctrl === canonical) { console.log('  ‼ 대조군 앵커가 낡았습니다'); anchorFails += 1; }
  else {
    writeFileSync(MIG, ctrl);
    const green = applyMigration() && proofGreen() && checkerGreen();
    console.log(green
      ? '  ✓ 주석만 바꾼 판은 GREEN — 검사가 글자에 반응하지 않는다'
      : '  ✗ 주석만 바꿨는데 빨갛다 — 검사가 조건이 아니라 글자를 보고 있다');
    if (!green) survivors += 1;
    restore();
    applyMigration();
  }
}

restore();
applyMigration();
console.log('');
if (survivors || anchorFails) {
  console.log(`챌린지 마감 뮤테이션 실패 — 살아남은 뮤테이션 ${survivors}건 · 낡은 앵커 ${anchorFails}건`);
  process.exit(1);
}
console.log(`뮤테이션 ${MUTATIONS.length}건 전부 RED · 주석 대조군 GREEN`);
