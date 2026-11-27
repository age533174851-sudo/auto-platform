// scripts/test-paper-account-scope-comments.mjs
//
// **계좌 범위 관문이 "적혀 있는 것"에 속지 않는가.**
//
// `check-paper-account-scope.mjs` 는 `from('paper_positions')` 자리마다
// 10줄 창을 떠서 계좌로 좁혔는지 본다. 그 창이 **원문**이었다. 기계 탐침
// 으로 실제로 돌려 확인했다(TS 구문 유효):
//
//     .eq('user_id',uid)                                         → rc=1 (대조)
//     .eq('user_id',uid) // .eq('paper_account_id',account.data.id) → rc=0 (구멍)
//     .eq('user_id',uid) /* .eq('paper_account_id', x) */           → rc=0 (구멍)
//
// 좁히기를 지우면 막는데, 같은 창 안 **주석**에 그 글자를 남기면 통과했다.
// 그 검사기의 머리말이 막으려는 것이 이것이다 — *"전용 계좌(챌린지 등)가
// 처음 생기는 날 가용 증거금·총자산·위험 판정이 섞이고, REVERSE 가 남의
// 계좌 포지션을 닫는다."*
//
// **줄 정렬은 건드리지 않는다.** 걷는 것은 창뿐이고 찾기·줄 번호는 원래
// 줄 배열에서 그대로 쓴다. 창을 이어 붙일 때 `' '` 가 아니라 `'\n'` 을
// 쓰는 것도 그래서다 — 공백으로 이으면 `//` 하나가 창 전체를 먹는다.
// 아래 마지막 대조가 그 성질을 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-paper-account-scope.mjs');
const TARGET = 'src/app/api/paper/automation/route.ts';
const PREFIX = 'pas-cmt-';

/** 이 시험이 만든 임시 폴더만 센다 */
function ownTempDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));
}

/**
 * 검사기를 격리된 작업 폴더에서 돌린다. 이 검사기는 `grep -rln … src worker`
 * 로 대상을 **스스로 찾으므로** 그 두 뿌리가 보여야 한다. `src` 만 복사하고
 * 나머지는 심링크한다.
 * **`finally` 로 반드시 치운다** — 쓰기 공간이 고정 할당이라 남기면 다음
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

function edit(path, fn) {
  const s = readFileSync(path, 'utf8');
  const out = fn(s);
  assert.notEqual(out, s, '바꿀 자리를 못 찾았습니다 — 못 찾은 것을 통과로 적지 않습니다');
  writeFileSync(path, out);
}

const REAL = ".eq('user_id',uid).eq('paper_account_id',account.data.id)";

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  assert.equal(runChecker(null).rc, 0);
});

test('대조 — 계좌 좁히기를 지우면 막는다 (규칙이 필요하긴 한가)', () => {
  const r = runChecker((p) => edit(p(TARGET), (s) => s.replace(REAL, ".eq('user_id',uid)")));
  assert.notEqual(r.rc, 0, '계좌로 안 좁힌 조회가 통과했습니다');
});

test('★ 같은 창 안 꼬리 주석에 좁히기를 남겨도 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(TARGET), (s) =>
    s.replace(REAL, `.eq('user_id',uid) // ${REAL}`)));
  assert.notEqual(r.rc, 0, '꼬리 주석을 살아 있는 좁히기로 셌습니다');
  console.log('    거부 확인 · 꼬리 주석');
});

test('★ 같은 창 안 블록 주석에 좁히기를 남겨도 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(TARGET), (s) =>
    s.replace(REAL, ".eq('user_id',uid) /* .eq('paper_account_id', x) */")));
  assert.notEqual(r.rc, 0, '블록 주석을 살아 있는 좁히기로 셌습니다');
  console.log('    거부 확인 · 블록 주석');
});

test('대조 — 창 안의 설명 주석이 진짜 좁히기를 먹지 않는다', () => {
  // 창을 `' '` 로 이으면 `//` 하나가 뒤를 전부 먹어 **원문이 빨개진다.**
  // `'\n'` 으로 이어야 그 줄만 사라진다. 그 성질을 잠근다.
  const r = runChecker((p) => edit(p(TARGET), (s) =>
    s.replace(REAL, `// 왜 봇 전부를 읽는지 설명\n        ${REAL}`)));
  assert.equal(r.rc, 0, '설명 주석 한 줄이 진짜 좁히기를 먹었습니다');
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = new Set(ownTempDirs());
  runChecker(null);
  assert.deepEqual(ownTempDirs().filter((n) => !before.has(n)), []);
});
