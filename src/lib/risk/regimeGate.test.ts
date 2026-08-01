// src/lib/risk/regimeGate.test.ts
//
// 막으려는 것: **시세를 못 받은 것이 '진입 허용'으로 새는 것.**
//
// 예전 detectRegime은 봉이 0개여도 '횡보 · 저변동 · allowEntry=true'를
// 돌려줬다. 필터를 켜 뒀는데 시세 조회가 실패하면 필터가 통째로 사라졌고,
// 화면에는 '횡보장'이라고 떠 있었다 — 관측이 아니라 계산을 못 한 것인데.

import { test, eq, assert } from '../../test/harness';
import { detectRegime, regimeAllowsEntry, REGIME_MIN_BARS } from './regime';
import { judgeRegime, readRegimeFilter } from './regimeGate';

/** 꾸준히 오르는 봉 — 상승 추세 */
const up = (n = 120) => Array.from({ length: n }, (_, i) => 50_000 * (1 + i * 0.004));
/** 꾸준히 내리는 봉 */
const down = (n = 120) => Array.from({ length: n }, (_, i) => 80_000 * (1 - i * 0.004));
/** 좁게 오가는 봉 — 횡보 */
const flat = (n = 120) => Array.from({ length: n }, (_, i) => 60_000 + (i % 2 ? 60 : -60));
/** 크게 튀는 봉 — 고변동 */
const wild = (n = 120) => Array.from({ length: n }, (_, i) => 60_000 * (1 + (i % 2 ? 0.06 : -0.06)));

export function runRegimeGateTests() {
  console.log('[국면 — 데이터가 모자랄 때]');

  test('봉이 없으면 판정하지 않는다 — 예전에는 "횡보 · 진입 허용"이었다', () => {
    const r = detectRegime([]);
    eq(r.dataOk, false);
    eq(r.allowEntry, false, '시세를 못 받은 것이 허용이 되면 필터가 사라진다');
    eq(r.label, '판정 불가');
  });

  test(`${REGIME_MIN_BARS}개 미만이면 전부 판정 불가`, () => {
    for (const n of [1, 10, REGIME_MIN_BARS - 1]) {
      const r = detectRegime(up(n));
      eq(r.dataOk, false, `${n}개로 판정했다`);
      assert(r.dataReason.includes(String(n)), `몇 개인지 적어야 한다: ${r.dataReason}`);
    }
  });

  test(`${REGIME_MIN_BARS}개부터는 판정한다`, () => {
    eq(detectRegime(up(REGIME_MIN_BARS)).dataOk, true);
  });

  test('숫자가 아닌 값은 세지 않는다 — 빈 칸이 봉으로 잡히면 안 된다', () => {
    const bad = [...up(REGIME_MIN_BARS - 1), NaN, 0, -5] as number[];
    eq(detectRegime(bad).dataOk, false);
  });

  test('판정 못 한 국면은 게이트가 막는다', () => {
    const r = detectRegime([]);
    const g = regimeAllowsEntry(r, 'buy');
    eq(g.allowed, false);
    assert(g.reason.includes('판정하지 못'), `이유를 적어야 한다: ${g.reason}`);
  });

  console.log('[국면 — 판정]');

  test('상승·하락·횡보를 구분한다', () => {
    eq(detectRegime(up()).trend, 'uptrend');
    eq(detectRegime(down()).trend, 'downtrend');
    eq(detectRegime(flat()).trend, 'sideways');
  });

  test('크게 튀면 고변동으로 잡는다', () => {
    eq(detectRegime(wild()).volatility, 'high_vol');
  });

  console.log('[국면 게이트 — 필터 강도]');

  test('필터가 꺼져 있으면 막지 않는다 — 보지 않기로 한 검사가 주문을 막으면 안 된다', () => {
    const v = judgeRegime(wild(), 'LONG', 'off');
    eq(v.blockEntries, false);
    eq(v.status, 'ok');
    assert(v.reason.includes('참고용'), `꺼져 있음을 알려야 한다: ${v.reason}`);
  });

  test('꺼져 있어도 국면은 알려준다', () => {
    const v = judgeRegime(up(), 'LONG', 'off');
    assert(v.regime != null && v.regime.trend === 'uptrend', '국면을 비워 돌려줬다');
  });

  test("'any'는 고변동장을 막는다", () => {
    const v = judgeRegime(wild(), 'LONG', 'any');
    eq(v.blockEntries, true);
    eq(v.status, 'blocked');
  });

  test("'any'는 역추세 진입을 막는다", () => {
    eq(judgeRegime(down(), 'LONG', 'any').blockEntries, true);   // 하락장 롱
    eq(judgeRegime(up(), 'SHORT', 'any').blockEntries, true);    // 상승장 숏
  });

  test("'any'는 추세 방향 진입을 통과시킨다", () => {
    eq(judgeRegime(up(), 'LONG', 'any').blockEntries, false);
    eq(judgeRegime(down(), 'SHORT', 'any').blockEntries, false);
  });

  test("'trend_only'는 횡보장을 막는다", () => {
    eq(judgeRegime(flat(), 'LONG', 'trend_only').blockEntries, true);
    eq(judgeRegime(up(), 'LONG', 'trend_only').blockEntries, false);
  });

  test("'range_only'는 추세장을 막는다", () => {
    eq(judgeRegime(up(), 'LONG', 'range_only').blockEntries, true);
    eq(judgeRegime(flat(), 'LONG', 'range_only').blockEntries, false);
  });

  console.log('[국면 게이트 — 모르는 것]');

  test('필터가 켜져 있는데 시세를 못 받으면 막는다', () => {
    for (const c of [null, undefined, [], up(10)]) {
      const v = judgeRegime(c as number[], 'LONG', 'any');
      eq(v.status, 'unknown', `${JSON.stringify(c)?.slice(0, 20)}가 판정됐다`);
      eq(v.blockEntries, true);
    }
  });

  test('필터가 꺼져 있으면 시세를 못 받아도 막지 않는다', () => {
    const v = judgeRegime([], 'LONG', 'off');
    eq(v.status, 'unknown');
    eq(v.blockEntries, false);
  });

  console.log('[국면 게이트 — 설정 읽기]');

  const envOf = (o: Record<string, string>) => (k: string) => o[k];

  test('기본은 꺼짐 — 전략의 신호를 조용히 거부하기 시작하면 다른 전략이 된다', () => {
    eq(readRegimeFilter(envOf({})).mode, 'off');
    eq(readRegimeFilter(envOf({ REGIME_FILTER: '' })).mode, 'off');
  });

  test('아는 값은 그대로 쓴다 (대소문자·공백 무시)', () => {
    eq(readRegimeFilter(envOf({ REGIME_FILTER: 'any' })).mode, 'any');
    eq(readRegimeFilter(envOf({ REGIME_FILTER: ' TREND_ONLY ' })).mode, 'trend_only');
  });

  test('모르는 값은 끄되 그 사실을 남긴다 — 조용히 무시하면 오타를 영원히 모른다', () => {
    const r = readRegimeFilter(envOf({ REGIME_FILTER: 'trendonly' }));
    eq(r.mode, 'off');
    assert(r.note.includes('알 수 없는'), `오타를 알려야 한다: ${r.note}`);
    assert(r.note.includes('trend_only'), '가능한 값을 적어야 한다');
  });
}
