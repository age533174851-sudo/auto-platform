// /api/webhook/tradingview
// Receives TradingView/WUNDER signals — full safety validation
import { NextRequest, NextResponse } from 'next/server';
import {
  validatePreOrder, isDuplicateWebhook, logAudit,
  getKillSwitchState,
} from '@/lib/safety';

interface WebhookPayload {
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

  // ── Secret validation (code) — 불일치 시 200 + Signal Dropped (TradingView 재시도 방지) ──
  if (WEBHOOK_SECRET && body.code !== WEBHOOK_SECRET) {
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
    // 보안: 웹훅 시크릿 검증 (아무나 주문 못 넣게)
    const expectedSecret = process.env.WEBHOOK_SECRET || '';
    if (expectedSecret && body.secret !== expectedSecret) {
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
      const usdtNotional = (body.amount || body.quantity * px || 0) / 1375;
      const qty = body.quantity || (px > 0 ? usdtNotional / (px / 1375) : 0);

      // 거래소 직접 호출 X → jobs 큐에 PLACE_ORDER 적재 (Worker가 유일 실행자)
      const { enqueueJob } = await import('@/lib/jobs');
      const q = await enqueueJob(sb, {
        userId: conn.user_id, connectionId: body.connectionId, action: 'PLACE_ORDER',
        mode: isTestnet ? 'TESTNET' : 'LIVE', symbol: tradeSymbol,
        side: (body.side || 'buy').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        quantity: Number(qty.toFixed(3)),
        payload: { type: 'MARKET', leverage: body.leverage ?? null, source: 'webhook' },
        priority: 4,
      });

      entry.status = q.ok ? 'queued' : 'error';
      (entry as any).jobId = q.jobId;
      signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();

      return NextResponse.json({
        ok: q.ok, id: webhookId, mode, queued: q.ok, jobId: q.jobId,
        status: q.ok ? 'queued' : 'error',
        testnet: isTestnet,
        message: q.ok ? '신호 접수됨 — Worker가 주문 실행' : `적재 실패: ${q.error}`,
      });
    } catch (e: any) {
      entry.status = 'error';
      signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
      try { const { sendTelegram, fmtError } = await import('@/lib/notify/telegram'); await sendTelegram(fmtError(`웹훅 오류: ${e?.message}`)); } catch {}
      return NextResponse.json({ ok: false, id: webhookId, message: `주문 오류: ${e?.message || ''}` }, { status: 200 });
    }
  }

  // ── Paper mode: log only ──────────────────────────────────
  entry.status = 'paper_logged';
  signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();

  // 텔레그램 알림 (설정된 경우)
  try {
    const { sendTelegram, fmtEntry } = await import('@/lib/notify/telegram');
    await sendTelegram(fmtEntry({
      symbol: body.symbol || body.asset || '?',
      side: body.side === 'sell' ? '매도' : '매수',
      price: body.price || 0,
      amount: body.amount || 0,
      leverage: body.leverage,
      mode: '모의',
    }));
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
