// /api/strategies/spot/plan
//
// 현물 주문 계획을 만든다. **여기서도 주문은 내지 않는다.**
//
// 계획과 실행을 나누는 이유
// ─────────────────────────
// 실행은 /api/binance/spot/order 하나만 한다. 그 라우트에 현물 검사가
// 모여 있다 — 공매도 차단, 보유 확인, 레버리지 필드 거부, 수량 정밀도.
// 계획 라우트가 자기 실행 경로를 가지면 그 검사를 두 벌 관리하게 되고,
// 언젠가 한쪽만 고쳐진다.
//
// 그래서 여기서는 "이런 주문들을 이렇게 내면 된다"까지만 만들고,
// 호출자가 그 목록을 하나씩 기존 주문 라우트로 보낸다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import {
  planSplit, planBracket, summarizeGuards,
  startTrailing, type PlanResult,
} from '@/lib/strategies/spotOrderPlan';
import { computeCostBasis } from '@/lib/markets/costBasis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 현물 최소 주문 금액(NOTIONAL). 모르면 null — 그 검사만 빠진다 */
async function fetchMinNotional(symbol: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`,
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    const s = (d.symbols || [])[0];
    const f = (s?.filters || []).find((x: any) =>
      x.filterType === 'NOTIONAL' || x.filterType === 'MIN_NOTIONAL');
    const v = parseFloat(f?.minNotional);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const symbol = String(body.symbol || '').toUpperCase().replace('/', '');
  if (!symbol) return NextResponse.json({ error: 'missing_symbol' }, { status: 400 });

  const kind = String(body.kind || '');
  const connectionId = body.connectionId ? String(body.connectionId) : null;

  // ── 보유·평균가 ──
  // 매도 계획과 TP/SL은 이 값 없이는 만들 수 없다. 0으로 채우면
  // "팔 수 있다"고 계획했다가 거래소에서 거부된다.
  let heldQty: number | null = null;
  let avgPrice: number | null = null;

  if (connectionId) {
    try {
      const { data: conn } = await (sb.from('exchange_connections') as any)
        .select('api_key, api_secret_enc, encrypted_secret, has_withdrawal')
        .eq('id', connectionId).eq('user_id', uid).maybeSingle();
      if (conn && !conn.has_withdrawal) {
        const { decryptSecret } = await import('@/lib/exchanges/crypto');
        const bn = await import('@/lib/exchanges/binance');
        const secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || '');
        const base = symbol.replace(/USDT$|BUSD$|USDC$/, '');

        const balances = await bn.getBalancesBinance(conn.api_key || '', secret);
        const hit = (Array.isArray(balances) ? balances : [])
          .find(b => String(b.currency).toUpperCase() === base);
        // 미체결에 묶인 물량은 팔 수 없다. free만 센다.
        heldQty = hit ? Number(hit.free) || 0 : 0;

        const raw = await bn.getSpotTrades(conn.api_key || '', secret, symbol, 500);
        avgPrice = computeCostBasis(
          raw
            .map((t: any) => ({
              time: Number(t.time) || 0,
              isBuyer: !!t.isBuyer, qty: Number(t.qty), price: Number(t.price),
              commission: Number(t.commission), commissionAsset: String(t.commissionAsset || ''),
              baseAsset: base,
            }))
            .sort((a, b) => a.time - b.time),
        ).avgPrice;
      }
    } catch { /* 못 읽으면 null로 남는다 — 아래 계획 함수가 거부한다 */ }
  }

  const minNotional = await fetchMinNotional(symbol);

  let plan: PlanResult;
  let extra: Record<string, any> = {};

  switch (kind) {
    case 'split': {
      plan = planSplit({
        side: String(body.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        total: Number(body.total),
        tranches: Number(body.tranches),
        fromPrice: Number(body.fromPrice),
        toPrice: Number(body.toPrice),
        minNotionalUsd: minNotional ?? undefined,
        heldQty: heldQty ?? undefined,
      });
      break;
    }
    case 'bracket': {
      if (heldQty == null || avgPrice == null) {
        plan = {
          ok: false, orders: [],
          warnings: ['보유 수량이나 평균 매수가를 확인하지 못해 익절·손절을 계획할 수 없습니다'],
        };
        break;
      }
      plan = planBracket({
        heldQty, avgPrice,
        takeProfit: body.takeProfit != null ? Number(body.takeProfit) : null,
        stopLoss: body.stopLoss != null ? Number(body.stopLoss) : null,
        coverPct: body.coverPct != null ? Number(body.coverPct) : undefined,
      });
      break;
    }
    case 'trailing': {
      // 트레일링은 주문을 만들지 않는다. 시작 상태만 돌려주고, 이후는
      // 서버가 가격을 보며 갱신한다 — 그래서 앱 보호다.
      const entry = Number(body.entryPrice);
      const pct = Number(body.trailPct);
      if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(pct) || pct <= 0 || pct >= 100) {
        plan = { ok: false, orders: [], warnings: ['시작가 또는 트레일링 비율이 유효하지 않습니다'] };
        break;
      }
      const state = startTrailing(entry, pct);
      extra = { trailing: state };
      plan = {
        ok: true, orders: [],
        warnings: [
          '트레일링 스톱은 거래소에 올라가지 않습니다. 서버가 가격을 보며 손절선을 옮기므로, ' +
          '서버가 멈추면 이 보호는 동작하지 않습니다.',
        ],
      };
      break;
    }
    default:
      return NextResponse.json(
        { error: 'unknown_kind', message: "kind는 'split' | 'bracket' | 'trailing' 중 하나여야 합니다" },
        { status: 400 });
  }

  const guards = summarizeGuards(
    plan.orders.length > 0 ? plan.orders : (kind === 'trailing' ? [{ guardedBy: 'APP' as const }] : []));

  return NextResponse.json({
    ok: plan.ok,
    marketType: 'SPOT',
    symbol, kind,
    heldQty, avgPrice, minNotional,
    orders: plan.orders,
    warnings: plan.warnings,
    guards,
    ...extra,
    // 실행 경로를 응답에 박아 둔다. 호출자가 다른 경로를 만들지 않게.
    executeVia: '/api/binance/spot/order',
    note: '계획입니다. 주문은 나가지 않았습니다.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
