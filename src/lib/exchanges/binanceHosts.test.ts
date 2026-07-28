// src/lib/exchanges/binanceHosts.test.ts
//
// 막으려는 사고:
//  1. 테스트넷 연결인데 실전 호스트로 주문이 나가는 것 — 진짜 돈이다
//  2. demo-api.binance.com 을 테스트넷으로 착각하는 것. 그 호스트는
//     응답하지만 실전과 같은 거래소다(심볼 3,659개로 동일). 이름만 데모다.
//  3. 실전 연결인데 테스트넷으로 나가는 것 — 주문이 허공으로 가고
//     사용자는 거래한 줄 안다. 1번보다 조용해서 더 오래 안 들킨다.
import { test, assert, eq } from '../../test/harness';
import { binanceBase, annotateAuthError } from './binance';

export function runBinanceHostTests() {
  console.log('[바이낸스 호스트 — 현물/선물 × 실전/테스트넷]');

  test('현물 실전은 api.binance.com', () => {
    eq(binanceBase(), 'https://api.binance.com');
    eq(binanceBase({}), 'https://api.binance.com');
    eq(binanceBase({ testnet: false }), 'https://api.binance.com');
  });

  test('현물 테스트넷은 testnet.binance.vision', () => {
    eq(binanceBase({ testnet: true }), 'https://testnet.binance.vision');
  });

  test('선물은 현물과 다른 호스트를 쓴다', () => {
    eq(binanceBase({ futures: true }), 'https://fapi.binance.com');
    eq(binanceBase({ futures: true, testnet: true }), 'https://demo-fapi.binance.com');
  });

  test('네 조합이 모두 서로 다르다', () => {
    const all = [
      binanceBase({ testnet: false, futures: false }),
      binanceBase({ testnet: true,  futures: false }),
      binanceBase({ testnet: false, futures: true }),
      binanceBase({ testnet: true,  futures: true }),
    ];
    eq(new Set(all).size, 4, `호스트가 겹친다: ${all.join(' / ')}`);
  });

  test('demo-api.binance.com 은 어디에도 쓰지 않는다', () => {
    // 실측: exchangeInfo 심볼 수가 실전과 같은 3,659개 → 테스트넷이 아니다.
    // 이름이 그럴듯해서 언젠가 누가 넣는다. 그때 이 테스트가 잡는다.
    for (const t of [true, false]) {
      for (const f of [true, false]) {
        assert(!binanceBase({ testnet: t, futures: f }).includes('demo-api'),
          'demo-api는 실전 미러다 — 진짜 돈으로 주문이 나간다');
      }
    }
  });

  console.log('[바이낸스 호스트 — 인증 실패에 목적지를 적는다]');

  test('인증 오류면 어느 거래소에 물었는지 붙인다', () => {
    const t = annotateAuthError('Invalid API-key, IP, or permissions for action. (-2015)', true);
    assert(t.includes('testnet.binance.vision'), t);
    assert(t.includes('demo-fapi'), '선물 키와 헷갈린 경우를 짚어야 한다');

    const l = annotateAuthError('Invalid API-key, IP, or permissions for action. (-2015)', false);
    assert(l.includes('api.binance.com'), l);
    assert(!l.includes('testnet.binance.vision'), '실전인데 테스트넷을 안내하면 안 된다');
  });

  test('인증과 무관한 오류는 건드리지 않는다', () => {
    const m = 'Filter failure: LOT_SIZE';
    eq(annotateAuthError(m, true), m);
    eq(annotateAuthError(m, false), m);
  });
}
