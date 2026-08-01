// GET /api/portfolio/allocation — 지금 자금을 어떻게 나눌 것인가
//
// 청산된 거래 기록 → 전략별 통계 → 점수 → 배분표.
//
// **읽기 전용이다.** 이 라우트는 아무것도 실행하지 않는다. 배분을 실제
// 주문에 물리기 전에, 사람이 먼저 "이 표가 말이 되는가"를 봐야 한다.
//
// 무엇을 세는가
// ─────────────
// 지금은 **모의 거래(paper_positions)만** 센다. 실거래는 전략별 실현손익을
// 아직 붙일 수 없다 — `live_orders`는 주문 의도를 기록하고, 실현손익은
// 거래소 원장(income)에 있는데 둘을 잇는 대조가 없다. 없는 것을 있는 척
// 섞으면 점수가 무엇으로 만들어졌는지 알 수 없게 된다.
//
// 그리고 순서상으로도 이게 맞다: 백테스트 → 모의 → 소액 실거래.
// 모의에서 30거래도 못 채운 전략을 실거래 점수로 평가할 이유가 없다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { aggregateStrategies, paperRowToTrade, type ClosedTrade } from '@/lib/portfolio/stats';
import { scoreAll } from '@/lib/portfolio/strategyScore';
import { allocate, readTiers, RISK_PER_TRADE_PCT } from '@/lib/portfolio/allocation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 최근 이 기간의 거래로 평가한다. 너무 오래된 성적은 지금 시장의 성적이 아니다 */
const LOOKBACK_DAYS = 180;

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const now = Date.now();
  const since = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString();
  const warnings: string[] = [];

  // ── 청산된 모의 거래 ──
  let trades: ClosedTrade[] = [];
  let tradesOk = false;
  try {
    const { data, error } = await sb.from('paper_positions')
      .select('strategy_id, realized_pnl, closed_at')
      .eq('user_id', uid).eq('status', 'closed')
      .gte('closed_at', since)
      .order('closed_at', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    trades = (Array.isArray(data) ? data : []).map(paperRowToTrade).filter(Boolean) as ClosedTrade[];
    tradesOk = true;
  } catch (e: any) {
    // 조회 실패를 '거래 없음'으로 그리지 않는다. 거래가 없으면 "표본 부족"이
    // 나오는데, 그건 조회 실패와 화면에서 똑같이 보인다.
    warnings.push(`거래 기록을 읽지 못했습니다 (${e?.message || e}) — 아래 표는 비어 있는 것이 아니라 확인 불가입니다`);
  }

  // ── 자산 ──
  // 모의 계좌 잔고를 쓴다. 못 읽으면 null이고, 그러면 배분 자체를 하지 않는다
  // (allocation.ts의 unknown 등급).
  let equityUsd: number | null = null;
  try {
    const { data } = await sb.from('paper_accounts')
      .select('balance').eq('user_id', uid).maybeSingle();
    const v = Number(data?.balance);
    equityUsd = Number.isFinite(v) ? v : null;
    if (equityUsd == null) warnings.push('모의 계좌 잔고를 확인하지 못했습니다');
  } catch {
    warnings.push('모의 계좌 잔고를 확인하지 못했습니다');
  }

  const { tiers, note } = readTiers(k => process.env[k]);
  if (note) warnings.push(note);

  const stats = tradesOk ? aggregateStrategies(trades, { nowMs: now, equityUsd }) : [];
  const scores = scoreAll(stats);
  const plan = allocate({
    equityUsd: tradesOk ? equityUsd : null,   // 기록을 못 읽었으면 배분하지 않는다
    scores, tiers,
    riskPerTradePct: Number(process.env.RISK_PER_TRADE_PCT) || RISK_PER_TRADE_PCT,
  });

  return NextResponse.json({
    ok: true,
    source: 'paper',
    sourceNote: '모의 거래 기록만 셉니다. 실거래는 전략별 실현손익 대조가 아직 없습니다.',
    lookbackDays: LOOKBACK_DAYS,
    tradeCount: trades.length,
    stats, scores, plan,
    warnings,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
