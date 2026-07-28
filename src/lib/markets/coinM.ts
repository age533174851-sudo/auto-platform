// src/lib/markets/coinM.ts
//
// COIN-M(코인 마진) 선물의 계산.
//
// USDT-M과 무엇이 다른가 — 이게 이 파일의 전부다
// ────────────────────────────────────────────────
//  1. **수량 단위가 계약(contract)이다.** 코인 개수가 아니다.
//     BTCUSD_PERP은 1계약 = 100 USD, 대부분의 알트는 1계약 = 10 USD.
//     사용자가 0.5를 입력하며 "0.5 BTC"를 생각했다면 실제로는 0.5계약
//     = 50 USD가 나간다. 반대로 100을 넣으면 10,000 USD다.
//     이 오해가 이 시장에서 가장 흔한 사고다.
//
//  2. **계약 수는 정수여야 한다.** 거래소가 소수 계약을 받지 않는다.
//
//  3. **증거금·손익이 코인으로 계산된다.** BTC로 마진을 걸고 BTC로
//     번다. USDT 기준으로 "필요 증거금 $50"이라고 표시하면 틀린다.
//
//  4. **역방향(inverse) 계약이다.** 손익이 가격에 선형이 아니다.
//     롱이 오를수록 같은 달러당 벌어들이는 코인 수가 줄어든다.
//     그래서 "몇 % 오르면 얼마 번다"를 USDT-M 공식으로 계산하면 틀린다.
//
// 모르면 계산하지 않는다
// ──────────────────────
// 계약 크기를 모르는 심볼은 null을 돌려준다. 흔한 값(10)으로 추측하면
// BTC에서 10배 틀린 주문이 나간다.

export type CoinMSymbol = string;   // 'BTCUSD_PERP' | 'ETHUSD_240628'

/** COIN-M 심볼 형식인가. 'BTCUSDT'(USDT-M)와 확실히 구분한다 */
export function isCoinMSymbol(s: string): boolean {
  return /^[A-Z0-9]+USD_(PERP|\d{6})$/.test(String(s || '').toUpperCase());
}

/** 'BTCUSD_PERP' → 'BTC' */
export function baseAssetOf(symbol: string): string | null {
  const m = /^([A-Z0-9]+)USD_(?:PERP|\d{6})$/.exec(String(symbol || '').toUpperCase());
  return m ? m[1] : null;
}

/** 무기한인가 분기물인가. 분기물은 만기가 있어 취급이 다르다 */
export function isPerpetual(symbol: string): boolean {
  return /USD_PERP$/.test(String(symbol || '').toUpperCase());
}

/**
 * 계약 크기(USD).
 *
 * 거래소가 exchangeInfo로 알려주지만, 그걸 못 받았을 때 기본값을 쓰면
 * 안 된다. BTC(100)와 알트(10)가 10배 다르기 때문이다.
 * 그래서 아는 값만 갖고 있고, 모르면 null이다.
 */
const KNOWN_CONTRACT_USD: Record<string, number> = {
  BTC: 100,
};
/** BTC 외 대부분은 10이지만, '대부분'으로 주문을 낼 수는 없다 */
const COMMON_ALT_CONTRACT_USD = 10;

export interface ContractSpec {
  /** 1계약이 몇 USD인가 */
  contractUsd: number;
  /** 이 값이 거래소에서 온 것인가, 우리가 아는 값인가 */
  source: 'exchange' | 'known';
}

/**
 * 계약 크기를 정한다.
 *
 * @param fromExchange exchangeInfo의 contractSize. 있으면 무조건 이것을 쓴다.
 */
export function resolveContractSize(
  symbol: string, fromExchange?: number | null,
): ContractSpec | null {
  if (fromExchange != null && Number.isFinite(fromExchange) && fromExchange > 0) {
    return { contractUsd: fromExchange, source: 'exchange' };
  }
  const base = baseAssetOf(symbol);
  if (!base) return null;
  const known = KNOWN_CONTRACT_USD[base];
  if (known != null) return { contractUsd: known, source: 'known' };
  // 알트가 대개 10이라는 것은 알지만, 그 '대개'로 주문을 내지 않는다.
  return null;
}

/** 참고용 — 화면에서 "대부분 10입니다" 같은 안내에만 쓴다 */
export const TYPICAL_ALT_CONTRACT_USD = COMMON_ALT_CONTRACT_USD;

// ── 수량 변환 ──────────────────────────────────────────

export interface ContractConversion {
  ok: boolean;
  /** 정수 계약 수 */
  contracts: number;
  /** 그 계약 수의 실제 명목가(USD) */
  actualNotionalUsd: number;
  /** 요청과 실제의 차이. 반올림 때문에 생긴다 */
  shortfallUsd: number;
  reason?: string;
}

/**
 * 원하는 명목가(USD)를 계약 수로 바꾼다.
 *
 * **항상 내림한다.** 올리면 의도보다 큰 포지션이 열리고, COIN-M은
 * 계약 하나가 100 USD라 한 계약 차이가 크다.
 */
export function notionalToContracts(notionalUsd: number, contractUsd: number): ContractConversion {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
    return { ok: false, contracts: 0, actualNotionalUsd: 0, shortfallUsd: 0, reason: '명목가가 유효하지 않습니다' };
  }
  if (!Number.isFinite(contractUsd) || contractUsd <= 0) {
    return { ok: false, contracts: 0, actualNotionalUsd: 0, shortfallUsd: 0, reason: '계약 크기를 알 수 없습니다' };
  }

  const contracts = Math.floor(notionalUsd / contractUsd);
  if (contracts < 1) {
    return {
      ok: false, contracts: 0, actualNotionalUsd: 0, shortfallUsd: notionalUsd,
      reason: `1계약이 ${contractUsd} USD입니다. ${notionalUsd} USD로는 한 계약도 살 수 없습니다.`,
    };
  }
  const actual = contracts * contractUsd;
  return { ok: true, contracts, actualNotionalUsd: actual, shortfallUsd: notionalUsd - actual };
}

