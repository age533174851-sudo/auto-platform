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
import { categorize, render, nextAction, CATEGORIES, deniedToolTally, deniedToolLine, PRINTABLE_TOOLS } from './claude-exec-category.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 실제 실패 회차가 보고한 모양 */
const OBSERVED = {
  type: 'result', subtype: 'success', is_error: true,
  num_turns: 1, duration_ms: 361, total_cost_usd: 0,
  permission_denials: [], modelUsage: {},
};

test('관측된 모양 — 사용 기록이 없다고 적는다 (호출 0으로 단정하지 않는다)', () => {
  const c = categorize([OBSERVED]);
  assert.equal(c.category, 'no_usage_record');
  assert.equal(c.isError, true);
  assert.equal(c.numTurns, 1);
  assert.equal(c.durationMs, 361);
  assert.equal(c.usageRecord, 'absent');
  assert.equal(c.usageModelKinds, 0);
});

test('modelUsage가 있으면 no_usage_record가 아니다', () => {
  const c = categorize([{ ...OBSERVED, modelUsage: { 'claude-opus-5-5': { inputTokens: 10 } } }]);
  assert.notEqual(c.category, 'no_usage_record');
  assert.equal(c.usageRecord, 'present');
  assert.equal(c.usageModelKinds, 1);
});

// ── GPT 검수 ① — 종류 수를 호출 횟수로 적지 않는다 ──
//
// `Object.keys(modelUsage).length`는 **서로 다른 모델 키의 개수**다.
// 한 모델을 100번 불러도 1이다. 그걸 "모델 호출 수"로 적으면 숫자가
// 거짓말을 한다.
test('★★ 한 모델을 여러 번 불러도 종류 수는 1이다 — 호출 횟수가 아니다', () => {
  const c = categorize([{ ...OBSERVED, is_error: false, num_turns: 40,
    modelUsage: { 'claude-opus-5-5': { inputTokens: 999999, outputTokens: 88888 } } }]);
  assert.equal(c.usageModelKinds, 1, '모델 종류는 하나다');
  assert.equal(c.usageRecord, 'present');
  const out = render(c);
  assert.ok(!out.includes('모델 호출 수'),
    `종류 수를 호출 횟수로 적었다: ${out}`);
});

test('★★ 사용 기록이 비었다고 "한 번도 못 불렀다"로 단정하지 않는다', () => {
  const out = render(categorize([OBSERVED]));
  assert.ok(!out.includes('한 번도'),
    `SDK 기록 누락 가능성을 배제하고 단정했다: ${out}`);
  assert.ok(out.includes('사용 기록'), `무엇이 없는지 적지 않았다: ${out}`);
  assert.ok(/기록하지 못했|누락|확정하지/.test(out),
    `기록 누락 가능성을 적지 않았다: ${out}`);
});

test('modelUsage가 아예 없는 칸이면 확인 불가다 — 0으로 적지 않는다', () => {
  const { modelUsage, ...noUsage } = OBSERVED;
  const c = categorize([noUsage]);
  assert.equal(c.usageRecord, 'unknown');
  assert.equal(c.usageModelKinds, null, 'null이어야 한다 — 0은 "없다"는 주장이다');
  assert.equal(c.category, 'unknown', '확인 못 한 것을 특정 범주로 적었다');
});

test('성공 회차는 ok로 분류한다', () => {
  const c = categorize([{ ...OBSERVED, is_error: false, num_turns: 7, total_cost_usd: 0.4,
    modelUsage: { 'claude-opus-5-5': { inputTokens: 100 } } }]);
  assert.equal(c.category, 'ok');
  assert.equal(c.isError, false);
  assert.equal(c.usageRecord, 'present');
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
  assert.equal(c.category, 'no_usage_record');
});

// ══════════════════════════════════════════════════════════════════
// GPT 검수 ② — **가짜 `ok`를 만들 수 있었다** (#533)
//
// 두 자리가 겹쳐서 실패를 성공으로 덮었다:
//
//   ① `resultOf`가 `type === 'result'`가 아닌 메시지도 최종 결과로
//      채택했다. `is_error`가 boolean이거나 `num_turns`가 숫자이면
//      충분했다 — 그래서 결과 뒤에 붙은 `{type:'assistant',
//      is_error:false}` 한 줄이 **진짜 실패 결과를 밀어냈다.**
//
//   ② `is_error === false`이면 `subtype`을 보지 않고 `ok`로 끝냈다.
//      그래서 `subtype:'error_max_turns', is_error:false`처럼
//      **스스로 모순된 기록**도 성공이 됐다.
//
// 진단기가 가짜 초록을 만드는 것은 이 저장소에서 가장 비싼 실패다 —
// 복구가 끝났다고 적힌 채 회차가 계속 죽는다.
// ══════════════════════════════════════════════════════════════════

