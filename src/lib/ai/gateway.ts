// src/lib/ai/gateway.ts
// AI 비용 통제 게이트웨이.
// 원칙: 매 요청마다 AI를 부르지 않는다. 규칙 엔진이 먼저 판단하고, 필요할 때만 승급한다.
//
//  L0 규칙 엔진   — 무료. 지표·손절·포지션 계산은 코드가 한다.
//  L1 저가 AI     — 뉴스 요약, 일반 설명. 공유 캐시로 여러 사용자가 재사용.
//  L2 고급 AI     — 신호가 강하거나 위험할 때만.
//  L3 다중 AI 합의 — 중요한 매매에만.

export type AiTier = 'L0_RULES' | 'L1_CHEAP' | 'L2_PREMIUM' | 'L3_COMMITTEE';
export type PlanType = 'free' | 'basic' | 'pro' | 'byok';

export interface TierInfo { tier: AiTier; label: string; costWeight: number; desc: string }

export const TIERS: Record<AiTier, TierInfo> = {
  L0_RULES:     { tier: 'L0_RULES',     label: '규칙 엔진',   costWeight: 0,  desc: '지표·위험 계산 (AI 호출 없음)' },
  L1_CHEAP:     { tier: 'L1_CHEAP',     label: '기본 AI',     costWeight: 1,  desc: '뉴스 요약·간단 해석' },
  L2_PREMIUM:   { tier: 'L2_PREMIUM',   label: '고급 AI',     costWeight: 6,  desc: '심층 분석·이상 상황 판단' },
  L3_COMMITTEE: { tier: 'L3_COMMITTEE', label: '다중 AI 합의', costWeight: 20, desc: '여러 모델 의견 비교' },
};

// 플랜별 일일 한도 (costWeight 기준 크레딧)
export interface PlanQuota {
  dailyCredits: number;       // -1 = 무제한
  maxTier: AiTier;
  label: string;
}

export const PLAN_QUOTAS: Record<PlanType, PlanQuota> = {
  free:  { dailyCredits: 5,   maxTier: 'L1_CHEAP',     label: '무료' },
  basic: { dailyCredits: 60,  maxTier: 'L2_PREMIUM',   label: '베이직' },
  pro:   { dailyCredits: 300, maxTier: 'L3_COMMITTEE', label: '프로' },
  byok:  { dailyCredits: -1,  maxTier: 'L3_COMMITTEE', label: '개인 키' },
};

const TIER_ORDER: AiTier[] = ['L0_RULES', 'L1_CHEAP', 'L2_PREMIUM', 'L3_COMMITTEE'];
const tierRank = (t: AiTier) => TIER_ORDER.indexOf(t);

// ── 승급 판단 ────────────────────────────────────────
export interface EscalationInput {
  kind: 'news' | 'signal' | 'explain' | 'decision';
  signalConfidence?: number;    // 0~1
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  newsImportance?: number;      // 0~100
  positionValue?: number;       // 이 판단이 걸린 금액 ($)
  isAnomaly?: boolean;          // 이상 상황 감지
}

export interface EscalationResult {
  tier: AiTier;
  reason: string;
  cacheable: boolean;           // 여러 사용자가 재사용 가능한가
  cacheTtlSec: number;
}

// 어느 계층까지 올라갈지 결정 — 기본은 최소 계층
export function decideTier(input: EscalationInput): EscalationResult {
  const { kind, signalConfidence = 0, riskLevel = 'low', newsImportance = 0, positionValue = 0, isAnomaly = false } = input;

  // 뉴스: 중요도에 따라
  if (kind === 'news') {
    if (newsImportance >= 90) return { tier: 'L2_PREMIUM', reason: `중요도 ${newsImportance} — 심층 분석 필요`, cacheable: true, cacheTtlSec: 900 };
    if (newsImportance >= 50) return { tier: 'L1_CHEAP', reason: `중요도 ${newsImportance} — 요약만`, cacheable: true, cacheTtlSec: 1800 };
    return { tier: 'L0_RULES', reason: `중요도 ${newsImportance} — 목록 저장만, AI 호출 안 함`, cacheable: true, cacheTtlSec: 3600 };
  }

  // 이상 상황은 무조건 승급
  if (isAnomaly) return { tier: 'L2_PREMIUM', reason: '이상 상황 감지 — 고급 분석', cacheable: false, cacheTtlSec: 0 };

  // 매매 판단: 금액·확신도·위험도로 승급
  if (kind === 'decision' || kind === 'signal') {
    if (riskLevel === 'critical' || positionValue >= 50000) {
      return { tier: 'L3_COMMITTEE', reason: `고위험/고액($${positionValue.toFixed(0)}) — 다중 AI 합의`, cacheable: false, cacheTtlSec: 0 };
    }
    if (riskLevel === 'high' || signalConfidence >= 0.8 || positionValue >= 10000) {
      return { tier: 'L2_PREMIUM', reason: `강한 신호(확신 ${(signalConfidence * 100).toFixed(0)}%) — 고급 분석`, cacheable: false, cacheTtlSec: 0 };
    }
    if (signalConfidence >= 0.5) {
      return { tier: 'L1_CHEAP', reason: '보통 신호 — 기본 확인', cacheable: false, cacheTtlSec: 0 };
    }
    return { tier: 'L0_RULES', reason: '약한 신호 — 규칙 엔진만으로 충분', cacheable: false, cacheTtlSec: 0 };
  }

  // 설명 요청
  return { tier: 'L1_CHEAP', reason: '사용자 설명 요청', cacheable: false, cacheTtlSec: 0 };
}

