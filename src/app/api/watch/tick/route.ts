// /api/watch/tick
//
// 트레일링·예약 감시 루프의 한 번.
//
// 얼마나 자주 도는가가 이 기능의 성능이다
// ────────────────────────────────────────
// GitHub Actions가 15분마다 부른다 (Vercel Hobby cron은 하루 1회라
// 트레일링에 쓸 수 없다). 즉 **최대 15분치 갭을 그대로 맞는다.**
// 손절선이 100이어도 다음 확인 때 가격이 92면 92에 팔린다.
//
// 이건 구현 결함이 아니라 이 구조의 한계다. 그래서 응답에 실제 확인
// 간격을 담고, 화면이 그것을 그대로 보여준다. 사용자가 "손절 걸어놨다"고
// 믿는 것과 실제 보호 수준의 차이를 좁히는 유일한 방법이다.
//
// 거래소에 올릴 수 있는 보호(지정가 손절)는 거래소에 올리는 편이 낫다.
// 그건 앱이 꺼져도, 이 루프가 멈춰도 살아 있다.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import {
  listActiveWatches, updateWatchStop, touchWatch, closeWatch,
  CHECK_INTERVAL_MIN, type Watch,
} from '@/lib/strategies/watchStore';
import { updateTrailing, checkReserved } from '@/lib/strategies/spotOrderPlan';
import { placeSpotOrder } from '@/lib/exchanges/spotOrderExecutor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function safeEqual(provided: string | null, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

/** 현물 시세를 한 번에. 감시마다 부르면 레이트리밋에 걸린다 */
async function fetchPrices(symbols: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (symbols.length === 0) return map;
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price',
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return map;
    const list = await r.json();
    const want = new Set(symbols);
    for (const t of (Array.isArray(list) ? list : [])) {
      const s = String(t?.symbol);
      if (!want.has(s)) continue;
      const v = parseFloat(t?.price);
      if (Number.isFinite(v)) map.set(s, v);
    }
  } catch { /* 못 받으면 이번 주기는 아무것도 하지 않는다 */ }
  return map;
}

async function runTick(sb: any, userId?: string) {
  const started = Date.now();
  const watches = await listActiveWatches(sb, userId);
  const prices = await fetchPrices(Array.from(new Set(watches.map(w => w.symbol))));

  const results: any[] = [];
  let moved = 0, triggered = 0, ordered = 0, skipped = 0;

  for (const w of watches) {
    const price = prices.get(w.symbol) ?? null;

    // 가격을 못 받으면 이 감시는 건너뛴다. 특히 '발동'으로 처리하면
    // 조회 실패 한 번에 보유분이 팔린다.
    if (price == null) {
      skipped++;
      results.push({ id: w.id, symbol: w.symbol, action: 'SKIP', reason: '현재가를 받지 못했습니다' });
      continue;
    }

    if (w.payload.kind === 'TRAILING') {
      const u = updateTrailing({
        highWater: w.payload.highWater ?? w.entryPrice ?? price,
        stopPrice: w.stopPrice ?? 0,
        trailPct: w.payload.trailPct ?? 0,
      }, price);

      if (u.moved) {
        moved++;
        await updateWatchStop(sb, w.id, u.state.stopPrice,
          { ...w.payload, highWater: u.state.highWater });
      }

      if (!u.triggered) {
        if (!u.moved) await touchWatch(sb, w.id, w.payload);
        results.push({ id: w.id, symbol: w.symbol, action: u.moved ? 'MOVE' : 'HOLD', reason: u.note });
        continue;
      }

      triggered++;
      const r = await fire(sb, w, price, u.note);
      if (r.ok) ordered++;
      results.push(r.entry);
      continue;
    }

    // ── 예약 ──
    const c = checkReserved({
      side: w.payload.side,
      triggerPrice: w.payload.triggerPrice ?? 0,
      direction: w.payload.direction ?? 'below',
      amount: w.payload.qty ?? w.payload.quoteUsd ?? 0,
      // 보유는 주문 실행기가 다시 확인한다. 여기서는 알 수 없으므로
      // 매도 예약은 실행기에게 맡긴다 — 두 번 조회하면 레이트리밋만 쓴다.
      heldQty: w.payload.side === 'SELL' ? Number.POSITIVE_INFINITY : undefined,
    }, price);

    if (!c.triggered) {
      await touchWatch(sb, w.id, w.payload);
      results.push({ id: w.id, symbol: w.symbol, action: 'HOLD', reason: c.reason });
      continue;
    }

    triggered++;
    const r = await fire(sb, w, price, c.reason);
    if (r.ok) ordered++;
    results.push(r.entry);
  }

  return {
    checked: watches.length,
    moved, triggered, ordered, skipped,
    tookMs: Date.now() - started,
    checkIntervalMin: CHECK_INTERVAL_MIN,
    results,
  };
}

/** 발동한 감시의 주문을 낸다. 성공이든 실패든 감시는 끝난다 */
async function fire(sb: any, w: Watch, price: number, why: string) {
  const r = await placeSpotOrder(sb, {
    userId: w.userId,
    connectionId: w.payload.connectionId,
    symbol: w.symbol,
    side: w.payload.side,
    type: 'MARKET',
    quantity: w.payload.qty ?? null,
    quoteOrderQty: w.payload.quoteUsd ?? null,
    signalId: w.signalId,
    strategyId: w.strategyId,
  });

  // 실패해도 되살리지 않는다. 되살리면 다음 주기에 또 시도하고,
  // 그 사이 가격이 더 내려가 훨씬 나쁜 값에 팔린다.
  await closeWatch(
    sb, w.id,
    r.ok ? 'TRIGGERED' : 'FAILED',
    `${why} / 주문: ${r.message}`);

  return {
    ok: r.ok,
    entry: {
      id: w.id, symbol: w.symbol,
      action: r.ok ? 'ORDERED' : 'ORDER_FAILED',
      price, reason: why, orderMessage: r.message,
    },
  };
}

/** cron용 — 관리자 시크릿 */
export async function GET(req: NextRequest) {
  const secret = process.env.ADMIN_SECRET || '';
  const cronSecret = process.env.CRON_SECRET || '';
  const auth = req.headers.get('authorization') || '';

  const byCron =
    safeEqual(req.headers.get('x-admin-secret'), secret) ||
    (cronSecret && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), cronSecret));

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  if (byCron) {
    try {
      const out = await runTick(sb);
      return NextResponse.json({ ok: true, scope: 'all', ...out },
        { headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) {
      // 조용히 200을 돌려주면 감시가 멈춘 것을 아무도 모른다.
      return NextResponse.json({ ok: false, error: e?.message || 'tick 실패' }, { status: 500 });
    }
  }

  // 사용자 호출 — 자기 감시만. 터미널이 열려 있는 동안 더 자주 확인하는 용도다.
  const uid = await resolveUserId(auth, req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  try {
    const out = await runTick(sb, uid);
    return NextResponse.json({ ok: true, scope: 'self', ...out },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'tick 실패' }, { status: 500 });
  }
}
