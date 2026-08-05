// src/lib/engine/orderExecutor.ts
// 실주문 실행기 (테스트넷 우선).
//
// 실행 순서 — 이 순서를 지켜야 서버가 죽어도 복구할 수 있다:
//   1. 주문 의도를 DB에 먼저 기록 (INTENT)
//   2. 같은 clientOrderId가 거래소에 이미 있는지 확인
//   3. 레버리지 설정
//   4. 거래소로 주문 전송 (SENT)
//   5. 응답 저장 (ACKED / REJECTED / UNKNOWN)
//   6. 손절·익절 부착
//   7. 실제 포지션 조회로 대조
//
// 응답을 못 받으면 절대 그냥 재시도하지 않는다 → UNKNOWN으로 두고 대조 후 판단.
import type { PositionPlan } from './riskManager';
import type { ExitPlan } from './exitPlan';
import { applyTransition, type OrderState as LifecycleState } from './orderLifecycle';

export type OrderStatus = 'INTENT' | 'SENT' | 'ACKED' | 'FILLED' | 'REJECTED' | 'FAILED' | 'UNKNOWN' | 'RECONCILED';

export interface ExecuteArgs {
  userId?: string | null;
  connectionId?: string | null;
  signalId: string;
  clientOrderId: string;
  exchange: 'binance' | 'gate';
  mode: 'TESTNET' | 'LIVE';
  plan: PositionPlan;
  /**
   * 이 주문을 낸 것이 누구인가.
   *
   * 사람이 화면을 보며 누른 것과, 아무도 안 보는 새벽에 크론이 낸 것은
   * **같은 규칙으로 다루면 안 된다.** 아래 protectionPolicy가 이 값에
   * 따라 정해진다.
   */
  source?: 'MANUAL' | 'AUTOTRADE' | 'TRADINGVIEW' | 'CREATOR_SIGNAL';
  /**
   * 손절을 못 걸었을 때 어떻게 할 것인가.
   *
   *   REQUIRED — 방금 연 포지션을 **즉시 되돌린다.** 자동매매의 기본값이다.
   *              포지션 크기 자체가 손절 거리로 역산된 값이라(허용손실 ÷
   *              손절거리), 손절이 없으면 그 크기를 정당화하는 근거가
   *              사라진다. 그리고 아무도 안 보고 있다.
   *
   *   OPTIONAL — 포지션을 **유지한다.** 사람이 화면 앞에 있고, 손절 없이
   *              들고 가겠다는 것도 그 사람의 선택이다. 다만 손절을
   *              요청했는데 못 걸린 것은 **크게 알린다** — 보호되지 않은
   *              포지션이라는 사실을 모르고 넘어가면 안 된다.
   *
   *   NONE     — 손절을 아예 시도하지 않는다.
   *
   * **기본값은 REQUIRED다.** 안 넘긴 호출부는 지금까지와 똑같이 동작한다 —
   * 정책을 새로 만들면서 기존 경로가 조용히 느슨해지면 안 된다.
   */
  protectionPolicy?: 'REQUIRED' | 'OPTIONAL' | 'NONE';
  stopLoss?: number;
  takeProfit?: number;
  /**
   * 비대칭 청산 계획. 주면 단일 익절 대신 분할 익절 사다리를 건다.
   * 손절은 이 계획에 포함돼 있어도 stopLoss와 동일하게 전량 STOP_MARKET이다.
   */
  exitPlan?: ExitPlan;
  /**
   * 주문 유형. **기본 MARKET** — 기존 호출자(daily-ladder)의 동작을 바꾸지 않는다.
   *
   * 예전에는 여기서 'MARKET'을 하드코딩했다. 수동 주문을 이 경로로 옮기면서
   * 그대로 두면 사용자가 지정가로 넣은 주문이 **조용히 시장가로 나간다.**
   * 지정가를 쓰는 이유가 '그 가격에만 사겠다'는 것이므로, 그건 주문을
   * 무시하는 것과 같다.
   */
  orderType?: 'MARKET' | 'LIMIT';
  /** LIMIT일 때 필수. 없으면 전송 전에 거부한다 */
  limitPrice?: number;
  /**
   * 청산 주문인가.
   *
   * true면 손절·익절을 **붙이지 않는다.** 나가는 주문에 보호주문을 걸면
   * 포지션이 없어진 뒤에 남아서, 다음 진입을 예상치 못하게 닫는다.
   */
  reduceOnly?: boolean;
  apiKey: string;
  apiSecret: string;
}

export interface ExecuteResult {
  ok: boolean;
  status: OrderStatus;
  clientOrderId: string;
  /**
   * **손절이 실제로 걸렸는가.**
   *
   * `slOrderId`가 있으면 걸린 것이고, 요청했는데 없으면 보호되지 않은
   * 포지션이다. 화면이 그 둘을 구분해 그릴 수 있어야 한다 — 지금까지는
   * 메시지 문자열을 읽어야만 알 수 있었다.
   */
  unprotected?: boolean;
  exchangeOrderId?: string;
  filledQty?: number;
  avgPrice?: number;
  slOrderId?: string;
  tpOrderId?: string;
  message: string;
  duplicate?: boolean;
}

// ── 018 마이그레이션 이전 스키마와의 호환 ──
//
// 복구용 컬럼(pos_qty_before 등)은 018에서 추가된다. 아직 적용되지
// 않은 DB에 그대로 쓰면 update 전체가 실패해 상태 기록까지 날아간다.
// 주문을 보냈는데 DB가 INTENT로 남는 것이 가장 나쁜 결과이므로,
// 실패하면 새 컬럼만 빼고 다시 쓴다. 마이그레이션이 적용되면 이 경로는 안 돌아간다.
const RECOVERY_COLS = ['pos_qty_before', 'resolve_attempts', 'last_resolve_at', 'needs_attention'];

async function updateOrderRow(sb: any, id: string, patch: Record<string, any>): Promise<void> {
  const { error } = await sb.from('live_orders').update(patch).eq('id', id);
  if (!error) return;
  const legacy: Record<string, any> = {};
  let stripped = false;
  for (const [k, v] of Object.entries(patch)) {
    if (RECOVERY_COLS.includes(k)) { stripped = true; continue; }
    legacy[k] = v;
  }
  if (!stripped || Object.keys(legacy).length === 0) return;
  await sb.from('live_orders').update(legacy).eq('id', id);
}

// 수량 정밀도 보정 — 거래소는 정해진 소수점만 받는다
export function roundQuantity(qty: number, stepSize: number): number {
  if (!stepSize || stepSize <= 0) return qty;
  const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
  return Number((Math.floor(qty / stepSize) * stepSize).toFixed(precision));
}

