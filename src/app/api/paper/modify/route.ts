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
import { readTpslEditValue, type TpslEditValue } from '@/lib/trading/tpslEdit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

  // **이상한 값은 '그대로'가 아니라 거절이다.** 예전에는 0·음수·문자가
  // 조용히 무시되어, 같이 온 다른 칸만 저장되고 "저장했습니다"가 나갔다.
  // 판정은 화면과 같은 파일(`lib/trading/tpslEdit.ts`)에 있다.
  const slIn = readTpslEditValue(body?.stopLoss);
  const tpIn = readTpslEditValue(body?.takeProfit);
  for (const [field, label, v] of [['stopLoss', '손절', slIn], ['takeProfit', '익절', tpIn]] as const) {
    if (v.kind === 'INVALID') {
      return NextResponse.json({
        ok: false, error: 'invalid_price', field,
        message: `${label} 값을 가격으로 읽지 못했습니다 — 아무것도 저장하지 않았습니다 (0보다 큰 숫자만)`,
      }, { status: 400 });
    }
  }
  /** KEEP → undefined(그대로) · CLEAR → null(지우기) · SET → 값 */
  const asPatch = (v: TpslEditValue): number | null | undefined =>
    v.kind === 'SET' ? v.price : v.kind === 'CLEAR' ? null : undefined;
  const stopLoss = asPatch(slIn);
  const takeProfit = asPatch(tpIn);
  if (stopLoss === undefined && takeProfit === undefined) {
    return NextResponse.json({
      ok: false, error: 'nothing_to_change',
      message: '손절 또는 익절 값을 입력하세요',
    }, { status: 400 });
  }

  // **소유권 확인.** 없으면 남의 포지션 id로 남의 장부를 고칠 수 있다.
  // **`market`을 함께 읽는다.** 방향을 볼 가격이 이 칸으로 정해진다.
  // 생성된 Supabase 타입에는 `market`이 없다(청산 라우트와 같은 이유).
  const { data: pos, error: posErr } = await (sb as any).from('paper_positions')
    .select('id, user_id, symbol, side, status, entry_price, market')
    .eq('id', positionId).maybeSingle();
  // **조회 실패는 "없음"이 아니다.** `/api/paper/close`와 같은 규칙이다 —
  // 예전 이 자리는 `error`를 버려, DB가 잠깐 실패하면 있는 포지션을 404
  // `not_found`로 답했다.
  if (posErr) {
    return NextResponse.json({
      ok: false, error: 'position_unreadable',
      message: '포지션을 읽지 못해 손절·익절을 바꾸지 않았습니다 — 포지션이 없다는 뜻이 아닙니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
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
  //
  // **발동과 같은 가격으로 본다.** 손절을 실제로 발동시키는 감시기
  // (`/api/paper/exit-monitor`)는 `readPaperMarkPrice(p.market, …)`를 쓴다.
  // 예전 이 자리는 시장을 안 보고 선물 `getPremiumIndex`(만료된 캐시도
  // 돌려준다)를 불러서, 현물 포지션에서는 감시기가 보는 값과 다른 값으로
  // "걸자마자 발동하는가"를 물었다.
  const { readPaperMarkPrice, paperPriceFailed } =
    await import('@/lib/engine/paperPriceSource');
  const px = await readPaperMarkPrice(pos.market, String(pos.symbol));
  const mark: number | null = paperPriceFailed(px) ? null : px.price;

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

  // **열린 포지션에만 쓰고, 맞은 행을 센다.** 위에서 읽은 뒤 시세를 읽는
  // 사이에 감시기가 이 포지션을 닫을 수 있다(정산은 `status='open'`일 때만
  // 바뀌는 조건부 UPDATE다 — 072). 예전에는 `id`·`user_id`만 보고 결과
  // 행 수를 보지 않아서, 닫힌 포지션의 손절 칸을 덮어쓰고 "저장했습니다"를
  // 답했다 — 사용자는 손절을 옮겼다고 믿는데 포지션은 이미 옛 손절로 닫혀 있다.
  const { data: written, error } = await (sb.from('paper_positions') as any)
    .update(patch).eq('id', positionId).eq('user_id', uid).eq('status', 'open')
    .select('id');
  if (error) {
    return NextResponse.json({ ok: false, error: 'update_failed', message: error.message }, { status: 500 });
  }
  // 바뀐 행을 확인하지 못했으면 성공이 아니다 — 모름을 "저장했습니다"로 적지 않는다.
  if (!Array.isArray(written)) {
    return NextResponse.json({
      ok: false, error: 'update_unconfirmed',
      message: '저장됐는지 확인하지 못했습니다 — 포지션을 새로 고쳐 손절·익절을 확인하세요',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  if (written.length === 0) {
    return NextResponse.json({
      ok: false, error: 'already_closed',
      message: '그사이 포지션이 청산되어 손절·익절을 바꾸지 않았습니다',
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
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
