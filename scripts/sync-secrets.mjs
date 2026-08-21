// scripts/sync-secrets.mjs
//
// **"시크릿 동기화해" 한 마디로 끝나게 한다.**
//
// 검사 → 반영 → 재배포 → **지문 재확인**까지 한 번에 한다.
//
// 마지막 단계가 핵심이다
// ──────────────────────
// 예전 워크플로는 `flyctl secrets set`이 0을 돌려주면 성공으로 적었다.
// 그건 "명령을 받았다"이지 "맞았다"가 아니다. 2026-08-19에 워커는
// 멀쩡히 돌고 배포는 성공이고 Fly는 started라고 하는데 화면은 아무것도
// 못 봤다 — 다른 데이터베이스를 보고 있었다. 사흘을 잃었다.
//
// 그래서 여기서는 밀어 넣은 뒤 **돌고 있는 두 프로세스가 실제로 들고
// 있는 지문**을 읽어 대조한다(`/api/system/runtime-health`).
//
// 판단은 여기 없다
// ────────────────
// `src/lib/ops/secretSync.ts`와 `vercelEnv.ts`에 있고 테스트가 붙어
// 있다. 이 파일은 사실을 모으고, 판정에 넘기고, 시키는 것만 한다.
//
// 값은 어디에도 남지 않는다
// ─────────────────────────
// 이름과 지문(sha256 앞 6자)만 출력한다. 값을 찍는 줄이 하나도 없다.
// `flyctl secrets set`은 값이 명령줄에 들어가므로 stdio를 통째로 가린다.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APPLY = process.env.SYNC_APPLY === 'true';
const FLY_APP = process.env.FLY_APP || 'auto-platform';
const FLY_TOKEN = process.env.FLY_API_TOKEN || '';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || '';
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');

/** 지문. **값은 되찾을 수 없다** */
const fp = (v) => (v ? createHash('sha256').update(String(v), 'utf8').digest('hex').slice(0, 6) : null);

function loadJudge() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-sync-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, 'src/lib/ops/secretSync.ts', 'src/lib/ops/vercelEnv.ts',
    '--outDir', dir, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

async function vercel(req) {
  const r = await fetch(`https://api.vercel.com${req.path}`, {
    method: req.method,
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      ...(req.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(req.body ? { body: req.body } : {}),
  });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { ok: r.ok, status: r.status, body };
}

/** flyctl. **출력을 그대로 흘리지 않는다** — 값이 인자에 들어간다 */
function flyQuiet(args) {
  try {
    execFileSync('flyctl', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FLY_API_TOKEN: FLY_TOKEN },
    });
    return true;
  } catch {
    return false;
  }
}
function flyRead(args) {
  try {
    return execFileSync('flyctl', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FLY_API_TOKEN: FLY_TOKEN },
    });
  } catch { return null; }
}

const NAMES = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'EXCHANGE_ENCRYPTION_KEY', 'ADMIN_SECRET'];

