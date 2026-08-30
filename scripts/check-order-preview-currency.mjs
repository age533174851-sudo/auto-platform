#!/usr/bin/env node
// scripts/check-order-preview-currency.mjs
//
// **주문 전에 보는 숫자가 실제로 나가는 주문과 같은 뜻인가.**
//
// 무엇이 있었나
// ─────────────
// 실행에서는 환율을 없앴는데(C3) 미리보기와 확인창은 옛 계산 그대로였다:
//
//   krwPx  = sel.p            // /api/prices의 원화 표시가
//   usdtPx = krwPx / 1375
//   qty    = amount / krwPx
//
// 그런데 실전·테스트넷의 `amount`는 이제 USDT 명목가다. 100 USDT짜리
// 주문을 넣으면 확인창은 `0.000029 ETH · 0.073 USDT`라고 적고, 실제로는
// `0.04 ETH`가 나갔다 — 약 1,375배 다른 숫자를 보고 승인한 것이다.
//
// 미리보기도 같은 병이 있었다. venue 시세가 아직 없으면 `sel.quotePrice`,
// 즉 **바이낸스 현물 참고가**로 되돌아갔다. Gate 연결에서도 바이낸스
// 현물 기준 수량이 보였다.
//
// 이 검사가 지키는 것
// ───────────────────
//   · 미리보기·확인창이 실행과 같은 함수(`orderPreviewOf`)에서 숫자를 받는다
//   · 거래소 계산에 환율·원화 표시가·현물 참고가가 들어오지 않는다
//   · 확인창을 열기 전에 venue 시세를 읽고, 못 읽으면 열지 않는다
//   · 시세는 현재 연결에 묶인 값만 쓴다
//   · 제출 시점에 다시 읽는다 (예상값과 정본을 나눈다)
//
// 사용: node scripts/check-order-preview-currency.mjs

import { readFileSync, existsSync } from 'node:fs';

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);

// 이 파일도 설명에 `1375`·`sel.quotePrice`를 그대로 적는다. 검사기가
// 자기 산문을 읽고 통과/실패하는 고장이 반복됐다.
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

/** `from` 이후 짝이 맞는 중괄호까지. 길이로 자르면 옆 구문을 읽는다. */
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

/**
 * 화살표 함수 **본문**을 뗀다.
 *
 * 서명 괄호를 먼저 건너뛴다. 그러지 않으면 매개변수 블록을 본문으로 읽는다
 * — 되돌림 시험에서 실제로 잡힌 고장이다.
 */
