// /api/paper/positions
// 가상 매매 현황 조회 — 대시보드용. 계좌 요약 + 열린 포지션 + 최근 청산.
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const userId = url.searchParams.get('userId') || 'paper-default';

  let sb: any = null;
  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
    sb = getSupabaseAdmin();
  } catch {
    return NextResponse.json({ ok: false, error: 'DB 연결 없음' }, { status: 500 });
  }

  try {
    const { getPaperAccount } = await import('@/lib/engine/paperStore');
    const account = await getPaperAccount(sb, userId);

    const { data: open } = await sb.from('paper_positions')
      .select('*').eq('user_id', userId).eq('status', 'open').order('opened_at', { ascending: false });

    const { data: closed } = await sb.from('paper_positions')
      .select('*').eq('user_id', userId).eq('status', 'closed').order('closed_at', { ascending: false }).limit(20);

    const closedList = Array.isArray(closed) ? closed : [];
    const wins = closedList.filter((p: any) => Number(p.realized_pnl) > 0).length;
    const winRate = closedList.length ? (wins / closedList.length) * 100 : 0;
    const totalPnl = closedList.reduce((a: number, p: any) => a + (Number(p.realized_pnl) || 0), 0);

    return NextResponse.json({
      ok: true,
      account: {
        balance: Number(account.balance),
        initialBalance: Number(account.initial_balance),
        totalPnl: Number(account.total_pnl),
        totalFees: Number(account.total_fees),
        tradeCount: Number(account.trade_count),
        returnPct: Number(account.initial_balance) > 0
          ? ((Number(account.balance) - Number(account.initial_balance)) / Number(account.initial_balance)) * 100
          : 0,
      },
      openPositions: (Array.isArray(open) ? open : []).map((p: any) => ({
        id: p.id, symbol: p.symbol, side: p.side, bucket: p.bucket,
        fillPrice: Number(p.fill_price), quantity: Number(p.quantity),
        notional: Number(p.notional), leverage: Number(p.leverage), margin: Number(p.margin),
        stopLoss: p.stop_loss != null ? Number(p.stop_loss) : null,
        takeProfit: p.take_profit != null ? Number(p.take_profit) : null,
        liquidationPrice: Number(p.liquidation_price),
        openedAt: p.opened_at,
      })),
      recentClosed: closedList.map((p: any) => ({
        symbol: p.symbol, side: p.side, exitReason: p.exit_reason,
        fillPrice: Number(p.fill_price), exitPrice: Number(p.exit_price),
        realizedPnl: Number(p.realized_pnl), pnlPct: Number(p.pnl_pct),
        closedAt: p.closed_at,
      })),
      stats: { closedCount: closedList.length, winRate, totalPnl },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '조회 실패' }, { status: 500 });
  }
}

// 수동 청산
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'JSON 파싱 실패' }, { status: 400 }); }
  const { positionId, exitPrice, reason } = body || {};
  if (!positionId || typeof exitPrice !== 'number') {
    return NextResponse.json({ ok: false, error: 'positionId와 exitPrice가 필요합니다' }, { status: 400 });
  }

  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
    const sb = getSupabaseAdmin();
    const { closePaperPosition } = await import('@/lib/engine/paperStore');
    const r = await closePaperPosition(sb, positionId, exitPrice, reason || 'MANUAL');
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '청산 실패' }, { status: 500 });
  }
}
