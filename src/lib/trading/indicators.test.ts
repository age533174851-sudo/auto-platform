// src/lib/trading/indicators.test.ts
//
// **토글만 있고 계산이 없는 지표가 없는지, 앞구간을 0으로 채우지 않는지.**
import { test, eq, assert } from '../../test/harness';
import {
  sma, ema, computeIndicator, indicatorSpec, indicatorAvailable, INDICATORS,
} from './indicators';
import type { Candle } from './candleSeries';

const C = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ time: 1000 + i * 60, open: c, high: c, low: c, close: c }));

export function runIndicatorsTests() {
  // ── 값이 맞는가 ──
  test('단순이동평균이 실제 평균이다', () => {
    const r = sma(C([1, 2, 3, 4, 5]), 3);
    eq(r.map(p => p.value).join(','), '2,3,4');
  });

  test('★ 기간이 안 찬 앞구간은 점이 없다 — 0으로 채우면 차트가 바닥을 찍는다', () => {
    const r = sma(C([1, 2, 3, 4, 5]), 3);
    eq(r.length, 3);                       // 5개 중 앞 2개는 점이 없다
    eq(r[0].time, C([1, 2, 3, 4, 5])[2].time);
    assert(r.every(p => p.value > 0), '0짜리 점이 들어갔습니다');
  });

  test('봉이 기간보다 적으면 아무 점도 만들지 않는다', () => {
    eq(sma(C([1, 2]), 5).length, 0);
    eq(ema(C([1, 2]), 5).length, 0);
  });

  test('지수이동평균은 첫 기간의 단순평균에서 시작한다', () => {
    const r = ema(C([2, 4, 6, 8]), 2);
    eq(r[0].value, 3);                     // (2+4)/2
    // k = 2/3 → 6*2/3 + 3*1/3 = 5
    assert(Math.abs(r[1].value - 5) < 1e-9, `두 번째 값이 다릅니다 (${r[1].value})`);
  });

  test('★ 같은 입력에 같은 값 — 결정적이다', () => {
    const c = C([3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]);
    eq(JSON.stringify(sma(c, 5)), JSON.stringify(sma(c, 5)));
    eq(JSON.stringify(ema(c, 5)), JSON.stringify(ema(c, 5)));
  });

  test('값이 일정하면 평균도 그 값이다', () => {
    const r = sma(C([7, 7, 7, 7, 7]), 3);
    assert(r.every(p => Math.abs(p.value - 7) < 1e-9), '상수 입력에서 평균이 어긋났습니다');
    const e = ema(C([7, 7, 7, 7, 7]), 3);
    assert(e.every(p => Math.abs(p.value - 7) < 1e-9), '상수 입력에서 EMA가 어긋났습니다');
  });

  // ── 못 읽은 값 ──
  test('★ 읽을 수 없는 봉이 나오면 거기서 멈춘다 — 구멍 난 창으로 평균을 만들지 않는다', () => {
    const c = C([1, 2, 3, 4, 5]);
    (c[3] as any).close = NaN;
    const r = sma(c, 3);
    assert(r.length <= 2, `NaN 뒤로도 점을 만들었습니다 (${r.length}개)`);
    assert(r.every(p => Number.isFinite(p.value)), 'NaN 점이 들어갔습니다');
  });

  test('입력이 없어도 터지지 않는다', () => {
    eq(sma(null as any, 3).length, 0);
    eq(ema(undefined as any, 3).length, 0);
    eq(sma(C([1, 2, 3]), 0).length, 0);
    eq(sma(C([1, 2, 3]), -1).length, 0);
    eq(ema(C([1, 2, 3]), NaN as any).length, 0);
  });

  // ── 목록 ──
  test('★ 목록에 있는 지표는 전부 실제로 계산된다', () => {
    const c = C(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 5));
    for (const s of INDICATORS) {
      const r = computeIndicator(s.id, c);
      assert(r.length > 0, `${s.id}가 아무 점도 만들지 않습니다 — 토글만 있는 지표입니다`);
      assert(r.every(p => Number.isFinite(p.value)), `${s.id}에 읽을 수 없는 점이 있습니다`);
    }
  });

  test('★ 모르는 지표는 지어내지 않는다', () => {
    const c = C([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const id of ['BOLL', 'SAR', 'SUPER', '', null, undefined]) {
      eq(computeIndicator(id, c).length, 0);
      eq(indicatorSpec(id), null);
      eq(indicatorAvailable(id, 1000), false);
    }
  });

  test('★ 그릴 수 없는 지표는 켤 수 없다', () => {
    eq(indicatorAvailable('MA25', 24), false);
    eq(indicatorAvailable('MA25', 25), true);
    eq(indicatorAvailable('EMA26', 10), false);
    eq(indicatorAvailable('MA7', NaN as any), false);
  });

  test('지표마다 색이 다르다 — 겹치면 어느 선인지 알 수 없다', () => {
    eq(new Set(INDICATORS.map(s => s.color)).size, INDICATORS.length);
    eq(new Set(INDICATORS.map(s => s.id)).size, INDICATORS.length);
  });

  test('첫 완성판은 MA·EMA만이다 — 사진에 있다고 억지로 늘리지 않았다', () => {
    eq(INDICATORS.length, 4);
    assert(INDICATORS.every(s => s.kind === 'MA' || s.kind === 'EMA'),
      'MA·EMA 밖의 지표가 목록에 있습니다');
  });
}
