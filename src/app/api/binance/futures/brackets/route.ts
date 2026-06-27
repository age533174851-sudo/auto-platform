// /api/binance/futures/brackets
// 심볼별 실제 레버리지 브래킷(유지증거금률/공제액) 조회 — 6시간 캐시
// GET ?connectionId=xxx&symbol=BTCUSDT[&notional=12345]

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { getCachedBracket } from '@/lib/exchanges/binanceFutures';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const connectionId = req.nextUrl.searchParams.get('connectionId');
  const symbol = (req.nextUrl.searchParams.get('symbol') || '').toUpperCase().replace('/', '');
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });
  if (!symbol)       return NextResponse.json({ error: 'missing_symbol' }, { status: 400 });

  const { data: conn, error } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (error || !conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') {
    return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  }

  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return NextResponse.json({ error: 'decrypt_failed' }, { status: 500 }); }
  const apiKey = conn.api_key || '';
  const testnet = conn.is_testnet === true;

  const tiers = await getCachedBracket(symbol, apiKey, secret, testnet);
  if (!tiers) {
    // 거래소 조회 실패 → 호출측이 fallback 테이블 쓰도록 source 표기
    return NextResponse.json({ symbol, source: 'fallback', tiers: null }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // 선택적으로 특정 명목가의 MMR/공제액도 바로 반환
  const notional = parseFloat(req.nextUrl.searchParams.get('notional') || '0');
  let tier: { mmr: number; maintAmount: number } | null = null;
  if (notional > 0) {
    const sorted = [...tiers].sort((a, b) => a[0] - b[0]);
    const found = sorted.find(([cap]) => notional <= cap) || sorted[sorted.length - 1];
    tier = { mmr: found[1], maintAmount: found[2] };
  }

  return NextResponse.json({
    symbol,
    source: 'exchange',
    tiers,            // [[상한, MMR, 공제액], ...]
    tier,             // notional 지정 시 해당 구간
  }, { headers: { 'Cache-Control': 'public, max-age=21600' } }); // 6h
}
