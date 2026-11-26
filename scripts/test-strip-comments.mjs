// scripts/test-strip-comments.mjs
//
// **주석을 걷는 공용 함수는 17개 검사기가 함께 쓴다.**
//
// 그래서 이 함수가 틀리면 그 17개가 **한꺼번에** 틀린다. 그런데 시험이
// 하나도 없었다. 이번에 두 가지 탈선을 실측해 고치고 그 둘을 못 박는다.
//
// ① 정규식 리터럴을 몰랐다
//
//    `/["']+/g` 를 만나면 안의 `"` 를 문자열 시작으로 읽고 **가짜 문자열
//    상태**에 빠진다. 그 상태에서는 `//` 를 주석으로 보지 않으므로
//    **주석 본문이 코드로 남는다.** `scripts/ops-runner.mjs:50` 이 그랬고,
//    인용 상태가 73·86·175·237·303행으로 이어져 410행부터 끝까지 닫히지
//    않았다. 그 바람에 106행 주석의 `vercelSha: mainSha` 가 코드로 남아,
//    그 문구를 금지하는 `check-deploy-evidence` 가 원문에서 거짓 양성을 냈다.
//
// ② 템플릿 `${ … }` 안이 코드인 것을 몰랐다
//
//    백틱만 세면 `${ … \`중첩\` … }` 에서 짝이 어긋난다.
//    `scripts/claude-exec-category.mjs` 296~327행이 그렇게 이어졌다.
//
// 실측: 걷은 결과에 `//` 줄이 남는 파일이 **1611개 중 127개 → 10개**.
// 남은 10개는 전부 **템플릿 리터럴 안의 `//`**, 즉 데이터다(생성되는 파일의
// 머리글·Pine Script 본문 등). 그건 남아야 맞다.
//
// 방향: 탈선 중에는 글자가 **남으므로** "있어야 한다"를 보는 검사가 주석에
// 적힌 문구로 **통과**한다 — 조용히 열리는 쪽이다. 반대로 나눗셈을 정규식
// 으로 오인하면 **코드를 먹는다.** 그래서 그 구분도 같이 못 박는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripJsComments, stripYamlComments } from './lib/strip-comments.mjs';

test('★ 정규식 리터럴 안의 인용부호에 속지 않는다', () => {
  const src = 'const re = /["\']+/g;\n// MARK\nconst keep = 1;\n';
  const out = stripJsComments(src);
  assert.doesNotMatch(out, /MARK/, '주석이 코드로 남았습니다');
  assert.match(out, /const keep = 1/);
});

test('★ 문자 클래스 안의 / 는 정규식의 끝이 아니다', () => {
  const out = stripJsComments('const re = /[/"]/g;\n// MARK\nconst keep = 1;\n');
  assert.doesNotMatch(out, /MARK/);
  assert.match(out, /const keep = 1/);
});

test('★ 템플릿 ${ } 안은 코드다 — 중첩 백틱에 어긋나지 않는다', () => {
  const out = stripJsComments('const s = `a ${ `b` } c`;\n// MARK\nconst keep = 1;\n');
  assert.doesNotMatch(out, /MARK/);
  assert.match(out, /const keep = 1/);
});

test('★ ${ } 안의 객체 리터럴 중괄호를 세어 템플릿으로 돌아온다', () => {
  const out = stripJsComments('const s = `${ {a: 1}.a } tail`;\n// MARK\nconst keep = 1;\n');
  assert.doesNotMatch(out, /MARK/);
  assert.match(out, /const keep = 1/);
});

test('나눗셈을 정규식으로 오인해 코드를 먹지 않는다 — 좁히는 쪽 대조', () => {
  // 이쪽으로 틀리면 **코드가 사라진다.** 금지 문구를 보는 검사가 조용히
  // 아무것도 못 보게 되므로, 위 ★들보다 이 대조가 더 중요하다.
  const out = stripJsComments('const a = x / y;\nconst b = z / w;\nconst KEEP = 1;\n');
  assert.match(out, /const a = x \/ y/);
  assert.match(out, /const b = z \/ w/);
  assert.match(out, /KEEP/);
});

test('키워드 뒤의 / 는 정규식이다', () => {
  const out = stripJsComments('function f(s){ return /a"b/.test(s); }\n// MARK\n');
  assert.doesNotMatch(out, /MARK/);
  assert.match(out, /return \/a"b\/\.test/);
});

test('템플릿·문자열 안의 // 는 데이터이므로 남는다', () => {
  assert.match(stripJsComments('const s = `x\n// data\n`;\n'), /\/\/ data/);
  assert.match(stripJsComments("const u = 'https://example.com';\n"), /https:\/\/example\.com/);
});

test('평범한 줄 주석·블록 주석·JSX 주석은 걷는다', () => {
  assert.doesNotMatch(stripJsComments('// MARK\nconst x=1;'), /MARK/);
  assert.doesNotMatch(stripJsComments('/* MARK */\nconst x=1;'), /MARK/);
  assert.doesNotMatch(stripJsComments('<div>{/* MARK */}</div>'), /MARK/);
});

test('★ 실제 ops-runner.mjs — 주석 속 금지 문구가 코드로 남지 않는다', () => {
  const raw = readFileSync('scripts/ops-runner.mjs', 'utf8');
  // 그 문구는 원문의 **주석**에 역사로 적혀 있다 (앵커가 바뀌면 이 시험을 고친다)
  assert.match(raw, /예전에는 관측하지 않고/, '앵커가 바뀌었습니다');
  assert.match(raw, /vercelSha: mainSha/);
  const code = stripJsComments(raw);
  assert.doesNotMatch(code, /vercelSha\s*:\s*mainSha/,
    '주석에만 있는 금지 문구가 코드로 남았습니다 — 거짓 양성이 됩니다');
  // 같은 파일의 진짜 코드는 남아 있어야 한다
  assert.match(code, /observedVercelSha\(/);
  assert.match(code, /readVercelSha\(\)/);
});

test('★ 실제 claude-exec-category.mjs — 템플릿 뒤 주석이 코드로 남지 않는다', () => {
  const raw = readFileSync('scripts/claude-exec-category.mjs', 'utf8');
  assert.match(raw, /거부가 있을 때만 적는다/, '앵커가 바뀌었습니다');
  const code = stripJsComments(raw);
  assert.doesNotMatch(code, /거부가 있을 때만 적는다/);
});

test('stripYamlComments 는 인용 안의 # 를 자르지 않는다 (기존 계약)', () => {
  assert.equal(stripYamlComments('run: echo "a # b"').trim(), 'run: echo "a # b"');
  assert.equal(stripYamlComments('key: v  # 이유').trim(), 'key: v');
  assert.equal(stripYamlComments('color: "#fff"').trim(), 'color: "#fff"');
});
