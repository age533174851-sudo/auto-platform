// scripts/check-undefined.test.mjs
//
// `scripts/check-undefined.mjs`의 판정을 고정한다.
//
// 이 검사기는 `ci.yml`의 명시 목록에 **없다** — 저장소의 어느 워크플로도
// 부르지 않는다. 그래서 판정만이라도 `npm test`로 돌게 여기 둔다
// (`scripts/run-tests.mjs`에 등록돼 있다).
//
// 무엇을 고정하나
// ───────────────
// 고치기 전 이 검사기는 tsc를 `|| true`로 불러 **종료코드를 버렸고**,
// 검사가 돌지 않은 경우에도 "✅ 런타임 미정의 식별자 없음"으로 끝났다.
// 실측 RED(2026-11-10, main `220f8001`): 끝나지 않은 정규식 리터럴 하나로
// tsc 진단이 **73건 → 1건**으로 줄고 TS2304가 출력에서 사라졌는데,
// 같은 트리에 실제 미정의 호출이 있었고 원본 검사기는 **exit 0**이었다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  judge, collectHits, isTypeOnly, selfCheck, SYNTAX_ALLOW,
} from './check-undefined.mjs';

const DIAG = "src/a.ts(3,10): error TS2304: Cannot find name 'nope'.";

test('검사가 돌지 않은 모양을 통과시키지 않는다', () => {
  const blocked = [
    ['tsconfig 없음', { code: 0, out: '', hasTsconfig: false }],
    ['사용법 배너', { code: 1, out: 'Version 5.9.3\n\nCOMMON COMMANDS\n', hasTsconfig: true }],
    ['배너 다른 줄', { code: 1, out: 'tsc: The TypeScript Compiler - Version 5.9.3\n', hasTsconfig: true }],
    ['설정 오류 TS5058', { code: 1, out: "error TS5058: The specified path does not exist: 'nope.json'.", hasTsconfig: true }],
    ['설정 오류 TS6059', { code: 1, out: "error TS6059: File is not under 'rootDir'.", hasTsconfig: true }],
    ['진단 없는 비정상 종료', { code: 2, out: '', hasTsconfig: true }],
  ];
  for (const [name, input] of blocked) {
    const v = judge(input);
    assert.equal(v.ok, false, `${name} 을(를) 통과시켰다`);
    assert.ok(v.reason && v.reason.length > 0, `${name} 에 이유가 없다`);
  }
});

test('파싱이 중단되면 — 개수와 무관하게 — 통과시키지 않는다', () => {
  // 실측 RED와 같은 모양. 진단이 73건에서 1건으로 줄고 TS2304가 사라진다.
  const v = judge({
    code: 2,
    out: 'src/lib/x.ts(1,20): error TS1161: Unterminated regular expression literal.',
    hasTsconfig: true,
  });
  assert.equal(v.ok, false, '파싱 중단을 통과시켰다 — 뒤쪽 파일의 TS2304는 나오지 않는다');
  assert.match(v.reason, /TS1161/);
});

test('정상 출력은 통과시킨다 — 전부 막는 검사기도 쓸모가 없다', () => {
  assert.equal(judge({ code: 0, out: '', hasTsconfig: true }).ok, true, '에러 0건을 막았다');
  const real = judge({
    code: 1,
    out: `${DIAG}\nsrc/c.ts(9,9): error TS1117: Duplicate property.`,
    hasTsconfig: true,
  });
  assert.equal(real.ok, true, `기준선에 상주하는 TS1117을 막았다: ${real.reason}`);
});

test('종료코드 값 자체로는 판정하지 않는다 — 같은 트리에서 1과 2가 다 나왔다', () => {
  for (const code of [0, 1, 2]) {
    assert.equal(
      judge({ code, out: DIAG, hasTsconfig: true }).ok, true,
      `진단이 있는데 종료코드 ${code} 때문에 막았다 — 깜빡이는 검사기가 된다`,
    );
  }
});

test('값 위치만 센다 — 타입 위치는 컴파일 시 소거된다', () => {
  assert.equal(collectHits(DIAG, () => 'return nope(1);').length, 1, '값 위치를 놓쳤다');
  for (const src of ['const x: nope = y;', 'useState<nope>()', 'y as nope', 'interface nope {}', 'const a: nope[] = [];']) {
    assert.equal(collectHits(DIAG, () => src).length, 0, `타입 위치를 값으로 셌다: ${src}`);
  }
  assert.equal(isTypeOnly('nope', 'return nope(1);'), false);
  assert.equal(isTypeOnly('nope', 'let v: nope;'), true);
});

test('읽을 수 없는 줄은 버리지 않고 건너뛴다 — 없는 것으로 적지 않는다', () => {
  const hits = collectHits(DIAG, () => { throw new Error('ENOENT'); });
  assert.equal(hits.length, 0, '파일을 못 읽었는데 위험으로 적었다');
});

test('허용 문법 코드가 ci.yml과 같다 — 다르면 한쪽만 막는다', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const m = ci.match(/SYNTAX_ALLOW='([^']+)'/);
  assert.ok(m, "ci.yml에서 SYNTAX_ALLOW를 찾지 못했다 — 이름이 바뀌었으면 이 시험도 같이 고쳐야 한다");
  const fromCi = new Set(m[1].split('|'));
  assert.deepEqual(
    [...SYNTAX_ALLOW].sort(), [...fromCi].sort(),
    '검사기와 ci.yml의 허용 목록이 갈렸다 — 같은 판단이 두 곳에 있으면 언젠가 갈린다',
  );
});

