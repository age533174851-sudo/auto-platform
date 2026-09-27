// GET /api/market/instruments?market=SPOT|USDM
//
// **거래소가 상장했다고 말한 것만 돌려준다.**
//
// 왜 서버를 거치나
// ────────────────
// 브라우저에서 바이낸스를 직접 부르면 시장마다 주소가 갈리고(현물 `api` ·
// 선물 `fapi`) 그 분기가 화면에 또 생긴다. 그리고 `exchangeInfo`는 응답이
// 크다 — 걸러 내는 일을 서버에서 한 번 하면 화면이 받는 양이 줄어든다.
//
// ★ 실패를 빈 목록으로 돌려주지 않는다
// ────────────────────────────────────
// 조회가 실패했을 때 `instruments: []`를 `ok: true`로 주면 화면은
// **"이 시장에 종목이 없다"**로 그린다. 그건 거짓이다. 실패는 `ok: false`와
// 사유로 나가고, 화면은 그 사유를 적고 다시 시도할 수 있게 한다.
import { NextRequest, NextResponse } from 'next/server';
import { parseCatalogFor, catalogOpenFor } from '@/lib/trading/instrumentCatalog';
import { readMarketTab } from '@/lib/trading/marketTabs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 시장 → 공개 조회 주소. **여기 없는 시장은 조회하지 않는다** */
const ENDPOINT: Record<string, string> = {
  SPOT: 'https://api.binance.com/api/v3/exchangeInfo',
  USDM: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
};

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('market');
  const market = readMarketTab(raw);
  if (!market) {
    // 모르는 값을 현물로 떨어뜨리지 않는다 — 선물 목록을 달라고 했는데
    // 현물 목록을 받으면 화면은 그것을 선물 종목으로 읽는다.
    return NextResponse.json({
      ok: false, error: 'unknown_market',
      message: `모르는 시장입니다 (${String(raw ?? '없음')})`,
    }, { status: 400 });
  }

  const open = catalogOpenFor(market);
  if (!open.open) {
    return NextResponse.json({
      ok: false, error: 'catalog_not_open', market, message: open.reason,
    }, { status: 409 });
  }

  const url = ENDPOINT[market];
  if (!url) {
    return NextResponse.json({
      ok: false, error: 'no_endpoint', market,
      message: `${market} 목록 조회 주소가 없습니다`,
    }, { status: 409 });
  }

  const asOf = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000), cache: 'no-store' });
    if (!r.ok) {
      return NextResponse.json({
        ok: false, error: 'upstream_http', market, status: r.status,
        message: `거래소 종목 목록 조회가 실패했습니다 (HTTP ${r.status})`,
      }, { status: 502 });
    }
    const payload = await r.json();
    const instruments = parseCatalogFor(market, payload, asOf);
    if (instruments.length === 0) {
      // 응답은 왔는데 통과한 줄이 하나도 없다. **정상 0건으로 적지 않는다** —
      // 거래소 응답 모양이 바뀐 경우가 여기로 온다.
      return NextResponse.json({
        ok: false, error: 'empty_catalog', market, asOf,
        message: `${market} 목록을 받았지만 거래 가능한 종목이 하나도 없습니다 — `
          + '응답 모양이 바뀌었을 수 있습니다',
      }, { status: 502 });
    }
    return NextResponse.json({ ok: true, market, asOf, count: instruments.length, instruments });
  } catch (e: any) {
    return NextResponse.json({
      ok: false, error: 'fetch_failed', market,
      message: `거래소 종목 목록을 읽지 못했습니다 (${String(e?.message || e).slice(0, 140)})`,
    }, { status: 502 });
  }
}
