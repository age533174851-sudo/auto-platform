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
  mode?:      'paper'|'real';
  strategyId?:string;
  connectionId?:string;
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

  // ── Secret validation ──────────────────────────────────────
  if (WEBHOOK_SECRET && body.code !== WEBHOOK_SECRET) {
    logAudit({
      userId: body.userId || 'anon', action: 'WEBHOOK_AUTH_FAIL',
      resource: body.symbol || '?', detail: { ip: req.ip },
      result: 'blocked',
    });
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
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

  // ── Real mode: mark as pending confirmation ───────────────
  if (mode === 'real') {
    entry.status = 'pending_confirmation';
    signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
    // In a real system, this would send to a queue for manual confirmation
    // For now, log and return — NEVER execute real orders from webhook directly
    console.log('[TRAIGO] Real mode signal received — queued for confirmation:', webhookId);
    return NextResponse.json({
      ok:      true,
      id:      webhookId,
      mode:    'real',
      status:  'pending_confirmation',
      message: '실거래 신호 수신됨. 이중 확인 대기 중.',
      warnings:safetyResult.warnings,
      fee:     safetyResult.estimatedFee,
      slip:    safetyResult.estimatedSlip,
      liqPx:  safetyResult.liquidationPx,
    });
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
