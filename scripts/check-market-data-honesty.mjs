#!/usr/bin/env node
// scripts/check-market-data-honesty.mjs
//
// **없는 데이터를 있는 것처럼 내보내지 않는지 배선으로 확인한다.**
//
// 감사에서 셋이 나왔다. 전부 오류를 내지 않고 화면만 멀쩡했다.
//
//   ① 지어낸 기사(`MOCK_NEWS`)가 `ok: true`로 나갔다.
//      `source: 'TRAIGO'` · `url: '#'`짜리 우리가 쓴 글인데 화면에서는
//      실제 기사와 구별되지 않았고, 일간 브리핑과 뉴스 상세가 받아 갔다.
//
//   ② 손으로 적은 시가총액 표가 응답의 `marketCap`으로 나가고, 그 값이
//      목록의 **기본 정렬 기준**이었다. 순위는 "무엇이 큰 자산인가"를
//      말하는 셈이라 값보다 세게 읽힌다.
//
//   ③ 차트 주기 버튼이 컴포넌트 안에 따로 적혀 있었다. 능력표와 갈리면
//      화면은 400을 받는 버튼을 그린다.
//
// 그리고 변동률의 기준(주식 = 어제 종가 / 코인 = 24시간 롤링)을 같은
// 말로 적지 않는지도 본다.
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const err = (m) => { console.error(`❌ ${m}`); console.error(`::error::${m}`); bad += 1; };
const read = (p) => existsSync(p) ? readFileSync(p, 'utf8') : '';
const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── ① 지어낸 기사를 진짜처럼 내보내지 않는다 ──
{
  const route = code(read('src/app/api/market/news/route.ts'));
  if (!route) err('market/news 라우트를 읽지 못했습니다');
  // 공급자가 없을 때 **실패라고 말하는가**. 조용한 폴백이 있으면 안 된다.
  if (!/news_provider_unconfigured/.test(route)) {
    err('뉴스 공급자가 없을 때 실패를 말하지 않습니다 — 지어낸 기사가 진짜처럼 나갑니다');
  }
  if (!/items\.length === 0 && !allowMock/.test(route)) {
    err('지어낸 기사로 내려가는 길이 명시적으로 막혀 있지 않습니다');
  }
  // 그래도 나가는 경우에는 출처에 그렇게 적혀야 한다.
  if (!/MOCK_NOT_REAL_NEWS/.test(route)) {
    err('지어낸 기사가 나갈 때 출처에 그 사실이 적히지 않습니다');
  }
}

// ── ② 손으로 적은 시총을 권위로 쓰지 않는다 ──
{
  const route = code(read('src/app/api/prices/route.ts'));
  if (!route) err('prices 라우트를 읽지 못했습니다');
  if (!/MCAP_QUARANTINED_NOT_REAL/.test(route)) {
    err('시총 표가 격리 표시 없이 쓰이고 있습니다');
  }
  // 응답에 실리면 화면이 실제 시총으로 읽는다.
  if (/marketCap:\s*MCAP/.test(route)) {
    err('지어낸 시총이 응답의 marketCap으로 나갑니다');
  }
  // 정렬은 값보다 세게 읽힌다 — 지어낸 순위를 기본으로 두지 않는다.
  if (/sort\(\(a,\s*b\)\s*=>\s*\(b\.marketCap/.test(route)) {
    err('지어낸 시총으로 목록 순서를 정합니다 — 실제 공급자가 생길 때까지 시총순을 켜지 않습니다');
  }
}

// ── ③ 주기 버튼은 능력표가 정한다 ──
{
  const cap = code(read('src/lib/markets/intervalCapability.ts'));
  const chart = code(read('src/components/trading/PriceChart.tsx'));
  const candles = code(read('src/app/api/market/candles/route.ts'));
  if (!cap) err('봉 주기 능력표가 없습니다');

  if (!/CHART_INTERVALS = supportedIntervals\(\)/.test(chart)) {
    err('차트가 주기 목록을 스스로 적습니다 — 능력표와 갈리면 400을 받는 버튼이 생깁니다');
  }
  // 능력표의 SUPPORTED와 라우트 화이트리스트가 같은가. **문자열로 대조한다.**
  const routeList = (candles.match(/const INTERVALS = \[([^\]]*)\]/) || [])[1] || '';
  const routeIds = (routeList.match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));
  const capIds = [...cap.matchAll(/\{ id: '([^']+)', label: '[^']*', support: 'SUPPORTED'/g)]
    .map(m => m[1]);
  if (!routeIds.length || !capIds.length) {
    err('주기 목록을 읽지 못했습니다 — 검사가 헛돌고 있습니다');
  } else if (routeIds.join(',') !== capIds.join(',')) {
    err(`능력표(${capIds.join(',')})와 봉 라우트(${routeIds.join(',')})가 다릅니다`);
  }
  // 못 주는 주기가 SUPPORTED로 올라가 있지 않은가.
  for (const id of ['1s', 'tick']) {
    if (new RegExp(`\\{ id: '${id}',[^}]*support: 'SUPPORTED'`).test(cap)) {
      err(`${id}가 지원으로 잡혀 있습니다 — 체결 스트림이 없습니다`);
    }
  }
}

