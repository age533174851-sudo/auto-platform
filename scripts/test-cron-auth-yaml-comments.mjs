// scripts/test-cron-auth-yaml-comments.mjs
//
// **인용부호 안의 `#` 는 주석이 아니다.**
//
// `check-cron-auth-contract` 는 워크플로에서 `Authorization`/`x-admin-secret`
// 을 보내는 줄을 찾아 그 줄의 `secrets.X` 이름을 모은다. 그 전에 YAML 주석을
// 지우는데, 전에는 이렇게 했다:
//
//     raw.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n')
//
// 공용 `scripts/lib/strip-comments.mjs` 머리말이 **바로 그 실수**를 적어 둔
// 자리다 — `#` 은 줄 맨 앞이거나 공백 뒤일 때만 주석이고, 인용부호 안의
// `#` 는 값이다. 그 구분을 안 하면 `"color: #fff"` 까지 잘라 먹는다.
//
// 실측 (main `ed00c1a4` · 거울 사본에 워크플로 하나를 넣고 돌림)
//
//   평범한 줄                        → rc=1, 표에 나타남   (막는다)
//   같은 줄 앞에 `"X-Tag: build #1"`  → rc=0, **표에 아예 없음**
//
// 뒤쪽이 더 나쁘다. 그 `#` 부터 줄이 잘려 `Authorization` 도 안 보이게 되므로
// **그 워크플로가 목록에서 통째로 빠진다** — 보내는 비밀이 하나도 검사되지
// 않는다. 손으로 맞추는 비밀이 갈려 401 이 30회 연속 났던 것이 이 검사기가
// 막으려는 고장이다.
//
// 실제 `.github/workflows/` 는 건드리지 않는다 — 거울 사본에만 넣는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const CHECKER = join(ROOT, 'scripts', 'check-cron-auth-contract.mjs');
const PREFIX = 'cron-yaml-';
const WF = '.github/workflows';
const SECRET = 'PROBE_HAND_SECRET';

/** `.github` 만 실제 디렉터리 + 파일 심링크로 비춘다 — 거기에만 파일을 더한다 */
function mirrorGithub(absDir, absDest) {
  mkdirSync(absDest, { recursive: true });
  for (const e of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, e.name);
    if (e.isDirectory()) mirrorGithub(abs, join(absDest, e.name));
    else symlinkSync(abs, join(absDest, e.name));
  }
}

function fixture(addWorkflow = null) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    if (e.name === '.github') { mirrorGithub(join(ROOT, '.github'), join(dir, '.github')); continue; }
    symlinkSync(join(ROOT, e.name), join(dir, e.name));
  }
  if (addWorkflow) {
    const p = join(dir, WF, 'probe-hand-secret.yml');
    writeFileSync(p, addWorkflow);
    assert.ok(existsSync(p), '주입이 적용되지 않았다 — 워크플로 파일이 없다');
  }
  return dir;
}

function runIn(dir) {
  try {
    const out = execFileSync(process.execPath, [CHECKER], { cwd: dir, encoding: 'utf8', timeout: 600_000 });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function withFixture(addWorkflow, fn) {
  const dir = fixture(addWorkflow);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const wf = (bodyLine) => `name: Probe Hand Secret
on:
  workflow_dispatch:
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - name: call
        run: |
${bodyLine}
`;
const PLAIN = `          curl -sS -X POST "$URL" -H "Authorization: Bearer \${{ secrets.${SECRET} }}"`;
const QUOTED_HASH = `          curl -sS -X POST "$URL" -H "X-Tag: build #1" -H "Authorization: Bearer \${{ secrets.${SECRET} }}"`;
// 진짜 주석. 배선이 아니므로 **세면 안 된다.**
const ONLY_COMMENT = `          # 예전에는 -H "Authorization: Bearer \${{ secrets.${SECRET} }}" 를 보냈다\n          curl -sS -X POST "$URL"`;

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  const r = withFixture(null, runIn);
  assert.equal(r.rc, 0, r.out.slice(-600));
});

test('대조 — 평범한 줄의 미선언 손-비밀을 막는다 (판정이 동작하는가)', () => {
  const r = withFixture(wf(PLAIN), runIn);
  assert.equal(r.rc, 1, '판정이 동작하지 않는다 — 아래 ★ 시험은 의미가 없다');
  assert.ok(r.out.includes(SECRET), `표/오류에 ${SECRET} 가 없다`);
  assert.ok(r.out.includes('sync-secrets가 관리하지 않습니다'), '다른 이유로 빨개졌다');
});

test('★ 같은 줄 앞에 인용부호 안의 `#` 가 있어도 막는다', () => {
  const r = withFixture(wf(QUOTED_HASH), runIn);
  assert.equal(r.rc, 1,
    '인용부호 안의 `#` 를 주석으로 읽어 줄이 잘렸다 — 그 워크플로가 목록에서 통째로 빠진다');
  assert.ok(r.out.includes(SECRET),
    `${SECRET} 가 표에 아예 나타나지 않았다 — Authorization 까지 잘려 워크플로가 빠졌다`);
  assert.ok(r.out.includes('sync-secrets가 관리하지 않습니다'), '막기는 했는데 다른 판정이 울렸다');
});

test('대조 — 진짜 주석에 적힌 비밀은 배선으로 세지 않는다', () => {
  // 반대 방향을 막는 대조군이다. 주석을 계약으로 읽기 시작하면 설명만 적어도
  // 위반이 되고, 그건 고치는 게 아니라 거짓으로 막는 것이다.
  const r = withFixture(wf(ONLY_COMMENT), runIn);
  assert.equal(r.rc, 0, `주석에 적힌 비밀을 배선으로 셌다\n${r.out.slice(-500)}`);
  assert.ok(!r.out.includes(SECRET), `주석의 ${SECRET} 가 표에 들어갔다`);
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  withFixture(null, runIn);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  assert.equal(after, before, `임시 폴더가 늘었다 (${before} → ${after})`);
});
