// scripts/test-market-data-honesty-comments.mjs
//
// **시장 데이터 정직성 관문이 "적혀 있는 것"에 속지 않는가.**
//
// `check-market-data-honesty.mjs` 의 앵커는 대부분 오류 코드·상수
// 문자열(`news_provider_unconfigured` · `MOCK_NOT_REAL_NEWS` ·
// `MCAP_QUARANTINED_NOT_REAL` …)이다. 그 판정이 보는 본문은 `code()` 를
// 지난 것이었고, `code()` 는 `//`·`*`·`/*` 로 **시작하는 줄**만 버렸다.
// 꼬리 주석에 그 글자만 남겨도 만족됐다.
//
// 기계 탐침으로 실제로 돌려 확인한 구멍 둘 — 전부 TS 구문이 유효하고,
// **이 검사기가 막으려고 쓰인 바로 그 고장**이 되살아나는데 통과했다:
//
//   if (false) { // if (items.length === 0 && !allowMock) {
//     → 공급자 미설정 거부가 꺼지고 지어낸 기사가 ok 로 나간다
//
//   if (items.length === 0) source = 'TRAIGO'; // source = 'MOCK_NOT_REAL_NEWS'
//     → 지어낸 기사가 우리 출처로 적혀 실제 기사와 구별되지 않는다
//
// 먼저 앵커가 필요한지 확인했다 — 두 줄을 지우면 각각 rc=1 이다.
// 아래 시험이 그 변형을 박아 둔다. 다시 통과하면 구멍이 다시 열린 것이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-market-data-honesty.mjs');
const NEWS = 'src/app/api/market/news/route.ts';
const GUARD = '  if (items.length === 0 && !allowMock) {';
const MARK = "  if (items.length === 0) source = 'MOCK_NOT_REAL_NEWS';";
const PREFIX = 'mdh-cmt-';

/** 이 시험이 만든 임시 폴더 (다른 접두사·다른 시험은 세지 않는다) */
function ownTempDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));
}

/**
 * 검사기를 **격리된 작업 폴더**에서 돌린다. `src` 만 복사하고 나머지는
 * 심링크한다. **`finally` 로 반드시 치운다** — 치우지 않으면 한 번 돌 때마다
 * `src` 사본이 남고 쓰기 가능 공간이 고정 할당이라 다음 작업이 막힌다
 * (검수 지적 #799).
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

function swap(path, from, to) {
  const s = readFileSync(path, 'utf8');
  assert.ok(s.includes(from), `바꿀 줄을 못 찾았습니다: ${from.trim().slice(0, 50)}`);
  writeFileSync(path, s.replace(from, to));
}

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  assert.equal(runChecker(null).rc, 0);
});

test('대조 — 두 줄을 지우면 막는다 (앵커가 필요하긴 한가)', () => {
  const a = runChecker((p) => swap(p(NEWS), GUARD, '  if (false) {'));
  assert.notEqual(a.rc, 0, '미설정 거부를 없앴는데 통과했습니다');
  const b = runChecker((p) => swap(p(NEWS), `${MARK}\n`, ''));
  assert.notEqual(b.rc, 0, 'MOCK 표식을 없앴는데 통과했습니다');
});

test('★ 미설정 거부를 끄고 조건을 꼬리 주석에 남기면 통과하지 않는다', () => {
  const r = runChecker((p) => swap(p(NEWS), GUARD, `  if (false) { //${GUARD}`));
  assert.notEqual(r.rc, 0, '꼬리 주석이 살아 있는 거부로 셌습니다 — 지어낸 기사가 ok 로 나갑니다');
  console.log('    거부 확인 · 공급자 미설정 거부를 꼬리 주석으로');
});

test("★ MOCK 표식을 'TRAIGO' 로 바꾸고 꼬리 주석에 남기면 통과하지 않는다", () => {
  const r = runChecker((p) => swap(p(NEWS), MARK,
    "  if (items.length === 0) source = 'TRAIGO'; // source = 'MOCK_NOT_REAL_NEWS'"));
  assert.notEqual(r.rc, 0, '꼬리 주석이 표식으로 셌습니다 — 지어낸 기사가 우리 출처로 나갑니다');
  console.log("    거부 확인 · MOCK 표식을 'TRAIGO' 로 바꾸고 꼬리 주석에");
});

test('대조 — 줄머리 주석을 더해도 판정이 흔들리지 않는다', () => {
  const r = runChecker((p) => swap(p(NEWS), GUARD,
    `  // 설명: items.length === 0 && !allowMock 이면 거부한다\n${GUARD}`));
  assert.equal(r.rc, 0, r.out);
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = new Set(ownTempDirs());
  runChecker(null);
  assert.deepEqual(ownTempDirs().filter((n) => !before.has(n)), []);
});
