#!/usr/bin/env node
// scripts/check-gate-spot-precision.mjs
//
// **Gate 현물의 네 축이 서로 섞이지 않는지, 그리고 맞춘 가격이 실제로
// 거래소 본문에 들어가는지 본다 (Phase 4B-2B-1).**
//
// Gate가 종목마다 주는 규격은 넷이고 의미가 전부 다르다:
//
//   amount_precision   수량 자릿수      min_base_amount   최소 주문 수량
//   precision          가격 자릿수      min_quote_amount  최소 주문 금액
//
// 바이낸스는 수량 격자를 **증분**(stepSize)으로 주고 Gate는 **자릿수**로
// 준다. 같은 뜻이 아니라 변환 관계이고, 10의 거듭제곱이 아닌 증분은
// 자릿수로 표현할 수조차 없다. 두 표현을 섞는 순간 한쪽 종목에서 조용히
// 틀린 값이 나간다.
//
// 값이 맞는지는 시험이 본다. 여기서 보는 것은 **배선**이다 — 정본을
// 부르는가, 그 결과가 POST 본문에 들어가는가, 섞이면 안 되는 것이
// 섞이지 않았는가.
import { readFileSync, existsSync } from 'node:fs';

const PREC = 'src/lib/exchanges/gateSpotPrecision.ts';
const PLAN = 'src/lib/exchanges/gateSpotPlan.ts';
const API  = 'src/lib/exchanges/gateSpot.ts';
const EXEC = 'src/lib/exchanges/spotOrderExecutor.ts';
const REG  = 'src/lib/products/registry.ts';

let bad = 0;
const fail = (m) => { console.error(`  ✗ ${m}`); bad += 1; };
const read = (p) => {
  if (!existsSync(p)) { fail(`${p}가 없습니다`); return ''; }
  return readFileSync(p, 'utf8');
};
/**
 * 주석은 규율이 아니다.
 *
 * `://`를 주석으로 읽지 않는다 — 블록 주석을 먼저 지우고, 줄 주석은
 * 앞 글자가 `:`가 아닐 때만 자른다. (같은 함정을 현물 검사기에서 한 번
 * 겪었다: URL이 있는 줄이 통째로 사라져 하드코딩 호스트를 못 잡았다.)
 */
const stripTs = (s) => String(s)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:\\])\/\/[^\n]*/gm, '$1 ');

/** `marker`(필요하면 `after`) 뒤의 첫 블록을 짝이 맞는 `}`까지 */
function blockAfter(src, marker, after) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  let from = at;
  if (after) {
    const a = src.indexOf(after, at);
    if (a < 0) return null;
    from = a;
  }
  let i = src.indexOf('{', from);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return null;
}

const prec = stripTs(read(PREC));
const plan = stripTs(read(PLAN));
const api  = stripTs(read(API));
const exec = stripTs(read(EXEC));
const reg  = stripTs(read(REG));

// ══════════════ ① 가격 자릿수를 거래소에서 읽는다 ══════════════
{
  if (!/pricePrecision:\s*n\(d\.precision\)/.test(api)) {
    fail(`${API}: Gate의 가격 자릿수(precision)를 읽지 않습니다`);
  }
  // ★ **수량 자릿수로 가격 자릿수를 채우지 않는다.** Gate는 두 필드를
  //   따로 주고, 한쪽으로 다른 쪽을 대신하면 가격이 수량 자릿수로 깎인다.
  if (/pricePrecision:[^,\n]*amount_precision/.test(api)
   || /amountPrecision:[^,\n]*d\.precision/.test(api)) {
    fail(`${API}: ★ 수량 자릿수와 가격 자릿수를 서로 대신 쓰고 있습니다`);
  }
  // 네 축이 각각 계획으로 넘어가는가
  for (const f of ['amountPrecision', 'pricePrecision', 'minBaseAmount', 'minQuoteAmount']) {
    if (!new RegExp(`${f}:\\s*input\\.${f}\\s*\\?\\?\\s*info\\?\\.${f}`).test(api)) {
      fail(`${API}: ${f}를 계획으로 넘기지 않습니다`);
    }
  }
}

