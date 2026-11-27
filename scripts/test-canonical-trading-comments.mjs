// scripts/test-canonical-trading-comments.mjs
//
// **거래 정본 계약 관문이 "적혀 있는 것"에 속지 않는가.**
//
// `check-canonical-trading.mjs` 의 `code()` 는 블록 주석은 줄 안에서도
// 뗐지만 **`//` 는 줄 안에서 떼지 않았다.** 머리말이 그 이유를 적어
// 두었다 — `https://` 가 같이 잘린다. 우려는 맞지만, 그 대가로 꼬리
// 주석 한 줄에 계약이 뚫렸다. 기계 탐침으로 실제로 돌려 확인했다:
//
//     const detailTarget = useMemo(() => xTargetOf( // detailTargetOf(
//       detailAsset), [detailAsset]);
//
// 실제 호출은 `xTargetOf` 로 바뀌었는데 §가 요구하는 `detailTargetOf(` 가
// 주석에 남아 있어 통과했다(TS 구문 유효). 이름만 바꾸면 rc=1 이므로
// 앵커는 필요한 것이 맞았고, 보는 눈이 주석을 못 걸러낸 것이다.
//
// 고친 뒤에도 **URL 은 잘리지 않아야 한다** — 그 대조를 같이 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripJsComments } from './lib/strip-comments.mjs';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-canonical-trading.mjs');
const PAGE = 'src/app/page.tsx';
const CALL = 'detailTargetOf(';
const PREFIX = 'ct-cmt-';

/** 이 시험이 만든 임시 폴더 (다른 접두사·다른 시험은 세지 않는다) */
function ownTempDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));
}

/**
 * 검사기를 **격리된 작업 폴더**에서 돌린다. `src` 만 복사하고 나머지는
 * 심링크한다. **`finally` 로 반드시 치운다**(검수 지적 #799) — 치우지
 * 않으면 한 번 돌 때마다 `src` 사본이 남고 쓰기 공간이 고정 할당이라
 * 다음 작업이 디스크로 막힌다.
 */
function runChecker(mutate) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  try {
    for (const e of readdirSync(REPO)) {
      // `node_modules` 도 심링크한다 — 이 검사기는 TypeScript 로 실제
      // 컴파일을 하므로(`:276` 이 없으면 던진다) 빼면 원문 대조가 깨진다.
      // 처음에 빼 놓고 돌렸다가 그 대조가 실패해서 알았다.
      if (e === 'src' || e === '.git') continue;
      symlinkSync(join(REPO, e), join(dir, e));
    }
    cpSync(join(REPO, 'src'), join(dir, 'src'), { recursive: true });
    if (mutate) mutate((rel) => join(dir, rel));
    const r = spawnSync('node', [CHECKER], { cwd: dir, encoding: 'utf8' });
    return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function edit(path, fn) {
  const s = readFileSync(path, 'utf8');
  const out = fn(s);
  assert.notEqual(out, s, '바꿀 자리를 못 찾았습니다 — 못 찾은 것을 통과로 적지 않습니다');
  writeFileSync(path, out);
}

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  assert.equal(runChecker(null).rc, 0);
});

test('대조 — 호출 이름을 바꾸면 막는다 (앵커가 필요하긴 한가)', () => {
  const r = runChecker((p) => edit(p(PAGE), (s) => s.replace(CALL, 'xTargetOf(')));
  assert.notEqual(r.rc, 0, '정본 호출을 다른 이름으로 바꿨는데 통과했습니다');
});

test('★ 이름을 바꾸고 원래 이름을 꼬리 주석에 남기면 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(PAGE), (s) =>
    s.replace(CALL, `xTargetOf( // ${CALL}\n    `)));
  assert.notEqual(r.rc, 0, '꼬리 주석이 살아 있는 호출로 셌습니다');
  console.log('    거부 확인 · 이름을 바꾸고 원래 이름을 꼬리 주석에');
});

test('대조 — 문자열·템플릿 안의 URL 은 잘리지 않는다 (머리말의 그 우려)', () => {
  // 떼지 않던 이유가 이것이었다. 공용 제거기는 인용부호를 알고 걷는다.
  for (const src of [
    "const u = 'https://fapi.binance.com/fapi/v1/ticker/price';",
    'const u = `https://api.binance.com/api/v3/ticker/price?symbol=${s}`;',
    "const r = /a\\/\\/b/; const y = 'ticker/price';",
  ]) {
    assert.equal(stripJsComments(src), src, `URL·정규식이 잘렸습니다: ${src}`);
  }
  // 그러면서 꼬리 주석은 떼고, 나눗셈은 주석으로 오인하지 않는다
  assert.equal(stripJsComments('const x = 1; // detailTargetOf('), 'const x = 1; ');
  assert.equal(stripJsComments('const z = a / b; // x'), 'const z = a / b; ');
});

test('대조 — 블록 주석을 떼는 기존 동작은 그대로다', () => {
  // 머리말이 적어 둔 사고: `onPickPrice={() => { /* 지정가를 받지 않는다 */ }}`
  // 가 "지정가 UI가 있다"로 잡힌 적이 있다. 그 처리는 유지돼야 한다.
  assert.equal(stripJsComments('a(/* 지정가 */); b();').includes('지정가'), false);
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = new Set(ownTempDirs());
  runChecker(null);
  assert.deepEqual(ownTempDirs().filter((n) => !before.has(n)), []);
});
