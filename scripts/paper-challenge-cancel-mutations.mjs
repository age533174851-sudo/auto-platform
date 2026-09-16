#!/usr/bin/env node
// scripts/paper-challenge-cancel-mutations.mjs
//
// **취소의 규칙을 하나씩 빼고, 그때 검사가 빨개지는지 본다.**
//
// 취소는 겉으로는 한 줄짜리 상태 변경이라 "이 정도는 시험이 필요 없다"고
// 읽히기 쉽다. 그런데 이 한 줄이 틀리면 **사용자가 달성한 챌린지가 취소로
// 기록되고**, 남의 챌린지가 닫히고, 취소가 직접 정산해서 회계 권위가 둘이
// 된다. 그래서 `087`의 계약을 한 줄씩 무력화하고, 실행 증명이나 배선
// 검사기가 **그것을 잡는지** 확인한다. 안 잡히면 그 줄은 장식이다.
//
// 무엇이 빨개져야 통과인가
// ────────────────────────
// 실행 증명(`scripts/sql/087_..._proof.sql`) **또는** 배선 검사기
// (`scripts/check-paper-challenge-wiring.mjs`) 중 하나라도 실패하면 RED다.
// 둘을 다 보는 이유: 잠금 순서처럼 **한 연결로는 관측되지 않는** 위반이 있고,
// 그건 조건을 읽는 검사기만 잡을 수 있다.
//
// 쓰는 법
//   PAPER_DB_URL=postgresql://... node scripts/paper-challenge-cancel-mutations.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { reapplyAfter } from './lib/reapply-migrations.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const MIG_DIR  = 'supabase/migrations';
const MIG_NAME = '087_paper_challenge_cancel.sql';
const MIG   = `${MIG_DIR}/${MIG_NAME}`;
const PROOF = 'scripts/sql/087_paper_challenge_cancel_proof.sql';
const CHECK = 'scripts/check-paper-challenge-wiring.mjs';

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

