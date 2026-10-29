#!/usr/bin/env node
// scripts/claude-exec-category.mjs
//
// **Claude Code Action이 삼킨 SDK 실패를 민감정보 없이 분류한다.** (#533)
//
// 무엇이 있었나
// ─────────────
// 실패 회차 40921526704 · 40921531797의 로그에는 Claude 단계의 오류가
// **한 줄도 없다.** action이 기본값으로 전체 SDK 오류를 숨기고
// `Claude execution failed: result is_error:true`만 남긴다. 그래서 로그를
// 아무리 읽어도 원인이 안 나온다 — 읽을 것이 없는 것이다.
//
// 어떻게 적는가
// ─────────────
// **출력은 허용한 칸만 조립한다.** 원문을 가공해서 내보내지 않는다.
// 오류 문구는 범주를 **고르는 데만** 쓰고 그 문구 자체는 절대 출력하지
// 않는다. 그래서 키·토큰·프롬프트·요청 ID·URL이 섞일 경로가 없다 —
// 지우는 것(마스킹)이 아니라 **애초에 담지 않는 것**이다. 마스킹은
// 패턴을 하나 놓치면 새지만, 화이트리스트는 새로운 칸이 생겨도 안 샌다.
//
// 숫자는 문구보다 안전하지만 **숫자도 과장할 수 있다.**
//
// `modelUsage`는 모델별 사용량 묶음이라 `Object.keys().length`는
// **서로 다른 모델의 개수**지 호출 횟수가 아니다 — 한 모델을 100번 불러도
// 1이다. 그래서 '호출 수'로 적지 않는다.
//
// 비어 있는 것도 "한 번도 안 불렀다"의 증거가 아니다. SDK가 기록을 남기지
// 못했거나 집계가 늦었을 수도 있다. 이 저장소의 규칙 그대로 —
// **확인하지 못한 것은 통과도 0도 아니다.** `no_usage_record`는 "사용 기록이
// 없다"는 관측이지 "호출이 없었다"는 결론이 아니다.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 오류 문구 → 범주. 구체적인 것부터 본다 */
const PATTERNS = [
  ['credit_or_billing', /credit balance|\b402\b|payment required|billing/i],
  ['auth_invalid', /authentication_error|invalid x-api-key|\b401\b|unauthorized/i],
  ['permission_denied', /permission_error|\b403\b|forbidden/i],
  ['model_not_found', /not_found_error|\b404\b|unknown model|model[^\n]{0,40}not (found|exist)/i],
  ['rate_limited', /rate_limit|\b429\b|too many requests/i],
  ['overloaded', /overloaded|\b529\b/i],
  ['max_turns_exhausted', /maximum number of turns|max[_ ]turns/i],
  ['timeout', /timed? ?out|\bETIMEDOUT\b/i],
  ['transport_error', /ECONNRESET|socket hang up|EAI_AGAIN|ENOTFOUND|network error/i],
  ['invalid_request', /invalid_request_error|\b400\b|bad request/i],
];

/** 숫자 하나를 안전하게 읽는다. 못 읽으면 null — 0으로 바꾸지 않는다 */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 결과 메시지를 찾는다. 배열·`{messages:[]}`·생 JSON 문자열을 받는다 */
function resultOf(input) {
  let data = input;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  if (data == null || typeof data !== 'object') return null;
  const list = Array.isArray(data) ? data
    : Array.isArray(data.messages) ? data.messages
      : Array.isArray(data.output) ? data.output
        : [data];
  // 마지막 result 메시지가 최종 판정이다.
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && typeof m === 'object'
        && (m.type === 'result' || typeof m.is_error === 'boolean' || num(m.num_turns) != null)) {
      return m;
    }
  }
  return null;
}

/**
 * 분류한다. **순수 함수다** — 파일도 네트워크도 타지 않는다.
 *
 * 돌려주는 값에는 허용한 스칼라만 들어간다. 원문 문구는 들어가지 않는다.
 */
