// src/lib/strategies/scalpSignal.test.ts
//
// 이 테스트가 막는 것 셋:
//  1. **이길 수 없는 자리에 신호를 내는 것** — 목표 < 왕복 비용
//  2. **미래를 보는 것** — 마지막 봉의 고가로 그 봉의 돌파를 판정
//  3. **못 읽은 값을 만족한 것으로 세는 것** — 거래량·ATR
//
// 1번이 가장 중요하다. 봉이 짧아질수록 신호는 늘어나는데 그 신호들이
// 전부 마이너스다. 수수료는 봉이 짧다고 줄지 않는다.

import { test, eq, assert } from '../../test/harness';
import {
  scalpSignal, atr, timeframeVerdict, SCALP_DEFAULTS,
  type Bars, type ScalpConfig,
} from './scalpSignal';

/** 평평한 봉 n개 — 신호가 안 나는 바탕 */
function flat(n: number, price = 100, vol = 100): Bars {
  return {
    highs: Array(n).fill(price + 0.5),
    lows: Array(n).fill(price - 0.5),
    closes: Array(n).fill(price),
    volumes: Array(n).fill(vol),
  };
}

/** 마지막 봉을 돌파로 만든다 */
function withBreakout(b: Bars, close: number, vol: number): Bars {
  const n = b.closes.length;
  const out: Bars = {
    highs: [...b.highs], lows: [...b.lows], closes: [...b.closes], volumes: [...b.volumes],
  };
  out.closes[n - 1] = close;
  out.highs[n - 1] = Math.max(out.highs[n - 1], close);
  out.lows[n - 1] = Math.min(out.lows[n - 1], close);
  out.volumes[n - 1] = vol;
  return out;
}

