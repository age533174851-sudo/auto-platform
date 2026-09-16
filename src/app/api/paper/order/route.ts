// /api/paper/order — 모의투자 주문
// POST { symbol, side: 'LONG'|'SHORT', quantity, leverage, stopPrice?, stopLossPct?, takeProfit? }
//
// 거래소로 아무것도 보내지 않는다. 체결은 **공개 마크가 + 슬리피지**로
// 계산하고 앱 안의 장부(paper_positions / paper_accounts)에 적는다.
//
// 검사는 실전과 같다
// ──────────────────
// 손절 필수·배율 상한·손절 방향·청산거리·증거금. 규칙이 실전과 다르면
// 그 연습은 쓸모가 없다 (lib/engine/paperPlan.ts 주석 참조).
//
// 다른 것은 하나뿐: 잔고가 모자라면 "충전하세요"라고 말할 수 있다.
// 검사를 건너뛴다는 뜻이 아니다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { buildPaperPlan } from '@/lib/engine/paperPlan';
import { recordAudit, recordAuditAsync } from '@/lib/safety/auditStore';
import {
  paperOrderTelemetry, paperOrderAuditEvent, openFailureCode, planRejectionCode,
  type PaperOrderCode,
} from '@/lib/engine/paperOrderTelemetry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * **어디서 막혔는지 셀 수 있게 한다 — 응답은 한 글자도 바꾸지 않는다.**
 *
 * 모의 체결이 30일간 0건이었는데, 어느 관문에서 멈췄는지 말해 주는 기록이
 * 한 줄도 없었다. 그래서 같은 제보가 와도 같은 자리에서 멈춘다.
 *
 * 지키는 것 셋
 * ────────────
 *  · **기록이 주문을 바꾸지 않는다.** 던지지 않고, 응답 본문·status도 그대로다
 *  · 적는 것은 거친 코드·HTTP status·경로 이름뿐이다. 주문 내용은 안 적는다
 *  · 안전장치의 판단은 건드리지 않는다. 여기서는 **세기만** 한다
 *
 * 왜 실패 경로만 기다리나
 * ───────────────────────
 * 서버리스는 응답을 돌려주면 그 요청의 실행을 곧 정리한다. 불 지르고 잊은
 * insert는 **완료 전에 잘릴 수 있고**, 그러면 "기록은 남는다"고 믿는데 표는
 * 비어 있다 — 관측을 만들어 놓고 관측이 안 되는 것이다.
 *
 * 이미 실패해서 돌아가는 응답은 조금 기다려도 잃을 것이 없다. 반대로 체결에
 * 성공한 응답은 빨라야 하므로 기다리지 않는다. 기다리든 아니든 **던지지
 * 않는다** — 그래서 기록 실패가 체결 결과를 바꿀 수 없다.
 */
