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
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const connectionId = req.nextUrl.searchParams.get('connectionId');
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn, error } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (error || !conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  // **거래소를 가리지 않는다.**
  //
  // 예전에는 바이낸스가 아니면 not_binance로 끝났다. 그래서 Gate 연결로
  // 주문을 내면 **체결은 되는데 포지션 탭에는 "열린 포지션이 없습니다"**가
  // 떴다. 증거금은 빠져 나갔고 포지션은 살아 있는데 화면에는 없다.
  //
  // 이건 이 앱에서 가장 위험한 화면 상태다. 안 보이는 포지션은 닫을 생각도
  // 못 하고, 손절이 걸렸는지도 알 수 없다.
  const { futuresExchangeOf } = await import('@/lib/exchanges/futuresAdapter');
  const ex = futuresExchangeOf(conn.exchange_id);
  if (!ex) {
    return NextResponse.json({
      error: 'unsupported_exchange',
      message: `이 연결(${conn.exchange_id || '알 수 없음'})의 선물 계좌는 아직 읽지 못합니다`,
    }, { status: 400 });
  }

  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return NextResponse.json({ error: 'decrypt_failed' }, { status: 500 }); }
  const apiKey = conn.api_key || '';
  // **저장소 공통 규칙: is_testnet === false 일 때만 실전이다.**
  // 예전에는 `=== true`라 값이 비어 있으면 실전으로 읽었다 — 모르는 값이
  // 실제 돈 쪽으로 기울면 안 된다.
  const testnet = conn.is_testnet !== false;

  if (ex === 'gate') return gateAccount(apiKey, secret, testnet);

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

/**
 * Gate 선물 계좌·포지션.
 *
 * 바이낸스 응답 모양으로 맞춰 돌려준다 — 화면(BottomDock)이 한 벌의 코드로
 * 두 거래소를 그려야 한다. 여기서 모양이 갈리면 화면에 분기가 생기고,
 * 분기가 생기면 한쪽만 고쳐진다.
 *
 * **못 읽은 것은 0으로 채우지 않는다.** 잔고 조회가 실패했는데 0을 그리면
 * "돈이 없다"가 되고, 포지션 조회가 실패했는데 빈 배열을 그리면 "포지션이
 * 없다"가 된다. 둘 다 확인한 적 없는 사실이다.
 */
