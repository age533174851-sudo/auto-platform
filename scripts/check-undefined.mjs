#!/usr/bin/env node
// scripts/check-undefined.mjs
//
// **런타임 ReferenceError 사전 탐지.**
//
// tsc의 TS2304(Cannot find name) 중 "값 위치"에서 쓰인 것만 골라낸다.
// 타입 위치(useState<X>, as X, : X)는 컴파일 시 소거되므로 제외한다.
//
// 못 본 것을 "없다"로 적던 자리
// ─────────────────────────────
// 예전 이 파일은 tsc를 이렇게 불렀다:
//
//     execSync('npx tsc --noEmit 2>&1 || true')
//
// `|| true`가 **실패를 전부 삼켰고**, 종료코드를 보지 않았다. 그래서
// tsc가 프로젝트를 검사하지 못한 경우에도 TS2304 줄이 없으니
// "✅ 런타임 미정의 식별자 없음"을 찍고 **0으로 끝났다.**
//
// 실측(2026-11-10, main `220f8001`):
//
//   · `tsconfig.json`을 치우면 `npx tsc --noEmit`은 **사용법 배너**를
//     출력한다(`Version 5.9.3` / `COMMON COMMANDS`). 그 상태에서 값 위치
//     미정의 식별자 1건을 심어 두고 이 검사기를 돌렸더니
//     **`✅ 런타임 미정의 식별자 없음` · exit 0** 이었다.
//
// 즉 "검사하지 못했다"가 "위험이 없다"로 적혔다. `CLAUDE.md`의
// **UNKNOWN을 0으로 적지 않는다**가 정확히 이 자리다.
//
// 같은 판단이 두 곳에 있고 한쪽만 굳어 있었다
// ───────────────────────────────────────────
// `.github/workflows/ci.yml`의 타입 에러 개수 단계는 **같은 tsc 출력**을
// 읽는데, 거기에는 이 보호가 이미 있다. 그 주석이 사고를 적어 두었다:
//
//   > 파싱 오류가 나면 tsc가 그 파일에서 멈춰 **에러가 줄어든다.**
//   > 실제로 80건이 1건이 된 적이 있고, 그때 이 검사는 통과했다.
//   > TS1127이 빠져 있어서 같은 사고가 다시 났다 — 73건 → 2건으로
//   > 멈췄고, 이 검사는 "줄었으니 기준선을 내려 주세요"만 띄우고 통과했다.
//
// 파싱이 멈추면 **뒤쪽 파일의 TS2304는 아예 나오지 않는다.** 그러니
// 개수 검사보다 이 검사기가 더 직접적으로 속는다. 여기도 같은 원리를
// 쓴다: TS1xxx는 전부 문법 계열이고, 기준선에 상주하는 것만 허용하고
// 그 밖의 TS1xxx는 **개수와 무관하게 실패**시킨다.
//
// 종료코드로 판정하지 않는 이유
// ─────────────────────────────
// 처음에는 "믿는 종료코드는 {0,2}뿐"으로 짰다. **실측에서 틀렸다.**
// 같은 트리·같은 명령인데 한 번은 2, 세 번은 1이 나왔다(`npx tsc`와
// `node_modules/.bin/tsc`, bash와 `execFileSync` 모두 1). 73건의 진단은
// 네 번 다 그대로 나왔다.
//
// 그 값에 기대면 이 검사기는 **깜빡이는 검사기**가 된다. `ci.yml`이
// 같은 자리에 적어 둔 말이 그대로 적용된다 — "오탐이 한 번 나면
// 다음부터 아무도 안 본다."
//
// 그래서 종료코드가 아니라 **양의 증거**로 판정한다: 출력이 tsc의
// 진단으로 보이는가, 그리고 검사를 못 한 흔적(사용법 배너 · 설정 오류 ·
// 문법 중단)이 없는가. 종료코드는 "0이 아닌데 진단이 하나도 없다"는
// 한 가지에만 쓴다 — 그때는 출력이 잘렸거나 죽은 것이다.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

