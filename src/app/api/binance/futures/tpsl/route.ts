// /api/binance/futures/tpsl — TP/SL·트레일링 설정·교체. **Vercel에서 직접 실행한다.**
//
// POST {
//   connectionId, symbol, positionSide,
//   tpPrice?, slPrice?,
//   portionPct?,      // 1~100. 없거나 100이면 전량(closePosition)
//   trigger?,         // 'MARK' | 'LAST'. 기본 MARK
//   trailing?: { callbackRate, activationPrice? },
// }
//
// 예전에는 jobs 큐에 SET_TPSL을 적재했고 Worker만 실행했다. 그 워커를 쓰지 않게
// 된 뒤로 이 경로는 아무 일도 하지 않았다 — 손절을 옮겼다고 믿은 사용자에게는
// 가장 나쁜 실패다.
//
// 기존 TP/SL은 **전량 청산용(closePosition=true)만** 취소한다. 분할 익절
// 사다리와 다른 전략의 보호주문은 남긴다 (감사 지적 6번).
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { symbol, positionSide, tpPrice, slPrice } = body;
  const trailing = body?.trailing || null;
  if (!symbol || !positionSide) return NextResponse.json({ error: 'missing_params' }, { status: 400 });
  if (positionSide !== 'LONG' && positionSide !== 'SHORT') return NextResponse.json({ error: 'invalid_position_side' }, { status: 400 });
  if (tpPrice == null && slPrice == null && !trailing) {
    return NextResponse.json({ error: 'no_tp_sl', message: 'TP·SL 또는 트레일링 중 하나는 있어야 합니다' }, { status: 400 });
  }

  // **거래소를 가리지 않는다.**
  //
  // 예전에는 loadBinanceCreds라 Gate 연결이면 not_binance로 끝났다.
  // 그래서 Gate 사용자는 **앱에서 손절을 걸 방법이 아예 없었다** —
  // 거래소 앱으로 나가야 했고, 그 사이 포지션은 보호 없이 열려 있었다.
  //
  // 판정(방향·청산가 검사)은 거래소를 안 가린다. 갈라지는 것은
  // **읽는 쪽과 거는 쪽**뿐이다.
  const creds = await loadFuturesCreds(sb, uid, body.connectionId);
  if (!creds.ok) return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status });

  const want = String(symbol).toUpperCase().replace('/', '');

  // 포지션이 있어야 한다. 전량 종료 주문은 포지션 없이 걸면 거래소가
  // 거부하거나, 걸린 뒤 다음 진입을 예상치 못하게 닫는다.
  const { futuresPositionRisk } = await import('@/lib/exchanges/futuresAdapter');
  const rr = await futuresPositionRisk(creds.exchange!, creds.key!, creds.secret!, want, creds.testnet!);
  if (!rr.risk || rr.risk.positionAmt == null) {
    return NextResponse.json({
      ok: false, queued: false, error: 'position_lookup_failed',
      message: `포지션을 확인하지 못해 TP/SL을 걸지 않았습니다: ${rr.error || '사유 미상'}`,
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
  const amt = Number(rr.risk.positionAmt) || 0;
  if (Math.abs(amt) === 0) {
    return NextResponse.json({
      ok: false, queued: false, error: 'no_position',
      message: `${want} 포지션이 없습니다. TP/SL은 포지션이 있을 때만 걸 수 있습니다.`,
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  // 방향은 부호에서 뽑는다. **여기가 틀리면 손절이 익절 자리에 걸린다.**
  const pos = {
    side: amt > 0 ? 'LONG' : 'SHORT',
    amount: amt,
    markPrice: rr.risk.markPrice,
    liquidationPrice: rr.risk.liquidationPrice,
  };
  if (pos.side !== positionSide) {
    return NextResponse.json({
      ok: false, queued: false, error: 'side_mismatch',
      message: `방향 불일치 — 요청 ${positionSide}, 실제 ${pos.side}`,
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 보내기 전에 판단한다 ──
  //
  // 익절·손절은 **방향이 틀려도 거래소가 받아 준다.** 롱인데 손절을 현재가
  // 위에 걸면 주문은 정상 접수되고 다음 틱에 발동한다. 화면에는 그때까지
  // '설정됨'으로 떠 있다 — 사용자는 보호가 걸린 줄 안다.
  const {
    checkTakeProfit, checkStopLoss, checkTrailing, portionQty, normalizeTrigger,
  } = await import('@/lib/exchanges/tpslPlan');

  const ref = Number(pos.markPrice) > 0 ? Number(pos.markPrice) : null;
  const liq = Number(pos.liquidationPrice) > 0 ? Number(pos.liquidationPrice) : null;
  const workingType = normalizeTrigger(body?.trigger);

  const reject = (message: string, error = 'plan_rejected') =>
    NextResponse.json({ ok: false, queued: false, error, message, refPrice: ref, liquidationPrice: liq },
      { status: 400, headers: { 'Cache-Control': 'no-store' } });

  if (tpPrice != null && Number(tpPrice) > 0) {
    const v = checkTakeProfit(Number(tpPrice), ref, positionSide);
    if (!v.ok) return reject(v.reason);
  }
  if (slPrice != null && Number(slPrice) > 0) {
    const v = checkStopLoss(Number(slPrice), ref, positionSide, liq);
    if (!v.ok) return reject(v.reason);
  }
  if (trailing) {
    const v = checkTrailing(
      Number(trailing.callbackRate),
      trailing.activationPrice == null || trailing.activationPrice === '' ? null : Number(trailing.activationPrice),
      ref, positionSide);
    if (!v.ok) return reject(v.reason);
  }

  // 부분 수량. **전량은 null이다** — 0과 섞으면 거래소가 거부한다.
  const portion = portionQty(
    Math.abs(Number(pos.amount)),
    body?.portionPct == null || body.portionPct === '' ? null : Number(body.portionPct));
  if (portion.reason) return reject(portion.reason, 'invalid_portion');

  const exitSide: 'BUY' | 'SELL' = pos.side === 'LONG' ? 'SELL' : 'BUY';
  const out: { tp?: any; sl?: any; trail?: any } = {};
  let cancelled: any = null;

  if (creds.exchange === 'gate') {
    // ── Gate ──
    //
    // 조건부 주문이 별도 통(price_orders)에 있어 취소 경로도 다르다.
    // 그리고 **부분 수량과 트레일링은 아직 지원하지 않는다** —
    // 여기서 계약 수를 직접 계산해 넣으면 배수 오독이 그대로 수량
    // 오류가 되고, 그건 이미 한 번 밟은 자리다. 지원 안 하는 것을
    // 지원하는 척하지 않는다.
    if (portion.qty != null) {
      return reject('Gate는 아직 부분 TP/SL을 지원하지 않습니다 — 전량으로 거세요', 'gate_no_portion');
    }
    if (trailing) {
      return reject('Gate는 아직 트레일링 손절을 지원하지 않습니다', 'gate_no_trailing');
    }

    const gp = await import('@/lib/exchanges/gatePlan');
    const gf = await import('@/lib/exchanges/gateFutures');
    const contract = gp.toGateContract(want);
    if (!contract) return reject(`Gate 계약 이름을 만들 수 없습니다 (${want})`, 'gate_contract');

    // 기존 보호 주문을 먼저 지운다. 안 지우면 손절이 두 개 걸린다.
    const { futuresCancelProtection } = await import('@/lib/exchanges/futuresAdapter');
    const cp = await futuresCancelProtection(creds.exchange!, creds.key!, creds.secret!, creds.testnet!, want);
    cancelled = { cancelled: cp.cancelled };

    const spec = await gf.getGateContractSpec(contract, creds.testnet!);

    const place = async (price: number, kind: 'SL' | 'TP') => {
      // rule·autoSize·triggerPrice를 한 덩어리로 만든다. 예전에 이 셋을
      // 따로 넘기다가 triggerPrice만 반올림 전 값이 나가 Gate가 400을
      // 돌려준 적이 있다 — 그래서 spec 객체 하나로 받는다.
      //
      // **손절과 익절은 부등호가 반대라 함수가 다르다.** 손절 함수로
      // 익절을 만들면 롱의 익절이 현재가 아래에 걸려, 오르지 않고
      // 조금만 내려도 '익절'이라는 이름으로 손실이 확정된다.
      const st = kind === 'SL'
        ? gp.gateStopSpec(pos.side as 'LONG' | 'SHORT', price, ref, spec)
        : gp.gateTakeProfitSpec(pos.side as 'LONG' | 'SHORT', price, ref, spec);
      if (!st || !st.ok || st.triggerPrice == null) {
        return { success: false,
          message: `Gate ${kind === 'SL' ? '손절' : '익절'} 조건을 만들 수 없습니다`
                 + `${st?.reason ? ` — ${st.reason}` : ''}` };
      }
      return gf.placeStopGateFutures(creds.key!, creds.secret!, {
        contract,
        spec: { rule: st.rule, autoSize: st.autoSize, triggerPrice: st.triggerPrice },
      }, creds.testnet!);
    };

    if (tpPrice != null && Number(tpPrice) > 0) out.tp = await place(Number(tpPrice), 'TP');
    if (slPrice != null && Number(slPrice) > 0) out.sl = await place(Number(slPrice), 'SL');
  } else {
    const bf = await import('@/lib/exchanges/binanceFutures');
    cancelled = await bf.cancelOpenTPSL(creds.key!, creds.secret!, want, creds.testnet!);

    if (tpPrice != null && Number(tpPrice) > 0) {
      out.tp = await bf.placeFuturesTPSL(creds.key!, creds.secret!, {
        symbol: want, side: exitSide, stopPrice: Number(tpPrice), type: 'TAKE_PROFIT_MARKET',
        quantity: portion.qty ?? undefined, workingType,
      }, creds.testnet!);
    }
    if (slPrice != null && Number(slPrice) > 0) {
      out.sl = await bf.placeFuturesTPSL(creds.key!, creds.secret!, {
        symbol: want, side: exitSide, stopPrice: Number(slPrice), type: 'STOP_MARKET',
        quantity: portion.qty ?? undefined, workingType,
      }, creds.testnet!);
    }
    if (trailing) {
      out.trail = await bf.placeFuturesTrailingStop(creds.key!, creds.secret!, {
        symbol: want, side: exitSide,
        callbackRate: Number(trailing.callbackRate),
        quantity: portion.qty,
        activationPrice: trailing.activationPrice == null || trailing.activationPrice === ''
          ? null : Number(trailing.activationPrice),
        workingType,
      }, creds.testnet!);
    }
  }

  // 손절 실패를 성공에 섞지 않는다. 익절만 걸리고 손절이 실패했는데 ok:true를
  // 주면, 사용자는 보호가 걸렸다고 믿는다.
  const slFailed = out.sl != null && !out.sl.success;
  const tpFailed = out.tp != null && !out.tp.success;
  const trailFailed = out.trail != null && !out.trail.success;
  const ok = !slFailed && !tpFailed && !trailFailed;

  return NextResponse.json({
    ok, queued: false, executed: ok,
    cancelledExisting: cancelled?.cancelled ?? 0,
    tp: out.tp ? { success: out.tp.success, orderId: out.tp.orderId, message: out.tp.message } : null,
    sl: out.sl ? { success: out.sl.success, orderId: out.sl.orderId, message: out.sl.message } : null,
    trailing: out.trail ? { success: out.trail.success, orderId: out.trail.orderId, message: out.trail.message } : null,
    testnet: creds.testnet,
    // 무엇을 기준으로 걸었는지 남긴다. 나중에 '왜 이 값에 발동했지'를
    // 되짚을 때 트리거 기준이 없으면 재구성이 안 된다.
    workingType,
    portionQty: portion.qty,
    message: ok
      ? `설정 완료 (${portion.qty == null ? '전량' : `${portion.qty}`} · ${workingType === 'MARK_PRICE' ? 'Mark' : 'Last'} 기준)`
      : `${slFailed ? '손절' : tpFailed ? '익절' : '트레일링'} 설정 실패 — 거래소에서 직접 확인하세요`,
  }, { status: ok ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
}