function applyFile(path) {
  try {
    execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-q', '--single-transaction', '-f', path],
      { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

/**
 * 이 파일을 세우고 **뒤 번호까지 다시 세운다.**
 *
 * 지금은 087이 마지막이라 뒤엣것이 없지만, 088이 생기는 순간 이 한 줄이
 * 없으면 087 정본이 088의 대체를 덮는다 — 085에서 실제로 그렇게 깨졌다.
 */
function applyMigration() {
  if (!applyFile(MIG)) return false;
  return reapplyAfter(MIG_DIR, MIG_NAME, (sql) => {
    const tmp = `${process.env.TMPDIR || '/tmp'}/pccm-reapply.sql`;
    writeFileSync(tmp, sql);
    return applyFile(tmp);
  });
}
function proofGreen() {
  // **NOTICE는 stderr로 나온다.** stdout만 보면 정본도 빨갛게 읽힌다 —
  // 처음에 그렇게 틀렸다. 두 흐름을 모두 본다.
  const r = spawnSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-Xf', PROOF],
    { encoding: 'utf8' });
  const out = String(r.stdout ?? '') + String(r.stderr ?? '');
  return r.status === 0 && /챌린지 취소 실행 증명 전부 통과/.test(out);
}
function checkerGreen() {
  try {
    execFileSync(process.execPath, [CHECK], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

// ── 무엇을 빼 보는가 ──
const MUTATIONS = [
  { name: '소유자 확인을 첫 조회에서 뺀다 — 남의 챌린지가 취소된다',
    cut: ['   WHERE c.id = p_challenge AND c.user_id = p_user;\n\n  IF v_acct IS NULL THEN',
          '   WHERE c.id = p_challenge;\n\n  IF v_acct IS NULL THEN'] },

  { name: '소유자 확인을 잠긴 재조회에서도 뺀다 — 남의 챌린지가 닫힌다',
    cuts: [
      ['   WHERE c.id = p_challenge AND c.user_id = p_user;\n\n  IF v_acct IS NULL THEN',
       '   WHERE c.id = p_challenge;\n\n  IF v_acct IS NULL THEN'],
      ['   WHERE c.id = p_challenge AND c.user_id = p_user\n     FOR UPDATE;',
       '   WHERE c.id = p_challenge\n     FOR UPDATE;'],
      ["     AND c.user_id = p_user\n     AND c.close_intent IS NULL",
       '     AND c.close_intent IS NULL'],
    ] },

  { name: '이미 정해진 사유를 덮는다 — 달성이 취소로 기록된다',
    cut: ['  IF v_ch.intent IS NOT NULL THEN', '  IF FALSE THEN'] },

  { name: '사유 CAS를 뺀다 — 동시에 들어온 만료를 취소가 덮는다',
    cuts: [
      ['  IF v_ch.intent IS NOT NULL THEN', '  IF FALSE THEN'],
      ['     AND c.close_intent IS NULL\n', ''],
    ] },

  { name: '상태 관문을 없앤다 — CLOSING·CLOSED도 다시 밀린다',
    cuts: [
      ["  IF v_ch.st NOT IN ('READY', 'RUNNING') THEN", '  IF FALSE THEN'],
      ["     AND c.status IN ('READY', 'RUNNING')", "     AND c.status IN ('READY', 'RUNNING', 'CLOSING', 'CLOSED')"],
      ["  IF v_ch.st = 'CLOSED' THEN", '  IF FALSE THEN'],
      ['  IF v_ch.intent IS NOT NULL THEN', '  IF FALSE THEN'],
    ] },

  { name: '전이 키를 새로 만든다 — CLOSING 로그가 두 줄이 된다',
    cut: ["'INTENT:' || p_challenge::TEXT", "'CANCEL:' || p_challenge::TEXT"] },

  { name: '사건 시각 신선도 검사를 뺀다 — 낡은 취소가 만료 뒤에 도착해도 먹는다',
    cut: ['  PERFORM public.paper_event_time_guard(p_event_effective_at);',
          '  -- (뮤테이션) 신선도를 보지 않는다'] },

  { name: '사건 시각이 없어도 진행한다 — 판정 기준 없는 기록이 생긴다',
    cut: ['  IF p_event_effective_at IS NULL THEN', '  IF FALSE THEN'] },

  { name: '잠금 순서를 뒤집는다 (챌린지 → 계좌) — 086의 마감과 순환 대기가 생긴다',
    cuts: [
      ['  SELECT a.id INTO v_locked\n'
     + '    FROM public.paper_accounts a WHERE a.id = v_acct FOR UPDATE;\n'
     + '  IF v_locked IS NULL THEN\n'
     + "    RAISE EXCEPTION 'paper_challenge_cancel: 계좌가 없습니다 (%)', v_acct;\n"
     + '  END IF;\n',
       '  -- (뮤테이션) 계좌 잠금을 뒤로 미룬다\n'],
      ['     FOR UPDATE;\n\n  IF v_ch.cid IS NULL THEN',
       '     FOR UPDATE;\n'
     + '  SELECT a.id INTO v_locked\n'
     + '    FROM public.paper_accounts a WHERE a.id = v_acct FOR UPDATE;\n\n'
     + '  IF v_ch.cid IS NULL THEN'],
    ] },

  { name: '취소가 직접 정산한다 — 회계 권위가 둘이 된다',
    cut: ['  v_now := clock_timestamp();\n',
          '  v_now := clock_timestamp();\n'
        + '  PERFORM public.paper_money_apply(\n'
        + "      v_acct, p_user, 'REALIZED_PNL', 0,\n"
        + "      'POSITION_CLOSE', p_challenge::TEXT, p_event_effective_at);\n"] },

  { name: '취소가 포지션을 직접 닫는다 — 정산 경로가 둘이 된다',
    cut: ['  v_now := clock_timestamp();\n',
          '  v_now := clock_timestamp();\n'
        + "  UPDATE public.paper_positions SET status = 'closed'\n"
        + '   WHERE paper_account_id = v_acct;\n'] },

  { name: '취소가 잔고를 직접 고친다 — 원장과 잔고가 갈린다',
    cut: ['  v_now := clock_timestamp();\n',
          '  v_now := clock_timestamp();\n'
        + '  UPDATE public.paper_accounts SET balance = balance + 1 WHERE id = v_acct;\n'] },

  { name: '남의 챌린지에 다른 답을 준다 — 존재 여부가 새어 나간다',
    cut: ["    RETURN QUERY SELECT FALSE, 'NOT_FOUND'::TEXT, NULL::TEXT, NULL::TEXT;\n"
        + '    RETURN;\n'
        + '  END IF;\n\n'
        + '  -- ② 계좌 → ③ 챌린지',
          "    RETURN QUERY SELECT FALSE, 'NOT_OWNED'::TEXT, NULL::TEXT, NULL::TEXT;\n"
        + '    RETURN;\n'
        + '  END IF;\n\n'
        + '  -- ② 계좌 → ③ 챌린지'] },
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
  const ctrl = canonical.replace('-- **여기서 돈을 만들지 않는다**',
    '-- **여기서 돈을 만들지 않는다** (대조군: 주석만 바꿨다)');
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
  console.log(`챌린지 취소 뮤테이션 실패 — 살아남은 뮤테이션 ${survivors}건 · 낡은 앵커 ${anchorFails}건`);
  process.exit(1);
}
console.log(`뮤테이션 ${MUTATIONS.length}건 전부 RED · 주석 대조군 GREEN`);
