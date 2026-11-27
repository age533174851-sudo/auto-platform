// scripts/test-paper-order-telemetry-comments.mjs
//
// **관측 배선 관문이 "적혀 있는 것"에 속지 않는가.**
//
// 이 검사기의 머리말은 "종료 지점 하나가 빠지면 그 자리는 영영 안 보인다"
// 다. 기계 탐침으로 실제로 돌려 **세 자리**가 주석으로 뚫린 것을 확인했다.
// 변이는 모두 저장소의 TypeScript 파서로 구문 유효를 확인했다.
//
//   §1 `body` 가 줄머리만 뗐다
//        return /* counted( */ NextResponse.json({ ok: false, … }, { status: 400 });
//      같은 `return` 문 안의 블록 주석이 `counted(` 자리를 채워 줘서,
//      **세지 않는 종료 지점**이 보이지 않았다.
//
//   §3 계약을 **원문**(`route`)에서 찾았다
//        // if (code === 'OPENED') recordAudit(sb, ev);
//        // else await recordAuditAsync(sb, ev);
//        await zecordAuditAsync(sb, ev);
//      두 줄을 주석으로 바꾸고 호출을 다른 이름으로 돌려도 통과했다.
//      그러면 "실패 경로를 끝까지 남긴다"가 주석 두 줄로 사라지고,
//      서버리스에서 기록이 응답과 함께 잘린다.
//
//   §4 선언을 **원문**(`mod`)에서 찾았다 — 주석을 **아예** 걷지 않았다
//      라우트가 쓰는 코드를 모듈의 주석에만 적어 두면 통과했다. 줄머리
//      주석·꼬리 주석·블록 주석 **세 모양 모두**. 그 규칙의 목적이
//      "오타가 조용히 통과하지 않게"인데 주석 한 줄로 그게 사라졌다.
//
// **구멍이 아니었던 것도 적어 둔다**: §1 에서 앞 줄 꼬리 주석에 `counted(`
// 를 남기는 변이는 고치기 전에도 rc=1 이었다(`return ` 이후만 잘라 보기
// 때문이다). 패턴이 비슷하다고 구멍으로 적지 않는다. 대조로 넣는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-paper-order-telemetry.mjs');
const ROUTE = 'src/app/api/paper/order/route.ts';
const MODULE = 'src/lib/engine/paperOrderTelemetry.ts';
const PREFIX = 'pot-cmt-';

/** 이 시험이 만든 임시 폴더만 센다 */
function ownTempDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));
}

/**
 * 검사기를 격리된 작업 폴더에서 돌린다. `src` 만 복사하고 나머지는
 * 심링크한다. **`finally` 로 반드시 치운다** — 치우지 않으면 한 번 돌 때마다
 * `src` 사본이 남고, 쓰기 공간이 고정 할당이라 다음 작업이 디스크로 막힌다.
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

const EXIT = `    return await counted(getSupabaseAdmin(), 'INVALID_JSON',
      NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }));`;
const AUDIT = "    if (code === 'OPENED') recordAudit(sb, ev);       // 체결 경로는 기다리지 않는다\n"
            + '    else await recordAuditAsync(sb, ev);              // 실패 경로는 끝까지 남긴다';
const DECL = "  | 'INVALID_JSON'              // 400";

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  assert.equal(runChecker(null).rc, 0);
});

// ── §1 종료 지점 ───────────────────────────────────────────────
test('대조 — 계수를 아예 벗기면 막는다 (규칙이 필요하긴 한가)', () => {
  const r = runChecker((p) => edit(p(ROUTE), (s) => s.replace(EXIT,
    "    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });")));
  assert.notEqual(r.rc, 0, '세지 않는 종료 지점이 생겼는데 통과했습니다');
});

test('★ counted( 를 같은 return 문 안의 블록 주석으로 옮기면 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(ROUTE), (s) => s.replace(EXIT,
    "    return /* counted( */ NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });")));
  assert.notEqual(r.rc, 0, '블록 주석이 계수 자리를 채워 줬습니다');
  console.log('    거부 확인 · return 안의 블록 주석 counted(');
});

