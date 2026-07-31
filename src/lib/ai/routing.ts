// src/lib/ai/routing.ts
//
// **어느 AI를, 어느 길로 부를 것인가.**
//
// providers.ts에서 떼어냈다. 이유는 하나다: 그 파일은 Anthropic 공식 SDK를
// import하는데, 테스트 하네스는 node_modules 없이 컴파일한다. 판정을 같이
// 두면 **이 판정에 테스트를 붙일 수 없다.**
//
// 그리고 이 판정은 테스트가 꼭 필요하다. 화면(어느 AI가 붙었는지)과 실제
// 호출이 같은 함수를 봐야 하기 때문이다. 갈라지면 화면에는 "Grok 사용 가능"
// 이라고 뜨는데 부르면 실패한다.
import type { AiTier } from './gateway';

export type AiProvider = 'openai' | 'anthropic' | 'gemini' | 'grok' | 'perplexity';

/** 화면·집계에서 순서를 맞추기 위한 전체 목록. 라우트가 각자 적지 않게 */
export const ALL_PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'gemini', 'grok', 'perplexity'];

export const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI', anthropic: 'Claude', gemini: 'Gemini',
  grok: 'Grok', perplexity: 'Perplexity',
};

// ── 모델 선택 ─────────────────────────────────────────────────
// 모델 ID는 제공자 쪽에서 계속 바뀌므로 환경변수로 덮어쓸 수 있게 둔다.
export const MODELS = {
  openai: {
    cheap:   process.env.OPENAI_MODEL_CHEAP   || 'gpt-4o-mini',
    premium: process.env.OPENAI_MODEL_PREMIUM || 'gpt-4o',
  },
  gemini: {
    cheap:   process.env.GEMINI_MODEL_CHEAP   || 'gemini-2.0-flash',
    premium: process.env.GEMINI_MODEL_PREMIUM || 'gemini-2.5-pro',
  },
  // Anthropic은 모델을 나누지 않는다. 깊이/비용은 effort로 조절한다.
  anthropic: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  // 아래 둘은 모델 ID가 특히 자주 바뀐다. 404가 나면 여기(환경변수)에서 맞춘다 —
  // 코드를 고쳐야만 고칠 수 있는 값으로 두지 않는다.
  grok: process.env.GROK_MODEL || 'grok-4',
  perplexity: process.env.PERPLEXITY_MODEL || 'sonar',
};

export const isCheap = (tier?: AiTier) => tier === 'L1_CHEAP';

// ── 어떻게 부를 것인가 (직접 / OpenRouter) ────────────────────
//
// OpenRouter는 **제공자가 아니라 통로다.** 키 하나로 여러 회사의 모델을
// 부를 수 있게 해 준다.
//
// 그래서 여기서 하나로 합치지 않는다. 합치면 합의 분석이 OpenRouter를
// **한 번만** 부르게 되고, 그건 모델 하나에게 물어본 것과 같다 — 여러
// 의견을 모으려고 붙인 것인데 의견이 하나가 된다.
//
// 대신 제공자마다 "어느 길로 갈지"를 정한다:
//
//   1. 그 회사 키가 있으면 **직접** 간다 (중계 수수료가 없고, 중계가
//      죽어도 살아 있다)
//   2. 없고 OPENROUTER_API_KEY가 있으면 **OpenRouter로** 간다
//   3. 둘 다 없으면 그 제공자는 없는 것이다
//
// 무료 한도가 있는 Gemini를 직접 연결해 두면, 중계가 죽어도 그건 돈다.

export type AiVia = 'direct' | 'openrouter' | 'none';

export interface ProviderRoute {
  provider: AiProvider;
  via: AiVia;
  /** 실제로 부를 모델 ID */
  model: string;
  /** OpenAI 호환 경로일 때만. anthropic·gemini 직접 호출은 자기 방식이 있다 */
  baseUrl?: string;
  /** 쓸 키가 담긴 환경변수 이름 (값이 아니라 이름 — 화면에 보여줘도 된다) */
  keyEnv?: string;
  reason: string;
}

/** OpenRouter에서 이 회사 모델이 어떤 이름으로 불리는지 */
const OPENROUTER_VENDOR: Record<AiProvider, string> = {
  openai: 'openai', anthropic: 'anthropic', gemini: 'google',
  grok: 'x-ai', perplexity: 'perplexity',
};

