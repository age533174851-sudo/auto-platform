#!/usr/bin/env node
// scripts/check-execution-currency.mjs
//
// **실전·테스트넷 주문 계산에 환율이 들어가지 않는다.**
//
// 무엇이 있었나
// ─────────────
// 화면은 원화로 금액을 받고 이렇게 수량을 만들었다:
//
//   usdtPx       = krwPx / 1375
//   usdtNotional = krwAmount / 1375
//   qty          = usdtNotional / usdtPx      →  krwAmount / krwPx
//
// 명시적인 1375는 소거된다. 그래서 오래 "환율은 수량에 영향이 없다"고
// 읽혔다. 아니다 — `krwPx`는 `/api/prices`가 거래소 원가에 상수 1375를
// 곱해 만든 값이라 실효 수식은 `krwAmount / (usdPx × 1375)`였다.
// **환율은 앞단에 숨어 처음부터 체결 크기를 정하고 있었다.**
//
// 그리고 단위가 바뀌면 숫자의 뜻도 바뀐다. `100000`은 모의에서
// ₩100,000이고 거래소에서 100,000 USDT다. 같은 입력칸을 두 모드가 나눠
// 쓰면 모드를 바꾼 순간 백 배가 넘는 주문이 된다.
//
// 이 검사가 지키는 것
// ───────────────────
//   · 거래소 주문 분기에 환율·원화 표시가·연습 잔고가 들어오지 않는다
//   · 통화가 바뀌는 모드 전환에서 금액을 비운다
//   · 거래소 모드에 기본 주문금액을 지어내지 않는다
//   · 거래소 가격을 못 읽으면 막는다 (환율로 되돌려 만들지 않는다)
//
// 저장소 전체의 1375를 금지하지 않는다 — 다른 화면의 표시·legacy는
// 별개 작업이다. 보는 것은 **거래소 주문 분기**뿐이다.
//
// 사용: node scripts/check-execution-currency.mjs

import { readFileSync, existsSync } from 'node:fs';

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);

// 이 파일도 설명에 `1375`와 `loadPaperBalance`를 그대로 적는다.
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

/**
 * 함수 **본문**을 뗀다.
 *
 * `bodyAt`을 그대로 쓰면 `planExchangeOrder(i: { ... })`의 **매개변수 타입**
 * 블록을 잡는다. 실제로 본문에 환율 상수를 넣어도 통과했다 — 되돌림
 * 시험에서 잡혔다. 괄호를 세어 서명을 넘긴 뒤의 `{`부터 본다.
 */
function functionBodyAt(src, name) {
  const at = src.indexOf(`export function ${name}`);
  if (at < 0) return '';
  const paren = src.indexOf('(', at);
  if (paren < 0) return '';
  let depth = 0, i = paren;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) break; }
  }
  return bodyAt(src, i);
}

/** `from`부터 짝이 맞는 중괄호까지 */
function bodyAt(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

const LIB = 'src/lib/markets/orderCurrency.ts';
const TEST = 'src/lib/markets/orderCurrency.test.ts';
const PAGE = 'src/components/pages/TradingPage.tsx';
const PRICES = 'src/app/api/prices/route.ts';

// ── 1. 판정은 한 곳에 있고 환율을 받지 않는다 ──
if (!existsSync(LIB)) fail(`${LIB}이 없습니다`);
else {
  const lib = stripJs(readFileSync(LIB, 'utf8'));
  for (const fn of ['orderCurrencyOf', 'amountMustClear', 'planExchangeOrder', 'percentBaseFor',
    'balanceStateOf', 'scopedValueFor']) {
    if (!new RegExp(`export function ${fn}\\b`).test(lib)) fail(`${LIB}에 ${fn}이 없습니다`);
  }
  // **계획 함수가 환율을 입력으로 받으면 안 된다.** 받는 순간 실행이
  // 다시 환율에 묶인다.
  const plan = functionBodyAt(lib, 'planExchangeOrder');
  if (!plan) fail(`${LIB}에서 planExchangeOrder 본문을 찾지 못했습니다`);
  for (const bad of ['1375', 'fx', 'Fx', 'FX', 'krw', 'Krw', 'KRW', 'usdKrw']) {
    if (plan.includes(bad)) {
      fail(`${LIB}의 planExchangeOrder가 ${bad}를 다룹니다 — 실행에 환율이 들어갑니다`);
    }
  }
  notes.push(`실행 계획 ${LIB} — 환율을 입력으로 받지 않습니다`);
}
if (!existsSync(TEST)) fail(`${TEST}이 없습니다`);
else {
  const reg = existsSync('scripts/run-tests.mjs') ? readFileSync('scripts/run-tests.mjs', 'utf8') : '';
  if (!reg.includes('runOrderCurrencyTests()')) fail('run-tests.mjs에 runOrderCurrencyTests()가 없습니다');
}

// ── 2. 거래소 원본 가격이 손실 없이 내려오는가 ──
if (!existsSync(PRICES)) fail(`${PRICES}이 없습니다`);
else {
  const pr = stripJs(readFileSync(PRICES, 'utf8'));
  // 파일 어딘가에 이름이 있는 것과 **값을 싣는 것**은 다르다. 실제로
  // 한 생성 지점에서 지워도 타입 선언 때문에 통과했다.
  const assigned = (pr.match(/quotePrice\s*[:=]\s*parseFloat/g) || []).length;
  const krwMultiplied = (pr.match(/lastPrice\)\s*\*\s*KRW/g) || []).length;
  if (assigned < krwMultiplied) {
    fail(`${PRICES}이 원본 견적가를 ${assigned}곳에서만 싣습니다`
      + ` — 원화로 곱하는 곳이 ${krwMultiplied}곳입니다. 화면이 표시가에서 환산하게 됩니다`);
  }
  notes.push(`${PRICES}이 원본 견적가를 보존합니다`);
}

