// ─────────────────────────────────────────────────────────────
// TRAIGO Exchange Router — dispatches to correct adapter
// ─────────────────────────────────────────────────────────────
import type { ExchangeId, TestResult, ExchangeBalance } from './types';
import { testBinance, getBalancesBinance } from './binance';
import { testBybit,   getBalancesBybit   } from './bybit';
import { testOKX,     getBalancesOKX     } from './okx';
import { testGate,    getBalancesGate    } from './gate';
import { testUpbit,   getBalancesUpbit   } from './upbit';
import { testBithumb, getBalancesBithumb } from './bithumb';
import { testFuturesConnection } from './binanceFutures';

export async function testExchange(
  exchange: ExchangeId,
  key: string,
  secret: string,
  passphrase?: string,
  isTestnet?: boolean
): Promise<TestResult> {
  switch (exchange) {
    case 'binance':
      // 테스트넷이면 선물 테스트넷으로 검증 (testnet.binancefuture.com)
      if (isTestnet) {
        try {
          const r = await testFuturesConnection(key, secret, true);
          return r.success
            ? { success: true, message: r.message || '테스트넷 연결 성공' }
            : { success: false, message: r.message || '테스트넷 인증 실패' };
        } catch (e) {
          return { success: false, message: e instanceof Error ? e.message : '테스트넷 검증 오류' };
        }
      }
      return testBinance(key, secret);
    case 'bybit':    return testBybit(key, secret);
    case 'okx':      return testOKX(key, secret, passphrase || '');
    case 'gate':     return testGate(key, secret);
    case 'upbit':    return testUpbit(key, secret);
    case 'bithumb':  return testBithumb(key, secret);
    default:         return { success: false, message: `Unknown exchange: ${exchange}` };
  }
}

export async function getExchangeBalances(
  exchange: ExchangeId,
  key: string,
  secret: string,
  passphrase?: string
): Promise<ExchangeBalance[]> {
  try {
    switch (exchange) {
      case 'binance':  return getBalancesBinance(key, secret);
      case 'bybit':    return getBalancesBybit(key, secret);
      case 'okx':      return getBalancesOKX(key, secret, passphrase || '');
      case 'gate':     return getBalancesGate(key, secret);
      case 'upbit':    return getBalancesUpbit(key, secret);
      case 'bithumb':  return getBalancesBithumb(key, secret);
      default:         return [];
    }
  } catch { return []; }
}
