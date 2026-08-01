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

  // 지원 거래소인가.
  //
  // 예전에는 바이낸스가 아니면 무조건 400 'not_binance'였다. 화면은 그걸
  // "잔고 확인 불가"로 그리므로, **게이트로 연결한 사람은 가용 잔고가
  // 영원히 확인 불가**였고 25%·50% 버튼도 계속 비활성이었다. 조회에 실패한
  // 것이 아니라 아예 물어보지 않은 것인데 화면에서는 구분이 안 된다.
  const exch = String(conn.exchange_id || '').toLowerCase();
  if (exch !== 'binance' && exch !== 'gate') {
    return NextResponse.json({
      error: 'unsupported_exchange',
      message: `${conn.exchange_id} 지갑 조회는 아직 지원하지 않습니다 (바이낸스·게이트만)`,
    }, { status: 400 });
  }
  if (conn.has_withdrawal === true) {
    return NextResponse.json({ error: 'withdrawal_key_blocked' }, { status: 403 });
  }

  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return NextResponse.json({ error: 'decrypt_failed' }, { status: 500 }); }
  const apiKey = conn.api_key || '';
  // 프로젝트 공통 규칙: `is_testnet === false`일 때만 실전이다.
  // `=== true`로 두면 값이 없거나 이상할 때 **실계좌**를 조회한다.
  const testnet = conn.is_testnet !== false;

  // ── 두 지갑을 나란히, 각각 ──
  const [spotRes, futRes] = await Promise.allSettled(exch === 'gate' ? [
    // ── 게이트 ──
    (async (): Promise<SpotWallet> => {
      const { getBalancesGate } = await import('@/lib/exchanges/gate');
      const list = await getBalancesGate(apiKey, secret, testnet);
      const raw = (Array.isArray(list) ? list : [])
        .map(b => ({
          asset: String((b as any).currency || (b as any).asset || ''),
          free: Number((b as any).free) || 0,
          locked: Number((b as any).locked) || 0,
        }))
        .filter(b => b.asset && (b.free > 0 || b.locked > 0));
      const assets = await priceAssets(raw);
      const usdt = assets.find(a => a.asset === 'USDT');
      return { ok: true, assets, usdt: usdt ? usdt.free : 0 };
    })(),
    (async (): Promise<FuturesWallet> => {
      const { getAccountGateFutures, getPositionsGateFutures } = await import('@/lib/exchanges/gateFutures');
      const [acct, pos] = await Promise.all([
        getAccountGateFutures(apiKey, secret, testnet),
        getPositionsGateFutures(apiKey, secret, testnet).catch(() => [] as any[]),
      ]);
      const walletBalance = Number(acct?.total);
      const availableMargin = Number(acct?.available);
      // **못 읽은 값을 0으로 채우지 않는다.** 0은 '돈이 없다'이고 조회
      // 실패는 '모른다'인데, 화면에서는 둘 다 "0.00 USDT"로 보인다.
      if (!Number.isFinite(walletBalance) || !Number.isFinite(availableMargin)) {
        throw new Error('게이트 선물 잔고를 읽지 못했습니다');
      }
      const positions: any[] = Array.isArray(pos) ? pos : [];
      const unrealized = positions.reduce((sm, p) => sm + (Number(p.unrealised_pnl) || 0), 0);
      // 게이트 포지션 응답에는 증거금 칸이 따로 없다. 지갑 잔고에서
      // 가용을 뺀 것이 묶여 있는 금액이다.
      const positionMargin = Math.max(0, walletBalance - availableMargin);
      return { ok: true, walletBalance, availableMargin, positionMargin, unrealizedPnl: unrealized };
    })(),
  ] : [
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

      const walletBalance = Number(b.balance ?? b.total ?? b.walletBalance);
      const availableMargin = Number(b.available ?? b.availableBalance);
      // **`|| 0`을 쓰지 않는다.** 응답에 그 칸이 없거나 숫자가 아니면
      // 0이 되어 화면에 "0.00 USDT"로 뜬다. 0은 '돈이 없다'이고 이건
      // '못 읽었다'인데, 사용자는 그 차이를 알 방법이 없다 — 테스트 자금을
      // 받으러 갈지 키를 고칠지가 갈리는 자리다.
      if (!Number.isFinite(walletBalance) || !Number.isFinite(availableMargin)) {
        throw new Error('선물 잔고 응답에 잔고 칸이 없습니다');
      }

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
