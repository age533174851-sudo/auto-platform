import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  SWEEP_EXCLUSIONS, sweepPlan, sweepFindings, baseName,
  CI_UNCOVERED, ciCoverageFindings, ciInvokes,
} from './lib/checker-sweep.mjs';
import { inlineSweepFindings, allFindings } from './check-checker-sweep.mjs';
import { checkerFiles } from './run-all-checkers.mjs';

/** 디스크 없이 판정하기 위한 가짜 파일계 */
const fsOf = (map) => ({
  exists: (p) => Object.prototype.hasOwnProperty.call(map, p),
  read: (p) => (Object.prototype.hasOwnProperty.call(map, p) ? map[p] : null),
});

const OK = [{
  file: 'scripts/check-a.mjs', why: '인자가 필요하다',
  runWith: null, coveredBy: '.github/workflows/w.yml',
}];
const OK_FS = fsOf({
  'scripts/check-a.mjs': '',
  '.github/workflows/w.yml': 'run: node scripts/check-a.mjs "$body"',
});

test('이유와 "대신 도는 곳"이 둘 다 있으면 통과한다', () => {
  assert.deepEqual(sweepFindings({ exclusions: OK, ...OK_FS }), []);
});

test('둘 다 없으면 조용히 버려지는 것이므로 실패한다', () => {
  const f = sweepFindings({
    exclusions: [{ file: 'scripts/check-a.mjs', why: '그냥', runWith: null, coveredBy: null }],
    ...OK_FS,
  });
  assert.equal(f.length, 1);
  assert.match(f[0], /조용히 버려집니다/);
});

test('덮는다고 적은 파일이 그 검사기를 부르지 않으면 실패한다 — 주장만으로는 못 지나간다', () => {
  const f = sweepFindings({
    exclusions: OK,
    ...fsOf({ 'scripts/check-a.mjs': '', '.github/workflows/w.yml': 'run: echo 아무것도 안 함' }),
  });
  assert.equal(f.length, 1);
  assert.match(f[0], /사실이 아닙니다/);
});

test('없는 파일을 빼 두면 썩은 선언으로 실패한다', () => {
  const f = sweepFindings({ exclusions: OK, ...fsOf({ '.github/workflows/w.yml': 'check-a.mjs' }) });
  assert.equal(f.length, 1);
  assert.match(f[0], /선언이 썩었습니다/);
});

test('이유가 비어 있으면 실패한다', () => {
  const f = sweepFindings({
    exclusions: [{ ...OK[0], why: '  ' }], ...OK_FS,
  });
  assert.ok(f.some((x) => /왜 뺐는지가 비어 있습니다/.test(x)));
});

test('runWith 와 coveredBy 가 둘 다 있으면 어디서 도는지가 갈린다', () => {
  const f = sweepFindings({
    exclusions: [{ ...OK[0], runWith: ['--self-test'] }], ...OK_FS,
  });
  assert.ok(f.some((x) => /둘 다 있습니다/.test(x)));
});

test('같은 파일을 두 번 빼면 실패한다', () => {
  const f = sweepFindings({ exclusions: [OK[0], OK[0]], ...OK_FS });
  assert.ok(f.some((x) => /두 번 적혀 있습니다/.test(x)));
});

test('계획은 제외 목록만 따른다 — 러너가 제 분기를 갖지 않는다', () => {
  const p = sweepPlan({
    files: ['scripts/check-a.mjs', 'scripts/check-b.mjs', 'scripts/check-c.mjs'],
    exclusions: [
      { file: 'scripts/check-a.mjs', why: 'x', runWith: ['--self-test'], coveredBy: null },
      { file: 'scripts/check-b.mjs', why: 'y', runWith: null, coveredBy: '.github/workflows/w.yml' },
    ],
  });
  assert.deepEqual(p.bare, ['scripts/check-c.mjs']);
  assert.deepEqual(p.withArgs, [{ file: 'scripts/check-a.mjs', args: ['--self-test'] }]);
  assert.deepEqual(p.deferred, [{ file: 'scripts/check-b.mjs', coveredBy: '.github/workflows/w.yml' }]);
  // 모든 파일이 정확히 한 갈래에 들어간다 — 조용히 사라지는 것이 없다.
  assert.equal(p.bare.length + p.withArgs.length + p.deferred.length, 3);
});

