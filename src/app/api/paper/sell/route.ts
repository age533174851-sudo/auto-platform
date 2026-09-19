// /api/paper/sell — 모의 현물 보유분 매도
// POST { symbol, percent? | quantity?, clientSellId, challengeId? }
//
// **이 라우트는 돈을 한 푼도 계산하지 않는다.**
// ────────────────────────────────────────────
// 손익·수수료·비례 배분·남은 수량은 전부 `paper_sell_holding`(088)이
// NUMERIC으로 만든다. 예전 청산 경로는 JS가 계산해 RPC에 넘겼고, 그 구조에서는
// 25%+25%+100%와 100% 1회가 double 오차만큼 달랐다 — 그 차이가 lot에 dust로
// 남으면 영원히 안 풀리는 잔량이 된다.
//
// 여기서 하는 일은 셋뿐이다.
//   ① 누구인지 · 어느 장부인지 정한다 (요청 본문에서 계좌를 받지 않는다)
//   ② 청산가를 **서버가 읽는다** (진입·청산과 같은 `readPaperMarkPrice`)
//   ③ RPC를 부르고 결과를 그대로 옮긴다
//
// 재시도
// ──────
// `clientSellId`를 재시도 때 **그대로** 보내면 두 번 팔리지 않는다.
//   같은 id + 같은 내용 → REPLAYED (처음 결과를 그대로 준다)
//   같은 id + 다른 내용 → CONFLICT 409 (아무것도 안 움직인다)
// 화면이 id를 새로 만들면 그건 새 매도다 — 그게 맞다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 편도 수수료. 진입(`paperPlan`)과 같은 기본값이다.
const FEE_RATE_PCT = 0.05;

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const symbol = String(body?.symbol || '').toUpperCase().replace('/', '');
  const clientSellId = String(body?.clientSellId || '').trim();
  if (!symbol || !clientSellId) {
    return NextResponse.json({ ok: false, error: 'missing_params' }, { status: 400 });
  }

  // 비율과 수량 중 **정확히 하나**다. 판단은 `paperSellRequest` 한 곳에 있고
  // 시험이 거기 붙어 있다 — 라우트 안에 적으면 시험을 붙일 수 없다.
  const { sellAmountOf, sellAmountFailed } = await import('@/lib/engine/paperSellRequest');
  const amount = sellAmountOf(body);
  if (sellAmountFailed(amount)) {
    return NextResponse.json({
      ok: false,
      error: amount.code === 'AMBIGUOUS' ? 'ambiguous_amount'
           : amount.code === 'BAD_PERCENT' ? 'bad_percent' : 'bad_quantity',
      message: amount.reason,
    }, { status: 400 });
  }
  const percent = amount.percent;
  const quantity = amount.quantity;

  // ── 어느 장부인가. **계좌 id를 받지 않는다** ──
  const { resolveHoldingScope, holdingScopeFailed } =
    await import('@/lib/engine/paperHoldingScope');
  const scope = await resolveHoldingScope(sb, uid, body?.challengeId);
  if (holdingScopeFailed(scope)) {
    return NextResponse.json({
      ok: false,
      error: scope.code === 'UNREADABLE' ? 'scope_unreadable' : 'challenge_not_found',
      message: scope.reason,
    }, { status: scope.status, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 청산가는 서버가 읽는다 ──
  //
  // 화면이 보낸 가격을 쓰면 유리한 값으로 팔아 장부를 만들 수 있다.
  // **진입·청산과 같은 함수**다 — 시장별 출처가 한 파일에만 있다.
  const { readPaperMarkPrice, paperPriceFailed } =
    await import('@/lib/engine/paperPriceSource');
  const px = await readPaperMarkPrice('SPOT', symbol);
  if (paperPriceFailed(px)) {
    return NextResponse.json({
      ok: false, error: px.code === 'UNSUPPORTED_MARKET' ? 'unsupported_market' : 'no_price',
      message: px.code === 'UNSUPPORTED_MARKET'
        ? px.reason
        : '시세를 확인하지 못해 매도하지 않았습니다. 잠시 후 다시 시도하세요.',
    }, { status: px.code === 'UNSUPPORTED_MARKET' ? 400 : 502,
         headers: { 'Cache-Control': 'no-store' } });
  }

  const { paperEventTimeNow } = await import('@/lib/engine/paperEventTime');

  let row: any = null;
  try {
    // 생성된 Supabase 타입에는 이 함수가 없다(088이 새로 만든다). 챌린지
    // 라우트들과 같은 자리·같은 이유다.
    const { data, error } = await (sb as any).rpc('paper_sell_holding', {
      p_user: uid,
      p_paper_account_id: scope.accountId,
      p_market: 'SPOT',
      p_symbol: symbol,
      p_percent: percent,
      p_quantity: quantity,
      p_exit_price: px.price,
      p_fee_rate: FEE_RATE_PCT / 100,
      p_client_sell_id: clientSellId,
      // 진입·청산과 같은 자리에서 만든다. 없으면 아무것도 팔지 않는다.
      p_event_effective_at: paperEventTimeNow(),
    });
    if (error) throw new Error(String((error as any).message ?? error));
    row = Array.isArray(data) ? data[0] : data;
  } catch (e: any) {
    // **실패를 성공으로 적지 않는다.** 트랜잭션이 통째로 되돌아갔으므로
    // 보유는 그대로다.
    return NextResponse.json({
      ok: false, error: 'sell_failed',
      message: `매도를 기록하지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`,
    }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  if (!row) {
    return NextResponse.json({
      ok: false, error: 'sell_failed',
      message: '매도를 기록하지 못했습니다: 결과를 받지 못했습니다',
    }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  const status = String(row.out_status || '');

  // 거부는 **거부라고 말한다.** 200에 빈 값을 실어 보내면 화면이 성공으로 읽는다.
  const REJECT: Record<string, { http: number; error: string; message: string }> = {
    NO_ACCOUNT:           { http: 404, error: 'account_not_found',
                            message: '모의 계좌를 찾지 못했습니다' },
    NO_HOLDING:           { http: 409, error: 'no_holding',
                            message: '보유한 수량이 없습니다' },
    INSUFFICIENT_HOLDING: { http: 409, error: 'insufficient_holding',
                            message: '보유한 수량보다 많이 팔 수 없습니다' },
    NOT_SPOT:             { http: 400, error: 'not_spot',
                            message: '이 경로로는 현물 보유분만 팔 수 있습니다' },
    UNREADABLE_LOT:       { http: 503, error: 'lot_unreadable',
                            message: '보유 원가를 읽지 못해 매도하지 않았습니다 — 보유가 없다는 뜻이 아닙니다' },
    CONFLICT:             { http: 409, error: 'sell_id_conflict',
                            message: '같은 매도 식별자로 다른 주문이 이미 처리됐습니다' },
  };
  const rej = REJECT[status];
  if (rej) {
    return NextResponse.json({
      ok: false, error: rej.error, message: rej.message, status,
    }, { status: rej.http, headers: { 'Cache-Control': 'no-store' } });
  }
  if (status !== 'SOLD' && status !== 'REPLAYED') {
    return NextResponse.json({
      ok: false, error: 'sell_failed', message: `알 수 없는 매도 결과 (${status || '없음'})`,
    }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json({
    ok: true, paper: true,
    // 재시도였는지 화면이 알 수 있게. 값으로 들고 다닌다.
    status,
    replayed: status === 'REPLAYED',
    challengeId: scope.challengeId,
    symbol, market: 'SPOT',
    exitPrice: px.price, priceSource: px.source,
    soldQuantity: row.out_sold_qty == null ? null : Number(row.out_sold_qty),
    grossPnl: row.out_gross == null ? null : Number(row.out_gross),
    exitFee: row.out_exit_fee == null ? null : Number(row.out_exit_fee),
    realizedPnl: row.out_realized == null ? null : Number(row.out_realized),
    remainingQuantity: row.out_remaining == null ? null : Number(row.out_remaining),
    lotsTouched: row.out_lots == null ? null : Number(row.out_lots),
    message: status === 'REPLAYED'
      ? '같은 매도가 이미 처리돼 있습니다 (다시 팔지 않았습니다)'
      : `모의 매도 체결 — ${symbol} (거래소로 나가지 않았습니다)`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
