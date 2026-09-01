#!/usr/bin/env node
// scripts/check-ui-shell-contract.mjs
//
// **접기·폭 조절·보기 전환이 "있는 척"만 하지 않게 한다.**
//
// 이 저장소에서 가장 자주 난 UI 고장은 두 가지였다:
//   ① 만들어 놓고 배선을 안 함 — 버튼은 있는데 아무 일도 안 일어난다
//   ② 경로가 둘인데 한쪽만 고침 — 같은 판단이 두 곳에 있다
//
// 그래서 여기서 보는 것은 **상호작용 계약**이다:
//   · 접기 상태가 실제로 칸 폭을 바꾸는 경로에 닿아 있는가
//   · 폭 판단이 panelPrefs 한 곳에 있는가 (컴포넌트가 직접 조이지 않는가)
//   · 저장 키가 한 곳에만 적혀 있는가
//   · 새 조작이 button semantic + 이름을 갖고 있는가
//   · 메뉴의 두 모양이 같은 데이터/같은 이동 함수를 쓰는가
//
// **픽셀값은 검사하지 않는다.** `width: 300px`을 정규식으로 박아 두면
// 다음 사람이 280으로 고칠 때 이 검사가 실패하는데, 그건 고장이 아니라
// 디자인 변경이다. 그런 검사는 사람을 검사에 맞추게 만든다.
//
// 규칙 하나: **못 읽으면 통과시키지 않는다.**

import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

const PREFS = 'src/lib/ui/panelPrefs.ts';
const PAGE = 'src/app/page.tsx';
const CSS = 'src/app/globals.css';
const HUB = 'src/components/pages/MenuHubPage.tsx';
const RESIZER = 'src/components/shell/RailResizer.tsx';
const TOGGLE = 'src/components/shell/PanelToggle.tsx';
const TILE = 'src/components/menu/MenuTile.tsx';
const VIEW_TOGGLE = 'src/components/menu/MenuViewToggle.tsx';

const FILES = [PREFS, PAGE, CSS, HUB, RESIZER, TOGGLE, TILE, VIEW_TOGGLE];
const src = {};
for (const f of FILES) {
  const t = read(f);
  if (t == null) { err(`${f}를 찾지 못했습니다 — 이 검사가 무엇을 보고 있는지 다시 확인하세요`); continue; }
  if (!t.trim()) { err(`${f}가 비어 있습니다`); continue; }
  src[f] = t;
}
if (bad) { console.error('\n검사할 파일을 못 읽었습니다. 여기서 멈춥니다.\n'); process.exit(1); }

/**
 * CSS 주석을 지운다.
 *
 * **주석을 계약으로 읽으면 안 된다.** 이 검사를 처음 돌렸을 때
 * `minmax(0, 1fr)`을 전부 `1fr`로 바꿔 놓았는데도 통과했다. 원인은
 * 설명 주석에 그 문구가 적혀 있었던 것이다 — 검사기가 규칙이 아니라
 * 규칙에 대한 설명을 보고 초록을 켰다. 그건 통과가 아니라 고장이다.
 */
