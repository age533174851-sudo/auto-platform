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

if (bad > 0) {
  console.error(`\n시장 데이터 정직성 검사 실패 (${bad}건)`);
  process.exit(1);
}
console.log('✅ 시장 데이터 정직성 — 지어낸 기사 비노출 · 시총 표 격리 ·'
  + ' 주기 능력표 1곳 · 변동률 기준 구분 · 칩 비수축');
