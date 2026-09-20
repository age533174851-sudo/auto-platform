#!/usr/bin/env node
// scripts/product-registry-mutations.mjs
//
// **제품 능력 정본의 계약을 하나씩 무력화하고, 그때 게이트가 빨개지는지 본다.**
//
// 통과하는 검사만 보고는 "이 규칙을 아무도 안 지켜본다"를 구별할 수 없다.
// 이 저장소에서 규칙이 뮤테이션을 통과시킨 적이 여러 번 있고 전부 같은
// 이유였다 — **낱말만 찾고 모양을 안 봤다.**
//
// 무엇이 빨개져야 통과인가
//   · `scripts/check-product-registry.mjs` 실패
//   · 또는 제품 정본 시험 실패 (`registry.test.ts`)
// 둘 중 하나라도 빨개지면 RED다.
//
// 대조군
//   주석 한 줄을 더하는 변경은 **GREEN이어야 한다.** 대조군이 없으면
//   "무엇을 해도 빨개지는" 검사기가 만점을 받는다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REG   = 'src/lib/products/registry.ts';
const CHECK = 'scripts/check-product-registry.mjs';
const CAP   = 'src/lib/trading/capability.ts';

const ONLY = process.argv.slice(2);

/** 게이트를 돌린다. 하나라도 실패하면 RED. */
function gate() {
  const c = spawnSync('node', [CHECK], { encoding: 'utf8' });
  if (c.status !== 0) return { red: true, by: '계약 검사기' };
  const t = spawnSync('node', ['-e', `
    import('./src/lib/products/registry.test.ts').catch(() => process.exit(0));
  `], { encoding: 'utf8' });
  // TS는 직접 못 돌린다 — 전체 시험 러너로 본다.
  const r = spawnSync('node', ['scripts/run-tests.mjs'], { encoding: 'utf8' });
  if (r.status !== 0) return { red: true, by: '시험' };
  void t;
  return { red: false, by: null };
}

