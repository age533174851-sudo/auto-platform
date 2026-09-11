#!/usr/bin/env node
// scripts/check-100x-mutations.mjs
//
// **전용 100배 계약 돌연변이 하네스 — 검증 증거를 재현 가능하게.**
//
// 무엇을 하는가
// ─────────────
// 규칙을 하나씩 고의로 망가뜨린 뒤, CI가 보는 것과 **같은 게이트**를
// 돌려서 빨간불이 뜨는지 본다. 빨간불이 안 뜨면 그 규칙은 지켜지는 것이
// 아니라 **아무도 안 보는 것**이다.
//
// 왜 저장소 안에 있는가
// ─────────────────────
// 이 하네스는 원래 세션 임시 폴더에서 돌았다. 그래서 "97개 중 누락 0"이라는
// 숫자가 나왔는데, 다른 사람이 같은 커밋을 받아도 그 숫자를 다시 만들 수
// 없었다. 재현할 수 없는 증거는 증거가 아니라 주장이다.
//
// 이제 저장소 파일만으로 돈다:
//
//     node scripts/check-100x-mutations.mjs
//
// 거래소 키도, 비밀값도, 실제 주문도 필요 없다 — 전부 소스 파일을 고쳐
// 보고 검사기·시험을 돌리는 일뿐이다.
//
// 하네스가 스스로 틀린 적이 세 번 있다
// ────────────────────────────────────
// 이 파일에서 가장 중요한 것은 돌연변이 목록이 아니라 **안전장치**다.
// 결과를 믿을 수 없는데 숫자만 그럴듯하게 나오는 것이 가장 나쁘다.
//
//   ① `git clean`이 node_modules 심링크를 지워서 전부 "틀린 이유로" RED
//   ② 적용되지 않은 돌연변이를 검출로 셌다 (탐지력 과대보고)
//   ③ 복원이 커밋되지 않은 작업을 통째로 지웠다 — 그 뒤 판정이 전부 거짓
//
// 그래서:
//   · `git clean`을 쓰지 않는다
//   · 적용 전후가 실제로 달라졌는지 확인한 뒤에만 판정한다(아니면 NOOP)
//   · **복원은 읽어 둔 원본 바이트를 그대로 다시 쓴다.** `git checkout --`을
//     쓰지 않으므로, 사용자의 커밋되지 않은 변경을 파괴할 수 없다
//   · 시작할 때 트리가 깨끗한지 보고, 아니면 아예 돌지 않는다
//   · 변이마다 끝나고 트리가 깨끗한지 다시 본다(대상 밖 파일이 바뀌면 중단)
//   · 중간에 죽어도 복원하도록 신호를 받는다
//
// CI에 대하여
// ───────────
// 이 하네스는 시험 전체를 여러 번 돌리므로 오래 걸린다. 매 PR마다 돌리면
// CI 시간이 폭증한다. 그래서 일반 CI는 이 파일이 **깨지지 않았는지**만
// 본다(`--self-test`). 전수 실행은 계약이 바뀐 라운드에 사람이 부른다.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`전용 100배 계약 돌연변이 하네스

사용법
  node scripts/check-100x-mutations.mjs              전수 실행 (오래 걸림)
  node scripts/check-100x-mutations.mjs --self-test  목록·대상만 점검 (빠름)
  node scripts/check-100x-mutations.mjs --list       돌연변이 목록만 출력
  node scripts/check-100x-mutations.mjs --help       이 도움말

진단
  --only OK1,OK2   이름이 그것으로 시작하는 변이만 돌린다
  --verbose        어느 게이트가 빨간불을 켰는지 함께 적는다

  대조군이 빨개졌을 때 쓴다. 게이트 셋 중 무엇이 잡았는지 보이지 않으면
  원인을 찾을 수 없다.

전제
  · 저장소 루트에서 실행한다
  · 워킹 트리가 깨끗해야 한다 (더러우면 거부한다)
  · 의존성이 설치돼 있어야 한다 (npm ci)

필요 없는 것
  거래소 키 · 비밀값 · 네트워크 · 실제 주문. 소스를 고쳐 보고
  검사기와 유닛 시험을 돌리는 것이 전부다.

