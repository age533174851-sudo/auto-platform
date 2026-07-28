// /api/autotrade/exit-monitor
//
// 계단식 거래의 트레일링 · 본전 이동 · 시간 청산을 실행한다.
// Vercel Cron이 주기적으로 호출한다 (vercel.json의 crons).
//
// 왜 Vercel인가: Railway 워커는 Binance가 IP 지역을 차단해 주문이 나가지
// 않는다. Vercel은 regions가 hnd1(도쿄)이라 정상 연결된다.
//
// 인증: Vercel Cron은 CRON_SECRET이 설정돼 있으면
//       Authorization: Bearer <CRON_SECRET> 을 붙여 호출한다.
//       수동 점검용으로 x-admin-secret도 허용한다.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { checkPositionGuard, type GuardVerdict } from '@/lib/engine/positionGuard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function safeEqual(provided: string | null, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

function authorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET || '';
  const adminSecret = process.env.ADMIN_SECRET || '';

  const auth = req.headers.get('authorization') || '';
  if (cronSecret && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), cronSecret)) return true;
  if (safeEqual(req.headers.get('x-admin-secret'), adminSecret)) return true;
  return false;
}

/**
 * 열린 거래마다 거래소 실제 상태를 읽어 기술적 사고를 점검한다.
 * 조회 자체가 실패하면 exchangeReachable=false로 넘겨 알림만 나가게 한다 —
 * 연결이 없으면 청산 주문도 못 내므로 임의로 CLOSE 판정하지 않는다.
 */
