#!/usr/bin/env node
// scripts/check-nostop-lifecycle.mjs
//
// **고정 손절을 쓰지 않는 포지션이 감시 대상에서 빠지지 않는가.**
//
// 무엇이 고장나 있었나
// ────────────────────
// 세 곳이 각각 맞는 말을 하고 있었는데, 이어 보면 구멍이 있었다:
//
//   ① `managedCandidates`  손절가가 없는 줄을 `NO_STOP`으로 제외
//   ② `runLifecycleSweep`  `stop_policy` 칸을 아예 조회하지 않음
//   ③ `lifecycleDecide`    무손절이면 시간 청산만 — **닿기만 하면** 맞다
//
// ①은 "1R을 계산할 수 없다"는 옳은 이유였다. ②는 그냥 빠져 있었다. 둘이
// 겹치자 **고정 손절을 쓰지 않기로 한 포지션이 후보 목록에 들어오지 못했고**,
// ③의 시간 청산까지 닿지 못했다. 열려 있는데 아무도 안 보는 포지션이 된다.
//
// 이 검사가 막는 것은 그 조합이다. 셋 중 하나만 되돌려도 같은 구멍이
// 다시 생기고, 시험은 각자 초록일 수 있다.
//
// ★ 정책을 **읽는 것**과 **추정하는 것**을 구별한다
// ─────────────────────────────────────────────────
// 손절가가 비어 있다는 사실은 무손절 계약의 근거가 아니다 — 손절을 걸다
// 실패한 주문도 똑같이 비어 있다. 그 둘은 다루는 법이 정반대라서,
// **`stop_policy`에 적혀 있을 때만** 무손절로 읽어야 한다.
import { readFileSync, existsSync } from 'node:fs';

