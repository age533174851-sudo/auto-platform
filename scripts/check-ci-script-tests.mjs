#!/usr/bin/env node
// scripts/check-ci-script-tests.mjs
//
// **CI가 파일 이름을 손으로 적어 시험을 돌리면, 새 시험은 안 돈다.**
//
// 무엇이 실제로 일어났나
// ──────────────────────
// `ci.yml`은 `.mjs` 시험을 이렇게 돌리고 있었다:
//
//     - name: Claude 무인 회차 진단기 회귀
//       run: |
//         node --test scripts/test-claude-api-preflight.mjs
//         node --test scripts/test-claude-exec-category.mjs
//
// 그 단계 위에는 이런 주석이 붙어 있었다 — **위험을 이미 알고 있었다**:
//
//     `npm test`는 TypeScript 러너라 `.mjs` 시험이 안 걸린다. 여기서
//     돌리지 않으면 PR에서 한 번도 안 돈다 — 이 저장소가 이미 당한 모양이다.
//
// 그런데 그 목록은 **손으로 적은 목록**이었다. `scripts/test-*.mjs`가
// 다섯 개로 늘어나는 동안 목록은 둘에 멈춰 있었고, 나머지 셋은
// **PR에서 한 번도 돌지 않았다**:
//
//     scripts/test-pipeline.mjs                    (파이프라인 배선 18건)
//     scripts/test-check-claude-hourly-settings.mjs
//     scripts/test-pr-facts.mjs
//
// 그래서 `test-pipeline.mjs`가 main에서 **죽어 있는데도** CI는 초록이었다
// (#593이 그 RED를 찾아냈다). `CLAUDE.md`의 "경로가 둘인데 한쪽만 고침"이
// 한 층 위에서 또 일어난 것이다.
//
// 무엇을 지키는가
// ───────────────
// 디스크에 있는 모든 `scripts/test-*.mjs`를 `ci.yml`이 실제로 돌리는가.
// "적혀 있는가"가 아니라 **`node --test`로 돌리는가**를 본다 —
// `paths:` 필터에 경로가 적혀 있는 것은 돌리는 것이 아니다.
//
// 목록을 늘려 주는 것이 아니라 **목록을 없애는 것**이 통과 조건이다:
// 글롭(`scripts/test-*.mjs`) 하나면 다음에 생기는 시험도 자동으로 돈다.

import { readdirSync, readFileSync } from 'fs';
import { stripYamlComments } from './lib/strip-comments.mjs';

const CI = '.github/workflows/ci.yml';

/** `scripts/`에 있는 시험 파일 이름 (정렬) */
export function testFileNames(dir = 'scripts') {
  return readdirSync(dir)
    .filter(n => /^test-.+\.mjs$/.test(n))
    .sort();
}

/**
 * `node --test ...`로 **실제로 돌려지는** 경로 토큰.
 *
 * 같은 줄에 `node --test`가 있어야 한다. 주석 처리된 줄은 세지 않는다.
 */
