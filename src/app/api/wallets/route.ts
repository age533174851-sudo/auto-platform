// /api/wallets
//
// 통합 자산 트리. 현물 지갑과 선물 지갑을 **각각** 조회해서 나란히 돌려준다.
//
// 두 조회를 따로 하는 이유
// ────────────────────────
// 하나가 실패해도 나머지는 보여줘야 한다. 그런데 실패한 쪽을 0으로 채우면
// 총자산이 줄어든 것처럼 보이고 사용자는 손실이 난 줄 안다.
// 그래서 실패는 ok:false로 남기고, 합계는 lib/markets/wallets.ts가
// "한쪽이라도 모르면 null"로 처리한다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import {
  buildWalletTree, spotAllocation,
  SPOT_UNAVAILABLE, FUTURES_UNAVAILABLE,
  type SpotWallet, type FuturesWallet,
} from '@/lib/markets/wallets';
// 가격 매기기는 통합 자산과 현물 전략이 함께 쓴다. 각자 계산하면
// 한 화면은 리밸런싱이 돌고 다른 화면은 안 도는 식으로 어긋난다.
import { priceAssets } from '@/lib/markets/pricing';

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

  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return NextResponse.json({ error: 'decrypt_failed' }, { status: 500 }); }
  const apiKey = conn.api_key || '';
  const testnet = conn.is_testnet === true;

  // ── 두 지갑을 나란히, 각각 ──
  const [spotRes, futRes] = await Promise.allSettled([
    (async (): Promise<SpotWallet> => {
      const { getBalancesBinance } = await import('@/lib/exchanges/binance');
      const list = await getBalancesBinance(apiKey, secret, testnet);
      const raw = (Array.isArray(list) ? list : [])
        .map(b => ({
          asset: String(b.currency || ''),
          free: Number(b.free) || 0,
          locked: Number(b.locked) || 0,
        }))
        .filter(b => b.asset && (b.free > 0 || b.locked > 0));
      const assets = await priceAssets(raw);
      const usdt = assets.find(a => a.asset === 'USDT');
      return {
        ok: true, assets,
        usdt: usdt ? usdt.free : 0,
      };
    })(),
    (async (): Promise<FuturesWallet> => {
      const { getFuturesBalance, getFuturesPositions } = await import('@/lib/exchanges/binanceFutures');
      const [bal, pos] = await Promise.all([
        getFuturesBalance(apiKey, secret, testnet),
        getFuturesPositions(apiKey, secret, testnet),
      ]);
      if (!(bal as any)?.success) throw new Error((bal as any)?.message || '선물 잔고 조회 실패');

      const b: any = bal;
      const positions: any[] = (pos as any)?.success ? (pos as any).positions : [];
      const unrealized = positions.reduce(
        (s, p) => s + (Number(p.unrealizedPnl ?? p.unRealizedProfit) || 0), 0);
      const positionMargin = positions.reduce(
        (s, p) => s + (Number(p.isolatedMargin ?? p.initialMargin) || 0), 0);

      const walletBalance = Number(b.balance ?? b.total ?? b.walletBalance) || 0;
      const availableMargin = Number(b.available ?? b.availableBalance) || 0;

      return { ok: true, walletBalance, availableMargin, positionMargin, unrealizedPnl: unrealized };
    })(),
  ]);

  const spot: SpotWallet = spotRes.status === 'fulfilled'
    ? spotRes.value
    : { ...SPOT_UNAVAILABLE, error: String((spotRes as any).reason?.message || '현물 지갑 조회 실패') };

  const futures: FuturesWallet = futRes.status === 'fulfilled'
    ? futRes.value
    : { ...FUTURES_UNAVAILABLE, error: String((futRes as any).reason?.message || '선물 지갑 조회 실패') };

  const tree = buildWalletTree(spot, futures);

  return NextResponse.json({
    ok: true,
    tree,
    allocation: spotAllocation(spot),
    // 화면이 이 문장을 그대로 쓸 수 있게 여기서 정해 둔다.
    // 각 화면이 알아서 쓰면 어딘가는 "총자산으로 주문 가능"이라고 쓴다.
    note: '현물 잔고는 선물 증거금이 아닙니다. 선물에서 쓰려면 이체가 필요합니다.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
