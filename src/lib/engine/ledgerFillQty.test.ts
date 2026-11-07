// src/lib/engine/ledgerFillQty.test.ts
import { test, eq, assert } from '../../test/harness';
import { ledgerFillQty } from './ledgerFillQty';

export function runLedgerFillQtyTests() {
  // ── 쓰는 쪽을 정직하게 고치면 읽는 쪽이 메운다 ──
  //
  //   `orderFillFacts`가 체결을 확인하지 못한 줄의 `filled_qty`를 null로
  //   만들자, 읽는 쪽 세 곳의 `Number(r.filled_qty ?? r.quantity) || 0`이
  //   **그 null을 요청 수량으로 메웠다.** 없애려던 결함이 읽는 쪽으로
  //   옮겨 앉은 것이다. 메우는 것 자체를 막지는 않지만(과소 보고가 더
  //   위험하다) **메웠다는 사실**을 반드시 드러낸다.

  test('★ 거래소가 증명한 수량이 있으면 그것만 쓴다', () => {
    const r = ledgerFillQty({ filled_qty: 0.02, quantity: 0.068 });
    eq(r.qty, 0.02);
    eq(r.assumed, false);
    assert(r.qty !== 0.068);
  });

  test('★ 체결 0은 사실이다 — 요청 수량으로 올리지 않는다', () => {
    for (const z of [0, '0', '0.000']) {
      const r = ledgerFillQty({ filled_qty: z, quantity: 0.068 });
      eq(r.qty, 0);
      eq(r.assumed, false);
    }
  });

  test('★ 체결 수량이 없으면 대신 쓰되 **추정이라고 말한다**', () => {
    for (const miss of [null, undefined, '']) {
      const r = ledgerFillQty({ filled_qty: miss, quantity: 0.068 });
      eq(r.qty, 0.068);
      eq(r.assumed, true);     // 이 한 줄이 이 파일의 존재 이유다
    }
  });

  test('★ 읽을 수 없는 값을 수량으로 쓰지 않는다', () => {
    for (const bad of ['abc', 'NaN', 'Infinity', {}, []]) {
      const r = ledgerFillQty({ filled_qty: bad, quantity: 0.068 });
      eq(r.qty, 0.068);
      eq(r.assumed, true);
    }
    // 음수 체결은 사실로 받지 않는다 — 요청 수량으로 떨어진다.
    const neg = ledgerFillQty({ filled_qty: -1, quantity: 0.068 });
    eq(neg.qty, 0.068);
    eq(neg.assumed, true);
  });

  test('★ 둘 다 없으면 0이고, 그것은 추정이 아니다', () => {
    for (const row of [null, undefined, {}, { filled_qty: null, quantity: null }]) {
      const r = ledgerFillQty(row as any);
      eq(r.qty, 0);
      eq(r.assumed, false);    // 셀 것이 없다 — 추정했다고 적으면 거짓이다
    }
    // 요청 수량이 0이어도 추정이 아니다.
    eq(ledgerFillQty({ quantity: 0 }).assumed, false);
  });

  test('★ 문자열 수량도 같게 읽는다', () => {
    eq(ledgerFillQty({ filled_qty: '0.02' }).qty, 0.02);
    eq(ledgerFillQty({ filled_qty: '0.02' }).assumed, false);
    eq(ledgerFillQty({ quantity: '0.068' }).qty, 0.068);
    eq(ledgerFillQty({ quantity: '0.068' }).assumed, true);
  });
}
