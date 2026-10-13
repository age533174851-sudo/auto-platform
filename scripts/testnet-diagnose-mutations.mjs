#!/usr/bin/env node
// scripts/testnet-diagnose-mutations.mjs
//
// **TESTNET 진단의 안전 조건을 하나씩 깨뜨려 본다.**
//
// 빨간불이 안 뜨면 그 조건은 지켜지는 것이 아니라 **아무도 안 보는
// 것**이다. 이 묶음이 겨냥하는 고장은 하나로 모인다:
//
//     확인하지 못한 것이 통과로 적히는 것 (UNKNOWN → READY)
//
// 그리고 그 변이는 **단위 시험만으로는 새 나갈 수 있다** — 라우트가
// 판정을 부르지 않게 되면 시험은 정본을 직접 부르므로 그대로 초록이다.
// 그래서 배선 변이(TD-13~TD-16)를 같이 둔다.
//
// 안전장치
// ────────
//   · `git clean`을 쓰지 않는다
//   · 복원은 **읽어 둔 원본 바이트를 그대로 다시 쓴다**
//   · 적용 전후가 실제로 달라졌는지 확인한 뒤에만 판정한다(아니면 NOOP)
//   · 시작·종료 시 트리가 깨끗한지 본다
//
//   실행:  node scripts/testnet-diagnose-mutations.mjs            (전수)
//          node scripts/testnet-diagnose-mutations.mjs --list
//          node scripts/testnet-diagnose-mutations.mjs --self-test
//          node scripts/testnet-diagnose-mutations.mjs --only TD-1

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const LIST = argv.includes('--list');
const SELF = argv.includes('--self-test');
const onlyAt = argv.indexOf('--only');
const ONLY = onlyAt >= 0 ? (argv[onlyAt + 1] || '').split(',').filter(Boolean) : null;

const P = {
  v: 'src/lib/engine/testnetDiagnoseVerdict.ts',
  route: 'src/app/api/binance/futures/diagnose/route.ts',
  fut: 'src/lib/exchanges/binanceFutures.ts',
};

