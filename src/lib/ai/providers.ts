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

export type AiProvider = 'openai' | 'anthropic' | 'gemini';

export interface AiCallInput {
  system: string;
  user: string;
  maxTokens?: number;
  tier?: AiTier;
  /** 개인 키(BYOK). 주어지면 서버 환경변수 대신 이 키로 호출한다. */
  apiKey?: string;
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
  error?: string;
}

const TIMEOUT_MS = 30_000;

// ── 모델 선택 ─────────────────────────────────────────────────
// 모델 ID는 제공자 쪽에서 계속 바뀌므로 환경변수로 덮어쓸 수 있게 둔다.
const MODELS = {
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
};

const isCheap = (tier?: AiTier) => tier === 'L1_CHEAP';

/** 어떤 제공자의 키가 준비돼 있는지 (값은 노출하지 않는다) */
export function availableProviders(): AiProvider[] {
  const out: AiProvider[] = [];
  if (process.env.OPENAI_API_KEY)    out.push('openai');
  if (process.env.ANTHROPIC_API_KEY) out.push('anthropic');
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) out.push('gemini');
  return out;
}

// ── OpenAI ────────────────────────────────────────────────────
async function callOpenAI(input: AiCallInput): Promise<AiCallResult> {
  const key = input.apiKey || process.env.OPENAI_API_KEY || '';
  const model = isCheap(input.tier) ? MODELS.openai.cheap : MODELS.openai.premium;
  const base: AiCallResult = { ok: false, provider: 'openai', model, text: null };
  if (!key) return { ...base, error: 'OPENAI_API_KEY 미설정' };

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
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
    if (!r.ok) return { ...base, error: `HTTP ${r.status}` };
    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content?.trim() || null;
    return {
      ...base, ok: !!text, text,
      inputTokens:  d?.usage?.prompt_tokens,
      outputTokens: d?.usage?.completion_tokens,
    };
  } catch (e: any) {
    return { ...base, error: e?.message || 'openai 호출 실패' };
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
async function logCall(provider: AiProvider, r: AiCallResult, latencyMs: number) {
  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/server');
    const sb = getSupabaseAdmin();
    if (!sb) return;
    await (sb.from('ai_usage') as any).insert({
      tier: 'L1_CHEAP',
      kind: 'news',
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
  let r: AiCallResult;
  switch (provider) {
    case 'openai':    r = await callOpenAI(input); break;
    case 'anthropic': r = await callClaude(input); break;
    case 'gemini':    r = await callGemini(input); break;
  }
  const latencyMs = Date.now() - t0;
  // 기록을 기다리지 않는다. 통계 때문에 사용자 응답이 늦어지면 안 된다.
  void logCall(provider, r!, latencyMs);
  return { ...r!, latencyMs };
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

  const LABEL: Record<AiProvider, string> = { openai: 'GPT', anthropic: 'Claude', gemini: 'Gemini' };
  const combined = opinions.map(o => `[${LABEL[o.provider]}]\n${o.text}`).join('\n\n');

  return { opinions, skipped, combined, count: opinions.length };
}
