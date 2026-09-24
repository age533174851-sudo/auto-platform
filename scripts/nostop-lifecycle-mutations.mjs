#!/usr/bin/env node
// scripts/nostop-lifecycle-mutations.mjs
//
// **이번에 고친 구멍을 하나씩 되돌려 보고, 게이트가 빨개지는지 본다.**
//
// 검사기를 새로 쓰면 가장 흔한 실패는 아무것도 안 잡는 검사기다. 실제로
// 이 검사기도 처음 두 판은 **앵커를 잘못 잡아** 엉뚱한 쿼리를 보고 있었다.
// 그래서 고친 결함을 그대로 재현해 확인한다.
//
// 되돌리는 것은 실제로 있었던 세 가지다:
//   ① sweep이 `stop_policy`를 조회하지 않는다
//   ② 후보 만들기가 손절 없는 줄을 전부 제외한다
//   ③ 판단이 무손절을 시간 청산보다 먼저 본다
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CAND   = 'src/lib/engine/managedPosition.ts';
const SWEEP  = 'src/app/api/autotrade/exit-monitor/route.ts';
const DECIDE = 'src/lib/engine/exitLifecycle.ts';
const POLICY = 'src/lib/strategies/lifecyclePolicy.ts';
const OPS    = 'src/lib/engine/venuePositionOps.ts';
const CHECK  = 'scripts/check-nostop-lifecycle.mjs';

const ONLY = process.argv.slice(2);

/** 검사기 + 시험. 둘 중 하나라도 빨개지면 RED다 */
function gate() {
  const c = spawnSync('node', [CHECK], { encoding: 'utf8' });
  if (c.status !== 0) return { red: true, by: '무손절 감시 검사기' };
  const t = spawnSync('node', ['scripts/run-tests.mjs'], { encoding: 'utf8' });
  if (t.status !== 0) return { red: true, by: '시험' };
  return { red: false, by: null };
}

