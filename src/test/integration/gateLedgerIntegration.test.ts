// src/test/integration/gateLedgerIntegration.test.ts
//
// **일일 손실 한도가 읽는 원장을 끝까지, 믿을 수 있게 읽는가.**
//
// 실제로 도는 것: `getGateAccountBook` → `gateReq`(서명 생성 · 질의 조립 ·
//   응답 파싱). 가짜는 `fetch` 한 겹뿐이다.
//
// 이 값의 뜻은 `dailyLossCheck`가 정한다:
//
//     rows == null  → todayNetUsd = null → judgeDailyLoss = unknown
//                     → **신규 진입 차단**
//     rows != null  → 그 합이 오늘의 손익이다 (한도 판정의 근거)
//
// 즉 **불완전한 배열을 돌려주는 것이 null보다 나쁘다.** null은 막고,
// 모자란 배열은 "오늘 덜 잃었다"가 되어 한도를 통과시킨다.
//
// Gate 공식 문서(`GET /futures/{settle}/account_book`):
//   · `limit` 기본 100 — "Maximum number of records returned in a single list"
//   · `offset` — "List offset, starting from 0"
//   · `from`/`to` — Unix timestamp
//   · **정렬 순서는 적혀 있지 않다**
// 그래서 첫 쪽에 없다고 없는 것이 아니다.

import { test, eq, assert } from '../harness';
import { FakeVenue } from './venueHarness';
// 정적 import — 러너가 이 사슬을 컴파일 대상에 넣어야 한다.
import { getGateAccountBook } from '../../lib/exchanges/gateFutures';

const BOOK = '/api/v4/futures/usdt/account_book';
const KEY = 'K'.repeat(32);
const SECRET = 'S'.repeat(64);
const NOW_SEC = 1_760_000_000;

/** 실제 응답 한 줄의 모양 (초 단위 time, 문자열 change) */
function row(change: string, over: Record<string, unknown> = {}) {
  return { time: NOW_SEC, change, balance: '1000', type: 'pnl', text: 'BTC_USDT', ...over };
}
/** 한 쪽을 채운다 */
function page(n: number, change = '-0.01') {
  return Array.from({ length: n }, () => row(change));
}

async function on<T>(v: FakeVenue, fn: () => Promise<T>): Promise<T> {
  const restore = v.install();
  try { return await fn(); } finally { restore(); }
}

/** offset을 보고 쪽마다 다른 응답을 준다 */
function paged(v: FakeVenue, byOffset: (offset: number) => any) {
  v.on(BOOK, { json: () => {
    const c = v.calls[v.calls.length - 1];
    return byOffset(Number(c?.params?.offset ?? 0));
  } });
  return v;
}

