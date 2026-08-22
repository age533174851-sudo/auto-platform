#!/usr/bin/env node
// scripts/check-first-eval.mjs
//
// **자동매매를 켜는 순간, 실평가는 한 경로뿐이어야 한다.**
//
// 무슨 일이 있었나
// ────────────────
// `AutotradeControl.save()`가 예약을 저장한 뒤 `runFirstCheck()`를 불렀다.
// 그건 `checkOnly`가 아니라 **진짜 실행 요청**이었다. 그런데 서버의
// `POST /api/autotrade/schedule`도 저장 직후 `evaluateIfDue()`를 돌린다.
// 즉 켜는 순간 실평가가 둘이었다:
//
//   POST /api/autotrade/schedule
//     ├ 예약 저장
//     └ 서버가 evaluateIfDue() 실행        ← 첫 번째
//   → runFirstCheck() → 전략 API POST      ← 두 번째
//
// 아래쪽 중복 방어(`last_run_at` compare-and-set · 결정적 clientOrderId)가
// 받아 주고 있었다. **그래도 유지할 이유가 없다** — 방어 하나가 약해지는
// 날 주문이 두 번 나가고, 그 날은 이 구조를 모르는 사람이 코드를 고칠
// 때 온다.
//
// 무엇을 막는가
// ─────────────
// 브라우저 코드가 전략 실행기를 **`checkOnly` 없이** 부르는 것.
// 화면은 점검(`checkOnly: true`)만 부른다. 실평가는 서버와 Worker
// 둘뿐이고, 그 둘은 `last_run_at` 선점으로 한 번만 돈다.
//
// 이 검사가 없으면 `runFirstCheck` 같은 함수가 조용히 다시 생긴다.
import { readFileSync, globSync } from 'node:fs';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };

/**
 * 전략 실행기 주소는 **레지스트리에서 읽는다.**
 * 여기에 목록을 또 적으면 전략을 추가할 때 한쪽만 바뀐다.
 */
function strategyRoutes() {
  const src = readFileSync('src/lib/strategies/registry.ts', 'utf8');
  const out = new Set();
  for (const line of src.split('\n')) {
    const m = /^\s*route:\s*'([^']+)'/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/**
 * 주문을 내지 않는 플래그 이름은 **checkFlag.ts에서 읽는다.**
 * 여기 `['checkOnly','dryRun']`을 또 적으면 이름이 하나 늘어난 날
 * 이 검사만 모르고, 멀쩡한 점검 호출을 실행이라고 부른다.
 */
function checkFlagNames() {
  const src = readFileSync('src/lib/strategies/checkFlag.ts', 'utf8');
  const m = /export const CHECK_FLAGS\s*=\s*\[([^\]]+)\]/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** 줄 주석·블록 주석을 지운다. 왜 없앴는지 설명하려면 경로를 적어야 한다 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*)/.test(l) ? '' : l.replace(/\/\/.*$/, '')))
    .join('\n');
}

/** `fn(` 뒤의 괄호가 닫히는 곳까지 */
function argsOf(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

const ROUTES = strategyRoutes();
if (ROUTES.length === 0) {
  err('registry.ts에서 전략 실행기 주소를 하나도 못 읽었습니다 — 검사가 아무것도 안 보고 통과할 뻔했습니다');
}
const FLAGS = checkFlagNames();
if (FLAGS.length === 0) {
  err('checkFlag.ts에서 CHECK_FLAGS를 못 읽었습니다 — 그러면 모든 호출이 실행으로 보입니다');
}
/** `checkOnly: true` 또는 `dryRun: true` */
const NO_ORDER = new RegExp(`(${FLAGS.join('|')})\\s*:\\s*true`);

const BROWSER_FILES = [
  ...globSync('src/components/**/*.tsx'),
  ...globSync('src/components/**/*.ts'),
  ...globSync('src/app/**/*.tsx'),
].map((f) => f.replaceAll('\\', '/'));

let checked = 0;

for (const f of BROWSER_FILES) {
  let raw = '';
  try { raw = readFileSync(f, 'utf8'); } catch { continue; }
  const src = stripComments(raw);

  // ① 전략 요청을 조립하는 곳은 반드시 `checkOnly: true`를 넣는다.
  //    (`strategyRunRequest`가 주소를 숨기므로 주소만 찾아서는 못 잡는다)
  let idx = src.indexOf('strategyRunRequest(');
  while (idx >= 0) {
    checked += 1;
    const args = argsOf(src, idx + 'strategyRunRequest'.length);
    if (!NO_ORDER.test(args)) {
      const line = src.slice(0, idx).split('\n').length;
      err(`${f}:${line}\n     브라우저가 전략 실행기를 점검 플래그 없이 부릅니다`
        + '\n     이건 점검이 아니라 진짜 실행 요청입니다'
        + '\n     자동매매를 켤 때 실평가가 두 경로가 됩니다 — 서버(evaluateIfDue)와 여기'
        + '\n     화면은 점검(checkOnly/dryRun)만 부르고, 첫 평가 결과는 서버 응답(firstEvaluation)을 그립니다');
    }
    idx = src.indexOf('strategyRunRequest(', idx + 1);
  }

  // ② 주소를 직접 적어서 부르는 곳도 같은 규칙을 받는다.
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    for (const route of ROUTES) {
      if (!line.includes(`'${route}'`) && !line.includes(`"${route}"`) && !line.includes(`\`${route}\``)) continue;
      checked += 1;
      // 같은 fetch 호출 안(뒤 25줄)에 checkOnly가 있어야 한다.
      const window = lines.slice(i, i + 25).join('\n');
      if (!NO_ORDER.test(window)) {
        err(`${f}:${i + 1}\n     브라우저가 전략 실행기(${route})를 점검 플래그 없이 부릅니다`
          + '\n     자동매매를 켤 때 실평가가 두 경로가 됩니다'
          + `\n     ${line.trim().slice(0, 110)}`);
      }
    }
  });
}

if (bad === 0) {
  console.log(`✅ 브라우저 전략 호출 ${checked}곳 전부 점검(${FLAGS.join('/')}) · 실평가 경로는 서버(evaluateIfDue)와 Worker poll뿐`);
} else {
  console.error('');
  console.error('   실평가 경로가 둘이면 아래쪽 중복 방어에 기대는 것입니다.');
  console.error('   방어 하나가 약해지는 날 주문이 두 번 나갑니다.');
}
process.exit(bad ? 1 : 0);
