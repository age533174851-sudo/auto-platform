#!/usr/bin/env node
// scripts/check-canonical-trading.mjs
//
// **화면이 나뉘어 있는가 — 그리고 나뉜 화면들이 같은 판정을 쓰는가.**
//
// 무엇이 바뀌었나 (Phase UI-IA)
// ─────────────────────────────
// 예전 계약은 **원스크린을 강제했다.** "모바일 터미널이 정본 거래 화면을
// 두 곳에서 렌더해야 한다", "주문│호가 분할 줄이 있어야 한다", "시트
// 구조로 돌아가면 실패" — 차트·호가·주문폼·포지션을 한 화면에 쌓는 배치를
// CI가 지키고 있었다.
//
// 그 배치는 모바일에서 실패했다. 320×600에서 차트가 96px까지 밀렸고,
// 붙인 주문 버튼이 슬라이더를 덮어 **보이는데 눌리지 않는** 상태가 났다.
//
// 그래서 계약을 뒤집는다. **약화가 아니라 방향 전환이다** — 아래 규칙은
// 예전과 같은 수의 고장을 막되, 막는 대상이 반대다:
//
//     시장 / 왓치리스트 / 검색
//       → 종목 상세      (보는 화면. 주문폼이 없다)
//       → 전용 주문 화면  (주문하는 화면. 큰 차트가 없다)
//       → 체결
//       → 포지션 / 주문 / 자산
//
// 두 화면이 서로의 일을 다시 하기 시작하면 그게 원스크린으로 돌아가는
// 길이다. ④와 ⑤가 양쪽에서 그것을 막는다.
//
// ★ 그리고 가장 중요한 것 — ⑨
// ────────────────────────────
// 간편/프로는 **표현 밀도**이지 다른 제품이 아니다. 밀도마다 주문 엔진을
// 따로 만들면 "프로에서만 수량이 다르게 나가는" 고장이 나고, 그건 화면을
// 봐서는 알 수 없다. 그래서 두 밀도가 **같은 훅 인스턴스**를 받는지를
// 구조로 검사한다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PAGE    = 'src/app/page.tsx';
const DETAIL  = 'src/components/instrument/InstrumentDetail.tsx';
const ORDER   = 'src/components/trading/PaperOrderScreen.tsx';
const PRO     = 'src/components/trading/ProOrderPanel.tsx';
const BBUY    = 'src/components/trading/BeginnerBuyScreen.tsx';
const BSELL   = 'src/components/trading/BeginnerSellScreen.tsx';
const SHEET   = 'src/components/trading/OrderControls.tsx';
const SLIDER  = 'src/components/trading/SizingSlider.tsx';
const FORM    = 'src/lib/trading/useTradeForm.ts';
const TARGET  = 'src/lib/trading/paperTarget.ts';
const POS     = 'src/components/trading/PositionsOrdersScreen.tsx';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); bad += 1; };
const read = (p) => {
  try { return readFileSync(p, 'utf8'); }
  catch { err(`${p}를 읽지 못했습니다 — 확인하지 못한 것을 통과로 적지 않습니다`); return ''; }
};
/** 주석은 규율이 아니다. 주석에 적힌 낱말로 검사가 통과하면 안 된다 */
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const page   = code(read(PAGE));
const detail = code(read(DETAIL));
const order  = code(read(ORDER));
const pro    = code(read(PRO));
const sheet  = code(read(SHEET));
const slider = code(read(SLIDER));
const form   = code(read(FORM));
const target = code(read(TARGET));