export const TYPE_CTX = [
  /useState<\s*NAME/, /useRef<\s*NAME/, /useMemo<\s*NAME/,
  /:\s*NAME\b/, /\bas\s+(\[)?NAME\b/, /<NAME>/,
  /Record<[^>]*\bNAME\b/, /Array<\s*NAME/, /Partial<\s*NAME/,
  /\bNAME\[\]/, /extends\s+NAME\b/, /interface\s+NAME\b/, /type\s+NAME\b/,
  /:\s*\([^)]*\bNAME\b/,        // : (NAME & {...})[]  형태의 타입 어노테이션
  /&\s*NAME\b/, /\bNAME\s*&/,   // 교차 타입
  /\|\s*NAME\b/, /\bNAME\s*\|/, // 유니온 타입
];

/** 설정·CLI 계열. 이것이 보이면 tsc가 **프로젝트를 검사하지 못했다.** */
const CONFIG_ERR = /error (TS(?:5\d{3}|6\d{3})):/;

/** 사용법 배너. `-p`를 줘도 혹시 모르니 한 겹 더 둔다. */
const USAGE_BANNER = /^(?:Version \d|tsc: The TypeScript Compiler|COMMON COMMANDS)/m;

/**
 * 기준선에 상주하는 **비중단** 문법 코드만 허용한다.
 * `ci.yml`의 `SYNTAX_ALLOW`와 같은 값이어야 한다 — 다르면 한쪽만 막는다.
 */
export const SYNTAX_ALLOW = new Set(['TS1117']);

export function isTypeOnly(name, src) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return TYPE_CTX.some(re => new RegExp(re.source.replace(/NAME/g, esc)).test(src));
}

/**
 * **이 tsc 출력을 믿어도 되는가.**
 *
 * 믿을 수 없으면 `{ ok: false, reason }`을 돌려준다. 부르는 쪽은 그때
 * **통과시키지 않는다.** 확인하지 못한 것은 통과가 아니다.
 */
export function judge({ code, out, hasTsconfig }) {
  const text = String(out ?? '');

  if (!hasTsconfig) {
    return { ok: false, reason: 'tsconfig.json이 없습니다 — tsc가 무엇을 검사해야 할지 모릅니다' };
  }
  if (USAGE_BANNER.test(text)) {
    return { ok: false, reason: 'tsc가 사용법 배너만 출력했습니다 — 타입 검사가 돌지 않았습니다' };
  }
  const cfg = text.match(CONFIG_ERR);
  if (cfg) {
    return { ok: false, reason: `tsc 설정·CLI 오류(${cfg[1]})입니다 — 프로젝트를 검사하지 못했습니다` };
  }
  const syntax = [...new Set(
    [...text.matchAll(/error (TS1\d{3}):/g)].map(m => m[1]),
  )].filter(c => !SYNTAX_ALLOW.has(c)).sort();
  if (syntax.length > 0) {
    return {
      ok: false,
      reason: `문법 계열 오류가 있습니다 (${syntax.join(' ')}) — tsc가 파일을 끝까지 읽지 못했을 수 있고, `
        + '그러면 뒤쪽 파일의 TS2304는 아예 나오지 않습니다',
    };
  }
  if (code !== 0 && !/error TS\d+:/.test(text)) {
    return { ok: false, reason: `tsc가 종료코드 ${code}인데 진단을 하나도 내지 않았습니다 — 출력이 잘렸을 수 있습니다` };
  }
  return { ok: true, reason: null };
}

/** TS2304 중 **값 위치**인 것만 모은다. */
export function collectHits(out, readLine) {
  const hits = [];
  for (const line of String(out ?? '').split('\n')) {
    const m = line.match(/^(.+?)\((\d+),\d+\):\s*error TS2304:.*Cannot find name '([^']+)'/);
    if (!m) continue;
    const [, file, lineNo, name] = m;
    let src = '';
    try { src = readLine(file, Number(lineNo)); } catch { continue; }
    if (src == null) continue;
    if (!isTypeOnly(name, src)) {
      hits.push({ file, lineNo, name, src: String(src).trim().slice(0, 100) });
    }
  }
  return hits;
}

