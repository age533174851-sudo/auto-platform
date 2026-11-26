#!/usr/bin/env node
// scripts/check-test-registry.mjs
//
// **테스트가 두 번 등록되면 개수는 늘고 검증력은 그대로다.**
//
// 무엇이 실제로 일어났나
// ──────────────────────
// PR을 최신 main에 재배치할 때 `scripts/run-tests.mjs`의 등록 줄이
// 충돌했다. 양쪽 다 그 한 줄에 `runXTests()`를 덧붙였기 때문이다.
// 기계적으로 양쪽을 남기자 **같은 테스트가 두 번 등록**됐고, 개수가
// 4,279에서 6,090으로 뛰었다.
//
// 이게 나쁜 이유는 개수가 틀려서가 아니다:
//
//   · 전부 통과하므로 **CI는 초록이다.** 아무도 안 본다
//   · "테스트 6천 개 통과"라는 숫자가 실제보다 두 배로 보인다
//   · 반대 방향의 사고 — 재배치가 등록 줄을 통째로 한쪽 것으로
//     덮으면 **테스트 뭉치가 조용히 사라진다.** 그때도 CI는 초록이다
//
// 두 번째가 진짜 위험하다. 없어진 테스트는 없어졌다는 표시가 없다.
//
// 자동 재배치가 이걸 더 위험하게 만든다
// ─────────────────────────────────────
// `auto-rebase` 워크플로가 생기면서 재배치를 기계가 한다. 깨끗하게
// 재배치되는 것만 하지만, **이 등록 줄은 깨끗하게 재배치되기도 한다** —
// 한쪽 줄이 통째로 이기면 충돌이 안 난다. 그래서 사람이 안 볼 때
// 테스트가 사라질 수 있다.
//
// 그 구멍을 이 검사가 막는다.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const RUNNER = 'scripts/run-tests.mjs';
const ROOTS = ['src', 'worker/src'];

/**
 * **훑지 못한 디렉터리를 적어 둔다.**
 *
 * 예전에는 `catch { return out; }`이었다. 뿌리가 없거나 읽히지 않으면
 * 그 뿌리의 시험이 **조용히 검사 밖으로 나갔고**, 집계는 그래도
 * `미등록 0`이라고 적었다. 실측했다 (2026-11-26, main ed00c1a4):
 *
 *   worker/src에 등록 안 된 시험을 심고 돌리면 → ❌ (맞다)
 *   같은 파일을 둔 채 그 뿌리 경로만 바꾸면   → ✅ 테스트 파일 395개 ·
 *                                              등록 414개 · 미등록 0 (rc=0)
 *   readdirSync를 전부 빈 결과로 만들면       → ✅ 테스트 파일 0개 ·
 *                                              등록 414개 · 미등록 0 (rc=0)
 *
 * 이 파일의 머리말이 막으려던 고장이 "테스트 뭉치가 조용히 사라지고
 * 그때도 CI는 초록"인데, **검사기 자신이 같은 모양으로 비어 있었다.**
 * 못 본 것은 통과가 아니다.
 */
function walk(dir, out = [], failures = []) {
  let names;
  try { names = readdirSync(dir); }
  catch (e) { failures.push(`${dir} (${errCode(e)})`); return out; }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); }
    catch (e) { failures.push(`${p} (${errCode(e)})`); continue; }
    if (st.isDirectory()) walk(p, out, failures);
    else if (name.endsWith('.test.ts')) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

/** 예외에서 원인 코드만 꺼낸다 — 경로 외의 내용은 적지 않는다 */
function errCode(e) {
  const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : String(e);
  return code.slice(0, 40);
}

const runner = readFileSync(RUNNER, 'utf8');

// ── 등록된 것 ──
//
// **별칭(`as`)을 놓치지 않는다.** 러너에는 `runWalletTests as
// runWalletScreenTests`처럼 이름을 바꿔 가져오는 줄이 있다. 별칭을
// 못 읽으면 "import 없이 부르는 테스트"라는 거짓 실패가 난다 —
// 검사가 틀리면 사람들은 검사를 끈다.
const imported = new Map();   // 러너 안에서 부르는 이름 → { path, exportName }
for (const m of runner.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
  const [, names, path] = m;
  for (const piece of names.split(',')) {
    const t = piece.trim();
    if (!t) continue;
    const as = /^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)$/.exec(t);
    const exportName = as ? as[1] : t;
    const localName = as ? as[2] : t;
    if (!/^run[A-Za-z0-9_]*Tests$/.test(localName)) continue;
    if (imported.has(localName)) {
      console.error(`❌ ${localName}을(를) 두 번 import합니다 — ${imported.get(localName).path} · ${path}`);
      process.exit(1);
    }
    imported.set(localName, { path, exportName });
  }
}
/** 파일이 실제로 내보내는 이름들. 별칭을 거쳐도 등록된 것으로 센다 */
const registeredExports = new Set([...imported.values()].map(v => `${v.path}#${v.exportName}`));

const calls = [...runner.matchAll(/\b(run[A-Za-z0-9_]*Tests)\s*\(\s*\)/g)].map(m => m[1]);
const callCount = new Map();
for (const c of calls) callCount.set(c, (callCount.get(c) ?? 0) + 1);

