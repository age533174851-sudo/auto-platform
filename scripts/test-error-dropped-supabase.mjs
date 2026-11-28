// scripts/test-error-dropped-supabase.mjs
//
// **문자열 안의 주석 기호로 개수 관문을 내릴 수 없다.**
//
// `node --test scripts/test-*.mjs` (ci.yml의 글롭)에 자동으로 걸린다.
//
// 무엇이 실제로 이랬나 (기준 main ed00c1a4, 저장소 전수로 돌려서 얻은 값)
// ─────────────────────────────────────────────────────────────────
// `check-db-columns`는 `error`를 받지 않은 Supabase 호출을 **세서 기준보다
// 늘면 실패**시킨다(기준 178, 현재 177). 세는 판정은
// `scripts/lib/error-dropped-supabase.mjs` 한 곳에 있다.
//
// 그 판정이 주석을 정규식으로 걷으면서 **문자열을 몰랐다.** 그래서 완전히
// 정상적인 한 줄이 개수를 내렸다. 자리 앞에 `const probeTag = '/*';` 를
// 넣어 전체 1403개 파일을 다시 센 값:
//
//   자리가 있는 파일 72개 중 **개수가 내려간 파일 39개**
//     src/app/api/autotrade/mode/route.ts           3 → 0
//     src/app/api/autotrade/daily-ladder/route.ts   1 → 0
//     src/app/api/autotrade/schedule/route.ts      10 → 9
//
// `'/*'` 가 블록 주석을 열어 **다음 `*/` 까지를 통째로 지웠다.**
//
// 왜 이것이 치명적인가
// ────────────────────
// 개수 기준 관문에서는 **적게 세는 쪽**이 위험하다. 아무것도 고치지 않고
// 기준선을 내릴 수 있고, 그 사이에 들어온 새 자리까지 가려진다. 이 판정이
// 막으려고 만들어진 것이 바로 "사람이 우연히 발견하기 전에 조용히 들어오는
// 네 번째"다.
//
// 고친 뒤 같은 측정: **39 → 0**, 전수 개수는 177 그대로(기준선 178 유지).
//
// 어느 경우가 기준 main 에서 실제로 어긋났나 (정확히 적는다)
// ──────────────────────────────────────────────────────
// 기준 main 헬퍼에 아래 경계들을 직접 걸어 보면 **어긋난 것은 하나다**:
//
//   ✗ `'/*'` 뒤에 자리들이 있고 그 뒤에 **진짜 `*/`** 가 있다  1개 (3이어야 한다)
//
// 두 줄짜리 조각(`'/*'` + 자리 하나)은 main 에서도 1을 낸다 — 그 조각에는
// 뒤따르는 `*/` 가 없어 정규식 `\/\*[\s\S]*?\*\/` 가 아예 맞지 않기
// 때문이다. 즉 **가짜 `/*` 가 뒤의 진짜 `*/` 와 짝지어질 때만** 삼킨다.
//
// 그래서 아래 두 줄짜리 경우들은 **구멍이 아니라 경계 고정**이다 — 다르게
// 고치면 깨지도록 두었다. 실제 RED 는 위 한 줄과 저장소 전수 39개다.
// (저장소 파일은 거의 모두 JSDoc 을 쓰므로 뒤에 `*/` 가 있다. 그래서
//  합성 조각에서는 안 보이고 실제 파일에서는 39개가 나왔다.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  errorDroppedSites, selfTest, stripCommentsKeepingLength,
} from './lib/error-dropped-supabase.mjs';

const n = (src) => errorDroppedSites(src).length;
const lines = (src) => errorDroppedSites(src).map((x) => x.line);

const READ = "const { data } = await sb.from('t').select('*');";
const WRITE = "await sb.from('t').insert({ a: 1 });";

// ── 판정 자기 점검이 통과하는가 ──────────────────────────────────
test('정본의 자기 점검이 전부 통과한다', () => {
  const r = selfTest();
  assert.deepEqual(r.failed, [], `세는 규칙이 틀리면 기준선이 거짓이 된다: ${r.failed.join(' | ')}`);
  assert.ok(r.total >= 24, `자기 점검이 ${r.total}개로 줄었다`);
});

// ── ★ 문자열 안의 주석 기호가 뒤의 자리를 지우지 않는다 ──────────
for (const [how, line] of [
  ["문자열 '/*'", "const s = '/*';"],
  ['템플릿 `/*`', 'const s = `/*`;'],
  ['문자열 "/*"', 'const s = "/*";'],
  ["문자열 '//'", "const s = '//';"],
  ["URL 'https://x'", "const u = 'https://x';"],
  ["문자열 '/* … */'", "const s = '/* 설명 */';"],
]) {
  test(`경계 — ${how} 가 뒤의 읽기 자리를 지우지 않는다`, () => {
    assert.equal(n(`${line}\n${READ}`), 1, `${how} 로 개수를 내릴 수 있으면 기준선이 거짓이 된다`);
  });

  test(`경계 — ${how} 가 뒤의 쓰기 자리를 지우지 않는다`, () => {
    assert.equal(n(`${line}\n${WRITE}`), 1, `${how} 로 개수를 내릴 수 있으면 기준선이 거짓이 된다`);
  });
}

