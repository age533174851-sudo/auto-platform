// src/lib/engine/reconcileCheck.ts
//
// 거래소·앱 스냅샷을 모아 stateReconcile에 넘기는 수집 계층.
//
// 판정 규칙은 stateReconcile.ts(순수 함수)에 있고 여기서는 조회만 한다.
// 조회 코드가 라우트와 주문 경로 두 곳에 복사되면, 한쪽만 고쳐졌을 때
// "화면은 괜찮다는데 주문은 막히는" 식의 불일치가 생긴다.
import { reconcileState, type PositionView, type OrderView, type ReconcileVerdict } from './stateReconcile';

export interface GatherResult {
  /** 거래소 조회에 실패하면 판정 자체가 불가능하다 */
  reachable: boolean;
  verdict: ReconcileVerdict | null;
  error?: string;
  appPositions: PositionView[];
  exchangePositions: PositionView[];
}

export async function gatherAndReconcile(
  sb: any,
  userId: string,
  testnet: boolean,
): Promise<GatherResult> {
  const empty = { appPositions: [], exchangePositions: [] };

  const { data: conn } = await sb.from('exchange_connections')
    .select('api_key, api_secret_enc, encrypted_secret, has_withdrawal')
    .eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle();

  if (!conn) return { reachable: false, verdict: null, error: '활성 거래소 연결이 없습니다', ...empty };
  if ((conn as any).has_withdrawal) {
    return { reachable: false, verdict: null, error: '출금 권한 키는 사용할 수 없습니다', ...empty };
  }

  const bf = await import('@/lib/exchanges/binanceFutures');
  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  const key = (conn as any).api_key as string;
  const secret = decryptSecret((conn as any).api_secret_enc ?? (conn as any).encrypted_secret ?? '');

  const posRes: any = await bf.getFuturesPositions(key, secret, testnet);
  if (!posRes?.success) {
    // 조회 실패를 "포지션 없음"으로 처리하면 앱의 모든 포지션이 불일치로 잡힌다.
    return { reachable: false, verdict: null, error: posRes?.message || '거래소 조회 실패', ...empty };
  }

  const exchangePositions: PositionView[] = [];
  for (const p of (posRes.positions as any[])) {
    let hasStop = false;
    try {
      const open = await bf.getFuturesOpenOrders(key, secret, testnet, p.symbol);
      hasStop = (Array.isArray(open) ? open : []).some((o: any) =>
        String(o?.type || '').toUpperCase() === 'STOP_MARKET');
    } catch { hasStop = false; }

    exchangePositions.push({
      symbol: p.symbol,
      side: p.side === 'SHORT' ? 'SHORT' : 'LONG',
      qty: Math.abs(Number(p.amount)),
      leverage: Number(p.leverage) || null,
      marginType: p.marginType || null,
      hasProtectiveStop: hasStop,
    });
  }

  let exchangeOpenOrders: OrderView[] | undefined;
  try {
    const open = await bf.getFuturesOpenOrders(key, secret, testnet);
    exchangeOpenOrders = (Array.isArray(open) ? open : []).map((o: any) => ({
      clientOrderId: String(o.clientOrderId || ''), symbol: String(o.symbol || ''),
    }));
  } catch { exchangeOpenOrders = undefined; }

  const { data: appRows } = await sb.from('live_orders')
    .select('client_order_id, symbol, side, filled_qty, status')
    .eq('user_id', userId).in('status', ['ACKED', 'FILLED'])
    .order('created_at', { ascending: false }).limit(50);

  const appPositions: PositionView[] = (Array.isArray(appRows) ? appRows : [])
    .filter((r: any) => Number(r.filled_qty) > 0)
    .map((r: any) => ({
      symbol: String(r.symbol),
      side: String(r.side).toUpperCase() === 'SHORT' ? 'SHORT' as const : 'LONG' as const,
      qty: Number(r.filled_qty),
    }));

  const { data: appOpenRows } = await sb.from('live_orders')
    .select('client_order_id, symbol')
    .eq('user_id', userId).in('status', ['SENT', 'ACKED']).limit(50);
  const appOpenOrders: OrderView[] = (Array.isArray(appOpenRows) ? appOpenRows : [])
    .map((r: any) => ({ clientOrderId: String(r.client_order_id), symbol: String(r.symbol) }));

  const verdict = reconcileState({ appPositions, exchangePositions, appOpenOrders, exchangeOpenOrders });
  return { reachable: true, verdict, appPositions, exchangePositions };
}

/**
 * 주문 직전 관문. 신규 주문을 내도 되는지 판단한다.
 *
 * 거래소에 닿지 않으면 막는다. 상태를 확인할 수 없는 채로 주문을 내면,
 * 이미 열린 포지션 위에 하나를 더 얹거나 이미 청산된 것을 모르고 진행하게 된다.
 */
export async function assertStateConsistent(
  sb: any,
  userId: string,
  testnet: boolean,
): Promise<{ allowed: boolean; reason?: string; verdict: ReconcileVerdict | null }> {
  const r = await gatherAndReconcile(sb, userId, testnet);

  if (!r.reachable) {
    return {
      allowed: false, verdict: null,
      reason: `거래소 상태를 확인할 수 없어 신규 주문을 보류합니다: ${r.error || '조회 실패'}`,
    };
  }
  if (r.verdict?.blockNewOrders) {
    return {
      allowed: false, verdict: r.verdict,
      reason: `앱과 거래소 상태가 어긋나 신규 주문을 보류합니다 — ${r.verdict.summary}`,
    };
  }
  return { allowed: true, verdict: r.verdict };
}
