// src/lib/engine/leverageMath.test.ts
//
// 이 테스트가 막는 것
// ───────────────────
// **화면 문자열 안에 박힌 식이 조용히 낡는 것.**
//
// 두 화면이 이렇게 적고 있었다:
//
//   "100배가 실제로 나오려면 손절이 약 0.26% 안쪽이어야 합니다"
//
// 그 0.26은 1회 증거금 칸이 생기기 전의 식에서 나온 숫자다. 그때는
// 증거금 예산이 계좌 전액이었다. 증거금 10%를 넣은 지금 같은 조건의
// 답은 1.00%다 — **네 배 차이**다.
//
// 그 차이만큼 사용자는 "100배는 불가능하구나"라고 잘못 배운다. 식이
// JSX 안에 있으면 아무도 못 고치고, 고쳐도 다른 화면은 그대로 남는다.

import { test, eq, assert, close } from '../../test/harness';
import {
  impliedLeverage, stopPctForLeverage, notionalPctFor,
  leverageCapFromNotional, leverageNote,
  liquidationDistancePct, maxLeverageBeforeLiquidation,
  stopFiresBeforeLiquidation, liquidationWarning,
} from './leverageMath';

export function runLeverageMathTests() {
  console.log('[배율 역산 — 정하는 것이 아니라 나오는 것이다]');

  // 사용자의 실제 설정: 1회 위험 10% · 1회 증거금 10%
  test('위험 10% · 증거금 10% · 손절 1%면 100배가 나온다', () => {
    close(impliedLeverage({ riskPct: 10, marginPct: 10, stopPct: 1 }), 100, 1e-9);
  });

  test('손절이 넓어지면 배율이 그만큼 낮아진다', () => {
    close(impliedLeverage({ riskPct: 10, marginPct: 10, stopPct: 2 }), 50, 1e-9);
    close(impliedLeverage({ riskPct: 10, marginPct: 10, stopPct: 5 }), 20, 1e-9);
  });

  // **이게 화면에 잘못 적혀 있던 값이다.**
  test('100배가 나오는 손절은 1.00%다 — 0.26%가 아니다', () => {
    const s = stopPctForLeverage(100, 10, 10);
    close(s, 1.0, 1e-9);
    assert(Math.abs(s - 0.26) > 0.5, '옛날 식(0.26%)이 아직 살아 있다');
  });

  test('증거금을 반으로 줄이면 같은 배율에 손절이 두 배 넓어도 된다', () => {
    close(stopPctForLeverage(100, 10, 5), 2.0, 1e-9);
  });

  test('역산과 정산이 서로 맞는다', () => {
    for (const L of [10, 25, 50, 100, 125]) {
      const stop = stopPctForLeverage(L, 10, 10);
      close(impliedLeverage({ riskPct: 10, marginPct: 10, stopPct: stop }), L, 1e-6);
    }
  });

  // ── 명목가 상한과의 관계 ──
  //
  // 배율이 잘리는 두 번째 자리다. 증거금 10%로 100배를 쓰려면 명목가가
  // 자산의 1000%여야 하는데, 기본 상한은 300%였다 → 30배로 잘렸다.
  test('증거금 10% · 100배는 명목가 1000%가 필요하다', () => {
    eq(notionalPctFor(10, 100), 1000);
  });

  test('명목가 상한 300%에 증거금 10%면 30배가 천장이다', () => {
    eq(leverageCapFromNotional(300, 10), 30);
  });

  test('상한을 1000%로 올리면 100배가 열린다', () => {
    eq(leverageCapFromNotional(1000, 10), 100);
  });

  // ── 0과 음수는 '모름'이다 ──
  //
  // 0을 돌려주면 화면이 "0배로 나갑니다" 또는 "손절 0%"라고 적는다.
  // 둘 다 사실이 아니고, 둘 다 그럴듯하게 보인다.
  test('값이 없으면 null이다 — 0으로 답하지 않는다', () => {
    eq(impliedLeverage({ riskPct: 0, marginPct: 10, stopPct: 1 }), null);
    eq(impliedLeverage({ riskPct: 10, marginPct: 0, stopPct: 1 }), null);
    eq(impliedLeverage({ riskPct: 10, marginPct: 10, stopPct: 0 }), null);
    eq(stopPctForLeverage(0, 10, 10), null);
    eq(stopPctForLeverage(100, 10, 0), null);
    eq(notionalPctFor(0, 100), null);
    eq(leverageCapFromNotional(300, 0), null);
  });

  test('숫자가 아니면 null이다', () => {
    eq(impliedLeverage({ riskPct: NaN, marginPct: 10, stopPct: 1 }), null);
    eq(stopPctForLeverage(100, NaN, 10), null);
  });

  // ── 화면 문장 ──
  test('설정이 다 있으면 손절 기준을 숫자로 말한다', () => {
    const n = leverageNote(100, 10, 10);
    assert(n.includes('1.00%'), n);
    assert(n.includes('100배'), n);
  });

  test('설정이 없으면 지어내지 않는다', () => {
    const n = leverageNote(100, null, null);
    assert(!n.includes('%  안쪽'), n);
    assert(n.includes('정하면'), '무엇을 정해야 하는지 안 알려줬다: ' + n);
  });

  test('배율 상한이 없으면 문장도 없다', () => {
    eq(leverageNote(0, 10, 10), null);
  });

  // ══ 청산이 손절보다 먼저 오는 구간 ══
  //
  // 이 계좌에서 실제로 두 번 일어났다:
  //   진입 62,906 → 청산 62,573 (0.53%). 손절은 구경도 못 했다.
  //
  // 100배에서 청산은 약 0.6%에 온다. 손절을 1%에 걸면 그 손절은 청산
  // **뒤에** 있어서 작동할 기회가 없고 증거금 전액이 사라진다.
  test('100배의 청산 거리는 약 0.6%다', () => {
    close(liquidationDistancePct(100), 0.6, 1e-9);
    close(liquidationDistancePct(50), 1.6, 1e-9);
    close(liquidationDistancePct(10), 9.6, 1e-9);
  });

  test('유지증거금보다 청산 거리가 짧아지는 배율은 진입 즉시 청산이다', () => {
    // 100/250 = 0.4 → 0.4 - 0.4 = 0 → 양수가 아니다
    eq(liquidationDistancePct(250), null);
    eq(liquidationDistancePct(300), null);
  });

  // **어제 제가 드린 말이 여기서 틀렸다.**
  // "손절 1%면 100배가 나옵니다"는 배율 역산으로는 맞지만, 그 조합은
  // 청산이 먼저 와서 실제로는 쓸 수 없다.
  test('손절 1%에서는 71배가 천장이다 — 100배는 못 쓴다', () => {
    const m = maxLeverageBeforeLiquidation(1.0);
    close(m, 100 / 1.4, 1e-9);
    assert(Math.floor(m) === 71, '천장이 71배가 아니다: ' + m);
    assert(m < 100, '손절 1%에 100배가 안전하다고 했다');
  });

  test('손절 0.5%면 100배가 안전 구간 안이다', () => {
    const m = maxLeverageBeforeLiquidation(0.5);
    assert(m > 100, `손절 0.5%인데 천장이 ${m}배다`);
  });

  test('손절과 청산의 선후를 판정한다', () => {
    // 위험 10% · 증거금 10% · 손절 1% → 100배 → 청산 0.6% < 손절 1% → 위험
    eq(stopFiresBeforeLiquidation({ riskPct: 10, marginPct: 10, stopPct: 1 }), false);
    // 손절 0.5% → 배율 200 → 청산 0.1% < 0.5% → 여전히 위험
    eq(stopFiresBeforeLiquidation({ riskPct: 10, marginPct: 10, stopPct: 0.5 }), false);
    // 위험 5% · 증거금 10% · 손절 2% → 25배 → 청산 3.6% > 손절 2% → 안전
    eq(stopFiresBeforeLiquidation({ riskPct: 5, marginPct: 10, stopPct: 2 }), true);
  });

  test('모르면 null이다 — false(안전)로 답하지 않는다', () => {
    eq(stopFiresBeforeLiquidation({ riskPct: 0, marginPct: 10, stopPct: 1 }), null);
    eq(liquidationDistancePct(0), null);
    eq(maxLeverageBeforeLiquidation(0), null);
  });

  test('위험할 때만 경고한다 — 안전하면 조용하다', () => {
    const bad = liquidationWarning({ riskPct: 10, marginPct: 10, stopPct: 1 });
    assert(bad != null && bad.includes('청산'), '위험한데 경고가 없다: ' + bad);
    assert(bad.includes('71배'), '안전한 배율을 안 알려줬다: ' + bad);
    // 문제없을 때 문장을 띄우면 경고가 배경이 되고, 진짜 경고도 안 읽힌다.
    eq(liquidationWarning({ riskPct: 5, marginPct: 10, stopPct: 2 }), null);
  });
}
