// scripts/test-autodev-fence.mjs
//
// **CI가 안 돌리는 자기 점검은 없는 자기 점검이다.**
//
// `check-autodev-safety.mjs` 는 `--self-test` 로 임시 저장소를 만들어
// 울타리 판정을 실제로 돌려 본다. 그런데 2026-11-18까지 **아무도 그걸
// 부르지 않았다.** 대조군이 분명하다:
//
//     check-100x-mutations --self-test   claude-hourly-trading.yml 에서 1회
//                                        mutation-100x-pr313.yml 에서 1회
//     check-autodev-safety --self-test   **0회**
//
// 그래서 울타리 자기 점검은 사람이 손으로 돌릴 때만 돌았다. 울타리를
// 지키는 판정의 시험이 그 상태였다.
//
// 이 파일이 그 구멍을 메운다. 이름이 `test-*.mjs` 라서 `ci.yml` 의
// **글롭 하나**(`node --test scripts/test-*.mjs`)가 자동으로 집어 가고,
// `check-ci-script-tests` 가 그 글롭이 이름 목록으로 되돌아가지 못하게
// 막는다 — 워크플로를 고치지 않고 배선된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authoritySurface, authorityFindings } from './lib/workflow-authority.mjs';

function selfTest() {
  try {
    return { code: 0, out: execFileSync(process.execPath,
      ['scripts/check-autodev-safety.mjs', '--self-test'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

test('울타리 자기 점검이 실제로 돌고 통과한다', () => {
  const r = selfTest();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✅ 울타리 자기 점검 \d+\/\d+/);
  // **센 것을 로그에 남긴다.** 단정만 하면 CI 로그에는 `ok 1` 한 줄뿐이고,
  // 그걸 읽는 사람은 **무엇이 몇 건 확인됐는지 알 수 없다.** 이 PR 자체가
  // "verify=success 인데 자기 점검이 로그에 없더라"에서 시작했다 —
  // 같은 실수를 한 층 위에서 반복하지 않는다.
  for (const line of r.out.split('\n')) {
    if (/^\s*[✓✗]|^✅|^❌/.test(line)) console.log(`    ${line.trim()}`);
  }
});

test('**셈이 0이 아니다** — 아무것도 안 보고 통과하지 않는다', () => {
  // "0/0 통과"는 통과가 아니다. 이 저장소가 두 번 당한 모양이다.
  const m = selfTest().out.match(/울타리 자기 점검 (\d+)\/(\d+)/);
  assert.ok(m, '자기 점검 수를 읽지 못했습니다');
  assert.equal(m[1], m[2]);
  assert.ok(Number(m[2]) >= 16, `자기 점검이 ${m[2]}건뿐입니다 — 시험이 사라졌을 수 있습니다`);
});

test('권한을 넓히는 다섯 모양이 전부 거부 대상으로 남아 있다', () => {
  // 시험 이름이 바뀌거나 사라지면 여기서 잡는다. 관문이 아니라
  // **관문의 시험이** 조용히 줄어드는 것을 막는다.
  const out = selfTest().out;
  for (const must of [
    '토큰 권한을 올리면 거부한다',
    '도구 허용 목록을 넓히면 거부한다',
    '시크릿을 새로 받으면 거부한다',
    '셸 본문에서 시크릿을 끌어와도 거부한다',
    '더 자주 깨어나게 하면 거부한다',
    '워크플로를 새로 만들면 거부한다',
    '워크플로를 지우면 거부한다',
  ]) {
    assert.ok(out.includes(must), `자기 점검에서 사라졌습니다: ${must}`);
  }
});

test('무해한 변경은 통과로 남아 있다 — 넓힌 쪽도 지킨다', () => {
  const out = selfTest().out;
  assert.ok(out.includes('셸 본문만 바꾸면 통과한다'));
  assert.ok(out.includes('주석만 더하면 통과한다'));
});

/* ── `with:` 아래 키 — 머리말이 범위에 넣어 둔 것을 코드가 안 보고 있었다
   ──────────────────────────────────────────────────────────────────────
   `authoritySurface` 는 `with:` **그 한 줄만** 뽑고 있었다. 이미 `with:`
   블록이 있는 단계에 자식 키를 더하면 표면이 그대로라서, 권한을 넓히는
   네 모양이 실측으로 **통과했다**. 아래가 그 네 모양이다 — 하나라도 다시
   통과하면 울타리에 구멍이 다시 열린 것이다.

   같이 지키는 반대쪽: **설정 키와 프롬프트 본문은 얼어붙지 않는다.**
   블록을 통째로 표면에 넣으면 프롬프트 한 글자에도 승인 대기가 되고,
   그것이 이 모듈이 생긴 이유인 #679 의 고장이다. */

const WF = '.github/workflows';
const FIXTURE = [
  'name: hourly',
  'on:',
  '  schedule:',
  "    - cron: '17 * * * *'",
  'permissions:',
  '  contents: write',
  'jobs:',
  '  run:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/create-github-app-token@v1',
  '        with:',
  '          app-id: 1',
  '      - uses: actions/checkout@v4',
  '        with:',
  '          fetch-depth: 1',
].join('\n');

/** 한 줄을 다른 줄(들)로 바꾼 사본 */
function withLine(from, to) {
  if (!FIXTURE.includes(from)) throw new Error(`fixture 에 없는 줄: ${from}`);
  return FIXTURE.replace(from, to);
}

function verdict(after) {
  return authorityFindings({ path: `${WF}/w.yml`, before: FIXTURE, after }).length > 0
    ? 'block' : 'pass';
}

test('★ `with:` 아래 권한을 주는 키 네 모양이 전부 거부된다', () => {
  const holes = [
    ['앱 토큰에 쓰기 권한을 더한다',
      withLine('          app-id: 1', '          app-id: 1\n          permission-contents: write')],
    ['앱 토큰이 받을 저장소를 넓힌다',
      withLine('          app-id: 1', '          app-id: 1\n          repositories: auto-platform other')],
    ['토큰을 .git/config 에 남긴다',
      withLine('          fetch-depth: 1', '          fetch-depth: 1\n          persist-credentials: true')],
    ['체크아웃하는 ref 를 바꾼다',
      withLine('          fetch-depth: 1', '          ref: refs/heads/main')],
  ];
  for (const [label, after] of holes) {
    assert.equal(verdict(after), 'block', `통과했습니다 — 구멍이 다시 열렸습니다: ${label}`);
    console.log(`    거부 확인 · ${label}`);
  }
});

test('대조 — `with:` 아래 설정 키는 그대로 통과한다 (좁히는 쪽으로 틀리지 않는다)', () => {
  const harmless = [
    ['node 버전을 올린다', withLine('          fetch-depth: 1', '          fetch-depth: 1\n          node-version: 22')],
    ['캐시를 켠다', withLine('          fetch-depth: 1', '          fetch-depth: 1\n          cache: npm')],
    ['fetch-depth 를 바꾼다', withLine('          fetch-depth: 1', '          fetch-depth: 0')],
    ['산출물 보관일을 바꾼다', withLine('          fetch-depth: 1', '          fetch-depth: 1\n          retention-days: 7')],
  ];
  for (const [label, after] of harmless) {
    assert.equal(verdict(after), 'pass', `무해한 변경이 막혔습니다: ${label}`);
  }
});

test('대조 — 셸 본문과 주석만 바뀌면 통과한다 (넓힌 쪽을 지킨다)', () => {
  assert.equal(verdict(`${FIXTURE}\n      - run: node scripts/x.mjs --extra`), 'pass');
  assert.equal(verdict(`${FIXTURE}\n      # 설명 한 줄`), 'pass');
});

test('★ 프롬프트 본문은 표면에 들어오지 않는다 — 블록을 통째로 넣지 않았다', () => {
  const before = [
    'jobs:',
    '  run:',
    '    steps:',
    '      - uses: anthropics/claude-code-action@v1',
    '        with:',
    '          claude_args: |',
    '            --allowedTools "Bash(node:*)"',
    '          prompt: |',
    '            오늘은 이것을 고쳐라',
  ].join('\n');
  // 키 줄은 표면에 있다
  const surf = authoritySurface(before);
  assert.ok(surf.some((l) => /claude_args\s*:/.test(l)), 'claude_args 키 줄이 표면에 없습니다');
  assert.ok(surf.some((l) => /prompt\s*:/.test(l)), 'prompt 키 줄이 표면에 없습니다');
  // 본문(산문)은 표면에 없고, 바꿔도 통과한다
  assert.ok(!surf.some((l) => l.includes('오늘은 이것을 고쳐라')), '프롬프트 산문이 표면에 들어왔습니다');
  const after = before.replace('오늘은 이것을 고쳐라', '오늘은 저것을 고쳐라');
  assert.equal(authorityFindings({ path: `${WF}/w.yml`, before, after }).length, 0,
    '프롬프트 문장만 바꿨는데 막혔습니다 — #679 의 고장이 돌아왔습니다');
  // 같은 블록 안의 도구 목록은 **여전히** 막힌다
  const widened = before.replace('--allowedTools "Bash(node:*)"', '--allowedTools "Bash"');
  assert.ok(authorityFindings({ path: `${WF}/w.yml`, before, after: widened }).length > 0,
    '도구 허용 목록을 넓혔는데 통과했습니다');
});

test('실제 워크플로: 설정 키는 한 줄도 표면에 없다 (대가를 값으로 잠근다)', () => {
  const CONFIG = /^\s*(node-version|cache|cache-dependency-path|fetch-depth|retention-days|if-no-files-found|pattern|path|name|bun-version|version)\s*:/;
  let checked = 0, leaked = [];
  const files = readdirSync(WF).filter((n) => /\.ya?ml$/.test(n));
  assert.ok(files.length > 0, '워크플로를 한 장도 못 읽었습니다 — 못 읽은 것을 통과로 적지 않습니다');
  for (const f of files) {
    for (const line of authoritySurface(readFileSync(join(WF, f), 'utf8'))) {
      checked += 1;
      if (CONFIG.test(line)) leaked.push(`${f}: ${line.trim()}`);
    }
  }
  assert.ok(checked > 0, '표면이 0줄입니다 — 아무것도 안 보고 통과하지 않습니다');
  assert.deepEqual(leaked, [], `설정 키가 표면에 들어왔습니다:\n  ${leaked.join('\n  ')}`);
  console.log(`    워크플로 ${files.length}장 · 표면 ${checked}줄 · 설정 키 누출 0`);
});
