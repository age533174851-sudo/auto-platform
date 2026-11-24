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
//
// **저장된 것이 없으면 빈 목록이다.** 예전에는 여기서 예시 규칙 셋을
// 돌려줬는데, 그 예시에 "누적 1,200,000원 · 8회 실행" 같은 **이력**이
// 들어 있었고 화면은 그것을 사용자의 실제 규칙처럼 그렸다. 적립한 적 없는
// 사람이 120만 원을 넣은 줄 알게 되고, 스위치 하나만 눌러도 그 숫자가
// 저장돼 남는다. 없는 것은 없다고 그린다 — 화면에 빈 상태가 이미 있다.
export function loadDCARules(): DCARule[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(DCA_STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (e) {
    console.warn('[dca] load failed', e);
    return [];
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

/**
 * 새 룰을 만들 때 쓰는 값 = **기본값**.
 *
 * 상수로 빼는 이유: 화면이 "이 값이 기본과 다릅니다"를 말하려면 기본이
 * 무엇인지 알아야 한다. createBlankRule 안에만 있으면 화면에서 볼 수 없고,
 * 화면이 자기 사본을 들면 언젠가 둘이 어긋나 **틀린 기본값을 알려준다.**
 */
export const DCA_DEFAULTS = {
  baseAmount: 100000,
  dipBoost:    { enabled: true,  threshold: -5, multiplier: 2 },
  overheatCut: { enabled: false, threshold: 20, multiplier: 0.5 },
  reinvestDividend: true,
} as const;

export function createBlankRule(): DCARule {
  return {
    id: `dca_${Date.now().toString(36)}`,
    enabled: true,
    name: '새 적립 룰',
    symbol: 'QQQ',
    symbolName: 'Invesco QQQ',
    frequency: 'monthly',
    baseAmount: DCA_DEFAULTS.baseAmount,
    dipBoost: { ...DCA_DEFAULTS.dipBoost },
    overheatCut: { ...DCA_DEFAULTS.overheatCut },
    reinvestDividend: DCA_DEFAULTS.reinvestDividend,
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
