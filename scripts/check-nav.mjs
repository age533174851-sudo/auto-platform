// scripts/check-nav.mjs
//
// **눌러도 아무 일도 안 일어나는 메뉴를 막는다.**
//
// 왜 필요한가
// ───────────
// 더보기 메뉴에서 항목을 눌러도 화면이 안 바뀌는 회귀가 한 번 있었다.
// 원인은 단순했다 — `MENU`에는 id가 있는데 그 id를 받는 화면 분기가
// 없었던 것이다. 그러면 `setTab(id)`은 성공하고, 렌더는 아무것도 안
// 그리고, 사용자에게는 **버튼이 고장 난 것으로 보인다.**
//
// 이건 타입으로 안 잡힌다. id가 그냥 문자열이라 컴파일러가 둘을
// 이어 주지 않는다. 그래서 검사가 필요하다.
//
// 왜 유닛 테스트가 아니라 스크립트인가
// ────────────────────────────────────
// `menuItems.tsx`는 JSX와 아이콘 컴포넌트를 들고 있어서 테스트 하니스
// (순수 TS를 CJS로 컴파일해 Node로 실행)에서 불러올 수 없다. 그리고
// 화면 분기는 `page.tsx`의 switch문이라 애초에 값으로 못 꺼낸다.
//
// 그래서 **원문을 읽어 맞춰 본다.** 정교하진 않지만, 이 검사가 막으려는
// 것(id 하나가 짝을 잃는 것)은 정확히 잡는다.
//
// 규칙 하나: **못 읽으면 통과시키지 않는다.** 파일을 못 찾거나 항목이
// 하나도 안 잡히면 그건 '문제 없음'이 아니라 이 검사가 고장 난 것이다.

import { readFileSync, existsSync } from 'node:fs';

const MENU_FILE = 'src/lib/menuItems.tsx';
const PAGE_FILE = 'src/app/page.tsx';

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

for (const f of [MENU_FILE, PAGE_FILE]) {
  if (!existsSync(f)) fail(`${f}를 찾지 못했습니다 — 이 검사가 무엇을 보고 있는지 다시 확인하세요`);
}

const menuSrc = readFileSync(MENU_FILE, 'utf8');
const pageSrc = readFileSync(PAGE_FILE, 'utf8');

// MENU의 id들. `{ id:'trading', ... }` 모양을 그대로 읽는다.
// **문자셋을 좁게 잡으면 안 읽히는 항목이 생긴다.** 처음에 [a-zA-Z_0-9]로
// 뒀다가, 한글 id를 넣은 항목이 통째로 안 세어지는 것을 확인했다 —
// 검사에서 조용히 빠지는 것이 이 스크립트가 막으려는 고장과 같은 종류다.
const menuIds = [...menuSrc.matchAll(/\bid\s*:\s*'([^']+)'/g)].map(m => m[1]);
// 화면 분기. `case 'trading':`
const cases = new Set([...pageSrc.matchAll(/\bcase\s+'([^']+)'/g)].map(m => m[1]));
// 바깥으로 나가는 링크는 화면 분기가 없어도 된다.
const hrefs = new Set([...menuSrc.matchAll(/\bhref\s*:\s*'([^']+)'/g)].map(m => m[1]));

if (menuIds.length === 0) {
  fail(`${MENU_FILE}에서 메뉴 항목을 하나도 못 읽었습니다 — 구조가 바뀌었다면 이 스크립트도 같이 고쳐야 합니다`);
}
if (cases.size === 0) {
  fail(`${PAGE_FILE}에서 화면 분기를 하나도 못 읽었습니다 — 라우팅 방식이 바뀌었다면 이 스크립트도 같이 고쳐야 합니다`);
}

// href를 가진 항목은 별도 경로로 나간다. id 순서와 href 순서를 짝지을
// 수 없으므로, **href를 가진 항목이 있으면 그 개수만큼은 봐준다**가
// 아니라 항목 블록 단위로 다시 읽는다.
const blocks = [...menuSrc.matchAll(/\{\s*id\s*:\s*'([^']+)'[^}]*\}/g)];
const dead = [];
for (const b of blocks) {
  const [block, id] = b;
  if (/\bhref\s*:/.test(block)) continue;   // 독립 경로로 나간다
  if (/\bdisabled\s*:\s*true/.test(block)) continue;   // 준비 중 — 누를 수 없다
  if (!cases.has(id)) dead.push(id);
}

const dupes = menuIds.filter((id, i) => menuIds.indexOf(id) !== i);

let bad = false;

if (dead.length > 0) {
  console.error('\n❌ 눌러도 아무 일도 안 일어나는 메뉴 항목:');
  for (const id of dead) {
    console.error(`   · ${id} — MENU에는 있는데 page.tsx에 case '${id}'가 없습니다`);
  }
  console.error('\n   고치는 방법은 셋 중 하나입니다:');
  console.error('     1. page.tsx에 화면 분기를 추가한다');
  console.error("     2. 독립 경로면 MENU 항목에 href를 준다");
  console.error("     3. 아직 안 만들었으면 disabled: true로 '준비 중'을 표시한다");
  console.error('\n   빈 화면으로 보내지 마세요 — 눌렀는데 아무 일도 안 일어나는 것이 가장 나쁜 상태입니다.');
  bad = true;
}

if (dupes.length > 0) {
  console.error(`\n❌ 메뉴 id가 겹칩니다: ${[...new Set(dupes)].join(', ')}`);
  console.error('   같은 id가 둘이면 나중 것이 앞의 것을 가립니다.');
  bad = true;
}

if (bad) process.exit(1);

console.log(`✅ 메뉴 ${blocks.length}개 · 화면 분기 ${cases.size}개 · 죽은 항목 0개`);
if (hrefs.size > 0) console.log(`   (독립 경로 ${hrefs.size}개는 화면 분기 검사에서 제외)`);
