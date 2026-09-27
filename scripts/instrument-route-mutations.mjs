#!/usr/bin/env node
// scripts/instrument-route-mutations.mjs
//
// **심볼 정규화를 하나씩 무너뜨리고, 시험이 빨개지는지 본다.**
//
// 왜 이 스위트가 따로 있는가
// ──────────────────────────
// 이 고장은 **검사기로는 안 잡힌다.** 소스 검사기는 "helper가 있는가",
// "이름이 맞는가"를 볼 뿐이고, 여기서 틀리는 것은 **나오는 값**이다:
//
//     BTC → BTC       (BTCUSDT여야 한다)
//     ETH → ETH
//
// 예외도 안 나고 화면도 멀쩡하다. 그 심볼이 차트·호가·봉 조회로 흘러가서
// "거래가 없는 종목"처럼 보일 뿐이다. 그래서 방어선은 **입출력 시험**이고,
// 이 스위트는 그 시험이 정말 방어하고 있는지를 확인한다.
//
// 게이트는 `npm test` 하나다 — 이 고장을 잡을 수 있는 것이 그것뿐이다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SRC = 'src/lib/markets/instrumentRoute.ts';

const ONLY = process.argv.slice(2);

function gate() {
  const r = spawnSync('npm', ['test'], { encoding: 'utf8' });
  return { red: r.status !== 0 };
}

const CASES = [
  // ★ 원래 고장 그대로 — 이것이 실기에서 났다
  ['MUT-IR1 결제통화로 끝나기만 하면 완성 쌍으로 본다 (BTC → BTC · ETH → ETH)', 'RED',
   [[`  return QUOTES.some(q => s.length > q.length && s.endsWith(q));`,
     `  return QUOTES.some(q => s.endsWith(q));`]]],

  ['MUT-IR2 결제통화 목록에서 BTC·ETH를 뺀다 (ETHBTC → ETHBTCUSDT)', 'RED',
   [[`const QUOTES = ['USDT', 'USDC', 'BUSD', 'BTC', 'ETH'] as const;`,
     `const QUOTES = ['USDT', 'USDC', 'BUSD'] as const;`]]],

  ['MUT-IR3 아무것도 완성으로 보지 않는다 (BTCUSDT → BTCUSDTUSDT)', 'RED',
   [[`  return QUOTES.some(q => s.length > q.length && s.endsWith(q));`,
     `  return false;`]]],

  ['MUT-IR4 전부 완성으로 본다 (BTC → BTC · SOL → SOL)', 'RED',
   [[`  return QUOTES.some(q => s.length > q.length && s.endsWith(q));`,
     `  return true;`]]],

  ['MUT-IR5 양끝 공백을 떼지 않는다 (공백만 있는 값이 "   USDT"가 된다)', 'RED',
   [[`String(asset.symbol ?? asset.id ?? '').trim().toUpperCase()`,
     `String(asset.symbol ?? asset.id ?? '').toUpperCase()`]]],

  ['MUT-IR6 목록에서 들어온 길을 선물로 적는다 (현물 종목이 선물로 열린다)', 'RED',
   [[`    market: 'SPOT',`, `    market: 'USDM',`]]],

  // 대조군 — "무엇을 해도 빨개지는" 시험이 만점을 받지 않게 한다
  ['OK-IR1 주석 한 줄 추가', 'GREEN',
   [[`export function isCompletePair(raw: string): boolean {`,
     `// 대조군\nexport function isCompletePair(raw: string): boolean {`]]],
];

const selected = ONLY.length ? CASES.filter(c => ONLY.some(o => c[0].includes(o))) : CASES;
console.log(`게이트: 전체 시험 (npm test)\n총 ${selected.length}건\n`);

let detected = 0, missed = 0, noop = 0, greenOk = 0, greenBad = 0;

if (!existsSync(SRC)) {
  console.error(`❌ ${SRC}를 찾지 못했습니다`);
  process.exit(1);
}

for (const [name, kind, cuts] of selected) {
  const before = readFileSync(SRC, 'utf8');
  let after = before, missing = false;
  for (const [from, to] of cuts) {
    if (!after.includes(from)) { missing = true; break; }
    after = after.replace(from, () => to);
  }
  if (missing || after === before) {
    console.log(`  ⚠  ${name} — 대상 문구를 찾지 못했습니다`);
    noop += 1; continue;
  }

  writeFileSync(SRC, after);
  let res;
  try { res = gate(); } finally { writeFileSync(SRC, before); }

  if (kind === 'RED') {
    if (res.red) { console.log(`  ●  ${name} — RED (검출)`); detected += 1; }
    else { console.log(`  ✗  ${name} — GREEN (새 나감)`); missed += 1; }
  } else {
    if (!res.red) { console.log(`  ✓  ${name} — PASS (과도 검출 없음)`); greenOk += 1; }
    else { console.log(`  ✗  ${name} — RED (과도 검출)`); greenBad += 1; }
  }
}

console.log(`\n검출 ${detected} / 누락 ${missed} / 판정불가 ${noop}`
  + ` / 대조군 PASS ${greenOk} · 과도검출 ${greenBad}`);
process.exit(missed > 0 || greenBad > 0 || noop > 0 ? 1 : 0);
