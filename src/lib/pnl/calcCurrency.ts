// src/lib/pnl/calcCurrency.ts
//
// **손익 계산기는 사용자가 적은 가격의 통화로 셈한다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 미국주식·ETF 예시는 NVDA 875 → 920처럼 **달러**로 적는다. 그런데
// 계산기는 '환율 (USD/KRW)' 칸을 받아 놓고 한 번도 쓰지 않았다:
//
//   · 결과를 전부 원화로 그렸다 — 달러 이익 450이 '₩450'으로 보였다
//   · 양도세의 **250만 원** 공제를 달러 이익에서 그대로 뺐다 — 이익이
//     250만 달러를 넘기 전에는 22% 양도세가 언제나 0이었다
//
// 규칙
// ────
//   · 미국주식·ETF는 달러, 나머지는 원화로 적는다고 본다 (예시와 같다)
//   · 원화로 정해진 공제는 **환율로 바꿔서** 뺀다
//   · 환율을 모르면 그 세금은 **null**이다 — 0으로 적으면 세금이 없다고 읽힌다

export type QuoteCurrency = 'KRW' | 'USD';

/** 연 250만 원 기본공제 (해외주식·가상자산·파생 양도세) */
export const KRW_TAX_DEDUCTION = 2_500_000;

/** 계산기에 적는 가격의 통화 */
export function quoteCurrencyOf(assetType: string): QuoteCurrency {
  return assetType === 'us_stock' || assetType === 'etf' ? 'USD' : 'KRW';
}

/**
 * 원화 금액을 가격 통화로. **환율을 모르면 null.**
 */
export function krwToQuote(krw: number, quote: QuoteCurrency, fxRate: number): number | null {
  if (quote === 'KRW') return krw;
  return Number.isFinite(fxRate) && fxRate > 0 ? krw / fxRate : null;
}

/**
 * 계산기의 예상 세금 (가격 통화 기준).
 *
 * 세율 규칙 자체는 바꾸지 않았다 — 공제액의 **통화만** 맞춘다.
 */
export function estimateCalcTax(i: {
  taxMode: string;
  grossProfit: number;
  sellAmount: number;
  /** '직접 입력' 세율 (%) */
  taxRatePct: number;
  quote: QuoteCurrency;
  /** 1 USD = ? KRW */
  fxRate: number;
}): number | null {
  const afterDeduction = (rate: number): number | null => {
    const deduction = krwToQuote(KRW_TAX_DEDUCTION, i.quote, i.fxRate);
    if (deduction == null) return null;
    return Math.max(0, i.grossProfit - deduction) * rate;
  };
  switch (i.taxMode) {
    case 'us_stock': return afterDeduction(0.22);
    case 'futures':  return afterDeduction(0.20);
    case 'crypto':   return afterDeduction(0.20);   // 시행 시 250만 원 공제 후 20%
    case 'kr_stock': return i.sellAmount * 0.0023;  // 거래세는 매도금액의 0.23%
    default:         return Math.max(0, i.grossProfit) * (i.taxRatePct / 100);
  }
}
