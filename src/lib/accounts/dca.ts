// ─────────────────────────────────────────────────────────────
// TRAIGO — DCA (Dollar Cost Averaging) Auto-Invest Engine
// 자동 적립: 매일/매주/매월 정액 매수 + 하락시 추가매수 + 과열시 축소
// 마스터프롬프트의 "장투 = 모으기" 핵심 기능
// ─────────────────────────────────────────────────────────────

export type DCAFrequency = 'daily' | 'weekly' | 'monthly';

export interface DCARule {
  id: string;
  enabled: boolean;
  name: string;          // 사용자 지정 룰 이름
  symbol: string;        // 대상 종목 (단일)
  symbolName: string;
  frequency: DCAFrequency;
  baseAmount: number;    // 기본 1회 매수 금액 (KRW)
  dipBoost: {            // 하락시 추가매수
    enabled: boolean;
    threshold: number;   // 하락폭 % (예: -5)
    multiplier: number;  // 매수금액 배수 (예: 2 = 2배)
  };
  overheatCut: {         // 과열시 축소
    enabled: boolean;
    threshold: number;   // 상승폭 % (예: +20)
    multiplier: number;  // 매수금액 배수 (예: 0.5 = 절반)
  };
  reinvestDividend: boolean; // 배당 재투자
  startedAt: number;
  totalInvested: number; // 누적 매수금
  totalShares: number;   // 누적 수량
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
}

export const DCA_STORE_KEY = 'tg_dca_rules_v1';

// ── 빈도별 다음 실행 시각 계산 ───────────────────────
export function computeNextRun(frequency: DCAFrequency, from: number = Date.now()): number {
  const d = new Date(from);
  if (frequency === 'daily') {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  } else if (frequency === 'weekly') {
    // 다음 월요일 9시
    const day = d.getDay();
    const diff = (8 - day) % 7 || 7;
    d.setDate(d.getDate() + diff);
    d.setHours(9, 0, 0, 0);
  } else {
    // 다음 달 1일
    d.setMonth(d.getMonth() + 1, 1);
    d.setHours(9, 0, 0, 0);
  }
  return d.getTime();
}

export const FREQUENCY_LABEL: Record<DCAFrequency, string> = {
  daily:   '매일',
  weekly:  '매주 월요일',
  monthly: '매월 1일',
};

// ── 동적 금액 계산: 하락시 부스트 / 과열시 컷 ─────────
export interface PriceContext {
  currentPrice: number;
  pct7d: number;   // 최근 7일 변화율 (%)
  pct30d: number;  // 최근 30일 변화율 (%)
}

export interface DCAExecutionPreview {
  ruleId: string;
  triggerReason: string;
  amount: number;     // 이번에 매수할 금액
  shares: number;     // 매수 예정 수량
  willExecute: boolean;
}

export function previewExecution(rule: DCARule, ctx: PriceContext): DCAExecutionPreview {
  let amount = rule.baseAmount;
  let triggerReason = '정기 적립';
  let willExecute = rule.enabled;

  if (rule.dipBoost.enabled && ctx.pct7d <= rule.dipBoost.threshold) {
    amount = rule.baseAmount * rule.dipBoost.multiplier;
    triggerReason = `📉 7일 ${ctx.pct7d.toFixed(1)}% 하락 — ${rule.dipBoost.multiplier}배 추가매수`;
  } else if (rule.overheatCut.enabled && ctx.pct30d >= rule.overheatCut.threshold) {
    amount = rule.baseAmount * rule.overheatCut.multiplier;
    triggerReason = `🔥 30일 ${ctx.pct30d.toFixed(1)}% 과열 — 매수금액 ${(rule.overheatCut.multiplier * 100).toFixed(0)}%로 축소`;
  }

  const price = Math.max(1, ctx.currentPrice);
  const shares = Number((amount / price).toFixed(6));
  return { ruleId: rule.id, triggerReason, amount, shares, willExecute };
}

