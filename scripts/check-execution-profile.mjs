#!/usr/bin/env node
// 실행 프로필 계약이 **화면과 같은 의미**로 저장·전달되는가.
//
// 이 검사기가 지키는 것
// ────────────────────
// 화면의 프로필 표(배율 25~50배 · 위험 0.5% · 손절 0.3% · Post-only)는
// 오래 전부터 있었는데 읽는 곳이 화면 하나뿐이었다. 실제 단타는 ATR로
// 매번 다시 계산한다. 그래서 화면과 거래소가 다른 값으로 움직였다.
//
// 1A는 그 계약을 저장·전달하는 길만 낸다. 실행 의미는 아직 바꾸지 않는다.
// 그래서 여기서 막아야 할 것이 둘이다:
//
//   ① 계약이 조용히 다른 값으로 해석되는 것 (fallback · 반쪽 선택 · 버전)
//   ② 계약을 가진 예약이 **기존 방식으로 실행되는 것** (dormant)
//
// ②를 놓치면 "저장은 연구용, 실행은 ATR"이 정식 기능이 된다 — 지금
// 없애려는 고장을 기능으로 만드는 셈이다.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripJsComments } from './lib/strip-comments.mjs';

const PLAN   = 'src/lib/execution/profile.ts';
const PLANT  = 'src/lib/execution/profile.test.ts';
const RUNREQ = 'src/lib/strategies/runRequest.ts';
const RUNNER = 'src/lib/autotrade/evaluationRunner.ts';
const SCHED  = 'src/app/api/autotrade/schedule/route.ts';
const SCALP  = 'src/app/api/autotrade/scalp/route.ts';
const MIG    = 'supabase/migrations/077_execution_profile.sql';

let bad = 0;
const err = m => { console.error(`❌ ${m}`); bad++; };
const read = f => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const code = f => stripJsComments(read(f));

const plan = code(PLAN), planT = read(PLANT);
const runreq = code(RUNREQ), runner = code(RUNNER);
const sched = code(SCHED), scalp = code(SCALP);
const mig = read(MIG);

if (!plan) err(`${PLAN}: 실행 프로필 정본이 없습니다`);