종료 코드
  0  누락 0 · 과도검출 0 · 판정 불가 0
  1  누락/과도검출/판정 불가가 있음
  2  더러운 트리 — 실행하지 않음
  3  실행 중 대상 밖 파일이 바뀜 — 오염되어 중단`);
  process.exit(0);
}

const SELF_TEST = argv.includes('--self-test');
const LIST_ONLY = argv.includes('--list');
const VERBOSE = argv.includes('--verbose');
// `--only OK1` 또는 `--only OK1,OK2` — 이름 앞부분만 맞으면 된다.
// 대조군 하나가 빨개졌을 때 그것만 떼어 돌려 보기 위한 것이다.
const ONLY = (() => {
  const i = argv.indexOf('--only');
  if (i < 0 || !argv[i + 1]) return null;
  return argv[i + 1].split(',').map(x => x.trim()).filter(Boolean);
})();

const P = {
  prof: 'src/lib/strategies/profiles.ts',
  preset: 'src/lib/strategies/profilePreset.ts',
  plan: 'src/lib/execution/profile.ts',
  gate: 'src/lib/execution/dormantGate.ts',
  exec: 'src/lib/engine/orderExecutor.ts',
  reattach: 'src/lib/engine/stopReattach.ts',
  sizing: 'src/lib/engine/sizing100x.ts',
  cl: 'src/lib/engine/preTradeChecklist.ts',
  life: 'src/lib/engine/exitLifecycle.ts',
  sched: 'src/app/api/autotrade/schedule/route.ts',
  runner: 'src/lib/autotrade/evaluationRunner.ts',
  worker: 'worker/src/index.ts',
  mig: 'supabase/migrations/078_live_orders_stop_policy.sql',
  migOpen: 'supabase/migrations/080_execution_profile_selective.sql',
  entry: 'src/lib/engine/entry100x.ts',
  scalp: 'src/app/api/autotrade/scalp/route.ts',
  ui: 'src/components/AutotradeControl.tsx',
  runreq: 'src/lib/strategies/runRequest.ts',
  ladder: 'src/app/api/autotrade/daily-ladder/route.ts',
  orig: 'src/app/api/autotrade/my-original-v1/route.ts',
  auth: 'src/lib/engine/entryAuthority.ts',
};

const CHECK = ['scripts/check-100x-contract.mjs'];
const CHECK1A = ['scripts/check-execution-profile.mjs'];

/** 게이트 하나를 돌린다. 통과면 null, 실패면 {name, code, output}. */
const runGate = (name, cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', timeout: 900_000 });
    return null;
  } catch (e) {
    const out = `${e?.stdout?.toString?.() || ''}${e?.stderr?.toString?.() || ''}`;
    return { name, code: e?.status ?? 1, output: out.trim() };
  }
};
// **CI가 보는 것을 그대로 본다.** 검사기 둘 + 유닛 시험.
//
// 처음에는 검사기만 돌렸다. 그랬더니 시험이 잡는 돌연변이(권한 판정 제거,
// 계약 기본값 뒤집기 같은 **동작** 변경)가 전부 "새 나감"으로 찍혔다 —
// 탐지력 과소보고다. 하네스가 CI보다 좁게 보면 그 차이만큼 거짓 신호가
// 나온다. 검사기를 먼저 돌려서 빨리 걸리는 것은 빨리 걸리게 하고,
// 통과하면 시험까지 본다.
const GATES = [
  ['check-100x-contract', process.execPath, CHECK],
  ['check-execution-profile', process.execPath, CHECK1A],
  ['npm test', 'npm', ['test']],
];

/**
 * 게이트 전체. 통과면 null, 실패면 **처음 실패한 게이트**를 돌려준다.
 *
 * 예전에는 1/0만 돌려줬다. 그래서 "빨간불"이 무엇 때문인지 볼 수 없었고,
 * 실제로 그 때문에 한 번 크게 틀렸다 — 아래 기준선 검사 주석 참고.
 */
const gateChecker = () => {
  for (const [name, cmd, args] of GATES) {
    const fail = runGate(name, cmd, args);
    if (fail) return fail;
  }
  return null;
};

const M = [
  // ── 필수 wiring 돌연변이 ──
  ['W1  Web(Binance) 배율 되읽기 배선 제거', P.exec,
    s => s.replace(/const lev = await futuresApplyLeverage\(\s*\{ exchange: 'binance'[\s\S]*?plan\.symbol, plan\.leverage\);\s*if \(!lev\.ok\) \{/,
      "const lev = await bf.setFuturesLeverage(apiKey, apiSecret, plan.symbol, plan.leverage, testnet);\n        if (!(lev as any)?.success) {")],
  ['W2  stopPolicy 전달 제거', P.exec,
    s => s.replace("const noFixedSl = args.stopPolicy === 'NO_FIXED_SL';", 'const noFixedSl = false;')],
  ['W3  복구 경로가 정책을 안 봄', P.reattach,
    s => s.replace(/if \(String\(o\?\.stop_policy \|\| ''\) === 'NO_FIXED_SL'\) \{[\s\S]*?\n  \}\n/, '')],
  ['W4  계약 없을 때 기본이 NO_FIXED_SL (레거시 levCap100 승격)', P.plan,
    s => s.replace("return c?.stopPolicy === 'NO_FIXED_SL' ? 'NO_FIXED_SL' : 'FIXED_SL';",
      "return c?.stopPolicy === 'FIXED_SL' ? 'FIXED_SL' : 'NO_FIXED_SL';")],
  ['W5  표를 채워도 켜기(L3) 조건이 안 바뀜 — 영구 BLOCK', P.gate,
    s => s.replace(/  const safe = open\.filter[\s\S]*?\n  return \{ kind: 'or'[\s\S]*?\};\n\}/,
      "  void open;\n  return { kind: 'isNull' };\n}")],
  ['W6  실행기(L4)가 게이트를 안 읽음', P.runner,
    s => s.replace(/const gate = executionGateVerdict\(\{[\s\S]*?\}\);/,
      "const gate = { allowed: true, reason: '' };")],
  ['W7  켜기 필터가 죽음', P.sched,
    s => s.replace(/if \(dormantFilter\) \{[\s\S]*?\n    \}/, 'if (false) { /* noop */ }')],
  ['W8  워커 SET_TPSL 경계 제거', P.worker,
    s => s.replace(/if \(String\(\(p as any\)\?\.stopPolicy \|\| ''\) === 'NO_FIXED_SL'[\s\S]*?\n      \}\n/, '')],

  // ── 계약 값 돌연변이 ──
  ['M1  100X 요청 배율 100 → 99', P.prof, s => s.replace('  leverage: 100,\n  maxLeverage: 100,', '  leverage: 99,\n  maxLeverage: 100,')],
  ['M2  100X 상한 100 → 50', P.prof, s => s.replace('  leverage: 100,\n  maxLeverage: 100,', '  leverage: 100,\n  maxLeverage: 50,')],
  ['M3  전용 프리셋이 100X를 20배로 낮춤', P.preset,
    s => s.replace("      leverage: 100, maxLeverage: 100, leverageBand: [100, 100],",
      "      leverage: 20, maxLeverage: 20, leverageBand: [10, 20],")],
  ['M4  100X에 synthetic stop 삽입 (null → 0.5)', P.prof, s => s.replace('  stopLossPct: null,\n  stopPolicy: \'NO_FIXED_SL\',', '  stopLossPct: 0.5,\n  stopPolicy: \'NO_FIXED_SL\',')],
  ['M5  100X가 FIXED_SL이 됨', P.prof, s => s.replace("  stopLossPct: null,\n  stopPolicy: 'NO_FIXED_SL',", "  stopLossPct: null,\n  stopPolicy: 'FIXED_SL',")],
  ['M6  100X 교차 마진 허용', P.prof,
    s => s.replace("  marginModes: ['isolated'],          // Cross 금지 (위 주석 · 사용자 확정 정책)",
      "  marginModes: ['isolated', 'cross'],")],
  ['M6b 100X sizingPolicy가 STOP_RISK로 바뀜', P.prof,
    s => s.replace("  sizingPolicy: 'MARGIN_ALLOCATION',", "  sizingPolicy: 'STOP_RISK',")],
  ['M6c 계약 기본 사이징이 MARGIN_ALLOCATION으로 뒤집힘', P.plan,
    s => s.replace("return c?.sizingPolicy === 'MARGIN_ALLOCATION' ? 'MARGIN_ALLOCATION' : 'STOP_RISK';",
      "return c?.sizingPolicy === 'STOP_RISK' ? 'STOP_RISK' : 'MARGIN_ALLOCATION';")],
  // ── 부작용 순서 (P0): 차단될 요청이 거래소를 건드리면 안 된다 ──
  ['O1  권한 판정 뒤에 거래소 단계가 오지 않음 (guardedEntry 우회)', P.scalp,
    s => s.replace('const guarded = await guardedEntry(authorityFacts, async (): Promise<any> => {',
      'const guarded = { verdict: { allowed: true, code: "OK", reason: "" }, result: await (async (): Promise<any> => {')
          .replace('    return plan;\n  });', '    return plan;\n  })() };')],
  ['O2  guardedEntry가 막힌 요청에서도 mutate를 부름', P.auth,
    s => s.replace('  if (!verdict.allowed) return { verdict, result: null };', '  if (false) return { verdict, result: null };')],
  ['O3  모드↔연결 판정 제거', P.auth,
    s => s.replace(/  if \(f\.connIsLive !== f\.modeNeedsLiveKey\) \{[\s\S]*?\n  \}\n/, '')],
  ['O4  킬 스위치 판정 제거', P.auth,
    s => s.replace("  if (f.killSwitchReason) return no('KILL_SWITCH', f.killSwitchReason);\n", '')],
  ['O5  마이그레이션 판정 제거', P.auth,
    s => s.replace("  if (f.migrationReason) return no('MIGRATION_PENDING', f.migrationReason);\n", '')],
  ['O6  킬 스위치 조회가 거래소 쓰기보다 뒤로 감', P.scalp, s => {
    const m = /  const killReason = await \(async \(\) => \{[\s\S]*?\n  \}\)\(\);\n/.exec(s);
    if (!m) return s;
    return s.replace(m[0], '').replace('  const plan: any = guarded.result;',
      m[0] + '  const plan: any = guarded.result;');
  }],
  ['O7  마진 모드 확인 전에 배율을 검 (진입 계획 내부 순서)', P.entry, s => {
    const mm = /  \/\/ ── ① 마진 모드 ──[\s\S]*?notes\.push\(`마진 모드 \$\{mode\} \(되읽음\)`\);\n(?:[\s\S]*?\n  \}\n)/.exec(s);
    if (!mm) return s;
    return s.replace(mm[0], '').replace('  notes.push(`배율 ${req}배 확인(되읽음)`);',
      '  notes.push(`배율 ${req}배 확인(되읽음)`);\n' + mm[0]);
  }],
  ['O8  거래소 쓰기 의존이 분류에서 빠짐', P.entry,
    s => s.replace("export const MUTATING_DEPS = ['applyLeverage'] as const;",
      "export const MUTATING_DEPS = [] as const;")],

  // ── 손절/익절 축 분리 (P1) ──
  ['T1  100X에 익절 숫자가 되살아남', P.prof,
    s => s.replace("  takeProfitPct: null,\n  takeProfitPolicy: 'NO_FIXED_TP',",
      "  takeProfitPct: 1.5,\n  takeProfitPolicy: 'NO_FIXED_TP',")],
  ['T2  100X가 FIXED_TP가 됨', P.prof,
    s => s.replace("  takeProfitPolicy: 'NO_FIXED_TP',", "  takeProfitPolicy: 'FIXED_TP',")],
  ['T3  계약 기본 익절 정책이 NO_FIXED_TP로 뒤집힘', P.plan,
    s => s.replace("return c?.takeProfitPolicy === 'NO_FIXED_TP' ? 'NO_FIXED_TP' : 'FIXED_TP';",
      "return c?.takeProfitPolicy === 'FIXED_TP' ? 'FIXED_TP' : 'NO_FIXED_TP';")],
  ['T4  Gate 익절이 다시 손절 정책으로 막힘 (거래소 불일치)', P.exec,
    s => s.replace("    if (!args.reduceOnly && !noFixedTp && tpSpec) {",
      "    if (!args.reduceOnly && policy !== 'NONE' && tpSpec) {")],
  ['T5  Binance 익절이 정책을 안 봄 (거래소 불일치)', P.exec,
    s => s.replace("      } else if (noFixedTp) {\n", "      } else if (false) {\n")],
  ['T6  익절 정책과 익절가 모순을 조용히 통과', P.exec,
    s => s.replace('  if (noFixedTp && args.takeProfit != null) {', '  if (false) {')],
  ['T7  scalp가 익절 정책을 안 넘김', P.scalp,
    s => s.replace('    takeProfitPolicy: epTakeProfitPolicy,\n', '')],
  ['T8  scalp가 손절 정책으로 익절까지 뺌', P.scalp,
    s => s.replace("    ...(epTakeProfitPolicy === 'NO_FIXED_TP' ? {} : { takeProfit: scalp.signal.target }),",
      "    ...(epStopPolicy === 'NO_FIXED_SL' ? {} : { takeProfit: scalp.signal.target }),")],
  ['T9  계약 칸에서 익절 정책이 빠짐', P.plan,
    s => s.replace("  'stopPolicy', 'sizingPolicy', 'takeProfitPolicy',", "  'stopPolicy', 'sizingPolicy',")],

  // ── UI exact identity ──
  ['U1  x100Row가 프리셋을 안 봄', P.ui,
    s => s.replace("    && r?.execution_preset_id === 'EXACT_100X'\n", '')],
  ['U2  x100Row가 계약 버전을 안 봄', P.ui,
    s => s.replace("    && Number(r?.execution_contract_version) === 2\n", '')],
  ['U3  x100Row가 운영 모드를 안 봄', P.ui,
    s => s.replace("    && String(r?.mode || '').toUpperCase() === 'TESTNET'\n", '')],

  // ── 전략 identity (P0) ──
  // 판정이 "첫 줄 하나"에서 "남은 줄들"로 바뀌면서 이 변이가 겨누던
  // 문구가 사라졌다. 정본이 옮겨가면 변이도 따라가야 한다 — 안 따라가면
  // 통과가 "규칙이 지켜졌다"가 아니라 "아무것도 안 겨눴다"가 된다.
  // (자기 점검이 이걸 CI에서 잡았다.)
  ['S1  조합에서 전략 조건 제거 (게이트)', P.gate,
    s => s.replace(/  const byStrategy = rows\.filter\(c => c\.strategyId === strat\);\n  if \(byStrategy\.length === 0\) \{[\s\S]*?\n  \}\n/,
                   '  const byStrategy = rows;\n')],

  // 넓히면서 헐거워지는 자리. 남은 줄 중 **하나라도** 요구하면 요구해야
  // 하는데, `some`을 `every`로 바꾸면 줄을 하나 더 놓는 것만으로 배정
  // 비율 검사가 사라진다.
  ['S1b 배정 비율을 every로 약화 (게이트)', P.gate,
    s => s.replace('if (byMode.some(c => c.requiresMarginAllocation)) {',
                   'if (byMode.every(c => c.requiresMarginAllocation) && byMode.length > 1) {')],
  ['S2  조합 표의 전략을 daily-ladder로 바꿈', P.gate,
    s => s.replace("strategyId: 'scalp',", "strategyId: 'daily-ladder',")],
  ['S3  켜기(L3) 조건에서 전략이 빠짐', P.gate,
    s => s.replace('      `strategy_id.eq.${c.strategyId}`,\n', '')],
  ['S4  실행기(L4)가 전략을 안 넘김', P.runner,
    s => s.replace('    strategyId: strategyIdOfRow(row),\n', '')],
  ['S5  켜기 probe가 전략을 안 넘김', P.sched,
    s => s.replace('        strategyId: probe.data?.strategy_id,\n', '')],
  ['S6  DB 제약에서 전략이 빠짐', P.migOpen,
    s => s.replace("      strategy_id = 'scalp'\n      AND execution_profile_id", '      execution_profile_id')],
  ['S7  daily-ladder가 계약을 받아 놓고 무시', P.ladder,
    s => s.replace(/    const \{ carriesExecutionContract \} = await import\('@\/lib\/execution\/profile'\);[\s\S]*?\n    \}\n/, '')],
  ['S8  my-original-v1이 계약을 받아 놓고 무시', P.orig,
    s => s.replace(/    const \{ carriesExecutionContract \} = await import\('@\/lib\/execution\/profile'\);[\s\S]*?\n    \}\n/, '')],
  ['S9  UI가 non-scalp에서도 100X를 저장', P.ui,
    s => s.replace("    if (strategyId !== 'scalp') {", '    if (false) {')],

  ['M17 LIVE를 열어 버림', P.gate,
    s => s.replace("modes: ['TESTNET'],", "modes: ['TESTNET', 'LIVE'],")],
  ['M17b 배정 비율 없이도 켜지게 함', P.gate,
    s => s.replace('requiresMarginAllocation: true,', 'requiresMarginAllocation: false,')],
  ['M17c DB 제약이 LIVE를 허용', P.migOpen,
    s => s.replace("AND mode = 'TESTNET'", "AND mode IN ('TESTNET', 'LIVE')")],
  ['M17d DB 제약이 배정 비율을 요구 안 함', P.migOpen,
    s => s.replace('      AND margin_allocation_pct IS NOT NULL\n', '')],

  // ── 사이징 돌연변이 ──
  ['M7  되읽은 배율 불일치를 통과시킴', P.sizing,
    s => s.replace('  if (obs !== req) {', '  if (false) {')],
  // 앞 검사를 지워도 바로 뒤의 `obs !== req`가 **같은 코드로** 막는다.
  // 동치 변이라 RED가 나오지 않는 것이 정상이다. 지우지 않고 남겨 둔다 —
  // 나중에 뒤 검사가 사라지면 이 줄이 RED로 바뀌어 알려 준다.
  ['M8  배율 못 읽음을 통과시킴 (동치 변이)', P.sizing,
    s => s.replace('  if (obs == null || !Number.isFinite(obs)) {', '  if (false) {'), 'EQUIV'],
  // M9는 원래 `planSize100x` 안의 UNSET 분기를 겨눴다. 그 규칙이
  // `validateMarginAllocation`으로 빠지면서 옛 문구는 더 이상 규칙을
  // 건드리지 못한다 — **정본이 옮겨갔으면 변이도 따라가야 한다.**
  // 안 따라가면 "검출됨"이 아니라 "겨누지 않음"이 되고, 그건 탐지력
  // 과대보고다.
  ['M9  증거금 배정 미지정을 통과시킴', P.sizing,
    s => s.replace(
      "  if (pct == null) {\n    return {\n      code: 'MARGIN_ALLOCATION_UNSET',",
      "  if (false) {\n    return {\n      code: 'MARGIN_ALLOCATION_UNSET',"), 'RED'],

  ['M9b 배정 비율 범위 검사를 통과시킴', P.sizing,
    s => s.replace('  if (!Number.isFinite(n) || n <= 0 || n > 100) {', '  if (false) {'), 'RED'],

  // 옛 M9 문구는 이제 **정말로 동치**다 — 앞에서 null이 걸러지므로
  // `?? 10`에 도달할 수 없다. 동치라는 사실 자체를 박아 둔다.
  ['M9c 옛 fallback 문구 (도달 불가 · 동치)', P.sizing,
    s => s.replace('  const pct = Number(i.marginAllocationPct);',
                   '  const pct = Number(i.marginAllocationPct ?? 10);'), 'EQUIV'],

  // ── 조합 제한 ──
  ['P1  전용 100배가 STABILIZE에서도 해석됨', P.plan,
    s => s.replace(/export const EXCLUSIVE_PAIRS[\s\S]*?\];/,
      "export const EXCLUSIVE_PAIRS: ReadonlyArray<{ profileId: StrategyType; presetId: RiskPresetId }> = [];")],
  ['P2  조합 검증이 죽음', P.plan,
    s => s.replace('  const mismatch = pairMismatchReason(pid, sid);', "  const mismatch = '';")],
  ['P3  프리셋 쪽 방향만 막음 (다른 프로필 + EXACT_100X 통과)', P.plan,
    s => s.replace(/    if \(presetId === pair\.presetId && profileId !== pair\.profileId\) \{[\s\S]*?\n    \}\n/, '')],
  ['P4  전용 프리셋 표에서 100X 항목 제거', P.preset,
    s => s.replace(/  EXACT_100X: \{[\s\S]*?\n  \},\n\};/, "  EXACT_100X: {},\n};")],
  ['P5  presetOf가 EXACT_100X를 기본값으로 눕힘', P.preset,
    s => s.replace("  if (s === 'EXACT_100X') return 'EXACT_100X';\n", '')],

  // ── production 배선 ──
  ['W9  scalp가 사이징 정책으로 갈라지지 않음', P.scalp,
    s => s.replace("if (epSizingPolicy === 'MARGIN_ALLOCATION') {", 'if (false) {')],
  ['W10 scalp가 executeOrder에 stopPolicy를 안 넘김', P.scalp,
    s => s.replace('    stopPolicy: epStopPolicy,\n', '')],
  ['W11 scalp가 체크리스트에 stopPolicy를 안 넘김', P.scalp,
    s => s.replace('    stopPolicy: epStopPolicy,\n  });', '  });')],
  ['W12 진입 계획이 planSize100x를 안 씀', P.entry,
    s => s.replace('  const size: Sizing100xVerdict = planSize100x({',
      '  const size: Sizing100xVerdict = ((_: any) => ({ ok: true, code: "OK", quantity: 1, allocatedMargin: 1, targetNotional: 1, leverage: 100, message: "" }) as any)({')],
  ['W13 예약의 배정 비율이 요청에 안 실림', P.runreq,
    s => s.replace(/    if \(i\.marginAllocationPct != null[\s\S]*?\n    \}\n/, '')],
  ['W14 저장 라우트가 marginPct를 배정 비율로 상속', P.sched,
    s => s.replace('      allocCols = { margin_allocation_pct: n };',
      '      allocCols = { margin_allocation_pct: body?.marginPct };')],

  // ── 진입 순서·마진 모드 ──
  ['E1  교차 마진인데 진입', P.entry,
    s => s.replace('  if (!allowed.includes(mode)) {', '  if (false) {')],
  ['E2  마진 모드를 모르는데 진입', P.entry,
    s => s.replace('  if (mode == null) {', '  if (false) {')],
  ['E3  배율 되읽기 불일치를 통과 (확정 단계)', P.entry,
    s => s.replace('  if (bad) {', '  if (false) {')],
  ['E4  거래소 규격 실패를 통과', P.entry,
    s => s.replace('  if (q.qty == null || !(q.qty > 0)) {', '  if (false) {')],
  ['E5  필요 증거금 재검증 제거', P.entry,
    s => s.replace('  if (requiredMargin > allocated) {', '  if (false) {')],
  // 마진 모드 블록 전체를 배율 블록 **뒤로** 옮긴다. 교차 계좌에 배율부터
  // 걸면, 막을 주문을 위해 계좌 설정을 먼저 바꾸는 것이 된다.
  ['E6  마진 모드 확인보다 배율 설정이 먼저', P.entry, s => {
    const mm = /  \/\/ ── ① 마진 모드 ──[\s\S]*?notes\.push\(`마진 모드 \$\{mode\} \(되읽음\)`\);\n(?:[\s\S]*?\n  \}\n)/;
    const m = mm.exec(s);
    if (!m) return s;
    const block = m[0];
    const without = s.replace(block, '');
    return without.replace('  notes.push(`배율 ${req}배 확인(되읽음)`);',
      '  notes.push(`배율 ${req}배 확인(되읽음)`);\n' + block);
  }],
  ['M10 잔고 못 읽음 → 0', P.sizing,
    s => s.replace('  if (i.availableUsd == null || !Number.isFinite(Number(i.availableUsd))) {', '  if (false) {')],
  ['M11 기준가 못 읽음 → 통과', P.sizing,
    s => s.replace('  if (i.referencePrice == null || !finitePos(i.referencePrice)) {', '  if (false) {')],

  // ── 재부착 / 체크리스트 / 청산 감시 ──
  ['M12 재부착: 값 검사가 정책보다 앞', P.reattach,
    s => s.replace(/  if \(String\(o\?\.stop_policy \|\| ''\) === 'NO_FIXED_SL'\) \{\n    return no\('NO_FIXED_SL'[\s\S]*?\n  \}\n\n  const stop = Number\(o\?\.stop_loss\);\n  if \(!Number\.isFinite\(stop\) \|\| stop <= 0\) return no\('NO_PLANNED_STOP'\);/,
      "  const stop = Number(o?.stop_loss);\n  if (!Number.isFinite(stop) || stop <= 0) return no('NO_PLANNED_STOP');\n\n  if (String(o?.stop_policy || '') === 'NO_FIXED_SL') {\n    return no('NO_FIXED_SL', '손절 복구 안 함');\n  }")],
  ['M13 체크리스트: STOP_ATTACHED를 N/A 목록에서 제거', P.cl,
    s => s.replace("  'STOP_ATTACHED', 'LIQUIDATION_DISTANCE', 'PROTECTIVE_ORDER',", "  'LIQUIDATION_DISTANCE', 'PROTECTIVE_ORDER',")],
  ['M14 체크리스트: runChecklist가 stopPolicy를 안 넘김', P.cl,
    s => s.replace("      input.overtrading != null, exchangeEvidence, stopPolicy));", "      input.overtrading != null, exchangeEvidence));")],
  ['M15 체크리스트: N/A 조건이 죽음', P.cl,
    s => s.replace("  if (stopPolicy === 'NO_FIXED_SL' && FIXED_STOP_ONLY_CHECKS.includes(id)) return false;", "  if (false) return false;")],
  ['M16 청산 감시: NO_FIXED_STOP 가드 제거', P.life,
    s => s.replace(/  if \(!\(Number\(p\.stopLoss\) > 0\)\) \{\n    return no\('NO_FIXED_STOP',[\s\S]*?\n  \}\n/, '')],
  ['M18 진입: 모순(손절가 동반)을 조용히 통과', P.exec,
    s => s.replace('  if (noFixedSl && args.stopLoss != null) {', '  if (false) {')],
  ['M19 진입: stop_policy를 장부에 안 적음', P.exec,
    s => s.replace("    ...(noFixedSl ? { stop_policy: 'NO_FIXED_SL' } : {}),", '')],
  ['M20 마이그레이션: NOT NULL 강제', P.mig,
    s => s.replace('ADD COLUMN IF NOT EXISTS stop_policy text;', "ADD COLUMN IF NOT EXISTS stop_policy text NOT NULL DEFAULT 'FIXED_SL';")],

  // ── 쓰기 이전 권한선 (이번 라운드) ──
  //
  // 여기서 세는 것은 "막았는가"가 아니라 **"막힐 요청이 거래소를
  // 건드리지 않았는가"**다. 그래서 게이트를 지우는 변이가 아니라
  // **쓰기 뒤로 되돌리는** 변이를 넣는다 — 게이트는 그대로 있고 순서만
  // 원래대로 돌아간다. 줄을 옮기는 diff는 위험해 보이지 않으므로,
  // 검사가 잡지 못하면 이 회귀가 조용히 들어온다.
  ['MUT-PREWRITE-CONFLICT  전략 충돌 게이트를 쓰기 뒤로 되돌림', P.scalp,
    s => moveAfterWrite(s,
      "    const { strategyConflictGate, sleeveCapitalGate } = await import('@/lib/engine/strategyConflictGate');",
      "    const cf = await strategyConflictGate(sb, {", "    }\n"), 'RED'],

  ['MUT-PREWRITE-SLEEVE    슬리브 자본 게이트를 쓰기 뒤로 되돌림', P.scalp,
    s => moveAfterWrite(s,
      "    const sl = await sleeveCapitalGate(sb, {", null, "    }\n"), 'RED'],

  // 새로 생긴 후단 차단을 잡는가. 위 두 개는 "옮긴 것이 도로 내려갔는가"만
  // 본다 — 그것으로는 **내일 새로 붙는** 게이트를 못 잡는다.
  ['MUT-PREWRITE-CHECKLIST 등록되지 않은 후단 차단 추가', P.scalp,
    // 쓰기 **뒤**에 새 차단을 붙인다. 점검 목록은 이제 쓰기 앞이므로
    // 거기 붙이면 정당한 pre-write 게이트가 되어 잡히지 않는다 —
    // 확정 단계 뒤, 주문 직전에 넣어야 이 규칙을 겨눈다.
    s => s.replace(
      "  const { executeOrder } = await import('@/lib/engine/orderExecutor');",
      "  if ((base as any).__never) {\n"
      + "    return NextResponse.json({ ...base, executed: false, blocked: 'NEW_LATE_GATE',\n"
      + "      error: '새로 붙인 후단 차단' }, { status: 409 });\n"
      + "  }\n"
      + "  const { executeOrder } = await import('@/lib/engine/orderExecutor');"), 'RED'],

  // 사람 확인을 다시 명목가 뒤로 되돌린다 — confirm 없는 실계좌 요청이
  // 409로 막히기 전에 실계좌의 배율이 바뀌던 그 경로다.
  ['MUT-PREWRITE-CONFIRM   사람 확인을 쓰기 뒤로 되돌림', P.scalp,
    s => moveAfterWrite(s,
      "    if (modeNeedsConfirmation(opMode) && body.confirm !== true) {", null, "    }\n"), 'RED'],

  // 확인 요구 판정을 두 벌로 만든다. gateOrder만 고치고 쓰기 전 판정은
  // 그대로 두면, 한쪽만 고쳐지는 이 저장소의 단골 고장이 된다.
  ['MUT-CONFIRM-TWO-COPIES 확인 요구 규칙을 두 벌로', 'src/lib/engine/operatingMode.ts',
    s => s.replace('    needsConfirmation: modeNeedsConfirmation(mode),',
                   '    needsConfirmation: cap.realMoney && !cap.autoTrade,'), 'EQUIV'],

  ['MUT-CONFIRM-FLIP       확인 요구를 항상 false로', 'src/lib/engine/operatingMode.ts',
    s => s.replace('  return cap.realMoney && !cap.autoTrade;\n}',
                   '  return false;\n}'), 'RED'],

  // 배정 비율 검사를 쓰기 뒤로 되돌린다. 카운터가 실제로 잡은 결함이라
  // 이 변이가 GREEN이면 그 결함이 그대로 돌아온 것이다.
  // 2단계로 나눈 뒤 이 변이는 **정말로 동치**가 됐다. 준비 단계에는 쓰기
  // 함수가 아예 없으므로, 앞당긴 검사를 지워도 `planSize100x`가 여전히
  // 같은 단계에서 막고 거래소는 건드려지지 않는다. 동치라는 사실을 박아
  // 둔다 — RED로 기대해 두면 다음 사람이 없는 결함을 찾는다.
  ['MUT-ALLOC-AFTER-WRITE  앞당긴 배정 비율 검사 제거 (동치)', P.entry,
    s => s.replace(/  const allocBad = validateMarginAllocation\(marginAllocationPct\);\n  if \(allocBad\) \{\n    return fail\('SIZING_BLOCKED', allocBad\.message, notes, \{ marginMode: mode \}\);\n  \}\n/, ''),
    'EQUIV'],

  // 검사를 복제해 두 벌로 만든다 — 규칙이 갈리는 모양 그대로.
  ['MUT-ALLOC-TWO-COPIES   배정 비율 검사를 복제', P.sizing,
    s => s.replace('  const alloc = validateMarginAllocation(i.marginAllocationPct);\n  if (alloc) return block(alloc.code, alloc.message);',
      "  if (i.marginAllocationPct == null) return block('MARGIN_ALLOCATION_UNSET', '미지정');\n"
      + "  if (!(Number(i.marginAllocationPct) > 0)) return block('MARGIN_ALLOCATION_INVALID', '범위 밖');"),
    'EQUIV'],

  // 통합 카운터를 이름 하나 세기로 좁힌다. 분류가 무너지면 새 쓰기가
  // 카운터 밖으로 샌다.
  ['MUT-COUNTER-NARROW     쓰기 분류 목록을 비움', P.entry,
    s => s.replace("export const MUTATING_DEPS = ['applyLeverage'] as const;",
                   "export const MUTATING_DEPS = [] as const;"), 'RED'],

  // 감싸기를 풀어 순서를 줄 위치에만 맡긴다.
  ['MUT-GUARD-BYPASS       권한 판정을 무시하고 항상 실행', P.auth,
    s => s.replace('  if (!verdict.allowed) return { verdict, result: null };',
                   '  if (!verdict.allowed) return { verdict, result: await mutate() };'), 'RED'],

  // ── 2단계 분리 (이번 라운드) ──
  //
  // 여기서 보는 것은 "막았는가"가 아니라 **"막힐 요청이 배율을 걸기
  // 전에 막혔는가"**다. 그래서 게이트를 지우는 변이가 아니라, 읽기를
  // 쓰기 뒤로 미루는 변이를 넣는다.

  ['MUT-BALANCE-BEFORE-WRITE  잔고 조회를 쓰기 뒤로', P.entry,
    s => moveReadAfterWrite(s, 'availableUsd'), 'RED'],

  ['MUT-PRICE-BEFORE-WRITE    기준가 조회를 쓰기 뒤로', P.entry,
    s => moveReadAfterWrite(s, 'referencePrice'), 'RED'],

  // 다듬기·증거금 재검증·후보 사이징을 통째로 확정 단계로 미룬다.
  // 준비 단계가 통과해 버리므로, 그 뒤에서 막힐 요청이 배율을 먼저 건다.
  ['MUT-QUANTIZE-BEFORE-WRITE 규격 실패를 준비 단계에서 통과', P.entry,
    s => s.replace('  if (q.qty == null || !(q.qty > 0)) {', '  if (false) {'), 'RED'],

  ['MUT-MARGIN-EXCEEDED-BEFORE-WRITE 증거금 초과를 준비 단계에서 통과', P.entry,
    s => s.replace('  if (requiredMargin > allocated) {', '  if (false) {'), 'RED'],

  // 1회 상한을 쓰기 뒤로 되돌린다 — 상한에 걸릴 요청이 계좌를 먼저 바꾼다.
  // 규칙이 라우트의 `if`에 있을 때 이 변이는 그대로 새 나갔다. 검사기가
  // "gateOrder를 부르는가"라는 문자열만 봤기 때문이다 — 부르고 결과를
  // 버려도 통과였다. 규칙을 확정 단계로 옮긴 뒤 다시 겨눈다.
  ['MUT-NOTIONAL-BEFORE-WRITE 확정 단계가 상한 판정을 무시', P.entry,
    s => s.replace("  if (!preWrite || preWrite.disposition !== 'SEND') {", '  if (false) {'), 'RED'],

  ['MUT-NOTIONAL-NOT-PASSED   라우트가 상한 판정을 안 넘김', P.scalp,
    s => s.replace('      modeGate,\n    );', "      { disposition: 'SEND', reason: '' },\n    );"), 'RED'],

  // 정확 배율 확인을 없앤다 — 75/99/null이 주문으로 간다.
  ['MUT-LEVERAGE-VERIFY       정확 배율 확인 제거', P.entry,
    s => s.replace('  const bad = verifyLeverageExact(req, lev.ok ? lev.observed : null);',
                   '  const bad = null;'), 'RED'],

  // 이것도 동치다: 못 읽으면 obs가 null이고 `null !== 100`이라 다음 가지가
  // 그대로 막는다. 막는 힘은 같고 사유 문구만 달라진다.
  ['MUT-LEVERAGE-VERIFY-LOOSE 되읽기 실패 가지 제거 (동치)', P.sizing,
    s => s.replace('  if (obs == null || !Number.isFinite(obs)) {', '  if (false) {'), 'EQUIV'],

  ['MUT-LEVERAGE-VERIFY-CAP   낮춰 준 배율을 통과시킴', P.sizing,
    s => s.replace('  if (obs !== req) {', '  if (obs > req) {'), 'RED'],

  // 읽기 단계에 쓰기 의존을 다시 끼워 넣는다 — 구조적 보장이 무너진다.
  ['MUT-PHASE-TYPE-MERGE      준비 단계가 쓰기 의존을 받게 함', P.entry,
    s => s.replace('  deps: Entry100xReadDeps,\n): Promise<Entry100xVerdict> {',
                   '  deps: Entry100xDeps,\n): Promise<Entry100xVerdict> {'), 'RED'],

  // 막힌 계획으로 확정을 불러도 쓰지 않는다는 방어를 없앤다.
  ['MUT-COMMIT-ON-BLOCKED     막힌 계획으로도 배율을 걺', P.entry,
    s => s.replace('  if (!prepared.ok) return { ...prepared, notes };', ''), 'RED'],

  // ── 과도 검출 대조군 (GREEN이어야 함) ──
  ['OK1 주석 한 줄 추가', P.sizing, s => `// 대조군\n${s}`, 'GREEN'],
  // **대조군은 정말로 중립이어야 한다.**
  //
  // 예전 대조군은 `simSeed: 1_000 → 2_000`이었다. 게이트가 검사기뿐일
  // 때는 중립이었지만, 시험까지 보게 되자 모의 시드를 못박은 시험이
  // 정당하게 잡았다 — 과도 검출이 아니라 **대조군이 틀린 것**이다.
  // 실행 계약과 무관하면서 아무 시험도 못박지 않는 변경으로 바꾼다.
  ['OK2 계약 파일에 주석 한 줄 추가', P.plan, s => `// 대조군\n${s}`, 'GREEN'],
  ['OK3 변경 없음', P.sizing, s => s, 'NOOP-EXPECTED'],
];