export async function executeOrder(sb: any, args: ExecuteArgs): Promise<ExecuteResult> {
  const { clientOrderId, plan, exchange, mode, apiKey, apiSecret } = args;
  const testnet = mode !== 'LIVE';
  // 안 넘기면 REQUIRED — 기존 호출부의 동작이 바뀌지 않는다.
  const policy = args.protectionPolicy ?? 'REQUIRED';
  const orderType = args.orderType ?? 'MARKET';
  // 청산이면 방향이 뒤집힌다. plan.side는 '무슨 포지션을 다루는가'이고
  // reduceOnly는 그것을 줄이는 주문이므로 반대 방향으로 보내야 한다.
  // 이걸 틀리면 청산 대신 **두 배로 늘린다.**
  const posSide: 'BUY' | 'SELL' = plan.side === 'LONG' ? 'BUY' : 'SELL';
  const side: 'BUY' | 'SELL' = args.reduceOnly
    ? (posSide === 'BUY' ? 'SELL' : 'BUY')
    : posSide;

  // ── 0) 사전 안전 검사 — 잘못된 값이 거래소로 나가지 않게 ──
  if (!plan.approved) {
    return { ok: false, status: 'REJECTED', clientOrderId, message: '승인되지 않은 계획은 주문할 수 없습니다' };
  }
  if (!isFinite(plan.quantity) || plan.quantity <= 0) {
    return { ok: false, status: 'REJECTED', clientOrderId, message: `주문 수량이 유효하지 않습니다 (${plan.quantity})` };
  }
  // 배율은 진입에만 필요하다. 청산에서 이 검사를 걸면, 거래소에서 배율을
  // 못 읽었다는 이유로 **포지션을 못 닫게 된다.** (아래 3~4단계도 같은 이유로
  // 진입에만 실행한다)
  if (!args.reduceOnly && (!isFinite(plan.leverage) || plan.leverage < 1)) {
    return { ok: false, status: 'REJECTED', clientOrderId,
      message: `레버리지를 확인하지 못했습니다 (${plan.leverage}) — 주문 화면에서 배율을 직접 골라 주세요` };
  }
  if (!clientOrderId || clientOrderId.length < 4) {
    return { ok: false, status: 'REJECTED', clientOrderId, message: 'clientOrderId가 없으면 중복 주문을 막을 수 없어 중단합니다' };
  }
  // 지정가인데 가격이 없으면 보내지 않는다. 여기서 시장가로 바꿔 보내면
  // 사용자가 지정한 가격이 무시된 채 체결된다 — 지정가를 쓴 이유가 사라진다.
  if (orderType === 'LIMIT' && (args.limitPrice == null || !isFinite(args.limitPrice) || args.limitPrice <= 0)) {
    return { ok: false, status: 'REJECTED', clientOrderId,
      message: `지정가 주문에 가격이 없습니다 (${args.limitPrice}). 시장가로 바꿔 보내지 않습니다` };
  }
  // 손절 방향 재확인 (Risk Manager를 통과했더라도 마지막으로 한 번 더)
  if (args.stopLoss != null && plan.liquidationPrice > 0) {
    const badLong = plan.side === 'LONG' && args.stopLoss <= plan.liquidationPrice;
    const badShort = plan.side === 'SHORT' && args.stopLoss >= plan.liquidationPrice;
    if (badLong || badShort) {
      return { ok: false, status: 'REJECTED', clientOrderId,
        message: `손절가(${args.stopLoss})가 청산가(${plan.liquidationPrice.toFixed(2)}) 너머입니다 — 주문 중단` };
    }
  }

  // ── 1) 의도를 먼저 기록 ──
  //    UNIQUE 제약이 같은 clientOrderId 재실행을 원천 차단한다.
  const intent = {
    client_order_id: clientOrderId,
    signal_id: args.signalId,
    user_id: args.userId || null,
    connection_id: args.connectionId || null,
    exchange, mode,
    symbol: plan.symbol,
    side,
    // 하드코딩이었다. 지정가 주문을 'MARKET'으로 적으면 나중에 내역을 볼 때
    // 왜 그 가격에 체결됐는지 설명이 안 된다.
    order_type: orderType,
    // 청산 주문임을 반드시 기록한다.
    //
    // 안 적으면 상태 대조(reconcileCheck)가 이 행을 **반대 방향 진입**으로
    // 읽는다. 롱을 닫은 SELL 기록이 숏 포지션으로 잡히고, 거래소에는 그런
    // 포지션이 없으니 심각 불일치가 되어 이후 주문이 전부 막힌다.
    //
    // daily-ladder는 진입만 하므로 이 필드가 없어도 드러나지 않았다.
    // 수동 청산이 이 경로를 타면서 실제 문제가 된다.
    reduce_only: !!args.reduceOnly,
    quantity: plan.quantity,
    leverage: plan.leverage,
    stop_loss: args.stopLoss ?? null,
    take_profit: args.takeProfit ?? null,
    status: 'INTENT' as OrderStatus,
  };

  const { data: row, error: insErr } = await sb.from('live_orders').insert(intent).select('id, status').single();
  if (insErr) {
    if (String(insErr.code) === '23505') {
      // 이미 처리된 주문 — 기존 상태를 그대로 반환 (재시도해도 결과 동일)
      const { data: prev } = await sb.from('live_orders').select('*').eq('client_order_id', clientOrderId).maybeSingle();
      return {
        ok: prev?.status === 'ACKED' || prev?.status === 'FILLED',
        status: (prev?.status as OrderStatus) || 'UNKNOWN',
        clientOrderId,
        exchangeOrderId: prev?.exchange_order_id,
        filledQty: prev?.filled_qty != null ? Number(prev.filled_qty) : undefined,
        avgPrice: prev?.avg_price != null ? Number(prev.avg_price) : undefined,
        duplicate: true,
        message: '이미 처리된 주문입니다 (중복 요청)',
      };
    }
    return { ok: false, status: 'FAILED', clientOrderId, message: `의도 기록 실패: ${insErr.message}` };
  }

  const orderRowId = row.id;

  // ── 상태 전이 검증 ──
  // 예전에는 update()가 어떤 status든 그대로 덮어썼다. 그러면 이미 FAILED로
  // 확정된 주문이 뒤늦게 도착한 응답 때문에 ACKED로 바뀌는 식의 뒤집힘이
  // 가능하다. orderLifecycle의 상태 기계를 통과한 전이만 기록한다.
  //
  // DB는 예전부터 'INTENT'를 쓰고 상태 기계는 'APPROVED'를 쓴다. 컬럼을
  // 바꾸려면 마이그레이션과 기존 행 변환이 필요하므로, 여기서 매핑만 한다.
  const toLifecycle = (s: string): LifecycleState =>
    (s === 'INTENT' ? 'APPROVED' : s === 'RECONCILED' ? 'ACKED' : s) as LifecycleState;

  let currentStatus: OrderStatus = 'INTENT';

  const update = async (patch: Record<string, any>) => {
    const next = patch.status as OrderStatus | undefined;
    if (next && next !== currentStatus) {
      const t = applyTransition(toLifecycle(currentStatus), toLifecycle(next));
      if (!t.ok) {
        // 상태만 빼고 나머지는 기록한다. 잘못된 전이는 어딘가의 논리 오류이므로
        // 조용히 넘기지 않고 사유를 남긴다.
        try {
          const { log } = await import('@/lib/log/logger');
          log.warn('order-executor', `${clientOrderId}: ${t.reason}`);
        } catch { /* 로거 실패가 주문을 막지 않는다 */ }
        const { status: _drop, ...rest } = patch;
        if (Object.keys(rest).length === 0) return;
        patch = rest;
      } else {
        currentStatus = next;
      }
    }
    try { await updateOrderRow(sb, orderRowId, { ...patch, updated_at: new Date().toISOString() }); } catch {}
  };

  try {
    if (exchange === 'binance') {
      const bf = await import('@/lib/exchanges/binanceFutures');

      // ── 2) 거래소에 이미 같은 주문이 있는지 확인 ──
      try {
        const existing = await bf.findOrderByClientId(apiKey, apiSecret, plan.symbol, clientOrderId, testnet);
        if (existing.found) {
          await update({
            status: 'RECONCILED', exchange_order_id: String(existing.order?.orderId),
            filled_qty: parseFloat(existing.order?.executedQty || '0'),
            avg_price: parseFloat(existing.order?.avgPrice || '0'),
            reconciled_at: new Date().toISOString(),
          });
          return {
            ok: true, status: 'RECONCILED', clientOrderId,
            exchangeOrderId: String(existing.order?.orderId),
            filledQty: parseFloat(existing.order?.executedQty || '0'),
            duplicate: true, message: '거래소에 이미 존재하는 주문 — 재전송하지 않음',
          };
        }
      } catch (e: any) {
        // 조회 자체가 실패하면 판단 불가 → 주문하지 않는다
        //
        // 인증 오류(-2015 등)면 원인 셋을 나눠 적는다. 바이낸스 원문은
        // "Invalid API-key, IP, or permissions"로 셋을 한 문장에 뭉쳐
        // 놓아서, 그대로 띄우면 무엇을 확인해야 하는지 알 수 없다.
        // 셋을 나열하는 대신 **어느 것인지 알아낸다.** 같은 키·같은 서버로
        // 잔고(읽기 권한)를 한 번 찔러 본다. 그게 되면 환경도 IP도 아니므로
        // 남는 것은 '선물 거래 권한이 꺼짐' 하나뿐이다.
        const { narrowFuturesAuthError } = await import('@/lib/exchanges/binance');
        const why = await narrowFuturesAuthError(
          String(e?.message || e), testnet,
          () => bf.getFuturesBalance(apiKey, apiSecret, testnet) as any,
        );
        await update({ status: 'FAILED', error_message: `중복 확인 실패: ${why}` });
        return { ok: false, status: 'FAILED', clientOrderId, message: `중복 확인 실패로 주문 중단: ${why}` };
      }

      // ── 3~4) 마진 타입·레버리지는 **진입에만** 설정한다 ──
      //
      // 둘 다 '어떻게 들어갈 것인가'의 설정이다. 나가는 주문에는 해당이
      // 없는데, 예전에는 청산에도 그대로 걸어 두고 실패하면 주문을 중단했다.
      // 그래서 청산이 막히는 길이 두 개 있었다:
      //   · 마진 타입: 열린 포지션이 있으면 못 바꾼다(-4047). 청산에는 항상
      //     포지션이 있으므로, CROSSED로 열린 포지션은 **닫을 수가 없었다.**
      //   · 레버리지: 거래소에서 배율을 못 읽으면 0이 내려오고 그대로 거부.
      //
      // 못 여는 것은 불편이고, **못 닫는 것은 사고다.**
      if (!args.reduceOnly) {
        // Binance는 심볼별 마진 타입 기본값이 CROSSED다. 이 호출이 없으면
        // "1회 격리 증거금" 전략이라도 실제 체결은 Cross로 나가고, 손실이
        // 증거금을 넘어 계좌 전체로 번진다. 계단식 증거금 상한과 청산가 계산이
        // 모두 isolated를 전제하므로, 설정에 실패하면 주문하지 않는다.
        // (이미 ISOLATED면 -4046이 오는데 그건 성공으로 처리된다)
        const mt = await bf.setFuturesMarginType(apiKey, apiSecret, plan.symbol, 'ISOLATED', testnet);
        if (!mt.success) {
          const reason = `ISOLATED 설정 실패로 주문 중단: ${mt.message}` +
            (mt.code === -4047 || mt.code === -4048
              ? ' (해당 심볼에 열린 포지션이나 미체결 주문이 있으면 마진 타입을 바꿀 수 없습니다)'
              : '');
          await update({ status: 'FAILED', error_message: reason });
          return { ok: false, status: 'FAILED', clientOrderId, message: reason };
        }

        const lev = await bf.setFuturesLeverage(apiKey, apiSecret, plan.symbol, plan.leverage, testnet);
        if (!(lev as any)?.success) {
          await update({ status: 'FAILED', error_message: `레버리지 설정 실패: ${(lev as any)?.message}` });
          return { ok: false, status: 'FAILED', clientOrderId, message: `레버리지 설정 실패: ${(lev as any)?.message}` };
        }
      }

      // ── 4.5) 전송 직전 포지션 기록 ──
      //
      // 응답을 못 받았을 때(UNKNOWN) "주문이 거래소에 들어갔는가"를 판단할
      // 유일한 반대 증거다. 나중에 조회했더니 주문은 안 보이는데 포지션이
      // 변해 있다면, 주문이 들어갔거나 다른 무언가가 계좌를 건드린 것이므로
      // 자동 확정해서는 안 된다. 기준값이 없으면 그 비교 자체를 못 한다.
      // 실패해도 주문은 진행한다 — 교차 확인이 없다는 사실만 남긴다.
      let posQtyBefore: number | null = null;
      try {
        const pr: any = await bf.getFuturesPositions(apiKey, apiSecret, testnet);
        if (pr?.success) {
          const mine = (pr.positions as any[]).find(
            (p: any) => String(p.symbol).toUpperCase() === plan.symbol.toUpperCase());
          posQtyBefore = mine ? Number(mine.amount) || 0 : 0;
        }
      } catch { /* 조회 실패 시 null — 교차 확인 없이 판단하게 된다 */ }

      // ── 5) 주문 전송 ──
      await update({
        status: 'SENT', sent_at: new Date().toISOString(), attempt_count: 1,
        pos_qty_before: posQtyBefore,
      });

      let res: any;
      try {
        res = await bf.placeFuturesOrder(apiKey, apiSecret, {
          symbol: plan.symbol, side, type: orderType,
          quantity: plan.quantity, clientOrderId,
          ...(orderType === 'LIMIT' ? { price: args.limitPrice } : {}),
          ...(args.reduceOnly ? { reduceOnly: true } : {}),
        }, testnet);
      } catch (e: any) {
        // 응답을 못 받음 → 체결됐을 수도 있다. 절대 재시도하지 않고 UNKNOWN.
        await update({ status: 'UNKNOWN', error_message: `응답 없음: ${e?.message || e}` });
        return { ok: false, status: 'UNKNOWN', clientOrderId,
          message: '주문 전송 후 응답을 받지 못했습니다. 재시도하지 않고 대조가 필요합니다.' };
      }

      if (!res?.success) {
        await update({ status: 'REJECTED', error_message: res?.message });
        return { ok: false, status: 'REJECTED', clientOrderId, message: `거래소 거부: ${res?.message}` };
      }

      // ── 6) 접수 확인 ──
      await update({
        status: 'ACKED', exchange_order_id: String(res.orderId),
        filled_qty: res.qty, avg_price: res.price, acked_at: new Date().toISOString(),
      });

      // ── 7) 손절·익절 부착 ──
      let slId: string | undefined, tpId: string | undefined;
      const closeSide: 'BUY' | 'SELL' = side === 'BUY' ? 'SELL' : 'BUY';
      let slError = '';
      // 청산 주문에는 보호주문을 붙이지 않는다. 붙이면 포지션이 없어진 뒤에도
      // 남아서 다음 진입을 예상치 못하게 닫는다.
      if (!args.reduceOnly && args.stopLoss && policy !== 'NONE') {
        const sl = await bf.placeFuturesTPSL(apiKey, apiSecret, {
          symbol: plan.symbol, side: closeSide, stopPrice: args.stopLoss, type: 'STOP_MARKET',
          // 1차는 closePosition(그때 있는 전량)이 맞다. 그게 이 환경에서
          // 거절되면(-4120) 체결 수량으로 한 번 더 시도한다.
          fallbackQuantity: res.qty || plan.quantity,
        }, testnet);
        if ((sl as any)?.success) slId = String((sl as any).orderId);
        else {
          slError = String((sl as any)?.message || '원인 불명');
          // 이 환경이 조건부 주문을 아예 안 받는 경우다. 사용자가
          // 고칠 것이 **여기에는 없다** — 무엇을 해야 하는지까지 적는다.
          // 이 말이 없으면 같은 시도를 반복하게 되고, 시도마다 진입·청산
          // 수수료가 나간다(실제로 잔고가 그렇게 줄었다).
          if ((sl as any)?.envUnsupported) {
            slError += testnet
              ? ' — 이 환경에서는 거래소 손절을 걸 수 없으므로, 여기서 손절 있는 진입은 불가능합니다.'
                + ' 실전(fapi)은 STOP_MARKET을 받으므로 이 제약은 데모에만 해당합니다.'
                + ' 모의(PAPER) 모드는 앱이 직접 손절을 계산하므로 연습에 쓸 수 있습니다.'
              : ' — 거래소가 조건부 주문을 받지 않습니다. 손절 없이 진입하지 않습니다.';
          }
        }
      }
      // 익절 — exitPlan이 있으면 분할 사다리를, 없으면 기존 단일 익절을 건다.
      const tpIds: string[] = [];
      if (args.reduceOnly) {
        // 위와 같은 이유 — 나가는 주문에 익절 사다리를 걸지 않는다
      } else if (args.exitPlan) {
        for (const o of args.exitPlan.orders) {
          if (o.kind !== 'PARTIAL_TP') continue;   // 손절은 위에서 이미 걸었다
          const r = await bf.placeFuturesTPSL(apiKey, apiSecret, {
            symbol: plan.symbol, side: closeSide, stopPrice: o.price,
            type: 'TAKE_PROFIT_MARKET', quantity: o.quantity,
          }, testnet);
          if ((r as any)?.success) tpIds.push(String((r as any).orderId));
          // 분할 익절 실패는 진입을 되돌릴 사유가 아니다 — 손절은 이미 걸려
          // 있으므로 손실은 고정된다. 이익 확보만 덜 되는 것이다.
        }
        tpId = tpIds[0];
      } else if (args.takeProfit) {
        const tp = await bf.placeFuturesTPSL(apiKey, apiSecret, {
          symbol: plan.symbol, side: closeSide, stopPrice: args.takeProfit, type: 'TAKE_PROFIT_MARKET',
        }, testnet);
        if ((tp as any)?.success) tpId = String((tp as any).orderId);
      }
      await update({ sl_order_id: slId || null, tp_order_id: tpId || null });

      // ── 7-b) 손절이 **정말** 걸려 있는지 되읽는다 ──
      //
      // 위의 `slId`는 거래소가 200을 줬다는 뜻이지, 그 주문이 지금 주문장에
      // 남아 있다는 뜻이 아니다. 리스크 엔진이 접수 직후 취소하거나,
      // reduceOnly 조건이 안 맞아 즉시 취소되거나, 다른 심볼로 들어가도
      // 응답은 성공이다. 셋 다 결과는 같다 — **손절 없는 포지션이 열려 있다.**
      //
      // 못 읽었을 때는 '없음'으로 치지 않는다. 조회 한 번 실패로 멀쩡한
      // 포지션을 시장가로 닫으면 수수료와 슬리피지를 확정 손실로 물면서
      // 아무것도 얻지 못한다. 그래서 결과가 셋이다 — 있음/없음/확인 불가.
      let stopCheckNote = '';
      if (!args.reduceOnly && args.stopLoss && slId) {
        const { verifyStopAttached, shouldUnwind } = await import('./stopVerify');
        let openOrders: any[] | null = null;
        try {
          const oo: any = await bf.getFuturesOpenOrders(apiKey, apiSecret, testnet, plan.symbol);
          // success가 false여도 orders: []를 돌려준다. 그 빈 배열을 그대로
          // 넘기면 **조회 실패가 '손절 없음'이 되어 포지션이 청산된다.**
          openOrders = oo?.success && Array.isArray(oo.orders) ? oo.orders : null;
        } catch { openOrders = null; }

        const check = verifyStopAttached(openOrders, {
          symbol: plan.symbol, side: closeSide, stopPrice: args.stopLoss,
        });
        if (shouldUnwind(check)) {
          // 아래 8)의 되돌리기 경로를 그대로 탄다. 판정을 두 곳에 적지 않는다.
          slId = undefined;
          slError = check.reason;
          // 방금 적은 sl_order_id를 지운다. 남겨 두면 나중에 대조할 때
          // 있지도 않은 주문을 "손절 걸림"으로 읽는다.
          await update({ sl_order_id: null });
        } else if (check.status === 'unknown') {
          stopCheckNote = ` · ${check.reason}`;
        }
      }

      // ── 8) 손절이 안 붙었으면 포지션을 즉시 닫는다 ──
      //
      // 예전에는 경고 문자열만 message에 붙이고 ok:true로 반환했다. 그러면
      // 호출자는 성공으로 처리하는데 실제로는 손절 없는 포지션이 열려 있다.
      // 포지션 크기 자체가 "손절 거리"로 역산된 값이므로(허용손실 ÷ 손절거리),
      // 손절이 없으면 그 크기를 정당화하는 근거가 사라진다. 방치하면 계단식
      // 1회 증거금을 넘어 손실이 커질 수 있다.
      // 진입 근거가 사라졌으므로 되돌린다.
      // ── **되돌릴지 말지는 정책이 정한다** ──
      //
      // 자동매매(REQUIRED)는 되돌린다. 포지션 크기 자체가 손절 거리로
      // 역산된 값이라(허용손실 ÷ 손절거리) 손절이 없으면 그 크기를
      // 정당화하는 근거가 사라지고, 아무도 안 보고 있다.
      //
      // 수동(OPTIONAL)은 **유지한다.** 사람이 화면 앞에 있고, 손절 없이
      // 들고 가겠다는 것도 그 사람의 선택이다. 다만 요청한 손절이 안
      // 걸렸다는 사실은 크게 알린다 — 모르고 넘어가면 안 된다.
      if (args.stopLoss && !slId && policy !== 'REQUIRED') {
        const warn = `⚠ 진입은 체결됐지만 요청한 손절이 등록되지 않았습니다`
          + (slError ? ` (${slError})` : '')
          + '. **지금 보호되지 않은 포지션입니다** — 거래소에서 직접 손절을 걸거나 포지션을 닫으세요.';
        await update({ status: 'ACKED', error_message: warn });
        return {
          ok: true, status: 'ACKED', clientOrderId,
          exchangeOrderId: res.orderId ? String(res.orderId) : undefined,
          filledQty: res.qty, avgPrice: res.avgPrice,
          tpOrderId: tpId, unprotected: true, message: warn,
        };
      }

      if (args.stopLoss && !slId) {
        let closed = false, closeErr = '';
        try {
          const close = await bf.placeFuturesOrder(apiKey, apiSecret, {
            symbol: plan.symbol, side: closeSide, type: 'MARKET',
            quantity: res.qty || plan.quantity, reduceOnly: true,
            clientOrderId: `${clientOrderId}X`.slice(0, 36),
          }, testnet);
          closed = !!(close as any)?.success;
          if (!closed) closeErr = String((close as any)?.message || '');
        } catch (e: any) {
          closeErr = e?.message || String(e);
        }

        // ── **접수됐다와 없어졌다는 다르다** ──
        //
        // 거래소가 200을 줬다는 것은 주문을 받았다는 뜻이지, 포지션이
        // 사라졌다는 뜻이 아니다. 부분 체결로 끝나거나, 리스크 엔진이
        // 접수 직후 취소하거나, reduceOnly가 조용히 무시될 수 있다.
        //
        // 손절 부착 쪽은 이미 되읽어 확인한다(7-b). 되돌리기 쪽만
        // 안 하고 있었고, 그래서 화면에 "진입을 즉시 청산했습니다"가
        // 뜬 채로 포지션이 그대로 열려 있는 일이 생겼다. 그 문장은
        // 사용자가 더 확인하지 않게 만들기 때문에 특히 나쁘다.
        if (closed) {
          try {
            const after = await bf.getSymbolPositionRiskEx(apiKey, apiSecret, plan.symbol, testnet);
            const left = after.risk ? Math.abs(Number(after.risk.positionAmt) || 0) : null;
            if (left != null && left > 0) {
              closed = false;
              closeErr = `청산 주문은 접수됐는데 포지션이 ${left} 남아 있습니다`;
            }
            // 조회 자체가 실패하면 **확인하지 못한 것**이다. 접수만 보고
            // '닫았다'고 단정하지 않는다.
            else if (after.error) {
              closed = false;
              closeErr = `청산 주문은 접수됐지만 실제로 닫혔는지 확인하지 못했습니다 (${after.error})`;
            }
          } catch (e: any) {
            closed = false;
            closeErr = `청산 주문은 접수됐지만 확인에 실패했습니다 (${e?.message || e})`;
          }
        }

        // ── 닫기가 실패했다면 **정말 열려 있는지 확인한다** ──
        //
        // -2022(ReduceOnly Order is rejected)는 대부분 "줄일 포지션이
        // 없다"는 뜻이다. 진입이 체결되지 않았거나 이미 닫힌 경우다.
        // 그런데 예전에는 닫기 실패를 곧바로 "손절 없는 포지션이 열려
        // 있습니다"로 적었다. 없는 포지션을 찾으라고 보내는 것이고,
        // 사용자는 거래소를 뒤지다가 아무것도 못 찾는다.
        //
        // 반대로 정말 열려 있으면 수량을 거래소에서 읽어 **그 수량으로**
        // 한 번 더 닫는다. 우리가 들고 있던 res.qty가 부분 체결이나
        // 반올림으로 실제와 다르면 reduceOnly가 거절된다.
        let posAmt: number | null = null;
        let posErr = '';
        if (!closed) {
          try {
            const { risk, error } = await bf.getSymbolPositionRiskEx(apiKey, apiSecret, plan.symbol, testnet);
            if (error) posErr = error;
            else posAmt = risk ? Math.abs(Number(risk.positionAmt) || 0) : 0;
          } catch (e: any) { posErr = String(e?.message || e); }

          if (posAmt != null && posAmt > 0) {
            try {
              const retry = await bf.placeFuturesOrder(apiKey, apiSecret, {
                symbol: plan.symbol, side: closeSide, type: 'MARKET',
                quantity: posAmt, reduceOnly: true,
                clientOrderId: `${clientOrderId}Y`.slice(0, 36),
              }, testnet);
              if ((retry as any)?.success) { closed = true; closeErr = ''; }
              else closeErr = `${closeErr} · 실제 수량(${posAmt})으로 재시도도 실패: ${(retry as any)?.message || ''}`;
            } catch (e: any) {
              closeErr = `${closeErr} · 재시도 실패: ${e?.message || e}`;
            }
          } else if (posAmt === 0) {
            // 열린 포지션이 없다. 되돌릴 것이 없으므로 '닫았다'와 같다 —
            // 다만 문구는 사실대로 적는다(아래 detail에서 구분한다).
            closed = true;
            closeErr = '';
          }
        }

        const detail = `손절 부착 실패(${slError})`;
        if (closed) {
          await update({ status: 'FAILED', error_message: `${detail} — 포지션을 즉시 청산했습니다` });
          return {
            ok: false, status: 'FAILED', clientOrderId,
            exchangeOrderId: String(res.orderId), filledQty: res.qty, avgPrice: res.price,
            tpOrderId: tpId,
            message: posAmt === 0
              // 되돌릴 것이 없었다. '청산했다'고 적으면 하지도 않은 일을
              // 했다고 말하는 것이고, 사용자는 체결된 줄 안다.
              ? `${detail}. 거래소에 열린 포지션이 없어 되돌릴 것이 없었습니다 — 진입은 체결되지 않았습니다.`
              : `${detail}. 손절 없는 포지션을 남기지 않기 위해 진입을 즉시 청산했습니다.`,
          };
        }

        // 청산까지 실패 — 사람이 개입해야 한다
        //
        // **포지션이 열려 있다고 단정하려면 확인했어야 한다.** 확인하지
        // 못했으면 그렇게 적는다 — 없는 포지션을 찾으라고 보내면 사용자는
        // 거래소를 뒤지다가 아무것도 못 찾고, 다음부터 이 경고를 안 믿는다.
        const posLine = posAmt != null && posAmt > 0
          ? `손절 없는 포지션 ${posAmt}이(가) 열려 있습니다 — 거래소에서 직접 닫으세요.`
          : posErr
            ? `포지션이 열렸는지 확인하지 못했습니다(${posErr}) — 거래소에서 직접 확인하세요.`
            : '거래소에서 직접 확인하세요.';
        await update({ status: 'UNKNOWN', error_message: `${detail}, 자동 청산도 실패(${closeErr})` });
        return {
          ok: false, status: 'UNKNOWN', clientOrderId,
          exchangeOrderId: String(res.orderId), filledQty: res.qty, avgPrice: res.price,
          tpOrderId: tpId,
          message: `⚠️ 긴급: ${detail}이고 자동 청산도 실패했습니다(${closeErr}). ${posLine}`,
        };
      }

      const exitNote = args.exitPlan
        ? ` · 분할익절 ${tpIds.length}/${args.exitPlan.orders.filter(o => o.kind === 'PARTIAL_TP').length}건` +
          (args.exitPlan.trailingQty > 0 ? ` · 잔량 ${args.exitPlan.trailingQty}는 트레일링 대기` : '')
        : '';

      return {
        ok: true, status: 'ACKED', clientOrderId,
        exchangeOrderId: String(res.orderId), filledQty: res.qty, avgPrice: res.price,
        slOrderId: slId, tpOrderId: tpId,
        // 손절이 걸렸는지 **확인하지 못했으면** 그 사실을 메시지에 남긴다.
        // 조용히 지나가면 "접수됨"만 보이고, 사용자는 손절이 확인된 줄 안다.
        message: `주문 접수 (${plan.leverage}배 · ${plan.quantity})${exitNote}${stopCheckNote}`,
      };
    }

    // ── Gate ──
    //
    // 이 분기는 바이낸스 경로가 가진 보호를 하나도 갖고 있지 않았다:
    // 마진 모드 미확인 · 레버리지 설정 결과 무시 · 손절 미부착 ·
    // 수량을 Math.round(0.4 → 0, 1.6 → 2). 하나씩 채운다.
    const gf = await import('@/lib/exchanges/gateFutures');
    const gp = await import('@/lib/exchanges/gatePlan');
    const contract = gp.toGateContract(plan.symbol);
    if (!contract) {
      await update({ status: 'REJECTED', error_message: `Gate 계약 이름을 만들 수 없습니다 (${plan.symbol})` });
      return { ok: false, status: 'REJECTED', clientOrderId,
        message: `Gate 계약 이름을 만들 수 없습니다 (${plan.symbol})` };
    }

    // ── 수량: 기초자산 → 정수 계약 ──
    //
    // **여기가 Gate 주문이 BTC에서 한 번도 나가지 못한 이유였다.**
    //
    // `plan.quantity`는 저장소 전체에서 기초자산 수량이다(0.05 BTC). 그런데
    // Gate의 `size`는 정수 계약 수이고, 1계약이 몇 개인지는 계약마다 다르다 —
    // BTC_USDT는 0.0001이다. 예전 코드는 그 배수를 읽지 않고 0.05를 그대로
    // 계약 수로 보고 내림했다. floor(0.05) = 0 → "1계약 미만입니다"로 거부.
    // 실제로는 500계약이었어야 했다.
    //
    // SOL_USDT처럼 배수가 1인 계약에서는 우연히 맞았다. 그래서 "어떤 종목은
    // 되고 BTC만 안 되는" 모양이었고 원인을 짚을 단서가 없었다.
    //
    // **규격을 못 읽으면 주문하지 않는다.** 배수를 1로 가정하면 이번엔 반대로
    // 10000배가 나간다.
    const gspec = await gf.getGateContractSpec(contract, testnet);
    const sized = gp.gateSizeFromBase(plan.quantity, plan.side, gspec);
    if (!sized.ok) {
      await update({ status: 'REJECTED', error_message: sized.reason });
      return { ok: false, status: 'REJECTED', clientOrderId, message: sized.reason };
    }

    // 손절 방향을 미리 검사한다. 주문을 낸 뒤에 알면 이미 늦다.
    // 규격을 함께 넘겨 트리거 가격을 호가 단위에 맞춘다 — 안 맞추면
    // "trigger.price is not an integer multiple of a price unit"로 거부되고,
    // 그러면 진입은 성공한 뒤 손절만 실패해 포지션을 되돌리게 된다.
    const stopSpec = gp.gateStopSpec(plan.side, args.stopLoss ?? null, null, gspec);
    if (!args.reduceOnly && !stopSpec.ok) {
      await update({ status: 'REJECTED', error_message: stopSpec.reason });
      return { ok: false, status: 'REJECTED', clientOrderId,
        message: `손절을 걸 수 없어 진입하지 않습니다 — ${stopSpec.reason}` };
    }

    // 중복 확인. **조회에 실패하면 보내지 않는다.**
    // "없음"과 "확인 못 함"을 같이 취급하면, 레이트리밋 한 번이 중복 체결이
    // 된다 (바이낸스 경로와 같은 규칙).
    const lookup = await gf.findOrderByClientIdGateFutures(apiKey, apiSecret, contract, clientOrderId, testnet);
    if (!lookup.ok) {
      const msg = `중복 확인 실패로 주문 중단: ${lookup.error || '조회 실패'}`;
      await update({ status: 'FAILED', error_message: msg });
      return { ok: false, status: 'FAILED', clientOrderId, message: msg };
    }
    if (lookup.order) {
      const existing = lookup.order;
      await update({ status: 'RECONCILED', exchange_order_id: String(existing.id), reconciled_at: new Date().toISOString() });
      return { ok: true, status: 'RECONCILED', clientOrderId, exchangeOrderId: String(existing.id),
        duplicate: true, message: '거래소에 이미 존재하는 주문' };
    }

    // ── 레버리지 + 격리 확인 ──
    // 결과를 버리지 않는다. Gate에서 leverage=0은 교차 마진이고, 교차면 한
    // 종목의 손실이 지갑 전체로 번진다 (바이낸스 경로의 ISOLATED 강제와 같은 이유).
    // 청산 주문은 건너뛴다 — 나가는 주문에 배율을 다시 설정할 이유가 없다.
    if (!args.reduceOnly) {
      const lev = await gf.setLeverageGateFutures(apiKey, apiSecret, contract, plan.leverage, testnet);
      if (!lev.success) {
        await update({ status: 'REJECTED', error_message: lev.message });
        return { ok: false, status: 'REJECTED', clientOrderId,
          message: `Gate 배율·마진 모드를 확정하지 못해 주문을 중단합니다 — ${lev.message}` };
      }
    }

    // 진입 직전 포지션 수량을 남긴다. UNKNOWN이 됐을 때 교차 확인의 기준값이다.
    let gatePosBefore: number | null = null;
    try {
      const before = await gf.getPositionGateFutures(apiKey, apiSecret, contract, testnet);
      gatePosBefore = before ? Number(before.size) || 0 : 0;
    } catch { /* 조회 실패 시 null — 교차 확인 없이 판단하게 된다 */ }

    await update({
      status: 'SENT', sent_at: new Date().toISOString(), attempt_count: 1,
      pos_qty_before: gatePosBefore,
    });

    let gres: any;
    try {
      gres = await gf.placeOrderGateFutures(apiKey, apiSecret, {
        contract,
        size: sized.size,
        price: orderType === 'LIMIT' ? String(args.limitPrice) : '0',
        tif: orderType === 'LIMIT' ? 'gtc' : 'ioc',
        reduceOnly: !!args.reduceOnly,
        clientOrderId,
      }, testnet);
    } catch (e: any) {
      await update({ status: 'UNKNOWN', error_message: `응답 없음: ${e?.message || e}` });
      return { ok: false, status: 'UNKNOWN', clientOrderId, message: '응답 없음 — 대조 필요' };
    }

    // ── 체결됐는가 ──
    //
    // 시장가는 `tif: 'ioc'`로 나간다. 유동성이 없으면 Gate는 200 + `finished`에
    // `left`(미체결 수량)를 그대로 담아 돌려준다 — "정상 처리됐고 하나도 안
    // 붙었다"는 뜻이다. 이걸 ACKED로 기록하면 없는 포지션에 손절을 걸려 하고,
    // 화면에는 손절 실패라는 엉뚱한 이유가 뜬다.
    const fill = gp.gateFillOf(gres);
    if (fill.unfilled) {
      await update({ status: 'REJECTED', exchange_order_id: String(gres?.id ?? ''),
        filled_qty: 0, error_message: fill.reason });
      return { ok: false, status: 'REJECTED', clientOrderId,
        exchangeOrderId: gres?.id != null ? String(gres.id) : undefined, filledQty: 0,
        message: `체결되지 않았습니다 — ${fill.reason}` };
    }

    await update({
      status: 'ACKED', exchange_order_id: String(gres?.id ?? ''),
      acked_at: new Date().toISOString(),
      // 못 읽었으면 적지 않는다 — 0으로 적으면 '체결 없음'이 사실이 된다
      ...(fill.filledQty != null ? { filled_qty: fill.filledQty } : {}),
      ...(fill.avgPrice != null ? { avg_price: fill.avgPrice } : {}),
    });

    // ── 손절 부착 ──
    //
    // 청산 주문에는 붙이지 않는다. 진입에는 반드시 붙이고, **실패하면 방금 연
    // 포지션을 즉시 닫는다** — 감사 지적 3번과 같은 규칙이다. 포지션 크기는
    // 손절이 있다는 전제로 계산됐으므로, 그 전제가 없으면 크기를 정당화할
    // 근거가 사라진다.
    //
    // Gate의 price_orders 호출은 실계좌로 검증되지 않았다. 그래서 이 되돌리기가
    // 특히 중요하다 — API 모양이 틀렸더라도 결과는 '보호 없는 포지션'이 아니라
    // '포지션 없음 + 실패 보고'가 된다.
    let gateSlId: string | undefined;
    if (!args.reduceOnly && args.stopLoss && policy !== 'NONE') {
      // spec을 통째로 넘긴다. 예전에는 rule·autoSize만 spec에서 꺼내고
      // triggerPrice는 원본 손절가를 넘겨서, 호가 단위에 맞춰 둔 값이
      // 아무 데도 안 쓰였다 — 계산해 놓고 배선을 안 한 것이다.
      const sl = await gf.placeStopGateFutures(apiKey, apiSecret, {
        contract, spec: stopSpec, clientOrderId: `${clientOrderId}SL`,
      }, testnet);

      if (sl.success) {
        gateSlId = sl.orderId;
        await update({ sl_order_id: sl.orderId ?? null });
      } else if (policy !== 'REQUIRED') {
        // 수동 진입 — 되돌리지 않는다. 사람이 보고 있고, 되돌리면 그 사람이
        // 의도한 포지션이 수수료만 남기고 사라진다. 대신 크게 알린다.
        const warn = `⚠ 진입은 체결됐지만 요청한 손절이 등록되지 않았습니다 (${sl.message})`
          + '. **지금 보호되지 않은 포지션입니다** — 거래소에서 직접 손절을 걸거나 포지션을 닫으세요.';
        await update({ status: 'ACKED', error_message: warn });
        return {
          ok: true, status: 'ACKED', clientOrderId,
          exchangeOrderId: gres?.id != null ? String(gres.id) : undefined,
          filledQty: fill.filledQty ?? undefined,
          avgPrice: fill.avgPrice ?? undefined,
          unprotected: true, message: warn,
        };
      } else {
        const undo = await gf.closePositionGateFutures(apiKey, apiSecret, contract, testnet);
        const msg = `손절을 걸지 못해 포지션을 되돌렸습니다 — ${sl.message}`
          + (undo.success ? '' : ` / ⚠ 되돌리기도 실패: ${undo.message} — 거래소에서 직접 확인하세요`);
        await update({ status: 'FAILED', error_message: msg });
        return { ok: false, status: 'FAILED', clientOrderId,
          exchangeOrderId: String(gres?.id), message: msg };
      }
    }

    return {
      ok: true, status: 'ACKED', clientOrderId,
      exchangeOrderId: gres?.id != null ? String(gres.id) : undefined,
      filledQty: fill.filledQty ?? undefined,
      avgPrice: fill.avgPrice ?? undefined,
      slOrderId: gateSlId,
      message: `주문 접수 (Gate · ${sized.size}계약 = ${plan.quantity} ${plan.symbol.replace(/USDT$/, '')})`
        + (sized.reason ? ` · ${sized.reason}` : '')
        + (stopSpec.note ? ` · ${stopSpec.note}` : '')
        + (fill.filledQty != null && fill.filledQty < Math.abs(sized.size)
            ? ` · 부분 체결 ${fill.filledQty}/${Math.abs(sized.size)}` : '')
        + (gateSlId ? ' · 손절 부착' : ''),
    };

  } catch (e: any) {
    await update({ status: 'FAILED', error_message: e?.message || String(e) });
    return { ok: false, status: 'FAILED', clientOrderId, message: e?.message || '주문 실패' };
  }
}

