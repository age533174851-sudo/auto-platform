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
  /**
   * 아직 결과가 확정되지 않은 주문들.
   *
   * 상태 대조와는 다른 축이다. 대조는 "지금 무엇이 열려 있는가"를 보고,
   * 이쪽은 "우리가 보낸 것 중 결과를 모르는 것이 있는가"를 본다.
   * 미확정 주문이 있으면 거래소 포지션이 앞으로 변할 수 있으므로,
   * 지금 대조가 일치하더라도 그 위에 새 주문을 얹으면 안 된다.
   */
  unresolvedOrders: { clientOrderId: string; symbol: string; reason: string; needsAttention: boolean }[];
}

export async function gatherAndReconcile(
  sb: any,
  userId: string,
  testnet: boolean,
): Promise<GatherResult> {
  const empty = { appPositions: [], exchangePositions: [], unresolvedOrders: [] };

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
      // 대조에는 쓰지 않지만 거래 전 점검이 쓴다 (PositionView 주석 참조).
      // 0이면 거래소가 안 준 것이라 null로 둔다 — 0은 청산가가 아니다.
      liquidationPrice: Number(p.liquidationPrice) || null,
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

  // ── 결과 미확정 주문 ──
  // UNKNOWN은 "보냈는데 결과를 모르는" 상태다. 이게 남아 있으면 거래소
  // 포지션이 앞으로 바뀔 수 있으므로, 지금 대조가 맞더라도 그 위에 새
  // 주문을 얹으면 안 된다.
  //
  // needs_attention은 018 마이그레이션에서 생긴다. 아직 적용되지 않은 DB에서
  // 그 컬럼을 요청하면 조회 전체가 실패하고, 그러면 미확정 주문이 0건으로
  // 보여 관문이 열려버린다. 실패하면 컬럼을 빼고 다시 조회한다 —
  // 부가 정보가 없더라도 "미확정 주문이 있다"는 사실은 반드시 알아야 한다.
  const unresolvedQuery = (cols: string) => sb.from('live_orders')
    .select(cols)
    .eq('user_id', userId).eq('status', 'UNKNOWN')
    .order('created_at', { ascending: false }).limit(20);

  let { data: unresolvedRows, error: unresolvedErr } =
    await unresolvedQuery('client_order_id, symbol, error_message, needs_attention');
  if (unresolvedErr) {
    ({ data: unresolvedRows } = await unresolvedQuery('client_order_id, symbol, error_message'));
  }
  const unresolvedOrders = (Array.isArray(unresolvedRows) ? unresolvedRows : []).map((r: any) => ({
    clientOrderId: String(r.client_order_id || ''),
    symbol: String(r.symbol || ''),
    reason: String(r.error_message || '사유 미기록'),
    needsAttention: r.needs_attention === true,
  }));

  const verdict = reconcileState({ appPositions, exchangePositions, appOpenOrders, exchangeOpenOrders });
  return { reachable: true, verdict, appPositions, exchangePositions, unresolvedOrders };
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
): Promise<{
  allowed: boolean;
  reason?: string;
  verdict: ReconcileVerdict | null;
  /**
   * 방금 읽은 원본. 호출자가 같은 조회를 다시 하지 않도록 실어 보낸다.
   *
   * 거래 전 점검(preTradeChecklist)이 이 값들을 필요로 하는데, 없으면
   * 주문 경로가 거래소를 두 번 읽는다 — 레이트리밋을 두 배로 쓰고,
   * 두 조회 사이에 상태가 바뀌면 점검과 차단이 서로 다른 사실을 본다.
   */
  gather: GatherResult;
}> {
  const r = await gatherAndReconcile(sb, userId, testnet);

  if (!r.reachable) {
    return {
      allowed: false, verdict: null, gather: r,
      reason: `거래소 상태를 확인할 수 없어 신규 주문을 보류합니다: ${r.error || '조회 실패'}`,
    };
  }
  // 미확정 주문이 있으면 막는다. 그 주문이 나중에 체결되면 포지션이
  // 두 배가 되고, 100배 격리에서 그것은 즉시 청산 거리를 반으로 줄인다.
  if (r.unresolvedOrders.length > 0) {
    const first = r.unresolvedOrders[0];
    return {
      allowed: false, verdict: r.verdict, gather: r,
      reason: `결과가 확정되지 않은 주문이 ${r.unresolvedOrders.length}건 있어 신규 주문을 보류합니다 ` +
              `(${first.symbol} ${first.clientOrderId}: ${first.reason}). ` +
              `/api/orders/reconcile로 확정한 뒤 다시 시도하세요.`,
    };
  }
  if (r.verdict?.blockNewOrders) {
    return {
      allowed: false, verdict: r.verdict, gather: r,
      reason: `앱과 거래소 상태가 어긋나 신규 주문을 보류합니다 — ${r.verdict.summary}`,
    };
  }
  return { allowed: true, verdict: r.verdict, gather: r };
}
