// src/lib/markets/ranking.test.ts
//
// **목록 순서는 값보다 세게 읽힌다.** 맨 위에 있는 것이 "가장 큰 자산"으로
// 읽히고, 사용자는 그 순서를 근거로 무엇을 볼지 정한다.
//
// 그래서 순위를 지어내지 않는다. 손으로 적은 시총 표로 줄 세우던 것을
// 뺐고, 대신 거래소가 관측한 거래대금을 쓴다 — **같은 통화 안에서만.**
import { test, eq, assert } from '../../test/harness';
import {
  tradingValueOf, rankByTradingValue,
  MARKET_CAP_RANKING_AVAILABLE, RANKING_AXES,
} from './ranking';

export function runRankingTests() {
  console.log('[목록 순위]');

  test('★ 거래대금은 거래소 원가 × 거래량이다', () => {
    const r = tradingValueOf({ quotePrice: 100, quoteCurrency: 'usdt', volume: 3 });
    eq(r.value, 300);
    eq(r.currency, 'USDT');
    eq(r.reason, null);
  });

  test('★ 통화를 모르면 순위를 만들지 않는다 — 다른 통화와 섞이면 환율을 1로 쓰는 셈이다', () => {
    const r = tradingValueOf({ quotePrice: 100, quoteCurrency: null, volume: 3 });
    eq(r.value, null);
    assert(!!r.reason);
  });

  test('★ 값을 못 받으면 0으로 세지 않는다', () => {
    for (const bad of [null, undefined, '', NaN, false]) {
      eq(tradingValueOf({ quotePrice: bad as any, quoteCurrency: 'USDT', volume: 3 }).value, null);
      eq(tradingValueOf({ quotePrice: 100, quoteCurrency: 'USDT', volume: bad as any }).value, null);
    }
  });

  test('★ 같은 통화 안에서만 줄 세운다', () => {
    const items = [
      { id: 'a', qp: 1, qc: 'USDT', v: 10 },     // 10 USDT
      { id: 'b', qp: 1, qc: 'USDT', v: 50 },     // 50 USDT
      { id: 'c', qp: 1000, qc: 'KRW', v: 1000 }, // 1,000,000 KRW
    ];
    const r = rankByTradingValue(items, (x) => ({
      quotePrice: x.qp, quoteCurrency: x.qc, volume: x.v,
    }));
    eq(r.universes.length, 2, '통화가 둘인데 한 묶음으로 합쳤습니다');
    const krw = r.universes.find(u => u.currency === 'KRW')!;
    const usdt = r.universes.find(u => u.currency === 'USDT')!;
    eq(usdt.items.map(x => (x.item as any).id).join(','), 'b,a');
    eq(krw.items.length, 1);
    // KRW 1,000,000이 USDT 50보다 '크다'고 말하지 않는다 — 다른 자다.
    assert(krw !== usdt, '두 통화가 한 순위에 들어갔습니다');
  });

  test('★ 비교할 수 없는 것은 순위를 만들지 않는다 — 맨 아래로 보내지도 않는다', () => {
    const items = [
      { id: 'ok', qp: 2, qc: 'USDT', v: 5 },
      { id: 'no', qp: null, qc: 'USDT', v: 5 },
    ];
    const r = rankByTradingValue(items, (x) => ({
      quotePrice: x.qp, quoteCurrency: x.qc, volume: x.v,
    }));
    eq(r.unavailable.length, 1);
    eq((r.unavailable[0].item as any).id, 'no');
    eq(r.unavailable[0].status, 'UNAVAILABLE');
    assert(!!r.unavailable[0].reason, '사유 없이 순위에서 뺐습니다');
    // 순위 묶음에는 섞이지 않았다
    eq(r.universes[0].items.length, 1);
  });

  test('★ 시가총액순은 아직 고를 수 없다 — 정본 공급자가 없다', () => {
    eq(MARKET_CAP_RANKING_AVAILABLE, false);
    // `as const`라 타입만 보면 이미 불가능한 비교다. 그래도 남기는 이유는
    // **목록에 값을 더하는 것은 런타임 변경**이기 때문이다 — 누가
    // `marketCap`을 넣으면 이 줄이 먼저 빨개진다.
    const ids = RANKING_AXES.map(a => String(a.id));
    assert(ids.indexOf('marketCap') < 0, '시총순이 선택지에 들어갔습니다');
  });

  test('★ 한 주당 가격순은 선택지에서 뺐다', () => {
    const ids = RANKING_AXES.map(a => String(a.id));
    assert(ids.indexOf('price') < 0,
      '주당 가격순이 남아 있습니다 — 액면분할 한 번에 뒤집히는 숫자입니다');
  });

  test('빈 목록·이상한 입력에도 터지지 않는다', () => {
    eq(rankByTradingValue([], () => ({})).universes.length, 0);
    eq(rankByTradingValue(null as any, () => ({})).unavailable.length, 0);
  });
}
