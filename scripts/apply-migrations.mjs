#!/usr/bin/env node
// scripts/apply-migrations.mjs
//
// **사람이 Supabase SQL 편집기를 여는 일을 없앤다.**
//
// 사용:
//   node scripts/apply-migrations.mjs --check    적용 계획만 본다 (DB를 바꾸지 않는다)
//   node scripts/apply-migrations.mjs --apply    안전한 것만 적용하고 확인까지 한다
//
//   node scripts/apply-migrations.mjs --apply \\
//     --approve-destructive=085_paper_challenge_accounting.sql \\
//     --approve-sha=<이 실행이 체크아웃한 40자 커밋>
//                                                사람이 명시한 **그 한 파일만** 적용한다
//
// 승인 경로는 왜 있는가
// ─────────────────────
// 위험한 것을 자동으로 실행하지 않는 것까지는 만들어 뒀는데, **승인해서
// 실행하는 문**이 없었다. 그러면 남는 길은 사람이 Supabase 편집기를 열거나
// psql을 직접 치는 것뿐이고, 그건 이 파일이 없애려던 바로 그 상태다.
// 판정을 느슨하게 만드는 대신 **판정은 그대로 두고 통과 절차를 만든다.**
//
//   분류(classifier)  "이건 위험하다"           — 이 승인 경로가 건드리지 않는다
//   승인(사람)        "이 파일·이 내용만 허용"  — 아래 검증 여덟 가지
//   적용(runner)      "승인된 그 하나만 실행"   — autoApply에 섞지 않는다
//
// 승인은 무엇에 묶이는가
// ──────────────────────
// **파일 이름 + 그 시점의 내용 + 정확한 커밋.** `--approve-sha`가 이 실행이
// 체크아웃한 커밋과 다르면 시작도 하지 않는다. 커밋이 같으면 파일 내용도 같으므로
// 승인은 곧 그 체크섬에 묶인다 — 내용이 바뀌면 커밋이 바뀌고, 옛 승인은 무효가 된다.
// 체크섬은 승인 기록에 그대로 남긴다.
//
// 승인해도 넘어가지 않는 것
// ─────────────────────────
// 승인한 이름이 목록에 없거나 · 지금 계획에서 막혀 있지 않거나 · 위험도가
// DESTRUCTIVE가 아니거나 · 이미 적용됐거나 · 승인 대상이 하나가 아니면
// **아무것도 적용하지 않고 실패한다.** 승인하지 않은 다른 blocked는 그대로 막힌다.
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

/** `--이름=값`을 읽는다. 같은 이름이 두 번 오면 **고르지 않고 멈춘다.** */
function argOf(name) {
  const hits = process.argv.filter(a => a.startsWith(`--${name}=`));
  if (hits.length > 1) return { many: true, value: null };
  if (hits.length === 0) return { many: false, value: null };
  return { many: false, value: hits[0].slice(name.length + 3) };
}
const APPROVE_ARG = argOf('approve-destructive');
const APPROVE_SHA_ARG = argOf('approve-sha');
const APPROVE_CHECKSUM_ARG = argOf('approve-checksum');
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
  required: 0, applied: [], adopted: [], adoptable: [], pending: [], blocked: [], failed: [], verified: [], drift: [],
  /**
   * 사람이 승인해서 실행한 위험 마이그레이션. 없으면 null.
   *
   * **schema_migrations에 칸을 새로 만들지 않는다.** 승인 기능을 쓰려고 또
   * 마이그레이션이 필요해지면 순환이다. 흔적은 여기(리포트 아티팩트)와
   * Actions 실행 기록, 그리고 기존 applied_by/runtime_sha/checksum/status로 남긴다.
   */
  approval: null,
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

