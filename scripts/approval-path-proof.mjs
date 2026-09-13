#!/usr/bin/env node
// scripts/approval-path-proof.mjs
//
// **승인 경로가 무엇을 통과시키고 무엇을 막는지 실행해서 본다.**
//
// 왜 필요한가
// ───────────
// 이 경로는 안전장치를 **일부러 통과시키는** 자리다. 그런 코드는 조용히 헐거워지기
// 쉽고, 헐거워진 것을 알아채는 방법이 없으면 "위험한 건 자동으로 안 돕니다"라는
// 문장이 거짓이 된다. 그래서 글자를 읽지 않고 **진짜 러너를 진짜 DB에 대고 돌린다.**
//
// 무엇을 쓰는가
// ─────────────
// 픽스처를 새로 만들지 않는다. 이 저장소의 **실제 마이그레이션 83개**를 그대로
// 쓴다 — 빈 DB에서 막히는 것이 마침 다섯 개고, 그중 UNKNOWN 셋과 DESTRUCTIVE
// 둘이 순서까지 섞여 있어서 필요한 경우가 전부 나온다:
//
//   022 UNKNOWN      ← 첫 번째로 막힌 것. 승인해도 통과하면 안 된다
//   050 UNKNOWN
//   081 UNKNOWN
//   082 DESTRUCTIVE  ← 앞에 막힌 것이 있으므로 순서를 건너뛸 수 없다
//   085 DESTRUCTIVE
//
// 운영에 닿지 않는다
// ──────────────────
// 접속 대상이 로컬이 아니면 시작하지 않는다. 이 스크립트는 표를 지우고 다시 만든다.
//
// 쓰는 법
//   PROOF_DB_URL=postgresql://... node scripts/approval-path-proof.mjs
import { execFileSync } from 'node:child_process';
import { checksumOf, readMigrationFiles } from './gen-migration-manifest.mjs';

const DB = process.env.PROOF_DB_URL || '';
if (!DB) { console.error('PROOF_DB_URL이 필요합니다'); process.exit(1); }