test('★★ 결과 뒤에 붙은 비결과 메시지가 실패를 성공으로 덮지 않는다', () => {
  const c = categorize([
    { type: 'result', subtype: 'error_during_execution', is_error: true,
      num_turns: 1, modelUsage: {}, total_cost_usd: 0 },
    { type: 'assistant', is_error: false },
  ]);
  assert.notEqual(c.category, 'ok', '실패 기록이 뒤 메시지에 덮였다');
  assert.equal(c.isError, true, '최종 결과가 아닌 메시지를 결과로 읽었다');
  assert.equal(c.subtype, 'error_during_execution');
});

test('★★ 결과 메시지가 없으면 비결과 메시지의 is_error로 성공을 적지 않는다', () => {
  const c = categorize([{ type: 'assistant', is_error: false }]);
  assert.equal(c.category, 'no_execution_record');
  assert.equal(c.isError, null, '결과가 아닌 것을 결과로 읽었다');
});

test('★★ num_turns만 있는 비결과 메시지도 결과로 읽지 않는다', () => {
  const c = categorize([{ type: 'assistant', num_turns: 3 }]);
  assert.equal(c.category, 'no_execution_record');
  assert.equal(c.numTurns, null);
});

test('★★ is_error:false인데 subtype이 성공이 아니면 ok로 적지 않는다', () => {
  const c = categorize([{ type: 'result', subtype: 'error_max_turns', is_error: false,
    num_turns: 40, modelUsage: { m: {} }, total_cost_usd: 1 }]);
  assert.notEqual(c.category, 'ok', '모순된 기록을 성공으로 적었다');
  assert.equal(c.category, 'max_turns_exhausted');
});

test('★★ is_error:false인데 subtype을 못 읽었으면 ok로 적지 않는다', () => {
  const c = categorize([{ type: 'result', is_error: false,
    num_turns: 5, modelUsage: { m: {} }, total_cost_usd: 1 }]);
  assert.notEqual(c.category, 'ok', '증거 없이 성공으로 적었다');
  assert.equal(c.subtype, null);
});

test('★★ 음수 턴·소요·비용은 0이 아니라 확인 못 함이다', () => {
  const c = categorize([{ ...OBSERVED, num_turns: -3, duration_ms: -1, total_cost_usd: -0.5 }]);
  assert.equal(c.numTurns, null, '음수 턴을 그대로 적었다');
  assert.equal(c.durationMs, null);
  assert.equal(c.costUsd, null);
  assert.notEqual(c.category, 'no_usage_record',
    '불가능한 숫자 위에서 범주를 단정했다');
});

test('★★ 비용 칸이 아예 없으면 0으로 바꿔 범주를 단정하지 않는다', () => {
  const { total_cost_usd, ...noCost } = OBSERVED;
  const c = categorize([noCost]);
  assert.equal(c.costUsd, null, '없는 비용을 0으로 적었다');
  assert.notEqual(c.category, 'no_usage_record',
    '확인 못 한 비용을 0으로 바꿔 범주를 단정했다');
  assert.equal(c.category, 'unknown');
});

// ── 범주 → 누가 움직여야 하는가 ──
//
// 이 판단은 전에 **워크플로 YAML 안**에 산문으로 있었다. 범주를 고치면
// 산문은 그대로 남아 갈렸다 — 실제로 `credit_or_billing` 회차에
// "인증 단계" 처방이 붙었다. 표로 옮겼으니 표를 고정한다.

test('알려진 범주 전부가 처방 표에 있다 — 새 범주를 올리는 것을 잊으면 RED', () => {
  const missing = CATEGORIES.filter((c) => {
    const a = nextAction(c);
    // 표에 없으면 기본값이 돌아온다. 그 기본값과 같은지로 누락을 센다.
    return a.line === '원인을 범주로 좁히지 못했습니다 — 사람이 봐야 합니다.' && c !== 'unknown';
  });
  assert.deepEqual(missing, [], `처방 표에 없는 범주: ${missing.join(', ')}`);
});

