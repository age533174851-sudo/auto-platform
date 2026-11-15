import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { readGateTestnetExposure } from '@/lib/exchanges/gateFutures';
import { toGateContract } from '@/lib/exchanges/gatePlan';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(code: string, status: number) {
  return NextResponse.json({ ok: false, code }, { status, headers: NO_STORE });
}

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req.headers.get('authorization'), null, null);
  if (!userId) return failure('AUTH_REQUIRED', 401);
  const testId = req.nextUrl.searchParams.get('testId');
  if (!testId || !UUID.test(testId)) return failure('BAD_TEST_ID', 400);

  const db = getSupabaseAdmin();
  if (!db) return failure('DATABASE_UNAVAILABLE', 503);

  try {
    // smoke_tests is absent from the generated Database table types.
    const smokeLedger = db as unknown as SupabaseClient;
    const { data: row, error } = await smokeLedger.from('smoke_tests')
      .select('id,connection_id,symbol,mode,state')
      .eq('id', testId).eq('user_id', userId).maybeSingle();
    if (error) return failure('SMOKE_ROW_UNREADABLE', 503);
    if (!row) return failure('NOT_FOUND', 404);

    const contract = typeof row.symbol === 'string' ? toGateContract(row.symbol) : null;
    if (row.mode !== 'TESTNET' || row.state !== 'FAIL' || typeof row.connection_id !== 'string'
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
    return NextResponse.json({
      ok: readable,
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
