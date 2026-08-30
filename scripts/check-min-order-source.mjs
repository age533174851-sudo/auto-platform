#!/usr/bin/env node
// scripts/check-min-order-source.mjs
//
// **최소 주문 규칙은 거래소가 정한다. 화면도 코드도 정하지 않는다.**
//
// 무엇이 있었나
// ─────────────
// 화면에 `CLIENT_MIN_NOTIONAL_USDT = 20`이 있었다. 그 값은 어느 종목의
// 규칙도 아니라 **두 방향으로 틀렸다:**
//
//   최소가 20보다 작은 종목  거래소가 받을 주문을 화면이 먼저 거절했다
//   최소가 20보다 큰 종목    통과시켰고, 배율만 바뀐 채 거래소가 거절했다
//
// 그 상수가 메우고 있던 자리는 서버의 공백이었다. `quantizeOrder`에
// 최소 명목가 검사가 있었지만, 어댑터가 `MIN_NOTIONAL` 필터를 읽지 않아
// **한 번도 실행된 적이 없었다.**
//
// 그리고 바이낸스는 지정가에 `LOT_SIZE`, 시장가에 `MARKET_LOT_SIZE`를
// 따로 준다. 어댑터는 `LOT_SIZE`만 읽어서, 시장가 주문도 지정가 격자로
// 깎고 있었다.
//
// 이 검사가 지키는 것
// ───────────────────
//   · 화면에 최소 금액 상수가 없다
//   · 어댑터가 MIN_NOTIONAL·MARKET_LOT_SIZE를 실제로 읽는다
//   · 주문유형별 격자가 타입에 남아 있고, 없는 쪽을 복사하지 않는다
//   · 시장가 최소 금액 기준가는 **서버가 읽은 마크가**다
//   · 최소 금액은 **자른 뒤의 수량**으로 검사한다
//   · Gate에 없는 고정 최소 금액을 만들지 않는다
//   · 규격을 못 읽었을 때 신규 진입은 막고 청산은 막지 않는다
//   · 청산에는 최소 명목가를 적용하지 않는다
//
// 사용: node scripts/check-min-order-source.mjs

import { readFileSync, existsSync } from 'node:fs';

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);

// 이 파일도 설명에 `CLIENT_MIN_NOTIONAL_USDT`와 `MIN_NOTIONAL`을 적는다.
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

/** 서명 괄호를 넘긴 뒤의 본문 — 매개변수 타입 블록을 본문으로 읽지 않는다 */
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

const QZ = 'src/lib/exchanges/quantize.ts';
const BF = 'src/lib/exchanges/binanceFutures.ts';
const GP = 'src/lib/exchanges/gatePlan.ts';
const ROUTE = 'src/app/api/binance/futures/order/route.ts';
const EXEC = 'src/lib/exchanges/futuresExec.ts';
const ADAPTER = 'src/lib/exchanges/futuresAdapter.ts';
const PAGE = 'src/components/pages/TradingPage.tsx';
const PLAN = 'src/lib/markets/orderCurrency.ts';
const TEST = 'src/lib/exchanges/quantize.test.ts';

