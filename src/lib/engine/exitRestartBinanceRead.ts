// Issue #325: read-only Binance TESTNET reconciliation evidence.
// No order placement and no LIVE host fallback. The original persisted ID
// is mandatory. NOT_FOUND is still unresolved for resend purposes.
import { binanceExitOrderStatus, type ExitOrderLookup } from './exitRestartOrderStatus';

export interface TestnetExitOrderQuery {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  clientOrderId: string;
  verifiedTestnet: boolean;
}

export type BinanceClientOrderLookup = (
  key: string, secret: string, symbol: string, clientOrderId: string,
  testnet: boolean,
) => Promise<{ found: boolean; order?: unknown }>;

export async function readBinanceTestnetExitOrderEvidence(
  query: TestnetExitOrderQuery,
  lookup?: BinanceClientOrderLookup,
): Promise<ExitOrderLookup> {
  const unknown: ExitOrderLookup = { ok: false, state: 'UNKNOWN' };
  if (!query.verifiedTestnet || !query.apiKey || !query.apiSecret
    || !query.symbol || !/^[A-Z0-9]{2,40}$/.test(query.symbol)
    || !/^x5t[a-z0-9]{1,33}$/.test(query.clientOrderId)) return unknown;
  try {
    const find = lookup ??
      (await import('../exchanges/binanceFutures')).findOrderByClientId;
    // Literal true, never derive testnet from a request query parameter.
    const found = await find(
      query.apiKey, query.apiSecret, query.symbol, query.clientOrderId, true,
    );
    if (found?.found === false) return { ok: true, state: 'NOT_FOUND' };
    if (found?.found !== true) return unknown;
    return binanceExitOrderStatus(
      found.order as { status?: unknown; clientOrderId?: unknown } | undefined,
      query.clientOrderId,
    );
  } catch {
    // Credential/venue/network failure cannot prove the order did not exist.
    return unknown;
  }
}
