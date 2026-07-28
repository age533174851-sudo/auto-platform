// /api/watch
//
// 트레일링·예약 감시의 등록·조회·취소.
//
// 실제 감시는 /api/watch/tick이 돌린다. 여기서는 목록만 관리한다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import {
  listActiveWatches, createWatch, closeWatch, CHECK_INTERVAL_MIN,
} from '@/lib/strategies/watchStore';
import { startTrailing, validateWatchSpec } from '@/lib/strategies/spotOrderPlan';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  try {
    const watches = await listActiveWatches(sb, uid);
    return NextResponse.json({
      ok: true,
      watches: watches.map(w => ({
        id: w.id, symbol: w.symbol, strategyId: w.strategyId,
        kind: w.payload.kind, side: w.payload.side,
        stopPrice: w.stopPrice, entryPrice: w.entryPrice,
        highWater: w.payload.highWater ?? null,
        trailPct: w.payload.trailPct ?? null,
        triggerPrice: w.payload.triggerPrice ?? null,
        direction: w.payload.direction ?? null,
        qty: w.payload.qty ?? null,
        quoteUsd: w.payload.quoteUsd ?? null,
        lastCheckedAt: w.payload.lastCheckedAt ?? null,
      })),
      // 이 값이 곧 보호 수준이다. 화면이 그대로 보여줘야 한다.
      checkIntervalMin: CHECK_INTERVAL_MIN,
      guardedBy: 'APP',
      note: `서버가 ${CHECK_INTERVAL_MIN}분마다 확인합니다. ` +
            `그 사이에 가격이 손절선을 지나가면 지나간 값에 체결됩니다. ` +
            `서버나 감시 작업이 멈추면 이 보호는 동작하지 않습니다.`,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '조회 실패' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const kind = body.kind === 'RESERVED' ? 'RESERVED' : body.kind === 'TRAILING' ? 'TRAILING' : null;
  if (!kind) {
    return NextResponse.json({ error: 'invalid_kind', message: "kind는 'TRAILING' 또는 'RESERVED'" }, { status: 400 });
  }

  const symbol = String(body.symbol || '').toUpperCase().replace('/', '');
  const connectionId = String(body.connectionId || '');
  const side = String(body.side || '').toUpperCase();
  if (!symbol || !connectionId) {
    return NextResponse.json({ error: 'missing_params', message: '종목과 거래소 연결이 필요합니다' }, { status: 400 });
  }
  if (side !== 'BUY' && side !== 'SELL') {
    return NextResponse.json({ error: 'invalid_side' }, { status: 400 });
  }

  const qty = body.qty != null ? Number(body.qty) : undefined;
  const quoteUsd = body.quoteUsd != null ? Number(body.quoteUsd) : undefined;

  // ── 값 검증 ──
  // 소유권 검사보다 먼저 한다. 뒤에 두면 잘못된 값이 전부
  // connection_not_found로 가려져 사용자가 무엇이 틀렸는지 알 수 없다.
  // 규칙 자체는 순수 함수에 있어 테스트로 덮인다.
  const v = validateWatchSpec({
    kind, side: side as 'BUY' | 'SELL', qty, quoteUsd,
    entryPrice: body.entryPrice != null ? Number(body.entryPrice) : null,
    trailPct: body.trailPct != null ? Number(body.trailPct) : null,
    triggerPrice: body.triggerPrice != null ? Number(body.triggerPrice) : null,
    direction: body.direction === 'above' ? 'above' : body.direction === 'below' ? 'below' : null,
  });
  if (!v.ok) {
    return NextResponse.json({ error: v.code, message: v.reason }, { status: 400 });
  }

  // 연결 소유권 — 남의 연결로 감시를 걸 수 없다
  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id').eq('id', connectionId).eq('user_id', uid).maybeSingle();
  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });

  if (kind === 'TRAILING') {
    const entry = Number(body.entryPrice);
    const pct = Number(body.trailPct);
    const r = await createWatch(sb, {
      userId: uid, connectionId, strategyId: String(body.strategyId || 'manual'),
      symbol, kind, side, qty, quoteUsd,
      trailing: startTrailing(entry, pct),
      entryPrice: entry,
    });
    return NextResponse.json({ ...r, checkIntervalMin: CHECK_INTERVAL_MIN },
      { status: r.ok ? 200 : 500 });
  }

  // RESERVED
  const triggerPrice = Number(body.triggerPrice);
  const direction = body.direction === 'above' ? 'above' : 'below';

  const r = await createWatch(sb, {
    userId: uid, connectionId, strategyId: String(body.strategyId || 'manual'),
    symbol, kind, side, qty, quoteUsd,
    triggerPrice, direction,
    entryPrice: body.entryPrice != null ? Number(body.entryPrice) : null,
  });
  return NextResponse.json({ ...r, checkIntervalMin: CHECK_INTERVAL_MIN },
    { status: r.ok ? 200 : 500 });
}

export async function DELETE(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });

  // 남의 감시를 취소할 수 없다
  const { data: row } = await sb.from('signals')
    .select('id').eq('id', id).eq('user_id', uid).maybeSingle();
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await closeWatch(sb, id, 'CANCELED', '사용자가 취소');
  return NextResponse.json({ ok: true, message: '감시를 취소했습니다' },
    { headers: { 'Cache-Control': 'no-store' } });
}