export function categorize(input) {
  const r = resultOf(input);
  if (!r) {
    return {
      category: 'no_execution_record', isError: null, subtype: null,
      numTurns: null, durationMs: null, costUsd: null, permissionDenials: null,
    };
  }

  // 칸이 아예 없으면 **모른다**. 0으로 바꾸지 않는다.
  const hasUsageField = r.modelUsage != null && typeof r.modelUsage === 'object';
  const usageModelKinds = hasUsageField ? Object.keys(r.modelUsage).length : null;
  const usageRecord = !hasUsageField ? 'unknown' : (usageModelKinds > 0 ? 'present' : 'absent');
  const numTurns = num(r.num_turns);
  const out = {
    // subtype은 SDK가 정한 짧은 열거값이다. 자유 문구가 아니다.
    subtype: typeof r.subtype === 'string' && /^[a-z_]{1,32}$/.test(r.subtype) ? r.subtype : null,
    isError: typeof r.is_error === 'boolean' ? r.is_error : null,
    numTurns,
    durationMs: num(r.duration_ms),
    costUsd: num(r.total_cost_usd),
    // **호출 횟수가 아니다.** modelUsage에 나타난 모델 종류의 수다.
    usageModelKinds,
    /** 'present' | 'absent' | 'unknown' */
    usageRecord,
    permissionDenials: Array.isArray(r.permission_denials) ? r.permission_denials.length : null,
    category: 'unknown',
  };

  if (out.isError === false) { out.category = 'ok'; return out; }

  // 범주를 고르는 데만 쓴다. 이 문자열은 **어디에도 출력되지 않는다.**
  const haystack = [r.result, r.error?.message, r.error?.type, r.message, r.subtype]
    .filter((v) => typeof v === 'string').join(' \n ');
  for (const [category, re] of PATTERNS) {
    if (re.test(haystack)) { out.category = category; return out; }
  }

  // 문구가 없을 때. 사용 기록이 **비어 있다는 관측**까지만 적는다.
  // 기록이 없는 것과 호출이 없었던 것을 같은 말로 쓰지 않는다.
  if (usageRecord === 'absent' && numTurns != null && numTurns <= 1
      && (out.costUsd ?? 0) === 0) {
    out.category = 'no_usage_record';
  }
  return out;
}

/** 사람이 읽을 요약. **이 함수는 분류 결과의 칸만 쓴다** */
export function render(c) {
  const v = (x) => (x == null ? '확인 못 함' : String(x));
  return [
    '## Claude 실행 진단 (민감정보 제외)',
    '',
    `- 범주: \`${c.category}\``,
    `- is_error: ${v(c.isError)}`,
    `- subtype: ${c.subtype == null ? '확인 못 함' : `\`${c.subtype}\``}`,
    `- 턴 수: ${v(c.numTurns)}`,
    `- 소요: ${c.durationMs == null ? '확인 못 함' : `${c.durationMs}ms`}`,
    `- 비용(USD): ${v(c.costUsd)}`,
    `- 모델 사용 기록: ${{ present: '있음', absent: '없음', unknown: '확인 못 함' }[c.usageRecord] ?? '확인 못 함'}`,
    `- 사용 기록의 모델 종류 수: ${v(c.usageModelKinds)} (호출 횟수가 아닙니다)`,
    `- 권한 거부 수: ${v(c.permissionDenials)}`,
    '',
    c.category === 'no_usage_record'
      ? '**모델 사용 기록이 없습니다.** 생성 요청에 닿지 못했을 수도 있고, SDK가'
        + ' 사용량을 기록하지 못했을 수도 있습니다 — 둘을 여기서 확정하지'
        + ' 않습니다. 인증·모델 권한·SDK 기동 쪽을 먼저 봅니다.'
      : c.category === 'no_execution_record'
        ? '실행 기록 파일을 찾지 못했습니다. **성공으로 보지 않습니다.**'
        : '오류 문구 자체는 키·요청 ID를 담을 수 있어 적지 않았습니다. 범주만 적습니다.',
  ].join('\n');
}

/** `$RUNNER_TEMP`에서 실행 기록을 찾는다 */
export function findExecutionFile(dir, list = readdirSync) {
  if (!dir) return null;
  try {
    const hit = list(dir).filter((f) => /^claude-execution-output.*\.json$/.test(f)).sort();
    return hit.length ? join(dir, hit[hit.length - 1]) : null;
  } catch { return null; }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const path = process.argv[2]
    || process.env.CLAUDE_EXECUTION_FILE
    || findExecutionFile(process.env.RUNNER_TEMP);
  let raw = null;
  if (path) { try { raw = readFileSync(path, 'utf8'); } catch { raw = null; } }
  // 보고용이다. **종료 코드로 회차 판정을 바꾸지 않는다** — 실제 실패는
  // Claude 단계가 이미 적었고, 여기서 0이 아닌 값을 주면 원인이 가려진다.
  console.log(render(categorize(raw)));
}