// ── 1. 판정 함수 ──
if (!existsSync(QZ)) fail(`${QZ}이 없습니다`);
else {
  const qz = stripJs(readFileSync(QZ, 'utf8'));

  // 주문유형별 격자가 타입에 남아 있는가. 한 벌로 접으면 차이를 표현할 수 없다.
  for (const f of ['limitQty', 'marketQty']) {
    if (!new RegExp(`${f}\\s*:`).test(qz)) {
      fail(`${QZ}의 SymbolFilters에 ${f}가 없습니다 — 시장가와 지정가 규격이 한 벌로 접힙니다`);
    }
  }
  if (!/export function qtyGridFor\b/.test(qz)) fail(`${QZ}에 qtyGridFor가 없습니다`);
  const grid = fnBodyAt(qz, 'export function qtyGridFor');
  // ── 격자를 **실제로 고르는가** ──
  //
  // 되돌림 시험에서 `return filters.limitQty ?? null;`처럼 유형을 무시하고
  // 한쪽만 돌려줘도 통과했다. 호출부가 유형을 넘겨도 고르는 쪽이 안 보면
  // 시장가가 지정가 격자로 깎인다.
  if (grid) {
    if (!/orderType/.test(grid)) {
      fail(`${QZ}의 qtyGridFor가 주문유형을 보지 않습니다`);
    }
    for (const f of ['limitQty', 'marketQty']) {
      if (!grid.includes(f)) fail(`${QZ}의 qtyGridFor가 ${f}를 돌려주지 않습니다`);
    }
  }
  // 한쪽이 없을 때 **null**이 아닌 다른 값으로 채우면 안 된다.
  // 삼항 양쪽에 두 이름이 함께 나오는 것은 정상이므로, `??`/`||`의
  // 오른쪽이 null인지만 본다.
  if (grid) {
    for (const m of grid.matchAll(/(limitQty|marketQty)\s*(?:\?\?|\|\|)\s*([A-Za-z_$][\w$.]*)/g)) {
      if (m[2] !== 'null') {
        fail(`${QZ}의 qtyGridFor가 ${m[1]}을 ${m[2]}로 대신 채웁니다`
          + ' — 거래소가 두지 않은 규칙을 만드는 것입니다');
      }
    }
  }

  const body = fnBodyAt(qz, 'export function quantizeOrder');
  if (!body) fail(`${QZ}에서 quantizeOrder 본문을 찾지 못했습니다`);
  else {
    // 격자는 유형이 고른다.
    if (!/qtyGridFor\s*\(\s*filters\s*,\s*orderType\s*\)/.test(body)) {
      fail(`${QZ}의 quantizeOrder가 주문유형으로 격자를 고르지 않습니다`);
    }
    // ── 규격 미확인은 **두 가지**다 ──
    //
    //   filters == null            조회 자체가 실패
    //   filters는 있고 격자만 null  이 주문유형의 수량 규칙을 모름
    //
    // 둘 다 신규 진입에서는 "규격을 모른다"이고 막아야 한다. 뒤쪽을
    // "규칙 없음"으로 읽어 그냥 흘려보내면 조회 실패와 같은 위험이 된다.
    if (!/FILTERS_UNKNOWN/.test(body)) {
      fail(`${QZ}이 규격 미확인을 구분하지 않습니다 — 모르는 규격으로 신규 진입이 나갑니다`);
    }
    if (!/QTY_FILTER_UNKNOWN/.test(body)) {
      fail(`${QZ}이 '이 주문유형의 수량 격자 미확인'을 구분하지 않습니다`
        + ' — MARKET_LOT_SIZE가 없을 때 시장가 신규 진입이 그대로 나갑니다');
    }
    for (const [pattern, label] of [
      [/if\s*\(\s*!\s*filters\s*\)/, '규격 조회 실패'],
      [/if\s*\(\s*!\s*lot\s*\)/, '주문유형 격자 미확인'],
    ]) {
      const at = body.search(pattern);
      if (at < 0) { fail(`${QZ}에 ${label} 분기가 없습니다`); continue; }
      const blk = braceBodyAt(body, at);
      if (!/reduceOnly/.test(blk)) {
        fail(`${QZ}이 ${label}에서 신규와 청산을 갈라내지 않습니다`
          + ' — 못 여는 것은 불편이고 못 닫는 것은 사고입니다');
      }
      if (!/_UNKNOWN/.test(blk)) {
        fail(`${QZ}의 ${label} 분기가 신규 진입을 막지 않습니다`);
      }
      // 격자를 적용하지 않았는데 적용했다고 적으면 안 된다.
      if (/applied:\s*true/.test(blk)) {
        fail(`${QZ}의 ${label} 분기가 applied:true를 적습니다`
          + ' — 규격을 적용하지 않았습니다');
      }
    }
    // 격자가 없는데 아래 계산으로 흘러가면 안 된다. `!lot` 분기가
    // step/minQty를 읽는 곳보다 **앞**에 있어야 한다.
    const lotAt = body.search(/if\s*\(\s*!\s*lot\s*\)/);
    const stepAt = body.search(/const\s+step\s*=/);
    if (lotAt >= 0 && stepAt >= 0 && lotAt > stepAt) {
      fail(`${QZ}이 격자 미확인을 확인하기 전에 수량을 자릅니다`);
    }
    // 최소 명목가: 청산 제외 + 자른 뒤 수량 + 시장가는 서버 기준가
    const minAt = body.indexOf('minNotional');
    if (minAt < 0) fail(`${QZ}이 최소 명목가를 보지 않습니다`);
    else {
      const seg = body.slice(minAt);
      if (!/!\s*reduceOnly/.test(seg)) {
        fail(`${QZ}이 청산에도 최소 명목가를 적용합니다 — 남은 포지션을 닫지 못하게 됩니다`);
      }
      if (!/marketReferencePrice/.test(seg)) {
        fail(`${QZ}이 시장가 최소 명목가의 기준가를 받지 않습니다`);
      }
      // **자른 뒤의 수량(q)으로 검사해야 한다.** 원본(q0)으로 보면
      // stepSize로 내리면서 미달이 된 주문을 통과시킨다.
      if (!/\bq\s*\*\s*ref\b/.test(seg)) {
        fail(`${QZ}이 자른 뒤의 수량으로 최소 명목가를 검사하지 않습니다`);
      }
      if (/\bq0\s*\*/.test(seg)) {
        fail(`${QZ}이 원본 수량으로 최소 명목가를 검사합니다`);
      }
    }
    // 기준가를 못 읽으면 지어내지 않는다.
    if (!/REFERENCE_PRICE_UNKNOWN/.test(body)) {
      fail(`${QZ}이 기준가를 못 읽었을 때를 구분하지 않습니다 — 지어낸 값으로 검사하게 됩니다`);
    }
    // 숫자 상수를 최소 금액으로 쓰지 않는다.
    for (const m of body.matchAll(/minNotional\s*(?:=|\?\?)\s*(\d+)/g)) {
      fail(`${QZ}이 최소 명목가에 상수 ${m[1]}을 씁니다 — 거래소 값만 씁니다`);
    }
  }
  notes.push(`판정은 ${QZ} 한 곳에 있고 주문유형·청산 여부를 받습니다`);
}

