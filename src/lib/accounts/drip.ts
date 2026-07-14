// src/lib/accounts/drip.ts
// 배당 재투자(DRIP) 복리 시뮬레이션.
// 재투자 시 배당으로 주식을 더 사서 다음 배당이 커지는 복리 효과를 모델링.
export interface DripInput {
  principal: number;       // 초기 투자금
  annualYield: number;     // 연 배당수익률 (%)
  divGrowth: number;       // 연 배당 성장률 (%)
  priceGrowth: number;     // 연 주가 상승률 (%)
  years: number;
  reinvest: boolean;       // true=재투자(DRIP), false=현금 수령
  taxRate?: number;        // 배당소득세율 (%) — 예: 한국 15.4, 미국 15. 기본 0(세전)
}

export interface DripYear {
  year: number;
  value: number;             // 평가금액 (주식 가치)
  cumulativeDividends: number; // 누적 배당 (재투자면 재투자된 총액, 현금이면 받은 현금 누적)
  totalReturn: number;       // 총 자산 (재투자=value, 현금=value+누적현금배당)
}

// 연 단위 시뮬레이션 (배당은 연 1회 재투자로 근사 — 장기 복리 효과 비교엔 충분)
export function simulateDrip(inp: DripInput): DripYear[] {
  const { principal, annualYield, divGrowth, priceGrowth, years, reinvest, taxRate = 0 } = inp;
  const netRate = 1 - Math.max(0, Math.min(100, taxRate)) / 100;   // 세후 비율
  const out: DripYear[] = [];
  let shareValue = principal;    // 보유 주식의 현재 평가금액
  let cashDividends = 0;         // 현금 수령 시 누적 배당
  let cumReinvested = 0;         // 재투자된 배당 누적
  let curYield = annualYield / 100;

  for (let y = 1; y <= years; y++) {
    // 올해 배당 = 현재 평가금액 × 수익률, 세금 차감 후
    const dividend = shareValue * curYield * netRate;
    // 주가 상승 반영
    shareValue = shareValue * (1 + priceGrowth / 100);
    if (reinvest) {
      shareValue += dividend;    // 세후 배당으로 추가 매수 → 평가금액에 합산 (복리)
      cumReinvested += dividend;
    } else {
      cashDividends += dividend; // 세후 현금으로 빼둠
    }
    // 배당 성장 (기업이 배당 인상)
    curYield = curYield * (1 + divGrowth / 100);
    out.push({
      year: y,
      value: Math.round(shareValue),
      cumulativeDividends: Math.round(reinvest ? cumReinvested : cashDividends),
      totalReturn: Math.round(reinvest ? shareValue : shareValue + cashDividends),
    });
  }
  return out;
}

// 재투자 vs 현금 수령 최종 비교
export function compareDrip(inp: Omit<DripInput, 'reinvest'>): {
  reinvest: DripYear[]; cash: DripYear[]; extra: number; extraPct: number;
} {
  const reinvest = simulateDrip({ ...inp, reinvest: true });
  const cash = simulateDrip({ ...inp, reinvest: false });
  const rFinal = reinvest[reinvest.length - 1]?.totalReturn || 0;
  const cFinal = cash[cash.length - 1]?.totalReturn || 0;
  const extra = rFinal - cFinal;
  return { reinvest, cash, extra, extraPct: cFinal > 0 ? (extra / cFinal) * 100 : 0 };
}
