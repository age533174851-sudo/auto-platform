// src/lib/engine/paperCapacity.test.ts
//
// **모의 계좌의 크기는 모의 계좌에서 나온다. 그리고 잔고보다 크게 열 수 없다.**
//
// 회귀 대상 둘:
//
//   ① `buildRiskContext`에 PAPER 분기가 없어, 모의 자동매매의 포지션
//      크기가 거래소 잔고나 폴백 $10,000에서 나왔다. 계좌가 3,000으로
//      줄어도 크기는 10,000 기준이었다 — 복리가 아예 일어나지 않았다.
//   ② 잔고 검사가 없어 계좌보다 큰 포지션이 열릴 수 있었다.
//
// 여기서는 순수 계산과 조회 계약을 붙든다. 최종 판정(동시 진입 race)은
// 계좌를 잠근 트랜잭션이 하고, 그 SQL 계약은 검사기가 본다.

import { test, eq, assert, close } from '../../test/harness';
import { paperCapacityOf, capacityVerdict, readPaperCapacity } from './paperCapacity';

/** paper_accounts / paper_positions만 답하는 가짜 Supabase */
const fakeSb = (i: {
  account?: { balance: unknown } | null;
  accountError?: boolean;
  positions?: Array<{ margin: unknown }> | null;
  positionsError?: boolean;
  onTable?: (t: string) => void;
}) => ({
  from(table: string) {
    i.onTable?.(table);
    const b: any = {
      _table: table,
      select() { return b; },
      eq() { return b; },
      maybeSingle() {
        if (i.accountError) return Promise.resolve({ data: null, error: { message: 'boom' } });
        return Promise.resolve({ data: i.account ?? null, error: null });
      },
      then(res: any) {
        // `.select().eq().eq()`가 그대로 await되는 목록 질의
        if (i.positionsError) return res({ data: null, error: { message: 'boom' } });
        return res({ data: i.positions ?? [], error: null });
      },
    };
    return b;
  },
});

