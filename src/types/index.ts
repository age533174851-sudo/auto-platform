export type AssetType = 'coin'|'stock'|'krstock'|'jpstock'|'cnstock'|'eustock'|'etf'|'index'|'commodity'|'forex';

export interface Asset {
  id: string; nameKr: string; name: string; sym: string;
  p: number; c: number; v: string; t: AssetType; clr: string;
  cap?: string; sector?: string;
}

export interface Order {
  id: string; assetId: string; nameKr: string; sym: string;
  side: 'buy'|'sell'; price: number; amount: number;
  leverage: number; fee: number; slippage: number;
  status: 'filled'|'pending'|'cancelled';
  pnl: number; pnlPct: number; openedAt: string;
  note: string; emotion: string;
}

export interface Alert {
  id: string; assetId: string; nameKr: string;
  condition: 'above'|'below'; value: number; active: boolean;
}

export interface Notif {
  id: string; type: 'trade'|'alert'|'system';
  title: string; body: string; read: boolean; time: string;
}

// ── Dual Portfolio System ─────────────────────────────────────
export interface DCAEntry {
  id: string; assetId: string; nameKr: string; clr: string; sym: string;
  amount: number; freq: 'daily'|'weekly'|'monthly';
  active: boolean; avgPrice: number; totalInvested: number;
  qty: number; targetPrice: number; nextBuy: string;
}

export interface LongPosition {
  id: string; assetId: string; nameKr: string; clr: string; sym: string;
  type: 'spot'|'etf'|'dca';
  avgPrice: number; qty: number; invested: number;
  targetPrice: number; stopPrice: number;
  note: string; addedAt: string;
}

export interface ShortPosition {
  id: string; assetId: string; nameKr: string; clr: string; sym: string;
  side: 'long'|'short';
  entryPrice: number; qty: number; margin: number; leverage: number;
  takeProfitPrice: number; stopLossPrice: number;
  pnl: number; pnlPct: number; openedAt: string; strategy: string;
}

export interface PortfolioAllocation {
  longPct: number;
  shortPct: number;
  cashPct: number;
}

export type PortfolioMode = 'all'|'long'|'short'|'cash';

export type AllocationPreset = '안정형'|'균형형'|'공격형'|'자동매매형';
