// scripts/test-browser-orders-comments.mjs
//
// **타이머가 내는 주문이 주석 한 개 뒤에 숨지 않는다.**
//
// `check-browser-orders.mjs` 가 막으려는 것은 그 파일이 적어 둔 그대로다 —
// 사람이 누르는 주문은 "보고 있고, 한 번이고, 실패하면 바로 안다"지만
// **타이머는 아무도 안 볼 때 반복해서 낸다.** 그리고 결과도 적혀 있다:
// "탭을 닫으면 진입한 포지션을 아무도 청산하지 않습니다."
//
// 그런데 주석 필터가 **줄머리만** 봤다:
//
//     if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
//         || t.startsWith('{/*')) return;
//
// 줄머리가 그 모양이면 그 줄의 **나머지 진짜 코드까지** 버렸다. TSX 에서
// `{/* … */}` 는 주석을 쓰는 평범한 방법이라 사고로도 생긴다.
//
// ★ 가 그 셋이고 나머지는 대조다. 좁히다가 **맞는 통과**(줄 전체가 주석인
// 경우, 블록 주석 가운데 줄에 적어 둔 코드)를 막지 않았는지도 잠근다.
//
// **아직 열려 있는 경계 하나** — 별표 없는 여러 줄 주석 본문에 적어 둔
// 호출은 지금도 호출로 세어진다(과대검출):
//
//     /* 메모
//     void fetch('/api/binance/futures/order');
//     */
//
// 줄마다 따로 걷기 때문에 블록 주석 상태가 다음 줄로 넘어가지 않는다.
// main 에서도 같고, 방향은 **닫히는 쪽**(없는 호출을 있다고 말한다)이라
// 포지션이 새지는 않는다. 여기에 시험을 걸지 않는다 — 지금 동작을 잠그면
// 줄바꿈을 보존하는 공용 제거기(#795)가 들어올 때 거짓 빨강이 된다.
// 0으로 적지 않기 위해 적어 둔다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const CHECKER = join(ROOT, 'scripts', 'check-browser-orders.mjs');
const PREFIX = 'bo-cmt-';

// 탐침 파일은 훑는 글롭(`src/**/*.tsx`) 안에 있어야 한다.
const PROBE = 'src/components/ZzProbeRogue.tsx';
const EP = '/api/binance/futures/order';

/**
 * 격리 사본. `src` 는 **실제 디렉터리 + 파일 심볼릭 링크**로 비춘다.
 *
 * 이 검사기는 `globSync('src/**\/*.tsx')` 로 훑고, 면제 목록
 * (`MANUAL_ORDER_OK`)의 파일이 **사라지면 실패**한다. 그래서 src 전체가
 * 보여야 한다. 디렉터리를 심볼릭 링크로 두면 glob 이 따라 들어가지 못해
 * **엉뚱한 이유로** 빨개진다.
 */
function mirror(absDir, absDest) {
  mkdirSync(absDest, { recursive: true });
  for (const e of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, e.name);
    if (e.isDirectory()) mirror(abs, join(absDest, e.name));
    else symlinkSync(abs, join(absDest, e.name));
  }
}

/** `bodyLine` 을 setInterval 안에 넣은 탐침 파일을 만든다. null 이면 안 만든다. */
function fixture(bodyLine) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    if (e.name === 'src') { mirror(join(ROOT, 'src'), join(dir, 'src')); continue; }
    symlinkSync(join(ROOT, e.name), join(dir, e.name));
  }
  if (bodyLine != null) {
    writeFileSync(join(dir, PROBE), `'use client';
import { useEffect } from 'react';

export default function ZzProbeRogue() {
  useEffect(() => {
    const id = setInterval(() => {
${bodyLine}
    }, 60000);
    return () => clearInterval(id);
  }, []);
  return <div>probe</div>;
}
`);
  }
  return dir;
}

function runIn(dir) {
  try {
    execFileSync(process.execPath, [CHECKER], { cwd: dir, stdio: 'pipe', timeout: 300_000 });
    return { rc: 0, out: '' };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function withFixture(bodyLine, fn) {
  const dir = fixture(bodyLine);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const CAUGHT = '타이머와 주문 경로';

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  const r = withFixture(null, runIn);
  assert.equal(r.rc, 0, r.out.slice(-400));
});

test('대조 — 타이머 안에서 주문 경로를 평범하게 부르면 막는다 (금지가 동작하는가)', () => {
  const r = withFixture(`      void fetch('${EP}', { method: 'POST' });`, runIn);
  assert.equal(r.rc, 1, '금지가 동작하지 않는다 — 아래 ★ 시험은 의미가 없다');
  assert.ok(r.out.includes(CAUGHT), '다른 이유로 빨개졌다');
});

test('★ 줄머리 JSX 주석 `{/* */}` 뒤의 진짜 호출을 본다', () => {
  const r = withFixture(
    `      {/* 메모 */} void fetch('${EP}', { method: 'POST' });`, runIn);
  assert.equal(r.rc, 1,
    'JSX 주석 한 개가 타이머 주문을 가렸다 — 탭을 닫으면 아무도 청산하지 않는다');
  assert.ok(r.out.includes(CAUGHT), '막기는 했는데 다른 판정이 울렸다');
});

test('★ 줄머리 블록 주석 `/* */` 뒤의 진짜 호출을 본다', () => {
  const r = withFixture(
    `      /* 메모 */ void fetch('${EP}', { method: 'POST' });`, runIn);
  assert.equal(r.rc, 1, '블록 주석 한 개가 타이머 주문을 가렸다');
  assert.ok(r.out.includes(CAUGHT), '막기는 했는데 다른 판정이 울렸다');
});

test('대조 — 줄 전체가 `//` 주석이면 통과한다 (과대검출로 가지 않았다)', () => {
  const r = withFixture(
    `      // void fetch('${EP}', { method: 'POST' });`, runIn);
  assert.equal(r.rc, 0, `좁히다가 주석까지 호출로 셌다\n${r.out.slice(-300)}`);
});

test('★ 여러 줄 주석의 **닫는 줄** 뒤의 진짜 호출을 본다', () => {
  // `*/` 뒤에는 진짜 코드가 올 수 있다. `*` 로 시작하는 줄을 통째로 버리면
  // 그 호출이 사라진다 — **숨는 쪽**이다. 검수에서 지적받아 측정했고,
  // 고치기 전 검사기와 첫 수정 모두 못 잡았다(main 과 같은 경계였다).
  const r = withFixture(
    `      /* 메모\n       */ void fetch('${EP}', { method: 'POST' });`, runIn);
  assert.equal(r.rc, 1, '닫는 줄 뒤의 타이머 주문이 숨었다');
  assert.ok(r.out.includes(CAUGHT), '막기는 했는데 다른 판정이 울렸다');
});

test('대조 — 블록 주석 가운데 줄(` * …`)에 적어 둔 코드는 세지 않는다', () => {
  const r = withFixture(
    `      /*\n       * void fetch('${EP}');\n       */`, runIn);
  assert.equal(r.rc, 0, `좁히다가 블록 주석 본문을 호출로 셌다\n${r.out.slice(-300)}`);
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  withFixture(null, runIn);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  assert.equal(after, before, `임시 폴더가 늘었다 (${before} → ${after})`);
});
