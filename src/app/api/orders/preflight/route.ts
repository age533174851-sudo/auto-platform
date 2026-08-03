// POST /api/orders/preflight
//
// 주문을 보내기 전에 점검 목록을 돌린다. **주문을 보내지 않는다.**
//
// 수집은 lib/engine/preflight.ts, 판정은 lib/engine/preTradeChecklist.ts에
// 있다. 이 라우트는 인증하고 형식화할 뿐이다 — /api/reconcile/state와 같은
// 구조다. 화면이 보는 판정과 주문 경로가 막히는 근거가 같아야 한다.
//
// 왜 GET이 아니라 POST인가
// ────────────────────────
// 점검은 '무엇을 주문할지'에 따라 결과가 달라진다 — 손절가, 배율, 명목가.
// 그것을 쿼리스트링에 싣기 시작하면 주문 파라미터가 URL과 본문 두 곳에
// 흩어지고, 로그·리퍼러에 남는다. 상태를 바꾸지 않지만 본문을 받는다.
//
// 여기서 통과했다고 주문이 보장되지 않는다
// ────────────────────────────────────────
// 점검과 주문 사이에 시간이 흐른다. 그 사이 포지션이 바뀔 수도 있어서,
// 주문 경로는 자기 자리에서 다시 확인한다(assertStateConsistent). 이 라우트는
// 사용자가 **보내기 전에 이유를 알 수 있게** 하는 것이 목적이다.
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const { getUserIdFromRequest, getSupabaseAdmin } = await import('@/lib/supabase/admin');
  const userId = await getUserIdFromRequest(req.headers.get('authorization'));
  if (!userId) {
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const symbol = String(body?.symbol ?? '').trim();
  const sideRaw = String(body?.side ?? '').toUpperCase();
  if (!symbol) return NextResponse.json({ ok: false, error: 'symbol_required' }, { status: 400 });
  if (sideRaw !== 'LONG' && sideRaw !== 'SHORT') {
    return NextResponse.json({ ok: false, error: 'side_must_be_LONG_or_SHORT' }, { status: 400 });
  }

  const num = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const { fromLegacyMode } = await import('@/lib/engine/operatingMode');
  // 모드를 못 읽으면 fromLegacyMode가 UI_DEMO로 떨어뜨린다 — 모르는 값은
  // 가장 안전한 칸으로 간다는 그쪽 규칙을 그대로 쓴다.
  const mode = fromLegacyMode(process.env.NEXT_PUBLIC_APP_MODE ?? null);
  const testnet = mode !== 'LIVE_SMALL' && mode !== 'LIVE_LIMITED';

  const { collectChecklistInput } = await import('@/lib/engine/preflight');
  const { runChecklist } = await import('@/lib/engine/preTradeChecklist');

  const input = await collectChecklistInput({
    sb, userId, testnet, mode,
    symbol,
    side: sideRaw as 'LONG' | 'SHORT',
    notionalUsd: num(body?.notionalUsd) ?? 0,
    stopPrice: num(body?.stopPrice),
    intendedLeverage: num(body?.leverage),
    requiredMargin: num(body?.requiredMargin),
    // 호출자가 알고 있을 때만 넘긴다. 여기서 ladderGate를 부르면 점검만으로
    // 하루치 슬롯이 예약된다 (preflight.ts 주석 참조).
    alreadyTradedToday: typeof body?.alreadyTradedToday === 'boolean'
      ? body.alreadyTradedToday : null,
    // 1회 명목가 상한이 자산에 붙어 있다. 안 넘기면 **미리보기와 실제
    // 주문이 다른 상한을 쓴다** — 미리보기 통과가 통과를 뜻하지 않게 된다.
    equityUsd: num(body?.equityUsd),
    overrideMaxNotionalUsd: (() => {
      const n = Number(process.env.LIVE_MAX_NOTIONAL_USD);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
  });

  const verdict = runChecklist(input);

  return NextResponse.json({
    ok: true,
    // 통과 여부를 맨 앞에 둔다. 화면이 results를 세어 판단하면 그 계산이
    // 또 하나의 규칙이 되고, 언젠가 여기와 갈린다.
    allowed: verdict.allowed,
    summary: verdict.summary,
    passed: verdict.passed,
    total: verdict.total,
    unknownCount: verdict.unknownCount,
    results: verdict.results,
    blockers: verdict.blockers,
    mode,
    testnet,
    checkedAt: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
