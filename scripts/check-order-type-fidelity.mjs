#!/usr/bin/env node
// scripts/check-order-type-fidelity.mjs
//
// **사용자가 고른 주문유형이 그대로 나가는가.**
//
// 무엇이 있었나
// ─────────────
// 화면은 `시장가 / 지정가 / 조건부` 셋을 고르게 했고, 지정가·조건부에는
// 가격 입력칸까지 띄웠다. 그런데 요청 본문은:
//
//   type: 'MARKET'
//
// 로 박혀 있었고 입력한 가격은 한 번도 읽히지 않았다. 지정가를 눌러도,
// 트리거가를 적어도 지금 값에 즉시 체결되는 시장가가 나갔다. 조건부는
// 서버·워커·어댑터 어디에도 진입 트리거가 없어 화면에만 있는 선택지였다.
//
// 그리고 수량의 기준가도 문제였다. `amount`는 포지션 명목가(USDT)이므로
// 지정가 주문의 수량은 **지정가로** 나눠야 한다. 마크가로 나누면
// 100 USDT · 마크가 2,500 · 지정가 2,000에서 수량이 0.04가 되고 실제 체결
// 명목은 `0.04 × 2,000 = 80 USDT`가 된다 — 사용자가 적은 100이 아니다.
//
// 이 검사가 지키는 것
// ───────────────────
//   · 화면의 선택지 ⊆ 서버 validateOrder가 받는 집합
//   · 목록이 한 파일에서 온다 (두 벌이면 언젠가 갈린다)
//   · 요청 본문의 type이 리터럴이 아니라 고른 값이다
//   · 지정가면 가격을 함께 보낸다
//   · 수량 기준가를 화면이 따로 정하지 않는다
//   · 조건부는 고를 수 없다 (뒤에서 시장가로 바꾸지 않는다)
//   · 종목·연결·통화가 바뀌면 남은 지정가를 지운다
//
// 사용: node scripts/check-order-type-fidelity.mjs

import { readFileSync, existsSync } from 'node:fs';
import { stripJsComments } from './lib/strip-comments.mjs';

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);

// 이 파일도 설명에 `type: 'MARKET'`과 `CONDITIONAL`을 그대로 적는다. 그래서
// 읽은 본문에서 주석을 걷어야 한다.
//
// **여기에 `stripJs` 사본이 있었다.** 공용 `scripts/lib/strip-comments.mjs`의
// 머리글이 그 위험을 미리 적어 두었다:
//
//   그래서 이 함수를 **한 곳에만** 둔다. 검사기마다 각자 복사해 두면 언젠가
//   한쪽만 고쳐지고, 그때부터 그 검사기는 조용히 아무것도 막지 않는다.
//
// 그 일이 일어났다. 사본은 **정규식 리터럴을 모른다** — `/["\']+/g`를 만나면
// 안의 `"`를 문자열 시작으로 읽고 가짜 문자열 상태에 빠지고, 그 상태에서는
// `//`를 주석으로 보지 않아 **주석 본문이 코드로 남는다.** 기계 탐침으로
// 실제로 돌려 확인했다(TS 구문 유효):
//
//     const QUOTES = /["\']+/g;
//     // export function sizingPriceOf
//     export function zizingPriceOf(t) { … }
//
//   이름만 바꾸면                                   rc=1
//   정규식 없이 같은 주석만 남기면                   rc=1   ← 탈선이 원인이라는 대조
//   위처럼 정규식 뒤에 주석을 남기면                 rc=0   ← 구멍
//
// 그래서 사본을 지우고 공용 함수를 쓴다. 지금 main의 공용 함수도 같은 탈선을
// 갖고 있어서 이 교체만으로 위 구멍이 닫히지는 않는다. **대신 고칠 자리가
// 하나가 된다** — PR #795가 공용 함수의 그 탈선을 고치고, 같은 변이를 #795
// 판으로 재면 주석 문구가 코드로 남지 않는다(실측: 사본 true · main true ·
// #795 false). 사본을 남겨 두면 #795가 병합돼도 이 검사기만 조용히 뚫린 채
// 남는다.
/** `from` 이후 짝이 맞는 중괄호까지 */
function braceBodyAt(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

/** 서명 괄호를 넘긴 뒤의 본문 */
function fnBodyAt(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return '';
  const paren = src.indexOf('(', at);
  if (paren < 0) return '';
  let depth = 0, i = paren;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) break; }
  }
  return braceBodyAt(src, i);
}

