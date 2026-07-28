// /api/strategies/combined
//
// 현물+선물 결합 전략을 평가한다. **주문은 내지 않는다.**
//
// 실행을 여기서 하지 않는 이유는 다른 전략 라우트와 같다 — 주문 경로는
// 시장마다 하나여야 한다. 결합 전략은 오히려 그게 더 중요하다: 다리가
// 두 시장에 걸쳐 있으니 각 시장의 검사(현물 공매도 차단, 선물 ISOLATED
// 강제)를 그 시장의 경로가 하게 해야 한다.
//
// 대신 여기서는 **순서와 실패 시 상태**를 정해 준다. 그게 결합 전략에서
// 가장 중요한 정보다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import {
  planCombined, checkHedgeHealth, estimateFundingCost,
  COMBINED_IDS, COMBINED_LABEL,
  type CombinedStrategyId, type CombinedContext,
} from '@/lib/strategies/combined';
import { computeCostBasis } from '@/lib/markets/costBasis';
import { rsiLast } from '@/lib/strategies/spotStrategies';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : null;
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
  const base = symbol.replace(/USDT$|BUSD$|USDC$/, '');

  // ── 시세·지표 ──
  const [priceJson, klines, premium] = await Promise.all([
    fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`),
    fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=60`),
    fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
  ]);

  const price = priceJson ? parseFloat(priceJson.price) : null;
  const closes = Array.isArray(klines)
    ? klines.map((k: any) => parseFloat(k?.[4])).filter((v: number) => Number.isFinite(v))
    : [];
  const fundingRaw = premium ? parseFloat(premium.lastFundingRate) : NaN;
  const fundingPct = Number.isFinite(fundingRaw) ? fundingRaw * 100 : null;
  const overheatScore = closes.length ? rsiLast(closes, 14) : null;

  // ── 포지션 ──
  // 한쪽이라도 못 읽으면 null로 둔다. 0으로 채우면 "현물 없음 → 헤지 불필요"나
  // "선물 없음 → 전량 숏"처럼 정반대 계획이 나온다.
  let spotQty: number | null = null;
  let spotAvgPrice: number | null = null;
  let futuresQty: number | null = null;
  let futuresPnlUsd: number | null = null;
  let futuresMarginUsd: number | null = null;

  if (connectionId) {
    const { data: conn } = await (sb.from('exchange_connections') as any)
      .select('api_key, api_secret_enc, encrypted_secret, has_withdrawal, is_testnet')
      .eq('id', connectionId).eq('user_id', uid).maybeSingle();

    if (conn && !conn.has_withdrawal) {
      const { decryptSecret } = await import('@/lib/exchanges/crypto');
      const secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || '');
      const apiKey = conn.api_key || '';
      const testnet = conn.is_testnet === true;

      try {
        const bn = await import('@/lib/exchanges/binance');
        const balances = await bn.getBalancesBinance(apiKey, secret, testnet);
        const hit = (Array.isArray(balances) ? balances : [])
          .find(b => String(b.currency).toUpperCase() === base);
        spotQty = hit ? (Number(hit.free) || 0) + (Number(hit.locked) || 0) : 0;

        const raw = await bn.getSpotTrades(apiKey, secret, symbol, 500, testnet);
        spotAvgPrice = computeCostBasis(
          raw.map((t: any) => ({
            time: Number(t.time) || 0,
            isBuyer: !!t.isBuyer, qty: Number(t.qty), price: Number(t.price),
            commission: Number(t.commission), commissionAsset: String(t.commissionAsset || ''),
            baseAsset: base,
          })).sort((a, b) => a.time - b.time),
        ).avgPrice;
      } catch { /* null 유지 */ }

      try {
        const bf = await import('@/lib/exchanges/binanceFutures');
        const pos: any = await bf.getFuturesPositions(apiKey, secret, testnet);
        if (pos?.success) {
          const mine = (pos.positions as any[]).filter(p => String(p.symbol) === symbol);
          futuresQty = mine.reduce((s, p) => s + (Number(p.amount) || 0), 0);
          futuresPnlUsd = mine.reduce(
            (s, p) => s + (Number(p.unrealizedPnl ?? p.unRealizedProfit) || 0), 0);
        }
        const bal: any = await bf.getFuturesBalance(apiKey, secret, testnet);
        if (bal?.success) {
          const v = Number(bal.available ?? bal.availableBalance);
          futuresMarginUsd = Number.isFinite(v) ? v : null;
        }
      } catch { /* null 유지 */ }
    }
  }

  const ctx: CombinedContext = {
    symbol, price, spotQty, futuresQty, futuresPnlUsd,
    spotAvgPrice, fundingPct, overheatScore, futuresMarginUsd,
  };

  const only = req.nextUrl.searchParams.get('strategy') as CombinedStrategyId | null;
  const ids = only && COMBINED_IDS.includes(only) ? [only] : COMBINED_IDS;

  const plans = ids.map(id => {
    const p = planCombined(id, ctx, {
      targetExposureRatio: Number(req.nextUrl.searchParams.get('exposure') ?? 0),
      leverage: Number(req.nextUrl.searchParams.get('leverage') ?? 2),
      holdDays: Number(req.nextUrl.searchParams.get('holdDays') ?? 30),
    });
    return {
      id, label: COMBINED_LABEL[id],
      ok: p.ok, reason: p.reason,
      legs: p.legs, warnings: p.warnings,
      targetNetExposure: p.targetNetExposure,
    };
  });

  // 지금 헤지가 살아 있는가 — 계획과 별개로 항상 본다
  const health = checkHedgeHealth(spotQty, futuresQty, spotQty ?? 0);
  const notional = spotQty != null && price != null ? Math.abs(spotQty) * price : 0;
  const funding = estimateFundingCost(fundingPct, notional, 30, 'SHORT');

  return NextResponse.json({
    ok: true,
    symbol, price,
    spotQty, spotAvgPrice, futuresQty, futuresPnlUsd, futuresMarginUsd,
    fundingPct, overheatScore,
    positionsReadable: spotQty != null && futuresQty != null,
    netExposure: spotQty != null && futuresQty != null ? spotQty + futuresQty : null,
    hedgeHealth: health,
    fundingCost30d: funding,
    plans,
    note: '평가 결과입니다. 주문은 나가지 않았습니다 — 각 다리는 해당 시장의 주문 화면에서 실행하세요.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
