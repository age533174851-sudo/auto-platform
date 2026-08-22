// src/lib/risk/killSwitchTruth.test.ts
//
// **급할 때 누른 버튼의 응답 문구를 사람이 읽고 손을 뗀다.**
//
// 그래서 킬스위치에서 가장 위험한 실패는 "안 됐다"가 아니라
// **"됐다고 말하는 것"**이다. 아래 판정들이 그 자리다.
import { test, eq, assert } from '../../test/harness';
import {
  intentOf, leftoverVerdict, killCompletion, retriggerPlan, resetVerdict, isTestnetConn,
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
}
