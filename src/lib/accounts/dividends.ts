// ─────────────────────────────────────────────────────────────
// TRAIGO — Dividend Calendar
// 배당 일정 데이터 + 다가오는 배당 계산 + 연 배당수익 추정
// (실제 배당 API 연결 전 mock — 분기/월 배당 패턴 기반)
// ─────────────────────────────────────────────────────────────

export type DividendFrequency = 'monthly' | 'quarterly' | 'semi-annual' | 'annual';

export interface DividendStock {
  symbol: string;
  name: string;
  category: 'us_stock' | 'us_etf' | 'kr_stock' | 'kr_etf';
  yieldPct: number;             // 연 배당 수익률 (%)
  frequency: DividendFrequency;
  payMonths: number[];          // 1~12 중 지급월 (예: [3, 6, 9, 12])
  // 배당락일 — 보통 지급월의 특정일 (mock: 매월 15일 가정)
  exDay: number;                // 1~28
  // 통화
  currency: 'USD' | 'KRW';
  // 1회당 배당금 (mock — 실제로는 API에서)
  paymentPerShare: number;
}

export const DIVIDEND_UNIVERSE: DividendStock[] = [
  // US ETFs
  { symbol: 'SCHD', name: 'Schwab US Dividend ETF',    category: 'us_etf',   yieldPct: 3.5, frequency: 'quarterly',  payMonths: [3, 6, 9, 12], exDay: 18, currency: 'USD', paymentPerShare: 0.78 },
  { symbol: 'VYM',  name: 'Vanguard High Div Yield',   category: 'us_etf',   yieldPct: 2.9, frequency: 'quarterly',  payMonths: [3, 6, 9, 12], exDay: 20, currency: 'USD', paymentPerShare: 0.82 },
  { symbol: 'JEPI', name: 'JPMorgan Equity Premium',   category: 'us_etf',   yieldPct: 7.2, frequency: 'monthly',    payMonths: [1,2,3,4,5,6,7,8,9,10,11,12], exDay: 1, currency: 'USD', paymentPerShare: 0.34 },
  { symbol: 'QYLD', name: 'Global X NASDAQ Covered',   category: 'us_etf',   yieldPct: 11.5,frequency: 'monthly',    payMonths: [1,2,3,4,5,6,7,8,9,10,11,12], exDay: 19, currency: 'USD', paymentPerShare: 0.17 },
  { symbol: 'VOO',  name: 'Vanguard S&P 500',          category: 'us_etf',   yieldPct: 1.4, frequency: 'quarterly',  payMonths: [3, 6, 9, 12], exDay: 22, currency: 'USD', paymentPerShare: 1.78 },

  // US dividend stocks
  { symbol: 'KO',   name: 'Coca-Cola',                 category: 'us_stock', yieldPct: 3.1, frequency: 'quarterly',  payMonths: [3, 6, 9, 12], exDay: 14, currency: 'USD', paymentPerShare: 0.48 },
  { symbol: 'JNJ',  name: 'Johnson & Johnson',         category: 'us_stock', yieldPct: 3.0, frequency: 'quarterly',  payMonths: [2, 5, 8, 11], exDay: 25, currency: 'USD', paymentPerShare: 1.24 },
  { symbol: 'PG',   name: 'Procter & Gamble',          category: 'us_stock', yieldPct: 2.5, frequency: 'quarterly',  payMonths: [1, 4, 7, 10], exDay: 18, currency: 'USD', paymentPerShare: 1.01 },
  { symbol: 'MSFT', name: 'Microsoft',                 category: 'us_stock', yieldPct: 0.7, frequency: 'quarterly',  payMonths: [2, 5, 8, 11], exDay: 14, currency: 'USD', paymentPerShare: 0.83 },
  { symbol: 'AVGO', name: 'Broadcom',                  category: 'us_stock', yieldPct: 1.3, frequency: 'quarterly',  payMonths: [3, 6, 9, 12], exDay: 19, currency: 'USD', paymentPerShare: 5.25 },
  { symbol: 'AAPL', name: 'Apple',                     category: 'us_stock', yieldPct: 0.5, frequency: 'quarterly',  payMonths: [2, 5, 8, 11], exDay: 9,  currency: 'USD', paymentPerShare: 0.25 },
  { symbol: 'O',    name: 'Realty Income',             category: 'us_stock', yieldPct: 5.7, frequency: 'monthly',    payMonths: [1,2,3,4,5,6,7,8,9,10,11,12], exDay: 1, currency: 'USD', paymentPerShare: 0.263 },

  // KR
  { symbol: '005930', name: '삼성전자',                category: 'kr_stock', yieldPct: 2.0, frequency: 'quarterly',  payMonths: [4, 5, 8, 11], exDay: 28, currency: 'KRW', paymentPerShare: 361 },
  { symbol: '033780', name: 'KT&G',                    category: 'kr_stock', yieldPct: 5.4, frequency: 'annual',     payMonths: [4],          exDay: 15, currency: 'KRW', paymentPerShare: 5200 },
  { symbol: '316140', name: '우리금융지주',            category: 'kr_stock', yieldPct: 6.8, frequency: 'quarterly',  payMonths: [4, 7, 10, 1],exDay: 12, currency: 'KRW', paymentPerShare: 250 },
];

export const FREQ_LABEL: Record<DividendFrequency, string> = {
  monthly: '월간',
  quarterly: '분기',
  'semi-annual': '반기',
  annual: '연간',
};

