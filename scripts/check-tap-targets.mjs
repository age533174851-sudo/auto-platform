// 손으로 누르는 자리가 실제로 손가락만 한가.
//
// 왜 이 검사가 있나
// ─────────────────
// UI-1에서 접기 버튼을 26×26으로 만들고 주석에 "마우스가 있는 PC에서만
// 보인다"고 적었다. 그런데 CSS 계약은 그렇지 않았다 — 사이드바는 768px,
// 오른쪽 레일은 1024px부터 보이고 834×1194나 1024×768 태블릿은 **손으로
// 누른다.** 그래서 크기를 컴포넌트가 각자 고르지 않기로 하고
// `panelPrefs.MIN_CONTROL_TARGET`을 정본으로 삼았다.
//
// 그런데 자동매매 화면은 그 정본을 보지 않고 있었다. 실측하면 버튼
// 높이가 26·28·30·32·34·36px이었고, 전역 알림 벨은 38×38로 화면 위에
// 떠서 **1024px 미만에서 헤더의 로그인 버튼을 1376px² 덮었다**
// (430·390·360·834 전부). 데스크톱에서 안 겹친 것은 접힌 오른쪽 레일이
// 우연히 같은 폭의 띠를 비워 뒀기 때문이지, 누가 그렇게 정해서가 아니다.
//
// 이 검사가 보는 것
// ─────────────────
//   ① CSS의 --tap 과 --notify-band 가 panelPrefs의 값과 같은가
//   ② 자동매매 화면 파일들이 40px 미만 조작 크기를 직접 적지 않는가
//   ③ 떠 있는 알림 벨이 자기 띠를 계약으로 갖고 있는가
//
// 실제 픽셀 확인은 scripts/probe/가 한다(수동, README 참조).

import { readFileSync, existsSync } from 'node:fs';
import { stripJsComments } from './lib/strip-comments.mjs';

let bad = false;
const err = (m) => { bad = true; console.error(`❌ ${m}`); };

const PREFS  = 'src/lib/ui/panelPrefs.ts';
const CSS    = 'src/app/globals.css';
const NOTIFY = 'src/components/notify/NotifyHost.tsx';
const SCREENS = [
  'src/components/pages/AutoPage.tsx',
  'src/components/AutotradeControl.tsx',
  'src/components/MockAutoTrade.tsx',
];

for (const f of [PREFS, CSS, NOTIFY, ...SCREENS]) {
  if (!existsSync(f)) { err(`${f}를 찾지 못했습니다 — 이 검사가 무엇을 보는지 다시 확인하세요`); }
}
if (bad) { console.error('\n검사할 파일을 못 읽었습니다. 여기서 멈춥니다.\n'); process.exit(1); }

const prefs = stripJsComments(readFileSync(PREFS, 'utf8'));
const css   = readFileSync(CSS, 'utf8');

/* ── ① 정본과 CSS가 같은 값을 본다 ─────────────────────────
   CSS는 TypeScript 상수를 import할 수 없다. 그래서 값을 두 벌 적을
   수밖에 없고, 두 벌이면 언젠가 한쪽만 바뀐다. 여기서 대조한다. */
const tapTs = Number(/export const MIN_CONTROL_TARGET\s*=\s*(\d+)/.exec(prefs)?.[1] || 0);
if (!tapTs) err(`${PREFS}: MIN_CONTROL_TARGET을 찾지 못했습니다`);
if (tapTs < 40) err(`${PREFS}: MIN_CONTROL_TARGET이 ${tapTs}px입니다 — 손가락으로 누르기에 좁습니다`);

const bandTs = Number(/export const RAIL_COLLAPSED\s*=\s*MIN_CONTROL_TARGET\s*\+\s*(\d+)/.exec(prefs)?.[1] || NaN);
if (Number.isNaN(bandTs)) err(`${PREFS}: RAIL_COLLAPSED가 MIN_CONTROL_TARGET에서 나오지 않습니다 — 띠가 버튼보다 좁아질 수 있습니다`);

const tapCss = Number(/--tap:\s*(\d+)px/.exec(css)?.[1] || 0);
if (!tapCss) err(`${CSS}: --tap 변수가 없습니다`);
else if (tapCss !== tapTs) err(`${CSS}: --tap이 ${tapCss}px인데 ${PREFS}의 MIN_CONTROL_TARGET은 ${tapTs}px입니다 — 두 값이 갈라졌습니다`);

