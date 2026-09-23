// src/lib/exchanges/spotOrderExecutor.ts
//
// 현물 주문 실행. **현물 주문이 나가는 유일한 구현이다.**
//
// 왜 라우트에서 꺼냈나
// ────────────────────
// 감시 루프(트레일링·예약)가 조건을 만족했을 때 주문을 내야 하는데,
// 그 루프는 cron이 관리자 시크릿으로 호출한다. 사용자 JWT가 없으므로
// /api/binance/spot/order를 그대로 부를 수 없다 (resolveUserId가
// 프로덕션에서 JWT만 받는다 — 그게 맞다).
//
// 그렇다고 루프가 자기 주문 코드를 따로 가지면, 현물 검사(공매도 차단·
// 보유 확인·레버리지 필드 거부·수량 정밀도)가 두 벌이 되고 언젠가
// 한쪽만 고쳐진다. 그래서 구현을 여기 하나만 두고
//   - HTTP 라우트: 사용자가 부른다 (인증은 라우트가 한다)
//   - 감시 루프: 서버가 부른다 (사용자 확인은 루프가 한다)
// 두 입구가 같은 함수를 쓴다.
import { checkIntent, tagSignalId } from '@/lib/markets/marketType';
import type { SpecSource } from '@/lib/markets/venueSpec';
import {
  precisionSkipOf, PRECISION_SKIP_TEXT, type PrecisionSkip,
} from './spotPrecisionState';
import type { GateSpotPrecision } from './gateSpotPrecision';

export interface SpotOrderArgs {
  userId: string;
  connectionId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  /** 코인 수량 */
  quantity?: number | null;
  /** USDT 금액 (시장가 매수 전용) */
  quoteOrderQty?: number | null;
  /** 지정가 */
  price?: number | null;
  /** 장부에 남길 신호 id. 표식은 이 함수가 붙인다 */
  signalId?: string;
  /** 소유 전략. 없으면 수동 주문 */
  strategyId?: string | null;
}

/**
 * **거래소 격자를 실제로 적용했는가 — 값으로 들고 나간다.**
 *
 * 왜 불린 하나로 끝내지 않는가
 * ────────────────────────────
 * "안 맞췄다"에는 서로 다른 네 가지가 있다. 사유는
 * `spotPrecisionState.ts`가 한 곳에서 판정한다 — 처음에는 여기서
 * `applied ? null : 'SPEC_UNKNOWN'`으로 뭉갰고, 그 바람에 **`source:
 * 'EXCHANGE'`인데 사유는 "규격 미상"**인 모순된 응답이 나갔다.
 */
export interface SpotVenuePrecision {
  venue: 'BINANCE_SPOT';
  /** 수량 격자를 실제로 적용했는가 */
  applied: boolean;
  /** 적용하지 않았다면 왜. 적용했으면 null */
  skipped: PrecisionSkip | null;
  /** 어디서 온 격자인가. 안 읽었으면 null */
  source: SpecSource | null;
  /** 수량·가격이 바뀌었는가 */
  changed: boolean;
  /** 사용자가 요청한 수량. 금액 기반 매수면 null */
  requestedQuantity: number | null;
  /** 실제로 보낸 수량. 금액 기반 매수면 null */
  quantity: number | null;
}

export interface SpotOrderResult {
  ok: boolean;
  status: 'FILLED' | 'REJECTED' | 'UNKNOWN' | 'BLOCKED';
  clientOrderId?: string;
  orderId?: number | string;
  filledQty?: number;
  avgPrice?: number;
  message: string;
  /** 사용자에게 보여줄 오류 코드 */
  code?: string;
  /**
   * 거래소 규격 적용 결과. 주문을 만들기 전에 막힌 경우에는 없다.
   *
   * **거래소마다 모양이 다르다.** 바이낸스는 base 수량 격자 하나를
   * 판정하고, Gate는 수량 자릿수와 가격 자릿수를 **따로** 판정한다.
   * 하나의 모양으로 뭉치면 Gate에서 한쪽 축의 실패가 사라진다.
   * `venue`가 어느 모양인지 알려준다.
   */
  venuePrecision?: SpotVenuePrecision | GateSpotPrecision;
}

