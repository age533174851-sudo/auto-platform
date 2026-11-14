import { attestationVerdict, planAttestation, type AttestationObservation } from '../smoke/exposureAttestation';
import { protectiveClientOrderId } from '../engine/orderOwnership';
// Existing live_orders is the parent intent/ownership authority. No extra
// position ledger, credentials, or direct venue capability is introduced.
export interface AlgoStoreScope {
  userId: string; connectionId: string; parentId: string;
}
export type AlgoIntentState = 'SENT' | 'ACKED' | 'ACTIVE' | 'UNKNOWN' | 'CANCELED';
export interface StoredAlgoIntent {
  clientAlgoId: string;
  payload: Record<string, string>;
  state: AlgoIntentState;
  algoId: string | null;
  attestation?: unknown;
}

async function parent(sb: any, scope: AlgoStoreScope) {
  const result = await sb.from('live_orders').select('id,client_order_id,symbol,side,status,testnet_algo_intents')
    .eq('id', scope.parentId).eq('user_id', scope.userId).eq('connection_id', scope.connectionId)
    .eq('exchange', 'binance').eq('mode', 'TESTNET').maybeSingle();
  const row = result?.data;
  if (result?.error || !row || row.id !== scope.parentId
      || !row.testnet_algo_intents || typeof row.testnet_algo_intents !== 'object'
      || Array.isArray(row.testnet_algo_intents)) throw new Error('ALGO_PARENT_UNREADABLE');
  return row;
}
export async function readParentAlgoIntents(sb: any, scope: AlgoStoreScope): Promise<StoredAlgoIntent[]> {
  const row = await parent(sb, scope);
  return Object.values(row.testnet_algo_intents) as StoredAlgoIntent[];
}
export async function findAlgoParent(sb: any, userId: string, connectionId: string, clientOrderId: string): Promise<AlgoStoreScope | null> {
  const r = await sb.from('live_orders').select('id').eq('user_id', userId).eq('connection_id', connectionId)
    .eq('client_order_id', clientOrderId).eq('exchange', 'binance').eq('mode', 'TESTNET').maybeSingle();
  if (r?.error) throw new Error('ALGO_PARENT_UNREADABLE');
  return r?.data?.id ? { userId, connectionId, parentId: r.data.id } : null;
}

async function replace(sb: any, scope: AlgoStoreScope, before: any, after: any, status?: string): Promise<boolean> {
  let query = sb.from('live_orders').update({ testnet_algo_intents: after })
    .eq('id', scope.parentId).eq('user_id', scope.userId).eq('connection_id', scope.connectionId)
    .eq('exchange', 'binance').eq('mode', 'TESTNET')
    .eq('testnet_algo_intents', JSON.stringify(before));
  if (status) query = query.eq('status', status);
  const r = await query.select('id,testnet_algo_intents');
  if (r?.error || !Array.isArray(r?.data)) throw new Error('ALGO_INTENT_WRITE_UNCONFIRMED');
  if (r.data.length === 0) return false;
  if (r.data.length !== 1 || r.data[0]?.id !== scope.parentId
      || JSON.stringify(r.data[0]?.testnet_algo_intents) === undefined) {
    throw new Error('ALGO_INTENT_WRITE_UNCONFIRMED');
  }
  // JSONB key ordering is not significant; compare each complete intent below.
  const observed = r.data[0].testnet_algo_intents;
  for (const [key, value] of Object.entries(after)) {
    if (!sameIntent(observed?.[key], value as StoredAlgoIntent)) throw new Error('ALGO_INTENT_READBACK_MISMATCH');
  }
  if (Object.keys(observed).length !== Object.keys(after).length) throw new Error('ALGO_INTENT_READBACK_MISMATCH');
  return true;
}

function sameIntent(a: any, b: StoredAlgoIntent): boolean {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  return !!a && JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** A successful exact-row CAS is the ONLY permission to send once. */
export async function claimTestnetAlgoIntent(sb: any, scope: AlgoStoreScope,
  payload: Record<string, string>, sequence = 0): Promise<{ send: boolean; intent: StoredAlgoIntent }> {
  const connection = await sb.from('exchange_connections').select('id,exchange_id,is_testnet,has_withdrawal')
    .eq('id', scope.connectionId).eq('user_id', scope.userId).maybeSingle();
  if (connection?.error || connection?.data?.id !== scope.connectionId
      || connection.data.exchange_id !== 'binance' || connection.data.is_testnet !== true
      || connection.data.has_withdrawal !== false) throw new Error('VERIFIED_TESTNET_REQUIRED');
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await parent(sb, scope);
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 31
        || !['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(payload.type)
        || payload.clientAlgoId !== protectiveClientOrderId(row.client_order_id,
          payload.type === 'STOP_MARKET' ? 'STOP_LOSS' : 'TAKE_PROFIT', sequence)) throw new Error('ALGO_IDENTITY_MISMATCH');
    if (row.symbol !== payload.symbol || !['BUY', 'SELL'].includes(row.side)
        || payload.side !== (row.side === 'BUY' ? 'SELL' : 'BUY')
        || !['SENT', 'ACKED', 'FILLED'].includes(row.status)
        || !/^[.A-Z:/a-z0-9_-]{1,36}$/.test(payload.clientAlgoId || '')) throw new Error('ALGO_PARENT_MISMATCH');
    const before = row.testnet_algo_intents;
    const existing = before[payload.clientAlgoId];
    if (existing) {
      if (!sameIntent(existing, { ...existing, payload, clientAlgoId: payload.clientAlgoId })) throw new Error('ALGO_INTENT_CONFLICT');
      return { send: false, intent: existing };
    }
    if (Object.keys(before).length >= 32) throw new Error('ALGO_INTENT_LIMIT');
    const intent: StoredAlgoIntent = { payload, clientAlgoId: payload.clientAlgoId, state: 'SENT', algoId: null };
    if (await replace(sb, scope, before, { ...before, [payload.clientAlgoId]: intent }, row.status)) return { send: true, intent };
  }
  throw new Error('ALGO_INTENT_CONCURRENT_UPDATE');
}

