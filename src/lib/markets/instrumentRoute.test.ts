// src/lib/markets/instrumentRoute.test.ts
//
// **목록의 종목 이름을 거래소 심볼로 바꾸는 규칙.**
//
// 여기서 틀리면 조용히 틀린다. 잘못된 심볼은 예외를 내지 않고 차트·호가·
// 봉 조회로 그대로 흘러가서 **"거래가 없는 종목"처럼 보인다.** 화면에는
// 오류도 빈 칸도 없다.
//
// 실제로 그렇게 났다
// ──────────────────
// 판정이 `/USDT$|USDC$|BUSD$|BTC$|ETH$/`였다. `BTC`와 `ETH`는 결제통화
// 이면서 동시에 기초자산 이름이라, 목록의 `BTC` 한 종목이 "이미 완성된
// 쌍"으로 읽혔다:
//
//     BTC → BTC      (BTCUSDT가 아니라)
//     ETH → ETH
//
// 함수 주석의 계약과 정면으로 어긋난 상태였다.
//
// ★ 이 시험은 **helper가 있는지**를 보지 않는다
// ─────────────────────────────────────────────
// 이름만 맞춰 두고 안을 바꾸는 변경은 이름 검사를 통과한다. 그래서
// 여기서는 **입력을 넣고 나온 값**만 본다.
import { test, eq, assert } from '../../test/harness';
import { detailTargetOf, isCompletePair } from './instrumentRoute';

const sym = (s: string) => detailTargetOf({ symbol: s, category: 'coin' })?.symbol ?? null;

export function runInstrumentRouteTests() {
  console.log('[종목 → 상세 심볼]');

  test('★ 기초자산 이름만 오면 USDT를 붙인다', () => {
    eq(sym('BTC'), 'BTCUSDT');
    eq(sym('ETH'), 'ETHUSDT');
    eq(sym('SOL'), 'SOLUSDT');
  });

  test('★ BTC·ETH는 결제통화이기도 하다 — 그 이유로 완성 쌍이 되면 안 된다', () => {
    // 이것이 실제로 났던 고장이다. `BTC`가 `BTC$`에 걸려 그대로 나갔다.
    assert(sym('BTC') !== 'BTC', 'BTC가 그대로 나갔다 — 거래소에 없는 심볼이다');
    assert(sym('ETH') !== 'ETH', 'ETH가 그대로 나갔다');
    eq(isCompletePair('BTC'), false);
    eq(isCompletePair('ETH'), false);
    eq(isCompletePair('USDT'), false);
  });

  test('★ 이미 완성된 쌍은 그대로 둔다 — USDT를 또 붙이지 않는다', () => {
    eq(sym('BTCUSDT'), 'BTCUSDT');
    eq(sym('ETHUSDT'), 'ETHUSDT');
    eq(sym('SOLUSDC'), 'SOLUSDC');
    eq(sym('BNBBUSD'), 'BNBBUSD');
  });

  test('★ 코인/코인 쌍도 완성이다 (결제통화 앞에 기초자산이 있다)', () => {
    eq(sym('ETHBTC'), 'ETHBTC');
    eq(sym('BTCETH'), 'BTCETH');
    eq(isCompletePair('ETHBTC'), true);
    eq(isCompletePair('BTCETH'), true);
  });

  test('소문자·슬래시도 같은 규칙으로 읽는다', () => {
    eq(sym('btc'), 'BTCUSDT');
    eq(sym('BTC/USDT'), 'BTCUSDT');
    eq(sym('eth/btc'), 'ETHBTC');
  });

  test('시장은 언제나 현물이다 — 목록에서 들어오는 길은 현물이다', () => {
    eq(detailTargetOf({ symbol: 'BTC', category: 'coin' })?.market, 'SPOT');
    eq(detailTargetOf({ symbol: 'ETHBTC', category: 'coin' })?.market, 'SPOT');
  });

  test('코인이 아니라고 적혀 있으면 열지 않는다', () => {
    eq(detailTargetOf({ symbol: 'AAPL', category: 'stock' }), null);
    eq(detailTargetOf({ symbol: 'GOLD', type: 'commodity' }), null);
    // 적혀 있지 않으면 심볼로 본다 (기존 동작 유지)
    eq(detailTargetOf({ symbol: 'BTC' })?.symbol, 'BTCUSDT');
  });

  test('읽을 것이 없으면 null이다 — 기본 종목을 지어내지 않는다', () => {
    eq(detailTargetOf(null), null);
    eq(detailTargetOf({}), null);
    eq(detailTargetOf({ symbol: '' }), null);
    eq(detailTargetOf({ symbol: '   ' }), null);
  });

  test('이름은 있으면 싣고 없으면 비운다', () => {
    eq(detailTargetOf({ symbol: 'BTC', name: '비트코인' })?.name, '비트코인');
    eq(detailTargetOf({ symbol: 'BTC' })?.name, undefined);
  });
}
