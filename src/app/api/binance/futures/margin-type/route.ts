// GET  /api/binance/futures/margin-type?connectionId=…&symbol=BTCUSDT
// POST /api/binance/futures/margin-type  { connectionId, symbol, marginType }
//
// 이 심볼의 마진 모드를 읽고 바꾼다.
//
// 왜 GET이 필요한가 — 화면이 거짓말을 하고 있었다
// ───────────────────────────────────────────────
// 주문 화면의 '격리' 칸은 **글자만 박아 둔 상자**였다. 누를 수도 없고,
// 거래소에서 읽어 오지도 않았다. 그래서 같은 화면에서 이런 일이 났다:
//
//   · 윗줄:   격리          ← 항상 이렇게 적혀 있다
//   · 아랫줄: 마진 모드를 읽지 못했습니다 — CROSS인지 확인할 수 없습니다
//
// 앱이 "모른다"고 말하는 값을 화면 위쪽에서는 "격리"라고 단정하고 있었다.
// 둘 중 하나는 거짓이고, 사용자가 믿는 쪽은 큰 글씨다.
//
// 그리고 CROSS로 열리면 손실이 증거금을 넘어 **계좌 전체로 번진다.**
// 이 앱의 청산가 계산·증거금 상한이 전부 격리를 전제한다. 격리인지 아닌지는
// 알아야 하는 값이지 가정할 값이 아니다.
//
// 왜 바꾸는 것이 실패할 수 있는가
// ───────────────────────────────
// 열린 포지션이나 미체결 주문이 있으면 거래소가 마진 모드 변경을 거부한다
// (-4047 / -4048). 그건 앱의 잘못이 아니라 거래소 규칙이라, **무엇을 먼저
// 정리해야 하는지**를 그대로 적어 돌려준다.
import { NextRequest, NextResponse } from 'next/server';
import { resolveUserId, getSupabaseAdmin } from '@/lib/supabase/server';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';
import { setFuturesMarginType } from '@/lib/exchanges/binanceFutures';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 지금 무엇인가. **못 읽으면 못 읽었다고 말한다 — 격리로 가정하지 않는다.** */
export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const url = new URL(req.url);
  const symbol = String(url.searchParams.get('symbol') || '').toUpperCase().replace('/', '');
  if (!symbol) return NextResponse.json({ error: 'missing_symbol' }, { status: 400 });

  const sb = getSupabaseAdmin();
  // **거래소를 가리지 않는다.** 예전에는 바이낸스 전용이라 Gate 연결이면
  // not_binance로 끝났고, 주문 화면의 마진 모드 칸에 "모드 ?"가 떴다.
  // 그건 "모른다"가 아니라 "이 라우트가 Gate를 모른다"였는데, 화면은 그
  // 둘을 구분해 말할 수 없었다.
  const creds = await loadFuturesCreds(sb, uid, url.searchParams.get('connectionId'));
  if (!creds.ok) {
    return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status || 400 });
  }

  const { futuresPositionRisk } = await import('@/lib/exchanges/futuresAdapter');
  const rr = await futuresPositionRisk(
    creds.exchange!, creds.key!, creds.secret!, symbol, creds.testnet === true);

  // positionRisk v3에는 marginType이 없다. 값이 안 오면 **null이다.**
  // 'ISOLATED'로 채우면 화면이 확인된 사실처럼 그린다.
  // (Gate는 leverage=0이 교차라 gatePositionToRisk가 이미 둘로 갈라 준다)
  const raw = rr.risk?.marginType ?? null;
  const marginType = raw == null ? null
    : /isolat/i.test(String(raw)) ? 'ISOLATED'
    : /cross/i.test(String(raw)) ? 'CROSSED'
    : null;

  return NextResponse.json({
    ok: true,
    symbol,
    marginType,
    // 왜 못 읽었는지. 이게 없으면 화면은 '확인 못 함'까지만 말할 수 있다.
    error: marginType == null ? (rr.error || '거래소가 마진 모드를 돌려주지 않았습니다') : null,
    exchange: creds.exchange,
    hasPosition: rr.risk?.positionAmt != null ? Math.abs(Number(rr.risk.positionAmt)) > 0 : null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const symbol = String(body?.symbol || '').toUpperCase().replace('/', '');
  const wantRaw = String(body?.marginType || '').toUpperCase();
  // 'CROSS'로 보내는 화면이 있을 수 있다. 거래소가 받는 이름은 CROSSED다.
  const want: 'ISOLATED' | 'CROSSED' | null =
    wantRaw === 'ISOLATED' ? 'ISOLATED'
    : (wantRaw === 'CROSSED' || wantRaw === 'CROSS') ? 'CROSSED'
    : null;

  if (!symbol) return NextResponse.json({ error: 'missing_symbol' }, { status: 400 });
  if (!want) {
    return NextResponse.json({
      error: 'invalid_margin_type',
      message: '마진 모드는 ISOLATED 또는 CROSSED여야 합니다',
    }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  const creds = await loadFuturesCreds(sb, uid, body?.connectionId);
  if (!creds.ok) {
    return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status || 400 });
  }

  // ── Gate는 마진 모드를 배율로 표현한다 ──
  //
  // leverage = 0 이 교차, 0이 아니면 격리다. 그래서 '격리로 바꾼다'는
  // 배율을 1 이상으로 설정하는 일이고, '교차로 바꾼다'는 0으로 두는 일이다.
  //
  // **교차로 바꾸는 길은 열지 않는다.** 이 앱의 청산가 계산·증거금 상한이
  // 전부 격리를 전제한다. 교차는 한 종목의 손실이 지갑 전체로 번지는데,
  // 그걸 켜 주고도 화면의 청산가는 격리 기준으로 남는다 — 화면이 거짓을
  // 말하게 하는 것보다 이 버튼을 막는 쪽이 낫다.
  if (creds.exchange === 'gate') {
    const gf = await import('@/lib/exchanges/gateFutures');
    const gp = await import('@/lib/exchanges/gatePlan');
    const contract = gp.toGateContract(symbol);
    if (!contract) {
      return NextResponse.json({ error: 'bad_symbol',
        message: `Gate 계약 이름을 만들 수 없습니다 (${symbol})` }, { status: 400 });
    }
    if (want === 'CROSSED') {
      return NextResponse.json({
        error: 'cross_not_supported',
        message: '게이트아이오 연결은 교차 마진으로 바꿀 수 없습니다 — 이 앱의 청산가·증거금 '
               + '계산이 전부 격리를 전제합니다. 교차로 열면 화면의 청산가가 틀린 값이 됩니다.',
      }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    // 지금 배율을 유지한 채 격리로만 돌린다. 못 읽으면 1배다 — 배율을
    // 지어내 올리면 사용자가 정하지 않은 위험이 된다.
    let lev = 1;
    try {
      const pos = await gf.getPositionGateFutures(creds.key!, creds.secret!, contract, creds.testnet === true);
      const n = Number(pos?.leverage);
      if (Number.isFinite(n) && n >= 1) lev = Math.round(n);
    } catch { /* 1배 */ }

    const g = await gf.setLeverageGateFutures(
      creds.key!, creds.secret!, contract, lev, creds.testnet === true);
    if (!g.success) {
      return NextResponse.json({ error: 'margin_type_failed', message: g.message },
        { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({
      ok: true, symbol, exchange: 'gate', marginType: 'ISOLATED', alreadySet: false,
      message: `${contract}를 격리로 맞췄습니다 (${g.leverage ?? lev}배)`,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const r = await setFuturesMarginType(creds.key!, creds.secret!, symbol, want, creds.testnet === true);

  if (!r.success) {
    // -4047/-4048은 '지금은 못 바꾼다'이지 '이 기능이 고장'이 아니다.
    // 무엇을 정리해야 바뀌는지 적어야 사용자가 다음 행동을 할 수 있다.
    const busy = r.code === -4047 || r.code === -4048;
    return NextResponse.json({
      error: busy ? 'margin_type_locked' : 'margin_type_failed',
      code: r.code ?? null,
      message: busy
        ? `${symbol}에 열린 포지션이나 미체결 주문이 있어 마진 모드를 바꿀 수 없습니다. `
          + '포지션을 닫고 미체결 주문을 취소한 뒤 다시 시도하세요.'
        : (r.message || '마진 모드를 바꾸지 못했습니다'),
    }, { status: busy ? 409 : 400, headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json({
    ok: true, symbol, marginType: want, alreadySet: r.alreadySet,
    message: r.alreadySet
      ? `${symbol}는 이미 ${want === 'ISOLATED' ? '격리' : '교차'}입니다`
      : `${symbol} 마진 모드를 ${want === 'ISOLATED' ? '격리' : '교차'}로 바꿨습니다`
        + (want === 'CROSSED'
          ? ' — 교차는 손실이 증거금을 넘어 계좌 전체로 번질 수 있습니다.'
          : ''),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
