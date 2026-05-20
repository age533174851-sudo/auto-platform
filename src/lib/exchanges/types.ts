// ─────────────────────────────────────────────────────────────
// TRAIGO Exchange Types
// ─────────────────────────────────────────────────────────────

export type ExchangeId = 'binance' | 'gate' | 'bybit' | 'okx' | 'upbit' | 'bithumb';

export interface ExchangeMeta {
  id:           ExchangeId;
  name:         string;
  nameKr:       string;
  logo:         string;      // emoji
  color:        string;
  hasPassphrase:boolean;
  website:      string;
  apiGuideUrl:  string;
  type:         'global' | 'korean';
  currency:     'USD' | 'KRW';
}

export const EXCHANGE_META: Record<ExchangeId, ExchangeMeta> = {
  binance: {
    id: 'binance', name: 'Binance', nameKr: '바이낸스',
    logo: '🟡', color: '#F0B90B', hasPassphrase: false,
    website: 'https://binance.com', type: 'global', currency: 'USD',
    apiGuideUrl: 'https://www.binance.com/en/support/faq/360002502072',
  },
  gate: {
    id: 'gate', name: 'Gate.io', nameKr: '게이트아이오',
    logo: '🔵', color: '#2354E6', hasPassphrase: false,
    website: 'https://gate.io', type: 'global', currency: 'USD',
    apiGuideUrl: 'https://www.gate.io/myaccount/apiv4keys',
  },
  bybit: {
    id: 'bybit', name: 'Bybit', nameKr: '바이비트',
    logo: '🟠', color: '#F7A600', hasPassphrase: false,
    website: 'https://bybit.com', type: 'global', currency: 'USD',
    apiGuideUrl: 'https://www.bybit.com/app/user/api-management',
  },
  okx: {
    id: 'okx', name: 'OKX', nameKr: 'OKX',
    logo: '⚫', color: '#FFFFFF', hasPassphrase: true,
    website: 'https://okx.com', type: 'global', currency: 'USD',
    apiGuideUrl: 'https://www.okx.com/account/my-api',
  },
  upbit: {
    id: 'upbit', name: 'Upbit', nameKr: '업비트',
    logo: '🟦', color: '#1478FF', hasPassphrase: false,
    website: 'https://upbit.com', type: 'korean', currency: 'KRW',
    apiGuideUrl: 'https://upbit.com/mypage/open_api_info',
  },
  bithumb: {
    id: 'bithumb', name: 'Bithumb', nameKr: '빗썸',
    logo: '🔴', color: '#FF5C00', hasPassphrase: false,
    website: 'https://bithumb.com', type: 'korean', currency: 'KRW',
    apiGuideUrl: 'https://www.bithumb.com/react/member/api-management',
  },
};

export interface ConnectedExchange {
  id:             string;       // UUID from DB
  userId:         string;
  exchange:       ExchangeId;
  nickname:       string;
  apiKeyMasked:   string;       // e.g. "ABCD****1234"
  hasPassphrase:  boolean;
  permissions: {
    read:       boolean;
    trading:    boolean;
    withdrawal: boolean;
  };
  status:         'active' | 'error' | 'testing';
  lastTestAt:     string | null;
  lastTestResult: string | null;
  autoTradingEnabled: boolean;
  isPaper:        boolean;       // paper trading mode
  createdAt:      string;
  balance?: {
    total: number;
    available: number;
    currency: string;
  };
}

export interface ExchangeBalance {
  currency:  string;
  free:      number;
  locked:    number;
  total:     number;
  valueUSD?: number;
  valueKRW?: number;
}

export interface ConnectPayload {
  exchange:   ExchangeId;
  apiKey:     string;
  apiSecret:  string;
  passphrase?: string;
  nickname:   string;
}

export interface TestResult {
  success: boolean;
  message: string;
  balances?: ExchangeBalance[];
  permissions?: {
    read: boolean;
    trading: boolean;
    withdrawal: boolean;
  };
  latencyMs?: number;
}
