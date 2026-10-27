// src/test/integration/venueHarnessOrderSends.test.ts
//
// FakeVenue의 주문 전송 계측 자체를 고정한다.
// Gate 조건부 손절은 /price_orders POST이므로 /orders만 세면
// "손절을 다시 보내지 않았다"는 테스트가 거짓으로 통과할 수 있다.
// 거래소/DB/네트워크 접근 없이 합성 호출만 사용한다.
import { test, eq, assert } from '../harness';
import { FakeVenue, type VenueCall } from './venueHarness';

const call = (method: string, path: string): VenueCall => ({
  method, path, host: 'offline.invalid', params: {}, body: null, authed: false,
});

export function runVenueHarnessOrderSendsTests() {
  console.log('[통합 하네스 — 주문 전송 계측 사각지대 방지]');
  const venue = new FakeVenue();
  venue.calls.push(
    call('POST', '/fapi/v1/order'),                   // Binance
    call('POST', '/api/v4/futures/usdt/orders'),      // Gate 일반 주문
    call('POST', '/api/v4/futures/usdt/price_orders'),// Gate 조건부 손절/익절
    call('POST', '/api/v4/spot/orders'),              // Gate 현물
    call('GET', '/api/v4/futures/usdt/price_orders'), // 조회는 전송 아님
    call('DELETE', '/api/v4/futures/usdt/price_orders/77'),
    call('POST', '/api/v4/futures/usdt/positions'),   // 주문 외 POST
    call('POST', '/api/v4/futures/usdt/price_orders_backup'),
  );

  test('★★ Gate price_orders POST도 주문 전송에 반드시 포함한다', () => {
    eq(venue.countOf('/price_orders', 'POST'), 1);
    eq(venue.orderSends().filter(c => c.path.endsWith('/price_orders')).length, 1,
      'Gate 손절 중복 전송이 주문 0건으로 위장된다');
  });
  test('기존 Binance/Gate 선물·현물 주문 계측을 유지한다', () => {
    eq(venue.orderSends().length, 4, '조회·삭제·비주문 POST가 전송으로 섞였거나 주문이 빠졌다');
    for (const path of ['/fapi/v1/order', '/api/v4/futures/usdt/orders', '/api/v4/spot/orders']) {
      assert(venue.orderSends().some(c => c.path === path), `누락된 전송: ${path}`);
    }
  });
  test('GET·DELETE·비주문 POST는 주문 전송으로 세지 않는다', () => {
    assert(venue.orderSends().every(c => c.method === 'POST'));
    assert(venue.orderSends().every(c => !c.path.includes('positions')
      && !c.path.includes('backup')));
  });
}
