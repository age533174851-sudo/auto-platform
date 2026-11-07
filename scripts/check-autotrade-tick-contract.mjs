#!/usr/bin/env node
// scripts/check-autotrade-tick-contract.mjs
//
// **`autotrade-tick`이 "200이면 성공"으로 되돌아가지 못하게 한다.**
//
// `/api/autotrade/daily-ladder`는 예약 표를 못 읽어도 **HTTP 200**에
// `ok:false`를 실어 돌려준다. HTTP 코드만 보면 그 회차는 초록이고,
// 자동매매가 하루 종일 한 번도 안 돌아도 아무도 모른다.
//
// 여기서 두 가지를 센다:
//   ① 판정기(`autotrade-tick-verdict.mjs`)가 실제로 옳게 판정하는가
//      — 가짜 응답을 넣고 결과를 본다. 모양 검사가 아니라 **동작** 검사다.
//   ② 워크플로가 그 판정기를 **실제로 부르는가**
//      — 만들어 놓고 배선을 안 하는 것이 이 저장소에서 가장 자주 난 고장이다.

import { readFileSync, existsSync } from 'node:fs';
import { tickVerdict } from './autotrade-tick-verdict.mjs';

let bad = 0;
const err = (m) => { bad++; console.error(`❌ ${m}`); console.log(`::error::${m}`); };
const eq = (actual, expected, label) => {
  if (actual !== expected) err(`${label}: 기대 ${expected}, 실제 ${actual}`);
};

// ── ① 판정 동작 ──

// 정상 관망은 **성공이다.** 여기서 실패로 만들면 매 15분 X가 뜨고,
// 그러면 아무도 안 보게 되어 진짜 고장이 같이 묻힌다.
for (const [label, body] of [
  ['켜진 예약 없음', '{"ok":true,"scheduled":0,"results":[],"note":"켜져 있는 자동매매 설정이 없습니다"}'],
  ['간격 안 됨', '{"ok":true,"scheduled":1,"results":[{"ok":true,"executed":false,"code":"WAITING"}]}'],
  ['진입함', '{"ok":true,"scheduled":1,"results":[{"ok":true,"executed":true}]}'],
  ['평가했지만 진입 안 함', '{"ok":true,"scheduled":1,"results":[{"ok":true,"executed":false,"outcome":"NO_SIGNAL"}]}'],
  ['꺼진 예약 건너뜀', '{"ok":true,"scheduled":1,"results":[{"ok":true,"skipped":true,"code":"OFF"}]}'],
]) {
  const v = tickVerdict(200, body);
  if (!v.ok) err(`정상 관망을 실패로 적었습니다 (${label}): [${v.code}] ${v.reason}`);
}

// **200 + ok:false는 실패다.** 이 PR이 닫는 구멍이다.
{
  const v = tickVerdict(200, '{"ok":false,"error":"autotrade_schedules 조회 실패","scheduled":0}');
  eq(v.ok, false, '200 + ok:false');
  eq(v.code, 'APP_FAILED', '200 + ok:false 코드');
  if (v.ok || !/조회 실패/.test(v.reason)) {
    err(`200 + ok:false의 사유가 응답에서 오지 않습니다: ${v.reason}`);
  }
}

// DB 오류는 라우트가 200 + ok:false로 내보낸다 — 위와 같은 경로다.
for (const [label, body] of [
  ['표 없음', '{"ok":false,"error":"autotrade_schedules 표가 아직 없습니다","scheduled":0}'],
  ['쿼터 초과', '{"ok":false,"error":"402 payment required","scheduled":0}'],
]) {
  const v = tickVerdict(200, body);
  eq(v.ok, false, `DB 오류(${label})`);
  eq(v.code, 'APP_FAILED', `DB 오류(${label}) 코드`);
}

