// scripts/test-venue-ids-discovery.mjs
//
// **`check-venue-ids`가 훑지 않은 것을 "없음"으로 적지 않는지 못 박는다.**
//
// 그 검사기가 막는 고장은 2026-08-16에 실제로 났다 — Gate 조건부 주문
// 번호가 `JSON.parse`에서 뭉개져(`…685400` · `…978500`) 취소가 전부
// `400 No order found`로 돌아왔고, 포지션은 0인데 보호주문 2건이 남았다.
//
// 그런데 그 검사기의 훑기는 `readdirSync` 한 겹이었다. 하위 폴더가 하나
// 생기면 그 아래는 전부 검사 밖으로 나가고, 집계는 그대로 "전부 lossless
// 파서로 읽습니다"라고 적었다 (실측: main ed00c1a4).
//
// 여기서 보는 것은 다섯 가지다:
//
//   · 깨끗한 트리는 초록이다 (잘못 막으면 그것도 고장이다)
//   · 바로 아래의 `.json()`은 여전히 빨강이다 (원래 동작의 회귀)
//   · **하위 폴더** 안의 위반도 빨강이다 ← 고친 것
//   · 대상 `.ts`가 **0개인 디렉터리**가 있으면 빨강이다 ← 고친 것
//   · **훑지 못한 디렉터리**는 이름을 적고 빨강이다 ← 고친 것
//     (예전에도 종료코드는 0이 아니었지만 스택만 뱉었다 — 어느
//      디렉터리인지, 왜 통과가 아닌지는 말하지 않았다)
//
// 저장소를 건드리지 않는다. 검사기가 보는 것만 갖춘 작은 가짜 트리를
// 임시 디렉터리에 세우고 거기서만 돈다.
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-venue-ids.mjs');

function runChecker(cwd) {
  const r = spawnSync(process.execPath, [CHECKER], { cwd, encoding: 'utf8' });
  return { rc: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** 깨끗한 최소 트리 — 검사기가 보는 세 디렉터리에 위반 없는 파일을 둔다 */
const CLEAN_EXCHANGE = `import { parseLossless } from './losslessJson';
export async function fetchOrder(r: Response) {
  return parseLossless(await r.text());
}
`;

function makeTree(extra = {}, skip = []) {
  const base = mkdtempSync(join(tmpdir(), 'venueids-'));
  const write = (rel, body) => {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  const files = {
    'src/lib/exchanges/binanceClient.ts': CLEAN_EXCHANGE,
    // 파서 자신은 면제다 — 여기가 유일하게 JSON.parse를 부르는 곳이다.
    // **면제는 이 두 경로 그대로**이고, 검사기는 둘이 실재하는지도 본다.
    'src/lib/exchanges/losslessJson.ts':
      'export function parseLossless(t: string) { return JSON.parse(t); }\n',
    'src/lib/exchanges/losslessJson.test.ts':
      "import { parseLossless } from './losslessJson';\nexport const t = parseLossless('{}');\n",
    'src/lib/engine/orderExecutor.ts':
      'export function idOf(o: { order_id: string }) { return o.order_id; }\n',
    'src/lib/smoke/runSmoke.ts':
      'export function go(o: { order_id: string }) { return String(o.order_id); }\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    if (skip.includes(rel)) continue;
    write(rel, body);
  }
  for (const [rel, body] of Object.entries(extra)) write(rel, body);
  return base;
}

function withTree(extra, fn, opts = {}) {
  const base = makeTree(extra, opts.skip ?? []);
  try {
    if (opts.emptyDir) mkdirSync(join(base, opts.emptyDir), { recursive: true });
    return fn(base);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

const JSON_READER = `export async function f(r: Response) {
  const body = await r.json();
  return body;
}
`;
const NUMBER_ID = `export function f(o: { order_id: string }) {
  return Number(o.order_id);
}
`;

test('양성 대조 — 깨끗한 트리는 초록이고 읽은 파일 수를 적는다', () => {
  withTree({}, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 0, `초록이어야 합니다:\n${r.err}${r.out}`);
  });
});

test('바로 아래의 .json()은 빨강이다 (원래 동작의 회귀)', () => {
  withTree({ 'src/lib/exchanges/zzFlat.ts': JSON_READER }, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, '통과했습니다');
    assert.match(r.err, /zzFlat\.ts/);
  });
});

test('★ exchanges 하위 폴더의 .json()을 잡는다 (예전에는 한 겹만 봤다)', () => {
  withTree({ 'src/lib/exchanges/zzsub/deep.ts': JSON_READER }, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, '하위 폴더의 위반을 통과시켰습니다');
    assert.match(r.err, /zzsub\/deep\.ts/, '어느 파일인지 말하지 않습니다');
    assert.doesNotMatch(r.out, /새는 곳 없음/, '빨강인데 통과 문장을 찍었습니다');
  });
});

