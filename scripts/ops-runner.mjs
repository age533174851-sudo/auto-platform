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
import { mkdtempSync, cpSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
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
async function loadLib() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-ops-'));
  // 판단하는 파일들만 복사한다. selfHeal.ts는 runtimeHealth의 타입만
  // 쓰므로 그것도 같이 가져온다(타입은 컴파일 뒤 사라진다).
  cpSync(join(ROOT, 'src', 'lib', 'ops', 'opsQueue.ts'), join(dir, 'opsQueue.ts'));
  // opsQueue는 실행 가능한 명령 목록을 opsCommand에서 뽑아 쓴다 —
  // **목록을 두 곳에 두지 않으려고 그렇게 했으므로** 같이 가져와야 한다.
  cpSync(join(ROOT, 'src', 'lib', 'ops', 'opsCommand.ts'), join(dir, 'opsCommand.ts'));
  cpSync(join(ROOT, 'src', 'lib', 'ops', 'selfHeal.ts'), join(dir, 'selfHeal.ts'));
  cpSync(join(ROOT, 'src', 'lib', 'runtime', 'runtimeHealth.ts'), join(dir, 'runtimeHealth.ts'));
  // selfHeal.ts는 '../runtime/runtimeHealth'를 참조한다. 평평하게 놓았으므로
  // 경로만 바꿔 준다 — **판단 자체는 한 글자도 고치지 않는다.**
  const heal = readFileSync(join(dir, 'selfHeal.ts'), 'utf8')
    .replace("from '../runtime/runtimeHealth'", "from './runtimeHealth'");
  writeFileSync(join(dir, 'selfHeal.ts'), heal);
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('TypeScript를 찾을 수 없습니다 — 먼저 npm ci');
  execFileSync(process.execPath, [tsc, 'opsQueue.ts', 'opsCommand.ts', 'selfHeal.ts', 'runtimeHealth.ts',
    '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { cwd: dir, stdio: 'pipe' });
  return {
    ...(await import(`file://${join(dir, 'opsQueue.js')}`)),
    ...(await import(`file://${join(dir, 'selfHeal.js')}`)),
    ...(await import(`file://${join(dir, 'runtimeHealth.js')}`)),
  };
}

const {
  claimDecision, runOutcomeOf, healPlan, healVerdict, deployVerification, runtimeHealthOf,
} = await loadLib();

// ── 워커 상태를 DB에서 직접 읽는다 ──
//
// 화면을 거치지 않는다. **사람이 fly logs를 여는 일을 없애는 것이 목적인데
// 실행기가 사람을 거치면 아무 의미가 없다.**
function readWorker() {
  const r = q(`SELECT worker_id, EXTRACT(EPOCH FROM last_seen) * 1000, status, version,
                      provider, supabase_fingerprint, encryption_fingerprint, startup_ok, startup_detail
               FROM worker_heartbeat ORDER BY last_seen DESC LIMIT 1`);
  if (!r.ok) return undefined;                 // 못 읽었다
  const row = r.rows[0];
  if (!row) return null;                       // 없다
  return {
    worker_id: row[0] || null,
    last_seen: new Date(Number(row[1]) || 0).toISOString(),
    status: row[2] || null,
    version: row[3] || null,
    provider: row[4] || null,
    supabase_fingerprint: row[5] || null,
    encryption_fingerprint: row[6] || null,
    startup_ok: row[7] === '' ? null : row[7] === 't',
    startup_detail: row[8] || null,
  };
}

function currentHealth(mainSha) {
  const w = readWorker();
  return runtimeHealthOf({ worker: w, mainSha: mainSha || null, nowMs: Date.now() });
}

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

// ── 자격을 실제로 써 본다 ──
//
// **"있을 것으로 보입니다"를 없앤다.** 값이 있는지가 아니라 그 값으로
// 실제로 되는지를 본다 — 있는데 만료된 토큰이 가장 흔한 고장이고,
// 그건 "없음"과 완전히 다른 사실이다.
//
// 값은 어디에도 적지 않는다. 상태 세 가지와 한 줄 설명뿐이다.
function noteCredential(name, state, detail) {
  const has = q(`SELECT to_regclass('public.ops_bootstrap') IS NOT NULL`);
  if (!has.ok || has.rows[0]?.[0] !== 't') return;   // 060이 아직이면 조용히 넘어간다
  q(`INSERT INTO ops_bootstrap (credential, state, checked_at, checked_by, detail)
     VALUES (${lit(name)}, ${lit(state)}, now(), 'github-actions', ${lit(detail)})
     ON CONFLICT (credential) DO UPDATE
     SET state = EXCLUDED.state, checked_at = now(), checked_by = EXCLUDED.checked_by, detail = EXCLUDED.detail`);
  console.log(`  ${name}: ${state} — ${detail}`);
}

console.log('권한 연결 확인 (값은 출력하지 않습니다)');
// 여기까지 왔다는 것은 DB 접속이 실제로 됐다는 뜻이다.
noteCredential('SUPABASE_DB_URL', 'CONNECTED', '요청 큐를 읽고 썼습니다');

{
  const token = String(process.env.FLY_API_TOKEN || '').trim();
  if (!token) {
    noteCredential('FLY_API_TOKEN', 'MISSING', '워커를 자동으로 재시작·재배포할 수 없습니다');
  } else {
    try {
      execFileSync('flyctl', ['apps', 'list', '--json'],
        { stdio: 'pipe', encoding: 'utf8', timeout: 60_000 });
      noteCredential('FLY_API_TOKEN', 'CONNECTED', 'Fly 앱 목록을 읽었습니다');
    } catch (e) {
      // **값은 있는데 안 된다.** 만료됐거나 이 앱에 권한이 없다.
      noteCredential('FLY_API_TOKEN', 'INVALID',
        `토큰은 있으나 Fly에 닿지 못했습니다: ${scrub(String(e?.stderr || e?.message || e), DB).slice(0, 150)}`);
    }
  }
}

{
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  noteCredential('GITHUB_TOKEN', token ? 'CONNECTED' : 'MISSING',
    token ? '워크플로를 깨울 수 있습니다' : '배포·마이그레이션을 자동으로 시작할 수 없습니다');
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
    '-d', JSON.stringify({ ref: args.ref || 'main',
      ...(args.inputs ? { inputs: args.inputs } : {}) }),
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
if (cmd === 'SYNC_SECRETS') {
  // ── 시크릿 동기화 ──
  //
  // **사람이 두 대시보드를 오가는 일을 없앤다.**
  //
  // 여기서 값을 직접 만지지 않는다. `sync-secrets` 워크플로가
  // 검사 → 반영 → 재배포 → **지문 재확인**까지 하고, 지문이 안 맞으면
  // 실패로 끝난다("밀어 넣었다"와 "맞았다"는 다르다).
  //
  // 값은 이 실행기의 로그에도 저 워크플로의 로그에도 남지 않는다 —
  // 이름과 지문(sha256 앞 6자)뿐이다.
  //
  // **"요청됨"을 "맞춰짐"으로 적지 않는다.** 이 실행기가 아는 것은
  // 워크플로를 깨웠다는 것까지다. 실제로 맞았는지는 저쪽이 지문으로
  // 확인하고, 안 맞으면 실패로 끝난다.
  //
  // 그리고 안 맞은 상태는 이미 진입을 막는다 — `parityGate`가 모든
  // 진입 경로에 있고 웹·워커 지문이 다르면 신규 주문을 세운다.
  // (이미 열린 포지션의 청산·보호는 계속 돈다.)
  step('시크릿 동기화', () => {
    const r = gh({ workflow: 'sync-secrets.yml', inputs: { apply: 'true' } });
    return `${r} — 반영·재배포·지문 확인은 저 워크플로가 하고, 지문이 다르면 실패로 끝납니다`;
  });
} else if (cmd === 'DEPLOY' || cmd === 'APPROVE_LIVE_SMALL') {
  // **마이그레이션이 먼저다.** 코드만 앞서 나가면 조용히 틀린다.
  step('마이그레이션', () => gh({ workflow: 'migrate.yml' }));
  step('워커 배포', () => gh({ workflow: 'fly-deploy.yml' }));
} else if (cmd === 'RECOVER') {
  // ── 안전한 자가 복구 ──
  //
  // **눈감고 재시작하지 않는다.** 열린 주문 수를 못 읽으면 아무것도 하지
  // 않고, 주문이 있으면 대조가 먼저이고, 같은 원인으로 세 번 시도했으면
  // 멈추고 사람에게 말한다. 판정은 selfHeal.ts에 있고 테스트가 붙어 있다.
  const mainSha = String(process.env.GITHUB_SHA || '').trim();
  const before = currentHealth(mainSha);
  console.log(`  지금 상태: ${before.code} — ${before.summary}`);

  // 열린 주문 수. **못 읽으면 null이고, null이면 워커를 만지지 않는다.**
  let openOrders = null;
  {
    const r = q(`SELECT count(*) FROM live_orders
                 WHERE status IN ('NEW','PARTIALLY_FILLED','OPEN','PENDING')`);
    if (r.ok && r.rows[0]) openOrders = Number(r.rows[0][0]);
  }

  // 지난 시도 기록. **못 읽으면 undefined이고, 그때는 다시 시도하지 않는다** —
  // 0번으로 세면 무한 재시작이 된다.
  let attempts = undefined;
  {
    const has = q(`SELECT to_regclass('public.self_heal_runs') IS NOT NULL`);
    if (has.ok && has.rows[0]?.[0] === 't') {
      const r = q(`SELECT trigger, EXTRACT(EPOCH FROM started_at) * 1000, outcome
                   FROM self_heal_runs WHERE started_at > now() - interval '2 hours'
                   ORDER BY started_at DESC LIMIT 20`);
      if (r.ok) attempts = r.rows.map(x => ({ trigger: x[0], startedAtMs: Number(x[1]) || 0, outcome: x[2] }));
    } else {
      // 061이 아직이면 기록할 곳이 없다. **기록 못 하는 채로 재시작하지 않는다**
      attempts = undefined;
    }
  }

  const plan = healPlan({ health: before, openOrders, attempts, nowMs: Date.now() });
  console.log(`  복구 계획: ${plan.code} — ${plan.reason}`);

  if (plan.code !== 'HEAL') {
    // 할 일이 없거나 해서는 안 되는 상태다. **그 사실을 그대로 적는다.**
    steps.push({
      step: '자동 복구', ok: plan.code === 'HEALTHY',
      detail: `${plan.code}: ${plan.reason}`
        + (plan.needsHuman.length ? ` / 사람 확인 필요: ${plan.needsHuman.join(' · ')}` : ''),
    });
  } else {
    let healId = null;
    const openHeal = q(`INSERT INTO self_heal_runs (trigger, action, attempt, outcome, open_orders)
      VALUES (${lit(plan.trigger)}, ${lit(plan.actions.join('+'))}, ${plan.attempt}, 'RUNNING', ${openOrders == null ? 'NULL' : openOrders})
      RETURNING id`);
    if (openHeal.ok && openHeal.rows[0]) healId = openHeal.rows[0][0];

    for (const a of plan.actions) {
      if (a === 'RECONCILE_FIRST') {
        // 대조는 워커·라우트가 하는 일이다. 여기서 거래소를 직접 만지지 않는다 —
        // **주문 경로를 두 곳에 만들지 않는다.**
        step('대조 먼저', () => '열린 주문이 있어 대조가 끝난 뒤에 재시작합니다 (워커가 매 tick 수행)');
      } else if (a === 'APPLY_MIGRATIONS') {
        step('마이그레이션', () => gh({ workflow: 'migrate.yml' }));
      } else if (a === 'RESTART_WORKER') {
        step('워커 재시작', () => flyctl(['machine', 'restart', '--select', '--app', 'auto-platform']));
      } else if (a === 'REDEPLOY_WORKER') {
        step('워커 재배포', () => gh({ workflow: 'fly-deploy.yml' }));
      }
    }

    // ── 정말 나았는가 ──
    //
    // **명령이 0으로 끝난 것과 낫는 것은 다른 사실이다.** flyctl이
    // 성공했다는 것은 머신을 재시작했다는 뜻이지 워커가 일을 하고 있다는
    // 뜻이 아니다. 신호가 다시 올 시간을 준 뒤 상태를 다시 읽는다.
    const commandOk = steps.every(x => x.ok);
    if (commandOk) {
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{}, 45000)'], { timeout: 60_000 });
    }
    const after = commandOk ? currentHealth(mainSha) : undefined;
    const v = healVerdict({ commandOk, after, before: before.code });
    steps.push({ step: '복구 확인', ok: v.verified, detail: `${v.outcome}: ${v.reason}` });

    if (healId) {
      q(`UPDATE self_heal_runs SET finished_at = now(), outcome = ${lit(v.outcome)},
          verified = ${v.verified}, detail = ${lit(v.reason)} WHERE id = ${lit(healId)}`);
    }
  }
}

// ── 배포가 정말 끝났는가 ──
//
// **"머지됐다"와 "배포됐다"와 "그 코드가 돌고 있다"는 서로 다른 사실이다.**
// 이 저장소는 그 셋을 섞어 두 번 사고를 냈다. 여섯 가지가 전부 확인돼야
// VERIFIED이고, **하나라도 모르면 UNKNOWN이고 UNKNOWN은 성공이 아니다.**
if (cmd === 'DEPLOY' || cmd === 'APPROVE_LIVE_SMALL') {
  // 배포 워크플로가 끝날 시간을 준다. 여기서 다 못 기다려도 괜찮다 —
  // 결과는 표에 남고, 다음 회차가 다시 본다.
  execFileSync(process.execPath, ['-e', 'setTimeout(()=>{}, 90000)'], { timeout: 120_000 });

  const w = readWorker();
  const mainSha = String(process.env.GITHUB_SHA || '').trim() || null;
  const workerFresh = w === undefined ? null
    : w === null ? false
    : (Date.now() - Date.parse(w.last_seen)) < 3 * 60_000;

  // 마이그레이션은 기록표에서 직접 본다.
  let migrationsApplied = null;
  {
    const has = q(`SELECT to_regclass('public.schema_migrations') IS NOT NULL`);
    if (has.ok && has.rows[0]?.[0] === 't') {
      const r = q(`SELECT count(*) FROM schema_migrations WHERE status = 'FAILED' OR verified = false`);
      if (r.ok && r.rows[0]) migrationsApplied = Number(r.rows[0][0]) === 0;
    }
  }

  const dv = deployVerification({
    mainSha, vercelSha: mainSha, flySha: w?.version ?? null, workerFresh, migrationsApplied,
  });
  console.log(`배포 검증: ${dv.code} — ${dv.reason}`);

  const hasTable = q(`SELECT to_regclass('public.deployment_verifications') IS NOT NULL`);
  if (hasTable.ok && hasTable.rows[0]?.[0] === 't') {
    q(`INSERT INTO deployment_verifications
       (main_sha, vercel_sha, fly_sha, worker_fresh, migrations_applied, verdict, reason)
       VALUES (${lit(mainSha)}, ${lit(mainSha)}, ${lit(w?.version ?? null)},
               ${workerFresh == null ? 'NULL' : workerFresh},
               ${migrationsApplied == null ? 'NULL' : migrationsApplied},
               ${lit(dv.code)}, ${lit(dv.reason)})`);
  }
  // **검증이 안 됐으면 배포 명령을 성공으로 적지 않는다.**
  steps.push({ step: '배포 검증', ok: dv.code === 'VERIFIED', detail: `${dv.code}: ${dv.reason}` });
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
