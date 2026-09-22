#!/usr/bin/env node
// scripts/venue-precision-mutations.mjs
//
// **거래소 격자 계약을 하나씩 무력화하고, 그때 게이트가 빨개지는지 본다.**
//
// 이 저장소에서 규칙이 뮤테이션을 통과시킨 적이 여러 번 있고 전부 같은
// 이유였다 — **낱말만 찾고 모양을 안 봤다.** 그래서 여기서는 실제로
// 격자가 무너지는 변경을 넣는다.
//
// 대조군은 반드시 GREEN이어야 한다. "무엇을 해도 빨개지는" 검사기가
// 만점을 받는 일을 막는다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SPEC   = 'src/lib/markets/venueSpec.ts';
const SOURCE = 'src/lib/markets/venueSpecSource.ts';
const SPOT   = 'src/lib/exchanges/binance.ts';
const PAPER  = 'src/app/api/paper/order/route.ts';
const REG    = 'src/lib/products/registry.ts';
const CHECK  = 'scripts/check-venue-precision.mjs';

const ONLY = process.argv.slice(2);

function gate() {
  const c = spawnSync('node', [CHECK], { encoding: 'utf8' });
  if (c.status !== 0) return { red: true, by: '격자 검사기' };
  const r = spawnSync('node', ['scripts/run-tests.mjs'], { encoding: 'utf8' });
  if (r.status !== 0) return { red: true, by: '시험' };
  return { red: false, by: null };
}

