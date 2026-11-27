// scripts/test-admin-client-anchors.mjs
//
// **"수정이 사라졌습니다" 를 잡겠다는 단정이 그 경우에 침묵했다.**
//
// `check-admin-client.mjs` §② 는 서버 읽기의 캐시 차단이 코드에 남아
// 있는지 본다 — 그 문(`getSupabaseAdmin`)이 `adminClientOptions()` 를 쓰고,
// 구현이 `cache: 'no-store'` 를 붙이는지. 둘 다 **원문**에 걸려 있었다.
//
// 실측(무인 회차 02:32): `serverFetch.ts` 의 `no-store` 는 3곳인데 실제
// 코드는 한 줄뿐이고 나머지 둘은 머리말 주석과 함수 설명이다. 그래서
// **실제 한 줄을 지워도** 통과했다. 지우는 것이 바로 이 단정이 막겠다고
// 적어 둔 상황이다.
//
// §① (서버 코드가 직접 `createClient` 를 만드는지)은 **금지** 방향이고
// 줄 번호를 보고하므로 원문을 그대로 본다 — 여기서 걷지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync, cpSync , rmSync} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-admin-client.mjs');
const GATE = 'src/lib/supabase/server.ts';
const IMPL = 'src/lib/supabase/serverFetch.ts';

/**
 * 검사기를 격리 폴더에서 돌린다. `src` 만 실제 복사하고(변형 대상) 나머지는
 * 심링크한다 — 저장소를 통째로 복사하지 않는다.
 */
const PREFIX = 'adm-anchor-';

/** 이 시험이 만든 임시 폴더 (다른 접두사·다른 시험은 세지 않는다) */
function ownTempDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));
}

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
    // **치우지 않으면 한 번 돌 때마다 `src` 사본이 남는다.** 검수 지적으로
    // 재현했다(#799 코멘트 7212565149): 이 접두사만 이 컨테이너에 20개 ·
    // 400MB 였고, 같은 모양의 제 시험 넷을 합치면 약 1.57GB 였다. 쓰기
    // 가능 공간이 고정 할당이라 그대로 두면 다음 작업이 디스크로 막힌다.
    // 검사기가 실패해 예외가 나도 치운다.
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 주석도 설명도 아닌 **실제 코드** 줄만 고른다. */
function codeLineWith(path, needle) {
  const L = readFileSync(path, 'utf8').split('\n');
  const i = L.findIndex((l) => {
    const t = l.trim();
    return l.includes(needle) && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
  assert.ok(i >= 0, `${needle} 의 실제 코드 줄을 찾지 못했다`);
  return { L, i };
}

test('대조군 — 실제 저장소에서 통과한다', () => {
  const { rc, out } = runChecker(null);
  assert.equal(rc, 0, out);
  assert.match(out, /읽기 캐시 차단 유지/);
});

test("★ 실제 cache: 'no-store' 줄을 지우면 막힌다 — 주석 2곳이 남아 있어도", () => {
  const dropped = runChecker((p) => {
    const f = p(IMPL);
    const { L, i } = codeLineWith(f, "cache: 'no-store'");
    writeFileSync(f, L.filter((_, k) => k !== i).join('\n'));
    // 주석 쪽 언급은 그대로 남겨 둔다 — 그게 전에 통과시킨 것이다.
    assert.ok(readFileSync(f, 'utf8').includes('no-store'), '주석 언급이 남아 있어야 이 시험이 뜻을 가진다');
  });
  assert.equal(dropped.rc, 1, '실제 줄을 지웠는데 통과했다');
  assert.match(dropped.out, /no-store/);
});

test('★ 같은 줄을 주석 처리해도 막힌다 (// · 블록 둘 다)', () => {
  for (const wrap of ['line', 'block']) {
    const r = runChecker((p) => {
      const f = p(IMPL);
      const { L, i } = codeLineWith(f, "cache: 'no-store'");
      const n = L[i].length - L[i].replace(/^\s*/, '').length;
      L[i] = wrap === 'line'
        ? `${L[i].slice(0, n)}// ${L[i].slice(n)}`
        : `${L[i].slice(0, n)}/* ${L[i].slice(n).trimEnd()} */`;
      writeFileSync(f, L.join('\n'));
    });
    assert.equal(r.rc, 1, `${wrap} 주석인데 통과했다\n${r.out}`);
  }
});

test('★ adminClientOptions() 호출을 주석 처리하면 막힌다 — import 는 호출이 아니다', () => {
  const r = runChecker((p) => {
    const f = p(GATE);
    const { L, i } = codeLineWith(f, 'adminClientOptions()');
    const n = L[i].length - L[i].replace(/^\s*/, '').length;
    L[i] = `${L[i].slice(0, n)}// ${L[i].slice(n)}`;
    writeFileSync(f, L.join('\n'));
  });
  assert.equal(r.rc, 1, '호출을 주석 처리했는데 통과했다');
  assert.match(r.out, /adminClientOptions/);
});

test('§① 은 좁히지 않았다 — 실제 createClient 는 잡고, 주석은 잡지 않는다', () => {
  // 금지 방향이라 넓이를 줄이면 빠져나갈 길이 생긴다. 실제 호출은 걸려야 한다.
  const real = runChecker((p) => {
    const f = p(IMPL);
    const L = readFileSync(f, 'utf8').split('\n');
    L.push('export const leak = () => createClient(1, 2);');
    writeFileSync(f, L.join('\n'));
  });
  assert.equal(real.rc, 1, '직접 만든 client 를 놓쳤다');
  assert.match(real.out, /직접 만들고 있습니다/);

  // 주석 처리된 것은 client 를 만들지 않으므로 잡지 않는 것이 옳다.
  const commented = runChecker((p) => {
    const f = p(IMPL);
    const L = readFileSync(f, 'utf8').split('\n');
    L.push('// export const leak = () => createClient(1, 2);');
    writeFileSync(f, L.join('\n'));
  });
  assert.equal(commented.rc, 0, `주석을 호출로 셌다\n${commented.out}`);
});

test('★ 임시 폴더를 남기지 않는다 — 한 번 돌 때마다 src 사본이 쌓였다', () => {
  const before = new Set(ownTempDirs());
  runChecker(null);
  const leaked = ownTempDirs().filter((n) => !before.has(n));
  assert.deepEqual(leaked, [], `남은 임시 폴더:\n  ${leaked.join('\n  ')}`);
});
