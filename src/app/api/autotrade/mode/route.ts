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
    hasLiveKey: false, liveUnlocked: process.env.ALLOW_LIVE_TRADING === 'true',
  };

  try {
    // 이 모드에서 끝까지 간 주문만 표본으로 센다.
    const { data: done } = await sb.from('live_orders')
      .select('created_at')
      .eq('user_id', userId).eq('mode', current)
      .in('status', ['FILLED', 'RECONCILED'])
      .order('created_at', { ascending: true }).limit(500);
    const rows = Array.isArray(done) ? done : [];
    ev.completedTrades = rows.length;
    if (rows.length > 0) {
      // 서로 다른 날짜 수. 하루에 여러 건 넣어 기간을 채울 수 없게 한다.
      ev.daysInMode = new Set(rows.map((r: any) => String(r.created_at).slice(0, 10))).size;
    }

    const { count: unresolved } = await sb.from('live_orders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('status', 'UNKNOWN');
    ev.unresolvedOrders = unresolved ?? 0;

    const { data: conn } = await sb.from('exchange_connections')
      .select('is_testnet').eq('user_id', userId).eq('is_active', true).limit(20);
    ev.hasLiveKey = (Array.isArray(conn) ? conn : []).some((c: any) => c.is_testnet === false);
  } catch { /* 조회 실패는 증거 부족으로 남는다 — 승급이 막히는 쪽이라 안전하다 */ }

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
