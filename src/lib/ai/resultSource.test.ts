// src/lib/ai/resultSource.test.ts
//
// 실제 화면이었던 것:
//
//   AI 분석 결과
//   신뢰도 75% · fallback
//   OpenAI 호출 실패 — fallback 사용 (openai_status_429)
//
// OpenAI가 429로 거절했고 내부 템플릿이 결과를 만들었다. 그런데 제목은
// 'AI 분석 결과'이고 신뢰도 75%가 붙어 있다.
//
// 막으려는 것:
//  1. fallback을 'AI 분석 결과'라고 부르는 것
//  2. 템플릿 기본값을 AI 신뢰도로 보여주는 것 — 템플릿은 자기가
//     얼마나 맞을지 모른다
//  3. 모르는 출처를 AI로 읽는 것
//  4. 429에 연타로 다시 때리는 것
import { test, assert, eq } from '../../test/harness';
import {
  sourceOf, aiResultView, failureText, retryPlan,
  SOURCE_TITLE, MAX_RETRY_DELAY_MS,
} from './resultSource';

export function runAiResultSourceTests() {
  console.log('[AI 출처 — fallback을 AI라고 부르지 않는다]');

  test("fallback 제목이 'AI 분석 결과'가 아니다", () => {
    eq(SOURCE_TITLE.FALLBACK_TEMPLATE, '기본 전략 초안');
    assert(!SOURCE_TITLE.FALLBACK_TEMPLATE.includes('AI'), SOURCE_TITLE.FALLBACK_TEMPLATE);
    eq(SOURCE_TITLE.AI_GENERATED, 'AI 분석 결과');
  });

  test('429로 떨어진 결과는 AI 결과가 아니다', () => {
    // 화면에 실제로 떴던 그 조합.
    const v = aiResultView({ source: 'fallback', confidence: 75, errorCode: 'openai_status_429' });
    eq(v.source, 'FALLBACK_TEMPLATE');
    assert(!v.title.includes('AI 분석 결과'), v.title);
    assert(v.failureNote.includes('429'), v.failureNote);
  });

  test('fallback에는 AI 신뢰도를 붙이지 않는다', () => {
    // 75%는 모델의 확신이 아니라 템플릿에 박힌 상수였다.
    const v = aiResultView({ source: 'fallback', confidence: 75 });
    eq(v.confidencePct, null);
    assert(v.confidenceNote.includes('AI 신뢰도가 아닙니다'), v.confidenceNote);
  });

  test('AI가 실제로 답했을 때만 신뢰도가 있다', () => {
    const v = aiResultView({ source: 'openai', confidence: 75 });
    eq(v.source, 'AI_GENERATED');
    eq(v.confidencePct, 75);
    eq(v.confidenceNote, '');
  });

  test('AI가 신뢰도를 안 줬으면 지어내지 않는다', () => {
    const v = aiResultView({ source: 'openai' });
    eq(v.confidencePct, null);
    assert(v.confidenceNote.includes('주지 않았습니다'), v.confidenceNote);
  });

  test('범위를 벗어난 신뢰도는 안 쓴다', () => {
    for (const bad of [-1, 101, NaN, 'abc']) {
      eq(aiResultView({ source: 'openai', confidence: bad }).confidencePct, null, String(bad));
    }
  });

  console.log('[AI 출처 — 모르는 것을 AI로 읽지 않는다]');

  test('모르는 값은 AI가 아니다', () => {
    // 이쪽으로 기울면 실패한 호출이 성공으로 보인다.
    eq(sourceOf(null), 'UNKNOWN');
    eq(sourceOf(''), 'UNKNOWN');
    eq(sourceOf('아무거나'), 'UNKNOWN');
  });

  test('알려진 제공자만 AI로 센다', () => {
    for (const p of ['openai', 'anthropic', 'gemini', 'openrouter', 'groq']) {
      eq(sourceOf(p), 'AI_GENERATED', p);
    }
  });

  test('fallback 표기가 여러 개여도 다 잡는다', () => {
    for (const p of ['fallback', 'FALLBACK_TEMPLATE', 'template']) {
      eq(sourceOf(p), 'FALLBACK_TEMPLATE', p);
    }
  });

  test('사람이 쓴 것은 AI가 아니다', () => {
    eq(sourceOf('manual'), 'MANUAL');
    eq(aiResultView({ source: 'manual' }).confidencePct, null);
  });

  console.log('[AI 출처 — 만들었다고 쓸 만한 것이 아니다]');

  test('기본은 미검증이다', () => {
    eq(aiResultView({ source: 'openai', confidence: 90 }).validated, false);
    eq(aiResultView({ source: 'openai', validated: true }).validated, true);
    eq(aiResultView({ source: 'openai', validated: 'true' as any }).validated, false,
      '문자열 true를 참으로 읽지 않는다');
  });

  test('AI가 아니면 다시 시도할 수 있다고 알린다', () => {
    eq(aiResultView({ source: 'fallback' }).retryable, true);
    eq(aiResultView({ source: 'openai' }).retryable, false);
  });

  console.log('[AI 출처 — 실패 코드를 사람 말로]');

  test('429는 왜 났는지까지 적는다', () => {
    // 상태 코드만 남기면 요청 제한인지 잔액 부족인지 모른다.
    const t = failureText('openai_status_429');
    assert(t.includes('요청이 몰려'), t);
    assert(t.includes('잔액'), t);
  });

  test('401은 키 문제라고 말한다', () => {
    assert(failureText('status_401').includes('키'), failureText('status_401'));
  });

  test('코드가 없으면 빈 문자열이다', () => {
    eq(failureText(null), '');
    eq(failureText(''), '');
  });

  console.log('[AI 출처 — 429에 연타하지 않는다]');

  test('요청이 나가 있으면 또 보내지 않는다', () => {
    const p = retryPlan({ inFlight: true, errorCode: '429' });
    eq(p.should, false);
    assert(p.reason.includes('연타는 한도만'), p.reason);
  });

  test('Retry-After를 존중한다', () => {
    // 무시하고 바로 다시 때리면 한도가 더 늦게 풀린다.
    const p = retryPlan({ errorCode: '429', retryAfterSec: 30 });
    eq(p.should, true);
    eq(p.delayMs, 30_000);
    assert(p.reason.includes('30초'), p.reason);
  });

  test('Retry-After가 터무니없이 길어도 상한을 지킨다', () => {
    eq(retryPlan({ errorCode: '429', retryAfterSec: 9999 }).delayMs, MAX_RETRY_DELAY_MS);
  });

  test('없으면 2·4·8·16초로 늘린다', () => {
    eq(retryPlan({ errorCode: '429', attempt: 0 }).delayMs, 2000);
    eq(retryPlan({ errorCode: '429', attempt: 1 }).delayMs, 4000);
    eq(retryPlan({ errorCode: '429', attempt: 2 }).delayMs, 8000);
    eq(retryPlan({ errorCode: '429', attempt: 3 }).delayMs, 16000);
  });

  test('네 번이면 멈추고 사람을 부른다', () => {
    const p = retryPlan({ errorCode: '429', attempt: 4 });
    eq(p.should, false);
    assert(p.reason.includes('사람이 확인'), p.reason);
  });

  test('401은 몇 번을 해도 같은 답이다', () => {
    eq(retryPlan({ errorCode: 'status_401' }).should, false);
    eq(retryPlan({ errorCode: 'status_403' }).should, false);
  });

  test('5xx와 timeout은 다시 시도한다', () => {
    eq(retryPlan({ errorCode: 'status_503' }).should, true);
    eq(retryPlan({ errorCode: 'timeout' }).should, true);
  });
}
