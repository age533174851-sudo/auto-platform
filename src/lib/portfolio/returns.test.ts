// src/lib/portfolio/returns.test.ts
//
// 막으려는 것:
//  1. **입출금 때문에 수익률이 왜곡되는 것.** 90만에서 −10%, 990만에서
//     +10%를 낸 사람의 성적이 "+8.9%"로 뜨면, 그건 매매 실력이 아니라
//     큰돈을 좋은 구간에 넣은 결과다
//  2. 돈이 없던 구간을 1로 치고 넘어가는 것 — 파산이 성적에서 사라진다
//  3. 계산 못 한 것을 0%로 돌려주는 것. 0%는 '본전'이지 '모름'이 아니다
//  4. 수수료를 모르는데 0으로 더해 순손익을 좋게 만드는 것
//  5. XIRR이 발산했는데 그 숫자를 그냥 화면에 띄우는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  timeWeightedReturn, moneyWeightedReturn, naiveCheck, pnlBreakdown,
  NAIVE_GAP_WARN_PP,
} from './returns';

const DAY = 86_400_000;

export function runPortfolioReturnsTests() {
  console.log('[수익률 — 입출금이 성적을 흔들면 안 된다]');

  test('입출금이 없으면 그냥 잔고 증가율이다', () => {
    const r = timeWeightedReturn([{ startValue: 100, flow: 0, endValue: 110 }]);
    close(r.pct!, 10, 1e-9);
  });

  test('중간에 큰돈을 넣어도 전략 성적은 안 바뀐다', () => {
    // 1월 100만 → 90만 (−10%)
    // 2월 900만 더 넣어 990만 → 1,089만 (+10%)
    // 잔고로 보면 1,000만 → 1,089만 = +8.9%인데,
    // **이 사람의 매매는 −10%와 +10%를 낸 것이다.**
    const r = timeWeightedReturn([
      { startValue: 1_000_000, flow: 0, endValue: 900_000, label: '1월' },
      { startValue: 900_000, flow: 9_000_000, endValue: 10_890_000, label: '2월' },
    ]);
    // 0.9 × 1.1 = 0.99 → −1%
    close(r.pct!, -1, 1e-9);
    assert(r.pct! < 0, '입출금 효과가 섞이면 여기가 양수가 된다');
  });

  test('출금도 성적을 흔들지 않는다', () => {
    const r = timeWeightedReturn([
      { startValue: 100, flow: 0, endValue: 120 },
      { startValue: 120, flow: -60, endValue: 66 },
    ]);
    // 1.2 × (66/60) = 1.32 → +32%
    close(r.pct!, 32, 1e-9);
  });

  test('돈이 없던 구간을 1로 치고 넘기지 않는다', () => {
    // 그러면 파산 구간이 성적에서 조용히 사라진다.
    const r = timeWeightedReturn([
      { startValue: 100, flow: 0, endValue: 0, label: '파산' },
      { startValue: 0, flow: 0, endValue: 0, label: '이후' },
    ]);
    eq(r.pct, null);
    assert(r.reason.includes("'이후' 구간"), r.reason);
    assert(r.reason.includes('0 이하'), r.reason);
  });

  test('평가액을 못 읽으면 0%가 아니라 null이다', () => {
    const r = timeWeightedReturn([{ startValue: 100, flow: 0, endValue: null as any }]);
    eq(r.pct, null);
    assert(r.reason.includes('읽지 못했'), r.reason);
  });

  test('구간이 없으면 없다고 한다', () => {
    eq(timeWeightedReturn([]).pct, null);
    eq(timeWeightedReturn(null).pct, null);
  });

  console.log('[수익률 — 내 지갑의 성적 (MWR)]');

  test('1년 뒤 10% 늘면 연 10%다', () => {
    const r = moneyWeightedReturn([
      { atMs: 0, amount: -100 },
      { atMs: 365 * DAY, amount: 110 },
    ]);
    close(r.pct!, 10, 0.01);
  });

  test('반년 만에 10% 늘면 연율은 그보다 크다', () => {
    const r = moneyWeightedReturn([
      { atMs: 0, amount: -100 },
      { atMs: 182.5 * DAY, amount: 110 },
    ]);
    assert(r.pct! > 20, `연율 ${r.pct}`);
    close(r.pct!, 21, 0.5);
  });

  test('중간 입금이 시점까지 반영된다', () => {
    // TWR과 달리 MWR은 언제 넣었는지가 결과를 바꾼다 — 그게 이 지표의 뜻이다.
    const early = moneyWeightedReturn([
      { atMs: 0, amount: -100 },
      { atMs: 30 * DAY, amount: -100 },
      { atMs: 365 * DAY, amount: 230 },
    ]);
    const late = moneyWeightedReturn([
      { atMs: 0, amount: -100 },
      { atMs: 300 * DAY, amount: -100 },
      { atMs: 365 * DAY, amount: 230 },
    ]);
    assert(early.pct! < late.pct!, `이른 입금 ${early.pct} vs 늦은 입금 ${late.pct}`);
  });

  test('부호가 한쪽뿐이면 0%가 아니라 계산 불가다', () => {
    // 0%는 '본전'이라는 뜻이고, 여기는 '해가 없다'는 뜻이다.
    const r = moneyWeightedReturn([
      { atMs: 0, amount: -100 },
      { atMs: 365 * DAY, amount: -100 },
    ]);
    eq(r.pct, null);
    assert(r.reason.includes('둘 다 있어야'), r.reason);
  });

  test('같은 날 흐름만 있으면 연율이 없다', () => {
    const r = moneyWeightedReturn([
      { atMs: 1000, amount: -100 },
      { atMs: 1000, amount: 110 },
    ]);
    eq(r.pct, null);
    assert(r.reason.includes('기간이 없으면'), r.reason);
  });

  test('흐름이 모자라면 지어내지 않는다', () => {
    eq(moneyWeightedReturn([{ atMs: 0, amount: -100 }]).pct, null);
    eq(moneyWeightedReturn([]).pct, null);
    eq(moneyWeightedReturn(null).pct, null);
  });

  test('같은 입력은 같은 답을 낸다', () => {
    const flows = [
      { atMs: 0, amount: -1000 },
      { atMs: 100 * DAY, amount: -500 },
      { atMs: 365 * DAY, amount: 1700 },
    ];
    eq(moneyWeightedReturn(flows).pct, moneyWeightedReturn(flows).pct);
  });

  test('전액 손실도 답을 낸다', () => {
    const r = moneyWeightedReturn([
      { atMs: 0, amount: -100 },
      { atMs: 365 * DAY, amount: 1 },
    ]);
    assert(r.pct! < -90, `${r.pct}`);
  });

  console.log('[수익률 — 단순 수익률을 언제 믿어도 되는가]');

  test('입출금이 없으면 단순 수익률을 그냥 써도 된다', () => {
    const twr = timeWeightedReturn([{ startValue: 100, flow: 0, endValue: 110 }]);
    const mwr = moneyWeightedReturn([{ atMs: 0, amount: -100 }, { atMs: 365 * DAY, amount: 110 }]);
    const c = naiveCheck(100, 110, twr, mwr);
    eq(c.safeToShowNaive, true);
    close(c.naivePct!, 10, 1e-9);
    eq(c.reason, '');
  });

  test('벌어지면 그 차이가 입출금 탓이라고 말한다', () => {
    const twr = timeWeightedReturn([
      { startValue: 1_000_000, flow: 0, endValue: 900_000 },
      { startValue: 900_000, flow: 9_000_000, endValue: 10_890_000 },
    ]);
    const mwr = moneyWeightedReturn([
      { atMs: 0, amount: -1_000_000 },
      { atMs: 30 * DAY, amount: -9_000_000 },
      { atMs: 60 * DAY, amount: 10_890_000 },
    ]);
    const c = naiveCheck(10_000_000, 10_890_000, twr, mwr);
    eq(c.safeToShowNaive, false);
    assert(c.gapPp! >= NAIVE_GAP_WARN_PP, String(c.gapPp));
    assert(c.reason.includes('입출금 시점이 만든 것'), c.reason);
  });

  test('TWR을 못 냈으면 단순 수익률이 맞는지 확인 못 한 것이다', () => {
    // 확인하지 못한 것은 통과가 아니다.
    const twr = timeWeightedReturn([]);
    const mwr = moneyWeightedReturn([]);
    const c = naiveCheck(100, 110, twr, mwr);
    eq(c.safeToShowNaive, false);
    assert(c.reason.includes('확인할 수 없습니다'), c.reason);
  });

  test('넣은 돈을 모르면 단순 수익률도 없다', () => {
    const c = naiveCheck(null, 110, timeWeightedReturn([]), moneyWeightedReturn([]));
    eq(c.naivePct, null);
    eq(c.safeToShowNaive, false);
  });

  console.log('[수익률 — 비용을 모르는데 0으로 더하지 않는다]');

  test('네 항목이 다 있으면 비용 전/후를 낸다', () => {
    const b = pnlBreakdown({ realized: 1000, unrealized: 400, fees: 210, funding: 90 });
    eq(b.beforeCost, 1400);
    eq(b.costTotal, 300);
    eq(b.afterCost, 1100);
    eq(b.missing.length, 0);
  });

  test('수수료를 모르면 합계를 내지 않는다', () => {
    // 0으로 치고 더하면 순손익이 언제나 실제보다 좋게 나온다.
    const b = pnlBreakdown({ realized: 1000, unrealized: 400, funding: 90 });
    eq(b.afterCost, null);
    eq(b.beforeCost, null);
    assert(b.missing.includes('수수료'), b.missing.join(','));
    assert(b.reason.includes('좋게 나옵니다'), b.reason);
  });

  test('모르는 항목을 전부 이름으로 적는다', () => {
    const b = pnlBreakdown({});
    eq(b.missing.length, 4);
    for (const k of ['실현손익', '미실현손익', '수수료', '펀딩비']) {
      assert(b.missing.includes(k), b.missing.join(','));
    }
  });

  test('진짜 0은 모름이 아니다', () => {
    const b = pnlBreakdown({ realized: 0, unrealized: 0, fees: 0, funding: 0 });
    eq(b.missing.length, 0);
    eq(b.afterCost, 0);
  });

  test('비용이 이익보다 크면 순손익이 음수로 나온다', () => {
    const b = pnlBreakdown({ realized: 100, unrealized: 0, fees: 210, funding: 90 });
    eq(b.afterCost, -200);
  });
}
