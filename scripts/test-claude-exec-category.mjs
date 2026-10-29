// scripts/test-claude-exec-category.mjs
//
// #533 — Claude Code Action이 숨긴 SDK 실패를 **민감정보 없이** 분류한다.
//
// 왜 필요한가: 실패 실행 40921526704 / 40921531797의 로그에는 Claude 단계의
// 오류 범주가 **없다.** action이 기본값으로 삼켰고, 그래서 로그를 아무리 읽어도
// 원인이 안 나온다. 이 시험은 두 가지를 고정한다:
//
//   ① 관측된 종료 모양(num_turns 1 · modelUsage {} · cost 0 · is_error)을
//      `no_model_call`로 분류한다 — 모델을 한 번도 못 불렀다는 사실 자체가
//      가장 중요한 단서다
//   ② **어떤 입력에도 키·토큰·프롬프트·요청 ID·URL이 출력에 새지 않는다**

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, render } from './claude-exec-category.mjs';

/** 실제 실패 회차가 보고한 모양 */
const OBSERVED = {
  type: 'result', subtype: 'success', is_error: true,
  num_turns: 1, duration_ms: 361, total_cost_usd: 0,
  permission_denials: [], modelUsage: {},
};

test('관측된 모양 — 모델을 한 번도 못 불렀다고 분류한다', () => {
  const c = categorize([OBSERVED]);
  assert.equal(c.category, 'no_model_call');
  assert.equal(c.isError, true);
  assert.equal(c.numTurns, 1);
  assert.equal(c.durationMs, 361);
  assert.equal(c.modelCalls, 0);
});

test('modelUsage가 있으면 no_model_call이 아니다', () => {
  const c = categorize([{ ...OBSERVED, modelUsage: { 'claude-opus-5-5': { inputTokens: 10 } } }]);
  assert.notEqual(c.category, 'no_model_call');
  assert.equal(c.modelCalls, 1);
});

test('성공 회차는 ok로 분류한다', () => {
  const c = categorize([{ ...OBSERVED, is_error: false, num_turns: 7, total_cost_usd: 0.4,
    modelUsage: { 'claude-opus-5-5': { inputTokens: 100 } } }]);
  assert.equal(c.category, 'ok');
  assert.equal(c.isError, false);
});

// ── 오류 문구 → 범주. **문구 자체는 절대 출력하지 않는다** ──
const CASES = [
  ['authentication_error: invalid x-api-key', 'auth_invalid'],
  ['HTTP 401 Unauthorized', 'auth_invalid'],
  ['permission_error: your API key does not have permission', 'permission_denied'],
  ['HTTP 403 Forbidden', 'permission_denied'],
  ['not_found_error: model: claude-opus-5-5', 'model_not_found'],
  ['HTTP 404', 'model_not_found'],
  ['rate_limit_error: too many requests', 'rate_limited'],
  ['HTTP 429', 'rate_limited'],
  ['Your credit balance is too low', 'credit_or_billing'],
  ['HTTP 402 Payment Required', 'credit_or_billing'],
  ['overloaded_error', 'overloaded'],
  ['HTTP 529', 'overloaded'],
  ['invalid_request_error: max_tokens', 'invalid_request'],
  ['HTTP 400 Bad Request', 'invalid_request'],
  ['Request timed out after 600000ms', 'timeout'],
  ['socket hang up ECONNRESET', 'transport_error'],
  ['Claude reached the maximum number of turns', 'max_turns_exhausted'],
];
for (const [message, expected] of CASES) {
  test(`오류 문구 분류: ${expected}`, () => {
    const c = categorize([{ ...OBSERVED, num_turns: 3, modelUsage: { m: {} }, result: message }]);
    assert.equal(c.category, expected);
  });
}

test('모르는 오류는 unknown이다 — 추측해서 이름 붙이지 않는다', () => {
  const c = categorize([{ ...OBSERVED, num_turns: 3, modelUsage: { m: {} },
    result: '알 수 없는 어떤 실패' }]);
  assert.equal(c.category, 'unknown');
});

// ══════════ 유출 방지 — 이 시험이 이 파일의 존재 이유다 ══════════
const SECRETS = [
  'sk-ant-api03-SUPERSECRETKEYVALUE',
  'oauth-tok-DEADBEEFCAFE',
  'req_01ABCDEFGHIJKLMNOP',
  'TRAIGO 무인 개발 — 이 문장은 프롬프트 본문이다',
  'https://api.anthropic.com/v1/messages?key=leak',
  'eyJhbGciOiJIUzI1NiJ9.LEAKEDJWT.sig',
];

test('★★ 어떤 민감정보도 출력에 새지 않는다', () => {
  const poisoned = [{
    ...OBSERVED,
    num_turns: 3,
    modelUsage: { m: {} },
    result: `authentication_error ${SECRETS[0]} ${SECRETS[2]} ${SECRETS[4]}`,
    error: { message: SECRETS[0], request_id: SECRETS[2], url: SECRETS[4] },
    prompt: SECRETS[3],
    apiKeySource: SECRETS[0],
    session_id: SECRETS[5],
    messages: [{ role: 'user', content: SECRETS[3] }],
    env: { ANTHROPIC_API_KEY: SECRETS[0], CLAUDE_CODE_OAUTH_TOKEN: SECRETS[1] },
  }];
  const out = render(categorize(poisoned));
  for (const s of SECRETS) {
    assert.ok(!out.includes(s), `출력에 민감정보가 섞였다: ${s.slice(0, 12)}…`);
  }
  // 분류는 여전히 쓸모 있어야 한다 — 가리느라 아무것도 못 적으면 의미가 없다
  assert.ok(out.includes('auth_invalid'), `범주를 적지 않았다: ${out}`);
});

test('★★ 출력은 허용한 칸만 담는다 (화이트리스트)', () => {
  const out = render(categorize([{ ...OBSERVED, result: 'HTTP 401', extra_field: 'LEAKME' }]));
  assert.ok(!out.includes('LEAKME'), `모르는 칸이 그대로 나갔다: ${out}`);
});

// ── 파일이 없거나 깨졌을 때 ──
test('파일이 없으면 모른다고 적는다 — 성공으로 적지 않는다', () => {
  const c = categorize(null);
  assert.equal(c.category, 'no_execution_record');
  assert.equal(c.isError, null);
});

test('JSON이 깨져 있어도 던지지 않고 모른다고 적는다', () => {
  const c = categorize('{{{ not json');
  assert.equal(c.category, 'no_execution_record');
});

test('result 메시지가 없으면 모른다고 적는다', () => {
  const c = categorize([{ type: 'system', subtype: 'init' }]);
  assert.equal(c.category, 'no_execution_record');
});

test('배열이 아니라 객체로 감싸 와도 읽는다', () => {
  const c = categorize({ messages: [OBSERVED] });
  assert.equal(c.category, 'no_model_call');
});
