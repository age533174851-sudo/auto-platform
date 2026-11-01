// src/lib/engine/cancelReceipt.test.ts
//
// **2026-11-02 00:36(KST) 화면 한 장이 이 파일의 이유다 (#552).**
//
// 사용자가 본 것: 포지션 0 · 조건부 주문 1건 · 판정 MINE ·
// `이 주문만 취소 (#)` → `취소 응답 · HTTP 400 · 0바퀴 · 재조회 성공`,
// 그리고 재조회에도 그 주문은 그대로 있었다.
//
// 그 화면에는 거래소가 등장하지 않는다. 앱이 자기 요청을 스스로 거절한
// 것인데, 화면은 **"재조회 성공"**이라고 적었다. 재조회는 일어나지
// 않았다 — 없는 필드를 성공으로 읽은 것이다. 그래서 사용자는 "바이낸스가
// 400을 줬다"로 읽었고, 한 회차가 그 추측 위에서 돌았다.
//
// 여기서 막는 것 셋:
//   1. **번호를 못 읽은 주문에 취소 번호를 넘기지 않는다** — 넘기면 앱이
//      자기 400을 돌려주고, 그 400이 거래소 거부처럼 보인다.
//   2. **못 읽은 것을 0이나 성공으로 적지 않는다** — 필드가 없으면
//      "안 함(모름)"이다.
//   3. **번호를 못 읽은 줄이 섞인 목록으로 "사라졌다"고 말하지 않는다** —
//      내가 못 읽은 그 줄이 바로 그 주문일 수 있다.

import { test, eq, assert } from '../../test/harness';
import { orderIdEvidence, cancelPlanOf, cancelReceiptOf } from './cancelReceipt';

/** Gate 조건부 주문 한 줄 (화면이 보여 준 모양) */
const gateRow = (over: any = {}) => ({
  id: 123456789,
  initial: { contract: 'ETH_USDT', auto_size: 'close_long', text: 't-smo-24fddc0cf8' },
  trigger: { price: '2289.1', rule: 1 },
  ...over,
});

