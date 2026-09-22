#!/usr/bin/env node
// scripts/check-venue-precision.mjs
//
// **주문이 거래소 격자를 벗어나지 못하게 하는 규율이 코드에 남아 있는지 본다.**
//
// 이 저장소는 같은 고장을 두 번 겪었다. 선물 쪽 `getSymbolFilters`가
// `parseFloat(lot?.stepSize || '0.001')`처럼 **기본값을 지어내고** 있었고,
// 고쳐진 뒤에도 현물 `getSpotSymbolFilters`에는 같은 버그(`|| '0.00001'`)가
// 그대로 남아 있었다. 규율이 주석에만 있으면 옆 파일로 가지 않는다.
//
// 그래서 글자가 아니라 **모양**을 본다 — 기본값 연산자가 격자 파싱에
// 붙어 있는가, 격자가 다른 격자에서 복사되는가, 못 읽었을 때 값이
// 만들어지는가.
import { readFileSync, existsSync } from 'node:fs';

const SPEC   = 'src/lib/markets/venueSpec.ts';
const SOURCE = 'src/lib/markets/venueSpecSource.ts';
const SPOT   = 'src/lib/exchanges/binance.ts';
const FUT    = 'src/lib/exchanges/binanceFutures.ts';
const PAPER  = 'src/app/api/paper/order/route.ts';
const SELL   = 'src/app/api/paper/sell/route.ts';
const QUANT  = 'src/lib/exchanges/quantize.ts';
const REG    = 'src/lib/products/registry.ts';

let bad = 0;
const fail = (m) => { console.error(`  ✗ ${m}`); bad += 1; };
const read = (p) => {
  if (!existsSync(p)) { fail(`${p}가 없습니다`); return ''; }
  return readFileSync(p, 'utf8');
};
const stripTs = (s) => String(s)
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ');

const spec   = stripTs(read(SPEC));
const source = stripTs(read(SOURCE));
const spot   = stripTs(read(SPOT));
const fut    = stripTs(read(FUT));
const paper  = stripTs(read(PAPER));
const sell   = stripTs(read(SELL));
const reg    = stripTs(read(REG));

// ══════════════ ① 격자를 지어내지 않는다 ══════════════
//
// `stepSize`·`minQty`·`tickSize`·`minNotional`을 읽는 자리에 `||`나 `??`로
// 숫자 기본값이 붙으면, 규격을 못 읽은 순간 **틀린 격자로 반올림한 주문**이
// 나간다. 맞춘 줄 알고 보내니까 규격을 안 맞춘 것보다 나쁘다.
{
  const FIELDS = ['stepSize', 'minQty', 'tickSize', 'minNotional', 'maxQty', 'contractSize'];
  for (const [file, code] of [[SPOT, spot], [FUT, fut], [SOURCE, source], [SPEC, spec]]) {
    for (const f of FIELDS) {
      // `lot?.stepSize || '0.001'` · `f.minQty ?? 1` 같은 모양.
      //
      // ★ **0은 잡지 않는다.** 이 저장소에서 `grid?.stepSize ?? 0`은 격자를
      //   지어내는 것이 아니라 **"격자 없음"을 뜻한다** — 받는 쪽이
      //   `stepSize > 0 ? roundToStep(...) : 그대로`로 다룬다
      //   (`binanceFutures.closeQuantityFor`). 처음 이 규칙을 넓게 썼다가
      //   그 자리를 결함으로 잡았고, 코드가 맞고 규칙이 틀렸다.
      //
      //   위험한 것은 **양수 기본값**이다. 그건 없는 격자를 만들어 내고,
      //   그 위에서 반올림한 주문은 "맞춘 줄 알고" 나간다.
      const POS = `['"\`]?(?!0['"\`]?[^.0-9])[0-9]`;
      for (const re of [
        // `lot?.stepSize || '0.001'`
        new RegExp(`\\.${f}\\s*(\\|\\||\\?\\?)\\s*${POS}`, 'g'),
        // ★ `stepSize: num(lot?.stepSize) ?? 0.00001`
        //   값을 감싸는 함수가 한 겹 끼면 위 모양으로는 안 잡힌다.
        //   MUT-V6b가 정확히 그 틈으로 빠져나갔다.
        new RegExp(`${f}\\s*:[^,\\n]*\\)\\s*(\\|\\||\\?\\?)\\s*${POS}`, 'g'),
      ]) {
        const hit = code.match(re);
        if (hit) fail(`${file}: 격자 ${f}에 기본값을 지어냅니다 — ${hit[0]}`);
      }
    }
  }
}

