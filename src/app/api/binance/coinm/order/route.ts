// /api/binance/coinm/order
//
// COIN-M 선물 주문. **현물·USDⓈ-M과 코드를 공유하지 않는다.**
//
// 이 시장의 고유 위험
// ───────────────────
// 수량 단위가 **계약**이다. 코인 개수가 아니다. BTCUSD_PERP은
// 1계약 = 100 USD다. 사용자가 0.5를 넣으며 "0.5 BTC"를 생각했다면
// 실제로는 0.5계약(소수라 거부)이고, 3을 넣었다면 300 USD다.
//
// 그래서 이 라우트는 계약 수를 받되, 사용자가 금액으로 생각했을 수 있는
// 경우를 위해 notionalUsd도 받아 **서버에서 변환**한다. 변환은 항상
// 내림이다 — 올리면 의도보다 큰 포지션이 열린다.
//
// 확인 토큰도 다르다. 현물·USDⓈ-M과 같은 값이면 엔드포인트만 바꿔치기해도
// 통과한다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import {
  checkCoinMIntent, resolveContractSize, notionalToContracts,
  requiredMarginCoin, isCoinMSymbol,
} from '@/lib/markets/coinM';
import { tagSignalId } from '@/lib/markets/marketType';
import { tagStrategy } from '@/lib/strategies/ledger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  if (body.confirmToken !== 'COINM_ORDER_CONFIRMED') {
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400 });
  }
  if (!body.connectionId) {
    return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });
  }

  const symbol = String(body.symbol || '').toUpperCase();
  if (!isCoinMSymbol(symbol)) {
    return NextResponse.json({
      error: 'not_coinm',
      message: `'${symbol}'은 COIN-M 심볼이 아닙니다. BTCUSD_PERP 형식이어야 합니다 ` +
               `(BTCUSDT는 USDⓈ-M 선물입니다).`,
    }, { status: 400 });
  }

  const side = String(body.side || '').toUpperCase() as 'BUY' | 'SELL';
  const type = String(body.type || 'MARKET').toUpperCase() as 'MARKET' | 'LIMIT';
  const leverage = Number(body.leverage ?? 1);
  const price = body.price != null ? Number(body.price) : null;

  // ── 연결 ──
  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, api_key, api_secret_enc, encrypted_secret, has_withdrawal, is_testnet')
    .eq('id', body.connectionId).eq('user_id', uid).maybeSingle();

  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') {
    return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  }
  if (conn.has_withdrawal === true) {
    return NextResponse.json({ error: 'withdrawal_key_blocked' }, { status: 403 });
  }

  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  const dapi = await import('@/lib/exchanges/binanceCoinFutures');
  const apiKey = conn.api_key || '';
  const testnet = conn.is_testnet === true;
  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return NextResponse.json({ error: 'decrypt_failed' }, { status: 500 }); }

  // ── 계약 크기 ──
  // 거래소에서 받는 것이 원칙이다. 못 받고 아는 값도 없으면 주문하지 않는다 —
  // 알트를 10으로 추측했다가 실제가 100이면 10배 큰 주문이 나간다.
  const fromExchange = await dapi.getCoinMContractSize(symbol, testnet);
  const spec = resolveContractSize(symbol, fromExchange);
  if (!spec) {
    return NextResponse.json({
      error: 'unknown_contract_size',
      message: `${symbol}의 계약 크기를 확인하지 못했습니다. 추측해서 주문하지 않습니다.`,
    }, { status: 502 });
  }

  // ── 수량 결정 ──
  // contracts를 직접 줬으면 그대로, notionalUsd를 줬으면 내림 변환.
  let contracts: number;
  let conversionNote: string | null = null;

  if (body.contracts != null) {
    contracts = Number(body.contracts);
  } else if (body.notionalUsd != null) {
    const c = notionalToContracts(Number(body.notionalUsd), spec.contractUsd);
    if (!c.ok) {
      return NextResponse.json({ error: 'notional_too_small', message: c.reason }, { status: 400 });
    }
    contracts = c.contracts;
    if (c.shortfallUsd > 0) {
      // 조용히 줄이면 왜 주문이 작은지 알 수 없다
      conversionNote =
        `${body.notionalUsd} USD → ${contracts}계약(${c.actualNotionalUsd} USD). ` +
        `1계약이 ${spec.contractUsd} USD라 ${c.shortfallUsd.toFixed(2)} USD는 주문되지 않습니다.`;
    }
  } else {
    return NextResponse.json({
      error: 'missing_quantity',
      message: 'contracts(계약 수) 또는 notionalUsd(명목가)가 필요합니다',
    }, { status: 400 });
  }

  const intent = checkCoinMIntent({ symbol, side, contracts, leverage });
  if (!intent.ok) {
    return NextResponse.json({ error: intent.code, message: intent.reason }, { status: 400 });
  }

  // ── ISOLATED 강제 ──
  // USDⓈ-M과 같은 이유다. CROSSED면 손실이 그 코인 지갑 전체로 번진다.
  const mt = await dapi.setCoinMMarginType(apiKey, secret, symbol, 'ISOLATED', testnet);
  if (!mt.success) {
    return NextResponse.json({
      error: 'margin_type_failed',
      message: `ISOLATED 설정 실패로 주문을 중단했습니다: ${mt.message}`,
    }, { status: 400 });
  }

  const lev = await dapi.setCoinMLeverage(apiKey, secret, symbol, leverage, testnet);
  if (!lev.success) {
    return NextResponse.json({
      error: 'leverage_failed',
      message: `레버리지 설정 실패로 주문을 중단했습니다: ${lev.message}`,
    }, { status: 400 });
  }

  // ── 거래 전 점검 ──
  //
  // 여기 끼우는 이유: 바로 위에서 ISOLATED와 배율 설정이 **성공을 확인하고**
  // 통과했다. 그 앞에서 점검하면 마진 모드를 아직 모르는 상태가 되고,
  // 그러면 필수 항목 unknown으로 모든 COIN-M 주문이 막힌다.
  //
  // COIN-M 목록에는 손절·청산거리 항목이 없다 — 이 경로가 손절을 붙이지
  // 않기 때문이다. 면제가 아니라 아직 못 고친 위험의 표시다
  // (preTradeChecklist의 STOP_ATTACHED 주석 참조).
  {
    const { fromLegacyMode, gateOrder } = await import('@/lib/engine/operatingMode');
    const { runChecklist } = await import('@/lib/engine/preTradeChecklist');

    const isExit = body.reduceOnly === true;
    const markPrice = await dapi.getCoinMMarkPrice(symbol, testnet);
    // 명목가는 계약 수 × 계약 크기(USD)다. 코인 수량이 아니다 —
    // COIN-M에서 그 둘을 섞으면 자릿수가 통째로 틀린다.
    const notionalUsd = contracts * spec.contractUsd;

    // 필요 증거금은 코인 단위다. 마크가를 못 읽으면 계산하지 않는다 —
    // 추측한 가격으로 증거금을 적으면 그 판정이 거짓말이 된다.
    let marginInput: { required: number | null; available: number | null } | null = null;
    if (!isExit && markPrice != null) {
      // requiredMarginCoin은 결과 객체를 준다. ok:false면 계산이 안 된 것이라
      // marginCoin(0)을 쓰면 안 된다 — 0은 '증거금이 필요 없다'가 아니다.
      const req = requiredMarginCoin(contracts, spec.contractUsd, markPrice, leverage);
      if (req.ok) {
        const bal = await dapi.getCoinMBalances(apiKey, secret, testnet);
        // 심볼에서 담보 코인을 뽑는다: BTCUSD_PERP → BTC
        const coin = symbol.split('USD')[0];
        const hit = bal.success
          ? bal.balances.find(b => b.asset.toUpperCase() === coin.toUpperCase())
          : null;
        marginInput = {
          required: req.marginCoin,
          available: hit ? (hit.availableBalance ?? hit.balance) : null,
        };
      }
    }

    const localMs = Date.now();
    // COIN-M은 dapi 호스트다. 선물(fapi) 시각을 쓰면 다른 호스트에 물어보는
    // 것이 된다 — premiumIndex 호출로 도달성은 이미 확인됐으므로, 시각만
    // 따로 읽는다.
    const serverMs = await dapi.getCoinMServerTime(testnet);

    const mode = fromLegacyMode(process.env.NEXT_PUBLIC_APP_MODE ?? null);
    const g = gateOrder(mode, notionalUsd);

    const checklist = runChecklist({
      mode: { disposition: g.disposition, reason: g.reason },
      clock: serverMs != null ? { localMs, serverMs } : null,
      // 위에서 성공을 확인한 값들이다
      marginType: 'isolated',
      leverage: { actual: leverage, intended: leverage },
      // 실제로 센다. 0을 그냥 적으면 "확인했고 없다"가 되는데, 그건
      // 확인하지 않은 것을 통과로 적는 것이다 — 이 체크리스트가 막으려는
      // 바로 그 실패다. 조회가 실패하면 null이 되어 unknown으로 막힌다.
      unresolvedOrderCount: await (async () => {
        const q = await sb.from('live_orders')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', uid).eq('status', 'UNKNOWN');
        return q.error ? null : (q.count ?? 0);
      })(),
      existingPositionQty: null,
      margin: marginInput,
      side: side === 'SELL' ? 'SHORT' : 'LONG',
    }, { market: 'COINM', intent: isExit ? 'EXIT' : 'ENTRY' });

    if (!checklist.allowed) {
      return NextResponse.json({
        error: 'checklist_blocked',
        message: checklist.summary,
        checklist: {
          allowed: false, market: checklist.market, intent: checklist.intent,
          passed: checklist.passed, total: checklist.total,
          unknownCount: checklist.unknownCount,
          results: checklist.results, blockers: checklist.blockers,
        },
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  // ── 의도 기록 ──
  const clientOrderId = `CM${Date.now().toString(36).toUpperCase()}${symbol}`.slice(0, 36);
  let signalId = tagSignalId(String(body.signalId || 'manual-coinm'), 'COIN_FUTURES');
  if (body.strategyId) signalId = tagStrategy(signalId, String(body.strategyId));

  const intentRow: Record<string, any> = {
    client_order_id: clientOrderId,
    signal_id: signalId,
    user_id: uid,
    connection_id: body.connectionId,
    exchange: 'binance',
    mode: testnet ? 'TESTNET' : 'LIVE',
    symbol, side, order_type: type,
    // 여기 저장되는 quantity는 **계약 수**다. 다른 시장의 수량과 단위가
    // 다르므로 나중에 합산하면 안 된다 — signal_id의 [COIN_FUTURES]
    // 표식이 그 구분을 남긴다.
    quantity: contracts,
    price: type === 'LIMIT' ? price : null,
    leverage,
    status: 'INTENT',
    market_type: 'COIN_FUTURES',
  };

  const insert = (row: Record<string, any>) =>
    sb.from('live_orders').insert(row).select('id').single();
  let res = await insert(intentRow);
  if (res.error) {
    const { market_type: _drop, ...legacy } = intentRow;
    res = await insert(legacy);
  }
  const rowId = res.data?.id ?? null;

  const patch = async (p: Record<string, any>) => {
    if (!rowId) return;
    try {
      await sb.from('live_orders')
        .update({ ...p, updated_at: new Date().toISOString() }).eq('id', rowId);
    } catch { /* 기록 실패가 주문 결과를 바꾸지 않는다 */ }
  };

  await patch({ status: 'SENT', sent_at: new Date().toISOString() });

  const r = await dapi.placeCoinMOrder(apiKey, secret, {
    symbol, side, type, contracts,
    price: type === 'LIMIT' ? (price ?? undefined) : undefined,
    reduceOnly: body.reduceOnly === true,
    clientOrderId,
  }, testnet);

  if (!r.success) {
    // placeCoinMOrder는 네트워크 오류도 success:false로 돌려준다.
    // 응답을 못 받은 경우와 거부된 경우를 구분해야 재시도 여부를 정할 수 있다.
    const unknown = /timeout|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i
      .test(String(r.message || ''));
    await patch({
      status: unknown ? 'UNKNOWN' : 'REJECTED',
      error_message: r.message,
    });
    return NextResponse.json({
      ok: false, marketType: 'COIN_FUTURES',
      status: unknown ? 'UNKNOWN' : 'REJECTED',
      error: unknown ? 'no_response' : 'order_rejected',
      message: unknown
        ? '주문 전송 후 응답을 받지 못했습니다. 재시도하지 말고 COIN-M 내역을 확인하세요.'
        : r.message,
    }, { status: unknown ? 502 : 400 });
  }

  await patch({
    status: 'FILLED',
    exchange_order_id: String(r.orderId ?? ''),
    filled_qty: r.filledContracts ?? null,
    avg_price: r.avgPrice ?? null,
    acked_at: new Date().toISOString(),
  });

  // 참고용 증거금 — **코인 단위**다
  const margin = r.avgPrice
    ? requiredMarginCoin(contracts, spec.contractUsd, r.avgPrice, leverage)
    : null;

  return NextResponse.json({
    ok: true, marketType: 'COIN_FUTURES',
    clientOrderId, orderId: r.orderId,
    contracts, contractUsd: spec.contractUsd,
    contractSizeSource: spec.source,
    filledContracts: r.filledContracts,
    avgPrice: r.avgPrice,
    marginCoin: margin?.ok ? margin.marginCoin : null,
    baseAsset: symbol.replace(/USD_(PERP|\d{6})$/, ''),
    conversionNote,
    message: `COIN-M ${side === 'BUY' ? 'LONG 진입' : 'SHORT 진입'} — ${contracts}계약`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
