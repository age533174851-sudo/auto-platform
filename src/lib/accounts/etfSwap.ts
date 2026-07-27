// src/lib/accounts/etfSwap.ts
// ETF 자동 교체 — 보유 ETF와 동급(같은 지수/전략)이면서 더 저렴하거나 나은 대안 제안.
export interface EtfInfo {
  symbol: string;
  name: string;
  expense: number;   // 총보수 (연 %)
  yieldPct: number;  // 배당수익률 (%)
}

// 동급 ETF 그룹 (같은 그룹 = 사실상 대체 가능)
export interface EtfGroup { id: string; label: string; etfs: EtfInfo[] }

export const ETF_GROUPS: EtfGroup[] = [
  { id: 'sp500', label: 'S&P 500', etfs: [
    { symbol: 'VOO', name: 'Vanguard S&P 500',     expense: 0.03, yieldPct: 1.4 },
    { symbol: 'IVV', name: 'iShares Core S&P 500',  expense: 0.03, yieldPct: 1.4 },
    { symbol: 'SPY', name: 'SPDR S&P 500',          expense: 0.09, yieldPct: 1.3 },
  ]},
  { id: 'total_us', label: '미국 전체시장', etfs: [
    { symbol: 'VTI',  name: 'Vanguard Total Market', expense: 0.03, yieldPct: 1.3 },
    { symbol: 'ITOT', name: 'iShares Core Total US',  expense: 0.03, yieldPct: 1.3 },
    { symbol: 'SCHB', name: 'Schwab US Broad',        expense: 0.03, yieldPct: 1.3 },
  ]},
  { id: 'nasdaq100', label: '나스닥 100', etfs: [
    { symbol: 'QQQM', name: 'Invesco NASDAQ 100',    expense: 0.15, yieldPct: 0.6 },
    { symbol: 'QQQ',  name: 'Invesco QQQ Trust',     expense: 0.20, yieldPct: 0.6 },
  ]},
  { id: 'dividend', label: '고배당', etfs: [
    { symbol: 'SCHD', name: 'Schwab US Dividend',    expense: 0.06, yieldPct: 3.5 },
    { symbol: 'VYM',  name: 'Vanguard High Div',     expense: 0.06, yieldPct: 2.9 },
    { symbol: 'DVY',  name: 'iShares Select Div',    expense: 0.38, yieldPct: 3.6 },
  ]},
  { id: 'covered_call', label: '커버드콜', etfs: [
    { symbol: 'JEPI', name: 'JPMorgan Equity Prem',  expense: 0.35, yieldPct: 7.2 },
    { symbol: 'JEPQ', name: 'JPMorgan Nasdaq Prem',  expense: 0.35, yieldPct: 9.5 },
    { symbol: 'QYLD', name: 'Global X NASDAQ CC',    expense: 0.60, yieldPct: 11.5 },
  ]},
];

const SYM_INDEX: Record<string, { group: EtfGroup; etf: EtfInfo }> = {};
for (const g of ETF_GROUPS) for (const e of g.etfs) SYM_INDEX[e.symbol] = { group: g, etf: e };

export function findEtf(symbol: string) { return SYM_INDEX[(symbol || '').toUpperCase()]; }

export interface SwapSuggestion {
  from: EtfInfo;
  to: EtfInfo;
  group: string;
  feeSaving: number;      // 연 총보수 절감 (%p)
  annualSaved: number;    // 보유금액 기준 연 절감액 (통화 단위)
  reason: string;
}

// 보유 ETF에 대해 더 나은 동급 대안 제안 (총보수 우선, 동률이면 배당 높은 쪽)
export function suggestSwap(symbol: string, holdingValue: number): SwapSuggestion | null {
  const found = findEtf(symbol);
  if (!found) return null;
  const { group, etf } = found;
  // 같은 그룹에서 최적: 총보수 최저 → 동률이면 배당 최고
  const best = [...group.etfs].sort((a, b) => a.expense - b.expense || b.yieldPct - a.yieldPct)[0];
  if (best.symbol === etf.symbol) return null;      // 이미 최적
  const feeSaving = etf.expense - best.expense;
  if (feeSaving <= 0) return null;
  return {
    from: etf, to: best, group: group.label,
    feeSaving,
    annualSaved: holdingValue * (feeSaving / 100),
    reason: `동일 ${group.label} 지수, 총보수 ${etf.expense}% → ${best.expense}%`,
  };
}
