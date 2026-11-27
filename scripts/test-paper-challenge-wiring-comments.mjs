// scripts/test-paper-challenge-wiring-comments.mjs
//
// **챌린지 배선 관문이 "적혀 있는 것"에 속지 않는가.**
//
// `check-paper-challenge-wiring.mjs` 의 `code()` 는 **줄머리만** 뗐다
// (`/^\s*(\/\/|\*|\/\*|--)/`). 기계 탐침으로 실제로 돌려 TS 쪽 네 자리가
// 꼬리 주석에 뚫린 것을 확인했다. 넷 다 TS 구문 유효였고, 이름만 바꾸면
// rc=1 이라 **앵커는 필요한 것이 맞았다** — 보는 눈이 문제였다:
//
//     accountId = zs.accountId;    // accountId = cs.accountId;
//     rpc('zaper_challenge_cancel' // rpc('paper_challenge_cancel'
//     status === 'ZUNNING'         // status === 'RUNNING'
//     zaperEventTimeNow()          /* paperEventTimeNow() */
//
// 각각이 지키던 것:
//   · `accountId = cs.accountId;` — 챌린지를 물어봤는데 다른 장부를 보여 주지
//     않는다
//   · `rpc('paper_challenge_cancel'` — 취소 회계 권위가 087 함수 하나다
//   · `status === 'RUNNING'` — 관문이 **허용 목록**이다 (금지 목록이면 상태가
//     늘 때 조용히 열린다)
//   · `paperEventTimeNow()` — 사건 시각을 서버가 만든다
//
// **SQL 쪽은 아직 열려 있다.** 같은 탐침으로 마이그레이션에서 구멍 3개를
// 실측했고(사유 CAS · 사건시각 가드 · 소유자 조건), 그 수정은 공용
// `stripSqlComments`(PR #795)가 main 에 올라간 뒤에 온다. **열린 구멍을
// 통과로 못 박는 시험은 쓰지 않는다** — 측정값은 검사기 머리말과 PR 본문에
// 그대로 적어 두었다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-paper-challenge-wiring.mjs');
const POS = 'src/app/api/paper/positions/route.ts';
const CANCEL = 'src/app/api/paper/challenge/[id]/cancel/route.ts';
const SCOPE = 'src/lib/engine/paperChallengeScope.ts';
const PREFIX = 'pcw-cmt-';

/** 이 시험이 만든 임시 폴더만 센다 */
function ownTempDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));
}

/**
 * 검사기를 격리된 작업 폴더에서 돌린다. `src` 만 복사하고 나머지는
 * 심링크한다(마이그레이션은 읽기만 하므로 심링크로 충분하다).
 * **`finally` 로 반드시 치운다** — 치우지 않으면 한 번 돌 때마다 `src`
 * 사본이 남고, 쓰기 공간이 고정 할당이라 다음 작업이 디스크로 막힌다.
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

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  assert.equal(runChecker(null).rc, 0);
});

test('대조 — 챌린지 계좌 대입을 다른 이름으로 바꾸면 막는다', () => {
  const r = runChecker((p) => edit(p(POS), (s) =>
    s.replace('accountId = cs.accountId;', 'accountId = zs.accountId;')));
  assert.notEqual(r.rc, 0, '챌린지가 정한 계좌를 안 쓰는데 통과했습니다');
});

test('★ 챌린지 계좌 대입을 꼬리 주석으로 옮기면 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(POS), (s) =>
    s.replace('accountId = cs.accountId;', 'accountId = zs.accountId; // accountId = cs.accountId;')));
  assert.notEqual(r.rc, 0, '꼬리 주석을 살아 있는 대입으로 셌습니다');
  console.log('    거부 확인 · 챌린지 계좌 대입을 꼬리 주석으로');
});

test('★ 087 함수 호출을 꼬리 주석으로 옮기면 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(CANCEL), (s) =>
    s.replace("rpc('paper_challenge_cancel'", "rpc('zaper_challenge_cancel' // rpc('paper_challenge_cancel'\n       ")));
  assert.notEqual(r.rc, 0, '취소 회계 권위를 안 부르는데 주석으로 통과했습니다');
  console.log('    거부 확인 · rpc(paper_challenge_cancel) 을 꼬리 주석으로');
});

test('★ RUNNING 허용 목록을 꼬리 주석으로 옮기면 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(SCOPE), (s) =>
    s.replace("status === 'RUNNING'", "status === 'ZUNNING' // status === 'RUNNING'\n    ")));
  assert.notEqual(r.rc, 0, '관문이 허용 목록이 아닌데 주석으로 통과했습니다');
  console.log('    거부 확인 · RUNNING 허용 목록을 꼬리 주석으로');
});

test('★ 서버 사건 시각 호출을 블록 꼬리 주석으로 옮기면 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(CANCEL), (s) =>
    s.replaceAll('paperEventTimeNow()', 'zaperEventTimeNow() /* paperEventTimeNow() */')));
  assert.notEqual(r.rc, 0, '서버 사건 시각을 안 쓰는데 주석으로 통과했습니다');
  console.log('    거부 확인 · paperEventTimeNow() 를 블록 꼬리 주석으로');
});

test('대조 — 요청에서 계좌 id 를 읽으면 여전히 막는다 (금지 앵커 회귀)', () => {
  // TS 쪽을 공용 제거기로 바꿨으니, 금지 쪽이 느슨해지지 않았는지 본다.
  const r = runChecker((p) => edit(p(POS), (s) =>
    s.replace('export async function GET', "const leak = searchParams.get('paperAccountId');\nexport async function GET")));
  assert.notEqual(r.rc, 0, '요청에서 계좌 id 를 읽는데 통과했습니다');
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = new Set(ownTempDirs());
  runChecker(null);
  assert.deepEqual(ownTempDirs().filter((n) => !before.has(n)), []);
});
