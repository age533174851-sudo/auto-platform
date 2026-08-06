// src/lib/signals/signalPath.test.ts
//
// 막으려는 것:
//  1. 봉의 종가만 써서 손절이 꼬리에 닿은 것을 못 보는 것
//     — 그러면 성적은 언제나 좋아진다
//  2. 방향마다 봉 안의 순서를 바꿔 두 다리가 다른 경로를 보는 것
//     — 그러면 순방향·역방향 비교 자체가 성립하지 않는다
//  3. 구간이 모자란데 있는 데까지만 돌려, 일어난 적 없는 시점의 가격으로
//     청산하는 것
//  4. 값을 못 읽은 봉을 종가로 채워 그 봉의 손절을 지우는 것
import { test, assert, eq } from '../../test/harness';
import { barsToPath, windowFor, pathCovers, buildSignalPath, type Bar } from './signalPath';

const STEP = 60_000;   // 1분봉
const T0 = Date.UTC(2026, 0, 1);

const bar = (i: number, o: number, h: number, l: number, c: number): Bar =>
  ({ openTime: T0 + i * STEP, open: o, high: h, low: l, close: c });

export function runSignalPathTests() {
  console.log('[신호 경로 — 봉을 점으로 펴기]');

  test('봉 하나가 네 점이 된다', () => {
    const p = barsToPath([bar(0, 100, 103, 98, 101)], STEP);
    eq(p.length, 4);
    eq(p[0].price, 100, '시가');
    eq(p[1].price, 98, '저가');
    eq(p[2].price, 103, '고가');
    eq(p[3].price, 101, '종가');
  });

  test('저가가 언제나 고가보다 먼저다 — 방향에 따라 바꾸지 않는다', () => {
    // 방향마다 순서를 바꾸면 순방향과 역방향이 다른 경로를 보게 되고,
    // 그러면 두 다리를 비교하는 것 자체가 뜻을 잃는다.
    const p = barsToPath([bar(0, 100, 110, 90, 105)], STEP);
    const iLow = p.findIndex(x => x.price === 90);
    const iHigh = p.findIndex(x => x.price === 110);
    assert(iLow < iHigh, '저가가 먼저여야 두 다리가 같은 배열을 본다');
  });

  test('네 점의 시각이 봉 안에서 흩어진다', () => {
    // 전부 openTime이면 최대 보유시간 판정이 봉 단위로 뭉뚝해진다.
    const p = barsToPath([bar(0, 100, 103, 98, 101)], STEP);
    for (let i = 1; i < p.length; i++) {
      assert(p[i].t > p[i - 1].t, `시각이 안 늘어난다 (${p[i - 1].t} → ${p[i].t})`);
      assert(p[i].t < T0 + STEP, '다음 봉을 침범하면 안 된다');
    }
  });

  test('종가만 보면 안 보이는 손절이 경로에는 있다', () => {
    // 시가 100 → 저가 95 → 종가 100. 종가만 쓰면 아무 일도 없었던 봉이다.
    const p = barsToPath([bar(0, 100, 100, 95, 100)], STEP);
    assert(p.some(x => x.price === 95), '꼬리가 경로에 없다 — 손절이 사라진다');
  });

  console.log('[신호 경로 — 못 읽은 봉]');

  test('값을 못 읽은 봉은 종가로 채우지 않고 건너뛴다', () => {
    const bad: any = { openTime: T0, open: 100, high: NaN, low: 98, close: 100 };
    const p = barsToPath([bad, bar(1, 100, 101, 99, 100)], STEP);
    eq(p.length, 4, '못 읽은 봉을 채우면 그 봉의 손절이 사라진다');
  });

  test('고가가 저가보다 낮은 봉은 버린다', () => {
    const p = barsToPath([bar(0, 100, 95, 105, 100)], STEP);
    eq(p.length, 0, '뒤집힌 봉은 데이터가 깨진 것이다');
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(barsToPath(null, STEP).length, 0);
    eq(barsToPath([], STEP).length, 0);
    eq(barsToPath([bar(0, 1, 1, 1, 1)], 0).length, 4, '간격을 몰라도 점은 만든다');
  });

  console.log('[신호 경로 — 구간]');

  test('구간은 발언 앞뒤로 한 봉씩 여유를 준다', () => {
    const w = windowFor(T0, 30, 3600, STEP);
    assert(w != null);
    eq(w!.startMs, T0 - STEP, '발언이 봉 중간이면 그 봉이 통째로 빠진다');
    eq(w!.endMs, T0 + (30 + 3600) * 1000 + STEP);
  });

  test('발언 시각이 없으면 구간을 만들지 않는다', () => {
    eq(windowFor(NaN as any, 30, 3600, STEP), null);
    eq(windowFor(0, 30, 3600, STEP), null);
  });

  console.log('[신호 경로 — 끝까지 채점할 수 있는가]');

  test('최대 보유시간을 덮으면 통과', () => {
    const bars = [];
    for (let i = 0; i < 70; i++) bars.push(bar(i, 100, 101, 99, 100));
    const c = pathCovers(barsToPath(bars, STEP), T0, 30, 3600);
    eq(c.covers, true, c.reason);
  });

  test('모자라면 있는 데까지 돌리지 않고 그렇다고 말한다', () => {
    // 10분치 봉으로 1시간 보유를 채점할 수 없다. 그런데 그냥 돌리면
    // '시간 청산'으로 기록되고, 그 손익은 일어난 적 없는 시점의 것이다.
    const bars = [];
    for (let i = 0; i < 10; i++) bars.push(bar(i, 100, 101, 99, 100));
    const c = pathCovers(barsToPath(bars, STEP), T0, 30, 3600);
    eq(c.covers, false);
    assert(c.reason.includes('모자랍니다'), c.reason);
    assert(c.reason.includes('일어난 적 없는'), c.reason);
  });

  test('빈 경로는 덮지 못한 것이다', () => {
    eq(pathCovers([], T0, 30, 3600).covers, false);
    eq(pathCovers(null, T0, 30, 3600).covers, false);
  });

  console.log('[신호 경로 — 한 번에]');

  test('buildSignalPath가 셋을 한 번에 한다', () => {
    const bars = [];
    for (let i = 0; i < 70; i++) bars.push(bar(i, 100, 101, 99, 100));
    const r = buildSignalPath(bars, { saidAtMs: T0, delaySec: 30, maxHoldSec: 3600, intervalMs: STEP });
    eq(r.covers, true, r.error);
    eq(r.error, '');
    assert(r.path.length > 0);
  });

  test('모자라면 경로는 주되 사유를 함께 남긴다', () => {
    // 경로를 버리지 않는다 — 화면이 "얼마나 모자란지"를 보여줄 수 있어야
    // 사용자가 캔들 보관 기간 문제인지 수집 실패인지 가른다.
    const bars = [];
    for (let i = 0; i < 5; i++) bars.push(bar(i, 100, 101, 99, 100));
    const r = buildSignalPath(bars, { saidAtMs: T0, delaySec: 30, maxHoldSec: 3600, intervalMs: STEP });
    eq(r.covers, false);
    assert(r.path.length > 0, '경로 자체는 남아야 한다');
    assert(r.error.length > 0);
  });

  test('봉을 하나도 못 읽으면 그렇다고 말한다', () => {
    const r = buildSignalPath([], { saidAtMs: T0, delaySec: 30, maxHoldSec: 3600, intervalMs: STEP });
    eq(r.covers, false);
    assert(r.error.includes('읽지 못했습니다'), r.error);
  });
}
