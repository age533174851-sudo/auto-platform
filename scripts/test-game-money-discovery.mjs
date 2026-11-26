// scripts/test-game-money-discovery.mjs
//
// **`check-game-money`가 훑지 못한 것을 "비침투"로 적지 않는지 못 박는다.**
//
// 그 검사기가 지키는 것은 "게임머니는 표시 단위이고 회계 단위가 아니다"다.
// 서버·엔진 쪽 어디에도 표시 함수가 들어오면 안 된다 — `src/app/api` ·
// `src/lib/engine` · `worker/src` 세 뿌리를 훑어서 확인한다.
//
// 그런데 그 훑기가 `catch { return out; }`이었다. 뿌리 하나를 읽지 못하면
// 그 아래가 전부 검사 밖으로 나가고, 집계는 그대로 "주문 본문·엔진
// 비침투"를 적었다. 세 뿌리에는 고정 경로 읽기가 걸쳐 있지 않아서
// (고정 읽기는 `src/lib/trading`·`src/components/trading` 쪽이다) 아무도
// 눈치채지 못한다.
//
// 실측했다 (main ed00c1a4):
//
//   worker/src/zzprobe/bad.ts 가 gameMoney를 import  → ❌ rc=1  (맞다)
//   같은 파일을 둔 채 그 뿌리 경로만 바꿈            → ✅ rc=0
//
// 그 검사기 자신이 바로 아래에서 빈 `bodyBlock`을 잡으며 적어 둔 문장이
// 이것이다 — **"살아 있는 척하는 검사가 제일 나쁘다."** 한쪽에만 그
// 단언이 있었다.
//
// 저장소를 건드리지 않는다. 검사기가 읽는 고정 파일 셋만 복제하고 세
// 뿌리는 임시 디렉터리 안에 새로 만든다.
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-game-money.mjs');

/** 검사기가 고정 경로로 읽는 파일 — 내용이 규칙을 만족해야 하므로 실제 것을 쓴다 */
const FIXED = [
  'src/lib/trading/gameMoney.ts',
  'src/lib/trading/useTradeForm.ts',
  'src/components/trading/OrderControls.tsx',
];

/** 훑는 세 뿌리. 위반이 없는 평범한 파일을 하나씩 둔다 */
const ROOTS = {
  'src/app/api/zzhealth/route.ts': 'export async function GET() { return new Response("ok"); }\n',
  'src/lib/engine/zzplan.ts': 'export const planned = true;\n',
  'worker/src/index.ts': 'export const workerEntry = 1;\n',
};

function runChecker(cwd) {
  const r = spawnSync(process.execPath, [CHECKER], { cwd, encoding: 'utf8' });
  return { rc: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function withTree(extra, fn, opts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'gamemoney-'));
  const write = (rel, body) => {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  try {
    for (const rel of FIXED) {
      mkdirSync(dirname(join(base, rel)), { recursive: true });
      cpSync(join(ROOT, rel), join(base, rel));
    }
    for (const [rel, body] of Object.entries(ROOTS)) {
      if ((opts.skip ?? []).includes(rel)) continue;
      write(rel, body);
    }
    for (const [rel, body] of Object.entries(extra)) write(rel, body);
    return fn(base);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

const IMPORTS_GAME_MONEY =
  "import { formatGameMoney } from '../../src/lib/trading/gameMoney';\nexport const x = formatGameMoney;\n";

test('양성 대조 — 깨끗한 트리는 초록이다', () => {
  withTree({}, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 0, `초록이어야 합니다:\n${r.err}${r.out}`);
  });
});

test('worker/src가 표시 함수를 불러오면 빨강이다 (원래 동작의 회귀)', () => {
  withTree({ 'worker/src/zzbad.ts': IMPORTS_GAME_MONEY }, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, '통과했습니다');
    assert.match(r.err, /zzbad\.ts/);
  });
});

test('★ 훑지 못한 뿌리는 이름을 적고 빨강이다 (예전에는 조용히 통과했다)', () => {
  // worker/src가 아예 없다. 예전에는 `catch { return out; }`이 삼켜서
  // "주문 본문·엔진 비침투"를 그대로 적었다.
  withTree({}, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, `빨강이어야 합니다:\n${r.out}`);
    assert.match(r.err, /훑지 못한 디렉터리/);
    assert.match(r.err, /worker\/src/);
    assert.doesNotMatch(r.out, /엔진 비침투/, '빨강인데 통과 문장을 찍었습니다');
  }, { skip: ['worker/src/index.ts'] });
});

test('★ 뿌리에서 읽은 파일이 0개면 빨강이다 — 0을 "비침투"로 적지 않는다', () => {
  // 뿌리는 있는데 `.ts`가 하나도 없다. 경로가 바뀐 모습이다.
  withTree({ 'worker/src/README.md': '옮겼습니다\n' }, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, `빨강이어야 합니다:\n${r.out}`);
    assert.match(r.err, /읽은 파일이 0개/);
    assert.match(r.err, /worker\/src/);
  }, { skip: ['worker/src/index.ts'] });
});

test('★ 집계가 뿌리별 개수를 적는다 — 한 뿌리가 0으로 떨어진 것이 보여야 한다', () => {
  withTree({}, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 0, `초록이어야 합니다:\n${r.err}`);
    assert.match(r.out, /src\/app\/api 1개/);
    assert.match(r.out, /src\/lib\/engine 1개/);
    assert.match(r.out, /worker\/src 1개/);
    assert.match(r.out, /훑지 못한 디렉터리 0/);
  });
});

test('실제 저장소도 초록이다 — 가짜 트리가 현실과 갈라지지 않았는지 본다', () => {
  const r = runChecker(ROOT);
  assert.equal(r.rc, 0, `실제 저장소가 빨강입니다:\n${r.err}${r.out}`);
});