export async function runGateLedgerTests() {
  console.log('[통합 — Gate 손익 원장]');

  // ══════════ ① 정상 원장 10건 ══════════
  {
    const v = paged(new FakeVenue(), (o) => (o === 0 ? page(10, '-2.5') : []));
    const r: any = await on(v, () => getGateAccountBook(KEY, SECRET, true));

    test('★ ① 정상 원장 10건은 그대로 10건이다', () => {
      assert(Array.isArray(r), '정상 조회가 null로 막혔다');
      eq(r.length, 10);
      eq(r[0].incomeType, 'REALIZED_PNL');
      eq(r[0].income, -2.5);
      eq(r[0].time, NOW_SEC * 1000, '초 → ms 변환이 빠지면 전부 어제로 걸러진다');
    });
  }

  // ══════════ ② 손익 0 USDT는 정상이다 ══════════
  //
  // 0을 거부하면 수수료만 난 줄이 사라진다. 막아야 하는 것은 **못 읽은
  // 것**이지 0이 아니다.
  {
    const v = paged(new FakeVenue(), (o) => (o === 0 ? [row('0')] : []));
    const r: any = await on(v, () => getGateAccountBook(KEY, SECRET, true));

    test('★ ② 금액 0은 거부하지 않는다', () => {
      assert(Array.isArray(r), '정상적인 0 손익이 막혔다');
      eq(r.length, 1);
      eq(r[0].income, 0);
    });
  }

  // ══════════ ③ 301번째 줄의 큰 손실을 놓치지 않는다 ══════════
  //
  // 첫 쪽만 읽으면 그 손실이 오늘 집계에서 빠지고, 한도가 헐거워진다.
  {
    const v = paged(new FakeVenue(), (o) => {
      if (o === 0) return page(300, '-0.01');
      if (o === 300) return [row('-5000')];
      return [];
    });
    const r: any = await on(v, () => getGateAccountBook(KEY, SECRET, true));

    test('★ ③ 301번째 줄의 손실도 집계에 들어간다', () => {
      assert(Array.isArray(r), String(r));
      eq(r.length, 301, '첫 쪽만 읽으면 300건에서 멈춘다');
      const total = r.reduce((s: number, x: any) => s + x.income, 0);
      assert(Math.abs(total - (-5003)) < 1e-9,
        `합이 ${total}이다 — 큰 손실이 빠지면 한도가 헐거워진다`);
    });
  }

  // ══════════ ④ 첫 쪽이 가득 차면 다음 쪽을 읽는다 ══════════
  {
    const v = paged(new FakeVenue(), (o) => (o === 0 ? page(300) : o === 300 ? page(5) : []));
    const r: any = await on(v, () => getGateAccountBook(KEY, SECRET, true));

    test('★ ④ 가득 찬 쪽 뒤의 짧은 쪽까지 읽고 끝낸다', () => {
      assert(Array.isArray(r), String(r));
      eq(r.length, 305);
      eq(v.countOf(BOOK), 2, '짧은 쪽에서 멈춰야 한다');
    });
  }

  // ══════════ ⑤ 두 번째 쪽 조회 실패 ══════════
  //
  // 앞 쪽만 들고 돌아가면 **덜 잃은 것으로** 보인다 — 한도가 통과한다.
  {
    const v = new FakeVenue();
    // 첫 쪽은 가득 차서 오고, 둘째 쪽부터 500이다.
    (v as any).rules.push({
      label: 'second-page-fails',
      match: (c: any) => c.path.includes(BOOK) && Number(c.params?.offset ?? 0) > 0,
      reply: { status: 500, json: { label: 'SERVER_ERROR' } },
    });
    v.on(BOOK, { json: () => page(300) });
    const r: any = await on(v, () => getGateAccountBook(KEY, SECRET, true));

    test('★ ⑤ 중간 쪽이 실패하면 앞 쪽만 들고 돌아가지 않는다', () => {
      eq(r, null, '부분 원장은 "덜 잃었다"가 되어 한도를 통과시킨다');
    });
  }

  // ══════════ ⑥ 200인데 배열이 아니다 ══════════
  {
    const v = new FakeVenue().on(BOOK, { json: { label: 'OK', message: 'fine' } });
    const r: any = await on(v, () => getGateAccountBook(KEY, SECRET, true));

    test('★ ⑥ 배열이 아닌 200 응답은 원장이 아니다', () => {
      eq(r, null);
    });
  }

  // ══════════ ⑦⑧⑨ 금액을 못 읽은 줄 ══════════
  //
  // `Number(null)`도 `Number('')`도 **0**이다. 그 0이 "손익 0"으로
  // 섞이면 실제 손실이 장부에서 사라진다. 조용히 건너뛰어도 같다 —
  // 그 줄이 큰 손실이었을 수 있다.
  for (const [label, bad] of [
    ['⑦ null', null], ['⑧ 빈 문자열', ''], ['⑨ undefined', undefined],
  ] as Array<[string, any]>) {
    const v = paged(new FakeVenue(), (o) => (o === 0
      ? [row('-1.0'), { ...row('0'), change: bad }] : []));
    const r: any = await on(v, () => getGateAccountBook(KEY, SECRET, true));

    test(`★ ${label} 금액은 0이 아니라 "못 읽음"이다`, () => {
      eq(r, null, '못 읽은 줄을 0으로 세면 손실이 장부에서 사라진다');
    });
  }

  // ══════════ ⑩ 시각을 못 읽은 줄 ══════════
  //
  // `Number(null) * 1000 = 0` → 1970년 → 오늘 집계에서 조용히 빠진다.
  {
    const v = paged(new FakeVenue(), (o) => (o === 0
      ? [row('-1.0'), { ...row('-900'), time: null }] : []));
    const r: any = await on(v, () => getGateAccountBook(KEY, SECRET, true));

    test('★ ⑩ 시각을 못 읽은 줄은 1970년이 아니라 "못 읽음"이다', () => {
      eq(r, null, '시각이 0이면 오늘 집계에서 빠져 손실이 사라진다');
    });
  }

  // ══════════ ⑪ 쪽 상한에 닿았다 ══════════
  {
    const v = new FakeVenue().on(BOOK, { json: () => page(300) });
    const r: any = await on(v, () => getGateAccountBook(KEY, SECRET, true));

    test('★ ⑪ 끝까지 가득 차면 불완전한 원장을 돌려주지 않는다', () => {
      eq(r, null, '다 읽지 못한 원장은 "덜 잃었다"가 된다');
      const n = v.countOf(BOOK);
      assert(n > 1 && n <= 20, `요청이 ${n}번 — 상한이 없거나 쪽을 안 넘긴다`);
    });
  }

  // ══════════ ⑫ 정상적인 음수 손실 ══════════
  {
    const v = paged(new FakeVenue(), (o) => (o === 0
      ? [row('-12.5'), row('-0.75', { type: 'fee' }), row('0.3', { type: 'fund' })] : []));
    const r: any = await on(v, () => getGateAccountBook(KEY, SECRET, true));

    test('★ ⑫ 음수 손실과 종류 매핑이 그대로다', () => {
      assert(Array.isArray(r), String(r));
      eq(r.length, 3);
      eq(r[0].income, -12.5);
      eq(r[1].incomeType, 'COMMISSION');
      eq(r[2].incomeType, 'FUNDING_FEE');
    });
  }
}
