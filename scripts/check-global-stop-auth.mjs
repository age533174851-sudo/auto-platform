#!/usr/bin/env node
// 전체정지가 **서버에 닿는 인증 경로**를 쓰는가.
//
// 무엇이 고장나 있었나
// ────────────────────
// 전체정지는 두 번 서버를 부른다 — 무엇이 켜져 있는지 읽는 GET, 그리고
// 하나씩 끄는 PATCH. 둘 다 `localStorage.sb_access_token`을 읽고 있었다.
//
// 그런데 **저장소 역사 전체에 그 키를 쓰는 코드가 없다.** 값은 늘 비어
// 있고, 읽는 쪽은 비면 요청 전에 종료한다. 즉 전체정지는 서버에 닿은 적이
// 없다. 브라우저 실측으로도 버튼을 눌렀을 때 GET 0회 · PATCH 0회였다.
//
// 표시용 카드는 정본 Supabase 세션을 쓰므로 화면은 예약을 정확히 그렸다.
// 그래서 "화면은 멀쩡한데 정지만 안 되는" 형태로 숨어 있었다. 사용자가
// 위험하다고 판단해 누르는 버튼이 아무 일도 하지 않는다.
//
// 이 검사기가 지키는 것
// ─────────────────────
// 읽기와 쓰기가 **같은 정본 경로**를 쓴다. 둘이 갈리면 "무엇이 도는지는
// 아는데 끄지는 못하는" 상태가 다시 생긴다.
import { readFileSync, existsSync } from 'node:fs';
import { stripJsComments } from './lib/strip-comments.mjs';

const PAGE = 'src/components/pages/AutoPage.tsx';
let bad = 0;
const err = m => { console.error(`❌ ${m}`); bad++; };

if (!existsSync(PAGE)) { err(`${PAGE}를 찾지 못했습니다`); process.exit(1); }
const raw = readFileSync(PAGE, 'utf8');
const src = stripJsComments(raw);

/* ── ① 아무도 쓰지 않는 키로 인증하지 않는다 ────────────── */
if (/sb_access_token/.test(src)) {
  err(`${PAGE}: 전체정지가 legacy sb_access_token으로 인증합니다 — 그 키를 쓰는 코드가 저장소에 없어 요청이 서버에 닿지 않습니다`);
}

/* ── ② 정본 경로를 쓴다 ─────────────────────────────────── */
if (!/from '@\/lib\/auth\/authToken'/.test(src)) {
  err(`${PAGE}: 정본 인증 모듈(lib/auth/authToken)을 쓰지 않습니다`);
}

/** 함수 본문을 이름으로 잘라 온다. 정규식으로 자르면 여러 줄 시그니처에서
 *  타입 블록까지만 잡혀 본문을 못 본다 — 이 저장소에서 실제로 겪었다. */
function bodyOf(name) {
  const i = src.indexOf(name);
  if (i < 0) return '';
  const rest = src.slice(i);
  const next = rest.slice(1).search(/\n  const \w+\s*=\s*(useCallback|async)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/* ── ③ 읽기와 쓰기가 같은 경로를 쓴다 ───────────────────── */
for (const [fn, what] of [
  ['const loadSchedules', '전체정지가 무엇을 끌지 읽는 호출'],
  ['const handleGlobalStop', '실제로 끄는 호출'],
]) {
  const body = bodyOf(fn);
  if (!body) { err(`${PAGE}: ${fn}을 찾지 못했습니다`); continue; }
  if (!/probeAuthToken\s*\(/.test(body)) {
    err(`${PAGE}: ${what}(${fn})이 정본 토큰을 얻지 않습니다`);
  }
  // `Bearer ${...}`로 다시 감싸면 정본 값이 이미 'Bearer …'라 두 번 붙는다.
  if (/Authorization\s*:\s*`Bearer \$\{/.test(body)) {
    err(`${PAGE}: ${fn}이 Bearer를 한 번 더 붙입니다 — 정본 값에 이미 들어 있습니다`);
  }
}

/* ── ④ '확인 못 함'을 '로그아웃'으로 적지 않는다 ──────────
   probeAuthToken은 셋을 구분한다: 'Bearer …' / '' / null(확인 실패).
   안전 경로에서 null을 ''로 눕히면, 세션이 멀쩡한데 잠깐 못 읽은 것을
   사용자가 로그인 문제로 오해한다. */
if (!/auth\s*===\s*null/.test(src)) {
  err(`${PAGE}: 인증을 '확인하지 못한 것'과 '로그인 안 된 것'을 가르지 않습니다`);
}

console.log(bad === 0
  ? '✅ 전체정지 인증 — 읽기와 쓰기가 같은 정본 경로를 쓴다'
  : '\n전체정지가 서버에 닿지 못하는 인증 경로를 씁니다.\n실측 재현: scripts/probe/global-stop-auth.mjs');
process.exit(bad === 0 ? 1 && 0 : 1);
