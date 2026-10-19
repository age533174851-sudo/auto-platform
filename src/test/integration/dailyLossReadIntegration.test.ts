// src/test/integration/dailyLossReadIntegration.test.ts
//
// **원장에 못 읽은 줄이 있으면 오늘 한도를 "통과"로 적지 않는가.**
//
// 실제로 도는 것: `collectDailyLoss` → `getFuturesIncome` → 서명 생성 ·
//   질의 조립 · 응답 파싱 → `sumTodayIncome` → `judgeDailyLoss`.
//   가짜는 `fetch` 한 겹뿐이다.
//
// 왜 이것이 한도의 문제인가
// ─────────────────────────
// `dailyLossCheck`의 머리말이 이미 적고 있다: "income 조회가 실패하면
// `todayNetUsd: null`이다. 0으로 두면 '오늘 아무 거래도 없었다'가 되어
// **한도가 통째로 사라진다.**"
//
// 그 보호는 **조회 자체가 실패했을 때만** 걸렸다. 응답은 왔는데 그 안의
// 한 줄을 못 읽은 경우에는 `sumTodayIncome`이 조용히 건너뛰었고, 남은
// 줄의 합이 "오늘의 손익"으로 확정됐다. 건너뛴 줄이 큰 손실이면
// **덜 잃은 것으로 보이고 한도를 통과한다.**

import { test, eq, assert } from '../harness';
import { FakeVenue } from './venueHarness';
// 정적 import — 러너가 이 사슬을 컴파일 대상에 넣어야 한다.
import { collectDailyLoss } from '../../lib/risk/dailyLossCheck';
import { getFuturesIncome } from '../../lib/exchanges/binanceFutures';

const INCOME = '/fapi/v1/income';
const KEY = 'K'.repeat(64);
const SECRET = 'S'.repeat(64);

/** 오늘(UTC) 안의 시각 */
const todayMs = () => {
  const now = Date.now();
  return now - (now % 86_400_000) + 3_600_000;
};

/** 창 밀기 시험에서 쓰는 기준 시각 */
const BASE = todayMs();

const row = (income: unknown, over: Record<string, unknown> = {}) =>
  ({ symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income, asset: 'USDT',
     time: todayMs(), ...over });

/** 한도가 걸려 있는 환경 — 없으면 판정이 'ok'로 빠져 시험이 공허해진다 */
const ENV = (k: string): string | undefined =>
  (k === 'DAILY_MAX_LOSS_USD' ? '100' : undefined);

async function on<T>(v: FakeVenue, fn: () => Promise<T>): Promise<T> {
  const restore = v.install();
  try { return await fn(); } finally { restore(); }
}

const run = (v: FakeVenue) => on(v, () => collectDailyLoss({
  apiKey: KEY, apiSecret: SECRET, testnet: true,
  currentEquityUsd: 1000, env: ENV,
}));

