// GET /api/market/candles — 차트가 그릴 봉
//
// **새 가격 권위를 만들지 않는다.**
// ────────────────────────────────
// 여기서 하는 일은 `fetchVenueBars()`를 부르고 결과를 그대로 넘기는 것뿐이다.
// 보간도, 채우기도, 평활화도 없다. venue가 준 봉이 곧 응답이다.
//
// 왜 서버를 거치나
// ────────────────
// 브라우저에서 바이낸스를 직접 부르면 시장마다 주소가 갈리고(현물 api ·
// 선물 fapi), 그 분기가 화면에 또 생긴다. `fetchVenueBars`가 이미 그
// 판단을 갖고 있으므로 그것을 그대로 쓴다 — 같은 판단을 두 곳에 두지 않는다.
//
// 진행 중인 봉을 남긴다
// ─────────────────────
// 판정 경로는 미완성 봉을 잘라야 하지만(아직 움직이는 값으로 손절 도달을
// 적으면 안 된다), **차트는 그 봉이 있어야 한다.** 안 그리면 차트가 늘 한
// 칸 뒤처지고, 그 빈자리를 화면이 스스로 채우기 시작하면 그때부터 우리가
// 봉을 지어내는 것이다. 그래서 `keepIncomplete: true`로 받고, 그 봉이
// 미완성이라는 사실을 응답에 적는다.
import { NextRequest, NextResponse } from 'next/server';
import { fetchVenueBars, intervalMs } from '@/lib/markets/venueBars';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 화면이 고를 수 있는 간격. **여기 없는 값은 받지 않는다** — 추측해서 자르지 않는다. */
const INTERVALS = ['1m', '15m', '1h', '4h', '1d'] as const;

/** 한 번에 줄 수 있는 봉 수. 지표(EMA 26)가 그려질 만큼은 되어야 한다. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 300;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const symbol = String(q.get('symbol') || '').toUpperCase().replace('/', '');
  const interval = String(q.get('interval') || '');
  const market = String(q.get('market') || 'USDM').toUpperCase();

  if (!symbol) {
    return NextResponse.json({ ok: false, error: 'missing_symbol' }, { status: 400 });
  }
  if ((INTERVALS as readonly string[]).indexOf(interval) < 0) {
    // 모르는 간격을 기본값으로 바꾸지 않는다. 바꾸면 화면은 1시간을
    // 골랐는데 1분 봉을 받고, 축이 그럴듯해서 아무도 못 본다.
    return NextResponse.json({
      ok: false, error: 'unsupported_interval',
      message: `지원하지 않는 간격입니다 (${interval || '없음'})`,
    }, { status: 400 });
  }
  if (market !== 'SPOT' && market !== 'USDM') {
    return NextResponse.json({
      ok: false, error: 'unsupported_market',
      message: `지원하지 않는 시장입니다 (${market})`,
    }, { status: 400 });
  }

  const rawLimit = Number(q.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(MAX_LIMIT, Math.floor(rawLimit)) : DEFAULT_LIMIT;

  try {
    const r = await fetchVenueBars({
      exchange: 'binance',
      symbol,
      interval,
      limit,
      // ★ **시장을 끝까지 들고 간다.**
      // 예전에는 위에서 `market`을 검사하고 응답에 적기까지 했으면서
      // 여기로는 넘기지 않았다. `fetchVenueBars`의 바이낸스 경로는 fapi
      // 전용이라, 현물 화면이 **선물 봉을 현물이라고 적어서** 받았다.
      market: market as 'SPOT' | 'USDM',
      // 실전 시세를 본다. 모의 주문도 실제 시장을 보고 연습해야 뜻이 있다.
      testnet: false,
      // ★ 차트는 진행 중인 봉이 필요하다 (머리말 참고)
      keepIncomplete: true,
    });

    if (!r.bars) {
      // **빈 배열을 "봉이 없다"로 적지 않는다.** 못 받은 것과 없는 것은 다르다.
      return NextResponse.json({
        ok: false, error: 'bars_unavailable',
        message: `봉을 받지 못했습니다 (${String(r.error ?? '').slice(0, 120)})`
          + ' — 봉이 없다는 뜻이 아닙니다',
        source: r.source,
      }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }

    return NextResponse.json({
      ok: true,
      symbol, interval, market,
      // 어디서 읽었는지 적는다. 적어 두지 않으면 나중에 "이 차트가 어느
      // 시장 가격인가"를 화면에서 확인할 방법이 없다.
      source: r.source,
      intervalMs: intervalMs(interval),
      bars: r.bars,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({
      ok: false, error: 'bars_failed',
      message: `봉을 받지 못했습니다 — ${String(e?.message || e).slice(0, 160)}`,
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