test('★★ 모르는 범주는 시스템이 아니라 사람에게 간다', () => {
  // 기본값이 system이면, 표에 올리는 것을 잊은 새 범주가 "다음 회차가
  // 알아서 한다"로 적히고 영원히 조용히 실패한다.
  assert.equal(nextAction('방금 지어낸 범주').owner, 'human');
  assert.equal(nextAction('unknown').owner, 'human');
  assert.equal(nextAction(undefined).owner, 'human');
});

test('자금·키·권한·모델 접근은 사람만 — 시스템이 하겠다고 적지 않는다', () => {
  for (const c of ['credit_or_billing', 'auth_invalid', 'permission_denied', 'model_not_found']) {
    assert.equal(nextAction(c).owner, 'human', `${c}를 시스템 몫으로 적었다`);
  }
});

test('일시적 실패는 사람을 부르지 않는다', () => {
  for (const c of ['rate_limited', 'overloaded', 'timeout', 'transport_error']) {
    assert.equal(nextAction(c).owner, 'system', `${c}로 사람을 불렀다`);
  }
});

test('원인 미확정(기록 없음)은 사람에게 간다 — 확인 못 한 것은 통과가 아니다', () => {
  assert.equal(nextAction('no_usage_record').owner, 'human');
  assert.equal(nextAction('no_execution_record').owner, 'human');
});

test('ok는 아무도 부르지 않는다', () => {
  assert.equal(nextAction('ok').owner, 'none');
});

test('★★ 요약에 처방이 실린다 — 범주만 적고 끝내지 않는다', () => {
  const out = render(categorize([{
    ...OBSERVED,
    result: 'API Error: Your credit balance is too low to access the Claude API.',
  }]));
  assert.match(out, /범주: `credit_or_billing`/);
  assert.match(out, /다음에 움직일 쪽: \*\*사람\*\*/);
  assert.match(out, /자금 결정은 사람만 합니다/);
  // 원문은 여전히 새지 않는다.
  assert.ok(!out.includes('credit balance'), '오류 원문이 요약에 샜다');
  assert.ok(!out.includes('API Error'), '오류 원문이 요약에 샜다');
});

test('★★ 처방 한 줄에도 오류 원문이 섞이지 않는다', () => {
  for (const c of CATEGORIES) {
    const line = nextAction(c).line;
    assert.ok(!/[A-Za-z]{2,}-[A-Za-z0-9]{8,}/.test(line), `${c}의 처방에 토큰 모양이 있다`);
    assert.ok(!line.includes('http'), `${c}의 처방에 URL이 있다`);
  }
});

// ── 거부가 몇 건인지만 알면 아무것도 할 수 없다 (#533) ──────────
//
// 매시 갈래의 진단은 `권한 거부 수: 5`까지만 적는다. 실측이다 — 최근 6회차가
// 3·5·9·10·10·16건이었고, **무엇이 막혔는지는 어디에도 없다.** 그러면
// "허용 목록을 고쳐야 하는가"에 답할 수 없다.
//
// 이름은 **화이트리스트로만** 적는다. 이 파일의 머리말이 정한 규칙이다 —
// "마스킹은 패턴을 하나 놓치면 새지만, 화이트리스트는 새로운 칸이 생겨도
// 안 샌다." 그래서 아는 도구 이름만 적고, 목록 밖은 **개수로만** 적는다.
test('거부된 도구 이름을 적는다 — 아는 이름만', () => {
  const c = categorize({
    type: 'result', subtype: 'success', is_error: false,
    num_turns: 9, duration_ms: 1000, total_cost_usd: 0.5,
    modelUsage: { 'claude-x': {} },
    permission_denials: [
      { tool_name: 'Bash' }, { tool_name: 'Bash' }, { tool_name: 'WebFetch' },
    ],
  });
  assert.equal(c.permissionDenials, 3);
  const out = render(c);
  assert.match(out, /Bash/, '막힌 도구 이름이 요약에 없다');
  assert.match(out, /WebFetch/, '둘째 도구 이름이 요약에 없다');
  assert.match(out, /Bash.*2|2.*Bash/s, '같은 도구의 횟수를 적지 않았다');
});

