// src/lib/ai/providers.ts
// AI 제공자 어댑터 — OpenAI / Anthropic / Google Gemini를 하나의 인터페이스로 감싼다.
//
// 기존에는 api/ai/route.ts가 OpenAI를 직접 fetch로 부르는 코드 하나뿐이었다.
// gateway.ts가 L3_COMMITTEE(다중 AI 합의) 계층을 정의해 두었지만 부를 모델이
// 하나뿐이라 실제로는 동작할 수 없었다. 이 모듈이 그 빈자리를 채운다.
//
// 비용 조절은 "싼 모델로 바꾸기"가 아니라 계층별 파라미터로 한다:
//   - Anthropic: effort (low/medium/high) — 모델은 claude-opus-5 고정
//   - OpenAI / Gemini: 계층별 모델 선택 (env로 덮어쓸 수 있음)
//
// 키가 없는 제공자는 조용히 건너뛴다. 셋 다 없으면 호출자가 폴백 문구를 쓴다.
import Anthropic from '@anthropic-ai/sdk';
import type { AiTier } from './gateway';

import {
  ALL_PROVIDERS, PROVIDER_LABEL, MODELS, isCheap,
  resolveRoute, availableProviders, providerRoutes,
  OPENAI_COMPATIBLE,
  type AiProvider, type AiVia, type ProviderRoute,
} from './routing';

// 부르는 쪽이 두 파일을 알 필요는 없다 — 지금까지 쓰던 이름 그대로 내보낸다.
export {
  ALL_PROVIDERS, PROVIDER_LABEL,
  resolveRoute, availableProviders, providerRoutes,
};
export type { AiProvider, AiVia, ProviderRoute };


export interface AiCallInput {
  system: string;
  user: string;
  maxTokens?: number;
  tier?: AiTier;
  /** 개인 키(BYOK). 주어지면 서버 환경변수 대신 이 키로 호출한다. */
  apiKey?: string;
  /**
   * 무슨 용도의 호출인가 (news | signal | explain | decision).
   *
   * 기록에만 쓴다. 예전에는 logCall이 'news'를 하드코딩해서, 합의 분석이든
   * 챗이든 전부 뉴스로 집계됐다 — 어디서 돈이 나가는지 화면이 알 수 없었다.
   */
  kind?: string;
  /**
   * JSON만 받겠다는 표시.
   *
   * 프롬프트로 "JSON만 출력해라"라고 부탁하는 것과 다르다. 부탁은 모델이
   * 자주 어긴다 — 코드펜스를 씌우거나 앞에 설명을 붙인다. 공급자가
   * 제공하는 강제 모드를 쓰면 파싱 실패 자체가 줄어든다.
   */
  jsonOnly?: boolean;
}

export interface AiCallResult {
  ok: boolean;
  provider: AiProvider;
  model: string;
  text: string | null;
  inputTokens?: number;
  outputTokens?: number;
  /** 이 호출에 걸린 시간(ms). 측정 못 하면 없다 — 0이 아니다 */
  latencyMs?: number;
  /** 안전 분류기가 요청을 거절한 경우 (Anthropic) — 오류가 아니라 정상 응답이다. */
  refused?: boolean;
  /** 직접 갔는가, OpenRouter를 거쳤는가. 비용·장애 원인을 가르는 값이다 */
  via?: AiVia;
  error?: string;
}

const TIMEOUT_MS = 30_000;



