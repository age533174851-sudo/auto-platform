// src/lib/trading/streamEndpoints.test.ts
//
// 여기서 고정하는 사실은 하나다:
// **현물 화면이 선물 값을 보고 있으면 안 된다.**
import { test, eq, assert } from '../../test/harness';
import {
  streamMarketOf, hubKey, wsStreamUrl, ticker24hUrl, markPriceUrl,
  parseTicker24h, parseMarkPrice, depthRowsOf, STREAM_MARKETS,
} from './streamEndpoints';

export function runStreamEndpointTests() {
  // ── ★ 시장이 다르면 주소가 다르다 ──
  test('★ 현물과 선물은 서로 다른 소켓에 붙는다', () => {
    const spot = wsStreamUrl('SPOT', 'BTCUSDT');
    const usdm = wsStreamUrl('USDM', 'BTCUSDT');
    assert(!!spot && !!usdm, '주소를 못 만들었습니다');
    assert(spot !== usdm, '현물과 선물이 같은 주소를 씁니다');
    assert(spot!.includes('stream.binance.com'), '현물이 현물 스트림이 아닙니다');
    assert(!spot!.includes('fstream'), '현물이 선물 스트림에 붙습니다');
    assert(usdm!.includes('fstream.binance.com'), '선물이 선물 스트림이 아닙니다');
  });

  test('★ 24시간 통계도 시장별로 다른 곳에서 받는다', () => {
    const spot = ticker24hUrl('SPOT', 'BTCUSDT');
    const usdm = ticker24hUrl('USDM', 'BTCUSDT');
    assert(spot!.includes('api.binance.com/api/v3'), '현물 통계가 현물 API가 아닙니다');
    assert(!spot!.includes('fapi'), '현물 통계를 선물 API에서 받습니다');
    assert(usdm!.includes('fapi.binance.com/fapi/v1'), '선물 통계가 선물 API가 아닙니다');
  });

  test('★ 허브 키에 시장이 들어간다 — 안 그러면 소켓을 잘못 나눠 쓴다', () => {
    assert(hubKey('SPOT', 'BTCUSDT') !== hubKey('USDM', 'BTCUSDT'),
      '현물과 선물이 같은 허브를 씁니다');
  });

  // ── 모르는 시장은 기본값이 없다 ──
  test('모르는 시장은 null이다 — USDM으로 때우지 않는다', () => {
    eq(streamMarketOf('COINM'), null);
    eq(streamMarketOf(''), null);
    eq(streamMarketOf(null), null);
    eq(streamMarketOf(undefined), null);
    eq(streamMarketOf(123), null);
    eq(wsStreamUrl('COINM', 'BTCUSDT'), null);
    eq(ticker24hUrl(null, 'BTCUSDT'), null);
  });

  test('시장 이름은 대소문자/공백을 봐준다', () => {
    eq(streamMarketOf(' spot '), 'SPOT');
    eq(streamMarketOf('usdm'), 'USDM');
  });

  test('이상한 심볼은 주소로 만들지 않는다', () => {
    eq(wsStreamUrl('USDM', 'BTC/USDT'), null);
    eq(wsStreamUrl('USDM', 'BTC USDT'), null);
    eq(wsStreamUrl('USDM', '?symbol=x'), null);
    eq(wsStreamUrl('USDM', ''), null);
    eq(ticker24hUrl('SPOT', 'a'.repeat(21)), null);
  });

  // ── ★ 마크가격 ──
  test('★ 현물에는 마크가격이 없다 — 현재가로 대신 채우지 않는다', () => {
    eq(markPriceUrl('SPOT', 'BTCUSDT'), null);
    assert(markPriceUrl('USDM', 'BTCUSDT')!.includes('premiumIndex'),
      '선물 마크가격 주소가 아닙니다');
  });

  test('마크가격을 못 읽으면 null이다', () => {
    eq(parseMarkPrice(null), null);
    eq(parseMarkPrice({}), null);
    eq(parseMarkPrice({ markPrice: '' }), null);
    eq(parseMarkPrice({ markPrice: '0' }), null);
    eq(parseMarkPrice({ markPrice: 'abc' }), null);
    eq(parseMarkPrice({ markPrice: '65000.5' }), 65000.5);
  });

  // ── ★ 24시간 통계 파싱 ──
  test('★ 못 읽은 칸은 0이 아니라 null이다', () => {
    const t = parseTicker24h({ priceChangePercent: '1.5', highPrice: null, lowPrice: '', volume: 'x', quoteVolume: '10' })!;
    eq(t.changePct, 1.5);
    eq(t.high, null);      // null을 0으로 적으면 고가 0이 화면에 뜬다
    eq(t.low, null);
    eq(t.volume, null);
    eq(t.quoteVolume, 10);
  });

  test('아는 칸이 하나도 없으면 응답 자체를 못 읽은 것이다', () => {
    eq(parseTicker24h({ nope: 1 }), null);
    eq(parseTicker24h(null), null);
    eq(parseTicker24h('{}'), null);
  });

  test('변동률 0%는 못 읽음이 아니다', () => {
    eq(parseTicker24h({ priceChangePercent: '0' })!.changePct, 0);
  });

  test('음수 변동률을 그대로 읽는다', () => {
    eq(parseTicker24h({ priceChangePercent: '-3.21' })!.changePct, -3.21);
  });

  // ── ★ 호가 필드 이름이 시장마다 다르다 ──
  test('★ 선물은 {a,b}, 현물은 {asks,bids} — 둘 다 읽는다', () => {
    const fut = depthRowsOf({ a: [['1', '2']], b: [['0.9', '3']] })!;
    eq(fut.asks.length, 1);
    eq(fut.bids.length, 1);
    const spot = depthRowsOf({ asks: [['1', '2']], bids: [['0.9', '3']] })!;
    eq(spot.asks.length, 1);
    eq(spot.bids.length, 1);
  });

  test('한쪽만 있으면 호가가 아니다 — 반쪽 호가창을 그리지 않는다', () => {
    eq(depthRowsOf({ a: [['1', '2']] }), null);
    eq(depthRowsOf({ bids: [] }), null);
    eq(depthRowsOf(null), null);
  });

  test('빈 호가는 빈 호가다 — 못 읽음과 다르다', () => {
    const r = depthRowsOf({ a: [], b: [] })!;
    eq(r.asks.length, 0);
    eq(r.bids.length, 0);
  });

  test('아는 시장은 둘뿐이다', () => {
    eq(STREAM_MARKETS.join(','), 'SPOT,USDM');
  });
}
