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
import { orderIdEvidence, cancelPlanOf, cancelReceiptOf, orphanCancelDecision, asksNothing } from './cancelReceipt';

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

  // ── 합성 판정 (#553 관문 × #554 번호 증거) ──
  //
  // **라우트는 이 함수 하나만 부른다.** `allowed`가 false면 거래소로
  // 나가는 호출이 없다 — 아래 시험은 전부 그 한 줄을 본다.
  console.log('[취소 영수증 — 사전 관문과 합성: allowed=false면 거래소로 안 나간다]');

  const FLAT = { ok: true, found: false, qty: 0 };
  const MINE_ROW = { id: '123456789', ownership: 'MINE', namespace: 'GATE_PRICE', idReadable: true };
  const D = (over: any = {}) => orphanCancelDecision({
    position: FLAT, ledgerReadable: true, orders: [MINE_ROW], asked: ['123456789'], ...over,
  });

  test('모두 확인되면 그 한 건만 보낸다', () => {
    const d = D();
    eq(d.allowed, true);
    eq(d.targets.join(','), '123456789');
    eq(d.notFound.length, 0);
  });

  test('포지션이 열려 있으면 보호주문을 지우지 않는다 — #553이 막은 P0', () => {
    const d = D({ position: { ok: true, found: true, qty: 1 } });
    eq(d.allowed, false);
    eq(d.code, 'POSITION_NOT_FLAT');
  });

  test('포지션 조회 실패는 0이 아니다 — 가짜 qty=0도 막는다', () => {
    // 조회가 실패했는데 qty 칸이 0으로 와도 통과시키지 않는다.
    eq(D({ position: { ok: false, found: false, qty: 0 } }).allowed, false);
    eq(D({ position: null }).allowed, false);
    eq(D({ position: { ok: true, found: false, qty: null } }).allowed, false);
  });

  test('장부(smoke_tests)를 못 읽으면 취소하지 않는다', () => {
    const d = D({ ledgerReadable: false });
    eq(d.allowed, false);
    eq(d.code, 'LEDGER_UNREADABLE');
  });

  test('거래소 목록을 못 읽으면 취소하지 않는다', () => {
    const d = D({ orders: null });
    eq(d.allowed, false);
    eq(d.code, 'ORDERS_UNREADABLE');
  });

  test('번호를 하나도 받지 못하면 요청이 아니다', () => {
    const d = D({ asked: [''] });
    eq(d.allowed, false);
    eq(d.code, 'NOTHING_ASKED');
    eq(asksNothing([null, '', 'null', 'undefined']), true);
    eq(asksNothing(['7']), false);
  });

  test('소유권이 MINE이 아니면 — UNKNOWN도 FOREIGN처럼 막는다', () => {
    for (const own of ['UNKNOWN', 'FOREIGN', '', 'MAYBE']) {
      const d = D({ orders: [{ ...MINE_ROW, ownership: own }] });
      eq(d.allowed, false, `ownership=${own}`);
      eq(d.code, 'OWNERSHIP_NOT_PROVEN', `ownership=${own}`);
    }
  });

  test('Binance Algo는 일반 취소 API로 보내지 않는다', () => {
    const d = D({ orders: [{ ...MINE_ROW, namespace: 'BINANCE_ALGO' }] });
    eq(d.allowed, false);
    eq(d.code, 'UNSUPPORTED_NAMESPACE');
  });

  test('namespace를 모르면 보내지 않는다', () => {
    eq(D({ orders: [{ ...MINE_ROW, namespace: 'UNKNOWN' }] }).allowed, false);
  });

  test('같은 번호가 두 줄이면 어느 것인지 모른다 — 보내지 않는다', () => {
    const d = D({ orders: [MINE_ROW, { ...MINE_ROW }] });
    eq(d.allowed, false);
    eq(d.code, 'TARGET_NOT_UNIQUE');
  });

  test('요청한 번호가 목록에 없고, 번호를 못 읽은 줄이 있으면 "없다"고 말하지 않는다', () => {
    const d = D({
      asked: ['777'],
      orders: [{ id: '', ownership: 'MINE', namespace: 'UNKNOWN', idReadable: false }],
    });
    eq(d.allowed, false);
    eq(d.code, 'ASKED_UNREADABLE');
    eq(d.notFound.length, 0, '못 읽은 줄이 있는데 notFound로 적었습니다');
    eq(d.unreadableRows, 1);
  });

  test('요청한 번호가 없고 모든 줄을 읽었어도 취소는 보내지 않는다', () => {
    // 지울 것이 없으면 보낼 것도 없다. **그리고 "사라졌다"로 적지 않는다.**
    const d = D({ asked: ['777'] });
    eq(d.allowed, false);
    eq(d.code, 'TARGET_NOT_UNIQUE');
    eq(d.notFound.length, 0);
  });

  test('허용된 경로에서도 notFound는 비어 있다 — 단건 일치를 요구하므로', () => {
    eq(D().notFound.length, 0);
  });

  test('관문을 한 조건씩만 어겨도 전부 막힌다 (돌연변이 전수)', () => {
    // **하나라도 통과하면 그 조건은 지켜지는 것이 아니라 아무도 안 보는 것이다.**
    const mutations: Array<[string, any]> = [
      ['position open', { position: { ok: true, found: true, qty: 0.5 } }],
      ['position read fail', { position: { ok: false, found: false, qty: 0 } }],
      ['position null', { position: null }],
      ['qty null', { position: { ok: true, found: false, qty: null } }],
      ['qty nonzero', { position: { ok: true, found: false, qty: 0.001 } }],
      ['ledger unreadable', { ledgerReadable: false }],
      ['orders unreadable', { orders: null }],
      ['no ids', { asked: [] }],
      ['blank id', { asked: ['  '] }],
      ['ownership unknown', { orders: [{ ...MINE_ROW, ownership: 'UNKNOWN' }] }],
      ['algo namespace', { orders: [{ ...MINE_ROW, namespace: 'BINANCE_ALGO' }] }],
      ['duplicate rows', { orders: [MINE_ROW, { ...MINE_ROW }] }],
      ['asked absent', { asked: ['999'] }],
      ['unreadable row + asked absent', {
        asked: ['999'], orders: [{ id: '', ownership: 'MINE', namespace: 'UNKNOWN', idReadable: false }] }],
    ];
    for (const [name, over] of mutations) {
      const d = D(over);
      eq(d.allowed, false, `${name}: 거래소로 나가는 것을 막지 못했습니다`);
      eq(d.targets.length, 0, `${name}: targets가 비어 있지 않습니다`);
      eq(d.notFound.length, 0, `${name}: notFound로 "없다"고 적었습니다`);
    }
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
