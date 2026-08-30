// /api/binance/futures/quote — **주문이 나갈 그 거래소의 선물 가격.**
//
// ⚠ 경로 이름은 `binance`지만 바이낸스 전용이 아니다. Gate 연결도 여기로
//   온다 — 거래소는 `connectionId`가 정한다. 주문·계좌 라우트와 같은 규칙이다.
//
// 왜 필요한가
// ───────────
// 실전·테스트넷 주문 수량은 이렇게 만든다:
//
//   qty = notionalUsdt / price
//
// 그 `price`가 **주문이 나갈 곳의 가격이 아니면** 수량이 어긋난다.
// 화면이 쓰던 `/api/prices`의 값은 `api.binance.com`의 **현물** 티커다.
// 그래서 Gate 연결로 주문해도 바이낸스 현물 가격으로 수량을 만들고 있었다 —
// 환율을 없애고 그 자리에 **다른 거래소의 다른 시장 가격**을 넣은 셈이다.
//
// 현물과 선물은 같은 종목이라도 값이 다르고(베이시스), 거래소끼리도 다르다.
// 그래서 연결이 정한 곳에서 읽는다:
//
//   Binance Futures  getPremiumIndex()      → markPrice
//   Gate Futures     getTickerGateFutures() → mark_price, 없으면 last
//
// 환경도 연결이 정한다. 테스트넷 연결은 테스트넷 호스트에서 읽는다 —
// 실전 가격으로 테스트넷 수량을 만들면 두 장부가 서로 다른 사실을 본다.
//
// 못 읽으면 값을 지어내지 않는다
// ──────────────────────────────
// 다른 거래소로 대신 읽지 않고, 현물로 내려가지 않고, 환율로 만들지 않는다.
// `price: null`을 주고 화면이 주문을 막는다. **가격을 모르는 것은 수량을
// 만들 수 없다는 뜻이다.**
//
// 읽기만 한다. 주문을 내지 않는다.

import { NextRequest, NextResponse } from 'next/server';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const num = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const connectionId = req.nextUrl.searchParams.get('connectionId') || '';
  const symbol = String(req.nextUrl.searchParams.get('symbol') || '').toUpperCase().replace('/', '');
  if (!symbol) return NextResponse.json({ error: 'missing_symbol' }, { status: 400 });

  // 거래소·환경은 **연결이 정한다.** 화면이 고른 값을 믿지 않는다.
  const creds = await loadFuturesCreds(sb, uid, connectionId);
  if (!creds.ok) {
    return NextResponse.json({ error: creds.error, message: (creds as any).message ?? null },
      { status: creds.status });
  }

  let price: number | null = null;
  let priceSource: string | null = null;
  let error: string | null = null;

  try {
    if (creds.exchange === 'gate') {
      const { getTickerGateFutures } = await import('@/lib/exchanges/gateFutures');
      const { toGateContract } = await import('@/lib/exchanges/gatePlan');
      const t = await getTickerGateFutures(toGateContract(symbol), creds.testnet);
      // 마크가를 먼저 본다. 없으면 최종가 — **둘 다 없으면 없는 것이다.**
      price = num(t?.mark_price) ?? num(t?.last);
      priceSource = price == null ? null : (num(t?.mark_price) != null ? 'gate_mark' : 'gate_last');
    } else {
      const { getPremiumIndex } = await import('@/lib/exchanges/binanceFutures');
      const p = await getPremiumIndex(symbol, creds.testnet);
      price = num(p?.markPrice);
      priceSource = price == null ? null : 'binance_mark';
    }
  } catch (e: any) {
    error = String(e?.message || e).slice(0, 200);
  }

  return NextResponse.json({
    ok: price != null,
    price,
    quoteCurrency: price != null ? 'USDT' : null,
    exchange: creds.exchange,
    testnet: creds.testnet,
    priceSource,
    asOf: new Date().toISOString(),
    // **다른 거래소로 대신 읽지 않는다.** 못 읽었으면 그렇다고만 말한다.
    error,
    note: price == null
      ? '이 연결의 선물 가격을 읽지 못했습니다 — 다른 거래소·현물·환율로 대신 계산하지 않습니다'
      : null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
