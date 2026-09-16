#!/usr/bin/env node
// scripts/check-paper-price-source.mjs
//
// **진입과 청산이 같은 시장의 가격을 쓰는지 배선으로 확인한다.**
//
// 무엇이 고장이었나
// ─────────────────
// 진입(`/api/paper/order`)은 `if (spot) 현물 else 선물`로 출처를 갈랐는데,
// 청산(`/api/paper/close`)에는 그 분기가 **아예 없었다.** `pos.market`을 한
// 번도 읽지 않고 언제나 `getPremiumIndex`(선물)를 불렀다. 그래서 현물로 산
// 포지션이 선물 마크가로 닫혔다 — 같은 포지션의 가격 권위가 앞뒤로 달랐다.
//
// 시험으로는 부족하다
// ───────────────────
// 라우트는 네트워크를 타므로 단위 시험이 실행하지 못한다. 그리고 두
// 출처의 값은 대개 비슷해서 **결과 숫자만 보면 구별되지 않는다.** 어느
// 문을 두드렸는지는 코드의 모양으로 봐야 한다.
//
// 무엇을 보는가
// ─────────────
//   ① 두 라우트 **누구도** 가격 출처를 직접 부르지 않는다
//   ② 두 라우트 **모두** `readPaperMarkPrice`를 부른다
//   ③ 청산이 `pos.market`을 읽어 넘긴다 (안 읽으면 고장이 그대로다)
//   ④ 모르는 시장이 USDM으로 흘러가지 않는다 (fail-closed)
//   ⑤ 청산가가 요청에서 오지 않는다
//   ⑥ 출처 표에서 현물과 선물이 **다른** 출처를 쓴다
//   ⑦ `readPaperMarkPrice`가 출처를 인자로 받지 않는다
import { readFileSync } from 'node:fs';