function arrowBodyAt(src, decl) {
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

/** `(` 부터 짝이 맞는 `)` 까지 — JSX 블록을 뗄 때 쓴다. */
function parenBodyAt(src, from) {
  const open = src.indexOf('(', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

const LIB = 'src/lib/markets/orderPreview.ts';
const QUOTE = 'src/lib/markets/venueQuote.ts';
const PAGE = 'src/components/pages/TradingPage.tsx';
const TESTS = [
  ['src/lib/markets/orderPreview.test.ts', 'runOrderPreviewTests()'],
  ['src/lib/markets/venueQuote.test.ts', 'runVenueQuoteTests()'],
];

// ── 1. 뜻은 한 곳에 있고, 거래소 계산에 환율이 없다 ──
if (!existsSync(LIB)) fail(`${LIB}이 없습니다`);
else {
  const lib = stripJs(readFileSync(LIB, 'utf8'));
  for (const fn of ['orderPreviewOf', 'exchangePreviewOf', 'practicePreviewOf']) {
    if (!new RegExp(`export function ${fn}\\b`).test(lib)) fail(`${LIB}에 ${fn}이 없습니다`);
  }
  // **거래소 미리보기는 실행 계획과 같은 함수로 계산해야 한다.**
  const ex = arrowBodyAt(lib, 'export function exchangePreviewOf');
  if (!ex) fail(`${LIB}에서 exchangePreviewOf 본문을 찾지 못했습니다`);
  else {
    if (!/planExchangeOrder\s*\(/.test(ex)) {
      fail(`${LIB}의 exchangePreviewOf가 planExchangeOrder를 쓰지 않습니다`
        + ' — 화면이 실행과 다른 공식을 갖게 됩니다');
    }
    for (const bad of ['1375', 'krw', 'Krw', 'KRW', 'PRACTICE_DISPLAY_RATE', 'quotePrice', 'sel.p']) {
      if (ex.includes(bad)) {
        fail(`${LIB}의 exchangePreviewOf가 ${bad}를 다룹니다 — 거래소 표시에 환율·참고가가 들어갑니다`);
      }
    }
    // 가격을 모를 때 숫자를 만들면 안 된다.
    if (!/PRICE_UNKNOWN/.test(ex)) {
      fail(`${LIB}의 exchangePreviewOf가 가격을 모를 때를 구분하지 않습니다`);
    }
  }
  notes.push(`미리보기 뜻이 ${LIB} 한 곳에 있습니다`);
}

if (!existsSync(QUOTE)) fail(`${QUOTE}이 없습니다`);
else {
  const q = stripJs(readFileSync(QUOTE, 'utf8'));
  if (!/export async function fetchVenueQuote\b/.test(q)) fail(`${QUOTE}에 fetchVenueQuote가 없습니다`);
  if (!/export function toVenueSymbol\b/.test(q)) fail(`${QUOTE}에 toVenueSymbol이 없습니다`);
}

// ── 2. 화면 ──
if (!existsSync(PAGE)) fail(`${PAGE}이 없습니다`);
else {
  const page = stripJs(readFileSync(PAGE, 'utf8'));

  // 현물 참고가로 되돌아가는 길 자체가 없어야 한다.
  if (/sel\.quotePrice/.test(page)) {
    fail(`${PAGE}이 아직 sel.quotePrice(바이낸스 **현물** 참고가)를 씁니다`
      + ' — Gate 연결에서도 바이낸스 현물 기준 수량이 보입니다');
  }

  // 시세는 읽기 경로 하나를 지난다. **확인창을 열기 전과 제출 시점, 두 번.**
  const reads = (page.match(/fetchVenueQuote\s*\(/g) || []).length;
  if (reads < 2) {
    fail(`${PAGE}이 venue 시세를 ${reads}곳에서만 읽습니다`
      + ' — 확인창을 열기 전(예상값)과 제출 시점(정본) 두 곳이어야 합니다');
  }

  // ── 2a. 미리보기 ──
  // 주석은 stripJs가 지운다 — 코드에 있는 표식을 잡는다.
  const pvAt = page.indexOf('{amount&&+amount>0&&(');
  if (pvAt < 0) fail(`${PAGE}에서 미리보기 블록을 찾지 못했습니다`);
  else {
    const pv = parenBodyAt(page, pvAt);
    if (!/orderPreviewOf\s*\(/.test(pv)) {
      fail(`${PAGE}의 미리보기가 orderPreviewOf를 쓰지 않습니다 — 공식이 두 벌이 됩니다`);
    }
    if (!/scopedValueFor\s*\(\s*venueQuote\s*,\s*connId\s*\)/.test(pv)) {
      fail(`${PAGE}의 미리보기가 시세를 현재 연결에 묶지 않습니다`);
    }
    if (pv.includes('1375')) fail(`${PAGE}의 미리보기에 고정 환율이 있습니다`);
    notes.push('미리보기가 venue 시세와 공용 계산만 씁니다');
  }

  // ── 2b. 확인창 ──
  const cfAt = page.indexOf('{showConfirm&&(');
  if (cfAt < 0) fail(`${PAGE}에서 확인창을 찾지 못했습니다`);
  else {
    const cf = parenBodyAt(page, cfAt);
    if (!cf) fail(`${PAGE}의 확인창 본문을 뜯지 못했습니다`);
    else {
      if (!/orderPreviewOf\s*\(/.test(cf)) {
        fail(`${PAGE}의 확인창이 orderPreviewOf를 쓰지 않습니다`
          + ' — 승인 화면이 실행과 다른 숫자를 말하게 됩니다');
      }
      if (!/scopedValueFor\s*\(\s*venueQuote\s*,\s*connId\s*\)/.test(cf)) {
        fail(`${PAGE}의 확인창이 시세를 현재 연결에 묶지 않습니다`
          + ' — 다른 계좌의 시세로 승인하게 됩니다');
      }
      if (cf.includes('1375')) {
        fail(`${PAGE}의 확인창에 고정 환율이 있습니다 — 실전 금액은 USDT입니다`);
      }
      // ── 옛 원화 수량 계산이 남아 있으면 안 된다 ──
      //
      // `amount / krwPx`만 찾으면 `+amount/(sel.p||1)`처럼 괄호 하나로
      // 빠져나간다 — 되돌림 시험에서 실제로 통과했다. **원화 표시가로
      // 나누는 것 자체**를 본다. 청산 비율(%)은 통화와 무관해서 예외다.
      for (const m of cf.matchAll(/[^\n;]{0,40}\/\s*\(?\s*(krwPx|sel\.p)\b[^\n;]{0,20}/g)) {
        if (/Pct|100/.test(m[0])) continue;
        fail(`${PAGE}의 확인창이 원화 표시가로 나눕니다: ${m[0].trim().slice(0, 60)}`);
      }
      // 통화 표기는 모드가 정한다. 문자열 하나만 보면 안 되고 **분기**를 봐야 한다.
      if (!/const\s+notionalText\s*=\s*isExchange\b/.test(cf)) {
        fail(`${PAGE}의 확인창이 명목가 통화를 모드로 나누지 않습니다`
          + ' — 실전에서 USDT 금액에 ₩가 붙습니다');
      }
      if (!/const\s+marginText\s*=\s*isExchange\b/.test(cf)) {
        fail(`${PAGE}의 확인창이 증거금 통화를 모드로 나누지 않습니다`);
      }
      // 미리 읽은 값은 예상이다 — 그렇게 적어야 한다.
      if (!/예상 수량/.test(cf)) {
        fail(`${PAGE}의 확인창이 수량을 확정값처럼 적습니다 — 제출 시점에 다시 읽습니다`);
      }
      notes.push('확인창이 실행과 같은 계산·같은 통화로 적습니다');
    }
  }

  // ── 2c. 확인창을 열기 전에 읽는가 ──
  const oc = arrowBodyAt(page, 'const openConfirm');
  if (!oc) fail(`${PAGE}에 openConfirm이 없습니다 — 확인창을 열기 전에 시세를 읽어야 합니다`);
  else {
    const readAt = oc.indexOf('fetchVenueQuote');
    const openAt = oc.indexOf('setShowConfirm(true)', readAt < 0 ? 0 : readAt);
    if (readAt < 0) fail(`${PAGE}의 openConfirm이 시세를 읽지 않습니다`);
    else if (openAt < 0) {
      fail(`${PAGE}의 openConfirm이 시세를 읽은 뒤 확인창을 열지 않습니다`);
    }
    // 실패하면 **열지 않는다.**
    const guardAt = oc.search(/if\s*\(\s*!\s*q\s*\)/);
    if (guardAt < 0) {
      fail(`${PAGE}의 openConfirm이 시세 실패를 구분하지 않습니다`
        + ' — 가격을 모른 채 승인 화면이 열립니다');
    } else {
      const guard = braceBodyAt(oc, guardAt);
      if (!/return\s*;/.test(guard)) {
        fail(`${PAGE}의 openConfirm이 시세 실패에서 멈추지 않습니다`);
      }
      if (/setShowConfirm\s*\(\s*true/.test(guard)) {
        fail(`${PAGE}의 openConfirm이 시세 실패에서도 확인창을 엽니다`);
      }
    }
    // 연습 장부는 네트워크를 지나지 않는다 — 기존 동작을 지킨다.
    if (!/orderCurrency\s*!==\s*'USDT'/.test(oc)) {
      fail(`${PAGE}의 openConfirm이 연습 장부를 갈라내지 않습니다`);
    }
    notes.push('거래소 모드는 시세를 읽지 못하면 확인창을 열지 않습니다');
  }

  // 확인창을 여는 길이 openConfirm 하나뿐인가. 옆길이 남으면 그쪽으로 샌다.
  const opens = (page.match(/setShowConfirm\s*\(\s*true\s*\)/g) || []).length;
  const inOc = ((arrowBodyAt(page, 'const openConfirm').match(/setShowConfirm\s*\(\s*true\s*\)/g)) || []).length;
  if (opens !== inOc) {
    fail(`${PAGE}이 확인창을 ${opens}곳에서 여는데 openConfirm 안은 ${inOc}곳입니다`
      + ' — 시세를 읽지 않는 옆길이 남아 있습니다');
  }
}

// ── 3. 시험이 붙어 있는가 ──
const reg = existsSync('scripts/run-tests.mjs') ? readFileSync('scripts/run-tests.mjs', 'utf8') : '';
for (const [file, call] of TESTS) {
  if (!existsSync(file)) { fail(`${file}이 없습니다`); continue; }
  if (!reg.includes(call)) fail(`run-tests.mjs에 ${call}이 없습니다`);
}
{
  const t = existsSync(TESTS[0][0]) ? readFileSync(TESTS[0][0], 'utf8') : '';
  if (!/원화 표시가가 있어도 미리보기가 그 값으로 수량을 만들지 않는다/.test(t)) {
    fail(`${TESTS[0][0]}에 옛 원화 계산 회귀 시험이 없습니다`);
  }
}

console.log('주문 전 표시 통화 확인');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length === 0) {
  console.log('통과 — 승인 화면의 숫자가 실제 나갈 주문과 같은 뜻입니다');
  process.exit(0);
}
for (const f of fails) console.log(`::error::${f}`);
console.log(`실패 ${fails.length}건`);
process.exit(1);
