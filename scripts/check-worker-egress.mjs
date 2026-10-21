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

if (bad === 0) {
  console.log('✅ 워커 전송량 — 매 틱 전체 칸 조회 0 · 주기 제한 3곳 · 한도 차단기 배선됨 · '
    + '포지션 보호 경로는 차단기 뒤에 없음');
} else {
  console.error('');
  console.error('   이 조회들은 3초마다 돕니다. 한 줄이 하루 28,800번입니다.');
  process.exit(1);
}