const CAND  = 'src/lib/engine/managedPosition.ts';
const OPS   = 'src/lib/engine/venuePositionOps.ts';
const ACT   = 'src/lib/engine/lifecycleAction.ts';
const SCALP = 'src/app/api/autotrade/scalp/route.ts';
/** 진입·종료의 포지션 모드 판정 정본이 나란히 있는 곳 */
const EXEC  = 'src/lib/exchanges/futuresExec.ts';
const SWEEP = 'src/lib/engine/lifecycleSweep.ts';
/** 라우트는 실제 구현을 끼우는 배선이다. 판단은 SWEEP에 있다 */
const ROUTE = 'src/app/api/autotrade/exit-monitor/route.ts';
const LEASE = 'src/lib/engine/exitMonitorLease.ts';
const DECIDE = 'src/lib/engine/exitLifecycle.ts';
const POLICY = 'src/lib/strategies/lifecyclePolicy.ts';
const MIG = 'supabase/migrations/078_live_orders_stop_policy.sql';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  if (!existsSync(p)) { err(`${p}가 없습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
  return readFileSync(p, 'utf8');
};
/** 주석은 규율이 아니다 */
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const cand = code(read(CAND));
const ops  = code(read(OPS));
const act  = code(read(ACT));
const scalp = code(read(SCALP));
const exec  = code(read(EXEC));
const sweep = code(read(SWEEP));
const route = code(read(ROUTE));
const lease = code(read(LEASE));
const decide = code(read(DECIDE));
const policy = code(read(POLICY));

// ══════════ ① 장부에서 정책을 읽어 온다 ══════════
{
  if (!/stop_policy/.test(route)) {
    err(`${ROUTE}가 stop_policy를 조회하지 않습니다 — 정책을 모르면 무손절 포지션이 후보에서 빠집니다`);
  }
  // **수명주기 sweep의 select 안에** 있어야 한다.
  //
  // ★ 앵커를 두 번 틀렸다. 처음에는 파일의 첫 `.select(`를 잡았는데 그건
  //   자격증명 쿼리였고, 다음에는 첫 `from('live_orders')`를 잡았는데 그건
  //   고아 보호주문 sweep이었다. 같은 표를 읽는 쿼리가 여럿이라, **함수
  //   이름**으로 앵커해야 이 sweep의 select를 본다.
  const fn = route.indexOf('runLifecycleSweep');
  if (fn < 0) err(`${ROUTE}에서 runLifecycleSweep을 찾지 못했습니다`);
  else {
    const body = route.slice(fn);
    const m = body.match(/from\('live_orders'\)[\s\S]{0,900}?\.order\(/);
    if (!m) err(`${ROUTE}의 runLifecycleSweep에서 주문 장부 select를 찾지 못했습니다`);
    else if (!/stop_policy/.test(m[0])) {
      err(`${ROUTE}의 수명주기 select에 stop_policy가 없습니다`
        + ' — 칸을 안 읽으면 값은 언제나 undefined이고, 무손절 포지션이 후보에서 빠집니다');
    }
  }
  if (!existsSync(MIG)) err(`${MIG}가 없습니다 — 정책 칸의 근거가 사라졌습니다`);
}

// ══════════ ② 후보 만들기가 무손절을 제외하지 않는다 ══════════
{
  if (!/stop_policy/.test(cand)) {
    err(`${CAND}가 정책 칸을 읽지 않습니다`);
  }
  // 적혀 있을 때만 무손절로 읽는가
  if (!/'NO_FIXED_SL'/.test(cand)) {
    err(`${CAND}에 무손절 판정이 없습니다`);
  }
  // ★ 제외 조건이 **정책을 보고** 갈라지는가.
  //   `if (stopLoss == null …) continue` 하나만 남으면 구멍이 되돌아온다.
  // 중첩 괄호를 허용한다 — 실제 조건은 `if (!noFixedSl && (stopLoss == null || …))`다.
  const skip = cand.match(/if \([\s\S]{0,160}?stopLoss == null[\s\S]{0,120}?\{[\s\S]{0,300}?continue;/);
  if (!skip) {
    err(`${CAND}에서 손절 없음 제외 분기를 찾지 못했습니다 — 구조가 바뀌었으면 이 검사도 같이 봐야 합니다`);
  } else if (!/noFixedSl|NO_FIXED_SL|stopPolicy/.test(skip[0])) {
    err(`${CAND}가 정책을 보지 않고 손절 없는 줄을 전부 제외합니다`
      + ' — 무손절 계약 포지션이 감시되지 않습니다');
  }
  // 값이 없을 때 0으로 눕히지 않는가
  if (/stopLoss:\s*(Number\()?[^,\n]*\|\|\s*0/.test(cand)) {
    err(`${CAND}가 없는 손절을 0으로 적습니다 — 0은 "손절이 0원"으로 읽힙니다`);
  }
  // 후보에 정책이 실려 나가는가
  if (!/stopPolicy/.test(cand)) err(`${CAND}가 정책을 후보에 싣지 않습니다`);
}

// ══════════ ③ 판단이 정책을 값보다 먼저 본다 ══════════
{
  if (!/stopPolicy === 'NO_FIXED_SL'/.test(decide)) {
    err(`${DECIDE}가 정책으로 무손절을 판정하지 않습니다 — 값이 비었다는 사실만으로 추정하면`
      + ' 손절을 걸다 실패한 포지션까지 무손절 계약으로 다룹니다');
  }
  // ★ **시간 청산이 무손절 판정보다 앞에 있어야 한다.**
  //   뒤로 가면 무손절 포지션의 유일한 자동 종료가 사라진다.
  const iTime = decide.indexOf("'TIME_EXIT'");
  const iNoStop = decide.indexOf("'NO_FIXED_STOP'");
  if (iTime < 0 || iNoStop < 0) {
    err(`${DECIDE}에서 시간 청산 또는 무손절 판정을 찾지 못했습니다`);
  } else if (iTime > iNoStop) {
    err(`${DECIDE}가 무손절 판정을 시간 청산보다 먼저 합니다`
      + ' — 무손절 포지션이 영원히 닫히지 않습니다');
  }
  // 무손절 가지가 손절을 걸지 않는가
  const branch = decide.match(/stopPolicy === 'NO_FIXED_SL'\)[\s\S]{0,400}?\}/);
  if (branch && /MOVE_STOP|action: 'CLOSE'/.test(branch[0])) {
    err(`${DECIDE}의 무손절 가지가 손절을 걸거나 청산합니다 — 그 계약이 하지 않기로 한 일입니다`);
  }
}

// ══════════ ④ 시간 값의 출처가 드러난다 ══════════
//
// `scalp`의 6시간은 검증용으로 정한 값이고, 무손절 계약에서는 **유일한**
// 자동 종료다. 출처를 숨기면 사용자가 정한 실전 규칙처럼 읽힌다.
{
  if (!/source:\s*'LIFECYCLE_TESTNET_V1'/.test(policy)) {
    err(`${POLICY}에 검증용 출처 표시가 없습니다 — 값이 어디서 왔는지 사라집니다`);
  }
  // ★ **이름이 아니라 파생을 본다.**
  //
  //   처음에는 `policySource`라는 낱말만 찾았다. 그래서 그 변수를 `null`로
  //   박아 버리는 변경이 그대로 통과했다 — 칸은 있고 값은 언제나 비는
  //   상태이고, 화면에서는 "출처 미상"으로 보인다.
  if (!/policySource\s*=\s*policy\?\.source/.test(sweep)) {
    err(`${SWEEP}의 정책 출처가 실제 정책에서 오지 않습니다`
      + ' — 검증용으로 정한 값이 사용자 확정 규칙처럼 보입니다');
  }
  const uses = (sweep.match(/policySource\s*[,:}\n]/g) || []).length;
  if (uses < 2) {
    err(`${SWEEP}가 정책 출처를 결과 줄에 싣지 않습니다 (${uses}곳)`
      + ' — 조치한 줄과 안 한 줄 모두에 있어야 합니다');
  }
}

// ══════════ ⑤ 청산은 확인하고 적는다 (기존 규율 유지) ══════════
{
  if (!/closeSymbolPosition\(/.test(sweep)) err(`${SWEEP}에 실제 청산 호출이 없습니다`);
  // 닫았다고 적기 전에 다시 읽는가.
  //
  // ★ 이 판단은 `lifecycleAction`으로 옮겼다(순서를 시험하려고). 그래서
  //   sweep이 아니라 그 모듈을 본다 — 옛 위치를 계속 보면 옮긴 것을
  //   "사라졌다"로 읽는다.
  if (!/readAfter\s*:/.test(sweep)) {
    err(`${SWEEP}가 청산 실행에 재조회를 넘기지 않습니다`);
  }
  if (!/deps\.readAfter\(\)/.test(act)) {
    err(`${ACT}가 청산 뒤 포지션을 다시 읽지 않습니다 — 접수는 체결이 아닙니다`);
  }
  if (!/applyLifecycleClose\(/.test(sweep)) {
    err(`${SWEEP}가 청산 실행 정본을 쓰지 않습니다 — 순서가 시험되지 않는 자리로 돌아갑니다`);
  }
  if (!/flatVerified/.test(sweep)) {
    err(`${SWEEP}가 재조회 결과를 구분해 적지 않습니다 — 조회 실패가 flat으로 읽힙니다`);
  }
  if (!/mayActOn\(/.test(sweep)) {
    err(`${SWEEP}가 소유권을 확인하지 않습니다 — 남의 포지션을 닫을 수 있습니다`);
  }
  // 진입 시각은 acked_at이다. created_at으로 바뀌면 새 포지션이 조기 청산된다.
  if (!/acked_at/.test(cand)) err(`${CAND}가 체결 시각(acked_at)을 쓰지 않습니다`);
  if (/openedAt\s*=\s*[^;\n]*created_at/.test(cand)) {
    err(`${CAND}가 created_at을 진입 시각으로 씁니다 — 시간 청산이 앞당겨집니다`);
  }
}

// ══════════ ⑥ 종료 요청으로 반대 포지션이 생기지 않는다 ══════════
//
// 이 불변식은 거래소 문서와 무관하게 언제나 참이어야 한다. 종료는 줄이는
// 일이고, 늘리는 일이 되면 그건 종료가 아니다.
//
// 지키는 법은 하나다: **계좌가 어느 모드인지 알고 나서 보낸다.** 단방향과
// 양방향은 허용 파라미터가 다르고, 틀린 조합은 거부가 아니라 반대 방향
// 신규 진입이 될 수 있다.
{
  const fn = ops.indexOf('export async function closeSymbolPosition');
  if (fn < 0) err(`${OPS}에서 closeSymbolPosition을 찾지 못했습니다`);
  else {
    const body = ops.slice(fn, fn + 3200);

    // ① 모드를 **읽는가**
    if (!/futuresPositionMode\s*\(/.test(body)) {
      err(`${OPS}의 종료 경로가 계좌 포지션 모드를 읽지 않습니다`
        + ' — 단방향 전용 파라미터를 양방향 계좌에 보내면 반대 포지션이 열릴 수 있습니다');
    }
    // ② 판정 **정본**을 쓰고, 통과하지 못하면 안 보내는가 (fail-closed)
    //
    //   ★ 판정을 `futuresExec`으로 옮겼다. 진입 판정과 같은 파일에 있어야
    //     한쪽만 고쳐지지 않는다. 여기서는 **그것을 쓰는지**를 본다.
    if (!/closeModeVerdict\(/.test(body)) {
      err(`${OPS}가 종료 모드 판정 정본을 쓰지 않습니다`
        + ' — 판정이 두 곳이면 진입과 종료가 서로 다른 답을 냅니다');
    }
    if (!/if \(!cm\.ok\) return \{ attempted: false/.test(body)) {
      err(`${OPS}가 판정에 걸려도 청산을 보냅니다 — 모르는 모드로 추측해 보내면 안 됩니다`);
    }
    // ③ 모드 판정이 **거래소 호출보다 앞**에 있는가
    const iMode = body.indexOf('futuresPositionMode');
    const iSend = Math.min(
      ...['closePositionGateFutures', 'closePositionPercent']
        .map(n => { const i = body.indexOf(n); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }));
    if (iMode >= 0 && iSend !== Number.MAX_SAFE_INTEGER && iMode > iSend) {
      err(`${OPS}가 청산을 보낸 뒤에 포지션 모드를 읽습니다 — 확인이 먼저입니다`);
    }
    // ④ 방향을 모르면 안 보내는가 (기존 규율 유지)
    if (!/positionSide !== 'LONG'[\s\S]{0,200}?attempted: false/.test(body)) {
      err(`${OPS}가 방향을 모르는 채 청산을 보냅니다 — 짐작하면 반대 진입이 됩니다`);
    }
  }
}

// ══════════ ⑥-b 진입과 종료가 같은 관측을 같은 파일에서 판정한다 ══════════
//
// 진입은 `positionModeVerdict`, 종료는 `closeModeVerdict`. 결론은 다를 수
// 있어도 **판정이 흩어지면** 한쪽만 고쳐진다 — 그때 "열 수는 있고 닫을
// 수는 없는" 상태가 소리 없이 생긴다.
{
  for (const f of ['positionModeVerdict', 'closeModeVerdict']) {
    if (!new RegExp(`export function ${f}\\(`).test(exec)) {
      err(`${EXEC}에 ${f}가 없습니다 — 진입·종료 판정이 한 곳에 없습니다`);
    }
  }
  const i = exec.indexOf('export function closeModeVerdict');
  if (i >= 0) {
    const body = exec.slice(i, i + 2600);
    // 못 읽으면 막는가
    if (!/code: 'UNKNOWN'[\s\S]{0,120}?ok: false|ok: false[\s\S]{0,120}?code: 'UNKNOWN'/.test(body)) {
      err(`${EXEC}의 종료 판정이 모드를 못 읽어도 통과시킵니다`);
    }
    // 양방향을 막는가
    if (!/mode === 'HEDGE'/.test(body) || !/HEDGE_UNVERIFIED/.test(body)) {
      err(`${EXEC}의 종료 판정이 양방향(헤지) 계좌를 구분하지 않습니다`);
    }
    // ★ **두 실패를 섞지 않는다.** 아직 안 연 것과 이미 열려 있는데 못 닫는
    //   것은 운영자가 해야 할 일이 다르다.
    if (!/strandsOpenPosition/.test(body)) {
      err(`${EXEC}의 종료 판정이 "이미 열린 포지션이 갇힌다"를 구분해 적지 않습니다`
        + ' — 신규 진입 차단과 종료 차단이 같은 말로 보입니다');
    }
  }
  // 옛 거짓말이 돌아오지 않는가: 진입 판정이 "청산은 언제나 된다"고 적었다
  if (/열린 포지션은 언제나 닫을 수 있습니다/.test(exec)) {
    err(`${EXEC}가 "열린 포지션은 언제나 닫을 수 있다"고 적습니다`
      + ' — 종료 경로는 모드를 못 읽으면 보내지 않습니다. 사실이 아닙니다');
  }
}

// ══════════ ⑦ 청산 전에 실행 권한을 확인한다 ══════════
//
// 임차(fence)는 있었지만 `stillMine()` 확인이 **sweep이 끝난 뒤**에 있었다.
// 그래서 청산 경로만 잠금 밖이었고, 임차가 넘어간 뒤에도 청산이 나갔다.
{
  if (!/stillMine/.test(sweep)) err(`${SWEEP}에 실행 권한 확인이 없습니다`);
  // sweep에 권한 확인이 **주입되는가**
  if (!/runLifecycleSweep\(sb, dryRun, stillMine\)/.test(route)) {
    err(`${ROUTE}가 수명주기 sweep에 실행 권한을 넘기지 않습니다`
      + ' — 그 경로의 청산이 잠금 밖에 남습니다');
  }
  if (!/stillMine:\s*deps\.stillMine/.test(sweep)) {
    err(`${SWEEP}가 청산 실행에 실행 권한을 넘기지 않습니다`
      + ' — 주입은 받았는데 쓰지 않으면 잠금이 없는 것과 같습니다');
  }
  // 획득이 원자적인가 (읽고-판정하고-쓰는 사이에 끼어들 수 있으면 둘 다 주인이 된다)
  //
  // ★ 획득 순서는 `exitMonitorLease`로 옮겼다 — 두 실행을 동시에 돌려
  //   경합을 재현하는 시험을 붙일 수 있는 자리다. 라우트는 조건부 UPDATE를
  //   실제로 거는 배선이고, 둘 다 필요하다.
  if (!/compareAndSet\(row, prevFence\)/.test(lease)) {
    err(`${LEASE}의 임차 획득이 본 값을 조건으로 걸지 않습니다`
      + ' — 동시 요청이 같은 fence를 얻어 둘 다 주인이 될 수 있습니다');
  }
  if (!/Number\(r\?\.updated\) === 1/.test(lease)) {
    err(`${LEASE}가 갱신된 줄 수를 확인하지 않습니다 — 0줄 갱신이 성공으로 읽힙니다`);
  }
  if (!/\.eq\('fence', prevFence\)/.test(route)) {
    err(`${ROUTE}의 조건부 갱신에 본 fence 조건이 없습니다`
      + ' — 판정은 원자적인데 실제 쿼리가 조건 없이 덮어씁니다');
  }
  // 실행 단계가 권한을 전송보다 먼저 보는가
  const iMine = act.indexOf('stillMine');
  const iClose = act.indexOf('deps.close()');
  if (iMine < 0 || iClose < 0) err(`${ACT}에서 권한 확인 또는 전송을 찾지 못했습니다`);
  else if (iMine > iClose) {
    err(`${ACT}가 청산을 보낸 뒤에 권한을 확인합니다 — 확인이 먼저입니다`);
  }
  // 권한 확인이 던지면 보내지 않는가 (fail-closed)
  if (!/catch \{ mine = false; \}/.test(act)) {
    err(`${ACT}가 권한 확인 실패를 통과로 읽습니다`);
  }
}

// ══════════ ⑧ attempted · accepted · flatVerified를 섞지 않는다 ══════════
{
  for (const f of ['attempted', 'accepted', 'flatVerified']) {
    if (!new RegExp(`${f}:`).test(act)) err(`${ACT}에 ${f}가 없습니다`);
  }
  // 재조회 실패는 null이어야 한다 — boolean으로 적으면 "닫혔다"로 읽힌다
  if (!/CLOSE_UNVERIFIED[\s\S]{0,200}?flatVerified: null/.test(act)) {
    err(`${ACT}가 재조회 실패를 null로 적지 않습니다 — 0이라는 뜻이 아닙니다`);
  }
  // 부분 종료를 ok로 적지 않는가
  if (!/CLOSE_INCOMPLETE[\s\S]{0,160}?ok: false/.test(act)) {
    err(`${ACT}가 포지션이 남은 경우를 성공으로 적습니다 — 부분 종료도 체결로 잡힙니다`);
  }
  // 최종 실행 상태가 수명주기 실패를 포함하는가
  if (!/lifecycleFailed/.test(route)) {
    err(`${ROUTE}의 실행 상태 집계가 수명주기 청산 실패를 포함하지 않습니다`
      + ' — 청산이 실패한 회차가 OK로 남습니다');
  }
  if (!/failed = \[\.\.\.results\.filter[\s\S]{0,80}?lifecycleFailed\]/.test(route)) {
    err(`${ROUTE}가 수명주기 실패를 실패 목록에 합치지 않습니다`);
  }
}

// ══════════ ⑨ 과거 줄이 새 포지션을 판단하지 않는다 ══════════
{
  if (!/STALE_DUPLICATE/.test(cand)) {
    err(`${CAND}가 같은 자리의 오래된 줄을 걸러내지 않습니다`
      + ' — 과거 주문의 보유 시간으로 새 포지션이 청산됩니다');
  }
  // 걸러내기가 **판단 전**이어야 한다
  const iDedupe = cand.indexOf('STALE_DUPLICATE');
  const iMap = cand.indexOf('const positions: ManagedPosition[]');
  if (iDedupe >= 0 && iMap >= 0 && iDedupe > iMap) {
    err(`${CAND}가 후보를 만든 뒤에 중복을 제거합니다 — 판단 전이어야 합니다`);
  }
  // 전략을 키에 넣어야 충돌 감지가 살아 있다
  if (!/strategyId \?\? ''/.test(cand)) {
    err(`${CAND}의 중복 키에 전략이 없습니다 — 다른 전략의 주장이 합쳐져 충돌을 못 봅니다`);
  }
}

// ══════════ ⑩ 닫을 수 없는 계좌에는 진입하지 않는다 ══════════
//
// 종료는 양방향(헤지)을 막는데 진입은 막지 않으면, **열 수는 있고 닫을
// 수는 없는** 상태가 된다. 그건 둘 다 막는 것보다 나쁘다.
{
  if (!/futuresPositionMode/.test(scalp)) {
    err(`${SCALP}가 진입 전에 계좌 포지션 모드를 보지 않습니다`
      + ' — 종료가 불가능한 계좌에서 100배 포지션이 열립니다');
  }
  if (!/pm\.mode !== 'ONE_WAY'[\s\S]{0,120}?return null/.test(scalp)) {
    err(`${SCALP}가 종료 불가 모드에서 진입을 막지 않습니다`);
  }
  // 진입과 종료가 **같은 정본**을 쓰는가 (판정이 두 벌이면 갈린다)
  if (!/futuresPositionMode/.test(ops)) {
    err(`${OPS}와 ${SCALP}가 같은 포지션 모드 정본을 쓰지 않습니다`);
  }
}

// ══════════ ⑪ 판단이 한 곳에만 있다 ══════════
//
// 이 저장소가 이름 붙인 2번 고장: **경로가 둘인데 한쪽만 고침.** sweep 루프가
// 라우트로 되돌아오면 정규식 검사기밖에 못 보는 자리로 돌아가는 것이고, 청산
// 횟수·순서를 세는 시험(`lifecycleSweep.test.ts`)이 무력해진다.
{
  if (!/runLifecycleSweepCore\(/.test(route)) {
    err(`${ROUTE}가 sweep 정본을 쓰지 않습니다`
      + ' — 루프가 라우트로 돌아가면 청산 횟수·순서를 돌려서 셀 수 없습니다');
  }
  // 라우트가 판단을 **다시 갖지 않는가.** 이 낱말들은 sweep 정본의 것이다.
  for (const [pat, what] of [
    [/lifecycleDecide\(/, '종료 판단'],
    [/applyLifecycleClose\(/, '청산 실행'],
    [/managedCandidates\(/, '후보 만들기'],
    [/moveStopSafely\(/, '손절 이동'],
  ]) {
    if (pat.test(route)) {
      err(`${ROUTE}가 ${what}을 직접 합니다 — 판단이 두 곳이면 언젠가 갈립니다`);
    }
  }
  // 회차 안 중복 방지(2중 방어)가 살아 있는가.
  //
  // ★ 이것은 **시험이 못 잡는다.** `managedCandidates`가 같은 전략의 중복
  //   줄을 이미 걸러내고, 전략이 다르면 소유권 충돌로 판단이 멈춘다. 그래서
  //   지금은 도달할 수 없는 방어이고 — 워커가 둘 떠서 후보가 밖에서 겹쳐
  //   들어올 때를 위한 것이다. 도달 못 하는 것을 "돌려서 확인했다"고 적지
  //   않는다. 여기서는 줄이 있는지만 본다.
  if (!/done\.has\(key\)/.test(sweep) || !/done\.add\(key\)/.test(sweep)) {
    err(`${SWEEP}에 회차 안 중복 방지가 없습니다`
      + ' — 워커가 둘 떠서 같은 후보가 겹쳐 들어오면 같은 자리에 두 번 나갑니다');
  }
  // 반대로 정본이 거래소를 **직접** 부르지 않는가 (가짜로 바꿔 끼울 수 있어야 한다)
  if (/from '.*venuePositionOps'|import\('@\/lib\/engine\/venuePositionOps'\)/.test(sweep)) {
    err(`${SWEEP}가 거래소 어댑터를 직접 불러옵니다`
      + ' — 가짜로 바꿔 끼울 수 없으면 청산 횟수를 셀 수 없습니다');
  }
  // 회차를 실제로 돌려 세는 시험이 있는가 (정규식 검사와 구분되는 증거)
  const T = 'src/lib/engine/lifecycleSweep.test.ts';
  if (!existsSync(T)) err(`${T}가 없습니다 — 소스 연결만 보고 실행 횟수를 안 셉니다`);
  else {
    const t = readFileSync(T, 'utf8');
    for (const [pat, what] of [
      [/closes/, '청산 호출 횟수'],
      [/stillMine→close→readAfter/, '호출 순서'],
      [/LEASE_LOST/, '임차 상실'],
      [/readErr/, '장부 조회 실패'],
    ]) {
      if (!pat.test(t)) err(`${T}가 ${what}을 세지 않습니다`);
    }
  }
  // 경합을 재현하는 시험이 있는가
  const L = 'src/lib/engine/exitMonitorLease.test.ts';
  if (!existsSync(L)) err(`${L}가 없습니다`);
  else {
    const t = readFileSync(L, 'utf8');
    if (!/acquireExitLease/.test(t)) err(`${L}가 임차 획득을 돌려 보지 않습니다`);
    if (!/cas:\s*false/.test(t)) {
      err(`${L}가 조건 없이 쓰는 예전 구현을 재현하지 않습니다`
        + ' — 경합이 실제로 일어나는지 보이지 않습니다');
    }
    if (!/Promise\.all\(\[[\s\S]{0,200}?acquireExitLease/.test(t)) {
      err(`${L}가 두 실행을 겹쳐서 돌리지 않습니다`);
    }
  }
}

if (bad > 0) {
  console.error(`\n무손절 포지션 감시 배선 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ 무손절 포지션 감시 — 정책 조회 · 후보 포함 · 추정 금지 ·'
  + ' 시간청산 우선 · 출처 표시 · 청산 후 재확인 · 종료 시 모드 확인 ·'
  + ' 청산 전 권한 확인 · 결과 의미 분리 · 과거 줄 배제 · 진입/종료 대칭 ·'
  + ' 판단 한 곳 · 실행 횟수/순서 실측 · 임차 경합 재현');
