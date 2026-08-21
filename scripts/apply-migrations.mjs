#!/usr/bin/env node
// scripts/apply-migrations.mjs
//
// **사람이 Supabase SQL 편집기를 여는 일을 없앤다.**
//
// 사용:
//   node scripts/apply-migrations.mjs --check    적용 계획만 본다 (DB를 바꾸지 않는다)
//   node scripts/apply-migrations.mjs --apply    안전한 것만 적용하고 확인까지 한다
//
// 접속
// ────
// `SUPABASE_DB_URL`(없으면 DATABASE_URL·POSTGRES_URL)에서 읽는다.
// **값은 어디에도 출력하지 않는다.** 있는지 없는지와 지문만 말한다.
//
// 절차
// ────
//   1. 기록표 준비        000_schema_migrations.sql을 먼저 적용한다
//   2. 이미 있는 것 채택   표·인덱스·칸·정책이 실제로 있으면 '적용됨'으로 기록
//                          — **실행하지 않는다.** 이미 돌아간 SQL을 다시 돌리지 않는다
//   3. 계획               남은 것을 ADDITIVE/DESTRUCTIVE/UNKNOWN으로 가른다
//   4. 잠금               배포 두 개가 겹치지 않게
//   5. 적용               ADDITIVE만, 번호 순으로, 한 파일 한 트랜잭션
//   6. 확인               카탈로그에 실제로 생겼는지 다시 묻는다
//   7. 기록               파일명·체크섬·시각·커밋·상태
//
// **위험한 것은 절대 자동으로 실행하지 않는다.** DROP TABLE·DROP COLUMN·
// 타입 변경·조건 없는 DELETE/UPDATE는 여기서 멈추고 사유를 적는다.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadPlan, readMigrationFiles, checksumOf, LEGACY, MIG_DIR } from './gen-migration-manifest.mjs';

const MODE = process.argv.includes('--apply') ? 'apply' : 'check';
const RUNTIME_SHA = String(process.env.GITHUB_SHA || process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 40) || null;
const APPLIED_BY = String(process.env.GITHUB_ACTIONS ? 'github-actions' : 'local');
const HOLDER = `${APPLIED_BY}:${String(process.env.GITHUB_RUN_ID || randomUUID()).slice(0, 24)}`;

/** 값을 보여주지 않고 같은 값인지만 말한다 */
function fingerprint(v) {
  if (!v) return null;
  return createHash('sha256').update(String(v)).digest('hex').slice(0, 6);
}

function dbUrl() {
  for (const k of ['SUPABASE_DB_URL', 'DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_DB_URL_POOLER']) {
    const v = String(process.env[k] || '').trim();
    if (v) return { url: v, from: k };
  }
  return { url: '', from: null };
}

/** 로그·오류 문구에서 접속 문자열을 지운다. **한 번 새면 기록에 영원히 남는다** */
function scrub(text, url) {
  let s = String(text ?? '');
  if (url) {
    s = s.split(url).join('[DB_URL 가림]');
    try {
      const u = new URL(url);
      if (u.password) s = s.split(u.password).join('[가림]');
      if (u.username) s = s.split(`${u.username}:`).join('[가림]:');
      if (u.host) s = s.split(u.host).join('[호스트 가림]');
    } catch { /* 형식이 아니면 위 split만으로 충분하다 */ }
  }
  return s.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[DB_URL 가림]');
}

// ── psql ──
//
// 결과를 파일로 받는다. 파이프로 받으면 오류 문구에 접속 문자열이 섞여
// 그대로 로그에 실리는 일이 생긴다.
function psql(url, args, opts = {}) {
  try {
    const out = execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-X', '-q', ...args], {
      stdio: 'pipe', encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000,
      env: { ...process.env, PGCONNECT_TIMEOUT: '15' },
    });
    return { ok: true, out: String(out) };
  } catch (e) {
    const raw = [e?.stderr, e?.stdout, e?.message].map(x => String(x ?? '')).join('\n').trim();
    return { ok: false, out: '', error: scrub(raw, url).slice(0, 2000) };
  }
}

/** 한 줄짜리 값들을 탭으로 받아 온다 */
function query(url, sql) {
  const r = psql(url, ['-At', '-F', '\t', '-c', sql]);
  if (!r.ok) return { ok: false, rows: [], error: r.error };
  const rows = r.out.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('\t'));
  return { ok: true, rows };
}

