#!/usr/bin/env node
// scripts/kill-close-mutations.mjs
//
// **긴급 종료 안전 조건을 하나씩 깨뜨려 본다.**
//
// 빨간불이 안 뜨면 그 조건은 지켜지는 것이 아니라 **아무도 안 보는
// 것**이다. 특히 이 묶음의 첫 변이(KC-1)는 이번 수정의 전부다:
//
//     닫을 수 없으면 취소하지도 않는다 (`clamp`)
//
// 안전장치
// ────────
//   · `git clean`을 쓰지 않는다
//   · 복원은 **읽어 둔 원본 바이트를 그대로 다시 쓴다**
//   · 적용 전후가 실제로 달라졌는지 확인한 뒤에만 판정한다(아니면 NOOP)
//   · 시작·종료 시 트리가 깨끗한지 본다
//
//   실행:  node scripts/kill-close-mutations.mjs            (전수)
//          node scripts/kill-close-mutations.mjs --list
//          node scripts/kill-close-mutations.mjs --self-test
//          node scripts/kill-close-mutations.mjs --only KC-1

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const LIST = argv.includes('--list');
const SELF = argv.includes('--self-test');
const onlyAt = argv.indexOf('--only');
const ONLY = onlyAt >= 0 ? (argv[onlyAt + 1] || '').split(',').filter(Boolean) : null;

const P = {
  plan: 'src/lib/risk/killClosePlan.ts',
  run: 'src/lib/risk/killCloseRun.ts',
  sw: 'src/lib/risk/killSwitch.ts',
  lease: 'src/lib/engine/exitMonitorLease.ts',
  adapter: 'src/lib/exchanges/futuresAdapter.ts',
  fx: 'src/lib/exchanges/futuresExec.ts',
};