const CASES = [
  // ── ① 실제로 있었던 결함: 칸을 조회하지 않는다 ──
  ['MUT-NS1 sweep이 stop_policy를 조회하지 않는다 (원래 결함)', SWEEP, 'RED',
   [[`        + 'stop_policy, '\n`, ``]]],

  // ── ② 실제로 있었던 결함: 손절 없는 줄을 전부 제외 ──
  ['MUT-NS2 후보 만들기가 손절 없는 줄을 전부 제외한다 (원래 결함)', CAND, 'RED',
   [[`    if (!noFixedSl && (stopLoss == null || stopLoss <= 0)) {`,
     `    if (stopLoss == null || stopLoss <= 0) {`]]],

  // ── ③ 순서가 뒤집히면 유일한 종료가 사라진다 ──
  ['MUT-NS3 무손절 판정이 시간 청산보다 먼저 온다 (영원히 안 닫힘)', DECIDE, 'RED',
   [[`  if (pol.maxHoldMs != null && Number.isFinite(p.openedAt)) {`,
     `  if (false && pol.maxHoldMs != null && Number.isFinite(p.openedAt)) {`]]],

  // ── ④ 정책을 값으로 추정한다 ──
  ['MUT-NS4 손절가가 비었다는 이유만으로 무손절로 읽는다', CAND, 'RED',
   [[`      pol === 'NO_FIXED_SL' ? 'NO_FIXED_SL' : pol === 'FIXED_SL' ? 'FIXED_SL' : null;`,
     `      rawStop == null ? 'NO_FIXED_SL' : 'FIXED_SL';`]]],

  ['MUT-NS4b 판단이 정책 대신 값만 본다', DECIDE, 'RED',
   [[`  if (p.stopPolicy === 'NO_FIXED_SL') {`, `  if (false) {`]]],

  // ── ⑤ 없는 손절을 숫자로 눕힌다 ──
  ['MUT-NS5 무손절 계약의 손절을 0으로 적는다', CAND, 'RED',
   [[`    const stopLoss = noFixedSl ? null : rawStop;`,
     `    const stopLoss = noFixedSl ? 0 : rawStop;`]]],

  // ── ⑥ 무손절 계약에 손절을 다시 건다 ──
  ['MUT-NS6 무손절 포지션에 R 기반 손절 이동을 허용한다', CAND, 'RED',
   [[`    const stopLoss = noFixedSl ? null : rawStop;`,
     `    const stopLoss = noFixedSl ? (rawStop ?? 1) : rawStop;`]]],

  // ── ⑦ 출처를 숨긴다 ──
  ['MUT-NS7 검증용 시간 값의 출처를 결과에서 뺀다', SWEEP, 'RED',
   [[`      const policySource = policy?.source ?? null;`,
     `      const policySource = null;`]]],

  ['MUT-NS7b 정책 출처 표시 자체를 없앤다', POLICY, 'RED',
   [[`    source: 'LIFECYCLE_TESTNET_V1',`, `    source: 'STRATEGY_DECLARED',`]]],

  // ── ⑧ 청산 뒤 재확인을 없앤다 (기존 규율) ──
  ['MUT-NS8 청산 뒤 포지션을 다시 읽지 않는다', SWEEP, 'RED',
   [[`        const after = await ops.readOpenPosition(venue, p.symbol);`,
     `        const after = { ok: true, found: false } as any;`]]],

  ['MUT-NS9 소유권 확인을 건너뛴다', SWEEP, 'RED',
   [[`      if (live.ok && live.found && hasStop && mayActOn(p)) {`,
     `      if (live.ok && live.found && hasStop) {`]]],

  // ── ⑨ 진입 시각을 created_at으로 되돌린다 (조기 청산) ──
  ['MUT-NS10 진입 시각을 created_at으로 되돌린다 (새 포지션 조기 청산)', CAND, 'RED',
   [[`    const openedAt = r?.acked_at ? Date.parse(String(r.acked_at)) : NaN;`,
     `    const openedAt = Date.parse(String(r?.acked_at || r?.created_at));`]]],

  // ── ⑩ 종료 요청으로 반대 포지션이 생기지 않는다 ──
  //
  //   단방향 전용 파라미터(`reduceOnly` 무조건 · `positionSide` 없음)를
  //   양방향 계좌에 보내면 거부가 아니라 **반대 방향 신규 진입**이 될 수
  //   있다. 그래서 모드를 먼저 읽고, 모르면 안 보낸다.

  ['MUT-NS11 종료 경로가 포지션 모드를 읽지 않는다 (원래 결함)', OPS, 'RED',
   [[`    const pm = await fa.futuresPositionMode(`, `    const pm: any = { mode: 'ONE_WAY', error: null }; void (`]]],

  ['MUT-NS12 모드를 못 읽어도 청산을 보낸다 (추측 전송)', OPS, 'RED',
   [[`    if (pm.mode == null) {`, `    if (false) {`]]],

  ['MUT-NS13 양방향 계좌에 단방향 규격을 그대로 보낸다', OPS, 'RED',
   [[`    if (pm.mode === 'HEDGE') {`, `    if (false) {`]]],

  ['MUT-NS14 방향을 모르는 채 청산을 보낸다 (반대 진입)', OPS, 'RED',
   [[`    if (positionSide !== 'LONG' && positionSide !== 'SHORT') {`, `    if (false) {`]]],

  // ── 대조군 ──
  ['OK-NS1 후보 파일에 주석 한 줄 추가', CAND, 'GREEN',
   [[`export interface OrderRowLike {`, `// 대조군\nexport interface OrderRowLike {`]]],
  ['OK-NS2 판단 파일에 주석 한 줄 추가', DECIDE, 'GREEN',
   [[`export type LifecycleAction`, `// 대조군\nexport type LifecycleAction`]]],
  ['OK-NS3 종료 경로 파일에 주석 한 줄 추가', OPS, 'GREEN',
   [[`export async function closeSymbolPosition(`,
     `// 대조군\nexport async function closeSymbolPosition(`]]],
];

const selected = ONLY.length ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;
console.log(`게이트: 무손절 감시 검사기 + 전체 시험\n총 ${selected.length}건\n`);

let detected = 0, missed = 0, noop = 0, greenOk = 0, greenBad = 0;

for (const [name, file, kind, cuts] of selected) {
  if (!existsSync(file)) { console.log(`  ⚠  ${name} — 파일이 없습니다`); noop += 1; continue; }
  const before = readFileSync(file, 'utf8');
  let after = before, missing = false;
  for (const [from, to] of cuts) {
    if (!after.includes(from)) { missing = true; break; }
    // ★ 함수로 넘긴다. 문자열 치환은 `$'`를 "매치 뒤 전체"로 해석한다.
    after = after.replace(from, () => to);
  }
  if (missing || after === before) {
    console.log(`  ⚠  ${name} — 대상 문구를 찾지 못했습니다`);
    noop += 1; continue;
  }

  writeFileSync(file, after);
  let res;
  try { res = gate(); } finally { writeFileSync(file, before); }

  if (kind === 'RED') {
    if (res.red) { console.log(`  ●  ${name} — RED (검출: ${res.by})`); detected += 1; }
    else { console.log(`  ✗  ${name} — GREEN (새 나감)`); missed += 1; }
  } else {
    if (!res.red) { console.log(`  ✓  ${name} — PASS (과도 검출 없음)`); greenOk += 1; }
    else { console.log(`  ✗  ${name} — RED (과도 검출: ${res.by})`); greenBad += 1; }
  }
}

console.log(`\n검출 ${detected} / 누락 ${missed} / 판정불가 ${noop}`
  + ` / 대조군 PASS ${greenOk} · 과도검출 ${greenBad}`);
process.exit(missed > 0 || greenBad > 0 || noop > 0 ? 1 : 0);
