#!/usr/bin/env node
// scripts/check-spot-precision.mjs
//
// **바이낸스 현물 실계좌 주문이 격자를 실제로 지나는지 본다 (Phase 4B-2A).**
//
// 왜 시험으로 부족한가
// ────────────────────
// `normalizeForVenue`가 옳게 계산한다는 것은 `spotPrecision.test.ts`가
// 고정한다. 그런데 이 저장소에서 가장 자주 난 고장은 계산이 틀린 것이
// 아니라 **만들어 놓고 배선을 안 한 것**이다 — 4B-1도 응답에 `applied:
// false`를 실어 놓고 화면 훅이 그 문장을 버리고 있었다.
//
// 그래서 여기서는 값이 아니라 **배선**을 본다: 정본을 부르는가, 그 결과를
// 실제로 거래소에 보내는가, 부르면 안 되는 자리에서 부르지 않는가.
//
// ★ 가장 중요한 규칙은 ②다
// ────────────────────────
// 금액 기반 시장가 매수(`quoteOrderQty`)에는 **수량이라는 값이 없다.**
// 거기에 수량 정규화를 끼우면 `Number(null) === 0`이 되어 지금 정상
// 동작하는 매수가 전부 막힌다. 이 경계가 4B-2A의 핵심이다.
import { readFileSync, existsSync } from 'node:fs';

const EXEC  = 'src/lib/exchanges/spotOrderExecutor.ts';
const ROUTE = 'src/app/api/binance/spot/order/route.ts';
const BN    = 'src/lib/exchanges/binance.ts';
const PLAN  = 'src/app/api/strategies/spot/plan/route.ts';
const FORM  = 'src/lib/trading/useTradeForm.ts';
const REG   = 'src/lib/products/registry.ts';
const STATE = 'src/lib/exchanges/spotPrecisionState.ts';

let bad = 0;
const fail = (m) => { console.error(`  ✗ ${m}`); bad += 1; };
const read = (p) => {
  if (!existsSync(p)) { fail(`${p}가 없습니다`); return ''; }
  return readFileSync(p, 'utf8');
};
/**
 * 주석은 규율이 아니다. 주석에 적힌 낱말로 검사가 통과하면 안 된다.
 *
 * ★ **`://`를 주석으로 읽지 않는다.**
 *
 *   원래는 `//`를 무조건 잘랐다. 그런데 `https://api.binance.com/...`의
 *   `//`가 걸려서 **URL이 있는 줄이 통째로 사라졌다.** 그래서 "실전 호스트를
 *   하드코딩했다"를 잡는 규칙 앞에서, 하드코딩한 그 줄만 안 보였다 —
 *   검사기가 자기가 잡아야 할 것을 스스로 지우고 있었다(MUT-S22가 이것을
 *   짚었다).
 *
 *   블록 주석을 **먼저** 지운다. 그래야 문서 주석 안의 URL이 코드로
 *   남지 않는다.
 */
const stripTs = (s) => String(s)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:\\])\/\/[^\n]*/gm, '$1 ');

const exec  = stripTs(read(EXEC));
const route = stripTs(read(ROUTE));
const bn    = stripTs(read(BN));
const plan  = stripTs(read(PLAN));
const form  = stripTs(read(FORM));
const reg   = stripTs(read(REG));
const state = stripTs(read(STATE));

/**
 * `marker` 뒤의 첫 블록을 짝이 맞는 `}`까지 잘라 준다.
 *
 * ★ **`after`를 왜 받는가**
 *
 *   여러 줄 시그니처에서는 첫 `{`가 본문이 아니다. `placeGateSpot(sb, args,
 *   ctx: { ... })`의 첫 `{`는 **ctx의 타입 리터럴**이라, 그것만 잘라 놓고
 *   "함수 본문을 봤다"고 착각하게 된다. 실제로 그 바람에 Gate 갈래에 격자를
 *   얹는 변경이 두 번 그대로 통과했다(MUT-S28).
 *
 *   그래서 본문 여는 괄호를 특정할 수 있는 표식을 따로 받는다.
 */
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

