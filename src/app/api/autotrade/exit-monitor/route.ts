// /api/autotrade/exit-monitor
//
// 계단식 거래의 트레일링 · 본전 이동 · 시간 청산을 실행한다.
//
// 누가 부르는가
// ─────────────
//   Fly Worker   5분마다. **주 실행자다.** 이미 가진 ADMIN_SECRET으로
//                부르므로 맞춰야 할 비밀이 따로 없다
//   Vercel Cron  하루 1회 (무료 플랜 한도). 워커가 죽었을 때의 그물
//   GitHub       선택. 시크릿이 있으면 백업으로 돈다
//
// 예전에는 GitHub Actions가 15분마다 별도 시크릿(EXIT_MONITOR_SECRET)으로
// 불렀다. 그 값이 Vercel의 ADMIN_SECRET과 한 글자만 달라도 401이었고,
// **2026-08-03부터 30번 연속 401이었다.** 그동안 트레일링·본전 이동·
// 시간 청산은 한 번도 돌지 않았다. 시크릿을 맞추는 일을 자동화하는 것보다
// 그 시크릿이 필요 없게 만드는 쪽이 맞다.
//
// 왜 여기서 주문을 내는가: Binance가 Fly/Railway의 IP 지역을 차단한다.
// Vercel은 regions가 hnd1(도쿄)이라 정상 연결된다. 그래서 **판단과 주문은
// 여기, 깨우는 일은 워커**다.
//
// 인증: Vercel Cron은 CRON_SECRET이 설정돼 있으면
//       Authorization: Bearer <CRON_SECRET> 을 붙여 호출한다.
//       워커·수동 점검용으로 x-admin-secret도 허용한다.
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
  decisions: {
    tradeId: string; userId: string; symbol: string; side: 'LONG' | 'SHORT';
    /** 이 거래의 연결. 있으면 **그 연결로만** 조회한다 */
    connectionId?: string | null;
  }[],
  testnet: boolean,
  /**
   * 이 거래의 키·망.
   *
   * **거래를 통째로 넘긴다 — user_id만 넘기지 않는다.** 예전에는
   * 사용자별이었고, 활성 연결이 둘 이상이면 A 계좌에서 연 포지션을
   * B 계좌에서 찾았다. 조회는 조용히 "포지션 없음"으로 돌아온다.
   */
  connFor?: (d: { userId: string; connectionId?: string | null })
    => Promise<{ key: string; secret: string; testnet: boolean } | null>,
  /**
   * 포지션이 이미 0인 종목에서 치운 보호주문 기록을 담는다.
   *
   * **결과를 응답에 싣기 위한 것이지 판단에 쓰지 않는다** — 정리 여부가
   * 청산 판단을 바꾸면 안 된다.
   */
  orphanCleanups?: any[],
): Promise<{ tradeId: string; symbol: string; verdict: GuardVerdict }[]> {
  if (decisions.length === 0) return [];

  // **거래소를 가리지 않는다.** 예전에는 여기서 바이낸스 함수를 직접
  // 불렀다 — Gate 연결이면 포지션 조회가 실패하고, 그 실패가 "포지션
  // 없음"으로 읽혀 **점검 대상에서 통째로 빠졌다.**
  const ops = await import('@/lib/engine/venuePositionOps');
  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  const out: { tradeId: string; symbol: string; verdict: GuardVerdict }[] = [];

  // 사용자별로 키를 한 번만 읽는다
  const credCache = new Map<string, { key: string; secret: string; testnet: boolean; exchange: 'binance' | 'gate' } | null>();

  for (const d of decisions) {
    try {
      // **연결 단위로 캐시한다.** 사용자 단위로 캐시하면 같은 사용자의
      // 두 연결이 한 키를 공유하게 되어, 두 번째 거래가 첫 번째의
      // 계좌에서 조회된다.
      const cacheKey = d.connectionId ? `c:${d.connectionId}` : `u:${d.userId}`;
      if (!credCache.has(cacheKey)) {
        if (connFor) {
          const c: any = await connFor(d);
          credCache.set(cacheKey, c
            ? { key: c.key, secret: c.secret, testnet: c.testnet, exchange: c.exchange ?? 'binance' }
            : null);
        } else {
          const { data: conn } = await sb.from('exchange_connections')
            .select('api_key, api_secret_enc, is_testnet, exchange_id')
            .eq('user_id', d.userId).eq('is_active', true).limit(1).maybeSingle();
          if (conn) {
            const { resolveExecExchange } = await import('@/lib/exchanges/futuresExec');
            const ex = resolveExecExchange((conn as any).exchange_id).exchange;
            // **모르는 거래소를 바이낸스로 읽지 않는다.**
            credCache.set(cacheKey, ex ? {
              key: (conn as any).api_key,
              secret: decryptSecret((conn as any).api_secret_enc ?? ''),
              testnet: (conn as any).is_testnet !== false,
              exchange: ex,
            } : null);
          } else credCache.set(cacheKey, null);
        }
      }
      const cred = credCache.get(cacheKey);
      if (!cred) continue;

      const venue = {
        exchange: cred.exchange, apiKey: cred.key, apiSecret: cred.secret, testnet: cred.testnet,
      };
      const snap = await ops.readGuardSnapshot(venue, d.symbol);

      // ── 거래소에 포지션이 없다 ──
      //
      // 이미 닫힌 것이므로 청산 점검 대상은 아니다.
      // **조회에 성공했을 때만 그렇게 읽는다.**
      //
      // 그런데 예전에는 여기서 그냥 넘어갔다. 그래서 **거래소 SL이나
      // TP가 포지션을 닫아 준 직후, 남은 형제 주문이 아무에게도
      // 청구되지 않고 그대로 남았다.** 다음 날 신규 진입이 그 위에 새
      // SL/TP를 얹기 전까지 아무도 안 치웠고, 그게 정상 동작처럼
      // 굳어 있었다 — 실제 Gate에 Positions 0 / Orders 1이 남은 이유다.
      //
      // 다음 진입 때까지 기다리지 않는다. **닫힌 그 순간 치운다.**
      // 여기서는 전략 id를 들고 있지 않으므로 **적어 둔 주문 번호와
      // 일치하는 것만** 지운다(`ownedOnly`) — 남의 손절은 절대 안 지운다.
      if (snap.ok && !snap.found) {
        if (orphanCleanups) {
          try {
            const { cleanupOwnedProtectionWhenFlat, loadOwnedProtectionIds } =
              await import('@/lib/engine/protectionCleanup');
            const owned = await loadOwnedProtectionIds(sb, { userId: d.userId, symbol: d.symbol, limit: 5 });
            if (owned.ids.length > 0) {
              const r = await cleanupOwnedProtectionWhenFlat(venue, d.symbol, {
                position: { ok: snap.ok, found: snap.found, qty: null },
                myStrategyId: '', ownedIds: owned.ids, ownedOnly: true,
              });
              // **아무것도 안 지운 경우는 적지 않는다** — 매 분 도는
              // 경로라 로그가 그것만으로 덮인다.
              if (r.code !== 'NOTHING_TO_DO') {
                orphanCleanups.push({
                  symbol: d.symbol, tradeId: d.tradeId, code: r.code, ok: r.ok,
                  cancelled: r.cancelled, stillPresent: r.stillPresent, unknown: r.unknown,
                  reason: r.reason,
                });
              }
            }
          } catch (e: any) {
            // **조용히 넘기지 않는다.** 못 치웠다는 사실이 남아야 한다.
            orphanCleanups.push({ symbol: d.symbol, tradeId: d.tradeId, code: 'CLEANUP_ERROR',
              ok: false, reason: String(e?.message || e) });
          }
        }
        continue;
      }

      const verdict = checkPositionGuard({
        symbol: d.symbol,
        side: d.side,
        entryPrice: snap.entryPrice ?? 0,
        // **못 읽었으면 null이다.** 0으로 넘기면 "청산가를 지났다"가 되어
        // 멀쩡한 포지션이 강제 청산된다.
        markPrice: snap.markPrice,
        liquidationPrice: snap.liquidationPrice ?? 0,
        marginType: snap.marginType,
        // 손절 여부를 못 읽었으면 **있다고도 없다고도 하지 않는다** —
        // 없는 것으로 읽으면 "손절이 사라졌다"로 포지션을 닫는다.
        hasProtectiveStop: snap.hasProtectiveStop !== false,
        exchangeReachable: snap.ok,
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
        .select('user_id, exchange_id, api_key, api_secret_enc, has_withdrawal, is_testnet')
        .eq('id', cid).maybeSingle();
      if (!conn || (conn as any).has_withdrawal) continue;

      const ex = (await import('@/lib/exchanges/futuresAdapter')).futuresExchangeOf((conn as any).exchange_id);
      // **건너뛰되 조용히 넘어가지 않는다.** 이 루프는 사람이 안 보는
      // 사이에 도는 경로라, 여기서 말없이 continue하면 그 연결의 미확정
      // 주문은 영영 확정되지 않는다 — 그리고 미확정이 하나 남으면
      // 다음 진입이 상태 대조에서 막힌다.
      if (!ex) {
        out.details.push(
          `연결 ${String(cid).slice(0, 8)}: 선물을 지원하지 않는 거래소라 대조하지 못했습니다`
          + ` (${(conn as any).exchange_id || '알 수 없음'}) — 미확정 주문이 남아 있으면 `
          + '다음 진입이 상태 대조에서 막힙니다');
        out.needsAttention += 1;
        continue;
      }
      const r = await reconcilePendingOrders(sb, {
        exchange: ex,
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
        // 이 연결의 주인 것만, 이 연결 것만. 없으면 한 사람의 키로
        // 모든 사용자의 주문을 대조하게 된다.
        userId: (conn as any).user_id ?? null,
        connectionId: cid,
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
      ? '서버에 ADMIN_SECRET이 없습니다 — 이 값이 없으면 워커도 청산 감시를 부를 수 없습니다.'
      : !sent
        ? 'x-admin-secret 헤더가 오지 않았습니다.'
        : sent.length !== String(process.env.ADMIN_SECRET).length
          ? `보낸 값의 길이가 서버 값과 다릅니다 (보낸 ${sent.length}자 / 서버 ${String(process.env.ADMIN_SECRET).length}자) — 복사할 때 앞뒤 공백이나 줄바꿈이 딸려 들어갔는지 확인하세요.`
          : '길이는 같은데 값이 다릅니다 — 부른 쪽이 들고 있는 값이 이 서버의 ADMIN_SECRET과 다릅니다.';

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

  // ── 두 번 돌지 않는다 ──
  //
  // 청산 감시는 이제 워커가 5분마다 깨운다. 워커가 재시작하거나 두 대가
  // 동시에 뜨면 같은 순간에 두 번 깨울 수 있고, 그러면 **같은 포지션에
  // 손절 이동이 두 번 나간다.** 되돌릴 수 없는 종류다.
  //
  // 한 줄짜리 임차로 막고, 울타리 번호로 "느린 실행이 뒤늦게 깨어나
  // 자기가 아직 주인인 줄 아는 것"까지 막는다.
  // 판정은 exitMonitorLease.ts에 있고 테스트가 붙어 있다.
  const { leaseDecision, fenceStillMine, LEASE_TTL_MS } = await import('@/lib/engine/exitMonitorLease');
  const runner = String(req.headers.get('x-traigo-source') || '').trim() || 'manual';
  const holder = `${runner}:${String(req.headers.get('x-traigo-worker') || '').trim() || 'anon'}`;

  let myFence: number | null = null;
  let leaseTracked = true;
  {
    let current: any = undefined;
    try {
      const { data, error } = await (sb as any)
        .from('exit_monitor_lease').select('holder, fence, expires_at').eq('id', 1).maybeSingle();
      if (!error) current = data ?? null;
      else if (/does not exist|schema cache|relation/i.test(String(error.message))) {
        // 058이 아직인 배포. **여기서 막으면 청산 감시가 통째로 멈춘다** —
        // 그건 이 안전장치가 막으려던 것보다 나쁘다. 예전처럼 돈다.
        leaseTracked = false;
      }
    } catch { /* undefined로 남는다 → 실행하지 않는다 */ }

    if (leaseTracked) {
      const d = leaseDecision({
        current: current == null ? current : {
          holder: String(current.holder), fence: Number(current.fence) || 0,
          expiresAtMs: Date.parse(String(current.expires_at)),
        },
        me: holder, nowMs: cronStartedAt,
      });
      if (!d.granted) {
        // **기다리지 않는다.** 그쪽이 하면 되는 일이다.
        return NextResponse.json({ ok: true, skipped: true, code: d.code, message: d.reason },
          { headers: { 'Cache-Control': 'no-store' } });
      }
      myFence = d.nextFence;
      const { error: upErr } = await (sb as any).from('exit_monitor_lease').upsert({
        id: 1, holder, fence: myFence,
        acquired_at: new Date(cronStartedAt).toISOString(),
        expires_at: new Date(cronStartedAt + LEASE_TTL_MS).toISOString(),
      }, { onConflict: 'id' });
      if (upErr) {
        return NextResponse.json({ ok: true, skipped: true, code: 'LEASE_WRITE_FAILED',
          message: `임차를 적지 못해 이번은 건너뜁니다: ${String(upErr.message).slice(0, 200)}` },
          { headers: { 'Cache-Control': 'no-store' } });
      }
    }
  }

  /** 주문을 내기 직전에 다시 묻는다 — 내 울타리가 아직 최신인가 */
  const stillMine = async (): Promise<boolean> => {
    if (!leaseTracked) return true;
    let cur: number | null | undefined = undefined;
    try {
      const { data, error } = await (sb as any)
        .from('exit_monitor_lease').select('fence').eq('id', 1).maybeSingle();
      if (!error) cur = data == null ? null : Number(data.fence);
    } catch { /* undefined */ }
    return fenceStillMine({ myFence, currentFence: cur }).ok;
  };

  // 회차를 연다. **돌기 시작했다는 사실부터 남긴다** — 중간에 죽으면
  // finished_at이 비어 있는 줄이 남고, 그게 "돌다 죽었다"의 증거다.
  const EXIT_MONITOR_INTERVAL_MS = 5 * 60_000;
  let runId: string | null = null;
  try {
    const { data } = await (sb as any).from('exit_monitor_runs').insert({
      started_at: new Date(cronStartedAt).toISOString(),
      source: runner,
      worker_id: String(req.headers.get('x-traigo-worker') || '').trim() || null,
      worker_sha: String(req.headers.get('x-traigo-sha') || '').trim() || null,
      status: 'RUNNING',
      next_expected_at: new Date(cronStartedAt + EXIT_MONITOR_INTERVAL_MS).toISOString(),
    }).select('id').single();
    runId = data?.id ?? null;
  } catch { /* 058이 아직이면 null로 남는다 — 감시는 계속 돈다 */ }

  /** 회차를 닫는다. **실패도 닫는다** — 열린 채로 두면 다음 회차가 밀린 것으로 읽는다 */
  const closeRun = async (fields: Record<string, any>): Promise<void> => {
    if (!runId) return;
    try {
      await (sb as any).from('exit_monitor_runs')
        .update({ finished_at: new Date().toISOString(), ...fields }).eq('id', runId);
    } catch { /* 기록 실패가 청산을 막지는 않는다 */ }
  };


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
  type ConnCreds = {
    key: string; secret: string; testnet: boolean; exchange: 'binance' | 'gate' | null;
    /** 이 자격이 **거래에 적힌 연결**에서 온 것인가, 사용자 단위 추측인가 */
    guessed: boolean;
  };
  const connCache = new Map<string, ConnCreds | null>();

  /** 거래에 적힌 연결을 그대로 읽는다 */
  const connById = async (connectionId: string): Promise<ConnCreds | null> => {
    const k = `c:${connectionId}`;
    if (!connCache.has(k)) {
      let v: ConnCreds | null = null;
      try {
        const { data: c } = await sb.from('exchange_connections')
          .select('api_key, api_secret_enc, has_withdrawal, is_testnet, exchange_id')
          .eq('id', connectionId).maybeSingle();
        if (c && !(c as any).has_withdrawal) {
          const { decryptSecret } = await import('@/lib/exchanges/crypto');
          const { resolveExecExchange } = await import('@/lib/exchanges/futuresExec');
          v = {
            key: (c as any).api_key,
            secret: decryptSecret((c as any).api_secret_enc ?? ''),
            testnet: (c as any).is_testnet !== false,
            exchange: resolveExecExchange((c as any).exchange_id).exchange,
            guessed: false,
          };
        }
      } catch { v = null; }
      connCache.set(k, v);
    }
    return connCache.get(k) ?? null;
  };

  /**
   * **거래 하나의 자격.**
   *
   * 거래에 연결이 적혀 있으면(065 이후) 그것만 쓴다. 없으면 예전처럼
   * 사용자 단위로 찾되 `guessed: true`로 표시한다 — 추측한 것과 아는
   * 것은 다르고, 그 차이가 응답에 남아야 한다.
   */
  const connForTrade = async (
    d: { userId: string; connectionId?: string | null },
  ): Promise<ConnCreds | null> => {
    if (d.connectionId) return connById(d.connectionId);
    return connForUser(d.userId);
  };

  const connForUser = async (uid: string): Promise<ConnCreds | null> => {
    const k = `u:${uid}`;
    if (!connCache.has(k)) {
      let v: ConnCreds | null = null;
      try {
        const { data: c } = await sb.from('exchange_connections')
          .select('api_key, api_secret_enc, has_withdrawal, is_testnet, exchange_id')
          .eq('user_id', uid).eq('is_active', true).limit(1).maybeSingle();
        if (c && !(c as any).has_withdrawal) {
          const { decryptSecret } = await import('@/lib/exchanges/crypto');
          // **어느 거래소인지 같이 들고 다닌다.**
          //
          // 예전에는 이 값을 안 읽고 무조건 바이낸스 함수로 조회했다.
          // Gate 연결이면 Gate 키로 바이낸스를 부르는 것이라 인증 오류로
          // 끝나고, 그 실패가 아래에서 "포지션 없음"으로 읽혔다.
          const { resolveExecExchange } = await import('@/lib/exchanges/futuresExec');
          const ex = resolveExecExchange((c as any).exchange_id).exchange;
          v = {
            key: (c as any).api_key,
            secret: decryptSecret((c as any).api_secret_enc ?? ''),
            // 저장소 전체 규칙: is_testnet === false 만 실전이다.
            testnet: (c as any).is_testnet !== false,
            exchange: ex,
            // **하나를 골라 온 것이다.** 활성 연결이 둘 이상이면 이 값은
            // 그 거래의 연결이 아닐 수 있다.
            guessed: true,
          };
        }
      } catch { v = null; }
      connCache.set(k, v);
    }
    return connCache.get(k) ?? null;
  };
  /** 이 사용자의 포지션이 어느 망에 있나. 못 알아내면 null — 추측하지 않는다. */
  const testnetFor = async (uid: string): Promise<boolean | null> => {
    const c = await connForUser(uid);
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
  // **거래소를 가리지 않는다.** 예전에는 바이낸스 미체결 주문만 읽었다 —
  // Gate 연결이면 언제나 null이 되어 진입 손절을 계속 1R로 썼고,
  // 그러면 트레일링이 한 번도 움직이지 않는다.
  //
  // 방향까지 봐야 한다. 반대 방향을 닫는 손절은 남의 것이거나 옛 포지션의
  // 고아다(protectiveReadback이 그 판별표를 갖고 있다).
  const stopCache = new Map<string, number | null>();
  const liveStopFor = async (
    uid: string, symbol: string, side?: 'LONG' | 'SHORT', connectionId?: string | null,
  ): Promise<number | null> => {
    // **연결이 열쇠에 들어간다.** 사용자+종목만으로 캐시하면 같은 사용자의
    // 두 연결이 같은 손절가를 공유하게 된다.
    const key = `${connectionId || uid}:${String(symbol).toUpperCase()}:${side ?? ''}`;
    if (!stopCache.has(key)) {
      let v: number | null = null;
      try {
        const c: any = await connForTrade({ userId: uid, connectionId });
        if (c && (side === 'LONG' || side === 'SHORT')) {
          const ops = await import('@/lib/engine/venuePositionOps');
          v = await ops.liveStopPrice(
            { exchange: c.exchange ?? 'binance', apiKey: c.key, apiSecret: c.secret, testnet: c.testnet },
            symbol, side);
        }
      } catch { v = null; }   // 못 읽으면 진입 손절을 그대로 쓴다
      stopCache.set(key, v);
    }
    return stopCache.get(key) ?? null;
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
  // 포지션이 이미 0이 된 종목에서 치운 보호주문. **판단에 쓰지 않고
  // 응답에만 싣는다** — 정리 여부가 청산 판단을 바꾸면 안 된다.
  const orphanCleanups: any[] = [];
  const guardFindings = await runPositionGuards(sb, decisions, testnet, connForTrade, orphanCleanups);
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
      alerts, recovery, orphanCleanups,
      decisions: decisions.map(d => ({
        symbol: d.symbol, action: d.action, reason: d.reason,
        highWaterR: Number(d.highWaterR.toFixed(3)),
        currentStop: d.currentStop, newStop: d.newStop,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // **바이낸스 모듈을 더 이상 부르지 않는다.** 청산·손절 이동·손절 확인이
  // 전부 거래소 공통 경로(venuePositionOps · futuresExec)로 간다.
  const { readPositions, closeVerdict, exitReasonLine } = await import('@/lib/engine/closeEvidence');
  const { futuresListPositions, futuresPlaceOrder } = await import('@/lib/exchanges/futuresExec');
  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  const results: any[] = [];

  // **주문을 내기 직전에 다시 묻는다: 내 울타리가 아직 최신인가.**
  //
  // 여기까지 오는 데 거래소 조회로 수십 초가 걸릴 수 있다. 그 사이 임차가
  // 넘어갔다면 남이 같은 일을 하고 있는 것이고, 내가 마저 내면 **같은
  // 포지션에 손절 이동이 두 번 나간다.**
  if (actionable.length > 0 && !dryRun && !(await stillMine())) {
    await closeRun({
      status: 'OK', positions_scanned: decisions.length, actions: 0,
      orphan_cleanups: Array.isArray(orphanCleanups) ? orphanCleanups.length : null,
      cleanup_detail: Array.isArray(orphanCleanups) && orphanCleanups.length ? orphanCleanups : null,
      errors: '임차가 넘어가 주문을 내지 않았습니다',
    });
    return NextResponse.json({
      ok: true, skipped: true, code: 'LEASE_LOST', checked: decisions.length, actionable: 0,
      orphanCleanups,
      message: '실행 도중 임차가 다른 워커에게 넘어가 주문을 내지 않았습니다 — 그쪽이 같은 판단을 합니다',
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  for (const d of actionable) {
    try {
      // 키도 망도 이 사용자의 연결에서 온다. 환경변수로 정하면 실계좌
      // 포지션을 테스트넷에서 닫으려 하고, 그건 조용히 실패한다.
      // **이 거래의 연결로 낸다.** 연결이 적혀 있지 않은 옛 줄은
      // 사용자 단위로 찾되, 아래에서 그 사실을 결과에 남긴다.
      const cr = await connForTrade(d);
      if (!cr) {
        results.push({ symbol: d.symbol, ok: false,
          error: '활성 거래소 연결 없음(또는 출금 권한 키) — 청산 주문을 낼 수 없습니다' });
        continue;
      }
      const key = cr.key, secret = cr.secret;
      const testnet = cr.testnet;          // **전역 값을 가린다 — 의도적이다**
      const exitSide: 'BUY' | 'SELL' = d.side === 'LONG' ? 'SELL' : 'BUY';

      if (d.action === 'CLOSE') {
        // ── 무엇을 근거로 '닫혔다'고 적는가 ──
        //
        // 예전에는 조회 결과가 배열이 아니면 `list = []`가 되어
        // "포지션이 이미 없다"로 읽었다. `getFuturesPositions`는 실패하면
        // `{ success:false, message }`를 돌려준다 — `positions` 칸이
        // 아예 없다. 그래서 인증 오류·타임아웃·레이트리밋이 전부
        // **아무것도 안 닫고 장부에 CLOSED로 적히는** 결과가 됐다.
        //
        // 판정은 `closeEvidence`에 있고 유닛 테스트가 붙어 있다.
        // **조회에 실패했으면 닫힘이 아니다.**
        if (!cr.exchange) {
          results.push({ symbol: d.symbol, action: 'CLOSE', ok: false,
            error: `선물을 지원하지 않는 거래소라 청산할 수 없습니다 — 거래소에서 직접 닫아 주세요` });
          continue;
        }
        const t = { exchange: cr.exchange, key, secret, testnet };
        const before = readPositions(await futuresListPositions(t as any), d.symbol);

        let order: { attempted: boolean; ok: boolean; error?: string | null } | null = null;
        let after: ReturnType<typeof readPositions> | null = null;

        if (before.ok && before.found) {
          // 수량을 못 읽었으면 보내지 않는다. 임의 수량으로 reduceOnly를
          // 내면 남는 쪽이 생기고, 그 사실을 아무도 모른다.
          if (before.amount == null) {
            order = { attempted: false, ok: false, error: '보유 수량을 읽지 못했습니다' };
          } else {
            const r: any = await futuresPlaceOrder(t as any, {
              symbol: d.symbol, side: exitSide, type: 'MARKET' as const,
              quantity: before.amount, reduceOnly: true,
              clientOrderId: `xm${String(d.tradeId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}`,
            });
            order = { attempted: true, ok: r?.ok === true, error: r?.error ?? r?.message ?? null };
            // **접수는 체결이 아니다.** 보낸 뒤 다시 읽어 확인한다.
            if (order.ok) after = readPositions(await futuresListPositions(t as any), d.symbol);
          }
        }

        const verdict = closeVerdict({ before, order, after });

        // ── 닫았으면 그 자리에서 보호주문을 치운다 ──
        //
        // **여기가 비어 있었다.** `protectionCleanup.ts`의 주석은 이 절차가
        // 필요한 세 곳을 적어 두었고 그중 셋째가 "청산 감시"인데, 정작
        // 청산 감시는 그 함수를 안 불렀다.
        //
        // 다음 회차가 알아서 치워 줄 것이라는 보장도 없다. 성공한 거래는
        // 바로 아래에서 `CLOSED`가 되므로 `decideExits`의 `status='OPEN'`
        // 조회에서 빠진다 — **그 거래는 다시는 이 경로를 지나지 않는다.**
        //
        // 우리가 낸 청산은 reduceOnly라 남은 SL/TP를 자동으로 지우지
        // 않는다. 안 치우면 다음 진입이 옛 주문에 맞아 예상치 못하게 닫힌다.
        let closeCleanup: any = null;
        if (verdict.closed && !dryRun) {
          try {
            const { cleanupOwnedProtectionWhenFlat, loadOwnedProtectionIds } =
              await import('@/lib/engine/protectionCleanup');
            const owned = await loadOwnedProtectionIds(sb, {
              connectionId: d.connectionId ?? null,
              userId: d.connectionId ? null : d.userId,
              symbol: d.symbol, limit: 5,
            });
            if (owned.ids.length > 0) {
              const venueCl = { exchange: cr.exchange, apiKey: key, apiSecret: secret, testnet };
              const cl = await cleanupOwnedProtectionWhenFlat(venueCl, d.symbol, {
                // 방금 재조회한 결과를 그대로 넘긴다. 여기서 또 읽으면
                // 같은 순간에 두 답이 나올 수 있고, 그때 어느 쪽을 믿을지가
                // 또 하나의 갈림길이 된다.
                position: { ok: after?.ok === true, found: after?.found === true, qty: after?.amount ?? null },
                // 전략 id를 들고 있지 않다. **적어 둔 번호와 일치하는 것만.**
                myStrategyId: '', ownedIds: owned.ids, ownedOnly: true,
              });
              if (cl.code !== 'NOTHING_TO_DO') {
                closeCleanup = {
                  code: cl.code, ok: cl.ok, cancelled: cl.cancelled,
                  stillPresent: cl.stillPresent, unknown: cl.unknown, reason: cl.reason,
                };
                orphanCleanups.push({ symbol: d.symbol, tradeId: d.tradeId, at: 'AFTER_CLOSE', ...closeCleanup });
              }
            }
          } catch (e: any) {
            // **조용히 넘기지 않는다.** 못 치웠다는 사실이 남아야 한다.
            closeCleanup = { code: 'CLEANUP_ERROR', ok: false, reason: String(e?.message || e).slice(0, 200) };
            orphanCleanups.push({ symbol: d.symbol, tradeId: d.tradeId, at: 'AFTER_CLOSE', ...closeCleanup });
          }
        }

        if (!dryRun) {
          await sb.from('ladder_daily_trades').update({
            // **닫힘으로 적는 것은 verdict.closed 하나뿐이다.**
            status: verdict.closed ? 'CLOSED' : 'OPEN',
            // 못 닫았으면 왜 못 닫았는지가 장부에 남는다 — 로그에만
            // 있으면 다음 사람이 처음부터 다시 조사한다.
            exit_reason: exitReasonLine(d.reason, verdict),
            ...(verdict.closed ? { closed_at: new Date().toISOString() } : {}),
          }).eq('id', d.tradeId);
        }
        results.push({
          symbol: d.symbol, action: 'CLOSE', exchange: cr.exchange,
          ok: verdict.closed, code: verdict.code,
          needsReconcile: verdict.needsReconcile, retry: verdict.retry,
          // **어느 연결로 냈는지, 그리고 그것이 확실한지.**
          // 옛 줄(065 이전)은 사용자 단위로 고른 연결이라 그 거래의
          // 계좌가 아닐 수 있다.
          connectionKnown: !cr.guessed,
          reason: d.reason, detail: verdict.reason,
          protectionCleanup: closeCleanup,
        });
        continue;
      }

      // ── MOVE_STOP: 새 손절을 먼저 걸고, 성공하면 기존 것을 취소한다 ──
      // 순서가 중요하다. 취소를 먼저 하면 그 사이에 새 주문이 실패했을 때
      // 손절 없는 포지션이 남는다. 반대로 하면 잠깐 손절이 둘이 되는데,
      // 둘 다 closePosition이라 먼저 걸리는 쪽이 전량을 닫고 나머지는
      // 자동으로 무효가 된다. 겹치는 편이 비는 것보다 안전하다.
      // **거래소를 가리지 않는다.** 예전에는 바이낸스 함수를 직접 불러서,
      // Gate 포지션은 진입은 되는데 손절을 옮길 수가 없었다 — 화면에는
      // "청산 감시 정상"이 떠 있었다.
      const opsMv = await import('@/lib/engine/venuePositionOps');
      const venueMv = { exchange: cr.exchange, apiKey: key, apiSecret: secret, testnet };
      const placed = await opsMv.placeStop(venueMv, {
        symbol: d.symbol, positionSide: d.side, stopPrice: d.newStop!,
      });

      if (!placed.ok) {
        results.push({ symbol: d.symbol, action: 'MOVE_STOP', ok: false, error: `새 손절 실패: ${placed.message}` });
        continue;
      }

      // 기존 손절 중 방금 건 것 외에는 취소한다.
      // **남길 것을 모르면 아무것도 지우지 않는다** — 지우면 손절 없는
      // 포지션이 남는다. 익절과 분할 사다리는 건드리지 않는다.
      const { cancelled, note: cancelNote } =
        await opsMv.cancelOtherStops(venueMv, d.symbol, d.side, placed.orderId);

      if (!dryRun) {
        // **stop_loss를 덮어쓰지 않는다.** 그 칸은 진입 시점 값이고 1R을
        // 정의한다. 덮어쓰면 다음 주기에 1R이 커져서 트레일링이 멈춘다.
        // 지금 걸린 손절은 거래소가 갖고 있고, 위에서 그것을 읽어 쓴다.
        await sb.from('ladder_daily_trades').update({
          exit_reason: d.reason,
        }).eq('id', d.tradeId);
      }
      results.push({ symbol: d.symbol, action: 'MOVE_STOP', ok: true, exchange: cr.exchange,
        connectionKnown: !cr.guessed,
        newStop: d.newStop, cancelledOld: cancelled, cancelNote, reason: d.reason });
    } catch (e: any) {
      results.push({ symbol: d.symbol, action: d.action, ok: false, error: e?.message || '실행 실패' });
    }
  }

  // 돌았다는 사실을 남긴다. 이게 없으면 크론이 조용히 죽어도 아무도
  // 모른다 — 캘린더 동기화가 vercel.json에 등록조차 안 된 채로 몇 달을
  // 보낸 것이 정확히 그 결과였다.
  const { recordCronRun } = await import('@/lib/system/cronLog');
  // **누가 불렀는지 같이 적는다.** 워커가 도는데 화면이 '안 돎'으로
  // 보이거나, 백업만 돌고 있는 상태를 구분할 방법이 이 한 줄뿐이다.
  const caller = (() => {
    const src = String(req.headers.get('x-traigo-source') || '').trim().toLowerCase();
    if (src === 'worker') return 'worker';
    if (src) return src.slice(0, 16).replace(/[^a-z0-9_-]/g, '');
    const auth = req.headers.get('authorization') || '';
    return auth.startsWith('Bearer ') ? 'cron' : 'manual';
  })();
  const cronLog = await recordCronRun(sb, 'exit-monitor',
    actionable.length > 0 ? 'ok' : 'skipped',
    `${decisions.length}건 확인 · ${actionable.length}건 처리 (${caller})`, cronStartedAt);

  // 회차를 닫는다. **#142 증거(정확한 번호로 취소한 남은 보호주문)를
  // 그대로 담는다** — 사용자가 Gate 앱을 열어 확인하지 않아도 되게.
  const failed = results.filter(r => r && r.ok === false);
  await closeRun({
    status: failed.length > 0 ? 'FAILED' : 'OK',
    positions_scanned: decisions.length,
    actions: results.filter(r => r && r.ok === true).length,
    orphan_cleanups: Array.isArray(orphanCleanups) ? orphanCleanups.length : null,
    cleanup_detail: Array.isArray(orphanCleanups) && orphanCleanups.length ? orphanCleanups : null,
    errors: failed.length > 0
      ? failed.map(r => `${r.symbol}: ${String(r.error || '').slice(0, 120)}`).join(' · ').slice(0, 1000)
      : null,
  });

  return NextResponse.json({
    ok: true, checked: decisions.length, actionable: actionable.length, alerts, recovery, orphanCleanups, results,
    runId, cronLogError: cronLog.error,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