/**
 * 읽기 호출 하나를 **확정 단계로 미룬다.**
 *
 * 지우는 변이가 아니다 — 조회는 그대로 일어나고 자리만 쓰기 뒤로 간다.
 * 검사가 "부르는가"만 보면 이 변이를 놓치고, 그때 그 조회가 실패하는
 * 요청은 계좌 배율을 먼저 바꾼다.
 */
function moveReadAfterWrite(src, dep) {
  // 준비 단계에서 그 조회를 없애고, 실패해도 통과하도록 눕힌다.
  if (dep === 'availableUsd') {
    return src.replace('  try { avail = await deps.availableUsd(); } catch { avail = null; }',
                       '  avail = 1000;');
  }
  if (dep === 'referencePrice') {
    return src.replace('  try { price = await deps.referencePrice(); } catch { price = null; }',
                       '  price = 50000;');
  }
  return src;
}

function moveAfterWrite(src, startMarker, alsoFrom, endMarker) {
  const from = src.indexOf(startMarker);
  if (from < 0) return src;
  const searchFrom = alsoFrom ? src.indexOf(alsoFrom, from) : from;
  if (searchFrom < 0) return src;
  const end = src.indexOf(endMarker, searchFrom);
  if (end < 0) return src;
  const stop = end + endMarker.length;
  const block = src.slice(from, stop);
  const rest = src.slice(0, from) + src.slice(stop);
  const AFTER = '  const plan: any = guarded.result;\n';
  const at = rest.indexOf(AFTER);
  if (at < 0) return src;
  const cut = at + AFTER.length;
  // 응답 모양을 뒤쪽 형태로 바꿔 컴파일이 되게 한다 — 변이가 컴파일
  // 오류로 죽으면 "틀린 이유로 RED"가 되어 판정이 무의미해진다.
  const moved = block.replace(/\.\.\.preBase, ok: false, /g, '...base, ');
  return rest.slice(0, cut) + moved + rest.slice(cut);
}

