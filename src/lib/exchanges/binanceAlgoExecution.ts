import {
  buildBinanceConditionalAlgoPayload, parseBinanceAlgoAcceptance,
  verifyBinanceAlgoOpenReadback, type BinanceConditionalAlgoIntent,
} from './binanceAlgoContract';
import { claimTestnetAlgoIntent, recordTestnetAlgoIntent, readParentAlgoIntents, type AlgoStoreScope } from './binanceAlgoStore';

export interface AlgoExecutionTransport {
  post(payload: Record<string, string>): Promise<unknown>;
  readOpen(symbol: string): Promise<{ success: boolean; orders: any[] }>;
}

/** After proven flat, cancel only this parent's immutable owned Algo intents.
 * Each identifier is reconciled by clientAlgoId, never guessed from an ID
 * namespace or a failed POST. Unknown/triggered history stays blocked.
 */
export async function cleanupTestnetAlgoParent(sb: any, scope: AlgoStoreScope,
  creds: { apiKey: string; apiSecret: string; testnet: boolean }, symbol: string): Promise<boolean> {
  if (creds.testnet !== true) return false;
  const bf = await import('./binanceFutures');
  const ops = await import('../engine/venuePositionOps');
  const venue = { ...creds, exchange: 'binance' as const };
  try {
    const before = await ops.readOpenPosition(venue, symbol);
    if (before.ok !== true || before.found !== false || before.qty !== 0) return false;
    const intents = await readParentAlgoIntents(sb, scope);
    for (const intent of intents) {
      if (intent.state === 'CANCELED') continue;
      if (intent.payload.symbol !== symbol || intent.clientAlgoId !== intent.payload.clientAlgoId) return false;
      const row = await bf.readTestnetAlgoOrder(creds.apiKey, creds.apiSecret, symbol, { clientAlgoId: intent.clientAlgoId });
      const accepted = parseBinanceAlgoAcceptance(row, intent.payload);
      if (!accepted.acceptedAlgoId || (intent.algoId && accepted.acceptedAlgoId !== intent.algoId)) return false;
      if (intent.state === 'SENT') await recordTestnetAlgoIntent(sb, scope, intent.clientAlgoId, 'ACKED', accepted.acceptedAlgoId);
      const canceled = await bf.cancelTestnetAlgoOrder(creds.apiKey, creds.apiSecret, symbol, `algo:${accepted.acceptedAlgoId}`, true);
      if (!canceled.success) return false;
      await recordTestnetAlgoIntent(sb, scope, intent.clientAlgoId, 'CANCELED', accepted.acceptedAlgoId);
    }
    const [after, orders] = await Promise.all([
      ops.readOpenPosition(venue, symbol), bf.getTestnetProtectiveOrders(creds.apiKey, creds.apiSecret, symbol),
    ]);
    return after.ok === true && after.found === false && after.qty === 0 && orders.success === true && orders.orders.length === 0;
  } catch { return false; }
}

/** Caller must already pass canonical owner/TESTNET/entry and risk gates.
 * The pure builder's executionAuthorized:false is not used as authorization.
 * A durable exact-row ownership CAS is mandatory before the ONLY POST.
 */
export async function executeTestnetAlgoProtection(sb: any, scope: AlgoStoreScope,
  intent: BinanceConditionalAlgoIntent, transport: AlgoExecutionTransport, sequence = 0) {
  const denied = (message: string, orderId: string | null = null) =>
    ({ success: false, message, orderId, protectionVerified: false });
  const built = buildBinanceConditionalAlgoPayload(intent);
  if (!built.ok || !built.payload) return denied(`ALGO_CONTRACT_${built.code}`);
  let claimed: Awaited<ReturnType<typeof claimTestnetAlgoIntent>>;
  try { claimed = await claimTestnetAlgoIntent(sb, scope, built.payload, sequence); }
  catch { return denied('ALGO_INTENT_NOT_CONFIRMED'); }
  // A previous SENT/UNKNOWN is recovery work, never a new POST permission.
  if (!claimed.send) return denied('ALGO_ALREADY_DISPATCHED_RECONCILE_REQUIRED',
    claimed.intent.algoId ? `algo:${claimed.intent.algoId}` : null);
  let acceptedId: string | null = null;
  try {
    if (Date.now() < intent.referenceObservedAtMs || Date.now() - intent.referenceObservedAtMs > intent.maxReferenceAgeMs) throw new Error('ALGO_REFERENCE_EXPIRED');
    const response = await transport.post(built.payload);
    const accepted = parseBinanceAlgoAcceptance(response, built.payload);
    acceptedId = accepted.acceptedAlgoId;
    if (accepted.code !== 'ACKED_UNVERIFIED' || !acceptedId) throw new Error('ALGO_ACK_UNKNOWN');
    await recordTestnetAlgoIntent(sb, scope, intent.clientAlgoId, 'ACKED', acceptedId);
    const open = await transport.readOpen(intent.symbol);
    const readback = verifyBinanceAlgoOpenReadback({ accepted, payload: built.payload, venueRead: open });
    if (!readback.listedOpenAtRead) throw new Error(`ALGO_${readback.code}`);
    await recordTestnetAlgoIntent(sb, scope, intent.clientAlgoId, 'ACTIVE', acceptedId);
    return { success: true, message: 'Algo 보호주문 재조회 확인', orderId: `algo:${acceptedId}`, protectionVerified: true };
  } catch {
    try { await recordTestnetAlgoIntent(sb, scope, intent.clientAlgoId, 'UNKNOWN', acceptedId); } catch { /* SENT/ACKED also block */ }
    return denied('ALGO_SUBMISSION_OR_READBACK_UNKNOWN', acceptedId ? `algo:${acceptedId}` : null);
  }
}
