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

function walk(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.test.ts')) out.push(p.replace(/\\/g, '/'));
  }
  return out;
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
const files = ROOTS.flatMap(r => walk(r));
const orphans = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const exported = [...src.matchAll(/export\s+function\s+(run[A-Za-z0-9_]*Tests)\s*\(/g)].map(m => m[1]);
  if (exported.length === 0) continue;
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

console.log(`✅ 테스트 파일 ${files.length}개 · 등록 ${imported.size}개 · 중복 0 · 미등록 0`);
