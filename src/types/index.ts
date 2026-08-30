export type AssetType = 'coin'|'stock'|'krstock'|'jpstock'|'cnstock'|'eustock'|'etf'|'index'|'commodity'|'forex';

export interface Asset {
  id: string; nameKr: string; name: string; sym: string;
  /** 화면에 적는 원화 환산가. **고정 환율이 곱해져 있다 — 실행에 쓰지 않는다** */
  p: number;
  c: number; v: string; t: AssetType; clr: string;
  hasReal?: boolean;  // true if live price connected
  noData?: boolean;   // true if no API key configured
  cap?: string; sector?: string;
  /**
   * 거래소가 실제로 부르는 값과 그 통화.
   *
   * `p`는 `/api/prices`가 고정 상수를 곱해 만든다. 그 값으로 주문 수량을
   * 만들면 실제 환율과 벌어진 만큼 체결 크기가 어긋난다 — 실전·테스트넷
   * 주문은 **이쪽을 읽는다.** 못 받았으면 `null`이고, `p`에서 되돌려
   * 만들지 않는다.
   */
  quotePrice?: number | null;
  quoteCurrency?: string | null;
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
