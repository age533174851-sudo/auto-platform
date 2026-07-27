// src/lib/ai/runtime.ts
// AI 게이트웨이 실행 계층 — 할당량 확인 → 캐시 조회 → 키 선택 → 호출 → 사용량 기록.
// 모든 AI 호출은 이 계층을 거쳐야 비용이 통제된다.
import { decideTier, checkQuota, sharedCacheKey, TIERS, type AiTier, type PlanType, type EscalationInput } from './gateway';

export interface AiRequestContext {
  userId?: string | null;
  plan?: PlanType;
  subject: string;            // 캐시 키에 쓰일 대상 (뉴스 제목, 심볼 등)
  escalation: EscalationInput;
}

export interface AiGateDecision {
  proceed: boolean;           // AI를 호출해도 되는가
  tier: AiTier;
  tierLabel: string;
  reason: string;
  downgraded: boolean;
  creditsNeeded: number;
  creditsRemaining: number;
  useOwnKey: boolean;
  provider?: string;
  cacheKey?: string;
  cached?: any;               // 캐시 적중 시 결과
  userMessage?: string;       // 사용자에게 보여줄 안내
}

// 오늘 사용한 크레딧
async function getUsedCredits(sb: any, userId: string): Promise<number> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await sb.from('ai_usage')
      .select('credits').eq('user_id', userId).eq('usage_date', today).eq('used_own_key', false);
    if (!Array.isArray(data)) return 0;
    return data.reduce((a: number, r: any) => a + (Number(r.credits) || 0), 0);
  } catch { return 0; }
}

// 개인 키 조회 (있으면 그 키로 호출 → 사용자 계정에서 결제)
async function getOwnKey(sb: any, userId: string): Promise<{ provider: string; key: string } | null> {
  try {
    const { data } = await sb.from('ai_keys')
      .select('provider, key_enc').eq('user_id', userId).eq('active', true).limit(1).maybeSingle();
    if (!data?.key_enc) return null;
    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    return { provider: data.provider, key: decryptSecret(data.key_enc) };
  } catch { return null; }
}

// 공유 캐시 조회
async function getCached(sb: any, cacheKey: string): Promise<any | null> {
  try {
    const { data } = await sb.from('ai_cache')
      .select('result, expires_at').eq('cache_key', cacheKey).maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    // 적중 카운트 증가 (실패해도 무시)
    try { await sb.rpc('increment_cache_hit', { k: cacheKey }); } catch {}
    return data.result;
  } catch { return null; }
}

export async function saveCached(sb: any, cacheKey: string, kind: string, tier: AiTier, result: any, ttlSec: number) {
  try {
    await sb.from('ai_cache').upsert({
      cache_key: cacheKey, kind, tier, result,
      expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
    });
  } catch {}
}

// 사용량 기록
export async function recordUsage(
  sb: any,
  args: { userId?: string | null; tier: AiTier; kind?: string; usedOwnKey: boolean; cacheHit: boolean; inputTokens?: number; outputTokens?: number }
) {
  try {
    await sb.from('ai_usage').insert({
      user_id: args.userId || null,
      tier: args.tier,
      kind: args.kind || null,
      credits: args.cacheHit ? 0 : TIERS[args.tier].costWeight,
      used_own_key: args.usedOwnKey,
      cache_hit: args.cacheHit,
      input_tokens: args.inputTokens ?? null,
      output_tokens: args.outputTokens ?? null,
    });
  } catch {}
}

// ── 메인: AI 호출 전에 반드시 통과해야 하는 관문 ──
export async function gateAiRequest(sb: any, ctx: AiRequestContext): Promise<AiGateDecision> {
  const esc = decideTier(ctx.escalation);

  // L0는 AI를 부르지 않는다 — 즉시 반환
  if (esc.tier === 'L0_RULES') {
    return {
      proceed: false, tier: 'L0_RULES', tierLabel: TIERS.L0_RULES.label,
      reason: esc.reason, downgraded: false, creditsNeeded: 0, creditsRemaining: -1,
      useOwnKey: false,
      userMessage: '규칙 엔진으로 처리했어요 (AI 호출 없음)',
    };
  }

  // 캐시 먼저 확인 (비용 0)
  let cacheKey: string | undefined;
  if (esc.cacheable && sb) {
    cacheKey = sharedCacheKey(ctx.escalation.kind, ctx.subject, esc.tier);
    const cached = await getCached(sb, cacheKey);
    if (cached) {
      await recordUsage(sb, { userId: ctx.userId, tier: esc.tier, kind: ctx.escalation.kind, usedOwnKey: false, cacheHit: true });
      return {
        proceed: false, tier: esc.tier, tierLabel: TIERS[esc.tier].label,
        reason: '기존 분석 재사용 (캐시 적중)', downgraded: false,
        creditsNeeded: 0, creditsRemaining: -1, useOwnKey: false,
        cacheKey, cached,
        userMessage: '최근 분석 결과를 재사용했어요',
      };
    }
  }

  // 개인 키 확인
  let ownKey: { provider: string; key: string } | null = null;
  if (sb && ctx.userId) ownKey = await getOwnKey(sb, ctx.userId);

  // 할당량
  const used = sb && ctx.userId && !ownKey ? await getUsedCredits(sb, ctx.userId) : 0;
  const q = checkQuota(esc.tier, ctx.plan || 'free', used, !!ownKey);

  return {
    proceed: q.allowed && q.effectiveTier !== 'L0_RULES',
    tier: q.effectiveTier,
    tierLabel: TIERS[q.effectiveTier].label,
    reason: q.downgraded ? `${esc.reason} → ${q.reason}` : esc.reason,
    downgraded: q.downgraded,
    creditsNeeded: q.creditsNeeded,
    creditsRemaining: q.creditsRemaining,
    useOwnKey: !!ownKey,
    provider: ownKey?.provider,
    cacheKey,
    userMessage: !q.allowed ? q.reason : (q.downgraded ? q.reason : undefined),
  };
}
