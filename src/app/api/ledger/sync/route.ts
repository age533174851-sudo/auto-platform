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
import { ingestTargetsOf } from '@/lib/ledger/ingestTargets';
import { ingestStatePatchOf } from '@/lib/ledger/ingestState';

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
    // **수집 대상은 지금 활성인 연결 전부다.** 별도 등록 목록을 두지
    // 않는다 — 새 연결을 만들 때 어딘가에 또 적어야 하면, 언젠가 그
    // 한 줄을 빼먹고 그 연결의 수수료만 조용히 빠진다.
    const targets = ingestTargetsOf(conns as any);
    if (targets == null) {
      // **못 읽은 것을 '연결 없음'으로 적지 않는다.**
      results.push({ userId, ok: false, error: '연결 목록을 읽지 못했습니다 — 연결이 없다는 뜻이 아닙니다' });
      continue;
    }

    for (const t of targets) {
      const connectionId = t.connectionId;
      const env = t.env;
      const exchange = t.exchange;

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
      //
      // **한 장으로 끝내지 않는다.** 두 거래소 모두 조회가 `limit` 한 장이라,
      // 응답이 상한에 닿으면 뒤에 더 있는지 증명할 수 없다. 그대로
      // `covered_to`를 지금까지 밀면 못 읽은 구간을 읽었다고 말하게 되고,
      // 그 구간의 수수료·펀딩은 영원히 안 들어온다.
      //
      // 공식 문서는 이 환경에서 열리지 않는다(egress 차단). 그래서
      // **검증하지 못한 파라미터를 지어내지 않는다** — `page`·`offset`·
      // `endTime`을 상상해서 붙이는 대신, 이미 동작이 확인된 것만 쓰고
      // **정렬은 응답에서 직접 확인한다.**
      const PAGE_LIMIT = 1000;
      let rows: IncomeRow[] | null = null;
      let readError: string | null = null;
      let pageComplete = true;
      let provenThroughMs: number | null = null;
      let incompleteReason: string | null = null;
      let pagesRead = 0;

      try {
        const { loadFuturesCreds } = await import('@/lib/exchanges/loadCreds');
        const creds = await loadFuturesCreds(sb, userId, connectionId);
        if (!creds.ok) throw new Error((creds as any).message || (creds as any).error || '키를 읽지 못했습니다');
        const key = (creds as any).key, secret = (creds as any).secret, testnet = (creds as any).testnet;

        const { pageVerdictOf, pageBudgetExhausted, MAX_PAGES_PER_RUN } =
          await import('@/lib/ledger/incomePaging');

        // 거래소별로 **따로** 한 장을 읽는다. 한쪽의 규칙을 다른 쪽에
        // 복사하지 않는다 — 파라미터 이름도 시각 단위도 다르다.
        const readPage = async (fromMs: number): Promise<IncomeRow[] | null> => {
          if (t.route === 'binance') {
            const { getFuturesIncome } = await import('@/lib/exchanges/binanceFutures');
            const raw = await getFuturesIncome(key, secret, testnet, { startTime: fromMs, limit: PAGE_LIMIT });
            return raw == null ? null : raw.map((d: any) => ({
              incomeType: String(d?.incomeType ?? ''),
              income: Number(d?.income),
              time: Number(d?.time),
              symbol: d?.symbol ? String(d.symbol) : null,
              // **문자열이다** — int64를 숫자로 다루면 끝자리가 뭉개진다 (#139)
              tranId: d?.tranId != null ? String(d.tranId) : null,
            }));
          }
          if (t.route === 'gate') {
            const { getGateAccountBook } = await import('@/lib/exchanges/gateFutures');
            // Gate의 `from`은 **초 단위**다. 바이낸스와 같은 값을 넣으면 안 된다.
            const raw = await getGateAccountBook(key, secret, testnet, {
              fromSec: Math.floor(fromMs / 1000), limit: PAGE_LIMIT,
            });
            return raw == null ? null : raw.map(r => ({
              incomeType: r.incomeType, income: r.income, time: r.time, symbol: null, tranId: null,
            }));
          }
          readError = t.reason;
          return null;
        };

        if (!t.supported) {
          readError = t.reason;
        } else {
          const collected: IncomeRow[] = [];
          let windowFrom = plan.fromMs;

          for (;;) {
            const page = await readPage(windowFrom);
            if (page == null) { rows = null; break; }
            pagesRead += 1;
            collected.push(...page);

            const v = pageVerdictOf({
              times: page.map(r => Number(r.time)),
              limit: PAGE_LIMIT, windowFromMs: windowFrom,
            });

            if (v.complete) { pageComplete = true; break; }

            if (v.code === 'ADVANCE' && v.nextFromMs != null) {
              // 증명된 지점을 계속 밀어 둔다 — 페이지 상한에 걸려도
              // 여기까지는 읽었다고 말할 수 있다.
              provenThroughMs = v.provenThroughMs;
              if (pagesRead >= MAX_PAGES_PER_RUN) {
                const b = pageBudgetExhausted(provenThroughMs);
                pageComplete = false; incompleteReason = b.reason;
                break;
              }
              windowFrom = v.nextFromMs;
              continue;
            }

            // STUCK · UNPROVEN — **전진하지 않는다.**
            pageComplete = false;
            incompleteReason = v.reason;
            break;
          }
          if (readError == null) rows = rows === null && pagesRead === 0 ? null : collected;
        }
      } catch (e: any) {
        readError = String(e?.message || e).slice(0, 200);
        rows = null;
      }

      // ── 이번 회차의 결과를 하나의 판정으로 만든다 ──
      //
      // 판정은 `ingestStatePatchOf`에 있다(테스트가 붙어 있다).
      // 여기서 다시 규칙을 쓰면 두 벌이 되고, 언젠가 한쪽만 고쳐진다.
      const ing = rows == null ? null : incomeToEvents({ rows, userId, env, connectionId, exchange });

      let written = 0, duplicate = 0, failed = 0;
      if (ing) {
        const { recordLedgerEvent } = await import('@/lib/ledger/writeLedger');
        for (const ev of ing.events) {
          const r = await recordLedgerEvent(sb, ev, 'income');
          if (r.code === 'WRITTEN') written += 1;
          else if (r.code === 'DUPLICATE') duplicate += 1;
          else failed += 1;
        }
      }

      const patch = ingestStatePatchOf({
        userId, connectionId, env,
        coverage, planFromMs: plan.fromMs,
        readOk: rows != null,
        readError,
        eventsFromMs: ing?.fromMs ?? null,
        eventsToMs: ing?.toMs ?? null,
        written, failed,
        skipped: ing?.skipped ?? null,
        // **끝까지 읽었는가.** 아니면 covered_to를 지금까지 밀지 않는다.
        complete: pageComplete,
        provenThroughMs,
        incompleteReason,
        nowMs,
      });

      // ── 상태를 적는다. **오류를 반드시 받아 본다** ──
      //
      // 예전에는 `await sb.from(...).upsert(...)`만 하고 반환값을 버렸다.
      // supabase-js는 DB 오류를 **던지지 않는다** — `{ error }`로 준다.
      // 그래서 상태 기록이 실패해도 try/catch에 안 걸리고, 그 회차는
      // 성공으로 보고됐다. **적히지 않은 coverage가 적힌 것처럼 보인다.**
      let stateError: string | null = null;
      try {
        const { error: upErr } = await (sb as any).from('ledger_ingest_state')
          .upsert(patch.row, { onConflict: 'user_id,connection_id,env' });
        if (upErr) stateError = String(upErr.message ?? upErr).slice(0, 200);
      } catch (e: any) {
        stateError = String(e?.message || e).slice(0, 200);
      }

      if (stateError) {
        // **DB 실패를 성공으로 기록하지 않는다.**
        results.push({ connectionId, env, exchange, ok: false,
          error: `수집 상태를 적지 못했습니다: ${stateError}` });
        continue;
      }

      if (rows == null) {
        results.push({ connectionId, env, exchange, ok: false,
          error: readError || '거래소 원장을 읽지 못했습니다', advanced: false });
        continue;
      }

      results.push({
        connectionId, env, exchange, ok: failed === 0,
        read: rows.length, written, duplicate, failed,
        skipped: ing?.skipped ?? [],
        // **성공 + 0건도 coverage 증거다.** 그 사실을 값으로 남긴다.
        advanced: patch.advanced,
        pages: pagesRead,
        // 상한에 닿아 다 못 읽었으면 그 사실을 값으로 준다.
        truncated: !pageComplete,
        truncatedReason: incompleteReason,
        note: patch.reason,
        coveredTo: patch.row.covered_to ?? null,
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