const bandCss = Number(/--notify-band:\s*(\d+)px/.exec(css)?.[1] || 0);
if (!bandCss) err(`${CSS}: --notify-band 변수가 없습니다 — 떠 있는 벨이 비울 자리가 정해져 있지 않습니다`);
else if (bandCss !== tapTs + bandTs) {
  err(`${CSS}: --notify-band가 ${bandCss}px인데 RAIL_COLLAPSED는 ${tapTs + bandTs}px입니다 — 벨이 헤더를 덮거나 빈 자리가 생깁니다`);
}

/* ── ② 레일이 없는 폭에서 헤더가 그 띠를 비운다 ──────────────
   1024px는 오른쪽 레일이 나타나는 폭이다(globals.css). 그 아래에서는
   레일이 없으므로 헤더가 직접 비워야 한다. */
if (!/@media \(max-width: 1023px\)[\s\S]{0,200}?\.hdr-actions\s*\{[^}]*margin-right:\s*var\(--notify-band\)/.test(css)) {
  err(`${CSS}: 레일이 없는 폭에서 헤더가 알림 벨의 띠를 비우지 않습니다 — 벨이 로그인·프로필 버튼을 덮습니다`);
}

/* ── ③ 떠 있는 벨이 정본 크기를 쓰고 이름이 있다 ────────────── */
const notify = stripJsComments(readFileSync(NOTIFY, 'utf8'));
if (/width:\s*\d+\s*,\s*height:\s*\d+/.test(notify)) {
  err(`${NOTIFY}: 벨 크기를 숫자로 직접 적습니다 — var(--tap)을 쓰세요`);
}
if (!/var\(--tap\)/.test(notify)) err(`${NOTIFY}: 벨이 조작 대상 최소 크기를 쓰지 않습니다`);
/* 아이콘만 있는 버튼은 읽어 줄 이름이 없으면 스크린리더에서 "버튼"이다.
   파일 아무 데나 aria-label이 있으면 통과하던 규칙이었다 — 벨의 이름을
   지워도 알림창 닫기 버튼의 이름이 대신 통과시켜 줬다. **그 버튼 자신**을
   본다. */
{
  const bell = /<button[^>]*?position:\s*'fixed'[\s\S]{0,400}?>/.exec(notify)
            || /<button(?:(?!<button)[\s\S])*?var\(--tap\)(?:(?!<button)[\s\S])*?>/.exec(notify);
  if (!bell) err(`${NOTIFY}: 떠 있는 알림 벨을 찾지 못했습니다`);
  else if (!/aria-label=/.test(bell[0])) {
    err(`${NOTIFY}: 떠 있는 알림 벨에 이름이 없습니다 — 아이콘만 있는 버튼은 스크린리더에서 그냥 "버튼"입니다`);
  }
}

/* ── ④ 자동매매 화면이 40px 미만을 직접 적지 않는다 ────────── */
for (const f of SCREENS) {
  const src = stripJsComments(readFileSync(f, 'utf8'));
  const hits = [];
  /* `minWidth: 0` / `minHeight: 0`은 UI-1이 지키라고 한 flex 계약이다
     (`minmax(0, 1fr)` / `min-width: 0`). 크기가 아니라 "줄어들어도 된다"는
     뜻이므로 여기서 세면 안 된다. 1~39만 본다. */
  for (const m of src.matchAll(/min(?:Height|Width):\s*([1-9]\d*)\b/g)) {
    if (Number(m[1]) < tapTs) hits.push(m[1]);
  }
  if (hits.length) {
    err(`${f}: 조작 크기를 ${[...new Set(hits)].join('·')}px로 직접 적습니다 (${hits.length}곳) — MIN_CONTROL_TARGET을 쓰세요`);
  }
}

/* ── ⑤ 화면 전체에 바닥을 까는 규칙이 살아 있다 ──────────────
   버튼마다 손으로 적으면 스무 곳 중 한 곳이 빠지고, 빠진 것을 아무도
   모른다. 표식 + 한 줄로 바닥을 깐다. */
if (!/\[data-region='autoPage'\][\s\S]{0,160}?min-height:\s*var\(--tap\)/.test(css)) {
  err(`${CSS}: 자동매매 화면의 조작 대상 바닥 규칙이 없습니다`);
}
if (!/data-region="autoPage"/.test(readFileSync(SCREENS[0], 'utf8'))) {
  err(`${SCREENS[0]}: data-region="autoPage" 표식이 없습니다 — 바닥 규칙이 걸릴 곳이 없습니다`);
}

if (bad) {
  console.error('\n손으로 누르는 자리가 손가락보다 좁거나, 떠 있는 버튼이 남의 자리를 덮습니다.\n'
    + '실제 픽셀 확인은 scripts/probe/README.md 참조.\n');
  process.exit(1);
}
console.log('✅ 조작 대상 계약 — 정본 하나 · 알림 벨 띠 · 자동매매 화면 바닥 규칙');