// ══════════════ ② 자릿수 해석은 한 곳에서만 ══════════════
{
  const d = blockAfter(prec, 'export function gatePriceDecimals');
  if (!d) fail(`${PREC}: gatePriceDecimals를 찾지 못했습니다`);
  else {
    // ★ `Number(null) === 0`이고 0은 "정수 호가"라는 뜻이 있는 값이다.
    //   숫자로 바꾸기 **전에** 비어 있는지 봐야 한다.
    if (!/precision == null/.test(d)) {
      fail(`${PREC}: ★ 빈 값을 숫자로 바꾸기 전에 거르지 않습니다 — `
         + `Number(null)===0이라 모르는 규격이 '정수 호가'가 됩니다`);
    }
    if (!/return null/.test(d)) fail(`${PREC}: 모르는 자릿수가 null로 떨어지지 않습니다`);
  }

  const r = blockAfter(prec, 'export function roundGatePrice');
  if (!r) fail(`${PREC}: roundGatePrice를 찾지 못했습니다`);
  else {
    if (!/gatePriceDecimals\(/.test(r)) {
      fail(`${PREC}: 자릿수 해석을 정본으로 하지 않습니다`);
    }
    // 못 읽었으면 맞췄다고 적지 않는다
    if (!/applied:\s*false,\s*skipped:\s*'METADATA_UNKNOWN'/.test(r)) {
      fail(`${PREC}: 규격을 못 읽은 것을 적용했다고 적습니다`);
    }
    // 임의 기본값 금지 — 못 읽었을 때 숫자를 만들어 내면 안 된다
    if (/gatePriceDecimals\([^)]*\)\s*(\?\?|\|\|)\s*\d/.test(r)) {
      fail(`${PREC}: 자릿수에 기본값을 지어냅니다`);
    }
  }

  // 자릿수 해석이 이 파일 밖에 또 있으면 두 벌이 된다
  for (const [f, src] of [[PLAN, plan], [API, api], [EXEC, exec]]) {
    if (/Math\.pow\(10\s*,\s*-/.test(src)) {
      fail(`${f}: 자릿수→증분 변환이 정본 밖에 있습니다`);
    }
  }
}

// ══════════════ ③ ★ 정규화된 가격이 실제 POST 본문에 들어간다 ══════════════
//
// 정본을 부르고도 본문에 원값을 다시 넣으면 아무것도 안 한 것과 같다.
{
  if (!/roundGatePrice\(/.test(plan)) {
    fail(`${PLAN}: 지정가를 Gate 가격 자릿수에 맞추지 않습니다`);
  }
  const limit = plan.match(/const r = roundGatePrice\([\s\S]{0,2000}?time_in_force = 'gtc';/);
  if (!limit) fail(`${PLAN}: 지정가 갈래를 찾지 못했습니다`);
  else {
    if (!/body\.price = String\(sentPrice\)/.test(limit[0])) {
      fail(`${PLAN}: ★ 맞춘 가격이 아니라 다른 값을 본문에 넣습니다`);
    }
    if (/body\.price = String\(price\)/.test(limit[0])) {
      fail(`${PLAN}: ★ 정규화 전 가격을 본문에 다시 넣습니다 (우회)`);
    }
  }
  // 본문에 원값을 넣는 자리가 파일 어디에도 남아 있으면 안 된다
  if (/body\.price\s*=\s*String\(\s*price\s*\)/.test(plan)) {
    fail(`${PLAN}: 정규화 전 가격을 본문에 넣는 자리가 남아 있습니다`);
  }
  if (!/sentPrice/.test(plan)) fail(`${PLAN}: 보낼 가격을 따로 들고 있지 않습니다`);
}

// ══════════════ ④ 규격을 못 읽으면 진입은 보내지 않는다 ══════════════
//
// **못 사는 것은 불편이고 못 파는 것은 사고다.** 신규 매수는 막고 매도는
// 보내되, 맞췄다고 적지 않는다.
{
  const blk = plan.match(/if \(!r\.applied\)[\s\S]{0,900}?\n    \} else \{/);
  if (!blk) fail(`${PLAN}: 규격 미상 갈래를 찾지 못했습니다`);
  else {
    if (!/if \(!i\.isExit\)[\s\S]{0,300}?return bad\(/.test(blk[0])) {
      fail(`${PLAN}: ★ 가격 자릿수를 못 읽었는데 신규 진입을 그대로 보냅니다`);
    }
    if (!/priceApplied = false/.test(blk[0])) {
      fail(`${PLAN}: 조회 실패를 적용했다고 기록합니다`);
    }
  }
  // 매도가 이 갈래로 오려면 실행부가 청산 여부를 넘겨야 한다
  if (!/isExit:\s*ctx\.side === 'SELL'/.test(exec)) {
    fail(`${EXEC}: Gate 현물 매도를 청산으로 넘기지 않습니다 — 못 파는 상태가 생깁니다`);
  }
}

// ══════════════ ⑤ 네 축을 뭉개지 않는다 ══════════════
{
  // 금액 주문에 수량 자릿수를 대지 않는가
  const byQuote = plan.match(/const byQuote[\s\S]{0,1400}?\n  \}/);
  if (!byQuote) fail(`${PLAN}: 금액 기반 매수 갈래를 찾지 못했습니다`);
  else {
    if (/floorTo\(|roundGatePrice\(/.test(byQuote[0])) {
      fail(`${PLAN}: ★ 금액(quote)에 수량·가격 정규화를 걸었습니다 — 단위가 다릅니다`);
    }
    if (!/NOT_IN_ORDER/.test(byQuote[0])) {
      fail(`${PLAN}: 금액 주문에 없는 축을 '못 읽음'과 구별하지 않습니다`);
    }
  }
  // 기존 수량 내림이 살아 있는가 (2B-1은 수량 축을 건드리지 않는다)
  if (!/floorTo\(rawQty,\s*i\.amountPrecision\)/.test(plan)) {
    fail(`${PLAN}: 기존 수량 자릿수 내림이 사라졌습니다`);
  }
  // 최소 수량과 최소 금액이 각각 따로 쓰이는가
  if (!/i\.minQuoteAmount != null/.test(plan)) fail(`${PLAN}: 최소 주문 금액을 보지 않습니다`);
  if (!/i\.minBaseAmount != null/.test(plan))  fail(`${PLAN}: 최소 주문 수량을 보지 않습니다`);

  // 기록도 축마다 따로 있는가
  for (const f of ['quantityApplied', 'quantitySkipped', 'priceApplied', 'priceSkipped']) {
    if (!prec.includes(f)) fail(`${PREC}: ${f} 축이 없습니다`);
    if (!plan.includes(f)) fail(`${PLAN}: ${f}를 기록하지 않습니다`);
  }
}

// ══════════════ ⑥ 맞췄는지가 밖으로 나간다 ══════════════
{
  if (!/precision:\s*plan\.precision/.test(api)) {
    fail(`${API}: 규격 적용 결과를 결과에 담지 않습니다`);
  }
  if (!/venuePrecision:\s*r\.precision/.test(exec)) {
    fail(`${EXEC}: Gate 주문의 규격 적용 결과가 호출자에게 가지 않습니다`);
  }
}

// ══════════════ ⑦ registry는 실행 경로까지 증명된 것만 올린다 ══════════════
{
  const row = reg.match(/venue:\s*'GATE_SPOT',\s*verdict:\s*'([A-Z_]+)',\s*evidence:\s*'([^']+)'/);
  if (!row) fail(`${REG}: GATE_SPOT 판정을 찾지 못했습니다`);
  else {
    const [, verdict, evidence] = row;
    if (verdict === 'SUPPORTED') {
      // metadata를 읽는 것만으로는 부족하다 — 본문까지 들어가야 한다
      const f = evidence.split(':')[0];
      const c = existsSync(f) ? stripTs(readFileSync(f, 'utf8')) : '';
      if (!/body\.price = String\(sentPrice\)/.test(c)) {
        fail(`${REG}: GATE_SPOT을 SUPPORTED로 적었는데 근거 파일이 맞춘 가격을 `
           + `본문에 넣는 것을 보이지 않습니다 (${f})`);
      }
      // 읽지 않는 축이 남아 있으면 SUPPORTED가 아니다
      if (!/max_base_amount|maxBaseAmount/.test(api)) {
        fail(`${REG}: ★ 최대 주문 수량·금액을 읽지 않는데 GATE_SPOT이 SUPPORTED입니다`);
      }
    }
    if (!existsSync(evidence.split(':')[0])) {
      fail(`${REG}: GATE_SPOT 근거 파일이 없습니다 (${evidence})`);
    }
  }
}

if (bad > 0) {
  console.error(`\nGate 현물 규격 검사 실패 ${bad}건`);
  process.exit(1);
}
console.log('Gate 현물 규격 검사 통과 — 네 축 분리 · 가격 자릿수 정본 · '
  + '본문 반영 · 진입 fail-closed · 기록 전달 · registry 근거');
