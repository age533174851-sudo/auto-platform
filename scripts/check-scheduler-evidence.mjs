#!/usr/bin/env node
// scripts/check-scheduler-evidence.mjs
//
// **"예약 폴러가 도는지 fly logs로 봐 주세요"가 다시 생기지 않게 한다.**
//
// 2026-08-29에 이 저장소는 "Fly Worker 예약 폴러가 실제로 도는가"에 값으로
// 답하지 못했다. 코드는 이미 있었다 — 없었던 것은 **밖에서 읽을 수 있는
// 자리**였다. 그래서 워커가 heartbeat에 적고, 인증 없는
// `/api/system/deployment`가 보여 주고, `deployment-check`가 찍는다.
//
// 이 저장소가 자주 내는 고장 두 가지가 정확히 여기에 걸린다:
//
//   1. 만들어 놓고 배선을 안 함 — 워커는 적는데 API가 안 보여 준다
//   2. 경로가 둘인데 한쪽만 고침 — 네 가지 코드를 두 곳에서 정의한다
//
// 그리고 **값이 새면 안 된다.** APP_URL도 ADMIN_SECRET도 있다/없다만
// 들어간다. 이 검사가 그 경계를 지킨다.
//
// 사용: node scripts/check-scheduler-evidence.mjs

import { readFileSync, existsSync } from 'node:fs';

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);

// ── 주석을 먼저 걷어낸다 ──
//
// **이 검사는 지금까지 네 번 자기 주석을 사용처로 읽었다**(#211·#210·#214·
// #215·#216). 이 파일과 검사 대상 파일 모두 설명이 길고, 그 설명 안에
// `APP_URL`도 `WORKER_PRIMARY_ACTIVE`도 그대로 등장한다. 문자를 하나씩
// 걸으며 문자열 안의 `//`는 주석으로 세지 않는다.
function stripJs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;      // ' " ` 중 무엇 안에 있는가
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (quote) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) quote = null;
      out += c === '\n' ? '\n' : c;
      i++; continue;
    }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

function stripSql(src) {
  return src.split('\n').map(l => (l.trimStart().startsWith('--') ? '' : l)).join('\n');
}

function read(path) {
  if (!existsSync(path)) { fail(`${path} 이 없습니다`); return null; }
  return readFileSync(path, 'utf8');
}

const JUDGE = 'src/lib/runtime/schedulerReport.ts';
const WORKER = 'worker/src/index.ts';
const WORKER_DB = 'worker/src/supabase.ts';
const ROUTE = 'src/app/api/system/deployment/route.ts';
const CI_SCRIPT = 'scripts/verify-deployment.mjs';
const MIGRATION = 'supabase/migrations/073_worker_scheduler.sql';
const TEST = 'src/lib/runtime/schedulerReport.test.ts';

const CODES = [
  'WORKER_PRIMARY_ACTIVE',
  'WORKER_PRESENT_BUT_CONFIG_BLOCKED',
  'WORKER_PRESENT_BUT_RUNTIME_BROKEN',
  'INSUFFICIENT_EVIDENCE',
];

// ── 1. 판정은 한 곳에만 있다 ──
const judgeRaw = read(JUDGE);
if (judgeRaw) {
  const judge = stripJs(judgeRaw);
  for (const c of CODES) {
    if (!judge.includes(`'${c}'`)) fail(`${JUDGE}에 ${c} 판정이 없습니다`);
  }
  if (!/export function schedulerVerdict/.test(judge)) fail(`${JUDGE}에 schedulerVerdict()가 없습니다`);
  // **값은 이 파일을 지나가지 않는다.** 주소도 시크릿도 이름조차 다루지 않는다.
  if (/process\.env/.test(judge)) fail(`${JUDGE}이 process.env를 읽습니다 — 판정기는 값을 만지지 않습니다`);
  notes.push(`판정 ${JUDGE} — 코드 ${CODES.length}가지`);
}

// 다른 파일이 같은 네 가지를 다시 정의하면 언젠가 갈린다.
for (const f of [WORKER, WORKER_DB, ROUTE, CI_SCRIPT]) {
  const raw = existsSync(f) ? readFileSync(f, 'utf8') : '';
  const body = stripJs(raw);
  const declared = CODES.filter(c => body.includes(`'${c}'`) || body.includes(`"${c}"`)).length;
  if (declared === CODES.length) {
    fail(`${f}이 네 가지 판정 코드를 전부 들고 있습니다 — 판정을 ${JUDGE} 한 곳에 두세요`);
  }
}

