// /api/strategy-accounts
//
// **전략 계좌를 SQL 없이 만들고 읽는다.**
//
// 권한 표(039)에서 배운 것을 그대로 적용한다: 표를 만들어 놓고 값을
// 넣을 방법을 SQL 말고 안 만들면, 그 기능은 만든 사람 말고는 못 쓴다.
//
// 무엇을 지키는가
//  · **총 배정액이 실제 자금을 넘지 않는다.** 넘으면 두 전략이 같은
//    돈을 각자 자기 것으로 세고, 둘 다 진입하는 순간 증거금이 모자란다.
//    판정은 checkAllocation이 한다 — 여기서 다시 쓰지 않는다.
//  · **소유 수량은 이 라우트로 못 바꾼다.** positions는 체결이 만드는
//    값이다. 손으로 고칠 수 있으면 장부가 장부가 아니다.
//  · 표가 없으면 그렇다고 말한다. 조용히 빈 목록을 주면 화면이
//    "계좌가 하나도 없네"로 읽는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadSleeves, saveSleeve, stageOf, type SleeveRecord } from '@/lib/strategies/sleeveStore';
import {
  checkAllocation, equityOf, availableOf, freshSleeve, STAGE_ORDER,
} from '@/lib/strategies/sleeveLedger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** GET — 내 전략 계좌 목록 */
export async function GET(req: NextRequest) {
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const load = await loadSleeves(sb, uid);

  // 총 자금은 질의로 받는다. 안 주면 배분 검사를 **하지 않는다** —
  // 0으로 치면 모든 배정이 초과로 보이고, 큰 수를 지어내면 초과를 못 잡는다.
  const total = num(req.nextUrl.searchParams.get('totalUsd'));
  const alloc = total != null
    ? checkAllocation(total, load.records.map(r => r.spec))
    : null;

  return NextResponse.json({
    ok: true,
    installed: load.installed,
    known: load.known,
    reason: load.reason,
    stages: STAGE_ORDER,
    allocation: alloc,
    accounts: load.records.map(r => ({
      id: r.rowId,
      sleeveId: r.spec.id,
      label: r.spec.label,
      stage: r.spec.stage,
      allocated: r.spec.allocated,
      riskPerTradePct: r.spec.riskPerTradePct ?? null,
      maxDrawdownPct: r.spec.maxDrawdownPct ?? null,
      maxLeverage: r.spec.maxLeverage ?? null,
      connectionId: r.connectionId,
      halted: r.halted,
      haltReason: r.haltReason,
      // 장부
      equity: equityOf(r.state),
      available: availableOf(r.state),
      realizedPnl: r.state.realizedPnl,
      unrealizedPnl: r.state.unrealizedPnl,
      fees: r.state.fees,
      reservedMargin: r.state.reservedMargin,
      drawdownPct: r.state.maxDrawdownPct,
      positions: r.state.positions,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/** POST — 만들거나 설정을 고친다 */
export async function POST(req: NextRequest) {
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const sleeveId = String(body?.sleeveId ?? '').trim().toUpperCase();
  if (!sleeveId) {
    return NextResponse.json({
      ok: false, error: 'sleeve_id_required',
      message: '전략 식별자가 필요합니다 — 주문에 이 값이 새겨집니다',
    }, { status: 400 });
  }

  const load = await loadSleeves(sb, uid);
  if (!load.installed) {
    return NextResponse.json({
      ok: false, error: 'not_installed', message: load.reason,
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  // **못 읽었으면 쓰지 않는다.** 기존 계좌를 못 본 채로 upsert하면
  // 장부(realized_pnl·positions)를 0으로 덮어쓴다.
  if (!load.known) {
    return NextResponse.json({
      ok: false, error: 'read_failed',
      message: `${load.reason} — 기존 장부를 덮어쓰지 않기 위해 저장하지 않았습니다`,
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }

  const existing = load.records.find(r => r.spec.id === sleeveId) ?? null;
  const allocated = num(body?.allocated) ?? existing?.spec.allocated ?? 0;
  if (allocated < 0) {
    return NextResponse.json({ ok: false, error: 'bad_allocation' }, { status: 400 });
  }

  // ── 총 자금을 넘기지 않는다 ──
  //
  // 이 검사가 없으면 전략 열둘이 각자 $10,000을 배정받아 총 $120,000이
  // 되고, 실제 계좌에는 $50,000뿐이다. 그러면 넷째 전략부터는 진입할
  // 때마다 증거금 부족으로 거부되는데, 화면에는 배정액이 멀쩡히 떠 있다.
  const totalUsd = num(body?.totalUsd);
  if (totalUsd != null) {
    const specs = load.records
      .filter(r => r.spec.id !== sleeveId)
      .map(r => r.spec)
      .concat([{ id: sleeveId, label: String(body?.label ?? sleeveId), allocated }]);
    const check = checkAllocation(totalUsd, specs);
    if (!check.ok) {
      return NextResponse.json({
        ok: false, error: 'allocation_exceeded', message: check.reason, allocation: check,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  const spec = {
    id: sleeveId,
    label: String(body?.label ?? existing?.spec.label ?? sleeveId),
    allocated,
    riskPerTradePct: num(body?.riskPerTradePct) ?? existing?.spec.riskPerTradePct ?? null,
    maxDrawdownPct: num(body?.maxDrawdownPct) ?? existing?.spec.maxDrawdownPct ?? null,
    maxLeverage: num(body?.maxLeverage) ?? existing?.spec.maxLeverage ?? null,
    stage: body?.stage != null ? stageOf(body.stage) : (existing?.spec.stage ?? 'SPECIFICATION'),
  };

  // **장부는 그대로 둔다.** 있으면 기존 것, 없으면 새 것.
  // positions·realized_pnl은 체결이 만드는 값이라 이 라우트가 만지지 않는다.
  const record: SleeveRecord = {
    rowId: existing?.rowId ?? null,
    spec,
    state: existing
      ? { ...existing.state, allocated: spec.allocated,
          // 배정을 늘렸으면 최고점도 그만큼 올린다 — 안 올리면 늘린
          // 순간 낙폭이 생긴 것으로 계산된다.
          peakEquity: Math.max(existing.state.peakEquity, spec.allocated) }
      : freshSleeve(spec),
    connectionId: body?.connectionId != null
      ? (String(body.connectionId) || null)
      : (existing?.connectionId ?? null),
    halted: body?.halted != null ? !!body.halted : (existing?.halted ?? false),
    haltReason: String(body?.haltReason ?? existing?.haltReason ?? ''),
  };

  const saved = await saveSleeve(sb, uid, record);
  if (!saved.ok) {
    return NextResponse.json({ ok: false, error: 'save_failed', message: saved.error },
      { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json({
    ok: true, id: saved.rowId, sleeveId,
    created: existing == null,
    message: existing ? `${spec.label} 설정을 바꿨습니다` : `${spec.label} 전략 계좌를 만들었습니다`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
