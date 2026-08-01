import { test, eq } from '../../test/harness';
import { toTradingSymbol } from './recordPrediction';

export function runRecordPredictionTests() {
  console.log('[AI 예측 기록 — 자산 이름을 종목으로]');

  test('코인 심볼은 USDT를 붙인다', () => {
    eq(toTradingSymbol('BTC'), 'BTCUSDT');
    eq(toTradingSymbol('eth'), 'ETHUSDT');
    eq(toTradingSymbol('  SOL '), 'SOLUSDT');
  });

  test('이미 종목 이름이면 그대로 둔다 — USDTUSDT를 만들지 않는다', () => {
    eq(toTradingSymbol('BTCUSDT'), 'BTCUSDT');
    eq(toTradingSymbol('BTC_USDT'), 'BTCUSDT');
    eq(toTradingSymbol('ETHUSDC'), 'ETHUSDC');
  });

  test('매매 종목이 아닌 것은 버린다 — 없는 종목의 합의를 쌓지 않는다', () => {
    for (const a of ['NASDAQ', 'SPX', 'DXY', 'VIX', 'GOLD', 'USD', 'KRW']) {
      eq(toTradingSymbol(a), null, a);
    }
  });

  test('빈 값과 이상한 값은 null이다', () => {
    eq(toTradingSymbol(null), null);
    eq(toTradingSymbol(''), null);
    eq(toTradingSymbol('   '), null);
    eq(toTradingSymbol('연준 금리 인상'), null);
  });

  test('견적 통화를 바꿀 수 있다', () => {
    eq(toTradingSymbol('BTC', 'USDC'), 'BTCUSDC');
  });
}
