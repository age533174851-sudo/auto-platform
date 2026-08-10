// src/lib/engine/closeEvidence.test.ts
//
// **조회 실패를 "닫혔다"로 읽으면 열려 있는 포지션이 장부에서 사라진다.**
//
// 실제로 있던 코드다. `getFuturesPositions`가 실패하면 `positions` 칸이
// 없는 응답을 주는데, 그걸 빈 배열로 읽고 "포지션이 이미 없다 — 목표
// 달성"으로 처리한 뒤 장부에 CLOSED를 적었다. 아무것도 안 닫고서.

import { test, eq, assert } from '../../test/harness';
import { readPositions, closeVerdict, exitReasonLine } from './closeEvidence';

const okRead = (amount: number | null = 1) => ({ ok: true, found: true, amount });
const flatRead = () => ({ ok: true, found: false, amount: null });
const failRead = (e = '타임아웃') => ({ ok: false, found: false, amount: null, error: e });

export function runCloseEvidenceTests() {
  console.log('[청산 증거 — 조회 실패는 닫힘이 아니다]');

  test('바이낸스 실패 응답을 "포지션 없음"으로 읽지 않는다', () => {
    // { success: false, message } — positions 칸이 아예 없다.
    const r = readPositions({ success: false, message: '-2015 잘못된 API 키' }, 'BTCUSDT');
    eq(r.ok, false);
    assert(String(r.error).includes('2015'), r.error || '');
  });

  test('조회 실패면 장부를 건드리지 않는다', () => {
    const v = closeVerdict({ before: failRead('ETIMEDOUT') });
    eq(v.closed, false);
    eq(v.code, 'READ_FAILED');
    eq(v.needsReconcile, true);
    eq(v.retry, true);
    assert(v.reason.includes('조회 실패는'), v.reason);
  });

  test('빈 배열과 조회 실패는 다르다', () => {
    // 빈 배열 = 조회는 됐고 포지션이 없다 → 닫힘 확인
    eq(closeVerdict({ before: readPositions({ ok: true, positions: [] }, 'BTCUSDT') }).closed, true);
    // 실패 = 모른다 → 닫힘 아님
    eq(closeVerdict({ before: readPositions({ ok: false }, 'BTCUSDT') }).closed, false);
  });

  test('모르는 응답 모양은 성공으로 읽지 않는다', () => {
    for (const res of [null, undefined, {}, { positions: null }, 'oops', { data: [] }]) {
      eq(readPositions(res as any, 'BTCUSDT').ok, false, JSON.stringify(res));
    }
  });

  console.log('[청산 증거 — 심볼 표기]');

  test('Gate 계약 이름도 같은 심볼로 본다', () => {
    const res = { ok: true, positions: [{ symbol: 'BTC_USDT', amount: 0.5 }] };
    eq(readPositions(res, 'BTCUSDT').found, true);
    eq(readPositions(res, 'BTCUSDT').amount, 0.5);
  });

  test('다른 심볼의 포지션을 이 거래로 세지 않는다', () => {
    const res = { ok: true, positions: [{ symbol: 'ETHUSDT', amount: 2 }] };
    eq(readPositions(res, 'BTCUSDT').found, false);
  });

  test('수량을 못 읽어도 줄이 있으면 포지션이 있는 것이다', () => {
    // 수량 파싱 실패를 0으로 읽으면 "없다"가 되고, 그러면 닫힘으로 적힌다.
    const r = readPositions({ ok: true, positions: [{ symbol: 'BTCUSDT', amount: null }] }, 'BTCUSDT');
    eq(r.found, true); eq(r.amount, null);
    eq(closeVerdict({ before: r }).closed, false);
  });

  console.log('[청산 증거 — 접수는 체결이 아니다]');

  test('청산 주문 접수만으로 닫혔다고 적지 않는다', () => {
    const v = closeVerdict({
      before: okRead(1), order: { attempted: true, ok: true }, after: null,
    });
    eq(v.closed, false);
    eq(v.code, 'RECONCILE_REQUIRED');
    eq(v.needsReconcile, true);
  });

  test('주문 뒤 조회에서 사라졌으면 닫힘이다', () => {
    const v = closeVerdict({
      before: okRead(1), order: { attempted: true, ok: true }, after: flatRead(),
    });
    eq(v.closed, true); eq(v.code, 'CLOSE_VERIFIED');
  });

  test('부분 체결은 닫힘이 아니다 — 남은 수량을 다시 닫는다', () => {
    const v = closeVerdict({
      before: okRead(1), order: { attempted: true, ok: true }, after: okRead(0.4),
    });
    eq(v.closed, false); eq(v.code, 'STILL_OPEN'); eq(v.retry, true);
    assert(v.reason.includes('부분 체결'), v.reason);
  });

  test('주문 뒤 조회가 실패하면 대조 필요다 — 닫힘이 아니다', () => {
    const v = closeVerdict({
      before: okRead(1), order: { attempted: true, ok: true }, after: failRead(),
    });
    eq(v.closed, false); eq(v.code, 'RECONCILE_REQUIRED');
  });

  test('청산 주문이 거절되면 장부는 OPEN 그대로다', () => {
    const v = closeVerdict({
      before: okRead(1), order: { attempted: true, ok: false, error: '-2022 ReduceOnly 거절' },
    });
    eq(v.closed, false); eq(v.code, 'ORDER_FAILED'); eq(v.retry, true);
    assert(v.reason.includes('2022'), v.reason);
  });

  test('주문을 안 보냈으면 열린 채로 둔다', () => {
    const v = closeVerdict({ before: okRead(1) });
    eq(v.closed, false); eq(v.code, 'STILL_OPEN');
  });

  console.log('[청산 증거 — 닫지 못한 이유가 장부에 남는다]');

  test('닫히면 사유는 원문 그대로다', () => {
    eq(exitReasonLine('시간 청산', closeVerdict({ before: flatRead() })), '시간 청산');
  });

  test('못 닫았으면 무엇이 막았는지 장부에 적힌다', () => {
    const line = exitReasonLine('시간 청산', closeVerdict({ before: failRead('ECONNRESET') }));
    assert(line.includes('RECONCILE_REQUIRED'), line);
    assert(line.includes('시간 청산'), line);
    assert(line.length <= 300, '칸 길이를 넘지 않아야 한다');
  });

  console.log('[청산 증거 — 어떤 입력으로도 모름을 닫힘으로 만들 수 없다]');

  test('조회가 실패한 상태에서는 무엇을 붙여도 닫히지 않는다', () => {
    for (const order of [null, { attempted: true, ok: true }, { attempted: false, ok: false }]) {
      for (const after of [null, flatRead(), okRead(1)]) {
        eq(closeVerdict({ before: failRead(), order: order as any, after }).closed, false,
          `${JSON.stringify(order)} / ${JSON.stringify(after)}`);
      }
    }
  });
}
