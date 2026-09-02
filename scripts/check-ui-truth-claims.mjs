#!/usr/bin/env node
// scripts/check-ui-truth-claims.mjs
//
// **화면이 서버·실행 상태보다 센 말을 하지 못하게 한다.**
//
// 이 검사가 생긴 이유는 취향이 아니라 실제로 난 고장들이다:
//
//   ① 자동매매 전체정지가 서버를 부르지 않고 로컬 state만 바꾸면서
//      "모든 봇이 중단되었습니다"라고 적었다. 크론은 계속 돌고 있었다.
//   ② 봇 카드 여섯 장이 실행기에 연결돼 있지 않은데, 토글 한 번에
//      배지가 '실행중'이 되고 머리줄이 '실행중 1'이 됐다.
//   ③ 홈과 오른쪽 레일이 만들어 둔 기사를 "최신 뉴스"라는 제목으로,
//      실제 매체명과 "5분 전"까지 붙여 그렸다. 라우트는 이미
//      `source: 'mock'`이라고 알려 주고 있었는데 화면이 안 읽었다.
//   ④ 아카데미가 청산가를 `진입가 ÷ (1 + 레버리지)`라는 존재하지 않는
//      공식으로 가르쳤고, 골든크로스를 교차 사건이 아니라 부등식 상태로
//      정의했다.
//
// 넷 다 같은 모양이다 — **확인하지 않은 것을 확인한 것처럼 적었다.**
// 사람이 코드리뷰로 잡던 것을 여기서 잡는다.
//
// 주석은 계약이 아니다
// ────────────────────
// 위 문장들은 고친 파일의 설명 주석에도 그대로 적혀 있다. 주석을 지우지
// 않고 검사하면 "고장을 설명하는 주석"을 "고장"으로 읽고 무조건 실패한다.
// 반대로 규칙을 찾을 때도, 주석에 이름이 적혀 있다는 이유로 통과가 난다.
// 이 저장소에서 이미 두 번 일어난 일이다. 그래서 항상 주석을 지우고 본다.

import { readFileSync, existsSync } from 'node:fs';
import { stripJsComments } from './lib/strip-comments.mjs';
import { variableFunctionBody, functionBody } from './lib/function-body.mjs';

let bad = false;
const err = (m) => { bad = true; console.error(`❌ ${m}`); };

const AUTO     = 'src/components/pages/AutoPage.tsx';
const HOME     = 'src/components/pages/HomePage.tsx';
const RAIL     = 'src/app/page.tsx';
const ACADEMY  = 'src/components/pages/AcademyPage.tsx';
const STOPLIB  = 'src/lib/autotrade/globalStop.ts';
const FEEDLIB  = 'src/lib/news/feed.ts';
const CARDLIB  = 'src/lib/ui/strategyCard.ts';

const FILES = [AUTO, HOME, RAIL, ACADEMY, STOPLIB, FEEDLIB, CARDLIB];

/** 주석을 지운 본문. 파일이 없으면 여기서 멈춘다 — 못 읽은 것은 통과가 아니다. */
const code = {};
/** 파서에 넣을 원문. 주석을 지운 소스를 파서에 넣으면 위치가 어긋난다. */
const rawSrc = {};
for (const f of FILES) {
  if (!existsSync(f)) { err(`${f}를 찾지 못했습니다 — 이 검사가 무엇을 보고 있는지 다시 확인하세요`); continue; }
  const t = readFileSync(f, 'utf8');
  if (!t.trim()) { err(`${f}가 비어 있습니다`); continue; }
  rawSrc[f] = t;
  code[f] = stripJsComments(t);
}
if (bad) { console.error('\n검사할 파일을 못 읽었습니다. 여기서 멈춥니다.\n'); process.exit(1); }

const has = (f, re) => re.test(code[f]);
const need = (f, re, msg) => { if (!has(f, re)) err(`${f}: ${msg}`); };
const deny = (f, re, msg) => { if (has(f, re)) err(`${f}: ${msg}`); };

/* ── ① 전체정지: 서버를 부르지 않으면 멈췄다고 말할 수 없다 ──────
   원래 고장 그대로다. 로컬 state만 바꾸는 정지 버튼은 사용자가 위험을
   느껴 누른 그 순간에 아무것도 하지 않는다. */