/**
 * **규칙이 실제로 걸리는지 매번 확인한다.**
 *
 * 통과만 하고 아무것도 막지 않는 검사기는 없는 것보다 나쁘다 — 막는
 * 것처럼 보이면서 안 막는다. 이 검사기는 `ci.yml`의 명시 목록에 없어서
 * 전용 CI 줄이 없다. 그래서 자기 점검을 **정상 경로에서** 돌린다.
 */
export function selfCheck() {
  const real = "src/a.ts(3,10): error TS2304: Cannot find name 'nope'.";
  const cases = [
    ['tsconfig 없음', { code: 0, out: '', hasTsconfig: false }],
    ['사용법 배너', { code: 1, out: 'Version 5.9.3\n\nCOMMON COMMANDS\n', hasTsconfig: true }],
    ['설정 오류 TS5058', { code: 1, out: "error TS5058: The specified path does not exist: 'nope.json'.", hasTsconfig: true }],
    ['설정 오류 TS6059', { code: 1, out: "error TS6059: File is not under 'rootDir'.", hasTsconfig: true }],
    ['문법 중단 TS1127', { code: 2, out: `${real}\nsrc/b.ts(1,1): error TS1127: Invalid character.`, hasTsconfig: true }],
    ['진단 없는 비정상 종료', { code: 2, out: '', hasTsconfig: true }],
  ];
  const leaked = cases.filter(([, input]) => judge(input).ok).map(([name]) => name);
  if (leaked.length > 0) {
    return { ok: false, reason: `자기 점검 실패 — 막아야 할 입력을 통과시켰습니다: ${leaked.join(' · ')}` };
  }
  // 정상값은 통과해야 한다. 전부 막는 검사기도 쓸모가 없다.
  const normal = judge({ code: 2, out: `${real}\nsrc/c.ts(9,9): error TS1117: Duplicate property.`, hasTsconfig: true });
  if (!normal.ok) {
    return { ok: false, reason: `자기 점검 실패 — 정상 출력을 막았습니다: ${normal.reason}` };
  }
  // 값 위치와 타입 위치를 실제로 가르는지.
  const valueHits = collectHits(real, () => 'return nope(1);');
  const typeHits = collectHits(real, () => 'const x: nope = y;');
  if (valueHits.length !== 1 || typeHits.length !== 0) {
    return { ok: false, reason: `자기 점검 실패 — 값/타입 위치 판별이 깨졌습니다 (값 ${valueHits.length}, 타입 ${typeHits.length})` };
  }
  return { ok: true, reason: null };
}

function runTsc() {
  try {
    const out = execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    // 종료코드가 0이 아니면 여기로 온다. **코드를 버리지 않는다.**
    const code = typeof e.status === 'number' ? e.status : -1;
    return { code, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function main() {
  const self = selfCheck();
  if (!self.ok) {
    console.log(`🔴 ${self.reason}`);
    process.exit(1);
  }

  const hasTsconfig = existsSync('tsconfig.json');
  const { code, out } = hasTsconfig ? runTsc() : { code: -1, out: '' };

  const verdict = judge({ code, out, hasTsconfig });
  if (!verdict.ok) {
    console.log(`🔴 타입 검사 결과를 믿을 수 없습니다 — ${verdict.reason}`);
    console.log('   확인하지 못한 것은 통과가 아닙니다. 이 검사는 실패로 끝냅니다.');
    const head = String(out).split('\n').filter(Boolean).slice(0, 5);
    for (const line of head) console.log(`     ${line}`);
    process.exit(1);
  }

  const hits = collectHits(out, (file, lineNo) => readFileSync(file, 'utf8').split('\n')[lineNo - 1] ?? '');
  if (hits.length === 0) {
    const n = (String(out).match(/error TS\d+:/g) || []).length;
    console.log(`✅ 런타임 미정의 식별자 없음 (tsc 종료코드 ${code} · 진단 ${n}건을 실제로 읽었습니다)`);
    process.exit(0);
  }
  console.log(`🔴 런타임 크래시 위험 ${hits.length}건:\n`);
  for (const h of hits) {
    console.log(`  ${h.file}:${h.lineNo} → '${h.name}'`);
    console.log(`     ${h.src}\n`);
  }
  process.exit(1);
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