const TYPES = 'src/lib/markets/orderTypes.ts';
const CURR = 'src/lib/markets/orderCurrency.ts';
const VALID = 'src/lib/engine/orderValidation.ts';
const PAGE = 'src/components/pages/TradingPage.tsx';
const TEST = 'src/lib/markets/orderTypes.test.ts';

// ── 1. 목록은 한 곳에 있다 ──
if (!existsSync(TYPES)) fail(`${TYPES}이 없습니다`);
else {
  const t = stripJsComments(readFileSync(TYPES, 'utf8'));
  if (!/export const SERVER_ORDER_TYPES\s*=/.test(t)) fail(`${TYPES}에 SERVER_ORDER_TYPES가 없습니다`);
  if (!/export function sizingPriceOf\b/.test(t)) fail(`${TYPES}에 sizingPriceOf가 없습니다`);
  // 기준가 함수가 못 정했을 때 값을 지어내면 안 된다.
  const sz = fnBodyAt(t, 'export function sizingPriceOf');
  if (!sz) fail(`${TYPES}에서 sizingPriceOf 본문을 찾지 못했습니다`);
  else {
    for (const code of ['NATIVE_PRICE_UNKNOWN', 'LIMIT_PRICE_REQUIRED', 'UNSUPPORTED_ORDER_TYPE']) {
      if (!sz.includes(code)) fail(`${TYPES}의 sizingPriceOf가 ${code}를 구분하지 않습니다`);
    }
    // ── 지정가 갈래가 거래소 가격을 보면 안 된다 ──
    //
    // 길이로 잘라 뒤를 보면 시장가 갈래를 같이 읽는다. 갈래 자체를 뗀다.
    const limAt = sz.search(/if\s*\(\s*t\s*===\s*'LIMIT'\s*\)/);
    if (limAt < 0) fail(`${TYPES}의 sizingPriceOf에 지정가 갈래가 없습니다`);
    else {
      const lim = braceBodyAt(sz, limAt);
      if (/venuePrice/.test(lim)) {
        fail(`${TYPES}의 지정가 갈래가 거래소 가격을 봅니다`
          + ' — 지정가는 사용자가 정한 값으로만 계산합니다');
      }
      if (!/LIMIT_PRICE_REQUIRED/.test(lim)) {
        fail(`${TYPES}의 지정가 갈래가 가격 없음을 구분하지 않습니다`);
      }
    }
    // 환율·원화가 들어올 자리가 아니다.
    for (const bad of ['1375', 'krw', 'KRW']) {
      if (sz.includes(bad)) fail(`${TYPES}의 sizingPriceOf가 ${bad}를 다룹니다`);
    }
  }
  notes.push(`주문유형·기준가 정본이 ${TYPES} 한 곳에 있습니다`);
}

// ── 2. 서버 검증기가 같은 목록을 본다 ──
if (!existsSync(VALID)) fail(`${VALID}이 없습니다`);
else {
  const v = stripJsComments(readFileSync(VALID, 'utf8'));
  if (!/import\s*\{[^}]*(SERVER_ORDER_TYPES|isServerOrderType)[^}]*\}\s*from\s*['"][^'"]*orderTypes['"]/.test(v)) {
    fail(`${VALID}이 orderTypes에서 목록을 가져오지 않습니다 — 목록이 두 벌이면 갈립니다`);
  }
  if (!/isServerOrderType\s*\(/.test(v)) {
    fail(`${VALID}이 공용 판정으로 주문유형을 확인하지 않습니다`);
  }
  // 지정가에 가격을 요구하는 계약은 그대로 있어야 한다.
  if (!/price_required/.test(v)) fail(`${VALID}이 지정가에 가격을 요구하지 않습니다`);
  notes.push(`${VALID}이 같은 목록을 봅니다`);
}