/** 직접 연결이 OpenAI 호환 형식인 제공자 */
export const OPENAI_COMPATIBLE: Partial<Record<AiProvider, { baseUrl: string; keys: string[] }>> = {
  openai:     { baseUrl: 'https://api.openai.com/v1', keys: ['OPENAI_API_KEY'] },
  grok:       { baseUrl: 'https://api.x.ai/v1',       keys: ['XAI_API_KEY', 'GROK_API_KEY'] },
  perplexity: { baseUrl: 'https://api.perplexity.ai', keys: ['PERPLEXITY_API_KEY'] },
};

/** 자기 방식으로 부르는 제공자 */
const NATIVE_KEYS: Partial<Record<AiProvider, string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini:    ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

function directModelOf(provider: AiProvider, tier?: AiTier): string {
  switch (provider) {
    case 'openai':     return isCheap(tier) ? MODELS.openai.cheap : MODELS.openai.premium;
    case 'gemini':     return isCheap(tier) ? MODELS.gemini.cheap : MODELS.gemini.premium;
    case 'anthropic':  return MODELS.anthropic;
    case 'grok':       return MODELS.grok;
    case 'perplexity': return MODELS.perplexity;
  }
}

/**
 * OpenRouter에서 쓸 모델 ID.
 *
 * 기본값은 직접 호출용 ID 앞에 회사 이름을 붙인 것이다
 * (`gpt-4o` → `openai/gpt-4o`). **OpenRouter에 그 ID가 없으면 404가 난다** —
 * 모델 목록은 자주 바뀌므로, 그때는 `OPENROUTER_MODEL_<제공자>`로 맞춘다.
 * 오류 메시지에 모델 ID가 그대로 담기므로 무엇을 고쳐야 하는지 보인다.
 */
function openrouterModelOf(
  provider: AiProvider, tier: AiTier | undefined, env: (k: string) => string | undefined,
): string {
  const override = env(`OPENROUTER_MODEL_${provider.toUpperCase()}`);
  if (override && override.trim()) return override.trim();
  return `${OPENROUTER_VENDOR[provider]}/${directModelOf(provider, tier)}`;
}

/**
 * 이 제공자를 지금 어떻게 부를 수 있는가.
 *
 * 순수 함수다 — env를 주입받는다. 이 판정이 화면(어느 AI가 붙었는지)과
 * 실제 호출 양쪽에 쓰이므로, **두 곳이 다른 답을 내지 않게** 한 곳에 둔다.
 */
export function resolveRoute(
  provider: AiProvider,
  env: (k: string) => string | undefined = (k) => process.env[k],
  tier?: AiTier,
): ProviderRoute {
  const firstKey = (names: string[] | undefined) =>
    (names ?? []).find(n => (env(n) ?? '').trim() !== '');

  const compat = OPENAI_COMPATIBLE[provider];
  const own = firstKey(compat ? compat.keys : NATIVE_KEYS[provider]);

  if (own) {
    return {
      provider, via: 'direct', keyEnv: own,
      model: directModelOf(provider, tier),
      baseUrl: compat?.baseUrl,
      reason: `${own}로 직접 연결`,
    };
  }

  if ((env('OPENROUTER_API_KEY') ?? '').trim() !== '') {
    return {
      provider, via: 'openrouter', keyEnv: 'OPENROUTER_API_KEY',
      model: openrouterModelOf(provider, tier, env),
      baseUrl: (env('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1').trim(),
      reason: 'OpenRouter 경유 (중계 수수료가 붙습니다)',
    };
  }

  const wanted = compat ? compat.keys : (NATIVE_KEYS[provider] ?? []);
  return {
    provider, via: 'none', model: directModelOf(provider, tier),
    reason: `${wanted.join(' 또는 ')} 또는 OPENROUTER_API_KEY가 필요합니다`,
  };
}

/** 지금 부를 수 있는 제공자 (직접이든 OpenRouter든). 키 값은 노출하지 않는다 */
export function availableProviders(
  env: (k: string) => string | undefined = (k) => process.env[k],
): AiProvider[] {
  return ALL_PROVIDERS.filter(p => resolveRoute(p, env).via !== 'none');
}

/** 화면에 그대로 쓸 경로표 */
export function providerRoutes(
  env: (k: string) => string | undefined = (k) => process.env[k],
): ProviderRoute[] {
  return ALL_PROVIDERS.map(p => resolveRoute(p, env));
}
