#!/usr/bin/env node
// 전용 100배 프로필이 **적힌 그대로 실행되는가.**
//
// 무엇을 막는가
// ─────────────
// 이 저장소에서 100배는 오래 **상한**이었다. 화면의 `levCap=100`은 "여기까지
// 허용"이고, 실제 배율은 손절 거리에서 역산돼 그 상한에서 잘렸다. 손절
// 0.5%면 75배가 나간다. 그런데 화면에는 100배라고 적혀 있었다.
//
// 전용 프로필은 그것과 다른 물건이다 — 요청이 **정확히 100**이고, 거래소에
// 되읽어 100이 확인될 때만 주문한다. 그 차이가 지켜지지 않으면 두 개념이
// 다시 하나로 뭉개지고, 그때 사용자는 상한 100배를 고른 것을 전용 100배로
// 읽는다.
//
// 왜 문자열이 아니라 조건을 보는가
// ────────────────────────────────
// 이 저장소에서 검사기가 새 나간 형태가 반복해서 같았다 — 메시지는 그대로
// 두고 조건만 `if (false)`로 바꾸면 통과했고, 호출을 stub으로 바꿔도
// import에 이름이 남아 통과했다. 그래서 여기서는 **정본을 컴파일해서 실제로
// 부르고**, 배선은 "이름이 있는가"가 아니라 "옛 판단이 사라졌는가"까지 본다.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { stripJsComments } from './lib/strip-comments.mjs';

const PROFILES_TS = 'src/lib/strategies/profiles.ts';
const PLAN        = 'src/lib/execution/profile.ts';
const GATE        = 'src/lib/execution/dormantGate.ts';
const EXEC        = 'src/lib/engine/orderExecutor.ts';
const REATTACH    = 'src/lib/engine/stopReattach.ts';
const SIZING      = 'src/lib/engine/sizing100x.ts';
const CHECKLIST   = 'src/lib/engine/preTradeChecklist.ts';
const LIFECYCLE   = 'src/lib/engine/exitLifecycle.ts';
const SCHED       = 'src/app/api/autotrade/schedule/route.ts';
const RUNNER      = 'src/lib/autotrade/evaluationRunner.ts';
const WORKER      = 'worker/src/index.ts';
const MIG         = 'supabase/migrations/078_live_orders_stop_policy.sql';

const ID = 'MAX_LEV_100X';

let bad = 0;
const err = m => { console.error(`❌ ${m}`); bad++; };
const read = f => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const code = f => stripJsComments(read(f));

// ─────────────────────────────────────────────────────────────
// ① 정본을 실제로 컴파일해서 부른다 (값을 소스에서 읽지 않는다)
// ─────────────────────────────────────────────────────────────
//
// 프로필 리터럴을 regex로 읽으면 `applyPreset`이 그 위에 얹는 override를
// 보지 못한다. 화면에 100배로 뜨는지는 **합쳐진 결과**가 정한다.

const REL = /^\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,]+from\s+)?['"](\.[^'"]+)['"]/gm;

const collect = (entry) => {
  const files = new Map();
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    if (files.has(f)) continue;
    const src = read(f);
    if (!src) { files.set(f, null); continue; }
    files.set(f, src);
    let m;
    REL.lastIndex = 0;
    while ((m = REL.exec(src))) {
      const p = join(dirname(f), m[1]);
      for (const cand of [`${p}.ts`, `${p}.tsx`, join(p, 'index.ts')]) {
        if (existsSync(cand)) { queue.push(cand); break; }
      }
    }
  }
  return files;
};

const loadModule = async (entry, what) => {
  const files = collect(entry);
  const dir = mkdtempSync(join(tmpdir(), 'traigo-100x-'));
  for (const [f, src] of files) {
    if (src == null) { err(`${what}: ${f}을(를) 읽지 못했습니다`); return null; }
    const dest = join(dir, f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, src);
  }
  const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) { err(`TypeScript가 없습니다 (${tsc}). 먼저 npm ci`); return null; }
  try {
    execFileSync(process.execPath, [tsc, entry, '--module', 'commonjs',
      '--target', 'es2019', '--skipLibCheck'], { cwd: dir, stdio: 'pipe', timeout: 180_000 });
  } catch (e) {
    err(`${what}: 컴파일되지 않습니다\n${String(e.stdout || e.message).trim().slice(0, 400)}`);
    return null;
  }
  return import(`file://${join(dir, entry.replace(/\.tsx?$/, '.js'))}`);
};

