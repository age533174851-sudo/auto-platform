// Binance USD-M Algo Service conditional STOP/TP contract — OFFLINE ONLY.
//
// Official API as reviewed 2026-10-16:
// POST /fapi/v1/algoOrder, algoType=CONDITIONAL, triggerPrice,
// clientAlgoId and response.algoId (distinct from regular orderId).
//
// CRITICAL: this module makes NO network requests, imports no exchange
// credentials and is NOT connected to startAttempt/placeFuturesTPSL.
// It is only a future adapter contract until tested with a real TESTNET
// signed GET/POST, safe cancellation/reconciliation, and release policies.
//
// Binance docs:
// https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Algo-Order

export type ConditionalAlgoKind = 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
export type AlgoClosingPosition = 'LONG' | 'SHORT';
export type AlgoPositionMode = 'ONE_WAY' | 'HEDGE' | 'UNKNOWN';

export interface BinanceConditionalAlgoIntent {
  environment: 'TESTNET' | 'LIVE' | 'UNKNOWN';
  symbol: string;
  positionMode: AlgoPositionMode;
  closes: AlgoClosingPosition;
  side: 'BUY' | 'SELL';
  type: ConditionalAlgoKind;
  /** Already normalized in the protective direction by roundTrigger. */
  triggerPrice: number;
  /** Verified Binance PRICE_FILTER.tickSize, not a default. */
  tickSize: number;
  workingType: 'MARK_PRICE' | 'CONTRACT_PRICE';
  /** Price of EXACTLY workingType (MARK or CONTRACT) from the same symbol. */
  referencePrice: number;
  /** Caller must provide observed and evaluation instants in Unix ms. */
  referenceObservedAtMs: number;
  evaluatedAtMs: number;
  /** Research freshness budget; must be 1..5000ms. */
  maxReferenceAgeMs: number;
  /** Exactly one form: true -> closePosition, false -> quantity + reduceOnly. */
  closeAll: boolean;
  quantity?: number | null;
  /** Verified LOT_SIZE step for the same symbol, if quantity is supplied. */
  quantityStep?: number | null;
  reduceOnly?: boolean | null;
  /** Stable idempotency key, NEVER regenerated on a network retry. */
  clientAlgoId: string;
}

export type AlgoContractCode =
  | 'OK'
  | 'NOT_TESTNET'
  | 'MODE_UNKNOWN_OR_UNSUPPORTED'
  | 'BAD_SYMBOL'
  | 'BAD_IDENTITY'
  | 'SIDE_MISMATCH'
  | 'BAD_TRIGGER'
  | 'TICK_UNKNOWN_OR_OFF_GRID'
  | 'CONFLICTING_CLOSE_FORM'
  | 'QUANTITY_UNKNOWN_OR_OFF_GRID'
  | 'INVALID_WORKING_TYPE'
  | 'REFERENCE_UNKNOWN_OR_STALE'
  | 'TRIGGER_WRONG_SIDE_OR_IMMEDIATE';

export interface AlgoPayloadVerdict {
  ok: boolean;
  code: AlgoContractCode;
  /** Only constructed in a verified scenario; never an execution grant. */
  payload: Record<string, string> | null;
  executionAuthorized: false;
}

const valid = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x > 0;
const gridAligned = (value: number, step: number): boolean => {
  if (!valid(value) || !valid(step)) return false;
  const ratio = value / step;
  return Number.isFinite(ratio) && ratio >= 1 &&
    Math.abs(ratio - Math.round(ratio)) < 1e-7;
};

const denied = (code: AlgoContractCode): AlgoPayloadVerdict =>
  ({ ok: false, code, payload: null, executionAuthorized: false });

