// /api/paper/positions
// 가상 매매 현황 조회 — 대시보드용. 계좌 요약 + 열린 포지션 + 최근 청산.
//
// **어느 장부를 보는가**
// ─────────────────────
// `?challengeId=`가 있으면 그 챌린지의 전용 계좌, 없으면 지금까지처럼 기본
// 계좌다. 챌린지를 지정했는데 못 찾으면 **기본 계좌를 대신 보여 주지
// 않는다** — 남의 챌린지를 물어본 사람에게 자기 기본 계좌를 보여 주면
// "조회됐다"로 읽히고, 그 화면의 숫자는 물어본 것과 다른 장부의 것이다.
//
// **청산은 여기에 없다.** `/api/paper/close` 하나뿐이다 (아래 POST 주석 참고).
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  // 사용자는 **인증 헤더에서만** 얻는다.
  //
  // 예전에는 `?userId=`를 그대로 믿었다. 남의 가상 계좌를 URL만 바꿔
  // 들여다볼 수 있었다는 뜻이다. 가상 돈이라도 그 사람의 매매 기록이다.
  let sb: any = null;
  let userId: string | null = null;
  try {
    const { getSupabaseAdmin, resolveUserId } = await import('@/lib/supabase/admin');
    sb = getSupabaseAdmin();
    userId = await resolveUserId(
      req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  } catch {
    return NextResponse.json({ ok: false, error: 'DB 연결 없음' }, { status: 500 });
  }
  if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  try {
    const { getPaperAccount } = await import('@/lib/engine/paperStore');
    const { resolvePaperScope, paperScopeFailed } = await import('@/lib/engine/paperScope');
    const { resolveChallengeScope, challengeScopeFailed } =
      await import('@/lib/engine/paperChallengeScope');

    const rawChallengeId = String(req.nextUrl.searchParams.get('challengeId') || '').trim();

    // **한 장부를 정하고 계좌 요약과 포지션이 같은 값을 쓴다.** 예전에는
    // 요약은 `getPaperAccount`(기본 계좌), 포지션은 `scope`였다 — 챌린지가
    // 생기는 순간 둘이 갈린다.
    //
    // 계좌를 못 정하면 **0건으로 읽지 않는다** — 0건은 "포지션이 없다"로
    // 보이고 그건 확인된 사실이 아니다.
    let accountId: string;
    let account: any;
    if (rawChallengeId) {
      const cs = await resolveChallengeScope(sb, userId, rawChallengeId);
      if (challengeScopeFailed(cs)) {
        // **기본 계좌로 내려가지 않는다.** 못 찾은 것은 못 찾은 것이다.
        const unreadable = cs.code === 'UNREADABLE';
        return NextResponse.json({
          ok: false, error: unreadable ? 'challenge_unreadable' : 'challenge_not_found',
          message: cs.reason,
        }, { status: unreadable ? 503 : 404, headers: { 'Cache-Control': 'no-store' } });
      }
      accountId = cs.accountId;
      // 챌린지 계좌는 **찾기만 한다.** `getPaperAccount`는 기본 계좌를 찾고
      // 없으면 만든다 — 여기서 부르면 아무도 고르지 않은 계좌가 생긴다.
      const { data: ca } = await sb.from('paper_accounts')
        .select('*').eq('id', accountId).eq('user_id', userId).maybeSingle();
      if (!ca?.id) {
        return NextResponse.json({
          ok: false, error: 'account_unreadable',
          message: '챌린지 계좌를 읽지 못했습니다 — 계좌가 없다는 뜻이 아닙니다',
        }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
      account = ca;
    } else {
      const scope = await resolvePaperScope(sb, userId);
      if (paperScopeFailed(scope)) {
        return NextResponse.json({
          ok: false, error: 'scope_unresolved', message: scope.reason,
        }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
      accountId = scope.accountId;
      account = await getPaperAccount(sb, userId);
    }

    // ── **조회 실패를 "없음"으로 적지 않는다** ──
    //
    // 예전에는 `error`를 버리고 `data`만 썼다. SELECT가 실패하면 `open`이
    // `null`이 되고 화면에는 이렇게 나온다:
    //
    //   열린 포지션 없음 · 사용 증거금 0 · 거래 0건 · 승률 0%
    //
    // 전부 **정상으로 보이는 가짜 상태**다. 사용자는 포지션이 정리된 줄
    // 알고, 사이징 슬라이더는 있지도 않은 여유 증거금을 배정한다.
    // `paperScope`는 이미 조회 오류를 UNREADABLE로 분리하고 있었다 —
    // 이 라우트만 그 규칙 밖에 있었다.
    const { data: open, error: openErr } = await sb.from('paper_positions')
      .select('*').eq('user_id', userId).eq('paper_account_id', accountId)
      .eq('status', 'open').order('opened_at', { ascending: false });
    if (openErr || !Array.isArray(open)) {
      return NextResponse.json({
        ok: false, error: 'positions_unreadable',
        message: `열린 모의 포지션을 읽지 못했습니다 (${String(openErr?.message ?? '').slice(0, 120)})`
          + ' — 포지션이 없다는 뜻이 아닙니다',
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }

    const { data: closed, error: closedErr } = await sb.from('paper_positions')
      .select('*').eq('user_id', userId).eq('paper_account_id', accountId)
      .eq('status', 'closed').order('closed_at', { ascending: false }).limit(20);
    if (closedErr || !Array.isArray(closed)) {
      return NextResponse.json({
        ok: false, error: 'positions_unreadable',
        message: `청산된 모의 포지션을 읽지 못했습니다 (${String(closedErr?.message ?? '').slice(0, 120)})`
          + ' — 거래가 없었다는 뜻이 아닙니다',
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }

    const closedList = closed;
    const wins = closedList.filter((p: any) => Number(p.realized_pnl) > 0).length;
    const winRate = closedList.length ? (wins / closedList.length) * 100 : 0;
    const totalPnl = closedList.reduce((a: number, p: any) => a + (Number(p.realized_pnl) || 0), 0);

    // 새 주문에 배정할 수 있는 잔고. 판단은 `/api/paper/account`와 **같은
    // 함수**다 — 사이징 슬라이더가 어느 라우트를 읽든 같은 답을 봐야 한다.
    const { availableView } = await import('@/lib/engine/paperAvailable');
    const av = availableView(account.balance, open);

    return NextResponse.json({
      ok: true,
      challengeId: rawChallengeId || null,
      account: {
        balance: Number(account.balance),
        // **못 읽었으면 null이다.** 0은 "돈이 없다"로 읽힌다.
        available: av.available,
        availableUnknownReason: av.unknownReason,
        usedMargin: av.usedMargin,
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

// ── 수동 청산은 **여기에 없다** ──
//
// 무엇이 있었나
// ─────────────
// 이 자리에 `POST`가 하나 더 있었고, **인증을 한 번도 하지 않았다.**
// `positionId`와 `exitPrice`를 본문에서 받아 그대로 정산했다. 즉 아무나
// 남의 포지션을 자기가 고른 가격에 닫을 수 있었고, 제품에서 이 경로를
// 부르는 곳은 **한 곳도 없었다**(화면은 GET만 쓴다).
//
// 왜 막지 않고 없애나
// ───────────────────
// 인증만 붙이면 청산 경로가 둘로 남는다. 그리고 이쪽은 **청산가를 본문에서
// 받는다** — 챌린지 전용 계좌가 생긴 지금, 그 값은 곧 자기 성적표를 직접
// 적는 길이다(유리한 가격으로 닫아 REALIZED_PNL을 만들고 목표를 달성한다).
// 체크리스트를 늘리는 대신 **실패 지점 자체를 없앤다.**
//
// 청산은 `/api/paper/close` 하나다. 거기는 소유자를 확인하고, 청산가를
// **서버가 받는 마크가**로만 정한다.
export async function POST() {
  return NextResponse.json({
    ok: false, error: 'gone',
    message: '이 경로는 없어졌습니다 — 모의 청산은 /api/paper/close 를 쓰세요',
  }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
}