const CASES = [
  // ── ★ 지목된 12가지 회귀 ──

  ['MUT-V1 tickSize를 격자에서 버린다', SPEC, 'RED',
   [['    tickSize: s.tickSize,', '    tickSize: null,']]],

  ['MUT-V2 stepSize를 무시하고 원래 수량을 보낸다', SPEC, 'RED',
   [['  const r = quantizeOrder(q0, i.price ?? null, filtersOf(spec), {',
     '  if (spec) return { ok: true, quantity: q0, price: i.price ?? null, applied: true,\n    source: spec.source, venue, changed: false, code: null, reason: "" };\n  const r = quantizeOrder(q0, i.price ?? null, filtersOf(spec), {']]],

  ['MUT-V3 minQty를 격자에서 버린다', SPEC, 'RED',
   [['  const grid = (step: number | null, min: number | null) =>\n    (step == null && min == null) ? null : { stepSize: step, minQty: min };',
     '  const grid = (step: number | null, min: number | null) =>\n    (step == null && min == null) ? null : { stepSize: step, minQty: null };']]],

  ['MUT-V4 minNotional을 격자에서 버린다', SPEC, 'RED',
   [['    minNotional: s.minNotional,', '    minNotional: null,']]],

  ['MUT-V5 모르는 venue를 기본 venue로 떨어뜨린다', SPEC, 'RED',
   [["  if (market === 'USDM') return 'BINANCE_USDM';\n  return null;",
     "  return 'BINANCE_SPOT';"]]],

  ['MUT-V6 못 읽은 격자를 기본값으로 대체한다', SOURCE, 'RED',
   [['  return unknownSpec(venue, sym);',
     '  return { venue, symbol: sym, source: "EXCHANGE", tickSize: 0.01, stepSize: 0.001,\n    minQty: 0.001, maxQty: null, minNotional: 10, marketStepSize: 0.001,\n    marketMinQty: 0.001, multiplier: null, fetchedAt: Date.now() };']]],

  ['MUT-V6b 현물 규격에 기본값을 되살린다 (고쳐 둔 그 버그)', SPOT, 'RED',
   [['      stepSize: num(lot?.stepSize),', "      stepSize: num(lot?.stepSize) ?? 0.00001,"]]],

  ['MUT-V7 시장가 격자를 지정가 격자에서 복사한다 (SPOT→FUTURES류 재사용)', SPEC, 'RED',
   [['    marketQty: grid(s.marketStepSize, s.marketMinQty),',
     '    marketQty: grid(s.marketStepSize ?? s.stepSize, s.marketMinQty ?? s.minQty),']]],

  ['MUT-V8 USDT-M 격자를 COIN-M에도 쓴다', SOURCE, 'RED',
   [["  if (venue === 'BINANCE_USDM') {", "  if (venue === 'BINANCE_USDM' || venue === 'BINANCE_COINM') {"]]],

  ['MUT-V9 모의가 venue를 묻지 않고 현물 격자를 쓴다 (PAPER/LIVE 권위 혼동)', PAPER, 'RED',
   [['  const venue = venueForPaperMarket(market);',
     "  const venue = 'BINANCE_SPOT' as any;"]]],

  ['MUT-V10 KIS를 근거 없이 규격 지원으로 올린다', REG, 'RED',
   [["      venue: 'KIS_KR', verdict: 'VENUE_GAP',", "      venue: 'KIS_KR', verdict: 'SUPPORTED',"]]],

  ['MUT-V11 일부 venue만 증명하고 제품 전체를 승격한다', REG, 'RED',
   [['  return vs.every(v => v.verdict === \'SUPPORTED\');',
     '  return vs.some(v => v.verdict === \'SUPPORTED\');']]],

  // MUT-V12는 뺐다. `venueSpec`에 0 수량 가드를 한 겹 더 두었는데,
  // `quantizeOrder`가 이미 `INVALID_STEP`으로 막아(quantize.ts:248) **도달
  // 불가**였다 — 가드를 `if (false)`로 바꿔도 게이트가 초록이었다.
  // 지키는 뮤테이션이 없는 방어는 죽은 코드라 가드를 지웠다.

  // ── 절충 정책이 정책대로인가 ──

  ['MUT-V13 못 읽었는데 "맞췄다"고 적는다', SPEC, 'RED',
   [["      ok: true, quantity: q0, price: i.price ?? null, applied: false,",
     "      ok: true, quantity: q0, price: i.price ?? null, applied: true,"]]],

  ['MUT-V14 못 읽었을 때 수량을 임의로 바꾼다', SPEC, 'RED',
   [["      ok: true, quantity: q0, price: i.price ?? null, applied: false,",
     "      ok: true, quantity: Math.floor(q0 * 1000) / 1000, price: i.price ?? null, applied: false,"]]],

  ['MUT-V15 모의가 맞춘 수량을 버리고 원래 수량으로 계획한다', PAPER, 'RED',
   [['    quantity: Number(norm.quantity),', '    quantity: Number(body?.quantity),']]],

  ['MUT-V16 규격 적용 여부를 응답에서 숨긴다', PAPER, 'RED',
   [['      applied: norm.applied, source: norm.source, venue: norm.venue,',
     '      source: norm.source, venue: norm.venue,']]],

  ['MUT-V17 제품 축 PRECISION을 근거 없이 올린다', REG, 'RED',
   [["    PRECISION: cap('VENUE_GAP', 'src/app/api/binance/spot/order/route.ts',",
     "    PRECISION: cap('SUPPORTED', 'src/app/api/binance/spot/order/route.ts',"]]],

  // ── 대조군 (GREEN이어야 한다) ──
  ['OK-V1 격자 정본에 주석 한 줄 추가', SPEC, 'GREEN',
   [['export type VenueId =', '// 대조군\nexport type VenueId =']]],
  ['OK-V2 공급자에 주석 한 줄 추가', SOURCE, 'GREEN',
   [['const cache = new Map<string, VenueSpec>();', '// 대조군\nconst cache = new Map<string, VenueSpec>();']]],
  ['OK-V3 검사기에 주석 한 줄 추가', CHECK, 'GREEN',
   [["const SPEC   = 'src/lib/markets/venueSpec.ts';",
     "// 대조군\nconst SPEC   = 'src/lib/markets/venueSpec.ts';"]]],
];

const selected = ONLY.length ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;
console.log(`게이트: 격자 검사기 + 전체 시험\n총 ${selected.length}건\n`);

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