/** 계약 수 → 코인 수량. 가격이 있어야 한다 (역방향이라 가격에 반비례) */
export function contractsToCoin(
  contracts: number, contractUsd: number, price: number,
): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(contracts) || contracts <= 0) return null;
  return (contracts * contractUsd) / price;
}

// ── 증거금 (코인 단위) ─────────────────────────────────

export interface CoinMarginResult {
  ok: boolean;
  /** 필요 증거금 — **코인 단위**다. USD가 아니다 */
  marginCoin: number;
  /** 참고용 USD 환산. 표시에만 쓰고 계산에 쓰지 않는다 */
  marginUsdApprox: number;
  reason?: string;
}

/**
 * 필요 증거금을 **코인 단위**로 낸다.
 *
 * COIN-M은 BTC로 마진을 걸고 BTC로 번다. 여기서 USD를 돌려주면
 * 호출자가 그 값으로 "USDT 잔고 충분한가"를 판단하게 되는데,
 * COIN-M 지갑에는 USDT가 없다.
 */
export function requiredMarginCoin(
  contracts: number, contractUsd: number, price: number, leverage: number,
): CoinMarginResult {
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, marginCoin: 0, marginUsdApprox: 0, reason: '가격을 모릅니다' };
  }
  if (!Number.isFinite(leverage) || leverage < 1) {
    return { ok: false, marginCoin: 0, marginUsdApprox: 0, reason: '레버리지가 유효하지 않습니다' };
  }
  const coin = contractsToCoin(contracts, contractUsd, price);
  if (coin == null) {
    return { ok: false, marginCoin: 0, marginUsdApprox: 0, reason: '수량을 계산할 수 없습니다' };
  }
  const marginCoin = coin / leverage;
  return { ok: true, marginCoin, marginUsdApprox: marginCoin * price };
}

// ── 역방향 손익 ────────────────────────────────────────

/**
 * 역방향 계약의 손익(코인 단위).
 *
 * 공식: 계약수 × 계약크기 × (1/진입가 − 1/청산가)  [롱]
 * 선형(USDT-M) 공식으로 계산하면 틀린다. 특히 큰 변동에서 차이가 커진다.
 */
export function inversePnlCoin(
  contracts: number, contractUsd: number,
  entryPrice: number, exitPrice: number,
  side: 'LONG' | 'SHORT',
): number | null {
  if (![contracts, contractUsd, entryPrice, exitPrice].every(v => Number.isFinite(v) && v > 0)) {
    return null;
  }
  const usd = contracts * contractUsd;
  const raw = usd * (1 / entryPrice - 1 / exitPrice);
  return side === 'LONG' ? raw : -raw;
}

/**
 * 역방향 청산가 (근사).
 *
 * 유지증거금률을 반영한 근사치다. 실제 청산가는 거래소가 계산하며
 * 이보다 가깝다. 화면에도 그렇게 적어야 한다 — 이 값을 믿고
 * 손절을 그 너머에 두면 청산이 먼저 온다.
 */
export function inverseLiquidationPrice(
  entryPrice: number, leverage: number, side: 'LONG' | 'SHORT', mmrPct = 0.5,
): number | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!Number.isFinite(leverage) || leverage < 1) return null;

  const im = 1 / leverage;              // 초기증거금률
  const mm = mmrPct / 100;              // 유지증거금률
  // 역방향에서는 1/P 공간에서 선형이다
  const invEntry = 1 / entryPrice;
  const delta = im - mm;
  const invLiq = side === 'LONG' ? invEntry * (1 + delta) : invEntry * (1 - delta);
  if (invLiq <= 0) return null;
  return 1 / invLiq;
}

// ── 주문 사전 검사 ─────────────────────────────────────

export interface CoinMIntent {
  symbol: string;
  side: 'BUY' | 'SELL';
  /** 계약 수 — 정수여야 한다 */
  contracts: number;
  leverage: number;
}

export interface CoinMCheck { ok: boolean; code?: string; reason?: string }

const no = (code: string, reason: string): CoinMCheck => ({ ok: false, code, reason });

export function checkCoinMIntent(i: CoinMIntent): CoinMCheck {
  if (!isCoinMSymbol(i.symbol)) {
    return no('not_coinm',
      `'${i.symbol}'은 COIN-M 심볼이 아닙니다. BTCUSD_PERP 형식이어야 합니다 ` +
      `(BTCUSDT는 USDⓈ-M입니다).`);
  }
  if (!Number.isFinite(i.contracts) || i.contracts <= 0) {
    return no('invalid_contracts', '계약 수가 유효하지 않습니다');
  }
  if (!Number.isInteger(i.contracts)) {
    return no('fractional_contracts',
      `계약 수는 정수여야 합니다 (요청 ${i.contracts}). COIN-M의 수량 단위는 코인이 아니라 계약입니다.`);
  }
  if (!Number.isFinite(i.leverage) || i.leverage < 1 || i.leverage > 125) {
    return no('invalid_leverage', '레버리지는 1~125 사이여야 합니다');
  }
  if (i.side !== 'BUY' && i.side !== 'SELL') {
    return no('invalid_side', 'BUY 또는 SELL만 가능합니다');
  }
  return { ok: true };
}
