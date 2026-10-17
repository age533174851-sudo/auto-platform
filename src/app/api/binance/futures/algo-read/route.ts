// POST /api/binance/futures/algo-read
//
// READ ONLY — inspect an already-known Binance conditional Algo by
// stable clientAlgoId. NEVER sends or cancels an order, changes a DB row,
// starts a smoke run or assumes a missing order was rejected.
//
// Server-only TESTNET signed GET: /fapi/v1/algoOrder?clientAlgoId=...
// Neither x-admin-secret nor x-user-id may bypass ownership. Expose only
// an abbreviated evidence classification and status, NOT API keys/URLs.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadBinanceCreds } from '@/lib/exchanges/loadCreds';
import { getFuturesAlgoByClientIdReadOnly } from '@/lib/exchanges/binanceFutures';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

function answer(body: Record<string, any>, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req.headers.get('authorization'), null, null);
  if (!userId) return answer({ ok: false, code: 'AUTH_REQUIRED' }, 401);

  let body: any;
  try { body = await req.json(); }
  catch { return answer({ ok: false, code: 'BAD_JSON' }, 400); }

  const connectionId = body?.connectionId;
  const clientAlgoId = body?.clientAlgoId;
  const symbol = body?.symbol;
  if (typeof connectionId !== 'string' || connectionId.length > 100 ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(connectionId) ||
      typeof clientAlgoId !== 'string' ||
      !/^[.A-Z:/a-z0-9_-]{1,36}$/.test(clientAlgoId) ||
      symbol !== 'BTCUSDT' && symbol !== 'ETHUSDT') {
    return answer({ ok: false, code: 'INVALID_SCOPE' }, 400);
  }

  const sb = getSupabaseAdmin();
  if (!sb) return answer({ ok: false, code: 'DB_UNAVAILABLE' }, 503);

  let creds: Awaited<ReturnType<typeof loadBinanceCreds>>;
  try {
    creds = await loadBinanceCreds(sb, userId, connectionId);
  } catch {
    return answer({ ok: false, code: 'CONNECTION_READ_UNKNOWN' }, 503);
  }
  // An unknown is_testnet is not sufficient, even if the generic
  // loader would route it toward the demo host by default. LIVE is
  // forbidden, as are foreign, withdrawal-enabled or Gate connections.
  if (!creds.ok || creds.exchange !== 'binance' ||
      creds.isTestnetRaw !== true || creds.testnet !== true ||
      !creds.key || !creds.secret) {
    return answer({ ok: false, code: 'VERIFIED_TESTNET_CONNECTION_REQUIRED' }, 409);
  }

  const observed = await getFuturesAlgoByClientIdReadOnly(
    creds.key, creds.secret, true, symbol, clientAlgoId);
  if (observed.code !== 'FOUND_UNVERIFIED') {
    return answer({
      ok: false, code: observed.code, observedAt: new Date().toISOString(),
      canResend: false, canCancel: false, mayStartSmoke: false,
    }, observed.code === 'VENUE_READ_UNKNOWN' ? 502 : 409);
  }

  const order = observed.order;
  return answer({
    ok: true, code: 'FOUND_UNVERIFIED',
    environment: 'TESTNET', symbol, clientAlgoId,
    algoType: order.algoType, algoStatus: order.algoStatus,
    orderType: order.orderType, side: order.side,
    positionSide: order.positionSide,
    actualOrderCreated: order.actualOrderId != null &&
      String(order.actualOrderId) !== '',
    observedAt: new Date().toISOString(),
    // GET of one conditional order cannot prove current position, fills,
    // other open ordinary/Algo orders, absence from open list, or ownership
    // of all historical items on this connection.
    positionFlatVerified: false, allOrdersClearVerified: false,
    activeProtectionVerified: false,
    canResend: false, canCancel: false, mayStartSmoke: false,
  }, 200);
}
