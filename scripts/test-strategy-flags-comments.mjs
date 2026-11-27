// scripts/test-strategy-flags-comments.mjs
//
// **점검 플래그 검사기의 요구 앵커가 주석으로 만족되지 않는다.**
//
// `check-strategy-flags.mjs` 가 막으려는 고장은 그 파일 머리에 적혀 있다:
// 레지스트리는 점검 플래그를 한 이름으로 선언했는데 라우트가 다른 이름만
// 읽어서, **"주문은 안 냅니다"라고 적힌 버튼이 주문을 냈다.**
//
// 그런데 그 판정 셋이 전부 **원문**을 보고 있었다. 주석 한 줄로 전부
// 만족됐다 — 기계 탐침으로 실제로 돌려 확인했다:
//
//   · 위임 호출을 지우고 주석에만 `checkOnlyOf(` 를 적으면      통과했다
//   · 읽기를 지우고 주석에만 `body.checkOnly` 를 적으면          통과했다
//   · 레지스트리 블록에 주석으로 다른 이름을 먼저 적으면
//     검사기가 **엉뚱한 이름**을 검증하고 통과했다
//
// ★ 가 그 셋이고 나머지는 대조다. 대조가 무너지면 ★ 는 의미가 없다.
//
// `my-original-v1` 은 건드리지 않는다 — 사본에서도 손대지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const CHECKER = join(ROOT, 'scripts', 'check-strategy-flags.mjs');
const PREFIX = 'sf-cmt-';

const REG = 'src/lib/strategies/registry.ts';
const ROUTES = [
  'src/app/api/autotrade/daily-ladder/route.ts',
  'src/app/api/autotrade/scalp/route.ts',
  'src/app/api/autotrade/my-original-v1/route.ts',
];
const NEEDED = [REG, ...ROUTES];

const SCALP = ROUTES[1];
const DAILY = ROUTES[0];

/** 검사기가 읽는 파일만 실체로 둔 격리 사본. `edits`는 {경로: (본문)=>본문} */
function fixture(edits = {}) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  for (const rel of NEEDED) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const next = edits[rel] ? edits[rel](text) : text;
    assert.ok(!edits[rel] || next !== text, `변이가 적용되지 않았다: ${rel}`);
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, next);
  }
  return dir;
}

function runIn(dir) {
  try {
    execFileSync(process.execPath, [CHECKER], { cwd: dir, stdio: 'pipe', timeout: 120_000 });
    return { rc: 0, out: '' };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function withFixture(edits, fn) {
  const dir = fixture(edits);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── 변이 조각 ──
const CALL = "checkOnlyOf('scalp', body)";
const READ = 'body.checkOnly === true';
const killCall = (s) => s.replaceAll(CALL, "resolveCheckX('scalp', body)");
const killRead = (s) => s.replaceAll(READ, 'false');
const addComment = (text) => (s) => s.replace('export async function POST', `// ${text}\nexport async function POST`);
const chain = (...fns) => (s) => fns.reduce((acc, f) => f(acc), s);
const fakeDecl = (s) => s.replace("    id: 'daily-ladder',",
  "    id: 'daily-ladder',\n    // 과거 이름: checkFlag: 'dryRun'");

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  assert.equal(withFixture({}, runIn).rc, 0);
});

test('대조 — scalp 의 위임 호출을 지우면 막는다 (요구 앵커가 동작하는가)', () => {
  assert.equal(withFixture({ [SCALP]: killCall }, runIn).rc, 1,
    '요구 앵커가 동작하지 않는다 — 아래 ★ 시험은 의미가 없다');
});

test('★ 지우고 주석에만 `checkOnlyOf(` 를 적어도 막는다', () => {
  const edits = { [SCALP]: chain(killCall, addComment('원래는 checkOnlyOf(…) 를 써야 한다')) };
  assert.equal(withFixture(edits, runIn).rc, 1,
    '주석 한 줄이 위임을 가장했다 — 점검 호출이 주문을 낼 수 있다');
});

test('대조 — 그 이름 없는 주석이면 원래도 막았다', () => {
  const edits = { [SCALP]: chain(killCall, addComment('원래는 공용 판정기를 써야 한다')) };
  assert.equal(withFixture(edits, runIn).rc, 1);
});

test('대조 — daily-ladder 가 선언한 이름을 읽는 자리를 지우면 막는다', () => {
  assert.equal(withFixture({ [DAILY]: killRead }, runIn).rc, 1);
});

test('★ 지우고 주석에만 `body.checkOnly` 를 적어도 막는다', () => {
  const edits = { [DAILY]: chain(killRead, addComment('예전에는 body.checkOnly 를 읽었다')) };
  assert.equal(withFixture(edits, runIn).rc, 1,
    '주석 한 줄이 "선언한 이름을 읽는다"를 가장했다');
});

test('★ 레지스트리 선언을 주석으로 바꿔치기해도 엉뚱한 이름을 검증하지 않는다', () => {
  // 진짜 읽기를 지우고, 블록에 주석으로 다른 이름을 먼저 적는다.
  // 주석이 이기면 검사기는 라우트가 읽는 `dryRun` 을 보고 통과한다.
  const r = withFixture({ [DAILY]: killRead, [REG]: fakeDecl }, runIn);
  assert.equal(r.rc, 1, '주석이 선언을 바꿔치기했다 — 검사기가 엉뚱한 이름을 검증했다');
  assert.ok(!r.out.includes("'dryRun'를 직접 읽음"),
    '판정이 주석이 적은 이름으로 바뀌었다');
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  withFixture({}, runIn);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  assert.equal(after, before, `임시 폴더가 늘었다 (${before} → ${after})`);
});