// ── ④ 변동률 기준을 한 말로 뭉개지 않는다 ──
{
  const basis = code(read('src/lib/markets/changeBasis.ts'));
  if (!basis) err('변동률 기준 계약이 없습니다');
  if (!/PREVIOUS_CLOSE/.test(basis) || !/ROLLING_24H/.test(basis)) {
    err('주식(어제 종가)과 코인(24시간)을 구분하지 않습니다');
  }
  // 코인에 '전일대비'를 붙이면 어제 종가 대비로 읽힌다.
  if (/ROLLING_24H:\s*\{[^}]*label: '전일대비'/.test(basis)) {
    err('코인 24시간 변동률에 전일대비 이름을 붙였습니다');
  }
  if (!/UNKNOWN/.test(basis)) {
    err('기준을 모를 때의 상태가 없습니다 — 모르면 숫자를 적지 않아야 합니다');
  }
}

// ── ⑤ 가로 칩이 눌려서 글자가 쪼개지지 않는다 ──
//
// 실측: 393×852에서 `미국주식`이 폭 28px 칸에 갇혀 세로로 쪼개졌다
// (내용 61px). 430×932에서도 같았다 — 폭 문제가 아니라 flex 수축이다.
{
  const ui = read('src/components/pages/SharedUI.tsx');
  const pill = (ui.match(/export function Pill\([^]*?\n\}/) || [])[0] || '';
  if (!pill) err('Pill 컴포넌트를 찾지 못했습니다');
  if (!/flexShrink:\s*0/.test(pill)) {
    err('Pill에 flexShrink:0이 없습니다 — 가로 스크롤 대신 칩이 눌려 글자가 쪼개집니다');
  }
  if (!/whiteSpace:\s*'nowrap'/.test(pill)) {
    err('Pill에 nowrap이 없습니다');
  }
}

