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
  for (const fn of ['orderCurrencyOf', 'amountMustClear', 'planExchangeOrder', 'percentBaseFor']) {
    if (!new RegExp(`export function ${fn}\\b`).test(lib)) fail(`${LIB}에 ${fn}이 없습니다`);
  }
  // **계획 함수가 환율을 입력으로 받으면 안 된다.** 받는 순간 실행이
  // 다시 환율에 묶인다.
  const planAt = lib.indexOf('export function planExchangeOrder');
  const plan = planAt >= 0 ? bodyAt(lib, planAt) : '';
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
  if (!/quotePrice/.test(pr)) {
    fail(`${PRICES}이 거래소 원본 가격(quotePrice)을 내려보내지 않습니다`
      + ' — 화면이 원화 표시가에서 환산하게 됩니다');
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
    if (!/quotePrice/.test(branch)) {
      fail(`${PAGE}의 거래소 주문 분기가 거래소 원본 가격을 읽지 않습니다`);
    }
    // 원화 표시가를 수량 계산에 쓰면 안 된다. 손절 비율(%) 계산은 통화와
    // 무관하므로 예외다 — 나눗셈의 결과가 가격이 아니라 비율이다.
    for (const m of branch.matchAll(/[^\n;]{0,40}\/\s*krwPx[^\n;]{0,40}/g)) {
      if (/Pct|100/.test(m[0])) continue;
      fail(`${PAGE}의 거래소 주문 분기가 원화 표시가로 나눕니다: ${m[0].trim().slice(0, 60)}`);
    }
    notes.push('거래소 주문 분기에 환율·연습 잔고가 없습니다');
  }

  // 통화가 바뀌는 전환에서 금액을 비우는가.
  if (!/amountMustClear\s*\(/.test(page)) {
    fail(`${PAGE}이 모드 전환에서 금액 통화를 확인하지 않습니다`
      + ' — ₩100,000이 100,000 USDT가 됩니다');
  }
  // 거래소 모드에 기본 금액을 지어내지 않는가.
  if (!/orderCurrency === 'USDT'[\s\S]{0,200}포지션 명목가\(USDT\)를 입력하세요/.test(page)) {
    fail(`${PAGE}이 거래소 모드에서 금액 없이 주문을 막지 않습니다`);
  }
  // 비율 버튼이 모드별 잔고를 쓰는가.
  if (!/percentBaseFor\s*\(/.test(page)) {
    fail(`${PAGE}의 비율 버튼이 모드별 잔고 출처를 쓰지 않습니다`);
  }
  notes.push('통화 전환 시 금액을 비우고, 거래소 모드에 기본 금액이 없습니다');
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