export function buildBinanceConditionalAlgoPayload(
  i: BinanceConditionalAlgoIntent,
): AlgoPayloadVerdict {
  if (!i || i.environment !== 'TESTNET') return denied('NOT_TESTNET');
  // This research implementation supports ONE_WAY only. Hedge mode has
  // positionSide-specific order rules; do not fake them with BOTH.
  if (i.positionMode !== 'ONE_WAY') return denied('MODE_UNKNOWN_OR_UNSUPPORTED');
  if (!/^[A-Z0-9]{5,24}$/.test(i.symbol || '')) return denied('BAD_SYMBOL');
  if (!/^[.A-Z:/a-z0-9_-]{1,36}$/.test(i.clientAlgoId || '')) {
    return denied('BAD_IDENTITY');
  }
  if ((i.closes !== 'LONG' && i.closes !== 'SHORT') ||
      !['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(i.type)) {
    return denied('SIDE_MISMATCH');
  }
  if ((i.closes === 'LONG' && i.side !== 'SELL') ||
      (i.closes === 'SHORT' && i.side !== 'BUY')) {
    return denied('SIDE_MISMATCH');
  }
  if (!valid(i.triggerPrice)) return denied('BAD_TRIGGER');
  if (!gridAligned(i.triggerPrice, i.tickSize)) {
    return denied('TICK_UNKNOWN_OR_OFF_GRID');
  }
  if (i.workingType !== 'MARK_PRICE' && i.workingType !== 'CONTRACT_PRICE') {
    return denied('INVALID_WORKING_TYPE');
  }
  // A tick-aligned trigger can still be catastrophically placed on the
  // WRONG side of the current mark/contract price, immediately activating
  // on entry or leaving the position with unusable protection. No fallback
  // price or unbounded-age readback is accepted. The caller must prove that
  // referencePrice corresponds to the declared workingType.
  const timestamp = (x: unknown) =>
    typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
  if (!valid(i.referencePrice) ||
      !timestamp(i.referenceObservedAtMs) ||
      !timestamp(i.evaluatedAtMs) ||
      !timestamp(i.maxReferenceAgeMs) || i.maxReferenceAgeMs > 5000 ||
      i.referenceObservedAtMs > i.evaluatedAtMs ||
      i.evaluatedAtMs - i.referenceObservedAtMs > i.maxReferenceAgeMs) {
    return denied('REFERENCE_UNKNOWN_OR_STALE');
  }
  const shouldBeAboveReference = i.type === 'STOP_MARKET'
    ? i.closes === 'SHORT'
    : i.closes === 'LONG';
  if (shouldBeAboveReference
    ? !(i.triggerPrice > i.referencePrice)
    : !(i.triggerPrice < i.referencePrice)) {
    return denied('TRIGGER_WRONG_SIDE_OR_IMMEDIATE');
  }

  const payload: Record<string, string> = {
    algoType: 'CONDITIONAL',
    symbol: i.symbol, side: i.side, positionSide: 'BOTH',
    type: i.type, triggerPrice: String(i.triggerPrice),
    workingType: i.workingType, clientAlgoId: i.clientAlgoId,
  };
  if (i.closeAll === true) {
    // Binance forbids reduceOnly OR quantity alongside closePosition=true.
    if (i.quantity != null || i.reduceOnly != null) {
      return denied('CONFLICTING_CLOSE_FORM');
    }
    payload.closePosition = 'true';
  } else if (i.closeAll === false) {
    // For ONE_WAY quantity close, reduceOnly must be explicit and true.
    // Quantity cannot be rounded *up*, nor silently replaced.
    if (i.reduceOnly !== true || !valid(i.quantity) ||
        !gridAligned(i.quantity, Number(i.quantityStep))) {
      return denied('QUANTITY_UNKNOWN_OR_OFF_GRID');
    }
    payload.quantity = String(i.quantity);
    payload.reduceOnly = 'true';
  } else {
    return denied('CONFLICTING_CLOSE_FORM');
  }

  return { ok: true, code: 'OK', payload, executionAuthorized: false };
}

// ── Signed GET-by-clientAlgoId: a READ ONLY path toward venue evidence ──
//
// This injects a GET-only transport for testability. Its caller must be
// server-side and must use the verified connection owner's TESTNET key.
// A 404/not-found, network timeout or malformed 200 is UNKNOWN, NOT
// proof the conditional order was never accepted.
//
// NOTE: Unlike the offline payload builder above, the transport below may
// be wired to a signed exchange GET. It can NEVER create, cancel or
// authorize a position. Request and response fields are deliberately narrow.
export interface AlgoIndividualLookup {
  code: 'FOUND_UNVERIFIED' | 'INVALID_SCOPE' |
    'VENUE_READ_UNKNOWN' | 'VENUE_IDENTITY_MISMATCH';
  order: any | null;
  canResend: false;
  canCancel: false;
  executionAuthorized: false;
}

export type AlgoSignedGet = (
  path: '/fapi/v1/algoOrder',
  params: { clientAlgoId: string },
) => Promise<any>;

export async function queryBinanceAlgoByClientId(
  i: {
    environment: 'TESTNET' | 'LIVE' | 'UNKNOWN';
    symbol: string;
    clientAlgoId: string;
  },
  readSignedGet: AlgoSignedGet | null | undefined,
): Promise<AlgoIndividualLookup> {
  const failed = (code: AlgoIndividualLookup['code']): AlgoIndividualLookup =>
    ({ code, order: null, canResend: false, canCancel: false,
      executionAuthorized: false });
  if (i?.environment !== 'TESTNET' ||
      !/^[A-Z0-9]{5,24}$/.test(i?.symbol ?? '') ||
      !/^[.A-Z:/a-z0-9_-]{1,36}$/.test(i?.clientAlgoId ?? '') ||
      typeof readSignedGet !== 'function') {
    return failed('INVALID_SCOPE');
  }
  try {
    const r: any = await readSignedGet('/fapi/v1/algoOrder', {
      clientAlgoId: i.clientAlgoId,
    });
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return failed('VENUE_READ_UNKNOWN');
    }
    const id = r.algoId;
    const validId = typeof id === 'string'
      ? /^[1-9][0-9]*$/.test(id)
      : typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
    if (!validId || r.algoType !== 'CONDITIONAL' ||
        r.clientAlgoId !== i.clientAlgoId || r.symbol !== i.symbol ||
        !['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET',
          'STOP', 'TAKE_PROFIT'].includes(r.orderType) ||
        !['BUY', 'SELL'].includes(r.side) ||
        !['BOTH', 'LONG', 'SHORT'].includes(r.positionSide) ||
        typeof r.algoStatus !== 'string') {
      return failed('VENUE_IDENTITY_MISMATCH');
    }
    return {
      code: 'FOUND_UNVERIFIED', order: r, canResend: false,
      canCancel: false, executionAuthorized: false,
    };
  } catch {
    return failed('VENUE_READ_UNKNOWN');
  }
}

