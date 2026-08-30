#!/usr/bin/env node
// scripts/check-position-sizing-display.mjs
//
// **명목가는 배율과 무관하다. 증거금은 명목가를 배율로 나눈 값이다.**
//
// 무엇이 있었나
// ─────────────
// TradingPage가 명목가를 `amount × leverage`로 그리고 있었다. 그런데 실제
// 주문은 `qty = amount / price`라서 거래소에 서는 명목가는 `amount`
// 그대로다 — **10배에서는 화면이 실제의 열 배**를 말했다. 확인창은 반대로
// `margin = notional`이라 배율을 무시했고, 증거금도 열 배로 적혔다.
//
// 같은 줄 안에서도 어긋났다: '수량 0.002'와 '명목 1,000 USDT'가 나란히
// 적혔는데 0.002 × 50,000 = 100이지 1,000이 아니다.
//
// 사용자는 그 숫자로 **"이 정도면 증거금이 충분한가"**를 판단한다.
//
// 정본
// ────
//   manualPlan.ts      positionSize = quantity × refPrice
//                      requiredMargin = notional / leverage
//   quantityInput.ts   QUOTE_NOTIONAL = 포지션 명목가 (배율과 무관)
//                      INITIAL_MARGIN = 실제로 넣는 돈 (배율을 곱한 만큼이 포지션)
//
// 실행은 처음부터 정본과 같았다. 이 검사가 막는 것은 **표시가 다시
// 어긋나는 것**과, 화면이 자기 공식을 새로 들고 오는 것이다.
//
// 사용: node scripts/check-position-sizing-display.mjs

import { readFileSync, existsSync } from 'node:fs';

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);

// 이 파일도 설명에 `amount × leverage`를 그대로 적는다. 문자를 하나씩
// 걸으며 문자열 안의 `//`는 주석으로 세지 않는다.
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

// ── 1. 뜻은 한 곳에서 정의된다 ──
const LIB = 'src/lib/markets/quantityInput.ts';
if (!existsSync(LIB)) fail(`${LIB}이 없습니다`);
else {
  const lib = stripJs(readFileSync(LIB, 'utf8'));
  // 명목가는 배율과 무관하고, 증거금은 나눗셈이다.
  if (!/export function notionalAndMargin/.test(lib)) {
    fail(`${LIB}에 통화 중립 helper(notionalAndMargin)가 없습니다`);
  }
  // ── 나눗셈 구현은 **하나뿐이어야 한다** ──
  //
  // 화면이 같은 나눗셈을 따로 들고 있었고, 그때 preview와 확인창이 서로
  // 다른 답을 냈다. helper를 만들어 놓고 옆에 공식이 하나 더 있으면
  // 만든 의미가 없다.
  const divisions = (lib.match(/\/\s*lev\b/g) || []).length;
  if (divisions !== 1) {
    fail(`${LIB}에 '명목가 / 배율' 구현이 ${divisions}개 있습니다 — 하나여야 합니다`);
  }
  // helper가 배율을 모를 때 0을 지어내면 '돈이 안 든다'로 읽힌다.
  const at = lib.indexOf('export function notionalAndMargin');
  const body = at >= 0 ? lib.slice(at, at + 600) : '';
  if (/margin:\s*0\b/.test(body) || /\?[^:;]*:\s*0\s*[,}]/.test(body)) {
    fail(`${LIB}의 helper가 증거금을 0으로 채웁니다 — 모르면 null입니다`);
  }
  if (/margin:\s*n\s*[,}]/.test(body)) {
    fail(`${LIB}의 helper가 증거금을 명목가와 같게 둡니다`);
  }
  if (!/case 'QUOTE_NOTIONAL'[\s\S]{0,200}notional = v;/.test(lib)) {
    fail(`${LIB}의 QUOTE_NOTIONAL이 적은 금액을 그대로 명목가로 쓰지 않습니다 — 배율과 무관해야 합니다`);
  }
  notes.push(`뜻은 ${LIB} 한 곳에서 정의됩니다`);
}

// ── 2. 화면이 공식을 다시 만들지 않는가 ──
//
// **표시 계산을 화면이 들고 있으면 언젠가 갈린다.** 실제로 preview와
// 확인창이 서로 다른 공식을 쓰고 있었다.
//
// 표시 계산은 이제 `orderPreview.ts` 한 곳을 지난다. 그래서 **그 파일이
// 공용 정의를 쓰는지**와 **화면이 그 파일에 위임하는지**를 나눠 본다.
// 화면이 공식을 다시 갖고 있지 않은지는 아래 정규식들이 계속 본다.
const SOURCE = 'src/lib/markets/orderPreview.ts';
if (!existsSync(SOURCE)) fail(`${SOURCE}이 없습니다`);
else {
  const src = stripJs(readFileSync(SOURCE, 'utf8'));
  if (!/convertQuantity\s*\(/.test(src)) {
    fail(`${SOURCE}이 convertQuantity를 쓰지 않습니다 — 명목가·증거금 공식을 다시 만들고 있습니다`);
  }
  if (!/notionalAndMargin\s*\(/.test(src)) {
    fail(`${SOURCE}이 notionalAndMargin을 쓰지 않습니다`);
  }
  if (!/import\s*\{[^}]*convertQuantity[^}]*\}\s*from\s*['"][^'"]*quantityInput['"]/.test(src)) {
    fail(`${SOURCE}이 quantityInput에서 convertQuantity를 가져오지 않습니다 — 공용 정의가 출처여야 합니다`);
  }
  notes.push(`표시 계산이 ${SOURCE} 한 곳을 지납니다`);
}

