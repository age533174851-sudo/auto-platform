// /api/paper/modify — 열린 모의 포지션의 손절·익절을 고친다
// POST { positionId, stopLoss?, takeProfit? }
//
// 왜 필요한가
// ───────────
// 모의 포지션 카드에는 **'모의 청산' 버튼 하나뿐**이었다. 실계좌 카드에는
// 배율·TP/SL·청산이 있는데 모의에는 없으니, 연습으로 쓰라고 만든 화면에서
// 정작 손절을 옮기는 연습을 할 수 없었다. 거래소 앱(바이낸스)에도 포지션
// 아래에 Leverage · TP/SL · Close 세 개가 나란히 있다.
//
// 방향을 확인한다
// ───────────────
// 롱인데 손절을 현재가 위에 걸면 **걸자마자 발동**한다. 익절을 아래 걸면
// 그것도 즉시다. 화면에서는 둘 다 '설정됨'으로 보이기 때문에, 여기서
// 막지 않으면 사용자는 자기가 무엇을 걸었는지 모른 채 청산된다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 값이 왔는가. null은 '지우기', undefined는 '그대로'다 — 둘은 다르다 */
function readOpt(v: any): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const positionId = String(body?.positionId || '');
  if (!positionId) return NextResponse.json({ ok: false, error: 'missing_params' }, { status: 400 });

  const stopLoss = readOpt(body?.stopLoss);
  const takeProfit = readOpt(body?.takeProfit);
  if (stopLoss === undefined && takeProfit === undefined) {
    return NextResponse.json({
      ok: false, error: 'nothing_to_change',
      message: '손절 또는 익절 값을 입력하세요',
    }, { status: 400 });
  }

  // **소유권 확인.** 없으면 남의 포지션 id로 남의 장부를 고칠 수 있다.
  const { data: pos } = await sb.from('paper_positions')
    .select('id, user_id, symbol, side, status, entry_price')
    .eq('id', positionId).maybeSingle();
  if (!pos || pos.user_id !== uid) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  if (pos.status === 'closed') {
    return NextResponse.json({
      ok: false, error: 'already_closed',
      message: '이미 청산된 포지션입니다',
    }, { status: 409 });
  }

  // ── 방향 확인 ──
  //
  // 기준은 **지금 시세**다. 진입가로 보면, 이미 많이 움직인 포지션에서
  // 지금 당장 발동하는 값이 통과한다.
  let mark: number | null = null;
  try {
    const { getPremiumIndex } = await import('@/lib/exchanges/binanceFutures');
    const px = await getPremiumIndex(String(pos.symbol), false);
    const v = Number(px?.markPrice);
    mark = Number.isFinite(v) && v > 0 ? v : null;
  } catch { mark = null; }

  const long = String(pos.side || '').toUpperCase() === 'LONG';

  // 시세를 못 읽었으면 방향 검사를 **건너뛰지 않는다** — 진입가로라도 본다.
  // 아무 검사 없이 통과시키면, 조회가 실패한 순간에만 즉시 발동하는 값이
  // 걸리는 길이 생긴다.
  const ref = mark ?? (Number(pos.entry_price) || null);
  if (ref != null) {
    if (stopLoss != null) {
      const bad = long ? stopLoss >= ref : stopLoss <= ref;
      if (bad) {
        return NextResponse.json({
          ok: false, error: 'stop_wrong_side',
          message: `${long ? '롱' : '숏'} 손절 ${stopLoss}은 기준가 ${ref}의 `
            + `${long ? '위' : '아래'}입니다 — 걸자마자 발동합니다`,
          refPrice: ref, refIsMark: mark != null,
        }, { status: 400 });
      }
    }
    if (takeProfit != null) {
      const bad = long ? takeProfit <= ref : takeProfit >= ref;
      if (bad) {
        return NextResponse.json({
          ok: false, error: 'tp_wrong_side',
          message: `${long ? '롱' : '숏'} 익절 ${takeProfit}은 기준가 ${ref}의 `
            + `${long ? '아래' : '위'}입니다 — 걸자마자 발동합니다`,
          refPrice: ref, refIsMark: mark != null,
        }, { status: 400 });
      }
    }
  }

  const patch: any = {};
  if (stopLoss !== undefined) patch.stop_loss = stopLoss;
  if (takeProfit !== undefined) patch.take_profit = takeProfit;

  const { error } = await (sb.from('paper_positions') as any)
    .update(patch).eq('id', positionId).eq('user_id', uid);
  if (error) {
    return NextResponse.json({ ok: false, error: 'update_failed', message: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    stopLoss: stopLoss === undefined ? undefined : stopLoss,
    takeProfit: takeProfit === undefined ? undefined : takeProfit,
    // 무엇을 기준으로 판단했는지 남긴다. 시세를 못 읽었으면 진입가로 본
    // 것이고, 그건 느슨한 검사다.
    refPrice: ref, refIsMark: mark != null,
    message: mark == null
      ? '저장했습니다 — 시세를 못 읽어 진입가 기준으로만 확인했습니다'
      : '저장했습니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