export interface AcceptedAlgoOrder {
  code: 'ACKED_UNVERIFIED' | 'UNKNOWN';
  acceptedAlgoId: string | null;
  clientAlgoId: string | null;
  /** ACK is not evidence the protection is active on the exchange. */
  venueProtectionActiveVerified: false;
  executionAuthorized: false;
}

/**
 * Accept only a matching idempotency echo and lossless int64 `algoId`.
 * Never borrow regular orderId; never Number() an unsafe integer.
 * Even a matching ACK is not a successful protective readback.
 */
export function parseBinanceAlgoAcceptance(
  response: any,
  payload: Record<string, string> | null,
): AcceptedAlgoOrder {
  const unknown: AcceptedAlgoOrder = {
    code: 'UNKNOWN', acceptedAlgoId: null, clientAlgoId: null,
    venueProtectionActiveVerified: false, executionAuthorized: false,
  };
  if (!payload || !response || response.algoType !== 'CONDITIONAL' ||
      response.clientAlgoId !== payload.clientAlgoId ||
      response.symbol !== payload.symbol ||
      response.side !== payload.side ||
      response.orderType !== payload.type) {
    return unknown;
  }
  const raw = response.algoId;
  let id: string | null = null;
  if (typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw)) id = raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    id = String(raw);
  }
  if (!id) return unknown;
  return { code: 'ACKED_UNVERIFIED', acceptedAlgoId: id,
    clientAlgoId: payload.clientAlgoId,
    venueProtectionActiveVerified: false, executionAuthorized: false };
}

