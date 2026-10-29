#!/usr/bin/env node
// Read-only, zero-generation Anthropic API diagnostic. No credentials, URL query,
// response body, request IDs or provider error strings are ever written to logs.
// A successful models GET proves metadata access, NOT that messages/billing work.

const MODEL = 'claude-opus-5-5';
const ENDPOINT = `https://api.anthropic.com/v1/models/${MODEL}`;

// ── #533 보강 ──
//
// ① **일시적 실패와 확정 실패를 나눈다.** 429·5xx는 다시 보면 풀릴 수
//    있다. 그런데 `ok:false`가 그대로 종료 코드 1이 되므로, 재시도가
//    없으면 **일시적 제한 한 번이 그 시간 회차를 통째로 막는다.**
//    401·403·404는 다시 보낼 이유가 없다 — 같은 답이 온다.
//
// ② **메타데이터 GET 200은 생성 권한의 증거가 아니다.** 모델 접근은
//    메시지 경로에서 확인해야 한다. `POST /v1/messages/count_tokens`는
//    토큰을 **생성하지 않고 요금이 붙지 않는** 경로라 여기에 쓸 수 있다.
//    생성(`POST /v1/messages`)은 부르지 않는다 — 추가 결제 금지.

/** 워크플로의 `--model`과 **같은 값이어야 한다.** 갈리면 점검이 거짓이 된다 */
export const MESSAGES_PREFLIGHT_MODEL = MODEL;
const MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages/count_tokens';
/** 다시 보낼 가치가 있는 상태 */
const TRANSIENT = (status) => status === 429 || status >= 500;
const KNOWN = new Map([
  [400, 'bad_request_or_api_version'],
  [401, 'invalid_or_expired_api_key'],
  [402, 'payment_required'],
  [403, 'key_or_workspace_forbidden'],
  [404, 'model_unavailable_for_key'],
  [408, 'request_timeout'],
  [429, 'rate_limited'],
]);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function diagnoseHttpStatus(status) {
  if (status === 200) return { ok: true, code: 'model_metadata_accessible' };
  return { ok: false, code: KNOWN.get(status) ?? (status >= 500 ? 'provider_unavailable' : 'unexpected_http_status') };
}

/**
 * 한 번 보내고, **일시적 실패만** 제한된 횟수로 다시 보낸다.
 *
 * 응답 본문은 읽지 않는다 — 공급자 오류 문구에 요청별 정보가 들어 있다.
 */
async function probe({ label, url, init, request, log, retries, sleep, timeoutMs }) {
  let last = { ok: false, code: 'transport_or_timeout_error' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    let status = null;
    try {
      const response = await request(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      status = response.status;
    } catch {
      // 저수준 오류 문구는 키·URL을 담을 수 있어 적지 않는다.
      last = { ok: false, code: 'transport_or_timeout_error' };
      if (attempt < retries) { await sleep(250 * (attempt + 1)); continue; }
      log(`Claude preflight: ${label}=transport_or_timeout_error`);
      return last;
    }
    last = diagnoseHttpStatus(status);
    if (last.ok || !TRANSIENT(status)) {
      log(`Claude preflight: ${label}=${last.code} (HTTP ${status})`);
      return last;
    }
    // 일시적이다. 남은 횟수가 있으면 다시 본다.
    if (attempt < retries) {
      log(`Claude preflight: ${label}=${last.code} (HTTP ${status}) — 재시도 ${attempt + 1}/${retries}`);
      await sleep(250 * (attempt + 1));
      continue;
    }
    // **재시도를 다 썼다. 실패로 적는다** — 성공으로 바꾸지 않는다.
    log(`Claude preflight: ${label}=${last.code} (HTTP ${status}) — 재시도 소진`);
    return last;
  }
  return last;
}

export async function check({
  apiKey = '', oauthToken = '', request = fetch,
  // **기본값은 재시도 없음이다.** 재시도는 정책이고, 정책은 호출부(CLI)가
  // 정한다. 라이브러리 기본값을 바꾸면 이 함수를 쓰는 기존 시험과 호출부의
  // 동작이 말없이 달라진다.
  log = console.log, timeoutMs = 10_000, retries = 0, sleep = defaultSleep,
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
  return probe({
    label: 'metadata', url: ENDPOINT,
    init: { method: 'GET', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
    request, log, retries, sleep, timeoutMs,
  });
}

/**
 * **모델이 메시지 경로에서 쓸 수 있는가.**
 *
 * 토큰 세기는 생성이 아니고 요금이 붙지 않는다. 그래도 인증·모델 권한은
 * 생성과 같은 경로에서 평가되므로, 메타데이터 GET보다 훨씬 가까운 증거다.
 * 그렇다고 **생성이 성공한다는 증거는 아니다** — 한도·동시성·정책은 여기서
 * 보이지 않는다.
 */
export async function checkModelAccess({
  apiKey = '', request = fetch, log = console.log,
  timeoutMs = 10_000, retries = 0, sleep = defaultSleep,
  model = MESSAGES_PREFLIGHT_MODEL,
} = {}) {
  if (!apiKey) {
    log('Claude preflight: model_access=missing_credentials');
    return { ok: false, code: 'missing_credentials' };
  }
  const result = await probe({
    label: 'model_access', url: MESSAGES_ENDPOINT,
    init: {
      method: 'POST',
      headers: {
        'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      // 고정 문구다. 프롬프트·저장소 내용이 들어가지 않는다.
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }] }),
    },
    request, log, retries, sleep, timeoutMs,
  });
  return result.ok ? { ok: true, code: 'model_messages_accessible' } : result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  // 일시적 제한(429·5xx)에만 제한된 재시도를 쓴다. 401·403·404는 즉시 끝난다.
  const RETRIES = 2;
  const metadata = await check({
    apiKey,
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    retries: RETRIES,
  });
  let access = { ok: true, code: 'skipped' };
  // 요금이 붙지 않는 경로지만, 원치 않으면 끌 수 있게 둔다.
  if (apiKey && process.env.CLAUDE_PREFLIGHT_SKIP_MESSAGES !== '1') {
    access = await checkModelAccess({ apiKey, retries: RETRIES });
  }
  // **둘 중 하나라도 실패면 실패다.** 통과한 쪽만 보고 넘기지 않는다.
  if (!metadata.ok || !access.ok) process.exitCode = 1;
}
