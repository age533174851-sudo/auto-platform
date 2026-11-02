#!/usr/bin/env node
// Read-only, zero-generation Anthropic API diagnostic. No credentials, URL query,
// response body, request IDs or provider error strings are ever written to logs.
// A successful models GET proves metadata access, NOT that messages/billing work.

import { readFileSync, existsSync } from 'node:fs';
import { findOverrideKeys } from './lib/oauth-override-names.mjs';

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
 * 메시지 경로가 **이 요청에 어떤 HTTP 상태를 돌려주는가.**
 *
 * 토큰 세기는 생성이 아니고 요금이 붙지 않는다. 메타데이터 GET보다 생성에
 * 가까운 경로이긴 하다.
 *
 * **그래도 이것은 생성 성공의 증거가 아니다.** 모델 접근 권한·청구 상태·
 * 가용성을 확정하지도 못한다 — 한도·동시성·정책은 여기서 보이지 않고,
 * 이 순간의 상태가 다음 순간의 상태도 아니다. 돌려주는 것은 **그 호출의
 * HTTP 상태 분류**뿐이다. 실제 생성이 되는지는 **Claude Code Action이
 * 실제로 성공한 회차**로만 판정한다.
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
  // 이름을 '모델 접근 가능'으로 적지 않는다 — 그건 이 호출이 말할 수 있는
  // 것보다 큰 주장이다. 적는 것은 "그 호출이 200이었다"까지다.
  return result.ok ? { ok: true, code: 'messages_endpoint_http_ok' } : result;
}


// ── #533 보강 ③ 실행 **직전** 프로젝트 설정이 인증을 바꿔치지 않는가 ──
//
// `check-claude-hourly`의 설정 관문은 **git이 추적하는** 파일만 본다.
// 개발자 각자의 추적되지 않는 개인 설정까지 빨갛게 만들면 사람이 그
// 검사기를 무시하게 되기 때문이고, 그것은 CI 시점의 판단으로 옳다.
//
// 그런데 **무인 회차의 시점은 다르다.** 워크플로는
// `npm ci` → 이 사전 점검 → Claude Action 순서로 돈다. 그 사이에 어떤
// 단계가 추적되지 않는 `.claude/settings.json`을 만들면, Claude Code는
// **git이 아니라 파일 시스템을 읽으므로** 그 파일을 설정으로 쓴다.
// 추적만 보는 관문은 그것을 구조적으로 세지 못한다.
//
// (측정: 현재 lockfile의 `npm ci`는 그런 파일을 만들지 않았다 —
//  `.claude`·`settings*.json` 0건, 설치 훅 0개. 그러나 그것은 "불가능"이
//  아니라 **한 번의 측정**이고, lockfile이 바뀌면 다시 UNKNOWN이 된다.
//  그래서 세지 않는 대신 fail-closed로 센다.)
//
// **값·JSON 본문·예외 문구는 어디에도 적지 않는다.** 적는 것은
// 파일 경로 · 정해진 범주 · **우리 목록의 고정된 이름**뿐이다. 설정
// 파일의 키 이름 자체는 적지 않는다 — 그 파일이 신뢰할 수 없는 내용을
// 담고 있을 수 있고, 키 이름을 그대로 적으면 그것이 로그로 흘러나온다.
/** Claude Code가 작업 디렉터리에서 설정으로 읽는 두 파일 */
export const PROJECT_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