// ── 복원 ──
//
// **`git checkout --`을 쓰지 않는다.** 그 방식은 한 번 사용자의 커밋되지
// 않은 작업을 통째로 지웠고, 그 뒤 변이들이 전부 거짓 신호를 냈다.
// 여기서는 변이 직전에 읽어 둔 **원본 바이트를 그대로 다시 쓴다.** 이러면
// git 상태와 무관하게 정확히 되돌아가고, 무엇을 지울 수도 없다.
const restoreExact = (file, original) => writeFileSync(file, original);

// `--only`가 있으면 그것만 남긴다. 진단용이므로 **결과 요약에 그대로
// 반영된다** — 일부만 돌린 결과를 전체 결과로 착각하지 않도록 총계도
// 줄어든 수로 적힌다.
const SELECTED = ONLY
  ? M.filter(([name]) => ONLY.some(p => name.startsWith(p)))
  : M;
if (ONLY && SELECTED.length === 0) {
  console.error(`❌ --only ${ONLY.join(',')} 에 맞는 돌연변이가 없습니다`);
  process.exit(1);
}

const gitDirty = () =>
  execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    .split('\n').map(l => l.slice(3).trim()).filter(Boolean);

if (LIST_ONLY) {
  for (const [name, file, , kind = 'RED'] of SELECTED) console.log(`${kind.padEnd(14)} ${name}  →  ${file}`);
  console.log(`\n총 ${SELECTED.length}건`);
  process.exit(0);
}