const stopFn = variableFunctionBody(rawSrc[AUTO], 'handleGlobalStop');
if (!stopFn.ok) {
  err(`${AUTO}: 전체정지 경로를 읽지 못했습니다 — ${stopFn.reason}`);
} else {
  // 본문을 뽑은 **뒤에** 주석을 지운다. 설명 주석이 서버 호출을 대신
  // 증명해 주면 안 된다.
  const stopBody = stripJsComments(stopFn.body);
  if (!/\/api\/autotrade\/schedule/.test(stopBody)) {
    err(`${AUTO}: handleGlobalStop이 서버(/api/autotrade/schedule)를 부르지 않습니다 — 로컬 state만 바꾸는 정지는 정지가 아닙니다`);
  }
  if (!/PATCH/.test(stopBody)) {
    err(`${AUTO}: handleGlobalStop이 예약을 끄지 않습니다 — 목록만 읽고 껐다고 적으면 안 됩니다`);
  }
  if (!/unknownResult\s*\(/.test(stopBody)) {
    err(`${AUTO}: 목록을 못 읽었을 때의 판정(unknownResult)이 없습니다 — 화면이 스스로 결론을 적으면 그 결론은 서버와 갈립니다`);
  }

  /* **결과를 넣는 모든 자리**를 본다. 판정 함수를 한 번만 부르고 다른
     자리에서는 손으로 결과를 적으면, "부르긴 부른다"는 검사는 통과하고
     화면은 여전히 제 마음대로 결론을 낸다. 그래서 `setStopResult`에
     들어가는 값이 globalStop이 만든 것인지 자리마다 확인한다. */
  const ALLOWED_RESULT = /^(verify\s*\(|unknownResult\s*\(|IDLE_RESULT|\{\s*\.\.\.\s*IDLE_RESULT)/;
  const sites = [...stopBody.matchAll(/setStopResult\s*\(\s*([\s\S]{0,40})/g)];
  if (sites.length === 0) err(`${AUTO}: 전체정지가 결과를 남기지 않습니다`);
  for (const m of sites) {
    if (!ALLOWED_RESULT.test(m[1].trim())) {
      err(`${AUTO}: 전체정지 결과를 화면이 직접 지어냅니다 — \`${m[1].trim().slice(0, 30)}…\`. `
        + 'verify()/unknownResult()가 센 것만 넣으세요');
    }
  }

  /* ── 끄고 나서 다시 읽는가 ────────────────────────────────
     PATCH N개가 200을 받은 것은 그 N개에 대한 증거일 뿐이다. 그 사이에
     새 예약이 생기거나 다른 창에서 켜면 도는 것이 남는데, 예전에는
     마지막 GET이 목록만 갱신하고 판정에는 안 들어가서 화면이 계속
     "전부 껐다"고 적었다. 그 조회가 판정에 쓰이는지 본다. */
  if (!/verify\s*\(/.test(stopBody)) {
    err(`${AUTO}: 끄고 나서 다시 읽은 결과로 판정하지 않습니다 — verify(outcomes, after)를 쓰세요`);
  }
  if (!/state\s*:\s*'read'/.test(stopBody) || !/state\s*:\s*'unread'/.test(stopBody)) {
    err(`${AUTO}: 마지막 조회의 성공/실패를 구분하지 않습니다 — 못 읽었으면 "전부 꺼졌다"고 단정할 수 없습니다`);
  }
  /* 마지막 조회가 PATCH 뒤에 있어야 한다. 앞에 있으면 끄기 전 상태로
     판정하게 된다. */
  /* 남은 개수는 **다시 읽은 목록에서 세야 한다.** 상수를 적으면
     조회를 하고도 결과를 안 보는 것과 같다. */
  if (/state\s*:\s*'read'\s*,\s*remaining\s*:\s*\d/.test(stopBody)) {
    err(`${AUTO}: 다시 읽은 뒤 남은 개수를 상수로 적습니다 — 조회 결과에서 세세요`);
  }
  if (!/remaining\s*:\s*stopTargets\s*\(/.test(stopBody)) {
    err(`${AUTO}: 남은 개수를 다시 읽은 목록에서 세지 않습니다`);
  }

  /* **끄기 전과 후, 두 번 읽어야 한다.** 뒤쪽 조회를 지우고 빈 목록을
     넣으면 remaining이 늘 0이 되어 항상 "전부 껐다"가 된다. */
  const reads = (stopBody.match(/loadSchedules\s*\(\s*\)/g) || []).length;
  if (reads < 2) {
    err(`${AUTO}: 예약 목록을 ${reads}번만 읽습니다 — 끄기 전과 끈 뒤 두 번 읽어야 지금 상태를 말할 수 있습니다`);
  }

  const lastPatch = stopBody.lastIndexOf('PATCH');
  const verifyAt = stopBody.indexOf('verify(');
  if (lastPatch >= 0 && verifyAt >= 0 && verifyAt < lastPatch) {
    err(`${AUTO}: 끄기 전 상태로 판정합니다 — 다시 읽는 것은 PATCH 뒤여야 합니다`);
  }

  /* 화면이 직접 쓸 수 있는 상태는 '아직 모른다'(STOPPING)뿐이다.
     ALL_STOPPED·REMAINS·UNVERIFIED는 서버 응답을 센 결과여야 한다. */
  for (const m of stopBody.matchAll(/code\s*:\s*'([A-Z_]+)'/g)) {
    if (m[1] !== 'STOPPING') {
      err(`${AUTO}: 전체정지가 '${m[1]}'를 손으로 적습니다 — 서버 응답을 센 결과만 씁니다`);
    }
  }
}

/* 화면 어디에서도 "모든 봇이 중단" 류의 문장을 적지 않는다.
   개수는 globalStop.headline이 서버 응답에서 센 것만 적는다. */
for (const f of [AUTO, HOME, RAIL]) {
  deny(f, /모든\s*봇/, '"모든 봇"이라고 적습니다 — 서버가 확인해 준 개수만 말하세요');
  deny(f, /모두\s*(중단|정지)(됐|되었)/, '전부 멈췄다고 단정합니다 — 확인한 개수만 적으세요');
  /* **"모든 봇"만 막으면 같은 거짓말이 다른 말로 돌아온다.**
     실제로 그랬다: 버튼과 결과 문장은 고쳤는데 카드 설명에
     "모든 자동매매를 즉시 중단합니다"가 그대로 남아 있었고, 검사는
     초록이었다. 같은 카드 안에서 위 문장과 아래 문장이 반대였다.
     그래서 대상(봇·자동매매·전략·예약)과 동작(중단·정지)의 조합으로 본다. */
  deny(f, /모든\s*(자동매매|전략|봇|예약)[^.\n]{0,20}(즉시\s*)?(중단|정지)(합니다|됩니다|한다|시킵니다)/,
    '"모든 …를 중단합니다"라고 약속합니다 — 예약을 끄는 것은 청산도 주문 취소도 아닙니다');
  deny(f, /전체\s*(중단|정지)\s*(완료|됨|됐)/, '"전체 중단 완료"를 적습니다 — 서버로 확인한 상태만 적으세요');
}

/* ── 긴급정지 카드 안만 따로 본다 ─────────────────────────
   **파일 전체에서 문구를 찾으면 다른 곳에 있는 같은 문장이 검사를
   대신 통과시킨다.** 실제로 그랬다: 버튼 아래 작은 글씨에는 경계가
   적혀 있었고 카드 설명에는 "모든 자동매매를 즉시 중단합니다"가
   남아 있었는데, 파일 어딘가에 경계 문장이 있다는 이유로 초록이었다.
   같은 카드 안에서 위와 아래가 반대인 것이 문제였으므로 그 카드만 본다. */
const stopCardAt = code[AUTO].indexOf('긴급 정지');
if (stopCardAt < 0) {
  err(`${AUTO}: 긴급 정지 카드를 찾지 못했습니다 — 이 검사가 무엇을 보는지 다시 확인하세요`);
} else {
  const end = code[AUTO].indexOf('</Card>', stopCardAt);
  const card = code[AUTO].slice(stopCardAt, end < 0 ? stopCardAt + 1500 : end);
  const cardNeed = (re, msg) => { if (!re.test(card)) err(`${AUTO} 긴급정지 카드: ${msg}`); };
  const cardDeny = (re, msg) => { if (re.test(card)) err(`${AUTO} 긴급정지 카드: ${msg}`); };

  cardDeny(/모든\s*(자동매매|전략|봇|예약)[^.\n]{0,20}(즉시\s*)?(중단|정지)/,
    '"모든 …를 중단합니다"라고 약속합니다 — 버튼은 예약을 끌 뿐이고 청산도 주문 취소도 하지 않습니다');
  cardDeny(/즉시\s*중단/, '"즉시 중단"이라고 적습니다 — 예약을 끄는 것은 이미 열린 것을 멈추지 않습니다');
  cardNeed(/새\s*진입/, '"새 진입만 막는다"는 경계를 말하지 않습니다');
  cardNeed(/열린\s*포지션/, '열린 포지션이 남는다는 사실을 말하지 않습니다');
  cardNeed(/(거래소\s*)?주문[^.\n]{0,20}(취소|남습니다|그대로)/, '기존 거래소 주문이 취소되지 않는다는 사실을 말하지 않습니다');
}

/* 판정 문장은 globalStop 한 곳에서만 만든다. */
need(STOPLIB, /export\s+function\s+verify\s*\(/,
  'verify가 없습니다 — 다시 읽은 결과로 판정하는 곳이 사라졌습니다');
/* 상태 이름이 `verify` 본문에만 남고 타입에서 빠지면, 다음 사람이
   그 갈래를 없애도 아무도 막지 않는다. 타입 선언 자체를 본다. */
/* verify가 실제로 마지막 조회 결과를 보고 갈라지는가. `after`를 받기만
   하고 안 보면 인자는 장식이고 판정은 다시 PATCH 성공 수로 돌아간다. */
{
  const r = functionBody(rawSrc[STOPLIB], 'verify');
  if (!r.ok) {
    err(`${STOPLIB}: verify 본문을 읽지 못했습니다 — ${r.reason}`);
  } else {
    const b = stripJsComments(r.body);
    if (!/after\.state\s*===\s*'unread'/.test(b)) {
      err(`${STOPLIB}: verify가 "다시 읽지 못한 경우"를 갈라 보지 않습니다`);
    }
    if (!/after\.remaining\s*>\s*0/.test(b)) {
      err(`${STOPLIB}: verify가 남아 있는 개수를 보지 않습니다 — PATCH 성공 수만으로 판정하게 됩니다`);
    }
    if (!/code:\s*'ALL_STOPPED'/.test(b) || !/code:\s*'REMAINS'/.test(b) || !/code:\s*'UNVERIFIED'/.test(b)) {
      err(`${STOPLIB}: verify가 세 갈래(확인됨/남음/확인못함)를 모두 내지 않습니다`);
    }
  }
}

const codeUnion = /export\s+type\s+GlobalStopCode\s*=([\s\S]*?);/.exec(code[STOPLIB]);
if (!codeUnion) {
  err(`${STOPLIB}: GlobalStopCode 선언을 찾지 못했습니다`);
} else {
  for (const [name, why] of [
    ['UNVERIFIED', '다시 읽지 못한 상태가 사라졌습니다 — 그러면 확인 못 한 것을 껐다고 적게 됩니다'],
    ['REMAINS', '아직 켜진 것이 남은 상태가 사라졌습니다'],
    ['ALL_STOPPED', '전체 비활성 확인 상태가 사라졌습니다'],
    ['UNKNOWN', '목록조차 못 읽은 상태가 사라졌습니다'],
  ]) {
    if (!codeUnion[1].includes(`'${name}'`)) err(`${STOPLIB}: ${name} — ${why}`);
  }
}
need(STOPLIB, /export\s+function\s+headline\s*\(/, 'headline이 없습니다 — 결과 문장의 정본이 사라졌습니다');
need(STOPLIB, /export\s+function\s+boundaryNote\s*\(/, 'boundaryNote가 없습니다 — 예약을 끄는 것이 청산이 아니라는 경계 설명이 사라졌습니다');
deny(STOPLIB, /모든\s*봇/, '"모든 봇" 표현이 판정 문장에 들어왔습니다');

/* ── ② 못 읽은 개수를 0으로 적지 않는다 ──────────────────────
   CLAUDE.md: "UNKNOWN을 0으로 적지 않는다. 확인하지 못한 것은 통과가
   아니다." 목록을 못 읽었으면 null이고, 화면은 모른다고 말해야 한다. */
need(AUTO, /schedRows\s*===\s*null\s*\?\s*null/,
  '예약 목록을 못 읽었을 때 개수를 null로 두지 않습니다 — 모르는 것을 0으로 적으면 "아무것도 안 돌고 있다"로 읽힙니다');
deny(AUTO, /schedRows\s*(\|\|\s*\[\]|\?\?\s*\[\])/,
  '못 읽은 예약 목록을 빈 배열로 대신합니다 — 그러면 실패가 "0개"가 됩니다');

/* ── ③ 연결되지 않은 목록은 '실행중'이라고 말하지 않는다 ────────
   봇 카드는 이 화면의 React 상태일 뿐이다. 배지 이름을 고르는 판단이
   strategyCard 한 곳에 있어야, 나중에 진짜 목록을 붙이는 사람이 그
   질문을 건너뛸 수 없다. */
need(CARDLIB, /export\s+function\s+activityLabel\s*\(/, 'activityLabel이 없습니다 — 연결 여부에 따라 칸 이름을 고르는 판단이 사라졌습니다');
need(CARDLIB, /UNWIRED_ACTIVITY_LABEL/, 'UNWIRED_ACTIVITY_LABEL이 없습니다');
if (/UNWIRED_ACTIVITY_LABEL[^=]*=\s*\{([^}]*)\}/.test(code[CARDLIB])) {
  const body = RegExp.$1;
  if (/실행/.test(body)) err(`${CARDLIB}: 연결되지 않은 목록의 칸 이름이 "실행"이라고 말합니다`);
}
need(AUTO, /activityLabel\s*\(/, '봇 카드 배지가 activityLabel을 쓰지 않습니다');
deny(AUTO, /ACTIVITY_LABEL\s*\[/, '연결되지 않은 목록이 실행중 칸 이름을 직접 씁니다 — activityLabel(act, wired)로 물어보세요');
/* 연결되지 않은 카드가 로컬 성과 숫자를 실제 성적처럼 그리지 않는가.
   위쪽 지표에서 UNKNOWN→0을 없애 놓고 카드 안에서 같은 0을 그리면
   한 화면에 규칙이 두 개가 된다 — 실제로 그 상태로 한 번 나갔다. */
need(CARDLIB, /export\s+function\s+cardPerfLine\s*\(/, 'cardPerfLine이 없습니다 — 카드 성과 표시의 판단이 사라졌습니다');
need(CARDLIB, /export\s+function\s+cardPerfInput\s*\(/, 'cardPerfInput이 없습니다');
/* 두 함수 모두 연결 여부로 갈라져야 한다. `wired`를 받기만 하고 안 보면
   인자는 장식이고 카드는 다시 0을 그린다. */
for (const fn of ['cardPerfLine', 'cardPerfInput']) {
  const r = functionBody(rawSrc[CARDLIB], fn);
  if (!r.ok) { err(`${CARDLIB}: ${fn} 본문을 읽지 못했습니다 — ${r.reason}`); continue; }
  const b = stripJsComments(r.body);
  if (!/!\s*wired/.test(b)) {
    err(`${CARDLIB}: ${fn}이 연결 여부(wired)로 갈라지지 않습니다 — 인자만 받고 무시하면 카드는 다시 0을 그립니다`);
  }
}
if (!/\bmeasured\s*\(/.test(code[CARDLIB])) {
  err(`${CARDLIB}: 잰 값만 숫자로 읽는 함수(measured)가 없습니다 — Number(null)은 0이라 없는 값이 0원이 됩니다`);
}
need(AUTO, /cardPerfLine\s*\(\s*s\s*,\s*STRAT_LIST_WIRED\s*\)/,
  '카드 머리줄이 연결 여부를 묻지 않고 성과를 그립니다 — cardPerfLine(s, STRAT_LIST_WIRED)를 쓰세요');
need(AUTO, /perfSummaryOf\s*\(\s*cardPerfInput\s*\(\s*s\s*,\s*STRAT_LIST_WIRED\s*\)\s*\)/,
  '펼친 성과 표가 로컬 값을 그대로 넘깁니다 — cardPerfInput(s, STRAT_LIST_WIRED)를 거치세요');
/* 예시 카드의 변수는 `s`다. `sp.metrics.totalPnl`(실제 매매기록에서
   계산한 값)까지 막으면 잰 값을 못 그리게 되므로, 앞에 다른 식별자가
   붙지 않은 `s.` 만 본다. */
deny(AUTO, /(?<![A-Za-z0-9_$.])s\.(totalPnl|winRate)\b/,
  '카드가 예시 전략의 로컬 성과 값(totalPnl/winRate)을 직접 그립니다 — 잰 적 없는 0을 성적으로 적게 됩니다');
deny(AUTO, /(?<![A-Za-z0-9_$.])s\.trades\s*[>=<]/,
  '카드가 예시 전략의 로컬 거래수로 분기합니다 — cardPerfLine이 판단하게 하세요');
deny(AUTO, /['"]거래 없음['"]/,
  '"거래 없음"을 화면이 직접 적습니다 — 서버에 물어본 적이 없으면 거래가 없었는지도 모릅니다');

need(AUTO, /const\s+STRAT_LIST_WIRED\s*=\s*false/,
  '봇 카드 목록이 실행기에 연결됐다고 선언했습니다 — 정말 연결했다면 이 검사와 카드 안내 문구를 같이 고치세요');

/* ── ④ 뉴스: 출처를 읽지 않고 "최신"이라 부르지 않는다 ──────────
   라우트는 공급자에서 못 받으면 `source:'mock'`으로 답한다. 화면이 그
   필드를 안 보면 만들어 둔 기사가 실제 매체명과 "5분 전"을 달고 나온다. */
for (const f of [HOME, RAIL]) {
  deny(f, /MOCK_NEWS/, 'MOCK_NEWS를 화면이 직접 그립니다 — 서버 응답의 출처를 읽으세요');
  deny(f, /['"`]최신\s*뉴스['"`]/, '"최신 뉴스"를 고정 문자열로 적습니다 — feedTitle(provenance)로 출처를 반영하세요');
  need(f, /from\s*['"][^'"]*lib\/news\/feed['"]/, '뉴스 출처 판정(lib/news/feed)을 쓰지 않습니다');
  need(f, /feedTitle\s*\(/, 'feedTitle을 쓰지 않습니다 — 제목이 출처를 반영하지 않습니다');
  need(f, /itemTime\s*\(/, 'itemTime을 쓰지 않습니다 — 예시 기사의 "5분 전"이 그대로 그려집니다');
  need(f, /itemSource\s*\(/, 'itemSource를 쓰지 않습니다 — 예시 기사에 실제 매체명이 붙습니다');
}
need(FEEDLIB, /source\s*===\s*['"]newsapi['"]/, '실물 판정 기준이 사라졌습니다');
if (/export function toFeed[\s\S]*?\n\}/.test(code[FEEDLIB])) {
  const body = RegExp.lastMatch;
  if (/MOCK|SAMPLE_ITEMS|fallbackItems/.test(body)) {
    err(`${FEEDLIB}: 응답을 못 읽었을 때 예시로 채웁니다 — 없는 것을 그럴듯한 것으로 메우지 마세요`);
  }
}

/* ── ⑤ 아카데미: 없는 공식을 가르치지 않는다 ────────────────────
   청산가는 거래소·계약형태·마진 모드·유지증거금률에 따라 달라진다.
   단일 공식 하나로 답을 주면, 그 숫자를 믿고 포지션을 잡는다. */
deny(ACADEMY, /÷\s*\(\s*1\s*[+＋]\s*레버리지/, '존재하지 않는 청산가 공식을 가르칩니다');
deny(ACADEMY, /\/\s*\(\s*1\s*\+\s*(leverage|lev|배율)/i, '청산가를 단일 공식으로 계산해 줍니다');
deny(ACADEMY, /청산가\s*[=＝]/, '청산가를 등식 하나로 정의합니다 — 거래소마다 다릅니다');
/* 가정·한계는 **두 강의 모두**에 있어야 한다. 하나만 남으면 나머지
   강의가 조용히 "이게 전부"라고 말하는 상태로 돌아간다. 정규식이
   `caveatsX` 같은 이름에 걸려 통과하지 않도록 콜론까지 본다. */
const countOf = (f, re) => (code[f].match(re) || []).length;
if (countOf(ACADEMY, /\bcaveats\s*:/g) < 2) {
  err(`${ACADEMY}: 가정·한계(caveats)를 적은 강의가 2개 미만입니다 — 청산과 골든크로스 둘 다 필요합니다`);
}
if (countOf(ACADEMY, /\bscope\s*:/g) < 2) {
  err(`${ACADEMY}: 성립 범위(scope)를 적은 강의가 2개 미만입니다`);
}
/* 교차 마진에 단일 공식이 없다는 말은 반드시 남는다 — 이것을 지우면
   격리 마진 공식 하나를 "그 공식"으로 읽게 된다. */
need(ACADEMY, /교차\s*마진[\s\S]{0,120}?(성립하지\s*않|없습니다)/,
  '교차 마진에 단일 청산가 공식이 성립하지 않는다는 설명이 사라졌습니다');
need(ACADEMY, /(유지증거금|MMR)/, '유지증거금률 가정을 적지 않습니다');
need(ACADEMY, /펀딩/, '펀딩비가 증거금을 줄인다는 가정을 적지 않습니다');
/* 적어 두기만 하고 화면에 안 그리면 없는 것과 같다. UI-1에서 겪은
   "만들어 놓고 배선을 안 함"이 정확히 이 모양이었다. */
need(ACADEMY, /caveats[\s\S]{0,400}?\.map\s*\(/, 'caveats를 화면에 그리지 않습니다 — 데이터에만 있고 화면에 없으면 없는 것입니다');
need(ACADEMY, /\.scope\s*&&|\(lesson as any\)\.scope/, 'scope를 화면에 그리지 않습니다');

/* ── ⑥ 골든크로스는 상태가 아니라 사건이다 ──────────────────
   원래 본문은 `골든크로스는 단기MA > 장기MA인 상태`라고 적었다. 그러면
   몇 주 전에 끝난 교차도 계속 "골든크로스"가 된다.

   **부등식이 나온다는 것만으로 막지 않는다.** 지금 본문은 "위에 있는
   상태(단기 > 장기)는 교차가 아니라 그 뒤의 배열"이라고 **부정하기
   위해** 같은 부등식을 쓴다. 그것까지 막으면 옳게 쓴 글이 걸리고,
   사람은 검사기를 피해 글을 나쁘게 고친다. 그래서 `골든크로스`라는
   말 바로 뒤에서 정의로 쓰이는 경우만 본다. */
deny(ACADEMY, /골든\s*크로스[^.。\n]{0,60}단기\s*(이동평균선|이평선|MA|선)?\s*[>＞]\s*장기/,
  '골든크로스를 부등식 상태로 정의합니다 — 아래에서 위로 교차하는 사건입니다');
need(ACADEMY, /골든\s*크로스[\s\S]{0,300}?아래에서\s*위로/,
  '골든크로스를 교차 사건("아래에서 위로")으로 설명하지 않습니다');
need(ACADEMY, /상태가\s*아니라\s*사건/,
  '골든크로스가 상태가 아니라 사건이라는 구분이 사라졌습니다');

if (bad) {
  console.error('\n화면이 확인하지 않은 것을 확인한 것처럼 적고 있습니다.\n'
    + '표시를 낮추거나, 서버에서 확인하는 경로를 붙이세요.\n');
  process.exit(1);
}
console.log('✅ UI 사실성 계약 — 화면이 서버·실행 상태보다 센 말을 하지 않습니다');
