// src/lib/products/productCapability.ts
//
// Phase 4A — 제품을 그리기 전에 실제 능력을 증명한다.
//
// 이 표는 "탭 목록"이 아니다. 데이터·실행·계좌·보유·정밀도·PAPER·LIVE·UI를
// 따로 판정한다. 하나라도 모르는 것을 SUPPORTED로 올려서 화면을 먼저 열지 않는다.

export type ProductId =
  | 'SPOT_CRYPTO'
  | 'FUTURES_PERPS'
  | 'SPOT_STOCKS'
  | 'STOCK_PERPS'
  | 'COMMODITY_PERPS'
  | 'OPTIONS'
  | 'ONCHAIN'
  | 'CONVERT';

export type CapabilityState = 'SUPPORTED' | 'BACKEND_GAP' | 'DATA_GAP' | 'VENUE_GAP';
export type CapabilityDimension =
  | 'marketData' | 'execution' | 'account' | 'holdings'
  | 'precision' | 'paper' | 'live' | 'ui';

export interface CapabilityFact {
  state: CapabilityState;
  /** 코드/계약 근거. 빈 문자열 금지. */
  evidence: string;
}

export interface ProductCapability {
  id: ProductId;
  label: string;
  /** 실제 제품 화면으로 노출 가능한가. LOCKED는 탭/주문 CTA를 만들지 않는다. */
  exposure: 'VISIBLE' | 'LOCKED';
  dimensions: Record<CapabilityDimension, CapabilityFact>;
}

const ok = (evidence: string): CapabilityFact => ({ state: 'SUPPORTED', evidence });
const backend = (evidence: string): CapabilityFact => ({ state: 'BACKEND_GAP', evidence });
const data = (evidence: string): CapabilityFact => ({ state: 'DATA_GAP', evidence });
const venue = (evidence: string): CapabilityFact => ({ state: 'VENUE_GAP', evidence });

export const PRODUCT_IDS: ProductId[] = [
  'SPOT_CRYPTO', 'FUTURES_PERPS', 'SPOT_STOCKS', 'STOCK_PERPS',
  'COMMODITY_PERPS', 'OPTIONS', 'ONCHAIN', 'CONVERT',
];

export const CAPABILITY_DIMENSIONS: CapabilityDimension[] = [
  'marketData', 'execution', 'account', 'holdings', 'precision', 'paper', 'live', 'ui',
];

