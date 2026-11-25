#!/usr/bin/env node
// scripts/check-autodev-safety.mjs
//
// **무인 회차가 만든 변경을, 커밋된 뒤에 한 번 더 본다.**
//
// 왜 프롬프트만으로는 부족한가
// ─────────────────────────────
// "안전장치를 제거하지 마라"는 지시다. 지시는 지켜지지 않을 수 있고,
// 지켜지지 않은 것을 **아무도 보지 않는 시간에** 알아차릴 방법이 없다.
// 그래서 결과물을 기계가 센다.
//
// 가장 비싼 실패 모양은 이것이다: 시험이 빨간데 원인을 찾는 대신
// **막고 있던 관문을 지워서 초록으로 만든다.** 그렇게 지워진 관문은
// 아무도 다시 세우지 않는다.
//
// 무엇을 보는가
// ─────────────
//   ① 안전 닻(fail-closed 표식)의 개수가 **줄지 않았는가**
//   ② 검사기를 지우거나 단정을 줄이지 않았는가
//   ③ 제 울타리(워크플로)를 스스로 고치지 않았는가
//   ④ 마이그레이션을 건드리지 않았는가
//   ⑤ (dev 갈래) 거래 엔진 경로를 건드리지 않았는가
//
// 쓰는 법:  node scripts/check-autodev-safety.mjs --base <ref> --mode dev|trading
import { execFileSync } from 'node:child_process';
import { stripJsComments } from './lib/strip-comments.mjs';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const BASE = argOf('--base', 'origin/main');
const MODE = argOf('--mode', 'dev') === 'trading' ? 'trading' : 'dev';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };

// ── --self-test ──
//
// **이 검사기가 "아무것도 보지 못한 채 ✅"를 주지 않는지 자기가 확인한다.**
//
// 2026-11-02에 실제로 그랬다. 무인 회차가 변경을 **커밋하기 전에** 이
// 검사기를 돌렸고, `BASE...HEAD`는 커밋된 상태만 보기 때문에 그 변경을
// 본 적이 없는 상태로 통과(✅)를 적었다. 세 PR에서 같은 일이 났다.
//
// 그래서 임시 저장소를 만들어 **깨끗한 트리**와 **더러운 트리**에서
// 각각 이 파일을 실제로 돌려 본다. 정적 추론이 아니다.
if (argv.includes('--self-test')) {
  const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const self = new URL(import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), 'autodev-fence-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  const run = () => {
    try {
      const out = execFileSync(process.execPath, [self, '--base', 'HEAD', '--mode', 'trading'],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out };
    } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
  };
  let fails = 0;
  // 수를 손으로 적으면 시험을 더할 때 또 어긋난다 — 센 것을 쓴다.
  let total = 0;
  const want = (name, cond, got) => {
    total += 1;
    if (cond) console.log(`  ✓ ${name}`);
    else { console.error(`  ✗ ${name} — ${got}`); fails += 1; }
  };
  try {
    g('init', '-q');
    g('config', 'user.email', 'selftest@local');
    g('config', 'user.name', 'selftest');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');

    const clean = run();
    want('깨끗한 트리 + 변경 없음 → 통과', clean.code === 0, `exit=${clean.code} ${clean.out.trim()}`);

    writeFileSync(join(dir, 'b.txt'), 'untracked\n');
    const untracked = run();
    want('추적되지 않은 새 파일이 있으면 판정하지 않는다',
      untracked.code === 1 && /커밋되지 않은/.test(untracked.out),
      `exit=${untracked.code} ${untracked.out.trim()}`);
    rmSync(join(dir, 'b.txt'));

    appendFileSync(join(dir, 'a.txt'), 'two\n');
    const modified = run();
    want('추적 파일이 수정돼 있으면 판정하지 않는다',
      modified.code === 1 && /커밋되지 않은/.test(modified.out),
      `exit=${modified.code} ${modified.out.trim()}`);

    g('add', '-A'); g('commit', '-q', '-m', 'second');
    const committed = run();
    want('커밋하면 다시 판정한다', committed.code === 0,
      `exit=${committed.code} ${committed.out.trim()}`);

    // ── 비교 지점이 공통 조상인가 ──
    //
    // 브랜치가 base보다 뒤처지면, base **끝점**과 비교하는 순간 main이
    // 늘린 닻이 브랜치가 지운 것으로 보인다. #561에서 실제로 그랬다:
    // 그 체인은 main보다 104 커밋 뒤였고, 닻을 하나도 지우지 않았는데
    // `NO_FIXED_SL 259 → 249`처럼 **거짓 고발**이 세 건 나왔다.
    //
    // 그래서 뒤처진 브랜치를 실제로 만들어 돌려 본다.
    const runBase = (base) => {
      try {
        const out = execFileSync(process.execPath,
          [self, '--base', base, '--mode', 'trading'],
          { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, out };
      } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
    };
    const GUARD = 'guard.ts';
    const anchors = (n) => Array.from({ length: n }, () => 'reduceOnly').join('\n') + '\n';

    g('checkout', '-q', '-b', 'trunk');
    writeFileSync(join(dir, GUARD), anchors(3));
    g('add', '-A'); g('commit', '-q', '-m', 'guards');
    // 브랜치는 여기서 갈라진다 (= 공통 조상)
    g('checkout', '-q', '-b', 'work');
    writeFileSync(join(dir, 'note.ts'), 'export const x = 1;\n');
    g('add', '-A'); g('commit', '-q', '-m', 'work: 무해한 변경');
    // trunk 가 **닻을 늘린다** — 브랜치는 이 커밋을 갖고 있지 않다
    g('checkout', '-q', 'trunk');
    writeFileSync(join(dir, GUARD), anchors(5));
    g('add', '-A'); g('commit', '-q', '-m', 'trunk: 닻 추가');
    g('checkout', '-q', 'work');

    const behind = runBase('trunk');
    want('뒤처진 브랜치를 닻 제거로 고발하지 않는다 (공통 조상 기준)',
      behind.code === 0 && !/안전 닻이 줄었/.test(behind.out),
      `exit=${behind.code} ${behind.out.trim()}`);

    // 같은 상황에서 **진짜로** 지우면 그대로 걸려야 한다 — 약화가 아니다.
    writeFileSync(join(dir, GUARD), anchors(2));
    g('add', '-A'); g('commit', '-q', '-m', 'work: 닻 진짜 제거');
    const removed = runBase('trunk');
    want('뒤처진 브랜치가 **진짜** 지운 닻은 잡는다',
      removed.code === 1 && /안전 닻이 줄었/.test(removed.out),
      `exit=${removed.code} ${removed.out.trim()}`);

    const noBase = runBase('no/such/ref');
    want('공통 조상을 못 구하면 판정하지 않는다',
      noBase.code === 1 && /공통 조상/.test(noBase.out),
      `exit=${noBase.code} ${noBase.out.trim()}`);

    // ── ③ 권한 표면 — 경로가 아니라 능력으로 막는지 실제로 돌려 본다 ──
    //
    // 정적 추론이 아니다. 임시 저장소에 진짜 워크플로를 만들고 고쳐서
    // 이 검사기를 돌린다. "막는 집합이 줄지 않았다"를 값으로 보인다.
    const WF = '.github/workflows/w.yml';
    const BASE_WF = [
      'name: w', 'on:', '  schedule:', "    - cron: '0 * * * *'",
      'permissions:', '  contents: read', '  actions: read',
      'jobs:', '  j:', '    runs-on: ubuntu-latest', '    timeout-minutes: 10',
      '    steps:', '      - uses: actions/checkout@v4',
      '      - name: 검사', '        run: |', '          node scripts/check-a.mjs',
      '',
    ].join('\n');
    const seedWf = (body) => {
      mkdirSync(join(dir, '.github/workflows'), { recursive: true });
      writeFileSync(join(dir, WF), body);
    };
    const commitAll = (msg) => { g('add', '-A'); g('commit', '-q', '-m', msg); };

    seedWf(BASE_WF); commitAll('wf');
    const wfBase = g('rev-parse', 'HEAD').trim();
    const runWf = () => {
      try {
        const out = execFileSync(process.execPath, [self, '--base', wfBase, '--mode', 'trading'],
          { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, out };
      } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
    };

    // (a) 셸 본문만 바꾼다 → 능력이 안 바뀌므로 통과해야 한다
    seedWf(BASE_WF.replace('node scripts/check-a.mjs', 'node scripts/run-all-checkers.mjs'));
    commitAll('run body');
    const bodyOnly = runWf();
    want('셸 본문만 바꾸면 통과한다 — 능력이 바뀌지 않는다',
      bodyOnly.code === 0, `exit=${bodyOnly.code} ${bodyOnly.out.trim()}`);

    // (b) 주석만 더한다 → 통과해야 한다
    seedWf(BASE_WF.replace('      - name: 검사', '      # 설명 주석\n      - name: 검사'));
    commitAll('comment');
    const commentOnly = runWf();
    want('주석만 더하면 통과한다 — 설명은 능력이 아니다',
      commentOnly.code === 0, `exit=${commentOnly.code} ${commentOnly.out.trim()}`);

    // (c) 토큰 권한을 올린다 → **거부되어야 한다**
    seedWf(BASE_WF.replace('  contents: read', '  contents: write'));
    commitAll('perm');
    const perm = runWf();
    want('토큰 권한을 올리면 거부한다',
      perm.code === 1 && /권한 표면이 바뀌었습니다/.test(perm.out),
      `exit=${perm.code} ${perm.out.trim()}`);

    // (d) 도구 허용 목록을 넓힌다 → **거부되어야 한다**
    seedWf(BASE_WF.replace('        run: |',
      '        run: |\n          claude --allowedTools "Bash(curl:*)"'));
    commitAll('tools');
    const tools = runWf();
    want('도구 허용 목록을 넓히면 거부한다',
      tools.code === 1 && /권한 표면이 바뀌었습니다/.test(tools.out),
      `exit=${tools.code} ${tools.out.trim()}`);

    // (e) 시크릿을 새로 받는다 → **거부되어야 한다**
    seedWf(BASE_WF.replace('    steps:',
      '    env:\n      ADMIN_SECRET: ${{ secrets.ADMIN_SECRET }}\n    steps:'));
    commitAll('secret');
    const secret = runWf();
    want('시크릿을 새로 받으면 거부한다',
      secret.code === 1 && /권한 표면이 바뀌었습니다/.test(secret.out),
      `exit=${secret.code} ${secret.out.trim()}`);

    // (e2) 셸 본문에서 시크릿을 직접 끌어온다 → **거부되어야 한다**
    //
    // GitHub Actions 는 `run:` 안에서도 `${{ secrets.X }}` 를 푼다.
    // `env:` 를 거치지 않으므로 키 줄 패턴으로는 안 잡히고 **`secrets.`
    // 패턴만** 잡는다. 돌연변이 ①이 이 구멍을 찾아냈다 — 처음 시험은
    // `env:` 로 넣어서 다른 패턴에 걸렸고, 그래서 `secrets.` 를 빼도
    // 초록이었다. 시험이 약하면 관문이 약한 것과 구별되지 않는다.
    seedWf(BASE_WF.replace('          node scripts/check-a.mjs',
      '          node scripts/check-a.mjs "${{ secrets.ADMIN_SECRET }}"'));
    commitAll('secret in run');
    const secretRun = runWf();
    want('셸 본문에서 시크릿을 끌어와도 거부한다',
      secretRun.code === 1 && /권한 표면이 바뀌었습니다/.test(secretRun.out),
      `exit=${secretRun.code} ${secretRun.out.trim()}`);

    // (f) 더 자주 깨어나게 한다 → **거부되어야 한다**
    seedWf(BASE_WF.replace("    - cron: '0 * * * *'", "    - cron: '*/5 * * * *'"));
    commitAll('cron');
    const cron = runWf();
    want('더 자주 깨어나게 하면 거부한다',
      cron.code === 1 && /권한 표면이 바뀌었습니다/.test(cron.out),
      `exit=${cron.code} ${cron.out.trim()}`);

    // (f2) 워크플로를 **새로 만든다** → 거부되어야 한다
    //
    // 돌연변이 ⑦이 이 구멍을 찾았다 — "못 읽은 쪽을 통과로" 바꿔도
    // 시험이 전부 초록이었다. 새 파일은 기준 쪽이 없으므로 그 분기로
    // 들어오고, 막지 않으면 회차가 **원하는 권한으로 워크플로를 새로
    // 만들 수 있다.** 고치는 것보다 만드는 쪽이 더 쉬운 길이면 울타리가
    // 아니다.
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/new.yml'),
      'name: new\non:\n  push:\npermissions:\n  contents: write\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n');
    commitAll('new wf');
    const added = runWf();
    want('워크플로를 새로 만들면 거부한다 — 만드는 길이 더 쉬우면 울타리가 아니다',
      added.code === 1 && /새로 만들었습니다/.test(added.out),
      `exit=${added.code} ${added.out.trim()}`);
    rmSync(join(dir, '.github/workflows/new.yml'));
    commitAll('drop new wf');

    // (g) 워크플로를 통째로 지운다 → **거부되어야 한다**
    rmSync(join(dir, WF));
    commitAll('delete wf');
    const del = runWf();
    want('워크플로를 지우면 거부한다 — 울타리가 사라질 수 있다',
      del.code === 1 && /지웠습니다/.test(del.out),
      `exit=${del.code} ${del.out.trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(fails === 0
    ? `✅ 울타리 자기 점검 ${total}/${total} — 커밋되지 않은 변경을 통과로 `
      + '읽지 않고, 비교 지점을 공통 조상으로 잡습니다'
    : `❌ 울타리 자기 점검 실패 ${fails}/${total}건`);
  process.exit(fails ? 1 : 0);
}

const { readFileSync } = await import('node:fs');
const { authorityFindings } = await import('./lib/workflow-authority.mjs');

const git = (...args) => {
  try { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
};

// ── ⓪ 커밋되지 않은 변경이 있으면 판정하지 않는다 ──
//
// 이 검사는 **커밋된 상태만** 본다(아래 `BASE...HEAD`). 그래서 작업 트리에
// 아직 커밋하지 않은 변경이 있으면 그 변경을 **본 적이 없는 채로** ✅를 준다.
//
// 2026-11-02에 실제로 그렇게 통과시켰다. 무인 회차가 커밋 전에 이 검사기를
// 돌리고 "검사기 81/0"이라고 적었는데, 커밋된 HEAD로 다시 재면 마이그레이션
// 규칙(④)에 걸리는 변경이 들어 있었다. 세 PR에서 같은 일이 났다.
//
// 돌지 않은 검사를 통과로 읽는 것이 이 저장소에서 가장 비싼 실패이므로,
// **판정할 수 없는 상태를 통과로 적지 않는다.** 깨끗한 트리에서는 아무
// 영향이 없다(무인 회차 워크플로는 커밋 뒤에 이 단계를 돈다).
const dirty = git('status', '--porcelain');
if (dirty == null) {
  err('작업 트리 상태를 읽지 못했습니다 — 읽지 못한 것을 통과로 보지 않습니다');
  process.exit(1);
}
if (dirty.trim()) {
  // 파일 **이름만** 적는다. 내용은 적지 않는다.
  const names = dirty.split('\n').filter(Boolean).map((l) => l.slice(3)).slice(0, 20);
  err('커밋되지 않은 변경이 있어 판정하지 않습니다 — 이 검사는 커밋된 상태만 봅니다. '
    + '커밋한 뒤 다시 돌리세요');
  for (const n of names) console.error(`     ${n}`);
  const total = dirty.split('\n').filter(Boolean).length;
  if (total > names.length) console.error(`     … 그리고 ${total - names.length}개 더`);
  process.exit(1);
}

// ── 바뀐 파일 목록 ──
// ── 비교 지점은 **공통 조상**이다 ──
//
// 바뀐 파일 목록은 `${BASE}...HEAD`(세 점)로 구한다 — 세 점은 **공통
// 조상 기준** 차이다. 그런데 내용 비교(검사기 단정 수 · 안전 닻 수)는
// `${BASE}`의 **끝점**에서 읽고 있었다. 같은 판단이 두 기준을 쓰면
// 브랜치가 base보다 뒤처진 순간 둘이 어긋난다.
//
// 실측(#561, 2026-11-02): 그 체인은 main보다 **104 커밋 뒤**였고,
// `--base origin/main`으로 돌리면 이렇게 나왔다:
//
//     ❌ 안전 닻이 줄었습니다: `NO_FIXED_SL` 259 → 249건
//     ❌ 안전 닻이 줄었습니다: `reduceOnly` 444 → 438건
//     ❌ 안전 닻이 줄었습니다: `closePosition` 138 → 127건
//
// **그 브랜치는 닻을 하나도 지우지 않았다.** 자기 base와 비교하면
// 145=145 · 377=377 · 112=112로 같았고, 줄어 보인 것은 **main이 그
// 104 커밋에서 닻을 늘렸기** 때문이다. 즉 울타리가 **하지 않은 일로
// 브랜치를 고발**하고 있었다 — 그리고 "안전장치를 지웠다"는 고발은
// 이 저장소에서 가장 비싼 거짓 경보다.
//
// 그래서 내용도 **공통 조상에서** 읽는다. 브랜치가 실제로 지운 것은
// 그대로 걸린다 — 시작점이 공통 조상이기 때문이다.
const MERGE_BASE = (() => {
  const out = git('merge-base', BASE, 'HEAD');
  return out == null ? null : out.trim();
})();
if (!MERGE_BASE) {
  // 공통 조상을 모르면 무엇을 기준으로 비교해야 하는지 모른다.
  err(`기준(${BASE})과의 공통 조상을 찾지 못했습니다 — `
    + '비교 지점을 모르는 채로 통과시키지 않습니다');
  process.exit(1);
}

const nameStatus = git('diff', '--name-status', `${BASE}...HEAD`);
if (nameStatus == null) {
  err(`기준(${BASE})과 비교하지 못했습니다 — 비교하지 못한 것을 통과로 보지 않습니다`);
  process.exit(1);
}
const changed = nameStatus.split('\n').filter(Boolean).map((l) => {
  const [status, ...rest] = l.split('\t');
  return { status, path: rest[rest.length - 1] };
});

if (changed.length === 0) {
  console.log('✅ 변경 없음 — 볼 것이 없습니다 (고칠 것이 없는 회차는 정상입니다)');
  process.exit(0);
}

// ── ③ 제 울타리를 스스로 넓히지 않는다 ──
//
// 무인 회차가 울타리를 넓히는 변경을 스스로 제안할 수 있으면, 그 PR을
// 사람이 놓친 순간 다음 회차부터 울타리가 없다. 그래서 막는다.
//
// **막는 기준은 경로가 아니라 권한이다.** 전에는 `.github/workflows/`
// 아래면 무엇이든 거부했는데, 그러면 취지보다 넓게 막힌다 — 회차가 제
// 권한을 1mm도 넓히지 않는 수정(검사기 전수 한 줄, ci.yml 배선 한 줄)도
// 같은 빨간불로 막혔고, 그때마다 사람이 눌러야 했다. 2026-11-15~18에
// 그 한 줄 때문에 main 이 며칠 빨갰다.
//
// 이제 **권한 표면**(`scripts/lib/workflow-authority.mjs`)을 본다. 깨어나는
// 조건·토큰 권한·시크릿·환경 키·`uses:`·`with:`·도구 허용/차단·겹침·상한.
// 그 표면이 한 글자라도 달라지면 **그대로 거부**한다. 셸 본문과 주석만
// 바뀌었으면 통과한다 — 그 둘은 능력을 바꾸지 않는다.
//
// 막는 집합은 줄지 않았다. 통과시키는 집합이 늘었고, 늘어난 쪽에는
// 권한을 바꾸는 변경이 하나도 없다.
for (const f of changed) {
  if (!f.path.startsWith('.github/workflows/')) continue;
  const before = f.status === 'A' ? null : git('show', `${MERGE_BASE}:${f.path}`);
  const after = f.status === 'D' ? null : (() => {
    try { return readFileSync(f.path, 'utf8'); } catch { return null; }
  })();
  // 읽지 못한 것을 통과로 적지 않는다.
  if (f.status !== 'A' && before == null) {
    err(`${f.path}: 기준 쪽을 읽지 못했습니다 — 못 읽은 것을 통과로 적지 않습니다`);
    continue;
  }
  for (const m of authorityFindings({ path: f.path, before, after })) err(m);
}

// **제출 통로도 울타리다.**
//
// 2026-11-04에 허용 목록에서 `git push`·`gh pr create`를 걷어내고
// 올리는 일을 `scripts/autodev-submit.mjs` 하나로 좁혔다. 그 스크립트가
// refspec과 `--draft`를 글자로 박고 있기 때문에 통로가 좁은 것인데,
// **회차가 그 파일을 고칠 수 있으면 통로를 스스로 넓힐 수 있다** —
// 한 줄만 바꿔 `refs/heads/main`을 적으면 된다. 그래서 워크플로와
// 같은 취급을 한다: 통로 변경은 사람이 직접 연 PR에서만 한다.
const SUBMIT_PATHS = [
  'scripts/autodev-submit.mjs',
  'scripts/lib/autodev-delivery.mjs',
];
for (const f of changed) {
  if (SUBMIT_PATHS.includes(f.path)) {
    err(`무인 회차가 제출 통로를 고쳤습니다: ${f.path} — `
      + '올리는 모양(refspec · --draft · 브랜치 접두어)은 스스로 넓힐 수 없습니다');
  }
}

// ── ④ 마이그레이션은 건드리지 않는다 ──
for (const f of changed) {
  if (f.path.startsWith('supabase/migrations/')) {
    err(`무인 회차가 마이그레이션을 건드렸습니다: ${f.path} — 운영 DB 스키마는 별도 승인 사항입니다`);
  }
}

// ── ⑤ dev 갈래는 거래 엔진에 손대지 않는다 ──
//
// trading 갈래는 **일부러** 여기에 손대라고 만든 것이라 이 규칙을
// 적용하지 않는다. 대신 그쪽은 검증을 더 세게 받는다.
if (MODE === 'dev') {
  const TRADING_PATHS = [
    'src/lib/engine/', 'src/lib/strategies/', 'src/lib/exchanges/',
    'src/lib/smoke/', 'src/lib/execution/', 'src/lib/risk/',
    'src/lib/backtest/', 'worker/',
  ];
  for (const f of changed) {
    const hit = TRADING_PATHS.find((p) => f.path.startsWith(p));
    if (hit) {
      err(`dev 갈래가 거래 엔진 경로를 건드렸습니다: ${f.path} (${hit}) — `
        + `그 수정은 claude-hourly-trading 갈래에서, 더 센 검증을 받고 해야 합니다`);
    }
  }
}

// ── ② 검사기를 지우거나 약하게 만들지 않는다 ──
for (const f of changed) {
  if (!/^scripts\/check-.*\.mjs$/.test(f.path)) continue;
  if (f.status === 'D') {
    err(`검사기를 지웠습니다: ${f.path} — 막는 것을 없애서 통과시키지 않습니다`);
    continue;
  }
  const before = git('show', `${MERGE_BASE}:${f.path}`);
  const after = git('show', `HEAD:${f.path}`);
  if (before == null || after == null) continue;
  // **`err(`만 세면 공허하다.** 이 저장소의 검사기는 보고 방식이
  // 제각각이다 — `err()`를 쓰는 것도 있고 배열에 쌓아 두었다가
  // `console.error`로 뿜는 것도 있다(`check-order-guards.mjs`는
  // `err(`가 0건이라, 처음 쓴 규칙이 그 파일에는 아무것도 막지
  // 못했다). 그래서 **실패를 알리는 신호를 모두** 센다.
  //
  // **주석을 걷어내고 센다.** 처음에는 원문에서 셌는데, 단정을 한 줄
  // 주석 처리해도 글자는 그대로라 44 → 44로 안 줄었다. 막는 것을
  // 지우는 가장 쉬운 방법이 주석 처리인데 그것을 못 보던 셈이다.
  const countSignals = (t) =>
    (stripJsComments(t).match(/\berr\(|\.push\(|console\.error\(/g) || []).length;
  const b = countSignals(before); const a = countSignals(after);
  if (a < b) {
    err(`검사기의 단정이 줄었습니다: ${f.path} (실패 신호 ${b} → ${a}건) — `
      + `검사기가 막으면 검사기가 옳다고 보고 원인을 다시 봅니다`);
  }
}

// ── ① 안전 닻이 줄지 않았는가 ──
//
// 이 저장소가 비싸게 배운 fail-closed 표식들이다. 리팩터링으로 이름이
// 바뀔 수도 있지만, **무인 회차에서는 그 판단을 하지 않는다** —
// 이름을 바꿔야 한다면 사람이 연 PR에서 한다.
const ANCHORS = [
  'maySend: false',
  "fail('BLOCKED'",
  'killSwitchGate',
  'quantizeOrder(',
  'roundTrigger(',
  'unresolvedExposureBlock(',
  'smokeTestnetVerdict(',
  'unprotectedExposureVerdict(',
  'residualVerdict(',
  'NO_FIXED_SL',
  'NO_FIXED_TP',
  'reduceOnly',
  'closePosition',
];

/** 추적 중인 소스 전체에서 닻이 몇 번 나오는가 */
function anchorCounts(ref) {
  const out = {};
  for (const a of ANCHORS) out[a] = 0;
  const list = git('ls-tree', '-r', '--name-only', ref);
  if (list == null) return null;
  const files = list.split('\n').filter((p) => /\.(ts|tsx|mjs)$/.test(p));
  for (const p of files) {
    const body = git('show', `${ref}:${p}`);
    if (body == null) continue;
    for (const a of ANCHORS) {
      let i = 0; let n = 0;
      for (;;) { const k = body.indexOf(a, i); if (k < 0) break; n += 1; i = k + a.length; }
      out[a] += n;
    }
  }
  return out;
}

{
  // 소스 파일이 하나도 안 바뀌었으면 셀 필요가 없다 — 느린 작업이다.
  const touchedSource = changed.some((f) => /\.(ts|tsx|mjs)$/.test(f.path));
  if (touchedSource) {
    const before = anchorCounts(MERGE_BASE);
    const after = anchorCounts('HEAD');
    if (!before || !after) {
      err('안전 닻을 세지 못했습니다 — 세지 못한 것을 통과로 보지 않습니다');
    } else {
      for (const a of ANCHORS) {
        if (after[a] < before[a]) {
          err(`안전 닻이 줄었습니다: \`${a}\` ${before[a]} → ${after[a]}건 — `
            + `fail-closed 분기를 지워서 시험을 통과시키지 않습니다. `
            + `이름을 바꿔야 한다면 사람이 연 PR에서 하세요`);
        }
      }
    }
  }
}

if (bad === 0) {
  console.log(`✅ 무인 회차 변경 안전 (${MODE}) — 파일 ${changed.length}개 · `
    + '안전 닻 유지 · 검사기 유지 · 울타리/마이그레이션 무변경');
} else {
  console.error('');
  console.error('   무인 회차는 사람이 보지 않는 시간에 돕니다.');
  console.error('   막고 있던 것을 지워서 초록을 만드는 것이 가장 비싼 실패입니다.');
}
process.exit(bad ? 1 : 0);