test('목록 밖 이름은 **적지 않고 개수로만** 적는다', () => {
  const c = categorize({
    type: 'result', subtype: 'success', is_error: false,
    num_turns: 2, duration_ms: 10, total_cost_usd: 0.1,
    modelUsage: { 'claude-x': {} },
    permission_denials: [
      { tool_name: 'mcp__secretserver__sk-live-DO-NOT-PRINT' },
      { tool_name: 'Bash' },
    ],
  });
  const out = render(c);
  assert.ok(!out.includes('sk-live-DO-NOT-PRINT'), '목록 밖 이름이 그대로 샜다');
  assert.ok(!out.includes('secretserver'), '목록 밖 이름이 그대로 샜다');
  assert.match(out, /Bash/);
  // **이 이름은 MCP 모양이라 `MCP 도구` 칸으로 센다**(`목록 밖`이 아니다).
  // 어느 칸인지는 바뀌어도 지켜야 하는 성질은 둘이다 — 위의 두 assert 처럼
  // 이름이 새지 않는 것, 그리고 **건수가 어디로도 사라지지 않는 것**.
  assert.match(out, /MCP 도구 1건/, 'MCP 거부 건수를 적지 않았다');
  assert.ok(!out.includes('목록 밖'), 'MCP 모양인데 목록 밖으로 셌다');
});

test('거부가 0건이면 이름 줄을 만들지 않는다', () => {
  const c = categorize({
    type: 'result', subtype: 'success', is_error: false,
    num_turns: 1, duration_ms: 10, total_cost_usd: 0.1,
    modelUsage: { 'claude-x': {} }, permission_denials: [],
  });
  assert.ok(!render(c).includes('막힌 도구'), '거부 0건인데 이름 줄이 있다');
});

// 변이 시험에서 이 구멍을 찾았다: 이름을 못 읽은 항목을 조용히 버려도
// 위의 시험들이 전부 통과했다. 그러면 `권한 거부 수: 3`인데 막힌 도구
// 줄에는 `Bash 1건`만 적히고, **나머지 둘이 사라진다.**
// 못 읽은 것을 0으로 적는 것이 이 저장소가 금지하는 바로 그 일이다.
test('이름을 못 읽은 거부도 버리지 않고 센다', () => {
  const t = deniedToolTally([{ tool_name: 'Bash' }, { nope: 1 }, {}, null, 'x']);
  assert.equal(t.unnamed, 4, '이름 없는 항목을 버렸다');
  assert.deepEqual(t.named, [{ name: 'Bash', count: 1 }]);
  const line = deniedToolLine(t);
  assert.match(line, /이름 확인 못 함 4건/, '못 읽은 건수를 적지 않았다');
});

test('막힌 도구 줄의 합이 거부 수와 맞는다', () => {
  const denials = [
    { tool_name: 'Bash' }, { tool_name: 'Bash' }, { tool_name: 'Read' },
    { tool_name: 'mcp__x__y' }, { nope: 1 },
  ];
  const t = deniedToolTally(denials);
  // 칸이 하나 늘었다(`mcp`). 합에 더하지 않으면 이 시험이 **새 칸으로 간
  // 건수를 사라진 것으로 못 본다** — 그게 이 시험의 유일한 일이다.
  const summed = t.named.reduce((a, b) => a + b.count, 0) + t.mcp + t.unlisted + t.unnamed;
  assert.equal(summed, denials.length, `합 ${summed} ≠ 거부 ${denials.length} — 어딘가로 사라졌다`);
});

// ── "목록 밖"이 두 가지를 한 이름으로 섞고 있었다 ──
//
//   `mcp__github__merge_pull_request`가 막힌 것과, 처음 보는 내장 도구가
//   막힌 것이 **같은 `목록 밖 N건`**으로 떨어졌다. 그런데 사람이 할 일이
//   다르다 — 앞은 MCP 설정, 뒤는 도구 허용 목록이다.
//
//   이름은 여전히 내보내지 않는다. MCP 도구 이름은 서버가 정하는 임의
//   문자열이므로 **모양만 보고 개수로만** 센다.

test('MCP 도구 거부를 "목록 밖"과 구별해 센다', () => {
  const t = deniedToolTally([
    { tool_name: 'mcp__github__merge_pull_request' },
    { tool_name: 'mcp__x__y' },
    { tool_name: 'SomeFutureTool' },
    { tool_name: 'Bash' },
  ]);
  assert.equal(t.mcp, 2, 'MCP 거부를 따로 세지 않았다');
  assert.equal(t.unlisted, 1, '목록 밖은 MCP 가 아닌 것만이어야 한다');
  assert.deepEqual(t.named, [{ name: 'Bash', count: 1 }]);
  const line = deniedToolLine(t);
  assert.match(line, /MCP 도구 2건/, 'MCP 건수가 줄에 없다');
  // **이름은 절대 나오지 않는다.**
  assert.ok(!line.includes('mcp__'), `MCP 이름이 새어 나갔다: ${line}`);
  assert.ok(!line.includes('github'), `서버 이름이 새어 나갔다: ${line}`);
});

