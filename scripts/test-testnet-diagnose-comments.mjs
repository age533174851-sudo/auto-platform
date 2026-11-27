// scripts/test-testnet-diagnose-comments.mjs
//
// **TESTNET 진단 검사기의 금지 앵커가 주석 한 번에 눈을 감지 않는다.**
//
// 전에 `check-testnet-diagnose.mjs`는 주석을 직접 걷었다:
//
//     .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
//
// 인용부호를 모르므로 **문자열 안의 `//`에서도** 잘랐다. URL 한 개가 그
// 줄의 나머지를 먹었고, 그 뒤에 숨은 것은 **읽기만 해야 하는 진단이
// 배율·마진 모드를 고치는 코드**였다. 이 검사기의 ①이 막으려던 바로
// 그것이다.
//
// 그래서 ★ 둘이 이 시험의 핵심이고, 나머지는 대조다:
//   · 금지 앵커가 애초에 동작하는가 (동작하지 않으면 ★는 의미가 없다)
//   · 원인이 `//`인가 (`//` 없는 문자열이면 원래도 막았다)
//   · 좁히는 대가가 0인가 (원문 복사본은 그대로 통과한다)

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { stripJsComments } from './lib/strip-comments.mjs';

const ROOT = process.cwd();
const CHECKER = join(ROOT, 'scripts', 'check-testnet-diagnose.mjs');
const PREFIX = 'tnd-cmt-';

// 검사기가 읽는 파일은 이 셋뿐이다. 그래서 `src` 20MB를 복사하지 않고
// 이 셋만 실체로 두고 나머지는 심볼릭 링크로 둔다.
const V = 'src/lib/engine/testnetDiagnoseVerdict.ts';
const ROUTE = 'src/app/api/binance/futures/diagnose/route.ts';
const FUT = 'src/lib/exchanges/binanceFutures.ts';
const READS = [V, ROUTE, FUT];

const ANCHOR = 'export async function POST(req: NextRequest) {';

/** 격리 사본을 만든다. `mutate(dir)`로 한 줄 끼워 넣는다. */
function fixture(mutate) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  // 검사기는 `process.cwd()/node_modules/typescript/bin/tsc`를 쓴다.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  for (const rel of READS) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(ROOT, rel), 'utf8'));
  }
  if (mutate) mutate(dir);
  return dir;
}

/** 라우트의 POST 본문 첫 줄에 `line`을 끼운다. */
const injectRoute = (line) => (dir) => {
  const p = join(dir, ROUTE);
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes(ANCHOR), '기준점이 사라졌다 — 시험을 고쳐야 한다');
  writeFileSync(p, src.replace(ANCHOR, `${ANCHOR}\n${line}`));
};

/** 검사기를 그 사본 위에서 돌린다. 종료 코드를 돌려준다. */
function runIn(dir) {
  try {
    execFileSync(process.execPath, [CHECKER], { cwd: dir, stdio: 'pipe', timeout: 300_000 });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

function withFixture(mutate, fn) {
  const dir = fixture(mutate);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  assert.equal(withFixture(null, runIn), 0);
});

test('대조 — 금지 호출을 평범하게 넣으면 막는다 (금지 앵커가 동작하는가)', () => {
  const line = '  const _x1 = () => setFuturesLeverage(1);';
  assert.equal(withFixture(injectRoute(line), runIn), 1,
    '금지 앵커가 동작하지 않는다 — 아래 ★ 시험은 의미가 없다');
});

test('★ 같은 줄 앞에 URL 문자열이 있어도 금지 호출을 본다', () => {
  const line = "  const _u2 = 'https://binance-docs.github.io/apidocs/';"
    + ' const _x2 = () => setFuturesLeverage(1);';
  assert.equal(withFixture(injectRoute(line), runIn), 1,
    'URL 한 개가 설정 변경 호출을 가렸다 — 진단이 읽기 전용이라는 보장이 깨진다');
});

test('대조 — `//` 없는 문자열이면 원래도 막았다 (원인이 `//`라는 대조)', () => {
  const line = "  const _u3 = 'plain-no-slash'; const _x3 = () => setFuturesLeverage(1);";
  assert.equal(withFixture(injectRoute(line), runIn), 1);
});

test('대조 — 금지 경로 문자열을 평범하게 넣으면 막는다', () => {
  const line = "  const _y1 = '/fapi/v1/marginType';";
  assert.equal(withFixture(injectRoute(line), runIn), 1);
});

test('★ URL 뒤에 숨은 금지 경로 문자열도 본다', () => {
  const line = "  const _u4 = 'https://x/y'; const _y2 = '/fapi/v1/marginType';";
  assert.equal(withFixture(injectRoute(line), runIn), 1,
    'URL 한 개가 마진 모드 변경 경로를 가렸다');
});

test('대조 — 공용 제거기가 URL·정규식·나눗셈을 먹지 않는다', () => {
  assert.ok(stripJsComments("const u = 'https://x/y'; const k = 1;").includes('const k = 1;'));
  assert.ok(stripJsComments('const r = /a\\/\\/b/; const k = 2;').includes('const k = 2;'));
  assert.ok(stripJsComments('const d = a / b / c; const k = 3;').includes('const k = 3;'));
  // 진짜 주석은 그대로 걷는다.
  assert.equal(stripJsComments('const k = 4; // 설명').trim(), 'const k = 4;');
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  withFixture(null, runIn);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  assert.equal(after, before, `임시 폴더가 늘었다 (${before} → ${after})`);
});
