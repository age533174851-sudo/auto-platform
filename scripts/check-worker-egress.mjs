#!/usr/bin/env node
// scripts/check-worker-egress.mjs
//
// **워커가 3초마다 DB를 긁던 자리를 다시 열지 못하게 한다.**
//
// 무엇이 있었나
// ─────────────
// Supabase Free Plan의 Egress가 6.13GB/5GB로 넘어 402가 났다. 원인은
// 한 군데가 아니라 **매 틱(3초)마다 무조건 나가던 조회들**이었다:
//
//   · `jobs.select('*')`                     — `result` 칸까지 통째로
//   · `exchange_connections.select('*')`     — 암호화된 시크릿 칸까지,
//                                              연결마다 킬스위치·잡을 또 조회
//   · `worker_lock.select('*')`              — 매 틱
//   · heartbeat upsert                       — 매 틱
//   · 낡은 잡 회수 스캔                        — 매 틱
//
// 하루 28,800틱이라 한 줄만 되돌려도 수만 번이 다시 나간다. 그래서
// **되돌림을 모양으로 막는다.**
//
// 그리고 더 중요한 것 하나
// ────────────────────────
// 한도 차단기(`routineDbAllowed`)가 **포지션 보호 경로 앞에 붙지 않았는지**
// 센다. 전송량을 아끼려고 청산·정산·보호 조회를 멈추면, 아낀 것보다 큰
// 것을 잃는다. 이 검사가 그 선을 지킨다.

import { readFileSync, existsSync } from 'node:fs';

const WF = 'worker/src/index.ts';
const LOCK = 'worker/src/supabase.ts';
let bad = 0;
const err = (m) => { bad++; console.error(`❌ ${m}`); console.log(`::error::${m}`); };

if (!existsSync(WF) || !existsSync(LOCK)) {
  err(`워커 소스를 찾지 못했습니다 (${WF} · ${LOCK})`);
  process.exit(1);
}
const src = readFileSync(WF, 'utf8');
const lockSrc = readFileSync(LOCK, 'utf8');

/** 함수 하나의 본문을 꺼낸다 (다음 최상위 `async function`까지) */
function bodyOf(text, name) {
  const i = text.indexOf(`async function ${name}(`);
  if (i < 0) return null;
  const rest = text.slice(i + 1);
  const j = rest.search(/^async function /m);
  return j < 0 ? rest : rest.slice(0, j);
}

// ── ① 매 틱 조회가 모든 칸을 끌어오지 않는가 ──
for (const [table, where] of [['jobs', src], ['exchange_connections', src], ['worker_lock', lockSrc]]) {
  const re = new RegExp(`from\\('${table}'\\)[\\s\\S]{0,200}?\\.select\\('\\*'\\)`);
  if (re.test(where)) {
    err(`${table}을(를) \`select('*')\`로 읽습니다 — 3초마다 도는 조회에서 `
      + '쓰지 않는 칸(큰 JSON·암호문)까지 전송량이 됩니다. 쓰는 칸만 적으세요');
  }
}

// ── ② 틱마다 무조건 나가던 것들이 주기 제한을 갖고 있는가 ──
const throttles = [
  { name: 'heartbeat', needle: 'HEARTBEAT_MIN_GAP_MS',
    why: '죽음 판정 문턱이 180초인데 3초마다 적을 이유가 없습니다' },
  { name: '낡은 잡 회수 스캔', needle: 'STALE_SCAN_MS',
    why: '회수 조건이 "만료 + 유예 120초"라 60초에 한 번이면 충분합니다' },
  { name: 'Ghost Sync(monitorConnections)', needle: 'MONITOR_CONNECTIONS_MS',
    why: '연결마다 1+2N번 조회가 나갑니다 — 가장 큰 덩어리였습니다' },
];
for (const t of throttles) {
  if (!src.includes(t.needle)) {
    err(`${t.name}에 주기 제한(\`${t.needle}\`)이 없습니다 — ${t.why}`);
  }
}

// ── ③ 한도 차단기가 **배선돼 있는가** ──
if (!src.includes('routineDbAllowed')) {
  err('한도 차단기(`routineDbAllowed`)를 쓰지 않습니다 — 402에 재시도가 계속 나갑니다');
}
if (!src.includes('noteDb(')) {
  err('조회 결과를 차단기에 반영하지 않습니다(`noteDb`) — 닫힐 일이 없습니다');
}