export function runTokens(yamlText) {
  const tokens = [];
  for (const line of stripYamlComments(yamlText).split('\n')) {
    if (!/node\s+--test/.test(line)) continue;
    for (const m of line.matchAll(/scripts\/test-[^\s'"`;|&)]*\.mjs/g)) tokens.push(m[0]);
  }
  return tokens;
}

/** 토큰 하나가 파일 이름을 덮는가 (글롭 `*` 포함) */
export function tokenCovers(token, name) {
  const want = `scripts/${name}`;
  if (!token.includes('*')) return token === want;
  const rx = new RegExp('^' + token.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
  return rx.test(want);
}

export function scriptTestFindings(i) {
  const names = Array.isArray(i?.names) ? i.names : null;
  const yaml = typeof i?.yaml === 'string' ? i.yaml : null;
  const out = [];
  if (yaml === null) return [{ code: 'NO_CI', msg: `${CI}를 읽지 못했습니다 — 통과로 보지 않습니다` }];
  if (!names || names.length === 0) {
    return [{ code: 'NO_TESTS', msg: 'scripts/test-*.mjs를 하나도 찾지 못했습니다 — 검사할 것이 없는 것이 아니라 못 본 것입니다' }];
  }
  const tokens = runTokens(yaml);
  if (tokens.length === 0) {
    out.push({ code: 'NO_RUN_STEP', msg: `${CI}에 \`node --test scripts/test-…\` 단계가 없습니다 — .mjs 시험은 \`npm test\`에 걸리지 않습니다` });
  }
  for (const name of names) {
    if (!tokens.some(t => tokenCovers(t, name))) {
      out.push({ code: 'NOT_RUN', msg: `scripts/${name} — CI가 돌리지 않습니다. 이름을 하나 더 적는 대신 \`node --test scripts/test-*.mjs\`로 목록을 없애세요` });
    }
  }
  return out;
}

const CASES = [
  { n: '글롭 하나면 전부 덮는다', names: ['test-a.mjs', 'test-b.mjs'],
    yaml: '        run: node --test scripts/test-*.mjs', want: [] },
  { n: '이름을 적은 목록에서 하나가 빠지면 잡는다', names: ['test-a.mjs', 'test-b.mjs'],
    yaml: '        run: |\n          node --test scripts/test-a.mjs', want: ['NOT_RUN'] },
  { n: '★ 주석 처리된 실행 줄은 돌리는 것이 아니다', names: ['test-a.mjs'],
    yaml: '        run: |\n          # node --test scripts/test-a.mjs', want: ['NO_RUN_STEP', 'NOT_RUN'] },
  { n: '★ paths 필터에 적혀 있는 것은 돌리는 것이 아니다', names: ['test-a.mjs'],
    yaml: "    paths:\n      - 'scripts/test-*.mjs'", want: ['NO_RUN_STEP', 'NOT_RUN'] },
  { n: '다른 디렉터리 글롭은 덮지 않는다', names: ['test-a.mjs'],
    yaml: '        run: node --test worker/test-*.mjs', want: ['NO_RUN_STEP', 'NOT_RUN'] },
  { n: '시험 파일을 하나도 못 찾으면 통과가 아니다', names: [],
    yaml: '        run: node --test scripts/test-*.mjs', want: ['NO_TESTS'] },
  { n: 'ci.yml 을 못 읽으면 통과가 아니다', names: ['test-a.mjs'], yaml: null, want: ['NO_CI'] },
  { n: '값 안의 # 을 주석으로 읽지 않는다', names: ['test-a.mjs'],
    yaml: '        run: node --test scripts/test-a.mjs  # 이유', want: [] },
];

export function selfTest() {
  let pass = 0; const fail = [];
  for (const c of CASES) {
    const got = scriptTestFindings({ names: c.names, yaml: c.yaml }).map(f => f.code).sort();
    const want = [...c.want].sort();
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else fail.push(`${c.n}: 기대 ${JSON.stringify(want)}, 실제 ${JSON.stringify(got)}`);
  }
  return { total: CASES.length, pass, fail };
}

function main() {
  const st = selfTest();
  if (st.fail.length > 0) {
    console.error('❌ 검사기 자기 점검 실패');
    for (const f of st.fail) console.error('   ·', f);
    process.exit(1);
  }
  let yaml = null;
  try { yaml = readFileSync(CI, 'utf8'); } catch {}
  let names = null;
  try { names = testFileNames(); } catch {}
  const findings = scriptTestFindings({ names, yaml });
  if (findings.length > 0) {
    for (const f of findings) {
      console.error(`❌ [${f.code}] ${f.msg}`);
      console.log(`::error::[${f.code}] ${f.msg}`);
    }
    process.exit(1);
  }
  console.log(`✅ CI가 scripts/test-*.mjs ${names.length}개를 전부 돌립니다 (자기 점검 ${st.pass}/${st.total})`);
  for (const n of names) console.log(`   · ${n}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
