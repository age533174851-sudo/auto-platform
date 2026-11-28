// scripts/test-paper-automation-coverage.mjs
//
// **주석이 시험대의 마이그레이션 목록을 대신하지 않는다.**
//
// `node --test scripts/test-*.mjs` (ci.yml의 글롭)에 자동으로 걸린다.
//
// 무엇이 실제로 이랬나 (기준 main ed00c1a4, fixture 탐침으로 돌려서 얻은 값)
// ──────────────────────────────────────────────────────────────────
// `check-paper-automation-migrations.mjs`는 두 시험대가 paper 마이그레이션
// 19개를 모두 올리는지 센다. 그런데 **원문을 그대로 세고 있었다.**
//
//   대조 · 원문 그대로                                 rc=0  OK
//   대조 ★★ flow 의 ids 에서 102 를 뺀다                rc=1  OK
//   102 를 빼고 파일명을 주석에 적는다                     rc=0  구멍
//   ids 줄을 통째로 주석 처리한다                         rc=0  구멍
//   ids 를 주석에만 남기고 코드에서 지운다                   rc=0  구멍
//   pg 시험대의 LATE 배열을 주석 처리한다                   rc=0  구멍
//
// 세 번째 줄이 가장 나쁘다. 시험대가 **아무것도 올리지 않는데** 검사기는
// 19개를 전부 올린다고 말했다. 이 검사기가 막으려던 사고(마이그레이션 102의
// claim 함수를 아무도 실제 DB로 돌리지 않던 기간)가 **주석 한 줄로 다시
// 가능했다.**
//
// 삭제 대조가 rc=1 인 것이 이 측정의 근거다 — fixture 가 검사기에 실제로
// 닿는다는 증거다. 이 검사기는 경로를 모두 cwd 기준으로 읽으므로 fixture 를
// cwd 로 주면 된다 (`import.meta.url` 로 root 를 유도하지 않는다).
//
// 지금 저장소는 주석에 의존하지 않는다 — 두 시험대 모두 원문 기준·주석 제거
// 기준 양쪽에서 빠진 것이 0개다(돌려서 확인했다). 그래서 이 수정으로 main 이
// 빨강이 되지 않는다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts/check-paper-automation-migrations.mjs');
const FLOW = 'scripts/probe/paper-automation-flow.mjs';
const PGT = 'scripts/paper-automation-pg.test.mjs';

/**
 * 저장소의 거울 — `scripts`·`supabase`만 실제 디렉터리로 만들고 나머지는
 * 심링크로 둔다.
 *
 * ★ 심링크를 만든 뒤 같은 경로에 쓰면 **원본 파일을 덮어쓴다.** 그래서
 *   바꿀 파일은 쓰기 전에 심링크를 끊는다. (이 함정에 실제로 두 번 빠졌다.)
 */
function mirror(a, d, add) {
  mkdirSync(d, { recursive: true });
  const rel = a.slice(ROOT.length + 1);
  for (const e of readdirSync(a, { withFileTypes: true })) {
    const s = join(a, e.name), t = join(d, e.name);
    if (e.isDirectory()) mirror(s, t, add);
    else symlinkSync(s, t);
  }
  for (const [q, body] of add) {
    if (q.slice(0, q.lastIndexOf('/')) !== rel) continue;
    const dst = join(d, q.slice(q.lastIndexOf('/') + 1));
    rmSync(dst, { force: true });
    writeFileSync(dst, body);
  }
}