/** [이름, 파일, 변이 함수, 종류?] */
const M = [
  // ── 판정 정본: 모르는 것을 통과로 ──
  ['TD-1  모르는 포지션 모드를 단방향으로', P.v,
    s => s.replace("  if (mode === 'ONE_WAY') {", '  if (mode !== \'HEDGE\') {')],
  ['TD-2  양방향을 통과로 (긴급 종료가 멈추는 모드다)', P.v,
    s => s.replace("  if (mode === 'HEDGE') {", '  if (false) {')],
  ['TD-3  격리 조회 실패를 통과로', P.v,
    s => s.replace("  if (i?.read !== true) return unknown('격리·배율 설정을 조회하지 못했습니다');",
      "  if (false) return unknown('격리·배율 설정을 조회하지 못했습니다');")],
  ['TD-4  빈 마진 타입을 통과로', P.v,
    s => s.replace("  if (!raw) return unknown('거래소가 마진 타입을 보고하지 않았습니다');",
      "  if (false) return unknown('거래소가 마진 타입을 보고하지 않았습니다');")],
  ['TD-5  교차 마진을 통과로', P.v,
    s => s.replace('  if (!isolated) {', '  if (false) {')],
  ['TD-6  모르는 마진 타입을 교차로 단정 (UNKNOWN을 FAIL로)', P.v,
    s => s.replace('    return crossed', '    return true')],
  ['TD-7  배율 미보고를 통과로', P.v,
    s => s.replace('  if (!Number.isFinite(lev as number) || lev == null) {', '  if (false) {')],
  ['TD-8  요구 배율이 0·NaN이어도 비교한다', P.v,
    s => s.replace('  if (!Number.isFinite(expected) || !(expected > 0)) {', '  if (false) {')],
  ['TD-9  배율 불일치를 통과로', P.v,
    s => s.replace('  if (lev !== expected) {', '  if (false) {')],
  ['TD-10 기록된 출금 false를 "확인됨"으로', P.v,
    s => s.replace("    status: 'UNKNOWN', code: 'NOT_VERIFIED_TESTNET_CONSTANT',",
      "    status: 'PASS', code: 'NOT_VERIFIED_TESTNET_CONSTANT',")],
  ['TD-11 UNKNOWN이 있어도 READY', P.v,
    s => s.replace('      : unknown > 0 ? \'UNKNOWN\'', '      : unknown > 0 ? \'READY\'')],
  ['TD-12 항목이 하나도 없어도 READY', P.v,
    s => s.replace("        : pass > 0 ? 'READY' : 'UNKNOWN';", "        : 'READY';")],
  ['TD-12b 상태 없는 항목을 통과로 센다', P.v,
    s => s.replace('    unknown += 1;', '    pass += 1;')],
  ['TD-12c statusToOk가 UNKNOWN을 ok로', P.v,
    s => s.replace("  return status === 'PASS';", "  return status !== 'FAIL';")],

  // ── 배선: 라우트가 판정을 부르지 않게 된다 ──
  //   단위 시험은 정본을 직접 부르므로 **그대로 초록이다.**
  ['TD-13 라우트가 모드 판정을 부르지 않는다', P.route,
    s => s.replace('    const v = positionModeVerdict(m);',
      "    const v = { status: 'PASS' as const, code: 'ONE_WAY', reason: '' };")],
  ['TD-14 라우트가 격리 판정을 부르지 않는다', P.route,
    s => s.replace('    const v = isolationVerdict({',
      "    const v = { status: 'PASS' as const, code: 'READY', reason: '' }; const _unused = ({")],
  ['TD-15 라우트가 출금 증거를 부르지 않는다', P.route,
    s => s.replace('    const v = withdrawalEvidence({',
      "    const v = { status: 'PASS' as const, code: 'X', reason: '' }; const _unused2 = ({")],
  ['TD-16 전체 판정을 응답에서 뺀다', P.route,
    s => s.replace('    readiness,', '')],
  ['TD-17 요구 배율을 라우트에 숫자로 박는다', P.route,
    s => s.replace("    const expectedLeverage = overrideOf('MAX_LEV_100X', 'EXACT_100X').leverage;",
      '    const expectedLeverage = 100;')],

  // ── 관문 ──
  ['TD-18 TESTNET 전용 관문을 치운다', P.route,
    s => s.replace('  if (!gate.ok) {', '  if (false) {')],
  ['TD-19 진단이 배율을 바꿔 놓는다 (읽기 전용 위반)', P.route,
    s => s.replace("  const checks: Check[] = [];",
      "  const checks: Check[] = [];\n  await import('@/lib/exchanges/binanceFutures')"
      + ".then(m => (m as any).setFuturesLeverage?.(apiKey, secret, testnet, 'BTCUSDT', 100));")],

  // ── 조회가 플랫 심볼을 걸러내면 진입 전에 확인할 수 없다 ──
  ['TD-20 설정 조회가 수량 0을 걸러낸다', P.fut,
    s => s.replace("    const row = rows.find((p: any) => String(p?.symbol ?? '').toUpperCase() === sym);",
      "    const row = rows.filter((p: any) => parseFloat(p.positionAmt) !== 0)"
      + ".find((p: any) => String(p?.symbol ?? '').toUpperCase() === sym);")],
  ['TD-21 응답에 심볼이 없으면 기본값으로 메운다', P.fut,
    s => s.replace("      return { ok: false, marginType: null, leverage: null, positionAmt: null,\n        error: `${sym} 설정 줄이 응답에 없습니다` };",
      "      return { ok: true, marginType: 'isolated', leverage: 100, positionAmt: 0, error: null };")],

  // ── 대조군: 아무것도 깨지 않는 변이. **빨개지면 과도 검출이다** ──
  ['OK1   주석 한 줄 추가 (중립이어야 한다)', P.v,
    s => s.replace('export type DiagnoseStatus', '// 중립 변이\nexport type DiagnoseStatus'), 'GREEN'],
];

