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