export function runScalpSignalTests() {
  console.log('[단타 신호 — 이길 수 없는 자리에는 신호를 내지 않는다]');

  const CFG: ScalpConfig = { ...SCALP_DEFAULTS, lookback: 5, atrPeriod: 5 };

  // ── ATR ─────────────────────────────────────────────────
  test('봉이 모자라면 ATR은 null — 0이 아니다', () => {
    // 0을 돌려주면 손절 폭이 0이 되고, 그건 진입 즉시 손절이다
    eq(atr(flat(3), 14), null);
    eq(atr(flat(14), 14), null, '기간+1개는 있어야 한다');
  });

  test('변동성이 0이면 null', () => {
    const b: Bars = {
      highs: Array(20).fill(100), lows: Array(20).fill(100),
      closes: Array(20).fill(100), volumes: Array(20).fill(1),
    };
    eq(atr(b, 5), null, '움직임이 없는데 ATR이 나왔다');
  });

  test('정상 봉이면 ATR이 나온다', () => {
    const a = atr(flat(30), 14);
    assert(a != null && a > 0, `ATR이 안 나왔다: ${a}`);
  });

  // ── 신호를 안 내는 경우 ─────────────────────────────────
  test('봉이 모자라면 신호 없음', () => {
    const r = scalpSignal(flat(5), CFG);
    eq(r.signal, null);
    assert(r.reason.includes('모자'), r.reason);
  });

  test('데이터가 없으면 신호 없음', () => {
    eq(scalpSignal(null, CFG).signal, null);
    eq(scalpSignal(undefined, CFG).signal, null);
  });

  test('돌파가 없으면 신호 없음', () => {
    const r = scalpSignal(flat(30), CFG);
    eq(r.signal, null);
    assert(r.reason.includes('돌파'), r.reason);
  });

  // 거래량 없는 돌파는 대개 되돌아온다. **못 읽으면 통과시키지 않는다** —
  // 확인 못 한 조건을 만족한 것으로 세면 그 조건은 없는 것과 같다.
  test('거래량이 부족하면 신호 없음', () => {
    const b = withBreakout(flat(30), 105, 100);   // 평균과 같은 거래량
    const r = scalpSignal(b, CFG);
    eq(r.signal, null);
    assert(r.reason.includes('거래량'), r.reason);
  });

  test('거래량을 못 읽으면 신호 없음', () => {
    const b = withBreakout(flat(30), 105, NaN as any);
    eq(scalpSignal(b, CFG).signal, null);
  });

  // ── 신호가 나는 경우 ────────────────────────────────────
  test('거래량 실린 상방 돌파는 LONG', () => {
    const b = withBreakout(flat(30), 105, 500);
    const r = scalpSignal(b, CFG);
    assert(r.signal != null, r.reason);
    eq(r.signal!.side, 'LONG');
    assert(r.signal!.stop < r.signal!.entry, '롱인데 손절이 진입가 위다');
    assert(r.signal!.target > r.signal!.entry, '롱인데 목표가 진입가 아래다');
  });

  test('하방 돌파는 SHORT — 손절과 목표가 뒤집힌다', () => {
    const b = withBreakout(flat(30), 95, 500);
    const r = scalpSignal(b, CFG);
    assert(r.signal != null, r.reason);
    eq(r.signal!.side, 'SHORT');
    assert(r.signal!.stop > r.signal!.entry, '숏인데 손절이 진입가 아래다');
    assert(r.signal!.target < r.signal!.entry, '숏인데 목표가 진입가 위다');
  });

  test('손익비가 설정대로 나온다', () => {
    const b = withBreakout(flat(30), 105, 500);
    const r = scalpSignal(b, { ...CFG, rewardRisk: 3 });
    assert(r.signal != null, r.reason);
    const rr = r.signal!.targetPct / r.signal!.stopPct;
    assert(Math.abs(rr - 3) < 0.001, `손익비가 3이 아니다: ${rr}`);
  });

  // ── **이 파일의 이유** ──────────────────────────────────
  //
  // 목표가 왕복 비용보다 작으면 방향을 맞춰도 진다. 이 검사가 없으면
  // 봉이 짧아질수록 신호가 늘어나는데 그 신호들이 전부 마이너스다.
  test('목표가 왕복 비용보다 작으면 신호를 내지 않는다', () => {
    const b = withBreakout(flat(30), 105, 500);
    // 비용을 목표보다 크게 잡으면 반드시 막혀야 한다
    const r = scalpSignal(b, { ...CFG, roundTripCostPct: 99 });
    eq(r.signal, null);
    assert(r.reason.includes('왕복 비용'), r.reason);
  });

  test('비용을 넘기면 통과하고, 기대값을 적는다', () => {
    const b = withBreakout(flat(30), 105, 500);
    const r = scalpSignal(b, { ...CFG, roundTripCostPct: 0.01 });
    assert(r.signal != null, r.reason);
    assert(r.signal!.notes.some(x => x.includes('왕복 비용')), '비용 차감을 안 적었다');
  });

  // ── 미래를 보지 않는다 ──────────────────────────────────
  //
  // 마지막 봉을 기준선에 포함하면 그 봉의 고가로 그 봉의 돌파를 판정하게
  // 된다. 언제나 참이고, 실거래에서는 그 값을 그 시점에 알 수 없다.
  test('마지막 봉의 고가는 돌파 기준에 들어가지 않는다', () => {
    const b = flat(30, 100, 100);
    // 마지막 봉의 고가만 아주 높게. 종가는 구간 안.
    const n = b.closes.length;
    b.highs[n - 1] = 999;
    b.volumes[n - 1] = 500;
    const r = scalpSignal(b, CFG);
    // 종가가 구간 안이므로 돌파가 아니다. 마지막 봉 고가를 기준에
    // 넣었다면 여기서 신호가 났을 것이다.
    eq(r.signal, null, '마지막 봉 고가를 기준선에 넣었다(미래 참조)');
  });

  // ── 봉 주기 판정 ────────────────────────────────────────
  //
  // 짧을수록 봉의 움직임이 작아지고 왕복 비용은 그대로다. 어느 선 아래로는
  // 구조적으로 이길 수 없다 — 전략을 아무리 잘 만들어도.
  test('1분봉은 못 쓴다고 말한다', () => {
    const v = timeframeVerdict(1);
    eq(v.usable, false);
    assert(v.text.includes('수수료'), v.text);
  });

  test('긴 봉일수록 쓸 만해진다', () => {
    eq(timeframeVerdict(1).usable, false);
    eq(timeframeVerdict(5).usable, false);
    eq(timeframeVerdict(60).usable, true);
    eq(timeframeVerdict(240).usable, true);
  });

  test('움직임은 주기가 길수록 커진다', () => {
    const a = timeframeVerdict(1).typicalMovePct;
    const b = timeframeVerdict(15).typicalMovePct;
    const c = timeframeVerdict(60).typicalMovePct;
    assert(a < b && b < c, `단조 증가가 아니다: ${a} ${b} ${c}`);
  });

  // ── 잡스러운 입력 ───────────────────────────────────────
  test('고가·저가 개수가 다르면 거부한다', () => {
    const b = flat(30);
    b.highs = b.highs.slice(0, 20);
    eq(scalpSignal(b, CFG).signal, null);
  });

  test('현재가가 0이면 거부한다', () => {
    const b = flat(30);
    b.closes[b.closes.length - 1] = 0;
    eq(scalpSignal(b, CFG).signal, null);
  });
}