/** Never turns an uncertain submission into a new send permission. */
export async function recordTestnetAlgoIntent(sb: any, scope: AlgoStoreScope,
  clientAlgoId: string, state: AlgoIntentState, algoId: string | null): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await parent(sb, scope), before = row.testnet_algo_intents;
    const intent = before[clientAlgoId] as StoredAlgoIntent | undefined;
    if (!intent || intent.clientAlgoId !== clientAlgoId) throw new Error('ALGO_INTENT_NOT_FOUND');
    if (intent.algoId != null && algoId !== intent.algoId) throw new Error('ALGO_ID_CHANGED');
    if (algoId != null && !/^[1-9][0-9]*$/.test(algoId)) throw new Error('ALGO_ID_INVALID');
    const allowed: Record<AlgoIntentState, AlgoIntentState[]> = {
      SENT: ['ACKED', 'UNKNOWN'], ACKED: ['ACTIVE', 'UNKNOWN', 'CANCELED'],
      ACTIVE: ['ACTIVE', 'UNKNOWN', 'CANCELED'], UNKNOWN: ['UNKNOWN', 'ACTIVE', 'CANCELED'], CANCELED: ['CANCELED'],
    };
    if (!allowed[intent.state]?.includes(state) || (state !== 'UNKNOWN' && !algoId)) throw new Error('ALGO_STATE_TRANSITION');
    if (intent.state === 'CANCELED') {
      if (state !== 'CANCELED') throw new Error('ALGO_INTENT_TERMINAL');
      return;
    }
    const next = { ...intent, state, algoId };
    if (await replace(sb, scope, before, { ...before, [clientAlgoId]: next })) return;
  }
  throw new Error('ALGO_INTENT_CONCURRENT_UPDATE');
}

/** Global connection fence includes timed-out/response-lost child intents. */
export async function testnetAlgoConnectionClear(sb: any, userId: string, connectionId: string): Promise<boolean> {
  const connection = await sb.from('exchange_connections').select('id,exchange_id,is_testnet,has_withdrawal')
    .eq('id', connectionId).eq('user_id', userId).maybeSingle();
  if (connection?.error || connection?.data?.id !== connectionId || connection.data.exchange_id !== 'binance'
      || connection.data.is_testnet !== true || connection.data.has_withdrawal !== false) return false;
  const r = await sb.from('live_orders').select('id,symbol,testnet_algo_intents')
    .eq('user_id', userId).eq('connection_id', connectionId).eq('exchange', 'binance').eq('mode', 'TESTNET')
    .neq('testnet_algo_intents', '{}').limit(201);
  if (r?.error || !Array.isArray(r?.data) || r.data.length > 200) return false;
  return r.data.every((row: any) => row.testnet_algo_intents && typeof row.testnet_algo_intents === 'object'
    && !Array.isArray(row.testnet_algo_intents)
    && Object.entries(row.testnet_algo_intents).every(([key, raw]) => {
      const intent = raw as StoredAlgoIntent;
      return intent?.clientAlgoId === key && intent?.payload?.clientAlgoId === key
        && intent.payload.symbol === row.symbol && intent.payload.algoType === 'CONDITIONAL'
        && ['SENT', 'ACKED', 'ACTIVE', 'UNKNOWN', 'CANCELED'].includes(intent.state)
        && (intent.state === 'CANCELED'
          ? /^[1-9][0-9]*$/.test(intent.algoId || '')
          : attestationVerdict(intent.attestation, Date.now()).accepted);
    }));
}

/** Reuses the authenticated recovery route's actual three-book observations.
 * Historical submission state is preserved; an attestation never permits a
 * resend of this same intent. Its six-hour freshness limit still applies.
 */
export async function attestParentAlgoIntents(sb: any, userId: string, connectionId: string,
  parentClientId: string, observation: AttestationObservation, nowMs: number): Promise<void> {
  const r = await sb.from('live_orders').select('id').eq('user_id', userId).eq('connection_id', connectionId)
    .eq('client_order_id', parentClientId).eq('exchange', 'binance').eq('mode', 'TESTNET').maybeSingle();
  if (r?.error) throw new Error('ALGO_PARENT_UNREADABLE');
  if (!r?.data) return;
  const scope = { userId, connectionId, parentId: r.data.id };
  for (let n = 0; n < 4; n++) {
    const row = await parent(sb, scope), before = row.testnet_algo_intents;
    const after: Record<string, StoredAlgoIntent> = {};
    for (const [id, raw] of Object.entries(before)) {
      const intent = raw as StoredAlgoIntent;
      if (intent?.clientAlgoId !== id || intent?.payload?.clientAlgoId !== id
          || intent.payload.symbol !== row.symbol || intent.payload.algoType !== 'CONDITIONAL') throw new Error('ALGO_INTENT_IDENTITY_UNKNOWN');
      const plan = planAttestation({ current: intent.attestation, observation,
        nowMs, method: 'positionRisk+openOrders+openAlgoOrders', env: 'TESTNET' });
      after[id] = { ...intent, attestation: plan.attestation };
    }
    if (Object.keys(after).length === 0 || await replace(sb, scope, before, after)) return;
  }
  throw new Error('ALGO_INTENT_CONCURRENT_UPDATE');
}
