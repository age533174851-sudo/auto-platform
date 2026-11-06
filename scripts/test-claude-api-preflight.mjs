import assert from 'node:assert/strict';
import test from 'node:test';
import { check, diagnoseHttpStatus, checkProjectSettings,
  PROJECT_SETTINGS_FILES, runPreflight } from './claude-api-preflight.mjs';
import { OAUTH_OVERRIDE_NAMES, MAX_DEPTH } from './lib/oauth-override-names.mjs';

const run = async (status, key = 'dummy_secret') => {
  const logs = [];
  let sent;
  const result = await check({
    apiKey: key,
    request: async (url, options) => {
      sent = { url, options };
      return { status, text: () => { throw Error('never read response'); } };
    },
    log: x => logs.push(x),
  });
  return { logs, sent, result };
};

test('200 validates read-only model metadata access but not generation', async () => {
  const { result, sent, logs } = await run(200);
  assert.deepEqual(result, { ok: true, code: 'model_metadata_accessible' });
  assert.equal(sent.options.method, 'GET');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/models/claude-opus-5-5');
  assert.equal(sent.options.headers['x-api-key'], 'dummy_secret');
  assert.ok(logs[0].includes('model_metadata_accessible'));
  assert.ok(!logs.join('').includes('dummy_secret'));
});

for (const [status, code] of [
  [400, 'bad_request_or_api_version'],
  [401, 'invalid_or_expired_api_key'],
  [402, 'payment_required'],
  [403, 'key_or_workspace_forbidden'],
  [404, 'model_unavailable_for_key'],
  [429, 'rate_limited'],
  [500, 'provider_unavailable'],
]) {
  test(String(status) + ' fails closed with only a sanitized category', async () => {
    const { result, logs } = await run(status);
    assert.deepEqual(result, { ok: false, code });
    assert.equal(logs.length, 1);
    assert.ok(!logs.join('').includes('dummy_secret'));
  });
}

test('OAuth-only is unverified, not mislabeled an API-key success', async () => {
  const logs = [];
  const result = await check({ oauthToken: 'oauth_dummy', request: () => { throw Error('must not call'); }, log: x => logs.push(x) });
  assert.equal(result.code, 'oauth_unverified');
  assert.ok(logs[0].includes('not verified'));
  assert.ok(!logs[0].includes('oauth_dummy'));
});

test('missing credentials rejects before network access', async () => {
  const result = await check({ request: () => { throw Error('must not call'); }, log: () => {} });
  assert.deepEqual(result, { ok: false, code: 'missing_credentials' });
});

test('transport error is sanitized without exception body', async () => {
  const logs = [];
  const result = await check({ apiKey: 'dummy_secret', request: async () => { throw Error('dummy_secret from proxy'); }, log: x => logs.push(x) });
  assert.equal(result.code, 'transport_or_timeout_error');
  assert.ok(!logs.join('').includes('dummy_secret'));
});

test('status mapping is deterministic and does not parse provider bodies', () => {
  assert.deepEqual(diagnoseHttpStatus(502), { ok: false, code: 'provider_unavailable' });
});

// ══════════ #533 보강 — 429 제한 재시도 · 메시지 경로 모델 접근 ══════════
//
// 왜 더 필요한가
// ──────────────
// ① `ok:false → exitCode 1`이라 **일시적** 429가 그 시간 회차를 통째로
//    막는다. 제한된 횟수만 다시 보고, 그래도 안 되면 실패로 적는다.
// ② 메타데이터 GET 200은 **생성 권한의 증거가 아니다.** 모델 접근은
//    메시지 경로에서 확인해야 한다. `POST /v1/messages/count_tokens`는
//    **토큰을 생성하지 않고 요금이 붙지 않는** 경로라 그 확인에 쓸 수 있다.
//    (생성 호출은 하지 않는다 — 추가 결제 금지)

import { checkModelAccess, MESSAGES_PREFLIGHT_MODEL } from './claude-api-preflight.mjs';

/** 상태 코드를 순서대로 돌려주는 가짜 전송기 */
function sequence(statuses) {
  const seen = [];
  return {
    seen,
    request: async (url, options) => {
      seen.push({ url, method: options?.method ?? 'GET' });
      const status = statuses[Math.min(seen.length - 1, statuses.length - 1)];
      return { status, text: () => { throw Error('never read response'); } };
    },
  };
}

