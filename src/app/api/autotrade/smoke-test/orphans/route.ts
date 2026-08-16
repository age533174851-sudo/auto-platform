// /api/autotrade/smoke-test/orphans
//
// **거래소에 남은 보호주문을 증거 그대로 보여 주고, 지정한 번호만 지운다.**
//
// 왜 만드나
// ─────────
// 2026-08-15 21:16:16(KST)에 스모크가 만든 ETHUSDT 조건부 주문 2건이
// 포지션 0인 상태로 남았다. 원인을 잡으려면 세 가지가 필요했는데
// 어느 것도 볼 방법이 없었다:
//
//   · DB에 저장된 **정확한 거래소 주문 번호**
//   · Gate가 지금 실제로 돌려주는 주문의 모양(text · trigger · rule · auto_size)
//   · 취소를 요청했을 때 거래소가 **뭐라고 답하는지**
//
// 화면의 트리거 가격으로 추측하면 틀린다. 그래서 여기서는 추측하지
// 않고 **DB의 번호와 거래소의 응답을 나란히** 보여 준다.
//
// 규칙
// ────
//   GET   **아무것도 지우지 않는다.** 증거 보존이 목적이다.
//   POST  **번호를 명시한 것만** 지운다. `ids`가 비면 거절한다 —
//         "전부 지워"라는 입력 자체를 두지 않는다. Cancel All은 없다.
//         남의 전략 주문(FOREIGN)으로 판별되면 번호를 줘도 거절한다.
//
// 그리고 취소 확인은 재조회로만 한다. 거래소가 200을 줬다는 것은
// 접수이지 지워졌다는 뜻이 아니다 — 그 구분이 없어서 장부에는 정리된
// 것으로 적혀 있었다.
//
// **비밀은 아무것도 내보내지 않는다.** 주문 번호·가격·시각뿐이다.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { SMOKE_STRATEGY_ID } from '@/lib/smoke/smokePlan';
import { classifyOrder, ownershipTextOf } from '@/lib/engine/orderOwnership';
import { ownedOrderIds, cancelLedger, orderIdOf } from '@/lib/engine/protectionLedger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 거래소 응답 한 줄을 **비밀 없이** 사람이 읽을 모양으로 */
function describe(row: any, myIds: string[]) {
  const initial = row?.initial ?? row ?? {};
  const trigger = row?.trigger ?? {};
  const cls = classifyOrder(row, SMOKE_STRATEGY_ID, myIds);
  return {
    id: orderIdOf(row),
    text: ownershipTextOf(row) || null,
    // Gate: initial.contract · 바이낸스: symbol
    contract: initial.contract ?? row?.symbol ?? null,
    size: initial.size ?? null,
    autoSize: initial.auto_size ?? null,
    reduceOnly: initial.reduce_only ?? row?.reduceOnly ?? null,
    triggerPrice: trigger.price ?? row?.stopPrice ?? null,
    rule: trigger.rule ?? null,
    priceType: trigger.price_type ?? null,
    status: row?.status ?? null,
    createTime: row?.create_time ?? row?.time ?? null,
    ownership: cls.class,
    ownershipReason: cls.reason,
  };
}

async function venueOf(sb: any, userId: string, connectionId: string) {
  const { loadFuturesCreds } = await import('@/lib/exchanges/loadCreds');
  const creds = await loadFuturesCreds(sb, userId, connectionId);
  if (!creds.ok) return { ok: false as const, status: (creds as any).status || 400, message: (creds as any).message };
  return {
    ok: true as const,
    venue: {
      exchange: (creds as any).exchange as 'binance' | 'gate',
      apiKey: (creds as any).key, apiSecret: (creds as any).secret,
      testnet: (creds as any).testnet as boolean,
    },
  };
}

