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