test('YAML 에 전수 루프가 돌아오면 실패한다', () => {
  const f = inlineSweepFindings(
    'run: |\n  for f in scripts/check-*.mjs; do node "$f"; done\n  node scripts/run-all-checkers.mjs\n', 'w.yml');
  assert.equal(f.length, 1);
  assert.match(f[0], /전수 루프가 다시 있습니다/);
});

test('"러너를 부르는가"는 여기서 보지 않는다 — 소유자가 하나여야 한다', () => {
  // 그 질문은 `check-claude-hourly` 가 `|| fail=1` 까지 함께 못 박는다.
  // 두 곳이 같은 것을 보면 언젠가 갈린다.
  assert.deepEqual(inlineSweepFindings('run: echo 아무것도 안 함\n', 'w.yml'), []);
});

test('그 핀이 check-claude-hourly 에 실제로 있다 — 소유자가 비어 있지 않다', () => {
  const src = readFileSync('scripts/check-claude-hourly.mjs', 'utf8');
  assert.match(src, /node scripts\\\/run-all-checkers\\\.mjs \\\|\\\| fail=1/);
});

test('**주석에 적힌 설명을 계약으로 읽지 않는다**', () => {
  // 이 시험이 없으면 "전에는 for f in scripts/check-* 루프가 있었다"는
  // 설명 주석만으로 빨간불이 켜진다. 실제로 처음 쓸 때 그렇게 걸렸다.
  const f = inlineSweepFindings(
    '# 전에는 여기에 `for f in scripts/check-*.mjs` 루프가 있었다\nrun: node scripts/run-all-checkers.mjs\n', 'w.yml');
  assert.deepEqual(f, []);
});

test('실제 저장소 상태에서 통과한다 — 목록이 사실과 같다', () => {
  assert.deepEqual(allFindings(), []);
});

test('실제 전수 계획이 모든 검사기를 덮는다 — 합이 전체와 같다', () => {
  const files = checkerFiles();
  const p = sweepPlan({ files, exclusions: SWEEP_EXCLUSIONS });
  assert.equal(p.bare.length + p.withArgs.length + p.deferred.length, files.length);
  assert.ok(files.length > 80, `검사기가 ${files.length}개뿐입니다 — 글롭이 깨졌을 수 있습니다`);
  // 자기 자신이 전수에 들어 있어야 한다. 빠지면 이 관문이 안 돈다.
  assert.ok(p.bare.includes('scripts/check-checker-sweep.mjs'));
});

test('baseName 은 경로를 벗긴다', () => {
  assert.equal(baseName('scripts/check-a.mjs'), 'check-a.mjs');
  assert.equal(baseName('check-a.mjs'), 'check-a.mjs');
  assert.equal(baseName(null), '');
});

test('워크플로가 러너를 실제로 부른다 — 배선 확인', () => {
  const y = readFileSync('.github/workflows/claude-hourly-trading.yml', 'utf8');
  assert.match(y, /node scripts\/run-all-checkers\.mjs \|\| fail=1/);
});

// ───────────────────────────────────────────────────────────────────
// PR CI 가 부르지 않는 검사기가 **전부 선언돼 있는가**
//
// `ci.yml` 은 검사기를 이름으로 하나하나 부른다. 새 검사기를 더하고 그
// 줄을 넣지 않으면 **PR 에서 한 번도 돌지 않는다.** 실제로 그렇게 된
// 것이 있고(`scripts/run-tests.mjs` 가 그 사실을 주석으로 적어 두기까지
// 했다), 그걸 세는 곳이 없었다.
// ───────────────────────────────────────────────────────────────────

const CI_WITH = (names) => names.map((n) => `        run: node scripts/${n}`).join('\n');

test('★ 선언 없이 PR CI 밖에 있으면 실패한다 — 새 검사기가 조용히 안 돈다', () => {
  const f = ciCoverageFindings({
    files: ['scripts/check-a.mjs', 'scripts/check-b.mjs'],
    ciText: CI_WITH(['check-a.mjs']),
    declared: [],
  });
  assert.equal(f.length, 1);
  assert.match(f[0], /check-b\.mjs/);
  assert.match(f[0], /PR 에서 한 번도 돌지 않습니다/);
});

test('선언하면 통과한다 — 이유와 실제로 도는 곳을 값으로 적는다', () => {
  assert.deepEqual(ciCoverageFindings({
    files: ['scripts/check-a.mjs', 'scripts/check-b.mjs'],
    ciText: CI_WITH(['check-a.mjs']),
    declared: [{ file: 'scripts/check-b.mjs', why: '인자가 필요하다', runsIn: '.github/workflows/w.yml' }],
  }), []);
});

