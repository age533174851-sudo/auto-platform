// /api/binance/coinm/account
//
// COIN-M 계좌. USDⓈ-M·현물과 **같은 응답에 섞지 않는다.**
//
// COIN-M 지갑은 코인별로 나뉜다 — BTC 잔고와 ETH 잔고는 서로 쓸 수 없고,
// USDT-M 증거금과도 완전히 별개다. 합쳐서 "총 증거금"을 만들면 없는 돈으로
// 포지션 크기를 정하게 된다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import { resolveContractSize, inverseLiquidationPrice } from '@/lib/markets/coinM';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const connectionId = req.nextUrl.searchParams.get('connectionId');
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, api_key, api_secret_enc, encrypted_secret, has_withdrawal, is_testnet')
    .eq('id', connectionId).eq('user_id', uid).maybeSingle();

  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') {
    return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  }
  if (conn.has_withdrawal === true) {
    return NextResponse.json({ error: 'withdrawal_key_blocked' }, { status: 403 });
  }

  try {
    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const dapi = await import('@/lib/exchanges/binanceCoinFutures');
    const secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || '');
    const apiKey = conn.api_key || '';
    const testnet = conn.is_testnet === true;

    const [bal, pos] = await Promise.all([
      dapi.getCoinMBalances(apiKey, secret, testnet),
      dapi.getCoinMPositions(apiKey, secret, testnet),
    ]);

    // 조회 실패를 빈 배열로 돌려주면 "포지션 없음"으로 읽힌다.
    if (!bal.success && !pos.success) {
      return NextResponse.json({
        ok: false, error: 'query_failed',
        message: bal.message || pos.message || 'COIN-M 계좌 조회 실패',
      }, { status: 502 });
    }

    const positions = pos.positions.map(p => {
      const spec = resolveContractSize(p.symbol);
      const approxLiq = p.liquidationPrice > 0
        ? null   // 거래소가 준 값이 있으면 그것이 정확하다
        : inverseLiquidationPrice(
            p.entryPrice, p.leverage, p.contracts > 0 ? 'LONG' : 'SHORT');
      return {
        ...p,
        side: p.contracts > 0 ? 'LONG' : 'SHORT',
        contractUsd: spec?.contractUsd ?? null,
        notionalUsd: spec ? Math.abs(p.contracts) * spec.contractUsd : null,
        // 거래소 값이 없을 때만 근사치를 주고, 그 사실을 표시한다
        liquidationPriceApprox: approxLiq,
        liquidationIsApprox: approxLiq != null,
      };
    });

    return NextResponse.json({
      ok: true,
      marketType: 'COIN_FUTURES',
      wallet: 'COINM_WALLET',
      // 잔고는 코인별로 따로다. 합계를 내지 않는다 — 단위가 서로 다르다.
      balances: bal.success ? bal.balances : null,
      balancesReadable: bal.success,
      positions: pos.success ? positions : null,
      positionsReadable: pos.success,
      note: 'COIN-M 잔고·손익은 코인 단위입니다. USDⓈ-M 증거금이나 현물 잔고와 합산하지 마세요.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: 'query_failed', message: e?.message || 'COIN-M 계좌 조회 실패' },
      { status: 502 });
  }
}