// ── ④ **한가한 경로에만** 붙어 있는가 ──
const ROUTINE = ['pollSchedules', 'pollLedgerSync', 'pollEquitySnapshot', 'pollChallengeSweep'];
for (const fn of ROUTINE) {
  const body = bodyOf(src, fn);
  if (body == null) { err(`${fn}을(를) 찾지 못했습니다`); continue; }
  if (!body.includes('routineDbAllowed')) {
    err(`${fn}에 한도 차단기가 없습니다 — 한도에 막혀도 계속 조회합니다`);
  }
}

// ── ⑤ **포지션 보호 경로에는 붙어 있지 않은가** (가장 중요한 줄) ──
//
// 전송량을 아끼려고 청산·정산·보호를 멈추지 않는다. 열린 100배 포지션이
// 방치되는 쪽이 훨씬 비싸다.
const PROTECTION = [
  'processPendingJobs', 'pollSmokeTests', 'pollSmokeCancels',
  'pollExitMonitor', 'pollScheduledExit',
];
for (const fn of PROTECTION) {
  const body = bodyOf(src, fn);
  if (body == null) { err(`${fn}을(를) 찾지 못했습니다`); continue; }
  if (body.includes('routineDbAllowed')) {
    err(`${fn}이 한도 차단기 뒤에 있습니다 — 한도를 아끼려고 **포지션 보호**를 `
      + '멈추면 아낀 것보다 큰 것을 잃습니다. 이 경로는 언제나 보내야 합니다');
  }
}

// ── ⑥ 판정 정본을 복제하지 않았는가 ──
if (!src.includes("from '../../src/lib/supabase/quotaBreaker'")) {
  err('차단기 판정을 공유 정본에서 가져오지 않습니다 — 사본을 두면 한쪽만 고쳐집니다');
}

// ── ⑦ 연결 칸 목록을 손으로 적지 않는가 ──
//
// **좁히는 자리가 둘이었다.** `getConnection()`은 여덟 칸을 읽고
// `monitorConnections()`는 일곱 칸을 읽었다 — 빠진 칸이 `encrypted_secret`
// 이었다. 자격증명을 푸는 식은 이렇다:
//
//   secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || '')
//
// `encrypted_secret`에만 비밀이 든 **구 버전 연결**(`api_secret_enc`는
// 004의 기본값 `''`)은 그 자리에서 `secret === ''`가 되고, 바로 다음 줄
// `if (!key || !secret) continue;`에 걸려 **조용히 빠진다.** 그 연결만
// Ghost Sync와 **킬스위치 자가복구**를 잃는다.
//
// 그래서 칸 목록은 값 하나여야 한다. 손으로 적는 자리를 금지한다.
for (const m of src.matchAll(/from\('exchange_connections'\)[\s\S]{0,200}?\.select\(([^)]*)\)/g)) {
  const arg = m[1].trim();
  if (!arg.includes('EXCHANGE_CONNECTION_COLUMNS')) {
    err('exchange_connections의 칸 목록을 손으로 적었습니다 '
      + `(${arg.slice(0, 60)}) — 읽는 자리가 둘이라 갈라집니다. `
      + 'EXCHANGE_CONNECTION_COLUMNS 하나만 쓰세요');
  }
}
if (!src.includes("EXCHANGE_CONNECTION_COLUMNS")) {
  err('연결 칸 목록 정본(EXCHANGE_CONNECTION_COLUMNS)을 쓰지 않습니다');
}