const problems = [];

// 1. 두 번 부르는 것 — 개수가 부푼다
const doubled = [...callCount.entries()].filter(([, n]) => n > 1);
if (doubled.length > 0) {
  problems.push({
    what: '두 번 등록된 테스트',
    detail: doubled.map(([n, c]) => `${n} ×${c}`),
    why: '개수만 늘고 검증력은 그대로입니다. 전부 통과하므로 CI는 초록입니다',
  });
}

// 2. 가져왔는데 안 부르는 것 — **조용히 사라진 테스트다**
const notCalled = [...imported.keys()].filter(n => !callCount.has(n));
if (notCalled.length > 0) {
  problems.push({
    what: '가져왔는데 실행하지 않는 테스트',
    detail: notCalled,
    why: '없어진 테스트는 없어졌다는 표시가 없습니다 — CI는 그대로 초록입니다',
  });
}

// 3. 부르는데 안 가져온 것 — 러너가 아예 안 돈다(빠르게 실패하지만 이유를 적어 준다)
const notImported = [...callCount.keys()].filter(n => !imported.has(n));
if (notImported.length > 0) {
  problems.push({
    what: 'import 없이 부르는 테스트', detail: notImported,
    why: '러너가 컴파일되지 않습니다',
  });
}

// 4. 파일은 있는데 등록이 안 된 것 — **써 놓고 배선을 안 한 테스트다**
// **뿌리마다 따로 센다.** 어느 뿌리가 0으로 떨어졌는지 집계 줄에 남는다.
//
// 뿌리마다 "1개 이상"을 요구하지는 **않는다.** 실측하면 worker/src의
// `.test.ts`는 정상 저장소에서 0개다(파일 5개 중 0개). 그걸 빨강으로
// 만들면 건강한 저장소가 막히고, 그렇게 막는 검사는 사람이 끈다.
// 구분해야 하는 것은 **"걸었는데 0개"와 "걷지 못했다"**다.
const walkFailures = [];
const perRoot = ROOTS.map(r => ({ root: r, files: walk(r, [], walkFailures) }));
const files = perRoot.flatMap(p => p.files);
const fileSet = new Set(files);

