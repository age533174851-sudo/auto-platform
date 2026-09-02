#!/usr/bin/env node
// scripts/check-design-tokens.mjs
//
// **디자인 토큰 정본이 하나이고, 실제로 쓰이는가.**
//
// 이 검사가 막는 것은 "토큰 파일을 만들어 두고 아무도 안 쓰는 상태"다.
// 이 저장소에서 실제로 그랬다:
//   · `components/ui/tokens.ts`에 SP·R·F가 있었지만 8개 파일만 썼고
//   · `components/terminal/theme.ts`에 글자 크기 스케일이 **한 벌 더**
//     있었고(FS), 두 스케일은 같은 개념을 다른 모양으로 적고 있었다
//   · SharedUI의 Card는 반지름 18, tokens.ts의 cardStyle()은 16 —
//     같은 "카드"가 두 모양이었다
//
// 무엇을 검사하지 않는가
// ──────────────────────
// **인라인 스타일 개수를 세지 않는다.** 지금 17,000건이 넘고, 이번 단계는
// 그것을 한 번에 없애는 단계가 아니다. 숫자를 기준으로 잠그면 다음 사람이
// 화면을 고칠 때마다 이 검사와 싸우게 된다.
//
// 대신 **계약**을 본다: 정본이 하나인가, 정본에 테스트가 붙어 있는가,
// 스케일 값이 두 곳에 중복 선언돼 있지 않은가, 대표 사용처가 실제로
// 정본을 소비하는가.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripJsComments } from './lib/strip-comments.mjs';

let bad = false;
const err = (m) => { bad = true; console.error(`❌ ${m}`); };

const CORE     = 'src/lib/ui/tokens.ts';            // 숫자 정본
const CORE_TST = 'src/lib/ui/tokens.test.ts';
const STYLE    = 'src/components/ui/tokens.ts';     // 색이 붙은 스타일
const TERM     = 'src/components/terminal/theme.ts';
const SHARED   = 'src/components/pages/SharedUI.tsx';
const PREFS    = 'src/lib/ui/panelPrefs.ts';
const FILES = [CORE, CORE_TST, STYLE, TERM, SHARED, PREFS];

const code = {}, rawSrc = {};
for (const f of FILES) {
  if (!existsSync(f)) { err(`${f}를 찾지 못했습니다 — 이 검사가 무엇을 보는지 다시 확인하세요`); continue; }
  const t = readFileSync(f, 'utf8');
  if (!t.trim()) { err(`${f}가 비어 있습니다`); continue; }
  rawSrc[f] = t; code[f] = stripJsComments(t);
}
if (bad) { console.error('\n검사할 파일을 못 읽었습니다. 여기서 멈춥니다.\n'); process.exit(1); }

const has = (f, re) => re.test(code[f]);
const need = (f, re, msg) => { if (!has(f, re)) err(`${f}: ${msg}`); };

/* ── ① 숫자 정본이 존재하고 테스트가 붙어 있다 ────────────────
   테스트 없는 정본은 "정본이라고 적어 둔 파일"이다. 값이 갈라져도
   아무도 모르고, 그게 이 저장소에서 실제로 일어난 일이다. */
const SCALES = ['SP', 'R', 'FS', 'FW', 'CONTROL'];
for (const name of SCALES) {
  need(CORE, new RegExp(`export const ${name}\\s*=`), `${name} 스케일이 정본에 없습니다`);
}
need(CORE, /export const BORDER_W\s*=/, '테두리 두께가 정본에 없습니다');
need(CORE_TST, /export function runTokensTests/, '정본에 테스트가 없습니다');

/* 하네스에 등록돼야 실제로 돈다. 파일만 있고 등록이 없으면 초록은
   그 테스트를 한 번도 실행하지 않은 초록이다. */
const runner = readFileSync('scripts/run-tests.mjs', 'utf8');
if (!/runTokensTests\s*\(\s*\)/.test(runner)) {
  err('scripts/run-tests.mjs에 runTokensTests()가 등록되지 않았습니다 — 테스트 파일만 있고 돌지 않습니다');
}

/* ── ② 스케일을 두 번 선언하지 않는다 ─────────────────────────
   같은 개념이 두 곳에 있으면 언젠가 한쪽만 바뀐다. 터미널 theme.ts에
   글자 크기 스케일이 한 벌 더 있었던 것이 정확히 그 상태였다. */