// ── 자기 점검 (일반 CI용, 빠름) ──
//
// 전수 실행은 오래 걸리므로 CI에서는 이것만 돈다. 목록이 살아 있고, 대상
// 파일이 전부 존재하고, 각 돌연변이가 **실제로 적용되는지**까지 본다 —
// 적용되지 않는 돌연변이는 통과가 아니라 "아무것도 안 겨눔"이고, 그것이
// 탐지력 과대보고의 원인이다.
if (SELF_TEST) {
  let bad = 0;
  const seen = new Set();
  // 자기 점검은 파일을 **바꾸지 않는다.** 그것을 확인하려면 "지금 더러운가"가
  // 아니라 "이 점검 때문에 더러워졌는가"를 봐야 한다. 하네스 파일 자체가
  // 아직 커밋되지 않은 상태에서 돌리면 앞의 방식은 거짓 경보를 낸다.
  const dirtyBefore = new Set(gitDirty());
  for (const [name, file, mutate, kind = 'RED'] of SELECTED) {
    if (seen.has(name)) { console.error(`❌ 이름이 겹칩니다: ${name}`); bad++; }
    seen.add(name);
    let before;
    try { before = readFileSync(file, 'utf8'); }
    catch { console.error(`❌ ${name}: 대상 파일이 없습니다 — ${file}`); bad++; continue; }
    let after;
    try { after = mutate(before); }
    catch (e) { console.error(`❌ ${name}: 변이 함수가 던졌습니다 — ${e?.message || e}`); bad++; continue; }
    const applied = after !== before;
    if (kind === 'NOOP-EXPECTED') {
      if (applied) { console.error(`❌ ${name}: 적용되면 안 되는데 적용됐습니다`); bad++; }
    } else if (!applied) {
      console.error(`❌ ${name}: 적용되지 않습니다 — 정본이 옮겨갔으면 변이도 따라가야 합니다`);
      bad++;
    }
  }
  const newlyDirty = gitDirty().filter(f => !dirtyBefore.has(f));
  if (newlyDirty.length) {
    console.error('❌ 자기 점검이 파일을 바꿨습니다 (그럴 리 없습니다):');
    for (const f of newlyDirty) console.error(`   · ${f}`);
    bad++;
  }
  if (bad) { console.error(`\n돌연변이 하네스 자기 점검 실패: ${bad}건`); process.exit(1); }
  console.log(`✅ 돌연변이 하네스 자기 점검 — ${SELECTED.length}건 전부 겨냥 가능`);
  process.exit(0);
}