const ORDER  = 'src/app/api/paper/order/route.ts';
const CLOSE  = 'src/app/api/paper/close/route.ts';
const SOURCE = 'src/lib/engine/paperPriceSource.ts';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  try { return readFileSync(p, 'utf8'); }
  catch { err(`${p}를 읽지 못했습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
};
/** 주석을 뺀 본문. 규칙을 주석으로 만족시키지 못하게 한다. */
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const order = code(read(ORDER));
const close = code(read(CLOSE));
const src   = code(read(SOURCE));

// ── ① 라우트가 가격 출처를 직접 부르지 않는다 ──
//
// 한 곳이라도 직접 부르기 시작하면 그 자리가 곧 두 번째 규칙이 되고,
// 언젠가 한쪽만 고쳐진다.
for (const [name, body] of [[ORDER, order], [CLOSE, close]]) {
  for (const fn of ['getPremiumIndex', 'fetchSpotPriceMap', 'premiumIndex', 'ticker/price']) {
    if (body.includes(fn)) {
      err(`${name}이 가격 출처를 직접 부릅니다 (${fn})`
        + ' — 시장별 출처는 paperPriceSource 한 곳에만 있어야 합니다');
    }
  }
}

// ── ② 둘 다 같은 함수를 부른다 ──
for (const [name, body] of [[ORDER, order], [CLOSE, close]]) {
  if (!/readPaperMarkPrice\(/.test(body)) {
    err(`${name}이 readPaperMarkPrice를 부르지 않습니다 — 진입과 청산이 갈립니다`);
  }
}

// ── ③ 청산이 포지션의 시장을 읽어 넘긴다 ──
if (!/\.select\('[^']*\bmarket\b[^']*'\)/.test(close)) {
  err(`${CLOSE}가 포지션의 market 칸을 읽지 않습니다 — 이 칸을 안 읽어서 현물이 선물 가격으로 닫혔습니다`);
}
if (!/readPaperMarkPrice\(\s*pos\.market\s*,/.test(close)) {
  err(`${CLOSE}가 readPaperMarkPrice에 pos.market을 넘기지 않습니다`);
}
// 진입은 요청이 검증한 market을 넘긴다
if (!/readPaperMarkPrice\(\s*market\s*,/.test(order)) {
  err(`${ORDER}가 readPaperMarkPrice에 market을 넘기지 않습니다`);
}

// ── ④ fail closed ──
if (!/UNSUPPORTED_MARKET/.test(close)) {
  err(`${CLOSE}가 모르는 시장을 따로 거부하지 않습니다 — 선물로 흘려보내면 고장이 이름만 바꿔 돌아옵니다`);
}
// 진입 라우트의 `body?.market || 'USDM'`은 **미지정 시 기본값**이고,
// 바로 다음 줄이 모르는 값을 거부한다. 그 둘이 붙어 있어야 안전하므로
// 폴백을 금지하는 대신 **거부가 실재하는지**를 본다.
if (!/market !== 'SPOT' && market !== 'USDM'/.test(order)) {
  err(`${ORDER}가 모르는 시장을 거부하지 않습니다 — 기본값만 있고 검증이 없으면 오타가 전부 선물이 됩니다`);
}
// 청산 쪽에는 기본값이 있어서는 안 된다. 포지션에 이미 적힌 시장을
// 그대로 써야 하고, 못 읽었으면 멈춰야 한다.
if (/\|\|\s*['"]USDM['"]/.test(close) || /\?\?\s*['"]USDM['"]/.test(close)
    || /readPaperMarkPrice\([^)]*\)\s*\|\|/.test(close)) {
  err(`${CLOSE}에 시장 폴백이 있습니다 — 포지션에 적힌 시장을 그대로 써야 합니다`);
}
if (/\|\|\s*['"]USDM['"]/.test(src) || /\?\?\s*['"]USDM['"]/.test(src)) {
  err(`${SOURCE}에 기본 시장 폴백이 있습니다 — 빈 값과 오타가 전부 선물이 됩니다`);
}

// ── ⑤ 청산가는 요청에서 오지 않는다 ──
for (const [name, body] of [[ORDER, order], [CLOSE, close]]) {
  if (/(body|searchParams|params)[^\n]{0,60}(exitPrice|exit_price|markPrice|mark_price|fillPrice)/i.test(body)) {
    err(`${name}이 요청에서 체결·청산 가격을 읽습니다 — 유리한 값으로 장부를 만들 수 있습니다`);
  }
}

// ── ⑥⑦ 출처 표 자체 ──
if (!/'SPOT'\s*\)\s*return\s*'BINANCE_SPOT_TICKER'/.test(src)) {
  err(`${SOURCE}에서 현물이 현물 출처로 가지 않습니다`);
}
if (!/'USDM'\s*\)\s*return\s*'BINANCE_USDM_MARK'/.test(src)) {
  err(`${SOURCE}에서 선물이 선물 출처로 가지 않습니다`);
}
{
  // 두 시장이 같은 출처로 접히면 고장이 그대로 돌아온다
  const spot = /'SPOT'\s*\)\s*return\s*'([A-Z_]+)'/.exec(src);
  const usdm = /'USDM'\s*\)\s*return\s*'([A-Z_]+)'/.exec(src);
  if (spot && usdm && spot[1] === usdm[1]) {
    err(`${SOURCE}에서 현물과 선물이 같은 출처(${spot[1]})를 씁니다`);
  }
}
if (!/export async function readPaperMarkPrice\(\s*\n?\s*rawMarket: any, symbol: string,?\s*\n?\)/.test(src)) {
  err(`${SOURCE}의 readPaperMarkPrice가 (market, symbol) 두 인자가 아닙니다`
    + ' — 출처를 인자로 받으면 부르는 쪽이 현물에 선물 출처를 넘길 수 있습니다');
}

// ── 폐기한 경로가 되살아나지 않았는가 ──
{
  const pos = read('src/app/api/paper/positions/route.ts');
  if (/export async function POST\(req/.test(code(pos))) {
    err('인증 없이 청산가를 받던 POST /api/paper/positions가 되살아났습니다');
  }
}

if (bad > 0) {
  console.error(`\n모의 가격 출처 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ 모의 가격 출처 — 진입·청산이 같은 함수 · 시장별 출처 분리 ·'
  + ' pos.market 반영 · 모르는 시장 fail-closed · 요청 가격 비수신');