for (const f of [STYLE, TERM]) {
  for (const name of SCALES) {
    if (new RegExp(`export const ${name}\\s*=\\s*\\{`).test(code[f])) {
      err(`${f}: ${name}을 다시 선언합니다 — 정본은 ${CORE} 하나입니다`);
    }
  }
}
/* 최소 터치 크기는 panelPrefs가 정본이다(UI-1에서 그 값 때문에 되돌린 적이 있다). */
need(PREFS, /export const MIN_CONTROL_TARGET\s*=\s*\d+/, '최소 터치 크기 정본이 사라졌습니다');
if (/MIN_CONTROL_TARGET\s*=\s*\d+/.test(code[CORE])) {
  err(`${CORE}: 최소 터치 크기를 다시 선언합니다 — panelPrefs에서 가져오세요`);
}
need(CORE, /min:\s*MIN_CONTROL_TARGET/, '정본이 최소 터치 크기를 panelPrefs에서 가져오지 않습니다');

/* ── ③ 색이 붙은 스타일이 정본 위에 서 있다 ───────────────────
   F.*가 숫자를 직접 적으면 스케일을 고쳐도 화면은 그대로다. */
need(STYLE, /from\s*'@\/lib\/ui\/tokens'/, '정본을 가져오지 않습니다');
need(STYLE, /export\s*\{[^}]*\bSP\b[^}]*\}/, '기존 import 경로가 쓰던 스케일을 다시 내보내지 않습니다 — 8개 파일이 깨집니다');
const fBlock = /export const F\s*=\s*\{([\s\S]*?)\n\}\s*as const;/.exec(code[STYLE]);
if (!fBlock) err(`${STYLE}: F 선언을 찾지 못했습니다`);
else {
  const sizes = [...fBlock[1].matchAll(/fontSize:\s*([^,\s]+)/g)].map(m => m[1]);
  const literal = sizes.filter(v => /^\d/.test(v));
  // numXL(26)만 스케일 밖이다 — 총자산 한 자리에만 쓰여서 단계를 만들
  // 만큼 반복되지 않는다. 그 하나를 넘으면 스케일을 안 쓰고 있는 것이다.
  if (literal.length > 1) {
    err(`${STYLE}: F가 글자 크기를 직접 적습니다(${literal.join(', ')}) — FS 스케일을 쓰세요`);
  }
  const weights = [...fBlock[1].matchAll(/fontWeight:\s*([^,\s}]+)/g)].map(m => m[1]);
  if (weights.some(v => /^\d/.test(v))) {
    err(`${STYLE}: F가 글자 굵기를 직접 적습니다 — FW 스케일을 쓰세요`);
  }
}
/* 버튼 높이도 정본에서. 36/44를 직접 적으면 CONTROL을 고쳐도 안 따라온다. */
need(STYLE, /CONTROL\.sm|CONTROL\.md/, 'buttonStyle이 정본의 control 높이를 쓰지 않습니다');

/* ── ④ 터미널이 정본 스케일을 쓴다 ────────────────────────────
   36개 파일이 이 FS를 쓴다. 여기가 정본에서 떨어지면 앱과 터미널의
   글자 크기가 다시 갈라진다. */
need(TERM, /export\s*\{\s*FS\s*\}\s*from\s*'@\/lib\/ui\/tokens'/,
  '터미널이 정본 글자 크기 스케일을 쓰지 않습니다');

/* ── ⑤ 대표 사용처가 정본에 실제로 닿아 있다 ──────────────────
   "정본이 있다"와 "정본이 쓰인다"는 다르다. 가장 많이 렌더되는 두
   primitive(Card 337곳 · Bdg 67곳)가 정본을 소비하는지 본다. */
need(SHARED, /from\s*'@\/lib\/ui\/tokens'/, '가장 많이 쓰이는 primitive가 정본을 가져오지 않습니다');
const card = /export function Card\([\s\S]*?\n\}/.exec(code[SHARED]);
if (!card) err(`${SHARED}: Card 선언을 찾지 못했습니다`);
else {
  if (/borderRadius:\s*\d/.test(card[0])) {
    err(`${SHARED}: Card가 반지름을 직접 적습니다 — R.card를 쓰세요`);
  }
  if (!/R\.card/.test(card[0])) err(`${SHARED}: Card가 정본 반지름을 쓰지 않습니다`);
}
const bdg = /export function Bdg\([\s\S]*?\n\}/.exec(code[SHARED]);
if (!bdg) err(`${SHARED}: Bdg 선언을 찾지 못했습니다`);
else if (/fontSize:\s*[^,]*\d\s*:/.test(bdg[0]) && !/FS\./.test(bdg[0])) {
  err(`${SHARED}: Bdg가 글자 크기를 직접 적습니다 — FS 스케일을 쓰세요`);
}