export function runPaperCapacityTests() {
  console.log('[모의 계좌 용량 — 크기도 한도도 모의 장부에서]');

  // ── 순수 계산 ──

  test('잔고 3,000 · 사용 500 → 자산 3,000 · 가용 2,500', () => {
    const c = paperCapacityOf({ balance: 3000, usedMargin: 500 });
    eq(c.known, true);
    if (c.known !== true) return;
    eq(c.balance, 3000);
    eq(c.usedMargin, 500);
    eq(c.available, 2500);
  });

  test('**잔고 0은 확인된 사실이다** — 폴백 10,000으로 바꾸지 않는다', () => {
    const c = paperCapacityOf({ balance: 0, usedMargin: 0 });
    eq(c.known, true);
    if (c.known !== true) return;
    eq(c.balance, 0);
    eq(c.available, 0);
  });

  test('못 읽은 값은 0으로 접지 않는다', () => {
    for (const bad of [null, undefined, '', NaN, 'abc', -1]) {
      eq(paperCapacityOf({ balance: bad, usedMargin: 0 }).known, false);
      eq(paperCapacityOf({ balance: 1000, usedMargin: bad }).known, false);
    }
  });

  test('이미 잔고보다 많이 물고 있으면 가용은 0이다 — 음수가 아니다', () => {
    const c = paperCapacityOf({ balance: 100, usedMargin: 150 });
    eq(c.known, true);
    if (c.known !== true) return;
    eq(c.available, 0);
  });

  // ── 용량 판정: **수수료까지 포함한다** ──

  test('잔고 1,000 · 사용 200 · 새 증거금 700 · 수수료 1 → 통과', () => {
    eq(capacityVerdict({ balance: 1000, usedMargin: 200, margin: 700, entryFee: 1 }).ok, true);
  });

  test('잔고 1,000 · 사용 300 · 새 증거금 700 · 수수료 1 → 차단', () => {
    const v = capacityVerdict({ balance: 1000, usedMargin: 300, margin: 700, entryFee: 1 });
    eq(v.ok, false);
  });

  test('**수수료를 빼먹으면 통과하는 경계** — 100/90/10/0.1은 차단이다', () => {
    // 증거금만 보면 90 + 10 <= 100이라 통과한다. 그런데 수수료가 같은
    // 트랜잭션에서 빠지므로 체결 뒤 잔고는 99.9인데 물고 있는 증거금은 100이다.
    eq(capacityVerdict({ balance: 100, usedMargin: 90, margin: 10, entryFee: 0.1 }).ok, false);
    // 수수료가 0이면 딱 맞아 통과한다 — 경계가 수수료 때문에 갈린다.
    eq(capacityVerdict({ balance: 100, usedMargin: 90, margin: 10, entryFee: 0 }).ok, true);
  });

  test('용량을 모르면 통과시키지 않는다', () => {
    eq(capacityVerdict({ balance: null, usedMargin: 0, margin: 1, entryFee: 0 }).ok, false);
    eq(capacityVerdict({ balance: 100, usedMargin: null, margin: 1, entryFee: 0 }).ok, false);
    eq(capacityVerdict({ balance: 100, usedMargin: 0, margin: null, entryFee: 0 }).ok, false);
    eq(capacityVerdict({ balance: 100, usedMargin: 0, margin: 1, entryFee: null }).ok, false);
  });

  // ── 조회 계약 ──

  test('모의 장부만 읽는다 — 다른 표를 건드리지 않는다', async () => {
    const seen: string[] = [];
    const sb = fakeSb({
      account: { balance: 3000 }, positions: [{ margin: 200 }, { margin: 300 }],
      onTable: (t) => seen.push(t),
    });
    const c = await readPaperCapacity(sb, 'u1');
    eq(c.known, true);
    if (c.known !== true) return;
    eq(c.balance, 3000);
    eq(c.usedMargin, 500);
    eq(c.available, 2500);
    for (const t of seen) {
      assert(t === 'paper_accounts' || t === 'paper_positions', `모의 장부가 아닌 표를 읽었다: ${t}`);
    }
  });

  test('계좌가 없으면 모른다 — 여기서 만들지 않는다', async () => {
    const c = await readPaperCapacity(fakeSb({ account: null }), 'u1');
    eq(c.known, false);
  });

  test('계좌 조회가 실패하면 모른다', async () => {
    const c = await readPaperCapacity(fakeSb({ accountError: true }), 'u1');
    eq(c.known, false);
  });

  test('**포지션 조회가 실패하면 사용 증거금을 0으로 두지 않는다**', async () => {
    // 0은 "아무것도 안 물고 있다"로 읽힌다. 실제로는 모르는 것이고,
    // 그 차이만큼 크게 주문된다.
    const c = await readPaperCapacity(fakeSb({ account: { balance: 3000 }, positionsError: true }), 'u1');
    eq(c.known, false);
  });

  test('포지션 증거금 한 줄을 못 읽어도 모른다', async () => {
    const c = await readPaperCapacity(
      fakeSb({ account: { balance: 3000 }, positions: [{ margin: 100 }, { margin: 'x' }] }), 'u1');
    eq(c.known, false);
  });

  test('열린 포지션이 없으면 사용 0이고 전액이 가용이다', async () => {
    const c = await readPaperCapacity(fakeSb({ account: { balance: 1234.5 }, positions: [] }), 'u1');
    eq(c.known, true);
    if (c.known !== true) return;
    eq(c.usedMargin, 0);
    close(c.available, 1234.5, 1e-9);
  });

  // ── 복리: 별도 배율이 아니라 **잔고가 바뀌면 예산이 바뀐다** ──

  test('잔고가 3,000 → 3,600 → 2,000이면 예산도 따라 움직인다', async () => {
    const budgets: number[] = [];
    for (const bal of [3000, 3600, 2000]) {
      const c = await readPaperCapacity(fakeSb({ account: { balance: bal }, positions: [] }), 'u1');
      if (c.known === true) budgets.push(c.available);
    }
    eq(budgets.join(','), '3000,3600,2000');
  });
}
