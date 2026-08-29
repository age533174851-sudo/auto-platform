#!/usr/bin/env node
// scripts/check-ui-inventory.mjs
//
// **목록이 낡으면 실패시킨다.**
//
// 이 저장소가 이미 겪은 실패: 문서에 적어 둔 상태가 실제와 갈렸고,
// 갈린 것을 아무도 못 봤다(FULL_COMPLETION_STATUS.md · 마이그레이션
// 목록 054·055·056). 그래서 마이그레이션 목록은 `gen-…`이 굽고 CI가
// 최신인지 확인한다. 화면 목록도 같은 방식이다.
//
// 화면을 하나 추가하고 `npm run gen:ui-inventory`를 안 돌리면 여기서
// 막힌다 — 그것이 목록이 살아 있게 하는 유일한 방법이다.
import { readFileSync, existsSync } from 'node:fs';
import { build, render, OUT } from './gen-ui-inventory.mjs';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };

const b = build();
const want = render(b);
const have = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';

if (have !== want) {
  err('docs/UI_INVENTORY.md가 낡았습니다 — `npm run gen:ui-inventory`를 실행하고 커밋하세요');
  if (have) {
    const n = (s) => (s.match(/^\| \*\*/gm) || []).length;
    console.error(`   현재 문서에 화면 ${n(have)}줄 · 실제 ${n(want)}줄`);
  }
}

// ── 목록 자체가 비면 스캐너가 고장 난 것이다 ──
//
// 0개를 "화면이 없다"로 읽으면, 이 검사는 영원히 초록이면서 아무것도
// 안 보는 상태가 된다. **못 읽은 것을 통과로 적지 않는다.**
if (b.screens.length === 0) err('화면을 하나도 읽지 못했습니다 — 스캐너가 구조 변화를 못 따라갔습니다');
if (b.routes.length === 0) err('라우트를 하나도 읽지 못했습니다');
if (Object.values(b.primitives).every(p => !p.exists)) err('공통 primitive를 하나도 찾지 못했습니다');

// ── 목록에는 있는데 그릴 화면이 없는 것 ──
//
// 누르면 빈 화면이다. `check-nav.mjs`는 MENU만 보므로 BTABS·MTABS는
// 여기서 본다.
const noCase = b.screens.filter(s => s.via.length > 0 && !s.component);
if (noCase.length) {
  err(`목록에 있는데 그리는 화면이 없습니다: ${noCase.map(s => `${s.id}(${s.via.join('+')})`).join(', ')}`);
}

if (bad === 0) {
  const orphan = b.screens.filter(s => s.via.length === 0).length;
  console.log(`✅ UI 목록 최신 — 화면 ${b.screens.length}개 · 라우트 ${b.routes.length}개`
    + ` · 목록에 없는 화면 ${orphan}개(문서에 기록됨)`);
} else {
  console.error('');
  console.error('   목록이 실제와 갈리면, 그 목록을 보고 내리는 판단이 전부 틀립니다.');
}
process.exit(bad ? 1 : 0);
