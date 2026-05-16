import { NextRequest, NextResponse } from 'next/server';

interface WebhookPayload {
  code?: string;
  orderType?: 'openLong'|'openShort'|'closeLong'|'closeShort'|'closeAll';
  amountPerTradeType?: 'percent'|'fixed';
  amountPerTrade?: number;
  leverage?: number;
  stopLoss?: number;
  reduceOnly?: boolean;
  pos?: string;
  strategy?: string;
  asset?: string;
  price?: number;
  timestamp?: string;
  // WUNDER fields
  action?: string;
  contracts?: number;
  comment?: string;
}

// In-memory signal log (resets on cold start — use DB for persistence)
const signalLog: Array<{id:string; payload:WebhookPayload; receivedAt:string; status:string}> = [];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as WebhookPayload;

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      payload: body,
      receivedAt: new Date().toISOString(),
      status: 'paper_logged',   // NEVER executes real trades
    };

    signalLog.unshift(entry);
    if (signalLog.length > 100) signalLog.pop();  // keep last 100

    console.log('[TRAIGO Webhook] Signal received:', JSON.stringify(entry));

    return NextResponse.json({
      ok: true,
      id: entry.id,
      mode: 'paper',
      message: '신호 수신됨 (모의매매 로그). 실제 거래 미실행.',
      warning: 'Real trading is disabled. This is paper mode only.',
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }
}

export async function GET() {
  return NextResponse.json({
    signals: signalLog.slice(0, 20),
    total: signalLog.length,
    mode: 'paper',
    note: 'Real trading disabled — paper signals only',
  });
}
