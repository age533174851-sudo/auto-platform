// GET /api/cron/reconcile
//
// **응답을 못 받은 주문을 하루가 아니라 한 시간 안에 확정한다.**
//
// 왜 새로 만드나
// ──────────────
// `reconcilePendingOrders`를 부르는 곳이 둘 있었는데 둘 다 이 일을 못 했다:
//
//   · /api/orders/reconcile — **connectionId를 줘야** 실제 대조를 한다.
//     사람이 화면에서 눌러야 하는 것이고, 크론은 그 값을 모른다.
//   · /api/autotrade/exit-monitor — 크론이 **하루 한 번**이고, 그 라우트는
//     청산 감시가 본업이라 주기를 올리면 다른 동작까지 같이 잦아진다.
//
// 그래서 대조만 하는 경로를 따로 둔다. 주기를 올려도 바뀌는 것이 대조뿐이다.
//
// **vercel.json에는 안 넣는다.**
// 매시(`0 * * * *`)로 넣어 봤더니 배포가 실패했다. 이 요금제에서 크론을
// 하루 한 번보다 자주 돌릴 수 없거나 개수 한도에 걸린 것이고, 어느 쪽이든
// 여기서 우길 일이 아니다 — 배포가 안 되면 이 파일 하나가 아니라 전부가
// 안 올라간다.
//
// 대신 이 경로는 그대로 두고 두 가지로 덮는다:
//   · 단타 라우트가 진입 직전에 **자기 연결을** 대조한다. 거래하는
//     사람에게는 이게 크론보다 낫다 — 필요한 순간에 정확히 돈다.
//   · 이 경로는 외부 스케줄러(cron-job.org·GitHub Actions 등)나 사람이
//     부를 수 있다. 전 사용자를 훑는 것은 여기뿐이므로, 거래를 안 하는
//     계정에 남은 미확정 주문은 이쪽으로만 풀린다.
//
// 요금제를 올리면 vercel.json에 아래 한 줄만 더하면 된다:
//   { "path": "/api/cron/reconcile", "schedule": "0 * * * *" }
//
// 무엇이 걸려 있나
// ────────────────
// executeOrder는 응답을 못 받으면 UNKNOWN으로 적고 **절대 재시도하지
// 않는다.** 그건 맞다. 문제는 그 뒤에 아무도 안 본다는 것이었다.
//
//   1. 거래소에는 포지션이 열려 있는데 앱은 모른다 → 손절이 안 걸린다
//   2. 체크리스트가 미확정 주문을 보고 막는다 → 자동매매가 멎는다
//
// 둘째는 불편이지만 첫째는 사고다.
//
// 인증
// ────
// 이 경로는 **API 키를 복호화해 거래소로 요청을 보낸다.** 다른 크론들은
// `CRON_SECRET`이 없으면 열려 있는데, 여기서 그러면 익명 호출로 남의
// 계좌에 거래소 요청을 일으킬 수 있다. **미설정이면 잠근다.**
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  pendingTargets, skipReason, summarizeOutcomes,
  PENDING_STATUSES, DEFAULT_GRACE_MS, DEFAULT_MAX_CONNECTIONS,
  type ReconcileOutcome,
} from '@/lib/engine/pendingReconcile';

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

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || process.env.ADMIN_SECRET || '';
  if (!secret) {
    // **열어 두지 않는다.** 키를 복호화하는 경로다.
    return NextResponse.json({
      ok: false, error: 'not_configured',
      message: 'CRON_SECRET(또는 ADMIN_SECRET)이 없어 이 경로는 잠겨 있습니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    || req.headers.get('x-admin-secret')
    || req.nextUrl.searchParams.get('secret')
    || '';
  if (!safeEqual(given, secret)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return NextResponse.json({ ok: false, error: 'supabase_not_configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  const now = Date.now();
  const graceMs = (() => {
    const n = Number(req.nextUrl.searchParams.get('graceSec'));
    return Number.isFinite(n) && n >= 0 ? n * 1000 : DEFAULT_GRACE_MS;
  })();
  const dryRun = req.nextUrl.searchParams.get('dry') === '1';

  try {
    const { data: rows, error } = await sb.from('live_orders')
      .select('id, user_id, connection_id, status, created_at, symbol')
      .in('status', PENDING_STATUSES)
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) {
      // **조회 실패를 '없음'으로 적지 않는다.** 0건과 못 셌음은 다르다.
      return NextResponse.json({
        ok: false, error: 'query_failed', message: error.message,
        summary: '미확정 주문을 세지 못했습니다 — 대조가 돌지 않았습니다',
      }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }

    const targets = pendingTargets(rows, { now, graceMs, maxConnections: DEFAULT_MAX_CONNECTIONS });
    if (targets.length === 0) {
      return NextResponse.json({
        ok: true, pendingRows: Array.isArray(rows) ? rows.length : 0,
        targets: 0, outcomes: [], summary: summarizeOutcomes([]),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (dryRun) {
      return NextResponse.json({
        ok: true, dryRun: true, pendingRows: Array.isArray(rows) ? rows.length : 0,
        targets: targets.length, plan: targets,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const { reconcilePendingOrders } = await import('@/lib/engine/orderExecutor');
    const { futuresExchangeOf } = await import('@/lib/exchanges/futuresAdapter');

    const outcomes: ReconcileOutcome[] = [];
    for (const t of targets) {
      const { data: conn } = await sb.from('exchange_connections')
        .select('id, user_id, exchange_id, api_key, api_secret_enc, has_withdrawal, is_testnet')
        .eq('id', t.connectionId)
        .maybeSingle();

      const skip = skipReason(conn);
      if (skip) { outcomes.push({ connectionId: t.connectionId, ok: true, skipped: skip }); continue; }

      const ex = futuresExchangeOf(conn.exchange_id);
      // **모르는 거래소를 바이낸스로 대조하면 안 된다.** 그 거래소에 있는
      // 주문을 바이낸스에서 못 찾고 '체결 안 됨'으로 확정해 버린다.
      if (!ex) {
        outcomes.push({
          connectionId: t.connectionId, ok: true,
          skipped: `대조할 수 없는 거래소입니다 (${conn.exchange_id || '알 수 없음'})`,
        });
        continue;
      }

      try {
        const r = await reconcilePendingOrders(sb, {
          exchange: ex,
          apiKey: conn.api_key,
          apiSecret: decryptSecret(conn.api_secret_enc ?? ''),
          // 저장소 공통 규칙: is_testnet === false 일 때만 실전이다.
          testnet: conn.is_testnet !== false,
          // 언제나 좁힌다. 안 좁히면 한 사람의 키로 남의 주문을 물어보고,
          // 없다는 답을 남의 행에 쓴다.
          userId: conn.user_id ?? t.userId ?? null,
          connectionId: t.connectionId,
        });
        outcomes.push({
          connectionId: t.connectionId, ok: true,
          resolved: r.resolved, checked: r.checked,
        });
      } catch (e: any) {
        // 한 연결이 실패해도 나머지는 돈다. 그리고 **실패는 적힌다** —
        // 조용히 건너뛰면 "대조 정상"이라고 말하는 동안 미확정이 쌓인다.
        outcomes.push({
          connectionId: t.connectionId, ok: false,
          error: e?.message || '대조 실패',
        });
      }
    }

    const anyFailed = outcomes.some(o => !o.ok && !o.skipped);
    return NextResponse.json({
      ok: !anyFailed,
      pendingRows: Array.isArray(rows) ? rows.length : 0,
      targets: targets.length,
      outcomes,
      summary: summarizeOutcomes(outcomes),
    }, { status: anyFailed ? 207 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '대조 실패' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
