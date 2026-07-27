// ─────────────────────────────────────────────────────────────
// TRAIGO — AI Recommended Portfolio Engine
// 입력: 목표 / 기간 / 월투자금 / 성향 / 선호자산 / 위험허용도
// 출력: 종목별 비중 (합계 100%) + 근거 + 예상 수익 시뮬레이션
//
// 외부 API 호출 없는 룰 기반 시스템 — 빠르고 결정적이며 비용 0
// 마스터프롬프트의 "AI 반도체 장투 포트폴리오" 예시를 기준 데이터로
// ─────────────────────────────────────────────────────────────

export type RiskProfile = 'conservative' | 'balanced' | 'aggressive' | 'extreme';
export type Theme = 'ai_semi' | 'us_tech' | 'dividend' | 'crypto' | 'broad_etf' | 'kr_growth';
export type Horizon = '1y' | '3y' | '5y' | '10y';

export interface AIPortfolioInput {
  goalAmount: number;        // 목표 금액 (KRW)
  horizon: Horizon;          // 투자 기간
  monthly: number;           // 월 투자금 (KRW)
  risk: RiskProfile;         // 성향
  themes: Theme[];           // 선호 (복수 선택)
  riskTolerance: number;     // 위험허용도 0~100
}

export interface AllocItem {
  symbol: string;
  name: string;
  category: 'us_stock' | 'us_etf' | 'kr_stock' | 'kr_etf' | 'crypto' | 'cash' | 'bond';
  weight: number;            // %
  rationale: string;
  expectedAnnualReturn: number; // 추정 연수익률 (%, 보수적)
  volatility: number;        // 추정 변동성 (%)
}

export interface AIPortfolioResult {
  allocations: AllocItem[];
  totalWeight: number;       // 검증용 (100이어야 함)
  expectedAnnualReturn: number;
  expectedVolatility: number;
  riskScore: number;         // 1~10
  projection: { months: number; principal: number; expected: number; conservative: number; optimistic: number }[];
  monthsToGoal: number | null; // 목표 달성까지 개월 수 (불가능하면 null)
  summary: string;
  warnings: string[];
}

// ── 자산 마스터 데이터 (실제 시장 데이터 기반 보수적 추정) ─
interface AssetMeta {
  symbol: string;
  name: string;
  category: AllocItem['category'];
  themes: Theme[];
  annualReturn: number; // 추정 연수익률 (보수적, 과거 10년 중앙값 - 1%p)
  volatility: number;
}

