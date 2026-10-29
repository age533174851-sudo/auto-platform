// POST /api/autotrade/smoke-test/attest-exposure
//
// **막아 놓은 것을 푸는 명령.** 사용자는 이것만 부른다.
//
// #343의 `legacy-evidence`는 지금 노출을 읽어 주지만 읽고 끝난다
// (`historicalEvidencePersisted: false`). 그래서 보고서에 "거래소에서
// 확인한 뒤 DB를 고쳐 주세요"가 남았다. 그 문장을 없애는 것이 이 경로다.
//
// 무엇을 하는가
// ─────────────
// 거래소 세 가지를 읽고(포지션 · 일반 미결 · 조건부 Algo 미결), 비어
// 있으면 **관측으로 적는다.** 간격을 둔 두 번째 관측까지 비어 있으면
// 사후 확인이 완성되고, 그때부터 `unresolvedExposureBlock`이 그 줄을
// 차단 사유로 쓰지 않는다.
//
// 무엇을 하지 않는가
// ──────────────────
//   · **과거를 고치지 않는다.** `state`·`verdict`·`ENTRY`는 그대로 둔다.
//     10월에 무슨 일이 있었는지는 모르고, 모르는 것은 모르는 채로 둔다.
//   · **기록된 FAIL을 덮지 않는다.** "주문이 남은 것을 봤다"는 사실은
//     지금 비어 있다는 관측으로 지워지지 않는다.
//   · **주문을 내지도 취소하지도 않는다.** GET 세 번이 전부다.
//   · **진입을 허가하지 않는다.** 진입 직전에는 `preflightVerdict`가
//     거래소를 다시 읽는다. 관문이 둘이고 이쪽이 풀려도 저쪽은 그대로다.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadBinanceCreds } from '@/lib/exchanges/loadCreds';
import {
  getFuturesPositions, getFuturesOpenOrders, getFuturesOpenAlgoOrders,
} from '@/lib/exchanges/binanceFutures';
import { legacySmokeExposureVerdict } from '@/lib/smoke/smokePlan';
import { planAttestation, observationOf } from '@/lib/smoke/exposureAttestation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHOD = 'positionRisk+openOrders+openAlgoOrders';

const bad = (code: string, status: number, extra: Record<string, any> = {}) =>
  NextResponse.json({ ok: false, code, ...extra }, { status, headers: NO_STORE });

/** 단계 상태 읽기 — 옛 행의 문자열 형태도 받는다 */
function stepState(steps: any, id: string): string | null {
  const v = steps?.[id];
  if (v == null) return null;
  const st = typeof v === 'string' ? v : v?.state;
  return st == null ? null : String(st).toUpperCase();
}