function sqlLit(v) {
  if (v == null) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── 결과 보고 ──
const report = {
  mode: MODE, ok: false, code: 'UNKNOWN', reason: '',
  required: 0, applied: [], adopted: [], pending: [], blocked: [], failed: [], verified: [], drift: [],
};

function say(line) { console.log(line); }
function finish(code, reason, exitCode) {
  report.code = code;
  report.reason = reason;
  report.ok = exitCode === 0;
  const json = JSON.stringify(report, null, 2);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `pending=${report.pending.length}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `blocked=${report.blocked.length}\n`);
  }
  if (process.env.MIGRATION_REPORT_PATH) writeFileSync(process.env.MIGRATION_REPORT_PATH, json);
  say('');
  say(`결과: ${code} — ${reason}`);
  process.exit(exitCode);
}

// ── 시작 ──
const { url, from } = dbUrl();
if (!url) {
  // **여기서 조용히 통과하지 않는다.** "확인하지 못했다"와 "다 됐다"는 다르다.
  say('::error::DB 접속 정보가 없습니다 (SUPABASE_DB_URL / DATABASE_URL / POSTGRES_URL 중 하나)');
  say('이 값이 없으면 마이그레이션을 자동으로 적용할 수 없습니다 — 값은 로그에 찍지 않습니다.');
  finish('NO_CREDENTIAL', '접속 정보가 없어 아무것도 확인하지 못했습니다', 1);
}
say(`DB 접속 정보: ${from} (지문 ${fingerprint(url)}, 값은 출력하지 않습니다)`);

const { classifyMigration, migrationIdOf, migrationPlanOf, migrationTargets, migrationDrift } = await loadPlan();

// 번호가 붙은 파일만 자동 파이프라인 대상이다. 나머지는 사본·구파일이고
// gen-migration-manifest.mjs의 LEGACY에 이유가 적혀 있다(CI가 검사한다).
const files = readMigrationFiles()
  .map(f => ({ name: f.name, id: migrationIdOf(f.name), sql: f.sql }))
  .filter(f => f.id != null);
report.required = files.length;
say(`마이그레이션 파일 ${files.length}개 (번호 없는 ${Object.keys(LEGACY).length}개는 자동 대상 아님)`);

// ── 1. 기록표 준비 ──
const bootstrap = files.find(f => f.name.startsWith('000_'));
if (!bootstrap) finish('NO_BOOTSTRAP', '000_schema_migrations.sql이 없습니다', 1);

if (MODE === 'apply') {
  const r = psql(url, ['--single-transaction', '-f', join(MIG_DIR, bootstrap.name)]);
  if (!r.ok) {
    say(`::error::기록표를 만들지 못했습니다: ${r.error}`);
    finish('BOOTSTRAP_FAILED', '기록표(schema_migrations)를 만들지 못했습니다', 1);
  }
  say('기록표 준비 완료 (schema_migrations · schema_migration_lock)');
}

// ── 적용 기록 읽기 ──
//
// **못 읽으면 null이다.** 빈 배열로 두면 "아무것도 적용 안 됨"이 되고,
// 그 상태로 자동 적용을 돌리면 이미 적용된 것을 다시 실행한다.
let rows = null;
{
  const q = query(url, `SELECT filename, checksum, status FROM schema_migrations`);
  if (q.ok) {
    rows = q.rows.map(r => ({ name: r[0], checksum: r[1] || null, success: r[2] !== 'FAILED' }));
  } else if (/does not exist|relation .* does not exist/i.test(q.error || '')) {
    rows = MODE === 'apply' ? [] : null;   // check 모드에서는 표가 없으면 '모름'
    if (rows) say('기록표가 비어 있습니다 — 첫 실행입니다');
  } else {
    say(`::warning::적용 기록을 읽지 못했습니다: ${q.error}`);
  }
}

// ── 2. 이미 있는 것 채택 ──
//
// 이 저장소는 이 파이프라인이 생기기 전에 53개를 손으로 적용했다.
// 그걸 "기록이 없으니 미적용"으로 보면 53개를 다시 실행한다.
// 그렇다고 "아마 적용했겠지"로 적으면 그건 증거 없는 기록이다.
//
// **카탈로그에 실제로 있는지 확인하고, 있는 것만 적는다.**
async function catalogHas(target) {
  const t = sqlLit(target.table), n = sqlLit(target.name);
  const sql = {
    table: `SELECT 1 FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_name = ${t} LIMIT 1`,
    column: `SELECT 1 FROM information_schema.columns WHERE table_name = ${t} AND column_name = ${n} LIMIT 1`,
    index: `SELECT 1 FROM pg_indexes WHERE indexname = ${n} LIMIT 1`,
    policy: `SELECT 1 FROM pg_policies WHERE tablename = ${t} AND policyname = ${n} LIMIT 1`,
  }[target.kind];
  if (!sql) return null;
  const q = query(url, sql);
  if (!q.ok) return null;              // 못 읽었다 → 없다고 단정하지 않는다
  return q.rows.length > 0;
}

async function verifyTargets(f) {
  const targets = migrationTargets(f.sql);
  if (targets.length === 0) return { checked: 0, missing: [], unknown: 0, verdict: 'NO_TARGET' };
  const missing = [];
  let unknown = 0;
  for (const t of targets) {
    const has = await catalogHas(t);
    if (has === null) unknown += 1;
    else if (!has) missing.push(`${t.kind} ${t.table}.${t.name}`);
  }
  return {
    checked: targets.length, missing, unknown,
    verdict: missing.length ? 'MISSING' : unknown ? 'UNKNOWN' : 'PRESENT',
  };
}

if (rows && MODE === 'apply') {
  const known = new Set(rows.map(r => r.name));
  for (const f of files) {
    if (known.has(f.name)) continue;
    const v = await verifyTargets(f);
    if (v.verdict !== 'PRESENT') continue;   // 증거가 없으면 채택하지 않는다
    const ins = psql(url, ['-c',
      `INSERT INTO schema_migrations (filename, checksum, applied_by, runtime_sha, status, verified, verify_detail)
       VALUES (${sqlLit(f.name)}, ${sqlLit(checksumOf(f.sql))}, 'baseline-verified', ${sqlLit(RUNTIME_SHA)}, 'BASELINE', true,
               ${sqlLit(`대상 ${v.checked}개가 이미 존재함 — 실행하지 않고 적용된 것으로 기록`)})
       ON CONFLICT (filename) DO NOTHING`]);
    if (ins.ok) {
      rows.push({ name: f.name, checksum: checksumOf(f.sql), success: true });
      report.adopted.push(f.name);
    }
  }
  if (report.adopted.length) {
    say(`이미 적용돼 있던 ${report.adopted.length}개를 실행 없이 기록했습니다 (카탈로그에서 확인함)`);
  }
}

// ── 3. 계획 ──
const plan = migrationPlanOf({ files, applied: rows ? rows.filter(r => r.success).map(r => r.name) : null });
report.applied = plan.applied;
report.pending = plan.pending;
report.blocked = plan.blocked;

if (rows) {
  const drift = migrationDrift({ files, rows, checksumOf: f => checksumOf(f.sql) });
  report.drift = drift;
  for (const d of drift) say(`::warning::${d.name} — ${d.reason}`);
}

say('');
say(`적용됨 ${plan.applied.length} / 남음 ${plan.pending.length} / 승인 필요 ${plan.blocked.length}`);
for (const b of plan.blocked) say(`  ⛔ ${b.name} — ${b.risk}: ${b.reasons.join(' · ')}`);
for (const n of plan.autoApply) say(`  ▶ ${n}`);

if (plan.code === 'UNKNOWN') finish('UNKNOWN', plan.reason, 1);
if (plan.code === 'UP_TO_DATE') finish('UP_TO_DATE', plan.reason, 0);

if (MODE === 'check') {
  // 확인만 하는 모드. **남은 것이 있으면 통과가 아니다** — 이 상태로 새
  // 코드를 배포하면 코드가 요구하는 칸이 DB에 없는 채로 돌게 된다.
  const code = plan.blocked.length ? 'NEEDS_APPROVAL' : 'PENDING';
  finish(code, plan.reason, 1);
}

// ── 4. 잠금 ──
{
  const q = query(url, `
    INSERT INTO schema_migration_lock (id, holder, acquired_at) VALUES (1, ${sqlLit(HOLDER)}, now())
    ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, acquired_at = now()
    WHERE schema_migration_lock.acquired_at < now() - interval '15 minutes'
    RETURNING holder`);
  if (!q.ok) finish('LOCK_FAILED', `잠금을 얻지 못했습니다: ${q.error}`, 1);
  if (q.rows.length === 0 || q.rows[0][0] !== HOLDER) {
    // 다른 배포가 돌고 있다. **기다리지 않고 멈춘다** — 그쪽이 끝내면 된다.
    finish('LOCKED', '다른 배포가 마이그레이션을 적용하는 중입니다 — 이번에는 아무것도 하지 않았습니다', 1);
  }
  say(`잠금 획득 (${HOLDER})`);
}
const release = () => psql(url, ['-c',
  `DELETE FROM schema_migration_lock WHERE id = 1 AND holder = ${sqlLit(HOLDER)}`]);

// ── 5~7. 적용 · 확인 · 기록 ──
let failed = null;
for (const name of plan.autoApply) {
  const f = files.find(x => x.name === name);
  const started = Date.now();
  say(`적용: ${name}`);
  const r = psql(url, ['--single-transaction', '-f', join(MIG_DIR, name)], { timeoutMs: 300_000 });
  const ms = Date.now() - started;

  if (!r.ok) {
    // **실패도 기록한다.** 다음 실행이 "아무 일도 없었다"고 읽으면 안 된다.
    psql(url, ['-c',
      `INSERT INTO schema_migrations (filename, checksum, applied_by, runtime_sha, status, duration_ms, error, verified)
       VALUES (${sqlLit(name)}, ${sqlLit(checksumOf(f.sql))}, ${sqlLit(APPLIED_BY)}, ${sqlLit(RUNTIME_SHA)}, 'FAILED', ${ms}, ${sqlLit(String(r.error).slice(0, 1500))}, false)
       ON CONFLICT (filename) DO UPDATE SET status='FAILED', error=EXCLUDED.error, applied_at=now(), duration_ms=EXCLUDED.duration_ms, verified=false`]);
    report.failed.push({ name, error: String(r.error).slice(0, 500) });
    say(`::error::${name} 적용 실패 — ${r.error}`);
    failed = name;
    break;                     // **뒤엣것을 이어서 적용하지 않는다**
  }

  // psql이 0으로 끝난 것과 표가 생긴 것은 다른 사실이다.
  const v = await verifyTargets(f);
  const verified = v.verdict === 'PRESENT' || v.verdict === 'NO_TARGET';
  const detail = v.verdict === 'PRESENT' ? `대상 ${v.checked}개 확인`
    : v.verdict === 'NO_TARGET' ? '확인할 대상 없음 (실행은 성공)'
    : v.verdict === 'MISSING' ? `없음: ${v.missing.join(', ')}`
    : `${v.unknown}개를 확인하지 못함`;

  psql(url, ['-c',
    `INSERT INTO schema_migrations (filename, checksum, applied_by, runtime_sha, status, duration_ms, verified, verify_detail)
     VALUES (${sqlLit(name)}, ${sqlLit(checksumOf(f.sql))}, ${sqlLit(APPLIED_BY)}, ${sqlLit(RUNTIME_SHA)}, 'APPLIED', ${ms}, ${verified}, ${sqlLit(detail)})
     ON CONFLICT (filename) DO UPDATE SET status='APPLIED', checksum=EXCLUDED.checksum, applied_at=now(),
       runtime_sha=EXCLUDED.runtime_sha, duration_ms=EXCLUDED.duration_ms, verified=EXCLUDED.verified,
       verify_detail=EXCLUDED.verify_detail, error=NULL`]);

  if (!verified) {
    say(`::error::${name} — 실행은 끝났지만 확인에 실패했습니다: ${detail}`);
    report.failed.push({ name, error: detail });
    failed = name;
    break;
  }
  report.verified.push({ name, detail, ms });
  say(`  ✓ ${detail} (${ms}ms)`);
}

release();

if (failed) finish('APPLY_FAILED', `${failed} 적용/확인 실패 — 뒤의 마이그레이션은 실행하지 않았습니다`, 1);
if (plan.blocked.length > 0) {
  finish('NEEDS_APPROVAL',
    `안전한 ${report.verified.length}개는 적용했습니다. ${plan.blocked.length}개는 되돌릴 수 없는 변경이라 승인이 필요합니다`, 1);
}
finish('APPLIED', `${report.verified.length}개를 적용하고 확인했습니다`, 0);
