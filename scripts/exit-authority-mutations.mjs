#!/usr/bin/env node
// scripts/exit-authority-mutations.mjs
//
// **막았다는 각 구멍을 하나씩 되돌려 보고, 게이트가 빨개지는지 본다.**
//
// 검사기를 새로 쓰면 가장 흔한 실패는 아무것도 안 잡는 검사기다.
// 그래서 PR-S가 막은 것들을 그대로 재현한다 — 특히 main에 실제로 있던
// 조건 없는 upsert와 잠금 밖 거래소 쓰기.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ROUTE = 'src/app/api/autotrade/exit-monitor/route.ts';
const LEASE = 'src/lib/engine/exitMonitorLease.ts';
const ACT   = 'src/lib/engine/lifecycleAction.ts';
const EXEC  = 'src/lib/exchanges/futuresExec.ts';
const OPS   = 'src/lib/engine/venuePositionOps.ts';
const GUARD = 'src/lib/engine/mutationGuard.ts';
const CHECK = 'scripts/check-exit-authority.mjs';

const ONLY = process.argv.slice(2);

/** 검사기 + 시험. 둘 중 하나라도 빨개지면 RED다 */
function gate() {
  const c = spawnSync('node', [CHECK], { encoding: 'utf8' });
  if (c.status !== 0) return { red: true, by: '종료 권한 검사기' };
  const t = spawnSync('node', ['scripts/run-tests.mjs'], { encoding: 'utf8' });
  if (t.status !== 0) return { red: true, by: '시험' };
  return { red: false, by: null };
}

