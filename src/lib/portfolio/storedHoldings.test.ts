// src/lib/portfolio/storedHoldings.test.ts
//
// **리밸런싱·ETF 교체 도구가 보유 종목을 "없음"으로 읽지 않는가.**
//
// `tg_portfolio_v2`는 PortfolioPage가 `{ id: 'pos-…', assetId, buyPrice,
// quantity }`로 적는다. 두 도구는 `p.symbol || p.ticker || p.id`와
// `p.curPrice || p.avgPrice`를 읽고 있었다 — 종목 칸은 행 id('POS-…')가
// 되고 가격은 0이 되어, 종목을 몇 개를 넣어도 "리밸런싱할 자산이 없어요"가
// 떴다. 또 `prices`는 실제로 `Asset[]`(배열)인데 `prices[sym]`으로 읽어
// 실시세가 한 번도 쓰이지 않았다.
import { readFileSync } from 'fs';
import { test, eq, assert, close } from '../../test/harness';
import { valueStoredHoldings, sumKnownValues } from './storedHoldings';

/** PortfolioPage.submit()이 실제로 적는 모양 그대로 */
const stored = (o: Record<string, unknown> = {}) => ({
  id: 'pos-lx1a2b', assetId: 'BTC', assetName: '비트코인', category: 'crypto',
  buyPrice: 100, quantity: 2, addedAt: 1, ...o,
});

export function runStoredHoldingsTests() {
  console.log('[보유 종목 평가 — PortfolioPage가 적은 칸을 그대로 읽는다]');

  test('PortfolioPage가 적은 한 줄이 "자산 0"이 되지 않는다', () => {
    const h = valueStoredHoldings([stored()], []);
    eq(h.length, 1);
    eq(h[0].assetId, 'BTC');
    eq(h[0].value, 200);
    eq(h[0].priceSource, 'buy');
    eq(sumKnownValues(h), 200);
  });

  test('행 id(pos-…)를 종목으로 읽지 않는다', () => {
    const h = valueStoredHoldings([stored()], []);
    assert(h[0].assetId !== 'POS-LX1A2B' && h[0].assetId !== 'pos-lx1a2b', '행 id를 종목으로 읽음');
  });

  test('실제로 넘어오는 Asset[] 시세를 쓴다 (PortfolioPage와 같은 a.id → a.p)', () => {
    const prices = [{ id: 'BTC', p: 150 }, { id: 'ETH', p: 9 }];
    const h = valueStoredHoldings([stored()], prices);
    eq(h[0].price, 150);
    eq(h[0].priceSource, 'live');
    eq(h[0].value, 300);
  });

  test('Record 모양 시세도 받는다', () => {
    const h = valueStoredHoldings([stored({ assetId: 'SPY', category: 'etf' })], { SPY: 700 });
    eq(h[0].value, 1400);
    eq(h[0].category, 'etf');
  });

  test('시세 0·NaN은 실시세가 아니다 — 매수가로 되돌아간다', () => {
    const h = valueStoredHoldings([stored()], [{ id: 'BTC', p: 0 }]);
    eq(h[0].priceSource, 'buy');
    eq(h[0].value, 200);
  });

  test('가격을 전혀 모르면 0이 아니라 null — 합계에서 빠진다', () => {
    const h = valueStoredHoldings([stored({ buyPrice: undefined })], []);
    eq(h[0].value, null);
    eq(h[0].priceSource, 'none');
    eq(sumKnownValues(h), 0);
  });

  test('수량이 없거나 깨진 줄, 배열이 아닌 저장값은 버린다', () => {
    eq(valueStoredHoldings([stored({ quantity: 0 }), stored({ quantity: 'x' }), null], []).length, 0);
    eq(valueStoredHoldings({ not: 'array' }, []).length, 0);
  });

  test('category가 없으면 crypto (기존 도구와 같은 기본값)', () => {
    const h = valueStoredHoldings([stored({ category: undefined })], []);
    eq(h[0].category, 'crypto');
  });

  test('콤마가 섞인 숫자 문자열도 읽는다', () => {
    const h = valueStoredHoldings([stored({ buyPrice: '1,000', quantity: '1.5' })], []);
    close(h[0].value as number, 1500);
  });

  console.log('[배선 — 두 도구가 같은 평가 함수를 쓴다]');
  for (const file of ['src/components/RebalanceTool.tsx', 'src/components/EtfSwapTool.tsx']) {
    test(`${file}는 valueStoredHoldings를 쓰고 행 id를 종목으로 읽지 않는다`, () => {
      const src = readFileSync(file, 'utf8');
      assert(src.includes('valueStoredHoldings('), `${file}: valueStoredHoldings 미사용`);
      assert(!/p\.id\s*\|\|/.test(src) && !/\|\|\s*p\.id\b/.test(src), `${file}: p.id를 종목으로 읽음`);
    });
  }
}
