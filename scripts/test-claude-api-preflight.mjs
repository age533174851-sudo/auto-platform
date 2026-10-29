import assert from 'node:assert/strict';
import test from 'node:test';
import { check, diagnoseHttpStatus } from './claude-api-preflight.mjs';

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
  assert.equal(result.code, 'model_messages_accessible');
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
