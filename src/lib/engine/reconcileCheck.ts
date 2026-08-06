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
  /**
   * **이 주문이 쓰는 연결.** 주면 그 연결만 본다.
   *
   * 안 주면 예전처럼 활성 연결 중 아무거나 하나를 집는데, 연결이 여럿이면
   * 그건 **주문과 상관없는 거래소**일 수 있다. 실제로 그랬다 — 바이낸스
   * 실전 진입이 "Gate 401: Invalid key provided"로 막혔다. Gate 키가 죽은
   * 것과 바이낸스 주문은 아무 관계가 없다.
   *
   * 남의 거래소 상태로 이 거래소의 주문을 막으면, 고칠 수 없는 이유로
   * 영영 막힌다.
   */
  connectionId?: string | null,
): Promise<GatherResult> {
  const empty = { appPositions: [], exchangePositions: [], unresolvedOrders: [] };

  let q = sb.from('exchange_connections')
    .select('exchange_id, api_key, api_secret_enc, has_withdrawal')
    .eq('user_id', userId).eq('is_active', true);
  if (connectionId) q = q.eq('id', connectionId);
  const { data: conn } = await q.limit(1).maybeSingle();

  if (!conn) return { reachable: false, verdict: null, error: '활성 거래소 연결이 없습니다', ...empty };
  if ((conn as any).has_withdrawal) {
    return { reachable: false, verdict: null, error: '출금 권한 키는 사용할 수 없습니다', ...empty };
  }

  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  const key = (conn as any).api_key as string;
  const secret = decryptSecret((conn as any).api_secret_enc ?? '');

  // ── 어느 거래소인가 ──
  //
  // 예전에는 바이낸스만 읽었다. Gate 연결에서 이 함수를 부르면 Gate 키로
  // 바이낸스에 물어보게 되고, 실패 → `reachable: false` → 거래 전 점검이
  // '확인 못 함'으로 **모든 Gate 주문을 막았다.**
  //
  // 판정(reconcileState)은 거래소를 모른다 — PositionView만 받는다. 그래서
  // 읽는 쪽만 갈라 준다.
  // 판정은 futuresExchangeOf 한 곳에 있다. 모르는 거래소를 바이낸스로
  // 읽으면, 그 거래소에 있는 포지션을 바이낸스에서 못 찾고 **'포지션
  // 없음'으로 대조**해 버린다 — 앱에는 있는데 거래소에는 없다는 결론이
  // 나오고, 그건 가장 위험한 거짓말이다.
  const { futuresExchangeOf } = await import('@/lib/exchanges/futuresAdapter');
  const exResolved = futuresExchangeOf((conn as any).exchange_id);
  if (!exResolved) {
    return { reachable: false, verdict: null,
      error: `선물을 지원하지 않는 거래소라 대조하지 못했습니다 `
           + `(${(conn as any).exchange_id || '알 수 없음'})`, ...empty };
  }
  const isGate = exResolved === 'gate';

  const exchangePositions: PositionView[] = [];
  let exchangeOpenOrders: OrderView[] | undefined;

  if (isGate) {
    const gf = await import('@/lib/exchanges/gateFutures');
    const gp = await import('@/lib/exchanges/gatePlan');

    let gatePositions: any[];
    try {
      gatePositions = await gf.getPositionsGateFutures(key, secret, testnet);
    } catch (e: any) {
      return { reachable: false, verdict: null,
        error: `Gate 포지션 조회 실패: ${e?.message || e}`, ...empty };
    }

    for (const p of gatePositions) {
      // 변환은 gatePositionToRisk 한 곳에만 둔다 (leverage 0 = 교차 등).
      const r = gp.gatePositionToRisk(p)!;
      // 조건부 주문 목록으로 보호주문 유무를 판정한다. 못 읽으면 **있다고
      // 가정하지 않는다** — 없는 것으로 보면 대조가 '손절 소실'을 띄우고
      // 주문이 막히는데, 그게 있다고 보는 것보다 안전하다.
      const priceOrders = await gf.getPriceOrdersGateFutures(key, secret, p.contract, testnet);
      exchangePositions.push({
        // Gate 계약명을 앱 심볼 모양으로 되돌린다 — 대조는 심볼로 짝을 맞춘다
        symbol: String(p.contract || '').replace('_', ''),
        side: r.positionAmt < 0 ? 'SHORT' : 'LONG',
        qty: Math.abs(r.positionAmt),
        leverage: r.leverage,
        marginType: r.marginType,
        hasProtectiveStop: priceOrders == null ? false : priceOrders.length > 0,
        liquidationPrice: r.liquidationPrice,
      });
    }

    // Gate 미체결 주문. clientOrderId는 't-' 접두사가 붙어 저장되므로 떼어낸다.
    try {
      const rows = await gf.getOpenOrdersGateFutures(key, secret, testnet);
      exchangeOpenOrders = rows.map(o => ({
        clientOrderId: String(o.text || '').replace(/^t-/, ''),
        symbol: String(o.contract || '').replace('_', ''),
      }));
    } catch { exchangeOpenOrders = undefined; }

  } else {
    const bf = await import('@/lib/exchanges/binanceFutures');
    const posRes: any = await bf.getFuturesPositions(key, secret, testnet);
    if (!posRes?.success) {
      // 조회 실패를 "포지션 없음"으로 처리하면 앱의 모든 포지션이 불일치로 잡힌다.
      return { reachable: false, verdict: null, error: posRes?.message || '거래소 조회 실패', ...empty };
    }

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

    try {
      const open = await bf.getFuturesOpenOrders(key, secret, testnet);
      exchangeOpenOrders = (Array.isArray(open) ? open : []).map((o: any) => ({
        clientOrderId: String(o.clientOrderId || ''), symbol: String(o.symbol || ''),
      }));
    } catch { exchangeOpenOrders = undefined; }
  }

  // ── 청산 주문은 포지션이 아니다 ──
  //
  // reduce_only 행을 그대로 포지션으로 읽으면 방향이 뒤집혀 잡힌다. 롱을 닫은
  // SELL 기록이 숏 포지션이 되고, 거래소에는 그런 포지션이 없으니 심각 불일치가
  // 되어 이후 주문이 전부 막힌다.
  //
  // 컬럼이 없는 스키마에서 select가 실패하면 조회 전체가 비고, 그러면 앱
  // 포지션이 통째로 사라져 이번에는 반대 방향 불일치가 난다. 그래서 실패하면
  // 컬럼을 빼고 다시 읽는다 — 아래 미확정 주문 조회와 같은 방식이다.
  // ── **어느 연결의 기록인가** ──
  //
  // 이 조회들이 `user_id`로만 걸러지고 있었다. 그러면 **테스트넷에서
  // 만든 기록을 실전 거래소에 물어본다.** 거래소는 당연히 모른다고
  // 답하고, 대조는 "앱에는 있는데 거래소에 없다"로 끝난다 —
  // 영원히. 실제로 이 계좌가 그 상태였다: 08-03 테스트넷 주문 9건이
  // 실전 연결 대조를 막고 있었고, [미확정 주문 확정]을 눌러도 안 풀렸다.
  // 없는 것을 찾고 있었으니까.
  //
  // 연결이 곧 거래소이자 망이다. 연결을 알면 그 연결 것만 본다.
  // **모르면 좁히지 않는다** — 안 거르는 쪽이 과하게 막는 쪽이고,
  // 과하게 막는 것은 놓치는 것보다 낫다.
  const scope = (q: any) => (connectionId ? q.eq('connection_id', connectionId) : q);

  const appQuery = (cols: string) => scope(sb.from('live_orders')
    .select(cols)
    .eq('user_id', userId).in('status', ['ACKED', 'FILLED']))
    .order('created_at', { ascending: false }).limit(50);

  let { data: appRows, error: appErr } =
    await appQuery('client_order_id, symbol, side, filled_qty, status, reduce_only');
  if (appErr) {
    ({ data: appRows } = await appQuery('client_order_id, symbol, side, filled_qty, status'));
  }

  const appPositions: PositionView[] = (Array.isArray(appRows) ? appRows : [])
    .filter((r: any) => Number(r.filled_qty) > 0 && r.reduce_only !== true)
    .map((r: any) => ({
      symbol: String(r.symbol),
      side: String(r.side).toUpperCase() === 'SHORT' ? 'SHORT' as const : 'LONG' as const,
      qty: Number(r.filled_qty),
    }));

  const { data: appOpenRows } = await scope(sb.from('live_orders')
    .select('client_order_id, symbol')
    .eq('user_id', userId).in('status', ['SENT', 'ACKED'])).limit(50);
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
  const unresolvedQuery = (cols: string) => scope(sb.from('live_orders')
    .select(cols)
    .eq('user_id', userId).eq('status', 'UNKNOWN'))
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
  /** 이 주문이 쓰는 연결. 주면 그 연결만 대조한다 */
  connectionId?: string | null,
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
  const r = await gatherAndReconcile(sb, userId, testnet, connectionId);

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
              // **사용자에게 API 주소를 알려주지 않는다.** 휴대폰으로 보는
              // 사람에게 "/api/…를 호출하세요"는 막다른 길이다. 화면에
              // 버튼이 있고, 그 버튼을 누르라고 말해야 한다.
              `아래 '미확정 주문 확정' 버튼을 눌러 거래소와 대조한 뒤 다시 시도하세요.`,
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