async function counted(
  sb: any, code: PaperOrderCode, res: NextResponse,
): Promise<NextResponse> {
  const ev = paperOrderAuditEvent(paperOrderTelemetry(code, res.status));
  try {
    if (code === 'OPENED') recordAudit(sb, ev);       // 체결 경로는 기다리지 않는다
    else await recordAuditAsync(sb, ev);              // 실패 경로는 끝까지 남긴다
  } catch {
    // 기록이 터져도 주문 응답은 그대로 나간다. 이 catch가 그 약속이다.
  }
  return res;
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch {
    return await counted(getSupabaseAdmin(), 'INVALID_JSON',
      NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }));
  }

  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) {
    return await counted(getSupabaseAdmin(), 'AUTH_REQUIRED',
      NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 }));
  }
  const sb = getSupabaseAdmin();
  if (!sb) {
    return await counted(null, 'SUPABASE_NOT_CONFIGURED',
      NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 }));
  }

  const symbol = String(body?.symbol || '').toUpperCase().replace('/', '');
  const side = String(body?.side || '').toUpperCase();
  if (!symbol || (side !== 'LONG' && side !== 'SHORT')) {
    return await counted(sb, 'MISSING_PARAMS',
      NextResponse.json({ ok: false, error: 'missing_params' }, { status: 400 }));
  }

  // 어느 시장인가. 모르는 값은 **거부한다** — USDM으로 흘려보내면 현물
  // 주문이 선물 규칙(배율·청산·손절 필수)으로 계산된다.
  const market = String(body?.market || 'USDM').toUpperCase();
  if (market !== 'SPOT' && market !== 'USDM') {
    return await counted(sb, 'UNSUPPORTED_MARKET', NextResponse.json({
      ok: false, error: 'unsupported_market',
      message: market === 'COINM'
        ? '모의 COIN-M은 아직 지원하지 않습니다'
        : `모르는 시장입니다 (${market})`,
    }, { status: 400 }));
  }
  const spot = market === 'SPOT';

  // ── 어느 장부에 적을 것인가 — **여기서 한 번 정한다** ──
  //
  // 밖에서 들어오는 것은 `challengeId` 하나다. 계좌 id를 받지 않는다 —
  // 받으면 "이 계좌가 무엇인지" 아는 곳이 화면이 된다.
  //
  // **못 정하면 기본 계좌로 내려가지 않는다.** 내려가면 사용자가 고른 적
  // 없는 장부로 주문이 나간다. 세 가지 실패가 전부 거부다.
  const { resolveChallengeScope, challengeScopeFailed, challengeOrderGate } =
    await import('@/lib/engine/paperChallengeScope');
  const rawChallengeId = typeof body?.challengeId === 'string' ? body.challengeId.trim() : '';
  let challengeAccountId: string | null = null;
  if (rawChallengeId) {
    const cs = await resolveChallengeScope(sb, uid, rawChallengeId);
    if (challengeScopeFailed(cs)) {
      const unreadable = cs.code === 'UNREADABLE';
      return await counted(sb, unreadable ? 'CHALLENGE_UNREADABLE' : 'CHALLENGE_NOT_FOUND',
        NextResponse.json({
          ok: false, error: unreadable ? 'challenge_unreadable' : 'challenge_not_found',
          message: cs.reason,
        }, { status: unreadable ? 503 : 404, headers: { 'Cache-Control': 'no-store' } }));
    }
    // **RUNNING만 받는다.** 잠그기 전의 관문이고, 최종 판정은 `086`의
    // `paper_open_position`이 계좌를 잠근 뒤 다시 한다 — 권위는 거기 하나다.
    const gate = challengeOrderGate(cs.status);
    if (!gate.allowed) {
      return await counted(sb, 'CHALLENGE_NOT_RUNNING', NextResponse.json({
        ok: false, error: 'challenge_not_running', message: gate.reason,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } }));
    }
    challengeAccountId = cs.accountId;
  }

  // 체결 기준가는 **서버가 받는다.** 화면이 보낸 가격을 그대로 쓰면
  // 유리한 값을 넣어 장부를 만들 수 있고, 그러면 성적표가 의미를 잃는다.
  //
  // **어느 시장의 가격인가는 `paperPriceSource`가 정한다.** 예전에는 이
  // 자리에 `if (spot) 현물 else 선물`이 직접 적혀 있었고, 청산 라우트에는
  // 그 분기가 아예 없어서 현물 포지션이 선물 마크가로 닫혔다. 규칙을 두
  // 곳에 적고 같기를 바라는 대신, 적는 곳을 하나로 만든다 —
  // **진입과 청산이 같은 함수를 부른다.**
  const { readPaperMarkPrice, paperPriceFailed } =
    await import('@/lib/engine/paperPriceSource');
  const px = await readPaperMarkPrice(market, symbol);
  const markPrice: number | null = paperPriceFailed(px) ? null : px.price;

  // 손절: 가격으로 왔으면 그대로, %면 마크가에서 만든다.
  // 현물에는 손절이 없다 — 실전 현물 라우트도 stopLossPct를 거부한다.
  const slPct = Number(body?.stopLossPct);
  const stopPrice = spot ? null : (body?.stopPrice != null
    ? Number(body.stopPrice)
    : (markPrice != null && Number.isFinite(slPct) && slPct > 0
        ? (side === 'LONG' ? markPrice * (1 - slPct / 100) : markPrice * (1 + slPct / 100))
        : null));

  // 가용 잔고 = 잔고 − 열린 포지션이 물고 있는 증거금.
  // 이걸 빼먹으면 같은 돈으로 몇 번이고 진입할 수 있다.
  const { getPaperAccount } = await import('@/lib/engine/paperStore');
  const { resolvePaperScope, paperScopeFailed } = await import('@/lib/engine/paperScope');
  // **챌린지 주문은 `getPaperAccount`를 부르지 않는다.** 그 함수는 기본
  // 계좌를 찾고 **없으면 만든다** — 챌린지 경로에서 부르면 사용자가 고른
  // 적 없는 계좌가 조용히 생긴다.
  const acct = challengeAccountId ? null : await getPaperAccount(sb, uid);
  let available: number | null = null;
  try {
    // **SQL과 같은 범위를 본다.** `082`의 `paper_open_position`은
    // `user_id AND paper_account_id`로 예산을 센다. 여기가 사용자 전체를
    // 세면 미리보기와 최종 판정이 다른 예산을 본다.
    let accountId: string;
    let balance: number;
    if (challengeAccountId) {
      // 소유권은 위에서 이미 확인했다. 그래도 `user_id`로 함께 좁힌다 —
      // 한 곳만 보면 언젠가 그 한 곳이 빠진다.
      const { data: ca } = await sb.from('paper_accounts')
        .select('balance').eq('id', challengeAccountId).eq('user_id', uid).maybeSingle();
      const b = Number(ca?.balance);
      // **못 읽은 것을 0으로 적지 않는다.** 0이면 "잔고가 없다"가 되어
      // 사유가 뒤바뀐다 — 모름으로 두고 계획 단계에서 막는다.
      if (!Number.isFinite(b)) throw new Error('챌린지 계좌 잔고를 읽지 못했습니다');
      accountId = challengeAccountId;
      balance = b;
    } else {
      const scope = await resolvePaperScope(sb, uid);
      if (paperScopeFailed(scope)) throw new Error(scope.reason);
      accountId = scope.accountId;
      balance = Number(acct.balance) || 0;
    }
    const { data: open } = await sb.from('paper_positions')
      .select('margin').eq('user_id', uid)
      .eq('paper_account_id', accountId).eq('status', 'open');
    // 증거금 합산은 `paperAvailable` 한 곳에 있다 — 읽기 라우트
    // (`/api/paper/account` · `/api/paper/positions`)와 같은 답을 봐야
    // 화면이 보여 준 가용 잔고와 여기서 막는 기준이 갈리지 않는다.
    //
    // 예전 한 줄은 `Number(p.margin) || 0`이었다. 못 읽은 증거금을 0으로
    // 세어 **가용 잔고가 실제보다 커졌고**, 그 상태로 진입이 통과했다.
    const { usedMarginOf } = await import('@/lib/engine/paperAvailable');
    const used = usedMarginOf(open);
    if (used.unreadable > 0) {
      throw new Error(`열린 포지션 ${used.unreadable}건의 증거금을 읽지 못했습니다`);
    }
    available = balance - used.used;
  } catch {
    available = null;   // 모르면 buildPaperPlan이 막는다
  }

  // 오늘 손실 한도 — 모의에도 건다. 규칙이 실전과 다르면 그 연습은 쓸모가
  // 없다 (하루 한도를 무시하고 계속 넣어도 되는 화면에서 익힌 습관이
  // 실계좌에서 그대로 나온다).
  try {
    const { collectPaperDailyLoss } = await import('@/lib/risk/dailyLossCheck');
    // **같은 장부의 오늘을 본다.** 기본 계좌의 손익으로 챌린지 주문을
    // 막거나 통과시키면 계좌를 나눈 이유가 사라진다.
    const dl = await collectPaperDailyLoss({ sb, userId: uid, paperAccountId: challengeAccountId });
    if (dl.verdict.blockEntries) {
      return await counted(sb, 'DAILY_LIMIT', NextResponse.json({
        ok: false, error: 'daily_limit', paper: true,
        status: dl.verdict.status,
        message: dl.verdict.status === 'locked'
          ? `[모의] ${dl.verdict.reason}`
          : `[모의] ${dl.verdict.reason} — 확인하지 못해 진입하지 않습니다`,
        todayNetUsd: dl.todayNetUsd,
      }, { status: 429, headers: { 'Cache-Control': 'no-store' } }));
    }
  } catch {
    // 판정 자체가 터지면 막는다. 한도를 확인하지 못한 채 넣는 것은
    // 한도를 안 건 것과 같다.
    return await counted(sb, 'DAILY_LIMIT_UNKNOWN', NextResponse.json({
      ok: false, error: 'daily_limit_unknown', paper: true,
      message: '[모의] 오늘 손실 한도를 확인하지 못해 진입하지 않았습니다',
    }, { status: 429, headers: { 'Cache-Control': 'no-store' } }));
  }

  const built = buildPaperPlan({
    symbol, side: side as 'LONG' | 'SHORT',
    market: market as 'SPOT' | 'USDM',
    quantity: Number(body?.quantity),
    leverage: spot ? 1 : Number(body?.leverage ?? 1),
    markPrice, stopPrice,
    takeProfit: body?.takeProfit != null ? Number(body.takeProfit) : null,
    availableBalance: available,
    // 현물에는 마진 모드가 없다. 선물만 받는다.
    // **아는 값만 받는다** — 오타 하나가 '교차인데 격리로 계산'을 만든다.
    marginMode: spot ? 'ISOLATED'
      : String(body?.marginMode || '').toUpperCase() === 'CROSSED' ? 'CROSSED' : 'ISOLATED',
  });

  if (!built.ok || !built.plan) {
    return await counted(sb, planRejectionCode({ markPrice, available }), NextResponse.json({
      ok: false, error: 'plan_rejected', message: built.reason,
      // 거부해도 계산값은 돌려준다 — 화면이 이유와 숫자를 같이 보여줄 수 있게
      notional: built.notional, requiredMargin: built.requiredMargin,
      liquidationPrice: built.liquidationPrice,
      available,
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } }));
  }

  // 같은 신호를 두 번 넣지 않게 한다. paper_positions에 signal_id UNIQUE가
  // 걸려 있어(010 마이그레이션) 같은 분(minute)의 같은 주문은 한 번만 들어간다.
  const minute = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  // **장부가 다르면 다른 신호다.** 계좌를 안 넣으면 같은 분에 기본 계좌와
  // 챌린지에 같은 주문을 낼 때 뒤엣것이 DUPLICATE로 막힌다 — 사용자는
  // 내지도 않은 중복으로 거부당한다.
  const ledgerKey = challengeAccountId ? `c${challengeAccountId.slice(0, 8)}` : 'default';
  const signalId = `paper-${uid.slice(0, 8)}-${minute}-${ledgerKey}-${market}-${symbol}-${side}-${built.plan.quantity}`;

  const { openPaperPosition } = await import('@/lib/engine/paperStore');
  const r = await openPaperPosition(sb, {
    userId: uid,
    signalId,
    strategyId: String(body?.strategyId || 'manual'),
    plan: built.plan,
    marginMode: spot ? 'ISOLATED'
      : String(body?.marginMode || '').toUpperCase() === 'CROSSED' ? 'CROSSED' : 'ISOLATED',
    market,
    entryPrice: markPrice as number,
    stopLoss: stopPrice ?? undefined,
    takeProfit: body?.takeProfit != null ? Number(body.takeProfit) : undefined,
    // **미리보기와 같은 계좌를 넘긴다.** 안 넘기면 SQL이 기본 계좌를 고르고,
    // 위에서 챌린지 예산으로 통과시킨 주문이 기본 장부에 체결된다.
    paperAccountId: challengeAccountId ?? undefined,
  });

  if (!r.ok) {
    return await counted(sb, openFailureCode((r as any).status), NextResponse.json({
      ok: false, error: r.duplicate ? 'duplicate' : 'open_failed',
      duplicate: !!r.duplicate,
      message: r.duplicate
        ? '같은 주문이 방금 들어갔습니다 (1분 안의 중복). 1분 뒤에 다시 넣을 수 있습니다.'
        : (r.error || '가상 포지션을 열지 못했습니다'),
    }, { status: r.duplicate ? 409 : 500, headers: { 'Cache-Control': 'no-store' } }));
  }

  return await counted(sb, 'OPENED', NextResponse.json({
    ok: true, paper: true, positionId: r.positionId,
    // 어느 장부에 적혔는지 화면이 알 수 있게. **계좌 id는 내보내지 않는다** —
    // 나가면 다음 요청이 그 값을 되보내게 되고 `challengeId` 계약이 깨진다.
    challengeId: rawChallengeId || null,
    symbol, side,
    fillPrice: r.fill?.fillPrice, quantity: r.fill?.quantity,
    notional: r.fill?.notional, leverage: r.fill?.leverage,
    margin: r.fill?.margin, entryFee: r.fill?.entryFee,
    stopLoss: stopPrice, liquidationPrice: built.liquidationPrice,
    message: `모의 ${side} 체결 — ${r.fill?.quantity?.toFixed(6)} @ ${r.fill?.fillPrice?.toFixed(2)}`
           + ' (거래소로 나가지 않았습니다)',
  }, { headers: { 'Cache-Control': 'no-store' } }));
}
