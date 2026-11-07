// Read-only, TESTNET-only diagnostic projections of actual venue snapshots.
// DB live_orders status is NOT evidence of a Binance currently open order.
// This module does not receive credentials and has no order write capability.

export interface OpenOrderSnapshot {
  success?: unknown;
  orders?: unknown;
}
export interface PositionSnapshot {
  success?: unknown;
  positions?: unknown;
}

export interface VenueOrderEvidence {
  source: 'BINANCE_TESTNET_OPEN_ORDERS';
  code: 'VERIFIED' | 'UNKNOWN';
  openOrderCount: number | null;
  openCloseIntentCount: number | null;
  bySymbol: Array<{ symbol: string; openOrders: number; closeIntents: number }>;
}

export interface VenuePositionEvidence {
  source: 'BINANCE_TESTNET_POSITION_RISK';
  code: 'VERIFIED' | 'UNKNOWN';
  openPositionCount: number | null;
  symbols: string[];
}

const NO_ORDERS: VenueOrderEvidence = {
  source: 'BINANCE_TESTNET_OPEN_ORDERS', code: 'UNKNOWN',
  openOrderCount: null, openCloseIntentCount: null, bySymbol: [],
};

const NO_POSITIONS: VenuePositionEvidence = {
  source: 'BINANCE_TESTNET_POSITION_RISK', code: 'UNKNOWN',
  openPositionCount: null, symbols: [],
};

/**
 * A failed read and an empty successful read are distinct.
 * Order IDs, response payloads and credentials are never copied to output.
 * reduceOnly OR closePosition signals a *possible close-intent order*, not
 * verified ownership by this strategy or proof of a duplicate.
 */
export function summarizeTestnetOpenOrders(s: OpenOrderSnapshot | null | undefined):
  VenueOrderEvidence {
  if (s?.success !== true || !Array.isArray(s.orders)) return { ...NO_ORDERS };
  const bySymbol = new Map<string, { symbol: string; openOrders: number; closeIntents: number }>();
  for (const raw of s.orders) {
    if (!raw || typeof raw !== 'object') return { ...NO_ORDERS };
    const row = raw as Record<string, unknown>;
    const symbol = row.symbol;
    if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,40}$/.test(symbol)
      || typeof row.reduceOnly !== 'boolean' || typeof row.closePosition !== 'boolean')
      return { ...NO_ORDERS };
    const closeIntent = row.reduceOnly || row.closePosition;
    const current = bySymbol.get(symbol) ?? { symbol, openOrders: 0, closeIntents: 0 };
    current.openOrders += 1;
    if (closeIntent) current.closeIntents += 1;
    bySymbol.set(symbol, current);
  }
  const groups = [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return {
    source: 'BINANCE_TESTNET_OPEN_ORDERS', code: 'VERIFIED',
    openOrderCount: s.orders.length,
    openCloseIntentCount: groups.reduce((n, g) => n + g.closeIntents, 0),
    bySymbol: groups,
  };
}

/** Active exchange exposure is a separate question from DB-managed candidates. */
export function summarizeTestnetOpenPositions(s: PositionSnapshot | null | undefined):
  VenuePositionEvidence {
  if (s?.success !== true || !Array.isArray(s.positions)) return { ...NO_POSITIONS };
  const symbols: string[] = [];
  for (const raw of s.positions) {
    if (!raw || typeof raw !== 'object') return { ...NO_POSITIONS };
    const symbol = (raw as Record<string, unknown>).symbol;
    if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,40}$/.test(symbol))
      return { ...NO_POSITIONS };
    symbols.push(symbol);
  }
  return {
    source: 'BINANCE_TESTNET_POSITION_RISK', code: 'VERIFIED',
    openPositionCount: s.positions.length,
    symbols: [...new Set(symbols)].sort(),
  };
}
