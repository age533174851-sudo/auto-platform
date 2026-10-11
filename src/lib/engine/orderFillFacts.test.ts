// src/lib/engine/orderFillFacts.test.ts
import { test, eq, assert } from '../../test/harness';
import { fillFactsOf } from './orderFillFacts';
import { ORDER_STATUSES } from './orderExecutor';

export function runOrderFillFactsTests() {
  // ── 결함 재현 ──
  //
  // 예전 코드는 `parseFloat(d.origQty || d.executedQty || '0')`를
  // `filled_qty`에 적었다. 아래 응답은 **한 주도 채워지지 않은** ACK인데
  // origQty가 0.068이므로 "0.068 체결됨"으로 장부에 남았다.
  const ackOnly = {
    orderId: 1, symbol: 'BTCUSDT', status: 'NEW',
    origQty: '0.068', executedQty: '0', avgPrice: '0.00000', price: '0',
  };

  test('★ 미체결 ACK을 요청 수량만큼 체결됐다고 적지 않는다', () => {
    const f = fillFactsOf(ackOnly);
    eq(f.status, 'ACKED');
    eq(f.filledQty, 0);          // executedQty를 그대로 — origQty가 아니다
    eq(f.avgPrice, null);        // '0.00000'은 가격이 아니라 없음이다
    eq(f.exchangeStatus, 'NEW');
    eq(f.partial, false);
    // 옛 고장이 되돌아오면 여기서 터진다.
    assert(f.filledQty !== 0.068);
  });

  test('★ executedQty가 **없으면** origQty로 메우지 않는다', () => {
    // `executedQty ?? origQty`로 되돌리는 변이를 잡는다. `?? `는 '0'을
    // 통과시키므로 executedQty가 **아예 없는** 응답으로 확인해야 한다.
    const f = fillFactsOf({ status: 'NEW', origQty: '0.068', price: '100500' });
    eq(f.filledQty, null);
    assert(f.filledQty !== 0.068);
    // price도 avgPrice의 대체물이 아니다 — 지정가는 체결가가 아니다.
    eq(f.avgPrice, null);
    for (const raw of [
      { status: 'NEW', origQty: '1' },
      { status: 'PARTIALLY_FILLED', origQty: '1' },
      { status: 'FILLED', origQty: '1' },
    ]) {
      eq(fillFactsOf(raw).filledQty, null);
      eq(fillFactsOf(raw).status, 'ACKED');   // 수량 증거가 없으면 FILLED가 아니다
    }
  });

  test('★ 상태를 못 읽으면 ACKED다 — 시간이 지났다고 성공으로 올리지 않는다', () => {
    for (const raw of [undefined, null, {}, { orderId: 1 }, { status: '' }, { status: '   ' }]) {
      const f = fillFactsOf(raw);
      eq(f.status, 'ACKED');
      eq(f.exchangeStatus, null);
      eq(f.filledQty, null);
      eq(f.avgPrice, null);
    }
  });

  test('★ 부분 체결은 ACKED로 두고 실제 채워진 수량만 적는다', () => {
    const f = fillFactsOf({
      status: 'PARTIALLY_FILLED', origQty: '0.068', executedQty: '0.020', avgPrice: '100500.5',
    });
    eq(f.status, 'ACKED');       // 진행 중 — 계좌 용량 관문이 다음 진입을 막아야 한다
    eq(f.partial, true);
    eq(f.filledQty, 0.02);
    eq(f.avgPrice, 100500.5);
  });

  test('★ FILLED는 거래소가 FILLED라고 말하고 수량이 0보다 클 때만이다', () => {
    const ok = fillFactsOf({ status: 'FILLED', origQty: '0.068', executedQty: '0.068', avgPrice: '100500' });
    eq(ok.status, 'FILLED');
    eq(ok.filledQty, 0.068);
    eq(ok.avgPrice, 100500);

    // FILLED라는데 수량이 0이면 모순이다 — 올리지 않는다.
    eq(fillFactsOf({ status: 'FILLED', executedQty: '0' }).status, 'ACKED');
    eq(fillFactsOf({ status: 'FILLED', executedQty: '' }).status, 'ACKED');
    eq(fillFactsOf({ status: 'FILLED' }).status, 'ACKED');
  });

  test('★ 취소·거절은 FILLED로 올라가지 않는다', () => {
    for (const st of ['CANCELED', 'EXPIRED', 'REJECTED', 'NEW', 'PENDING_CANCEL']) {
      const f = fillFactsOf({ status: st, origQty: '0.068', executedQty: '0.068' });
      eq(f.status, 'ACKED');
      eq(f.exchangeStatus, st);
      // 취소 전에 일부 채워졌을 수 있다 — 그 수량은 사실이므로 보존한다.
      eq(f.filledQty, 0.068);
    }
  });

  test('★ 읽을 수 없는 수량·가격은 0으로 적지 않는다', () => {
    for (const bad of ['abc', 'NaN', undefined, null, {}, [], 'Infinity']) {
      const f = fillFactsOf({ status: 'NEW', executedQty: bad, avgPrice: bad });
      eq(f.filledQty, null);
      eq(f.avgPrice, null);
    }
    // 음수 수량은 사실로 받지 않는다.
    eq(fillFactsOf({ status: 'NEW', executedQty: '-1' }).filledQty, null);
  });

  test('★ 소문자 상태도 같게 읽는다', () => {
    eq(fillFactsOf({ status: 'filled', executedQty: '1' }).status, 'FILLED');
    eq(fillFactsOf({ status: ' Filled ', executedQty: '1' }).exchangeStatus, 'FILLED');
  });

  test('★ 이 함수가 돌려주는 상태는 장부 어휘 안에 있다', () => {
    for (const raw of [ackOnly, { status: 'FILLED', executedQty: '1' }, {}]) {
      assert((ORDER_STATUSES as readonly string[]).includes(fillFactsOf(raw).status));
    }
  });
}
