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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts/check-get-writes.mjs');

function runChecker() {
  const r = spawnSync(process.execPath, [CHECKER], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * 임시 라우트를 두고 검사기를 돌린다. 끝나면 **반드시** 지운다.
 * 남기면 다음 시험·다음 회차가 그 파일을 저장소의 것으로 읽는다.
 */
function withRoute(name, source, fn) {
  const dir = join(ROOT, 'src/app/api', name);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'route.ts'), source);
    return fn(runChecker());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HEAD = `import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
`;

test('양성 대조 — 손대지 않은 저장소는 초록이고 라우트를 실제로 세었다', () => {
  const r = runChecker();
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