const FILTERED = ONLY ? M.filter(([n]) => ONLY.some(p => n.startsWith(p))) : M;

if (LIST) {
  for (const [n, f] of FILTERED) console.log(`${n}  ·  ${f}`);
  console.log(`\n총 ${FILTERED.length}건`);
  process.exit(0);
}

const gitDirty = () => execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
  .split('\n').map(l => l.slice(3).trim()).filter(Boolean);

if (gitDirty().length > 0) {
  console.error('❌ 작업 트리가 깨끗하지 않습니다 — 변이가 섞이면 결과를 믿을 수 없습니다');
  process.exit(1);
}

// 앵커가 실제로 적용되는지만 본다 (빠름)
if (SELF) {
  let bad = 0;
  for (const [name, file, fn] of FILTERED) {
    const orig = readFileSync(file, 'utf8');
    if (fn(orig) === orig) {
      console.error(`❌ ${name}: 적용되지 않습니다 — 정본이 옮겨갔으면 변이도 따라가야 합니다`);
      bad += 1;
    }
  }
  if (bad) { console.error(`\n자기 점검 실패: ${bad}건`); process.exit(1); }
  console.log(`✅ TESTNET 진단 변이 자기 점검 — ${FILTERED.length}건 전부 겨냥 가능`);
  process.exit(0);
}

const GATES = [
  ['check-testnet-diagnose', process.execPath, ['scripts/check-testnet-diagnose.mjs']],
  ['npm test', 'npm', ['test']],
];
const runGates = () => {
  for (const [n, cmd, args] of GATES) {
    try { execFileSync(cmd, args, { stdio: 'pipe', timeout: 900_000 }); }
    catch { return n; }
  }
  return null;
};

console.log('기준선 확인 (변이 없이 게이트가 초록인가) … ');
const base = runGates();
if (base) {
  console.error(`❌ 기준선이 이미 빨갛습니다 (${base}) — 변이 결과를 믿을 수 없습니다`);
  process.exit(1);
}
console.log('초록');

let red = 0, escaped = 0, noop = 0, green = 0, equiv = 0;
for (const [name, file, fn, kind = 'RED'] of FILTERED) {
  const orig = readFileSync(file, 'utf8');
  const next = fn(orig);
  if (next === orig) { console.log(`  ·  ${name} — 적용 안 됨(NOOP)`); noop += 1; continue; }
  writeFileSync(file, next);
  let failedGate = null;
  try { failedGate = runGates(); }
  finally { writeFileSync(file, orig); }
  const dirty = gitDirty();
  if (dirty.length > 0) {
    console.error(`❌ ${name}: 복원 뒤에도 트리가 더럽습니다 (${dirty.join(', ')}) — 중단합니다`);
    process.exit(1);
  }
  if (kind === 'GREEN') {
    if (failedGate) { console.log(`  ✗  ${name} — 대조군이 빨갛다 (${failedGate}) · 과도 검출`); escaped += 1; }
    else { console.log(`  ✓  ${name} — PASS (과도 검출 없음)`); green += 1; }
    continue;
  }
  if (kind === 'EQUIV') {
    if (failedGate) { console.log(`  ●  ${name} — RED (${failedGate}) · 동치인데 잡혔다`); red += 1; }
    else { console.log(`  ○  ${name} — GREEN (동치 변이 · 뒤 코드가 같은 결과를 만든다)`); equiv += 1; }
    continue;
  }
  if (failedGate) { console.log(`  ●  ${name} — RED (${failedGate})`); red += 1; }
  else { console.log(`  ✗  ${name} — GREEN (새 나감)`); escaped += 1; }
}

console.log(`\n검출 ${red} / 누락 ${escaped} / 동치 ${equiv} / NOOP ${noop} / 대조군 PASS ${green}`);
console.log(`총 ${FILTERED.length}건 · 트리 clean 확인됨`);
process.exit(escaped > 0 || noop > 0 ? 1 : 0);
