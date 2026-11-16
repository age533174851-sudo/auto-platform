// POST /api/autotrade/smoke-test/legacy-evidence
//
// READ ONLY, user-authorized, Binance USD-M TESTNET ONLY.
// Purpose: obtain current venue snapshots for old smoke attempts with a
// missing ORDERS_ZERO field. This does not mark old attempts PASS, does not
// change the database, and never submits/cancels an exchange order.
//
// WARNING: signed GETs of positionRisk, openOrders and openAlgoOrders are
// not one atomic venue snapshot. This alone does not clear historical
// UNKNOWN results and does not authorize a new smoke run.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadBinanceCreds } from '@/lib/exchanges/loadCreds';
import {
  getFuturesPositions, getFuturesOpenOrders, getFuturesOpenAlgoOrders,
} from '@/lib/exchanges/binanceFutures';
import { legacySmokeExposureVerdict } from '@/lib/smoke/smokePlan';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function POST(req: NextRequest) {
  // Deliberately disallow admin-secret, x-user-id, or dev-token shortcuts.
  // A signed-in user may inspect ONLY their own past smoke attempt.
  const userId = await resolveUserId(req.headers.get('authorization'), null, null);
  if (!userId) return NextResponse.json(
    { ok: false, code: 'AUTH_REQUIRED' }, { status: 401, headers: NO_STORE });

  let body: any = null;
  try { body = await req.json(); } catch {
    return NextResponse.json(
      { ok: false, code: 'INVALID_JSON' }, { status: 400, headers: NO_STORE });
  }
  const testId = body?.testId;
  if (typeof testId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(testId)) {
    return NextResponse.json(
      { ok: false, code: 'BAD_TEST_ID' }, { status: 400, headers: NO_STORE });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json(
    { ok: false, code: 'DATABASE_UNAVAILABLE' }, { status: 503, headers: NO_STORE });

  let attempt: any;
  try {
    const result = await (sb as any).from('smoke_tests')
      .select('id,user_id,connection_id,symbol,state,mode,steps,created_at')
      .eq('id', testId).eq('user_id', userId).maybeSingle();
    if (result.error) throw new Error('SMOKE_ROW_UNREADABLE');
    attempt = result.data;
  } catch {
    return NextResponse.json(
      { ok: false, code: 'SMOKE_ROW_UNREADABLE' }, { status: 503, headers: NO_STORE });
  }
  if (!attempt) return NextResponse.json(
    { ok: false, code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });

  // An active/unknown exposure must not be touched by a historical
  // recovery utility; this endpoint only diagnoses terminal UNKNOWN rows.
  if (attempt.mode !== 'TESTNET' || attempt.state !== 'UNKNOWN' ||
      (attempt.symbol !== 'BTCUSDT' && attempt.symbol !== 'ETHUSDT')) {
    return NextResponse.json(
      { ok: false, code: 'NOT_LEGACY_TESTNET_UNKNOWN' },
      { status: 409, headers: NO_STORE });
  }

  const creds = await loadBinanceCreds(sb, userId, attempt.connection_id);
  if (!creds.ok || creds.exchange !== 'binance' ||
      creds.isTestnetRaw !== true || creds.testnet !== true ||
      !creds.key || !creds.secret) {
    return NextResponse.json(
      { ok: false, code: 'VERIFIED_TESTNET_REQUIRED' },
      { status: 409, headers: NO_STORE });
  }

  // All three requests are GET; deliberately no exposure to order IDs,
  // API keys, secrets, or raw response/error bodies in the client result.
  let observed: ReturnType<typeof legacySmokeExposureVerdict>;
  try {
    const [positionRead, regularOrderRead, algoOrderRead] = await Promise.all([
      getFuturesPositions(creds.key, creds.secret, true),
      getFuturesOpenOrders(creds.key, creds.secret, true, attempt.symbol),
      getFuturesOpenAlgoOrders(creds.key, creds.secret, true, attempt.symbol),
    ]);
    observed = legacySmokeExposureVerdict({
      symbol: attempt.symbol,
      positionRead, regularOrderRead, algoOrderRead,
    });
  } catch {
    observed = legacySmokeExposureVerdict({
      symbol: attempt.symbol,
      positionRead: null, regularOrderRead: null, algoOrderRead: null,
    });
  }

  // This is a point-in-time observation only. Even OBSERVED_FLAT_NOW
  // cannot mark ORDERS_ZERO PASS in historical rows or greenlight a trade.
  return NextResponse.json({
    ok: true,
    code: observed.code,
    testId: attempt.id,
    symbol: attempt.symbol,
    observedAt: new Date().toISOString(),
    currentPositionCount: observed.positionCount,
    currentRegularOpenOrderCount: observed.regularOrderCount,
    currentConditionalAlgoOrderCount: observed.algoOrderCount,
    priorSmokeVerdictUnchanged: true,
    historicalEvidencePersisted: false,
    mayStartSmoke: false,
    note: '현재 세 조회 결과만 확인했습니다. 비원자적 시점 관측이며 과거 UNKNOWN 판정을 변경하지 않습니다.',
  }, { status: 200, headers: NO_STORE });
}
