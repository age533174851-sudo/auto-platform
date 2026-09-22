#!/usr/bin/env node
// scripts/spot-precision-mutations.mjs
//
// **현물 격자 계약을 하나씩 무력화하고, 그때 게이트가 빨개지는지 본다.**
//
// 규칙을 새로 쓸 때마다 이 저장소에서 같은 일이 있었다 — 낱말만 찾고
// 모양을 안 봐서 뮤테이션이 그대로 통과했다. 그래서 여기서는 실제로
// 주문이 잘못 나가는 변경을 넣는다.
//
// 대조군은 반드시 GREEN이어야 한다. "무엇을 해도 빨개지는" 검사기가
// 만점을 받는 일을 막는다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const EXEC  = 'src/lib/exchanges/spotOrderExecutor.ts';
const ROUTE = 'src/app/api/binance/spot/order/route.ts';
const BN    = 'src/lib/exchanges/binance.ts';
const PLAN  = 'src/app/api/strategies/spot/plan/route.ts';
const FORM  = 'src/lib/trading/useTradeForm.ts';
const REG   = 'src/lib/products/registry.ts';
const CHECK = 'scripts/check-spot-precision.mjs';

const ONLY = process.argv.slice(2);

function gate() {
  const c = spawnSync('node', [CHECK], { encoding: 'utf8' });
  if (c.status !== 0) return { red: true, by: '현물 격자 검사기' };
  const v = spawnSync('node', ['scripts/check-venue-precision.mjs'], { encoding: 'utf8' });
  if (v.status !== 0) return { red: true, by: '거래소 격자 검사기' };
  const r = spawnSync('node', ['scripts/run-tests.mjs'], { encoding: 'utf8' });
  if (r.status !== 0) return { red: true, by: '시험' };
  return { red: false, by: null };
}

