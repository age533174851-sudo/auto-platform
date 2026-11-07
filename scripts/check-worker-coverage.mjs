#!/usr/bin/env node
// scripts/check-worker-coverage.mjs
//
// **Fly Worker를 끄면 무엇이 멈추는지를 명령 하나로 답한다.**
//
// 2026-11-06에 운영 방향이 "Fly.io 퇴출, Vercel + Supabase"로 정해졌다.
// 그런데 Fly Worker는 지금 **시계**다 — 60초마다 깨어나서 예약 평가·손절
// 감시·예약 청산·job 큐를 깨운다. 주문은 Fly가 내지 않는다(Binance가 그
// 서버의 IP 지역을 막아서 주문은 Vercel이 낸다). 그래서 이관에 필요한
// 것은 거래 엔진 이전이 아니라 **분 단위 시계와 job 처리자의 대체**다.
//
// 그 사실을 사람의 기억에 맡기면 끄는 날 틀린다. 이 검사가 하는 일:
//
//   ① `worker/src/index.ts`의 `tick()`을 **파싱해서** 실제 주기 작업 목록을 뽑는다
//   ② `vercel.json`의 cron을 읽는다
//   ③ 판정은 `src/lib/system/workerCoverage.ts` 한 곳에서 가져온다
//   ④ 아래 선언표와 ①이 어긋나면 RED — 새 작업을 넣고 대체를 선언하지
//      않거나, 선언해 둔 작업이 사라지면 그 자리에서 드러난다
//
// **기본 종료 코드는 선언이 현실과 맞는지만 본다.** 지금 대체가 없는
// 작업들은 선언표에 그대로 적혀 있으므로 통과한다 — 이 검사는 "Fly를
// 끌 수 있다"고 주장하지 않고, **끄면 무엇이 멈추는지**를 적는다.
//
//   node scripts/check-worker-coverage.mjs                  표와 드리프트 검사
//   node scripts/check-worker-coverage.mjs --assert-retirable  끌 수 있는지 단정 (막히면 exit 1)
//
// 판정 로직을 이 스크립트에 복제하지 않는다. `loadJudge()`가 앱과 **같은
// 파일**을 컴파일해서 쓴다 — 복제하면 언젠가 한쪽만 고쳐진다.

import { readFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKER = 'worker/src/index.ts';
const JUDGE = 'src/lib/system/workerCoverage.ts';

const errs = [];
const err = (m) => { errs.push(m); console.log(`❌ ${m}`); console.log(`::error::${m}`); };
const ok = (m) => console.log(`✅ ${m}`);

// ── 선언표 ──
//
// 코드에서 읽을 수 없는 것만 적는다: **역할**과 **안전상 필수인가**.
// 주기·엔드포인트는 코드에서 뽑으므로 여기 적지 않는다(두 곳이 갈린다).
//
// `safetyCritical`: 포지션을 닫거나 손실을 막는 일, 또는 그것을 **가능하게
// 하는** 일. job 큐와 킬스위치 보장이 여기 들어간다 — 큐를 처리하는
// 쪽이 없으면 킬스위치 job이 영원히 대기한다.
const DECLARED = {
  processPendingJobs: { role: 'job 큐 처리 (킬스위치·Ghost Sync job이 여기서 실행된다)', safetyCritical: true },
  monitorConnections: { role: '연결 감시 · 킬스위치 job 보장', safetyCritical: true },
  pollSchedules: { role: '예약 평가 — 진입 판단을 깨운다', safetyCritical: false },
  pollExitMonitor: { role: '계단식 청산 · 손절 이동 감시', safetyCritical: true },
  pollScheduledExit: { role: '예약 청산 실행', safetyCritical: true },
  pollPaperExit: { role: '모의계좌 청산 감시', safetyCritical: false },
  pollChallengeSweep: { role: '챌린지 정리', safetyCritical: false },
  pollLedgerSync: { role: '수수료·펀딩 장부 동기화', safetyCritical: false },
  pollEquitySnapshot: { role: '자산 스냅샷', safetyCritical: false },
  pollSmokeTests: { role: '스모크 테스트 청산', safetyCritical: false },
  pollSmokeRuns: { role: '스모크 테스트 다음 회차', safetyCritical: false },
  pollSmokeCancels: { role: '사람이 누른 테스트 종료 처리', safetyCritical: false },
};

// tick()에서 불리지만 주기 작업이 아닌 것 (락·하트비트)
const NOT_A_TASK = new Set(['acquireLock', 'heartbeat', 'noteScheduler', 'releaseLock', 'sleep']);

// ── 기능적 대체 ──
//
// **이 표가 없어서 제 판정이 두 번째로 틀렸다.**
//
// 대체를 **엔드포인트로만** 짝지었다. 그런데 DB를 직접 보는 작업은
// 자기 이름의 엔드포인트가 없고, 그 일을 **다른 주소**가 한다. 그래서
// `pollSchedules`(예약 평가)를 "대체 없음"으로 적었는데, 실제로는
// `/api/autotrade/daily-ladder`의 GET이 `autotrade_schedules`를 읽어
// **워커와 같은 `evaluateIfDue`** 를 부른다
// (`src/app/api/autotrade/daily-ladder/route.ts:1157` · `:1173` · `:1188`).
// 그 주소는 `autotrade-tick.yml`이 `*/15`로 깨운다.
//
// 즉 예약 평가는 **15분 대체가 이미 있다**(15배 느림). 없는 것이 아니다.
// 한쪽만 보고 "없음"으로 적으면 이관이 실제보다 어려워 보이고, 그 방향의
// 오보가 더 나쁘다 — 멀쩡한 대체를 다시 만들게 된다.
//
// 그래서 **증거(파일:줄)를 함께 적어** 기능적 대체를 선언한다. 증거 없이
// 이 표에 줄을 더하면 "대체됐다"는 거짓이 생기므로, 검사기가 그 파일에
// 그 심볼이 실제로 있는지 확인한다.
const FUNCTIONAL_SUBSTITUTE = {
  pollSchedules: {
    endpoint: '/api/autotrade/daily-ladder',
    evidenceFile: 'src/app/api/autotrade/daily-ladder/route.ts',
    // 이 심볼들이 그 파일에 실제로 있어야 한다 — 없으면 선언이 거짓이다
    evidenceSymbols: ['autotrade_schedules', 'evaluateIfDue'],
    why: 'GET이 autotrade_schedules를 읽어 워커와 같은 evaluateIfDue를 부른다',
  },
};

/** 간격 상수 이름 → 값(ms). 못 읽으면 null (UNKNOWN, 0이 아니다) */
function resolveIntervals() {
  const out = {};
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const evalMs = (expr) => {
    const m = /^\s*([\d_]+)\s*(?:\*\s*([\d_]+)\s*)?$/.exec(String(expr));
    if (!m) return null;
    const a = Number(String(m[1]).replace(/_/g, ''));
    const b = m[2] == null ? 1 : Number(String(m[2]).replace(/_/g, ''));
    return Number.isFinite(a) && Number.isFinite(b) ? a * b : null;
  };
  // 정본 상수는 각자의 모듈에 있다
  const srcs = {
    POLL_INTERVAL_MS: 'src/lib/autotrade/schedulePoll.ts',
    EXIT_MONITOR_INTERVAL_MS: 'src/lib/engine/exitMonitorSchedule.ts',
  };
  for (const [name, file] of Object.entries(srcs)) {
    const m = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`).exec(read(file));
    out[name] = m ? evalMs(m[1]) : null;
  }
  // worker 안에서 env 기본값으로 선언된 것들
  const w = read(WORKER);
  for (const m of w.matchAll(/const (\w+_MS)\s*=\s*Number\(process\.env\.\w+\s*\|\|\s*([^)]+)\)/g)) {
    const name = m[1];
    const dflt = m[2].trim();
    out[name] = /^[A-Z_]+$/.test(dflt) ? (out[dflt] ?? null) : evalMs(dflt);
  }
  return out;
}

/** tick()이 실제로 부르는 주기 작업과 그 주기·엔드포인트를 코드에서 뽑는다 */
function extractTasks(intervals) {
  const src = readFileSync(WORKER, 'utf8');
  const lines = src.split('\n');
  const bodyOf = (startIdx) => {
    let d = 0;
    for (let i = startIdx; i < lines.length; i++) {
      d += (lines[i].match(/{/g) || []).length - (lines[i].match(/}/g) || []).length;
      if (i > startIdx && d <= 0) return lines.slice(startIdx, i + 1).join('\n');
    }
    return lines.slice(startIdx).join('\n');
  };

  const tickIdx = lines.findIndex((l) => /^async function tick\(\)/.test(l));
  if (tickIdx < 0) { err(`${WORKER}에서 tick()을 찾지 못했습니다 — 주기 작업 목록을 뽑을 수 없습니다`); return []; }
  const tickBody = bodyOf(tickIdx);

  const called = [...new Set([...tickBody.matchAll(/await (\w+)\(/g)].map((m) => m[1]))]
    .filter((n) => !NOT_A_TASK.has(n));

  return called.map((fn) => {
    const defIdx = lines.findIndex((l) => new RegExp(`^async function ${fn}\\(`).test(l));
    if (defIdx < 0) return { fn, everyMs: null, endpoint: null, unresolved: '정의를 찾지 못했습니다' };
    const body = bodyOf(defIdx);
    let ep = (body.match(/\$\{APP_URL\}(\/api\/[A-Za-z0-9/\-]+)/) || [])[1] || null;
    // 자기 이름의 주소가 없으면 기능적 대체를 본다 (증거를 확인한 뒤에만)
    if (!ep && FUNCTIONAL_SUBSTITUTE[fn]) {
      const sub = FUNCTIONAL_SUBSTITUTE[fn];
      const ev = existsSync(sub.evidenceFile) ? readFileSync(sub.evidenceFile, 'utf8') : '';
      const missing = sub.evidenceSymbols.filter((sym) => !ev.includes(sym));
      if (missing.length) {
        err(`${fn}의 기능적 대체 선언이 거짓입니다 — ${sub.evidenceFile}에 `
          + `${missing.join(' · ')}이 없습니다. 증거 없는 대체를 "대체됨"으로 적지 않습니다`);
      } else {
        ep = sub.endpoint;
      }
    }
    const ivName = (body.match(/\b([A-Z][A-Z0-9_]*_MS)\b/) || [])[1] || null;
    const everyMs = ivName ? (intervals[ivName] ?? null) : null;
    return { fn, line: defIdx + 1, everyMs, endpoint: ep, ivName, perTick: !ivName };
  });
}

/**
 * GitHub Actions 워크플로의 `schedule` cron과 그 워크플로가 부르는
 * `/api/...` 경로를 짝지어 돌려준다.
 *
 * 한 워크플로가 여러 경로를 부르면 그 cron이 전부에 걸린다고 본다 —
 * 실제로 그 주기에 깨워지기 때문이다.
 */
function actionsCrons() {
  const dir = '.github/workflows';
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    const schedules = [...text.matchAll(/-\s*cron:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (!schedules.length) continue;
    const paths = [...new Set([...text.matchAll(/(\/api\/[A-Za-z0-9/_-]+)/g)].map((m) => m[1]))]
      // 디렉터리만 가리키는 조각은 버린다
      .filter((p) => !p.endsWith('/'));
    for (const schedule of schedules) {
      for (const path of paths) {
        out.push({ schedule, path, source: `.github/workflows/${name}` });
      }
    }
  }
  return out;
}

function loadJudge() {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-cov-'));
  const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript를 찾지 못했습니다 — npm ci 먼저');
  execFileSync(process.execPath, [
    tsc, JUDGE, '--outDir', dir, '--module', 'commonjs',
    '--target', 'es2019', '--skipLibCheck', '--esModuleInterop',
  ], { stdio: 'pipe' });
  return dir;
}

const fmt = (ms) => {
  if (ms == null) return 'UNKNOWN';
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}일`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}시간`;
  if (ms % 60_000 === 0) return `${ms / 60_000}분`;
  return `${ms}ms`;
};

async function main() {
  const assertRetirable = process.argv.includes('--assert-retirable');

  if (!existsSync(WORKER)) { err(`${WORKER}을 읽지 못했습니다`); }
  if (!existsSync('vercel.json')) { err('vercel.json을 읽지 못했습니다'); }
  if (!existsSync(JUDGE)) { err(`${JUDGE}을 읽지 못했습니다 — 판정 정본이 없습니다`); }
  if (errs.length) { finish(false); return; }

  const intervals = resolveIntervals();
  for (const [k, v] of Object.entries(intervals)) {
    if (v == null) err(`간격 상수 ${k}의 값을 읽지 못했습니다 — UNKNOWN을 0으로 적지 않습니다`);
  }

  const found = extractTasks(intervals);

  // ── 드리프트 검사 ──
  for (const t of found) {
    if (!DECLARED[t.fn]) {
      err(`tick()에 ${t.fn}이 새로 들어왔는데 선언표에 없습니다 — `
        + 'Fly를 끄면 이 작업이 멈추는지 아무도 모릅니다. DECLARED에 역할과 safetyCritical을 적으세요');
    }
  }
  for (const fn of Object.keys(DECLARED)) {
    if (!found.some((t) => t.fn === fn)) {
      err(`선언표의 ${fn}이 tick()에 없습니다 — 사라졌으면 선언표에서도 지우세요`);
    }
  }
  if (!errs.length) ok(`선언표와 tick()이 일치합니다 (주기 작업 ${found.length}개)`);

  const outDir = loadJudge();
  const { coverage, flyRetirementBlockers } =
    await import(`file://${join(outDir, 'workerCoverage.js')}`);

  // ── 깨우는 쪽을 **전부** 모은다 ──
  //
  // `vercel.json`만 보면 틀린다. **Vercel Hobby는 일 단위 cron만
  // 허용하고**(이 저장소가 `exit-monitor/route.ts:9` · `PROGRESS.md:493`
  // 등 여러 곳에 적어 둔 제약), 그래서 분 단위로 깨우는 일은 이미
  // **GitHub Actions의 `schedule`** 이 하고 있다. 한쪽만 보면 이미 있는
  // 대체를 없다고 적는다 — 실제로 그렇게 틀렸다.
  const crons = [
    ...((JSON.parse(readFileSync('vercel.json', 'utf8')).crons) || [])
      .map((c) => ({ ...c, source: 'vercel.json' })),
    ...actionsCrons(),
  ];
  const tasks = found
    .filter((t) => DECLARED[t.fn])
    .map((t) => ({
      fn: t.fn, everyMs: t.everyMs, endpoint: t.endpoint,
      role: DECLARED[t.fn].role, safetyCritical: DECLARED[t.fn].safetyCritical,
    }));

  const rows = coverage(tasks, crons);

  console.log('');
  console.log('Fly Worker 주기 작업 → cron 대체 상태 (vercel.json + GitHub Actions)');
  console.log('');
  // **열 이름에 "선언"을 적는다.** 이 검사기는 파일만 읽는다 — cron이
  // 실제로 그 주기로 도는지는 확인할 수 없다. 그런데 2026-11-07 실측에서
  // GitHub Actions의 `schedule`은 **선언과 무관하게 하루 4~5회**만 돌았다
  // (`*/5`로 288회를 선언한 워크플로가 400회/69일 = 5.8회/일). 그래서
  // 선언 기준 악화 배수는 **실제보다 20~58배 낙관적이다.** 열 이름이
  // 그냥 "대체 주기"면 보는 사람이 관측값으로 읽는다.
  console.log('| 작업 | 역할 | 안전 | Fly 주기 | 대체 주기(선언) | 상태 | 악화(선언 기준) | 깨우는 쪽 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const who = r.substitute === 'NONE' ? '없음'
      : (String(r.reason).match(/^([^\s`]+)/) || [])[1] || '?';
    console.log(`| \`${r.fn}\` | ${r.role} | ${r.safetyCritical ? '★' : ''} | `
      + `${fmt(r.flyEveryMs)} | ${fmt(r.vercelEveryMs)} | ${r.substitute} | `
      + `${r.factor == null ? 'UNKNOWN' : Math.round(r.factor) + '배'} | ${who} |`);
  }

  const blockers = flyRetirementBlockers(rows);
  console.log('');
  if (blockers.length === 0) {
    console.log('✅ 안전상 필수 작업이 모두 Vercel에서 같은 급으로 대체됩니다 — Fly를 끌 수 있습니다');
  } else {
    console.log(`⚠ Fly를 지금 끄면 안전상 필수 작업 ${blockers.length}개가 멈추거나 크게 느려집니다:`);
    for (const b of blockers) {
      console.log(`   · ${b.fn} (${b.role}) — ${b.substitute}: ${b.reason}`);
    }
    console.log('');
    console.log('   이 표가 비기 전에는 Worker를 중지하지 않습니다. 이것은 의견이 아니라 값입니다.');
    console.log('');
    console.log('   ⚠ 위 악화 배수는 **선언된 cron 기준이며 실제보다 낙관적입니다.**');
    console.log('      2026-11-07 실측: GitHub Actions `schedule`은 선언과 무관하게 하루 4~5회만');
    console.log('      돌았습니다 (워크플로 8개, 선언 24~288회/일 → 실측 4.3~5.0회/일).');
    console.log('      즉 대체 주기는 선언값이 아니라 **약 5시간**입니다:');
    console.log('        pollSchedules      1분 → 실측 ~294분 (선언 15분)  → 15배가 아니라 ~294배');
    console.log('        pollExitMonitor    5분 → 실측 ~320분 (선언 1시간) → 12배가 아니라 ~64배');
    console.log('        pollScheduledExit  1분 → 실측 ~288분 (선언 5분)   →  5배가 아니라 ~288배');
    console.log('      이 검사기는 파일만 읽으므로 실제 실행률을 확인할 수 없습니다 —');
    console.log('      선언을 관측으로 적지 않기 위해 이 경고를 남깁니다.');
    if (assertRetirable) {
      err(`Fly 종료 조건이 충족되지 않았습니다 — 안전상 필수 ${blockers.length}개가 대체되지 않았습니다`);
    }
  }

  finish(true);
}

function finish() {
  console.log('');
  if (errs.length) {
    console.log(`Worker 대체 선언이 현실과 어긋납니다 (${errs.length}곳).`);
    process.exit(1);
  }
  // **"현실과 일치"라고 적지 않는다.** 이 검사기가 확인한 것은
  // `tick()`의 선언표와 워크플로 파일이 서로 맞는다는 것뿐이다.
  // cron이 실제로 그 주기로 도는지는 확인하지 않았다 — 실측은 더 나쁘다.
  console.log('✅ tick() 선언과 cron 파일이 일치합니다 — 끄면 무엇이 멈추는지 위 표가 답입니다');
  console.log('   (단, 악화 배수는 선언 기준입니다. 실제 실행률은 이 검사기가 확인하지 않습니다.)');
}

main().catch((e) => { err(`검사 중 오류 — ${e?.message || e}`); finish(); });
