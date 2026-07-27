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

export type OrderStatus = 'INTENT' | 'SENT' | 'ACKED' | 'FILLED' | 'REJECTED' | 'FAILED' | 'UNKNOWN' | 'RECONCILED';

export interface ExecuteArgs {
  userId?: string | null;
  connectionId?: string | null;
  signalId: string;
  clientOrderId: string;
  exchange: 'binance' | 'gate';
  mode: 'TESTNET' | 'LIVE';
  plan: PositionPlan;
  stopLoss?: number;
  takeProfit?: number;
  apiKey: string;
  apiSecret: string;
}

export interface ExecuteResult {
  ok: boolean;
  status: OrderStatus;
  clientOrderId: string;
  exchangeOrderId?: string;
  filledQty?: number;
  avgPrice?: number;
  slOrderId?: string;
  tpOrderId?: string;
  message: string;
  duplicate?: boolean;
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
  const side: 'BUY' | 'SELL' = plan.side === 'LONG' ? 'BUY' : 'SELL';

  // ── 0) 사전 안전 검사 — 잘못된 값이 거래소로 나가지 않게 ──
  if (!plan.approved) {
    return { ok: false, status: 'REJECTED', clientOrderId, message: '승인되지 않은 계획은 주문할 수 없습니다' };
  }
  if (!isFinite(plan.quantity) || plan.quantity <= 0) {
    return { ok: false, status: 'REJECTED', clientOrderId, message: `주문 수량이 유효하지 않습니다 (${plan.quantity})` };
  }
  if (!isFinite(plan.leverage) || plan.leverage < 1) {
    return { ok: false, status: 'REJECTED', clientOrderId, message: `레버리지가 유효하지 않습니다 (${plan.leverage})` };
  }
  if (!clientOrderId || clientOrderId.length < 4) {
    return { ok: false, status: 'REJECTED', clientOrderId, message: 'clientOrderId가 없으면 중복 주문을 막을 수 없어 중단합니다' };
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
    order_type: 'MARKET',
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
  const update = async (patch: Record<string, any>) => {
    try { await sb.from('live_orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', orderRowId); } catch {}
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
        await update({ status: 'FAILED', error_message: `중복 확인 실패: ${e?.message || e}` });
        return { ok: false, status: 'FAILED', clientOrderId, message: `중복 확인 실패로 주문 중단: ${e?.message || e}` };
      }

      // ── 3) 마진 타입 ISOLATED 강제 (레버리지보다 먼저) ──
      //
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

      // ── 4) 레버리지 설정 (주문 전에 반드시) ──
      const lev = await bf.setFuturesLeverage(apiKey, apiSecret, plan.symbol, plan.leverage, testnet);
      if (!(lev as any)?.success) {
        await update({ status: 'FAILED', error_message: `레버리지 설정 실패: ${(lev as any)?.message}` });
        return { ok: false, status: 'FAILED', clientOrderId, message: `레버리지 설정 실패: ${(lev as any)?.message}` };
      }

      // ── 5) 주문 전송 ──
      await update({ status: 'SENT', sent_at: new Date().toISOString(), attempt_count: 1 });

      let res: any;
      try {
        res = await bf.placeFuturesOrder(apiKey, apiSecret, {
          symbol: plan.symbol, side, type: 'MARKET',
          quantity: plan.quantity, clientOrderId,
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
      if (args.stopLoss) {
        const sl = await bf.placeFuturesTPSL(apiKey, apiSecret, {
          symbol: plan.symbol, side: closeSide, stopPrice: args.stopLoss, type: 'STOP_MARKET',
        }, testnet);
        if ((sl as any)?.success) slId = String((sl as any).orderId);
        else slError = String((sl as any)?.message || '원인 불명');
      }
      if (args.takeProfit) {
        const tp = await bf.placeFuturesTPSL(apiKey, apiSecret, {
          symbol: plan.symbol, side: closeSide, stopPrice: args.takeProfit, type: 'TAKE_PROFIT_MARKET',
        }, testnet);
        if ((tp as any)?.success) tpId = String((tp as any).orderId);
      }
      await update({ sl_order_id: slId || null, tp_order_id: tpId || null });

      // ── 8) 손절이 안 붙었으면 포지션을 즉시 닫는다 ──
      //
      // 예전에는 경고 문자열만 message에 붙이고 ok:true로 반환했다. 그러면
      // 호출자는 성공으로 처리하는데 실제로는 손절 없는 포지션이 열려 있다.
      // 포지션 크기 자체가 "손절 거리"로 역산된 값이므로(허용손실 ÷ 손절거리),
      // 손절이 없으면 그 크기를 정당화하는 근거가 사라진다. 방치하면 계단식
      // 1회 증거금을 넘어 손실이 커질 수 있다.
      // 진입 근거가 사라졌으므로 되돌린다.
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

        const detail = `손절 부착 실패(${slError})`;
        if (closed) {
          await update({ status: 'FAILED', error_message: `${detail} — 포지션을 즉시 청산했습니다` });
          return {
            ok: false, status: 'FAILED', clientOrderId,
            exchangeOrderId: String(res.orderId), filledQty: res.qty, avgPrice: res.price,
            tpOrderId: tpId,
            message: `${detail}. 손절 없는 포지션을 남기지 않기 위해 진입을 즉시 청산했습니다.`,
          };
        }

        // 청산까지 실패 — 사람이 개입해야 한다
        await update({ status: 'UNKNOWN', error_message: `${detail}, 자동 청산도 실패(${closeErr})` });
        return {
          ok: false, status: 'UNKNOWN', clientOrderId,
          exchangeOrderId: String(res.orderId), filledQty: res.qty, avgPrice: res.price,
          tpOrderId: tpId,
          message: `⚠️ 긴급: ${detail}이고 자동 청산도 실패했습니다(${closeErr}). ` +
                   `손절 없는 포지션이 열려 있습니다 — 거래소에서 직접 확인하세요.`,
        };
      }

      return {
        ok: true, status: 'ACKED', clientOrderId,
        exchangeOrderId: String(res.orderId), filledQty: res.qty, avgPrice: res.price,
        slOrderId: slId, tpOrderId: tpId,
        message: `주문 접수 (${plan.leverage}배 · ${plan.quantity})`,
      };
    }

    // Gate
    const gf = await import('@/lib/exchanges/gateFutures');
    const contract = plan.symbol.replace('USDT', '_USDT').toUpperCase();

    const existing = await gf.findOrderByClientIdGateFutures(apiKey, apiSecret, contract, clientOrderId, testnet);
    if (existing) {
      await update({ status: 'RECONCILED', exchange_order_id: String(existing.id), reconciled_at: new Date().toISOString() });
      return { ok: true, status: 'RECONCILED', clientOrderId, exchangeOrderId: String(existing.id),
        duplicate: true, message: '거래소에 이미 존재하는 주문' };
    }

    await gf.setLeverageGateFutures(apiKey, apiSecret, contract, plan.leverage, testnet);
    await update({ status: 'SENT', sent_at: new Date().toISOString(), attempt_count: 1 });

    let gres: any;
    try {
      gres = await gf.placeOrderGateFutures(apiKey, apiSecret, {
        contract,
        size: plan.side === 'LONG' ? Math.round(plan.quantity) : -Math.round(plan.quantity),
        price: '0', tif: 'ioc', clientOrderId,
      }, testnet);
    } catch (e: any) {
      await update({ status: 'UNKNOWN', error_message: `응답 없음: ${e?.message || e}` });
      return { ok: false, status: 'UNKNOWN', clientOrderId, message: '응답 없음 — 대조 필요' };
    }

    await update({ status: 'ACKED', exchange_order_id: String(gres?.id), acked_at: new Date().toISOString() });
    return { ok: true, status: 'ACKED', clientOrderId, exchangeOrderId: String(gres?.id), message: '주문 접수 (Gate)' };

  } catch (e: any) {
    await update({ status: 'FAILED', error_message: e?.message || String(e) });
    return { ok: false, status: 'FAILED', clientOrderId, message: e?.message || '주문 실패' };
  }
}

// ── 재시작 복구: UNKNOWN/SENT 상태 주문을 거래소와 대조 ──
export interface ReconcileResult { checked: number; resolved: number; stillUnknown: number; details: string[] }

export async function reconcilePendingOrders(
  sb: any,
  creds: { exchange: 'binance' | 'gate'; apiKey: string; apiSecret: string; testnet: boolean }
): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, resolved: 0, stillUnknown: 0, details: [] };

  const { data: pending } = await sb.from('live_orders')
    .select('*')
    .in('status', ['SENT', 'UNKNOWN'])
    .eq('exchange', creds.exchange)
    .order('created_at', { ascending: true })
    .limit(50);

  if (!Array.isArray(pending) || !pending.length) return out;

  for (const o of pending) {
    out.checked++;
    try {
      if (creds.exchange === 'binance') {
        const bf = await import('@/lib/exchanges/binanceFutures');
        const r = await bf.findOrderByClientId(creds.apiKey, creds.apiSecret, o.symbol, o.client_order_id, creds.testnet);
        if (r.found) {
          const st = r.order?.status;
          await sb.from('live_orders').update({
            status: st === 'FILLED' ? 'FILLED' : 'RECONCILED',
            exchange_order_id: String(r.order?.orderId),
            filled_qty: parseFloat(r.order?.executedQty || '0'),
            avg_price: parseFloat(r.order?.avgPrice || '0'),
            reconciled_at: new Date().toISOString(),
          }).eq('id', o.id);
          out.resolved++;
          out.details.push(`${o.symbol} ${o.client_order_id} → ${st} (체결 ${r.order?.executedQty})`);
        } else {
          // 거래소에 없음 = 주문이 안 나갔음 → 안전하게 실패 처리
          await sb.from('live_orders').update({
            status: 'FAILED', error_message: '거래소에 주문 없음 — 전송되지 않은 것으로 확정',
            reconciled_at: new Date().toISOString(),
          }).eq('id', o.id);
          out.resolved++;
          out.details.push(`${o.symbol} ${o.client_order_id} → 미전송 확정`);
        }
      } else {
        const gf = await import('@/lib/exchanges/gateFutures');
        const contract = o.symbol.replace('USDT', '_USDT').toUpperCase();
        const hit = await gf.findOrderByClientIdGateFutures(creds.apiKey, creds.apiSecret, contract, o.client_order_id, creds.testnet);
        await sb.from('live_orders').update({
          status: hit ? 'RECONCILED' : 'FAILED',
          exchange_order_id: hit ? String(hit.id) : null,
          error_message: hit ? null : '거래소에 주문 없음',
          reconciled_at: new Date().toISOString(),
        }).eq('id', o.id);
        out.resolved++;
      }
    } catch (e: any) {
      out.stillUnknown++;
      out.details.push(`${o.symbol} ${o.client_order_id} → 대조 실패: ${e?.message || e}`);
    }
  }
  return out;
}
