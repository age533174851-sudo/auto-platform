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
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { stripJsComments } from './lib/strip-comments.mjs';

const PROFILES_TS = 'src/lib/strategies/profiles.ts';
const PLAN        = 'src/lib/execution/profile.ts';
const GATE        = 'src/lib/execution/dormantGate.ts';
const COVERAGE    = 'src/lib/engine/exitCoverage.ts';
const LIQ         = 'src/lib/engine/liquidationDistance.ts';
const COST        = 'src/lib/engine/executionCost.ts';
const EXEC        = 'src/lib/engine/orderExecutor.ts';
const REATTACH    = 'src/lib/engine/stopReattach.ts';
const SIZING      = 'src/lib/engine/sizing100x.ts';
const CHECKLIST   = 'src/lib/engine/preTradeChecklist.ts';
const LIFECYCLE   = 'src/lib/engine/exitLifecycle.ts';
const SCHED       = 'src/app/api/autotrade/schedule/route.ts';
const RUNNER      = 'src/lib/autotrade/evaluationRunner.ts';
const WORKER      = 'worker/src/index.ts';
const ENTRY       = 'src/lib/engine/entry100x.ts';
const SCALP       = 'src/app/api/autotrade/scalp/route.ts';
const RUNREQ      = 'src/lib/strategies/runRequest.ts';
const UI          = 'src/components/AutotradeControl.tsx';
const AUTHORITY   = 'src/lib/engine/entryAuthority.ts';
const MIG         = 'supabase/migrations/078_live_orders_stop_policy.sql';
const MIG_ALLOC   = 'supabase/migrations/079_schedule_margin_allocation.sql';
const MIG_OPEN    = 'supabase/migrations/080_execution_profile_selective.sql';

const ID = 'MAX_LEV_100X';
const PRESET = 'EXACT_100X';

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

// 상대 경로와 `@/` 별칭을 **둘 다** 따라간다.
//
// ★ 예전에는 상대 경로만 봤다. 그래서 정본이 `@/lib/...`를 하나라도
//   쓰면 컴파일이 깨지고, 그 파일은 **동작으로 검사할 수 없었다** —
//   글자만 보는 규칙으로 물러나게 되는 조용한 이유였다.
const REL = /^\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,]+from\s+)?['"]((?:\.|@\/)[^'"]+)['"]/gm;

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
      const spec = m[1];
      const p = spec.startsWith('@/') ? join('src', spec.slice(2)) : join(dirname(f), spec);
      for (const cand of [`${p}.ts`, `${p}.tsx`, join(p, 'index.ts')]) {
        if (existsSync(cand)) { queue.push(cand); break; }
      }
    }
  }
  return files;
};

// ── 임시 작업판을 치운다 ──
//
// `loadModule`은 호출마다 `mkdtemp`로 작업판을 만들어 의존 파일을 복사하고
// tsc로 컴파일한다. 그런데 **그 디렉터리를 지우지 않았다.**
//
// 검사기 한 번에 `loadModule`을 열 번 넘게 부르고, 돌연변이 전수는 검사기를
// 376번 돌린다. 한 번의 전수가 수천 개를 남기고, 그것이 세션 디스크 할당량을
// 먹어 전수가 **ENOSPC로 죽는다.** 실제로 그 상태에서 소스 파일이 중간에서
// 잘렸다(`positionSizing.ts`). /tmp에 190,615개가 쌓여 있었다.
//
// `import`가 끝난 뒤에도 모듈이 평가될 수 있으므로 **바로 지우지 않고**
// 프로세스가 끝날 때 한꺼번에 치운다.
const probeDirs = [];
const cleanProbeDirs = () => {
  while (probeDirs.length) {
    try { rmSync(probeDirs.pop(), { recursive: true, force: true }); } catch { /* 지우기 실패는 판정에 영향 없다 */ }
  }
};
process.on('exit', cleanProbeDirs);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanProbeDirs(); process.exit(130); });
}

const loadModule = async (entry, what) => {
  const files = collect(entry);
  const dir = mkdtempSync(join(tmpdir(), 'traigo-100x-'));
  probeDirs.push(dir);
  for (const [f, src] of files) {
    if (src == null) { err(`${what}: ${f}을(를) 읽지 못했습니다`); return null; }
    const dest = join(dir, f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, src);
  }
  const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) { err(`TypeScript가 없습니다 (${tsc}). 먼저 npm ci`); return null; }
  try {
    // `@/`를 `src/`로 풀어 준다 — 위 수집기가 그 파일들을 이미 복사해 뒀다.
    writeFileSync(join(dir, 'tsconfig.probe.json'), JSON.stringify({
      compilerOptions: {
        module: 'commonjs', target: 'es2019', skipLibCheck: true,
        baseUrl: '.', paths: { '@/*': ['src/*'] },
      },
      files: [entry],
    }));
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.probe.json'],
      { cwd: dir, stdio: 'pipe', timeout: 180_000 });
  } catch (e) {
    err(`${what}: 컴파일되지 않습니다\n${String(e.stdout || e.message).trim().slice(0, 400)}`);
    return null;
  }
  return import(`file://${join(dir, entry.replace(/\.tsx?$/, '.js'))}`);
};

const plan = await loadModule(PLAN, '실행 계약 정본');
const profilesMod = await loadModule(PROFILES_TS, '프로필 정본');
const presetMod = await loadModule('src/lib/strategies/profilePreset.ts', '프리셋 표');

if (plan) {
  // ── 정체 ──
  const r = plan.resolveExecutionProfile(ID, PRESET, plan.EXECUTION_CONTRACT_VERSION);
  if (!r?.ok || r.kind !== 'contract') {
    err(`${ID}/${PRESET} 계약이 해석되지 않습니다`
      + ` (${r?.code || '사유 미상'}) — 전용 100배가 자기 프리셋에서 막혀 있습니다`);
  } else {
    const c = r.contract;
    if (c.leverage !== 100) err(`${ID}의 요청 배율이 ${c.leverage}입니다 — 정확히 100이어야 합니다`);
    if (c.maxLeverage !== 100) {
      err(`${ID}의 상한이 ${c.maxLeverage}입니다 — 요청값과 달라지면 "정확히 100"이 아닙니다`);
    }
    if (c.stopPolicy !== 'NO_FIXED_SL') err(`${ID}의 stopPolicy가 ${c.stopPolicy}입니다`);
    if (c.sizingPolicy !== 'MARGIN_ALLOCATION') {
      err(`${ID}의 sizingPolicy가 ${c.sizingPolicy}입니다`
        + ' — 손절이 없으면 손절 거리로 크기를 만들 수 없습니다');
    }
    if (c.takeProfitPolicy !== 'NO_FIXED_TP') {
      err(`${ID}의 takeProfitPolicy가 ${c.takeProfitPolicy}입니다`);
    }
    if (c.takeProfitPct !== null) {
      err(`${ID}에 익절 숫자가 남아 있습니다 (${c.takeProfitPct})`
        + ' — 이 프로필을 위해 고른 적 없는 값이 실제 익절 주문이 됩니다');
    }
    if (c.stopLossPct !== null) {
      err(`${ID}에 손절 숫자가 남아 있습니다 (${c.stopLossPct}) — 걸지도 않을 값이 사이징의 분모나`
        + ' 복구 경로의 손절가로 되살아납니다');
    }
    // 마진 모드는 **사용자가 확정한 정책**이다(ISOLATED 전용). 이 검사기가
    // 임의로 만든 규칙이 아니라, 확정된 계약을 지키는 것이다.
    if (!Array.isArray(c.marginModes) || c.marginModes.join(',') !== 'isolated') {
      err(`${ID}의 마진 모드가 isolated 전용이 아닙니다 (${JSON.stringify(c.marginModes)})`);
    }
  }

  // ── 조합 제한: 양방향 ──
  //
  // 한쪽만 막으면 반대가 샌다. `SCALP + EXACT_100X`가 통과하면 "전용
  // 100배 프리셋인데 25배"가 저장된다.
  for (const sid of ['STABILIZE', 'RESEARCH']) {
    const rr = plan.resolveExecutionProfile(ID, sid, plan.EXECUTION_CONTRACT_VERSION);
    if (rr?.ok) {
      err(`${ID}/${sid}가 해석됩니다 — 전용 100배는 ${PRESET}과만 짝이어야 합니다`
        + ' (안정화를 골랐는데 100배가 나가는 상태입니다)');
    }
  }
  for (const pid of ['SCALP_HIGH_LEV', 'SWING_LOW_LEV', 'DAILY_HIGH_LEV']) {
    const rr = plan.resolveExecutionProfile(pid, PRESET, plan.EXECUTION_CONTRACT_VERSION);
    if (rr?.ok) err(`${pid}/${PRESET}이 해석됩니다 — 전용 프리셋이 다른 프로필에 붙었습니다`);
    // 기존 조합은 그대로 살아 있어야 한다.
    for (const sid of ['STABILIZE', 'RESEARCH']) {
      const keep = plan.resolveExecutionProfile(pid, sid, plan.EXECUTION_CONTRACT_VERSION);
      if (!keep?.ok || keep.kind !== 'contract') {
        err(`${pid}/${sid}가 막혔습니다 — 기존 조합의 동작이 바뀌었습니다`);
        continue;
      }
      if (keep.contract.takeProfitPolicy !== 'FIXED_TP' || !(Number(keep.contract.takeProfitPct) > 0)) {
        err(`${pid}/${sid}의 익절이 꺼졌습니다 — 기존 전략의 의미가 바뀌었습니다`);
      }
      if (keep.contract.stopPolicy !== 'FIXED_SL' || keep.contract.sizingPolicy !== 'STOP_RISK') {
        err(`${pid}/${sid}의 실행 의미가 바뀌었습니다`
          + ` (${keep.contract.stopPolicy}/${keep.contract.sizingPolicy})`);
      }
    }
  }

  // ── 정본 리터럴과 합쳐진 계약이 갈리지 않는가 ──
  //
  // 계약은 `applyPreset`이 얹은 결과라, 프로필 리터럴의 배율을 99로 바꿔도
  // 프리셋 override가 100으로 덮어써서 계약은 그대로다. 그러면 **표에 적힌
  // 숫자와 실행되는 숫자가 다른 상태**가 조용히 생긴다.
  const raw = profilesMod?.PROFILES?.[ID];
  if (!raw) err(`${PROFILES_TS}: ${ID} 프로필 정본이 없습니다`);
  else {
    if (raw.leverage !== 100 || raw.maxLeverage !== 100) {
      err(`${PROFILES_TS}: ${ID} 리터럴의 배율이 ${raw.leverage}/${raw.maxLeverage}입니다`
        + ' — 프리셋이 덮어써서 계약은 100이지만, 표에 적힌 숫자가 실행과 다릅니다');
    }
    if (raw.stopLossPct !== null || raw.stopPolicy !== 'NO_FIXED_SL'
        || raw.sizingPolicy !== 'MARGIN_ALLOCATION') {
      err(`${PROFILES_TS}: ${ID} 리터럴의 정책이 계약과 다릅니다`);
    }
    if (raw.marginAllocationPct !== undefined) {
      err(`${PROFILES_TS}: 배정 비율이 프로필 상수로 남아 있습니다`
        + ' — 예약이 값을 바꿔도 계약은 옛 값을 가리키게 됩니다');
    }
  }

  // ── 계약이 없으면 100X 실행 의미를 만들 수 없다 ──
  if (typeof plan.stopPolicyOfContract !== 'function'
      || plan.stopPolicyOfContract(null) !== 'FIXED_SL'
      || plan.stopPolicyOfContract(undefined) !== 'FIXED_SL') {
    err('계약이 없을 때 기본 손절 정책이 FIXED_SL이 아닙니다'
      + ' — 이 한 글자가 모든 기존 전략의 손절을 끕니다');
  }
  if (typeof plan.sizingPolicyOfContract !== 'function'
      || plan.sizingPolicyOfContract(null) !== 'STOP_RISK'
      || plan.sizingPolicyOfContract(undefined) !== 'STOP_RISK') {
    err('계약이 없을 때 기본 사이징이 STOP_RISK가 아닙니다'
      + ' — 기존 전략이 손절 거리 기반 사이징을 잃습니다');
  }

  // ── 전용 프리셋이 **자기 행**으로 해석되는가 ──
  //
  // `presetOf`가 모르는 값을 기본 프리셋으로 눕힌다. `EXACT_100X`가 거기서
  // 빠지면 `applyPreset`이 **안정화 행**을 얹는다. 지금은 그 행이 비어 있어
  // 프로필 리터럴(100)이 그대로 남아 결과가 같지만, 그건 우연이다 —
  // 전용 프리셋 표에 다른 값이 들어오는 순간 계약이 조용히 달라진다.
  if (presetMod) {
    const own = presetMod.overrideOf?.(ID, PRESET);
    const table = presetMod.PRESET_TABLE?.[PRESET]?.[ID];
    if (!own || !table || own.maxLeverage !== table.maxLeverage || own.leverage !== table.leverage) {
      err(`${PRESET} 프리셋이 자기 행으로 해석되지 않습니다`
        + ` (얹힌 값 ${JSON.stringify(own)} / 표의 값 ${JSON.stringify(table)})`
        + ' — presetOf가 기본 프리셋으로 눕히고 있습니다');
    }
    if (presetMod.presetOf?.(PRESET) !== PRESET) {
      err(`presetOf('${PRESET}')가 ${presetMod.presetOf?.(PRESET)}를 돌려줍니다`);
    }
  }

  // ── 계약 칸 ──
  for (const f of ['stopPolicy', 'sizingPolicy', 'takeProfitPolicy']) {
    if (!plan.CONTRACT_FIELDS?.includes(f)) {
      err(`CONTRACT_FIELDS에 ${f}가 없습니다 — 지문이 이 값의 변경을 못 잡습니다`);
    }
  }
  if (plan.CONTRACT_FIELDS?.includes('marginAllocationPct')) {
    err('CONTRACT_FIELDS에 marginAllocationPct가 있습니다'
      + ' — 배정 비율은 예약 값이라 계약에 넣으면 사용자가 바꿔도 계약이 옛 값을 가리킵니다');
  }
}

// ── 사이징: 정본을 불러 실제로 판정시킨다 ──
const sizing = await loadModule(SIZING, '100X 사이징');
if (sizing) {
  const base = {
    requiredLeverage: 100,
    availableUsd: 1000, marginAllocationPct: 10, referencePrice: 50_000,
  };
  // **막았는지만 보면 부족하다.** 검사를 통째로 지워도 뒤쪽 검사가
  // 우연히 막아 주는 경우가 있고(예: 잔고 null → Number(null)=0 → "잔고
  // 없음"), 그때 사용자는 "조회 실패"를 "잔고 0"으로 읽는다. 그 둘은
  // 대응이 완전히 다르다 — 이 저장소가 UNKNOWN을 0으로 적지 않는 이유다.
  // 그래서 **어떤 이유로 막았는지**까지 고정한다.
  const must = (input, wantCode, why) => {
    const v = sizing.planSize100x({ ...base, ...input });
    if (v.ok) { err(`100X 사이징: ${why} — 그런데 통과했습니다 (수량 ${v.quantity})`); return; }
    if (v.code !== wantCode) {
      err(`100X 사이징: ${why} — 막긴 했지만 이유가 ${v.code}입니다 (${wantCode}이어야 합니다).`
        + ' 다른 검사가 우연히 막아 준 것이라, 사용자에게 잘못된 원인이 보입니다');
    }
  };
  // 정확 배율 판정은 크기 계산에서 떼어냈다 — 후보 수량을 **쓰기 전에**
  // 계산하려면 되읽은 값에 묶여 있으면 안 되기 때문이다. 막는 힘은
  // 그대로여야 하므로 옮겨간 자리에서 그대로 확인한다.
  for (const [label, observed] of [['99배', 99], ['75배', 75], ['모름', null]]) {
    const bad = sizing.verifyLeverageExact(100, observed);
    if (!bad) err(`100X 배율 확인: 되읽은 값이 ${label}인데 통과했습니다`);
    else if (bad.code !== 'LEVERAGE_NOT_EXACT') {
      err(`100X 배율 확인: ${label}을 막았지만 이유가 ${bad.code}입니다`);
    }
  }
  if (sizing.verifyLeverageExact(100, 100) !== null) {
    err('100X 배율 확인: 정확히 요구 배율인데 막았습니다');
  }
  must({ availableUsd: null }, 'BALANCE_UNKNOWN', '잔고를 못 읽었으면 막아야 합니다');
  must({ availableUsd: 0 }, 'BALANCE_EMPTY', '잔고가 0이면 그 사실로 막아야 합니다');
  must({ marginAllocationPct: null }, 'MARGIN_ALLOCATION_UNSET', '증거금 배정이 미지정이면 막아야 합니다');
  must({ referencePrice: null }, 'PRICE_UNKNOWN', '기준가를 못 읽었으면 막아야 합니다');
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
  if (v.code !== 'NO_FIXED_SL' || !v.note) {
    err(`손절 재부착: 정책으로 막았다는 사실이 기록에 안 남습니다 (code=${v.code}, note=${JSON.stringify(v.note)})`);
  }
  // **손절가가 비어 있을 때도 이유는 정책이어야 한다.** 값 검사가 정책보다
  // 앞에 오면 여기서 NO_PLANNED_STOP이 나오고, "일부러 안 걸었다"가
  // "걸 값이 없었다"로 기록된다 — 100배 포지션에서 그 차이는 크다.
  const v2 = reattach.stopReattachVerdict({ stop_policy: 'NO_FIXED_SL' });
  if (v2.code !== 'NO_FIXED_SL') {
    err(`손절 재부착: 정책 판정이 값 검사보다 뒤입니다 (code=${v2.code}) — 순서가 규칙의 일부입니다`);
  }
  const legacy = reattach.stopReattachVerdict({ stop_loss: 49_000 });
  if (!legacy.attach) err('기존 주문의 손절 복구가 막혔습니다 — 보호 없는 포지션이 남습니다');
}

// ── 켜기 게이트 ──
const gate = await loadModule(GATE, '켜기 게이트');
if (gate) {
  const open = gate.OPEN_COMBOS || [];
  // **전략이 조합에 있어야 한다.** 100X 계약을 실제로 해석하는 라우트는
  // scalp 하나다. 전략을 빼면 daily-ladder 예약에 100X를 저장하고 켤 수
  // 있게 되는데, 그 라우트는 계약을 읽지 않고 자기 방식으로 돈다 —
  // 저장된 것과 도는 것이 달라진다.
  for (const c of open) {
    const wired = code(`src/app/api/autotrade/${c.strategyId}/route.ts`);
    if (!wired) {
      err(`열린 조합의 전략 ${c.strategyId}에 해당하는 라우트를 찾지 못했습니다`);
      continue;
    }
    if (!/resolveExecutionProfile/.test(wired) || !/prepareEntry100x/.test(wired)) {
      err(`${c.strategyId} 라우트가 실행 계약을 해석하지 않는데 조합이 열려 있습니다`
        + ' — 저장된 것은 100X인데 도는 것은 그 전략입니다');
    }
  }
  if (open.length !== 1 || open[0].strategyId !== 'scalp'
      || open[0].profileId !== ID || open[0].presetId !== PRESET) {
    err(`열린 조합이 ${JSON.stringify(open.map(c => `${c.profileId}/${c.presetId}`))}입니다`
      + ` — 지금 검증된 조합은 ${ID}/${PRESET} 하나뿐입니다`);
  } else {
    if (open[0].modes.includes('LIVE')) {
      err('LIVE가 열려 있습니다 — 고정 손절을 대신할 자동 종료 권한이 배선됐다는 증거가'
        + ' 먼저 있어야 합니다 (dormantGate 머리말). 임의의 exit 문턱을 만들어 통과시키지 마세요');
    }
    if (open[0].modes.join(',') !== 'TESTNET') {
      err(`열린 모드가 ${open[0].modes.join(',')}입니다 — 지금은 TESTNET 하나여야 합니다`);
    }
    if (open[0].requiresMarginAllocation !== true) {
      err('배정 비율 없이도 켤 수 있게 돼 있습니다'
        + ' — 손절이 없으면 크기를 정할 근거가 그 값 하나뿐입니다');
    }
  }

  const okRow = {
    strategyId: 'scalp', profileId: ID, presetId: PRESET, contractVersion: 2,
    mode: 'TESTNET', marginAllocationPct: 10,
  };
  const mustBlock = (over, why) => {
    const v = gate.executionGateVerdict({ ...okRow, ...over });
    if (v.allowed) err(`켜기 게이트: ${why} — 그런데 켜집니다`);
  };
  if (!gate.executionGateVerdict(okRow).allowed) {
    err(`켜기 게이트: 검증된 조합이 막힙니다 — ${gate.executionGateVerdict(okRow).reason}`);
  }
  mustBlock({ strategyId: 'daily-ladder' }, '계약을 해석하지 않는 전략은 막아야 합니다');
  mustBlock({ strategyId: 'my-original-v1' }, '계약을 해석하지 않는 전략은 막아야 합니다');
  mustBlock({ strategyId: '' }, '전략이 비면 막아야 합니다');
  mustBlock({ mode: 'LIVE' }, 'LIVE는 막아야 합니다');
  mustBlock({ mode: 'LIVE_LIMITED' }, 'LIVE_LIMITED는 막아야 합니다');
  mustBlock({ marginAllocationPct: null }, '배정 비율이 없으면 막아야 합니다');
  mustBlock({ marginAllocationPct: 0 }, '배정 비율 0은 막아야 합니다');
  mustBlock({ presetId: 'STABILIZE' }, '다른 프리셋은 막아야 합니다');
  mustBlock({ contractVersion: 1 }, '다른 계약 버전은 막아야 합니다');
  mustBlock({ profileId: 'DAILY_HIGH_LEV', presetId: 'STABILIZE' }, '기존 프로필은 막아야 합니다');
  mustBlock({ profileId: 'WHATEVER_UNKNOWN' }, '모르는 프로필은 막아야 합니다');
  if (gate.executionGateVerdict({ profileId: null }).allowed !== true) {
    err('프로필이 없는 기존 예약이 막힙니다 — 기존 동작이 바뀌었습니다');
  }

  // 켜기 조건이 **표를 실제로 읽는가.** 안 읽으면 나중에 조합을 넓혀도
  // L3가 계속 막는데 아무도 모른다.
  const spec = gate.enableFilterSpec();
  if (spec.kind !== 'or') {
    err('켜기(L3) 조건이 열린 조합을 읽지 않습니다 — 실행기만 열리고 사용자는 못 켭니다');
  } else {
    for (const need of [
      'execution_profile_id.is.null', 'strategy_id.eq.scalp', `execution_profile_id.eq.${ID}`,
      `execution_preset_id.eq.${PRESET}`, 'execution_contract_version.eq.2',
      'mode.eq.TESTNET', 'margin_allocation_pct.not.is.null',
    ]) {
      if (!String(spec.expr).includes(need)) err(`켜기 조건에 ${need}가 없습니다`);
    }
    if (String(spec.expr).includes('mode.eq.LIVE')) err('켜기 조건에 LIVE가 들어갔습니다');
  }
  if (gate.enableFilterSpec([]).kind !== 'isNull') {
    err('열린 조합이 없는데 켜기 조건이 넓어졌습니다');
  }

  // ── 표를 넓히는 것만으로 실자금이 열리지 않는가 ──
  //
  //   위 `mustBlock`은 **정본 표**를 쓴다. 그래서 표의 `modes`에 한 줄
  //   더하는 변경을 전혀 보지 못한다 — 그 변경 하나로 실계좌가 열렸다.
  //   검사기가 그것을 잡더라도 검사기는 돌려야 의미가 있다.
  //
  //   그래서 **실자금 모드를 전부 열어 둔 표를 직접 넘겨서** 그래도
  //   막히는지 본다. 막는 근거가 표가 아니라 계약(고정 손절 없음)이어야
  //   이 검사가 통과한다.
  //
  //   ★ 글자로 막으면 샌다: `'LIVE'`라는 모드는 **존재하지 않는다**
  //     (사다리는 UI_DEMO·PAPER·TESTNET·SHADOW_LIVE·LIVE_SMALL·LIVE_LIMITED).
  //     `mode === 'LIVE'`로 막았다면 LIVE_SMALL·LIVE_LIMITED가 그대로
  //     통과했을 것이다.
  {
    const wide = [{
      strategyId: 'scalp', profileId: ID, presetId: PRESET, contractVersion: 2,
      modes: ['TESTNET', 'SHADOW_LIVE', 'LIVE_SMALL', 'LIVE_LIMITED'],
      requiresMarginAllocation: true,
    }];
    for (const mode of ['LIVE_SMALL', 'LIVE_LIMITED']) {
      const v = gate.executionGateVerdict({ ...okRow, mode }, wide);
      if (v.allowed) {
        err(`켜기 게이트: 표에 ${mode}를 적는 것만으로 실자금이 열립니다`
          + ' — 막는 근거가 계약(고정 손절 없음)이 아니라 표입니다');
      } else if (!/고정 손절/.test(String(v.reason))) {
        err(`켜기 게이트: ${mode}가 막히기는 하는데 사유가 계약을 가리키지 않습니다`
          + ` (${String(v.reason).slice(0, 80)}) — 표를 넓히면 사라질 방어입니다`);
      }
    }
    // **TESTNET 검증을 막아서 통과시키는 것이 아니다.** 지금 돌고 있는
    // 조합은 그대로 켜져야 한다.
    if (!gate.executionGateVerdict({ ...okRow, mode: 'TESTNET' }, wide).allowed) {
      err('켜기 게이트: TESTNET 검증이 막혔습니다 — 기존 동작을 바꿨습니다');
    }
    // 주문을 보내지 않는 모드까지 막으면 LIVE 승급에 필요한 관찰을 못 한다.
    if (!gate.executionGateVerdict({ ...okRow, mode: 'SHADOW_LIVE' }, wide).allowed) {
      err('켜기 게이트: SHADOW_LIVE가 막혔습니다'
        + ' — 주문이 나가지 않는 모드입니다(닫을 것이 없습니다)');
    }
  }

  // 모드를 **글자로** 비교하지 않는가. 사다리 정본에 물어야 모드를 하나
  // 더 만들어도 조건이 자동으로 따라온다.
  {
    const src = code(GATE);
    if (!/capability\s*\(/.test(src) || !/parseMode\s*\(/.test(src)) {
      err(`${GATE}: 실자금 판정을 모드 사다리 정본(capability·parseMode)에 묻지 않습니다`);
    }
    if (/mode\s*===\s*['"]LIVE['"]/.test(src)) {
      err(`${GATE}: 모드를 'LIVE' 글자와 비교합니다`
        + " — 그런 모드는 없습니다. LIVE_SMALL·LIVE_LIMITED가 그대로 통과합니다");
    }
    if (!/stopPolicy\s*===\s*['"]NO_FIXED_SL['"]/.test(src)) {
      err(`${GATE}: 실자금 차단이 계약의 stopPolicy를 보지 않습니다`);
    }
  }
}

// ── 청산 감시 커버리지가 계약 단위로 참말을 하는가 ──
//
//   `exitCoverage`는 전략 단위 표였다. 그래서 `scalp` 한 줄이
//   `lifecyclePolicyOf('scalp')`를 근거로 트레일링·본전이동·시간청산을 전부
//   true로 적었고, 같은 전략의 `NO_FIXED_SL` 계약 포지션에는 그 중 **하나도
//   돌지 않는데도** 응답은 초록이었다(자리 전체가 유예된다). 이 파일
//   머리말의 "여기에 희망을 적지 않는다"를 어기고 있었다.
{
  const cov = await loadModule(COVERAGE, '청산 감시 커버리지');
  if (cov) {
    const rows = cov.exitCoverage();
    const contractRows = rows.filter(r => r.contract != null);
    const noFixed = contractRows.filter(r => r.stopPolicy === 'NO_FIXED_SL');
    if (noFixed.length === 0) {
      err(`${COVERAGE}: 열려 있는 NO_FIXED_SL 계약 줄이 표에 없습니다`
        + ' — 그 계약의 포지션이 무슨 감시를 받는지 아무도 적지 않습니다');
    }
    for (const r of noFixed) {
      // ── 계약상 **안 하는 것**은 여전히 false여야 한다 ──
      //
      //   ⑤가 시간 청산 하나를 열었다고 해서 나머지가 같이 열리면 안 된다.
      //   그 셋은 1R(고정 손절)을 요구하므로 이 계약에는 정의 자체가 없다.
      for (const [k, what] of [
        ['trailing', '트레일링'], ['breakEven', '본전이동'],
        ['protectiveOrdersAtEntry', '진입 보호주문'],
      ]) {
        if (r[k] !== false) {
          err(`${COVERAGE}: ${r.strategyId}/${r.contract.presetId}의 ${what}을 ${r[k]}로 적습니다`
            + ' — 이 계약에는 1R이 없어 정의할 수 없습니다 (시간 청산과 함께 열리면 안 됩니다)');
        }
      }

      // ── 시간 청산은 **분류기와 같아야 한다** ──
      //
      //   원래 규칙은 `timeExit === false`를 못박았다. 그 이유는 "자리
      //   유예로 돌지 않는데 돈다고 적으면 거짓말"이었다. ⑤에서 전용 종료
      //   권한이 붙어 실제로 돌기 시작했으므로 그 숫자는 더 이상 사실이
      //   아니다. 지켜야 할 성질은 "false다"가 아니라 **"표와 코드가
      //   같다"**였다. 그래서 상수 대신 분류기에게 묻는다.
      const auth = typeof cov.authorityCapabilitiesOf === 'function'
        ? cov.authorityCapabilitiesOf(r.stopPolicy, {
            profileId: r.contract.profileId, presetId: r.contract.presetId,
            contractVersion: r.contract.contractVersion })
        : null;
      if (!auth) {
        err(`${COVERAGE}: authorityCapabilitiesOf가 없습니다`
          + ' — 표가 무엇을 근거로 시간 청산을 적는지 확인할 수 없습니다');
      } else {
        if (r.timeExit !== auth.capabilities.timeExit) {
          err(`${COVERAGE}: 표의 시간청산(${r.timeExit})이 분류기(${auth.capabilities.timeExit})와`
            + ' 다릅니다 — 표에 손으로 적었습니다');
        }
        // ★ **값이 같은 것으로는 부족하다.**
        //
        //   분류기도 `true`이므로 표에 `true`를 손으로 적어도 값은 같다.
        //   그러면 "분류기에서 derive한다"는 계약이 깨졌는데 검사는
        //   통과한다(실제로 그 변이가 새 나갔다). 값이 아니라 **어디서
        //   왔는가**를 본다.
        const csrc = code(COVERAGE);
        const iRows = csrc.indexOf('function contractRows(');
        const rowsBody = iRows < 0 ? '' : csrc.slice(iRows, csrc.indexOf('\n}', iRows));
        if (iRows < 0) {
          err(`${COVERAGE}: contractRows를 찾지 못했습니다 — 표가 무엇을 적는지 확인할 수 없습니다`);
        }
        for (const [field, want] of [
          ['timeExit', 'auth.capabilities.timeExit'],
          ['trailing', 'auth.capabilities.trailing'],
          ['breakEven', 'auth.capabilities.breakEven'],
          ['protectiveOrdersAtEntry', 'auth.capabilities.fixedStopAtEntry'],
        ]) {
          if (!rowsBody.includes(`${field}: ${want}`)) {
            err(`${COVERAGE}: 계약 줄의 ${field}를 분류기에서 가져오지 않습니다`
              + ` (${want}가 아닙니다) — 표에 손으로 적으면 배선을 끊어도 초록으로 남습니다`);
          }
        }
        if (/\b(timeExit|trailing|breakEven|protectiveOrdersAtEntry):\s*(true|false)\b/.test(rowsBody)) {
          err(`${COVERAGE}: 계약 줄에 감시 깃발을 상수로 적었습니다`
            + ' — 분류기가 바뀌어도 표가 따라가지 않습니다');
        }
        for (const k of ['trailing', 'breakEven', 'emergency']) {
          if (auth.capabilities[k] !== false) {
            err(`${COVERAGE}: 분류기가 ${k}를 열어 두었습니다`
              + ' — 이번 단계에서 열린 것은 시간 청산 하나뿐입니다');
          }
        }
      }

      // ── 배선이 **실제로** 있는가 ──
      //
      //   표가 `timeExit: true`라고 적으려면 라우트가 전용 권한을 실제로
      //   돌려야 한다. 표만 보고 믿지 않는다 — 배선을 끊는 변이에서 이
      //   검사가 빨간불이 되어야 한다.
      if (r.timeExit === true) {
        // `MONITOR` 상수는 이 블록보다 뒤에 선언된다 — 경로를 여기서 쓴다.
        const monPath = 'src/app/api/autotrade/exit-monitor/route.ts';
        const mon2 = code(monPath);
        if (!/runExitAuthority\(/.test(mon2)) {
          err(`${COVERAGE}: 시간청산을 true로 적는데 ${monPath}가 전용 종료 권한을 부르지 않습니다`
            + ' — 만들어 놓고 배선하지 않은 상태입니다');
        }
        if (!/authorityCandidates/.test(mon2)) {
          err(`${COVERAGE}: 시간청산을 true로 적는데 ${monPath}가 전용 권한 후보를 받지 않습니다`);
        }
      }

      if (r.gap == null) {
        err(`${COVERAGE}: ${r.strategyId}/${r.contract.presetId}에 빈 칸이 있는데 이유가 없습니다`);
      } else {
        const gap = String(r.gap);
        // **하나가 열렸다고 "종료가 된다"로 적지 않는다.** 없는 것은
        // 그대로 없다고 적어야 운영자가 무엇을 못 믿는지 안다.
        const okGap = r.timeExit
          ? /시간 청산만/.test(gap) && /아직 없습니다/.test(gap)
          : /사람이 직접 닫는/.test(gap);
        if (!okGap) {
          err(`${COVERAGE}: 아직 없는 종료 수단을 사유에 적지 않습니다`
            + ' — 운영자가 무엇이 없는지 알 수 없습니다');
        }
      }
    }
    // 기본 예약 줄의 커버리지는 **건드리지 않는다.**
    const base = rows.filter(r => r.contract == null);
    if (base.length < 3) err(`${COVERAGE}: 기본 예약 줄이 ${base.length}개입니다 — 줄이 사라졌습니다`);
    for (const b of base) {
      if (b.stopPolicy != null) {
        err(`${COVERAGE}: 기본 예약 줄의 stopPolicy를 ${b.stopPolicy}로 적습니다`
          + ' — 장부 칸이 비어 있는 옛 줄을 "정하기로 한 줄"로 바꿔 읽습니다');
      }
    }
    // 요약 줄이 **계약 단위**로 세는가. 전략 수로 세면 같은 전략의 다른
    // 계약이 숨는다.
    const line = String(cov.exitCoverageLine());
    if (!/실행 계약/.test(line)) {
      err(`${COVERAGE}: 요약 줄이 아직 전략 수로 셉니다 (${line.slice(0, 60)})`);
    }
    if (/전부 청산 감시 대상/.test(line)) {
      err(`${COVERAGE}: 돌지 않는 계약이 있는데 "전부 감시 대상"이라고 적습니다`);
    }
    // 유예 판정을 **표가 다시 적지 않는가.** 분류기에게 물어야 한다 —
    // 두 벌이 되면 언젠가 한쪽만 고쳐진다.
    const src = code(COVERAGE);
    if (!/managedCandidates/.test(src)) {
      err(`${COVERAGE}: 유예 판정을 분류기(managedCandidates)에게 묻지 않습니다`
        + ' — 표에 규칙을 다시 적으면 managedPosition과 갈립니다');
    }
    // **이름이 있는지로는 부족하다.** `import { OPEN_COMBOS }` 한 줄만
    // 남겨 두고 손으로 적은 목록을 돌려도 이름 검사는 통과한다 — 실제로
    // 그 변이가 새 나갔다. 그래서 **표를 주입해서 따라오는지** 본다.
    if (!/of\s+open\b/.test(src)) {
      err(`${COVERAGE}: 계약 줄을 주어진 조합 목록으로 만들지 않습니다`
        + ' — 손으로 적은 목록이면 조합을 하나 더 열어도 표가 빠뜨립니다');
    }
    {
      // 정본과 **다른 전략**의 조합을 넘긴다. 표가 주입을 무시하고 손으로
      // 적은 목록(scalp)을 쓰면 strategyId가 달라서 바로 드러난다.
      const injected = [{
        strategyId: 'my-original-v1', profileId: ID, presetId: PRESET,
        contractVersion: 2, modes: ['TESTNET'], requiresMarginAllocation: true,
      }];
      const got = cov.exitCoverage(injected).filter(r => r.contract != null);
      if (got.length !== 1) {
        err(`${COVERAGE}: 조합 하나를 주입했는데 계약 줄이 ${got.length}개입니다`
          + ' — 표가 주어진 조합 목록을 읽지 않습니다');
      } else if (got[0].strategyId !== 'my-original-v1') {
        err(`${COVERAGE}: 주입한 조합의 전략은 my-original-v1인데 표는`
          + ` ${got[0].strategyId}을(를) 적습니다 — 목록을 손으로 적어 두었습니다`);
      }
      // 빈 표를 주면 계약 줄도 없어야 한다. 그래도 줄이 나오면 어딘가에
      // 조합이 박혀 있다는 뜻이다.
      if (cov.exitCoverage([]).some(r => r.contract != null)) {
        err(`${COVERAGE}: 열린 조합이 없는데도 계약 줄이 나옵니다`);
      }
    }
    // 탐침이 분류되지 않을 때 **통과로 적지 않는가.**
    if (!/UNCLASSIFIED/.test(src)) {
      err(`${COVERAGE}: 분류되지 않은 계약을 다루는 자리가 없습니다`
        + ' — 모르는 것을 감시 중으로 적으면 UNKNOWN을 0으로 적는 것입니다');
    }
  }
}

// ── 진입 계획 (가짜 어댑터로 실제 판정시킨다) ──
const entry = await loadModule(ENTRY, '100X 진입 계획');
if (entry) {
  const okDeps = (over = {}) => ({
    observeMarginMode: async () => 'isolated',
    applyLeverage: async (lev) => ({ ok: true, observed: lev, message: '' }),
    availableUsd: async () => 1000,
    referenceMark: async () => ({
      price: 50_000, exchangeTimeMs: Date.now() - 100, observedAtMs: Date.now(),
      source: 'EXCHANGE_PREMIUM_INDEX', cache: 'FRESH',
    }),
    quantize: async (q) => ({ qty: q, message: '' }),
    // 거래소 브래킷 첫 구간(소액): MMR 0.4% · 공제액 0.
    maintenanceTiers: async () => ({
      tiers: [[50_000_000, 0.004, 0]], observedAtMs: Date.now(), freshness: 'FRESH',
    }),
    // **손절이 아니다** — 신호가 ATR로 잰 변동성 위험 거리(%)다.
    adverseDistancePct: async () => 0.3,
    commissionRates: async () => ({
      takerRate: 0.0004, makerRate: 0.0002,
      source: 'EXCHANGE_ACCOUNT', observedAtMs: Date.now(),
    }),
    orderBookDepth: async () => ({
      bids: [[49_995, 50]], asks: [[50_005, 50]],
      source: 'EXCHANGE_DEPTH', observedAtMs: Date.now(), exchangeTimeMs: Date.now() - 100,
    }),
    fundingContext: async () => ({
      rate: 0.0001, nextFundingTimeMs: Date.now() + 3_600_000, intervalHours: 8,
      capRate: 0.0005, floorRate: -0.0005,
      source: 'EXCHANGE_FUNDING_INFO',
      premiumObservedAtMs: Date.now(), premiumExchangeTimeMs: Date.now() - 100,
      premiumCache: 'FRESH', fundingBoundsObservedAtMs: Date.now(),
    }),
    ...over,
  });
  const C = {
    leverage: 100, sizingPolicy: 'MARGIN_ALLOCATION', marginModes: ['isolated'],
    side: 'LONG',
    // 시장가 주문이므로 taker다.
    fillKind: 'TAKER',
    maxHoldSec: 14_400,
  };
  // 두 단계를 이어 부르는 검사용 합성. 제품 경로는 그 사이에 쓰기 없는
  // 관문(1회 상한)을 하나 더 넣는다.
  /** 쓰기 전 관문이 허락한 상태 — 순서 검사에서는 이 조건을 고정한다. */
  const SEND = { disposition: 'SEND', reason: '' };
  const planEntry100x = async (c, pct, deps) =>
    entry.commitEntry100x(await entry.prepareEntry100x(c, pct, deps), deps, SEND);

  const mustBlock = async (over, wantCode, why) => {
    const v = await planEntry100x(C, 10, okDeps(over));
    if (v.ok) { err(`100X 진입: ${why} — 그런데 통과했습니다 (수량 ${v.quantity})`); return; }
    if (v.code !== wantCode) {
      err(`100X 진입: ${why} — 막긴 했지만 이유가 ${v.code}입니다 (${wantCode}이어야 합니다)`);
    }
  };
  const good = await planEntry100x(C, 10, okDeps());
  if (!good.ok) err(`100X 진입: 정상 입력이 막혔습니다 — ${good.message}`);

  await mustBlock({ observeMarginMode: async () => 'cross' },
    'MARGIN_MODE_NOT_ISOLATED', '거래소가 교차 마진이면 막아야 합니다');
  await mustBlock({ observeMarginMode: async () => null },
    'MARGIN_MODE_UNKNOWN', '마진 모드를 모르면 막아야 합니다');
  await mustBlock({ applyLeverage: async () => ({ ok: false, observed: 75, message: '거래소가 낮춤' }) },
    'LEVERAGE_NOT_EXACT', '되읽은 배율이 75배면 막아야 합니다');
  await mustBlock({ applyLeverage: async () => ({ ok: true, observed: 99, message: '' }) },
    'LEVERAGE_NOT_EXACT', '되읽은 배율이 99배면 막아야 합니다');
  await mustBlock({ applyLeverage: async () => ({ ok: true, observed: null, message: '' }) },
    'LEVERAGE_NOT_EXACT', '배율을 못 읽으면 막아야 합니다');
  await mustBlock({ availableUsd: async () => null },
    'SIZING_BLOCKED', '잔고를 못 읽으면 막아야 합니다');
  // 기준 마크가는 **관측**이라 ④가 막는다. "값이 없다"가 아니라
  // "언제의 값인지 모른다"가 사유다 — 그 값에는 다른 주인이 없다.
  await mustBlock({ referenceMark: async () => null },
    'MARKET_DATA_STALE', '기준 마크가를 못 읽으면 막아야 합니다');
  await mustBlock({ quantize: async () => ({ qty: null, message: '' }) },
    'QUANTIZE_FAILED', '거래소 규격에 못 맞추면 막아야 합니다');
  await mustBlock({ quantize: async () => ({ qty: 0.3, message: '' }) },
    'MARGIN_EXCEEDED', '올림해서 배정을 넘으면 막아야 합니다');

  // 배정 비율 미지정
  const noAlloc = await planEntry100x(C, null, okDeps());
  if (noAlloc.ok) err('100X 진입: 배정 비율이 없는데 통과했습니다');

  // **마진 모드 확인이 배율 설정보다 먼저인가.** 교차 계좌에 배율부터
  // 걸면, 막을 주문을 위해 계좌 설정을 먼저 바꾸는 것이 된다.
  let applied = false;
  await planEntry100x(C, 10, okDeps({
    observeMarginMode: async () => 'cross',
    applyLeverage: async (lev) => { applied = true; return { ok: true, observed: lev, message: '' }; },
  }));
  if (applied) err('100X 진입: 교차인 걸 알기 전에 배율을 걸었습니다 — 순서가 규칙의 일부입니다');

  // ── 순서를 이름으로 적어 직접 확인한다 ──
  //
  // 횟수만 세면 **자리**를 못 본다. 잔고를 읽기 전에 배율을 걸어도
  // 쓰기는 여전히 1번이다. 그래서 일어난 순서를 그대로 비교한다.
  {
    const loggedDeps = (over = {}) => {
      const log = [];
      const base = { ...okDeps(), ...over };
      const label = {
        observeMarginMode: ['marginMode:read'],
        availableUsd: ['balance:read'],
        referenceMark: ['mark:read'],
        quantize: ['quantize'],
        maintenanceTiers: ['bracket:read'],
        adverseDistancePct: ['adverse:read'],
        commissionRates: ['commission:read'],
        orderBookDepth: ['book:read'],
        fundingContext: ['funding:read'],
        applyLeverage: ['leverage:write', 'leverage:readback'],
      };
      const d = {};
      for (const k of Object.keys(base)) {
        const fn = base[k];
        d[k] = async (...a) => { for (const t of (label[k] || [k])) log.push(t); return fn(...a); };
      }
      return { d, log };
    };

    {
      const { d, log } = loggedDeps();
      const prep = await entry.prepareEntry100x(C, 10, d);
      if (!prep.ok) err(`100X 순서: 준비 단계가 막혔습니다 — ${prep.message}`);
      const afterPrep = log.join(' > ');
      // ★ 청산거리 입력을 **준비 단계 안에서** 읽는다. 이 두 칸이
      //   `leverage:write` 앞에 있다는 것이 진입 전 보호의 전부다.
      if (afterPrep !== 'marginMode:read > balance:read > mark:read > quantize'
                      + ' > bracket:read > adverse:read'
                      + ' > commission:read > book:read > funding:read') {
        err(`100X 순서: 준비 단계 호출 순서가 다릅니다 — ${afterPrep}`);
      }
      await entry.commitEntry100x(prep, d, SEND);
      const full = log.join(' > ');
      if (full !== 'marginMode:read > balance:read > mark:read > quantize'
                 + ' > bracket:read > adverse:read'
                 + ' > commission:read > book:read > funding:read'
                 + ' > leverage:write > leverage:readback') {
        err(`100X 순서: 전체 호출 순서가 계약과 다릅니다 — ${full}`);
      }
    }

    // 읽기 실패는 전부 쓰기 0.
    for (const [why, over] of [
      ['잔고를 못 읽음', { availableUsd: async () => null }],
      ['기준 마크가를 못 읽음', { referenceMark: async () => null }],
      ['규격에 못 맞춤', { quantize: async () => ({ qty: null, message: '' }) }],
      ['마진 모드가 교차', { observeMarginMode: async () => 'cross' }],
      ['마진 모드를 못 읽음', { observeMarginMode: async () => null }],
      ['배정 초과', { quantize: async (q) => ({ qty: q * 2, message: '' }) }],
    ]) {
      const { d, log } = loggedDeps(over);
      const prep = await entry.prepareEntry100x(C, 10, d);
      if (prep.ok) err(`100X 순서: ${why}인데 준비 단계가 통과했습니다`);
      if (log.includes('leverage:write')) {
        err(`100X 순서: ${why}으로 막힐 요청이 거래소에 배율을 걸었습니다 — ${log.join(' > ')}`);
      }
      // 호출부가 순서를 어겨도 막는가.
      await entry.commitEntry100x(prep, d, SEND);
      if (log.includes('leverage:write')) {
        err(`100X 순서: 막힌 계획으로 확정을 불렀더니 거래소에 썼습니다 (${why})`);
      }
    }
  }

  // ── 통합 호출 카운터 ──
  //
  // **"주문이 안 나갔다"로는 부족하다.** 세는 대상이 주문 하나면, 주문
  // 앞에서 계좌 설정을 바꾸는 호출은 세어지지 않는다. 그래서 읽기·쓰기·
  // 주문을 **따로** 센다.
  //
  // 배율 설정 하나만 세지 않는 것도 같은 이유다. 나중에 마진 모드 setter
  // 같은 쓰기가 붙어도, 분류 목록(MUTATING_DEPS)에 올라가는 순간 여기서
  // 함께 세어진다.
  {
    const mutating = new Set(entry.MUTATING_DEPS || []);
    const readonly = new Set(entry.READONLY_DEPS || []);
    const countingDeps = (over = {}) => {
      const c = { exchangeReads: 0, exchangeWrites: 0, orderSubmits: 0 };
      const base = okDeps(over);
      const wrapped = {};
      for (const k of Object.keys(base)) {
        const fn = base[k];
        wrapped[k] = async (...a) => {
          if (mutating.has(k)) c.exchangeWrites++;
          else if (readonly.has(k)) c.exchangeReads++;
          else throw new Error(`분류되지 않은 의존 ${k} — 카운터 밖으로 샙니다`);
          return fn(...a);
        };
      }
      return { deps: wrapped, c };
    };

    // 교차 마진이면 **쓰기 0**이어야 한다. 읽기는 있어야 한다 —
    // 읽지도 않고 막았다면 그건 판정이 아니라 우연이다.
    {
      const { deps, c } = countingDeps({ observeMarginMode: async () => 'cross' });
      const v = await planEntry100x(C, 10, deps);
      if (v.ok) err('100X 카운터: 교차 마진인데 통과했습니다');
      if (c.exchangeWrites !== 0) {
        err(`100X 카운터: 교차 마진으로 막힐 요청이 거래소에 ${c.exchangeWrites}번 썼습니다`
          + ' — 막힌 것으로는 부족합니다. 계좌 설정이 이미 바뀌었습니다');
      }
      if (c.exchangeReads === 0) err('100X 카운터: 마진 모드를 읽지도 않고 막았습니다');
      if (c.orderSubmits !== 0) err('100X 카운터: 막힌 요청이 주문을 냈습니다');
    }

    // 배정 비율이 없으면 **쓰기 0**이어야 한다.
    {
      const { deps, c } = countingDeps();
      const v = await planEntry100x(C, null, deps);
      if (v.ok) err('100X 카운터: 배정 비율이 없는데 통과했습니다');
      if (c.exchangeWrites !== 0) {
        err(`100X 카운터: 배정 비율 미지정으로 막힐 요청이 거래소에 ${c.exchangeWrites}번 썼습니다`);
      }
    }

    // 통과하는 요청은 **정확히 한 번만** 쓴다. 0이면 되읽기 없이 통과한
    // 것이고, 2 이상이면 같은 설정을 두 번 거는 것이다.
    {
      const { deps, c } = countingDeps();
      const v = await planEntry100x(C, 10, deps);
      if (!v.ok) err(`100X 카운터: 정상 입력이 막혔습니다 — ${v.message}`);
      if (c.exchangeWrites !== 1) {
        err(`100X 카운터: 통과 경로의 거래소 쓰기가 ${c.exchangeWrites}번입니다 (1이어야 합니다)`);
      }
    }
  }
}

// ── 진입 전 청산거리 보호 (②) ──
//
//   `NO_FIXED_SL`에는 손절이 없다. 그래서 저장소의 청산 판정 넷이 전부
//   성립하지 않고(모두 "손절이 청산보다 먼저인가"를 묻는다), 체크리스트는
//   `LIQUIDATION_DISTANCE`를 Exact100X에서 **항목째로 뺀다.** 그 결과
//   진입 경로에 청산 판정이 하나도 없었고, 계획은 `liquidationPrice: 0`을
//   적고 있었다 — 0은 "0달러에 청산"이라 거리가 100%가 된다.
//
//   ★ 이것은 **진입 전 보호**다. 열린 포지션을 닫는 권한이 아니다.
{
  const liq = await loadModule(LIQ, '청산거리 판정');
  // 바이낸스 BTCUSDT 대표 구간
  const BR = [[50_000, 0.004, 0], [500_000, 0.005, 50], [1_000_000, 0.010, 2_550]];
  const okIn = (over = {}) => ({
    side: 'LONG', referencePrice: 50_000, quantity: 0.2, leverage: 100,
    marginMode: 'isolated', brackets: BR, adverseDistancePct: 0.3, ...over,
  });
  if (liq) {
    const good = liq.assessLiquidationDistance(okIn());
    if (!good.ok) err(`${LIQ}: 정상 100배 입력이 막힙니다 — ${good.reason}`);
    if (!(good.liquidationDistancePct > 0)) {
      err(`${LIQ}: 통과했는데 청산거리가 ${good.liquidationDistancePct}입니다`);
    }
    if (good.headroomKind !== 'RAW') {
      err(`${LIQ}: 비용 반영 전 값이라는 표시(headroomKind: 'RAW')가 없습니다`
        + ' — ③의 실질 여유와 같은 숫자로 섞입니다');
    }

    // 방향. **거울상이 아니다** — 거래소 식은 (1−mmr)과 (1+mmr)로 갈린다.
    const L = liq.assessLiquidationDistance(okIn({ side: 'LONG' }));
    const S = liq.assessLiquidationDistance(okIn({ side: 'SHORT' }));
    if (!(L.estimatedLiquidationPrice < 50_000)) {
      err(`${LIQ}: LONG 청산가가 기준가 아래가 아닙니다 (${L.estimatedLiquidationPrice})`);
    }
    if (!(S.estimatedLiquidationPrice > 50_000)) {
      err(`${LIQ}: SHORT 청산가가 기준가 위가 아닙니다 (${S.estimatedLiquidationPrice})`);
    }
    if (!(L.liquidationDistance > 0) || !(S.liquidationDistance > 0)) {
      err(`${LIQ}: 거리를 부호로 표현합니다 — 둘 다 "불리한 방향으로 남은 거리"여야 합니다`);
    }
    if (Math.abs(L.liquidationDistancePct - S.liquidationDistancePct) < 1e-6) {
      err(`${LIQ}: LONG과 SHORT의 청산거리가 같습니다 — 한쪽 식을 다른 쪽에 복사했습니다`);
    }

    // **모르면 막는다.** 하나라도 통과하면 100배가 눈을 감고 들어간다.
    for (const [why, over, code] of [
      ['방향 없음', { side: null }, 'SIDE_UNKNOWN'],
      ['기준가 0', { referencePrice: 0 }, 'REFERENCE_PRICE_UNUSABLE'],
      ['기준가 NaN', { referencePrice: NaN }, 'REFERENCE_PRICE_UNUSABLE'],
      ['기준가 Infinity', { referencePrice: Infinity }, 'REFERENCE_PRICE_UNUSABLE'],
      ['수량 없음', { quantity: null }, 'QUANTITY_UNUSABLE'],
      ['배율 없음', { leverage: null }, 'LEVERAGE_UNUSABLE'],
      ['마진 모드 없음', { marginMode: null }, 'MARGIN_MODE_UNKNOWN'],
      ['교차 마진', { marginMode: 'cross' }, 'MARGIN_MODE_UNSUPPORTED'],
      ['브래킷 없음', { brackets: null }, 'MAINTENANCE_TIER_MISSING'],
      ['빈 브래킷 표', { brackets: [] }, 'MAINTENANCE_TIER_MISSING'],
      ['MMR이 비율이 아님', { brackets: [[Infinity, 1, 0]] }, 'MAINTENANCE_TIER_MISSING'],
      // `Number(null) === 0`이라 빠진 값이 0으로 읽히면 fail-open이다.
      ['MMR이 빠짐', { brackets: [[Infinity, null, 0]] }, 'MAINTENANCE_TIER_MISSING'],
      ['공제액이 빠짐', { brackets: [[Infinity, 0.004, null]] }, 'MAINTENANCE_TIER_MISSING'],
      ['계정별 브래킷 조정 배수', { brackets: [[Infinity, 0.004, 0, 1.5]] },
        'BRACKET_COEF_UNSUPPORTED'],
      ['변동성 거리 모름', { adverseDistancePct: null }, 'ADVERSE_DISTANCE_UNKNOWN'],
      ['변동성이 청산을 넘음', { adverseDistancePct: 1.0 }, 'ADVERSE_REACHES_LIQUIDATION'],
    ]) {
      const v = liq.assessLiquidationDistance(okIn(over));
      if (v.ok) err(`${LIQ}: ${why}인데 통과합니다 — 확인하지 못한 것은 안전이 아닙니다`);
      else if (v.code !== code) {
        err(`${LIQ}: ${why}의 사유가 ${v.code}입니다 (${code}이어야 합니다)`);
      }
    }
    // 계산 못 한 경우 **0을 청산가로 적지 않는가.**
    const uncomputable = liq.assessLiquidationDistance(
      okIn({ brackets: [[Infinity, 0.004, 1_000_000]] }));
    if (uncomputable.ok) {
      err(`${LIQ}: 청산가를 못 구했는데 통과합니다`);
    }
    if (uncomputable.estimatedLiquidationPrice != null) {
      err(`${LIQ}: 계산 못 한 청산가를 ${uncomputable.estimatedLiquidationPrice}로 적습니다`
        + ' — 0을 적으면 청산거리가 100%가 되어 가장 위험한 주문이 가장 안전해 보입니다');
    }
    // 경계는 **>** 다. 예상 움직임이 정확히 청산에 닿는 것은 여유가 아니다.
    const d = good.liquidationDistancePct;
    if (liq.assessLiquidationDistance(okIn({ adverseDistancePct: d })).ok) {
      err(`${LIQ}: 변동성 거리가 청산거리와 **같은데** 통과합니다 — 경계가 >= 입니다`);
    }
    if (!liq.assessLiquidationDistance(okIn({ adverseDistancePct: d - 1e-6 })).ok) {
      err(`${LIQ}: 경계 바로 안쪽이 막힙니다 — 조건이 그 자리에 있지 않습니다`);
    }
  }

  // ── 구간 자기일관성 (②A) ──
  //
  //   **한 번 고른 구간으로 끝내면 틀린다.** 100배는 청산까지 0.x%만
  //   움직이므로, 진입 명목가가 구간 경계 근처면 그 사이에 경계를 넘는다.
  //   넘었는데 처음 구간으로 계산하면 청산거리가 실제보다 **멀게** 나온다 —
  //   틀리는 방향이 낙관적이다.
  if (liq) {
    // LONG: 청산가가 내려가며 **아래** 구간으로.
    const L2 = liq.assessLiquidationDistance(okIn({ side: 'LONG', quantity: 1.002 }));
    if (!L2.ok) err(`${LIQ}: 경계를 넘는 정상 LONG이 막힙니다 — ${L2.reason}`);
    else {
      if (L2.entryTierIndex !== 1) err(`${LIQ}: LONG 진입 구간이 ${L2.entryTierIndex}입니다 (1이어야 합니다)`);
      if (L2.tier?.index !== 0) {
        err(`${LIQ}: LONG 청산가에서 아래 구간으로 넘어가는데 최종 구간이 ${L2.tier?.index}입니다`
          + ' — 진입 구간을 그대로 씁니다');
      }
      if (L2.tier?.mmr !== 0.004 || L2.tier?.maintAmount !== 0) {
        err(`${LIQ}: LONG 최종 구간의 MMR/공제액이 최초 구간 값입니다`
          + ` (mmr ${L2.tier?.mmr} · cum ${L2.tier?.maintAmount})`);
      }
      if (!(L2.tier?.notional <= 50_000)) {
        err(`${LIQ}: LONG 자기일관이 깨졌습니다 — 청산 명목가 ${L2.tier?.notional}가 고른 구간 밖입니다`);
      }
    }
    // SHORT: 청산가가 올라가며 **위** 구간으로.
    const S2 = liq.assessLiquidationDistance(okIn({ side: 'SHORT', quantity: 9.99 }));
    if (!S2.ok) err(`${LIQ}: 경계를 넘는 정상 SHORT이 막힙니다 — ${S2.reason}`);
    else {
      if (S2.entryTierIndex !== 1) err(`${LIQ}: SHORT 진입 구간이 ${S2.entryTierIndex}입니다 (1이어야 합니다)`);
      if (S2.tier?.index !== 2) {
        err(`${LIQ}: SHORT 청산가에서 위 구간으로 넘어가는데 최종 구간이 ${S2.tier?.index}입니다`);
      }
      if (S2.tier?.mmr !== 0.010 || S2.tier?.maintAmount !== 2_550) {
        err(`${LIQ}: SHORT 최종 구간의 MMR/공제액이 최초 구간 값입니다`
          + ` (mmr ${S2.tier?.mmr} · cum ${S2.tier?.maintAmount})`);
      }
      if (!(S2.tier?.notional > 500_000)) {
        err(`${LIQ}: SHORT 자기일관이 깨졌습니다 — 청산 명목가 ${S2.tier?.notional}가 고른 구간 밖입니다`);
      }
    }
    // 고친 값은 옛 값보다 **짧아야** 한다. 옛 계산이 낙관적이었다.
    if (L2.ok) {
      const q = 1.002;
      const oldLp = (50_000 * (1 - 1 / 100) - 50 / q) / (1 - 0.005);
      const oldPct = (50_000 - oldLp) / 50_000 * 100;
      if (!(L2.liquidationDistancePct < oldPct)) {
        err(`${LIQ}: 경계를 넘는데 청산거리가 옛 값(${oldPct.toFixed(5)}%)보다 짧지 않습니다`
          + ` (${L2.liquidationDistancePct}%) — 낙관적인 방향으로 틀렸습니다`);
      }
    }
    // 자기일관 해가 **없는** 경우. 두 구간이 서로를 가리키게 만든다.
    //   1구간(상한 99 · cum 0) → 청산가 99.398 → 2구간
    //   2구간(상한 ∞  · cum 1) → 청산가 98.394 → 1구간
    // 진입 구간(2구간)의 답은 양수이고 방향도 맞으므로, 지어내면 통과해
    // 버린다 — 퇴화하지 않는 케이스여야 그 변이를 잡는다.
    {
      const noSol = liq.assessLiquidationDistance(okIn({
        referencePrice: 100, quantity: 1, brackets: [[99, 0.004, 0], [Infinity, 0.004, 1]],
      }));
      if (noSol.ok) err(`${LIQ}: 자기일관 해가 없는데 통과합니다 — 진입 구간으로 답을 지어냅니다`);
      else if (noSol.code !== 'TIER_NOT_SELF_CONSISTENT') {
        err(`${LIQ}: 해가 없는 경우의 사유가 ${noSol.code}입니다`
          + ' (TIER_NOT_SELF_CONSISTENT여야 합니다 — 계산 불가와 구별돼야 합니다)');
      }
    }

    // 넘지 않는 자리는 그대로여야 한다 (과도 수정이 아니다).
    const mid = liq.assessLiquidationDistance(okIn({ quantity: 0.2 }));
    if (mid.tier?.index !== 0 || mid.entryTierIndex !== 0) {
      err(`${LIQ}: 구간 한가운데인데 구간이 바뀝니다`);
    }
  }

  // 경계 해석(`<=`)이 **한 곳**에만 있는가. 두 파일이 각자 고르면 경계
  // 바로 위아래에서 답이 갈린다.
  {
    const src = code(LIQ);
    if (/<=\s*cap|cap\s*>=|notionalCap/.test(src)) {
      err(`${LIQ}: 구간 경계 해석을 이 파일에서 다시 합니다`
        + ' — tierIndexFor 하나에만 있어야 합니다');
    }
    if (!/solveLiquidationPrice/.test(src)) {
      err(`${LIQ}: 자기일관 solver를 쓰지 않습니다 — 진입 명목가 구간으로 끝내면 틀립니다`);
    }
    // **계정별 브래킷 조정 배수를 버리지 않는가.**
    //
    //   버린다는 것은 "그런 조정이 없다"고 가정하는 것과 같다. 확인한 적이
    //   없으므로 보존하고, 1이 아니면 위 판정이 막는다.
    //   ★ 이름이 있는지로는 부족하다. `BracketTier` 튜플 라벨에도 같은
    //     단어가 있어서, 파서가 값을 버려도 정규식은 통과했다 — 실제로
    //     그 변이가 새 나갔다. 그래서 **파서를 돌려서** 확인한다.
    const bfMod = await loadModule('src/lib/exchanges/leverageBracket.ts', '브래킷 파서');
    if (bfMod && typeof bfMod.parseBrackets === 'function') {
      // ★ **바이낸스 실제 응답 모양**이다. `notionalCoef`는 bracket 줄
      //   안이 아니라 **symbol 객체 최상위**에 있다. 예전 fixture는 줄
      //   안에 넣고 있었고, 구현도 거기서 읽고 있어서 **둘이 같은 오해를
      //   공유한 채 초록**이었다. 실제 응답에는 줄 안에 그 칸이 없으므로
      //   조정 배수를 계속 버리고 있었던 셈이다.
      const parsed = bfMod.parseBrackets({
        symbol: 'BTCUSDT',
        notionalCoef: 1.5,
        brackets: [
          { bracket: 1, initialLeverage: 125, notionalCap: 50_000,
            notionalFloor: 0, maintMarginRatio: 0.004, cum: 0 },
          { bracket: 2, initialLeverage: 100, notionalCap: 500_000,
            notionalFloor: 50_000, maintMarginRatio: 0.005, cum: 50 },
        ],
      });
      if (!Array.isArray(parsed) || parsed.length !== 2) {
        err('leverageBracket.parseBrackets: 구간을 파싱하지 못합니다');
      } else {
        // 계정-level 값이므로 **모든 구간**이 그 값을 들고 있어야 한다.
        if (parsed[0][3] !== 1.5 || parsed[1][3] !== 1.5) {
          err('leverageBracket.parseBrackets: 최상위 notionalCoef를 버립니다'
            + ` (구간별 값 ${String(parsed[0][3])}·${String(parsed[1][3])})`
            + ' — 계정별 브래킷 조정이 걸려 있어도 알 수 없습니다');
        }
        if (parsed[0][1] !== 0.004 || parsed[1][2] !== 50) {
          err('leverageBracket.parseBrackets: 실제 응답 모양에서 MMR·공제액을 못 읽습니다');
        }
      }
      // 줄 안에만 들어 있는 값은 **읽지 않아야 한다** — 실제 API에는
      // 그 자리에 그런 칸이 없고, 거기서 읽으면 늘 undefined다.
      const bogus = bfMod.parseBrackets({
        symbol: 'BTCUSDT',
        brackets: [{ notionalCap: 50_000, maintMarginRatio: 0.004, cum: 0, notionalCoef: 1.5 }],
      });
      if (bogus?.[0]?.[3] !== undefined) {
        err('leverageBracket.parseBrackets: bracket 줄 안의 notionalCoef를 읽습니다'
          + ' — 실제 응답에는 그 자리에 그 칸이 없습니다');
      }
      // 조정이 없는 응답은 undefined여야 한다(지어내지 않는다).
      const plain = bfMod.parseBrackets({
        symbol: 'BTCUSDT',
        brackets: [{ notionalCap: 50_000, maintMarginRatio: 0.004, cum: 0 }],
      });
      if (plain?.[0]?.[3] !== undefined) {
        err('leverageBracket.parseBrackets: 응답에 없는 notionalCoef를 지어냅니다');
      }
    } else {
      err('leverageBracket.parseBrackets를 불러오지 못했습니다 — 파서 동작을 확인할 수 없습니다');
    }
    const ps = code('src/lib/safety/liquidationPrice.ts');
    const caps = (ps.match(/notional\s*<=\s*table\[i\]\[0\]|notional\s*<=\s*cap/g) || []).length;
    if (caps !== 1) {
      err(`src/lib/safety/liquidationPrice.ts: 경계 비교가 ${caps}곳입니다 — 한 곳이어야 합니다`);
    }
  }

  // 식을 **복제하지 않는가.** 청산가 산출은 safety/liquidationPrice 하나다.
  {
    const src = code(LIQ);
    if (!/from '\.\.\/safety\/liquidationPrice'/.test(src)
        || !/solveLiquidationPrice/.test(src)) {
      err(`${LIQ}: 청산가 산출식 정본(safety/liquidationPrice의 solveLiquidationPrice)을`
        + ' 쓰지 않습니다');
    }
    // 식을 여기서 다시 쓰면 두 벌이 된다. 그 모양을 직접 막는다.
    if (/1\s*\/\s*leverage|1\s*\/\s*lev\b/.test(src)) {
      err(`${LIQ}: 청산가 식을 이 파일에서 다시 씁니다 — 정본과 갈립니다`);
    }
    // 추정 표로 떨어지지 않는가.
    if (/MMR_BRACKETS/.test(src)) {
      err(`${LIQ}: 추정 유지증거금 표를 씁니다 — 100배에서 구간을 잘못 짚으면 청산가가 통째로 달라집니다`);
    }
  }

  // 진입 계획이 **그 판정으로 막는가** (이름이 아니라 동작).
  if (entry) {
    const base = {
      observeMarginMode: async () => 'isolated',
      applyLeverage: async (lev) => ({ ok: true, observed: lev, message: '' }),
      availableUsd: async () => 1000,
      referenceMark: async () => ({
        price: 50_000, exchangeTimeMs: Date.now() - 100, observedAtMs: Date.now(),
        source: 'EXCHANGE_PREMIUM_INDEX', cache: 'FRESH',
      }),
      quantize: async (q) => ({ qty: q, message: '' }),
      maintenanceTiers: async () => ({
        tiers: [[50_000_000, 0.004, 0]], observedAtMs: Date.now(), freshness: 'FRESH',
      }),
      adverseDistancePct: async () => 0.3,
      commissionRates: async () => ({
        takerRate: 0.0004, makerRate: 0.0002,
        source: 'EXCHANGE_ACCOUNT', observedAtMs: Date.now(),
      }),
      orderBookDepth: async () => ({
        bids: [[49_995, 50]], asks: [[50_005, 50]],
        source: 'EXCHANGE_DEPTH', observedAtMs: Date.now(), exchangeTimeMs: Date.now() - 100,
      }),
      fundingContext: async () => ({
        rate: 0.0001, nextFundingTimeMs: Date.now() + 3_600_000, intervalHours: 8,
        capRate: 0.0005, floorRate: -0.0005,
        source: 'EXCHANGE_FUNDING_INFO',
      premiumObservedAtMs: Date.now(), premiumExchangeTimeMs: Date.now() - 100,
      premiumCache: 'FRESH', fundingBoundsObservedAtMs: Date.now(),
      }),
    };
    const CC = { leverage: 100, sizingPolicy: 'MARGIN_ALLOCATION', marginModes: ['isolated'],
                 side: 'LONG', fillKind: 'TAKER', maxHoldSec: 14_400 };
    for (const [why, over] of [
      ['브래킷을 못 읽으면', { maintenanceTiers: async () => null }],
      ['브래킷 조회가 터지면', { maintenanceTiers: async () => { throw new Error('boom'); } }],
      ['변동성 거리를 모르면', { adverseDistancePct: async () => null }],
      ['변동성이 청산을 넘으면', { adverseDistancePct: async () => 5 }],
      ['방향을 모르면', {}],
    ]) {
      const c = why === '방향을 모르면' ? { ...CC, side: null } : CC;
      const prep = await entry.prepareEntry100x(c, 10, { ...base, ...over });
      if (prep.ok) err(`100X 진입: ${why} 막아야 하는데 통과했습니다`);
      else if (prep.code !== 'LIQUIDATION_UNSAFE') {
        err(`100X 진입: ${why} 막긴 했는데 사유가 ${prep.code}입니다 (LIQUIDATION_UNSAFE여야 합니다)`);
      }
    }
    // 막힌 계획도 **계산한 데까지는 말한다.**
    const blocked = await entry.prepareEntry100x(
      CC, 10, { ...base, adverseDistancePct: async () => 5 });
    if (blocked.liquidation == null || blocked.liquidation.liquidationDistancePct == null) {
      err('100X 진입: 여유가 모자라 막혔는데 계산한 청산거리를 버립니다'
        + ' — 운영자가 계산 실패와 구별할 수 없습니다');
    }
    // 통과한 계획은 판정을 들고 간다.
    const passed = await entry.prepareEntry100x(CC, 10, base);
    if (!passed.ok || passed.liquidation?.ok !== true) {
      err('100X 진입: 통과한 계획이 청산거리 판정을 들고 있지 않습니다');
    }
  }

  // 의존 분류 — 새 읽기가 통합 카운터 밖으로 새지 않는가.
  if (entry) {
    for (const nm of ['maintenanceTiers', 'adverseDistancePct']) {
      if (!(entry.READONLY_DEPS || []).includes(nm)) {
        err(`100X 진입: ${nm}이 READONLY_DEPS에 없습니다 — 분류 밖 의존은 카운터에서 샙니다`);
      }
      if ((entry.MUTATING_DEPS || []).includes(nm)) {
        err(`100X 진입: ${nm}이 쓰기로 분류돼 있습니다 — 읽기입니다`);
      }
    }
    const es = code(ENTRY);
    // 읽기 전용 타입에 들어 있어야 **구조상** 쓰기보다 앞이 된다.
    const iRead = es.indexOf('export interface Entry100xReadDeps');
    const iWrite = es.indexOf('export interface Entry100xWriteDeps');
    const readBlock = iRead >= 0 && iWrite > iRead ? es.slice(iRead, iWrite) : '';
    for (const nm of ['maintenanceTiers', 'adverseDistancePct']) {
      if (!readBlock.includes(nm)) {
        err(`${ENTRY}: ${nm}이 읽기 전용 의존 타입 안에 없습니다`
          + ' — 쓰기 단계에서 읽게 되면 보호가 첫 거래소 쓰기 뒤로 갑니다');
      }
    }
  }

  // 라우트가 **0을 다시 적지 않는가.**
  {
    const sc = code(SCALP);
    if (/liquidationPrice:\s*0\s*,\s*liquidationDistancePct:\s*0/.test(sc)) {
      err(`${SCALP}: 청산가·청산거리를 0으로 적습니다`
        + ' — 0은 "0달러에 청산"이라 거리가 100%가 됩니다 (UNKNOWN을 0으로 적지 않는다)');
    }
    // **낡은 거래소 값이 Exact100X 입력으로 들어가지 않는가.**
    //
    //   브래킷도 premium도 TTL이 지난 뒤 조회에 실패하면 옛 값이 남는다.
    //   판정은 ④의 정본(`marketFreshness`) 한 곳에서 한다 — 라우트가
    //   따로 보면 규칙이 두 벌이 되고 사유가 "못 읽음"으로 뭉개진다.
    //   그래서 라우트에 요구하는 것은 **캐시 상태를 그대로 넘기는 것**이다.
    for (const [dep, what, need] of [
      ['maintenanceTiers:', '유지증거금 브래킷', /freshness:\s*r\.freshness/],
      ['fundingContext:', 'premium', /premiumCache:\s*snap\.stamps\.cache/],
    ]) {
      const at = sc.indexOf(dep);
      if (at < 0) { err(`${SCALP}: ${what} 의존을 넘기지 않습니다`); continue; }
      const body = sc.slice(at, at + 2200);
      if (!need.test(body)) {
        err(`${SCALP}: ${what}의 캐시 상태를 엔진에 그대로 넘기지 않습니다`
          + ' — 만료된 캐시가 새 데이터로 보이고 ④가 그것을 볼 수 없습니다');
      }
      if (/freshness:\s*'FRESH'|premiumCache:\s*'FRESH'/.test(body)) {
        err(`${SCALP}: ${what}의 캐시 상태를 'FRESH'로 적습니다 — 세탁입니다`);
      }
    }
    // **관측 시각을 라우트에서 만들어 붙이지 않는가.**
    //
    //   `Date.now()`를 붙이면 언제 읽었든 항상 "방금"이 된다. 읽는 쪽이
    //   응답에 시각을 넣어 주므로, 라우트에는 붙일 이유가 없다.
    for (const [dep, what] of [
      ['referenceMark:', '기준 마크가'],
      ['commissionRates:', '수수료율'],
      ['orderBookDepth:', '호가'],
      ['fundingContext:', '펀딩 데이터'],
    ]) {
      const at = sc.indexOf(dep);
      if (at < 0) { err(`${SCALP}: ${what} 의존을 넘기지 않습니다`); continue; }
      const body = sc.slice(at, at + 2200);
      if (/(observedAtMs|ObservedAtMs|exchangeTimeMs|ExchangeTimeMs):\s*Date\.now\(\)/.test(body)) {
        err(`${SCALP}: ${what}에 새 시각(Date.now())을 붙입니다`
          + ' — 낡은 값이 "방금 읽은 데이터"로 보입니다 (④가 설 기반이 사라집니다)');
      }
    }
    // premium과 펀딩 상한의 시각을 **합치지 않는가.**
    {
      const at = sc.indexOf('fundingContext:');
      const body = at < 0 ? '' : sc.slice(at, at + 2200);
      if (!/premiumObservedAtMs:\s*snap\.stamps\.observedAtMs/.test(body)) {
        err(`${SCALP}: premium의 실제 관측 시각을 쓰지 않습니다`);
      }
      if (!/fundingBoundsObservedAtMs:\s*fb\.bounds\.observedAtMs/.test(body)) {
        err(`${SCALP}: 펀딩 상한의 관측 시각을 premium과 **따로** 적지 않습니다`
          + ' — 한 칸에 합치면 한쪽의 신선함이 다른 쪽을 덮습니다');
      }
    }
    // **기준 마크가를 계좌/포지션 응답에서 떼어 오지 않는가.**
    //
    //   `positionRisk.markPrice`는 계좌 상태 응답 안의 숫자다. 그 응답의
    //   `updateTime`은 포지션이 갱신된 시각이지 마크가가 만들어진 시각이
    //   아니다 — 서로의 timestamp가 될 수 없다.
    {
      const at = sc.indexOf('referenceMark:');
      const body = at < 0 ? '' : sc.slice(at, at + 1200);
      if (/futuresPositionRisk|positionRisk|updateTime/.test(body)) {
        err(`${SCALP}: 기준 마크가를 계좌/포지션 응답에서 읽습니다`
          + ' — 그 응답의 updateTime은 포지션 갱신 시각이지 시세 시각이 아닙니다');
      }
      if (!/marketSnapshot\(\)/.test(body)) {
        err(`${SCALP}: 기준 마크가를 시장 스냅숏에서 읽지 않습니다`);
      }
    }
    // **한 진입이 시장 스냅숏을 한 번만 읽는가.**
    //
    //   마크가와 premium이 서로 다른 조회에서 오면, 청산거리는 T0의
    //   가격으로 펀딩은 T1의 요율로 계산된다 — ④가 막으려는 바로 그
    //   모양을 ④ 자신이 만드는 꼴이다. 라우트가 Promise 하나를 만들어
    //   두 의존이 같은 것을 기다리게 해야 한다.
    {
      if (!/marketSnapshotOnce/.test(sc)) {
        err(`${SCALP}: 시장 스냅숏을 요청 범위로 공유하지 않습니다`
          + ' — 마크가와 펀딩이 서로 다른 시점이 됩니다');
      }
      const calls = (sc.match(/readMarketSnapshot\(/g) || []).length;
      if (calls !== 1) {
        err(`${SCALP}: readMarketSnapshot을 ${calls}번 부릅니다`
          + ' — 한 진입은 한 스냅숏이어야 합니다');
      }
      const iFund = sc.indexOf('fundingContext:');
      const fundBody = iFund < 0 ? '' : sc.slice(iFund, iFund + 2200);
      if (/readPremiumIndex/.test(fundBody)) {
        err(`${SCALP}: 펀딩 입력이 45초 캐시 reader(readPremiumIndex)를 씁니다`
          + ' — 마크가와 다른 시점이 됩니다');
      }
      if (!/marketSnapshot\(\)/.test(fundBody)) {
        err(`${SCALP}: 펀딩 입력이 마크가와 **같은 스냅숏**을 쓰지 않습니다`);
      }
    }

    // 변동성 거리로 **손절가**를 넘기지 않는가. `NO_FIXED_SL`을 되살리는 길이다.
    const iAdv = sc.indexOf('adverseDistancePct:');
    if (iAdv < 0) {
      err(`${SCALP}: 변동성 위험 거리를 진입 계획에 넘기지 않습니다`);
    } else {
      const seg = sc.slice(iAdv, iAdv + 300);
      if (!/signal\.stopPct/.test(seg)) {
        err(`${SCALP}: 변동성 위험 거리에 신호의 stopPct를 넘기지 않습니다`);
      }
      if (/stopLoss|stopPrice/.test(seg)) {
        err(`${SCALP}: 변동성 위험 거리 자리에서 손절 주문 값을 씁니다`
          + ' — NO_FIXED_SL에서 그 값은 거래소로 나가지 않습니다');
      }
    }
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
// **타입 유니온에 이름만 남아 있어도 통과하면 안 된다.** 이 저장소에서
// 검사기가 새 나간 형태가 정확히 그것이다 — 조건을 지워도 문자열이 남아서
// 초록이 됐다. 그래서 "손절이 없으면 그 코드로 멈춘다"는 **조건**을 본다.
const life = code(LIFECYCLE);
if (!/if\s*\(\s*!\s*\(\s*Number\(\s*p\.stopLoss\s*\)\s*>\s*0\s*\)\s*\)[\s\S]{0,200}?NO_FIXED_STOP/.test(life)) {
  err(`${LIFECYCLE}: 고정 손절이 없는 포지션에서 멈추는 조건이 없습니다`
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
// **전략을 실제로 넘기는가.** 안 넘기면 게이트가 전략을 봐도 항상 빈 값이
// 들어와서, 열린 조합이 있어도 아무것도 안 켜지거나(운이 좋으면) 전략
// 조건이 무의미해진다.
for (const [src, file] of [[runner, RUNNER], [sched, SCHED], [code(SCALP), SCALP]]) {
  const call = src.slice(src.indexOf('executionGateVerdict('),
                         src.indexOf('executionGateVerdict(') + 500);
  if (!/strategyId:/.test(call)) {
    err(`${file}: executionGateVerdict에 strategyId를 넘기지 않습니다`
      + ' — 전략 조건이 항상 빈 값으로 판정됩니다');
  }
}

const scalpSrc = code(SCALP);
// ─────────────────────────────────────────────────────────────
// ④ 차단될 요청은 거래소 상태를 바꾸지 않는가 (부작용 순서)
// ─────────────────────────────────────────────────────────────
//
// **"주문이 안 나갔다"로는 부족하다.** 요청이 TESTNET인데 연결이 실계좌면,
// 주문이 막혀도 그 전에 실계좌의 배율이 바뀔 수 있다. 계좌 설정이 바뀌었고,
// 그 자리에 포지션이 있었다면 청산가가 함께 움직인다.
//
// 그래서 호출 하나를 세지 않는다 — **거래소를 건드리는 단계 전체**가 권한
// 뒤에 있는지를 본다. 나중에 마진 모드 setter 같은 쓰기가 붙어도 같은
// 보장이 유지되어야 한다.
{
  const at = code(AUTHORITY);
  if (!at) err(`${AUTHORITY}이(가) 없습니다 — 권한 판정이 라우트 안에 흩어져 있습니다`);
  else if (!/export async function guardedEntry/.test(at)) {
    err(`${AUTHORITY}: guardedEntry가 없습니다 — 순서를 구조로 강제할 수 없습니다`);
  }

  // 권한이 막으면 **감싼 단계가 아예 실행되지 않는가** — 세어서 확인한다.
  {
    const am = await loadModule(AUTHORITY, '진입 권한');
    if (am) {
      const ok = {
        exchangeSupported: true, connIsLive: false, modeNeedsLiveKey: false,
        killSwitchReason: '', migrationReason: '', liveClosedReason: '',
      };
      for (const [over, why] of [
        [{ exchangeSupported: false }, '지원하지 않는 거래소'],
        [{ connIsLive: true }, '모드↔연결 불일치'],
        [{ killSwitchReason: '멈춤' }, '킬 스위치'],
        [{ migrationReason: '밀림' }, '마이그레이션'],
        [{ liveClosedReason: '닫힘' }, '실거래 닫힘'],
      ]) {
        let ran = 0;
        const r = await am.guardedEntry({ ...ok, ...over }, async () => { ran++; return 1; });
        if (r.verdict.allowed) err(`진입 권한: ${why}인데 통과했습니다`);
        if (ran !== 0) {
          err(`진입 권한: ${why}로 막힐 요청이 거래소 단계를 ${ran}번 실행했습니다`
            + ' — 감싸기가 순서를 강제하지 못합니다');
        }
      }
      let ran2 = 0;
      const good = await am.guardedEntry(ok, async () => { ran2++; return 7; });
      if (!good.verdict.allowed || good.result !== 7 || ran2 !== 1) {
        err('진입 권한: 통과해야 할 요청이 감싼 단계를 정확히 한 번 실행하지 않았습니다');
      }
    }
  }

  const iAuth = scalpSrc.indexOf('guardedEntry(');
  const iPlan = scalpSrc.indexOf('prepareEntry100x(');
  const iConn = scalpSrc.indexOf('loadConnection(');
  const iOrder = scalpSrc.indexOf('executeOrder(sb');
  if (iAuth < 0) {
    err(`${SCALP}: guardedEntry를 쓰지 않습니다`
      + ' — 권한과 거래소 쓰기의 순서가 줄 위치로만 지켜집니다');
  } else {
    if (!(iConn < iAuth)) err(`${SCALP}: 연결 로드가 권한 판정보다 뒤입니다`);
    if (!(iAuth < iPlan)) {
      err(`${SCALP}: 거래소를 건드리는 계획 단계가 권한 판정보다 앞입니다`
        + ' — 차단될 요청이 계좌 설정을 먼저 바꿉니다');
    }
    if (!(iPlan < iOrder)) err(`${SCALP}: 계획이 주문 제출보다 뒤입니다`);
  }

  // 권한 판정에 쓰이는 사실이 **전부 판정 앞에서** 모이는가.
  //
  // 아래 목록은 "거래소 쓰기 없이 결론이 나는 차단"이다. 하나라도 쓰기
  // 뒤로 내려가면 그 사유로 막힐 요청이 계좌 설정을 먼저 바꾼다.
  for (const [needle, what] of [
    ['killSwitchGate(', '킬 스위치'],
    ['migrationGate(', '마이그레이션 관문'],
    ['strategyConflictGate(', '전략 충돌'],
    ['sleeveCapitalGate(', '슬리브 자본'],
    ['parityGate(', '시크릿 정합'],
    ['exitMonitorGate(', '청산 감시 신선도'],
    ['modeNeedsConfirmation(', '사람 확인'],
    ['suppressGate(', '수동 청산 억제'],
  ]) {
    const i = scalpSrc.indexOf(needle);
    if (i < 0) { err(`${SCALP}: ${what} 검사가 없습니다`); continue; }
    if (iAuth >= 0 && !(i < iAuth)) {
      err(`${SCALP}: ${what}가 권한 판정보다 뒤입니다 — 멈춰 둔 계좌에 설정이 나갑니다`);
    }
    if (iPlan >= 0 && !(i < iPlan)) {
      err(`${SCALP}: ${what}가 거래소 쓰기보다 뒤입니다`);
    }
  }

  // ── 2단계 구조가 실제로 두 단계인가 ──
  //
  // 순서를 줄 위치로만 지키면 뒤집힌다. 실제로 뒤집혀 있었다 —
  // 배율 설정이 잔고·기준가·규격 조회보다 **앞**이라, 그 조회에서 막힐
  // 요청이 계좌 배율을 먼저 바꿨다.
  //
  // 그래서 읽기 단계에는 쓰기 함수를 **줄 수 없게** 만들었다. 그것이
  // 지켜지는지 본다.
  {
    const es = code(ENTRY);
    if (!/export async function prepareEntry100x/.test(es)) {
      err(`${ENTRY}: prepareEntry100x가 없습니다 — 읽기 단계가 분리되지 않았습니다`);
    }
    if (!/export async function commitEntry100x/.test(es)) {
      err(`${ENTRY}: commitEntry100x가 없습니다 — 쓰기 단계가 분리되지 않았습니다`);
    }
    // 준비 단계의 매개변수 타입이 읽기 전용인가.
    const prepSig = (es.match(/export async function prepareEntry100x\(([\s\S]*?)\): Promise/) || [])[1] || '';
    if (!/deps:\s*Entry100xReadDeps/.test(prepSig)) {
      err(`${ENTRY}: prepareEntry100x가 읽기 전용 의존을 받지 않습니다`
        + ' — 쓰기 함수가 타입에 있으면 순서가 다시 주석으로만 지켜집니다');
    }
    // 준비 단계 본문에 쓰기가 없는가.
    const prepBody = (es.match(/export async function prepareEntry100x[\s\S]*?\n\}/) || [''])[0];
    if (/applyLeverage/.test(prepBody)) {
      err(`${ENTRY}: prepareEntry100x 본문이 applyLeverage를 부릅니다 — 읽기 단계가 씁니다`);
    }
    // 읽기 전용 의존 타입에 쓰기가 섞이지 않았는가.
    const roIface = (es.match(/export interface Entry100xReadDeps \{([\s\S]*?)\n\}/) || [])[1] || '';
    for (const w of ['applyLeverage']) {
      if (roIface.includes(w)) {
        err(`${ENTRY}: Entry100xReadDeps에 쓰기 의존 ${w}가 들어 있습니다`);
      }
    }
  }

  // 확정 단계가 관문 판정을 **실제로 강제하는가**. 규칙이 라우트의
  // `if`에만 있으면 그 조건을 뒤집는 변경이 시험에 안 걸린다.
  {
    const es = code(ENTRY);
    const commitBody = (es.match(/export async function commitEntry100x[\s\S]*?\n\}/) || [''])[0];
    if (!/preWrite/.test(commitBody)) {
      err(`${ENTRY}: commitEntry100x가 쓰기 전 관문 판정을 받지 않습니다`);
    }
    if (!/disposition\s*!==\s*'SEND'/.test(commitBody)) {
      err(`${ENTRY}: commitEntry100x가 'SEND'가 아닐 때 멈추지 않습니다`);
    }
  }

  // 준비 단계가 그 분기 **안**에 있는가.
  {
    const iBranch = scalpSrc.indexOf("if (epSizingPolicy === 'MARGIN_ALLOCATION') {");
    const iPrepCall = scalpSrc.indexOf('prepareEntry100x(');
    if (iBranch >= 0 && iPrepCall >= 0 && !(iBranch < iPrepCall)) {
      err(`${SCALP}: 준비 단계가 사이징 정책 분기 밖에 있습니다`);
    }
  }

  // ── 라우트에서 첫 거래소 쓰기의 자리 ──
  //
  // **쓰기는 늦을수록 좋다.** 준비 단계가 계획을 만들어 두므로 남은
  // 관문(1회 상한 · 점검 목록 · 거부권 · 숏 방어 · 중복 신호)이 전부
  // 거래소를 건드리지 않고 판정된다. 그렇다면 배율은 그 관문들을 다
  // 지난 **주문 직전**에 걸어야 한다.
  //
  // 여기서 세는 자리는 `futuresApplyLeverage`가 적힌 줄이 아니다 — 그건
  // 클로저 정의일 뿐이고, 실제로 쓰는 시점은 확정 단계를 부르는 자리다.
  const iCommitCall = scalpSrc.indexOf('commitEntry100x(\n      prepared100x');
  {
    const iPrep = scalpSrc.indexOf('prepareEntry100x(');
    if (iPrep < 0) err(`${SCALP}: 준비 단계를 부르지 않습니다`);
    if (iCommitCall < 0) {
      err(`${SCALP}: 확정 단계를 준비 결과로 부르지 않습니다`
        + ' — 쓰기 시점을 특정할 수 없습니다');
    } else {
      if (iPrep >= 0 && !(iPrep < iCommitCall)) {
        err(`${SCALP}: 확정(쓰기)이 준비 단계보다 앞입니다`);
      }
      // 쓰기 없이 판정되는 관문이 전부 쓰기 앞에 있는가.
      for (const [needle, what] of [
        ['killSwitchGate(', '킬 스위치'],
        ['migrationGate(', '마이그레이션 관문'],
        ['strategyConflictGate(', '전략 충돌'],
        ['sleeveCapitalGate(', '슬리브 자본'],
        ['parityGate(', '시크릿 정합'],
        ['exitMonitorGate(', '청산 감시 신선도'],
        ['modeNeedsConfirmation(', '사람 확인'],
        ['suppressGate(', '수동 청산 억제'],
        ['gateOrder(opMode', '1회 상한'],
        ['runChecklist(', '점검 목록'],
        ['applyVetoToSignal(', '경제일정·변동성 거부권'],
        ['shortGuard(', '숏 방어'],
        ['claimSignal(', '중복 신호'],
      ]) {
        const i = scalpSrc.indexOf(needle);
        if (i < 0) { err(`${SCALP}: ${what} 검사가 없습니다`); continue; }
        if (!(i < iCommitCall)) {
          err(`${SCALP}: ${what}가 거래소 쓰기보다 뒤입니다`
            + ' — 이 사유로 막힐 요청이 계좌 배율을 먼저 바꿉니다');
        }
      }
      // 1회 상한 판정을 확정 단계에 **실제로 넘기는가.** 부르고 결과를
      // 버리면 아무것도 막지 못한다 — 실제로 그 변이가 새 나갔었다.
      if (!/commitEntry100x\(\n\s*prepared100x,[\s\S]{0,200}?modeGate,\n\s*\)/.test(scalpSrc)) {
        err(`${SCALP}: 1회 상한 판정(modeGate)을 확정 단계에 넘기지 않습니다`);
      }
    }
  }

  // ── 쓰기 뒤에 남은 차단은 **전부 등록돼 있는가** ──
  //
  // 위의 개별 규칙은 "옮긴 것이 도로 내려갔는가"만 본다. 그것으로는
  // **새로 생긴** 게이트를 못 잡는다 — 누가 내일 쓰기 뒤에 차단을 하나
  // 더 붙이면, 그 사유로 막힐 요청은 또 계좌 설정을 먼저 바꾼다.
  //
  // 그래서 반대로 센다. 쓰기 경계 뒤의 차단 코드를 **전부 뽑아서**, 아래
  // 목록에 없으면 실패시킨다. 목록에 올리려면 "왜 앞으로 못 옮기는가"를
  // 적어야 한다. 옮길 수 있는데 뒤에 둔 것은 통과하지 못한다.
  // 쓰기 뒤에 남아도 되는 차단은 **걸어 봐야 아는 것**뿐이다.
  const POST_WRITE_ALLOWED = new Map([
    ['LEVERAGE_NOT_EXACT',
      '배율을 걸고 되읽어야 알 수 있다 — 쓰기의 결과 그 자체다'],
    ['LEVERAGE_MISMATCH',
      '이 단계가 곧 쓰기다(ensureLeverage) — 맞추고 되읽는 일 자체라 앞에 둘 수 없다'],
  ]);
  {
    const wb = iCommitCall;
    const seen = new Set();
    // `blocked:` 뒤의 **그 줄 전체**에서 코드를 뽑는다. 삼항으로 적힌
    // 것(`blocked: x ? null : 'MODE_GATE'`)까지 잡아야 한다 — 모양을
    // 바꾸는 것만으로 검사를 빠져나갈 수 있으면 검사가 아니다.
    const re = /blocked:[^\n]*/g;
    let m;
    while ((m = re.exec(scalpSrc))) {
      if (!(wb >= 0 && m.index > wb)) continue;
      // 비교 대상(`x === 'FILLED'`)은 차단 코드가 아니다 — 값 자리만 본다.
      const valueSide = m[0].replace(/[=!]==?\s*'[A-Z_]+'/g, '');
      for (const q of valueSide.matchAll(/'([A-Z][A-Z_]{2,})'/g)) seen.add(q[1]);
    }
    for (const codeName of seen) {
      if (!POST_WRITE_ALLOWED.has(codeName)) {
        err(`${SCALP}: 거래소 쓰기 뒤에 등록되지 않은 차단 '${codeName}'이 있습니다`
          + ' — 이 사유로 막힐 요청은 계좌 설정을 먼저 바꿉니다.'
          + ' 쓰기 앞으로 옮기거나, 옮길 수 없는 이유를 POST_WRITE_ALLOWED에 적으세요');
      }
    }
    // 목록이 낡는 것도 막는다. 앞으로 옮겼는데 목록에 남아 있으면,
    // 다음 사람이 "이건 못 옮긴다"고 잘못 읽는다.
    for (const codeName of POST_WRITE_ALLOWED.keys()) {
      if (!seen.has(codeName)) {
        err(`${SCALP}: POST_WRITE_ALLOWED의 '${codeName}'이 쓰기 뒤에 없습니다`
          + ' — 옮겼거나 사라졌으면 목록에서도 지우세요');
      }
    }
  }

  // 모드↔연결 판정이 권한 안에 있는가 (라우트에 남아 있으면 순서가 갈린다)
  if (/blocked:\s*'MODE_CONN_MISMATCH'/.test(scalpSrc)) {
    err(`${SCALP}: 모드↔연결 판정이 라우트에 따로 남아 있습니다`
      + ' — 권한 판정과 두 곳으로 갈립니다');
  }
}

// ── 거래소를 건드리는 의존이 전부 분류돼 있는가 ──
//
// 지금은 배율 설정 하나뿐이지만, 새 쓰기가 붙었는데 분류되지 않으면
// 통합 카운터 밖으로 샌다.
{
  const es = read(ENTRY);
  const ifaceR = (es.match(/export interface Entry100xReadDeps \{([\s\S]*?)\n\}/) || [])[1] || '';
  const ifaceW = (es.match(/export interface Entry100xWriteDeps \{([\s\S]*?)\n\}/) || [])[1] || '';
  const iface = `${ifaceR}\n${ifaceW}`;
  const keys = Array.from(iface.matchAll(/^\s{2}(\w+)\s*[(:]/gm)).map(m => m[1]);
  const listed = (es.match(/MUTATING_DEPS\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
  const listedRo = (es.match(/READONLY_DEPS\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
  const all = `${listed} ${listedRo}`;
  if (keys.length === 0) err(`${ENTRY}: Entry100xReadDeps/WriteDeps의 칸을 읽지 못했습니다`);
  for (const k of keys) {
    if (!all.includes(`'${k}'`)) {
      err(`${ENTRY}: 의존 ${k}가 읽기/쓰기 어느 목록에도 없습니다`
        + ' — 새 거래소 쓰기가 통합 카운터 밖으로 샙니다');
    }
  }
  if (!/'applyLeverage'/.test(listed)) {
    err(`${ENTRY}: MUTATING_DEPS에 applyLeverage가 없습니다`);
  }
}

// ─────────────────────────────────────────────────────────────
// ⑤ 손절과 익절은 다른 축인가
// ─────────────────────────────────────────────────────────────
//
// 예전에는 `protectionPolicy: 'NONE'` 하나가 둘을 함께 껐고, 그 자리에서
// 두 거래소가 이미 갈려 있었다 — 바이낸스 익절은 policy를 보지 않아서
// 그대로 나갔고 Gate는 막혔다. 같은 계약이 거래소마다 다르게 실행됐다.
{
  const ex = code(EXEC);
  if (!/const noFixedTp = args\.takeProfitPolicy === 'NO_FIXED_TP'/.test(ex)) {
    err(`${EXEC}: 익절 정책이 별도 축으로 들어오지 않습니다`);
  }
  // 두 거래소가 **같은 값**을 본다.
  // 개수만 세면 한 자리를 `false`로 바꿔도 다른 자리 덕에 통과한다.
  // **각 자리를 따로** 본다.
  //
  // 바이낸스 익절 가지는 원래 정책을 보지 않았다 — 그래서 Gate와 갈렸다.
  // 그 가지가 `noFixedTp`를 실제로 보는지 확인한다.
  const binanceTpBranch = /\} else if \(noFixedTp\) \{/.test(ex);
  if (!binanceTpBranch) {
    err(`${EXEC}: 바이낸스 익절 가지가 익절 정책을 보지 않습니다`
      + ' — 여기가 Gate와 갈렸던 자리입니다');
  }
  if (/if \(!args\.reduceOnly && policy !== 'NONE' && tpSpec\)/.test(ex)) {
    err(`${EXEC}: Gate 익절이 아직 손절 정책(policy)으로 막힙니다`
      + ' — 손절만 없는 전략을 표현할 수 없고 바이낸스와 갈립니다');
  }
  if (!/noFixedTp && args\.takeProfit != null/.test(ex)) {
    err(`${EXEC}: 익절 정책과 익절가가 함께 온 모순을 막지 않습니다`);
  }
  // scalp 호출부: 손절과 익절을 **따로** 뺀다
  if (!/epStopPolicy === 'NO_FIXED_SL' \? \{\} : \{ stopLoss/.test(scalpSrc)) {
    err(`${SCALP}: 손절만 따로 빼지 않습니다`);
  }
  if (!/epTakeProfitPolicy === 'NO_FIXED_TP' \? \{\} : \{ takeProfit/.test(scalpSrc)) {
    err(`${SCALP}: 익절을 손절 정책으로 함께 빼고 있습니다`);
  }
  if (!/takeProfitPolicy:\s*epTakeProfitPolicy/.test(scalpSrc)) {
    err(`${SCALP}: executeOrder에 익절 정책을 넘기지 않습니다`);
  }
}

// ── 화면도 같은 조합을 지키는가 ──
//
// 서버가 막아도 화면이 다른 전략으로 저장하게 두면, 사용자는 저장은 됐는데
// 켜지지 않는 예약을 갖게 되고 이유를 알 수 없다. 그리고 화면이 전략을
// 몰래 scalp로 바꿔 저장하면 **고른 적 없는 전략이 도는 것**이라 더 나쁘다.
const ui = code(UI);
if (!ui) err(`${UI}을(를) 읽지 못했습니다`);
else {
  const save = ui.slice(ui.indexOf('const saveX100'), ui.indexOf('const saveX100') + 1400);
  if (!/strategyId\s*!==\s*'scalp'/.test(save)) {
    err(`${UI}: saveX100이 전략을 확인하지 않습니다`
      + ' — 계약을 해석하지 않는 전략으로 100X 예약이 저장됩니다');
  }
  if (/strategyId:\s*'scalp'/.test(save)) {
    err(`${UI}: saveX100이 전략을 scalp로 바꿔 저장합니다`
      + ' — 사용자가 고른 적 없는 전략이 도는 것이라 더 나쁩니다');
  }
  const row = ui.slice(ui.indexOf('const x100Row'), ui.indexOf('const x100Row') + 600);
  if (!/strategy_id\s*===\s*'scalp'/.test(row)) {
    err(`${UI}: x100Row가 전략을 보지 않습니다`
      + ' — 켤 수 없는 예약을 "전용 100배로 저장됨"으로 그립니다');
  }
  for (const [re, what] of [
    [/execution_profile_id\s*===\s*'MAX_LEV_100X'/, '프로필'],
    [/execution_preset_id\s*===\s*'EXACT_100X'/, '프리셋'],
    [/execution_contract_version\s*\)?\s*===\s*2/, '계약 버전'],
    [/mode[^\n]*===\s*'TESTNET'/, '운영 모드'],
  ]) {
    if (!re.test(row)) {
      err(`${UI}: x100Row가 저장된 ${what}을(를) 보지 않습니다`
        + ' — 켤 수 없는 행을 "정상 저장됨"으로 그립니다');
    }
  }
}

// 계약을 해석하지 않는 라우트는 계약을 **받지도** 않아야 한다
for (const f of ['src/app/api/autotrade/daily-ladder/route.ts',
                 'src/app/api/autotrade/my-original-v1/route.ts']) {
  const src = code(f);
  if (!src) { err(`${f}을(를) 읽지 못했습니다`); continue; }
  if (/prepareEntry100x/.test(src)) continue;   // 배선됐으면 이 규칙 대상이 아니다
  if (!/carriesExecutionContract\s*\(/.test(src)) {
    err(`${f}: 실행 계약을 해석하지 않으면서 거절도 하지 않습니다`
      + ' — 계약을 실은 직접 요청이 자기 방식으로 실행됩니다');
  }
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

// ─────────────────────────────────────────────────────────────
// ③ production 체인이 실제로 닫혀 있는가
// ─────────────────────────────────────────────────────────────
//
// **여기가 이 검사기의 핵심이다.** `planSize100x`·`planEntry100x`가
// 시험과 검사기에서만 불리면, 계약은 초록인데 실제 주문은 그 경로를
// 타지 않는다 — "만들어 놓고 배선을 안 함"의 정확한 형태다.
//
// 그래서 **제품 코드에서 부르는 곳이 있는지**를 센다. 시험·검사기는
// 세지 않는다.
const PRODUCTION_GLOBS = ['src/app', 'src/lib', 'src/components', 'worker/src'];

const walk = (dir, out = []) => {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
};
const productionFiles = PRODUCTION_GLOBS.flatMap(d => walk(d));
const callers = (needle, exclude = []) => productionFiles.filter(f =>
  !exclude.includes(f) && stripJsComments(readFileSync(f, 'utf8')).includes(needle));

for (const [needle, home, what] of [
  ['prepareEntry100x(', ENTRY, '100X 진입 준비'],
  ['commitEntry100x(', ENTRY, '100X 진입 확정'],
  ['stopPolicyOfContract(', PLAN, '계약 → 손절 정책'],
  ['sizingPolicyOfContract(', PLAN, '계약 → 사이징 정책'],
]) {
  const found = callers(needle, [home]);
  if (found.length === 0) {
    err(`${what}(${needle.replace('(', '')})를 제품 코드에서 부르는 곳이 0건입니다`
      + ' — 시험과 검사기만 부르면 계약은 초록인데 실제 주문은 그 경로를 타지 않습니다');
  }
}
// `planSize100x`는 `entry100x`가 부른다. 그 자체가 제품 배선이므로,
// 진입 계획이 실제로 호출되는지를 위에서 확인한 것으로 충분하다.
// 다만 진입 계획이 그것을 정말 쓰는지는 여기서 본다 — 안 쓰면 크기를
// 어디선가 다시 만들고 있다는 뜻이다.
if (!code(ENTRY).includes('planSize100x(')) {
  err(`${ENTRY}: planSize100x를 부르지 않습니다 — 크기 계산이 복제됐습니다`);
}

// 진입 라우트가 계약대로 갈라지는가
// **분기 여는 줄 그대로** 본다. 문자열이 어딘가 있기만 하면 통과하게
// 두면, 그 분기를 `if (false)`로 눕혀도 다른 자리의 같은 문자열 때문에
// 초록이 된다 — 실제로 그렇게 새 나갔다.
if (!scalpSrc.includes("if (epSizingPolicy === 'MARGIN_ALLOCATION') {")) {
  err(`${SCALP}: 사이징 정책으로 갈라지지 않습니다 — planPosition을 우회하지 않습니다`);
}
// **두 자리를 각각 본다.** 파일 전체에서 이름을 찾으면 한쪽이 사라져도
// 다른 쪽 때문에 통과한다 — 이 저장소에서 반복된 false-green의 형태다.
const blockAfter = (src, needle, span = 1600) => {
  const i = src.indexOf(needle);
  return i < 0 ? '' : src.slice(i, i + span);
};
const execCall = blockAfter(scalpSrc, 'executeOrder(sb, {');
if (!execCall) err(`${SCALP}: executeOrder 호출을 찾지 못했습니다`);
else if (!/stopPolicy:\s*epStopPolicy/.test(execCall)) {
  err(`${SCALP}: executeOrder에 stopPolicy를 넘기지 않습니다`
    + ' — 계약이 장부(live_orders.stop_policy)까지 닿지 않습니다');
}
if (!/epStopPolicy\s*===\s*'NO_FIXED_SL'\s*\n?\s*\?\s*\{\}/.test(scalpSrc)
    && !/epStopPolicy === 'NO_FIXED_SL'[\s\S]{0,80}\?\s*\{\}/.test(scalpSrc)) {
  err(`${SCALP}: 고정 손절 없는 계약에서도 stopLoss를 함께 보냅니다`
    + ' — executeOrder가 그 조합을 모순으로 보고 거부합니다');
}
const clCall = blockAfter(scalpSrc, 'runChecklist(checkInput', 500);
if (!clCall) err(`${SCALP}: runChecklist 호출을 찾지 못했습니다`);
else if (!/stopPolicy:\s*epStopPolicy/.test(clCall)) {
  err(`${SCALP}: 체크리스트에 stopPolicy를 넘기지 않습니다 — 손절 항목이 N/A로 빠지지 않습니다`);
}

// 예약의 배정 비율이 라우트까지 실려 가는가
// 인터페이스에 이름만 남아도 통과하면 안 된다. **본문에 싣는 대입**을 본다.
if (!/body\.marginAllocationPct\s*=/.test(code(RUNREQ))) {
  err(`${RUNREQ}: 예약의 증거금 배정 비율을 요청 본문에 싣지 않습니다`
    + ' — 타입에 이름만 있고 값이 라우트까지 가지 않습니다');
}
if (!/marginAllocationPct/.test(code(RUNNER))) {
  err(`${RUNNER}: 예약 줄의 margin_allocation_pct를 읽지 않습니다`);
}

// 워커 SET_TPSL — **생산자가 아직 없다.**
//
// `enqueueJob`을 부르는 제품 코드가 0건이라 SET_TPSL 잡을 만드는 곳이
// 없다. 그래서 "생산자가 stopPolicy를 싣는지"는 지금 증명할 대상이
// 아니다. 대신 **생산자가 생기는 날 CI가 요구하도록** 규칙만 걸어 둔다.
const tpslProducers = productionFiles.filter(f => {
  if (f === WORKER) return false;
  const src = stripJsComments(readFileSync(f, 'utf8'));
  return /action:\s*'SET_TPSL'/.test(src);
});
for (const f of tpslProducers) {
  const src = stripJsComments(readFileSync(f, 'utf8'));
  if (!/stopPolicy/.test(src)) {
    err(`${f}: SET_TPSL 잡을 만들면서 stopPolicy를 payload에 싣지 않습니다`
      + ' — 워커는 live_orders를 읽지 않으므로 잡에 실려 와야 압니다');
  }
}

// DB 제약과 코드 표가 갈리지 않는가
const migOpen = read(MIG_OPEN).replace(/--[^\n]*/g, '');
if (!migOpen) err(`${MIG_OPEN}이 없습니다 — L1이 전면 금지인 채로 남습니다`);
else {
  if (!/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+autotrade_schedules_execution_profile_dormant/i.test(migOpen)) {
    err(`${MIG_OPEN}: 옛 전면 금지 제약을 떼지 않습니다`);
  }
  if (/DROP\s+CONSTRAINT[^;]*execution_profile_complete/i.test(migOpen)) {
    err(`${MIG_OPEN}: _complete 제약을 떼고 있습니다 — 반쪽 선택은 지금도 선택이 아닙니다`);
  }
  for (const need of [ID, PRESET, "strategy_id = 'scalp'", "mode = 'TESTNET'",
                      'margin_allocation_pct IS NOT NULL']) {
    if (!migOpen.includes(need)) {
      err(`${MIG_OPEN}: 제약에 ${need}가 없습니다 — DB와 코드 표가 갈립니다`);
    }
  }
  if (/'LIVE'/.test(migOpen)) err(`${MIG_OPEN}: 제약이 LIVE를 허용합니다`);
}
const migAlloc = read(MIG_ALLOC).replace(/--[^\n]*/g, '');
if (!migAlloc) err(`${MIG_ALLOC}이 없습니다 — 배정 비율을 저장할 칸이 없습니다`);
else if (!/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+margin_allocation_pct/i.test(migAlloc)) {
  err(`${MIG_ALLOC}: margin_allocation_pct 칸을 더하지 않습니다`);
}

// 저장 라우트가 화면 기본값을 물려주지 않는가
const schedSrc = code(SCHED);
if (!/marginAllocationPct/.test(schedSrc)) {
  err(`${SCHED}: 증거금 배정 비율을 받지 않습니다`);
}
if (/margin_allocation_pct:\s*(marginPct|body\?\.marginPct|body\.marginPct)/.test(schedSrc)) {
  err(`${SCHED}: 화면 기본값 marginPct를 배정 비율로 상속합니다`
    + ' — 사용자가 고른 적 없는 크기로 100배가 나갑니다');
}

// ─────────────────────────────────────────────────────────────
// ⑫ PR-E — 안전하게 나갈 수 없는 계좌에는 들어가지 않는다
// ─────────────────────────────────────────────────────────────
//
// 불변식: CAN_AUTO_ENTER requires CAN_AUTO_EXIT_SAFELY
//
// #281이 종료를 fail-closed로 만들면서 "열 수는 있는데 자동으로 닫을 수는
// 없는" 비대칭이 생겼다. 이 관문이 그걸 막는다. 새는 방식은 전부 조용하다 —
// 관문을 지워도, 조건을 뒤집어도, 쓰기 뒤로 옮겨도 화면에는 아무 일도 안
// 일어난다. 그래서 **정책을 실제로 부르고**(동작) **순서를 함께 본다**(배선).
const SAFETY = 'src/lib/engine/entryExitSafety.ts';
const VPO    = 'src/lib/engine/venuePositionOps.ts';
{
  // ── ⑫-a 정책을 컴파일해서 실제로 부른다 ──
  //
  //   글자가 아니라 답을 본다. `if (false)`로 바꾸거나 `ok`만 보게
  //   고치면 여기서 잡힌다.
  const sm = await loadModule(SAFETY, '진입 전 종료 안전 정책');
  if (!sm || typeof sm.entryExitSafetyVerdict !== 'function') {
    err(`${SAFETY}: entryExitSafetyVerdict가 없습니다 — 진입 전 종료 안전 판정이 없습니다`);
  } else {
    const V = sm.entryExitSafetyVerdict;
    const safe = { ok: true, code: 'ONE_WAY', strandsOpenPosition: false, message: '단방향' };
    if (V(safe)?.allowed !== true) err('진입 전 종료 안전: 단방향 계좌인데 진입이 막혔습니다');

    for (const [ev, why] of [
      [{ ok: false, code: 'HEDGE_UNVERIFIED', strandsOpenPosition: true, message: 'h' }, '양방향'],
      [{ ok: false, code: 'UNKNOWN', strandsOpenPosition: true, message: 'u' }, '모드 못 읽음'],
      [{ ok: false, code: 'NO_DIRECTION', strandsOpenPosition: true, message: 'n' }, '방향 모름'],
      [null, '증거 없음'],
      [undefined, '증거 undefined'],
      [{}, '빈 증거'],
      // ★ `ok === true`를 `ok !== false`로 무르게 바꾸는 회귀는 **여기서만**
      //   잡힌다. 증거가 통째로 없는 판(`{}`·null)은 `strandsOpenPosition`
      //   쪽에서 어차피 막혀 동치가 되기 때문이다. 갇히지 않는다고 적혀
      //   있는데 `ok`만 빠진 판이 그 둘을 가른다.
      [{ code: 'X', strandsOpenPosition: false, message: 'm' }, 'ok가 없음'],
      [{ ok: null, code: 'X', strandsOpenPosition: false, message: 'm' }, 'ok가 null'],
      [{ ok: 'yes', code: 'X', strandsOpenPosition: false, message: 'm' }, 'ok가 참 같은 글자'],
      // ★ `ok`만 보는 회귀를 잡는 자리. 오늘 정본에서는 나오지 않는
      //   조합이라 시험이 없으면 조용히 샌다.
      [{ ok: true, code: 'ONE_WAY', strandsOpenPosition: true, message: 'x' }, '통과인데 갇힘'],
    ]) {
      const r = V(ev);
      if (r?.allowed !== false) {
        err(`진입 전 종료 안전: ${why}인데 진입이 허용됩니다`
          + ' — 자동으로 닫지 못하는 계좌에 새 포지션이 열립니다');
      }
      if (r && r.code !== 'AUTO_EXIT_UNSAFE') {
        err(`진입 전 종료 안전: ${why}의 코드가 ${r.code}입니다 — AUTO_EXIT_UNSAFE여야 합니다`);
      }
    }

    // 사유가 응답까지 살아 가는가. 코드만 남고 문구가 사라지면 운영자는
    // 무엇을 고쳐야 하는지 모른다.
    const kept = V({ ok: false, code: 'HEDGE_UNVERIFIED', strandsOpenPosition: true,
      message: '양방향 규격 미확정' });
    if (kept?.evidence?.code !== 'HEDGE_UNVERIFIED'
      || !String(kept?.reason || '').includes('양방향 규격 미확정')) {
      err('진입 전 종료 안전: 정본의 코드·사유가 응답까지 전달되지 않습니다');
    }

    // ★ 이 정책이 모드를 **다시 해석하지 않는가.** 정본이 통과시키면
    //   코드 이름과 무관하게 통과해야 한다 — 여기에 HEDGE 분기가 생기면
    //   진입과 종료가 서로 다른 답을 내는 두 번째 정본이 된다.
    const future = V({ ok: true, code: 'HEDGE_VERIFIED', strandsOpenPosition: false, message: 'v' });
    if (future?.allowed !== true) {
      err(`${SAFETY}: 정본이 통과시킨 판을 코드 이름으로 다시 막습니다`
        + ' — 종료 판정이 두 곳이 됩니다');
    }
  }

  // 정책 파일이 모드를 직접 해석하지 않는가 (글자로도 한 번 더)
  {
    const src = code(SAFETY);
    for (const needle of ['positionModeVerdict', 'futuresPositionMode', "'HEDGE'", '"HEDGE"']) {
      if (src.includes(needle)) {
        err(`${SAFETY}가 ${needle}를 직접 봅니다`
          + ' — 종료 가능 판정의 정본은 closeModeVerdict 하나입니다');
      }
    }
  }

  // ── ⑫-b 라우트가 정본을 부르는가 ──
  const sc = code(SCALP);
  const iSafety = sc.indexOf('entryExitSafetyVerdict(');
  const iGate   = sc.indexOf('closeModeGate(');
  const iCommit = sc.indexOf('commitEntry100x(\n');
  const iLev    = sc.indexOf('ensureLeverage(');
  const iExec   = sc.indexOf('executeOrder(sb');
  const iClaim  = sc.indexOf('claimSignal(');

  if (iGate < 0) {
    err(`${SCALP}: closeModeGate를 부르지 않습니다`
      + ' — 자동으로 닫지 못하는 계좌에 새 포지션이 열립니다');
  }
  if (iSafety < 0) {
    err(`${SCALP}: entryExitSafetyVerdict를 부르지 않습니다 — 관문이 배선되지 않았습니다`);
  }
  // 종료 가능 판정을 **독자적으로** 다시 하지 않는가.
  //
  //   ★ 호출 모양(`(`)만 보면 샌다 — `void positionModeVerdict;`처럼
  //     들여놓기만 해도 다음 사람이 그걸 쓴다. 이 라우트는 진입용
  //     모드 판정을 **아예 쓰지 않으므로** 이름 자체를 들이지 않는다.
  if (/\bpositionModeVerdict\b/.test(sc)) {
    err(`${SCALP}이 진입용 positionModeVerdict를 들입니다`
      + ' — 종료 가능 여부의 정본은 closeModeGate 하나입니다'
      + ' (진입은 되는데 종료는 안 되는 두 번째 판정이 됩니다)');
  }

  // ── ⑫-b2 판정을 실제로 쓰는가 ──
  //
  //   `entryExitSafetyVerdict`를 부르고 결과를 버리면 관문은 **있는데
  //   없는 것**이 된다. 호출이 있는지가 아니라 **차단 가지가 판정에
  //   달려 있는지**를 본다.
  if (iSafety >= 0) {
    const tail = sc.slice(iSafety, iSafety + 900);
    const branch = /if\s*\(\s*!\s*(\w+)\.allowed\s*\)\s*\{/.exec(tail);
    if (!branch) {
      err(`${SCALP}: 종료 안전 판정으로 분기하지 않습니다`
        + ' — 판정을 부르고 결과를 버리면 관문이 없는 것과 같습니다');
    } else {
      // 그 가지가 정말 **막는가** — 409로 돌아가야 한다.
      const body = tail.slice(branch.index, branch.index + 500);
      if (!/return\s+NextResponse\.json\(/.test(body)) {
        err(`${SCALP}: 종료 안전 차단 가지가 응답을 돌려주지 않습니다 — 그대로 진행됩니다`);
      }
      if (!/blocked:\s*'AUTO_EXIT_UNSAFE'/.test(body)) {
        err(`${SCALP}: 차단 사유를 AUTO_EXIT_UNSAFE로 적지 않습니다`
          + ' — 화면이 왜 막혔는지 말할 수 없습니다');
      }
      if (!/executed:\s*false/.test(body)) {
        err(`${SCALP}: 종료 안전 차단 응답이 executed:false를 적지 않습니다`);
      }
    }
    // 조건을 상수로 바꿔 끄는 회귀.
    if (/if\s*\(\s*(false|true)\s*\)\s*\{[\s\S]{0,300}?AUTO_EXIT_UNSAFE/.test(sc)) {
      err(`${SCALP}: 종료 안전 차단이 상수 조건에 묶여 있습니다`);
    }
  }

  // ── ⑫-c 차단이 거래소 쓰기보다 앞인가 ──
  //
  //   막힐 요청이 배율·마진을 먼저 바꾸면 "주문은 안 나갔다"가 위로가
  //   되지 않는다 — 계좌 설정이 이미 바뀌었고 그 자리에 포지션이 있으면
  //   청산가가 함께 움직인다.
  if (iSafety >= 0) {
    for (const [i, what] of [
      [iCommit, '배율 확정(commitEntry100x)'],
      [iLev, '배율 동기화 쓰기(ensureLeverage)'],
      [iExec, '주문 제출(executeOrder)'],
    ]) {
      if (i >= 0 && !(iSafety < i)) {
        err(`${SCALP}: 종료 안전 관문이 ${what}보다 뒤입니다`
          + ' — 자동으로 닫지 못할 계좌에 설정이 나가거나 주문이 나갑니다');
      }
    }
    if (iGate >= 0 && !(iGate < iCommit || iCommit < 0)) {
      err(`${SCALP}: closeModeGate 조회가 배율 확정보다 뒤입니다`);
    }
    // 멱등 표식을 태우지 않는가 — 진입도 안 했는데 그 봉이 잠기면
    // 같은 봉의 정당한 재시도가 막힌다.
    if (iClaim >= 0 && !(iSafety < iClaim)) {
      err(`${SCALP}: 종료 안전 관문이 중복 신호 claim보다 뒤입니다`
        + ' — 막힌 회차가 그 봉의 멱등 표식을 태웁니다');
    }
  }

  // ── ⑫-d 방향을 짐작하지 않는가 ──
  //
  //   `plan.side`를 `'SHORT' ? 'SHORT' : 'LONG'`으로 좁히면 방향을 못
  //   읽은 경우가 조용히 LONG이 되고 정본의 NO_DIRECTION이 영원히 안
  //   나온다. 짐작해서 닫으면 반대 방향 신규 진입이다.
  if (iGate >= 0) {
    const call = sc.slice(iGate, iGate + 400);
    if (/closeModeGate\([^)]*,\s*['"](LONG|SHORT)['"]\s*\)/.test(call)
      || /sideForClose\s*=\s*['"](LONG|SHORT)['"]/.test(sc)) {
      err(`${SCALP}: closeModeGate에 방향을 글자로 박아 넘깁니다`
        + ' — 반대 방향으로 신규 진입이 될 수 있습니다');
    }
    if (!/plan\.side/.test(sc.slice(Math.max(0, iGate - 700), iGate + 400))) {
      err(`${SCALP}: closeModeGate에 plan.side를 넘기지 않습니다`);
    }
    if (/plan\.side\s*===\s*'SHORT'\s*\?\s*'SHORT'\s*:\s*'LONG'/.test(
      sc.slice(Math.max(0, iGate - 700), iGate + 400))) {
      err(`${SCALP}: 종료 방향을 LONG으로 좁혀 넘깁니다`
        + ' — 방향을 못 읽은 경우(NO_DIRECTION)가 조용히 통과합니다');
    }
  }

  // ── ⑫-e 계약이 없는 legacy 경로까지 막지 않는가 ──
  //
  //   이 PR은 열려 있는 execution-contract 경로에만 건다. epContract가
  //   없던 예전 scalp의 행동은 바꾸지 않는다.
  if (iSafety >= 0) {
    const before = sc.slice(Math.max(0, iSafety - 1400), iSafety);
    if (!/if\s*\(\s*epContract\s*\)/.test(before)) {
      err(`${SCALP}: 종료 안전 관문이 epContract 조건 안에 있지 않습니다`
        + ' — 계약이 없던 예전 경로의 행동까지 바뀝니다');
    }
  }

  // ── ⑫-f 관문이 거래소 상태를 바꾸지 않는가 ──
  //
  //   확인하려고 모드를 바꾸거나 시험 주문을 보내면, 안전을 확인하는
  //   행위 자체가 계좌를 건드린다.
  if (iSafety >= 0) {
    const win = sc.slice(Math.max(0, iSafety - 1600), iSafety + 600);
    for (const [re, what] of [
      [/futuresSetPositionMode|setPositionMode\s*\(/, '포지션 모드 변경'],
      [/closeSymbolPosition\s*\(/, '포지션 강제 청산'],
      [/reduceOnly\s*:\s*true/, 'reduceOnly 시험 주문'],
      [/futuresSetLeverage\s*\(/, '배율 쓰기'],
    ]) {
      if (re.test(win)) {
        err(`${SCALP}: 종료 안전 관문 주변에서 ${what}을(를) 합니다`
          + ' — 확인하는 행위가 계좌를 바꿉니다');
      }
    }
  }

  // ── ⑫-g 정본 closeModeGate가 그대로인가 (#281 의미 회귀) ──
  {
    const vp = code(VPO);
    if (!/export async function closeModeGate/.test(vp)) {
      err(`${VPO}: closeModeGate가 없습니다 — 종료 가능 판정의 정본이 사라졌습니다`);
    }
    if (!/closeModeVerdict\s*\(/.test(vp)) {
      err(`${VPO}: closeModeGate가 closeModeVerdict를 쓰지 않습니다`);
    }
    // ★ 이름이 있는지가 아니라 **어디서 온 값인지**를 본다.
    //   `strandsOpenPosition: false`로 박아 두면 이름은 그대로 남고
    //   진입 관문은 영원히 "안 갇힌다"만 본다 — 가장 조용한 회귀다.
    const gate = vp.slice(vp.indexOf('export async function closeModeGate'),
      vp.indexOf('export async function closeModeGate') + 900);
    if (!/strandsOpenPosition:\s*v\.strandsOpenPosition/.test(gate)) {
      err(`${VPO}: closeModeGate가 갇힘 여부를 판정(v)에서 가져오지 않습니다`
        + ' — 값을 박아 두면 진입 관문이 영원히 "안 갇힌다"만 봅니다');
    }
    if (/strandsOpenPosition:\s*(true|false)\b/.test(gate)) {
      err(`${VPO}: closeModeGate가 갇힘 여부를 상수로 적습니다`);
    }
    for (const f of ['ok: v.ok', 'code: v.code', 'message: v.message']) {
      if (!gate.includes(f)) {
        err(`${VPO}: closeModeGate가 ${f}를 판정에서 그대로 전달하지 않습니다`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// ⑬ PR1 — 고정 손절 없는 주문: 인식은 하되 관리하지 않는다
// ─────────────────────────────────────────────────────────────
//
// 지금까지 `NO_FIXED_SL` 주문이 일반 생명주기에 안 들어간 것은 정책
// 때문이 아니라 **우연**이었다 — 손절 값이 없어 `NO_STOP`으로 걸러졌을
// 뿐이다. 참고용 값이 한 번 채워지면 그 우연은 끝나고, 그 포지션은
// highWater·6시간 시간청산·본전이동·트레일링·MOVE_STOP·CLOSE를 받는다.
//
// 그리고 줄 하나를 빼는 것만으로는 부족하다 — 거래소 선물은 net position
// 이라, 같은 자리의 다른 줄을 관리하면 그 노출까지 같이 움직인다.
const CAND    = 'src/lib/engine/managedPosition.ts';
const MONITOR = 'src/app/api/autotrade/exit-monitor/route.ts';
const REATT   = 'src/lib/engine/stopReattach.ts';
{
  // ── ⑬-a 분류 정본을 컴파일해서 실제로 돌린다 ──
  const cm = await loadModule(CAND, '감시 후보 정본');
  if (!cm || typeof cm.managedCandidates !== 'function' || typeof cm.mayActOn !== 'function') {
    err(`${CAND}: managedCandidates / mayActOn이 없습니다`);
  } else {
    const T = '2026-08-27T09:00:00.000Z';
    const row = (o = {}) => ({
      id: 'ord-1', connection_id: 'conn-bn', exchange: 'binance',
      symbol: 'BTCUSDT', side: 'BUY', avg_price: 100, stop_loss: 90,
      status: 'FILLED', reduce_only: false, acked_at: T,
      signal_id: '[s:scalp]sig-1', ...o,
    });
    const run = rows => cm.managedCandidates(rows);
    const codes = r => r.deferred.map(d => d.code);

    // 고정 손절 주문은 평소대로 관리된다 (과잉 차단 방지)
    {
      const r = run([row({ stop_policy: 'FIXED_SL' })]);
      if (r.positions.length !== 1 || !cm.mayActOn(r.positions[0])) {
        err('감시 후보: 고정 손절 주문이 관리에서 빠졌습니다 — 과잉 차단입니다');
      }
    }
    // 정책이 안 적힌 옛 줄은 기존대로 관리된다
    {
      const r = run([row({})]);
      if (r.positions.length !== 1 || !cm.mayActOn(r.positions[0])) {
        err('감시 후보: stop_policy가 없는 legacy 줄을 막았습니다'
          + ' — 기존 고정 손절 전략이 통째로 관리에서 빠집니다');
      }
    }
    // ★ 고정 손절 없는 주문은 손절 값이 있든 없든 관리하지 않는다
    for (const [sl, want] of [[null, 'NO_FIXED_SL_EXIT_UNWIRED'],
                              [90, 'NO_FIXED_SL_STOP_CONFLICT']]) {
      const r = run([row({ stop_policy: 'NO_FIXED_SL', stop_loss: sl })]);
      if (r.positions.length !== 0) {
        err(`감시 후보: NO_FIXED_SL(손절 ${sl === null ? '없음' : '있음'}) 주문이`
          + ' 일반 생명주기에 들어갔습니다');
      }
      if (!codes(r).includes(want)) {
        err(`감시 후보: ${want} 유예 기록이 없습니다 — 인식했다는 증거가 사라집니다`);
      }
    }
    // 유예를 "손절 없음"으로 뭉개지 않는다
    {
      const r = run([row({ stop_policy: 'NO_FIXED_SL', stop_loss: null })]);
      if ((r.skipped || []).some(x => x.code === 'NO_STOP')) {
        err('감시 후보: 정책상 유예를 NO_STOP으로 적었습니다 — 고칠 것이 없는데 고치려 듭니다');
      }
      const d = r.deferred[0] || {};
      for (const f of ['connectionId', 'symbol', 'side', 'strategyId', 'orderId']) {
        if (d[f] === undefined) err(`감시 후보: 유예 기록에 ${f}가 없습니다 — 추적이 끊깁니다`);
      }
    }
    // 고정 손절인데 값이 없으면 legacy NO_STOP으로 숨기지 않는다
    {
      const r = run([row({ stop_policy: 'FIXED_SL', stop_loss: null })]);
      if (!codes(r).includes('FIXED_SL_MISSING_STOP')) {
        err('감시 후보: FIXED_SL인데 손절이 없는 상태를 NO_STOP으로 숨깁니다');
      }
    }
    // 모르는 정책을 고정 손절로 읽지 않는다
    {
      const r = run([row({ stop_policy: 'WAT', stop_loss: 90 })]);
      if (r.positions.length !== 0 || !codes(r).includes('STOP_POLICY_UNKNOWN')) {
        err('감시 후보: 모르는 손절 정책을 추측해서 관리합니다');
      }
    }

    // ── ★★ net position 자리 — 이 PR의 핵심 ──
    //
    //   ① 다른 전략이 섞인 자리: 걸러진 줄이 **자리 주장에도 남아야**
    //      소유권이 모호해진다. 분류가 주장보다 앞서면 조용히 OWNED가 된다.
    {
      const r = run([
        row({ id: 'a', stop_policy: 'NO_FIXED_SL', stop_loss: null, signal_id: '[s:scalp]a' }),
        row({ id: 'b', stop_policy: 'FIXED_SL', stop_loss: 90, signal_id: '[s:my-original-v1]b' }),
      ]);
      const p = r.positions[0];
      if (!p) err('감시 후보: 혼재 자리에서 고정 손절 줄이 통째로 사라졌습니다');
      else {
        if (cm.mayActOn(p)) {
          err('감시 후보: 고정 손절 없는 줄을 버린 덕에 다른 전략 줄이 관리 가능해졌습니다'
            + ' — 같은 net position이라 그쪽 노출까지 건드립니다');
        }
        if (p.ownership?.code !== 'OWNERSHIP_AMBIGUOUS') {
          err('감시 후보: 걸러진 줄이 자리 주장에서도 사라졌습니다'
            + ' — 관리 가능 여부가 소유권을 조용히 바꿉니다');
        }
      }
    }
    //   ② ★ 같은 전략이 섞인 자리: 주장자가 하나뿐이라 **소유권은 OWNED다.**
    //      소유권만으로는 못 막는다 — 관리 판정이 따로 있어야 한다.
    {
      const r = run([
        row({ id: 'a', stop_policy: 'NO_FIXED_SL', stop_loss: null, signal_id: '[s:scalp]a' }),
        row({ id: 'b', stop_policy: 'FIXED_SL', stop_loss: 90, signal_id: '[s:scalp]b' }),
      ]);
      const p = r.positions[0];
      if (!p) err('감시 후보: 같은 전략 혼재 자리에서 고정 손절 줄이 사라졌습니다');
      else if (cm.mayActOn(p)) {
        err('감시 후보: 같은 전략의 혼재 자리를 관리합니다'
          + ' — 정책이 다른 노출을 분리할 수 없는데 net position을 건드립니다');
      }
    }
    //   ③ ★ 고정 손절을 쓴다면서 값이 없는 줄도 같은 자리를 막는다.
    //      막는 **이유**는 다르지만(일부러 안 건다 vs 걸기로 해 놓고 없다)
    //      결과는 같다 — 둘 다 관리할 수 없는 노출이고, net position에서
    //      수량을 나눌 수 없다.
    for (const same of [true, false]) {
      const r = run([
        row({ id: 'a', stop_policy: 'FIXED_SL', stop_loss: null, signal_id: '[s:scalp]a' }),
        row({ id: 'b', stop_policy: 'FIXED_SL', stop_loss: 90,
              signal_id: same ? '[s:scalp]b' : '[s:my-original-v1]b' }),
      ]);
      const p = r.positions[0];
      if (!p) { err('감시 후보: 손절 누락 혼재 자리에서 정상 줄이 사라졌습니다'); continue; }
      if (cm.mayActOn(p)) {
        err(`감시 후보: 손절 누락 줄과 ${same ? '같은' : '다른'} 전략이 섞인 자리를 관리합니다`
          + ' — 계약이 깨진 노출까지 닫거나 손절을 옮깁니다');
      }
      if (same && p.management?.code === 'MANAGED') {
        err('감시 후보: 같은 전략 혼재 자리가 MANAGED로 승격했습니다');
      }
    }
    // 자리 유예 코드가 **상위 개념 이름**인가. `NO_FIXED_SL_...`이라는
    // 이름으로 손절 누락까지 막으면 동작은 맞는데 이름이 거짓말을 한다.
    {
      const r = run([
        row({ id: 'a', stop_policy: 'FIXED_SL', stop_loss: null }),
        row({ id: 'b', stop_policy: 'FIXED_SL', stop_loss: 90 }),
      ]);
      const mg = r.positions[0]?.management || {};
      if (mg.code !== 'UNMANAGED_SEAT_DEFERRED') {
        err(`감시 후보: 자리 유예 코드가 ${mg.code}입니다`
          + ' — 손절 누락까지 막는 상태에 NO_FIXED_SL 전용 이름을 쓰면 이름이 거짓말합니다');
      }
      // 왜 막혔는지(root cause)가 남아 있는가 — 줄 유예와 자리 유예는 다른 질문이다.
      if (!String(mg.reason || '').includes('FIXED_SL_MISSING_STOP')) {
        err('감시 후보: 자리가 막힌 진짜 이유가 사유에 없습니다');
      }
    }
    //   ④ ★ 자리를 막는 사유는 **다섯**이다
    //
    //      원칙: 일반 생명주기가 관리할 수 없는 줄이 같은 net-position
    //      자리에 하나라도 있으면 그 자리를 건드리지 않는다. 막는 이유와
    //      줄의 관측 의미는 제각각이지만 **결과는 같다.**
    const SEAT_BLOCKERS = [
      [{ stop_policy: 'NO_FIXED_SL', stop_loss: null }, 'NO_FIXED_SL_EXIT_UNWIRED'],
      [{ stop_policy: 'NO_FIXED_SL', stop_loss: 95 }, 'NO_FIXED_SL_STOP_CONFLICT'],
      [{ stop_policy: 'FIXED_SL', stop_loss: null }, 'FIXED_SL_MISSING_STOP'],
      [{ stop_policy: 'WAT', stop_loss: 90 }, 'STOP_POLICY_UNKNOWN'],
      [{ stop_loss: null }, 'NO_STOP'],
    ];
    for (const [bad, blocker] of SEAT_BLOCKERS) {
      for (const same of [true, false]) {
        const r = run([
          row({ id: 'a', signal_id: '[s:scalp]a', ...bad }),
          row({ id: 'b', stop_policy: 'FIXED_SL', stop_loss: 90,
                signal_id: same ? '[s:scalp]b' : '[s:my-original-v1]b' }),
        ]);
        const p = r.positions.find(x => x.orderId === 'b');
        if (!p) { err(`감시 후보: ${blocker} 혼재 자리에서 정상 줄이 사라졌습니다`); continue; }
        if (cm.mayActOn(p)) {
          err(`감시 후보: ${blocker}가 있는 자리를 관리합니다`
            + ` (${same ? '같은' : '다른'} 전략 혼재)`
            + ' — 관리할 수 없는 노출까지 닫거나 손절을 옮깁니다');
        }
        if (same && !String(p.management?.reason || '').includes(blocker)) {
          err(`감시 후보: 자리가 막힌 이유(${blocker})가 사유에 없습니다`);
        }
      }
      // 과잉 차단 방지 — 자리가 다르면 영향이 없어야 한다
      for (const [over, what] of [
        [{ connection_id: 'conn-OTHER' }, '다른 계좌'],
        [{ symbol: 'ETHUSDT' }, '다른 종목'],
      ]) {
        const r = run([
          row({ id: 'a', ...bad }),
          row({ id: 'b', stop_policy: 'FIXED_SL', stop_loss: 90, ...over }),
        ]);
        const p = r.positions.find(x => x.orderId === 'b');
        if (!p || !cm.mayActOn(p)) {
          err(`감시 후보: ${blocker}가 ${what}까지 막았습니다 — 과잉 차단입니다`);
        }
      }
    }
    // ★ 자리를 막아도 **줄의 관측 의미는 그대로다.**
    {
      const r = run([row({ stop_loss: null })]);
      if (!(r.skipped || []).some(x => x.code === 'NO_STOP')) {
        err('감시 후보: NO_STOP이 대상 아님 목록에서 사라졌습니다');
      }
      if ((r.deferred || []).length !== 0) {
        err('감시 후보: 옛 줄(NO_STOP)을 유예로 옮겼습니다'
          + ' — 운영자가 새로 생긴 문제로 읽습니다');
      }
      const u = run([row({ stop_policy: 'WAT', stop_loss: 90 })]);
      if (!codes(u).includes('STOP_POLICY_UNKNOWN')) {
        err('감시 후보: 모르는 정책이 유예 목록에서 사라졌습니다');
      }
    }
    // 범위 고정 — 체결 시각 없음까지 넓히지 않았다
    {
      const r = run([
        row({ id: 'a', acked_at: null }),
        row({ id: 'b', stop_policy: 'FIXED_SL', stop_loss: 90 }),
      ]);
      const p = r.positions.find(x => x.orderId === 'b');
      if (!p || !cm.mayActOn(p)) {
        err('감시 후보: NO_ENTRY_TIME까지 자리 차단으로 넓혔습니다 — 별도 판단이 필요합니다');
      }
    }

    //   ⑤ 과잉 차단 방지 — 다른 계좌·다른 종목은 영향이 없어야 한다
    for (const [over, what] of [
      [{ connection_id: 'conn-OTHER' }, '다른 계좌'],
      [{ symbol: 'ETHUSDT' }, '다른 종목'],
    ]) {
      const r = run([
        row({ id: 'a', stop_policy: 'NO_FIXED_SL', stop_loss: null }),
        row({ id: 'b', stop_policy: 'FIXED_SL', stop_loss: 90, ...over }),
      ]);
      const p = r.positions[0];
      if (!p || !cm.mayActOn(p)) err(`감시 후보: ${what}까지 유예시켰습니다 — 과잉 차단입니다`);
    }
    // 관리 판정이 빠진 옛 모양 객체가 유예를 우회하지 않는가
    if (cm.mayActOn({ ownership: { code: 'OWNED', reason: '', claimants: [] } })) {
      err(`${CAND}: 관리 판정이 없는 객체를 통과시킵니다 — 유예를 우회하는 길이 열립니다`);
    }
  }

  // ── ⑬-b 감시 라우트가 정책 칸을 읽는가 ──
  const mon = code(MONITOR);
  {
    // ★ 조회 모양은 이제 `lifecycleRows`에 있다(090 미적용 후퇴 때문에
    //   두 벌이 필요해졌다). 라우트가 아니라 그 정본을 본다.
    //
    //   **두 모양 다** 손절 정책을 읽어야 한다 — 후퇴가 `stop_policy`를
    //   버리면 NO_FIXED_SL 주문이 일반 생명주기로 들어간다(PR1이 막은 고장).
    const rowsSrc = code('src/lib/engine/lifecycleRows.ts');
    const sel = rowsSrc;
    if (!/LIFECYCLE_SELECT_IDENTITY/.test(rowsSrc) || !/LIFECYCLE_SELECT_LEGACY/.test(rowsSrc)) {
      err('src/lib/engine/lifecycleRows.ts: 조회 모양 정본을 찾지 못했습니다 — 검사가 헛돕니다');
    }
    // ★ **선언 하나만** 본다. 넉넉히 잘라 두면 다음 선언까지 창에 들어와,
    //   앞 선언에서 지운 낱말이 뒤 선언에 남아 있어 검사가 통과한다.
    const declOf = (name) => {
      const at = rowsSrc.indexOf(`export const ${name}`);
      if (at < 0) return '';
      const end = rowsSrc.indexOf(';', at);
      return end < 0 ? rowsSrc.slice(at) : rowsSrc.slice(at, end);
    };
    for (const name of ['LIFECYCLE_SELECT_IDENTITY', 'LIFECYCLE_SELECT_LEGACY']) {
      const body = declOf(name);
      if (!body) { err(`${name} 선언을 찾지 못했습니다 — 검사가 헛돕니다`); continue; }
      if (!/stop_policy/.test(body)) {
        err(`${name}이 stop_policy를 읽지 않습니다`
          + ' — 고정 손절 없는 주문과 "값이 아직 안 적힌 주문"이 구별되지 않습니다');
      }
    }
    // 없는 칼럼을 읽으면 조회 전체가 실패한다 (PostgREST)
    if (/select\([^)]*strategy_id/.test(sel)) {
      err(`${MONITOR}: live_orders에 없는 strategy_id를 projection합니다 — 조회가 통째로 실패합니다`);
    }
  }

  // ── ⑬-c 유예가 실행 반복문에 **도달할 수 없는가** ──
  //
  //   반복문 안에서 뒤늦게 거르면 그때는 이미 거래소를 읽은 뒤다.
  //   구조로 막혔는지를 본다 — `deferred`가 반복문 안에 없어야 한다.
  {
    if (!/const \{ positions, deferred, skipped, authorityCandidates \} = managedCandidates\(/.test(mon)) {
      err(`${MONITOR}: managedCandidates의 유예·전용권한 목록을 받지 않습니다`);
    }
    const iLoop = mon.indexOf('for (const p of positions) {');
    const iEnd = mon.indexOf('const unknown = out.results.filter');
    if (iLoop < 0 || iEnd < 0 || !(iLoop < iEnd)) {
      err(`${MONITOR}: 생명주기 반복문을 찾지 못했습니다 — 검사가 헛돕니다`);
    } else {
      const body = mon.slice(iLoop, iEnd);
      // ★ **목록을 쓰는가**를 본다. `deferred: true` 같은 결과 표시는
      //   막을 이유가 없다 — 낱말을 금지하면 정직한 표기까지 막힌다.
      if (/\bdeferred\s*\.|of\s+deferred\b|deferred\s*\[/.test(body)) {
        err(`${MONITOR}: 유예 목록이 실행 반복문 안에서 쓰입니다`
          + ' — 거래소를 읽은 뒤에 거르게 됩니다');
      }
      // 거래소를 건드리는 단계가 전부 이 반복문 **안**에 있는가.
      // 밖으로 새면 유예와 무관하게 불린다.
      // ★★ 실행 권한 관문이 **반복문 맨 앞**에 있는가.
      //
      //   mayActOn은 ownership + management의 SSOT다. 둘 중 하나라도
      //   막혔으면 거래소를 읽을 이유도, 권한도 없다.
      //
      //   특히 OWNER_UNKNOWN 수동 주문이 삭제된 옛 connection_id를
      //   가리키는 경우, 이 관문이 credsOf보다 뒤면 실제 주문 권한은
      //   0인데 NO_CONNECTION만 발생해 회차 전체가 거짓 FAILED가 된다.
      {
        const iGate = body.search(/if\s*\(\s*!mayActOn\(p\)\s*\)/);
        if (iGate < 0) {
          err(`${MONITOR}: 실행 권한 관문(mayActOn)이 반복문 앞에 없습니다`
            + ' — 소유권 불명·관리 유예 노출이 venue 조회까지 내려갑니다');
        } else {
          // ★ **고정 크기 창으로 보지 않는다.**
          //
          //   예전에는 `body.slice(iGate, iGate + 1400)`에 `continue;`가
          //   있는지만 봤다. 그런데 이 검사기는 주석을 지운 소스를 보므로
          //   관문 블록이 675자로 줄고, 1400자 창이 **다음 블록까지** 닿아
          //   거기 있는 `continue;`로 통과했다. 관문의 `continue;`를 지워도
          //   초록이었다 — MUT-P23이 그렇게 새 나갔다.
          //
          //   관문 블록의 중괄호를 세서 **그 블록 안**만 본다.
          const gOpen = body.indexOf('{', iGate);
          let depth = 0;
          let gEnd = -1;
          for (let k = gOpen; k >= 0 && k < body.length; k += 1) {
            if (body[k] === '{') depth += 1;
            else if (body[k] === '}') { depth -= 1; if (depth === 0) { gEnd = k; break; } }
          }
          if (gOpen < 0 || gEnd < 0) {
            err(`${MONITOR}: 실행 권한 관문 블록의 범위를 찾지 못했습니다`);
          } else if (!/continue;/.test(body.slice(iGate, gEnd + 1))) {
            err(`${MONITOR}: 실행 권한 관문이 회차를 끊지 않습니다`
              + ' — 기록만 남기고 진행하면 유예된 자리가 거래소를 읽고 건드립니다');
          }
          for (const needle of ['credsOf(', 'readOpenPosition(', 'highWaterSince(',
            'liveStopPrice(', 'lifecycleDecide(', 'guard.claim(', 'applyLifecycleClose(',
            'moveStopSafely(']) {
            const at = body.indexOf(needle);
            if (at >= 0 && !(iGate < at)) {
              err(`${MONITOR}: 실행 권한 관문이 ${needle}보다 뒤입니다`
                + ' — 소유권 불명·유예 노출을 조회하거나 건드립니다');
            }
          }
        }
      }

      // ★ **정의가 아니라 호출이 반복문 안에 있는가.** `credsOf`처럼
      //   위에서 선언되고 안에서 불리는 것이 있어서, 첫 출현 위치로
      //   판단하면 멀쩡한 배선을 밖에 있다고 잘못 읽는다.
      for (const needle of ['credsOf(', 'readOpenPosition(', 'highWaterSince(',
        'liveStopPrice(', 'lifecycleDecide(', 'guard.claim(', 'applyLifecycleClose(',
        'moveStopSafely(']) {
        if (!body.includes(needle)) {
          err(`${MONITOR}: ${needle} 호출이 후보 반복문 안에 없습니다`
            + ' — 유예와 무관하게 불리거나 배선이 끊겼습니다');
        }
      }
    }
    // 유예를 telemetry로 내보내는가 (숫자만 줄이고 사실을 감추지 않는가)
    if (!/out\.deferred\s*=\s*deferred/.test(mon) || !/deferredCount/.test(mon)) {
      err(`${MONITOR}: 유예를 응답에 내보내지 않습니다 — 관찰할 수 없는 상태가 됩니다`);
    }
    if (!/관리 유예/.test(read(MONITOR))) {
      err(`${MONITOR}: 요약에 관리 유예 건수를 적지 않습니다`);
    }
  }

  // ── ⑬-d 유예를 시스템 실패로 세지 않는가 ──
  //
  //   "일부러 관리하지 않음"과 "실행이 실패함"은 다른 상태다.
  {
    const om = await loadModule('src/lib/engine/exitRunOutcome.ts', '회차 결과 정본');
    if (om && typeof om.collectLifecycleFailures === 'function') {
      const f = om.collectLifecycleFailures({
        error: null, results: [],
        deferred: [{ code: 'NO_FIXED_SL_EXIT_UNWIRED', symbol: 'BTCUSDT', reason: 'x' }],
        deferredCount: 1,
      });
      if ((f || []).length !== 0) {
        err('회차 결과: 의도된 관리 유예를 시스템 실패로 셉니다'
          + ' — 정상 회차가 빨간불이 됩니다');
      }
    }
  }

  // ── ⑬-d2 정상 0-action 회차도 RUNNING으로 남기지 않는가 ──
  //
  //   실패일 때만 closeRun을 부르면 실패를 고친 순간 정상 회차가 열린
  //   상태로 영구히 남는다. 실제 worker 실측에서 그대로 드러났다.
  {
    const iEarly = mon.indexOf('const earlyOutcome = exitRunOutcome');
    const iBranch = mon.indexOf('if (dryRun || actionable.length === 0)', iEarly);
    const iReturn = mon.indexOf('return NextResponse.json({', iBranch);
    const early = iBranch >= 0 && iReturn > iBranch ? mon.slice(iBranch, iReturn) : '';
    if (!early) {
      err(`${MONITOR}: 0-action 조기 반환 구간을 찾지 못했습니다`);
    } else {
      if (!/if\s*\(\s*!dryRun\s*\)\s*\{[\s\S]*?await\s+closeRun\s*\(\s*\{/m.test(early)) {
        err(`${MONITOR}: 실제 0-action 회차를 closeRun으로 닫지 않습니다`
          + ' — 정상 회차가 RUNNING으로 영구히 남습니다');
      }
      if (!/status:\s*earlyOutcome\.status/.test(early)) {
        err(`${MONITOR}: 조기 종료 상태를 exitRunOutcome 정본에서 가져오지 않습니다`
          + ' — 응답과 exit_monitor_runs가 다른 진실을 말할 수 있습니다');
      }
      if (/!earlyOutcome\.ok/.test(early)) {
        err(`${MONITOR}: 실패일 때만 회차를 닫습니다`
          + ' — 정상 0-action 회차가 RUNNING으로 남습니다');
      }
      const iClose = early.indexOf('await closeRun(');
      if (iClose < 0) {
        err(`${MONITOR}: 조기 반환 전에 closeRun 호출이 없습니다`);
      }
    }
  }

  // ── ⑬-e 뒤늦게 막는 구조로 바뀌지 않았는가 ──
  //
  //   `exitLifecycle`에서 걸러도 그때는 venue read가 끝난 뒤다. 기존
  //   레거시 안전망(NO_FIXED_STOP)은 **그대로 두고**, 그것이 유일한
  //   방어가 되지 않았는지만 본다.
  {
    const life = code('src/lib/engine/exitLifecycle.ts');
    if (!/NO_FIXED_STOP/.test(life)) {
      err('exitLifecycle: 레거시 NO_FIXED_STOP 안전망이 사라졌습니다 — 삭제 금지입니다');
    }
    if (/stop_policy|NO_FIXED_SL/.test(life)) {
      err('exitLifecycle이 stop_policy를 직접 봅니다'
        + ' — 진입 자체를 막지 않고 뒤늦게 거르는 구조입니다 (venue read가 이미 일어납니다)');
    }
  }

  // ── ⑬-f 손절 재부착 정본이 그대로인가 ──
  {
    const ra = code(REATT);
    if (!/NO_FIXED_SL/.test(ra)) {
      err(`${REATT}: NO_FIXED_SL 불변식이 사라졌습니다`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// ⑭ PR2 — 어느 계약으로 연 주문인지 장부에 적는다 (적기만 한다)
// ─────────────────────────────────────────────────────────────
//
// 이 칸이 없던 동안 PR-E와 PR1은 둘 다 "identity가 없으니 정책만 보고
// 판단한다"로 우회했다. 이제 장부가 직접 말한다.
//
// ★ 그런데 **말할 뿐 판단하지 않는다.** identity가 생기면 "Exact100X면
//   이렇게 하자"가 자연스러워 보이기 시작하고, 그 분기가 전용 종료 권한
//   설계보다 먼저 생긴다. 아래 ⑭-d가 그것을 막는다.
const MIG_IDENT = 'supabase/migrations/090_live_orders_execution_identity.sql';
const EXECUTOR  = 'src/lib/engine/orderExecutor.ts';
{
  // ── ⑭-a 마이그레이션이 세 칸과 완전성 제약을 둔다 ──
  const mi = read(MIG_IDENT).replace(/--[^\n]*/g, '');
  if (!mi) err(`${MIG_IDENT}이 없습니다 — 실행 계약을 적을 칸이 없습니다`);
  else {
    for (const col of ['execution_profile_id', 'execution_preset_id',
      'execution_contract_version']) {
      if (!new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${col}`, 'i').test(mi)) {
        err(`${MIG_IDENT}: ${col} 칸을 더하지 않습니다`);
      }
    }
    // 반쪽 기록을 DB에서도 막는가 (077의 `_complete`와 같은 규칙)
    if (!/live_orders_execution_identity_complete/.test(mi)
      || !/CHECK\s*\(/i.test(mi)) {
      err(`${MIG_IDENT}: 세 칸 완전성 제약이 없습니다`
        + ' — 반쪽이 저장되면 읽는 쪽이 나머지를 추측하게 됩니다');
    }
    // **백필하지 않는다** — 이미 쌓인 행에 "그때 이 계약이었다"는 거짓 기록
    if (/UPDATE\s+public\.live_orders/i.test(mi) || /\bSET\s+execution_/i.test(mi)
      || /DEFAULT\s+'/i.test(mi)) {
      err(`${MIG_IDENT}: 기존 행에 계약을 채웁니다 — 없던 기록을 지어냅니다`);
    }
    // ★ `IS NOT NULL`은 완전성 제약의 정상적인 일부다. 낱말이 아니라
    //   **칼럼을 NOT NULL로 만드는 모양**만 막는다.
    if (/ADD\s+COLUMN[^;]*?\bNOT\s+NULL/i.test(mi) || /SET\s+NOT\s+NULL/i.test(mi)) {
      err(`${MIG_IDENT}: 칸을 NOT NULL로 만듭니다 — 기록이 없는 옛 행이 전부 막힙니다`);
    }
  }

  // ── ⑭-b 온전함의 기준이 **하나**인가 ──
  //
  //   적는 쪽과 읽는 쪽이 따로 세면 반쪽이 저장되고 반쪽이 읽힌다.
  const pm = await loadModule(PLAN, '실행 계약 정본');
  if (!pm || typeof pm.executionIdentityComplete !== 'function') {
    err(`${PLAN}: executionIdentityComplete 정본이 없습니다`);
  } else {
    const C = pm.executionIdentityComplete;
    if (C({ profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 }) !== true) {
      err('실행 계약 식별자: 온전한 세 칸을 반쪽으로 판정합니다');
    }
    for (const [x, why] of [
      [null, '없음'], [undefined, 'undefined'], [{}, '빈 값'],
      [{ presetId: 'EXACT_100X', contractVersion: 2 }, '프로필 없음'],
      [{ profileId: 'MAX_LEV_100X', contractVersion: 2 }, '프리셋 없음'],
      [{ profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X' }, '버전 없음'],
      [{ profileId: '  ', presetId: 'EXACT_100X', contractVersion: 2 }, '프로필 공백'],
      [{ profileId: 'A', presetId: 'B', contractVersion: 'x' }, '버전이 숫자가 아님'],
    ]) {
      if (C(x) !== false) err(`실행 계약 식별자: ${why}인데 온전하다고 합니다`);
    }
    // 글자로 온 버전은 받아들인다 (DB 드라이버가 문자열을 줄 수 있다)
    if (C({ profileId: 'A', presetId: 'B', contractVersion: '2' }) !== true) {
      err('실행 계약 식별자: 글자로 온 버전을 거부합니다 — DB 드라이버 차이로 기록이 끊깁니다');
    }
  }
  // 읽는 쪽이 자기만의 완전성 판정을 다시 만들지 않는가
  {
    const cd = code(CAND);
    if (!/executionIdentityComplete/.test(cd)) {
      err(`${CAND}: 온전함을 계약 정본에 묻지 않고 따로 판정합니다`
        + ' — 적는 쪽과 기준이 갈립니다');
    }
  }

  // ── ⑭-c 적는 쪽 배선 ──
  {
    const ex = code(EXECUTOR);
    for (const col of ['execution_profile_id', 'execution_preset_id',
      'execution_contract_version']) {
      if (!ex.includes(col)) err(`${EXECUTOR}: ${col}을 장부에 적지 않습니다`);
    }
    // **조건부여야 한다** — 항상 붙이면 090 이전 DB에서 모든 주문이 실패한다
    if (!/\.\.\.\(ident\s*\?\s*\{/.test(ex)) {
      err(`${EXECUTOR}: 실행 계약 칸을 조건 없이 붙입니다`
        + ' — 090가 아직인 DB에서 기존 경로의 주문까지 전부 실패합니다');
    }
    // ★ 온전함을 **정본에 묻는가.** `!!ident`처럼 자기가 세면 적는 쪽과
    //   읽는 쪽의 기준이 갈리고, 반쪽이 저장된다.
    if (!/identOk\s*=\s*executionIdentityComplete\(/.test(ex)) {
      err(`${EXECUTOR}: 식별자의 온전함을 계약 정본에 묻지 않습니다`
        + ' — 적는 쪽과 읽는 쪽의 기준이 갈립니다');
    }
    // 반쪽이면 **보내기 전에** 멈추는가
    if (!/if\s*\(ident\s*&&\s*!identOk\)/.test(ex)) {
      err(`${EXECUTOR}: 반쪽 식별자를 그대로 저장합니다`
        + ' — 호출부의 계약 조립 오류는 경계에서 거절해야 합니다.'
        + ' DB 제약은 마지막 방어선이지 응용 검증의 대체물이 아닙니다'
        + ' (제약이 없는 배포에서는 반쪽이 그대로 저장됩니다)');
    }
    // ★ 지키려는 것은 "insert보다 앞"이 **아니다.**
    //
    //   반쪽 식별자가 있으면 **어떤 거래소 부수효과도 일어나기 전에**
    //   거절해야 한다. insert만 기준으로 삼으면, guard를 거래소 쓰기
    //   뒤로 옮겨도 insert보다는 앞이라 통과한다.
    //
    //   동작 증명은 `orderExecutorIdentity.test.ts`가 호출 횟수 0으로
    //   한다. 여기서는 **순서**를 함께 못박는다.
    const iGuard = ex.search(/if\s*\(ident\s*&&\s*!identOk\)/);
    if (iGuard < 0) {
      err(`${EXECUTOR}: 반쪽 식별자 관문을 찾지 못했습니다 — 검사가 헛돕니다`);
    } else {
      for (const [needle, what] of [
        ["from('live_orders').insert(", '장부 기록'],
        ['futuresApplyLeverage(', '배율 설정(거래소 쓰기)'],
        ['setLeverageGateFutures(', 'Gate 배율·마진 설정(거래소 쓰기)'],
        ['placeFuturesOrder(', 'Binance 주문 전송'],
        ['createOrderGateFutures(', 'Gate 주문 전송'],
      ]) {
        const at = ex.indexOf(needle);
        if (at < 0) continue;   // 그 경로가 없는 배포도 있다
        if (!(iGuard < at)) {
          err(`${EXECUTOR}: 반쪽 식별자 관문이 ${what}보다 뒤입니다`
            + ' — 계약 조립 오류가 계좌를 먼저 건드립니다');
        }
      }
    }
    // 호출부: 계약이 있을 때만 넘긴다
    const sc = code(SCALP);
    if (!/executionIdentity:\s*\{/.test(sc)) {
      err(`${SCALP}: 실행 계약 식별자를 주문에 넘기지 않습니다`);
    }
    if (!/\.\.\.\(epContract\s*\?\s*\{\s*executionIdentity/.test(sc)) {
      err(`${SCALP}: 계약이 없는 경로에도 식별자를 넘깁니다 — 옛 경로의 동작이 바뀝니다`);
    }
    for (const f of ['epContract.profileId', 'epContract.presetId', 'epContract.contractVersion']) {
      if (!sc.includes(f)) err(`${SCALP}: ${f}를 넘기지 않습니다`);
    }
    // 읽는 쪽: 감시 라우트가 세 칸을 projection하는가
    // identity 모양이 세 칸을 읽는가 (후퇴 모양은 읽지 **않아야** 한다)
    const rowsSrc2 = code('src/lib/engine/lifecycleRows.ts');
    const atId = rowsSrc2.indexOf('export const LIFECYCLE_SELECT_IDENTITY');
    const endId = atId < 0 ? -1 : rowsSrc2.indexOf(';', atId);
    const idSel = atId < 0 ? '' : rowsSrc2.slice(atId, endId < 0 ? undefined : endId);
    for (const col of ['execution_profile_id', 'execution_preset_id',
      'execution_contract_version']) {
      if (!idSel.includes(col)) {
        err(`LIFECYCLE_SELECT_IDENTITY가 ${col}을 읽지 않습니다`
          + ' — identity가 언제나 null이 됩니다');
      }
    }
  }

  // ── ⑭-c2 DB가 코드보다 뒤처져도 회차가 죽지 않는가 ──
  //
  //   090가 아직인 DB에 코드가 먼저 닿으면, 새 칸을 넣은 조회를 PostgREST가
  //   통째로 거절한다. 그때 회차가 끝나면 **이미 열린 포지션의 청산·보호·
  //   복구가 함께 멈춘다** — `migrationStatus`의 불변식과 정면으로 충돌한다.
  {
    const ROWS = 'src/lib/engine/lifecycleRows.ts';
    const lr = await loadModule(ROWS, '주문 장부 읽기 정본');
    if (!lr || typeof lr.loadLifecycleRows !== 'function') {
      err(`${ROWS}: loadLifecycleRows가 없습니다 — 090 미적용에서 회차가 죽습니다`);
    } else {
      const miss = c => ({ code: '42703', message: `column live_orders.${c} does not exist` });
      // ① 칸이 다 있으면 한 번에 읽는다 (멀쩡한데 두 번 읽지 않는다)
      {
        const calls = [];
        const r = await lr.loadLifecycleRows(async sel => { calls.push(sel); return { data: [{ id: 'a' }], error: null }; });
        if (r.projection !== 'RISK' || calls.length !== 1) {
          err('주문 장부 읽기: 칸이 다 있는데 한 번에 읽지 않습니다'
            + ` (${r.projection} · ${calls.length}회)`);
        }
      }
      // ①-b ★ 091만 아직일 때 **계약 칸을 함께 잃지 않는다**
      //
      //   여기서 LEGACY로 내려가면 실행 계약 세 칸이 사라지고 이미 검증된
      //   ⑤A의 4시간 TIME_EXIT이 멈춘다. 새 위험 기록이 없다는 이유로
      //   되는 종료까지 죽이는 것은 후퇴가 아니라 고장이다.
      {
        const calls = [];
        const r = await lr.loadLifecycleRows(async sel => {
          calls.push(sel);
          return calls.length === 1
            ? { data: null, error: miss('entry_adverse_distance_pct') }
            : { data: [{ id: 'a' }], error: null };
        });
        if (r.error || r.projection !== 'IDENTITY' || calls.length !== 2) {
          err('주문 장부 읽기: 091이 아직일 때 한 단계가 아니라 통째로 후퇴합니다'
            + ` (${r.projection} · ${calls.length}회) — 실행 계약을 잃어 TIME_EXIT이 멈춥니다`);
        }
        for (const c of (lr.IDENTITY_COLUMNS || [])) {
          if (!String(calls[1] || '').includes(c)) {
            err(`주문 장부 읽기: 091 후퇴 모양에서 ${c}가 사라졌습니다`);
          }
        }
        for (const c of (lr.RISK_SNAPSHOT_COLUMNS || [])) {
          if (String(calls[1] || '').includes(c)) {
            err(`주문 장부 읽기: 091 후퇴 모양에 ${c}가 남아 있습니다 — 또 실패합니다`);
          }
        }
      }
      // ② 090 칸이 없으면 옛 모양으로 살린다
      {
        const calls = [];
        const r = await lr.loadLifecycleRows(async sel => {
          calls.push(sel);
          return calls.length <= 2
            ? { data: null, error: miss('execution_profile_id') }
            : { data: [{ id: 'a' }], error: null };
        });
        if (r.error || r.projection !== 'LEGACY' || r.rows.length !== 1) {
          err('주문 장부 읽기: 090가 아직이라고 회차를 죽입니다'
            + ' — 이미 열린 포지션의 청산·보호·복구가 멈춥니다');
        }
        if (calls.length !== 3) {
          err(`주문 장부 읽기: 후퇴가 한 단계씩이 아닙니다 (${calls.length}회)`);
        }
        const last = String(calls[calls.length - 1] || '');
        for (const c of [...(lr.IDENTITY_COLUMNS || []), ...(lr.RISK_SNAPSHOT_COLUMNS || [])]) {
          if (last.includes(c)) {
            err(`주문 장부 읽기: 후퇴 모양에 ${c}가 남아 있습니다 — 또 실패합니다`);
          }
        }
        // 후퇴가 조용한 기능 축소가 되지 않는가
        if (!last.includes('stop_policy')) {
          err('주문 장부 읽기: 후퇴가 stop_policy까지 버립니다'
            + ' — NO_FIXED_SL 주문이 일반 생명주기로 들어갑니다');
        }
      }
      // ③ ★ 다른 오류는 후퇴하지 않는다
      for (const [e, why] of [
        [{ code: '42501', message: 'permission denied' }, '권한'],
        [{ message: 'fetch failed' }, '연결'],
        [{ code: '42703', message: 'column live_orders.strategy_id does not exist' }, '다른 칼럼'],
      ]) {
        const calls = [];
        const r = await lr.loadLifecycleRows(async sel => { calls.push(sel); return { data: null, error: e }; });
        if (r.projection !== null || !r.error || calls.length !== 1) {
          err(`주문 장부 읽기: ${why} 오류를 "090 미적용"으로 읽고 후퇴합니다`
            + ' — 진짜 고장이 정상 회차로 덮입니다');
        }
      }
      // ④ 후퇴로 읽은 줄에 identity를 지어내지 않는가
      {
        const cm3 = await loadModule(CAND, '감시 후보 정본');
        const legacyRow = {
          id: 'a', connection_id: 'c', exchange: 'binance', symbol: 'BTCUSDT',
          side: 'BUY', avg_price: 100, stop_loss: 90, status: 'FILLED',
          reduce_only: false, acked_at: '2026-08-27T09:00:00.000Z',
          signal_id: '[s:scalp]s', stop_policy: 'FIXED_SL',
        };
        const got = cm3?.managedCandidates?.([legacyRow]);
        if (got && got.positions[0]?.executionIdentity !== null) {
          err('감시 후보: 계약 칸이 없는 줄에 identity를 만들어 냅니다');
        }
        if (got && !cm3.mayActOn(got.positions[0])) {
          err('감시 후보: 후퇴 상태에서 기존 고정 손절 포지션을 관리하지 않습니다');
        }
      }
    }
    // 라우트가 그 정본을 실제로 쓰는가 (직접 select를 다시 짜지 않는가)
    const mon3 = code(MONITOR);
    // ★ 이름이 있는지가 아니라 **정본에서 가져오는지**를 본다. 같은 이름의
    //   지역 함수를 만들어 두면 이름만 보는 검사는 그대로 통과한다.
    if (!/(import|require)\([^)]*lifecycleRows[^)]*\)/.test(mon3)
      || !/\{\s*loadLifecycleRows\s*\}/.test(mon3)) {
      err(`${MONITOR}: 주문 장부를 정본(lifecycleRows)에서 읽지 않습니다`
        + ' — 후퇴 경로가 사라집니다');
    }
    // ★ **대입**을 본다. `out.projection === 'LEGACY'` 같은 비교는
    //   `=`로 시작해서 느슨한 정규식에 걸린다 — 지워도 통과해 버린다.
    if (!/out\.projection\s*=\s*loaded\.projection/.test(mon3)) {
      err(`${MONITOR}: 어떤 모양으로 읽었는지 남기지 않습니다`
        + ' — "기록이 없는 주문"과 "칸을 못 읽은 회차"가 같아 보입니다');
    }
  }

  // ── ⑭-d ★★ identity가 **일반 생명주기 분류를 바꾸지 않는다** ──
  //
  //   원래 규칙은 "identity로 아예 분기하지 마라"였다. 그 이유는 적혀
  //   있었다 — *"무엇을 할지는 전용 종료 권한을 설계하는 다음 단계의
  //   일이다."* 그 단계가 ⑤다. 이제 전용 권한은 identity로 계약의 보유
  //   한도를 찾아야 하므로 분기가 **필요하다.**
  //
  //   그래서 규칙을 지우지 않고 **좁힌다.** 지켜야 할 성질은 처음부터
  //   "분기 금지"가 아니라 이것이었다:
  //
  //     identity가 있든 없든 **`positions`·`deferred`·`skipped`는 같다.**
  //     identity는 전용 권한 목록(`authorityCandidates`)만 바꾼다.
  //
  //   정규식은 그 성질의 대리물이었고 지금은 거짓 경보를 낸다. 성질
  //   자체를 아래에서 **돌려서** 검사한다. 정규식은 분류기 정본 함수
  //   (`seatExitCapabilities`) 밖에서만 유지한다 — 그 함수가 바로
  //   "이 계약에 무엇이 열려 있는가"를 정하는 자리다.
  {
    /** 능력 분류기 본문은 예외다. 그 함수의 일이 바로 identity 판단이다 */
    const withoutCapabilityFn = (src) => {
      const at = src.indexOf('export function seatExitCapabilities(');
      if (at < 0) {
        // 정본 함수가 사라졌으면 **검사가 눈머는 것이 아니라 실패한다.**
        err(`${CAND}: seatExitCapabilities가 없습니다 — 능력 분류 정본이 사라졌습니다`);
        return src;
      }
      // 함수의 끝은 **열 0의 닫는 중괄호 한 줄**이다(`\n}\n`).
      //
      // `indexOf('\n}')`만 쓰면 인자 객체 타입의 닫는 줄(`}): {`)에 먼저
      // 걸려 범위가 짧게 잘리고, 그러면 예외가 적용되지 않아 거짓 경보가
      // 난다(실제로 그렇게 틀렸다). 그 줄은 뒤에 `)`가 붙으므로 개행이
      // 바로 오는 것만 고르면 구별된다.
      const end = src.indexOf('\n}\n', at);
      if (end < 0) {
        err(`${CAND}: seatExitCapabilities의 끝을 찾지 못했습니다 — 예외 범위를 정할 수 없습니다`);
        return src;
      }
      return src.slice(0, at) + src.slice(end + 3);
    };
    for (const [f, src0] of [[CAND, code(CAND)], [MONITOR, code(MONITOR)]]) {
      const src = f === CAND ? withoutCapabilityFn(src0) : src0;
      // identity 값을 조건으로 쓰는 모양
      for (const re of [
        /executionIdentity\??\.\w+\s*===/,
        /executionIdentity\??\.\w+\s*!==/,
        /if\s*\([^)]*executionIdentity[^)]*\)\s*\{[\s\S]{0,200}?(return|continue|throw)/,
      ]) {
        if (re.test(src)) {
          err(`${f}: 실행 계약 identity로 분기합니다 (${re})`
            + ' — 이 단계는 적고 보여 줄 뿐입니다. 무엇을 할지는 전용 종료 권한의 일입니다');
        }
      }
      // 프로필·프리셋 이름을 값으로 비교하는 모양
      for (const lit of [`'${ID}'`, `'${PRESET}'`]) {
        if (src.includes(lit)) {
          err(`${f}가 ${lit}을 직접 비교합니다`
            + ' — identity는 사실로 들고 다닐 뿐 판단 기준이 아닙니다');
        }
      }
    }
    // 동작으로도 확인한다 — identity가 무엇이든 분류가 같은가
    const cm2 = await loadModule(CAND, '감시 후보 정본');
    if (cm2 && typeof cm2.managedCandidates === 'function') {
      const T = '2026-08-27T09:00:00.000Z';
      const base = o => ({
        id: 'ord-1', connection_id: 'conn-bn', exchange: 'binance',
        symbol: 'BTCUSDT', side: 'BUY', avg_price: 100, status: 'FILLED',
        reduce_only: false, acked_at: T, signal_id: '[s:scalp]s', ...o,
      });
      const IDENT = {
        execution_profile_id: ID, execution_preset_id: PRESET,
        execution_contract_version: 2,
      };
      for (const c of [
        { stop_policy: 'FIXED_SL', stop_loss: 90 },
        { stop_policy: 'NO_FIXED_SL', stop_loss: null },
        { stop_policy: 'FIXED_SL', stop_loss: null },
        { stop_loss: null },
      ]) {
        const a = cm2.managedCandidates([base(c)]);
        const b = cm2.managedCandidates([base({ ...c, ...IDENT })]);
        const shape = r => [
          r.positions.length,
          r.positions.map(p => `${p.ownership?.code}/${p.management?.code}`).join('|'),
          r.deferred.map(d => d.code).join('|'),
          r.skipped.map(x => x.code).join('|'),
        ].join(' · ');
        if (shape(a) !== shape(b)) {
          err(`감시 후보: identity가 **일반 생명주기 분류**를 바꿉니다 (${JSON.stringify(c)})`
            + `\n      없을 때: ${shape(a)}\n      있을 때: ${shape(b)}`);
        }
      }

      // ★ 전용 권한 목록은 **identity가 정한다** — 그리고 일반 목록과 겹치지 않는다.
      {
        const NFS = { stop_policy: 'NO_FIXED_SL', stop_loss: null };
        const noId = cm2.managedCandidates([base(NFS)]);
        const yesId = cm2.managedCandidates([base({ ...NFS, ...IDENT })]);
        if ((noId.authorityCandidates || []).length !== 0) {
          err('감시 후보: 계약 기록이 없는 NO_FIXED_SL을 전용 종료 권한 후보로 올립니다'
            + ' — 어느 계약의 보유 한도를 쓸지 알 수 없습니다 (fail-closed여야 합니다)');
        }
        if ((yesId.authorityCandidates || []).length !== 1) {
          err('감시 후보: 계약 기록이 있는 NO_FIXED_SL이 전용 종료 권한 후보에 없습니다'
            + ' — 만들어 놓고 배선하지 않은 상태입니다');
        }
        const ac = (yesId.authorityCandidates || [])[0];
        if (ac) {
          if (ac.capabilities?.timeExit !== true) {
            err('감시 후보: 전용 권한 후보에 시간 청산이 열려 있지 않습니다');
          }
          for (const k of ['trailing', 'breakEven', 'fixedStopAtEntry', 'emergency']) {
            if (ac.capabilities?.[k] !== false) {
              err(`감시 후보: 전용 권한 후보에 ${k}가 함께 열렸습니다`
                + ' — boolean 하나로 네 기능을 같이 열지 않습니다');
            }
          }
          if (ac.executionIdentity?.presetId !== PRESET) {
            err('감시 후보: 전용 권한 후보가 identity를 들고 있지 않습니다');
          }
        }
        // **일반 목록에는 그대로 없어야 한다.** 겹치면 트레일링이 함께 돈다.
        if (yesId.positions.length !== 0) {
          err('감시 후보: 전용 권한 노출이 일반 생명주기 목록에도 들어 있습니다'
            + ' — 한 노출을 두 경로가 건드립니다');
        }
        if ((yesId.deferred || []).length !== 1) {
          err('감시 후보: 전용 권한 후보를 올리면서 유예 기록을 지웠습니다'
            + ' — 일반 생명주기가 왜 안 보는지는 그대로 말해야 합니다');
        }
      }
      // 그러면서도 사실은 실려 있어야 한다 (적기만 한다 ≠ 안 적는다)
      const withId = cm2.managedCandidates([base({ stop_policy: 'FIXED_SL', stop_loss: 90, ...IDENT })]);
      if (withId.positions[0]?.executionIdentity?.presetId !== PRESET) {
        err('감시 후보: identity를 읽고도 포지션에 싣지 않습니다');
      }
      const defId = cm2.managedCandidates([base({ stop_policy: 'NO_FIXED_SL', stop_loss: null, ...IDENT })]);
      if (defId.deferred[0]?.executionIdentity?.profileId !== ID) {
        err('감시 후보: 유예 기록에 identity를 싣지 않습니다'
          + ' — 어느 계약의 노출이 관리되지 않는지 알 수 없습니다');
      }
    }
  }
}

// ── 실행·보유 비용과 실질 여유 (③) ──
//
//   ②가 구한 RAW 여유는 비용을 빼기 **전** 값이다. 100배에서 왕복 taker
//   수수료만 여유의 상당 부분이고 슬리피지가 거기 더해진다.
{
  const cost = await loadModule(COST, '실행 비용 판정');
  const COM = { takerRate: 0.0004, makerRate: 0.0002,
                source: 'EXCHANGE_ACCOUNT', observedAtMs: 1 };
  const BOOK = { bids: [[49_995, 50]], asks: [[50_005, 50]],
                 source: 'EXCHANGE_DEPTH', observedAtMs: 1, exchangeTimeMs: 1 };
  const NOW = 1_000_000_000_000;
  const FUND = { rate: 0.0001, nextFundingTimeMs: NOW + 3_600_000, intervalHours: 8,
                 capRate: 0.0005, floorRate: -0.0005,
                 source: 'EXCHANGE_FUNDING_INFO',
                 // **서로 다른 값**이어야 한다 — 같으면 두 칸을 하나로
                 // 합치는 변경이 검사를 그대로 통과한다.
                 premiumObservedAtMs: 1, premiumExchangeTimeMs: 1, premiumCache: 'FRESH',
                 fundingBoundsObservedAtMs: 2 };
  const cIn = (over = {}) => ({
    side: 'LONG', referencePrice: 50_000, quantity: 0.2, leverage: 100,
    fillKind: 'TAKER', commission: COM, book: BOOK, funding: FUND,
    nowMs: NOW, holdHorizonMs: 14_400_000, ...over,
  });

  if (cost) {
    const good = cost.assessExecutionCost(cIn());
    if (!good.ok) err(`${COST}: 정상 입력이 막힙니다 — ${good.reason}`);
    else {
      // **세 비용이 따로 보여야 한다.**
      for (const k of ['entryFeeUsd', 'exitFeeReserveUsd', 'entrySlippageUsd',
                       'exitSlippageReserveUsd', 'fundingReserveUsd']) {
        if (!(Number(good[k]) >= 0)) err(`${COST}: ${k}가 ${good[k]}입니다`);
      }
      if (!(good.totalCostUsd > 0)) err(`${COST}: 총 비용이 ${good.totalCostUsd}입니다`);
      if (good.commissionRate !== COM.takerRate) {
        err(`${COST}: taker 주문에 ${good.commissionRate} 수수료율을 씁니다`
          + ` (${COM.takerRate}여야 합니다 — maker를 쓰면 비용이 작아집니다)`);
      }
      // LONG 진입은 **매도호가**를 먹는다.
      if (!(good.expectedFillPrice >= 50_005)) {
        err(`${COST}: LONG 예상 체결가가 ${good.expectedFillPrice}입니다`
          + ' — 매도호가(50,005)보다 낮으면 유리한 쪽으로 계산한 것입니다');
      }
      if (!(good.entrySlippageUsd > 0)) {
        err(`${COST}: 기준가보다 불리하게 체결되는데 슬리피지가 ${good.entrySlippageUsd}입니다`);
      }
      if (good.bookObservedAtMs == null || good.commissionObservedAtMs == null
          || good.premiumObservedAtMs == null || good.fundingBoundsObservedAtMs == null) {
        err(`${COST}: 관측 시각을 버립니다 — ④(신선도)가 검사할 근거가 없습니다`);
      }
      if (good.premiumObservedAtMs === good.fundingBoundsObservedAtMs) {
        err(`${COST}: premium과 펀딩 상한의 관측 시각이 한 칸으로 합쳐졌습니다`
          + ' — 다른 엔드포인트의 다른 순간입니다. 한쪽의 신선함이 다른 쪽을 덮습니다');
      }
    }

    const sh = cost.assessExecutionCost(cIn({ side: 'SHORT' }));
    if (!sh.ok) err(`${COST}: 정상 SHORT이 막힙니다 — ${sh.reason}`);
    else if (!(sh.expectedFillPrice <= 49_995)) {
      err(`${COST}: SHORT 예상 체결가가 ${sh.expectedFillPrice}입니다`
        + ' — 매수호가(49,995)보다 높으면 유리한 쪽으로 계산한 것입니다');
    }

    for (const [why, over, codeWant] of [
      ['방향 없음', { side: null }, 'SIDE_UNKNOWN'],
      ['주문 유형 모름', { fillKind: null }, 'FILL_KIND_UNKNOWN'],
      ['수수료 없음', { commission: null }, 'COMMISSION_MISSING'],
      ['수수료 출처가 기본값 표', { commission: { ...COM, source: 'DEFAULT_TABLE' } },
        'COMMISSION_MISSING'],
      ['호가 없음', { book: null }, 'BOOK_MISSING'],
      ['먹어야 하는 쪽 호가가 빔', { book: { ...BOOK, asks: [] } }, 'BOOK_SIDE_EMPTY'],
      ['호가가 교차', { book: { bids: [[50_010, 50]], asks: [[50_005, 50]],
        source: 'EXCHANGE_DEPTH', observedAtMs: 1, exchangeTimeMs: 1 } }, 'BOOK_CROSSED'],
      ['깊이 부족', { quantity: 1_000 }, 'DEPTH_INSUFFICIENT'],
      ['펀딩 없음', { funding: null }, 'FUNDING_MISSING'],
      ['펀딩 주기 없음', { funding: { ...FUND, intervalHours: null } },
        'FUNDING_INTERVAL_UNUSABLE'],
      ['보유 구간 없음', { holdHorizonMs: null }, 'HOLD_HORIZON_UNUSABLE'],
    ]) {
      const v = cost.assessExecutionCost(cIn(over));
      if (v.ok) err(`${COST}: ${why}인데 통과합니다 — 비용을 모르면 실질 여유를 말할 수 없습니다`);
      else if (v.code !== codeWant) {
        err(`${COST}: ${why}의 사유가 ${v.code}입니다 (${codeWant}이어야 합니다)`);
      }
    }

    // **수취 예상치를 안전 여유로 쓰지 않는다.**
    const pay = cost.assessExecutionCost(cIn({ funding: { ...FUND, rate: 0.0001 } }));
    const recv = cost.assessExecutionCost(cIn({ funding: { ...FUND, rate: -0.0001 } }));
    if (pay.ok && recv.ok) {
      if (recv.fundingReserveUsd !== pay.fundingReserveUsd) {
        err(`${COST}: 펀딩 수취 쪽 예약이 ${recv.fundingReserveUsd}, 지불 쪽이`
          + ` ${pay.fundingReserveUsd}입니다 — 수취 예상치로 위험한 진입을 통과시킵니다`);
      }
      if (recv.fundingSideNow !== 'RECEIVE' || pay.fundingSideNow !== 'PAY') {
        err(`${COST}: 펀딩 방향을 관측에 남기지 않습니다`
          + ` (지불 ${pay.fundingSideNow} · 수취 ${recv.fundingSideNow})`);
      }
    }
    // 유리한 슬리피지를 **깎는다.**
    const favor = cost.assessExecutionCost(cIn({
      book: { bids: [[49_000, 50]], asks: [[49_500, 50]],
              source: 'EXCHANGE_DEPTH', observedAtMs: 1, exchangeTimeMs: 1 },
    }));
    if (favor.ok && favor.entrySlippageUsd !== 0) {
      err(`${COST}: 기준가보다 싸게 체결될 예상을 ${favor.entrySlippageUsd}로 적습니다`
        + ' — 유리한 쪽은 0으로 깎아야 합니다');
    }

    // 펀딩 주기를 **8시간으로 박지 않는가.**
    const h1 = cost.assessExecutionCost(cIn({ funding: { ...FUND, intervalHours: 1 } }));
    const h8 = cost.assessExecutionCost(cIn());
    if (h1.ok && h8.ok && !(h1.fundingEvents > h8.fundingEvents)) {
      err(`${COST}: 펀딩 주기 1시간과 8시간의 횟수가 ${h1.fundingEvents}·${h8.fundingEvents}입니다`
        + ' — 주기를 읽지 않고 고정값을 씁니다');
    }

    // ── 비용 → 증거금 → 실효배율 ──
    const eff = cost.effectiveMarginAfterCost(good, 100);
    if (eff.code !== 'OK') err(`${COST}: 정상 비용에서 실효 증거금을 못 구합니다 — ${eff.reason}`);
    else {
      if (!(eff.marginAfterCostUsd < eff.marginAtEntryUsd)) {
        err(`${COST}: 비용을 뺐는데 증거금이 줄지 않았습니다`);
      }
      if (!(eff.effectiveLeverage > 100)) {
        err(`${COST}: 실효배율이 ${eff.effectiveLeverage}입니다 — 증거금이 줄면 배율은 올라야 합니다`);
      }
      if (eff.effectiveEntryPrice !== good.expectedFillPrice) {
        err(`${COST}: 실질 계산의 진입가가 예상 체결가가 아닙니다`
          + ' — 슬리피지를 비용 표 한 줄로만 적고 청산가는 옛 기준가로 두면 두 세계가 생깁니다');
      }
    }
    if (cost.effectiveMarginAfterCost({ ...good, totalCostUsd: 1e9 }, 100).code === 'OK') {
      err(`${COST}: 비용이 증거금을 넘는데 통과합니다`);
    }
    if (cost.effectiveMarginAfterCost({ ok: false, code: 'X' }, 100).code !== 'COST_NOT_ASSESSED') {
      err(`${COST}: 비용을 확정하지 못했는데 실질 여유를 계산합니다`);
    }
  }

  // 기존 상수를 **정본으로 승격하지 않았는가.**
  {
    const src = code(COST);
    if (/roundTripCostPct|SCALP_DEFAULTS/.test(src)) {
      err(`${COST}: 신호 쪽 왕복 비용 상수를 끌어옵니다 — 다른 질문입니다`);
    }
    if (/DEFAULT_FEES|getDefaultConfig/.test(src)) {
      err(`${COST}: 수수료를 기본값 표에서 가져옵니다`);
    }
    if (/intervalHours\s*\?\?\s*8|=\s*8\s*;/.test(src)) {
      err(`${COST}: 펀딩 주기를 8시간으로 박았습니다`);
    }
  }

  // 진입 계획이 비용으로 **막는가** (이름이 아니라 동작).
  //
  // ★ 비용 판정용 고정 시각(1ms)을 진입 단계에 그대로 쓰면 ④(신선도)가
  //   "1970년 값"으로 먼저 막는다. 여기서 보는 것은 **비용**이므로 관측
  //   시각만 지금으로 맞춘다 — 신선도 자체는 아래 ④ 묶음이 따로 본다.
  const freshCOM = (over = {}) => ({ ...COM, observedAtMs: Date.now(), ...over });
  const freshBOOK = (over = {}) => ({ ...BOOK,
    observedAtMs: Date.now(), exchangeTimeMs: Date.now() - 100, ...over });
  const freshFUND = (over = {}) => ({ ...FUND, nextFundingTimeMs: Date.now() + 3_600_000,
    premiumObservedAtMs: Date.now(), premiumExchangeTimeMs: Date.now() - 100,
    premiumCache: 'FRESH', fundingBoundsObservedAtMs: Date.now(), ...over });
  if (entry) {
    const base = {
      observeMarginMode: async () => 'isolated',
      applyLeverage: async (lev) => ({ ok: true, observed: lev, message: '' }),
      availableUsd: async () => 1000,
      referenceMark: async () => ({
        price: 50_000, exchangeTimeMs: Date.now() - 100, observedAtMs: Date.now(),
        source: 'EXCHANGE_PREMIUM_INDEX', cache: 'FRESH',
      }),
      quantize: async (q) => ({ qty: q, message: '' }),
      maintenanceTiers: async () => ({
        tiers: [[50_000_000, 0.004, 0]], observedAtMs: Date.now(), freshness: 'FRESH',
      }),
      adverseDistancePct: async () => 0.3,
      commissionRates: async () => freshCOM(),
      orderBookDepth: async () => freshBOOK(),
      fundingContext: async () => freshFUND(),
    };
    const CC = { leverage: 100, sizingPolicy: 'MARGIN_ALLOCATION', marginModes: ['isolated'],
                 side: 'LONG', fillKind: 'TAKER', maxHoldSec: 14_400 };
    for (const [why, over, wantCode] of [
      ['수수료를 못 읽으면', { commissionRates: async () => null }, 'COST_UNKNOWN'],
      ['호가를 못 읽으면', { orderBookDepth: async () => null }, 'COST_UNKNOWN'],
      ['펀딩을 못 읽으면', { fundingContext: async () => null }, 'COST_UNKNOWN'],
      ['호가 깊이가 모자라면', {
        orderBookDepth: async () => freshBOOK({ asks: [[50_005, 0.0001]] }),
      }, 'COST_UNKNOWN'],
      ['수수료가 증거금을 먹으면',
        { commissionRates: async () => freshCOM({ takerRate: 0.4 }) },
        'LIQUIDATION_UNSAFE_AFTER_COST'],
      // ★ **RAW는 통과하고 실질 여유만 모자라는 자리.** 이 케이스가 없으면
      //   실질 여유 관문을 통째로 지우는 변경이 조용히 통과한다 — 실제로
      //   그 변이가 새 나갔다. RAW 0.6024% · 실질 0.4920%이므로 0.55는
      //   그 사이에 있다.
      ['비용을 빼면 여유가 모자라면', { adverseDistancePct: async () => 0.55 },
        'LIQUIDATION_UNSAFE_AFTER_COST'],
      // 비교: RAW 자체가 모자라면 사유가 다르다.
      ['RAW 여유부터 모자라면', { adverseDistancePct: async () => 0.62 },
        'LIQUIDATION_UNSAFE'],
    ]) {
      const prep = await entry.prepareEntry100x(CC, 10, { ...base, ...over });
      if (prep.ok) err(`100X 진입: ${why} 막아야 하는데 통과했습니다`);
      else if (prep.code !== wantCode) {
        err(`100X 진입: ${why} 막긴 했는데 사유가 ${prep.code}입니다 (${wantCode}여야 합니다)`);
      }
    }
    // 실질 여유로 막힌 계획은 **RAW가 통과했다는 사실**도 들고 있어야 한다.
    // 그래야 운영자가 "구조는 괜찮은데 비용이 먹었다"를 읽을 수 있다.
    {
      const afterCost = await entry.prepareEntry100x(
        CC, 10, { ...base, adverseDistancePct: async () => 0.55 });
      if (afterCost.code !== 'LIQUIDATION_UNSAFE_AFTER_COST') {
        err(`100X 진입: 비용 때문에 막혀야 하는데 ${afterCost.code}입니다`);
      } else {
        if (afterCost.liquidation?.ok !== true) {
          err('100X 진입: 비용으로 막힌 계획인데 RAW 판정이 통과로 남아 있지 않습니다');
        }
        if (afterCost.effectiveLiquidation?.ok !== false
            || afterCost.effectiveLiquidation?.headroomKind !== 'EFFECTIVE') {
          err('100X 진입: 실질 여유 판정이 결과에 남지 않습니다'
            + ' — 무엇이 모자랐는지 말할 수 없습니다');
        }
      }
    }

    // 통과한 계획은 RAW와 EFFECTIVE를 **둘 다** 들고 간다.
    const ok2 = await entry.prepareEntry100x(CC, 10, base);
    if (!ok2.ok) err(`100X 진입: 비용 포함 정상 경로가 막혔습니다 — ${ok2.message}`);
    else {
      if (ok2.liquidation?.headroomKind !== 'RAW') {
        err(`100X 진입: RAW 여유 표시가 ${ok2.liquidation?.headroomKind}입니다`);
      }
      if (ok2.effectiveLiquidation?.headroomKind !== 'EFFECTIVE') {
        err(`100X 진입: 실질 여유 표시가 ${ok2.effectiveLiquidation?.headroomKind}입니다`);
      }
      if (ok2.cost?.ok !== true) err('100X 진입: 통과한 계획이 비용 판정을 들고 있지 않습니다');
      const raw = ok2.liquidation?.liquidationDistancePct;
      const effPct = ok2.effectiveLiquidation?.liquidationDistancePct;
      if (!(effPct < raw)) {
        err(`100X 진입: 비용을 반영했는데 여유가 줄지 않았습니다 (RAW ${raw} · 실질 ${effPct})`);
      }
      if (ok2.liquidation === ok2.effectiveLiquidation) {
        err('100X 진입: RAW와 실질 여유가 같은 객체입니다 — 하나가 다른 하나를 덮었습니다');
      }
      // **거리는 마크가에서 잰다.** 체결가에서 재면 슬리피지가 통째로
      // 사라진다 — 식이 진입가에 비례하므로 진입가 대비 %가 그대로다.
      if (ok2.effectiveLiquidation?.referencePrice !== 50_000) {
        err('100X 진입: 실질 거리의 기준이 마크가가 아닙니다'
          + ` (${ok2.effectiveLiquidation?.referencePrice}) — 체결가에서 재면 슬리피지가 사라집니다`);
      }
      if (!(ok2.effectiveLiquidation?.entryPrice > 50_000)) {
        err('100X 진입: 실질 계산의 진입가가 예상 체결가가 아닙니다'
          + ` (${ok2.effectiveLiquidation?.entryPrice})`);
      }
    }
    // 의존 분류 — 새 읽기 셋이 통합 카운터 밖으로 새지 않는가.
    const es = code(ENTRY);
    const iRead = es.indexOf('export interface Entry100xReadDeps');
    const iWrite = es.indexOf('export interface Entry100xWriteDeps');
    const readBlock = iRead >= 0 && iWrite > iRead ? es.slice(iRead, iWrite) : '';
    for (const nm of ['commissionRates', 'orderBookDepth', 'fundingContext']) {
      if (!(entry.READONLY_DEPS || []).includes(nm)) {
        err(`100X 진입: ${nm}이 READONLY_DEPS에 없습니다`);
      }
      if (!readBlock.includes(nm)) {
        err(`${ENTRY}: ${nm}이 읽기 전용 의존 타입 안에 없습니다`
          + ' — 쓰기 단계에서 읽으면 보호가 첫 거래소 쓰기 뒤로 갑니다');
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// ④ 시장 데이터 신선도 — **값은 있는데 언제의 값인지 모르는 상태**
// ═══════════════════════════════════════════════════════════
//
//   ②·③까지 와서 청산거리와 비용은 거래소 값으로 계산하게 됐다. 그런데
//   그 값들이 **같은 순간의 시장**이라는 보장은 어디에도 없었다.
//
//   이름이 아니라 **동작**으로 본다. 정본 모듈을 실제로 돌려서 막는지
//   보고, 정상 스냅숏이 통과하는지도 본다 — 막는 능력만 시험하면 가장
//   안전해 보이는 코드는 `return false`다.
{
  const FRESH = 'src/lib/engine/marketFreshness.ts';
  const mf = await loadModule(FRESH, '시장 데이터 신선도 정본');
  if (!mf || typeof mf.assessMarketFreshness !== 'function') {
    err(`${FRESH}: assessMarketFreshness를 불러오지 못했습니다 — 동작을 확인할 수 없습니다`);
  } else {
    const NOW = 1_700_000_000_000;
    const BASE = {
      MARK: { kind: 'MARK', source: 'EXCHANGE_PREMIUM_INDEX', value: 50_000,
              exchangeTimeMs: NOW - 300, receivedAtMs: NOW - 200, observedAtMs: NOW - 200,
              cache: 'FRESH' },
      BOOK: { kind: 'BOOK', source: 'EXCHANGE_DEPTH',
              exchangeTimeMs: NOW - 400, receivedAtMs: NOW - 250, observedAtMs: NOW - 250,
              cache: 'FRESH' },
      PREMIUM: { kind: 'PREMIUM', source: 'EXCHANGE_PREMIUM_INDEX',
                 exchangeTimeMs: NOW - 500, receivedAtMs: NOW - 350, observedAtMs: NOW - 350,
                 cache: 'FRESH' },
      FUNDING_BOUNDS: { kind: 'FUNDING_BOUNDS', source: 'EXCHANGE_FUNDING_INFO',
                        exchangeTimeMs: null, observedAtMs: NOW - 100, cache: 'FRESH' },
      COMMISSION: { kind: 'COMMISSION', source: 'EXCHANGE_ACCOUNT',
                    exchangeTimeMs: null, observedAtMs: NOW - 150, cache: 'FRESH' },
      BRACKET: { kind: 'BRACKET', source: 'EXCHANGE_LEVERAGE_BRACKET',
                 exchangeTimeMs: null, observedAtMs: NOW - 60_000, cache: 'FRESH' },
    };
    const snap = (over = {}) => Object.keys(BASE)
      .filter(k => over[k] !== null)
      .map(k => ({ ...BASE[k], ...(over[k] || {}) }));
    const assess = (over = {}, ...rest) => mf.assessMarketFreshness({
      // **기본값을 쓰지 않는다.** `assess(x, undefined)`가 NOW로 바뀌면
      // "판정 시각을 모를 때 막는가"를 시험할 수 없다.
      observations: snap(over), required: ['MARK'],
      nowMs: rest.length ? rest[0] : NOW,
    });

    // 대조군 — **정상 스냅숏을 과도하게 거부하지 않는다**
    const good = assess();
    if (!good.ok) err(`${FRESH}: 정상 스냅숏을 막습니다 — ${good.reason}`);

    for (const [why, over, wantCode] of [
      // ① 마크가 값 자체
      ['마크가가 null', { MARK: { value: null } }, 'VALUE_INVALID'],
      ['마크가가 0', { MARK: { value: 0 } }, 'VALUE_INVALID'],
      ['마크가가 NaN', { MARK: { value: NaN } }, 'VALUE_INVALID'],
      ['마크가가 Infinity', { MARK: { value: Infinity } }, 'VALUE_INVALID'],
      // ② 수신 시각 · ③ 거래소 시각
      ['마크가에 수신 시각이 없음', { MARK: { observedAtMs: null } }, 'TIMESTAMP_MISSING'],
      ['마크가에 거래소 시각이 없음', { MARK: { exchangeTimeMs: null } }, 'TIMESTAMP_MISSING'],
      ['수신 시각이 NaN', { MARK: { observedAtMs: NaN } }, 'TIMESTAMP_MISSING'],
      ['수신 시각이 Infinity', { MARK: { observedAtMs: Infinity } }, 'TIMESTAMP_MISSING'],
      ['호가에 거래소 시각이 없음', { BOOK: { exchangeTimeMs: null } }, 'TIMESTAMP_MISSING'],
      // ④ 낡음
      ['마크가가 10초 전', { MARK: { exchangeTimeMs: NOW - 10_100,
        receivedAtMs: NOW - 10_000, observedAtMs: NOW - 10_000 } }, 'STALE'],
      ['호가가 10초 전', { BOOK: { exchangeTimeMs: NOW - 10_100,
        receivedAtMs: NOW - 10_000, observedAtMs: NOW - 10_000 } }, 'STALE'],
      ['premium이 60초 전', { PREMIUM: { exchangeTimeMs: NOW - 60_100,
        receivedAtMs: NOW - 60_000, observedAtMs: NOW - 60_000 } }, 'STALE'],
      ['브래킷이 7시간 전', { BRACKET: { observedAtMs: NOW - 7 * 3_600_000,
        receivedAtMs: NOW - 7 * 3_600_000 } }, 'STALE'],
      // ⑤ 만료된 캐시 — 시각을 지금으로 바꿔도 잡힌다 (세탁 불가)
      ['만료된 브래킷 캐시', { BRACKET: { cache: 'STALE_CACHE' } }, 'CACHE_NOT_FRESH'],
      ['만료된 premium 캐시에 지금 시각',
        { PREMIUM: { cache: 'STALE_CACHE', exchangeTimeMs: NOW - 100,
                     receivedAtMs: NOW, observedAtMs: NOW } },
        'CACHE_NOT_FRESH'],
      // ⑥ 수신 지연 — 늦게 도착한 값 (판단은 checkClockSkew 정본)
      ['거래소 시각만 한참 전', { MARK: { exchangeTimeMs: NOW - 100 - 3_300,
        receivedAtMs: NOW - 100, observedAtMs: NOW - 100 } }, 'CLOCK_SKEW'],
      // ⑦ 미래 시각
      ['관측 시각이 미래', { MARK: { exchangeTimeMs: NOW + 60_000 - 100,
        receivedAtMs: NOW + 60_000, observedAtMs: NOW + 60_000 } }, 'FROM_FUTURE'],
      ['거래소 시각이 수신보다 미래', { BOOK: { exchangeTimeMs: NOW + 60_000,
        receivedAtMs: NOW - 100, observedAtMs: NOW - 100 } }, 'FROM_FUTURE'],
      // ⑧ 교차 출처 — 각자 신선해도 **합친 그림**은 없을 수 있다
      ['마크가와 호가가 7초 떨어진 시점', {
        MARK: { exchangeTimeMs: NOW - 200, receivedAtMs: NOW - 100, observedAtMs: NOW - 100 },
        BOOK: { exchangeTimeMs: NOW - 7_000, receivedAtMs: NOW - 4_500, observedAtMs: NOW - 4_500 },
      }, 'CROSS_SOURCE_SKEW'],
      // 기준 마크가가 아예 없으면 — 그 값에는 다른 주인이 없다
      ['마크가 관측 자체가 없음', { MARK: null }, 'OBSERVATION_MISSING'],
    ]) {
      const v = assess(over);
      if (v.ok) { err(`${FRESH}: ${why}인데 통과했습니다`); continue; }
      if (v.code !== wantCode) {
        err(`${FRESH}: ${why} 막긴 했는데 사유가 ${v.code}입니다 (${wantCode}여야 합니다)`);
      }
    }

    // 판정 시각 자체를 모르면 막는다 — 나이를 잴 수 없다
    for (const n of [null, undefined, NaN, Infinity]) {
      const v = assess({}, n);
      if (v.ok || v.code !== 'NOW_UNUSABLE') {
        err(`${FRESH}: 판정 시각이 ${String(n)}인데 ${v.code}입니다 (NOW_UNUSABLE여야 합니다)`);
      }
    }

    // 교차 검사가 **개별 검사로 대체되지 않는가** — 비어 있는 검사는 검사가 아니다
    {
      const v = assess({
        MARK: { exchangeTimeMs: NOW - 200, receivedAtMs: NOW - 100, observedAtMs: NOW - 100 },
        BOOK: { exchangeTimeMs: NOW - 7_000, receivedAtMs: NOW - 4_500, observedAtMs: NOW - 4_500 },
      });
      const perSource = (v.findings || [])
        .filter(f => f.code !== 'OK' && f.code !== 'CROSS_SOURCE_SKEW');
      if (perSource.length) {
        err(`${FRESH}: 교차 출처 케이스가 개별 검사에서 이미 걸립니다`
          + ' — 그러면 교차 검사가 있으나 마나입니다');
      }
    }

    // 출처별 관측 시각을 **합치지 않는가**
    {
      const p = good.provenance || {};
      for (const k of ['referenceMarkObservedAtMs', 'referenceMarkReceivedAtMs',
                       'referenceMarkExchangeTimeMs',
                       'bookObservedAtMs', 'bookExchangeTimeMs',
                       'premiumObservedAtMs', 'premiumExchangeTimeMs',
                       'fundingBoundsObservedAtMs', 'commissionObservedAtMs',
                       'bracketObservedAtMs', 'bracketFreshness']) {
        if (p[k] == null) err(`${FRESH}: provenance에 ${k}가 없습니다 — 출처를 따로 적어야 합니다`);
      }
      if (p.premiumObservedAtMs === p.fundingBoundsObservedAtMs) {
        err(`${FRESH}: premium과 펀딩 상한의 시각이 한 칸으로 합쳐졌습니다`
          + ' — 한쪽의 신선함이 다른 쪽을 덮습니다');
      }
    }

    // 문턱이 **화면용 정본**에서 오지 않았는가
    {
      const pol = mf.EXACT100X_FRESHNESS_POLICY || {};
      // **시계 오차 숫자를 여기서 또 정의하지 않았는가.**
      //   정본은 `preTradeChecklist.checkClockSkew`다. 같은 판단이 두
      //   곳에 있으면 한쪽만 바뀌고 그때 두 답이 갈린다.
      for (const dup of ['clockSkewBudgetMs', 'futureToleranceMs']) {
        if (dup in pol) {
          err(`${FRESH}: 정책에 ${dup}를 또 정의했습니다`
            + ' — 시계 오차 정본은 preTradeChecklist.checkClockSkew 한 곳입니다');
        }
      }
      if (!/checkClockSkew/.test(code(FRESH))) {
        err(`${FRESH}: 시계 오차 정본(checkClockSkew)을 쓰지 않습니다`
          + ' — 같은 판단을 두 벌 만들면 언젠가 두 답이 갈립니다');
      }
      // **빠른 시장 사실과 느린 설정 사실에 같은 문턱을 씌우지 않았는가.**
      for (const fast of ['MARK', 'BOOK', 'PREMIUM']) {
        for (const slow of ['BRACKET', 'COMMISSION', 'FUNDING_BOUNDS']) {
          const a = (pol.maxDecisionAgeMs || {})[fast];
          const b = (pol.maxDecisionAgeMs || {})[slow];
          if (!(a < b)) {
            err(`${FRESH}: ${fast}(${a}ms)와 ${slow}(${b}ms)에 같은 문턱을 씁니다`
              + ' — 가격 tick과 계정 설정은 성질이 다릅니다. 둘 중 하나는 반드시 틀립니다');
          }
        }
      }
      for (const k of ['MARK', 'BOOK', 'PREMIUM']) {
        const v = (pol.maxDecisionAgeMs || {})[k];
        if (!(v > 0) || v >= 100_000) {
          err(`${FRESH}: ${k}의 나이 예산이 ${v}ms입니다`
            + ' — 화면용 정본(dataQuality: POLLED 10초 × STALE 10배 = 100초)을 쓰면'
            + ' 100배 진입이 10만ms 전 가격으로 판정됩니다');
        }
      }
      for (const k of ['MARK', 'BOOK', 'PREMIUM']) {
        if (!(pol.requireExchangeTime || []).includes(k)) {
          err(`${FRESH}: ${k}에 거래소 시각을 요구하지 않습니다`
            + ' — 수신 시각만으로는 늦게 도착한 값을 구분할 수 없습니다');
        }
      }
    }

    // **이 파일은 `Date.now()`를 부르지 않는다** — 판정이 자기 시각을
    // 만들 수 있으면 자기 자신을 속일 수 있다.
    if (/Date\.now\(\)/.test(code(FRESH))) {
      err(`${FRESH}: 판정 안에서 Date.now()를 부릅니다`
        + ' — 관측 시각을 만들어 낼 수 있는 코드가 판정 안에 있으면 세탁을 막을 수 없습니다');
    }
  }

  // 거래소 읽기가 **시각을 들고 오는가** (동작으로 확인한다)
  {
    const bf = 'src/lib/exchanges/binanceFutures.ts';
    const src = code(bf);
    if (!/export async function readMarketSnapshot/.test(src)) {
      err(`${bf}: readMarketSnapshot이 없습니다 — 기준 마크가를 시장 데이터에서 읽지 않습니다`);
    }
    // premiumIndex 응답의 `time`을 버리지 않는가
    if (!/timeMs:\s*Number\.isFinite\(t\)/.test(src)) {
      err(`${bf}: premiumIndex의 거래소 시각(time)을 버립니다`);
    }
    if (/timeMs:\s*Number\(d\.time\s*\|\|\s*0\)/.test(src)) {
      err(`${bf}: 없는 거래소 시각을 0(1970년)으로 적습니다 — "없음"과 "낡음"은 다른 상태입니다`);
    }
    // depth 응답의 `T`/`E`를 버리지 않는가
    if (!/d\?\.T\s*\?\?\s*d\?\.E/.test(src)) {
      err(`${bf}: 호가 응답의 거래소 시각(T/E)을 버립니다`);
    }
    // 수수료 조회가 **자기 관측 시각을 응답에 넣는가**
    const iCom = src.indexOf('export async function getCommissionRate');
    const comBody = iCom < 0 ? '' : src.slice(iCom, iCom + 1400);
    if (!/observedAtMs:\s*Date\.now\(\)/.test(comBody)) {
      err(`${bf}: 수수료 조회가 관측 시각을 응답에 넣지 않습니다`
        + ' — 그러면 부르는 쪽이 Date.now()를 붙이게 되고, 언제 읽었든 "방금"이 됩니다');
    }
    // 마크가 조회가 **캐시를 쓰지 않는가** — 45초 캐시는 100배 기준가에 못 쓴다
    const iMk = src.indexOf('export async function readMarketSnapshot');
    const mkBody = iMk < 0 ? '' : src.slice(iMk, iMk + 2000);
    if (/PREMIUM_CACHE|CACHE\.get\(/.test(mkBody)) {
      err(`${bf}: readMarketSnapshot이 캐시를 씁니다`
        + ' — premium의 45초 캐시를 100배 청산 여유의 기준가로 쓸 수 없습니다');
    }
    // **마크가와 premium이 한 응답에서 나오는가.**
    //   따로 읽으면 한 진입 안에서 청산거리는 T0, 펀딩은 T1이 된다.
    for (const need of ['markPrice', 'lastFundingRate', 'nextFundingTimeMs']) {
      if (!mkBody.includes(need)) {
        err(`${bf}: 시장 스냅숏이 ${need}를 함께 돌려주지 않습니다`
          + ' — 마크가와 펀딩을 따로 읽으면 서로 다른 시점이 됩니다');
      }
    }
    // **포지션 갱신 시각을 마크가 시각이라고 부르지 않는가.**
    //
    // ★ 앵커가 옮겨갔다 — `SymbolPositionRisk`와 조회 순서가
    //   `positionRiskRead.ts`(순수 정본)로 갔다. `binanceFutures.ts`는
    //   node `crypto` 때문에 검사기가 컴파일하지 못해 그 경계를 돌려서
    //   확인할 수 없었기 때문이다. **규칙을 지우지 않고** 새 자리를
    //   함께 본다.
    const PRR = 'src/lib/exchanges/positionRiskRead.ts';
    const stampSrc = code(bf) + '\n' + code(PRR);
    if (/markPriceObservedAtMs/.test(stampSrc)) {
      err(`${bf}: 포지션 갱신 시각을 markPriceObservedAtMs라고 부릅니다`
        + ' — 그 timestamp의 의미가 다릅니다');
    }
    if (!/positionUpdateTimeMs/.test(stampSrc)) {
      err(`${bf}: positionRisk의 updateTime을 버립니다`
        + ' — 보존하되 마크가 시각으로 쓰지 않는 것이 맞습니다');
    }
  }
}

// ═══════════════════════════════════════════════════════════
// ⑤ 전용 종료 권한 — **순서를 돌려서** 증명한다
// ═══════════════════════════════════════════════════════════
//
//   `exitAuthority.ts`가 단계를 타입으로 적어 두었다고 런타임 순서가
//   보장되지는 않는다. 선언은 선언이고, 무엇을 몇 번 어느 순서로 부르는지는
//   돌려 봐야 안다.
//
//   특히 **울타리 재검증과 전송 사이**에 조회가 하나라도 끼면, 느린
//   실행자가 그 창에서 깨어나 남의 포지션에 주문을 낸다. 그 창의 폭을
//   호출 기록으로 직접 센다.
{
  const RUN = 'src/lib/engine/exitAuthorityRun.ts';
  const AUTH = 'src/lib/engine/exitAuthority.ts';
  const POL = 'src/lib/engine/exitPolicy.ts';
  const MON5 = 'src/app/api/autotrade/exit-monitor/route.ts';
  const run = await loadModule(RUN, '전용 종료 실행 순서');
  const pol = await loadModule(POL, '종료 정책 정본');

  // ── 정책: 계약이 정본이고, 못 풀면 전략 값으로 내려가지 않는다 ──
  if (!pol || typeof pol.resolveExitPolicy !== 'function') {
    err(`${POL}: resolveExitPolicy를 불러오지 못했습니다`);
  } else {
    const ID = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 };
    const good = pol.resolveExitPolicy({ executionIdentity: ID, strategyId: 'scalp' });
    if (!good.ok || good.maxHoldMs !== 4 * 3600 * 1000) {
      err(`${POL}: 전용 100배 계약의 보유 한도가 ${good.maxHoldMs}ms입니다`
        + ' — 계약이 선언한 14400초(4시간)여야 합니다');
    }
    if (good.source !== 'EXECUTION_CONTRACT') {
      err(`${POL}: 전용 100배의 정책 출처가 ${good.source}입니다 — 계약이어야 합니다`);
    }
    // **전략 6시간으로 내려가지 않는가.**
    for (const [why, idv] of [
      ['못 푸는 계약', { profileId: 'NOPE', presetId: 'NOPE', contractVersion: 1 }],
      ['반쪽 identity', { profileId: 'MAX_LEV_100X', presetId: '', contractVersion: 2 }],
    ]) {
      const r = pol.resolveExitPolicy({ executionIdentity: idv, strategyId: 'scalp' });
      if (r.ok) {
        err(`${POL}: ${why}인데 정책을 돌려줍니다 (${r.maxHoldMs}ms · ${r.source})`
          + ' — 사용자가 고르지 않은 보유 한도로 닫게 됩니다');
      }
      if (r.maxHoldMs === 6 * 3600 * 1000) {
        err(`${POL}: ${why}에 전략 scalp의 6시간으로 내려갔습니다`);
      }
    }
    // 계약 없이 연 예약은 **기존 의미 그대로**다.
    const legacy = pol.resolveExitPolicy({ executionIdentity: null, strategyId: 'scalp' });
    if (!legacy.ok || legacy.maxHoldMs !== 6 * 3600 * 1000
        || legacy.source !== 'STRATEGY_LIFECYCLE') {
      err(`${POL}: 계약 없는 scalp의 기존 생명주기 의미가 바뀌었습니다`
        + ` (${legacy.maxHoldMs}ms · ${legacy.source})`);
    }
  }

  // ── 런타임 순서를 **호출 기록으로** 본다 ──
  if (!run || typeof run.runExitAuthority !== 'function') {
    err(`${RUN}: runExitAuthority를 불러오지 못했습니다 — 순서를 확인할 수 없습니다`);
  } else {
    const NOW = 1_800_000_000_000;
    const FOUR_H = 4 * 3600 * 1000;
    const EID = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 };
    const cand = (over = {}) => ({
      positionIdentity: {
        exchange: 'binance', connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG',
        executionIdentity: EID, openingOrderId: 'o1',
      },
      strategyId: 'scalp', executionIdentity: EID,
      capabilities: { fixedStopAtEntry: false, breakEven: false, trailing: false,
                      timeExit: true, emergency: false },
      reason: 'TIME_EXIT', openedAtMs: NOW - FOUR_H, ...over,
    });
    const rig = (o = {}) => {
      const log = [];
      return { log, deps: {
        leaseOwned: async () => { log.push('lease'); return { owned: o.owned !== false, identity: { holder: 'a', fence: 10 } }; },
        prepareClose: async () => {
          log.push('prepare');
          if (o.flat) return { code: 'ALREADY_FLAT', prepared: null, message: 'flat' };
          if (o.readFail) return { code: 'READ_FAILED', prepared: null, message: '조회 실패' };
          return { code: 'READY', message: 'ready',
            prepared: { quantity: 0.2, orderSide: 'SELL', reduceOnly: true,
                        observedQty: 0.2, positionMode: 'ONE_WAY' } };
        },
        revalidateFence: async () => { log.push('revalidate'); return o.fence !== false; },
        sendClose: async () => { log.push('send'); return { attempted: true, ok: true, error: null }; },
        readAfter: async () => { log.push('readAfter'); return { ok: true, found: false }; },
      } };
    };

    // 정상 경로의 **정확한** 순서
    {
      const { deps, log } = rig();
      const r = await run.runExitAuthority(cand(), deps, NOW);
      if (r.code !== 'CLOSED_VERIFIED') {
        err(`${RUN}: 정상 경로가 ${r.code}입니다 — ${r.reason}`);
      }
      const want = 'lease > prepare > revalidate > send > readAfter';
      if (log.join(' > ') !== want) {
        err(`${RUN}: 런타임 순서가 계약과 다릅니다 — ${log.join(' > ')} (${want}여야 합니다)`);
      }
      // ★ **재검증과 전송 사이가 비어 있는가.** 이 창이 넓으면 울타리가
      //   있어도 느린 실행자가 주문을 보낼 여지가 남는다.
      const iR = log.indexOf('revalidate');
      if (iR < 0 || log[iR + 1] !== 'send') {
        err(`${RUN}: 울타리 재검증과 전송 사이에 다른 호출이 끼어 있습니다 (${log.join(' > ')})`
          + ' — 그 창만큼 낡은 실행자가 주문을 보낼 수 있습니다');
      }
      // 노출 조회는 재검증 **앞**이어야 한다.
      if (!(log.indexOf('prepare') < iR)) {
        err(`${RUN}: 노출 조회가 울타리 재검증보다 뒤입니다 — 창이 넓어집니다`);
      }
    }

    // 쓰기 직전 재검증이 막으면 **주문 0건**
    {
      const { deps, log } = rig({ fence: false });
      const r = await run.runExitAuthority(cand(), deps, NOW);
      if (r.code !== 'LEASE_LOST' || r.attemptedWrite !== false || log.includes('send')) {
        err(`${RUN}: 울타리가 넘어갔는데 주문이 나갔습니다 (${r.code} · ${log.join(' > ')})`);
      }
    }
    // 임차가 없으면 거래소를 **읽지도** 않는다
    {
      const { deps, log } = rig({ owned: false });
      const r = await run.runExitAuthority(cand(), deps, NOW);
      if (r.code !== 'NOT_OWNER' || log.join(' > ') !== 'lease') {
        err(`${RUN}: 남의 임차인데 거래소를 건드렸습니다 (${log.join(' > ')})`);
      }
    }
    // 이미 flat이면 **주문 0건**이고 "보냈다"로 적지 않는다
    {
      const { deps, log } = rig({ flat: true });
      const r = await run.runExitAuthority(cand(), deps, NOW);
      if (r.code !== 'ALREADY_FLAT' || r.attemptedWrite !== false || log.includes('send')) {
        err(`${RUN}: flat인데 주문을 보냈거나 전송했다고 적습니다 (${r.code} · attempted=${r.attemptedWrite})`);
      }
      if (r.failed !== false || r.ok !== true) {
        err(`${RUN}: ALREADY_FLAT을 실패로 셉니다 — 안전 상태입니다`);
      }
    }
    // 못 읽으면 flat이 아니다
    {
      const { deps, log } = rig({ readFail: true });
      const r = await run.runExitAuthority(cand(), deps, NOW);
      if (r.code !== 'POSITION_READ_FAILED' || log.includes('send')) {
        err(`${RUN}: 포지션을 못 읽었는데 ${r.code}입니다`);
      }
    }
    // 경계 — `>=`
    for (const [held, want] of [[FOUR_H - 1, 'POLICY_NOT_DUE'], [FOUR_H, 'CLOSED_VERIFIED'],
                                [FOUR_H + 1, 'CLOSED_VERIFIED']]) {
      const { deps } = rig();
      const r = await run.runExitAuthority(cand({ openedAtMs: NOW - held }), deps, NOW);
      if (r.code !== want) {
        err(`${RUN}: 보유 ${held}ms에서 ${r.code}입니다 (${want}여야 합니다)`
          + ' — 경계는 >=입니다');
      }
    }
    // openedAt이 없거나 미래면 막는다
    for (const [why, v] of [['없음', null], ['NaN', NaN], ['미래', NOW + 60_000]]) {
      const { deps, log } = rig();
      const r = await run.runExitAuthority(cand({ openedAtMs: v }), deps, NOW);
      if (r.code !== 'OPENED_AT_UNUSABLE' || log.includes('send')) {
        err(`${RUN}: 진입 시각이 ${why}인데 ${r.code}입니다 — fail-closed여야 합니다`);
      }
    }
  }

  // ── 라우트가 **실제로** 그 경로를 부르는가 ──
  {
    const mon = code(MON5);
    if (!/runExitAuthority\(/.test(mon)) {
      err(`${MON5}: 전용 종료 권한을 부르지 않습니다 — 만들어 놓고 배선하지 않았습니다`);
    }
    // 쓰기 원시 함수를 못 찾으면 **검사기 자신이 실패한다.** 이름이 바뀌어
    // 검사가 눈머는 길을 열어 두지 않는다.
    const vops = code('src/lib/engine/venuePositionOps.ts');
    for (const fn of ['prepareSymbolClose', 'sendSymbolClose']) {
      if (!new RegExp(`export async function ${fn}\\(`).test(vops)) {
        err(`venuePositionOps: ${fn}를 찾지 못했습니다 — 쓰기 경계를 확인할 수 없습니다`);
      }
      if (!new RegExp(`${fn}\\(`).test(mon)) {
        err(`${MON5}: ${fn}를 쓰지 않습니다 — 준비/전송 분리가 배선되지 않았습니다`);
      }
    }
    // 전송은 **읽지 않아야** 한다 — 그래야 재검증과의 창이 0이다.
    const iSend = vops.indexOf('export async function sendSymbolClose(');
    const sendBody = iSend < 0 ? '' : vops.slice(iSend, iSend + 1600);
    for (const banned of ['readOpenPosition', 'closeModeGate', 'prepareClosePosition',
                          'getFuturesPositions', 'futuresPositionMode']) {
      if (sendBody.includes(banned)) {
        err(`venuePositionOps.sendSymbolClose가 ${banned}를 부릅니다`
          + ' — 전송 직전에 조회가 남으면 울타리 재검증과의 창이 넓어집니다');
      }
    }
    // 전용 권한 결과가 **집계에서 사라지지 않는가.**
    if (!/out\.authority/.test(mon)) {
      err(`${MON5}: 전용 종료 결과를 따로 집계하지 않습니다`);
    }
    if (!/전용 종료 후보/.test(mon)) {
      err(`${MON5}: 요약에 전용 종료 결과가 없습니다 — 화면에서 사라집니다`);
    }
    // **일반 루프에 합치지 않았는가.**
    if (/positions\.push\(\s*\.\.\.authorityCandidates|positions\.concat\(authorityCandidates/.test(mon)) {
      err(`${MON5}: 전용 권한 후보를 일반 생명주기 목록에 합쳤습니다`
        + ' — 전략 6시간 정책을 타고 트레일링까지 열립니다');
    }
    // 전용 경로가 `lifecyclePolicyOf`를 쓰지 않는가.
    // 범위를 **일반 루프 시작 전까지**로 자른다. 넉넉히 잡으면 일반
    // 루프의 `lifecyclePolicyOf`가 섞여 들어와 거짓 경보가 난다.
    const iAuth = mon.indexOf('if (authorityCandidates.length > 0) {');
    const iGeneric = mon.indexOf('for (const p of positions) {', iAuth < 0 ? 0 : iAuth);
    if (iAuth < 0) {
      err(`${MON5}: 전용 종료 권한 블록을 찾지 못했습니다 — 배선을 확인할 수 없습니다`);
    }
    if (iAuth >= 0 && iGeneric < 0) {
      err(`${MON5}: 일반 생명주기 반복문을 찾지 못했습니다 — 두 경로의 경계를 확인할 수 없습니다`);
    }
    const authBody = (iAuth < 0 || iGeneric < 0) ? '' : mon.slice(iAuth, iGeneric);
    // 전용 블록이 일반 루프보다 **앞**이어야 한다 — 뒤에 있으면 일반
    // 루프가 먼저 같은 자리를 건드릴 수 있다.
    if (iAuth >= 0 && iGeneric >= 0 && !(iAuth < iGeneric)) {
      err(`${MON5}: 전용 종료 권한 블록이 일반 생명주기 반복문보다 뒤에 있습니다`);
    }
    if (/lifecyclePolicyOf/.test(authBody)) {
      err(`${MON5}: 전용 종료 경로가 전략 생명주기 정책을 씁니다 — 계약 4시간이 아니라 6시간이 됩니다`);
    }
  }

  // ── DB 울타리는 거래소를 막지 못한다 — 멱등 키가 있는가 ──
  //
  //   재검증 **직후** 임차가 넘어가면 낡은 실행자도 요청을 보낼 수 있다.
  //   다른 프로세스라 같은 event loop를 공유하지 않고, 거래소는 우리
  //   `fence` 값을 모른다. 그래서 같은 종료 의도에 **같은 주문 식별자**를
  //   실어 거래소가 중복을 **알아볼 기회**를 준다.
  //
  //   ★ 여기서 강제하는 것은 "거래소가 둘째를 거부한다"가 **아니다.**
  //     그 동작은 이 환경에서 확인하지 못했고, 공식 문서도 `newClientOrderId`
  //     가 **열린 주문들 사이에서** 고유하다고만 적는다. 강제하는 것은
  //     우리 쪽 계약뿐이다 — 결정적 식별자 · 규격 · 전달 · 중복 응답의
  //     올바른 분류 · 그리고 **strict single-writer라고 주장하지 않을 것.**
  {
    const INTENT = 'src/lib/engine/exitIntent.ts';
    const it = await loadModule(INTENT, '종료 의도 멱등 키');
    if (!it || typeof it.exitIntentId !== 'function') {
      err(`${INTENT}: exitIntentId를 불러오지 못했습니다`
        + ' — 거래소 수준 중복 차단이 없으면 낡은 실행자가 두 번째 청산을 낼 수 있습니다');
    } else {
      const EID = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 };
      const base = { connectionId: 'c1', exchange: 'binance', symbol: 'BTCUSDT',
                     side: 'LONG', executionIdentity: EID, reason: 'TIME_EXIT' };
      const a = it.exitIntentId({ ...base, quantity: 1 });
      const b = it.exitIntentId({ ...base, quantity: 1 });
      if (a !== b) {
        err(`${INTENT}: 같은 종료 의도가 다른 식별자를 만듭니다 (${a} vs ${b})`
          + ' — 두 실행자가 다른 id를 쓰면 거래소가 중복을 알아볼 기회조차 없습니다');
      }
      // 시각·난수가 들어가면 결정적이지 않다. 소스로도 확인한다.
      const isrc = code(INTENT);
      for (const banned of ['Date.now()', 'Math.random()', 'randomUUID', 'process.pid']) {
        if (isrc.includes(banned)) {
          err(`${INTENT}: 식별자에 ${banned}를 씁니다`
            + ' — 실행자마다 달라져 거래소가 중복을 알아볼 수 없습니다');
        }
      }
      // 서로 다른 의도는 **달라야** 한다 (정당한 재시도가 영구 차단되지 않게)
      for (const [why, over] of [
        ['수량', { quantity: 0.6 }], ['종목', { symbol: 'ETHUSDT', quantity: 1 }],
        ['방향', { side: 'SHORT', quantity: 1 }], ['계좌', { connectionId: 'c2', quantity: 1 }],
        ['계약', { executionIdentity: { ...EID, contractVersion: 3 }, quantity: 1 }],
      ]) {
        if (it.exitIntentId({ ...base, quantity: 1, ...over }) === a) {
          err(`${INTENT}: ${why}가 달라도 같은 식별자입니다 — 다른 종료가 영구히 막힙니다`);
        }
      }
      // 거래소 규격 — 저장소가 이미 쓰는 36자
      if (!(a.length > 0 && a.length <= 36) || !/^[A-Za-z0-9_-]+$/.test(a)) {
        err(`${INTENT}: 식별자가 거래소 규격을 벗어납니다 (${a})`);
      }
      // ── 중복 응답 분류. **두 코드를 정반대로 다뤄야 한다** ──
      //
      //   USDⓈ-M 공식 오류표:
      //     -4015 INVALID_CL_ORD_ID_LEN      식별자 길이·형식 오류
      //     -4116 DUPLICATED_CLIENT_ORDER_ID 식별자 중복
      //
      //   -4015를 중복으로 읽으면 **보내지도 않은 주문을 보낸 것으로**
      //   치고 재조회 결과에 따라 닫혔다고 적게 된다. 우리가 만드는 고장이다.
      if (typeof it.isDuplicateIntentError !== 'function') {
        err(`${INTENT}: isDuplicateIntentError가 없습니다`
          + ' — 중복 응답을 "안 나갔다"로 읽으면 같은 자리에 또 보냅니다');
      } else {
        for (const m of ['-4116 DUPLICATED_CLIENT_ORDER_ID',
                         'code=-4116 clientOrderId is duplicated',
                         'Duplicate order sent.', 'ORDER_DUPLICATE']) {
          if (!it.isDuplicateIntentError(m)) {
            err(`${INTENT}: 중복 응답을 알아보지 못합니다 ("${m}")`);
          }
        }
        for (const m of ['-4015 Client order id is not valid', '-4015 INVALID_CL_ORD_ID_LEN',
                         '-2022 ReduceOnly Order is rejected', '-1021 Timestamp',
                         'socket hang up']) {
          if (it.isDuplicateIntentError(m)) {
            err(`${INTENT}: "${m}"을 중복으로 읽습니다`
              + ' — -4015는 식별자 형식 오류이고 중복이 아닙니다.'
              + ' 모르는 오류를 중복으로 확대 해석하면 보내지 않은 주문을 보냈다고 적게 됩니다');
          }
        }
      }
    }

    // 전송 경로가 **실제로** 그 키를 싣는가
    const vops2 = code('src/lib/engine/venuePositionOps.ts');
    if (!/clientOrderId/.test(vops2)) {
      err('venuePositionOps: 청산 주문에 멱등 키를 싣지 않습니다');
    }
    const bfs = code('src/lib/exchanges/binanceFutures.ts');
    const iSend2 = bfs.indexOf('export async function sendPreparedClose(');
    const sendBody2 = iSend2 < 0 ? '' : bfs.slice(iSend2, iSend2 + 1200);
    if (iSend2 < 0) {
      err('binanceFutures: sendPreparedClose를 찾지 못했습니다 — 쓰기 경계를 확인할 수 없습니다');
    } else {
      if (!/clientOrderId/.test(sendBody2)) {
        err('binanceFutures.sendPreparedClose가 멱등 키를 주문에 싣지 않습니다'
          + ' — 울타리가 넘어간 직후의 둘째 주문을 거래소가 막을 수 없습니다');
      }
      if (!/reduceOnly:\s*true/.test(sendBody2)) {
        err('binanceFutures.sendPreparedClose의 payload에 reduceOnly가 없습니다');
      }
    }
    const mon6 = code(MON5);
    if (!/exitIntentId\(/.test(mon6)) {
      err(`${MON5}: 전용 종료 경로가 멱등 키를 만들지 않습니다`);
    }
    // 실행 순서 정본이 중복 거부를 "모름"으로 넘기는가
    const runSrc = code(RUN);
    if (!/isDuplicateIntentError/.test(runSrc)) {
      err(`${RUN}: 중복 식별자 거부를 분류하지 않습니다`
        + ' — "거부됐다"로 적으면 안 나간 것으로 읽혀 또 보냅니다');
    }
    // ── 외부가 보장하지 않은 것을 **보장한다고 적지 않는가** ──
    //
    //   공식 문서는 `newClientOrderId`가 열린 주문 사이에서 고유하다고만
    //   적는다. "같은 의도면 주문이 하나만 생긴다"·"거래소가 둘째를
    //   거부한다"는 그보다 강한 주장이고, 이 환경에서 확인하지 못했다.
    //   ★ **원본을 본다 — `code()`가 아니다.** 이 저장소의 과장 문장은
    //     전부 주석에 있다. 주석을 지운 소스로 검사하면 규칙이 통과하는
    //     이유가 "과장이 없어서"가 아니라 "볼 수 없어서"가 된다.
    //     (실제로 그 모양으로 한 번 들어갔다가 이 줄로 고쳤다.)
    //
    //   부정문은 **적어야 한다.** "strict single-writer가 아니다"는 금지
    //   대상이 아니라 우리가 원하는 문장이다. 그래서 금지어를 찾은 뒤
    //   그 줄과 **다음 줄**에 부정 표지가 있는지 본다 — 한국어 주석은
    //   서술어가 다음 줄로 넘어간다.
    const NEGATION = /아니다|아니라|아닙니다|않는다|않습니다|않음|못한다|못합니다|못한|비보장|보장하지|주장하지|증명하지|적지\s*않/;
    for (const f of [INTENT, RUN, 'src/lib/engine/venuePositionOps.ts',
                     'src/lib/exchanges/binanceFutures.ts', MON5,
                     'src/lib/engine/exitAuthorityRun.test.ts']) {
      const lines = read(f).split('\n');
      for (const [re, what] of [
        [/주문(이|은)?\s*하나만\s*생긴다|주문\s*하나(로|만)?\s*(끝난다|생긴다)|→\s*주문\s*하나/, '"주문은 하나만 생긴다"'],
        [/둘째를\s*거부한다/, '"거래소가 둘째를 거부한다"'],
        [/같은\s*ID\s*재사용을\s*거부한다/, '"같은 ID 재사용을 거부한다"'],
        [/strict\s*single-?writer/i, 'strict single-writer 주장'],
        [/멱등\s*키가\s*(중복|둘째)[^\n]{0,20}막는다/, '"멱등 키가 둘째를 막는다"'],
      ]) {
        for (let i = 0; i < lines.length; i += 1) {
          if (!re.test(lines[i])) continue;
          const window = lines[i] + ' ' + (lines[i + 1] ?? '');
          if (NEGATION.test(window)) continue;
          err(`${f}:${i + 1}: 외부 거래소가 보장하지 않은 것을 보장한다고 적습니다 (${what})`
            + ' — 공식 문서는 열린 주문 사이의 고유성만 적습니다.'
            + ' 추가 방어층이라고 적고 UNVERIFIED_EXTERNAL로 남기십시오');
        }
      }
    }

    // ── ⑤A-2 전용 종료 권한의 **거래소 지원 범위** ──
    //
    //   Gate는 전용 권한이 아직 지원하지 않는다. 진입 경로가 Gate에서
    //   우연히 fail-closed라는 것만으로는 부족하다 — 그건 잠복 경로다.
    //   여기서는 **돌려서** 확인한다. 이름이 아니라 동작이다.
    {
      const AUTH2 = 'src/lib/engine/exitAuthority.ts';
      const am = await loadModule(AUTH2, '종료 권한 정본');
      if (!am || typeof am.exact100xExitVenueCapability !== 'function') {
        err(`${AUTH2}: exact100xExitVenueCapability가 없습니다`
          + ' — 거래소 허용 범위가 흩어져 적히면 Gate를 열 때 한 곳만 고쳐집니다');
      } else {
        if (am.exact100xExitVenueCapability('binance').timeExit !== true) {
          err(`${AUTH2}: binance에서 전용 TIME_EXIT이 닫혀 있습니다 — 기존 경로가 죽습니다`);
        }
        for (const x of ['gate', 'okx', '', null, undefined]) {
          if (am.exact100xExitVenueCapability(x).timeExit === true) {
            err(`${AUTH2}: 검증하지 않은 거래소(${String(x)})에서 전용 TIME_EXIT이 열려 있습니다`
              + ' — 멱등 키 규격·중복 거부 동작을 외부 검증한 뒤에 엽니다');
          }
        }
        if (!String(am.exact100xExitVenueCapability('gate').reason || '').trim()) {
          err(`${AUTH2}: Gate가 왜 닫혀 있는지 사유가 비어 있습니다`);
        }
      }

      // 실행 정본이 **무엇을 부르기도 전에** 막는가. deps 호출 0회여야 한다.
      const rm = await loadModule(RUN, '종료 권한 실행 정본');
      if (rm && typeof rm.runExitAuthority === 'function') {
        const touched = [];
        const spy = n => async () => { touched.push(n); throw new Error('불려서는 안 된다'); };
        const EID = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 };
        const r = await rm.runExitAuthority({
          positionIdentity: { exchange: 'gate', connectionId: 'c1', symbol: 'BTC_USDT',
            side: 'LONG', executionIdentity: EID, openingOrderId: 'o1' },
          strategyId: 'scalp', executionIdentity: EID,
          capabilities: { fixedStopAtEntry: false, breakEven: false, trailing: false,
            timeExit: true, emergency: false },
          reason: 'TIME_EXIT', openedAtMs: Date.now() - 9 * 3600 * 1000,
        }, {
          leaseOwned: spy('lease'), prepareClose: spy('prepare'),
          revalidateFence: spy('revalidate'), sendClose: spy('send'),
          readAfter: spy('readAfter'),
        }, Date.now());
        if (r?.code !== 'EXIT_VENUE_UNSUPPORTED') {
          err(`${RUN}: Gate 후보가 EXIT_VENUE_UNSUPPORTED가 아니라 "${r?.code}"로 보고됩니다`
            + ' — 미지원을 조회 실패·신원 불일치로 숨기면 운영자가 거래소를 의심합니다');
        }
        if (r?.attemptedWrite !== false) {
          err(`${RUN}: 미지원 거래소인데 attemptedWrite가 ${String(r?.attemptedWrite)}입니다`);
        }
        if (touched.length !== 0) {
          err(`${RUN}: 미지원 거래소에서 거래소 경로를 ${touched.length}번 건드립니다`
            + ` (${touched.join('→')}) — 조회·준비·전송 전부 0회여야 합니다`);
        }
        // Binance 경로는 **그대로**여야 한다 (지원을 줄이는 변경이 아니다)
        const log = [];
        const ok = await rm.runExitAuthority({
          positionIdentity: { exchange: 'binance', connectionId: 'c1', symbol: 'BTCUSDT',
            side: 'LONG', executionIdentity: EID, openingOrderId: 'o1' },
          strategyId: 'scalp', executionIdentity: EID,
          capabilities: { fixedStopAtEntry: false, breakEven: false, trailing: false,
            timeExit: true, emergency: false },
          reason: 'TIME_EXIT', openedAtMs: Date.now() - 9 * 3600 * 1000,
        }, {
          leaseOwned: async () => { log.push('lease'); return { owned: true, identity: { holder: 'w', fence: 1 } }; },
          prepareClose: async () => { log.push('prepare'); return { code: 'READY', message: '',
            prepared: { quantity: 1, orderSide: 'SELL', reduceOnly: true, observedQty: 1,
              positionMode: 'ONE_WAY' } }; },
          revalidateFence: async () => { log.push('revalidate'); return true; },
          sendClose: async () => { log.push('send'); return { attempted: true, ok: true, error: null }; },
          readAfter: async () => { log.push('readAfter'); return { ok: true, found: false }; },
        }, Date.now());
        if (log.join('>') !== 'lease>prepare>revalidate>send>readAfter' || ok?.code !== 'CLOSED_VERIFIED') {
          err(`${RUN}: 거래소 관문을 넣으면서 Binance 경로가 바뀌었습니다`
            + ` (${log.join('>')} · ${ok?.code})`);
        }
      }

      // **일반 생명주기의 Gate 지원을 막지 않았는가.** 지원을 줄이는
      // 변경이 아니라 검증 범위와 런타임을 맞추는 변경이다.
      const mp = await loadModule('src/lib/engine/managedPosition.ts', '열린 포지션 분류');
      if (mp && typeof mp.managedCandidates === 'function') {
        const g = mp.managedCandidates([{
          id: 'g', connection_id: 'cg', exchange: 'gate', symbol: 'ETHUSDT', side: 'BUY',
          avg_price: 100, stop_loss: 90, status: 'FILLED', reduce_only: false,
          acked_at: '2026-08-27T09:00:00.000Z', created_at: '2026-08-27T08:00:00.000Z',
          signal_id: '[s:scalp]s1', sl_order_id: 'sl-1', tp_order_id: null,
        }]);
        if ((g?.positions?.length ?? 0) !== 1) {
          err('managedPosition: Gate 일반 생명주기 줄이 후보에서 빠졌습니다'
            + ' — 전용 권한의 거래소 제한이 일반 Gate 기능까지 막았습니다');
        }
      }

      // Gate `text` 미배선을 **방어층이 있다고 적지 않는가**
      const vsrc = read('src/lib/engine/venuePositionOps.ts');
      if (/Gate[^\n]{0,40}(멱등\s*키|client\s*id)[^\n]{0,40}(있다|싣는다|전달한다)/.test(vsrc)) {
        err('venuePositionOps: Gate에 멱등 키 방어층이 있다고 적습니다'
          + ' — closePositionGateFutures는 text를 싣지 않습니다');
      }
    }

    // ── ⑤B-0/1 위험 측정기는 **재기만 하는가** ──
    //
    //   문턱을 먼저 정하고 측정기를 만들면 그 문턱을 정당화하는 측정기가
    //   나온다. 그래서 이 단계의 규칙은 대부분 "하지 않는다"이고,
    //   돌려서 확인한다 — 이름이 아니라 동작이다.
    {
      const PER = 'src/lib/engine/postEntryRisk.ts';
      const pm = await loadModule(PER, '열린 포지션 위험 측정기');
      if (!pm || typeof pm.measurePostEntryRisk !== 'function') {
        err(`${PER}: measurePostEntryRisk를 불러오지 못했습니다`);
      } else {
        // 측정기가 **거래소를 바꿀 수단을 내보내지 않는가**
        for (const bad of ['sendClose', 'closePosition', 'sendPreparedClose',
                           'runExitAuthority', 'sendSymbolClose', 'decideExit']) {
          if (Object.keys(pm).includes(bad)) {
            err(`${PER}: 측정기가 ${bad}를 내보냅니다 — 재는 것과 닫는 것을 섞었습니다`);
          }
        }
        const N = 1_780_000_000_000;
        const BR = [[50_000, 0.004, 0], [250_000, 0.005, 50]];
        const base = {
          side: 'LONG',
          mark: { kind: 'MARK', source: 'EXCHANGE_PREMIUM_INDEX', value: 50_000,
            exchangeTimeMs: N - 200, receivedAtMs: N - 150, observedAtMs: N - 150,
            cache: 'FRESH' },
          bracket: { kind: 'BRACKET', source: 'EXCHANGE_LEVERAGE_BRACKET',
            exchangeTimeMs: null, receivedAtMs: N - 60_000, observedAtMs: N - 60_000,
            cache: 'FRESH' },
          exchangeLiquidationPrice: 49_700, entryPrice: 50_000, quantity: 0.2,
          leverage: 100, marginMode: 'isolated', brackets: BR,
          entryAdverseDistancePct: 0.4, entryLiquidationDistancePctRaw: 0.6,
          provenance: { positionReceivedAtMs: N - 100, positionUpdateTimeMs: N - 3_600_000,
            markExchangeTimeMs: N - 200, markReceivedAtMs: N - 150,
            markObservedAtMs: N - 150, bracketObservedAtMs: N - 60_000 },
          nowMs: N,
        };
        const both = pm.measurePostEntryRisk(base);
        if (both.status !== 'MEASURED' || both.liquidationSources !== 'BOTH_AVAILABLE') {
          err(`${PER}: 두 청산가가 다 있는데 ${both.status}/${both.liquidationSources}입니다`);
        }
        // ★ **평균하지 않는가**
        if (both.exchangeLiquidationPrice != null && both.estimatedLiquidationPrice != null) {
          const avg = (both.exchangeLiquidationPrice + both.estimatedLiquidationPrice) / 2;
          if (both.exchangeLiquidationPrice === avg || both.estimatedLiquidationPrice === avg) {
            err(`${PER}: 두 청산가를 평균해 한 칸에 적습니다`
              + ' — 근거 없는 숫자를 만드는 것입니다');
          }
        }
        // ★ **한쪽이 없을 때 조용히 대체하지 않는가**
        const noEx = pm.measurePostEntryRisk({ ...base, exchangeLiquidationPrice: null });
        if (noEx.exchangeLiquidationPrice != null || noEx.exchangeHeadroomPct != null) {
          err(`${PER}: 거래소 청산가가 없는데 내부 추정이 그 칸으로 승격됩니다`);
        }
        if (noEx.liquidationSources !== 'INTERNAL_ONLY' || noEx.absoluteDelta != null) {
          err(`${PER}: 한쪽만 있는데 차이를 적거나 상태를 잘못 분류합니다`
            + ` (${noEx.liquidationSources})`);
        }
        // ★ **0을 청산가로 읽지 않는가**
        const zero = pm.measurePostEntryRisk({ ...base, exchangeLiquidationPrice: 0 });
        if (zero.exchangeLiquidationPrice != null) {
          err(`${PER}: 거래소가 준 0을 청산가로 읽습니다`
            + ' — 여유가 100%가 되어 가장 위험한 자리가 가장 안전해 보입니다');
        }
        // ★ **091 스냅숏 null을 숫자로 바꾸지 않는가**
        const noSnap = pm.measurePostEntryRisk({
          ...base, entryAdverseDistancePct: null, entryLiquidationDistancePctRaw: null });
        if (noSnap.entryAdverseDistancePct != null
            || noSnap.entryLiquidationDistancePctRaw != null) {
          err(`${PER}: 없는 진입 위험 스냅숏을 숫자로 채웁니다`
            + ' — 0이면 어떤 청산여유든 통과합니다. NULL은 UNKNOWN입니다');
        }
        if (noSnap.status !== 'MEASURED') {
          err(`${PER}: 스냅숏이 없다고 측정까지 포기합니다 (${noSnap.status})`);
        }
        // ★ **둘 다 없으면 RISK_DATA_UNUSABLE이고, 그것은 종료 사유가 아니다**
        const none = pm.measurePostEntryRisk({
          ...base, exchangeLiquidationPrice: null, brackets: null, bracket: null });
        if (none.status !== 'RISK_DATA_UNUSABLE') {
          err(`${PER}: 청산가를 어느 쪽에서도 못 구했는데 ${none.status}입니다`);
        }
        for (const k of Object.keys(none)) {
          if (/^(action|close|shouldExit|exit|verdict)$/i.test(k)) {
            err(`${PER}: 측정 결과에 행동 칸이 있습니다 (${k}) — 판단이 섞였습니다`);
          }
          if (/tolerance|threshold|ratio|consistent/i.test(k)) {
            err(`${PER}: 측정 결과에 문턱성 칸이 있습니다 (${k})`
              + ' — ⑤B-3 전에는 문턱을 만들지 않습니다');
          }
        }
        // ★ `positionRisk.updateTime`을 신선도에 쓰지 않는가
        //   (한 시간 전 갱신인데도 측정은 성립해야 한다)
        if (both.provenance?.positionUpdateTimeMs !== N - 3_600_000) {
          err(`${PER}: 포지션 갱신 시각을 기록하지 않습니다`);
        }
        if ('liquidationExchangeTimeMs' in (both.provenance ?? {})) {
          err(`${PER}: 거래소 청산가에 exchangeTimeMs 칸을 만들었습니다`
            + ' — 공식 응답에 없는 값입니다');
        }
      }

      // ── 소스 규칙 ──
      //
      //   아래 넷은 **타입·주석에만 나타나는 변경**이거나 다른 파일에
      //   있어서 모듈을 돌려서는 보이지 않는다. RK4·RK5·RK9·RK14가
      //   그래서 한 번 새 나갔다. 돌려서 보는 규칙과 소스를 보는 규칙은
      //   둘 다 필요하다.
      const psrcRaw = read(PER);
      const psrc = code(PER);

      // ★ RK5 — 청산가에 거래소 시각 칸을 **선언조차** 하지 않는가
      if (/liquidationExchangeTimeMs|liqExchangeTimeMs/.test(psrcRaw)) {
        err(`${PER}: 거래소 청산가에 exchangeTimeMs 칸을 선언했습니다`
          + ' — 공식 응답에 그 값이 없습니다. receivedAtMs만 적을 수 있습니다');
      }
      // ★ RK9 — 측정 상태에 **행동 이름**이 섞이지 않는가
      {
        const m = /export type PostEntryRiskStatus =([\s\S]{0,400}?);/.exec(psrc);
        if (!m) {
          err(`${PER}: PostEntryRiskStatus를 찾지 못했습니다`);
        } else if (/CLOSE|EXIT|SELL|LIQUIDATE|EMERGENCY|ADVERSE|TRAIL/i.test(m[1])) {
          err(`${PER}: 측정 상태에 행동 이름이 들어 있습니다 (${m[1].trim()})`
            + ' — ⑤B-0/1은 재기만 합니다. 종료 사유는 ⑤B-2/3의 일입니다');
        }
      }
      for (const banned of ['0.35', '1.5', 'liquidationProximityRatio', 'markShockPct']) {
        if (psrc.includes(banned)) {
          err(`${PER}: positionGuard의 문턱(${banned})을 100배 경로로 가져왔습니다`
            + ' — 저배율용으로 고른 값이고 Exact100X의 근거가 아닙니다');
        }
      }
      // 마크가 정본: `positionRisk.markPrice`를 쓰지 않는가
      if (/positionRisk\.markPrice|risk\.markPrice/.test(psrc)) {
        err(`${PER}: 포지션 응답의 markPrice를 씁니다`
          + ' — 그 값에는 시각이 없습니다. ④의 timestamped MARK를 쓰십시오');
      }
      // ── ⑤B-0/1 정정 — provenance가 **실제 HTTP 경계**와 같은가 ──
      //
      //   포지션 조회는 한 번의 왕복이 아니다(v2 → v3 → account).
      //   부르는 쪽이 호출 **전에** 찍은 시각을 "받은 시각"이라고 적으면
      //   왕복 두세 번만큼 앞선 값이 기록된다. ⑤B-0이 모으려는 관측이
      //   그 자리에서 오염되므로 이름 문제가 아니다.
      {
        // ★ 순수 정본을 돌린다. `binanceFutures.ts`는 node `crypto`를
        //   써서 검사기가 컴파일하지 못한다 — 그래서 순서·시각 경계를
        //   그쪽에 두면 **돌려서 확인할 수 없다.**
        const BF = 'src/lib/exchanges/positionRiskRead.ts';
        const bm = await loadModule(BF, '포지션 조회 순서 정본');
        if (!bm || typeof bm.readPositionRiskWithProvenance !== 'function') {
          err(`${BF}: readPositionRiskWithProvenance를 불러오지 못했습니다`);
        } else {
          const ROW = { symbol: 'BTCUSDT', positionAmt: '0.2', marginType: 'isolated',
            leverage: '100', liquidationPrice: '49700', entryPrice: '50000',
            markPrice: '50010', updateTime: '1779999000000' };
          const ROW3 = { ...ROW, marginType: undefined, leverage: undefined };
          const ACCT = { positions: [{ symbol: 'BTCUSDT', isolated: true, leverage: '100' }] };
          const clock = () => { let t = 1000; return () => (t += 100); };

          // ① v2 성공 — started < received (요청 전 시각이면 같아진다)
          const a = await bm.readPositionRiskWithProvenance('BTCUSDT',
            async () => [ROW], clock());
          const pa = a?.provenance ?? {};
          if (pa.positionRiskSource !== 'V2') {
            err(`${BF}: v2 성공인데 출처가 ${pa.positionRiskSource}입니다`);
          }
          if (pa.positionRiskRequestStartedAtMs == null
              || pa.positionRiskReceivedAtMs == null
              || !(pa.positionRiskRequestStartedAtMs < pa.positionRiskReceivedAtMs)) {
            err(`${BF}: positionRisk 관측 시각이 실제 응답 경계가 아닙니다`
              + ` (${pa.positionRiskRequestStartedAtMs} → ${pa.positionRiskReceivedAtMs})`
              + ' — 요청 **전**에 찍은 시각을 "받은 시각"으로 적으면 왕복만큼 앞섭니다');
          }
          if (pa.accountRequestStartedAtMs != null) {
            err(`${BF}: v2 성공인데 계정 조회 시각이 적혀 있습니다`);
          }

          // ② v2 실패 → v3 — v2 시각을 재사용하지 않는가
          const b = await bm.readPositionRiskWithProvenance('BTCUSDT',
            async (path) => {
              if (path === '/fapi/v2/positionRisk') throw new Error('v2 down');
              if (path === '/fapi/v3/positionRisk') return [ROW3];
              return ACCT;
            }, clock());
          const pb = b?.provenance ?? {};
          if (pb.positionRiskSource !== 'V3') {
            err(`${BF}: v3로 넘어갔는데 출처가 ${pb.positionRiskSource}입니다`);
          }
          if (!(pb.positionRiskRequestStartedAtMs > 1100)) {
            err(`${BF}: 실패한 v2 요청의 시각을 v3 관측 시각으로 재사용합니다`
              + ` (${pb.positionRiskRequestStartedAtMs})`);
          }
          // ③ 계정 응답 시각이 청산가 관측 시각을 덮지 않는가
          if (!(pb.positionRiskReceivedAtMs < pb.accountRequestStartedAtMs)) {
            err(`${BF}: 계정 조회 시각이 청산가 관측 시각을 덮어씁니다`
              + ` (${pb.positionRiskReceivedAtMs} vs ${pb.accountRequestStartedAtMs})`
              + ' — 청산가는 계정 응답에 들어 있지 않습니다');
          }
          // ④ 실패했는데 시각을 지어내지 않는가
          const d = await bm.readPositionRiskWithProvenance('BTCUSDT',
            async () => { throw new Error('down'); }, clock());
          if (d?.provenance?.positionRiskSource != null
              || d?.provenance?.positionRiskReceivedAtMs != null) {
            err(`${BF}: 조회가 전부 실패했는데 관측 시각을 적습니다`);
          }
          // ⑤ 청산가 전용 거래소 시각 칸을 만들지 않는가
          for (const bad of ['liquidationExchangeTimeMs', 'liquidationObservedAtMs',
                             'liquidationCalculatedAtMs']) {
            if (bad in (pa ?? {})) {
              err(`${BF}: ${bad} 칸을 만들었습니다 — 공식 응답에 그 값이 없습니다`);
            }
          }
        }

        // 라우트가 helper 호출 **전에** 시각을 찍지 않는가 (원본으로 본다)
        const monRaw = read(MON5);
        if (/const\s+\w*[Rr]eceivedAt\w*\s*=\s*Date\.now\(\)\s*;?\s*\n\s*const\s+\w+\s*=\s*await\s+bf\.getSymbolPositionRiskEx/
            .test(monRaw)) {
          err(`${MON5}: 포지션 조회 **전에** 찍은 시각을 "받은 시각"으로 씁니다`
            + ' — 이 helper는 v2→v3→account까지 왕복이 여러 번입니다.'
            + ' helper가 돌려주는 provenance를 쓰십시오');
        }
        if (!/positionRiskReceivedAtMs:\s*rr\?\.provenance/.test(monRaw)) {
          err(`${MON5}: 위험 측정이 helper의 실제 provenance를 쓰지 않습니다`);
        }
      }

      // ── trustworthy 의미가 섞이지 않는가 ──
      //
      //   거래소 청산가는 1차 venue 관측이고 내부 solver는 독립
      //   검증자다. 둘을 한 boolean으로 묶으면 브래킷을 못 읽어 내부
      //   계산만 실패한 샘플이 "거래소 값도 못 믿음"으로 읽힌다.
      {
        const PER2 = 'src/lib/engine/postEntryRisk.ts';
        const pm2 = await loadModule(PER2, '열린 포지션 위험 측정기');
        if (pm2 && typeof pm2.measurePostEntryRisk === 'function') {
          const N = 1_780_000_000_000;
          const base2 = {
            side: 'LONG',
            mark: { kind: 'MARK', source: 'EXCHANGE_PREMIUM_INDEX', value: 50_000,
              exchangeTimeMs: N - 200, receivedAtMs: N - 150, observedAtMs: N - 150,
              cache: 'FRESH' },
            bracket: null,
            exchangeLiquidationPrice: 49_700, entryPrice: 50_000, quantity: 0.2,
            leverage: 100, marginMode: 'isolated', brackets: null,
            entryAdverseDistancePct: 0.4, entryLiquidationDistancePctRaw: 0.6,
            provenance: { positionRiskSource: 'V2',
              positionRiskRequestStartedAtMs: N - 180, positionRiskReceivedAtMs: N - 100,
              accountRequestStartedAtMs: null, accountReceivedAtMs: null,
              positionUpdateTimeMs: N - 3_600_000,
              markExchangeTimeMs: N - 200, markReceivedAtMs: N - 150,
              markObservedAtMs: N - 150, bracketObservedAtMs: null },
            nowMs: N,
          };
          const only = pm2.measurePostEntryRisk(base2);
          if ('trustworthy' in only) {
            err(`${PER2}: 측정 전체에 붙은 trustworthy가 있습니다`
              + ' — 내부 계산 실패가 거래소 관측까지 못 믿는 것으로 읽힙니다.'
              + ' internalTrustworthy로 분리하십시오');
          }
          if (only.liquidationSources !== 'EXCHANGE_ONLY'
              || only.exchangeLiquidationPrice !== 49_700) {
            err(`${PER2}: 내부 계산이 실패했다고 거래소 관측까지 버립니다`
              + ` (${only.liquidationSources})`);
          }
          if (only.internalTrustworthy !== false) {
            err(`${PER2}: 브래킷이 없는데 내부 추정을 믿을 수 있다고 적습니다`);
          }
          // 새 위험 판단 boolean을 만들지 않았는가
          for (const k of Object.keys(only)) {
            if (typeof only[k] === 'boolean' && k !== 'internalTrustworthy') {
              err(`${PER2}: 측정에 새 boolean이 생겼습니다 (${k})`
                + ' — 판단은 ⑤B-2/3의 일입니다');
            }
          }
          // ★ 받은 시각이 **없을 때** updateTime으로 메우지 않는가.
          //   `received ?? updateTime` 같은 대체는 "한 시간 전 갱신"을
          //   "방금 받음"으로 둔갑시킨다. fixture가 항상 received를 주면
          //   그 경로가 실행되지 않아 변이가 새 나간다 — 실제로 한 번
          //   새 나갔다(RK18b).
          const noRecv = pm2.measurePostEntryRisk({
            ...base2,
            provenance: { ...base2.provenance,
              positionRiskRequestStartedAtMs: null, positionRiskReceivedAtMs: null },
          });
          if (noRecv.provenance?.positionRiskReceivedAtMs != null) {
            err(`${PER2}: 받은 시각이 없는데 다른 값으로 메웁니다`
              + ` (${noRecv.provenance.positionRiskReceivedAtMs})`
              + ' — 모르는 것은 null입니다. updateTime은 청산가 시각이 아닙니다');
          }
          if (noRecv.provenance?.positionRiskLatencyMs != null) {
            err(`${PER2}: 시각이 없는데 지연을 적습니다`);
          }
          if (noRecv.provenance?.positionUpdateTimeMs == null) {
            err(`${PER2}: positionUpdateTimeMs를 버립니다 — 기록은 남아야 합니다`);
          }

          // ── wall-clock 차와 단조 elapsed를 **다른 칸**에 두는가 ──
          //
          //   epoch 차는 NTP 보정에 오염되므로 지연 표본으로 쓸 수 없다.
          //   그 용도는 단조 측정이고, 둘이 한 칸이 되면 분리가 사라진다.
          const pv = pm2.measurePostEntryRisk({
            ...base2,
            provenance: { ...base2.provenance, positionRiskElapsedMs: 74 },
          }).provenance;
          if (pv?.positionRiskWallClockDeltaMs !== 80) {
            err(`${PER2}: wall-clock 차를 받은 시각 − 보낸 시각으로 재지 않습니다`
              + ` (${pv?.positionRiskWallClockDeltaMs})`);
          }
          if (pv?.positionRiskElapsedMs !== 74) {
            err(`${PER2}: 단조 elapsed를 그대로 들고 오지 않습니다`
              + ` (${pv?.positionRiskElapsedMs}) — wall-clock으로 다시 계산하면`
              + ' 시계 보정이 지연 표본을 오염시킵니다');
          }
          if (pv?.positionRiskElapsedMs === pv?.positionRiskWallClockDeltaMs) {
            err(`${PER2}: duration과 epoch 차가 같은 칸입니다`);
          }
        }
        // `trustworthy:` 단순 alias가 돌아오지 않았는가 (소스)
        const per2src = code(PER2);
        if (/\btrustworthy\s*:\s*internal\.trustworthy/.test(per2src)) {
          err(`${PER2}: 전체 trustworthy를 internal.trustworthy의 alias로 되돌렸습니다`);
        }
      }

      // ── ⑤B-2 관측 적재 — 실측과 주입값을 섞지 않는가 ──
      {
        const OBS = 'src/lib/engine/riskObservationStore.ts';
        const om = await loadModule(OBS, '위험 관측 적재기');
        // 아래 두 블록이 함께 쓰므로 **상위 스코프**에 둔다.
        const N0 = 1_780_000_000_000;
        const MEAS = {
          status: 'MEASURED', reason: '', internalTrustworthy: true,
          side: 'LONG', markPrice: 50_000,
          exchangeLiquidationPrice: 49_700, estimatedLiquidationPrice: 49_690,
          exchangeHeadroomPct: 0.6, estimatedHeadroomPct: 0.62,
          absoluteDelta: 10, deltaPct: 0.02, liquidationSources: 'BOTH_AVAILABLE',
          entryAdverseDistancePct: 0.4, entryLiquidationDistancePctRaw: 0.6,
          provenance: {
            positionRiskSource: 'V2',
            positionRiskRequestStartedAtMs: N0 - 180, positionRiskReceivedAtMs: N0 - 100,
            positionRiskWallClockDeltaMs: 80,
            positionRiskElapsedMs: 74, accountElapsedMs: null, helperElapsedMs: 74,
            accountRequestStartedAtMs: null, accountReceivedAtMs: null,
            positionUpdateTimeMs: N0 - 3_600_000,
            markExchangeTimeMs: N0 - 200, markReceivedAtMs: N0 - 150,
            markObservedAtMs: N0 - 150, bracketObservedAtMs: N0 - 60_000,
          },
          freshness: { code: 'OK' },
          internal: { code: 'ADVERSE_DISTANCE_UNKNOWN', entryTierIndex: 1,
            tier: { mmr: 0.005, maintAmount: 50 } },
        };
        if (!om || typeof om.recordRiskObservation !== 'function'
            || typeof om.riskObservationRow !== 'function') {
          err(`${OBS}: 관측 적재기를 불러오지 못했습니다`);
        } else {
          for (const bad of ['sendClose', 'closePosition', 'sendSymbolClose',
                             'runExitAuthority', 'placeFuturesOrder']) {
            if (Object.keys(om).includes(bad)) {
              err(`${OBS}: 적재기가 ${bad}를 내보냅니다 — 관측에 주문 권한이 붙었습니다`);
            }
          }
          const N = N0;
          const inp = (o = {}) => ({
            sampleOrigin: 'SYNTHETIC_TEST_ONLY', env: 'TESTNET',
            connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG',
            executionIdentity: { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X',
              contractVersion: 2 },
            measurement: MEAS,
            position: { entryPrice: 50_000, quantity: 0.2, leverage: 100,
              marginMode: 'isolated' },
            bracketFreshness: 'FRESH', ...o,
          });

          const row = om.riskObservationRow(inp());
          // ★ duration과 epoch이 **다른 칸**인가
          if (row.position_risk_elapsed_ms === row.position_risk_wall_clock_delta_ms) {
            err(`${OBS}: 단조 elapsed와 wall-clock 차가 같은 값입니다`
              + ' — 한 칸이 다른 칸을 덮었습니다. 시계 보정이 표본을 오염시킵니다');
          }
          if (!(row.position_risk_elapsed_ms < 1_000_000)) {
            err(`${OBS}: duration 칸에 epoch timestamp가 들어갔습니다`
              + ` (${row.position_risk_elapsed_ms})`);
          }
          // ★ 시크릿·문턱 칸이 없는가
          for (const k of Object.keys(row)) {
            if (/key|secret|signature|token|passphrase/i.test(k)) {
              err(`${OBS}: 관측 줄에 시크릿성 칸이 있습니다 (${k})`);
            }
            if (/threshold|tolerance|ratio|consistent|should|verdict/i.test(k)) {
              err(`${OBS}: 관측 줄에 판단 칸이 있습니다 (${k})`
                + ' — ⑤B-2는 측정만 합니다');
            }
            if (/liquidation_exchange_time|liquidation_observed_at/i.test(k)) {
              err(`${OBS}: 청산가 전용 시각 칸을 만들었습니다 (${k})`);
            }
          }

          // ★ OB7 — 줄 **생성기**를 직접 불러도 실측으로 둔갑하지 않는가.
          //   `recordRiskObservation`만 검사하면 생성기가 기본값을 넣는
          //   변경이 그대로 통과한다(실제로 한 번 새 나갔다).
          for (const bad of [undefined, null, '']) {
            const r3 = om.riskObservationRow(inp({ sampleOrigin: bad }));
            if (r3?.sample_origin === 'VERIFIED_TESTNET_OBSERVATION') {
              err(`${OBS}: 출처를 안 골랐는데 줄 생성기가 실측으로 적습니다`
                + ' — 시험 주입값이 조용히 실측 통계에 섞입니다');
            }
          }

          // ★ 출처를 안 고르면 **적지 않는가**
          const seen = [];
          const fakeSb = { from: (t) => ({ insert: async (r2) => {
            seen.push({ t, r2 }); return { error: null }; } }) };
          for (const bad of [undefined, null, '', 'REAL']) {
            seen.length = 0;
            const r2 = await om.recordRiskObservation(fakeSb, inp({ sampleOrigin: bad }));
            if (r2?.code !== 'ORIGIN_UNSPECIFIED' || seen.length !== 0) {
              err(`${OBS}: 출처 "${String(bad)}"로 관측이 쌓입니다`
                + ' — 시험 주입값이 실측으로 둔갑합니다');
            }
          }
          // ★ 어느 표에 쓰는가 — live_orders를 덮지 않는가
          seen.length = 0;
          const okRec = await om.recordRiskObservation(fakeSb, inp());
          if (okRec?.code !== 'RECORDED' || seen[0]?.t !== 'exact100x_risk_observations') {
            err(`${OBS}: 관측을 "${seen[0]?.t}"에 씁니다`
              + ' — live_orders에 쓰면 진입 불변 스냅숏이 덮입니다');
          }
          // ★ 기록 실패를 성공으로 적지 않는가
          const failSb = { from: () => ({ insert: async () => ({ error: { message: 'denied' } }) }) };
          if ((await om.recordRiskObservation(failSb, inp()))?.code !== 'WRITE_FAILED') {
            err(`${OBS}: 적재 실패를 성공으로 적습니다`
              + ' — 조용히 사라진 줄이 분포를 왜곡합니다');
          }
          // ★ 던지지 않는가 (감시 회차를 죽이지 않는다)
          let threw = false;
          try { await om.recordRiskObservation(null, inp()); } catch { threw = true; }
          if (threw) err(`${OBS}: 적재 실패가 감시 회차를 죽입니다`);
        }

        // ★ OB11 — 단조 시계 **기본값**이 `Date.now()`로 되돌아가지
        //   않는가. 시험은 `() => null`을 주입하므로 기본값 경로를 밟지
        //   않는다 — 그래서 원본으로 본다(실제로 한 번 새 나갔다).
        {
          // ★ 앵커가 옮겨갔다 — 단조 시계 정본이
          //   `system/monotonicClock`으로 갔다(⑤B-3A-1에서 두 벌이 되지
          //   않게 모았다). **지우지 않고** 새 자리를 본다.
          const PRR2 = 'src/lib/exchanges/positionRiskRead.ts';
          const prrSrc = code(PRR2);
          const monSrc = code('src/lib/system/monotonicClock.ts');
          const m2 = /export function monotonicNowMs[\s\S]{0,300}?\n\}/.exec(monSrc);
          if (!m2) {
            err('system/monotonicClock: 단조 시계 정본을 찾지 못했습니다');
          } else if (/Date\.now/.test(m2[0])) {
            err('system/monotonicClock: 단조 시계가 없을 때 Date.now로 메웁니다'
              + ' — 시계 보정에 오염된 줄과 깨끗한 줄을 나중에 구분할 수 없습니다.'
              + ' 없으면 null이 맞습니다');
          }
          if (/const defaultMonotonic[\s\S]{0,200}?performance/.test(prrSrc)) {
            err(`${PRR2}: 단조 시계를 또 한 벌 만들었습니다`
              + ' — 정본은 system/monotonicClock 하나입니다');
          }
          // duration 계산이 epoch 시계를 쓰지 않는가
          if (/span\(\s*(v2Started|v3Started|nowMs\(\))/.test(prrSrc)) {
            err(`${PRR2}: duration을 epoch 시각으로 잽니다`);
          }
        }

        // 감시 라우트가 **실측 출처**로 적는가, 그리고 여전히 주문 0건인가
        const monObs = code(MON5);
        const iObs = monObs.indexOf('recordRiskObservation');
        if (iObs < 0) {
          err(`${MON5}: 위험 관측을 적재하지 않습니다`
            + ' — 한 회차 응답에만 있으면 ⑤B-3이 쓸 분포가 생기지 않습니다');
        } else {
          const end = monObs.indexOf('for (const p of positions) {', iObs);
          const body = end > iObs ? monObs.slice(iObs, end) : monObs.slice(iObs, iObs + 4000);
          if (!/sampleOrigin:\s*'VERIFIED_TESTNET_OBSERVATION'/.test(body)) {
            err(`${MON5}: 실제 조회 경로가 표본 출처를 실측으로 적지 않습니다`);
          }
          for (const bad of ['sendSymbolClose', 'prepareSymbolClose', 'runExitAuthority']) {
            if (body.includes(bad)) {
              err(`${MON5}: 관측 적재 블록이 ${bad}를 부릅니다 — 주문 0건이어야 합니다`);
            }
          }
        }

        // ── 실측 자격 정본 — **열린 포지션이어야 실측이다** ──
        {
          const ELG = 'src/lib/engine/riskObservationEligibility.ts';
          const em = await loadModule(ELG, '실측 표본 자격 정본');
          if (!em || typeof em.verifiedTestnetObservationEligibility !== 'function') {
            err(`${ELG}: 자격 정본을 불러오지 못했습니다`);
          } else {
            const E = em.verifiedTestnetObservationEligibility;
            const EID = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X',
              contractVersion: 2 };
            const b = (o = {}) => ({ testnet: true, exchange: 'binance', side: 'LONG',
              executionIdentity: EID, positionAmt: 0.2, ...o });
            if (E(b()).code !== 'ELIGIBLE') {
              err(`${ELG}: 정상 TESTNET 관측이 자격 미달입니다 (${E(b()).code})`);
            }
            if (E(b({ side: 'SHORT', positionAmt: -0.2 })).code !== 'ELIGIBLE') {
              err(`${ELG}: SHORT 음수 수량이 자격 미달입니다`);
            }
            // ★ LIVE를 VERIFIED_TESTNET으로 적지 않는가
            for (const t of [false, null, undefined]) {
              if (E(b({ testnet: t })).eligible !== false) {
                err(`${ELG}: testnet=${String(t)}인데 실측 자격을 줍니다`
                  + ' — LIVE 관측이 TESTNET 통계로 들어갑니다');
              }
            }
            // ★ 열린 포지션인가
            if (E(b({ positionAmt: 0 })).code !== 'NO_POSITION') {
              err(`${ELG}: 수량 0을 열린 포지션으로 봅니다`
                + ' — 없는 포지션의 청산가가 실측 통계에 들어갑니다');
            }
            // ★ 방향이 맞는가
            if (E(b({ side: 'LONG', positionAmt: -0.2 })).code !== 'SIDE_MISMATCH'
                || E(b({ side: 'SHORT', positionAmt: 0.2 })).code !== 'SIDE_MISMATCH') {
              err(`${ELG}: 부호가 반대인 포지션을 이 후보의 것으로 봅니다`);
            }
            // ★ 못 읽은 수량을 0으로 읽지 않는가
            for (const q of [null, undefined, NaN, Infinity, 'x', true]) {
              if (E(b({ positionAmt: q })).code !== 'POSITION_UNUSABLE') {
                err(`${ELG}: 수량 ${String(q)}를 쓸 수 있다고 봅니다`);
              }
            }
            if (E(b({ executionIdentity: null })).code !== 'IDENTITY_MISMATCH'
                || E(b({ exchange: 'gate' })).code !== 'VENUE_UNSUPPORTED') {
              err(`${ELG}: 계약·거래소 관문이 열려 있습니다`);
            }
            // ★ **완전한 identity ≠ Exact100X identity.**
            //
            //   `executionIdentityComplete`는 세 칸이 찼는가만 본다.
            //   그걸로 자격을 주면 다른 계약의 포지션이 Exact100X 실측
            //   통계에 섞인다. 여기서는 **돌려서** 확인한다 — 완전한데도
            //   자격이 없어야 한다.
            const pm3 = await loadModule('src/lib/execution/profile.ts', '실행 계약 정본');
            if (pm3 && typeof pm3.executionIdentityComplete === 'function') {
              for (const id of [
                { profileId: 'SCALP_HIGH_LEV', presetId: 'STABILIZE', contractVersion: 2 },
                { profileId: 'SWING_LOW_LEV', presetId: 'RESEARCH', contractVersion: 2 },
                { profileId: 'MAX_LEV_100X', presetId: 'STABILIZE', contractVersion: 2 },
                { profileId: 'SCALP_HIGH_LEV', presetId: 'EXACT_100X', contractVersion: 2 },
              ]) {
                const complete = pm3.executionIdentityComplete(id);
                const v2 = E(b({ executionIdentity: id }));
                if (complete && v2.eligible) {
                  err(`${ELG}: ${id.profileId}/${id.presetId}가 Exact100X 실측 자격을 받습니다`
                    + ' — 완전한 identity와 Exact100X identity는 다릅니다');
                }
                if (v2.code !== 'IDENTITY_MISMATCH') {
                  err(`${ELG}: ${id.profileId}/${id.presetId}를 ${v2.code}로 적습니다`);
                }
              }
              // 지난/엉뚱한 버전도 막히는가
              for (const v of [1, 3, 0, -1, 1.5, '2.0', 'two', null]) {
                const v3 = E(b({ executionIdentity: {
                  profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: v } }));
                if (v3.eligible) {
                  err(`${ELG}: 계약 버전 ${String(v)}인데 실측 자격을 줍니다`);
                }
              }
              // 정상 Exact100X는 통과해야 한다 (관문이 전부 닫히면 안 된다)
              const good = E(b({ executionIdentity: {
                profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X',
                contractVersion: pm3.EXECUTION_CONTRACT_VERSION } }));
              if (good.code !== 'ELIGIBLE') {
                err(`${ELG}: 정상 Exact100X가 자격 미달입니다 (${good.code}) — 관문이 전부 닫혔습니다`);
              }
            }
            // Exact100X 판정 정본이 resolver를 지나는가
            if (!pm3 || typeof pm3.exact100xIdentity !== 'function') {
              err('execution/profile: exact100xIdentity 정본이 없습니다');
            } else {
              const X = pm3.exact100xIdentity;
              if (X('MAX_LEV_100X', 'EXACT_100X', pm3.EXECUTION_CONTRACT_VERSION).code
                  !== 'EXACT_100X') {
                err('execution/profile: 정상 Exact100X를 알아보지 못합니다');
              }
              if (X('SCALP_HIGH_LEV', 'STABILIZE', 2).code !== 'OTHER_CONTRACT'
                  || X('NOPE', 'NOPE', 2).code !== 'UNRESOLVED'
                  || X('MAX_LEV_100X', 'EXACT_100X', 99).code !== 'UNRESOLVED') {
                err('execution/profile: Exact100X 판정이 사유를 구별하지 못합니다');
              }
              // 자격 정본이 **그 정본을 쓰는가** (문자열 비교로 되돌아가지 않았는가)
              const esrc = code(ELG);
              if (!/exact100xIdentity\(/.test(esrc)) {
                err(`${ELG}: Exact100X 판정 정본을 쓰지 않습니다`
                  + ' — 완전성 검사만으로는 다른 계약이 섞입니다');
              }
              if (/MAX_LEV_100X|EXACT_100X/.test(esrc)) {
                err(`${ELG}: 계약 이름을 직접 비교합니다`
                  + ' — 버전이 올라갈 때 여기만 옛말로 남습니다. 정본에 물으십시오');
              }
            }
            // 행동 칸이 없는가 (종료 판정이 아니다)
            for (const k of Object.keys(E(b()))) {
              if (/action|close|exit|order|send/i.test(k)) {
                err(`${ELG}: 자격 판정에 행동 칸이 있습니다 (${k})`);
              }
            }
          }

          // 적재기가 **정본에게 묻는가**, 그리고 쓰기 실패와 섞지 않는가
          if (om && typeof om.recordRiskObservation === 'function') {
            const seen2 = [];
            const sb2 = { from: () => ({ insert: async (r4) => {
              seen2.push(r4); return { error: null }; } }) };
            const verified = (o = {}) => ({
              sampleOrigin: 'VERIFIED_TESTNET_OBSERVATION', env: 'TESTNET',
              connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG',
              executionIdentity: { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X',
                contractVersion: 2 },
              measurement: MEAS,
              position: { entryPrice: 50_000, quantity: 0.2, leverage: 100,
                marginMode: 'isolated' },
              bracketFreshness: 'FRESH',
              signedPositionAmt: 0.2, testnet: true, exchange: 'binance', ...o,
            });
            // LIVE/MOCK은 실측이 될 수 없다
            for (const env2 of ['LIVE', 'MOCK']) {
              seen2.length = 0;
              const r5 = await om.recordRiskObservation(sb2, verified({ env: env2 }));
              if (r5?.code !== 'ORIGIN_IMPOSSIBLE' || seen2.length !== 0) {
                err(`${OBS}: ${env2} 관측이 VERIFIED_TESTNET으로 쌓입니다`);
              }
            }
            // 열린 포지션이 아니면 **쓰기 실패가 아니라** 자격 미달이다
            for (const amt of [0, -0.2, null]) {
              seen2.length = 0;
              const r6 = await om.recordRiskObservation(sb2,
                verified({ signedPositionAmt: amt }));
              if (r6?.code !== 'NOT_ELIGIBLE' || seen2.length !== 0) {
                err(`${OBS}: 수량 ${String(amt)}인데 실측으로 적습니다 (${r6?.code})`);
              }
              if (r6?.code === 'WRITE_FAILED') {
                err(`${OBS}: 자격 미달을 쓰기 실패로 적습니다 — 고칠 것이 없는데 DB를 봅니다`);
              }
            }
            // 정상 경로는 그대로 적힌다
            seen2.length = 0;
            if ((await om.recordRiskObservation(sb2, verified()))?.code !== 'RECORDED'
                || seen2[0]?.sample_origin !== 'VERIFIED_TESTNET_OBSERVATION') {
              err(`${OBS}: 실제 열린 TESTNET 포지션을 실측으로 적지 않습니다`);
            }
          }

          // 라우트가 **부호 있는 수량**을 넘기는가
          const monSig = code(MON5);
          // ★ **호출부**를 앵커로 잡는다. `recordRiskObservation`의 첫
          //   등장은 import 줄이고, 거기서 창을 자르면 실제 인자를
          //   보기도 전에 끝난다(실제로 그래서 한 번 오탐이 났다).
          const iSig = monSig.indexOf('await recordRiskObservation(');
          const sigBody = iSig < 0 ? '' : monSig.slice(iSig, iSig + 2500);
          if (iSig < 0) err(`${MON5}: 관측 적재 호출부를 찾지 못했습니다`);
          // ★ **줄 전체**를 본다. 앞부분만 맞추면 `Math.abs(...)`를
          //   덧붙이는 변이가 그대로 통과한다(실제로 한 번 새 나갔다).
          const sigLine = /signedPositionAmt:([^\n]*)/.exec(sigBody);
          if (iSig >= 0 && !sigLine) {
            err(`${MON5}: 실측 자격 판정에 부호 있는 수량을 넘기지 않습니다`);
          } else if (sigLine && /Math\.abs|Math\.sign|\babs\(/.test(sigLine[1])) {
            err(`${MON5}: 실측 자격 판정에 절댓값을 넘깁니다 (${sigLine[1].trim()})`
              + ' — 부호가 사라지면 헤지 계좌의 반대 다리를 이 포지션으로 적습니다');
          } else if (sigLine && !/rr\?\.risk\?\.positionAmt\s*\?\?\s*null\s*,/.test(sigLine[1])) {
            err(`${MON5}: 부호 있는 수량을 그대로 넘기지 않습니다 (${sigLine[1].trim()})`);
          }
        }





      // ── ⑤B-3A-3.1 실전·테스트넷 동시 연결 — **기존 연결을 덮지 않는가** ──
      //
      //   연결 생성이 `onConflict: 'user_id,exchange_id'`였고 DB 제약도
      //   같았다. 그래서 Binance 실전이 있는 사용자가 테스트넷을 등록하면
      //   **기존 실전 row가 갱신됐다.** 우리가 "절대 하지 말 것"으로 적어
      //   둔 사고를 코드가 열어 두고 있었다.
      {
        const IDN = 'src/lib/exchanges/connectionIdentity.ts';
        const EXR = 'src/app/api/exchange/route.ts';
        const MIG96 = 'supabase/migrations/096_exchange_connections_environment_identity.sql';
        const im = await loadModule(IDN, '연결 자리 정본');
        if (!im || typeof im.connectionConflictTarget !== 'function'
            || typeof im.envSwitchVerdict !== 'function'
            || typeof im.nicknameVerdict !== 'function') {
          err(`${IDN}: 연결 자리 정본이 없습니다`);
        } else {
          // ① 자리에 환경이 들어가는가
          const cols = im.CONNECTION_IDENTITY_COLUMNS || [];
          if (!cols.includes('is_testnet')) {
            err(`${IDN}: 자리에 is_testnet이 없습니다 (${cols.join(',')})`
              + ' — 테스트넷 등록이 기존 실전 연결을 덮습니다');
          }
          const tgt = im.connectionConflictTarget();
          if (tgt !== 'user_id,exchange_id,is_testnet') {
            err(`${IDN}: conflict target이 "${tgt}"입니다`);
          }
          // ② 두 환경의 기본 이름이 다른가
          for (const name of ['Binance', 'Gate']) {
            if (im.envNicknameOf(name, true) === im.envNicknameOf(name, false)) {
              err(`${IDN}: ${name}의 실전·테스트넷 기본 이름이 같습니다`
                + ' — nickname unique가 부딪혀 한쪽이 덮입니다');
            }
          }
          // ③ 실전과 테스트넷이 서로 다른 자리인가
          if (im.sameIdentity({ userId: 'u', exchangeId: 'binance', isTestnet: false },
            { userId: 'u', exchangeId: 'binance', isTestnet: true })) {
            err(`${IDN}: 실전과 테스트넷을 같은 자리로 봅니다`);
          }
          if (im.duplicateIdentityGroups([
            { userId: 'u', exchangeId: 'binance', isTestnet: false },
            { userId: 'u', exchangeId: 'binance', isTestnet: true },
          ]).length !== 0) {
            err(`${IDN}: 실전+테스트넷 동시 보유를 duplicate로 읽습니다`);
          }
          // ④ 환경 전환이 자리를 덮지 않는가
          const ev = im.envSwitchVerdict({
            target: { connectionId: 'live-1', isTestnet: false },
            siblings: [{ connectionId: 'live-1', isTestnet: false },
              { connectionId: 'test-1', isTestnet: true }],
            toTestnet: true,
          });
          if (ev?.code !== 'ENV_CONNECTION_EXISTS') {
            err(`${IDN}: 자리가 겹치는 환경 전환을 ${ev?.code}로 읽습니다`
              + ' — 자동으로 합치거나 덮으면 어느 키가 사라졌는지 알 수 없습니다');
          }
          // 자기 자신 때문에 막히지 않는가 (영구 전환 불가가 된다)
          if (im.envSwitchVerdict({ target: { connectionId: 'only', isTestnet: false },
            siblings: [{ connectionId: 'only', isTestnet: false }], toTestnet: true })?.code
            !== 'OK') {
            err(`${IDN}: 자기 자신을 반대편으로 세어 전환을 막습니다`);
          }
          // ⑤ 다른 환경이 쓰는 이름을 덮지 않는가
          if (im.nicknameVerdict({ wanted: 'x',
            existing: [{ nickname: 'x', isTestnet: false }], isTestnet: true })?.code
            !== 'NICKNAME_CONFLICT') {
            err(`${IDN}: 다른 환경이 쓰는 이름을 덮어씁니다`);
          }
          // ⑥ 키·시크릿을 다루지 않는가
          for (const bad of ['encryptSecret', 'decryptSecret', 'upsert', 'setTestnet']) {
            if (Object.keys(im).includes(bad)) err(`${IDN}: ${bad}를 내보냅니다`);
          }
        }

        // 라우트가 정본을 쓰는가
        const esrc = code(EXR);
        if (!esrc.trim()) err(`${EXR}을 읽지 못했습니다`);
        else {
          if (/onConflict:\s*'user_id,exchange_id'/.test(esrc)) {
            err(`${EXR}: conflict target이 환경을 보지 않습니다`
              + ' — 테스트넷 등록이 기존 실전 연결을 덮습니다');
          }
          if (!/onConflict:\s*connectionConflictTarget\(\)/.test(esrc)) {
            err(`${EXR}: conflict target을 자리 정본에서 만들지 않습니다`);
          }
          // ★ 실제로 통한 환경(usedTestnet)이 자리에 들어가는가.
          //   사용자가 고른 isTestnet을 쓰면 실전 키가 테스트넷 자리에 앉는다.
          if (!/is_testnet:\s*usedTestnet/.test(esrc)) {
            err(`${EXR}: 검증으로 확정한 환경(usedTestnet)을 저장하지 않습니다`);
          }
          // ★ **호출 블록 안을 본다.** 토큰이 다른 자리에도 있으면,
          //   한 자리만 바꿔도 파일 전체 검색은 계속 맞는다
          //   (ENV4b가 그렇게 새 나갔다).
          {
            const rn = /resolveNickname\(\{([\s\S]{0,260}?)\}\)/.exec(esrc);
            if (!rn) {
              err(`${EXR}: 연결 이름을 환경별로 만들지 않습니다`);
            } else if (!/isTestnet:\s*usedTestnet\b/.test(rn[1])) {
              err(`${EXR}: 연결 이름을 검증으로 확정한 환경이 아니라`
                + ` 요청값으로 만듭니다 (${rn[1].replace(/\s+/g, ' ').trim().slice(0, 80)})`
                + ' — 실전 키가 "테스트넷"이라는 이름을 받습니다');
            }
            const nvc = /nicknameVerdict\(\{([\s\S]{0,420}?)\}\);/.exec(esrc);
            if (!nvc) {
              err(`${EXR}: 이름 충돌을 검사하지 않습니다`);
            } else if (!/isTestnet:\s*usedTestnet\b/.test(nvc[1])) {
              err(`${EXR}: 이름 충돌을 요청값 환경으로 판정합니다`);
            }
          }
          // ★ **판정 결과를 실제로 막는 데 쓰는가.** 호출만 남겨 두고
          //   가지를 죽이면 아무 의미가 없다(ENV9b가 그렇게 새 나갔다).
          if (!/if\s*\(!nv\.ok\)\s*\{/.test(esrc)) {
            err(`${EXR}: 이름 충돌 판정을 막는 데 쓰지 않습니다`
              + ' — 불러 놓고 버리면 기존 연결이 덮입니다');
          }
          if (!/NICKNAME_CONFLICT|nv\.code/.test(esrc)) {
            err(`${EXR}: 이름 충돌을 명시적 코드로 거부하지 않습니다`);
          }
          if (!/envSwitchVerdict\(/.test(esrc)) {
            err(`${EXR}: 환경 전환에서 반대편 연결을 보지 않습니다`);
          }
          if (!/ENV_CONNECTION_EXISTS/.test(esrc)) {
            err(`${EXR}: 자리 겹침을 ENV_CONNECTION_EXISTS로 거부하지 않습니다`);
          }
          // 환경 전환 판정도 **막는 데** 쓰는가
          if (!/if\s*\(ev\.code === 'ENV_CONNECTION_EXISTS'\)\s*\{/.test(esrc)) {
            err(`${EXR}: 환경 전환 판정을 막는 데 쓰지 않습니다`);
          }
          // 자동으로 합치거나 지우지 않는가
          for (const bad of [/\.delete\(\)[\s\S]{0,120}is_testnet/,
                             /is_testnet[\s\S]{0,80}\.delete\(\)/]) {
            if (bad.test(esrc)) {
              err(`${EXR}: 환경 전환에서 반대편 연결을 지웁니다 (${bad})`);
            }
          }
          // 새 연결은 자동매매가 꺼진 상태여야 한다
          if (!/auto_trading_enabled:\s*false/.test(esrc)) {
            err(`${EXR}: 새 연결을 자동매매 꺼진 상태로 만들지 않습니다`);
          }
          if (/auto_trading_enabled:\s*true/.test(esrc)) {
            err(`${EXR}: 자동매매를 코드가 켭니다 — 사람이 확인하기 전에 켜지 않습니다`);
          }
        }

        // 096이 데이터를 고치지 않는가
        const m96 = read(MIG96);
        if (!m96.trim()) err('096 마이그레이션이 없습니다');
        else {
          if (!/RAISE EXCEPTION/i.test(m96)) {
            err('096: duplicate를 RAISE로 멈추지 않습니다');
          }
          if (!/UNIQUE \(user_id, exchange_id, is_testnet\)/i.test(m96)) {
            err('096: 환경을 포함한 새 제약이 없습니다');
          }
          const ddl96 = m96.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
          for (const bad of [/\bUPDATE\s+public\./i, /\bDELETE\s+FROM/i, /\bTRUNCATE\b/i,
                             /DROP\s+TABLE/i, /DROP\s+COLUMN/i]) {
            if (bad.test(ddl96)) {
              err(`096: 데이터·구조를 고치는 문장이 있습니다 (${bad})`
                + ' — 어느 연결이 맞는지는 사람이 정합니다');
            }
          }
          // 쓰고 있는 nickname 제약을 조용히 떨어뜨리지 않는가
          if (/DROP CONSTRAINT[\s\S]{0,80}nickname/i.test(ddl96)) {
            err('096: nickname unique 제약을 떨어뜨립니다 — 환경별 이름으로 피해야 합니다');
          }
        }
      }
      // ── ⑤B-3A-3 외부 준비 상태 — **거짓 준비를 만들지 않는가** ──
      //
      //   표본이 없는 이유를 "코드 문제"로 적지 않기 위해, 그리고 없는
      //   표본을 만들어 내지 않기 위해 판정을 정본 한 곳에 둔다.
      //
      //   ★ 자격 진단은 **시크릿을 받지 않는다.** 입력이 전부 boolean이
      //     아니면 값이 흘러 들어올 길이 생긴다.
      {
        const RDY = 'src/lib/engine/testnetReadiness.ts';
        const rm = await loadModule(RDY, 'TESTNET 준비 상태 정본');
        if (!rm || typeof rm.diagnoseCredential !== 'function'
            || typeof rm.binanceTestnetReadiness !== 'function'
            || typeof rm.sampleReadiness !== 'function') {
          err(`${RDY}: TESTNET 준비 상태 정본이 없습니다`);
        } else {
          const okc = { rowFound: true, exchangeResolved: true, hasWithdrawal: false,
            keyPresent: true, secretCiphertextPresent: true, secretDecrypted: true };
          // ① 서로 다른 원인이 서로 다른 코드로 나오는가
          const want = {
            rowFound: 'NO_CONNECTION', exchangeResolved: 'UNSUPPORTED_EXCHANGE',
            keyPresent: 'KEY_MISSING', secretCiphertextPresent: 'SECRET_MISSING',
            secretDecrypted: 'DECRYPT_FAILED',
          };
          const seen = new Set();
          for (const [k, code] of Object.entries(want)) {
            const got = rm.diagnoseCredential({ ...okc, [k]: false });
            if (got !== code) err(`${RDY}: ${k}=false를 ${got}로 읽습니다 (${code}이어야 합니다)`);
            seen.add(got);
          }
          const wd = rm.diagnoseCredential({ ...okc, hasWithdrawal: true });
          if (wd !== 'WITHDRAWAL_ENABLED') err(`${RDY}: 출금 권한 있는 키를 ${wd}로 읽습니다`);
          seen.add(wd);
          if (seen.size < 6) {
            err(`${RDY}: 서로 다른 원인이 같은 코드로 뭉개집니다 (${seen.size}종)`
              + ' — 1037회가 무엇이었는지 알 수 없게 됩니다');
          }
          // ② 출금 권한 미확인(null)을 통과로 적지 않는가
          for (const v of [null, undefined]) {
            if (rm.diagnoseCredential({ ...okc, hasWithdrawal: v }) !== 'WITHDRAWAL_ENABLED') {
              err(`${RDY}: 출금 권한 미확인을 "없음"으로 읽습니다`);
            }
          }
          // ③ 사유 문구에 값이 들어가지 않는가
          if (typeof rm.credentialDiagnosisReason === 'function') {
            for (const c of ['NO_CONNECTION', 'WITHDRAWAL_ENABLED', 'DECRYPT_FAILED']) {
              const r = String(rm.credentialDiagnosisReason(c) ?? '');
              if (/[A-Za-z0-9+/]{20,}={0,2}/.test(r)) {
                err(`${RDY}: ${c} 사유에 값처럼 보이는 문자열이 있습니다`);
              }
            }
          }
          // ④ 현재 실제 상태(Gate TESTNET 1 + Binance LIVE 2)가 READY가 아닌가
          const now = rm.binanceTestnetReadiness([
            { connectionId: 'gate', exchange: 'gate', testnet: true, active: true,
              permissionRead: true, permissionTrade: false, hasWithdrawal: false },
            { connectionId: 'bn1', exchange: 'binance', testnet: false, active: true,
              permissionRead: true, permissionTrade: true, hasWithdrawal: false },
            { connectionId: 'bn2', exchange: 'binance', testnet: false, active: true,
              permissionRead: true, permissionTrade: true, hasWithdrawal: false },
          ]);
          if (now?.code !== 'NO_BINANCE_TESTNET_CONNECTION') {
            err(`${RDY}: Gate TESTNET·Binance LIVE만 있는데 ${now?.code}로 읽습니다`
              + ' — 기존 연결을 TESTNET 후보로 세면 거짓 표본이 쌓입니다');
          }
          // ⑤ 빈 목록을 통과시키지 않는가
          for (const x of [[], null, undefined]) {
            if (rm.binanceTestnetReadiness(x)?.ready !== false) {
              err(`${RDY}: 연결이 없는데 준비됐다고 적습니다`);
            }
          }
          // ⑥ 출금 권한이 거래 권한보다 먼저 막는가
          const wo = rm.binanceTestnetReadiness([{ connectionId: 'x', exchange: 'binance',
            testnet: true, active: true, permissionRead: true, permissionTrade: false,
            hasWithdrawal: true }]);
          if (wo?.code !== 'WITHDRAWAL_PERMISSION_PRESENT') {
            err(`${RDY}: 출금 가능한 키를 ${wo?.code}까지 들여다봅니다`);
          }
          // ⑦ Gate TESTNET이 Exact100X 표본 자격을 얻지 않는가
          const g = rm.sampleReadiness({ testnet: true, exchange: 'gate', side: 'LONG',
            executionIdentity: { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X',
              contractVersion: 2 }, positionAmt: 0.01 });
          if (g?.code !== 'VENUE_UNSUPPORTED') {
            err(`${RDY}: Gate TESTNET을 ${g?.code}로 읽습니다 — VENUE_UNSUPPORTED여야 합니다`);
          }
          // ⑧ 모듈이 주문·DB·연결 생성 수단을 내보내지 않는가
          for (const bad of ['sendClose', 'placeFuturesOrder', 'createConnection',
                             'setTestnet', 'decryptSecret', 'applyMigration']) {
            if (Object.keys(rm).includes(bad)) err(`${RDY}: ${bad}를 내보냅니다`);
          }
        }

        // 자격 판독이 **한 벌인가.** 두 벌이면 한쪽만 고치고 끝난다
        // (실제로 이 파일에 같은 구현이 두 벌 있었고, 그래서 뭉개진 문장이
        //  두 자리에 남아 있었다).
        const CRD = 'src/lib/engine/connectionCreds.ts';
        const csrc = code(CRD);
        if (!csrc.trim()) err(`${CRD}: 자격 판독 정본이 없습니다`);
        else if (!/diagnoseCredential\(/.test(csrc)) {
          err(`${CRD}: 자격 진단 정본을 쓰지 않습니다`
            + ' — 실패 원인이 다시 한 문장으로 뭉개집니다');
        }

        // 라우트가 그 정본을 쓰고, 세 사실을 한 문장으로 되돌리지 않는가
        const rsrc = code(MON5);
        if (!/makeCredsReader\(/.test(rsrc)) {
          err(`${MON5}: 공용 자격 판독기를 쓰지 않습니다`);
        }
        // 라우트 안에 **연결 범위** 판독기를 다시 만들지 않는가.
        //
        //   `runPositionGuards`의 user 범위 판독(`.eq('user_id', ...)`)은
        //   다른 관심사다 — `connFor` 주입으로 시험이 붙어 있고 출금 권한을
        //   보지 않는다. 그것까지 금지하면 검사기가 거짓말을 한다.
        //   여기서 막는 것은 **연결 id로 읽는 자격 판독의 복제**다.
        if (/\.eq\('id',\s*connectionId\)/.test(rsrc)) {
          err(`${MON5}: 연결 범위 자격 판독을 라우트 안에서 다시 구현합니다`
            + ' — 두 벌이 되면 한쪽만 고치게 됩니다 (실제로 그랬다)');
        }

        // ★ **진단한 경로마다 기록하는가.** "하나라도 있으면 통과"로 두면
        //   세 경로 중 하나에서 지워도 초록이 된다(RDY10b가 그렇게 새 나갔다).
        //   진단한 수와 기록한 수가 같아야 한다.
        {
          const diagCount = (rsrc.match(/creds\.codeOf\(/g) || []).length;
          const recCount = (rsrc.match(/credentialCode:/g) || []).length;
          const pathCount = (rsrc.match(/\bpath:\s*'(GENERIC_PROTECTION_SWEEP|EXACT100X_AUTHORITY|GENERIC_MANAGED_POSITION)'/g) || []).length;
          if (diagCount < 3) {
            err(`${MON5}: 자격 코드를 쓰지 않는 실패 경로가 남아 있습니다 (${diagCount}곳)`
              + ' — 고아 정리·Exact100X 권한·생명주기 세 경로 전부여야 합니다');
          }
          if (recCount !== diagCount) {
            err(`${MON5}: 진단은 ${diagCount}곳인데 자격 코드를 ${recCount}곳만 남깁니다`
              + ' — 진단한 경로는 전부 기록해야 합니다');
          }
          if (pathCount !== diagCount) {
            err(`${MON5}: 진단은 ${diagCount}곳인데 경로 이름을 ${pathCount}곳만 적습니다`
              + ' — 경로를 안 적으면 Exact100X 실패와 섞여 셉니다');
          }
        }
        // ★ **결과를 실제로 쓰는가.** 함수를 불러 놓고 버리면 아무 의미가
        //   없다 — 검사기가 "호출했는가"만 보면 그것을 놓친다
        //   (RDY10·RDY13이 그렇게 새 나갔다).
        if (!/reason:\s*credentialDiagnosisReason\(/.test(rsrc)) {
          err(`${MON5}: 사유를 자격 진단 정본에서 만들지 않습니다`
            + ' — 세 가지 다른 실패가 다시 한 문장이 됩니다');
        }
        if (!/out\.failures\s*=\s*classifyFailures\(/.test(rsrc)) {
          err(`${MON5}: 경로별 집계 결과를 쓰지 않습니다`
            + ' — 불러 놓고 버리면 합계만 남습니다');
        }
        // ★ 뭉개진 옛 문장을 되돌리지 않는가. **주석이 아니라 코드**에서만 본다.
        {
          const COLLAPSED = '연결을 읽지 못했거나 출금 권한이 있는 키라 조회하지 않았습니다';
          if (rsrc.includes(COLLAPSED)) {
            err(`${MON5}: 세 가지 다른 실패를 한 문장으로 뭉개는 문구가 남아 있습니다`
              + ' — 어느 원인인지 알 수 없게 됩니다');
          }
        }
        if (!/path:\s*'GENERIC_PROTECTION_SWEEP'/.test(rsrc)) {
          err(`${MON5}: 보호주문 고아 정리 실패를 경로로 구분하지 않습니다`
            + ' — Exact100X 관측 실패와 섞여 셉니다');
        }
        // ★ 삭제된 과거 연결은 현재 자격 장애와 다르다.
        // 다른 연결로 추측해서 접근하지 않고, 반복 FAILED도 만들지 않는다.
        {
          const a = rsrc.indexOf('async function sweepOrphanProtection(');
          const b = rsrc.indexOf('async function recoverUnresolvedOrders(', a);
          const sweep = a >= 0 && b > a ? rsrc.slice(a, b) : '';
          if (!sweep) {
            err(`${MON5}: 보호주문 고아 정리 본문을 찾지 못했습니다`);
          } else {
            const iDisp = sweep.indexOf('const disp = sweepCredentialDisposition(dc)');
            const iSkip = sweep.indexOf('if (disp.skip)', iDisp);
            const iUnread = sweep.indexOf('out.unreadable += 1', iDisp);
            if (iDisp < 0 || iSkip < 0 || iUnread < 0 || !(iDisp < iSkip && iSkip < iUnread)) {
              err(`${MON5}: 삭제된 연결 분류가 unreadable 증가보다 앞에 있지 않습니다`
                + ' — 과거 connection_id가 회차 전체를 계속 FAILED로 만듭니다');
            }
            if (!/ok:\s*true,\s*skipped:\s*true/.test(sweep)) {
              err(`${MON5}: 삭제된 연결을 비실패 skip으로 기록하지 않습니다`);
            }
            if (!/out\.skipped\.push\(\{ code: disp\.code/.test(sweep)) {
              err(`${MON5}: 삭제된 연결 skip을 요약에 남기지 않습니다`);
            }
            if (!/skipped:\s*out\.skipped\.reduce/.test(sweep)) {
              err(`${MON5}: 보호주문 요약이 동적으로 추가된 skip을 세지 않습니다`);
            }
          }
        }
        // ★ 진단에 시크릿 **값**을 넘기지 않는가
        const dm = /diagnoseCredential\(\{([\s\S]{0,420}?)\}\);/.exec(csrc);
        if (!dm) {
          err(`${CRD}: 자격 진단 호출부를 찾지 못했습니다`);
        } else {
          for (const bad of [/api_secret_enc\s*[,}]/, /apiSecret:/, /plain\s*[,}]/,
                             /secret:\s*\w/, /\.length/]) {
            if (bad.test(dm[1])) {
              err(`${CRD}: 자격 진단에 시크릿 값·길이를 넘깁니다 (${bad})`
                + ' — 있다/없다만 넘겨야 합니다');
            }
          }
        }
      }
      // ── ⑤B-3A-2.3 관측 표 ACL — **RLS만으로 닫았다고 적지 않는다** ──
      //
      //   Supabase의 legacy default privileges가 새 public table에
      //   anon/authenticated 권한을 자동으로 줄 수 있다. RLS를 켜 두어도
      //   표 자체에는 닿을 수 있고, 정책 한 줄만 잘못 생기면 열린다.
      //   095가 GRANT/REVOKE 층을 닫는다.
      //
      //   판정은 `system/observationAcl.ts` 한 곳에 있고 **문자열 위치가
      //   아니라 문장을 끊어 동사·권한·표·role을 읽는다.** 검사기는 그
      //   함수를 **돌려서** 실제 095 파일을 본다 — 시험은 fixture로,
      //   여기서는 진짜 파일로. 판정 로직은 한 벌이다.
      {
        const ACLF = 'supabase/migrations/095_exact100x_observation_acl_hardening.sql';
        const ACLM = 'src/lib/system/observationAcl.ts';
        const am = await loadModule(ACLM, '관측 표 ACL 정본');
        if (!am || typeof am.checkObservationAcl !== 'function'
            || typeof am.parseAclStatements !== 'function') {
          err(`${ACLM}: 관측 표 ACL 정본이 없습니다`);
        } else {
          const sql = read(ACLF);
          if (!sql.trim()) {
            err(`${ACLF}이 없습니다 — anon/authenticated의 table privilege가 열린 채로 남습니다`);
          } else {
            const v = am.checkObservationAcl(sql);
            if (!v?.ok) err(`095 ACL ${v?.code}: ${v?.reason}`);

            // 두 표 · 세 role이 실제로 문장에 등장하는가
            const st = am.parseAclStatements(sql);
            for (const t of am.PROTECTED_OBSERVATION_TABLES) {
              if (!st.some(s => s.tables.includes(t))) {
                err(`095: ${t}에 대한 ACL 문장이 없습니다`);
              }
            }
            for (const r of [...am.PUBLIC_ROLES, am.SERVICE_ROLE]) {
              if (!st.some(s => s.roles.includes(r))) err(`095: ${r}에 대한 문장이 없습니다`);
            }
            // replay-safe — ACL 문장만 있고 데이터를 바꾸지 않는가
            for (const s of st) {
              if (s.verb === 'OTHER') {
                err(`095: ACL이 아닌 문장이 있습니다 (${s.raw.slice(0, 70)})`
                  + ' — 이 파일은 다시 돌려도 안전해야 합니다');
              }
            }
            // 거래·실행 판단에 손대지 않는가
            for (const bad of [/threshold/i, /ExitReason/i, /adverse/i, /emergency/i,
                               /leverage/i, /stop_?loss/i, /take_?profit/i]) {
              if (bad.test(sql)) err(`095가 거래 판단(${bad})을 건드립니다`);
            }
          }
          // manifest에 095가 있는가 (자동생성 — 다시 굽지 않으면 낡는다)
          const man095 = read('src/lib/system/migrationManifest.ts');
          if (!/name:\s*'095_exact100x_observation_acl_hardening\.sql'[^}]*id:\s*95\b/.test(man095)) {
            err('095가 manifest에 id 95로 없습니다 — `npm run gen:migrations`를 다시 실행해야 합니다');
          }
          if (!/name:\s*'095_exact100x_observation_acl_hardening\.sql'[^}]*risk:\s*'ADDITIVE'/
              .test(man095)) {
            err('095의 manifest risk가 ADDITIVE가 아닙니다');
          }
          // ★ checksum이 낡지 않았는가.
          //
          //   체크섬 계산을 여기서 **다시 구현하지 않는다.** 같은 판단이
          //   두 곳에 있으면 언젠가 갈린다 — 생성기의 함수를 그대로 쓴다
          //   (`gen-migration-manifest.mjs`의 loadPlan()이 같은 방식이다).
          try {
            const gen = await import('./gen-migration-manifest.mjs');
            const built = await gen.buildManifest();
            const want = gen.renderManifest(built);
            if (man095 !== want) {
              err('migrationManifest.ts가 낡았습니다 (체크섬·목록 불일치)'
                + ' — `npm run gen:migrations`를 실행하고 커밋해야 합니다');
            }
          } catch (e) {
            err(`manifest 신선도를 확인하지 못했습니다: ${String(e?.message || e)}`);
          }
        }
      }
      // ── ⑤B-3A-2 마이그레이션 계보 — **번호가 두 갈래로 갈라졌는가** ──
      //
      //   이 브랜치는 main에서 갈라진 뒤 자체 089를 만들었고, 그 사이
      //   main에도 089_auth_profile_identity_sync가 생겨 **production에
      //   이미 적용됐다.** 같은 번호가 두 SQL을 가리켰다.
      //
      //   로컬만 보면 보이지 않는다 — 번호를 바꾸고 manifest를 다시 구우면
      //   **자기 일관적이라** 기존 검사기가 전부 초록이다. 충돌은
      //   **base(main)에 대해서만** 보인다. 그래서 여기서 base를 읽는다.
      //
      //   판정은 `system/migrationLineage.ts` 한 곳에 있고, 이 검사기는
      //   이름이 아니라 **그 판정을 돌려서** 본다.
      {
        const LIN = 'src/lib/system/migrationLineage.ts';
        const lm = await loadModule(LIN, '마이그레이션 계보 정본');
        if (!lm || typeof lm.checkMigrationLineage !== 'function'
            || !Array.isArray(lm.EXACT100X_MIGRATIONS)) {
          err(`${LIN}: 마이그레이션 계보 정본이 없습니다`
            + ' — 번호 충돌이 base에 대해서만 보이므로 이 판정이 유일한 방어입니다');
        } else {
          const MIGD = 'supabase/migrations';
          const idOf = n => (/^(\d{3})_/.exec(n) ? Number(/^(\d{3})_/.exec(n)[1]) : null);
          // 작업 트리
          const files = readdirSync(MIGD).filter(n => n.endsWith('.sql')).sort()
            .map(n => ({ name: n, id: idOf(n), sql: read(`${MIGD}/${n}`) }));
          // base(origin/main). **못 읽으면 통과시키지 않는다** —
          // 비교하지 못한 것을 "겹치지 않음"으로 적는 순간 이 사고가 다시 난다.
          let baseFiles = [];
          let baseErr = null;
          try {
            const ls = execFileSync('git', ['ls-tree', '--name-only', 'origin/main', `${MIGD}/`],
              { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            const names = ls.split('\n').map(s => s.trim()).filter(s => s.endsWith('.sql'))
              .map(s => s.replace(`${MIGD}/`, ''));
            baseFiles = names.map(n => ({
              name: n, id: idOf(n),
              sql: execFileSync('git', ['show', `origin/main:${MIGD}/${n}`],
                { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }),
            }));
          } catch (e) { baseErr = String(e?.message || e); }

          if (baseErr || baseFiles.length === 0) {
            err('마이그레이션 계보: base(origin/main)를 읽지 못했습니다'
              + ` (${baseErr || '목록이 비었습니다'})`
              + ' — 얕은 체크아웃이면 전체 이력을 받아(fetch-depth 0) 다시 실행하세요.'
              + ' 비교하지 못한 것을 "겹치지 않음"으로 적지 않습니다');
          } else {
            const v = lm.checkMigrationLineage({ files, baseFiles });
            if (!v?.ok) {
              err(`마이그레이션 계보 ${v?.code}: ${v?.reason}`);
            }
            // base의 089는 **내용까지** 같아야 한다 (이미 적용된 파일이다)
            const AUTH = '089_auth_profile_identity_sync.sql';
            const b089 = baseFiles.find(b => b.name === AUTH);
            const m089 = files.find(b => b.name === AUTH);
            if (!b089) {
              err(`마이그레이션 계보: base에 ${AUTH}이 없습니다 — base 선택이 잘못됐습니다`);
            } else if (!m089) {
              err(`마이그레이션 계보: ${AUTH}이 작업 트리에 없습니다`
                + ' — production ledger에 이미 적용된 파일입니다');
            } else if (m089.sql !== b089.sql) {
              err(`마이그레이션 계보: ${AUTH}이 base와 다릅니다 — 내용 변경 없이 복원해야 합니다`);
            }
            // ⑤B 다섯 개가 manifest에 **같은 번호로** 실려 있는가.
            // manifest는 자동생성이다 — 다시 굽지 않으면 옛 번호가 남는다.
            const man = read('src/lib/system/migrationManifest.ts');
            for (const d of lm.EXACT100X_MIGRATIONS) {
              const re = new RegExp(`name:\\s*'${d.name.replace(/\./g, '\\.')}'[^}]*id:\\s*${d.id}\\b`);
              if (!re.test(man)) {
                err(`마이그레이션 계보: manifest에 ${d.name}이 id ${d.id}로 없습니다`
                  + ' — `npm run gen:migrations`를 다시 실행해야 합니다');
              }
            }
            // base의 번호 있는 파일은 **전부** manifest에 있어야 한다.
            // 한 줄만 빠져도 화면은 조용히 옛 기준으로 초록을 켠다.
            for (const b of baseFiles) {
              if (b.id == null) continue;
              if (!man.includes(`name: '${b.name}'`)) {
                err(`마이그레이션 계보: manifest에 base의 ${b.name}이 없습니다`
                  + ' — `npm run gen:migrations`를 다시 실행해야 합니다');
              }
            }
            // 옛 번호가 manifest에 남아 있지 않은가
            for (const stale of ['089_live_orders_execution_identity.sql',
                                 '090_live_orders_entry_risk_snapshot.sql',
                                 '091_exact100x_risk_observations.sql',
                                 '092_exact100x_risk_observations_rls.sql',
                                 '093_exact100x_exit_escape_observations.sql']) {
              if (man.includes(`'${stale}'`)) {
                err(`마이그레이션 계보: manifest에 옛 이름 ${stale}이 남아 있습니다`);
              }
            }
            // 이름만 옮기고 **의미를 바꾸지 않았는가.** 각 파일이 약속한
            // 것이 그대로 있는지 본다 — rename이라고 말하면서 SQL을 고치면
            // 여기서 걸린다.
            const PROMISES = [
              ['090_live_orders_execution_identity.sql',
                ['execution_profile_id', 'execution_preset_id', 'execution_contract_version']],
              ['091_live_orders_entry_risk_snapshot.sql',
                ['entry_adverse_distance_pct', 'entry_liquidation_distance_pct_raw']],
              ['092_exact100x_risk_observations.sql',
                ['exact100x_risk_observations', 'sample_origin']],
              ['093_exact100x_risk_observations_rls.sql',
                ['ENABLE ROW LEVEL SECURITY', 'service_role']],
              ['094_exact100x_exit_escape_observations.sql',
                ['exact100x_exit_escape_observations', 'ENABLE ROW LEVEL SECURITY', 'service_role']],
            ];
            for (const [name, needles] of PROMISES) {
              const sql = read(`${MIGD}/${name}`);
              if (!sql.trim()) { err(`마이그레이션 계보: ${name}이 비었습니다`); continue; }
              for (const n of needles) {
                if (!sql.includes(n)) {
                  err(`마이그레이션 계보: ${name}이 ${n}을 더는 선언하지 않습니다`
                    + ' — 번호만 옮긴 것이 아니라 의미가 바뀌었습니다');
                }
              }
            }
          }
        }
      }
        // ── ⑤B-3A-1 탈출 계측 — 재기만 하는가, 제대로 재는가 ──
      {
        const ESC = 'src/lib/engine/escapeObservationStore.ts';
        const SLP = 'src/lib/engine/closeSlippage.ts';
        const MON = 'src/lib/system/monotonicClock.ts';

        // 단조 시계 정본이 Date.now로 되돌아가지 않는가
        const msrc = code(MON);
        if (!msrc.trim()) err(`${MON}: 단조 시계 정본이 없습니다`);
        else if (/Date\.now/.test(msrc)) {
          err(`${MON}: 단조 시계 정본이 Date.now를 씁니다`
            + ' — 시계 보정에 오염된 줄을 나중에 구분할 수 없습니다');
        }

        // 슬리피지 정본: 부호 규칙과 문턱 없음
        const sm = await loadModule(SLP, '종료 슬리피지 정본');
        if (!sm || typeof sm.closeSlippage !== 'function') {
          err(`${SLP}: closeSlippage 정본이 없습니다`);
        } else {
          const L = sm.closeSlippage({ side: 'LONG', markPrice: 50_000, fillPrice: 49_900 });
          const S = sm.closeSlippage({ side: 'SHORT', markPrice: 50_000, fillPrice: 50_100 });
          if (!(L.adverseCloseSlippagePct > 0) || !(S.adverseCloseSlippagePct > 0)) {
            err(`${SLP}: 불리한 체결이 양수가 아닙니다`
              + ` (LONG ${L.adverseCloseSlippagePct} · SHORT ${S.adverseCloseSlippagePct})`
              + ' — 방향이 섞이면 두 분포가 서로 뒤집힌 채 한 통에 담깁니다');
          }
          for (const bad of [
            { side: 'LONG', markPrice: null, fillPrice: 49_900 },
            { side: 'LONG', markPrice: 50_000, fillPrice: null },
            { side: 'LONG', markPrice: 0, fillPrice: 49_900 },
          ]) {
            if (sm.closeSlippage(bad).adverseCloseSlippagePct != null) {
              err(`${SLP}: 모르는 슬리피지를 숫자로 적습니다 — 분포가 0으로 쏠립니다`);
            }
          }
          const ssrc = code(SLP);
          if (/\b\d+(\.\d+)?\s*(?:\/\/|$)/m.test('') || /threshold|tolerance/i.test(ssrc)) {
            err(`${SLP}: 슬리피지 정본에 문턱이 있습니다`);
          }
        }

        // 실행 경로 계측: 구간이 따로이고, 순서를 바꾸지 않았는가
        const rm2 = await loadModule(RUN, '종료 권한 실행 정본');
        if (rm2 && typeof rm2.runExitAuthority === 'function') {
          const EID2 = { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2 };
          const log2 = [];
          let tick = 0;
          const r7 = await rm2.runExitAuthority({
            positionIdentity: { exchange: 'binance', connectionId: 'c1', symbol: 'BTCUSDT',
              side: 'LONG', executionIdentity: EID2, openingOrderId: 'o1' },
            strategyId: 'scalp', executionIdentity: EID2,
            capabilities: { fixedStopAtEntry: false, breakEven: false, trailing: false,
              timeExit: true, emergency: false },
            reason: 'TIME_EXIT', openedAtMs: Date.now() - 9 * 3600 * 1000,
          }, {
            leaseOwned: async () => { log2.push('lease'); return { owned: true, identity: { holder: 'w', fence: 1 } }; },
            prepareClose: async () => { log2.push('prepare'); return { code: 'READY', message: '',
              prepared: { quantity: 1, orderSide: 'SELL', reduceOnly: true, observedQty: 1,
                positionMode: 'ONE_WAY' } }; },
            revalidateFence: async () => { log2.push('revalidate'); return true; },
            sendClose: async () => { log2.push('send'); return { attempted: true, ok: true,
              error: null, reportedAvgPrice: 49_900 }; },
            readAfter: async () => { log2.push('readAfter'); return { ok: true, found: false }; },
            monotonicNowMs: () => (tick += 1),
          }, Date.now());

          // 계측이 순서를 바꾸지 않았는가
          if (log2.join('>') !== 'lease>prepare>revalidate>send>readAfter') {
            err(`${RUN}: 계측 때문에 경로 순서가 바뀌었습니다 (${log2.join('>')})`);
          }
          const t7 = r7?.timing ?? {};
          for (const k of ['leaseCheckElapsedMs', 'prepareCloseElapsedMs',
                           'fenceRevalidationElapsedMs', 'criticalWindowElapsedMs',
                           'submitElapsedMs', 'submitAcceptedToFirstReadAfterMs']) {
            if (t7[k] == null) err(`${RUN}: ${k}를 재지 않습니다`);
          }
          // ★ critical window를 0으로 적지 않는가
          if (!(t7.criticalWindowElapsedMs > 0)) {
            err(`${RUN}: 재검증→전송 구간을 재지 않고 ${t7.criticalWindowElapsedMs}로 적습니다`
              + ' — 왕복이 0이라고 시간이 0인 것은 아닙니다');
          }
          // ★ 평균가를 버리지 않는가
          if (r7?.reportedAvgPrice !== 49_900) {
            err(`${RUN}: 거래소가 준 평균 체결가를 버립니다 (${r7?.reportedAvgPrice})`
              + ' — 그 값이 없으면 종료 슬리피지를 낼 수 없습니다');
          }
          // ★ 첫 재조회를 실제 flat 시간이라고 부르지 않는가
          if ('actualTimeToFlatMs' in t7) {
            err(`${RUN}: 첫 재조회 지연을 actualTimeToFlatMs라고 적습니다`
              + ' — 재조회는 한 번뿐이라 실제 flat 시각은 모릅니다');
          }
          if (t7.flatObservedAtFirstRead !== true) {
            err(`${RUN}: 첫 재조회 결과를 적지 않습니다`);
          }
          // ★ 단조 시계가 없으면 재지 않는가
          const r8 = await rm2.runExitAuthority({
            positionIdentity: { exchange: 'binance', connectionId: 'c1', symbol: 'BTCUSDT',
              side: 'LONG', executionIdentity: EID2, openingOrderId: 'o1' },
            strategyId: 'scalp', executionIdentity: EID2,
            capabilities: { fixedStopAtEntry: false, breakEven: false, trailing: false,
              timeExit: true, emergency: false },
            reason: 'TIME_EXIT', openedAtMs: Date.now() - 9 * 3600 * 1000,
          }, {
            leaseOwned: async () => ({ owned: true, identity: { holder: 'w', fence: 1 } }),
            prepareClose: async () => ({ code: 'READY', message: '',
              prepared: { quantity: 1, orderSide: 'SELL', reduceOnly: true, observedQty: 1,
                positionMode: 'ONE_WAY' } }),
            revalidateFence: async () => true,
            sendClose: async () => ({ attempted: true, ok: true, error: null }),
            readAfter: async () => ({ ok: true, found: false }),
            monotonicNowMs: () => null,
          }, Date.now());
          if (r8?.timing?.submitElapsedMs != null) {
            err(`${RUN}: 단조 시계가 없는데 구간 시간을 지어냅니다`);
          }
        }

        // 적재기: 다른 표에 쓰는가, 출처를 섞지 않는가, 주문 수단이 없는가
        const em2 = await loadModule(ESC, '탈출 계측 적재기');
        if (!em2 || typeof em2.recordEscapeObservation !== 'function') {
          err(`${ESC}: 탈출 계측 적재기가 없습니다`);
        } else {
          for (const bad of ['sendClose', 'sendSymbolClose', 'placeFuturesOrder',
                             'runExitAuthority', 'closePosition']) {
            if (Object.keys(em2).includes(bad)) {
              err(`${ESC}: 적재기가 ${bad}를 내보냅니다`);
            }
          }
          const T = { leaseCheckElapsedMs: 5, prepareCloseElapsedMs: 180,
            fenceRevalidationElapsedMs: 6, criticalWindowElapsedMs: 0.2,
            submitElapsedMs: 210, submitAcceptedToFirstReadAfterMs: 90,
            flatObservedAtFirstRead: true };
          const EI = (o = {}) => ({
            sampleOrigin: 'SYNTHETIC_TEST_ONLY', env: 'TESTNET', connectionId: 'c1',
            symbol: 'BTCUSDT', side: 'LONG',
            executionIdentity: { profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X',
              contractVersion: 2 },
            wakeSource: 'worker', wakeDelayMs: null, configuredIntervalMs: 300_000,
            observation: { markReadElapsedMs: 12, bracketReadElapsedMs: 8,
              positionRiskElapsedMs: 74, riskMeasurementElapsedMs: 0.4 },
            timing: T, runCode: 'CLOSED_VERIFIED', attemptedWrite: true, accepted: true,
            flatVerified: true, requestedQuantity: 1, reportedAvgPrice: 49_900,
            exchangeOrderId: 'o-1', executedQty: 0.6, markAtSubmit: 50_000,
            signedPositionAmt: 1, testnet: true, exchange: 'binance', ...o,
          });
          const row2 = em2.escapeObservationRow(EI());
          if (row2.requested_quantity === row2.executed_qty) {
            err(`${ESC}: 보낸 수량과 체결 수량을 같은 칸으로 적습니다`);
          }
          if (!(row2.adverse_close_slippage_pct > 0)) {
            err(`${ESC}: 슬리피지를 계산하지 않거나 부호가 뒤집혔습니다`
              + ` (${row2.adverse_close_slippage_pct})`);
          }
          if (em2.escapeObservationRow(EI({ markAtSubmit: null })).adverse_close_slippage_pct != null) {
            err(`${ESC}: 마크가가 없는데 슬리피지를 지어냅니다`);
          }
          if (em2.escapeObservationRow(EI({ wakeDelayMs: null })).wake_delay_ms != null) {
            err(`${ESC}: 모르는 wake 지연을 숫자로 추정합니다`);
          }
          for (const k of Object.keys(row2)) {
            if (/key|secret|signature|token|passphrase|raw/i.test(k)) {
              err(`${ESC}: 계측 줄에 시크릿성 칸이 있습니다 (${k})`);
            }
            if (/actual_time_to_flat/i.test(k)) {
              err(`${ESC}: 실제 flat 시간 칸을 만들었습니다 (${k})`);
            }
            if (/threshold|tolerance|verdict/i.test(k)) {
              err(`${ESC}: 계측 줄에 판정 칸이 있습니다 (${k})`);
            }
          }
          const seen3 = [];
          const sb3 = { from: (t) => ({ insert: async (r9) => {
            seen3.push({ t, r9 }); return { error: null }; } }) };
          if ((await em2.recordEscapeObservation(sb3, EI()))?.code !== 'RECORDED'
              || seen3[0]?.t !== 'exact100x_exit_escape_observations') {
            err(`${ESC}: 계측을 "${seen3[0]?.t}"에 씁니다`
              + ' — 위험 스냅숏 표와 결이 다릅니다');
          }
          for (const env3 of ['LIVE', 'MOCK']) {
            seen3.length = 0;
            const rr3 = await em2.recordEscapeObservation(sb3,
              EI({ sampleOrigin: 'VERIFIED_TESTNET_OBSERVATION', env: env3 }));
            if (rr3?.code !== 'ORIGIN_IMPOSSIBLE' || seen3.length !== 0) {
              err(`${ESC}: ${env3} 계측이 VERIFIED_TESTNET으로 쌓입니다`);
            }
          }
          seen3.length = 0;
          const rr4 = await em2.recordEscapeObservation(sb3, EI({
            sampleOrigin: 'VERIFIED_TESTNET_OBSERVATION',
            executionIdentity: { profileId: 'SCALP_HIGH_LEV', presetId: 'STABILIZE',
              contractVersion: 2 } }));
          if (rr4?.code !== 'NOT_ELIGIBLE' || seen3.length !== 0) {
            err(`${ESC}: 다른 계약의 종료가 Exact100X 계측 표본에 섞입니다`);
          }
        }

        // ★ ESC3 — 거래소 계층이 평균가를 **실제로 끌어올리는가.**
        //
        //   `binanceFutures`는 node `crypto` 때문에 검사기가 컴파일하지
        //   못한다. 그래서 주입한 가짜 `sendClose`만 보면 그 계층이
        //   값을 버려도 통과한다(실제로 한 번 새 나갔다). 원본을 본다.
        {
          const bfRaw = code('src/lib/exchanges/binanceFutures.ts');
          const i2 = bfRaw.indexOf('export async function sendPreparedClose');
          const body4 = i2 < 0 ? '' : bfRaw.slice(i2, i2 + 1800);
          if (i2 < 0) {
            err('binanceFutures: sendPreparedClose를 찾지 못했습니다');
          } else {
            if (!/reportedAvgPrice/.test(body4)) {
              err('binanceFutures.sendPreparedClose가 평균 체결가를 돌려주지 않습니다'
                + ' — 그 값이 없으면 종료 슬리피지를 낼 수 없습니다');
            }
            const m4 = /const\s+reportedAvgPrice\s*=([^;]*);/.exec(body4);
            if (!m4) {
              err('binanceFutures.sendPreparedClose: 평균가를 응답에서 꺼내지 않습니다');
            } else if (!/\br\b|raw/.test(m4[1]) || /^\s*null\s*$/.test(m4[1])) {
              err(`binanceFutures.sendPreparedClose가 평균가를 버립니다 (${m4[1].trim()})`
                + ' — 응답에서 꺼내야 합니다');
            }
          }
          const vopRaw = code('src/lib/engine/venuePositionOps.ts');
          const i3 = vopRaw.indexOf('export async function sendSymbolClose');
          const body5 = i3 < 0 ? '' : vopRaw.slice(i3, i3 + 2200);
          if (i3 >= 0 && !/reportedAvgPrice:\s*r\?\.reportedAvgPrice/.test(body5)) {
            err('venuePositionOps.sendSymbolClose가 평균 체결가를 통과시키지 않습니다');
          }
        }

        // 094 보안
        const mig94 = read('supabase/migrations/094_exact100x_exit_escape_observations.sql');
        if (!mig94.trim()) err('094 마이그레이션이 없습니다');
        else {
          if (!/ENABLE ROW LEVEL SECURITY/i.test(mig94)) {
            err('094: RLS가 켜져 있지 않습니다');
          }
          if (!/CREATE POLICY[\s\S]{0,200}TO service_role/i.test(mig94)) {
            err('094: service_role 정책이 없습니다');
          }
          for (const role of ['anon', 'authenticated']) {
            if (new RegExp(`CREATE POLICY[\\s\\S]{0,300}TO\\s+[^;]*\\b${role}\\b`, 'i').test(mig94)) {
              err(`094: ${role}에 정책을 열었습니다`);
            }
          }
          if (!/CHECK\s*\([\s\S]{0,200}VERIFIED_TESTNET_OBSERVATION[\s\S]{0,120}env\s*=\s*'TESTNET'/i
              .test(mig94)) {
            err('094: VERIFIED_TESTNET → TESTNET 제약이 없습니다');
          }
          // **칸 정의만** 본다. 주석에 "그 칸을 만들지 않았다"고 적은
          // 문장을 금지어로 잡으면, 이유를 설명하는 글이 규칙을 깬다.
          const ddl93 = mig94.split('\n')
            .filter(l => !/^\s*(--|\*|\/\*)/.test(l)).join('\n');
          if (/^\s*actual_time_to_flat\w*\s+\w/im.test(ddl93)) {
            err('094: 실제 flat 시간 칸을 만들었습니다 — 재조회는 한 번뿐입니다');
          }
          for (const bad of [/ALTER\s+COLUMN/i, /DROP\s+(COLUMN|TABLE)/i,
                             /\bUPDATE\s+public\./i, /\bDELETE\s+FROM/i]) {
            if (bad.test(mig94)) err(`094: 파괴적 문장이 있습니다 (${bad})`);
          }
        }

        // 감시 라우트의 계측 적재가 **주문을 내지 않는가**
        const monEsc = code(MON5);
        // ★ **블록 전체를 본다.** `recordEscapeObservation` 호출부에서
        //   창을 시작하면 그 **앞**에 끼워 넣은 주문 호출을 놓친다
        //   (실제로 ESC10이 그렇게 새 나갔다).
        const iEsc = monEsc.indexOf("if (r.attemptedWrite === true) {");
        if (iEsc < 0 || monEsc.indexOf('recordEscapeObservation(sb') < 0) {
          err(`${MON5}: 탈출 계측을 적재하지 않습니다`);
        } else {
          const body3 = monEsc.slice(iEsc, iEsc + 3500);
          for (const bad of ['sendSymbolClose', 'prepareSymbolClose', 'runExitAuthority']) {
            if (body3.includes(bad)) {
              err(`${MON5}: 계측 적재 블록이 ${bad}를 부릅니다 — 주문 0건이어야 합니다`);
            }
          }
          if (!/sampleOrigin:\s*'VERIFIED_TESTNET_OBSERVATION'/.test(body3)) {
            err(`${MON5}: 계측 표본 출처를 적지 않습니다`);
          }
          if (!/wakeSource:\s*wake\.source/.test(body3)) {
            err(`${MON5}: wake source를 헤더 정본에서 가져오지 않습니다`);
          }
        }

        // ── ⑤B-3A-1.1 wake provenance — **틀린 값을 적지 않는가** ──
        //
        //   라우트는 `x-traigo-source`가 없으면 `'manual'`로 적고 있었다.
        //   Vercel Cron은 Bearer로 인증하고 그 헤더를 보내지 않으므로,
        //   **실제 자동 cron 호출이 전부 manual로 적혔다.** UNKNOWN이
        //   아니라 거짓이었다.
        //
        //   판정은 `engine/exitMonitorWake.ts` 한 곳에 있고 node 내장을
        //   쓰지 않으므로, 이 검사기는 이름이 아니라 **동작을 돌려서** 본다.
        {
          const WK = 'src/lib/engine/exitMonitorWake.ts';
          const wm = await loadModule(WK, 'wake provenance 정본');
          if (!wm || typeof wm.resolveWakeSource !== 'function'
              || typeof wm.resolveWakeCadence !== 'function'
              || typeof wm.wakeCadenceHeaders !== 'function') {
            err(`${WK}: wake provenance 정본이 없습니다`
              + ' — 누가 깨웠는지를 라우트가 추측하게 됩니다');
          } else {
            // ① 헤더가 없다고 manual로 적지 않는가
            for (const kind of ['CRON_BEARER', 'ADMIN_HEADER']) {
              for (const empty of [null, '', '  ']) {
                const got = wm.resolveWakeSource(empty, kind);
                if (got === 'manual') {
                  err(`${WK}: source 헤더가 없는데 manual로 적습니다 (${kind})`
                    + ' — 실제 자동 호출이 전부 사람이 부른 것으로 기록됩니다');
                }
                if (got == null) {
                  err(`${WK}: 인증된 호출(${kind})의 출처가 비었습니다`);
                }
              }
            }
            // ② 두 인증 경로가 한 이름으로 합쳐지지 않는가
            const cron = wm.resolveWakeSource(null, 'CRON_BEARER');
            const admin = wm.resolveWakeSource(null, 'ADMIN_HEADER');
            if (cron === admin) {
              err(`${WK}: Bearer cron과 admin 호출을 같은 이름("${cron}")으로 적습니다`
                + ' — 어느 쪽이 깨웠는지 영구히 복원할 수 없습니다');
            }
            // ③ 명시한 값은 보존되는가
            if (wm.resolveWakeSource('worker', 'CRON_BEARER') !== 'worker'
                || wm.resolveWakeSource('github-backup', 'ADMIN_HEADER') !== 'github-backup') {
              err(`${WK}: 명시한 source를 인증 경로로 덮어씁니다`);
            }
            // ④ 인증 실패는 출처가 없다
            if (wm.resolveWakeSource(null, 'NONE') != null) {
              err(`${WK}: 인증되지 않은 호출에 출처를 붙입니다`);
            }
            // ⑤ 예정 시각을 모르면 지연은 null — 0도 5분도 아니다
            for (const exp of [null, '', '0', 'abc']) {
              const c = wm.resolveWakeCadence({
                intervalHeader: '300000', expectedAtHeader: exp, observedAtMs: 1_780_000_000_000 });
              if (c?.delayMs != null) {
                err(`${WK}: 예정 시각 없이 wake 지연을 ${c.delayMs}로 적습니다`
                  + ' — 0은 "정시"라는 다른 사실이고 300000은 추정입니다');
              }
            }
            // ⑥ 간격을 모르면 null — 상수로 메우지 않는가
            for (const iv of [null, '', '0', 'abc']) {
              const c = wm.resolveWakeCadence({
                intervalHeader: iv, expectedAtHeader: null, observedAtMs: 1_780_000_000_000 });
              if (c?.intervalMs != null) {
                err(`${WK}: 간격을 모르는데 ${c.intervalMs}로 적습니다`);
              }
            }
            // ⑦ 알려 준 값은 실제로 쓰이는가 (상수로 못박히지 않았는가)
            {
              const c = wm.resolveWakeCadence({ intervalHeader: '90000',
                expectedAtHeader: String(1_780_000_000_000 - 7_000),
                observedAtMs: 1_780_000_000_000 });
              if (c?.intervalMs !== 90_000 || c?.delayMs !== 7_000) {
                err(`${WK}: 알려 준 cadence를 그대로 쓰지 않습니다`
                  + ` (간격 ${c?.intervalMs} · 지연 ${c?.delayMs})`);
              }
            }
            // ⑧ 첫 tick에는 예정 시각을 지어내지 않는가
            {
              const h = wm.wakeCadenceHeaders({ lastRunMs: null, intervalMs: 300_000 });
              const k = Object.keys(h || {});
              if (k.some(x => /expected/i.test(x))) {
                err(`${WK}: 직전 실행이 없는데 예정 시각 헤더를 보냅니다`);
              }
              const h2 = wm.wakeCadenceHeaders({ lastRunMs: null, intervalMs: null });
              if (Object.keys(h2 || {}).length !== 0) {
                err(`${WK}: 모르는 cadence를 헤더로 보냅니다 — 키 자체가 없어야 합니다`);
              }
            }
          }

          // 라우트가 그 정본을 쓰는가 — `|| 'manual'`로 되돌아가지 않는가
          const rsrc = code(MON5);
          if (!/resolveWakeSource\(/.test(rsrc)) {
            err(`${MON5}: wake source 정본을 쓰지 않습니다`);
          }
          const runnerLine = /const\s+runner\s*=([^;]*);/.exec(rsrc);
          if (!runnerLine) {
            err(`${MON5}: wake source를 정하는 자리를 찾지 못했습니다`);
          } else if (/'manual'|"manual"/.test(runnerLine[1])) {
            err(`${MON5}: 헤더가 없을 때 manual로 적습니다 (${runnerLine[1].trim()})`
              + ' — Vercel cron은 그 헤더를 보내지 않습니다');
          }
          // 인증 결과를 boolean으로 버리지 않는가
          const authBody = /function authorized\(req: NextRequest\)([\s\S]{0,900}?)\n}/.exec(rsrc);
          if (!authBody) {
            err(`${MON5}: authorized를 찾지 못했습니다`);
          } else {
            if (!/CRON_BEARER/.test(authBody[1]) || !/ADMIN_HEADER/.test(authBody[1])) {
              err(`${MON5}: 인증 경로를 구분해서 돌려주지 않습니다`
                + ' — 헤더가 없으면 provenance를 복원할 수 없습니다');
            }
            if (/:\s*boolean\s*\{/.test(authBody[0])) {
              err(`${MON5}: 인증 결과를 boolean으로 버립니다`);
            }
          }
          // ★ cadence telemetry를 **판단에 쓰지 않는가** (ESC18c)
          //
          //   간격·지연은 provenance 전용이다. 이 값으로 종료를 앞당기거나
          //   건너뛰면 그 순간 telemetry가 실행 경로가 된다.
          for (const [f, label] of [[MON5, 'exit-monitor'],
                                    ['src/lib/engine/exitAuthorityRun.ts', 'exitAuthorityRun'],
                                    ['src/lib/engine/exitAuthority.ts', 'exitAuthority'],
                                    ['src/lib/engine/venuePositionOps.ts', 'venuePositionOps']]) {
            const body = code(f);
            for (const line of body.split('\n')) {
              if (!/\b(wakeCadence|wake)\.(delayMs|intervalMs)\b/.test(line)) continue;
              if (/\b(if|while|switch)\s*\(/.test(line)
                  || /[<>]=?|===|!==|&&|\|\||\?\s*[^?:]*:/.test(line)) {
                err(`${label}: cadence telemetry를 판단에 씁니다 (${line.trim().slice(0, 90)})`
                  + ' — 간격·지연은 provenance 전용입니다');
              }
            }
          }

          // 부르는 쪽이 **자기가 실제로 쓰는** 값을 보내는가
          const wsrc = code('worker/src/index.ts');
          if (!/wakeCadenceHeaders\(/.test(wsrc)) {
            err('worker: 실제 간격·예정 시각을 알려주지 않습니다'
              + ' — 라우트는 예정이 언제였는지 알 방법이 없습니다');
          } else {
            const mh = /const\s+wakeHeaders\s*=\s*wakeCadenceHeaders\(\{([\s\S]{0,240}?)\}\);/.exec(wsrc);
            if (!mh) {
              err('worker: cadence 헤더를 만드는 자리를 찾지 못했습니다');
            } else {
              if (!/intervalMs:\s*EXIT_MONITOR_MS/.test(mh[1])) {
                err(`worker: 실제 간격 대신 다른 값을 보냅니다 (${mh[1].replace(/\s+/g, ' ').trim()})`
                  + ' — EXIT_MONITOR_MS가 정본입니다');
              }
              if (!/lastRunMs:\s*lastExitMonitorMs/.test(mh[1])) {
                err('worker: 직전 실행 시각을 그대로 넘기지 않습니다');
              }
              // ★ 덮어쓰기 **전에** 읽는가. 뒤에서 만들면 예정 시각이
              //   "지금 + 간격"이 되어 항상 간격만큼 이르다고 적힌다.
              const iH = wsrc.indexOf('wakeCadenceHeaders({');
              const iW = wsrc.indexOf('lastExitMonitorMs = Date.now();');
              if (iH < 0 || iW < 0 || iH > iW) {
                err('worker: 직전 실행 시각을 덮어쓴 뒤에 예정 시각을 계산합니다'
                  + ' — 지연이 항상 음수가 됩니다');
              }
            }
          }
        }
      }

      // ── 관측 표의 **보안** — RLS 없이 열어 두지 않는가 ──
        //
        //   이 표에는 connection_id·방향·수량·진입가·청산가가 들어간다.
        //   public 스키마에 무보호로 두면 anon 키 하나로 전부 읽힌다.
        //   048·040·026은 전부 켜 두었다 — 092만 빠져 있었다.
        {
          const sec = read('supabase/migrations/092_exact100x_risk_observations.sql')
            + '\n' + read('supabase/migrations/093_exact100x_risk_observations_rls.sql');
          if (!sec.trim()) {
            err('관측 표 마이그레이션을 찾지 못했습니다');
          } else {
            if (!/ALTER TABLE[\s\S]{0,120}exact100x_risk_observations[\s\S]{0,80}ENABLE ROW LEVEL SECURITY/i
                .test(sec)) {
              err('exact100x_risk_observations: RLS가 켜져 있지 않습니다'
                + ' — connection_id·포지션·청산가가 무보호로 열립니다');
            }
            if (!/CREATE POLICY[\s\S]{0,200}TO service_role/i.test(sec)) {
              err('exact100x_risk_observations: service_role 정책이 없습니다');
            }
            // anon·authenticated에 쓰기를 열지 않는가
            for (const role of ['anon', 'authenticated']) {
              const re = new RegExp(`CREATE POLICY[\\s\\S]{0,300}TO\\s+[^;]*\\b${role}\\b`, 'i');
              if (re.test(sec)) {
                err(`exact100x_risk_observations: ${role}에 정책을 열었습니다`
                  + ' — 이 표는 service 경로 전용입니다');
              }
            }
            // VERIFIED_TESTNET → TESTNET 제약이 DB에도 있는가
            if (!/CHECK\s*\([\s\S]{0,200}VERIFIED_TESTNET_OBSERVATION[\s\S]{0,120}env\s*=\s*'TESTNET'/i
                .test(sec)) {
              err('exact100x_risk_observations: VERIFIED_TESTNET → TESTNET 제약이 없습니다'
                + ' — 런타임만 막으면 다른 경로가 생겼을 때 DB가 받아 줍니다');
            }
            // 기존 데이터를 고쳐서 맞추지 않는가
            for (const bad of [/\bUPDATE\s+public\.exact100x/i,
                               /\bDELETE\s+FROM\s+public\.exact100x/i]) {
              if (bad.test(sec)) {
                err('exact100x_risk_observations: 기존 줄을 고쳐서 제약을 맞춥니다'
                  + ' — 어긋난 줄이 있었다는 사실이 사라집니다');
              }
            }
          }
        }

        // 092이 ADDITIVE이고 기존 칸을 건드리지 않는가
        const mig = read('supabase/migrations/092_exact100x_risk_observations.sql');
        if (!mig) {
          err('092 마이그레이션이 없습니다');
        } else {
          for (const bad of [/ALTER\s+COLUMN/i, /DROP\s+(COLUMN|TABLE)/i,
                             /\bUPDATE\s+public\./i, /\bDELETE\s+FROM/i]) {
            if (bad.test(mig)) {
              err(`092: 파괴적 문장이 있습니다 (${bad}) — ADDITIVE여야 합니다`);
            }
          }
          if (!/sample_origin/.test(mig) || !/CHECK \(sample_origin IN/.test(mig)) {
            err('092: 표본 출처 칸과 제약이 없습니다 — 실측과 주입값이 섞입니다');
          }
          if (/sample_origin[^,]*DEFAULT/i.test(mig)) {
            err('092: sample_origin에 기본값이 있습니다'
              + ' — 모르고 실측으로 적히는 길을 열어 둡니다');
          }
        }
      }

      // ★ RK1 — 진입 스냅숏을 **허가 판정 결과에서** 꺼내는가
      {
        const sc2 = code('src/app/api/autotrade/scalp/route.ts');
        const iSnap = sc2.indexOf('entryRiskSnapshot');
        if (iSnap < 0) {
          err('scalp/route: 진입 위험 스냅숏을 주문에 넘기지 않습니다'
            + ' — 091 칸이 영원히 null이 되어 ⑤B가 쓸 기록이 생기지 않습니다');
        } else {
          const body = sc2.slice(iSnap, sc2.indexOf('}', sc2.indexOf('}', iSnap) + 1) + 1);
          if (!/prepared100x\.liquidation\.adverseDistancePct/.test(body)
              || !/prepared100x\.liquidation\.liquidationDistancePct/.test(body)) {
            err('scalp/route: 진입 위험 스냅숏이 허가 판정 결과에서 오지 않습니다'
              + ' — 저장된 값이 "허가를 내린 값"이 아니게 되어 칸의 뜻이 사라집니다');
          }
          if (/signal\.stopPct|signal\.stop\b|atr/i.test(body)) {
            err('scalp/route: 진입 위험 스냅숏을 신호에서 다시 계산합니다'
              + ' — 신호가 그 사이 바뀌었으면 장부가 거짓말을 합니다');
          }
        }
      }

      // 감시 라우트가 **측정만** 하는가
      const mon7raw = read(MON5);
      const mon7 = code(MON5);
      const iRisk = mon7.indexOf('measurePostEntryRisk');
      if (iRisk < 0) {
        err(`${MON5}: 위험 측정기를 부르지 않습니다`
          + ' — 만들어 놓고 배선하지 않으면 ⑤B-3이 쓸 관측이 생기지 않습니다');
      } else {
        const end = mon7.indexOf('for (const p of positions) {', iRisk);
        const body = end > iRisk ? mon7.slice(iRisk, end) : mon7.slice(iRisk, iRisk + 6000);
        for (const bad of ['sendSymbolClose', 'prepareSymbolClose', 'runExitAuthority',
                           'closePositionPercent', 'applyLifecycleClose']) {
          if (body.includes(bad)) {
            err(`${MON5}: 위험 측정 블록이 ${bad}를 부릅니다`
              + ' — ⑤B-0/1은 주문 0건이어야 합니다');
          }
        }
        // ★ RK14 — 관문을 **부르는 것**으로는 부족하다. 그 결과로
        //   실제로 건너뛰는지까지 본다 (`if (false)`로 바꿔치기 방지).
        if (!/exact100xExitVenueCapability\([^)]*\)\s*\.timeExit\s*!==\s*true\)\s*continue/
            .test(body)) {
          err(`${MON5}: 위험 측정이 거래소 관문으로 실제로 건너뛰지 않습니다`
            + ' — 감시가 권한보다 넓은 거래소를 보면 그쪽이 새 잠복 경로가 됩니다');
        }
        // ★ RK4 — MARK 정본이 **시장 스냅숏**인가.
        //   포지션 응답의 markPrice에는 시각이 없다.
        const rawBody = (() => {
          const i = mon7raw.indexOf('measurePostEntryRisk');
          const e = mon7raw.indexOf('for (const p of positions) {', i);
          return i < 0 ? '' : mon7raw.slice(i, e > i ? e : i + 8000);
        })();
        if (/mark:\s*rr\?\.risk|mark:[\s\S]{0,120}risk\.markPrice/.test(rawBody)) {
          err(`${MON5}: 위험 측정이 포지션 응답의 markPrice를 MARK로 씁니다`
            + ' — 그 값에는 시각이 없어 "언제의 가격인가"를 물을 수 없습니다');
        }
        if (!/mark:\s*snap\?\.snapshot/.test(body)) {
          err(`${MON5}: 위험 측정의 MARK가 시장 스냅숏에서 오지 않습니다`);
        }
      }
      // 091 후퇴가 **계약 칸을 함께 잃지 않는가**
      const lr = code('src/lib/engine/lifecycleRows.ts');
      for (const c of ['execution_profile_id', 'execution_preset_id',
                       'execution_contract_version']) {
        if (!new RegExp(`LIFECYCLE_SELECT_RISK[\\s\\S]{0,600}${c}`).test(lr)) {
          err(`lifecycleRows: 091 모양에 ${c}가 없습니다`
            + ' — 091을 적용한 DB가 실행 계약을 잃고 TIME_EXIT이 멈춥니다');
        }
      }
      for (const c of ['entry_adverse_distance_pct', 'entry_liquidation_distance_pct_raw']) {
        if (new RegExp(`LIFECYCLE_SELECT_IDENTITY[\\s\\S]{0,600}${c}`).test(lr)) {
          err(`lifecycleRows: 091 칸(${c})이 IDENTITY 모양에 남아 있습니다`
            + ' — 후퇴해도 같은 이유로 또 실패합니다');
        }
      }
      // 익절·트레일링이 함께 열리지 않았는가 (큰 Winner 보존)
      const prof = code('src/lib/strategies/profiles.ts');
      // **계약 본문 하나만 본다.** 창이 넓으면 다른 프로필의 익절 숫자를
      // 이 계약의 것으로 잘못 읽는다.
      const iMax = prof.indexOf('const MAX_LEV_100X');
      const pEnd = iMax < 0 ? -1 : prof.indexOf('\n};', iMax);
      const pbody = iMax < 0 ? '' : prof.slice(iMax, pEnd < 0 ? iMax + 3000 : pEnd);
      if (/takeProfitPct:\s*[0-9]/.test(pbody)) {
        err('profiles: Exact100X에 고정 익절 숫자가 들어왔습니다'
          + ' — 큰 Winner를 크게 가져가는 계약입니다');
      }
    }

    // ── ⑤A 안전 계약의 **최종 세 문장**이 그대로 있는가 ──
    //
    //   이 세 줄이 사라지거나 강해지면, 다음 사람은 이 경로가 strict
    //   single-writer라고 읽는다. 문장을 자산으로 취급한다.
    {
      const prose = read(RUN).replace(/^\s*(\/\/|\*)/gm, ' ').replace(/\s+/g, ' ');
      for (const must of [
        'exchange-level strict single-writer는 보장하지 않는다.',
        '안전성은 fence window 최소화 + reduceOnly + current exposure reconciliation에 의존한다.',
        'clientOrderId duplicate rejection은 추가 방어층이며 외부 검증 전제다.',
      ]) {
        if (!prose.includes(must)) {
          err(`${RUN}: ⑤A 안전 계약의 최종 문장이 없습니다 — "${must}"`
            + ' 이 문장이 사라지면 다음 사람이 이 경로를 strict single-writer로 읽습니다');
        }
      }
    }

    // 보낸 수량을 **체결량으로 적지 않는가**
    if (/closedQuantity/.test(runSrc)) {
      err(`${RUN}: 보낸 수량을 "닫힌 수량"으로 적습니다`
        + ' — 준비 뒤 일부가 수동 청산되면 그 숫자가 거짓이 됩니다 (flatVerified만 사실입니다)');
    }
  }

  // ── 아직 열지 않은 종료 사유를 열지 않았는가 ──
  {
    const authSrc = code(AUTH);
    const m = /export type ExitReason =([\s\S]{0,200}?);/.exec(authSrc);
    if (!m) {
      err(`${AUTH}: ExitReason을 찾지 못했습니다`);
    } else if (/ADVERSE|EMERGENCY|TRAIL|LIQUIDATION_BUFFER|BREAK_EVEN/i.test(m[1])) {
      err(`${AUTH}: 아직 구현이 없는 종료 사유가 ExitReason에 들어 있습니다 (${m[1].trim()})`
        + ' — 빈 기능을 이름으로 먼저 열지 않습니다');
    }
  }
}


// ── Exact100X maxOpenPositions=1: 선언이 아니라 실주문 경계 배선 ──
// 순수 단위 테스트만 있으면 호출부를 지워도 초록색이 된다.
{
  const scalp = code(SCALP);
  const cap = code('src/lib/engine/maxOpenPositionsGate.ts');
  if (!/epContract\?\.profileId\s*===\s*'MAX_LEV_100X'/.test(scalp)) {
    err('scalp: Exact100X 계좌 전체 포지션 상한을 적용하지 않습니다');
  }
  if (!/maxOpenPositions:\s*epContract\.maxOpenPositions/.test(scalp)
      || !/const capacity = await maxOpenPositionsGate\(/.test(scalp)) {
    err('scalp: maxOpenPositions 선언값을 실제 용량 관문으로 넘기지 않습니다');
  }
  const gateAt = scalp.indexOf('const capacity = await maxOpenPositionsGate(');
  const leverageAt = scalp.indexOf('const committed = await commitEntry100x(');
  if (gateAt < 0 || leverageAt < 0 || gateAt >= leverageAt) {
    err('scalp: 계좌 전체 상한이 거래소 배율 설정보다 앞에 있지 않습니다');
  }
  if (!/x100-capacity:\$\{userId\}:\$\{body\.connectionId\}/.test(scalp)) {
    err('scalp: BTC·ETH가 동일한 계좌 수준의 원자적 claim key를 쓰지 않습니다');
  }
  if (!/getFuturesPositions\(/.test(scalp)
      || !/getFuturesOpenOrders\(/.test(scalp)
      || !/countPendingEntries:\s*async/.test(scalp)) {
    err('scalp: 계좌 전체 포지션/미체결 주문/미확정 진입을 모두 조사하지 않습니다');
  }
  if (!/claim\.installed !== true/.test(cap)
      || !/claim\.error/.test(cap)
      || !/claim\.duplicate/.test(cap)
      || !/i\.mode !== 'TESTNET'/.test(cap)) {
    err('maxOpenPositionsGate: fail-closed 또는 TESTNET 전용 관문이 사라졌습니다');
  }
}

if (bad) {
  console.error(`\n전용 100배 계약 검사 실패: ${bad}건`);
  process.exit(1);
}
console.log('✅ 전용 100배 계약 (정확 100 · 고정 손절 없음 · 누출 0 · dormant)');