// ── 재시작 복구: UNKNOWN/SENT 상태 주문을 거래소와 대조 ──
//
// 예전 구현은 "거래소에 주문이 안 보이면 전송되지 않은 것"으로 즉시 FAILED를
// 찍었다. 그런데 거래소가 아직 반영을 못 했거나, 조회가 실패했거나, 우리가
// 멱등 키를 안 붙여 식별을 못 하는 경우도 전부 "안 보임"으로 들어온다.
// FAILED로 찍히면 재시도가 열리고, 그 재시도가 그대로 중복 체결이 된다.
//
// 판단 규칙은 unknownResolver.ts(순수 함수)로 옮겼다. 여기서는 조회만 해서
// 넘긴다 — 규칙이 코드 안에 흩어져 있으면 테스트로 확인할 수가 없다.
export interface ReconcileResult {
  checked: number; resolved: number; stillUnknown: number;
  /** 자동 판단이 불가능해 사람이 봐야 하는 건수 */
  needsAttention: number;
  details: string[];
}

/**
 * **확정된 뒤에 손절이 없으면 지금 건다.**
 *
 * 왜 필요한가 — 실제로 이렇게 됐다
 * ─────────────────────────────────
 * 진입 요청이 응답을 못 받으면 executeOrder는 UNKNOWN으로 기록하고 **즉시
 * 반환한다.** 그 자리에서 끝나므로 손절 부착 단계는 **한 번도 실행되지
 * 않는다.** 그런데 주문은 거래소에 실제로 들어가 있을 수 있다.
 *
 * 그러면 이런 상태가 남는다:
 *
 *   거래소:  Positions (1) · Orders (0)     ← 포지션은 있고 손절은 없다
 *   앱:      UNKNOWN → 나중에 RECONCILED
 *
 * 대조는 주문 상태만 맞추고 끝났다. **보호되지 않은 포지션이 그대로
 * 남는다** — 그리고 아무도 그걸 다시 걸어 주지 않았다.
 *
 * 규칙
 * ────
 * · 포지션이 **실제로 있을 때만** 건다. 없는 포지션에 손절을 걸면 다음
 *   진입을 예상치 못하게 닫는다
 * · 계획에 손절가가 적혀 있을 때만 건다. 없는 값을 지어내지 않는다
 * · 실패해도 포지션을 되돌리지 않는다. 여기는 **복구**이지 진입이 아니고,
 *   이미 열려 있는 것을 닫는 판단은 사람의 몫이다. 대신 그 사실을 남긴다
 */
