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
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
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
const ENTRY       = 'src/lib/engine/entry100x.ts';
const SCALP       = 'src/app/api/autotrade/scalp/route.ts';
const RUNREQ      = 'src/lib/strategies/runRequest.ts';
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
  for (const f of ['stopPolicy', 'sizingPolicy']) {
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
    requiredLeverage: 100, observedLeverage: 100,
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
  must({ observedLeverage: 99 }, 'LEVERAGE_NOT_EXACT', '되읽은 배율이 99배면 막아야 합니다');
  must({ observedLeverage: 75 }, 'LEVERAGE_NOT_EXACT', '되읽은 배율이 75배면 막아야 합니다');
  must({ observedLeverage: null }, 'LEVERAGE_NOT_EXACT', '배율을 못 읽었으면 막아야 합니다');
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
    if (!/resolveExecutionProfile/.test(wired) || !/planEntry100x/.test(wired)) {
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
}

// ── 진입 계획 (가짜 어댑터로 실제 판정시킨다) ──
const entry = await loadModule(ENTRY, '100X 진입 계획');
if (entry) {
  const okDeps = (over = {}) => ({
    observeMarginMode: async () => 'isolated',
    applyLeverage: async (lev) => ({ ok: true, observed: lev, message: '' }),
    availableUsd: async () => 1000,
    referencePrice: async () => 50_000,
    quantize: async (q) => ({ qty: q, message: '' }),
    ...over,
  });
  const C = { leverage: 100, sizingPolicy: 'MARGIN_ALLOCATION', marginModes: ['isolated'] };
  const mustBlock = async (over, wantCode, why) => {
    const v = await entry.planEntry100x(C, 10, okDeps(over));
    if (v.ok) { err(`100X 진입: ${why} — 그런데 통과했습니다 (수량 ${v.quantity})`); return; }
    if (v.code !== wantCode) {
      err(`100X 진입: ${why} — 막긴 했지만 이유가 ${v.code}입니다 (${wantCode}이어야 합니다)`);
    }
  };
  const good = await entry.planEntry100x(C, 10, okDeps());
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
  await mustBlock({ referencePrice: async () => null },
    'SIZING_BLOCKED', '기준가를 못 읽으면 막아야 합니다');
  await mustBlock({ quantize: async () => ({ qty: null, message: '' }) },
    'QUANTIZE_FAILED', '거래소 규격에 못 맞추면 막아야 합니다');
  await mustBlock({ quantize: async () => ({ qty: 0.3, message: '' }) },
    'MARGIN_EXCEEDED', '올림해서 배정을 넘으면 막아야 합니다');

  // 배정 비율 미지정
  const noAlloc = await entry.planEntry100x(C, null, okDeps());
  if (noAlloc.ok) err('100X 진입: 배정 비율이 없는데 통과했습니다');

  // **마진 모드 확인이 배율 설정보다 먼저인가.** 교차 계좌에 배율부터
  // 걸면, 막을 주문을 위해 계좌 설정을 먼저 바꾸는 것이 된다.
  let applied = false;
  await entry.planEntry100x(C, 10, okDeps({
    observeMarginMode: async () => 'cross',
    applyLeverage: async (lev) => { applied = true; return { ok: true, observed: lev, message: '' }; },
  }));
  if (applied) err('100X 진입: 교차인 걸 알기 전에 배율을 걸었습니다 — 순서가 규칙의 일부입니다');
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

// 계약을 해석하지 않는 라우트는 계약을 **받지도** 않아야 한다
for (const f of ['src/app/api/autotrade/daily-ladder/route.ts',
                 'src/app/api/autotrade/my-original-v1/route.ts']) {
  const src = code(f);
  if (!src) { err(`${f}을(를) 읽지 못했습니다`); continue; }
  if (/planEntry100x/.test(src)) continue;   // 배선됐으면 이 규칙 대상이 아니다
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
  ['planEntry100x(', ENTRY, '100X 진입 계획'],
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
const scalpSrc = code(SCALP);
if (!/epSizingPolicy\s*===\s*'MARGIN_ALLOCATION'/.test(scalpSrc)) {
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

if (bad) {
  console.error(`\n전용 100배 계약 검사 실패: ${bad}건`);
  process.exit(1);
}
console.log('✅ 전용 100배 계약 (정확 100 · 고정 손절 없음 · 누출 0 · dormant)');