// ── ⑥ 종목 상세가 정본만 읽는가 ──
//
// 새 화면이 지어낸 값을 물려받는 것이 가장 쉬운 사고다. 상세 화면이
// 만들어지는 순간 `MOCK_NEWS`·`MCAP`·`AutoBotLabPage`의 손으로 적은
// 펀더멘털이 전부 "그럴듯한 칸"을 채울 후보가 된다.
{
  const d = code(read('src/components/instrument/InstrumentDetail.tsx'));
  if (!d) err('종목 상세 화면을 찾지 못했습니다');

  // 지어낸 기사 경로를 부르지 않는다. 정본은 stored 하나다.
  if (/\/api\/market\/news/.test(d)) {
    err('상세 화면이 지어낸 기사 경로를 읽습니다 — 정본은 /api/news/stored입니다');
  }
  if (!/\/api\/news\/stored/.test(d)) {
    err('상세 화면이 정본 뉴스를 읽지 않습니다');
  }
  if (!/affectedAssets/.test(d)) {
    err('상세 화면이 이 종목과 매핑된 기사만 거르지 않습니다');
  }
  // 손으로 적은 펀더멘털/시총을 끌어오지 않는다.
  for (const banned of [/AutoBotLab/, /MCAP/, /roe/i, /opMargin/, /debtRatio/]) {
    if (banned.test(d)) {
      err(`상세 화면이 손으로 적은 펀더멘털을 씁니다 (${banned})`);
    }
  }
  // 칸을 그려도 되는지 먼저 묻는다.
  if (!/instrumentFieldPlan\(/.test(d)) {
    err('상세 화면이 칸 권위를 묻지 않습니다 — 출처 없는 칸이 생깁니다');
  }
  // 변동률 기준을 스스로 정하지 않는다.
  if (!/changeView\(/.test(d)) {
    err('상세 화면이 변동률 기준을 정본에 묻지 않습니다');
  }
  // 보유는 주문과 같은 장부에서 온다.
  if (/\/api\/paper\/account/.test(d)) {
    err('상세 화면이 기본 계좌 라우트를 읽습니다 — 챌린지에서 장부가 갈립니다');
  }
  if (!/usePaperLedger\(/.test(d) || !/usePaperTarget\(/.test(d)) {
    err('상세 화면의 보유가 정본 장부에서 오지 않습니다');
  }
  // 미실현 손익 정본이 없으므로 여기서 만들지 않는다.
  for (const banned of [/unrealized/i, /roe[A-Z]/, /pnlPct/]) {
    if (banned.test(d)) err(`상세 화면이 손익을 스스로 계산합니다 (${banned})`);
  }
}

// ── ⑦ 상세 화면이 사람이 다니는 길에 붙어 있는가 ──
//
// 만들어 놓고 안 거는 것이 이 저장소의 1번 고장이다. 그리고 예전 모달과
// 새 상세가 **동시에** 정본이 되면 둘이 갈린다.
{
  const page = code(read('src/app/page.tsx'));
  if (!/<InstrumentDetail/.test(page)) {
    err('page.tsx가 종목 상세를 그리지 않습니다 — 만들어 놓고 안 걸었습니다');
  }
  if (!/detailTargetOf\(/.test(page)) {
    err('page.tsx가 상세 대상 판단을 정본에 묻지 않습니다');
  }
  // 하나만 뜬다 — 삼항으로 갈려 있어야 한다.
  if (!/detailTarget \? \(/.test(page)) {
    err('새 상세와 옛 모달이 동시에 뜰 수 있습니다 — 정본이 둘이 됩니다');
  }
  // 도달 불가였던 옛 거래 화면을 되살리지 않는다.
  const tp = code(read('src/components/pages/TradingPage.tsx'));
  if (/<InstrumentDetail/.test(tp)) {
    err('도달 불가 화면(TradingPage)에 상세를 붙였습니다');
  }
}

// ── ⑧ 목록 순위가 통화를 섞지 않는가 ──
{
  const rank = code(read('src/lib/markets/ranking.ts'));
  const market = code(read('src/components/pages/MarketPage.tsx'));
  if (!/export const MARKET_CAP_RANKING_AVAILABLE = false;/.test(rank)) {
    err('시총순이 고를 수 있게 열려 있습니다 — 정본 공급자가 없습니다');
  }
  // 통화별로 나눠 비교하는가. **묶는 코드가 실제로 있어야 한다.**
  // **이름이 아니라 묶는 키를 본다.** 처음에는 `byCurrency`라는 낱말만
  // 찾았는데, 그러면 키를 상수로 바꿔 통화를 다 합쳐도 통과한다 —
  // 실제로 뮤테이션이 그 틈으로 살아남았다.
  if (!/byCurrency\.get\(tv\.currency\)/.test(rank)
    || !/byCurrency\.set\(tv\.currency,/.test(rank)) {
    err('거래대금 순위가 통화별로 나누지 않습니다 — 환율을 1로 쓰는 셈입니다');
  }
  if (!/useState\('tradingValue'\)/.test(market)) {
    err('목록 기본 정렬이 거래대금이 아닙니다');
  }
  if (/sort === 'price'/.test(market)) {
    err('주당 가격순이 목록 정렬에 남아 있습니다');
  }
  // 표시용 환산가로 줄 세우지 않는다.
  if (/quotePrice: a\.p\b/.test(market)) {
    err('표시용 환산가로 순위를 냅니다 — 상수가 순위를 정하게 됩니다');
  }
}

if (bad > 0) {
  console.error(`\n시장 데이터 정직성 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ 시장 데이터 정직성 — 지어낸 기사 비노출 · 시총 표 격리 ·'
  + ' 주기 능력표 1곳 · 변동률 기준 구분 · 칩 비수축 ·'
  + ' 상세 정본 전용 · 상세 배선 1곳 · 순위 통화 분리');
