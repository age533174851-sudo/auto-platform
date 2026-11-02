// `assert-tap-ran.mjs`가 **돌지 않은 시험을 통과로 읽지 않는지** 본다.
//
// Node의 시험 러너는 전부 건너뛴 묶음에도 종료 코드 0을 준다. 그래서
// `node --test`의 종료 코드만 보면 "PG 시험 초록"이 "PG 시험 안 돌았음"과
// 구분되지 않는다 — 이 저장소가 가장 싫어하는 모양(UNKNOWN을 통과로 적기)이다.
//
// #544의 워크플로는 그것을 `grep -Eq` 다섯 줄로 막았다. 그런데 PG 묶음이
// 둘이 되면 그 다섯 줄을 복사해야 하고, 그 순간 **경로가 둘**이 된다.
// 그래서 판정을 한 파일로 옮기고 여기서 시험한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictOf } from './assert-tap-ran.mjs';

/** 실제로 돈 묶음의 TAP 꼬리 */
const RAN = `1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4009`;

/** **전부 건너뛴** 묶음의 TAP 꼬리 — `node --test`는 여기도 0을 준다 */
const SKIPPED = `1..1
# tests 1
# suites 0
# pass 0
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 224`;

test('실제로 돈 묶음은 통과다', () => {
  const v = verdictOf(RAN);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.counts.pass, 7);
});

test('★ 전부 건너뛴 묶음은 통과가 아니다 — 종료 코드 0에 속지 않는다', () => {
  const v = verdictOf(SKIPPED);
  assert.equal(v.ok, false);
  assert.match(v.reason, /skipped/);
});

test('★ pass가 0이면 통과가 아니다', () => {
  const v = verdictOf(RAN.replace('# pass 7', '# pass 0'));
  assert.equal(v.ok, false);
  assert.match(v.reason, /pass/);
});

test('★ 실패가 있으면 통과가 아니다', () => {
  const v = verdictOf(RAN.replace('# fail 0', '# fail 2'));
  assert.equal(v.ok, false);
  assert.match(v.reason, /fail/);
});

test('★ 취소가 있으면 통과가 아니다 — 취소는 결과가 아니다', () => {
  const v = verdictOf(RAN.replace('# cancelled 0', '# cancelled 1'));
  assert.equal(v.ok, false);
  assert.match(v.reason, /cancelled/);
});

test('★ tests가 0이면 통과가 아니다', () => {
  const v = verdictOf(RAN.replace('# tests 7', '# tests 0'));
  assert.equal(v.ok, false);
  assert.match(v.reason, /tests/);
});

test('★ 줄이 아예 없으면 통과가 아니다 — 못 읽은 것을 0으로 읽지 않는다', () => {
  for (const missing of ['# tests 7', '# pass 7', '# fail 0', '# skipped 0', '# cancelled 0']) {
    const v = verdictOf(RAN.split('\n').filter(l => l !== missing).join('\n'));
    assert.equal(v.ok, false, `${missing}이 없는데 통과로 읽었습니다`);
  }
  assert.equal(verdictOf('').ok, false);
  assert.equal(verdictOf(null).ok, false);
});

test('숫자 뒤에 군더더기가 붙은 줄은 그 줄로 세지 않는다', () => {
  // `# pass 7 (expected)` 같은 변형을 숫자로 읽으면 안 된다.
  const v = verdictOf(RAN.replace('# pass 7', '# pass 7 maybe'));
  assert.equal(v.ok, false);
});
