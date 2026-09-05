#!/usr/bin/env node
// 전체정지가 **서버에 닿는 인증 경로**를 쓰는가.
//
// 무엇이 고장나 있었나
// ────────────────────
// 전체정지는 두 번 서버를 부른다 — 무엇이 켜져 있는지 읽는 GET, 그리고
// 하나씩 끄는 PATCH. 둘 다 `localStorage.sb_access_token`을 읽고 있었다.
//
// 그런데 **저장소 역사에서 그 키를 쓰는 production writer를 찾지 못했다.**
// 정상 production app flow에서는 그 키가 채워지지 않고, 읽는 쪽은 비면
// 요청 전에 종료한다. 브라우저 실측 — base(d614dfb)의 canonical-session
// fixture에서 버튼을 누른 뒤 **GET 0회 · PATCH 0회**를 재현했다.
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

/** 토큰을 담은 변수 이름. 이름이 바뀌어도 따라간다. */
function authVarOf(body) {
  const m = /const\s+(\w+)\s*=\s*await\s+probeAuthToken\s*\(/.exec(body);
  return m ? m[1] : null;
}

/**
 * 이 본문 안의 `/api/autotrade/schedule` 호출들의 **옵션 객체**를 잘라 온다.
 *
 * 왜 호출 단위로 보는가: 함수 안에 `probeAuthToken()`이 있는지만 보면
 * 토큰을 얻어 놓고 **헤더에 안 넣어도** 통과한다. 실제로 그 돌연변이가
 * 검사기를 초록으로 통과했다 — 이번 버그가 바로 "요청이 인증 경로에
 * 닿는가"이므로 그 구멍은 이 검사기를 무의미하게 만든다.
 */
function scheduleCallOptions(body) {
  const out = [];
  const re = /fetch\(\s*'\/api\/autotrade\/schedule'/g;
  let m;
  while ((m = re.exec(body))) {
    const after = body.slice(m.index + m[0].length);
    // URL 뒤에 곧바로 `,` + `{`가 와야 옵션 객체다. 없으면 헤더 자체가 없다.
    const opt = /^\s*,\s*\{/.exec(after);
    if (!opt) { out.push(''); continue; }
    const start = m.index + m[0].length + opt[0].length - 1;
    let depth = 0, end = body.length;
    for (let i = start; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    out.push(body.slice(start, end));
  }
  return out;
}

/* ── ③ 얻은 토큰이 **실제로 요청 헤더에 들어간다** ───────
   ②는 토큰을 얻는지만 본다. 얻어 놓고 안 쓰면 버튼은 다시 서버에 닿지
   못한다 — 그게 이번에 고친 고장 그 자체다. */
for (const [fn, what, needMethod] of [
  ['const loadSchedules', '전체정지가 무엇을 끌지 읽는 호출', null],
  ['const handleGlobalStop', '실제로 끄는 호출', 'PATCH'],
]) {
  const body = bodyOf(fn);
  if (!body) { err(`${PAGE}: ${fn}을 찾지 못했습니다`); continue; }

  const v = authVarOf(body);
  if (!v) {
    err(`${PAGE}: ${what}(${fn})이 정본 토큰을 얻지 않습니다`);
    continue;
  }

  const opts = scheduleCallOptions(body);
  if (opts.length === 0) {
    err(`${PAGE}: ${fn}이 /api/autotrade/schedule을 부르지 않습니다`);
    continue;
  }
  opts.forEach((o, i) => {
    if (!o) {
      err(`${PAGE}: ${fn}의 ${i + 1}번째 schedule 호출에 옵션이 없습니다 — 인증 헤더가 붙지 않습니다`);
      return;
    }
    // 얻은 그 변수여야 한다. ''나 다른 변수를 넣으면 서버가 401을 준다.
    if (!new RegExp(`Authorization\\s*:\\s*${v}\\b`).test(o)) {
      err(`${PAGE}: ${fn}의 ${i + 1}번째 schedule 호출이 Authorization에 ${v}를 넣지 않습니다 — 토큰을 얻어 놓고 쓰지 않으면 요청은 서버에 닿지 못합니다`);
    }
    // `Bearer ${...}`로 다시 감싸면 정본 값이 이미 'Bearer …'라 두 번 붙는다.
    if (/Authorization\s*:\s*`Bearer \$\{/.test(o)) {
      err(`${PAGE}: ${fn}이 Bearer를 한 번 더 붙입니다 — 정본 값에 이미 들어 있습니다`);
    }
  });

  if (needMethod && !opts.some(o => new RegExp(`method\\s*:\\s*'${needMethod}'`).test(o))) {
    err(`${PAGE}: ${fn}에 ${needMethod} 호출이 없습니다 — 끄는 요청이 사라졌습니다`);
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