// ── 3. 거래소 주문 분기 ──
if (!existsSync(PAGE)) fail(`${PAGE}이 없습니다`);
else {
  const page = stripJs(readFileSync(PAGE, 'utf8'));

  const branchAt = page.indexOf("tradeMode === 'testnet' || tradeMode === 'live'");
  if (branchAt < 0) fail(`${PAGE}에서 거래소 주문 분기를 찾지 못했습니다`);
  else {
    const branch = bodyAt(page, branchAt);
    // 실행 계산에 환율·원화 표시가·연습 잔고가 들어오면 안 된다.
    for (const [bad, why] of [
      ['1375', '고정 환율이 실행에 들어옵니다'],
      ['loadPaperBalance', '연습 원화 잔고가 거래소 주문에 들어옵니다'],
    ]) {
      if (branch.includes(bad)) fail(`${PAGE}의 거래소 주문 분기에 ${bad}가 있습니다 — ${why}`);
    }
    // 수량은 계획 함수가 만든다.
    if (!/planExchangeOrder\s*\(/.test(branch)) {
      fail(`${PAGE}의 거래소 주문 분기가 planExchangeOrder를 쓰지 않습니다`);
    }
    if (!/futures\/quote/.test(branch)) {
      fail(`${PAGE}의 거래소 주문 분기가 venue 선물 시세를 읽지 않습니다`
        + ' — /api/prices는 바이낸스 **현물** 가격이라 Gate 주문에 쓰면 안 됩니다');
    }
    if (!/connectionId=/.test(branch)) {
      fail(`${PAGE}이 시세를 연결에 묶어 읽지 않습니다 — 거래소·환경이 정해지지 않습니다`);
    }
    // 화면 참고가격(`/api/prices`)을 실행 수량에 쓰면 안 된다.
    for (const m of branch.matchAll(/nativePrice\s*=\s*([^;\n]{0,60})/g)) {
      if (/sel\.quotePrice|sel\.p\b/.test(m[1])) {
        fail(`${PAGE}이 화면 참고가격을 실행 수량에 씁니다: ${m[1].trim().slice(0, 50)}`
          + ' — venue 선물 시세를 읽으세요');
      }
    }
    // 원화 표시가를 수량 계산에 쓰면 안 된다. 손절 비율(%) 계산은 통화와
    // 무관하므로 예외다 — 나눗셈의 결과가 가격이 아니라 비율이다.
    for (const m of branch.matchAll(/[^\n;]{0,40}\/\s*krwPx[^\n;]{0,40}/g)) {
      if (/Pct|100/.test(m[0])) continue;
      fail(`${PAGE}의 거래소 주문 분기가 원화 표시가로 나눕니다: ${m[0].trim().slice(0, 60)}`);
    }
    notes.push('거래소 주문 분기에 환율·연습 잔고가 없습니다');
  }

  // 통화가 바뀌는 전환에서 금액을 비우는가. **꺼 두는 것도 안 된다.**
  if (!/amountMustClear\s*\(/.test(page)) {
    fail(`${PAGE}이 모드 전환에서 금액 통화를 확인하지 않습니다`
      + ' — ₩100,000이 100,000 USDT가 됩니다');
  } else if (/(false\s*&&|&&\s*false)[^\n]{0,40}amountMustClear|if\s*\(\s*false\s*\)/.test(page)) {
    fail(`${PAGE}이 금액 비우기를 꺼 뒀습니다`);
  }
  // 거래소 모드에 기본 금액을 지어내지 않는가.
  // **매수·매도 두 버튼 다** 막아야 한다 — 한쪽만 고치면 다른 쪽으로 나간다.
  const guarded = (page.match(/포지션 명목가\(USDT\)를 입력하세요/g) || []).length;
  const defaulted = (page.match(/setAmount\('100000'\)/g) || []).length;
  if (guarded < defaulted) {
    fail(`${PAGE}에 기본 10만원이 ${defaulted}곳인데 거래소 차단은 ${guarded}곳입니다`
      + ' — 막지 않은 쪽으로 100,000 USDT 주문이 나갑니다');
  }
  // 비율 버튼이 연습 잔고를 직접 읽지 않는가.
  if (!/percentBaseFor\s*\(/.test(page)) {
    fail(`${PAGE}의 비율 버튼이 모드별 잔고 출처를 쓰지 않습니다`);
  }
  {
    const pctAt = page.indexOf('percentBase.base == null');
    if (pctAt < 0) fail(`${PAGE}에서 비율 버튼의 잔고 판정을 찾지 못했습니다`);
    else {
      // 비율 버튼 onClick 안에서 연습 잔고를 직접 읽으면 안 된다.
      // (연습 장부를 고치는 다른 자리는 MOCK 전용이라 정당하다.)
      const btn = page.slice(Math.max(0, pctAt - 200), pctAt + 900);
      if (/loadPaperBalance\s*\(/.test(btn)) {
        fail(`${PAGE}의 비율 버튼이 연습 잔고를 직접 읽습니다`
          + ' — 거래소 비율이 원화 잔고로 계산됩니다');
      }
    }
    // percentBaseFor의 인자 자리는 있어야 한다.
    if (!/practiceKrw:[\s\S]{0,120}loadPaperBalance\s*\(/.test(page)) {
      fail(`${PAGE}이 모의 비율의 잔고 출처를 percentBaseFor에 넘기지 않습니다`);
    }
  }
  notes.push('통화 전환 시 금액을 비우고, 거래소 모드에 기본 금액이 없습니다');

  // ── 잔고·시세는 어느 연결에서 읽은 것인가 ──
  //
  // A 계정 잔고를 읽은 뒤 B로 바꾸고 B 조회가 실패하면, 비율 버튼이
  // **다른 계정의 잔고**로 B 주문 크기를 정할 수 있었다.
  if (!/scopedValueFor\s*\(/.test(page)) {
    fail(`${PAGE}이 잔고·시세를 연결에 묶지 않습니다 — 이전 계정의 값이 남습니다`);
  }
  if (!/balanceStateOf\s*\(/.test(page)) {
    fail(`${PAGE}이 잔고 0과 '못 읽음'을 가르지 않습니다`);
  }
  // 조회 실패에서 이전 값을 남기면 안 된다.
  const unknownWrites = (page.match(/setUsdtBalance\(\{[^}]{0,80}kind:\s*'UNKNOWN'/g) || []).length;
  if (unknownWrites < 2) {
    fail(`${PAGE}이 조회 실패 때 잔고를 UNKNOWN으로 적는 곳이 ${unknownWrites}곳입니다`
      + ' — 응답 실패와 예외 둘 다 적어야 이전 계정 값이 남지 않습니다');
  }
  notes.push('잔고·시세가 연결에 묶이고, 0과 모름이 갈립니다');
}

// ── 4. 시세 라우트가 연결이 정한 venue·환경에서 읽는가 ──
const QUOTE = 'src/app/api/binance/futures/quote/route.ts';
if (!existsSync(QUOTE)) fail(`${QUOTE}이 없습니다 — venue 선물 시세 경로가 필요합니다`);
else {
  const q = stripJs(readFileSync(QUOTE, 'utf8'));
  if (!/loadFuturesCreds\s*\(/.test(q)) {
    fail(`${QUOTE}이 연결에서 거래소·환경을 읽지 않습니다`);
  }
  for (const [need, why] of [
    ['getPremiumIndex', '바이낸스 선물 마크가'],
    ['getTickerGateFutures', 'Gate 선물 시세'],
  ]) {
    if (!q.includes(need)) fail(`${QUOTE}이 ${why}(${need})를 읽지 않습니다`);
  }
  if (!/creds\.testnet/.test(q)) {
    fail(`${QUOTE}이 연결의 환경(testnet/live)을 따르지 않습니다`);
  }
  // 다른 거래소·현물·환율로 대신 읽으면 안 된다.
  for (const bad of ['api.binance.com', '/api/prices', '1375', 'coingecko']) {
    if (q.includes(bad)) fail(`${QUOTE}이 ${bad}로 대신 읽습니다 — venue 시세만 씁니다`);
  }
  // 주문을 내면 안 된다. 읽기 전용이다.
  if (/method:\s*['"`]POST/i.test(q)) fail(`${QUOTE}이 쓰기 요청을 보냅니다 — 읽기 전용입니다`);
  notes.push(`${QUOTE}이 연결이 정한 거래소·환경의 선물 시세만 읽습니다`);
}

console.log('실행 통화 확인');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length === 0) {
  console.log('통과 — 거래소 주문은 USDT로 계산되고 환율을 지나지 않습니다');
  process.exit(0);
}
for (const f of fails) console.log(`::error::${f}`);
console.log(`실패 ${fails.length}건`);
process.exit(1);
