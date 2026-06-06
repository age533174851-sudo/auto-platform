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

  // ── Real mode: 거래소에 실제 주문 전송 (24시간 무인) ───────────
  if (mode === 'real') {
    // 보안: 웹훅 시크릿 검증 (아무나 주문 못 넣게)
    const expectedSecret = process.env.WEBHOOK_SECRET || '';
    if (expectedSecret && body.secret !== expectedSecret) {
      entry.status = 'blocked_auth';
      signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();
      return NextResponse.json({ ok: false, id: webhookId, message: '웹훅 시크릿 불일치 — 인증 실패' }, { status: 401 });
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
      const { decryptSecret } = await import('@/lib/exchanges/crypto');
      const apiSecret = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '');
      const apiKey = conn.api_key ?? conn.api_key_encrypted ?? '';
      const isTestnet = conn.is_testnet !== false;

      const px = body.price || 0;
      const usdtNotional = (body.amount || body.quantity * px || 0) / 1375;
      const qty = body.quantity || (px > 0 ? usdtNotional / (px / 1375) : 0);

      const result = await placeFuturesOrderSafe(
        apiKey, apiSecret,
        {
          symbol: tradeSymbol,
          side: (body.side || 'buy').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          type: 'MARKET',
          quantity: Number(qty.toFixed(3)),
        },
        isTestnet,
      );

      entry.status = result.success ? 'executed' : 'error';
      (entry as any).orderResult = result;
      signalLog.unshift(entry); if (signalLog.length > 200) signalLog.pop();

      // 텔레그램 알림
      try {
        const { sendTelegram, fmtEntry, fmtError } = await import('@/lib/notify/telegram');
        if (result.success) await sendTelegram(fmtEntry({ symbol: tradeSymbol, side: body.side === 'sell' ? '매도' : '매수', price: px, amount: body.amount || 0, leverage: body.leverage, mode: '실전(웹훅)' }));
        else await sendTelegram(fmtError(`웹훅 주문 실패: ${result.message}`));
      } catch {}

      return NextResponse.json({
        ok: result.success, id: webhookId, mode: 'real',
        status: result.success ? 'executed' : 'error',
        orderId: (result as any).orderId,
        message: result.success ? '실거래 주문 체결됨' : `주문 실패: ${result.message}`,
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
