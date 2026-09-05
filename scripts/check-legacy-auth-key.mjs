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

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

for (const f of walk(ROOT)) {
  const code = stripJsComments(readFileSync(f, 'utf8'));
  if (!code.includes(KEY)) continue;
  const line = code.split('\n').findIndex(l => l.includes(KEY)) + 1;
  err(`${f}:${line}: 제품 코드가 legacy ${KEY}을 씁니다 — 저장소 역사에서 production writer를 찾지 못한 키라 정상 흐름에서는 채워지지 않습니다. lib/auth/authToken을 쓰세요`);
}

console.log(bad === 0
  ? '✅ 인증 정본 하나 — 제품 코드에 legacy 키 사용 없음'
  : '\n인증 경로가 둘입니다. 정본은 lib/auth/authToken 하나입니다.\n실측 재현: scripts/probe/global-stop-auth.mjs · scripts/probe/home-auth.mjs');
process.exit(bad === 0 ? 0 : 1);
