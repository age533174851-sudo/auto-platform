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

/**
 * `from`부터 시작하는 함수의 **본문만** 떼어 낸다.
 *
 * 길이로 잘라 읽었더니 **옆 함수의 try/catch를 이 함수의 것으로 읽었다** —
 * 되돌림 시험에서 잡혔다. 중괄호를 세는 것 말고 정확한 방법이 없다.
 */
function bodyAt(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
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

  // ── 공개 경로로 나가는 칸을 최소로 묶는다 ──
  //
  // 이 보고는 **로그인 없이 열리는** `/api/system/deployment`로 나간다.
  // 예약이 도는지 판정하는 데 필요한 것은 유무·시각·횟수뿐이고,
  // 종목·자격·사용자는 필요하지 않다. 필요하지 않은 것을 공개 경로에
  // 얹지 않는다 — 한 번 얹히면 다음 사람이 그 자리에 더 얹는다.
  const DENIED_FIELDS = [
    'lastEvalSymbol', 'lastEvalOutcome', 'symbol', 'outcome',
    'userId', 'user_id', 'accountId', 'account_id', 'connectionId', 'connection_id',
    'apiKey', 'apiSecret', 'fingerprint', 'appUrl', 'adminSecret', 'token',
    // **자유 문자열 오류는 담지 않는다.** 예외 문구에 무엇이 섞여 들어올지
    // 미리 알 수 없고, 정규식으로 가리는 것은 방어가 아니라 추측이다.
    'lastError', 'error', 'message', 'detail', 'stack', 'reason',
  ];
  const shape = judge.match(/export interface SchedulerReport \{([\s\S]*?)\n\}/);
  if (!shape) fail(`${JUDGE}에서 SchedulerReport 형식을 찾지 못했습니다`);
  else {
    for (const f of DENIED_FIELDS) {
      if (new RegExp(String.raw`(^|\s)${f}\s*\??:`, 'm').test(shape[1])) {
        fail(`SchedulerReport에 ${f}이(가) 있습니다 — 이 보고는 인증 없이 공개됩니다`);
      }
    }
    for (const f of ['hasAppUrl', 'hasAdminSecret']) {
      if (!new RegExp(String.raw`${f}:\s*boolean\s*\|\s*null`).test(shape[1])) {
        fail(`SchedulerReport의 ${f}이 boolean이 아닙니다 — 값이 아니라 있다/없다만 적습니다`);
      }
    }
  }

  // ── 오류는 **미리 정한 코드**로만 나간다 ──
  //
  // 가리개(정규식)를 공개 안전성의 주 방어선으로 쓰지 않는다. 통과 목록이
  // 방어선이다 — 목록에 없는 것은 UNKNOWN으로 접힌다.
  if (!/lastErrorCode:\s*SchedulerErrorCode \| null/.test(judge)) {
    fail(`${JUDGE}의 lastErrorCode가 코드 타입이 아닙니다 — 자유 문자열이 공개됩니다`);
  }
  if (!/export const SCHEDULER_ERROR_CODES\s*=\s*\[/.test(judge)) {
    fail(`${JUDGE}에 SCHEDULER_ERROR_CODES 목록이 없습니다`);
  }
  if (!/SCHEDULER_ERROR_CODES as readonly string\[\]\)\.includes/.test(judge)) {
    fail(`${JUDGE}이 오류 코드를 목록으로 거르지 않습니다 — 임의 문자열이 그대로 통과합니다`);
  }

  // 관측 장치는 본업보다 약해야 한다. 병합기가 던지면 예약도 같이 멈춘다.
  const mergeStart = judge.indexOf('export function mergeSchedulerReport');
  if (mergeStart < 0) fail(`${JUDGE}에 mergeSchedulerReport가 없습니다`);
  else if (!/catch\s*\{/.test(bodyAt(judge, mergeStart))) {
    fail('mergeSchedulerReport에 catch가 없습니다 — 관측 실패가 본업을 죽입니다');
  }
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
  if (!/lastErrorCode\s*:/.test(w)) fail(`${WORKER}이 폴링 오류를 적지 않습니다 — 조용히 멈추면 초록으로 보입니다`);
  if (/lastError\s*:/.test(w)) fail(`${WORKER}이 예외 문구를 보고에 담습니다 — 코드(lastErrorCode)만 적으세요`);
  // 코드 자리에 템플릿 문자열이 들어가면 예외 문구가 그대로 실린다.
  for (const m of w.matchAll(/lastErrorCode\s*:\s*([^,\n}]+)/g)) {
    const v = m[1].trim();
    if (!/^'[A-Z_]+'$/.test(v)) {
      fail(`${WORKER}의 lastErrorCode에 상수가 아닌 값이 들어갑니다: ${v.slice(0, 60)}`);
    }
  }

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
  // ── 관측이 본업을 죽이지 않는가 ──
  //
  // `noteScheduler`가 던지면 예약 평가도 주문 실행도 생존 신호도 같이
  // 멈춘다. 고장을 보려고 만든 것이 고장을 만들면 안 된다.
  const dbForTry = existsSync(WORKER_DB) ? stripJs(readFileSync(WORKER_DB, 'utf8')) : '';
  const noteStart = dbForTry.indexOf('export function noteScheduler');
  if (noteStart < 0) fail(`${WORKER_DB}에서 noteScheduler 본문을 찾지 못했습니다`);
  else if (!/try\s*\{[\s\S]*?catch/.test(bodyAt(dbForTry, noteStart))) {
    fail(`${WORKER_DB}의 noteScheduler가 try/catch 없이 적습니다 — 관측 실패가 워커를 멈춥니다`);
  }
  // 워커가 `await noteScheduler(...)` 하면 관측이 본업 경로에 끼어든다.
  if (/await\s+noteScheduler\s*\(/.test(w)) {
    fail(`${WORKER}이 noteScheduler를 await 합니다 — 관측은 본업을 기다리게 하지 않습니다`);
  }
  notes.push('워커가 환경변수 유무·main 락·폴링 시각·오류를 적습니다 (값 아님)');
  notes.push('관측 실패가 예약·주문·생존 신호를 멈추지 않습니다 (noteScheduler try/catch)');
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
  const withCol = /\.select\(`\$\{COLS\}, scheduler`\)/.test(r);
  const withoutCol = /\.select\(COLS\)/.test(r);
  if (!withCol || !withoutCol) {
    fail(`${ROUTE}에 칸 없는 배포용 재조회가 없습니다 — 073 전에는 이 경로가 통째로 죽습니다`
      + ` (scheduler 포함 조회 ${withCol ? '있음' : '없음'} · 뺀 조회 ${withoutCol ? '있음' : '없음'})`);
  }
  if (!/pickSchedulerRow\s*\(/.test(r)) fail(`${ROUTE}이 main 락을 쥔 줄을 고르지 않습니다`);

  // ── 한 워커의 사실과 다른 워커의 사실을 섞지 않는가 ──
  //
  // 보고는 main 락을 쥔 줄에서 고르면서 생존 여부만 `rows[0]`(가장 최근
  // heartbeat)에서 계산하면, **죽은 main 워커가 살아 있는 예비 워커의
  // 생존 신호를 빌려 쓴다.** 폴링 허용치 안에서 가짜 초록이 나온다.
  const callStart = r.indexOf('schedulerVerdict({');
  if (callStart < 0) fail(`${ROUTE}에서 schedulerVerdict 호출을 찾지 못했습니다`);
  else {
    const call = bodyAt(r, callStart);
    for (const bad of ['fly.alive', 'fly.ageSec', 'fly.lastSeen', 'fly.workerId']) {
      if (call.includes(bad)) {
        fail(`${ROUTE}이 schedulerVerdict에 ${bad}을(를) 넘깁니다`
          + ' — 판정 값은 전부 pickSchedulerRow가 고른 같은 줄에서 나와야 합니다');
      }
    }
    for (const need of ['workerAlive:', 'heartbeatAgeSec:', 'workerStartedIso:']) {
      if (!call.includes(need)) fail(`${ROUTE}의 schedulerVerdict 호출에 ${need}이 없습니다`);
    }
  }
  // 고른 줄의 heartbeat로 생존을 계산했는가.
  if (!/picked\.row/.test(r) || !/workerAlive\(nowMs,\s*Number\.isFinite\(pSeenMs\)/.test(r)) {
    fail(`${ROUTE}이 고른 줄의 heartbeat로 생존을 계산하지 않습니다`);
  }
  // 이 경로는 로그인 없이 열린다. 인증을 새로 붙이지 않았는지도 본다.
  if (/auth_required|resolveUserId/.test(r)) {
    fail(`${ROUTE}에 인증이 붙었습니다 — CI가 못 읽게 되면 다시 사람이 확인하게 됩니다`);
  }
  // ── 관측 코드가 실행을 일으키면 안 된다 ──
  //
  // 이 경로는 **읽기만 한다.** 배포를 확인하러 부른 요청이 예약을
  // 평가하거나 주문을 내면, 확인이 곧 실행이 된다.
  if (/\.(insert|update|upsert|delete)\s*\(/.test(r)) fail(`${ROUTE}이 쓰기를 합니다 — 이 경로는 읽기만 합니다`);
  if (/evaluateIfDue|pollSchedules|daily-ladder|dailyLadder/.test(r)) {
    fail(`${ROUTE}이 평가 실행을 부릅니다 — 확인이 곧 실행이 되면 안 됩니다`);
  }
  notes.push(`${ROUTE}은 읽기 전용입니다 (쓰기·평가 실행 없음)`);
  notes.push(`${ROUTE}이 인증 없이 판정과 근거를 돌려줍니다`);
}

// ── 6. 배포마다 찍히는가 ──
const ciRaw = read(CI_SCRIPT);
if (ciRaw) {
  const c = stripJs(ciRaw);
  if (!/scheduler/.test(c)) fail(`${CI_SCRIPT}이 예약 판정을 찍지 않습니다 — 사람이 다시 브라우저로 열게 됩니다`);
  // 확인기가 실행을 일으키면 확인이 곧 실행이 된다. GET 말고는 없어야 한다.
  if (/method\s*:\s*['"`](POST|PUT|PATCH|DELETE)/i.test(c)) {
    fail(`${CI_SCRIPT}이 쓰기 요청을 보냅니다 — 배포 확인은 읽기만 합니다`);
  }
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
