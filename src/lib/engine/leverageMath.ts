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

// ── 청산이 손절보다 먼저 오는 구간 ────────────────────────────
//
// **이걸 몰라서 청산당한다.**
//
// 격리 마진에서 청산은 (1/배율 − 유지증거금률)만큼 불리하게 움직이면
// 온다. 100배면 1% − 0.4% ≈ 0.6%다. 그런데 손절을 1%에 걸면 그 손절은
// **청산 뒤에 있다.** 가격이 0.6%에서 청산을 치고 지나가므로 손절은
// 작동할 기회가 없고, 증거금 전액이 사라진다.
//
// 실제로 이 계좌에서 일어난 일이다:
//   진입 62,906 → 청산 62,573 (0.53%). 손절은 구경도 못 했다.
//
// "배율이 높을수록 손절이 타이트해야 한다"가 아니라, **배율이 손절
// 거리를 정한다.** 손절을 정하고 배율을 올리는 것이 아니라, 배율을
// 정하면 손절이 그 안쪽이어야만 의미가 있다.

/** BTC USDⓈ-M 유지증거금률(%). 명목가 구간에 따라 다르지만 소액 구간 기준. */
export const DEFAULT_MMR_PCT = 0.4;

/**
 * 이 배율에서 청산까지 몇 % 인가. 손절은 **이 안쪽**이어야 한다.
 *
 * 청산거리% = 100 ÷ 배율 − 유지증거금률%
 *
 * 결과가 0 이하면 그 배율은 진입 즉시 청산 구간이다 — null을 준다.
 */
export function liquidationDistancePct(leverage: number, mmrPct = DEFAULT_MMR_PCT): number | null {
  const L = Number(leverage), m = Number(mmrPct);
  if (!Number.isFinite(L) || L <= 0 || !Number.isFinite(m) || m < 0) return null;
  const d = 100 / L - m;
  return d > 0 ? d : null;
}

/**
 * 이 손절 거리에서 **청산당하지 않는** 최대 배율.
 *
 * 손절% < 100÷배율 − MMR%  →  배율 < 100 ÷ (손절% + MMR%)
 *
 * 손절 1%면 100/(1+0.4) = 71배가 천장이다. 100배는 못 쓴다.
 * 손절 0.5%면 100/0.9 = 111배 → 거래소 상한 125배 안이라 100배가 가능하다.
 */
export function maxLeverageBeforeLiquidation(stopPct: number, mmrPct = DEFAULT_MMR_PCT): number | null {
  const s = Number(stopPct), m = Number(mmrPct);
  if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(m) || m < 0) return null;
  const L = 100 / (s + m);
  return L > 0 ? L : null;
}

/**
 * 이 설정으로 진입하면 손절이 청산보다 먼저 오는가.
 *
 * **모르면 null이다.** false로 답하면 "안전하다"로 읽힌다.
 */
export function stopFiresBeforeLiquidation(
  inp: LeverageInputs, mmrPct = DEFAULT_MMR_PCT,
): boolean | null {
  const lev = impliedLeverage(inp);
  if (lev == null) return null;
  const liq = liquidationDistancePct(lev, mmrPct);
  if (liq == null) return false;          // 진입 즉시 청산 구간
  return Number(inp.stopPct) < liq;
}

/**
 * 화면에 적을 경고. 안전하면 null — 문제없을 때 문장을 띄우면
 * 경고가 배경이 되고, 그러면 진짜 경고도 안 읽힌다.
 */
export function liquidationWarning(
  inp: LeverageInputs, mmrPct = DEFAULT_MMR_PCT,
): string | null {
  const lev = impliedLeverage(inp);
  if (lev == null) return null;
  const liq = liquidationDistancePct(lev, mmrPct);
  if (liq == null) {
    return `배율 ${Math.round(lev)}배는 진입 즉시 청산 구간입니다 (유지증거금 ${mmrPct}%).`;
  }
  if (Number(inp.stopPct) < liq) return null;
  const safe = maxLeverageBeforeLiquidation(Number(inp.stopPct), mmrPct);
  return `손절 ${inp.stopPct}%가 청산 거리 ${liq.toFixed(2)}%보다 멉니다 — `
    + '손절이 작동하기 전에 청산됩니다(증거금 전액 소멸). '
    + (safe != null
        ? `이 손절에서는 ${Math.floor(safe)}배까지가 안전합니다. `
          + `${Math.round(lev)}배를 쓰려면 손절이 ${liq.toFixed(2)}% 안쪽이어야 합니다.`
        : '');
}
