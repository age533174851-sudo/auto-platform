#!/usr/bin/env node
// scripts/check-kill-close-safety.mjs
//
// **긴급 종료의 안전 조건을 소스에서 고정한다.**
//
// 시험은 "지금 이렇게 동작한다"를 확인한다. 이 검사기는 **"그렇게만
// 동작할 수 있다"**를 확인한다 — 관문을 우회하는 호출이 새로 생기면
// 시험은 그대로 초록인 채로 남는다.
//
// 지키는 네 가지
// ──────────────
//   K-1 모드 관문을 **취소·종료보다 먼저** 지난다
//   K-2 모든 긴급 종료 주문이 멱등 식별자를 싣는다
//   K-3 쓰기 직전 울타리를 재검증한다 (긴급은 선점한다)
//   K-4 계좌 전체 Cancel All·Close All이 긴급 경로에 **없다**
//
// ★ 가장 중요한 것: **닫을 수 없으면 취소하지도 않는다**는 불변식이
//   `killClosePlan`의 한 자리(`clamp`)에서 조여지고, 그 함수를 실제로
//   불러서 확인한다.

import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const PLAN = 'src/lib/risk/killClosePlan.ts';
const RUN = 'src/lib/risk/killCloseRun.ts';
const SW = 'src/lib/risk/killSwitch.ts';
const TRIG = 'src/app/api/risk/kill-switch/trigger/route.ts';
const STAT = 'src/app/api/risk/kill-switch/status/route.ts';
const LEASE = 'src/lib/engine/exitMonitorLease.ts';
const STORE = 'src/lib/engine/exitLeaseStore.ts';
const MON = 'src/app/api/autotrade/exit-monitor/route.ts';

