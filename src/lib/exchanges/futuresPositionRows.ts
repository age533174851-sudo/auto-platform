// Strict, offline parser for Binance /fapi/v2/positionRisk.
// An unknown row is NOT evidence that the account is flat.
import type { FuturesPosition } from './binanceFutures';

function decimal(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseFuturesPositionRows(data: unknown): FuturesPosition[] {
  if (!Array.isArray(data)) throw new Error('BINANCE_POSITION_RISK_NOT_ARRAY');
  const positions: FuturesPosition[] = [];
  for (const [index, raw] of data.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`BINANCE_POSITION_ROW_INVALID:${index}`);
    }
    const row = raw as Record<string, unknown>;
    const symbol = row.symbol;
    const amt = decimal(row.positionAmt);
    if (typeof symbol !== 'string' || !/^[A-Z0-9]{3,30}$/.test(symbol) || amt === null) {
      throw new Error(`BINANCE_POSITION_IDENTITY_INVALID:${index}`);
    }
    // Zero rows are valid and intentionally omitted from the open-position list.
    // Still validate their identity/amount, otherwise malformed rows look flat.
    if (amt === 0) continue;

    const entryPrice = decimal(row.entryPrice);
    const markPrice = decimal(row.markPrice);
    const unrealizedPnl = decimal(row.unRealizedProfit);
    const leverage = decimal(row.leverage);
    const liquidationPrice = decimal(row.liquidationPrice);
    const marginType = typeof row.marginType === 'string' ? row.marginType.toLowerCase() : '';
    if (entryPrice === null || entryPrice <= 0
      || markPrice === null || markPrice <= 0
      || unrealizedPnl === null
      || leverage === null || !Number.isInteger(leverage) || leverage <= 0
      || liquidationPrice === null || liquidationPrice < 0
      || (marginType !== 'isolated' && marginType !== 'cross')) {
      throw new Error(`BINANCE_POSITION_FIELDS_INVALID:${index}`);
    }
    positions.push({
      symbol,
      side: amt > 0 ? 'LONG' : 'SHORT',
      amount: Math.abs(amt),
      entryPrice,
      markPrice,
      unrealizedPnl,
      leverage,
      liquidationPrice,
      marginType,
    });
  }
  return positions;
}