// ── 2. 바이낸스 어댑터가 실제 필터를 읽는가 ──
if (!existsSync(BF)) fail(`${BF}이 없습니다`);
else {
  const bf = stripJs(readFileSync(BF, 'utf8'));
  const body = fnBodyAt(bf, 'export async function getSymbolFilters');
  if (!body) fail(`${BF}에서 getSymbolFilters 본문을 찾지 못했습니다`);
  else {
    for (const f of ['LOT_SIZE', 'MARKET_LOT_SIZE', 'PRICE_FILTER', 'MIN_NOTIONAL']) {
      if (!body.includes(f)) {
        fail(`${BF}의 getSymbolFilters가 ${f} 필터를 읽지 않습니다`);
      }
    }
    // 이름만 있는 것과 **값을 싣는 것**은 다르다.
    if (!/notional/.test(body)) {
      fail(`${BF}이 MIN_NOTIONAL의 notional 값을 읽지 않습니다`);
    }
    if (!/marketQty\s*[,:]/.test(body)) {
      fail(`${BF}이 시장가 격자를 결과에 싣지 않습니다`);
    }
    // 없는 필터를 다른 필터로 채우면 안 된다.
    if (/marketQty\s*:\s*(?:limitQty|gridOf\s*\(\s*lot\s*\))/.test(body)) {
      fail(`${BF}이 MARKET_LOT_SIZE 대신 LOT_SIZE를 복사합니다`);
    }
    // 최소 금액 기본값 금지.
    for (const m of body.matchAll(/minNotional[^;\n]{0,40}(?:\?\?|\|\|)\s*(\d+)/g)) {
      fail(`${BF}이 최소 명목가 기본값 ${m[1]}을 지어냅니다`);
    }
    // ── minQty를 stepSize로 추론하지 않는다 ──
    //
    // 바이낸스에서 둘은 서로 다른 규칙이다. 최소가 0.01인데 단위가
    // 0.001인 종목에서 그 추론은 최소를 열 배 낮춰 잡는다 — 거래소가
    // 거절할 주문을 우리가 통과시킨다.
    const gridAt = body.search(/const\s+gridOf\s*=/);
    if (gridAt < 0) fail(`${BF}에 격자 파서(gridOf)가 없습니다`);
    else {
      const g = braceBodyAt(body, gridAt);
      if (/minQty\s*:\s*[^,}\n]*\b(?:st|step|stepSize)\b/.test(g)) {
        fail(`${BF}이 minQty를 stepSize로 대신 채웁니다 — 둘은 다른 규칙입니다`);
      }
      // 두 값 다 있어야 격자가 만들어진다.
      if (!/minQty[\s\S]{0,80}return null/.test(g) && !/return null[\s\S]{0,120}minQty/.test(g)) {
        fail(`${BF}의 격자 파서가 minQty가 없을 때 null을 돌려주지 않습니다`);
      }
    }
  }
  notes.push(`${BF}이 주문유형별 격자와 최소 금액을 거래소에서 읽습니다`);
}

