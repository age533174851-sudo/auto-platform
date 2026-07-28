// /api/strategies/ledger
//
// 전략별 장부를 만들고 거래소와 대조한다.
//
// 장부는 어디서 오나
// ──────────────────
// live_orders의 체결 기록에서 만든다. 각 주문에는 소유 전략이 표식으로
// 붙어 있다(lib/strategies/ledger.ts의 tagStrategy).
//
// 거래소는 전략을 모르므로, 이 장부는 **우리가 붙인 귀속**이다.
// 그래서 마지막에 반드시 거래소 실제 수량과 대조하고, 차이가 있으면
// 그 차이를 전략들에 나눠 붙이지 않고 '미귀속'으로 따로 보고한다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import { marketTypeOf } from '@/lib/markets/marketType';
import {
  strategyOf, attribute, detectConflicts,
  type StrategyHolding, type StrategyIntent,
} from '@/lib/strategies/ledger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 주인 없는 주문을 담는 자리. 임의의 전략에 붙이지 않는다. */
const UNOWNED = '(주인 미상)';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const connectionId = req.nextUrl.searchParams.get('connectionId');

  // ── 체결된 주문에서 장부를 쌓는다 ──
  const { data: rows, error } = await sb.from('live_orders')
    .select('*')
    .eq('user_id', uid)
    .in('status', ['FILLED', 'RECONCILED'])
    .order('created_at', { ascending: true })
    .limit(1000);

  if (error) {
    return NextResponse.json(
      { ok: false, error: 'query_failed', message: error.message }, { status: 500 });
  }

  // key: strategy|market|symbol
  const book = new Map<string, StrategyHolding>();
  let unownedCount = 0;

  for (const r of (Array.isArray(rows) ? rows : [])) {
    const market = marketTypeOf(r);
    // 시장 유형을 모르는 주문은 장부에 넣지 않는다. 현물인지 선물인지
    // 모르면 어느 장부에 넣어도 틀린다.
    if (!market) continue;

    const strategy = strategyOf(r) ?? UNOWNED;
    if (strategy === UNOWNED) unownedCount++;

    const qty = Number(r.filled_qty ?? r.quantity) || 0;
    if (qty <= 0) continue;
    const price = Number(r.avg_price ?? r.price) || null;

    // 현물은 매수가 +, 매도가 −. 선물은 BUY가 LONG(+), SELL이 SHORT(−).
    // 둘의 부호 규칙이 같아 보이지만 뜻이 다르다 — 현물 −는 보유 감소,
    // 선물 −는 반대 포지션이다. 장부를 시장별로 나눠 두는 이유다.
    const signed = String(r.side).toUpperCase() === 'BUY' ? qty : -qty;

    const key = `${strategy}|${market}|${r.symbol}`;
    const prev = book.get(key);
    if (!prev) {
      book.set(key, {
        strategyId: strategy, symbol: String(r.symbol), market,
        qty: signed, avgPrice: price,
      });
      continue;
    }

    // 같은 방향으로 더하면 평균가를 섞고, 반대면 수량만 줄인다.
    if (prev.qty === 0 || (prev.qty > 0) === (signed > 0)) {
      const totalQty = prev.qty + signed;
      if (price != null && prev.avgPrice != null && totalQty !== 0) {
        prev.avgPrice = (prev.avgPrice * Math.abs(prev.qty) + price * qty) / Math.abs(totalQty);
      }
      prev.qty = totalQty;
    } else {
      prev.qty = prev.qty + signed;
      if (Math.abs(prev.qty) < 1e-12) { prev.qty = 0; prev.avgPrice = null; }
    }
  }

  const holdings = Array.from(book.values()).filter(h => Math.abs(h.qty) > 1e-12);

  // ── 거래소 실제 수량 ──
  // 못 읽으면 null로 둔다. 0으로 채우면 "전부 미귀속"이 되어 경고가 도배된다.
  const exchangeQty = new Map<string, number>();
  let exchangeReadable = false;
  if (connectionId) {
    try {
      const { data: conn } = await (sb.from('exchange_connections') as any)
        .select('api_key, api_secret_enc, encrypted_secret, has_withdrawal, is_testnet')
        .eq('id', connectionId).eq('user_id', uid).maybeSingle();
      if (conn && !conn.has_withdrawal) {
        const { decryptSecret } = await import('@/lib/exchanges/crypto');
        const bf = await import('@/lib/exchanges/binanceFutures');
        const secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || '');
        const pos: any = await bf.getFuturesPositions(conn.api_key || '', secret, conn.is_testnet === true);
        if (pos?.success) {
          exchangeReadable = true;
          for (const p of pos.positions) {
            exchangeQty.set(`USDT_FUTURES|${p.symbol}`, Number(p.amount) || 0);
          }
        }
      }
    } catch { /* 못 읽으면 exchangeReadable=false */ }
  }

  // ── 대조 ──
  const pairs = new Set(holdings.map(h => `${h.market}|${h.symbol}`));
  // 거래소에는 있는데 장부에 아예 없는 종목도 대조 대상이다
  for (const k of exchangeQty.keys()) pairs.add(k);

  const attribution = Array.from(pairs).map(k => {
    const [market, symbol] = k.split('|');
    const ex = exchangeReadable ? (exchangeQty.get(k) ?? 0) : null;
    return attribute(holdings, symbol, market as any, ex);
  });

  // ── 충돌 ──
  const intents: StrategyIntent[] = holdings.map(h => ({
    strategyId: h.strategyId, symbol: h.symbol, market: h.market, qty: h.qty,
  }));
  const conflicts = detectConflicts(intents.filter(i => i.strategyId !== UNOWNED));

  // 전략 목록 — 화면이 이걸로 필터를 만든다
  const strategies = Array.from(new Set(holdings.map(h => h.strategyId))).sort();

  return NextResponse.json({
    ok: true,
    holdings,
    strategies,
    attribution,
    conflicts,
    exchangeReadable,
    unownedCount,
    note: exchangeReadable
      ? '장부는 앱이 붙인 귀속입니다. 거래소가 사실이고, 차이는 미귀속으로 표시됩니다.'
      : '거래소 수량을 읽지 못해 대조하지 못했습니다 — 일치한다는 뜻이 아닙니다.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
