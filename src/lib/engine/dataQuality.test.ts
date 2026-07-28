// src/lib/engine/dataQuality.test.ts
//
// 가장 중요한 것은 "모의·추정이 실시간과 같은 모양으로 나오지 않는다"이다.
// 호가창이 Math.random() 값을 실시간처럼 보여주던 것이 실제 사례였다.
import { test, assert, eq } from '../../test/harness';
import { assess, badgeStyle, formatAge, worst, type DataKind } from './dataQuality';

const NOW = 1_700_000_000_000;

export function runDataQualityTests() {
  console.log('[데이터 품질 — 모의·추정 구분]');

  test('모의 값은 아무리 새것이어도 실전 근거가 아니다', () => {
    const a = assess({ kind: 'SIMULATED', origin: '앱 내부', asOf: NOW }, NOW);
    eq(a.freshness, 'FRESH', '나이 자체는 신선하다');
    eq(a.tradeable, false, '모의 값이 실전 판단 근거로 통과했다');
  });

  test('AI 추정도 실전 근거가 아니다', () => {
    eq(assess({ kind: 'ESTIMATED', origin: 'AI', asOf: NOW }, NOW).tradeable, false);
  });

  test('모의·추정·실시간은 서로 다른 모양이다', () => {
    const shapes = (['REALTIME', 'SIMULATED', 'ESTIMATED'] as DataKind[])
      .map(kind => badgeStyle(assess({ kind, origin: 'x', asOf: NOW }, NOW)).shape);
    eq(new Set(shapes).size, 3, '색만 다르면 빠르게 훑을 때 구분되지 않는다');
  });

  test('주기 수신(REST)은 실시간과 같은 모양을 쓰지 않는다', () => {
    const rt = badgeStyle(assess({ kind: 'REALTIME', origin: 'Binance', asOf: NOW }, NOW));
    const pl = badgeStyle(assess({ kind: 'POLLED', origin: 'Binance', asOf: NOW }, NOW));
    assert(rt.shape !== pl.shape, '5초마다 당겨오는 값이 실시간처럼 보인다');
  });

  console.log('[데이터 품질 — 신선도]');

  test('갱신 주기가 다르면 기준도 다르다', () => {
    // 2초 지난 값: 100ms 주기에서는 멈춘 것이고, 5초 주기에서는 정상이다
    const fast = assess({ kind: 'REALTIME', origin: 'x', asOf: NOW - 2000, expectedIntervalMs: 100 }, NOW);
    const slow = assess({ kind: 'POLLED', origin: 'x', asOf: NOW - 2000, expectedIntervalMs: 5000 }, NOW);
    eq(fast.freshness, 'STALE');
    eq(slow.freshness, 'FRESH', '느린 값에 빠른 기준을 적용했다');
  });

  test('지연과 멈춤을 구분한다', () => {
    const iv = 1000;
    eq(assess({ kind: 'REALTIME', origin: 'x', asOf: NOW - 4000, expectedIntervalMs: iv }, NOW).freshness, 'LAGGING');
    eq(assess({ kind: 'REALTIME', origin: 'x', asOf: NOW - 20000, expectedIntervalMs: iv }, NOW).freshness, 'STALE');
  });

  test('멈춘 값은 실전 근거가 아니다', () => {
    const a = assess({ kind: 'REALTIME', origin: 'Binance', asOf: NOW - 60_000, expectedIntervalMs: 100 }, NOW);
    eq(a.tradeable, false, '멈춘 호가를 보고 진입 판단을 하게 된다');
  });

  console.log('[데이터 품질 — 없음과 오래됨의 구분]');

  test('시각을 모르는 값은 신선한 것으로 통과하지 않는다', () => {
    const a = assess({ kind: 'REALTIME', origin: 'Binance', asOf: null }, NOW);
    eq(a.freshness, 'NONE', '출처 시각이 없는데 실시간으로 봤다');
    eq(a.ageMs, null);
    eq(a.tradeable, false);
  });

  test('수신 없음은 멈춤과 다른 상태다', () => {
    const none = assess({ kind: 'UNAVAILABLE', origin: 'Binance', asOf: null }, NOW);
    const stale = assess({ kind: 'REALTIME', origin: 'Binance', asOf: NOW - 999_999, expectedIntervalMs: 100 }, NOW);
    eq(none.freshness, 'NONE');
    eq(stale.freshness, 'STALE');
    assert(none.text !== stale.text, '두 상태가 같은 문구로 나온다');
  });

  console.log('[데이터 품질 — 표기]');

  test('나이를 단위에 맞게 적는다', () => {
    eq(formatAge(81), '81ms 전');
    eq(formatAge(3_400), '3초 전');
    eq(formatAge(120_000), '2분 전');
    eq(formatAge(null), '시각 미상');
  });

  test('한 줄에 값·출처·성격·나이가 모두 들어간다', () => {
    const a = assess({ kind: 'REALTIME', origin: 'Binance', label: 'Mark Price', asOf: NOW - 81 }, NOW);
    for (const piece of ['Mark Price', 'Binance', '실시간', '81ms 전']) {
      assert(a.text.includes(piece), `'${piece}'가 빠졌다: ${a.text}`);
    }
  });

  test('여러 값 중 가장 나쁜 것을 고른다', () => {
    const list = [
      assess({ kind: 'REALTIME', origin: 'a', asOf: NOW }, NOW),
      assess({ kind: 'REALTIME', origin: 'b', asOf: NOW - 60_000, expectedIntervalMs: 100 }, NOW),
      assess({ kind: 'POLLED', origin: 'c', asOf: NOW }, NOW),
    ];
    eq(worst(list)?.freshness, 'STALE', '하나라도 문제면 문제로 봐야 한다');
    eq(worst([]), null);
  });
}