// ── 더러운 트리에서는 돌지 않는다 ──
//
// 복원 자체는 안전해졌지만(원본 바이트를 되쓴다), **판정이 오염된다.**
// 커밋되지 않은 변경이 있으면 "변이 뒤에 트리가 깨끗한가" 검사가 그것을
// 대상 밖 변경으로 읽고 매번 멈춘다. 그리고 무엇보다, 무엇을 검증한
// 것인지가 불분명해진다 — 증거는 특정 커밋에 대한 것이어야 한다.
{
  const dirty = gitDirty();
  if (dirty.length) {
    console.error('❌ 워킹 트리가 깨끗하지 않습니다. 먼저 커밋하거나 되돌리세요:');
    for (const f of dirty) console.error(`   · ${f}`);
    console.error('\n   증거는 특정 커밋에 대한 것이어야 합니다.');
    process.exit(2);
  }
}

// 중간에 죽어도 원본으로 되돌린다. 되돌리지 못한 채 끝나면 다음 실행이
// 더러운 트리로 거부되므로 조용히 넘어가지는 않는다 — 그래도 여기서
// 되돌리는 편이 낫다.
// ══════════════════ 기준선 ══════════════════
//
// **변이를 넣기 전에 게이트가 초록인지 먼저 본다.**
//
// 이 검사가 없어서 한 번 크게 틀렸다. GitHub Actions에서 얕은 체크아웃
// (`fetch-depth: 1`)으로 돌렸더니 `check-execution-profile`이 비교할 base
// 커밋을 찾지 못해 **변이와 무관하게 항상 실패**했다. 그러자 105건이 전부
// 빨간불이 됐고, 하네스는 그것을 "검출 102 · 누락 0"이라고 적었다.
//
// 숫자는 그럴듯했지만 아무것도 측정하지 않았다. 대조군 2건이 함께 빨개진
// 덕분에 드러났을 뿐, 대조군이 없었다면 "전부 검출"로 보고됐을 것이다.
//
// 돌연변이 검사의 전제는 하나다: **지금 초록인 것이 변이 때문에 빨개져야
// 한다.** 처음부터 빨갛다면 어떤 변이를 넣어도 빨갛고, 그 실행은 판정이
// 아니라 잡음이다. 그래서 아예 시작하지 않는다.
{
  process.stdout.write('기준선 확인 (변이 없이 게이트가 초록인가) … ');
  const fail = gateChecker();
  if (fail) {
    console.log('실패\n');
    console.error(`❌ 변이를 넣기 전부터 게이트가 실패합니다: ${fail.name} (exit ${fail.code})`);
    console.error('   이 상태에서는 모든 변이가 빨간불이 되어 판정이 전부 거짓이 됩니다.');
    if (fail.output) {
      console.error('\n--- 게이트 출력 ---');
      console.error(fail.output.split('\n').slice(-25).join('\n'));
      console.error('-------------------');
    }
    // **원인을 단정하지 않는다.** 위의 게이트 출력이 정본이다. 여기서는
    // 지금까지 실제로 겪은 것만 적는다.
    console.error('\n   지금까지 실제로 겪은 원인:');
    console.error('   · 얕은 체크아웃(fetch-depth 1) — 검사기가 비교할 base 커밋을 찾지 못한다');
    console.error('     → 전체 이력을 받아서(fetch-depth 0) 다시 실행');
    console.error('   · 의존성 미설치 — 검사기가 TypeScript를 찾지 못한다');
    console.error('     → npm ci');
    process.exit(4);
  }
  console.log('초록');
}

