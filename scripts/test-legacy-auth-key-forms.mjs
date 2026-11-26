// scripts/test-legacy-auth-key-forms.mjs
//
// **`check-legacy-auth-key`가 파일 꼴만 바꾼 우회를 잡는지, 그리고 0개를
// "없음"으로 적지 않는지 못 박는다.**
//
// 그 검사기가 지키는 것은 "제품 코드가 `localStorage.sb_access_token`을
// 읽지 않는다"다. 그 키는 저장소 역사에 production writer가 없어서 정상
// 흐름에서는 채워지지 않는다 — 읽는 쪽은 값을 못 얻고 요청 전에 끝난다.
// 그래서 전체정지 버튼이 아무 요청도 보내지 않았고(#242), 홈 자동매매
// 카드는 영구히 '읽는 중…'이었고, 로그인한 사용자에게 '로그인하면'이라고
// 적었다.
//
// 그런데 읽는 파일 꼴 목록이 `ts|tsx|js|jsx|mjs`였다. TypeScript·Node가
// 똑같이 받아 주는 `cts`·`mts`·`cjs`가 빠져 있었다. 실측했다
// (main ed00c1a4):
//
//   src/zzprobe-legacy.ts  에 그 한 줄   → ❌ rc=1  (맞다)
//   같은 줄을 .cts / .mts / .cjs 로 두면 → ✅ rc=0  "legacy 키 사용 없음"
//
// 그리고 읽은 파일이 0개여도 "사용 없음"을 적었다. 이 검사기에는 고정
// 경로 읽기가 없어서 다른 단언이 우연히 잡아 주지도 않는다.
//
// 저장소를 건드리지 않는다. 검사기가 보는 것은 `src` 하나뿐이므로
// 임시 디렉터리에 작은 `src`를 세우고 거기서만 돈다.
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-legacy-auth-key.mjs');

/** 정본을 쓰는 평범한 파일 — 위반이 아니다 */
const CLEAN = `import { authHeader } from '@/lib/auth/authToken';
export async function ping() {
  return fetch('/api/ping', { headers: { Authorization: await authHeader() } });
}
`;
/** legacy 키를 읽는 한 줄 */
const LEGACY = "export const t = localStorage.getItem('sb_access_token');\n";

function runChecker(cwd) {
  const r = spawnSync(process.execPath, [CHECKER], { cwd, encoding: 'utf8' });
  return { rc: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function withSrc(extra, fn, opts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'legacyauth-'));
  const write = (rel, body) => {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  try {
    if (!opts.noClean) write('src/lib/net/ping.ts', CLEAN);
    else mkdirSync(join(base, 'src'), { recursive: true });
    for (const [rel, body] of Object.entries(extra)) write(rel, body);
    return fn(base);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

test('양성 대조 — 정본만 쓰는 트리는 초록이다', () => {
  withSrc({}, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 0, `초록이어야 합니다:\n${r.err}${r.out}`);
  });
});

test('.ts에서 legacy 키를 읽으면 빨강이다 (원래 동작의 회귀)', () => {
  withSrc({ 'src/lib/net/zzlegacy.ts': LEGACY }, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, '통과했습니다');
    assert.match(r.err, /zzlegacy\.ts/);
  });
});

for (const ext of ['cts', 'mts', 'cjs']) {
  test(`★ .${ext}에서 legacy 키를 읽어도 빨강이다 (예전에는 꼴만 바꾸면 빠졌다)`, () => {
    withSrc({ [`src/lib/net/zzlegacy.${ext}`]: LEGACY }, (base) => {
      const r = runChecker(base);
      assert.equal(r.rc, 1, `.${ext} 꼴을 통과시켰습니다`);
      assert.match(r.err, new RegExp(`zzlegacy\\.${ext}`), '어느 파일인지 말하지 않습니다');
      assert.doesNotMatch(r.out, /사용 없음/, '빨강인데 통과 문장을 찍었습니다');
    });
  });
}

test('★ 읽은 파일이 0개면 빨강이다 — 0을 "사용 없음"으로 적지 않는다', () => {
  // src는 있는데 읽을 파일이 하나도 없다. 경로가 바뀐 모습이고, 이
  // 검사기에는 고정 경로 읽기가 없어 다른 단언이 잡아 주지 않는다.
  withSrc({}, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, `0개를 통과시켰습니다:\n${r.out}`);
    assert.match(r.err, /읽은 파일이 0개/);
    assert.doesNotMatch(r.out, /사용 없음/);
  }, { noClean: true });
});

test('★ 훑지 못하면 이름을 적고 빨강이다 (예전에는 스택만 뱉었다)', () => {
  const base = mkdtempSync(join(tmpdir(), 'legacyauth-'));
  try {
    // src가 아예 없다. 예전에는 readdirSync가 그대로 던져서 스택만 나왔고,
    // 어느 디렉터리인지·왜 통과가 아닌지는 말하지 않았다.
    const r = runChecker(base);
    assert.equal(r.rc, 1, '없는 디렉터리를 통과시켰습니다');
    assert.match(r.err, /훑지 못했습니다/);
    assert.match(r.err, /src \(ENOENT\)/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('주석으로 남긴 역사는 위반이 아니다 — 왜 그렇게 됐는지 적을 수 있어야 한다', () => {
  withSrc({
    'src/lib/net/zzhistory.ts':
      `// 예전에는 localStorage.getItem('${'sb_access_token'}')을 읽었다 — 이제 쓰지 않는다\n`
      + 'export const note = 1;\n',
  }, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 0, `주석을 코드로 읽었습니다:\n${r.err}`);
  });
});

test('실제 저장소도 초록이다 — 가짜 트리가 현실과 갈라지지 않았는지 본다', () => {
  const r = runChecker(ROOT);
  assert.equal(r.rc, 0, `실제 저장소가 빨강입니다:\n${r.err}${r.out}`);
});
