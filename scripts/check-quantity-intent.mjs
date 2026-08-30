#!/usr/bin/env node
// scripts/check-quantity-intent.mjs
//
// **표시용으로 깎은 숫자가 실행 수량이 되지 않는다.**
//
// 무엇이 있었나
// ─────────────
// Terminal의 비율·위험 버튼은 계산 결과를 `toFixed(6)`(개수)·`toFixed(2)`
// (USDT)로 깎아 **입력칸 문자열**을 만들고, 주문을 낼 때 그 문자열을 다시
// 읽어 거래소로 보냈다. 조사에서 나온 실제 수치:
//
//   px 0.0000345 · stepSize 1 · 실제 포지션 1,000,145
//   100% 버튼 → 34.51 USDT → 주문 시 1,000,289.855 → 서버 내림 1,000,289
//   **보유보다 +144 많다.**
//
// 서버 `quantizeOrder`는 stepSize로 내림하지만 반올림 오차가 stepSize보다
// 크면 되돌리지 못한다. 여기에 USDT 되돌림의 가격 시점차, 클릭 뒤 포지션
// 축소, 규격을 못 읽는 경우가 겹친다.
//
// 자리수를 늘리는 것(6 → 8)은 해결이 아니다. **정밀도 문제가 아니라 의도를
// 잃는 문제다.**
//
// 이 검사가 보는 것
// ─────────────────
// `toFixed`가 있는지가 아니다 — 표시에는 써도 된다. 보는 것은
// **깎은 문자열이 실행 수량으로 이어지는 연결**이다.
//
// 사용: node scripts/check-quantity-intent.mjs

import { readFileSync, existsSync } from 'node:fs';

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);

// 이 파일도 설명에 `toFixed`와 함수 이름을 그대로 적고 있다. 문자를 하나씩
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

/** `from`부터 시작하는 블록의 본문만 중괄호를 세어 떼어 낸다 */
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

const PANE = 'src/components/terminal/OrderPane.tsx';
const LIB = 'src/lib/ui/quantityIntent.ts';
const TEST = 'src/lib/ui/quantityIntent.test.ts';

// ── 1. 판정은 한 곳에 있고 시험이 붙어 있다 ──
if (!existsSync(LIB)) fail(`${LIB}이 없습니다`);
else {
  const lib = stripJs(readFileSync(LIB, 'utf8'));
  for (const fn of ['makeIntent', 'closePercentOf', 'executionQuantityOf', 'intentStillValid']) {
    if (!new RegExp(`export function ${fn}\\b`).test(lib)) fail(`${LIB}에 ${fn}이 없습니다`);
  }
  // 의도가 살아 있는지는 **입력칸이 그대로인지**로 판정한다.
  if (!/currentInput/.test(lib)) fail(`${LIB}이 현재 입력값을 보지 않습니다 — 고친 것을 알 수 없습니다`);
  notes.push(`판정 ${LIB} — 의도 보존·해제`);
}
if (!existsSync(TEST)) fail(`${TEST}이 없습니다 — 판정에는 시험을 붙입니다`);
else {
  const reg = existsSync('scripts/run-tests.mjs') ? readFileSync('scripts/run-tests.mjs', 'utf8') : '';
  if (!reg.includes('runQuantityIntentTests()')) fail('run-tests.mjs에 runQuantityIntentTests()가 없습니다');
}

// ── 2. 화면이 의도를 쓰는가 ──
if (!existsSync(PANE)) fail(`${PANE}이 없습니다`);
else {
  const pane = stripJs(readFileSync(PANE, 'utf8'));

  if (!/executionQuantityOf\s*\(/.test(pane)) {
    fail(`${PANE}이 executionQuantityOf를 쓰지 않습니다 — 입력칸 문자열이 다시 실행 수량이 됩니다`);
  }
  if (!/closePercentOf\s*\(/.test(pane)) {
    fail(`${PANE}이 closePercentOf를 쓰지 않습니다 — 비율 청산이 개수로 나갑니다`);
  }
  if (!/makeIntent\s*\(/.test(pane)) fail(`${PANE}이 makeIntent를 쓰지 않습니다`);

  // 사용자가 칸을 고치면 의도가 풀려야 한다. 안 풀리면 화면에는 100%가
  // 남아 있는데 주문은 전량으로 나간다.
  if (!/setQtyIntent\(null\)/.test(pane)) {
    fail(`${PANE}이 의도를 해제하는 곳이 없습니다 — 사용자가 고쳐도 버튼 값이 나갑니다`);
  }
  const inputAt = pane.indexOf('onChange={e => {');
  if (inputAt < 0 || !/setQtyIntent\(null\)/.test(bodyAt(pane, inputAt))) {
    fail(`${PANE}의 수량 입력 onChange가 의도를 해제하지 않습니다`);
  }

  // ── 3. 비율 청산이 개수를 들고 일반 주문 경로로 가지 않는가 ──
  //
  // 정본은 `close-position`이다 — 그 라우트는 quantity를 받지 않고 주문
  // 순간의 실제 포지션을 다시 읽는다.
  if (!/close-position/.test(pane)) {
    fail(`${PANE}이 비율 청산 정본 경로(close-position)를 부르지 않습니다`);
  } else {
    const at = pane.indexOf('close-position');
    const call = pane.slice(Math.max(0, at - 200), at + 700);
    if (/quantity\s*:/.test(call)) {
      fail(`${PANE}이 close-position에 quantity를 보냅니다 — 그 라우트는 비율만 받습니다`);
    }
    if (!/percent\s*:/.test(call)) fail(`${PANE}이 close-position에 percent를 보내지 않습니다`);
    // 방향은 실제 포지션에서 온다. 버튼(BUY/SELL)으로 추측하면 안 된다.
    if (!/positionSide\s*:\s*holding/.test(call)) {
      fail(`${PANE}이 positionSide를 실제 포지션(holding)에서 가져오지 않습니다`);
    }
  }
  notes.push('비율 청산은 개수 대신 percent를 정본 라우트로 보냅니다');

  // ── 4. 깎은 값을 실행에 되쓰지 않는가 ──
  //
  // `toFixed` 자체는 금지하지 않는다 — 표시에는 쓴다. 금지하는 것은
  // 그 결과가 곧바로 주문 body의 quantity가 되는 연결이다.
  for (const m of pane.matchAll(/quantity\s*:\s*([^,\n}]+)/g)) {
    const expr = m[1].trim();
    if (/toFixed|toPrecision|Math\.round|Math\.ceil/.test(expr)) {
      fail(`${PANE}이 주문 quantity에 표시 자리수를 넣습니다: ${expr.slice(0, 60)}`);
    }
  }
  notes.push('표시 자리수가 주문 수량으로 이어지지 않습니다');
}

console.log('수량 의도 보존 확인');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length === 0) {
  console.log('통과 — 버튼은 의도를 남기고, 실행은 깎이지 않은 값을 씁니다');
  process.exit(0);
}
for (const f of fails) console.log(`::error::${f}`);
console.log(`실패 ${fails.length}건`);
process.exit(1);
