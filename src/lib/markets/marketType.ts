// src/lib/markets/marketType.ts
//
// 시장 유형. 이 파일이 현물과 선물을 가르는 기준점이다.
//
// 왜 이것부터인가
// ───────────────
// 지금 코드에는 시장 유형 개념이 아예 없다. 매매 화면의 '매도' 버튼은
// 무조건 선물 SHORT로 나간다. 현물을 붙이면서 하나의 주문 함수에
// `if (isSpot)` 분기를 넣으면, 그 분기가 한 번 잘못 평가되는 순간
// **현물 매도가 선물 SHORT로 나간다.** 되돌릴 수 없는 사고다.
//
// 그래서 유형을 값으로 만들고, 유형마다 무엇이 존재하고 무엇이
// 존재하지 않는지를 여기에 못 박는다. 화면과 주문 경로는 이 표를 읽는다.
//
// 없는 것을 "0"으로 두지 않는다
// ─────────────────────────────
// 현물에는 레버리지가 1배가 아니라 **없다**. 청산가도 0이 아니라 없다.
// 0으로 채우면 "1배 레버리지", "청산가 0원"처럼 읽히고, 그 값으로
// 위험 계산을 돌리면 답이 나온다 — 틀린 답이.
// 그래서 능력표는 boolean이고, 없는 항목은 화면에 아예 렌더되지 않는다.

export type MarketType = 'SPOT' | 'USDT_FUTURES' | 'COIN_FUTURES' | 'STOCK';

export const MARKET_TYPES: MarketType[] = ['SPOT', 'USDT_FUTURES', 'COIN_FUTURES', 'STOCK'];

export interface MarketCapability {
  label: string;
  shortLabel: string;
  /** 레버리지가 존재하는가 */
  leverage: boolean;
  /** 청산가가 존재하는가 */
  liquidation: boolean;
  /** Cross/Isolated 선택이 존재하는가 */
  marginMode: boolean;
  /** 펀딩비가 존재하는가 */
  funding: boolean;
  /** 공매도가 가능한가 (빌리지 않고) */
  canShort: boolean;
  /** reduce-only 주문 개념이 있는가 */
  reduceOnly: boolean;
  /** 어느 지갑을 쓰는가 — 잔고를 섞으면 안 된다 */
  wallet: 'SPOT_WALLET' | 'FUTURES_WALLET';
  /** 매수/진입 버튼 문구 */
  buyLabel: (base: string) => string;
  /** 매도/반대진입 버튼 문구 */
  sellLabel: (base: string) => string;
  /** 주문 API 경로 — 유형마다 다른 엔드포인트를 쓴다 */
  orderEndpoint: string;
}

const CAP: Record<MarketType, MarketCapability> = {
  SPOT: {
    label: '현물', shortLabel: '현물',
    leverage: false, liquidation: false, marginMode: false,
    funding: false, canShort: false, reduceOnly: false,
    wallet: 'SPOT_WALLET',
    // 현물은 '산다/판다'다. LONG/SHORT라고 쓰면 선물과 같은 것으로 읽힌다.
    buyLabel: base => `${base} 매수`,
    sellLabel: base => `${base} 매도`,
    orderEndpoint: '/api/binance/spot/order',
  },
  USDT_FUTURES: {
    label: 'USDⓈ-M 선물', shortLabel: 'USDT-M',
    leverage: true, liquidation: true, marginMode: true,
    funding: true, canShort: true, reduceOnly: true,
    wallet: 'FUTURES_WALLET',
    buyLabel: () => 'LONG 진입',
    sellLabel: () => 'SHORT 진입',
    orderEndpoint: '/api/binance/futures/order',
  },
  COIN_FUTURES: {
    label: 'COIN-M 선물', shortLabel: 'COIN-M',
    leverage: true, liquidation: true, marginMode: true,
    funding: true, canShort: true, reduceOnly: true,
    wallet: 'FUTURES_WALLET',
    buyLabel: () => 'LONG 진입',
    sellLabel: () => 'SHORT 진입',
    orderEndpoint: '/api/binance/coinm/order',
  },
  // 주식은 거래소가 아니라 **증권사(한국투자증권)**를 탄다. 연결도 따로다 —
  // 바이낸스 연결로는 주문이 안 나가고, 그 사실을 주문판이 먼저 말한다.
  //
  // canShort가 false인 이유: 이 경로는 현금 매수·매도만 낸다. 공매도는
  // 대주/신용이 따로 필요하고 규칙도 다르다. **없는 것을 있는 척하지 않는다.**
  STOCK: {
    label: '주식', shortLabel: '주식',
    leverage: false, liquidation: false, marginMode: false,
    funding: false, canShort: false, reduceOnly: false,
    // 증권 계좌는 현금 계좌다. 선물 지갑과 섞으면 안 된다.
    wallet: 'SPOT_WALLET',
    buyLabel: base => `${base} 매수`,
    sellLabel: base => `${base} 매도`,
    orderEndpoint: '/api/stock/order',
  },
};

