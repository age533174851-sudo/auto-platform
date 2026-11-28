// src/lib/market/hubBriefing.test.ts
//
// **이 테스트가 막는 것: 못 읽은 시세를 지어낸 숫자로 채워 브리핑하는 것.**
//
// `/api/hub?action=briefing`은 Binance를 못 읽으면 `btcPrice = 94230000` ·
// `btcChg = 2.14`를 그대로 내보냈다. 화면(허브 「오늘의 시장」, 인텔리전스
// 음성 브리핑)은 그것을 "BTC ₩9423만 (+2.14%) · BULLISH"로 실측처럼
// 그리고 읽어 줬다. Binance는 일부 지역 서버를 막기 때문에 이 폴백은
// 드문 경우가 아니다.
import { test, eq, assert } from '../../test/harness';
import { briefingFromMarket } from './hubBriefing';

const NOW = '2026-11-28T00:00:00.000Z';

export function runHubBriefingTests() {
  console.log('[허브 브리핑 — 못 읽은 시세를 지어내지 않는다]');

  test('시세를 못 읽으면 가격·변동률·감성을 null로 둔다', () => {
    const b = briefingFromMarket({ priceUsd: null, chgPct: null, fundingRate: null }, 1375, null, NOW);
    eq(b.btcPrice, null); eq(b.btcChg, null); eq(b.sentiment, null);
    eq(b.fundingRate, null); eq(b.fundBias, null);
    eq(b.marketOk, false);
    assert(!/9423/.test(b.aiSummary), '지어낸 가격이 요약에 들어갔습니다');
    assert(/읽지 못/.test(b.aiSummary), '못 읽었다는 사실을 요약이 말하지 않습니다');
    eq(b.source, 'unavailable');
  });

  test('NaN·0·음수 가격은 못 읽은 것으로 본다', () => {
    for (const p of [NaN, 0, -1]) {
      const b = briefingFromMarket({ priceUsd: p, chgPct: 1, fundingRate: 0 }, 1375, null, NOW);
      eq(b.btcPrice, null); eq(b.btcChg, null); eq(b.sentiment, null); eq(b.marketOk, false);
    }
  });

  test('시세를 읽으면 그대로 쓴다', () => {
    const b = briefingFromMarket({ priceUsd: 100000, chgPct: -3.5, fundingRate: 0.001 }, 1375, null, NOW);
    eq(b.btcPrice, 137500000); eq(b.btcChg, -3.5); eq(b.sentiment, 'STRONG_BEARISH');
    eq(b.fundBias, '롱 과열'); eq(b.marketOk, true); eq(b.source, 'fallback');
    assert(/13,750만|13750만/.test(b.aiSummary), b.aiSummary);
  });

  test('펀딩만 못 읽으면 펀딩 편향을 「중립」으로 적지 않는다', () => {
    const b = briefingFromMarket({ priceUsd: 100000, chgPct: 0.5, fundingRate: null }, 1375, null, NOW);
    eq(b.fundingRate, null); eq(b.fundBias, null);
    assert(!/중립/.test(b.aiSummary), b.aiSummary);
  });

  test('AI 요약은 시세를 읽었을 때만 쓴다', () => {
    eq(briefingFromMarket({ priceUsd: 100000, chgPct: 0, fundingRate: 0 }, 1375, 'AI', NOW).source, 'openai');
    const b = briefingFromMarket({ priceUsd: null, chgPct: null, fundingRate: null }, 1375, 'AI', NOW);
    eq(b.source, 'unavailable'); assert(b.aiSummary !== 'AI', 'AI 요약이 지어낸 숫자 위에 쓰였습니다');
  });
}
