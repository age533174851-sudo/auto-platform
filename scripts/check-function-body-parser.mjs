#!/usr/bin/env node
// scripts/check-function-body-parser.mjs
//
// **검사기가 함수 본문을 정확히 읽는지 검사한다.**
//
// 검사기가 틀린 곳을 보고 있으면 그 검사기는 초록을 켤 뿐 아무것도 지키지
// 않는다. 예전 `fnBodyAt()`이 그랬다 — 반환 타입이 직접 객체면 타입 블록을
// 본문으로 읽었다. 여기서 그 자리를 닫는다.
//
// 아래 픽스처는 전부 **실제로 겪었거나 겪을 수 있는 모양**이다. 통과하는
// 것만 넣지 않았다: F3은 옛 구현이 실패하던 바로 그 모양이고, F12·F13은
// "못 읽었다"를 조용히 빈 본문으로 넘기지 않는지 본다.
import { functionBody } from './lib/function-body.mjs';

let bad = 0;
const err = (m) => { console.error(`::error::${m}`); bad += 1; };

/** 본문 안에 BODY 표식이 있고, 타입 조각이 섞여 들어오지 않아야 한다 */
function wantBody(label, src, name, mustHave = 'BODY', mustNotHave = null) {
  const r = functionBody(src, name);
  if (!r.ok) { err(`${label}: 본문을 읽지 못했습니다 — ${r.reason}`); return; }
  if (!r.body.includes(mustHave)) {
    err(`${label}: 본문에 ${mustHave}가 없습니다 — 읽은 것: ${JSON.stringify(r.body.slice(0, 70))}`);
    return;
  }
  if (mustNotHave && r.body.includes(mustNotHave)) {
    err(`${label}: 본문에 ${mustNotHave}가 섞였습니다 — 타입을 본문으로 읽었을 수 있습니다`);
    return;
  }
  console.log(`  ✓ ${label}`);
}

function wantFailure(label, src, name) {
  const r = functionBody(src, name);
  if (r.ok) {
    err(`${label}: 실패해야 하는데 본문을 돌려줬습니다 — ${JSON.stringify(r.body.slice(0, 70))}`);
    return;
  }
  console.log(`  ✓ ${label} (${r.reason})`);
}

console.log('함수 본문 파서:');

// F1 단순 반환 타입
wantBody('F1 단순 반환 타입', 'function f(): number {\n  const BODY = 1;\n}', 'f');

// F2 매개변수가 inline object
wantBody('F2 inline object 매개변수',
  'function f(i: { a: number; b?: { c: string } }): number {\n  const BODY = 1;\n}', 'f', 'BODY', 'c: string');

// F3 **이번에 고친 구멍** — 반환 타입이 직접 객체
wantBody('F3 직접 inline object 반환 타입',
  'function f(): {\n  ok: boolean;\n  nested: { n: number };\n} {\n  const BODY = 1;\n}', 'f', 'BODY', 'ok: boolean');

// F4 Promise<{…}>
wantBody('F4 Promise inline object',
  'async function f(): Promise<{ ok: boolean }> {\n  const BODY = 1;\n}', 'f', 'BODY', 'ok: boolean');

// F5 유니온 객체 반환
wantBody('F5 유니온 객체 반환',
  'function f(): { a: 1 } | { b: 2 } {\n  const BODY = 1;\n}', 'f', 'BODY', 'b: 2');

// F6 교차 타입 + 중첩 제네릭
wantBody('F6 교차 타입·중첩 제네릭',
  'function f(): Promise<Map<string, { a: 1 }> & { b: 2 }> {\n  const BODY = 1;\n}', 'f', 'BODY', 'b: 2');

// F7 본문 안 중첩 객체 — 본문 전체가 와야 한다
{
  const src = 'function f() {\n  const x = { a: { b: 1 } };\n  return x;\n}';
  const r = functionBody(src, 'f');
  if (!r.ok) err(`F7: ${r.reason}`);
  else if (!r.body.includes('return x')) err('F7: 본문이 중첩 객체에서 잘렸습니다');
  else console.log('  ✓ F7 본문 안 중첩 객체');
}

// F8 문자열·템플릿 안의 중괄호
{
  const src = 'function f() {\n  const a = "{ not a body }";\n  const b = `value ${ { x: 1 }.x }`;\n  const BODY = 1;\n}';
  const r = functionBody(src, 'f');
  if (!r.ok) err(`F8: ${r.reason}`);
  else if (!r.body.includes('BODY')) err('F8: 문자열 속 중괄호에서 본문이 잘렸습니다');
  else console.log('  ✓ F8 문자열·템플릿 속 중괄호');
}

// F9 주석 속 가짜 선언
wantBody('F9 주석 속 가짜 선언',
  '// function f(): { fake: true } {}\nfunction f() {\n  const BODY = 1;\n}', 'f', 'BODY', 'fake');

// F10 문자열 속 가짜 선언
wantBody('F10 문자열 속 가짜 선언',
  'const s = "function f() { FAKE }";\nfunction f() {\n  const BODY = 1;\n}', 'f', 'BODY', 'FAKE');

// F11 오버로드 — 본문 있는 구현을 고른다
wantBody('F11 오버로드',
  'function f(x: string): string;\nfunction f(x: number): number;\nfunction f(x: string | number) {\n  const BODY = 1;\n  return x;\n}', 'f');

// F12 없는 함수 — 빈 본문을 조용히 성공으로 넘기지 않는다
wantFailure('F12 없는 함수', 'function g() { const BODY = 1; }', 'f');

// F13 문법이 깨진 소스 — fail-closed
wantFailure('F13 문법 깨진 소스', 'function f(: { const BODY = 1;', 'f');

// F14 export async
wantBody('F14 export async',
  'export async function f(): Promise<void> {\n  const BODY = 1;\n}', 'f');

// F15 본문 있는 구현이 둘 — 어느 것인지 정하지 않는다
wantFailure('F15 같은 이름 구현 둘',
  'function f() { const A = 1; }\nfunction f() { const B = 2; }', 'f');

if (bad) {
  console.error(`\n함수 본문 파서 계약 위반 ${bad}건.`);
  process.exit(1);
}
console.log('함수 본문 파서 확인 완료 — 반환 타입을 본문으로 읽지 않습니다');
