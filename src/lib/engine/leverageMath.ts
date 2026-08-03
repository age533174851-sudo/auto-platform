// src/lib/engine/leverageMath.ts
//
// **배율은 정하는 것이 아니라 나오는 것이다.**
//
// 화면에 "배율 상한 100"을 넣어도 100배가 나가지 않는다. 엔진은 이렇게
// 역산한다:
//
//   명목가   = 1회 위험금액 ÷ 손절거리
//   증거금   = 자산 × 1회 증거금 %
//   배율     = 명목가 ÷ 증거금   (상한에서 잘림)
//
// 정리하면 배율은 세 값이 정한다 — 1회 위험 %, 1회 증거금 %, 손절거리 %.
// 상한은 그 결과를 자르기만 한다.
//
// 왜 파일로 떼어 놓나
// ───────────────────
// 화면 두 곳이 "100배가 나오려면 손절이 0.26% 안쪽이어야 합니다"라고
// 적고 있었다. 그 0.26은 **증거금 칸이 생기기 전의 식**에서 나온 숫자다.
// 그때는 증거금 예산이 계좌 전액이었다. 1회 증거금 10%를 넣은 지금
// 같은 조건의 답은 1%다 — 네 배 차이다.
//
// 식이 화면 문자열 안에 박혀 있으면 이렇게 조용히 낡는다. 한 곳에 두고
// 테스트를 붙인다.

export interface LeverageInputs {
  /** 1회 위험 비율 (%) — 손절에 닿았을 때 잃을 자산 비율 */
  riskPct: number;
  /** 1회 증거금 비율 (%) — 이번 자리에 묶을 자산 비율 */
  marginPct: number;
  /** 손절 거리 (%) */
  stopPct: number;
}

/**
 * 이 설정이면 배율이 몇 배로 나오는가. 상한을 적용하기 **전** 값이다.
 *
 * 배율 = (위험% ÷ 손절%) ÷ (증거금% ÷ 100)
 *
 * 못 구하면 null — 0으로 돌려주면 화면이 "0배로 나갑니다"라고 적는다.
 */
export function impliedLeverage(inp: LeverageInputs): number | null {
  const risk = Number(inp.riskPct), margin = Number(inp.marginPct), stop = Number(inp.stopPct);
  if (![risk, margin, stop].every(Number.isFinite)) return null;
  if (risk <= 0 || margin <= 0 || stop <= 0) return null;
  return (risk / stop) / (margin / 100);
}

/**
 * 목표 배율이 나오려면 손절이 몇 % 안쪽이어야 하는가.
 *
 * 손절% = 위험% × 100 ÷ (배율 × 증거금%)
 *
 * 예: 위험 10% · 증거금 10% · 목표 100배 → 1.0%
 *     (증거금 칸이 없던 시절의 답은 0.26%였다. 그 숫자가 아직도 화면에
 *      박혀 있었다.)
 */
export function stopPctForLeverage(
  targetLeverage: number, riskPct: number, marginPct: number,
): number | null {
  const L = Number(targetLeverage), risk = Number(riskPct), margin = Number(marginPct);
  if (![L, risk, margin].every(Number.isFinite)) return null;
  if (L <= 0 || risk <= 0 || margin <= 0) return null;
  return (risk * 100) / (L * margin);
}

/**
 * 명목가가 자산의 몇 %가 되는가 — 명목가 상한과 맞춰야 하는 값.
 *
 * 명목가% = 증거금% × 배율
 *
 * 이 값이 명목가 상한(기본 300%)보다 크면 **명목가가 먼저 잘리고**
 * 배율이 그만큼 낮게 나온다. 증거금 10% · 100배면 1000%가 필요하다.
 */
export function notionalPctFor(marginPct: number, leverage: number): number | null {
  const m = Number(marginPct), L = Number(leverage);
  if (![m, L].every(Number.isFinite)) return null;
  if (m <= 0 || L <= 0) return null;
  return m * L;
}

/**
 * 명목가 상한 때문에 배율이 얼마까지만 나오는가.
 *
 * 배율 = 명목가% ÷ 증거금%
 */
export function leverageCapFromNotional(
  maxNotionalPct: number, marginPct: number,
): number | null {
  const n = Number(maxNotionalPct), m = Number(marginPct);
  if (![n, m].every(Number.isFinite)) return null;
  if (n <= 0 || m <= 0) return null;
  return n / m;
}

/**
 * 화면에 적을 한 문장. **모르는 값이 있으면 지어내지 않는다.**
 */
export function leverageNote(
  targetLeverage: number, riskPct: number | null, marginPct: number | null,
): string | null {
  if (!(Number(targetLeverage) > 0)) return null;
  const risk = Number(riskPct), margin = Number(marginPct);
  if (!(risk > 0) || !(margin > 0)) {
    return `배율은 손절 거리에서 역산되고 ${targetLeverage}배에서 잘립니다. `
      + '1회 위험 %와 1회 증거금 %를 정하면 손절이 몇 % 안쪽이어야 하는지 계산해 드립니다.';
  }
  const stop = stopPctForLeverage(targetLeverage, risk, margin);
  if (stop == null) return null;
  return `배율은 손절 거리에서 역산되고 ${targetLeverage}배에서 잘립니다. `
    + `지금 설정(1회 위험 ${risk}% · 1회 증거금 ${margin}%)에서 ${targetLeverage}배가 나오려면 `
    + `손절이 약 ${stop.toFixed(2)}% 안쪽이어야 합니다. 손절이 더 넓으면 그만큼 낮은 배율로 나갑니다.`;
}