// 향후 N개월간 배당 일정 생성
export interface UpcomingDividend {
  symbol: string;
  name: string;
  exDate: Date;                 // 배당락일
  payDate: Date;                // 지급일 (배당락일 + 약 30일)
  paymentPerShare: number;
  currency: 'USD' | 'KRW';
  category: DividendStock['category'];
  yieldPct: number;
  frequency: DividendFrequency;
}

export function getUpcomingDividends(months: number = 3, symbols?: string[]): UpcomingDividend[] {
  const list: UpcomingDividend[] = [];
  const now = new Date();
  const universe = symbols && symbols.length > 0
    ? DIVIDEND_UNIVERSE.filter(d => symbols.includes(d.symbol))
    : DIVIDEND_UNIVERSE;

  for (const d of universe) {
    if (!Array.isArray(d.payMonths)) continue;
    // 향후 months 개월 안의 ex-date 찾기
    for (let offset = 0; offset <= months; offset++) {
      const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      const targetMonth = target.getMonth() + 1; // 1~12
      if (!d.payMonths.includes(targetMonth)) continue;
      const exDate = new Date(target.getFullYear(), target.getMonth(), d.exDay);
      if (exDate < now) continue;
      const payDate = new Date(exDate);
      payDate.setDate(payDate.getDate() + 30);
      list.push({
        symbol: d.symbol,
        name: d.name,
        exDate, payDate,
        paymentPerShare: d.paymentPerShare,
        currency: d.currency,
        category: d.category,
        yieldPct: d.yieldPct,
        frequency: d.frequency,
      });
    }
  }

  return list.sort((a, b) => a.exDate.getTime() - b.exDate.getTime());
}

// 보유 수량으로 연간 배당 추정
export interface DividendHolding {
  symbol: string;
  shares: number;
}

/**
 * 수량 입력 한 건의 유효성.
 *
 * **왜 분리했는가 (#778 리뷰)**
 * 전에는 수정 경로가 "n이 유한 양수이면 update, 0이면 delete"로 **같은
 * 숫자칸이 두 동작의 입구**였다. 그런데 SliderField는 소수 step 아래
 * 입력(예: step=0.00001일 때 0.000001)을 `toFixed(5)`로 **0에 반올림**한다.
 * 결과: 사용자가 양의 수량 0.000001을 치려다가 저장소에서 해당 종목이
 * 조용히 삭제된다 (Codex 3차 재현).
 *
 * 그래서 삭제는 **별도 버튼**으로 떼어 내고, 수정 경로는 이 함수로
 * **양의 유한 수량만** 받는다. 0이나 음수는 거절한다 — 삭제 의도라면
 * 삭제 버튼을 누르는 게 맞다.
 */
export type HoldingSharesValidation =
  | { ok: true; shares: number }
  | { ok: false; reason: 'not-finite' | 'non-positive' };

export function validateHoldingShares(n: number): HoldingSharesValidation {
  if (!Number.isFinite(n)) return { ok: false, reason: 'not-finite' };
  if (n <= 0) return { ok: false, reason: 'non-positive' };
  return { ok: true, shares: n };
}

export interface AnnualDividendEstimate {
  symbol: string;
  name: string;
  shares: number;
  annualDividend: number;       // 보유 통화 기준
  currency: 'USD' | 'KRW';
  yieldPct: number;
  frequency: DividendFrequency;
}

export function estimateAnnualDividends(holdings: DividendHolding[]): AnnualDividendEstimate[] {
  if (!Array.isArray(holdings)) return [];
  const result: AnnualDividendEstimate[] = [];
  for (const h of holdings) {
    const meta = DIVIDEND_UNIVERSE.find(d => d.symbol === h.symbol);
    if (!meta) continue;
    const paymentsPerYear =
      meta.frequency === 'monthly'     ? 12 :
      meta.frequency === 'quarterly'   ? 4 :
      meta.frequency === 'semi-annual' ? 2 : 1;
    const annualDividend = meta.paymentPerShare * paymentsPerYear * h.shares;
    result.push({
      symbol: meta.symbol,
      name: meta.name,
      shares: h.shares,
      annualDividend,
      currency: meta.currency,
      yieldPct: meta.yieldPct,
      frequency: meta.frequency,
    });
  }
  return result.sort((a, b) => b.annualDividend - a.annualDividend);
}

// 사용자의 보유 종목 (localStorage)
export const DIV_HOLDINGS_KEY = 'tg_dividend_holdings_v1';

export function loadDividendHoldings(): DividendHolding[] {
  if (typeof window === 'undefined') return seedHoldings();
  try {
    const raw = window.localStorage.getItem(DIV_HOLDINGS_KEY);
    if (!raw) return seedHoldings();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seedHoldings();
    return parsed;
  } catch (e) {
    console.warn('[dividend] load failed', e);
    return seedHoldings();
  }
}

export function saveDividendHoldings(holdings: DividendHolding[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DIV_HOLDINGS_KEY, JSON.stringify(holdings));
  } catch (e) {
    console.warn('[dividend] save failed', e);
  }
}

function seedHoldings(): DividendHolding[] {
  return [
    { symbol: 'SCHD', shares: 25 },
    { symbol: 'JEPI', shares: 18 },
    { symbol: 'O',    shares: 30 },
    { symbol: 'MSFT', shares: 4 },
  ];
}
