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
// 왜 전용 DB를 따로 만드는가
// ──────────────────────────
// 앞 판은 재생 검사가 쓰는 그 DB에서 `DROP SCHEMA public CASCADE`를 했다. 로컬
// 평범한 Postgres에서는 통했지만 Supabase 로컬 스택에서는 소유권·확장이 달라
// 러너가 기록표조차 세우지 못했고, CI에서 28건이 한꺼번에 무너졌다.
//
// 문제는 그 실패가 아니라 **구조**였다. 이 증명은 표를 지우고 러너를 망가뜨리는
// 실험을 하는데, 그것을 본 검사와 같은 DB에서 하면 두 결과가 계속 서로에게
// 영향을 준다. 그래서 스키마를 조심스럽게 지우는 쪽이 아니라 **DB 자체를
// 분리**한다 — 같은 Postgres 서버 안에 전용 DB를 만들고, 끝나면 지운다.
//
// 본 DB는 읽기만 한다. 그것도 **증명 전후로 같은지 확인하기 위해서만** 읽는다.
//
// 무엇을 쓰는가
// ─────────────
// 픽스처를 새로 만들지 않는다. 이 저장소의 **실제 마이그레이션 전부**를 그대로
// 쓴다 — 빈 DB에서 막히는 것이 마침 다섯 개고, UNKNOWN 셋과 DESTRUCTIVE 둘이
// 순서까지 섞여 있어서 필요한 경우가 전부 나온다:
//
//   022 UNKNOWN      ← 첫 번째로 막힌 것. 승인해도 통과하면 안 된다
//   050 UNKNOWN
//   081 UNKNOWN
//   082 DESTRUCTIVE  ← 앞에 막힌 것이 있으므로 순서를 건너뛸 수 없다
//   085 DESTRUCTIVE
//
// 운영에 닿지 않는다
// ──────────────────
// 접속 대상이 로컬이 아니면 시작하지 않는다. 전용 DB를 만들지 못하면 **본 DB로
// 물러서지 않고 그냥 실패한다** — 물러서는 순간 이 격리가 없는 것과 같다.
//
// 쓰는 법
//   PROOF_DB_URL=postgresql://... node scripts/approval-path-proof.mjs
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { checksumOf, readMigrationFiles } from './gen-migration-manifest.mjs';

const REPLAY_URL = process.env.PROOF_DB_URL || '';
if (!REPLAY_URL) { console.error('PROOF_DB_URL이 필요합니다'); process.exit(1); }

// URL에서 host만 뽑는다. **값은 출력하지 않는다** — 비밀번호가 들어 있다.
function hostOf(url) {
  const q = /[?&]host=([^&]+)/.exec(url);
  if (q) return decodeURIComponent(q[1]);
  return url.replace(/^[a-z]+:\/\//, '').replace(/^[^@/]*@/, '').replace(/[:/?].*$/, '');
}
const HOST = hostOf(REPLAY_URL);
if (!(HOST.startsWith('/') || ['localhost', '127.0.0.1', '::1', 'db', 'postgres'].includes(HOST))) {
  console.error(`거부: 접속 대상이 로컬이 아닙니다 (${HOST}) — 이 증명은 DB를 만들고 지웁니다`);
  process.exit(1);
}

/**
 * 같은 서버의 다른 DB를 가리키는 URL. 나머지(사용자·호스트·포트·소켓)는 그대로 둔다.
 *
 * `new URL`을 쓰지 않는다. libpq의 유닉스 소켓 형태
 * `postgresql://user@/db?host=/tmp/sock`은 호스트 자리가 비어 있어서 `new URL`이
 * **거부한다** — 그러면 CI의 TCP 형태에서만 동작하는 코드가 된다.
 *
 * 모양을 못 알아보면 **추측하지 않고 멈춘다.** 엉뚱한 DB를 만들거나 지우는 것보다
 * 시작하지 않는 쪽이 낫다.
 */
function withDatabase(url, name) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)\/([^/?#]*)(\?[^#]*)?$/i.exec(url);
  if (!m) {
    console.error('거부: 접속 URL에서 DB 이름 자리를 찾지 못했습니다 — 추측하지 않습니다');
    process.exit(1);
  }
  return `${m[1]}/${name}${m[3] ?? ''}`;
}

/**
 * 출력에서 접속 문자열을 지운다.
 *
 * 실패했을 때 러너의 stdout/stderr를 그대로 보여 주는데, 거기에 접속 URL이
 * 섞여 나올 수 있다. **비밀번호를 로그에 남기지 않는다.**
 */
function scrub(text) {
  return String(text ?? '')
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '<db-url 가림>')
    .replace(new RegExp(TEMP_NAME, 'g'), '<proof-db>');
}

