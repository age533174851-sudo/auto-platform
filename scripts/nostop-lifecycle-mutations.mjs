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
const SWEEP  = 'src/lib/engine/lifecycleSweep.ts';
const ROUTE  = 'src/app/api/autotrade/exit-monitor/route.ts';
const LEASE  = 'src/lib/engine/exitMonitorLease.ts';
const DECIDE = 'src/lib/engine/exitLifecycle.ts';
const POLICY = 'src/lib/strategies/lifecyclePolicy.ts';
const OPS    = 'src/lib/engine/venuePositionOps.ts';
const ACT    = 'src/lib/engine/lifecycleAction.ts';
const SCALP  = 'src/app/api/autotrade/scalp/route.ts';
const EXEC   = 'src/lib/exchanges/futuresExec.ts';
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
  ['MUT-NS1 sweep이 stop_policy를 조회하지 않는다 (원래 결함)', ROUTE, 'RED',
   [[`          + 'stop_policy, '\n`, ``]]],

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
  // 재조회는 `lifecycleAction`으로 옮겼다(순서를 시험하려고). 그래서 그쪽을 겨냥한다.
  ['MUT-NS8 청산 뒤 포지션을 다시 읽지 않는다', ACT, 'RED',
   [[`  try { after = await deps.readAfter(); }`,
     `  try { after = { ok: true, found: false }; void deps; }`]]],

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

  // ★ 이 둘의 앵커는 `venuePositionOps`의 인라인 검사였다. 판정을
  //   `futuresExec.closeModeVerdict`로 합치면서(진입 판정 옆) 그 줄이
  //   사라졌다. **옮긴 것을 "없어졌다"로 두지 않고 새 자리를 겨냥한다.**
  ['MUT-NS12 모드를 못 읽어도 청산을 보낸다 (추측 전송)', OPS, 'RED',
   [[`    const cm = fx.closeModeVerdict(pm.mode as any, pm.error);`,
     `    const cm = { ok: true, message: '' } as any; void fx; void pm;`]]],

  ['MUT-NS13 양방향 계좌에 단방향 규격을 그대로 보낸다', EXEC, 'RED',
   [[`    return { ok: false, mode: 'HEDGE', code: 'HEDGE_UNVERIFIED', strandsOpenPosition: true,`,
     `    return { ok: true, mode: 'HEDGE', code: 'HEDGE_UNVERIFIED', strandsOpenPosition: false,`]]],

  ['MUT-NS14 방향을 모르는 채 청산을 보낸다 (반대 진입)', OPS, 'RED',
   [[`    if (positionSide !== 'LONG' && positionSide !== 'SHORT') {`, `    if (false) {`]]],

  // ── ⑪ 청산 전 실행 권한 (검수에서 지적된 실재 결함) ──

  ['MUT-NS15 sweep에 실행 권한을 넘기지 않는다 (원래 결함)', ROUTE, 'RED',
   [[`runLifecycleSweep(sb, dryRun, stillMine)`, `runLifecycleSweep(sb, dryRun)`]]],

  ['MUT-NS15b sweep 정본이 받은 권한을 청산에 쓰지 않는다', SWEEP, 'RED',
   [[`          stillMine: deps.stillMine,`, `          stillMine: undefined,`]]],

  ['MUT-NS16 임차 획득이 본 값을 조건으로 걸지 않는다 (둘 다 주인)', LEASE, 'RED',
   [[`      const r = await i.store.compareAndSet(row, prevFence);`,
     `      const r = await i.store.insert(row);`]]],

  ['MUT-NS16b 갱신된 줄이 0개여도 잡았다고 읽는다', LEASE, 'RED',
   [[`      ok = !r?.error && Number(r?.updated) === 1;`, `      ok = !r?.error;`]]],

  ['MUT-NS16c 실제 쿼리에서 fence 조건을 뺀다 (판정만 원자적)', ROUTE, 'RED',
   [[`          .eq('id', 1).eq('fence', prevFence).select('fence');`,
     `          .eq('id', 1).select('fence');`]]],

  ['MUT-NS17 권한 확인이 전송 뒤로 간다', ACT, 'RED',
   [[`  if (deps.stillMine) {`, `  if (false) {`]]],

  ['MUT-NS18 권한 확인 실패를 통과로 읽는다', ACT, 'RED',
   [[`try { mine = await deps.stillMine(); } catch { mine = false; }`,
     `try { mine = await deps.stillMine(); } catch { mine = true; }`]]],

  // ── ⑫ 결과 의미 분리 ──

  ['MUT-NS19 재조회 실패를 "닫혔다"로 적는다', ACT, 'RED',
   [[`    return { code: 'CLOSE_UNVERIFIED', ok: false, attempted: true, accepted: true,
      flatVerified: null,`,
     `    return { code: 'CLOSE_UNVERIFIED', ok: true, attempted: true, accepted: true,
      flatVerified: true,`]]],

  ['MUT-NS20 부분 종료를 성공으로 적는다', ACT, 'RED',
   [[`    return { code: 'CLOSE_INCOMPLETE', ok: false, attempted: true, accepted: true,`,
     `    return { code: 'CLOSE_INCOMPLETE', ok: true, attempted: true, accepted: true,`]]],

  ['MUT-NS21 청산 실패가 실행 상태에 반영되지 않는다 (원래 결함)', ROUTE, 'RED',
   [[`  const failed = [...results.filter(r => r && r.ok === false), ...lifecycleFailed];`,
     `  const failed = results.filter(r => r && r.ok === false);`]]],

  // ── ⑬ 과거 줄 배제 ──

  ['MUT-NS22 과거 줄을 다시 후보에 올린다 (조기 청산 · 원래 결함)', CAND, 'RED',
   [[`    if (!cur || k.pos.openedAt > cur.pos.openedAt) {`, `    if (true) {`]]],

  ['MUT-NS23 중복 키에서 전략을 뺀다 (충돌 감지 소실)', CAND, 'RED',
   [['|${k.pos.strategyId ?? \'\'}`;', '`;']]],

  // ── ⑭ 진입/종료 대칭 ──

  ['MUT-NS24 닫을 수 없는 계좌에 진입을 허용한다 (원래 비대칭)', SCALP, 'RED',
   [[`          if (pm.mode !== 'ONE_WAY') return null;`, ``]]],

  // ── 대조군 ──
  // ── ⑮ 돌려서만 잡히는 것들 (정규식으로는 못 본다) ──
  //
  // 아래 넷은 소스에 줄이 다 있어도 고장난다. **횟수와 순서**의 문제라
  // 회차를 실제로 돌려 세는 시험만 잡을 수 있다.

  ['MUT-NS25 임차를 잃고도 다음 후보로 넘어간다 (같은 회차에 또 보냄)', SWEEP, 'RED',
   [[`            ok: false, reason: act.reason, stopPolicy: p.stopPolicy, policySource });
          break;`,
     `            ok: false, reason: act.reason, stopPolicy: p.stopPolicy, policySource });
          continue;`]]],

  ['MUT-NS26 장부 조회 실패를 "후보 없음"으로 적는다', SWEEP, 'RED',
   [[`    if (r?.error) {`, `    if (false && r?.error) {`]]],

  // ★ 이 하나는 **시험이 못 잡는다.** `managedCandidates`가 같은 전략의
  //   중복 줄을 이미 걸러내고, 전략이 다르면 소유권 충돌로 판단이 멈춘다.
  //   그래서 회차 안 중복 방지는 지금 **도달할 수 없는 2중 방어**다 —
  //   워커가 둘 떠서 후보가 밖에서 겹쳐 들어올 때를 위한 것이다.
  //   도달할 수 없는 것을 "돌려서 확인했다"고 적지 않는다. 검사기가 본다.
  ['MUT-NS27 회차 안 중복 방지를 없앤다 (같은 자리에 두 번)', SWEEP, 'RED',
   [[`    if (done.has(key)) {`, `    if (false) {`]]],

  ['MUT-NS28 점검 모드에서도 거래소를 바꾼다', SWEEP, 'RED',
   [[`      if (dryRun) {`, `      if (false && dryRun) {`]]],

  // ── ⑯ 판단이 두 곳으로 갈린다 (이 저장소의 2번 고장) ──

  ['MUT-NS29 라우트가 종료 판단을 다시 갖는다 (경로 두 개)', ROUTE, 'RED',
   [[`  const lifecycle = await runLifecycleSweep(sb, dryRun, stillMine);`,
     `  const lifecycle = await runLifecycleSweep(sb, dryRun, stillMine);
  if ((globalThis as any).__never) {
    const { lifecycleDecide } = await import('@/lib/engine/exitLifecycle');
    void lifecycleDecide({} as any);
  }`]]],

  ['MUT-NS30 sweep 정본이 거래소 어댑터를 직접 불러온다 (가짜로 못 바꿈)', SWEEP, 'RED',
   [[`import { moveStopSafely } from './stopMove';`,
     `import { moveStopSafely } from './stopMove';
import * as __ops from '@/lib/engine/venuePositionOps';
void __ops;`]]],

  // ── ⑰ 진입/종료 대칭의 정본 ──

  ['MUT-NS31 종료 판정이 모드를 못 읽어도 통과시킨다', EXEC, 'RED',
   [[`  return { ok: false, mode: null, code: 'UNKNOWN', strandsOpenPosition: true,`,
     `  return { ok: true, mode: null, code: 'UNKNOWN', strandsOpenPosition: false,`]]],

  ['MUT-NS32 종료가 막힌 모드에서 진입만 허용한다 (비대칭 복원)', EXEC, 'RED',
   [[`      ok: false, mode: 'HEDGE', code: 'HEDGE_BLOCKED',`,
     `      ok: true, mode: 'HEDGE', code: 'HEDGE_BLOCKED',`]]],

  ['MUT-NS33 진입 차단과 종료 차단을 같은 실패로 적는다', EXEC, 'RED',
   [[`    return { ok: false, mode: 'HEDGE', code: 'HEDGE_UNVERIFIED', strandsOpenPosition: true,`,
     `    return { ok: false, mode: 'HEDGE', code: 'HEDGE_BLOCKED' as any, strandsOpenPosition: false,`]]],

  ['MUT-NS34 종료 경로가 판정 정본을 무시한다', OPS, 'RED',
   [[`    if (!cm.ok) return { attempted: false, ok: false, error: cm.message };`,
     `    if (false) return { attempted: false, ok: false, error: cm.message };`]]],

  ['MUT-NS35 "청산은 언제나 된다"는 옛 문장을 되살린다', EXEC, 'RED',
   [[`           + '(종료 경로는 별도로 판정합니다 — closeModeVerdict를 보세요.)',`,
     `           + '(청산은 이 검사를 받지 않습니다. 열린 포지션은 언제나 닫을 수 있습니다.)',`]]],

  ['OK-NS1 후보 파일에 주석 한 줄 추가', CAND, 'GREEN',
   [[`export interface OrderRowLike {`, `// 대조군\nexport interface OrderRowLike {`]]],
  ['OK-NS2 판단 파일에 주석 한 줄 추가', DECIDE, 'GREEN',
   [[`export type LifecycleAction`, `// 대조군\nexport type LifecycleAction`]]],
  ['OK-NS4 청산 실행 파일에 주석 한 줄 추가', ACT, 'GREEN',
   [[`export type LifecycleActionCode`, `// 대조군\nexport type LifecycleActionCode`]]],
  ['OK-NS3 종료 경로 파일에 주석 한 줄 추가', OPS, 'GREEN',
   [[`export async function closeSymbolPosition(`,
     `// 대조군\nexport async function closeSymbolPosition(`]]],

  ['OK-NS5 sweep 정본에 주석 한 줄 추가', SWEEP, 'GREEN',
   [[`export async function runLifecycleSweepCore(`,
     `// 대조군\nexport async function runLifecycleSweepCore(`]]],

  ['OK-NS6 임차 파일에 주석 한 줄 추가', LEASE, 'GREEN',
   [[`export async function acquireExitLease(`,
     `// 대조군\nexport async function acquireExitLease(`]]],

  ['OK-NS7 모드 판정 파일에 주석 한 줄 추가', EXEC, 'GREEN',
   [[`export function closeModeVerdict(`,
     `// 대조군\nexport function closeModeVerdict(`]]],
];