// ══════════════ ② 격자를 다른 격자에서 복사하지 않는다 ══════════════
//
// `MARKET_LOT_SIZE`가 없는데 `LOT_SIZE`를 쓰면 거래소가 두지 않은 규칙을
// 만드는 것이다. `minQty`가 없다고 `stepSize`를 넣는 것도 마찬가지 —
// 바이낸스에서 둘은 서로 다른 규칙이고, 그 추론은 최소를 낮춰 잡는다.
{
  for (const [file, code] of [[SPOT, spot], [FUT, fut], [SOURCE, source]]) {
    if (/marketStepSize\s*[:=]\s*[^,\n]*\blot\b/.test(code)
     || /marketQty[\s\S]{0,60}\blimitQty\b/.test(code)) {
      fail(`${file}: 시장가 격자를 지정가 격자에서 가져옵니다`);
    }
    if (/minQty\s*[:=]\s*(num\()?[^,\n]*\bstepSize\b/.test(code)) {
      fail(`${file}: minQty를 stepSize로 대신 채웁니다 — 서로 다른 규칙입니다`);
    }
  }
}

// ══════════════ ③ 못 읽었다는 사실이 값으로 남는다 ══════════════
{
  if (!/source:\s*'UNKNOWN'/.test(spec)) {
    fail(`${SPEC}: 못 읽은 상태를 값으로 표현하지 않습니다`);
  }
  if (!/export function unknownSpec/.test(spec)) {
    fail(`${SPEC}: unknownSpec이 없습니다 — null을 흘려보내게 됩니다`);
  }
  // 절충 정책: 못 읽으면 통과시키되 applied=false
  if (!/!specUsable\(i\.spec\)[\s\S]{0,400}applied:\s*false/.test(spec)) {
    fail(`${SPEC}: 규격 미상일 때 "안 맞췄다"고 적지 않습니다`);
  }
  if (!/!specUsable\(i\.spec\)[\s\S]{0,400}ok:\s*true/.test(spec)) {
    fail(`${SPEC}: 규격 미상일 때 통과시키지 않습니다 — 절충 정책이 아닙니다`);
  }
  // 그리고 그때 수량을 바꾸지 않는다
  if (!/!specUsable\(i\.spec\)[\s\S]{0,400}quantity:\s*q0/.test(spec)) {
    fail(`${SPEC}: 규격 미상인데 수량을 바꿉니다 — 없는 격자로 맞춘 것입니다`);
  }
}

// ══════════════ ③-b 조회 실패가 격자를 만들어내지 않는다 ══════════════
//
// 공급자의 실패 경로가 스펙 리터럴을 만들면, 못 읽은 종목이 조용히
// "읽은 것"이 된다. MUT-V6이 그 틈으로 빠져나갔다 — 실패 반환을 통째로
// 지어낸 스펙으로 바꿔도 아무도 안 봤다.
{
  if (!/return unknownSpec\(venue, sym\);/.test(source)) {
    fail(`${SOURCE}: 조회 실패가 unknownSpec으로 끝나지 않습니다`);
  }
  // 실패/캐시 경로에서 source를 'EXCHANGE'로 적으면 안 된다.
  // ★ `fetchVenueSpec`의 **실패/캐시 경로만** 본다.
  //
  //   처음에는 `let fresh`부터 파일 끝까지 잘랐는데, 그 뒤에 오는
  //   `readSpec`이 정상 조회라 `source: 'EXCHANGE'`를 **정당하게** 적는다.
  //   규칙이 맞는 코드를 잡았다 — 코드가 아니라 규칙이 틀렸다.
  const fetchBody = source.slice(source.indexOf('let fresh'));
  const tail = fetchBody.slice(0, fetchBody.indexOf('async function readSpec'));
  if (/source:\s*'EXCHANGE'/.test(tail)) {
    fail(`${SOURCE}: 조회하지 않은 격자를 '거래소 조회'로 적습니다`);
  }
  if (!/source:\s*'CACHED'/.test(tail)) {
    fail(`${SOURCE}: 캐시에서 온 값을 캐시라고 적지 않습니다`);
  }
  // 실패 경로에 격자 숫자 리터럴이 들어가면 지어낸 것이다.
  if (/unknownSpec[\s\S]{0,20}\{[\s\S]{0,200}tickSize:\s*[0-9]/.test(source)
   || /(tickSize|stepSize|minQty|minNotional):\s*0?\.[0-9]/.test(tail)) {
    fail(`${SOURCE}: 실패 경로에 격자 숫자를 지어냈습니다`);
  }
}

// ══════════════ ③-c venue SUPPORTED에는 배선 근거가 필요하다 ══════════════
//
// 판정만 바꾸면 되는 상태로 두면 언젠가 바뀐다. MUT-V10이 KIS를
// SUPPORTED로 올렸는데 아무도 안 봤다 — 주식에는 정규화가 한 줄도 없다.
//
// 그래서 **SUPPORTED인 venue는 그 근거 파일에 실제 정규화 호출이 있어야
// 한다.** 판정과 코드가 같이 움직인다.
{
  const rows = [...reg.matchAll(
    /venue:\s*'([A-Z_]+)',\s*verdict:\s*'([A-Z_]+)',\s*\n\s*evidence:\s*'([^']+)'/g)];
  if (rows.length === 0) fail(`${REG}: venue 규격 판정을 하나도 찾지 못했습니다`);
  for (const [, venue, verdict, ev] of rows) {
    if (verdict !== 'SUPPORTED') continue;
    const file = ev.split(':')[0];
    if (!existsSync(file)) { fail(`${REG}: ${venue}의 근거 파일이 없습니다 — ${ev}`); continue; }
    const c = readFileSync(file, 'utf8');
    if (!/quantizeOrder|normalizeForVenue/.test(c)) {
      fail(`${REG}: ${venue}가 지원으로 적혔는데 근거(${ev})에 정규화 호출이 없습니다`);
    }
  }
}

// ══════════════ ④ 정규화를 두 벌로 만들지 않는다 ══════════════
//
// 같은 주문이 경로에 따라 다른 수량으로 나가는 것이 이 저장소의 2번 고장이다.
{
  if (!/quantizeOrder\(/.test(spec)) {
    fail(`${SPEC}: 기존 정규화(quantizeOrder)를 쓰지 않고 자체 계산을 합니다`);
  }
  // 자체 내림/반올림 구현 금지
  if (/Math\.floor\([^)]*\/\s*(step|stepSize)/.test(spec)) {
    fail(`${SPEC}: 자체 격자 내림을 구현했습니다 — quantizeOrder가 정본입니다`);
  }
}

// ══════════════ ⑤ venue를 섞지 않는다 ══════════════
{
  if (!/BINANCE_USDM/.test(spec) || !/BINANCE_COINM/.test(spec)) {
    fail(`${SPEC}: USDT-M과 COIN-M이 따로 있지 않습니다`);
  }
  if (!/venue:\s*VenueId/.test(spec)) {
    fail(`${SPEC}: 격자가 venue를 들고 다니지 않습니다`);
  }
  // 모의 시장 → venue 사상이 fail-closed인가
  if (!/export function venueForPaperMarket[\s\S]{0,300}return null;/.test(spec)) {
    fail(`${SPEC}: 모르는 모의 시장이 null로 떨어지지 않습니다`);
  }
  if (/venueForPaperMarket[\s\S]{0,300}return 'BINANCE_SPOT';\s*\n\s*\}/.test(spec)) {
    fail(`${SPEC}: 모르는 시장이 현물 venue로 떨어집니다`);
  }
  // 공급자가 다른 venue의 격자를 빌려 오지 않는가
  if (/venue === 'BINANCE_COINM'[\s\S]{0,200}getSymbolFilters|venue === 'KIS[\s\S]{0,200}getSpotSymbolFilters/.test(source)) {
    fail(`${SOURCE}: 다른 venue의 격자를 빌려 옵니다`);
  }
}

// ══════════════ ⑥ 모의 진입이 격자를 거친다 ══════════════
{
  if (!/normalizeForVenue\(/.test(paper)) {
    fail(`${PAPER}: 모의 진입이 거래소 격자를 거치지 않습니다`);
  }
  if (!/venueForPaperMarket\(/.test(paper)) {
    fail(`${PAPER}: 모의가 어느 venue를 모사하는지 묻지 않습니다`);
  }
  // 맞춘 수량이 실제로 계획에 들어가는가 — 부르기만 하고 버리면 소용없다
  if (!/buildPaperPlan\(\{[\s\S]{0,300}quantity:\s*Number\(norm\.quantity\)/.test(paper)) {
    fail(`${PAPER}: 맞춘 수량을 쓰지 않고 원래 수량으로 계획합니다`);
  }
  // 못 맞췄다는 사실이 응답에 나가는가
  if (!/venuePrecision/.test(paper)) {
    fail(`${PAPER}: 규격 적용 여부를 응답에 담지 않습니다 — 화면이 구별할 수 없습니다`);
  }
  // ★ **성공 응답에 앵커한다.**
  //
  //   처음에는 파일 전체에서 `applied: norm.applied`를 찾았다. 그런데 그
  //   문구가 **오류 응답에도** 있어서, 성공 응답에서만 빼는 변경이 그대로
  //   통과했다(MUT-V16). 체결된 주문이 격자를 맞췄는지가 바로 그 자리다.
  {
    // `requestedQuantity`는 체결 응답에만 있다 — 오류 응답과 구별되는 표식.
    const okResp = paper.match(/venuePrecision:\s*\{[\s\S]{0,400}?requestedQuantity/);
    if (!okResp) fail(`${PAPER}: 체결 응답을 찾지 못했습니다`);
    else if (!/applied:\s*norm\.applied/.test(okResp[0])) {
      fail(`${PAPER}: 체결 응답이 규격 적용 여부를 담지 않습니다`);
    }
  }
}

// ══════════════ ⑦ ★ 매도에는 걸지 않는다 (088 등가성 보호) ══════════════
//
// 088의 증명은 "25%+25%+전량 == 100% 1회"가 정확히 같은 장부를 만든다는
// 것이다. 매도 수량을 격자로 내리면 그 등가가 깨진다. 진입에서 맞춘
// 수량이 들어오므로 보유는 이미 격자 위에 있다.
{
  if (/normalizeForVenue\(|venueForPaperMarket\(/.test(sell)) {
    fail(`${SELL}: 매도에 격자를 걸었습니다 — 088의 분할/전량 등가성이 깨집니다`);
  }
}

// ══════════════ ⑧ 제품 규격은 가장 약한 venue를 따른다 ══════════════
{
  if (!/export function allVenuesPrecise/.test(reg)) {
    fail(`${REG}: venue별 규격을 합치는 함수가 없습니다`);
  }
  if (!/vs\.every\(v => v\.verdict === 'SUPPORTED'\)/.test(reg)) {
    fail(`${REG}: 일부 venue만 증명해도 제품이 통과합니다`);
  }
  if (!/vs\.length === 0[\s\S]{0,40}return false/.test(reg)) {
    fail(`${REG}: 감사하지 않은 제품이 통과합니다 — 모르는 것을 통과로 읽습니다`);
  }
  // USDT-M 하나가 닫혔다고 제품 전체가 올라가면 안 된다
  const m = reg.match(/PERP_CRYPTO:\s*\[([\s\S]*?)\n  \],/);
  if (!m) fail(`${REG}: PERP_CRYPTO venue 목록을 찾지 못했습니다`);
  else {
    const n = (m[1].match(/verdict:\s*'SUPPORTED'/g) || []).length;
    const total = (m[1].match(/venue:/g) || []).length;
    if (total < 2) fail(`${REG}: 코인 무기한에 venue가 하나뿐입니다 — COIN-M이 빠졌습니다`);
    if (n === total) {
      fail(`${REG}: 코인 무기한의 모든 venue가 지원으로 적혔습니다 — COIN-M 격자는 아직 없습니다`);
    }
  }
  // 제품 축 PRECISION은 아직 어느 제품도 SUPPORTED일 수 없다
  const prec = [...reg.matchAll(/PRECISION:\s*cap\(\s*'([A-Z_]+)'/g)].map(x => x[1]);
  if (prec.length === 0) fail(`${REG}: PRECISION 판정을 찾지 못했습니다`);
  for (const v of prec) {
    if (v === 'SUPPORTED') {
      fail(`${REG}: 제품 축 PRECISION이 SUPPORTED입니다 — 아직 어느 제품도 전 venue가 닫히지 않았습니다`);
    }
  }
}

// ══════════════ ⑨ 기존 정규화의 규율이 살아 있는가 ══════════════
{
  const q = stripTs(read(QUANT));
  if (!/'FILTERS_UNKNOWN'/.test(q) || !/'QTY_FILTER_UNKNOWN'/.test(q)) {
    fail(`${QUANT}: 규격 미상 코드가 사라졌습니다`);
  }
  if (!/applied/.test(q)) fail(`${QUANT}: 적용 여부 플래그가 사라졌습니다`);
}

if (bad > 0) {
  console.error(`\n거래소 격자 규율 검사 실패 ${bad}건`);
  process.exit(1);
}
console.log('거래소 격자 규율 검사 통과 — 기본값 비생성 · 격자 비복사 · 절충 정책 · venue 분리 · 매도 비적용');