export function capability(m: MarketType): MarketCapability {
  return CAP[m];
}

/**
 * 문자열을 시장 유형으로. **모르면 null이다.**
 *
 * 기본값을 두지 않는 이유: 어느 쪽으로 정해도 위험하다. SPOT으로 떨어뜨리면
 * 선물 주문이 현물로 나가고, FUTURES로 떨어뜨리면 현물 주문이 레버리지로
 * 나간다. 둘 다 사고다. 그래서 호출자가 반드시 처리하게 만든다.
 */
export function parseMarketType(raw: string | null | undefined): MarketType | null {
  const s = String(raw || '').toUpperCase().replace(/[\s-]/g, '_');
  if ((MARKET_TYPES as string[]).includes(s)) return s as MarketType;
  // 흔한 별칭만 좁게 받는다. 넓게 받으면 오타가 통과한다.
  if (s === 'FUTURES' || s === 'USDM' || s === 'USDSM' || s === 'USD_M') return 'USDT_FUTURES';
  if (s === 'COINM' || s === 'COIN_M') return 'COIN_FUTURES';
  return null;
}

export function isFutures(m: MarketType): boolean {
  return m === 'USDT_FUTURES' || m === 'COIN_FUTURES';
}

// ── DB 호환 ────────────────────────────────────────────
//
// live_orders에 market_type 컬럼이 아직 없다. 컬럼을 추가하려면
// 마이그레이션이 필요한데, 그때까지 시장 유형을 기록하지 않으면
// "이 주문이 현물이었는지 선물이었는지" 자체를 잃는다. 그건 나중에
// 대조·복구·손익 계산을 전부 못 하게 만든다.
//
// 그래서 컬럼이 있으면 컬럼에, 없으면 signal_id 앞에 표식을 붙여 남긴다.
// 표식은 사람이 읽을 수 있고, 마이그레이션 후에도 그대로 해석된다.

const TAG = /^\[(SPOT|USDT_FUTURES|COIN_FUTURES|STOCK)\]/;

/** signal_id 앞에 유형 표식을 붙인다 */
export function tagSignalId(signalId: string, m: MarketType): string {
  const clean = String(signalId || '').replace(TAG, '');
  return `[${m}]${clean}`;
}

/**
 * 행에서 시장 유형을 읽는다.
 *
 * 우선순위: 컬럼 → signal_id 표식 → 추론.
 * 어느 쪽으로도 못 읽으면 null이다. 모르는 것을 아는 척하지 않는다 —
 * 유형을 모르는 주문은 화면에서도 '유형 미상'으로 보여야 한다.
 */
export function marketTypeOf(row: any): MarketType | null {
  const col = parseMarketType(row?.market_type);
  if (col) return col;

  const tag = TAG.exec(String(row?.signal_id || ''));
  if (tag) return tag[1] as MarketType;

  // 018 이전에 쌓인 행에는 표식도 없다. 그때는 선물 경로밖에 없었으므로
  // USDT 선물로 본다. 이 추론은 여기 한 곳에만 두고 근거를 남긴다.
  if (row?.leverage != null && Number(row.leverage) > 0) return 'USDT_FUTURES';
  return null;
}

/** 표식을 뗀 원래 signal_id */
export function untagSignalId(signalId: string): string {
  return String(signalId || '').replace(TAG, '');
}