export const PRODUCT_CAPABILITIES: Record<ProductId, ProductCapability> = {
  SPOT_CRYPTO: {
    id: 'SPOT_CRYPTO', label: 'Spot Crypto', exposure: 'VISIBLE',
    dimensions: {
      marketData: ok('market/candles + venue quote/stream 경로'),
      execution: ok('PAPER /api/paper/order·sell, LIVE spot executors'),
      account: ok('paper_accounts + 거래소 spot wallet'),
      holdings: ok('/api/paper/holdings + 거래소 spot balance'),
      precision: venue('PAPER에는 venue stepSize/minQty/minNotional 정본이 없음; LIVE venue별 검증은 별도'),
      paper: ok('PaperMarket SPOT + 088 분할매도'),
      live: ok('Binance/Gate 등 spot 실행 어댑터 존재'),
      ui: ok('InstrumentDetail → PaperOrderScreen / TradingWorkspace'),
    },
  },
  FUTURES_PERPS: {
    id: 'FUTURES_PERPS', label: 'Futures / Perpetuals', exposure: 'VISIBLE',
    dimensions: {
      marketData: ok('USDT-M/COIN-M quote·mark·funding 관련 경로 존재'),
      execution: ok('Binance futures/coinm 및 futures adapters'),
      account: ok('futures account/wallet 경로'),
      holdings: ok('선물 position 경로'),
      precision: venue('거래소별 contract filters/spec 검증이 필요하며 하나의 공통 정본으로 확정되지 않음'),
      paper: ok('PaperMarket USDM + /api/paper/order'),
      live: ok('USDT-M/COIN-M live execution 경로'),
      ui: ok('TradingWorkspace가 PAPER USDM canonical order route에 연결'),
    },
  },
  SPOT_STOCKS: {
    id: 'SPOT_STOCKS', label: 'Spot Stocks', exposure: 'VISIBLE',
    dimensions: {
      marketData: ok('stock/stocks + 기존 instrument stock data 경로'),
      execution: ok('/api/stock/order'),
      account: ok('KIS 증권계좌 경로'),
      holdings: ok('StockOrderPanel/KIS 계좌 기반 보유 경로'),
      precision: venue('주식시장별 호가단위·최소수량/소수점 지원을 통합 정본으로 감사하지 않음'),
      paper: backend('현재 PAPER 장부는 SPOT crypto/USDM만 지원'),
      live: ok('STOCK market type이 /api/stock/order로 분리'),
      ui: ok('StockOrderPanel 존재'),
    },
  },
  STOCK_PERPS: {
    id: 'STOCK_PERPS', label: 'Stock Perps', exposure: 'LOCKED',
    dimensions: {
      marketData: data('전용 종목/mark/funding/contract data source 없음'),
      execution: backend('전용 주문 domain/API 없음'),
      account: venue('지원 venue/account authority 미선정'),
      holdings: backend('stock-perp position ledger 없음'),
      precision: venue('contract spec authority 없음'),
      paper: backend('PAPER domain에 stock perp market 없음'),
      live: venue('실행 venue 미선정'),
      ui: backend('전용 제품 UI 없음'),
    },
  },
  COMMODITY_PERPS: {
    id: 'COMMODITY_PERPS', label: 'Commodity Perps', exposure: 'LOCKED',
    dimensions: {
      marketData: data('commodity-perp authoritative feed 없음'),
      execution: backend('전용 주문 domain/API 없음'),
      account: venue('지원 venue/account authority 미선정'),
      holdings: backend('commodity-perp position ledger 없음'),
      precision: venue('contract spec authority 없음'),
      paper: backend('PAPER domain에 commodity perp market 없음'),
      live: venue('실행 venue 미선정'),
      ui: backend('전용 제품 UI 없음'),
    },
  },
  OPTIONS: {
    id: 'OPTIONS', label: 'Options', exposure: 'LOCKED',
    dimensions: {
      marketData: data('expiry/strike/call-put/bid-ask/IV option chain 정본 없음'),
      execution: backend('option order/strategy execution domain 없음'),
      account: venue('option 권한/account authority 미선정'),
      holdings: backend('option contract position ledger 없음'),
      precision: venue('contract multiplier/tick/lot authority 없음'),
      paper: backend('PAPER option accounting/settlement 없음'),
      live: venue('option execution venue 미선정'),
      ui: backend('option chain/order ticket 없음'),
    },
  },
  ONCHAIN: {
    id: 'ONCHAIN', label: 'Onchain', exposure: 'LOCKED',
    dimensions: {
      marketData: data('/api/onchain은 mock 혼합/fallback 분석 데이터라 거래 정본으로 사용 불가'),
      execution: backend('swap/bridge/onchain execution route 없음'),
      account: backend('wallet/chain signing authority 없음'),
      holdings: backend('chain portfolio authority 없음'),
      precision: venue('chain/token decimals·slippage·gas authority 없음'),
      paper: backend('onchain PAPER settlement 없음'),
      live: backend('서명/전송 execution 없음'),
      ui: backend('거래 제품 UI 없음'),
    },
  },
  CONVERT: {
    id: 'CONVERT', label: 'Convert', exposure: 'LOCKED',
    dimensions: {
      marketData: data('convert quote/RFQ source 없음'),
      execution: backend('convert execution API/domain 없음'),
      account: venue('convert 가능 venue/account capability 미확정'),
      holdings: backend('convert 전후 자산 authority 계약 없음'),
      precision: venue('min/max/precision/quote-expiry authority 없음'),
      paper: backend('PAPER convert settlement 없음'),
      live: venue('convert venue adapter 없음'),
      ui: backend('convert quote/confirm UI 없음'),
    },
  },
};

export function productCapability(id: ProductId): ProductCapability {
  return PRODUCT_CAPABILITIES[id];
}

export function canExposeProduct(id: ProductId): boolean {
  return PRODUCT_CAPABILITIES[id].exposure === 'VISIBLE';
}

export function capabilityGaps(id: ProductId): CapabilityFact[] {
  return CAPABILITY_DIMENSIONS
    .map(d => PRODUCT_CAPABILITIES[id].dimensions[d])
    .filter(f => f.state !== 'SUPPORTED');
}