const selected = ONLY.length ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;

// ── --audit: 뮤테이션 잔재 검사 ──
//
// 이 스윕은 파일을 고쳤다가 되돌린다. 그런데 컨테이너가 중간에 죽으면
// (한 번 `exit 137`로 실제로 죽었다) **되돌리기가 실행되지 않고** 뮤테이션
// 페이로드가 작업 트리에 남는다. 다음 판은 그 문구를 "대상 문구를 찾지
// 못했습니다"로 넘기고, 남은 페이로드는 커밋까지 따라갈 수 있다.
//
// 실제로 한 번 그렇게 됐다: MUT-NS6의 `noFixedSl ? (rawStop ?? 1)`이 트리에
// 남아 시험 2건이 빨갛게 떠 있었고, 나는 "잔재 없음"이라고 잘못 보고했다.
// 그래서 사람 눈이 아니라 이 모드가 본다.
if (process.env.NOSTOP_AUDIT === '1' || ONLY.includes('--audit')) {
  let dirty = 0;
  for (const [name, file, , cuts] of CASES) {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const [from, to] of cuts) {
      // 원문이 사라졌는데 뮤테이션 문구가 있으면 되돌리기가 빠진 것이다.
      if (!src.includes(from) && src.includes(to)) {
        console.log(`  ✗ 잔재: ${name}\n      ${file}`);
        dirty += 1;
      }
    }
  }
  console.log(dirty === 0
    ? '✅ 뮤테이션 잔재 없음'
    : `❌ 뮤테이션 잔재 ${dirty}건 — 되돌린 뒤 다시 실행하세요`);
  process.exit(dirty === 0 ? 0 : 1);
}
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