/**
 * Follow-up READ-ONLY proof from GET /fapi/v1/openAlgoOrders.
 *
 * This is a *snapshot* of currently listed Algo orders, not a guarantee
 * that the stop can fill before liquidation or that it cannot disappear
 * between reads. Missing from the list is UNKNOWN (filled/cancelled/missed
 * from view), NEVER permission to resend a second stop.
 */
export function verifyBinanceAlgoOpenReadback(i: {
  accepted: AcceptedAlgoOrder;
  payload: Record<string, string> | null;
  venueRead: { success?: unknown; orders?: unknown } | null | undefined;
}): {
  code: 'LISTED_OPEN_AT_READ' | 'NOT_LISTED_UNKNOWN' | 'READ_UNKNOWN' | 'IDENTITY_MISMATCH';
  listedOpenAtRead: boolean;
  executionAuthorized: false;
} {
  const fail = (code: 'NOT_LISTED_UNKNOWN' | 'READ_UNKNOWN' | 'IDENTITY_MISMATCH') =>
    ({ code, listedOpenAtRead: false, executionAuthorized: false as const });
  const p = i?.payload;
  const a = i?.accepted;
  if (!p || a?.code !== 'ACKED_UNVERIFIED' || !a.acceptedAlgoId ||
      !a.clientAlgoId || a.clientAlgoId !== p.clientAlgoId) {
    return fail('IDENTITY_MISMATCH');
  }
  if (i.venueRead?.success !== true ||
      !Array.isArray(i.venueRead?.orders)) {
    return fail('READ_UNKNOWN');
  }
  // The venue ID may be int64. Treat a numeric ID as usable ONLY while
  // Number.isSafeInteger; never round an int64 then claim it matches.
  const lossless = (x: any): string | null =>
    typeof x === 'string' && /^[1-9][0-9]*$/.test(x) ? x
    : typeof x === 'number' && Number.isSafeInteger(x) && x > 0 ? String(x)
    : null;
  const matchesClientId = i.venueRead.orders.filter((o: any) =>
    o?.clientAlgoId === a.clientAlgoId);
  if (matchesClientId.length === 0) return fail('NOT_LISTED_UNKNOWN');
  if (matchesClientId.length !== 1) return fail('IDENTITY_MISMATCH');
  const o = matchesClientId[0];
  const same = lossless(o.algoId) === a.acceptedAlgoId &&
    o.symbol === p.symbol && o.side === p.side &&
    o.algoType === 'CONDITIONAL' &&
    o.orderType === p.type && o.positionSide === 'BOTH' &&
    o.algoStatus === 'NEW' && o.workingType === p.workingType &&
    Number.isFinite(Number(o.triggerPrice)) &&
    Number(o.triggerPrice) === Number(p.triggerPrice) &&
    (p.closePosition === 'true'
      ? o.closePosition === true && !o.reduceOnly
      : o.reduceOnly === true && !o.closePosition &&
        Number.isFinite(Number(o.quantity)) &&
        Number(o.quantity) === Number(p.quantity));
  if (!same) return fail('IDENTITY_MISMATCH');
  return { code: 'LISTED_OPEN_AT_READ',
    listedOpenAtRead: true, executionAuthorized: false };
}

/**
 * Recovery after POST response loss / process restart.
 *
 * Queries must be performed with the SAME VERIFIED owner's TESTNET key,
 * the same symbol, and persisted immutable clientAlgoId. GET algoOrder
 * includes terminal history; GET openAlgoOrders includes only live
 * conditional orders. One empty open list NEVER means "never accepted".
 *
 * This is a pure readback classifier with NO retry, cancel or order
 * capability. Recovery of canceled/triggered/expired orders still requires
 * flat-position proof, actualOrderId fill reconciliation and other
 * outstanding close-intent owner checks before considering any new trade.
 */