const CASES = [
  // ── A. 임차 경합 (main에 실제로 있던 결함) ──
  ['MUT-S1 임차를 조건 없이 덮어쓴다 (main의 결함 · 둘 다 주인)', LEASE, 'RED',
   [[`      const r = await i.store.compareAndSet(row, prevFence);`,
     `      const r = await i.store.insert(row);`]]],

  ['MUT-S2 갱신된 줄이 0개여도 잡았다고 읽는다', LEASE, 'RED',
   [[`      ok = !r?.error && Number(r?.updated) === 1;`, `      ok = !r?.error;`]]],

  ['MUT-S3 실제 쿼리에서 fence 조건을 뺀다 (판정만 원자적)', ROUTE, 'RED',
   [[`          .eq('id', 1).eq('fence', prevFence).select('fence');`,
     `          .eq('id', 1).select('fence');`]]],

  ['MUT-S4 경합에서 지고도 실행 권한을 갖는다', LEASE, 'RED',
   [[`    return { code: 'RACE_LOST', granted: false, myFence: null, tracked: true,`,
     `    return { code: 'RACE_LOST', granted: true, myFence: 1, tracked: true,`]]],

  ['MUT-S5 임차 상태를 못 읽어도 빈 표로 읽는다', LEASE, 'RED',
   [[`  } catch { /* undefined로 남는다 → 아래 판정이 막는다 */ }`,
     `  } catch { current = null; }`]]],

  // ── B. stale worker가 거래소를 바꾼다 ──
  ['MUT-S6 sweep에 실행 권한을 넘기지 않는다 (잠금 밖 쓰기)', ROUTE, 'RED',
   [[`runLifecycleSweep(sb, dryRun, stillMine, myFence)`,
     `runLifecycleSweep(sb, dryRun, undefined, myFence)`]]],

  ['MUT-S7 청산에 권한 확인을 넘기지 않는다', ROUTE, 'RED',
   [[`        const act = await applyLifecycleClose({
          stillMine,`,
     `        const act = await applyLifecycleClose({
          stillMine: undefined,`]]],

  // ★ 옛 문구를 지우는 무해 변이로 두지 않는다. sweep의 **모든** 거래소
  //   쓰기가 이 헬퍼 하나에 걸려 있으므로, 이것을 무력화하는 것이
  //   실제 방어선을 시험하는 변이다.
  ['MUT-S8 sweep의 권한 확인 헬퍼를 통과로 만든다 (모든 쓰기 무방비)', ROUTE, 'RED',
   [[`    if (!stillMine) return true;
    try { return await stillMine(); } catch { return false; }`,
     `    void stillMine;
    return true;`]]],

  ['MUT-S8b 취소 건너뜀을 완전 성공으로 숨긴다 (부분 성공 은폐)', ROUTE, 'RED',
   [[`            return { cancelled: 0, note: LEASE_LOST_MSG, skipped: true };`,
     `            return { cancelled: 0, note: LEASE_LOST_MSG };`]]],

  ['MUT-S8c 계단식 MOVE_STOP이 옛 손절 잔존을 숨긴다', ROUTE, 'RED',
   [[`        oldStopKept: !cleanupOwned, cleanupSkipped: !cleanupOwned,`,
     `        oldStopKept: false, cleanupSkipped: false,`]]],

  ['MUT-S8d 정본이 건너뜀을 MOVED로 적는다', 'src/lib/engine/stopMove.ts', 'RED',
   [[`    if (c?.skipped === true) {`, `    if (false) {`]]],

  // ── C. 청산 순서 ──
  ['MUT-S9 권한 확인이 전송 뒤로 간다', ACT, 'RED',
   [[`  if (deps.stillMine) {`, `  if (false) {`]]],

  ['MUT-S10 권한 확인 실패를 통과로 읽는다', ACT, 'RED',
   [[`try { mine = await deps.stillMine(); } catch { mine = false; }`,
     `try { mine = await deps.stillMine(); } catch { mine = true; }`]]],

  ['MUT-S11 청산 뒤 포지션을 다시 읽지 않는다', ACT, 'RED',
   [[`  try { after = await deps.readAfter(); }`,
     `  try { after = { ok: true, found: false }; void deps; }`]]],

  // ── D. 접수 != 종료 ──
  ['MUT-S12 재조회 실패를 "닫혔다"로 적는다', ACT, 'RED',
   [[`    return { code: 'CLOSE_UNVERIFIED', ok: false, attempted: true,
      accepted: ambiguous ? null : true, flatVerified: null,`,
     `    return { code: 'CLOSE_UNVERIFIED', ok: true, attempted: true,
      accepted: true, flatVerified: true,`]]],

  ['MUT-S13 부분 종료를 성공으로 적는다', ACT, 'RED',
   [[`    return { code: 'CLOSE_INCOMPLETE', ok: false, attempted: true, accepted: true,`,
     `    return { code: 'CLOSE_INCOMPLETE', ok: true, attempted: true, accepted: true,`]]],

  ['MUT-S14 거부를 성공으로 적는다', ACT, 'RED',
   [[`    return { code: 'CLOSE_REJECTED', ok: false,`,
     `    return { code: 'CLOSE_REJECTED', ok: true,`]]],

  // ── E. 중복 CLOSE ──
  ['MUT-S15 회차 안 중복 방지를 없앤다', ROUTE, 'RED',
   [[`    if (!guard.claim(key)) {`, `    if (false) {`]]],

  ['MUT-S16 빈 키를 통과시킨다 (전부 같은 자리 / 전부 다른 자리)', GUARD, 'RED',
   [[`      if (!k) return false;`, `      if (false) return false;`]]],

  ['MUT-S17 임차가 바뀌어도 옛 표식을 물려준다', GUARD, 'RED',
   [[`export function mutationGuardFor(fence: number | null | undefined): MutationGuard {
  const done = new Set<string>();`,
     `const __shared = new Set<string>();
export function mutationGuardFor(fence: number | null | undefined): MutationGuard {
  const done = __shared;`]]],

  // ── F. 종료 모드 ──
  ['MUT-S18 종료 경로가 포지션 모드를 읽지 않는다', OPS, 'RED',
   [[`    if (!cm.ok) return { attempted: false, ok: false, error: cm.message };`,
     `    if (false) return { attempted: false, ok: false, error: cm.message };`]]],

  ['MUT-S19 모드를 못 읽어도 청산을 보낸다', EXEC, 'RED',
   [[`    return { ok: false, mode: null, code: 'UNKNOWN', strandsOpenPosition: true,`,
     `    return { ok: true, mode: null, code: 'UNKNOWN', strandsOpenPosition: false,`]]],

  ['MUT-S20 양방향 계좌에 단방향 규격을 그대로 보낸다', EXEC, 'RED',
   [[`    return { ok: false, mode: 'HEDGE', code: 'HEDGE_UNVERIFIED', strandsOpenPosition: true,`,
     `    return { ok: true, mode: 'HEDGE', code: 'HEDGE_UNVERIFIED', strandsOpenPosition: false,`]]],

  ['MUT-S21 방향을 모르는 채 청산을 보낸다 (반대 진입)', EXEC, 'RED',
   [[`  if (i.exchange === 'binance' && i.positionSide !== 'LONG' && i.positionSide !== 'SHORT') {`,
     `  if (false) {`]]],

  // ── G. 거짓 문구 ──
  ['MUT-S22 "청산은 언제나 된다"는 옛 문장을 되살린다', EXEC, 'RED',
   [[`           + '(종료 경로는 별도로 판정합니다 — closeModeVerdict를 보세요.)',`,
     `           + '(청산은 이 검사를 받지 않습니다. 열린 포지션은 언제나 닫을 수 있습니다.)',`]]],

  // ── H. PR-S 범위를 벗어나는 변경 ──
  ['MUT-S23 손절 없는 줄을 일반 생명주기에 들여보낸다 (PR1 침범)',
   'src/lib/engine/managedPosition.ts', 'RED',
   [[`    if (stopLoss == null || stopLoss <= 0) {`, `    if (false) {`]]],

  // ── 머지 차단 5건 회귀 (실물 감사에서 잡힌 것들) ──

  ['MUT-S24 계단식 reduceOnly 청산이 종료 모드 관문을 우회한다 (blocker 1)', ROUTE, 'RED',
   [[`            const gate = await opsGate.closeModeGate(`,
     `            const gate = { ok: true, message: '', code: 'ONE_WAY', strandsOpenPosition: false };
            void opsGate; void (async () => await (0 as any)(`]]],

  ['MUT-S25 종료 관문이 모드를 읽지 않는다 (blocker 1)', OPS, 'RED',
   [[`  const pm = await fa.futuresPositionMode(`,
     `  const pm = { mode: 'ONE_WAY' as const, error: null }; void fa; void (async () => await (0 as any)(`]]],

  ['MUT-S26 접수를 종료로 적는다 (blocker 2)', ROUTE, 'RED',
   [[`          ok: act.ok, closed: act.flatVerified === true,`,
     `          ok: act.ok, closed: act.accepted === true,`]]],

  ['MUT-S27 모호한 전송을 거부로 단정한다 (blocker 3)', ACT, 'RED',
   [[`  if (!r.ok && !ambiguous) {`, `  if (!r.ok) {`]]],

  ['MUT-S28 전송 예외를 모호가 아니라 거부로 적는다 (blocker 3)', ACT, 'RED',
   [[`    r = { attempted: true, ok: false, error: String(e?.message || e), ambiguous: true };`,
     `    r = { attempted: true, ok: false, error: String(e?.message || e), ambiguous: false };`]]],

  ['MUT-S29 타임아웃을 모호로 분류하지 않는다 (blocker 3)', OPS, 'RED',
   [[`    return fx.unknownResultVerdict(String(msg)).unknown === true;`, `    return false;`]]],

  ['MUT-S30 손절 걸기 직전 권한 확인을 없앤다 (blocker 4)', ROUTE, 'RED',
   [[`          if (!(await mayMutate())) {
            return { ok: false, orderId: null, message: LEASE_LOST_MSG };
          }`, ``]]],

  ['MUT-S31 손절 취소 직전 권한 확인을 없앤다 (blocker 4)', ROUTE, 'RED',
   [[`          if (!(await mayMutate())) {
            return { cancelled: 0, note: LEASE_LOST_MSG, skipped: true };
          }`, ``]]],

  ['MUT-S32 계단식 청산 전송 직전 권한 확인을 없앤다 (blocker 4)', ROUTE, 'RED',
   [[`            } else if (!(await stillMine())) {`, `            } else if (false) {`]]],

  ['MUT-S33 계단식 손절 걸기 직전 권한 확인을 없앤다 (blocker 4)', ROUTE, 'RED',
   [[`      if (!(await stillMine())) {
        results.push({ symbol: d.symbol, action: 'MOVE_STOP', ok: false, error: LEASE_LOST_MSG });
        continue;
      }`, ``]]],

  ['MUT-S34 계단식 손절 취소가 권한을 묻지 않는다 (blocker 4)', ROUTE, 'RED',
   [[`      const cleanupOwned = await stillMine();`, `      const cleanupOwned = true;`]]],

  ['MUT-S35 고아 보호주문 취소에 권한을 넘기지 않는다 (blocker 4)', ROUTE, 'RED',
   [[`    : await sweepOrphanProtection(sb, stillMine);`, `    : await sweepOrphanProtection(sb);`]]],

  ['MUT-S36 포지션 가드 정리에 권한을 넘기지 않는다 (blocker 4)', ROUTE, 'RED',
   [[`connFor, orphanCleanups, stillMine);`, `connFor, orphanCleanups);`]]],

  ['MUT-S37 선점이 판단 전으로 돌아간다 (blocker 5)', ROUTE, 'RED',
   [[`      if (!guard.claim(key)) {
        out.results.push({ symbol: p.symbol, strategyId: p.strategyId, code: 'DUPLICATE',
          ok: true, reason: '같은 계좌·종목·방향을 이번 회차에 이미 처리했습니다' });
        continue;
      }
      if (v.action === 'CLOSE') {`,
     `      if (v.action === 'CLOSE') {`],
    [`    const key = mutationKeyOf(p);`,
     `    const key = mutationKeyOf(p);
    if (!guard.claim(key)) {
      out.results.push({ symbol: p.symbol, strategyId: p.strategyId, code: 'DUPLICATE',
        ok: true, reason: '같은 계좌·종목·방향을 이번 회차에 이미 처리했습니다' });
      continue;
    }`]]],

  // ── 대조군 ──
  ['OK-S1 임차 파일에 주석 한 줄 추가', LEASE, 'GREEN',
   [[`export async function acquireExitLease(`, `// 대조군\nexport async function acquireExitLease(`]]],
  ['OK-S2 청산 실행 파일에 주석 한 줄 추가', ACT, 'GREEN',
   [[`export async function applyLifecycleClose(`, `// 대조군\nexport async function applyLifecycleClose(`]]],
  ['OK-S3 모드 판정 파일에 주석 한 줄 추가', EXEC, 'GREEN',
   [[`export function closeModeVerdict(`, `// 대조군\nexport function closeModeVerdict(`]]],
  ['OK-S4 중복 방지 파일에 주석 한 줄 추가', GUARD, 'GREEN',
   [[`export function mutationGuardFor(`, `// 대조군\nexport function mutationGuardFor(`]]],
];

const selected = ONLY.length && !ONLY.includes('--audit')
  ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;

// ── --audit: 뮤테이션 잔재 검사 ──
//
// 스윕이 중간에 죽으면(컨테이너 재시작 등) 되돌리기가 실행되지 않고
// 페이로드가 작업 트리에 남는다. 실제로 그렇게 커밋될 뻔했다.
if (process.env.SAFETY_AUDIT === '1' || ONLY.includes('--audit')) {
  let dirty = 0;
  for (const [name, file, , cuts] of CASES) {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const [from, to] of cuts) {
      if (to && !src.includes(from) && src.includes(to)) {
        console.log(`  ✗ 잔재: ${name}\n      ${file}`); dirty += 1;
      }
    }
  }
  console.log(dirty === 0 ? '✅ 뮤테이션 잔재 없음'
    : `❌ 뮤테이션 잔재 ${dirty}건 — 되돌린 뒤 다시 실행하세요`);
  process.exit(dirty === 0 ? 0 : 1);
}

console.log(`게이트: 종료 권한 검사기 + 전체 시험\n총 ${selected.length}건\n`);

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