export function checkProjectSettings({
  files = PROJECT_SETTINGS_FILES,
  readFile = (f) => readFileSync(f, 'utf8'),
  exists = (f) => existsSync(f),
  log = console.log,
} = {}) {
  const problems = [];
  const notes = [];
  for (const f of files) {
    // 없는 것은 정상이다 — 설정이 없으면 바꿔칠 것도 없다.
    if (!exists(f)) { notes.push(`${f}:absent`); continue; }

    let text;
    try { text = readFile(f); }
    catch { problems.push({ file: f, code: 'settings_unreadable' }); continue; }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch { problems.push({ file: f, code: 'settings_malformed_json' }); continue; }

    // 객체가 아니면 무엇을 설정하는지 셀 수 없다 — 통과로 보지 않는다.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      problems.push({ file: f, code: 'settings_not_object' }); continue;
    }

    const { hits, truncated } = findOverrideKeys(parsed);
    // `h.name`은 **우리 목록의 고정된 이름**이다(파일에서 읽은 문자열이 아니다).
    for (const h of hits) problems.push({ file: f, code: 'settings_auth_override', name: h.name });
    if (truncated) problems.push({ file: f, code: 'settings_depth_exceeded' });
    if (!hits.length && !truncated) notes.push(`${f}:no_auth_override`);
  }
  for (const n of notes) log(`Claude preflight: project_settings=${n}`);
  for (const p of problems) {
    log(`Claude preflight: project_settings=${p.file}:${p.code}`
      + (p.name ? ` (${p.name})` : ''));
  }
  // 이것은 **OAuth 유효성이나 모델 생성 성공의 증거가 아니다.**
  // "실행 직전 설정이 인증을 바꿔치지 않는다"까지만 말한다.
  return problems.length
    ? { ok: false, code: 'project_settings_override', problems }
    : { ok: true, code: 'project_settings_no_override' };
}

/**
 * 사전 점검 한 회차. **설정 검사가 RED면 네트워크를 건드리기 전에 끝낸다.**
 *
 * 앞선 판에서는 설정 검사를 먼저 **부르기만** 했다. 주석에는 "네트워크보다
 * 먼저 본다"고 적어 두었는데, 실제로는 결과를 보지 않고 그대로 메타데이터
 * GET 과 토큰 세기 POST 로 넘어갔고 **마지막 줄에서야** 종료 코드에 반영했다.
 * 즉 설정이 인증을 바꿔친 회차에서도 요청이 두 번 나갔다(실측: 요청 2회).
 * 적어 둔 계약과 코드가 달랐던 자리다.
 *
 * 이제 RED 면 **요청 0회로** 끝낸다. 그 뒤 점검이 무엇을 돌려주든 그 회차는
 * 의도한 인증으로 돌지 않으므로, 더 볼 것이 없다.
 *
 * `request` 와 `checkSettings` 를 주입할 수 있게 해 두어, **요청 횟수를 세는**
 * 음성 시험을 네트워크 없이 돌릴 수 있다.
 */
export async function runPreflight({
  env = process.env,
  request = fetch,
  log = console.log,
  checkSettings = checkProjectSettings,
  // 일시적 제한(429·5xx)에만 제한된 재시도를 쓴다. 401·403·404는 즉시 끝난다.
  retries = 2,
  sleep = defaultSleep,
  timeoutMs = 10_000,
} = {}) {
  const settings = checkSettings({ log });
  if (!settings.ok) {
    log('Claude preflight: aborted_before_network=project_settings_override');
    return { ok: false, code: 'project_settings_override', stage: 'project_settings' };
  }

  const apiKey = env.ANTHROPIC_API_KEY ?? '';
  const metadata = await check({
    apiKey, oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    request, log, retries, sleep, timeoutMs,
  });
  let access = { ok: true, code: 'skipped' };
  // 요금이 붙지 않는 경로지만, 원치 않으면 끌 수 있게 둔다.
  if (apiKey && env.CLAUDE_PREFLIGHT_SKIP_MESSAGES !== '1') {
    access = await checkModelAccess({ apiKey, request, log, retries, sleep, timeoutMs });
  }
  // **둘 중 하나라도 실패면 실패다.** 통과한 쪽만 보고 넘기지 않는다.
  if (!metadata.ok) return { ok: false, code: metadata.code, stage: 'metadata' };
  if (!access.ok) return { ok: false, code: access.code, stage: 'model_access' };
  return { ok: true, code: 'preflight_ok', stage: 'done' };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await runPreflight();
  if (!result.ok) process.exitCode = 1;
}