// ══════════════ ① 실행부가 정본을 부른다 ══════════════
//
// 정규화를 여기서 새로 쓰면 같은 주문이 경로에 따라 다른 수량으로 나간다.
{
  if (!/normalizeForVenue\(/.test(exec)) {
    fail(`${EXEC}: 현물 실계좌 주문이 거래소 격자를 거치지 않습니다`);
  }
  if (!/fetchVenueSpec\(\s*'BINANCE_SPOT'/.test(exec)) {
    fail(`${EXEC}: 바이낸스 현물 규격을 읽지 않습니다`);
  }
  // 규격 조회에 testnet이 실리는가. 실전 규격으로 테스트넷 주문을 맞추면
  // 확인한 적 없는 것을 확인했다고 적는 셈이다.
  if (!/fetchVenueSpec\(\s*'BINANCE_SPOT'\s*,\s*symbol\s*,\s*testnet\s*\)/.test(exec)) {
    fail(`${EXEC}: 규격 조회가 이 연결의 망(testnet)을 따르지 않습니다`);
  }
}

// ══════════════ ② ★ 금액 기반 매수에는 수량 격자를 대지 않는다 ══════════════
{
  const quote = blockAfter(exec, 'if (byQuote)');
  if (!quote) {
    fail(`${EXEC}: 금액 기반 매수 갈래를 찾지 못했습니다`);
  } else {
    // ★ **호출 모양이 아니라 이름을 본다.**
    //
    //   `const { normalizeForVenue: _nv } = ...` 로 별칭을 주고 `_nv(`로
    //   부르면 `normalizeForVenue(`는 어디에도 안 보인다. 이 갈래에 그
    //   이름들이 **나타날 이유가 없으므로** 이름 자체를 금지한다.
    if (/normalizeForVenue|quantizeOrder|roundSpotQty/.test(quote)) {
      fail(`${EXEC}: ★ 금액 기반 시장가 매수에 수량 정규화를 걸었습니다 — `
         + `quoteOrderQty에는 수량이 없어 Number(null)===0으로 전부 막힙니다`);
    }
    // 그 사실이 값으로 남는가. 사유는 정본(`spotPrecisionState`)이 정한다 —
    // 여기서 직접 적으면 판정이 두 곳이 된다.
    if (!/precisionSkipOf\(\{\s*byQuote:\s*true/.test(quote)) {
      fail(`${EXEC}: 금액 기반 매수가 왜 격자를 안 탔는지 정본으로 판정하지 않습니다`);
    }
    // ★ **기록의 칸을 본다, 인자가 아니라.**
    //
    //   처음에는 갈래 안에서 `applied: false`를 찾았다. 그런데 그 문구가
    //   `precisionSkipOf({ byQuote: true, applied: false, ... })` **인자에도**
    //   있어서, 기록을 `applied: true`로 뒤집는 변경이 그대로 통과했다
    //   (MUT-S3). venue 칸에 붙여 기록만 겨냥한다.
    if (!/venue:\s*'BINANCE_SPOT',\s*applied:\s*false/.test(quote)) {
      fail(`${EXEC}: 금액 기반 매수가 맞췄다고 적혀 있습니다`);
    }
  }
}

// ══════════════ ②-b ★ "왜 안 맞췄는가"를 하나로 뭉개지 않는다 ══════════════
//
// 4B-2A가 실제로 내보내던 모순이 여기에 있었다:
//
//     skipped: applied ? null : 'SPEC_UNKNOWN'
//
// `applied: false`가 되는 길은 하나가 아니다. 규격을 **못 읽은 것**과,
// 규격은 읽었는데 **이 주문유형의 격자만 없는 것**은 다른 사실이다. 뒤엣것을
// 앞엣것으로 적으면 `source: 'EXCHANGE'`인데 사유는 "규격 미상"인 응답이
// 나간다 — 구별하려고 만든 필드가 구별을 없앤다.
{
  // 실행부가 사유를 직접 적으면 판정이 두 곳이 된다
  if (/skipped:\s*[^,\n]*\?[^,\n]*:\s*'SPEC_UNKNOWN'/.test(exec)) {
    fail(`${EXEC}: ★ 격자 미적용 사유를 삼항 하나로 뭉갰습니다 — `
       + `못 읽은 것과 이 유형의 격자가 없는 것이 같은 값이 됩니다`);
  }
  if (/skipped:\s*'/.test(exec)) {
    fail(`${EXEC}: 사유를 실행부가 직접 적습니다 — precisionSkipOf가 정본입니다`);
  }
  if (!/precisionSkipOf\(/.test(exec)) {
    fail(`${EXEC}: 격자 미적용 사유를 정본으로 판정하지 않습니다`);
  }

  // 정본이 네 상태를 실제로 구별하는가
  for (const k of ['QUOTE_ORDER', 'SPEC_UNKNOWN', 'ORDER_TYPE_GRID_UNKNOWN', 'INVALID_INPUT']) {
    if (!state.includes(`'${k}'`)) fail(`${STATE}: ${k} 상태가 없습니다`);
  }
  const fn = blockAfter(state, 'export function precisionSkipOf');
  if (!fn) fail(`${STATE}: precisionSkipOf를 찾지 못했습니다`);
  else {
    // ★ **순서가 의미를 만든다.** `code`를 `source`보다 먼저 봐야, 입력이
    //   틀린 것이 규격 조회 장애로 적히지 않는다.
    const iCode = fn.search(/code\s*===/);
    const iSrc  = fn.search(/source\s*===/);
    if (iCode < 0 || iSrc < 0) {
      fail(`${STATE}: 사유 판정이 code와 source를 모두 보지 않습니다`);
    } else if (iCode > iSrc) {
      fail(`${STATE}: ★ source를 code보다 먼저 봅니다 — 입력 오류가 규격 장애로 적힙니다`);
    }
    // 읽은 격자를 '못 읽음'으로 떨어뜨리지 않는가 (마지막 반환이 분리 상태여야 한다)
    if (!/return 'ORDER_TYPE_GRID_UNKNOWN'/.test(fn)) {
      fail(`${STATE}: 규격은 읽었는데 유형 격자만 없는 경우가 따로 나오지 않습니다`);
    }
  }
  // 모순 판정이 있어야 시험이 모순을 고정할 수 있다
  if (!/export function precisionStateConsistent/.test(state)) {
    fail(`${STATE}: 값들이 서로 모순되는지 판정하는 함수가 없습니다`);
  }
}

// ══════════════ ③ 매도는 EXIT다 ══════════════
//
// 규격을 못 읽었다고 **팔지 못하게** 만들지 않는다. 못 사는 것은 불편이고
// 못 파는 것은 사고다. 리터럴 `false`를 박으면 그 정책이 사라진다.
{
  // ★ **`norm`이 정본 호출의 결과 그 자체여야 한다.**
  //
  //   처음에는 파일 어디든 `normalizeForVenue({...})` 모양만 찾았다. 그러자
  //   가짜 객체를 `norm`에 넣고 진짜 호출은 `_unused`로 버리는 변경이 그대로
  //   통과했다 — 호출은 있고 결과는 안 쓰는 상태다. 부르기만 하는 것은
  //   부르지 않는 것과 같다.
  if (!/const norm = normalizeForVenue\(\{/.test(exec)) {
    fail(`${EXEC}: 정규화 결과를 그대로 쓰지 않습니다 — 부르기만 하고 버립니다`);
  }
  if (!/qty = norm\.quantity/.test(exec)) {
    fail(`${EXEC}: 맞춘 수량을 수량 변수에 넣지 않습니다`);
  }
  const call = exec.match(/const norm = normalizeForVenue\(\{[\s\S]{0,600}?\}\)/);
  if (!call) {
    fail(`${EXEC}: normalizeForVenue 호출 모양을 찾지 못했습니다`);
  } else {
    const c = call[0];
    if (!/reduceOnly:\s*isSellSide/.test(c)) {
      fail(`${EXEC}: 매도를 청산으로 넘기지 않습니다 — 규격을 못 읽으면 못 팔게 됩니다`);
    }
    // ④ 주문유형이 격자를 가른다. 안 넘기면 시장가를 지정가 격자로 깎는다.
    if (!/orderType:\s*type/.test(c)) {
      fail(`${EXEC}: 주문유형을 넘기지 않습니다 — 시장가가 지정가 격자로 깎입니다`);
    }
    // ⑤ 기준가는 **서버가 읽은 값**이어야 한다. 화면이 보낸 값으로 검사하면
    //    검사가 검사 대상에게 값을 물어보는 꼴이 된다.
    //    축약형(`referencePrice,`)과 명시형 둘 다 받되, **그 이름의 값**이어야
    //    한다. `referencePrice: null`로 바꾸면 최소 명목가 검사가 통째로
    //    사라지면서도 호출 모양은 그대로 남는다.
    if (!/referencePrice\s*,/.test(c) && !/referencePrice:\s*referencePrice\b/.test(c)) {
      fail(`${EXEC}: 최소 명목가 기준가를 넘기지 않습니다`);
    }
    if (/referencePrice:\s*(args|body|input)\./.test(c)) {
      fail(`${EXEC}: 기준가를 호출자가 준 값으로 씁니다 — 서버가 읽어야 합니다`);
    }
  }
  if (!/const referencePrice\s*=[\s\S]{0,120}?getSpotPrice\(\s*symbol\s*,\s*testnet\s*\)/.test(exec)) {
    fail(`${EXEC}: 기준가를 서버가 읽지 않습니다`);
  }
  // 언제 읽을지도 규격이 정한다 — 최소 명목가 규칙이 있을 때만.
  // `Number(body.minNotional)` 같은 것으로 바뀌면 화면이 검사를 끌 수 있다.
  if (!/needsRef\s*=[^;]*spec\.minNotional/.test(exec)) {
    fail(`${EXEC}: 기준가를 읽을지를 거래소 규격이 정하지 않습니다`);
  }
}

// ══════════════ ⑥ 맞춘 값이 실제로 거래소로 간다 ══════════════
//
// 부르기만 하고 결과를 버리면 아무것도 안 한 것과 같다. 4B-1의 모의
// 경로에서 같은 자리를 뮤테이션이 짚었다(MUT-V15).
{
  const send = exec.match(/placeOrderBinance\([\s\S]{0,700}?\}\)/);
  if (!send) {
    fail(`${EXEC}: 거래소 전송 호출을 찾지 못했습니다`);
  } else {
    const s = send[0];
    if (!/quantity:\s*byQuote\s*\?\s*undefined\s*:\s*\(qty/.test(s)) {
      fail(`${EXEC}: 맞춘 수량이 아니라 원래 수량을 보냅니다`);
    }
    if (!/price:[^,\n]*orderPrice/.test(s)) {
      fail(`${EXEC}: 격자에 맞춘 가격이 아니라 원값을 보냅니다 — PRICE_FILTER에 걸립니다`);
    }
  }
  // 장부에도 실제로 보낸 값이 적혀야 대조가 맞는다
  if (!/price:\s*type === 'LIMIT' \? orderPrice : null/.test(exec)) {
    fail(`${EXEC}: 장부에 맞추기 전 가격을 적습니다 — 거래소와 다른 주문이 기록됩니다`);
  }
}

// ══════════════ ⑦ 반올림 자리가 둘이 되지 않는다 ══════════════
{
  if (/roundSpotQty\(/.test(exec)) {
    fail(`${EXEC}: 정규화 뒤에 두 번째 반올림이 남아 있습니다`);
  }
}

// ══════════════ ⑧ 맞췄는지가 화면까지 간다 ══════════════
{
  if (!/venuePrecision/.test(exec)) {
    fail(`${EXEC}: 격자 적용 여부를 결과에 담지 않습니다`);
  }
  if (!/venuePrecision:\s*r\.venuePrecision/.test(route)) {
    fail(`${ROUTE}: 격자 적용 여부를 응답에 담지 않습니다 — 화면이 구별할 수 없습니다`);
  }
  // 체결 응답에 붙어 있는가. 오류 응답에만 있으면 체결된 주문이 격자를
  // 맞췄는지 알 수 없다 — 4B-1에서 같은 모양이 한 번 새 나갔다(MUT-V16).
  const okResp = exec.match(/ok:\s*true,\s*status:\s*'FILLED'[\s\S]{0,400}?\}/);
  if (!okResp) fail(`${EXEC}: 체결 응답을 찾지 못했습니다`);
  else if (!/venuePrecision/.test(okResp[0])) {
    fail(`${EXEC}: 체결 응답이 격자 적용 여부를 담지 않습니다`);
  }
  // 바뀌었거나 못 맞췄으면 사용자에게 한 줄이 간다
  if (!/precisionNote/.test(exec)) {
    fail(`${EXEC}: 수량이 바뀐 사실을 사용자에게 말하지 않습니다`);
  }
  else if (!/message:[^\n]*precisionNote/.test(exec)) {
    fail(`${EXEC}: 사유를 만들어 놓고 문장에 붙이지 않습니다`);
  }
  // 문장도 정본에서 가져온다. 실행부가 다시 쓰면 사유가 늘 때 한쪽만 고쳐진다.
  if (!/PRECISION_SKIP_TEXT\[/.test(exec)) {
    fail(`${EXEC}: 사유 문장을 정본에서 가져오지 않습니다`);
  }
}

// ══════════════ ⑨ 화면 훅이 서버 문장을 버리지 않는다 ══════════════
//
// 여기는 `'모의 주문이 체결됐습니다'` 고정 문구였다. 그래서 "격자를 못
// 읽어 안 맞췄다"도 "수량이 줄었다"도 화면에 닿은 적이 없다.
{
  const okBranch = form.match(/setMessage\(\{\s*ok:\s*true[\s\S]{0,200}?\}\)/);
  if (!okBranch) fail(`${FORM}: 성공 메시지 자리를 찾지 못했습니다`);
  else if (/text:\s*'[^']+'/.test(okBranch[0])) {
    fail(`${FORM}: 성공 문장이 고정돼 서버가 쓴 사유가 버려집니다`);
  }
  if (!/d\?\.message|d\.message/.test(form)) {
    fail(`${FORM}: 서버 문장을 읽지 않습니다`);
  }
}

// ══════════════ ⑩ 규격 조회가 두 벌이 되지 않는다 ══════════════
//
// 이 파일은 exchangeInfo를 **직접** 부르고 있었고, testnet 인자가 없어
// 테스트넷 연결의 계획을 실전 규격으로 판정했다.
{
  if (/exchangeInfo/.test(plan)) {
    fail(`${PLAN}: 규격 조회를 직접 합니다 — getSpotSymbolFilters가 정본입니다`);
  }
  if (!/getSpotSymbolFilters\(/.test(plan)) {
    fail(`${PLAN}: 최소 주문 금액을 정본에서 읽지 않습니다`);
  }
  if (!/fetchMinNotional\(symbol,\s*specTestnet\)/.test(plan)) {
    fail(`${PLAN}: 최소 주문 금액을 이 연결의 망으로 판정하지 않습니다`);
  }
  // 하드코딩 호스트가 남아 있으면 testnet 인자가 있어도 의미가 없다
  if (/api\.binance\.com/.test(plan)) {
    fail(`${PLAN}: 실전 호스트가 하드코딩돼 있습니다`);
  }
}

// ══════════════ ⑪ 기준가·규격 조회가 망을 따른다 ══════════════
{
  const gp = blockAfter(bn, 'export async function getSpotPrice');
  if (!gp) fail(`${BN}: getSpotPrice를 찾지 못했습니다`);
  else {
    if (!/spotBase\(testnet\)/.test(gp)) {
      fail(`${BN}: 현물 현재가를 실전 호스트에서 읽습니다 — 테스트넷 주문이 실전 시세로 검사됩니다`);
    }
    // 못 읽으면 null이다. 0으로 두면 명목가가 0이 되어 검사가 통과한다.
    if (!/return null/.test(gp)) {
      fail(`${BN}: 현재가를 못 읽었을 때 null로 떨어지지 않습니다`);
    }
    if (/return 0\b/.test(gp)) {
      fail(`${BN}: 현재가를 못 읽고 0을 돌려줍니다`);
    }
  }
  // roundSpotQty가 null·NaN을 우연히 넘기지 않는가
  const rs = blockAfter(bn, 'export function roundSpotQty');
  if (!rs) fail(`${BN}: roundSpotQty를 찾지 못했습니다`);
  else if (!/Number\.isFinite/.test(rs)) {
    fail(`${BN}: roundSpotQty가 NaN 단위를 막지 않습니다 — 수량이 NaN인 주문이 만들어집니다`);
  }
}

// ══════════════ ⑫ 범위 경계 — Gate 갈래는 4B-2A가 건드리지 않았다 ══════════════
//
// Gate 현물은 어댑터 안쪽에서 `amount_precision`으로 이미 내린다. 여기에
// 바이낸스 격자를 얹으면 **다른 개념의 격자 둘**이 순차 적용된다.
{
  const gate = blockAfter(exec, 'async function placeGateSpot',
    '): Promise<SpotOrderResult> {');
  if (!gate) fail(`${EXEC}: Gate 갈래를 찾지 못했습니다`);
  // ②와 같은 이유로 **이름**을 본다. `const { normalizeForVenue: _g } = ...`로
  // 별칭을 주면 호출 모양은 사라지지만 의존은 그대로 들어온다.
  else if (/normalizeForVenue|fetchVenueSpec/.test(gate)) {
    fail(`${EXEC}: Gate 현물에 바이낸스 격자를 얹었습니다 — 단위 개념이 다릅니다`);
  }
}

// ══════════════ ⑬ 승격된 venue에는 배선 근거가 있어야 한다 ══════════════
{
  const rows = [...reg.matchAll(
    /venue:\s*'([A-Z_]+)',\s*verdict:\s*'([A-Z_]+)',\s*evidence:\s*'([^']+)'/g)];
  if (rows.length === 0) fail(`${REG}: venue 판정을 찾지 못했습니다`);
  for (const [, venue, verdict, evidence] of rows) {
    if (verdict !== 'SUPPORTED') continue;
    const f = evidence.split(':')[0];
    if (!existsSync(f)) { fail(`${REG}: ${venue}의 근거 파일이 없습니다 (${f})`); continue; }
    const c = stripTs(readFileSync(f, 'utf8'));
    if (!/quantizeOrder|normalizeForVenue/.test(c)) {
      fail(`${REG}: ${venue}를 SUPPORTED로 적었는데 근거 파일이 격자를 적용하지 않습니다 (${f})`);
    }
  }
  // 실계좌 현물이 나가는 venue가 목록에서 빠지면 제품 칸이 거짓이 된다
  const spotBlock = reg.match(/SPOT_CRYPTO:\s*\[[\s\S]*?\n\s*\],/);
  if (!spotBlock) fail(`${REG}: SPOT_CRYPTO venue 목록을 찾지 못했습니다`);
  else {
    for (const v of ['BINANCE_SPOT', 'GATE_SPOT']) {
      if (!spotBlock[0].includes(`'${v}'`)) {
        fail(`${REG}: ${v}가 실계좌로 나가는데 SPOT_CRYPTO venue 목록에 없습니다`);
      }
    }
  }
}

if (bad > 0) {
  console.error(`\n현물 격자 배선 검사 실패 ${bad}건`);
  process.exit(1);
}
console.log('현물 격자 배선 검사 통과 — 정본 호출 · 금액매수 경계 · 매도 EXIT · '
  + '전송값 일치 · 이중반올림 없음 · 사유 전달 · 조회 단일화 · venue 목록');
