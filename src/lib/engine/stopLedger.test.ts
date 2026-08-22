// src/lib/engine/stopLedger.test.ts
//
// **손절을 옮겼는데 장부가 새 번호를 모르면, 그 손절은 나중에 남의 것이 된다.**
//
// 고아 정리는 적어 둔 `sl_order_id`·`tp_order_id`를 1순위 소유 증거로
// 쓰고, 청산 감시는 `ownedOnly: true`로 **그 번호와 일치하는 것만**
// 지운다. 번호를 안 적으면 정리 코드는 안전을 이유로 안 지우고
// (그게 맞다 — 남의 손절을 지우는 것이 가장 큰 사고다), 그 손절은
// 거래소에 계속 남는다.
import { test, eq, assert } from '../../test/harness';
import { stopLedgerVerdict, pickStopLedgerRow } from './stopLedger';
import { ladderEntryClientOrderId, ladderStopClientOrderId, priceTag } from '../strategies/ladderIds';

export function runStopLedgerTests() {
  console.log('[손절 이동 — 새 번호를 적고 나서 옛 것을 취소한다]');

  test('적었을 때만 옛 손절을 취소한다', () => {
    const v = stopLedgerVerdict({ newOrderId: '123', targetFound: true, writeOk: true });
    eq(v.code, 'RECORDED');
    eq(v.recorded, true);
    eq(v.cancelOld, true);
  });

  test('취소를 여는 경우는 정확히 하나뿐이다', () => {
    const cases = [
      { newOrderId: null, targetFound: true, writeOk: true },
      { newOrderId: '', targetFound: true, writeOk: true },
      { newOrderId: '123', targetFound: false, writeOk: null },
      { newOrderId: '123', targetFound: true, writeOk: false },
      { newOrderId: '123', targetFound: true, writeOk: null },
      { newOrderId: '123', targetFound: true, writeOk: true },
    ];
    const open = cases.map(stopLedgerVerdict).filter(v => v.cancelOld);
    eq(open.length, 1, `취소를 여는 경우가 ${open.length}개다`);
    eq(open[0].code, 'RECORDED');
  });

  test('주문 번호를 못 받았으면 옛 손절을 취소하지 않는다', () => {
    // 취소하면 장부에는 없는 옛 번호만 남고, 실제로 걸린 새 손절은
    // 장부에 없어서 남의 것으로 보인다.
    const v = stopLedgerVerdict({ newOrderId: null, targetFound: true, writeOk: true });
    eq(v.code, 'NO_ORDER_ID');
    eq(v.cancelOld, false);
    assert(v.reason.includes('남의 것'), v.reason);
  });

  test('적을 줄을 못 찾았으면 취소하지 않는다', () => {
    const v = stopLedgerVerdict({ newOrderId: '123', targetFound: false, writeOk: null });
    eq(v.code, 'NO_TARGET_ROW');
    eq(v.cancelOld, false);
  });

  test('적기가 실패했으면 취소하지 않는다', () => {
    const v = stopLedgerVerdict({ newOrderId: '123', targetFound: true, writeOk: false });
    eq(v.code, 'WRITE_FAILED');
    eq(v.cancelOld, false);
    // 손절이 잠깐 둘인 것은 위험하지 않다는 사실을 사람이 읽을 수 있어야 한다.
    assert(v.reason.includes('위험하지 않습니다'), v.reason);
  });

  test('공백만 있는 번호는 번호가 아니다', () => {
    eq(stopLedgerVerdict({ newOrderId: '   ', targetFound: true, writeOk: true }).code, 'NO_ORDER_ID');
  });

  console.log('[손절 이동 — 어느 줄에 적는가]');

  const ROWS = [
    { id: 'a', client_order_id: 'LD20260822BTCUSDT', sl_order_id: '111', created_at: '2026-08-22T01:00:00Z' },
    { id: 'b', client_order_id: 'other', sl_order_id: '222', created_at: '2026-08-22T03:00:00Z' },
    { id: 'c', client_order_id: 'nostop', sl_order_id: null, created_at: '2026-08-22T05:00:00Z' },
  ];

  test('진입 식별자가 1순위다', () => {
    // 같은 연결·종목에 여러 주문이 쌓여 있어도 그 거래의 진입 줄은 하나뿐이다.
    eq(pickStopLedgerRow(ROWS, 'LD20260822BTCUSDT')!.id, 'a');
  });

  test('진입 식별자를 못 찾으면 손절 번호를 든 가장 최근 줄로 내려간다', () => {
    eq(pickStopLedgerRow(ROWS, 'LD99999999XXX')!.id, 'b');
  });

  test('손절 번호가 없는 줄에는 적지 않는다', () => {
    // 엉뚱한 줄에 적으면 다른 거래의 손절 번호를 덮어써서 그 거래의
    // 손절이 고아가 된다.
    const only = [{ id: 'c', client_order_id: 'nostop', sl_order_id: null, created_at: '2026-08-22T05:00:00Z' }];
    eq(pickStopLedgerRow(only, null), null);
  });

  test('줄이 없으면 null이다 — 아무 데나 적지 않는다', () => {
    eq(pickStopLedgerRow([], 'LD20260822BTCUSDT'), null);
    eq(pickStopLedgerRow(null, 'x'), null);
  });

  console.log('[계단식 식별자 — 조립을 한 곳에서만 한다]');

  test('진입 식별자 형식을 바꾸지 않았다', () => {
    // **멱등 열쇠다.** 형식이 바뀌면 배포 경계에서 같은 논리적 주문이
    // 다른 id를 갖게 되고, 그건 중복 진입의 문이다.
    eq(ladderEntryClientOrderId({ tradeDate: '2026-08-22', symbol: 'BTCUSDT' }), 'LD20260822BTCUSDT');
  });

  test('손절 식별자는 진입 식별자에서 나온다', () => {
    const cid = ladderStopClientOrderId({ tradeDate: '2026-08-22', symbol: 'BTCUSDT', stopPrice: 59000 });
    assert(cid.startsWith('LD20260822BTCUSDT'), cid);
    assert(cid.length <= 36, `${cid.length}자 — 거래소 상한을 넘는다`);
  });

  test('같은 손절가면 같은 id다 — 재시도가 중복이 되지 않는다', () => {
    const a = ladderStopClientOrderId({ tradeDate: '2026-08-22', symbol: 'BTCUSDT', stopPrice: 59000 });
    const b = ladderStopClientOrderId({ tradeDate: '2026-08-22', symbol: 'BTCUSDT', stopPrice: 59000 });
    eq(a, b);
  });

  test('다른 손절가면 다른 id다 — 옮긴 것이 중복으로 막히면 안 된다', () => {
    const a = ladderStopClientOrderId({ tradeDate: '2026-08-22', symbol: 'BTCUSDT', stopPrice: 59000 });
    const b = ladderStopClientOrderId({ tradeDate: '2026-08-22', symbol: 'BTCUSDT', stopPrice: 60000 });
    assert(a !== b, `같은 id가 나왔다: ${a}`);
  });

  test('자릿수만 보고 섞지 않는다 — 60000과 70000이 같으면 안 된다', () => {
    // `Math.round(price*100) % 1e6` 같은 것은 BTC에서 바로 충돌한다.
    eq(priceTag(60000) === priceTag(70000), false);
    eq(priceTag(1000) === priceTag(2000), false);
    eq(priceTag(0.0001) === priceTag(0.0002), false);
  });

  test('가까운 값도 갈린다', () => {
    const seen = new Set<string>();
    for (let p = 59000; p < 59050; p += 1) seen.add(priceTag(p));
    eq(seen.size, 50, `50개 중 ${seen.size}개만 서로 달랐다`);
  });

  test('시각을 섞지 않는다 — 두 번 불러도 같다', () => {
    // Date.now()를 섞으면 재시도마다 새 id가 되고, 그건 멱등이 아니라 중복이다.
    eq(priceTag(12345.678), priceTag(12345.678));
  });

  test('읽을 수 없는 가격도 값을 돌려준다', () => {
    assert(priceTag(NaN as any).length > 0);
  });
}