export type AlgoRecoveryCode =
  | 'OPEN_CONFIRMED_AT_READ'
  | 'TRIGGERED_OR_TERMINAL_NEEDS_RECONCILIATION'
  | 'OPEN_LIST_CONFLICT_UNKNOWN'
  | 'ORDER_LOOKUP_UNKNOWN'
  | 'OPEN_LOOKUP_UNKNOWN'
  | 'VENUE_IDENTITY_MISMATCH';

export interface AlgoRecoveryVerdict {
  code: AlgoRecoveryCode;
  algoId: string | null;
  mustInspectPositionAndFills: true;
  canResendAlgoOrder: false;
  canCancelAlgoOrder: false;
  executionAuthorized: false;
}

export function inspectBinanceAlgoRecovery(i: {
  expectedPayload: Record<string, string> | null;
  orderLookup: { success?: unknown; order?: unknown } | null | undefined;
  openLookup: { success?: unknown; orders?: unknown } | null | undefined;
}): AlgoRecoveryVerdict {
  const result = (code: AlgoRecoveryCode, algoId: string | null = null):
    AlgoRecoveryVerdict => ({
      code, algoId, mustInspectPositionAndFills: true,
      canResendAlgoOrder: false, canCancelAlgoOrder: false,
      executionAuthorized: false,
    });
  const p = i?.expectedPayload;
  if (!p || !p.clientAlgoId || !p.symbol || !p.type ||
      p.algoType !== 'CONDITIONAL') {
    return result('VENUE_IDENTITY_MISMATCH');
  }
  if (i?.orderLookup?.success !== true ||
      !i.orderLookup.order || typeof i.orderLookup.order !== 'object') {
    return result('ORDER_LOOKUP_UNKNOWN');
  }
  const q: any = i.orderLookup.order;
  // The parser validates exact original request identity and retains int64
  // algoId as a string. A forged, stale or foreign venue order blocks.
  const accepted = parseBinanceAlgoAcceptance(q, p);
  if (accepted.code !== 'ACKED_UNVERIFIED') {
    return result('VENUE_IDENTITY_MISMATCH');
  }
  const id = accepted.acceptedAlgoId;
  if (q.positionSide !== 'BOTH' ||
      q.workingType !== p.workingType ||
      !Number.isFinite(Number(q.triggerPrice)) ||
      Number(q.triggerPrice) !== Number(p.triggerPrice) ||
      (p.closePosition === 'true'
        ? q.closePosition !== true || q.reduceOnly === true
        : q.closePosition === true || q.reduceOnly !== true ||
          !Number.isFinite(Number(q.quantity)) ||
          Number(q.quantity) !== Number(p.quantity))) {
    return result('VENUE_IDENTITY_MISMATCH', id);
  }
  // A triggered conditional creates an ACTUAL order (possibly partly
  // filled). Terminal status is NOT proof that the position is flat.
  if (q.algoStatus !== 'NEW' ||
      (q.actualOrderId != null && String(q.actualOrderId) !== '')) {
    return result('TRIGGERED_OR_TERMINAL_NEEDS_RECONCILIATION', id);
  }
  if (i?.openLookup?.success !== true ||
      !Array.isArray(i.openLookup.orders)) {
    return result('OPEN_LOOKUP_UNKNOWN', id);
  }
  const evidence = verifyBinanceAlgoOpenReadback({
    accepted, payload: p, venueRead: i.openLookup,
  });
  return evidence.code === 'LISTED_OPEN_AT_READ'
    ? result('OPEN_CONFIRMED_AT_READ', id)
    : result('OPEN_LIST_CONFLICT_UNKNOWN', id);
}

/**
 * Cancel is never "done" just because DELETE /fapi/v1/algoOrder returned 200.
 * Its response is not a fill/position proof, and a lost response does NOT
 * authorize retry. A later signed GET must show the exact Algo order as
 * canceled, and the open order book must no longer list this clientAlgoId.
 *
 * Even this classified observation leaves account exposure UNKNOWN:
 * stop cancellation can strand an open position, and a sibling TP may
 * still be active. A separate connection-scoped position + order
 * reconciliation is mandatory. This function never performs a DELETE.
 */
