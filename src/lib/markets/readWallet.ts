// src/lib/markets/readWallet.ts
//
// **연결 하나의 지갑을 읽는다 — 한 곳에서만.**
//
// 왜 라우트에서 꺼냈나
// ────────────────────
// 이 조회는 `/api/wallets`(연결 하나)와 지갑 화면의 전체 개요(연결
// 여럿)가 같이 쓴다. 라우트 안에 두면 개요 쪽이 자기 사본을 갖게 되고,
// 그때 한쪽만 고쳐진다 — 이 저장소에서 가장 자주 난 고장이다.
//
// 여기서 지키는 것
// ────────────────
// **못 읽은 값을 0으로 채우지 않는다.** 0은 '돈이 없다'이고 조회 실패는
// '모른다'인데, 화면에서는 둘 다 "0.00 USDT"로 보인다. 실패는 `ok:false`와
// 사유로 남기고, 합계는 "한쪽이라도 모르면 null"로 처리한다.

import {
  buildWalletTree, spotAllocation, usdtFromFuturesBalances,
  SPOT_UNAVAILABLE, FUTURES_UNAVAILABLE,
  type SpotWallet, type FuturesWallet,
} from './wallets';
import { priceAssets } from './pricing';

export interface WalletRead {
  /**
   * **연결 자체를 읽었는가.** 지갑 숫자가 다 맞다는 뜻이 아니다.
   *
   * 예전에는 이 하나로 뭉쳐 있어서, 연결만 읽히면 `ok:true`였고 그 안의
   * 현물·선물이 실패해도 상위 개요는 "모두 읽었습니다"라고 적었다.
   * 부분 실패는 아래 세 칸으로 따로 남긴다.
   */
  ok: boolean;
  /** 현물 지갑을 읽었는가 */
  spotOk: boolean;
  /** 선물 잔고를 읽었는가 */
  futuresOk: boolean;
  /** 선물 **포지션 목록**을 읽었는가. false면 미실현손익은 모르는 값이다 */
  positionsOk: boolean;
  /** 연결은 읽혔지만 안에서 하나라도 실패했는가 */
  partial: boolean;
  /** 못 읽었으면 왜. HTTP 상태까지 같이 준다 — 라우트가 다시 정하지 않게 */
  error: string | null;
  status: number;
  message: string | null;
  connectionId: string;
  exchangeId: string | null;
  /** 저장소 공통 규칙: `is_testnet === false`일 때만 실전이다 */
  testnet: boolean | null;
  spot: SpotWallet | null;
  futures: FuturesWallet | null;
  tree: ReturnType<typeof buildWalletTree> | null;
  allocation: ReturnType<typeof spotAllocation> | null;
}

const fail = (connectionId: string, error: string, status: number, message?: string): WalletRead => ({
  ok: false, spotOk: false, futuresOk: false, positionsOk: false, partial: false,
  error, status, message: message ?? null,
  connectionId, exchangeId: null, testnet: null,
  spot: null, futures: null, tree: null, allocation: null,
});

/**
 * 이 연결의 현물·선물 지갑.
 *
 * 두 조회를 **따로** 한다. 하나가 실패해도 나머지는 보여줘야 하기 때문이다.
 */