test('경계 — 같은 줄에 있어도 지우지 않는다', () => {
  assert.equal(n(`const s = '/*'; ${READ}`), 1);
  assert.equal(n(`const u = 'a//b'; ${READ}`), 1);
});

test('★ 가짜 /* 가 뒤의 진짜 */ 와 짝지어 여러 자리를 삼키지 않는다', () => {
  // **기준 main 에서 실제로 어긋난 경우다.** `'/*'` 뒤에 진짜 `*/` 가
  // 있으면 그 사이 전부가 지워졌다 — main 헬퍼는 3개가 아니라 1개를 셌다.
  // 저장소 파일은 거의 모두 JSDoc 을 쓰므로 그 `*/` 가 늘 뒤에 있다.
  const src = `const s = '/*';\n${READ}\n${WRITE}\n/* 진짜 주석 */\n${READ}`;
  assert.equal(n(src), 3, '가짜 /* 와 진짜 */ 사이의 자리들이 한꺼번에 사라졌다');
});

test('경계 — 이스케이프된 따옴표에서 문자열이 일찍 닫히지 않는다', () => {
  assert.equal(n(`const s = 'a\\'/*b'; ${READ}`), 1);
});

// ── 대조 — 진짜 주석은 그대로 지운다 ────────────────────────────
test('대조 — 진짜 줄 주석의 코드는 세지 않는다', () => {
  assert.equal(n(`// ${READ}`), 0);
  assert.equal(n(`const s = 'ok'; // ${READ}`), 0);
});

test('대조 — 진짜 블록 주석의 코드는 세지 않는다', () => {
  assert.equal(n(`/* ${READ} */`), 0);
  assert.equal(n(`const s = 'ok'; /* ${READ} */`), 0);
  assert.equal(n(`/**\n * ${READ}\n */`), 0);
});

test('대조 — error 를 받으면 세지 않는다', () => {
  assert.equal(n("const { data, error } = await sb.from('t').select('*');"), 0);
  assert.equal(n("const { error } = await sb.from('t').insert({ a: 1 });"), 0);
});

test('대조 — auth 류는 세지 않는다', () => {
  assert.equal(n('const { data } = await sb.auth.getSession();'), 0);
});

// ── 줄번호는 원문과 같다 ───────────────────────────────────────
test('경계 — 문자열을 보존해도 줄번호가 밀리지 않는다', () => {
  assert.deepEqual(lines(`const s = '/*';\n${READ}`), [2]);
  assert.deepEqual(lines(`/**\n * 설명\n * 두 줄\n */\n${READ}`), [5]);
  assert.deepEqual(lines(`// 설명\n// 두 줄\n${WRITE}`), [3]);
});

test('경계 — 블록 주석이 긴 파일에서도 줄번호가 맞는다', () => {
  // 실측(2026-11-24)으로 고친 고장 — 줄바꿈을 지우면 뒤가 전부 밀린다.
  const doc = '/**\n * 1\n * 2\n * 3\n * 4\n * 5\n */';
  assert.deepEqual(lines(`${doc}\n${READ}`), [8]);
  assert.deepEqual(lines(`${doc}\n${doc}\n${READ}`), [15]);
});

// ── 제거기 자체 ────────────────────────────────────────────────
test('stripCommentsKeepingLength — 길이와 줄을 유지한다', () => {
  for (const src of [
    `const s = '/*';\n${READ}`,
    `/* a */ ${READ}`,
    `// a\n${READ}`,
    '/**\n * a\n */\nx;',
    "const u = 'https://x'; // c",
  ]) {
    const out = stripCommentsKeepingLength(src);
    assert.equal(out.length, src.length, `길이가 달라졌다: ${JSON.stringify(src)}`);
    assert.equal(out.split('\n').length, src.split('\n').length, '줄 수가 달라졌다');
  }
});

test('stripCommentsKeepingLength — 문자열은 그대로, 주석은 공백', () => {
  assert.equal(stripCommentsKeepingLength("const s = '/*';"), "const s = '/*';");
  assert.equal(stripCommentsKeepingLength("const u = 'https://x';"), "const u = 'https://x';");
  assert.equal(stripCommentsKeepingLength('a // b'), 'a     ');
  assert.equal(stripCommentsKeepingLength('a /* b */ c'), 'a         c');
});

test('stripCommentsKeepingLength — 빈 입력과 닫히지 않은 주석', () => {
  assert.equal(stripCommentsKeepingLength(''), '');
  // 닫히지 않은 블록 주석은 끝까지 주석이다 (코드를 되살리지 않는다)
  const out = stripCommentsKeepingLength('/* a\nb');
  assert.equal(out.length, 4 + 1 + 1);
  assert.equal(out.split('\n').length, 2);
});