// ── localStorage I/O ───────────────────────────────────
export function loadDCARules(): DCARule[] {
  if (typeof window === 'undefined') return seedRules();
  try {
    const raw = window.localStorage.getItem(DCA_STORE_KEY);
    if (!raw) return seedRules();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seedRules();
    return parsed;
  } catch (e) {
    console.warn('[dca] load failed', e);
    return seedRules();
  }
}

export function saveDCARules(rules: DCARule[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DCA_STORE_KEY, JSON.stringify(rules));
  } catch (e) {
    console.warn('[dca] save failed', e);
  }
}

function seedRules(): DCARule[] {
  const now = Date.now();
  return [
    {
      id: 'dca_qqq', enabled: true, name: 'QQQ 매주 적립',
      symbol: 'QQQ', symbolName: 'Invesco QQQ',
      frequency: 'weekly', baseAmount: 100000,
      dipBoost:     { enabled: true,  threshold: -5,  multiplier: 2 },
      overheatCut:  { enabled: true,  threshold: 20,  multiplier: 0.5 },
      reinvestDividend: true,
      startedAt: now - 86400_000 * 60,
      totalInvested: 1_200_000, totalShares: 2.1,
      lastRunAt: now - 86400_000 * 3, nextRunAt: computeNextRun('weekly'),
      runCount: 8,
    },
    {
      id: 'dca_btc', enabled: true, name: 'BTC 매월 모으기',
      symbol: 'BTC', symbolName: 'Bitcoin',
      frequency: 'monthly', baseAmount: 200000,
      dipBoost:     { enabled: true,  threshold: -10, multiplier: 1.5 },
      overheatCut:  { enabled: false, threshold: 30,  multiplier: 0.5 },
      reinvestDividend: false,
      startedAt: now - 86400_000 * 180,
      totalInvested: 1_200_000, totalShares: 0.014,
      lastRunAt: now - 86400_000 * 12, nextRunAt: computeNextRun('monthly'),
      runCount: 6,
    },
    {
      id: 'dca_schd', enabled: false, name: 'SCHD 배당 재투자',
      symbol: 'SCHD', symbolName: 'Schwab Dividend ETF',
      frequency: 'monthly', baseAmount: 150000,
      dipBoost:     { enabled: false, threshold: -5,  multiplier: 2 },
      overheatCut:  { enabled: false, threshold: 20,  multiplier: 0.5 },
      reinvestDividend: true,
      startedAt: now - 86400_000 * 30,
      totalInvested: 0, totalShares: 0,
      nextRunAt: computeNextRun('monthly'),
      runCount: 0,
    },
  ];
}

export function createBlankRule(): DCARule {
  return {
    id: `dca_${Date.now().toString(36)}`,
    enabled: true,
    name: '새 적립 룰',
    symbol: 'QQQ',
    symbolName: 'Invesco QQQ',
    frequency: 'monthly',
    baseAmount: 100000,
    dipBoost: { enabled: true, threshold: -5, multiplier: 2 },
    overheatCut: { enabled: false, threshold: 20, multiplier: 0.5 },
    reinvestDividend: true,
    startedAt: Date.now(),
    totalInvested: 0,
    totalShares: 0,
    nextRunAt: computeNextRun('monthly'),
    runCount: 0,
  };
}

// 누적 적립 시뮬레이션 (사용자가 보기용)
export function projectAccumulation(rule: DCARule, months: number, assumedAnnualReturn: number): { month: number; invested: number; value: number }[] {
  const monthlyReturn = assumedAnnualReturn / 100 / 12;
  const perMonth = rule.frequency === 'daily' ? rule.baseAmount * 30 : rule.frequency === 'weekly' ? rule.baseAmount * 4.33 : rule.baseAmount;
  const out: { month: number; invested: number; value: number }[] = [];
  let bal = rule.totalInvested;
  let invested = rule.totalInvested;
  for (let m = 1; m <= months; m++) {
    bal = (bal + perMonth) * (1 + monthlyReturn);
    invested += perMonth;
    if (m % Math.max(1, Math.floor(months / 12)) === 0 || m === months) {
      out.push({ month: m, invested: Math.round(invested), value: Math.round(bal) });
    }
  }
  return out;
}
