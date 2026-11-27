// scripts/test-hold-extension-comments.mjs
//
// **보유 연장 관문의 금지 앵커가 URL 한 개로 눈을 감았다.**
//
// `check-hold-extension.mjs` 의 `code()` 는 줄마다 이렇게 걷었다:
//
//     .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
//
// 인용부호를 모르므로 **문자열 안의 `//` 에서도 자른다.** URL 한 개가 그
// 줄의 나머지를 먹는다. 기계 탐침으로 실제로 돌려 확인했다(TS 구문 유효):
//
//     const _u = 'https://x/y'; const _x = () => resolveHoldExtensionPolicy({});
//
//   금지 호출을 평범하게 넣으면              rc=1  ← 금지 앵커는 동작한다
//   `//` 없는 문자열을 앞에 두면              rc=1  ← 원인이 `//` 라는 대조
//   위처럼 URL 을 앞에 두면                   rc=0  ← 구멍
//
// 그 금지가 지키는 것은 ④ 배선이다 — `resolveHoldExtensionPolicy` 를 직접
// 부르면 *"승인·소급 금지 관문을 지나지 않는다"*. 즉 **승인 없이 켜지는
// 경로**가 URL 한 개 뒤에 숨을 수 있었다.
//
// 방향이 나쁘다. 지금까지 이 저장소에서 쓸어온 대부분은 "요구 앵커가 주석
// 으로 만족"(조용히 열림)이었는데, 이것은 **코드를 먹어 금지가 눈을 감는**
// 쪽이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripJsComments } from './lib/strip-comments.mjs';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-hold-extension.mjs');
const RUN = 'src/lib/engine/exitAuthorityRun.ts';
const PREFIX = 'hx-cmt-';

/** 이 시험이 만든 임시 폴더만 센다 */
function ownTempDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));
}

/**
 * 검사기를 격리된 작업 폴더에서 돌린다. `src` 만 복사하고 나머지는
 * 심링크한다 — 이 검사기는 TypeScript 로 **실제 컴파일**도 하므로
 * `node_modules` 가 보여야 한다.
 * **`finally` 로 반드시 치운다**: 쓰기 공간이 고정 할당이라 남기면 다음
 * 작업이 디스크로 막힌다.
 */
function runChecker(mutate) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  try {
    for (const e of readdirSync(REPO)) {
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

/** 파일 맨 앞(첫 줄 뒤)에 한 줄 끼워 넣는다 */
function inject(path, line) {
  const s = readFileSync(path, 'utf8');
  const i = s.indexOf('\n');
  writeFileSync(path, `${s.slice(0, i + 1)}${line}\n${s.slice(i + 1)}`);
}

const BAD = 'const _x = () => resolveHoldExtensionPolicy({});';

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  assert.equal(runChecker(null).rc, 0);
});

test('대조 — 금지 호출을 평범하게 넣으면 막는다 (금지 앵커가 동작하는가)', () => {
  const r = runChecker((p) => inject(p(RUN), BAD));
  assert.notEqual(r.rc, 0, '관문을 우회하는 직접 호출이 통과했습니다');
});

test('★ 같은 줄 앞에 URL 문자열이 있어도 금지 호출을 본다', () => {
  const r = runChecker((p) => inject(p(RUN), `const _u = 'https://x/y'; ${BAD}`));
  assert.notEqual(r.rc, 0, 'URL 한 개가 금지 앵커를 먹었습니다');
  console.log('    거부 확인 · URL 뒤의 resolveHoldExtensionPolicy');
});

test('대조 — `//` 없는 문자열이면 원래도 막았다 (원인이 `//` 라는 대조)', () => {
  const r = runChecker((p) => inject(p(RUN), `const _u = 'plain'; ${BAD}`));
  assert.notEqual(r.rc, 0);
});

test('대조 — 공용 제거기가 URL·정규식·나눗셈을 먹지 않는다', () => {
  for (const src of [
    "const u = 'https://x/y'; const z = 1;",
    'const u = `https://a/${b}`;',
    "const r = /a\\/\\/b/; const y = 'q';",
    'const z = a / b;',
  ]) {
    assert.equal(stripJsComments(src), src, `코드를 먹었습니다: ${src}`);
  }
  // 그러면서 진짜 주석은 뗀다
  assert.equal(stripJsComments('const x = 1; // resolveHoldExtensionPolicy('), 'const x = 1; ');
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = new Set(ownTempDirs());
  runChecker(null);
  assert.deepEqual(ownTempDirs().filter((n) => !before.has(n)), []);
});