export function inspectBinanceAlgoCancellationEvidence(i: {
  expectedPayload: Record<string, string> | null;
  accepted: AcceptedAlgoOrder;
  deleteReceipt: any;
  orderLookup: { success?: unknown; order?: unknown } | null | undefined;
  openLookup: { success?: unknown; orders?: unknown } | null | undefined;
}): {
  code: 'CANCEL_OBSERVED_POSITION_UNKNOWN' | 'RECEIPT_UNKNOWN' |
    'LOOKUP_UNKNOWN' | 'STILL_OPEN' | 'VENUE_IDENTITY_MISMATCH';
  canStartNewPosition: false;
  canRepeatCancel: false;
  canMarkPositionFlat: false;
  executionAuthorized: false;
} {
  const result = (code: 'CANCEL_OBSERVED_POSITION_UNKNOWN' | 'RECEIPT_UNKNOWN' |
    'LOOKUP_UNKNOWN' | 'STILL_OPEN' | 'VENUE_IDENTITY_MISMATCH') => ({
    code, canStartNewPosition: false as const,
    canRepeatCancel: false as const, canMarkPositionFlat: false as const,
    executionAuthorized: false as const,
  });
  const p = i?.expectedPayload;
  const accepted = i?.accepted;
  if (!p || !accepted || accepted.code !== 'ACKED_UNVERIFIED' ||
      accepted.clientAlgoId !== p.clientAlgoId || !accepted.acceptedAlgoId) {
    return result('VENUE_IDENTITY_MISMATCH');
  }
  const lossless = (n: any) => typeof n === 'string' && /^[1-9][0-9]*$/.test(n)
    ? n : typeof n === 'number' && Number.isSafeInteger(n) && n > 0
      ? String(n) : null;
  if (!i.deleteReceipt ||
      lossless(i.deleteReceipt.algoId) !== accepted.acceptedAlgoId ||
      i.deleteReceipt.clientAlgoId !== p.clientAlgoId ||
      ![200, '200'].includes(i.deleteReceipt.code)) {
    return result('RECEIPT_UNKNOWN');
  }
  const query = i?.orderLookup;
  const open = i?.openLookup;
  if (query?.success !== true || !query.order ||
      open?.success !== true || !Array.isArray(open.orders)) {
    return result('LOOKUP_UNKNOWN');
  }
  const q: any = query.order;
  const mirrored = parseBinanceAlgoAcceptance(q, p);
  if (mirrored.code !== 'ACKED_UNVERIFIED' ||
      mirrored.acceptedAlgoId !== accepted.acceptedAlgoId ||
      q.positionSide !== 'BOTH' || q.workingType !== p.workingType ||
      Number(q.triggerPrice) !== Number(p.triggerPrice)) {
    return result('VENUE_IDENTITY_MISMATCH');
  }
  // Fail closed if any matching open algo remains, even if individual
  // lookup claims CANCELED. A race/inconsistent venue snapshot needs review.
  if (open.orders.some((o: any) =>
      o?.clientAlgoId === p.clientAlgoId ||
      lossless(o?.algoId) === accepted.acceptedAlgoId)) {
    return result('STILL_OPEN');
  }
  if (q.algoStatus !== 'CANCELED') {
    return result('LOOKUP_UNKNOWN');
  }
  return result('CANCEL_OBSERVED_POSITION_UNKNOWN');
}

/** Deletion must use Algo ID namespace; a regular-order ID is NOT interchangeable. */
export function binanceAlgoCancellationIdentifier(
  id: { kind: 'ALGO'; algoId: string } | { kind: 'REGULAR'; orderId: string },
): { ok: boolean; algoId: string | null; executionAuthorized: false } {
  if (id?.kind !== 'ALGO' || !/^[1-9][0-9]*$/.test(id.algoId ?? '')) {
    return { ok: false, algoId: null, executionAuthorized: false };
  }
  return { ok: true, algoId: id.algoId, executionAuthorized: false };
}
