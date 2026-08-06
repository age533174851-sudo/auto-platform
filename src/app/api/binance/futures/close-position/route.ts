// /api/binance/futures/close-position — 포지션 부분/전량 종료. **직접 실행한다.**
// POST { connectionId, symbol, positionSide: 'LONG'|'SHORT', percent }
//
// 예전에는 jobs 큐에 CLOSE_POSITION을 적재했고, 비율 종료 구현은 워커에만
// 있었다(worker/src/binance.ts의 closePositionPct). 그 워커를 쓰지 않게 된 뒤로
// 이 경로는 아무 일도 하지 않았다. 구현을 앱으로 옮겼다
// (binanceFutures.closePositionPercent).
//
// quantity는 더 받지 않는다. 예전 라우트는 quantity를 필수로 요구하면서 워커에는
// percent만 넘겼다 — 화면이 보낸 수량은 어디에도 쓰이지 않았다. 실제로 쓰는 값만
// 받는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { symbol, positionSide, percent = 100 } = body;
  if (!symbol || !positionSide) {
    return NextResponse.json({ error: 'missing_params', message: 'connectionId·symbol·positionSide 필수' }, { status: 400 });
  }
  if (positionSide !== 'LONG' && positionSide !== 'SHORT') {
    return NextResponse.json({ error: 'invalid_position_side' }, { status: 400 });
  }

  const creds = await loadFuturesCreds(sb, uid, body.connectionId);
  if (!creds.ok) return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status });

  // ── Gate ──
  //
  // Gate의 수량 단위는 정수 계약이라 비율 종료를 여기서 계산한다.
  // **내림하고, 1계약 미만이면 전량 닫는다.** 0으로 내려서 "종료했다"고
  // 말하면 사용자는 닫힌 줄 알고 손을 뗀다 — 못 닫는 것이 가장 나쁘다.
  if (creds.exchange === 'gate') {
    const gf = await import('@/lib/exchanges/gateFutures');
    const gp = await import('@/lib/exchanges/gatePlan');
    const contract = gp.toGateContract(String(symbol));
    if (!contract) {
      return NextResponse.json({ error: 'bad_symbol',
        message: `Gate 계약 이름을 만들 수 없습니다 (${symbol})` }, { status: 400 });
    }
    const pos = await gf.getPositionGateFutures(creds.key!, creds.secret!, contract, creds.testnet!);
    const size = Number(pos?.size ?? 0);
    if (!size) {
      return NextResponse.json({ ok: true, queued: false, executed: true, closedQty: 0,
        fullClose: false, testnet: creds.testnet, exchange: 'gate',
        message: '닫을 포지션이 없습니다' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    // 방향이 어긋나면 닫지 않는다. 반대 방향으로 보내면 닫는 대신 두 배가 된다.
    const posSide = size > 0 ? 'LONG' : 'SHORT';
    if (posSide !== positionSide) {
      return NextResponse.json({ error: 'position_side_mismatch',
        message: `${contract}의 열린 포지션은 ${posSide}입니다 — ${positionSide}로 닫을 수 없습니다` },
        { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const pct = Math.min(100, Math.max(0, Number(percent) || 100));
    const want = Math.floor(Math.abs(size) * pct / 100);
    const full = pct >= 100 || want < 1 || want >= Math.abs(size);

    if (full) {
      const r = await gf.closePositionGateFutures(creds.key!, creds.secret!, contract, creds.testnet!);
      return NextResponse.json({
        ok: r.success, queued: false, executed: r.success,
        closedQty: r.success ? Math.abs(size) : 0, fullClose: true,
        testnet: creds.testnet, exchange: 'gate',
        message: r.message + (pct < 100 && want < 1
          ? ` (${pct}%는 1계약 미만이라 전량 종료했습니다)` : ''),
      }, { status: r.success ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
    }

    // 부분 종료. reduce_only로 반대 방향 수량만큼 보낸다.
    try {
      await gf.placeOrderGateFutures(creds.key!, creds.secret!, {
        contract, size: size > 0 ? -want : want, price: '0', tif: 'ioc', reduceOnly: true,
      }, creds.testnet!);
      return NextResponse.json({
        ok: true, queued: false, executed: true, closedQty: want, fullClose: false,
        testnet: creds.testnet, exchange: 'gate',
        message: `${want}계약 종료 (요청 ${pct}%)`,
      }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) {
      return NextResponse.json({ ok: false, executed: false, exchange: 'gate',
        message: `부분 종료 실패: ${e?.message || e}` },
        { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  const { closePositionPercent } = await import('@/lib/exchanges/binanceFutures');
  const r = await closePositionPercent(
    creds.key, creds.secret, String(symbol), positionSide, Number(percent) || 100, creds.testnet);

  // **수동 청산은 기록에 남는다.** 자동매매가 연 포지션을 사람이 닫으면
  // 그 뒤로 재진입을 막는데(manualOverride), 왜 막혔는지를 되짚으려면
  // 누가 언제 닫았는지가 있어야 한다.
  {
    const { recordAudit } = await import('@/lib/safety/auditStore');
    recordAudit(sb, {
      userId: uid, action: 'MANUAL_CLOSE', resource: String(symbol),
      result: r.success ? 'success' : 'failed',
      connectionId: body?.connectionId ?? null,
      detail: {
        side: positionSide, percent: Number(percent) || 100,
        closedQty: r.closedQty, fullClose: r.fullClose,
        testnet: creds.testnet, message: r.message,
      },
    });
  }

  return NextResponse.json({
    ok: r.success,
    queued: false,
    executed: r.success,
    closedQty: r.closedQty,
    // 1%를 요청했는데 최소 단위 때문에 전량이 닫힌 경우를 숨기지 않는다
    fullClose: r.fullClose,
    testnet: creds.testnet,
    exchange: creds.exchange,
    message: r.message,
  }, { status: r.success ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
}
