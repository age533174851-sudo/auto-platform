#!/usr/bin/env node
// scripts/gate-spot-precision-mutations.mjs
//
// **Gate 현물 규격 계약을 하나씩 무너뜨리고, 그때 게이트가 빨개지는지 본다.**
//
// 이 저장소에서 규칙이 뮤테이션을 통과시킨 적이 여러 번 있고 전부 같은
// 이유였다 — **낱말만 찾고 모양을 안 봤다.** 그래서 여기서는 실제로 틀린
// 값이 거래소로 나가는 변경을 넣는다.
//
// 대조군은 반드시 GREEN이어야 한다. "무엇을 해도 빨개지는" 검사기가
// 만점을 받는 일을 막는다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PREC = 'src/lib/exchanges/gateSpotPrecision.ts';
const PLAN = 'src/lib/exchanges/gateSpotPlan.ts';
const API  = 'src/lib/exchanges/gateSpot.ts';
const EXEC = 'src/lib/exchanges/spotOrderExecutor.ts';
const REG  = 'src/lib/products/registry.ts';
const CHECK = 'scripts/check-gate-spot-precision.mjs';

const ONLY = process.argv.slice(2);

function gate() {
  const c = spawnSync('node', [CHECK], { encoding: 'utf8' });
  if (c.status !== 0) return { red: true, by: 'Gate 규격 검사기' };
  const p = spawnSync('node', ['scripts/check-product-registry.mjs'], { encoding: 'utf8' });
  if (p.status !== 0) return { red: true, by: '제품 정본 검사기' };
  const r = spawnSync('node', ['scripts/run-tests.mjs'], { encoding: 'utf8' });
  if (r.status !== 0) return { red: true, by: '시험' };
  return { red: false, by: null };
}

const CASES = [
  // ── ★ 지목된 여덟 가지 ──

  ['MUT-G1 지정가 가격 정규화를 제거한다 (원값이 그대로 나간다)', PLAN, 'RED',
   [[`    body.price = String(sentPrice);`, `    body.price = String(price);`]]],

  ['MUT-G2 가격 자릿수를 수량 자릿수로 바꾼다', PLAN, 'RED',
   [[`    const r = roundGatePrice(price, i.pricePrecision);`,
     `    const r = roundGatePrice(price, i.amountPrecision);`]]],

  ['MUT-G2b 조회 단계에서 가격 자릿수를 수량 필드로 채운다', API, 'RED',
   [[`      pricePrecision: n(d.precision),`, `      pricePrecision: n(d.amount_precision),`]]],

  ['MUT-G3 금액 기반 시장가 매수에 수량 정규화를 건다 (단위가 다르다)', PLAN, 'RED',
   [[`    body.amount = String(amt);`,
     `    body.amount = String(floorTo(amt, i.amountPrecision));`]]],

  ['MUT-G3b 금액 기반 매수에 가격 정규화를 건다', PLAN, 'RED',
   [[`    body.time_in_force = 'ioc';
    body.amount = String(amt);`,
     `    body.time_in_force = 'ioc';
    roundGatePrice(amt, i.pricePrecision);
    body.amount = String(amt);`]]],

  ['MUT-G4 기존 수량 내림을 제거한다 (매도가 보유를 넘긴다)', PLAN, 'RED',
   [[`  const qty = floorTo(rawQty, i.amountPrecision);`, `  const qty = rawQty;`]]],

  ['MUT-G5 규격 조회 실패를 "맞췄다"로 기록한다', PREC, 'RED',
   [[`    return { price: p0, applied: false, skipped: 'METADATA_UNKNOWN', changed: false };`,
     `    return { price: p0, applied: true, skipped: null, changed: false };`]]],

  ['MUT-G5b 규격 조회 실패인데 신규 매수를 그대로 보낸다', PLAN, 'RED',
   [[`      if (!i.isExit) {`, `      if (false) {`]]],

  ['MUT-G5c 매도까지 막는다 (못 파는 상태를 만든다)', EXEC, 'RED',
   [[`      isExit: ctx.side === 'SELL',`, `      isExit: false,`]]],

  ['MUT-G6 자릿수에 임의 기본값을 넣는다', PLAN, 'RED',
   [[`    const r = roundGatePrice(price, i.pricePrecision);`,
     `    const r = roundGatePrice(price, i.pricePrecision ?? 2);`]]],

  ['MUT-G6b 빈 값을 0(정수 호가)으로 읽는다 (Number(null)===0 함정)', PREC, 'RED',
   [[`  if (precision == null || precision === '') return null;`, `  if (false) return null;`]]],

  ['MUT-G6c 모르는 자릿수를 기본값으로 대체한다', PREC, 'RED',
   [[`  const d = gatePriceDecimals(precision);
  if (d == null) {`,
     `  const d = gatePriceDecimals(precision) ?? 8;
  if (false) {`]]],

  ['MUT-G7 정규화 전 가격을 본문에 다시 넣는 우회를 만든다', PLAN, 'RED',
   [[`    body.price = String(sentPrice);
    body.time_in_force = 'gtc';`,
     `    body.price = String(sentPrice);
    body.price = String(price);
    body.time_in_force = 'gtc';`]]],

  ['MUT-G8 registry를 실행 근거 없이 SUPPORTED로 올린다', REG, 'RED',
   [[`      venue: 'GATE_SPOT', verdict: 'VENUE_GAP',`,
     `      venue: 'GATE_SPOT', verdict: 'SUPPORTED',`]]],

  // ── 축을 뭉개는 변경 ──

  ['MUT-G9 "이 주문에 없음"을 "못 읽음"으로 뭉갠다', PLAN, 'RED',
   [[`        quantityApplied: false, quantitySkipped: 'NOT_IN_ORDER',
        priceApplied: false, priceSkipped: 'NOT_IN_ORDER',`,
     `        quantityApplied: false, quantitySkipped: 'METADATA_UNKNOWN',
        priceApplied: false, priceSkipped: 'METADATA_UNKNOWN',`]]],

  ['MUT-G10 최소 금액 검사를 최소 수량으로 바꾼다 (축 혼동)', PLAN, 'RED',
   [[`    if (i.minQuoteAmount != null && amt < Number(i.minQuoteAmount)) {`,
     `    if (i.minBaseAmount != null && amt < Number(i.minBaseAmount)) {`]]],

  ['MUT-G11 자릿수→증분 변환을 정본 밖에 만든다', PLAN, 'RED',
   [[`    const r = roundGatePrice(price, i.pricePrecision);`,
     `    const _t = Math.pow(10, -Number(i.pricePrecision));
    const r = roundGatePrice(price, i.pricePrecision);`]]],

  ['MUT-G12 맞춘 결과를 호출자에게 안 넘긴다', API, 'RED',
   [[`      precision: plan.precision,`, ``]]],

  ['MUT-G12b 실행부가 규격 결과를 버린다', EXEC, 'RED',
   [[`    venuePrecision: r.precision,`, ``]]],

  ['MUT-G13 자릿수에 맞춰 0이 된 가격을 그대로 보낸다', PLAN, 'RED',
   [[`    if (!(Number(sentPrice) > 0)) {`, `    if (false) {`]]],

  // ── 대조군 (GREEN이어야 한다) ──
  ['OK-G1 규격 파일에 주석 한 줄 추가', PREC, 'GREEN',
   [[`export type GatePrecisionSkip =`, `// 대조군\nexport type GatePrecisionSkip =`]]],
  ['OK-G2 계획 파일에 주석 한 줄 추가', PLAN, 'GREEN',
   [[`export type GateSpotSide =`, `// 대조군\nexport type GateSpotSide =`]]],
  ['OK-G3 검사기에 주석 한 줄 추가', CHECK, 'GREEN',
   [[`const PREC = 'src/lib/exchanges/gateSpotPrecision.ts';`,
     `// 대조군\nconst PREC = 'src/lib/exchanges/gateSpotPrecision.ts';`]]],
];

