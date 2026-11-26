// `check-runtime.mjs`의 **발견이 비면 멈추는가**를 본다.
//
// 그 검사기는 두 집합을 모은다 — 화면 파일(`.tsx`)과 소스 파일(`.ts`).
// 예전에는 `globSync`가 없거나 던지면 둘 다 빈 배열이 됐다.
// `srcFiles`가 비는 경우는 뒤의 "워커 생존 판정 기준이 없습니다"가
// **우연히** 잡아 줬지만, `uiFiles`가 비는 경우는 아무도 안 잡았다.
//
// 실측: UI glob만 없는 경로로 바꾸고 화면에 `Railway`를 적은 파일을 둔 채
// 돌리면 `✅ 운영 사실 문구 0건 …` rc=0 이었다. 한 장도 안 열고 "0건"을
// 적는 것은 이 저장소가 금지한 **UNKNOWN을 0으로 적기**다.
//
// 우연히 걸리는 단언에 기대지 않는다 — 두 집합을 각각 단언했는지 본다.
//
// 공유 상태를 건드리지 않는다: `src`를 임시 디렉터리에 한 번 복제하고
// 그 안에서만 쓴다. 실제 트리에 임시 파일을 만들면 병렬로 도는 형제
// 시험이 깨진다 (#783에서 한 번 깨뜨렸다).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = 'scripts/check-runtime.mjs';
const SOURCE = readFileSync(join(ROOT, CHECKER), 'utf8');

const BASE = mkdtempSync(join(tmpdir(), 'runtimechk-'));
cpSync(join(ROOT, 'src'), join(BASE, 'src'), { recursive: true });
cpSync(join(ROOT, 'worker'), join(BASE, 'worker'), { recursive: true });
mkdirSync(join(BASE, 'scripts/lib'), { recursive: true });
cpSync(join(ROOT, 'scripts/lib'), join(BASE, 'scripts/lib'), { recursive: true });
process.on('exit', () => { try { rmSync(BASE, { recursive: true, force: true }); } catch { /* 정리 실패가 판정을 바꾸지 않는다 */ } });

const PROBE_DIR = join(BASE, 'src/components/zz-probe');
const run = (file, cwd = BASE) => {
  const r = spawnSync(process.execPath, [file], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const variant = (name, transform = (s) => s) => {
  const rel = `scripts/${name}.mjs`;
  writeFileSync(join(BASE, rel), transform(SOURCE));
  return join(BASE, rel);
};
const NO_GLOB = (s) => s.replaceAll("typeof fs.globSync === 'function'", 'false');
const NO_UI = (s) => s
  .replace("fs.globSync('src/components/**/*.tsx')", "fs.globSync('src/NOPEC/**/*.tsx')")
  .replace("fs.globSync('src/app/**/*.tsx')", "fs.globSync('src/NOPEA/**/*.tsx')");

function withProbe(fn) {
  try {
    mkdirSync(PROBE_DIR, { recursive: true });
    // `STALE_CLAIMS`가 금지하는 문구를 화면 파일에 적는다.
    writeFileSync(join(PROBE_DIR, 'Probe.tsx'),
      'export function Zz() { return <div>Railway 워커 상태</div>; }\n');
    return fn();
  } finally {
    rmSync(PROBE_DIR, { recursive: true, force: true });
  }
}

test('양성 대조 — 손대지 않은 저장소는 초록이다', () => {
  const r = run(join(ROOT, CHECKER), ROOT);
  assert.equal(r.code, 0, `빨강입니다:\n${r.err.slice(0, 500)}`);
});

test('화면이 운영 사실을 적으면 빨강이다 (원래 동작의 회귀)', () => {
  withProbe(() => {
    const r = run(variant('rt-plain'));
    assert.notEqual(r.code, 0);
    assert.match(r.err, /zz-probe/);
  });
});

test('★ 화면 파일을 하나도 못 찾으면 빨강이다 (예전에는 "0건"으로 통과했다)', () => {
  withProbe(() => {
    const r = run(variant('rt-noui', NO_UI));
    assert.notEqual(r.code, 0, '화면 파일 0개인데 통과했습니다');
    assert.match(r.err, /화면 파일\(\.tsx\)을 하나도 찾지 못했습니다/);
    assert.doesNotMatch(r.out, /운영 사실 문구 0건/, '한 장도 안 열고 "0건"을 적었습니다');
  });
});

test('★ glob이 없어도 화면 위반을 잡는다 (walk 대체)', () => {
  withProbe(() => {
    const r = run(variant('rt-noglob', NO_GLOB));
    assert.notEqual(r.code, 0);
    // 예전 모양은 여기서 **다른 이유**로 빨강이었다(워커 생존 기준을 못 찾아서).
    // 그래서 "어느 파일인지 말하는가"로 가른다.
    assert.match(r.err, /zz-probe/, 'walk 대체로 화면 위반을 잡지 못했습니다');
  });
});

test('glob이 없고 위반도 없으면 통과한다 — 잘못 막으면 그것도 고장이다', () => {
  const r = run(variant('rt-noglob2', NO_GLOB));
  assert.equal(r.code, 0, `위반이 없는데 막았습니다:\n${r.err.slice(0, 500)}`);
});
