// src/lib/trading/orderBook.test.ts
//
// **두 거래 화면이 같은 호가 판단을 쓰는지 고정한다.**
//
// 예전에는 각자 계산했고 실제로 갈려 있었다 — 가운데 값의 폴백이 달라서,
// 체결가가 아직 없고 매수 호가만 비는 순간 한 화면은 가격을 보여 주고
// 다른 화면은 '—'를 보여 줬다.
import { test, eq, assert } from '../../test/harness';
import { orderBookLadder, orderBookLive } from './orderBook';

const A = (p: number, q: number) => ({ price: p, qty: q });

export function runOrderBookTests() {
  test('매도는 높은 가격이 위로 온다', () => {
    const l = orderBookLadder({ asks: [A(101, 1), A(102, 2), A(103, 3)], bids: [], rows: 3 });
    eq(l.asks.map(x => x.price).join(','), '103,102,101');
  });

  test('매수는 높은 가격부터 그대로다', () => {
    const l = orderBookLadder({ asks: [], bids: [A(99, 1), A(98, 2)], rows: 3 });
    eq(l.bids.map(x => x.price).join(','), '99,98');
  });

  test('줄 수를 넘기지 않는다', () => {
    const l = orderBookLadder({
      asks: [A(1, 1), A(2, 1), A(3, 1), A(4, 1)],
      bids: [A(9, 1), A(8, 1), A(7, 1), A(6, 1)], rows: 2,
    });
    eq(l.asks.length, 2); eq(l.bids.length, 2);
    // 잘라낸 뒤 뒤집는다 — 최우선 둘이지 아무 둘이 아니다
    eq(l.asks.map(x => x.price).join(','), '2,1');
    eq(l.bids.map(x => x.price).join(','), '9,8');
  });

  test('★ 음수·0·비숫자 줄 수는 엉뚱한 구간을 만들지 않는다', () => {
    for (const r of [0, -1, -7, NaN, undefined, null, 'x']) {
      const l = orderBookLadder({ asks: [A(1, 1), A(2, 1)], bids: [A(9, 1)], rows: r as any });
      eq(l.asks.length, 0); eq(l.bids.length, 0); eq(l.empty, true);
    }
  });

  test('깊이 막대 분모는 0이 되지 않는다', () => {
    const l = orderBookLadder({ asks: [], bids: [], rows: 5 });
    assert(l.maxQty > 0, '분모가 0입니다 — 나누면 Infinity가 됩니다');
  });

  test('분모는 양쪽에서 가장 큰 수량이다', () => {
    const l = orderBookLadder({ asks: [A(1, 3)], bids: [A(9, 7)], rows: 5 });
    eq(l.maxQty, 7);
  });

  // ── 갈려 있던 자리 ──
  test('체결가가 있으면 그것이 가운데 값이다', () => {
    const l = orderBookLadder({ asks: [A(101, 1)], bids: [A(99, 1)], rows: 5, lastPrice: 100 });
    eq(l.mid, 100);
  });

  test('체결가가 없으면 최우선 매수다', () => {
    const l = orderBookLadder({ asks: [A(101, 1)], bids: [A(99, 1)], rows: 5, lastPrice: null });
    eq(l.mid, 99);
  });

  test('★ 매수가 비면 최우선 매도까지 본다 — 여기가 두 화면이 갈리던 자리다', () => {
    const l = orderBookLadder({ asks: [A(101, 1), A(102, 1)], bids: [], rows: 5, lastPrice: null });
    // asks는 뒤집혀 [102, 101]이므로 최우선(가장 낮은) 매도는 101이다
    eq(l.mid, 101);
  });

  test('아무것도 없으면 가격을 지어내지 않는다', () => {
    eq(orderBookLadder({ asks: [], bids: [], rows: 5, lastPrice: null }).mid, null);
    eq(orderBookLadder({ asks: [], bids: [], rows: 5, lastPrice: 0 }).mid, null);
    eq(orderBookLadder({ asks: [], bids: [], rows: 5, lastPrice: NaN }).mid, null);
  });

  test('체결가가 0이나 음수면 호가로 넘어간다', () => {
    eq(orderBookLadder({ asks: [], bids: [A(99, 1)], rows: 5, lastPrice: -1 }).mid, 99);
  });

  test('입력이 없어도 터지지 않는다', () => {
    const l = orderBookLadder({ rows: 5 } as any);
    eq(l.empty, true); eq(l.mid, null);
    const l2 = orderBookLadder({ asks: null, bids: undefined, rows: 5 } as any);
    eq(l2.empty, true);
  });

  // ── 실시간 판정 ──
  test('★ 연결만으로 실시간이라고 적지 않는다 — stale이면 아니다', () => {
    eq(orderBookLive({ status: 'live', stale: false }), true);
    eq(orderBookLive({ status: 'live', stale: true }), false);
  });

  test('연결이 살아 있지 않으면 실시간이 아니다', () => {
    for (const s of ['connecting', 'reconnecting', 'error', 'idle', '', null, undefined]) {
      eq(orderBookLive({ status: s as any, stale: false }), false);
    }
    eq(orderBookLive(null), false);
    eq(orderBookLive(undefined), false);
  });
}