const ASSETS: AssetMeta[] = [
  // US ETF (broad)
  { symbol: 'QQQ',  name: 'Invesco QQQ',           category: 'us_etf',   themes: ['us_tech','broad_etf','ai_semi'],   annualReturn: 13, volatility: 22 },
  { symbol: 'VOO',  name: 'Vanguard S&P 500',      category: 'us_etf',   themes: ['broad_etf'],                       annualReturn: 10, volatility: 16 },
  { symbol: 'VTI',  name: 'Vanguard Total Mkt',    category: 'us_etf',   themes: ['broad_etf'],                       annualReturn: 9,  volatility: 16 },
  { symbol: 'SCHD', name: 'Schwab Dividend ETF',   category: 'us_etf',   themes: ['dividend'],                        annualReturn: 8,  volatility: 14 },
  { symbol: 'VYM',  name: 'Vanguard High Div',     category: 'us_etf',   themes: ['dividend'],                        annualReturn: 7,  volatility: 13 },

  // US Stocks (AI/Semi)
  { symbol: 'NVDA', name: 'NVIDIA',                category: 'us_stock', themes: ['ai_semi','us_tech'],               annualReturn: 22, volatility: 45 },
  { symbol: 'MSFT', name: 'Microsoft',             category: 'us_stock', themes: ['us_tech','ai_semi','dividend'],    annualReturn: 14, volatility: 24 },
  { symbol: 'GOOGL',name: 'Alphabet',              category: 'us_stock', themes: ['us_tech','ai_semi'],               annualReturn: 13, volatility: 26 },
  { symbol: 'AVGO', name: 'Broadcom',              category: 'us_stock', themes: ['ai_semi','dividend'],              annualReturn: 18, volatility: 30 },
  { symbol: 'TSM',  name: 'TSMC',                  category: 'us_stock', themes: ['ai_semi'],                         annualReturn: 15, volatility: 32 },
  { symbol: 'AAPL', name: 'Apple',                 category: 'us_stock', themes: ['us_tech','dividend'],              annualReturn: 12, volatility: 25 },

  // KR (성장)
  { symbol: '005930', name: '삼성전자',            category: 'kr_stock', themes: ['ai_semi','kr_growth'],             annualReturn: 9,  volatility: 28 },
  { symbol: '000660', name: 'SK하이닉스',          category: 'kr_stock', themes: ['ai_semi','kr_growth'],             annualReturn: 12, volatility: 38 },
  { symbol: '360750', name: 'TIGER 미국S&P500',    category: 'kr_etf',   themes: ['broad_etf'],                       annualReturn: 10, volatility: 18 },

  // Crypto
  { symbol: 'BTC',  name: 'Bitcoin',               category: 'crypto',   themes: ['crypto'],                          annualReturn: 25, volatility: 65 },
  { symbol: 'ETH',  name: 'Ethereum',              category: 'crypto',   themes: ['crypto'],                          annualReturn: 22, volatility: 75 },

  // Defensive
  { symbol: 'CASH', name: '현금/MMF',              category: 'cash',     themes: [],                                  annualReturn: 3,  volatility: 1  },
  { symbol: 'BND',  name: 'Vanguard Bond ETF',     category: 'bond',     themes: [],                                  annualReturn: 4,  volatility: 6  },
];

// ── 성향별 자산군 비중 가이드 ──────────────────────────
const RISK_PRESET: Record<RiskProfile, { stock: number; crypto: number; bond: number; cash: number }> = {
  conservative: { stock: 50, crypto: 0,  bond: 35, cash: 15 },
  balanced:     { stock: 65, crypto: 5,  bond: 20, cash: 10 },
  aggressive:   { stock: 75, crypto: 15, bond: 5,  cash: 5  },
  extreme:      { stock: 70, crypto: 25, bond: 0,  cash: 5  },
};

export const RISK_LABEL: Record<RiskProfile, string> = {
  conservative: '안정형',
  balanced:     '중립형',
  aggressive:   '공격형',
  extreme:      '초공격형',
};

export const THEME_LABEL: Record<Theme, string> = {
  ai_semi:    'AI / 반도체',
  us_tech:    '미국 빅테크',
  dividend:   '배당주',
  crypto:     '코인',
  broad_etf:  'ETF 분산',
  kr_growth:  '한국 성장주',
};

export const HORIZON_LABEL: Record<Horizon, string> = {
  '1y': '1년', '3y': '3년', '5y': '5년', '10y': '10년',
};

export const HORIZON_MONTHS: Record<Horizon, number> = {
  '1y': 12, '3y': 36, '5y': 60, '10y': 120,
};