// URL에서 host만 뽑는다. **값은 출력하지 않는다** — 비밀번호가 들어 있다.
function hostOf(url) {
  const q = /[?&]host=([^&]+)/.exec(url);
  if (q) return decodeURIComponent(q[1]);
  return url.replace(/^[a-z]+:\/\//, '').replace(/^[^@/]*@/, '').replace(/[:/?].*$/, '');
}
const HOST = hostOf(DB);
if (!(HOST.startsWith('/') || ['localhost', '127.0.0.1', '::1', 'db', 'postgres'].includes(HOST))) {
  console.error(`거부: 접속 대상이 로컬이 아닙니다 (${HOST}) — 이 증명은 표를 지웁니다`);
  process.exit(1);
}

const FAKE_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
let fails = 0;

const ok = (l, v) => console.log(`ok  ${l}  → ${v}`);
const bad = (l, want, got) => { console.log(`FAIL ${l} : 기대 [${want}] / 실제 [${got}]`); fails += 1; };
function want(label, expect, got) {
  // **읽지 못한 것을 통과로 적지 않는다.** 빈 값은 `wantNoRow`로 따로 본다 —
  // 여기서 빈 값을 허용하면 질의가 실패한 것과 "줄이 없다"가 같아진다.
  if (got === '' || got == null) return bad(label, expect, '읽지 못했습니다(빈 값)');
  if (String(got).startsWith('ERROR:')) return bad(label, expect, got);
  return String(expect) === String(got) ? ok(label, got) : bad(label, expect, got);
}

/** 그 파일의 기록이 **아예 없어야** 한다. 질의 오류와 구별한다. */
function wantNoRow(label, filename) {
  const n = psql(`SELECT count(*) FROM schema_migrations WHERE filename = '${filename}'`);
  if (n === '' || n.startsWith('ERROR:')) return bad(label, '0', `읽지 못했습니다: ${n}`);
  return n === '0' ? ok(label, '기록 없음') : bad(label, '0', `${n}줄 있음`);
}

function psql(sql) {
  try {
    return execFileSync('psql', [DB, '-Atc', sql], { stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch (e) { return `ERROR:${String(e.stderr ?? e).slice(0, 160)}`; }
}
function psqlFile(path) {
  try { execFileSync('psql', [DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

/** 진짜 러너를 돌린다. 종료코드와 리포트 code를 함께 돌려준다. */
function runner(args, { sha = FAKE_SHA } = {}) {
  const env = { ...process.env, SUPABASE_DB_URL: DB, GITHUB_SHA: sha, GITHUB_ACTOR: 'proof-actor' };
  delete env.MIGRATION_REPORT_PATH;
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, ['scripts/apply-migrations.mjs', ...args],
      { stdio: 'pipe', encoding: 'utf8', env });
  } catch (e) { out = String(e.stdout ?? '') + String(e.stderr ?? ''); code = e.status ?? 1; }
  const m = /결과: ([A-Z_]+)/.exec(out);
  return { code, verdict: m ? m[1] : '(판정없음)', out };
}

const files = readMigrationFiles();
const rowCount = () => psql(`SELECT count(*) FROM schema_migrations`);
const statusOf = n => psql(`SELECT status FROM schema_migrations WHERE filename = '${n}'`);

// ══════════════ 준비: 빈 DB ══════════════
function resetSchema() {
  psql(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
        GRANT ALL ON SCHEMA public TO postgres; GRANT ALL ON SCHEMA public TO public;`);
}

console.log('── 1단계: 빈 DB · 실제 마이그레이션 83개 ──');
resetSchema();
{
  const r = runner(['--apply']);
  want('승인 없이 적용하면 NEEDS_APPROVAL', 'NEEDS_APPROVAL', r.verdict);
  want('  종료코드 1', '1', String(r.code));
  wantNoRow('  085는 적용되지 않았다', '085_paper_challenge_accounting.sql');
}
const baseRows = rowCount();
console.log(`   (이 시점 기록 ${baseRows}줄 — 아래 실패들은 이 값을 바꾸면 안 된다)`);

// ══════════════ 통과하면 안 되는 승인들 ══════════════
console.log('\n── 2단계: 거부돼야 하는 승인 ──');
const REJECT = [
  ['앞에 막힌 것이 있으면 순서를 건너뛰지 않는다 (085)',
   '085_paper_challenge_accounting.sql', 'APPROVAL_OUT_OF_ORDER', {}],
  ['앞에 막힌 것이 있으면 순서를 건너뛰지 않는다 (082)',
   '082_paper_rpc_account_id.sql', 'APPROVAL_OUT_OF_ORDER', {}],
  ['UNKNOWN은 이름만 보고 승인할 수 없다 (022)',
   '022_rls_worker_tables.sql', 'APPROVAL_RISK_MISMATCH', {}],
  ['목록에 없는 이름은 거부',
   '999_no_such_migration.sql', 'APPROVAL_UNKNOWN_FILE', {}],
  ['이미 적용된 것을 승인하면 거부',
   '011_ai_usage.sql', 'APPROVAL_ALREADY_APPLIED', {}],
  ['막히지 않은 안전한 파일 승인은 거부',
   '023_ai_predictions.sql', 'APPROVAL_NOT_BLOCKED', {}],
];
for (const [label, name, expect, opt] of REJECT) {
  const r = runner(['--apply', `--approve-destructive=${name}`, `--approve-sha=${FAKE_SHA}`], opt);
  want(label, expect, r.verdict);
}

// 커밋이 다르면 **DB에 닿기 전에** 멈춘다.
{
  const r = runner(['--apply',
    '--approve-destructive=085_paper_challenge_accounting.sql',
    `--approve-sha=${OTHER_SHA}`]);
  want('승인 커밋이 실행 커밋과 다르면 거부', 'APPROVAL_SHA_MISMATCH', r.verdict);
  // 접속 정보를 읽는 줄이 아예 나오지 않아야 한다 = DB에 닿기 전에 끝났다.
  want('  DB에 닿기 전에 끝났다', 'true', String(!/DB 접속 정보:/.test(r.out)));
}
{
  const r = runner(['--apply', '--approve-destructive=085_paper_challenge_accounting.sql']);
  want('커밋을 안 묶은 승인은 거부', 'APPROVAL_INVALID', r.verdict);
}
{
  const r = runner(['--apply', `--approve-sha=${FAKE_SHA}`]);
  want('대상 없이 커밋만 온 승인은 거부', 'APPROVAL_INVALID', r.verdict);
}
{
  const r = runner(['--apply',
    '--approve-destructive=../../etc/passwd', `--approve-sha=${FAKE_SHA}`]);
  want('경로가 섞인 승인은 거부', 'APPROVAL_INVALID', r.verdict);
}
{
  const r = runner(['--apply',
    '--approve-destructive=085_paper_challenge_accounting.sql',
    '--approve-destructive=082_paper_rpc_account_id.sql', `--approve-sha=${FAKE_SHA}`]);
  want('승인 대상이 둘이면 거부', 'APPROVAL_INVALID', r.verdict);
}

want('거부들이 기록을 한 줄도 바꾸지 않았다', baseRows, rowCount());

// ══════════════ 3단계: 앞의 것부터 승인하면 그것만 지나간다 ══════════════
//
// 운영과 같은 모양을 만든다: 022·050·081까지는 이미 적용된 DB.
// **기록표를 손으로 넣는 것은 여기서 "운영이 이미 그 상태"를 흉내내는 준비이지,
// 승인 경로를 우회하는 것이 아니다** — 검증 대상은 그다음에 도는 러너다.
console.log('\n── 3단계: 앞의 UNKNOWN이 이미 적용된 상태 (운영과 같은 모양) ──');
function seedApplied(upTo) {
  for (const f of files) {
    const num = /^(\d{3})_/.exec(f.name);
    if (!num || Number(num[1]) > upTo) continue;
    if (statusOf(f.name)) continue;
    psqlFile(`supabase/migrations/${f.name}`);
    psql(`INSERT INTO schema_migrations (filename, checksum, applied_by, status, verified)
          VALUES ('${f.name}', '${checksumOf(f.sql)}', 'proof-seed', 'APPLIED', true)
          ON CONFLICT (filename) DO NOTHING`);
  }
}
seedApplied(81);
{
  const r = runner(['--check']);
  want('이제 막힌 것은 082·085 둘', '2',
    String((r.out.match(/⛔/g) || []).length));
}
{
  // 082를 승인한다. **085는 승인하지 않았으므로 그대로 막혀 있어야 한다.**
  const r = runner(['--apply',
    '--approve-destructive=082_paper_rpc_account_id.sql', `--approve-sha=${FAKE_SHA}`]);
  want('앞의 082를 승인하면 NEEDS_APPROVAL (085가 남았으므로)', 'NEEDS_APPROVAL', r.verdict);
  want('  082는 적용됐다', 'APPLIED', statusOf('082_paper_rpc_account_id.sql'));
  wantNoRow('  ★ 승인하지 않은 085는 그대로 막혀 있다', '085_paper_challenge_accounting.sql');
  want('  승인 흔적이 applied_by에 남았다', 'true',
    String(psql(`SELECT applied_by FROM schema_migrations WHERE filename='082_paper_rpc_account_id.sql'`)
      .startsWith('approved:')));
}

// ══════════════ 4단계: 마지막 하나를 승인한다 ══════════════
console.log('\n── 4단계: 085만 남은 상태 (운영의 지금 모양) ──');
{
  const r = runner(['--apply']);   // 083·084는 안전하므로 자동으로 들어간다
  want('승인 없이 돌리면 085에서 멈춘다', 'NEEDS_APPROVAL', r.verdict);
  want('  083은 자동 적용됐다', 'APPLIED', statusOf('083_paper_challenge_core.sql'));
  want('  084도 자동 적용됐다', 'APPLIED', statusOf('084_paper_open_position_ambiguity.sql'));
  wantNoRow('  085는 여전히 미적용', '085_paper_challenge_accounting.sql');
}
{
  // 내용이 다르다고 주장하는 승인은 거부.
  const r = runner(['--apply',
    '--approve-destructive=085_paper_challenge_accounting.sql',
    `--approve-sha=${FAKE_SHA}`, '--approve-checksum=deadbeefdeadbeef']);
  want('체크섬이 다르면 거부', 'APPROVAL_CHECKSUM_MISMATCH', r.verdict);
  wantNoRow('  그래도 085는 미적용', '085_paper_challenge_accounting.sql');
}
{
  const real = checksumOf(files.find(f => f.name === '085_paper_challenge_accounting.sql').sql);
  const r = runner(['--apply',
    '--approve-destructive=085_paper_challenge_accounting.sql',
    `--approve-sha=${FAKE_SHA}`, `--approve-checksum=${real}`]);
  want('★ 정확한 승인이면 085가 적용된다', 'APPLIED', r.verdict);
  want('  종료코드 0', '0', String(r.code));
  want('  085 기록 상태', 'APPLIED', statusOf('085_paper_challenge_accounting.sql'));
  want('  확인까지 끝났다 (verified)', 't',
    psql(`SELECT verified FROM schema_migrations WHERE filename='085_paper_challenge_accounting.sql'`));
  want('  승인 흔적이 남았다', 'true',
    String(psql(`SELECT applied_by FROM schema_migrations WHERE filename='085_paper_challenge_accounting.sql'`)
      .startsWith('approved:')));
  want('  새 함수가 실제로 생겼다 (paper_challenge_judge)', '1',
    psql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='paper_challenge_judge'`));
}
{
  const r = runner(['--apply']);
  want('다 끝난 뒤 승인 없이 돌리면 UP_TO_DATE', 'UP_TO_DATE', r.verdict);
  want('  종료코드 0', '0', String(r.code));
}

console.log('');
if (fails) { console.log(`승인 경로 증명 실패 ${fails}건`); process.exit(1); }
console.log('승인 경로 증명 전부 통과');