// ══════════════ 승인 입력 검사 — **DB에 닿기 전에 끝낸다** ══════════════
//
// 접속·잠금·적용 어느 것도 하기 전에 여기서 거른다. 커밋이 어긋난 승인으로
// 잠금을 잡고 들어가면, 실패해도 그 사이 다른 배포가 막힌다.
const APPROVAL = (() => {
  for (const [label, a] of [
    ['--approve-destructive', APPROVE_ARG],
    ['--approve-sha', APPROVE_SHA_ARG],
    ['--approve-checksum', APPROVE_CHECKSUM_ARG],
  ]) {
    if (a.many) {
      say(`::error::${label}가 여러 번 왔습니다 — 어느 것을 승인한 것인지 정할 수 없습니다`);
      finish('APPROVAL_INVALID', `${label}가 중복됐습니다`, 1);
    }
  }
  const name = APPROVE_ARG.value;
  if (name == null) {
    // 승인 인자가 없다. **지금까지와 완전히 같은 실행이다.**
    if (APPROVE_SHA_ARG.value != null || APPROVE_CHECKSUM_ARG.value != null) {
      say('::error::--approve-sha/--approve-checksum만 왔습니다 — 무엇을 승인하는지가 없습니다');
      finish('APPROVAL_INVALID', '승인 대상 파일명이 없습니다', 1);
    }
    return null;
  }

  if (!name.trim()) {
    say('::error::승인 대상 파일명이 비어 있습니다');
    finish('APPROVAL_INVALID', '승인 대상 파일명이 비어 있습니다', 1);
  }
  // 경로를 받지 않는다. 목록에 있는 **이름 그대로**여야 한다.
  if (/[\\/]/.test(name) || name.includes('..')) {
    say(`::error::승인 대상에 경로가 들어 있습니다: ${name}`);
    finish('APPROVAL_INVALID', '승인 대상은 마이그레이션 파일 이름 하나여야 합니다', 1);
  }

  const sha = APPROVE_SHA_ARG.value;
  if (!sha) {
    say('::error::--approve-sha가 없습니다 — 승인은 특정 커밋에 묶여야 합니다');
    say('커밋에 묶지 않으면, 승인한 뒤 파일이 바뀌어도 그 승인이 계속 유효해집니다.');
    finish('APPROVAL_INVALID', '승인에 커밋이 묶이지 않았습니다', 1);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    say('::error::--approve-sha가 40자 커밋 해시가 아닙니다');
    finish('APPROVAL_INVALID', '승인 커밋 형식이 올바르지 않습니다', 1);
  }
  if (!RUNTIME_SHA) {
    say('::error::지금 실행이 어느 커밋인지 알 수 없습니다 (GITHUB_SHA 없음) — 승인을 확인할 수 없습니다');
    finish('APPROVAL_INVALID', '실행 커밋을 확인하지 못했습니다', 1);
  }
  if (RUNTIME_SHA !== sha) {
    // **승인한 커밋과 지금 도는 커밋이 다르다.** 그 사이 파일이 바뀌었을 수 있다.
    say(`::error::승인한 커밋과 이 실행의 커밋이 다릅니다 — 승인: ${sha} / 실행: ${RUNTIME_SHA}`);
    say('그 사이 파일이 바뀌었을 수 있습니다. 지금 커밋을 다시 확인하고 승인하세요.');
    finish('APPROVAL_SHA_MISMATCH', '승인 커밋이 이 실행의 커밋과 다릅니다', 1);
  }

  say(`승인 입력 확인: ${name} @ ${sha}`);
  return { name, sha, checksum: APPROVE_CHECKSUM_ARG.value };
})();

// ── 시작 ──
const { url, from } = dbUrl();
if (!url) {
  // **여기서 조용히 통과하지 않는다.** "확인하지 못했다"와 "다 됐다"는 다르다.
  say('::error::DB 접속 정보가 없습니다 (SUPABASE_DB_URL / DATABASE_URL / POSTGRES_URL 중 하나)');
  say('이 값이 없으면 마이그레이션을 자동으로 적용할 수 없습니다 — 값은 로그에 찍지 않습니다.');
  finish('NO_CREDENTIAL', '접속 정보가 없어 아무것도 확인하지 못했습니다', 1);
}
say(`DB 접속 정보: ${from} (지문 ${fingerprint(url)}, 값은 출력하지 않습니다)`);

const { classifyMigration, migrationIdOf, migrationPlanOf, migrationTargets, migrationDrift,
        adoptionCandidates } = await loadPlan();

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
    // 함수는 pg_proc에 있다. 인자 조합이 여럿일 수 있으므로 이름만 본다 —
    // **있는지 없는지**가 여기서 답할 질문이고, 시그니처까지는 SQL 자신이
    // 트랜잭션 안에서 보장한다.
    function: `SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = ${t} AND p.proname = ${n} LIMIT 1`,
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

