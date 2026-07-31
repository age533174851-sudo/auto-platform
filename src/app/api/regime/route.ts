// /api/regime — 현재 시장 상태(레짐) 판별 + 진입 게이트 판정
//
// **주문 게이트와 같은 봉을 본다.**
//
// 예전에는 이 라우트가 1시간봉을 썼고, 진입 게이트(regimeGate)는 일봉을
// 쓴다. 그러면 화면에는 '상승 추세'가 떠 있는데 주문은 '하락 추세라 차단'으로
// 막히는 일이 생긴다 — 사용자는 무엇이 맞는지 알 방법이 없다.
// 판정이 두 곳으로 갈리는 것을 이 프로젝트에서 여러 번 겪었다.
//
// `side`를 주면 그 방향으로 지금 들어갈 수 있는지(게이트 결과)까지 돌려준다.
import { NextRequest, NextResponse } from 'next/server';
import { detectRegime } from '@/lib/risk/regime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
  try {
    // 일봉. 게이트가 보는 것과 같아야 한다 (위 주석).
    const { fetchDailyCloses, collectRegime } = await import('@/lib/risk/regimeCheck');
    const closes = await fetchDailyCloses(symbol, 120);
    if (!closes) return NextResponse.json({ error: 'fetch_failed', regime: null });

    const regime = detectRegime(closes);
    // 봉이 모자라면 detectRegime이 dataOk:false를 준다. 그걸 '횡보'로
    // 그리지 않도록 그대로 내보낸다.

    // 방향을 주면 게이트 판정까지. 안 주면 국면만.
    const sideRaw = String(req.nextUrl.searchParams.get('side') || '').toUpperCase();
    const side = sideRaw === 'SHORT' ? 'SHORT' : sideRaw === 'LONG' ? 'LONG' : null;
    const gate = side
      ? await collectRegime({ symbol, side, closes })
      : null;
    let recommendedStrategy = '';
    if (regime.volatility === 'high_vol') recommendedStrategy = '관망 / 포지션 축소';
    else if (regime.trend === 'uptrend') recommendedStrategy = '추세추종 (EMA/MACD)';
    else if (regime.trend === 'downtrend') recommendedStrategy = '숏 또는 관망';
    else recommendedStrategy = '반전매매 (RSI/볼린저)';

    return NextResponse.json({
      symbol, regime, recommendedStrategy, source: 'binance', interval: '1d', at: Date.now(),
      gate: gate ? {
        status: gate.verdict.status,
        blockEntries: gate.verdict.blockEntries,
        reason: gate.verdict.reason,
        mode: gate.mode, enabled: gate.enabled, note: gate.note,
      } : null,
    },
      { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'error', regime: null });
  }
}