// ── 2. 워커가 실제로 적는가 ──
const workerRaw = read(WORKER);
if (workerRaw) {
  const w = stripJs(workerRaw);
  if (!/noteScheduler\s*\(/.test(w)) fail(`${WORKER}이 noteScheduler를 부르지 않습니다 — 적지 않으면 밖에서 못 읽습니다`);
  if (!/hasAppUrl\s*:/.test(w)) fail(`${WORKER}이 APP_URL 유무를 적지 않습니다`);
  if (!/hasAdminSecret\s*:/.test(w)) fail(`${WORKER}이 ADMIN_SECRET 유무를 적지 않습니다`);
  if (!/isMain\s*[,}]|isMain\s*:/.test(w)) fail(`${WORKER}이 main 락 상태를 적지 않습니다 — 예비 워커를 보고 "안 돈다"고 읽게 됩니다`);
  if (!/lastPollIso\s*:/.test(w)) fail(`${WORKER}이 마지막 폴링 시각을 적지 않습니다 — 그게 "실제로 봤다"의 증거입니다`);
  if (!/lastError\s*:/.test(w)) fail(`${WORKER}이 폴링 오류를 적지 않습니다 — 조용히 멈추면 초록으로 보입니다`);

  // ── 값이 새지 않는가 ──
  //
  // `noteScheduler({...})` 안에 APP_URL·ADMIN_SECRET이 **부울로 접히지 않고**
  // 그대로 들어가면 주소와 시크릿이 DB와 공개 API로 나간다.
  for (const m of w.matchAll(/noteScheduler\s*\(\s*\{/g)) {
    let i = m.index + m[0].length - 1, depth = 0;
    for (; i < w.length; i++) {
      if (w[i] === '{') depth++;
      else if (w[i] === '}') { depth--; if (depth === 0) break; }
    }
    const arg = w.slice(m.index, i + 1);
    for (const [name, re] of [
      ['APP_URL', /(^|[^!.\w])APP_URL\b/],
      ['APP_ADMIN_SECRET', /(^|[^!.\w])APP_ADMIN_SECRET\b/],
    ]) {
      // `!!APP_URL`은 부울이라 통과. 맨 이름이 값으로 들어가면 실패.
      const bare = arg.replace(/!!\s*APP_URL/g, '').replace(/!!\s*APP_ADMIN_SECRET/g, '');
      if (re.test(bare)) fail(`${WORKER}의 noteScheduler에 ${name} 값이 그대로 들어갑니다 — 있다/없다만 적으세요`);
    }
  }
  notes.push('워커가 환경변수 유무·main 락·폴링 시각·오류를 적습니다 (값 아님)');
}

// ── 3. heartbeat에 실려 나가는가 ──
const dbRaw = read(WORKER_DB);
if (dbRaw) {
  const d = stripJs(dbRaw);
  if (!/export function noteScheduler/.test(d)) fail(`${WORKER_DB}에 noteScheduler가 없습니다`);
  if (!/\bscheduler\b\s*,/.test(d)) fail(`${WORKER_DB}의 runtimeColumns에 scheduler가 없습니다 — 적어도 안 실리면 못 읽습니다`);
  if (!/runtimeColumnsMissing/.test(d)) fail(`${WORKER_DB}에 칸 없는 배포용 재시도가 없습니다 — 073 전 배포에서 생존 신호를 잃습니다`);
}

// ── 4. 마이그레이션은 더하기만 한다 ──
const sqlRaw = read(MIGRATION);
if (sqlRaw) {
  const q = stripSql(sqlRaw);
  if (!/ADD COLUMN IF NOT EXISTS\s+scheduler/i.test(q)) fail(`${MIGRATION}이 scheduler 칸을 더하지 않습니다`);
  if (/\bDROP\b|\bALTER COLUMN\b|\bRENAME\b/i.test(q)) fail(`${MIGRATION}에 파괴적 구문이 있습니다 — 칸을 더하기만 하세요`);
  const manifest = existsSync('src/lib/system/migrationManifest.ts')
    ? readFileSync('src/lib/system/migrationManifest.ts', 'utf8') : '';
  if (!manifest.includes('073_worker_scheduler')) {
    fail('073이 migrationManifest에 없습니다 — node scripts/gen-migration-manifest.mjs 를 돌리세요');
  }
}

// ── 5. 인증 없는 경로가 보여 주는가 ──
const routeRaw = read(ROUTE);
if (routeRaw) {
  const r = stripJs(routeRaw);
  if (!/schedulerVerdict\s*\(/.test(r)) fail(`${ROUTE}이 schedulerVerdict를 부르지 않습니다 — 판정을 여기서 새로 하지 마세요`);
  if (!/scheduler\s*:\s*\{/.test(r)) fail(`${ROUTE}이 scheduler를 응답에 넣지 않습니다 — 적어 놓고 안 보여 주면 없는 것과 같습니다`);
  if (!/column\|schema cache/.test(r)) fail(`${ROUTE}에 칸 없는 배포용 재조회가 없습니다 — 073 전에는 이 경로가 통째로 죽습니다`);
  if (!/pickSchedulerRow\s*\(/.test(r)) fail(`${ROUTE}이 main 락을 쥔 줄을 고르지 않습니다`);
  // 이 경로는 로그인 없이 열린다. 인증을 새로 붙이지 않았는지도 본다.
  if (/auth_required|resolveUserId/.test(r)) {
    fail(`${ROUTE}에 인증이 붙었습니다 — CI가 못 읽게 되면 다시 사람이 확인하게 됩니다`);
  }
  notes.push(`${ROUTE}이 인증 없이 판정과 근거를 돌려줍니다`);
}

// ── 6. 배포마다 찍히는가 ──
const ciRaw = read(CI_SCRIPT);
if (ciRaw) {
  const c = stripJs(ciRaw);
  if (!/scheduler/.test(c)) fail(`${CI_SCRIPT}이 예약 판정을 찍지 않습니다 — 사람이 다시 브라우저로 열게 됩니다`);
}

// ── 7. 판정에 시험이 붙어 있는가 ──
if (!existsSync(TEST)) fail(`${TEST}이 없습니다 — 판정에는 시험을 붙입니다`);
else {
  const reg = existsSync('scripts/run-tests.mjs') ? readFileSync('scripts/run-tests.mjs', 'utf8') : '';
  if (!reg.includes('runSchedulerReportTests()')) fail('run-tests.mjs에 runSchedulerReportTests()가 등록되지 않았습니다');
}

console.log('예약 주 경로 증거 배선 확인');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length === 0) {
  console.log('통과 — 워커가 적고, 인증 없는 경로가 보여 주고, 배포마다 찍힙니다');
  process.exit(0);
}
for (const f of fails) console.log(`::error::${f}`);
console.log(`실패 ${fails.length}건`);
process.exit(1);
