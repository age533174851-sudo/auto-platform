// /api/paper/account — 가상 계좌 조회 + 충전/초기화
//
// GET  → 잔고·열린 포지션(현재가 기준 평가손익 포함)
// POST → { action: 'deposit', amount } | { action: 'reset' }
//
// 왜 충전이 있는가
// ────────────────
// 모의는 연습이다. 한 번 날려 먹으면 연습을 못 하게 되는 연습은 의미가
// 없다. 다만 **충전은 기록으로 남는다** — 얼마를 넣어가며 만든 수익률인지
// 모르면 그 성적표는 아무것도 말해주지 않는다. 그래서 초기자본을 같이
// 올리고, 수익률은 '넣은 돈 대비'로 계산되게 한다.
//
// 사용자 확인
// ───────────
// 예전 `/api/paper/positions`는 쿼리스트링의 userId를 그대로 믿었다.
// 남의 가상 계좌를 URL만 바꿔 들여다볼 수 있었다는 뜻이다. 여기서는
// 인증 헤더에서만 사용자를 얻는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 한 번에 넣을 수 있는 금액 상한. 가상이라도 자릿수를 잘못 넣으면 장부가 무의미해진다 */
const MAX_DEPOSIT = 1_000_000;

async function uidOf(req: NextRequest) {
  return resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
}

export async function GET(req: NextRequest) {
  const uid = await uidOf(req);
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const { getPaperAccount } = await import('@/lib/engine/paperStore');
  const acct = await getPaperAccount(sb, uid);

  const { data: open } = await sb.from('paper_positions')
    .select('*').eq('user_id', uid).eq('status', 'open')
    .order('opened_at', { ascending: false });

  const rows = Array.isArray(open) ? open : [];

  // 현재가는 공개 시세에서 한 번만 받는다. 심볼마다 부르면 화면을 열
  // 때마다 여러 번 나간다.
  const symbols = Array.from(new Set(rows.map((p: any) => String(p.symbol))));
  const marks = new Map<string, number>();
  await Promise.all(symbols.map(async (s) => {
    try {
      const { getPremiumIndex } = await import('@/lib/exchanges/binanceFutures');
      const px = await getPremiumIndex(s, false);
      const v = Number(px?.markPrice);
      if (Number.isFinite(v) && v > 0) marks.set(s, v);
    } catch { /* 못 받으면 평가손익을 비운다 — 0으로 적지 않는다 */ }
  }));

  const positions = rows.map((p: any) => {
    const mark = marks.get(String(p.symbol)) ?? null;
    const fill = Number(p.fill_price);
    const qty = Number(p.quantity);
    // 못 받은 시세로 손익을 만들지 않는다. null은 '확인 불가'다.
    const pnl = mark == null ? null
      : (p.side === 'LONG' ? mark - fill : fill - mark) * qty;
    const margin = Number(p.margin);
    return {
      id: p.id, symbol: p.symbol, side: p.side,
      fillPrice: fill, quantity: qty, notional: Number(p.notional),
      leverage: Number(p.leverage), margin,
      stopLoss: p.stop_loss != null ? Number(p.stop_loss) : null,
      takeProfit: p.take_profit != null ? Number(p.take_profit) : null,
      liquidationPrice: Number(p.liquidation_price) || null,
      markPrice: mark,
      unrealizedPnl: pnl,
      roiPct: pnl != null && margin > 0 ? (pnl / margin) * 100 : null,
      openedAt: p.opened_at,
    };
  });

  const balance = Number(acct.balance) || 0;
  const initial = Number(acct.initial_balance) || 0;
  // 증거금은 열린 포지션이 물고 있다. 가용은 그만큼 뺀 값이다 —
  // 이걸 빼먹으면 같은 돈으로 몇 번이고 진입할 수 있게 된다.
  const usedMargin = positions.reduce((a, p) => a + (Number(p.margin) || 0), 0);

  return NextResponse.json({
    ok: true,
    account: {
      balance,
      available: Math.max(0, balance - usedMargin),
      usedMargin,
      initialBalance: initial,
      totalPnl: Number(acct.total_pnl) || 0,
      totalFees: Number(acct.total_fees) || 0,
      tradeCount: Number(acct.trade_count) || 0,
      winCount: Number(acct.win_count) || 0,
      returnPct: initial > 0 ? ((balance - initial) / initial) * 100 : null,
    },
    positions,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const uid = await uidOf(req);
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const { getPaperAccount } = await import('@/lib/engine/paperStore');
  const acct = await getPaperAccount(sb, uid);
  const action = String(body?.action || 'deposit');

  if (action === 'reset') {
    // 열린 포지션이 있으면 초기화하지 않는다. 잔고만 되돌리면 포지션의
    // 증거금이 공중에 뜨고, 그 뒤의 손익은 아무 의미가 없다.
    const { count } = await sb.from('paper_positions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', uid).eq('status', 'open');
    if ((count ?? 0) > 0) {
      return NextResponse.json({
        ok: false, error: 'has_open_positions',
        message: `열린 모의 포지션이 ${count}건 있습니다. 먼저 정리한 뒤 초기화하세요.`,
      }, { status: 409 });
    }

    const start = 10_000;
    await sb.from('paper_accounts').update({
      balance: start, initial_balance: start,
      total_pnl: 0, total_fees: 0, trade_count: 0, win_count: 0,
      updated_at: new Date().toISOString(),
    }).eq('user_id', uid);

    return NextResponse.json({
      ok: true, action: 'reset', balance: start,
      message: `모의 계좌를 ${start.toLocaleString()} USDT로 초기화했습니다`,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({
      ok: false, error: 'invalid_amount', message: `충전 금액이 유효하지 않습니다 (${body?.amount})`,
    }, { status: 400 });
  }
  if (amount > MAX_DEPOSIT) {
    return NextResponse.json({
      ok: false, error: 'amount_too_large',
      message: `한 번에 ${MAX_DEPOSIT.toLocaleString()} USDT까지 넣을 수 있습니다. `
             + '자릿수를 잘못 넣으면 이후 수익률이 아무 의미가 없어집니다.',
    }, { status: 400 });
  }

  const balance = (Number(acct.balance) || 0) + amount;
  // **초기자본도 같이 올린다.** 안 올리면 넣은 돈이 수익으로 잡혀
  // 수익률이 부풀려진다 — 성적표가 거짓말을 하기 시작한다.
  const initial = (Number(acct.initial_balance) || 0) + amount;

  const { error } = await sb.from('paper_accounts').update({
    balance, initial_balance: initial, updated_at: new Date().toISOString(),
  }).eq('user_id', uid);

  if (error) {
    return NextResponse.json({
      ok: false, error: 'update_failed', message: error.message,
    }, { status: 500 });
  }

  return NextResponse.json({
    ok: true, action: 'deposit', amount, balance, initialBalance: initial,
    message: `${amount.toLocaleString()} USDT를 넣었습니다 (가상) · 잔고 ${balance.toLocaleString()}`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