// ── 3. Gate에 없는 규칙을 만들지 않는가 ──
if (!existsSync(GP)) fail(`${GP}이 없습니다`);
else {
  const gp = stripJs(readFileSync(GP, 'utf8'));
  const body = fnBodyAt(gp, 'export function gateFiltersOf');
  if (!body) fail(`${GP}에서 gateFiltersOf 본문을 찾지 못했습니다`);
  else {
    if (!/minNotional\s*:\s*null/.test(body)) {
      fail(`${GP}이 Gate에 고정 최소 명목가를 만듭니다`
        + ' — Gate 계약 명세에는 그 필드가 없습니다. 최소 정본은 계약 수입니다');
    }
    if (!/quantoMultiplier/.test(body)) fail(`${GP}이 계약 배수를 읽지 않습니다`);
  }
  notes.push(`${GP}이 Gate에 없는 최소 금액을 만들지 않습니다`);
}

// ── 4. 서버가 기준가를 스스로 읽는가 ──
if (!existsSync(ADAPTER)) fail(`${ADAPTER}이 없습니다`);
else {
  const ad = stripJs(readFileSync(ADAPTER, 'utf8'));
  if (!/export async function futuresMarkPrice\b/.test(ad)) {
    fail(`${ADAPTER}에 futuresMarkPrice가 없습니다 — 서버가 기준가를 스스로 읽어야 합니다`);
  }
  const mk = fnBodyAt(ad, 'export async function futuresMarkPrice');
  if (mk) {
    if (!/getPremiumIndex/.test(mk)) fail(`${ADAPTER}의 futuresMarkPrice가 바이낸스 마크가를 읽지 않습니다`);
    if (!/getTickerGateFutures/.test(mk)) fail(`${ADAPTER}의 futuresMarkPrice가 Gate 시세를 읽지 않습니다`);
    for (const bad of ['1375', 'api/prices', 'coingecko']) {
      if (mk.includes(bad)) fail(`${ADAPTER}의 futuresMarkPrice가 ${bad}로 값을 만듭니다`);
    }
    if (!/testnet/.test(mk)) fail(`${ADAPTER}의 futuresMarkPrice가 환경을 구분하지 않습니다`);
  }
}