async function gateAccount(apiKey: string, secret: string, testnet: boolean) {
  const gf = await import('@/lib/exchanges/gateFutures');
  const gp = await import('@/lib/exchanges/gatePlan');

  let balances: any[] = [];
  let balanceMsg = '';
  try {
    const acct = await gf.getAccountGateFutures(apiKey, secret, testnet);
    const total = Number(acct?.total);
    const avail = Number(acct?.available);
    const upnl = Number(acct?.unrealised_pnl);
    if (Number.isFinite(total) || Number.isFinite(avail)) {
      balances = [{
        asset: 'USDT',
        balance: Number.isFinite(total) ? total : avail,
        availableBalance: Number.isFinite(avail) ? avail : total,
        unrealizedPnl: Number.isFinite(upnl) ? upnl : 0,
      }];
      balanceMsg = '잔고 조회 성공';
    } else {
      balanceMsg = 'Gate 계좌 응답에 잔고가 없습니다';
    }
  } catch (e: any) {
    balanceMsg = `잔고 조회 실패: ${e?.message || e}`;
  }

  let rawPositions: any[] = [];
  let positionMsg = '';
  let positionsReadable = false;
  try {
    rawPositions = await gf.getPositionsGateFutures(apiKey, secret, testnet);
    positionsReadable = true;
    positionMsg = `${rawPositions.length}개 포지션`;
  } catch (e: any) {
    positionMsg = `포지션 조회 실패: ${e?.message || e}`;
  }

  const positions = await Promise.all(rawPositions.map(async (p: any) => {
    const contract = String(p.contract || '');
    // Gate는 계약 수로 준다. 배수를 곱해 기초자산 수량으로 바꾼다 —
    // 못 읽으면 null이다. 계약 수를 수량 칸에 적으면 "0.98 BTC"가
    // "9800 BTC"로 보인다.
    const spec = await gf.getGateContractSpec(contract, testnet);
    const contracts = Number(p.size) || 0;
    const amtBase = gp.gateBaseFromContracts(contracts, spec);

    // 걸려 있는 손절·익절. **못 읽으면 null이다** — 빈 배열이면 화면이
    // "손절 없음"으로 그리고, 그건 확인한 적 없는 사실이다.
    let tp: number | null = null, sl: number | null = null;
    const priceOrders = await gf.getPriceOrdersGateFutures(apiKey, secret, contract, testnet);
    if (priceOrders) {
      for (const o of priceOrders) {
        const trig = Number(o?.trigger?.price);
        if (!Number.isFinite(trig) || trig <= 0) continue;
        const rule = Number(o?.trigger?.rule);
        // LONG(양수)은 아래로 내려갈 때 닫는 것이 손절(rule 2), 위는 익절.
        // SHORT은 반대다. 부호를 여기서 틀리면 손절칸에 익절가가 뜬다.
        const isStop = contracts > 0 ? rule === 2 : rule === 1;
        if (isStop) sl = trig; else tp = trig;
      }
    }

    const entry = Number(p.entry_price);
    const liq = Number(p.liq_price);
    const lev = Number(p.leverage);
    const upnl = Number(p.unrealised_pnl);
    const mark = Number((p as any).mark_price);

    return {
      symbol: contract.replace('_', ''),
      side: contracts > 0 ? 'LONG' : contracts < 0 ? 'SHORT' : 'FLAT',
      amount: amtBase != null ? Math.abs(amtBase) : null,
      // 계약 수도 함께 보낸다. Gate에서 실제로 거래되는 단위이고,
      // 거래소 화면과 대조할 때 이 숫자가 필요하다.
      contracts: Math.abs(contracts),
      entryPrice: Number.isFinite(entry) && entry > 0 ? entry : null,
      markPrice: Number.isFinite(mark) && mark > 0 ? mark : null,
      unrealizedPnl: Number.isFinite(upnl) ? upnl : null,
      leverage: Number.isFinite(lev) && lev > 0 ? lev : null,
      liquidationPrice: Number.isFinite(liq) && liq > 0 ? liq : null,
      // Gate는 leverage 0이 교차다. 판정은 gatePlan 한 곳에 있다.
      marginType: gp.isGateIsolated(p.leverage) ? 'isolated' : 'cross',
      tpPrice: tp, slPrice: sl,
      // 손절·익절을 **못 읽었는지** 화면이 알아야 한다. null과 '없음'은 다르다.
      protectionReadable: priceOrders != null,
      mmr: null, maintAmount: null,
      lastFundingRate: null, nextFundingTime: null,
      estimatedNextFundingFee: null, fundingSide: 'neutral' as const,
      liqSource: Number.isFinite(liq) && liq > 0 ? 'exchange' : 'estimated',
      bracketSource: 'unavailable',
    };
  }));

  return NextResponse.json({
    testnet,
    exchange: 'gate',
    balances,
    positions,
    // **읽지 못했으면 그 사실을 남긴다.** 빈 배열만 보내면 화면은
    // "포지션 없음"으로 그리고, 그게 이 앱에서 가장 위험한 거짓말이다.
    positionsReadable,
    // Gate의 펀딩 내역은 account_book에 섞여 있다. 아직 안 갈라 놨으므로
    // 0으로 채우지 않고 비어 있다고 말한다.
    funding: { total: null, bySymbol: {}, items: [] },
    balanceMsg,
    positionMsg,
    fundingMsg: 'Gate 펀딩 내역은 아직 표시하지 않습니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