const bad = (code: string, message: string): SpotOrderResult =>
  ({ ok: false, status: 'BLOCKED', code, message });

/**
 * 현물 주문을 낸다.
 *
 * 인증은 하지 않는다 — 호출자가 이미 사용자를 확정했다고 가정한다.
 * 대신 소유권(연결이 이 사용자 것인지)은 여기서 확인한다.
 */
export async function placeSpotOrder(sb: any, args: SpotOrderArgs): Promise<SpotOrderResult> {
  const symbol = String(args.symbol || '').toUpperCase().replace('/', '');
  const side = args.side;
  const type = args.type;

  if (!symbol) return bad('missing_symbol', '종목이 없습니다');
  if (side !== 'BUY' && side !== 'SELL') return bad('invalid_side', 'BUY 또는 SELL만 가능합니다');
  if (type !== 'MARKET' && type !== 'LIMIT') return bad('invalid_type', '주문 유형이 올바르지 않습니다');

  const quantity = args.quantity != null ? Number(args.quantity) : null;
  const quoteOrderQty = args.quoteOrderQty != null ? Number(args.quoteOrderQty) : null;
  const price = args.price != null ? Number(args.price) : null;

  // 현물 매도는 **보유분 청산**이다. 이 값이 격자 정책의 방향을 정한다 —
  // 아래 정규화에서 `reduceOnly`로 쓴다.
  const isSellSide = side === 'SELL';

  const byQuote = type === 'MARKET' && side === 'BUY' && quoteOrderQty != null;
  if (!byQuote && (!Number.isFinite(quantity as number) || (quantity as number) <= 0)) {
    return bad('invalid_quantity', '주문 수량이 올바르지 않습니다');
  }
  if (byQuote && (!Number.isFinite(quoteOrderQty as number) || (quoteOrderQty as number) <= 0)) {
    return bad('invalid_quote_qty', '주문 금액이 올바르지 않습니다');
  }
  if (type === 'LIMIT' && (!Number.isFinite(price as number) || (price as number) <= 0)) {
    return bad('invalid_price', '지정가가 올바르지 않습니다');
  }

  // ── 연결 소유권 ──
  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, api_key, api_secret_enc, encrypted_secret, has_withdrawal, is_testnet')
    .eq('id', args.connectionId).eq('user_id', args.userId).maybeSingle();

  if (!conn) return bad('connection_not_found', '거래소 연결을 찾을 수 없거나 본인의 연결이 아닙니다');

  const exchange = String(conn.exchange_id || '').toLowerCase();
  if (exchange !== 'binance' && exchange !== 'gate') {
    return bad('unsupported_exchange',
      `현물 주문은 바이낸스·Gate만 지원합니다 (이 연결: ${conn.exchange_id || '알 수 없음'})`);
  }
  if (conn.has_withdrawal === true) {
    return bad('withdrawal_key_blocked', '출금 권한이 있는 키는 사용할 수 없습니다');
  }

  const { decryptSecret } = await import('./crypto');
  const apiKey = conn.api_key || '';
  // 이 한 줄이 모든 호출의 목적지를 정한다. 조회·필터·주문이 같은 값을 써야
  // 한다 — 잔고는 테스트넷에서 읽고 주문은 실전으로 나가면 최악이다.
  const testnet = conn.is_testnet === true;
  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return bad('decrypt_failed', 'API 키를 복호화하지 못했습니다'); }

  // ── 여기서 거래소가 갈린다 ──
  //
  // 아래 코드는 전부 바이낸스 전용이다(잔고 통화 이름, 필터 조회, 주문 형식).
  // Gate에 억지로 끼우면 이름이 안 맞아 조용히 다른 것을 사거나, 시장가
  // 매수의 '수량'과 '금액'이 뒤바뀐다. 그래서 갈래를 따로 둔다.
  //
  // 다만 **의도 기록·소유권 확인·출금키 차단은 위에서 이미 공통으로 끝났다.**
  // 그 셋이 거래소별로 갈리면 한쪽만 지켜지는 날이 온다.
  if (exchange === 'gate') {
    return placeGateSpot(sb, args, {
      apiKey, secret, symbol, side, type,
      quantity, quoteOrderQty, price, byQuote,
      testnet: conn.is_testnet === true,
    });
  }

  const bn = await import('./binance');

  // ── 매도 전 보유 확인 ──
  // 현물에는 공매도가 없다. 보유량을 모르는 채로 보내면 거래소가 거부하거나,
  // 다른 미체결과 겹쳐 의도보다 많이 나갈 수 있다.
  let heldQty: number | null = null;
  if (side === 'SELL') {
    const base = symbol.replace(/USDT$|BUSD$|USDC$/, '');
    try {
      const balances = await bn.getBalancesBinance(apiKey, secret, testnet);
      const hit = (Array.isArray(balances) ? balances : [])
        .find(b => String(b.currency).toUpperCase() === base);
      // 미체결에 묶인 물량(locked)은 팔 수 없다. free만 센다.
      heldQty = hit ? Number(hit.free) || 0 : 0;
    } catch { heldQty = null; }
  }

  const intent = checkIntent({
    market: 'SPOT', side,
    quantity: byQuote ? 1 : (quantity as number),
    heldQty: byQuote ? undefined : heldQty,
  });
  if (!intent.ok) return bad('intent_rejected', intent.reason!);

  // ── 거래소 격자 (Phase 4B-2A) ───────────────────────────────
  //
  // 예전에는 여기서 `roundSpotQty(qty, f.stepSize)` 한 줄이었다. 그것이
  // 놓치고 있던 것이 셋이다:
  //
  //   ① **주문유형을 안 봤다.** 바이낸스 현물은 시장가에 `MARKET_LOT_SIZE`를
  //      따로 고시한다. 지정가 격자로 시장가를 깎으면 거래소가 요구하지
  //      않은 크기로 주문하게 된다
  //   ② **가격을 안 맞췄다.** 지정가는 `PRICE_FILTER.tickSize` 위에 있어야
  //      하고, 아니면 주문 자체가 거부된다. 화면이 만드는 분할 지정가는
  //      가격 구간을 균등 보간한 생 실수라 격자 위에 있을 이유가 없다
  //   ③ **최소 명목가를 안 봤다.** 수량과 최소수량을 다 통과해도 금액이
  //      모자라면 거래소가 거부한다
  //
  // 계산을 여기서 새로 쓰지 않는다 — `normalizeForVenue`가 정본이고
  // 그 안에서 `quantizeOrder`를 부른다. 정규화가 두 벌이 되면 같은 주문이
  // 경로에 따라 다른 수량으로 나간다.
  //
  // ★ **매도는 EXIT다.** 이 저장소가 이미 그렇게 판정한다
  //   (`/api/binance/spot/order`의 `intent: isSell ? 'EXIT' : 'ENTRY'`).
  //   그래서 `reduceOnly`로 넘긴다 — 규격을 못 읽었다고 **팔지 못하게**
  //   만들지 않고, 최소 명목가로 먼지 잔량을 가두지 않는다. 못 사는 것은
  //   불편이고 못 파는 것은 사고다.
  let qty = quantity;
  let orderPrice = price;
  let precision: SpotVenuePrecision;

  if (byQuote) {
    // ── ★ 금액 기반 시장가 매수에는 수량 격자를 적용하지 않는다 ──
    //
    //   이 주문은 `quoteOrderQty`(결제통화 금액)로 나간다. 수량이라는 값이
    //   아예 없다. 여기에 수량 정규화를 억지로 끼우면 `Number(null) === 0`이
    //   되어 **지금 정상 동작하는 매수가 전부 막힌다.**
    //
    //   최소 주문 금액은 거래소가 판정한다. 우리가 앞질러 막으면 지금까지
    //   나가던 주문을 새로 막는 것이고, 그건 다른 종류의 사고다.
    precision = {
      venue: 'BINANCE_SPOT', applied: false,
      skipped: precisionSkipOf({ byQuote: true, applied: false, source: null, code: null }),
      source: null, changed: false, requestedQuantity: null, quantity: null,
    };
  } else {
    const { normalizeForVenue } = await import('@/lib/markets/venueSpec');
    const { fetchVenueSpec } = await import('@/lib/markets/venueSpecSource');

    const spec = await fetchVenueSpec('BINANCE_SPOT', symbol, testnet);

    // 시장가의 최소 명목가는 **서버가 읽은 가격**으로 검사한다. 화면이 보낸
    // 값을 쓰면 검사가 검사 대상에게 값을 물어보는 꼴이 된다. 지정가는
    // 사용자가 정한 가격이 곧 체결가라 그대로 쓰므로 읽지 않는다.
    // 매도(EXIT)에는 최소 명목가를 적용하지 않으므로 역시 읽지 않는다 —
    // 필요 없는 호출을 하지 않는다.
    const needsRef = !isSellSide && type !== 'LIMIT' && Number(spec.minNotional) > 0;
    const referencePrice = needsRef ? await bn.getSpotPrice(symbol, testnet) : null;

    const norm = normalizeForVenue({
      spec,
      quantity: qty as number,
      price: type === 'LIMIT' ? price : null,
      orderType: type,
      reduceOnly: isSellSide,
      referencePrice,
    });

    if (!norm.ok) {
      return { ...bad(norm.code || 'invalid_quantity', norm.reason), venuePrecision: {
        venue: 'BINANCE_SPOT', applied: norm.applied,
        skipped: precisionSkipOf({
          byQuote: false, applied: norm.applied, source: norm.source, code: norm.code,
        }),
        source: norm.source, changed: norm.changed,
        requestedQuantity: qty, quantity: null,
      } };
    }

    qty = norm.quantity;
    if (type === 'LIMIT' && norm.price != null) orderPrice = norm.price;
    precision = {
      venue: 'BINANCE_SPOT', applied: norm.applied,
      skipped: precisionSkipOf({
        byQuote: false, applied: norm.applied, source: norm.source, code: norm.code,
      }),
      source: norm.source, changed: norm.changed,
      requestedQuantity: quantity, quantity: qty,
    };
  }

  /**
   * 격자에 대해 사용자에게 덧붙일 한 줄. 할 말이 없으면 빈 문자열.
   *
   * **말없이 크기를 줄이지 않는다.** 100%를 눌렀는데 잔고가 남는 이유가
   * 화면 어디에도 없으면, 사용자는 그것을 고장으로 읽는다.
   */
  const precisionNote = (() => {
    // 사유 문장은 `spotPrecisionState`가 갖는다. 여기서 다시 쓰면 사유가
    // 늘 때마다 두 곳을 고쳐야 하고, 언젠가 한쪽만 고쳐진다.
    //
    // **금액 주문은 말하지 않는다.** 그건 고장이 아니라 그 주문의 성질이고,
    // 매번 경고처럼 띄우면 사용자는 곧 전부 무시한다.
    if (precision.skipped != null && precision.skipped !== 'QUOTE_ORDER') {
      return ` · ${PRECISION_SKIP_TEXT[precision.skipped]}`;
    }
    if (!precision.changed) return '';
    const parts: string[] = [];
    if (precision.quantity !== precision.requestedQuantity) {
      parts.push(`수량 ${precision.requestedQuantity} → ${precision.quantity}`);
    }
    if (orderPrice !== price) parts.push(`가격 ${price} → ${orderPrice}`);
    return parts.length ? ` · 거래소 단위에 맞춰 조정했습니다 (${parts.join(' · ')})` : '';
  })();

  // ── 의도를 먼저 기록 ──
  const clientOrderId = `SP${Date.now().toString(36).toUpperCase()}${symbol}`.slice(0, 36);
  let signalId = tagSignalId(String(args.signalId || 'manual-spot'), 'SPOT');
  if (args.strategyId) {
    const { tagStrategy } = await import('@/lib/strategies/ledger');
    signalId = tagStrategy(signalId, args.strategyId);
  }

  const intentRow: Record<string, any> = {
    client_order_id: clientOrderId,
    signal_id: signalId,
    user_id: args.userId,
    connection_id: args.connectionId,
    exchange: 'binance',
    // 테스트넷 주문을 LIVE로 적으면 성과 집계·손실 한도가 가짜 체결을 실전으로 센다.
    mode: testnet ? 'TESTNET' : 'LIVE',
    symbol, side, order_type: type,
    // **실제로 보낼 값을 적는다.** 격자에 맞추기 전 값을 적으면 장부와
    // 거래소가 다른 주문을 기록하게 되고, 나중에 대조가 안 맞는다.
    quantity: byQuote ? 0 : (qty as number),
    price: type === 'LIMIT' ? orderPrice : null,
    status: 'INTENT',
    market_type: 'SPOT',
  };

  const insert = (row: Record<string, any>) =>
    sb.from('live_orders').insert(row).select('id').single();

  let res = await insert(intentRow);
  if (res.error) {
    // market_type 컬럼이 아직 없는 DB — 그 필드만 빼고 다시 넣는다.
    // 유형 표식은 signal_id에 이미 들어 있다.
    const { market_type: _drop, ...legacy } = intentRow;
    res = await insert(legacy);
  }
  if (res.error) {
    return bad('intent_log_failed', `주문 기록 실패: ${res.error.message}`);
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

  let r: any;
  try {
    r = await bn.placeOrderBinance(apiKey, secret, {
      symbol, side, type,
      quantity: byQuote ? undefined : (qty as number),
      quoteOrderQty: byQuote ? (quoteOrderQty as number) : undefined,
      // 격자에 맞춘 가격을 보낸다. 원값을 보내면 PRICE_FILTER에 걸려
      // 거래소가 통째로 거부한다.
      price: type === 'LIMIT' ? (orderPrice as number) : undefined,
      // 이 값을 거래소에 보내지 않으면 UNKNOWN 복구가 주문을 찾을 수 없다.
      // 지금까지 DB에만 적고 거래소에는 안 보내고 있었다.
      clientOrderId,
      testnet,
    });
  } catch (e: any) {
    // 응답을 못 받았다. 나갔는지 안 나갔는지 모른다 — 재시도하지 않는다.
    await patch({ status: 'UNKNOWN', error_message: `응답 없음: ${e?.message || e}` });
    return {
      ok: false, status: 'UNKNOWN', clientOrderId, venuePrecision: precision,
      message: '주문 전송 후 응답을 받지 못했습니다. 재시도하지 말고 현물 내역을 확인하세요.',
    };
  }

  if (!r?.success) {
    await patch({ status: 'REJECTED', error_message: r?.message });
    return { ok: false, status: 'REJECTED', clientOrderId, code: 'order_rejected',
      venuePrecision: precision, message: r?.message || '거래소가 거부했습니다' };
  }

  await patch({
    status: 'FILLED',
    exchange_order_id: String(r.orderId ?? ''),
    filled_qty: r.qty ?? null,
    avg_price: r.price ?? null,
    acked_at: new Date().toISOString(),
  });

  return {
    ok: true, status: 'FILLED', clientOrderId,
    orderId: r.orderId, filledQty: r.qty, avgPrice: r.price,
    venuePrecision: precision,
    message: `현물 ${side === 'BUY' ? '매수' : '매도'} 체결` + precisionNote,
  };
}

