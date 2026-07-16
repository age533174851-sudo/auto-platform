// src/lib/autotrade/dynamicSizing.ts
// ATR 기반 동적 포지션 — 변동성 낮으면 크게, 높으면 작게 베팅.
// "항상 시드 10%" 대신 변동성 티어로 자동 조정 → 위험 균등화.

export interface VolTier {
  max: number;       // ATR% 상한 (이 값 이하이면 이 티어)
  posPct: number;    // 이 티어의 포지션 비중 (시드 대비 %)
  label: string;
  color: string;
}

// 기본 티어: 변동성이 낮을수록 크게, 높을수록 작게
export const DEFAULT_VOL_TIERS: VolTier[] = [
  { max: 1.0,  posPct: 25, label: '매우 낮음', color: '#22C55E' },
  { max: 2.0,  posPct: 20, label: '낮음',      color: '#10B981' },
  { max: 4.0,  posPct: 10, label: '보통',      color: '#64748B' },
  { max: 7.0,  posPct: 5,  label: '높음',      color: '#F59E0B' },
  { max: 100,  posPct: 3,  label: '매우 높음', color: '#EF4444' },
];

// True Range 기반 ATR (종가만 있으면 close-to-close로 근사)
export function computeATR(prices: number[], period = 14): number {
  if (prices.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < prices.length; i++) trs.push(Math.abs(prices[i] - prices[i - 1]));
  const n = Math.min(period, trs.length);
  const recent = trs.slice(-n);
  return recent.reduce((a, b) => a + b, 0) / n;
}

// ATR%를 반환 (가격 대비 정규화 → 종목 간 비교 가능)
export function computeATRPct(prices: number[], period = 14): number {
  if (!prices.length) return 0;
  const atr = computeATR(prices, period);
  const price = prices[prices.length - 1];
  return price > 0 ? (atr / price) * 100 : 0;
}

export function tierForVol(atrPct: number, tiers: VolTier[] = DEFAULT_VOL_TIERS): VolTier {
  for (const t of tiers) if (atrPct <= t.max) return t;
  return tiers[tiers.length - 1];
}

export interface SizingPlan {
  atrPct: number;
  tier: VolTier;
  posPct: number;
  positionAmount: number;   // 실제 진입 금액 (equity × posPct)
  vsBaseline: number;       // 고정 10% 대비 배수
  note: string;
}

// 동적 사이징 계획 계산
export function planPositionSize(
  equity: number,
  prices: number[],
  opts: { tiers?: VolTier[]; period?: number; maxCapPct?: number } = {}
): SizingPlan {
  const tiers = opts.tiers ?? DEFAULT_VOL_TIERS;
  const atrPct = computeATRPct(prices, opts.period ?? 14);
  const tier = tierForVol(atrPct, tiers);
  const cap = opts.maxCapPct ?? 100;
  const posPct = Math.min(tier.posPct, cap);
  const positionAmount = Math.round((equity * posPct) / 100);
  const vsBaseline = posPct / 10;   // 고정 10% 대비
  const note = atrPct < 2
    ? '변동성이 낮아 평소보다 크게 진입해도 위험이 낮습니다.'
    : atrPct > 7
      ? '변동성이 매우 커서 손실 위험이 높습니다. 진입을 크게 줄이세요.'
      : '변동성이 보통 수준입니다.';
  return { atrPct, tier, posPct, positionAmount, vsBaseline, note };
}