async function main() {
  const dir = loadJudge();
  const { syncPlanOf, syncVerify, syncReport } = await import(`file://${join(dir, 'secretSync.js')}`);
  const V = await import(`file://${join(dir, 'vercelEnv.js')}`);

  // ── 기준값 ──
  //
  // **값을 변수에 담기만 하고 절대 출력하지 않는다.**
  const source = {};
  const sourceFp = {};
  for (const n of NAMES) {
    const v = process.env[n] || '';
    if (v) source[n] = v;
    sourceFp[n] = fp(v);
  }
  console.log('기준값(GitHub Secrets):');
  for (const n of NAMES) console.log(`  ${n}: ${sourceFp[n] ? `있음 (지문 ${sourceFp[n]})` : '없음'}`);

  // ── 지금 어디에 무엇이 있는가 ──
  //
  // **Fly도 Vercel도 값을 돌려주지 않는다.** Fly는 다이제스트를 주지만
  // 우리 지문과 계산 방식이 달라 직접 비교할 수 없고, Vercel은
  // encrypted 값을 아예 안 준다. 그래서 여기서는 **이름이 있는지만**
  // 본다 — 같은지 다른지는 아래 "돌고 있는 프로세스의 지문"이 답한다.
  let flyNames = null;
  if (FLY_TOKEN) {
    const out = flyRead(['secrets', 'list', '--app', FLY_APP]);
    if (out == null) console.log('Fly: 시크릿 목록을 읽지 못했습니다 (토큰·권한 확인)');
    else {
      flyNames = out.split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
      console.log(`Fly: 이름 ${flyNames.length}개`);
    }
  } else {
    console.log('Fly: FLY_API_TOKEN이 없습니다');
  }

  let vercelRows = null;
  if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
    const target = { projectId: VERCEL_PROJECT_ID, teamId: VERCEL_TEAM_ID || null };
    const r = await vercel(V.vercelEnvListRequest(target));
    if (!r.ok) console.log(`Vercel: 환경변수 목록을 읽지 못했습니다 (HTTP ${r.status})`);
    else {
      vercelRows = Array.isArray(r.body?.envs) ? r.body.envs : [];
      console.log(`Vercel: 이름 ${vercelRows.length}개`);
    }
  } else {
    console.log('Vercel: VERCEL_TOKEN 또는 VERCEL_PROJECT_ID가 없습니다');
  }

  // 이름이 아예 없으면 지문도 없는 것으로 둔다 — 판정기가 "모르면 민다".
  const nameFp = (names) => {
    if (names == null) return undefined;
    const out = {};
    for (const n of NAMES) out[n] = names.includes(n) ? sourceFp[n] : null;
    return out;
  };

  const plan = syncPlanOf({
    sourceFp,
    // **여기서 "이름이 있으니 값도 같다"고 가정한다는 뜻이 아니다.**
    // 이름조차 없으면 확실히 다르고, 이름이 있으면 아직 모른다 —
    // 최종 판정은 아래 지문 대조가 한다.
    vercelFp: vercelRows == null ? undefined
      : nameFp(vercelRows.filter(e => (Array.isArray(e.target) ? e.target : []).includes('production')).map(e => e.key)),
    flyFp: nameFp(flyNames),
    canPushVercel: !!(VERCEL_TOKEN && VERCEL_PROJECT_ID),
    canPushFly: !!FLY_TOKEN,
  });

  console.log('\n계획:');
  for (const s of plan.steps) console.log(`  ${s.destination}/${s.name}: ${s.code} — ${s.reason}`);

  if (!APPLY) {
    console.log('\n확인 모드입니다 — 아무것도 바꾸지 않았습니다.');
    for (const b of plan.bootstrap) console.log(`  사람이 해야 할 것: ${b}`);
    return 0;
  }

  // ── 밀어 넣는다 ──
  //
  // **여기 시각을 기억해 둔다.** 아래에서 "워커가 이 시각 이후로
  // 한 번이라도 뛰었는가"로 새 값이 적용됐는지 판단한다.
  const pushStartedMs = Date.now();
  let pushed = 0;
  const failures = [];

  const flyPush = plan.push.filter(p => p.destination === 'fly');
  if (flyPush.length > 0) {
    // **--stage로 한 번에.** 하나씩 밀면 그때마다 워커가 재시작하고,
    // 그 사이 열린 포지션의 감시가 여러 번 끊긴다.
    const args = ['secrets', 'set', '--app', FLY_APP, '--stage'];
    for (const p of flyPush) {
      if (!source[p.name]) continue;          // 빈 값을 밀지 않는다
      args.push(`${p.name}=${source[p.name]}`);
      console.log(`Fly에 밀어 넣습니다: ${p.name}`);
    }
    if (args.length > 5) {
      if (flyQuiet(args)) pushed += flyPush.length;
      else failures.push('Fly에 밀어 넣지 못했습니다');
    }
  }

  const vercelPush = plan.push.filter(p => p.destination === 'vercel');
  if (vercelPush.length > 0) {
    const target = { projectId: VERCEL_PROJECT_ID, teamId: VERCEL_TEAM_ID || null };
    for (const p of vercelPush) {
      if (!source[p.name]) continue;
      const up = V.vercelUpsertPlan({ name: p.name, existing: vercelRows });
      if (up.action === 'SKIP') { failures.push(`Vercel/${p.name}: ${up.reason}`); continue; }
      const req = up.action === 'CREATE'
        ? V.vercelEnvCreateRequest({ target, name: p.name, value: source[p.name] })
        : V.vercelEnvUpdateRequest({ target, envId: up.envId, value: source[p.name] });
      const r = await vercel(req);
      // **응답 본문을 찍지 않는다** — 요청에 값이 들어갔다.
      if (r.ok) { pushed++; console.log(`Vercel에 ${up.action === 'CREATE' ? '만들었습니다' : '고쳤습니다'}: ${p.name}`); }
      else failures.push(`Vercel/${p.name}: HTTP ${r.status}`);
    }
  }

  // ── 반영시킨다 ──
  //
  // **밀어 넣기만 하면 돌고 있는 배포는 옛 값 그대로다.** Vercel은
  // 빌드 시점에 환경변수를 굽고, Fly는 --stage한 값을 다음 배포에서
  // 적용한다. 재배포를 안 하면 아래 지문 대조가 옛 값을 보고 실패한다.
  if (pushed > 0 && FLY_TOKEN) {
    console.log('Fly 재배포…');
    if (!flyQuiet(['deploy', '--app', FLY_APP, '--remote-only'])) {
      failures.push('Fly 재배포에 실패했습니다 — 밀어 넣은 값이 아직 적용되지 않았습니다');
    }
  }

  // ── 실제로 맞았는가 ──
  //
  // 여기가 이 스크립트의 이유다. "밀어 넣었다"와 "맞았다"는 다르다.
  //
  // **워커가 아직 새 값으로 안 떴을 수 있다.** 재배포 직후 몇십 초는
  // 옛 워커의 지문이 남아 있다. 그걸 "어긋났다"로 읽으면 멀쩡한
  // 동기화가 매번 BLOCKED가 된다 — 그러면 이 판정을 아무도 안 믿는다.
  //
  // 그래서 **기다렸다가 다시 본다.** 다만 영원히 기다리지 않는다 —
  // 끝내 확인이 안 되면 그건 "맞았다"가 아니라 "모른다"이고, 모르면
  // 신규 진입을 막는다.
  let verify = null;
  if (!APP_URL) {
    console.log('APP_URL이 없어 지문을 대조하지 못했습니다');
  } else {
    const TRIES = 12;          // 15초 × 12 = 3분
    const WAIT_MS = 15_000;
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      let j = null;
      try {
        const r = await fetch(`${APP_URL}/api/system/runtime-health`, {
          signal: AbortSignal.timeout(30_000),
        });
        j = await r.json().catch(() => null);
      } catch (e) {
        console.log(`지문을 읽지 못했습니다 (${attempt}/${TRIES}): ${String(e?.message || e).slice(0, 120)}`);
      }

      verify = syncVerify({
        sourceFp,
        webFp: j?.web ? {
          SUPABASE_URL: j.web.supabaseFingerprint ?? null,
          EXCHANGE_ENCRYPTION_KEY: j.web.encryptionFingerprint ?? null,
        } : null,
        workerFp: j?.worker ? {
          SUPABASE_URL: j.worker.supabaseFingerprint ?? null,
          EXCHANGE_ENCRYPTION_KEY: j.worker.encryptionFingerprint ?? null,
        } : null,
        // 워커가 이번 밀어넣기 이후로 아직 한 번도 안 뛰었으면 '아직'이다.
        workerStale: (() => {
          const seen = Date.parse(String(j?.worker?.lastSeen ?? ''));
          if (!Number.isFinite(seen)) return true;   // 모르면 '아직'으로 본다
          return seen < pushStartedMs;
        })(),
      });

      console.log(`지문 확인 ${attempt}/${TRIES}: ${verify.code}`);
      // 확정된 답이 나오면 끝난다. WORKER_STALE·UNKNOWN은 아직이다.
      if (verify.code === 'SYNCED' || verify.code === 'MISMATCH') break;
      if (attempt < TRIES) await new Promise(r => setTimeout(r, WAIT_MS));
    }
  }

  const report = syncReport({ plan, pushed, verify });

  console.log('\n────────────────');
  console.log(`결과: ${report.outcome}`);
  console.log(report.summary);
  console.log(`신규 진입: ${report.entryAllowed ? '허용' : '차단 (이미 열린 포지션의 청산·보호는 계속 돕니다)'}`);
  for (const f of failures) console.log(`  실패: ${f}`);
  for (const t of report.humanTodo) console.log(`  사람이 해야 할 것: ${t}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## 시크릿 동기화\n\n**${report.outcome}** — ${report.summary}\n\n`
      + `신규 진입: ${report.entryAllowed ? '허용' : '**차단**'}\n\n`
      + (failures.length ? `실패:\n${failures.map(f => `- ${f}`).join('\n')}\n\n` : '')
      + (report.humanTodo.length ? `사람이 해야 할 것:\n${report.humanTodo.map(t => `- ${t}`).join('\n')}\n\n` : '')
      + '값은 로그에 남지 않습니다 — 이름과 지문(sha256 앞 6자)만 찍습니다.\n');
  }

  // BLOCKED면 실패로 끝낸다 — 초록으로 끝나면 아무도 안 본다.
  return report.outcome === 'BLOCKED' ? 1 : 0;
}

main().then(c => process.exit(c)).catch(e => {
  // 값이 섞일 수 있는 메시지를 그대로 찍지 않는다.
  console.error('시크릿 동기화 실패:', String(e?.message || e).slice(0, 200));
  process.exit(1);
});