const errors = [];
const err = (m) => errors.push(m);
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
/** 주석을 벗긴다 — 검사기가 자기 설명 주석을 근거로 통과하면 안 된다 */
const code = (s) => (s ?? '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

/** `fn(`의 인자 전체를 괄호를 세어 떼어 온다 */
const callArgsOf = (src, fn) => {
  const at = src.indexOf(`${fn}(`);
  if (at < 0) return null;
  const i = at + fn.length;
  let depth = 0;
  for (let k = i; k < src.length; k += 1) {
    if (src[k] === '(') depth += 1;
    else if (src[k] === ')') { depth -= 1; if (depth === 0) return src.slice(i + 1, k); }
  }
  return null;
};

// ── 판정 정본을 **실제로 불러서** 확인한다 ──
//
// `killClosePlan`은 의존이 없다(순수 판정). 그래서 한 파일만 컴파일해서
// 불러 볼 수 있다. 소스 패턴만 보는 검사는 "그렇게 적혀 있다"까지만 말한다.
let mod = null;
{
  const src = read(PLAN);
  if (src == null) err(`${PLAN}을(를) 읽지 못했습니다`);
  else {
    const dir = mkdtempSync(join(tmpdir(), 'traigo-kcs-'));
    process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    const dest = join(dir, PLAN);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, src);
    const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tsc)) err(`TypeScript가 없습니다 (${tsc}) — 먼저 npm ci`);
    else {
      writeFileSync(join(dir, 'tsconfig.probe.json'), JSON.stringify({
        compilerOptions: { module: 'commonjs', target: 'es2019', skipLibCheck: true },
        files: [PLAN],
      }));
      try {
        execFileSync(process.execPath, [tsc, '-p', 'tsconfig.probe.json'],
          { cwd: dir, stdio: 'pipe', timeout: 180_000 });
        mod = await import(`file://${join(dir, PLAN.replace(/\.ts$/, '.js'))}`);
      } catch (e) {
        err(`${PLAN}이(가) 단독으로 컴파일되지 않습니다 — 순수 판정 모듈이 아니게 됐습니다`
          + `\n${String(e.stdout || e.message).trim().slice(0, 300)}`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
// ★★ 핵심 불변식 — 닫을 수 없으면 취소하지도 않는다
// ══════════════════════════════════════════════════════════
if (mod && typeof mod.planKillClose === 'function') {
  const POS = { ok: true, rows: [{ symbol: 'BTCUSDT', amount: 0.01 }] };
  const ORD = { ok: true, rows: [{ id: '111', symbol: 'BTCUSDT' },
    { id: '999', symbol: 'SOLUSDT' }] };
  const modes = [
    ['UNKNOWN', { ok: false, code: 'UNKNOWN', mode: null, message: 'm' }],
    ['HEDGE', { ok: false, code: 'HEDGE_UNVERIFIED', mode: 'HEDGE', message: 'm' }],
    ['NO_DIRECTION', { ok: false, code: 'NO_DIRECTION', mode: 'ONE_WAY', message: 'm' }],
    ['관문 없음', null],
  ];
  for (const [label, modeVerdict] of modes) {
    const p = mod.planKillClose({ modeVerdict, positions: POS, openOrders: ORD });
    if (p?.mayClose !== false) {
      err(`모드 ${label}에서 종료가 허용됩니다 — 양방향 계좌에서 반대 포지션이 될 수 있습니다`);
    }
    if (p?.mayCancel !== false || (p?.cancelIds?.length ?? 1) !== 0) {
      err(`★ 모드 ${label}에서 **취소가 허용됩니다** — 닫지도 못하면서 보호주문만`
        + ' 벗기면 포지션이 무방비로 남습니다. 이번 수정의 핵심 안전 조건입니다');
    }
    if (p?.protectionRetained !== true) {
      err(`모드 ${label}에서 protectionRetained가 참이 아닙니다`);
    }
  }
  // 포지션을 못 읽었을 때도 같다
  const unread = mod.planKillClose({
    modeVerdict: { ok: true, code: 'ONE_WAY', mode: 'ONE_WAY', message: '' },
    positions: { ok: false }, openOrders: ORD });
  if (unread?.mayCancel !== false || unread?.mayClose !== false) {
    err('포지션을 못 읽었는데 취소·종료가 허용됩니다 — flat이 아닙니다');
  }
  // 범위: 다른 심볼의 주문을 넣지 않는다
  const ok = mod.planKillClose({
    modeVerdict: { ok: true, code: 'ONE_WAY', mode: 'ONE_WAY', message: '' },
    positions: POS, openOrders: ORD });
  if (ok?.code !== 'PROCEED') err(`정상 경로가 PROCEED가 아닙니다 (${ok?.code})`);
  if ((ok?.cancelIds ?? []).includes('999')) {
    err('★ 닫을 대상이 아닌 심볼(SOLUSDT)의 주문이 취소 목록에 있습니다'
      + ' — 다른 전략의 보호주문을 지웁니다');
  }
  // 주문을 못 읽으면 전체 취소로 대신하지 않는다
  const noOrd = mod.planKillClose({
    modeVerdict: { ok: true, code: 'ONE_WAY', mode: 'ONE_WAY', message: '' },
    positions: POS, openOrders: { ok: false } });
  if (noOrd?.mayCancel !== false) {
    err('미체결 주문을 못 읽었는데 취소가 허용됩니다 — 임의 전체 취소 금지');
  }
}

// "주문만 중지" 단계: 포지션이 있는 심볼의 주문을 지우지 않는다
if (mod && typeof mod.planKillCancelOnly === 'function') {
  const p = mod.planKillCancelOnly({
    positions: { ok: true, rows: [{ symbol: 'BTCUSDT', amount: 0.01 }] },
    openOrders: { ok: true, rows: [{ id: '111', symbol: 'BTCUSDT' },
      { id: '222', symbol: 'ETHUSDT' }] },
  });
  if ((p?.cancelIds ?? []).includes('111')) {
    err('★ 포지션이 있는 심볼의 주문이 취소 목록에 있습니다'
      + ' — 닫지 않는 단계에서 보호주문을 벗기면 그 포지션이 무방비가 됩니다');
  }
  const unread = mod.planKillCancelOnly({
    positions: { ok: false }, openOrders: { ok: true, rows: [{ id: '1', symbol: 'X' }] } });
  if ((unread?.cancelIds?.length ?? 1) !== 0) {
    err('포지션을 못 읽었는데 취소합니다 — 어느 심볼이 비어 있는지 알 수 없습니다');
  }
}

// ══════════════════════════════════════════════════════════
// K-4 — 계좌 전체 취소·종료가 긴급 경로에 없다
// ══════════════════════════════════════════════════════════
{
  const sw = code(read(SW));
  if (!sw) err(`${SW}을(를) 읽지 못했습니다`);
  else {
    for (const bad of ['futuresCancelAll', 'futuresCloseAll',
      'cancelAllOpenOrders', 'closeAllPositions']) {
      if (sw.includes(bad)) {
        err(`${SW}이(가) ${bad}을(를) 부릅니다 — 계좌 전체 취소·종료는 같은 계좌의`
          + ' 다른 전략이 걸어 둔 손절까지 지웁니다 (P2에서 제거했습니다)');
      }
    }
    if (!sw.includes('cancelExact')) {
      err(`${SW}이(가) cancelExact를 쓰지 않습니다 — 번호를 지정해 취소해야 합니다`);
    }
    if (!sw.includes('runKillClose')) {
      err(`${SW}이(가) runKillClose를 부르지 않습니다 — 안전 순서가 배선되지 않았습니다`);
    }
    if (!sw.includes('planKillCancelOnly')) {
      err(`${SW}이(가) planKillCancelOnly를 쓰지 않습니다`
        + ' — 닫지 않는 단계의 취소 범위가 좁혀지지 않았습니다');
    }
    if (!sw.includes('accountCloseModeGate')) {
      err(`${SW}이(가) 모드 관문을 부르지 않습니다`);
    }
  }
}

// ══════════════════════════════════════════════════════════
// K-1·K-2·K-3 — 실행 순서가 배선됐는가
// ══════════════════════════════════════════════════════════
{
  const run = code(read(RUN));
  if (!run) err(`${RUN}을(를) 읽지 못했습니다`);
  else {
    if (!run.includes('planKillClose(')) err(`${RUN}이(가) 계획을 부르지 않습니다`);
    if (!run.includes('killIntentId(')) {
      err(`${RUN}이(가) 멱등 식별자를 만들지 않습니다 (K-2)`);
    }
    if (!run.includes('killProtectionVerdict(')) {
      err(`${RUN}이(가) 보호 상태를 판정하지 않습니다 (K-4)`);
    }
    // 순서: 울타리 재검증이 취소보다 앞
    //
    // ★ **함수 본문 안에서만** 센다. 파일 전체로 세면 `KillCloseDeps`
    //   인터페이스의 선언 순서가 끼어들어 실제 호출 순서를 가린다 —
    //   실제로 그 때문에 한 번 거짓 신호가 났다.
    const bodyAt = run.indexOf('export async function runKillClose(');
    const body = bodyAt < 0 ? '' : run.slice(bodyAt);
    if (!body) err(`${RUN}에서 runKillClose 본문을 찾지 못했습니다`);
    const iMine = body.indexOf('deps.stillMine()');
    const iCancel = body.indexOf('deps.cancelOrders(');
    const iClose = body.indexOf('deps.closeOne(');
    if (iMine < 0) err(`${RUN}이(가) 쓰기 직전 울타리를 재검증하지 않습니다 (K-3)`);
    else if (!(iMine < iCancel)) {
      err(`${RUN}: 울타리 재검증이 취소보다 뒤입니다 — 임차를 잃은 실행자가`
        + ' 남의 보호주문을 지울 수 있습니다');
    }
    if (iCancel >= 0 && iClose >= 0 && !(iCancel < iClose)) {
      err(`${RUN}: 취소가 종료보다 뒤입니다`);
    }
    if (iCancel < 0) err(`${RUN}: 본문이 deps.cancelOrders를 부르지 않습니다`);
    if (iClose < 0) err(`${RUN}: 본문이 deps.closeOne을 부르지 않습니다`);
    // 재시도 전 조회
    if (!run.includes('findByClientId')) {
      err(`${RUN}이(가) 재시도 전 주문 조회를 하지 않습니다 (K-2)`);
    }
    if (!/skippedUnknown/.test(run)) {
      err(`${RUN}: 조회 실패를 신규 주문 허가로 쓰지 않는다는 분기가 없습니다`);
    }
  }
}

// 라우트 배선 — 관문이 **대상 종료보다 앞**에 있는가
{
  const t = code(read(TRIG));
  if (!t) err(`${TRIG}을(를) 읽지 못했습니다`);
  else {
    if (!t.includes('accountCloseModeGate')) {
      err(`${TRIG}이(가) 포지션 모드 관문을 부르지 않습니다 (K-1)`);
    }
    const iGate = t.indexOf('accountCloseModeGate');
    const iTargeted = t.indexOf('runTargetedCloses');
    const iExec = t.indexOf('executeKillActions(sb');
    if (iGate >= 0 && iTargeted >= 0 && !(iGate < iTargeted)) {
      err(`${TRIG}: 모드 관문이 표적 종료보다 뒤입니다 — 순서가 계약입니다`);
    }
    if (iGate >= 0 && iExec >= 0 && !(iGate < iExec)) {
      err(`${TRIG}: 모드 관문이 종료 실행보다 뒤입니다`);
    }
    if (!/killBlocked/.test(t)) {
      err(`${TRIG}: 관문이 막았을 때 종료를 건너뛰는 분기가 없습니다`);
    }
    if (!t.includes('preempt: true')) {
      err(`${TRIG}이(가) 긴급 선점 임차를 잡지 않습니다 (K-3)`);
    }
    const args = callArgsOf(t, 'executeKillActions');
    if (args && !/stillMine/.test(args)) {
      err(`${TRIG}: executeKillActions에 울타리 확인을 넘기지 않습니다 (K-3)`);
    }
  }
  const st = code(read(STAT));
  if (st) {
    if (!st.includes('preempt: true')) {
      err(`${STAT}(자동 발동)이 긴급 선점 임차를 잡지 않습니다`);
    }
    const args = callArgsOf(st, 'executeKillActions');
    if (args && !/stillMine/.test(args)) {
      err(`${STAT}: executeKillActions에 울타리 확인을 넘기지 않습니다`);
    }
  }
}

// 임차 선점의 **기본값은 꺼짐**이어야 한다
{
  const l = code(read(LEASE));
  if (!l) err(`${LEASE}을(를) 읽지 못했습니다`);
  else {
    if (!/preempt/.test(l)) err(`${LEASE}에 선점 분기가 없습니다 (K-3)`);
    if (!/preempt === true/.test(l)) {
      err(`${LEASE}: 선점이 \`=== true\`로 확인되지 않습니다`
        + ' — truthy 값이 선점으로 읽히면 일반 감시가 서로를 밀어냅니다');
    }
  }
  // 표를 읽고 쓰는 코드는 한 곳뿐이어야 한다
  const store = read(STORE);
  if (!store) err(`${STORE}이 없습니다 — 임차 표 접근 정본이 사라졌습니다`);
  const mon = code(read(MON));
  if (mon && /from\(['"]exit_monitor_lease['"]\)/.test(mon)) {
    err(`${MON}이(가) 임차 표를 직접 다룹니다 — 같은 판단이 두 벌이 되면`
      + ' 한쪽만 고쳐지고 그때 둘 다 주인이 됩니다 (exitLeaseStore를 쓰세요)');
  }
  if (mon && !mon.includes('exitLeaseStore')) {
    err(`${MON}이(가) exitLeaseStore를 쓰지 않습니다`);
  }
}

if (errors.length) {
  console.error('❌ 긴급 종료 안전성 검사 실패\n');
  for (const e of errors) console.error(`  · ${e}`);
  console.error(`\n총 ${errors.length}건`);
  process.exit(1);
}
console.log('✅ 긴급 종료 안전성 — 모드 관문 우선 · 닫을 수 없으면 취소 없음'
  + ' · 멱등 식별자 · 울타리 선점 · 전체 취소 제거');