/** [이름, 파일, 변이 함수] */
const M = [
  // ★★ 이번 수정의 핵심
  // 정본이 내보내는 함수로 옮겨갔다(직접 시험하기 위해). **앵커를 따라간다.**
  ['KC-1  불변식 clamp 제거 (닫지 못하는데 취소 허용)', P.plan,
    s => s.replace('  if (p.mayClose === true) return p;', '  return p;')],
  ['KC-2  모드 관문 무력화 (HEDGE·UNKNOWN을 통과)', P.plan,
    s => s.replace('  if (v.ok !== true) {', '  if (false) {')],
  ['KC-3  관문 미통과를 허용', P.plan,
    s => s.replace('  if (v == null) {', '  if (v == null && false) {')],
  ['KC-4  포지션 미조회를 flat으로', P.plan,
    s => s.replace("  if (i?.positions?.ok !== true) {\n    return blocked('BLOCKED_POSITIONS_UNREAD',",
      "  if (false) {\n    return blocked('BLOCKED_POSITIONS_UNREAD',")],
  ['KC-5  미체결 미조회인데 취소 허용', P.plan,
    s => s.replace("      code: 'BLOCKED_ORDERS_UNREAD', mayCancel: false, mayClose: true,",
      "      code: 'BLOCKED_ORDERS_UNREAD', mayCancel: true, mayClose: true,")],
  ['KC-6  취소 범위를 계좌 전체로 (다른 심볼까지)', P.plan,
    s => s.replace('    if (!s || !closeSymbols.has(s)) continue;', '    if (!s) continue;')],
  ['KC-7  번호를 못 읽은 주문도 취소', P.plan,
    s => s.replace('    if (!id) { unidentified += 1; continue; }', '    if (!id) { cancelIds.push(id); continue; }')],
  ['KC-8  side를 무시하고 부호만 본다 (SHORT가 LONG이 된다)', P.plan,
    s => s.replace("    const declared = r?.side === 'LONG' || r?.side === 'SHORT' ? r.side : null;",
      '    const declared = null as any;')],
  ['KC-9  방향 모순을 통과', P.plan,
    s => s.replace('    if (side == null) { unusable += 1; continue; }',
      "    if (side == null) { closes.push({ symbol: s, side: 'LONG', qty: Math.abs(amt) }); continue; }")],
  ['KC-10 닫지 않는 단계가 점유 심볼의 주문도 취소', P.plan,
    s => s.replace('    if (occupied.has(s)) { retained += 1; continue; }', '    if (false) { retained += 1; continue; }')],
  ['KC-11 닫지 않는 단계가 포지션 미조회에도 취소', P.plan,
    s => s.replace("  if (i?.positions?.ok !== true) {\n    return { code: 'BLOCKED_POSITIONS_UNREAD', cancelIds: [],",
      "  if (false) {\n    return { code: 'BLOCKED_POSITIONS_UNREAD', cancelIds: [],")],
  ['KC-12 수량 못 읽은 줄을 플랫으로', P.plan,
    s => s.replace('    if (amt == null) { unusable += 1; continue; }', '    if (amt == null) { continue; }')],
  ['KC-13 보호 상태: 취소했는데 남은 것을 닫힌 것으로', P.plan,
    s => s.replace('  if (strippedProtection) {', '  if (false) {')],
  ['KC-14 보호 상태: 잔여 null을 0으로', P.plan,
    s => s.replace('  if (left == null) {', '  if (false) {')],

  // 실행 순서
  ['KC-15 쓰기 직전 울타리 재검증 제거', P.run,
    s => s.replace("  if (typeof deps.stillMine === 'function') {", '  if (false) {')],
  ['KC-16 울타리 조회 예외를 통과로', P.run,
    s => s.replace('    catch { mine = false; }', '    catch { mine = true; }')],
  ['KC-17 재시도 전 조회 없이 재전송', P.run,
    s => s.replace('        if (probe.ok !== true) {', '        if (false) {')],
  // ★ **동치 변이다.** 관문을 지워도 바로 아래 `deps.findByClientId(...)`가
  //   undefined 호출로 던지고, 그것을 감싼 try/catch가 `probe.ok = false`로
  //   떨어뜨려 **같은 결과**(재전송하지 않음)가 된다. 안전한 방향으로
  //   같아지는 것이므로 새 나간 것이 아니다.
  ['KC-18 조회 수단이 없어도 재전송 (동치 — catch가 같은 결과를 만든다)', P.run,
    s => s.replace("        if (typeof deps.findByClientId !== 'function') {", '        if (false) {'),
    'EQUIV'],
  ['KC-19 이미 있는 주문에도 재전송', P.run,
    s => s.replace('        if (probe.found === true) {', '        if (false) {')],
  ['KC-20 중복 식별자 거부를 실패로 적는다', P.run,
    s => s.replace('      if (r.ok !== true && isDuplicateIntentError(r.error)) {', '      if (false) {')],
  ['KC-21 멱등 식별자를 싣지 않는다', P.run,
    s => s.replace('    const clientOrderId = killIntentId({', '    const clientOrderId = ((): string => \'\')(); const _unused = ({')],
  ['KC-22 계획이 막아도 실행한다', P.run,
    s => s.replace('  if (plan.mayClose !== true) {', '  if (false) {')],

  // 배선
  ['KC-23 킬스위치가 계좌 전체 취소로 되돌아간다', P.sw,
    s => s.replace("  const { planKillCancelOnly } = await import('./killClosePlan');",
      "  const { planKillCancelOnly } = await import('./killClosePlan');\n  const { futuresCancelAll } = await import('@/lib/exchanges/futuresAdapter');\n  void futuresCancelAll;")],
  ['KC-24 킬스위치가 side를 넘기지 않는다', P.sw,
    s => s.replace("        side: (p?.side === 'SHORT' ? 'SHORT'\n          : p?.side === 'LONG' ? 'LONG' : null) as 'LONG' | 'SHORT' | null })) };",
      '        side: null as any })) };')],
  ['KC-25 임차 선점이 기본값이 된다', P.lease,
    s => s.replace('    if (i.preempt === true) {', '    if (i.preempt !== false) {')],
  ['KC-26 미체결 조회 실패를 "없음"으로 읽는다', P.adapter,
    s => s.replace('    if (r?.success !== true) {', '    if (false) {')],
  ['KC-27 계좌 범위 관문이 방향까지 면제한다', P.fx,
    s => s.replace("  if (i.scope !== 'ACCOUNT'\n      && i.exchange === 'binance'", '  if (false\n      && i.exchange === \'binance\'')],

  ['KC-28 무방비 노출을 운영자 알림에서 정상 실행처럼 적는다',
    'src/lib/risk/killAlert.ts',
    s => s.replace('  const unprotected = safety?.unprotected === true;', '  const unprotected = false;')],
  ['KC-29 할 일 없는 회차의 잔여를 모른다고 적는다 (경고 홍수)', P.run,
    s => s.replace("  const leftover = plan.code === 'NOTHING_TO_DO' ? 0 : null;",
      '  const leftover = null;')],
  ['KC-30 막힌 회차의 잔여를 0으로 적는다', P.run,
    s => s.replace("  const leftover = plan.code === 'NOTHING_TO_DO' ? 0 : null;",
      '  const leftover = 0;')],

  // 대조군
  ['OK1 주석 한 줄 추가 (중립이어야 한다)', P.plan, s => `// 대조군\n${s}`, 'GREEN'],
];

const FILTERED = ONLY ? M.filter(([n]) => ONLY.some(p => n.startsWith(p))) : M;

if (LIST) {
  for (const [n, f, , kind = 'RED'] of FILTERED) console.log(`${String(kind).padEnd(5)} ${n}  →  ${f}`);
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
    if (fn(orig) === orig) { console.error(`❌ ${name}: 적용되지 않습니다 — 정본이 옮겨갔으면 변이도 따라가야 합니다`); bad += 1; }
  }
  if (bad) { console.error(`\n자기 점검 실패: ${bad}건`); process.exit(1); }
  console.log(`✅ 긴급 종료 변이 자기 점검 — ${FILTERED.length}건 전부 겨냥 가능`);
  process.exit(0);
}

const GATES = [
  ['check-kill-close-safety', process.execPath, ['scripts/check-kill-close-safety.mjs']],
  ['check-kill-switch-contract', process.execPath, ['scripts/check-kill-switch-contract.mjs']],
  ['npm test', 'npm', ['test']],
];
const runGates = () => {
  for (const [n, cmd, args] of GATES) {
    try { execFileSync(cmd, args, { stdio: 'pipe', timeout: 900_000 }); }
    catch (e) { return n; }
  }
  return null;
};

console.log('기준선 확인 (변이 없이 게이트가 초록인가) … ');
const base = runGates();
if (base) { console.error(`❌ 기준선이 이미 빨갛습니다 (${base}) — 변이 결과를 믿을 수 없습니다`); process.exit(1); }
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
    // 동치 변이 — **초록이 맞다.** 뒤 코드가 같은 결과를 만든다.
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