export async function POST(req: NextRequest) {
  // 관리자 시크릿·x-user-id·dev-token 우회를 두지 않는다.
  // 자기 회차만, 로그인한 본인이.
  const userId = await resolveUserId(req.headers.get('authorization'), null, null);
  if (!userId) return bad('AUTH_REQUIRED', 401);

  let body: any = null;
  try { body = await req.json(); } catch { return bad('INVALID_JSON', 400); }
  const testId = body?.testId;
  if (typeof testId !== 'string' || !UUID.test(testId)) return bad('BAD_TEST_ID', 400);

  const sb = getSupabaseAdmin();
  if (!sb) return bad('DATABASE_UNAVAILABLE', 503);

  let row: any;
  try {
    const r = await (sb as any).from('smoke_tests')
      .select('id,user_id,connection_id,symbol,state,mode,steps,created_at')
      .eq('id', testId).eq('user_id', userId).maybeSingle();
    if (r.error) throw new Error('unreadable');
    row = r.data;
  } catch { return bad('SMOKE_ROW_UNREADABLE', 503); }
  if (!row) return bad('NOT_FOUND', 404);

  if (row.mode !== 'TESTNET' || row.state !== 'UNKNOWN'
      || (row.symbol !== 'BTCUSDT' && row.symbol !== 'ETHUSDT')) {
    return bad('NOT_LEGACY_TESTNET_UNKNOWN', 409);
  }
  // **본 적 있는 FAIL은 사후 확인 대상이 아니다.** 그 줄은 사람이 직접
  // 보고 판단해야 한다 — 자동으로 지워 주면 그게 증거 없는 PASS다.
  if (stepState(row.steps, 'ORDERS_ZERO') === 'FAIL'
      || stepState(row.steps, 'POSITION_ZERO') === 'FAIL') {
    return bad('RECORDED_FAILURE_NOT_ATTESTABLE', 409);
  }

  const creds = await loadBinanceCreds(sb, userId, row.connection_id);
  if (!creds.ok || creds.exchange !== 'binance'
      || creds.isTestnetRaw !== true || creds.testnet !== true
      || !creds.key || !creds.secret) {
    return bad('VERIFIED_TESTNET_REQUIRED', 409);
  }

  // GET 세 번. 하나라도 못 읽으면 `legacySmokeExposureVerdict`가 UNKNOWN이다.
  let observed: ReturnType<typeof legacySmokeExposureVerdict>;
  try {
    const [positionRead, regularOrderRead, algoOrderRead] = await Promise.all([
      getFuturesPositions(creds.key, creds.secret, true),
      getFuturesOpenOrders(creds.key, creds.secret, true, row.symbol),
      getFuturesOpenAlgoOrders(creds.key, creds.secret, true, row.symbol),
    ]);
    observed = legacySmokeExposureVerdict({
      symbol: row.symbol, positionRead, regularOrderRead, algoOrderRead,
    });
  } catch {
    observed = legacySmokeExposureVerdict({
      symbol: row.symbol, positionRead: null, regularOrderRead: null, algoOrderRead: null,
    });
  }

  const nowMs = Date.now();
  const plan = planAttestation({
    current: row.steps?._attestation,
    observation: observationOf(observed, nowMs),
    nowMs, method: METHOD, env: 'TESTNET',
    sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
  });

  // ── 쓰기 ──
  //
  // **덧붙이기만 한다.** 기존 steps를 통째로 바꾸지 않고 `_attestation`
  // 칸만 교체한다. 그리고 id·user_id·connection_id를 전부 조건에 걸고
  // 되읽어 **정확히 한 줄**을 확인한다. 0행은 성공이 아니다 — 그 사이에
  // 줄이 바뀌었거나 남의 줄을 건드린 것이다.
  const steps = { ...(row.steps && typeof row.steps === 'object' ? row.steps : {}) };
  if (plan.attestation == null) delete (steps as any)._attestation;
  else (steps as any)._attestation = plan.attestation;

  let wrote: any;
  try {
    wrote = await (sb as any).from('smoke_tests')
      .update({ steps })
      .eq('id', row.id).eq('user_id', userId).eq('connection_id', row.connection_id)
      .select('id');
  } catch (e: any) {
    return bad('ATTESTATION_WRITE_FAILED', 503, { reason: String(e?.message ?? e) });
  }
  if (wrote?.error) {
    return bad('ATTESTATION_WRITE_FAILED', 503, { reason: String(wrote.error?.message ?? wrote.error) });
  }
  // `error: null`인데 0행인 경우가 있다. 그걸 성공으로 적으면 적히지도
  // 않은 관측 위에 다음 회차가 열린다.
  if (Array.isArray(wrote?.rows ?? wrote?.data) && (wrote.rows ?? wrote.data).length !== 1) {
    return bad('ATTESTATION_WRITE_UNCONFIRMED', 409,
      { rows: (wrote.rows ?? wrote.data).length });
  }

  return NextResponse.json({
    ok: true,
    phase: plan.phase,
    code: observed.code,
    testId: row.id,
    symbol: row.symbol,
    observedAt: new Date(nowMs).toISOString(),
    currentPositionCount: observed.positionCount,
    currentRegularOpenOrderCount: observed.regularOrderCount,
    currentConditionalAlgoOrderCount: observed.algoOrderCount,
    nextCheckInMs: plan.waitMs,
    // 과거 판정은 그대로다. 이 경로는 과거를 고치지 않는다.
    priorSmokeVerdictUnchanged: true,
    // 진입 허가는 여기서 내리지 않는다. 시작 직전에 거래소를 다시 읽는다.
    mayStartSmoke: false,
    reason: plan.reason,
  }, { status: 200, headers: NO_STORE });
}
