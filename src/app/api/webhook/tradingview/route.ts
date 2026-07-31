// /api/webhook/tradingview
// Receives TradingView/WUNDER signals — full safety validation
import { NextRequest, NextResponse } from 'next/server';
import {
  validatePreOrder, isDuplicateWebhook, logAudit,
  getKillSwitchState,
} from '@/lib/safety';

interface WebhookPayload {
  // TradingView 알림이 보낼 수 있는 선택 필드들.
  // 이전에 코드에서 참조하는데 타입에 없어 TS2339가 발생했다.
  reduceOnly?: boolean;
  alertId?:    string;
  action?:     string;
  pnlPct?:     number;
  // Auth
  code?:      string;
  userId?:    string;
  // Order
  orderType?: 'openLong'|'openShort'|'closeLong'|'closeShort'|'closeAll';
  side?:      'buy'|'sell';
  symbol?:    string;
  asset?:     string;
  quantity?:  number;
  amount?:    number;
  price?:     number;
  leverage?:  number;
  stopLoss?:  number;
  takeProfit?:number;
  // Control
  mode?:      'paper'|'testnet'|'real';
  strategyId?:string;
  connectionId?:string;
  secret?:    string;
  exchange?:  string;
  // Idempotency
  id?:        string;
  messageId?: string;
  timestamp?: string;
  // Misc
  comment?:   string;
}

// Signal log (in-memory, last 200)
const signalLog: Array<{id:string; payload:WebhookPayload; receivedAt:string; status:string; safetyResult?:any}> = [];

const WEBHOOK_SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET || '';

