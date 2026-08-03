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
  /** 사용자별 키·망. 없으면 예전처럼 전역 망을 쓴다(하위 호환). */
  connFor?: (uid: string) => Promise<{ key: string; secret: string; testnet: boolean } | null>,
): Promise<{ tradeId: string; symbol: string; verdict: GuardVerdict }[]> {
  if (decisions.length === 0) return [];

  const bf = await import('@/lib/exchanges/binanceFutures');
  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  const out: { tradeId: string; symbol: string; verdict: GuardVerdict }[] = [];

  // 사용자별로 키를 한 번만 읽는다
  const credCache = new Map<string, { key: string; secret: string; testnet: boolean } | null>();

  for (const d of decisions) {
    try {
      if (!credCache.has(d.userId)) {
        if (connFor) {
          const c = await connFor(d.userId);
          credCache.set(d.userId, c ? { key: c.key, secret: c.secret, testnet: c.testnet } : null);
        } else {
          const { data: conn } = await sb.from('exchange_connections')
            .select('api_key, api_secret_enc, is_testnet')
            .eq('user_id', d.userId).eq('is_active', true).limit(1).maybeSingle();
          credCache.set(d.userId, conn
            ? { key: (conn as any).api_key, secret: decryptSecret((conn as any).api_secret_enc ?? ''),
                testnet: (conn as any).is_testnet !== false }
            : null);
        }
      }
      const cred = credCache.get(d.userId);
      if (!cred) continue;
      // **이 사용자의 망으로 본다.** 다른 망을 보면 포지션이 없는 것처럼
      // 보이고, 위의 "포지션 없으면 이미 닫힌 것" 분기로 빠져서 실제로
      // 열려 있는 포지션이 점검에서 통째로 사라진다.
      const tnet = cred.testnet;

      const posRes: any = await bf.getFuturesPositions(cred.key, cred.secret, tnet);
      const reachable = posRes?.success === true;
      const pos = reachable
        ? (posRes.positions as any[]).find(p => String(p.symbol) === d.symbol && Math.abs(Number(p.amount)) > 0)
        : null;

      // 거래소에 포지션이 없으면 이미 닫힌 것 — 점검 대상이 아니다
      if (reachable && !pos) continue;

      let hasStop = false;
      if (reachable) {
        try {
          const open = await bf.getFuturesOpenOrders(cred.key, cred.secret, tnet, d.symbol);
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

/**
 * SENT/UNKNOWN으로 남은 주문을 거래소 조회로 확정한다.
 *
 * 연결이 끊겼다 붙은 뒤에 반드시 거쳐야 하는 단계다. 주문을 재전송하지
 * 않고 조회만 하므로 중복 체결 위험이 없다. 활성 연결마다 한 번씩 돌린다.
 */
async function recoverUnresolvedOrders(
  sb: any, testnet: boolean,
): Promise<{ checked: number; resolved: number; stillUnknown: number; needsAttention: number; details: string[] }> {
  const out = { checked: 0, resolved: 0, stillUnknown: 0, needsAttention: 0, details: [] as string[] };
  try {
    // 미확정 주문이 있는 연결만 고른다. 없으면 거래소를 부를 이유가 없다.
    const { data: pend } = await sb.from('live_orders')
      .select('connection_id').in('status', ['SENT', 'UNKNOWN']).limit(50);
    const connIds = Array.from(new Set(
      (Array.isArray(pend) ? pend : []).map((r: any) => r.connection_id).filter(Boolean)));
    if (connIds.length === 0) return out;

    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const { reconcilePendingOrders } = await import('@/lib/engine/orderExecutor');

    for (const cid of connIds) {
      const { data: conn } = await sb.from('exchange_connections')
        .select('exchange_id, api_key, api_secret_enc, has_withdrawal, is_testnet')
        .eq('id', cid).maybeSingle();
      if (!conn || (conn as any).has_withdrawal) continue;

      const ex = String((conn as any).exchange_id || '').toLowerCase().includes('gate') ? 'gate' : 'binance';
      const r = await reconcilePendingOrders(sb, {
        exchange: ex as 'binance' | 'gate',
        apiKey: (conn as any).api_key,
        apiSecret: decryptSecret((conn as any).api_secret_enc ?? ''),
        // **연결이 정한다. 전역 기본값을 섞지 않는다.**
        //
        // 예전에는 `is_testnet !== false ? true : testnet`이었다. 실전
        // 연결이면 삼항의 else로 빠져 전역 testnet을 쓰는데, 그 기본값이
        // true(테스트넷)다. 결과: **실전 연결의 미확정 주문을 테스트넷에
        // 물어보고, 없으니 영영 확정되지 않는다.** 미확정 주문이 남아
        // 있으면 다음 진입이 상태 대조에서 막힌다 — 하나가 다음을 막는다.
        testnet: (conn as any).is_testnet !== false,
      });
      out.checked += r.checked; out.resolved += r.resolved;
      out.stillUnknown += r.stillUnknown; out.needsAttention += r.needsAttention;
      out.details.push(...r.details);
    }
  } catch (e: any) {
    // 복구 실패가 청산 감시를 막으면 안 된다. 사실만 남기고 계속한다.
    out.details.push(`복구 실패: ${e?.message || e}`);
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    // ── 401은 두 가지가 전혀 다른 문제인데 문구가 같았다 ──
    //
    //  (가) 서버에 ADMIN_SECRET이 아예 없다 → Vercel에 넣고 **재배포**해야 한다
    //  (나) 있는데 보낸 값과 다르다        → GitHub 시크릿을 맞춰야 한다
    //
    // "인증 필요"만 적으면 둘을 구분할 수 없어서, 이미 넣어 둔 사람이
    // 같은 값을 계속 다시 넣게 된다. 실제로 그 상태였다.
    //
    // **값은 절대 싣지 않는다.** 있다/없다와 길이만 본다 — 길이는 앞뒤
    // 공백이 딸려 들어간 경우를 잡는 데 쓰인다(복사할 때 가장 흔한 실수).
    const adminSet = !!process.env.ADMIN_SECRET;
    const cronSet = !!process.env.CRON_SECRET;
    const sent = req.headers.get('x-admin-secret') || '';
    const hint = !adminSet
      ? '서버에 ADMIN_SECRET이 없습니다 — Vercel → Settings → Environment Variables에 넣고 **재배포**하세요. 저장만 하면 기존 배포에는 적용되지 않습니다.'
      : !sent
        ? 'x-admin-secret 헤더가 오지 않았습니다.'
        : sent.length !== String(process.env.ADMIN_SECRET).length
          ? `보낸 값의 길이가 서버 값과 다릅니다 (보낸 ${sent.length}자 / 서버 ${String(process.env.ADMIN_SECRET).length}자) — 복사할 때 앞뒤 공백이나 줄바꿈이 딸려 들어갔는지 확인하세요.`
          : '길이는 같은데 값이 다릅니다 — GitHub의 EXIT_MONITOR_SECRET을 Vercel의 ADMIN_SECRET과 똑같이 맞추세요.';

    // ── 지문 ──
    //
    // "값이 다르다"까지는 알았는데, 그게 **다른 값을 넣어서**인지
    // **재배포가 아직 반영이 안 돼서**인지를 구분할 수 없다. 후자면
    // 아무리 다시 넣어도 안 되고, 그 상태가 오래 간다.
    //
    // SHA-256 앞 6자리만 돌려준다. 24비트라 값을 되찾을 수 없고(UUID는
    // 2^122 공간이다), 양쪽이 같은 값을 들고 있는지는 한눈에 보인다.
    // 재배포가 먹었는지도 이 값이 바뀌는 것으로 알 수 있다.
    const { createHash } = await import('crypto');
    const fp = (v: string) => v ? createHash('sha256').update(v).digest('hex').slice(0, 6) : null;

    return NextResponse.json({
      ok: false,
      error: '인증 필요 — Vercel Cron(Bearer) 또는 x-admin-secret 헤더가 맞아야 합니다',
      message: hint,
      // 값이 아니라 **설정 여부**다. 이게 있어야 어느 쪽을 고칠지 안다.
      adminSecretSet: adminSet,
      cronSecretSet: cronSet,
      // 서버가 지금 들고 있는 값의 지문. 재배포 전후로 이 값이 바뀌면
      // 배포가 반영된 것이고, 안 바뀌면 아직이다.
      serverFingerprint: fp(String(process.env.ADMIN_SECRET || '')),
      sentFingerprint: fp(sent),
    }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry') === '1';
  // **환경변수는 기본값일 뿐이다.** 실제로 어느 망인지는 그 포지션을
  // 들고 있는 연결이 정한다 (아래 connFor).
  const testnet = (process.env.LADDER_MODE || 'TESTNET').toUpperCase() !== 'LIVE';

  const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });
  const cronStartedAt = Date.now();

  // ── 사용자별 연결 ──
  //
  // **여기가 사고가 날 뻔한 자리다.**
  //
  // 예전에는 이 라우트 전체가 환경변수 하나(LADDER_MODE)로 망을 정했다.
  // 진입(daily-ladder)은 연결의 is_testnet을 따라 실계좌로 나가는데,
  // 청산 감시는 LADDER_MODE가 LIVE가 아니면 테스트넷을 봤다. 그러면
  // 실계좌 포지션에 대해:
  //   · 트레일링 손절이 안 움직이고
  //   · 시간 청산이 안 되고
  //   · 포지션 점검이 "포지션 없음"이라고 보고한다
  // 전부 조용히. **못 여는 것은 불편이고 못 닫는 것은 사고다.**
  //
  // 한 번 읽고 캐시한다 — 사용자 수만큼만 조회한다.
  const connCache = new Map<string, { key: string; secret: string; testnet: boolean } | null>();
  const connFor = async (uid: string): Promise<{ key: string; secret: string; testnet: boolean } | null> => {
    if (!connCache.has(uid)) {
      let v: { key: string; secret: string; testnet: boolean } | null = null;
      try {
        const { data: c } = await sb.from('exchange_connections')
          .select('api_key, api_secret_enc, has_withdrawal, is_testnet')
          .eq('user_id', uid).eq('is_active', true).limit(1).maybeSingle();
        if (c && !(c as any).has_withdrawal) {
          const { decryptSecret } = await import('@/lib/exchanges/crypto');
          v = {
            key: (c as any).api_key,
            secret: decryptSecret((c as any).api_secret_enc ?? ''),
            // 저장소 전체 규칙: is_testnet === false 만 실전이다.
            testnet: (c as any).is_testnet !== false,
          };
        }
      } catch { v = null; }
      connCache.set(uid, v);
    }
    return connCache.get(uid) ?? null;
  };
  /** 이 사용자의 포지션이 어느 망에 있나. 못 알아내면 null — 추측하지 않는다. */
  const testnetFor = async (uid: string): Promise<boolean | null> => {
    const c = await connFor(uid);
    return c ? c.testnet : null;
  };

  // ── 미확정 주문 복구 ──
  //
  // 청산 판단보다 먼저 한다. UNKNOWN 주문이 실제로는 체결돼 있었다면,
  // 그것을 모른 채 청산을 계산하면 없는 포지션을 닫으려 하거나 실제
  // 포지션을 놓친다. 결과가 확정된 뒤에 판단해야 한다.
  //
  // 이 복구는 절대 주문을 다시 보내지 않는다 — 거래소에 조회만 한다
  // (unknownResolver.ts 참고).
  const recovery = await recoverUnresolvedOrders(sb, testnet);

  const { decideExits } = await import('@/lib/engine/exitMonitor');

  // 지금 거래소에 실제로 걸려 있는 손절가를 읽어 주는 함수.
  //
  // DB의 stop_loss는 **진입 시점 값**이고 1R을 정의한다. 그 둘을 한 칸에
  // 두면(예전처럼 옮길 때마다 덮어쓰면) 1R이 매번 커져서 트레일링이 한 번
  // 움직인 뒤 멈춘다 — 첫 이동은 일어나므로 동작하는 것처럼 보인다.
  //
  // 사용자마다 키가 다르므로 사용자 단위로 한 번만 읽어 캐시한다.
  const stopCache = new Map<string, Map<string, number> | null>();
  const liveStopFor = async (uid: string, symbol: string): Promise<number | null> => {
    if (!stopCache.has(uid)) {
      let m: Map<string, number> | null = null;
      try {
        const c = await connFor(uid);
        if (c) {
          const bfx = await import('@/lib/exchanges/binanceFutures');
          // getFuturesOpenOrders는 {success, orders} 모양을 돌려준다.
          // 배열로 착각하면 조용히 0건이 되고, 그러면 진입 손절을 계속 쓴다.
          // **망은 이 사용자의 연결이 정한다** — 다른 망의 주문 목록을
          // 읽으면 손절이 없는 것처럼 보인다.
          const res: any = await bfx.getFuturesOpenOrders(c.key, c.secret, c.testnet);
          const open: any[] = Array.isArray(res) ? res : (res?.orders ?? []);
          m = new Map<string, number>();
          for (const o of open) {
            if (String(o?.type).toUpperCase() !== 'STOP_MARKET') continue;
            if (o?.closePosition !== true) continue;   // 분할 익절 사다리는 제외
            const p = Number(o?.stopPrice);
            if (Number.isFinite(p) && p > 0) m.set(String(o.symbol).toUpperCase(), p);
          }
        }
      } catch { m = null; }   // 못 읽으면 진입 손절을 그대로 쓴다
      stopCache.set(uid, m);
    }
    return stopCache.get(uid)?.get(String(symbol).toUpperCase()) ?? null;
  };

  const { readTrailConfig } = await import('@/lib/engine/trailPlan');
  const { cfg: trailCfg } = readTrailConfig(k => process.env[k]);

  const decisions = await decideExits(sb, { testnet, testnetFor, liveStopFor, cfg: trailCfg });

  // ── 기술적 사고 점검 ──
  // 트레일링·시간청산 판단보다 먼저 본다. 청산가에 다다랐거나 손절이
  // 사라졌거나 마진이 Cross로 바뀐 상태라면, 손절선을 옮길 때가 아니라
  // 포지션을 닫아야 할 때다.
  //
  // 이 점검은 방향으로 판단하지 않는다 (positionGuard.ts 참고).
  const guardFindings = await runPositionGuards(sb, decisions, testnet, connFor);
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
      alerts, recovery,
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
      // 키도 망도 이 사용자의 연결에서 온다. 환경변수로 정하면 실계좌
      // 포지션을 테스트넷에서 닫으려 하고, 그건 조용히 실패한다.
      const cr = await connFor(d.userId);
      if (!cr) {
        results.push({ symbol: d.symbol, ok: false,
          error: '활성 거래소 연결 없음(또는 출금 권한 키) — 청산 주문을 낼 수 없습니다' });
        continue;
      }
      const key = cr.key, secret = cr.secret;
      const testnet = cr.testnet;          // **전역 값을 가린다 — 의도적이다**
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
        // **stop_loss를 덮어쓰지 않는다.** 그 칸은 진입 시점 값이고 1R을
        // 정의한다. 덮어쓰면 다음 주기에 1R이 커져서 트레일링이 멈춘다.
        // 지금 걸린 손절은 거래소가 갖고 있고, 위에서 그것을 읽어 쓴다.
        await sb.from('ladder_daily_trades').update({
          exit_reason: d.reason,
        }).eq('id', d.tradeId);
      }
      results.push({ symbol: d.symbol, action: 'MOVE_STOP', ok: true, newStop: d.newStop, cancelledOld: cancelled, reason: d.reason });
    } catch (e: any) {
      results.push({ symbol: d.symbol, action: d.action, ok: false, error: e?.message || '실행 실패' });
    }
  }

  // 돌았다는 사실을 남긴다. 이게 없으면 크론이 조용히 죽어도 아무도
  // 모른다 — 캘린더 동기화가 vercel.json에 등록조차 안 된 채로 몇 달을
  // 보낸 것이 정확히 그 결과였다.
  const { recordCronRun } = await import('@/lib/system/cronLog');
  const cronLog = await recordCronRun(sb, 'exit-monitor',
    actionable.length > 0 ? 'ok' : 'skipped',
    `${decisions.length}건 확인 · ${actionable.length}건 처리`, cronStartedAt);

  return NextResponse.json({
    ok: true, checked: decisions.length, actionable: actionable.length, alerts, recovery, results,
    cronLogError: cronLog.error,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