export async function readConnectionWallet(
  sb: any, userId: string, connectionId: string,
): Promise<WalletRead> {
  if (!connectionId) return fail('', 'missing_connectionId', 400);

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, api_key, api_secret_enc, encrypted_secret, has_withdrawal, is_testnet')
    .eq('id', connectionId).eq('user_id', userId).maybeSingle();

  if (!conn) return fail(connectionId, 'connection_not_found', 404);

  // 지원 거래소인가.
  //
  // 예전에는 바이낸스가 아니면 무조건 400 'not_binance'였다. 화면은 그걸
  // "잔고 확인 불가"로 그리므로, **게이트로 연결한 사람은 가용 잔고가
  // 영원히 확인 불가**였고 25%·50% 버튼도 계속 비활성이었다. 조회에 실패한
  // 것이 아니라 아예 물어보지 않은 것인데 화면에서는 구분이 안 된다.
  const exch = String(conn.exchange_id || '').toLowerCase();
  if (exch !== 'binance' && exch !== 'gate') {
    return fail(connectionId, 'unsupported_exchange', 400,
      `${conn.exchange_id} 지갑 조회는 아직 지원하지 않습니다 (바이낸스·게이트만)`);
  }
  if (conn.has_withdrawal === true) {
    return fail(connectionId, 'withdrawal_key_blocked', 403,
      '출금 권한이 있는 키로는 지갑을 조회하지 않습니다');
  }

  const { decryptSecret } = await import('../exchanges/crypto');
  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return fail(connectionId, 'decrypt_failed', 500, 'API 키를 복호화하지 못했습니다'); }
  const apiKey = conn.api_key || '';
  // 프로젝트 공통 규칙: `is_testnet === false`일 때만 실전이다.
  // `=== true`로 두면 값이 없거나 이상할 때 **실계좌**를 조회한다.
  const testnet = conn.is_testnet !== false;

  // ── 두 지갑을 나란히, 각각 ──
  const [spotRes, futRes] = await Promise.allSettled(exch === 'gate' ? [
    // ── 게이트 ──
    (async (): Promise<SpotWallet> => {
      const { getBalancesGate } = await import('../exchanges/gate');
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
      const { getAccountGateFutures, getPositionsGateFutures } = await import('../exchanges/gateFutures');
      // **포지션 조회 실패를 빈 배열로 바꾸지 않는다.**
      //
      // 예전에는 `.catch(() => [])`였다. 그러면 포지션을 못 읽은 것이
      // '포지션 없음'이 되고, 미실현손익이 **0**으로 계산된다 — 주문
      // 엔진에서 몇 번이나 고쳤던 바로 그 패턴이 지갑에 남아 있었다.
      // 실패는 `null`로 남기고, 미실현손익도 null로 둔다.
      const [acct, pos] = await Promise.all([
        getAccountGateFutures(apiKey, secret, testnet),
        getPositionsGateFutures(apiKey, secret, testnet).then(
          (r: any) => (Array.isArray(r) ? r : null), () => null),
      ]);
      const walletBalance = Number(acct?.total);
      const availableMargin = Number(acct?.available);
      // **못 읽은 값을 0으로 채우지 않는다.** 0은 '돈이 없다'이고 조회
      // 실패는 '모른다'인데, 화면에서는 둘 다 "0.00 USDT"로 보인다.
      if (!Number.isFinite(walletBalance) || !Number.isFinite(availableMargin)) {
        throw new Error('게이트 선물 잔고를 읽지 못했습니다');
      }
      const positionsOk = pos != null;
      const unrealized = positionsOk
        ? (pos as any[]).reduce((sm, p) => sm + (Number(p.unrealised_pnl) || 0), 0)
        : null;
      // 게이트 포지션 응답에는 증거금 칸이 따로 없다. 지갑 잔고에서
      // 가용을 뺀 것이 묶여 있는 금액이다 — 이건 잔고만으로 계산되므로
      // 포지션 조회와 무관하게 알 수 있다.
      const positionMargin = Math.max(0, walletBalance - availableMargin);
      return { ok: true, walletBalance, availableMargin, positionsOk, positionMargin,
        unrealizedPnl: unrealized,
        ...(positionsOk ? {} : { error: '게이트 포지션 목록을 읽지 못했습니다 — 미실현손익을 0으로 적지 않습니다' }) };
    })(),
  ] : [
    (async (): Promise<SpotWallet> => {
      const { getBalancesBinance } = await import('../exchanges/binance');
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
      const { getFuturesBalance, getFuturesPositions } = await import('../exchanges/binanceFutures');
      const [bal, pos] = await Promise.all([
        getFuturesBalance(apiKey, secret, testnet),
        getFuturesPositions(apiKey, secret, testnet),
      ]);
      // **조회 실패를 빈 배열로 바꾸지 않는다.** `success`가 아니면
      // 포지션이 없는 것이 아니라 **모르는 것**이다. 예전에는 `[]`로
      // 접어서 미실현손익이 0이 됐다.
      const positionsOk = (pos as any)?.success === true && Array.isArray((pos as any).positions);
      const positions: any[] | null = positionsOk ? (pos as any).positions : null;
      const unrealized = positions
        ? positions.reduce((s, p) => s + (Number(p.unrealizedPnl ?? p.unRealizedProfit) || 0), 0)
        : null;
      const positionMargin = positions
        ? positions.reduce((s, p) => s + (Number(p.isolatedMargin ?? p.initialMargin) || 0), 0)
        : null;

      // 응답 모양을 여기서 추측하지 않는다 — 정확히 그래서 틀렸었다.
      // (lib/markets/wallets의 usdtFromFuturesBalances 주석 참조)
      const w = usdtFromFuturesBalances(bal);
      if (!w.ok) throw new Error(w.error || '선물 잔고를 읽지 못했습니다');

      return {
        ok: true,
        walletBalance: w.walletBalance,
        availableMargin: w.availableMargin,
        positionsOk, positionMargin, unrealizedPnl: unrealized,
        ...(positionsOk ? {} : { error: '바이낸스 포지션 목록을 읽지 못했습니다 — 미실현손익을 0으로 적지 않습니다' }),
      };
    })(),
  ]);

  const spot: SpotWallet = spotRes.status === 'fulfilled'
    ? spotRes.value
    : { ...SPOT_UNAVAILABLE, error: String((spotRes as any).reason?.message || '현물 지갑 조회 실패') };

  const futures: FuturesWallet = futRes.status === 'fulfilled'
    ? futRes.value
    : { ...FUTURES_UNAVAILABLE, error: String((futRes as any).reason?.message || '선물 지갑 조회 실패') };

  const tree = buildWalletTree(spot, futures);
  const spotOk = spot.ok === true;
  const futuresOk = futures.ok === true;
  const positionsOk = futuresOk && futures.positionsOk === true;
  const partial = !spotOk || !futuresOk || !positionsOk;
  return {
    ok: true, spotOk, futuresOk, positionsOk, partial,
    // **부분 실패를 사유에 남긴다.** 예전에는 여기가 언제나 null이라,
    // 안에서 현물이 실패해도 위에서는 성공으로만 보였다.
    error: partial
      ? [!spotOk ? '현물 조회 실패' : '', !futuresOk ? '선물 잔고 조회 실패' : '',
        futuresOk && !positionsOk ? '선물 포지션 조회 실패' : ''].filter(Boolean).join(' · ')
      : null,
    status: 200, message: null,
    connectionId, exchangeId: String(conn.exchange_id ?? ''),
    testnet,
    spot, futures, tree, allocation: spotAllocation(spot),
  };
}
