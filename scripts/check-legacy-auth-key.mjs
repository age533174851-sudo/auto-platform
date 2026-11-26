#!/usr/bin/env node
// 제품 코드가 **아무도 쓰지 않는 인증 키**를 읽지 않는가.
//
// 무엇이 고장나 있었나
// ────────────────────
// 화면 네 곳이 `localStorage.sb_access_token`을 읽어 요청 헤더를 만들었다.
// 그런데 저장소 역사에서 그 키를 쓰는 production writer를 찾지 못했다
// (`git log -S"setItem('sb_access_token'" --all` → 0건). 정상 흐름에서는
// 채워지지 않으므로, 읽는 쪽은 값을 못 얻고 요청 전에 종료한다.
//
// 그 결과가 자리마다 달랐고 전부 사용자에게 나빴다.
//
//   전체정지          버튼을 눌러도 GET·PATCH가 나가지 않는다 (#242)
//   홈 자동매매 카드   아무 상태도 안 세우고 반환 → 라벨이 영구히 '읽는 중…'
//   홈 지갑 개요       로그인한 사용자에게 '로그인하면 …'이라고 적는다
//
// 정본은 하나다 — `lib/auth/authToken`(Supabase 세션). 그쪽은 'Bearer …' /
// '' / null(확인 실패)을 구분하므로, **확인하지 못한 것을 로그아웃으로
// 단정하지 않을** 수 있다.
//
// 이 검사기가 지키는 것
// ─────────────────────
// 제품 코드(src/)에서 그 키를 **읽는 코드**가 다시 생기지 않게 한다.
// 주석은 센다 — 옛 방식을 설명하는 주석까지 막으면 왜 그렇게 됐는지
// 기록을 남길 수 없다. 그래서 주석을 걷어낸 뒤 검사한다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripJsComments } from './lib/strip-comments.mjs';

const ROOT = 'src';
const KEY = 'sb_access_token';
let bad = 0;
const err = m => { console.error(`❌ ${m}`); bad++; };

/**
 * 읽는 파일 꼴.
 *
 * **꼴을 하나 빠뜨리면 그 꼴로 쓴 코드는 검사 밖으로 나간다.** 예전
 * 목록은 `ts|tsx|js|jsx|mjs`였다. TypeScript·Node가 똑같이 받아 주는
 * `cts`·`mts`·`cjs`가 빠져 있었다. 실측했다 (main ed00c1a4):
 *
 *   src/zzprobe-legacy.ts   에 `localStorage.getItem('sb_access_token')`
 *     → ❌ 제품 코드가 legacy sb_access_token을 씁니다        rc=1  (맞다)
 *   같은 한 줄을 .cts · .mts · .cjs 로 두면
 *     → ✅ 인증 정본 하나 — 제품 코드에 legacy 키 사용 없음   rc=0
 *
 * 이 저장소가 이미 겪은 고장과 같은 모양이다 — **표기법만 바꾸면
 * 통과하는 관문은 있는 것보다 나쁘다.**
 *
 * 지금 `src` 아래 실측: `.ts` 1187 · `.tsx` 211 · `.css` 1 (총 1399).
 * 그래서 꼴을 늘려도 오늘 잡히는 것은 늘지 않는다.
 *
 * **여전히 읽지 않는 것**: `.css`와 그림·글꼴 같은 자산(코드가 아니다),
 * 그리고 `.vue`·`.svelte`(이 저장소는 쓰지 않는다). 그 꼴이 생기면 이
 * 목록을 같이 고쳐야 한다.
 */
const READ = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

const walkFailures = [];
function walk(dir) {
  const out = [];
  let names;
  try { names = readdirSync(dir); }
  catch (e) { walkFailures.push(`${dir} (${errCode(e)})`); return out; }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); }
    catch (e) { walkFailures.push(`${p} (${errCode(e)})`); continue; }
    if (st.isDirectory()) out.push(...walk(p));
    else if (READ.test(name)) out.push(p);
  }
  return out;
}

/** 예외에서 원인 코드만 꺼낸다 — 경로 외의 내용은 적지 않는다 */
function errCode(e) {
  const c = e && typeof e === 'object' && 'code' in e ? String(e.code) : String(e);
  return c.slice(0, 40);
}

const files = walk(ROOT);

// ── 발견이 성립했는가 ──
//
// 이 검사의 결론은 "legacy 키 사용 없음"이다. 그 문장은 파일을 실제로
// 읽은 뒤에만 참이다. 읽은 것이 0이면 "없음"이 아니라 **아직 모른다**다.
// 예전에는 `src`가 비어 있어도 그대로 "사용 없음"을 적었다 (실측 rc=0) —
// 이 검사기에는 고정 경로 읽기가 없어서 다른 단언이 우연히 잡아 주지도
// 않는다.
for (const f of walkFailures) {
  err(`훑지 못했습니다: ${f} — 못 본 것은 통과가 아닙니다.`
    + ' 그 아래에서 legacy 키를 읽는지 아무도 보지 않았습니다');
}
if (files.length === 0) {
  err(`${ROOT}에서 읽은 파일이 0개입니다 — 경로가 바뀌었는지 확인해야 합니다.`
    + ' 읽은 것이 0이면 "legacy 키 사용 없음"은 참이 아니라 아직 모른다는 뜻입니다');
}

for (const f of files) {
  const code = stripJsComments(readFileSync(f, 'utf8'));
  if (!code.includes(KEY)) continue;
  const line = code.split('\n').findIndex(l => l.includes(KEY)) + 1;
  err(`${f}:${line}: 제품 코드가 legacy ${KEY}을 씁니다 — 저장소 역사에서 production writer를 찾지 못한 키라 정상 흐름에서는 채워지지 않습니다. lib/auth/authToken을 쓰세요`);
}

console.log(bad === 0
  ? `✅ 인증 정본 하나 — 제품 코드에 legacy 키 사용 없음 (${ROOT} ${files.length}개 읽음 · 훑지 못한 곳 0)`
  : '\n인증 경로가 둘입니다. 정본은 lib/auth/authToken 하나입니다.\n실측 재현: scripts/probe/global-stop-auth.mjs · scripts/probe/home-auth.mjs');
process.exit(bad === 0 ? 0 : 1);