// ── 최상위 ok:true여도 **개별 예약 실패**는 초록이 아니다 ──
//
// 라우트에서 `results[].ok`가 false가 되는 경우는 둘뿐이고 둘 다 관망이
// 아니다: `due.code === 'NO_CONNECTION'`(연결 없는 예약) ·
// `record.outcome === 'FAILED'`(평가 실패). 저절로 낫지 않는 고장이다.
for (const [label, body, want] of [
  ['연결 없는 예약',
    '{"ok":true,"scheduled":1,"results":[{"ok":false,"code":"NO_CONNECTION","symbol":"BTCUSDT"}]}',
    'SCHEDULE_FAILED'],
  ['평가 FAILED',
    '{"ok":true,"scheduled":1,"results":[{"ok":false,"outcome":"FAILED","symbol":"ETHUSDT"}]}',
    'SCHEDULE_FAILED'],
  ['성공과 실패가 섞임',
    '{"ok":true,"scheduled":2,"results":[{"ok":true,"executed":true},{"ok":false,"code":"NO_CONNECTION"}]}',
    'SCHEDULE_FAILED'],
]) {
  const v = tickVerdict(200, body);
  eq(v.ok, false, `개별 예약 실패(${label})`);
  eq(v.code, want, `개별 예약 실패(${label}) 코드`);
}
{
  // 사유가 응답에서 와야 한다 — 어느 예약이 왜 막혔는지 로그에 남아야
  // 사람이 고칠 수 있다.
  const v = tickVerdict(200,
    '{"ok":true,"scheduled":1,"results":[{"ok":false,"code":"NO_CONNECTION","symbol":"BTCUSDT"}]}');
  if (!/BTCUSDT/.test(v.reason) || !/NO_CONNECTION/.test(v.reason)) {
    err(`개별 예약 실패 사유가 응답에서 오지 않습니다: ${v.reason}`);
  }
}

// 예약이 있는데 결과 목록을 못 읽으면 실패다. 예약 0건이면 없어도 된다.
eq(tickVerdict(200, '{"ok":true,"scheduled":1}').code, 'RESULTS_UNREADABLE', '예약 1건 · results 없음');
eq(tickVerdict(200, '{"ok":true,"scheduled":2,"results":"x"}').code, 'RESULTS_UNREADABLE', '예약 2건 · results 문자열');
eq(tickVerdict(200, '{"ok":true,"scheduled":0}').ok, true, '예약 0건 · results 없음은 정상');

// 읽을 수 없는 본문을 "정상 관망"으로 적지 않는다.
for (const [label, body, want] of [
  ['빈 본문', '', 'BODY_UNREADABLE'],
  ['공백만', '   \n', 'BODY_UNREADABLE'],
  ['HTML 오류 페이지', '<!DOCTYPE html><h1>Internal Error</h1>', 'BODY_UNREADABLE'],
  ['잘린 JSON', '{"ok":true,"sched', 'BODY_UNREADABLE'],
  ['배열', '[]', 'BODY_NOT_OBJECT'],
  ['문자열', '"ok"', 'BODY_NOT_OBJECT'],
  ['null', 'null', 'BODY_NOT_OBJECT'],
  ['ok 칸 없음', '{"scheduled":1,"results":[]}', 'OK_FIELD_MISSING'],
  ['ok가 문자열 "true"', '{"ok":"true"}', 'APP_FAILED'],
]) {
  const v = tickVerdict(200, body);
  eq(v.ok, false, `비정상 본문(${label})`);
  eq(v.code, want, `비정상 본문(${label}) 코드`);
}

// HTTP 실패는 그대로 실패다.
for (const code of [500, 502, 503, 401, 404, 0, NaN, 'x']) {
  const v = tickVerdict(code, '{"ok":true}');
  eq(v.ok, false, `HTTP ${code}`);
  eq(v.code, 'HTTP_NOT_200', `HTTP ${code} 코드`);
}

// ── ② 워크플로가 판정기를 실제로 부르는가 ──

const WF = '.github/workflows/autotrade-tick.yml';
if (!existsSync(WF)) {
  err(`${WF}를 찾지 못했습니다`);
} else {
  const src = readFileSync(WF, 'utf8');
  if (!src.includes('scripts/autotrade-tick-verdict.mjs')) {
    err(`${WF}가 판정기를 부르지 않습니다 — HTTP 코드만 보면 200 + ok:false가 초록이 됩니다`);
  }
  if (!/actions\/checkout/.test(src)) {
    err(`${WF}에 checkout이 없습니다 — 판정기 파일을 가져올 수 없습니다`);
  }
  // 예전 판정(코드만 보는 조기 종료)이 남아 판정기를 가리지 않는가.
  if (/if \[ "\$code" != "200" \]; then\s*\n\s*echo[^\n]*\n\s*exit 1/.test(src)) {
    err(`${WF}에 "200이 아니면 실패"만 보는 옛 분기가 남아 있습니다 — `
      + '판정기가 그 뒤에 있으면 200 + ok:false를 여전히 놓칩니다');
  }
}

if (bad === 0) {
  console.log('✅ autotrade-tick 응답 계약 — 정상 관망 성공 · 200+ok:false 실패 · '
    + '개별 예약 실패 차단 · 비정상 JSON/DB 오류/HTTP 실패 차단 · 워크플로 배선됨');
} else {
  console.error('');
  console.error('   이 호출은 15분마다 돕니다. 초록으로 보이는 실패는 아무도 못 봅니다.');
  process.exit(1);
}