test('★ 이유나 도는 곳이 비면 실패한다 — 다음 사람이 되돌릴 수 없다', () => {
  const f = ciCoverageFindings({
    files: ['scripts/check-b.mjs'],
    ciText: '',
    declared: [{ file: 'scripts/check-b.mjs', why: '  ', runsIn: '' }],
  });
  assert.equal(f.length, 2);
  assert.match(f.join('\n'), /왜 PR 밖인지가 비어 있습니다/);
  assert.match(f.join('\n'), /실제로 어디서 도는지가 비어 있습니다/);
});

test('★ 썩은 선언 — 파일이 없으면 실패한다', () => {
  const f = ciCoverageFindings({
    files: ['scripts/check-a.mjs'],
    ciText: CI_WITH(['check-a.mjs']),
    declared: [{ file: 'scripts/check-gone.mjs', why: '이유', runsIn: '어딘가' }],
  });
  assert.equal(f.length, 1);
  assert.match(f[0], /선언이 썩었습니다/);
});

test('★ ci.yml 이 이제 부르는데 선언이 남아 있으면 실패한다 — 면제가 쌓인다', () => {
  const f = ciCoverageFindings({
    files: ['scripts/check-a.mjs'],
    ciText: CI_WITH(['check-a.mjs']),
    declared: [{ file: 'scripts/check-a.mjs', why: '이유', runsIn: '어딘가' }],
  });
  assert.equal(f.length, 1);
  assert.match(f[0], /지우세요/);
});

test('같은 파일을 두 번 선언하면 실패한다', () => {
  const d = { file: 'scripts/check-b.mjs', why: '이유', runsIn: '어딘가' };
  const f = ciCoverageFindings({ files: ['scripts/check-b.mjs'], ciText: '', declared: [d, d] });
  assert.match(f.join('\n'), /두 번 적혀 있습니다/);
});

test('"적혀 있는 것"과 "부르는 것"을 구분한다 — paths 목록은 부르는 것이 아니다', () => {
  // `paths:` 필터에 경로가 적혀 있는 것은 돌리는 것이 아니다. 이 구분이
  // 없으면 `paths:` 한 줄로 관문을 통과시킬 수 있다.
  assert.equal(ciInvokes("      - 'scripts/check-a.mjs'", 'scripts/check-a.mjs'), false);
  assert.equal(ciInvokes('        run: node scripts/check-a.mjs', 'scripts/check-a.mjs'), true);
  assert.equal(ciInvokes('        run: node scripts/check-a.mjs --self-test', 'scripts/check-a.mjs'), true);
});

test('★ 주석 안의 호출은 부르는 것이 아니다 (독립 검수 반례 ①)', () => {
  // 단계를 주석 처리하면 그 단계는 사라진다. 그런데 문자열은 남는다.
  // 실제 `ci.yml` 로 재현된 반례다 — `# run: node scripts/check-x.mjs`.
  // 지금 `ci.yml` 에도 주석 안에 `node scripts/check-100x-mutations.mjs`
  // 안내가 있고, 그 검사기는 같은 파일의 `--self-test` 줄로 실제로 돈다.
  assert.equal(ciInvokes('        # run: node scripts/check-a.mjs', 'scripts/check-a.mjs'), false);
  assert.equal(ciInvokes('      # 전수 실행: node scripts/check-a.mjs (사람이 부른다)', 'scripts/check-a.mjs'), false);
});

test('★ echo 는 부르는 것이 아니다 (독립 검수 반례 ②)', () => {
  // `echo node scripts/check-x.mjs` 는 문장만 출력한다. 명령 위치에
  // 있는 것만 센다 — 토막이 `node` 로 시작해야 한다.
  assert.equal(ciInvokes('        run: echo node scripts/check-a.mjs', 'scripts/check-a.mjs'), false);
  assert.equal(ciInvokes('        run: printf "node scripts/check-a.mjs"', 'scripts/check-a.mjs'), false);
});

