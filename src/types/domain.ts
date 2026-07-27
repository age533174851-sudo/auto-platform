// 주문 상태 (UI 표시용 — 실행엔진의 OrderStatus와는 별개)
export type OrderStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'canceled';

// src/types/domain.ts
// 여러 페이지가 공유하는 도메인 타입.
//
// 배경: 페이지를 분리하면서 타입 정의가 특정 페이지 파일에 남아,
//       다른 페이지에서 같은 이름을 쓰는데 정의가 없는 상태가 됐다.
//       (SubscriptionPage가 AnalyticsPage의 타입을, TradFiPage가 FundingPage의 타입을 참조)
//       공용 위치로 옮겨 한 곳에서만 정의한다.

// ── 구독/플랜 ────────────────────────────────────────
export type PlanType   = 'free' | 'pro' | 'premium' | 'lifetime' | 'founder' | 'admin';
export type PlanStatus = 'active' | 'expired' | 'suspended' | 'trialing';
export type BadgeType  = 'vip' | 'founder' | 'supporter' | 'lifetime' | 'admin' | 'early_bird';

export interface UserSubscription {
  userId: string;
  planType: PlanType;
  status: PlanStatus;
  expiresAt: string | null;   // null = 무기한 (lifetime/admin)
  grantedBy: string | null;   // 부여한 관리자 userId
  createdAt: string;
  inviteCode?: string;
  badges: BadgeType[];
}

export interface InviteCode {
  id: string;
  code: string;
  planType: PlanType;
  usesMax: number | null;     // null = 무제한
  usesCount: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  note: string;
  active: boolean;
}

// ── TradFi (주식 CFD·지수·원자재·환율) ────────────────
export type ProductType    = 'spot' | 'futures' | 'cfd' | 'tokenized' | 'index' | 'commodity' | 'forex' | 'watchonly';
export type TradFiProvider = 'gate' | 'bybit' | 'binance' | 'bitget' | 'etoro' | 'watchonly';

export interface TradFiAsset {
  id: string; nameKr: string; name: string; sym: string;
  category: 'stock_cfd' | 'index' | 'commodity' | 'forex';
  productType: ProductType;
  providers: TradFiProvider[];
  p: number; c: number; clr: string; overnight: string;
  maxLev: number; isWatchOnly: boolean;
}

// ── 입출금/은행 연동 ──────────────────────────────────
export type FundingTab = 'hub' | 'openbanking' | 'fx' | 'guide';

export interface LinkedBank {
  id: string; bankName: string; accountNum: string;
  holder: string; balance: number; isMain: boolean;
}

export interface ExchangeFunding {
  exchange: string; icon: string; color: string;
  depositTime: string; withdrawTime: string;
  depositFee: string; withdrawFee: string; minDeposit: string;
}

// ── 페이지 분리 과정에서 흩어진 타입 (공용화) ──────────
export type AccountGroup = 'longterm'|'shortterm'|'auto'|'cash'|'custom';

export interface BulkOrder {
  assetId:string; nameKr:string; side:'buy'|'sell'; totalAmount:number;
  selectedAccounts:string[]; allocationMethod:'equal'|'percent'|'weighted'|'custom';
  allocations:Record<string,number>; leverage:number;
}

export interface ConnectedAccount {
  id:string; exchange:ExchangeType; nickname:string; group:AccountGroup;
  status:'connected'|'error'|'pending'; balance:number; available:number;
  openPositions:number; todayPnl:number; todayPnlPct:number;
  apiKeyMasked:string; permissions:{trading:boolean;withdrawal:boolean;read:boolean};
  autoTrading:boolean; maxDailyLoss:number; maxPositionSize:number;
  lastSync:string; isPaper:boolean; emergencyStop:boolean;
}

export type ExchangeType = 'binance'|'gateio'|'upbit'|'bithumb'|'kr_broker'|'us_broker';

export interface BotRun {
  id:string; stratId:string; stratName:string; asset:string;
  side:'long'|'short'; entryPrice:number; exitPrice?:number;
  qty:number; pnl:number; pnlPct:number; status:OrderStatus;
  execMode:ExecMode; openedAt:string; closedAt?:string;
}

export type ExecMode='paper'|'simulated'|'testnet'|'real';

export interface RiskEvent {
  id:string; type:'daily_loss'|'drawdown'|'leverage'|'consecutive_loss'|'emergency';
  message:string; severity:'info'|'warning'|'critical'; timestamp:string;
}

export interface Signal {
  id:string; stratId:string; stratName:string; asset:string;
  type:'buy'|'sell'; price:number; state:SignalState;
  confidence:number; source:'indicator'|'webhook'|'ai'|'manual';
  createdAt:string; note:string;
}

export type SignalState='waiting'|'confirmed'|'rejected'|'executed'|'expired';

export type StratStatus='running'|'paused'|'stopped'|'error';

export type StratType='ema_cross'|'rsi_reversal'|'macd_trend'|'breakout'|'scalping'|'swing'|'dca'|'buy_dip'|'funding_rate'|'ai_strategy';

export interface Strategy {
  id:string; name:string; type:StratType; status:StratStatus;
  asset:string; assetNameKr:string; timeframe:string;
  leverage:number; maxLeverage:number; riskLevel:'low'|'medium'|'high';
  tp:number; sl:number; enabled:boolean;
  winRate:number; totalPnl:number; trades:number;
  maxDailyLoss:number; maxPositionSize:number; cooldownMin:number;
  params:Record<string,number|string|boolean>; description:string;
}

export type DataFreq = 'low'|'balanced'|'high';

export interface RealtimeConfig { freq:DataFreq; wsEnabled:boolean; pollingInterval:number; }

export interface DrawingAction {
  type: 'add'|'delete'|'update'|'move';
  prev: DrawingObject | null;
  next: DrawingObject | null;
}

export type DrawingPoint = { x: number; y: number; price?: number; bar?: number };
export type DrawingToolId = string;

export interface DrawingObject {
  id: string;
  toolId: DrawingToolId;
  toolLabel: string;
  symbol: string;
  timeframe: string;
  points: DrawingPoint[];
  priceLevel?: number;
  priceLevel2?: number;
  text?: string;
  style: {
    color: string;
    width: number;
    dash: 'solid'|'dashed'|'dotted';
    fillColor?: string;
    fillOpacity?: number;
    textSize?: number;
    fontWeight?: 'normal'|'bold';
    opacity?: number;
  };
  locked: boolean;
  hidden: boolean;
  selected?: boolean;
  name?: string;
  createdAt: string;
  updatedAt: string;
  // Risk tool fields
  riskEntry?: number;
  riskSL?: number;
  riskTP?: number;
  // Fib fields
  fibLevels?: { level: number; label: string; color: string }[];
}

export type DrawingTool = { id: string; label: string; icon: string; group: string };

export interface LayoutData {
  id: string;
  name: string;
  symbol: string;
  interval: string;
  chartType: string;
  indicators: string[];
  drawings: DrawingObject[];
  chartType2?: string;
  symbol2?: string;
  createdAt: string;
  updatedAt: string;
}
