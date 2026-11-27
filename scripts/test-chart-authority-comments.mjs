// scripts/test-chart-authority-comments.mjs
//
// **차트 권위 관문이 "적혀 있는 것"에 속지 않는가.**
//
// `check-chart-authority.mjs` 의 `code()` 는 **줄머리만** 뗐다
// (`/^\s*(\/\/|\*|\/\*)/`). 기계 탐침으로 실제로 돌려 두 가지를 봤다.
//
//   ① 꼬리 주석이 코드로 셌다 — 요구 앵커 세 자리가 뚫렸다
//        if (!disposed) zetChartEpoch(n => n + 1); // setChartEpoch(
//      실제 호출은 사라졌는데 `setChartEpoch\s*\(` 가 주석에 맞아 통과했다.
//      `isFreshResponse` 두 곳, 정본 봉 `fetch` 주소도 같은 모양으로 샜다.
//
//   ② 줄머리 `*` 가 **실행되는 코드**를 버렸다 — 금지 앵커가 뚫렸다
//        if (!disposed) setChartEpoch(n => n
//              + 1
//              * Math.random());
//      연산자로 시작하는 줄이라 통째로 버려져서, 차트가 진짜 난수를 쓰는데도
//      ①("값을 만들지 않는다")이 통과했다. 주석이 아니라 코드를 못 본
//      것이라 이쪽이 더 나쁘다.
//
// 네 변이 모두 TS 구문 유효였고(저장소 TypeScript 파서로 확인), 이름만
// 바꾸면 rc=1 이라 앵커는 필요한 것이 맞았다 — 보는 눈이 문제였다.
//
// 이 검사기는 **URL 자체를 앵커로 요구한다**
// (`api.binance.com/api/v3/klines` — `venueBars.ts` 의 템플릿 안). 주석을
// 줄 안에서 떼면서 그 URL 이 살아남는지를 같이 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripJsComments } from './lib/strip-comments.mjs';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-chart-authority.mjs');
const CHART = 'src/components/trading/PriceChart.tsx';
const PREFIX = 'ca-cmt-';

/** 이 시험이 만든 임시 폴더만 센다 (다른 접두사는 세지 않는다) */
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

const EPOCH = 'if (!disposed) setChartEpoch(n => n + 1);';
const FRESH = 'if (!alive || !isFreshResponse(gen, genRef.current)) return;';
const URL_LINE = '`/api/market/candles?symbol=${encodeURIComponent(symbol)}`';

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  assert.equal(runChecker(null).rc, 0);
});

test('대조 — setChartEpoch 이름을 바꾸면 막는다 (앵커가 필요하긴 한가)', () => {
  const r = runChecker((p) => edit(p(CHART), (s) =>
    s.replace(EPOCH, EPOCH.replace('setChartEpoch', 'zetChartEpoch'))));
  assert.notEqual(r.rc, 0, '차트 준비 알림 호출을 지웠는데 통과했습니다');
});

test('★ setChartEpoch 를 바꾸고 원래 이름을 꼬리 주석에 남기면 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(CHART), (s) =>
    s.replace(EPOCH, `${EPOCH.replace('setChartEpoch', 'zetChartEpoch')} // setChartEpoch(`)));
  assert.notEqual(r.rc, 0, '꼬리 주석이 살아 있는 호출로 셌습니다');
  console.log('    거부 확인 · setChartEpoch 를 꼬리 주석으로');
});

test('★ isFreshResponse 두 곳을 꼬리 주석으로 옮겨도 세대 확인 2곳으로 세지 않는다', () => {
  // 여기는 **개수**를 센다(`guards < 2`). 두 줄을 같이 바꿔도 주석 두 개가
  // 2곳으로 세어지면, 가드를 다 지운 코드가 "성공·실패 경로 둘 다 지켰다"가 된다.
  const r = runChecker((p) => edit(p(CHART), (s) =>
    s.replaceAll(FRESH, `${FRESH.replace('isFreshResponse', 'zsFreshResponse')} // isFreshResponse(`)));
  assert.notEqual(r.rc, 0, '주석 두 개를 요청 세대 확인 두 곳으로 셌습니다');
  console.log('    거부 확인 · isFreshResponse 두 곳을 꼬리 주석으로');
});

test('★ 정본 봉 주소를 바꾸고 꼬리 주석에 남겨도 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(CHART), (s) =>
    s.replace(URL_LINE, `${URL_LINE.replace('/api/market/', '/api/zarket/')} // fetch(\`/api/market/candles`)));
  assert.notEqual(r.rc, 0, '정본 봉 라우트를 안 부르는데 주석으로 통과했습니다');
  console.log('    거부 확인 · 봉 fetch 주소를 꼬리 주석으로');
});

test('★ 줄머리가 `*` 인 줄의 실제 Math.random() 을 놓치지 않는다 (금지 앵커)', () => {
  // 주석이 아니라 **실행되는 코드**다. 연산자로 줄을 시작했을 뿐이다.
  const r = runChecker((p) => edit(p(CHART), (s) =>
    s.replace(EPOCH, 'if (!disposed) setChartEpoch(n => n\n        + 1\n        * Math.random());')));
  assert.notEqual(r.rc, 0, '차트가 실제로 난수를 쓰는데 통과했습니다');
  assert.match(r.out, /난수/);
  console.log('    거부 확인 · `*` 로 시작하는 줄의 실행되는 Math.random()');
});

test('대조 — 이 검사기가 요구하는 URL 앵커는 제거기를 지나도 살아 있다', () => {
  // 줄머리만 떼던 이유가 "`https://`가 같이 잘린다"였다. 공용 제거기는
  // 인용부호·템플릿·정규식을 알고 걷으므로 그 일이 일어나지 않는다.
  for (const src of [
    'url: `https://api.binance.com/api/v3/klines?${q}`,',
    'url: `${i.futuresHost}/fapi/v1/klines?${q}`,',
    "const u = 'https://fapi.binance.com/fapi/v1/ticker/price';",
    "const r = /a\\/\\/b/; const y = 'klines';",
  ]) {
    assert.equal(stripJsComments(src), src, `URL·정규식이 잘렸습니다: ${src}`);
  }
  // 그러면서 꼬리 주석은 떼고, 나눗셈을 주석으로 오인하지 않는다
  assert.equal(stripJsComments('const x = 1; // setChartEpoch('), 'const x = 1; ');
  assert.equal(stripJsComments('const z = a / b; // x'), 'const z = a / b; ');
  // 연산자로 시작하는 줄은 코드로 남는다 — 위 ★ 가 기대는 성질이다
  assert.match(stripJsComments('  + 1\n  * Math.random());'), /Math\.random/);
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = new Set(ownTempDirs());
  runChecker(null);
  assert.deepEqual(ownTempDirs().filter((n) => !before.has(n)), []);
});