// ── 3. 모드별 선택지 ──
if (!existsSync(CURR)) fail(`${CURR}이 없습니다`);
else {
  const c = stripJsComments(readFileSync(CURR, 'utf8'));
  if (!/export function supportedOrderTypes\b/.test(c)) fail(`${CURR}에 supportedOrderTypes가 없습니다`);
  const sup = fnBodyAt(c, 'export function supportedOrderTypes');
  if (sup && !/SERVER_ORDER_TYPES/.test(sup)) {
    fail(`${CURR}의 supportedOrderTypes가 서버 목록에서 오지 않습니다`);
  }
  // 계획 함수가 기준가를 스스로 다시 정하면 안 된다.
  const plan = fnBodyAt(c, 'export function planExchangeOrder');
  if (!plan) fail(`${CURR}에서 planExchangeOrder 본문을 찾지 못했습니다`);
  else {
    // ── 이름이 있는 것과 **그 결과를 쓰는 것**은 다르다 ──
    //
    // 되돌림 시험에서 `const sized: any = ({...}) || sizingPriceOf({...})`를
    // 넣자 그대로 통과했다. 호출은 남아 있지만 값은 화면이 지어낸 것이었다.
    if (!/const\s+sized\s*=\s*sizingPriceOf\s*\(/.test(plan)) {
      fail(`${CURR}의 planExchangeOrder가 기준가를 sizingPriceOf에서 받지 않습니다`
        + ' — 기준가 판단이 두 벌이 됩니다');
    }
    if (!/sized\.kind\s*!==\s*'READY'/.test(plan)) {
      fail(`${CURR}의 planExchangeOrder가 기준가 실패를 구분하지 않습니다`);
    }
    if (!/=\s*sized\.price\b/.test(plan)) {
      fail(`${CURR}의 planExchangeOrder가 sizingPriceOf가 정한 가격을 쓰지 않습니다`);
    }
  }
}

// ── 4. 화면 ──
if (!existsSync(PAGE)) fail(`${PAGE}이 없습니다`);
else {
  const page = stripJsComments(readFileSync(PAGE, 'utf8'));

  // ── 요청 본문의 유형이 리터럴이면 실패 ──
  //
  // 이게 옛 고장 그 자체다. `type: 'MARKET'`이 돌아오면 무엇을 고르든
  // 시장가가 나간다.
  for (const m of page.matchAll(/type\s*:\s*'(MARKET|LIMIT)'/g)) {
    fail(`${PAGE}이 주문 요청에 유형을 리터럴로 박습니다: type: '${m[1]}'`
      + ' — 사용자가 고른 값을 보내세요');
  }
  if (!/type:\s*orderType\b/.test(page)) {
    fail(`${PAGE}이 요청에 고른 주문유형을 보내지 않습니다`);
  }
  // 지정가면 가격을 함께 보낸다. 서버 계약이 price > 0을 요구한다.
  if (!/price:\s*orderType\s*===\s*'LIMIT'/.test(page)) {
    fail(`${PAGE}이 지정가에 가격을 함께 보내지 않습니다`);
  }
  // 수량 기준가를 화면이 따로 만들지 않는다.
  if (!/orderType,\s*limitPrice/.test(page)) {
    fail(`${PAGE}이 주문유형·지정가를 공용 계산에 넘기지 않습니다`);
  }

  // ── 선택지는 서버 목록에서 온다 ──
  if (!/supportedOrderTypes\s*\(/.test(page)) {
    fail(`${PAGE}이 선택지를 서버 목록에서 만들지 않습니다`);
  }
  // 조건부를 고를 수 있으면 실패. 안내 문구로 남기는 것은 괜찮다.
  for (const m of page.matchAll(/setOrderType\s*\(\s*'([^']*)'/g)) {
    if (m[1] !== 'MARKET' && m[1] !== 'LIMIT') {
      fail(`${PAGE}이 서버가 받지 않는 유형을 고르게 합니다: ${m[1]}`);
    }
  }
  if (/onClick[^\n]{0,80}setOrderType\s*\(\s*'CONDITIONAL'/.test(page)) {
    fail(`${PAGE}에 조건부 선택 버튼이 살아 있습니다`);
  }

  // ── 낼 수 없는 유형·가격 없는 지정가는 확인창을 열기 전에 막는다 ──
  const oc = fnBodyAt(page, 'const openConfirm');
  if (!oc) fail(`${PAGE}에 openConfirm이 없습니다`);
  else {
    if (!/allowedTypes\.includes\s*\(\s*orderType\s*\)/.test(oc)) {
      fail(`${PAGE}의 openConfirm이 낼 수 없는 유형을 걸러내지 않습니다`);
    }
    const limAt = oc.search(/orderType\s*===\s*'LIMIT'\s*&&\s*!\s*\(\s*Number\s*\(\s*limitPrice/);
    if (limAt < 0) {
      fail(`${PAGE}의 openConfirm이 가격 없는 지정가를 막지 않습니다`
        + ' — 시장가로 바꿔 보내지 않으려면 여기서 멈춰야 합니다');
    } else {
      const guard = braceBodyAt(oc, limAt);
      if (/setShowConfirm\s*\(\s*true/.test(guard)) {
        fail(`${PAGE}이 가격 없는 지정가에도 확인창을 엽니다`);
      }
    }
  }

  // ── 남은 지정가를 지우는가 ──
  //
  // 종목·연결이 바뀌었는데 이전 종목의 지정가가 남으면, 다시 보지 않고
  // 확인을 누르는 순간 다른 종목 가격으로 주문이 만들어진다.
  if (!/useEffect\s*\(\s*\(\)\s*=>\s*\{\s*setLimitPrice\(''\);\s*\}\s*,\s*\[\s*sel\.id\s*,\s*connId\s*\]/.test(page)) {
    fail(`${PAGE}이 종목·연결 변경에서 지정가를 비우지 않습니다`);
  }
  if (!/amountMustClear\s*\([^)]*\)\s*\)\s*\{[^}]*setLimitPrice\(''\)/.test(page)) {
    fail(`${PAGE}이 통화가 바뀌는 모드 전환에서 지정가를 비우지 않습니다`);
  }

  // ── 옛 원화 지정가 채움이 돌아오면 실패 ──
  if (/setLimitPrice\s*\(\s*String\s*\(\s*Math\.round\s*\(\s*sel\.p/.test(page)) {
    fail(`${PAGE}의 가격 버튼이 원화 표시가를 지정가에 넣습니다`);
  }
  if (/>\s*BBO\s*</.test(page)) {
    fail(`${PAGE}에 'BBO' 표기가 남아 있습니다`
      + ' — 마크가는 최우선 호가가 아닙니다. 값에 맞는 이름을 쓰세요');
  }
  notes.push('화면이 고른 유형과 가격을 그대로 보냅니다');
}

// ── 5. 시험 ──
//
// **원문이 아니라 걷은 본문을 본다.** 탐침으로 확인한 구멍 둘이다:
//
//   zunOrderTypesTests() // runOrderTypesTests()     → rc=0 (시험이 등록 안 됐는데 통과)
//   시험 이름을 바꾸고 원래 이름을 주석에 남기면      → rc=0 (회귀 시험을 지워도 통과)
//
// 둘째가 특히 나쁘다. 그 회귀 시험이 지키는 것이 "지정가 수량은 지정가로
// 나눈다"이고, 그게 빠지면 사용자가 적은 명목가와 실제 체결 명목가가 갈린다
// (이 파일 머리말의 100 → 80 USDT 사고가 그것이다).
//
// 등록 여부는 **생성되는 러너 본문**에서 본다. `run-tests.mjs`는 러너를
// `const RUN_SRC = \`…\`` 템플릿 하나로 들고 있다가 `run.ts`로 써 내려간다
// (47행 ~ 586행). 즉 호출이 적힌 자리는 호스트 코드가 아니라 **그 템플릿
// 안**이고, 호스트의 주석을 걷어도 템플릿은 문자열이라 손대지 않는다 —
// 그래서 템플릿 안에 `// runOrderTypesTests();`를 남기면 생성된 `run.ts`
// 에서는 주석인데 검사기는 통과했다(실측 rc=0).
//
// 템플릿 본문도 **소스**다. 소스로 읽는다. 모양이 바뀌어 본문을 못 떼면
// 빈 문자열이 되어 앵커가 없다고 **크게 실패한다** — 조용히 통과하지 않는다.
function generatedRunnerSource(src) {
  const at = src.indexOf('const RUN_SRC = `');
  if (at < 0) return '';
  const from = src.indexOf('`', at) + 1;
  const end = src.indexOf('\n`;', from);
  return end < 0 ? '' : src.slice(from, end);
}
const reg = existsSync('scripts/run-tests.mjs')
  ? stripJsComments(generatedRunnerSource(readFileSync('scripts/run-tests.mjs', 'utf8'))) : '';
if (!existsSync(TEST)) fail(`${TEST}이 없습니다`);
else {
  if (!reg.includes('runOrderTypesTests()')) fail('run-tests.mjs에 runOrderTypesTests()가 없습니다');
  const t = stripJsComments(readFileSync(TEST, 'utf8'));
  if (!/화면 선택지는 서버 목록의 부분집합이다/.test(t)) {
    fail(`${TEST}에 선택지 부분집합 시험이 없습니다`);
  }
  if (!/지정가 fixture/.test(t) || !/qty × 지정가/.test(t)) {
    fail(`${TEST}에 지정가 수량 기준 회귀 시험이 없습니다`);
  }
}

console.log('주문유형 일치 확인');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length === 0) {
  console.log('통과 — 고른 주문유형이 그대로 나가고, 수량은 그 유형의 가격으로 만듭니다');
  process.exit(0);
}
for (const f of fails) console.log(`::error::${f}`);
console.log(`실패 ${fails.length}건`);
process.exit(1);
