// /api/risk/daily-limit — 오늘 손실 한도 현황
// GET ?connectionId=...&paper=1
//
// 왜 조회 경로를 따로 두는가
// ──────────────────────────
// 한도는 **보이지 않으면 없는 것과 같다.** 주문 버튼을 눌렀을 때 처음
// 알게 되면, 사용자는 그 시점까지 한도를 모른 채로 계획을 세운 것이다.
// 남은 여유를 미리 보여주면 마지막 한 번을 넣기 전에 스스로 멈출 수 있다.
//
// 이 경로는 **아무것도 막지 않는다.** 판단은 주문 경로가 하고, 여기서는
// 같은 순수 함수로 같은 답을 보여줄 뿐이다 — 화면과 서버가 각자 계산하면
// 서로 다른 숫자를 말하게 된다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const url = new URL(req.url);
  const paper = url.searchParams.get('paper') === '1';
  const connectionId = url.searchParams.get('connectionId');

  try {
    if (paper) {
      const { collectPaperDailyLoss } = await import('@/lib/risk/dailyLossCheck');
      const f = await collectPaperDailyLoss({ sb, userId: uid });
      return NextResponse.json({ ok: true, paper: true, ...shape(f) },
        { headers: { 'Cache-Control': 'no-store' } });
    }

    if (!connectionId) {
      return NextResponse.json({ ok: false, error: 'missing_connectionId' }, { status: 400 });
    }

    const { loadBinanceCreds } = await import('@/lib/exchanges/loadCreds');
    const creds = await loadBinanceCreds(sb, uid, connectionId);
    if (!creds.ok) {
      return NextResponse.json({ ok: false, error: creds.error, message: creds.message },
        { status: creds.status });
    }

    // 지갑 잔고. 못 읽으면 null이고, 비율 한도는 그때 unknown이 된다.
    let equity: number | null = null;
    try {
      const bf = await import('@/lib/exchanges/binanceFutures');
      const bal: any = await bf.getFuturesBalance(creds.key!, creds.secret!, creds.testnet!);
      if (bal?.success) {
        const usdt = (bal.balances ?? []).find((b: any) => b.asset === 'USDT');
        if (usdt) equity = Number(usdt.balance ?? usdt.availableBalance);
      }
    } catch { /* null */ }

    const { collectDailyLoss } = await import('@/lib/risk/dailyLossCheck');
    const f = await collectDailyLoss({
      apiKey: creds.key!, apiSecret: creds.secret!, testnet: creds.testnet!,
      currentEquityUsd: equity,
    });
    return NextResponse.json({ ok: true, paper: false, ...shape(f) },
      { headers: { 'Cache-Control': 'no-store' } });

  } catch (e: any) {
    // 조회 실패를 '한도 여유 있음'으로 그리지 않는다.
    return NextResponse.json({
      ok: false, error: 'lookup_failed',
      message: `오늘 손실을 확인하지 못했습니다 (${e?.message || e})`,
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

function shape(f: any) {
  return {
    status: f.verdict.status,
    blockEntries: f.verdict.blockEntries,
    reason: f.verdict.reason,
    byProfitTarget: f.verdict.byProfitTarget,
    limitUsd: f.verdict.limitUsd,
    remainingUsd: f.verdict.remainingUsd,
    todayNetUsd: f.todayNetUsd,
    incomeCount: f.incomeCount,
    config: f.cfg,
  };
}