/**
 * Gate 현물.
 *
 * 바이낸스 갈래와 **같은 순서**를 지킨다: 매도 전 보유 확인 → 중복 확인 →
 * 의도 기록 → 전송 → 결과 기록. 순서가 다르면 한쪽에만 있는 안전장치가
 * 생기고, 그건 언젠가 "Gate에서만 두 번 나갔다"가 된다.
 *
 * 다른 점은 셋뿐이다:
 *   · 종목 이름이 `BTC_USDT`
 *   · 시장가 매수의 amount가 **금액**이다
 *   · 보내기 전에 표식으로 중복을 한 번 더 확인한다 (Gate에는 바이낸스의
 *     clientOrderId 멱등성이 없다)
 */
async function placeGateSpot(
  sb: any,
  args: SpotOrderArgs,
  ctx: {
    apiKey: string; secret: string; symbol: string;
    side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT';
    quantity: number | null; quoteOrderQty: number | null; price: number | null;
    byQuote: boolean; testnet: boolean;
  },
): Promise<SpotOrderResult> {
  const gs = await import('./gateSpot');
  const { toGatePair } = await import('./gateSpotPlan');
  const { checkIntent, tagSignalId } = await import('@/lib/markets/marketType');

  const p = toGatePair(ctx.symbol);
  if (!p) {
    return bad('bad_symbol',
      `종목 '${ctx.symbol}'을 Gate 이름으로 바꾸지 못했습니다 (예: BTC_USDT)`);
  }

  // ── 매도 전 보유 확인 ──
  // 현물에는 공매도가 없다. 조회에 실패하면 null이다 — 0으로 두면
  // '보유 없음'이 되어 checkIntent가 막아 버리고, 실제로는 있는데 못 판다.
  let heldQty: number | null = null;
  if (ctx.side === 'SELL') {
    try {
      const balances = await gs.getGateSpotBalances(ctx.apiKey, ctx.secret, ctx.testnet);
      const hit = balances.find(b => b.currency === p.base);
      heldQty = hit ? hit.free : 0;   // 목록을 받았는데 없으면 진짜 0이다
    } catch { heldQty = null; }
  }

  const intent = checkIntent({
    market: 'SPOT', side: ctx.side,
    quantity: ctx.byQuote ? 1 : (ctx.quantity as number),
    heldQty: ctx.byQuote ? undefined : heldQty,
  });
  if (!intent.ok) return bad('intent_rejected', intent.reason!);

  // ── 의도를 먼저 기록 ──
  const clientOrderId = `GS${Date.now().toString(36).toUpperCase()}${p.base}`.slice(0, 36);
  let signalId = tagSignalId(String(args.signalId || 'manual-spot'), 'SPOT');
  if (args.strategyId) {
    const { tagStrategy } = await import('@/lib/strategies/ledger');
    signalId = tagStrategy(signalId, args.strategyId);
  }

  const intentRow: Record<string, any> = {
    client_order_id: clientOrderId,
    signal_id: signalId,
    user_id: args.userId,
    connection_id: args.connectionId,
    exchange: 'gate',
    mode: ctx.testnet ? 'TESTNET' : 'LIVE',
    symbol: p.pair,
    side: ctx.side, order_type: ctx.type,
    quantity: ctx.byQuote ? 0 : (ctx.quantity as number),
    price: ctx.type === 'LIMIT' ? ctx.price : null,
    status: 'INTENT',
    market_type: 'SPOT',
  };

  const insert = (row: Record<string, any>) =>
    sb.from('live_orders').insert(row).select('id').single();
  let res = await insert(intentRow);
  if (res.error) {
    const { market_type: _drop, ...legacy } = intentRow;
    res = await insert(legacy);
  }
  if (res.error) return bad('intent_log_failed', `주문 기록 실패: ${res.error.message}`);
  const rowId = res.data?.id ?? null;

  const patch = async (pp: Record<string, any>) => {
    if (!rowId) return;
    try {
      await sb.from('live_orders')
        .update({ ...pp, updated_at: new Date().toISOString() }).eq('id', rowId);
    } catch { /* 기록 실패가 주문 결과를 바꾸지 않는다 */ }
  };

  // ── 중복 확인 ──
  // Gate에는 바이낸스처럼 clientOrderId로 중복을 막아 주는 장치가 없다.
  // 그래서 보내기 전에 같은 표식의 주문이 이미 있는지 본다.
  //
  // **조회에 실패하면 보내지 않는다.** '없음'으로 읽고 보내면, 한도 초과가
  // 난 순간 같은 주문이 두 번 나간다. 선물 경로에서 같은 이유로 같은 결정을 했다.
  const dup = await gs.findGateSpotOrderByText(
    ctx.apiKey, ctx.secret, p.pair, clientOrderId, ctx.testnet);
  if (!dup.ok) {
    await patch({ status: 'FAILED', error_message: `중복 확인 실패: ${dup.error}` });
    return {
      ok: false, status: 'BLOCKED', clientOrderId, code: 'dup_check_failed',
      message: `중복 주문 확인에 실패해 보내지 않았습니다 (${dup.error}). 잠시 후 다시 시도하세요.`,
    };
  }
  if (dup.order) {
    await patch({ status: 'RECONCILED', exchange_order_id: String(dup.order?.id ?? '') });
    return {
      ok: false, status: 'REJECTED', clientOrderId, code: 'duplicate',
      message: '같은 표식의 주문이 이미 거래소에 있습니다',
    };
  }

  await patch({ status: 'SENT', sent_at: new Date().toISOString() });

  let r: Awaited<ReturnType<typeof gs.placeGateSpotOrder>>;
  try {
    r = await gs.placeGateSpotOrder(ctx.apiKey, ctx.secret, {
      symbol: p.pair, side: ctx.side, type: ctx.type,
      quantity: ctx.byQuote ? null : ctx.quantity,
      quoteAmount: ctx.byQuote ? ctx.quoteOrderQty : null,
      price: ctx.type === 'LIMIT' ? ctx.price : null,
      // **현물 매도는 청산이다.** 규격을 못 읽었을 때 진입은 막고 매도는
      // 보낸다 — 이 라우트가 이미 `intent: isSell ? 'EXIT' : 'ENTRY'`로
      // 같은 판단을 한다. 못 사는 것은 불편이고 못 파는 것은 사고다.
      isExit: ctx.side === 'SELL',
      clientOrderId,
    }, ctx.testnet);
  } catch (e: any) {
    // 응답을 못 받았다. 나갔는지 안 나갔는지 **모른다** — 재시도하지 않는다.
    await patch({ status: 'UNKNOWN', error_message: `응답 없음: ${e?.message || e}` });
    return {
      ok: false, status: 'UNKNOWN', clientOrderId,
      message: '주문 전송 후 응답을 받지 못했습니다. 재시도하지 말고 Gate 현물 내역을 확인하세요.',
    };
  }

  if (!r.success) {
    await patch({ status: 'REJECTED', error_message: r.message });
    return { ok: false, status: 'REJECTED', clientOrderId, code: 'order_rejected', message: r.message };
  }

  await patch({
    status: 'FILLED',
    exchange_order_id: String(r.orderId ?? ''),
    // 체결량을 모르면 null로 둔다. 0으로 적으면 '한 개도 안 붙었다'가 되고,
    // 나중에 이 장부로 성과를 세면 그 거래가 통째로 사라진다.
    filled_qty: r.filledQty ?? null,
    avg_price: r.avgPrice ?? null,
    acked_at: new Date().toISOString(),
  });

  return {
    ok: true,
    // IOC가 하나도 안 붙고 취소됐으면 그건 체결이 아니다.
    status: r.unfilled ? 'REJECTED' : 'FILLED',
    venuePrecision: r.precision,
    clientOrderId,
    orderId: r.orderId,
    filledQty: r.filledQty ?? undefined,
    avgPrice: r.avgPrice ?? undefined,
    message: r.unfilled
      ? r.message
      : `Gate 현물 ${ctx.side === 'BUY' ? '매수' : '매도'} — ${r.message}`
        + (r.filledQty == null ? ' (체결 수량은 거래 내역에서 확인하세요)' : ''),
  };
}