const SCREENS = ['src/components/pages/TradingPage.tsx'];
for (const file of SCREENS) {
  if (!existsSync(file)) { fail(`${file}이 없습니다`); continue; }
  const body = stripJs(readFileSync(file, 'utf8'));

  if (!/orderPreviewOf\s*\(/.test(body)) {
    fail(`${file}이 orderPreviewOf를 쓰지 않습니다 — 명목가·증거금 공식을 화면이 다시 만들고 있습니다`);
  }
  if (!/import\s*\{[^}]*orderPreviewOf[^}]*\}\s*from\s*['"][^'"]*orderPreview['"]/.test(body)) {
    fail(`${file}이 orderPreview에서 orderPreviewOf를 가져오지 않습니다 — 공용 정의가 출처여야 합니다`);
  }

  // 명목가를 배율로 곱하는 표시가 남아 있으면 안 된다.
  for (const m of body.matchAll(/(notional|명목)[^\n;]{0,60}/g)) {
    const line = m[0];
    if (/\*\s*leverage|leverage\s*\*/.test(line)) {
      fail(`${file}이 명목가에 배율을 곱합니다: ${line.trim().slice(0, 70)}`
        + ' — 명목가는 배율과 무관합니다');
    }
  }
  // 증거금을 명목가와 같게 두는 것도 같은 오류다.
  if (/(const|let)\s+margin\s*=\s*notional\s*[;,]/.test(body)) {
    fail(`${file}이 증거금을 명목가와 같게 둡니다 — 증거금 = 명목가 / 배율입니다`);
  }
  // ── 화면에 공식이 남아 있지 않은가 ──
  //
  // 예전 검사기는 파일 어딘가에 convertQuantity 호출이 하나라도 있으면
  // 통과시켰다. 그래서 원화 요약 한 경로가 `amount / leverage`를 직접
  // 계산해도 잡히지 않았다 — **값은 맞았지만 공식이 두 벌이었다.**
  for (const m of body.matchAll(/[^\n;]{0,30}\b(\+?\s*amount|notional|usdt|krw)\s*\/\s*leverage[^\n;]{0,30}/gi)) {
    const line = m[0];
    // helper를 부르는 줄은 나눗셈을 직접 하지 않는다.
    if (/notionalAndMargin|convertQuantity/.test(line)) continue;
    fail(`${file}이 증거금을 직접 나눕니다: ${line.trim().slice(0, 70)}`
      + ' — 공식은 notionalAndMargin 한 곳에만 둡니다');
  }
  // 0 fallback은 '돈이 안 든다'로 읽힌다.
  if (/leverage\s*>\s*0\s*\?[^\n;]{0,60}:\s*0/.test(body)) {
    fail(`${file}이 배율을 모를 때 증거금을 0으로 적습니다 — '확인 불가'여야 합니다`);
  }

  // 확인창이 둘을 **다른 행**으로 보여 주는가.
  if (/주문 금액['"`]\s*,\s*v:/.test(body)) {
    fail(`${file}의 확인창이 아직 '주문 금액'으로 적습니다 — 명목가인지 증거금인지 읽히지 않습니다`);
  }
  for (const need of ['포지션 명목가', '증거금']) {
    if (!body.includes(need)) fail(`${file}에 '${need}' 표시가 없습니다`);
  }
  notes.push(`${file}이 명목가·증거금을 공용 정의로 계산합니다`);
}

// ── 3. 시험이 붙어 있는가 ──
const TEST = 'src/lib/markets/quantityInput.test.ts';
if (!existsSync(TEST)) fail(`${TEST}이 없습니다`);
else {
  const t = readFileSync(TEST, 'utf8');
  if (!/배율이 바뀌어도 명목가는 그대로다/.test(t)) {
    fail(`${TEST}에 배율 불변 시험이 없습니다 — 이게 핵심 회귀 시험입니다`);
  }
  notes.push('배율이 바뀌어도 명목가가 그대로임을 시험이 붙듭니다');
}

console.log('포지션 크기 표시 확인');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length === 0) {
  console.log('통과 — 명목가는 배율과 무관하고, 증거금은 명목가 / 배율입니다');
  process.exit(0);
}
for (const f of fails) console.log(`::error::${f}`);
console.log(`실패 ${fails.length}건`);
process.exit(1);