// ── 주문 방향 ──────────────────────────────────────────
//
// 현물의 BUY/SELL과 선물의 LONG/SHORT는 다른 개념이다.
// 현물 SELL은 가진 것을 파는 것이고, 선물 SELL은 없는 것을 파는 것이다.
// 같은 타입으로 두면 어느 순간 섞인다.

export type SpotSide = 'BUY' | 'SELL';
export type FuturesSide = 'LONG' | 'SHORT';

/** 선물 방향을 거래소가 받는 BUY/SELL로. 현물에는 쓰지 않는다. */
export function futuresSideToOrderSide(s: FuturesSide): 'BUY' | 'SELL' {
  return s === 'LONG' ? 'BUY' : 'SELL';
}

/**
 * 이 시장에서 이 주문이 가능한가.
 *
 * 현물에서 공매도를 시도하는 것이 대표적인 오류다. 보유 수량보다 많이
 * 팔 수 없다는 사실을 주문 직전이 아니라 여기서 먼저 막는다.
 */
export interface OrderIntent {
  market: MarketType;
  side: 'BUY' | 'SELL';
  quantity: number;
  /** 현물에서만 의미 있음 — 지금 보유한 수량 */
  heldQty?: number | null;
  /** 선물에서만 의미 있음 */
  leverage?: number | null;
  reduceOnly?: boolean;
}

export interface IntentCheck { ok: boolean; reason?: string }

export function checkIntent(i: OrderIntent): IntentCheck {
  const cap = CAP[i.market];

  if (!Number.isFinite(i.quantity) || i.quantity <= 0) {
    return { ok: false, reason: '주문 수량이 유효하지 않습니다' };
  }

  if (!cap.leverage && i.leverage != null && i.leverage > 1) {
    return { ok: false, reason: `${cap.label}에는 레버리지가 없습니다 (요청 ${i.leverage}배)` };
  }

  if (!cap.reduceOnly && i.reduceOnly) {
    return { ok: false, reason: `${cap.label}에는 reduce-only가 없습니다` };
  }

  if (!cap.canShort && i.side === 'SELL') {
    // 현물 매도는 보유분을 파는 것이다. 얼마나 있는지 모르면 통과시키지 않는다 —
    // 모르는 채로 보내면 거래소가 거부하거나, 최악의 경우 다른 주문과 겹쳐 나간다.
    if (i.heldQty == null) {
      return { ok: false, reason: '보유 수량을 확인하지 못해 현물 매도를 보류합니다' };
    }
    if (i.quantity > i.heldQty) {
      return {
        ok: false,
        reason: `보유 수량(${i.heldQty})보다 많이 팔 수 없습니다 (요청 ${i.quantity}). ` +
                '현물에는 공매도가 없습니다.',
      };
    }
  }

  return { ok: true };
}

// ── 통합 노출 ──────────────────────────────────────────
//
// 현물과 선물을 동시에 들고 있으면 "지금 나는 어느 방향인가"가
// 한눈에 안 보인다. 현물 0.15 BTC + 선물 SHORT 0.10 BTC는
// 실질 +0.05 BTC다. 이걸 따로 보면 둘 다 크게 느껴진다.

export interface Exposure {
  /** 현물 보유 수량 (항상 0 이상) */
  spotQty: number;
  /** 선물 순 수량. LONG이 +, SHORT가 - */
  futuresQty: number;
}

export function netExposure(e: Exposure): number {
  return e.spotQty + e.futuresQty;
}

/**
 * 현물가와 선물 Mark Price의 괴리(%).
 *
 * 선물이 비싸면 +다. 이 값이 크면 선물 쪽에 프리미엄이 붙어 있다는 뜻이고,
 * 펀딩비가 그만큼 나간다. 둘 중 하나라도 없으면 계산하지 않는다.
 */
export function basisPct(spot: number | null, mark: number | null): number | null {
  if (spot == null || mark == null) return null;
  if (!Number.isFinite(spot) || !Number.isFinite(mark) || spot <= 0) return null;
  return ((mark - spot) / spot) * 100;
}
