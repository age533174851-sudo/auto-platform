// /api/logo — Stock/ETF/Crypto logo proxy
// Hides API keys from client, falls back gracefully when sources fail.
//
// 조회 로직은 src/lib/logoLookup.ts에 있다. App Router의 route 파일은
// HTTP 메서드와 정해진 설정값 외의 export를 허용하지 않는다.
import { NextRequest, NextResponse } from 'next/server';
import { lookupLogo, type AssetType } from '@/lib/logoLookup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── GET /api/logo?symbol=X&type=auto ───────────────────────
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const symbolRaw = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  const typeRaw   = ((url.searchParams.get('type') || 'auto').toLowerCase()) as AssetType;

  if (!symbolRaw) {
    return NextResponse.json({
      symbol: '', type: 'auto', logoUrl: null, source: 'fallback', fallback: true,
      error: 'Missing symbol',
    }, { status: 400 });
  }
  const resp = await lookupLogo(symbolRaw, typeRaw);
  return NextResponse.json(resp, {
    headers: { 'Cache-Control': 'public, max-age=21600' },
  });
}
