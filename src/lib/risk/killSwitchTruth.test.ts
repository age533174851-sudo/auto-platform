// src/lib/risk/killSwitchTruth.test.ts
//
// **급할 때 누른 버튼의 응답 문구를 사람이 읽고 손을 뗀다.**
//
// 그래서 킬스위치에서 가장 위험한 실패는 "안 됐다"가 아니라
// **"됐다고 말하는 것"**이다. 아래 판정들이 그 자리다.
import { test, eq, assert } from '../../test/harness';
import {
  intentOf, leftoverVerdict, killCompletion, retriggerPlan, resetVerdict, isTestnetConn,
  targetedCloseVerdict, discoveryVerdict, effectiveModeOf,
} from './killSwitchTruth';

const CLEAR = leftoverVerdict({ leftover: { positions: 0, orders: 0 }, expectedClosed: true });
const REMAINS = leftoverVerdict({ leftover: { positions: 1, orders: 0 }, expectedClosed: true });
const UNKNOWN = leftoverVerdict({ leftover: { positions: null, orders: null }, expectedClosed: true });

export function runKillSwitchTruthTests() {
  console.log('[킬스위치 — 하기로 한 것만 말한다]');

  test('기본 조합(BC)은 포지션을 닫지 않는다', () => {
    const i = intentOf('BC');
    eq(i.cancel, true);
    eq(i.close, false, 'D가 없는데 닫는다고 읽었다');
  });

  test('D가 있으면 취소가 먼저 온다', () => {
    const i = intentOf('BD');
    eq(i.close, true);
    eq(i.cancel, true, '종료하려면 취소가 선행돼야 한다');
  });

  // ── 여기가 실제로 틀려 있던 자리 ──
  //
  // 예전 판정: `close?.success !== false`. BC에서는 `close`가 null이라
  // `undefined !== false` → 참. **한 적 없는 일이 성공으로 셌다.**
  test('포지션을 안 닫는 단계에서 "포지션 종료 완료"라고 적지 않는다', () => {
    const d = killCompletion({
      actionMode: 'BC',
      exec: { ran: true, cancel: { ran: true, success: true }, close: null },
      leftover: leftoverVerdict({ leftover: { positions: 3, orders: 0 }, expectedClosed: false }),
    });
    eq(d.complete, true, '취소가 끝났고 미체결 0인데 미완료로 적었다');
    eq(d.intendedClose, false);
    assert(!d.message.includes('포지션 종료'), d.message);
    assert(d.message.includes('닫지 않습니다'), d.message);
  });

  test('실행 안 한 취소를 성공으로 세지 않는다', () => {
    const d = killCompletion({
      actionMode: 'BC',
      // ran이 없다 = 안 돌았다
      exec: { ran: true, cancel: null, close: null },
      leftover: CLEAR,
    });
    eq(d.complete, false);
    assert(d.missing.includes('미체결 취소'), d.missing.join(' · '));
  });

  test('거래소 확인 없이 완료라고 적지 않는다', () => {
    const d = killCompletion({
      actionMode: 'BCD',
      exec: { ran: true, cancel: { ran: true, success: true }, close: { ran: true, success: true } },
      leftover: null,
    });
    eq(d.complete, false, '거래소에 물어보지도 않고 완료라고 적었다');
  });

  test('잔여 확인이 UNKNOWN이면 완료가 아니다', () => {
    const d = killCompletion({
      actionMode: 'BCD',
      exec: { ran: true, cancel: { ran: true, success: true }, close: { ran: true, success: true } },
      leftover: UNKNOWN,
    });
    eq(d.complete, false, '못 읽은 것을 정리됨으로 읽었다');
  });

  test('전부 하고 거래소가 0을 확인해 줬을 때만 완료다', () => {
    const d = killCompletion({
      actionMode: 'BCD',
      exec: { ran: true, cancel: { ran: true, success: true }, close: { ran: true, success: true } },
      leftover: CLEAR,
    });
    eq(d.complete, true);
    assert(d.message.includes('포지션 종료'), d.message);
    assert(d.message.includes('거래소 확인됨'), d.message);
  });

  test('심볼별 종료가 하나라도 실패하면 완료가 아니다', () => {
    const d = killCompletion({
      actionMode: 'BCD',
      exec: { ran: true, cancel: { ran: true, success: true }, close: { ran: true, success: true }, closeFailed: 1 },
      leftover: CLEAR,
    });
    eq(d.complete, false);
  });

  test('실행 자체를 못 했으면 절반만 됐다고 적는다', () => {
    const d = killCompletion({ actionMode: 'BCD', exec: { ran: false }, leftover: CLEAR });
    eq(d.complete, false);
    assert(d.message.includes('신규 주문 차단'), d.message);
    assert(d.message.includes('직접 확인'), d.message);
  });

  console.log('[킬스위치 — 잔여를 0으로 추측하지 않는다]');

  test('못 읽은 것을 0으로 읽지 않는다', () => {
    eq(UNKNOWN.code, 'UNKNOWN');
    eq(leftoverVerdict({ leftover: { positions: 0, orders: null }, expectedClosed: false }).code, 'UNKNOWN');
    // 포지션까지 봐야 하는 단계인데 포지션을 못 읽었으면 모르는 것이다.
    eq(leftoverVerdict({ leftover: { positions: null, orders: 0 }, expectedClosed: true }).code, 'UNKNOWN');
  });

  test('포지션을 안 닫는 단계에서는 포지션이 남아 있어도 정상이다', () => {
    const v = leftoverVerdict({ leftover: { positions: 2, orders: 0 }, expectedClosed: false });
    eq(v.code, 'CLEAR');
    assert(v.reason.includes('포지션을 닫지 않습니다'), v.reason);
  });

  test('미체결이 남아 있으면 어느 단계든 REMAINS다', () => {
    eq(leftoverVerdict({ leftover: { positions: 0, orders: 1 }, expectedClosed: false }).code, 'REMAINS');
  });

  console.log('[킬스위치 — 다시 눌렀을 때]');

  test('첫 발동은 당연히 실행한다', () => {
    eq(retriggerPlan({ wasActive: false }).execute, true);
  });

  // 사용자가 다시 누르는 순간은 대부분 첫 실행이 절반만 됐을 때다.
  test('이미 발동 중이어도 남아 있으면 다시 실행한다', () => {
    const p = retriggerPlan({ wasActive: true, leftover: REMAINS });
    eq(p.execute, true, '남았는데 아무것도 안 하고 성공이라고 답했다');
  });

  test('이미 발동 중이고 잔여를 모르면 다시 실행한다', () => {
    const p = retriggerPlan({ wasActive: true, leftover: UNKNOWN });
    eq(p.execute, true, '모르는 것을 정리됨으로 두었다');
    assert(p.reason.includes('모르는 것'), p.reason);
  });

  test('잔여 확인을 아예 못 한 경우에도 다시 실행한다', () => {
    eq(retriggerPlan({ wasActive: true, leftover: null }).execute, true);
  });

  test('남은 것이 없다고 확인됐을 때만 건너뛴다', () => {
    eq(retriggerPlan({ wasActive: true, leftover: CLEAR }).execute, false);
  });

  console.log('[킬스위치 — 리셋은 잠금을 여는 동작이다]');

  test('총자산을 모르면 리셋하지 않는다', () => {
    // 0을 기준선으로 저장하면 다음 낙폭 판정이 전부 틀린다.
    const v = resetVerdict({ equity: null, leftover: CLEAR });
    eq(v.allowed, false);
    eq(v.code, 'EQUITY_UNKNOWN');
  });

  test('잔여를 모르면 잠금을 풀지 않는다', () => {
    const v = resetVerdict({ equity: 1000, leftover: UNKNOWN });
    eq(v.allowed, false);
    eq(v.code, 'LEFTOVER_UNKNOWN');
  });

  test('잔여 확인을 아예 안 했으면 잠금을 풀지 않는다', () => {
    eq(resetVerdict({ equity: 1000, leftover: null }).allowed, false);
  });

  test('남아 있으면 잠금을 풀지 않는다', () => {
    const v = resetVerdict({ equity: 1000, leftover: REMAINS });
    eq(v.allowed, false);
    eq(v.code, 'LEFTOVER_REMAINS');
  });

  test('둘 다 확인됐을 때만 연다', () => {
    const v = resetVerdict({ equity: 1000, leftover: CLEAR });
    eq(v.allowed, true);
  });

  test('총자산 0은 모르는 것과 다르다', () => {
    // 진짜로 0원인 계좌는 리셋할 수 있어야 한다.
    eq(resetVerdict({ equity: 0, leftover: CLEAR }).allowed, true);
  });

  test('NaN을 총자산으로 받지 않는다', () => {
    eq(resetVerdict({ equity: NaN, leftover: CLEAR }).allowed, false);
  });

  console.log('[킬스위치 — 실전 판정은 저장소 규칙을 따른다]');

  test('is_testnet === false 만 실전이다', () => {
    // 예전에는 `=== true`였다 — NULL이 실전으로 읽혀서 테스트넷 키로
    // 실전 호스트에 물어보고, 그 실패가 equity 0이 되어 발동했다.
    eq(isTestnetConn({ is_testnet: false }), false);
    eq(isTestnetConn({ is_testnet: true }), true);
    eq(isTestnetConn({ is_testnet: null }), true, 'NULL을 실전으로 읽었다');
    eq(isTestnetConn({}), true);
    eq(isTestnetConn(null), true);
  });

  console.log('[킬스위치 — 건너뛴 것과 못 한 것은 다르다]');

  // ── 두 판정이 서로 모순됐던 자리 ──
  //
  // `retriggerPlan`이 "이미 발동 중이고 거래소에 남은 것이 없다"고
  // 판정하면 실행을 안 한다. 그러면 `exec`가 null인데, 예전 `killCompletion`은
  // 그걸 곧바로 "실행하지 못했습니다"로 읽어 **502를 냈다.**
  // 깨끗해서 안 했는데 실패라고 답한 것이다.
  test('이미 깨끗해서 재실행을 생략한 것은 성공이다', () => {
    const plan = retriggerPlan({ wasActive: true, leftover: CLEAR });
    eq(plan.execute, false);
    const d = killCompletion({
      actionMode: 'BCD', exec: null, leftover: CLEAR,
      skipped: { reason: plan.reason },
    });
    eq(d.complete, true, '깨끗해서 안 했는데 실패라고 답했다 — 502가 나간다');
    assert(d.message.includes('거래소 확인됨'), d.message);
  });

  test('건너뛰었다고 해도 거래소가 안 깨끗하면 성공이 아니다', () => {
    // skipped를 무조건 성공으로 읽으면 그게 새 구멍이 된다.
    eq(killCompletion({ actionMode: 'BCD', exec: null, leftover: REMAINS,
      skipped: { reason: 'x' } }).complete, false);
    eq(killCompletion({ actionMode: 'BCD', exec: null, leftover: UNKNOWN,
      skipped: { reason: 'x' } }).complete, false);
    eq(killCompletion({ actionMode: 'BCD', exec: null, leftover: null,
      skipped: { reason: 'x' } }).complete, false);
  });

  test('건너뛴 적 없는데 exec가 없으면 여전히 실패다', () => {
    eq(killCompletion({ actionMode: 'BCD', exec: null, leftover: CLEAR }).complete, false);
  });

  console.log('[킬스위치 — 심볼별 청산은 D 없이도 검사한다]');

  const conf = (symbol: string) =>
    ({ symbol, ok: true, before: 1, after: 0, closePct: 100 });

  // CLOSE_AUTOMATED(actions A·B·C)와 REDUCE_RISK(A·B)는 **D가 없다.**
  // 그런데 실제로는 심볼별로 포지션을 닫거나 줄인다. 예전에는
  // `intent.close`일 때만 검사해서, 자동매매 포지션 청산이 실패했는데
  // 일반 주문이 0이면 완료로 적혔다.
  test('D가 없어도 심볼별 청산 실패를 잡는다', () => {
    const d = killCompletion({
      actionMode: 'ABC',                 // CLOSE_AUTOMATED — D 없음
      exec: {
        ran: true, cancel: { ran: true, success: true }, close: null,
        targeted: [conf('BTCUSDT'), { symbol: 'ETHUSDT', ok: false, message: '거절' }],
      },
      leftover: leftoverVerdict({ leftover: { positions: 1, orders: 0 }, expectedClosed: false }),
    });
    eq(d.complete, false, '자동매매 포지션 청산이 실패했는데 완료로 적었다');
    assert(d.missing.some(m => m.includes('ETHUSDT')), d.missing.join(' · '));
  });

  test('D가 없고 심볼별 청산이 전부 확인되면 완료다', () => {
    const d = killCompletion({
      actionMode: 'ABC',
      exec: {
        ran: true, cancel: { ran: true, success: true }, close: null,
        targeted: [conf('BTCUSDT'), conf('ETHUSDT')],
      },
      leftover: leftoverVerdict({ leftover: { positions: 0, orders: 0 }, expectedClosed: false }),
    });
    eq(d.complete, true, d.missing.join(' · '));
  });

  test('접수를 청산으로 읽지 않는다 — 재조회가 없으면 미확인이다', () => {
    const v = targetedCloseVerdict({ symbol: 'BTCUSDT', ok: true, before: 1, after: null, closePct: 100 });
    eq(v.code, 'UNVERIFIED');
    assert(v.reason.includes('접수는 체결이 아닙니다'), v.reason);
  });

  test('전량 청산은 재조회 0일 때만 확인이다', () => {
    eq(targetedCloseVerdict({ symbol: 'X', ok: true, before: 2, after: 0, closePct: 100 }).code, 'CONFIRMED');
    eq(targetedCloseVerdict({ symbol: 'X', ok: true, before: 2, after: 0.5, closePct: 100 }).code, 'STILL_OPEN');
  });

  test('절반 축소는 목표 수량까지 줄었는지 본다', () => {
    // 2 → 절반 → 1 이하여야 한다.
    eq(targetedCloseVerdict({ symbol: 'X', ok: true, before: 2, after: 1, closePct: 50 }).code, 'CONFIRMED');
    eq(targetedCloseVerdict({ symbol: 'X', ok: true, before: 2, after: 1.8, closePct: 50 }).code, 'STILL_OPEN');
  });

  test('줄이기 전 수량을 모르면 확인했다고 말하지 않는다', () => {
    eq(targetedCloseVerdict({ symbol: 'X', ok: true, before: null, after: 1, closePct: 50 }).code, 'UNVERIFIED');
  });

  test('주문이 거절되면 재조회 값과 무관하게 실패다', () => {
    eq(targetedCloseVerdict({ symbol: 'X', ok: false, before: 1, after: 0, closePct: 100 }).code, 'ORDER_FAILED');
  });

  test('재조회 근거가 없는 옛 모양도 실패 건수는 놓치지 않는다', () => {
    const d = killCompletion({
      actionMode: 'ABC',
      exec: { ran: true, cancel: { ran: true, success: true }, close: null, closeFailed: 2 },
      leftover: leftoverVerdict({ leftover: { positions: 0, orders: 0 }, expectedClosed: false }),
    });
    eq(d.complete, false);
  });

  // ══ 대상을 못 찾은 것과 대상이 없는 것 ══
  //
  // REDUCE_RISK는 actions ['A','B'] — actionMode에 C도 D도 없다.
  // 그래서 cancel·close 어느 조건에도 안 걸리고, leftover는
  // expectedClosed=false라 남은 포지션을 세지 않는다. 대상까지 비어
  // 있으면 **아무것도 안 하고 complete=true**가 됐다.
  const REDUCE = { closePct: 50, automatedOnly: false };
  const AUTO = { closePct: 100, automatedOnly: true };

  test('REDUCE_RISK + 거래소 포지션 2개 + live_orders 0개 → 두 포지션 모두 대상', () => {
    // 후보를 장부가 아니라 거래소에서 만들면 장부가 비어도 2건이다.
    const d = discoveryVerdict({ spec: REDUCE, positionsRead: true, ledgerRead: true, targetCount: 2 });
    eq(d.code, 'VERIFIED_TARGETS', '두 건을 찾았다');
    eq(d.count, 2, '2건');
  });

  test('REDUCE_RISK + 포지션 조회 실패 → 완료 아님', () => {
    const d = discoveryVerdict({ spec: REDUCE, positionsRead: false, ledgerRead: true, targetCount: 0 });
    eq(d.code, 'UNKNOWN', '못 읽었다');
    eq(d.count, null, '0으로 적지 않는다');
    const c = killCompletion({
      actionMode: 'AB', exec: { ran: true, targeted: null, closeFailed: 0 } as any,
      leftover: { code: 'CLEAR', expectedClosed: false, reason: '미체결 0' } as any,
      discovery: d,
    });
    assert(!c.complete, '대상을 못 찾았는데 완료라고 적었다');
    assert(c.missing.some(m => /읽지 못했습니다/.test(m)), '사유가 남아야 한다');
  });

  test('CLOSE_AUTOMATED + live_orders 조회 오류 → 완료 아님', () => {
    const d = discoveryVerdict({ spec: AUTO, positionsRead: true, ledgerRead: false, targetCount: 0 });
    eq(d.code, 'UNKNOWN', '장부를 못 읽으면 봇의 것을 가릴 수 없다');
    const c = killCompletion({
      actionMode: 'ABC',
      exec: { ran: true, cancel: { ran: true, success: true }, targeted: null, closeFailed: 0 } as any,
      leftover: { code: 'CLEAR', expectedClosed: false, reason: '미체결 0' } as any,
      discovery: d,
    });
    assert(!c.complete, '장부를 못 읽었는데 완료라고 적었다');
  });

  test('CLOSE_AUTOMATED + 조회 성공 + 실제 대상 0 → VERIFIED_EMPTY이고 완료다', () => {
    const d = discoveryVerdict({ spec: AUTO, positionsRead: true, ledgerRead: true, targetCount: 0 });
    eq(d.code, 'VERIFIED_EMPTY', '읽었고 정말 없었다');
    const c = killCompletion({
      actionMode: 'ABC',
      exec: { ran: true, cancel: { ran: true, success: true }, targeted: null, closeFailed: 0 } as any,
      leftover: { code: 'CLEAR', expectedClosed: false, reason: '미체결 0' } as any,
      discovery: d,
    });
    assert(c.complete, '정말 없는 것까지 실패로 만들면 안 된다');
    assert(/줄일 포지션 없음/.test(c.message), '확인했다고 적어야 한다');
  });

  test('targeted가 비었는데 discovery UNKNOWN → complete=false', () => {
    const c = killCompletion({
      actionMode: 'AB', exec: { ran: true, targeted: [], closeFailed: 0 } as any,
      leftover: { code: 'CLEAR', expectedClosed: false, reason: '미체결 0' } as any,
      discovery: { code: 'UNKNOWN', count: null, reason: '거래소에서 열린 포지션을 읽지 못했습니다' } as any,
    });
    assert(!c.complete, '빈 배열을 확인됨으로 읽었다');
  });

  test('찾았는데 청산 기록이 없으면 완료가 아니다', () => {
    const c = killCompletion({
      actionMode: 'AB', exec: { ran: true, targeted: null, closeFailed: 0 } as any,
      leftover: { code: 'CLEAR', expectedClosed: false, reason: '미체결 0' } as any,
      discovery: { code: 'VERIFIED_TARGETS', count: 2, reason: '2건' } as any,
    });
    assert(!c.complete, '찾은 것과 한 것이 어긋났는데 완료라고 적었다');
    assert(c.missing.some(m => /청산 기록이 없습니다/.test(m)), '사유');
  });

  test('포지션을 줄이지 않는 단계는 discovery를 요구하지 않는다', () => {
    const d = discoveryVerdict({ spec: { closePct: 0, automatedOnly: false }, positionsRead: false, ledgerRead: false, targetCount: 0 });
    eq(d.code, 'NOT_APPLICABLE', '해당 없음');
    const c = killCompletion({
      actionMode: 'BC',
      exec: { ran: true, cancel: { ran: true, success: true }, targeted: null, closeFailed: 0 } as any,
      leftover: { code: 'CLEAR', expectedClosed: false, reason: '미체결 0' } as any,
      discovery: d,
    });
    assert(c.complete, 'BC는 원래 포지션을 안 닫는다');
  });

  // ══ 이번 발동을 만든 조합 ══
  test('설정 BC → 수동 CLOSE_ALL → 일부 남음 → reset이 잠금을 풀지 않는다', () => {
    // 이번 발동의 조합이 남아 있으면 D를 보고 포지션까지 확인한다.
    const eff = effectiveModeOf({ effective: 'ABCD', config: 'BC', active: true });
    eq(eff.expectedClosed, true, 'CLOSE_ALL은 포지션을 닫는다');
    eq(eff.source, 'EFFECTIVE', '이번 발동의 값');

    const lv = leftoverVerdict({
      leftover: { positions: 1, orders: 0, error: null } as any,
      expectedClosed: eff.expectedClosed,
    });
    eq(lv.code, 'REMAINS', '포지션이 남아 있다');
    const g = resetVerdict({ equity: 1000, leftover: lv });
    assert(!g.allowed, '남은 포지션 위에서 잠금을 풀면 안 된다');
    eq(g.code, 'LEFTOVER_REMAINS', '사유');
  });

  test('설정값으로 판단하면 그 잠금이 풀린다 — 그래서 설정값을 쓰지 않는다', () => {
    // 예전 동작 재현: 저장된 설정 BC로 판단
    const lvOld = leftoverVerdict({
      leftover: { positions: 1, orders: 0, error: null } as any,
      expectedClosed: intentOf('BC').close,   // false
    });
    eq(lvOld.code, 'CLEAR', '설정값으로 보면 포지션을 안 센다');
    assert(resetVerdict({ equity: 1000, leftover: lvOld }).allowed,
      '이것이 예전에 잠금이 풀리던 경로다');
  });

  test('이번 발동의 조합이 없으면 가장 강한 쪽으로 본다 — 느슨하게 풀지 않는다', () => {
    const eff = effectiveModeOf({ effective: null, config: 'BC', active: true });
    eq(eff.expectedClosed, true, '모르면 닫았을 수 있다고 본다');
    eq(eff.source, 'ASSUMED_STRICT', '가정한 것이라고 적는다');
    const lv = leftoverVerdict({
      leftover: { positions: 1, orders: 0, error: null } as any,
      expectedClosed: eff.expectedClosed,
    });
    eq(lv.code, 'REMAINS', '포지션을 센다');
    assert(!resetVerdict({ equity: 1000, leftover: lv }).allowed, '잠금이 풀리면 안 된다');
  });

  test('발동 중이 아니면 설정값을 써도 된다', () => {
    const eff = effectiveModeOf({ effective: null, config: 'BC', active: false });
    eq(eff.source, 'CONFIG', '설정값');
    eq(eff.expectedClosed, false, 'BC는 포지션을 안 닫는다');
  });

  test('이번 발동의 조합이 설정값보다 약해도 그 값을 쓴다', () => {
    // 설정이 ABCD인데 이번엔 PAUSE_ENTRIES(A)만 실행한 경우.
    const eff = effectiveModeOf({ effective: 'A', config: 'ABCD', active: true });
    eq(eff.mode, 'A', '이번 값');
    eq(eff.expectedClosed, false, '이번엔 안 닫았다');
    eq(eff.source, 'EFFECTIVE', '이번 발동의 값');
  });
}
