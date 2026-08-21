// POST /api/ledger/sync — 거래소 원장을 장부로 옮긴다
//
// **수수료와 펀딩을 모르면 "번 것"을 말할 수 없다.**
//
// 056이 장부 표를 만들었고, 진입·청산 시점의 사건은 적히고 있다.
// 그런데 수수료와 펀딩은 아무도 안 모았다 — 그래서 `tradingPnlOf()`는
// 네 항 중 둘을 모른 채로 언제나 `null`을 돌려줬다. 048(자산 스냅샷)이
// 표만 만들어지고 채우는 코드가 없던 것과 **정확히 같은 고장**이다.
//
// 왜 여기(Vercel)인가
// ──────────────────
// Binance가 Fly의 IP 지역을 차단한다. 워커는 이 라우트를 깨우기만 하고,
// 거래소를 부르는 것은 여기다 — 청산 감시와 같은 구조다.
//
// 판정은 여기 없다. `src/lib/ledger/incomeIngest.ts`에 있고 테스트가
// 붙어 있다. 이 파일은 불러오고 적기만 한다.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { incomeToEvents, nextIngestFrom, type IncomeRow } from '@/lib/ledger/incomeIngest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function safeEqual(provided: string | null, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, 'utf8'); const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export async function POST(req: NextRequest) {
  // 워커가 자기 ADMIN_SECRET으로 부른다 — **새 비밀을 만들지 않는다.**
  const admin = safeEqual(req.headers.get('x-admin-secret'), process.env.ADMIN_SECRET || '');
  const uid = admin
    ? String((await req.json().catch(() => ({}))).userId ?? '') || null
    : await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // 관리자 호출인데 userId를 안 줬으면 모든 사용자를 돈다.
  let userIds: string[] = [];
  if (uid) userIds = [uid];
  else if (admin) {
    const { data } = await (sb as any).from('exchange_connections').select('user_id');
    userIds = Array.from(new Set((Array.isArray(data) ? data : []).map((r: any) => String(r.user_id))));
  } else {
    return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  }

  const nowMs = Date.now();
  const results: any[] = [];

  for (const userId of userIds) {
    // ── 실제 칸 이름은 `exchange_id`다 ──
    //
    // **처음에 `exchange`라고 썼다.** 그 칸은 없다(004 참조). 그런데 조회
    // 오류를 안 받고 `Array.isArray(conns) ? conns : []`로 넘어갔으므로,
    // 컬럼 오류가 나도 **연결 0개로 조용히 끝났다** — 기능은 있고
    // 테스트도 통과하는데 실제로는 한 건도 수집하지 않는 상태다.
    //
    // 이 저장소가 계속 잡아 온 고장이 정확히 그 모양이라, 여기서는
    // **오류를 반드시 받아 보고, 못 읽었으면 성공으로 적지 않는다.**
    const { data: conns, error: connErr } = await (sb as any)
      .from('exchange_connections')
      .select('id, exchange_id, is_testnet, is_active')
      .eq('user_id', userId)
      // 꺼 둔 연결은 수집하지 않는다.
      .eq('is_active', true);

    if (connErr) {
      results.push({ userId, ok: false,
        error: `연결 목록을 읽지 못했습니다: ${String(connErr.message).slice(0, 200)}` });
      continue;
    }
    const connRows = Array.isArray(conns) ? conns : null;
    if (connRows == null) {
      // **못 읽은 것을 '연결 없음'으로 적지 않는다.**
      results.push({ userId, ok: false, error: '연결 목록을 읽지 못했습니다 — 연결이 없다는 뜻이 아닙니다' });
      continue;
    }

    for (const c of connRows) {
      const connectionId = String(c.id);
      // **저장소 규칙: is_testnet === false만 실전이다.** 그 밖은 전부 테스트넷.
      const env: 'LIVE' | 'TESTNET' = c?.is_testnet === false ? 'LIVE' : 'TESTNET';
      const exchange = String(c?.exchange_id ?? '');

      // 어디까지 읽었는가
      let coverage: { fromMs: number | null; toMs: number | null } | null = null;
      try {
        const { data } = await (sb as any).from('ledger_ingest_state')
          .select('covered_from, covered_to')
          .eq('user_id', userId).eq('connection_id', connectionId).eq('env', env).maybeSingle();
        if (data) {
          coverage = {
            fromMs: Date.parse(String(data.covered_from ?? '')) || null,
            toMs: Date.parse(String(data.covered_to ?? '')) || null,
          };
        }
      } catch { /* 062가 아직이면 null — 처음부터 읽는다 */ }

      const plan = nextIngestFrom({ coverage, nowMs });

      // ── 거래소에서 읽는다 ──
      let rows: IncomeRow[] | null = null;
      let readError: string | null = null;
      try {
        const { loadFuturesCreds } = await import('@/lib/exchanges/loadCreds');
        const creds = await loadFuturesCreds(sb, userId, connectionId);
        if (!creds.ok) throw new Error((creds as any).message || (creds as any).error || '키를 읽지 못했습니다');
        const key = (creds as any).key, secret = (creds as any).secret, testnet = (creds as any).testnet;

        if (exchange === 'binance') {
          const { getFuturesIncome } = await import('@/lib/exchanges/binanceFutures');
          const raw = await getFuturesIncome(key, secret, testnet, { startTime: plan.fromMs, limit: 1000 });
          rows = raw == null ? null : raw.map((d: any) => ({
            incomeType: String(d?.incomeType ?? ''),
            income: Number(d?.income),
            time: Number(d?.time),
            symbol: d?.symbol ? String(d.symbol) : null,
            // **문자열이다** — int64를 숫자로 다루면 끝자리가 뭉개진다 (#139)
            tranId: d?.tranId != null ? String(d.tranId) : null,
          }));
        } else if (exchange === 'gate') {
          const { getGateAccountBook } = await import('@/lib/exchanges/gateFutures');
          const raw = await getGateAccountBook(key, secret, testnet, {
            fromSec: Math.floor(plan.fromMs / 1000), limit: 1000,
          });
          rows = raw == null ? null : raw.map(r => ({
            incomeType: r.incomeType, income: r.income, time: r.time, symbol: null, tranId: null,
          }));
        } else {
          readError = `${exchange}는 아직 원장 수집을 지원하지 않습니다`;
        }
      } catch (e: any) {
        readError = String(e?.message || e).slice(0, 200);
      }

      if (rows == null) {
        // **못 읽은 것을 '없음'으로 적지 않는다.** 덮인 구간을 늘리지도 않는다 —
        // 늘리면 읽지 않은 구간을 읽었다고 말하는 것이 된다.
        try {
          await (sb as any).from('ledger_ingest_state').upsert({
            user_id: userId, connection_id: connectionId, env,
            last_run_at: new Date(nowMs).toISOString(),
            last_error: readError || '거래소 원장을 읽지 못했습니다',
          }, { onConflict: 'user_id,connection_id,env' });
        } catch { /* 062가 아직이면 기록할 곳이 없다 */ }
        results.push({ connectionId, env, ok: false, error: readError || '읽지 못했습니다' });
        continue;
      }

      const ing = incomeToEvents({ rows, userId, env, connectionId, exchange });

      let written = 0, duplicate = 0, failed = 0;
      const { recordLedgerEvent } = await import('@/lib/ledger/writeLedger');
      for (const ev of ing.events) {
        const r = await recordLedgerEvent(sb, ev, 'income');
        if (r.code === 'WRITTEN') written += 1;
        else if (r.code === 'DUPLICATE') duplicate += 1;
        else failed += 1;
      }

      // ── 덮인 구간을 넓힌다 ──
      //
      // 실패가 하나라도 있으면 **넓히지 않는다.** 못 적은 사건이 있는
      // 구간을 '읽었다'고 하면 그 구간의 수수료가 영원히 빠진다.
      const okToExtend = failed === 0;
      const newFrom = coverage?.fromMs != null
        ? Math.min(coverage.fromMs, ing.fromMs ?? plan.fromMs)
        : (ing.fromMs ?? plan.fromMs);
      const newTo = okToExtend
        ? Math.max(coverage?.toMs ?? 0, ing.toMs ?? nowMs, nowMs)
        : (coverage?.toMs ?? null);

      try {
        await (sb as any).from('ledger_ingest_state').upsert({
          user_id: userId, connection_id: connectionId, env,
          covered_from: new Date(newFrom).toISOString(),
          covered_to: newTo == null ? null : new Date(newTo).toISOString(),
          last_run_at: new Date(nowMs).toISOString(),
          last_written: written,
          // 알아보지 못한 종류를 조용히 버리지 않는다.
          last_skipped: ing.skipped.length ? ing.skipped : null,
          last_error: failed > 0 ? `${failed}건을 적지 못했습니다` : null,
        }, { onConflict: 'user_id,connection_id,env' });
      } catch (e: any) {
        results.push({ connectionId, env, ok: false, error: `기록 상태를 적지 못했습니다: ${String(e?.message || e).slice(0, 150)}` });
        continue;
      }

      results.push({
        connectionId, env, exchange, ok: failed === 0,
        read: rows.length, written, duplicate, failed,
        skipped: ing.skipped,
        coveredTo: newTo == null ? null : new Date(newTo).toISOString(),
      });
    }
  }

  // ── 연결이 있는데 한 건도 안 돌았으면 성공이 아니다 ──
  //
  // **이게 없으면 "구현했고 테스트도 통과"인데 실제로는 아무것도 수집하지
  // 않는 상태를 아무도 못 알아챈다.** 컬럼 이름 하나가 틀렸을 때 정확히
  // 그렇게 됐다.
  const attempted = results.filter((r: any) => r && r.connectionId);
  const failedUsers = results.filter((r: any) => r && r.ok === false && !r.connectionId);
  const ok = failedUsers.length === 0;

  return NextResponse.json({
    ok, users: userIds.length, results, checkedAt: nowMs,
    // 몇 개 연결을 실제로 훑었는가. 0인데 사용자가 있으면 그 사실을 적는다.
    scanned: attempted.length,
    note: attempted.length === 0 && userIds.length > 0
      ? '수집 대상 연결이 하나도 없었습니다 — 연결이 정말 없는지, 조회가 실패한 것인지 results를 보세요'
      : null,
  }, { status: ok ? 200 : 500, headers: { 'Cache-Control': 'no-store' } });
}