test('★ engine 하위 폴더의 Number(order_id)를 잡는다', () => {
  withTree({ 'src/lib/engine/zzsub/deep.ts': NUMBER_ID }, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, '하위 폴더의 위반을 통과시켰습니다');
    assert.match(r.err, /zzsub\/deep\.ts/);
    assert.doesNotMatch(r.out, /새는 곳 없음/);
  });
});

test('★ 대상 .ts가 0개인 디렉터리가 있으면 빨강이다 — 0을 "없음"으로 적지 않는다', () => {
  // smoke 디렉터리는 있는데 `.ts`가 하나도 없다. 경로가 바뀐 모습이고,
  // 읽은 것이 0이면 "새는 곳 없음"은 참이 아니라 아직 모른다는 뜻이다.
  withTree({ 'src/lib/smoke/README.md': '옮겼습니다\n' }, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, `0개인 디렉터리를 통과시켰습니다:\n${r.out}`);
    assert.match(r.err, /0개인 디렉터리/);
    assert.match(r.err, /src\/lib\/smoke/);
  }, { skip: ['src/lib/smoke/runSmoke.ts'] });
});

test('★ 훑지 못한 디렉터리는 이름을 적고 빨강이다 (예전에는 스택만 뱉었다)', () => {
  withTree({}, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, '없는 디렉터리를 통과시켰습니다');
    assert.match(r.err, /훑지 못한 디렉터리/, '어느 디렉터리인지, 왜 통과가 아닌지 말하지 않습니다');
    assert.match(r.err, /src\/lib\/smoke/);
  }, { skip: ['src/lib/smoke/runSmoke.ts'] });
});

test('실제 저장소도 초록이다 — 가짜 트리가 현실과 갈라지지 않았는지 본다', () => {
  const r = runChecker(ROOT);
  assert.equal(r.rc, 0, `실제 저장소가 빨강입니다:\n${r.err}${r.out}`);
});

test('★ 하위 폴더에서 파일 이름만 losslessJson.ts여도 빨강이다 (면제는 정식 경로 하나)', () => {
  // 훑기를 재귀로 넓히면서 면제를 `basename`으로 비교하면, 아무 하위
  // 폴더에서나 같은 이름을 쓰는 것으로 관문을 비켜 갈 수 있다. 실측으로
  // 확인된 구멍이다 — 정규식과 면제 문자열이 같아도 **적용 범위가**
  // 달라졌다.
  withTree({ 'src/lib/exchanges/zzallow/losslessJson.ts': JSON_READER }, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, '이름만 같은 하위 파일을 면제했습니다');
    assert.match(r.err, /zzallow\/losslessJson\.ts/, '어느 파일인지 말하지 않습니다');
    assert.doesNotMatch(r.out, /새는 곳 없음/);
  });
});

test('정식 파서 자신은 계속 면제된다 — 잘못 막으면 그것도 고장이다', () => {
  // `src/lib/exchanges/losslessJson.ts`는 저장소에서 유일하게
  // JSON.parse를 부르는 곳이다. 면제를 좁히다가 이것까지 막으면 안 된다.
  withTree({}, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 0, `정식 파서를 막았습니다:\n${r.err}`);
  });
});

test('★ 면제 경로가 사라지면 빨강이다 — 낡은 면제는 아무것도 가리키지 않는다', () => {
  // 파서를 옮기면 면제는 없는 파일을 가리킨다. 그대로 두면 다음 사람은
  // "파서는 면제돼 있다"고 믿는데, 그 자리에 다른 파일이 올 수 있다.
  withTree({}, (base) => {
    rmSync(join(base, 'src/lib/exchanges/losslessJson.test.ts'));
    const r = runChecker(base);
    assert.equal(r.rc, 1, `낡은 면제를 통과시켰습니다:\n${r.out}`);
    assert.match(r.err, /면제 목록에 있는데 파일이 없습니다/);
    assert.match(r.err, /losslessJson\.test\.ts/);
  });
});
