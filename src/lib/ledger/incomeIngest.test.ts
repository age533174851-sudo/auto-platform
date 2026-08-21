// src/lib/ledger/incomeIngest.test.ts
//
// **수수료와 펀딩을 모르면 "번 것"을 말할 수 없다.**
//
// 장부 표는 있는데 매매손익이 영원히 null이었던 이유가 이것이다.
// 그런데 모으는 쪽이 조용히 틀리면 더 나쁘다 — 없는 수익이 생긴다.

import { test, eq, assert } from '../../test/harness';
import {
  classifyIncome, incomeToEvents, nextIngestFrom, ledgerCovers,
  OVERLAP_MS, MAX_BACKFILL_MS,
} from './incomeIngest';

const BASE = {
  userId: 'u1', env: 'TESTNET' as const, connectionId: 'c1', exchange: 'binance',
};
const NOW = 1_800_000_000_000;

export function runIncomeIngestTests() {
  console.log('[거래소 원장 수집 — 모르는 것을 손익으로 읽지 않는다]');

  test('두 거래소의 이름을 같은 종류로 옮긴다', () => {
    eq(classifyIncome('REALIZED_PNL'), 'REALIZED_PNL');
    eq(classifyIncome('COMMISSION'), 'FEE');
    eq(classifyIncome('FUNDING_FEE'), 'FUNDING');
    // Gate가 맞춰 주는 이름
    eq(classifyIncome('fee'), 'FEE');
    eq(classifyIncome('fund'), 'FUNDING');
  });

  test('**모르는 종류를 손익으로 읽지 않는다**', () => {
    // 거래소는 종류를 계속 늘린다. 뭉뚱그리면 없는 수익이 생긴다.
    eq(classifyIncome('SOME_NEW_TYPE_2027'), 'UNKNOWN');
    eq(classifyIncome(''), 'UNKNOWN');
  });

  test('**테스트넷 충전은 수익이 아니다**', () => {
    eq(classifyIncome('WELCOME_BONUS'), 'TESTNET_CREDIT');
  });

  test('수수료의 부호를 뒤집지 않는다', () => {
    // 거래소는 이미 계좌 관점으로 준다. 뒤집으면 수수료가 수익이 된다.
    const r = incomeToEvents({ ...BASE, rows: [{ incomeType: 'COMMISSION', income: -0.42, time: NOW }] });
    eq(r.events[0].kind, 'FEE');
    eq(r.events[0].amount, -0.42);
  });

  test('모르는 종류는 적지 않고 **그 사실을 남긴다**', () => {
    const r = incomeToEvents({ ...BASE, rows: [
      { incomeType: 'REALIZED_PNL', income: 12, time: NOW },
      { incomeType: 'MYSTERY', income: 999, time: NOW },
      { incomeType: 'MYSTERY', income: 1, time: NOW },
    ] });
    eq(r.events.length, 1);
    eq(r.skipped.find(s => s.type === 'MYSTERY')!.count, 2);
  });

  test('시각이나 금액이 숫자가 아니면 적지 않는다 — 0으로 적으면 없었던 일이 된다', () => {
    const r = incomeToEvents({ ...BASE, rows: [
      { incomeType: 'FEE', income: NaN as any, time: NOW },
      { incomeType: 'FEE', income: -1, time: 0 },
    ] });
    eq(r.events.length, 0);
    eq(r.skipped.find(s => s.type === 'BAD_ROW')!.count, 2);
  });

  test('**테스트넷 입금은 TESTNET_CREDIT으로 적는다**', () => {
    // 실전 입금과 같은 칸에 넣으면 나중에 둘을 못 가른다.
    const r = incomeToEvents({ ...BASE, rows: [{ incomeType: 'DEPOSIT', income: 10000, time: NOW }] });
    eq(r.events[0].kind, 'TESTNET_CREDIT');
  });

  test('실전 입금은 그대로 DEPOSIT이다', () => {
    const r = incomeToEvents({ ...BASE, env: 'LIVE', rows: [{ incomeType: 'DEPOSIT', income: 500, time: NOW }] });
    eq(r.events[0].kind, 'DEPOSIT');
  });

  test('Gate의 dnw는 부호로 입금·출금을 가른다', () => {
    const inn = incomeToEvents({ ...BASE, env: 'LIVE', rows: [{ incomeType: 'dnw', income: 100, time: NOW }] });
    const out = incomeToEvents({ ...BASE, env: 'LIVE', rows: [{ incomeType: 'dnw', income: -100, time: NOW }] });
    eq(inn.events[0].kind, 'DEPOSIT');
    eq(out.events[0].kind, 'WITHDRAWAL');
  });

  test('거래소 번호는 문자열로 남는다', () => {
    const r = incomeToEvents({ ...BASE, rows: [
      { incomeType: 'FEE', income: -1, time: NOW, tranId: '2089209928026685417' },
    ] });
    eq(r.events[0].venueOrderId, '2089209928026685417');
  });

  test('읽은 구간을 돌려준다', () => {
    const r = incomeToEvents({ ...BASE, rows: [
      { incomeType: 'FEE', income: -1, time: NOW - 5000 },
      { incomeType: 'FEE', income: -1, time: NOW },
    ] });
    eq(r.fromMs, NOW - 5000);
    eq(r.toMs, NOW);
  });

  // ── 어디까지 읽었는가 ──

  test('처음에는 최근 7일부터 읽는다', () => {
    const n = nextIngestFrom({ coverage: null, nowMs: NOW });
    eq(n.fromMs, NOW - MAX_BACKFILL_MS);
  });

  test('**겹쳐서 읽는다** — 빠지는 것보다 겹치는 것이 낫다', () => {
    const n = nextIngestFrom({ coverage: { fromMs: NOW - 100_000, toMs: NOW - 1000 }, nowMs: NOW });
    eq(n.fromMs, NOW - 1000 - OVERLAP_MS);
  });

  test('아무리 오래 안 돌았어도 7일보다 더 거슬러 가지 않는다', () => {
    const n = nextIngestFrom({ coverage: { fromMs: 0, toMs: NOW - 30 * 24 * 3_600_000 }, nowMs: NOW });
    eq(n.fromMs, NOW - MAX_BACKFILL_MS);
  });

  test('덮인 구간만 완전하다고 말한다', () => {
    const c = { fromMs: NOW - 86_400_000, toMs: NOW };
    eq(ledgerCovers({ coverage: c, periodFromMs: NOW - 3_600_000, periodToMs: NOW }).complete, true);
  });

  test('**앞이 비면 완전하지 않다** — 그 기간의 수수료를 모른다', () => {
    const c = { fromMs: NOW - 3_600_000, toMs: NOW };
    const v = ledgerCovers({ coverage: c, periodFromMs: NOW - 86_400_000, periodToMs: NOW });
    eq(v.complete, false);
    assert(/매매손익을 만들 수 없습니다/.test(v.reason), v.reason);
  });

  test('최근 구간이 아직이면 완전하지 않다', () => {
    const c = { fromMs: NOW - 86_400_000, toMs: NOW - 600_000 };
    eq(ledgerCovers({ coverage: c, periodFromMs: NOW - 3_600_000, periodToMs: NOW }).complete, false);
  });

  test('한 번도 안 읽었으면 완전하지 않다', () => {
    const v = ledgerCovers({ coverage: null, periodFromMs: NOW - 1000, periodToMs: NOW });
    eq(v.complete, false);
    assert(/읽은 적이 없습니다/.test(v.reason), v.reason);
  });
}