test('검사기의 자기 점검이 통과한다', () => {
  const r = selfCheck();
  assert.equal(r.ok, true, `자기 점검 실패: ${r.reason}`);
});

// ── 주석이 면제를 위조하지 못한다 ──
//
// 이 검사기의 유일한 면제는 "그 이름이 **타입 위치**에 있다"다. 그 판정이
// 원문 줄을 보고 있었다 — 그래서 주석 한 줄로 면제를 만들 수 있었다.
//
// 실측(main `ed00c1a4`, 실제 경로로 tsc까지 돌려서):
//
//   src/lib/__probe_undef.ts 에 미정의 호출을 값 위치로 심고
//     주석 없이         → 🔴 런타임 크래시 위험 1건            rc=1
//     `// : NAME 로 …`  → ✅ 런타임 미정의 식별자 없음          rc=0
//                         (`진단 53건을 실제로 읽었습니다`라고 적고서)
//
// TS2304를 **읽고 나서 버렸다.** 이 검사기가 막는 것이 런타임 크래시이고,
// 그 크래시가 보고되지 않은 채 초록이 된 것이다.
test('★ 주석이 타입 위치를 가장해도 값 위치는 보고한다', () => {
  const forged = [
    ['줄 주석 · 타입 어노테이션', 'return nope(1);  // : nope 로 바꿀 예정'],
    ['블록 주석 · 제네릭',        'return nope(1);  /* <nope> 였다 */'],
    ['줄 주석 · 배열 타입',       'nope();  // nope[] 로 바꾼다'],
    ['줄 주석 · interface',      'nope();  // interface nope 를 지웠다'],
    ['줄 주석 · union',          'nope();  // nope | null 이었다'],
    // 블록 주석이 **닫힌 뒤의 코드**. 줄머리만 보고 버리는 필터는 이 줄을
    // 통째로 날려 눈이 멀고, 그러면 크래시가 조용히 지나간다.
    ['닫는 줄 뒤의 코드',        '*/ nope();  // : nope'],
  ];
  for (const [what, src] of forged) {
    assert.equal(
      collectHits(DIAG, () => src).length, 1,
      `주석이 면제를 위조했다 (${what}) — 런타임 크래시가 보고되지 않는다: ${src}`,
    );
    assert.equal(isTypeOnly('nope', src), false, `${what}: 주석을 타입 문맥으로 읽었다`);
  }
});

test('대조 — 주석을 지우는 대가가 없다', () => {
  // 진짜 타입 위치는 그대로 면제된다. 전부 보고하는 검사기도 쓸모가 없다.
  for (const src of ['const x: nope = y;', 'let v: nope;  // 설명', 'useState<nope>()  /* 설명 */']) {
    assert.equal(collectHits(DIAG, () => src).length, 0, `타입 위치를 값으로 셌다: ${src}`);
  }
  // 무해한 주석이 보고를 막지 않는다 (고치기 전에도 막지 않았다 — 대조군)
  assert.equal(collectHits(DIAG, () => 'return nope(1);  // 이름을 바꿨다').length, 1);
  // **문자열 안의 `//`를 주석으로 읽지 않는다.** 읽으면 뒤의 진짜 타입
  // 문맥이 잘려 나가 과검출이 된다 — `https://`는 이 저장소에 흔하다.
  assert.equal(
    collectHits(DIAG, () => "f('https://x'); const y: nope = z;").length, 0,
    'URL 의 `//` 를 주석 시작으로 읽어 뒤의 타입 문맥을 잘라 먹었다',
  );
});

// ── 아직 닫히지 않은 두 방향 ──
//
// 여기 적힌 기대값은 **지금 그렇다**는 기록이고, 옳다는 뜻이 아니다.
// 닫을 수 없는 것을 닫았다고 적지 않는다. 이 시험이 깨지면 그 방향이
// 닫힌 것이니 기대값을 1로 올리고 아래 설명을 지워라.
test('남은 방향 — 줄 하나만 보기 때문에 모르는 것 (기록)', () => {
  // ① 블록 주석의 **마지막 줄**에 타입 문맥이 있고 그 뒤에 코드가 오는 모양.
  //    줄 하나만으로는 그 `: nope`가 주석 안이라는 것을 알 수 없다.
  //    닫는 법: 개행을 보존하는 제거기로 **파일 전체**를 지운다(#795).
  //    지금 공용 제거기는 블록 주석의 개행을 지워서, 파일 전체를 지우면
  //    줄 번호가 밀려 **다른 줄**을 보고 판정한다. 그게 더 나쁘다.
  assert.equal(collectHits(DIAG, () => '   설명 : nope */ nope();').length, 0);
  // ② 문자열 리터럴이 타입 문맥을 대신한다. 제거기는 문자열을 **일부러**
  //    남긴다(URL 때문에). 이 방향은 공용 AST 존재 판정으로만 닫힌다.
  assert.equal(collectHits(DIAG, () => "f('a: nope'); nope();").length, 0);
});
