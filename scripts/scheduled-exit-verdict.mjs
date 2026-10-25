#!/usr/bin/env node
// 예약 청산 호출의 HTTP 성공과 실제 예약별 결과를 분리한다.
// 주문·청산을 실행하지 않는 순수 판정기. CI: --self-test.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const SAFE_RESULTS = new Set(['ok', 'no_position', 'skipped']);

export function scheduledExitVerdict(httpCode, bodyText) {
  if (String(httpCode) !== '200') return { ok: false, code: 'HTTP_NOT_200' };
  let body;
  try { body = JSON.parse(String(bodyText)); }
  catch { return { ok: false, code: 'BODY_UNREADABLE' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'BODY_NOT_OBJECT' };
  }
  if (body.ok !== true) return { ok: false, code: 'APP_NOT_OK' };
  if (!Number.isSafeInteger(body.checked) || body.checked < 0
      || !Number.isSafeInteger(body.fired) || body.fired < 0
      || !Number.isSafeInteger(body.stale) || body.stale < 0
      || !Array.isArray(body.results) || body.fired !== body.results.length
      || body.checked < body.fired) {
    return { ok: false, code: 'RESULTS_UNREADABLE' };
  }
  // stale은 이미 청산 시각을 놓쳤다는 뜻이다. 주문을 재전송하지 않고 실패로 알린다.
  if (body.stale > 0) return { ok: false, code: 'MISSED_EXIT', count: body.stale };
  for (const row of body.results) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || typeof row.result !== 'string' || !SAFE_RESULTS.has(row.result)) {
      // failed/claim_failed/알 수 없는 새 상태를 HTTP 200이라고 성공으로 적지 않는다.
      return { ok: false, code: 'EXIT_NOT_CONFIRMED', result: row?.result ?? null };
    }
  }
  return { ok: true, code: 'OK', fired: body.fired };
}

function selfTest() {
  const body = (changes = {}) => JSON.stringify({
    ok: true, checked: 0, fired: 0, stale: 0, results: [], caller: 'cron', ...changes,
  });
  const cases = [
    ['빈 예약은 정상', '200', body(), true, 'OK'],
    ['청산 성공', '200', body({ checked: 1, fired: 1, results: [{ result: 'ok' }] }), true, 'OK'],
    ['이미 닫힌 포지션', '200', body({ checked: 1, fired: 1, results: [{ result: 'no_position' }] }), true, 'OK'],
    ['다른 실행기가 선점', '200', body({ checked: 1, fired: 1, results: [{ result: 'skipped' }] }), true, 'OK'],
    ['청산 실패', '200', body({ checked: 1, fired: 1, results: [{ result: 'failed' }] }), false, 'EXIT_NOT_CONFIRMED'],
    ['선점 DB 실패', '200', body({ checked: 1, fired: 1, results: [{ result: 'claim_failed' }] }), false, 'EXIT_NOT_CONFIRMED'],
    ['청산 시각 놓침', '200', body({ checked: 1, fired: 1, stale: 1, results: [{ result: 'stale' }] }), false, 'MISSED_EXIT'],
    ['결과 배열은 정상이어도 stale > 0', '200', body({ checked: 1, stale: 1 }), false, 'MISSED_EXIT'],
    ['알 수 없는 결과', '200', body({ checked: 1, fired: 1, results: [{ result: 'new_status' }] }), false, 'EXIT_NOT_CONFIRMED'],
    ['앱 실패', '200', body({ ok: false }), false, 'APP_NOT_OK'],
    ['ok 문자열 위장', '200', body({ ok: 'true' }), false, 'APP_NOT_OK'],
    ['HTML 오류 페이지', '200', '<html>ok</html>', false, 'BODY_UNREADABLE'],
    ['잘린 JSON', '200', '{"ok":true', false, 'BODY_UNREADABLE'],
    ['null 응답', '200', 'null', false, 'BODY_NOT_OBJECT'],
    ['결과 배열 누락', '200', '{"ok":true,"checked":0,"fired":0,"stale":0}', false, 'RESULTS_UNREADABLE'],
    ['결과 수 불일치', '200', body({ checked: 1, fired: 1, results: [] }), false, 'RESULTS_UNREADABLE'],
    ['HTTP 500', '500', body(), false, 'HTTP_NOT_200'],
    ['HTTP 401', '401', body(), false, 'HTTP_NOT_200'],
  ];
  for (const [name, code, payload, expectedOk, expectedCode] of cases) {
    const got = scheduledExitVerdict(code, payload);
    assert.equal(got.ok, expectedOk, name);
    assert.equal(got.code, expectedCode, name);
  }
  // 검사기 자체가 배선되지 않아도 초록으로 끝나는 퇴행을 막는다.
  const workflow = readFileSync('.github/workflows/scheduled-exit.yml', 'utf8');
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /actions\/checkout@v4/, '예약 청산 워크플로 checkout 누락');
  assert.match(workflow, /node scripts\/scheduled-exit-verdict\.mjs "\$code" \/tmp\/out\.json/, '예약 청산 응답 판정기 배선 누락');
  assert.match(ci, /node scripts\/scheduled-exit-verdict\.mjs --self-test/, 'CI 자기검사 배선 누락');
  console.log('scheduled-exit verdict: 18/18 + workflow/CI wiring PASS');
}

if (process.argv[1]?.endsWith('/scheduled-exit-verdict.mjs')) {
  if (process.argv[2] === '--self-test') {
    selfTest();
  } else {
    const code = process.argv[2] ?? '';
    const path = process.argv[3] ?? '';
    let raw = '';
    try { raw = readFileSync(path, 'utf8'); } catch { /* BODY_UNREADABLE */ }
    const verdict = scheduledExitVerdict(code, raw);
    console.log(verdict.ok
      ? `예약 청산 응답 정상 (결과 ${verdict.fired}건)`
      : `::error::예약 청산 결과 확인 실패 [${verdict.code}]${verdict.result == null ? '' : ' result=' + verdict.result}`);
    if (!verdict.ok) process.exitCode = 1;
  }
}
