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
      // 테스트넷이면 선물 테스트넷으로 검증 (demo-fapi.binance.com)
      if (isTestnet) {
        try {
          const r = await testFuturesConnection(key, secret, true);
          // ★ 권한 객체를 반드시 반환 — 안 그러면 perm_trading=false로 저장돼 자동매매 토글이 막힘
          // 선물 테스트넷 연결 성공 = 읽기 + 선물 거래 권한 확인됨 (canTrade로 보정, 출금권한은 테스트넷에서 의미없음)
          console.log('[testExchange:binance:testnet] success=%s canTrade=%s', r.success, (r as any).canTrade);
          return r.success
            ? { success: true, message: r.message || '테스트넷 연결 성공', permissions: { read: true, trading: (r as any).canTrade !== false, withdrawal: false } }
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
