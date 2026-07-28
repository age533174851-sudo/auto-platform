// /api/strategies/spot
//
// 현물 전략 10종을 평가한다. **주문은 내지 않는다.**
//
// 왜 여기서 주문하지 않나
// ───────────────────────
// 주문 경로는 시장마다 하나여야 한다(/api/binance/spot/order). 전략
// 라우트가 자기 주문 경로를 따로 가지면, 현물 주문 검사(공매도 차단·
// 보유 확인·레버리지 필드 거부)를 두 곳에서 관리하게 되고 언젠가
// 한쪽만 고쳐진다.
//
// 그래서 여기서는 "무엇을 해야 하는가"만 돌려주고, 실행은 호출자가
// 기존 현물 주문 라우트로 한다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import {
  decideSpot, SPOT_STRATEGY_IDS, SPOT_STRATEGY_LABEL,
  type SpotStrategyId, type SpotContext,
} from '@/lib/strategies/spotStrategies';
import { computeCostBasis } from '@/lib/markets/costBasis';
import { strategyOf } from '@/lib/strategies/ledger';
import { priceAssets, totalValueUsd } from '@/lib/markets/pricing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 일봉 종가. 지표 계산용 — 현물 시장에서 받는다 */
async function fetchCloses(symbol: string, limit = 120): Promise<number[]> {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`,
      { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return [];
    const d = await r.json();
    return (Array.isArray(d) ? d : [])
      .map((k: any) => parseFloat(k?.[4]))
      .filter((v: number) => Number.isFinite(v));
  } catch { return []; }
}

async function fetchSpotPrice(symbol: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const v = parseFloat(j?.price);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const symbol = String(req.nextUrl.searchParams.get('symbol') || 'BTCUSDT')
    .toUpperCase().replace('/', '');
  const connectionId = req.nextUrl.searchParams.get('connectionId');
  const only = req.nextUrl.searchParams.get('strategy') as SpotStrategyId | null;
  const budgetUsd = Number(req.nextUrl.searchParams.get('budget') || '1000');

  const [price, closes] = await Promise.all([fetchSpotPrice(symbol), fetchCloses(symbol)]);

  // ── 보유·평균가 ──
  // 못 읽으면 0/null로 두되, 그 사실을 응답에 남긴다. 전략은 어차피
  // 모르는 값에서는 보류한다.
  let heldQty = 0;
  let avgPrice: number | null = null;
  let portfolioValueUsd: number | null = null;
  let holdingsReadable = false;

  if (connectionId) {
    try {
      const { data: conn } = await (sb.from('exchange_connections') as any)
        .select('api_key, api_secret_enc, encrypted_secret, has_withdrawal')
        .eq('id', connectionId).eq('user_id', uid).maybeSingle();
      if (conn && !conn.has_withdrawal) {
        const { decryptSecret } = await import('@/lib/exchanges/crypto');
        const bn = await import('@/lib/exchanges/binance');
        const secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || '');
        const base = symbol.replace(/USDT$|BUSD$|USDC$/, '');

        const balances = await bn.getBalancesBinance(conn.api_key || '', secret);
        const hit = (Array.isArray(balances) ? balances : [])
          .find(b => String(b.currency).toUpperCase() === base);
        heldQty = hit ? (Number(hit.free) || 0) + (Number(hit.locked) || 0) : 0;
        holdingsReadable = true;

        // 리밸런싱은 전체 평가액이 필요하다. 거래소는 USD 값을 주지 않으므로
        // 여기서 매긴다. 값을 못 구한 자산이 하나라도 있으면 null이고,
        // 그러면 리밸런싱이 보류된다 — 반쪽 합계로 비중을 내면 그 비중을
        // 근거로 팔아버린다.
        const priced = await priceAssets(
          (Array.isArray(balances) ? balances : []).map(b => ({
            asset: String(b.currency || ''),
            free: Number(b.free) || 0,
            locked: Number(b.locked) || 0,
          })));
        portfolioValueUsd = totalValueUsd(priced);

        const raw = await bn.getSpotTrades(conn.api_key || '', secret, symbol, 500);
        // computeCostBasis는 시간 오름차순을 가정한다. 순서가 뒤집히면
        // 평균 원가가 틀린다.
        const basis = computeCostBasis(
          raw
            .map((t: any) => ({
              time: Number(t.time) || 0,
              isBuyer: !!t.isBuyer, qty: Number(t.qty), price: Number(t.price),
              commission: Number(t.commission), commissionAsset: String(t.commissionAsset || ''),
              baseAsset: base,
            }))
            .sort((a, b) => a.time - b.time),
        );
        avgPrice = basis.avgPrice;
      }
    } catch { /* 못 읽으면 holdingsReadable=false */ }
  }

  // ── 이 전략이 마지막으로 산 시각 ──
  // 적립식·이동평균 적립이 주기를 지키려면 필요하다.
  const lastBuyAt = new Map<string, number>();
  try {
    const { data } = await sb.from('live_orders')
      // strategy_id 컬럼은 아직 없다. strategyOf가 signal_id 표식으로
      // 읽으므로 여기서는 요청하지 않는다 (요청하면 조회 자체가 실패한다).
      .select('signal_id, created_at, side, symbol')
      .eq('user_id', uid).eq('symbol', symbol).eq('side', 'BUY')
      .in('status', ['FILLED', 'RECONCILED'])
      .order('created_at', { ascending: false }).limit(200);
    for (const r of (Array.isArray(data) ? data : [])) {
      const s = strategyOf(r);
      if (!s || lastBuyAt.has(s)) continue;
      lastBuyAt.set(s, new Date(r.created_at).getTime());
    }
  } catch { /* 없으면 첫 실행으로 본다 */ }

  const ids = only && SPOT_STRATEGY_IDS.includes(only) ? [only] : SPOT_STRATEGY_IDS;
  const now = Date.now();

  const results = ids.map(id => {
    const ctx: SpotContext = {
      symbol, price, closes,
      heldQty, avgPrice, portfolioValueUsd,
      budgetUsd,
      // 사용액은 전략별 예산 장부가 생기기 전까지 0으로 둔다.
      // 0이라고 해서 예산이 무제한이 되지는 않는다 — budgetUsd가 상한이다.
      usedUsd: 0,
      now,
      lastBuyAt: lastBuyAt.get(id) ?? null,
    };
    const r = decideSpot(id, ctx, {});
    return {
      id, label: SPOT_STRATEGY_LABEL[id],
      action: r.intent.action,
      quoteUsd: r.intent.quoteUsd ?? null,
      qty: r.intent.qty ?? null,
      reason: r.intent.reason,
      clamped: r.clamped,
      note: r.note ?? null,
    };
  });

  return NextResponse.json({
    ok: true,
    marketType: 'SPOT',
    symbol,
    price,
    heldQty: holdingsReadable ? heldQty : null,
    avgPrice,
    holdingsReadable,
    portfolioValueUsd,
    results,
    // 이 라우트는 판단만 한다는 사실을 응답에도 남긴다
    note: '평가 결과입니다. 주문은 나가지 않았습니다 — 실행은 현물 주문 화면에서 하세요.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
