// `check-get-writes.mjs`가 **표기법을 바꿔도 잡는가**를 본다.
//
// 왜 이 시험이 있는가
// ───────────────────
// 그 검사기는 "새로 생기는 GET이 쓰는 경로를 CI가 막는다"고 적고 있다.
// 그런데 `export async function GET(` 하나만 찾았기 때문에 Next가 똑같이
// 받아 주는 `export const GET = async () => {}` 꼴은 **검사 대상에서
// 통째로 빠졌다.** 계수에도 안 들어갔다.
//
// 실측: 그 꼴로 `.insert(`를 넣은 라우트를 두고 돌려도
//   "✅ GET 라우트 132개 · 새로 쓰는 것 0개" · 종료코드 0
// 이었다. 표기법만 바꾸면 통과하는 관문은 있는 것보다 나쁘다 — 있다고
// 믿게 하기 때문이다.
//
// 그래서 **행동으로** 못을 박는다. 두 꼴 모두에서 빨강이어야 하고,
// POST가 쓰는 것은 여전히 통과여야 한다(잘못 막으면 그것도 고장이다).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts/check-get-writes.mjs');

function runChecker(cwd) {
  const r = spawnSync(process.execPath, [CHECKER], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * 임시 라우트를 **복제한 트리 안에** 두고 검사기를 돌린다.
 *
 * 왜 복제하는가 — 이 시험이 한 번 CI를 빨갛게 만들었다
 * ──────────────────────────────────────────────────────
 * 처음에는 실제 `src/app/api/` 안에 임시 라우트를 만들고 `finally`에서
 * 지웠다. `node --test`는 **시험 파일들을 병렬로** 돌리므로, 형제 시험
 * (`test-instrument-route-fields.mjs`)이 같은 디렉터리를 훑는 중에 내
 * `finally`가 그것을 지웠고 CI가 이렇게 끝났다:
 *
 *     ENOENT: no such file or directory, scandir 'src/app/api/zz-test-boundary'
 *
 * 지우는 것을 미루거나 이름을 바꾸는 것으로는 못 고친다 — **공유 상태를
 * 건드리는 것 자체가 원인**이다. 그래서 실제 트리는 읽기만 하고,
 * 복제본 안에서만 쓴다.
 *
 * 검사기는 `src/app/api`와 면제(ALLOW) 경로를 **cwd 기준 상대경로**로
 * 읽으므로, cwd를 복제 뿌리로 주면 면제 목록도 복제본 안에서 풀린다.
 */
function withRoute(name, source, fn) {
  return withTree({ [`src/app/api/${name}/route.ts`]: source }, (base) => fn(runChecker(base)));
}

/**
 * 복제한 트리에 **임의의 상대경로**로 파일을 쓴 뒤 그 안에서 돌린다.
 *
 * `withRoute`로는 `src/app/api` 안의 `route.ts`만 둘 수 있다. 검사기가
 * `src/app` 전체에서 `route.*`를 찾게 된 뒤로는 **뿌리 밖**과 **다른 파일
 * 꼴**도 세워 봐야 한다.
 */
function withTree(files, fn) {
  const base = mkdtempSync(join(tmpdir(), 'getwrites-'));
  try {
    cpSync(join(ROOT, 'src/app/api'), join(base, 'src/app/api'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(base, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const WRITING_GET = `${'import { NextResponse } from \'next/server\';'}
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET() {
  const sb = createAdminClient();
  await sb.from('account_equity_snapshots').insert({ equity: 1 });
  return NextResponse.json({ ok: true });
}
`;

const HEAD = `import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
`;

test('양성 대조 — 손대지 않은 저장소는 초록이고 라우트를 실제로 세었다', () => {
  const r = runChecker(ROOT);
  assert.equal(r.code, 0, `빨강입니다:\n${r.err.slice(0, 500)}`);
  const m = /GET 라우트 (\d+)개/.exec(r.out);
  assert.ok(m, `라우트 개수를 찍지 않았습니다: ${r.out.slice(0, 200)}`);
  // 0개를 통과로 적지 않는다 — 아무것도 안 본 초록이 가장 나쁘다.
  assert.ok(Number(m[1]) > 100, `본 라우트가 ${m[1]}개뿐입니다`);
});

test('★ const 화살표 꼴 GET이 쓰면 빨강이다 (예전에는 통째로 빠졌다)', () => {
  withRoute('zz-test-const-get', `${HEAD}
export const GET = async () => {
  const sb = createAdminClient();
  await sb.from('account_equity_snapshots').insert({ equity: 1 });
  return NextResponse.json({ ok: true });
};
`, (r) => {
    assert.notEqual(r.code, 0, 'const 꼴 GET이 쓰는데 통과했습니다');
    assert.match(r.err, /zz-test-const-get/, '어느 파일인지 말하지 않습니다');
    assert.match(r.err, /GET이 DB에 쓰고 있습니다/);
    assert.doesNotMatch(r.out, /새로 쓰는 것 0개/, '빨강인데 통과 문장을 찍었습니다');
  });
});

test('function 꼴 GET이 쓰면 빨강이다 (원래 동작의 회귀)', () => {
  withRoute('zz-test-fn-get', `${HEAD}
export async function GET() {
  const sb = createAdminClient();
  await sb.from('account_equity_snapshots').insert({ equity: 1 });
  return NextResponse.json({ ok: true });
}
`, (r) => {
    assert.notEqual(r.code, 0, 'function 꼴 GET이 쓰는데 통과했습니다');
    assert.match(r.err, /zz-test-fn-get/);
  });
});

test('POST가 쓰는 것은 통과한다 — 잘못 막으면 그것도 고장이다', () => {
  withRoute('zz-test-post-writes', `${HEAD}
export async function GET() {
  return NextResponse.json({ ok: true });
}

export async function POST() {
  const sb = createAdminClient();
  await sb.from('account_equity_snapshots').insert({ equity: 1 });
  return NextResponse.json({ ok: true });
}
`, (r) => {
    assert.equal(r.code, 0, `POST 쓰기를 막았습니다:\n${r.err.slice(0, 400)}`);
    assert.doesNotMatch(r.err, /zz-test-post-writes/);
  });
});

test('경계 — GET 다음이 const POST여도 POST 쓰기를 GET으로 세지 않는다', () => {
  withRoute('zz-test-boundary', `${HEAD}
export async function GET() {
  return NextResponse.json({ ok: true });
}

export const POST = async () => {
  const sb = createAdminClient();
  await sb.from('account_equity_snapshots').insert({ equity: 1 });
  return NextResponse.json({ ok: true });
};
`, (r) => {
    assert.equal(r.code, 0, `const POST의 쓰기를 GET으로 셌습니다:\n${r.err.slice(0, 400)}`);
    assert.doesNotMatch(r.err, /zz-test-boundary/);
  });
});

test("재수출(`export { GET } from …`)은 건너뛴다 — 부모 라우트가 따로 검사된다", () => {
  withRoute('zz-test-reexport', "export { GET } from '../route';\n", (r) => {
    assert.equal(r.code, 0, `재수출을 막았습니다:\n${r.err.slice(0, 300)}`);
  });
});

test('★ route.tsx 꼴로 GET이 쓰면 빨강이다 (예전에는 꼴만 바꾸면 빠졌다)', () => {
  // Next는 `route.tsx`도 라우트로 받는다. 검사기는 `route.ts`만 읽으므로,
  // 읽을 수 없는 꼴을 발견하면 **모른다고 적어야** 한다.
  withTree({ 'src/app/api/zz-test-ext/route.tsx': WRITING_GET }, (base) => {
    const r = runChecker(base);
    assert.notEqual(r.code, 0, '읽지 못하는 꼴의 라우트를 통과시켰습니다');
    assert.match(r.err, /zz-test-ext\/route\.tsx/, '어느 파일인지 말하지 않습니다');
    assert.match(r.err, /읽지 못하는 라우트 파일 꼴/);
    assert.doesNotMatch(r.out, /새로 쓰는 것 0개/, '빨강인데 통과 문장을 찍었습니다');
  });
});

test('★ 걷는 뿌리 밖의 route.ts가 GET으로 쓰면 빨강이다', () => {
  // 라우트를 `src/app/api` 밖으로 옮기면 검사기는 그것을 아예 열지 않는다.
  // 발견하지 못한 것을 "0개"로 적지 않는다.
  withTree({ 'src/app/(v2)/api/zz-test-loc/route.ts': WRITING_GET }, (base) => {
    const r = runChecker(base);
    assert.notEqual(r.code, 0, '뿌리 밖 라우트를 통과시켰습니다');
    assert.match(r.err, /zz-test-loc\/route\.ts/);
    assert.match(r.err, /밖의 라우트/);
    assert.doesNotMatch(r.out, /새로 쓰는 것 0개/);
  });
});

test('★ 발견이 비면 빨강이다 — "새로 쓰는 것 0개"를 적지 않는다', () => {
  // 디렉터리 훑기만 빈 결과로 만든다(고정 경로 읽기는 그대로). 이것이
  // 이 구멍을 찾은 탐침이고, 고치기 전에는 여기서
  //   ✅ GET 라우트 0개 · 새로 쓰는 것 0개   rc=0
  // 이 나왔다.
  withTree({ 'blind.mjs': `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('fs');
fs.readdirSync = () => [];
if (fs.globSync) fs.globSync = () => [];
` }, (base) => {
    const r = spawnSync(process.execPath,
      ['--import', pathToFileURL(join(base, 'blind.mjs')).href, CHECKER],
      { cwd: base, encoding: 'utf8' });
    assert.notEqual(r.status, 0, '라우트를 하나도 못 열고 통과했습니다');
    assert.match(r.stderr ?? '', /하나도 찾지 못했습니다/);
    assert.doesNotMatch(r.stdout ?? '', /새로 쓰는 것 0개/);
  });
});