const CASES = [
  // ── ★ 4B-2A의 핵심 경계 ──

  ['MUT-S1a 금액 매수 갈래를 없애 정규화로 떨어뜨린다 (Number(null)===0으로 전부 막힌다)', EXEC, 'RED',
   [[`  if (byQuote) {`, `  if (false) {`]]],

  ['MUT-S1b 금액 매수 갈래에서 별칭으로 정규화를 부른다', EXEC, 'RED',
   [[`  if (byQuote) {`,
     `  if (byQuote) {
    const { normalizeForVenue: _nv } = await import('@/lib/markets/venueSpec');
    _nv({ spec: null, quantity: qty as number });`]]],

  ['MUT-S2 금액 매수의 사유를 "규격 미상"으로 적는다 (해당 없음과 장애를 합친다)', EXEC, 'RED',
   [[`skipped: 'QUOTE_ORDER'`, `skipped: 'SPEC_UNKNOWN'`]]],

  ['MUT-S3 금액 매수를 "맞췄다"고 적는다', EXEC, 'RED',
   [[`venue: 'BINANCE_SPOT', applied: false, skipped: 'QUOTE_ORDER',`,
     `venue: 'BINANCE_SPOT', applied: true, skipped: 'QUOTE_ORDER',`]]],

  // ── 정본을 거치는가 ──

  ['MUT-S4 정규화를 빼고 원래 수량을 보낸다', EXEC, 'RED',
   [[`    const norm = normalizeForVenue({`,
     `    const norm = { ok: true, quantity: qty, price, applied: true, source: 'EXCHANGE' as any,
      changed: false, code: null, reason: '' } as any;
    const _unused = normalizeForVenue({`]]],

  ['MUT-S5 규격 조회가 이 연결의 망을 따르지 않는다 (실전 규격으로 테스트넷 주문)', EXEC, 'RED',
   [[`await fetchVenueSpec('BINANCE_SPOT', symbol, testnet)`,
     `await fetchVenueSpec('BINANCE_SPOT', symbol, false)`]]],

  // ── 주문유형 · 매도 정책 ──

  ['MUT-S6 주문유형을 안 넘긴다 (시장가를 지정가 격자로 깎는다)', EXEC, 'RED',
   [[`      orderType: type,\n      reduceOnly: isSellSide,`,
     `      reduceOnly: isSellSide,`]]],

  ['MUT-S7 시장가를 언제나 지정가로 본다', EXEC, 'RED',
   [[`      orderType: type,`, `      orderType: 'LIMIT' as const,`]]],

  ['MUT-S8 매도를 진입과 같은 정책으로 막는다 (못 파는 상태를 만든다)', EXEC, 'RED',
   [[`      reduceOnly: isSellSide,`, `      reduceOnly: false,`]]],

  ['MUT-S9 매수까지 청산으로 적는다 (최소 명목가 검사가 사라진다)', EXEC, 'RED',
   [[`      reduceOnly: isSellSide,`, `      reduceOnly: true,`]]],

  // ── 기준가 ──

  ['MUT-S10 최소 명목가 기준가를 넘기지 않는다', EXEC, 'RED',
   [[`      referencePrice,\n    });`, `      referencePrice: null,\n    });`]]],

  ['MUT-S11 기준가를 호출자가 준 값으로 쓴다 (검사가 검사 대상에게 묻는다)', EXEC, 'RED',
   [[`    const referencePrice = needsRef ? await bn.getSpotPrice(symbol, testnet) : null;`,
     `    const referencePrice = needsRef ? Number((args as any).price) : null;`]]],

  ['MUT-S12 기준가를 실전 호스트에서 읽는다', BN, 'RED',
   [[`      \`\${spotBase(testnet)}/api/v3/ticker/price?symbol=\${encodeURIComponent(sym)}\``,
     `      \`https://api.binance.com/api/v3/ticker/price?symbol=\${encodeURIComponent(sym)}\``]]],

  ['MUT-S13 현재가를 못 읽고 0을 돌려준다 (명목가가 0이 되어 전부 통과)', BN, 'RED',
   [[`    return Number.isFinite(p) && p > 0 ? p : null;\n  } catch { return null; }`,
     `    return Number.isFinite(p) && p > 0 ? p : 0;\n  } catch { return 0; }`]]],

  // ── 맞춘 값이 실제로 나가는가 ──

  ['MUT-S14 맞춘 수량을 버리고 원래 수량을 보낸다', EXEC, 'RED',
   [[`      quantity: byQuote ? undefined : (qty as number),`,
     `      quantity: byQuote ? undefined : (quantity as number),`]]],

  ['MUT-S15 맞춘 가격을 버리고 원값을 보낸다 (PRICE_FILTER에 걸린다)', EXEC, 'RED',
   [[`      price: type === 'LIMIT' ? (orderPrice as number) : undefined,`,
     `      price: type === 'LIMIT' ? (price as number) : undefined,`]]],

  ['MUT-S16 장부에는 맞추기 전 가격을 적는다 (거래소와 다른 주문이 기록된다)', EXEC, 'RED',
   [[`    price: type === 'LIMIT' ? orderPrice : null,`,
     `    price: type === 'LIMIT' ? price : null,`]]],

  ['MUT-S17 정규화 뒤에 두 번째 반올림을 되살린다', EXEC, 'RED',
   [[`    qty = norm.quantity;`,
     `    qty = norm.quantity;
    qty = (await import('./binance')).roundSpotQty(qty as number, 0.001);`]]],

  // ── 사실이 화면까지 가는가 ──

  ['MUT-S18 격자 적용 여부를 체결 응답에서 숨긴다', EXEC, 'RED',
   [[`    orderId: r.orderId, filledQty: r.qty, avgPrice: r.price,\n    venuePrecision: precision,`,
     `    orderId: r.orderId, filledQty: r.qty, avgPrice: r.price,`]]],

  ['MUT-S19 라우트가 격자 결과를 응답에서 뺀다', ROUTE, 'RED',
   [[`    venuePrecision: r.venuePrecision,`, ``]]],

  ['MUT-S20 사유를 만들어 놓고 문장에 안 붙인다 (수량이 줄어도 말 안 함)', EXEC, 'RED',
   [[`체결\` + precisionNote,`, `체결\`,`]]],

  ['MUT-S21 화면 훅이 서버 문장을 다시 버린다 (4B-1이 새 나간 그 자리)', FORM, 'RED',
   [[`        setMessage({ ok: true, text });`,
     `        setMessage({ ok: true, text: '모의 주문이 체결됐습니다' });`]]],

  // ── 규격 조회 단일화 ──

  ['MUT-S22 계획 라우트가 규격 조회를 다시 직접 한다', PLAN, 'RED',
   [[`    const { getSpotSymbolFilters } = await import('@/lib/exchanges/binance');`,
     `    const _r = await fetch(\`https://api.binance.com/api/v3/exchangeInfo?symbol=\${symbol}\`);
    const { getSpotSymbolFilters } = await import('@/lib/exchanges/binance');`]]],

  ['MUT-S23 계획 라우트가 망을 무시하고 실전 규격으로 판정한다', PLAN, 'RED',
   [[`fetchMinNotional(symbol, specTestnet)`, `fetchMinNotional(symbol, false)`]]],

  // ── roundSpotQty ──

  ['MUT-S24 roundSpotQty가 NaN 단위를 다시 통과시킨다', BN, 'RED',
   [[`  const step = Number(stepSize);\n  if (!Number.isFinite(step) || step <= 0) return qty;`,
     `  const step = Number(stepSize);\n  if (step <= 0) return qty;`]]],

  // ── registry ──

  ['MUT-S25 Gate 현물을 목록에서 지워 제품을 승격시킨다', REG, 'RED',
   [[`      venue: 'GATE_SPOT', verdict: 'VENUE_GAP',`,
     `      venue: 'BINANCE_SPOT', verdict: 'SUPPORTED',`]]],

  ['MUT-S26 제품 칸만 올리고 venue 층은 그대로 둔다 (두 정본이 갈린다)', REG, 'RED',
   [[`    PRECISION: cap('VENUE_GAP', 'src/lib/exchanges/gateSpotPlan.ts:168',`,
     `    PRECISION: cap('SUPPORTED', 'src/lib/exchanges/gateSpotPlan.ts:168',`]]],

  ['MUT-S27 근거 없는 venue를 SUPPORTED로 올린다', REG, 'RED',
   [[`      venue: 'GATE_SPOT', verdict: 'VENUE_GAP',`,
     `      venue: 'GATE_SPOT', verdict: 'SUPPORTED',`]]],

  // ── 범위 경계 ──

  ['MUT-S28 Gate 현물에 바이낸스 격자를 얹는다 (단위 개념이 다른 격자 둘)', EXEC, 'RED',
   [[`  const p = toGatePair(ctx.symbol);`,
     `  const { normalizeForVenue: _g } = await import('@/lib/markets/venueSpec');
  const p = toGatePair(ctx.symbol);`]]],

  // ── 대조군 (GREEN이어야 한다) ──
  ['OK-S1 실행부에 주석 한 줄 추가', EXEC, 'GREEN',
   [[`export interface SpotOrderArgs {`, `// 대조군\nexport interface SpotOrderArgs {`]]],
  ['OK-S2 검사기에 주석 한 줄 추가', CHECK, 'GREEN',
   [[`const EXEC  = 'src/lib/exchanges/spotOrderExecutor.ts';`,
     `// 대조군\nconst EXEC  = 'src/lib/exchanges/spotOrderExecutor.ts';`]]],
  ['OK-S3 현물 모듈에 주석 한 줄 추가', BN, 'GREEN',
   [[`export function roundSpotQty(`, `// 대조군\nexport function roundSpotQty(`]]],
];

const selected = ONLY.length ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;
console.log(`게이트: 현물 격자 검사기 + 거래소 격자 검사기 + 전체 시험\n총 ${selected.length}건\n`);

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