function withFixture(add, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pam-test-'));
  try {
    for (const e of readdirSync(ROOT, { withFileTypes: true })) {
      if (e.name === 'scripts' || e.name === 'supabase') {
        mirror(join(ROOT, e.name), join(dir, e.name), add);
        continue;
      }
      symlinkSync(join(ROOT, e.name), join(dir, e.name));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 검사기를 fixture 를 cwd 로 돌린다 */
const run = (add) => withFixture(add, (dir) => {
  try {
    const out = execFileSync(process.execPath, [CHECKER],
      { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 600_000 });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
});

const flowSrc = () => readFileSync(join(ROOT, FLOW), 'utf8');
const pgSrc = () => readFileSync(join(ROOT, PGT), 'utf8');

// ── 대조 — 지금 저장소는 통과한다 ────────────────────────────────
test('대조 — 지금 저장소는 통과한다', () => {
  const r = run(new Map());
  assert.equal(r.rc, 0, `지금 트리가 막히면 검사기가 거짓말을 한다:\n${r.out}`);
  assert.match(r.out, /paper 마이그레이션 \d+개를 2개 시험대가 모두 올립니다/);
});

// ── 삭제 대조 — fixture 가 검사기에 닿는가 ──────────────────────
test('대조 ★★ 삭제 대조 — 목록에서 102 를 빼면 막는다', () => {
  const r = run(new Map([[FLOW, flowSrc().replace('102,103,104]', '103,104]')]]));
  assert.equal(r.rc, 1, 'fixture 가 검사기에 닿지 않으면 이 시험 전체가 무의미하다');
  assert.match(r.out, /102_paper_multi_bot\.sql/);
});

// ── ★ 주석이 목록을 대신하지 않는다 ─────────────────────────────
test('★ 102 를 빼고 파일명을 주석에 적으면 막는다', () => {
  const r = run(new Map([[FLOW, `${flowSrc().replace('102,103,104]', '103,104]')}\n`
    + '// 102_paper_multi_bot.sql 은 여기서 올리지 않는다\n']]));
  assert.equal(r.rc, 1, '주석에 적는 것으로 통과하면 사유만 적고 아무도 올리지 않는다');
  assert.match(r.out, /102_paper_multi_bot\.sql/);
});

test('★ ids 줄을 통째로 주석 처리하면 전부 빠진 것으로 센다', () => {
  const r = run(new Map([[FLOW, flowSrc().replace(/^const ids=\[/m, '// const ids=[')]]));
  assert.equal(r.rc, 1, '아무것도 올리지 않는데 통과하던 것이 이 검사의 가장 나쁜 구멍이었다');
  assert.match(r.out, /19개/);
});

test('★ ids 를 주석에만 남기고 코드에서 지우면 막는다', () => {
  const r = run(new Map([[FLOW, flowSrc().replace(/^const ids=\[([^\]]*)\];/m,
    (m, g) => `// const ids=[${g}];\nconst ids=[];`)]]));
  assert.equal(r.rc, 1);
  assert.match(r.out, /19개/);
});

test('★ 파일명 목록을 주석 처리하면 막는다', () => {
  const r = run(new Map([[PGT, pgSrc().replace(
    "  const LATE = ['099_paper_automation.sql'",
    "  // const LATE = ['099_paper_automation.sql'")]]));
  assert.equal(r.rc, 1);
  assert.match(r.out, /099_paper_automation\.sql/);
});

test('★ 블록 주석 안의 목록도 세지 않는다', () => {
  const r = run(new Map([[FLOW, flowSrc().replace(/^const ids=\[([^\]]*)\];/m,
    (m, g) => `/* const ids=[${g}]; */\nconst ids=[];`)]]));
  assert.equal(r.rc, 1);
  assert.match(r.out, /19개/);
});

// ── 대조 — 지나치게 잡지 않는가 ─────────────────────────────────
test('대조 — 관계없는 주석을 더해도 통과한다', () => {
  const r = run(new Map([[FLOW, `// 아무 의미 없는 주석\n${flowSrc()}`]]));
  assert.equal(r.rc, 0, r.out);
});

test('대조 — 주석 안의 괄호·따옴표가 목록을 깨지 않는다', () => {
  const r = run(new Map([[FLOW,
    `// 목록 모양을 설명하는 주석: ids=[1,2] 와 'x.sql' 처럼 적는다\n${flowSrc()}`]]));
  assert.equal(r.rc, 0, r.out);
});

test('대조 — 문자열 안의 주석 기호는 코드로 남는다', () => {
  // `stripJsComments`는 문자열 내부를 보존한다. 파일명 목록이 문자열
  // 리터럴이므로 그 보존이 없으면 이 검사기가 전부 빠진 것으로 센다.
  const r = run(new Map([[FLOW,
    `const note = 'http://example.com // not a comment';\n${flowSrc()}`]]));
  assert.equal(r.rc, 0, r.out);
});

test('대조 — paper 가 아닌 마이그레이션을 더해도 요구하지 않는다', () => {
  const r = run(new Map([['supabase/migrations/198_unrelated_thing.sql',
    'CREATE TABLE IF NOT EXISTS public.unrelated_thing (id bigserial primary key);\n']]));
  assert.equal(r.rc, 0, r.out);
});

test('★ paper 마이그레이션을 새로 더하면 목록에 넣으라고 막는다', () => {
  const r = run(new Map([['supabase/migrations/198_paper_new_thing.sql',
    'CREATE TABLE IF NOT EXISTS public.paper_new_thing (id bigserial primary key);\n']]));
  assert.equal(r.rc, 1, '새 paper 마이그레이션을 아무 시험대도 올리지 않으면 막아야 한다');
  assert.match(r.out, /198_paper_new_thing\.sql/);
});
