// src/lib/markets/venueQuote.test.ts
//
// **시세를 못 읽었을 때 값을 지어내지 않는가. 그리고 그 값이 연결에
// 묶여 있는가.**

import { test, eq, assert } from '../../test/harness';
import { fetchVenueQuote, toVenueSymbol } from './venueQuote';
import { scopedValueFor } from './orderCurrency';

const okRes = (body: any) => ({ ok: true, json: async () => body });
const badRes = (body: any) => ({ ok: false, json: async () => body });

export function runVenueQuoteTests() {
  console.log('[venue 시세 — 하나의 읽기 경로]');

  test('종목 표기가 무엇이든 하나의 거래소 심볼이 된다', () => {
    for (const raw of ['BTC', 'btc', 'BTCUSDT', 'btcusdt', 'BTC/USDT']) {
      eq(toVenueSymbol(raw), 'BTCUSDT');
    }
    eq(toVenueSymbol(''), '');
    eq(toVenueSymbol(null), '');
  });

  test('읽으면 연결에 묶인 값이 나온다', async () => {
    let seen = '';
    const q = await fetchVenueQuote({
      connectionId: 'conn-A', symbol: 'eth',
      fetchImpl: async (url: string) => { seen = url; return okRes({ ok: true, price: 2500, exchange: 'gate', priceSource: 'gate_mark', asOf: 'now' }); },
    });
    assert(q != null, '읽지 못했습니다');
    eq(q!.connectionId, 'conn-A');
    eq(q!.value.price, 2500);
    eq(q!.value.exchange, 'gate');
    assert(seen.includes('connectionId=conn-A'), `연결이 붙지 않았습니다: ${seen}`);
    assert(seen.includes('symbol=ETHUSDT'), `심볼이 붙지 않았습니다: ${seen}`);
  });

  test('**다른 연결의 값으로 읽히지 않는다**', async () => {
    const q = await fetchVenueQuote({
      connectionId: 'conn-A', symbol: 'ETH',
      fetchImpl: async () => okRes({ ok: true, price: 2500, exchange: 'gate' }),
    });
    eq(scopedValueFor(q, 'conn-A')?.price, 2500);
    eq(scopedValueFor(q, 'conn-B'), null);
    eq(scopedValueFor(q, ''), null);
  });

  test('실패하면 null이다 — 지어낸 값이 없다', async () => {
    const cases: any[] = [
      async () => badRes({ error: 'auth_required' }),
      async () => okRes({ ok: false, error: 'exchange_unreachable' }),
      async () => okRes({ ok: true, price: null }),
      async () => okRes({ ok: true, price: 0 }),
      async () => okRes({ ok: true, price: -1 }),
      async () => { throw new Error('network'); },
    ];
    for (const fetchImpl of cases) {
      const q = await fetchVenueQuote({ connectionId: 'conn-A', symbol: 'ETH', fetchImpl });
      eq(q, null);
    }
  });

  test('연결이 없으면 읽지 않는다 — 거래소·환경이 정해지지 않는다', async () => {
    let called = 0;
    const q = await fetchVenueQuote({
      connectionId: '', symbol: 'ETH',
      fetchImpl: async () => { called++; return okRes({ ok: true, price: 2500 }); },
    });
    eq(q, null);
    eq(called, 0);
  });
}