// ── ⑧ 연결을 **못 읽은 것**을 "연결 없음"으로 적지 않는가 ──
//
// `finalize(job, false, ...)`는 잡을 **FAILED로 영구 종료**한다. 조회가
// 한 번 실패했을 뿐인데 청산·킬스위치 잡이 "연결 없음"이라는 틀린 사유로
// 죽으면, 열린 포지션이 보호 없이 남는다. 연결은 멀쩡히 있는데.
{
  const body = bodyOf(src, 'getConnection');
  if (body == null) {
    err('getConnection을 찾지 못했습니다');
  } else if (!body.includes('connectionReadVerdict')) {
    err('getConnection이 조회 실패와 연결 없음을 구분하지 않습니다 — '
      + 'connectionReadVerdict로 READ_FAILED / NOT_FOUND를 갈라 주세요');
  }
  if (!src.includes("from '../../src/lib/supabase/exchangeConnectionRead'")) {
    err('연결 조회 판정을 공유 정본에서 가져오지 않습니다 — 사본을 두면 한쪽만 고쳐집니다');
  }
  const caller = bodyOf(src, 'processPendingJobs') || '';
  // **주석은 코드가 아니다.** 옛 모양을 주석에 인용해 두면 그 문장에
  // 걸린다 — 그래서 `//` 줄을 걷어내고 본다.
  const callerCode = caller.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  if (/연결 없음/.test(caller) && !caller.includes('READ_FAILED')) {
    err('잡 처리에서 연결 조회 결과를 "연결 없음" 한 가지로만 적습니다 — '
      + '못 읽은 것(READ_FAILED)은 없는 것이 아닙니다');
  }

  // ── ⑨ 못 읽은 잡을 **상한 없이** 되돌리지 않는가 ──
  //
  // 조회 실패로 잡을 끝내지 않는 것까지는 맞다. 그런데 그냥 PENDING으로
  // 되돌리기만 하면 3초마다 claim → 되돌림이 반복된다. `max_attempts`
  // 비교는 `runAction` 실패 경로에만 있어서 이 분기에는 걸리지 않는다.
  // 한도(402) 때문에 난 실패라면 아끼려던 전송량을 오히려 늘린다.
  if (caller.includes('READ_FAILED') && !caller.includes('connectionReadRetryPlan')) {
    err('연결 조회 실패 분기에 재시도 상한·간격이 없습니다 — 3초마다 '
      + 'claim과 되돌림이 반복됩니다. connectionReadRetryPlan을 쓰세요');
  }

  // ── 거르는 일이 `limit` **앞**에 있는가 ──
  //
  // 조건이 뒤에 있으면, backoff 중인 우선순위 0짜리 잡 10개가 같은
  // 우선순위의 새 `KILL_SWITCH_EXECUTE`를 11번째로 밀어낸다. DB는 앞의
  // 10개만 돌려주므로 그 킬스위치는 **조회조차 되지 않는다.** 폴러는
  // 멀쩡히 도는데 보호 작업만 굶는다.
  // stale 회수 조회가 아니라 **PENDING 조회**를 겨냥한다.
  const q = caller.match(/\.eq\('status', 'PENDING'\)[\s\S]{0,1200}?\.limit\(/);
  if (!q) {
    err('PENDING 잡 조회를 찾지 못했습니다');
  } else if (!q[0].includes('claimableFilter')) {
    err('PENDING 잡 조회가 재시도 가능 시각을 `limit` 앞에서 거르지 않습니다 — '
      + 'backoff 중인 잡 10개가 11번째 긴급 잡을 가립니다. claimableFilter를 쓰세요');
  }

  // ── 다음에 볼 시각을 **행에** 적는가 ──
  //
  // 프로세스 메모리에 적으면 재시작하면 비고 다른 인스턴스에는 안 보인다.
  // 되돌린 잡을 새 인스턴스가 즉시 다시 집어서, 한도(402) 때문에 쉬게
  // 하려던 것이 오히려 재시도를 늘린다.
  if (/connReadRetryAt|new Map<string, number>\(\)/.test(src)) {
    err('재시도 간격을 프로세스 메모리에 둡니다 — 재시작과 다른 워커에서 '
      + '유지되지 않습니다. locked_until(행)에 적으세요');
  }
  if (caller.includes('READ_FAILED') && /locked_until: null/.test(caller)) {
    err('연결 조회 실패로 되돌리면서 locked_until을 비웁니다 — 다음 틱에 '
      + '바로 다시 집힙니다');
  }
  if (!src.includes("from '../../src/lib/supabase/jobClaimWindow'")) {
    err('잡 선택 조건을 공유 정본에서 가져오지 않습니다 — 사본을 두면 한쪽만 고쳐집니다');
  }

  // ── stale 회수가 **근거를 못 읽고** 되돌리지 않는가 ──
  //
  // 되돌리는 것은 "이 잡은 임자가 없다"는 주장이고 근거는 heartbeat다.
  // `const { data: beats } = …`로 오류를 버리면 조회 실패가 **빈 집합**이
  // 되어 모든 워커가 죽은 것으로 읽힌다 — 살아 있는 워커의 잡이 통째로
  // PENDING으로 돌아가고 다른 워커가 집으면 주문·청산이 중복된다.
  if (!callerCode.includes('staleRecoveryPlan')) {
    err('stale 회수가 판정 정본을 쓰지 않습니다 — heartbeat를 못 읽은 것을 '
      + '"살아 있는 워커 0명"으로 읽으면 살아 있는 워커의 잡을 회수합니다');
  }
  if (/const \{ data: beats \}/.test(callerCode)) {
    err('heartbeat 조회에서 error를 버립니다 — 못 읽은 것은 워커 사망의 증거가 아닙니다');
  }
  if (!src.includes("from '../../src/lib/engine/staleJobRecovery'")) {
    err('stale 회수 판정을 공유 정본에서 가져오지 않습니다 — 사본을 두면 한쪽만 고쳐집니다');
  }
  // ── claim이 **조회에서 본 값**을 조건에 거는가 (CAS) ──
  //
  // 조회에 `claimableFilter`를 걸어도 그것만으로는 원자적이지 않다.
  // `status = 'PENDING'`만 보면 PENDING→PROCESSING→PENDING(ABA)을
  // 구분하지 못해, 그 사이 재시도 대기로 바뀐 잡을 backoff 만료 전에
  // 집고 `attempts` 증가를 덮어쓴다.
  {
    const cl = callerCode.match(/update\(\{ status: 'PROCESSING'[\s\S]{0,900}?\.select\(\)/);
    if (!cl) {
      err('claim UPDATE를 찾지 못했습니다');
    } else {
      if (!cl[0].includes('claimableFilter')) {
        err('claim UPDATE가 재시도 가능 시각을 다시 확인하지 않습니다 — 조회 이후 '
          + '대기로 바뀐 잡을 backoff 만료 전에 집습니다');
      }
      if (!/'attempts'/.test(cl[0])) {
        err('claim UPDATE가 조회 당시 attempts를 조건에 걸지 않습니다 — '
          + 'PENDING→PROCESSING→PENDING(ABA)을 구분하지 못합니다');
      }
    }
    if (!callerCode.includes('claimOutcome')) {
      err('claim 결과에서 0행과 오류를 구분하지 않습니다 — DB 오류가 '
        + '"다른 워커가 가져감"으로 조용히 넘어갑니다');
    }
    if (/const \{ data: claimed \}/.test(callerCode)) {
      err('claim 조회에서 error를 버립니다 — 집었는지 못 집었는지 모르는 것을 '
        + '경쟁 패배로 적습니다');
    }
  }

  // 조회 이후 바뀐 잡을 덮어쓰지 않는다 (CAS)
  if (callerCode.includes('staleRecoveryPlan') && !/eq\('locked_until'/.test(callerCode)) {
    err('stale 회수 UPDATE가 읽을 때 본 locked_until을 조건에 걸지 않습니다 — '
      + '조회 이후 다시 집힌 잡을 덮어씁니다');
  }
}

// ── ⑩ 킬스위치 자가복구가 Ghost Sync에 **묶여 있지 않은가** ──
//
// 예전에는 `monitorConnections()` 안, 거래소 포지션 조회 뒤에 있었다.
// `futuresListPositions`가 실패하면 `continue`에 걸려 **킬스위치가 켜져
// 있어도 복구 잡이 만들어지지 않았다.** 거래소가 흔들릴 때는 정확히
// 킬스위치가 필요한 때다. Ghost Sync의 60초 주기에 끌려가서도 안 된다 —
// 그건 관측이고 이건 보호다.
{
  const mon = bodyOf(src, 'monitorConnections');
  if (mon == null) {
    err('monitorConnections를 찾지 못했습니다');
  } else if (/KILL_SWITCH_EXECUTE/.test(mon)) {
    err('킬스위치 자가복구가 Ghost Sync(monitorConnections) 안에 있습니다 — '
      + '거래소 포지션 조회가 실패하면 같이 멈추고, 관측 주기(60초)에 '
      + '보호가 끌려갑니다. 따로 돌리세요');
  }
  const ks = bodyOf(src, 'pollKillSwitchRecovery');
  if (ks == null) {
    err('pollKillSwitchRecovery를 찾지 못했습니다 — 자가복구가 배선되지 않았습니다');
  } else {
    if (!ks.includes('killSwitchRecoveryVerdict')) {
      err('자가복구가 판정 정본을 쓰지 않습니다 — 못 읽은 것을 "꺼짐"이나 '
        + '"0건"으로 읽으면 복구가 멈추거나 중복 잡이 생깁니다');
    }
    if (/MONITOR_CONNECTIONS_MS/.test(ks)) {
      err('자가복구가 Ghost Sync 주기(MONITOR_CONNECTIONS_MS)를 씁니다 — '
        + '관측 주기에 보호가 끌려갑니다');
    }
    if (!src.includes("from '../../src/lib/engine/killSwitchRecovery'")) {
      err('자가복구 판정을 공유 정본에서 가져오지 않습니다 — 사본을 두면 한쪽만 고쳐집니다');
    }
  }
  if (!src.includes('pollKillSwitchRecovery()')) {
    err('pollKillSwitchRecovery를 틱에서 부르지 않습니다 — 만들어 놓고 배선을 안 한 모양입니다');
  }
}

// Post-claim DB writes must be fenced, and UPDATE errors must not look successful.
{
  const owned = bodyOf(src, 'writeClaimedJob') || '';
  for (const needle of [
    "persistOwnedJob(", ".eq('status', 'PROCESSING')",
    ".eq('locked_by', owner)", ".eq('attempts', attempts)", ".select('id')",
  ]) {
    if (!owned.includes(needle)) err(`잡 후속 상태 쓰기에 소유권 CAS/ACK 누락: ${needle}`);
  }
  const pending = bodyOf(src, 'processPendingJobs') || '';
  if (!pending.includes("'connection-read-retry'") || !pending.includes("'action-retry'")) {
    err('연결 조회 실패 또는 주문 실패 재시도 분기가 소유권 CAS를 거치지 않습니다');
  }
  if (!src.includes("from '../../src/lib/supabase/jobOwnedWrite'")) {
    err('잡 쓰기 결과 판정 정본을 쓰지 않습니다');
  }
}

// ── ⑪ 402가 **나기 전** 사다리가 한가한 경로에 걸려 있는가 ──
//
// `quotaGate`는 402가 난 뒤에 반응한다. 그 시점에는 자동매매·청산 감시가
// 이미 끊긴 뒤다(2026-10-23 `exceed_egress_quota`). 70·85·95% 사다리는
// 그 앞에 선다.
//
// **보호 경로에는 걸지 않는다** — 위 ⑤가 그 선을 이미 센다. 사다리는
// `routineDbAllowed()` 안에만 있어야 한다.
{
  const gate = bodyOf(src, 'routineDbAllowed') || src.slice(src.indexOf('function routineDbAllowed'), src.indexOf('function routineDbAllowed') + 1800);
  if (!/usageAllows\s*\(/.test(gate)) {
    err('한가한 조회 관문에 사용량 사다리가 없습니다 — 402가 난 뒤에야 반응하면 '
      + '그때는 이미 자동매매·청산 감시가 끊긴 뒤입니다');
  }
  if (!/shouldSendUsageAlert\s*\(/.test(gate)) {
    err('사용량 단계가 올라도 알리지 않습니다 — 70·85·95%를 지나는 것을 사람이 봐야 합니다');
  }
  if (!src.includes("from '../../src/lib/supabase/usageBudget'")) {
    err('사용량 판정을 공유 정본에서 가져오지 않습니다 — 사본을 두면 한쪽만 고쳐집니다');
  }
  // 보호 경로에 사다리를 걸면 안 된다
  for (const fn of PROTECTION) {
    const b = bodyOf(src, fn) || '';
    if (/usageAllows\s*\(/.test(b)) {
      err(`${fn}에 사용량 사다리가 걸렸습니다 — 아끼려고 **포지션 보호**를 멈추면 `
        + '아낀 것보다 큰 것을 잃습니다');
    }
  }
}

if (bad === 0) {
  console.log('✅ 워커 전송량 — 매 틱 전체 칸 조회 0 · 주기 제한 3곳 · 한도 차단기 배선됨 · '
    + '포지션 보호 경로는 차단기 뒤에 없음');
} else {
  console.error('');
  console.error('   이 조회들은 3초마다 돕니다. 한 줄이 하루 28,800번입니다.');
  process.exit(1);
}
