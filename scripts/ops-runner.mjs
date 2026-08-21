#!/usr/bin/env node
// scripts/ops-runner.mjs
//
// **"배포해" 한 마디를 실제 배포로 바꾼다.**
//
// 화면(Vercel)은 GitHub 워크플로를 부를 자격도, Fly 머신을 만질 자격도
// 없다. 그 자격은 GitHub Actions가 이미 가지고 있다 —
// `GITHUB_TOKEN`과 `FLY_API_TOKEN`. 그래서 새 토큰을 하나 더 만들지 않고,
// **이미 자격을 가진 쪽이 요청을 집어 간다.**
//
// 큐를 읽고 쓰는 데 쓰는 것은 `SUPABASE_DB_URL` 하나다. 그건 마이그레이션
// 자동화에 이미 필요한 값이라, **이 기능이 새로 요구하는 권한은 0이다.**
//
// 사용: node scripts/ops-runner.mjs
//
// **값은 어디에도 출력하지 않는다.** 접속 문자열은 지문만, 오류 문구에서도
// 지우고 찍는다.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const ME = `gh:${String(process.env.GITHUB_RUN_ID || 'local').slice(0, 24)}`;
const REPO = String(process.env.GITHUB_REPOSITORY || '').trim();

function fingerprint(v) {
  return v ? createHash('sha256').update(String(v)).digest('hex').slice(0, 6) : null;
}

function dbUrl() {
  for (const k of ['SUPABASE_DB_URL', 'DATABASE_URL', 'POSTGRES_URL']) {
    const v = String(process.env[k] || '').trim();
    if (v) return { url: v, from: k };
  }
  return { url: '', from: null };
}

function scrub(text, url) {
  let s = String(text ?? '');
  if (url) {
    s = s.split(url).join('[DB_URL 가림]');
    try {
      const u = new URL(url);
      if (u.password) s = s.split(u.password).join('[가림]');
      if (u.host) s = s.split(u.host).join('[호스트 가림]');
    } catch { /* 형식이 아니면 위 split으로 충분하다 */ }
  }
  return s.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[DB_URL 가림]')
    .replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, '[토큰 가림]');
}

const { url: DB, from } = dbUrl();
if (!DB) {
  // **조용히 통과하지 않는다.** 요청을 못 읽은 것과 요청이 없는 것은 다르다.
  console.log('::warning::SUPABASE_DB_URL이 없어 운영 요청을 읽지 못했습니다 — 이번 회차는 아무것도 하지 않습니다');
  process.exit(0);
}
console.log(`요청 큐 접속: ${from} (지문 ${fingerprint(DB)}, 값은 출력하지 않습니다)`);

function q(sql) {
  try {
    const out = execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-X', '-At', '-F', '\t', '-c', sql],
      { stdio: 'pipe', encoding: 'utf8', timeout: 60_000, env: { ...process.env, PGCONNECT_TIMEOUT: '15' } });
    return { ok: true, rows: String(out).split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('\t')) };
  } catch (e) {
    const raw = [e?.stderr, e?.stdout, e?.message].map(x => String(x ?? '')).join('\n');
    return { ok: false, rows: [], error: scrub(raw, DB).slice(0, 800) };
  }
}

const lit = v => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// ── 판단은 opsQueue.ts에 있다. 복제하지 않고 컴파일해서 쓴다 ──
async function loadQueue() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-ops-'));
  cpSync(join(ROOT, 'src', 'lib', 'ops', 'opsQueue.ts'), join(dir, 'opsQueue.ts'));
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('TypeScript를 찾을 수 없습니다 — 먼저 npm ci');
  execFileSync(process.execPath, [tsc, 'opsQueue.ts', '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
    { cwd: dir, stdio: 'pipe' });
  return await import(`file://${join(dir, 'opsQueue.js')}`);
}

const { claimDecision, runOutcomeOf } = await loadQueue();

// 표가 아직 없으면 059가 적용되기 전이다. **오류가 아니라 '아직'이다.**
const probe = q(`SELECT to_regclass('public.ops_requests') IS NOT NULL`);
if (!probe.ok) {
  console.log(`::warning::요청 표를 확인하지 못했습니다: ${probe.error}`);
  process.exit(0);
}
if (probe.rows[0]?.[0] !== 't') {
  console.log('요청 표(ops_requests)가 아직 없습니다 — 마이그레이션 059가 적용되면 동작합니다');
  process.exit(0);
}

const listed = q(`
  SELECT id, command, status, approved,
         EXTRACT(EPOCH FROM requested_at) * 1000,
         EXTRACT(EPOCH FROM claimed_at) * 1000, claimed_by
  FROM ops_requests
  WHERE status IN ('PENDING', 'CLAIMED')
  ORDER BY requested_at ASC LIMIT 20`);

const rows = listed.ok ? listed.rows.map(r => ({
  id: r[0], command: r[1], status: r[2], approved: r[3] === 't',
  requestedAtMs: Number(r[4]) || 0,
  claimedAtMs: r[5] ? Number(r[5]) : null,
  claimedBy: r[6] || null,
})) : undefined;