if (walkFailures.length > 0) {
  problems.push({
    what: '훑지 못한 디렉터리',
    detail: walkFailures,
    why: '못 본 것은 통과가 아닙니다 — 그 아래의 시험은 등록 검사를 받지 않고,'
      + ' 집계에는 "미등록 0"으로 적힙니다',
  });
}
if (files.length === 0) {
  problems.push({
    what: '시험 파일을 하나도 찾지 못했습니다',
    detail: [`뿌리 ${ROOTS.join(' · ')} · 러너 등록은 ${imported.size}개입니다`],
    why: '발견이 0이면 아래 "미등록"·"러너 미내보냄"·"얹혀 도는 러너" 검사가'
      + ' 전부 빈 집합을 보고 통과합니다 — 이 검사가 아무것도 지키지 않습니다',
  });
}
/** 같은 파일을 두 번 읽지 않는다 — 아래 '얹혀 도는 러너' 검사도 이걸 쓴다 */
const srcByFile = new Map();
const orphans = [];
const runnerless = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  srcByFile.set(f, src);
  // **`async`를 빠뜨리면 검사가 그 파일을 통째로 건너뛴다.**
  //
  // 원래 이 정규식은 `export function`만 봤다. 그런데 통합시험은 전부
  // `export async function run...Tests`다 — 주문 경로·강제 진입·보유
  // 연장·킬 청산·스모크 시작·Exact100X, 여섯 파일이 조용히 검사 밖에
  // 있었다. 그 중 orderPathIntegration.test.ts 하나에만 러너가 셋이다.
  //
  // 이 검사가 존재하는 이유가 "재배치가 등록 줄을 덮으면 테스트 뭉치가
  // 조용히 사라진다"인데, **정작 가장 무거운 시험들이 그 보호 밖에
  // 있었다.** 사라져도 초록이었을 것이다.
  const exported = [...src.matchAll(/export\s+(?:async\s+)?function\s+(run[A-Za-z0-9_]*Tests)\s*\(/g)].map(m => m[1]);

  // ── 러너를 아예 안 내보내는 시험 파일 ──
  //
  // 예전에는 `continue`로 넘겼다. "등록할 것이 없다"는 뜻으로 읽은
  // 것인데, 실제로는 **그 파일의 test()들이 영영 실행되지 않는다**는
  // 뜻이다. 러너는 export된 함수를 불러서 돌리므로, 내보내지 않으면
  // 아무도 그 파일을 import하지 않는다.
  //
  // 그러고도 집계는 '미등록 0'이라고 적혔다 — 시험을 쓴 사람은 통과한
  // 줄 안다. **이 검사가 막으려던 고장 그대로다.**
  if (exported.length === 0) {
    if (/^\s*(?:await\s+)?test\s*\(/m.test(src)) runnerless.push(f);
    continue;
  }
  // 러너의 import 경로는 './src/...' 꼴이고 파일 경로는 'src/...' 꼴이다.
  const rel = './' + f.replace(/\.ts$/, '');
  const missing = exported.filter(n =>
    !registeredExports.has(`${rel}#${n}`) && !imported.has(n));
  if (missing.length > 0) orphans.push(`${f} → ${missing.join(', ')}`);
}
if (orphans.length > 0) {
  problems.push({
    what: '파일은 있는데 러너에 등록되지 않은 테스트',
    detail: orphans,
    why: '이 저장소가 반복해서 겪은 고장입니다 — 만들어 놓고 배선을 안 함',
  });
}

// 5. test()는 쓰는데 러너를 안 내보내는 파일 — **아무도 부를 수 없다**
if (runnerless.length > 0) {
  problems.push({
    what: 'test()를 쓰는데 러너를 내보내지 않는 시험 파일',
    detail: runnerless.map(f => `${f} → export function run...Tests() 로 감싸고 러너에 등록하세요`),
    why: 'export가 없으면 러너가 그 파일을 import하지 않습니다 — 한 번도 실행되지 않고, 집계에는 안 잡힙니다',
  });
}

// 6. 시험 파일이 **다른 시험 파일의 러너**를 부른다
//
// 실제로 일어난 일: `src/lib/portfolio/returns.test.ts`가
// `runDripTests()`를 불렀다. 그 자리 주석에 이유까지 적혀 있었다 —
// "`run-tests.mjs` 등록 목록은 열린 PR 여럿이 같이 고치고 있어, 줄 하나를
// 더 얹으면 그 PR들과 겹친다".
//
// 그 회피는 두 방향으로 깨진다:
//
//   · **등록 없이 얹히면** 이 검사는 '미등록'이라 말하지만, 사람 눈에는
//     시험이 돌고 있으니 아무도 고치지 않는다. 그리고 얹힌 쪽 파일을
//     나중에 손보면 그 시험 뭉치가 조용히 사라진다
//   · **등록까지 되면 두 번 돈다.** 그런데 이 검사는 러너 파일만 보므로
//     `중복 0`이라고 적었다. 실측했다 — drip 5건이 두 번 돌아 8054가
//     8059가 됐고 검사는 종료 0이었다. **거짓 초록이다**
//
// `run-tests.mjs`의 충돌은 집합 합치기로 푸는 것이 이 저장소의 규칙이다.
// 남의 시험 파일에 얹어서 피하지 않는다.
function normalizeRel(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

const piggyback = [];
for (const f of files) {
  const src = srcByFile.get(f) ?? '';
  const dir = f.slice(0, f.lastIndexOf('/'));
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const [, names, spec] = m;
    if (!spec.startsWith('.')) continue;            // 패키지 import는 대상이 아니다
    const target = normalizeRel(`${dir}/${spec}`) + '.ts';
    if (target === f || !fileSet.has(target)) continue;   // 시험 파일을 부른 것만 본다
    for (const piece of names.split(',')) {
      const t = piece.trim();
      if (!t) continue;
      const as = /^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)$/.exec(t);
      const exportName = as ? as[1] : t;
      const local = as ? as[2] : t;
      if (!/^run[A-Za-z0-9_]*Tests$/.test(local)) continue;
      // **가져오기만 한 것은 문제가 아니다.** 실제로 부르는 것만 센다
      if (!new RegExp(`\\b${local}\\s*\\(\\s*\\)`).test(src)) continue;
      const registered = imported.has(local)
        || registeredExports.has(`./${target.replace(/\.ts$/, '')}#${exportName}`);
      piggyback.push(`${f} → ${local}() (${target})`
        + (registered
            ? ' — 러너에도 등록돼 있습니다. **두 번 돕니다**'
            : ' — 러너에 등록되지 않은 채 여기에 얹혀 돕니다'));
    }
  }
}
if (piggyback.length > 0) {
  problems.push({
    what: '다른 시험 파일에 얹혀 도는 러너',
    detail: piggyback,
    why: '등록 목록이 더 이상 무엇이 도는지 말하지 않습니다 — 등록까지 돼 있으면 두 번 돌고, 그때도 CI는 초록입니다',
  });
}

if (problems.length > 0) {
  console.error('❌ 테스트 등록이 어긋났습니다\n');
  for (const p of problems) {
    console.error(`  ${p.what}`);
    for (const d of p.detail) console.error(`    · ${d}`);
    console.error(`    ${p.why}\n`);
  }
  console.error(`고치는 곳: ${RUNNER}`);
  console.error('(재배치 충돌을 기계적으로 해소하면 이 줄이 잘 깨집니다 —');
  console.error(' 양쪽을 다 남기면 두 번 등록되고, 한쪽으로 덮으면 통째로 사라집니다)');
  process.exit(1);
}

const tally = perRoot.map(p => `${p.root} ${p.files.length}개`).join(' · ');
console.log(`✅ 테스트 파일 ${files.length}개(${tally}) · 등록 ${imported.size}개`
  + ' · 중복 0 · 미등록 0 · 얹혀 도는 러너 0 · 훑지 못한 디렉터리 0');
