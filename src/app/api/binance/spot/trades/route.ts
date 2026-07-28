// /api/binance/spot/trades
//
// 현물 체결 내역 + 그 종목의 평균 매수가·미실현 손익.
//
// 평균 매수가를 여기서 계산하는 이유
// ──────────────────────────────────
// 거래소는 현물 평균 매수가를 주지 않는다. 체결 내역에서 직접 구해야 한다.
// 화면마다 각자 계산하면 화면마다 다른 수익률이 나온다 — 한 곳에서 낸다.
//
// 계산은 **이동평균 원가**다. 매수하면 원가에 섞고, 매도하면 수량만 줄이고
// 단가는 유지한다(그때 실현손익이 확정된다). 수수료는 받은 그대로 뺀다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface SpotCostBasis {
  /** 현재 보유 수량 (체결 내역 기준) */
  qty: number;
  /** 평균 매수 단가. 보유가 0이면 null */
  avgPrice: number | null;
  /** 지금까지 확정된 실현 손익 (수수료 반영) */
  realizedPnl: number;
  /** 지불한 수수료 합 (USDT 환산이 아닌 원 통화 그대로일 수 있음) */
  feePaid: number;
}

/**
 * 체결 내역에서 평균 매수가와 실현손익을 구한다. 순수 함수 — 시간순 입력을 가정한다.
 */
export function computeCostBasis(
  trades: { isBuyer: boolean; qty: number; price: number; commission: number; commissionAsset: string; baseAsset: string }[],
): SpotCostBasis {
  let qty = 0, cost = 0, realized = 0, fee = 0;

  for (const t of trades) {
    if (!Number.isFinite(t.qty) || !Number.isFinite(t.price)) continue;
    const c = Number.isFinite(t.commission) ? t.commission : 0;
    fee += c;

    if (t.isBuyer) {
      // 수수료를 코인으로 냈으면 그만큼 덜 받은 것이다
      const received = t.commissionAsset === t.baseAsset ? t.qty - c : t.qty;
      cost += t.qty * t.price;
      qty += received;
    } else {
      const avg = qty > 0 ? cost / qty : 0;
      const sold = Math.min(t.qty, qty);
      realized += sold * (t.price - avg);
      // 매도 수수료는 보통 견적통화(USDT)로 낸다
      if (t.commissionAsset !== t.baseAsset) realized -= c;
      cost -= sold * avg;
      qty -= sold;
      if (qty < 1e-12) { qty = 0; cost = 0; }
    }
  }

  return {
    qty,
    avgPrice: qty > 0 ? cost / qty : null,
    realizedPnl: realized,
    feePaid: fee,
  };
}

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const connectionId = req.nextUrl.searchParams.get('connectionId');
  const symbol = req.nextUrl.searchParams.get('symbol');
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });
  // 거래소가 전체 체결을 주지 않는다. symbol 없이 빈 배열을 돌려주면
  // "거래 내역이 없다"로 읽히므로 명시적으로 요구한다.
  if (!symbol) {
    return NextResponse.json(
      { error: 'missing_symbol', message: '현물 체결 내역은 종목을 지정해야 조회됩니다' },
      { status: 400 });
  }

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, api_key, api_secret_enc, encrypted_secret, has_withdrawal')
    .eq('id', connectionId).eq('user_id', uid).maybeSingle();

  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') {
    return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  }
  if (conn.has_withdrawal === true) {
    return NextResponse.json({ error: 'withdrawal_key_blocked' }, { status: 403 });
  }

  try {
    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const { getSpotTrades } = await import('@/lib/exchanges/binance');
    const secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || '');
    const sym = symbol.toUpperCase().replace('/', '');
    const baseAsset = sym.replace(/USDT$|BUSD$|USDC$/, '');

    const raw = await getSpotTrades(conn.api_key || '', secret, sym, 500);
    const trades = raw
      .map((t: any) => ({
        id: t.id, orderId: t.orderId, time: Number(t.time),
        isBuyer: !!t.isBuyer,
        qty: Number(t.qty), price: Number(t.price),
        quoteQty: Number(t.quoteQty),
        commission: Number(t.commission), commissionAsset: String(t.commissionAsset || ''),
        baseAsset,
      }))
      .sort((a, b) => a.time - b.time);

    return NextResponse.json({
      ok: true, marketType: 'SPOT', symbol: sym,
      costBasis: computeCostBasis(trades),
      // 화면에는 최신이 위에 오는 게 자연스럽다
      trades: [...trades].reverse().slice(0, 200),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: 'query_failed', message: e?.message || '현물 체결 조회 실패' },
      { status: 502 });
  }
}
