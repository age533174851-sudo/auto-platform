// /api/autotrade/mode
//
// 지금 어느 단계에 있고, 다음 단계로 올라갈 수 있는지 보여준다.
//
// 판정은 lib/engine/operatingMode.ts(순수 함수)가 하고 여기서는 증거만
// 모은다. "표본 10건"을 화면과 서버가 각자 세면 서로 다른 답이 나온다.
//
// 읽기 전용이다. 모드 자체는 아직 환경변수 LADDER_MODE와 요청 본문의
// mode로 정한다 — 사용자별 저장은 컬럼 추가가 필요해서 나중에 한다.
import { NextRequest, NextResponse } from 'next/server';
import {
  LADDER, parseMode, capability, canChangeMode, stepOf,
  type OperatingMode, type ModeEvidence,
} from '@/lib/engine/operatingMode';
import { PROVEN_FILL_STATUSES, isProvenFill } from '@/lib/engine/holdingEvidence';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { getUserIdFromRequest, getSupabaseAdmin } = await import('@/lib/supabase/admin');
  const userId = await getUserIdFromRequest(req.headers.get('authorization'));
  if (!userId) {
    return NextResponse.json({ ok: false, error: '인증이 필요합니다' }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const current: OperatingMode = parseMode(process.env.LADDER_MODE || 'TESTNET');

  // ── 증거 수집 ──
  // 승급 판단의 근거는 전부 실제 기록에서 온다. 사람이 "됐다고 치자"고
  // 넘길 수 있으면 사다리를 만든 의미가 없다.
  const ev: ModeEvidence = {
    completedTrades: 0, daysInMode: 0,
    unresolvedOrders: 0, criticalMismatches: 0,
    hasLiveKey: false, liveUnlocked: (require('@/lib/engine/liveTradingGate') as any).liveTradingGate().allowed,
  };

  /** 증거 조회가 던졌으면 그 사유. 읽었으면 null */
  let evidenceError: string | null = null;

  try {
    // 이 모드에서 **체결이 증명된** 주문만 표본으로 센다.
    //
    // **여기는 `HOLDING_EVIDENCE_STATUSES`를 쓰지 않는다.** 그 목록은
    // "보유 가능성"이고 `ACKED`(거래소에 아직 열려 있음)를 포함한다.
    // 승급 근거는 **완주한 거래**이므로 열려 있는 주문을 세면 모드가
    // 끝나지도 않은 거래로 올라간다. 두 질문이 다르므로 목록도 다르다.
    //
    // 그리고 예전에는 `['FILLED','RECONCILED']`를 셌다. `RECONCILED`는
    // **최종 체결 결과를 모르는 상태**다 — 그걸 완주로 세면 체결된 적
    // 없는 주문이 실전 승급의 근거가 된다. 상태와 수량을 둘 다 보는
    // `isProvenFill` 하나로 판단한다.
    // ★ **`error`를 받는다.** Supabase의 select는 실패해도 던지지 않고
    //   `{ data: null, error }`를 준다. 예전에는 `data`만 받아서, 조회
    //   실패가 "0건"이 되어 증거에 섞였다. 특히 아래 미확정 주문 수는
    //   **승급을 막는 증거**라서, 0건으로 적히면 막아야 할 상태에서
    //   관문이 열린 것으로 보인다.
    const { data: done, error: doneErr } = await sb.from('live_orders')
      .select('created_at, status, filled_qty')
      .eq('user_id', userId).eq('mode', current)
      .in('status', [...PROVEN_FILL_STATUSES])
      .order('created_at', { ascending: true }).limit(500);
    if (doneErr || !Array.isArray(done)) {
      // 못 읽었다. **0건으로 적지 않는다** — 판정이 "부족"이 아니라
      // "확인 못 함"으로 나가야 한다.
      ev.samplesKnown = false;
    } else {
      const rows = done.filter(isProvenFill);
      ev.completedTrades = rows.length;
      if (rows.length > 0) {
        // 서로 다른 날짜 수. 하루에 여러 건 넣어 기간을 채울 수 없게 한다.
        ev.daysInMode = new Set(rows.map((r: any) => String(r.created_at).slice(0, 10))).size;
      }
    }

    const { count: unresolved, error: unresolvedErr } = await sb.from('live_orders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('status', 'UNKNOWN');
    if (unresolvedErr || unresolved == null || !Number.isFinite(Number(unresolved))) {
      ev.unresolvedKnown = false;
    } else {
      ev.unresolvedOrders = Number(unresolved);
    }

    const { data: conn, error: connErr } = await sb.from('exchange_connections')
      .select('is_testnet').eq('user_id', userId).eq('is_active', true).limit(20);
    if (connErr || !Array.isArray(conn)) {
      ev.liveKeyKnown = false;
    } else {
      ev.hasLiveKey = conn.some((c: any) => c.is_testnet === false);
    }
  } catch (e: any) {
    // 던진 경우도 **못 읽은 것**이다. 여기까지 채워진 값은 그대로 두고,
    // 아직 확인하지 못한 사실만 "확인 못 함"으로 남긴다.
    if (ev.samplesKnown == null && ev.completedTrades === 0) ev.samplesKnown = false;
    if (ev.unresolvedKnown == null && ev.unresolvedOrders === 0) ev.unresolvedKnown = false;
    if (ev.liveKeyKnown == null && ev.hasLiveKey === false) ev.liveKeyKnown = false;
    evidenceError = String(e?.message || e).slice(0, 200);
  }

  // 상태 불일치는 거래소를 실제로 조회해야 알 수 있다. 실패하면 0이 아니라
  // 조회 불가로 두어야 하지만, 그러면 승급이 영원히 막힌다. 대신 실패
  // 사실을 함께 돌려주고 화면이 그것을 보여주게 한다.
  let reconcileError: string | null = null;
  try {
    const { gatherAndReconcile } = await import('@/lib/engine/reconcileCheck');
    const r = await gatherAndReconcile(sb, userId, !capability(current).needsLiveKey);
    if (!r.reachable) reconcileError = r.error || '거래소 조회 실패';
    else ev.criticalMismatches = (r.verdict?.mismatches ?? [])
      .filter((m: any) => m.severity === 'critical').length;
  } catch (e: any) {
    reconcileError = e?.message || '대조 실패';
  }

  const next = LADDER[stepOf(current) + 1] ?? null;

  return NextResponse.json({
    ok: true,
    current,
    step: stepOf(current) + 1,
    total: LADDER.length,
    capability: capability(current),
    evidence: ev,
    // 못 읽은 사실이 있으면 화면이 그것을 말할 수 있어야 한다.
    evidenceError,
    reconcileError,
    next: next ? { mode: next, ...canChangeMode(current, next, ev) } : null,
    ladder: LADDER.map(m => ({
      mode: m,
      label: capability(m).label,
      sendsOrders: capability(m).sendsOrders,
      realMoney: capability(m).realMoney,
      maxNotionalUsd: capability(m).maxNotionalUsd,
      current: m === current,
    })),
    hint: '모드는 환경변수 LADDER_MODE 또는 요청 본문의 mode로 정합니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