async function attachStopIfMissing(
  sb: any,
  creds: { exchange: 'binance' | 'gate'; apiKey: string; apiSecret: string; testnet: boolean },
  o: any,
): Promise<string | null> {
  // 청산 주문에는 보호주문을 붙이지 않는다.
  if (o?.reduce_only) return null;
  if (o?.sl_order_id) return null;               // 이미 걸려 있다
  const stop = Number(o?.stop_loss);
  if (!Number.isFinite(stop) || stop <= 0) return null;   // 계획에 없던 값

  const symbol = String(o?.symbol || '').toUpperCase();
  if (!symbol) return null;
  // 진입 방향. BUY로 들어갔으면 롱이고, 닫는 주문은 SELL이다.
  const posSide: 'LONG' | 'SHORT' = String(o?.side).toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
  const closeSide: 'BUY' | 'SELL' = posSide === 'LONG' ? 'SELL' : 'BUY';

  try {
    if (creds.exchange === 'gate') {
      const gf = await import('@/lib/exchanges/gateFutures');
      const gp = await import('@/lib/exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return null;

      // **포지션이 실제로 있는지 먼저 본다.**
      const pos = await gf.getPositionGateFutures(creds.apiKey, creds.apiSecret, contract, creds.testnet);
      const size = Number(pos?.size ?? 0);
      if (!size) return null;                     // 포지션 없음 — 걸 이유가 없다
      // 방향이 어긋나면 걸지 않는다. 반대 방향 손절은 즉시 발동한다.
      if ((size > 0 ? 'LONG' : 'SHORT') !== posSide) {
        return `손절 복구 안 함 — 기록은 ${posSide}인데 거래소 포지션은 ${size > 0 ? 'LONG' : 'SHORT'}입니다`;
      }

      const spec = await gf.getGateContractSpec(contract, creds.testnet);
      const stopSpec = gp.gateStopSpec(posSide, stop, null, spec);
      if (!stopSpec.ok) return `손절 복구 실패 — ${stopSpec.reason}`;

      const sl = await gf.placeStopGateFutures(creds.apiKey, creds.apiSecret, {
        contract, spec: stopSpec, clientOrderId: `${o.client_order_id}R`,
      }, creds.testnet);
      if (!sl.success) return `손절 복구 실패 — ${sl.message}`;
      await updateOrderRow(sb, o.id, { sl_order_id: sl.orderId ?? null });
      return `손절 복구 완료 (${stopSpec.triggerPrice})`;
    }

    const bf = await import('@/lib/exchanges/binanceFutures');
    const rr = await bf.getSymbolPositionRiskEx(creds.apiKey, creds.apiSecret, symbol, creds.testnet);
    const amt = Number(rr.risk?.positionAmt ?? 0);
    if (!amt) return null;
    if ((amt > 0 ? 'LONG' : 'SHORT') !== posSide) {
      return `손절 복구 안 함 — 기록은 ${posSide}인데 거래소 포지션은 ${amt > 0 ? 'LONG' : 'SHORT'}입니다`;
    }

    const sl: any = await bf.placeFuturesTPSL(creds.apiKey, creds.apiSecret, {
      symbol, side: closeSide, stopPrice: stop, type: 'STOP_MARKET',
      fallbackQuantity: Math.abs(amt),
    }, creds.testnet);
    if (!sl?.success) return `손절 복구 실패 — ${sl?.message || '원인 불명'}`;
    await updateOrderRow(sb, o.id, { sl_order_id: String(sl.orderId) });
    return `손절 복구 완료 (${stop})`;
  } catch (e: any) {
    return `손절 복구 실패 — ${e?.message || e}`;
  }
}

export async function reconcilePendingOrders(
  sb: any,
  creds: {
    exchange: 'binance' | 'gate'; apiKey: string; apiSecret: string; testnet: boolean;
    /**
     * **누구의 주문을 대조하는가.**
     *
     * 이게 없어서 이 함수는 `status IN (SENT, UNKNOWN) AND exchange = 'binance'`로
     * **모든 사용자의 주문**을 긁어 왔다. 그리고 그것을 **한 사람의 API 키**로
     * 거래소에 물어봤다. 남의 주문은 이 계좌에 있을 리 없으니 "거래소에
     * 없음"으로 판정되고, 그 판정이 남의 행에 쓰인다.
     *
     * 서버 전용 경로라 외부에서 부를 수는 없지만, 한 사용자의 대조가 다른
     * 사용자의 장부를 바꾸는 것은 그 자체로 사고다.
     */
    userId?: string | null;
    /**
     * 어느 연결의 주문인가. 연결이 곧 거래소이자 망(실전/테스트넷)이다.
     *
     * 없으면 테스트넷에서 만든 주문을 실전 거래소에 물어보게 되고,
     * 거래소는 모른다고 답한다 — 그 기록은 영영 확정되지 않고 상태
     * 대조를 영구히 막는다. 실제로 이 계좌가 그 상태였다.
     */
    connectionId?: string | null;
  }
): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, resolved: 0, stillUnknown: 0, needsAttention: 0, details: [] };

  // **ACKED가 빠져 있었다.**
  //
  // ACKED는 "거래소가 접수했다"는 상태다. 그 뒤 체결·취소로 넘어가는
  // 경로가 아무 데도 없어서, 한번 ACKED가 된 주문은 영원히 ACKED로
  // 남았다. 그런데 상태 대조는 ACKED를 "열려 있는 주문"이자 (수량이
  // 있으면) "보유 중인 포지션"으로 읽는다.
  //
  // 결과: 거래소에는 아무것도 없는데 앱은 계속 있다고 믿고, **신규
  // 진입이 영구히 막힌다.** [미확정 주문 확정]을 눌러도 안 풀렸다 —
  // 그 버튼이 여기를 부르는데 ACKED를 조회하지 않았으니까.
  let q = sb.from('live_orders')
    .select('*')
    .in('status', ['SENT', 'UNKNOWN', 'ACKED'])
    .eq('exchange', creds.exchange);
  // **모르면 좁히지 않는다.** 좁히지 않으면 과하게 대조할 뿐이지만,
  // 잘못 좁히면 진짜 미확정 주문을 놓친다.
  if (creds.userId) q = q.eq('user_id', creds.userId);
  if (creds.connectionId) q = q.eq('connection_id', creds.connectionId);

  const { data: pending } = await q
    .order('created_at', { ascending: true })
    .limit(50);

  if (!Array.isArray(pending) || !pending.length) return out;

  const { resolveUnknown, resolveAcked, shouldEscalate } = await import('./unknownResolver');

  // 포지션은 심볼마다 다시 부르지 않고 한 번만 읽는다. 대조 한 번에 50건이
  // 들어올 수 있어 건마다 부르면 레이트리밋에 걸린다.
  let posBySymbol: Map<string, number> | null = null;
  if (creds.exchange === 'binance') {
    try {
      const bf = await import('@/lib/exchanges/binanceFutures');
      const pr: any = await bf.getFuturesPositions(creds.apiKey, creds.apiSecret, creds.testnet);
      if (pr?.success) {
        posBySymbol = new Map(
          (pr.positions as any[]).map((p: any) => [String(p.symbol).toUpperCase(), Number(p.amount) || 0]),
        );
      }
    } catch { posBySymbol = null; }   // null이면 교차 확인 불가로 취급된다
  } else {
    // Gate도 교차 확인을 한다. 예전에는 이 분기가 없어서 '주문이 안 보임'만으로
    // 판단했다 — 조회가 늦게 반영되는 거래소에서 그건 중복 주문의 근거가 된다.
    try {
      const gf = await import('@/lib/exchanges/gateFutures');
      const rows = await gf.getPositionsGateFutures(creds.apiKey, creds.apiSecret, creds.testnet);
      posBySymbol = new Map(
        rows.map((p: any) => [String(p.contract || '').replace('_', '').toUpperCase(), Number(p.size) || 0]),
      );
    } catch { posBySymbol = null; }
  }

  for (const o of pending) {
    out.checked++;
    const attempts = Number(o.resolve_attempts) || 0;
    try {
      if (creds.exchange === 'binance') {
        const bf = await import('@/lib/exchanges/binanceFutures');

        // findOrderByClientId는 "없음"(-2013)만 found:false로 돌려주고 그 외
        // 오류는 던진다. 던진 것은 조회 실패이지 주문 없음이 아니다.
        let query: { ok: boolean; order: any | null; error?: string };
        try {
          const r = await bf.findOrderByClientId(
            creds.apiKey, creds.apiSecret, o.symbol, o.client_order_id, creds.testnet);
          query = { ok: true, order: r.found ? r.order : null };
        } catch (e: any) {
          query = { ok: false, order: null, error: e?.message || String(e) };
        }

        const sentAt = o.sent_at || o.created_at;
        const elapsedMs = sentAt ? Date.now() - new Date(sentAt).getTime() : 0;

        // 기준값이 없으면 비교 자체가 불가능하므로 교차 확인을 생략한다
        // (018 이전에 만들어진 행). 그 사실은 확정 사유에 남는다.
        const before = o.pos_qty_before;
        const position = before === null || before === undefined ? undefined : {
          qtyBefore: Number(before),
          qtyNow: posBySymbol ? (posBySymbol.get(String(o.symbol).toUpperCase()) ?? 0) : null,
        };

        // **상태마다 규칙이 다르다.**
        // SENT/UNKNOWN은 "보냈는지도 모르는" 상태라, 주문이 안 보이면
        // 전송 안 됨(FAILED)으로 확정할 수 있다.
        // ACKED는 거래소가 이미 받았다고 확인해 준 상태다. 지금 안 보이는
        // 것은 "안 들어갔다"가 아니라 "이미 끝났다"이므로 FAILED로 찍으면
        // 장부가 거짓말을 하고, FAILED는 재시도가 열리는 상태라 중복
        // 체결의 문이 된다.
        const args = { clientOrderId: o.client_order_id || null, elapsedMs, query, position };
        const verdict = String(o.status) === 'ACKED'
          ? resolveAcked(args)
          : resolveUnknown(args);

        if (verdict.resolved) {
          const st = verdict.state === 'FILLED' ? 'FILLED'
            : verdict.state === 'FAILED' ? 'FAILED'
            : verdict.state === 'REJECTED' ? 'REJECTED'
            : 'RECONCILED';
          await updateOrderRow(sb, o.id, {
            status: st,
            exchange_order_id: query.order?.orderId != null ? String(query.order.orderId) : o.exchange_order_id,
            filled_qty: query.order ? parseFloat(query.order.executedQty || '0') : o.filled_qty,
            avg_price: query.order ? parseFloat(query.order.avgPrice || '0') : o.avg_price,
            error_message: verdict.resolved && st === 'FAILED' ? verdict.reason : o.error_message,
            reconciled_at: new Date().toISOString(),
            resolve_attempts: attempts + 1,
            last_resolve_at: new Date().toISOString(),
            needs_attention: false,
          });
          out.resolved++;
          out.details.push(`${o.symbol} ${o.client_order_id} → ${verdict.state} (${verdict.reason})`);
          // **확정만 하고 끝내지 않는다.** 응답을 못 받아 UNKNOWN이 된
          // 주문은 손절 부착 단계에 도달한 적이 없다 — 포지션은 열렸는데
          // 보호가 없는 상태로 남는다. 여기서 한 번 더 건다.
          if (st === 'FILLED' || st === 'RECONCILED') {
            const rep = await attachStopIfMissing(sb, creds, o);
            if (rep) out.details.push(`${o.symbol} ${rep}`);
          }
        } else {
          // 확정 못 함. 시도 횟수가 넘었거나 모순이면 사람에게 넘긴다.
          const escalate = verdict.action === 'ESCALATE' || shouldEscalate(attempts + 1);
          await updateOrderRow(sb, o.id, {
            status: 'UNKNOWN',
            error_message: verdict.reason,
            resolve_attempts: attempts + 1,
            last_resolve_at: new Date().toISOString(),
            needs_attention: escalate,
          });
          out.stillUnknown++;
          if (escalate) out.needsAttention++;
          out.details.push(
            `${o.symbol} ${o.client_order_id} → 미확정${escalate ? ' ⚠ 사람 확인 필요' : ''} (${verdict.reason})`);
        }
      } else {
        const gf = await import('@/lib/exchanges/gateFutures');
        const gp = await import('@/lib/exchanges/gatePlan');
        // 계약 이름 변환은 toGateContract 한 곳에만 둔다. 예전에는 여기서
        // `replace('USDT','_USDT')`를 직접 했다 — 소문자 심볼이나 USDT가 앞에
        // 오는 이름에서 다른 결과가 나온다.
        const contract = gp.toGateContract(o.symbol);
        const hit = await gf.findOrderByClientIdGateFutures(
          creds.apiKey, creds.apiSecret, contract, o.client_order_id, creds.testnet);

        const sentAt = o.sent_at || o.created_at;
        const elapsedMs = sentAt ? Date.now() - new Date(sentAt).getTime() : 0;

        // 기준값이 없으면 비교가 불가능하므로 교차 확인을 생략한다 (바이낸스와 동일).
        const gBefore = o.pos_qty_before;
        const position = gBefore === null || gBefore === undefined ? undefined : {
          qtyBefore: Number(gBefore),
          qtyNow: posBySymbol ? (posBySymbol.get(String(o.symbol).toUpperCase()) ?? 0) : null,
        };

        const verdict = resolveUnknown({
          clientOrderId: o.client_order_id || null, elapsedMs,
          // 조회 실패를 '주문 없음'으로 넘기지 않는다 — resolveUnknown이
          // ok:false를 '확인 못 함'으로 다룬다.
          query: hit.ok
            ? { ok: true, order: hit.order ? { status: 'NEW', orderId: hit.order.id } : null }
            : { ok: false, order: null, error: hit.error },
          position,
        });

        if (verdict.resolved) {
          await updateOrderRow(sb, o.id, {
            status: verdict.state === 'FAILED' ? 'FAILED' : 'RECONCILED',
            exchange_order_id: hit.order ? String(hit.order.id) : o.exchange_order_id,
            error_message: verdict.state === 'FAILED' ? verdict.reason : null,
            reconciled_at: new Date().toISOString(),
            resolve_attempts: attempts + 1, last_resolve_at: new Date().toISOString(),
            needs_attention: false,
          });
          out.resolved++;
          out.details.push(`${o.symbol} ${o.client_order_id} → ${verdict.state} (Gate)`);
          // 실패로 확정된 것은 포지션이 없다. 그 외에는 열려 있을 수 있으므로
          // 손절이 비어 있으면 지금 건다 — attachStopIfMissing이 포지션
          // 존재를 다시 확인한다.
          if (verdict.state !== 'FAILED') {
            const rep = await attachStopIfMissing(sb, creds, o);
            if (rep) out.details.push(`${o.symbol} ${rep}`);
          }
        } else {
          const escalate = verdict.action === 'ESCALATE' || shouldEscalate(attempts + 1);
          await updateOrderRow(sb, o.id, {
            status: 'UNKNOWN', error_message: verdict.reason,
            resolve_attempts: attempts + 1, last_resolve_at: new Date().toISOString(),
            needs_attention: escalate,
          });
          out.stillUnknown++;
          if (escalate) out.needsAttention++;
          out.details.push(`${o.symbol} ${o.client_order_id} → 미확정 (Gate: ${verdict.reason})`);
        }
      }
    } catch (e: any) {
      out.stillUnknown++;
      out.details.push(`${o.symbol} ${o.client_order_id} → 대조 실패: ${e?.message || e}`);
    }
  }
  return out;
}
