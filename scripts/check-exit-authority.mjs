#!/usr/bin/env node
// scripts/check-exit-authority.mjs
//
// **거래소를 바꾸기 전에 권한을 물었는가 — 그리고 그 판정이 한 곳에 있는가.**
//
// 이 검사가 지키는 다섯 가지
// ──────────────────────────
//   ① 임차 획득이 **본 값을 조건으로** 쓴다 (조건 없는 upsert 금지)
//   ② 생명주기 sweep이 실행 권한을 **주입받고 쓴다**
//   ③ 청산 순서가 권한 → 전송 → 재조회다
//   ④ 접수를 체결로, 재조회 실패를 0으로 적지 않는다
//   ⑤ 종료 모드 판정이 진입 판정 **옆에** 있고 fail-closed다
//
// 왜 시험만으로는 부족한가
// ────────────────────────
// 시험은 순수 함수를 돌려 순서·횟수를 센다. 그런데 **라우트가 그 함수를
// 부르지 않으면** 시험은 계속 초록이고 운영만 무방비다. 이 저장소에서
// 반복된 고장이 정확히 그것이다 — 만들어 놓고 배선을 안 함.
// 그래서 배선은 파일에서 본다.
import { readFileSync, existsSync } from 'node:fs';

const ROUTE = 'src/app/api/autotrade/exit-monitor/route.ts';
const LEASE = 'src/lib/engine/exitMonitorLease.ts';
const ACT   = 'src/lib/engine/lifecycleAction.ts';
const EXEC  = 'src/lib/exchanges/futuresExec.ts';
const OPS   = 'src/lib/engine/venuePositionOps.ts';
const CAND  = 'src/lib/engine/managedPosition.ts';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  if (!existsSync(p)) { err(`${p}가 없습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
  return readFileSync(p, 'utf8');
};
/** 주석은 규율이 아니다 */
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const route = code(read(ROUTE));
const lease = code(read(LEASE));
const act   = code(read(ACT));
const exec  = code(read(EXEC));
const ops   = code(read(OPS));
const cand  = code(read(CAND));

// ══════════ ① 임차 획득이 원자적이다 ══════════
{
  if (!/export async function acquireExitLease/.test(lease)) {
    err(`${LEASE}에 임차 획득 정본이 없습니다 — 경합을 시험으로 재현할 수 없습니다`);
  }
  if (!/compareAndSet\(row, prevFence\)/.test(lease)) {
    err(`${LEASE}의 임차 획득이 본 값을 조건으로 걸지 않습니다`
      + ' — 동시 요청이 같은 fence를 얻어 둘 다 주인이 될 수 있습니다');
  }
  if (!/Number\(r\?\.updated\) === 1/.test(lease)) {
    err(`${LEASE}가 갱신된 줄 수를 확인하지 않습니다 — 0줄 갱신이 성공으로 읽힙니다`);
  }
  if (!/code: 'RACE_LOST', granted: false/.test(lease)) {
    err(`${LEASE}가 경합에서 졌을 때 실행 권한을 내려놓지 않습니다`);
  }
  // 라우트가 그 정본을 쓰고, 실제 쿼리에도 조건이 걸려 있는가
  if (!/acquireExitLease\(/.test(route)) {
    err(`${ROUTE}가 임차 획득 정본을 쓰지 않습니다`);
  }
  if (!/\.eq\('fence', prevFence\)/.test(route)) {
    err(`${ROUTE}의 조건부 갱신에 본 fence 조건이 없습니다`
      + ' — 판정은 원자적인데 실제 쿼리가 조건 없이 덮어씁니다');
  }
  // 조건 없는 덮어쓰기로 되돌아가지 않았는가
  if (/from\('exit_monitor_lease'\)[\s\S]{0,120}?\.upsert\(/.test(route)) {
    err(`${ROUTE}가 임차를 조건 없이 upsert합니다 — 두 실행이 둘 다 주인이 됩니다`);
  }
  if (!/lease\.granted/.test(route)) {
    err(`${ROUTE}가 임차 획득 결과를 보지 않습니다`);
  }
}

// ══════════ ② sweep이 권한을 받고 쓴다 ══════════
{
  // 인자가 더 붙어도(fence 등) 권한이 넘어가는지만 본다.
  if (!/runLifecycleSweep\(sb, dryRun, stillMine[,)]/.test(route)) {
    err(`${ROUTE}가 생명주기 sweep에 실행 권한을 넘기지 않습니다`
      + ' — 그 경로의 거래소 쓰기가 잠금 밖에 남습니다');
  }
  const fn = route.indexOf('async function runLifecycleSweep');
  if (fn < 0) err(`${ROUTE}에서 runLifecycleSweep을 찾지 못했습니다`);
  else {
    const body = route.slice(fn);
    if (!/stillMine\?: \(\) => Promise<boolean>/.test(body)) {
      err(`${ROUTE}의 sweep이 실행 권한 인자를 받지 않습니다`);
    }
    // ★ **거래소 쓰기마다** 권한 확인이 앞서는가.
    //
    //   CLOSE는 `applyLifecycleClose`가 순서를 갖고, MOVE_STOP은 전송 전에
    //   직접 묻는다. 둘 중 하나라도 빠지면 stale worker가 쓸 수 있다.
    //
    //   ★ 첫 판은 본문에서 `stillMine,`이라는 **낱말만** 찾았다. 그런데
    //     `body`는 함수 끝에서 자르지 않은 slice라, 뒤쪽 호출부
    //     `runLifecycleSweep(sb, dryRun, stillMine, myFence)`가 그 조건을
    //     대신 만족시켰다. 그래서 청산에 `stillMine: undefined`를 넣는
    //     변경이 그대로 통과했다(MUT-S7). 이름이 아니라 **모양**을 본다.
    if (!/applyLifecycleClose\(\{\s*\n\s*stillMine,/.test(body)) {
      err(`${ROUTE}의 청산이 권한 확인을 넘기지 않습니다`
        + ' — applyLifecycleClose가 stillMine을 받아야 stale worker를 막습니다');
    }
    if (/applyLifecycleClose\([\s\S]{0,120}?stillMine:\s*undefined/.test(body)) {
      err(`${ROUTE}의 청산이 권한 확인을 비활성화했습니다`);
    }
    // 손절 이동은 **콜백 안에서** 전송 직전에 묻는다. 바깥에서 한 번
    // 물어 두는 것으로는 부족하다 — 그 사이 임차가 넘어갈 수 있다.
    const iMove = body.indexOf('moveStopSafely({');
    const iGuard = body.indexOf('if (!(await mayMutate())) {');
    if (iMove < 0) err(`${ROUTE}에서 손절 이동을 찾지 못했습니다`);
    else if (iGuard < 0 || iGuard > iMove) {
      err(`${ROUTE}가 손절을 옮긴 뒤에 권한을 확인합니다 — 확인이 먼저입니다`);
    }
    if (!/place: async \(stopPrice\) => \{\s*\n(?:[^\n]*\n){0,4}?\s*if \(!\(await mayMutate\(\)\)\)/.test(body)) {
      err(`${ROUTE}의 손절 걸기 콜백이 전송 직전에 권한을 묻지 않습니다`);
    }
  }
}

// ══════════ ②-b 회차 안 중복과 실행 사이 중복을 구분한다 ══════════
//
// 한 장치로 둘 다 막으려 하면 둘 다 못 막는다.
{
  const GUARD = 'src/lib/engine/mutationGuard.ts';
  if (!existsSync(GUARD)) err(`${GUARD}가 없습니다 — 회차 안 중복 방지가 시험되지 않습니다`);
  else {
    const g = code(readFileSync(GUARD, 'utf8'));
    if (!/export function mutationGuardFor/.test(g)) err(`${GUARD}에 중복 방지 정본이 없습니다`);
    // 빈 키를 통과시키면 전부 같은 자리이거나 전부 다른 자리가 된다
    if (!/if \(!k\) return false;/.test(g)) {
      err(`${GUARD}가 빈 키를 통과시킵니다`);
    }
  }
  if (!/mutationGuardFor\(/.test(route)) {
    err(`${ROUTE}가 회차 안 중복 방지 정본을 쓰지 않습니다`);
  }
  if (!/guard\.claim\(key\)/.test(route)) {
    err(`${ROUTE}가 자리를 선점하지 않고 처리합니다 — 같은 자리에 두 번 나갑니다`);
  }
  if (/const done = new Set<string>\(\);/.test(route)) {
    err(`${ROUTE}가 검사되지 않는 메모리 표식으로 되돌아갔습니다`);
  }
}

// ══════════ ③ 청산 순서: 권한 → 전송 → 재조회 ══════════
{
  if (!/applyLifecycleClose\(/.test(route)) {
    err(`${ROUTE}가 청산 실행 정본을 쓰지 않습니다 — 순서가 시험되지 않는 자리로 돌아갑니다`);
  }
  const iMine = act.indexOf('deps.stillMine()');
  const iClose = act.indexOf('deps.close()');
  const iRead = act.indexOf('deps.readAfter()');
  if (iMine < 0 || iClose < 0 || iRead < 0) {
    err(`${ACT}에서 권한·전송·재조회를 모두 찾지 못했습니다`);
  } else {
    if (iMine > iClose) err(`${ACT}가 청산을 보낸 뒤에 권한을 확인합니다 — 확인이 먼저입니다`);
    if (iClose > iRead) err(`${ACT}가 재조회 뒤에 청산을 보냅니다 — 순서가 뒤집혔습니다`);
  }
  // 권한 확인이 던지면 보내지 않는가 (fail-closed)
  if (!/catch \{ mine = false; \}/.test(act)) {
    err(`${ACT}가 권한 확인 실패를 통과로 읽습니다`);
  }
}

// ══════════ ④ 접수 != 종료 ══════════
{
  for (const f of ['attempted', 'accepted', 'flatVerified']) {
    if (!new RegExp(`${f}:`).test(act)) err(`${ACT}에 ${f}가 없습니다 — 셋을 섞으면 접수가 종료로 읽힙니다`);
  }
  if (!/CLOSE_UNVERIFIED[\s\S]{0,220}?flatVerified: null/.test(act)) {
    err(`${ACT}가 재조회 실패를 null로 적지 않습니다 — 0이라는 뜻이 아닙니다`);
  }
  if (!/CLOSE_INCOMPLETE[\s\S]{0,180}?ok: false/.test(act)) {
    err(`${ACT}가 포지션이 남은 경우를 성공으로 적습니다 — 부분 종료도 체결로 잡힙니다`);
  }
  if (!/CLOSE_REJECTED[\s\S]{0,180}?ok: false/.test(act)) {
    err(`${ACT}가 거부된 청산을 성공으로 적습니다`);
  }
  if (!/CLOSED_VERIFIED[\s\S]{0,180}?flatVerified: true/.test(act)) {
    err(`${ACT}가 재조회 확인 없이 CLOSED를 적습니다`);
  }
}

// ══════════ ⑤ 종료 모드가 진입 판정 옆에 있고 fail-closed다 ══════════
{
  for (const f of ['positionModeVerdict', 'closeModeVerdict']) {
    if (!new RegExp(`export function ${f}\\(`).test(exec)) {
      err(`${EXEC}에 ${f}가 없습니다 — 진입·종료 판정이 한 곳에 없습니다`);
    }
  }
  const i = exec.indexOf('export function closeModeVerdict');
  if (i >= 0) {
    const body = exec.slice(i, i + 3200);
    if (!/code: 'UNKNOWN', strandsOpenPosition: true/.test(body)) {
      err(`${EXEC}의 종료 판정이 모드를 못 읽어도 통과시킵니다`);
    }
    if (!/mode === 'HEDGE'/.test(body) || !/HEDGE_UNVERIFIED/.test(body)) {
      err(`${EXEC}의 종료 판정이 양방향(헤지) 계좌를 구분하지 않습니다`);
    }
    if (!/code: 'NO_DIRECTION'/.test(body)) {
      err(`${EXEC}가 방향을 모르는 청산을 막지 않습니다 — 짐작하면 반대 진입이 됩니다`);
    }
    if (!/strandsOpenPosition/.test(body)) {
      err(`${EXEC}가 "이미 열린 포지션이 갇힌다"를 구분해 적지 않습니다`);
    }
  }
  // 종료 경로가 그 판정을 실제로 쓰는가
  // ★ 모드 읽기 + 판정은 `closeModeGate`로 옮겼다 — 계단식 경로도 같은
  //   관문을 써야 하기 때문이다. 옮긴 것을 "없어졌다"로 두지 않는다.
  const gfn = ops.indexOf('export async function closeModeGate');
  if (gfn < 0) err(`${OPS}에 종료 모드 관문이 없습니다`);
  else {
    const gbody = ops.slice(gfn, gfn + 1600);
    if (!/futuresPositionMode\s*\(/.test(gbody)) {
      err(`${OPS}의 종료 관문이 계좌 포지션 모드를 읽지 않습니다`);
    }
    if (!/closeModeVerdict\(/.test(gbody)) {
      err(`${OPS}의 종료 관문이 판정 정본을 쓰지 않습니다 — 판정이 두 곳이면 갈립니다`);
    }
  }
  const fn = ops.indexOf('export async function closeSymbolPosition');
  if (fn < 0) err(`${OPS}에서 closeSymbolPosition을 찾지 못했습니다`);
  else {
    const body = ops.slice(fn, fn + 3200);
    if (!/closeModeGate\(/.test(body)) {
      err(`${OPS}의 종료 경로가 관문을 지나지 않습니다`);
    }
    if (!/if \(!cm\.ok\) return \{ attempted: false/.test(body)) {
      err(`${OPS}가 판정에 걸려도 청산을 보냅니다`);
    }
    // 관문이 **전송보다 앞**인가
    const iGate = body.indexOf('closeModeGate(');
    const iSend = Math.min(
      ...['closePositionGateFutures', 'closePositionPercent']
        .map(n => { const k = body.indexOf(n); return k < 0 ? Number.MAX_SAFE_INTEGER : k; }));
    if (iGate >= 0 && iSend !== Number.MAX_SAFE_INTEGER && iGate > iSend) {
      err(`${OPS}가 청산을 보낸 뒤에 관문을 지납니다 — 확인이 먼저입니다`);
    }
  }
}

// ══════════ ⑤-b 머지 차단 5건 — 회귀 방지 ══════════
//
// 실물 감사에서 잡힌 다섯 가지다. 각각 되돌리면 RED다.
{
  // ① reduceOnly CLOSE가 종료 모드 관문을 우회하지 못한다
  //
  //    reduceOnly라고 안전한 것이 아니다. 단방향 전용 조합을 양방향
  //    계좌에 보내면 거부가 아니라 반대 포지션이 된다. 계단식 경로가
  //    관문을 건너뛰고 직접 주문을 내고 있었다.
  if (!/export async function closeModeGate/.test(ops)) {
    err(`${OPS}에 종료 모드 관문 정본이 없습니다`);
  }
  const iRo = route.indexOf('reduceOnly: true');
  if (iRo >= 0) {
    const around = route.slice(Math.max(0, iRo - 2000), iRo);
    if (!/closeModeGate\(/.test(around)) {
      err(`${ROUTE}의 reduceOnly 청산이 종료 모드 관문을 지나지 않습니다`
        + ' — 양방향 계좌에서 반대 포지션이 열릴 수 있습니다');
    }
  }

  // ② closed는 접수가 아니라 **확인**이다
  if (/closed:\s*act\.accepted/.test(route)) {
    err(`${ROUTE}가 접수를 종료로 적습니다 — 부분 종료·미체결이 CLOSED로 남습니다`);
  }
  if (!/closed:\s*act\.flatVerified === true/.test(route)) {
    err(`${ROUTE}의 closed가 잔여 0 확인에서 나오지 않습니다`);
  }

  // ③ 모호한 전송을 거부로 단정하지 않는다
  if (!/CLOSE_AMBIGUOUS/.test(act)) {
    err(`${ACT}에 모호한 전송 판정이 없습니다`
      + ' — 타임아웃을 거부로 적으면 안 나간 것으로 읽혀 또 보냅니다');
  }
  if (!/const ambiguous = r\.ambiguous === true;/.test(act)) {
    err(`${ACT}가 전송 모호성을 읽지 않습니다`);
  }
  if (!/if \(!r\.ok && !ambiguous\) \{/.test(act)) {
    err(`${ACT}가 모호한 실패까지 거부로 단정합니다`);
  }
  if (!/needsReconcile/.test(act)) {
    err(`${ACT}가 대조 필요 여부를 적지 않습니다`);
  }
  // 모호할 때도 반드시 다시 읽는가 (재조회가 거부 분기 뒤에 있어야 한다)
  const iRej = act.indexOf("code: 'CLOSE_REJECTED'");
  const iRead = act.indexOf('deps.readAfter()');
  if (iRej >= 0 && iRead >= 0 && iRej > iRead) {
    err(`${ACT}가 재조회보다 뒤에서 거부를 판정합니다 — 순서가 뒤집혔습니다`);
  }
  if (!/unknownResultVerdict/.test(ops)) {
    err(`${OPS}가 모호한 오류를 기존 분류기로 가리지 않습니다 — 규칙이 두 벌이 됩니다`);
  }

  // ④ 모든 거래소 변경 직전에 권한을 묻는다
  for (const [re, what] of [
    // ★ 이름만 보면 본문을 `return true;`로 바꿔도 통과한다(MUT-S8이
    //   그렇게 새 나갔다). 칸이 있는 것과 묻는 것은 다르다 — **본문을 본다.**
    [/const mayMutate = async \(\): Promise<boolean> => \{\s*\n\s*if \(!stillMine\) return true;\s*\n\s*try \{ return await stillMine\(\); \} catch \{ return false; \}/,
      'sweep의 공용 권한 확인(본문)'],
    [/if \(!\(await mayMutate\(\)\)\) \{\s*\n\s*return \{ ok: false, orderId: null/, '손절 걸기 직전'],
    [/if \(!\(await mayMutate\(\)\)\) \{\s*\n\s*return \{ cancelled: 0/, '손절 취소 직전'],
    [/results\.push\(\{ symbol: d\.symbol, action: 'MOVE_STOP', ok: false, error: LEASE_LOST_MSG \}\)/, '계단식 손절 걸기 직전'],
    [/const cleanupOwned = await stillMine\(\);\s*\n\s*const \{ cancelled[\s\S]{0,80}?cleanupOwned\s*\n?\s*\? await opsMv\.cancelOtherStops/, '계단식 손절 취소 직전'],
    // ★ 메시지만 보면 조건을 `false`로 바꿔도 통과한다(MUT-S32가 그렇게
    //   새 나갔다). **조건을 본다.**
    [/\} else if \(!\(await stillMine\(\)\)\) \{\s*\n(?:[^\n]*\n){0,4}?\s*order = \{ attempted: false, ok: false, error: LEASE_LOST_MSG \}/, '계단식 청산 전송 직전'],
    [/code: 'LEASE_LOST', ok: false,\s*\n\s*reason: LEASE_LOST_MSG/, '고아 보호주문 취소 직전'],
  ]) {
    if (!re.test(route)) err(`${ROUTE}에 ${what} 권한 확인이 없습니다`);
  }
  if (!/sweepOrphanProtection\(sb, stillMine\)/.test(route)) {
    err(`${ROUTE}가 고아 정리에 권한을 넘기지 않습니다`);
  }
  if (!/runPositionGuards\(sb, decisions, testnet, connFor, orphanCleanups, stillMine\)/.test(route)) {
    err(`${ROUTE}가 포지션 가드 정리에 권한을 넘기지 않습니다`);
  }

  // ⑤ 선점은 판단 전이 아니라 **거래소를 바꾸기 직전**에
  //
  //    판단 전에 선점하면 읽기만 한 줄이 자리를 먹어서, 같은 자리를
  //    가리키는 실제 조치 대상이 DUPLICATE로 밀린다.
  const iClaim = route.indexOf('guard.claim(key)');
  const iDecide = route.indexOf('const v = lifecycleDecide(');
  if (iClaim < 0 || iDecide < 0) err(`${ROUTE}에서 선점 또는 판단을 찾지 못했습니다`);
  else if (iClaim < iDecide) {
    err(`${ROUTE}가 판단 전에 자리를 선점합니다`
      + ' — 읽기만 한 줄이 실제 조치 대상을 DUPLICATE로 밀어냅니다');
  }
}

// ══════════ ⑤-c 부분 성공을 완전 성공으로 숨기지 않는다 ══════════
//
// 임차를 잃어 옛 손절 취소를 건너뛰면, 새 손절은 걸려 있고 옛 것도 남는다.
// 실패는 아니지만 **MOVED(완전 성공)도 아니다.** 그 사실이 결과에 없으면
// 다음 주인이 다음 회차에 정리할 근거가 사라진다.
{
  const MV = 'src/lib/engine/stopMove.ts';
  if (!existsSync(MV)) err(`${MV}가 없습니다`);
  else {
    const mv = code(readFileSync(MV, 'utf8'));
    if (!/skipped\?: boolean/.test(mv)) {
      err(`${MV}의 취소 결과가 "건너뜀"을 0건 취소와 구분하지 않습니다`);
    }
    if (!/if \(c\?\.skipped === true\) \{/.test(mv)) {
      err(`${MV}가 건너뛴 정리를 MOVED로 적습니다 — 옛 손절이 남은 사실이 사라집니다`);
    }
    if (!/skipped === true\) \{[\s\S]{0,260}?oldStopKept: true/.test(mv)) {
      err(`${MV}가 건너뛴 경우에 oldStopKept를 남기지 않습니다`);
    }
  }
  // sweep 콜백이 건너뜀을 알리는가
  if (!/return \{ cancelled: 0, note: LEASE_LOST_MSG, skipped: true \};/.test(route)) {
    err(`${ROUTE}의 손절 취소 건너뜀이 skipped로 표시되지 않습니다`
      + ' — 정본이 "0건 취소하고 옮겼다"로 읽어 완전 성공으로 숨깁니다');
  }
  // 계단식 경로도 사실을 남기는가
  if (!/oldStopKept: !cleanupOwned, cleanupSkipped: !cleanupOwned,/.test(route)) {
    err(`${ROUTE}의 계단식 손절 이동이 옛 손절 잔존을 숨깁니다`);
  }
  if (!/code: cleanupOwned \? 'MOVED' : 'OLD_STOP_REMAINS',/.test(route)) {
    err(`${ROUTE}의 계단식 손절 이동이 건너뜀을 MOVED로 적습니다`);
  }
}

// ══════════ ⑥ 사실이 아닌 안전 문구가 없다 ══════════
{
  const LIES = [
    [/열린 포지션은 언제나 닫을 수 있습니다/, '"열린 포지션은 언제나 닫을 수 있다"'],
    [/청산은 이 검사를 받지 않습니다/, '"청산은 이 검사를 받지 않는다"'],
  ];
  for (const [rel, src] of [[EXEC, exec], [OPS, ops], [ROUTE, route]]) {
    for (const [re, what] of LIES) {
      if (re.test(src)) err(`${rel}에 사실과 다른 문구가 있습니다 — ${what}`);
    }
  }
}

// ══════════ ⑦ recognized != managed 계약을 깨지 않는다 ══════════
//
// PR-S는 안전성 작업이다. 손절 없는 줄(무손절 100X)을 일반 생명주기에
// **들여보내는 변경은 이 PR의 것이 아니다.** 실수로 섞이면 여기서 막는다.
{
  if (!/if \(stopLoss == null \|\| stopLoss <= 0\) \{/.test(cand)) {
    err(`${CAND}가 손절 없는 줄을 후보에서 제외하지 않습니다`
      + ' — recognized != managed 계약이 깨졌습니다 (PR-S 범위 밖)');
  }
  if (/stop_policy/.test(cand)) {
    err(`${CAND}가 stop_policy를 읽습니다 — NO_FIXED_SL 배선은 PR-S 범위 밖입니다`);
  }
  if (/lifecyclePolicyOf/.test(cand)) {
    err(`${CAND}가 수명주기 정책을 부릅니다 — PR-S 범위 밖입니다`);
  }
}

if (bad > 0) {
  console.error(`\n종료 권한 배선 검사 실패 (${bad}건)`);
  console.error('\n   거래소 쓰기는 되돌릴 수 없습니다. 권한 확인이 먼저입니다.');
  process.exit(1);
}
console.log('✅ 종료 권한 배선 — 임차 CAS · sweep 권한 주입 · 권한→전송→재조회 ·'
  + ' 접수≠종료 · 종료 모드 fail-closed · 거짓 문구 없음 · recognized≠managed 유지');
