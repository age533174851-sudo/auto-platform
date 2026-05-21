// ─────────────────────────────────────────────────────────────
// TRAIGO Safety Layer — Types
// ─────────────────────────────────────────────────────────────

export type SafetyCheckResult = {
  pass:     boolean;
  code:     string;       // e.g. 'DAILY_LOSS_EXCEEDED'
  message:  string;
  severity: 'block' | 'warn' | 'info';
};

export type OrderSide = 'buy' | 'sell';
export type OrderMode = 'paper' | 'real';

export interface PreOrderInput {
  userId:         string;
  connectionId:   string;         // exchange connection
  exchange:       string;
  symbol:         string;
  side:           OrderSide;
  quantity:       number;
  price:          number;         // entry price estimate
  leverage:       number;
  stopLoss?:      number;
  takeProfit?:    number;
  mode:           OrderMode;
  webhookId?:     string;         // idempotency key
  strategyId?:    string;
}

export interface PreOrderResult {
  allowed:        boolean;
  checks:         SafetyCheckResult[];
  warnings:       string[];
  blockers:       string[];
  estimatedFee:   number;
  estimatedSlip:  number;
  estimatedFund:  number;
  liquidationPx?: number;
  maxLoss?:       number;
  requiresConfirm:boolean;       // extra confirm needed for real orders
}

export interface AuditEvent {
  id:        string;
  userId:    string;
  action:    string;             // 'API_CONNECT' | 'BOT_ENABLE' | 'ORDER_ATTEMPT' | ...
  resource:  string;             // connectionId, botId, etc.
  detail:    Record<string, any>;
  ip?:       string;
  result:    'success' | 'blocked' | 'error';
  createdAt: string;
}

export interface RiskLimits {
  maxDailyLossKRW:     number;   // e.g. 500_000
  maxDailyLossUSD:     number;
  maxPositionSizeKRW:  number;
  maxLeverage:         number;
  maxConsecutiveLoss:  number;   // halt after N losses in a row
  cooldownMinutes:     number;   // after halt, wait this long
  allowedHours?:       [number, number]; // e.g. [9, 21] KST
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxDailyLossKRW:    500_000,
  maxDailyLossUSD:    400,
  maxPositionSizeKRW: 5_000_000,
  maxLeverage:        10,
  maxConsecutiveLoss: 3,
  cooldownMinutes:    60,
};

// Global kill switch state (server-side singleton)
export interface KillSwitchState {
  active:    boolean;
  reason:    string;
  activatedBy: string;
  activatedAt: string;
}
