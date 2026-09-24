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
const SWEEP = 'src/app/api/autotrade/exit-monitor/route.ts';
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
const sweep = code(read(SWEEP));
const decide = code(read(DECIDE));
const policy = code(read(POLICY));

// ══════════ ① 장부에서 정책을 읽어 온다 ══════════
{
  if (!/stop_policy/.test(sweep)) {
    err(`${SWEEP}가 stop_policy를 조회하지 않습니다 — 정책을 모르면 무손절 포지션이 후보에서 빠집니다`);
  }
  // **수명주기 sweep의 select 안에** 있어야 한다.
  //
  // ★ 앵커를 두 번 틀렸다. 처음에는 파일의 첫 `.select(`를 잡았는데 그건
  //   자격증명 쿼리였고, 다음에는 첫 `from('live_orders')`를 잡았는데 그건
  //   고아 보호주문 sweep이었다. 같은 표를 읽는 쿼리가 여럿이라, **함수
  //   이름**으로 앵커해야 이 sweep의 select를 본다.
  const fn = sweep.indexOf('runLifecycleSweep');
  if (fn < 0) err(`${SWEEP}에서 runLifecycleSweep을 찾지 못했습니다`);
  else {
    const body = sweep.slice(fn);
    const m = body.match(/from\('live_orders'\)[\s\S]{0,900}?\.order\(/);
    if (!m) err(`${SWEEP}의 runLifecycleSweep에서 주문 장부 select를 찾지 못했습니다`);
    else if (!/stop_policy/.test(m[0])) {
      err(`${SWEEP}의 수명주기 select에 stop_policy가 없습니다`
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
  // 닫았다고 적기 전에 다시 읽는가
  if (!/readOpenPosition\([\s\S]{0,200}?flat/.test(sweep)) {
    err(`${SWEEP}가 청산 뒤 포지션을 다시 읽지 않습니다 — 접수는 체결이 아닙니다`);
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
    // ② 못 읽으면 **안 보내는가** (fail-closed)
    if (!/mode == null[\s\S]{0,260}?attempted: false/.test(body)) {
      err(`${OPS}가 포지션 모드를 못 읽어도 청산을 보냅니다 — 모르는 모드로 추측해 보내면 안 됩니다`);
    }
    // ②-b 양방향 계좌를 **어떻게든 다루는가**
    //
    //   아래 전송은 단방향 전용 조합(`reduceOnly` 무조건 · `positionSide`
    //   없음)이다. 양방향 계좌에 그대로 보내면 반대 포지션이 열릴 수 있다.
    //   그래서 이 가지는 **막든지 분기하든지** 해야 하고, 그냥 통과시키면
    //   안 된다. (정확한 양방향 규격은 아직 공식 문서로 확인하지 못했다.)
    if (!/mode === 'HEDGE'/.test(body)) {
      err(`${OPS}가 양방향(헤지) 계좌를 구분하지 않습니다`
        + ' — 단방향 전용 파라미터가 그대로 나갑니다');
    } else if (!/mode === 'HEDGE'[\s\S]{0,420}?attempted: false/.test(body)) {
      err(`${OPS}의 양방향 가지가 전송을 막지도 분기하지도 않습니다`
        + ' — 확인되지 않은 규격으로 주문이 나갑니다');
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

if (bad > 0) {
  console.error(`\n무손절 포지션 감시 배선 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ 무손절 포지션 감시 — 정책 조회 · 후보 포함 · 추정 금지 ·'
  + ' 시간청산 우선 · 출처 표시 · 청산 후 재확인 · 종료 시 모드 확인');
