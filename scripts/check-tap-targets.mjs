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
const APP    = 'src/app/page.tsx';
const SCREENS = [
  'src/components/pages/AutoPage.tsx',
  'src/components/AutotradeControl.tsx',
  'src/components/MockAutoTrade.tsx',
];

for (const f of [PREFS, CSS, NOTIFY, APP, ...SCREENS]) {
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

const railTs = Number(/export const RAIL_COLLAPSED\s*=\s*MIN_CONTROL_TARGET\s*\+\s*(\d+)/.exec(prefs)?.[1] || NaN);
if (Number.isNaN(railTs)) err(`${PREFS}: RAIL_COLLAPSED가 MIN_CONTROL_TARGET에서 나오지 않습니다 — 띠가 버튼보다 좁아질 수 있습니다`);
const railCollapsed = tapTs + railTs;

const tapCss = Number(/--tap:\s*(\d+)px/.exec(css)?.[1] || 0);
if (!tapCss) err(`${CSS}: --tap 변수가 없습니다`);
else if (tapCss !== tapTs) err(`${CSS}: --tap이 ${tapCss}px인데 ${PREFS}의 MIN_CONTROL_TARGET은 ${tapTs}px입니다 — 두 값이 갈라졌습니다`);

const bandCss = Number(/--notify-band:\s*(\d+)px/.exec(css)?.[1] || 0);
if (!bandCss) err(`${CSS}: --notify-band 변수가 없습니다 — 떠 있는 벨이 비울 자리가 정해져 있지 않습니다`);

/* ── ② 레일이 없는 폭에서 헤더가 그 띠를 비운다 ──────────────
   1024px는 오른쪽 레일이 나타나는 폭이다(globals.css). 그 아래에서는
   레일이 없으므로 헤더가 직접 비워야 한다. */
if (!/@media \(max-width: 1023px\)[\s\S]{0,200}?\.hdr-actions\s*\{[^}]*margin-right:\s*var\(--notify-band\)/.test(css)) {
  err(`${CSS}: 레일이 없는 폭에서 헤더가 알림 벨의 띠를 비우지 않습니다 — 벨이 로그인·프로필 버튼을 덮습니다`);
}

/* ── ③ 떠 있는 벨이 자기가 예약한 띠 **안에** 들어간다 ────────
   처음 이 검사는 `--tap`·`--notify-band`·헤더 여백·벨이 var(--tap)을
   쓰는지만 봤다. 그런데 벨이 띠 안에 들어가는지는 **크기가 아니라
   크기 + 오른쪽 오프셋**이 정한다. right를 4에서 12로 바꾸면 벨은
   40 + 12 = 52px를 차지해 48px 띠를 4px 넘어가는데, 그때도 검사는
   통과했다(직접 재현했다). 지금은 그 관계를 증명한다:

     오른쪽 오프셋 + 버튼 크기 <= 예약한 띠

   그리고 데스크톱에서 겹치지 않는 근거는 접힌 레일이 이 띠보다 좁지
   않다는 것이다. 레일과 알림 벨은 다른 개념이므로 **같은 값이라고
   묶지 않고** 필요한 부등식만 본다:

     RAIL_COLLAPSED >= 알림 띠
*/
const notify = stripJsComments(readFileSync(NOTIFY, 'utf8'));
if (/width:\s*\d+\s*,\s*height:\s*\d+/.test(notify)) {
  err(`${NOTIFY}: 벨 크기를 숫자로 직접 적습니다 — var(--tap)을 쓰세요`);
}
if (!/var\(--tap\)/.test(notify)) err(`${NOTIFY}: 벨이 조작 대상 최소 크기를 쓰지 않습니다`);

/* 떠 있는 벨의 여는 태그 하나. 아래 두 규칙(이름 · 오프셋)이 **같은
   조각**을 본다 — 파일 어딘가에 있으면 통과하던 구멍을 두 번 겪었다. */
const bellTag = (
  /<button(?:(?!<\/?button)[\s\S])*?position:\s*'fixed'(?:(?!<\/?button)[\s\S])*?>/.exec(notify) || []
)[0] || '';

if (bandCss && bellTag) {
  /* **벨 자신의** 오프셋만 본다. 파일 전체에서 찾으면 알림창 패널의
     `right: 0`이 대신 통과시켜 준다 — 벨의 right를 아예 지워도 검사가
     통과했다(직접 재현했다). */
  const gap = /\bright:\s*(\d+)/.exec(bellTag);
  if (!gap) err(`${NOTIFY}: 떠 있는 벨의 오른쪽 오프셋을 읽지 못했습니다 — 띠 안에 들어가는지 확인할 수 없습니다`);
  else {
    const need = Number(gap[1]) + tapTs;
    if (need > bandCss) {
      err(`${NOTIFY}: 벨이 오른쪽 ${gap[1]}px + 크기 ${tapTs}px = ${need}px를 차지하는데 비워 둔 띠는 ${bandCss}px입니다 — ${need - bandCss}px가 헤더 위로 넘어갑니다`);
    }
  }
  if (railCollapsed < bandCss) {
    err(`${PREFS}: 접힌 레일이 ${railCollapsed}px인데 알림 띠는 ${bandCss}px입니다 — 1024px 이상에서 벨이 헤더를 덮습니다`);
  }
}
/* 아이콘만 있는 버튼은 읽어 줄 이름이 없으면 스크린리더에서 "버튼"이다.
   파일 아무 데나 aria-label이 있으면 통과하던 규칙이었다 — 벨의 이름을
   지워도 알림창 닫기 버튼의 이름이 대신 통과시켜 줬다. **그 버튼 자신**을
   본다. */
if (!bellTag) err(`${NOTIFY}: 떠 있는 알림 벨을 찾지 못했습니다`);
else if (!/aria-label=/.test(bellTag)) {
  err(`${NOTIFY}: 떠 있는 알림 벨에 이름이 없습니다 — 아이콘만 있는 버튼은 스크린리더에서 그냥 "버튼"입니다`);
}

/* ── ③-2 비슷하게 생긴 두 벨이 서로 다른 것임을 말한다 ────────
   헤더의 벨은 `nav('alerts')` — 사용자가 "무엇을 알려 달라"고 거는
   조건 화면이다. 떠 있는 벨은 이미 일어난 일의 기록(수신함)이다.
   둘 다 아이콘만 있고 나란히 붙어 있어서, 이름이 없으면 스크린리더에도
   눈에도 같은 버튼 두 개다. 기능을 지워서 해결하지 않는다 — 둘 다 쓴다. */
{
  const app = readFileSync(APP, 'utf8');
  const m = /<button onClick=\{\(\)=>nav\('alerts'\)\}(?:(?!<\/?button)[\s\S])*?>/.exec(app);
  if (!m) err(`${APP}: 헤더의 알림 화면 버튼을 찾지 못했습니다`);
  else if (!/aria-label=/.test(m[0])) {
    err(`${APP}: 헤더 벨에 이름이 없습니다 — 떠 있는 벨과 아이콘이 같아 구분되지 않습니다`);
  }
  /* 눈으로도 구분돼야 한다. 떠 있는 쪽이 같은 종 아이콘으로 돌아가면
     다시 같은 버튼 두 개가 된다. */
  if (/<Bell\b/.test(notify)) {
    err(`${NOTIFY}: 수신함이 헤더와 같은 종 아이콘을 씁니다 — 다른 기능인데 눈으로 구분되지 않습니다`);
  }
}
/* 연결 안 된 개수를 그럴듯한 숫자로 채우지 않는다. */
if (/const unreadCount\s*=\s*[1-9]/.test(readFileSync(APP, 'utf8'))) {
  err(`${APP}: 읽지 않은 알림 개수를 상수로 지어냅니다 — 확인하지 못한 것을 숫자로 적지 않습니다`);
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
