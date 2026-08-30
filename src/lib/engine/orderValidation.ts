// src/lib/engine/orderValidation.ts
// 주문 파라미터 검증 — 거래소로 나가기 전 마지막 방어선.
// 음수·NaN·Infinity·비정상 크기·잘못된 심볼이 큐나 거래소에 들어가지 못하게 한다.

// 받는 주문유형 목록은 **화면과 같은 파일에서** 온다. 두 벌로 두면
// 화면이 서버가 받지 않는 유형을 고르게 하거나, 뒤에서 조용히 다른 유형으로
// 바꾸는 일이 생긴다 — 실제로 그랬다.
import { SERVER_ORDER_TYPES, isServerOrderType, type ServerOrderType } from '../markets/orderTypes';

export interface OrderInput {
  symbol?: unknown;
  side?: unknown;
  type?: unknown;
  quantity?: unknown;
  price?: unknown;
  leverage?: unknown;
  reduceOnly?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  code?: string;
  value?: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: ServerOrderType;
    quantity: number;
    price?: number;
    leverage?: number;
    reduceOnly: boolean;
  };
}

// 안전 상한 — 실수로 큰 주문이 나가는 걸 막는다
const MAX_QUANTITY = 1_000_000;
const MAX_LEVERAGE = 125;
const MAX_PRICE = 100_000_000;

const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;   // BTCUSDT, ETHUSDT 등

function finiteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function validateOrder(input: OrderInput): ValidationResult {
  // ── 심볼 ──
  if (typeof input.symbol !== 'string' || !input.symbol.trim()) {
    return { ok: false, code: 'invalid_symbol', error: '심볼이 없습니다' };
  }
  const symbol = input.symbol.toUpperCase().replace('/', '').trim();
  if (!SYMBOL_RE.test(symbol)) {
    return { ok: false, code: 'invalid_symbol', error: `심볼 형식이 올바르지 않습니다: ${input.symbol}` };
  }

  // ── 방향 ──
  const sideRaw = String(input.side || '').toUpperCase();
  if (sideRaw !== 'BUY' && sideRaw !== 'SELL') {
    return { ok: false, code: 'invalid_side', error: 'side는 BUY 또는 SELL이어야 합니다' };
  }
  const side = sideRaw as 'BUY' | 'SELL';

  // ── 주문 유형 ──
  const typeRaw = String(input.type || 'MARKET').toUpperCase();
  if (!isServerOrderType(typeRaw)) {
    return {
      ok: false, code: 'invalid_type',
      error: `type은 ${SERVER_ORDER_TYPES.join(' 또는 ')}이어야 합니다 (받은 값: ${typeRaw})`,
    };
  }
  const type: ServerOrderType = typeRaw;

  // ── 수량 (핵심) ──
  const quantity = finiteNumber(input.quantity);
  if (quantity === null) {
    return { ok: false, code: 'invalid_quantity', error: `수량이 숫자가 아닙니다: ${String(input.quantity)}` };
  }
  if (quantity <= 0) {
    return { ok: false, code: 'invalid_quantity', error: `수량은 0보다 커야 합니다 (받은 값: ${quantity})` };
  }
  if (quantity > MAX_QUANTITY) {
    return { ok: false, code: 'quantity_too_large', error: `수량이 안전 상한(${MAX_QUANTITY})을 초과합니다: ${quantity}` };
  }

  // ── 가격 (LIMIT은 필수) ──
  let price: number | undefined;
  if (type === 'LIMIT') {
    const p = finiteNumber(input.price);
    if (p === null || p <= 0) {
      return { ok: false, code: 'price_required', error: 'LIMIT 주문에는 0보다 큰 가격이 필요합니다' };
    }
    if (p > MAX_PRICE) {
      return { ok: false, code: 'price_too_large', error: `가격이 비정상적으로 큽니다: ${p}` };
    }
    price = p;
  } else if (input.price != null) {
    const p = finiteNumber(input.price);
    if (p !== null && p > 0) price = p;
  }

  // ── 레버리지 ──
  let leverage: number | undefined;
  if (input.leverage != null) {
    const l = finiteNumber(input.leverage);
    if (l === null || !Number.isInteger(l) || l < 1 || l > MAX_LEVERAGE) {
      return { ok: false, code: 'invalid_leverage', error: `레버리지는 1~${MAX_LEVERAGE} 정수여야 합니다 (받은 값: ${String(input.leverage)})` };
    }
    leverage = l;
  }

  return {
    ok: true,
    value: { symbol, side, type, quantity, price, leverage, reduceOnly: !!input.reduceOnly },
  };
}
