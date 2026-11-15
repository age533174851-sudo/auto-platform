import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { readGateTestnetExposure } from '@/lib/exchanges/gateFutures';
import { toGateContract } from '@/lib/exchanges/gatePlan';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

import {
  GATE_RECOVERY_KEY, gateRecoveryTimes, isGateRecoveryCandidate, nextGateRecoveryObservation,
} from '@/lib/smoke/gateRecovery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(code: string, status: number) {
  return NextResponse.json({ ok: false, code }, { status, headers: NO_STORE });
}

async function inspect(req: NextRequest, persist: boolean) {
  const userId = await resolveUserId(req.headers.get('authorization'), null, null);
  if (!userId) return failure('AUTH_REQUIRED', 401);
  const testId = req.nextUrl.searchParams.get('testId');
  const connectionId = req.nextUrl.searchParams.get('connectionId');
  if (testId ? !UUID.test(testId) : persist || !connectionId || !UUID.test(connectionId)) {
    return failure('BAD_SCOPE', 400);
  }
  if (persist && (!connectionId || !UUID.test(connectionId))) return failure('BAD_SCOPE', 400);

  const db = getSupabaseAdmin();
  if (!db) return failure('DATABASE_UNAVAILABLE', 503);

  try {
    // smoke_tests is absent from the generated Database table types.
    const smokeLedger = db as unknown as SupabaseClient;
    if (!testId) {
      const { data: connection, error: connectionError } = await smokeLedger.from('exchange_connections')
        .select('exchange_id,is_testnet').eq('id', connectionId).eq('user_id', userId).maybeSingle();
      if (connectionError) return failure('CONNECTION_UNREADABLE', 503);
      if (connection?.exchange_id !== 'gate' || connection.is_testnet !== true) {
        return failure('VERIFIED_GATE_TESTNET_REQUIRED', 409);
      }
      const { data: rows, error: listError } = await smokeLedger.from('smoke_tests')
        .select('id,symbol,mode,state,steps').eq('user_id', userId).eq('connection_id', connectionId)
        .eq('mode', 'TESTNET').eq('state', 'FAIL').limit(1000);
      if (listError || !Array.isArray(rows) || rows.length >= 1000) {
        return failure('SMOKE_ROW_UNREADABLE', 503);
      }
      return NextResponse.json({
        ok: true,
        candidates: rows.filter(isGateRecoveryCandidate).map(row => ({
          id: row.id, symbol: row.symbol,
          evidence: gateRecoveryTimes(row.steps?.[GATE_RECOVERY_KEY], Date.now()),
        })),
      }, { headers: NO_STORE });
    }

    const { data: row, error } = await smokeLedger.from('smoke_tests')
      .select('id,connection_id,symbol,mode,state,steps')
      .eq('id', testId).eq('user_id', userId).maybeSingle();
    if (error) return failure('SMOKE_ROW_UNREADABLE', 503);
    if (!row || (persist && row.connection_id !== connectionId)) return failure('NOT_FOUND', 404);

    const contract = typeof row.symbol === 'string' ? toGateContract(row.symbol) : null;
    if (!isGateRecoveryCandidate(row) || typeof row.connection_id !== 'string'
        || !UUID.test(row.connection_id) || !contract) {
      return failure('GATE_TESTNET_FAILURE_REQUIRED', 409);
    }

    const creds = await loadFuturesCreds(db, userId, row.connection_id);
    if (!creds.ok || creds.exchange !== 'gate' || creds.isTestnetRaw !== true
        || creds.testnet !== true || !creds.key || !creds.secret) {
      return failure('VERIFIED_GATE_TESTNET_REQUIRED', 409);
    }

    const evidence = await readGateTestnetExposure(creds.key, creds.secret, contract);
    const counts = Object.values(evidence);
    const readable = counts.every(count => count !== null);
    const flat = counts.every(count => count === 0);
    // Only an authenticated POST may record successful observations.
    if (persist && flat) {
      const observation = nextGateRecoveryObservation(row.steps?.[GATE_RECOVERY_KEY], Date.now());
      if (observation.write) {
        const steps = { ...row.steps, [GATE_RECOVERY_KEY]: observation.evidence };
        const { data: saved, error: writeError } = await smokeLedger.from('smoke_tests')
          .update({ steps }).eq('id', testId).eq('user_id', userId)
          .eq('connection_id', row.connection_id).eq('symbol', row.symbol)
          .eq('mode', 'TESTNET').eq('state', 'FAIL')
          .filter('steps', 'eq', JSON.stringify(row.steps)).select('id').maybeSingle();
        if (writeError || saved?.id !== testId) return failure('OBSERVATION_WRITE_UNCONFIRMED', 409);
      }
      return NextResponse.json({ ok: true, ...observation }, { headers: NO_STORE });
    }
    return NextResponse.json({
      ok: readable && (!persist || flat),
      code: !readable ? 'UNREADABLE' : flat ? 'FLAT' : 'EXPOSURE_PRESENT',
      testId,
      symbol: row.symbol,
      observedAt: new Date().toISOString(),
      ...evidence,
    }, { status: readable ? 200 : 503, headers: NO_STORE });
  } catch {
    return failure('EVIDENCE_UNAVAILABLE', 503);
  }
}

export async function GET(req: NextRequest) {
  return inspect(req, false);
}

export async function POST(req: NextRequest) {
  return inspect(req, true);
}
