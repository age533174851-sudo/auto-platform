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

  // 체결 기준가는 **서버가 받는다.** 화면이 보낸 가격을 그대로 쓰면
  // 유리한 값을 넣어 장부를 만들 수 있고, 그러면 성적표가 의미를 잃는다.
  //
  // 현물은 **현물 시세**를 쓴다. 선물 마크가로 현물을 채우면 펀딩·베이시스
  // 만큼 다른 가격에 산 장부가 되고, 그 차이가 성적표에 그대로 남는다.
  let markPrice: number | null = null;
  try {
    if (spot) {
      const { fetchSpotPriceMap } = await import('@/lib/markets/pricing');
      const map = await fetchSpotPriceMap();
      const v = Number(map.get(symbol));
      markPrice = Number.isFinite(v) && v > 0 ? v : null;
    } else {
      const { getPremiumIndex } = await import('@/lib/exchanges/binanceFutures');
      const px = await getPremiumIndex(symbol, false);
      const v = Number(px?.markPrice);
      markPrice = Number.isFinite(v) && v > 0 ? v : null;
    }
  } catch { markPrice = null; }

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
  const acct = await getPaperAccount(sb, uid);
  let available: number | null = null;
  try {
    // **SQL과 같은 범위를 본다.** `082`의 `paper_open_position`은
    // `user_id AND paper_account_id`로 예산을 센다. 여기가 사용자 전체를
    // 세면 미리보기와 최종 판정이 다른 예산을 본다.
    const scope = await resolvePaperScope(sb, uid);
    if (paperScopeFailed(scope)) throw new Error(scope.reason);
    const { data: open } = await sb.from('paper_positions')
      .select('margin').eq('user_id', uid)
      .eq('paper_account_id', scope.accountId).eq('status', 'open');
    const used = (Array.isArray(open) ? open : [])
      .reduce((a: number, p: any) => a + (Number(p.margin) || 0), 0);
    available = (Number(acct.balance) || 0) - used;
  } catch {
    available = null;   // 모르면 buildPaperPlan이 막는다
  }

  // 오늘 손실 한도 — 모의에도 건다. 규칙이 실전과 다르면 그 연습은 쓸모가
  // 없다 (하루 한도를 무시하고 계속 넣어도 되는 화면에서 익힌 습관이
  // 실계좌에서 그대로 나온다).
  try {
    const { collectPaperDailyLoss } = await import('@/lib/risk/dailyLossCheck');
    const dl = await collectPaperDailyLoss({ sb, userId: uid });
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
  const signalId = `paper-${uid.slice(0, 8)}-${minute}-${market}-${symbol}-${side}-${built.plan.quantity}`;

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
    symbol, side,
    fillPrice: r.fill?.fillPrice, quantity: r.fill?.quantity,
    notional: r.fill?.notional, leverage: r.fill?.leverage,
    margin: r.fill?.margin, entryFee: r.fill?.entryFee,
    stopLoss: stopPrice, liquidationPrice: built.liquidationPrice,
    message: `모의 ${side} 체결 — ${r.fill?.quantity?.toFixed(6)} @ ${r.fill?.fillPrice?.toFixed(2)}`
           + ' (거래소로 나가지 않았습니다)',
  }, { headers: { 'Cache-Control': 'no-store' } }));
}
