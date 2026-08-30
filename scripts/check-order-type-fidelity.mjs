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

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);

// 이 파일도 설명에 `type: 'MARKET'`과 `CONDITIONAL`을 그대로 적는다.
function stripJs(src) {
  let out = '', i = 0, quote = null;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (quote) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) quote = null;
      out += c === '\n' ? '\n' : c;
      i++; continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

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
  const t = stripJs(readFileSync(TYPES, 'utf8'));
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
  const v = stripJs(readFileSync(VALID, 'utf8'));
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
  const c = stripJs(readFileSync(CURR, 'utf8'));
  if (!/export function supportedOrderTypes\b/.test(c)) fail(`${CURR}에 supportedOrderTypes가 없습니다`);
  const sup = fnBodyAt(c, 'export function supportedOrderTypes');
  if (sup && !/SERVER_ORDER_TYPES/.test(sup)) {
    fail(`${CURR}의 supportedOrderTypes가 서버 목록에서 오지 않습니다`);
  }
  // 계획 함수가 기준가를 스스로 다시 정하면 안 된다.
  const plan = fnBodyAt(c, 'export function planExchangeOrder');
  if (!plan) fail(`${CURR}에서 planExchangeOrder 본문을 찾지 못했습니다`);
  else if (!/sizingPriceOf\s*\(/.test(plan)) {
    fail(`${CURR}의 planExchangeOrder가 sizingPriceOf를 쓰지 않습니다 — 기준가 판단이 두 벌이 됩니다`);
  }
}

// ── 4. 화면 ──
if (!existsSync(PAGE)) fail(`${PAGE}이 없습니다`);
else {
  const page = stripJs(readFileSync(PAGE, 'utf8'));

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
const reg = existsSync('scripts/run-tests.mjs') ? readFileSync('scripts/run-tests.mjs', 'utf8') : '';
if (!existsSync(TEST)) fail(`${TEST}이 없습니다`);
else {
  if (!reg.includes('runOrderTypesTests()')) fail('run-tests.mjs에 runOrderTypesTests()가 없습니다');
  const t = readFileSync(TEST, 'utf8');
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