const CASES = [
  // ── ★ 사용자가 지목한 7가지 회귀 ──

  ['MUT-P1 미지원 제품을 SUPPORTED로 바꾼다 (옵션 주문 경로)', REG, 'RED',
   [["    EXECUTION: cap('BACKEND_GAP', 'src/app/api',\n      '옵션 주문 라우트가 없습니다'),",
     "    EXECUTION: cap('SUPPORTED', 'src/app/api',\n      '옵션 주문 라우트가 없습니다'),"]]],

  ['MUT-P2 LOCKED 제품을 거래 가능으로 연다 (필수 축 검사 제거)', REG, 'RED',
   [['  if (missing.length > 0) {', '  if (false) {']]],

  ['MUT-P3 온체인 mock을 시세 권위로 승격한다', REG, 'RED',
   [["    MARKET_DATA: cap('DATA_GAP', 'src/app/api/onchain/route.ts:44',",
     "    MARKET_DATA: cap('SUPPORTED', 'src/app/api/onchain/route.ts:44',"]]],

  ['MUT-P4 주식의 LIVE/PAPER를 한 칸으로 뭉갠다', REG, 'RED',
   [["    PAPER: cap('BACKEND_GAP', 'src/lib/engine/paperPriceSource.ts:44',\n      '모의 장부가 다루는 시장은 SPOT·USDM뿐입니다 — 주식 모의가 없습니다'),",
     "    PAPER: cap('SUPPORTED', 'src/lib/engine/paperPriceSource.ts:44',\n      '주식도 모의로 거래됩니다'),"]]],

  ['MUT-P5 옵션을 체인 권위 없이 지원 판정한다', REG, 'RED',
   [["    MARKET_DATA: cap('DATA_GAP', 'src/app/api',\n      '만기·행사가·콜풋·IV를 주는 옵션 체인 출처가 없습니다'),",
     "    MARKET_DATA: cap('SUPPORTED', 'src/app/api',\n      '옵션 시세를 읽습니다'),"]]],

  ['MUT-P6 규격 GAP을 근거 없이 SUPPORTED로 바꾼다', REG, 'RED',
   [["    PRECISION: cap('VENUE_GAP', 'src/app/api/binance/spot/order/route.ts',",
     "    PRECISION: cap('SUPPORTED', 'src/app/api/binance/spot/order/route.ts',"]]],

  ['MUT-P7 모르는 제품이 fallback으로 지원 제품이 된다', REG, 'RED',
   [["  const p = readProductId(product);\n  if (!p) {\n    return {\n      state: 'LOCKED', missing: [...AXES], paper: false, live: false,\n      reason: `모르는 제품입니다 (${String(product ?? '없음')})`,\n    };\n  }",
     "  const p = readProductId(product) || 'SPOT_CRYPTO';"]]],

  // ── 근거·경계 ──

  ['MUT-P8 근거를 없는 파일로 바꾼다 (사람이 확인할 수 없다)', REG, 'RED',
   [["'src/app/api/onchain/route.ts:44'", "'src/app/api/onchain/NOPE.ts:44'"]]],

  ['MUT-P9 근거 줄을 파일 밖으로 민다', REG, 'RED',
   [["'src/lib/engine/paperPriceSource.ts:44'", "'src/lib/engine/paperPriceSource.ts:999999'"]]],

  ['MUT-P10 모르는 축을 지원으로 떨어뜨린다', REG, 'RED',
   [['  if (!(AXES as readonly string[]).includes(axis)) {',
     '  if (false) {']]],

  ['MUT-P11 규격을 필수 축에 넣는다 (되는 거래까지 잠긴다)', REG, 'RED',
   [["  ['MARKET_DATA', 'EXECUTION', 'ACCOUNT', 'HOLDINGS', 'UI_WIRING'] as const;",
     "  ['MARKET_DATA', 'EXECUTION', 'ACCOUNT', 'HOLDINGS', 'UI_WIRING', 'PRECISION'] as const;"]]],

  ['MUT-P12 장부가 하나도 없어도 연다', REG, 'RED',
   [['  if (!paper && !live) {', '  if (false) {']]],

  ['MUT-P13 주문 기능 능력표가 제품 이름을 들고 온다 (경계 붕괴)', CAP, 'RED',
   [["export type OrderFeature =", "export type ProductName = 'OPTIONS' | 'CONVERT';\nexport type OrderFeature ="]]],

  // ── 대조군 (GREEN이어야 한다) ──
  ['OK-P1 정본에 주석 한 줄 추가', REG, 'GREEN',
   [['export type ProductId =', '// 대조군\nexport type ProductId =']]],
  ['OK-P2 검사기에 주석 한 줄 추가', CHECK, 'GREEN',
   [["const REG = 'src/lib/products/registry.ts';",
     "// 대조군\nconst REG = 'src/lib/products/registry.ts';"]]],
];

const selected = ONLY.length ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;
console.log(`게이트: 제품 능력 검사기 + 전체 시험\n총 ${selected.length}건\n`);

let detected = 0, missed = 0, noop = 0, greenOk = 0, greenBad = 0;

for (const [name, file, kind, cuts] of selected) {
  if (!existsSync(file)) { console.log(`  ⚠  ${name} — 파일이 없습니다`); noop += 1; continue; }
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [from, to] of cuts) {
    if (!after.includes(from)) {
      console.log(`  ⚠  ${name} — 대상 문구를 찾지 못했습니다`);
      after = before;
      break;
    }
    // ★ 함수로 넘긴다. 문자열 치환은 `$'`를 "매치 뒤 전체"로 해석한다 —
    //   이 저장소에서 그 함정에 한 번 걸려 뮤테이션이 조용히 무의미해졌다.
    after = after.replace(from, () => to);
  }
  if (after === before) { noop += 1; continue; }

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
process.exit(missed > 0 || greenBad > 0 ? 1 : 0);