/* ── ① 세 축 · 정확 일치 · fallback 금지 (EP-01·02·03·09) ── */
for (const need of ['resolveExecutionProfile', 'UNKNOWN_PROFILE', 'UNKNOWN_PRESET',
  'INCOMPLETE_SELECTION', 'VERSION_MISMATCH']) {
  if (!plan.includes(need)) err(`${PLAN}: ${need}이(가) 없습니다`);
}
// getProfile()은 모르는 id를 SWING_LOW_LEV로, presetOf()는 모르는 값을
// STABILIZE로 바꾼다. 화면에서는 편의지만 실행에서는 오타가 다른 배율이다.
for (const banned of ['getProfile', 'presetOf']) {
  if (new RegExp(`\\b${banned}\\s*\\(`).test(plan)) {
    err(`${PLAN}: ${banned}()를 씁니다 — 모르는 값을 다른 값으로 바꿉니다. 정확 일치로 조회하세요`);
  }
}
if (!/PROFILES\s*\)?\s*\[/.test(plan) && !/\(PROFILES as any\)\[/.test(plan)) {
  err(`${PLAN}: PROFILES를 정확 일치로 조회하지 않습니다`);
}
if (!/hasOwnProperty\.call\(\s*PRESET_TABLE/.test(plan)) {
  err(`${PLAN}: PRESET_TABLE 키 존재를 확인하지 않습니다 — 모르는 프리셋이 기본값으로 떨어집니다`);
}

/* ── ② 검증이 applyPreset보다 먼저다 (EP-20·21) ──
   applyPreset → overrideOf → presetOf 체인이라, 검증 전에 부르면 모르는
   프리셋이 기본값으로 해석된다. 도달 자체를 막아야 한다. */
{
  const iProfile = plan.indexOf('UNKNOWN_PROFILE');
  const iPreset  = plan.indexOf('UNKNOWN_PRESET');
  const iVer     = plan.indexOf('VERSION_MISMATCH');
  const iApply   = plan.indexOf('applyPreset(');
  if (iApply < 0) err(`${PLAN}: applyPreset을 쓰지 않습니다 — 숫자를 복제하지 마세요`);
  else for (const [i, name] of [[iProfile, '프로필'], [iPreset, '프리셋'], [iVer, '버전']]) {
    if (i < 0 || i > iApply) {
      err(`${PLAN}: ${name} 검증이 applyPreset보다 뒤에 있습니다 — 모르는 값이 기본값으로 해석됩니다`);
    }
  }
}

/* ── ③ 숫자를 복제하지 않는다 (EP-08) ──
   프로필 표의 값을 여기 다시 적으면 정본이 둘이 되고 언젠가 갈린다. */
for (const lit of ['25', '50', '0.5', '0.6', '0.3', 'post_only_limit', 'isolated']) {
  const re = new RegExp(`[:=]\\s*'?${lit.replace('.', '\\.')}'?\\s*[,;\\n]`);
  if (re.test(plan)) err(`${PLAN}: 프로필 값 ${lit}을 복제했습니다 — applyPreset 결과를 쓰세요`);
}

/* ── ④ 계약은 화이트리스트다 (EP-15·16·17) ── */
if (!plan.includes('CONTRACT_FIELDS')) err(`${PLAN}: CONTRACT_FIELDS 화이트리스트가 없습니다`);
for (const banned of ['simSeed', 'simCurrency', 'simTargetEquity', 'simPrice', 'simHoldSec',
  'edgePp', 'assumedWinRate']) {
  if (plan.includes(banned)) {
    err(`${PLAN}: 계약에 모의 전용 값(${banned})이 들어갑니다 — 실행값만 넣으세요`);
  }
}
{
  const m = /const CONTRACT_FIELDS = \[([\s\S]*?)\]/.exec(plan);
  const list = m ? m[1] : '';
  for (const banned of ['label', 'description', 'leverageBand', 'riskBand']) {
    if (list.includes(banned)) err(`${PLAN}: CONTRACT_FIELDS에 표시용 값(${banned})이 있습니다`);
  }
  for (const need of ['leverage', 'stopLossPct', 'takeProfitPct', 'orderType', 'marginModes']) {
    if (!list.includes(need)) err(`${PLAN}: CONTRACT_FIELDS에 ${need}이(가) 없습니다`);
  }
}
// 지문과 투영이 같은 목록을 써야 한다. 목록이 둘이면 언젠가 갈린다.
{
  const i = plan.indexOf('executionContractFingerprint');
  const body = i < 0 ? '' : plan.slice(i);
  if (!body.includes('CONTRACT_FIELDS')) {
    err(`${PLAN}: 지문이 CONTRACT_FIELDS를 쓰지 않습니다 — 목록이 둘이 됩니다`);
  }
}

/* ── ⑤ 시뮬 값이 실행 DTO로 새지 않는다 (EP-07) ── */
for (const [f, src] of [[RUNREQ, runreq], [RUNNER, runner], [SCHED, sched], [SCALP, scalp]]) {
  for (const banned of ['edgePp', 'assumedWinRate', 'monteCarlo']) {
    if (src.includes(banned)) err(`${f}: 시뮬 가정값(${banned})이 실행 경로에 있습니다`);
  }
}

/* ── ⑥ 세 칸 NULL이면 본문에 키를 붙이지 않는다 (EP-11) ──
   `executionProfileId: null`이라도 넣으면 기존 요청의 바이트가 달라진다. */
{
  const i = runreq.indexOf('const body');
  const body = i < 0 ? '' : runreq.slice(i);
  if (/body\.executionProfileId\s*=\s*null/.test(body)
      || /executionProfileId:\s*num\(/.test(body)
      || /executionProfileId:\s*i\./.test(body)) {
    err(`${RUNREQ}: 프로필이 없을 때도 본문에 키를 넣습니다 — 기존 요청이 바이트 동일하지 않게 됩니다`);
  }
  if (!/kind === 'contract'/.test(runreq)) {
    err(`${RUNREQ}: 해석에 성공했을 때만 키를 붙이지 않습니다`);
  }
}

/* ── ⑦ dormant — 계약을 가진 예약은 실행되지 않는다 ── */
// L1 DB (EP-30) — 코드 층만으로는 구 Worker가 도는 창을 못 막는다.
// Worker는 웹의 evaluator를 빌드 시점에 번들하므로 옛 코드로 계속 돈다.
if (!mig) err(`${MIG}: 마이그레이션이 없습니다`);
if (!/ADD CONSTRAINT\s+autotrade_schedules_execution_profile_dormant/i.test(mig)) {
  err(`${MIG}: dormant DB 제약이 없습니다 — 코드 층만으로는 구 Worker가 도는 배포 창을 막지 못합니다`);
}
if (!/ADD CONSTRAINT\s+autotrade_schedules_execution_profile_complete/i.test(mig)) {
  err(`${MIG}: all-or-none 제약이 없습니다 — 반쪽 저장이 통과합니다`);
}
if (/^\s*CHECK\s*\(/m.test(mig.replace(/ADD CONSTRAINT[\s\S]*?CHECK\s*\(/g, ''))) {
  err(`${MIG}: 이름 없는 독립 CHECK 문장이 있습니다 — 실행되지 않고, 1C에서 떼어낼 수도 없습니다`);
}
// L4 실행기 (EP-28)
//
// **import에 이름이 있는 것과 실제로 부르는 것은 다르다.** 호출을 stub으로
// 바꿔도 import는 남아서, 이름만 보면 통과한다. 그래서 호출과 **인자**를 본다 —
// 예약 줄의 세 칸을 넣어야 그 줄을 검증하는 것이다.
{
  const call = /resolveExecutionProfile\s*\(([\s\S]{0,300}?)\)/.exec(runner);
  if (!call) err(`${RUNNER}: 실행 직전에 계약을 다시 검증하지 않습니다`);
  else for (const arg of ['row.execution_profile_id', 'row.execution_preset_id',
    'row.execution_contract_version']) {
    if (!call[1].includes(arg)) {
      err(`${RUNNER}: 계약 검증에 ${arg}을(를) 넣지 않습니다 — 그 줄을 검증하는 것이 아닙니다`);
    }
  }
  if (!/isExecutionResolveError\s*\(\s*ep\s*\)/.test(runner)) {
    err(`${RUNNER}: 해석 실패를 판정에 쓰지 않습니다`);
  }
  if (!/outcome:\s*'BLOCKED'/.test(runner)) {
    err(`${RUNNER}: 막은 사실을 예약 줄에 남기지 않습니다 — 화면에는 '켜짐'만 보입니다`);
  }
}
{
  const iEp = runner.indexOf('resolveExecutionProfile');
  const iClaim = runner.indexOf('claimSchedule(');
  const iEval = runner.indexOf('evaluateSchedule(row');
  if (iEp >= 0 && iClaim >= 0 && iEp > iClaim) {
    err(`${RUNNER}: 계약 검증이 선점보다 뒤입니다 — 막을 것을 위해 last_run_at을 씁니다`);
  }
  if (iEp >= 0 && iEval >= 0 && iEp > iEval) {
    err(`${RUNNER}: 계약 검증이 평가 호출보다 뒤입니다 — 주문 경로에 이미 닿았습니다`);
  }
}
// L3 PATCH (EP-27·33) — UPDATE 조건 안에 있어야 한다
if (!/is\('execution_profile_id',\s*null\)/.test(sched)) {
  err(`${SCHED}: 켜기 UPDATE 조건에 프로필 필터가 없습니다 — 먼저 켜고 나중에 판단하면 늦습니다`);
}
// 필터가 **켜는 요청에서 실제로 붙는가.** 조건이 죽어 있으면 문자열만 남는다.
if (!/if\s*\(\s*dormantFilter\s*\)\s*q\s*=\s*q\.is\(\s*'execution_profile_id'/.test(sched)) {
  err(`${SCHED}: 프로필 필터가 켜기 요청에 걸리지 않습니다 — 조건이 죽어 있습니다`);
}
if (!/let\s+dormantFilter\s*=\s*enabled\b/.test(sched)) {
  err(`${SCHED}: 필터가 '켜는 요청일 때만'이 아닙니다 — 끄는 것까지 어려워지거나, 아무 때도 안 걸립니다`);
}
if (!sched.includes('EXECUTION_PROFILE_NOT_ACTIVE')) {
  err(`${SCHED}: 켤 수 없는 이유를 사람이 읽을 수 있게 말하지 않습니다`);
}
// L2 저장 (EP-26) + 직접 호출 경계 (EP-31)
//
// **문자열이 있는지가 아니라 조건이 걸려 있는지를 본다.** 이 저장소에서
// 이미 여러 번 그 구멍으로 샜다 — 메시지는 그대로 두고 조건만 `false`로
// 바꾸면 검사기가 초록이었다.
if (!/execution_config_requires_explicit_disabled/i.test(sched)) {
  err(`${SCHED}: 프로필을 바꾸는 요청에 enabled:false를 강제하지 않습니다 — 설정 변경이 곧 가동이 됩니다`);
}
if (!/if\s*\(\s*body\?\.enabled\s*!==\s*false\s*\)/.test(sched)) {
  err(`${SCHED}: enabled:false 강제가 실제 조건으로 걸려 있지 않습니다`);
}
if (!scalp.includes('EXECUTION_PROFILE_NOT_ACTIVE')) {
  err(`${SCALP}: 직접 호출에 계약이 실려 와도 막지 않습니다 — 예약을 거치지 않는 우회로가 남습니다`);
}
{
  // 신호 계산·주문 경로보다 앞에서 막아야 한다.
  const iEp = scalp.indexOf('resolveExecutionProfile');
  const iSig = scalp.indexOf('scalpSignal');
  if (iEp < 0) err(`${SCALP}: 계약을 해석하지 않습니다`);
  else if (iSig >= 0 && iEp > iSig) {
    err(`${SCALP}: 계약 검증이 신호 계산보다 뒤입니다 — 이미 파이프라인에 들어갔습니다`);
  }
}

/* ── ⑧ 저장 실패면 첫 평가도 돌지 않는다 (EP-12·13·14·29) ── */
if (!/EXECUTION_PROFILE_SCHEMA_MISSING/.test(sched)) {
  err(`${SCHED}: 077이 없을 때 프로필 요청을 막지 않습니다 — 프로필을 떼고 저장하면 기존 방식으로 실행됩니다`);
}
// 그 반환이 **실제 실패 조건에 매달려 있는가.**
if (!/if\s*\(\s*error\s*&&\s*epTouched\s*&&\s*!epAllNull/.test(sched)) {
  err(`${SCHED}: 077 차단이 실제 저장 실패 조건에 걸려 있지 않습니다 — 문구만 남고 후퇴는 그대로입니다`);
}
if (!/if \(enabled && !epTouched && data\?\.id\)/.test(sched)) {
  err(`${SCHED}: 프로필을 건드린 요청에서 첫 평가를 막지 않습니다`);
}

/* ── ⑨ omitted ≠ explicit null (EP-22·23·24·25) ── */
if (!/hasOwnProperty\.call\(body/.test(sched)) {
  err(`${SCHED}: 키를 안 보낸 것과 null로 보낸 것을 가르지 않습니다 — 구버전 요청이 기존 선택을 지웁니다`);
}
if (!/incomplete_selection/i.test(sched)) {
  err(`${SCHED}: 반쪽 선택을 400으로 막지 않습니다`);
}

/* ── ⑩ 계약 버전 — 값이 바뀌면 버전도 바뀐다 (EP-05·18·19·32) ──
   여기서 "현재 파일끼리 일치하는가"만 보면 새 나간다. 개발자가 실행값과
   스냅샷을 같이 고치고 버전을 그대로 두면 다시 일치하기 때문이다.
   그래서 **이전 커밋과 비교**한다. */
{
  const fpOf = src => {
    try {
      return execFileSync(process.execPath, ['--input-type=module', '-e', src],
        { encoding: 'utf8', timeout: 60_000 }).trim();
    } catch { return null; }
  };
  const HEAD_SRC = `
    import { executionContractFingerprint, EXECUTION_CONTRACT_VERSION }
      from './src/lib/execution/profile.ts';
    console.log(JSON.stringify({ v: EXECUTION_CONTRACT_VERSION, fp: executionContractFingerprint() }));
  `;
  // 지문은 TS라 직접 실행할 수 없다. 대신 값의 출처인 두 파일과 계약
  // 파일의 내용을 base와 비교한다 — 값이 바뀌었는지는 그것으로 충분하다.
  const gitShow = (rev, f) => {
    // base에 없는 파일은 정상이다(최초 도입). stderr까지 보여 줄 필요는 없다.
    try { return execFileSync('git', ['show', `${rev}:${f}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return null; }
  };
  const baseRev = process.env.EXECUTION_CONTRACT_BASE || (() => {
    for (const r of ['origin/main', 'HEAD~1']) {
      try { execFileSync('git', ['rev-parse', '--verify', r], { stdio: 'ignore' }); return r; }
      catch { /* 다음 후보 */ }
    }
    return null;
  })();

  /**
   * 실행값만 뽑는다.
   *
   * 파일 전체를 비교하면 주석 한 줄이나 `sim*` 헬퍼의 타입 정리 같은
   * **실행과 무관한 변경**까지 버전을 올리라고 요구한다. 그러면 개발자가
   * 규칙을 우회하는 습관이 들고, 정작 진짜 값이 바뀔 때 신호가 묻힌다.
   * 그래서 계약에 들어가는 칸과 프리셋 override 칸만 본다.
   */
  const execValues = src => {
    const KEYS = ['leverage', 'maxLeverage', 'marginModes', 'maxPortfolioPct',
      'riskPercentPerTrade', 'takeProfitPct', 'stopLossPct', 'orderType',
      'timeoutSec', 'dailyLossLimitPct', 'maxHoldSec', 'maxOpenPositions'];
    const re = new RegExp(`^\\s*(?:${KEYS.join('|')})\\s*:.*$`, 'gm');
    return ((src || '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').match(re) || [])
      .map(l => l.replace(/\s+/g, ' ').trim()).join('\n');
  };

  const versionOf = src => {
    const m = src && /EXECUTION_CONTRACT_VERSION\s*=\s*(\d+)/.exec(src);
    return m ? Number(m[1]) : null;
  };
  const headPlan = read(PLAN);
  const headV = versionOf(headPlan);
  if (headV == null) err(`${PLAN}: EXECUTION_CONTRACT_VERSION을 읽지 못했습니다`);

  if (!baseRev) {
    console.log('· 비교할 이전 커밋이 없습니다 — 버전 비교를 건너뜁니다');
  } else {
    const basePlan = gitShow(baseRev, PLAN);
    if (basePlan == null) {
      // ── bootstrap ──
      // 이 계약이 처음 들어오는 PR이다. 비교할 base 버전이 없다.
      // 그래도 조용히 통과시키지 않는다 — **이 PR에서 실행 정의까지 같이
      // 바꾸면** 무엇이 v1인지가 흐려진다. 그래서 그것만 막는다.
      if (headV !== 1) {
        err(`${PLAN}: 계약을 처음 들이면서 버전이 1이 아닙니다 (${headV})`);
      }
      for (const f of ['src/lib/strategies/profiles.ts', 'src/lib/strategies/profilePreset.ts']) {
        const b = gitShow(baseRev, f);
        if (b != null && execValues(b) !== execValues(read(f))) {
          err(`${f}: 계약을 처음 들이는 PR에서 실행 정의가 함께 바뀌었습니다`
            + ' — v1이 무엇인지 정할 수 없습니다. 정의 변경은 다음 PR로 나누세요');
        }
      }
      console.log(`· bootstrap — ${baseRev}에 실행 계약이 없습니다. v1로 시작합니다`);
    } else {
      const baseV = versionOf(basePlan);
      let changed = false;
      for (const f of ['src/lib/strategies/profiles.ts', 'src/lib/strategies/profilePreset.ts', PLAN]) {
        const b = gitShow(baseRev, f);
        if (b != null && b !== read(f)) changed = true;
      }
      if (changed && baseV === headV) {
        // 실행값이 안 바뀌었는데 주석만 고친 경우까지 막지는 않는다.
        // 그래서 지문 자체를 비교한다.
        let realChange = false;
        for (const f of ['src/lib/strategies/profiles.ts', 'src/lib/strategies/profilePreset.ts']) {
          const b = gitShow(baseRev, f);
          if (b != null && execValues(b) !== execValues(read(f))) realChange = true;
        }
        if (realChange) {
          err(`실행 정의가 바뀌었는데 EXECUTION_CONTRACT_VERSION이 그대로입니다 (${headV})`
            + ` — 같은 예약이 다른 의미로 실행됩니다. base=${baseRev}`);
        }
      }
    }
  }
}

/* ── ⑪ 시험이 남아 있는가 ── */
for (const m of ['UNKNOWN_PROFILE', 'UNKNOWN_PRESET', 'INCOMPLETE_SELECTION',
  'VERSION_MISMATCH', 'RESEARCH', 'STABILIZE']) {
  if (!planT.includes(m)) err(`${PLANT}: ${m}을(를) 못박은 시험이 없습니다`);
}
{
  const runner2 = read('scripts/run-tests.mjs');
  if (!/runExecutionProfileTests\s*\(\s*\)/.test(runner2)) {
    err('scripts/run-tests.mjs: 실행 프로필 시험이 등록돼 있지 않습니다');
  }
}

console.log(bad === 0
  ? '✅ 실행 프로필 계약 — 세 축 · fallback 없음 · 아직 잠들어 있음'
  : '\n계약이 화면과 다른 의미로 해석되거나, 잠금이 새고 있습니다.');
process.exit(bad === 0 ? 0 : 1);