export async function POST(req: NextRequest) {
  const receivedAt = new Date().toISOString();

  // ── Parse payload ──────────────────────────────────────────
  let body: WebhookPayload;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  // ── Secret validation (code) ──
  // 보안: 시크릿이 설정되지 않았으면 인증 검사를 건너뛰지 않고 요청 자체를 거부한다(fail-closed).
  // 미설정 상태에서 통과시키면 외부인이 주문 신호를 넣을 수 있다.
  if (!WEBHOOK_SECRET) {
    return NextResponse.json({
      ok: false,
      error: 'TRADINGVIEW_WEBHOOK_SECRET이 설정되지 않아 웹훅을 받을 수 없습니다',
    }, { status: 503 });
  }
  if (body.code !== WEBHOOK_SECRET) {
    logAudit({
      userId: body.userId || 'anon', action: 'WEBHOOK_AUTH_FAIL',
      resource: body.symbol || '?', detail: { ip: req.ip, reason: 'code mismatch' },
      result: 'blocked',
    });
    return NextResponse.json({ ok: false, dropped: true, message: 'Signal dropped — code 불일치' }, { status: 200 });
  }

  // ── Idempotency key ─────────────────────────────────────────
  const webhookId = body.id || body.messageId || `${body.symbol}-${body.timestamp}-${body.orderType}`;

  // ── Build signal entry ──────────────────────────────────────
  const entry = {
    id:          webhookId,
    payload:     body,
    receivedAt,
    status:      'received',
    safetyResult: null as any,
  };

  // ── Kill switch check ────────────────────────────────────────
  const ks = getKillSwitchState();
  if (ks.active) {
    entry.status = 'blocked_kill_switch';
    signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
    return NextResponse.json({
      ok: false, id: webhookId,
      error: `긴급 정지 활성화됨: ${ks.reason}`,
      mode: 'blocked',
    }, { status: 503 });
  }

  // ── Pre-order safety validation ───────────────────────────
  const mode   = body.mode || 'paper';
  const userId = body.userId || 'anon';
  const symbol = body.symbol || body.asset || 'UNKNOWN';

  const safetyResult = await validatePreOrder({
    userId,
    connectionId: body.connectionId || '',
    exchange:     body.exchange || 'binance',
    symbol,
    side:         body.side || (body.orderType?.includes('Long') ? 'buy' : 'sell'),
    quantity:     body.quantity || body.amount || 0,
    price:        body.price || 0,
    leverage:     body.leverage || 1,
    stopLoss:     body.stopLoss,
    takeProfit:   body.takeProfit,
    mode,
    webhookId,
    strategyId:   body.strategyId,
  });

  entry.safetyResult = {
    allowed:  safetyResult.allowed,
    blockers: safetyResult.blockers,
    warnings: safetyResult.warnings,
    fee:      safetyResult.estimatedFee,
    slip:     safetyResult.estimatedSlip,
    liqPx:    safetyResult.liquidationPx,
  };

  if (!safetyResult.allowed) {
    entry.status = 'blocked_safety';
    signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
    return NextResponse.json({
      ok:      false,
      id:      webhookId,
      mode,
      blocked: true,
      reasons: safetyResult.blockers,
      warnings:safetyResult.warnings,
      message: '안전 검사 실패 — 주문 차단됨',
    }, { status: 200 }); // 200 so TradingView doesn't retry
  }

  // ── Real/Testnet mode: 거래소에 실제 주문 전송 (24시간 무인) ───────────
  // real  → 연결의 is_testnet 플래그를 따름 (라이브 키면 라이브, 테스트 키면 테스트넷)
  // testnet → 연결 플래그와 무관하게 항상 거래소 테스트넷으로 강제 라우팅
  if (mode === 'real' || mode === 'testnet') {
    // 보안: 웹훅 시크릿 검증 (아무나 주문 못 넣게). 미설정 시 fail-closed.
    const expectedSecret = process.env.WEBHOOK_SECRET || '';
    if (!expectedSecret) {
      entry.status = 'blocked_auth';
      signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
      return NextResponse.json({
        ok: false, dropped: true, id: webhookId,
        message: 'WEBHOOK_SECRET 미설정 — 실주문 경로를 사용할 수 없습니다',
      }, { status: 503 });
    }
    if (body.secret !== expectedSecret) {
      entry.status = 'blocked_auth';
      signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
      return NextResponse.json({ ok: false, dropped: true, id: webhookId, message: 'Signal dropped — 웹훅 시크릿 불일치' }, { status: 200 });
    }
    if (!body.connectionId) {
      entry.status = 'blocked';
      signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
      return NextResponse.json({ ok: false, id: webhookId, message: 'connectionId 필수 (거래소 연결 ID)' }, { status: 400 });
    }
    try {
      const tradeSymbol = symbol.toUpperCase().replace(/USDT$/, '') + 'USDT';
      const { placeFuturesOrderSafe } = await import('@/lib/exchanges/binanceFutures');
      const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
      const sb = getSupabaseAdmin();
      // 연결 정보 로드 (서버 권한)
      const { data: conn } = await (sb.from('exchange_connections') as any)
        .select('*').eq('id', body.connectionId).single();
      if (!conn) throw new Error('거래소 연결을 찾을 수 없음');
      if (conn.has_withdrawal) throw new Error('출금 권한 키는 자동매매 불가');
      // 킬스위치 가드: active면 신규 진입 차단 (reduce-only 종료는 허용)
      const { isKillSwitchActive } = await import('@/lib/risk/killSwitch');
      const ks = await isKillSwitchActive(sb, body.connectionId);
      if (ks.active && !body.reduceOnly) {
        entry.status = 'blocked_killswitch';
        signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
        try {
          const { sendTelegramAlert } = await import('@/lib/notify/telegram');
          await sendTelegramAlert({
            level: 'warning', eventType: 'signal_dropped', exchange: 'Binance', mode: mode === 'testnet' ? 'TESTNET' : 'LIVE', symbol: body.symbol,
            title: 'Signal Dropped — 킬스위치 발동 중',
            message: '킬스위치 active 상태라 신규 진입 신호를 무시했습니다.',
            fields: { Reason: ks.reason || '계좌 보호' },
          }, sb);
        } catch {}
        return NextResponse.json({ ok: false, id: webhookId, blocked: true, dropped: true, message: `🛑 킬스위치 발동 중 — 신규 진입 차단 (${ks.reason || '계좌 보호'})` }, { status: 200 });
      }
      const isTestnet = mode === 'testnet' ? true : (conn.is_testnet !== false);

      const px = body.price || 0;
      // 예전 식에는 `/1375`(원-달러 추정치)가 두 번 들어가 서로 상쇄되고 있었다.
      //   (amount/1375) / (px/1375) === amount/px
      // 결과는 같지만, 읽는 사람은 통화 변환이 일어난다고 믿는다. 실제로는
      // amount와 price가 **같은 통화**라는 가정만 있다. 그 가정을 그대로 적는다.
      const qty = body.quantity || (px > 0 ? (body.amount || 0) / px : 0);

      // ── 중복 신호 차단 (멱등성) — TradingView 중복 발사·재시도 방어 ──
      const { signalKey, claimSignal } = await import('@/lib/risk/idempotency');
      const dedupKey = signalKey({
        clientId: body.id || body.alertId || null,
        connectionId: body.connectionId,
        symbol: tradeSymbol,
        action: body.action || (body.side || 'buy'),
        side: (body.side || 'buy').toUpperCase(),
        windowSec: 15,
      });
      const claim = await claimSignal(sb, dedupKey, 15);
      if (claim.duplicate) {
        entry.status = 'duplicate';
        signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
        return NextResponse.json({
          ok: true, id: webhookId, duplicate: true, dropped: true,
          message: '⚠️ 중복 신호 무시됨 — 동일 신호가 이미 처리되었습니다 (이중 주문 방지)',
        }, { status: 200 });
      }

      // ── 직접 실행 ──
      //
      // 예전에는 jobs 큐에 적재했고 Worker가 유일한 실행자였다. 그 워커는
      // Binance IP 지역 차단으로 쓰지 않고 있어(PROGRESS 인프라 표) 적재된
      // 신호는 실행되지 않았는데, 응답은 `status: 'queued'`였다.
      //
      // 게다가 그 payload에는 **reduceOnly가 빠져 있었다.** 위에서 킬스위치
      // 판단에는 body.reduceOnly를 쓰면서 주문에는 넘기지 않았으므로,
      // closeLong 신호가 신규 진입으로 나갈 수 있었다.
      //
      // 이제 수동 주문과 같은 경로를 쓴다 — 거래 전 점검 → 수동 계획 검사 →
      // executeOrder. 생명주기 기록·멱등 키·ISOLATED 강제가 따라온다.
      const isExit = body.reduceOnly === true
        || /^close/i.test(String(body.orderType || ''))
        || /^(close|exit)/i.test(String(body.action || ''));

      const sideUp = (body.side || 'buy').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      const levNum = Number(body.leverage ?? 0);

      // 손절가. 퍼센트로 오면 가격으로 바꾼다.
      //
      // 진입에 손절이 없으면 아래 buildManualPlan이 거부한다. 예전 큐 경로는
      // 손절 없이 그냥 보냈다 — 알림 하나로 보호 없는 포지션이 열렸다.
      const slPct = Number((body as any).stopLossPct);
      const stopPrice = (body as any).stopPrice != null
        ? Number((body as any).stopPrice)
        : (px > 0 && Number.isFinite(slPct) && slPct > 0
            ? (sideUp === 'BUY' ? px * (1 - slPct / 100) : px * (1 + slPct / 100))
            : null);

      const { decryptSecret } = await import('@/lib/exchanges/crypto');
      const { runChecklist } = await import('@/lib/engine/preTradeChecklist');
      const { fromLegacyMode, gateOrder } = await import('@/lib/engine/operatingMode');
      const { assertStateConsistent } = await import('@/lib/engine/reconcileCheck');
      const { buildManualPlan } = await import('@/lib/engine/manualPlan');
      const { executeOrder } = await import('@/lib/engine/orderExecutor');

      // 이 연결이 어느 거래소인가.
      //
      // 예전에는 `exchange: 'binance'`가 **하드코딩**돼 있었다. 연결은 id로만
      // 찾으므로 Gate 연결이 그대로 들어오는데, 그러면 Gate 키로 바이낸스에
      // 서명해 보내는 셈이다 — 점검용 조회는 전부 실패하고(전 항목 unknown →
      // 차단), 통과했다면 엉뚱한 거래소로 주문이 나갔다.
      const exchange: 'binance' | 'gate' =
        String(conn.exchange_id ?? conn.exchange ?? '').toLowerCase().includes('gate')
          ? 'gate' : 'binance';

      const apiSecret = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');

      // 로컬 시각은 호출 직후에 찍는다 — 응답을 기다린 뒤 찍으면 왕복 지연이
      // 그대로 시계 오차가 된다.
      const localMs = Date.now();
      let serverMs: number | null = null;
      let risk: {
        marginType: string; leverage: number | null;
        liquidationPrice: number | null; positionAmt: number; markPrice?: number | null;
      } | null = null;
      let readBalance: () => Promise<number | null>;

      if (exchange === 'gate') {
        const gf = await import('@/lib/exchanges/gateFutures');
        const gp = await import('@/lib/exchanges/gatePlan');
        serverMs = await gf.getGateServerTime(isTestnet);
        const contract = gp.toGateContract(tradeSymbol);
        risk = gp.gatePositionToRisk(
          await gf.getPositionGateFutures(conn.api_key, apiSecret, contract, isTestnet));
        readBalance = async () => {
          const acc: any = await gf.getAccountGateFutures(conn.api_key, apiSecret, isTestnet);
          const avail = Number(acc?.available);
          return Number.isFinite(avail) ? avail : null;
        };
      } else {
        const bf = await import('@/lib/exchanges/binanceFutures');
        serverMs = await bf.getFuturesServerTime(isTestnet);
        risk = await bf.getSymbolPositionRisk(conn.api_key, apiSecret, tradeSymbol, isTestnet);
        readBalance = async () => {
          const bal: any = await bf.getFuturesBalance(conn.api_key, apiSecret, isTestnet);
          if (!bal?.success) return null;
          const usdt = (bal.balances ?? []).find((b: any) => b.asset === 'USDT');
          return usdt ? usdt.availableBalance : null;
        };
      }

      const gate = await assertStateConsistent(sb, conn.user_id, isTestnet);

      const refPrice = px > 0 ? px : (risk?.markPrice ?? null);
      const notionalUsd = refPrice ? qty * refPrice : 0;
      const opMode = fromLegacyMode(process.env.NEXT_PUBLIC_APP_MODE ?? null);
      const g = gateOrder(opMode, notionalUsd);

      let marginInput: { required: number | null; available: number | null } | null = null;
      if (!isExit && refPrice && levNum > 0) {
        let available: number | null = null;
        try {
          available = await readBalance();
        } catch { /* null → unknown → 막힌다 */ }
        marginInput = { required: notionalUsd / levNum, available };
      }

      // 오늘 손실 한도. 웹훅은 사람이 안 보는 사이에 도는 경로라
      // 여기가 막히지 않으면 하루 한도가 없는 것과 같다.
      let dailyLossFact: { status: 'ok' | 'locked' | 'unknown'; reason: string } | null = null;
      if (!isExit) {
        try {
          const { collectDailyLoss } = await import('@/lib/risk/dailyLossCheck');
          const f = await collectDailyLoss({
            apiKey: conn.api_key, apiSecret, testnet: isTestnet,
            exchange, currentEquityUsd: marginInput?.available ?? null,
          });
          dailyLossFact = { status: f.verdict.status, reason: f.verdict.reason };
        } catch { /* null → unknown → 막힌다 */ }
      }

      // 시장 국면. 웹훅 신호가 국면과 맞는지 본다 — 필터를 켠 경우에만.
      const { collectRegime } = await import('@/lib/risk/regimeCheck');
      const regimeFacts = await collectRegime({
        symbol: tradeSymbol, side: sideUp === 'BUY' ? 'LONG' : 'SHORT',
      });

      const checklist = runChecklist({
        mode: { disposition: g.disposition, reason: g.reason },
        dailyLoss: dailyLossFact,
        regime: { status: regimeFacts.verdict.status, reason: regimeFacts.verdict.reason },
        clock: serverMs != null ? { localMs, serverMs } : null,
        reconcile: {
          reachable: gate.gather.reachable,
          blockNewOrders: !!gate.verdict?.blockNewOrders,
          summary: gate.reason || gate.verdict?.summary,
        },
        unresolvedOrderCount: gate.gather.reachable ? gate.gather.unresolvedOrders.length : null,
        marginType: risk?.marginType ?? null,
        leverage: (risk?.leverage != null && levNum > 0)
          ? { actual: risk.leverage, intended: levNum } : null,
        existingPositionQty: risk ? Math.abs(risk.positionAmt) : null,
        stopPrice,
        liquidationPrice: risk?.liquidationPrice ?? null,
        side: sideUp === 'BUY' ? 'LONG' : 'SHORT',
        margin: marginInput,
      }, { market: 'USDM', intent: isExit ? 'EXIT' : 'ENTRY',
           regimeFilter: regimeFacts.enabled });

      if (!checklist.allowed) {
        entry.status = 'error';
        (entry as any).error = checklist.summary;
        signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
        return NextResponse.json({
          ok: false, id: webhookId, executed: false, queued: false,
          error: 'checklist_blocked', message: checklist.summary,
          checklist: { allowed: false, passed: checklist.passed, total: checklist.total,
            blockers: checklist.blockers },
        }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
      }

      const built = buildManualPlan({
        symbol: tradeSymbol,
        side: sideUp,
        quantity: Number(qty.toFixed(3)),
        leverage: levNum > 0 ? levNum : Number(risk?.leverage ?? 0),
        reduceOnly: isExit,
        liquidationPrice: risk?.liquidationPrice ?? null,
        stopPrice,
        refPrice,
      });

      if (!built.plan.approved) {
        entry.status = 'error';
        (entry as any).error = built.reason;
        signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
        return NextResponse.json({
          ok: false, id: webhookId, executed: false, queued: false,
          error: 'plan_rejected', message: built.reason,
          hint: stopPrice == null && !isExit
            ? '알림 본문에 stopLossPct 또는 stopPrice를 넣으세요. 손절 없는 진입은 실행하지 않습니다.'
            : undefined,
        }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
      }

      // 멱등 키는 위 claimSignal의 중복 창(15초)과 별개다. 그쪽은 같은 신호의
      // 재발사를, 이쪽은 같은 주문의 재전송을 막는다.
      const clientOrderId = `TV${String(body.id || body.alertId || webhookId)
        .replace(/[^a-zA-Z0-9]/g, '').slice(0, 30)}`.slice(0, 36);

      const q = await executeOrder(sb, {
        userId: conn.user_id,
        connectionId: body.connectionId,
        signalId: `tradingview-${webhookId}`,
        clientOrderId,
        exchange,
        mode: isTestnet ? 'TESTNET' : 'LIVE',
        plan: built.plan,
        orderType: 'MARKET',
        reduceOnly: isExit,
        stopLoss: isExit ? undefined : (stopPrice ?? undefined),
        apiKey: conn.api_key,
        apiSecret,
      });

      entry.status = q.ok ? 'executed' : 'error';
      (entry as any).clientOrderId = q.clientOrderId;
      if (!q.ok) (entry as any).error = q.message;
      signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
      { const { log } = await import('@/lib/log/logger');
        if (q.ok) log.info('webhook', '주문 실행', { symbol: tradeSymbol, side: body.side, mode, clientOrderId: q.clientOrderId, status: q.status });
        else log.error('webhook', `주문 실패: ${q.message}`, { symbol: tradeSymbol, mode, status: q.status }); }

      // UNKNOWN은 200으로 돌려주지 않는다. TradingView는 실패를 재발사할 수
      // 있고, '보냈는데 결과를 모르는' 상태에서 재발사가 오면 중복 체결이 된다.
      // 5xx를 주면 TradingView가 재시도할 수 있지만, 15초 중복 창(claimSignal)과
      // clientOrderId 멱등이 그걸 막는다.
      return NextResponse.json({
        ok: q.ok, id: webhookId, mode,
        // 더 이상 큐를 쓰지 않는다. 화면·알림이 "처리 예정"으로 읽지 않게 명시한다.
        queued: false,
        executed: q.ok,
        status: q.status,
        clientOrderId: q.clientOrderId,
        exchangeOrderId: q.exchangeOrderId,
        filledQty: q.filledQty,
        avgPrice: q.avgPrice,
        slOrderId: q.slOrderId,
        duplicate: q.duplicate || undefined,
        testnet: isTestnet,
        message: q.message,
      }, { status: q.ok ? 200 : q.status === 'UNKNOWN' ? 502 : 400 });
    } catch (e: any) {
      entry.status = 'error';
      signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
      const { log } = await import('@/lib/log/logger');
      log.fatal('webhook', `실전 주문 처리 실패: ${e?.message}`, { symbol: body?.symbol, connectionId: body?.connectionId, mode });
      try { const { sendTelegram, fmtError } = await import('@/lib/notify/telegram'); await sendTelegram(fmtError(`웹훅 오류: ${e?.message}`)); } catch {}
      return NextResponse.json({ ok: false, id: webhookId, message: `주문 오류: ${e?.message || ''}` }, { status: 200 });
    }
  }

  // ── Paper mode: log only ──────────────────────────────────
  entry.status = 'paper_logged';
  signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();

  // 텔레그램 알림 — 매수완료 카드 + [일시정지][전량청산][웹열기] 버튼
  try {
    const { sendTelegram, entryCard } = await import('@/lib/notify/telegram');
    const card = entryCard({
      symbol: body.symbol || body.asset || '?',
      side: body.side === 'sell' ? '매도' : '매수',
      price: body.price || 0,
      amount: body.amount || 0,
      leverage: body.leverage,
      // 이 지점은 paper 모드 전용이다 (real/testnet은 위에서 모두 return).
      // 따라서 항상 '모의'. 이전 코드의 mode === 'real' 비교는 도달 불가였다.
      mode: '모의' as const,
      pnlPct: body.pnlPct,
      connectionId: body.connectionId,
    });
    await sendTelegram(card.text, { buttons: card.buttons });
  } catch {}

  return NextResponse.json({
    ok:       true,
    id:       webhookId,
    mode:     'paper',
    status:   'paper_logged',
    message:  '모의투자 신호 수신됨. 실제 주문 없음.',
    safety: {
      allowed:  true,
      warnings: safetyResult.warnings,
      fee:      safetyResult.estimatedFee,
      slip:     safetyResult.estimatedSlip,
      liqPx:    safetyResult.liquidationPx,
      maxLoss:  safetyResult.maxLoss,
    },
  });
}

export async function GET() {
  return NextResponse.json({
    signals: signalLog.slice(0, 30),
    total:   signalLog.length,
    mode:    'paper_default',
    killSwitch: getKillSwitchState(),
  });
}