export function runCancelReceiptTests() {
  console.log('[취소 영수증 — 번호를 못 읽은 주문]');

  test('읽은 번호는 그 칸 이름까지 같이 돌려준다', () => {
    const e = orderIdEvidence(gateRow());
    eq(e.readable, true);
    eq(e.id, '123456789');
    eq(e.source, 'id');
  });

  test('바이낸스는 orderId 칸이다', () => {
    const e = orderIdEvidence({ orderId: 55, symbol: 'ETHUSDT' });
    eq(e.readable, true); eq(e.id, '55'); eq(e.source, 'orderId');
  });

  test('정밀도를 잃은 숫자는 번호가 아니다 — 그 값으로 취소하면 없는 주문을 지운다', () => {
    const e = orderIdEvidence(gateRow({ id: 20897621948123456789 }));
    eq(e.readable, false);
    eq(e.id, '');
    eq(e.source, 'id');
    assert(e.reason.includes('정밀도'), e.reason);
  });

  test('취소에 쓸 번호 칸이 아예 없으면, 어떤 칸이 있었는지 적는다 (값은 안 적는다)', () => {
    // #552의 Algo namespace 질문. **추측하지 않고 무엇을 봤는지만 남긴다.**
    const e = orderIdEvidence({ algoId: 'A-1', clientAlgoId: 'c-1', symbol: 'ETHUSDT' });
    eq(e.readable, false);
    eq(e.id, '');
    eq(e.source, null);
    assert(e.reason.includes('algoId'), e.reason);
    assert(e.reason.includes('clientAlgoId'), e.reason);
    assert(!e.reason.includes('A-1'), `값이 새어 나갔습니다: ${e.reason}`);
  });

  test('주문 줄이 아니면 번호도 없다', () => {
    eq(orderIdEvidence(null).readable, false);
    eq(orderIdEvidence('x' as any).readable, false);
  });

  console.log('[취소 영수증 — 보낼 수 없는 요청을 보내지 않는다]');

  test('빈 번호는 요청이 아니다 — 앱이 자기 400을 돌려주는 자리', () => {
    const p = cancelPlanOf({ asked: [''], rows: [gateRow()] });
    eq(p.code, 'NOTHING_ASKED');
    eq(p.blocked, true);
    eq(p.targets.length, 0);
  });

  test('목록을 못 읽었으면 취소하지 않는다', () => {
    const p = cancelPlanOf({ asked: ['123456789'], rows: null });
    eq(p.code, 'ORDERS_UNREADABLE');
    eq(p.blocked, true);
  });

  test('읽은 번호가 목록에 있으면 그 번호만 대상이다', () => {
    const p = cancelPlanOf({ asked: ['123456789'], rows: [gateRow(), gateRow({ id: 999 })] });
    eq(p.code, 'READY');
    eq(p.blocked, false);
    eq(p.targets.join(','), '123456789');
    eq(p.notFound.length, 0);
    eq(p.unreadableRows, 0);
  });

  test('모든 줄의 번호를 읽었을 때만 "목록에 없다"고 말한다', () => {
    const p = cancelPlanOf({ asked: ['777'], rows: [gateRow()] });
    eq(p.code, 'READY');
    eq(p.notFound.join(','), '777');
    eq(p.unreadableRows, 0);
  });

  test('번호를 못 읽은 줄이 섞여 있으면 "사라졌다"고 말할 수 없다 — 그 줄이 그 주문일 수 있다', () => {
    const p = cancelPlanOf({
      asked: ['777'],
      rows: [gateRow({ id: 20897621948123456789 })],
    });
    eq(p.code, 'ASKED_UNREADABLE');
    eq(p.blocked, true);
    eq(p.notFound.length, 0, '못 읽은 줄이 있는데 notFound로 적었습니다');
    eq(p.unreadableRows, 1);
    assert(p.reason.includes('읽지 못'), p.reason);
  });

  test('못 읽은 줄이 있어도, 요청한 번호가 읽힌 줄에 있으면 그것은 보낸다', () => {
    const p = cancelPlanOf({
      asked: ['123456789'],
      rows: [gateRow(), gateRow({ id: 20897621948123456789 })],
    });
    eq(p.code, 'READY');
    eq(p.blocked, false);
    eq(p.targets.join(','), '123456789');
    eq(p.unreadableRows, 1);
  });

  console.log('[취소 영수증 — 못 읽은 것을 성공으로 적지 않는다]');

  test('거래소까지 가지 않은 거절을 "재조회 성공"으로 적지 않는다 — 사용자가 본 바로 그 줄', () => {
    const r = cancelReceiptOf({ httpStatus: 400, body: { ok: false, error: 'ids_required' } });
    eq(r.rounds, null);
    eq(r.reread, 'NONE');
    eq(r.reachedVenue, false);
    assert(!r.line.includes('재조회 성공'), `일어나지 않은 재조회를 성공으로 적었습니다: ${r.line}`);
    assert(r.line.includes('모름'), r.line);
    // **앱의 거절 코드가 화면에 보여야 한다.** 안 보이면 거래소 거부로 읽힌다.
    assert(r.line.includes('ids_required'), r.line);
  });

  test('0바퀴는 "안 돌았다"다 — 없는 필드를 0으로 적지 않는다', () => {
    const r = cancelReceiptOf({ httpStatus: 503, body: { ok: false, error: 'orders_unreadable' } });
    eq(r.rounds, null);
    assert(!r.line.includes('0바퀴'), r.line);
  });

  test('실제로 돈 바퀴와 재조회 성공은 그대로 적는다', () => {
    const r = cancelReceiptOf({ httpStatus: 200, body: { ok: true, rounds: 2, leftoverReadable: true } });
    eq(r.rounds, 2);
    eq(r.reread, 'OK');
    eq(r.reachedVenue, true);
    assert(r.line.includes('2바퀴'), r.line);
    assert(r.line.includes('재조회 성공'), r.line);
  });

  test('재조회 실패는 실패로 적는다', () => {
    const r = cancelReceiptOf({ httpStatus: 409, body: { rounds: 3, leftoverReadable: false } });
    eq(r.reread, 'FAILED');
    eq(r.rounds, 3);
    assert(r.line.includes('실패(모름)'), r.line);
  });

  test('바퀴 수가 이상한 값이면 모름이다 — 숫자로 꾸며 적지 않는다', () => {
    for (const bad of ['two', -1, 1.5, NaN, Infinity, null, {}]) {
      const r = cancelReceiptOf({ httpStatus: 200, body: { rounds: bad, leftoverReadable: true } });
      eq(r.rounds, null, `rounds=${String(bad)}`);
    }
  });

  test('HTTP 없는 자리(저장된 정리 증거)도 같은 규칙을 쓴다', () => {
    // 스모크가 남긴 장부에는 HTTP가 없다. 그래도 "모름"은 모름이다.
    const r = cancelReceiptOf({ body: { code: 'NOTHING_TO_CANCEL' } });
    eq(r.rounds, null);
    eq(r.reread, 'NONE');
    assert(!r.line.includes('HTTP'), r.line);
    assert(!r.line.includes('재조회 성공'), r.line);
    assert(r.line.includes('안 함(모름)'), r.line);
  });

  test('본문이 아예 없으면 전부 모름이다', () => {
    const r = cancelReceiptOf({ httpStatus: 0, body: null });
    eq(r.rounds, null);
    eq(r.reread, 'NONE');
    eq(r.reachedVenue, false);
  });
}