/* ── ⑥ 스케일이 현실을 담고 있다 ──────────────────────────────
   화면에 이미 서 있는 값이 스케일에 없으면 그 자리는 영원히 인라인으로
   남거나, 옮기면서 화면이 바뀐다. 둘 다 나쁘다. */
const coreCode = code[CORE];
const scaleOf = (name) => {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as const;`).exec(coreCode);
  return m ? [...m[1].matchAll(/:\s*(\d+(?:\.\d+)?)/g)].map(x => Number(x[1])) : [];
};
const must = { R: [18, 8, 12], FS: [9, 10, 11, 12, 13], SP: [8, 12, 16] };
for (const [name, vals] of Object.entries(must)) {
  const have = scaleOf(name);
  for (const v of vals) {
    if (!have.includes(v)) {
      err(`${CORE}: ${name} 스케일에 ${v}가 없습니다 — 이미 화면에 있는 값이라 빼면 옮길 수 없습니다`);
    }
  }
}

/* ── ⑦ 정본에 쓰이지 않는 것을 두지 않는다 ────────────────────
   **이 검사가 이번에 실제로 필요했다.** 처음 만들 때 정본에 BP(화면 폭
   분기점) · LH(줄 간격) · isTouchSafe · showsSidebar · showsRail ·
   inScale을 넣었는데, 여섯 개 전부 부르는 곳이 없었다. BP는 "CSS와 같은
   숫자여야 한다"고 적어 뒀지만 실제 JS 판단은 panelPrefs의 literal
   1440을 보고 있었고, 테스트는 globals.css를 읽지도 않으면서 "CSS와
   같다"는 이름을 달고 있었다 — 자기가 적은 숫자를 자기가 확인했다.

   쓰이지 않는 토큰은 정본이 아니라 장식이다. 그리고 "언젠가 쓸 것"으로
   남겨 두면 다음 사람이 그것을 진짜 계약으로 믿는다. */
{
  const exported = [...code[CORE].matchAll(/export const ([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1])
    .concat([...code[CORE].matchAll(/export function ([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]));
  const consumers = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && p !== CORE && p !== CORE_TST) consumers.push(p);
    }
  };
  walk('src');
  const body = consumers.map(f => stripJsComments(readFileSync(f, 'utf8'))).join('\n');
  for (const name of exported) {
    // 객체 스케일은 `NAME.` 로, 스칼라/함수는 이름 그대로 쓰인다.
    // import 줄만 있고 실제 사용이 없는 경우를 세지 않도록 import 문은 뺀다.
    const used = new RegExp(`(?<!import[^\\n]{0,200})\\b${name}\\b\\s*[.(\`,)}\\]]`).test(
      body.split('\n').filter(l => !/^\s*import\b/.test(l)).join('\n'));
    if (!used) {
      err(`${CORE}: ${name}을 내보내지만 화면에서 쓰는 곳이 없습니다 — `
        + '쓰이지 않는 토큰은 정본이 아니라 장식입니다. 실제로 배선하거나 빼세요');
    }
  }
}

/* ── ⑧ 기존 계약을 약화시키지 않았다 ──────────────────────────
   디자인 정리를 핑계로 UI-1·UI-3A 검사를 우회하거나 지우면 안 된다. */
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
for (const s of ['check-ui-shell-contract.mjs', 'check-ui-truth-claims.mjs', 'check-design-tokens.mjs']) {
  if (!ci.includes(s)) err(`.github/workflows/ci.yml: ${s}가 CI에 없습니다`);
}

if (bad) {
  console.error('\n디자인 토큰 정본이 하나가 아니거나, 만들어 두고 쓰지 않고 있습니다.\n');
  process.exit(1);
}
console.log('✅ 디자인 토큰 계약 — 정본 하나 · 테스트 있음 · 대표 사용처가 실제로 소비합니다');
