#!/usr/bin/env node
// scripts/check-order-quantity-source.mjs
//
// **거래소 수량 규격을 화면이 정하지 않는다.**
//
// 무엇이 있었나
// ─────────────
// TradingPage가 실전·테스트넷 주문에 이렇게 보내고 있었다:
//
//   quantity: Number(qty.toFixed(3))
//
// 소수 3자리 **반올림**이다. 의도한 0.0015가 **0.002로 커져서** 나갔다.
// 서버가 그 뒤에 stepSize 0.001로 정상 내림해도 이미 들어온 값이 0.002라
// 되돌아갈 이유가 없다 — **사용자가 누른 것보다 큰 주문이 체결된다.**
//
// 게다가 3자리는 어느 거래소의 규칙도 아니다. 화면은 심볼별 stepSize도,
// Gate의 계약 배수(quanto_multiplier)도 모른다. 모르는 쪽이 규칙을 정하면
// 언젠가 틀린다.
//
// 규격을 아는 곳은 서버 하나다:
//
//   futuresSymbolFilters()  거래소별 stepSize·minQty·minNotional
//   quantizeOrder()         stepSize로 **내림** · 미달이면 거절
//
// 그래서 신규 진입에서 **최종 수량 ≤ 의도 수량**이 항상 성립한다.
//
// 이 검사가 막는 것
// ─────────────────
// 화면이 보내는 `quantity:` 자리에 자리수 반올림이 다시 들어오는 것과,
// 서버의 정본 경로가 끊기는 것.
//
// 사용: node scripts/check-order-quantity-source.mjs

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);

// ── 주석을 먼저 걷어낸다 ──
//
// **이 저장소의 검사기는 자기 설명을 사용처로 읽은 적이 여러 번 있다.**
// 이 파일도 위에서 `toFixed(3)`을 그대로 적고 있다. 문자를 하나씩 걸으며
// 문자열 안의 `//`는 주석으로 세지 않는다.
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

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === '.next') continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

// ── 1. 화면이 보내는 quantity에 자리수 규칙이 없는가 ──
//
// 거래소로 나가는 주문 경로만 본다. 계산기·일지처럼 표시만 하는 곳은
// 이 계약의 대상이 아니다.
const ORDER_ROUTES = ['/api/binance/futures/order', '/api/orders', '/api/gate/'];

for (const file of walk('src/components')) {
  const body = stripJs(readFileSync(file, 'utf8'));
  // 이 파일이 거래소 주문 경로를 부르는가.
  if (!ORDER_ROUTES.some(r => body.includes(r))) continue;

  for (const m of body.matchAll(/quantity\s*:\s*([^,\n}]+)/g)) {
    const expr = m[1].trim();
    // **자리수를 여기서 정하면 안 된다.** toFixed는 반올림이라 커질 수 있고,
    // Math.round도 마찬가지다. 내림(floor)조차 거래소 단위를 모르면 틀린다.
    if (/toFixed\s*\(|toPrecision\s*\(|Math\.round\s*\(|Math\.ceil\s*\(/.test(expr)) {
      fail(`${file}이 거래소로 보내는 quantity에 자리수 규칙을 넣습니다: ${expr.slice(0, 70)}`
        + ' — 의도한 수량을 그대로 보내고 규격은 서버 quantizeOrder가 정합니다');
    }
  }
}
notes.push('화면이 보내는 수량에 자리수 반올림이 없습니다');

// ── 2. 서버 정본 경로가 살아 있는가 ──
const ROUTE = 'src/app/api/binance/futures/order/route.ts';
if (!existsSync(ROUTE)) fail(`${ROUTE}이 없습니다`);
else {
  const r = stripJs(readFileSync(ROUTE, 'utf8'));
  for (const need of ['futuresSymbolFilters', 'quantizeOrder']) {
    // `const { quantizeOrder } = await import(...)` 의 이름만 보면
    // 호출을 스텁으로 바꿔도 통과한다. **부르는지**를 본다.
    if (!new RegExp(`${need}\\s*\\(`).test(r)) {
      fail(`${ROUTE}이 ${need}를 부르지 않습니다 — 수량 규격을 정하는 곳이 사라졌습니다`);
    }
  }
  // 부르기만 하고 결과를 안 쓰면 규격이 적용되지 않는다.
  if (!/orderQty\s*=\s*q\.quantity/.test(r)) {
    fail(`${ROUTE}이 quantizeOrder의 결과를 주문 수량으로 쓰지 않습니다`);
  }
  // 거절을 무시하고 통과시키면 정본이 있으나 마나다.
  if (!/if\s*\(\s*!\s*q\.ok\s*\)/.test(r)) {
    fail(`${ROUTE}이 quantizeOrder의 거절을 처리하지 않습니다`);
  }
  notes.push(`${ROUTE}이 거래소 규격을 읽어 수량을 정합니다`);
}

// ── 3. 규격 적용은 **내림**이어야 한다 ──
//
// 반올림이면 신규 진입에서 수량이 커질 수 있다. 그게 이 검사의 이유다.
const QZ = 'src/lib/exchanges/quantize.ts';
if (!existsSync(QZ)) fail(`${QZ}가 없습니다`);
else {
  const q = stripJs(readFileSync(QZ, 'utf8'));
  if (!/Math\.floor/.test(q)) {
    fail(`${QZ}가 내림을 쓰지 않습니다 — 반올림하면 신규 진입 수량이 커질 수 있습니다`);
  }
  if (/floorToStep[\s\S]{0,200}Math\.(round|ceil)\s*\(/.test(q)) {
    fail(`${QZ}의 floorToStep이 올림·반올림을 씁니다`);
  }
  notes.push(`${QZ}가 stepSize로 내림합니다 (최종 수량 ≤ 의도 수량)`);
}

console.log('주문 수량 규격 출처 확인');
for (const n of notes) console.log(`  · ${n}`);
if (fails.length === 0) {
  console.log('통과 — 화면은 의도 수량만 보내고, 규격은 거래소 필터가 정합니다');
  process.exit(0);
}
for (const f of fails) console.log(`::error::${f}`);
console.log(`실패 ${fails.length}건`);
process.exit(1);