// ── 할당량 판정 ──────────────────────────────────────
export interface QuotaCheck {
  allowed: boolean;
  effectiveTier: AiTier;        // 한도 때문에 낮춰진 실제 계층
  downgraded: boolean;
  creditsNeeded: number;
  creditsRemaining: number;     // -1 = 무제한
  reason: string;
}

export function checkQuota(
  requested: AiTier,
  plan: PlanType,
  usedCreditsToday: number,
  hasOwnKey = false
): QuotaCheck {
  // 개인 키 사용자는 본인 계정으로 결제 → 한도 없음
  const effectivePlan: PlanType = hasOwnKey ? 'byok' : plan;
  const quota = PLAN_QUOTAS[effectivePlan] || PLAN_QUOTAS.free;

  // 플랜 상한을 넘는 계층은 강등
  let tier = requested;
  let downgraded = false;
  if (tierRank(tier) > tierRank(quota.maxTier)) {
    tier = quota.maxTier;
    downgraded = true;
  }

  const creditsNeeded = TIERS[tier].costWeight;
  const remaining = quota.dailyCredits < 0 ? -1 : Math.max(0, quota.dailyCredits - usedCreditsToday);

  // 무제한
  if (quota.dailyCredits < 0) {
    return { allowed: true, effectiveTier: tier, downgraded, creditsNeeded, creditsRemaining: -1,
      reason: hasOwnKey ? '개인 API 키 사용 — 한도 없음' : `${quota.label} 플랜 — 한도 없음` };
  }

  // 규칙 엔진은 항상 허용 (비용 0)
  if (tier === 'L0_RULES') {
    return { allowed: true, effectiveTier: tier, downgraded, creditsNeeded: 0, creditsRemaining: remaining, reason: '규칙 엔진 — 비용 없음' };
  }

  // 크레딧 부족 → 더 낮은 계층으로 강등 시도
  if (creditsNeeded > remaining) {
    for (let i = tierRank(tier) - 1; i >= 0; i--) {
      const lower = TIER_ORDER[i];
      if (TIERS[lower].costWeight <= remaining) {
        return {
          allowed: true, effectiveTier: lower, downgraded: true,
          creditsNeeded: TIERS[lower].costWeight, creditsRemaining: remaining,
          reason: `일일 한도 부족(${remaining}/${quota.dailyCredits}) — ${TIERS[lower].label}로 낮춤`,
        };
      }
    }
    return {
      allowed: false, effectiveTier: 'L0_RULES', downgraded: true,
      creditsNeeded, creditsRemaining: remaining,
      reason: `일일 AI 한도 소진 (${quota.label} 플랜 ${quota.dailyCredits} 크레딧). 내일 초기화되거나, 개인 API 키를 연결하면 계속 사용할 수 있어요`,
    };
  }

  return { allowed: true, effectiveTier: tier, downgraded, creditsNeeded, creditsRemaining: remaining,
    reason: `${quota.label} 플랜 · 잔여 ${remaining}/${quota.dailyCredits} 크레딧` };
}

// ── 공유 캐시 키 ─────────────────────────────────────
// 같은 뉴스/시장 분석은 여러 사용자가 재사용 → 호출 1번으로 N명 커버
export function sharedCacheKey(kind: string, subject: string, tier: AiTier): string {
  const norm = subject.toLowerCase().replace(/\s+/g, '_').slice(0, 80);
  return `ai:${kind}:${norm}:${tier}`;
}