// ══════════════ 전용 DB 이름 ══════════════
//
// 같은 러너에서 여러 번 돌 수 있으므로(뮤테이션 스윕이 이 파일을 반복 호출한다)
// 실행 정보와 난수를 함께 넣는다. **바깥에서 온 값을 그대로 이름에 쓰지 않는다** —
// 안전한 글자만 남긴다.
const safe = s => String(s ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
const RUN_TAG = safe(process.env.GITHUB_RUN_ID) || 'local';
const TEMP_NAME = `approval_proof_${RUN_TAG}_${randomBytes(4).toString('hex')}`;
const MAINT_URL = withDatabase(REPLAY_URL, 'postgres');
const TEMP_URL = withDatabase(REPLAY_URL, TEMP_NAME);

const FAKE_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
let fails = 0;

const ok = (l, v) => console.log(`ok  ${l}  → ${v}`);
const bad = (l, want, got) => { console.log(`FAIL ${l} : 기대 [${want}] / 실제 [${got}]`); fails += 1; };
function want(label, expect, got) {
  // **읽지 못한 것을 통과로 적지 않는다.** 빈 값은 `wantNoRow`로 따로 본다 —
  // 여기서 빈 값을 허용하면 질의가 실패한 것과 "줄이 없다"가 같아진다.
  if (got === '' || got == null) return bad(label, expect, '읽지 못했습니다(빈 값)');
  if (String(got).startsWith('ERROR:')) return bad(label, expect, scrub(got));
  return String(expect) === String(got) ? ok(label, got) : bad(label, expect, got);
}

function psqlOn(url, sql) {
  try {
    return execFileSync('psql', [url, '-Atc', sql], { stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch (e) { return `ERROR:${scrub(String(e.stderr ?? e)).slice(0, 200)}`; }
}
const psql = sql => psqlOn(TEMP_URL, sql);

function psqlFile(path) {
  try { execFileSync('psql', [TEMP_URL, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

/** 그 파일의 기록이 **아예 없어야** 한다. 질의 오류와 구별한다. */
function wantNoRow(label, filename) {
  const n = psql(`SELECT count(*) FROM schema_migrations WHERE filename = '${filename}'`);
  if (n === '' || n.startsWith('ERROR:')) return bad(label, '0', `읽지 못했습니다: ${scrub(n)}`);
  return n === '0' ? ok(label, '기록 없음') : bad(label, '0', `${n}줄 있음`);
}

/**
 * 진짜 러너를 **전용 DB에 대고** 돌린다.
 *
 * 판정 줄이 없으면 러너가 비정상 종료한 것이다. 그때 `(판정없음)`만 찍고 넘어가면
 * 원인을 추적할 수 없다 — 실제로 그래서 한 번 늦었다. 종료코드와 출력까지 남긴다.
 */
function runner(args, { sha = FAKE_SHA } = {}) {
  const env = { ...process.env, SUPABASE_DB_URL: TEMP_URL, GITHUB_SHA: sha, GITHUB_ACTOR: 'proof-actor' };
  delete env.MIGRATION_REPORT_PATH;
  delete env.DATABASE_URL;
  delete env.POSTGRES_URL;
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, ['scripts/apply-migrations.mjs', ...args],
      { stdio: 'pipe', encoding: 'utf8', env });
  } catch (e) { out = String(e.stdout ?? '') + String(e.stderr ?? ''); code = e.status ?? 1; }
  const m = /결과: ([A-Z_]+)/.exec(out);
  if (!m) {
    console.log(`    ⚠ 러너가 판정을 내지 못하고 끝났습니다 (종료코드 ${code}) — 아래는 그 출력입니다`);
    for (const line of scrub(out).trim().split('\n').slice(-25)) console.log(`      | ${line}`);
  }
  return { code, verdict: m ? m[1] : '(판정없음)', out };
}

// ══════════════ 준비 ══════════════

/** 본 DB가 건드려지지 않았음을 보이기 위한 지문. **읽기만 한다.** */
function replaySnapshot() {
  const q = [
    `current_database()`,
    `(SELECT count(*) FROM pg_tables WHERE schemaname = 'public')`,
    `(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')`,
    `(SELECT count(*) FROM pg_namespace)`,
  ].join(" || '|' || ");
  return psqlOn(REPLAY_URL, `SELECT ${q}`);
}

let created = false;
function cleanup() {
  if (!created) return;
  // 성공했든 실패했든 지운다. 남기면 다음 실행이 이름 충돌을 겪거나 디스크가 찬다.
  const r = psqlOn(MAINT_URL, `DROP DATABASE IF EXISTS ${TEMP_NAME} WITH (FORCE)`);
  if (String(r).startsWith('ERROR:')) console.log(`  ⚠ 전용 DB 정리 실패: ${scrub(r)}`);
  else { console.log('ok  전용 DB 정리 완료  → 지웠다'); created = false; }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1); });

// ── preflight: 못 하면 **본 DB로 물러서지 않고 실패한다** ──
console.log('── 0단계: 전용 DB 준비 (본 DB는 건드리지 않는다) ──');
{
  const alive = psqlOn(MAINT_URL, 'SELECT 1');
  if (alive !== '1') {
    console.error(`거부: 관리 DB에 붙지 못했습니다 — ${scrub(alive)}`);
    process.exit(1);
  }
  ok('관리 DB 접속', 'ok');

  const canCreate = psqlOn(MAINT_URL,
    `SELECT (rolcreatedb OR rolsuper)::text FROM pg_roles WHERE rolname = current_user`);
  if (canCreate !== 'true') {
    console.error(`거부: CREATE DATABASE 권한이 없습니다 (${scrub(canCreate)}) — 본 DB에서 돌리지 않습니다`);
    process.exit(1);
  }
  ok('CREATE DATABASE 권한', 'ok');

  const mk = psqlOn(MAINT_URL, `CREATE DATABASE ${TEMP_NAME}`);
  if (String(mk).startsWith('ERROR:')) {
    console.error(`거부: 전용 DB를 만들지 못했습니다 — ${scrub(mk)}`);
    process.exit(1);
  }
  created = true;
  ok('전용 DB 생성', TEMP_NAME);
}

const BEFORE = replaySnapshot();
if (String(BEFORE).startsWith('ERROR:') || !BEFORE) {
  console.error(`거부: 본 DB 지문을 읽지 못했습니다 — 비간섭을 증명할 수 없습니다: ${scrub(BEFORE)}`);
  process.exit(1);
}
ok('본 DB 지문 기록 (증명 전)', BEFORE);

// 전용 DB에 Supabase가 깔아 두는 것들을 최소한으로 흉내낸다. 역할(role)은 서버
// 전체 공용이라 이미 있고, 스키마·확장은 DB마다 따로라 여기서 만든다.
{
  const boot = `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    DO $b$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    END $b$;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY, email TEXT);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $f$ LANGUAGE sql STABLE;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $f$
      SELECT current_setting('request.jwt.claim.role', true) $f$ LANGUAGE sql STABLE;`;
  const r = psql(boot);
  if (String(r).startsWith('ERROR:')) {
    console.error(`거부: 전용 DB를 세우지 못했습니다 — ${scrub(r)}`);
    process.exit(1);
  }
  ok('전용 DB 부트스트랩', 'auth 스키마·역할·pgcrypto');
}

// 정말 다른 DB인가. "다른 URL을 썼다"가 아니라 실제로 다른 DB인지 본다.
{
  const tempDb = psql('SELECT current_database()');
  const replayDb = psqlOn(REPLAY_URL, 'SELECT current_database()');
  want('전용 DB와 본 DB는 서로 다른 DB다', 'true', String(tempDb !== replayDb && tempDb === TEMP_NAME));
}

const files = readMigrationFiles();
const rowCount = () => psql(`SELECT count(*) FROM schema_migrations`);
const statusOf = n => psql(`SELECT status FROM schema_migrations WHERE filename = '${n}'`);

console.log(`\n── 1단계: 빈 전용 DB · 실제 마이그레이션 ${files.length}개 ──`);
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
   '085_paper_challenge_accounting.sql', 'APPROVAL_OUT_OF_ORDER'],
  ['앞에 막힌 것이 있으면 순서를 건너뛰지 않는다 (082)',
   '082_paper_rpc_account_id.sql', 'APPROVAL_OUT_OF_ORDER'],
  ['UNKNOWN은 이름만 보고 승인할 수 없다 (022)',
   '022_rls_worker_tables.sql', 'APPROVAL_RISK_MISMATCH'],
  ['목록에 없는 이름은 거부',
   '999_no_such_migration.sql', 'APPROVAL_UNKNOWN_FILE'],
  ['이미 적용된 것을 승인하면 거부',
   '011_ai_usage.sql', 'APPROVAL_ALREADY_APPLIED'],
  ['막히지 않은 안전한 파일 승인은 거부',
   '023_ai_predictions.sql', 'APPROVAL_NOT_BLOCKED'],
];
for (const [label, name, expect] of REJECT) {
  const r = runner(['--apply', `--approve-destructive=${name}`, `--approve-sha=${FAKE_SHA}`]);
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
// **기록표를 손으로 넣는 것은 "운영이 이미 그 상태"를 흉내내는 준비이지,
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
  want('이제 막힌 것은 082·085 둘', '2', String((r.out.match(/⛔/g) || []).length));
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
// **승인은 그 하나만 통과시킨다 — 그 뒤는 평소대로다.**
//
// 085를 승인해 적용하고 나면 뒤에 남은 ADDITIVE(지금은 086)는 승인 없이
// 평소 경로로 들어간다. 예전에는 085가 마지막이라 바로 UP_TO_DATE가 나왔고,
// 이 증명은 그것을 가정하고 있었다 — 086이 생기자 APPLIED가 나와서 빨개졌다.
// **계약이 아니라 픽스처가 낡은 것이다.** 남은 것이 있으면 적용하고, 그다음
// 실행에서 UP_TO_DATE가 된다.
{
  const r = runner(['--apply']);
  if (r.verdict === 'APPLIED') {
    ok('승인 뒤 남은 ADDITIVE는 승인 없이 적용된다', 'APPLIED');
    want('  종료코드 0', '0', String(r.code));
  } else {
    want('승인 뒤 남은 것이 없으면 바로 UP_TO_DATE', 'UP_TO_DATE', r.verdict);
  }
  const again = runner(['--apply']);
  want('★ 다 끝난 뒤 승인 없이 돌리면 UP_TO_DATE', 'UP_TO_DATE', again.verdict);
  want('  종료코드 0', '0', String(again.code));
  // **승인은 뒤엣것에 번지지 않는다.**
  //
  // 085를 승인해 통과시킨 뒤 따라 들어간 ADDITIVE는 평소 경로로 들어간 것이지
  // 승인된 것이 아니다. 그 구분이 흐려지면 "무엇을 사람이 허락했는가"가
  // 기록에서 사라진다. (이 증명은 3단계에서 082도 승인하므로 승인 흔적 자체는
  // 둘이다 — 그래서 개수가 아니라 **어느 파일에 붙었는지**를 본다.)
  want('  085에는 승인 흔적이 있다', '1',
    psql(`SELECT count(*) FROM schema_migrations
           WHERE filename LIKE '085%' AND applied_by LIKE 'approved:%'`));
  want('★ 승인 뒤 따라 들어간 것에는 승인 흔적이 없다', '0',
    psql(`SELECT count(*) FROM schema_migrations
           WHERE filename > '085_zzz' AND applied_by LIKE 'approved:%'`));
}

// ══════════════ 5단계: 본 DB는 건드려지지 않았다 ══════════════
//
// "다른 URL을 썼다"는 의도이고, 이건 결과다. 증명 전후의 지문이 같아야 한다.
console.log('\n── 5단계: 본 DB 비간섭 ──');
{
  const AFTER = replaySnapshot();
  want('본 DB 지문이 증명 전과 같다', BEFORE, AFTER);
  // 본 DB에는 재생이 085까지 이미 적용해 뒀다 — **그것이 그대로 남아 있어야** 한다.
  // (앞 판은 여기서 public 스키마를 통째로 날려서 이 값이 0이 됐을 것이다.)
  want('  본 DB의 재생 결과가 살아 있다 (표가 남아 있다)', 'true',
    String(Number(psqlOn(REPLAY_URL,
      `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`)) > 0));
  want('  전용 DB는 이미 사라졌거나 곧 지워진다 (본 DB와 무관)', 'true',
    String(psqlOn(REPLAY_URL, 'SELECT current_database()') !== TEMP_NAME));
}

cleanup();
console.log('');
if (fails) { console.log(`승인 경로 증명 실패 ${fails}건`); process.exit(1); }
console.log('승인 경로 증명 전부 통과');
