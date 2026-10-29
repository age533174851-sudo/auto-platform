#!/usr/bin/env node
// Read-only, zero-generation Anthropic API diagnostic. No credentials, URL query,
// response body, request IDs or provider error strings are ever written to logs.
// A successful models GET proves metadata access, NOT that messages/billing work.

const MODEL = 'claude-opus-5-5';
const ENDPOINT = `https://api.anthropic.com/v1/models/${MODEL}`;
const KNOWN = new Map([
  [400, 'bad_request_or_api_version'],
  [401, 'invalid_or_expired_api_key'],
  [402, 'payment_required'],
  [403, 'key_or_workspace_forbidden'],
  [404, 'model_unavailable_for_key'],
  [408, 'request_timeout'],
  [429, 'rate_limited'],
]);

export function diagnoseHttpStatus(status) {
  if (status === 200) return { ok: true, code: 'model_metadata_accessible' };
  return { ok: false, code: KNOWN.get(status) ?? (status >= 500 ? 'provider_unavailable' : 'unexpected_http_status') };
}

export async function check({
  apiKey = '', oauthToken = '', request = fetch,
  log = console.log, timeoutMs = 10_000,
} = {}) {
  // OAuth is intentionally not probed with an API-key endpoint.
  if (!apiKey) {
    if (oauthToken) {
      log('Claude preflight: oauth_only; API-key model GET not applicable (not verified)');
      return { ok: true, code: 'oauth_unverified' };
    }
    log('Claude preflight: missing_credentials');
    return { ok: false, code: 'missing_credentials' };
  }
  try {
    const response = await request(ENDPOINT, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    const result = diagnoseHttpStatus(response.status);
    // Do not read the body; provider errors can contain request-specific data.
    log(`Claude preflight: ${result.code} (HTTP ${response.status})`);
    return result;
  } catch {
    // Intentionally hide low-level error text: it can include credentials/URLs.
    log('Claude preflight: transport_or_timeout_error');
    return { ok: false, code: 'transport_or_timeout_error' };
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await check({
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
  });
  if (!result.ok) process.exitCode = 1;
}