const plan = await loadModule(PLAN, '실행 계약 정본');

if (plan) {
  // ── 정체 ──
  const r = plan.resolveExecutionProfile(ID, 'STABILIZE', plan.EXECUTION_CONTRACT_VERSION);
  if (!r?.ok || r.kind !== 'contract') {
    err(`${ID} 계약이 해석되지 않습니다 — 전용 100배 프로필이 없거나 계약에서 빠졌습니다`);
  } else {
    const c = r.contract;
    if (c.leverage !== 100) err(`${ID}의 요청 배율이 ${c.leverage}입니다 — 정확히 100이어야 합니다`);
    if (c.maxLeverage !== 100) {
      err(`${ID}의 상한이 ${c.maxLeverage}입니다 — 요청값과 달라지면 "정확히 100"이 아닙니다`);
    }
    if (c.stopPolicy !== 'NO_FIXED_SL') err(`${ID}의 stopPolicy가 ${c.stopPolicy}입니다`);
    if (c.stopLossPct !== null) {
      err(`${ID}에 손절 숫자가 남아 있습니다 (${c.stopLossPct}) — 걸지도 않을 값이 사이징의 분모나`
        + ' 복구 경로의 손절가로 되살아납니다');
    }
    if (!Array.isArray(c.marginModes) || c.marginModes.join(',') !== 'isolated') {
      err(`${ID}의 마진 모드가 isolated 전용이 아닙니다 (${JSON.stringify(c.marginModes)})`
        + ' — 교차면 100배 손실이 지갑 전체로 번집니다');
    }
  }

  // ── 프리셋 불변 ──
  //
  // **모든 프리셋에서 100이어야 한다.** 안정화가 배율을 낮추면 "정확히
  // 100배"가 프리셋에 따라 달라지고, 그건 다른 계약이다.
  for (const sid of ['STABILIZE', 'RESEARCH']) {
    const rr = plan.resolveExecutionProfile(ID, sid, plan.EXECUTION_CONTRACT_VERSION);
    if (!rr?.ok || rr.kind !== 'contract') { err(`${ID}/${sid} 계약 해석 실패`); continue; }
    if (rr.contract.leverage !== 100 || rr.contract.maxLeverage !== 100) {
      err(`${ID}/${sid}의 배율이 100이 아닙니다 (${rr.contract.leverage}/${rr.contract.maxLeverage})`
        + ' — 프리셋이 전용 100배를 낮추면 안 됩니다');
    }
  }

  // ── 누출: 다른 프로필이 NO_FIXED_SL 의미를 갖지 않는다 ──
  for (const pid of ['SCALP_HIGH_LEV', 'SWING_LOW_LEV', 'DAILY_HIGH_LEV']) {
    for (const sid of ['STABILIZE', 'RESEARCH']) {
      const rr = plan.resolveExecutionProfile(pid, sid, plan.EXECUTION_CONTRACT_VERSION);
      if (!rr?.ok || rr.kind !== 'contract') { err(`${pid}/${sid} 계약 해석 실패`); continue; }
      if (rr.contract.stopPolicy !== 'FIXED_SL') {
        err(`${pid}/${sid}이 NO_FIXED_SL이 됐습니다 — 기존 전략의 손절이 꺼집니다`);
      }
    }
  }

  // ── 계약이 없으면 NO_FIXED_SL을 만들 수 없다 ──
  //
  // 레거시 levCap=100은 계약이 아니다. 여기가 기본값 방향을 지키는 자리다.
  if (typeof plan.stopPolicyOfContract !== 'function') {
    err(`${PLAN}: stopPolicyOfContract()가 없습니다 — 기본값이 여러 곳에 흩어집니다`);
  } else if (plan.stopPolicyOfContract(null) !== 'FIXED_SL'
          || plan.stopPolicyOfContract(undefined) !== 'FIXED_SL') {
    err('계약이 없을 때 기본 손절 정책이 FIXED_SL이 아닙니다'
      + ' — 이 한 글자가 모든 기존 전략의 손절을 끕니다');
  }
  if (typeof plan.marginAllocationOfContract !== 'function'
      || plan.marginAllocationOfContract(null) !== null) {
    err('계약이 없을 때 증거금 배정이 null이 아닙니다 — 화면 기본값을 빌려 오면 안 됩니다');
  }

  // ── 계약 칸 ──
  for (const f of ['stopPolicy', 'marginAllocationPct']) {
    if (!plan.CONTRACT_FIELDS?.includes(f)) {
      err(`CONTRACT_FIELDS에 ${f}가 없습니다 — 지문이 이 값의 변경을 못 잡습니다`);
    }
  }
}