async function runPositionGuards(
  sb: any,
  decisions: { tradeId: string; userId: string; symbol: string; side: 'LONG' | 'SHORT' }[],
  testnet: boolean,
): Promise<{ tradeId: string; symbol: string; verdict: GuardVerdict }[]> {
  if (decisions.length === 0) return [];

  const bf = await import('@/lib/exchanges/binanceFutures');
  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  const out: { tradeId: string; symbol: string; verdict: GuardVerdict }[] = [];

  // 사용자별로 키를 한 번만 읽는다
  const credCache = new Map<string, { key: string; secret: string } | null>();

  for (const d of decisions) {
    try {
      if (!credCache.has(d.userId)) {
        const { data: conn } = await sb.from('exchange_connections')
          .select('api_key, api_secret_enc, encrypted_secret')
          .eq('user_id', d.userId).eq('is_active', true).limit(1).maybeSingle();
        credCache.set(d.userId, conn
          ? { key: (conn as any).api_key, secret: decryptSecret((conn as any).api_secret_enc ?? (conn as any).encrypted_secret ?? '') }
          : null);
      }
      const cred = credCache.get(d.userId);
      if (!cred) continue;

      const posRes: any = await bf.getFuturesPositions(cred.key, cred.secret, testnet);
      const reachable = posRes?.success === true;
      const pos = reachable
        ? (posRes.positions as any[]).find(p => String(p.symbol) === d.symbol && Math.abs(Number(p.amount)) > 0)
        : null;

      // 거래소에 포지션이 없으면 이미 닫힌 것 — 점검 대상이 아니다
      if (reachable && !pos) continue;

      let hasStop = false;
      if (reachable) {
        try {
          const open = await bf.getFuturesOpenOrders(cred.key, cred.secret, testnet, d.symbol);
          hasStop = (Array.isArray(open) ? open : []).some((o: any) =>
            String(o?.type || '').toUpperCase() === 'STOP_MARKET');
        } catch { hasStop = false; }
      }

      const verdict = checkPositionGuard({
        symbol: d.symbol,
        side: d.side,
        entryPrice: pos ? Number(pos.entryPrice) : 0,
        markPrice: pos ? Number(pos.markPrice) : 0,
        liquidationPrice: pos ? Number(pos.liquidationPrice) : 0,
        marginType: pos ? pos.marginType : null,
        hasProtectiveStop: hasStop,
        exchangeReachable: reachable,
      });

      if (verdict.action !== 'NONE') out.push({ tradeId: d.tradeId, symbol: d.symbol, verdict });
    } catch {
      // 개별 실패가 전체 점검을 막지 않는다
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: '인증 필요 — Vercel Cron(Bearer CRON_SECRET) 또는 x-admin-secret' },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry') === '1';
  const testnet = (process.env.LADDER_MODE || 'TESTNET').toUpperCase() !== 'LIVE';

  const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const { decideExits } = await import('@/lib/engine/exitMonitor');
  const decisions = await decideExits(sb, { testnet });

  // ── 기술적 사고 점검 ──
  // 트레일링·시간청산 판단보다 먼저 본다. 청산가에 다다랐거나 손절이
  // 사라졌거나 마진이 Cross로 바뀐 상태라면, 손절선을 옮길 때가 아니라
  // 포지션을 닫아야 할 때다.
  //
  // 이 점검은 방향으로 판단하지 않는다 (positionGuard.ts 참고).
  const guardFindings = await runPositionGuards(sb, decisions, testnet);
  for (const g of guardFindings) {
    if (g.verdict.action !== 'CLOSE') continue;
    const d = decisions.find(x => x.tradeId === g.tradeId);
    if (d) { d.action = 'CLOSE'; d.reason = `[보호] ${g.verdict.reason}`; }
  }

  const actionable = decisions.filter(d => d.action !== 'NONE');

  // 청산까지는 아니지만 알아야 할 이상 (연결 끊김, Mark Price 급변 등)
  const alerts = guardFindings
    .filter(g => g.verdict.action === 'ALERT')
    .map(g => ({ symbol: g.symbol, reason: g.verdict.reason, faults: g.verdict.faults.map(f => f.code) }));

  if (dryRun || actionable.length === 0) {
    return NextResponse.json({
      ok: true, dryRun, checked: decisions.length, actionable: actionable.length,
      alerts,
      decisions: decisions.map(d => ({
        symbol: d.symbol, action: d.action, reason: d.reason,
        highWaterR: Number(d.highWaterR.toFixed(3)),
        currentStop: d.currentStop, newStop: d.newStop,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const bf = await import('@/lib/exchanges/binanceFutures');
  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  const results: any[] = [];

  for (const d of actionable) {
    try {
      const { data: conn } = await sb.from('exchange_connections')
        .select('id, api_key, api_secret_enc, encrypted_secret, has_withdrawal')
        .eq('user_id', d.userId).eq('is_active', true)
        .limit(1).maybeSingle();

      if (!conn) { results.push({ symbol: d.symbol, ok: false, error: '활성 거래소 연결 없음' }); continue; }
      if ((conn as any).has_withdrawal) { results.push({ symbol: d.symbol, ok: false, error: '출금 권한 키 — 사용 불가' }); continue; }

      const key = (conn as any).api_key as string;
      const secret = decryptSecret((conn as any).api_secret_enc ?? (conn as any).encrypted_secret ?? '');
      const exitSide: 'BUY' | 'SELL' = d.side === 'LONG' ? 'SELL' : 'BUY';

      if (d.action === 'CLOSE') {
        // 보유 수량을 먼저 읽는다. reduceOnly라도 수량은 필요하다.
        const posRes: any = await bf.getFuturesPositions(key, secret, testnet);
        const list: any[] = Array.isArray(posRes?.positions) ? posRes.positions : [];
        const pos = list.find(p => String(p.symbol) === d.symbol && Math.abs(Number(p.amount)) > 0);

        let ok: boolean;
        if (!pos) {
          ok = true;   // 이미 포지션이 없다 — 목표가 달성된 상태로 본다
        } else {
          const r: any = await bf.placeFuturesOrder(key, secret, {
            symbol: d.symbol, side: exitSide, type: 'MARKET',
            quantity: Math.abs(Number(pos.amount)), reduceOnly: true,
          }, testnet);
          ok = r?.success === true;
        }
        if (!dryRun) {
          await sb.from('ladder_daily_trades').update({
            status: ok ? 'CLOSED' : 'OPEN',
            exit_reason: `${d.reason}${ok ? '' : ' (청산 실패)'}`,
            ...(ok ? { closed_at: new Date().toISOString() } : {}),
          }).eq('id', d.tradeId);
        }
        results.push({ symbol: d.symbol, action: 'CLOSE', ok, reason: d.reason });
        continue;
      }

      // ── MOVE_STOP: 새 손절을 먼저 걸고, 성공하면 기존 것을 취소한다 ──
      // 순서가 중요하다. 취소를 먼저 하면 그 사이에 새 주문이 실패했을 때
      // 손절 없는 포지션이 남는다. 반대로 하면 잠깐 손절이 둘이 되는데,
      // 둘 다 closePosition이라 먼저 걸리는 쪽이 전량을 닫고 나머지는
      // 자동으로 무효가 된다. 겹치는 편이 비는 것보다 안전하다.
      const placed = await bf.placeFuturesTPSL(key, secret, {
        symbol: d.symbol, side: exitSide, stopPrice: d.newStop!, type: 'STOP_MARKET',
      }, testnet);

      if (!(placed as any)?.success) {
        results.push({ symbol: d.symbol, action: 'MOVE_STOP', ok: false, error: `새 손절 실패: ${(placed as any)?.message}` });
        continue;
      }

      // 기존 STOP_MARKET(closePosition) 중 방금 건 것 외에는 취소
      const newId = String((placed as any).orderId);
      let cancelled = 0;
      try {
        const open = await bf.getFuturesOpenOrders(key, secret, testnet, d.symbol);
        for (const o of (Array.isArray(open) ? open : []) as any[]) {
          if (String(o.orderId) === newId) continue;
          if (String(o.type).toUpperCase() !== 'STOP_MARKET') continue;
          if (o.closePosition !== true) continue;    // 분할 익절은 건드리지 않는다
          await bf.cancelFuturesOrder(key, secret, d.symbol, o.orderId, testnet);
          cancelled++;
        }
      } catch { /* 취소 실패 시 손절이 둘 남는다 — 위험하지 않다 */ }

      if (!dryRun) {
        await sb.from('ladder_daily_trades').update({
          stop_loss: d.newStop,
          exit_reason: d.reason,
        }).eq('id', d.tradeId);
      }
      results.push({ symbol: d.symbol, action: 'MOVE_STOP', ok: true, newStop: d.newStop, cancelledOld: cancelled, reason: d.reason });
    } catch (e: any) {
      results.push({ symbol: d.symbol, action: d.action, ok: false, error: e?.message || '실행 실패' });
    }
  }

  return NextResponse.json({
    ok: true, checked: decisions.length, actionable: actionable.length, alerts, results,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
