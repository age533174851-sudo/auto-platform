// /api/order — Place a trading order
// Currently: paper-mode always (real exchange integration plugged in later)
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}

  const { assetId, nameKr, symbol, side, amount, leverage, price, mode, tp, sl } = body;

  if (!assetId || !side || !amount) {
    return NextResponse.json({ error: 'assetId, side, amount are required' }, { status: 400 });
  }

  // ── Paper mode (always available, no API key needed) ──────────
  if (mode !== 'real') {
    const fee       = (Number(amount) || 0) * 0.001;
    const filledPx  = Number(price) || 0;
    const orderId   = 'PAPER-' + Date.now().toString(36).toUpperCase();
    return NextResponse.json({
      orderId, status: 'filled',
      assetId, nameKr, symbol, side,
      amount: Number(amount), leverage: Number(leverage) || 1,
      filledPrice: filledPx, fee, pnl: 0,
      tp: tp || null, sl: sl || null,
      timestamp: Date.now(), mode: 'paper',
      source: 'paper',
    });
  }

  // ── Real mode (exchange API key required) ─────────────────────
  const hasKey = !!(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET);
  if (!hasKey) {
    return NextResponse.json(
      { error: 'Real trading requires BINANCE_API_KEY and BINANCE_API_SECRET', mode: 'real' },
      { status: 403 }
    );
  }

  // TODO: plug in real exchange order placement here
  return NextResponse.json({ error: 'Real order API not yet implemented' }, { status: 501 });
}

// GET — fetch order history from Supabase (future)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId') || 'demo';
  // TODO: query Supabase trade_orders for this user
  return NextResponse.json({ orders: [], source: 'mock', userId });
}
