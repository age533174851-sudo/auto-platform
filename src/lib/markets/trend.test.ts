// src/lib/markets/trend.test.ts
//
// 막으려는 것:
//  1. 봉이 모자란데 있는 것만으로 계산해, 다른 기간의 지표를 같은
//     이름으로 쓰는 것
//  2. 기준선 근처에서 방향을 강제로 골라, 값이 흔들릴 때마다 추세가
//     뒤집히고 그 판정으로 주문이 나가는 것
//  3. 못 구한 것을 'RANGE'로 적어, 판정한 적 없는 것을 판정한 것처럼 만드는 것
import { test, assert, eq } from '../../test/harness';
import { trendOf } from './trend';

/** 일정하게 오르는 종가 */
const rising = (n: number, from = 100, step = 1) =>
  Array.from({ length: n }, (_, i) => from + i * step);
const falling = (n: number, from = 200, step = 1) =>
  Array.from({ length: n }, (_, i) => from - i * step);
const flat = (n: number, v = 100) => Array.from({ length: n }, () => v);

export function runTrendTests() {
  console.log('[추세 — 봉이 모자라면 판정하지 않는다]');

  test('기간보다 봉이 적으면 null이다', () => {
    // 있는 것만으로 계산하면 기간이 짧아진 평균이 나오는데,
    // 그건 다른 지표이지 짧은 버전이 아니다.
    const r = trendOf(rising(20), 50);
    eq(r.dir, null);
    assert(r.reason.includes('필요'), r.reason);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(trendOf(null).dir, null);
    eq(trendOf([]).dir, null);
    eq(trendOf(undefined).dir, null);
  });

  test('못 구한 것을 RANGE로 적지 않는다', () => {
    // RANGE는 '횡보'라는 판정이지 '모름'이 아니다. 섞으면 판정한 적
    // 없는 것을 판정한 것처럼 쓰게 된다.
    eq(trendOf(rising(10), 50).dir, null, 'RANGE가 아니라 null이어야 한다');
  });

  console.log('[추세 — 방향]');

  test('오르는 구간은 UP이다', () => {
    const r = trendOf(rising(120), 50);
    eq(r.dir, 'UP');
    assert((r.distancePct as number) > 0);
  });

  test('내리는 구간은 DOWN이다', () => {
    const r = trendOf(falling(120), 50);
    eq(r.dir, 'DOWN');
    assert((r.distancePct as number) < 0);
  });

  test('평평하면 RANGE다', () => {
    const r = trendOf(flat(120), 50);
    eq(r.dir, 'RANGE');
  });

  console.log('[추세 — 기준선 근처에서 뒤집히지 않는다]');

  test('밴드 안이면 RANGE로 둔다', () => {
    // 선 위/아래로만 가르면 값이 선 근처에서 흔들릴 때 추세가 매 봉
    // 뒤집히고, 그 판정으로 주문이 나간다.
    const closes = flat(120, 100);
    closes[closes.length - 1] = 100.2;   // 기준선 대비 +0.2%
    eq(trendOf(closes, 50, 0.5).dir, 'RANGE');
  });

  test('밴드를 넘으면 방향이 잡힌다', () => {
    const closes = flat(120, 100);
    closes[closes.length - 1] = 101;     // +1%
    eq(trendOf(closes, 50, 0.5).dir, 'UP');
  });

  test('밴드를 0으로 두면 예전처럼 선 하나로 가른다', () => {
    const closes = flat(120, 100);
    closes[closes.length - 1] = 100.01;
    eq(trendOf(closes, 50, 0).dir, 'UP', '밴드가 없으면 미세한 차이도 방향이 된다');
  });

  console.log('[추세 — 숏 검사와 이어진다]');

  test('상승 추세를 숏 검사에 넘기면 막힌다', async () => {
    // 이 값을 만들어 주는 곳이 없어서 그 검사는 **한 번도 돈 적이 없었다.**
    const { shortGuard } = await import('../engine/shortGuard');
    const t = trendOf(rising(120), 50);
    eq(t.dir, 'UP');
    const g = shortGuard({
      entryPrice: 64000, stopPrice: 64640, liquidationPrice: 70000,
      higherTrend: t.dir,
    });
    eq(g.allowed, false, '상승 추세에서 숏이 통과했다');
  });

  test('판정 못 한 추세는 숏을 막지 않는다', async () => {
    const { shortGuard } = await import('../engine/shortGuard');
    const t = trendOf(rising(10), 50);
    eq(t.dir, null);
    const g = shortGuard({
      entryPrice: 64000, stopPrice: 64640, liquidationPrice: 70000,
      higherTrend: t.dir,
    });
    eq(g.allowed, true, '못 읽었다고 막으면 조회가 흔들릴 때마다 숏이 멈춘다');
  });
}
