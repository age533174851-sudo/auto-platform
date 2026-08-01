// src/lib/ai/routing.test.ts
//
// "이 AI를 지금 부를 수 있는가, 어느 길로 가는가."
//
// 이 판정이 **두 곳에서 쓰인다**: 화면(어느 AI가 붙었는지)과 실제 호출.
// 둘이 갈라지면 화면에는 "Grok 사용 가능"이라고 뜨는데 부르면 실패하거나,
// 반대로 붙어 있는데 화면에서 안 보인다. 그래서 한 함수로 두고 여기서 잠근다.
//
// OpenRouter를 '제공자'로 합치지 않은 이유도 여기서 확인한다 — 합치면
// 합의 분석이 중계를 한 번만 부르고, 그건 모델 하나에게 물어본 것과 같다.

import { test, eq, assert } from '../../test/harness';
import { resolveRoute, availableProviders, ALL_PROVIDERS, PROVIDER_LABEL } from './routing';
import { priceOf } from './pricing';

const envOf = (o: Record<string, string>) => (k: string) => o[k];

export function runRoutingTests() {
  console.log('[AI 경로 — 키가 없으면 없는 것이다]');

  test('아무 키도 없으면 부를 수 있는 AI가 없다', () => {
    eq(availableProviders(envOf({})).length, 0);
    for (const p of ALL_PROVIDERS) eq(resolveRoute(p, envOf({})).via, 'none', p);
  });

  test('없을 때 무엇이 필요한지 말해 준다', () => {
    const r = resolveRoute('grok', envOf({}));
    assert(r.reason.includes('XAI_API_KEY'), r.reason);
    assert(r.reason.includes('OPENROUTER_API_KEY'), r.reason);
  });

  console.log('[AI 경로 — 직접 연결]');

  test('자기 키가 있으면 직접 간다', () => {
    const r = resolveRoute('openai', envOf({ OPENAI_API_KEY: 'sk-x' }));
    eq(r.via, 'direct');
    eq(r.keyEnv, 'OPENAI_API_KEY');
    assert(!r.model.includes('/'), `직접 호출에는 회사 접두사가 없다: ${r.model}`);
  });

  test('키 이름이 여러 개인 제공자는 아무거나 하나면 된다', () => {
    eq(resolveRoute('gemini', envOf({ GOOGLE_API_KEY: 'k' })).keyEnv, 'GOOGLE_API_KEY');
    eq(resolveRoute('grok', envOf({ GROK_API_KEY: 'k' })).keyEnv, 'GROK_API_KEY');
  });

  test('빈 문자열은 키가 아니다 — 환경변수를 만들어만 두면 흔한 실수다', () => {
    eq(resolveRoute('openai', envOf({ OPENAI_API_KEY: '   ' })).via, 'none');
  });

  console.log('[AI 경로 — OpenRouter]');

  test('키 하나로 다섯 개가 전부 열린다', () => {
    const env = envOf({ OPENROUTER_API_KEY: 'or-x' });
    eq(availableProviders(env).length, ALL_PROVIDERS.length);
    for (const p of ALL_PROVIDERS) eq(resolveRoute(p, env).via, 'openrouter', p);
  });

  test('**자기 키가 있으면 직접 연결이 이긴다** — 중계 수수료가 없고 중계가 죽어도 산다', () => {
    const env = envOf({ OPENROUTER_API_KEY: 'or-x', GEMINI_API_KEY: 'g-x' });
    eq(resolveRoute('gemini', env).via, 'direct');
    eq(resolveRoute('openai', env).via, 'openrouter');
  });

  test('OpenRouter 모델 ID에는 회사 이름이 붙는다', () => {
    const env = envOf({ OPENROUTER_API_KEY: 'or-x' });
    assert(resolveRoute('openai', env).model.startsWith('openai/'), resolveRoute('openai', env).model);
    assert(resolveRoute('gemini', env).model.startsWith('google/'), resolveRoute('gemini', env).model);
    assert(resolveRoute('grok', env).model.startsWith('x-ai/'), resolveRoute('grok', env).model);
  });

  test('모델 ID를 환경변수로 맞출 수 있다 — 목록이 바뀌면 코드를 고칠 수 없으면 안 된다', () => {
    const r = resolveRoute('anthropic', envOf({
      OPENROUTER_API_KEY: 'or-x',
      OPENROUTER_MODEL_ANTHROPIC: 'anthropic/claude-sonnet-4.5',
    }));
    eq(r.model, 'anthropic/claude-sonnet-4.5');
  });

  test('중계 주소도 바꿀 수 있다', () => {
    const r = resolveRoute('openai', envOf({ OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: 'https://x.test/v1' }));
    eq(r.baseUrl, 'https://x.test/v1');
  });

  test('OpenRouter는 제공자 목록에 없다 — 통로지 의견이 아니다', () => {
    assert(!(ALL_PROVIDERS as string[]).includes('openrouter'),
      '목록에 넣으면 합의 분석이 중계를 한 번만 부르고 끝난다');
  });

  test('모든 제공자에 이름표가 있다', () => {
    for (const p of ALL_PROVIDERS) assert(!!PROVIDER_LABEL[p], p);
  });

  console.log('[AI 비용 — OpenRouter 모델 ID]');

  test('회사 접두사를 떼고 단가를 찾는다 — 안 떼면 전부 "단가 모름"이 된다', () => {
    eq(priceOf('openai/gpt-4o-mini'), priceOf('gpt-4o-mini'));
    eq(priceOf('google/gemini-2.0-flash'), priceOf('gemini-2.0-flash'));
    eq(priceOf('x-ai/grok-4'), priceOf('grok-4'));
  });

  test(':free 같은 꼬리표도 뗀다', () => {
    eq(priceOf('openai/gpt-4o:nitro'), priceOf('gpt-4o'));
  });

  test('모르는 모델은 여전히 null — 0원이 아니다', () => {
    eq(priceOf('someco/unknown-model-9'), null);
  });

  test('gpt-4o가 gpt-4o-mini를 가로채지 않는다 (접두사 길이 우선)', () => {
    const mini = priceOf('openai/gpt-4o-mini');
    const full = priceOf('openai/gpt-4o');
    assert((mini as any).inPerM < (full as any).inPerM, '미니가 더 싸야 한다');
  });
}