test('대조 — 앞 줄 꼬리 주석의 counted( 는 원래도 통하지 않았다', () => {
  // 구멍이 아니었던 것. `return ` 이후만 잘라 보기 때문이다.
  const r = runChecker((p) => edit(p(ROUTE), (s) => s.replace(EXIT,
    "    return NextResponse.json({ ok: false, error: 'invalid_json' }, // counted(\n      { status: 400 });")));
  assert.notEqual(r.rc, 0);
});

// ── §3 성공·실패 경로 계약 ─────────────────────────────────────
test('대조 — 기록 호출 이름을 바꾸면 막는다', () => {
  const r = runChecker((p) => edit(p(ROUTE), (s) =>
    s.replace("if (code === 'OPENED') recordAudit(sb, ev);", "if (code === 'OPENED') zecordAudit(sb, ev);")));
  assert.notEqual(r.rc, 0);
});

test('★ 계약 두 줄을 주석으로 바꾸고 호출을 돌리면 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(ROUTE), (s) => s.replace(AUDIT,
    "    // if (code === 'OPENED') recordAudit(sb, ev);\n"
    + '    // else await recordAuditAsync(sb, ev);\n'
    + '    await zecordAuditAsync(sb, ev);')));
  assert.notEqual(r.rc, 0, '계약이 주석 두 줄로 사라졌는데 통과했습니다');
  console.log('    거부 확인 · 성공·실패 경로 계약을 주석으로');
});

// ── §4 코드 실재 대조 ──────────────────────────────────────────
test('대조 — 라우트가 아무 데도 없는 코드를 쓰면 막는다', () => {
  const r = runChecker((p) => edit(p(ROUTE), (s) => s.replace("'INVALID_JSON',", "'NOT_DECLARED_CODE',")));
  assert.notEqual(r.rc, 0);
});

test('★ 그 코드를 모듈의 주석에만 선언해도 통과하지 않는다 (세 모양)', () => {
  // **두 파일을 동시에** 바꿔야 한다. 모듈만 바꾸면 라우트가 그 코드를
  // 쓰지 않으니 판정 대상이 없고 rc=0 이 맞다 — 처음에 한쪽만 바꿔 재다가
  // 그 rc=0 을 구멍으로 잘못 읽었다.
  const shapes = {
    '줄머리 주석': `${DECL}\n  // | 'NOT_DECLARED_CODE'`,
    '꼬리 주석': `${DECL} | 'NOT_DECLARED_CODE'`,
    '블록 주석': "  | 'INVALID_JSON'  /* | 'NOT_DECLARED_CODE' */            // 400",
  };
  for (const [name, decl] of Object.entries(shapes)) {
    const r = runChecker((p) => {
      edit(p(ROUTE), (s) => s.replace("'INVALID_JSON',", "'NOT_DECLARED_CODE',"));
      edit(p(MODULE), (s) => s.replace(DECL, decl));
    });
    assert.notEqual(r.rc, 0, `${name}에만 선언했는데 통과했습니다`);
    console.log(`    거부 확인 · 모듈의 ${name}에만 선언`);
  }
});

// ── §2 금지 앵커 회귀 ──────────────────────────────────────────
test('대조 — counted() 에 주문 내용을 넘기면 여전히 막는다', () => {
  const r = runChecker((p) => edit(p(ROUTE), (s) => s.replace(
    "return await counted(getSupabaseAdmin(), 'INVALID_JSON',",
    "return await counted(getSupabaseAdmin(), 'INVALID_JSON', symbol,")));
  assert.notEqual(r.rc, 0, '기록에 심볼을 넘기는데 통과했습니다');
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = new Set(ownTempDirs());
  runChecker(null);
  assert.deepEqual(ownTempDirs().filter((n) => !before.has(n)), []);
});
