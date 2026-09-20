// src/lib/trading/tradeContext.test.ts
//
// **이 파일이 지키는 것은 두 가지다.**
//
//   ① 모드를 바꿔도 사용자가 고른 것이 그대로다
//   ② 현물 "매도"가 공매도 주문으로 변환되지 않는다
//
// ②가 이 Phase에서 제일 위험한 자리다. `OrderIntent.side`는 `'BUY'|'SELL'`이고
// `/api/paper/order`의 `side`는 `'LONG'|'SHORT'`다. 모양이 비슷해서 그냥
// 매핑하면 현물 매도가 숏 진입이 된다.
import { test, eq, assert } from '../../test/harness';
import {
  readTradeContext, sameTradeContext, routeFor, openSideFor,
  type TradeContext,
} from './tradeContext';

const ctx = (o: Partial<TradeContext>): TradeContext => ({
  symbol: 'BTCUSDT', market: 'SPOT', direction: 'BUY', ...o,
} as TradeContext);

export function runTradeContextTests() {
  // ── ★ 현물 매도는 진입 경로로 가지 않는다 ──

  test('★ 현물 SELL은 보유분 매도 경로다 — 공매도가 아니다', () => {
    eq(routeFor(ctx({ market: 'SPOT', direction: 'SELL' })), 'SELL_HOLDING');
  });

  test('★ 현물 SELL에는 진입 방향이 없다 — SHORT로 바뀌지 않는다', () => {
    eq(openSideFor(ctx({ market: 'SPOT', direction: 'SELL' })), null);
  });

  test('현물 BUY는 진입이고 방향은 LONG이다', () => {
    eq(routeFor(ctx({ market: 'SPOT', direction: 'BUY' })), 'OPEN_POSITION');
    eq(openSideFor(ctx({ market: 'SPOT', direction: 'BUY' })), 'LONG');
  });

  test('★ 선물 SELL은 진짜 숏 진입이다 — 현물과 같은 규칙을 쓰지 않는다', () => {
    eq(routeFor(ctx({ market: 'USDM', direction: 'SELL' })), 'OPEN_POSITION');
    eq(openSideFor(ctx({ market: 'USDM', direction: 'SELL' })), 'SHORT');
  });

  test('선물 BUY는 롱 진입이다', () => {
    eq(openSideFor(ctx({ market: 'USDM', direction: 'BUY' })), 'LONG');
  });

  test('문맥이 없으면 경로도 방향도 없다 — 기본값을 만들지 않는다', () => {
    eq(routeFor(null), null);
    eq(openSideFor(null), null);
  });

  // ── 읽기: 못 읽으면 null ──

  test('제대로 된 문맥을 읽는다 (심볼은 대문자로)', () => {
    const r = readTradeContext({ symbol: 'btcusdt', market: 'SPOT', direction: 'BUY' });
    assert(r != null, '읽지 못했습니다');
    eq(r!.symbol, 'BTCUSDT');
    eq(r!.market, 'SPOT');
    eq(r!.direction, 'BUY');
  });

  test('★ 종목을 모르면 null — 빈 종목으로 주문 화면을 열지 않는다', () => {
    eq(readTradeContext({ symbol: '', market: 'SPOT', direction: 'BUY' }), null);
    eq(readTradeContext({ symbol: '   ', market: 'SPOT', direction: 'BUY' }), null);
    eq(readTradeContext({ market: 'SPOT', direction: 'BUY' }), null);
  });

  test('★ 모르는 시장을 SPOT으로 흘려보내지 않는다', () => {
    eq(readTradeContext({ symbol: 'BTCUSDT', market: 'COINM', direction: 'BUY' }), null);
    eq(readTradeContext({ symbol: 'BTCUSDT', market: '', direction: 'BUY' }), null);
    eq(readTradeContext({ symbol: 'BTCUSDT', direction: 'BUY' }), null);
  });

  test('★ 방향을 모르면 BUY로 채우지 않는다', () => {
    eq(readTradeContext({ symbol: 'BTCUSDT', market: 'SPOT', direction: 'LONG' }), null);
    eq(readTradeContext({ symbol: 'BTCUSDT', market: 'SPOT' }), null);
  });

  test('객체가 아니면 null — 던지지 않는다', () => {
    eq(readTradeContext(null), null);
    eq(readTradeContext(undefined), null);
    eq(readTradeContext('BTCUSDT'), null);
    eq(readTradeContext(7), null);
  });

  // ── ★ 모드 전환에서 잃지 않는다 ──

  test('★ 같은 문맥은 같다고 읽는다 (전환 후 비교의 근거)', () => {
    assert(sameTradeContext(ctx({}), ctx({})), '같은 문맥이 다르다고 나왔습니다');
  });

  test('★ 종목·시장·방향 중 하나라도 달라지면 다르다', () => {
    assert(!sameTradeContext(ctx({}), ctx({ symbol: 'ETHUSDT' })), '종목 차이를 못 잡았습니다');
    assert(!sameTradeContext(ctx({}), ctx({ market: 'USDM' })), '시장 차이를 못 잡았습니다');
    assert(!sameTradeContext(ctx({}), ctx({ direction: 'SELL' })), '방향 차이를 못 잡았습니다');
  });

  test('null과는 같지 않다 — 없는 것을 같다고 하지 않는다', () => {
    assert(!sameTradeContext(null, ctx({})), 'null이 같다고 나왔습니다');
    assert(!sameTradeContext(ctx({}), null), 'null이 같다고 나왔습니다');
    assert(!sameTradeContext(null, null), 'null끼리 같다고 나왔습니다');
  });

  test('★ 이 타입에는 계좌·장부에 관한 것이 없다 (challengeId 두 번째 권위 금지)', () => {
    const r = readTradeContext({
      symbol: 'BTCUSDT', market: 'SPOT', direction: 'BUY',
      // 넣어 보내도 문맥에 남지 않아야 한다.
      challengeId: '11111111-1111-1111-1111-111111111111',
      paperAccountId: '22222222-2222-2222-2222-222222222222',
    });
    assert(r != null, '읽지 못했습니다');
    eq(Object.keys(r as any).sort().join(','), 'direction,market,symbol');
  });
}