const d = claimDecision({ rows, me: ME, nowMs: Date.now() });
console.log(`${d.code} — ${d.reason}`);

if (d.code !== 'CLAIM') {
  // 승인 대기·만료·모르는 명령은 그 사실을 요청에 적어 둔다.
  // **적어 두지 않으면 사용자는 "눌렀는데 아무 일도 없다"만 본다.**
  if (d.row && (d.code === 'EXPIRED' || d.code === 'UNKNOWN_COMMAND' || d.code === 'NEEDS_APPROVAL')) {
    const status = d.code === 'NEEDS_APPROVAL' ? 'PENDING' : 'EXPIRED';
    q(`UPDATE ops_requests SET status = ${lit(status)}, error = ${lit(d.reason)}
       ${status === 'EXPIRED' ? ', finished_at = now()' : ''} WHERE id = ${lit(d.row.id)}`);
  }
  process.exit(0);
}

// ── 집어 간다. 이미 남이 가져갔으면 0줄이 돌아온다 ──
const claimed = q(`
  UPDATE ops_requests SET status = 'CLAIMED', claimed_by = ${lit(ME)}, claimed_at = now()
  WHERE id = ${lit(d.row.id)} AND status IN ('PENDING', 'CLAIMED')
  RETURNING id`);
if (!claimed.ok || claimed.rows.length === 0) {
  console.log('다른 실행기가 먼저 가져갔습니다 — 이번은 아무것도 하지 않습니다');
  process.exit(0);
}
console.log(`집어 감: ${d.row.command} (${d.row.id})`);

// ── 실행 ──
const steps = [];
const step = (name, fn) => {
  try {
    const detail = fn() ?? '';
    steps.push({ step: name, ok: true, detail: String(detail).slice(0, 300) });
    console.log(`  ✓ ${name} ${detail}`);
  } catch (e) {
    const msg = scrub(String(e?.stderr || e?.message || e), DB).slice(0, 300);
    steps.push({ step: name, ok: false, detail: msg });
    console.log(`::error::${name} 실패 — ${msg}`);
  }
};

function gh(args) {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  if (!token) throw new Error('GITHUB_TOKEN이 없습니다');
  if (!REPO) throw new Error('GITHUB_REPOSITORY를 알 수 없습니다');
  const out = execFileSync('curl', [
    '-sS', '-X', 'POST', '-w', '\n%{http_code}',
    '-H', 'Accept: application/vnd.github+json',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    `https://api.github.com/repos/${REPO}/actions/workflows/${args.workflow}/dispatches`,
    '-d', JSON.stringify({ ref: args.ref || 'main' }),
  ], { encoding: 'utf8', timeout: 60_000 });
  const code = String(out).trim().split('\n').pop();
  if (code !== '204') throw new Error(`${args.workflow} 요청이 HTTP ${code}로 끝났습니다`);
  return `${args.workflow} 실행 요청됨`;
}

function flyctl(args) {
  if (!String(process.env.FLY_API_TOKEN || '').trim()) throw new Error('FLY_API_TOKEN이 없습니다');
  const out = execFileSync('flyctl', args, { encoding: 'utf8', timeout: 300_000, cwd: ROOT });
  return String(out).trim().split('\n').slice(-1)[0] || '완료';
}

const cmd = d.row.command;
if (cmd === 'DEPLOY' || cmd === 'APPROVE_LIVE_SMALL') {
  // **마이그레이션이 먼저다.** 코드만 앞서 나가면 조용히 틀린다.
  step('마이그레이션', () => gh({ workflow: 'migrate.yml' }));
  step('워커 배포', () => gh({ workflow: 'fly-deploy.yml' }));
} else if (cmd === 'RECOVER') {
  // 안전한 자가 복구만 한다. **값을 바꾸는 복구(시크릿 교체 등)는 하지 않는다.**
  step('마이그레이션', () => gh({ workflow: 'migrate.yml' }));
  // 워커 재시작. 열린 주문 확인은 화면 쪽 autoFixPlan이 이미 했고,
  // 여기서 다시 확인할 방법이 없으므로 **재배포가 아니라 재시작만** 한다.
  step('워커 재시작', () => flyctl(['machine', 'restart', '--select', '--app', 'auto-platform']));
}

const outcome = runOutcomeOf(steps);
q(`UPDATE ops_requests
   SET status = ${lit(outcome.status)}, finished_at = now(),
       result = ${lit(JSON.stringify({ summary: outcome.summary, steps: outcome.steps }))}::jsonb,
       error = ${lit(outcome.error)}
   WHERE id = ${lit(d.row.id)}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## 운영 명령 ${cmd} — ${outcome.status}\n\n${outcome.summary}\n\n`
    + steps.map(s => `- ${s.ok ? '✓' : '✗'} **${s.step}** ${s.detail}`).join('\n') + '\n', { flag: 'a' });
}

console.log(`${outcome.status} — ${outcome.summary}`);
process.exit(outcome.status === 'DONE' ? 0 : 1);