for (const [file, label] of [[ROUTE, '주문 라우트'], [EXEC, '실행 경로']]) {
  if (!existsSync(file)) { fail(`${file}이 없습니다`); continue; }
  const src = stripJs(readFileSync(file, 'utf8'));
  if (!/quantizeOrder\s*\(/.test(src)) continue;
  if (!/marketReferencePrice/.test(src)) {
    fail(`${file}(${label})이 시장가 최소 금액의 기준가를 넘기지 않습니다`);
  }
  if (!/futuresMarkPrice\s*\(/.test(src)) {
    fail(`${file}(${label})이 기준가를 서버에서 읽지 않습니다`);
  }
  // **화면이 보낸 가격을 기준가로 쓰면 안 된다.**
  if (/marketReferencePrice\s*:\s*(?:price|Number\(price\)|body\.|orderPrice)/.test(src)) {
    fail(`${file}(${label})이 화면이 보낸 가격을 최소 금액 기준가로 씁니다`);
  }
  if (!/reduceOnly\s*:/.test(src)) {
    fail(`${file}(${label})이 청산 여부를 규격 판정에 넘기지 않습니다`);
  }
}

// ── 5. 화면에 최소 금액 상수가 없는가 ──
if (!existsSync(PAGE)) fail(`${PAGE}이 없습니다`);
else {
  const page = stripJs(readFileSync(PAGE, 'utf8'));
  if (/CLIENT_MIN_NOTIONAL/.test(page)) {
    fail(`${PAGE}에 최소 주문 금액 상수가 다시 생겼습니다`
      + ' — 정본은 거래소 필터이고 서버가 강제합니다');
  }
  if (/minNotional/i.test(page)) {
    fail(`${PAGE}이 최소 주문 금액을 다룹니다 — 화면은 계산·안내까지만 합니다`);
  }
}
if (existsSync(PLAN)) {
  const plan = stripJs(readFileSync(PLAN, 'utf8'));
  if (/minNotional/i.test(plan)) {
    fail(`${PLAN}이 최소 주문 금액을 판정합니다 — 그 인자 자체가 없어야 합니다`);
  }
  if (/BELOW_MIN_NOTIONAL/.test(plan)) {
    fail(`${PLAN}에 화면 기준 최소 금액 차단이 남아 있습니다`);
  }
  notes.push('화면·화면 계획에 최소 금액 상수가 없습니다');
}

// ── 6. 시험 ──
const reg = existsSync('scripts/run-tests.mjs') ? readFileSync('scripts/run-tests.mjs', 'utf8') : '';
if (!reg.includes('runQuantizeTests()')) fail('run-tests.mjs에 runQuantizeTests()가 없습니다');
if (!existsSync(TEST)) fail(`${TEST}이 없습니다`);
else {
  const t = readFileSync(TEST, 'utf8');
  const need = [
    ['시장가는 MARKET_LOT_SIZE로, 지정가는 LOT_SIZE로 자른다', '주문유형별 격자'],
    ['자른 뒤의 수량으로 최소 금액을 본다', 'quantization 후 최소 금액'],
    ['규격을 못 읽어도 청산은 보낸다', '청산 fail-open'],
    ['규격을 못 읽으면 신규 진입은 막는다', '신규 진입 차단'],
    ['청산에는 최소 금액을 적용하지 않는다', '청산 최소 금액 면제'],
    ['Gate는 1계약 미만이면 막고', 'Gate 계약 규칙'],
    ['시장가 격자를 모르면 신규 진입을 막는다', '주문유형 격자 미확인'],
  ];
  for (const [needle, label] of need) {
    if (!t.includes(needle)) fail(`${TEST}에 ${label} 시험이 없습니다`);
  }
}

console.log('최소 주문 정본 확인');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length === 0) {
  console.log('통과 — 최소 주문 규칙은 거래소가 정하고, 신규와 청산이 갈립니다');
  process.exit(0);
}
for (const f of fails) console.log(`::error::${f}`);
console.log(`실패 ${fails.length}건`);
process.exit(1);