// ══════════════ ① 새 주문은 종목에서 시작한다 ══════════════
//
// 목록 → 상세 → 주문. 이 사슬의 고리가 하나라도 끊기면 사용자는 종목을
// 고른 뒤 주문까지 못 간다. 예전에 정확히 그랬다 — 목록에서 종목을 눌러도
// **보는 것으로 끝났다.**
{
  if (!/detailTargetOf\s*\(/.test(page)) {
    err(`${PAGE}가 종목에서 상세로 가는 판정을 쓰지 않습니다`);
  }
  if (!/<InstrumentDetail/.test(page)) {
    err(`${PAGE}가 종목 상세를 렌더하지 않습니다 — 탐색에서 상세로 가는 길이 없습니다`);
  }
  // 상세 → 주문. **문맥을 읽어서** 넘겨야 한다. 못 읽으면 열지 않는다 —
  // 종목을 모르는 채 주문 화면을 열면 무엇을 사는지 모르고 누르게 된다.
  if (!/onOrder=\{[\s\S]{0,600}?readTradeContext\(/.test(page)) {
    err(`${PAGE}가 상세의 주문 요청을 문맥으로 바꾸지 않습니다`);
  }
  if (!/<PaperOrderScreen/.test(page)) {
    err(`${PAGE}가 전용 주문 화면을 렌더하지 않습니다`);
  }
  // 상세에 주문 버튼이 실제로 있는가 (만들어 놓고 안 붙이는 1번 고장)
  if (!/onOrder\s*\(/.test(detail)) {
    err(`${DETAIL}에 주문으로 가는 길이 없습니다`);
  }
}

// ══════════════ ② 종목 상세는 상주 목적지가 아니다 ══════════════
//
// 하단 탭은 **언제나 갈 수 있는 곳**이다. 종목 상세는 종목을 고른 뒤에만
// 뜻이 있으므로 거기 있으면 안 된다 — 아무 종목도 안 고른 상태의 '상세'는
// 무엇을 보여줘야 할지 답이 없다.
{
  const m = page.match(/const BTABS[\s\S]{0,900}?\n\];/);
  if (!m) err(`${PAGE}에서 하단 탭 목록을 찾지 못했습니다`);
  else {
    for (const banned of ['detail', 'instrument', 'order']) {
      if (new RegExp(`id:\\s*'${banned}'`).test(m[0])) {
        err(`하단 탭에 '${banned}'가 있습니다 — 종목 상세·주문은 고른 뒤에만 뜻이 있습니다`);
      }
    }
  }
  // 상세와 주문은 **겹**이다. 겹이면 뒤로가기가 닫고, 탭이면 못 닫는다.
  if (!/id:\s*'detail',\s*open:/.test(page) || !/id:\s*'order',\s*open:/.test(page)) {
    err(`${PAGE}에서 상세·주문이 겹 목록에 없습니다 — 뒤로가기가 닫지 못합니다`);
  }
}

// ══════════════ ③ 주문 화면 host는 하나다 ══════════════
//
// host가 둘이면 두 판이 서로 다른 props로 갈라진다. 이 저장소가 이름 붙인
// 2번 고장이고, 예전 계약에서도 같은 것을 지켰다 — 지키는 대상만 바뀐다.
{
  const files = walk('src');
  const hosts = files.filter(f => f !== ORDER && /<PaperOrderScreen/.test(code(read(f))));
  if (hosts.length !== 1) {
    err(`전용 주문 화면을 렌더하는 곳이 ${hosts.length}곳입니다 — 하나여야 합니다`
      + (hosts.length ? ` (${hosts.join(', ')})` : ''));
  }
  // 주문 판정을 만드는 곳도 하나다. 여기가 갈리면 같은 주문이 두 수량으로 나간다.
  for (const hook of ['useTradeForm', 'useSellForm']) {
    const makers = files.filter(f => new RegExp(`\\b${hook}\\s*\\(\\{`).test(code(read(f))));
    if (makers.length !== 1 || makers[0] !== ORDER) {
      err(`${hook}을 만드는 곳이 [${makers.join(', ') || '없음'}]입니다 — ${ORDER} 한 곳이어야 합니다`);
    }
  }
}

// ══════════════ ④ 종목 상세에 주문폼을 넣지 않는다 ══════════════
//
// 여기가 원스크린으로 돌아가는 첫 번째 길이다. 상세에 주문폼을 얹으면
// 차트와 주문이 다시 같은 화면을 나눠 갖는다.
{
  for (const banned of ['OrderControls', 'SizingSlider', 'ProOrderPanel',
                        'BeginnerBuyScreen', 'OrderEstimate']) {
    if (new RegExp(`<${banned}|\\b${banned}\\s*\\(`).test(detail)) {
      err(`${DETAIL}이 주문 부품을 상주시킵니다 (${banned}) — 원스크린으로 되돌아갑니다`);
    }
  }
  // 판정 훅을 상세가 직접 들면 그 화면이 곧 주문 화면이 된다
  for (const hook of ['useTradeForm', 'useSellForm', 'submitGate']) {
    if (new RegExp(`\\b${hook}\\s*\\(`).test(detail)) {
      err(`${DETAIL}이 주문 판정을 직접 만듭니다 (${hook})`);
    }
  }
  // 체결 버튼이 상세에 있으면 안 된다 — 상세의 버튼은 **화면을 여는** 것뿐이다
  if (/\.submit\s*\(/.test(detail)) {
    err(`${DETAIL}이 주문을 직접 제출합니다 — 상세는 보는 화면입니다`);
  }
  // 옛 원스크린의 분할 흔적
  for (const gone of ['splitColumns', 'coreBudget', 'BOOK_MIN_PX', 'one-screen']) {
    if (detail.includes(gone) || order.includes(gone) || pro.includes(gone)) {
      err(`원스크린 배치가 되살아났습니다 (${gone})`);
    }
  }
}

// ══════════════ ⑤ 주문 화면에 분석용 큰 차트를 넣지 않는다 ══════════════
//
// 반대 방향의 같은 고장이다. 주문 화면에 차트를 얹으면 그게 터미널이다 —
// 이름만 바뀐 같은 배치가 된다. 차트를 보려면 뒤로 나가면 상세가 살아 있다.
{
  for (const f of [ORDER, PRO]) {
    const c = code(read(f));
    for (const banned of ['PriceChart', 'ChartPane', 'InlineTVChart', 'iframe']) {
      if (new RegExp(`<${banned}`).test(c)) {
        err(`${f}가 분석용 차트를 상주시킵니다 (${banned}) — 주문 화면이 터미널이 됩니다`);
      }
    }
    // 호가도 마찬가지다. 호가는 판단할 때 보는 것이고 상세의 일이다.
    if (/<OrderBookView/.test(c)) {
      err(`${f}가 호가를 상주시킵니다 — 주문│호가 분할이 되살아납니다`);
    }
  }
}

// ══════════════ ⑥ 정본 판정을 우회하지 않는다 ══════════════
{
  if (!/const gate = submitGate\(\{/.test(form)) {
    err(`${FORM}이 submitGate로 판정하지 않습니다 — 권한·수량·계획이 모두 필요합니다`);
  }
  if (!/buildPaperPlan\(/.test(form)) {
    err(`${FORM}이 서버와 같은 계획 함수를 쓰지 않습니다`);
  }
  if (/buildPaperPlan\(/.test(sheet)) {
    err(`${SHEET}가 계획을 직접 계산합니다 — 판정은 ${FORM} 한 곳입니다`);
  }
  if (/planSizing\(/.test(slider)) {
    err(`${SLIDER}가 수량을 다시 계산합니다 — 계산은 ${FORM} 한 곳입니다`);
  }
  if (!/stopRequestFields\s*\(/.test(form)) {
    err(`${FORM}이 손절 값을 stopPresets를 거치지 않고 만듭니다`);
  }
  // 문맥·장부 정본
  if (!/routeFor\s*\(/.test(order) || !/openSideFor\s*\(/.test(order)) {
    err(`${ORDER}가 tradeContext 정본으로 경로·방향을 정하지 않습니다`);
  }
  if (!/scopeForTarget\s*\(/.test(order)) {
    err(`${ORDER}가 장부 범위를 정본으로 정하지 않습니다`);
  }
  // 실거래를 모의 라우트가 가로채지 않는다
  if (!/return tradeMode === PAPER_TRADE_MODE;/.test(target)) {
    err(`${TARGET}의 모의 판정이 정본 상수 비교가 아닙니다 — 어휘가 갈리면 모드가 뒤바뀝니다`);
  }
  if (!/const PAPER_TRADE_MODE: TradeMode = 'PAPER';/.test(target)) {
    err(`${TARGET}의 모의 모드 이름이 TradeMode 타입에 묶여 있지 않습니다`);
  }
  for (const route of ['/api/binance/futures/order', '/api/binance/spot/order',
                       '/api/binance/coinm/order']) {
    if (sheet.includes(route)) err(`${SHEET}가 실거래 라우트를 직접 부릅니다 (${route})`);
  }
}

// ══════════════ ⑦ 상세의 칸은 출처가 정한다 ══════════════
//
// 칸을 먼저 만들어 두면 누군가 숫자를 채운다. 이 저장소에 이미 그렇게
// 들어온 값이 있다 — 손으로 적은 시가총액, 손으로 쓴 ROE.
{
  if (!/instrumentFieldPlan\s*\(/.test(detail)) {
    err(`${DETAIL}이 그려도 되는 칸을 정본에 묻지 않습니다`);
  }
  // 없는 값을 0으로 접지 않는다 — 0은 "그 값이 0이다"로 읽힌다
  if (/(marketCap|dividendYield|peRatio)\s*(\|\||\?\?)\s*0/.test(detail)) {
    err(`${DETAIL}이 없는 값을 0으로 적습니다`);
  }
  // 포지션·주문 화면도 같다. 출처 없는 칸을 "0건"으로 채우지 않는다.
  const pos = code(read(POS));
  // **정의가 아니라 사용을 본다.** 처음에는 `Locked`라는 낱말만 찾았고,
  // 정의 이름만 바꾸는 변경에 그대로 통과했다.
  const locks = (pos.match(/<Locked\b/g) || []).length;
  if (!/function Locked\b/.test(pos)) {
    err(`${POS}에 잠긴 칸 부품이 없습니다`);
  }
  if (locks < 2) {
    err(`${POS}가 출처 없는 칸을 ${locks}곳만 잠급니다 — 미체결·내역 둘 다 출처가 없습니다`);
  }
  // **"0건" 같은 낱말은 검사하지 않는다.** 화면이 "왜 0건이라고 적지
  // 않는가"를 설명하는 문장에도 그 낱말이 들어간다 — 실제로 여기서 한 번
  // 오탐이 났다. 낱말이 아니라 **잠긴 칸이 실제로 있는가**를 본다.
}

// ══════════════ ⑧ 능력 없는 제품에 주문 버튼을 열지 않는다 ══════════════
{
  if (!/paperOrderUiWiring\s*\(/.test(order)) {
    err(`${ORDER}가 제품 능력표를 보지 않습니다 — 안 되는 제품에 주문 버튼이 열립니다`);
  }
  if (!/canOrder:\s*wiring\.canOrder/.test(order)) {
    err(`${ORDER}가 능력표 판정을 주문 판정에 넘기지 않습니다`);
  }
  // **하나만 보면 안 된다.** CTA는 둘(LONG·SHORT)이고, 한쪽만 지켜도
  // 통과하게 두면 나머지 한쪽이 판정 없이 열린다.
  const ctas = (pro.match(/<Cta\b/g) || []).length;
  const gated = (pro.match(/disabled=\{!form\.gate\.ready \|\| form\.busy\}/g) || []).length;
  if (ctas === 0) err(`${PRO}에 주문 버튼이 없습니다`);
  if (gated !== ctas) {
    err(`${PRO}의 주문 버튼 ${ctas}개 중 ${gated}개만 판정을 봅니다`);
  }
  // 잔고를 못 읽으면 닫힌다. 못 읽은 것을 0으로 접으면 "돈이 없다"로 읽힌다.
  if (!/const balanceUnknown = availableBalance == null;/.test(slider)) {
    err(`${SLIDER}가 잔고 못 읽음을 판정하지 않습니다`);
  }
  if (!/const locked = !!disabled \|\| balanceUnknown;/.test(slider)) {
    err(`${SLIDER}가 잔고를 못 읽어도 잠기지 않습니다`);
  }
  if (/availableBalance \|\| 0|Number\(availableBalance\) \|\| 0/.test(slider)) {
    err(`${SLIDER}가 못 읽은 잔고를 0으로 접습니다`);
  }
}

// ══════════════ ⑨ ★ 간편과 프로는 같은 판정을 쓴다 ══════════════
//
// **이것이 이 검사기에서 가장 중요한 규칙이다.**
//
// 밀도는 표현이다. 밀도마다 주문 엔진·장부·사이징을 따로 만들면 "프로에서만
// 수량이 다르게 나가는" 고장이 나고, 그건 화면을 봐서는 알 수 없다 —
// 두 화면 다 정상으로 보이고 시험도 통과한다.
//
// 그래서 말로 적지 않고 **구조로 검사한다**: 훅은 밀도 분기보다 위에서
// 한 번 만들어지고, 아래 갈래는 그것을 받기만 한다.
{
  // ⑴ 훅 생성이 밀도 분기보다 **앞**에 있는가
  const iForm  = order.search(/\buseTradeForm\s*\(\{/);
  const iSell  = order.search(/\buseSellForm\s*\(\{/);
  const iLevel = order.search(/level === 'PRO'/);
  if (iForm < 0 || iSell < 0 || iLevel < 0) {
    err(`${ORDER}에서 판정 생성 또는 밀도 분기를 찾지 못했습니다`);
  } else if (iForm > iLevel || iSell > iLevel) {
    err(`${ORDER}가 밀도 분기 **뒤에서** 판정을 만듭니다 — 밀도마다 다른 엔진이 생깁니다`);
  }

  // ⑵ 밀도가 판정의 인자로 **들어가지 않는가**
  //
  //   `useTradeForm({ ... level ... })`이 되는 순간 밀도가 주문을 바꾼다.
  for (const hook of ['useTradeForm', 'useSellForm']) {
    const m = order.match(new RegExp(`\\b${hook}\\s*\\(\\{[\\s\\S]{0,700}?\\n  \\}\\)`));
    if (!m) { err(`${ORDER}의 ${hook} 인자를 읽지 못했습니다`); continue; }
    if (/\blevel\b|uiLevel|BEGINNER|PRO/.test(m[0])) {
      err(`${ORDER}의 ${hook}에 밀도가 들어갑니다 — 표현이 판정을 바꿉니다`);
    }
  }

  // ⑶ 표현 컴포넌트는 판정을 **만들지 않고 받는다**
  for (const f of [PRO, BBUY, BSELL]) {
    const c = code(read(f));
    for (const hook of ['useTradeForm', 'useSellForm', 'submitGate', 'planSizing',
                        'usePaperLedger', 'buildPaperPlan']) {
      if (new RegExp(`\\b${hook}\\s*\\(`).test(c)) {
        err(`${f}가 판정을 직접 만듭니다 (${hook}) — 밀도별 엔진이 생깁니다`);
      }
    }
  }

  // ⑷ 프로 패널이 **props로** 받는가 (받지 않으면 어딘가에서 만든 것이다)
  for (const need of ['form:', 'sell:']) {
    if (!new RegExp(`${need}\\s*(TradeForm|SellForm)`).test(pro)) {
      err(`${PRO}가 ${need.replace(':', '')}을 props로 받지 않습니다`);
    }
  }
  // ⑸ 두 갈래에 **같은 변수**가 간다
  // **개수로 본다.** 한 갈래만 `form={form}`이어도 정규식은 통과한다 —
  // 실제로 프로에만 복사본을 넘기는 뮤테이션이 그 틈으로 살아남았다.
  {
    const panels = (order.match(/<(ProOrderPanel|BeginnerBuyScreen)\b/g) || []).length;
    const sameForm = (order.match(/form=\{form\}/g) || []).length;
    if (panels === 0) err(`${ORDER}가 밀도별 표현을 렌더하지 않습니다`);
    if (sameForm !== panels) {
      err(`${ORDER}의 밀도 표현 ${panels}곳 중 ${sameForm}곳만 같은 판정을 받습니다`
        + ' — 한쪽에 복사본이 가면 두 밀도가 다른 주문을 냅니다');
    }
    const sells = (order.match(/<(ProOrderPanel|BeginnerSellScreen)\b/g) || []).length;
    const sameSell = (order.match(/sell=\{sell\}/g) || []).length;
    if (sameSell !== sells) {
      err(`${ORDER}의 매도 표현 ${sells}곳 중 ${sameSell}곳만 같은 판정을 받습니다`);
    }
  }

  // ⑹ 격자(venue precision)·장부 정본이 밀도로 갈리지 않는다
  for (const f of [PRO, BBUY, BSELL]) {
    const c = code(read(f));
    if (/normalizeForVenue|quantizeOrder|roundSpotQty|fetchVenueSpec/.test(c)) {
      err(`${f}가 거래소 격자를 화면에서 다시 맞춥니다 — 격자는 서버 정본입니다`);
    }
  }
}

// ══════════════ ⑩ 프로 패널이 주문할 수단을 잃지 않는다 ══════════════
//
// 화면을 나눈 뒤 생기는 새 고장이 있다 — **주문 화면 쪽이 비는 것.**
// 상세에서 주문폼을 뺐으니 주문 화면에는 반드시 있어야 한다.
{
  if (!/<OrderControls/.test(pro)) {
    err(`${PRO}에 주문 조작부가 없습니다 — 프로가 주문할 수단을 잃습니다`);
  }
  if (!/<OrderEstimate/.test(pro)) {
    err(`${PRO}가 증거금·수수료·청산가를 그리지 않습니다`);
  }
  // 예상값은 **스크롤 칸 밖**에 있어야 한다. 안에 넣으면 스크롤에 딸려
  // 사라지고, 얼마가 잠기는지 모른 채 누르게 된다.
  //
  // ★ 주석 표식으로 재지 않는다. 처음에 `{/* ③`을 찾게 썼더니 그 주석만
  //   바꾸는 변경에 **표식을 못 찾아 조용히 통과**했다(fail-open). 지금은
  //   여는 div부터 짝이 맞는 `</div>`까지 세어 실제 바깥인지 본다.
  {
    const open = pro.indexOf('data-testid="pro-order-scroll"');
    const est = pro.search(/<OrderEstimate/);
    if (open < 0) {
      err(`${PRO}의 스크롤 칸 표식을 찾지 못했습니다 — 구조를 확인할 수 없습니다`);
    } else if (est < 0) {
      err(`${PRO}가 예상값을 그리지 않습니다`);
    } else {
      // 여는 태그의 `<` 부터 깊이를 센다
      const from = pro.lastIndexOf('<div', open);
      let depth = 0, close = -1;
      const re = /<div\b|<\/div>/g;
      re.lastIndex = from;
      let m;
      while ((m = re.exec(pro))) {
        depth += m[0] === '</div>' ? -1 : 1;
        if (depth === 0) { close = m.index; break; }
      }
      if (close < 0) err(`${PRO}의 스크롤 칸이 닫히지 않습니다`);
      else if (est < close) {
        err(`${PRO}의 예상값이 스크롤 칸 안에 있습니다 — 스크롤에 딸려 사라집니다`);
      }
    }
  }
  // CTA를 붙이지 않는다. 320×600에서 붙인 줄이 슬라이더를 덮어
  // **보이는데 눌리지 않는** 상태가 났다.
  const cta = pro.match(/data-testid="pro-order-cta"[\s\S]{0,260}?\}\}/);
  if (!cta) err(`${PRO}에 LONG/SHORT 줄이 없습니다`);
  else if (/position:\s*'sticky'|position:\s*'fixed'/.test(cta[0])) {
    err(`${PRO}의 LONG/SHORT 줄이 다시 붙었습니다 — 슬라이더를 덮습니다`);
  }
  // 넘치면 자르지 않고 스크롤한다
  if (!/overflowY:\s*'auto'/.test(pro)) {
    err(`${PRO}에서 넘치는 칸이 스크롤하지 않습니다 — 넘친 줄이 말없이 사라집니다`);
  }
}

// ══════════════ ⑪ 포지션은 주문이 간 장부에서 읽는다 ══════════════
//
// 정본 화면에 포지션 줄이 없던 동안 `BottomDock`이 대신 그렸고, 그 둘은
// 다른 계좌를 보고 있었다. 챌린지로 주문하면 방금 연 포지션이 안 보이고
// 기본 계좌 포지션이 보인다 — 오류 없이 "포지션이 없네"로 읽힌다.
{
  const row = code(read('src/components/trading/PositionRow.tsx'));
  const pos = code(read(POS));
  if (!row) err('포지션 줄이 없습니다 — 주문한 포지션을 확인할 곳이 없습니다');

  // ① 이 줄은 **다시 읽지 않는다.** 새 조회가 생기면 계좌가 갈릴 자리가 생긴다.
  if (/\/api\/paper\/account/.test(row)) {
    err('포지션 줄이 /api/paper/account를 읽습니다 — 그 라우트는 늘 기본 계좌입니다');
  }
  if (/\/api\/paper\/positions/.test(row)) {
    err('포지션 줄이 포지션을 다시 조회합니다 — 화면이 이미 가진 장부를 써야 합니다');
  }
  // **이름이 아니라 호출을 본다.** 타입을 가져오는 것은 정상이다.
  for (const hook of ['usePaperAccount', 'useBinanceStream', 'usePaperLedger', 'usePaperTarget']) {
    if (new RegExp(`${hook}\\s*\\(`).test(row)) {
      err(`포지션 줄이 스스로 장부를 읽습니다 (${hook}) — props로 받은 정본만 씁니다`);
    }
  }
  if (!/'\/api\/paper\/close'/.test(row)) {
    err('포지션 줄이 기존 청산 경로를 쓰지 않습니다');
  }
  for (const banned of [/paper_account_id/, /accountId/, /fillPrice:/, /realizedPnl/, /unrealized/]) {
    if (banned.test(row)) {
      err(`포지션 줄이 계좌·손익을 스스로 다룹니다 (${banned}) — 정본에 없는 값을 만들지 않습니다`);
    }
  }

  // ② 화면이 **주문에 쓰는 바로 그 장부**를 넘기는가
  const rows = (pos.match(/<PositionRow/g) || []).length;
  const fed = (pos.match(/positions=\{positions\}/g) || []).length;
  const reloads = (pos.match(/onClosed=\{ledger\.reload\}/g) || []).length;
  if (rows === 0) err(`${POS}가 포지션 줄을 그리지 않습니다`);
  if (fed !== rows) err(`${POS}의 포지션 줄 ${rows}곳 중 ${fed}곳만 자기 장부를 받습니다`);
  if (reloads !== rows) {
    err(`${POS}의 포지션 줄 ${rows}곳 중 ${reloads}곳만 청산 뒤 장부를 다시 읽습니다`);
  }
  if (!/const positions = auth \? ledger\.openPositions : \[\]/.test(pos)) {
    err(`${POS}의 포지션 출처가 usePaperLedger가 아닙니다 — 계좌가 갈립니다`);
  }
}

// ══════════════ ⑩ 사유는 한 곳에서, 값은 자르지 않는다 ══════════════
//
// 실기에서 `비율이 0입니다`가 두 번 찍혔다. 판정은 하나인데 그리는 곳이
// 둘이었다. 남기는 쪽은 **버튼에 가장 가까운 것**이다.
{
  for (const dup of ['sizing-locked', 'sizing-reason']) {
    if (slider.includes(dup)) {
      err(`${SLIDER}가 사유를 다시 그립니다 (${dup}) — 같은 문장이 두 번 보입니다`);
    }
  }
  const spots = (sheet.match(/data-testid="order-blocked-reason"/g) || []).length;
  if (spots !== 1) err(`잠금 사유를 그리는 곳이 ${spots}곳입니다 — 정확히 한 곳이어야 합니다`);

  for (const [name, body] of [['OrderControls', sheet], ['SizingSlider', slider]]) {
    if (/textOverflow: 'ellipsis'/.test(body)) {
      err(`${name}이 값을 …로 잘라 통과시킵니다 — 잘린 숫자는 자릿수를 잘못 세게 합니다`);
    }
    if (!/overflowWrap: 'anywhere'/.test(body)) {
      err(`${name}이 좁을 때 줄을 나누지 않습니다 — 값이 잘립니다`);
    }
  }
  if (!/<SizingSlider/.test(sheet)) err(`${SHEET}에 사이징 슬라이더가 없습니다`);
  // 칸 이름을 글자 단위로 쪼개지 않는다 — `손절<br/>거리`가 실기에서
  // `손절` / `거리` 두 칸 이름처럼 보였다.
  if (/손절<br\s*\/?>거리/.test(sheet)) {
    err('손절거리 라벨에 강제 줄바꿈이 있습니다 — 두 칸 이름으로 읽힙니다');
  }
  if (!/STOP_PCTS\.map\s*\(/.test(sheet)) {
    err(`${SHEET}가 손절 거리 프리셋을 그리지 않습니다 — 선물은 손절이 필수라 주문이 막힙니다`);
  }
  for (const legacy of ['setByRisk', '위험 0.5', '[0.5, 1, 2]']) {
    if (sheet.includes(legacy)) err(`주문 조작부에 옛 위험 역산 사이징이 따라왔습니다 (${legacy})`);
  }
  if (/\[25,\s*50,\s*75,\s*100\]/.test(sheet)) {
    err('주문 조작부가 사이징 퍼센트 줄을 슬라이더와 별도로 또 그립니다');
  }
  // 대기 주문 백엔드가 없으므로 지정가 UI를 만들지 않는다
  for (const banned of [/>\s*지정가\s*</, /['"]LIMIT['"]/, /\bBBO\b/, /orderType/]) {
    if (banned.test(sheet)) {
      err(`주문 조작부에 대기 주문 UI가 있습니다 (${banned}) — 모의 백엔드에 그 개념이 없습니다`);
    }
  }
}

// ══════════════ ⑪ 원스크린이 되살아나지 않는다 ══════════════
//
// 이름을 바꿔 돌아오는 것까지 막는다. **어느 한 화면도** 차트·주문폼·호가·
// 포지션을 동시에 들지 않는다.
{
  for (const f of walk('src')) {
    const c = code(read(f));
    const has = (re) => re.test(c);
    const chart = has(/<PriceChart|<ChartPane/);
    const orderForm = has(/<OrderControls/);
    const book = has(/<OrderBookView|<OrderBookPanel/);
    const posRow = has(/<PositionRow/);
    const n = [chart, orderForm, book, posRow].filter(Boolean).length;
    if (n >= 3) {
      err(`${f}가 차트·주문폼·호가·포지션 중 ${n}가지를 한 화면에 들고 있습니다 — 원스크린입니다`);
    }
  }
  // 옛 치수 정본이 돌아오지 않았는가
  for (const f of walk('src')) {
    if (/from '@\/lib\/trading\/oneScreen'/.test(read(f))) {
      err(`${f}가 옛 원스크린 치수 정본을 다시 씁니다`);
    }
  }
}

// ══════════════ ⑫ 도달할 수 없는 화면을 되살리지 않는다 ══════════════
//
// `TradingPage.tsx`는 별도 정리 대상이다. 여기서는 **정본 부품을 거기에
// 다시 붙이지 않는다**는 것만 고정한다.
{
  const tp = code(read('src/components/pages/TradingPage.tsx'));
  if (/<PaperOrderScreen|<InstrumentDetail|<ProOrderPanel|PriceChart|SizingSlider/.test(tp)) {
    err('도달할 수 없는 TradingPage에 정본 부품이 붙었습니다 — 거기서는 아무도 볼 수 없습니다');
  }
}

if (bad > 0) {
  console.error(`\n분리 화면 계약 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ 분리 화면 계약 — 탐색→상세→주문 사슬 · 상세 비상주 · host 1곳 ·'
  + ' 상세에 주문폼 없음 · 주문에 차트 없음 · 정본 판정 비우회 · 칸 출처 ·'
  + ' 능력 게이트 · ★간편/프로 동일 판정 · 프로 주문수단 보존 · 포지션 장부 일치 ·'
  + ' 사유 1곳 · 원스크린 비복귀');
