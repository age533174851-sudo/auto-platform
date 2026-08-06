// POST /api/binance/futures/leverage
// { connectionId, symbol, leverage }
//
// 열린 포지션의 레버리지를 바꾼다.
//
// 왜 조심해야 하는가
// ──────────────────
// 레버리지는 "얼마나 벌 수 있나"의 손잡이처럼 보이지만, 실제로 바뀌는 것은
// **청산가**다. 100배에서 50배로 내리면 청산가가 멀어지고, 반대로 올리면
// 지금 들고 있는 포지션의 청산가가 **현재가 쪽으로 다가온다.**
//
// 그래서 이 라우트는 바꾸기 전에
//   1. 지금 포지션을 읽고
//   2. 바꾼 뒤의 청산가를 계산해
//   3. **현재가를 이미 넘었으면 거부한다** — 바꾸는 순간 청산되는 요청이다
// 계산은 추정이지만(정확한 값은 유지증거금 구간에 따라 달라진다) 보수적으로
// 잡아 틀리더라도 더 엄격한 쪽으로 틀린다.
//
// GET은 없다. '지금 몇 배인가'는 포지션 조회가 이미 답한다 — 같은 사실을
// 두 곳에서 말하기 시작하면 둘이 어긋났을 때 어느 쪽이 맞는지 알 수 없다.
import { NextRequest, NextResponse } from 'next/server';
import { resolveUserId, getSupabaseAdmin } from '@/lib/supabase/server';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';
import { futuresPositionRisk, futuresSetLeverage } from '@/lib/exchanges/futuresAdapter';
import { linearLiquidationPrice } from '@/lib/engine/paperPlan';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const symbol = String(body?.symbol || '').toUpperCase().replace('/', '');
  const leverage = Math.round(Number(body?.leverage));
  if (!symbol) return NextResponse.json({ error: 'missing_symbol' }, { status: 400 });
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 125) {
    return NextResponse.json({ error: 'invalid_leverage', message: '배율은 1~125 사이여야 합니다' }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  // **거래소를 가리지 않는다.** Gate에도 배율 설정이 있는데(그리고
  // Gate는 leverage 0이 교차라 격리 확인이 더 중요한데) 여기서 막혀
  // Gate 사용자는 앱에서 배율을 못 바꿨다.
  const creds = await loadFuturesCreds(sb, uid, body?.connectionId);
  if (!creds.ok) {
    return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status || 400 });
  }

  // ── 지금 포지션을 읽는다 ──
  //
  // 못 읽으면 **바꾸지 않는다.** 포지션이 있는지 없는지 모르는 채로 배율을
  // 올리면, 있었을 경우 청산가가 어디로 가는지 아무도 모른다.
  let pos: any = null;
  try {
    const rr = await futuresPositionRisk(
      creds.exchange!, creds.key!, creds.secret!, symbol, creds.testnet === true);
    // **못 읽은 것은 '포지션 없음'이 아니다.** 아래에서 pos가 null이면
    // "들고 있는 것이 없다"로 흘러가 청산가 검사를 건너뛴다.
    if (!rr.risk || rr.risk.positionAmt == null) {
      throw new Error(rr.error || '포지션 응답을 읽지 못했습니다');
    }
    const amt = Number(rr.risk.positionAmt) || 0;
    pos = Math.abs(amt) > 0
      ? { symbol, amount: amt, entryPrice: rr.risk.entryPrice, markPrice: rr.risk.markPrice }
      : null;
  } catch (e: any) {
    return NextResponse.json({
      error: 'positions_unreachable',
      message: `포지션을 확인하지 못해 배율을 바꾸지 않았습니다 (${e?.message || e}). `
        + '들고 있는 포지션이 있으면 배율 변경이 청산가를 움직입니다.',
    }, { status: 502 });
  }

  // ── 바꾼 뒤 청산가가 어디로 가는가 ──
  let projected: number | null = null;
  let warning: string | null = null;
  if (pos) {
    const entry = Number(pos.entryPrice);
    const mark = Number(pos.markPrice);
    const side: 'LONG' | 'SHORT' = (Number(pos.amount) || 0) > 0 ? 'LONG' : 'SHORT';
    // 유지증거금률을 넉넉히(1%) 잡아 청산가를 진입가 쪽으로 당긴다 —
    // 틀리더라도 **더 엄격한 쪽으로** 틀리게. (COIN-M 라우트와 같은 규칙)
    projected = linearLiquidationPrice(entry, leverage, side, 1.0);

    if (projected == null) {
      return NextResponse.json({
        error: 'liq_uncomputable',
        message: `${leverage}배에서는 청산가를 계산할 수 없습니다 — 진입 즉시 청산 구간입니다.`,
      }, { status: 400 });
    }
    if (Number.isFinite(mark) && mark > 0) {
      // **바꾸는 순간 청산되는 요청은 거부한다.**
      const wouldLiquidate = side === 'LONG' ? mark <= projected : mark >= projected;
      if (wouldLiquidate) {
        return NextResponse.json({
          error: 'would_liquidate',
          message: `${leverage}배로 바꾸면 청산가(약 ${projected.toFixed(2)})가 현재가(${mark.toFixed(2)})를 이미 넘습니다 — 바꾸는 즉시 청산됩니다. 배율을 낮추거나 포지션을 줄이세요.`,
          projectedLiquidationPrice: projected, markPrice: mark,
        }, { status: 409 });
      }
      const distPct = Math.abs((mark - projected) / mark) * 100;
      if (distPct < 1) {
        warning = `청산가까지 약 ${distPct.toFixed(2)}%밖에 안 남습니다 — 작은 변동에도 청산될 수 있습니다.`;
      }
    }
  }

  const r = await futuresSetLeverage(
    creds.exchange!, creds.key!, creds.secret!, symbol, leverage, creds.testnet === true);
  if (!r.success) {
    return NextResponse.json({ error: 'leverage_failed', message: r.message }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    symbol, leverage,
    hadPosition: !!pos,
    // 추정이라는 것을 응답에도 적는다. 화면이 이 값을 확정처럼 그리면 안 된다.
    projectedLiquidationPrice: projected,
    projectedNote: projected == null ? null
      : '청산가는 유지증거금 구간을 넉넉히 잡은 **추정치**입니다. 실제 값은 포지션 조회로 확인하세요.',
    warning,
    message: pos
      ? `${symbol} 배율을 ${leverage}배로 바꿨습니다. 들고 있는 포지션의 청산가도 함께 움직입니다.`
      : `${symbol} 배율을 ${leverage}배로 바꿨습니다.`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
