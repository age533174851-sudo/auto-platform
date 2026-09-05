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
  err(`${PAGE}: 전체정지가 legacy sb_access_token으로 인증합니다 — 저장소 역사에서 production writer를 찾지 못한 키라, 정상 흐름에서는 채워지지 않아 요청이 서버에 닿지 못합니다`);
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
/**
 * `{...}`에서 균형 잡힌 중괄호로 한 덩어리를 잘라 온다.
 * `start`는 여는 중괄호의 위치여야 한다.
 */
function braceBlock(src, start) {
  if (src[start] !== '{') return '';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
}

/**
 * 객체 리터럴에서 **depth 1 속성만** 읽는다. `Map<key, valueSource>`.
 *
 * 왜 문자열 검색으로는 안 되나
 * ───────────────────────────
 * `headers:`나 `method:'PATCH'`를 옵션 전체에서 찾으면 **중첩된 것**도 잡힌다.
 * 아래는 실제 HTTP 헤더도 메서드도 없는데 통과했다:
 *
 *   fetch(url, { meta: { headers: { Authorization: auth } } })
 *   fetch(url, { headers: {...}, meta: { method: 'PATCH' } })
 *
 * fetch가 실제로 읽는 것은 **최상위 속성**뿐이다. 그래서 검사기도 거기까지만
 * 본다. 문자열·템플릿·중첩 괄호를 건너뛰며 걷는다.
 *
 * 값을 특정할 수 없는 형태(단축 속성 `{ headers }`, 스프레드)는 `null`로 둔다 —
 * 모르는 것을 통과로 세지 않는다.
 */
function topLevelProps(obj) {
  const out = new Map();
  if (!obj || obj[0] !== '{') return out;
  const end = obj.length - 1;              // 닫는 '}'
  let i = 1;
  const skipString = () => {
    const q = obj[i++];
    while (i < end && obj[i] !== q) { if (obj[i] === '\\') i++; i++; }
    i++;
  };
  while (i < end) {
    while (i < end && /[\s,]/.test(obj[i])) i++;
    if (i >= end) break;
    if (obj[i] === '.') {                  // 스프레드 — 무엇이 들어올지 모른다
      while (i < end && obj[i] !== ',') i++;
      out.set('...', null);
      continue;
    }
    let key = '';
    if (obj[i] === "'" || obj[i] === '"') {
      const q = obj[i++];
      while (i < end && obj[i] !== q) { if (obj[i] === '\\') i++; key += obj[i++]; }
      i++;
    } else {
      while (i < end && /[A-Za-z0-9_$]/.test(obj[i])) key += obj[i++];
    }
    while (i < end && /\s/.test(obj[i])) i++;
    if (obj[i] !== ':') {                  // 단축 속성 — 값을 여기서 알 수 없다
      while (i < end && obj[i] !== ',') i++;
      if (key) out.set(key, null);
      continue;
    }
    i++;
    while (i < end && /\s/.test(obj[i])) i++;
    const vStart = i;
    let d = 0;
    while (i < end) {
      const c = obj[i];
      if (c === "'" || c === '"' || c === '`') { skipString(); continue; }
      if (c === '{' || c === '[' || c === '(') { d++; i++; continue; }
      if (c === '}' || c === ']' || c === ')') { if (d === 0) break; d--; i++; continue; }
      if (c === ',' && d === 0) break;
      i++;
    }
    out.set(key, obj.slice(vStart, i).trim());
  }
  return out;
}

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
  let sawMethod = false;
  opts.forEach((o, i) => {
    const where = `${fn}의 ${i + 1}번째 schedule 호출`;
    if (!o) {
      err(`${PAGE}: ${where}에 옵션이 없습니다 — 인증 헤더가 붙지 않습니다`);
      return;
    }
    // fetch가 읽는 것은 **최상위 속성**뿐이다. 중첩된 headers·method는 아니다.
    const top = topLevelProps(o);

    if (needMethod && top.get('method') === `'${needMethod}'`) sawMethod = true;

    const h = top.get('headers');
    if (h == null) {
      err(`${PAGE}: ${where}에 최상위 headers가 없습니다 — 인증 헤더가 붙지 않습니다`);
      return;
    }
    if (h[0] !== '{') {
      err(`${PAGE}: ${where}의 headers를 여기서 읽을 수 없습니다(${h.slice(0, 30)}) — 인증 헤더가 붙었는지 확인하지 못합니다`);
      return;
    }
    // headers **자신의** 속성이어야 한다. 그 안에 또 중첩된 것은 헤더가 아니다.
    const hp = topLevelProps(h);
    const a = hp.get('Authorization');
    if (a == null) {
      err(`${PAGE}: ${where}의 headers에 Authorization이 없습니다 — 토큰을 얻어 놓고 싣지 않으면 요청은 서버에 닿지 못합니다`);
      return;
    }
    // `Bearer ${...}`로 다시 감싸면 정본 값이 이미 'Bearer …'라 두 번 붙는다.
    if (/^`Bearer \$\{/.test(a)) {
      err(`${PAGE}: ${fn}이 Bearer를 한 번 더 붙입니다 — 정본 값에 이미 들어 있습니다`);
      return;
    }
    // 얻은 그 변수여야 한다. ''나 다른 변수를 넣으면 서버가 401을 준다.
    if (a !== v) {
      err(`${PAGE}: ${where}의 Authorization이 ${v}가 아니라 ${a}입니다 — 얻은 토큰을 싣지 않으면 요청은 서버에 닿지 못합니다`);
    }
  });

  if (needMethod && !sawMethod) {
    err(`${PAGE}: ${fn}에 최상위 method:'${needMethod}'인 호출이 없습니다 — 끄는 요청이 사라졌습니다`);
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