test('★★ 429는 제한된 재시도 뒤 실패로 적는다 — 성공으로 바꾸지 않는다', async () => {
  const s = sequence([429, 429, 429]);
  const logs = [];
  const result = await check({
    apiKey: 'dummy_secret', request: s.request, log: x => logs.push(x),
    retries: 2, sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'rate_limited');
  assert.equal(s.seen.length, 3, `시도 ${s.seen.length}회 — 1회 + 재시도 2회여야 한다`);
});

test('★★ 429 뒤에 200이면 통과한다 — 일시적 제한으로 회차를 막지 않는다', async () => {
  const s = sequence([429, 200]);
  const result = await check({
    apiKey: 'dummy_secret', request: s.request, log: () => {},
    retries: 2, sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'model_metadata_accessible');
  assert.equal(s.seen.length, 2);
});

test('5xx도 제한된 재시도 대상이다', async () => {
  const s = sequence([503, 503, 200]);
  const result = await check({
    apiKey: 'dummy_secret', request: s.request, log: () => {},
    retries: 2, sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(s.seen.length, 3);
});

for (const [status, code] of [[401, 'invalid_or_expired_api_key'],
  [403, 'key_or_workspace_forbidden'], [404, 'model_unavailable_for_key'],
  [402, 'payment_required']]) {
  test(`★★ ${status}는 재시도하지 않고 ${code}로 구분해 적는다`, async () => {
    const s = sequence([status]);
    const result = await check({
      apiKey: 'dummy_secret', request: s.request, log: () => {},
      retries: 2, sleep: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(s.seen.length, 1, `${status}는 다시 보낼 이유가 없다`);
  });
}

test('★★ 모델 접근은 메시지 경로에서 확인한다 (생성 없음·요금 없음)', async () => {
  const s = sequence([200]);
  const logs = [];
  const result = await checkModelAccess({
    apiKey: 'dummy_secret', request: s.request, log: x => logs.push(x),
    retries: 0, sleep: async () => {},
  });
  assert.equal(result.ok, true);
  // **생성 성공의 증거가 아니다.** 이름도 그렇게 적지 않는다.
  assert.equal(result.code, 'messages_endpoint_http_ok');
  assert.equal(s.seen[0].method, 'POST');
  assert.ok(s.seen[0].url.endsWith('/v1/messages/count_tokens'),
    `생성 엔드포인트를 불렀다: ${s.seen[0].url}`);
  assert.ok(!logs.join(' ').includes('dummy_secret'), '키가 로그에 새어 나갔다');
});

for (const [status, code] of [[401, 'invalid_or_expired_api_key'],
  [403, 'key_or_workspace_forbidden'], [404, 'model_unavailable_for_key']]) {
  test(`모델 접근 ${status} → ${code}`, async () => {
    const result = await checkModelAccess({
      apiKey: 'dummy_secret', request: sequence([status]).request, log: () => {},
      retries: 0, sleep: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  });
}

test('모델 접근 확인에도 키가 없으면 통과로 적지 않는다', async () => {
  const result = await checkModelAccess({ apiKey: '', request: async () => {
    throw Error('불려서는 안 된다');
  }, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_credentials');
});

test('점검 대상 모델은 워크플로가 쓰는 모델과 같다', () => {
  assert.equal(MESSAGES_PREFLIGHT_MODEL, 'claude-opus-5-5');
});

// ── #533 — 실행 **직전** 프로젝트 설정이 인증을 바꿔치지 않는가 ──
//
// `check-claude-hourly`의 설정 관문은 **추적되는** 파일만 본다(개발자
// 개인 설정을 빨갛게 만들지 않으려고). 무인 회차의 시점은 다르다:
// `npm ci` → 이 사전 점검 → Claude Action 순서이고, 그 사이에 생긴
// **추적되지 않는** `.claude/settings.json`도 Claude Code는 읽는다
// (git이 아니라 파일 시스템을 읽기 때문이다).
//
// 이 시험이 고정하는 것:
//   ① 없는 파일은 정상, 정상 설정도 정상
//   ② 추적 여부와 무관하게 금지 키는 **실패**
//   ③ 읽기 실패·깨진 JSON·객체 아님·깊이 초과는 모두 **실패**(fail-closed)
//   ④ **값·JSON 본문·예외 문구가 로그에 새지 않는다**
//   ⑤ OAuth 유효성이나 모델 생성 성공으로 적지 않는다

const SENTINEL = 'SENTINEL-MUST-NEVER-BE-LOGGED-9f3a';

/** 디스크를 건드리지 않는다 — 파일 시스템을 주입한다 */
function fs(map) {
  const logs = [];
  const result = checkProjectSettings({
    files: PROJECT_SETTINGS_FILES,
    exists: (f) => Object.prototype.hasOwnProperty.call(map, f),
    readFile: (f) => {
      const v = map[f];
      if (v instanceof Error) throw v;
      return v;
    },
    log: (x) => logs.push(x),
  });
  return { result, logs, joined: logs.join('\n') };
}

test('설정 파일이 없으면 정상 — 설정이 없으면 바꿔칠 것도 없다', () => {
  const { result, joined } = fs({});
  assert.equal(result.ok, true);
  assert.equal(result.code, 'project_settings_no_override');
  assert.ok(joined.includes('absent'));
});

test('권한 규칙만 있는 설정은 정상 — 이 저장소에 실제로 커밋돼 있는 모양', () => {
  const { result, joined } = fs({
    '.claude/settings.local.json': JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'project_settings_no_override');
  assert.ok(joined.includes('no_auth_override'));
});

test('**추적되지 않아도** apiKeyHelper는 실패다 — 추적 관문이 놓치는 자리', () => {
  const { result, joined } = fs({
    '.claude/settings.json': JSON.stringify({ apiKeyHelper: SENTINEL }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'project_settings_override');
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].code, 'settings_auth_override');
  assert.equal(result.problems[0].name, 'apiKeyHelper');
  assert.ok(!joined.includes(SENTINEL), '값이 로그에 샜습니다');
});

test('env.ANTHROPIC_AUTH_TOKEN도 실패다', () => {
  const { result, joined } = fs({
    '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SENTINEL } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].name, 'ANTHROPIC_AUTH_TOKEN');
  assert.ok(!joined.includes(SENTINEL));
});

test('여섯 이름 전부 — 하나도 빠뜨리지 않는다', () => {
  for (const [name] of OAUTH_OVERRIDE_NAMES) {
    const { result } = fs({ '.claude/settings.json': JSON.stringify({ env: { [name]: SENTINEL } }) });
    assert.equal(result.ok, false, `${name}을 놓쳤습니다`);
    assert.equal(result.problems[0].name, name);
  }
});

test('읽기 실패를 통과로 보지 않고, 예외 문구를 적지 않는다', () => {
  const { result, joined } = fs({ '.claude/settings.json': new Error(`열 수 없음 ${SENTINEL}`) });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].code, 'settings_unreadable');
  assert.ok(!joined.includes(SENTINEL), '예외 문구가 로그에 샜습니다');
});

test('깨진 JSON을 통과로 보지 않고, 본문을 적지 않는다', () => {
  const { result, joined } = fs({ '.claude/settings.json': `{ "apiKeyHelper": "${SENTINEL}"` });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].code, 'settings_malformed_json');
  assert.ok(!joined.includes(SENTINEL), 'JSON 본문이 로그에 샜습니다');
});

test('객체가 아니면 무엇을 설정하는지 셀 수 없다 — 실패', () => {
  for (const body of ['[]', '"str"', '42', 'null']) {
    const { result } = fs({ '.claude/settings.json': body });
    assert.equal(result.ok, false, `${body}를 통과로 봤습니다`);
    assert.equal(result.problems[0].code, 'settings_not_object');
  }
});

test('너무 깊으면 "없음"이 아니라 실패로 적는다', () => {
  let deep = { apiKeyHelper: SENTINEL };
  for (let i = 0; i <= MAX_DEPTH + 2; i += 1) deep = { nest: deep };
  const { result, joined } = fs({ '.claude/settings.json': JSON.stringify(deep) });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === 'settings_depth_exceeded'));
  assert.ok(!joined.includes(SENTINEL));
});

test('설정 파일의 **키 이름**도 로그에 적지 않는다 (신뢰할 수 없는 내용)', () => {
  const { result, joined } = fs({
    '.claude/settings.json': JSON.stringify({ [`${SENTINEL}-outer`]: { apiKeyHelper: 'x' } }),
  });
  assert.equal(result.ok, false);
  assert.ok(!joined.includes(SENTINEL), '설정 파일의 키 이름이 로그에 샜습니다');
});

test('두 파일을 모두 본다 — 한쪽만 보고 넘기지 않는다', () => {
  const { result } = fs({
    '.claude/settings.json': JSON.stringify({ apiKeyHelper: 'x' }),
    '.claude/settings.local.json': JSON.stringify({ env: { ANTHROPIC_API_KEY: 'y' } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 2);
});

test('통과를 OAuth 유효성이나 생성 성공으로 적지 않는다', () => {
  const { result, joined } = fs({});
  assert.equal(result.code, 'project_settings_no_override');
  for (const over of ['oauth_valid', 'model', 'generation', 'authenticated']) {
    assert.ok(!joined.includes(over), `과한 주장이 로그에 있습니다: ${over}`);
  }
});

// ── #533 — 설정 검사가 RED면 **네트워크를 건드리기 전에** 끝내는가 ──
//
// 앞선 판은 설정 검사를 먼저 **부르기만** 했다. 주석에는 "네트워크보다 먼저
// 본다"고 적혀 있었지만 결과를 보지 않고 메타데이터 GET 과 토큰 세기 POST 로
// 넘어갔고, 마지막 줄에서야 종료 코드에 반영했다. 실측(fetch 스텁):
//
//     설정 RED + API 키 → 외부 요청 시도 2회, exitCode 1
//
// 적어 둔 계약과 코드가 달랐다. 이 시험들은 **요청 횟수를 세서** 그 계약을
// 고정한다. 외부 요청은 하나도 나가지 않는다(request 를 주입한다).

const PF_SENTINEL = 'PREFLIGHT-SENTINEL-MUST-NOT-LEAK-7b2e';

/** 요청 횟수를 세는 스텁. 본문은 읽지 않는다 */
function counting(status = 200) {
  const calls = [];
  return {
    calls,
    request: async (url, options) => {
      calls.push({ method: options?.method ?? 'GET' });
      return { status, text: () => { throw Error('본문 읽지 않음'); } };
    },
  };
}

const settingsStub = (ok) => () => (ok
  ? { ok: true, code: 'project_settings_no_override' }
  : { ok: false, code: 'project_settings_override',
      problems: [{ file: '.claude/settings.json', code: 'settings_auth_override', name: 'apiKeyHelper' }] });

async function pf({ ok, env, status = 200 }) {
  const { calls, request } = counting(status);
  const logs = [];
  const result = await runPreflight({
    env, request, log: (x) => logs.push(x),
    checkSettings: settingsStub(ok), retries: 0, sleep: async () => {},
  });
  return { result, calls, logs, joined: logs.join('\n') };
}

test('설정 RED + API 키 → **요청 0회**로 중단한다', async () => {
  const { result, calls, joined } = await pf({ ok: false, env: { ANTHROPIC_API_KEY: PF_SENTINEL } });
  assert.equal(calls.length, 0, `요청이 ${calls.length}회 나갔습니다`);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'project_settings_override');
  assert.equal(result.stage, 'project_settings');
  assert.ok(joined.includes('aborted_before_network'));
  assert.ok(!joined.includes(PF_SENTINEL), '값이 로그에 샜습니다');
});

test('설정 RED + OAuth 전용 → 요청 0회로 중단한다', async () => {
  const { result, calls } = await pf({ ok: false, env: { CLAUDE_CODE_OAUTH_TOKEN: PF_SENTINEL } });
  assert.equal(calls.length, 0);
  assert.equal(result.ok, false);
});

test('설정 RED + 자격 증명 없음 → 요청 0회, 그래도 실패', async () => {
  const { result, calls } = await pf({ ok: false, env: {} });
  assert.equal(calls.length, 0);
  assert.equal(result.ok, false);
});

test('설정 GREEN + OAuth 전용 → 요청 0회, 기존 분류 유지', async () => {
  const { result, calls, joined } = await pf({ ok: true, env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } });
  assert.equal(calls.length, 0, 'OAuth 전용인데 API 키 경로를 찔렀습니다');
  assert.equal(result.ok, true);
  assert.ok(joined.includes('oauth_only'));
});

test('설정 GREEN + API 키 → 기존 제한된 호출을 그대로 한다 (메타데이터 + 토큰 세기)', async () => {
  const { result, calls } = await pf({ ok: true, env: { ANTHROPIC_API_KEY: 'k' } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'POST');
  assert.equal(result.ok, true);
});

test('설정 GREEN + API 키 + SKIP_MESSAGES=1 → 메타데이터만 한 번', async () => {
  const { result, calls } = await pf({
    ok: true, env: { ANTHROPIC_API_KEY: 'k', CLAUDE_PREFLIGHT_SKIP_MESSAGES: '1' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(result.ok, true);
});

test('설정 GREEN + 자격 증명 없음 → 요청 0회, 통과로 적지 않는다', async () => {
  const { result, calls } = await pf({ ok: true, env: {} });
  assert.equal(calls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_credentials');
});

test('설정 GREEN + API 키 + 401 → 실패로 적는다', async () => {
  const { result } = await pf({ ok: true, env: { ANTHROPIC_API_KEY: 'k' }, status: 401 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_or_expired_api_key');
  assert.equal(result.stage, 'metadata');
});
