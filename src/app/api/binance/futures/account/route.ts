// /api/binance/futures/account
// 선물 잔고 + 포지션 조회 (읽기 전용)
// GET ?connectionId=xxx

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { getFuturesBalance, getFuturesPositions, getFuturesFunding, getCachedBracket, getFuturesOpenOrders, getPremiumIndex } from '@/lib/exchanges/binanceFutures';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const connectionId = req.nextUrl.searchParams.get('connectionId');
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn, error } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (error || !conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') {
    return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  }

  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return NextResponse.json({ error: 'decrypt_failed' }, { status: 500 }); }
  const apiKey = conn.api_key || '';
  const testnet = conn.is_testnet === true;

  const [bal, pos, fund, openOrd] = await Promise.all([
    getFuturesBalance(apiKey, secret, testnet),
    getFuturesPositions(apiKey, secret, testnet),
    getFuturesFunding(apiKey, secret, testnet, { limit: 200 }),
    getFuturesOpenOrders(apiKey, secret, testnet),
  ]);

  const orders = openOrd.success ? openOrd.orders : [];
  // 심볼별 현재 TP/SL stopPrice 추출 (TAKE_PROFIT_MARKET / STOP_MARKET)
  const tpslBySymbol: Record<string, { tp: number | null; sl: number | null }> = {};
  for (const o of orders) {
    const s = o.symbol;
    if (!tpslBySymbol[s]) tpslBySymbol[s] = { tp: null, sl: null };
    if (o.type === 'TAKE_PROFIT_MARKET') tpslBySymbol[s].tp = o.stopPrice;
    if (o.type === 'STOP_MARKET')        tpslBySymbol[s].sl = o.stopPrice;
  }

  // 각 포지션에 실제 브래킷 기반 MMR/유지증거금 부착 (청산가는 거래소 제공값이 정확)
  const rawPositions = pos.success ? pos.positions : [];
  const positions = await Promise.all(rawPositions.map(async (p: any) => {
    const notional = Math.abs((p.markPrice || p.entryPrice || 0) * (p.amount || 0));
    const tiers = await getCachedBracket(p.symbol, apiKey, secret, testnet);
    let mmr: number | null = null, maintAmount: number | null = null, bracketSource = 'fallback';
    if (tiers && tiers.length) {
      const sorted = [...tiers].sort((a, b) => a[0] - b[0]);
      const t = sorted.find(([cap]) => notional <= cap) || sorted[sorted.length - 1];
      mmr = t[1]; maintAmount = t[2]; bracketSource = 'exchange';
    }
    const tpsl = tpslBySymbol[p.symbol] || { tp: null, sl: null };

    // 펀딩 예측 (premiumIndex)
    const prem = await getPremiumIndex(p.symbol, testnet);
    let lastFundingRate: number | null = null, nextFundingTime: number | null = null;
    let estimatedNextFundingFee: number | null = null, fundingSide: 'pay' | 'receive' | 'neutral' = 'neutral';
    if (prem) {
      lastFundingRate = prem.lastFundingRate;
      nextFundingTime = prem.nextFundingTime;
      const mark = prem.markPrice || p.markPrice || p.entryPrice || 0;
      const notion = Math.abs(mark * (p.amount || 0));
      const isLong = (p.amount || 0) > 0;
      const mag = notion * Math.abs(lastFundingRate);
      if (lastFundingRate === 0) { fundingSide = 'neutral'; estimatedNextFundingFee = 0; }
      else {
        // LONG은 rate>0일 때 지불, SHORT는 rate<0일 때 지불
        const pays = isLong ? lastFundingRate > 0 : lastFundingRate < 0;
        fundingSide = pays ? 'pay' : 'receive';
        estimatedNextFundingFee = pays ? -mag : mag;   // 음수=지불, 양수=수령
      }
    }

    return {
      ...p,
      mmr, maintAmount,
      tpPrice: tpsl.tp, slPrice: tpsl.sl,
      lastFundingRate, nextFundingTime, estimatedNextFundingFee, fundingSide,
      // 청산가는 바이낸스 positionRisk 직접 제공값 → 거래소 실제값
      liqSource: p.liquidationPrice > 0 ? 'exchange' : 'estimated',
      bracketSource,
    };
  }));

  return NextResponse.json({
    testnet,
    balances:  bal.success ? bal.balances : [],
    positions,
    funding:   { total: fund.total, bySymbol: fund.bySymbol, items: fund.items.slice(0, 50) },
    balanceMsg:  bal.message,
    positionMsg: pos.message,
    fundingMsg:  fund.message,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