// ── OpenAI 호환 경로 ──────────────────────────────────────────
//
// OpenAI · Grok · Perplexity · OpenRouter가 전부 같은 형식이다
// (`POST /chat/completions`). 하나로 만든다 — 네 벌을 두면 JSON 강제 모드나
// 오류 처리를 한 곳만 고치는 일이 반드시 생긴다.
async function callOpenAICompatible(
  route: ProviderRoute, input: AiCallInput,
): Promise<AiCallResult> {
  const provider = route.provider;
  const model = route.model;
  const base: AiCallResult = { ok: false, provider, model, text: null };

  const key = input.apiKey || (route.keyEnv ? process.env[route.keyEnv] : '') || '';
  if (!key) return { ...base, error: route.reason };
  if (!route.baseUrl) return { ...base, error: `${provider} 호출 경로가 없습니다` };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
  if (route.via === 'openrouter') {
    // OpenRouter가 요청 출처를 표시하는 데 쓰는 헤더. 없어도 동작하지만
    // 대시보드에서 어느 앱이 썼는지 구분이 안 된다.
    headers['HTTP-Referer'] = process.env.NEXT_PUBLIC_APP_URL || 'https://traigo.app';
    headers['X-Title'] = 'TRAIGO';
  }

  try {
    const r = await fetch(`${route.baseUrl}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model,
        max_tokens: input.maxTokens ?? 800,
        // JSON 모드. 프롬프트에 "JSON만"이라고 적는 것보다 확실하다.
        ...(input.jsonOnly ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: input.system },
          { role: 'user',   content: input.user   },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      // 상태 코드만 남기면 '왜'를 모른다. 429는 한도 초과와 잔액 부족이
      // 같은 코드로 오는데, 전자는 기다리면 풀리고 후자는 결제해야 한다.
      // 대응이 완전히 다른데 화면에는 둘 다 'HTTP 429'로 보인다.
      //
      // 그리고 OpenRouter는 없는 모델 ID에 404를 준다. 모델 ID를 오류에
      // 같이 담아야 "무엇을 고쳐야 하는지"가 보인다.
      let detail = '';
      try {
        const e = await r.json();
        detail = e?.error?.message || e?.error?.code || '';
      } catch { /* 본문이 JSON이 아니면 상태 코드만 */ }
      const via = route.via === 'openrouter' ? ' via OpenRouter' : '';
      return {
        ...base,
        error: `HTTP ${r.status}${via} [${model}]${detail ? ` — ${detail}` : ''}`
          + (r.status === 404 ? ` · OPENROUTER_MODEL_${provider.toUpperCase()}로 모델 ID를 맞추세요` : ''),
      };
    }
    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content?.trim() || null;
    return {
      ...base, ok: !!text, text,
      // OpenRouter는 실제로 응답한 모델을 돌려준다. 그걸 그대로 기록해야
      // 비용 화면이 무엇에 돈을 썼는지 말할 수 있다.
      model: typeof d?.model === 'string' && d.model ? d.model : model,
      inputTokens:  d?.usage?.prompt_tokens,
      outputTokens: d?.usage?.completion_tokens,
    };
  } catch (e: any) {
    return { ...base, error: e?.message || `${provider} 호출 실패` };
  }
}

// ── Anthropic ─────────────────────────────────────────────────
// 공식 SDK를 쓴다. 요청마다 클라이언트를 만드는 이유는 BYOK(개인 키)를
// 지원해야 하기 때문 — 사용자마다 키가 다를 수 있다.
async function callClaude(input: AiCallInput): Promise<AiCallResult> {
  const key = input.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const model = MODELS.anthropic;
  const base: AiCallResult = { ok: false, provider: 'anthropic', model, text: null };
  if (!key) return { ...base, error: 'ANTHROPIC_API_KEY 미설정' };

  // claude-opus-5는 thinking이 기본 활성이고, max_tokens는 thinking과 응답을
  // 합쳐서 제한한다. 짧은 답변을 원해도 여유를 둬야 중간에 잘리지 않는다.
  const maxTokens = Math.max(input.maxTokens ?? 800, isCheap(input.tier) ? 4000 : 8000);

  try {
    const client = new Anthropic({ apiKey: key, timeout: TIMEOUT_MS });
    const res = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
      thinking: { type: 'adaptive' },
      output_config: { effort: isCheap(input.tier) ? 'low' : 'high' },
      // 안전 분류기가 거절하면 다른 모델로 자동 재시도한다.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });

    // 거절은 오류가 아니라 stop_reason으로 온다 — content를 읽기 전에 확인한다.
    if (res.stop_reason === 'refusal') {
      return { ...base, refused: true, error: '안전 정책으로 응답이 거절되었습니다' };
    }

    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim() || null;

    return {
      ...base, ok: !!text, text, model: res.model || model,
      inputTokens:  res.usage?.input_tokens,
      outputTokens: res.usage?.output_tokens,
    };
  } catch (e: any) {
    return { ...base, error: e?.message || 'anthropic 호출 실패' };
  }
}

// ── Google Gemini ─────────────────────────────────────────────
async function callGemini(input: AiCallInput): Promise<AiCallResult> {
  const key = input.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  const model = isCheap(input.tier) ? MODELS.gemini.cheap : MODELS.gemini.premium;
  const base: AiCallResult = { ok: false, provider: 'gemini', model, text: null };
  if (!key) return { ...base, error: 'GEMINI_API_KEY 미설정' };

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        // 키는 헤더로 보낸다 — URL 쿼리에 넣으면 로그·리퍼러에 남는다.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [{ role: 'user', parts: [{ text: input.user }] }],
          generationConfig: {
            maxOutputTokens: input.maxTokens ?? 800,
            // Gemini도 JSON 강제 모드가 있다
            ...(input.jsonOnly ? { responseMimeType: 'application/json' } : {}),
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!r.ok) return { ...base, error: `HTTP ${r.status}` };
    const d = await r.json();
    const text = (d?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p?.text ?? '')
      .join('')
      .trim() || null;
    return {
      ...base, ok: !!text, text,
      inputTokens:  d?.usageMetadata?.promptTokenCount,
      outputTokens: d?.usageMetadata?.candidatesTokenCount,
    };
  } catch (e: any) {
    return { ...base, error: e?.message || 'gemini 호출 실패' };
  }
}

// ── 단일 호출 ─────────────────────────────────────────────────
/**
 * 호출 하나를 기록한다.
 *
 * 기록 실패가 호출 결과를 바꾸지 않는다 — 통계를 못 남겼다고 분석까지
 * 버릴 이유는 없다. 다만 조용히 넘기므로, 화면이 "기록이 0건"과
 * "호출이 0건"을 구분할 수 있어야 한다.
 */
async function logCall(
  provider: AiProvider,
  r: AiCallResult,
  latencyMs: number,
  input: AiCallInput,
) {
  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/server');
    const sb = getSupabaseAdmin();
    if (!sb) return;
    await (sb.from('ai_usage') as any).insert({
      // tier와 kind를 하드코딩하고 있었다 — 'L1_CHEAP' / 'news'. 그래서
      // premium 모델을 부르면서 표에는 '기본 AI'로, 합의 분석도 '뉴스'로
      // 찍혔다. 비용 화면이 어디서 돈이 나가는지 못 짚는 상태였다.
      //
      // tier는 DB에서 NOT NULL이라 값이 있어야 한다. tier가 안 넘어온
      // 호출은 실제로 **premium 모델**을 쓴다(isCheap가 false) — 그래서
      // 기본값도 그 사실에 맞춘다. 여기서 'L1_CHEAP'로 두면 다시 거짓말이다.
      tier: input.tier ?? 'L2_PREMIUM',
      kind: input.kind ?? null,
      credits: 0,
      used_own_key: false,
      cache_hit: false,
      input_tokens:  r.inputTokens ?? null,
      output_tokens: r.outputTokens ?? null,
      provider,
      model: r.model,
      latency_ms: latencyMs,
      ok: r.ok,
      // 실패 횟수만 세면 '왜'를 모른다. 키 만료와 한도 초과는 대응이 다르다.
      error_text: r.ok ? null : String(r.error || '').slice(0, 300),
    });
  } catch { /* 기록 실패가 호출 결과를 바꾸지 않는다 */ }
}

export async function callProvider(provider: AiProvider, input: AiCallInput): Promise<AiCallResult> {
  const t0 = Date.now();
  const route = resolveRoute(provider, k => process.env[k], input.tier);

  // 어느 길로 가는지는 resolveRoute 한 곳이 정한다. 여기서 다시 판단하면
  // 화면이 말하는 경로와 실제로 부른 경로가 갈라진다.
  let r: AiCallResult;
  if (route.via === 'none') {
    r = { ok: false, provider, model: route.model, text: null, error: route.reason };
  } else if (route.via === 'openrouter' || OPENAI_COMPATIBLE[provider]) {
    r = await callOpenAICompatible(route, input);
  } else if (provider === 'anthropic') {
    r = await callClaude(input);
  } else if (provider === 'gemini') {
    r = await callGemini(input);
  } else {
    r = { ok: false, provider, model: route.model, text: null, error: `${provider} 경로 없음` };
  }

  const latencyMs = Date.now() - t0;
  // 기록을 기다리지 않는다. 통계 때문에 사용자 응답이 늦어지면 안 된다.
  void logCall(provider, r!, latencyMs, input);
  return { ...r!, latencyMs, via: route.via };
}

/**
 * 사용 가능한 제공자를 순서대로 시도해 첫 성공을 반환한다.
 * prefer가 주어지면 그 제공자를 맨 앞에 둔다 (BYOK 사용자의 키에 맞추기 위함).
 */
export async function callAny(input: AiCallInput, prefer?: AiProvider): Promise<AiCallResult> {
  const avail = availableProviders();
  const order = prefer && avail.includes(prefer)
    ? [prefer, ...avail.filter(p => p !== prefer)]
    : avail;

  if (order.length === 0) {
    return { ok: false, provider: prefer ?? 'openai', model: '-', text: null, error: 'AI 제공자 키가 하나도 설정되지 않았습니다' };
  }

  let last: AiCallResult | null = null;
  for (const p of order) {
    const r = await callProvider(p, input);
    if (r.ok) return r;
    last = r;
    // 안전 거절은 다른 제공자에서도 거절될 가능성이 높지만, 판정 기준이
    // 제공자마다 달라 한 번은 넘겨본다.
  }
  return last!;
}

// ── L3_COMMITTEE: 다중 AI 합의 ────────────────────────────────
export interface CommitteeResult {
  /** 성공한 응답들 */
  opinions: AiCallResult[];
  /** 실패·거절한 제공자 (사용자에게 왜 빠졌는지 보여주기 위함) */
  skipped: { provider: AiProvider; reason: string }[];
  /** 합의 요약용으로 이어붙인 텍스트 */
  combined: string;
  /** 응답한 제공자 수 */
  count: number;
}

/**
 * 사용 가능한 모든 제공자에게 같은 질문을 던지고 의견을 모은다.
 * 병렬 호출이므로 지연은 가장 느린 제공자에 맞춰진다.
 */
export async function callCommittee(input: AiCallInput): Promise<CommitteeResult> {
  const avail = availableProviders();
  const results = await Promise.all(avail.map(p => callProvider(p, input)));

  const opinions = results.filter(r => r.ok && r.text);
  const skipped  = results
    .filter(r => !r.ok)
    .map(r => ({ provider: r.provider, reason: r.refused ? '안전 정책 거절' : (r.error || '실패') }));

  // 이름표는 PROVIDER_LABEL 한 곳에서. 여기 따로 두면 제공자를 추가할 때마다
  // 두 곳을 고쳐야 하고, 한 곳만 고치면 새 AI가 'undefined'로 표시된다.
  const combined = opinions
    .map(o => `[${PROVIDER_LABEL[o.provider]}]\n${o.text}`).join('\n\n');

  return { opinions, skipped, combined, count: opinions.length };
}
