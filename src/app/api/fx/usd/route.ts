// GET /api/fx/usd — USD 기준 환율
//
// **폴백 상수를 두지 않는다.**
//
// `src/lib/currency.ts`는 환율을 못 읽으면 `FALLBACK_USDKRW = 1375`를
// 썼다. 그 값이 언제 것인지는 아무도 모르고, 화면에는 그냥 원화 금액으로
// 보인다 — 못 읽었다는 표시가 없다.
//
// 여기서는 못 읽으면 `rate: null`을 준다. 화면은 그때 KRW 버튼을 잠근다.
// **못 바꾸는 것은 불편이고, 잘못 바꾼 숫자는 사고다.**
//
// 브라우저가 아니라 서버가 부르는 이유: 공급원이 바뀌어도 화면을 안
// 고치고, 값 검증(범위)을 한 곳에서만 한다.
import { NextResponse } from 'next/server';
import { parseUsdKrw } from '@/lib/portfolio/fxRate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// 환율은 분 단위로 바뀌지 않는다. 매 요청마다 외부를 부르지 않는다.
export const revalidate = 0;

let cached: { rate: number; asOfMs: number } | null = null;
const CACHE_MS = 30 * 60_000;

export async function GET() {
  const now = Date.now();
  if (cached && now - cached.asOfMs < CACHE_MS) {
    const fx = parseUsdKrw(cached.rate, cached.asOfMs);
    return NextResponse.json({ ok: !!fx, fx }, { headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    // 무료 · 키 불필요. 이미 `/api/providers/healthcheck`가 쓰는 곳이다.
    const r = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d: any = await r.json();
    const fx = parseUsdKrw(d?.rates?.KRW, now);
    if (!fx) throw new Error('환율 값이 정상 범위를 벗어났습니다');
    cached = { rate: fx.rate, asOfMs: now };
    return NextResponse.json({ ok: true, fx }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    // **오래된 캐시라도 있으면 준다.** 다만 언제 것인지 같이 준다 —
    // 화면이 "N시간 전 환율입니다"라고 말할 수 있어야 한다.
    if (cached) {
      const fx = parseUsdKrw(cached.rate, cached.asOfMs);
      if (fx) return NextResponse.json({ ok: true, fx, stale: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({
      ok: false, fx: null,
      message: `환율을 읽지 못했습니다 (${String(e?.message || e).slice(0, 120)}) — `
        + '1:1이라는 뜻이 아닙니다',
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