// ── 채택 자격을 **먼저** 묻는다 ──
//
// 예전에는 카탈로그부터 물었다. 그래서 위험도 분류가 돌기 전에 채택이
// 끝났고, UNKNOWN·DESTRUCTIVE가 승인 없이 BASELINE으로 적혔다
// (081/082, migrate run 34661664896).
//
// **거를 자리를 두지 않는다.** 자리마다 `if (!adoptable) continue`로 걸렀더니
// 돌연변이로 그 한 줄만 무력화해도 뚫렸다. 지금은 `adoptionCandidates`가
// 돌려준 목록만 돈다 — 막힌 파일은 애초에 목록에 없다. 판정은 계획과 같은
// `classifyMigration`을 쓰므로 두 곳이 갈릴 수 없다.
//
// **두 모드가 같은 목록을 쓴다.** check는 적지 않을 뿐이다.
{
  const appliedNames = rows ? rows.map(r => r.name) : null;
  const { adopt, refused } = adoptionCandidates({ files, applied: appliedNames });

  for (const f of adopt) {
    const v = await verifyTargets(f);
    if (v.verdict !== 'PRESENT') continue;   // 증거가 없으면 채택하지 않는다

    // check 모드는 **읽기만** 한다. 무엇이 채택될지는 알려 주되 적지 않는다.
    if (MODE !== 'apply') { report.adoptable.push(f.name); continue; }

    const ins = psql(url, ['-c',
      `INSERT INTO schema_migrations (filename, checksum, applied_by, runtime_sha, status, verified, verify_detail)
       VALUES (${sqlLit(f.name)}, ${sqlLit(checksumOf(f.sql))}, 'baseline-verified', ${sqlLit(RUNTIME_SHA)}, 'BASELINE', true,
               ${sqlLit(`대상 ${v.checked}개가 이미 존재함 — 실행하지 않고 적용된 것으로 기록`)})
       ON CONFLICT (filename) DO NOTHING`]);
    if (ins.ok && rows) {
      rows.push({ name: f.name, checksum: checksumOf(f.sql), success: true });
      report.adopted.push(f.name);
    }
  }

  if (report.adopted.length) {
    say(`이미 적용돼 있던 ${report.adopted.length}개를 실행 없이 기록했습니다 (카탈로그에서 확인함)`);
  }
  if (report.adoptable.length) {
    say(`채택 가능 ${report.adoptable.length}개 (check 모드라 기록하지 않았습니다)`);
  }
  // 왜 채택하지 않는지 남긴다. 이유 없이 조용히 넘기면 다음 사람이
  // "왜 매번 실행되지"를 다시 파야 한다.
  for (const r of refused) say(`  채택하지 않음: ${r.name} — ${r.code}: ${r.reason}`);
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

// ══════════════ 승인이 실제로 그 파일에 유효한가 ══════════════
//
// **여기서 통과하지 못하면 아무것도 적용하지 않는다.** 승인은 "이 이름"이 아니라
// "지금 계획에서 실제로 막혀 있는, 위험도가 DESTRUCTIVE인, 아직 적용되지 않은,
// 정확히 그 한 파일"에만 유효하다.
const approved = (() => {
  if (!APPROVAL) return null;

  const f = files.find(x => x.name === APPROVAL.name);
  if (!f) {
    say(`::error::승인한 이름이 마이그레이션 목록에 없습니다: ${APPROVAL.name}`);
    finish('APPROVAL_UNKNOWN_FILE', `${APPROVAL.name}은 마이그레이션 파일이 아닙니다`, 1);
  }

  // 이미 적용된 것을 다시 승인하는 것은 통과가 아니다 — 무엇을 하려는지가 불분명하다.
  if (plan.applied.includes(APPROVAL.name)) {
    say(`::error::${APPROVAL.name}은 이미 적용돼 있습니다 — 승인할 것이 없습니다`);
    finish('APPROVAL_ALREADY_APPLIED', `${APPROVAL.name}은 이미 적용된 파일입니다`, 1);
  }

  const entry = plan.blocked.find(b => b.name === APPROVAL.name);
  if (!entry) {
    // 안전한 것(ADDITIVE)은 승인 경로로 넣지 않는다. 그건 그냥 자동으로 간다.
    say(`::error::${APPROVAL.name}은 지금 계획에서 승인 대기 상태가 아닙니다`);
    say('이 경로는 위험해서 막힌 파일 하나를 통과시키는 자리입니다 — 안전한 것은 그냥 자동 적용됩니다.');
    finish('APPROVAL_NOT_BLOCKED', `${APPROVAL.name}은 승인이 필요한 파일이 아닙니다`, 1);
  }

  // **DESTRUCTIVE만이다.** UNKNOWN은 "모르는 문장"이라 사람이 이름만 보고
  // 승인할 수 있는 종류가 아니다 — 그건 먼저 분류를 정해야 한다.
  if (entry.risk !== 'DESTRUCTIVE') {
    say(`::error::${APPROVAL.name}의 위험도가 ${entry.risk}입니다 — 이 경로는 DESTRUCTIVE만 통과시킵니다`);
    say('UNKNOWN은 무슨 일이 일어나는지 아직 아무도 모르는 상태라, 이름만 보고 승인할 수 없습니다.');
    finish('APPROVAL_RISK_MISMATCH', `${APPROVAL.name}은 DESTRUCTIVE가 아닙니다 (${entry.risk})`, 1);
  }

  // **순서를 건너뛰지 않는다.**
  //
  // 계획은 "막힌 것이 하나라도 있으면 그 앞까지만" 적용한다. 승인이 그 규칙을
  // 넘어서면, 앞에 막혀 있는 번호를 건너뛰고 뒤엣것이 먼저 들어간다 — 스키마가
  // 뒤엉키고, 그 뒤로는 어느 순서로 적용된 DB인지 아무도 말할 수 없다.
  // 앞에 막힌 것이 있으면 **그것부터** 승인해야 한다.
  const beforeApproved = plan.pending.slice(0, plan.pending.indexOf(APPROVAL.name));
  const blockedBefore = beforeApproved.filter(n => plan.blocked.some(b => b.name === n));
  if (blockedBefore.length > 0) {
    say(`::error::${APPROVAL.name} 앞에 아직 막혀 있는 것이 있습니다: ${blockedBefore.join(', ')}`);
    say('순서를 건너뛰고 뒤엣것을 먼저 적용하면 스키마가 뒤엉킵니다 — 앞의 것부터 승인하세요.');
    finish('APPROVAL_OUT_OF_ORDER',
      `${APPROVAL.name} 앞의 ${blockedBefore.length}개가 아직 승인되지 않았습니다`, 1);
  }

  const sum = checksumOf(f.sql);
  if (APPROVAL.checksum != null && APPROVAL.checksum !== sum) {
    say(`::error::${APPROVAL.name}의 내용이 승인한 것과 다릅니다`);
    finish('APPROVAL_CHECKSUM_MISMATCH', `${APPROVAL.name}의 체크섬이 승인 값과 다릅니다`, 1);
  }

  say('');
  say(`★ 승인됨: ${APPROVAL.name} (${entry.risk}: ${entry.reasons.join(' · ')})`);
  say(`  체크섬 ${sum} · 커밋 ${APPROVAL.sha}`);
  const stillBlocked = plan.blocked.filter(b => b.name !== APPROVAL.name);
  if (stillBlocked.length) {
    // **승인은 하나에만 유효하다.** 나머지는 그대로 막힌 채로 둔다.
    say(`  나머지 ${stillBlocked.length}개는 승인되지 않았으므로 그대로 막힙니다: ${stillBlocked.map(b => b.name).join(', ')}`);
  }
  return { name: APPROVAL.name, file: f, checksum: sum, risk: entry.risk, sha: APPROVAL.sha, stillBlocked };
})();

if (approved) {
  report.approval = {
    filename: approved.name,
    checksum: approved.checksum,
    risk: approved.risk,
    approvedSha: approved.sha,
    runId: String(process.env.GITHUB_RUN_ID || '') || null,
    runtimeSha: RUNTIME_SHA,
    actor: String(process.env.GITHUB_ACTOR || '') || null,
    via: String(process.env.GITHUB_EVENT_NAME || '') || 'local',
    stillBlocked: approved.stillBlocked.map(b => b.name),
  };
}

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
//
// **한 파일을 적용하는 절차는 한 곳에만 둔다.** 자동 적용과 승인 적용이 각자
// 자기 절차를 가지면, 언젠가 한쪽만 고쳐지고 그쪽만 확인·기록을 빠뜨린다.
let failed = null;

/**
 * 파일 하나를 적용하고, 실제로 생겼는지 확인하고, 결과를 기록한다.
 * @returns 성공했으면 true. 실패하면 기록까지 남기고 false.
 */
async function applyOne(f, { approvedBy = null } = {}) {
  const name = f.name;
  const started = Date.now();
  say(approvedBy ? `적용(승인됨): ${name}` : `적용: ${name}`);
  const r = psql(url, ['--single-transaction', '-f', join(MIG_DIR, name)], { timeoutMs: 300_000 });
  const ms = Date.now() - started;

  if (!r.ok) {
    // **실패도 기록한다.** 다음 실행이 "아무 일도 없었다"고 읽으면 안 된다.
    psql(url, ['-c',
      `INSERT INTO schema_migrations (filename, checksum, applied_by, runtime_sha, status, duration_ms, error, verified)
       VALUES (${sqlLit(name)}, ${sqlLit(checksumOf(f.sql))}, ${sqlLit(approvedBy || APPLIED_BY)}, ${sqlLit(RUNTIME_SHA)}, 'FAILED', ${ms}, ${sqlLit(String(r.error).slice(0, 1500))}, false)
       ON CONFLICT (filename) DO UPDATE SET status='FAILED', error=EXCLUDED.error, applied_at=now(), duration_ms=EXCLUDED.duration_ms, verified=false`]);
    report.failed.push({ name, error: String(r.error).slice(0, 500) });
    say(`::error::${name} 적용 실패 — ${r.error}`);
    return false;
  }

  // psql이 0으로 끝난 것과 표가 생긴 것은 다른 사실이다.
  const v = await verifyTargets(f);
  const verified = v.verdict === 'PRESENT' || v.verdict === 'NO_TARGET';
  const detail = v.verdict === 'PRESENT' ? `대상 ${v.checked}개 확인`
    : v.verdict === 'NO_TARGET' ? '확인할 대상 없음 (실행은 성공)'
    : v.verdict === 'MISSING' ? `없음: ${v.missing.join(', ')}`
    : `${v.unknown}개를 확인하지 못함`;

  // 승인해서 실행한 것은 `applied_by`에 그 사실을 남긴다. 새 칸을 만들지 않고
  // 기존 칸으로 "누가 어떻게 넣었는가"를 말한다.
  psql(url, ['-c',
    `INSERT INTO schema_migrations (filename, checksum, applied_by, runtime_sha, status, duration_ms, verified, verify_detail)
     VALUES (${sqlLit(name)}, ${sqlLit(checksumOf(f.sql))}, ${sqlLit(approvedBy || APPLIED_BY)}, ${sqlLit(RUNTIME_SHA)}, 'APPLIED', ${ms}, ${verified}, ${sqlLit(detail)})
     ON CONFLICT (filename) DO UPDATE SET status='APPLIED', checksum=EXCLUDED.checksum, applied_at=now(),
       applied_by=EXCLUDED.applied_by, runtime_sha=EXCLUDED.runtime_sha, duration_ms=EXCLUDED.duration_ms,
       verified=EXCLUDED.verified, verify_detail=EXCLUDED.verify_detail, error=NULL`]);

  if (!verified) {
    say(`::error::${name} — 실행은 끝났지만 확인에 실패했습니다: ${detail}`);
    report.failed.push({ name, error: detail });
    return false;
  }
  report.verified.push({ name, detail, ms, approved: Boolean(approvedBy) });
  say(`  ✓ ${detail} (${ms}ms)`);
  return true;
}

for (const name of plan.autoApply) {
  const f = files.find(x => x.name === name);
  if (!(await applyOne(f))) { failed = name; break; }   // **뒤엣것을 이어서 적용하지 않는다**
}

// ── 승인된 그 하나 ──
//
// `plan.autoApply`에 섞지 않는다. 섞는 순간 "자동으로 갈 수 있는 것"의 정의가
// 흐려지고, 다음에 destructive가 하나 더 생기면 같이 딸려 갈 길이 열린다.
// 앞의 자동 적용이 하나라도 실패했으면 여기까지 오지 않는다.
let approvalApplied = false;
if (!failed && approved) {
  const by = `approved:${String(process.env.GITHUB_ACTOR || APPLIED_BY).slice(0, 40)}`;
  approvalApplied = await applyOne(approved.file, { approvedBy: by });
  if (!approvalApplied) failed = approved.name;
  if (report.approval) report.approval.applied = approvalApplied;
}

release();

if (failed) finish('APPLY_FAILED', `${failed} 적용/확인 실패 — 뒤의 마이그레이션은 실행하지 않았습니다`, 1);

// 승인되지 않고 남은 위험한 것들. **승인한 하나만 빠진다.**
const stillBlocked = approved ? plan.blocked.filter(b => b.name !== approved.name) : plan.blocked;
if (stillBlocked.length > 0) {
  finish('NEEDS_APPROVAL',
    `안전한 ${report.verified.length}개는 적용했습니다. ${stillBlocked.length}개는 되돌릴 수 없는 변경이라 승인이 필요합니다`, 1);
}
if (approvalApplied) {
  finish('APPLIED',
    `${report.verified.length}개를 적용하고 확인했습니다 (승인된 ${approved.name} 포함)`, 0);
}
finish('APPLIED', `${report.verified.length}개를 적용하고 확인했습니다`, 0);