test('환경변수 접두와 명령 이어붙이기는 부르는 것이다 — 잘못 막으면 그것도 고장이다', () => {
  assert.equal(ciInvokes('        run: FOO=1 node scripts/check-a.mjs', 'scripts/check-a.mjs'), true);
  assert.equal(ciInvokes('        run: node scripts/check-b.mjs && node scripts/check-a.mjs',
    'scripts/check-a.mjs'), true);
  // 다중행 `run: |` 블록 안의 줄도 같게 본다.
  assert.equal(ciInvokes('        run: |\n          node scripts/check-a.mjs\n', 'scripts/check-a.mjs'), true);
});

test('★ 인용 안의 호출은 부르는 것이 아니다 (독립 검수 반례 ③)', () => {
  // 세 번째 반례. 같은 문장을 **따옴표로 감싸고 세미콜론 하나**를 넣으면
  // 다시 "부름"으로 셌다 — raw 문자열을 `;` 로 나누니 둘째 토막이
  // `node …` 로 시작했기 때문이다. 셸은 그 문장을 출력만 한다.
  // 실제 `ci.yml` 로 재현하고 `/bin/bash -c` 로 검사기가 돌지 않는 것을
  // 확인했다 (HEAD c02d4f05).
  assert.equal(ciInvokes(
    '        run: echo "literal; node scripts/check-a.mjs --synthetic"', 'scripts/check-a.mjs'), false);
  assert.equal(ciInvokes(
    "        run: printf '%s\\n' 'literal; node scripts/check-a.mjs --synthetic'", 'scripts/check-a.mjs'), false);
  // 뒤에 플래그가 없어도, 닫는 따옴표 앞에 공백이 있어도 같다.
  // (전 판은 이 둘 중 하나만 우연히 걸렀다 — `(\s|$)` 가 `"` 에 막혀서다.
  //  우연히 맞는 것은 성질이 아니다.)
  assert.equal(ciInvokes('        run: echo "x; node scripts/check-a.mjs"', 'scripts/check-a.mjs'), false);
  assert.equal(ciInvokes('        run: echo "x; node scripts/check-a.mjs "', 'scripts/check-a.mjs'), false);
});

test('★ heredoc 본문은 명령이 아니다', () => {
  // `cat <<'SH'` 와 닫는 줄 사이는 셸이 실행하지 않는다 — 자료다.
  const yaml = [
    '        run: |',
    "          cat <<'SH' > /dev/null",
    '          node scripts/check-a.mjs',
    '          SH',
  ].join('\n');
  assert.equal(ciInvokes(yaml, 'scripts/check-a.mjs'), false);
  // 여는 줄 자체는 명령이므로, 같은 줄에 진짜 호출이 있으면 센다.
  assert.equal(ciInvokes(
    "        run: |\n          node scripts/check-a.mjs <<'SH'\n          자료\n          SH",
    'scripts/check-a.mjs'), true);
});

test('★ run 이 아닌 블록은 명령이 아니다 — env 본문에 적어도 부름이 아니다', () => {
  // `|` 블록은 `run:` 말고도 쓰인다. 그 본문을 명령으로 읽으면
  // `env:` 한 칸으로 관문을 통과시킬 수 있다. 본문에 `run:` 이라고
  // 적어도 명령이 되지 않는다.
  assert.equal(ciInvokes(
    '        env:\n          HINT: |\n            node scripts/check-a.mjs\n        run: true',
    'scripts/check-a.mjs'), false);
  assert.equal(ciInvokes(
    '        env:\n          HINT: |\n            run: node scripts/check-a.mjs\n        run: true',
    'scripts/check-a.mjs'), false);
  // 같은 단계의 진짜 `run:` 은 그대로 센다.
  assert.equal(ciInvokes(
    '        env:\n          HINT: |\n            아무 말\n        run: node scripts/check-a.mjs',
    'scripts/check-a.mjs'), true);
});

test('인용·heredoc을 보면서도 진짜 호출을 놓치지 않는다', () => {
  // 좁히는 쪽으로 고칠 때 같이 걸리기 쉬운 네 가지.
  assert.equal(ciInvokes('        run: node scripts/check-a.mjs   # 이유', 'scripts/check-a.mjs'), true);
  assert.equal(ciInvokes('        run: echo x | grep x && node scripts/check-a.mjs', 'scripts/check-a.mjs'), true);
  assert.equal(ciInvokes('        run: cd . && NODE_OPTIONS=--no-warnings node scripts/check-a.mjs',
    'scripts/check-a.mjs'), true);
  assert.equal(ciInvokes('      - run: node scripts/check-a.mjs', 'scripts/check-a.mjs'), true);
});