let inFlight = null;
const rescue = () => { if (inFlight) { try { restoreExact(inFlight.file, inFlight.before); } catch {} inFlight = null; } };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { rescue(); process.exit(130); });
}
process.on('uncaughtException', (e) => { rescue(); console.error(e); process.exit(1); });

const started = Date.now();
let detected = 0, missed = 0, noop = 0, greenOk = 0, greenBad = 0, equiv = 0;
for (const [name, file, mutate, kind = 'RED'] of SELECTED) {
  const before = readFileSync(file, 'utf8');
  const after = mutate(before);
  if (after === before) {
    if (kind === 'NOOP-EXPECTED') { console.log(`  ·  ${name} — 적용 안 됨(의도대로)`); continue; }
    console.log(`  ⚠  ${name} — NOOP · 적용되지 않음 → 판정 불가`);
    noop++; continue;
  }
  inFlight = { file, before };
  writeFileSync(file, after);
  const fail = gateChecker();
  const rc = fail ? 1 : 0;
  restoreExact(file, before);
  inFlight = null;

  // ── 변이 뒤에 트리가 정말 깨끗한가 ──
  //
  // 복원이 한 파일만 되돌리므로, 게이트가 **다른 파일을 건드렸다면**
  // 그 변경이 남는다. 남은 채로 다음 변이를 돌리면 그 뒤 판정이 전부
  // 오염된다. 하네스가 스스로 틀리는 것이 가장 나쁘다 — 즉시 멈춘다.
  {
    const left = gitDirty();
    if (left.length) {
      console.error(`\n❌ ${name} 뒤에 트리가 깨끗하지 않습니다 — 대상 외 파일이 바뀌었습니다:`);
      for (const f of left) console.error(`   · ${f}`);
      console.error('   이후 판정이 오염되므로 중단합니다.');
      process.exit(3);
    }
  }

  if (kind === 'GREEN') {
    if (rc === 0) { console.log(`  ✓  ${name} — PASS (과도 검출 없음)`); greenOk++; }
    else {
      console.log(`  ✗  ${name} — 정상 변경인데 실패했다 (과도 검출 · ${fail.name})`);
      if (fail.output) console.log(fail.output.split('\n').slice(-8).map(l => `        ${l}`).join('\n'));
      greenBad++;
    }
  } else if (kind === 'EQUIV') {
    if (rc === 0) { console.log(`  ○  ${name} — GREEN (동치 변이 · 뒤 검사가 같은 코드로 막는다)`); equiv++; }
    else { console.log(`  ●  ${name} — RED (동치가 아니었다)`); detected++; }
  } else if (rc !== 0) {
    console.log(`  ●  ${name} — RED (검출${VERBOSE ? ` · ${fail.name}` : ''})`);
    detected++;
  }
  else { console.log(`  ✗  ${name} — GREEN (새 나감)`); missed++; }
}

// ── 끝나고도 깨끗한가 ──
{
  const left = gitDirty();
  if (left.length) {
    console.error('\n❌ 실행이 끝났는데 트리가 깨끗하지 않습니다:');
    for (const f of left) console.error(`   · ${f}`);
    process.exit(3);
  }
}

const mins = ((Date.now() - started) / 60_000).toFixed(1);
console.log(`\n검출 ${detected} / 누락 ${missed} / 동치 ${equiv} / 판정불가 ${noop}`
  + ` / 대조군 PASS ${greenOk} · 과도검출 ${greenBad}`);
console.log(`총 ${SELECTED.length}건 · ${mins}분 · 트리 clean 확인됨`
  + (ONLY ? `  (--only ${ONLY.join(',')} — 일부만 돌렸습니다)` : ''));
process.exit(missed || greenBad || noop ? 1 : 0);