const selected = ONLY.length ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;
console.log(`게이트: Gate 규격 검사기 + 제품 정본 검사기 + 전체 시험\n총 ${selected.length}건\n`);

let detected = 0, missed = 0, noop = 0, greenOk = 0, greenBad = 0;

for (const [name, file, kind, cuts] of selected) {
  if (!existsSync(file)) { console.log(`  ⚠  ${name} — 파일이 없습니다`); noop += 1; continue; }
  const before = readFileSync(file, 'utf8');
  let after = before;
  let missing = false;
  for (const [from, to] of cuts) {
    if (!after.includes(from)) { missing = true; break; }
    // ★ 함수로 넘긴다. 문자열 치환은 `$'`를 "매치 뒤 전체"로 해석한다.
    after = after.replace(from, () => to);
  }
  if (missing || after === before) {
    console.log(`  ⚠  ${name} — 대상 문구를 찾지 못했습니다`);
    noop += 1; continue;
  }

  writeFileSync(file, after);
  let res;
  try { res = gate(); } finally { writeFileSync(file, before); }

  if (kind === 'RED') {
    if (res.red) { console.log(`  ●  ${name} — RED (검출: ${res.by})`); detected += 1; }
    else { console.log(`  ✗  ${name} — GREEN (새 나감)`); missed += 1; }
  } else {
    if (!res.red) { console.log(`  ✓  ${name} — PASS (과도 검출 없음)`); greenOk += 1; }
    else { console.log(`  ✗  ${name} — RED (과도 검출: ${res.by})`); greenBad += 1; }
  }
}

console.log(`\n검출 ${detected} / 누락 ${missed} / 판정불가 ${noop}`
  + ` / 대조군 PASS ${greenOk} · 과도검출 ${greenBad}`);
process.exit(missed > 0 || greenBad > 0 || noop > 0 ? 1 : 0);
