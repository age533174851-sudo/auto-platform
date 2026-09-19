// src/lib/trading/candleSeries.test.ts
//
// **없는 봉을 만들지 않는지, 간격을 바꿀 때 섞이지 않는지 고정한다.**
import { test, eq, assert } from '../../test/harness';
import {
  barsToCandles, barsToVolumes, applyLivePrice, withLivePrice,
  isFreshResponse, candlesMatchInterval, UP_COLOR, DOWN_COLOR,
} from './candleSeries';

const MIN = 60_000;
const bars = (n: number, base = 100) => ({
  openTimes: Array.from({ length: n }, (_, i) => 1_700_000_000_000 + i * MIN),
  opens:   Array.from({ length: n }, (_, i) => base + i),
  highs:   Array.from({ length: n }, (_, i) => base + i + 2),
  lows:    Array.from({ length: n }, (_, i) => base + i - 2),
  closes:  Array.from({ length: n }, (_, i) => base + i + 1),
  volumes: Array.from({ length: n }, (_, i) => 10 + i),
});

export function runCandleSeriesTests() {
  // ── 변환 ──
  test('★ 시각은 초로 준다 — 밀리초를 그대로 주면 축이 5만 년 뒤로 간다', () => {
    const c = barsToCandles(bars(3));
    eq(c[0].time, 1_700_000_000);
    assert(c[0].time < 2_000_000_000, '밀리초가 그대로 들어갔습니다');
  });

  test('시간순으로 정렬한다', () => {
    const b = bars(3);
    b.openTimes.reverse(); b.opens.reverse(); b.highs.reverse();
    b.lows.reverse(); b.closes.reverse();
    const c = barsToCandles(b);
    assert(c[0].time < c[1].time && c[1].time < c[2].time, '정렬되지 않았습니다');
  });

  test('★ 읽을 수 없는 줄은 버린다 — 0으로 채우지 않는다', () => {
    const b: any = bars(3);
    b.closes[1] = NaN;
    const c = barsToCandles(b);
    eq(c.length, 2);
    assert(c.every(x => x.close > 0), '0이나 NaN 봉이 들어갔습니다');
  });

  test('음수·0 가격은 봉으로 만들지 않는다', () => {
    const b: any = bars(2);
    b.lows[0] = 0; b.opens[1] = -1;
    eq(barsToCandles(b).length, 0);
  });

  test('입력이 없어도 터지지 않는다', () => {
    eq(barsToCandles(null).length, 0);
    eq(barsToCandles(undefined).length, 0);
    eq(barsToCandles({} as any).length, 0);
  });

  // ── 거래량 ──
  test('거래량 색은 봉의 방향에서 온다', () => {
    const b = bars(2);
    b.closes[0] = b.opens[0] - 5;      // 음봉
    const v = barsToVolumes(b);
    eq(v[0].color, DOWN_COLOR);
    eq(v[1].color, UP_COLOR);
  });

  test('★ 거래량을 못 읽은 봉은 막대를 그리지 않는다 — 0은 "거래 없음"이 된다', () => {
    const b: any = bars(3);
    b.volumes[1] = NaN;
    const v = barsToVolumes(b);
    eq(v.length, 2);
    assert(v.every(x => Number.isFinite(x.value)), 'NaN 막대가 들어갔습니다');
  });

  // ── ★ 진행 중 봉 ──
  test('★ 현재가는 종가만 바꾼다 — 시가는 venue 값 그대로다', () => {
    const c = { time: 1, open: 100, high: 105, low: 95, close: 102 };
    const u = applyLivePrice(c, 103)!;
    eq(u.open, 100);
    eq(u.close, 103);
  });

  test('★ 고가는 넘을 때만 올린다 — 내리면 닿았던 가격이 지워진다', () => {
    const c = { time: 1, open: 100, high: 105, low: 95, close: 102 };
    eq(applyLivePrice(c, 101)!.high, 105);      // 안 넘으면 그대로
    eq(applyLivePrice(c, 110)!.high, 110);      // 넘으면 올린다
  });

  test('★ 저가는 밑돌 때만 내린다', () => {
    const c = { time: 1, open: 100, high: 105, low: 95, close: 102 };
    eq(applyLivePrice(c, 99)!.low, 95);
    eq(applyLivePrice(c, 90)!.low, 90);
  });

  test('★ 값을 못 읽으면 봉을 그대로 둔다 — 새로 만들지 않는다', () => {
    const c = { time: 1, open: 100, high: 105, low: 95, close: 102 };
    for (const p of [null, undefined, '', NaN, 0, -1, 'x']) {
      const u = applyLivePrice(c, p as any)!;
      eq(u.close, 102);
      eq(u.high, 105);
      eq(u.low, 95);
    }
  });

  test('봉이 없으면 null이다', () => {
    eq(applyLivePrice(null, 100), null);
    eq(applyLivePrice(undefined, 100), null);
  });

  // ── ★ 다음 봉을 만들지 않는다 ──
  test('★ 마지막 봉만 갱신하고 새 봉을 붙이지 않는다', () => {
    const c = barsToCandles(bars(5));
    const u = withLivePrice(c, 999);
    eq(u.length, c.length);                   // ← 개수가 늘지 않는다
    eq(u[u.length - 1].close, 999);
    eq(u[0].close, c[0].close);               // 과거는 그대로
  });

  test('★ 닫힌 봉은 현재가로 덮이지 않는다', () => {
    const c = barsToCandles(bars(5));
    const u = withLivePrice(c, 1);
    for (let i = 0; i < c.length - 1; i++) {
      eq(u[i].close, c[i].close);
      eq(u[i].high, c[i].high);
      eq(u[i].low, c[i].low);
    }
  });

  test('봉이 없으면 현재가만으로 봉을 만들지 않는다', () => {
    eq(withLivePrice([], 100).length, 0);
    eq(withLivePrice(null as any, 100).length, 0);
  });

  // ── ★ 간격 전환 ──
  test('★ 지금 세대가 아닌 응답은 버린다 — 1분 봉이 1시간 차트에 박히는 것을 막는다', () => {
    eq(isFreshResponse(3, 3), true);
    eq(isFreshResponse(2, 3), false);        // 늦게 도착한 옛 요청
    eq(isFreshResponse(4, 3), false);        // 있을 수 없지만 받아들이지 않는다
  });

  test('세대 번호가 숫자가 아니면 받아들이지 않는다', () => {
    eq(isFreshResponse(NaN, 3), false);
    eq(isFreshResponse(3, NaN), false);
    eq(isFreshResponse(undefined as any, 3), false);
  });

  test('★ 봉 간격이 기대와 다르면 잡아낸다 — venue가 엉뚱한 간격을 줘도', () => {
    const oneMin = barsToCandles(bars(10));
    eq(candlesMatchInterval(oneMin, 60_000), true);
    eq(candlesMatchInterval(oneMin, 3_600_000), false);
  });

  test('★ 판단할 수 없으면 통과로도 거부로도 적지 않는다', () => {
    eq(candlesMatchInterval(barsToCandles(bars(1)), 60_000), null);   // 봉 하나
    eq(candlesMatchInterval([], 60_000), null);
    eq(candlesMatchInterval(barsToCandles(bars(5)), null), null);
    eq(candlesMatchInterval(barsToCandles(bars(5)), 0), null);
  });

  test('빈 구간이 있어도 가장 흔한 간격으로 판단한다', () => {
    const c = barsToCandles(bars(10));
    c.splice(4, 1);                          // 거래소 점검으로 한 봉이 빈 상황
    eq(candlesMatchInterval(c, 60_000), true);
  });
}
