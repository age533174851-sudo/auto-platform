// `check-order-guards.mjs`의 **발견이 비면 멈추는가**를 본다.
//
// 그 검사기의 머리말은 이렇게 적고 있다 — "검사가 조용히 사라지는 것이
// 검사가 못 찾는 것보다 나쁘다." 그런데 주문 경로를 찾는 코드가
// `globSync`가 없거나 던지면 후보를 **빈 배열**로 두고 계속 갔다.
//
// 실측했다. `globSync` 분기를 끈 사본에 목록 밖 주문 라우트를 두고
// 돌리면 이렇게 끝났다:
//
//     ✅ 실주문 경로 10개 · 안전장치 빠진 것 0개 · 조회 실패를 0으로
//        만드는 길 0개 …                                   rc=0
//
// 한 줄도 안 훑고 "0개"를 적는 것은 이 저장소가 금지한 **UNKNOWN을
// 0으로 적기**다. 그래서 행동으로 못을 박는다.
//
// 공유 상태를 건드리지 않는다 — `src/app/api`에 임시 라우트를 만들면
// 병렬로 도는 형제 시험이 깨진다(실제로 한 번 깨뜨렸다). 복제본에서만 쓴다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = 'scripts/check-order-guards.mjs';
const SOURCE = readFileSync(join(ROOT, CHECKER), 'utf8');

/** 복제 뿌리를 한 번만 만든다 — `src`는 20MB이고 경우마다 복사하면 느리다 */
const BASE = mkdtempSync(join(tmpdir(), 'orderguards-'));
cpSync(join(ROOT, 'src'), join(BASE, 'src'), { recursive: true });
mkdirSync(join(BASE, 'scripts/lib'), { recursive: true });
cpSync(join(ROOT, 'scripts/lib'), join(BASE, 'scripts/lib'), { recursive: true });
process.on('exit', () => { try { rmSync(BASE, { recursive: true, force: true }); } catch { /* 정리 실패가 판정을 바꾸지 않는다 */ } });

const PROBE = join(BASE, 'src/app/api/zz-probe/order');

function run(file, cwd = BASE) {
  const r = spawnSync(process.execPath, [file], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** `globSync` 분기를 끈 사본 — `globSync`가 없는 런타임을 흉내 낸다 */
function variant(name, transform = (s) => s) {
  const rel = `scripts/${name}.mjs`;
  writeFileSync(join(BASE, rel), transform(SOURCE));
  return rel;
}

function withProbe(fn) {
  try {
    mkdirSync(PROBE, { recursive: true });
    writeFileSync(join(PROBE, 'route.ts'),
      'import { NextResponse } from "next/server";\n'
      + 'export async function POST() { return NextResponse.json({ ok: true }); }\n');
    return fn();
  } finally {
    rmSync(join(BASE, 'src/app/api/zz-probe'), { recursive: true, force: true });
  }
}

const NO_GLOB = (s) => s.replaceAll("typeof fs.globSync === 'function'", 'false');

test('양성 대조 — 손대지 않은 저장소는 초록이고 주문 경로를 실제로 세었다', () => {
  const r = run(join(ROOT, CHECKER), ROOT);
  assert.equal(r.code, 0, `빨강입니다:\n${r.err.slice(0, 500)}`);
  const m = /실주문 경로 (\d+)개/.exec(r.out);
  assert.ok(m, `경로 개수를 찍지 않았습니다: ${r.out.slice(0, 200)}`);
  assert.ok(Number(m[1]) > 0, '실주문 경로를 0개로 셌습니다');
});

test('★ glob이 없어도 목록 밖 주문 경로를 잡는다 (예전에는 빈 배열로 통과했다)', () => {
  const v = variant('og-noglob', NO_GLOB);
  withProbe(() => {
    const r = run(join(BASE, v));
    assert.notEqual(r.code, 0, 'glob 없이 돌 때 목록 밖 주문 경로를 놓쳤습니다');
    assert.match(r.err, /zz-probe/, '어느 경로인지 말하지 않습니다');
  });
});

test('glob이 있을 때도 잡는다 (원래 동작의 회귀)', () => {
  withProbe(() => {
    const r = run(join(BASE, variant('og-plain')));
    assert.notEqual(r.code, 0);
    assert.match(r.err, /zz-probe/);
  });
});

test('glob이 없고 위반도 없으면 통과한다 — 잘못 막으면 그것도 고장이다', () => {
  const r = run(join(BASE, variant('og-noglob2', NO_GLOB)));
  assert.equal(r.code, 0, `위반이 없는데 막았습니다:\n${r.err.slice(0, 500)}`);
  assert.match(r.out, /실주문 경로 \d+개/);
});

test('★ 발견이 통째로 비면 빨강이다 — 훑지 않은 것을 "0개"로 적지 않는다', () => {
  const v = variant('og-empty', (s) => NO_GLOB(s)
    .replaceAll("walkFiles('src/app/api'", "walkFiles('src/app/NOPE'")
    .replaceAll("walkFiles('src/lib/markets'", "walkFiles('src/lib/NOPE1'")
    .replaceAll("walkFiles('src/lib/engine'", "walkFiles('src/lib/NOPE2'"));
  const r = run(join(BASE, v));
  assert.notEqual(r.code, 0, '발견이 0건인데 통과했습니다');
  assert.match(r.err, /하나도 찾지 못했습니다/);
  assert.match(r.err, /0건을 통과로 적지 않습니다/);
  assert.doesNotMatch(r.out, /안전장치 빠진 것 0개/, '아무것도 안 훑고 통과 문장을 찍었습니다');
});
