// src/lib/ledger/ledgerEvent.test.ts
//
// **잔고가 변한 것과 번 것은 다르다.**
//
// 자산은 매매가 아닌 이유로도 변한다 — 입출금, 이체, 수수료, 펀딩,
// 그리고 Gate 테스트넷 일일 충전과 Binance 테스트 자금 초기화.
// 마지막이 특히 위험하다: 테스트넷 충전을 수익으로 세면 전략이 실제로
// 버는 것처럼 보이고, 그 숫자를 믿고 실전으로 넘어간다.

import { test, eq, assert } from '../../test/harness';
import {
  ledgerEventOf, idempotencyKeyOf, ledgerTotals, tradingPnlOf,
} from './ledgerEvent';

const base = (over: any = {}) => ({
  userId: 'u1', env: 'TESTNET', connectionId: 'c1', exchange: 'gate',
  kind: 'FILL', symbol: 'ETHUSDT', venueOrderId: '2089209928026685417',
  amount: 0, occurredAtMs: 1_700_000_000_000, source: 'EXCHANGE_FILL', ...over,
});

export function runLedgerEventTests() {
  console.log('[장부 — 사건을 값으로 확정한다]');

  test('제대로 된 사건은 통과하고 열쇠가 붙는다', () => {
    const v = ledgerEventOf(base());
    eq(v.ok, true);
    assert(!!v.event?.idempotencyKey, '열쇠가 없다');
  });

  test('**모르는 종류를 기타로 눕히지 않는다**', () => {
    // 분류를 못 하면 합계의 어느 항에 넣을지도 못 정한다.
    eq(ledgerEventOf(base({ kind: 'SOMETHING' })).code, 'BAD_KIND');
    eq(ledgerEventOf(base({ kind: '' })).code, 'BAD_KIND');
  });

  test('**환경을 모르면 적지 않는다** — 어느 돈인지 모르는 사건은 합계를 망친다', () => {
    eq(ledgerEventOf(base({ env: 'PROD' })).code, 'BAD_ENV');
    eq(ledgerEventOf(base({ env: null })).code, 'BAD_ENV');
  });

  test('금액이 숫자가 아니면 0으로 적지 않는다', () => {
    eq(ledgerEventOf(base({ amount: null })).code, 'BAD_AMOUNT');
    eq(ledgerEventOf(base({ amount: 'x' })).code, 'BAD_AMOUNT');
  });

  test('**발생 시각이 없으면 "지금"으로 적지 않는다** — 순서가 뒤섞인다', () => {
    eq(ledgerEventOf(base({ occurredAtMs: null })).code, 'BAD_TIME');
    eq(ledgerEventOf(base({ occurredAtMs: 0 })).code, 'BAD_TIME');
  });

  test('출처를 모르면 적지 않는다', () => {
    eq(ledgerEventOf(base({ source: 'somewhere' })).code, 'BAD_SOURCE');
  });

  test('**int64 주문 번호가 문자열 그대로 남는다** (#139)', () => {
    const id = '2089209928026685417';
    assert(!Number.isSafeInteger(Number(id)), '안전 정수 범위를 넘어야 한다');
    eq(ledgerEventOf(base({ venueOrderId: id })).event!.venueOrderId, id);
  });

  console.log('[장부 — 같은 사건을 두 번 적지 않는다]');

  test('**같은 사건은 같은 열쇠다**', () => {
    eq(idempotencyKeyOf(base()), idempotencyKeyOf(base()));
  });

  test('**열쇠에 시각을 섞지 않는다** — 재시도마다 새 열쇠면 멱등이 아니다', () => {
    const a = idempotencyKeyOf(base());
    // 같은 입력으로 잠시 뒤 다시 만들어도 같아야 한다.
    const b = idempotencyKeyOf(base());
    eq(a, b);
    assert(!/\d{13}\|\d{13}/.test(a), `현재 시각이 열쇠에 섞였다: ${a}`);
  });

  test('다른 주문은 다른 열쇠다', () => {
    assert(idempotencyKeyOf(base()) !== idempotencyKeyOf(base({ venueOrderId: '999' })));
  });

  test('**끝자리만 다른 int64 주문 번호가 같은 열쇠가 되지 않는다**', () => {
    const a = '2089209928026685417';
    const b = '2089209928026685418';
    eq(Number(a) === Number(b), true);   // number로는 같아진다
    assert(idempotencyKeyOf(base({ venueOrderId: a })) !== idempotencyKeyOf(base({ venueOrderId: b })),
      '두 체결이 하나로 합쳐진다');
  });

  test('종류가 다르면 열쇠도 다르다 — 같은 주문의 체결과 수수료', () => {
    assert(idempotencyKeyOf(base({ kind: 'FILL' })) !== idempotencyKeyOf(base({ kind: 'FEE' })));
  });

  console.log('[장부 — 테스트넷 충전은 수익이 아니다]');

  test('**테스트넷 충전이 외부 유입으로 분류된다**', () => {
    const t = ledgerTotals([
      { kind: 'TESTNET_CREDIT', amount: 10000 },
      { kind: 'REALIZED_PNL', amount: 12 },
    ]);
    eq(t.testnetCredit, 10000);
    eq(t.externalFlow, 10000);
    eq(t.realizedPnl, 12);
  });

  test('**충전 때문에 자산이 늘어도 매매 손익은 그대로다**', () => {
    // 자산이 10,012 늘었지만 10,000은 충전이다. 번 것은 12뿐이다.
    const t = ledgerTotals([{ kind: 'TESTNET_CREDIT', amount: 10000 }]);
    const p = tradingPnlOf({ equityChange: 10012, totals: t, ledgerComplete: true });
    eq(p.value, 12, '테스트넷 충전이 수익으로 잡혔다');
    assert(/테스트넷 충전/.test(p.reason), p.reason);
  });

  test('입금도 수익이 아니다', () => {
    const t = ledgerTotals([{ kind: 'DEPOSIT', amount: 500 }]);
    eq(tradingPnlOf({ equityChange: 530, totals: t, ledgerComplete: true }).value, 30);
  });

  test('수수료와 펀딩은 매매 손익에서 빠진다', () => {
    const t = ledgerTotals([
      { kind: 'FEE', amount: -2 },
      { kind: 'FUNDING', amount: -3 },
    ]);
    eq(t.fees, -2); eq(t.funding, -3);
    // 자산 변화 100 − 외부 0 − (−2) − (−3) = 105
    eq(tradingPnlOf({ equityChange: 100, totals: t, ledgerComplete: true }).value, 105);
  });

  test('분류하지 못한 사건은 어느 항에도 안 들어간다', () => {
    const t = ledgerTotals([
      { kind: 'NOPE', amount: 999 } as any,
      { kind: 'FEE', amount: -1 },
    ]);
    eq(t.count, 1);
    eq(t.fees, -1);
  });

  console.log('[장부 — 모르면 매매 손익을 만들지 않는다]');

  test('**자산 변화를 모르면 매매 손익도 모른다**', () => {
    const p = tradingPnlOf({ equityChange: null, totals: ledgerTotals([]), ledgerComplete: true });
    eq(p.value, null); eq(p.complete, false);
    assert(p.missing.includes('자산 변화'), JSON.stringify(p.missing));
  });

  test('**장부가 기간을 다 덮지 못하면 매매 손익을 만들지 않는다**', () => {
    // 사건을 절반만 읽고 계산하면 나머지 절반이 전부 수익으로 둔갑한다.
    const p = tradingPnlOf({ equityChange: 100, totals: ledgerTotals([]), ledgerComplete: false });
    eq(p.value, null);
    assert(p.missing.includes('장부 완전성'), JSON.stringify(p.missing));
    assert(/수익으로 둔갑/.test(p.reason), p.reason);
  });

  test('장부 자체가 없으면 만들지 않는다', () => {
    eq(tradingPnlOf({ equityChange: 100, totals: null, ledgerComplete: true }).value, null);
  });

  test('전부 알면 숫자를 만든다', () => {
    const p = tradingPnlOf({ equityChange: 50, totals: ledgerTotals([]), ledgerComplete: true });
    eq(p.value, 50); eq(p.complete, true); eq(p.missing.length, 0);
  });
}