// ── 사이징: 정본을 불러 실제로 판정시킨다 ──
const sizing = await loadModule(SIZING, '100X 사이징');
if (sizing) {
  const base = {
    requiredLeverage: 100, observedLeverage: 100,
    availableUsd: 1000, marginAllocationPct: 10, referencePrice: 50_000,
  };
  const must = (input, why) => {
    const v = sizing.planSize100x({ ...base, ...input });
    if (v.ok) err(`100X 사이징: ${why} — 그런데 통과했습니다 (수량 ${v.quantity})`);
  };
  must({ observedLeverage: 99 }, '되읽은 배율이 99배면 막아야 합니다');
  must({ observedLeverage: 75 }, '되읽은 배율이 75배면 막아야 합니다');
  must({ observedLeverage: null }, '배율을 못 읽었으면 막아야 합니다');
  must({ availableUsd: null }, '잔고를 못 읽었으면 막아야 합니다');
  must({ marginAllocationPct: null }, '증거금 배정이 미지정이면 막아야 합니다');
  must({ referencePrice: null }, '기준가를 못 읽었으면 막아야 합니다');
  const ok = sizing.planSize100x(base);
  if (!ok.ok) err(`100X 사이징: 정상 입력이 막혔습니다 — ${ok.message}`);
}

// ── 재부착 판정 ──
const reattach = await loadModule(REATTACH, '손절 재부착 판정');
if (reattach) {
  // **손절가가 남아 있어도** 정책이 이겨야 한다. 값 검사가 앞에 오면 여기가 빨개진다.
  const v = reattach.stopReattachVerdict({ stop_policy: 'NO_FIXED_SL', stop_loss: 49_000 });
  if (v.attach) {
    err('NO_FIXED_SL 주문에 손절이 다시 걸립니다 — 사용자가 고른 적 없는 자리에 STOP_MARKET이 나갑니다');
  }
  const legacy = reattach.stopReattachVerdict({ stop_loss: 49_000 });
  if (!legacy.attach) err('기존 주문의 손절 복구가 막혔습니다 — 보호 없는 포지션이 남습니다');
}

// ── dormant 게이트 ──
const gate = await loadModule(GATE, 'dormant 게이트');
if (gate) {
  if (gate.executionGateVerdict(null).allowed !== true) {
    err('프로필이 없는 기존 예약이 막힙니다 — 기존 동작이 바뀌었습니다');
  }
  if (gate.executionGateVerdict('WHATEVER_UNKNOWN').allowed !== false) {
    err('모르는 프로필 id가 통과합니다 — 오타 하나가 기존 방식으로 도는 예약이 됩니다');
  }
  // 목록을 채우면 켜기 조건이 **실제로 달라져야** 한다. 안 달라지면
  // 나중에 프로필을 열어도 L3가 계속 막는데 아무도 모른다.
  const opened = gate.enableFilterSpec([ID]);
  if (opened.kind !== 'or' || !String(opened.expr).includes(ID)) {
    err('열린 목록을 채워도 켜기(L3) 조건이 바뀌지 않습니다'
      + ' — 실행기만 열리고 사용자는 켤 수 없는 상태가 됩니다');
  }
  if (gate.enableFilterSpec([]).kind !== 'isNull') {
    err('열린 목록이 비었는데 켜기 조건이 넓어졌습니다');
  }
  // 지금은 비어 있어야 한다 (자동 종료 권한 미증명 · 증거금 배정 미지정).
  if ((gate.EXECUTABLE_PROFILE_IDS || []).length > 0) {
    err('EXECUTABLE_PROFILE_IDS가 비어 있지 않습니다 — 고정 손절을 대신할 자동 종료 권한이'
      + ' 배선됐다는 증거와 증거금 배정 값이 먼저 있어야 합니다 (dormantGate 머리말)');
  }
}

