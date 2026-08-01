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
      // 바이낸스 테스트넷은 **두 개**다. 현물은 testnet.binance.vision,
      // 선물은 demo-fapi.binance.com — 키도 따로 발급된다.
      //
      // 그래서 한쪽만 보고 "테스트넷 연결 성공"이라 하면 안 된다. 사용자는
      // 둘 다 되는 줄 알고 현물 주문을 냈다가 -2015를 받는다. 양쪽을 다
      // 물어보고 **어느 시장이 쓸 수 있는지**를 메시지에 적는다.
      if (isTestnet) {
        const [fut, spot] = await Promise.all([
          testFuturesConnection(key, secret, true).catch(() => null),
          testBinance(key, secret, true).catch(() => null),
        ]);
        const futOk  = fut?.success === true;
        const spotOk = spot?.success === true;
        console.log('[testExchange:binance:testnet] futures=%s spot=%s', futOk, spotOk);

        if (!futOk && !spotOk) {
          return {
            success: false,
            message: '테스트넷 인증 실패 — 현물(testnet.binance.vision)과 선물(demo-fapi) 어느 쪽에서도 인증되지 않았습니다.\n'
              + `현물: ${spot?.message || '응답 없음'}\n선물: ${fut?.message || '응답 없음'}`,
          };
        }

        const usable = [spotOk ? '현물' : null, futOk ? 'USDⓈ-M 선물' : null].filter(Boolean).join(' · ');
        const missing = !spotOk
          ? '\n현물 테스트넷은 이 키로 인증되지 않습니다 — testnet.binance.vision에서 별도 발급하세요. 현물 주문·전략은 동작하지 않습니다.'
          : !futOk
          ? '\n선물 데모는 이 키로 인증되지 않습니다 — developers.binance.com 데모 모드에서 별도 발급하세요. 선물 주문은 동작하지 않습니다.'
          : '';

        return {
          success: true,
          message: `테스트넷 연결 성공 · 사용 가능: ${usable}${missing}`,
          // 출금 권한은 테스트넷에서 의미가 없다. trading은 어느 한쪽이라도 되면 true —
          // 안 그러면 perm_trading=false로 저장돼 자동매매 토글이 막힌다.
          permissions: { read: true, trading: futOk ? (fut as any).canTrade !== false : true, withdrawal: false },
          balances: spotOk ? spot!.balances : undefined,
        };
      }
      return testBinance(key, secret);
    case 'bybit':    return testBybit(key, secret);
    case 'okx':      return testOKX(key, secret, passphrase || '');
    // Gate도 testnet을 받는다. 안 넘기면 테스트넷 연결의 '연결 성공'이
    // 실계좌를 본 결과가 된다 — 확인한 적 없는 것을 확인했다고 적는 셈이다.
    case 'gate':     return testGate(key, secret, isTestnet === true);
    case 'upbit':    return testUpbit(key, secret);
    case 'bithumb':  return testBithumb(key, secret);
    default:         return { success: false, message: `Unknown exchange: ${exchange}` };
  }
}

export async function getExchangeBalances(
  exchange: ExchangeId,
  key: string,
  secret: string,
  passphrase?: string,
  isTestnet?: boolean,
): Promise<ExchangeBalance[]> {
  try {
    switch (exchange) {
      case 'binance':  return getBalancesBinance(key, secret, isTestnet);
      case 'bybit':    return getBalancesBybit(key, secret);
      case 'okx':      return getBalancesOKX(key, secret, passphrase || '');
      case 'gate':     return getBalancesGate(key, secret, isTestnet === true);
      case 'upbit':    return getBalancesUpbit(key, secret);
      case 'bithumb':  return getBalancesBithumb(key, secret);
      default:         return [];
    }
  } catch { return []; }
}
