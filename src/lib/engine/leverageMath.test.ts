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
}