// ── 추천 엔진 ───────────────────────────────────────────
export function generatePortfolio(input: AIPortfolioInput): AIPortfolioResult {
  const warnings: string[] = [];
  const themes = Array.isArray(input.themes) && input.themes.length > 0 ? input.themes : (['broad_etf'] as Theme[]);
  const preset = RISK_PRESET[input.risk] || RISK_PRESET.balanced;

  // riskTolerance(0~100)를 preset에 반영 — 50을 중립으로
  const tolt = Math.max(0, Math.min(100, input.riskTolerance));
  const shift = (tolt - 50) / 100; // -0.5 ~ +0.5
  let stockW = Math.max(0, Math.min(95, preset.stock + shift * 20));
  let cryptoW = Math.max(0, Math.min(40, preset.crypto + shift * 10));
  let bondW = Math.max(0, preset.bond - shift * 15);
  let cashW = Math.max(2, 100 - stockW - cryptoW - bondW);
  // 정규화
  const sum0 = stockW + cryptoW + bondW + cashW;
  stockW = (stockW/sum0)*100; cryptoW = (cryptoW/sum0)*100; bondW = (bondW/sum0)*100; cashW = (cashW/sum0)*100;

  // ── Stock 슬롯에 들어갈 종목 선정 ───────────────────
  // 선호 테마와 매칭되는 자산 중 변동성 낮은 순으로 5~6개
  const stockPool = ASSETS.filter(a =>
    (a.category === 'us_stock' || a.category === 'us_etf' || a.category === 'kr_stock' || a.category === 'kr_etf') &&
    a.themes.some(t => themes.includes(t))
  );

  // 만약 pool이 비면 broad_etf로 fallback
  let pool = stockPool;
  if (pool.length === 0) {
    pool = ASSETS.filter(a => a.themes.includes('broad_etf'));
    warnings.push('선호 테마와 매칭되는 종목이 없어 광범위 ETF로 대체했습니다.');
  }

  // 분산 가중: 변동성 작은 것을 우선
  pool = [...pool].sort((a, b) => a.volatility - b.volatility);

  // 성향별 종목 수
  const stockSlots = input.risk === 'conservative' ? 4 : input.risk === 'extreme' ? 7 : 5;
  const picked = pool.slice(0, Math.min(stockSlots, pool.length));

  // 변동성 역가중 → 정규화 (변동성 낮을수록 높은 비중)
  const invVols = picked.map(p => 1 / Math.max(8, p.volatility));
  const invSum = invVols.reduce((s, v) => s + v, 0) || 1;

  const stockAllocs: AllocItem[] = picked.map((p, i) => ({
    symbol: p.symbol,
    name: p.name,
    category: p.category,
    weight: Number(((invVols[i] / invSum) * stockW).toFixed(1)),
    rationale: `${p.themes.map(t => THEME_LABEL[t]).join(' · ')} 노출 / 변동성 ${p.volatility}%`,
    expectedAnnualReturn: p.annualReturn,
    volatility: p.volatility,
  }));

  // ── Crypto 슬롯 ────────────────────────────────────
  const cryptoAllocs: AllocItem[] = [];
  if (cryptoW > 0 && themes.includes('crypto')) {
    cryptoAllocs.push({
      symbol: 'BTC', name: 'Bitcoin', category: 'crypto',
      weight: Number((cryptoW * 0.7).toFixed(1)),
      rationale: '디지털 금 · 시장 대표 자산',
      expectedAnnualReturn: 25, volatility: 65,
    });
    if (input.risk === 'aggressive' || input.risk === 'extreme') {
      cryptoAllocs.push({
        symbol: 'ETH', name: 'Ethereum', category: 'crypto',
        weight: Number((cryptoW * 0.3).toFixed(1)),
        rationale: '스마트컨트랙트 플랫폼 1위',
        expectedAnnualReturn: 22, volatility: 75,
      });
    } else {
      // BTC 100%
      cryptoAllocs[0].weight = Number(cryptoW.toFixed(1));
    }
  } else if (cryptoW > 0) {
    // 선호에 crypto 없으면 비중 → 채권/현금으로 이동
    bondW += cryptoW * 0.6;
    cashW += cryptoW * 0.4;
    cryptoW = 0;
  }

  // ── Bond / Cash ────────────────────────────────────
  const defensiveAllocs: AllocItem[] = [];
  if (bondW > 0.5) {
    defensiveAllocs.push({
      symbol: 'BND', name: 'Vanguard Bond ETF', category: 'bond',
      weight: Number(bondW.toFixed(1)),
      rationale: '하락장 방어 / 인컴',
      expectedAnnualReturn: 4, volatility: 6,
    });
  }
  defensiveAllocs.push({
    symbol: 'CASH', name: '현금 / MMF', category: 'cash',
    weight: Number(cashW.toFixed(1)),
    rationale: '리밸런싱 탄약 · 폭락장 추가매수 대기',
    expectedAnnualReturn: 3, volatility: 1,
  });

  const allocations = [...stockAllocs, ...cryptoAllocs, ...defensiveAllocs];

  // 합계 100으로 보정 (반올림 오차)
  const total = allocations.reduce((s, a) => s + a.weight, 0);
  if (Math.abs(total - 100) > 0.01 && allocations.length > 0) {
    const diff = 100 - total;
    allocations[0].weight = Number((allocations[0].weight + diff).toFixed(1));
  }

  // ── 포트폴리오 기대수익률 / 변동성 ──────────────────
  const expectedAnnualReturn = allocations.reduce((s, a) => s + (a.weight / 100) * a.expectedAnnualReturn, 0);
  // 단순화: 가중 변동성 (실제로는 공분산 필요하나 모의 용도)
  const expectedVolatility = Math.sqrt(allocations.reduce((s, a) => s + Math.pow((a.weight / 100) * a.volatility, 2), 0)) * 1.8;
  const riskScore = Math.max(1, Math.min(10, Math.round(expectedVolatility / 4)));

  // ── 시뮬레이션 (월별 적립 + 복리) ──────────────────
  const monthlyReturn = expectedAnnualReturn / 100 / 12;
  const months = HORIZON_MONTHS[input.horizon];
  const projection: AIPortfolioResult['projection'] = [];
  let bal = 0;
  let principal = 0;
  for (let m = 1; m <= months; m++) {
    bal = (bal + input.monthly) * (1 + monthlyReturn);
    principal += input.monthly;
    // 분기마다 기록
    if (m % 3 === 0 || m === months) {
      const sigmaMonthly = (expectedVolatility / 100) / Math.sqrt(12);
      const span = bal * sigmaMonthly * Math.sqrt(m) * 1.0;
      projection.push({
        months: m,
        principal,
        expected: Math.round(bal),
        conservative: Math.round(Math.max(principal, bal - span)),
        optimistic:   Math.round(bal + span),
      });
    }
  }

  // ── 목표 달성까지 ──────────────────────────────────
  let monthsToGoal: number | null = null;
  if (input.goalAmount > 0 && monthlyReturn > -1) {
    let testBal = 0;
    for (let m = 1; m <= 600; m++) {
      testBal = (testBal + input.monthly) * (1 + monthlyReturn);
      if (testBal >= input.goalAmount) { monthsToGoal = m; break; }
    }
  }

  // ── 요약 ────────────────────────────────────────────
  const summary = `${RISK_LABEL[input.risk]} 성향 · ${HORIZON_LABEL[input.horizon]} 운용 · 기대 연수익률 ${expectedAnnualReturn.toFixed(1)}% (변동성 ${expectedVolatility.toFixed(0)}%) · 위험점수 ${riskScore}/10`;

  // ── 경고 ────────────────────────────────────────────
  if (input.risk === 'extreme' && cryptoW > 20) warnings.push('코인 비중이 높아 단기 변동성에 매우 취약합니다.');
  if (monthsToGoal !== null && monthsToGoal > months) warnings.push(`현재 월 투자금으로는 목표 ${input.horizon} 내 달성이 어렵습니다 (예상 ${Math.ceil(monthsToGoal/12)}년).`);
  if (input.monthly < 100000) warnings.push('월 투자금이 적어 분산 매수 시 거래비용 비중이 커질 수 있습니다.');

  return {
    allocations,
    totalWeight: allocations.reduce((s, a) => s + a.weight, 0),
    expectedAnnualReturn,
    expectedVolatility,
    riskScore,
    projection,
    monthsToGoal,
    summary,
    warnings,
  };
}
