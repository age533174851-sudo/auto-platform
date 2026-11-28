// scripts/test-status-claims-self-exempt.mjs
//
// **검사기 이름을 적는 것이 면제가 되지 않는다.**
//
// `check-status-claims.mjs` 가 막는 것은 그 파일이 적어 둔 그대로다 —
// "검증할 수 없는 형태로 참을 적어 두면, 거짓이 되는 순간을 아무도
// 모른다." 상태판에 적힌 `main = Vercel = Fly = 3c46151 · MATCHED ·
// Worker alive` 가 실제로 그렇게 늙었다.
//
// 그런데 면제가 **줄 단위**였다:
//
//     if (/check-status-claims/.test(line)) return out;
//
// 자기 이름을 적으면 그 줄의 늙는 문장이 **셋 다** 안 보였다. 지금은
// 줄을 버리지 않고 **그 말만 지운다** — 상태판은 여전히 "이 규칙은
// `check-status-claims`가 지킨다"처럼 검사기를 가리킬 수 있다.
//
// ★ 가 그 자리이고 나머지는 대조다. 좁히면서 **치른 대가**(`실측 주장`
// 같은 메타 표현을 실측 주장으로 세지 않는 것)도 대조로 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const CHECKER = join(ROOT, 'scripts', 'check-status-claims.mjs');
const PREFIX = 'sc-exempt-';
const DOC = 'FULL_COMPLETION_STATUS.md';

// 늙는 문장 셋이 한 줄에 다 들어 있다: SHA · 생존 단정 · 날짜 없는 실측.
const AGING = '- 실측 main = Vercel = Fly = 3c46151 이고 Fly Worker alive 다';

/** 검사기는 cwd 의 `FULL_COMPLETION_STATUS.md` 하나만 읽는다. */
function fixture(extraLines, { withDoc = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  if (withDoc) {
    const base = readFileSync(join(ROOT, DOC), 'utf8');
    writeFileSync(join(dir, DOC), extraLines ? `${base}\n${extraLines}\n` : base);
  }
  return dir;
}

function runIn(dir) {
  try {
    const out = execFileSync(process.execPath, [CHECKER], { cwd: dir, stdio: 'pipe', timeout: 120_000 });
    return { rc: 0, out: out.toString() };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function withFixture(extraLines, opts, fn) {
  const dir = fixture(extraLines, opts);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const THREE = ['커밋 SHA', '런타임 상태 단정', '언제 쟀는지 없는 실측 주장'];

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  const r = withFixture(null, {}, runIn);
  assert.equal(r.rc, 0, r.out.slice(-400));
});

test('대조 — 늙는 문장을 평범하게 넣으면 세 규칙이 다 걸린다', () => {
  const r = withFixture(AGING, {}, runIn);
  assert.equal(r.rc, 1, '규칙이 동작하지 않는다 — 아래 ★ 시험은 의미가 없다');
  for (const w of THREE) assert.ok(r.out.includes(w), `${w} 가 걸리지 않았다`);
});

test('★ 같은 줄에 `check-status-claims` 가 있어도 막는다', () => {
  const r = withFixture(`${AGING} (check-status-claims 예시)`, {}, runIn);
  assert.equal(r.rc, 1,
    '자기 이름 한 번이 그 줄의 늙는 문장을 전부 가렸다');
  for (const w of THREE) assert.ok(r.out.includes(w), `${w} 가 걸리지 않았다`);
});

test('대조 — 다른 토큰이면 원래도 막았다 (원인이 그 토큰이라는 대조)', () => {
  const r = withFixture(`${AGING} (다른 검사기 예시)`, {}, runIn);
  assert.equal(r.rc, 1);
});

test('대조 — 날짜가 같이 있는 실측은 조용하다', () => {
  const r = withFixture('- 2026-08-21 에 쟀다 — 실측 12건', {}, runIn);
  assert.equal(r.rc, 0, `좁히다가 날짜 있는 실측까지 잡았다\n${r.out.slice(-300)}`);
});

test('대조 — `실측 주장` 메타 표현은 조용하다 (좁힘의 대가를 치른 자리)', () => {
  // 이 문서가 실제로 이렇게 적는다 — 규칙을 **설명하는** 말이다.
  const r = withFixture('- `check-status-claims`가 날짜 없는 실측 주장을 CI에서 막는다', {}, runIn);
  assert.equal(r.rc, 0, `규칙을 설명하는 말을 주장으로 셌다\n${r.out.slice(-300)}`);
});

test('대조 — 감시 문서가 없으면 통과시키지 않는다 (fail-closed 유지)', () => {
  const r = withFixture(null, { withDoc: false }, runIn);
  assert.equal(r.rc, 1, '0개를 본 상태로 통과했다');
  assert.ok(r.out.includes('감시 목록이 낡았습니다'), '다른 이유로 빨개졌다');
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  withFixture(null, {}, runIn);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  assert.equal(after, before, `임시 폴더가 늘었다 (${before} → ${after})`);
});