/** 이 사용자의 스모크 줄이 들고 있는 주문 번호 */
async function smokeIds(sb: any, userId: string, symbol: string) {
  try {
    const { data } = await (sb as any).from('smoke_tests')
      .select('id, symbol, side, state, verdict, sl_order_id, tp_order_id, entry_order_id, client_order_id, created_at, closed_at')
      .eq('user_id', userId).eq('symbol', symbol)
      .order('created_at', { ascending: false }).limit(20);
    const rows = Array.isArray(data) ? data : [];
    return {
      rows: rows.map((r: any) => ({
        id: r.id, symbol: r.symbol, side: r.side, state: r.state, verdict: r.verdict,
        slOrderId: r.sl_order_id ?? null, tpOrderId: r.tp_order_id ?? null,
        entryOrderId: r.entry_order_id ?? null, clientOrderId: r.client_order_id ?? null,
        createdAt: r.created_at ?? null, closedAt: r.closed_at ?? null,
      })),
      ids: ownedOrderIds({ placed: rows.flatMap((r: any) => [r.sl_order_id, r.tp_order_id]) }),
      error: null as string | null,
    };
  } catch (e: any) {
    // **못 읽은 것을 빈 목록으로 두지 않는다.** 빈 목록이면 "내 주문이
    // 하나도 없다"가 되어 남은 것이 전부 남의 것으로 보인다.
    return { rows: [], ids: [] as string[], error: String(e?.message || e) };
  }
}

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const connectionId = String(req.nextUrl.searchParams.get('connectionId') || '').trim();
  const symbol = String(req.nextUrl.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!connectionId || !symbol) {
    return NextResponse.json({ ok: false, error: 'bad_request',
      message: 'connectionId와 symbol이 필요합니다' }, { status: 400 });
  }

  const v = await venueOf(sb, userId, connectionId);
  if (!v.ok) return NextResponse.json({ ok: false, error: 'creds', message: v.message }, { status: v.status });

  const ops = await import('@/lib/engine/venuePositionOps');
  const [position, orders, mine] = await Promise.all([
    ops.readOpenPosition(v.venue, symbol),
    ops.readProtectiveOrders(v.venue, symbol),
    smokeIds(sb, userId, symbol),
  ]);

  return NextResponse.json({
    ok: true,
    // **아무것도 지우지 않았다.** 이 경로는 증거 보존용이다.
    mutated: false,
    exchange: v.venue.exchange,
    env: v.venue.testnet ? 'TESTNET' : 'LIVE',
    symbol,
    position: { ok: position.ok, found: position.found, qty: position.qty, side: position.side, error: position.error },
    // **null은 '못 읽음'이고 []는 '없음'이다.**
    ordersReadable: orders != null,
    orders: (orders ?? []).map(o => describe(o, mine.ids)),
    smoke: { rows: mine.rows, ids: mine.ids, error: mine.error },
    note: orders == null
      ? '조건부 주문 목록을 읽지 못했습니다 — 0건과 다릅니다'
      : `조건부 주문 ${orders.length}건. 지우려면 POST에 지울 번호(ids)를 명시하세요 — `
        + '전체 취소 기능은 없습니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any = {};
  try { body = await req.json(); } catch { /* 아래에서 거절된다 */ }

  const connectionId = String(body?.connectionId || '').trim();
  const symbol = String(body?.symbol || '').trim().toUpperCase();
  const asked = ownedOrderIds({ placed: Array.isArray(body?.ids) ? body.ids : [] });

  if (!connectionId || !symbol) {
    return NextResponse.json({ ok: false, error: 'bad_request',
      message: 'connectionId와 symbol이 필요합니다' }, { status: 400 });
  }
  if (asked.length === 0) {
    // **"전부"라는 입력을 두지 않는다.** 두면 언젠가 눌리고, 그때
    // 다른 전략의 손절이 같이 사라진다.
    return NextResponse.json({ ok: false, error: 'ids_required',
      message: '지울 주문 번호(ids)를 명시하세요 — 전체 취소는 지원하지 않습니다',
    }, { status: 400 });
  }

  const v = await venueOf(sb, userId, connectionId);
  if (!v.ok) return NextResponse.json({ ok: false, error: 'creds', message: v.message }, { status: v.status });

  const ops = await import('@/lib/engine/venuePositionOps');
  const before = await ops.readProtectiveOrders(v.venue, symbol);
  if (before == null) {
    // 목록을 못 읽으면 무엇을 지우는지 확인할 수 없다. **모르는 채로
    // 취소를 보내지 않는다** — 남의 주문일 수 있다.
    return NextResponse.json({ ok: false, error: 'orders_unreadable',
      message: '조건부 주문 목록을 읽지 못했습니다 — 무엇을 지우는지 확인하지 못한 채로 취소하지 않습니다',
    }, { status: 503 });
  }

  const mine = await smokeIds(sb, userId, symbol);
  const seen = before.map(o => describe(o, mine.ids));

  // **남의 전략 주문은 번호를 줘도 안 지운다.**
  const foreign = seen.filter(o => asked.includes(o.id) && o.ownership === 'FOREIGN');
  if (foreign.length > 0) {
    return NextResponse.json({ ok: false, error: 'foreign_order',
      message: `${foreign.map(o => o.id).join(', ')}은 다른 전략의 주문으로 판별됩니다 — 지우지 않습니다`,
      orders: seen,
    }, { status: 409 });
  }

  const missing = asked.filter(id => !seen.some(o => o.id === id));
  const targets = asked.filter(id => seen.some(o => o.id === id));

  const cx = targets.length
    ? await ops.cancelExact(v.venue, symbol, targets, { attempts: 3 })
    : { attempts: [] as any[], leftover: before, rounds: 0 };
  const ledger = cancelLedger({ ids: targets, attempts: cx.attempts, leftover: cx.leftover });

  const position = await ops.readOpenPosition(v.venue, symbol);

  return NextResponse.json({
    ok: ledger.ok,
    mutated: targets.length > 0,
    exchange: v.venue.exchange,
    env: v.venue.testnet ? 'TESTNET' : 'LIVE',
    symbol,
    requested: asked,
    // 번호는 줬는데 거래소 목록에 없던 것. 이미 사라진 것이다.
    notFound: missing,
    // **요청 → 응답 → 재조회**의 기록. "왜 안 지워졌나"에 이걸로 답한다.
    ledger,
    attempts: cx.attempts,
    rounds: cx.rounds,
    leftoverReadable: cx.leftover != null,
    leftover: (cx.leftover ?? []).map(o => describe(o, mine.ids)),
    position: { ok: position.ok, found: position.found, qty: position.qty },
    note: ledger.ok
      ? '요청한 번호가 거래소에서 사라진 것을 재조회로 확인했습니다'
      : `${ledger.reason} — HTTP 응답만으로 취소 완료로 적지 않습니다`,
  }, { status: ledger.ok ? 200 : 409, headers: { 'Cache-Control': 'no-store' } });
}