test('이름이 겹치지 않게 본다 — check-a 선언이 check-ab 를 덮지 않는다', () => {
  assert.equal(ciInvokes('        run: node scripts/check-ab.mjs', 'scripts/check-a.mjs'), false);
});

test('★ ci.yml 을 못 읽으면 실패한다 — 못 읽은 것을 "전부 덮였다"로 적지 않는다', () => {
  const f = allFindings({
    exists: (p) => p !== '.github/workflows/ci.yml',
    read: (p) => (p === '.github/workflows/ci.yml' ? null : ''),
    files: ['scripts/check-a.mjs'],
  });
  assert.match(f.join('\n'), /ci\.yml 을 읽지 못했습니다/);
});

test('★ 검사기 본체를 하나도 못 찾으면 실패한다', () => {
  const f = allFindings({
    exists: () => true,
    read: () => 'run: node scripts/run-all-checkers.mjs',
    files: [],
  });
  assert.match(f.join('\n'), /검사기 본체를 하나도 찾지 못했습니다/);
});

test('실제 저장소에서 PR CI 밖 검사기가 전부 선언돼 있다', () => {
  // 이 시험이 빨개지면 둘 중 하나다 — 새 검사기를 ci.yml 에 안 넣었거나,
  // CI_UNCOVERED 선언이 낡았거나. 둘 다 사람이 고쳐야 한다.
  const files = checkerFiles();
  const ciText = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.deepEqual(ciCoverageFindings({ files, ciText }), []);
  assert.ok(CI_UNCOVERED.length > 0, '선언 목록이 비어 있습니다 — 실측과 다릅니다');
});

// ── 덮는다고 적은 곳이 **실제로 부르는가** ───────────────────
//
// 기계 탐침으로 찾았다 (3cc3fd14). `coveredBy` 검증이 `includes(이름)`
// 이어서, 덮는다고 적은 워크플로에서 그 호출 줄을 **주석 처리해도**
// 통과했다:
//
//   autotrade-tick.yml:110        지우면 rc=1 · 주석 처리하면 rc=0 ❌
//   claude-hourly-trading.yml:345 지우면 rc=1 · 주석 처리하면 rc=0 ❌
//
// 이 관문의 존재 이유가 "제외 목록이 검사기를 숨기는 자리가 되지 않게"
// 인데, 주석 한 줄로 숨길 수 있었다. 같은 질문에는 이미 답이 있다 —
// `ciInvokes` 가 셸 명령 위치만 센다.

test('★ 덮는 워크플로에서 호출 줄을 주석 처리하면 실패한다', () => {
  const wf = '      - run: node scripts/check-x.mjs --flag\n';
  const ex = [{ file: 'scripts/check-x.mjs', why: '이유', runWith: null,
    coveredBy: '.github/workflows/w.yml' }];
  const exists = () => true;
  const live = sweepFindings({ exclusions: ex, exists, read: () => wf });
  assert.deepEqual(live, [], live.join('\n'));
  const muted = sweepFindings({ exclusions: ex, exists, read: () => '      # - run: node scripts/check-x.mjs --flag\n' });
  assert.match(muted.join('\n'), /명령 위치에서/);
});

test('★ 인용 안에 적힌 것은 덮는 것이 아니다', () => {
  const ex = [{ file: 'scripts/check-x.mjs', why: '이유', runWith: null,
    coveredBy: '.github/workflows/w.yml' }];
  const faked = sweepFindings({ exclusions: ex, exists: () => true,
    read: () => '      - run: echo "x; node scripts/check-x.mjs --flag"\n' });
  assert.match(faked.join('\n'), /명령 위치에서/);
});

test('coveredBy 는 워크플로여야 한다 — 확인할 수 없는 꼴을 통과시키지 않는다', () => {
  const ex = [{ file: 'scripts/check-x.mjs', why: '이유', runWith: null,
    coveredBy: 'scripts/run-all-checkers.mjs' }];
  const out = sweepFindings({ exclusions: ex, exists: () => true, read: () => 'check-x.mjs' });
  assert.match(out.join('\n'), /워크플로\(\.yml\)여야 합니다/);
});

test('실제 저장소의 제외 3건이 전부 명령 위치에서 불린다', () => {
  const out = sweepFindings({ exclusions: SWEEP_EXCLUSIONS, exists: existsSync,
    read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null) });
  assert.deepEqual(out, [], out.join('\n'));
});
