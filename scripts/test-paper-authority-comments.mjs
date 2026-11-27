// scripts/test-paper-authority-comments.mjs
//
// **모의 장부 권위 관문이 "적혀 있는 것"에 속지 않는가.**
//
// `check-paper-authority.mjs` §① 은 옛 로컬 장부(`tg_paper_*`)에 쓰는 호출
// **하나하나**가 바로 앞에서 `isTradableLedger(...)` 를 확인하는지 본다.
// 그 관문이 없으면 "거래 가능한 모의투자"가 서버 장부와 로컬 장부 둘로
// 갈라진다 — `CLAUDE.md` 가 금지하는 "장부를 합산하는" 자리의 입구다.
//
// 그런데 관문 판정이 보는 본문은 `code()` 를 지난 것이었고, `code()` 는
// `//`·`*`·`/*` 로 **시작하는 줄**만 버렸다. 꼬리 주석에 적힌 글자는 코드로
// 셌다. 기계 탐침으로 실제로 돌려 확인한 구멍 — TS 구문이 유효하고 관문은
// 꺼졌는데 검사기가 ✅ 를 적었다:
//
//     if (false) { // if (!isTradableLedger(LEDGER)) {
//
// 먼저 앵커가 필요한지 확인했다: 관문 세 블록을 지우면 rc=1 이다.
// 아래 시험이 그 변형을 박아 둔다. 다시 통과하면 구멍이 다시 열린 것이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-paper-authority.mjs');
const OWNER = 'src/components/pages/PaperTradingPage.tsx';
const GUARD = '    if (!isTradableLedger(LEDGER)) {';
const PREFIX = 'pa-cmt-';

/** 이 시험이 만든 임시 폴더 (다른 접두사·다른 시험은 세지 않는다) */
function ownTempDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));
}

/**
 * 검사기를 **격리된 작업 폴더**에서 돌린다.
 *
 * 이 검사기는 `src/` 전체를 걷는다. 저장소를 통째로 복사하지 않고 `src` 만
 * 실제로 복사하고 나머지는 심링크한다. **`finally` 로 반드시 치운다** —
 * 치우지 않으면 한 번 돌 때마다 `src` 사본이 남고, 이 컨테이너의 쓰기 가능
 * 공간은 고정 할당이라 다음 작업이 디스크로 막힌다(검수 지적 #799).
 */
function runChecker(mutate) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  try {
    for (const e of readdirSync(REPO)) {
      if (e === 'src' || e === '.git' || e === 'node_modules') continue;
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
  const r = runChecker(null);
  assert.equal(r.rc, 0, r.out);
});

test('대조 — 관문 블록을 지우면 막는다 (앵커가 필요하긴 한가)', () => {
  const r = runChecker((p) => edit(p(OWNER), (s) => s.split(GUARD).join('    if (true) {')));
  assert.notEqual(r.rc, 0, '관문을 모두 통과로 바꿨는데 검사기가 통과했습니다');
});

test('★ 관문을 끄고 원문을 꼬리 주석에 남기면 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(OWNER), (s) => s.split(GUARD).join(`    if (false) { // ${GUARD.trim()}`)));
  assert.notEqual(r.rc, 0, '꼬리 주석이 살아 있는 관문으로 셌습니다');
  console.log('    거부 확인 · 관문을 끄고 원문을 꼬리 주석에');
});

test('대조 — 줄머리 주석을 더해도 판정이 흔들리지 않는다', () => {
  const r = runChecker((p) => edit(p(OWNER), (s) =>
    s.replace(GUARD, `    // 설명: isTradableLedger(LEDGER) 로 거래 가능 여부를 본다\n${GUARD}`)));
  assert.equal(r.rc, 0, r.out);
});

test('★ 임시 폴더를 남기지 않는다 — 한 번 돌 때마다 src 사본이 쌓인다', () => {
  const before = new Set(ownTempDirs());
  runChecker(null);
  const leaked = ownTempDirs().filter((n) => !before.has(n));
  assert.deepEqual(leaked, [], `남은 임시 폴더:\n  ${leaked.join('\n  ')}`);
});
