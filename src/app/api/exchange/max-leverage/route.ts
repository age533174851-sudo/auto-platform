// /api/exchange/max-leverage — 이 심볼에서 거래소가 몇 배까지 허용하는가
//
// 왜 라우트가 필요한가
// ────────────────────
// 배율 사다리에 '거래소 최대' 칸은 처음부터 있었는데 **아무도 채우지
// 않았다.** 화면은 사용자 상한과 청산안전 상한만 알고, 거래소가 실제로
// 몇 배까지 받아 주는지는 모른 채 계산했다.
//
// 그 결과가 둘이다:
//   · 일반 경로: 상한이 **없는 것처럼** 통과 → 거래소가 거절할 배율로 주문
//   · 스트레스: "몇 배까지 되는지 모른다"로 **매번 막힘**
//
// 브라우저에서 직접 거래소를 부를 수는 없다(바이낸스는 서명이 필요하고,
// 키는 서버에만 있다). 그래서 서버가 대신 읽어 준다.
//
// **못 읽으면 null이다.** 125를 채워 보내면 없는 상한을 있다고 적는 것이고,
// 그 숫자로 청산가·증거금이 전부 계산된다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { futuresMaxLeverage } from '@/lib/exchanges/futuresAdapter';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const url = new URL(req.url);
  const connectionId = url.searchParams.get('connectionId') || '';
  const symbol = (url.searchParams.get('symbol') || '').toUpperCase().replace('/', '');
  if (!connectionId || !symbol) {
    return NextResponse.json({ ok: false, error: 'missing_params', maxLeverage: null }, { status: 400 });
  }

  // **소유권 확인·거래소 판정·testnet 판정을 여기서 다시 쓰지 않는다.**
  // loadFuturesCreds가 이미 한다. 같은 판정을 두 곳에 두면 한쪽만 고쳐진다.
  const creds = await loadFuturesCreds(sb, uid, connectionId);
  if (!creds.ok) {
    return NextResponse.json({
      ok: false, error: creds.error || 'creds_unavailable', maxLeverage: null,
      message: creds.message || '연결의 API 키를 확인하지 못했습니다',
    }, { status: creds.status || 400 });
  }

  const r = await futuresMaxLeverage(
    creds.exchange!, creds.key || '', creds.secret || '', creds.testnet !== false, symbol);

  return NextResponse.json({
    // **못 읽으면 ok:false다.** 값을 지어내지 않는다 — 125를 채워 보내면
    // 없는 상한을 있다고 적는 것이고, 그 숫자로 청산가·증거금이 계산된다.
    ok: r.maxLeverage != null,
    maxLeverage: r.maxLeverage,
    source: r.source,
    symbol,
    exchange: creds.exchange,
    testnet: creds.testnet !== false,
    // 못 읽었으면 **왜** 못 읽었는지까지. 값만 비우면 화면에는 '확인 실패'
    // 까지만 뜨고 원인은 아무도 모른다.
    message: r.error,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