export async function runDailyLossReadTests() {
  console.log('[통합 — 일일 손실 원장 읽기]');

  // ══════════ ① 정상 원장은 그대로 합산된다 ══════════
  {
    const v = new FakeVenue().on(INCOME, { json: [row('-10'), row('-5')] });
    const r: any = await run(v);

    test('★ ① 정상 원장은 합산되고 한도 판정이 선다', () => {
      eq(r.todayNetUsd, -15);
      eq(r.incomeCount, 2);
      assert(r.verdict.status !== 'unknown', `판정이 unknown이다: ${r.verdict.reason}`);
    });
  }

  // ══════════ ② 금액을 못 읽은 줄이 있으면 "오늘 손익"을 확정하지 않는다 ══════════
  //
  // `Number(null)`은 0이고 유한하다 — 예전에는 그 0이 합계에 들어가
  // **-5 한 건만 잃은 것처럼** 보였다.
  {
    const v = new FakeVenue().on(INCOME, { json: [row(null), row('-5')] });
    const r: any = await run(v);

    test('★ ② 못 읽은 줄이 있으면 todayNetUsd는 null이다', () => {
      eq(r.todayNetUsd, null, '못 읽은 줄을 빼고 합계를 확정했다');
      eq(r.verdict.status, 'unknown', '확인하지 못한 것은 통과가 아니다');
    });
  }

  // ══════════ ③ 시각을 못 읽은 줄도 같다 ══════════
  {
    const v = new FakeVenue().on(INCOME, { json: [row('-900', { time: null }), row('-5')] });
    const r: any = await run(v);

    test('★ ③ 시각을 못 읽은 줄도 한도를 확정하지 못하게 한다', () => {
      eq(r.todayNetUsd, null);
      eq(r.verdict.status, 'unknown');
    });
  }

  // ══════════ ④ 어제 줄은 정상적으로 빠진다 (②③이 과하지 않다) ══════════
  //
  // 정상적인 제외까지 '못 읽음'으로 세면 어제 거래가 있는 날마다
  // 한도가 unknown이 되어 진입이 영영 막힌다.
  {
    const v = new FakeVenue().on(INCOME, {
      json: [row('-500', { time: todayMs() - 86_400_000 }), row('-5')] });
    const r: any = await run(v);

    test('★ ④ 어제 줄을 거르는 것은 "못 읽음"이 아니다', () => {
      eq(r.todayNetUsd, -5);
      assert(r.verdict.status !== 'unknown', `판정이 unknown이다: ${r.verdict.reason}`);
    });
  }

  // ══════════ ⑤ 조회 자체가 실패하면 예전처럼 null이다 ══════════
  {
    const v = new FakeVenue().on(INCOME, { status: 500, json: { code: -1000, msg: 'down' } });
    const r: any = await run(v);

    test('★ ⑤ 조회 실패는 그대로 unknown이다', () => {
      eq(r.todayNetUsd, null);
      eq(r.verdict.status, 'unknown');
    });
  }
  // ══════════ ⑥ 1001번째 줄의 손실을 놓치지 않는다 ══════════
  //
  // 바이낸스 `/fapi/v1/income`의 `limit`은 **최대 1000**이다. 그리고
  // 문서가 적는 잘림 방식이 고약하다 — "startTime과 endTime 사이 데이터가
  // limit을 넘으면 **startTime+limit에서 잘린다**". 즉 **오래된 쪽
  // 1000건만 오고 최근 것이 잘린다.**
  //
  // 오늘 체결이 많은 날(100배 스캘핑은 줄이 금방 쌓인다) 그 잘린 쪽에
  // 큰 손실이 있으면, 일일 한도는 그것을 못 보고 통과한다.
  {
    const v = new FakeVenue();
    v.on(INCOME, { json: () => {
      const c = v.calls[v.calls.length - 1];
      const from = Number(c?.params?.startTime ?? 0);
      // 첫 창: 가득 찬 1000줄(각 -0.01). 다음 창: 큰 손실 한 줄.
      if (from <= BASE) {
        return Array.from({ length: 1000 }, (_, i) =>
          ({ ...row('-0.01'), tranId: i + 1, time: BASE + i }));
      }
      return [{ ...row('-5000'), tranId: 99999, time: BASE + 2000 }];
    } });
    const r: any = await on(v, () => getFuturesIncome(KEY, SECRET, true,
      { startTime: BASE, limit: 1000 }));

    test('★ ⑥ 창이 가득 차면 다음 창을 읽는다 (1001번째 손실)', () => {
      assert(Array.isArray(r), String(r));
      eq(r.length, 1001, '첫 창만 읽으면 큰 손실이 집계에서 빠진다');
      const total = r.reduce((s: number, x: any) => s + Number(x.income), 0);
      assert(Math.abs(total - (-5010)) < 1e-6, `합이 ${total}이다`);
    });
  }

  // ══════════ ⑦ 짧은 창이면 한 번으로 끝난다 ══════════
  {
    const v = new FakeVenue().on(INCOME, { json: [row('-1')] });
    const r: any = await on(v, () => getFuturesIncome(KEY, SECRET, true, { startTime: BASE }));

    test('★ ⑦ 흔한 계정은 요청 한 번이다', () => {
      assert(Array.isArray(r) && r.length === 1, String(r));
      eq(v.countOf(INCOME), 1);
    });
  }

  // ══════════ ⑧ 같은 줄을 두 번 세지 않는다 ══════════
  //
  // 다음 창의 시작을 **마지막 시각(포함)** 으로 잡으므로 경계의 줄이
  // 다시 온다. `tranId`로 걸러야 손익이 두 배로 적히지 않는다.
  {
    const v = new FakeVenue();
    v.on(INCOME, { json: () => {
      const c = v.calls[v.calls.length - 1];
      const from = Number(c?.params?.startTime ?? 0);
      if (from <= BASE) {
        return Array.from({ length: 1000 }, (_, i) =>
          ({ ...row('-0.01'), tranId: i + 1, time: BASE + i }));
      }
      // 경계 줄(tranId 1000)이 다시 온다 + 새 줄 하나
      return [
        { ...row('-0.01'), tranId: 1000, time: BASE + 999 },
        { ...row('-2'), tranId: 1001, time: BASE + 1500 },
      ];
    } });
    const r: any = await on(v, () => getFuturesIncome(KEY, SECRET, true,
      { startTime: BASE, limit: 1000 }));

    test('★ ⑧ 창 경계에서 겹쳐 온 줄을 두 번 세지 않는다', () => {
      assert(Array.isArray(r), String(r));
      eq(r.length, 1001, '중복이 섞였다');
    });
  }

  // ══════════ ⑨ 끝까지 가득 차면 불완전한 원장을 돌려주지 않는다 ══════════
  {
    let n = 0;
    const v = new FakeVenue().on(INCOME, { json: () => {
      const base = BASE + (n++) * 10_000;
      return Array.from({ length: 1000 }, (_, i) =>
        ({ ...row('-0.01'), tranId: `${base}-${i}`, time: base + i }));
    } });
    const r: any = await on(v, () => getFuturesIncome(KEY, SECRET, true,
      { startTime: BASE, limit: 1000 }));

    test('★ ⑨ 창 상한에 닿으면 null이다 (덜 읽은 원장을 주지 않는다)', () => {
      eq(r, null, '다 읽지 못한 원장은 "덜 잃었다"가 된다');
      const c = v.countOf(INCOME);
      assert(c > 1 && c <= 20, `요청 ${c}번 — 상한이 없거나 창을 안 민다`);
    });
  }

  // ══════════ ⑩ 비배열 응답은 그대로 null이다 ══════════
  {
    const v = new FakeVenue().on(INCOME, { json: { code: 200, msg: 'ok' } });
    const r: any = await on(v, () => getFuturesIncome(KEY, SECRET, true, { startTime: BASE }));

    test('★ ⑩ 배열이 아닌 응답은 원장이 아니다', () => { eq(r, null); });
  }
}