function stripCssComments(t) {
  return String(t).replace(/\/\*[\s\S]*?\*\//g, ' ');
}
const cssCode = stripCssComments(src[CSS]);

/* ── ① 저장 키는 panelPrefs에만 있다 ────────────────────────
   키를 컴포넌트에도 적으면 이름을 바꾼 날 한쪽만 바뀐다. 그러면
   저장은 새 키로, 읽기는 옛 키로 — 설정이 조용히 사라진다. */
const KEYS = ['tg_ui_left_panel', 'tg_ui_right_panel', 'tg_ui_right_width', 'tg_menu_view'];
for (const k of KEYS) {
  if (!src[PREFS].includes(k)) err(`저장 키 ${k}가 ${PREFS}에 없습니다`);
  for (const f of [PAGE, HUB, RESIZER, TOGGLE, TILE, VIEW_TOGGLE]) {
    if (src[f].includes(k)) {
      err(`${f}가 저장 키 ${k}를 직접 적고 있습니다 — panelPrefs의 함수를 쓰세요`);
    }
  }
}

/* ── ② 폭 판단은 한 곳에서 ──────────────────────────────────
   컴포넌트가 자기만의 Math.min/Math.max로 폭을 조이기 시작하면
   드래그가 멈추는 자리와 창 크기 변화가 멈추는 자리가 갈린다. */
for (const f of [RESIZER, PAGE]) {
  if (!src[f].includes('panelPrefs')) err(`${f}가 panelPrefs를 쓰지 않습니다 — 폭 판단이 복제됐을 수 있습니다`);
}
if (!/export function clampRailWidth/.test(src[PREFS])) err(`${PREFS}에 clampRailWidth가 없습니다`);
if (!/CENTER_MIN/.test(src[PREFS])) err(`${PREFS}에 가운데 최소폭(CENTER_MIN)이 없습니다 — 레일이 본문을 잡아먹을 수 있습니다`);
// 조이기가 창 크기를 실제로 본다는 것 — 저장된 값을 그대로 강제하지 않는다
if (!/clampRailWidth\s*\([^)]*viewport/i.test(src[PREFS])) {
  err(`${PREFS}의 clampRailWidth가 화면 폭을 받지 않습니다 — 좁은 화면에서 저장값이 강제됩니다`);
}
if (!/addEventListener\(\s*'resize'/.test(src[PAGE])) {
  err(`${PAGE}가 창 크기 변화를 듣지 않습니다 — 창을 줄여도 저장된 큰 폭이 그대로 남습니다`);
}

/* ── ③ 접기가 실제로 칸을 바꾸는가 ──────────────────────────
   상태만 바뀌고 CSS에 닿지 않으면 버튼은 눌리는데 화면은 그대로다.
   배선의 양 끝을 본다: page.tsx가 변수를 내보내고, CSS가 그 변수로
   칸을 그리는가. */
if (!/--sb-w/.test(src[PAGE]) || !/--rp-w/.test(src[PAGE])) {
  err(`${PAGE}가 칸 폭 변수(--sb-w/--rp-w)를 내보내지 않습니다 — 접기가 폭에 닿지 않습니다`);
}
// 실제 `.aw`의 칸 선언만 본다. 파일 아무 데나 있는 같은 문자열이
// 아니라, 이 칸을 정하는 줄이 맞는지 확인한다.
const awCols = [...cssCode.matchAll(/\.aw[^{}]*\{[^}]*?grid-template-columns:\s*([^;}]+)/g)].map(m => m[1].trim());
if (!awCols.length) err(`${CSS}에서 .aw의 칸 선언을 못 찾았습니다 — 검사기가 고장 났거나 골격이 바뀐 것입니다`);
if (!awCols.some(c => /var\(--sb-w/.test(c))) err(`${CSS}의 PC 칸이 --sb-w를 쓰지 않습니다`);
if (!awCols.some(c => /var\(--rp-w/.test(c))) err(`${CSS}의 PC 칸이 --rp-w를 쓰지 않습니다`);
// 가운데는 minmax(0, 1fr)이어야 한다. 그냥 1fr은 minmax(auto, 1fr)이라
// 내용보다 좁아지지 않는다 — 넓은 표 하나가 옆 칸을 화면 밖으로 밀어낸다.
for (const c of awCols) {
  if (!/minmax\(\s*0\s*,\s*1fr\s*\)/.test(c)) {
    err(`${CSS}의 .aw 칸에 minmax(0, 1fr)이 없습니다: \`${c}\` — 넓은 내용 하나가 옆 칸을 화면 밖으로 밀어냅니다`);
  }
}
// 접었을 때 가운데가 늘어나려면 .mc에 max-width 상한이 없어야 한다.
// 예전 `.mc { max-width: 820px }`가 정확히 그 고장이었다 — 칸은 줄었는데
// 본문은 안 늘어나고 빈 자리만 생겼다.
if (/\.mc\s*\{[^}]*max-width:\s*\d+px/.test(cssCode)) {
  err(`${CSS}의 .mc에 고정 max-width가 있습니다 — 패널을 접어도 빈 자리만 남습니다`);
}
if (!/data-left=/.test(src[PAGE]) || !/data-right=/.test(src[PAGE])) {
  err(`${PAGE}에 접힘 상태 표시(data-left/data-right)가 없습니다`);
}
for (const attr of ['data-left', 'data-right']) {
  if (!new RegExp(`\\[${attr}=`).test(cssCode)) {
    err(`${CSS}가 ${attr} 상태를 그리지 않습니다 — 상태는 바뀌는데 화면은 그대로입니다`);
  }
}

/* ── ④ 접은 뒤에 다시 펼 수 있는가 ──────────────────────────
   한 번 접으면 못 펴는 화면은 접기 기능이 아니라 숨기기 사고다.
   접힌 상태에서 사라지는 것들 목록에 토글 자체가 없어야 한다. */
const collapsedHide = cssCode.match(/\.aw\[data-left='compact'\][^{]*\{[^}]*display:\s*none[^}]*\}/g) || [];
for (const rule of collapsedHide) {
  if (/PanelToggle|panel-toggle/.test(rule)) err('사이드바를 접으면 펴는 버튼까지 사라집니다');
}
if (!/PanelToggle/.test(src[PAGE])) err(`${PAGE}에 패널 토글이 배선돼 있지 않습니다`);

/* ── ⑤ 새 조작이 실제 버튼인가 ──────────────────────────────
   div onClick으로 만들면 Tab으로 닿지 않고 화면 낭독기가 읽지 못한다.
   아이콘만 있는 버튼은 보이는 글자가 없으므로 이름이 필수다. */
for (const f of [TOGGLE, RESIZER, VIEW_TOGGLE, TILE]) {
  if (!/<button/.test(src[f])) err(`${f}에 <button>이 없습니다 — div onClick으로 만든 조작은 키보드로 쓸 수 없습니다`);
  if (!/aria-label|aria-pressed/.test(src[f])) err(`${f}의 조작에 이름(aria-label)이 없습니다`);
}
if (!/aria-expanded/.test(src[TOGGLE])) err(`${TOGGLE}에 aria-expanded가 없습니다 — 지금 열려 있는지 낭독기가 알 수 없습니다`);
if (!/role="separator"/.test(src[RESIZER])) err(`${RESIZER}에 role="separator"가 없습니다`);
if (!/onPointerDown\s*=\s*\{/.test(src[RESIZER])) err(`${RESIZER}에 드래그가 배선돼 있지 않습니다`);
// 마우스로만 잡을 수 있는 손잡이는 마우스를 쓰는 사람만의 기능이다
// 함수를 만들어 두고 붙이지 않으면 이름은 파일에 남는다. **배선**을 본다.
if (!/onKeyDown\s*=\s*\{/.test(src[RESIZER])) err(`${RESIZER}에 키보드 조작이 배선돼 있지 않습니다`);
if (!/railWidthFromKey/.test(src[RESIZER])) err(`${RESIZER}가 키보드 폭 계산을 쓰지 않습니다`);
if (!/aria-valuenow/.test(src[RESIZER])) err(`${RESIZER}가 지금 폭을 알리지 않습니다`);
// 드래그 중 글자가 선택되면 본문 전체가 파랗게 잡힌다
if (!/rp-resizing/.test(src[RESIZER]) || !/body\.rp-resizing/.test(cssCode)) {
  err('드래그 중 글자 선택을 막는 처리(body.rp-resizing)가 배선돼 있지 않습니다');
}
// 손가락으로는 1px 모서리를 잡을 수 없다 — 터치 기기에서는 숨긴다
if (!/hover:\s*hover/.test(cssCode) || !/\.rp-resizer\s*\{[\s\S]*?\}/.test(cssCode)) {
  err(`${CSS}에 터치 기기에서 손잡이를 숨기는 규칙이 없습니다`);
}

/* ── ⑥ 메뉴 두 모양이 한 데이터·한 이동 함수를 쓰는가 ────────
   타일과 줄이 각자 이동 규칙을 가지면, href 항목이 한쪽에서만
   동작하는 날이 온다. 실제로 이 앱의 href 분기가 그런 모양이었다. */
if (!/MENU/.test(src[HUB])) err(`${HUB}가 MENU를 쓰지 않습니다`);
// 타일이 자기만의 항목 목록을 갖고 있으면 안 된다
if (/from '@\/lib\/menuItems'/.test(src[TILE]) && /\bMENU\b(?!_)/.test(src[TILE].replace(/type\s+MenuItem/g, ''))) {
  err(`${TILE}이 메뉴 목록을 직접 들고 있습니다 — 항목은 MenuHubPage가 넘겨야 합니다`);
}
// href 분기는 한 곳에만
const hrefBranches = (src[HUB].match(/m\.href/g) || []).length;
if (hrefBranches === 0) err(`${HUB}에 href 분기가 없습니다 — 별도 페이지 항목이 죽습니다`);
if (hrefBranches > 2) err(`${HUB}의 href 분기가 ${hrefBranches}곳입니다 — 이동 규칙은 한 곳에 두세요`);
if (/window\.location\.href/.test(src[TILE])) err(`${TILE}이 직접 이동합니다 — 이동은 MenuHubPage가 넘긴 함수로만`);
// 두 모양이 같은 즐겨찾기 저장소를 쓰는가 (새 저장소를 만들지 않았는가)
if (/localStorage/.test(src[TILE]) || /tg_favorites/.test(src[TILE])) {
  err(`${TILE}이 즐겨찾기를 직접 저장합니다 — lib/favorites 하나만 씁니다`);
}
if (!/from '@\/lib\/favorites'/.test(src[HUB])) err(`${HUB}가 기존 즐겨찾기 저장소를 쓰지 않습니다`);
if (!/MenuViewToggle/.test(src[HUB]) || !/MenuTile/.test(src[HUB])) {
  err(`${HUB}에 보기 전환이 배선돼 있지 않습니다`);
}
// 열 수를 고정하면 칸 폭이 바뀌는 이 화면에서 반드시 깨진다
if (!/auto-fill|auto-fit/.test(cssCode)) {
  err(`${CSS}의 메뉴 격자가 고정 열 수를 씁니다 — 패널을 접으면 칸 폭이 바뀝니다`);
}
if (/\.menu-grid\s*\{[^}]*grid-template-columns:\s*repeat\(\s*\d+\s*,/.test(cssCode)) {
  err(`${CSS}의 .menu-grid가 고정 열 수입니다`);
}

/* ── ⑦ 넘침을 숨기지 않았는가 ───────────────────────────────
   `overflow: hidden`을 전역에 붙이면 가로 스크롤은 사라지지만 내용도
   같이 사라진다. 안 보이는 것은 고친 것이 아니다. */
if (/^\s*\*\s*\{[^}]*overflow:\s*hidden/m.test(cssCode)) {
  err(`${CSS}에 전역 overflow:hidden이 있습니다 — 넘침을 고치지 않고 숨긴 것입니다`);
}

if (bad) {
  console.error(`\n❌ UI 껍데기 계약 ${bad}건 실패\n`);
  process.exit(1);
}
console.log('✅ UI 껍데기 계약 — 접기·폭 조절·보기 전환이 실제 폭과 저장소에 닿아 있습니다');