// ─────────────────────────────────────────────────────────────
// ② 배선 — 이름이 아니라 "옛 판단이 사라졌는가"를 본다
// ─────────────────────────────────────────────────────────────
const exec = code(EXEC);

// 배율: 두 거래소 다 되읽기 판정을 타야 한다.
const applyCalls = (exec.match(/futuresApplyLeverage\s*\(/g) || []).length;
if (applyCalls < 2) {
  err(`${EXEC}: futuresApplyLeverage 호출이 ${applyCalls}건입니다 — Binance·Gate 두 경로 모두여야 합니다`);
}
// **옛 판단이 남아 있으면 실패다.** 설정 응답의 success로 배율을 통과시키는
// 자리가 그대로면, 거래소가 100 → 75로 낮춘 경우가 성공으로 지나간다.
for (const [re, what] of [
  [/if\s*\(\s*!\s*\(?\s*\(?\s*lev\s*(?:as\s+any\s*)?\)?\s*\??\.?\s*success/, '설정 응답의 success로 배율을 판정'],
]) {
  if (re.test(exec)) err(`${EXEC}: ${what}하는 자리가 남아 있습니다 — VENUE_CAPPED가 성공으로 지나갑니다`);
}
if (!/if\s*\(\s*!\s*lev\.ok\s*\)/.test(exec)) {
  err(`${EXEC}: leverageVerdict의 ok로 막는 자리가 없습니다`);
}

// 손절 재부착: 판정을 복제하지 않고 정본을 부른다.
if (!/stopReattachVerdict\s*\(/.test(exec)) {
  err(`${EXEC}: attachStopIfMissing이 stopReattachVerdict를 부르지 않습니다 — 규칙이 시험 밖에 있습니다`);
}
if (/if\s*\(\s*String\(\s*o\?\.stop_policy/.test(exec)) {
  err(`${EXEC}: 재부착 판정이 다시 복제됐습니다 — 정본과 갈립니다`);
}

// 고정 손절 정책이 protectionPolicy를 덮는가 + 모순을 막는가
if (!/args\.stopPolicy\s*===\s*'NO_FIXED_SL'/.test(exec)) {
  err(`${EXEC}: stopPolicy가 주문 경로에 전달되지 않습니다`);
}
if (!/noFixedSl\s*\?\s*'NONE'/.test(exec)) {
  err(`${EXEC}: NO_FIXED_SL이 protectionPolicy를 NONE으로 덮지 않습니다`);
}
if (!/noFixedSl\s*&&\s*args\.stopLoss\s*!=\s*null/.test(exec)) {
  err(`${EXEC}: NO_FIXED_SL인데 손절가가 함께 온 모순을 막지 않습니다`
    + ' — 조용히 무시하면 화면에는 손절이 있고 거래소에는 없습니다');
}

// 체크리스트 N/A 축
const cl = code(CHECKLIST);
if (!/FIXED_STOP_ONLY_CHECKS/.test(cl) || !/stopPolicy\s*===\s*'NO_FIXED_SL'/.test(cl)) {
  err(`${CHECKLIST}: 손절 항목의 N/A 축이 없습니다`);
}
if (!/appliesTo\([^)]*stopPolicy\s*\)/s.test(cl)) {
  err(`${CHECKLIST}: runChecklist가 appliesTo에 stopPolicy를 넘기지 않습니다`
    + ' — 축은 있는데 아무도 안 먹이는 상태입니다');
}
// 배열 **본문**만 떼어내서 본다. `FIXED_STOP_ONLY_CHECKS ... 'X'`로 훑으면
// 선언부의 `CheckId[]`에 든 `]`나 파일 뒤쪽의 다른 등장에 걸려 판정이
// 엉뚱해진다 — 검사기가 틀리는 것도 고장이다.
const fixedOnlyBody = (cl.match(/FIXED_STOP_ONLY_CHECKS[^=]*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
for (const id of ['STOP_ATTACHED', 'LIQUIDATION_DISTANCE', 'PROTECTIVE_ORDER']) {
  if (!fixedOnlyBody.includes(`'${id}'`)) {
    err(`${CHECKLIST}: ${id}이(가) 손절 전용 목록에 없습니다`);
  }
}

// 청산 감시: 고정 손절 없는 포지션에 손절을 새로 걸지 않는다
if (!/NO_FIXED_STOP/.test(code(LIFECYCLE))) {
  err(`${LIFECYCLE}: 고정 손절이 없는 포지션에 대한 판정이 없습니다`
    + ' — planTrail의 1R 계산 실패에 기대고 있습니다');
}

// L3 / L4가 같은 목록을 읽는가
const sched = code(SCHED), runner = code(RUNNER);
if (!/enableFilterSpec\s*\(/.test(sched)) {
  err(`${SCHED}: 켜기 조건이 dormantGate를 읽지 않습니다`);
}
if (/\.is\(\s*'execution_profile_id'\s*,\s*null\s*\)[^;]*;\s*$/m.test(sched)
    && !/gateSpec/.test(sched)) {
  err(`${SCHED}: 켜기 필터가 목록과 무관하게 고정돼 있습니다`);
}
if (!/executionGateVerdict\s*\(/.test(runner)) {
  err(`${RUNNER}: 실행 직전 판정이 dormantGate를 읽지 않습니다 — L3와 갈립니다`);
}

// 워커 SET_TPSL 경계
const wk = code(WORKER);
if (!/stopPolicy[^\n]*NO_FIXED_SL/.test(wk)) {
  err(`${WORKER}: SET_TPSL이 고정 손절 없는 포지션을 거르지 않습니다`);
}

// 마이그레이션
// SQL 주석(`--`)을 떼고 본다. 안 떼면 "왜 NOT NULL이 아닌가"라고 **설명한
// 주석** 때문에 NOT NULL을 걸었다고 판정한다.
const migRaw = read(MIG);
const mig = migRaw.replace(/--[^\n]*/g, '');
if (!migRaw) err(`${MIG}이 없습니다 — 복구 경로가 정책을 읽을 칸이 없습니다`);
else {
  if (!/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+stop_policy/i.test(mig)) {
    err(`${MIG}: stop_policy 칸을 더하지 않습니다`);
  }
  if (!/live_orders_stop_policy_known/.test(mig)) {
    err(`${MIG}: 값 제약에 이름이 없습니다 — 이름이 없으면 나중에 확인·삭제할 수 없습니다`);
  }
  if (/NOT\s+NULL/i.test(mig)) {
    err(`${MIG}: NOT NULL을 걸면 기존 행에 "그때 그렇게 판단했다"는 거짓 기록이 생깁니다`);
  }
}
// 저장 후퇴 금지 — 칸이 없으면 붙이지 않고 저장하는 길이 있으면 안 된다
if (!/noFixedSl\s*\?\s*\{\s*stop_policy:\s*'NO_FIXED_SL'\s*\}/.test(exec)) {
  err(`${EXEC}: NO_FIXED_SL 주문에 stop_policy를 적지 않습니다`
    + ' — 복구 경로가 이 주문을 고정 손절 주문으로 읽습니다');
}

if (bad) {
  console.error(`\n전용 100배 계약 검사 실패: ${bad}건`);
  process.exit(1);
}
console.log('✅ 전용 100배 계약 (정확 100 · 고정 손절 없음 · 누출 0 · dormant)');