test('mcp 를 품은 이름이라고 다 MCP 가 아니다 — 접두사 모양만 본다', () => {
  const t = deniedToolTally([
    { tool_name: 'mcpSomething' }, { tool_name: 'mcp__' }, { tool_name: 'x__mcp__y' },
  ]);
  assert.equal(t.mcp, 0, '모양이 아닌 것을 MCP 로 셌다');
  assert.equal(t.unlisted, 3);
});

test('아무 이름도 못 적었으면 목록이 낡았을 수 있다고 적는다', () => {
  // 이름이 전부 목록 밖으로 떨어지면 그 줄은 바꾸기 전의 "개수만"과 똑같이
  // 쓸모가 없어진다. **그걸 알려 주는 장치가 없으면 아무도 모른다.**
  const stale = deniedToolLine(deniedToolTally([{ tool_name: 'SomeFutureTool' }]));
  assert.match(stale, /목록이 낡았을 수 있습니다/, '낡음 신호가 없다');
  // 하나라도 이름이 적혔으면 그 문장을 붙이지 않는다 — 거짓 경보를 만들지 않는다.
  const ok = deniedToolLine(deniedToolTally([{ tool_name: 'Bash' }, { tool_name: 'SomeFutureTool' }]));
  assert.ok(!ok.includes('목록이 낡았을 수 있습니다'), ok);
  // MCP 는 목록이 낡은 것이 아니다 — 모양을 알아본 것이다.
  const mcpOnly = deniedToolLine(deniedToolTally([{ tool_name: 'mcp__a__b' }]));
  assert.ok(!mcpOnly.includes('목록이 낡았을 수 있습니다'), mcpOnly);
});

test('합이 여전히 맞는다 — 새 칸이 생겨도 어디로도 사라지지 않는다', () => {
  const denials = [
    { tool_name: 'Bash' }, { tool_name: 'Read' }, { tool_name: 'mcp__a__b' },
    { tool_name: 'SomeFutureTool' }, { nope: 1 }, null,
  ];
  const t = deniedToolTally(denials);
  const summed = t.named.reduce((a, b) => a + b.count, 0) + t.mcp + t.unlisted + t.unnamed;
  assert.equal(summed, denials.length, `합 ${summed} ≠ 거부 ${denials.length} — 어딘가로 사라졌다`);
});

test('갈래가 쓰는 도구 이름이 전부 출력 목록에 있다 — 표가 코드에서 멀어지는 것을 잡는다', () => {
  // 허용·차단 목록에 새 도구가 생기면 그 이름의 거부는 `목록 밖`으로
  // 떨어진다. 그러면 이름 줄이 다시 쓸모없어지는데, **아무도 모른다.**
  // 그래서 워크플로를 읽어 대조한다(읽기만 한다 — 고치지 않는다).
  const files = readdirSync('.github/workflows')
    .filter(f => /^claude-.*\.ya?ml$/.test(f));
  assert.ok(files.length >= 2, `갈래 워크플로를 ${files.length}개만 찾았다 — 글롭이 빗나갔다`);

  const found = new Set();
  for (const f of files) {
    const src = readFileSync(join('.github/workflows', f), 'utf8');
    const lists = src.match(/--(?:dis)?allowedTools\s+"[^"]*"/g) || [];
    assert.ok(lists.length > 0, `${f}에서 도구 목록을 못 찾았다 — 정규식이 낡았다`);
    for (const l of lists) {
      const inner = l.slice(l.indexOf('"') + 1, -1);
      for (const entry of inner.split(',')) {
        const base = entry.trim().split('(')[0].trim();
        if (base) found.add(base);
      }
    }
  }
  assert.ok(found.size > 0, '도구 이름을 하나도 못 읽었다 — 이 시험이 아무것도 안 보고 있다');
  for (const name of found) {
    assert.ok(PRINTABLE_TOOLS.has(name),
      `갈래가 ${name} 를 쓰는데 출력 목록에 없다 — 그 거부는 "목록 밖"으로 떨어진다`);
  }
});
