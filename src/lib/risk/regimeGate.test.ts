// src/lib/risk/regimeGate.test.ts
//
// 막으려는 것: **시세를 못 받은 것이 '진입 허용'으로 새는 것.**
//
// 예전 detectRegime은 봉이 0개여도 '횡보 · 저변동 · allowEntry=true'를
// 돌려줬다. 필터를 켜 뒀는데 시세 조회가 실패하면 필터가 통째로 사라졌고,
// 화면에는 '횡보장'이라고 떠 있었다 — 관측이 아니라 계산을 못 한 것인데.

import { test, eq, assert } from '../../test/harness';
import {
  detectRegime, regimeAllowsEntry, regimeFromSnapshot,
  REGIME_MIN_BARS, REGIME_VIEW_WINDOW,
} from './regime';
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

  console.log('[국면 관측값(view) — 전략이 읽는 재료]');

  // ★ 여기부터가 이번에 넓힌 것. detectRegime은 price·ema20·ema60·atr을
  //   **이미 계산해 놓고** trend 세 값만 내보내고 있었다. 그래서 전략이
  //   쓸 수 있는 것이 '상승·하락·횡보'뿐이었고, 역추세·돌파·그리드를
  //   짤 재료가 아예 도착하지 않았다.

  test('★ 판정했으면 재료도 함께 온다 — 전에는 계산해 놓고 버렸다', () => {
    const r = detectRegime(up());
    assert(r.view.price != null && r.view.price > 0, '종가가 없다');
    assert(r.view.ema20 != null, 'ema20이 없다');
    assert(r.view.ema60 != null, 'ema60이 없다');
    assert(r.view.atr != null && r.view.atr > 0, 'ATR이 없다');
    assert(r.view.recentHigh != null && r.view.recentLow != null, '박스 끝이 없다');
  });

  test('★★ 판정하지 못하면 재료는 전부 null — 0으로 적지 않는다', () => {
    // 0으로 적으면 돌파 전략은 "전고점 0"을 보고 무조건 돌파로 읽고,
    // 변동성 기반 사이징은 ATR 0으로 나눈다. 못 잰 것은 null이다.
    for (const c of [[] as number[], up(10), null as unknown as number[]]) {
      const v = detectRegime(c).view;
      for (const [k, x] of Object.entries(v)) {
        eq(x, null, `${k}가 null이 아니다 (${JSON.stringify(c)?.slice(0, 16)})`);
      }
    }
  });

  test('박스 끝은 최근 창의 끝이다 — 전체 구간의 끝이 아니다', () => {
    // 앞쪽에 아주 높은 봉을 심어 둔다. 창이 전체를 보면 그 값이 전고점으로
    // 잡히고, 돌파는 영원히 일어나지 않는다.
    const closes = flat();
    closes[0] = 999_999;
    const v = detectRegime(closes).view;
    assert(v.recentHigh != null && v.recentHigh < 999_999,
      `창 밖의 봉이 전고점이 됐다: ${v.recentHigh}`);
    const win = closes.slice(-REGIME_VIEW_WINDOW);
    eq(v.recentHigh, Math.max(...win));
    eq(v.recentLow, Math.min(...win));
  });

  test('박스 끝이 종가를 감싼다 — low ≤ price ≤ high', () => {
    for (const c of [up(), down(), flat(), wild()]) {
      const v = detectRegime(c).view;
      assert(v.recentLow! <= v.price! && v.price! <= v.recentHigh!,
        `종가가 박스 밖이다: ${v.recentLow} / ${v.price} / ${v.recentHigh}`);
    }
  });

  console.log('[국면 — 입구가 둘, 판정은 한 벌]');

  test('★★ 스냅샷 입구가 봉 입구와 같은 판정을 한다 — 복사본이 갈리면 여기서 잡힌다', () => {
    // 화면(AutoTradeEngine)은 봉 배열이 없고 지표 스냅샷만 갖고 있다.
    // 전에는 그래서 판정식을 **복사해** 들고 있었고, detectRegime에
    // '봉이 모자라면 판정하지 않는다'를 넣었을 때 복사본은 그 검사를
    // 통째로 비껴갔다 — allowEntry가 상수 true로 박혀 있었다.
    for (const c of [up(), down(), flat(), wild()]) {
      const full = detectRegime(c);
      const snap = regimeFromSnapshot({
        price: full.view.price!, ema20: full.view.ema20,
        ema60: full.view.ema60, atr: full.view.atr,
      });
      eq(snap.trend, full.trend, '추세가 갈렸다');
      eq(snap.volatility, full.volatility, '변동성이 갈렸다');
      eq(snap.trendScore, full.trendScore, '추세 점수가 갈렸다');
      eq(snap.volPct, full.volPct, '변동성 %가 갈렸다');
      eq(snap.label, full.label, '표시가 갈렸다');
      eq(snap.allowEntry, full.allowEntry, '진입 허용이 갈렸다');
    }
  });

  test('★ 스냅샷에는 박스 끝이 없다 — 못 잰 것을 돌파선으로 쓰지 않게 null', () => {
    const snap = regimeFromSnapshot({ price: 60_000, ema20: 60_100, ema60: 59_000, atr: 700 });
    eq(snap.dataOk, true);
    eq(snap.view.recentHigh, null, '봉 창이 없는데 전고점이 생겼다');
    eq(snap.view.recentLow, null);
    eq(snap.view.price, 60_000);
    eq(snap.bars, 0, '봉이 없었음을 숨기면 안 된다');
  });

  test('★★ 스냅샷이 비면 막는다 — 전에는 allowEntry가 상수 true였다', () => {
    const empty = [
      { price: 60_000, ema20: null, ema60: 59_000, atr: 700 },
      { price: 60_000, ema20: 60_100, ema60: null, atr: 700 },
      { price: 0, ema20: 60_100, ema60: 59_000, atr: 700 },
      { price: 60_000, ema20: 60_100, ema60: 0, atr: 700 },
      { price: NaN, ema20: 60_100, ema60: 59_000, atr: 700 },
    ];
    for (const s of empty) {
      const r = regimeFromSnapshot(s);
      eq(r.dataOk, false, `${JSON.stringify(s)}가 판정됐다`);
      eq(regimeAllowsEntry(r, 'buy', 'any').allowed, false, `${JSON.stringify(s)}가 통과했다`);
    }
  });

  test('ATR이 없으면 변동성 재료도 null — 0폭 밴드를 만들지 않는다', () => {
    const r = regimeFromSnapshot({ price: 60_000, ema20: 60_100, ema60: 59_000, atr: null });
    eq(r.dataOk, true, '추세는 판정할 수 있다');
    eq(r.view.atr, null, 'ATR 0은 "변동 없음"으로 읽힌다');
  });
}
